/**
 * 窗口同步 · CDP 小工具与「要动哪些窗口」解析（从 session.js 拆出，行为不变）。
 * 连接、选页、attach、视口/窗口矩形读数、存活探针表达式、解绑路径的窗口解析。
 */
import { CdpClient } from '../kernel/cdp.js';
import { getInstance } from '../runtime/manager.js';
import { isStartPageUrl } from '../start/host.js';
import { choosePage, pageUsableReason } from './follow.js';
import { readVisibility } from './tabs.js';
import { state } from './session-state.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
export const PROBE_READ_EXPR = `(() => {
  var probe = null;
  try { ${PROBE_FIND} } catch (e) {}
  return JSON.stringify({ a: !!probe, h: location.href });
})()`;
export const PROBE_BOOL_EXPR = `(() => {
  var probe = null;
  try { ${PROBE_FIND} } catch (e) {}
  return !!probe;
})()`;
export const PROBE_OFF_EXPR = `(() => {
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
export async function connectInstance(profileId) {
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
export const unusableMasterPage = pageUsableReason;

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

export async function attach(client, targetId) {
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  return sessionId;
}

/** 受控窗口的可视视口（CSS px）。窗口最小化 / 还没布局时可能拿不到，返回 null 由调用方丢弃事件 */
export async function viewportOf(client, sessionId) {
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
export async function windowSizeOf(client, targetId) {
  try {
    const { windowId, bounds } = await client.send('Browser.getWindowForTarget', { targetId });
    return { windowId, width: bounds?.width ?? null, height: bounds?.height ?? null, state: bounds?.windowState || null };
  } catch {
    return null;
  }
}

/** 窗口的完整矩形（位置 + 尺寸 + 状态）：「窗口排列」的回读比对读它 */
export async function windowRectOf(client, targetId) {
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
  if (!state.current) return 'window';
  if (profileId === state.current.master) return 'master';
  if (state.current.slaves.includes(profileId)) return 'slave';
  return 'window';
}

/**
 * 解析「这次要动哪些窗口」。
 * @param {string[]|string|null} rawIds
 * @param {{what?:string}} opt `what` 只进错误文案（排列 / 显示 / 统一尺寸）
 * @returns {Promise<{handles:Array, skipped:Array, source:'session'|'ids'}>}
 */
export async function resolveWindows(rawIds, { what = '排列' } = {}) {
  const want = normalizeIdList(rawIds);
  const handles = [];
  const skipped = [];

  // ① 没给 ids：沿用同步会话（解绑前的行为，一个字节都不变）
  if (!want.length) {
    if (!state.current) {
      const err = new Error(`没有可${what}的窗口：先勾选正在运行的环境（同步没开始时也能排列），或者先开始同步`);
      err.reason = 'no_windows';
      throw err;
    }
    for (const id of [state.current.master, ...current.slaves]) {
      const t = state.current.targets.get(id);
      if (!t) continue;
      handles.push({
        id, client: t.client, targetId: t.targetId, sessionId: t.sessionId,
        role: id === state.current.master ? 'master' : 'slave', source: 'session', attachedByUs: false,
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
    const inSession = state.current?.targets.get(id);
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
export async function pageSessionOf(h) {
  if (h.sessionId) return h.sessionId;
  h.sessionId = await attach(h.client, h.targetId);
  h.attachedByUs = true;
  return h.sessionId;
}

/** 收尾：我们自己 attach 的会话要摘掉，别留给下一次（复用实例的连接是共用的） */
export async function releaseHandles(handles) {
  for (const h of handles) {
    if (!h.attachedByUs || !h.sessionId) continue;
    try { await h.client.send('Target.detachFromTarget', { sessionId: h.sessionId }); } catch { /* 连接已断就算了 */ }
    h.attachedByUs = false;
    h.sessionId = null;
  }
}
