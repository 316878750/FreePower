# FreePower 实现清单（供与 AdsPower 全量对比）

> 本文件只回答一个问题：**FreePower 现在到底有什么、在哪里生效**。不评价优先级、不给建议。
> 所有位置都是 `文件:行号`，行号以基线提交为准。

## 0. 基线与口径

| 项 | 值 |
|---|---|
| 审计基线 | `c094c22b879ef8efb4c634d99e0834ffcdc77b63`（`0.4.5 ② 窗口同步页顶部操作区`） |
| 远端 | `origin/master` = `c094c22`（与本地一致，无未推提交） |
| 读前 `git status --porcelain` | 空（工作区干净） |
| 读后 `git status --porcelain` | 只多本文件 `docs/21-FreePower实现清单.md`（其余无改动） |
| 读法 | 用 `git archive c094c22` 导出的树读，不读工作区 |
| 导出树 | `C:\Users\1\AppData\Local\Temp\fp-inv\tree2`（234 个文件） |

**计数口径**

- 「注册项」= `buildRoutes()` 返回数组的一条（`both()` 一次注册产出 v1/v2 两条路径，算两条）。
- 「method×path 组合」= 每条路径展开它允许的方法后的总数，这才是客户端能调到的接口数。
- 「占位」只认 `src/api/routes.js:1902` 那个循环里、带 `unsupported: true` 的注册；不靠路径猜。
- 「假字段」= 字段表里有、能存能配，但全仓库没有任何一处把它读出来用于拼启动参数 / CDP 注入 / 下发。
  判定从「谁读它」反查，不是只扫 schema。字段表本身（`fields.generated.json`、`schema.sql`、
  `fields.js`、`validate.js`、`aliases.js`、`repo.js`、`src/api/schema.js`、`tools/gen-schema.mjs`）的命中不算消费。

## 1. 总数速查

| 类别 | 数量 |
|---|---|
| 本地 API 路由注册项 | **162** |
| 本地 API method×path 组合 | **186** |
| 唯一路径 | **160** |
| 占位（明确不支持） | **14** 条路径 / **28** 个组合 |
| 真实现组合 | **158** |
| v1 路径 / v2 路径 / 其它 | 60 / 101 / 1（`/status`） |
| 前端页面文件 | **13**（`web/pages/*.js`） |
| 前端路由条数 | **14**（`web/app.js:20-40`） |
| 按钮 | **96** |
| 下拉 | **18** |
| 输入框 | **36** |
| 复选框 / 开关 | **12**；另有单选 **2** |
| 启动参数白名单 | **6** 条；保护（拒绝）名单 **25** 条 |
| CDP 命令 | **42** 种 |
| CDP 事件 | **11** 种 |
| 环境字段总数 | **138** |
| 假字段（无消费路径） | **66**（表单可见可配 48、显示但禁用 14、表单不可见 4） |
| 有真消费的字段 | **68**；别名 **1**（`browser_run_args` → `launch_args`） |

---

# 一、本地 API 路由全量

注册点全部在 `src/api/routes.js` 的 `buildRoutes()`（`:142`）里，用的三个辅助：
`add()` `:144-148`、`both(v1,v2)` `:149`、`notImplemented()` `:151`。
路由层只有四种 opts 键：`auth`、`rateTier`、`ticket`、`unsupported`。
无匹配路由时回 404 + `{supported:false, path}`（`src/api/server.js:263`）。

## 1.1 占位：明确不支持（14 条路径 / 28 组合）

这 14 条全部是 GET+POST 双注册，handler 统一抛 `-1`，说法在 `src/api/contract.js:47-52`。

| # | 路径 | 方法 | 注册点 |
|---|---|---|---|
| 1 | `/api/v1/application/list` | GET / POST | `src/api/routes.js:1902` |
| 2 | `/api/v1/fb/bm` | GET / POST | `src/api/routes.js:1902` |
| 3 | `/api/v1/fb/list` | GET / POST | `src/api/routes.js:1902` |
| 4 | `/api/v1/fb/page` | GET / POST | `src/api/routes.js:1902` |
| 5 | `/api/v2/browser-profile/share` | GET / POST | `src/api/routes.js:1902` |
| 6 | `/api/v2/browser-profile/update-patch` | GET / POST | `src/api/routes.js:1902` |
| 7 | `/api/v2/category/list` | GET / POST | `src/api/routes.js:1902` |
| 8 | `/api/v2/proxy/dynamic-proxy-traffic` | GET / POST | `src/api/routes.js:1902` |
| 9 | `/api/v2/user-group/list` | GET / POST | `src/api/routes.js:1902` |
| 10 | `/api/v2/user/create` | GET / POST | `src/api/routes.js:1902` |
| 11 | `/api/v2/user/delete` | GET / POST | `src/api/routes.js:1902` |
| 12 | `/api/v2/user/list` | GET / POST | `src/api/routes.js:1902` |
| 13 | `/api/v2/user/reset_password` | GET / POST | `src/api/routes.js:1902` |
| 14 | `/api/v2/user/update` | GET / POST | `src/api/routes.js:1902` |

另有一条**真实现但语义上是拒绝**的：`/api/v1/browser/cloud-active`、`/api/v2/browser-profile/cloud-active`
（`src/api/routes.js:196`，GET 无、POST 有）——参数校验照做，然后回 `supported:false, reason:'cloud_unavailable'`，
并指向 `/api/v1/browser/local-active`。它不在 `placeholders` 数组里，所以上面的 14 条不含它。

## 1.2 全量表（按 `routes.js` 章节顺序）

「类型」只有两种：**真实现** / **占位（明确不支持）**。
「实现落点」给的是 handler 实际调到的函数定义处，最多三个；`src/api/routes.js:NNN` 表示处理器内联在注册语句里。

### （未分组）

| # | 路由 | 方法 | 类型 | 注册点 | 实现落点 | 备注 |
|---|---|---|---|---|---|---|
| 153 | `/status` | GET | 真实现 | `src/api/routes.js:153` | `src/api/routes.js:153` | 处理器内联在本文件 |

### 1. A 类 8 条

