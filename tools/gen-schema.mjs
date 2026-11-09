// 由拆解字段表 + 人工覆盖层生成 profile 字段注册表与 DDL。
// 用法：node tools/gen-schema.mjs
// 产物：packages/profile/src/fields.generated.json、packages/profile/src/schema.sql
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STORAGE, COVERAGE, DEFAULTS, DEFAULT_SOURCE, DOMAIN_NOTES, NOTES } from '../packages/profile/reference/overrides.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const refPath = path.join(root, 'packages/profile/reference/ads-8.9.23-fields.json');
const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));

const SQL_TYPE = { string: 'TEXT', number: 'REAL', enum: 'TEXT', object: 'TEXT', 'array<string>': 'TEXT', 'array<object>': 'TEXT', 'array<enum>': 'TEXT' };
const INT_FIELDS = new Set(['win_x', 'win_y', 'image_size', 'canvas_id', 'webgl_image_id', 'audio_id', 'client_rects_id']);

/** 从参考表里压平字段，保留分组与原始元信息 */
const fields = [];
const seen = new Map();
for (const [group, defs] of Object.entries(ref.profile)) {
  for (const [name, def] of Object.entries(defs)) {
    if (seen.has(name)) {
      // virtual_camera 在 browser 与 privacy_switches 重复出现，保留第一次
      seen.get(name).alsoIn = [...(seen.get(name).alsoIn ?? []), group];
      continue;
    }
    // 数组/对象型没显式指定存储方式时一律走 JSON 列，避免把数组塞进 TEXT 列
    const storage = STORAGE[name] ?? (def.type.startsWith('array') || def.type === 'object' ? 'json' : 'column');
    const entry = {
      name,
      group,
      type: def.type,
      storage,
      sqlType: storage === 'column' ? (INT_FIELDS.has(name) ? 'INTEGER' : SQL_TYPE[def.type] ?? 'TEXT') : 'TEXT',
      values: def.values ?? null,
      range: def.range ?? null,
      requires_kernel: def.requires_kernel ?? null,
      precision: def.precision ?? null,
      format: def.format ?? null,
      shape: def.shape ?? null,
      max: def.max ?? null,
      required: def.required ?? false,
      server_side: def.server_side ?? false,
      apiV2Alias: def.api_v2_alias ?? null,
      apiV2AliasFrom: def.api_v2_alias_from ?? null,
      default: DEFAULTS[name] ?? null,
      defaultSource: DEFAULTS[name] === undefined ? null : DEFAULT_SOURCE[name] ?? 'guessed',
      domainNote: DOMAIN_NOTES[name] ?? null,
      coverage: COVERAGE[name] ?? 'n/a',
      note: NOTES[name] ?? null,
      evidence: '实测',
    };
    seen.set(name, entry);
    fields.push(entry);
  }
}

// ---- 自研扩展字段（不在对方表里）----
const EXT = [
  { name: 'id', sqlType: 'TEXT', note: '内部主键 uuid' },
  { name: 'profile_no', sqlType: 'INTEGER', note: '对外展示编号，v2 profile_no' },
  { name: 'fp_seed', sqlType: 'INTEGER', note: '噪点种子：canvas/audio/webgl_image/client_rects 由它派生，保证同环境每次启动一致' },
  { name: 'kernel_version', sqlType: 'TEXT', note: 'CfT 内核 pin（如 131.0.6778.86），ua_auto 时由内核决定 UA' },
  { name: 'proxy_id', sqlType: 'TEXT', note: '代理记录外键；user_proxy_config 只做 API 兼容镜像' },
  { name: 'status', sqlType: 'TEXT', note: 'idle | starting | running | crashed' },
  { name: 'created_at', sqlType: 'TEXT', note: '' },
  { name: 'updated_at', sqlType: 'TEXT', note: '' },
  { name: 'last_launch_at', sqlType: 'TEXT', note: '' },
];

// ---- DDL ----
const q = (n) => `"${n}"`;
const colLines = fields.map((f) => {
  const bits = [`  ${q(f.name)} ${f.sqlType}`];
  if (f.required) bits.push('NOT NULL');
  return bits.join(' ');
});
const extLines = EXT.map((c) => `  ${q(c.name)} ${c.sqlType}`);

const ddl = `-- 由 tools/gen-schema.mjs 生成，勿手改。
-- 形状：平铺大表 + 一个 fingerprint_config JSON 列（对齐 AdsPower 8.9.23 的存储形状）。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proxies (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  proxy_type    TEXT NOT NULL CHECK (proxy_type IN ('http','https','socks5','ssh','none')),
  host          TEXT NOT NULL,
  port          INTEGER NOT NULL,
  username      TEXT,
  password      TEXT,
  last_ip       TEXT,
  last_country  TEXT,
  last_region   TEXT,
  last_city     TEXT,
  last_tz       TEXT,
  checked_at    TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kernels (
  version     TEXT PRIMARY KEY,
  major       INTEGER NOT NULL,
  channel     TEXT NOT NULL,
  path        TEXT,
  size_bytes  INTEGER,
  installed_at TEXT
);

CREATE TABLE IF NOT EXISTS launches (
  id          TEXT PRIMARY KEY,
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  cdp_port    INTEGER NOT NULL,
  pid         INTEGER,
  ws_endpoint TEXT,
  args_json   TEXT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT
);

CREATE TABLE IF NOT EXISTS profile_tags (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  tag_id     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (profile_id, tag_id)
);

CREATE TABLE IF NOT EXISTS profiles (
  -- 自研扩展
${extLines.join(',\n')},

  -- 平铺字段（拆解表）
${colLines.join(',\n')},

  -- 结构化指纹对象
  "fingerprint_config" TEXT NOT NULL DEFAULT '{}',

  PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS idx_profiles_group ON profiles("group_id");
CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles("status");
CREATE INDEX IF NOT EXISTS idx_launches_profile ON launches(profile_id);
`;

const outDir = path.join(root, 'packages/profile/src');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'fields.generated.json'), JSON.stringify({ meta: { generatedFrom: 'ads-8.9.23-fields.json', count: fields.length, ext: EXT }, fields }, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'schema.sql'), ddl);

const byGroup = fields.reduce((a, f) => ((a[f.group] = (a[f.group] ?? 0) + 1), a), {});
const byCov = fields.reduce((a, f) => ((a[f.coverage] = (a[f.coverage] ?? 0) + 1), a), {});
console.log('fields:', fields.length, 'ext:', EXT.length);
console.log('by group:', byGroup);
console.log('by coverage:', byCov);
console.log('written: packages/profile/src/{fields.generated.json,schema.sql}');
