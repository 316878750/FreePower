# FreePower

独立实现的指纹浏览器（AdsPower 同类产品）：**多环境隔离 + 代理绑定 + 指纹一致 + 本地 API**。

内核用官方 Chrome for Testing（独立进程），指纹通过 CDP 注入与启动参数实现，不搬运 AdsPower 的私有代码、二进制、资源与商标。

> 当前阶段：**P9 完成**（媒体设备改成「真实枚举 + 只改 label」、语音按环境语言投影；字体只做探测与 `none` 标注，不写注入）。之前：P1 存储/校验/启停、P3 前置代理 fail-closed、P2 自检与四维确定性噪声、P4 本地 API 完整化 + 批量启停、P5 Web 管理控制台、P6 桌面壳、P8 外部检测对照。
> 阶段细节见 [P1](docs/02-P1-交付.md)、[P3 前置](docs/03-P3前置-代理与启动参数.md)、[P2](docs/04-P2-自检与注入补全.md)、[P4](docs/05-P4-本地API完整化.md)（附 [curl 实测记录](docs/05-P4-curl实测.md)）、[P5](docs/06-P5-Web控制台.md)、[P6](docs/07-P6-桌面壳.md)，技术路线见 [技术方案](docs/00-技术方案.md)。

## 一、范围（先看这个，避免后面被要求补）

### 做

- 环境（profile）增删改查、分组、指纹重生成；**运行中改配置可一键重启**（`POST /api/v1/browser/restart`，stop → 落库 → start 一个请求内完成，控制台里运行态保存按钮变「保存并重启」）
- 启动/关闭浏览器实例：独立 `--user-data-dir`、独立进程、随机 CDP 端口、进程树回收
- 指纹：UA / UA-CH / 语言 / 时区 / 屏幕与 DPR / WebGL vendor+renderer / Canvas 种子化噪声 / Audio 噪声 / WebGL 图像噪声 / client rects 噪声 / hardwareConcurrency / deviceMemory / media devices（**真实枚举 + 只改名字**）/ 语音（按环境语言投影 `getVoices()`）/ platform / 字体声明（只声明，不注入）/ WebRTC 策略
- 自检：每个环境启动后自动跑一次真实页面探针，输出 19 项可读报告（覆盖度对齐字段表 full/partial/none），含「页面直接创建的三类 worker + 嵌套 worker」双 Realm 断言与 AudioWorklet 明确 `none`，支持 API 与本地 HTML 页。**worker 不是全覆盖**（OOPIF 子帧、启动前已在跑的 SW 仍是盲区），边界见已知限制第 6 条
- 代理：HTTP/HTTPS/SOCKS5 绑定、账号密码认证（HTTP 代理）、**fail-closed**；PAC 明确拒绝（不支持就报错，不静默降级）；代理管理页**单条 / 批量健康检查**（出口 IP / 国家 / 延迟 / 时间，失败区分超时、认证失败、代理拒绝 CONNECT、连接被拒、DNS、TLS；批量限并发 3、单条 10s 上限，超 24h 的结果标「结果过期」）
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
| POST | `/api/v2/browser-profile/list` | 环境列表（v2：`limit` **不传只回 1 条**，照抄对手；显式给 `page_size` 时按它翻页） |
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
| POST | `/api/v1|v2/browser-profile/import` | **环境导入**：JSON 三种 body（`{list}` / `{data:{list}}` / 裸数组）都认，或 `{format:"txt", content:"..."}` 认 AdsPower `.txt` 块格式；未知字段进 `warnings`；`imported` / `failed` 顶层与 `data` 各一份（`code` 仍 0） |
| GET/POST | `/api/v1|v2/browser-profile/export` | **环境导出**：默认 `{list}`，同时带我方字段与 AdsPower 兼容键（`proxy_*`，代理密码原样）；`format:"txt"` → `data:{format,count,filename,content}`（AdsPower 块格式，**不含 list**）；`{profile_id:[...]}` 或 GET 多个 `profile_id` |
| POST | `/api/v1|v2/browser-profile/copy` | **复制环境**：指纹配置原样，`fp_seed` 与四个噪声种子**全部重生**，返回 `seeds_regenerated:true`；`copy_cookies` 默认关 |
| GET | `/api/v1|v2/browser-profile/cookie/export` | **cookie 导出**（`format=json|netscape`）；**要求环境在跑**，没跑报 `800002`，不会为了导出偷偷起内核 |
| POST | `/api/v1|v2/browser-profile/cookie/import` | **cookie 导入**：`cookies` 数组或 `{format:"netscape", content:"..."}`；要求环境在跑；`imported>0` 时回读校验 |
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
| 环境列表 | 启动/停止/批量启停/全部停止、运行态与端口、自检摘要、搜索与分组筛选、删除；工具条「导入」（JSON 三种形状，或 AdsPower `.txt`，按扩展名/首字符自动识别）、「导出 txt」（当前勾选或筛选结果 → AdsPower 块格式，值里的换行会替换并提示），每行「导出」JSON（保真备份）、「复制」（复制=配置原样、四个指纹种子重生） |
| 环境编辑 | 11 组分栏表单（基本信息 / 浏览器与内核 / UA 与语言 / 噪声四维 / 字体 / 屏幕与硬件 / 媒体设备 / 网络与代理 / 地理定位 / 隐私开关 / 启动与缓存），保存前实时校验；Cookie 一栏带「导出 cookie（JSON / netscape）」「导入 cookie 文件」（**需要环境运行中**：cookie 在内核里，和这一栏的登录 cookie 文本不是一份数据） |
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
2. **字体不伪装（P9-B 结论：不写注入，只探测 + 标 `none`）。** 只声明存在，不再伪造字形与宽度度量（自检里这一项叫「字体枚举面」、覆盖度 `none`、一律标黄）。
   根治要**自编译 Chromium**（把宿主字体集换成目标平台字体集）；JS 层做「字体投影」只能改 `measureText` / `document.fonts` 的返回值，改不了真实字形与宽度度量，**会造出新的不一致，风险大于收益**。
   **标 `none` 不等于字体指纹裸奔**：canvas 文本噪声已覆盖字形渲染这一类；裸的是「宿主装了哪些字体」这个**枚举面**（本机实测枚举到 `Microsoft YaHei` / `Microsoft YaHei UI` / `SimSun` / `SimHei` / `KaiTi` / `FangSong`）。
