# 16 · 环境管理页内 tabs（0.4.3 ②）

> 交付内容：环境管理从「一个列表页」变成**一个侧栏项 + 三个页内 tab**
> （环境列表 / 分组管理 / 回收站），并把回收站的「彻底删除 / 清空」补上。
> 一笔提交，判据 `test/profiles-tabs.test.mjs`（39 条）。

---

## 一、为什么是页内 tabs，不是侧栏三项

逆向 `adspower-reverse/8.9.23/28-远端UI界面结构.md` §2 有原文证据：

```
environmentManagement:{tabs:[{labelKey:"nav.environmentTab",routeName:"browserList"},
                             {labelKey:"nav.groupTab",routeName:"group"},
                             {labelKey:"nav.recycleTab",routeName:"recycle"}]}
当路由 meta.childrenAsTabs===true 时，侧栏只出现一个条目，子路由变成页面顶部 tab 条（hRoutes）。
→ 侧栏没有「二级展开菜单」这种形态。
```

所以我们的侧栏**不加**第二、第三个环境相关入口，只在页内加一条 tab 条。
（`README` 的页面表也照这个说法改了：七个页面，其中环境管理内含三个 tab。）

## 二、形态：三条真路由

| tab | hash | 页面模块 |
|---|---|---|
| 环境列表 | `#/profiles` | `web/pages/profiles.js` |
| 分组管理 | `#/profiles/groups` | `web/pages/groups.js` |
| 回收站 | `#/profiles/recycle` | `web/pages/recycle.js` |

两条硬性实现细节：

1. **路由顺序**：`/profiles/groups`、`/profiles/recycle` 必须排在 `/profiles/([^/]+)`（编辑页）**前面**，
   否则 `groups` 会被当成环境 id 打开编辑页。判据用索引顺序钉住（`groups@… < id@…`）。
2. **tab 是 `<a href>`**，带 `aria-current="page"`：能中键新开、能收藏、地址栏直达，
   读屏软件也能读出「当前是哪个 tab」。`web/tabs.js` 是纯数据 + 画 DOM 的小函数，
   `tabOf(path)` 从 hash 反推当前 tab（末斜杠也认），编辑页 `/profiles/<id>` 返回 `null`。

每个页面模块自己画 tab 条（各传自己的 id），所以切 tab 不会把条弄丢 —— 判据逐个模块静态检查。

## 三、分组管理

- `GET /api/v2/group/list` 现在多给 `profile_count` 与 `remark`。
  依据：07- 号文 §181 把 `group/*` 归为 **B 类「自己设计返回即可」**，加个计数不算破坏契约。
- **`profile_count` 只数在用的环境**（`deleted_at IS NULL`）：界面上那个数字是给人看
  「这个组里有多少环境」的，把回收站里的算进去就是误导。
- 备注存在 `meta` 表（`group_remark:<id>`）：`groups` 表没有 `remark` 列，
  而 `group/update` 从 2026-11 起就支持 `remark`（对手允许 null）。不改表结构，沿用 meta。
- **删分组不删环境**：组里的环境统一挪回 Default，响应回 `moved`（只数在用的），
  回收站里的也一起挪（否则恢复出来会挂在一个不存在的分组上）。
  Default（`id=0`）拒删，报 `100002`。
- 界面上 Default 行的「删除」是 disabled 且有 title 说明，不是点了才报错。

## 四、回收站

`list` / `restore` 的形状**不动**（严格对齐 `22-回收站响应形状.md`：item 6 个键、
`data={list,page,limit}`、没有 `total`、`restore` 必须带 `group_id`）。界面按这个形状写：

- 分页 100/页（服务端 `limit` 上限就是 100），`delete_time` 是**秒级 Unix 字符串**，页面上本地化显示。
- 「恢复」弹窗里有分组下拉（默认选中它原来的分组名），**必须选一个**才发请求 —— 这是对手的契约，不是我们的发明。

### 新增：`POST /api/v2/browser-profile/recycle-bin/purge`

**这是对手没有的路由。** 22- 号文 §5.4 写得很清楚：

