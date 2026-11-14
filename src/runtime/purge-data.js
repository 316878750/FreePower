/**
 * 删一个环境的 user-data 目录 —— **两阶段：先改名，再删墓碑**。
 *
 * ## 为什么不能直接 `fs.rmSync(dir, {recursive:true, force:true})`
 *
 * 2026-11-14 CEO 复验抓到的真缺陷：`rmSync` 是**先删内容、再删目录**。
 * 目录被占住（Windows 不许删任何进程的当前目录 / 里面的文件被别人独占打开）时，
 * 内容已经删光了，最后一步删空目录才抛 `EPERM`。结果是：
 *
 *   接口报「没删掉、还能恢复」→ 用户点恢复 → 拿回来一个空壳环境，登录态全没了。
 *
 * 这比「静默成功」更糟：**它报的和实际做的正好相反**。
 *
 * ## 两阶段的依据（都是本机实测，不是猜的）
 *
 * 先把整个 `<profile_no>_<id8>` 改名成墓碑（同盘 rename 是原子的，要么全成要么全不动）：
 *
 * ```
 * 锁法                                     rename      rm 墓碑
 * cwd 锁在 <dir> 本身                       EBUSY 失败   ——（没走到这步）
 * cwd 锁在 <dir>/userdata                   EPERM 失败   ——
 * 独占句柄（FileShare.None）锁里面的文件    EPERM 失败   ——
 * ```
 *
 * 也就是说：**真实的三类占用都会让 rename 先失败**，那时一个字节都没动。
 * 这正好是我们要的语义 —— 「删不掉」必须是「什么都没变」，不能是「删了一半」。
 *
 * 只有 rename 成功之后才去 `rmSync` 墓碑；那一步万一失败，就**把墓碑改回原名**（尽力），
 * 数据仍然完整可恢复。改不回来（极罕见：原名被重新占住）才报 `data_detached`，
 * 由调用方把库里那条记录也删掉 —— 不许还挂着「可恢复」。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROFILES_DIR } from '../config.js';
import { userDataDirFor } from './manager.js';

/** 墓碑后缀。带随机串是为了同一环境连续两次 purge 不会撞名 */
export const TOMB_MARK = '.purge-';

/** `<profiles>/<no>_<id8>` → `<profiles>/<no>_<id8>.purge-a1b2c3` */
export function tombstoneFor(dir, rand = () => crypto.randomBytes(3).toString('hex')) {
  return `${dir}${TOMB_MARK}${rand()}`;
}

/**
 * 清掉这个环境**上次遗留**的墓碑（尽力，删不掉不算失败）。
 * 为什么要它：`data_detached` 那一支会留下一个删不掉的墓碑目录，
 * 用户下次再 purge 同一条时不能被它卡住。
 */
export function sweepTombstones(dir, { fsx = fs } = {}) {
  const parent = path.dirname(dir);
  const prefix = `${path.basename(dir)}${TOMB_MARK}`;
  const swept = [];
  let names = [];
  try { names = fsx.readdirSync(parent); } catch { return swept; }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const abs = path.join(parent, name);
    try {
      fsx.rmSync(abs, { recursive: true, force: true });
      if (!fsx.existsSync(abs)) swept.push(name);
    } catch { /* 还占着就留着，下次再说 */ }
  }
  return swept;
}

/**
 * 删掉一个环境的 user-data 目录。
 *
 * @param {object|string} profile 环境（要 `id` 与 `profile_no`，用来算目录）
 * @param {{fsx?: object, rand?: () => string}} [opts] `fsx` 只给判据用（造双故障那一支），
 *        产品里永远走真 fs。
 * @returns {{
 *   ok: boolean,
 *   removed?: boolean,
 *   absent?: boolean,
 *   reason?: string,
 *   intact?: boolean,
 *   data_detached?: boolean,
 *   error_code?: string|null,
 *   error_message?: string,
 *   restore_error?: string,
 *   detached_path?: string,
 * }}
 *   - `ok:true, removed:true`  → 目录真的删掉了
 *   - `ok:true, removed:false, absent:true` → 本来就没有这个目录（记录该删，但没占磁盘）
 *   - `ok:false, intact:true`  → **一个字节都没动**，可以放心报「没删掉、还能恢复」
 *   - `ok:false, data_detached:true` → 名字改不回来了，数据已不在原路径，**不能恢复**
 */
export function purgeProfileData(profile, { fsx = fs, rand } = {}) {
  const dir = path.dirname(userDataDirFor(profile));
  // 防越界：只允许动 PROFILES_DIR 的直接子目录（userDataDirFor 算出来的就是这种）
  if (path.resolve(path.dirname(dir)) !== path.resolve(PROFILES_DIR)) {
    return { ok: false, intact: true, reason: 'outside_profiles_dir' };
  }

  // 上次的墓碑先清（删不掉不影响这次）
  sweepTombstones(dir, { fsx });

  if (!fsx.existsSync(dir)) return { ok: true, removed: false, absent: true };

  const tomb = tombstoneFor(dir, rand);

  // 第 1 步：改名。失败 = 什么都没动。
  try {
    fsx.renameSync(dir, tomb);
  } catch (e) {
    return {
      ok: false,
      intact: true,
      reason: 'userdata_remove_failed',
      error_code: e.code || null,
      error_message: e.message,
    };
  }

  // 第 2 步：删墓碑。
  try {
    fsx.rmSync(tomb, { recursive: true, force: true });
    return { ok: true, removed: true };
  } catch (e) {
    // 第 3 步：删不掉就改回来（尽力）。改回来就还是「什么都没变」。
    try {
      fsx.renameSync(tomb, dir);
      return {
        ok: false,
        intact: true,
        reason: 'userdata_remove_failed',
        error_code: e.code || null,
        error_message: e.message,
      };
    } catch (e2) {
      return {
        ok: false,
        data_detached: true,
        reason: 'userdata_remove_failed_after_rename',
        error_code: e.code || null,
        error_message: e.message,
        restore_error: e2.message,
        detached_path: path.relative(PROFILES_DIR, tomb),
      };
    }
  }
}
