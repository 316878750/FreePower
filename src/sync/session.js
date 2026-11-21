/**
 * 窗口同步会话（阶段 1：键鼠捕获 → 回放 + 坐标映射 + 四个开关 + 延迟）。
 *
 * 连接策略（方案 Q6）：**每个环境另开一条浏览器级 CDP 连接**，只用显式 `attachToTarget`，
 * **不碰 `Target.setAutoAttach`** —— `manager.js` 的 `applyToSession` 已经占了 auto-attach
 * （`manager.js:630` / `:729`），两个客户端抢同一个 auto-attach 会让另一个收不到事件。
 *
 * 主窗口：`Runtime.addBinding` + `Page.addScriptToEvaluateOnNewDocument` 捕获键鼠；
 * 受控窗口：**零注入**，只收 CDP `Input`。
 */
import crypto from 'node:crypto';
import { CdpClient } from '../kernel/cdp.js';
import { getInstance, getRunning, logProfile } from '../runtime/manager.js';
import { installedExpression, markerNames } from '../kernel/markers.js';
import { buildActivationScript, buildCaptureScript } from './agent-script.js';
import { newBindingName } from './binding.js';
import { buildSyncPlan, enabledBySwitch, mapPointStatus } from './replay.js';
import { makeTextResolver, textOf } from './text-input.js';
import { SyncScheduler, makeRng } from './scheduler.js';
import { isStartPageUrl } from '../start/host.js';
import {
  FOLLOW_INTERVAL_MS, PageFollower, choosePage, pageKind, pageUsableReason, staleHint,
} from './follow.js';
import {
  normalizeState, needsRestoreBeforeResize, summarizeResize, verifyBounds,
} from './window.js';
import {
  autoFit, auditPlan, planArrange, placeOne, summarizeArrange,
} from './arrange.js';
import { screensForArrange } from './displays.js';
import { planForce, planShow, summarizeForce, summarizeShow, verifyForced, verifyShown } from './show.js';
import { DEFAULT_SETTINGS, normalizeSettings } from './settings.js';
import {
  closeTabAt, isBlankUrl, listTabs, navigateAt, openTabFor,
  parseOpenUrls, planCloseBlank, planCloseOthers, planUnify, readVisibility, settle, targetIndex,
  visibleTabIndex,
} from './tabs.js';

/** 一次只允许一个同步会话：两套同时往同一批窗口发输入必然是灾难 */
let current = null;

/**
 * 上一次会话收尾的读数（判据用）。
 * 为什么需要它：binding 名在页面里**抓完就 delete 了**，所以「stop 之后页面里查不到」
 * 这件事在摘不摘 `removeBinding` 时都成立 —— 光看页面看不出来。这里记的是主进程侧
 * 到底有没有真的摘掉，`removed:false` 就是「没摘」的铁证。
 */
let lastTeardown = null;

/**
 * 上一次会话**为什么结束**（0.4.7.11）。
 *
 * `lastTeardown` 只讲 binding 摘没摘；用户真正要问的是「我什么都没干它怎么停了」。
 * 主窗口标签全关（`master_target_gone`）、连接断了（`connection_lost`）、用户自己停（`user_stop`）
 * 三种原因必须能区分，否则界面只能说一句「同步没在跑」。
 */
let lastEnd = null;

export function getTeardown() {
  return lastTeardown;
}

export function getSession() {
  return current;
}

/* 默认设置与归一化在 `./settings.js`（0.4.3 ④ 的「设置」页要单独读它，
 * 而 `prefs.js → session.js` 会把整个运行时拖进来）。这里原样再导出，对外契约不变。 */
export { DEFAULT_SETTINGS, normalizeSettings };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------- 存活探针（R5 的 alive） -------------------------
 * 捕获脚本会在文档里放一个 **Symbol 键、不可枚举** 的探针对象 `{at, off}`（见 agent-script.js）。
 * 主进程读它**不需要名字**：枚举 own symbols，找那个 `{at: number, off: function}` 形状的对象。
 *
 * 为什么不用字符串名：第一版用了每会话随机的 `_s<8hex>` 字符串名，被 P0 判据当场抓出来 ——
 * `Object.getOwnPropertyNames(window)` 里多一条 `_s<8hex>` 且整个会话期间都在，是持久检测面。
 * Symbol 键不进 own names / for...in / Object.keys / JSON，页面按名字也搜不到。
 */
const PROBE_FIND = `var ss = Object.getOwnPropertySymbols(window);
    for (var i = 0; i < ss.length; i++) {
      var v; try { v = window[ss[i]]; } catch (e) { continue; }
      if (v && typeof v === 'object' && typeof v.off === 'function' && typeof v.at === 'number') { probe = v; break; }
    }`;
const PROBE_READ_EXPR = `(() => {
  var probe = null;
  try { ${PROBE_FIND} } catch (e) {}
  return JSON.stringify({ a: !!probe, h: location.href });
})()`;
const PROBE_BOOL_EXPR = `(() => {
  var probe = null;
  try { ${PROBE_FIND} } catch (e) {}
  return !!probe;
})()`;
const PROBE_OFF_EXPR = `(() => {
  var n = 0;
  try {
    var ss = Object.getOwnPropertySymbols(window);
    for (var i = 0; i < ss.length; i++) {
      var v; try { v = window[ss[i]]; } catch (e) { continue; }
      if (v && typeof v === 'object' && typeof v.off === 'function') {
        try { v.off(); } catch (e) {}
        try { delete window[ss[i]]; n += 1; } catch (e) {}
      }
    }
  } catch (e) {}
  return n;
})()`;

/* ------------------------------ CDP 小工具 ------------------------------ */

/** 连一条浏览器级 ws（实例里已有 `wsUrl`，见 manager.js:321） */
async function connectInstance(profileId) {
  const inst = getInstance(profileId);
  if (!inst) throw new Error(`环境 ${profileId} 没有运行实例`);
  if (!inst.wsUrl) throw new Error(`环境 ${profileId} 没有 CDP 地址`);
  const client = await CdpClient.connect(inst.wsUrl, { timeoutMs: 8000 });
  return { inst, client };
}

/**
 * 选一张页面 target 去同步。
 *
 * 0.4.7.10：**优先选前台可见的那张**。
 *
 * 现场（用户 2026-11-21 实测）：主控和 3 个受控窗口各开了 3–4 个标签，每个窗口**可见**的都是
 * `defi.xstocks.fi/points`，但后台还挂着 `app.startale.com/sign-up`。旧实现取「第一张 URL 像真站的 page」，
 * `/json/list` 里 startale 排在前面 → 同步目标连到了**看不见的** startale。
 * 用户看着 xstocks 操作，输入全打到后台那张页上，于是「怎么点都没反应」。
 * 采集端、派发端、调度器全都正常（events=105 forwarded=105 errors=0），断的就是「连错标签」这一步。
 * 主控连错同样致命：捕获脚本装在隐藏页上，一条事件都抓不到。
 *
 * 优先级（0.4.7.10）：
 *   ① **可见 + 真站** → `source:'visible'`，`confident:true`
 *   ② 读不到可见（窗口最小化 / 全读失败）或可见的是起始页 → 退回**第一张真站**（跳过起始页/空白/内部页），
 *      `source:'real-fallback'`，`confident:false` —— 「跳过起始页」这条**保留**，只是降级为兜底
 *   ③ 连真站都没有 → `pages[0]`，`source:'first-page'`，`confident:false`
 *
 * 返回形状：`{ targetId, url, visible, confident, source, visible_url, visible_target_id }`
 * （`visible` 是实测值，读不到就是 `null`）。老的调用方只用 `.targetId`，形状兼容。
 *
 * 0.4.7.11：选择规则搬进 `./follow.js` 的 `choosePage()`（纯函数），
 * 因为**运行中**每 450ms 要按同一套规则重选一次（用户会切标签、关标签、开新标签）。
 * 启动时选对、运行中跟着走，必须是同一段逻辑，否则迟早分叉。
 */
export async function pickPageTarget(client) {
  const { targetInfos } = await client.send('Target.getTargets');
  const pages = (targetInfos || []).filter((t) => t.type === 'page');
  if (!pages.length) return null;

  /* 可见性读不到就整张表都是 null —— 这时**不许**当成「都隐藏」，要走兜底。
   * 同时把每张页的**真实** href 取回来（targetInfo 的 url 在错误页上是「想去的地址」，不可信）。 */
  let vis = new Map();
  try { vis = await readVisibility(client, pages.map((t) => t.targetId)); } catch { /* 全当未知 */ }
  return choosePage(pages, vis);
}

/**
 * 主窗口这张页面**能不能同步**（0.4.7.4）。返回 `null` = 能，返回字符串 = 不能的原因（人话）。
 *
 * 为什么要有这道前置检查（用户实测的坑，2026-11-17）：
 *   他 3 个环境全停在 **Chrome 错误页**（代理挂了），主窗口上根本没有可捕获的页面。
 *   老实现照样把会话起起来：binding 装上了、`Page.frameNavigated` 也挂了，
 *   但页面上永远不会有人按键 → 一条事件都抓不到，用户看到的就是「同步没反应」，
 *   而日志里干干净净，谁都看不出是「没有页面」还是「引擎坏了」。
 *   所以宁可**在起会话之前**明确拒绝，也不许起一个抓不到事件的死会话。
 *
 * 口径（哪张能、哪张不能）：
 *   - `chrome-error://`（打不开的站、代理失败）→ 不能，页面不是站点文档；
 *   - `devtools://` / `chrome://` / `chrome-extension://` / `view-source:` → 不能，
 *     这些页面拿不到键盘焦点，也没有可捕获的 DOM；
 *   - `about:blank` → **看注入**：注入脚本跑过（有派生标记）说明这是我们接管的空白页，
 *     能同步（新建标签的常态）；没跑过就是一张死的空白页，不能。
 *
 * 0.4.7.11：实现搬进 `./follow.js` 的 `pageUsableReason()` —— 启动时的前置检查和
 * `choosePage()` 的选目标规则要共用同一套口径，两处各写一份迟早分叉。
 * 这里只保留导出名（判据在用）。
 */
const unusableMasterPage = pageUsableReason;

/**
 * 主窗口「能不能开始同步」的判定（0.4.7.10 从 startSync 里抽出来，好让判据真求值测）。
 *
 * 两个来源，缺一不可：
 *   - `href`：选中那张页**自己报的** `location.href`（错误页只有它能看出停在 chrome-error）；
 *   - `visibleUrl`：前台那张页的真实 href。**前台是起始页、真站在后台标签里**时，不许悄悄同步后台那张
 *     —— 用户看的是起始页，同步后台页等于「点了没反应」，正是这次要修的 bug。
 *     同时 0.4.7.5 的「主窗口停在起始页就拒绝」必须保住。
 *
 * @returns {string|null} `null` = 能同步；字符串 = 不能同步的原因（人话）
 */
export function masterBlockReason({ href, injected = false, visibleUrl = null } = {}) {
  const h = String(href || '');
  const vis = String(visibleUrl || '');
  if (vis && isStartPageUrl(vis) && !isStartPageUrl(h)) {
    return '主窗口停在起始页（前台是起始页，真站在后台标签里，同步它等于点了没反应）';
  }
  return unusableMasterPage(h, { injected });
}

async function attach(client, targetId) {
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  return sessionId;
}

/** 受控窗口的可视视口（CSS px）。窗口最小化 / 还没布局时可能拿不到，返回 null 由调用方丢弃事件 */
async function viewportOf(client, sessionId) {
  try {
    const m = await client.send('Page.getLayoutMetrics', {}, sessionId);
    const v = m?.cssVisualViewport || m?.visualViewport;
    const w = Number(v?.clientWidth);
    const h = Number(v?.clientHeight);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return { vw: Math.round(w), vh: Math.round(h) };
  } catch {
    return null;
  }
}

/** 窗口外框尺寸（给「尺寸不一致」提示用，8b 判据读它） */
async function windowSizeOf(client, targetId) {
  try {
    const { windowId, bounds } = await client.send('Browser.getWindowForTarget', { targetId });
    return { windowId, width: bounds?.width ?? null, height: bounds?.height ?? null, state: bounds?.windowState || null };
  } catch {
    return null;
  }
}

/** 窗口的完整矩形（位置 + 尺寸 + 状态）：「窗口排列」的回读比对读它 */
async function windowRectOf(client, targetId) {
  try {
    const { bounds } = await client.send('Browser.getWindowForTarget', { targetId });
    return {
      x: bounds?.left ?? null,
      y: bounds?.top ?? null,
      width: bounds?.width ?? null,
      height: bounds?.height ?? null,
      state: bounds?.windowState || null,
    };
  } catch {
    return null;
  }
}

