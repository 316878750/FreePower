# P4 curl 实测记录（本地 API 完整化 + 批量启停）

> ⚠️ 本文是 P4 阶段的记录，描述的是当时状态；当前能力以 [README](../README.md) 为准。
> 正文里的自检摘要是 P4 当时的值（15 项、`7 pass / 8 warn`）；当前是 19 项、`10 pass / 9 warn / 0 fail`。
> 第 5 节 `local-active` 的样例已按 P7 后的真实响应重采（见该节标注）。

这轮不是跑 mock，是真起了一个 FreePower 服务、真起 Chrome、真用系统 `curl.exe` 打的。
下面的命令与响应都是从终端原样抄下来的，只做了三处处理，都在这儿说明白：

- **api_key 脱敏**：写成 `$FP_KEY`（值从 `data/local_api` 读，每次装都不同）。
- **长响应用 `…` 省略**：uuid、ws 地址、重复条目。省略的字段在正文里会点名，没省略的都是原样。
- **create / start / active / list 的响应裁掉了环境全量配置**（几十个指纹字段），只留关键字段，否则一屏放不下。所有 `code` / `msg` / 状态码一个没动。

实测环境：

| 项 | 值 |
| --- | --- |
| 时间 | 2026-11-10T16:28:14+08:00 |
| 数据目录 | `freepower/data-curl`（干净新建） |
| 服务 | `FREEPOWER_PORT=53417`，下称 `$FP` |
| 内核 | 系统 Chrome，目录名 `157.0.8103.40`，**实测跑的 `156.0.8078.80`**（见第 11 节） |
| 客户端头 | `x-freepower-client: mcp`（对这个头不限流，方便脚本连跑） |

`profile_id`、`pid`、`debug_port` 每次跑都不一样，下面抄的是这一次运行的实数；`code` / `msg` / 结构是稳定的。

复跑方式：

```powershell
$env:FREEPOWER_DATA="$PWD\data-curl"; $env:FREEPOWER_PORT="53417"
node src/main.js
# 另开一个窗口
$FP = "http://127.0.0.1:53417"
$FP_KEY = (Select-String -Path data\local_api -Pattern 'api_key=(.*)').Matches[0].Groups[1].Value
```

---

## 1. 探活 + 鉴权

`/status` 免鉴权、不限流，不带 api-key 也能打：

```bash
$ curl -s $FP/status
{"code":0,"msg":"success"}
```

注意**没有 `data` 字段**。`ok(null)` 是整个 key 不出现，不是 `"data": null`——有些脚本会按 key 判断，返回 null 反而会踩。

不带 key 调业务接口：

```bash
$ curl -s $FP/api/v1/user/list -o NUL -w '%{http_code}'
401
```

401 是 HTTP 状态码，不是业务码。鉴权失败不该伪装成 `code:0`。

---

## 2. 建 3 个环境

```bash
$ curl -s -X POST $FP/api/v1/user/create \
    -H "api-key: $FP_KEY" -H 'content-type: application/json' -H 'x-freepower-client: mcp' \
    -d '{"name":"curl-a","country":"US","group_id":"0"}'
```

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "profile_id": "de0745f1-9c16-428a-9c12-bda86a8b4bdc",
    "profile_no": 10001,
    "name": "curl-a",
    "ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
    "timezone": "America/New_York",
    "kernel_version": "157.0.8103.40"
  }
}
```

另外两个同形状：

| 名字 | profile_id | profile_no |
| --- | --- | --- |
| curl-a | `de0745f1-9c16-428a-9c12-bda86a8b4bdc` | 10001 |
| curl-b | `2c70b230-4a67-4e58-92ef-6267ef3717e8` | 10002 |
| curl-c | `0aae21b3-cd54-46ec-9cd8-4b573f6e0624` | 10003 |

`country=US` 会自动生成对得上的 UA / 时区 / 语言，不用手填。`ua` 声明的是 `Chrome/157`，跟内核目录名一致（真跑起来的版本差异见第 11 节）。

---

## 3. 起 1 个 + 批量起 3 个

单环境启动：

```bash
$ curl -s $FP/api/v1/browser/start?user_id=de0745f1-9c16-428a-9c12-bda86a8b4bdc \
    -H "api-key: $FP_KEY" -H 'x-freepower-client: mcp'
