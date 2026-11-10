import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, DATA_DIR } from '../config.js';
import { DDL, insertRecord } from '../../packages/profile/src/repo.js';

let db = null;

export function getDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = OFF;');
  migrate(db);
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

/* ------------------------------------------------------------------ */
/* 迁移：老 payload 整包 JSON 模型 → 平铺字段模型（schema 事实源是    */
/* packages/profile）。只迁移不删除，旧数据留在 profiles_legacy_v0。  */
/* ------------------------------------------------------------------ */

function tableColumns(d, name) {
  try {
    return d.prepare(`PRAGMA table_info("${name}")`).all().map((c) => c.name);
  } catch {
    return [];
  }
}

function migrate(d) {
  // 1) 老结构识别：profiles 表里存在 payload 列 → 整表让位
  if (tableColumns(d, 'profiles').includes('payload')) {
    d.exec('DROP TABLE IF EXISTS profiles_legacy_v0;');
    d.exec('ALTER TABLE profiles RENAME TO profiles_legacy_v0;');
  }
  if (tableColumns(d, 'groups').includes('group_id')) {
    d.exec('DROP TABLE IF EXISTS groups_legacy_v0;');
    d.exec('ALTER TABLE groups RENAME TO groups_legacy_v0;');
  }

  // 2) 建新结构（幂等）
  d.exec(DDL);
  d.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  ensureColumns(d, 'proxies', { remark: 'TEXT', ipchecker: 'TEXT' });

  // 3) 数据搬迁
  if (tableExists(d, 'profiles_legacy_v0')) migrateLegacyProfiles(d);
  if (tableExists(d, 'groups_legacy_v0')) migrateLegacyGroups(d);

  // 默认分组
  const has = d.prepare('SELECT COUNT(*) AS n FROM groups').get();
  if (has.n === 0) {
    d.prepare('INSERT INTO groups (id, name, sort, created_at) VALUES (?, ?, ?, ?)')
      .run('0', 'Default', 0, new Date().toISOString());
  }
}

