/**
 * 窗口同步 · 实时会话：开始 / 停止 / 重启 / 状态 / 自检 / 改设置（从 session.js 拆出，行为不变）。
 * 捕获（主控页 JS + iframe）→ 投递（Win32 / CDP）的整条链都在 startSync 里。
 */
import crypto from 'node:crypto';
import { getInstance, getRunning, logProfile } from '../runtime/manager.js';
import { installedExpression, markerNames } from '../kernel/markers.js';
import { buildActivationScript, buildCaptureScript } from './agent-script.js';
import { newBindingName } from './binding.js';
import { buildSyncPlan, enabledBySwitch, mapPointStatus } from './replay.js';
import { makeTextResolver, textOf } from './text-input.js';
import { SyncScheduler, makeRng } from './scheduler.js';
import { WinInput, toWinCommand } from './win-input.js';
import { FOLLOW_INTERVAL_MS, PageFollower, isSessionDeadError, pageKind, staleHint } from './follow.js';
import { DEFAULT_SETTINGS, normalizeSettings } from './settings.js';
import { PROBE_BOOL_EXPR, PROBE_OFF_EXPR, PROBE_READ_EXPR, connectInstance, masterBlockReason, sleep, viewportOf, windowSizeOf } from './session-cdp.js';
import { state } from './session-state.js';
import { TabMirror } from './tab-mirror.js';

/* ------------------------------ 启动 / 停止 ------------------------------ */

/**
 * 开始同步。
 * @param {{masterId: string, slaveIds: string[], settings?: object, rngSeed?: number}} opt
 */