/* ------------------------------ 「要动哪些窗口」：与同步会话解绑（0.4.7.4） ------------------------------ */

/**
 * 为什么会有这一段（用户实测的可用性问题，2026-11-17）：
 * AdsPower 的正常流程是「勾选环境 → 窗口排列 → 启动同步」——**排列不需要同步已经起来**，
 * 它作用在勾选的那些窗口上。我们把 `arrange` / `show` / `show/force` / `unify-size`
 * 四个动作全绑在同步会话上（`if (!current) throw`），用户按习惯先排列就直接吃到 100002，
 * 而界面上「窗口排列」区块就在那里、点了就报错。
 *
 * 解绑的边界（都是硬约束，不是风格）：
 *   · **不新起内核、不 startProfile、不重连**：只用 `getInstance(id)` 已经连着的
 *     浏览器级 CDP 客户端；窗口位置尺寸（`Browser.getWindowForTarget` / `setWindowBounds`）
 *     本来就是浏览器级命令，连 session 都不用开；
 *   · 有会话且没给 ids → 行为与解绑前**完全一致**（用会话里的 targets，不重复 attach）；
 *   · 给了 ids → 会话里已有的直接复用（不重复 attach），其余按运行实例解析；
 *   · 既没会话也没 ids → 100002 + 人话，明确说「先勾选正在运行的环境」。
 */

