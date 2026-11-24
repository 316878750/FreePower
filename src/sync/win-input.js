/**
 * 窗口同步 · Win32 投递端（第 3 步）的 Node 侧。
 *
 * 为什么：CDP `Input` 投给的是「某个 target」，于是我们得一直回答「受控窗口现在哪个标签在前台」，
 * 而这条链（可见性/焦点模拟/激活上报/探活/唤醒）就是同步反复失效的地方。
 * AdsPower 投给的是**窗口句柄**，由浏览器自己把消息路由到前台标签（含 iframe）。这里照做：
 * 常驻一个小 helper（./win-input.cs），PostMessage 给受控窗口。不装钩子。
 *
 * 零依赖：首次使用时用系统自带 .NET Framework 的 csc.exe 编译到数据目录，源码哈希变了才重编。
 * 任何一步失败 → `available()` 为 false，会话自动退回 CDP 投递（不影响原有行为）。
 */
import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'win-input.cs');
const CALL_TIMEOUT_MS = 1500;

function cscPath() {
  const win = process.env.WINDIR || 'C:\\Windows';
  for (const fw of ['Framework64', 'Framework']) {
    const p = path.join(win, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function ensureExe() {
  const src = fs.readFileSync(SRC, 'utf8');   // asar 里也能读
  const hash = crypto.createHash('sha1').update(src).digest('hex').slice(0, 10);
  const dir = path.join(os.tmpdir(), 'freepower-win-input');
  const exe = path.join(dir, `fp-win-input-${hash}.exe`);
  if (fs.existsSync(exe)) return exe;
  const csc = cscPath();
  if (!csc) throw new Error('找不到 csc.exe（.NET Framework 4）');
  fs.mkdirSync(dir, { recursive: true });
  const csFile = path.join(dir, `win-input-${hash}.cs`);
  fs.writeFileSync(csFile, src);
  await new Promise((resolve, reject) => {
    execFile(csc, ['/nologo', '/optimize', '/target:exe', '/r:System.Web.Extensions.dll', `/out:${exe}`, csFile],
      { windowsHide: true, timeout: 60000 }, (err, stdout) => (err ? reject(new Error(`编译失败：${stdout || err.message}`)) : resolve()));
  });
  return exe;
}

export class WinInput {
  constructor() {
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buf = '';
    this.ready = false;
    this.error = null;
  }

  available() { return this.ready && !!this.proc; }

  async start() {
    if (process.platform !== 'win32') { this.error = 'not_windows'; return false; }
    try {
      const exe = await ensureExe();
      this.proc = spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      this.proc.stdout.setEncoding('utf8');
      this.proc.stdout.on('data', (d) => this._onData(d));
      this.proc.on('exit', () => { this.ready = false; this.proc = null; this._failAll('helper_exit'); });
      this.proc.on('error', (e) => { this.error = e.message; this.ready = false; });
      const pong = await this.call({ op: 'ping' });
      this.ready = !!pong?.ok;
      return this.ready;
    } catch (e) {
      this.error = e?.message || String(e);
      this.stop();
      return false;
    }
  }

  _onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg); }
    }
  }

  _failAll(reason) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve({ ok: false, reason }); }
    this.pending.clear();
  }

  /** 一条指令一条回执（helper 单线程按序处理，所以投递天然保序） */
  call(cmd) {
    if (!this.proc) return Promise.resolve({ ok: false, reason: 'helper_down' });
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, reason: 'timeout' }); }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      this.proc.stdin.write(`${JSON.stringify({ ...cmd, id })}\n`);
    });
  }

  /** 按浏览器主进程 pid 找它的主窗口句柄 */
  findWindow(pid) { return this.call({ op: 'find', pid: Number(pid) }); }

  stop() {
    this.ready = false;
    try { this.proc?.stdin.end(); this.proc?.kill(); } catch { /* ignore */ }
    this.proc = null;
    this._failAll('stopped');
  }
}

/** 扩展键（lParam bit24）：方向键、Home/End、PgUp/PgDn、Ins/Del、右侧 Ctrl/Alt、小键盘回车/除号 */
const EXT_CODES = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
  'Insert', 'Delete', 'ControlRight', 'AltRight', 'NumpadEnter', 'NumpadDivide', 'MetaLeft', 'MetaRight', 'ContextMenu']);

/**
 * 页面事件 → helper 指令（null = 这条不走 Win32，交回 CDP 路径）。
 * 文本类（输入法组合结束 / 粘贴 / 随机数字 / 模拟人工输入）仍走 CDP insertText：
 * 它们依赖每窗口的文本解析器与逐字节奏，Win32 这边只做「原样转发」。
 */
export function toWinCommand(ev, hwnd, { rawKeysOnly = false } = {}) {
  if (!ev || !hwnd) return null;
  switch (ev.t) {
    case 'move': return { op: 'mouse', hwnd, t: 'move', x: ev.x, y: ev.y, btns: Number(ev.btns) || 0, m: Number(ev.m) || 0 };
    case 'down':
    case 'up': return { op: 'mouse', hwnd, t: ev.t, x: ev.x, y: ev.y, b: Number(ev.b) || 0, btns: Number(ev.btns) || 0, m: Number(ev.m) || 0 };
    case 'wheel': return { op: 'wheel', hwnd, x: ev.x, y: ev.y, dx: Number(ev.dx) || 0, dy: Number(ev.dy) || 0, m: Number(ev.m) || 0 };
    case 'key':
      /* 带字符的按键有两种情况不能走 Win32（Chrome 会按**真实**键盘状态 TranslateMessage 出字符）：
       *   · Shift / CapsLock 影响大小写与符号 → 真键盘没按 Shift，会出错字；
       *   · rawKeysOnly（随机数字 / 模拟人工 / 关相同文本）→ 不该落字符，但 Win32 拦不住。
       * 这两种返回 null，交回 CDP（同一个调度队列，顺序不乱）。 */
      /* 实测（真内核 157）：补 WM_CHAR → "aabb"；不补 → "AB"（Chrome 按 VK 码自己合成字符，大小写不对）。
       * PostMessage 无法可靠地产生正确字符，所以**凡是带字符的键一律交回 CDP**（CDP 那条 D5 实测正确）。
       * Win32 只管鼠标 + 不带字符的键（退格、方向键、回车、Tab、功能键、组合键）。 */
      if (ev.text) return null;
      return {
      op: 'key', hwnd, down: !!ev.down, kc: Number(ev.kc) || 0, m: Number(ev.m) || 0,
      ext: EXT_CODES.has(String(ev.c || '')), text: rawKeysOnly ? '' : String(ev.text || ''),
    };
    default: return null;
  }
}
