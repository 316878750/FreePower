# AdsPower Global 8.9.23 · Local API 路由全量清单

> 采集：2026-11-09。版本 8.9.23（agent `v2.9.0.1`）。
> 证据标签：**【码】** `%APPDATA%\adspower_global\cwd_global\lib\main.min.js`（8.85 MB，仅 minify，`@数字`=字符偏移）；**【官】** 客户端内置官方文档 `cwd_global\lib\internal\adspower-browser\skills\references\*.md`（upstream `adspower-browser@2.1.1`）；**【实】** 本机实测。
> 更正：早前记录 53 条，**实际 54 条**。漏掉的是 `/api/v2/browser-tags/delete`——它的处理器别名是 `$`，首轮正则 `\w+` 没匹配到【码】@841027。

---

## 0. 通用约定

| 项 | 值 | 证据 |
|---|---|---|
| 监听 | `127.0.0.1:50325` | 【实】 |
| 鉴权 | 请求头 `api-key`（走云端校验 `POST https://api.adspower.net/sys/user/api/check-api-key?_local_api=adspower`）或 `login-token` | 【码】@128616 |
| 免鉴权 | `GET /status`（无 key 也回 `{"code":0,"msg":"success"}`） | 【实】 |
| 响应外壳 | `{code, msg, data?}`；`data` 为 `null` 时**该 key 不出现** | 【码】 |
| 成功 | `respondSuccess` → `{code:0, msg:"success"}`（**小写 success**） | 【实】 |
| 失败 | `respondFail` → `{code:-1, msg:"<原因>"}` | 【码】 |
| 限流 | **54 条路径里 53 条限流 1 次/秒**；`/status` **不在限流名单**，可随便轮询 | 【码】@842926 |
| 限流豁免 | 带 `x-adspower-client: mcp` → 走 mcp 限流器 **30 次/秒**（仍要求路径在名单内） | 【码】 |
| 超限报文 | `{code:-1, msg:"Too many request per second, please check"}` | 【码】@847902 |
| 限流分桶 | `{"1_1":[54 条里除 /status 外全部], "10_1":["/api/v1/fbbird/user/list"]}` → 只有 fbbird 列表是 10/秒 | 【码】@833365 |
| CORS | Origin 白名单正则不匹配 → **403 + 纯文本 `CORS ERROR`**（不是 JSON） | 【码】@846007 |
| 转发云端时的头 | 补 `x-client-local-api-version: 2.0`（v2）/ `1.0`（v1），透传 `x-adspower-client`、`x-mcp-client` | 【码】@555626 |
| bodyParser | json + form，上限 5 MB | 【码】 |

### 两种处理器风格（很重要）

- **A 类：本地组装响应**——处理器里有 `respondSuccess`，`data` 是自己拼的。只有 7 条：`/status`、`browser/start`、`browser/stop`、`browser/active`、`browser/local-active`、`browser/cloud-active`、`browser-profile/cookies`、`browser-profile/kernels`（8 条含 list 的二次改名）。
- **B 类：原样透传**——处理器里**没有** `respondSuccess`，直接把云端返回写进响应（`t.body = <upstream>`），本地只做参数校验 + 字段改名。**其余 46 条全是这一类。**

→ 对 FreePower 的含义：B 类路由在 AdsPower 里根本没有本地实现，是云端 API 的薄代理。没有云端就没有可抄的逻辑，必须自己设计返回结构。

### v1 / v2 是同一批处理器，靠 `apiVersion` 分支

54 条路由只用了 **46 个处理器类**；`/api/v1/browser/start` 与 `/api/v2/browser-profile/start` 是同一个类，`convertV2Params()` 负责字段改名【码】。
v1→v2 内部改名表见 `02-指纹字段表.md`（`group_id→batch_id`、`cookie→login_cookie`、`tabs→openfb_tab` 等）。

---

## 1. 全量路由表（54 条）