/** 把 `ids` 归一成字符串数组：接受数组 / 单个 id / 逗号串；去空、去重、保序。 */
function normalizeIdList(raw) {
  const flat = Array.isArray(raw) ? raw : (raw === undefined || raw === null ? [] : [raw]);
  const out = [];
  for (const x of flat) {
    if (x === undefined || x === null) continue;
    for (const part of String(x).split(',')) {
      const id = part.trim();
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** 这个环境在会话里是什么角色；不在会话里就是普通窗口（解绑路径才有这个值） */
function roleOf(profileId) {
  if (!current) return 'window';
  if (profileId === current.master) return 'master';
  if (current.slaves.includes(profileId)) return 'slave';
  return 'window';
}

/**
 * 解析「这次要动哪些窗口」。
 * @param {string[]|string|null} rawIds
 * @param {{what?:string}} opt `what` 只进错误文案（排列 / 显示 / 统一尺寸）
 * @returns {Promise<{handles:Array, skipped:Array, source:'session'|'ids'}>}
 */
async function resolveWindows(rawIds, { what = '排列' } = {}) {
  const want = normalizeIdList(rawIds);
  const handles = [];
  const skipped = [];

  // ① 没给 ids：沿用同步会话（解绑前的行为，一个字节都不变）
  if (!want.length) {
    if (!current) {
      const err = new Error(`没有可${what}的窗口：先勾选正在运行的环境（同步没开始时也能排列），或者先开始同步`);
      err.reason = 'no_windows';
      throw err;
    }
    for (const id of [current.master, ...current.slaves]) {
      const t = current.targets.get(id);
      if (!t) continue;
      handles.push({
        id, client: t.client, targetId: t.targetId, sessionId: t.sessionId,
        role: id === current.master ? 'master' : 'slave', source: 'session', attachedByUs: false,
      });
    }
    if (!handles.length) {
      const err = new Error(`没有可${what}的窗口：同步会话里没有可用的窗口连接`);
      err.reason = 'no_windows';
      throw err;
    }
    return { handles, skipped, source: 'session' };
  }

  // ② 给了 ids：会话里已有的直接复用（不重复 attach），其余用运行实例的浏览器级连接
  for (const id of want) {
    const inSession = current?.targets.get(id);
    if (inSession) {
      handles.push({
        id, client: inSession.client, targetId: inSession.targetId, sessionId: inSession.sessionId,
        role: roleOf(id), source: 'session', attachedByUs: false,
      });
      continue;
    }
    const inst = getInstance(id);
    if (!inst || !inst.client) { skipped.push({ profile_id: id, reason: '没有在运行' }); continue; }
    let page = null;
    try { page = await pickPageTarget(inst.client); } catch (e) { skipped.push({ profile_id: id, reason: `读不到页面：${e?.message || e}` }); continue; }
    if (!page) { skipped.push({ profile_id: id, reason: '没有页面 target' }); continue; }
    handles.push({
      id, client: inst.client, targetId: page.targetId, sessionId: null,
      role: roleOf(id), source: 'instance', attachedByUs: false,
    });
  }
  if (!handles.length) {
    const why = skipped.map((x) => `${x.profile_id}（${x.reason}）`).join('、');
    const err = new Error(`没有可${what}的窗口：勾选的环境都没在运行（${why || '没给 id'}）。先勾选正在运行的环境`);
    err.reason = 'no_windows';
    throw err;
  }
  return { handles, skipped, source: 'ids' };
}

/**
 * 拿一张页面的 CDP 会话（只在真需要 Page 域命令时才 attach）。
 * 窗口位置/尺寸走浏览器级命令，不需要它 —— 这也是「排列不解绑也要能用」的关键：
 * 排列一次 attach 都不产生，所以不会和同步会话抢会话、也不会留半条连接。
 */
async function pageSessionOf(h) {
  if (h.sessionId) return h.sessionId;
  h.sessionId = await attach(h.client, h.targetId);
  h.attachedByUs = true;
  return h.sessionId;
}

/** 收尾：我们自己 attach 的会话要摘掉，别留给下一次（复用实例的连接是共用的） */
async function releaseHandles(handles) {
  for (const h of handles) {
    if (!h.attachedByUs || !h.sessionId) continue;
    try { await h.client.send('Target.detachFromTarget', { sessionId: h.sessionId }); } catch { /* 连接已断就算了 */ }
    h.attachedByUs = false;
    h.sessionId = null;
  }
}

/* ------------------------------ 启动 / 停止 ------------------------------ */

/**
 * 开始同步。
 * @param {{masterId: string, slaveIds: string[], settings?: object, rngSeed?: number}} opt
 */
export async function startSync({ masterId, slaveIds = [], settings = {}, rngSeed = null } = {}) {
  if (current) throw new Error('已经有一个同步会话在跑，先停止它');

  const master = String(masterId || '');
  if (!master) throw new Error('master_id is required');
  if (!getRunning(master)) throw new Error(`主窗口环境 ${master} 没有在运行`);

  const slaves = [...new Set(slaveIds.map(String))].filter((id) => id && id !== master);
  if (!slaves.length) throw new Error('至少要选一个受控窗口（除主窗口外的运行中环境）');
  for (const id of slaves) {
    if (!getRunning(id)) throw new Error(`受控窗口环境 ${id} 没有在运行`);
  }

  const st = normalizeSettings(settings);
  /* 名字形状不带 `fp`、不带 `__` 前缀：固定的签名前缀本身就是检测面（见 ./binding.js） */
  const bindingName = newBindingName();
  /* 存活探针：Symbol 键、不可枚举、每会话一个新 Symbol（见文件头 PROBE_* 的说明）。
   * 不用字符串名 —— 那是个持久检测面，P0 判据会直接红。 */
  const seed = rngSeed === null || rngSeed === undefined ? crypto.randomInt(1, 2 ** 31) : Number(rngSeed);
  const scheduler = new SyncScheduler({ delayMs: st.delay_ms, jitterMs: st.jitter_ms, rng: makeRng(seed) });
  /* 文本的随机源单独一条流：随机数字、逐字间隔都从这里取。
   * 与会话种子绑在一起 → 同一个 rngSeed 重放同一串数字，问题可复现（判据也靠这个）。 */
  const textRng = makeRng((Number(seed) >>> 0) ^ 0x5f356495);

  const targets = new Map();   // profileId -> { client, sessionId, targetId, viewport, window }
  const resolvers = new Map();  // profileId -> 文本解析器（每窗口一个：随机数字各抽各的、连击状态独立）
  const degraded = new Map();  // profileId -> reason
  /* 会话起点（毫秒）：`status.stale_ms` 的基准。
   * 必须在 session 字面量**之前**取 —— 放后面就是 TDZ（0.4.7.8 那类事故，判据当场抓到了）。 */
  const startedMs = Date.now();
  /* 0.4.7.11 运行中跟随用到的三张表（都要在 session 字面量**之前**声明，否则 TDZ）：
   *   followers   profileId → PageFollower（主窗口 + 每个受控窗口各一个）
   *   targetEvents targetId → 这张页贡献了多少条事件
   *   gateReasons 闸门拦下的原因分布（排障用） */
  const followers = new Map();
  const targetEvents = new Map();
  const gateReasons = {};
  /** R2：受控窗口「当前激活 target」的缓存上限。超过就重新解析（规格给的 500ms） */
  const DELIVERY_MAX_AGE_MS = 500;
  /** R6：多久没有捕获到**新**事件就重装一次捕获（规格 60s） */
  const CAPTURE_REINSTALL_MS = 60000;

  /* 0.4.7.11 第二轮：受控窗口「当前激活标签」改成**事件驱动**上报。
   *
   * 为什么不能用轮询：R7 的 `Emulation.setFocusEmulationEnabled(true)` 会把后台页的
   * `visibilityState` 也改成 `visible`（真内核实测，见 `buildActivationScript` 的注释），
   * 一旦给新开的标签也补开焦点模拟，两张页同时报 visible，轮询只能退回列表顺序第一张 ——
   * 用户切到 B2、输入一直打在 B1。这是 2026-11-21 现场的真实原因。
   *
   * 上报用的 binding 名与捕获用的**分开**：捕获那个只在主窗口，这个只在受控窗口，
   * 各自抓完引用立刻 delete，页面 own names 里都不留名字。 */
  const actBindingName = newBindingName();
  const actSource = buildActivationScript({ bindingName: actBindingName });
  /** profileId → Map<sessionId, targetId>（上报回来时靠它反查是哪张页） */
  const slaveSessions = new Map();
  /** profileId → Set<sessionId>：本文档已经装过上报（防重复 addBinding 把名字重新暴露出来） */
  const activationReady = new Map();
  /** profileId → Set<sessionId>：已经注册过「新文档脚本」（每次导航只注册一次） */
  const activationScripted = new Map();
  /** profileId → CDP 客户端（上报、补装、摘绑定都要用） */
  const slaveClients = new Map();

  const session = {
    id: crypto.randomUUID(),
    master,
    slaves,
    settings: st,
    binding_name: bindingName,
    probe_kind: 'symbol',
    rng_seed: seed,
    started_at: new Date().toISOString(),
    events: 0,
    /** 真的排进过至少一个受控窗口的事件数（与被开关拦下的 `dropped` 分开记） */
    forwarded: 0,
    dropped: 0,
    /** 0.4.7.11：R2 解析不到受控目标而跳过的事件数（不许静默） */
    skipped_no_target: 0,
    /** R3：坐标落在受控视口外被丢弃的事件数（正常现象，但要能看见） */
    dropped_out_of_view: 0,
    /** R6：看门狗自动重装捕获的次数 */
    capture_reinstalled: 0,
    /** 兼容字段：0.4.7.11 按 R1 删掉了可见性闸门，恒为 0（老界面/判据还在读它） */
    gated: 0,
    text_sent: 0,
    text_swallowed: 0,
    /** 最后一条捕获到的事件（status 用它算 `stale_ms`，界面据此给人话提示） */
    last_event_at: null,
    last_event_at_ms: 0,
    /** 最后一次「事件数增长」的时刻：R6 看门狗按它判断「60s 没涨」 */
    last_growth_ms: startedMs,
    /** R5：`alive` 必须是**读页面里的探针**得到的，不是看进程在不在 */
    alive: false,
    alive_checked_ms: 0,
    last_capture_target_url: null,
    started_ms: startedMs,
    scheduler,
    targets,
    degraded,
    followers,
    targetEvents,
    gate_reasons: gateReasons,
    stopped: false,
  };

  let masterClient = null;
  /* 0.4.7.11 运行中跟随：主窗口**所有**标签都装捕获（不只可见那张），
   * 转发时用「当前可见」当闸门 —— 用户切标签、关标签、开新标签都不用重开同步。
   * （`followers` / `targetEvents` / `gateReasons` 三张表在上面，session 字面量要用。） */
  const masterPages = new Map();            // targetId -> 我们装过捕获的 sessionId
  const masterSessionToTarget = new Map();  // sessionId -> targetId
  /* 给 status 读的引用（`statusOf` 在模块级，拿不到 startSync 的闭包变量） */
  session.capture_pages = masterPages;
  const captureSource = buildCaptureScript({ bindingName, probe: true });

  const bumpTarget = (targetId) => {
    if (!targetId) return;
    targetEvents.set(targetId, (targetEvents.get(targetId) || 0) + 1);
  };

  /**
   * R7：受控窗口的 target attach 之后开「焦点模拟」。
   * 不开的话 `document.hasFocus()` 是 false —— 很多站点（下拉菜单、快捷键、滚动容器）
   * 靠它决定要不要响应，于是输入发出去了、页面纹丝不动。
   *
   * **只对「当前投递目标」开，不许对所有受控页开**（0.4.7.11 第二轮修的正是这个）：
   * 真内核实测（`.tmp/e2e/vis2.cjs`）——
   *   后台页 未开焦点模拟: {"vis":"hidden","focus":false}
   *   后台页 开了焦点模拟: {"vis":"visible","focus":true}
   * 也就是说它会把 `visibilityState` 一起覆盖。开在所有页上，窗口里每一张都报 visible，
   * 「当前激活标签」就再也分不出来，只能一直投给列表里的第一张（用户看到的就是「切了标签没反应」）。
   */
  async function focusEmulate(t) {
    if (!t?.client || !t.sessionId) return false;
    try {
      await t.client.send('Emulation.setFocusEmulationEnabled', { enabled: true }, t.sessionId);
      return true;
    } catch { return false; }
  }

  /**
   * 关掉某张页的焦点模拟（投递目标换走时对**旧那张**调）。
   *
   * 为什么必须关：不关的话旧页继续谎报 `visible`，下一轮轮询会把目标又选回它，
   * 出现「切了标签，过一秒又跳回去」的抖动。
   */
  async function unfocusEmulate(client, sessionId) {
    if (!client || !sessionId) return false;
    try {
      await client.send('Emulation.setFocusEmulationEnabled', { enabled: false }, sessionId);
      return true;
    } catch { return false; }
  }

  /**
   * 给受控窗口的一张页装上「当前激活标签」上报（幂等）。
   *
   * 顺序有讲究：`Runtime.addBinding` 必须在脚本跑之前（脚本抓完引用立刻 delete）；
   * 同一个文档**只装一次** —— 重复 addBinding 会把名字重新挂回 window，
   * 而脚本已经跑过了，没人再去 delete，名字就永久留在 own names 里（检测面）。
   */
  async function instrumentSlavePage(id, targetId, sessionId, { force = false } = {}) {
    const client = slaveClients.get(id);
    if (!client || !targetId || !sessionId) return false;
    let sessions = slaveSessions.get(id);
    if (!sessions) { sessions = new Map(); slaveSessions.set(id, sessions); }
    sessions.set(sessionId, targetId);
    let ready = activationReady.get(id);
    if (!ready) { ready = new Set(); activationReady.set(id, ready); }
    if (ready.has(sessionId) && !force) return false;
    ready.add(sessionId);
    await client.send('Runtime.enable', {}, sessionId).catch(() => {});
    await client.send('Runtime.addBinding', { name: actBindingName }, sessionId).catch(() => {});
    let scripted = activationScripted.get(id);
    if (!scripted) { scripted = new Set(); activationScripted.set(id, scripted); }
    if (!scripted.has(sessionId)) {
      scripted.add(sessionId);
      await client.send('Page.addScriptToEvaluateOnNewDocument', { source: actSource }, sessionId).catch(() => {});
    }
    await client.send('Runtime.evaluate', { expression: actSource }, sessionId).catch(() => {});
    return true;
  }

  /**
   * 页面自己上报「我变成可见了」→ 改成这个窗口的当前投递目标。
   *
   * 只认 `visible`。切走时不动作：新那张会立刻报 visible，谁最后变可见谁就是激活标签。
   * 这样不会出现「旧的先报 hidden 把目标清空、新的还没报上来」的空窗。
   */
  function onActivationReport(id, params, sid) {
    if (!params || params.name !== actBindingName) return;
    const targetId = slaveSessions.get(id)?.get(sid);
    if (!targetId) return;
    let p = null;
    try { p = JSON.parse(params.payload); } catch { return; }
    if (p?.v !== 'visible') return;
    const f = followers.get(id);
    if (!f) return;
    f.setActiveTarget(targetId, typeof p.h === 'string' && p.h ? p.h : null);
  }

  /**
   * R5：读主窗口**当前投递那张页**里的探针，判断「捕获脚本真的在这个文档里」。
   *
   * 为什么不能看进程/连接：进程在、CDP 通、`running=true`，但脚本可能根本没装在这张页上
   * （0.4.7.10 现场就是这样，events 停在 21，谁都看不出脚本不在了）。
   * 探针名是每会话随机派生的，读得到 = 脚本在这个文档里跑过。
   */
  async function readProbe() {
    const f = followers.get(master);
    let dt = null;
    try { dt = await f?.deliveryTarget({ maxAgeMs: 1000 }); } catch { dt = null; }
    if (!dt) {
      session.alive = false;
      session.alive_checked_ms = Date.now();
      return false;
    }
    try {
      const r = await masterClient.send('Runtime.evaluate', {
        expression: PROBE_READ_EXPR,
        returnByValue: true,
      }, dt.sessionId);
      let parsed = null;
      try { parsed = JSON.parse(r?.result?.value || 'null'); } catch { parsed = null; }
      session.alive = parsed?.a === true;
      if (typeof parsed?.h === 'string' && parsed.h) session.last_capture_target_url = parsed.h;
      else session.last_capture_target_url = dt.url || null;
    } catch {
      session.alive = false;
    }
    session.alive_checked_ms = Date.now();
    return session.alive;
  }

  /**
   * R6 看门狗：`running` 但 events 连续 60s 没增长 → 重装一次捕获。
   *
   * 为什么需要：`Page.addScriptToEvaluateOnNewDocument` 在某些路径上会失效
   * （页面被 discard 后恢复、渲染进程换掉、我们注入时页面还没就绪）。
   * 这时会话看着完全正常，但一条事件都进不来。重装是幂等的（脚本自己会先摘旧监听）。
   *
   * 注意：重装**不能**当成「修好了」。它只是兜底，`capture_reinstalled` 涨了就说明
   * 前面有东西在丢，排障时要从这个数字看起。
   */
  async function reinstallCapture(reason = 'stale') {
    let n = 0;
    for (const [targetId, sid] of [...masterPages]) {
      try {
        await instrumentMasterPage(targetId, sid);
        n += 1;
      } catch { /* 这一页装不上就跳过，下一轮再说 */ }
    }
    if (n) {
      session.capture_reinstalled += 1;
      logProfile(master, 'WARN 同步捕获重装',
        `会话=${session.id.slice(0, 8)} 原因=${reason} 重装=${n} 张标签 `
        + `累计重装=${session.capture_reinstalled} 事件=${session.events}`);
    }
    session.last_growth_ms = Date.now();
    return n;
  }

  async function watchdogTick() {
    if (session.stopped) return;
    await readProbe();
    if (session.stopped) return;
    const idle = Date.now() - (session.last_growth_ms || session.started_ms);
    if (idle >= CAPTURE_REINSTALL_MS) await reinstallCapture('no_events_60s');
  }

  /** 主窗口一张标签装捕获：binding + 新文档脚本 + 当前文档立刻跑一遍 */
  async function instrumentMasterPage(targetId, sessionId) {
    if (!targetId || !sessionId) return;
    await masterClient.send('Page.enable', {}, sessionId).catch(() => {});
    await masterClient.send('Runtime.enable', {}, sessionId).catch(() => {});
    await masterClient.send('Runtime.addBinding', { name: bindingName }, sessionId);
    // 新文档：脚本自己轮询等 binding；主进程在 frameNavigated 时补装
    await masterClient.send('Page.addScriptToEvaluateOnNewDocument', { source: captureSource }, sessionId);
    // 当前文档：直接跑一遍（新文档脚本只对「下一个文档」生效）
    await masterClient.send('Runtime.evaluate', { expression: captureSource }, sessionId).catch(() => {});
    masterPages.set(targetId, sessionId);
    masterSessionToTarget.set(sessionId, targetId);
  }

  /** 可见标签变了（主窗口）：改状态里的映射、重读视口、落一行日志 */
  async function onMasterChosen(next, prev) {
    const mt = targets.get(master);
    if (!mt || !next) return;
    const f = followers.get(master);
    const sid = f?.pages.get(next.targetId)?.sessionId || null;
    if (!sid) return;
    const before = mt.targetUrl;
    mt.targetId = next.targetId;
    mt.sessionId = sid;
    mt.targetUrl = next.url;
    mt.visible = next.visible;
    mt.confident = next.confident;
    mt.source = next.source;
    await refreshViewport(master).catch(() => {});
    if (prev || before) {
      logProfile(master, '同步目标跟随',
        `会话=${session.id.slice(0, 8)} 主窗口可见标签 ${String(before || '?').slice(0, 90)} → `
        + `${String(next.url || '?').slice(0, 90)} target=${next.targetId} 来源=${next.source}`);
    }
  }

  /** 可见标签变了（受控窗口）：改投递目标 + 重读视口 —— 否则输入还打在已经看不见的那张页上 */
  async function onSlaveChosen(id, next) {
    const t = targets.get(id);
    if (!t) return;
    if (!next) { degraded.set(id, '窗口里已经没有页面了（标签全关）'); return; }
    const f = followers.get(id);
    const sid = f?.pages.get(next.targetId)?.sessionId || null;
    if (!sid) { degraded.set(id, '新标签还没连上，稍后重试'); return; }
    const before = t.targetUrl;
    const prevSid = t.sessionId;
    t.targetId = next.targetId;
    t.sessionId = sid;
    t.targetUrl = next.url;
    t.visible = next.visible;
    t.confident = next.confident;
    t.source = next.source;
    t.signal = next.signal || null;
    /* 视口优先用页面自己报的 `innerWidth/innerHeight`（R3 的口径），读不到才退回 layoutMetrics。
     * 两个都读不到就是 null —— 事件路径会因此丢弃鼠标事件，不会在 (0,0) 乱点。 */
    const pg = f?.pages.get(next.targetId);
    t.viewport = pg?.vw && pg?.vh ? { vw: pg.vw, vh: pg.vh } : await viewportOf(t.client, sid);
    // R7：焦点模拟**跟着投递目标走** —— 先给新页开，再关掉旧页（反了会有一瞬间两张都报 visible）
    await focusEmulate(t);
    if (prevSid && prevSid !== sid) await unfocusEmulate(t.client, prevSid);
    if (degraded.has(id)) degraded.delete(id);
    logProfile(id, '同步目标跟随',
      `会话=${session.id.slice(0, 8)} 受控窗口可见标签 ${String(before || '?').slice(0, 90)} → `
      + `${String(next.url || '?').slice(0, 90)} target=${next.targetId} 依据=${next.signal || 'poll'} `
      + `视口=${t.viewport ? `${t.viewport.vw}x${t.viewport.vh}` : '读不到'}`);
  }

  /**
   * 结束会话的唯一收口（用户停 / 主窗口没页面 / 连接断了都走这里）。
   *
   * 为什么要收口：0.4.7.10 之前「目标没了」这条路上没有任何一行日志、`running` 还是 true，
   * 用户和我们都看不出「会话其实已经废了」。现在无论怎么结束，都写清楚 `reason` + 人话 `message`。
   */
  async function finishSession({ reason, message, abnormal = false, removeBinding = true } = {}) {
    if (session.stopped) return { running: false, teardown: lastTeardown };
    session.stopped = true;
    session.end_reason = reason;
    session.end_message = message;
    scheduler.stop();
    if (session.watchdog) { clearInterval(session.watchdog); session.watchdog = null; }

    /* 顺序不能反：**先摘 binding，再停跟随器**。
     * `PageFollower.stop()` 会把我们自己 attach 的会话 detach 掉，
     * 之后再发 `Runtime.removeBinding` 就是「Session with given id not found」——
     * 0.4.7.11 第一轮 smoke 就是这么红的（teardown.removed=false）。 */
    const teardown = {
      binding_name: bindingName,
      at: new Date().toISOString(),
      removed: false,
      error: null,
      reason,
    };
    if (removeBinding) {
      let ok = 0;
      let tried = 0;
      for (const [targetId, sid] of masterPages) {
        tried += 1;
        try {
          await masterClient.send('Runtime.removeBinding', { name: bindingName }, sid);
          ok += 1;
        } catch (e) {
          teardown.error = teardown.error || (e?.message || String(e));
        }
        masterPages.delete(targetId);
      }
      teardown.removed = tried > 0 && ok === tried;
      if (!tried && !teardown.error) teardown.error = '主窗口没有装过捕获的标签（无可摘）';
    } else {
      teardown.error = message || '连接已断开，removeBinding 发不出去';
    }
    /* 页面里那个探针也要摘掉（`off()` + delete）：它是「脚本在这个页上」的唯一证据，别留。
     * 探针是 Symbol 键的，按形状枚举找到再摘 —— 不需要名字。 */
    if (removeBinding) {
      for (const [, t] of targets) {
        try {
          await t.client.send('Runtime.evaluate', { expression: PROBE_OFF_EXPR }, t.sessionId);
        } catch { /* 会话已经没了就算了 */ }
      }
    }

    for (const f of followers.values()) { try { f.stop(); } catch { /* ignore */ } }
    lastTeardown = teardown;
    lastEnd = {
      reason, message: message || null, at: teardown.at, session_id: session.id,
      events: session.events, forwarded: session.forwarded,
    };

    logProfile(master, abnormal ? '同步异常结束' : '同步结束',
      `会话=${session.id.slice(0, 8)} 事件=${session.events} 转发=${session.forwarded} `
      + `开关拦下=${session.dropped} 闸门拦下=${session.gated || 0} `
      + `文本发出=${session.text_sent} 文本被吞=${session.text_swallowed} `
      + `原因=${reason}${message ? `（${message}）` : ''} `
      + `teardown=${teardown.removed ? 'binding 已摘' : `binding 未摘（${teardown.error || '未知原因'}）`}`);

    for (const [, t] of targets) {
      try { t.client.close(); } catch { /* ignore */ }
    }
    targets.clear();
    if (current === session) current = null;
    return { running: false, teardown };
  }

  try {
    /* 主窗口：连上 → 先摸清「窗口里有哪些 page、谁是可见的」→ 前置检查 → 全部装捕获 */
    const m = await connectInstance(master);
    masterClient = m.client;
    const masterMarkers = m.inst.markers || markerNames(undefined);

    /* 第一轮只「看」不「装」：前置检查必须在装 binding 之前
     * （0.4.7.4 判据钉的就是「拒绝时页面上不留痕迹」）。 */
    const masterFollower = new PageFollower({
      client: m.client,
      label: master,
      intervalMs: FOLLOW_INTERVAL_MS,
      injectedExpression: installedExpression(masterMarkers),
    });
    followers.set(master, masterFollower);
    await masterFollower.refreshOnce();

    const mTarget = masterFollower.chosen;
    if (!mTarget) throw new Error('主窗口没有页面 target（可能没有开任何标签）');
    const mSession = masterFollower.pages.get(mTarget.targetId)?.sessionId || null;
    if (!mSession) throw new Error('主窗口那张标签连不上（可能正在关闭）');

    /* 前置检查：主窗口现在有没有「可同步的页面」（见 unusableMasterPage 的注释）。
     *
     * 地址取**页面自己报的 `location.href`**，不拿 `Target.getTargets` 里的 url：
     * 错误页那里报的是「当初想去的地址」（`http://127.0.0.1:1/nope`），
     * 页面实际停在 `chrome-error://chromewebdata/` —— 按 targetInfo.url 判会漏掉整类错误页
     * （0.4.7.4 判据第一次跑就是这么假绿的）。 */
    const masterProbe = await m.client.send('Runtime.evaluate', {
      expression: 'JSON.stringify({href: location.href, injected: ' + installedExpression(masterMarkers) + '})',
      returnByValue: true,
    }, mSession).then((r) => {
      try { return JSON.parse(r?.result?.value || 'null'); } catch { return null; }
    }).catch(() => null);
    const masterHref = String(masterProbe?.href || mTarget.url || '');
    const notSyncable = masterBlockReason({
      href: masterHref, injected: masterProbe?.injected === true, visibleUrl: mTarget.visible_url,
    });
    if (notSyncable) {
      logProfile(master, 'WARN 同步未开始', `主窗口不可同步：${notSyncable}（href=${masterHref.slice(0, 120)}）`);
      const err = new Error(`主窗口现在没有可同步的页面（${notSyncable}），先把页面打开再开始同步`);
      err.reason = 'master_not_syncable';
      err.master_url = masterHref;
      throw err;
    }

    targets.set(master, {
      client: m.client, sessionId: mSession, targetId: mTarget.targetId, viewport: null,
      window: await windowSizeOf(m.client, mTarget.targetId),
      // 可观测性：连的是哪张页、它可见不可见、是不是猜的 —— 见 statusOf()
      targetUrl: mTarget.url, visible: mTarget.visible, confident: mTarget.confident, source: mTarget.source,
      follower: masterFollower,
    });

    /* 主窗口**所有**标签都装捕获：用户随时可能切到另一张标签继续操作，
     * 只装当前这张的话，一切走就再也抓不到事件了（这正是这次要修的东西）。 */
    for (const p of masterFollower.pages.values()) {
      try { await instrumentMasterPage(p.targetId, p.sessionId); } catch { /* 这一页装不上，下一轮导航会补 */ }
    }
    masterFollower.onPageAdded = (targetId, sessionId) => instrumentMasterPage(targetId, sessionId);
    masterFollower.onPageRemoved = (targetId) => {
      masterPages.delete(targetId);
      for (const [sid, tid] of masterSessionToTarget) if (tid === targetId) masterSessionToTarget.delete(sid);
    };
    masterFollower.onChosen = (next, prev) => onMasterChosen(next, prev);
    masterFollower.onEmpty = () => {
      /* 主窗口一张 page 都不剩：会话**必须**明确结束，不许继续假装 running。
       * 用户关了主窗口所有标签之后，同步已经不可能有输入了。 */
      finishSession({
        reason: 'master_target_gone',
        message: '主窗口的标签全部关闭了，同步已自动结束（重新打开页面后请重新开始同步）',
      }).catch(() => {});
    };
    masterFollower.start();

    /* 会话开始就落一行实例日志（0.4.7.4）：用户说「没反应」时，
     * 第一件事是分清「主窗口是不是根本没页面」和「有页面但事件没转发」。
     * 这一行把主/受控 id、主窗口 url、装了几张标签、捕获脚本装没装一次说清。 */
    logProfile(master, '同步开始',
      `会话=${session.id.slice(0, 8)} 主=${master} 受控=${slaves.join(',') || '-'} `
      + `主窗口=${String(mTarget.url || '').slice(0, 120)} 可见=${mTarget.visible} 来源=${mTarget.source} `
      + `装捕获=${masterPages.size}/${masterFollower.pages.size} 张标签 捕获脚本=已装 binding=${bindingName}`);

    m.client.on('Page.frameNavigated', (params, sid) => {
      const targetId = masterSessionToTarget.get(sid);
      if (!targetId) return;
      // 只认主帧：子帧导航不该重装 binding（子帧拿不到也无所谓，见 README 的 iframe 边界）
      if (params?.frame?.parentId) return;
      // binding 不跨文档存活（实测）：新文档要补装一次，脚本的轮询会把它抓走并 delete
      m.client.send('Runtime.addBinding', { name: bindingName }, sid).catch(() => {});
      if (targets.get(master)?.targetId === targetId) refreshViewport(master).catch(() => {});
    });

    /* 受控窗口：连上、摸清标签、按可见选一张去投递 */
    for (const id of slaves) {
      const s = await connectInstance(id);
      slaveClients.set(id, s.client);
      const f = new PageFollower({ client: s.client, label: id, intervalMs: FOLLOW_INTERVAL_MS });
      followers.set(id, f);
      await f.refreshOnce().catch(() => null);
      const t = f.chosen;
      if (!t) { degraded.set(id, '没有页面 target'); f.stop(); s.client.close(); followers.delete(id); continue; }
      const sid = f.pages.get(t.targetId)?.sessionId || null;
      const viewport = await viewportOf(s.client, sid);
      const entry = {
        client: s.client, sessionId: sid, targetId: t.targetId, viewport,
        window: await windowSizeOf(s.client, t.targetId),
        targetUrl: t.url, visible: t.visible, confident: t.confident, source: t.source,
        signal: t.signal || null, follower: f,
        /* R2/R3 的逐窗口读数（status.windows[] 直接暴露，用户/排障一眼看出卡在哪） */
        delivery_ok: null, delivery_target_url: null, skipped_no_target: 0, dropped_out_of_view: 0,
      };
      targets.set(id, entry);
      /* 回调先挂好再装上报：上报脚本一跑就会立刻推一条 `visible`，
       * 那时 `onChosen` 必须已经能接住（否则 chosen 变了、投递目标还是旧的）。 */
      f.onChosen = (next) => onSlaveChosen(id, next);
      f.onEmpty = () => { degraded.set(id, '窗口里已经没有页面了（标签全关）'); };
      /* 事件驱动上报：每张受控页都装（只装当前那张的话，用户切到别的标签就再也收不到
       * 「我变成可见了」，只能等轮询 —— 而轮询在焦点模拟下是瞎的）。 */
      f.onPageAdded = (targetId, sessionId) => instrumentSlavePage(id, targetId, sessionId);
      for (const p of f.pages.values()) {
        try { await instrumentSlavePage(id, p.targetId, p.sessionId); } catch { /* 下一轮补 */ }
      }
      /* 新文档要重新 addBinding（binding 不跨文档存活）+ 重装上报脚本 */
      s.client.on('Page.frameNavigated', (params, navSid) => {
        if (params?.frame?.parentId) return;
        const targetId = slaveSessions.get(id)?.get(navSid);
        if (!targetId) return;
        activationReady.get(id)?.delete(navSid);
        instrumentSlavePage(id, targetId, navSid, { force: true }).catch(() => {});
      });
      s.client.on('Runtime.bindingCalled', (params, evSid) => onActivationReport(id, params, evSid));
      // R7：attach 之后立刻开焦点模拟（只对**当前投递目标**这一张，见 focusEmulate 的注释）
      await focusEmulate(entry);
      // 环境被外部关掉：连接断了就标降级，不静默继续
      s.client.socket?.on?.('close', () => { degraded.set(id, 'CDP 连接已断开'); });
      f.start();
    }

    /* 主窗口事件 → 受控窗口。
     *
     * 0.4.7.11 按规格 R1 去掉了「只转发当前可见页」的闸门：捕获脚本装在主窗口**所有** page
     * target 上，真实用户输入本来就只会落在前台那张页上，全装天然等价于「跟随激活标签」。
     * 再加可见性闸门只会多一个失败模式（可见性读不到 → 全丢），而那正是「点了没反应」。 */
    m.client.on('Runtime.bindingCalled', async (params, sid) => {
      if (params?.name !== bindingName) return;
      const targetId = masterSessionToTarget.get(sid);
      if (!targetId) return; // 不是我们装过捕获的页（比如别的客户端 attach 的）
      let payload = null;
      try { payload = JSON.parse(params.payload); } catch { return; }
      const list = Array.isArray(payload?.e) ? payload.e : [];
      for (const ev of list) {
        session.events += 1;
        session.last_event_at = new Date().toISOString();
        session.last_event_at_ms = Date.now();
        session.last_growth_ms = session.last_event_at_ms;
        bumpTarget(targetId);
        // 开关必须读**会话当前的** settings：闭包里那个 `st` 是启动时的快照，
        // 用户运行中关掉「输入」时它会一直是旧值（B 层判据抓到的真 bug）。
        if (!enabledBySwitch(ev, session.settings)) { session.dropped += 1; continue; }
        const isText = ev?.t === 'key' || ev?.t === 'text' || ev?.t === 'paste';
        /** 这一条事件里有没有文字真的落到受控窗口 */
        let textEmitted = false;
        /** 这一条事件有没有真的排进**至少一个**受控窗口（stop 那行日志要这个读数） */
        let delivered = false;
        for (const id of session.slaves) {
          const t = targets.get(id);
          if (!t || !t.follower) continue;

          /* R2：**每条事件派发前**解析受控窗口当前激活的 target（≤500ms 缓存）。
           * 绑死启动时那张 = 0.4.7.10 的失败原因：用户切了标签，输入还打在看不见的旧页上。 */
          let dt = null;
          try { dt = await t.follower.deliveryTarget({ maxAgeMs: DELIVERY_MAX_AGE_MS }); } catch { dt = null; }
          if (!dt) {
            t.skipped_no_target = (t.skipped_no_target || 0) + 1;
            session.skipped_no_target += 1;
            degraded.set(id, '窗口里没有可投递的页面（标签全关或正在切换）');
            continue;
          }
          if (dt.targetId !== t.targetId || dt.sessionId !== t.sessionId) {
            const before = t.targetUrl;
            const prevSid = t.sessionId;
            t.targetId = dt.targetId;
            t.sessionId = dt.sessionId;
            t.targetUrl = dt.url;
            t.visible = dt.visible;
            t.confident = dt.confident;
            t.source = dt.source;
            t.signal = dt.signal || null;
            t.viewport = dt.vw && dt.vh ? { vw: dt.vw, vh: dt.vh } : await viewportOf(t.client, dt.sessionId);
            /* R7：焦点模拟跟着投递目标走 —— 先给新页开、再关旧页。
             * 开在所有页上会把 visibilityState 一起覆盖掉（实测），那时「当前激活标签」
             * 就分不出来，只能一直投列表第一张（用户切了标签却没反应）。 */
            await focusEmulate(t);
            if (prevSid && prevSid !== dt.sessionId) await unfocusEmulate(t.client, prevSid);
            logProfile(id, '同步目标跟随',
              `会话=${session.id.slice(0, 8)} 受控窗口投递目标 ${String(before || '?').slice(0, 90)} → `
              + `${String(dt.url || '?').slice(0, 90)} target=${dt.targetId} 依据=${dt.signal || 'poll'} `
              + `视口=${t.viewport ? `${t.viewport.vw}x${t.viewport.vh}` : '读不到'}`);
          } else if (dt.vw && dt.vh) {
            // 视口每轮跟着刷新：用户改了窗口大小，1:1 坐标的越界判据要跟着变（R3）
            t.viewport = { vw: dt.vw, vh: dt.vh };
          }
          if (degraded.get(id) === '窗口里没有可投递的页面（标签全关或正在切换）') degraded.delete(id);

          if (!isText) {
            /* R3：坐标 1:1，越界**丢弃**（依据 34 号文 §5.2：主控 900/900 时受控 0 条）。
             * 分开记 `out_of_view` 和 `no_viewport`：前者是正常现象，后者是异常。 */
            const pt = mapPointStatus(ev, t.viewport);
            if (!pt.ok) {
              if (pt.reason === 'out_of_view') {
                t.dropped_out_of_view = (t.dropped_out_of_view || 0) + 1;
                session.dropped_out_of_view += 1;
              } else if (pt.reason === 'no_viewport') {
                t.no_viewport = (t.no_viewport || 0) + 1;
                degraded.set(id, '读不到受控页视口（窗口最小化或页面正在加载）');
              }
              continue;
            }
          }

          /* 每个受控窗口单独算一次计划：随机数字要「每窗口各自一个值」，
           * 逐字间隔也要每个窗口各自随机（否则 N 个窗口节奏完全一致，反而像机器人）。 */
          if (isText && !resolvers.has(id)) resolvers.set(id, makeTextResolver({ rng: textRng }));
          const plan = buildSyncPlan(ev, t.viewport, session.settings, resolvers.get(id), textRng);
          if (!plan.length) continue;
          /* 「这条事件里有没有文字真的落到受控窗口」：insertText，或者带 text 的 keyDown
           * （打字走后者 —— keyDown 自己就把字符打进去了，不用再 insertText）。 */
          if (plan.some((c) => c.method === 'Input.insertText'
            || (c.params && typeof c.params.text === 'string' && c.params.text))) textEmitted = true;
          scheduler.push(id, async () => {
            for (const call of plan) {
              // waitMs 是「发这一条之前等多久」：逐字投递的字符间隔在这里落地
              if (call.waitMs) await sleep(call.waitMs);
              // 读 t.sessionId（不是快照）：排队期间用户可能又切了标签，要投到新页上
              await t.client.send(call.method, call.params, t.sessionId);
            }
          });
          t.delivery_ok = true;
          t.delivery_target_url = dt.url || t.targetUrl || null;
          bumpTarget(t.targetId);
          delivered = true;
        }
        if (delivered) session.forwarded += 1;
        /* 读数：带文字的事件里，**真的发出去了**多少条、被**内容策略**吞掉多少条。
         * 与被开关拦下的 dropped 分开记 —— 「相同文本关掉」和「按键被丢掉」是两回事，
         * 合成一个数字会让用户（和判据）分不清是开关没生效还是文本策略生效。
         * 不带文字的按键（退格、方向键）不算在内：它们本来就该照发。 */
        if (isText && textOf(ev)) {
          if (textEmitted) session.text_sent += 1; else session.text_swallowed += 1;
        }
      }
    });
  } catch (e) {
    // 起不来就把已经连上的都关掉，不留半条连接
    for (const [, t] of targets) { try { t.client.close(); } catch { /* ignore */ } }
    throw e;
  }

  /**
   * 异常结束（环境被杀 / 内核崩了 / 连接被拔）：连接已经没了，`removeBinding` 发不出去。
   * 这时**如实记录没摘干净**，不要假装干净 —— 那个 binding 名会活到该环境关掉为止
   * （名字是随机的，页面里也已 delete，实际暴露面极小，但读数必须是真话）。
   */
  masterClient?.socket?.on?.('close', () => {
    if (session.stopped) return;
    session.abnormal = '主窗口 CDP 连接已断开';
    finishSession({
      reason: 'connection_lost',
      message: session.abnormal,
      abnormal: true,
      removeBinding: false,
    }).catch(() => {});
  });

  async function refreshViewport(profileId) {
    const t = targets.get(profileId);
    if (!t) return null;
    t.viewport = await viewportOf(t.client, t.sessionId);
    return t.viewport;
  }

  session.refreshViewport = refreshViewport;
  /**
   * 用户主动停止。摘 binding 必须**先于**关连接，而且要记读数：
   * 页面侧抓完引用就 `delete window[name]` 了，所以「stop 之后页面里查不到这个名字」
   * 在摘不摘 removeBinding 时都成立 —— 光看页面看不出区别，只能看主进程这边摘没摘。
   * `removed:false` 就是「没摘」的铁证（判据钉这条）。
   *
   * 0.4.7.11：主窗口现在可能装了好几份 binding（每张标签一份），要**全部**摘掉，
   * 只摘可见那张等于在后台标签里留了一个还活着的入口。
   */
  session.stop = async () => finishSession({ reason: 'user_stop', message: null });
  /** R5 自检入口（`POST /api/v2/sync/selftest` 调它） */
  session.selftest = async () => selftestOf(session);

  /* R6 看门狗：2 秒一次，读探针（`alive`）+ 60s 没事件就重装捕获。
   * 2 秒是折中：更密会白烧 CPU，更稀则 `alive` 读数太旧、用户操作后界面要等很久才变。 */
  session.watchdog = setInterval(() => { watchdogTick().catch(() => {}); }, 2000);
  session.watchdog.unref?.();

  session.status = () => statusOf(session);
  current = session;
  return statusOf(session);
}

/**
 * R5：`POST /api/v2/sync/selftest` 的实现 —— 「脚本真的在这些页上吗」的自证。
 *
 * 为什么需要这个接口：用户报「没反应」时，`running=true` / `events>0` / `errors=0` 全都可能是假的
 * （0.4.7.9 的教训：scheduler sent=311 errors=0，用户看到的还是不动）。
 * 这个接口直接对每个窗口的每个 page target 读一次：
 *   - `visibilityState`：它是不是前台那张；
 *   - `capture_installed`：主控页上有没有我们的探针（**脚本真的在这个文档里跑过**）；
 *     受控窗口按设计零注入，这里是 `null`（不是 false，别让人误以为坏了）；
 *   - `is_delivery_target`：这张页是不是**现在**会被投递的那张。
 *
 * 只读，不改任何状态；会话没在跑就如实说 `running:false`。
 */
export async function selftestOf(session) {
  const at = new Date().toISOString();
  if (!session || session.stopped) {
    return { running: false, session_id: session?.id || null, at, windows: [], note: '没有正在运行的同步会话' };
  }
  const out = [];
  for (const [id, t] of session.targets) {
    const role = id === session.master ? 'master' : 'slave';
    const f = session.followers?.get?.(id) || null;
    const deliveryTargetId = role === 'master'
      ? (session.targets.get(session.master)?.targetId || null)
      : (t.targetId || null);
    const pages = f ? [...f.pages.values()] : [];
    if (!pages.length) {
      out.push({
        profile_id: id, role, target_id: t.targetId || null, target_url: t.targetUrl || null,
        visibility_state: null, capture_installed: role === 'master' ? false : null,
        is_delivery_target: false, alive: false, error: '窗口里没有 page target',
      });
      continue;
    }
    for (const p of pages) {
      const row = {
        profile_id: id,
        role,
        target_id: p.targetId,
        target_url: p.href || null,
        visibility_state: p.state || null,
        /* 主控：探针在不在（脚本真在这张文档里）；受控：null（零注入，不适用，不是「坏了」） */
        capture_installed: null,
        is_delivery_target: p.targetId === deliveryTargetId,
        alive: true,
        viewport: p.vw && p.vh ? { vw: p.vw, vh: p.vh } : null,
      };
      if (role === 'master' && p.sessionId) {
        try {
          const r = await t.client.send('Runtime.evaluate', {
            expression: PROBE_BOOL_EXPR, returnByValue: true,
          }, p.sessionId);
          row.capture_installed = r?.result?.value === true;
        } catch {
          row.capture_installed = false;
          row.error = '读探针失败（页面可能正在导航）';
        }
      }
      out.push(row);
    }
  }
  return {
    running: true,
    session_id: session.id,
    at,
    /* 探针是 Symbol 键、没有字符串名（名字本身就是检测面）。
     * 这里如实说明形状，不编一个名字出来。 */
    probe: 'symbol',
    events: session.events,
    forwarded: session.forwarded,
    skipped_no_target: session.skipped_no_target || 0,
    dropped_out_of_view: session.dropped_out_of_view || 0,
    windows: out,
  };
}

/** 会话 → 对外的 status 形状（导出是为了让判据能真求值测形状，不用扫源码） */
export function statusOf(session) {
  const windows = [];
  for (const [id, t] of session.targets) {
    const f = session.followers?.get?.(id) || null;
    const role = id === session.master ? 'master' : 'slave';
    const pageCount = f ? f.pages.size : null;
    /* 降级原因：优先用回调记下的那句（更具体，比如「CDP 连接已断开」）。
     * 但「受控窗口一张 page 都不剩」是**可推导的**，不能只靠回调 ——
     * 用户关掉受控窗口最后一张标签时，回调可能因为连接先断而没来得及跑，
     * 结果 status 里 degraded=null、界面一片正常。这里补一条派生判定。 */
    let deg = session.degraded.get(id) || null;
    if (role === 'slave' && pageCount === 0 && !deg) deg = '窗口里已经没有页面了（标签全关）';
    windows.push({
      profile_id: id,
      role: id === session.master ? 'master' : 'slave',
      target_id: t.targetId,
      /* 0.4.7.10：把「连的是哪张页、它可见不可见」直接放进 status。
       * 起因：用户报「操作主控受控窗口不动」，而 status 里只有 target_id 一串哈希，
       * 日志和界面都看不出「连错了后台标签」—— 这类 bug 必须自己暴露出来，不能靠人去映射。 */
      target_url: t.targetUrl || null,
      visible: t.visible === true ? true : t.visible === false ? false : null,
      /** 这个 target 是「实测可见」选出来的（true），还是兜底猜的（false） */
      confident: t.confident === true,
      target_source: t.source || null,
      /* 0.4.7.11：这个 target 现在**还在不在**（用户可能已经把它关了）。
       * 没有这一项时，status 里照样显示一个已经不存在的 target_id，谁都看不出「绑在死页上」。 */
      alive: f ? f.pages.has(t.targetId) : true,
      /** 这张页贡献了多少条事件（主控=捕获到的，受控=投递出去的） */
      events_from_this_target: session.targetEvents?.get?.(t.targetId) || 0,
      /* 这个窗口里现在有哪几张 page target。
       * 0.4.7.11 第二轮：从「一个数字」改成**逐张明细** —— 用户报「投错标签」时，
       * 只给个 `pages=2` 等于让人肉去 `/json/list` 映射 target_id，那正是这次要消灭的东西。 */
      pages: f ? [...f.pages.entries()].map(([tid, p]) => ({
        target_id: p.targetId || tid,
        url: p.href || null,
        visible: p.state === 'visible' ? true : p.state === 'hidden' ? false : null,
        alive: p.alive !== false,
        /** 是不是这个窗口「当前激活」的那张（事件上报的，见 PageFollower.setActiveTarget） */
        active: f.activeTargetId === (p.targetId || tid),
        /** 是不是现在真正在投递/捕获的那张 */
        is_current: t.targetId === (p.targetId || tid),
      })) : null,
      /** 张数（老字段的等价读数，界面和日志还在用） */
      pages_count: pageCount,
      /** 「当前激活标签」是靠什么定的：`event` = 页面自己上报，`poll` = 主进程轮询兜底 */
      target_signal: t.signal || null,
      activation: f ? (f.activationSeen ? 'event' : 'poll') : null,
      /* R5：受控窗口「实际投到哪张页」「投递成功过没有」「解析不到目标跳过几条」
       * 「坐标越界丢了几条」。没有这几个数，用户报「没反应」时我们只能猜。 */
      delivery_target_url: t.delivery_target_url || null,
      delivery_ok: t.delivery_ok === true ? true : t.delivery_ok === false ? false : null,
      skipped_no_target: Number(t.skipped_no_target) || 0,
      dropped_out_of_view: Number(t.dropped_out_of_view) || 0,
      no_viewport: Number(t.no_viewport) || 0,
      viewport: t.viewport,
      window: t.window,
      degraded: deg,
    });
  }
  // 「尺寸不一致」：按窗口外框宽比，>2% 就算不一致（视口差一点是滚动条造成的，不算）
  const widths = windows.filter((w) => w.role === 'slave' && w.window?.width).map((w) => w.window.width);
  const base = windows.find((w) => w.role === 'master')?.window?.width || null;
  let sizeMismatch = false;
  if (base && widths.length) {
    sizeMismatch = widths.some((w) => Math.abs(w - base) / base > 0.02);
  }
  const masterFollower = session.followers?.get?.(session.master) || null;
  const lastAt = session.last_event_at_ms || session.started_ms || Date.now();
  const out = {
    running: !session.stopped,
    session_id: session.id,
    master_id: session.master,
    slave_ids: session.slaves,
    settings: session.settings,
    binding_name: session.binding_name,
    started_at: session.started_at,
    events: session.events,
    forwarded: session.forwarded,
    dropped: session.dropped,
    /** R2：解析不到受控目标而跳过的事件数（0.4.7.11 新增，不许静默） */
    skipped_no_target: session.skipped_no_target || 0,
    /** R3：坐标落在受控视口外被丢弃的事件数 */
    dropped_out_of_view: session.dropped_out_of_view || 0,
    /** R6：看门狗自动重装捕获的次数（>0 说明前面有东西在丢，排障从这里看起） */
    capture_reinstalled: session.capture_reinstalled || 0,
    /** 兼容字段：0.4.7.11 按 R1 删掉了可见性闸门，恒为 0 */
    gated: 0,
    gate_reasons: session.gate_reasons || {},
    text_sent: session.text_sent,
    text_swallowed: session.text_swallowed,
    /** 最后一条捕获到的事件 / 距现在多久 —— `stale_ms` 是「用户操作了但没抓到」的唯一线索 */
    last_event_at: session.last_event_at || null,
    stale_ms: session.stopped ? 0 : Math.max(0, Date.now() - lastAt),
    /* R5：`alive` 是**读页面里的探针**得到的（脚本真在这个文档里），不是看进程在不在。
     * `targets_attached` = 装过捕获的标签数；`last_capture_target_url` = 探针所在那张页的地址；
     * `events_from_current_target` = 当前主控 target 贡献了多少条事件。 */
    alive: session.alive === true,
    alive_checked_ms: session.alive_checked_ms || 0,
    targets_attached: session.capture_pages ? session.capture_pages.size : 0,
    last_capture_target_url: session.last_capture_target_url || null,
    events_from_current_target: session.targetEvents?.get?.(session.targets?.get?.(session.master)?.targetId) || 0,
    /* 探针是 Symbol 键、没有字符串名（名字本身就是检测面），如实说明形状 */
    probe: session.probe_kind || 'symbol',
    /** 主窗口现在有几张装过捕获的标签、可见那张是什么页 */
    master_pages: masterFollower ? masterFollower.pages.size : null,
    master_page_state: masterFollower?.visibleHref ? pageKind(masterFollower.visibleHref) : null,
    master_visible_target_id: masterFollower?.visibleTargetId || null,
    master_visible_url: masterFollower?.visibleHref || null,
    follow_interval_ms: FOLLOW_INTERVAL_MS,
    delivery_cache_ms: 500,
    abnormal: session.abnormal || null,
    end_reason: session.end_reason || null,
    end_message: session.end_message || null,
    scheduler: session.scheduler.stats(),
    windows,
    size_mismatch: sizeMismatch,
    last_teardown: lastTeardown,
    last_end: lastEnd,
  };
  /* 人话提示：`running=true` 但抓不到输入时，界面不能沉默（用户报「没反应」时最难查的就是这个） */
  out.hint = staleHint(out);
  return out;
}

/** 没在跑时给界面一个稳定的形状（不要返回 null，界面就不用到处判空） */
export function syncStatus() {
  if (!current) {
    return {
      running: false,
      master_id: null,
      slave_ids: [],
      settings: DEFAULT_SETTINGS,
      windows: [],
      size_mismatch: false,
      /* R5 的字段在「没在跑」时也要有：界面不用到处判空，判据也能直接读形状 */
      alive: false,
      targets_attached: 0,
      last_capture_target_url: null,
      events_from_current_target: 0,
      skipped_no_target: 0,
      dropped_out_of_view: 0,
      capture_reinstalled: 0,
      last_event_at: null,
      last_teardown: lastTeardown,
      last_end: lastEnd,
      hint: null,
      stale_ms: 0,
    };
  }
  return current.status();
}

export async function stopSync() {
  if (!current) return { running: false, teardown: lastTeardown };
  await current.stop();
  return { running: false, teardown: lastTeardown };
}

/**
 * 重启同步（对手的 `syncRestart`）：**用当前配置 stop + start**，不重新选窗口。
 *
 * 为什么要这个入口：改了窗口大小、换了标签页之后，捕获脚本与 binding 还挂在旧文档上，
 * 用户需要一个「重来一次」的按钮 —— 否则只能「停止 → 重新选主窗口/受控 → 开始」四步，
 * 而这三样我们本来就知道（`current.master` / `current.slaves` / `current.settings`）。
 *
 * `settings` 不给时沿用**这次会话正在用的那份**（它本身是「设置页存的默认 + 启动时覆盖」合并出来的），
 * 也就是 CEO 那句「参数没给时沿用已存默认」；给了就合并覆盖在上面。
 *
 * 失败不静默：`startSync` 抛错时，旧会话**已经停了**，调用方拿到的错要说清楚
 * 「已停止，但没能重新开始」—— 返回里带 `restarted:false` 与 `previous`，界面照实显示。
 */
export async function restartSync({ settings = null } = {}) {
  if (!current) throw new Error('没有正在运行的同步会话，先开始同步');
  const masterId = current.master;
  const slaveIds = [...current.slaves];
  const keep = settings && typeof settings === 'object'
    ? normalizeSettings({ ...current.settings, ...settings })
    : current.settings;

  await stopSync();
  try {
    const st = await startSync({ masterId, slaveIds, settings: keep });
    return { restarted: true, ...st };
  } catch (e) {
    const err = new Error(`同步已停止，但没能重新开始：${e?.message || String(e)}`);
    err.restarted = false;
    err.previous = { master_id: masterId, slave_ids: slaveIds };
    throw err;
  }
}

/** 环境被停掉时清会话（`manager.stopProfile` 会调它，别让会话挂在死连接上） */
export async function detachProfile(profileId) {
  if (!current) return false;
  if (current.master !== profileId && !current.slaves.includes(profileId)) return false;
  await stopSync();
  return true;
}

/** 改设置：四个开关与延迟可以运行中改，不用重开会话 */
export function updateSettings(raw) {
  if (!current) throw new Error('没有正在运行的同步会话');
  const st = normalizeSettings({ ...current.settings, ...raw });
  current.settings = st;
  current.scheduler.delayMs = st.delay_ms;
  current.scheduler.jitterMs = st.jitter_ms;
  return st;
}

/**
 * 一键统一尺寸：把每个受控窗口的外框拉到主窗口的宽高。
 *
 * 为什么是**按钮**不是自动：改用户窗口是可见的操作，静默改会让人以为程序自己乱动。
 * 为什么不改视口：外框是用户能看见、能自己调的那个量；视口差几像素是滚动条造成的。
 *
 * 三条硬约束（2026-11-14 阶段 3，CEO 定）：
 *   ① 先判窗口状态：**最大化 / 全屏 / 最小化下 `Browser.setWindowBounds` 的宽高会被静默忽略**，
 *      必须先把窗口恢复成 normal 再设尺寸 —— 否则用户点一辈子没反应还不知道为什么。
 *   ② 设完**回读校验**：重新读 `Browser.getWindowForTarget` 比对，不一致就如实报
 *      「有 N 个窗口没能改成同尺寸」，**不静默当成功**（命令返回成功不等于窗口变了）。
 *   ③ 不动显示器/系统设置，只动我们管的那几个浏览器窗口。
 *
 * 主窗口自己如果是最大化/全屏，也先恢复成 normal：不这么做的话「参考尺寸」是屏幕大小，
 * 受控窗口会变成三个屏幕那么宽的普通窗口，视口照样对不上（而且用户看不出为什么）。
 */
export async function unifySize(rawIds = null) {
  const { handles, skipped, source } = await resolveWindows(rawIds, { what: '统一尺寸' });
  // 会话路径的参考尺寸必须是**主窗口**（解绑前的语义）；主窗口连接不在时如实报错，不拿受控窗口顶替
  if (source === 'session' && handles[0].role !== 'master') throw new Error('主窗口连接已不在');
  const mt = handles[0];

  /** 读一张页所属窗口的当前状态 */
  const readWin = async (t) => {
    const w = await windowSizeOf(t.client, t.targetId);
    if (!w?.windowId) throw new Error('读不到窗口 id');
    return w;
  };
  /** 恢复到 normal（已 normal 就不发命令，少一次可见抖动） */
  const toNormal = async (t, win) => {
    if (!needsRestoreBeforeResize(win.state)) return win;
    await t.client.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal' } });
    await settle(120);
    return readWin(t);
  };

  const masterBefore = await readWin(mt);
  const masterRestored = needsRestoreBeforeResize(masterBefore.state);
  if (masterRestored) {
    await toNormal(mt, masterBefore);
    // 回读确认它真的回到 normal 了（不确认的话「参考尺寸」可能是屏幕大小）
    const check = await readWin(mt);
    if (normalizeState(check.state) !== 'normal') throw new Error('主窗口恢复成 normal 失败，没法当参考尺寸');
  }
  // 恢复之后重新读一遍真实宽高（normal 尺寸和最大化尺寸不是一个东西）
  const masterNow = await readWin(mt);
  const ref = { width: Math.round(Number(masterNow.width)), height: Math.round(Number(masterNow.height)) };
  if (!Number.isFinite(ref.width) || !Number.isFinite(ref.height) || ref.width <= 0 || ref.height <= 0) {
    throw new Error('读不到主窗口尺寸');
  }

  const resized = [];
  for (const t of handles.slice(1)) {
    const id = t.id;
    const entry = { profile_id: id, role: t.role, target_id: t.targetId, ok: false, expected: ref };
    try {
      let win = await readWin(t);
      entry.state_before = normalizeState(win.state);
      win = await toNormal(t, win);
      // 恢复之后重新读：normal 尺寸才是真正要改的那个基准
      await t.client.send('Browser.setWindowBounds', {
        windowId: win.windowId,
        bounds: { width: ref.width, height: ref.height },
      });
      await settle(140);
      // 回读校验（唯一可信的「成功」依据）
      const after = await readWin(t);
      entry.actual = { width: after.width, height: after.height, state: normalizeState(after.state) };
      const v = verifyBounds(ref, after);
      entry.ok = v.ok;
      entry.mismatches = v.mismatches;
      if (!v.ok) entry.reason = v.mismatches.map((m) => `${m.field} 期望 ${m.expected} 实际 ${m.actual}`).join('；');
    } catch (e) {
      entry.reason = e?.message || String(e);
    }
    resized.push(entry);
  }

  await refreshAll();
  const summary = summarizeResize(resized);
  return {
    /** 参考窗口（会话路径就是主窗口；解绑路径是 ids 里的第一个） */
    reference_id: mt.id,
    source,
    skipped,
    reference: ref,
    master_restored: masterRestored,
    master_state_before: normalizeState(masterBefore.state),
    resized,
    summary,
    status: current ? current.status() : syncStatus(),
  };
}

/**
 * 窗口排列（`tileWin`）：把参与同步的窗口按网格摆好。
 *
 * 参数与对手对齐（见 `src/sync/arrange.js` 顶部）：`row` 每行几个、`hs` 列间距、`vs` 行间距、
 * `left`/`top` 起始偏移、`width`/`height` 窗口尺寸、`range` 重叠式、`screenId` / `screenList` 多屏。
 * `auto: true`（对手的「一键排列」`sync90`）→ 按目标屏幕可用区自动算尺寸与每行个数。
 *
 * 三条硬约束：
 *   ① 原点加**目标屏幕的 workArea 偏移**（不是 bounds —— bounds 含任务栏，窗口会被压在下面）；
 *   ② 非 normal 的窗口先恢复 normal 再摆（最大化/全屏下 setWindowBounds 的宽高会被静默忽略，
 *      实测读数见 README「阶段 3 第 1 件」）；
 *   ③ 摆完**回读**每个窗口的 left/top/width/height 比对，不一致如实报「有 N 个窗口没能排到位」。
 */
export async function arrangeWindows(rawParams = {}, rawIds = null) {
  /* 窗口排列**不需要同步会话**（0.4.7.4 解绑，见 resolveWindows 顶部）：
   * 给了 ids 就排这些运行中的环境；没给且会话在跑就排会话里的窗口（老行为）。 */
  const { handles, skipped, source } = await resolveWindows(
    rawIds ?? rawParams?.ids ?? rawParams?.profile_ids,
    { what: '排列' },
  );
  const ids = handles.map((h) => h.id);

  const screens = screensForArrange();
  const params = { ...rawParams };
  let autoInfo = null;

  /* 一键排列：按目标屏幕可用区自动算「每行几个 + 每个多大」 */
  if (rawParams.auto === true || rawParams.auto === 'true' || rawParams.auto === 1) {
    const targetId = params.screenId === undefined || params.screenId === null || params.screenId === -1
      ? (screens.find((x) => x.primary)?.id ?? screens[0]?.id ?? null)
      : params.screenId;
    const area = screens.find((x) => String(x.id) === String(targetId))?.workArea
      || screens.find((x) => x.primary)?.workArea
      || screens[0]?.workArea
      || { x: 0, y: 0, width: 0, height: 0 };
    const fitted = autoFit(ids.length, area, { gap: Number(params.hs) || 0 });
    params.row = fitted.cols;
    params.width = fitted.width;
    params.height = fitted.height;
    // 自动模式下从可用区原点开始，偏移由用户额外给的 top/left 叠加
    params.left = Math.max(0, Number(params.left) || 0);
    params.top = Math.max(0, Number(params.top) || 0);
    autoInfo = { ...fitted, area };
  }

  const plan = planArrange({ count: ids.length, params, screens });
  const audit = auditPlan(plan.windows, screens.find((x) => String(x.id) === String(plan.screen_id))?.workArea || null);

  const placed = [];
  for (let i = 0; i < handles.length; i++) {
    const t = handles[i];
    const want = plan.windows[i];
    const entry = { profile_id: t.id, role: t.role, index: i, ok: false };
    try {
      const win = await windowSizeOf(t.client, t.targetId);
      if (!win?.windowId) throw new Error('读不到窗口 id');
      entry.state_before = normalizeState(win.state);
      /* 摆动 + 判定都在 placeOne 里：它只用回读说话。
       * 抽出去的理由见 arrange.js 顶部 —— 真内核造不出「命令成功但没到位」，
       * 那条只能靠注入假读数在 A 层测，所以判定必须只有一处、且可注入。 */
      const r = await placeOne({
        windowId: win.windowId,
        want,
        stateBefore: win.state,
        setBounds: (windowId, bounds) => t.client.send('Browser.setWindowBounds', { windowId, bounds }),
        readRect: () => windowRectOf(t.client, t.targetId),
        wait: settle,
      });
      Object.assign(entry, r);
    } catch (e) {
      entry.reason = e?.message || String(e);
    }
    placed.push(entry);
  }

  await refreshAll();
  return {
    source,
    skipped,
    /** 这一轮为了排列而新开的 CDP 会话数：窗口排列只走浏览器级命令，**恒为 0** */
    attached: 0,
    screen_id: plan.screen_id,
    plan: plan.windows,
    audit,
    warnings: plan.warnings,
    auto: autoInfo,
    displays_managed: screens.length > 0,
    placed,
    summary: summarizeArrange(placed),
    status: current ? current.status() : syncStatus(),
  };
}

/**
 * 强制置前：**用户显式点按钮才走这里**，默认的「显示窗口」绝不调用它。
 *
 * 为什么需要它：零依赖下 `Page.bringToFront` 抬不动被其它窗口盖住的窗口（实测 Win32 前台
 * 仍是别的窗口、z 序不动）。唯一能做到的办法是「最小化 → 恢复原状态」，实测会真的成为
 * OS 前台，代价是任务栏闪一下、每个窗口 0.6–1.0 秒。所以做成**一次性显式动作**：
 * 不写设置、不做开关、不默认执行 —— 用户点了就是要「现在看见它」。
 *
 * **能确认到哪**：产品里不调 Win32，所以只能回读 `windowState` 确认「窗口已恢复正常」，
 * 确认不了「它现在在最前面」。返回值的 `confirmed: 'window_restored'` 和文案
 * 「已恢复显示并尝试置前」说的就是这个边界，不写「已置前」。
 *
 * 判定**复用 `verifyShown(..., {strictRect:true})`**（`verifyForced`）：
 * 动过窗口，所以位置尺寸也要回到原样，别把多屏窗口搬回主屏。
 */
export async function forceShowWindows(rawIds) {
  // 强制置前同样解绑（0.4.7.4）：只有浏览器级命令 + 状态回读，不需要同步会话
  const { handles, skipped, source } = await resolveWindows(rawIds, { what: '显示' });

  const results = [];
  for (const t of handles) {
    const id = t.id;
    const entry = {
      profile_id: id,
      role: t.role,
      ok: false,
      action: 'force',
      raise: 'none',
      state_before: null,
      state_after: null,
      rect_before: null,
      rect_after: null,
    };
    try {
      const win = await windowSizeOf(t.client, t.targetId);
      if (!win?.windowId) throw new Error('读不到窗口 id');
      const before = await windowRectOf(t.client, t.targetId);
      entry.state_before = normalizeState(win.state);
      entry.rect_before = before;
      const [plan] = planForce([{ profile_id: id, state: win.state }]);
      entry.action = plan.action;
      if (plan.action === 'skip') {
        entry.reason = plan.reason;
        entry.ok = true;
        entry.raise = 'none';
        results.push(entry);
        continue;
      }

      /* 唯一「闪一下」的地方：最小化，再恢复成它原来的状态（normal 或 maximized） */
      await nudgeToFront(t.client, win.windowId, entry.state_before);
      entry.raise = 'restored';

      const after = await windowRectOf(t.client, t.targetId);
      entry.rect_after = after;
      entry.state_after = normalizeState(after?.state);
      const v = verifyForced({ state_before: entry.state_before, rect_before: before }, after);
      entry.ok = v.ok;
      entry.problems = v.problems;
      if (!v.ok) entry.reason = v.problems.map((m) => `${m.field} 期望 ${m.expected} 实际 ${m.actual}`).join('；');
    } catch (e) {
      entry.reason = e?.message || String(e);
    }
    results.push(entry);
  }

  await refreshAll();
  return {
    source,
    skipped,
    forced: results,
    summary: summarizeForce(results),
    /** 能确认的只有「窗口恢复正常」，不是「在最前面」（产品里不调 Win32） */
    os_foreground_confirmed: false,
    status: current ? current.status() : syncStatus(),
  };
}

/**
 * 最小化 → 恢复原状态。**只给强制置前用**，默认路径不许调（判据里有静态断言）。
 * 恢复成 `maximized` 时显式设 maximized：`setWindowBounds(normal)` 对最大化窗口是「取消最大化」，
 * 不能拿来当「恢复」。
 */
async function nudgeToFront(client, windowId, stateBefore) {
  await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  await settle(140);
  const back = normalizeState(stateBefore) === 'maximized' ? 'maximized' : 'normal';
  await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: back } });
  await settle(240);
}

