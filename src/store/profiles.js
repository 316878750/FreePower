/**
 * profile 仓储（FreePower 内部）—— schema 事实源是 packages/profile。
 * 这里只做：输入整形（API 风格 → 平铺字段）、指纹生成/重算、分页与分组。
 */
import {
  createProfile as dbCreate,
  getProfile as dbGet,
  listProfiles as dbList,
  updateProfile as dbUpdate,
  deleteProfile as dbDelete,
  setStatus,
} from '../../packages/profile/src/repo.js';
import { validateProfile, validateField } from '../../packages/profile/src/validate.js';
import { BY_NAME } from '../../packages/profile/src/fields.js';
import { getDb } from './db.js';
import { generateFingerprint, regenerateFingerprint, FALLBACK_KERNEL, geoFor } from '../fingerprint/generate.js';
import { fingerprintView, declaredSnapshot } from '../fingerprint/view.js';
import { newSeed } from '../fingerprint/rng.js';
import { findChrome } from '../kernel/chrome.js';

/** 对外暴露的默认代理形状（user_proxy_config 镜像） */
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
    proxy_type: String(p.proxy_type || 'http').toLowerCase(),
    host: p.host || p.proxy_host || '',
    port: Number(p.port || p.proxy_port || 0),
    username: p.username || p.proxy_user || '',
    password: p.password || p.proxy_pwd || '',
    proxy_id: p.proxy_id || p.proxyid || '',
  };
}

/** API 传进来的 fingerprint_config（嵌套）→ 平铺字段 */
function flattenFingerprint(input = {}) {
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (BY_NAME.has(k)) out[k] = v;
  }
  // 兼容 v0 的嵌套写法（老客户端/脚本）
  if (input.screen && typeof input.screen === 'object') {
    out.screen_resolution = `${input.screen.width}_${input.screen.height}`;
  }
  if (input.webgl_config && typeof input.webgl_config === 'object') out.webgl = out.webgl ?? '2';
  if (Array.isArray(input.languages)) out.language = input.languages;
  return out;
}

/** 内部记录 → 对外形状（保留嵌套视图，方便老调用方与注入层） */
export function toApi(profile) {
  if (!profile) return null;
  const view = fingerprintView(profile);
  return {
    ...profile,
    profile_id: profile.id,
    group_name: groupName(profile.group_id),
    proxy_config: profile.user_proxy_config ? normalizeProxy(profile.user_proxy_config) : { ...DEFAULT_PROXY },
    fingerprint_config: {
      ...declaredSnapshot(profile, view),
      // 兼容 v0 嵌套字段（smoke 与老脚本读这些）
      seed: String(profile.fp_seed),
      kernel: { full_version: profile.kernel_version || kernelVersionForNewProfile(), major: String(profile.kernel_version || '').split('.')[0] || undefined },
      screen: view.screen || undefined,
      webgl: view.webgl || undefined,
      device_scale_factor: view.device_scale_factor,
      canvas: view.canvas || undefined,
      audio: view.audio || undefined,
      fonts: { list: profile.fonts, spoofed: false },
    },
  };
}

export function createProfile(input = {}) {
  const seed = input.fingerprint_seed ?? newSeed();
  const kernel = input.kernel_version || kernelVersionForNewProfile();
  const country = input.country || 'US';
  const generated = generateFingerprint({ seed: String(seed), kernel, country });

  const flat = {
    ...generated,
    ...flattenFingerprint(input.fingerprint_config),
    ...flattenFingerprint(input),
    group_id: String(input.group_id ?? input.batch_id ?? '0'),
    name: String(input.name || `env-${Date.now() % 100000}`).slice(0, 100),
    remark: input.remark || '',
    domain_name: input.domain_name ?? input.platform ?? '',
    open_urls: input.open_urls ?? input.openfb_urls ?? [],
    user_proxy_config: input.proxy_config || input.user_proxy_config
      ? normalizeProxy(input.proxy_config || input.user_proxy_config)
      : null,
    fp_seed: Number(seed) || seedHash(seed),
    kernel_version: kernel,
    status: 'idle',
  };
  if (flat.user_proxy_config) flat.domain_name = flat.domain_name || '';

  const res = dbCreate(getDb(), flat);
  if (!res.ok) {
    const err = new Error(res.errors.map((e) => `${e.field}: ${e.message}`).join('; '));
    err.fieldErrors = res.errors;
    err.warnings = res.warnings;
    throw err;
  }
  return toApi(res.profile);
}

function seedHash(seed) {
  let h = 2166136261 >>> 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h | 0;
}

function groupName(groupId) {
  const row = getDb().prepare('SELECT name FROM groups WHERE id = ?').get(String(groupId));
  return row ? row.name : 'Default';
}

