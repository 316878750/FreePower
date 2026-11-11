# AdsPower Global 8.9.23 静态拆解 · 第 1 阶段：架构与 Local API

> 采集时间：2026-11-09。只读排查，未安装、未下载、未修改客户端。
> 证据来源：安装目录、`%APPDATA%\adspower_global`、`app.asar` 解包、本地端口探测、`main.log`。

## 1. 版本与安装形态

| 项 | 值 | 依据 |
|---|---|---|
| 产品 | AdsPower Global | `package.json` → `"name": "adspower_global"` |
| 版本 | 8.9.23 (FileVersion 8.9.23, ProductVersion 8.9.23.0) | exe 版本资源 |
| 安装路径 | `D:\Program Files\AdsPower Global` | 进程路径 |
| 主程序 | `AdsPower Global.exe` 191.4 MB | 文件属性 |
| 框架 | Electron（es 壳）+ 独立 node agent 子进程 | `LICENSES.chromium.html`、`app.asar`、`app-update.yml` |
| 更新 | electron-updater；`https://api-global.adspower.net/client/sys-client-version/get-latest-version?system=com_win64` | `main.log` 每次 `update-now: checkForUpdates` |
| 其他 | `resources\elevate.exe`（提权辅助）、`resources\app.asar.unpacked` | resources 目录列表 |

运行态：`AdsPower Global.exe` PID 8584 / 26408；另有 node agent 子进程 PID 12056 占用 50325。
`package.json` 里 `"config": { "obfuscate_main": "true" }` —— 印证主进程 JS 经过混淆构建。

## 2. 分层结构

```
AdsPower Global.exe (Electron 主进程, dist/main.js, javascript-obfuscator 混淆)
 ├─ dist/static/js/preload.js           渲染进程 preload
 ├─ app-global.adspower.net              远端 Web UI（BrowserWindow 直接加载）
 ├─ biz-napi.win32-x64-msvc.node        自研 N-API 原生模块（418 KB）
 ├─ koffi                                 FFI，用于调用本地 DLL（69 MB 依赖）
 └─ 子进程: node agent（cwd_global\lib\version\v2.9.0.1__<hash>__<ts>）
      ├─ main.min.js        8.8 MB, webpack 打包、仅 minify（未混淆）
      ├─ bundles.min.js     3.5 MB  (含 koa / koaRouter 等运行时)
      ├─ agent.min.cjs      5.3 MB
      └─ better_sqlite3.node / node_sqlite3.node
 └─ 内核目录 cwd_global\chrome_<NNN>\  (chromedriver 118→156 共 20 套，每套 ~500 MB)
      ├─ SunBrowser.exe                   启动器
      ├─ SunBrowser.exe.sig / chrome.dll.sig
      └─ 152.0.7977.54\chrome.dll  306 MB 定制 Chromium
 └─ Dll2.dll (1.5 MB) + AdsPowerTool.exe (13 MB, utils)
 └─ 扩展 browser_assistant（MV3, background.mjs）+ 内置 playwright-mcp
```

关键点：
- **指纹/内核能力的可用代码在 node agent 层**（`main.min.js` 只做了 minify，可直接读）；Electron 主进程 `dist/main.js` 是 `_0x` 字符串表混淆，逆向成本高，属于"第二顺位"。
- 内核是**自家裁剪过的 Chromium**（`chrome.dll` 306 MB，带 `.sig` 签名文件），不是原版 Chrome 换壳；`cwd_global` 里按大版本并排放了 20 套，按需下载（对应 `POST /api/v2/browser-profile/download-kernel`）。
- `cwd_global\lib\version` 存了 v2.8.7.3 → v2.9.0.1 五个带哈希的 agent 包，说明 **agent 是热更新单元**，可回滚/多版本共存。

## 3. 本地服务（Local API）