> 回收站里的记录能否彻底删除（find-a-hard-delete API for profiles）——
> 只看到 `check-hard-delete-list` 服务于清缓存，没看到「从回收站永久删」的路由。

我们加它的理由不是「猜对手有」，而是产品缺口：`delete` 是软删除、**不释放磁盘**，
回收站只进不出就等于磁盘黑洞（每个环境的 user-data 是 cookie + 缓存，几十个就是几十 GB）。
所以做，并且把语义写死：

| 边界 | 行为 |
|---|---|
| 只删回收站里的 | 在用环境 → `skipped: [{profile_id, reason:'not_in_recycle_bin'}]`，环境原样还在 |
| 参数必须显式 | `{profile_id:[…]}` 或 `{all:true}`；两个都没有 → `100002`，`data.field='profile_id'`；拼错（`profile_ids`）同样 `100002` |
| 顺序（两阶段） | 先停（理论上不该在跑）→ 把 `data/profiles/<no>_<id8>/`（`userDataDirFor()` 的上一级，路径由系统算）**整个 `rename` 成墓碑 `<no>_<id8>.purge-<6hex>`** → 删墓碑 → 删记录 + 清 `profile_extensions` / `profile_tags` |
| 盘删不掉（rename 失败） | **不删库**，一个字节没动，进 `skipped: {reason:'userdata_remove_failed', error_code, error_message}`；界面翻成「目录被占着，关掉之后再试，记录已保留」，不报成功 |
| 删墓碑失败 | 先 `rename` 回原名（尽力，回到「什么都没发生」）；改不回来 → `{reason:'userdata_remove_failed_after_rename', data_detached:true, detached_path}`，**连带删库**，界面明说「这条不能再恢复了」 |
| 残留墓碑 | `sweepTombstones()`：每次 purge 先扫 `.purge-*` 残留，不让上一次失败卡住第二次 |
| 出参 | `{purged:[…], skipped:[…], userdata_removed:N}` |

**为什么必须两阶段（这条是被 CEO 真缺陷打回来的）**：`fs.rmSync(dir,{recursive:true})`
**先删内容、再删目录**。目录被占用删不掉时抛 `EPERM`、内容已经删光了 —— 我们如实报「没删掉、
还能恢复」，用户点恢复拿回的是空壳，登录态全丢。**报告与实际相反，比静默成功更糟。**
改成先 rename 之后：rename 是原子操作，失败就什么都没发生，这是唯一能让「报的和做的」一致的做法。

**真实故障读数**（造失败前先探清楚，别拍脑袋）：

```
delete 探针（谁会真的让删除失败）
  A 独占打开文件（fs.openSync 'r+'）  → removed      删得掉（Node 默认带 FILE_SHARE_DELETE）
  B 子进程 cwd 设在该目录里            → EPERM  ✅    删不掉
  C attrib +R 只读                    → removed      删得掉（force 会重试）
  D 子进程 cwd 设在被删目录本身        → EPERM  ✅   同上

rename 探针（谁会让 rename 先失败）
  cwd 锁在 <dir> 本身                 → EBUSY，一个字节没动  ✅
  cwd 锁在 <dir>/userdata             → EPERM，一个字节没动  ✅
  独占句柄 FileShare.None 锁里面文件   → EPERM，一个字节没动  ✅
  fs.openSync 'r+' / attrib +R        → 删得掉（走不到这里）
```

判据用 B：起一个真进程把 cwd 钉在那个环境的目录里（模拟「没退干净的内核进程占着 user-data」），
然后 purge。断言：`purged` 为空且 `skipped` 点名该环境 / `reason === 'userdata_remove_failed'`
（**不是** `data_detached`）/ `error_code === 'EBUSY'` / **目录里 3 个文件一个不少且内容逐字节没变** /
回收站里还列着 / 没有墓碑残留。放开占用后**恢复成功**（文件还在），再删再 purge →
`purged=1`、`userdata_removed=1`、目录与记录都没了 —— 后半段是关键：不做这一步，「还在」有可能只是功能坏了。