| # | 路由 | 方法 | 类型 | 注册点 | 实现落点 | 备注 |
|---|---|---|---|---|---|---|
| 157 | `/api/v1/browser/start` | GET | 真实现 | `src/api/routes.js:157` | `src/api/routes.js:1909（startHandler）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v2/browser-profile/start` | GET | 真实现 | `src/api/routes.js:157` | `src/api/routes.js:1909（startHandler）` | 同一注册语句的另一版本 |
| 159 | `/api/v1/browser/stop` | GET / POST | 真实现 | `src/api/routes.js:159` | `src/api/routes.js:114（resolveProfile）、src/runtime/manager.js:1208（stopProfile）、src/api/contract.js:21（ApiError）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v2/browser-profile/stop` | GET / POST | 真实现 | `src/api/routes.js:159` | `src/api/routes.js:114（resolveProfile）、src/runtime/manager.js:1208（stopProfile）、src/api/contract.js:21（ApiError）` | 同一注册语句的另一版本 |
| 176 | `/api/v1/browser/restart` | POST | 真实现 | `src/api/routes.js:176` | `src/api/routes.js:1950（restartHandler）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v2/browser-profile/restart` | POST | 真实现 | `src/api/routes.js:176` | `src/api/routes.js:1950（restartHandler）` | 同一注册语句的另一版本 |
| 178 | `/api/v1/browser/active` | GET | 真实现 | `src/api/routes.js:178` | `src/api/routes.js:114（resolveProfile）、src/runtime/manager.js:75（getRunning）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v2/browser-profile/active` | GET | 真实现 | `src/api/routes.js:178` | `src/api/routes.js:114（resolveProfile）、src/runtime/manager.js:75（getRunning）` | 同一注册语句的另一版本 |
| 187 | `/api/v1/browser/local-active` | GET | 真实现 | `src/api/routes.js:187` | `src/runtime/manager.js:71（listRunning）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v2/browser-profile/local-active` | GET | 真实现 | `src/api/routes.js:187` | `src/runtime/manager.js:71（listRunning）` | 同一注册语句的另一版本 |
| 196 | `/api/v1/browser/cloud-active` | POST | 真实现 | `src/api/routes.js:196` | `src/api/contract.js:21（ApiError）、src/api/routes.js:134（idList）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v2/browser-profile/cloud-active` | POST | 真实现 | `src/api/routes.js:196` | `src/api/contract.js:21（ApiError）、src/api/routes.js:134（idList）` | 同一注册语句的另一版本 |
| 209 | `/api/v2/browser-profile/cookies` | GET | 真实现 | `src/api/routes.js:209` | `src/api/routes.js:114（resolveProfile）、src/store/profiles.js:129（cookieText）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 214 | `/api/v2/browser-profile/kernels` | GET | 真实现 | `src/api/routes.js:214` | `src/api/contract.js:21（ApiError）、src/kernel/chrome.js:69（listKernels）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 232 | `/api/v2/browser-profile/download-kernel` | POST | 真实现 | `src/api/routes.js:232` | `src/kernel/download.js:236（runKernelDownload）、src/api/contract.js:21（ApiError）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 278 | `/api/v1/user/list` | GET | 真实现 | `src/api/routes.js:278` | `src/api/routes.js:278` | 处理器内联在本文件 |
| 279 | `/api/v2/browser-profile/list` | POST / GET | 真实现 | `src/api/routes.js:279` | `src/api/routes.js:279` | 处理器内联在本文件 |
| 281 | `/api/v1/fbbird/user/list` | GET | 真实现 | `src/api/routes.js:281` | `src/api/routes.js:281` | 处理器内联在本文件 |

### 2. 本地 CRUD

| # | 路由 | 方法 | 类型 | 注册点 | 实现落点 | 备注 |
|---|---|---|---|---|---|---|
| 285 | `/api/v1/user/detail` | GET | 真实现 | `src/api/routes.js:285` | `src/api/routes.js:68（present）、src/api/routes.js:114（resolveProfile）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v2/browser-profile/detail` | GET | 真实现 | `src/api/routes.js:285` | `src/api/routes.js:68（present）、src/api/routes.js:114（resolveProfile）` | 同一注册语句的另一版本 |
| 290 | `/api/v1/user/create` | POST | 真实现 | `src/api/routes.js:290` | `src/api/routes.js:81（input）、src/store/profiles.js:144（createProfile）、src/api/routes.js:68（present）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v2/browser-profile/create` | POST | 真实现 | `src/api/routes.js:290` | `src/api/routes.js:81（input）、src/store/profiles.js:144（createProfile）、src/api/routes.js:68（present）` | 同一注册语句的另一版本 |
| 298 | `/api/v1/user/update` | POST | 真实现 | `src/api/routes.js:298` | `src/api/routes.js:114（resolveProfile）、src/runtime/manager.js:75（getRunning）、src/api/contract.js:21（ApiError）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v2/browser-profile/update` | POST | 真实现 | `src/api/routes.js:298` | `src/api/routes.js:114（resolveProfile）、src/runtime/manager.js:75（getRunning）、src/api/contract.js:21（ApiError）` | 同一注册语句的另一版本 |
| 306 | `/api/v1/user/delete` | POST | 真实现 | `src/api/routes.js:306` | `src/api/contract.js:21（ApiError）、src/api/routes.js:134（idList）、src/runtime/manager.js:75（getRunning）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v2/browser-profile/delete` | POST | 真实现 | `src/api/routes.js:306` | `src/api/contract.js:21（ApiError）、src/api/routes.js:134（idList）、src/runtime/manager.js:75（getRunning）` | 同一注册语句的另一版本 |
| 324 | `/api/v1/user/regroup` | POST | 真实现 | `src/api/routes.js:324` | `src/api/contract.js:21（ApiError）、src/store/profiles.js:511（regroupProfiles）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v2/browser-profile/regroup` | POST | 真实现 | `src/api/routes.js:324` | `src/api/contract.js:21（ApiError）、src/store/profiles.js:511（regroupProfiles）` | 同一注册语句的另一版本 |
| 333 | `/api/v1/user/new-fingerprint` | POST | 真实现 | `src/api/routes.js:333` | `src/api/routes.js:134（idList）、src/api/contract.js:21（ApiError）、src/store/profiles.js:198（getProfile）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v2/browser-profile/new-fingerprint` | POST | 真实现 | `src/api/routes.js:333` | `src/api/routes.js:134（idList）、src/api/contract.js:21（ApiError）、src/store/profiles.js:198（getProfile）` | 同一注册语句的另一版本 |
| 349 | `/api/v1/group/list` | GET | 真实现 | `src/api/routes.js:349` | `src/store/profiles.js:534（listGroups）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v2/group/list` | GET | 真实现 | `src/api/routes.js:349` | `src/store/profiles.js:534（listGroups）` | 同一注册语句的另一版本 |
| 350 | `/api/v1/group/create` | POST | 真实现 | `src/api/routes.js:350` | `src/api/contract.js:21（ApiError）、src/store/profiles.js:552（createGroup）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v2/group/create` | POST | 真实现 | `src/api/routes.js:350` | `src/api/contract.js:21（ApiError）、src/store/profiles.js:552（createGroup）` | 同一注册语句的另一版本 |
| 355 | `/api/v1/group/update` | POST | 真实现 | `src/api/routes.js:355` | `src/api/contract.js:21（ApiError）、src/store/profiles.js:565（updateGroup）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v2/group/update` | POST | 真实现 | `src/api/routes.js:355` | `src/api/contract.js:21（ApiError）、src/store/profiles.js:565（updateGroup）` | 同一注册语句的另一版本 |
| 364 | `/api/v1/group/delete` | POST | 真实现 | `src/api/routes.js:364` | `src/api/contract.js:21（ApiError）、src/store/profiles.js:584（deleteGroup）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v2/group/delete` | POST | 真实现 | `src/api/routes.js:364` | `src/api/contract.js:21（ApiError）、src/store/profiles.js:584（deleteGroup）` | 同一注册语句的另一版本 |
| 376 | `/api/v2/browser-tags/list` | POST | 真实现 | `src/api/routes.js:376` | `src/store/tags.js:17（listTags）、src/api/routes.js:134（idList）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v1/browser-tags/list` | POST | 真实现 | `src/api/routes.js:376` | `src/store/tags.js:17（listTags）、src/api/routes.js:134（idList）` | 同一注册语句的另一版本 |
| 380 | `/api/v2/browser-tags/create` | POST | 真实现 | `src/api/routes.js:380` | `src/api/contract.js:21（ApiError）、src/store/tags.js:34（createTags）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v1/browser-tags/create` | POST | 真实现 | `src/api/routes.js:380` | `src/api/contract.js:21（ApiError）、src/store/tags.js:34（createTags）` | 同一注册语句的另一版本 |
| 389 | `/api/v2/browser-tags/update` | POST | 真实现 | `src/api/routes.js:389` | `src/api/contract.js:21（ApiError）、src/store/tags.js:52（updateTags）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v1/browser-tags/update` | POST | 真实现 | `src/api/routes.js:389` | `src/api/contract.js:21（ApiError）、src/store/tags.js:52（updateTags）` | 同一注册语句的另一版本 |
| 397 | `/api/v2/browser-tags/delete` | POST | 真实现 | `src/api/routes.js:397` | `src/api/routes.js:134（idList）、src/api/contract.js:21（ApiError）、src/store/tags.js:72（deleteTags）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v1/browser-tags/delete` | POST | 真实现 | `src/api/routes.js:397` | `src/api/routes.js:134（idList）、src/api/contract.js:21（ApiError）、src/store/tags.js:72（deleteTags）` | 同一注册语句的另一版本 |
| 408 | `/api/v2/proxy-list/create` | POST | 真实现 | `src/api/routes.js:408` | `src/store/proxies.js:76（createProxies）、src/api/contract.js:21（ApiError）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v1/proxy-list/create` | POST | 真实现 | `src/api/routes.js:408` | `src/store/proxies.js:76（createProxies）、src/api/contract.js:21（ApiError）` | 同一注册语句的另一版本 |
| 417 | `/api/v2/proxy-list/update` | POST | 真实现 | `src/api/routes.js:417` | `src/store/proxies.js:94（updateProxy）、src/api/contract.js:21（ApiError）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v1/proxy-list/update` | POST | 真实现 | `src/api/routes.js:417` | `src/store/proxies.js:94（updateProxy）、src/api/contract.js:21（ApiError）` | 同一注册语句的另一版本 |
| 427 | `/api/v2/proxy-list/list` | POST | 真实现 | `src/api/routes.js:427` | `src/store/proxies.js:116（listProxies）、src/api/routes.js:134（idList）、src/api/contract.js:21（ApiError）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v1/proxy-list/list` | POST | 真实现 | `src/api/routes.js:427` | `src/store/proxies.js:116（listProxies）、src/api/routes.js:134（idList）、src/api/contract.js:21（ApiError）` | 同一注册语句的另一版本 |
| 435 | `/api/v2/proxy-list/delete` | POST | 真实现 | `src/api/routes.js:435` | `src/store/proxies.js:133（deleteProxies）、src/api/routes.js:134（idList）、src/api/contract.js:21（ApiError）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v1/proxy-list/delete` | POST | 真实现 | `src/api/routes.js:435` | `src/store/proxies.js:133（deleteProxies）、src/api/routes.js:134（idList）、src/api/contract.js:21（ApiError）` | 同一注册语句的另一版本 |

### 3. 批量启停 + 全停

| # | 路由 | 方法 | 类型 | 注册点 | 实现落点 | 备注 |
|---|---|---|---|---|---|---|
| 445 | `/api/v1/browser/batch-start` | POST | 真实现 | `src/api/routes.js:445` | `src/api/routes.js:134（idList）、src/api/contract.js:21（ApiError）、src/runtime/batch.js:40（batchStart）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v2/browser-profile/batch-start` | POST | 真实现 | `src/api/routes.js:445` | `src/api/routes.js:134（idList）、src/api/contract.js:21（ApiError）、src/runtime/batch.js:40（batchStart）` | 同一注册语句的另一版本 |
| 457 | `/api/v1/browser/batch-stop` | POST | 真实现 | `src/api/routes.js:457` | `src/api/routes.js:134（idList）、src/api/contract.js:21（ApiError）、src/runtime/batch.js:114（batchStop）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v2/browser-profile/batch-stop` | POST | 真实现 | `src/api/routes.js:457` | `src/api/routes.js:134（idList）、src/api/contract.js:21（ApiError）、src/runtime/batch.js:114（batchStop）` | 同一注册语句的另一版本 |
| 464 | `/api/v2/browser-profile/stop-all` | POST | 真实现 | `src/api/routes.js:464` | `src/runtime/manager.js:71（listRunning）、src/runtime/batch.js:114（batchStop）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v1/browser/stop-all` | POST | 真实现 | `src/api/routes.js:464` | `src/runtime/manager.js:71（listRunning）、src/runtime/batch.js:114（batchStop）` | 同一注册语句的另一版本 |

### 4. 其余本地能力

| # | 路由 | 方法 | 类型 | 注册点 | 实现落点 | 备注 |
|---|---|---|---|---|---|---|
| 476 | `/api/v2/browser-profile/schema` | GET | 真实现 | `src/api/routes.js:476` | `src/api/schema.js:144（profileFormSchema）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v1/user/schema` | GET | 真实现 | `src/api/routes.js:476` | `src/api/schema.js:144（profileFormSchema）` | 同一注册语句的另一版本 |
| 485 | `/api/v2/browser-profile/validate` | POST | 真实现 | `src/api/routes.js:485` | `packages/profile/src/aliases.js:34（toCanonical）、src/api/contract.js:60（normalizeLaunchArgs）、src/store/profiles.js:111（cookieToStorage）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v1/user/validate` | POST | 真实现 | `src/api/routes.js:485` | `packages/profile/src/aliases.js:34（toCanonical）、src/api/contract.js:60（normalizeLaunchArgs）、src/store/profiles.js:111（cookieToStorage）` | 同一注册语句的另一版本 |
| 502 | `/api/v1/browser/selfcheck` | GET / POST | 真实现 | `src/api/routes.js:502` | `src/api/routes.js:114（resolveProfile）、src/runtime/manager.js:81（getInstance）、src/selfcheck/store.js:18（readReportFile）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v2/browser-profile/selfcheck` | GET / POST | 真实现 | `src/api/routes.js:502` | `src/api/routes.js:114（resolveProfile）、src/runtime/manager.js:81（getInstance）、src/selfcheck/store.js:18（readReportFile）` | 同一注册语句的另一版本 |
| 528 | `/api/v2/browser-profile/selfcheck-ticket` | POST | 真实现 | `src/api/routes.js:528` | `src/api/routes.js:114（resolveProfile）、src/api/tickets.js:29（issueTicket）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 542 | `/api/v2/browser-profile/selfcheck-summary` | POST | 真实现 | `src/api/routes.js:542` | `src/api/routes.js:134（idList）、src/api/contract.js:21（ApiError）、src/runtime/manager.js:81（getInstance）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 555 | `/api/v2/browser-profile/ua` | POST | 真实现 | `src/api/routes.js:555` | `src/api/routes.js:134（idList）、src/api/contract.js:21（ApiError）、src/store/profiles.js:198（getProfile）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v1/browser-profile/ua` | POST | 真实现 | `src/api/routes.js:555` | `src/api/routes.js:134（idList）、src/api/contract.js:21（ApiError）、src/store/profiles.js:198（getProfile）` | 同一注册语句的另一版本 |
| 570 | `/api/v1/user/delete-cache` | POST | 真实现 | `src/api/routes.js:570` | `src/api/routes.js:134（idList）、src/api/contract.js:21（ApiError）、src/store/profiles.js:198（getProfile）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v2/browser-profile/delete-cache` | POST | 真实现 | `src/api/routes.js:570` | `src/api/routes.js:134（idList）、src/api/contract.js:21（ApiError）、src/store/profiles.js:198（getProfile）` | 同一注册语句的另一版本 |
| 588 | `/api/v1/proxy/check` | POST | 真实现 | `src/api/routes.js:588` | `src/proxy/probe.js:33（hasProxy）、src/api/contract.js:21（ApiError）、src/proxy/probe.js:311（checkProxy）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v2/proxy/check` | POST | 真实现 | `src/api/routes.js:588` | `src/proxy/probe.js:33（hasProxy）、src/api/contract.js:21（ApiError）、src/proxy/probe.js:311（checkProxy）` | 同一注册语句的另一版本 |
| 598 | `/api/v1/proxy/check-batch` | POST | 真实现 | `src/api/routes.js:598` | `src/api/routes.js:134（idList）、src/api/contract.js:21（ApiError）、src/store/proxies.js:147（getProxy）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v2/proxy/check-batch` | POST | 真实现 | `src/api/routes.js:598` | `src/api/routes.js:134（idList）、src/api/contract.js:21（ApiError）、src/store/proxies.js:147（getProxy）` | 同一注册语句的另一版本 |

### 4.6 P10：环境导入/导出、复制、cookie 导入/导出

| # | 路由 | 方法 | 类型 | 注册点 | 实现落点 | 备注 |
|---|---|---|---|---|---|---|
| 652 | `/api/v1/browser-profile/import` | POST | 真实现 | `src/api/routes.js:652` | `src/api/routes.js:652` | 处理器内联在本文件 |
|  | `/api/v2/browser-profile/import` | POST | 真实现 | `src/api/routes.js:652` | `src/api/routes.js:652` | 同一注册语句的另一版本 |
|  | `/api/v1/user/import` | POST | 真实现 | `src/api/routes.js:652` | `src/api/routes.js:652` | 同一注册语句的另一版本 |
| 655 | `/api/v1/browser-profile/export` | GET / POST | 真实现 | `src/api/routes.js:655` | `src/api/routes.js:655` | 处理器内联在本文件 |
|  | `/api/v2/browser-profile/export` | GET / POST | 真实现 | `src/api/routes.js:655` | `src/api/routes.js:655` | 同一注册语句的另一版本 |
|  | `/api/v1/user/export` | GET / POST | 真实现 | `src/api/routes.js:655` | `src/api/routes.js:655` | 同一注册语句的另一版本 |
| 661 | `/api/v1/browser-profile/copy` | POST | 真实现 | `src/api/routes.js:661` | `src/api/routes.js:2118（copyHandler）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v2/browser-profile/copy` | POST | 真实现 | `src/api/routes.js:661` | `src/api/routes.js:2118（copyHandler）` | 同一注册语句的另一版本 |
|  | `/api/v1/user/copy` | POST | 真实现 | `src/api/routes.js:661` | `src/api/routes.js:2118（copyHandler）` | 同一注册语句的另一版本 |
| 664 | `/api/v1/browser-profile/cookie/export` | GET | 真实现 | `src/api/routes.js:664` | `src/api/routes.js:664` | 处理器内联在本文件 |
|  | `/api/v2/browser-profile/cookie/export` | GET | 真实现 | `src/api/routes.js:664` | `src/api/routes.js:664` | 同一注册语句的另一版本 |
|  | `/api/v1/user/cookie/export` | GET | 真实现 | `src/api/routes.js:664` | `src/api/routes.js:664` | 同一注册语句的另一版本 |
| 665 | `/api/v1/browser-profile/cookie/import` | POST | 真实现 | `src/api/routes.js:665` | `src/api/routes.js:665` | 处理器内联在本文件 |
|  | `/api/v2/browser-profile/cookie/import` | POST | 真实现 | `src/api/routes.js:665` | `src/api/routes.js:665` | 同一注册语句的另一版本 |
|  | `/api/v1/user/cookie/import` | POST | 真实现 | `src/api/routes.js:665` | `src/api/routes.js:665` | 同一注册语句的另一版本 |

### 4.7 回收站（软删除；形状按逆向 22- 号文）

| # | 路由 | 方法 | 类型 | 注册点 | 实现落点 | 备注 |
|---|---|---|---|---|---|---|
| 677 | `/api/v2/browser-profile/recycle-bin/list` | POST | 真实现 | `src/api/routes.js:677` | `src/api/contract.js:21（ApiError）、src/store/profiles.js:451（listRecycleBin）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 701 | `/api/v2/browser-profile/recycle-bin/restore` | POST | 真实现 | `src/api/routes.js:701` | `src/api/contract.js:21（ApiError）、src/store/profiles.js:460（getRecycledProfile）、src/store/profiles.js:478（restoreProfiles）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 741 | `/api/v2/browser-profile/recycle-bin/purge` | POST | 真实现 | `src/api/routes.js:741` | `src/api/contract.js:21（ApiError）、src/store/profiles.js:451（listRecycleBin）、src/api/routes.js:134（idList）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 864 | `/api/v2/browser-profile/batch/archive` | POST | 真实现 | `src/api/routes.js:864` | `src/store/profiles.js:370（archiveProfiles）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 871 | `/api/v2/browser-profile/batch/unarchive` | POST | 真实现 | `src/api/routes.js:871` | `src/store/profiles.js:393（unarchiveProfiles）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 886 | `/api/v2/browser-profile/batch/proxy` | POST | 真实现 | `src/api/routes.js:886` | `src/store/proxies.js:147（getProxy）、src/api/contract.js:21（ApiError）、src/proxy/probe.js:33（hasProxy）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 944 | `/api/v2/browser-profile/batch/check-proxy` | POST | 真实现 | `src/api/routes.js:944` | `src/store/profiles.js:198（getProfile）、src/proxy/probe.js:33（hasProxy）、src/proxy/health.js:118（checkMany）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1033 | `/api/v2/browser-profile/batch/ua` | POST | 真实现 | `src/api/routes.js:1033` | `src/api/contract.js:21（ApiError）、src/kernel/chrome.js:69（listKernels）、src/store/profiles.js:198（getProfile）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1101 | `/api/v2/browser-profile/batch/remark` | POST | 真实现 | `src/api/routes.js:1101` | `src/api/contract.js:21（ApiError）、src/store/profiles.js:198（getProfile）、src/store/profiles.js:203（getProfileByNo）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1136 | `/api/v2/browser-profile/batch/update-info` | POST | 真实现 | `src/api/routes.js:1136` | `src/api/contract.js:21（ApiError）、src/store/profiles.js:561（getGroup）、src/store/profiles.js:198（getProfile）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1178 | `/api/v2/browser-profile/batch/show` | POST | 真实现 | `src/api/routes.js:1178` | `src/sync/batch-show.js:78（showWindowsOfProfiles）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1199 | `/api/v2/browser-profile/batch/cookie` | POST | 真实现 | `src/api/routes.js:1199` | `src/api/contract.js:21（ApiError）、src/kernel/cookies.js:109（parseNetscape）、src/store/profiles.js:198（getProfile）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1318 | `/api/v2/settings` | GET | 真实现 | `src/api/routes.js:1318` | `src/settings/prefs.js:26（readSyncDefaults）、src/settings/prefs.js:85（syncDefaultsDiff）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1334 | `/api/v2/settings/sync-defaults` | POST | 真实现 | `src/api/routes.js:1334` | `src/settings/prefs.js:55（writeSyncDefaults）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1343 | `/api/v2/settings/sync-defaults/reset` | POST | 真实现 | `src/api/routes.js:1343` | `src/settings/prefs.js:68（resetSyncDefaults）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1353 | `/api/v2/diagnose/network` | GET | 真实现 | `src/api/routes.js:1353` | `src/api/diagnose.js:80（networkSnapshot）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1360 | `/api/v2/diagnose/proxy` | POST | 真实现 | `src/api/routes.js:1360` | `src/api/routes.js:134（idList）、src/api/contract.js:21（ApiError）、src/api/diagnose.js:184（probeBoundProxies）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1415 | `/api/v1/agent/workflow/run` | POST | 真实现 | `src/api/routes.js:1415` | `src/api/contract.js:21（ApiError）、src/store/profiles.js:198（getProfile）、src/agent/workflow.js:131（createWorkflow）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1425 | `/api/v1/agent/workflow/:id/status` | GET | 真实现 | `src/api/routes.js:1425` | `src/agent/workflow.js:168（getWorkflow）、src/api/contract.js:21（ApiError）、src/agent/workflow.js:212（presentWorkflow）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1436 | `/api/v1/agent/workflow/:id/screenshot-ticket` | POST | 真实现 | `src/api/routes.js:1436` | `src/agent/workflow.js:168（getWorkflow）、src/api/contract.js:21（ApiError）、src/api/tickets.js:29（issueTicket）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1451 | `/api/v1/agent/workflow/:id/screenshot` | GET | 真实现 | `src/api/routes.js:1451` | `src/agent/workflow.js:168（getWorkflow）、src/api/contract.js:21（ApiError）、src/agent/task.js:294（resolveShotPath）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1464 | `/api/v1/agent/workflow/:id/approve` | POST | 真实现 | `src/api/routes.js:1464` | `src/agent/workflow.js:249（approveStep）、src/agent/workflow.js:212（presentWorkflow）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1479 | `/api/v1/agent/workflow/create-from-goal` | POST | 真实现 | `src/api/routes.js:1479` | `src/api/contract.js:21（ApiError）、src/store/profiles.js:198（getProfile）、src/agent/llm.js:310（planTasksFromGoal）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1503 | `/api/v1/agent/workflow/:id/run` | POST | 真实现 | `src/api/routes.js:1503` | `src/agent/workflow.js:168（getWorkflow）、src/api/contract.js:21（ApiError）、src/agent/cli.js:104（createCli）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |

### 4.5 本地 API 自述（0.4.2）

| # | 路由 | 方法 | 类型 | 注册点 | 实现落点 | 备注 |
|---|---|---|---|---|---|---|
| 1524 | `/api/v2/api/info` | GET | 真实现 | `src/api/routes.js:1524` | `src/api/info.js:86（apiInfoPayload）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v1/api/info` | GET | 真实现 | `src/api/routes.js:1524` | `src/api/info.js:86（apiInfoPayload）` | 同一注册语句的另一版本 |
| 1530 | `/api/v2/api/verify` | POST | 真实现 | `src/api/routes.js:1530` | `src/api/contract.js:21（ApiError）、src/api/info.js:35（setApiVerify）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v1/api/verify` | POST | 真实现 | `src/api/routes.js:1530` | `src/api/contract.js:21（ApiError）、src/api/info.js:35（setApiVerify）` | 同一注册语句的另一版本 |
| 1541 | `/api/v2/api/key/reset` | POST | 真实现 | `src/api/routes.js:1541` | `src/store/db.js:254（resetApiKey）、src/api/info.js:69（resetStats）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
|  | `/api/v1/api/key/reset` | POST | 真实现 | `src/api/routes.js:1541` | `src/store/db.js:254（resetApiKey）、src/api/info.js:69（resetStats）` | 同一注册语句的另一版本 |

