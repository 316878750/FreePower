# AdsPower Global 8.9.23 · `browser/start` 请求/响应契约（脱敏样例）

> 用途：给 FreePower 照着实现接口形状。
> 证据等级：
> - **【码】** 从 `cwd_global\lib\main.min.js` 直接读出（模块 96525 = v1 StartHandler，`@` 后为字符偏移）。
> - **【实】** 从本机真实落盘文件读出（`C:\.ADSPOWER_GLOBAL\cache\j41kc54_h99epb\`）。
> - **【未抓】** 实时 HTTP 往返没抓到——本机 Local API agent 已退出，`Get-NetTCPConnection -LocalPort 50325` 无监听。等有环境在运行时补一轮。
>
> 时间 2026-11-09 15:2x。所有凭据已脱敏。

---

## 1. 请求

### 1.1 v1：`GET /api/v1/browser/start`（全部走 query string）【码】

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `user_id` | string | 二者其一 | v2 叫 `profile_id` |
| `serial_number` | string | 二者其一 | v2 叫 `profile_no`；两个都给时 **`user_id` 优先** |
| `launch_args` | string | 否 | **JSON 数组的字符串**，不是数组本身，也不是逗号串 |
| `cover_args` | string | 否 | 同上，JSON 数组字符串 |
| `no_args` | `"0"`/`"1"` | 否 | 只留两条基线参数 |
| `headless` | `"0"`/`"1"` | 否 | |
| `open_tabs` | `"0"`/`"1"`/`"2"` | 否 | 开标签页策略 |
| `ip_tab` | `"0"`/`"1"` | 否 | 是否开 IP 检测页 |
| `type` | string | 否 | `"rpa"` 时响应里**多返回账号 cookie 等字段** |
| `source` | string | 否 | `"rpa_plus"` |
| `timeout` | number | 否 | 启动超时 |
| `hidden_notification` | `"0"`/`"1"` | 否 | |
| `disable_console` | `"0"`/`"1"` | 否 | |
| `disable_password_filling` | `"0"`/`"1"` | 否 | |
| `clear_cache_after_closing` | `"0"`/`"1"` | 否 | |
| `cdp_mask` | `"0"`/`"1"` | 否 | 非 `"0"` 一律按 `"1"` 处理 |
| `device_scale` | number | 否 | |
| `full_pac_url` | string | 否 | |

**校验失败响应**（`respondFail`，`code` 固定 `-1`）：

| 情况 | `msg` |
|---|---|
| 两个 id 都没给 | `Require user_id or serial_number`（v2：`Require profile_id or profile_no`） |
| `launch_args` 不是合法 JSON 数组 | `launch_args must be list string` |
| `cover_args` 不是合法 JSON 数组 | `cover_args must be list string` |
| id 查不到 | `Profile does not exist` |
| 环境被他人占用 | `[<id>] is being used by [<email>] and is not allowed to open` |
| firefox 内核 + `type=rpa` | `FlowerBrowser does not support running RPA!` |

### 1.2 v2：`POST /api/v2/browser-profile/start`（JSON body）

字段与 v1 的映射（`convertV2Params`，模块 96525）：

| v2 字段 | → v1 参数 | 转换 |
|---|---|---|
| `profile_id` | `user_id` | 直接 |
| `profile_no` | `serial_number` | 直接 |
| `launch_args` | `launch_args` | **数组** → `JSON.stringify` |
| `last_opened_tabs` | `open_tabs` | `"0"===last_opened_tabs ? "1" : "0"`（**反向**） |
| `proxy_detection` | `ip_tab` | 直接 |
| `password_filling` | `disable_password_filling` | `"1"===password_filling ? "1" : "0"`（**同名不同义**，注意） |
| `password_saving` | `enable_password_saving` | 直接 |
| `delete_cache` | `clear_cache_after_closing` | 直接 |
| `cdp_mask` `device_scale` `hidden_notification` `disable_console` `type` `source` `timeout` `full_pac_url` | 同名 | 直接 |

⚠️ `password_filling` 这条最容易踩：v2 传 `"1"`（要填密码）会被翻成 `disable_password_filling="1"`，而 v1 里 `"1"` 是**禁用**。语义对不上是 AdsPower 自己的历史包袱，复刻时建议**内部只保留一套 `enablePasswordSaving`/`disablePasswordFilling` 布尔**，在 API 边界做翻转。

### 1.3 脱敏请求样例【码 + 实】

```http
GET /api/v1/browser/start?user_id=j41kc54&launch_args=%5B%5D&headless=0&open_tabs=1&ip_tab=0&cdp_mask=0&device_scale=1&disable_password_filling=0&clear_cache_after_closing=0&timeout=60
Host: 127.0.0.1:50325
Origin: http://local.adspower.net
api-key: <32 位，已脱敏>
```

v2 等价：

```json
POST /api/v2/browser-profile/start
{
  "profile_id": "j41kc54",
  "launch_args": [],
  "headless": "0",
  "last_opened_tabs": "0",
  "proxy_detection": "0",
  "cdp_mask": "0",
  "device_scale": 1
}
```

---

## 2. 响应

### 2.1 成功外壳【码】

`respond(code, msg, data)` → `data` 为 `null` 时**整个 key 不出现**。

```json
{ "code": 0, "msg": "success", "data": { ... } }
```

注意 `msg` 是**小写 `success`**；而 `/status` 也是 `{"code":0,"msg":"success"}`（已实测）。

### 2.2 `data` 的形状【码，`formatOpenRes` @791759】

```json
{
  "ws": {
    "puppeteer": "ws://127.0.0.1:<port>/devtools/browser/<uuid>",
    "selenium":  "127.0.0.1:<port>"
  },
  "debug_port": "<port>",
  "webdriver": "<chromedriver 可执行文件路径>"
}
```

规则（逐条对得上 CEO 的三条要求）：

| 字段 | 规则 | 依据 |
|---|---|---|
| `ws.puppeteer` | 完整 ws URL，含 `/devtools/browser/<uuid>` | `formatOpenRes` 把 `debugUrl` 原样放进 `puppeteer` |
| `ws.selenium` | **只有 `host:port`，不带协议** | 代码 `debugUrl.match(/(127.0.0.1\|localhost\|\[::1\]):\d+/)[0]` |
| `debug_port` | 从 `selenium` 里按 `:` 切出第 2 段 | `i.split(":")[1]` |
| `webdriver` | 路径字符串 | `getWebDriver(browserType, kernelVersion)` |

**条件字段**（只有满足条件才出现）：

| 字段 | 条件 |
|---|---|
| `userName` `password` `cookies` `comment` `browserName` | **仅** `type=rpa` 时出现 |
| `marionette_port` | 仅 firefox 且拿到端口时 |

> `cookies` 是 `type=rpa` 时下发的登录态，**不要打进日志**。

### 2.3 脱敏响应样例【实 + 码】

`ws` 的端口和 uuid 不是编的——来自本机上一次真实启动后内核留下的文件
`C:\.ADSPOWER_GLOBAL\cache\j41kc54_h99epb\DevToolsActivePort`（60 字节）：

```
60328
/devtools/browser/b742df5a-8ba4-4c92-8b14-7775a01c6e9f
```

按 `formatOpenRes` 拼出来的真实响应：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "ws": {
      "puppeteer": "ws://127.0.0.1:60328/devtools/browser/b742df5a-8ba4-4c92-8b14-7775a01c6e9f",
      "selenium": "127.0.0.1:60328"
    },
    "debug_port": "60328",
    "webdriver": "C:\\Users\\1\\AppData\\Roaming\\adspower_global\\cwd_global\\chrome_142\\chromedriver.exe"
  }
}
```

