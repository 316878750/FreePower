/**
 * 运行中跟随（0.4.7.11）：同步**不能只在「开始」那一刻选一次页面**。
 *
 * 上一版（0.4.7.10）修的是「启动时选错了标签」：优先选前台可见的那张。
 * 但用户 2026-11-21 第二次反馈「还是不联动」，实测读数是这样的：
 *
 *   status: master target=DB4B3123AD url=https://app.startale.com/sign-up visible=true confident=true
 *   主控窗口现在只有两个标签：defi.xstocks.fi/points 和起始页
 *   → DB4B3123AD 已经不在窗口里了（那张标签被用户关掉/换掉了）
 *   往主控**当前可见**的 xstocks 页注入 5 个事件，计数 delta=0（21→21）
 *
 * 也就是说：选得对，但**只对了一瞬间**。用户在会话中途切标签、关标签、开新标签之后，
 * 同步还绑在旧 target 上 —— 那张页已经没了，捕获脚本跟着没了，事件一条都进不来；
 * 而 `running` 依然是 true、日志里没有任何一行说「目标没了」。用户看到的就是「没反应」。
 *
 * 这个模块负责「跟着用户走」：
 *   ① 每 `FOLLOW_INTERVAL_MS` 轮询一次 `Target.getTargets` + 每张页的 `document.visibilityState`；
 *      每个 target **一条持久 attach**，轮询复用，不反复 attach/detach；
 *   ② 可见页变了 → 通知调用方改投递目标（受控窗口要换 session、重读视口）；
 *   ③ target 没了 → 从表里摘掉、通知调用方；主窗口一张页都不剩 → 通知调用方结束会话；
 *   ④ 主窗口的捕获脚本装在**所有** page target 上（不只是可见那张）——
 *      真实用户输入只会落在前台那张页上，全装天然等价于「跟随激活标签」（R1，不判断可见性）。
 *
 * 纯决策部分（`pageKind` / `pageUsableReason` / `choosePage` / `staleHint`）
 * 都不碰 CDP，判据可以直接真求值；`PageFollower` 只依赖注入的客户端，假客户端也能跑。
 */
import { isStartPageUrl } from '../start/host.js';

/** 轮询间隔：450ms。用户切完标签再开始操作，最多丢半秒的第一下。 */
export const FOLLOW_INTERVAL_MS = 450;
/** 多久没捕获到输入就算「可疑」（只在状态里给人话提示，不阻断） */
export const STALE_MS = 5000;

/**
 * 「会话/目标已销毁」类 CDP 错误的统一识别。
 *
 * 什么时候会出现：target 还在表里（`targetDestroyed` 还没到 / 根本不会来），但渲染器已经被
 * 换掉或丢弃，缓存里的 sessionId 成了死会话 —— 之后每条命令都报
 * 「Session with given id not found」。识别出这一类，调用方才能走「作废重连」而不是报错。
 *
 * 内核侧（runtime/manager.js）另有一份同口径实现：两层不许互相 import（sync 层 import
 * runtime 层可以，反过来会成环），所以各留一份、文案集合保持一致，改一处要记得另一处。
 */
export function isSessionDeadError(e) {
  return /session with given id|no target with given id|target closed|session closed|cannot find context|execution context was destroyed/i
    .test(String(e?.message || e || ''));
}

/**
 * URL 分类。
 *
 * 为什么分这么细：`choosePage`（选谁去同步）对「什么算真站」是**宽松**口径（除了空白/新标签/
 * 错误页/起始页以外都算），而 `pageUsableReason`（起会话前的前置检查）要严格：
 * `chrome://settings` 这种内部页拿不到键盘焦点，同步它没有意义。
 */
export function pageKind(url) {
  const u = String(url || '');
  if (!u) return 'unknown';
  if (/^chrome-error:/i.test(u)) return 'error';
  if (isStartPageUrl(u)) return 'start';
  if (/^about:/i.test(u)) return 'blank';
  if (/^chrome:\/\/new-?tab/i.test(u)) return 'newtab';
  if (/^devtools:/i.test(u)) return 'devtools';
  if (/^(chrome|chrome-extension|edge|view-source|chrome-search|chrome-untrusted):/i.test(u)) return 'internal';
  if (/^https?:/i.test(u)) return 'real';
  return 'other';
}

