/**
 * 「设置」页的**持久化偏好**（0.4.3 ④）。
 *
 * 只放「真的有行为在用它」的项 —— 设置页上摆一个不生效的开关，
 * 比不摆更糟：用户改了、以为生效了、回头发现什么都没变。
 * 目前四组：**窗口同步的默认设置**（`meta.sync_defaults`）、**关闭环境时自动备份**
 * （`meta.snapshot_on_close`，0.4.7 ③）、**UA 跟随内核版本升级**（`meta.ua_autoalign`，
 * 0.4.7.2，**默认关**），以及自动备份的结果记录（`meta.snapshot_on_close_state`）。
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
import { UA_AUTOALIGN } from '../config.js';

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

/* ==================== UA 跟随内核版本升级（0.4.7.2） ====================
 *
 * **默认必须是关**，理由不是「实现简单」，而是**改用户的指纹**：
 *
 *   0.4.4 ~ 0.4.7.1 的跟版会在启动后把 `ua` / `client_hints` / `kernel_version` 全拉成
 *   本机内核版本并落库。用户 50 个环境的 UA 是导入时带的 Chrome/133，本机内核是 157 ——
 *   一开一次环境，133 就被永久改写成 157，而且**不可逆**（原值没有第二份）。
 *
 *   对手（AdsPower / SunBrowser）不做这件事：`ua` 与 `client_hints` 是两个各自可配的字段
 *   （逆向 02-指纹字段表.md:168-169），内核换了它也不动用户存好的 UA。
 *   所以「跟版」必须是用户显式要的，不能是默认行为。
 *
 * 存库（meta 表）而不是 localStorage：它要在**服务端**生效（`manager.startProfile` 读它），
 * 和 `sync_defaults` / `snapshot_on_close` 同一个理由。
 *
 * 键名不许改（改名等于把用户的选择丢掉）。
 */
export const UA_AUTOALIGN_KEY = 'ua_autoalign';

/**
 * 读「UA 跟随内核版本升级」开关。
 * @returns {{enabled:boolean, saved:boolean, broken:boolean}}
 *   - `saved:false` = 没存过（**按出厂默认，0.4.7.2 起是关**）或存坏了
 *   - `broken:true` = 存坏了，界面要如实说「已按关处理」
 */
export function readUaAutoAlign() {
  let raw = null;
  try {
    raw = getMeta(UA_AUTOALIGN_KEY);
  } catch {
    return { enabled: UA_AUTOALIGN, saved: false, broken: false };
  }
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { enabled: UA_AUTOALIGN, saved: false, broken: false };
  }
  const text = String(raw).trim();
  // 只认明确的开/关；其余（脏数据）**一律当关** —— 这是会改写用户 UA 的开关，
  // 读不懂就必须偏向「不动用户数据」。
  if (text === 'true' || text === '1') return { enabled: true, saved: true, broken: false };
  if (text === 'false' || text === '0') return { enabled: false, saved: true, broken: false };
  return { enabled: false, saved: false, broken: true };
}

/**
 * 写开关。只接受布尔（或 'true'/'false' 字符串），别的一律拒 —— 不猜用户意图。
 * @returns {{enabled:boolean, saved:true, changed:boolean}}
 */
export function writeUaAutoAlign(value) {
  const prev = readUaAutoAlign();
  let next;
  if (value === true || value === 'true' || value === 1 || value === '1') next = true;
  else if (value === false || value === 'false' || value === 0 || value === '0') next = false;
  else {
    const e = new Error('enabled must be a boolean');
    e.code = 'INVALID_ENABLED';
    throw e;
  }
  setMeta(UA_AUTOALIGN_KEY, next ? 'true' : 'false');
  return { enabled: next, saved: true, changed: prev.enabled !== next };
}

