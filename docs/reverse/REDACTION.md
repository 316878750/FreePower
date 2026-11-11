# 脱敏记录（REDACTION）

> 2026-11-11。原因：AdsPower 的本地 dump 里混着用户真实硬件与代理凭据，而这套笔记会推到 GitHub。
> 原则：**保留结构，不保留值**。报告 md 里本来就用占位，问题出在原始 dump 与工具脚本。

## 1. 替换表（值已从仓库移除，这里只记类别与占位符）

| 类别 | 占位符 | 出现在 |
|---|---|---|
| 环境 id（fbccId） | `p7demo1` / `p5demo2`（同长度假值） | `dyn-*`、报告 03b/05/08、旧脚本 |
| 账号级 invite code | `a1b2c3`（同长度） | 同上 |
| 代理出口 IP | `203.0.113.45`（RFC 5737 TEST-NET-3） | `dyn-extended-parameters*.json`、`dyn-dynamicconfig.json`、`dyn-staticconfig.json`、命令行 dump |
| 内网 IP | `192.0.2.10`（RFC 5737 TEST-NET-1） | 同上 |
| MAC 地址 | `AA-BB-CC-DD-EE-FF` | `dyn-staticconfig.json` |
| 主机名 | `DESKTOP-XXXXXXX` / `DESK-XXXXXXX` | `dyn-staticconfig.json` |
| 代理账号 / 密码 | `<redacted>` | `dyn-staticconfig.json` 的 `ProxyChain` |
| 序列号（serial_number） | `<serial_number>` | `dyn-extended-parameters*.json` |
| 本机用户名路径 | `C:\Users\<user>\` | 报告 01/06 等处的路径 |

## 2. 特意**保留**的

- **`GOOGLE_API_KEY`（`AIzaSyBOti4mM-…`）**：这是 Chromium 内置的公开默认 key，全世界 Chromium 都用，不是用户凭据。CEO 已确认不脱敏。
- **`DisabledFonts` 字体清单**：标准字体候选表，不是本机枚举结果。
- **`TTSEngines` 语音列表**：接近默认 Windows 语音表。
- **`BlockList` / `StrongBlockList` 域名**：AdsPower 服务端下发的黑名单，是产品数据。

## 3. 一个被我判错、事后更正的

`MediaDevices` 的三个 label（`Microphone Array (…)`、`Integrated Camera (…)`、`Speaker (…)`）我一开始当成**用户真实声卡/摄像头**，按硬件做了占位替换。

读了 agent 代码后推翻：这些是 **AdsPower 自己合成的假设备名**——音频取内置 6 条候选池，摄像头 label 恒为 `Integrated Camera (<4hex>:<4hex>)`，那串 VID:PID 由字符串哈希算出来。与真实硬件无关。

占位替换保留着（无害），但结论改为：**这里不存在硬件泄露；反而是一个新的检测点**。详见 `09-动态验证.md` §4.1.1。

## 4. `--extended-parameters` 密文的处理

不能只改明文 JSON —— 命令行 dump 里的那串密文**解码后就是同一份带真值的 JSON**。做法：
1. 解出原密文里的 JSON；
2. 按表脱敏；
3. **用 AdsPower 自定义字母表重新编码**，回填进 `dyn-cmdline-raw*.txt`。

校验：脱敏后两份命令行 dump 仍能解出 28 个键，结构不变（`tools/dyn/verify-sanitized.js`）。

## 5. 工具脚本里的硬编码

`restart-test.js`、`md5files.js`、`cfg-detail.js`、`decode-cfg.js`、`decrypt-cfg.js`、`gen-matrix.js` 原本硬编码真实环境 id，已改成环境变量 / 占位：

```
AP_PROFILE_ID / AP_INVITE_CODE / AP_PROFILE_DIR
```

`tools/sanitize.js` 的替换表在执行后已清空（文件头有说明），避免真值随仓库二次传播。需要重跑时从本机现场填，不要提交。

## 6. 自检命令

```powershell
cd C:\Users\1\.dsh\bot\workspace\adspower-reverse
# 真实值已从本文件移除；把模式从本机现场填入后再跑，不要提交填好真值的版本。
$pat = "<profileId>|<inviteCode>|<exitIP>|<lanIP>|<mac>|<proxyPassword>"
Get-ChildItem -Recurse -File -Include *.md,*.json,*.txt,*.js,*.log | Select-String -Pattern $pat
```

当前应为 **CLEAN**（`rea-probe\*.json` 里只剩 `C:\Users\1\` 这种本机路径，不含硬件/凭据）。