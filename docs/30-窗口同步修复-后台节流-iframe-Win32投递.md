# 30 - 窗口同步修复：后台不节流 + iframe 捕获 + Win32 鼠标投递

> 承接：`29-窗口同步规格-按实测行为对齐.md`（R1–R8 行为规格）
> 本文是**实现回执**：根因、改了什么、判据读数、与 29 号规格的对照、已知限制。
> 判据读数日期：2026-11-24，真内核 157.0.8103.78，Windows。

---

## 0. 一句话结论

0.4.7.9–0.4.7.12 的「主控操作、受控不动」**主因不在投递逻辑，在 Chrome 后台节流**：
受控窗口被主控遮挡 / 在后台时，渲染器被降级、定时器被节流、页面被冻结，
CDP `Input.*` 照样返回成功（`errors=0`），但页面不执行——这正是 0.4.7.9 「sent=311 / errors=0 但不动」。

次因两条：iframe 里的操作抓不到；投递依赖「找准受控窗口的激活标签」，这条链脆。

---

## 1. 根因 → 修复

| # | 根因 | 修复 | 文件 |
|---|---|---|---|
| A | 被遮挡/后台窗口渲染器降级、定时器节流、页面冻结（只关了 `CalculateNativeWinOcclusion` 不够） | 启动参数加 `--disable-renderer-backgrounding`、`--disable-backgrounding-occluded-windows`、`--disable-background-timer-throttling`；`--disable-features` 加 `IntensiveWakeUpThrottling` | `src/kernel/chrome.js` |
| B1 | 同源 iframe：`clientX/Y` 相对**本帧**，直接用会点偏 | 捕获脚本沿 `frameElement` 链累加偏移到根视口（100ms 缓存） | `src/sync/agent-script.js` |
| B2 | 已加载的同源子帧没装捕获（新文档脚本只管「下一个文档」） | 装捕获时递归 `frames[i].eval` 一遍；子帧导航也补 `addBinding` | `src/sync/session.js` |
| B3 | 跨进程 iframe（OOPIF）是独立 target，页面监听器抓不到 | 主控每张标签开 `Target.setAutoAttach({waitForDebuggerOnStart:true, flatten:true})`，子帧先停住→装捕获→放行；坐标按 `DOM.getFrameOwner`+`DOM.getBoxModel` 补偏移，拿不到偏移就丢（不点错） | `src/sync/session.js` |
| B4 | **顺序 bug**：`setAutoAttach` 会立刻为已存在的 OOPIF 发 `attachedToTarget`，当时标签还没登记 → 被当成「别人的」放走 | 先登记 `masterPages / masterSessionToTarget`，再装捕获；`attachedToTarget` 处理器在装捕获**之前**注册 | `src/sync/session.js` |
| C | 投递绑在 target 上，要一直回答「受控窗口哪张标签在前台」 | 新增 Win32 投递端：PostMessage 给受控窗口，浏览器自己路由到前台标签/iframe（与 AdsPower 同思路，投给窗口而不是标签）。**不装钩子** | `src/sync/win-input.cs`、`src/sync/win-input.js`、`src/sync/session.js` |

---

## 2. Win32 投递端

