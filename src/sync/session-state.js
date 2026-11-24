/**
 * 窗口同步 · 模块级共享状态（从 session.js 拆出）。
 *
 * 为什么是一个对象而不是三个 `export let`：ES 模块的导出绑定在别的模块里是只读的，
 * `current = session` 这种赋值只能在声明它的模块里做。放进对象里，各模块都能读写同一份。
 */
export const state = {
  /** 一次只允许一个同步会话：两套同时往同一批窗口发输入必然是灾难 */
  current: null,
  /** 上一次会话收尾的读数：binding 摘没摘（`removed:false` 就是「没摘」的铁证） */
  lastTeardown: null,
  /** 上一次会话**为什么结束**：master_target_gone / connection_lost / user_stop … */
  lastEnd: null,
};

export function getTeardown() {
  return state.lastTeardown;
}

export function getSession() {
  return state.current;
}
