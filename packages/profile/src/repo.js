// FreePower · profile 仓储层（node:sqlite，零原生依赖）
// 存储形状：平铺大表 + fingerprint_config 一个 JSON 列。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FIELDS, BY_NAME } from './fields.js';
import { validateProfile } from './validate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DDL = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');

export { DDL };

const FLAT = FIELDS.filter((f) => f.storage !== 'fp');
const FP = FIELDS.filter((f) => f.storage === 'fp');
const EXT_COLS = ['id', 'profile_no', 'fp_seed', 'kernel_version', 'proxy_id', 'status', 'created_at', 'updated_at', 'last_launch_at'];
/** 可能存 number 也可能存 "default" 的枚举列 */
const NUMERIC_ENUM = ['hardware_concurrency', 'device_memory'];

export function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec(DDL);
  return db;
}

const now = () => new Date().toISOString();

/**
 * 进回收站的时刻，格式写死 `YYYY-MM-DD HH:mm:ss`（**Asia/Shanghai**，秒级）。
 * 为什么不用 ISO：对外契约里 `delete_time` 的这种格式要转成**秒级 unix 时间戳字符串**
 * （见 src/store/profiles.js 的 deleteTimeOf），存成它就是契约认得的那个形状；
 * 同一格式的字面量也正好能按字典序排序，回收站按时间倒序不需要再解析。
 */
const deleteStamp = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });

/** 内部记录 → SQL 参数 */
function toRow(rec) {
  const row = {};
  for (const col of EXT_COLS) row[col] = rec[col] ?? null;
  for (const f of FLAT) {
    const v = rec[f.name];
    if (v === undefined) continue;
    if (f.storage === 'csv') row[f.name] = Array.isArray(v) ? v.join(',') : v;
    else if (f.storage === 'json') row[f.name] = typeof v === 'string' ? v : JSON.stringify(v);
    else row[f.name] = v;
  }
  const fp = {};
  for (const f of FP) if (rec[f.name] !== undefined) fp[f.name] = rec[f.name];
  row.fingerprint_config = JSON.stringify(fp);
  return row;
}

/** SQL 行 → 内部记录 */
function fromRow(row) {
  const rec = {};
  for (const col of EXT_COLS) rec[col] = row[col];
  for (const f of FLAT) {
    const v = row[f.name];
    if (v === null || v === undefined) { rec[f.name] = null; continue; }
    if (f.storage === 'csv') rec[f.name] = String(v).split(',').filter(Boolean);
    else if (f.storage === 'json') rec[f.name] = safeParse(v, v);
    else rec[f.name] = v;
  }
  const fp = safeParse(row.fingerprint_config, {});
  for (const f of FP) rec[f.name] = fp[f.name] ?? null;
  // 数值型枚举列（TEXT 亲和）读回来会变成 "12" / "12.0"，统一还原成 number
  for (const k of NUMERIC_ENUM) {
    if (rec[k] !== null && rec[k] !== undefined && rec[k] !== 'default') {
      const n = Number(rec[k]);
      if (Number.isFinite(n)) rec[k] = n;
    }
  }
  return rec;
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

export function deepMerge(base, patch) {
  const out = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch ?? {})) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

export function seedFromId(id) {
  const h = crypto.createHash('sha256').update(String(id)).digest();
  return h.readUInt32BE(0) % 2_000_000;
}

