/**
 * 多级代理链（本地链式转发）—— 第二批
 *
 * 为什么自己搭链：对手走内核 `--protected-staticconfig` 把配置整包交内核，我们用的是**系统 Chrome，
 * 没有这条通道**，所以链只能在浏览器外面搭出来。这是**有意差异**（README 第八节）。
 *
 * 链路**不是**一个可配置的 hop 数组（`user_proxy_config.proxy_chain` 那个取法已经被 `20-` §1.1
 * 的三级证据推翻：对手没有这个入参字段）。对手的「多级」是**两跳拼出来的产物**：
 *   hop0 = **本机 Windows 系统代理**（`HKCU\...\Internet Settings`）
 *   hop1 = **环境自己的代理**（`user_proxy_config`）
 * 开关 `is_multi_level_proxy`（对手拼写 `mutli_level_proxy` 同样只当开关认）为 `'1'` 时才组链。
 * 没有系统代理 → **塌成单跳、正常启动**（不是失败）。所以「打开了开关也只是一条链」，
 * 只有在用户本机确实配了系统代理时才多出这一跳 —— README 必须照实写，不许包装成「已实现多级代理」。
 *
 * 关于 `20-` §5 的 A/B 两版证据：B 版（`mutli_level_proxy` 是运行时对象）描述的是**对手客户端的
 * 运行时构造**，不是 API 入参；我们没有那一层客户端实现，所以 API 层两种写法都只当开关认 ——
 * 这是**没有可复刻的层**，不是漏实现。两版各写各的层，不互相矛盾。
 *
 * 结构：
 *   浏览器 --(--proxy-server=http://127.0.0.1:<relayPort>)--> 本模块的本地 HTTP 代理
 *          --> hop0（系统代理） --> hop1（环境代理） --> 目标
 *   下标 0 = **离浏览器最近**的第一跳（我们的语义，对手顺序无证据）。
 *
 * 转发用**嵌套 CONNECT**：向当前跳发一条「CONNECT 下一跳」，到最深一跳再在它的隧道里发
 * 「CONNECT 目标」；每一跳只带**自己的** `Proxy-Authorization`（测试里有一条专门查凭据不串层）。
 * 明文 http 目标也走同一条链（绝对 URI 改写 origin-form 再从隧道发出），**没有直连分支**。
 *
 * 硬约束（都不是可选项）：
 *   - 只 bind `127.0.0.1`，端口由系统分配（`listen(0)`），拿回来再交给 `--proxy-server`；
 *   - 任何一跳失败 → 给浏览器 502，并把 `{hop}` 记进 `lastError`，上层据此 fail-closed 拒绝启动；
 *   - `close()` 先 destroy 所有在建 socket 再 close 监听 —— 否则反复起停会漏端口（几轮后才炸，最难查）。
 *   - 读注册表**不写**：`readSystemProxy(overrides)` 可注入，测试永远不改用户注册表。
 */
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { normalizeProxyConfig, hasProxy } from './probe.js';
import { pacMessage } from './pac.js';

const CRLF = '\r\n';
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_HEAD_BYTES = 64 * 1024;
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/* ------------------------------ Windows 系统代理 ------------------------------ */

/**
 * 读 `HKCU\...\Internet Settings` 的四个值。**只读**，任何失败都返回 `{}`（调用方按「没配系统代理」处理，
 * 绝不因为读不到就假装有代理）。`reg query` 的输出形如：
 *
 *     HKEY_CURRENT_USER\...\Internet Settings
 *         ProxyEnable    REG_DWORD    0x1
 *         ProxyServer    REG_SZ       127.0.0.1:7890
 *
 * 注意：`ProxyEnable=0` 但 `ProxyServer` 仍在注册表里是常态（用户关掉代理但没清空），所以
 * **是否启用只看 `ProxyEnable`**，不看 `ProxyServer` 有没有值。
 */
