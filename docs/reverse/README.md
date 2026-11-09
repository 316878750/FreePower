# 逆向文档归档

竞品分析资料，供 FreePower 实现时对齐行为与接口形状。

- 来源：`C:\Users\1\.dsh\bot\workspace\adspower-reverse\8.9.23\`（Adspower 逆向拆解师产出）
- 分析对象：AdsPower Global **8.9.23**（Windows）
- 归档：2026-11-09
- 原始证据不进仓库（asar 清单、dll 字符串、客户端自带 skills、代码切片），留在上述工作目录

## 权威顺序

同主题有多份时，以「现行」为准，旧的那份只留作证据链。

| 文件 | 主题 | 状态 |
|---|---|---|
| [01-架构与LocalAPI.md](01-架构与LocalAPI.md) | 对手架构、自编译内核的判定依据 | 现行 |
| [02-指纹字段表.md](02-指纹字段表.md) | 139 字段 / 11 组，官方文档 × 内核代码对照 | 现行 |
| [03-启动参数拼装.md](03-启动参数拼装.md) | `browser/start` 参数静态拼装逻辑 | 被 03b 补强 |
| [03b-启动参数实测与内核配置落盘.md](03b-启动参数实测与内核配置落盘.md) | 真实 StaticConfig/DynamicConfig、base64 换表解密 | 现行 |
| [04-指纹注入层定位.md](04-指纹注入层定位.md) | policy loader + `SunBrowserPolicys` | 被 08 细化 |
| [05-browser-start契约.md](05-browser-start契约.md) | `browser/start` 请求/响应契约 | 现行 |
| [06-内核目录与下发更新.md](06-内核目录与下发更新.md) | 20 套内核目录、分块续传、签名校验 | 现行 |
| [07-LocalAPI路由全量清单.md](07-LocalAPI路由全量清单.md) | 54 条路由、限流、CORS | 现行 |
| [08-指纹注入落点矩阵.md](08-指纹注入落点矩阵.md) | 139 字段逐项落点归类 | 现行 |
| [fingerprint-fields.json](fingerprint-fields.json) | 机器可读字段定义（139 字段 / 11 组） | 现行 |

## 用法边界

- 这些是**行为与接口**的观察结论，不是可搬运的代码。仓库不包含 AdsPower 的任何二进制、资源、客户端自带文档原文或源码片段。
- 标「推测」的条目不要当事实用；落地前回到原文核对证据等级（【实】实测 / 【码】代码 / 【推】推测）。
- 与 FreePower 已知不兼容的部分，见根目录 `README.md` 的「不兼容项」。