3. **内核配置类 42 条 + `--extended-parameters` 10 条不实现**，列入「不兼容项」。
4. **SOCKS5 的账号密码只有预检支持**（Chrome 的 `--proxy-server` 不接受 SOCKS5 凭据，内核限制）；HTTP/HTTPS 代理认证走 CDP `Fetch`，只对带账号密码的代理挂载，会给请求加一跳。
   AdsPower 形状的 `proxy_host` / `proxy_port` / `proxy_user` / `proxy_password` **全链路都认**（`checkProxy` 预检、`--proxy-server`、CDP `Fetch.authRequired`）；`buildArgs` 在「已绑定代理但 host/port 拼不出来」时**直接抛错**，绝不退回直连（fail-open 已修）。
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
    另：卸载器靠 `InstallLocation` 找目录，该键丢失时会退回到 `%APPDATA%\FreePower\install-dir.ini` 里安装时写下的路径（`desktop/build/installer.nsh`），避免「删了个寂寞」。**这条兜底不是预防性代码**：本安装包装完注册表 9 个值里确实没有 `InstallLocation`，每次卸载都走 INI 兜底。
    空目录残留已修并在打包版实测：根因不是路径含空格，而是卸载器 `un.onInit` 里的 `SetOutPath $INSTDIR` 把进程当前目录压在安装目录上，Windows 不允许删任何进程的当前目录，于是 `RMDir /r $INSTDIR` 删光文件、留个空壳。修法是在删文件之前 `SetOutPath "$TEMP"`（`customUnInstall` 钩子）。两轮实测：含空格自定义路径（`%TEMP%\fp space test3\inst dir`）与默认路径（双击场景）都是 77 文件 / 注册表 9 值 / 两个快捷方式 → `/S` 卸载后文件 0、**目录消失**、注册项与快捷方式清空。
    （试过但已否掉：在 `un.onUninstSuccess` 里补一次非递归 `RMDir` —— 这个回调在 electron-builder 生成的卸载器里根本不会被调用，写了日志文件一次都没出现。）