/** 选目标的宽松口径（0.4.7.10 原样）：不是空白/新标签/错误页/起始页就算「真站」 */
export function isCandidatePage(url) {
  const k = pageKind(url);
  return k !== 'blank' && k !== 'newtab' && k !== 'error' && k !== 'start' && k !== 'unknown';
}

/**
 * 主窗口这张页面**能不能同步**。返回 `null` = 能，返回字符串 = 不能的原因（人话）。
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
 * 0.4.7.11 从 session.js 搬到这里：`choosePage()`（启动时和运行中）与
 * `pageUsableReason()`（起会话前的前置检查）必须共用同一套「什么算可同步页」的口径，
 * 两处各写一份迟早会分叉。
 */
export function pageUsableReason(url, { injected = false } = {}) {
  const u = String(url || '');
  if (!u) return '主窗口这张标签没有地址';
  if (/^chrome-error:/i.test(u)) return `主窗口停在 Chrome 错误页（${u.slice(0, 90)}）`;
  /* 0.4.7.5：起始页也不是业务页面。
   * 用户 2026-11-18 的场景：4 个环境全停在起始页（代理挂 → 打不开真站），
   * 同步会话起来了、事件也转发了，但点哪里都没有可见效果 —— 用户看到的就是「同步没反应」。
   * 起始页是**我们自己的本地页**，同步它没有任何意义，所以在起会话之前就明确拒绝。 */
  if (isStartPageUrl(u)) return '主窗口停在起始页（还没有打开真正的网站）';
  if (/^devtools:/i.test(u)) return '主窗口是开发者工具页';
  if (/^(chrome|chrome-extension|edge|view-source|chrome-search|chrome-untrusted):/i.test(u)) {
    return `主窗口是浏览器内部页面（${u.slice(0, 60)}）`;
  }
  if (/^about:/i.test(u)) {
    if (u === 'about:blank' && injected) return null;
    return '主窗口还停在空白页，而且注入脚本没装上（不是我们接管的那张）';
  }
  return null;
}

/**
 * 从「窗口里所有 page target」里选一张去同步（纯函数，判据直接真求值）。
 *
 * 优先级（0.4.7.11 第二轮起，`activeTargetId` 排在最前面）：
 *   ⓪ **页面自己上报「我变成可见了」的那张** → 事件驱动，最可信（`signal:'event'`）。
 *      为什么要它：R7 的 `Emulation.setFocusEmulationEnabled(true)` 会把后台页的
 *      `visibilityState` 也改成 `visible`（实测见 `agent-script.js` 的 `buildActivationScript`），
 *      一旦焦点模拟开在多张页上，轮询就分不出谁在前台，只能退回列表顺序 —— 那正是
 *      「用户切到 B2、输入一直打在 B1」的根因。
 *   ① 轮询到的**可见 + 真站** → `source:'visible'`、`signal:'poll'`、`confident:true`
 *   ② 读不到可见（窗口最小化 / 全读失败）或可见的是起始页 → 退回**第一张真站**，
 *      `source:'real-fallback'`、`confident:false`
 *   ③ 连真站都没有 → `pages[0]`，`source:'first-page'`、`confident:false`
 *
 * `source` 仍然是「为什么选它」：事件上报的语义就是「我变成可见了」，所以还是 `'visible'`；
 * 区分靠 `signal`（`'event'` = 页面自己报的，`'poll'` = 主进程轮询读到的）。
 *
 * @param {Array<{targetId: string, url?: string}>} pages `Target.getTargets` 里的 page 列表
 * @param {Map<string, {state: 'visible'|'hidden'|null, href: string|null}>} vis
 * @param {{activeTargetId?: string|null}} [opt] 事件驱动上报的当前激活 target
 * @returns {null | {targetId, url, visible, confident, source, signal, visible_url, visible_target_id}}
 */