function readRegistryValues() {
  if (process.platform !== 'win32') return {};
  try {
    const out = execFileSync('reg', ['query', REG_KEY], {
      encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const vals = {};
    for (const line of String(out).split(/\r?\n/)) {
      const m = /^\s{2,}(\S+)\s+(REG_[A-Z_]+)\s+(.*)$/.exec(line);
      if (m) vals[m[1]] = m[3].trim();
    }
    return vals;
  } catch {
    return {};
  }
}

/** 注册表 DWORD 在 `reg query` 里是 `0x1`；也认 `'1'` / `true`（注入时怎么写都行） */
function dwordOn(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === '0x1' || s === 'true';
}

/** `host:port` / `[::1]:8080` → `{host, port}`；没有端口或端口非法 → null（Windows 里总是带端口） */
function splitHostPort(s) {
  const str = String(s || '').trim();
  if (!str) return null;
  const m = /^\[([^\]]+)\]:(\d{1,5})$/.exec(str) || /^([^:\s]+):(\d{1,5})$/.exec(str);
  if (!m) return null;
  const port = Number(m[2]);
  if (!(port > 0 && port < 65536)) return null;
  return { host: m[1], port };
}

/**
 * 解 `ProxyServer`：`host:port` 或 `http=host:port;https=host:port`（也带 `socks=host:port`）。
 * 优先 `http=`，其次 `https=`，最后才用第一条 —— 我们要的是「能承载 CONNECT 的 http 代理」。
 * @returns {{entries:Array, pick:object|null}}
 */
export function parseProxyServer(raw = '') {
  const entries = [];
  for (const part of String(raw).split(';')) {
    const s = part.trim();
    if (!s) continue;
    const m = /^(https?|socks5?)=(.+)$/i.exec(s);
    const scheme = m ? m[1].toLowerCase() : '';
    const type = scheme.startsWith('https') ? 'https' : scheme.startsWith('socks') ? 'socks5' : 'http';
    const hp = splitHostPort(m ? m[2] : s);
    if (hp) entries.push({ type, host: hp.host, port: hp.port, raw: s });
  }
  const pick = entries.find((e) => e.type === 'http')
    || entries.find((e) => e.type === 'https')
    || entries[0]
    || null;
  return { entries, pick };
}

/** `ProxyOverride` 是分号分隔的旁路表（常含 `<local>`）——**读出来备查，本轮不逐请求旁路**（见 README） */
function parseBypass(raw = '') {
  return String(raw).split(';').map((s) => s.trim()).filter(Boolean);
}

/**
 * 读本机系统代理。**可注入**：传了 `overrides` 就完全不碰注册表（测试永远走这条）。
 * @param {object|null} overrides `{ProxyEnable, ProxyServer, ProxyOverride, AutoConfigURL}`
 * @returns {{enabled:boolean, proxyEnable:boolean, server:string, override:string, bypass:string[],
 *   pacUrl:string|null, hop:object|null, entries:Array, source:'registry'|'override'}}
 */
export function readSystemProxy(overrides = null) {
  // `!== null` 必须写在 `typeof` 前面：JS 里 `typeof null === 'object'`，顺序反了会把 `null` 当注入。
  const injected = overrides !== null && typeof overrides === 'object' && !Array.isArray(overrides);
  const raw = injected ? overrides : readRegistryValues();
  const proxyEnable = dwordOn(raw.ProxyEnable ?? raw.proxyEnable);
  const server = String(raw.ProxyServer ?? raw.proxyServer ?? '').trim();
  const override = String(raw.ProxyOverride ?? raw.proxyOverride ?? '');
  const pacUrl = String(raw.AutoConfigURL ?? raw.autoConfigURL ?? '').trim() || null;
  const { entries, pick } = parseProxyServer(server);
  return {
    enabled: proxyEnable && Boolean(pick),
    proxyEnable,
    server,
    override,
    bypass: parseBypass(override),
    pacUrl,
    hop: proxyEnable ? pick : null,
    entries,
    source: injected ? 'override' : 'registry',
  };
}

/* ------------------------------ 链路解析 ------------------------------ */

/** 开关：`is_multi_level_proxy` 与对手拼写 `mutli_level_proxy` 都认，**只当开关**（两者都是 enum '0'|'1'） */
function switchOn(profile = {}) {
  return String(profile.is_multi_level_proxy ?? '') === '1'
    || String(profile.mutli_level_proxy ?? '') === '1';
}

/**
 * 链路解析的**唯一入口**：开关 + 本机系统代理 + 环境代理 → hop 列表。
 *
 * 三种情形（口径见 docs/13-P 与 README 第八节）：
 *   ① 系统代理未启用（`ProxyEnable=0`）→ **塌成单跳**（只有环境代理），正常启动；
 *   ② 系统代理已启用 → `[系统代理, 环境代理]` 两跳（缺一条就还是单跳）；
 *   ③ 系统代理是 PAC（`AutoConfigURL` 非空）→ `ok:false, reason:'pac_unsupported'`，上层拒绝启动。
 *
 * 两跳时**必须都是 http 跳**：https 跳要在隧道里再套一层 TLS、socks5 跳要在隧道里再握手，本轮都没做，
 * 所以明确拒绝（`proxy_chain_invalid`），不假装支持。
 *
 * @returns {{ok:true, active:boolean, mode:'off'|'none'|'single'|'chain', hops:object[], collapsed:boolean,
 *   system:object|null} | {ok:false, active:true, mode:string, reason:string, message:string, system:object|null}}
 */
export function resolveChain(profile = {}, { systemProxy = null } = {}) {
  if (!switchOn(profile)) return { ok: true, active: false, mode: 'off', hops: [], collapsed: false, system: null };

  const sys = readSystemProxy(systemProxy);
  if (sys.pacUrl) {
    return {
      ok: false, active: true, mode: 'pac', reason: 'pac_unsupported',
      message: pacMessage(`系统代理 AutoConfigURL=${sys.pacUrl}`),
      system: sys,
    };
  }

  const hops = [];
  if (sys.hop) hops.push({ type: sys.hop.type, host: sys.hop.host, port: sys.hop.port, username: '', password: '', source: 'system' });

  const envRaw = profile.user_proxy_config || profile.proxy_config || null;
  const env = normalizeProxyConfig(envRaw || {});
  if (hasProxy(env)) hops.push({ ...env, source: 'environment' });

  // 系统代理与环境代理是同一个东西 → 只走一跳（同一条代理套两层没有任何收益，还会自连自）
  if (hops.length === 2 && hops[0].host === hops[1].host && hops[0].port === hops[1].port) hops.splice(0, 1);

  const mode = hops.length >= 2 ? 'chain' : hops.length === 1 ? 'single' : 'none';

  if (mode === 'chain') {
    for (let i = 0; i < hops.length; i++) {
      if (hops[i].type !== 'http') {
        return {
          ok: false, active: true, mode: 'invalid', reason: 'proxy_chain_invalid',
          message: `第 ${i} 跳是 ${hops[i].type}：两跳链目前只支持 http 代理`
            + `（https 跳要在隧道里再套 TLS、socks5 跳要在隧道里再握手，本轮没做）`,
          system: sys,
        };
      }
    }
  }

  return { ok: true, active: true, mode, hops, collapsed: mode !== 'chain', system: sys };
}

/* ---------------------------- 带缓冲的 socket ---------------------------- */

/** 读头用的小包装：支持「读到 \r\n\r\n 为止」并把多余字节原样交给调用方 */
class BufferedSocket {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.error = null;
    this.waiters = new Set();
    this.onData = (c) => { this.buf = Buffer.concat([this.buf, c]); this.wake(); };
    this.onClose = () => { this.error = this.error || new Error('连接被对端关闭'); this.wake(); };
    this.onErr = (e) => { this.error = e; this.wake(); };
    socket.on('data', this.onData);
    socket.on('close', this.onClose);
    socket.on('error', this.onErr);
  }

  wake() { for (const fn of [...this.waiters]) fn(); }

  async readHead(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.buf.indexOf(`${CRLF}${CRLF}`);
      if (idx >= 0) {
        const head = this.buf.subarray(0, idx).toString('latin1');
        this.buf = this.buf.subarray(idx + 4);
        return head;
      }
      if (this.buf.length > MAX_HEAD_BYTES) throw new Error('代理响应头过大');
      if (this.error) throw this.error;
      if (Date.now() >= deadline) throw new Error(`代理握手超时（${timeoutMs}ms）`);
      await new Promise((resolve) => {
        const done = () => { this.waiters.delete(done); clearTimeout(t); resolve(); };
        const t = setTimeout(done, Math.min(50, Math.max(deadline - Date.now(), 1)));
        this.waiters.add(done);
      });
    }
  }

  /** 拆掉监听，把还没被消费的字节交回去（之后这条 socket 交给裸 pipe） */
  detach() {
    this.socket.off('data', this.onData);
    this.socket.off('close', this.onClose);
    this.socket.off('error', this.onErr);
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    return rest;
  }
}