24. **对手的远端运营黑名单不接**：`DynamicConfig` 里实测多出 `BlockList` / `StrongBlockList` 两个键，是**远端下发的国内站点名单 + 版本号**，跟指纹无关，属于对手自己的运营数据。接它等于同步对手的运营策略，还得养一条下发通道，没有产品价值。
    我们做的是**用户级**名单：字段表里 `blacklist` / `whitelist`（`privacy_switches` 组）。当前覆盖度 `partial`：能存、能校验、能进 API，**注入层还没挂 `Network.setBlockedURLs`**，在接上之前按「存了但没生效」理解。
25. **我们不落任何内核配置文件，所以没有 mtime 可盯**：对手的三份配置（StaticConfig / DynamicConfig / 命令行快照）实测「内容不变就不重写、mtime 不动」——这本来是他们的反检测优点（盯 mtime 抓不到改动），但对我们反而更简单：CDP 路线改时区/地理/指纹**一律不写文件**，磁盘上没有任何「指纹配置文件」可抓、也没有 mtime 侧信道。这条是我们比对手干净的地方，写在这里当依据，不当卖点吹。
26. **外部检测站对照：`like headless` 已压到与裸 Chrome 持平（25% vs 25%），但这只是「不比裸 Chrome 更像 headless」，不是「过了检测站」**：用 creepjs 在同一台机器跑两遍（`plain` = 同内核同参数零注入，`ours` = 走 FreePower 起环境）。P7 收尾时是 25% → **38%**，多出来的 13 个百分点全来自两条：`noTaskbar`（我们把 `screen.availHeight/availWidth` 设成等于屏幕，等于「没有任务栏」）和 `hasVvpScreenRes`（窗口/视口尺寸等于屏幕，那是 headless 的默认形态）。P8-C 修掉这两条（`avail*` 留出任务栏、窗口比屏幕小一圈），复跑 25% → **25%**，逐项标志位与 plain 完全一致。
    - **P8-D**：`navigator.deviceMemory` 现在默认取真实内存档位（这台机器 96G → Chrome 报 32，我们报 32），与 `performance.memory.jsHeapSizeLimit`（4.09GB，跟真实内存走、我们不碰）不再打脸；单环境仍可显式改 `device_memory`（值域已扩到 16/32，因为 Chrome 157 实测会返回 32）。
    - 复跑：`node tools\detector-compare.mjs`（出对照表，落 `artifacts/detector-compare.json`），两轮实测记录见 [docs/11](docs/11-外部检测对照.md)。
    - 另有两条**不是注入造成**、属这台中文 Windows 的固有泄漏：creepjs 的 `platform hints` 暴露 `Microsoft YaHei UI`（字体枚举面，P9-B 只标注不注入），以及 `speechSynthesis` 的中文声音。**语音已处理（P9-A）**：按环境 `language` 投影 `getVoices()`，实测 ours 从 25 条（首条 `Microsoft Huihui - Chinese (Simplified, PRC)` / zh-CN）降到 6 条（首条 `Microsoft Mark - English (United States)` / en-US），宿主中文声音被挡掉；边界见已知限制第 31 条。字体那条仍是机器属性，`plain` 与 `ours` 一致。
    - **别把自检的 `pass 10 / warn 9 / fail 0` 读成「过了检测站」**：自检只证明我们注入的东西自己一致，五处 canvas 哈希相同也只证明噪声同源。唯一的对外证据是上面那张对照表。
