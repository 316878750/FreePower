/**
 * 按天数删缓存（0.4.7 ④）—— **删的是环境的内核数据目录（userdata），不是「清缓存」三个字那么轻**。
 *
 * ## 为什么要有它
 *
 * 环境一多，`data/profiles/` 就是磁盘黑洞（一个 userdata 几十到几百 MB）。而这件事**不可逆**：
 * 删掉的是 cache + cookie + localStorage + 书签 + 登录态，删完下次启动就是全新浏览器。
 *
 * ## 三条设计纪律
 *
 * 1. **先列清单，再动手**（两阶段：`plan` 只读，`apply` 才写）。
 *    用户看到的必须是「将删哪些、每个多大」，不是「已删除 N 个」。
 *
 * 2. **天数只认我们自己记录的「最后启动时间」**（`profiles.last_launch_at`），
 *    **绝不拿文件 `mtime` 猜** —— mtime 会被备份、复制、解压、杀毒软件改掉，
 *    拿它判「多久没开」会删掉用户天天在用的环境。
 *    没有记录的环境（这一版之前启动过的都是）**如实归到「判定不了、不删」**，并在清单里说明原因。
 *
 * 3. **只删「清单里那些」**。`apply` 逐个执行，每一条都如实报结果；删不掉的（被占用）
 *    走 `purgeProfileData` 的两阶段语义 —— 「删不掉」必须是「什么都没变」，不能是「删了一半」。
 *    这里**不删库里的记录**：环境还在（只是数据没了），下次启动会重新建一个干净的目录。
 *
 * ## 边界
 *
 * - 正在运行的环境**一律不删**（`state: 'running'`），不看天数。
 * - 回收站里的环境不参与（它们的记录还在，但数据由回收站的「彻底删除」负责）。
 * - 归档的环境**参与**（归档只是移出主列表，不是删除；它照样占磁盘）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { userDataDirFor } from './manager.js';
import { purgeProfileData } from './purge-data.js';
import { lastLaunchOf } from '../store/profiles.js';

/** 目录大小（字节）；算不出来给 null，**不拿 0 冒充** */
export function dirSizeOf(dir, { fsx = fs } = {}) {
  let total = 0;
  let seen = false;
  const walk = (d) => {
    let entries;
    try { entries = fsx.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(abs);
        else if (e.isFile()) { total += fsx.statSync(abs).size; seen = true; }
      } catch { /* 单个文件读不到就跳过，不因此整条失败 */ }
    }
  };
  try {
    if (!fsx.existsSync(dir)) return null;
    walk(dir);
  } catch {
    return null;
  }
  return seen ? total : 0;
}

/**
 * 算出「删 N 天未开环境」会删哪些（**只读，不动任何文件**）。
 *
 * @param {object[]} profiles 环境列表（要 `id` / `profile_no` / `name` / `last_launch_at` / `status`）
 * @param {{days:number, now?:Date, fsx?:object}} opts
 * @returns {{
 *   days: number,
 *   will_delete: object[],   // 将删（带 size_bytes / last_launch_at / days_unused）
 *   keep: object[],          // 不删（带 reason：recent / unknown / running / no_data）
 *   total_bytes: number,
 *   unknown_count: number,
 * }}
 */
export function planCacheCleanup(profiles = [], { days, now = new Date(), fsx = fs } = {}) {
  const d = Number(days);
  if (!Number.isFinite(d) || d < 0) throw new Error('days 必须是 ≥0 的数字');

  const willDelete = [];
  const keep = [];
  let totalBytes = 0;
  let unknownCount = 0;

  for (const p of profiles) {
    const launch = lastLaunchOf(p, { now });
    const dir = userDataDirFor(p);
    const size = dirSizeOf(dir, { fsx });
    const base = {
      profile_id: launch.profile_id,
      profile_no: launch.profile_no,
      name: launch.name,
      last_launch_at: launch.last_launch_at,
      days_unused: launch.days,
      dir_exists: size !== null,
      size_bytes: size,
    };

    if (launch.state === 'running') { keep.push({ ...base, reason: 'running', why: launch.reason }); continue; }
    if (launch.state === 'unknown') {
      unknownCount += 1;
      keep.push({ ...base, reason: 'unknown', why: launch.reason });
      continue;
    }
    if (launch.days < d) {
      keep.push({ ...base, reason: 'recent', why: `最近 ${launch.days} 天内启动过（阈值 ${d} 天）` });
      continue;
    }
    if (size === null) {
      // 天数够了，但目录不存在 —— 没有可删的东西，如实归「没有数据」而不是「已删除」
      keep.push({ ...base, reason: 'no_data', why: '这个环境没有数据目录（可能已经清过或从未启动）' });
      continue;
    }
    willDelete.push({ ...base, reason: 'idle_over_days', why: `${launch.days} 天没启动过（阈值 ${d} 天）` });
    totalBytes += size;
  }

  willDelete.sort((a, b) => (b.days_unused || 0) - (a.days_unused || 0));
  return { days: d, will_delete: willDelete, keep, total_bytes: totalBytes, unknown_count: unknownCount };
}

/**
 * 执行清理。**调用方必须先把 `planCacheCleanup` 的结果给用户看过并确认。**
 *
 * 每一条都走 `purgeProfileData`（先改名再删墓碑）：
 *   - `ok:true, removed:true` → 真删掉了（进 `deleted`，算释放空间）
 *   - `ok:true, absent:true`  → 目录本来就没有（进 `already_absent`，**不算「删掉了」、也不算失败**）
 *   - `ok:false, intact:true` → **一个字节都没动**（被占用），如实报，下次再试
 *   - `ok:false, data_detached:true` → 极罕见：改名后删不掉且改不回来，数据已不在原路径
 *
 * **只删清单里的那些**：函数签名收的就是清单，不自己重新挑 —— 免得「用户确认的」和
 * 「实际删的」不是同一批。
 *
 * @param {object[]} willDelete `planCacheCleanup().will_delete`
 * @param {{fsx?:object}} [opts]
 * @returns {{deleted:object[], already_absent:object[], failed:object[], freed_bytes:number}}
 */
export function applyCacheCleanup(willDelete = [], { fsx = fs } = {}) {
  const deleted = [];
  const alreadyAbsent = [];
  const failed = [];
  let freedBytes = 0;

  for (const item of willDelete) {
    const r = purgeProfileData({ id: item.profile_id, profile_no: item.profile_no }, { fsx });
    if (r.ok && r.removed) {
      deleted.push({ ...item, removed: true });
      freedBytes += Number(item.size_bytes) || 0;
      continue;
    }
    if (r.ok && r.absent) {
      // 目录已经不在了（预览之后被别的路径清掉 / 手动删了）：
      // **单独一栏**，不算进「已删除 N 个」—— 界面上写「已删除 3 个」而其中 2 个本来就没东西，
      // 就是条数虚报，和虚报释放空间是同一类错。
      alreadyAbsent.push({ ...item, absent: true });
      continue;
    }
    failed.push({
      profile_id: item.profile_id,
      profile_no: item.profile_no,
      name: item.name,
      reason: r.data_detached ? 'data_detached' : (r.reason || 'remove_failed'),
      intact: r.intact === true,
      error_code: r.error_code || null,
      error_message: r.error_message || '',
      detached_path: r.detached_path || null,
    });
  }

  return { deleted, already_absent: alreadyAbsent, failed, freed_bytes: freedBytes };
}
