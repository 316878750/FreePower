/**
 * 本地备份快照（0.4.7 ②）—— **丢数据的最后一道防线**。
 *
 * ## 它解决什么
 *
 * 这个产品里有一堆不可逆动作：彻底删除、按天数删缓存、`clear_cache_after_closing`、
 * 合并/还原 Cookie、换绑代理把登录态搞没……① 只给了「最近一次合并」的撤销，
 * 剩下的没有任何回退路径。② 是那个兜底：**把环境当前的样子整个存一份，随时能整份恢复**。
 *
 * ## 一份快照里到底有什么（界面和文档都必须说清，不许让用户以为「备份了」其实只备份了库）
 *
 * ```
 * <数据根>/snapshots/<profile_id>/<snap_id>/
 *   meta.json      —— 这份快照的元信息（时间、原因、包含/不含、大小、文件数）
 *   record.json    —— 环境记录：profiles 表这一行的**全部列**（含 cookie 字段、代理、指纹、UA…）
 *   userdata/      —— 内核数据目录的一份拷贝（**缓存目录除外**，见下）
 * ```
 *
 * **不包含**：
 *   - 可再生的缓存目录（`Cache` / `Code Cache` / `GPUCache` / `ShaderCache` / `Service Worker` /
 *     `Crashpad` / `BrowserMetrics` / `component_crx_cache` …）。理由：它们是浏览器能自己重建的东西，
 *     存进去只会让一份快照从几 MB 涨到几百 MB，把「保留 5 个」变成占几十 GB 的摆设。
 *     排除名单是**固定常量**，不是猜的；判据里有一条断言「Cache 目录不进快照、Cookies 进了」。
 *   - **内核本体**（几百 MB 的 Chrome）。内核按版本单独下载，恢复时不涉及。
 *   - 其他环境的数据（一份快照只属于一个环境）。
 *
 * ## 三条设计纪律
 *
 * 1. **保留 5 个**（每个环境各 5 个）。第 6 个进来时最旧的被挤掉，**并且文件要真的从磁盘消失**
 *    （不是只从索引里删掉）。挤不掉（被占用）时**照样保留新快照**、但如实报 `evict_failed` ——
 *    「因为删不掉旧的就不给备份」比「暂时多占一份」危险得多。
 * 2. **恢复是破坏性的**，所以恢复前**自动给当前状态留一份快照**（`reason: 'before_restore'`）。
 *    否则恢复本身就成了新的丢数据入口 —— 恢复到错的快照，连「刚才是什么样」都没了。
 * 3. **恢复要先换目录、再写库**，换目录走「改名 → 拷贝 → 删墓碑」：
 *    拷贝失败就把原名改回来，一个字节都没变（与 `purge-data.js` 同一条纪律）。
 *
 * ## 恢复哪些列、不恢复哪些列（刻意的）
 *
 * 恢复**全部业务列**（含 cookie / 代理 / 指纹 / UA / 备注 / 分组），但下面这几列**保留现状**：
 *   - `id` / `profile_no`：环境身份，恢复出来必须还是同一个环境；
 *   - `created_at`：创建时间不是可恢复的状态；
 *   - `updated_at`：改成「现在」（这次恢复就是一次更新）；
 *   - `status`：恢复完一定是 `idle`（快照里的 `running` 是当时的运行态，不是数据）；
 *   - `deleted_at` / `archived_at`：**不恢复**。否则「恢复一份归档时拍的快照」会让环境
 *     突然从主列表消失 —— 用户会以为环境被弄丢了。要归档/恢复归档用专门的入口。
 *
 * ## 安全边界
 *
 * `record.json` 与 `userdata/Cookies` 里**都有登录凭据**。它落在数据目录下，
 * 与 `freepower.db` 的信任边界一致（同一台机器、同一个用户）。接口与日志**不打印 cookie 值**。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../config.js';
import { getDb } from './db.js';
import { userDataDirFor } from '../runtime/manager.js';

/** `<数据根>/snapshots/<profile_id>/<snap_id>/` */
export const SNAPSHOTS_DIR = path.join(DATA_DIR, 'snapshots');

/** 每个环境保留几份（含恢复前自动留的那份） */
export const KEEP_SNAPSHOTS = 5;

/**
 * **不进快照**的目录名（任意深度、大小写不敏感）：全是浏览器能自己重建的缓存。
 * 名单是固定常量 —— 不读环境变量、不按大小猜，免得「同一份快照在不同机器上内容不一样」。
 */