27. **运行中不做「热改注入参数」，只做重启**：`POST /api/v1/browser/restart`（v2 同名）语义是 stop → 落库 → start，一个请求内完成；apply 或 start 任一步失败都保持 **stopped**，绝不会留下一个「还在跑旧代理/旧指纹」的内核。**为什么不热改**：CDP override 确实能热改时区/地理/语言，但注入脚本（`addScriptToEvaluateOnNewDocument`）已经在页面里跑过一轮，热改只会让主帧与 worker 出现两套值 —— 那正是我们自己的双 Realm 漏洞，宁可让用户短暂离线。
28. **代理检测的边界**：批量检查限并发 **3**、单条上限 **10s**（超时记 fail，不拖住整批），上限是常量 `src/proxy/health.js`（`HEALTH_CONCURRENCY` / `HEALTH_TIMEOUT_MS`），没有做成可调参数；`https` 代理的 TLS-in-TLS 预检不支持（见第 8 条）。**失败结果只存在当前页面会话里**（库里只有 `rememberProxyCheck` 落下的「上次成功出口」），刷新控制台后失败原因就没了 —— 这是故意的：检测是只读操作，不为它加表。列表里超过 24 小时的结果按「结果过期」显示，不当成现状。
29. **代理凭据与指纹参数不进命令行（这一点我们和对手相反）**：逆向 08/09 号报告实测 AdsPower 把噪声种子、时区、出口 IP、地理坐标、配置文件路径、`UserId` 以 `--protected-*` **明文**挂在每个子进程命令行上，本机任何进程读一次 `Win32_Process.CommandLine` 就能拿全。我们的 `--proxy-server` 只带 `http://host:port`，HTTP/HTTPS 认证走 CDP `Fetch.authRequired`（第 4 条），指纹参数走 CDP + 注入。**这不是读码结论**：`npm run test:cmdline` 用 `Win32_Process.CommandLine` 读该环境全部 chrome 进程实测（见第八节）。
30. **媒体设备改成「真实枚举 + 只改名字」（P9-C），不再伪造设备列表。** 逆向我们的人用自己的探针实测过旧做法三条破绽：跨 origin `deviceId` 恒定、未授权就返回非空 label、报得出摄像头但 `getUserMedia({video:true})` 抛 `NotFoundError`。
    现在的做法：`enumerateDevices()` 先调内核真值，**未授权原样返回**（label 天然空串）；授权后只按 kind 的第 i 个设备改名，`deviceId` / `groupId` / `kind` 原样保留 —— 跨 origin 加盐由内核负责。命名池不够用时用 Windows 自己的 `2- ` 前缀去重，**不让两个 deviceId 挂同一个 label**。`media_devices_num` 只作「授权后的命名池」，**不再决定列表长度**。
    依据：**「造一整套假设备」不如「给真实设备改名」隐蔽**（AdsPower 走的也是这条路）。实测未授权 `{audioinput:1, videoinput:0, audiooutput:1}`、id/label 全空；授权后枚举与 `getUserMedia` 一致，`track.label` 等于枚举里对应设备的名字；跨 origin `deviceId` 不同。复跑：`npm run test:media-devices`。
    两处复验后补的坑（P9-C 第二轮）：
    - **不能自造 `MediaDeviceInfo` 对象**：`Object.create(MediaDeviceInfo.prototype)` 没有内核内部槽位，页面一 `JSON.stringify(设备列表)` 就抛 `Illegal invocation`；而原生 `toJSON` 又按槽位取宿主真名，绕过我们的改名。现在直接在**真实对象**上 `defineProperty('label')`，并覆盖 `MediaDeviceInfo.prototype.toJSON`（先用原生 toJSON 拿全字段，再换 label）。残留：`Object.getOwnPropertyDescriptor(d,'label')` 是 own property，原生是原型上的 accessor —— 比抛异常轻得多，但仍是可观测差异（我们把 own label 定义成 **non-enumerable**，`Object.keys(d)` 与展开运算符的行为仍和原生一致）。
    - **权限按 kind 判**：Chrome 只给摄像头时，音频 label 仍是空串。原来的 `camera || microphone` 一把梭会让音频也改名。现在分别查 camera / microphone，`videoinput` 看 camera、`audioinput`/`audiooutput` 看 microphone；授权撤销时把打过补丁的对象还原。

