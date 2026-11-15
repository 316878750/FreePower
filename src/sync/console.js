/**
 * 窗口同步的**操作台**（对手的 Console 桌面小组件）：纯逻辑 + 跨进程文件交接。
 *
 * 为什么单独一个文件：这里有两类东西，都必须能被 A 层判据直接测，
 * 又不能把 Electron 拖进测试：
 *   1. **纯函数**：两种形态的尺寸、设置归一化、位置校验（给定显示器布局 + 保存的 rect，
 *      决定「用保存值」还是「回主屏居中」）、收起条上到底显示哪几项；
 *   2. **文件交接**：桌面壳写状态、界面写请求 —— 与 `hotkey.js` 同一套姿势，
 *      因为渲染进程没有 Node、没有 preload，而注册窗口/改窗口尺寸是 Electron 主进程的能力。
 *
 *   `sync-console.state.json`    桌面壳写 → 界面读（现在是什么形态、有什么设置、在不在管）
 *   `sync-console.request.json`  界面写 → 桌面壳读（用户点了收起/展开、改了自动收起、点了复位）
 *
 * 对手证据（`28-远端UI界面结构.md:141,149,180-182`）：顶部有「收起/展开操作台 `openConsole`」，
 * 设置里「操作台 `console` + 自动收起 `automaticShrink`」，操作台区块文案
 * `syncOperate3`="正在同步操作"、`syncOperate4`="关闭「桌面小组件」即可把操作台恢复至原来位置"。
 * 尺寸与默认值**对手没有给数字**，430×620 / 360×56 与「自动收起默认开」都是**我们选的**（README 已标）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

/* ------------------------------ 常量 ------------------------------ */

export const CONSOLE_MODES = Object.freeze(['expanded', 'collapsed']);

/**
 * 两种形态的窗口尺寸（**像素，我们的选择，不是对手原值**）。
 * 收起态必须真的比展开态矮得多 —— 展开态 430×620 置顶会挡住主控窗口，这正是「自动收起」存在的理由。
 * 收起态 360×56：一行放得下「正在同步操作 · 主控名 · 受控 N 个 · 停止 · 展开」。
 */
export const CONSOLE_EXPANDED = Object.freeze({ width: 430, height: 620 });
export const CONSOLE_COLLAPSED = Object.freeze({ width: 360, height: 56 });

/** 展开态的最小尺寸（用户可以拉大，但不许拉成一条缝） */
export const CONSOLE_MIN_EXPANDED = Object.freeze({ width: 380, height: 420 });

/**
 * 「算不算还在屏幕上」：窗口与某块屏的可用区交集至少这么多像素，用户才抓得到它。
 * 64×24 是「能看见标题条的一角、能拖回来」的经验值，也是我们选的。
 */
export const CONSOLE_MIN_VISIBLE = Object.freeze({ width: 64, height: 24 });

/**
 * 操作台设置的默认值（`automaticShrink` 对应这里的 `auto_shrink`）。
 *
 * **自动收起默认开**：展开态 430×620 且始终置顶，同步一开始就压在主控窗口上；
 * 用户点「开始同步」的下一秒就要在主控窗口里操作，那块面板正好挡住他要点的位置。
 * 对手的默认值**没有证据**（`dyn-staticconfig.json` 里没有这个键），所以这是我们的选择，README 与升级说明都标了。
 */
export const DEFAULT_CONSOLE_PREFS = Object.freeze({ open: true, auto_shrink: true });

/** 桌面壳多久没写状态就算「没有桌面壳在管」（纯网页跑 `npm start` 时就是这个状态） */
export const CONSOLE_STALE_MS = 30000;

/* ------------------------------ 纯函数 ------------------------------ */

export function normalizeConsoleMode(v) {
  return v === 'collapsed' ? 'collapsed' : 'expanded';
}

/** 设置归一化：只认 `open` / `auto_shrink` 两个布尔；缺省取默认（都是 true） */
export function normalizeConsolePrefs(raw = {}) {
  const bool = (v, dflt) => (v === undefined || v === null ? dflt : v === true || v === 'true' || v === 1 || v === '1');
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    open: bool(src.open, DEFAULT_CONSOLE_PREFS.open),
    auto_shrink: bool(src.auto_shrink, DEFAULT_CONSOLE_PREFS.auto_shrink),
  };
}

/** 形态 → 窗口尺寸（宽度高度都只由形态决定，位置记忆不记尺寸） */
export function consoleSizeOf(mode) {
  return normalizeConsoleMode(mode) === 'collapsed'
    ? { ...CONSOLE_COLLAPSED }
    : { ...CONSOLE_EXPANDED };
}

/** 两个矩形（含 x/y/w/h）的交集尺寸，没有交集就是 0×0 */
export function visibleArea(rect, area) {
  const r = rect || {};
  const a = area || {};
  const w = Math.min(Number(r.x || 0) + Number(r.width || 0), Number(a.x || 0) + Number(a.width || 0))
    - Math.max(Number(r.x || 0), Number(a.x || 0));
  const h = Math.min(Number(r.y || 0) + Number(r.height || 0), Number(a.y || 0) + Number(a.height || 0))
    - Math.max(Number(r.y || 0), Number(a.y || 0));
  return { width: Math.max(0, w), height: Math.max(0, h) };
}