export async function startSync({ masterId, slaveIds = [], settings = {}, rngSeed = null } = {}) {
  if (state.current) throw new Error('已经有一个同步会话在跑，先停止它');

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
  /**
   * 投递链防陈旧（本轮）：探活节流窗口 + 单条命令超时。
   *
   * 为什么需要探活：真内核三轮复现（2026-11-22）——受控窗口被主控完全遮挡、部分越出屏幕时，
   * Chrome 会冻结/丢弃后台渲染器；对这样的页 `Input.dispatchMouseEvent` **被接受且不抛错**
   * （scheduler errors 恒为 0），页面就是不执行。唯一可靠的判定是「主动问页面一句」：
   * evaluate 一条常量，答得上来 = 渲染器活着，答不上来/超时 = 陈旧，走唤醒与重连。
   *
   * 为什么节流 1500ms：真实 mousemove 一秒几百条，不能每条都多一个 RTT；
   * 1.5s 内复用上一次「活着」的结论，超窗后下一条事件再验一次。
   */
  const DELIVERY_VERIFY_THROTTLE_MS = 1500;
  const DELIVERY_VERIFY_TIMEOUT_MS = 1200;

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

  /* --------------------- 投递链防陈旧：探活 → 唤醒 → 重连（本轮） --------------------- */

  /**
   * 带 timeout 的 CDP 命令：`CdpClient.send` 本身没有超时，页面真挂起时会永远不回，
   * 把这个窗口的投递队列整个拖死。超时放弃后 send 自己的结局不再关心（吞掉防 unhandled）。
   */
  function cdpWithTimeout(client, method, params, sessionId, timeoutMs) {
    let timer = null;
    const tracked = client.send(method, params, sessionId);
    tracked.catch(() => {});
    return Promise.race([
      tracked,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${method} 超时（${timeoutMs}ms，页面疑似挂起）`)), timeoutMs);
      }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
  }

  /**
   * 受控页探活（节流）：向当前投递会话 evaluate 一条常量。
   *
   * 「Chrome 不抛错但页面不处理」没有别的判定途径 —— Input 派发被接受只说明 CDP 通道通，
   * 不说明渲染器会消费。答得上来 = 活着；报会话死错 / 超时 = 陈旧。
   * 成功结论缓存 1500ms（失败不缓存：下一批事件立刻再验）。
   */
  async function verifySlaveAlive(t) {
    if (!t?.client || !t.sessionId) return false;
    const now = Date.now();
    if (t.verified === true && now - (t.last_verify_ms || 0) < DELIVERY_VERIFY_THROTTLE_MS) return true;
    t.last_verify_ms = now;
    try {
      await cdpWithTimeout(t.client, 'Runtime.evaluate', { expression: '1', returnByValue: true },
        t.sessionId, DELIVERY_VERIFY_TIMEOUT_MS);
      t.verified = true;
      return true;
    } catch {
      t.verified = false;
      return false;
    }
  }

  /**
   * 唤醒冻结/被丢弃的页（规格原文的 `Page.setWebLifecycleState active` 或等效手段），
   * 然后立刻再探活一次。唤醒不算修复 —— 它只是给页面一次「活过来」的机会，
   * 活没活过来以探活为准，两次都计进 `delivery_wake` 的口径见 statusOf 注释。
   */
  async function wakeSlave(t) {
    if (!t?.client || !t.sessionId) return false;
    try {
      await t.client.send('Page.enable', {}, t.sessionId).catch(() => {});
      await cdpWithTimeout(t.client, 'Page.setWebLifecycleState', { state: 'active' },
        t.sessionId, DELIVERY_VERIFY_TIMEOUT_MS);
    } catch {
      return false;
    }
    t.delivery_wake = (t.delivery_wake || 0) + 1;
    t.last_verify_ms = 0;
    return verifySlaveAlive(t);
  }

  /**
   * 作废死会话并重连：让跟随器丢掉旧 sessionId，强制重新解析投递目标（重新 attach）。
   * 目标解析不到（标签全关）返回 null，调用方计 `delivery_fail`。
   */
  async function rebuildSlaveDelivery(t, id) {
    const f = t.follower;
    if (!f) return null;
    f.invalidateSession(t.targetId);
    t.delivery_retry = (t.delivery_retry || 0) + 1;
    let dt = null;
    try { dt = await f.deliveryTarget({ maxAgeMs: 0 }); } catch { dt = null; }
    if (!dt || !dt.sessionId) return null;
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
    await focusEmulate(t);
    if (prevSid && prevSid !== dt.sessionId) await unfocusEmulate(t.client, prevSid);
    logProfile(id, '同步目标跟随',
      `会话=${session.id.slice(0, 8)} 投递会话已作废并重连 ${String(before || '?').slice(0, 90)} → `
      + `${String(dt.url || '?').slice(0, 90)} target=${dt.targetId} `
      + `视口=${t.viewport ? `${t.viewport.vw}x${t.viewport.vh}` : '读不到'}`);
    return t;
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

  /** 打开了随机数字 / 模拟人工 / 关相同文本时，Win32 只发按键不带字符 */
  function rawKeysMode() {
    const st2 = session.settings;
    return !st2.text_sync || st2.random_number || st2.typing;
  }

  /** Win32 句柄与几何（按浏览器 pid 找主窗口，2s 缓存；chromeTop 从页面量，给没有渲染子窗口的新版 Chrome 兜底） */
  async function winGeom(id, t) {
    const now = Date.now();
    if (t.win && now - t.win.at < 2000 && t.win.hwnd) return t.win;
    const inst = getInstance(id);
    if (!inst?.pid) return null;
    const r = await session.win.findWindow(inst.pid);
    if (!r?.ok) { t.win = null; t.win_last_reason = r?.reason || 'find_failed'; return null; }
    let top = null; let vw = r.vw; let vh = r.vh;
    if (t.sessionId) {
      try {
        const { result } = await cdpWithTimeout(t.client, 'Runtime.evaluate', {
          expression: '[window.outerHeight-window.innerHeight-(window.outerWidth-window.innerWidth)/2,innerWidth,innerHeight]',
          returnByValue: true,
        }, t.sessionId, 800);
        if (Array.isArray(result?.value)) [top, vw, vh] = [Math.max(0, result.value[0]), result.value[1], result.value[2]];
      } catch { /* 页面忙：用 helper 自己量的 */ }
    }
    t.win = { hwnd: r.hwnd, top, vw, vh, at: now };
    return t.win;
  }

  /** 一条事件经 Win32 投出去。false = 这次没投成，调用方退回 CDP */
  async function winDeliver(id, t, ev) {
    const g = await winGeom(id, t).catch(() => null);
    if (!g) return false;
    const cmd = toWinCommand(ev, g.hwnd, { rawKeysOnly: rawKeysMode() });
    if (!cmd) return false;
    if (g.top !== null) Object.assign(cmd, { top: g.top, vw: g.vw, vh: g.vh });
    scheduler.push(id, async () => {
      const r = await session.win.call(cmd);
      if (r?.ok) { t.win_ok = (t.win_ok || 0) + 1; return; }
      /* 0.4.7.14：Win32 判越界/失败**不再吞掉**，计数后把这条改走 CDP（同一队列，顺序不乱）。
       * 9 窗口实测：指纹页面 3170×1800、真实窗口 1146×464，Win32 63/64 越界，用户看到的就是「全不动」。 */
      if (r?.reason === 'out_of_view') t.win_oob = (t.win_oob || 0) + 1;
      else { t.win_fail = (t.win_fail || 0) + 1; t.win_last_reason = r?.reason || '?'; }
      try {
        const plan = buildSyncPlan(ev, t.viewport, session.settings, null, textRng);
        for (const call of plan) await t.client.send(call.method, call.params, t.sessionId);
        t.delivery_via = 'cdp';
      } catch { /* CDP 也失败：下一条事件会走正常路径的探活/重连 */ }
      if (r?.reason === 'out_of_view') return;
      t.win_last_reason = r?.reason || '?';
      if (r?.reason === 'window_gone') t.win = null;
      if (r?.reason === 'window_minimized') degraded.set(id, '受控窗口已最小化（Win32 投递跳过）');
    });
    t.delivery_ok = true;
    t.delivery_via = 'win32';
    return true;
  }

  /** 主窗口一张标签装捕获：binding + 新文档脚本 + 当前文档立刻跑一遍 */
  async function instrumentMasterPage(targetId, sessionId) {
    if (!targetId || !sessionId) return;
    /* 必须先登记：instrumentSession 里的 setAutoAttach 会**立刻**为已存在的跨进程 iframe 发
     * attachedToTarget，那时 rootTargetOf(父会话) 还查不到就会被当成「别人的」放走（D3 实测红）。 */
    masterPages.set(targetId, sessionId);
    masterSessionToTarget.set(sessionId, targetId);
    await instrumentSession(sessionId);
  }

  /** 一个 CDP 会话（page 或 OOPIF）装捕获，并对它的跨进程子帧开 auto-attach */
  async function instrumentSession(sessionId) {
    await masterClient.send('Page.enable', {}, sessionId).catch(() => {});
    await masterClient.send('Runtime.enable', {}, sessionId).catch(() => {});
    await masterClient.send('Runtime.addBinding', { name: bindingName }, sessionId);
    // 新文档：脚本自己轮询等 binding；主进程在 frameNavigated 时补装
    await masterClient.send('Page.addScriptToEvaluateOnNewDocument', { source: captureSource }, sessionId);
    // 当前文档：直接跑一遍（新文档脚本只对「下一个文档」生效）
    await masterClient.send('Runtime.evaluate', { expression: captureSource }, sessionId).catch(() => {});
    /* 已经加载好的同源子帧：新文档脚本对它们不生效（只管「下一个文档」），这里递归 eval 一遍。
     * 跨源子帧 eval 会抛错被吞掉 —— 同进程跨源帧拿不到；跨进程的由下面 auto-attach 管。 */
    await masterClient.send('Runtime.evaluate', {
      expression: `(function inj(w,src){for(var i=0;i<w.frames.length;i++){try{var f=w.frames[i];f.eval(src);inj(f,src);}catch(e){}}})(window,${JSON.stringify(captureSource)})`,
    }, sessionId).catch(() => {});
    await masterClient.send('DOM.enable', {}, sessionId).catch(() => {});
    /* 跨进程 iframe（登录框/钱包/验证码常见）是独立 target，页面里的监听器抓不到它。
     * waitForDebuggerOnStart：子帧先停住，装完捕获再放行 —— 否则首屏的输入会丢。 */
    await masterClient.send('Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId).catch(() => {});
  }

  /* OOPIF 会话：sessionId → { frameId(=targetId), parentSid } */
  const frameSessions = new Map();
  /* 偏移缓存：sessionId → { x, y, at }（滚动会改变 iframe 位置，100ms 过期） */
  const frameOffsets = new Map();

  /** 事件所在会话 → 它属于主窗口哪张标签（page targetId） */
  function rootTargetOf(sid) {
    let cur = sid;
    for (let i = 0; i < 16 && cur; i++) {
      const tid = masterSessionToTarget.get(cur);
      if (tid) return tid;
      cur = frameSessions.get(cur)?.parentSid;
    }
    return null;
  }

  /** OOPIF 会话坐标 → 根页面视口坐标所需的累计偏移（拿不到返回 null，事件丢弃） */
  async function frameOffsetOf(sid) {
    let x = 0; let y = 0; let cur = sid;
    for (let i = 0; i < 16; i++) {
      const fr = frameSessions.get(cur);
      if (!fr) return { x, y };                // 到 page 了
      const hit = frameOffsets.get(cur);
      if (hit && Date.now() - hit.at < 100) { x += hit.x; y += hit.y; cur = fr.parentSid; continue; }
      try {
        const { backendNodeId } = await masterClient.send('DOM.getFrameOwner', { frameId: fr.frameId }, fr.parentSid);
        const { model } = await masterClient.send('DOM.getBoxModel', { backendNodeId }, fr.parentSid);
        const q = model?.content;              // [x1,y1,x2,y2,...]，相对父会话视口
        if (!q) return null;
        frameOffsets.set(cur, { x: q[0], y: q[1], at: Date.now() });
        x += q[0]; y += q[1];
      } catch { return null; }
      cur = fr.parentSid;
    }
    return null;
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
    /* 0.4.7.14：主控切了标签，受控也切到对应那张（只对镜像过的标签有效，见 tab-mirror.js） */
    try { session.mirror?.onMasterActivated(next.targetId); } catch { /* ignore */ }
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
  /** 结束日志用：每个受控窗口最后走的路径 + win32 成败 + 越界，例：cdp×8 / win32×0(ok=0,fail=0,越界=0) */
  function deliverySummary() {
    let cdp = 0; let win = 0; let wok = 0; let wfail = 0; let oob = 0;
    for (const id of session.slaves) {
      const t = targets.get(id);
      if (!t) continue;
      if (t.delivery_via === 'win32') win += 1; else cdp += 1;
      wok += Number(t.win_ok) || 0; wfail += Number(t.win_fail) || 0; oob += Number(t.dropped_out_of_view) || 0;
    }
    return `cdp×${cdp}/win32×${win}(ok=${wok},fail=${wfail},越界=${oob})`;
  }

  async function finishSession({ reason, message, abnormal = false, removeBinding = true } = {}) {
    if (session.stopped) return { running: false, teardown: state.lastTeardown };
    session.stopped = true;
    session.end_reason = reason;
    session.end_message = message;
    scheduler.stop();
    try { session.win?.stop(); } catch { /* ignore */ }
    try { session.mirror?.stop(); } catch { /* ignore */ }
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
    state.lastTeardown = teardown;
    state.lastEnd = {
      reason, message: message || null, at: teardown.at, session_id: session.id,
      events: session.events, forwarded: session.forwarded,
    };

    /* 投递链防陈旧的聚合读数（结束日志）：用户报「同步时好时坏」时，
     * wake/retry/fail 三个数能直接看出投递链路在会话期间对抗过多少次陈旧目标。 */
    let wakeSum = 0; let retrySum = 0; let failSum = 0;
    for (const [, t] of targets) {
      wakeSum += Number(t.delivery_wake) || 0;
      retrySum += Number(t.delivery_retry) || 0;
      failSum += Number(t.delivery_fail) || 0;
    }

    logProfile(master, abnormal ? '同步异常结束' : '同步结束',
      `会话=${session.id.slice(0, 8)} 事件=${session.events} 转发=${session.forwarded} `
      + `开关拦下=${session.dropped} 闸门拦下=${session.gated || 0} `
      + `文本发出=${session.text_sent} 文本被吞=${session.text_swallowed} `
      + `唤醒=${wakeSum} 重连=${retrySum} 投递失败=${failSum} `
      + `越界丢弃=${session.dropped_out_of_view || 0} 投递路径=${deliverySummary()} `
      + `标签同步=${session.mirror ? JSON.stringify(session.mirror.status()) : '未启用'} `
      + `原因=${reason}${message ? `（${message}）` : ''} `
      + `teardown=${teardown.removed ? 'binding 已摘' : `binding 未摘（${teardown.error || '未知原因'}）`}`);

    for (const [, t] of targets) {
      try { t.client.close(); } catch { /* ignore */ }
    }
    targets.clear();
    if (state.current === session) state.current = null;
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
    /* 跨进程 iframe 自动挂上：装捕获 → 放行 */
    masterClient.on('Target.attachedToTarget', async (params, parentSid) => {
      const sid = params?.sessionId;
      const info = params?.targetInfo;
      if (!sid || !info) return;
      if (info.type !== 'iframe' || !rootTargetOf(parentSid)) {
        if (params.waitingForDebugger) masterClient.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
        return;
      }
      frameSessions.set(sid, { frameId: info.targetId, parentSid });
      try { await instrumentSession(sid); } catch { /* 装不上也必须放行，否则 iframe 卡死 */ }
      masterClient.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
    });
    masterClient.on('Target.detachedFromTarget', (params) => {
      frameSessions.delete(params?.sessionId);
      frameOffsets.delete(params?.sessionId);
    });

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
      const targetId = rootTargetOf(sid);
      if (!targetId) return;
      // 子帧导航同样要补 binding（第 2 步起子帧也装了捕获），但不重读视口
      // binding 不跨文档存活（实测）：新文档要补装一次，脚本的轮询会把它抓走并 delete
      m.client.send('Runtime.addBinding', { name: bindingName }, sid).catch(() => {});
      if (params?.frame?.parentId || frameSessions.has(sid)) return;
      if (targets.get(master)?.targetId === targetId) refreshViewport(master).catch(() => {});
    });

    /* 受控窗口：连上、摸清标签、按可见选一张去投递 */
    /* 第 3 步：Win32 投递端。settings.deliver = 'cdp' 时关闭；起不来自动退回 CDP。 */
    if (session.settings.deliver !== 'cdp' && process.platform === 'win32') {
      const wi = new WinInput();
      if (await wi.start()) session.win = wi;
      else logProfile(master, 'WARN 同步投递端', `Win32 投递端不可用（${wi.error || '?'}），退回 CDP 投递`);
    }

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
        /* 投递链防陈旧计数（本轮）：wake=唤醒过几次冻结/挂起页，retry=死会话重连过几次，
         * fail=最终放弃的批次数。errors=0 而页面没动的盲区由这三个数堵上。 */
        delivery_wake: 0, delivery_retry: 0, delivery_fail: 0,
        /** 探活缓存：verified=true 且距上次验证 <1500ms 时直接复用结论 */
        verified: null, last_verify_ms: 0,
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
      const targetId = rootTargetOf(sid);
      if (!targetId) return; // 不是我们装过捕获的页（比如别的客户端 attach 的）
      let payload = null;
      try { payload = JSON.parse(params.payload); } catch { return; }
      const list = Array.isArray(payload?.e) ? payload.e : [];
      /* 来自 OOPIF：坐标补上 iframe 在根页面里的偏移（键盘/文本没坐标，不受影响） */
      if (frameSessions.has(sid)) {
        const off = await frameOffsetOf(sid);
        for (const ev of list) {
          if (typeof ev?.x !== 'number') continue;
          if (!off) { ev.x = NaN; ev.y = NaN; continue; } // 偏移拿不到 → 让 mapPoint 判 bad_input 丢弃
          ev.x += off.x; ev.y += off.y;
        }
      }
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

          /* 第 3 步：能走 Win32 就走 —— 投给窗口，由浏览器自己路由到前台标签/iframe。
           * 文本策略类与粘贴、输入法文本仍走下面的 CDP 路径。 */
          if (session.win?.available() && toWinCommand(ev, 1)) {
            if (await winDeliver(id, t, ev)) {
              delivered = true;
              if (ev.t === 'key' && ev.text && ev.down && !rawKeysMode()) textEmitted = true;
              continue;
            }
          }

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
            /* 投递前探活（节流 1500ms）：Input 派发对冻结/被丢弃的页「被接受且不抛错」，
             * errors 恒为 0 —— 唯一可靠的判定是主动问页面一句。陈旧 → 唤醒 → 仍陈旧 →
             * 作废会话重连重试一次 → 再失败记 delivery_fail 并降级提示，绝不静默。 */
            let liveOk = await verifySlaveAlive(t);
            if (!liveOk) {
              liveOk = await wakeSlave(t);
              if (!liveOk) {
                const rebuilt = await rebuildSlaveDelivery(t, id);
                if (rebuilt) liveOk = await verifySlaveAlive(t);
              }
              if (!liveOk) {
                t.delivery_fail = (t.delivery_fail || 0) + 1;
                degraded.set(id, '受控页唤醒失败（页面可能已冻结、被丢弃或正在关闭），这一批输入已跳过');
                logProfile(id, 'WARN 同步投递失败',
                  `会话=${session.id.slice(0, 8)} 受控页探活失败：唤醒后仍无响应、会话重连后仍无响应，`
                  + `丢弃 plan=${plan.length} 条 累计 fail=${t.delivery_fail} wake=${t.delivery_wake} retry=${t.delivery_retry}`);
                return;
              }
            }
            for (const call of plan) {
              // waitMs 是「发这一条之前等多久」：逐字投递的字符间隔在这里落地
              if (call.waitMs) await sleep(call.waitMs);
              // 读 t.sessionId（不是快照）：排队期间用户可能又切了标签，要投到新页上
              try {
                await t.client.send(call.method, call.params, t.sessionId);
              } catch (e) {
                if (!isSessionDeadError(e)) throw e;
                /* 派发中途会话死了（渲染器被换掉/页面正在关闭）：作废重连，这一条重试一次 */
                const rebuilt = await rebuildSlaveDelivery(t, id);
                if (!rebuilt) {
                  t.delivery_fail = (t.delivery_fail || 0) + 1;
                  degraded.set(id, '投递会话被销毁且没能重连（页面可能正在关闭），这一批输入已跳过');
                  logProfile(id, 'WARN 同步投递失败',
                    `会话=${session.id.slice(0, 8)} 投递会话被销毁且重连失败，`
                    + `丢弃 plan=${plan.length} 条 累计 fail=${t.delivery_fail}`);
                  return;
                }
                await t.client.send(call.method, call.params, t.sessionId);
              }
            }
          });
          t.delivery_ok = true;
          t.delivery_via = 'cdp';
          t.delivery_target_url = dt.url || t.targetUrl || null;
          bumpTarget(t.targetId);
          delivered = true;
          /* 探活/唤醒成功后清掉「唤醒失败」那句降级：恢复要可见，不能停在旧读数上 */
          if (typeof degraded.get(id) === 'string' && degraded.get(id).includes('唤醒失败')) degraded.delete(id);
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
    try { session.win?.stop(); } catch { /* ignore */ }
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

  /* 0.4.7.14 标签镜像：主控新开标签 / 打开链接 / 切标签 / 关标签 → 受控跟着做（见 tab-mirror.js）。
   * 只看 CDP target 事件，不依赖页面捕获 —— 地址栏、「+」、Ctrl+T、标签栏的操作页面 JS 根本看不到。 */
  try {
    const mirror = new TabMirror({
      masterClient,
      masterId: master,
      slaves: () => session.slaves.filter((id) => targets.has(id)),
      slaveClient: (id) => targets.get(id)?.client || null,
      settings: () => session.settings,
    });
    const seedSlaves = new Map();
    for (const id of session.slaves) { const t = targets.get(id); if (t) seedSlaves.set(id, t.targetId); }
    const mt0 = targets.get(master);
    if (mt0?.targetId) mirror.seed(mt0.targetId, seedSlaves);
    masterClient.on('Target.targetCreated', (p) => {
      const t = p?.targetInfo;
      if (t?.type === 'page' && !t.url?.startsWith('devtools://')) mirror.onMasterTabAdded(t.targetId);
    });
    masterClient.on('Target.targetDestroyed', (p) => { if (p?.targetId) mirror.onMasterTabRemoved(p.targetId); });
    /* 主帧导航：targetInfoChanged 在 URL 变了时触发，不需要 attach（新开但还没装捕获的标签也能看到） */
    const lastUrl = new Map();
    masterClient.on('Target.targetInfoChanged', (p) => {
      const t = p?.targetInfo;
      if (!t || t.type !== 'page') return;
      if (lastUrl.get(t.targetId) === t.url) return;
      lastUrl.set(t.targetId, t.url);
      mirror.onMasterNavigated(t.targetId, t.url);
    });
    session.mirror = mirror;
  } catch (e) {
    logProfile(master, 'WARN 标签同步', `没能启用：${e?.message || e}`);
  }

  session.status = () => statusOf(session);
  state.current = session;
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
      /* 第 3 步：走的哪条投递路径 + Win32 成功/失败计数与最后失败原因 */
      delivery_via: t.delivery_via || 'cdp',
      win_ok: Number(t.win_ok) || 0,
      win_fail: Number(t.win_fail) || 0,
      win_last_reason: t.win_last_reason || null,
      delivery_ok: t.delivery_ok === true ? true : t.delivery_ok === false ? false : null,
      skipped_no_target: Number(t.skipped_no_target) || 0,
      dropped_out_of_view: Number(t.dropped_out_of_view) || 0,
      /* 投递链防陈旧（本轮）：wake=对冻结/挂起页唤醒的次数，retry=死会话作废重连的次数，
       * fail=最终放弃的批次。三者全 0 且 delivery_ok=true 才是干净的投递；
       * fail>0 时 status.hint/degraded 会有人话，不许再出现「errors=0 而页面没动」的盲区。 */
      delivery_wake: Number(t.delivery_wake) || 0,
      delivery_retry: Number(t.delivery_retry) || 0,
      delivery_fail: Number(t.delivery_fail) || 0,
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
    /** 0.4.7.14 标签镜像读数：新开/认领/跳转/切换/关闭 计数与最后一次错误 */
    tab_sync: session.mirror ? session.mirror.status() : null,
    abnormal: session.abnormal || null,
    end_reason: session.end_reason || null,
    end_message: session.end_message || null,
    scheduler: session.scheduler.stats(),
    windows,
    size_mismatch: sizeMismatch,
    last_teardown: state.lastTeardown,
    last_end: state.lastEnd,
  };
  /* 人话提示：`running=true` 但抓不到输入时，界面不能沉默（用户报「没反应」时最难查的就是这个） */
  out.hint = staleHint(out);
  return out;
}

/** 没在跑时给界面一个稳定的形状（不要返回 null，界面就不用到处判空） */
export function syncStatus() {
  if (!state.current) {
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
      delivery_wake: 0,
      delivery_retry: 0,
      delivery_fail: 0,
      capture_reinstalled: 0,
      last_event_at: null,
      last_teardown: state.lastTeardown,
      last_end: state.lastEnd,
      hint: null,
      stale_ms: 0,
    };
  }
  return state.current.status();
}

export async function stopSync() {
  if (!state.current) return { running: false, teardown: state.lastTeardown };
  await state.current.stop();
  return { running: false, teardown: state.lastTeardown };
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
  if (!state.current) throw new Error('没有正在运行的同步会话，先开始同步');
  const masterId = state.current.master;
  const slaveIds = [...state.current.slaves];
  const keep = settings && typeof settings === 'object'
    ? normalizeSettings({ ...state.current.settings, ...settings })
    : state.current.settings;

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
  if (!state.current) return false;
  if (state.current.master !== profileId && !state.current.slaves.includes(profileId)) return false;
  await stopSync();
  return true;
}

/** 改设置：四个开关与延迟可以运行中改，不用重开会话 */
export function updateSettings(raw) {
  if (!state.current) throw new Error('没有正在运行的同步会话');
  const st = normalizeSettings({ ...state.current.settings, ...raw });
  state.current.settings = st;
  state.current.scheduler.delayMs = st.delay_ms;
  state.current.scheduler.jitterMs = st.jitter_ms;
  return st;
}