31. **语音投影的边界（P9-A）**：只从内核真实列表里**保留环境语言（含同语种变体）**，其余原样丢弃；不新建 voice 对象，只覆盖 `default`（正好一条），所以 `speak` / `cancel` / `SpeechSynthesisUtterance` 行为不受影响。**宿主连一条该语言的声音都没有时保持原生、不凭空造**（本机实测缺 `vi-VN` / `th-TH`，造出来的名字 `speak` 点不着，反而多一层破绽）；声音未加载时照原生返回空数组，`onvoiceschanged` 由内核触发一次、我们不补造。`speech_switch` 默认开（关掉要显式写 `'0'`）。
32. **CDP 直建带 URL 的标签要补一次重载（P9-C 复验第三轮）**：外部自动化常用 `Target.createTarget({ url })`，attach 时首个文档已在加载，`addScriptToEvaluateOnNewDocument` 只对下一个文档生效 —— 首帧是裸指纹（实测 `hardwareConcurrency` 是宿主 32，配置是 6）。现在 attach 后对**非空白页**统一等文档就绪、确认 `window.__fpApplied`，没有就补一次 `Page.reload`（比按 URL 猜可靠，也不会多刷已注入好的页面）。真机断言：`npm run test:cdp-page`。**代价**：这张页面会多一次加载，页面里若有「首屏就上报」的埋点会看到两次 load；残留一条 `performance.getEntriesByType('navigation')[0].type === 'reload'` —— 页面读自己的性能时间线就能知道刚被刷过一次（逆向实测）。

33. **环境导入/导出是「搬运」，复制是「克隆配置换指纹」（P10）**：导出里**包含代理密码明文**（这是本机用户自己的数据，本地 API 已鉴权 —— 但别把导出文件当可公开分享的文件）。导入会**重新生成 id / profile_no / 时间戳**，其余字段（含 `fp_seed` 与 `canvas_id` / `webgl_image_id` / `audio_id` / `client_rects_id`）原样落库，所以导出 → 删掉 → 再导入，四个噪点哈希不变（`npm run test:fileio` 实测 0 字段差异、四个哈希完全一致）。未知字段只进 `warnings`（不报错、不影响其它条）。
    复制**必须**换掉全部四个种子：只换 canvas 会在 WebGL 图像噪声那条上仍然同源，等于把两个账号主动关联起来。实测复制体 `canvas / webgl_image / audio / client_rects` 四个哈希全不同，UA / 时区 / 屏幕 / 核数与源一致。
    两种导入格式：**我们的 JSON**（保真备份，含指纹配置）与 **AdsPower `.txt` 块格式**（`format:"txt"`，单文件、每块 18 字段 + 18 个 `*` 收尾；逆向实测形状）。`.txt` 是「账号 + 代理 + cookie + UA」的**搬运单，不是环境全量备份** —— 四个种子、字体、媒体、时区、屏幕、`open_urls` 一个都不在里面，别以为导出了 txt 就备份完了。导出 txt 时值里的 `\r`/`\n` 会替换成一个空格（一行一字段），并在 `data.warnings` 里报数；写出后**立刻按同一解析器读回自校验**（块数 / 18 键 / cookie 可 JSON.parse / proxy 四段），失败就报非 0，不输出半坏文件。
    边界：AdsPower 的代理是**一个字符串** `host:port:user:pass`（已认，密码可含 `:`，切不出来就进 `warnings` 并写明「代理为空」，不静默丢）；cookie 是**对象数组**（落库原样保留，`JSON.parse` 回来仍是对象，不会变成 `["[object Object]"]`）；`sameSite` 用对方四值 `no_restriction/lax/strict/unspecified`，**内核没声明就写 `unspecified`，绝不补默认 `lax`**；分区 cookie（CHIPS）的 `partitionKey` / `CookiePartitionKey` 双向都认。我们自己的 cookie 导出仍是 `json` / `netscape` 两种，`expires` 对外 unix 秒（导入兼容毫秒；session 在 json 里 `-1`、netscape 里 `0`）。
