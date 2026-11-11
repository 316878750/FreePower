# agent 版本存档与基线声明

> 生成于 2026-11-11。**本目录是静态引用与代码偏移的唯一基线来源。**
> 后续所有报告里的「偏移 XXXX」若未注明版本，默认指 **v2.9.0.1**（见下）。

## 1. 当前基线（重要，与早前报告不一致处以此为准）

| 角色 | 版本 | 大小 | md5 | 路由数 | 文件 |
|---|---|---|---|---|---|
| **实际运行中**（基线） | **v2.9.0.1** | 8854556 | `3b0d2fc7984f051de23b3d66192bdd4c` | **54** | `main-v2.9.0.1.min.js` |
| 已下载、未激活 | v2.9.0.2 | 8865685 | `b197782ba75b390785f3589e83604f54` | 54 | `main-v2.9.0.2.min.js` |
| 静态解包时的旧包 | v2.8.9.2 | 8800604 | `846185c95bb5c09744c4896b8474e48b` | 51 | `main-v2.8.9.2.min.js` |

### 怎么确定「实际运行中」的

不是看 `version\record` 的 `latest` 字段（那个写的是 v2.9.0.2，会误导），而是看**进程命令行**：

```
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*main.min.js*" }
→ "D:\Program Files\AdsPower Global\AdsPower Global.exe" C:\Users\<user>\AppData\Roaming\adspower_global\cwd_global\lib\main.min.js
```

agent 跑的是固定的 `lib\main.min.js`，而它的 md5 = `3b0d2fc7...` = **v2.9.0.1**。
v2.9.0.2 已下载到 `lib\version\` 并被 `record` 标为 latest，但**还没被换成 `main.min.js`** —— 说明热更新是「先下载到 version/，下次启动才切换」。

**修复一条此前的错误结论**：报告 09 §7 与 01 里写的「实测运行 v2.9.0.2、路由 51→54 发生在 v2.9.0.2」**不成立**。
实际是：**51→54 发生在 v2.9.0.1**，v2.9.0.1 与 v2.9.0.2 的路由集合**完全相同**。

## 2. 三个版本的关键 token 计数（逐项实测）

| token | v2.8.9.2 | v2.9.0.1 | v2.9.0.2 |
|---|---|---|---|
| extended-parameters | 3 | 3 | 3 |
| CanvasMark / CanvasMarkEx | 7 / 3 | 7 / 3 | 7 / 3 |
| WebGLMark / WebGLMarkEx | 5 / 2 | 5 / 2 | 5 / 2 |
| AudioFp | 1 | 1 | 1 |
| ClientRectFp | 1 | 1 | 1 |
| DisabledFonts | 2 | 2 | 2 |
| Fakefonts | 1 | 1 | 1 |
| TTSEngines | 2 | 2 | 2 |
| StaticConfig | 17 | 17 | **19** |
| DynamicConfig | 9 | 9 | 9 |
| Geoposition | 10 | 10 | 10 |
| HardwareConcurrency | 1 | **2** | 2 |
| DeviceMemory | 1 | 1 | 1 |
| WebRTCAddress | 5 | 5 | 5 |
| WebRTCLocalAddress | 2 | 2 | 2 |
| UPDATE_IP_$$_ | 2 | 2 | 2 |
| IS_REALTIME_TZ_GEO | 11 | 11 | 11 |
| IS_SUNFLOWER_BROWSER_BASE64 | 6 | 6 | 6 |
| ProxyChain | 2 | 2 | 2 |
| BlockList | 25 | 25 | 25 |
| StrongBlockList | 11 | 11 | 11 |
| MediaDevices | 7 | 7 | 7 |

**判读**：指纹注入相关 token 在三个版本间几乎恒定，唯一变化是 `HardwareConcurrency`（v2.9.0.1 +1）与 `StaticConfig`（v2.9.0.2 +2）。
→ **静态报告 02/03/04/08 的指纹逻辑结论对 v2.9.0.1 仍然成立**，无需重做；但**偏移值必须以 v2.9.0.1 复核**（文件增长 53 KB，偏移会漂移）。

## 3. 路由差异（精确集合）

`v2.8.9.2 → v2.9.0.1` 新增 3 条，**全部是 POST**：

```
+ POST /api/v2/browser-profile/recycle-bin/list
+ POST /api/v2/browser-profile/recycle-bin/restore
+ POST /api/v2/proxy/dynamic-proxy-traffic
```

`v2.9.0.1 → v2.9.0.2`：**零差异**（路由集合完全相同）。

## 4. 关于「解包一份 v2.9.0.2 的 app.asar」的说明

**`app.asar` 不是 agent 的更新载体。** 两者是分开的：

| 层 | 载体 | 更新方式 |
|---|---|---|
| Electron 壳 | `D:\Program Files\AdsPower Global\resources\app.asar` | 随主程序安装包，8.9.23 固定不动 |
| node agent | `%APPDATA%\adspower_global\cwd_global\lib\main.min.js` | **热更新**，下载到 `lib\version\<ver>__<md5>__<ts>` 后切换 |
| 定制内核 | `cwd_global\chrome_142\` 等 20 套 | 单独下发 |

所以「v2.9.0.2 的 app.asar」不存在。本目录存档的是**热更新包本体**（`main.min.js` 各版本 + 美化版），这才是真正的 agent 基线。
`app.asar`（8.9.23）的解包产物仍在 `extract\8.9.23\`。

## 5. 复现命令

```powershell
# 1) 确认实际运行的 agent
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*main.min.js*" }

# 2) 取 md5 对版本
(Get-FileHash "$env:APPDATA\adspower_global\cwd_global\lib\main.min.js" -Algorithm MD5).Hash.ToLower()

# 3) 列出所有已下载版本
Get-ChildItem "$env:APPDATA\adspower_global\cwd_global\lib\version" | Select Name,Length

# 4) 版本矩阵 / 路由差异（本目录配套脚本）
node tools\dyn\version-matrix.js <bundle1> <bundle2> <bundle3>
node tools\dyn\route-diff.js <bundleA> <bundleB>
```

## 6. 版本基线声明（写给后续所有引用者）

> **静态引用基线 = agent v2.9.0.1（md5 3b0d2fc7984f051de23b3d66192bdd4c，54 路由）。**
> 早期报告（01–08）的偏移基于 v2.8.9.2（8800604 字节），v2.9.0.1 增大了 53952 字节，
> **偏移值只能作定位起点，必须按本目录的 v2.9.0.1 重新核对。**
> v2.9.0.2 与 v2.9.0.1 路由相同、指纹 token 仅 +2 处，可作为前瞻参考，但不是运行态。

## 7. 归档说明（进 git 的范围）

**进 git**：本 README、`.gitignore`。
**不进 git**：`main-v*.min.js`（原始包，合计 8.4 MB）、`main-v*.pretty.js`（美化版，合计 26 MB）—— 已由 `.gitignore` 排除。

理由：这些是 AdsPower 的完整商业代码副本，体积大且可再生；归档只需要**判定方法 + md5 对照表**，需要复现时按 §5 命令从本机 `lib/version/` 重新拷贝即可。

**校验方法**：拿到任何一份 bundle，先算 md5，再对 §1 表格——md5 一致才说明是同一个基线，否则偏移不可通用。

```
3b0d2fc7984f051de23b3d66192bdd4c  main-v2.9.0.1.min.js   ← 运行态基线
b197782ba75b390785f3589e83604f54  main-v2.9.0.2.min.js   ← 已下载未激活
846185c95bb5c09744c4896b8474e48b  main-v2.8.9.2.min.js   ← 01–08 的偏移基于它
```