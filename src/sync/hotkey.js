/**
 * 窗口同步的全局快捷键：**跨进程靠文件交接**，不引 IPC。
 *
 * 为什么要跨进程：注册 `globalShortcut` 是 Electron 主进程的能力，而「改快捷键」的界面
 * 走的是 Local API（渲染进程没有 Node、没有 preload）。中间加一层 IPC 就要加 preload，
 * 那是把安全边界打开换一个按钮 —— 不值。用两个 JSON 文件交接，读写都落在数据目录里：
 *
 *   `sync-hotkey.request.json`  界面写 → 桌面壳读（用户点了「保存」）
 *   `sync-hotkey.status.json`   桌面壳写 → 界面读（到底注册成没成）
 *
 * 失败必须能被看见：`Ctrl+Alt+S` 在装了 AdsPower 的机器上**大概率被占**（实测 err=1409），
 * 静默失败会让用户以为功能坏了 —— 所以 status 里带 `ok/error`，面板上明确提示并给改的入口。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

export const REQUEST_FILE = path.join(DATA_DIR, 'sync-hotkey.request.json');
export const STATUS_FILE = path.join(DATA_DIR, 'sync-hotkey.status.json');
export const DEFAULT_ACCELERATOR = 'CommandOrControl+Alt+S';

const MODIFIERS = ['CommandOrControl', 'Ctrl', 'Control', 'Alt', 'Shift', 'Super', 'Meta', 'Command'];

/** 允许的「非字符」按键（Electron accelerator 里合法的命名） */
const NAMED_KEYS = new Set([
  'Space', 'Tab', 'Enter', 'Return', 'Backspace', 'Delete', 'Insert', 'Home', 'End',
  'PageUp', 'PageDown', 'Up', 'Down', 'Left', 'Right', 'Escape', 'Esc',
  'Plus', 'Minus', 'Comma', 'Period', 'Slash', 'Backslash', 'Semicolon', 'Quote',
  'BracketLeft', 'BracketRight', 'Backquote',
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
]);

/**
 * 校验并规范化一个快捷键串。
 * 收：`CommandOrControl+Alt+S`、`Ctrl+Alt+K`、`ctrl + shift + f2`（大小写/空格不敏感）。
 * 拒：没有修饰键（会和页面输入抢键）、多个键、不认识的键、重复修饰键。
 * @returns {string|null} 规范化后的串；不合法返回 null
 */
export function normalizeAccelerator(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const parts = s.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;                       // 至少 一个修饰键 + 一个键

  const mods = [];
  for (const p of parts.slice(0, -1)) {
    const hit = MODIFIERS.find((m) => m.toLowerCase() === p.toLowerCase());
    if (!hit) return null;
    if (mods.includes(hit)) return null;
    mods.push(hit);
  }
  const keyRaw = parts[parts.length - 1];
  const key = /^[a-z0-9]$/i.test(keyRaw)
    ? keyRaw.toUpperCase()
    : (NAMED_KEYS.has(keyRaw) ? keyRaw : NAMED_KEYS.has(cap(keyRaw)) ? cap(keyRaw) : null);
  if (!key) return null;

  // 统一写法：Ctrl/Control 一律写成 CommandOrControl（Windows 与 macOS 语义一致）
  const normMods = mods.map((m) => (m === 'Ctrl' || m === 'Control' ? 'CommandOrControl' : m));
  return [...normMods, key].join('+');
}

function cap(s) {
  const t = String(s || '').toLowerCase();
  if (!t) return '';
  return t[0].toUpperCase() + t.slice(1);
}

function readJson(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(txt);
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** 界面读：桌面壳写下的「当前注册状态」；没有桌面壳时 managed=false */
export function readHotkeyStatus() {
  const st = readJson(STATUS_FILE) || {};
  return {
    accelerator: normalizeAccelerator(st.accelerator) || DEFAULT_ACCELERATOR,
    default: DEFAULT_ACCELERATOR,
    ok: st.ok === true ? true : st.ok === false ? false : null,
    error: st.error || null,
    managed: st.managed === true,
    updated_at: st.at || null,
  };
}

/** 界面写：请求桌面壳换成这个快捷键 */
export function requestHotkey(accelerator) {
  const acc = normalizeAccelerator(accelerator);
  if (!acc) return { ok: false, error: '快捷键格式不对（示例：CommandOrControl+Alt+S）' };
  writeJson(REQUEST_FILE, { accelerator: acc, at: new Date().toISOString() });
  return { ok: true, accelerator: acc };
}

/** 桌面壳用：读用户请求（没有就是 null） */
export function readHotkeyRequest() {
  const r = readJson(REQUEST_FILE);
  if (!r?.accelerator) return null;
  return { accelerator: normalizeAccelerator(r.accelerator) || r.accelerator, at: r.at || null };
}

/** 桌面壳用：写注册结果，供界面显示 */
export function writeHotkeyStatus({ accelerator, ok, error = null }) {
  writeJson(STATUS_FILE, {
    accelerator,
    ok: !!ok,
    error: error ? String(error) : null,
    managed: true,
    at: new Date().toISOString(),
  });
}