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
import { getInstance, getRunning } from '../runtime/manager.js';
import { buildCaptureScript } from './agent-script.js';
import { newBindingName } from './binding.js';
import { buildSyncPlan, enabledBySwitch } from './replay.js';
import { makeTextResolver, textOf } from './text-input.js';
import { SyncScheduler, makeRng } from './scheduler.js';
import {
  closeTabAt, isBlankUrl, listTabs, navigateAt, normalizeUrl, openTabFor,
  planCloseBlank, planCloseOthers, planUnify, settle, targetIndex, visibleTabIndex,
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

export function getTeardown() {
  return lastTeardown;
}

export function getSession() {
  return current;
}

/** 默认设置：键鼠四开关全开、无延迟；文本三个开关按对手面板的默认（相同文本/粘贴开，人工输入/随机数字关） */
export const DEFAULT_SETTINGS = Object.freeze({
  input: true,
  click: true,
  scroll: true,
  move: true,
  /* ---- 文本输入：四个开关互相独立，别合并（语义见 text-input.js） ---- */
  text_sync: true,        // 相同文本输入
  typing: false,          // 模拟人工输入（逐字 + 随机间隔）
  paste: true,            // 粘贴同步
  random_number: false,   // 随机数字输入（每窗口各自一个数，替换原文）
  typing_min_ms: 30,
  typing_max_ms: 120,
  random_min: 1000,
  random_max: 9999,
  /* ---- 标签页：两个开关独立（same_tab 管「动哪个」，target_blank 管「怎么开」） ---- */
  same_tab: true,         // 相同标签页：按序号对应主窗口的那个标签
  target_blank: true,     // 目标空白：新开标签先开空白页再导航
  delay_ms: 0,
  jitter_ms: 0,
});

export function normalizeSettings(raw = {}) {
  const bool = (v, dflt) => (v === undefined ? dflt : v === true || v === 'true' || v === 1 || v === '1');
  const num = (v, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, 5000) : dflt;
  };
  /* 文本相关的数值上限大得多（随机数可以到十亿位、打字间隔到 2 秒），
   * 不能复用 num() 的 5000 上限 —— 否则「随机数 1–99999」会被静默改成 5000。 */
  const int = (v, dflt, lo, hi) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt;
  };
  let typingMin = int(raw.typing_min_ms, DEFAULT_SETTINGS.typing_min_ms, 0, 2000);
  let typingMax = int(raw.typing_max_ms, DEFAULT_SETTINGS.typing_max_ms, 0, 2000);
  if (typingMin > typingMax) [typingMin, typingMax] = [typingMax, typingMin];
  let randMin = int(raw.random_min, DEFAULT_SETTINGS.random_min, 0, 1e9);
  let randMax = int(raw.random_max, DEFAULT_SETTINGS.random_max, 0, 1e9);
  if (randMin > randMax) [randMin, randMax] = [randMax, randMin];
  return {
    input: bool(raw.input, true),
    click: bool(raw.click, true),
    scroll: bool(raw.scroll, true),
    move: bool(raw.move, true),
    text_sync: bool(raw.text_sync, true),
    typing: bool(raw.typing, false),
    paste: bool(raw.paste, true),
    random_number: bool(raw.random_number, false),
    typing_min_ms: typingMin,
    typing_max_ms: typingMax,
    random_min: randMin,
    random_max: randMax,
    same_tab: bool(raw.same_tab, true),
    target_blank: bool(raw.target_blank, true),
    delay_ms: num(raw.delay_ms, 0),
    jitter_ms: num(raw.jitter_ms, 0),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ CDP 小工具 ------------------------------ */

/** 连一条浏览器级 ws（实例里已有 `wsUrl`，见 manager.js:321） */
async function connectInstance(profileId) {
  const inst = getInstance(profileId);
  if (!inst) throw new Error(`环境 ${profileId} 没有运行实例`);
  if (!inst.wsUrl) throw new Error(`环境 ${profileId} 没有 CDP 地址`);
  const client = await CdpClient.connect(inst.wsUrl, { timeoutMs: 8000 });
  return { inst, client };
}

/** 选一张页面 target：优先真实 URL（跳过 about:blank / chrome://newtab），没有就取第一张 page */
async function pickPageTarget(client) {
  const { targetInfos } = await client.send('Target.getTargets');
  const pages = (targetInfos || []).filter((t) => t.type === 'page');
  if (!pages.length) return null;
  const real = pages.find((t) => t.url && !t.url.startsWith('about:blank') && !t.url.startsWith('chrome://newtab'));
  return real || pages[0];
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
  const seed = rngSeed === null || rngSeed === undefined ? crypto.randomInt(1, 2 ** 31) : Number(rngSeed);
  const scheduler = new SyncScheduler({ delayMs: st.delay_ms, jitterMs: st.jitter_ms, rng: makeRng(seed) });
  /* 文本的随机源单独一条流：随机数字、逐字间隔都从这里取。
   * 与会话种子绑在一起 → 同一个 rngSeed 重放同一串数字，问题可复现（判据也靠这个）。 */
  const textRng = makeRng((Number(seed) >>> 0) ^ 0x5f356495);

  const targets = new Map();   // profileId -> { client, sessionId, targetId, viewport, window }
  const resolvers = new Map();  // profileId -> 文本解析器（每窗口一个：随机数字各抽各的、连击状态独立）
  const degraded = new Map();  // profileId -> reason

  const session = {
    id: crypto.randomUUID(),
    master,
    slaves,
    settings: st,
    binding_name: bindingName,
    rng_seed: seed,
    started_at: new Date().toISOString(),
    events: 0,
    dropped: 0,
    text_sent: 0,
    text_swallowed: 0,
    scheduler,
    targets,
    degraded,
    stopped: false,
  };

  let masterClient = null;
  try {
    /* 主窗口：连上、抓一张页面、装 binding + 捕获脚本 */
    const m = await connectInstance(master);
    masterClient = m.client;
    const mTarget = await pickPageTarget(m.client);
    if (!mTarget) throw new Error('主窗口没有页面 target（可能没有开任何标签）');
    const mSession = await attach(m.client, mTarget.targetId);
    targets.set(master, { client: m.client, sessionId: mSession, targetId: mTarget.targetId, viewport: null, window: await windowSizeOf(m.client, mTarget.targetId) });

    await m.client.send('Page.enable', {}, mSession).catch(() => {});
    await m.client.send('Runtime.enable', {}, mSession).catch(() => {});
    await m.client.send('Runtime.addBinding', { name: bindingName }, mSession);

    // 新文档：脚本自己轮询等 binding；主进程在 frameNavigated 时补装
    await m.client.send('Page.addScriptToEvaluateOnNewDocument', { source: buildCaptureScript({ bindingName }) }, mSession);
    // 当前文档：直接跑一遍（新文档脚本只对「下一个文档」生效）
    await m.client.send('Runtime.evaluate', { expression: buildCaptureScript({ bindingName }) }, mSession).catch(() => {});

    m.client.on('Page.frameNavigated', (params, sid) => {
      if (sid !== mSession) return;
      // 只认主帧：子帧导航不该重装 binding（子帧拿不到也无所谓，见 README 的 iframe 边界）
      if (params?.frame?.parentId) return;
      // binding 不跨文档存活（实测）：新文档要补装一次，脚本的轮询会把它抓走并 delete
      m.client.send('Runtime.addBinding', { name: bindingName }, sid).catch(() => {});
      refreshViewport(master).catch(() => {});
    });

    /* 受控窗口：连上、抓页面、读视口 */
    for (const id of slaves) {
      const s = await connectInstance(id);
      const t = await pickPageTarget(s.client);
      if (!t) { degraded.set(id, '没有页面 target'); s.client.close(); continue; }
      const sid = await attach(s.client, t.targetId);
      const viewport = await viewportOf(s.client, sid);
      const win = await windowSizeOf(s.client, t.targetId);
      targets.set(id, { client: s.client, sessionId: sid, targetId: t.targetId, viewport, window: win });
      // 环境被外部关掉：连接断了就标降级，不静默继续
      s.client.on('*', () => {});
      s.client.socket?.on?.('close', () => { degraded.set(id, 'CDP 连接已断开'); });
    }

    /* 主窗口事件 → 受控窗口 */
    m.client.on('Runtime.bindingCalled', async (params, sid) => {
      if (sid !== mSession || params?.name !== bindingName) return;
      let payload = null;
      try { payload = JSON.parse(params.payload); } catch { return; }
      const list = Array.isArray(payload?.e) ? payload.e : [];
      for (const ev of list) {
        session.events += 1;
        // 开关必须读**会话当前的** settings：闭包里那个 `st` 是启动时的快照，
        // 用户运行中关掉「输入」时它会一直是旧值（B 层判据抓到的真 bug）。
        if (!enabledBySwitch(ev, session.settings)) { session.dropped += 1; continue; }
        // 文本/键盘事件不需要视口；鼠标类没有视口就丢（宁可漏一次移动，也不要在 (0,0) 乱点）
        const isText = ev?.t === 'key' || ev?.t === 'text' || ev?.t === 'paste';
        let textEmitted = false;
        for (const id of session.slaves) {
          const t = targets.get(id);
          if (!t || degraded.has(id)) continue;
          if (!t.viewport && !isText) continue;
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
              await t.client.send(call.method, call.params, t.sessionId);
            }
          });
        }
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
    session.stopped = true;
    scheduler.stop();
    lastTeardown = {
      binding_name: bindingName,
      at: new Date().toISOString(),
      removed: false,
      error: session.abnormal,
      reason: 'connection_lost',
    };
    // 别的连接也要断掉：会话已经废了，留着只是占资源
    for (const [, t] of targets) { try { t.client.close(); } catch { /* ignore */ } }
    targets.clear();
    if (current === session) current = null;
  });

  async function refreshViewport(profileId) {
    const t = targets.get(profileId);
    if (!t) return null;
    t.viewport = await viewportOf(t.client, t.sessionId);
    return t.viewport;
  }

  session.refreshViewport = refreshViewport;
  session.stop = async () => {
    if (session.stopped) return;
    session.stopped = true;
    scheduler.stop();

    /**
     * 摘 binding 必须**先于**关连接，而且要记读数：
     * 页面侧抓完引用就 `delete window[name]` 了，所以「stop 之后页面里查不到这个名字」
     * 在摘不摘 removeBinding 时都成立 —— 光看页面看不出区别，只能看主进程这边摘没摘。
     * `removed:false` 就是「没摘」的铁证（判据钉这条）。
     */
    const teardown = {
      binding_name: bindingName,
      at: new Date().toISOString(),
      removed: false,
      error: null,
      reason: 'user_stop',
    };
    const mt = targets.get(master);
    if (mt) {
      try {
        await mt.client.send('Runtime.removeBinding', { name: bindingName }, mt.sessionId);
        teardown.removed = true;
      } catch (e) {
        teardown.error = e?.message || String(e);
      }
    } else {
      teardown.error = '主窗口连接已不在（无法摘 binding）';
    }
    lastTeardown = teardown;

    for (const [, t] of targets) {
      try { t.client.close(); } catch { /* ignore */ }
    }
    targets.clear();
    if (current === session) current = null;
  };

  session.status = () => statusOf(session);
  current = session;
  return statusOf(session);
}