/**
 * 显示窗口（对手的 `viewWin` / 行内 `displayWin`）：把窗口从最小化恢复出来并尽量放到前面。
 *
 * **零依赖实测读数决定实现**（`.tmp/foreground-probe*.mjs`，Chrome 157.0.8103.78，三层分开量）：
 *
 *   窗口**最小化**时：
 *     `Browser.setWindowBounds({windowState:'normal'})` → Win32 前台 pid = 该内核、z 序 0
 *     `Page.bringToFront`                              → 同样到前台、z 序 0
 *     ⇒ 恢复这一步**真的把 OS 窗口抬到前台了**。
 *
 *   窗口**没最小化、只是被别的窗口盖住**时：
 *     `Page.bringToFront` → 页面 `document.hasFocus()` 变 true，但 **Win32 前台仍不是它、z 序没动**
 *     `Target.activateTarget` → 同上，不抬
 *     `Browser.setWindowBounds(windowState:'normal')`（它本来就是 normal）→ 不抬
 *     ⇒ 「页面拿到焦点」和「OS 窗口到前台」不是一回事，**绝不能拿前者冒充后者**。
 *
 * 所以这里分两档，逐条如实记在 `raise` 字段里：
 *   `restored`   最小化 → 恢复并到前台（真的 ③）
 *   `page_only`  只做了页面级激活，**可能仍被盖住**（只有 ②，不是 ③）
 *   `none`       没动（用户主动全屏的窗口不该被我们缩回来）
 *
 * 为什么不给「被盖住」这种窗口也硬抬：零依赖唯一能做到的办法是「先最小化再恢复」
 * （实测能到前台，约 600–1000ms，位置不变、最大化状态也不丢），但那会让任务栏闪一下 ——
 * 是可见副作用，不在这一版里默认做（要不要引 Win32 依赖把它做成瞬间的，等定）。
 */