/**
 * 这次启动实际要不要跟版（`manager.startProfile` 只读这一个函数）。
 *
 * **关着的时候，任何路径都不许改写 `ua` / `client_hints` / `kernel_version`** ——
 * 包括启动前那次「只剩版本冲突才对齐」的预对齐（它会改这一轮呈现的指纹，虽然不落库）。
 * 判据 `test/ua-hints-kernel.test.mjs` 组 1 与 `test/ua-autoalign.test.mjs` 的静态扫描钉这一条。
 */
export function uaAutoAlignEnabled() {
  return readUaAutoAlign().enabled === true;
}

/* ==================== 总是打开起始页（0.4.7.3） ====================
 *
 * 起始页本身是「`open_urls` 为空时的兜底」—— 那条不需要开关，因为空白页没有任何用户价值。
 * 这个开关管的是**有启动网址时**要不要也在第一张多开一张起始页（对手默认就这么做）。
 *
 * **默认关**：用户库里 100 个环境配了启动网址，多开一张标签是可见的行为改变，
 * 不能替用户决定。关着时「`open_urls` 有值 → 行为与 0.4.7.2 逐字节一致」。
 *
 * 存库（meta 表）而不是 localStorage：它要在**服务端**生效（`manager.startProfile` 读它）。
 * 键名不许改（改名等于把用户的选择丢掉）。
 */
export const ALWAYS_START_PAGE_KEY = 'always_start_page';

/**
 * 读「总是打开起始页」。
 * @returns {{enabled:boolean, saved:boolean, broken:boolean}} 没存过 = 关（默认）
 */
export function readAlwaysStartPage() {
  let raw = null;
  try {
    raw = getMeta(ALWAYS_START_PAGE_KEY);
  } catch {
    return { enabled: false, saved: false, broken: false };
  }
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { enabled: false, saved: false, broken: false };
  }
  const text = String(raw).trim();
  // 只认明确的开/关；脏数据一律当关 —— 读不懂就不改用户的启动行为
  if (text === 'true' || text === '1') return { enabled: true, saved: true, broken: false };
  if (text === 'false' || text === '0') return { enabled: false, saved: true, broken: false };
  return { enabled: false, saved: false, broken: true };
}

/**
 * 写开关。只接受布尔（或 'true'/'false' 字符串），别的一律拒。
 * @returns {{enabled:boolean, saved:true, changed:boolean}}
 */
export function writeAlwaysStartPage(value) {
  const prev = readAlwaysStartPage();
  let next;
  if (value === true || value === 'true' || value === 1 || value === '1') next = true;
  else if (value === false || value === 'false' || value === 0 || value === '0') next = false;
  else {
    const e = new Error('enabled must be a boolean');
    e.code = 'INVALID_ENABLED';
    throw e;
  }
  setMeta(ALWAYS_START_PAGE_KEY, next ? 'true' : 'false');
  return { enabled: next, saved: true, changed: prev.enabled !== next };
}

/* ==================== 关闭环境时自动备份（0.4.7 ③） ====================
 *
 * **默认必须是关**。理由不是「实现简单」，是这个开关会让磁盘持续增长：
 * 每个环境留 5 份、每份是真 userdata 的拷贝（实测 14.7 MB → 2.5 MB，真实环境带
 * LocalStorage/IndexedDB 只会更大），几十个环境就是几百 MB 到 GB 级。
 * **替用户决定占磁盘是不可接受的**，所以没存过就是关。
 *
 * 存在库里（meta 表）而不是 localStorage：备份是**服务端**在关环境时做的
 * （`manager.stopProfile`），浏览器 localStorage 服务端读不到 —— 和 `sync_defaults` 同一个理由。
 *
 * 键名不许改（改名等于把用户的选择丢掉）。
 */
export const SNAPSHOT_ON_CLOSE_KEY = 'snapshot_on_close';

/** 上一次自动备份的结果（界面要能显示「上次自动备份失败」） */
export const SNAPSHOT_ON_CLOSE_STATE_KEY = 'snapshot_on_close_state';

/**
 * 读「关环境自动备份」开关。
 * @returns {{enabled:boolean, saved:boolean, broken:boolean}}
 *   - `saved:false` = 没存过（**默认关**）或存坏了；`broken:true` = 存坏了，界面要如实说
 */
