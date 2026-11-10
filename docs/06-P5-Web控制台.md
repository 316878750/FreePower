# P5 交付：Web 管理控制台

日期：2026-11-10 · 数据目录 `data-ui` · 真 Chrome 156.0.8078.80 · 服务 `127.0.0.1:53450`

P5 的目标是一句话：**这套东西不能只有 API，用户得能用鼠标日常操作。**
所以这轮交付的是一个跑在本地服务里的 Web 控制台 —— 不装框架、不加构建链、不多一个进程。

---

## 一、这一版做了什么

| 页面 | 能力 |
| --- | --- |
| 环境列表 | 启动 / 停止 / 批量启动 / 批量停止 / 全部停止；运行态（含调试端口）3 秒刷新；自检摘要（`7✓ 8⚠ 0✗`）；搜索、分组筛选、全选；删除 |
| 环境编辑 | 11 组分栏表单；新建 / 编辑；实时校验；分组与标签的新建；绑定代理；国家切换（整组重算时区/语言/地理） |
| 代理管理 | 列表、新增、编辑、删除、按 `/proxy/check` 预检出口并显示 IP / 国家 / 延迟 |
| 自检报告 | 评分、通过/告警/失败、覆盖度 7/7/1、四个噪声哈希、跨重启一致性、15 项「声明值 vs 实测值」、重跑、HTML 报告 |

范围是 CEO 定的四页，**没有**设置页、主题、动效，也**没有** Electron 壳。

---

## 二、结构

```
浏览器 ── GET / ─────────────► web/index.html（服务端注入 api_key + 端口）
        └─ GET /ui/*.js ─────► web/{ui,api,app}.js + web/pages/*.js
        └─ /api/v2/... ──────► 同一个 node:http 服务（鉴权 / 限流 / CORS 全走原路）
```

关键点：**控制台和 API 是同一个进程、同一个端口**。没有另起一个 dev server，所以不存在「界面能开但 API 连不上」这种只在开发期成立的假象。

静态层（`src/api/static.js`）刻意做得很窄：

- 只放 `web/` 一个目录，只认 `/` 和 `/ui/*`；
- `.js` / `.css` / `.html` / `.json` / 图片之外的类型一律 404；
- 路径 `resolve` 后必须还在 `web/` 下，点开头的段直接拒 —— `/ui/../package.json`、`/ui/%2e%2e/package.json` 都是 404（测试里专门打了这两条）；
- 静态响应 `cache-control: no-store`：本地活页，别让浏览器拿旧 JS 骗自己。

控制台首页由服务端渲染注入 `window.__FP__ = {apiKey, port, version}`，页面不再向用户要 key。这个决定的边界写在 README 已知限制 17：**控制台的信任边界就是本机**。

---

## 三、校验为什么只有一份

这是本轮唯一需要设计的地方。CEO 的要求是「前端给的错误文案直接复用后端的 800005 + warnings，不要两套」，照字面做就是：前端别自己写规则。

于是拆成两个接口：

| 接口 | 作用 |
| --- | --- |
| `GET /api/v2/browser-profile/schema` | 从 `packages/profile` 的字段注册表生成：11 组、131 个可编辑字段的类型 / 值域 / 必填 / 默认值 / 覆盖度 / 说明。**表单长什么样由它决定** |
| `POST /api/v2/browser-profile/validate` | 只校验不落库，内部就是 `validateProfile()` —— 和 create / update 用的是同一个函数 |

前端（`web/pages/edit.js`）只做两件不含判断的事：

1. 按 `errors[].field` 找到输入框，加红框、把 `message` 原样贴在下面；
2. 把 `warnings[]` 原样列在顶部，`severity: hard` 标「硬冲突」、`soft` 标「软提醒」。

所以后端改一句文案、改一个值域，界面下一次请求就跟着变，**不存在两边打架**。测试 `test/ui.test.mjs` 与 `test/api.test.mjs` 都断言了文案逐字来自后端：

```
PASS  validate：非法时区文案与 create 同源  — [{"field":"timezone","message":"not an IANA timezone: Mars/Olympus"}]
PASS  validate：硬冲突进 warnings（带 severity）
```

编辑页实测（把时区填成 `Mars/Olympus`）：

- 顶部红条：`1 个字段不合法（后端校验原文，保存会被拒）timezone — not an IANA timezone: Mars/Olympus`
- 时区输入框变红，框下逐字显示同一句；
- 改回 `America/New_York` 后，红条消失、恢复「校验通过：没有硬冲突，也没有软告警」。

