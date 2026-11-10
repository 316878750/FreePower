# P4 交付：本地 API 完整化 + 批量启停

> 目标（CEO 定的顺序）：先让现有 AdsPower 脚本低成本迁过来 —— API 兼容比再补注入维度值钱。
> 本文对应 4 件事：8 条本地组装路由 1:1、CRUD 自己重写、批量启停、错误码与限流。

---

## 一、做了什么

### 1. 8 条本地组装路由 1:1 对齐（形状照拆解手 07 号清单）

| 路由 | 之前 | 现在 |
|---|---|---|
| `/status` | ✅ 形状对 | 免鉴权 + **不限流**（连轮询不会被打） |
| `browser/start` | ✅ | 新增 `launch_args` 单次覆盖（v1 JSON 串 / v2 必须是数组，报错文案对齐）、`force=1` |
| `browser/stop` | 返回 `{profile_id, stopped}` | **成功不带 `data`**（对手如此）；没开 → `800002` |
| `browser/active` | 返回 `{list:[...]}` ❌ | `{status:"Active", ...运行信息}` 或 `{status:"Inactive"}`；缺 id → `100002 Require user_id or serial_number` |
| `browser/local-active` | 列表但 status 是内部值 | `{list:[{status:"Active",...}]}` |
| `browser/cloud-active` | 不存在 | **明确报错**，绝不返回成功（见下） |
| `browser-profile/cookies` | 不存在 | `{cookies:"<login_cookie 原文>"}` |
| `browser-profile/kernels` | 不存在 | `{list:[{kernel_type,kernel,is_downloaded}]}`，非法类型 → `100002 Kernel type must be Chrome or Firefox.` |
| `browser-profile/list` | 只有 GET | 新增 POST；**`limit` 不传只回 1 条**（对手的坑，照抄）；`profile_id[]`/`profile_no[]`/`tag_ids`/`sort_type` 都支持 |

`cloud-active` 的处理是这次最刻意的决定：它查的是 AdsPower 云端账号下的环境状态，我们没有云。
所以它返回 `code:-1` + `data.supported:false` + `data.local_alternative`，**绝不假成功**——脚本若以为「环境已开」会直接下错单。

### 2. 本地库能支撑的增删改查（自己重写，不搬透传）

