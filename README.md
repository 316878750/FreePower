# FreePower

独立实现的指纹浏览器（AdsPower 同类产品）：**多环境隔离 + 代理绑定 + 指纹一致 + 本地 API**。

内核用官方 Chrome for Testing（独立进程），指纹通过 CDP 注入与启动参数实现，不搬运 AdsPower 的私有代码、二进制、资源与商标。

> 当前阶段：**P6 完成**（Electron 桌面壳 + NSIS 安装包，有托盘/单实例/关机前清残留）。之前：P1 存储/校验/启停、P3 前置代理 fail-closed、P2 自检与四维确定性噪声、P4 本地 API 完整化 + 批量启停、P5 Web 管理控制台。
> 阶段细节见 [P1](docs/02-P1-交付.md)、[P3 前置](docs/03-P3前置-代理与启动参数.md)、[P2](docs/04-P2-自检与注入补全.md)、[P4](docs/05-P4-本地API完整化.md)（附 [curl 实测记录](docs/05-P4-curl实测.md)）、[P5](docs/06-P5-Web控制台.md)、[P6](docs/07-P6-桌面壳.md)，技术路线见 [技术方案](docs/00-技术方案.md)。

## 一、范围（先看这个，避免后面被要求补）

### 做

- 环境（profile）增删改查、分组、指纹重生成
- 启动/关闭浏览器实例：独立 `--user-data-dir`、独立进程、随机 CDP 端口、进程树回收
- 指纹：UA / UA-CH / 语言 / 时区 / 屏幕与 DPR / WebGL vendor+renderer / Canvas 种子化噪声 / Audio 噪声 / WebGL 图像噪声 / client rects 噪声 / hardwareConcurrency / deviceMemory / media devices / platform / 字体声明 / WebRTC 策略
- 自检：每个环境启动后自动跑一次真实页面探针，输出 19 项可读报告（覆盖度对齐字段表 full/partial/none），含「页面直接创建的三类 worker + 嵌套 worker」双 Realm 断言与 AudioWorklet 明确 `none`，支持 API 与本地 HTML 页。**worker 不是全覆盖**（OOPIF 子帧、启动前已在跑的 SW 仍是盲区），边界见已知限制第 6 条
- 代理：HTTP/HTTPS/SOCKS5 绑定、账号密码认证（HTTP 代理）、**fail-closed**；PAC 明确拒绝（不支持就报错，不静默降级）
- 本地 API：`/status`、环境 CRUD、分组、标签、代理列表、浏览器启停、**批量启停（并发上限 + 失败清单 + 可中断）**、自检报告；返回值形状对齐 AdsPower（`ws.puppeteer` / `ws.selenium` / `debug_port` / `status: Active|Inactive` / `cookies` / `kernels`）
- **Web 管理控制台**（`node:http` 直接托管，浏览器打开 `127.0.0.1:<端口>/` 即用）：环境列表（启动/停止/自检状态/批量操作）、环境编辑（11 组分栏表单，值域与必填来自后端注册表）、代理管理、自检报告。四个页面全部只调自己的 Local API，没有私有通道
- 未实现的 46 条云端透传接口（回收站、分享、成员、内核下载…）**明确报「不支持」**（`code:-1` + `data.supported:false`），不假成功、不留未知码
- **桌面版**：Electron 壳（单实例 / 托盘 / 关窗不退出 / 开机自启开关 / 退出前必清残留内核）+ NSIS 安装包，不需要 VS 编译链

### 不做（已和 CEO 确认，写进范围外）

- **AI Agent 模块**、**云手机模块**：一律不做，不留 UI、路由、依赖、占位。本地 API 的「脚本驱动浏览器」是基础能力，与 AI 模块无关，保留。
- 账号 / 计费 / 团队协作 / 云端同步：不做。
- AdsPower 54 条路由里 46 条是往它自己云端透传的，我们没有云，这 46 条照做没有意义：只做本地能自洽的那部分。
- 自编译 Chromium 内核（见下面「已知限制」第 1 条）。

## 二、技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node.js ≥ 22.5（ESM） | 当前验证于 v24.14.1 |
| 存储 | `node:sqlite`（内置） | 零原生依赖，单文件 `data/freepower.db` |
| 本地 API | `node:http` + 自写路由/限流/鉴权 | 零第三方依赖 |
| CDP 客户端 | 自写 WebSocket（`src/kernel/cdp.js`） | 只实现需要的帧类型，无 `ws` 依赖 |
| 内核 | 官方 Chrome for Testing | P0 用系统 Chrome 验链路，P1 接 CfT 版本矩阵 |
| 主程序 UI | 原生 JS + 自写极简视图层，`node:http` 托管静态页 | 不引前端框架、不建构建链 |
| 桌面壳 | Electron（主进程内起同一个服务，窗口 loadURL 到它） + electron-builder | 只做窗口/托盘/单实例/自启，**不重写服务**；无 native 模块，不需要 VS 编译链 |