### 4.6 窗口同步（0.4.2）

| # | 路由 | 方法 | 类型 | 注册点 | 实现落点 | 备注 |
|---|---|---|---|---|---|---|
| 1557 | `/api/v2/sync/start` | POST | 真实现 | `src/api/routes.js:1557` | `src/api/contract.js:21（ApiError）、src/sync/session.js:129（startSync）、src/settings/prefs.js:78（mergeSyncSettings）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1583 | `/api/v2/sync/stop` | POST | 真实现 | `src/api/routes.js:1583` | `src/sync/session.js:394（stopSync）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1590 | `/api/v2/sync/status` | GET | 真实现 | `src/api/routes.js:1590` | `src/sync/session.js:379（syncStatus）、src/settings/prefs.js:26（readSyncDefaults）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1600 | `/api/v2/sync/settings` | POST | 真实现 | `src/api/routes.js:1600` | `src/sync/session.js:442（updateSettings）、src/api/contract.js:21（ApiError）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1610 | `/api/v2/sync/refresh` | POST | 真实现 | `src/api/routes.js:1610` | `src/sync/session.js:1049（refreshAll）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1616 | `/api/v2/sync/unify-size` | POST | 真实现 | `src/api/routes.js:1616` | `src/sync/session.js:467（unifySize）、src/api/contract.js:21（ApiError）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1629 | `/api/v2/sync/arrange` | POST | 真实现 | `src/api/routes.js:1629` | `src/sync/session.js:555（arrangeWindows）、src/api/contract.js:21（ApiError）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1642 | `/api/v2/sync/restart` | POST | 真实现 | `src/api/routes.js:1642` | `src/settings/prefs.js:78（mergeSyncSettings）、src/sync/session.js:413（restartSync）、src/api/contract.js:21（ApiError）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1661 | `/api/v2/sync/console` | GET | 真实现 | `src/api/routes.js:1661` | `src/sync/console.js:213（readConsoleState）、src/sync/session.js:379（syncStatus）、src/store/profiles.js:198（getProfile）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1680 | `/api/v2/sync/console` | POST | 真实现 | `src/api/routes.js:1680` | `src/sync/console.js:267（requestConsole）、src/api/contract.js:21（ApiError）、src/sync/console.js:213（readConsoleState）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1696 | `/api/v2/sync/displays` | GET | 真实现 | `src/api/routes.js:1696` | `src/sync/displays.js:80（readDisplays）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1706 | `/api/v2/sync/show` | POST | 真实现 | `src/api/routes.js:1706` | `src/sync/session.js:749（showWindows）、src/api/contract.js:21（ApiError）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1724 | `/api/v2/sync/show/force` | POST | 真实现 | `src/api/routes.js:1724` | `src/sync/session.js:644（forceShowWindows）、src/api/contract.js:21（ApiError）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1740 | `/api/v2/sync/tab` | POST | 真实现 | `src/api/routes.js:1740` | `src/sync/session.js:850（openTabInAll）、src/api/contract.js:21（ApiError）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1750 | `/api/v2/sync/tabs` | GET | 真实现 | `src/api/routes.js:1750` | `src/sync/session.js:893（tabState）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1753 | `/api/v2/sync/tab-close` | POST | 真实现 | `src/api/routes.js:1753` | `src/sync/session.js:932（closeTabs）、src/api/contract.js:21（ApiError）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1763 | `/api/v2/sync/tab-copy` | POST | 真实现 | `src/api/routes.js:1763` | `src/sync/session.js:978（copyTabToSlaves）、src/api/contract.js:21（ApiError）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1774 | `/api/v2/sync/tab-unify` | POST | 真实现 | `src/api/routes.js:1774` | `src/sync/session.js:1010（unifyTabs）、src/api/contract.js:21（ApiError）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1786 | `/api/v2/sync/hotkey` | GET | 真实现 | `src/api/routes.js:1786` | `src/sync/hotkey.js:92（readHotkeyStatus）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1792 | `/api/v2/sync/hotkey` | POST | 真实现 | `src/api/routes.js:1792` | `src/sync/hotkey.js:105（requestHotkey）、src/api/contract.js:21（ApiError）、src/sync/hotkey.js:92（readHotkeyStatus）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |

### 4.8 应用中心：扩展管理（0.4.3）

