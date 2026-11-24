/**
 * 窗口同步 · 窗口操作：统一尺寸 / 排列 / 显示 / 强制置前（从 session.js 拆出，行为不变）。
 * 与同步会话解绑：没开同步也能对勾选的运行中环境用（见 resolveWindows）。
 */
import { needsRestoreBeforeResize, normalizeState, summarizeResize, verifyBounds } from './window.js';
import { auditPlan, autoFit, placeOne, planArrange, summarizeArrange } from './arrange.js';
import { screensForArrange } from './displays.js';
import { planForce, planShow, summarizeForce, summarizeShow, verifyForced, verifyShown } from './show.js';
import { settle } from './tabs.js';
import { pageSessionOf, releaseHandles, resolveWindows, windowRectOf, windowSizeOf } from './session-cdp.js';
import { syncStatus } from './session-live.js';
import { refreshAll } from './session-tabs.js';
import { state } from './session-state.js';

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
    status: state.current ? state.current.status() : syncStatus(),
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
    status: state.current ? state.current.status() : syncStatus(),
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
    status: state.current ? state.current.status() : syncStatus(),
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
    status: state.current ? state.current.status() : syncStatus(),
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