刻意保持 **零运行时依赖**：一开始就装一堆包，后面每次改内核启动参数都要跟着升级，收益不抵成本。

## 三、快速开始

```powershell
cd C:\Users\1\.dsh\bot\workspace\freepower
npm start
```

启动后：

- API：`http://127.0.0.1:53380`（53380 起，被占用就往后找，最多 20 个端口）
- 发现文件：`data/local_api`，里面有实际地址和 `api_key`
- 数据目录：`data/`（库、每个环境的 user-data-dir、日志）

> 端口用 53380 起是为了避开本机已装的 AdsPower（50325）。

指定内核：

```powershell
$env:FREEPOWER_CHROME='C:\path\to\chrome.exe'; npm start
```

桌面版（Electron 壳，见第六节）：

```powershell
npm install            # 首次：装 electron / electron-builder（约 150MB，可用 ELECTRON_MIRROR 加速）
npm run desktop        # 开发态起桌面壳
npm run dist:win       # 打 Windows 安装包 → release\FreePower-<ver>-setup.exe
```

## 四、本地 API

鉴权：`api-key` 头（对齐对手）、`api_key` 查询参数 / 头、`Authorization: Bearer`。**本地校验，离线可用**（对手是远端校验，离线不可用，这是我们有意做的差异）。

限流：`/status` 不限流；其余路由默认 1 次/秒，带 `x-freepower-client: mcp` 或 `x-adspower-client: mcp` 头走 30 次/秒。控制台自己带 `x-freepower-client: ui`，额度 60 次/秒（一次操作会连发几个请求，按 1/s 会把自己挡在门外；仍然是限量，不是「带某头就免限」）。超限报文与对手逐字一致（HTTP 200，脚本按这句判断要不要重试）：

```json
{"code":-1,"msg":"Too many request per second, please check"}
```

CORS：只放行 `127.0.0.1` / `localhost` 的 Origin，其他返回 `403` + 纯文本 `CORS ERROR`。

### 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/status` | 探活，`{"code":0,"msg":"success"}`，免鉴权、**不限流** |
| GET | `/api/v1/user/list` | 环境列表（`page` / `page_size` / `group_id` / `name`） |
| POST | `/api/v2/browser-profile/list` | 环境列表（v2：`limit` **不传只回 1 条**，照抄对手） |
| GET | `/api/v1/user/detail` | 单个环境 |
| POST | `/api/v1/user/create` | 建环境 |
| POST | `/api/v1/user/update` | 改环境 |
| POST | `/api/v1/user/delete` | 删环境（运行中会先停） |
| POST | `/api/v1/user/regroup` | 改分组 |
| POST | `/api/v1/user/new-fingerprint` | 整组重生成指纹（≤10 个） |
| GET | `/api/v1/group/list` | 分组列表 |
| POST | `/api/v1/group/create` | 建分组 |
| POST | `/api/v1/group/update` / `delete` | 改 / 删分组（删组把环境挪回 Default，不连带删环境） |
| GET | `/api/v1/browser/start` | 起环境（支持 `launch_args` 覆盖、`force=1`） |
| GET | `/api/v1/browser/stop` | 关环境（没开 → `800002`；成功**没有 `data`**） |
| GET | `/api/v1/browser/active` | `{status:"Active",...}` 或 `{status:"Inactive"}`（缺 id → `100002`） |
| GET | `/api/v1/browser/local-active` | 本机已开环境 `{list:[...]}` |
| POST | `/api/v1/browser/cloud-active` | **明确报不支持**（云端能力，本地没有），不会假成功 |
| POST | `/api/v1/browser/batch-start` | 批量起（并发上限、失败清单、可中断）— FreePower 扩展 |
| POST | `/api/v1/browser/batch-stop` | 批量停 — FreePower 扩展 |
| POST | `/api/v2/browser-profile/stop-all` | 关掉本机全部 |
| GET | `/api/v2/browser-profile/cookies` | `{cookies:"<login_cookie 原文>"}` |
| GET | `/api/v2/browser-profile/kernels` | `{list:[{kernel_type,kernel,is_downloaded}]}`（`kernel_type` 非法 → `100002`） |
| POST | `/api/v2/browser-tags/list` / `create` / `update` / `delete` | 标签 CRUD（本地实现） |
| POST | `/api/v2/proxy-list/create` / `update` / `list` / `delete` | 代理列表 CRUD（本地实现；create 的 body 是**顶层数组**） |
| POST | `/api/v1/proxy/check` | 代理预检：先验一下代理再绑环境（`data.ok` 是检查结果，失败也 `code:0`） |
| GET | `/api/v1/browser/selfcheck` | 自检报告（`user_id`；`rerun=1` 重跑） |
| POST | `/api/v2/browser-profile/create` | 建环境（v2 形状：`launch_args` 出站数组、`password_filling` 单布尔） |
| POST | `/api/v2/proxy/check` | 代理预检 |
| GET | `/api/v2/browser-profile/selfcheck` | 自检报告（`profile_id`；`rerun=1` 重跑；`format=html` 出自检页） |
| POST | `/api/v2/browser-profile/selfcheck-summary` | 批量取自检摘要（列表页那一列用，`{list:{id:摘要}}`） |
| GET | `/api/v2/browser-profile/schema` | **编辑表单的 schema**：11 组 131 字段的类型/值域/必填/默认值，与后端注册表同一份 |
| POST | `/api/v2/browser-profile/validate` | 只校验不落库：与 create/update 同一个 `validateProfile`，返回 `{ok,errors[],warnings[]}` |
| GET | `/` | **Web 管理控制台**（静态页，注入本地 api_key；外站 Origin 403） |
| GET | `/ui/*` | 控制台资源（`app.js` / `style.css` / `pages/*.js`），越权路径一律 404 |

