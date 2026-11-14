/**
 * 「显示窗口」（对手的 `viewWin` / 行内 `displayWin`）的**纯计算 + 判定**部分。
 *
 * 语义：把窗口从最小化恢复出来，并尽量放到最前面。
 *
 * 这一层为什么单独写、为什么把「抬到前台」分成两档（`restore` / `page_only`）：
 * 实测（`.tmp/foreground-probe*.mjs`，Chrome 157.0.8103.78）——
 *   · 窗口**最小化**时：`Browser.setWindowBounds(windowState:normal)` 与 `Page.bringToFront`
 *     **都能**把它恢复并抬到 OS 前台（Win32 读数：前台 pid = 该内核、z 序 0）。
 *   · 窗口**没最小化、只是被别的窗口盖住**时：`Page.bringToFront` **不抬**。
 *     实测读数：页面 `document.hasFocus()` 变 true，但 Win32 前台仍是别的窗口、z 序没动。
 *     所以「页面拿到焦点」不等于「OS 窗口到前台」，这两件事**必须分开记**（`raise` 字段）。
 *
 * 也就是说：`restore` 这一档是真的到前台；`page_only` 只保证页面级激活，**不保证**用户看得见。
 * 要不要为「被盖住」这种情况引 Win32 依赖，等定下来再换这里的实现，判定逻辑不用改。
 */
import { needsRestoreBeforeResize, normalizeState } from './window.js';

/**
 * 每个窗口该怎么处理。
 * @param {Array<{profile_id:string, state:string|null}>} windows 当前状态（来自 Browser.getWindowForTarget）
 * @returns {Array<{profile_id:string, action:'restore'|'page_only'|'none', state_before:string}>}
 */
export function planShow(windows) {
  const list = Array.isArray(windows) ? windows : [];
  return list.map((w) => {
    const state = normalizeState(w?.state);
    // 最小化：恢复就能同时到前台（实测），这一档是真的抬窗口
    if (state === 'minimized') {
      return { profile_id: w.profile_id, action: 'restore', state_before: state };
    }
    // 全屏：保持不动（用户主动全屏的窗口不该被我们缩回来）
    if (state === 'fullscreen') {
      return { profile_id: w.profile_id, action: 'none', state_before: state };
    }
    // normal / maximized 但被盖住：只能做页面级激活（零依赖能力边界，如实标 page_only）
    return { profile_id: w.profile_id, action: 'page_only', state_before: state };
  });
}

/**
 * 回读校验：**恢复成功**只认状态，另外钉一条「位置尺寸不许被搬走」。
 *
 * 为什么钉位置：用户点「显示窗口」只是想看见它，不想让它挪到别的地方去
 * （特别是多屏时，窗口在扩展屏上，一恢复就跳回主屏是最讨厌的）。
 * 最大化的窗口不做尺寸比对 —— 它的 bounds 是屏幕尺寸，系统会给出 -8 这类边框补偿值。
 *
 * **读不到回读值一律判失败**：`after` 为 null 时不能落进「状态没变所以没问题」那条路，
 * 否则「窗口已经崩了、命令没生效」会被报成成功。
 *
 * @param {{state_before:string, rect_before:object}} before
 * @param {object} after 回读到的 `{x,y,width,height,state}`
 */
export function verifyShown(before, after) {
  const stateBefore = normalizeState(before?.state_before);
  if (!after || typeof after !== 'object') {
    return {
      ok: false,
      problems: [{ field: 'windowState', expected: stateBefore === 'minimized' ? 'normal' : stateBefore, actual: null }],
    };
  }
  const stateAfter = normalizeState(after.state);
  const problems = [];

  if (stateBefore === 'minimized') {
    if (stateAfter !== 'normal' && stateAfter !== 'maximized') {
      problems.push({ field: 'windowState', expected: 'normal', actual: after?.state ?? null });
    }
    /*
     * 恢复后位置尺寸应当和最小化前一致（实测：「最小化→正常」不会搬动窗口）。
     * 唯一不比的情况是**读到的状态是 maximized** —— 最大化窗口的 bounds 带系统边框补偿（-8 这类），
     * 比了必然假失败。注意不能拿 `rect_before.state === 'normal'` 当门槛：
     * 窗口最小化期间读到的 state 就是 `minimized`，那样写等于永远不比位置，
     * 多屏窗口被搬回主屏这种硬伤就漏掉了。
     */
    if (stateAfter === 'normal' && normalizeState(before?.rect_before?.state) !== 'maximized') {
      for (const f of ['x', 'y', 'width', 'height']) {
        const want = before?.rect_before?.[f];
        const got = after?.[f];
        if (want === null || want === undefined) continue;
        if (got === null || got === undefined || Math.round(Number(got)) !== Math.round(Number(want))) {
          problems.push({
            field: f,
            expected: Math.round(Number(want)),
            actual: got === null || got === undefined ? null : Math.round(Number(got)),
          });
        }
      }
    }
  } else if (stateBefore === 'fullscreen') {
    if (stateAfter !== 'fullscreen') problems.push({ field: 'windowState', expected: 'fullscreen', actual: after?.state ?? null });
  } else if (stateAfter !== stateBefore) {
    // normal / maximized：不该被我们改掉状态（只做页面级激活）
    problems.push({ field: 'windowState', expected: stateBefore, actual: after?.state ?? null });
  }

  return { ok: problems.length === 0, problems };
}

/**
 * 汇总。文案分三档，**不让用户以为「塞到前面了」**：
 *   restored  真的恢复并到前台（最小化那批）
 *   page_only 只做了页面级激活，窗口可能还被盖着
 *   none      没动（全屏）
 */
export function summarizeShow(results) {
  const list = Array.isArray(results) ? results : [];
  const failed = list.filter((r) => !r.ok);
  const restored = list.filter((r) => r.ok && r.raise === 'restored');
  const pageOnly = list.filter((r) => r.ok && r.raise === 'page_only');
  const parts = [];
  if (restored.length) parts.push(`已恢复 ${restored.length} 个最小化的窗口`);
  if (pageOnly.length) parts.push(`${pageOnly.length} 个窗口只做了页面级激活（可能仍被其它窗口盖住）`);
  return {
    total: list.length,
    ok: failed.length === 0,
    failed: failed.length,
    restored: restored.length,
    page_only: pageOnly.length,
    message: failed.length
      ? `有 ${failed.length} 个窗口没能显示出来`
      : (parts.join('；') || '没有需要显示的窗口'),
    details: failed.map((r) => ({
      profile_id: r.profile_id,
      role: r.role,
      reason: r.reason || (r.problems || []).map((p) => `${p.field} 期望 ${p.expected} 实际 ${p.actual}`).join('；'),
    })),
  };
}

/** 这个窗口是不是「最小化」（路由/面板要提前说清楚哪些能真到前台） */
export function isMinimized(state) {
  return normalizeState(state) === 'minimized';
}

/** 需要先恢复再操作？（给别的模块复用，避免各处自己判） */
export function needsRestore(state) {
  return needsRestoreBeforeResize(state);
}