export async function showWindows(rawIds) {
  // 显示窗口解绑（0.4.7.4）：给了 ids 就动这些运行中的环境，不需要同步会话
  const { handles, skipped, source } = await resolveWindows(rawIds, { what: '显示' });

  const results = [];
  let attached = 0;
  try {
    for (const t of handles) {
      const id = t.id;
      const entry = {
        profile_id: id,
        role: t.role,
        ok: false,
        raise: 'none',
        state_before: null,
        state_after: null,
        rect_before: null,
        rect_after: null,
      };
      try {
        const win = await windowSizeOf(t.client, t.targetId);
        if (!win?.windowId) throw new Error('读不到窗口 id');
        const before = await windowRectOf(t.client, t.targetId);
        entry.state_before = normalizeState(win.state);
        entry.rect_before = before;
        const [plan] = planShow([{ profile_id: id, state: win.state }]);
        entry.action = plan.action;

        if (plan.action === 'restore') {
          entry.raise = 'restored';
          await t.client.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal' } });
          await settle(160);
        } else if (plan.action === 'page_only') {
          entry.raise = 'page_only';
          /* 页面级激活要 Page 域 → 这时才 attach（解绑路径按需开、用完摘） */
          if (!t.sessionId) attached += 1;
          await t.client.send('Page.bringToFront', {}, await pageSessionOf(t));
          await settle(160);
        }

        /* 回读：恢复成功只认状态 + 位置尺寸没被搬走（见 show.js 顶部） */
        const after = await windowRectOf(t.client, t.targetId);
        entry.rect_after = after;
        entry.state_after = normalizeState(after?.state);
        const v = verifyShown({ state_before: entry.state_before, rect_before: before }, after);
        // page_only 那批同时记下「页面拿到焦点没有」—— 但**它不参与 ok**，只作读数
        if (plan.action === 'page_only') {
          entry.page_focused = await pageHasFocus(t.client, await pageSessionOf(t));
        }
        entry.ok = v.ok;
        entry.problems = v.problems;
        if (!v.ok) entry.reason = v.problems.map((m) => `${m.field} 期望 ${m.expected} 实际 ${m.actual}`).join('；');
      } catch (e) {
        entry.reason = e?.message || String(e);
      }
      results.push(entry);
    }
  } finally {
    await releaseHandles(handles);
  }

  await refreshAll();
  return {
    source,
    skipped,
    /** 这一轮为了「页面级激活」新开的 CDP 会话数（解绑路径才会有；用完已摘） */
    attached,
    shown: results,
    summary: summarizeShow(results),
    /**
     * 明确告诉调用方：这一版**只有最小化的窗口真到前台**。
     * 面板据此显示一行提示，不让用户以为「点了就跑到最前面了」。
     */
    os_foreground: results.length > 0 && results.every((r) => r.raise === 'restored'),
    status: current ? current.status() : syncStatus(),
  };
}