`type=rpa` 时的额外字段（结构真实、值脱敏）：

```json
{
  "code": 0, "msg": "success",
  "data": {
    "ws": { "puppeteer": "ws://127.0.0.1:60328/devtools/browser/<uuid>",
            "selenium": "127.0.0.1:60328" },
    "debug_port": "60328",
    "webdriver": "...",
    "userName": "<平台账号>",
    "password": "<已脱敏>",
    "cookies": [ "<已脱敏，rpa 专用>" ],
    "comment": "<备注>",
    "browserName": "chrome"
  }
}
```

### 2.4 已经开着的情况【码】

`openByUserId` 第一步就是 `findCurrentDebugUrl(userId)`：
- 已在运行 → **直接**用现成 debugUrl 走 `respondOpenSuccess`，不重新启动（幂等）。
- 否则看 `getBrowserLaunchSnapshot` → 读 `<profileDir>/BrowserMessage`（内核启动后写的 JSON：`{pid, debug_link, marionette}`），有就按"已启动"返回。
- 都拿不到才真正走启动管线。

→ **`browser/start` 是幂等的**，重复调用不会开第二个浏览器。FreePower 必须复刻这个行为。

### 2.5 错误码表【码，模块 96525 起】

| code | 常量 | 含义 |
|---|---|---|
| `-1` | — | 通用失败（参数/id 问题，看 `msg`） |
| `100001` | OPEN_BROWSER_FAIL | 启动失败 |
| `100002` | — | 启动 URL 过长（`E2BIG`/`ENAMETOOLONG`） |
| `100012` | BROWSER_PATH_WRONG | 浏览器路径错误 |
| `100015` | BROWSER_DOWNING | 内核下载中 |
| `100016` | LOW_DISK_SPACE | 磁盘不足 |
| `100017` | RUN_IN_ZIP | 在压缩包里运行 |
| `100018` | DELETING_CACHE | 正在删缓存 |
| `100030` | — | 缓存下载失败（`DOWNLOAD_CACHE_FAIL`） |
| `100040` | INCOMPATIBLE_OS_VERSION | 系统版本不支持 |
| `100044` | — | 启动超时（`TIMEOUT`） |
| `100045` | — | 系统原因，建议重试 |
| `4294967295` | — | 系统级错误 |
| `800002` | PORT_FULL | 端口占满 |
| `800003` | HAS_NOT_IP | 没有 IP |
| `800004` | NO_NETWORK | 无网络 |
| `800005` | NO_PROXY | 代理不可用 |
| `800006` | 911_PATH_WRONG | 911 路径错 |
| `800007` | 911_NOT_RUN | 911 未运行 |