function dial(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(Object.assign(new Error(`连不上代理 ${host}:${port}（${timeoutMs}ms 超时）`), { reason: 'timeout' }));
    }, timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); sock.setNoDelay(true); resolve(sock); });
    sock.once('error', (e) => { clearTimeout(timer); reject(Object.assign(new Error(`连不上代理 ${host}:${port}：${e.message}`), { reason: e.code })); });
  });
}

const basicAuth = (hop) => (hop.username
  ? `Proxy-Authorization: Basic ${Buffer.from(`${hop.username}:${hop.password || ''}`).toString('base64')}${CRLF}`
  : '');

/**
 * 逐跳建链。每一跳只带**自己的**凭据（见文件头），返回「已经通到 target」的 socket + 残留字节。
 *
 * 失败时错误对象带 `hop`：**没能穿过去的那一跳**的下标。判法：
 *   - 407 → 是**当前这一跳**（`via`）不认我们的凭据（认证失败）；
 *   - 其它非 200 → 当前这一跳连不上**下一跳**（`next`），代理通常用 502/503 报上游失败；
 *   - 最后一跳请求目标时失败 → 只能算在最后一跳（`via`）头上（目标不可达与代理拒绝在协议上分不开）。
 */
async function openThroughChain(hops, host, port, timeoutMs) {
  let sock;
  try {
    sock = await dial(hops[0].host, hops[0].port, timeoutMs);
  } catch (e) {
    throw Object.assign(e, { hop: 0 });
  }
  const buffered = new BufferedSocket(sock);
  try {
    // 前 n-1 条：向当前跳请求「连到下一跳」
    for (let i = 0; i < hops.length - 1; i++) {
      const next = hops[i + 1];
      await connectVia(buffered, next.host, next.port, hops[i], timeoutMs, { via: i, next: i + 1 });
    }
    // 最后一条：在最深一跳的隧道里请求目标
    await connectVia(buffered, host, port, hops[hops.length - 1], timeoutMs, { via: hops.length - 1 });
    const rest = buffered.detach();
    return { socket: sock, rest };
  } catch (e) {
    buffered.detach();
    try { sock.destroy(); } catch { /* 已经断了 */ }
    throw e;
  }
}