| # | 路由 | 方法 | 类型 | 注册点 | 实现落点 | 备注 |
|---|---|---|---|---|---|---|
| 1807 | `/api/v2/app/list` | GET / POST | 真实现 | `src/api/routes.js:1807` | `src/store/extensions.js:211（listExtensions）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1809 | `/api/v2/app/import` | POST | 真实现 | `src/api/routes.js:1809` | `src/store/extensions.js:288（importExtension）、src/api/contract.js:21（ApiError）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1821 | `/api/v2/app/update` | POST | 真实现 | `src/api/routes.js:1821` | `src/api/contract.js:21（ApiError）、src/store/extensions.js:386（updateExtension）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1834 | `/api/v2/app/delete` | POST | 真实现 | `src/api/routes.js:1834` | `src/api/routes.js:134（idList）、src/api/contract.js:21（ApiError）、src/runtime/manager.js:71（listRunning）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1854 | `/api/v2/app/profile` | GET / POST | 真实现 | `src/api/routes.js:1854` | `src/api/routes.js:114（resolveProfile）、src/store/extensions.js:265（profileExtensions）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |
| 1874 | `/api/v2/app/profile/set` | POST | 真实现 | `src/api/routes.js:1874` | `src/api/routes.js:114（resolveProfile）、src/api/contract.js:21（ApiError）、src/api/routes.js:134（idList）` | 落点 = handler 实际调到的函数（按代码里出现顺序，最多三个） |

### 5. 占位：明确不支持

| # | 路由 | 方法 | 类型 | 注册点 | 实现落点 | 备注 |
|---|---|---|---|---|---|---|
| 1902 | `/api/v1/application/list` | GET / POST | **占位（明确不支持）** | `src/api/routes.js:1902` | `src/api/routes.js:151（notImplemented）+ :1888（循环注册）` | `unsupported:true`，handler 抛 `-1`；见 `src/api/contract.js:47-52` |
| 1902 | `/api/v2/category/list` | GET / POST | **占位（明确不支持）** | `src/api/routes.js:1902` | `src/api/routes.js:151（notImplemented）+ :1888（循环注册）` | `unsupported:true`，handler 抛 `-1`；见 `src/api/contract.js:47-52` |
| 1902 | `/api/v1/fb/list` | GET / POST | **占位（明确不支持）** | `src/api/routes.js:1902` | `src/api/routes.js:151（notImplemented）+ :1888（循环注册）` | `unsupported:true`，handler 抛 `-1`；见 `src/api/contract.js:47-52` |
| 1902 | `/api/v1/fb/page` | GET / POST | **占位（明确不支持）** | `src/api/routes.js:1902` | `src/api/routes.js:151（notImplemented）+ :1888（循环注册）` | `unsupported:true`，handler 抛 `-1`；见 `src/api/contract.js:47-52` |
| 1902 | `/api/v1/fb/bm` | GET / POST | **占位（明确不支持）** | `src/api/routes.js:1902` | `src/api/routes.js:151（notImplemented）+ :1888（循环注册）` | `unsupported:true`，handler 抛 `-1`；见 `src/api/contract.js:47-52` |
| 1902 | `/api/v2/browser-profile/share` | GET / POST | **占位（明确不支持）** | `src/api/routes.js:1902` | `src/api/routes.js:151（notImplemented）+ :1888（循环注册）` | `unsupported:true`，handler 抛 `-1`；见 `src/api/contract.js:47-52` |
| 1902 | `/api/v2/browser-profile/update-patch` | GET / POST | **占位（明确不支持）** | `src/api/routes.js:1902` | `src/api/routes.js:151（notImplemented）+ :1888（循环注册）` | `unsupported:true`，handler 抛 `-1`；见 `src/api/contract.js:47-52` |
| 1902 | `/api/v2/user/create` | GET / POST | **占位（明确不支持）** | `src/api/routes.js:1902` | `src/api/routes.js:151（notImplemented）+ :1888（循环注册）` | `unsupported:true`，handler 抛 `-1`；见 `src/api/contract.js:47-52` |
| 1902 | `/api/v2/user/update` | GET / POST | **占位（明确不支持）** | `src/api/routes.js:1902` | `src/api/routes.js:151（notImplemented）+ :1888（循环注册）` | `unsupported:true`，handler 抛 `-1`；见 `src/api/contract.js:47-52` |
| 1902 | `/api/v2/user/reset_password` | GET / POST | **占位（明确不支持）** | `src/api/routes.js:1902` | `src/api/routes.js:151（notImplemented）+ :1888（循环注册）` | `unsupported:true`，handler 抛 `-1`；见 `src/api/contract.js:47-52` |
| 1902 | `/api/v2/user/delete` | GET / POST | **占位（明确不支持）** | `src/api/routes.js:1902` | `src/api/routes.js:151（notImplemented）+ :1888（循环注册）` | `unsupported:true`，handler 抛 `-1`；见 `src/api/contract.js:47-52` |
| 1902 | `/api/v2/user/list` | GET / POST | **占位（明确不支持）** | `src/api/routes.js:1902` | `src/api/routes.js:151（notImplemented）+ :1888（循环注册）` | `unsupported:true`，handler 抛 `-1`；见 `src/api/contract.js:47-52` |
| 1902 | `/api/v2/user-group/list` | GET / POST | **占位（明确不支持）** | `src/api/routes.js:1902` | `src/api/routes.js:151（notImplemented）+ :1888（循环注册）` | `unsupported:true`，handler 抛 `-1`；见 `src/api/contract.js:47-52` |
| 1902 | `/api/v2/proxy/dynamic-proxy-traffic` | GET / POST | **占位（明确不支持）** | `src/api/routes.js:1902` | `src/api/routes.js:151（notImplemented）+ :1888（循环注册）` | `unsupported:true`，handler 抛 `-1`；见 `src/api/contract.js:47-52` |

---

# 二、页面与区块

前端是手写 `h()` 渲染，没有框架。页面文件 13 个，前端路由 14 条。

## 2.1 侧栏导航（`web/index.html`）

| 分组 | 是否可折叠 | 项 | 目标 | 位置 |
|---|---|---|---|---|
| 常用 | 否（结构上没有折叠入口） | 环境管理 | `#/profiles` | `web/index.html:26` |
| 常用 | 否 | 代理管理 | `#/proxies` | `web/index.html:27` |
| 常用 | 否 | 应用中心 | `#/apps` | `web/index.html:28` |
| 自动化 | 是（`data-fold="automation"`） | AI Agent | `#/agent` | `web/index.html:36` |
| 自动化 | 是 | 窗口同步 | `#/sync` | `web/index.html:37` |
| 自动化 | 是 | API & MCP | `#/api` | `web/index.html:38` |
| 底部账号菜单 | — | 设置 / 外观（子菜单）/ 网络诊断 | `#/settings`、`#/diagnostics` | `web/app.js:179-182` |

折叠键 `fp.nav.fold.v1`（`web/nav.js:17`），可折叠组只有 `['automation']`（`web/nav.js:23`），
「常用」不可折叠是结构性的（`web/nav.js:10-11`）。

## 2.2 前端路由表（`web/app.js:20-40`）

| 路由 | 页面函数 | 位置 |
|---|---|---|
| `/profiles` | `profilesList` | `web/app.js:21` |
| `/profiles/groups` | `groupsPage` | `web/app.js:24` |
| `/profiles/recycle` | `recyclePage` | `web/app.js:25` |
| `/profiles/new` | `profileEdit` | `web/app.js:26` |
| `/profiles/:id` | `profileEdit` | `web/app.js:27` |
| `/profiles/:id/selfcheck` | `selfcheckPage` | `web/app.js:28` |
| `/proxies` | `proxiesPage` | `web/app.js:29` |
| `/apps` | `appsPage` | `web/app.js:30` |
| `/api` | `apiPage` | `web/app.js:31` |
| `/sync` | `syncPage` | `web/app.js:32` |
| `/sync-panel` | `syncPanelPage` | `web/app.js:34` |
| `/agent(/:id)` | `agentPage` | `web/app.js:36` |
| `/settings` | `settingsPage` | `web/app.js:38` |
| `/diagnostics` | `diagnosticsPage` | `web/app.js:39` |

环境管理页内 tabs（`web/tabs.js:18-22`）：`list` 环境列表 / `groups` 分组管理 / `recycle` 回收站。

## 2.3 逐页控件清单

#### AI Agent（`#/agent`、`#/agent/:id`）

文件：`web/pages/agent.js`，12 个元素（按钮 7 个）。

| 区块 / 控件 | 类型 | 位置 | 点击/输入落点 |
|---|---|---|---|
| （文案由变量/图标拼出） | 下拉 | `web/pages/agent.js:87` | `web/pages/agent.js:87` |
| 留空用服务端 AGENT_LLM_ENDPOINT（不填任何厂商地址） | 输入框 | `web/pages/agent.js:92` | `web/pages/agent.js:92` |
| 留空用服务端 AGENT_LLM_KEY（不回显、不写盘） | 输入框 | `web/pages/agent.js:93` | `web/pages/agent.js:93` |
| 留空用服务端 AGENT_LLM_MODEL | 输入框 | `web/pages/agent.js:94` | `web/pages/agent.js:94` |
| 生成工作流 | 按钮 | `web/pages/agent.js:95` | `web/pages/agent.js:167` |
| **（标题由变量拼出）** | 页面标题 | `web/pages/agent.js:100` | `web/pages/agent.js:100` |
| 刷新环境 | 按钮 | `web/pages/agent.js:103` | `web/pages/agent.js:146` |
| 刷新 | 按钮 | `web/pages/agent.js:347` | `web/pages/agent.js:301` |
| （文案由变量/图标拼出） | 按钮 | `web/pages/agent.js:348` | `web/pages/agent.js:234` |
| 执行中… / 运行 | 按钮 | `web/pages/agent.js:351` | `web/pages/agent.js:261` |
| 批准 | 按钮 | `web/pages/agent.js:379` | `web/pages/agent.js:209` |
| 拒绝 | 按钮 | `web/pages/agent.js:380` | `web/pages/agent.js:209` |

#### API & MCP（`#/api`）

文件：`web/pages/api.js`，15 个元素（按钮 9 个）。

| 区块 / 控件 | 类型 | 位置 | 点击/输入落点 |
|---|---|---|---|
| **（标题由变量拼出）** | 页面标题 | `web/pages/api.js:111` | `web/pages/api.js:111` |
| 刷新 | 按钮 | `web/pages/api.js:114` | `web/pages/api.js:121` |
| 重试 | 按钮 | `web/pages/api.js:130` | `web/pages/api.js:121` |
| 刷新页面 | 按钮 | `web/pages/api.js:131` | `web/pages/api.js:131` |
| 隐藏 / 显示 | 按钮 | `web/pages/api.js:148` | `web/pages/api.js:140` |
| 复制 | 按钮 | `web/pages/api.js:149` | `web/pages/api.js:93` |
| 重置 | 按钮 | `web/pages/api.js:150` | → ../ui.js（confirmDialog） |
| 已开启（点此关闭） / 已关闭（点此开启） | 按钮 | `web/pages/api.js:170` | → ../ui.js（confirmDialog） |
| **（标题由变量拼出）** | 区块 | `web/pages/api.js:205` | `web/pages/api.js:205` |
| 按路径或说明过滤… | 输入框 | `web/pages/api.js:217` | `web/pages/api.js:229` |
| （文案由变量/图标拼出） | 下拉 | `web/pages/api.js:223` | `web/pages/api.js:229` |
| **（标题由变量拼出）** | 区块 | `web/pages/api.js:259` | `web/pages/api.js:259` |
| （文案由变量/图标拼出） | 按钮 | `web/pages/api.js:289` | `web/pages/api.js:286` |
| **（标题由变量拼出）** | 区块 | `web/pages/api.js:300` | `web/pages/api.js:300` |
| 复制配置 | 按钮 | `web/pages/api.js:302` | `web/pages/api.js:93` |

#### 应用中心（`#/apps`）

文件：`web/pages/apps.js`，11 个元素（按钮 7 个）。

| 区块 / 控件 | 类型 | 位置 | 点击/输入落点 |
|---|---|---|---|
| **（标题由变量拼出）** | 页面标题 | `web/pages/apps.js:26` | `web/pages/apps.js:26` |
| 刷新 | 按钮 | `web/pages/apps.js:29` | `web/pages/apps.js:57` |
| 导入扩展 | 按钮 | `web/pages/apps.js:30` | `web/pages/apps.js:159` |
| 停用 / 启用 | 按钮 | `web/pages/apps.js:96` | `web/pages/apps.js:113` |
| 改名 | 按钮 | `web/pages/apps.js:98` | `web/pages/apps.js:124` |
| 删除 | 按钮 | `web/pages/apps.js:100` | `web/pages/apps.js:135` |
| C:\\Users\\你\\Downloads\\some-extension  或  …\\ext.zip | 输入框 | `web/pages/apps.js:160` | `web/pages/apps.js:160` |
| 留空 = 用 manifest.json 里的名字 | 输入框 | `web/pages/apps.js:161` | `web/pages/apps.js:161` |
| 导入 | 按钮 | `web/pages/apps.js:163` | `web/pages/apps.js:183` |
| **（标题由变量拼出）** | 小节 | `web/pages/apps.js:168` | `web/pages/apps.js:168` |
| 取消 | 按钮 | `web/pages/apps.js:178` | `web/pages/apps.js:178` |

#### 网络诊断（`#/diagnostics`）

文件：`web/pages/diagnostics.js`，4 个元素（按钮 2 个）。

| 区块 / 控件 | 类型 | 位置 | 点击/输入落点 |
|---|---|---|---|
| **（标题由变量拼出）** | 小节 | `web/pages/diagnostics.js:17` | `web/pages/diagnostics.js:17` |
| **（标题由变量拼出）** | 页面标题 | `web/pages/diagnostics.js:30` | `web/pages/diagnostics.js:30` |
| 刷新快照 | 按钮 | `web/pages/diagnostics.js:33` | `web/pages/diagnostics.js:170` |
| 探测代理（只读） | 按钮 | `web/pages/diagnostics.js:52` | `web/pages/diagnostics.js:52` |

#### 环境管理 · 新建/编辑环境（`#/profiles/new`、`#/profiles/:id`）

文件：`web/pages/edit.js`，25 个元素（按钮 9 个）。