```

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "pid": 45880,
    "debug_port": "55755",
    "ws": {
      "puppeteer": "ws://127.0.0.1:55755/devtools/browser/cd28791c-a9e4-4c3f-9800-1cad788b6f2f",
      "selenium": "127.0.0.1:55755"
    },
    "status": "running",
    "already_running": false,
    "real_version": "156.0.8078.80",
    "selfcheck": { "ok": true, "score": 79, "pass": 7, "warn": 8, "fail": 0 }
  }
}
```

`ws.puppeteer` 直接喂给 puppeteer `connect()` 就能接；`ws.selenium` 是给 Selenium 的 `127.0.0.1:port` 形式。`real_version` 是内核自己报的，不是我们猜的。

> 上面两条响应里的 `selfcheck` 摘要是 P4 当时的真值（15 项、`7 pass / 8 warn`、score 79）；
> 当前是 19 项、`10 pass / 9 warn`、score 81，结构不变（见第 5 节重采的 `local-active` 样例）。

批量起 3 个（第一个已经在跑）：

```bash
$ curl -s -X POST $FP/api/v1/browser/batch-start \
    -H "api-key: $FP_KEY" -H 'x-freepower-client: mcp' \
    -d '{"user_ids":["de0745f1-…","2c70b230-…","0aae21b3-…"],"concurrency":3}'
```

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "requested": 3,
    "concurrency": 3,
    "interrupted": false,
    "elapsed_ms": 10469,
    "started": [
      { "profile_id": "de0745f1-…", "already_running": true,  "pid": 45880, "debug_port": "55755",
        "ws": { "puppeteer": "ws://127.0.0.1:55755/devtools/browser/cd28791c-…", "selenium": "127.0.0.1:55755" } },
      { "profile_id": "2c70b230-…", "already_running": false, "pid": 81076, "debug_port": "54947",
        "ws": { "puppeteer": "ws://127.0.0.1:54947/devtools/browser/ce63b344-…", "selenium": "127.0.0.1:54947" },
        "warnings": [
          { "field": "proxy", "message": "未绑定代理：出口即本机 IP，跑真实账号请务必绑代理", "severity": "soft" },
          { "field": "ip",    "message": "浏览器出口探测失败：出口探测页没有内容（代理拦截或页面没加载完）", "severity": "soft" }
        ] },
      { "profile_id": "0aae21b3-…", "already_running": false, "pid": 61908, "debug_port": "54948",
        "ws": { "puppeteer": "ws://127.0.0.1:54948/devtools/browser/857856ea-…", "selenium": "127.0.0.1:54948" },
        "warnings": ["同上两条"] }
    ],
    "already_running": ["de0745f1-…"],
    "failed": [],
    "skipped": []
  }
}
```

三个要点：

- **每个环境各自一个 debug_port**（55755 / 54947 / 54948），不会撞端口。
- 已经在跑的那个不会被重启，进 `started` 且 `already_running:true`（脚本拿到的 ws 仍然可用），同时也在 `already_running` 列表里。
- `elapsed_ms: 10469`——3 个并发起、每个都要真实拉起 Chrome + 跑自检 + 探出口 IP，10 秒是正常量级。批量不是「瞬间返回」。

---

## 4. 幂等重复 start

同一个环境再 start 一次：

```bash
$ curl -s $FP/api/v1/browser/start?user_id=de0745f1-9c16-428a-9c12-bda86a8b4bdc -H "api-key: $FP_KEY" -H 'x-freepower-client: mcp'
```

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "pid": 45880,
    "debug_port": "55755",
    "ws": { "puppeteer": "ws://127.0.0.1:55755/devtools/browser/cd28791c-…", "selenium": "127.0.0.1:55755" },
    "status": "running",
    "already_running": true,
    "real_version": "156.0.8078.80",
    "selfcheck": { "ok": true, "score": 79, "pass": 7, "warn": 8, "fail": 0 }
  }
}
```

`pid` 45880、`debug_port` 55755、ws 全一样，只有 `already_running` 从 false 变 true。
这是脚本最容易出事故的地方：重试逻辑如果每跑一次就多开一个浏览器，半小时后机器就炸了。同一个环境永远只有一份运行态。

---

