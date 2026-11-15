# 22 · 全量对比：AdsPower 8.9.23 有、FreePower 没有（或名存实亡）

- 基线：FreePower `c094c22`（0.4.5 ②）；对手 8.9.23。
- 输入：对手侧 `adspower-reverse\8.9.23\29-全量能力清单.md`（458 项，287 项本地可复刻）；我们侧 `freepower\docs\21-FreePower实现清单.md`（162 路由注册项 / 66 假字段）。
- 本文由 CEO 合并，**两侧清单不是同一人做的**（对手侧拆解手、我们侧巡检），合并判断在本文。

## 0. 一句话结论

**漏掉的功能不多，但「名存实亡」的很多。**

对手 287 项本地可复刻能力里，我们真正缺的约 **40 项**（下面 B 类）。更严重的是我们自己的 **66 个假字段**（下面 A 类）——
它们能在界面上填、能存进库，但**没有任何代码读它去改变浏览器行为**。用户配了以为生效，实际什么都没发生，
这正是「每次等用户使用中发现问题」的根源：不是功能少，是**界面在说谎**。

优先级因此是 **A 类 > B 类**，不是反过来。

## 1. A 类：假字段（66 个）—— 最严重

口径见 `21-FreePower实现清单.md` §5.1：字段全集 138 个，按「谁读它」反查，
只命中字段表 / API schema / 存取搬运的不算消费。

| 分类 | 数量 | 说明 |
|---|---|---|
| 表单可见且可配 | **48** | 用户填完存进库，无人消费。**用户一用就会发现** |
| 显示但禁用（需云端） | 14 | 界面摆了个永久灰的格子，纯本地产品永远拿不到值 |
| 表单不可见（API 可写） | 4 | API 能写、界面不显示，写完同样没人读 |

### 1.1 最该先修的 12 个（基础页可见，用户最可能真去用）

| 字段 | 用户以为它会做什么 | 实际 |
|---|---|---|
| `clear_cache_after_closing` | 关闭环境后清缓存 | 无任何代码读 |
| `new_startup_page` | 设置启动页 | 无。真正生效的是 `open_urls`（`src/runtime/manager.js:843`） |
| `open_tabs` | 启动时打开指定标签页 | 无。同上 |
| `win_x` / `win_y` | 记住窗口位置 | 无 |
| `hidden_notification` | 隐藏通知 | 无 |
| `disable_console` | 禁用控制台 | 无 |
| `disable_password_filling` | 关掉密码填充 | 8 处命中全在存取层，`src/kernel/chrome.js` 零消费 |
| `speech_voices` | 指定语音列表 | 无（`speech_switch` 是另一个字段，那个真生效） |
| `device_name` | 改设备名 | 无。命中的是 `device_name_switch`，子串误撞 |
| `sync_password` | 同步密码 | 无 |
| `virtual_camera` | 虚拟摄像头 | 无 |
| `gpu_switch` | 切 GPU | 无。命中的是 `webgpu_switch`，子串误撞 |

> 抽查说明：`device_name` / `gpu_switch` / `tls` 三处「有命中」都是**子串误撞**
> （`device_name_switch` / `webgpu_switch` / `tls_switch` 与 `node:tls`），字段本身确实零消费。CEO 已独立复核。

### 1.2 其余 36 个可见可配的

`api_merged`、`browser_compatibility_mode`、`browser_head`、`browser_kernel_config`、
`browser_security_lock`、`browser_security_lock_ignore_ids`、`cache_backup`、`cdp_mask`、`cover_args`、
`dis_canvas_url`、`domain_https`、`gyroscope`、`ignore_agent_config`、`image_size`、`kernelSandboxMode`、
`login_user`、`login_user_comment`、`mac_address_config`、`media_devices_config_v2`、
`network_information_type`、`new_mobile_mode`、`no_args`、`open_google_api`、`optimize_launch`、
`renderer_accessibility`、`repeat_config`、`storage_strategy`、`tabAssistantExt`、`tabAssistantFeatures`、
`translate_webpages`、`use_launch_optimize`、`whitelist_open`、`fakey`、`ipchecker`、`tls`

**处理建议（我的决定）**：分三步，不要一次性全做。