### 表单怎么排的

138 个字段平铺没人用得下去，所以：

- **11 组分栏**，标签与字段都来自注册表（基本信息 21 / 浏览器与内核 14 / UA 与语言 9 / 噪声四维 11 / 字体 2 / 屏幕与硬件 8 / 媒体设备 6 / 网络与代理 13 / 地理定位 5 / 隐私开关 22 / 启动与缓存 26）。
- 每组内再分两档：**基础**（常用、有人会改的）直接铺开；**高级**收进 `<details>` 折叠，标题写明「N 个，脚本旋钮，平时不用动」。
- 值域是枚举的（`canvas`、`webrtc`、`media_devices`…）渲染成下拉，且**显示人话、提交原值**：`1` → 「开启（同种子稳定）」、`disabled` → 「禁用」。API 契约一个字没改。
- 云端字段（`category_id` / `app_ids` / `sync_*_cache` 等）**禁用并注明「云端字段：FreePower 本地不生效」**，不假装能配。
- 只覆盖常用字段的中文名，其余直接显示 API 字段名（README 已知限制 18）：宁可丑一点，也不要「界面叫法 ↔ 文档字段名」对不上。

---

## 四、删除：二次确认 + 先停再删 + 连数据目录一起删

CEO 补的那条要求，落在三处：

1. **二次确认**（`confirmDialog`）：弹窗写明「本地硬删，不可恢复；会连 user-data 目录（cookie、登录态、缓存）一起删掉」；运行中会多一条黄色提示「会先停止浏览器，再删除」。
2. **先停再删**：`/api/v2/browser-profile/delete` 在删记录之前，对每个在跑的环境 `await stopProfile(id)` —— 记录没了而内核还在，就是谁也回收不了的孤儿进程。
3. **连 data 目录一起删**（这轮新增）：删完把 `data/profiles/<no>_<id8>/` 整个移除，响应里带 `userdata_removed` 计数。路径必须先 `resolve` 到 `profiles/` 之下才动手，算不对就宁可留着数据也不越界删。

实测：

```
删除返回 deleted + userdata_removed  — {"deleted":["485fdb08-…"],"userdata_removed":1}
user-data 目录已删除
删完再查报 100001
```

---

## 五、完整操作清单（界面上真点出来的）

环境：本机、真 Chrome、`data-ui` 数据目录、已有 5 个环境。

| # | 操作 | 结果 |
| --- | --- | --- |
| 1 | 打开 `http://127.0.0.1:53450/` | 环境列表，5 个环境，侧栏「运行中 N 个」 |
| 2 | 点「新建环境」 | 进编辑页，标题「新建环境」，11 个分组标签，基本信息 21 个字段 |
| 3 | 填名称 `控制台-新建演示`，国家选「日本」 | 顶部校验提示保持通过；国家决定 UA/时区/语言/经纬度 |
| 4 | 点「创建环境」 | toast「已创建 #10006」，自动回列表，新行出现：`未启动 / 未自检` |
| 5 | 点该行「启动」 | 1.7 秒后行内变 `运行中 :59445`，自检摘要出现 `7✓ 8⚠ 0✗` |
| 6 | 点自检摘要链接 | 报告页：评分 79、7/8/0、覆盖度 7/7/1、四个哈希、15 项逐条 |
| 7 | 点「重跑自检」 | 重新跑探针并刷新报告（运行中才可用） |
| 8 | 返回列表，点「停止」 | toast「已停止」，行变 `未启动`，自检摘要保留（标为上一次的） |
| 9 | 点「删除」 | 二次确认弹窗 → 确认 → 环境与 user-data 目录一起删除 |

第 3 步之后有个真实细节：**新建时前端只发「身份字段 + country」**，UA / 时区 / 语言 / 分辨率 / 硬件参数都由后端按 `country + 种子` 生成。原因是第一版把表单默认值全发回去，选了日本却建出 `timezone: UTC` 的环境 —— 见下面第八节的 bug ②。

---

## 六、截图

真实环境，5 个演示环境 + 1 个在跑：

| 文件 | 内容 |
| --- | --- |
| `docs/shots/01-list.png` | 环境列表（含运行中、自检摘要、批量按钮） |
| `docs/shots/02-edit.png` | 编辑页（基本信息 + 11 个分组标签） |
| `docs/shots/03-edit-invalid.png` | 填错时区：顶部红条 + 输入框红框 + 后端原文 |
| `docs/shots/04-edit-noise.png` | 噪声四维分栏（Canvas / WebGL 图像 / WebGL 掩码 / Audio / ClientRects） |
| `docs/shots/05-proxies.png` | 代理管理 |
| `docs/shots/06-edit-new.png` | 新建环境 |
| `docs/shots/07-list-running.png` | 新建的那个环境已启动 |
| `docs/shots/08-selfcheck.png` | 自检报告（评分 / 覆盖度 / 四个哈希 / 15 项） |
| `docs/shots/09-list-stopped.png` | 停止后 |