| # | 方法 | 路径 | 处理器（模块） | 入参 | 响应 `data` | 备注 |
|---|---|---|---|---|---|---|
| 1 | GET | `/status` | s(10559) | 无 | 无（仅 `{code:0,msg:"success"}`） | 免鉴权、**不限流** |
| 2 | GET | `/api/v1/browser/start` | o(96525) | query：`user_id`\|`serial_number`（前者优先）、`launch_args`（JSON 数组**字符串**）、`cover_args`、`no_args`、`headless`、`open_tabs`、`ip_tab`、`type`、`source`、`timeout`、`hidden_notification`、`disable_console`、`disable_password_filling`、`enable_password_saving`、`clear_cache_after_closing`、`cdp_mask`、`device_scale`、`full_pac_url` | `{ws:{puppeteer,selenium}, debug_port, webdriver}`（`type=rpa` 加 `userName/password/cookies/comment/browserName`；firefox 加 `marionette_port`） | A 类；幂等；见 `05` |
| 3 | GET | `/api/v1/browser/stop` | l(26991) | query：`user_id`\|`serial_number` | 无 | A 类 |
| 4 | GET | `/api/v1/browser/active` | u(72600) | query：`user_id`\|`serial_number` | `{status:"Active", ...运行信息}` 或 `{status:"Inactive"}` | A 类 |
| 5 | GET | `/api/v1/browser/local-active` | c(53588) | 无 | `{list:[...]}` | A 类；本机已开环境 |
| 6 | POST | `/api/v1/browser/cloud-active` | d(61010) | body：`user_ids`（逗号串，≤100） | 数组 | A 类 |
| 7 | POST | `/api/v1/user/delete` | g(64350) | body：`user_ids`（数组） | 透传 | |
| 8 | POST | `/api/v1/user/create` | f(24644) | body：`group_id`*、`name`、`remark`、`domain_name`、`open_urls`[]、`tabs`[]、`repeat_config`[]、`username`、`password`、`fakey`、`cookie`（str）、`platform_account`[]、`profile_tag_ids`[]、`random_fingerprint`、`category_id`、`user_proxy_config`{}、`proxyid`、`ip`、`country`、`region`、`city`、`fingerprint_config`{}、`ignore_cookie_error`、`ipchecker`、`storage_strategy`、`storage_cloud_option` | 透传（含新 `profile_id`） | 主建环境入口 |
| 9 | GET | `/api/v1/user/list` | h(57120) | query：`page`、`page_size`、`group_id`、`user_id`、`serial_number`、`search`、`user_sort` | 透传 | |
| 10 | GET | `/api/v1/fbbird/user/list` | m(80240) | query 同 9 | 透传 | **唯一 10/秒** |
| 11 | POST | `/api/v1/user/update` | _(15558) | body：`user_id`* + 同 8 | 透传 | |
| 12 | POST | `/api/v1/user/regroup` | w(22078) | body：`user_ids`[]、`group_id`* | 透传 | |
| 13 | GET | `/api/v1/group/list` | y(39246) | query：`group_name`、`page_size`（≤100，默认 10）、`page` | 透传 | |
| 14 | POST | `/api/v1/group/create` | v(44569) | body：`group_name`*、`remark` | 透传 | |
| 15 | POST | `/api/v1/user/delete-cache` | A(61053) | body：`user_ids`[] | 透传 | 旧版清缓存 |
| 16 | POST | `/api/v1/group/update` | b(47762) | body：`group_id`*、`group_name`*、`remark`（可 null） | 透传 | |
| 17 | GET | `/api/v1/application/list` | M(3411) | query：`category_id`、`page`、`limit`（1–100） | 透传 | 应用/扩展分类 |
| 18 | GET | `/api/v1/fb/list` | S(45353) | query | 透传 | Facebook 相关，遗留 |
| 19 | POST | `/api/v1/fb/page` | E(6829) | body + 强制注入 `type:"page"` | 透传 | |
| 20 | POST | `/api/v1/fb/bm` | x(2098) | body + 强制注入 `type:"bm"` | 透传 | |
| 21 | GET | `/api/v2/browser-profile/active` | u(72600) | `profile_id`\|`profile_no`（GET 也读 body） | 同 4 | |
| 22 | POST | `/api/v2/browser-profile/start` | o(96525) | body：`profile_id`\|`profile_no`、`launch_args`（**必须数组**）、`last_opened_tabs`、`proxy_detection`、`password_filling`、`password_saving`、`cdp_mask`、`delete_cache`、`device_scale`、`hidden_notification`、`disable_console`、`type`、`source`、`timeout`、`full_pac_url` | 同 2 | v2 映射见 `05` |
| 23 | POST | `/api/v2/browser-profile/stop` | l(26991) | body：`profile_id`\|`profile_no` | 无 | |
| 24 | POST | `/api/v2/browser-profile/create` | f(24644) | 同 8 + `platform`、`tabs`、`platform_account`、`category_id`、`profile_tag_ids`、`random_fingerprint` | 透传 | |
| 25 | POST | `/api/v2/browser-profile/update` | _(15558) | body：`profile_id`* + 同 24 + `tags_update_type`（`1` 替换/`2` 追加截断）、`browser_run_args`、`launch_args`（数组） | 透传 | |
| 26 | POST | `/api/v2/browser-profile/new-fingerprint` | p(93991) | `profile_id`[]\|`profile_no`[]，**≤10** | 透传 | 重新生成指纹 |
| 27 | POST | `/api/v2/browser-profile/list` | h(57120) | `profile_id`[]、`profile_no`[]、`group_id`、`limit`（**1–200，不传只回 1 条**）、`page`、`sort_type`、`sort_order`、`tag_ids`、`tags_filter`、`name`、`name_filter` | 透传 + 列表字段二次改名 | 最常用 |
| 28 | POST | `/api/v2/browser-profile/delete` | g(64350) | `profile_id`[] | 透传 | |
| 29 | POST | `/api/v2/browser-profile/recycle-bin/list` | J(72152) | `page`、`limit` | 透传 | 回收站 |
| 30 | POST | `/api/v2/browser-profile/recycle-bin/restore` | Q(44109) | `profile_id`（**字符串**）\|`profile_no`（字符串）\|`group_id`（数字） | 透传 | 只支持单个恢复 |
| 31 | POST | `/api/v2/browser-profile/delete-cache` | k(91141) | `profile_id`[]*、`type`[]*（`local_storage`/`indexeddb`/`extension_cache`/`cookie`/`history`/`image_file`） | 透传 | |
| 32 | GET | `/api/v2/browser-profile/cookies` | q(99764) | `profile_id`\|`profile_no`（query 优先，body 兜底） | `{cookies:"<解密后的 login_cookie 原文>"}` | A 类，单环境 |
| 33 | GET | `/api/v2/category/list` | M(3411) | query：`category_id`、`page`、`limit` | 透传 | **【实】实测 404**，虽在注册表与限流名单里 |
| 34 | POST | `/api/v2/browser-profile/share` | T(84463) | `profile_id`[]*（≤1000）、`receiver`*（邮箱/手机号）、`share_type`（1 邮箱/2 手机）、`content`[]（`name`/`proxy`/`remark`/`tabs`） | 透传 | |
| 35 | POST | `/api/v2/browser-profile/ua` | W(48342) | `profile_id`[]\|`profile_no`[]，≤10 | 透传（UA 列表） | |
| 36 | POST | `/api/v2/browser-profile/download-kernel` | V(48297) | `kernel_type`*（`Chrome`\|`Firefox`）、`kernel_version`*（数字串） | 透传 | 见 `06` |
| 37 | POST | `/api/v2/browser-profile/stop-all` | H(71045) | 无 | 透传 | 关本机全部 |
| 38 | GET | `/api/v2/browser-profile/kernels` | R(43710) | query：`kernel_type`（`chrome`\|`firefox`，大小写不敏感） | `{list:[{kernel_type, kernel, is_downloaded}]}` | A 类；本机 20 套 |
| 39 | POST | `/api/v2/browser-profile/update-patch` | B(26272) | body：`version_type`（`stable`\|`beta`） | 透传 | 升客户端 |
| 40 | POST | `/api/v2/user/create` | O(71585) | 成员字段（见下） | 透传 | 子账号 |
| 41 | POST | `/api/v2/user/update` | C(40874) | 成员字段 | 透传 | 日志文案复用 ProfileShareHandler（代码遗留） |
| 42 | POST | `/api/v2/user/reset_password` | L(77676) | 成员 id + 新密码 | 透传 | |
| 43 | POST | `/api/v2/user/delete` | P(57712) | 成员 id | 透传 | |
| 44 | GET | `/api/v2/user/list` | I(35876) | query，**为空则改读 body** | 透传 | |
| 45 | GET | `/api/v2/user-group/list` | N(30898) | query，为空则改读 body | 透传 | 成员分组 |
| 46 | POST | `/api/v2/proxy-list/create` | j(51677) | **顶层 JSON 数组**，每项 `type`*（`http`/`https`/`ssh`/`socks5`）、`host`*、`port`*（0–65535）、`user`、`password`、`proxy_url`、`remark`、`ipchecker` | 透传 | 批量 |
| 47 | POST | `/api/v2/proxy-list/update` | F(1461) | `proxy_id`* + 同 46 | 透传 | |
| 48 | POST | `/api/v2/proxy-list/list` | U(3041) | `limit`（1–100，默认 50）、`page`、`proxy_id`[] | 透传 | |
| 49 | POST | `/api/v2/proxy/dynamic-proxy-traffic` | z(794) | body（必须 object） | 透传 | 查动态代理流量；v2 新增 |
| 50 | POST | `/api/v2/proxy-list/delete` | Y(41133) | `proxy_id`[]（≤100） | 透传 | |
| 51 | POST | `/api/v2/browser-tags/list` | G(83391) | `ids`[]（≤100）、`limit`（1–200，默认 50）、`page` | 透传 | |
| 52 | POST | `/api/v2/browser-tags/create` | K(20178) | `tags`*：`{name`*(≤50), `color`}` | 透传 | color 8 值 |
| 53 | POST | `/api/v2/browser-tags/update` | X(55580) | `tags`*：`{id`*, `name`, `color`}` | 透传 | |
| 54 | POST | `/api/v2/browser-tags/delete` | $(76490) | `ids`[]* | 透传 | **首轮漏抓的一条** |

标签颜色枚举【官】：`darkBlue` `blue` `purple` `red` `yellow` `orange` `green` `lightGreen`。

---

## 2. 逐条错误文案（`code:-1`，可直接当 FreePower 的断言用例）

### 2.1 `/status`、`browser/start`、`stop`、`active`

| 路径 | msg |
|---|---|
| start | `launch_args must be array`（v2 传了非数组） |
| start | `launch_args must be list string`（v1 的 JSON 串解析后不是字符串数组） |
| start | `cover_args must be list string` |
| start | `Require user_id or serial_number`（v2：`Require profile_id or profile_no`） |
| start/stop/active | `Profile does not exist` |
| start | `[<id>] is being used by [<email>] and is not allowed to open` |
| start | `FlowerBrowser does not support running RPA!` |
| cloud-active | `Require user_ids` / `user_ids cannot exceed 100` |

`browser/start` 的业务错误码（100001/100012/800002…）见 `05-browser-start契约.md` §错误码，共 18 个。

### 2.2 环境（profile）增删改查

| 路径 | msg |
|---|---|
| create v1/v2 | `group_id is required` |
| create | `repeat_config must be an array`、`tabs must be an array`、`open_urls must be an array`、`profile_tag_ids must be an array`、`platform_account must be an array` |
| create | `cookie must be list string`（注意文案说 list，代码判的是 `typeof !== "string"`） |
| create | `user_proxy_config must be an object`、`fingerprint_config must be an object`、`fingerprint_config.webgl_config must be an object` |
| update v2 | `profile_id is required`、`launch_args must be an array`、`tabs must be an array` |
| update v1 | `user_id is required` |
| delete v2 | `profile_id is required`、`profile_id must be an array` |
| delete v1 | `user_ids is required`、`[user_ids] Incorrect format` |
| list v2 | `profile_id must be an array`、`profile_no must be an array`、`tag_ids must be an array` |
| new-fingerprint / ua | `Require profile_id or profile_no`、`Up to 10 profiles are supported per request.` |
| delete-cache v2 | `type must be an array`、`profile_id is required`、`profile_id must be an array` |
| recycle-bin/restore | `profile_id or profile_no is required`、`profile_id must be a string`、`profile_no must be a string`、`group_id must be a number`、`group_id is required` |
| share | `profile_id is required`、`profile_id is wrong`、`profile_id cannot exceed 1000`、`receiver is required`、`receiver must be an string`、`content must be an array` |
| regroup | `user_ids is required`、`[user_ids] Incorrect format`、`group_id is required` |
| group/update | `group_id is required` |
| cookies | `Require profile_id or profile_no` |

### 2.3 代理 / 标签 / 内核

| 路径 | msg |
|---|---|
| proxy-list/create | `request body must be array`、`request body must not be empty`、`proxy length must be less than 500`、`port must be number`、`port must be between 0 and 65535` |
| proxy-list/update | `port must be number`、`port must be between 0 and 65535` |
| proxy-list/list、delete | `proxy_id length must be less than 100` |
| dynamic-proxy-traffic | `Failed to get dynamic proxy traffic` |
| browser-tags/* | `failed`（三个都是这一句，没有细节） |
| download-kernel | `kernel_type and kernel_version are required`、`Kernel type must be Chrome or Firefox.`、`kernel_version is not a numeric strings`、`No matching kernel version available.`、`The kernel has an open profile and cannot be installed.`、`Operation failed, please try again.` |
| kernels | `Kernel type must be Chrome or Firefox.` |
| update-patch | `Update failed. The patch version cannot be updated while there are open profiles.` |

---

## 3. 本机实测过的三条

| 调用 | 结果 | 证据 |
|---|---|---|
| `GET /status` | `{"code":0,"msg":"success"}` | 【实】14:56 |
| `GET /api/v2/category/list` | **404**（尽管已注册） | 【实】 |
| `POST /api/v2/browser-profile/new-fingerprint` | 通（探测过，环境 id 已脱敏） | 【实】 |

> `/api/v2/category/list` 为什么 404 未定：路由存在（@839535）、限流名单里有它、处理器与 `application/list` 同一个类 `M`。可能是处理器内部 `apiVersion===V2` 分支走了不同云端口径而云端不认 **【推测】**。复刻时不要把这个 404 当契约。

---

## 4. 给 FreePower 的落地顺序

按「本地逻辑量」排序，这是真正要写代码的部分：

| 优先级 | 路由 | 为什么 |
|---|---|---|
| P0 | `/status`、`browser-profile/start`、`stop`、`active`、`local-active`、`stop-all` | A 类，本地组装，进程生命周期全在这 |
| P0 | `browser-profile/create`、`update`、`list`、`delete` | 环境 CRUD，`list` 的 `limit` 默认 1 条是个坑 |
| P1 | `browser-profile/cookies`、`ua`、`new-fingerprint`、`delete-cache` | 指纹/存储操作 |
| P1 | `browser-profile/kernels`、`download-kernel` | 内核目录（FreePower 走 CfT） |
| P1 | `proxy-list/*`、`browser-tags/*`、`group/*`、`user/*` | B 类透传，自己设计返回即可 |
| P2 | `recycle-bin/*`、`share`、`update-patch`、`fb/*`、`application/list`、`category/list` | 可后置 |
| 不做 | 云端成员体系（`/api/v2/user/*`、`user-group/list`）涉及账号服务 | 见范围说明 |

**必须照抄的三个契约细节**：
1. `data` 为 null 时整个 key 不出现（不要输出 `"data":null`）。
2. 成功文案是小写 `"success"`。
3. `/status` 不要限流；其余接口按 1 次/秒可拦，脚本会自己重试。

---

## 5. 未验证

1. **没有实抓任何 2xx/4xx 完整往返**（agent 14:56 后未再监听 50325），上表 `data` 列里 A 类是从代码推的、B 类标注为透传。
2. 鉴权失败的具体报文未抓（只知 403 `CORS ERROR` 是 Origin 白名单，`api-key` 错误走云端校验）。
3. `GET_MY_API_KEY` 的实际 URL 未取到（常量定义在 `@123910` 的导出表里，值需再定位）。
4. `/api/v1/fb/*`、`fbbird/*` 的入参只到「同 list」这一层，未逐字段展开（遗留功能，优先级低）。