- 端口：**50325**（实测 LISTENING，PID 12056）。代码中另有 `[50725, 60725]`、`[50325, 50425]` 两组候选（推测为主端口被占/多实例时的备选，**待验证**）。
- 服务启动后会把自己的地址写回文件：`cwd_global\source\local_api` → `http://local.adspower.com:50325/`（代码 `writeAPIUrl()` 会按 `IS_GLOBAL/IS_VN/IS_CN` 拼 `local.adspower.com|vn|cn|net`）。
- 探活：`GET /status` → `{"code":0,"msg":"success"}`（无需鉴权，**已实测**）。

### 3.1 中间件栈（模块 54478，`initServer()`）
顺序：日志 → bodyParser(json/form 5 MB) → 全局异常兜底 → corsConfig → OPTIONS 预检 → **Origin 白名单校验（不通过返回 403 "CORS ERROR"）** → 限流 → 业务中间件 → 路由分发。

CORS 白名单（正则数组，节选）：
`localhost/127.0.0.1/[::1]`、`*.adspower.net|.com|.io|.vn|.cn|adspowerapp.com`、`*.xmp.one`、`*.loginkits.com`、`*.acczing.com`、`app.fb-auto-cloud.com`、`chrome-extension://<32 位 id>`。

### 3.2 限流
`RATE_LIMIT_CONFIG` 硬编码：默认 **1 次/秒**（`RateLimiterMemory({points:1, duration:1})`）；带请求头 `x-adspower-client: mcp` 时走另一档 **30 次/秒**。运行时可用远端 `client/shell-config/get?key=SHELL_CONFIG` 覆盖（键名形如 `"1_1"` = 1 次/1 秒，`"10_1"` = 10 次/1 秒 → 对应 `/api/v1/fbbird/user/list`）。

### 3.3 路由表（51 条注册，模块 60617 `t.add(method, path, handler)`）

> **更新（2026-11-11 实测修正）**：实际运行的 agent 是 **v2.9.0.1**（md5 `3b0d2fc7…`），路由 **54 条**。
> 新增 3 条（全 POST）：`/api/v2/browser-profile/recycle-bin/list`、`/api/v2/browser-profile/recycle-bin/restore`、`/api/v2/proxy/dynamic-proxy-traffic`。
> **这 3 条是 v2.9.0.1 带来的，不是 v2.9.0.2**；v2.9.0.2（已下载未激活）与 v2.9.0.1 路由集合完全相同。
> 下面 51 条对应静态解包的 v2.8.9.2。版本存档与判定方法见 `agent-versions\README.md`，差异详见 `09-动态验证.md` §7。
>
> **版本基线声明：后续静态引用以 agent v2.9.0.1 为准。** 早期偏移基于 v2.8.9.2（8800604 字节），v2.9.0.1 增大了 53952 字节，**偏移只能作定位起点，必须重新核对**。
v1（GET 为主）：
```
/status
/api/v1/browser/start|stop|active        GET
/api/v1/browser/local-active             GET
/api/v1/browser/cloud-active             POST
/api/v1/user/create|update|delete|regroup POST
/api/v1/user/list|group/list|application/list  GET
/api/v1/user/delete-cache                POST
/api/v1/fbbird/user/list                 GET
/api/v1/fb/list (GET) | /fb/page | /fb/bm (POST)
```
v2（`N.default.V2` 实例化，语义从 user_id 换成 profile_id）：
```
/api/v2/browser-profile/ start | stop | stop-all | active | create | update | list |
                          delete | delete-cache | new-fingerprint | cookies | ua |
                          download-kernel | kernels | update-patch | share
/api/v2/category/list
/api/v2/user/create|update|delete|reset_password|list
/api/v2/user-group/list
/api/v2/proxy-list/create|update|delete|list
/api/v2/browser-tags/create|update|delete|list
```
版本区分靠响应头 `x-client-local-api-version: 1.0|2.0` 与 `apiVersion` 字段（v1 用 `user_id/serial_number`，v2 用 `profile_id/profile_no`）。

