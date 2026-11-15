/**
 * 合并 Cookie 的可撤销记录（0.4.7 ①）。
 *
 * 为什么要有它：合并（并集）虽然「同名以现有为准、不覆盖登录态」，但它会**往环境里加 cookie**，
 * 而且用户是对着一批环境批量操作的 —— 选错环境、拿错文件、点错确认，一次就污染几十个环境，
 * 之前**没有任何回退路径**（`21-` §5 里 `undoMerge` 是零实现）。
 *
 * 所以每次**真写**的合并，在写之前先把「这个环境合并前的 cookie 全集」落一份盘上的记录。
 * 撤销时把这份记录原样写回去、把多出来的删掉，再逐条比对（`compareCookieSets`）。
 *
 * 四条设计选择，都写清为什么：
 *
 *   1. **只保留最近一次**（一个环境一个文件，新的覆盖旧的）。不做无限历史：历史越久，
 *      「撤销」到底是回到哪一刻就越说不清，而用户真正需要的是「我刚才那一下合错了，退回去」。
 *      界面上也明说这一点。
 *
 *   2. **落盘，不是记日志**。进程崩了、重启了，撤销还得能用 —— 日志读不回来。
 *
 *   3. **快照写不进去就不许合并**（fail-closed）。写不了回滚记录的合并，就是一次不可回退的
 *      破坏性操作；宁可这一条合并失败并说明原因，也不做「先合了再说」。
 *
 *   4. **原子写**（`<id>.json.fp-tmp` → rename）。崩在写一半，盘上要么是上一份完整快照、
 *      要么是这一份完整的，不会出现半截 JSON 把撤销弄坏。
 *
 * 安全边界：这个文件里**有 cookie 的 value**（登录凭据）。它落在数据目录下，
 * 与 `freepower.db` 里 `cookie` 字段的信任边界一致（同一台机器、同一个用户）。
 * 撤销成功后**立刻删掉**这份记录（能撤销的窗口越短越好），接口与日志都**不打印 value**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

/** `<数据根>/cookie-undo/`：一个环境一个文件，文件名就是 profile_id */
export const COOKIE_UNDO_DIR = path.join(DATA_DIR, 'cookie-undo');

export function undoFileFor(profileId) {
  return path.join(COOKIE_UNDO_DIR, `${String(profileId)}.json`);
}

/**
 * 合并前落一份快照。
 *
 * @param {string} profileId
 * @param {object[]} cookies 合并**前**这个环境的 cookie 全集（`readCookies` 的返回）
 * @param {{merge_id?:string, incoming_total?:number, now?:Date}} [meta]
 * @returns {{path:string, total:number, taken_at:string}}
 * @throws 写不进去就抛（调用方必须据此**放弃这次合并**，见文件头第 3 条）
 */
export function saveMergeSnapshot(profileId, cookies = [], { merge_id: mergeId = '', incoming_total: incomingTotal = 0, now = new Date() } = {}) {
  fs.mkdirSync(COOKIE_UNDO_DIR, { recursive: true });
  const file = undoFileFor(profileId);
  const payload = {
    version: 1,
    profile_id: String(profileId),
    kind: 'cookie-merge',
    taken_at: now.toISOString(),
    merge_id: String(mergeId || ''),
    incoming_total: Number(incomingTotal) || 0,
    total: cookies.length,
    cookies,
  };
  const tmp = `${file}.fp-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // rename 失败 = 快照没写成（原子性：失败就是没发生）。临时文件要清掉，
    // 否则目录里永远躺一个 `.fp-tmp`，下次排查看到的是垃圾不是原因。
    try { fs.unlinkSync(tmp); } catch { /* 可能压根没写成 */ }
    throw e;
  }
  return { path: file, total: cookies.length, taken_at: payload.taken_at };
}

/**
 * 读回最近一次合并的快照。
 * @returns {object|null} 没有记录 → null；有记录但文件坏了 → 抛（调用方报 `snapshot_corrupt`，不许当成「没有」）
 */
export function readMergeSnapshot(profileId) {
  const file = undoFileFor(profileId);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`撤销记录已损坏（${path.basename(file)}）：${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.cookies)) {
    throw new Error(`撤销记录格式不对（${path.basename(file)}）：缺少 cookies 数组`);
  }
  return parsed;
}

/** 撤销成功后清掉记录（返回是否真的删掉了文件） */
export function clearMergeSnapshot(profileId) {
  const file = undoFileFor(profileId);
  try {
    fs.unlinkSync(file);
    return true;
  } catch (e) {
    if (e?.code === 'ENOENT') return false;
    throw e;
  }
}

/** 有没有可撤销的合并（给界面显示用，不读 cookie 内容） */
export function hasMergeSnapshot(profileId) {
  try {
    return fs.existsSync(undoFileFor(profileId));
  } catch {
    return false;
  }
}