另一个界面证据：控件尺寸与布局是量出来的，不是看出来的（本轮跑在 1687×1250 窗口）：

```
sidebar 200×1250, background rgb(23,26,31)
page-head 1487×63, body background rgb(244,246,248)
面板 1447×769, 11 个 tab（标签与计数齐全）
horizOverflow: false（所有页面都没有横向溢出）
```

---

## 七、别处没说的两个约束

- **控制台自己有一条限流通道**：`x-freepower-client: ui` → 60 次/秒。界面一次操作会连发几个请求（列表 + 运行态 + 自检摘要），按 1/s 限会把自己挡在门外；但仍然限量，不是「带某个头就免限」。
- **外站嵌不了控制台**：非白名单 `Origin` 拿 `/` 也是 `403 CORS ERROR`（和 API 同一条规则），不是只挡 JSON 接口。

---

## 八、这轮实测抓出来的两个真 bug

**① 时区校验把 `UTC` 当成非法值。**
`validateField('timezone', …)` 原本直接查 `Intl.supportedValuesOf('timeZone')`，而这个枚举**不含 `UTC`、`Etc/GMT±N`、`Asia/Calcutta` 这类合法 ID**。后果不只是「UTC 存不上」：新建环境时表单默认时区是 `UTC`，于是**新建页永远顶着一个红条**，用户以为坏了。
改法：先查表，查不到再用 `new Intl.DateTimeFormat(…, {timeZone})` 试一次 —— Intl 认不认才是判据。`Mars/Olympus` 照样被拒，文案没变。`test/unit.test.mjs` 加了 9 条断言。

**② 同一个字段，三种形状喂进校验就报错。**
`launch_args` 对外是数组、落库是 JSON 字符串；`cookie` 对外是原始串、落库是 JSON 数组串。`/validate` 一开始直接校验入参原形，于是：

```
launch_args — must be a string
cookie — cookie must be list string
```

界面每次保存都被自己拦住。改法：`/validate` 在边界上做和 create/update 完全一样的转换（`normalizeLaunchArgs` + `cookieToStorage`，空的 cookie 视为「没有」），三处（input / validate / 表单提交）对齐。顺带修了 `cookie: null` 这类空值 —— 现在空值等于不设置，不再被当成非法值。

两个都是界面逼出来的问题：API 测试全绿的时候，它们一点症状都没有。

---

## 九、已知缺陷

1. **没有 Electron 壳**：没有托盘、开机自启、单实例锁、窗口快捷键。这是本轮有意后置的（CEO 定的顺序）。
2. **编辑页没有「未保存离开」拦截**：改了 20 个字段再点侧栏，改动会直接丢（只提示一次「有未保存的修改」，不拦）。后续要做 `hashchange` 拦截 + 确认弹窗。
3. **列表页一次最多拉 200 个环境**，没有虚拟滚动；上千环境需要分页或搜索依赖（搜索目前是前端过滤当前页）。
4. **自检摘要要额外一次请求**（`selfcheck-summary`）：列表页每页一次，可接受；环境数量上去后应该在 list 接口里带上。
5. **控制台不显示「上次自检是几次启动前」**：`stale` 只标「当前未运行」，没记「第 N 次启动的报告」。
6. **表单没有「复制环境」入口**（API 也没有这个能力，属 P6 范畴）。

---

## 十、怎么验

```powershell
# 不需要 Chrome（schema 10 + unit 35 + api 61 + ui 29）
npm run test

# 需要完整权限（真 Chrome，152 项）
npm run smoke

# 手动看界面
$env:FREEPOWER_DATA="$PWD\data-ui"; $env:FREEPOWER_PORT="53450"; node src/main.js
# 浏览器打开 http://127.0.0.1:53450/
```

`test/ui.test.mjs` 是这轮新增的 29 项契约测试，覆盖：静态托管（含两条路径穿越）、schema 形状（11 组 / 131 字段 / 值域来自注册表）、validate 与 create 同源、空 cookie 与空 `launch_args`、删除时清 user-data 目录、ui 通道限流额度、外站 Origin 403。