/** 页面文档有没有焦点（只作读数，**不当作「窗口到前台」**） */
async function pageHasFocus(client, sessionId) {
  try {
    const r = await client.send('Runtime.evaluate', {
      expression: 'JSON.stringify({hasFocus: document.hasFocus(), visibility: document.visibilityState})',
      returnByValue: true,
    }, sessionId);
    return JSON.parse(r?.result?.value || '{}');
  } catch {
    return null;
  }
}

/**
 * 打开网址（`syncOperateOpenUrl`）：在每个同步窗口里打开同一批网址，**最多 10 个**
 * （对手的提示原文 `syncOperateOpenUrlsMaxCountExceed` 是「一键最多打开10个网址」）。
 * 超过 10 个**直接报错**，不静默截断 —— 用户填了 12 个却发现只开了 10 个，比报错难查得多。
 *
 * **姿势不能错**：`Target.createTarget({url})` 会在 attach 之前就把首个文档建好，
 * 注入脚本只对下一个文档生效 —— 那张标签的首帧就是原始指纹（`manager.js:807` 的实测）。
 * 所以一律 `about:blank` → 登记 blank-reload 豁免 → attach → `Page.navigate`。
 * 判据钉的就是这个：首个文档的**注入完成标记**（按该环境 `fp_seed` 派生的名字，见 `kernel/markers.js`）
 * 是 `object`，且 `navigation.type === 'navigate'`，并且**服务器只收到一次请求**。
 *
 * 只有一条选项（对手也是这么表达的）：
 *   `current_tab_url`（首个网址在当前标签页打开）→ **第一个**网址在窗口当前标签页里跳（`navigateAt`），
 *   其余网址照常新开。关掉（默认）时全部新开。
 */