## 5. active / local-active

```bash
$ curl -s $FP/api/v1/browser/active?user_id=de0745f1-9c16-428a-9c12-bda86a8b4bdc -H "api-key: $FP_KEY" -H 'x-freepower-client: mcp'
```

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "pid": 45880,
    "debug_port": "55755",
    "ws": { "puppeteer": "ws://127.0.0.1:55755/devtools/browser/cd28791c-…", "selenium": "127.0.0.1:55755" },
    "status": "Active",
    "already_running": true,
    "real_version": "156.0.8078.80"
  }
}
```

`status` 是 **`"Active"` 首字母大写**，跟对手一致；`start` 返回的 `status` 是 `"running"`。两个接口字段名一样但取值不同，这是照着对手的形状来的，不是我们随便定的。

本机全部已开（**2026-11-11 复采，P7 后**；`pid` / 端口 / ws / 哈希每次不同，结构稳定。
P4 当时的样例里 `ws` 还是字符串、没有 `workers` 字段，已按当前代码重采，不手改）：

```bash
$ curl -s $FP/api/v1/browser/local-active -H "api-key: $FP_KEY" -H 'x-freepower-client: mcp'
```

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "list": [
      {
        "profile_id": "67f52c82-d9eb-4197-b6a9-7de0fa784e45",
        "pid": 64552,
        "debug_port": "56425",
        "ws": {
          "puppeteer": "ws://127.0.0.1:56425/devtools/browser/baf831a2-c950-4127-b10c-5bcc4a6bbc52",
          "selenium": "127.0.0.1:56425"
        },
        "webdriver": "127.0.0.1:56425",
        "status": "Active",
        "real_version": "157.0.8103.40",
        "started_at": 1794380104,
        "already_running": false,
        "proxy": null,
        "egress": {
          "ok": false,
          "url": "http://ip-api.com/json/?fields=status,country,countryCode,regionName,city,timezone,isp,query",
          "error": "出口探测页没有内容（代理拦截或页面没加载完）"
        },
        "ua_aligned": null,
        "launch_args": { "applied": [], "rejected": [] },
        "warnings": [
          { "field": "proxy", "message": "未绑定代理：出口即本机 IP，跑真实账号请务必绑代理", "severity": "soft" },
          { "field": "ip", "message": "浏览器出口探测失败：出口探测页没有内容（代理拦截或页面没加载完）", "severity": "soft" }
        ],
        "workers": {
          "total": 13, "injected": 3, "skipped_extension": 4, "iframes": 1, "worklets": 1, "other": 3,
          "failed": [],
          "last": { "type": "service_worker", "url": "http://127.0.0.1:57940/fp-sw.js", "ms": 6 },
          "by_type": { "browser_ui": 2, "service_worker": 6, "iframe": 1, "other": 1, "worker": 1, "shared_worker": 1, "worklet": 1 }
        },
        "selfcheck": {
          "ok": true, "score": 81, "total": 19, "pass": 10, "warn": 9, "fail": 0,
          "full": 7, "partial": 10, "none": 2,
          "hashes": { "canvas": "a769b7fa", "webgl_image": "49a86523", "audio": "4ed404a1", "client_rects": "1b03423c" },
          "determinism": { "canvas": true, "webgl_image": true, "audio": true, "client_rects": true,
            "cross_restart": null, "compared_with": null,
            "note": "没有同内核留存的上一份报告，本次不判断跨重启一致性" },
          "generated_at": "2026-11-11T06:55:14.989Z",
          "report_url": "/api/v2/browser-profile/selfcheck?profile_id=67f52c82-d9eb-4197-b6a9-7de0fa784e45"
        }
      }
    ]
  }
}
```

要点：`ws` 是对象（`puppeteer` 是完整 ws 地址、`selenium` 是 `host:port`），每个元素是**完整的启动信息**；
`workers` 是 P7 新增的注入实况；`selfcheck` 是启动时自动跑的那次摘要（19 项 / `10 pass / 9 warn` / score 81）。

---

## 6. 批量停