1. **能一条命令生效的，立刻接上**（`--blink-settings`、`--disable-features` 这类）：
   `image_size`、`disable_console`、`hidden_notification`、`disable_password_filling`、`whitelist_open`。
2. **做不了的，界面上明确标「本版不支持」并把控件禁用**，不许留成可填的输入框。
   这条最要紧——**假字段比缺功能更坏**，它让用户以为配好了。
3. 剩下的按用户实际需求再逐个接（`win_x`/`win_y`、`clear_cache_after_closing` 这类改行为的不小）。

## 2. B 类：对手有、我们完全没有（约 40 项）

### 2.1 环境管理（14 项）

| 能力 | 对手入口 | 影响 |
|---|---|---|
| 书签批量改（追加/替换/清空，`.html` ≤3MB） | `accmanage.updateBookmark` | 中 |
| 批量改标签页（追加超 100 截断 / 替换全部） | `fbcc.fbccEditTabPage` | 中 |
| 批量改启动参数 | `fbcc.browserRunArgs` | 中（字段有、批量路由无） |
| 批量改指纹项 | `accmanage.batchFingerprint` | 中 |
| 批量改应用（环境的扩展） | `extension.extensionBatchModifyBrowserApp` | 中 |
| 按天数删缓存（删 N 天未开环境的缓存） | `fbcc.fbccDeleteCacheXDaysAgo` | **高**（磁盘黑洞） |
| 每环境自定义图标（6 种） | `fbcc.defaultIcon`/`idIcon`/… | 低（多开辨识） |
| 列锁定 / 自定义序号 / 序号批量生成（递增/递减/固定/随机） | `tips.lockColumn`、`fbcc.fbccCustomSortKey`、`logger.*` | 低 |
| 多条件筛选器组合 | `data.filterText.addFilters` | 中（我们只有单条件） |
| **合并 Cookie 可撤销** | `fbcc.fbccUndoMerge` | **高**（合错了没法退） |
| 标签批量追加超 30 截断 | `fbccAppendTabsWithLimit` | 低 |
| 本地备份快照 5 个 + 从备份恢复 + 关闭时自动备份 | `fbcc.fbccLocalBackupPolicy`、`accmanage.backupConfirm` | **高**（丢数据兜底） |
| 环境占用 / 多开模式提示 | `fbcc.lock.securityLock` | 中 |
| 缓存数据三视图（本地/云端/备份） | `accmanage.cache.tab.*` | 低（云端那两档我们不做） |

### 2.2 代理管理（6 项）

| 能力 | 对手入口 | 影响 |
|---|---|---|
| `.xlsx` 批量更新代理（≤1000，按代理 ID 匹配） | `proxyList.updateProxies` | **高**（换代理是高频） |
| 校验重复项 | `proxyList.proxyListDuplicateCheck` | 中 |
| 随机方式：随机全部 / 优先随机未使用 | `proxyList.proxyListRandomProxy` | 中 |
| IP 查询渠道预设（按类型各设，影响检测结果） | `proxyList.ipChannel1-8` | 中 |
| 关联环境数 / 关联环境 | `proxyList.proxyListAssociatedEnvironmentCount` | 中 |
| 导出代理 | `proxyList.proxyListExportProxy` | 中 |
| 代理标签（追加超 30 截断） | `proxyList.proxyListNewTabContent` | 低 |

**两处要澄清（我核过代码，不是缺口）**：

- **「编辑代理同步改关联环境」我们已经满足**，机制不同：环境按 `proxy_id` 引用代理
  （`src/store/proxies.js:153 proxyConfigOf`），改代理天然对所有引用它的环境生效，不需要「同步」这个动作。
- **「删除保护」我们换了语义**：对手要求「关联环境必须先同意改成 No Proxy」；
  我们直接清空绑定（`src/store/proxies.js:141-143`）并继续删。**这是有意的**（不留悬空引用），
  但界面上要说清「删代理会让 N 个环境变直连」，目前没说。
- **代理没有「分组」**：对手查遍 `proxyList` 326 条键只有标签，我此前把分组当缺口是错的，已更正。

### 2.3 应用中心（5 项）

| 能力 | 影响 |
|---|---|
| **Chrome 商店 URL 直接装扩展** | **高**（现在只能本地导入 zip） |
| 应用分类 / 跟随团队应用 / 固定到工具栏方式 | 中 |
| 商店下载失败分类提示（网络/校验/解压） | 低 |