- 环境 CRUD：`create`/`update`/`delete`/`regroup`/`new-fingerprint`（≤10）、`delete-cache`（本地清缓存，白名单路径，绝不递归删整目录）。
- 分组：`list`/`create`/`update`/**`delete`**（删组不删环境，环境挪回 Default 并返回挪动数量；Default 组拒绝删除）。
- 标签：`browser-tags/list|create|update|delete`，8 个颜色枚举对齐；环境可用 `profile_tag_ids` 挂标签，list 支持按 `tag_ids` 过滤（CSV 边界匹配，不会 `tag_ab` 命中 `tag_abc`）。
- 代理列表：`proxy-list/create|update|list|delete`（create 的 body 是**顶层数组**，批 ≤500，`port must be number` 等文案逐字对齐）；环境用 `proxy_id` 引用代理，启动时自动展开成 `user_proxy_config`；删代理会解绑引用它的环境，避免启动时静默直连。
- `cookie` 字段按对手要求存「JSON 数组字符串」：脚本传原始串 `sid=xxx; uid=7` 也收，`cookies` 路由读出来还是原文。

### 3. 批量启停（多账号核心场景）

```json
{"code":0,"msg":"success","data":{
  "requested":3,"concurrency":3,"interrupted":false,"elapsed_ms":8120,
  "started":[{"profile_id":"a1","pid":123,"ws":{"puppeteer":"ws://..."},"debug_port":"60001","already_running":false}],
  "already_running":[],
  "failed":[{"profile_id":"a2","code":800003,"reason":"proxy_unreachable","message":"..."}],
  "skipped":["a3"]}}
```

- **并发上限**：默认 3（`FREEPOWER_BATCH_CONCURRENCY`），请求可传 `concurrency`，夹在 1..10。
- **失败清单**：`failed[]` 带 `profile_id` / `code` / `reason` / `message`；已经起的在 `started[]` 里，**不回滚**。
- **可中断**：`stop_on_error` 默认开。第一个失败后不再领新任务（在跑的会跑完），剩下的原样进 `skipped[]`，`interrupted:true`。用户立刻知道「哪些成了、哪些没轮到」。
- 批量停不中断：停是收敛操作，失败一个继续停下一个；没开的进 `not_running[]`。
- 路由：`browser/batch-start`、`browser/batch-stop`（v1/v2 都有），`browser-profile/stop-all`（关本机全部）。

### 4. 错误码 + 限流 + 占位

- 6 个错误码全覆盖：`-1` / `100001` / `100002` / `800002` / `800003` / `800005`，没有新增码。
- 未实现的 17 条云端接口（回收站、分享、成员、内核下载、fb/*、应用/分类…）统一返回 `-1` + `data.supported:false` + 说明，**不留 404 让脚本猜**。未知路径 404 也带 `data.supported:false`。
- 限流：`/status` 不限流；其余 1 次/秒；`x-freepower-client: mcp` 或 `x-adspower-client: mcp` 走 30 次/秒；超限报文逐字一致 `{"code":-1,"msg":"Too many request per second, please check"}`（HTTP 200，脚本按这句话重试）。
- 鉴权补上了对手的 `api-key` 头；CORS 非白名单改为 **403 + 纯文本 `CORS ERROR`**（之前是 JSON，脚本的 `res.json()` 会炸）。

---

## 二、怎么验证

```powershell
npm run test     # schema 10 + 单元 34 + 本地 API 契约 50（都不需要 Chrome）
npm run smoke    # 148 项，需要真实 Chrome + 完整权限
```

实测结果（2026-11-10）：

| 套件 | 结果 |
|---|---|
| `packages/profile/test/schema.test.mjs` | 10/10 |
| `test/unit.test.mjs` | 34/34 |
| `test/api.test.mjs`（新增） | 50/50 |
| `test/smoke.mjs` | **148/148**（P1+P3 前置 95 + P2 34 + P4 新增 19） |

P4 在冒烟里覆盖的关键断言：

- `active` 开着 → `status:"Active"` 且带 ws；停掉 → `status:"Inactive"`；缺 id → `100002`
- `local-active` 起 3 个后在列表里、批量停后为空
- **批量起 3 个**：`started.length===3`、每个都有 ws/debug_port、并发上限回显
- **批量失败中断**：死代理 + 两个 ghost id → `failed` 带 `code:800003`/`100001`，`interrupted:true`，`skipped>=1`，`started` 为空
- `cookies` / `kernels` 形状、标签/代理列表 CRUD、占位接口 `-1 + supported:false`
- `cloud-active` 明确报错

`test/api.test.mjs` 不需要 Chrome，专门盯契约：错误码、限流报文、CORS 纯文本、`data` 省略、v2 list 默认 1 条、批量语义、tags/proxies CRUD。

真实 curl 记录见 [P4-curl 实测](05-P4-curl实测.md)。

---

## 三、契约细节（容易漏、已对齐）

1. `data` 为 null 时**整个 key 不出现**（不是 `"data":null`）。
2. 成功文案是小写 `success`。
3. `/status` 不限流。
4. `ws.selenium` 只放 `host:port`；`debug_port` 是字符串。
5. `stop` 成功没有 `data`；`active` 用 `status` 而不是 `list`。
6. v2 list 的 `limit` 默认 1 条。
7. `create` 的 `launch_args` 出站：v1 是 JSON 字符串，v2 是数组；内部只存数组。
8. `password_filling` 内部只有一个布尔（`disable_password_filling`），出入两套字段都带。

---

## 四、已知缺陷 / 不做

| # | 项 | 现状 | 说明 |
|---|---|---|---|
| 1 | 云端接口 | 不支持（明确报错） | `cloud-active`、回收站、分享、成员、内核下载、`fb/*` 等 17 条；没有云就没有真实语义，假成功比报错危险 |
| 2 | `cloud-active` | 只做「明确报错」 | 不做假数据；本地场景用 `local-active` |
| 3 | 回收站 | 未实现 | 删除是真删；`recycle-bin/*` 返回不支持 |
| 4 | `share` | 未实现 | 依赖账号体系 |
| 5 | `download-kernel` | 未实现 | 内核矩阵下载排在后面；`kernels` 只报磁盘上真实存在的版本 |
| 6 | 批量启动不自动重试 | 失败即中断（可关 `stop_on_error`） | 重试策略交给脚本；避免我们反复撞坏代理 |
| 7 | 并发上限 10 | 再高会抢 CPU/磁盘，内核反而更慢 | 需要更大规模时再压测调 |
| 8 | `proxy-list` 不自动预检 | 保存即入库 | 预检走 `/api/v2/proxy/check`，避免批量建代理时被 500 次网络请求拖死 |

---

## 五、这轮踩到的坑

1. **`cookie` 字段不是普通字符串**：对手存的是 JSON 数组字符串（`cookie must be list string`），直接写原始串会被 schema 校验拒绝。修法：入站包成数组串、出站再还原成原文。
2. **PowerShell 5.1 的 `Get-Content`/`Set-Content` 默认按 ANSI 读写 UTF-8 文件**，会把中文源码转成乱码（`test/smoke.mjs` 因此被写坏过一次）。这类文件一律用 UTF-8 工具改，别用 PowerShell 文本命令。
3. **node 里 `execFileSync('curl.exe', …)` 捕获输出在受限环境会挂住**；curl 实测改用 PowerShell 原生调用 + body 文件。
4. **`active` 的 `status` 被内部值覆盖**：`{status:'Active', ...live}` 顺序写反，内部 `status:'running'` 把契约值顶掉；必须 `{...live, status:'Active'}`。