function centerIn(workArea, size) {
  const wa = workArea || { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: Math.round(Number(wa.x || 0) + Math.max(0, (Number(wa.width || 0) - size.width) / 2)),
    y: Math.round(Number(wa.y || 0) + Math.max(0, (Number(wa.height || 0) - size.height) / 2)),
    width: size.width,
    height: size.height,
  };
}

/**
 * 位置校验：给定**当前**显示器布局与**上次保存**的位置，决定窗口放哪。
 *
 * 为什么必须在保存/恢复时校验而不是只信保存值：用户会拔掉副屏、改缩放、把任务栏挪走 ——
 * 这时候原来的坐标落在屏幕外，窗口就「打开看不见、还抢着置顶」，用户只能去任务管理器杀进程。
 *
 * @param {{saved?: {x:number,y:number}|null, displays?: object[], mode?: string}} opt
 *   `displays` 用 Electron 的 `screen.getAllDisplays()` 形状（`workArea` + `primary`）。
 * @returns {{rect:{x:number,y:number,width:number,height:number},
 *            source:'saved'|'reset',
 *            reason:'saved'|'no_saved'|'bad_saved'|'no_displays'|'off_screen'}}
 *   `source:'saved'` = 用保存的位置；`'reset'` = 回主屏居中（并说明为什么）。
 */
export function pickConsoleRect({ saved = null, displays = [], mode = 'expanded' } = {}) {
  const size = consoleSizeOf(mode);
  const list = (Array.isArray(displays) ? displays : []).filter((d) => d && d.workArea);
  const primary = list.find((d) => d.primary === true) || list[0] || null;

  if (!list.length) {
    // 一块屏都读不到（无头/远程会话）：给一个稳定值，别返回 null 让调用方去猜
    return { rect: { x: 0, y: 0, ...size }, source: 'reset', reason: 'no_displays' };
  }
  if (!saved || !Number.isFinite(Number(saved.x)) || !Number.isFinite(Number(saved.y))) {
    return { rect: centerIn(primary.workArea, size), source: 'reset', reason: saved ? 'bad_saved' : 'no_saved' };
  }

  const rect = { x: Math.round(Number(saved.x)), y: Math.round(Number(saved.y)), ...size };
  const hit = list.find((d) => {
    const a = visibleArea(rect, d.workArea);
    return a.width >= CONSOLE_MIN_VISIBLE.width && a.height >= CONSOLE_MIN_VISIBLE.height;
  });
  if (hit) return { rect, source: 'saved', reason: 'saved' };
  // 副屏被拔掉 / 改了缩放 / 分辨率变小 → 原坐标在屏幕外
  return { rect: centerIn(primary.workArea, size), source: 'reset', reason: 'off_screen' };
}

/**
 * 收起条上到底显示什么（对应对手的 `syncOperate3`="正在同步操作"）。
 *
 * **只放这五项**：状态词、主控环境名、受控数量、停止、展开。
 * 别的（事件计数、尺寸警告、快捷键状态）都不放 —— 收起态存在的意义就是「不挡、但还看得见在同步」。
 *
 * 状态词如实映射：我们**没有**对手那个「同步异常 `syncOperateSyncException`」的对应状态 ——
 * 我们的引擎在个别窗口断连时**照样继续跑**（`degraded` 只是那个窗口的连接没了）。
 * 所以这种情况标题仍然是「正在同步操作」，另给一行 detail 说「有 N 个窗口连接断了」，
 * 不硬造一个对不上的状态词。
 *
 * @returns {{title:string, master:string, slaves:string,
 *            actions:Array<{id:string,label:string}>, items:string[],
 *            tone:'ok'|'warn'|'idle', detail:string}}
 */
export function consoleBarModel({ status = {}, masterName = '' } = {}) {
  const running = status?.running === true;
  const masterId = String(status?.master_id || '');
  const slaveCount = Array.isArray(status?.slave_ids) ? status.slave_ids.length : 0;
  const degraded = (Array.isArray(status?.windows) ? status.windows : []).filter((w) => w && w.degraded).length;

  const title = running ? '正在同步操作' : '同步已停止';
  const master = masterName || (masterId ? masterId.slice(0, 8) : '未选主窗口');
  const slaves = `受控 ${running ? slaveCount : 0} 个`;
  const actions = running
    ? [{ id: 'stop', label: '停止' }, { id: 'expand', label: '展开' }]
    : [{ id: 'expand', label: '展开' }];

  return {
    title,
    master,
    slaves,
    actions,
    items: [title, master, slaves, ...actions.map((a) => a.label)],
    tone: !running ? 'idle' : (degraded ? 'warn' : 'ok'),
    detail: running && degraded ? `有 ${degraded} 个窗口连接断了` : '',
  };
}