async function connectVia(buffered, host, port, hop, timeoutMs, { via, next = null }) {
  const authority = `${host}:${port}`;
  buffered.socket.write(`CONNECT ${authority} HTTP/1.1${CRLF}Host: ${authority}${CRLF}${basicAuth(hop)}${CRLF}`);
  const head = await buffered.readHead(timeoutMs);
  const status = Number(String(head.split(CRLF)[0] || '').split(' ')[1]);
  if (status !== 200) {
    const failed = status === 407 ? via : (next ?? via);
    throw Object.assign(new Error(`代理链第 ${failed + 1} 跳没能穿过 CONNECT ${authority}（HTTP ${status}）`), {
      hop: failed, status, reason: status === 407 ? 'proxy_auth_failed' : 'proxy_refused',
    });
  }
}

/* ------------------------------ 本地监听 ------------------------------ */

/**
 * 起一个一次性本地 HTTP 代理（只 bind `127.0.0.1`），用给定链路转发。
 * @returns {Promise<{port:number, close:Function, lastError:object|null, sockets:Set, hops:Array}>}
 */
export async function startChain(hops, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!Array.isArray(hops) || hops.length === 0) throw new Error('startChain 需要至少一跳');
  for (let i = 0; i < hops.length; i++) {
    if (hops[i].type !== 'http') throw new Error(`第 ${i} 跳是 ${hops[i].type}：本地链只支持 http 跳`);
  }
  const state = { port: 0, lastError: null, sockets: new Set(), closed: false, hops: hops.length };

  const server = net.createServer((socket) => {
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
    socket.on('error', () => { /* 浏览器主动断，正常 */ });
    handleClient(socket, hops, state, timeoutMs).catch((e) => {
      state.lastError = state.lastError || e;
      try { socket.destroy(); } catch { /* ignore */ }
    });
  });
  server.on('error', (e) => { state.lastError = state.lastError || e; });

  await new Promise((resolve, reject) => {
    const onErr = (e) => reject(e);
    server.once('error', onErr);
    // 只 bind 回环：绝不 0.0.0.0（多开的内核不该把代理暴露给局域网），端口 0 = 系统分配
    server.listen(0, '127.0.0.1', () => { server.off('error', onErr); resolve(); });
  });
  state.port = server.address().port;

  state.close = () => new Promise((resolve) => {
    state.closed = true;
    for (const s of state.sockets) { try { s.destroy(); } catch { /* ignore */ } }
    state.sockets.clear();
    server.close(() => resolve());
  });
  return state;
}

