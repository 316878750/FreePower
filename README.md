# FreePower

独立实现的指纹浏览器（AdsPower 同类产品）：**多环境隔离 + 代理绑定 + 指纹一致 + 本地 API**。

内核用官方 Chrome for Testing（独立进程），指纹通过 CDP 注入与启动参数实现，不搬运 AdsPower 的私有代码、二进制、资源与商标。

> 当前阶段：**P0（骨架 + 端到端链路）**。能建环境、起真 Chrome、注入指纹、回收进程、跑本地 API。
> 阶段细节见 [P0 交付说明](docs/01-P0-交付.md)，技术路线见 [技术方案](docs/00-技术方案.md)。

## 一、范围（先看这个，避免后面被要求补）

### 做

- 环境（profile）增删改查、分组、复制、指纹重生成
- 启动/关闭浏览器实例：独立 `--user-data-dir`、独立进程、随机 CDP 端口、进程树回收
- 指纹：UA / UA-CH / 语言 / 时区 / 屏幕与 DPR / WebGL vendor+renderer / Canvas 种子化噪声 / Audio 噪声 / hardwareConcurrency / deviceMemory / platform / WebRTC 策略
- 代理：HTTP/HTTPS/SOCKS5 绑定、账号密码认证（HTTP 代理）、**fail-closed**
- 本地 API：`/status`、环境 CRUD、浏览器启停、返回值形状对齐 AdsPower（`ws.puppeteer` / `ws.selenium` / `debug_port`）

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
| 主程序 UI | Electron（P1） | P0 先保证内核与 API 正确 |

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

## 四、本地 API

鉴权：`api_key` 查询参数 / `api_key` 头 / `Authorization: Bearer`。**本地校验，离线可用**（对手是远端校验，离线不可用，这是我们有意做的差异）。

限流：`/status` 不限流；其余路由默认 1 次/秒，带 `x-freepower-client: mcp` 头走 30 次/秒。超限报文与对手逐字一致：

```json
{"code":-1,"msg":"Too many request per second, please check"}
```

CORS：只放行 `127.0.0.1` / `localhost` 的 Origin，其他返回 `403` + 纯文本 `CORS ERROR`。

### 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/status` | 探活，`{"code":0,"msg":"success"}`，形状对齐 AdsPower |
| GET | `/api/v1/user/list` | 环境列表（`page` / `page_size` / `group_id` / `name`） |
| GET | `/api/v1/user/detail` | 单个环境 |
| POST | `/api/v1/user/create` | 建环境 |
| POST | `/api/v1/user/update` | 改环境 |
| POST | `/api/v1/user/delete` | 删环境（运行中会先停） |
| POST | `/api/v1/user/regroup` | 改分组 |
| POST | `/api/v1/user/new-fingerprint` | 整组重生成指纹 |
| GET | `/api/v1/group/list` | 分组列表 |
| POST | `/api/v1/group/create` | 建分组 |
| GET | `/api/v1/browser/start` | 起环境 |
| GET | `/api/v1/browser/stop` | 关环境 |
| GET | `/api/v1/browser/active` | 运行中列表 |
| GET | `/api/v1/browser/local-active` | 同上（对齐对手命名） |

`browser/start` 返回（形状按拆解手 05 号契约）：

```json
{"code":0,"msg":"success","data":{
  "profile_id":"kjkvcd","pid":1234,
  "ws":{"puppeteer":"ws://127.0.0.1:60328/devtools/browser/b742df5a-...",
        "selenium":"127.0.0.1:60328"},
  "debug_port":"60328","status":"running","already_running":false}}
```

三条硬规则：`ws.selenium` 只放 `host:port`；`debug_port` 是字符串；重复调用 `start` 幂等（返回同一 `pid`，`already_running:true`）。

### 例子

```powershell
$key = (Select-String -Path data\local_api -Pattern 'api_key=(.*)').Matches[0].Groups[1].Value
$h = @{ api_key = $key; 'x-freepower-client' = 'mcp' }

Invoke-RestMethod -Uri 'http://127.0.0.1:53380/api/v1/user/create' -Method Post -Headers $h `
  -ContentType 'application/json' -Body '{"name":"env-a","country":"US","open_urls":["https://example.com"]}'

Invoke-RestMethod -Uri 'http://127.0.0.1:53380/api/v1/browser/start?user_id=<profile_id>' -Headers $h
```

## 五、已知限制（必须如实告知用户，不藏着）

1. **Canvas / Audio / WebGL 标识 / 字体是 JS 注入，不是内核级。**
   拆解手 08 号报告实测：AdsPower 139 个指纹字段里走 CDP 注入的是 0 个，全在内核配置和启动命令行。
   所以我们这四项属于**降级实现**：能改返回值、能保证同种子可复现、能过一致性检查，
   但 `Function.prototype.toString` 痕迹、双 Realm 取证、字体度量与真实字形交叉验证这些检测手段下**可被识别**。
   这是架构差距，不吹成 1:1。
2. **字体不伪装。** 只如实声明系统真实字体列表（`fingerprint_config.fonts.spoofed = false`）。
   伪造字体列表必须同时伪造几十种字体的宽度度量表，做不好比不做更危险。
3. **内核配置类 42 条 + `--extended-parameters` 10 条不实现**，列入「不兼容项」。
4. **SOCKS5 认证不支持**（Chrome 本身不支持命令行传 SOCKS5 账号密码）；HTTP/HTTPS 代理认证走 CDP `Fetch`，只对带账号密码的代理挂载，会给请求加一跳。
5. **WebRTC 只做参数级**（`disable_non_proxied_udp`），不做 JS 层伪造 `RTCPeerConnection`。
6. **Worker / AudioWorklet realm 覆盖不到**：`addScriptToEvaluateOnNewDocument` 覆盖主帧与子帧，worker 里再取一次原生函数会看到两套实现。
7. **沙箱内起不了 Chrome**：Windows 沙箱禁止命名管道，Chrome 的 Mojo IPC 会以 `platform_channel.cc:112 Check failed: 0x5` 自终止。这不是产品缺陷，但**跑冒烟必须用普通终端（非沙箱）**。
8. 主程序 UI（Electron）还没做，P0 只有 API 与内核链路。

## 六、验证

```powershell
# 必须用普通终端（不要在受限沙箱里跑）
npm run smoke
```

冒烟覆盖：

- `/status` 形状、鉴权、跨站 Origin 403 纯文本、限流报文
- 建环境 → 起真 Chrome → 探针读回 UA / UA-CH / 时区 / 语言 / platform / hardwareConcurrency / WebGL / `navigator.webdriver`
- Canvas 同页连读两次一致、重启后不变、换环境后必变
- 停环境后进程树回收干净、重复 start 幂等

## 七、目录

```
src/
  main.js              入口：起 API、写发现文件、回收环境
  config.js            端口/路径/限流配置
  api/server.js        路由、鉴权、限流、CORS
  store/db.js          node:sqlite 建表与 API Key
  store/profiles.js    环境 CRUD（内部 schema）
  fingerprint/         指纹生成（种子化，保证自洽）
  kernel/chrome.js     内核定位、启动参数、DevToolsActivePort、进程树回收
  kernel/cdp.js        CDP over WebSocket 客户端
  kernel/inject.js     页面注入脚本（canvas/audio/webgl/navigator）
  runtime/manager.js   启停、自动 attach 新标签页、代理认证
test/smoke.mjs         端到端冒烟
docs/                  技术方案、阶段交付
```