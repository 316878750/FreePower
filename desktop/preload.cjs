/**
 * 桌面壳的 preload —— **只挂在主窗口上**（`desktop/main.js` 的 `createWindow`）。
 *
 * 渲染进程要「打开操作台」这件事，只有 Electron 主进程能做（那是个独立置顶小窗）。
 * 以前这条路是缺的：`sandbox` 开着、不挂 preload，网页侧**根本无法通知桌面壳**，
 * 所以操作台只能从托盘菜单打开 —— 页面里没有入口。
 *
 * 这个文件存在的唯一目的就是补那一个入口，因此边界钉得很死：
 *   · 只暴露两个东西：`isDesktop: true` 与 `openSyncPanel()`；
 *   · **不暴露 `ipcRenderer`**、不暴露任何通用 `invoke`、不暴露 `require`；
 *     渲染进程能触达的主进程通道只有 `fp:open-sync-panel` 这一条（主进程侧还会校验调用者）。
 *   · preload 只在主窗口挂；操作台小窗**不挂**（它要改形态走 Local API + 请求文件，不走 IPC）。
 *
 * 注意：这个文件是 **CommonJS**，后缀用 `.cjs` 而不是 `.js` ——
 * `package.json` 里有 `"type": "module"`，`.js` 可能被当 ESM 解析，
 * 而 Electron 的 sandboxed preload **只能**是 CommonJS。用 `require`，不要改成 `import`。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fpDesktop', {
  /** 让网页知道自己是桌面版还是纯网页（纯网页时按钮要禁用并写明原因） */
  isDesktop: true,
  /** 打开操作台（桌面小组件）。返回 `{ok:true}` 或 `{ok:false,error}` */
  openSyncPanel: () => ipcRenderer.invoke('fp:open-sync-panel'),
});