### 2.1 形态
- `win-input.cs`：常驻小进程，stdin 一行 JSON 指令 / stdout 一行回执，单线程按序处理（天然保序）。
- 首次使用由系统自带 .NET Framework 4 的 `csc.exe` 编译到 `%TEMP%\freepower-win-input\`，源码哈希变才重编。**零 npm 依赖**。
- 起不来（非 Windows / 无 csc / 编译失败）→ `session.win` 为空，自动走 CDP，日志一行 `WARN 同步投递端`。
- 设置 `deliver: 'cdp'` 可强制回老路径；只认 `'cdp'`，其它值一律 `win32`。

### 2.2 分工（实测定下来的，不是设计偏好）

| 事件 | 路径 | 依据 |
|---|---|---|
| 鼠标移动 / 按下 / 抬起 / 滚轮 | **Win32** | D1/D2/D3/D4 两条路径都绿 |
| 不带字符的键（退格、方向键、回车、Tab、功能键、组合键） | **Win32** | 扩展键按 `lParam` bit24 标 |
| **带字符的键** | **CDP** | 实测：补 `WM_CHAR` → `"aabb"`；不补 → `"AB"`（Chrome 按 VK 码自己合成，大小写错）。PostMessage 无法可靠产生正确字符 |
| 输入法组合文本 / 粘贴 / 随机数字 / 模拟人工输入 | **CDP** | 依赖每窗口文本解析器与逐字节奏 |

带字符的键只会发生在用户正看着的标签里，走 CDP 不存在「投错标签」风险，所以这条分工不削弱 C 的收益。

### 2.3 坐标
- 输入是页面视口 CSS px；helper 按 `GetDpiForWindow` 换算成物理像素，加上渲染区在顶层客户区里的偏移。
- 优先找可见的 `Chrome_RenderWidgetHostHWND`；新版 Chrome 常没有这个子窗口，则用 Node 侧从页面量的 `outerHeight-innerHeight-(outerWidth-innerWidth)/2` 作工具栏高度兜底。
- 越界丢弃（R3，不 clamp），记 `dropped_out_of_view`。

### 2.4 状态字段（R5 补充）
`GET /api/v2/sync/status` 的 `windows[]` 新增：

| 字段 | 含义 |
|---|---|
| `delivery_via` | 最近一次实际走的路径：`win32` / `cdp` |
| `win_ok` / `win_fail` | Win32 投递成功 / 失败条数 |
| `win_last_reason` | 最后一次失败原因：`no_window` / `window_gone` / `window_minimized` / `no_render_widget` / `timeout` / `helper_down` … |

---

## 3. 判据读数（先红后绿）

新增 `test/sync-deliver.test.mjs`（A 层，进 `npm test`）与 `test/sync-deliver-kernel.test.mjs`（B 层真内核，进 `npm run smoke`）。
B 层只认**受控页自己的 DOM 读数**，不认 `scheduler.sent / errors`（29 号 §3 硬规则）。

| 判据 | 场景 | 首轮（红） | 最终 |
|---|---|---|---|
| D1 | 受控被主控完全遮挡：定时器 1s ≥ 7 次 + 点击同步 | —（第 1 步一上就绿，42→52） | cdp ✅ / win32 ✅ |
| D2 | 同源 iframe 点击 | `0→0`（B2 未修） | cdp ✅ / win32 ✅ |
| D3 | 跨进程 iframe 点击 | `0→0`（B4 顺序 bug） | cdp ✅ / win32 ✅ |
| D4 | 受控切标签：新标签 +1、旧标签不变 | ✅ | cdp ✅ / win32 ✅ |
| D5 | 打字 `ab` | win32：`"aabb"` → `"AB"` | cdp ✅ / win32 ✅（字符键交回 CDP） |
| D6 | 状态如实 | `undefined` / `{}` | win32 轮 `via=win32, win_ok=15, fail=0` |

最终：`sync-deliver-kernel` **16/16**；`settings-diagnose` 的「16 键」断言按新增 `deliver` 改为 17 键。

---

## 4. 与 29 号规格 R1–R8 的对照

| 规格 | 状态 | 说明 |
|---|---|---|
| R1 捕获覆盖主控所有 page target | ✅ 扩展 | 现在也覆盖同源子帧与 OOPIF |
| R2 转发目标发送时解析 | ✅ / 部分绕开 | CDP 路径照旧；Win32 路径投给窗口，不需要解析 target |
| R3 坐标 1:1、越界丢弃 | ✅ | 两条路径都按受控视口越界丢弃；Win32 按 DPI 换算 |
| R4 操作覆盖范围 | ✅ | 鼠标、滚轮、键盘全覆盖；mousemove 新带 `btns`，拖拽可同步 |
| R5 状态自证 | ✅ 扩展 | 新增 `delivery_via / win_ok / win_fail / win_last_reason` |
| R6 看门狗 | 不变 | — |
| R7 受控页 `hasFocus()` 为 true | 不变（CDP 路径） | Win32 路径不依赖焦点模拟 |
| R8 主控选取规则 | 不变 | — |

---

## 5. 已知限制（如实列出）

1. **B 层判据用 CDP 模拟主控输入，不是真人鼠标。** 出包前需人工复跑：3+ 环境、主控遮挡受控、常用站点点击/滚动/打字。
2. **组合键（Ctrl+A / Ctrl+C / Enter / Tab）走 Win32，判据未覆盖。** Chrome 读修饰键可能看真实键盘状态，需人工确认。
3. **hover 效果**：Chrome 可能参考真实光标位置（`GetCursorPos`），被遮挡窗口的悬停样式可能不出现；点击不受影响。
4. **工具栏高度兜底**：开侧边栏 / 下载栏 / 页面缩放时 Win32 坐标可能偏；iframe 带 CSS `transform` 缩放时两条路径都会偏。
5. **高 DPI / 跨屏不同 DPI**：按窗口 DPI 换算，未做跨屏实测（29 号 §2 原本就标「未测」）。
6. **浏览器界面区域**（地址栏、标签栏）仍抓不到——捕获端还是页面 JS（2026-11-14 不上全局钩子的决定不变）。
7. **受控窗口最小化**：Win32 投递返回 `window_minimized` 并降级提示，不投递（与 AdsPower 实测行为一致）。

---

## 6. 回退

- 运行时：同步设置 `deliver: 'cdp'` 即回到 0.4.7.12 的投递路径（第 1、2 步的修复仍生效）。
- 代码：本次改动集中在 `src/kernel/chrome.js`、`src/sync/{agent-script,session,settings,win-input}.*`、`test/sync-deliver*.mjs`、`test/settings-diagnose.test.mjs`、`package.json`。