export function getProfile(profileId) {
  return toApi(dbGet(getDb(), profileId));
}

export function listProfiles({ page = 1, page_size = 50, group_id = null, name = null } = {}) {
  const db = getDb();
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
  const total = db.prepare(`SELECT COUNT(*) AS n FROM profiles ${sqlWhere}`).get(...args).n;
  const size = Math.min(Math.max(Number(page_size) || 50, 1), 500);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * size;
  const rows = db.prepare(`SELECT id FROM profiles ${sqlWhere} ORDER BY profile_no ASC LIMIT ? OFFSET ?`).all(...args, size, offset);
  return {
    list: rows.map((r) => toApi(dbGet(db, r.id))),
    page: Number(page) || 1,
    page_size: size,
    total,
  };
}

export function updateProfile(profileId, patch = {}) {
  const cur = dbGet(getDb(), profileId);
  if (!cur) return null;

  const flat = { ...flattenFingerprint(patch.fingerprint_config), ...flattenFingerprint(patch) };
  if (patch.name !== undefined) flat.name = String(patch.name).slice(0, 100);
  if (patch.remark !== undefined) flat.remark = String(patch.remark);
  if (patch.domain_name !== undefined) flat.domain_name = String(patch.domain_name);
  if (patch.group_id !== undefined || patch.batch_id !== undefined) flat.group_id = String(patch.group_id ?? patch.batch_id);
  if (patch.open_urls !== undefined || patch.openfb_urls !== undefined) {
    const u = patch.open_urls ?? patch.openfb_urls;
    flat.open_urls = Array.isArray(u) ? u : u ? [u] : [];
  }
  if (patch.proxy_config !== undefined || patch.proxy_host !== undefined || patch.host !== undefined) {
    flat.user_proxy_config = normalizeProxy({ ...(cur.user_proxy_config || {}), ...(patch.proxy_config || patch) });
  }

  // 换国家 = 换时区/语言/地理，必须整组重算，不能只改一个字段
  const country = patch.country;
  if (country && country !== cur.country) {
    Object.assign(flat, generateFingerprint({
      seed: String(cur.fp_seed),
      kernel: cur.kernel_version || kernelVersionForNewProfile(),
      country,
    }));
    flat.language_switch = '0';
    flat.automatic_timezone = '0';
    flat.location_switch = '0';
  }

  // 随机指纹：换种子整组重算
  if (String(patch.random_fingerprint ?? patch.switch_random_finger) === '1') {
    const seed = newSeed();
    Object.assign(flat, regenerateFingerprint(cur, {
      seed,
      kernel: cur.kernel_version || kernelVersionForNewProfile(),
      country,
    }));
    flat.fp_seed = seedHash(seed);
    flat.random_fingerprint = '0';
  }

  const res = dbUpdate(getDb(), profileId, flat);
  if (!res.ok) {
    const err = new Error(res.errors.map((e) => `${e.field}: ${e.message}`).join('; '));
    err.fieldErrors = res.errors;
    throw err;
  }
  return toApi(res.profile);
}

export function deleteProfiles(ids = []) {
  const db = getDb();
  const deleted = [];
  for (const id of ids) {
    if (dbDelete(db, id)) deleted.push(id);
  }
  return deleted;
}

export function regroupProfiles(ids = [], groupId = '0') {
  const db = getDb();
  let changed = 0;
  for (const id of ids) {
    if (!db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(id)) continue;
    db.prepare('UPDATE profiles SET group_id = ?, updated_at = ? WHERE id = ?')
      .run(String(groupId), new Date().toISOString(), id);
    changed++;
  }
  return changed;
}

export function newFingerprintFor(profileId) {
  const cur = dbGet(getDb(), profileId);
  if (!cur) return null;
  return updateProfile(profileId, { random_fingerprint: '1' });
}

export function listGroups() {
  return getDb().prepare('SELECT id AS group_id, name AS group_name, sort FROM groups ORDER BY sort ASC, created_at ASC').all();
}

export function createGroup(groupNameStr) {
  const db = getDb();
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort), 0) AS n FROM groups').get().n;
  const id = String(maxSort + 1);
  db.prepare('INSERT INTO groups (id, name, sort, created_at) VALUES (?, ?, ?, ?)')
    .run(id, groupNameStr, maxSort + 1, new Date().toISOString());
  return { group_id: id, group_name: groupNameStr };
}

export function markStatus(profileId, status) {
  setStatus(getDb(), profileId, status);
}

/** 启动前一致性校验：返回 {ok, errors, warnings} */
export function checkProfile(profile) {
  const input = {};
  for (const f of BY_NAME.keys()) {
    if (profile[f] !== undefined && profile[f] !== null) input[f] = profile[f];
  }
  return validateProfile(input, { mode: 'update', fillDefaults: false });
}