另外两种情况**不开新窗口但也算成功路径**：启动过程中用户手动关窗 → `{code:0, msg:"The window was closed during startup"}`。

---

## 3. 给 FreePower 的三条硬约束（照抄即可）

1. **`ws.selenium` 只放 `host:port`**，不要写成 `http://host:port` 或 `ws://...`。
2. **`debug_port` 是字符串**，不是数字。
3. **`browser/start` 必须幂等**：同一 profile 重复调用返回同一组 `ws`，不要再开一个进程。

再加上 CEO 已拍板的：`--remote-debugging-port=0` + 读 `DevToolsActivePort` 拿端口。

`DevToolsActivePort` 文件格式（**实测**，两行）：

```
<port>\n
/devtools/browser/<uuid>\n
```

→ `puppeteer = "ws://127.0.0.1:" + 第1行 + 第2行`
→ `selenium = "127.0.0.1:" + 第1行`

---

## 4. 还欠的动态验证

1. **实时 HTTP 往返没抓**：agent 已退出。下次有环境在运行时，一条命令即可补：
   ```
   curl.exe -s "http://127.0.0.1:50325/api/v1/browser/start?user_id=<id>&launch_args=%5B%5D" -H "api-key: <key>"
   ```
2. `webdriver` 路径已确认在 `<cwd_global>\chrome_<版本>\chromedriver.exe`（**实测**：`chrome_142\chromedriver.exe`，20,488,040 B；每个内核目录一个，不是共享一个）。上面的样例值即真实路径。
3. `BrowserMessage` 文件（`{pid, debug_link, marionette}`）只在运行期间存在，关闭即删——本机 100 个环境目录里一个都没剩。【实测为空】