function statusOf(session) {
  const windows = [];
  for (const [id, t] of session.targets) {
    windows.push({
      profile_id: id,
      role: id === session.master ? 'master' : 'slave',
      target_id: t.targetId,
      viewport: t.viewport,
      window: t.window,
      degraded: session.degraded.get(id) || null,
    });
  }
  // 「尺寸不一致」：按窗口外框宽比，>2% 就算不一致（视口差一点是滚动条造成的，不算）
  const widths = windows.filter((w) => w.role === 'slave' && w.window?.width).map((w) => w.window.width);
  const base = windows.find((w) => w.role === 'master')?.window?.width || null;
  let sizeMismatch = false;
  if (base && widths.length) {
    sizeMismatch = widths.some((w) => Math.abs(w - base) / base > 0.02);
  }
  return {
    running: !session.stopped,
    session_id: session.id,
    master_id: session.master,
    slave_ids: session.slaves,
    settings: session.settings,
    binding_name: session.binding_name,
    started_at: session.started_at,
    events: session.events,
    dropped: session.dropped,
    text_sent: session.text_sent,
    text_swallowed: session.text_swallowed,
    abnormal: session.abnormal || null,
    scheduler: session.scheduler.stats(),
    windows,
    size_mismatch: sizeMismatch,
    last_teardown: lastTeardown,
  };
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
      last_teardown: lastTeardown,
    };
  }
  return current.status();
}

