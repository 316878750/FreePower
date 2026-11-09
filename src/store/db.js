import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, DATA_DIR } from '../config.js';

let db = null;

export function getDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS groups (
      group_id      TEXT PRIMARY KEY,
      group_name    TEXT NOT NULL,
      sort          INTEGER NOT NULL DEFAULT 0,
      created_time  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profiles (
      profile_id    TEXT PRIMARY KEY,
      profile_no    INTEGER NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      group_id      TEXT NOT NULL DEFAULT '0',
      payload       TEXT NOT NULL,
      created_time  INTEGER NOT NULL,
      updated_time  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_profiles_group ON profiles(group_id);
  `);

  const has = d.prepare('SELECT COUNT(*) AS n FROM groups').get();
  if (has.n === 0) {
    d.prepare('INSERT INTO groups (group_id, group_name, sort, created_time) VALUES (?, ?, ?, ?)')
      .run('0', 'Default', 0, Math.floor(Date.now() / 1000));
  }
}

export function getMeta(key) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(key, value) {
  getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

/** 首次运行生成 API Key 并落盘，供本地脚本读取（不打印到日志） */
export function ensureApiKey() {
  let key = getMeta('api_key');
  if (!key) {
    const crypto = globalThis.crypto;
    key = 'fp_' + Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex');
    setMeta('api_key', key);
  }
  const file = path.join(DATA_DIR, 'local_api');
  const content = `http://127.0.0.1:${process.env.FREEPOWER_PORT || 53380}/\napi_key=${key}\n`;
  try {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) fs.writeFileSync(file, content);
  } catch { /* 发现文件写不了不致命 */ }
  return key;
}