export function choosePage(pages, vis, { activeTargetId = null } = {}) {
  const list = Array.isArray(pages) ? pages.filter((t) => t && t.targetId) : [];
  if (!list.length) return null;
  const infoOf = (t) => vis?.get?.(t.targetId) || { state: null, href: null };
  const urlOf = (t) => infoOf(t).href || t.url || '';
  const visibleOf = (t) => (infoOf(t).state === 'visible' ? true : infoOf(t).state === 'hidden' ? false : null);

  /* ⓪ 事件驱动优先：页面自己说「我被激活了」，比任何轮询都准，也不受焦点模拟影响
   * （焦点模拟只会让**别的**页谎报 visible，不会让这一页谎报「我刚被激活」）。 */
  const activePage = activeTargetId ? list.find((t) => t.targetId === activeTargetId) : null;
  const activeReal = activePage && isCandidatePage(urlOf(activePage)) ? activePage : null;
  if (activeReal) {
    return {
      targetId: activeReal.targetId, url: urlOf(activeReal), visible: true, confident: true,
      source: 'visible', signal: 'event',
      visible_url: urlOf(activeReal), visible_target_id: activeReal.targetId,
    };
  }

  const visiblePage = list.find((t) => infoOf(t).state === 'visible') || null;
  const visibleUrl = visiblePage ? urlOf(visiblePage) : null;
  const visibleTargetId = visiblePage ? visiblePage.targetId : null;

  const visibleReal = list.find((t) => infoOf(t).state === 'visible' && isCandidatePage(urlOf(t)));
  if (visibleReal) {
    return {
      targetId: visibleReal.targetId, url: urlOf(visibleReal), visible: true, confident: true,
      source: 'visible', signal: 'poll', visible_url: visibleUrl, visible_target_id: visibleTargetId,
    };
  }
  const fallbackReal = list.find((t) => isCandidatePage(urlOf(t)));
  if (fallbackReal) {
    return {
      targetId: fallbackReal.targetId, url: urlOf(fallbackReal), visible: visibleOf(fallbackReal),
      confident: false, source: 'real-fallback', signal: 'poll',
      visible_url: visibleUrl, visible_target_id: visibleTargetId,
    };
  }
  const first = list[0];
  return {
    targetId: first.targetId, url: urlOf(first), visible: visibleOf(first), confident: false,
    source: 'first-page', signal: 'poll', visible_url: visibleUrl, visible_target_id: visibleTargetId,
  };
}

/* 0.4.7.11：上一版这里的 `masterGate()`（「只转发当前可见那张页发来的事件」）按规格 R1 删掉了。
 *
 * AdsPower 的投递对象是**窗口句柄**，没有 target 概念，切/关/开标签全都即时跟随。
 * 我们用「所有 page 都装捕获」达到同样的效果：**真实用户输入本来就只会落在前台那张页上**，
 * 后台页不会有人按键。再加一道可见性闸门只会引入新的失败模式（可见性读不到就全丢），
 * 而「读不到 → 丢」正是用户看到「没反应」的来源之一。
 */

/**
 * 状态 → 给用户看的一句话（`null` = 没什么要说的）。
 *
 * 用户报「没反应」时，最糟的不是坏掉，而是**沉默**：`running=true`、界面一片正常。
 * 所以这里把「没页面 / 可见的不是业务页 / 很久没抓到输入」翻成人话。
 */
export function staleHint(st) {
  if (!st || st.running !== true) return null;
  const pages = Number(st.master_pages ?? 0);
  if (pages === 0) return '主窗口已经没有可捕获的标签（标签被切换或关闭），同步即将结束';
  const kind = String(st.master_page_state || '');
  if (kind && kind !== 'real') {
    const label = kind === 'start' ? '起始页'
      : kind === 'blank' ? '空白页'
        : kind === 'error' ? '错误页'
          : kind === 'newtab' ? '新标签页' : '浏览器内部页面';
    return `主窗口当前可见的是${label}，同步它没有效果（请切回业务页面）`;
  }
  const stale = Number(st.stale_ms ?? 0);
  if (stale > STALE_MS) {
    return `主窗口最近 ${Math.round(stale / 1000)} 秒没有捕获到输入；`
      + '如果此时正在主窗口操作，说明没有捕获到当前这张标签（标签被切换或关闭）';
  }
  return null;
}

