/**
 * 窗口尺寸与排列的**纯计算**部分（不需要 Chrome、不需要显示器）。
 *
 * 为什么单独一个文件：阶段 3 的三件事（统一尺寸 / 窗口排列 / 显示窗口）里，
 * 「该设成多少、算不算成功、会不会重叠」全是算得出来的，真内核那层只负责证明
 * 「按这个计划下命令，浏览器确实变成那样」。算错了在 A 层一秒就红，不用等起 3 个环境。
 *
 * 一条贯穿全篇的取舍：**改窗口这件事必须回读验证**。
 * `Browser.setWindowBounds` 返回成功不代表窗口真变了 —— 最大化/全屏状态下它会被静默忽略
 * （实测：Chrome 157.0.8103.78，最大化窗口直接设 width/height 无效，必须先回 normal）。
 * 所以这里的 `verifyBounds` 是判「成功」的唯一依据，命令的返回值只当参考。
 */

/** CDP 的窗口状态就这四种；不认识的一律当 normal（不猜，照实处理） */
export const WINDOW_STATES = Object.freeze(['normal', 'minimized', 'maximized', 'fullscreen']);

/**
 * 归一窗口状态。
 * `Browser.getWindowBounds` 在 `windowState` 缺省时表示 normal（CDP 的默认值）。
 */
export function normalizeState(raw) {
  const s = String(raw || '').trim();
  return WINDOW_STATES.includes(s) ? s : 'normal';
}

/**
 * 要不要先恢复到 normal 才能设尺寸。
 * 最大化 / 全屏 / 最小化 三种状态下，直接设 width/height 都是**静默无效**的。
 */
export function needsRestoreBeforeResize(state) {
  return normalizeState(state) !== 'normal';
}

/**
 * 比对两套窗口外框。
 * 只比宽高（外框），不比起始位置 —— 「统一尺寸」不管位置，位置是「窗口排列」的事。
 * @param {{width:number,height:number}} expected
 * @param {{width:number,height:number,state?:string}} actual
 */
export function verifyBounds(expected, actual) {
  /* null / undefined 不能过 Number()（null 会变成 0，看着像「差 1000」而不是「读不到」） */
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
  };
  const ew = num(expected?.width);
  const eh = num(expected?.height);
  const aw = num(actual?.width);
  const ah = num(actual?.height);
  const state = normalizeState(actual?.state ?? actual?.windowState);
  const off = [];
  if (aw === null || aw !== ew) off.push({ field: 'width', expected: ew, actual: aw });
  if (ah === null || ah !== eh) off.push({ field: 'height', expected: eh, actual: ah });
  if (state !== 'normal') off.push({ field: 'windowState', expected: 'normal', actual: state });
  return { ok: off.length === 0, mismatches: off };
}

/**
 * 统一尺寸的结果汇总（面板文案与判据都读它）。
 * @param {Array<{role:string, profile_id:string, ok:boolean, actual?:object, mismatches?:Array}>} results
 */
export function summarizeResize(results) {
  const list = Array.isArray(results) ? results : [];
  const failed = list.filter((r) => !r.ok);
  return {
    total: list.length,
    ok: failed.length === 0,
    failed: failed.length,
    // 面板文案要能直接说清楚「几个没改成、差多少」，不能只说「失败了」
    message: failed.length
      ? `有 ${failed.length} 个窗口没能改成同尺寸`
      : `已把 ${list.length} 个窗口改成同尺寸`,
    details: failed.map((r) => ({
      profile_id: r.profile_id,
      role: r.role,
      reason: r.reason || (r.mismatches || []).map((m) => `${m.field} 期望 ${m.expected} 实际 ${m.actual}`).join('；'),
    })),
  };
}
