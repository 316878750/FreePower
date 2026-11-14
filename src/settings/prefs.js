/**
 * 「设置」页的**持久化偏好**（0.4.3 ④）。
 *
 * 只放「真的有行为在用它」的项 —— 设置页上摆一个不生效的开关，
 * 比不摆更糟：用户改了、以为生效了、回头发现什么都没变。
 * 所以这里目前只有一组：**窗口同步的默认设置**（`meta.sync_defaults`）。
 *
 * 为什么存在库里而不是 localStorage：
 *   1. 它要在**服务端**生效（`/api/v2/sync/start` 没显式给 settings 时用它），
 *      浏览器 localStorage 服务端读不到；
 *   2. 这是「这套安装的行为」，换个浏览器/清掉站点数据不该把它清掉；
 *   3. 与「视图密度」刻意不同：密度是纯显示偏好，那边只存 localStorage（见 web/density.js）。
 *
 * 坏数据一律当「没存过」（回内置默认），不因为一格脏 JSON 让同步起不来。
 */
import { getMeta, setMeta } from '../store/db.js';
import { DEFAULT_SETTINGS, normalizeSettings } from '../sync/settings.js';

/** meta 表的键。改名等于丢用户设置，别乱动。 */
export const SYNC_DEFAULTS_KEY = 'sync_defaults';

/**
 * 读同步默认设置。
 * @returns {{settings: object, saved: boolean, broken: boolean}} `saved:false` = 没存过或存坏了（用内置默认）
 */
export function readSyncDefaults() {
  let raw = null;
  try {
    raw = getMeta(SYNC_DEFAULTS_KEY);
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, saved: false, broken: false };
  }
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { settings: { ...DEFAULT_SETTINGS }, saved: false, broken: false };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // 存坏了：照内置默认走，但**如实告诉界面**（设置页会显示「存坏了，已回默认」）
    return { settings: { ...DEFAULT_SETTINGS }, saved: false, broken: true };
  }
  // 存过的值也过一遍归一化：旧版本可能存过现在已不认的字段，或存了个越界值
  return { settings: { ...normalizeSettings(parsed) }, saved: true, broken: false };
}

/**
 * 写同步默认设置。**合并**语义：只传要改的字段，其余保持已存的值。
 * 归一化复用 `/sync/settings` 那一套（越界值夹回区间，不在这里另写一套）。
 * @returns {{settings: object, saved: true, changed: string[]}}
 */
export function writeSyncDefaults(raw = {}) {
  const prev = readSyncDefaults();
  const merged = { ...prev.settings, ...(raw && typeof raw === 'object' ? raw : {}) };
  const next = normalizeSettings(merged);
  setMeta(SYNC_DEFAULTS_KEY, JSON.stringify(next));
  const changed = [];
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (prev.settings[k] !== next[k]) changed.push(k);
  }
  return { settings: next, saved: true, changed };
}

/** 清掉已存的默认设置（回到内置默认）。同一个键写空串 —— 读的时候按「没存过」处理 */
export function resetSyncDefaults() {
  setMeta(SYNC_DEFAULTS_KEY, '');
  return { settings: { ...DEFAULT_SETTINGS }, saved: false, changed: [] };
}

/**
 * 这次「开始同步」实际要用的设置：**已存默认**打底，请求里给的覆盖在上面。
 * 单独抽成纯函数是为了能直接验「设置页改了 → 开始同步真的按新值走」，
 * 不必为了这条断言真起两个内核（那是 B 层的事）。
 */
export function mergeSyncSettings(given = {}) {
  const base = readSyncDefaults().settings;
  const over = given && typeof given === 'object' ? given : {};
  return normalizeSettings({ ...base, ...over });
}

/** 设置页要显示「与内置默认差在哪几项」 */
export function syncDefaultsDiff() {
  const { settings } = readSyncDefaults();
  const out = [];
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (settings[k] !== DEFAULT_SETTINGS[k]) out.push(k);
  }
  return out;
}