export const CACHE_DIR_NAMES = Object.freeze([
  'cache',
  'code cache',
  'gpucache',
  'dawncache',
  'dawngraphitecache',
  'dawnwebgpucache',
  'shadercache',
  'grshadercache',
  'graphitedawncache',
  'service worker',
  'blob_storage',
  'crashpad',
  'browsermetrics',
  'component_crx_cache',
  'extensions_crx_cache',
]);

const CACHE_SET = new Set(CACHE_DIR_NAMES);

/** 快照里那些「保留现状」的列（见文件头最后一节） */
const KEEP_CURRENT_COLS = new Set(['id', 'profile_no', 'created_at', 'updated_at', 'status', 'deleted_at', 'archived_at']);

/** 允许的 reason：写进 meta，界面上要能说清「这份是谁拍的」 */
export const SNAPSHOT_REASONS = Object.freeze(['manual', 'before_restore', 'on_close']);

const REASON_LABEL = {
  manual: '手动创建',
  before_restore: '恢复前自动留存',
  on_close: '关闭环境时自动',
};

export function reasonLabel(reason) {
  return REASON_LABEL[reason] || reason || '未知';
}

/** `<数据根>/snapshots/<profile_id>/` */
export function profileSnapshotsDir(profileId) {
  return path.join(SNAPSHOTS_DIR, String(profileId));
}

export function snapshotDirFor(profileId, snapId) {
  return path.join(profileSnapshotsDir(profileId), String(snapId));
}