34. **cookie 导入/导出只走运行中内核（P10）**：用 CDP `Storage.getCookies` / `Storage.setCookies`，**不读 user-data-dir 里的 SQLite**（值用 DPAPI 加密，跨机器解不开），也**不为了导出偷偷起内核**。环境没在跑时两条路由都明确报 `800002`（文案写清「请先启动该环境」）。`imported > 0` 时会立刻回读，缺条目进 `warnings`，不假装成功。
    边界：`copy_cookies` 打开时要求源环境在跑，读到的 cookie 以**登录 cookie 文本**回写到新环境（`/api/v2/browser-profile/cookies` 可读），**不是**把内核实时读到的 SQLite 复制过去（那份数据既加锁又不完整）。需要「副本启动后原样带登录态」的场景，请在副本启动后用 `cookie/import` 再导入一次。
35. **注入函数的源码可以被 `Function.prototype.toString.call` 读到（P9-C 复验发现，未修）**：`native()` 只挂了函数自己的 `toString` 属性，所以 `String(fn)` 是 `[native code]`，但 `Function.prototype.toString.call(fn)` 对任何 JS 函数都返回真源码 —— 逆向实测 9 个入口泄漏（`enumerateDevices` / `MediaDeviceInfo.toJSON` / `hardwareConcurrency` getter / `toDataURL` / `getImageData` / `getBoundingClientRect` / `WebGL.getParameter` / `AudioBuffer.getChannelData` / `getVoices`），还会把 `CFG` / `seedForCanvas` 这些内部名字一起交给页面。**这是 JS 注入路线相对内核/DLL 替换的结构性差距**（AdsPower 在内核层替换，天然没有这条）。方向是把最常被检查的几项挪到内核/CDP 层、JS 层只留兜底；在修掉之前**不要把「native() 已伪装」当成「检测方看不见」**。泄漏清单已用集合相等锁在 `npm run test:native-tostring`（不要改成计数断言），逆向裁判跑 `npm run test:p9c-judge`（恒红是现状，L1 就是这条；不放进默认 `npm test`）。
36. **新建环境首次启动后，cookie 罐里会有一条内核自己写的 `NID@.google.com`（P10 验收实测，不是我们干的）**：主门 K1 里一个刚建、什么都没访问的环境，`cookie/export` 读出 3 条，其中一条是 `NID@.google.com`。用我们自己的 `buildArgs` 起一个全新 `user-data-dir` 的**裸内核**、不做任何导航、等 10 秒后直接读 cookie 罐，实测 `cookie 条数 = 1 | 清单 = ["NID@.google.com"]`、`page targets = ["chrome://newtab/"]`、`chrome 残留 = 0`：`--no-first-run` 挡不住新标签页后台那一次 google 请求，裸 Chrome 同样有。
    所以：新建环境首次启动后「导出全部 cookie」会带上它，跨环境搬运也会连它一起搬 —— 无害但是噪音。**不要**为它加过滤：裸 Chrome 有、我们没有，反而成了能被动检测的特征。同理，「刚建的环境导出 cookie 不是 0 条」不是 bug，别当异常去修。


## 八、验证

```powershell
# 不需要 Chrome：schema + 单元 + 本地 API 契约 + 控制台契约 + 桌面壳契约
npm run test

# 需要真实 Chrome + 完整权限（沙箱挡命名管道和进程查询）
npm run smoke
```

当前实测：`npm run test` = schema **10** + unit **64** + api **95** + ui **29** + desktop **54**；`npm run smoke` = **152/152**（`test/smoke.mjs`）+ **24/24**（`test/workers.test.mjs`），真 Chrome `157.0.8103.40`。桌面壳的人工验收记录见 [P6 文档](docs/07-P6-桌面壳.md)。

**外部检测对照**（不属于 `npm run test`，需要外网，约 2 分钟）：

```powershell
node tools\detector-compare.mjs   # plain（零注入基线）与 ours 各跑一遍 creepjs，直接出对照表
```

结果落 `artifacts/detector-compare.json`，实测结论与限制见 [docs/11](docs/11-外部检测对照.md) 与已知限制第 26 条 —— **这份表是唯一能对外说「检测方怎么看我们」的证据**，自检数字不算。

**运行中重配（restart）真机验证**（需要真实 Chrome，约 40 秒，独立于 `npm run smoke`）：