/** 一次 evaluate 同时取回可见性、真实 href、注入标记、视口尺寸
 *  （`targetInfo.url` 在错误页上不可信；视口按 R3 用页面的 `innerWidth/innerHeight`） */
export async function readPageState(client, sessionId, { injectedExpression = null } = {}) {
  if (!sessionId) return null;
  const fields = [
    'v: document.visibilityState', 'h: location.href',
    'w: window.innerWidth', 'g: window.innerHeight',
  ];
  if (injectedExpression) fields.push(`i: !!(${injectedExpression})`);
  try {
    const r = await client.send('Runtime.evaluate', {
      expression: `JSON.stringify({${fields.join(', ')}})`, returnByValue: true,
    }, sessionId);
    let parsed = null;
    try { parsed = JSON.parse(r?.result?.value || 'null'); } catch { parsed = null; }
    if (!parsed) return null;
    const v = parsed.v;
    const vw = Number(parsed.w);
    const vh = Number(parsed.g);
    return {
      state: v === 'visible' ? 'visible' : v === 'hidden' ? 'hidden' : null,
      href: typeof parsed.h === 'string' && parsed.h ? parsed.h : null,
      injected: parsed.i === true,
      /* 视口尺寸：0 / 读不到就是 null（最小化、还没布局）—— 调用方据此丢弃鼠标事件，
       * 不要在 (0,0) 乱点，也不要拿上一张页的尺寸去点新页。 */
      vw: Number.isFinite(vw) && vw > 0 ? Math.round(vw) : null,
      vh: Number.isFinite(vh) && vh > 0 ? Math.round(vh) : null,
    };
  } catch {
    return null; // 页面正在导航 / 已经没了：这一轮当作读不到，不当作「隐藏」
  }
}

/**
 * 一个窗口的跟随器：轮询 → 维护「这个窗口里有哪些 page、谁是可见的」。
 *
 * 每个 target 一条**持久** attach（`sessionFor`），轮询时复用；target 消失才 detach。
 * 主窗口把这条 session 交给调用方去装 binding + 捕获脚本（`onPageAdded`），
 * 受控窗口直接用它投递 `Input`（`chosen.sessionId`）。
 */