| 区块 / 控件 | 类型 | 位置 | 点击/输入落点 |
|---|---|---|---|
| **（标题由变量拼出）** | 页面标题 | `web/pages/edit.js:37` | `web/pages/edit.js:37` |
| （文案由变量/图标拼出） | 按钮 | `web/pages/edit.js:80` | `web/pages/edit.js:80` |
| **（标题由变量拼出）** | 页面标题 | `web/pages/edit.js:82` | `web/pages/edit.js:82` |
| 返回列表 | 按钮 | `web/pages/edit.js:85` | `web/pages/edit.js:85` |
| （文案由变量/图标拼出） | 按钮 | `web/pages/edit.js:188` | `web/pages/edit.js:185` |
| （文案由变量/图标拼出） | 下拉 | `web/pages/edit.js:224` | `web/pages/edit.js:110` |
| （文案由变量/图标拼出） | 下拉 | `web/pages/edit.js:237` | `web/pages/edit.js:110` |
| + 新建分组 | 按钮 | `web/pages/edit.js:242` | `web/pages/edit.js:242` |
| 分组名，例如「美区-养号」 | 输入框 | `web/pages/edit.js:246` | `web/pages/edit.js:246` |
| 创建 | 按钮 | `web/pages/edit.js:250` | → ../ui.js（toast） |
| （文案由变量/图标拼出） | 输入框 | `web/pages/edit.js:269` | `web/pages/edit.js:269` |
| （文案由变量/图标拼出） | 复选框/开关 | `web/pages/edit.js:270` | `web/pages/edit.js:270` |
| 新标签名 | 输入框 | `web/pages/edit.js:277` | `web/pages/edit.js:277` |
| 新建标签 | 按钮 | `web/pages/edit.js:281` | `web/pages/edit.js:281` |
| （文案由变量/图标拼出） | 输入框 | `web/pages/edit.js:300` | `web/pages/edit.js:105` |
| （文案由变量/图标拼出） | 复选框/开关 | `web/pages/edit.js:301` | `web/pages/edit.js:301` |
| 自定义（列表外，编辑会覆盖） / 直连（不绑代理） | 下拉 | `web/pages/edit.js:324` | `web/pages/edit.js:110` |
| （文案由变量/图标拼出） | 下拉 | `web/pages/edit.js:355` | `web/pages/edit.js:350` |
| （文案由变量/图标拼出） | 输入框 | `web/pages/edit.js:362` | `web/pages/edit.js:350` |
| （文案由变量/图标拼出） | 输入框 | `web/pages/edit.js:375` | `web/pages/edit.js:375` |
| （文案由变量/图标拼出） | 复选框/开关 | `web/pages/edit.js:376` | `web/pages/edit.js:376` |
| 导出 cookie（JSON） | 按钮 | `web/pages/edit.js:402` | `web/pages/edit.js:440` |
| 导出 cookie（netscape） | 按钮 | `web/pages/edit.js:403` | `web/pages/edit.js:440` |
| 导入 cookie 文件 | 按钮 | `web/pages/edit.js:404` | `web/pages/edit.js:404` |
| （文案由变量/图标拼出） | 输入框 | `web/pages/edit.js:407` | `web/pages/edit.js:350` |

#### 环境管理 · 分组管理（`#/profiles/groups`）

文件：`web/pages/groups.js`，6 个元素（按钮 5 个）。

| 区块 / 控件 | 类型 | 位置 | 点击/输入落点 |
|---|---|---|---|
| **（标题由变量拼出）** | 页面标题 | `web/pages/groups.js:17` | `web/pages/groups.js:17` |
| 刷新 | 按钮 | `web/pages/groups.js:20` | `web/pages/groups.js:42` |
| 新建分组 | 按钮 | `web/pages/groups.js:28` | `web/pages/groups.js:28` |
| 重命名 | 按钮 | `web/pages/groups.js:72` | `web/pages/groups.js:94` |
| 改备注 | 按钮 | `web/pages/groups.js:74` | `web/pages/groups.js:105` |
| 删除 | 按钮 | `web/pages/groups.js:76` | `web/pages/groups.js:117` |

#### 环境管理 · 环境列表（`#/profiles`）

文件：`web/pages/profiles.js`，44 个元素（按钮 21 个）。

| 区块 / 控件 | 类型 | 位置 | 点击/输入落点 |
|---|---|---|---|
| **（标题由变量拼出）** | 页面标题 | `web/pages/profiles.js:33` | `web/pages/profiles.js:33` |
| 刷新 | 按钮 | `web/pages/profiles.js:36` | `web/pages/profiles.js:223` |
| 只影响本机显示，不写库、不同步到别的机器 | 下拉 | `web/pages/profiles.js:43` | → ../density.js（setDensity） |
| 搜索名称 / 编号 | 输入框 | `web/pages/profiles.js:60` | `web/pages/profiles.js:284` |
| （文案由变量/图标拼出） | 下拉 | `web/pages/profiles.js:64` | `web/pages/profiles.js:223` |
| 归档 = 移出主列表但不算删除：cookie、user-data、能启动，一样不少 | 下拉 | `web/pages/profiles.js:70` | `web/pages/profiles.js:223` |
| 新建环境 | 按钮 | `web/pages/profiles.js:81` | `web/pages/profiles.js:81` |
| 导入 | 按钮 | `web/pages/profiles.js:82` | `web/pages/profiles.js:82` |
| 导出 txt | 按钮 | `web/pages/profiles.js:83` | `web/pages/profiles.js:83` |
| 批量启动 | 按钮 | `web/pages/profiles.js:84` | `web/pages/profiles.js:367` |
| 批量停止 | 按钮 | `web/pages/profiles.js:85` | `web/pages/profiles.js:367` |
| 全部停止 | 按钮 | `web/pages/profiles.js:86` | `web/pages/profiles.js:86` |
| （文案由变量/图标拼出） | 输入框 | `web/pages/profiles.js:96` | `web/pages/profiles.js:198` |
| （文案由变量/图标拼出） | 复选框/开关 | `web/pages/profiles.js:96` | `web/pages/profiles.js:96` |
| 批量操作 ▾ | 按钮 | `web/pages/profiles.js:121` | `web/pages/profiles.js:121` |
| （文案由变量/图标拼出） | 按钮 | `web/pages/profiles.js:125` | `web/pages/profiles.js:125` |
| （文案由变量/图标拼出） | 输入框 | `web/pages/profiles.js:307` | `web/pages/profiles.js:204` |
| （文案由变量/图标拼出） | 复选框/开关 | `web/pages/profiles.js:308` | `web/pages/profiles.js:308` |
| 停止中… / 停止 | 按钮 | `web/pages/profiles.js:326` | `web/pages/profiles.js:340` |
| 启动中… / 启动 | 按钮 | `web/pages/profiles.js:327` | `web/pages/profiles.js:340` |
| 编辑 | 按钮 | `web/pages/profiles.js:329` | `web/pages/profiles.js:329` |
| 自检 | 按钮 | `web/pages/profiles.js:331` | `web/pages/profiles.js:331` |
| 导出 | 按钮 | `web/pages/profiles.js:333` | `web/pages/profiles.js:972` |
| 复制 | 按钮 | `web/pages/profiles.js:335` | `web/pages/profiles.js:981` |
| 删除 | 按钮 | `web/pages/profiles.js:337` | `web/pages/profiles.js:996` |
| （文案由变量/图标拼出） | 下拉 | `web/pages/profiles.js:426` | `web/pages/profiles.js:426` |
| host 或 IP | 输入框 | `web/pages/profiles.js:430` | `web/pages/profiles.js:430` |
| 端口 | 输入框 | `web/pages/profiles.js:431` | `web/pages/profiles.js:431` |
| 用户名（可空） | 输入框 | `web/pages/profiles.js:432` | `web/pages/profiles.js:432` |
| 密码（可空） | 输入框 | `web/pages/profiles.js:433` | `web/pages/profiles.js:433` |
| （文案由变量/图标拼出） | 下拉 | `web/pages/profiles.js:434` | `web/pages/profiles.js:434` |
| （文案由变量/图标拼出） | 下拉 | `web/pages/profiles.js:447` | `web/pages/profiles.js:441` |
| 改代理 | 按钮 | `web/pages/profiles.js:462` | `web/pages/profiles.js:462` |
| （未下载） /  | 下拉 | `web/pages/profiles.js:507` | `web/pages/profiles.js:507` |
| 如 157.0.8103.78（留空 = 用上面选的） | 输入框 | `web/pages/profiles.js:510` | `web/pages/profiles.js:510` |
| 改 UA / 内核 | 按钮 | `web/pages/profiles.js:520` | `web/pages/profiles.js:520` |
| （文案由变量/图标拼出） | 下拉 | `web/pages/profiles.js:542` | `web/pages/profiles.js:542` |
| 改备注 | 按钮 | `web/pages/profiles.js:554` | `web/pages/profiles.js:554` |
| （文案由变量/图标拼出） | 输入框 | `web/pages/profiles.js:600` | `web/pages/profiles.js:600` |
| （文案由变量/图标拼出） | 复选框/开关 | `web/pages/profiles.js:600` | `web/pages/profiles.js:600` |
| （文案由变量/图标拼出） | 下拉 | `web/pages/profiles.js:603` | `web/pages/profiles.js:603` |
| （文案由变量/图标拼出） | 输入框 | `web/pages/profiles.js:609` | `web/pages/profiles.js:609` |
| 更新 | 按钮 | `web/pages/profiles.js:635` | `web/pages/profiles.js:635` |
| 强制抬到前台（会闪一下） | 按钮 | `web/pages/profiles.js:769` | `web/pages/profiles.js:749` |

#### 代理管理（`#/proxies`）

文件：`web/pages/proxies.js`，11 个元素（按钮 8 个）。

| 区块 / 控件 | 类型 | 位置 | 点击/输入落点 |
|---|---|---|---|
| 全部检测 | 按钮 | `web/pages/proxies.js:15` | `web/pages/proxies.js:167` |
| **（标题由变量拼出）** | 页面标题 | `web/pages/proxies.js:17` | `web/pages/proxies.js:17` |
| 刷新 | 按钮 | `web/pages/proxies.js:20` | `web/pages/proxies.js:42` |
| 新增代理 | 按钮 | `web/pages/proxies.js:22` | `web/pages/proxies.js:237` |
| 检测 | 按钮 | `web/pages/proxies.js:118` | `web/pages/proxies.js:132` |
| 编辑 | 按钮 | `web/pages/proxies.js:125` | `web/pages/proxies.js:237` |
| 删除 | 按钮 | `web/pages/proxies.js:127` | `web/pages/proxies.js:220` |
| （文案由变量/图标拼出） | 输入框 | `web/pages/proxies.js:246` | `web/pages/proxies.js:246` |
| （文案由变量/图标拼出） | 下拉 | `web/pages/proxies.js:254` | → ../ui.js（h） |
| 取消 | 按钮 | `web/pages/proxies.js:270` | `web/pages/proxies.js:270` |
| 保存 / 创建 | 按钮 | `web/pages/proxies.js:271` | → ../ui.js（toast） |

#### 环境管理 · 回收站（`#/profiles/recycle`）

文件：`web/pages/recycle.js`，8 个元素（按钮 6 个）。

| 区块 / 控件 | 类型 | 位置 | 点击/输入落点 |
|---|---|---|---|
| **（标题由变量拼出）** | 页面标题 | `web/pages/recycle.js:27` | `web/pages/recycle.js:27` |
| 刷新 | 按钮 | `web/pages/recycle.js:30` | `web/pages/recycle.js:68` |
| 清空回收站 | 按钮 | `web/pages/recycle.js:43` | `web/pages/recycle.js:43` |
| 上一页 | 按钮 | `web/pages/recycle.js:89` | `web/pages/recycle.js:68` |
| 下一页 | 按钮 | `web/pages/recycle.js:91` | `web/pages/recycle.js:68` |
| 恢复 | 按钮 | `web/pages/recycle.js:103` | `web/pages/recycle.js:108` |
| 彻底删除 | 按钮 | `web/pages/recycle.js:105` | `web/pages/recycle.js:130` |
| （文案由变量/图标拼出） | 下拉 | `web/pages/recycle.js:110` | `web/pages/recycle.js:110` |

#### 环境管理 · 自检报告（`#/profiles/:id/selfcheck`）

文件：`web/pages/selfcheck.js`，7 个元素（按钮 4 个）。

| 区块 / 控件 | 类型 | 位置 | 点击/输入落点 |
|---|---|---|---|
| **（标题由变量拼出）** | 页面标题 | `web/pages/selfcheck.js:10` | `web/pages/selfcheck.js:10` |
| **（标题由变量拼出）** | 页面标题 | `web/pages/selfcheck.js:22` | `web/pages/selfcheck.js:22` |
| 返回列表 | 按钮 | `web/pages/selfcheck.js:24` | `web/pages/selfcheck.js:24` |
| **（标题由变量拼出）** | 页面标题 | `web/pages/selfcheck.js:36` | `web/pages/selfcheck.js:36` |
| 重跑自检 | 按钮 | `web/pages/selfcheck.js:39` | `web/pages/selfcheck.js:39` |
| HTML 报告 | 按钮 | `web/pages/selfcheck.js:45` | `web/pages/selfcheck.js:45` |
| 返回列表 | 按钮 | `web/pages/selfcheck.js:50` | `web/pages/selfcheck.js:50` |