async function handleClient(client, hops, state, timeoutMs) {
  const buffered = new BufferedSocket(client);
  let head;
  try {
    head = await buffered.readHead(timeoutMs);
  } catch (e) {
    buffered.detach();
    try { client.destroy(); } catch { /* ignore */ }
    return;
  }
  const lines = head.split(CRLF);
  const [method, target] = String(lines[0] || '').split(' ');
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  let rest = buffered.detach();

  let upstream = null;
  try {
    if (String(method).toUpperCase() === 'CONNECT') {
      const [h, p] = splitAuthority(target);
      const t = await openThroughChain(hops, h, p, timeoutMs);
      upstream = t.socket;
      if (t.rest.length) rest = Buffer.concat([t.rest, rest]);
      client.write(`HTTP/1.1 200 Connection Established${CRLF}Proxy-Agent: FreePower${CRLF}${CRLF}`);
    } else {
      // 明文 http：绝对 URI → origin-form，再沿同一条链发出去（没有直连分支）
      const u = parseTargetUrl(target, headers.host);
      const t = await openThroughChain(hops, u.hostname, u.port, timeoutMs);
      upstream = t.socket;
      if (t.rest.length) rest = Buffer.concat([t.rest, rest]);
      upstream.write(rewriteToOriginForm(head, u, method));
    }
  } catch (e) {
    state.lastError = e;
    try {
      client.write(`HTTP/1.1 502 Bad Gateway${CRLF}Proxy-Agent: FreePower${CRLF}Content-Length: 0${CRLF}${CRLF}`);
    } catch { /* 浏览器已经断了 */ }
    try { client.destroy(); } catch { /* ignore */ }
    return;
  }

  if (rest.length) { try { upstream.write(rest); } catch { /* ignore */ } }
  relay(client, upstream);
}

function splitAuthority(authority) {
  const s = String(authority || '');
  const i = s.lastIndexOf(':');
  if (i <= 0) return [s.replace(/^\[|\]$/g, ''), 443];
  return [s.slice(0, i).replace(/^\[|\]$/g, ''), Number(s.slice(i + 1)) || 443];
}

function parseTargetUrl(target, hostHeader) {
  const raw = String(target || '');
  const full = /^https?:\/\//i.test(raw) ? raw : `http://${hostHeader || ''}${raw}`;
  const u = new URL(full);
  return { hostname: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80), path: `${u.pathname}${u.search}`, host: u.host };
}

/** 绝对 URI → origin-form；凭据/连接类头一律摘掉（它们只属于浏览器↔我们这一段） */
function rewriteToOriginForm(head, u, method) {
  const lines = head.split(CRLF);
  const out = [`${method} ${u.path || '/'} HTTP/1.1`];
  for (const line of lines.slice(1)) {
    const name = (line.split(':')[0] || '').trim().toLowerCase();
    if (!name) continue;
    if (name === 'proxy-authorization' || name === 'proxy-connection') continue;
    out.push(line);
  }
  return `${out.join(CRLF)}${CRLF}${CRLF}`;
}

function relay(a, b) {
  const kill = () => {
    try { a.destroy(); } catch { /* ignore */ }
    try { b.destroy(); } catch { /* ignore */ }
  };
  a.on('error', kill);
  b.on('error', kill);
  a.on('close', kill);
  b.on('close', kill);
  a.pipe(b);
  b.pipe(a);
}