/** 展开态顶部那行状态词（与收起条同一个来源，避免两处说法不一致） */
export function consoleStatusWord(status = {}) {
  if (status?.running !== true) return { text: '同步没在跑', tone: 'idle' };
  const degraded = (Array.isArray(status.windows) ? status.windows : []).filter((w) => w && w.degraded).length;
  return { text: '同步中', tone: degraded ? 'warn' : 'ok' };
}

/* ------------------------------ 文件交接 ------------------------------ */

export const CONSOLE_STATE_FILE = path.join(DATA_DIR, 'sync-console.state.json');
export const CONSOLE_REQUEST_FILE = path.join(DATA_DIR, 'sync-console.request.json');

function readJson(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
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

/**
 * 界面读：桌面壳写下的当前形态与设置。
 * `managed:false` = 没有桌面壳在管（纯网页跑服务）—— 这时操作台这个能力**根本不存在**，
 * 界面必须如实说「桌面版才有操作台」，不许摆一个点了没反应的按钮。
 */
export function readConsoleState() {
  const st = readJson(CONSOLE_STATE_FILE) || {};
  const at = st.at || null;
  const age = at ? Date.now() - Date.parse(at) : Infinity;
  const fresh = Number.isFinite(age) && age <= CONSOLE_STALE_MS;
  const rects = {};
  for (const m of CONSOLE_MODES) {
    const r = st.rects && st.rects[m];
    rects[m] = r && Number.isFinite(Number(r.x)) && Number.isFinite(Number(r.y))
      ? { x: Math.round(Number(r.x)), y: Math.round(Number(r.y)) }
      : null;
  }
  return {
    managed: st.managed === true && fresh,
    mode: normalizeConsoleMode(st.mode),
    prefs: normalizeConsolePrefs(st.prefs),
    rect: st.rect && typeof st.rect === 'object' ? st.rect : null,
    rects,
    displays_count: Number.isFinite(Number(st.displays_count)) ? Number(st.displays_count) : 0,
    at,
    age_ms: Number.isFinite(age) ? Math.round(age) : null,
  };
}

/**
 * 桌面壳写：形态 / 设置 / 位置 / 显示器数量（数量用来判断「副屏拔了没」）。
 *
 * 位置按形态分开记（`rects.expanded` / `rects.collapsed`）：收起态和展开态的左上角本来就不是同一个点，
 * 共用一个会让「收起 → 展开」每次跳位置。`rect` 是**当前**窗口的实际 bounds，只用于诊断。
 */
export function writeConsoleState({ mode, prefs, rect = null, rects = {}, displays_count = 0 }) {
  const cleanRect = (r) => (r && Number.isFinite(Number(r.x)) && Number.isFinite(Number(r.y)) ? {
    x: Math.round(Number(r.x)), y: Math.round(Number(r.y)),
    width: Math.round(Number(r.width) || 0), height: Math.round(Number(r.height) || 0),
  } : null);
  return writeJson(CONSOLE_STATE_FILE, {
    managed: true,
    mode: normalizeConsoleMode(mode),
    prefs: normalizeConsolePrefs(prefs),
    rect: cleanRect(rect),
    rects: {
      expanded: cleanRect(rects.expanded),
      collapsed: cleanRect(rects.collapsed),
    },
    displays_count: Number(displays_count) || 0,
    at: new Date().toISOString(),
  });
}

/**
 * 界面写：请求桌面壳做一件事。
 * @param {{mode?:string, prefs?:object, reset_position?:boolean}} req
 * @returns {{ok:boolean, managed:boolean, error?:string}}
 */
export function requestConsole(req = {}) {
  const st = readConsoleState();
  if (!st.managed) {
    // 没有人会读这个请求：写下去等于「说了但没做」
    return { ok: false, managed: false, error: '没有桌面壳在管（纯网页跑服务时没有操作台）' };
  }
  const body = { at: new Date().toISOString() };
  if (req.mode !== undefined) body.mode = normalizeConsoleMode(req.mode);
  if (req.prefs !== undefined) body.prefs = normalizeConsolePrefs(req.prefs);
  if (req.reset_position === true) body.reset_position = true;
  if (body.mode === undefined && body.prefs === undefined && !body.reset_position) {
    return { ok: false, managed: true, error: '请求里没有可执行的动作' };
  }
  return { ok: writeJson(CONSOLE_REQUEST_FILE, body), managed: true };
}

/** 桌面壳用：读界面请求（没有就是 null）。调用方按 `at` 去重，同一请求不重复执行。 */
export function readConsoleRequest() {
  const r = readJson(CONSOLE_REQUEST_FILE);
  if (!r?.at) return null;
  return {
    at: r.at,
    mode: r.mode === undefined ? undefined : normalizeConsoleMode(r.mode),
    prefs: r.prefs === undefined ? undefined : normalizeConsolePrefs(r.prefs),
    reset_position: r.reset_position === true,
  };
}