```bash
$ curl -s -X POST $FP/api/v2/browser-profile/batch-stop \
    -H "api-key: $FP_KEY" -H 'x-freepower-client: mcp' \
    -d '{"profile_ids":["de0745f1-…","2c70b230-…","0aae21b3-…"],"concurrency":5}'
```

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "requested": 3,
    "concurrency": 5,
    "elapsed_ms": 669,
    "stopped": ["de0745f1-…", "2c70b230-…", "0aae21b3-…"],
    "not_running": [],
    "failed": []
  }
}
```

停比起快一个数量级（669ms vs 10469ms），因为停不用等自检和出口探测。

停完立刻查 active：

```bash
$ curl -s $FP/api/v1/browser/active?user_id=de0745f1-9c16-428a-9c12-bda86a8b4bdc -H "api-key: $FP_KEY" -H 'x-freepower-client: mcp'
{"code":0,"msg":"success","data":{"status":"Inactive"}}
```

`Inactive` 时只剩 `status`，没有 pid/ws——停掉的东西不该还在响应里装活着。
批量停之后查过进程表，没有残留 `chrome.exe`。

---

## 7. 错误码

六码全覆盖，逐个打一遍。

**100001 环境不存在**

```bash
$ curl -s "$FP/api/v1/browser/start?user_id=not-exist" -H "api-key: $FP_KEY" -H 'x-freepower-client: mcp'
{"code":100001,"msg":"Profile does not exist"}
```

**100002 参数缺失 / 非法**（两个不同场景同一个码）

```bash
$ curl -s $FP/api/v1/browser/active -H "api-key: $FP_KEY" -H 'x-freepower-client: mcp'
{"code":100002,"msg":"Require user_id or serial_number"}

$ curl -s "$FP/api/v2/browser-profile/kernels?kernel_type=opera" -H "api-key: $FP_KEY" -H 'x-freepower-client: mcp'
{"code":100002,"msg":"Kernel type must be Chrome or Firefox."}
```

**800002 环境没在运行**

```bash
$ curl -s "$FP/api/v1/browser/stop?user_id=de0745f1-…" -H "api-key: $FP_KEY" -H 'x-freepower-client: mcp'
{"code":800002,"msg":"profile is not running"}
```

**`cloud-active` 明确报不支持**

```bash
$ curl -s -X POST $FP/api/v1/browser/cloud-active \
    -H "api-key: $FP_KEY" -H 'x-freepower-client: mcp' \
    -d '{"user_ids":"de0745f1-…,2c70b230-…,0aae21b3-…"}'
```

```json
{
  "code": -1,
  "msg": "FreePower 不支持 cloud-active：该接口查的是 AdsPower 云端账号下的环境状态，FreePower 是纯本地产品，没有云端环境列表。本机已开环境请用 /api/v1/browser/local-active",
  "data": { "supported": false, "reason": "cloud_unavailable", "local_alternative": "/api/v1/browser/local-active" }
}
```

返回 `code:0` 加空列表会让脚本以为「云端没有环境在跑」，接着就去开环境、结果开出重复实例——比报错危险得多。所以这里必须硬报错，并且顺手告诉调用方本地该用哪个接口。

**占位接口一律明确不支持**

```bash
$ curl -s -X POST $FP/api/v2/browser-profile/recycle-bin/list \
    -H "api-key: $FP_KEY" -H 'x-freepower-client: mcp' -d '{"page":1}'
```

```json
{
  "code": -1,
  "msg": "FreePower 不支持该接口（AdsPower 依赖其云端，本地没有对应能力）：/api/v2/browser-profile/recycle-bin/list",
  "data": { "supported": false, "path": "/api/v2/browser-profile/recycle-bin/list" }
}
```

用已知码 `-1` + `supported:false`，不用 404 也不用自造码。脚本看到 `-1` 知道是「明确不支持」，看到 `-1` 又带 `path` 就知道是整条路由没实现，可以跳过继续跑。

---

## 8. 限流

规则：`/status` 不限流，其余 1 次/秒；带 `x-freepower-client` 的放行（脚本连跑不算滥用）。

同一秒打两次：

```bash
$ curl -s $FP/api/v1/user/list -H "api-key: $FP_KEY"
{"code":0,"msg":"success","total":3,"returned":3}