```powershell
npm run test:restart   # 12 项：停旧内核 → 落库 → 按新配置起；断言旧 pid 已退出、只剩一个主进程、页面真的读到新时区
```

**命令行泄漏自查**（需要真实 Chrome，约 20 秒，独立于 `npm run smoke`）：

```powershell
npm run test:cmdline   # 8 项：起一个绑了代理账号密码的环境，用 Win32_Process.CommandLine 读它全部 chrome 进程
```

断言命令行里没有代理密码、没有代理用户名、没有时区值、没有 `--protected-*`，代理只以 `--proxy-server=http://127.0.0.1:PORT` 出现；同时断言读到的命令行非空、`--user-data-dir` 确实含本环境 id 的前 8 位 —— 这两条是**防假阴性**用的：过滤条件写错时会读到空串，那样所有「不含密码」的断言都会假通过。依据与对手的对照见已知限制第 29 条。

**媒体设备 / 语音投影真机验证**（需要真实 Chrome，约 40 秒，独立于 `npm run smoke`）：

```powershell
npm run test:media-speech   # media-devices 12 项（枚举/改名/JSON.stringify/按 kind 授权）+ speech 8 项
npm run test:cdp-page       # 3 项：CDP 直建带 URL 的页面，注入必须生效、hc/语言是配置值
```

**环境导入/导出/复制与 cookie 真机验证（P10，需要真实 Chrome，约 90 秒）**：

```powershell
npm run test:fileio   # 19 项：导出→删→导入逐字段+四个哈希一致；同一环境重启对照；复制体四个哈希全不同；
                      #       cookie json/netscape 两种格式、跨环境搬运、环境没在跑报 800002（不偷偷起内核）
```

**注入函数源码一致性（已知限制 35 的回归监视，需要真实 Chrome，约 20 秒）**：

```powershell
npm run test:native-tostring   # 3 项：9 个入口的 Function.prototype.toString.call 泄漏集合（集合相等，不是计数；
                               #       删一个入口或换成别的东西泄漏，计数会骗人）
npm run test:p9c-judge         # 逆向拆解师的独立裁判（两套环境约 2 分钟）。恒红是现状：L1 = toString 泄漏，
                               #       不放进默认 npm test —— 红出来的正是这一条，别让它被习惯性忽略
```

**代理健康检查真机验证**（需要真实 Chrome + 本机起 HTTP 服务，约 20 秒）：

```powershell
npm run test:proxy-health   # 15 项：好代理/密码错/死端口/黑洞四态、批量并发与超时、脏 id、只读、控制台点击
```


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
test/unit.test.mjs     零 Chrome 单元测试（58 项）
test/api.test.mjs      本地 API 契约测试（73 项，不需要 Chrome）
test/ui.test.mjs       控制台契约测试（29 项：静态托管、schema、校验、删除清目录、限流额度）
test/desktop.test.mjs  桌面壳契约测试（54 项：启动引导、票据、残留检查、安全姿势、打包配置）
test/workers.test.mjs  双 Realm 真机验证（24 项：三类 worker + 嵌套 + AudioWorklet）
test/proxy-health.test.mjs  代理健康检查真机验证（15 项：四态 / 批量 / 只读 / 控制台）
test/media-devices.test.mjs 媒体设备真机验证（P9-C，12 项：真实枚举 + 只改 label + toJSON + 按 kind 授权）
test/speech.test.mjs   语音投影真机验证（P9-A，8 项）
test/cdp-target.test.mjs  CDP 直建带 URL 页面的注入兜底（3 项）
test/helpers/profile-probe.mjs  真机探针脚手架（起环境 + 两个 origin，不含断言）
test/fake-proxy.mjs    假代理 / 假出口端点（冒烟不依赖公网）
tools/make-icons.py    自绘图标生成（Pillow，不引用第三方素材）
tools/run-desktop.mjs  开发态起桌面壳（会剥掉 ELECTRON_RUN_AS_NODE 再起）
electron-builder.yml   打包配置（win-unpacked + NSIS）
docs/                  技术方案、阶段交付、curl 实测、截图（docs/shots/）
```