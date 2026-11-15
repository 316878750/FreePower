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
 * 4. **正在恢复的那份快照不许被自己的「恢复前」快照挤掉**。恢复第 1 步会拍一份
 *    `before_restore`，而拍照会触发轮转（超 5 份真删目录）。池子满 5 份时恢复**最旧那份**，
 *    新拍的第 6 份本来会把最旧那份删掉 —— 删的正是正在恢复的那份，于是 userdata 找不到、
 *    静默跳过换目录，接口却回 `restored:true` + `verified:true`（**半恢复报成功**）。
 *    所以 `takeSnapshot` 带 `protect: [目标 snap_id]`，轮转跳过它、改删更旧的一份。
 * 5. **快照声称有 userdata 就必须真有**。`meta.includes.userdata === true` 而盘上那份
 *    `userdata/` 不存在或为空 → **硬失败**（`snapshot_userdata_missing`），且在动任何东西之前
 *    就失败。静默跳过换目录 = 「环境在、登录态没了」还报成功，是这一版最坏的失败形态。
 * 6. **`verified` 要同时覆盖记录和数据**：只核对 `profiles` 的业务列，等于「数据层一点没覆盖」，
 *    半恢复照样绿（0.4.7 ② 修之前的真实缺陷）。数据没恢复成功时 `verified` 不许是 true。
 *
 * ## 在运行时拍摄（如实标记，不禁止）
 *
 * 允许在环境跑着的时候拍快照（用户「边跑边备份」是合理需求），但那时拷的是**活着的 userdata**：
 * `Cookies` 是 WAL 模式的 SQLite，拷到一半可能是不一致的副本。所以 `meta.taken_while_running`
 * 如实记下来，列表上带可见标记、恢复时再提示一次 —— **不许让人以为这份跟别的一样可靠**。
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
 * @param {{reason?:string, now?:Date, fsx?:object, keep?:number,
 *          protect?:string[], running?:boolean}} [opts]
 *   - `protect`：这次轮转**不许删**的 snap_id（恢复时用来保护正在恢复的那份）
 *   - `running`：拍的时候环境是否在跑；不给就看 `profile.status`（如实记进 meta，见文件头）
 * @returns {{
 *   ok: boolean, reason?: string,
 *   snapshot?: object,          // meta
 *   evicted?: object[],         // 被挤掉的（含 removed:true/false）
 *   userdata?: {included:boolean, files:number, bytes:number, excluded:string[]},
 * }}
 *   - `ok:true` 一定能在盘上找到这份快照
 *   - 拍不下来就 `ok:false` + `reason`（调用方必须如实报，不许静默成功）
 */
export function takeSnapshot(profile, {
  reason = 'manual', now = new Date(), fsx = fs, keep = KEEP_SNAPSHOTS, protect = [], running,
} = {}) {
  const profileId = String(profile.id || profile.profile_id || '');
  if (!profileId) return { ok: false, reason: 'no_profile_id' };
  const why = SNAPSHOT_REASONS.includes(reason) ? reason : 'manual';
  // 在跑的时候拍：拷的是活着的 userdata，可能不一致。如实记下来，不假装它跟别的一样可靠。
  const wasRunning = running === undefined ? String(profile.status || '') === 'running' : running === true;

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
    // 拍摄时环境在跑：拷的是活着的 userdata，Cookies 是 WAL 模式的 SQLite，可能不一致。
    // 界面与恢复时都要提示，不许让人以为这份跟别的一样可靠。
    taken_while_running: wasRunning,
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
  //    被 `protect` 点名的（恢复时正在恢复的那份）跳过，改删更旧的一份 ——
  //    否则「恢复最旧那份」会先被自己的「恢复前」快照挤掉，导致半恢复还报成功。
  const evicted = rotate(profileId, { keep, fsx, protect });
  return { ok: true, snapshot: meta, evicted, userdata };
}

/**
 * 挤掉最旧的，直到只剩 `keep` 个。
 *
 * `protect`：这次**不许删**的 snap_id 列表。被保护的跳过（它仍占一个名额），所以会往下再删一份
 * 更旧的 —— 总份数照样回到 `keep`，只是死的不是被保护那份。全都受保护时宁可超上限也不删。
 *
 * 为什么「挤不掉也要保留新快照」：删不掉通常是文件被占用（杀毒、资源管理器缩略图），
 * 那一刻拒绝备份等于把用户刚做的操作变成「没有兜底」。宁可暂时多占一份，也要把备份留下，
 * 并把 `removed:false` 如实报给界面 —— 界面会说「有 N 份没删掉，暂时超过 5 份」。
 */
