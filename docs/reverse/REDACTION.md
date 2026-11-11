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

## 6. 自检命令（**已换成结构扫描，别再按已知值扫**）

```powershell
cd C:\Users\1\.dsh\bot\workspace\adspower-reverse
node tools\scan-secrets.js
```

`tools/scan-secrets.js` 不认「哪些文件有真值」，而是按**结构特征**扫**全目录所有文本扩展名**：IPv4 / MAC / `password|token|api_key` 赋值 / `AIza…`、`sk-…`、`AKIA…` 形态的密钥。自动排除回环、私有网段、RFC 5737 文档段，以及 `8.9.23.0` 这种版本号误报。

## 7. 两条教训（都是我自己踩的）

### 7.1 脱敏扫描要按「结构」扫，不能按「我以为哪里有」扫

第一轮我报了个**假的 CLEAN**。原因：我的扫描模式是「我已知的那几个真值」，于是：

- `03b`、`08` 这两份早期报告**根本没进我的文件清单**，里面还留着真实出口 IP 和真实 MAC；
- 第二次自己补扫，又漏了 `tools/gen-matrix.js` —— 它是**生成 08 的脚本**，真 MAC 以「格式示例」的形式待在代码里，不修的话下次重跑会把真值又写回 08。

CEO 复核时抓到了前两处，第三处是我改完扫描规则后才暴露的。

**规则**：
1. 扫**全目录 + 所有文本扩展名**，不按「我知道哪几份有真值」挑文件；
2. 显式列出**跳过了什么**（`node_modules`、大 bundle、`slices`）并单独补扫；
3. 生成脚本（`gen-matrix.js` 之流）要算进去 —— **它们会把真值再生出来**；
4. 只报「命中 + 人工判定」，不自己下 CLEAN 结论；CLEAN 必须能列出每一条误报为什么是误报。

### 7.2 判断「什么是用户数据」之前，先确认它是不是真数据

我把 `MediaDevices` 里那三个设备名当成用户真实声卡/摄像头，认真做了占位替换 —— **白忙一场**。

那三个名字是 AdsPower 自己合成的：音频取自内置 6 条候选池，摄像头的 `(<4hex>:<4hex>)` 是字符串哈希算出来的，与用户硬件无关。

**教训**：脱敏前先回答「这个值是**观测**来的，还是**生成**来的」。生成出来的值不属于用户数据，脱敏它只是浪费；更糟的是会让人误以为「这里已经处理干净了」，掩盖真正的问题。反过来说，认错了还会丢掉一个检测抓手（见 `09-动态验证.md` §8.1）。

---