未实现的云端透传接口（回收站、分享、成员体系、内核下载、fb/*…）统一返回：

```json
{"code":-1,"msg":"FreePower 不支持该接口（AdsPower 依赖其云端，本地没有对应能力）：/api/v2/browser-profile/share","data":{"supported":false,"path":"..."}}
```

错误码只有 6 个，脚本不会拿到未知码：`-1` 通用 / `100001` 环境不存在 / `100002` 参数非法 / `800002` 未在运行 / `800003` 启动失败 / `800005` 启动前一致性校验不通过。

批量启停（FreePower 扩展，响应形状）：

```json
{"code":0,"msg":"success","data":{
  "requested":3,"concurrency":3,"interrupted":false,"elapsed_ms":8120,
  "started":[{"profile_id":"a1","pid":123,"ws":{"puppeteer":"ws://..."},"debug_port":"60001","already_running":false}],
  "already_running":[],
  "failed":[{"profile_id":"a2","code":800003,"reason":"proxy_unreachable","message":"..."}],
  "skipped":["a3"]}}
```

`interrupted:true` 表示中途失败后**没有继续起剩下的**，剩下的原样在 `skipped` 里；起成功的不会回滚，用户能明确知道哪些成了。

`browser/start` 返回（形状按拆解手 05 号契约）：

```json
{"code":0,"msg":"success","data":{
  "profile_id":"kjkvcd","pid":1234,
  "ws":{"puppeteer":"ws://127.0.0.1:60328/devtools/browser/b742df5a-...",
        "selenium":"127.0.0.1:60328"},
  "debug_port":"60328","status":"running","already_running":false,
  "proxy":{"ok":true,"ip":"203.0.113.9","countryCode":"JP","timezone":"Asia/Tokyo"},
  "egress":{"ok":true,"ip":"203.0.113.9","countryCode":"JP"},
  "ua_aligned":null,
  "launch_args":{"applied":[],"rejected":[]},
  "selfcheck":{"ok":true,"score":79,"total":15,"pass":7,"warn":8,"fail":0,
               "full":7,"partial":7,"none":1,
               "hashes":{"canvas":"7eca175f","webgl_image":"3e6069c5","audio":"ada0a40f","client_rects":"1e14d3ce"},
               "report_url":"/api/v2/browser-profile/selfcheck?profile_id=..."},
  "warnings":[{"field":"proxy","message":"未绑定代理：出口即本机 IP…","severity":"soft"}]}}
```

三条硬规则：`ws.selenium` 只放 `host:port`；`debug_port` 是字符串；重复调用 `start` 幂等（返回同一 `pid`，`already_running:true`）。
新增字段都是超集（`proxy` / `egress` / `selfcheck` / `ua_aligned` / `launch_args` / `warnings`），旧字段一个没动。

代理不可用时 `start` 返回 `code:800003` + `data.reason:"proxy_unreachable"` + `data.proxy_check` 诊断，**内核进程根本不会启动**（fail-closed，详见 [P3 前置](docs/03-P3前置-代理与启动参数.md)）。

### 例子

```powershell
$key = (Select-String -Path data\local_api -Pattern 'api_key=(.*)').Matches[0].Groups[1].Value
$h = @{ api_key = $key; 'x-freepower-client' = 'mcp' }

Invoke-RestMethod -Uri 'http://127.0.0.1:53380/api/v1/user/create' -Method Post -Headers $h `
  -ContentType 'application/json' -Body '{"name":"env-a","country":"US","open_urls":["https://example.com"]}'

Invoke-RestMethod -Uri 'http://127.0.0.1:53380/api/v1/browser/start?user_id=<profile_id>' -Headers $h
```

## 五、Web 管理控制台

`npm start` 之后浏览器直接打开 `http://127.0.0.1:<端口>/`（端口看 `data/local_api`）。不用装任何东西，也没有第二套进程。

四个页面，范围就这些（CEO 定的，不扩）：

| 页面 | 做什么 |
|---|---|
| 环境列表 | 启动/停止/批量启停/全部停止、运行态与端口、自检摘要、搜索与分组筛选、删除 |
| 环境编辑 | 11 组分栏表单（基本信息 / 浏览器与内核 / UA 与语言 / 噪声四维 / 字体 / 屏幕与硬件 / 媒体设备 / 网络与代理 / 地理定位 / 隐私开关 / 启动与缓存），保存前实时校验 |
| 代理管理 | 代理列表增删改、按 `proxy/check` 预检出口、显示最近一次出口 IP 与国家 |
| 自检报告 | 评分、通过/告警/失败、覆盖度、四个噪声维度哈希与跨重启一致性、19 项逐条「声明值 vs 实测值」（含双 Realm 与 AudioWorklet） |

三条设计约束（都不是口号，代码里能对得上）：

1. **界面只调自己的 Local API**：`web/api.js` 里每个动作都是 `fetch` 到 `/api/v2/...`，没有任何私有通道。界面出问题时用 curl 一样能做，这也是对 API 契约的日常验证。
2. **校验只有一份**：表单的字段、值域、必填来自 `GET /api/v2/browser-profile/schema`（后端注册表生成的），错误文案来自 `POST /api/v2/browser-profile/validate`（和 create/update 同一个 `validateProfile`）。前端只做两件事：把 `errors[].field` 定位到输入框、把 `warnings[]`（含 `severity: hard|soft`）原样显示。**前端不自己编一句校验话**。
3. **删除是危险操作**：二次确认弹窗写明「本地硬删、不可恢复、连 user-data 一起删」；环境在运行会先停再删，删完连 `data/profiles/<no>_<id8>/` 一起清掉，不留孤儿进程也不留几个 G 的脏目录。

界面截图（真实环境，5 个环境 + 1 个在跑）：

![环境列表](docs/shots/01-list.png)

更多：[编辑页](docs/shots/02-edit.png)、[后端校验原文回填](docs/shots/03-edit-invalid.png)、[噪声四维分栏](docs/shots/04-edit-noise.png)、[代理管理](docs/shots/05-proxies.png)、[自检报告](docs/shots/08-selfcheck.png)。完整操作清单见 [P5 文档](docs/06-P5-Web控制台.md)。

## 六、桌面壳与安装包（P6）

同一个服务，套了一层 Electron：主进程内起的就是上面那个 `node:http`，窗口 `loadURL` 到 `127.0.0.1:<port>/`。
**四页界面一个字节没改**，`web/` 仍然是零构建链。

![桌面壳](docs/shots/10-desktop-window.png)

桌面能力（都是壳的事，不碰服务）：

| 能力 | 行为 |
|---|---|
| 单实例 | 已经有实例在跑时，再点图标不会起第二个进程/第二个端口，而是把已有窗口拉到前台 |
| 托盘 | 常驻；菜单 = 打开控制台 / 运行中 N 个 / 停止全部环境 / 开机自启 / 退出 |
| 关窗不退出 | 点 × 只收进托盘，服务和内核都继续跑 |
| 托盘退出 | 先 `stopAll()`，再用命令行里的数据目录核对残留 chrome（`ensureNoChrome`：查 → taskkill → 再查），确认干净才退出；杀不掉就弹框默认留在托盘 |
| 开机自启 | `setLoginItemSettings`，默认关；开机进托盘不弹窗 |
| 安全 | `contextIsolation`/`sandbox` 开、`nodeIntegration` 关、**不挂 preload**；`window.open` 一律 deny，外链丢系统浏览器，导航出本地地址也拦 |

**诊断开关**（正式包里就有，不是后门；不改数据、不开新端口、不联网）：
`FreePower.exe --selftest` 跑一遍壳自检并写 `desktop-selftest.json`；
`--quit-after-ms=N` 到点走托盘「退出」的同一个函数（自动化验收用）；
`--show-tray-menu` 把托盘菜单弹出来（截图/演示用）。

装完：`%LOCALAPPDATA%\Programs\FreePower`，**357.4MB / 77 文件**，安装包 109.9MB；数据在 `%APPDATA%\FreePower\data`。

顺带收掉一个 P5 尾巴：HTML 自检报告不再把 master `api_key` 拼进 URL，改成 **120 秒、绑定 profile 的一次性票据**
（`POST /api/v2/browser-profile/selfcheck-ticket`）；`api_key` 走 query 的老用法保留，老脚本不受影响。

完整设计、打包踩的坑、验收记录与操作清单：[P6 文档](docs/07-P6-桌面壳.md)。

## 七、已知限制（必须如实告知用户，不藏着）

1. **Canvas / Audio / WebGL 标识 / 字体是 JS 注入，不是内核级。**
   拆解手 08 号报告实测：AdsPower 139 个指纹字段里走 CDP 注入的是 0 个，全在内核配置和启动命令行。
   所以我们这四项属于**降级实现**：能改返回值、能保证同种子可复现、能过一致性检查，
   但 `Function.prototype.toString` 痕迹、字体度量与真实字形交叉验证这些检测手段下**可被识别**。
   双 Realm 取证只补上了「页面直接创建的三类 worker + 嵌套 worker」这一层，**OOPIF 子帧、AudioWorklet、启动前已在跑的 SW 仍是盲区**（见第 6 条）。
   这是架构差距，不吹成 1:1。
2. **字体不伪装。** 只声明存在，不伪造字形与宽度度量（自检里字体项覆盖度 `none`、一律标黄）。
   伪造字体列表必须同时伪造几十种字体的宽度度量表，做不好比不做更危险。
3. **内核配置类 42 条 + `--extended-parameters` 10 条不实现**，列入「不兼容项」。
4. **SOCKS5 的账号密码只有预检支持**（Chrome 的 `--proxy-server` 不接受 SOCKS5 凭据，内核限制）；HTTP/HTTPS 代理认证走 CDP `Fetch`，只对带账号密码的代理挂载，会给请求加一跳。
5. **WebRTC 只做参数级**（`disable_non_proxied_udp`），不做 JS 层伪造 `RTCPeerConnection`。
6. **Worker 注入的覆盖范围：页面直接创建的三类 worker + 任意深度的嵌套 worker；OOPIF 子帧与启动前已在跑的 SW 不在内。**
   覆盖到的：专用 worker / SharedWorker / ServiceWorker 都能在**脚本首行之前**注入（`Target.setAutoAttach` + `waitForDebuggerOnStart`，实测三类 worker 的 `atTop` 均为 `worker`），module worker 实测同样覆盖，主帧与 worker 的 canvas 哈希同值。
   **worker 里再 `new Worker` 的嵌套层也覆盖**：每个 worker 会话自己再挂一次 `setAutoAttach`，递归下去，所以不设深度上限。实测页 → w4 → w3 → w2 → w1 → w0 共五层，五层 `atTop` 全是 `worker`、`hardwareConcurrency` 全等于主帧的伪装值，`injected` 精确为 5、`failed` 为空，整条链约 68ms（大头是 Chrome 起 worker 本身，每层只多一次本地 CDP 往返）。
   **没覆盖的：**
   ④ **OOPIF 子帧本轮不注入**（只计数不覆盖，子帧里取原生函数仍可能看到两套）。
   ⑤ **启动前就已经在运行的 SW**（只在它下次被激活时接入）。自检里那条只验证**新建 SW**，别读成「SW 已支持」。
   ⑥ **AudioWorkletGlobalScope 标 `none`**——它没有独立 target、没有干净注入通道，靠 Fetch 改源码会被 `import.meta.url` 和模块完整性检测抓；
   但**音频指纹本体不在那里**：本体是主帧 `OfflineAudioContext` 的浮点噪声，已由 `audio` 维度覆盖，`AudioWorklet` 里裸的只有 `sampleRate`/`currentTime`。
   → 换句话说：**音频指纹没有裸奔**，别把这条读成「audio 没做」。
   注：自检的 19 项里**不含**嵌套 worker 一项（自检只验证页面直接创建的三类），嵌套这条由 `test/workers.test.mjs` 的三条断言钉住。
7. **沙箱内起不了 Chrome**：Windows 沙箱禁止命名管道，Chrome 的 Mojo IPC 会以 `platform_channel.cc:112 Check failed: 0x5` 自终止。这不是产品缺陷，但**跑冒烟必须用普通终端（非沙箱）**。
8. **`https` 代理 + `https` 目标**（TLS in TLS）预检不支持，会明确报错，不静默降级。
9. **PAC 明确不支持（不是静默降级）**：`full_pac_url` 或 `proxy_type=pac` 直接报错 `100002`（建环境）/ `800003`（老数据启动，`reason=pac_unsupported`），**一个内核进程都不会起**。原因是 PAC 可能含 `DIRECT` 回退，无法保证 fail-closed。多级代理（`is_multi_level_proxy`）未实现，只对第一跳做预检。
10. **2D canvas 固定软件光栅化**（`--disable-accelerated-2d-canvas`）。GPU 2D 路径跨进程会产生不同像素，导致 canvas 哈希跨重启漂移；固定软件光栅化后四轮实测一致。代价：`chrome://gpu` 显示 Software only，canvas 密集页面略慢。
11. **远程代理下的自检有盲区**：自检页走 `http://127.0.0.1` 安全上下文；若代理强制 loopback 也走代理（非 `--proxy-bypass-list=<-loopback>` 的配置），会回落到 `about:blank`，此时报告里 UA-CH / 媒体设备明确标「本次未验证」，不标通过。
12. **轮换代理会把「出口 IP 与预检不一致」判为告警**（正常业务形态，只提示不阻断）；运行中没有代理健康检查，掉线时请求失败但不会回退直连。
13. **云端依赖的接口一律不支持**：`cloud-active`、回收站、分享、成员体系、内核下载、`fb/*`、应用/分类等 17 条（对手 54 条路由里剩下的云端透传）返回 `-1` + `data.supported:false`，**不假成功**。`cloud-active` 尤其明确：脚本若以为"环境已开"会直接下错单。
14. **批量启停的并发默认 3**（`FREEPOWER_BATCH_CONCURRENCY` 可调，请求里 `concurrency` 覆盖，夹在 1..10）。批量启动**中途失败即中断**：已经起来的保留，剩下的不硬起，返回 `failed` + `skipped`。
15. **`kernels` 的版本号区分「实测」与「猜」**：系统 Chrome 的 `Application\` 下可能同时有几个版本目录（本机实测有 156/157），而启动器实际跑哪个由注册表决定。启动过就报 `Browser.getVersion` 的真值（`probed:true`），没启动过则按目录名猜。**不要拿目录名当真实版本用。**
16. **桌面壳没有代码签名、没有自动更新**：安装包和 exe 都未签名，SmartScreen 会提示「未知发布者」；要对外发版必须补证书。壳只做窗口/托盘/单实例/自启，不做增量更新与崩溃上报。
17. **控制台的信任边界就是本机**：首页由本地服务渲染，会把 `api_key` 注入页面（等价于「本机用户能看到自己的 key」）。外站 Origin 一律 403，但这挡不住本机上的其它程序 —— 本机多用户/共享机器上，要按「同一台机器互不设防」来理解。
18. **表单里 138 个字段的中文名只覆盖常用项**：其余（尤其启动与缓存、隐私开关里的脚本旋钮）直接显示 API 字段名，配注册表里的 `note` 说明。硬翻一遍反而会让「字段名 ↔ 文档」对不上。
19. **自检 HTML 报告用一次性票据**（120 秒、绑定 profile、只在内存）替掉 URL 里的 master `api_key`。票据泄露影响面只有一个环境的报告；`api_key` 老用法仍可用。
20. **托盘图标在受限会话里注册不上**：Agent 令牌下 Electron 的 Tray 对象/菜单/消息窗口都建好了，但 Win11 通知区域里看不到图标（裸 Electron 同样如此，而直接调 `Shell_NotifyIcon` 的探针成功）—— 判定为环境限制。**正常桌面双击安装后要确认一次托盘**；兜底是再点一次图标，单实例锁会把窗口拉回来，不会把用户锁在后台。
21. **在受限终端里验桌面版要加参数**：`--no-sandbox`（Chromium 沙箱起不来会秒退）且数据目录必须落在工作区内（`%APPDATA%` 之外的写入被拦）。**用户正常桌面双击不需要任何参数。**
22. **受限环境还可能挡住内核的沙箱**：`FREEPOWER_KERNEL_NO_SANDBOX=1` 会给内核加 `--no-sandbox`，并在启动结果 `warnings` 里标 `kernel_sandbox`。默认不开 —— 沙箱该开着。
23. **安装/卸载已验通，但要在普通目录里跑安装包**：本机工作区里的 exe 带 Low 完整性标签，从工作区直接执行安装器，进程会被降到 Low IL，写 `HKCU\Software` 和开始菜单一律被拒（文件照装、注册项和快捷方式静默丢失，`Uninstall /S` 于是「退出码 0、一个文件没删」）。
    拷到 `%TEMP%` 再跑就完全正常：注册表两个键齐全、快捷方式建了、`/S` 卸载把目录和键都清干净（实测记录见 [P6 文档](docs/07-P6-桌面壳.md)）。**用户从「下载」目录双击安装不受影响。**
    另：卸载器靠 `InstallLocation` 找目录，该键丢失时会退回到 `%APPDATA%\FreePower\install-dir.ini` 里安装时写下的路径（`desktop/build/installer.nsh`），避免「删了个寂寞」。安装路径含空格时卸载后可能留一个空目录；`desktop/build/installer.nsh` 的 `un.onUninstSuccess` 里有一轮非递归 `RMDir` 收尾（目录非空必失败，所以只收空壳、不会误删文件）。
24. **对手的远端运营黑名单不接**：`DynamicConfig` 里实测多出 `BlockList` / `StrongBlockList` 两个键，是**远端下发的国内站点名单 + 版本号**，跟指纹无关，属于对手自己的运营数据。接它等于同步对手的运营策略，还得养一条下发通道，没有产品价值。
    我们做的是**用户级**名单：字段表里 `blacklist` / `whitelist`（`privacy_switches` 组）。当前覆盖度 `partial`：能存、能校验、能进 API，**注入层还没挂 `Network.setBlockedURLs`**，在接上之前按「存了但没生效」理解。
25. **我们不落任何内核配置文件，所以没有 mtime 可盯**：对手的三份配置（StaticConfig / DynamicConfig / 命令行快照）实测「内容不变就不重写、mtime 不动」——这本来是他们的反检测优点（盯 mtime 抓不到改动），但对我们反而更简单：CDP 路线改时区/地理/指纹**一律不写文件**，磁盘上没有任何「指纹配置文件」可抓、也没有 mtime 侧信道。这条是我们比对手干净的地方，写在这里当依据，不当卖点吹。

## 八、验证

```powershell
# 不需要 Chrome：schema + 单元 + 本地 API 契约 + 控制台契约 + 桌面壳契约
npm run test

# 需要真实 Chrome + 完整权限（沙箱挡命名管道和进程查询）
npm run smoke
```

当前实测：`npm run test` = schema **10** + unit **46** + api **61** + ui **29** + desktop **54**；`npm run smoke` = **152/152**（`test/smoke.mjs`）+ **24/24**（`test/workers.test.mjs`），真 Chrome `157.0.8103.40`。桌面壳的人工验收记录见 [P6 文档](docs/07-P6-桌面壳.md)。

冒烟覆盖（152 项，双 Realm 的 24 项在 `test/workers.test.mjs` 里单独列）：

- `/status` 形状、鉴权、跨站 Origin 403 纯文本、限流报文
- 建环境 → 起真 Chrome → 探针读回 UA / UA-CH / 时区 / 语言 / platform / hardwareConcurrency / WebGL / `navigator.webdriver`
- Canvas 同页连读两次一致、重启后不变、换环境后必变
- **四维噪声确定性**：canvas / webgl_image / audio / client_rects 各自种子入库，重启后哈希与种子都不漂移
- **自检**：启动后自动跑 19 项、覆盖度 7/10/2、四个哈希齐全、`rerun=1` 重跑、HTML 页可读且无外链
- **双 Realm**（`test/workers.test.mjs`，已进 `npm run smoke`）：同一张页里起专用 worker / SharedWorker / ServiceWorker（**页面直接创建的**，嵌套 worker 另有三条断言，见已知限制第 6 条），断言三者的脚本首行已注入（`atTop === 'worker'`）、五处 canvas 哈希完全一致、硬件/语言/时区/UA 与主帧同值、`workerStats.injected === 3`；另断言 AudioWorklet 未被注入且可测表面只有 `sampleRate`/`currentTime`
- **嵌套 worker**（同文件）：页面里起的 worker 再 `new Worker`，断言外层与嵌套层首行都已注入、主帧/外层/嵌套三者的 `hardwareConcurrency` 一致、两层都进注入计数 —— 防的是「同一台机器同时暴露伪装值与真实核数」
- **本地 API 完整化**：`active` 的 Active/Inactive 形状、`local-active`、`cookies`、`kernels`、标签/代理列表 CRUD、占位接口明确不支持
- **批量启停**：一次起 3 个、批量停、失败清单带 code/message、中途失败即中断、并发上限生效
- **cloud-active 明确报错**（`-1` + `supported:false`，不假成功）
- 停环境后进程树回收干净、重复 start 幂等、重复 stop 800002
- **代理 fail-closed**：死代理 `start` 失败且一个内核进程都不起；活代理下浏览器出口 IP = 预检 IP；连 `127.0.0.1` 也走代理（没有 loopback bypass）
- **PAC 明确拒绝**：建环境 `100002`；老数据启动 `800003` + 零内核进程
- **出口地理一致性**：声明时区/语言与出口不一致时会出现在 `warnings` 里
- **launch_args 白名单**：从真实 `CommandLine` 验证白名单参数生效、保护参数不在 argv 里
- **UA 跟版**：旧版本 UA 启动时对齐到真实内核版本并落库
- **控制台**：首页带 api_key、`/ui/app.js` 可加载、schema 11 组 131 字段、表单校验接口放行 UTC 与空 cookie

## 九、目录

```
src/
  main.js              CLI 入口：起 API、打印摘要、SIGINT 回收环境
  boot.js              启动引导（CLI 与 Electron 壳共用）：找端口、写发现文件、交句柄、停机收尾
  config.js            端口/路径/限流/批量并发配置
  api/server.js        传输层：鉴权、限流、CORS、静态托管、错误整形
  api/routes.js        路由表：A 类本地组装 / B 类自己实现 / 占位明确不支持
  api/contract.js      错误码、响应外壳、launch_args 与 password_filling 边界转换
  api/schema.js        编辑表单 schema（字段分组/值域/必填，来自 packages/profile 注册表）
  api/static.js        控制台静态托管（只放 web/，路径穿越一律 404）
  api/tickets.js       自检报告的一次性票据（120 秒、绑 profile、只在内存）
  store/db.js          node:sqlite 建表、迁移补列、API Key
  store/profiles.js    环境 CRUD、分组、cookie 规范化、一致性校验
  store/tags.js        标签 CRUD（本地实现）
  store/proxies.js     代理列表 CRUD（本地实现）+ proxy_id → 启动配置
  fingerprint/         指纹生成（种子化，保证自洽）+ seeds.js（四维噪点种子入库）
  kernel/chrome.js     内核定位/清单、启动参数、DevToolsActivePort、进程树回收
  kernel/launch-args.js launch_args 白名单合并（保护名单/feature 并集）
  kernel/version.js    UA / UA-CH / kernel_version 跟版
  kernel/cdp.js        CDP over WebSocket 客户端
  kernel/inject.js     页面注入脚本（canvas/webgl_image/audio/client_rects/navigator/media devices）
  proxy/probe.js       代理预检（HTTP/HTTPS/SOCKS5）、出口信息归一
  proxy/egress.js      浏览器内出口探测（验证流量真的走了代理）
  proxy/pac.js         PAC 检测与拒绝文案（fail-closed）
  selfcheck/           自检：页面探针 / 报告 / 落盘 / 本地安全上下文服务 / HTML 渲染
  runtime/manager.js   启停、校验/预检/跟版、自动 attach 新标签页、自检、代理认证
  runtime/batch.js     批量启停：并发池、失败清单、中断
desktop/
  main.js              Electron 主进程：起服务、开窗、托盘、单实例、自启、退出收尾
  residue.js           退出前的残留 chrome 检查（WMI 查命令行 → taskkill → 再查）
  assets/tray.png      托盘图标（自绘）+ tray@2x / icon.png
  build/icon.ico       安装包与 exe 图标（自绘）
web/
  index.html           控制台外壳（api_key 由服务端注入）
  style.css            全部样式（无预处理器、无主题）
  ui.js                极简视图层：h() / mount() / toast / confirm / drawer
  api.js               Local API 客户端（界面只走这一条路）
  app.js               hash 路由 + 侧栏 + 运行态角标
  pages/profiles.js    环境列表：启停、批量、自检摘要、删除
  pages/edit.js        环境编辑：11 组分栏、实时校验（文案来自后端）
  pages/proxies.js     代理管理
  pages/selfcheck.js   自检报告
test/smoke.mjs         端到端冒烟（152 项，需真实 Chrome）
test/unit.test.mjs     零 Chrome 单元测试（35 项）
test/api.test.mjs      本地 API 契约测试（61 项，不需要 Chrome）
test/ui.test.mjs       控制台契约测试（29 项：静态托管、schema、校验、删除清目录、限流额度）
test/desktop.test.mjs  桌面壳契约测试（44 项：启动引导、票据、残留检查、安全姿势、打包配置）
test/fake-proxy.mjs    假代理 / 假出口端点（冒烟不依赖公网）
tools/make-icons.py    自绘图标生成（Pillow，不引用第三方素材）
tools/run-desktop.mjs  开发态起桌面壳（会剥掉 ELECTRON_RUN_AS_NODE 再起）
electron-builder.yml   打包配置（win-unpacked + NSIS）
docs/                  技术方案、阶段交付、curl 实测、截图（docs/shots/）
```