### 2.4 窗口同步（2 项）

| 能力 | 影响 |
|---|---|
| 主控窗口颜色（同步时给主控描边） | 中（多窗口时辨识） |
| 子窗口用标签页打开（Chrome 127+） | 中 |

### 2.5 AI Agent（3 项）

| 能力 | 影响 |
|---|---|
| **定时任务（日/周/月/一次 + 执行记录）** | **高**（`cron`/`定时` 在 `src/agent` 零命中） |
| 13 个预置技能（FB/IG/Reddit/X/TikTok/Amazon/YouTube） | 中 |
| 自建技能（zip / 目录 / 远程 MD 安装） | 中 |

### 2.6 其他（4 项）

| 能力 | 影响 |
|---|---|
| 按域名关 canvas 噪声（`DisCanvasUrl`） | 低（对手为防破图） |
| Passkey 保存/同步 | 低（本地无落点证据） |
| 移动档触摸点数（`MaxTouchPoints`） | 低（只在移动档） |
| Cookie/密码的**文件级**导入导出 | 中（换机迁移；我们只有 CDP 级） |

## 3. C 类：做了但形态/语义不同（3 项）

| 项 | 差异 | 判断 |
|---|---|---|
| 同步异常状态档 | 对手有 `syncOperateSyncException`「同步异常」；我们引擎在个别窗口断连时**照样继续跑**，只报 degraded | **不改**。我们没有那个失败态，硬造一个对不上的状态词更糟；界面用 detail 说「有 N 个窗口连接断了」 |
| 关闭操作台 | 对手有独立的「关闭桌面小组件」开关项；我们只有 × + 托盘/页面重开 | 中，可补 |
| 缓存/书签/备份 | 对手三视图含云端；我们只有本地 | **不做云端**，本地那部分见 B 类 2.1 |

## 4. D 类：按既定范围不做（112 项，不重开）

- **要云 / 需账号**：费用中心与计费（26）、团队管理与权限（41）、环境分享、分组分享、动态代理生态、
  云端缓存同步、登录注册账号体系（14）、AI 点数计费、MCP 云文档。
- **明确超范围**：RPA / RPA Plus（27）、云手机 / 云号码（4）。
- **需自编译内核**：字体白名单（`DisabledFonts`）等 12 项。

> 这几类共 112 项，是用户已拍板不做或本机做不到的，**不进优先级表**。

## 5. 我建议的下一批（0.4.6）

排序依据：**先修「界面说谎」，再补「用起来会卡」**。

| 顺序 | 内容 | 为什么排这里 |
|---|---|---|
| 1 | **48 个可见假字段：能接的接上，接不了的禁用并写明** | 这是用户「用着用着发现问题」的根因。不修，补再多功能也还是会被意外撞到 |
| 2 | 合并 Cookie 可撤销 | 合错了目前没法退，属于不可逆操作 |
| 3 | 按天数删缓存 | 环境多了以后 `data\profiles` 是磁盘黑洞 |
| 4 | 代理 `.xlsx` 批量更新 + 重复校验 | 换代理是高频操作，手填 1000 条不现实 |
| 5 | 本地备份快照 5 个 + 从备份恢复 | 丢数据兜底，比任何功能都值钱 |
| 6 | Chrome 商店 URL 装扩展 | 现在只能本地 zip，用户第一反应就是贴商店链接 |
| 7 | AI Agent 定时任务 | 自动化真正省时间的入口 |

**不做**：上面 D 类 112 项；`win_x`/`win_y` 这类改行为的大件放到用户真提需求时再做。

## 6. 本文边界

- 对手侧 458 项全部来自拆解手 `29-` 号文（8,313 条中文文案为底），**没有一条是「一般认为 AdsPower 会这样」**。
- 我们侧 66 个假字段来自巡检 `21-` 号文，按「谁读它」反查；CEO 独立抽查了 12 个基础页字段 + 3 个子串误撞，结论一致。
- **没验过的**：假字段的「表单可见」三分来自 `src/api/schema.js` 的 `HIDDEN`/`CLOUD_ONLY`/`BASIC` 分桶，
  没有在真界面上逐个数过控件；B 类各项目前只确认「零命中」，**没有逐条验过对手的真实行为**（那需要对手客户端实测）。
