/**
 * 窗口同步会话（阶段 1：键鼠捕获 → 回放 + 坐标映射 + 四个开关 + 延迟）。
 *
 * 连接策略（方案 Q6）：**每个环境另开一条浏览器级 CDP 连接**，只用显式 `attachToTarget`，
 * **不碰 `Target.setAutoAttach`** —— `manager.js` 的 `applyToSession` 已经占了 auto-attach
 * （`manager.js:630` / `:729`），两个客户端抢同一个 auto-attach 会让另一个收不到事件。
 *
 * 主窗口：`Runtime.addBinding` + `Page.addScriptToEvaluateOnNewDocument` 捕获键鼠；
 * 受控窗口：**零注入**，只收 CDP `Input`。
 *
 * 0.4.7.13 起本文件只是**门面**：实现拆到 session-*.js 五个模块，
 * 对外导出名与 0.4.7.12 完全一致（routes.js / desktop/main.js / 判据都不用改 import）。
 *   session-state.js    共享状态（current / lastTeardown / lastEnd）
 *   session-cdp.js      CDP 小工具 + 「要动哪些窗口」解析
 *   session-live.js     实时会话：start / stop / status / selftest
 *   session-windows.js  统一尺寸 / 排列 / 显示 / 强制置前
 *   session-tabs.js     标签：打开 / 关闭 / 复制 / 统一 / 刷新
 */

export { DEFAULT_SETTINGS, normalizeSettings } from './settings.js';
export { getSession, getTeardown } from './session-state.js';
export { masterBlockReason, pickPageTarget, sleep, unusableMasterPage } from './session-cdp.js';
export { detachProfile, restartSync, selftestOf, startSync, statusOf, stopSync, syncStatus, updateSettings } from './session-live.js';
export { arrangeWindows, forceShowWindows, showWindows, unifySize } from './session-windows.js';
export { closeTabs, copyTabToSlaves, openTabInAll, refreshAll, tabState, unifyTabs } from './session-tabs.js';
