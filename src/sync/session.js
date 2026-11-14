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
  parseOpenUrls, planCloseBlank, planCloseOthers, planUnify, settle, targetIndex, visibleTabIndex,
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

/* 默认设置与归一化在 `./settings.js`（0.4.3 ④ 的「设置」页要单独读它，
 * 而 `prefs.js → session.js` 会把整个运行时拖进来）。这里原样再导出，对外契约不变。 */
export { DEFAULT_SETTINGS, normalizeSettings };

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
export async function unifySize() {
  if (!current) throw new Error('没有正在运行的同步会话');
  const s = current;
  const mt = s.targets.get(s.master);
  if (!mt) throw new Error('主窗口连接已不在');

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
  for (const id of s.slaves) {
    const t = s.targets.get(id);
    if (!t) continue;
    const entry = { profile_id: id, role: 'slave', target_id: t.targetId, ok: false, expected: ref };
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
    reference: ref,
    master_restored: masterRestored,
    master_state_before: normalizeState(masterBefore.state),
    resized,
    summary,
    status: current.status(),
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
export async function arrangeWindows(rawParams = {}) {
  if (!current) throw new Error('没有正在运行的同步会话');
  const s = current;
  const ids = [s.master, ...s.slaves].filter((id) => s.targets.get(id));
  if (!ids.length) throw new Error('没有可排列的窗口');

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
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const t = s.targets.get(id);
    const want = plan.windows[i];
    const entry = { profile_id: id, role: id === s.master ? 'master' : 'slave', index: i, ok: false };
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
    screen_id: plan.screen_id,
    plan: plan.windows,
    audit,
    warnings: plan.warnings,
    auto: autoInfo,
    displays_managed: screens.length > 0,
    placed,
    summary: summarizeArrange(placed),
    status: current.status(),
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
  if (!current) throw new Error('没有正在运行的同步会话');
  const s = current;
  const all = [s.master, ...s.slaves];
  const want = rawIds === undefined || rawIds === null
    ? all
    : (Array.isArray(rawIds) ? rawIds : [rawIds]).map(String);
  const ids = want.filter((id) => s.targets.get(id));
  if (!ids.length) throw new Error('没有可显示的窗口');

  const results = [];
  for (const id of ids) {
    const t = s.targets.get(id);
    const entry = {
      profile_id: id,
      role: id === s.master ? 'master' : 'slave',
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
    forced: results,
    summary: summarizeForce(results),
    /** 能确认的只有「窗口恢复正常」，不是「在最前面」（产品里不调 Win32） */
    os_foreground_confirmed: false,
    status: current.status(),
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
  if (!current) throw new Error('没有正在运行的同步会话');
  const s = current;
  const all = [s.master, ...s.slaves];
  const want = rawIds === undefined || rawIds === null
    ? all
    : (Array.isArray(rawIds) ? rawIds : [rawIds]).map(String);
  const ids = want.filter((id) => s.targets.get(id));
  if (!ids.length) throw new Error('没有可显示的窗口');

  const results = [];
  for (const id of ids) {
    const t = s.targets.get(id);
    const entry = {
      profile_id: id,
      role: id === s.master ? 'master' : 'slave',
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
        await t.client.send('Page.bringToFront', {}, t.sessionId);
        await settle(160);
      }

      /* 回读：恢复成功只认状态 + 位置尺寸没被搬走（见 show.js 顶部） */
      const after = await windowRectOf(t.client, t.targetId);
      entry.rect_after = after;
      entry.state_after = normalizeState(after?.state);
      const v = verifyShown({ state_before: entry.state_before, rect_before: before }, after);
      // page_only 那批同时记下「页面拿到焦点没有」—— 但**它不参与 ok**，只作读数
      if (plan.action === 'page_only') {
        entry.page_focused = await pageHasFocus(t.client, t.sessionId);
      }
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
    shown: results,
    summary: summarizeShow(results),
    /**
     * 明确告诉调用方：这一版**只有最小化的窗口真到前台**。
     * 面板据此显示一行提示，不让用户以为「点了就跑到最前面了」。
     */
    os_foreground: results.length > 0 && results.every((r) => r.raise === 'restored'),
    status: current.status(),
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