export async function openTabInAll(rawUrl) {
  if (!current) throw new Error('没有正在运行的同步会话');
  const { urls, error } = parseOpenUrls(rawUrl);
  if (error) throw new Error(error);

  const opened = [];
  const masterTabs = await listTabs(current.targets.get(current.master).client);
  const masterVis = await visibleTabIndex(current.targets.get(current.master).client, masterTabs);
  for (const id of [current.master, ...current.slaves]) {
    const t = current.targets.get(id);
    if (!t) continue;
    const isMaster = id === current.master;
    const inst = getInstance(id);
    try {
      const tabs = isMaster ? masterTabs : await listTabs(t.client);
      const vis = isMaster ? masterVis : await visibleTabIndex(t.client, tabs);
      for (let n = 0; n < urls.length; n++) {
        const url = urls[n];
        // 「首个网址在当前标签页打开」只对**第一个**网址生效，其余照常新开（对手就是这么分的）
        if (n === 0 && current.settings.current_tab_url) {
          const idx = isMaster ? vis.index : slaveAnchor(masterVis.index, vis.index, tabs.length, current.settings.same_tab);
          const tab = tabs[idx];
          if (!tab) {
            opened.push({ profile_id: id, target_id: null, url, mode: 'current_tab', error: '没有可导航的标签' });
            continue;
          }
          await navigateAt(t.client, tab.targetId, url);
          opened.push({ profile_id: id, role: isMaster ? 'master' : 'slave', target_id: tab.targetId, url, mode: 'current_tab' });
          continue;
        }
        const r = await openTabFor(t.client, { url, onTarget: (tid) => inst?.exemptBlankReload?.(tid) });
        opened.push({ profile_id: id, role: isMaster ? 'master' : 'slave', target_id: r.targetId, url, mode: 'new_tab' });
      }
    } catch (e) {
      opened.push({ profile_id: id, target_id: null, urls, error: e?.message || String(e) });
    }
  }
  return { opened, urls };
}