#### 设置（`#/settings`）

文件：`web/pages/settings.js`，10 个元素（按钮 2 个）。

| 区块 / 控件 | 类型 | 位置 | 点击/输入落点 |
|---|---|---|---|
| **（标题由变量拼出）** | 小节 | `web/pages/settings.js:17` | `web/pages/settings.js:17` |
| **（标题由变量拼出）** | 页面标题 | `web/pages/settings.js:22` | `web/pages/settings.js:22` |
| （文案由变量/图标拼出） | 输入框 | `web/pages/settings.js:36` | `web/pages/settings.js:89` |
| （文案由变量/图标拼出） | 输入框 | `web/pages/settings.js:42` | `web/pages/settings.js:89` |
| （文案由变量/图标拼出） | 复选框/开关 | `web/pages/settings.js:42` | `web/pages/settings.js:42` |
| 恢复内置默认 | 按钮 | `web/pages/settings.js:66` | `web/pages/settings.js:66` |
| （文案由变量/图标拼出） | 输入框 | `web/pages/settings.js:119` | `web/pages/settings.js:119` |
| 保存 | 按钮 | `web/pages/settings.js:122` | `web/pages/settings.js:129` |
| （文案由变量/图标拼出） | 输入框 | `web/pages/settings.js:150` | → ../density.js（setDensity） |
| （文案由变量/图标拼出） | 单选 | `web/pages/settings.js:151` | `web/pages/settings.js:151` |

#### 窗口同步操作台 · 桌面小组件（`#/sync-panel`）

文件：`web/pages/sync-panel.js`，14 个元素（按钮 7 个）。

| 区块 / 控件 | 类型 | 位置 | 点击/输入落点 |
|---|---|---|---|
| **（标题由变量拼出）** | 页面标题 | `web/pages/sync-panel.js:82` | `web/pages/sync-panel.js:82` |
| （文案由变量/图标拼出） | 按钮 | `web/pages/sync-panel.js:104` | `web/pages/sync-panel.js:118` |
| （文案由变量/图标拼出） | 输入框 | `web/pages/sync-panel.js:136` | `web/pages/sync-panel.js:170` |
| （文案由变量/图标拼出） | 复选框/开关 | `web/pages/sync-panel.js:137` | `web/pages/sync-panel.js:137` |
| 收起 | 按钮 | `web/pages/sync-panel.js:145` | `web/pages/sync-panel.js:163` |
| 操作台复位到默认位置 | 按钮 | `web/pages/sync-panel.js:153` | `web/pages/sync-panel.js:184` |
| （文案由变量/图标拼出） | 下拉 | `web/pages/sync-panel.js:256` | `web/pages/sync-panel.js:247` |
| （文案由变量/图标拼出） | 输入框 | `web/pages/sync-panel.js:263` | `web/pages/sync-panel.js:263` |
| （文案由变量/图标拼出） | 复选框/开关 | `web/pages/sync-panel.js:264` | `web/pages/sync-panel.js:264` |
| 开始同步 | 按钮 | `web/pages/sync-panel.js:275` | `web/pages/sync-panel.js:275` |
| 停止 | 按钮 | `web/pages/sync-panel.js:289` | `web/pages/sync-panel.js:289` |
| 一键统一尺寸 | 按钮 | `web/pages/sync-panel.js:294` | `web/pages/sync-panel.js:294` |
| （文案由变量/图标拼出） | 输入框 | `web/pages/sync-panel.js:332` | `web/pages/sync-panel.js:332` |
| 保存 | 按钮 | `web/pages/sync-panel.js:333` | → ../ui.js（toast） |

#### 窗口同步（`#/sync`）

文件：`web/pages/sync.js`，25 个元素（按钮 9 个）。

| 区块 / 控件 | 类型 | 位置 | 点击/输入落点 |
|---|---|---|---|
| 重启同步 | 按钮 | `web/pages/sync.js:46` | `web/pages/sync.js:112` |
| 打开操作台 | 按钮 | `web/pages/sync.js:52` | `web/pages/sync.js:102` |
| **（标题由变量拼出）** | 页面标题 | `web/pages/sync.js:63` | `web/pages/sync.js:63` |
| 刷新 | 按钮 | `web/pages/sync.js:67` | `web/pages/sync.js:130` |
| **（标题由变量拼出）** | 区块 | `web/pages/sync.js:72` | `web/pages/sync.js:72` |
| **（标题由变量拼出）** | 区块 | `web/pages/sync.js:75` | `web/pages/sync.js:75` |
| **（标题由变量拼出）** | 区块 | `web/pages/sync.js:78` | `web/pages/sync.js:78` |
| **（标题由变量拼出）** | 区块 | `web/pages/sync.js:81` | `web/pages/sync.js:81` |
| **（标题由变量拼出）** | 区块 | `web/pages/sync.js:84` | `web/pages/sync.js:84` |
| **（标题由变量拼出）** | 区块 | `web/pages/sync.js:87` | `web/pages/sync.js:87` |
| 去环境管理 | 按钮 | `web/pages/sync.js:203` | `web/pages/sync.js:203` |
| （文案由变量/图标拼出） | 输入框 | `web/pages/sync.js:212` | `web/pages/sync.js:197` |
| （文案由变量/图标拼出） | 单选 | `web/pages/sync.js:213` | `web/pages/sync.js:213` |
| （文案由变量/图标拼出） | 输入框 | `web/pages/sync.js:217` | `web/pages/sync.js:197` |
| （文案由变量/图标拼出） | 复选框/开关 | `web/pages/sync.js:218` | `web/pages/sync.js:218` |
| 正在建立连接… / 开始同步 | 按钮 | `web/pages/sync.js:229` | `web/pages/sync.js:229` |
| 停止同步 | 按钮 | `web/pages/sync.js:234` | `web/pages/sync.js:234` |
| （文案由变量/图标拼出） | 输入框 | `web/pages/sync.js:256` | `web/pages/sync.js:305` |
| （文案由变量/图标拼出） | 复选框/开关 | `web/pages/sync.js:257` | `web/pages/sync.js:257` |
| （文案由变量/图标拼出） | 输入框 | `web/pages/sync.js:263` | `web/pages/sync.js:305` |
| （文案由变量/图标拼出） | 输入框 | `web/pages/sync.js:345` | `web/pages/sync.js:305` |
| （文案由变量/图标拼出） | 复选框/开关 | `web/pages/sync.js:346` | `web/pages/sync.js:346` |
| （文案由变量/图标拼出） | 按钮 | `web/pages/sync.js:352` | `web/pages/sync.js:381` |
| 重读窗口尺寸 | 按钮 | `web/pages/sync.js:440` | `web/pages/sync.js:130` |
| 一键统一尺寸 | 按钮 | `web/pages/sync.js:466` | `web/pages/sync.js:466` |

---

# 三、设置项

「存储位置」写的是真正落盘的键；「生效点」写的是读它并改变行为的那一行。

| 设置项 | 默认值 | 存储位置 | 写入点 | 生效点 | 界面入口 |
|---|---|---|---|---|---|
| 窗口同步默认设置（16 项） | 见下 | SQLite `meta` 表，键 `sync_defaults` | `src/settings/prefs.js:55`（`writeSyncDefaults`，合并语义） | `src/settings/prefs.js:78`（`mergeSyncSettings`）→ 启动/重启同步时用：`src/api/routes.js:1574`、`:1645` | 设置页「窗口同步：默认设置」`web/pages/settings.js:31` |
| 视图密度 | `standard` | 只写 `localStorage`，键 `fp.view_density` | `web/density.js:46` | `web/app.js:170`（`setDensity` → `applyDensity`） | 账号菜单「外观」子菜单 |
| 窗口同步全局快捷键 | `CommandOrControl+Alt+S` | 文件 `sync-hotkey.request.json` / `sync-hotkey.status.json`（`src/sync/hotkey.js:18-19`） | `src/sync/hotkey.js:105`（`requestHotkey`）、`:120`（`writeHotkeyStatus`） | `desktop/main.js:542`（`registerSyncHotkey` → `globalShortcut.register` `:547`）；桌面启动时读 `:125-126` | 设置页「窗口同步：全局快捷键」`web/pages/settings.js:113` |
| 开机自启 | 关 | 系统登录项（Electron `openAtLogin`），无自有配置文件 | `desktop/main.js:680`（`setLoginItemSettings`） | `desktop/main.js:633-635`（`loginItemOn` 读回勾选态）、菜单项 `:652-658` | **不在网页端**：桌面版托盘菜单，未打包时该项灰显（`:656`） |
| API 验证开关 | 开（校验 `api_key`） | SQLite `meta` 表，键 `api_verify` | `src/api/info.js:35`（`setApiVerify`） | `src/api/info.js:27`（`apiVerifyEnabled`）；开关接口 `src/api/routes.js:1530` | API & MCP 页「关闭 API 验证？」`web/pages/api.js:170` |
| 会话恢复（每个环境） | 开 | `<环境 user-data>/Default/Preferences` 的 `session.restore_on_startup = 1` | `src/runtime/prefs.js:72`（`ensureRestoreOnStartup`） | 与启动参数 `--restore-last-session` 配套（`src/kernel/chrome.js:234`），缺任一条都不恢复 | 无独立开关（随环境启动生效） |
| 窗口同步操作台形态/位置 | 展开、默认位置 | 文件 `sync-console.state.json`（`src/sync/console.js:184`）；请求走 `sync-console.request.json`（`:185`） | `desktop/main.js:329`（`persistConsoleState`）→ `src/sync/console.js` 的 `writeConsoleState` | `desktop/main.js:130`（启动时 `readConsoleState`）、`src/sync/console.js:113`（`pickConsoleRect`） | 操作台「收起 / 复位」`web/pages/sync-panel.js:145`、`:153` |
| 侧栏分组折叠 | 展开 | `localStorage`，键 `fp.nav.fold.v1` | `web/nav.js`（`parseFold` 的对应写入在 `web/app.js` 折叠切换处） | `web/app.js:57`（`applyFold`） | 侧栏「自动化」组标题按钮 `web/index.html:33` |

`DEFAULT_SETTINGS` 16 项（`src/sync/settings.js:12-38`）：
`input`=true、`click`=true、`scroll`=true、`move`=true、`text_sync`=true、`typing`=false、`paste`=true、
`random_number`=false、`typing_min_ms`=30、`typing_max_ms`=120、`random_min`=1000、`random_max`=9999、
`same_tab`=true、`current_tab_url`=false、`delay_ms`=0、`jitter_ms`=0。
其中 `same_tab` 是**内部项**，面板上不出现（`INTERNAL_SETTING_KEYS = ['same_tab']`，`src/sync/settings.js:41`）。

视图密度三档（`web/density.js:21-25`）：`compact` 紧凑 30px / `standard` 标准 44px / `ultra` 超高 64px。
行高是 FreePower 自己定的，对手没给数字。

设置页「没做 / 在别处」如实写的五条（`web/pages/settings.js:183-187`）：
开机自启（已实现，入口在桌面版托盘菜单，默认关）、界面语言（未实现）、主题（未实现）、
退出登录（不适用）、自动更新（未实现）。

---

# 四、启动参数与内核侧开关

## 4.1 白名单 6 条（`src/kernel/launch-args.js:17-24`）

用户能在环境里填的启动参数（字段 `launch_args`）只有这 6 条能过；其余一律进 `rejected`。

| 参数 | 类型 | 谁会产出它 / 谁会用 | 生效落点 |
|---|---|---|---|
| `--disable-features` | 逗号特性表 | ①系统固定产出：`src/kernel/chrome.js:193`（`Translate`/`OptimizationHints`/`MediaRouter`/`CalculateNativeWinOcclusion`）+ `:194`（`webgpu_switch==='0'` 时加 `WebGPU`/`WebGPUService`）+ `:210`（`disable_save_password==='1'` 时加 `EnablePasswordsAccountStorage`），合并进 `:223`；②用户 `launch_args` 追加（`src/kernel/launch-args.js:156`） | 内核命令行 `src/kernel/chrome.js:223` |
| `--enable-features` | 逗号特性表 | **只有**用户 `launch_args`（`src/kernel/launch-args.js:156`），系统不主动产出 | 同上，并入内核 argv |
| `--disable-blink-features` | 逗号特性表 | ①系统固定产出：`automation_controlled !== '1'` 时加 `AutomationControlled`（`src/kernel/chrome.js:257`）；②用户追加，但会剔除 `AutomationControlled` 并给软告警（`src/kernel/launch-args.js:142-154`） | `src/kernel/chrome.js:257` |
| `--enable-blink-features` | 逗号特性表 | **只有**用户 `launch_args`；含 `AutomationControlled` 直接拒绝（`src/kernel/launch-args.js:138-141`） | 并入内核 argv |
| `--proxy-bypass-list` | 绕过列表 | ①系统：绑代理时固定 `<-loopback>`（`src/kernel/chrome.js:304`）；②用户追加，但**绑了代理就拒绝**（`src/kernel/launch-args.js:124-127`，fail-closed） | `src/kernel/chrome.js:304` |
| `--start-maximized` | 无值 flag | 系统：`window_position === 'maximize'`（`src/kernel/chrome.js:269`）；用户也可填（重复时不叠加，`src/kernel/launch-args.js:163`） | `src/kernel/chrome.js:269` |