/** 新的 snap_id：`20261115T175812123Z-manual`（字典序就是时间序，排序不用再读 meta） */
function newSnapId(reason, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('.', '');
  const rand = crypto.randomBytes(2).toString('hex');
  return `${stamp}-${reason}-${rand}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 原子写：`<file>.fp-tmp` → rename（崩在写一半不会留下半截 JSON） */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.fp-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 目录里所有文件的总字节数（读不到就跳过，不因此整条失败） */
function dirBytes(dir, { fsx = fs } = {}) {
  let total = 0;
  let files = 0;
  const walk = (d) => {
    let entries;
    try { entries = fsx.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(abs);
        else if (e.isFile()) { total += fsx.statSync(abs).size; files += 1; }
      } catch { /* 单个文件读不到就跳过 */ }
    }
  };
  walk(dir);
  return { bytes: total, files };
}

/** 读 profiles 表的真实列名（不硬编码：schema 加了列，快照自动跟上） */
function profileColumns() {
  return getDb().prepare('PRAGMA table_info(profiles)').all().map((r) => r.name);
}

/**
 * 拍一份快照。
 *
 * @param {object} profile 环境记录（要 `id` / `profile_no`）
 * @param {{reason?:string, now?:Date, fsx?:object, keep?:number}} [opts]
 * @returns {{
 *   ok: boolean, reason?: string,
 *   snapshot?: object,          // meta
 *   evicted?: object[],         // 被挤掉的（含 removed:true/false）
 *   userdata?: {included:boolean, files:number, bytes:number, excluded:string[]},
 * }}
 *   - `ok:true` 一定能在盘上找到这份快照
 *   - 拍不下来就 `ok:false` + `reason`（调用方必须如实报，不许静默成功）
 */
export function takeSnapshot(profile, { reason = 'manual', now = new Date(), fsx = fs, keep = KEEP_SNAPSHOTS } = {}) {
  const profileId = String(profile.id || profile.profile_id || '');
  if (!profileId) return { ok: false, reason: 'no_profile_id' };
  const why = SNAPSHOT_REASONS.includes(reason) ? reason : 'manual';

  const snapId = newSnapId(why, now);
  const dir = snapshotDirFor(profileId, snapId);
  try {
    fsx.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, reason: 'mkdir_failed', error_message: e.message };
  }

  // 1) 记录：profiles 表这一行的全部列（含 cookie / 代理 / 指纹）
  let record;
  try {
    const row = getDb().prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
    if (!row) {
      fsx.rmSync(dir, { recursive: true, force: true });
      return { ok: false, reason: 'profile_not_found' };
    }
    record = row;
    writeJsonAtomic(path.join(dir, 'record.json'), { version: 1, columns: Object.keys(row), record: row });
  } catch (e) {
    try { fsx.rmSync(dir, { recursive: true, force: true }); } catch { /* 留着也只是垃圾 */ }
    return { ok: false, reason: 'record_write_failed', error_message: e.message };
  }

  // 2) userdata：拷一份（缓存目录除外）
  const srcDir = userDataDirFor(profile);
  const dstDir = path.join(dir, 'userdata');
  let userdata = { included: false, files: 0, bytes: 0, excluded: [...CACHE_DIR_NAMES] };
  if (fsx.existsSync(srcDir)) {
    try {
      fsx.cpSync(srcDir, dstDir, {
        recursive: true,
        filter: (src) => !CACHE_SET.has(path.basename(src).toLowerCase()),
      });
      const size = dirBytes(dstDir, { fsx });
      userdata = { included: true, files: size.files, bytes: size.bytes, excluded: [...CACHE_DIR_NAMES] };
    } catch (e) {
      // userdata 拷不下来：**整份快照作废**。只存了记录的快照最容易被误解成「备份好了」，
      // 而它恢复出来是个全新浏览器 —— 那比没有备份更糟。
      try { fsx.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      return { ok: false, reason: 'userdata_copy_failed', error_message: e.message };
    }
  }

  // 3) meta（最后写：有 meta 才算一份完整快照，读的时候只认有 meta 的目录）
  const meta = {
    version: 1,
    snap_id: snapId,
    profile_id: profileId,
    profile_no: profile.profile_no ?? record.profile_no ?? null,
    name: record.name ?? '',
    taken_at: now.toISOString(),
    reason: why,
    reason_label: reasonLabel(why),
    includes: {
      record: true,
      record_columns: Object.keys(record).length,
      userdata: userdata.included,
      userdata_files: userdata.files,
      userdata_bytes: userdata.bytes,
      // 显式写出来，界面上要看得见「哪些没备份」
      excluded_cache_dirs: [...CACHE_DIR_NAMES],
      kernel: false,
    },
  };
  try {
    writeJsonAtomic(path.join(dir, 'meta.json'), meta);
  } catch (e) {
    try { fsx.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, reason: 'meta_write_failed', error_message: e.message };
  }

  // 4) 轮转：只留最近 keep 个，多出来的**真删目录**
  const evicted = rotate(profileId, { keep, fsx });
  return { ok: true, snapshot: meta, evicted, userdata };
}

/**
 * 挤掉最旧的，直到只剩 `keep` 个。
 *
 * 为什么「挤不掉也要保留新快照」：删不掉通常是文件被占用（杀毒、资源管理器缩略图），
 * 那一刻拒绝备份等于把用户刚做的操作变成「没有兜底」。宁可暂时多占一份，也要把备份留下，
 * 并把 `removed:false` 如实报给界面 —— 界面会说「有 N 份没删掉，暂时超过 5 份」。
 */
export function rotate(profileId, { keep = KEEP_SNAPSHOTS, fsx = fs } = {}) {
  const all = listSnapshots(profileId, { fsx }); // 新的在前
  const evicted = [];
  for (const s of all.slice(keep)) {
    const dir = snapshotDirFor(profileId, s.snap_id);
    let removed = false;
    let error = null;
    try {
      fsx.rmSync(dir, { recursive: true, force: true });
      removed = !fsx.existsSync(dir);
      if (!removed) error = '目录还在（删不掉）';
    } catch (e) {
      error = e.message;
    }
    evicted.push({ snap_id: s.snap_id, taken_at: s.taken_at, removed, error });
  }
  return evicted;
}

/**
 * 这个环境的快照列表（新的在前）。
 *
 * 只认**有 `meta.json` 的目录**：写到一半崩掉的残骸不列出来 —— 它恢复不了，
 * 列出来只会让人点「恢复」然后失败。
 */
export function listSnapshots(profileId, { fsx = fs } = {}) {
  const root = profileSnapshotsDir(profileId);
  let names = [];
  try { names = fsx.readdirSync(root); } catch { return []; }
  const out = [];
  for (const name of names) {
    const meta = path.join(root, name, 'meta.json');
    try {
      if (!fsx.existsSync(meta)) continue;
      const m = readJson(meta);
      out.push({
        ...m,
        dir_exists: fsx.existsSync(path.join(root, name, 'userdata')),
      });
    } catch { /* meta 坏了就不列（它恢复不了） */ }
  }
  out.sort((a, b) => String(b.snap_id).localeCompare(String(a.snap_id)));
  return out;
}

/** 读一份快照（meta + record）。不存在 → 抛，调用方按 reason 报 */
export function readSnapshot(profileId, snapId) {
  const dir = snapshotDirFor(profileId, snapId);
  const metaFile = path.join(dir, 'meta.json');
  const recordFile = path.join(dir, 'record.json');
  if (!fs.existsSync(metaFile) || !fs.existsSync(recordFile)) {
    const e = new Error(`快照不存在或已损坏：${snapId}`);
    e.reason = 'snapshot_not_found';
    throw e;
  }
  let meta;
  let rec;
  try {
    meta = readJson(metaFile);
    rec = readJson(recordFile);
  } catch (e2) {
    const e = new Error(`快照文件损坏：${snapId}（${e2.message}）`);
    e.reason = 'snapshot_corrupt';
    throw e;
  }
  return { meta, record: rec.record || {}, columns: rec.columns || Object.keys(rec.record || {}) };
}

/** 删一份快照（真删目录；删不掉如实报） */
export function deleteSnapshot(profileId, snapId, { fsx = fs } = {}) {
  const dir = snapshotDirFor(profileId, snapId);
  if (!fsx.existsSync(dir)) return { ok: false, reason: 'snapshot_not_found' };
  try {
    fsx.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, reason: 'remove_failed', error_message: e.message };
  }
  if (fsx.existsSync(dir)) return { ok: false, reason: 'remove_failed', error_message: '目录还在' };
  return { ok: true, snap_id: snapId };
}

/** 这个环境所有快照占的磁盘（界面要能说「快照占了 12.3 MB」） */
export function snapshotUsage(profileId, { fsx = fs } = {}) {
  const list = listSnapshots(profileId, { fsx });
  let bytes = 0;
  for (const s of list) bytes += dirBytes(snapshotDirFor(profileId, s.snap_id), { fsx }).bytes;
  return { count: list.length, bytes };
}

/**
 * 从快照恢复（**破坏性**）。
 *
 * 调用方必须先确认：环境**没在跑**（内核占着 userdata，覆盖只会半途失败）。
 * 这里再查一次 `status`，双保险；两道都过了才动盘。
 *
 * @param {object} profile 当前环境记录
 * @param {string} snapId
 * @param {{fsx?:object, now?:Date, skipBefore?:boolean}} [opts] `skipBefore` 只给判据用
 * @returns {{
 *   ok: boolean, reason?: string,
 *   before_snapshot?: object,     // 恢复前自动留的那份
 *   userdata?: {replaced:boolean, files:number, bytes:number},
 *   record?: {written:number, kept_current:string[]},
 *   verified?: boolean, diff?: object,
 * }}
 */
export function restoreSnapshot(profile, snapId, { fsx = fs, now = new Date(), skipBefore = false } = {}) {
  const profileId = String(profile.id || profile.profile_id || '');
  if (!profileId) return { ok: false, reason: 'no_profile_id' };
  if (String(profile.status || '') === 'running') {
    return { ok: false, reason: 'running', error_message: '环境正在运行，先停止再恢复（内核占着数据目录）' };
  }

  let snap;
  try {
    snap = readSnapshot(profileId, snapId);
  } catch (e) {
    return { ok: false, reason: e.reason || 'snapshot_not_found', error_message: e.message };
  }

  // 1) 恢复前先给**当前状态**留一份：恢复错了还能回到「恢复之前」
  let before = null;
  if (!skipBefore) {
    const r = takeSnapshot(profile, { reason: 'before_restore', now, fsx });
    if (!r.ok) {
      // 留不下「恢复前」的快照就**不许恢复** —— 否则恢复本身成了新的丢数据入口
      return { ok: false, reason: 'before_snapshot_failed', error_message: r.reason || '' };
    }
    before = r.snapshot;
  }

  // 2) 换 userdata：改名 → 拷 → 删墓碑（拷贝失败就改回来，一个字节都没变）
  const liveDir = userDataDirFor(profile);
  const snapUserdata = path.join(snapshotDirFor(profileId, snapId), 'userdata');
  let userdata = { replaced: false, files: 0, bytes: 0 };
  if (fsx.existsSync(snapUserdata)) {
    const tomb = `${liveDir}.fp-restore-${crypto.randomBytes(3).toString('hex')}`;
    let renamed = false;
    if (fsx.existsSync(liveDir)) {
      try {
        fsx.renameSync(liveDir, tomb);
        renamed = true;
      } catch (e) {
        return { ok: false, reason: 'userdata_rename_failed', error_message: e.message, before_snapshot: before };
      }
    }
    try {
      fsx.mkdirSync(path.dirname(liveDir), { recursive: true });
      fsx.cpSync(snapUserdata, liveDir, { recursive: true });
      const size = dirBytes(liveDir, { fsx });
      userdata = { replaced: true, files: size.files, bytes: size.bytes };
    } catch (e) {
      // 拷坏了：把原目录改回来（尽力），报「什么都没变」
      try { fsx.rmSync(liveDir, { recursive: true, force: true }); } catch { /* ignore */ }
      if (renamed) {
        try { fsx.renameSync(tomb, liveDir); } catch { /* 改不回来就只能报 detached */ }
      }
      return { ok: false, reason: 'userdata_restore_failed', error_message: e.message, before_snapshot: before };
    }
    if (renamed) {
      try { fsx.rmSync(tomb, { recursive: true, force: true }); } catch { /* 墓碑留着不影响这次恢复 */ }
    }
  }

  // 3) 写回记录（全业务列；见文件头「恢复哪些列、不恢复哪些列」）
  let recordResult;
  try {
    recordResult = writeRecord(profileId, snap.record);
  } catch (e) {
    return { ok: false, reason: 'record_restore_failed', error_message: e.message, before_snapshot: before, userdata };
  }

  // 4) 逐列核对：写进去的和快照里的**逐字段相等**才算真恢复。
  //    核对范围是**快照里的全部业务列**，不是「刚刚写了哪些列」——
  //    否则「某个列悄悄没写」这种事会自己跟自己对上（0.4.7 ① 的教训：空集合对空集合也是绿的）。
  const after = getDb().prepare('SELECT * FROM profiles WHERE id = ?').get(profileId) || {};
  const diff = {};
  let verified = true;
  const checkCols = Object.keys(snap.record).filter((c) => !KEEP_CURRENT_COLS.has(c) && recordResult.written_cols.includes(c) === true);
  const expectedCols = Object.keys(snap.record).filter((c) => !KEEP_CURRENT_COLS.has(c) && profileColumns().includes(c));
  for (const col of expectedCols) {
    const want = snap.record[col];
    const got = after[col];
    if (JSON.stringify(want ?? null) !== JSON.stringify(got ?? null)) {
      verified = false;
      diff[col] = { want: String(want ?? '').slice(0, 40), got: String(got ?? '').slice(0, 40), written: checkCols.includes(col) };
    }
  }

  return {
    ok: true,
    snapshot: snap.meta,
    before_snapshot: before,
    userdata,
    record: recordResult,
    verified,
    diff,
  };
}

/**
 * 把快照里的记录写回库。返回真正写了哪些列（用于逐列核对）。
 * 保留现状的列见 `KEEP_CURRENT_COLS`，**不在 written_cols 里**（它们本来就不该被恢复）。
 */
export function writeRecord(profileId, record = {}) {
  const cols = profileColumns();
  const present = cols.filter((c) => !KEEP_CURRENT_COLS.has(c) && Object.prototype.hasOwnProperty.call(record, c));
  if (!present.length) return { written: 0, written_cols: [], kept_current: [...KEEP_CURRENT_COLS] };
  const sets = present.map((c) => `"${c}" = ?`);
  const args = present.map((c) => (record[c] === undefined ? null : record[c]));
  // status 一律回到 idle：快照里的 running 是当时的运行态，不是数据
  sets.push('"status" = ?');
  args.push('idle');
  sets.push('"updated_at" = ?');
  args.push(new Date().toISOString());
  getDb().prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE id = ?`).run(...args, String(profileId));
  return { written: present.length, written_cols: present, kept_current: [...KEEP_CURRENT_COLS] };
}

/**
 * 界面上要显示的那段「快照里有什么、没什么」——**文案只有这一份**，
 * 文档与界面都引用它，免得两处说法不一样（用户最恨的就是「备份了」其实没备）。
 */
export const SNAPSHOT_SCOPE = Object.freeze({
  included: [
    '环境记录：全部字段（含 Cookie 字段、代理、指纹、UA、备注、分组）',
    '内核数据目录：Cookie / 登录态、LocalStorage、IndexedDB、书签、历史、扩展设置',
  ],
  excluded: [
    '可再生的缓存目录（Cache / Code Cache / GPUCache / ShaderCache / Service Worker 等）',
    '内核本体（几百 MB 的 Chrome，按版本单独下载，恢复时不涉及）',
  ],
});