export function createProfile(db, input) {
  const res = validateProfile(input, { mode: 'create' });
  if (!res.ok) return { ok: false, errors: res.errors, warnings: res.warnings };
  const rec = { ...res.value };
  // 扩展列不在字段表里，校验会当未知字段丢掉，这里显式接住
  for (const col of EXT_COLS) if (input[col] !== undefined) rec[col] = input[col];
  rec.id = crypto.randomUUID();
  const next = db.prepare('SELECT COALESCE(MAX(profile_no), 10000) + 1 AS n FROM profiles').get();
  rec.profile_no = next.n;
  rec.fp_seed = rec.fp_seed ?? seedFromId(rec.id);
  rec.status = 'idle';
  rec.created_at = now();
  rec.updated_at = rec.created_at;

  const row = toRow(rec);
  const cols = Object.keys(row);
  const sql = `INSERT INTO profiles (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  db.prepare(sql).run(...cols.map((c) => row[c]));

  return { ok: true, warnings: res.warnings, profile: getProfile(db, rec.id) };
}

/**
 * 按记录直插（迁移/导入用）：不做默认值填充以外的改写，保留原 id / profile_no。
 */
export function insertRecord(db, rec) {
  const row = toRow({ ...rec, created_at: rec.created_at ?? now(), updated_at: rec.updated_at ?? now() });
  const cols = Object.keys(row).filter((c) => row[c] !== undefined);
  const sql = `INSERT INTO profiles (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  db.prepare(sql).run(...cols.map((c) => row[c]));
  return getProfile(db, rec.id);
}

export function updateProfile(db, id, input) {
  const existing = getProfile(db, id);
  if (!existing) return { ok: false, errors: [{ field: 'id', message: 'profile not found' }], warnings: [] };
  const res = validateProfile(input, { mode: 'update', fillDefaults: false });
  if (!res.ok) return { ok: false, errors: res.errors, warnings: res.warnings };

  const merged = { ...existing, ...res.value, id, updated_at: now() };
  // 扩展列（fp_seed / kernel_version / status …）不参与字段表校验，显式合并
  for (const col of EXT_COLS) if (input[col] !== undefined) merged[col] = input[col];
  // fingerprint_config 合并而不是覆盖（webgl_config 只改一半时不能丢字段）
  const fpPatch = {};
  for (const f of FP) if (res.value[f.name] !== undefined) fpPatch[f.name] = res.value[f.name];
  const row = toRow({ ...merged, ...fpPatch });
  // 深合并：只改 webgl_config.unmasked_renderer 时不能把 vendor/webgpu 丢掉
  row.fingerprint_config = JSON.stringify(deepMerge(existing.fingerprint_config_raw ?? {}, fpPatch));

  const cols = Object.keys(row).filter((c) => c !== 'id');
  db.prepare(`UPDATE profiles SET ${cols.map((c) => `"${c}" = ?`).join(',')} WHERE id = ?`).run(
    ...cols.map((c) => row[c]),
    id,
  );
  return { ok: true, warnings: res.warnings, profile: getProfile(db, id) };
}

export function getProfile(db, id, { includeDeleted = false } = {}) {
  const row = db.prepare(`SELECT * FROM profiles WHERE id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`).get(id);
  if (!row) return null;
  const rec = fromRow(row);
  rec.fingerprint_config_raw = safeParse(row.fingerprint_config, {});
  return rec;
}

export function listProfiles(db, filter = {}) {
  const where = [];
  const params = [];
  // 回收站里的环境默认不出现在任何 list 里（要用就显式传 include_deleted）
  if (!filter.include_deleted) where.push('deleted_at IS NULL');
  if (filter.group_id) { where.push('group_id = ?'); params.push(filter.group_id); }
  if (filter.status) { where.push('status = ?'); params.push(filter.status); }
  const sql = `SELECT * FROM profiles ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY profile_no`;
  return db.prepare(sql).all(...params).map(fromRow);
}

/**
 * 软删除：**只置删除标记，不删记录、不删盘**。
 * 回收站里的环境必须还能原样启动，所以 user-data 目录与这条记录都要留着；
 * 「彻底清理」是另一套语义（purge），不在这条路径上。
 * @returns {boolean} 是否真的删了一条（对已在回收站的、或不存在的返回 false）
 */
export function deleteProfile(db, id) {
  const r = db.prepare('UPDATE profiles SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(deleteStamp(), now(), id);
  return r.changes > 0;
}

/**
 * 从回收站恢复：清掉删除标记，id / profile_no 都不动（恢复出来的必须是同一个环境）。
 * `groupId` 是**必填**的上层契约（对手的 restore 要求显式指定分组），所以这里也会改写 group_id；
 * 不传就保持原分组 —— 那是给内部调用（测试/脚本）留的口子，路由层一律传。
 */
export function restoreProfile(db, id, groupId) {
  const sets = ['deleted_at = NULL', 'updated_at = ?'];
  const args = [now()];
  if (groupId !== undefined && groupId !== null && String(groupId) !== '') {
    sets.push('group_id = ?');
    args.push(String(groupId));
  }
  const r = db.prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NOT NULL`).run(...args, id);
  return r.changes > 0;
}

/**
 * 回收站列表：已删除的环境，按删除时间倒序（最近删的排前面 —— 用户找的就是刚删的那个）。
 * 记录上仍带着内部列 `deleted_at`（对外要转成 `delete_time`），
 * **不要**把这种记录直接交给 toApi/present：那会把内部存储状态抖到 54 条路由的响应里。
 */
export function listDeletedProfiles(db, { page = 1, page_size = 50 } = {}) {
  const total = db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE deleted_at IS NOT NULL').get().n;
  const size = Math.min(Math.max(Number(page_size) || 50, 1), 500);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * size;
  const rows = db.prepare('SELECT * FROM profiles WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, profile_no DESC LIMIT ? OFFSET ?')
    .all(size, offset);
  const list = rows.map((row) => ({ ...fromRow(row), deleted_at: row.deleted_at }));
  return { list, total, page: Math.max(Number(page) || 1, 1), page_size: size };
}

export function setStatus(db, id, status) {
  db.prepare('UPDATE profiles SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
}