## 4.2 保护名单 25 条（`src/kernel/launch-args.js:26-60`）

用户填了会被拒绝并给出原因，不是静默丢弃：

`--load-extension`、`--disable-extensions-except`（Chrome 137+ 已移除命令行装扩展，本机 157 实测不生效，改走应用中心）、
`--user-data-dir`、`--remote-debugging-port`、`--remote-debugging-pipe`、`--remote-debugging-address`、
`--extended-parameters`、`--lang`、`--accept-lang`、`--user-agent`、`--proxy-server`、`--proxy-pac-url`、
`--proxy-auto-detect`、`--enable-automation`、`--disable-web-security`、`--allow-running-insecure-content`、
`--ignore-certificate-errors`、`--disable-gpu`、`--disable-accelerated-2d-canvas`、`--disable-software-rasterizer`、
`--headless`、`--window-size`、`--window-position`、`--profile-directory`、`--incognito`。

不在白名单也不在保护名单的，拒绝理由是「不在白名单」（`src/kernel/launch-args.js:119`）。

## 4.3 系统固定产出的启动参数（`src/kernel/chrome.js:213-239`、`:242`、`:257-268`、`:278-285`、`:292-318`）

| 参数 | 条件 | 位置 |
|---|---|---|
| `--user-data-dir=<环境目录>` | 总是 | `chrome.js:214` |
| `--remote-debugging-port=0` | 总是（端口由 DevToolsActivePort 回读） | `chrome.js:215` |
| `--remote-allow-origins=*` | 总是 | `chrome.js:216` |
| `--no-first-run` / `--no-default-browser-check` / `--no-service-autorun` | 总是 | `chrome.js:217-219` |
| `--lang` / `--accept-lang` | 由 locale / language 字段 | `chrome.js:220-221` |
| `--window-size` | 由 `window_size` 或指纹屏幕 | `chrome.js:222` |
| `--disable-search-engine-choice-screen` / `--hide-crash-restore-bubble` | 总是 | `chrome.js:224-225` |
| `--restore-last-session` | 总是（会话恢复真正起作用的那一半） | `chrome.js:234` |
| `--disable-accelerated-2d-canvas` | 总是（canvas 跨重启一致） | `chrome.js:238` |
| `--password-store=basic` | `disable_save_password === '1'` | `chrome.js:242` |
| `--force-webrtc-ip-handling-policy` / `--webrtc-ip-handling-policy` | webrtc 非默认 | `chrome.js:260-264` |
| `--headless` / `--headless=new` | `headless` 为 `1` / `2` | `chrome.js:266-268` |
| `--no-sandbox` | 仅环境变量 `FREEPOWER_KERNEL_NO_SANDBOX=1` | `chrome.js:278-285` |
| `--blink-settings=imagesEnabled=false` | `disable_image === '1'` | `chrome.js:292-294` |
| `--proxy-server=<scheme>://host:port` | 环境绑了代理 | `chrome.js:315-318` |

多级代理链在内核命令行里**没有额外参数**：链在浏览器外由 `src/proxy/chain.js` 搭好，内核只看到本地链端口（`chrome.js:320-323`）。

## 4.4 CDP 命令 42 种 / 事件 11 种（`src/` 全域）

| CDP 命令 | 次数 | 主要落点 |
|---|---|---|
| `Browser.close` | 1 | `src/runtime/manager.js:1220` |
| `Browser.getVersion` | 1 | `src/runtime/manager.js:301` |
| `Browser.getWindowForTarget` | 3 | `src/sync/batch-show.js:33`、`src/sync/session.js:100`、`src/sync/session.js:110` |
| `Browser.grantPermissions` | 1 | `src/runtime/manager.js:327` |
| `Browser.setPermission` | 1 | `src/runtime/manager.js:330` |
| `Browser.setWindowBounds` | 9 | `src/sync/batch-show.js:65`、`src/sync/batch-show.js:68`、`src/sync/batch-show.js:120` |
| `Emulation.setDeviceMetricsOverride` | 1 | `src/runtime/manager.js:1067` |
| `Emulation.setGeolocationOverride` | 1 | `src/runtime/manager.js:1081` |
| `Emulation.setHardwareConcurrencyOverride` | 2 | `src/runtime/manager.js:724`、`src/runtime/manager.js:1059` |
| `Emulation.setLocaleOverride` | 1 | `src/runtime/manager.js:1047` |
| `Emulation.setTimezoneOverride` | 1 | `src/runtime/manager.js:1046` |
| `Emulation.setUserAgentOverride` | 1 | `src/runtime/manager.js:1039` |
| `Extensions.loadUnpacked` | 1 | `src/kernel/extensions.js:91` |
| `Fetch.continueRequest` | 2 | `src/runtime/manager.js:1192`、`src/runtime/manager.js:1194` |
| `Fetch.continueResponse` | 1 | `src/runtime/manager.js:1191` |
| `Fetch.continueWithAuth` | 1 | `src/runtime/manager.js:1201` |
| `Fetch.enable` | 1 | `src/runtime/manager.js:1137` |
| `Fetch.failRequest` | 2 | `src/runtime/manager.js:1181`、`src/runtime/manager.js:1185` |
| `Fetch.fulfillRequest` | 1 | `src/runtime/manager.js:1175` |
| `Network.deleteCookies` | 1 | `src/kernel/cookies.js:337` |
| `Network.enable` | 1 | `src/runtime/manager.js:1096` |
| `Network.setExtraHTTPHeaders` | 1 | `src/runtime/manager.js:1098` |
| `Page.addScriptToEvaluateOnNewDocument` | 2 | `src/runtime/manager.js:1036`、`src/sync/session.js:188` |
| `Page.bringToFront` | 2 | `src/sync/batch-show.js:124`、`src/sync/session.js:787` |
| `Page.enable` | 5 | `src/proxy/egress.js:34`、`src/runtime/manager.js:1031`、`src/sync/session.js:183` |
| `Page.getLayoutMetrics` | 1 | `src/sync/session.js:86` |
| `Page.navigate` | 8 | `src/proxy/egress.js:35`、`src/runtime/manager.js:858`、`src/runtime/manager.js:879` |
| `Page.reload` | 2 | `src/runtime/manager.js:805`、`src/runtime/manager.js:976` |
| `Runtime.addBinding` | 2 | `src/sync/session.js:185`、`src/sync/session.js:197` |
| `Runtime.enable` | 1 | `src/sync/session.js:184` |
| `Runtime.evaluate` | 14 | `src/proxy/egress.js:41`、`src/proxy/egress.js:64`、`src/runtime/manager.js:519` |
| `Runtime.removeBinding` | 1 | `src/sync/session.js:317` |
| `Runtime.runIfWaitingForDebugger` | 2 | `src/runtime/manager.js:614`、`src/runtime/manager.js:775` |
| `Storage.getCookies` | 1 | `src/kernel/cookies.js:159` |
| `Storage.setCookies` | 1 | `src/kernel/cookies.js:183` |
| `Target.attachToTarget` | 9 | `src/agent/workflow.js:351`、`src/kernel/cookies.js:322`、`src/proxy/egress.js:33` |
| `Target.closeTarget` | 3 | `src/proxy/egress.js:87`、`src/runtime/manager.js:904`、`src/sync/tabs.js:232` |
| `Target.createTarget` | 5 | `src/agent/workflow.js:350`、`src/proxy/egress.js:30`、`src/runtime/manager.js:873` |
| `Target.detachFromTarget` | 1 | `src/sync/tabs.js:201` |
| `Target.getTargets` | 7 | `src/agent/workflow.js:348`、`src/kernel/cookies.js:319`、`src/runtime/manager.js:809` |
| `Target.setAutoAttach` | 3 | `src/runtime/manager.js:688`、`src/runtime/manager.js:787`、`src/runtime/manager.js:1034` |
| `Target.setDiscoverTargets` | 1 | `src/sync/tabs.js:168` |

| CDP 事件 | 次数 | 主要落点 |
|---|---|---|
| `Fetch.authRequired` | 1 | `src/runtime/manager.js:1199` |
| `Fetch.requestPaused` | 1 | `src/runtime/manager.js:1147` |
| `Page.frameNavigated` | 2 | `src/runtime/manager.js:531`、`src/sync/session.js:192` |
| `Page.frameRequestedNavigation` | 1 | `src/runtime/manager.js:529` |
| `Page.frameStartedLoading` | 1 | `src/runtime/manager.js:530` |
| `Page.loadEventFired` | 2 | `src/runtime/manager.js:973`、`src/runtime/manager.js:988` |
| `Runtime.bindingCalled` | 1 | `src/sync/session.js:216` |
| `Target.attachedToTarget` | 1 | `src/runtime/manager.js:759` |
| `Target.detachedFromTarget` | 1 | `src/runtime/manager.js:788` |
| `Target.targetCreated` | 1 | `src/sync/tabs.js:159` |
| `Target.targetDestroyed` | 1 | `src/sync/tabs.js:164` |

`src/kernel/` 目录内自己的 CDP 调用只有 6 处：`Extensions.loadUnpacked` `src/kernel/extensions.js:91`、
`Storage.getCookies` `src/kernel/cookies.js:159`、`Storage.setCookies` `:183`、
`Target.getTargets` `:319`、`Target.attachToTarget` `:322`、`Network.deleteCookies` `:337`。
其余 36 种在 `src/runtime/manager.js`、`src/sync/`、`src/proxy/`、`src/agent/`。

## 4.5 `src/kernel/` 的注入与覆写面

| 面 | 做什么 | 位置 |
|---|---|---|
| `buildInjectionSource` | 生成 page 层注入脚本（主帧） | `src/kernel/inject.js:896` |
| `buildWorkerInjectionSource` | 生成 worker 层注入脚本 | `src/kernel/inject.js:914` |
| `sharedNoiseCoreSource` | 主帧与 worker 共用的噪声核（同一 seed 同一序列） | `src/kernel/inject.js:929` |
| 注入挂载点 | `Page.addScriptToEvaluateOnNewDocument` | `src/runtime/manager.js:1036` |
| 标记（markers） | 每个 seed 生成一组 `_xxxxxxxx` 标记名，用于自检「注入是否真跑过」 | `src/kernel/markers.js:28-67` |
| 请求级拦截规则 | 域名/资源类型黑白名单编译成 Fetch 规则 | `src/kernel/net-rules.js:76`（`compileNetRules`）、判定 `:134`（`decideRequest`） |
| 拦截执行 | `Fetch.enable` / `requestPaused` / `fulfillRequest` / `failRequest` | `src/runtime/manager.js:1137`、`:1147`、`:1175`、`:1181` |
| 拦截页 | 被拦请求返回自家 HTML 说明页 | `src/kernel/block-page.js:87`（`blockPageHtml`）、`:141`（`blockPageResponse`） |
| 扩展加载 | `Extensions.loadUnpacked` | `src/kernel/extensions.js:91` |
| 内核版本对齐 | 把指纹版本对齐到真内核版本 | `src/kernel/version.js:19`（`alignProfileToKernel`） |

`inject.js` 内部分区（覆写对象与位置）：PRNG `:75`、原生函数伪装 `:93`、2D 像素噪声 `:189`、WebGL 像素噪声 `:202`、
Audio 浮点噪声 `:216`、OffscreenCanvas `:226`、WebGL unmasked 标识 `:257`、Navigator `:288`、Screen `:325`、
Canvas 2D `:336`、Audio `:404`、ClientRects `:423`、媒体设备 `:452`、语音合成 `:715`、字体 `:792`、
worker 层 `:820`（WorkerNavigator `:822`、OffscreenCanvas `:871`、WebGL `:874`）。

---

# 五、假字段专项

## 5.1 判定口径（可复现）

1. 字段全集来自 `packages/profile/src/fields.generated.json`，共 **138** 个。
2. 对每个字段名（含驼峰变体）在 `src/{kernel,runtime,fingerprint,selfcheck,agent,sync,store,api,proxy}`、
   `web/`、`desktop/`、`mcp/`、`tools/`、`bin/` 做词边界匹配。**扫描范围不含 `packages/` 整棵**——
   那里是字段表本体（`fields.js`、`schema.sql`、`validate.js`、`aliases.js`、`repo.js`、`reference/overrides.mjs`），
   字段名出现在那里只说明「字段表里登记了这个字段」，不构成消费。
3. 只命中字段表 / API schema / 生成脚本的，**算没有消费路径**（豁免清单见 §0）。
4. 有命中的，再逐个看命中行：是「写库 / 搬运 / 回显」，还是「读出来拼启动参数 / 注入 / 下发」。
   前者不算消费。