export class PageFollower {
  /**
   * @param {object} opt
   * @param {object} opt.client CDP 客户端（`send` / `on`）
   * @param {string} [opt.label] 日志用（profile_id）
   * @param {number} [opt.intervalMs]
   * @param {string|null} [opt.injectedExpression] 主窗口传注入标记表达式，受控窗口不传
   * @param {(targetId: string, sessionId: string) => Promise<void>} [opt.onPageAdded]
   * @param {(targetId: string, page: object) => void} [opt.onPageRemoved]
   * @param {(next: object, prev: object|null) => Promise<void>|void} [opt.onChosen]
   * @param {() => void} [opt.onEmpty] 一张 page 都不剩
   */
  constructor({
    client, label = '', intervalMs = FOLLOW_INTERVAL_MS, injectedExpression = null,
    onPageAdded = null, onPageRemoved = null, onChosen = null, onEmpty = null,
  } = {}) {
    if (!client) throw new Error('PageFollower 需要一个 CDP 客户端');
    this.client = client;
    this.label = label;
    this.intervalMs = Math.max(100, Number(intervalMs) || FOLLOW_INTERVAL_MS);
    this.injectedExpression = injectedExpression;
    this.onPageAdded = onPageAdded;
    this.onPageRemoved = onPageRemoved;
    this.onChosen = onChosen;
    this.onEmpty = onEmpty;

    /** targetId → { targetId, sessionId, href, state, injected, vw, vh, alive } */
    this.pages = new Map();
    /** 这一轮选中的那张（`choosePage` 的返回值） */
    this.chosen = null;
    /** 前台可见的 target（不管它能不能同步）；读不到就是 null */
    this.visibleTargetId = null;
    this.visibleHref = null;
    this.visibleKnown = false;
    /* 事件驱动上报的「当前激活标签」（0.4.7.11 第二轮）。null = 还没收到任何上报，
     * 这时 `choosePage` 退回轮询口径（启动那一下必须能选出来）。 */
    this.activeTargetId = null;
    this.activationSeen = false;
    this.activationAt = 0;
    this.ticks = 0;
    this.errors = 0;
    this.timer = null;
    this.stopped = false;
    this.discoverOn = false;
    /** 上一轮刷新的时间（`deliveryTarget` 的缓存判据） */
    this.lastRefreshAt = 0;
    /** 选中时刻（status 里能看出「这个目标是什么时候定的」） */
    this.chosenAt = 0;
    /** 并发去重：同一个 tick 里多个事件同时要目标，只刷新一次 */
    this._refreshing = null;
    /** 投递目标的缓存（R2：≤500ms，任何 target 生命周期事件立刻失效） */
    this._delivery = null;
    this._deliveryAt = 0;

    /* 标签被关掉时**不能只等下一轮轮询**：用户关掉窗口最后一张标签，内核紧跟着就退出，
     * 连接先断，我们就只能报「连接已断开」，永远报不出「主窗口的标签全关了」。
     * 事件先到就先处理，轮询只做兜底。 */
    if (typeof this.client.on === 'function') {
      /* 新开一张标签：立刻装捕获（轮询 450ms 是兜底，但用户开完标签往往马上就打字，
       * 等半秒就可能丢掉头几个字符）。只在调用方已经准备好装捕获时才走这条快路，
       * 否则交给 `refreshOnce()` 同步入表 —— 两处都是「先查表再入表」，不会重复装。 */
      this.client.on('Target.targetCreated', (p) => {
        const t = p?.targetInfo;
        if (!t || t.type !== 'page' || this.stopped) return;
        /* 新 target 出现：投递缓存**立刻**失效（R2）。用户刚开了张新标签并切过去，
         * 缓存里那张旧页可能还在，但已经不该投了。 */
        this.invalidateDelivery();
        if (this.pages.has(t.targetId) || !this.onPageAdded) return;
        const page = {
          targetId: t.targetId, sessionId: null, href: t.url || '', state: null, injected: false,
          vw: null, vh: null, alive: true,
        };
        this.pages.set(t.targetId, page);
        this.sessionFor(t.targetId)
          .then((sid) => this.onPageAdded?.(t.targetId, sid))
          .catch(() => { this.errors += 1; });
      });
      this.client.on('Target.targetDestroyed', (p) => {
        const tid = p?.targetId;
        if (!tid) return;
        this.invalidateDelivery();
        if (this.activeTargetId === tid) this.clearActiveTarget(tid);
        if (!this.pages.has(tid)) return;
        const page = this.pages.get(tid);
        page.alive = false;
        this.pages.delete(tid);
        try { this.onPageRemoved?.(tid, page); } catch { /* ignore */ }
        this.rechooseNow();
      });
    }
  }

  /**
   * 页面自己上报「我变成可见了」（0.4.7.11 第二轮，事件驱动）。
   *
   * 只认 `visible`：`hidden` 不上报就不动作 —— 用户切走时，新那张会立刻报 `visible`，
   * 谁最后变可见谁就是当前激活标签。这样不会出现「旧的先报 hidden 把目标清空、
   * 新的还没报上来」的空窗（那半秒里事件会被记成 `skipped_no_target`）。
   *
   * @param {string} targetId
   * @param {string|null} [href] 页面自报的地址（`location.href`，比 targetInfo 更可信）
   * @returns {object|null} 新的 chosen
   */
  setActiveTarget(targetId, href = null) {
    if (!targetId || this.stopped) return null;
    if (!this.pages.has(targetId)) {
      /* 上报来自一张我们表里还没有的页（targetCreated 还没到）：等下一轮入表，
       * 但那一下不能丢 —— 记下来，入表后 `_refresh` 会按它选。 */
      this.activeTargetId = targetId;
      this.activationSeen = true;
      this.activationAt = Date.now();
      return this.chosen;
    }
    const changed = this.activeTargetId !== targetId;
    this.activeTargetId = targetId;
    this.activationSeen = true;
    this.activationAt = Date.now();
    const p = this.pages.get(targetId);
    if (p && href) p.href = href;
    if (!changed) return this.chosen;
    this.invalidateDelivery();
    return this.rechooseNow();
  }