export async function stopSync() {
  if (!current) return { running: false, teardown: lastTeardown };
  await current.stop();
  return { running: false, teardown: lastTeardown };
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
 */
export async function unifySize() {
  if (!current) throw new Error('没有正在运行的同步会话');
  const s = current;
  const ref = s.targets.get(s.master)?.window;
  if (!ref?.width || !ref?.height) throw new Error('读不到主窗口尺寸');

  const done = [];
  for (const id of s.slaves) {
    const t = s.targets.get(id);
    if (!t) continue;
    const win = await windowSizeOf(t.client, t.targetId);
    if (!win?.windowId) { done.push({ profile_id: id, ok: false, reason: '读不到窗口 id' }); continue; }
    try {
      // 最大化 / 最小化下 setWindowBounds 会被忽略（实测）：必须先回 normal 再设宽高
      await t.client.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal' } });
      await t.client.send('Browser.setWindowBounds', {
        windowId: win.windowId,
        bounds: { width: ref.width, height: ref.height },
      });
      done.push({ profile_id: id, ok: true, width: ref.width, height: ref.height });
    } catch (e) {
      done.push({ profile_id: id, ok: false, reason: e?.message || String(e) });
    }
  }
  await refreshAll();
  return { resized: done, status: current.status() };
}

/**
 * 在所有同步窗口里新开标签并访问网址（「打开网址」；最多 10 个，与对手的提示一致）。
 *
 * **姿势不能错**：`Target.createTarget({url})` 会在 attach 之前就把首个文档建好，
 * 注入脚本只对下一个文档生效 —— 那张标签的首帧就是原始指纹（`manager.js:807` 的实测）。
 * 所以一律 `about:blank` → 登记 blank-reload 豁免 → attach → `Page.navigate`。
 * 判据钉的就是这个：首个文档的**注入完成标记**（按该环境 `fp_seed` 派生的名字，见 `kernel/markers.js`）
 * 是 `object`，且 `navigation.type === 'navigate'`。
 *
 * 两个开关：
 *   `target_blank` 关掉 → 不新开，直接在**同序号**（或当前）那个标签里跳（`navigateAt`）；
 *   `same_tab` 关掉    → 不按序号对齐，只动各窗口**当前可见**的那个标签。
 */
export async function openTabInAll(rawUrl) {
  if (!current) throw new Error('没有正在运行的同步会话');
  const list = Array.isArray(rawUrl) ? rawUrl : [rawUrl];
  const urls = [];
  for (const item of list.slice(0, 10)) {
    const u = normalizeUrl(item);
    if (!u) throw new Error('url 必须是 http/https 地址');
    urls.push(u);
  }
  if (!urls.length) throw new Error('url 必须是 http/https 地址');

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
      for (const url of urls) {
        if (current.settings.target_blank) {
          const r = await openTabFor(t.client, { url, onTarget: (tid) => inst?.exemptBlankReload?.(tid) });
          opened.push({ profile_id: id, role: isMaster ? 'master' : 'slave', target_id: r.targetId, url, mode: 'new_tab' });
        } else {
          const idx = isMaster ? vis.index : slaveAnchor(masterVis.index, vis.index, tabs.length, current.settings.same_tab);
          const tab = tabs[idx];
          if (!tab) { opened.push({ profile_id: id, target_id: null, url, mode: 'same_tab', error: '没有可导航的标签' }); continue; }
          await navigateAt(t.client, tab.targetId, url);
          opened.push({ profile_id: id, role: isMaster ? 'master' : 'slave', target_id: tab.targetId, url, mode: 'same_tab' });
        }
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
    same_tab: current.settings.same_tab,
    target_blank: current.settings.target_blank,
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
      if (current.settings.target_blank) {
        const r = await openTabFor(t.client, { url: src.url, onTarget: (tid) => inst?.exemptBlankReload?.(tid) });
        copied.push({ profile_id: id, target_id: r.targetId, url: src.url, mode: 'new_tab' });
      } else {
        const tabs = await listTabs(t.client);
        const i = targetIndex(idx, tabs.length, current.settings.same_tab);
        const dst = tabs[i ?? idx];
        if (!dst) { copied.push({ profile_id: id, target_id: null, url: src.url, error: '受控窗口没有对应序号的标签' }); continue; }
        await navigateAt(t.client, dst.targetId, src.url);
        copied.push({ profile_id: id, target_id: dst.targetId, url: src.url, mode: 'same_tab' });
      }
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