/* ------------------------------ 标签页：状态 / 关 / 复制 / 统一 ------------------------------ */

/** 各窗口的标签列表 + 当前可见序号（界面与判据都读这个，不靠猜）。 */
export async function tabState() {
  if (!current) return { running: false, windows: [] };
  const windows = [];
  for (const id of [current.master, ...current.slaves]) {
    const t = current.targets.get(id);
    if (!t) continue;
    const tabs = await listTabs(t.client).catch(() => []);
    const vis = await visibleTabIndex(t.client, tabs).catch(() => ({ index: 0, confident: false }));
    windows.push({
      profile_id: id,
      role: id === current.master ? 'master' : 'slave',
      visible: vis.index,
      visible_confident: vis.confident,   // false = CDP 读不到前台标签，这条是猜的（如实带出去）
      tabs: tabs.map((x) => ({ index: x.index, url: x.url, title: x.title })),
    });
  }
  return {
    running: true,
    same_tab: current.settings.same_tab,          // 内部字段，面板不展示
    current_tab_url: current.settings.current_tab_url,
    windows,
  };
}

/**
 * 受控窗口该动第几个标签。
 *   `same_tab` 开：跟**主窗口**的序号（主窗口动第 2 个，受控也动第 2 个）；
 *   `same_tab` 关：各自动自己当前前台那个（`ownVisible`）。
 * 主窗口序号越界（受控窗口标签更少）时退回自己的前台标签 —— 跳过并如实记，不猜着乱关。
 */
function slaveAnchor(masterIndex, ownVisible, slaveCount, sameTab) {
  if (!sameTab || masterIndex === null || masterIndex === undefined) return ownVisible;
  return targetIndex(masterIndex, slaveCount, true) ?? ownVisible;
}

/**
 * 关标签：`current` 关当前 / `others` 关其它（留当前）/ `blank` 关空白。
 * 返回每个窗口实际关了哪些序号 —— 界面和判据都看这个，不看「应该关什么」。
 */
export async function closeTabs(which = 'current') {
  if (!current) throw new Error('没有正在运行的同步会话');
  const mode = ['current', 'others', 'blank'].includes(which) ? which : 'current';
  const closed = [];
  // 「相同标签页」的锚点是**主窗口**的序号：受控窗口按主窗口那个序号动，
  // 而不是拿自己的前台标签当锚（那样等于没开这个开关，2026-11-14 B 层判据抓到过）。
  let masterAnchor = null;
  const masterT = current.targets.get(current.master);
  if (masterT) {
    const mTabs = await listTabs(masterT.client).catch(() => []);
    if (mTabs.length) {
      masterAnchor = (await visibleTabIndex(masterT.client, mTabs).catch(() => ({ index: 0, confident: false }))).index;
    }
  }
  for (const id of [current.master, ...current.slaves]) {
    const t = current.targets.get(id);
    if (!t) continue;
    const tabs = await listTabs(t.client).catch(() => []);
    if (!tabs.length) continue;
    const vis = await visibleTabIndex(t.client, tabs).catch(() => ({ index: 0, confident: false }));
    const isMaster = id === current.master;

    let plan = [];
    if (mode === 'others') {
      const keep = isMaster ? vis.index : slaveAnchor(masterAnchor, vis.index, tabs.length, current.settings.same_tab);
      plan = planCloseOthers(tabs.length, keep).map((i) => tabs[i]);
    } else if (mode === 'blank') {
      plan = planCloseBlank(tabs.map((x) => x.url)).map((i) => tabs[i]);
    } else {
      const idx = isMaster ? vis.index : slaveAnchor(masterAnchor, vis.index, tabs.length, current.settings.same_tab);
      if (tabs[idx]) plan = [tabs[idx]];
    }

    for (const tab of plan) {
      const ok = await closeTabAt(t.client, tab.targetId);
      closed.push({ profile_id: id, role: isMaster ? 'master' : 'slave', index: tab.index, url: tab.url, ok });
    }
  }
  await settle(150);
  return { which: mode, closed };
}

/**
 * 复制标签到其它窗口：把主窗口第 `index` 个标签的 URL 在受控窗口打开。
 * 这是「复制」不是「同步」——只往受控窗口去，不会反过来动主窗口。
 */
export async function copyTabToSlaves({ index = null } = {}) {
  if (!current) throw new Error('没有正在运行的同步会话');
  const mt = current.targets.get(current.master);
  if (!mt) throw new Error('主窗口连接已不在');
  const masterTabs = await listTabs(mt.client);
  const vis = await visibleTabIndex(mt.client, masterTabs).catch(() => ({ index: 0, confident: false }));
  const idx = index === null || index === undefined ? vis.index : Math.floor(Number(index));
  const src = masterTabs[idx];
  if (!src) throw new Error(`主窗口没有第 ${idx} 个标签`);
  if (!src.url || isBlankUrl(src.url)) throw new Error('主窗口这个标签是空白页，没有可复制的地址');

  const copied = [];
  for (const id of current.slaves) {
    const t = current.targets.get(id);
    if (!t) continue;
    try {
      const inst = getInstance(id);
      // 复制标签**永远新开一张**（没有「目标空白」这个开关，也没有原地跳的分支）：
      // 复制到其它窗口的语义就是「多出一张」，原地跳是「替换掉现在这张」，那是另一件事。
      const r = await openTabFor(t.client, { url: src.url, onTarget: (tid) => inst?.exemptBlankReload?.(tid) });
      copied.push({ profile_id: id, target_id: r.targetId, url: src.url, mode: 'new_tab' });
    } catch (e) {
      copied.push({ profile_id: id, target_id: null, url: src.url, error: e?.message || String(e) });
    }
  }
  return { from_index: idx, url: src.url, copied };
}

/**
 * 统一标签页：把受控窗口的标签弄成与主窗口一致（数量 + 每个序号的 URL）。
 * 只做 CDP 真能做到的：多关尾部、缺开尾部、同序号 URL 不同就地跳。**不假装能插到中间**。
 */
export async function unifyTabs() {
  if (!current) throw new Error('没有正在运行的同步会话');
  const mt = current.targets.get(current.master);
  if (!mt) throw new Error('主窗口连接已不在');
  const masterTabs = await listTabs(mt.client);
  const masterUrls = masterTabs.map((t) => t.url);
  const result = [];
  for (const id of current.slaves) {
    const t = current.targets.get(id);
    if (!t) continue;
    const inst = getInstance(id);
    const slaveTabs = await listTabs(t.client).catch(() => []);
    const plan = planUnify(masterUrls, slaveTabs.map((x) => x.url));
    const done = { profile_id: id, navigated: [], opened: [], closed: [], errors: [] };
    for (const n of plan.navigate) {
      const tab = slaveTabs[n.index];
      if (!tab) continue;
      try { await navigateAt(t.client, tab.targetId, n.url); done.navigated.push(n); } catch (e) { done.errors.push(String(e?.message || e)); }
    }
    for (const i of plan.close) {
      const tab = slaveTabs[i];
      if (!tab) continue;
      const ok = await closeTabAt(t.client, tab.targetId);
      done.closed.push({ index: i, url: tab.url, ok });
    }
    for (const url of plan.open) {
      if (!url || isBlankUrl(url)) { done.opened.push({ url, skipped: 'blank' }); continue; }
      try {
        const r = await openTabFor(t.client, { url, onTarget: (tid) => inst?.exemptBlankReload?.(tid) });
        done.opened.push({ url, target_id: r.targetId });
      } catch (e) { done.errors.push(String(e?.message || e)); }
    }
    result.push(done);
  }
  await settle(150);
  return { master_urls: masterUrls, windows: result };
}

/** 重读所有窗口的视口（用户改了窗口尺寸之后调；8b 判据也用它） */
export async function refreshAll() {
  if (!current) return null;
  for (const id of [current.master, ...current.slaves]) {
    await current.refreshViewport(id).catch(() => {});
    const t = current.targets.get(id);
    if (t) t.window = await windowSizeOf(t.client, t.targetId).catch(() => t.window);
  }
  return current.status();
}

export { sleep };
/** 判据用：主窗口这张页面能不能同步（纯函数，A 层直接断言口径，不启内核） */
export { unusableMasterPage };