  /** 激活的那张页没了：清掉事件信号，退回轮询口径（下一轮会重新选出可见那张） */
  clearActiveTarget(targetId = null) {
    if (targetId && this.activeTargetId && this.activeTargetId !== targetId) return;
    this.activeTargetId = null;
  }

  /** 用当前已知的 pages 立刻重选一次（事件驱动的快路径，不等下一轮轮询） */
  rechooseNow() {
    const pages = [...this.pages.values()].map((p) => ({ targetId: p.targetId, url: p.href }));
    const vis = new Map([...this.pages.values()].map((p) => [p.targetId, { state: p.state, href: p.href }]));
    const prev = this.chosen;
    const next = choosePage(pages, vis, { activeTargetId: this.activeTargetId });
    this.chosen = next;
    if (!this.pages.has(this.visibleTargetId)) {
      // 可见那张已经没了：新的可见性还不知道，先当「读不到」（闸门放行），下一轮轮询会修正
      this.visibleTargetId = null;
      this.visibleHref = null;
      this.visibleKnown = false;
    }
    if ((prev?.targetId || null) !== (next?.targetId || null)) {
      this.chosenAt = Date.now();
      this.invalidateDelivery();
      try {
        const r = this.onChosen?.(next, prev);
        if (r && typeof r.catch === 'function') r.catch(() => { this.errors += 1; });
      } catch { this.errors += 1; }
    }
    if (!this.pages.size) {
      try { this.onEmpty?.(); } catch { /* ignore */ }
    }
    return next;
  }

  /** 投递缓存失效（任何 target 生命周期事件都调它） */
  invalidateDelivery() {
    this._delivery = null;
    this._deliveryAt = 0;
    this.lastRefreshAt = 0;
  }

  /**
   * 受控窗口**当前该投给哪张页**（R2）。
   *
   * 为什么每次事件都要问一次：用户在主控窗口切标签的同时，受控窗口可能也切了标签。
   * 绑死启动时那张 → 用户看到的就是「点了没反应」（0.4.7.10 现场）。
   *
   * 缓存 ≤500ms（`maxAgeMs`）：一次 mousemove 风暴里不能每条都去 `getTargets` + N 次 evaluate，
   * 那会把内核压死、反而更不跟手。500ms 内的切换会晚半秒生效，这是规格允许的上限。
   * 任何 `targetCreated/targetDestroyed` 都会立刻失效缓存，不用等 500ms。
   *
   * @returns {Promise<null | {targetId, sessionId, url, vw, vh, visible, confident, source}>}
   *   返回 `null` = 解析不到（窗口里一张 page 都没有 / attach 不上）→ 调用方记 `skipped_no_target`
   */
  async deliveryTarget({ maxAgeMs = 500 } = {}) {
    if (this.stopped) return null;
    const now = Date.now();
    /* 严格小于：`maxAgeMs:0` 必须**永远**重新解析（判据用它模拟「缓存已过期」）。
     * 写成 `<=` 时同一毫秒内会命中缓存，判据偶发假红。 */
    if (this._delivery && now - this._deliveryAt < maxAgeMs) {
      // 缓存里那张页可能已经被关掉了（事件还没到）：入表校验一次，不在了就立刻重解
      const p = this.pages.get(this._delivery.targetId);
      if (p && p.sessionId) return this._delivery;
      this.invalidateDelivery();
    }
    /* 并发去重做在 `refreshOnce()` 里：同一 tick 里 N 条事件同时要目标，只刷一次。 */
    await this.refreshOnce().catch(() => null);
    const d = this.buildDelivery();
    this._delivery = d;
    this._deliveryAt = Date.now();
    return d;
  }