5. 表单可见性三分来自 `src/api/schema.js`：`HIDDEN`（`:76-81`）、`CLOUD_ONLY`（`:84-88`）、
   `BASIC`（`:107-121`）；都不在的算「高级页可见」。

结果：**69** 个字段没有任何消费路径。复核后其中 3 个实为真消费（见 §5.5），**假字段最终 66 个**。

## 5.2 表单可见且可配的假字段 —— 48 个

这 48 个用户能在界面上填/切，填完存进库，但没有任何一处读它改变浏览器行为。**这是用户一用就会发现的那类。**

| # | 字段 | 分组 | 表单形态 | grep 命中 | 命中位置（前 4 处） | 结论 |
|---|---|---|---|---|---|---|
| 1 | `api_merged` | 启动与缓存 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 2 | `browser_compatibility_mode` | 浏览器与内核 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 3 | `browser_head` | 浏览器与内核 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 4 | `browser_kernel_config` | 浏览器与内核 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 5 | `browser_security_lock` | 启动与缓存 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 6 | `browser_security_lock_ignore_ids` | 启动与缓存 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 7 | `cache_backup` | 启动与缓存 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 8 | `cdp_mask` | 浏览器与内核 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 9 | `clear_cache_after_closing` | 启动与缓存 | 可见（基础页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 10 | `cover_args` | 启动与缓存 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 11 | `device_name` | 屏幕与硬件 | 可见（基础页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 12 | `dis_canvas_url` | 噪声四维 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 13 | `disable_console` | 隐私开关 | 可见（基础页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 14 | `domain_https` | 隐私开关 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 15 | `gpu_switch` | 浏览器与内核 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 16 | `gyroscope` | 屏幕与硬件 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 17 | `hidden_notification` | 隐私开关 | 可见（基础页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 18 | `ignore_agent_config` | 启动与缓存 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 19 | `image_size` | 隐私开关 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 20 | `kernelSandboxMode` | 浏览器与内核 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 21 | `login_user` | 基本信息 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 22 | `login_user_comment` | 基本信息 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 23 | `mac_address_config` | 屏幕与硬件 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 24 | `media_devices_config_v2` | 媒体设备 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 25 | `network_information_type` | 屏幕与硬件 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 26 | `new_mobile_mode` | 浏览器与内核 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 27 | `new_startup_page` | 启动与缓存 | 可见（基础页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 28 | `no_args` | 启动与缓存 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 29 | `open_google_api` | 隐私开关 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 30 | `open_tabs` | 启动与缓存 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 31 | `optimize_launch` | 启动与缓存 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 32 | `renderer_accessibility` | 浏览器与内核 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 33 | `repeat_config` | 基本信息 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 34 | `speech_voices` | 媒体设备 | 可见（基础页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 35 | `storage_strategy` | 启动与缓存 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 36 | `sync_password` | 隐私开关 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 37 | `tabAssistantExt` | 隐私开关 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 38 | `tabAssistantFeatures` | 隐私开关 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 39 | `translate_webpages` | 隐私开关 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 40 | `use_launch_optimize` | 启动与缓存 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 41 | `virtual_camera` | 浏览器与内核 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 42 | `whitelist_open` | 隐私开关 | 可见（高级页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 43 | `win_x` | 启动与缓存 | 可见（基础页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 44 | `win_y` | 启动与缓存 | 可见（基础页） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 45 | `tls` | 隐私开关 | 可见（高级页） | 4 处 | src/proxy/health.js<br>src/proxy/probe.js | 同名误命中：命中全是 `node:tls` / SOCKS5 协议名（`src/proxy/probe.js`、`src/proxy/health.js`），字段本身零消费 |
| 46 | `fakey` | 基本信息 | 可见（高级页） | 6 处 | src/api/routes.js<br>src/store/adspower-txt.js<br>web/pages/profiles.js | 命中只在「存取 / 搬运 / 回显」层（src/api/routes.js、src/store/adspower-txt.js、web/pages/profiles.js），没有一处读出来拼启动参数、注入或下发 |
| 47 | `disable_password_filling` | 隐私开关 | 可见（基础页） | 8 处 | src/api/contract.js<br>src/api/routes.js<br>src/store/transfer.js | 命中只在「存取 / 搬运 / 回显」层（src/api/contract.js、src/api/routes.js、src/store/transfer.js），没有一处读出来拼启动参数、注入或下发 |
| 48 | `ipchecker` | 网络与代理 | 可见（高级页） | 14 处 | src/store/adspower-txt.js<br>src/store/db.js<br>src/store/profiles.js<br>src/store/proxies.js | 命中只在「存取 / 搬运 / 回显」层（src/store/adspower-txt.js、src/store/db.js、src/store/profiles.js、src/store/proxies.js、src/store/transfer.js），没有一处读出来拼启动参数、注入或下发 |

## 5.3 显示但禁用的假字段 —— 14 个

这 14 个在界面上**看得见但点不动**（`CLOUD_ONLY`，`src/api/schema.js:84-88`），
理由是「需要 AdsPower 云端账号」；FreePower 是纯本地产品，云端不存在，所以它们永远拿不到值。
路由层对应的 `/api/v2/user/*` 也是占位（§1.1）。也就是说：界面摆了一个永久灰的格子。

| # | 字段 | 分组 | 表单形态 | grep 命中 | 命中位置（前 4 处） | 结论 |
|---|---|---|---|---|---|---|
| 1 | `category_id` | 基本信息 | 显示但禁用（需云端） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 2 | `company_id` | 基本信息 | 显示但禁用（需云端） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 3 | `fb_cloud_password_manager` | 隐私开关 | 显示但禁用（需云端） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 4 | `invite_code` | 基本信息 | 显示但禁用（需云端） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 5 | `is_fb_network_acceleration` | 启动与缓存 | 显示但禁用（需云端） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 6 | `not_sync_cache_not_open` | 启动与缓存 | 显示但禁用（需云端） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 7 | `storage_cloud_option` | 启动与缓存 | 显示但禁用（需云端） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 8 | `sync_extension_cache` | 启动与缓存 | 显示但禁用（需云端） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 9 | `sync_history` | 启动与缓存 | 显示但禁用（需云端） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 10 | `sync_indexeddb_cache` | 启动与缓存 | 显示但禁用（需云端） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 11 | `sync_localstorage_cache` | 启动与缓存 | 显示但禁用（需云端） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 12 | `sys_user_id` | 基本信息 | 显示但禁用（需云端） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 13 | `app_ids` | 基本信息 | 显示但禁用（需云端） | 1 处 | src/store/transfer.js | 命中只在「存取 / 搬运 / 回显」层（src/store/transfer.js），没有一处读出来拼启动参数、注入或下发 |
| 14 | `platform_account` | 基本信息 | 显示但禁用（需云端） | 3 处 | src/api/routes.js<br>web/pages/profiles.js | 命中只在「存取 / 搬运 / 回显」层（src/api/routes.js、web/pages/profiles.js），没有一处读出来拼启动参数、注入或下发 |

## 5.4 表单不可见的假字段 —— 4 个

API 能写、界面不显示（`HIDDEN`，`src/api/schema.js:76-81`），写完同样没人读。

| # | 字段 | 分组 | 表单形态 | grep 命中 | 命中位置（前 4 处） | 结论 |
|---|---|---|---|---|---|---|
| 1 | `ext_obj` | 基本信息 | 不可见（API 可写） | 0 处 | — | 全仓库零命中（除字段表与 API schema 外一次都没出现） |
| 2 | `ip_city` | 网络与代理 | 不可见（API 可写） | 3 处 | src/store/profiles.js<br>src/store/transfer.js | 命中只在「存取 / 搬运 / 回显」层（src/store/profiles.js、src/store/transfer.js），没有一处读出来拼启动参数、注入或下发 |
| 3 | `ip_region` | 网络与代理 | 不可见（API 可写） | 3 处 | src/store/profiles.js<br>src/store/transfer.js | 命中只在「存取 / 搬运 / 回显」层（src/store/profiles.js、src/store/transfer.js），没有一处读出来拼启动参数、注入或下发 |
| 4 | `ip_country` | 网络与代理 | 不可见（API 可写） | 5 处 | src/store/adspower-txt.js<br>src/store/profiles.js<br>src/store/transfer.js | 命中只在「存取 / 搬运 / 回显」层（src/store/adspower-txt.js、src/store/profiles.js、src/store/transfer.js），没有一处读出来拼启动参数、注入或下发 |

## 5.5 复核后纠正：分桶判「无消费」但实为真消费 —— 3 个

工具分桶把 `src/proxy/` 归到 `other`，导致下面 3 个被误判。按实际语义纠正，**不计入假字段**。

| 字段 | 工具原判 | 复核结论 |
|---|---|---|
| `mutli_level_proxy` | 无消费（命中 4 处） | 真消费：`src/proxy/chain.js:150-153` 用它决定「浏览器外两跳链」，内核只看到本地链端口。工具分桶把 `src/proxy/` 归到 `other`，误判。 |
| `random_fingerprint` | 无消费（命中 4 处） | 真消费：`src/store/profiles.js:323-332` 在保存时按它重算整套指纹（`newSeed()` + `regenerateFingerprint()`，随后写回 `0`）；`:526` 是「换一个随机指纹」的接口。 |
| `profile_tag_ids` | 无消费（命中 20 处） | 真消费：标签功能本体（`src/store/tags.js`、`src/api/routes.js` 标签接口、`web/pages/edit.js` 勾选、`web/pages/profiles.js` 显示筛选）。 |

## 5.6 别名 —— 1 个

| 字段 | 结论 |
|---|---|
| `browser_run_args` | 别名，落到 `launch_args`；归一点 `src/api/routes.js:83-84`，**真消费**（进内核命令行） |

---

# 附录 A：怎么复现这些数字

全部在仓库外的副本上跑，仓库零改动。脚本在 `C:\Users\1\AppData\Local\Temp\fp-inv\`：

| 脚本 | 作用 |
|---|---|
| `dump-routes2.mjs` | 真跑 `buildRoutes()` 导出全部路由（含 opts），用于「注册项 / 组合 / 占位」计数 |
| `gen-routes.mjs` | 静态解析 `routes.js`，给每条注册语句配 handler 落点与章节分组 |
| `gen-pages2.mjs` | 扫 `web/pages/*.js` 的 `h('button'|'input'|'select')` 与 `type:'checkbox'`，配点击落点 |
| `gen-cdp.mjs` | 扫 `src/**` 的 `.send('X.y')` 与 `on('X.y')`，得 CDP 命令/事件清单 |
| `fakefields2.mjs` | 138 个字段逐个词边界 grep，按目录分桶 |
| `verdict.mjs` | 结合 `src/api/schema.js` 的可见性，判定「有消费 / 无消费 / 别名」 |

命令（Node 侧编排，不用 PowerShell 处理中文文本）：

```
git archive --format=zip -o %TEMP%\fp-inv\head.zip c094c22
Expand-Archive %TEMP%\fp-inv\head.zip %TEMP%\fp-inv\tree2
node %TEMP%\fp-inv\dump-routes2.mjs %TEMP%\fp-inv\tree2 %TEMP%\fp-inv\data2 %TEMP%\fp-inv\routes-head.json
node %TEMP%\fp-inv\gen-routes.mjs  %TEMP%\fp-inv\tree2 %TEMP%\fp-inv
node %TEMP%\fp-inv\gen-pages2.mjs  %TEMP%\fp-inv\tree2 %TEMP%\fp-inv\gen-pages2.json
node %TEMP%\fp-inv\gen-cdp.mjs     %TEMP%\fp-inv\tree2 %TEMP%\fp-inv\gen-cdp.json
node %TEMP%\fp-inv\fakefields2.mjs %TEMP%\fp-inv\tree2 %TEMP%\fp-inv\fields-bucket-head.json
node %TEMP%\fp-inv\verdict.mjs     %TEMP%\fp-inv\tree2 %TEMP%\fp-inv\fields-bucket-head.json %TEMP%\fp-inv\routes-head.json %TEMP%\fp-inv\verdict-head.json
```

## 附录 B：给不出落点的地方（如实写）

| 位置 | 情况 |
|---|---|
| 启动参数里 `--enable-features` / `--enable-blink-features` | 系统**从不主动产出**，只有用户自己填 `launch_args` 才会出现（`src/kernel/launch-args.js:156`）。没有对应的界面开关。 |
| 假字段 48 个的「生效点」 | **未找到实现**。grep 范围见 §5.1 第 2 条；命中只有存取/搬运/回显，没有读取消费。 |
| 团队模块（子账号 / 角色 / 环境共享 / 审计） | 路由 `/api/v2/user/*`、`/api/v2/user-group/list` 全部是占位（§1.1）；界面无入口。 |
| RPA（流程编排 / 模板 / 定时任务 / 任务日志） | 未找到实现；`#/agent` 是 AI Agent，不是 RPA。 |
| 云手机 | 未找到实现，路由与界面均无。 |