$ curl -s $FP/api/v1/user/list -H "api-key: $FP_KEY"
{"code":-1,"msg":"Too many request per second, please check"}
```

报文 `Too many request per second, please check` 是逐字对齐的（注意对手原文就是 `request` 不是 `requests`，我们跟着它的原文，不擅自改语法）。**HTTP 状态是 200**，业务码才是 `-1`——脚本按 JSON 判断，不会因为 429 把连接层搞乱。

---

## 9. CORS

非白名单 Origin：

```bash
$ curl -s $FP/status -i -H 'Origin: https://evil.example'
```

```
HTTP/1.1 403 Forbidden
content-type: text/plain; charset=utf-8
content-length: 10
...

CORS ERROR
```

403 + **纯文本** `CORS ERROR`，不是 JSON。这是浏览器侧约定的形状：跨域被拒时前端拿到的是纯文本，返回 JSON 反而会让某些 fetch 封装以为是业务响应去解析。

---

## 10. 其它本地组装路由

**cookies**（新环境没登录过，返回空串）

```bash
$ curl -s "$FP/api/v2/browser-profile/cookies?profile_id=de0745f1-…" -H "api-key: $FP_KEY" -H 'x-freepower-client: mcp'
{"code":0,"msg":"success","data":{"cookies":""}}
```

存的时候是按对手要求存 JSON 数组字符串，这个接口还原成原始 cookie 串给调用方，直接能塞进 `Cookie` 头。

**kernels**

```bash
$ curl -s "$FP/api/v2/browser-profile/kernels?kernel_type=chrome" -H "api-key: $FP_KEY" -H 'x-freepower-client: mcp'
```

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "list": [
      {
        "kernel_type": "chrome",
        "kernel": "156.0.8078.80",
        "is_downloaded": true,
        "path": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "source": "system",
        "in_use": true,
        "guessed_kernel": "157.0.8103.40",
        "probed": true
      }
    ]
  }
}
```

`kernel` 是**实测真版本**，`guessed_kernel` 是目录名猜的，`probed:true` 表示内存里那个数是从 `Browser.getVersion` 拿的。这段是第一版实测抓到问题后改的，细节见下一节。

**list**（v2 POST，`limit` 不传只回 1 条）

```bash
$ curl -s -X POST $FP/api/v2/browser-profile/list -H "api-key: $FP_KEY" -H 'x-freepower-client: mcp' -d '{"limit":10}'
```

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "total": 3,
    "limit": 10,
    "list": [
      { "profile_id": "de0745f1-…", "name": "curl-a", "serial_number": 10001, "batch_id": "0" },
      { "profile_id": "2c70b230-…", "name": "curl-b", "serial_number": 10002, "batch_id": "0" },
      { "profile_id": "0aae21b3-…", "name": "curl-c", "serial_number": 10003, "batch_id": "0" }
    ]
  }
}
```

---

## 11. 这轮实测抓到的两个问题

**① `kernels` 报了错版本，已修。**
第一次跑出来是 `"kernel": "157.0.8103.40"`，但同一次启动的 `real_version` 是 `156.0.8078.80`。
原因：`Application\` 下有 156/157 两个版本目录，我们的版本推断取了目录里最新的那个，可启动器 `chrome.exe` 实际跑的是注册表指向的 156。
这个错的后果不轻：调用方会按 157 去挑内核、对 UA，结果真跑起来是 156，指纹自相矛盾。
改法：启动探测过真版本就报真值，目录猜测降级成 `guessed_kernel`，另加 `probed:true` 标记。现在两边对得上。

**② `cookies` 返回空串是正常的**，新环境没登录过。这条写在这儿免得下次看到空串以为坏了——真正该验的是「登录后再取」能还原成原始串，那个在冒烟里覆盖了。

**③ batch-start 10.5 秒**不是卡住，是 3 个真 Chrome 并发拉起 + 每个都跑一次自检 + 探出口。要更快只能砍自检，那不值。

---

## 12. 复跑

```powershell
# 全量记录（自己起服务、自己打、自己收尾）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\curl-record.ps1
# → artifacts\curl-transcript.txt
```

脚本会自己建一个干净的 `data-curl` 数据目录、起服务、跑完这十几条、最后关掉服务，不碰你的 `data/`。

不跑 Chrome 的契约测试（快，CI 友好）：

```bash
node test/api.test.mjs   # 61/61（P4 当时 50）
node test/unit.test.mjs  # 46/46（P4 当时 34）
```