export function readSnapshotOnClose() {
  let raw = null;
  try {
    raw = getMeta(SNAPSHOT_ON_CLOSE_KEY);
  } catch {
    return { enabled: false, saved: false, broken: false };
  }
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { enabled: false, saved: false, broken: false };
  }
  const text = String(raw).trim();
  // 只认明确的开：'true' / '1'。其余（含脏数据、'yes'、空）**一律当关** ——
  // 这是会占磁盘的开关，读不懂就必须偏向「不占」。
  if (text === 'true' || text === '1') return { enabled: true, saved: true, broken: false };
  if (text === 'false' || text === '0') return { enabled: false, saved: true, broken: false };
  return { enabled: false, saved: false, broken: true };
}

/**
 * 写开关。只接受布尔（或 'true'/'false' 字符串），别的一律拒 —— 不猜用户意图。
 * @returns {{enabled:boolean, saved:true, changed:boolean}}
 */
export function writeSnapshotOnClose(value) {
  const prev = readSnapshotOnClose();
  let next;
  if (value === true || value === 'true' || value === 1 || value === '1') next = true;
  else if (value === false || value === 'false' || value === 0 || value === '0') next = false;
  else {
    const e = new Error('enabled must be a boolean');
    e.code = 'INVALID_ENABLED';
    throw e;
  }
  setMeta(SNAPSHOT_ON_CLOSE_KEY, next ? 'true' : 'false');
  return { enabled: next, saved: true, changed: prev.enabled !== next };
}

/**
 * 自动备份的结果，**按环境存**（一个 map），因为界面上是在某个环境的「备份快照」页里看「上次失败」。
 *
 * @param {string} [profileId] 给 id 就取这个环境的；不给就取**最近一次**（设置页那句汇总用）
 * @returns {{at:string, ok:boolean, reason?:string, snap_id?:string, message?:string}|null}
 */
export function readSnapshotOnCloseState(profileId) {
  let raw = null;
  try {
    raw = getMeta(SNAPSHOT_ON_CLOSE_STATE_KEY);
  } catch {
    return null;
  }
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  let parsed = null;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (profileId !== undefined && profileId !== null) {
    const one = parsed[String(profileId)];
    return one && typeof one === 'object' ? one : null;
  }
  // 不给 id：取时间最新的那条（设置页「上次自动备份失败」用）
  let best = null;
  for (const v of Object.values(parsed)) {
    if (!v || typeof v !== 'object') continue;
    if (!best || String(v.at || '') > String(best.at || '')) best = v;
  }
  return best;
}

/** 记一次自动备份的结果（成功也记：界面要能显示「上次自动备份成功」） */
export function writeSnapshotOnCloseState(profileId, state = {}) {
  const payload = {
    at: state.at || new Date().toISOString(),
    ok: state.ok === true,
    ...(state.reason ? { reason: String(state.reason) } : {}),
    ...(state.snap_id ? { snap_id: String(state.snap_id) } : {}),
    ...(state.message ? { message: String(state.message).slice(0, 300) } : {}),
  };
  try {
    let map = {};
    try {
      const raw = getMeta(SNAPSHOT_ON_CLOSE_STATE_KEY);
      const parsed = raw ? JSON.parse(String(raw)) : null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed;
    } catch { map = {}; }
    map[String(profileId)] = payload;
    // 只留最近 200 个环境的结果：这是「上次怎样」的提示，不是历史日志，不能无限长
    const keys = Object.keys(map);
    if (keys.length > 200) {
      keys.sort((a, b) => String(map[a]?.at || '').localeCompare(String(map[b]?.at || '')));
      for (const k of keys.slice(0, keys.length - 200)) delete map[k];
    }
    setMeta(SNAPSHOT_ON_CLOSE_STATE_KEY, JSON.stringify(map));
  } catch { /* 记不下来不影响关环境；下次还会再记 */ }
  return payload;
}