function tableExists(d, name) {
  return !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

/** 老库补列（CREATE TABLE IF NOT EXISTS 不会给已有表加列） */
function ensureColumns(d, table, cols) {
  if (!tableExists(d, table)) return;
  const have = new Set(tableColumns(d, table));
  for (const [name, type] of Object.entries(cols)) {
    if (!have.has(name)) d.exec(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${type};`);
  }
}

function migrateLegacyGroups(d) {
  const rows = d.prepare('SELECT group_id, group_name, sort, created_time FROM groups_legacy_v0').all();
  for (const r of rows) {
    d.prepare('INSERT OR REPLACE INTO groups (id, name, sort, created_at) VALUES (?, ?, ?, ?)')
      .run(String(r.group_id), String(r.group_name ?? 'Default'), Number(r.sort || 0), new Date(Number(r.created_time || 0) * 1000).toISOString());
  }
}

/**
 * 老 payload → 新平铺记录。
 * 老的 fingerprint_config 是嵌套结构（seed/kernel/ua/screen/webgl/fonts…），逐项映射到字段表；
 * 映射不到的一律走安全默认，但 UA / 时区 / WebGL / 种子这些「有语义」的值必须原样保留。
 */
export function mapLegacyPayload(row) {
  let p = {};
  try { p = JSON.parse(row.payload || '{}'); } catch { /* 坏数据按空处理 */ }
  const fp = p.fingerprint_config || {};
  const kernel = fp.kernel || {};
  const screen = fp.screen || {};
  const gl = fp.webgl || {};
  const seed = fp.seed != null ? fp.seed : p.fingerprint_seed;
  const num = (v, dflt) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
  const seedInt = (salt) => {
    let h = (2166136261 ^ salt) >>> 0;
    const s = `${seed ?? ''}:${salt}`;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h | 0;
  };
  const created = row.created_time ? new Date(Number(row.created_time) * 1000).toISOString() : new Date().toISOString();
  const lang = Array.isArray(fp.language) && fp.language.length ? fp.language : ['en-US'];

  return {
    id: String(p.profile_id ?? row.profile_id),
    profile_no: Number(p.profile_no ?? row.profile_no ?? 10001),
    name: String(p.name ?? row.name ?? 'env'),
    group_id: String(p.group_id ?? row.group_id ?? '0'),
    remark: p.remark ?? '',
    domain_name: p.domain_name ?? '',
    open_urls: Array.isArray(p.open_urls) ? p.open_urls : [],
    ua: fp.ua ?? null,
    client_hints: kernel.full_version ? {
      platform: 'Windows',
      platform_version: '10.0.0',
      architecture: 'x86',
      bitness: '64',
      mobile: '0',
      wow64: '0',
      ua_full_version: kernel.full_version,
      model: '',
    } : null,
    platform: fp.platform ?? 'Win32',
    language: lang,
    language_switch: '0',
    page_language: fp.locale ?? lang[0],
    page_language_switch: '1',
    timezone: fp.timezone ?? 'UTC',
    automatic_timezone: '0',
    location: 'allow',
    location_switch: '0',
    accuracy: 1000,
    screen_resolution: screen.width && screen.height ? `${screen.width}_${screen.height}` : 'none',
    device_scale: num(fp.device_scale_factor, num(screen.device_scale_factor, 1)),
    hardware_concurrency: num(fp.hardware_concurrency, 'default'),
    device_memory: num(fp.device_memory, 'default'),
    canvas: fp.canvas && fp.canvas.mode !== 'off' ? '1' : '0',
    canvas_id: seedInt(1),
    webgl_image: '1',
    webgl_image_id: seedInt(2),
    audio: fp.audio && fp.audio.mode !== 'off' ? '1' : '0',
    audio_id: seedInt(3),
    client_rects: '1',
    client_rects_id: seedInt(4),
    webgl: gl.vendor && gl.renderer ? '2' : '0',
    webgl_config: gl.vendor && gl.renderer ? {
      unmasked_vendor: gl.vendor,
      unmasked_renderer: gl.renderer,
      webgpu: { webgpu_switch: '1' },
    } : null,
    fonts: ['all'],
    media_devices: '2',
    media_devices_num: fp.media_devices ? {
      audioinput_num: fp.media_devices.audioinput ?? 2,
      videoinput_num: fp.media_devices.videoinput ?? 1,
      audiooutput_num: fp.media_devices.audiooutput ?? 2,
    } : { audioinput_num: 2, videoinput_num: 1, audiooutput_num: 2 },
    webrtc: 'disable_udp',
    scan_port_type: '1',
    allow_scan_ports: '',
    user_proxy_config: p.proxy_config ?? null,
    flash: 'block',
    do_not_track: 'default',
    fp_seed: typeof seed === 'number' ? seed : seedInt(0),
    kernel_version: kernel.full_version ?? null,
    status: 'idle',
    created_at: created,
    updated_at: created,
  };
}

function migrateLegacyProfiles(d) {
  const rows = d.prepare('SELECT * FROM profiles_legacy_v0').all();
  let ok = 0;
  let bad = 0;
  for (const row of rows) {
    try {
      const rec = mapLegacyPayload(row);
      if (d.prepare('SELECT 1 FROM profiles WHERE id = ?').get(rec.id)) continue;
      insertRecord(d, rec);
      ok++;
    } catch (e) {
      bad++;
      d.exec('CREATE TABLE IF NOT EXISTS migration_errors (id TEXT, error TEXT, at TEXT);');
      d.prepare('INSERT INTO migration_errors VALUES (?, ?, ?)').run(String(row.profile_id ?? '?'), String(e.message), new Date().toISOString());
    }
  }
  d.exec('CREATE TABLE IF NOT EXISTS migration_meta (key TEXT PRIMARY KEY, value TEXT)');
  d.prepare('INSERT OR REPLACE INTO migration_meta VALUES (?, ?)').run('legacy_v0', JSON.stringify({ migrated: ok, failed: bad, at: new Date().toISOString() }));
}

/* ---------------------------- meta / API Key ---------------------------- */

export function getMeta(key) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(key, value) {
  getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

/** 首次运行生成 API Key，并写出发现文件供本地脚本读取（不打印到日志） */
export function ensureApiKey({ port } = {}) {
  let key = getMeta('api_key');
  if (!key) {
    key = 'fp_' + Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(24))).toString('hex');
    setMeta('api_key', key);
  }
  const file = path.join(DATA_DIR, 'local_api');
  const content = `http://127.0.0.1:${port || process.env.FREEPOWER_PORT || 53380}/\napi_key=${key}\n`;
  try {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) fs.writeFileSync(file, content);
  } catch { /* 发现文件写不了不致命 */ }
  return key;
}