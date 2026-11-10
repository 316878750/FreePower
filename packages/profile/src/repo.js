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

export function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec(DDL);
  return db;
}

const now = () => new Date().toISOString();

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
  // 派生：指纹种子
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

export function getProfile(db, id) {
  const row = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
  if (!row) return null;
  const rec = fromRow(row);
  rec.fingerprint_config_raw = safeParse(row.fingerprint_config, {});
  return rec;
}

export function listProfiles(db, filter = {}) {
  const where = [];
  const params = [];
  if (filter.group_id) { where.push('group_id = ?'); params.push(filter.group_id); }
  if (filter.status) { where.push('status = ?'); params.push(filter.status); }
  const sql = `SELECT * FROM profiles ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY profile_no`;
  return db.prepare(sql).all(...params).map(fromRow);
}

export function deleteProfile(db, id) {
  const r = db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  return r.changes > 0;
}

export function setStatus(db, id, status) {
  db.prepare('UPDATE profiles SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
}