  /** 从当前已知的 pages 里算出投递目标（不刷新；`deliveryTarget` 刷新后调它） */
  buildDelivery() {
    const next = this.chosen;
    if (!next) return null;
    const p = this.pages.get(next.targetId);
    if (!p || !p.sessionId) return null;
    return {
      targetId: p.targetId,
      sessionId: p.sessionId,
      url: p.href || next.url || '',
      vw: p.vw || null,
      vh: p.vh || null,
      visible: p.state === 'visible' ? true : p.state === 'hidden' ? false : null,
      confident: next.confident === true,
      source: next.source || null,
      /** `'event'` = 页面自己上报的激活，`'poll'` = 主进程轮询读到的（status 里能分清） */
      signal: next.signal || null,
    };
  }

  /** 拿（必要时建立）某个 target 的持久会话 —— 别每次轮询都 attach/detach */
  async sessionFor(targetId) {
    const p = this.pages.get(targetId);
    if (!p) return null;
    if (p.sessionId) return p.sessionId;
    const { sessionId } = await this.client.send('Target.attachToTarget', { targetId, flatten: true });
    p.sessionId = sessionId;
    return sessionId;
  }

  /**
   * 作废某个 target 的会话（投递/验证发现「会话已死」时调）。
   *
   * 为什么要显式作废：target 还在（targetDestroyed 不会来）但渲染器已经被换掉/挂起时，
   * 缓存里的 sessionId 已经是死的 —— 继续用它，每条命令都报
   * 「Session with given id not found」，而且永远不会自愈（没人再 attach 一次）。
   * 置空之后，下一次 `sessionFor()` 会重新 attach，拿到新会话。
   * `state` 也一起清：新渲染器要重新读可见性，别拿旧读数选目标。
   */
  invalidateSession(targetId) {
    const p = this.pages.get(targetId);
    if (!p) return false;
    const had = !!p.sessionId;
    p.sessionId = null;
    p.state = null;
    p.vw = null;
    p.vh = null;
    if (had) this.invalidateDelivery();
    return had;
  }

  /**
   * 轮询一次：同步 target 表 → 读可见性 → 选目标 → 触发回调。
   *
   * **并发去重**：定时轮询和 `deliveryTarget()`（每条事件都可能调）会同时进来。
   * 两次并发 refresh 会各自给同一张新页 `onPageAdded` → 同一页装两份捕获 →
   * 一条真实输入转发两次。所以这里共享同一个 in-flight promise。
   */
  async refreshOnce() {
    if (this._refreshing) return this._refreshing;
    this._refreshing = this._refresh().finally(() => { this._refreshing = null; });
    return this._refreshing;
  }