**验法交代**：主路（rename 失败 / 正常删掉）用**真实占用**验；「删墓碑失败 → 改回原名」与
「双故障 → detached」这两支是**注入 fs** 验的 —— 真实环境要 rename 成功、rm 失败、且改名回来也
失败（两个故障同时发生），而本机三类真实占用都会让 rename 先失败、根本走不到那一步。
测试里这处明确标了「注入验」，别当成真实故障读数。

顺带把 skipped 的形状改了：原来是拼在一条中文串里（`userdata_remove_failed: EPERM…`），
现在 `reason` 是**稳定的机器可读串**、`error_code` / `error_message` 分开挂，
翻译交给界面（`web/pages/recycle.js` 的 `skipReasonText`）。脚本按 reason 判断要不要重试，
人看中文，两件事不挤在一条串里。**认不出来的 reason 原样显示** —— 吞成「未知原因」才是最坏的结果，
这条也钉了判据。

**参数必须显式**这条是被 CEO 抓过一次同类缺陷之后立的规矩：0.4.3 ① 的
`app/profile/set` 因为 `ext_ids ?? ids` 在字段拼错时取到 `undefined`，被当成空数组把勾选全清了，
还回 `code=0`。所以这里和那里的写法一致：**缺字段报错，显式空/显式 all 才算全量动作**。
判据：缺字段后回收站里那条还在。

### 为什么不做「30 天自动清理」

对手的删除文案写「环境将被移至回收站并保留 30 天」。我们不自动清 ——
不打招呼就删用户数据（cookie/登录态）比磁盘占着更糟。所以页面如实写「不会自动清理」，
腾磁盘由用户自己点。这条写进 README 已知限制 48。

## 五、顺带修的一处「文案与行为不一致」

列表页原来的删除弹窗写：

> 这是本地硬删，不可恢复。会连它的 user-data 目录一起删掉。

而从 2026-11-12（软删除落地）起，`delete` 只是置 `deleted_at`、目录留在盘上、能恢复。
也就是说**弹窗在骗用户**。这一版改成：

> 环境会移入回收站：可以随时恢复，user-data 目录（cookie、登录态）原样留在盘上。

按钮从「删除」改成「移入回收站」，成功 toast 也写「已移入回收站：X（可在「回收站」里恢复）」。
判据里钉了两条：文案含「移入回收站」、且不再出现旧的「这是本地硬删」。

## 六、与对手的差异（如实列）

| 项 | 对手 | 我们 |
|---|---|---|
| 彻底删除 | 无证据（22- §5.4） | 有，`recycle-bin/purge`（我们自己加的） |
| 30 天自动清理 | 文案写着保留 30 天 | **不做**，页面明说不会自动清理 |
| 分组计数 | 云端返回（形状未取证） | 本地按 `deleted_at IS NULL` 现算 |
| 恢复时选分组 | `group_id` 必填 | 同（下拉给了，但仍必填） |
| 参数错码 | `-1` | `100002`（我们全局口径，与对手的有意差异） |

## 七、判据

```
node --no-warnings test/profiles-tabs.test.mjs        # 60 PASS / 0 FAIL
node --no-warnings test/purge-lock-kernel.test.mjs    # 14 PASS / 0 FAIL（已进 npm run smoke）
npm test                                              # 已并入链
```

六段：tab 模型（纯函数）→ 路由顺序/页面静态检查 → 分组（真 HTTP）→ 回收站（真 HTTP + 真删目录
+ **真实占用的失败**）→ 文案与 skipped 翻译。回收站那段会真的建一个
`data/profiles/<no>_<id8>/userdata/` 加 3 个文件（Cookies / Login Data / Preferences），
purge 之后断言目录没了、库记录没了、`profile_no` 不再被占；4b 那段起一个真进程占住目录，
验「**rename 失败 = 一个字节没动**」（3 个文件一个不少、内容逐字节没变、回收站里还列着、无墓碑残留），
放开后能恢复、再 purge 能真删掉。`purge-lock-kernel` 补第二层：**恢复之后真起得来**
（真启动 → 锁 → 失败 → 放开 → 恢复 → 再真启动 → 再 purge 真删掉）。