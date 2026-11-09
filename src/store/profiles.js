import { getDb } from './db.js';
import { generateFingerprint, regenerateFingerprint, FALLBACK_KERNEL } from '../fingerprint/generate.js';
import { newProfileId, newSeed } from '../fingerprint/rng.js';
import { findChrome } from '../kernel/chrome.js';

/**
 * profile schema（FreePower 内部；对外 Local API 字段名待群里和拆解手对齐后映射）
 * 之所以先定内部 schema：拆解手的字段表还没到，但存储层不能等 —— 迁移时只改映射层。
 */
export const DEFAULT_PROXY = {
  proxy_soft: 'other',
  proxy_type: 'http',
  host: '',
  port: 0,
  username: '',
  password: '',
  proxy_id: '',
};

export function kernelVersionForNewProfile() {
  const c = findChrome();
  return c && c.version ? c.version : FALLBACK_KERNEL;
}

function normalizeProxy(p = {}) {
  return {
    proxy_soft: p.proxy_soft || 'other',
    proxy_type: (p.proxy_type || 'http').toLowerCase(),
    host: p.host || p.proxy_host || '',
    port: Number(p.port || p.proxy_port || 0),
    username: p.username || p.proxy_user || '',
    password: p.password || p.proxy_pwd || '',
    proxy_id: p.proxy_id || p.proxyid || '',
  };
}

export function createProfile(input = {}) {
  const db = getDb();
  let id = input.profile_id || newProfileId();
  while (db.prepare('SELECT 1 FROM profiles WHERE profile_id = ?').get(id)) id = newProfileId();

  const maxNo = db.prepare('SELECT COALESCE(MAX(profile_no), 0) AS n FROM profiles').get().n;
  const now = Math.floor(Date.now() / 1000);
  const seed = input.fingerprint_seed || newSeed();
  const kernel = kernelVersionForNewProfile();
  const fp = generateFingerprint({ seed, kernel, country: input.country || 'US' });

  const profile = {
    profile_id: id,
    profile_no: maxNo + 1,
    name: input.name || `env-${maxNo + 1}`,
    group_id: String(input.group_id ?? '0'),
    remark: input.remark || '',
    domain_name: input.domain_name || '',
    open_urls: Array.isArray(input.open_urls) ? input.open_urls : (input.open_urls ? [input.open_urls] : []),
    proxy_config: normalizeProxy(input.proxy_config || input),
    fingerprint_config: fp,
    created_time: now,
    updated_time: now,
  };
  profile.group_name = groupName(profile.group_id);

  db.prepare(`INSERT INTO profiles (profile_id, profile_no, name, group_id, payload, created_time, updated_time)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(profile.profile_id, profile.profile_no, profile.name, profile.group_id, JSON.stringify(profile), now, now);
  return profile;
}

function groupName(groupId) {
  const row = getDb().prepare('SELECT group_name FROM groups WHERE group_id = ?').get(String(groupId));
  return row ? row.group_name : 'Default';
}

export function getProfile(profileId) {
  const row = getDb().prepare('SELECT payload FROM profiles WHERE profile_id = ?').get(profileId);
  return row ? JSON.parse(row.payload) : null;
}

export function listProfiles({ page = 1, page_size = 50, group_id = null, name = null } = {}) {
  const where = [];
  const args = [];
  if (group_id !== null && group_id !== undefined && group_id !== '') {
    where.push('group_id = ?');
    args.push(String(group_id));
  }
  if (name) {
    where.push('name LIKE ?');
    args.push(`%${name}%`);
  }
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = getDb().prepare(`SELECT COUNT(*) AS n FROM profiles ${sqlWhere}`).get(...args).n;
  const size = Math.min(Math.max(Number(page_size) || 50, 1), 500);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * size;
  const rows = getDb()
    .prepare(`SELECT payload FROM profiles ${sqlWhere} ORDER BY profile_no ASC LIMIT ? OFFSET ?`)
    .all(...args, size, offset);
  return { list: rows.map((r) => JSON.parse(r.payload)), page: Number(page) || 1, page_size: size, total };
}

export function updateProfile(profileId, patch = {}) {
  const cur = getProfile(profileId);
  if (!cur) return null;
  const now = Math.floor(Date.now() / 1000);
  const next = { ...cur };

  for (const key of ['name', 'remark', 'domain_name', 'group_id']) {
    if (patch[key] !== undefined) next[key] = String(patch[key]);
  }
  if (patch.open_urls !== undefined) {
    next.open_urls = Array.isArray(patch.open_urls) ? patch.open_urls : [patch.open_urls];
  }
  if (patch.proxy_config !== undefined || patch.host !== undefined || patch.proxy_host !== undefined) {
    next.proxy_config = normalizeProxy({ ...cur.proxy_config, ...(patch.proxy_config || patch) });
  }
  // 指纹字段是「整组」的：改单个字段必须重算，避免 UA 说 Win11、WebGL 报另一台机器的组合
  if (patch.fingerprint_config !== undefined) {
    next.fingerprint_config = {
      ...cur.fingerprint_config,
      ...patch.fingerprint_config,
      kernel: { ...cur.fingerprint_config.kernel, ...(patch.fingerprint_config.kernel || {}) },
    };
  }
  if (patch.country) {
    next.fingerprint_config = regenerateFingerprint(next.fingerprint_config, { seed: next.fingerprint_config.seed, country: patch.country });
  }
  next.updated_time = now;
  next.group_name = groupName(next.group_id);

  getDb().prepare('UPDATE profiles SET name = ?, group_id = ?, payload = ?, updated_time = ? WHERE profile_id = ?')
    .run(next.name, next.group_id, JSON.stringify(next), now, profileId);
  return next;
}

export function deleteProfiles(ids = []) {
  const db = getDb();
  const deleted = [];
  for (const id of ids) {
    const r = db.prepare('DELETE FROM profiles WHERE profile_id = ?').run(id);
    if (r.changes) deleted.push(id);
  }
  return deleted;
}

export function regroupProfiles(ids = [], groupId = '0') {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  let changed = 0;
  for (const id of ids) {
    const p = getProfile(id);
    if (!p) continue;
    p.group_id = String(groupId);
    p.group_name = groupName(p.group_id);
    p.updated_time = now;
    db.prepare('UPDATE profiles SET group_id = ?, payload = ?, updated_time = ? WHERE profile_id = ?')
      .run(p.group_id, JSON.stringify(p), now, id);
    changed++;
  }
  return changed;
}

export function newFingerprintFor(profileId) {
  const cur = getProfile(profileId);
  if (!cur) return null;
  const fp = regenerateFingerprint(cur.fingerprint_config, { seed: newSeed() });
  return updateProfile(profileId, { fingerprint_config: fp });
}

export function listGroups() {
  return getDb().prepare('SELECT group_id, group_name FROM groups ORDER BY sort ASC, created_time ASC').all();
}

export function createGroup(groupNameStr) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort), 0) AS n FROM groups').get().n;
  const id = String(maxSort + 1);
  db.prepare('INSERT INTO groups (group_id, group_name, sort, created_time) VALUES (?, ?, ?, ?)')
    .run(id, groupNameStr, maxSort + 1, now);
  return { group_id: id, group_name: groupNameStr };
}