  async _refresh() {
    if (!this.discoverOn && typeof this.client.on === 'function') {
      /* 只为了收 `Target.targetDestroyed`（标签一关就立刻知道，不等下一轮）。
       * 订阅两次是幂等的；`tabs.js` 的标签登记也用这条命令，互不影响。 */
      this.discoverOn = true;
      this.client.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
    }
    const r = await this.client.send('Target.getTargets');
    const list = (r?.targetInfos || []).filter((t) => t && t.type === 'page');
    const seen = new Set(list.map((t) => t.targetId));

    for (const [id, p] of [...this.pages]) {
      if (seen.has(id)) continue;
      p.alive = false;
      this.pages.delete(id);
      if (this.activeTargetId === id) this.clearActiveTarget(id);
      try { this.onPageRemoved?.(id, p); } catch { /* 回调不许把轮询打断 */ }
      if (p.sessionId) this.client.send('Target.detachFromTarget', { sessionId: p.sessionId }).catch(() => {});
    }

    for (const t of list) {
      if (this.pages.has(t.targetId)) continue;
      const p = {
        targetId: t.targetId, sessionId: null, href: t.url || '', state: null, injected: false,
        vw: null, vh: null, alive: true,
      };
      this.pages.set(t.targetId, p);
      try {
        const sid = await this.sessionFor(t.targetId);
        /* 只通知一次：重复调 `Page.addScriptToEvaluateOnNewDocument` 会让同一个页面装两份捕获脚本，
         * 一条真实输入变成两条转发 —— 比「这一页没装上」更糟。装不上就等下一次导航补。 */
        await this.onPageAdded?.(t.targetId, sid);
      } catch {
        this.errors += 1;
      }
    }

    for (const p of this.pages.values()) {
      if (!p.sessionId) {
        try { p.sessionId = await this.sessionFor(p.targetId); } catch { this.errors += 1; }
      }
      const st = await readPageState(this.client, p.sessionId, { injectedExpression: this.injectedExpression });
      if (!st) { p.state = null; p.vw = null; p.vh = null; continue; }
      p.state = st.state;
      p.injected = st.injected === true;
      if (st.href) p.href = st.href;
      // 视口每轮都刷新：用户改了窗口大小之后，1:1 坐标的越界判据要跟着变
      p.vw = st.vw;
      p.vh = st.vh;
    }

    const pages = [...this.pages.values()].map((p) => ({ targetId: p.targetId, url: p.href }));
    const vis = new Map([...this.pages.values()].map((p) => [p.targetId, { state: p.state, href: p.href }]));
    const prev = this.chosen;
    const next = choosePage(pages, vis, { activeTargetId: this.activeTargetId });
    this.chosen = next;
    this.visibleTargetId = next?.visible_target_id || null;
    this.visibleKnown = Boolean(this.visibleTargetId);
    const visPage = this.visibleTargetId ? this.pages.get(this.visibleTargetId) : null;
    this.visibleHref = visPage?.href || null;
    this.ticks += 1;
    this.lastRefreshAt = Date.now();

    const changed = (prev?.targetId || null) !== (next?.targetId || null);
    if (changed) {
      this.chosenAt = this.lastRefreshAt;
      // 目标换了：投递缓存立刻失效，下一个事件必须打到新页上（R2）
      this.invalidateDelivery();
      try { await this.onChosen?.(next, prev); } catch { this.errors += 1; }
    } else if (!this.chosenAt && next) {
      this.chosenAt = this.lastRefreshAt;
    }
    /* 这一轮刚读到的新鲜数据顺手填进投递缓存（R2 的 ≤500ms 缓存）。
     * 不填的话，每条事件都会因为「缓存过期」再触发一次 refresh → 8 个受控窗口时
     * 每秒几百次 getTargets + evaluate，把内核压死（实测就是这样「转发间歇停止」的）。
     * 定时轮询 450ms + 缓存 500ms 配对，事件路径基本总是命中缓存。 */
    if (this.pages.size) {
      const d = this.buildDelivery();
      if (d) { this._delivery = d; this._deliveryAt = this.lastRefreshAt; }
    }
    if (!this.pages.size) {
      try { this.onEmpty?.(); } catch { /* ignore */ }
    }
    return next;
  }

  /** 后台轮询（`unref`：不拖住进程退出） */
  start() {
    if (this.stopped || this.timer) return this;
    const tick = async () => {
      if (this.stopped) return;
      try { await this.refreshOnce(); } catch { this.errors += 1; }
      if (this.stopped) return;
      this.timer = setTimeout(tick, this.intervalMs);
      this.timer.unref?.();
    };
    this.timer = setTimeout(tick, this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  /** 停下并摘掉我们自己 attach 的会话 */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    for (const p of this.pages.values()) {
      if (!p.sessionId) continue;
      this.client.send('Target.detachFromTarget', { sessionId: p.sessionId }).catch(() => {});
      p.sessionId = null;
    }
    this.pages.clear();
    this.chosen = null;
    this.activeTargetId = null;
    this._delivery = null;
    this._deliveryAt = 0;
  }

  /** 这个 target 还在不在（status 用） */
  aliveOf(targetId) {
    return this.pages.has(targetId);
  }
}