export function rotate(profileId, { keep = KEEP_SNAPSHOTS, fsx = fs, protect = [] } = {}) {
  const protectedSet = new Set((protect || []).map((x) => String(x)));
  const all = listSnapshots(profileId, { fsx }); // 新的在前
  const evicted = [];
  let remaining = all.length;
  for (let i = all.length - 1; i >= 0 && remaining > keep; i -= 1) {
    const s = all[i];
    if (protectedSet.has(String(s.snap_id))) continue; // 跳过但**不**减 remaining：要再多删一份更旧的
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
    if (removed) remaining -= 1;
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
 *   evicted?: object[],           // 这次「恢复前」拍照挤掉的快照
 *   userdata?: {replaced:boolean, mode:'replaced'|'not_in_snapshot', files:number, bytes:number},
 *   record?: {written:number, kept_current:string[]},
 *   verified?: boolean,           // 记录**和**数据都核对通过才是 true
 *   verified_record?: boolean, verified_data?: boolean, diff?: object,
 * }}
 *   - `snapshot_userdata_missing`：meta 说包含数据但盘上没有 → 硬失败，**在动任何东西之前**
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

  /*
   * 0) **先验数据层，再动任何东西**。
   *
   * `meta.includes.userdata === true` 但盘上那份 `userdata/` 不见了或空了 → 硬失败。
   * 以前这里是 `if (fsx.existsSync(snapUserdata))` 一句静默跳过：记录照常写回、接口回
   * `restored:true` + `verified:true`，用户拿到「环境在、登录态没了」。
   * 在跑的环境被自己的「恢复前」快照挤掉时就是这个形态（见文件头第 4 条）。
   *
   * 放在拍 `before_restore` **之前**：这一步失败时一个字节都没动（连快照池子都没变），
   * 所以「记录没变」是天然成立的，不靠回滚。
   */
  const claimsUserdata = snap.meta && snap.meta.includes && snap.meta.includes.userdata === true;
  const snapUserdata = path.join(snapshotDirFor(profileId, snapId), 'userdata');
  if (claimsUserdata) {
    let snapFiles = 0;
    try { snapFiles = dirBytes(snapUserdata, { fsx }).files; } catch { snapFiles = 0; }
    if (!fsx.existsSync(snapUserdata) || snapFiles === 0) {
      return {
        ok: false,
        reason: 'snapshot_userdata_missing',
        error_message: `这份快照的 meta 说包含数据目录，但盘上的 userdata/ ${fsx.existsSync(snapUserdata) ? '是空的' : '不存在'}`
          + '（可能被挤掉、被手工删掉，或拷贝时中断）。恢复会得到一个「环境在、登录态没了」的结果，所以拒绝。',
      };
    }
  }

  // 1) 恢复前先给**当前状态**留一份：恢复错了还能回到「恢复之前」
  //    `protect` 必须带上正在恢复的那份 —— 池子满时这一步会触发轮转，不加保护就会把
  //    正在恢复的快照自己删掉（先拍后拷，删了就没 userdata 可拷了）。
  let before = null;
  let evicted = [];
  if (!skipBefore) {
    const r = takeSnapshot(profile, { reason: 'before_restore', now, fsx, protect: [snapId] });
    if (!r.ok) {
      // 留不下「恢复前」的快照就**不许恢复** —— 否则恢复本身成了新的丢数据入口
      return { ok: false, reason: 'before_snapshot_failed', error_message: r.reason || '' };
    }
    before = r.snapshot;
    // 这次拍照挤掉了谁，要如实往上报：「你刚恢复了最旧那份，代价是另一份被挤掉了」
    evicted = r.evicted || [];
  }

  // 2) 换 userdata：改名 → 拷 → 删墓碑（拷贝失败就改回来，一个字节都没变）
  //    `userdata.mode` 把「真的换了」和「快照里本来就没数据」分开说 —— 两者都 `replaced:false`
  //    会让人分不清是没恢复还是没得恢复。
  const liveDir = userDataDirFor(profile);
  let userdata = { replaced: false, mode: 'not_in_snapshot', files: 0, bytes: 0 };
  if (claimsUserdata) {
    // 第二道：第 0 步验过之后到这一步之间，目标快照仍可能消失（别的进程清理、手工删）。
    // 那时必须报「快照数据不见了」，不是含糊的「拷贝失败」—— 这两种失败对用户的意义完全不同。
    if (!fsx.existsSync(snapUserdata)) {
      return {
        ok: false,
        reason: 'snapshot_userdata_missing',
        error_message: '快照里的 userdata/ 在恢复过程中消失了（可能被轮转挤掉或被手工删除）。记录没有写回。',
        before_snapshot: before,
      };
    }
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
      userdata = { replaced: true, mode: 'replaced', files: size.files, bytes: size.bytes };
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
  let verifiedRecord = true;
  const checkCols = Object.keys(snap.record).filter((c) => !KEEP_CURRENT_COLS.has(c) && recordResult.written_cols.includes(c) === true);
  const expectedCols = Object.keys(snap.record).filter((c) => !KEEP_CURRENT_COLS.has(c) && profileColumns().includes(c));
  for (const col of expectedCols) {
    const want = snap.record[col];
    const got = after[col];
    if (JSON.stringify(want ?? null) !== JSON.stringify(got ?? null)) {
      verifiedRecord = false;
      diff[col] = { want: String(want ?? '').slice(0, 40), got: String(got ?? '').slice(0, 40), written: checkCols.includes(col) };
    }
  }

  /*
   * 数据层也要进 `verified`。
   *
   * 以前 `verified` 只核对 `profiles` 的业务列，**完全不看 userdata** —— 于是「记录回到快照、
   * 登录态还是恢复前的样子」也会是 `verified:true` + `diff:{}`。那正是 B 红1 抓到的形态。
   * 规则：快照说包含数据，就必须真换上了；说没包含，才允许 `replaced:false`。
   * （正常路径上第 0 步已经硬失败，这里是第二道，防以后有人把第 0 步的检查挪走。）
   */
  const verifiedData = claimsUserdata ? userdata.replaced === true : true;
  if (!verifiedData) diff.__userdata = { want: 'replaced', got: userdata.mode || 'not_replaced' };

  return {
    ok: true,
    snapshot: snap.meta,
    before_snapshot: before,
    // 这次恢复前拍照挤掉的快照：用户得知道「刚恢复了最旧那份，代价是另一份被挤掉了」
    evicted,
    userdata,
    record: recordResult,
    verified: verifiedRecord && verifiedData,
    verified_record: verifiedRecord,
    verified_data: verifiedData,
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
 * 彻底删除环境时，把这个环境的快照目录整份清掉（**只有彻底删除才调**）。
 *
 * 为什么必须清：环境记录从库里删掉之后，`restoreSnapshot` 需要 `profile` 记录，
 * 没有任何入口能恢复这些快照 —— 它们**看着像备份、实际永远用不上**，
 * 比没有备份更坏（让人误以为有兜底）。而量不小：一个环境 5 份，删 20 个环境就是几百 MB
 * 到 GB 级，界面上一个字节都看不到。
 *
 * 删盘走 **先改名再删** 的两阶段（与 `purge-data.js` 同一条纪律）：直接 `rmSync(recursive)`
 * 是「先删内容、再删目录」，目录被占住时会内容删光了才报错 —— 报的和做的正好相反。
 * 改名失败 = 一个字节都没动，如实报 `kept`。
 *
 * **删不掉不许让整个删除失败**：调用方（彻底删除路由）照样删环境记录，把 `kept` 如实报给用户。
 *
 * @returns {{ok:boolean, existed:boolean, removed:number, kept:number,
 *            bytes:number, freed_bytes:number, detached_path?:string,
 *            path:string, reason?:string, error_message?:string}}
 *   - `removed`：真正清掉的份数（改名成功就算清掉 —— 原路径上已经没有了）
 *   - `kept`：没清掉的份数（改名失败时是全部）
 *   - `detached_path`：改名成功但墓碑删不掉时的路径（磁盘没腾出来，但环境侧已经够不着了）
 */
export function purgeProfileSnapshots(profileId, { fsx = fs } = {}) {
  const root = profileSnapshotsDir(profileId);
  if (!fsx.existsSync(root)) {
    return { ok: true, existed: false, removed: 0, kept: 0, bytes: 0, freed_bytes: 0, path: root };
  }
  const list = listSnapshots(profileId, { fsx });
  const bytes = dirBytes(root, { fsx }).bytes;
  const count = list.length;

  const tomb = `${root}.fp-purge-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fsx.renameSync(root, tomb);
  } catch (e) {
    return {
      ok: false,
      existed: true,
      removed: 0,
      kept: count,
      bytes,
      freed_bytes: 0,
      path: root,
      reason: 'rename_failed',
      error_message: e.message,
    };
  }

  let detachedPath;
  try {
    fsx.rmSync(tomb, { recursive: true, force: true });
  } catch {
    detachedPath = tomb;
  }
  if (!detachedPath && fsx.existsSync(tomb)) detachedPath = tomb;

  return {
    ok: true,
    existed: true,
    removed: count,
    kept: 0,
    bytes,
    freed_bytes: detachedPath ? 0 : bytes,
    detached_path: detachedPath,
    path: root,
  };
}

/** 这个环境的快照有多少份、占多少字节（**只读**，彻底删除前给确认框看） */
export function snapshotFootprint(profileId, { fsx = fs } = {}) {
  const root = profileSnapshotsDir(profileId);
  let list = [];
  try { list = listSnapshots(profileId, { fsx }); } catch { list = []; }
  let bytes = 0;
  try { bytes = dirBytes(root, { fsx }).bytes; } catch { bytes = 0; }
  return { count: list.length, bytes };
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