### 3.4 鉴权（重要）
- 没有本地密码校验：API Key 由**远端**校验 —— `validateAPIKey()` → `POST https://api.adspower.net/sys/user/api/check-api-key?_local_api=adspower`（baseUrl 随发行版切换，Global 版是 `api-global.adspower.net`）。意味着**离线状态下 API Key 无法自行验证**，实际可用性依赖缓存/远端可达性（待验证离线行为）。
- 除 `api_key` 外还接受 `login-token` 请求头（内部 RPA 调 `GET /api/v1/browser/start?...&type=rpa&cdp_mask=0&device_scale=1` 时就用 `login-token`），这是脚本复用的一条捷径。
- 例外路由：`/checkIntranet`、`/` 无鉴权；`/status` 无鉴权（实测）。
- **⚠️ 实测重大发现（2026-11-11）：不带任何 `api_key` / `login-token`，直接 `GET /api/v1/user/list` 也能成功返回 `code:0` + 数据。** 说明该环境的鉴权是「配了才校验、没配就放行」，或者校验结果有本地缓存。**复刻时必须明确：这是否只发生在已登录且 API 开关打开时**——待补测（需要新装/未登录环境对照）。**【实测，09 §6】**

## 4. 数据与配置

- `%APPDATA%\adspower_global\config.json`（electron-store，约 40 KB）：**含 loginToken、apiKey、user 信息、device_id/os_uuid/硬件指纹、chrome 内核版本清单、defaultFontList（按 os 分组的字体白名单）等**。→ 敏感，后续分析只取键名，不回显值。
- `%APPDATA%\adspower_global\cwd_global\`：内核、agent 包、`source\conf`、`source\local_api`、`lib\dll\Dll2.dll`、`utils\AdsPowerTool.exe`、`log\log.YYYY-MM-DD.log`（RPA 运行日志，每天 ~700 KB）。
- `logs\main.log`：客户端主日志，含更新检查、URL 加载、`message-SERVER_PORT_$$_20725`（内部 IPC 端口，推测与 Web UI 通道有关）。
- 本地库：`better_sqlite3.node` 在 agent 侧，账号/分组/代理/标签数据推测落在 sqlite（下一步定位 .db 文件）。

## 5. Dll2.dll / AdsPowerTool.exe 初判

- `Dll2.dll`（1.5 MB, PE64）字符串里有 **`SunBrowser` / `sunbrowser` / `flowerbrowser` / `FlowerBrowser`**、大量 `api-ms-win-*` 导入、`mscoree.dll`、locale 表；**没有** canvas/WebGL/font/hook/inject/fingerprint/navigator 字样。
  → 这是**内核启动/兼容层辅助 DLL**，不是指纹注入模块。
  **【已由 04 号报告证实】** 指纹注入在 `chrome.dll`（定制 Chromium）内部，走 `--extended-parameters` → `SunBrowserPolicys` 策略束，详见 `04-指纹注入层定位.md`。
- `utils\AdsPowerTool.exe`（13 MB）：名字直白，功能未查（下一步）。

## 6. 结论与下一步

已确认：
1. 架构是「Electron 壳 + node agent 子进程 + 定制 Chromium 内核 + N-API/FFI」四层，agent 与内核都可热更新。
2. Local API 是 koa，端口 50325，v2.8.9.2 有 51 条路由（v2.9.0.1 起增至 54），1 req/s 默认限流，CORS 白名单严格，API Key 走远端校验、也认 `login-token`；**但实测无 key 也能读数据**（§3.4）。
3. 可读的攻击面优先级：`main.min.js`（未混淆）> `app.asar` 其余 > `dist/main.js`（混淆）。

下一步（按价值排序）：
1. ~~通关 `main.min.js` 的 `browser/start` 处理器~~ **已完成**，见 `03`/`03b`/`09`。
2. ~~抓 `chrome.dll` 的指纹模块特征~~ **已完成**，见 `04`/`08`。
3. ~~实抓 50325 一轮完整 `start` 请求/响应~~ **已完成**，见 `05-browser-start契约.md`、`09` §6。
4. 定位 sqlite 库文件与表结构（账号/指纹配置落库格式）—— **仍未做**。
5. 补测：未登录/全新环境下 Local API 是否仍无鉴权（决定复刻要不要照抄这个行为）。

> 注：路径 `C:\Users\<user>\.dsh\bot\workspace\adspower-reverse\`，脚本在 `tools\`，本报告在 `8.9.23\`。