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
  restoreProfile as dbRestore,
  listDeletedProfiles as dbListDeleted,
  setStatus,
} from '../../packages/profile/src/repo.js';
import { validateProfile, validateField } from '../../packages/profile/src/validate.js';
import { BY_NAME } from '../../packages/profile/src/fields.js';
import { getDb } from './db.js';
import { generateFingerprint, regenerateFingerprint, FALLBACK_KERNEL, geoFor } from '../fingerprint/generate.js';
import { fingerprintView, declaredSnapshot } from '../fingerprint/view.js';
import { newSeed } from '../fingerprint/rng.js';
import { findChrome } from '../kernel/chrome.js';
import { getProxy, proxyConfigOf } from './proxies.js';

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
    password: p.password || p.proxy_password || p.proxy_pwd || '',
    proxy_id: p.proxy_id || p.proxyid || '',
  };
}

/** API 传进来的 fingerprint_config（嵌套）→ 平铺字段 */
function flattenFingerprint(input = {}) {
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (BY_NAME.has(k)) out[k] = v;
  }
  // launch_args 契约：对外是数组，落库是 JSON 字符串（字段表里它是 string 列）
  if (Array.isArray(out.launch_args)) out.launch_args = JSON.stringify(out.launch_args);
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
  let launchArgs = [];
  if (Array.isArray(profile.launch_args)) launchArgs = profile.launch_args;
  else if (typeof profile.launch_args === 'string' && profile.launch_args.trim()) {
    try { launchArgs = JSON.parse(profile.launch_args); } catch { launchArgs = profile.launch_args.split(/\r?\n/).filter(Boolean); }
  }
  return {
    ...profile,
    launch_args: launchArgs,
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

/**
 * cookie 字段的存储形状：对手要求它是「JSON 数组字符串」（校验文案 `cookie must be list string`），
 * 但脚本里经常直接传 `sid=xxx; uid=7` 这种原始串。三种都收：
 *   - 对象数组（AdsPower 导出的形状：`[{name,value,domain,expires,…}]`）→ **原样**序列化，
 *     元素不许 `String()`（那会把整条 cookie 变成 `"[object Object]"`，导入成功、cookie 全毁）
 *   - 已经是 JSON 数组串 → 规整成数组串（对象元素保留，字符串元素保留）
 *   - 原始串 → 包成单元素数组（读出来还是原文）
 */
function cookieEntry(x) {
  return x && typeof x === 'object' && !Array.isArray(x) ? x : String(x);
}

export function cookieToStorage(v) {
  if (Array.isArray(v)) return JSON.stringify(v.map(cookieEntry));
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return JSON.stringify(parsed.map(cookieEntry));
    } catch { /* 不是 JSON，按原始串处理 */ }
  }
  return JSON.stringify([s]);
}

/**
 * 存储形状 → 对外「原文」（单元素直接返回，多元素按 ; 拼成可用的 cookie 串）。
 * 结构化元素（AdsPower 形状）按 `name=value` 重建；没有 name 的元素跳过 ——
 * 绝不把 `[object Object]` 当 cookie 串交出去。
 */
export function cookieText(v) {
  const s = String(v ?? '');
  if (!s.trim()) return '';
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) {
      return parsed.map((x) => {
        if (x && typeof x === 'object' && !Array.isArray(x)) return x.name ? `${x.name}=${x.value ?? ''}` : '';
        return String(x);
      }).filter(Boolean).join('; ');
    }
  } catch { /* 老数据就是原始串 */ }
  return s;
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
  if (input.login_cookie !== undefined) flat.cookie = cookieToStorage(input.login_cookie);
  else if (flat.cookie !== undefined && flat.cookie !== null) flat.cookie = cookieToStorage(flat.cookie);
  if (Array.isArray(input.profile_tag_ids)) flat.profile_tag_ids = input.profile_tag_ids.map(String);
  // 引用代理列表里的代理：proxy_id → 连接配置（显式 proxy_config 优先，不覆盖）
  if (!flat.user_proxy_config && input.proxy_id) {
    const preset = getProxy(input.proxy_id);
    if (preset) flat.user_proxy_config = proxyConfigOf(preset);
  }

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

export function getProfile(profileId, opts) {
  return toApi(dbGet(getDb(), profileId, opts));
}

/** serial_number / profile_no 是同一个数字编号，脚本里两种写法都有（回收站里的不算） */
export function getProfileByNo(no) {
  const n = Number(no);
  if (!Number.isFinite(n)) return null;
  const row = getDb().prepare('SELECT id FROM profiles WHERE profile_no = ? AND deleted_at IS NULL').get(n);
  return row ? toApi(dbGet(getDb(), row.id)) : null;
}

/**
 * 环境列表。
 *
 * `archived` 控制**归档**的这批算不算在内（0.4.3 ③）：
 *   - 不传 / `'exclude'`：只看主列表（默认）—— 归档的「移出主列表」就是这个意思；
 *   - `'only'`：只看已归档的（列表页那个「已归档」筛选）；
 *   - `'include'` / `'all'`：全都算进来。
 * 归档**不是删除**：`deleted_at` 为空的归档环境照样能启动、能编辑，
 * 只是默认不在主列表里出现。回收站（`deleted_at` 非空）与它是两套语义，别混。
 */
export function listProfiles({ page = 1, page_size = 50, group_id = null, name = null, ids = null, profile_nos = null, tag_ids = null, sort_field = null, sort_order = null, include_deleted = false, archived = null } = {}) {
  const db = getDb();
  // 回收站里的环境一律不出现在 list 里（软删除语义，见 deleteProfiles）
  const where = include_deleted ? [] : ['deleted_at IS NULL'];
  const args = [];
  const arch = String(archived || 'exclude').toLowerCase();
  if (arch === 'only') where.push('archived_at IS NOT NULL');
  else if (arch !== 'include' && arch !== 'all') where.push('archived_at IS NULL');
  if (group_id !== null && group_id !== undefined && group_id !== '') {
    where.push('group_id = ?');
    args.push(String(group_id));
  }
  if (name) {
    where.push('name LIKE ?');
    args.push(`%${name}%`);
  }
  if (Array.isArray(ids) && ids.length) {
    where.push(`id IN (${ids.map(() => '?').join(',')})`);
    args.push(...ids.map(String));
  }
  if (Array.isArray(profile_nos) && profile_nos.length) {
    const nos = profile_nos.map(Number).filter(Number.isFinite);
    if (nos.length) {
      where.push(`profile_no IN (${nos.map(() => '?').join(',')})`);
      args.push(...nos);
    }
  }
  if (Array.isArray(tag_ids) && tag_ids.length) {
    // profile_tag_ids 是 CSV 存储：用 ,id, 的边界匹配，避免 tag_ab 命中 tag_abc
    const likes = tag_ids.map(() => `(',' || profile_tag_ids || ',') LIKE ?`);
    where.push(`(${likes.join(' OR ')})`);
    for (const t of tag_ids) args.push(`%,${String(t)},%`);
  }
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM profiles ${sqlWhere}`).get(...args).n;
  const size = Math.min(Math.max(Number(page_size) || 50, 1), 500);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * size;
  const sortable = { name: 'name', profile_no: 'profile_no', created_at: 'created_at', updated_at: 'updated_at', last_launch_at: 'last_launch_at' };
  const orderBy = sortable[String(sort_field || 'profile_no')] || 'profile_no';
  const dir = String(sort_order || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const rows = db.prepare(`SELECT id FROM profiles ${sqlWhere} ORDER BY ${orderBy} ${dir} LIMIT ? OFFSET ?`).all(...args, size, offset);
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
  /*
   * 代理三态必须分清（批量改代理「改成直连」就栽在这条上）：
   *   `proxy_config: null`  → **显式清空**，不合并旧值（老实现 `{...cur, ...(null || patch)}`
   *                          会把旧 host/port 原样留下来，于是「改成直连」回 code=0 但其实没改）；
   *   `proxy_config: {...}` → 与现有合并（只改端口的场景要保住 host/username）；
   *   不给                 → 不动。
   */
  if (patch.proxy_config === null) {
    flat.user_proxy_config = null;
    flat.proxy_id = null;
  } else if (patch.proxy_config !== undefined || patch.proxy_host !== undefined || patch.host !== undefined) {
    flat.user_proxy_config = normalizeProxy({ ...(cur.user_proxy_config || {}), ...(patch.proxy_config || patch) });
  }
  if (patch.login_cookie !== undefined) flat.cookie = cookieToStorage(patch.login_cookie);
  else if (flat.cookie !== undefined && flat.cookie !== null) flat.cookie = cookieToStorage(flat.cookie);
  if (Array.isArray(patch.profile_tag_ids)) flat.profile_tag_ids = patch.profile_tag_ids.map(String);
  // 换绑代理列表里的代理
  if (patch.proxy_id !== undefined && patch.proxy_config === undefined) {
    if (!patch.proxy_id) {
      flat.user_proxy_config = null;
      flat.proxy_id = null;
    } else {
      const preset = getProxy(patch.proxy_id);
      if (preset) flat.user_proxy_config = proxyConfigOf(preset);
    }
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

/**
 * 删除 = 进回收站（软删除）：只置删除标记，**不删 user-data 目录**。
 * 回收站里的环境必须是「恢复后能直接启动的原环境」，删盘就等于恢复出一个空壳，
 * 「回收站」三个字也就成了骗人。彻底清理是另一套语义（purge），这里不做。
 * @returns {string[]} 真的进了回收站的 id（已经在里面或不存在的不算）
 */
export function deleteProfiles(ids = []) {
  const db = getDb();
  const deleted = [];
  for (const id of ids) {
    if (dbDelete(db, id)) deleted.push(id);
  }
  return deleted;
}

/**
 * 归档（0.4.3 ③）：**移出主列表，但不是删除**。
 *
 * 和回收站的区别（CEO 明确要求分清，别把 `/recycle-bin/*` 复用成归档）：
 *   - 归档：`archived_at` 有值、`deleted_at` 仍为空 → 还能启动、能编辑，筛选「已归档」看得见，
 *     一条 cookie 一个字节都没动；
 *   - 回收站：`deleted_at` 有值 → 不在任何列表里，要从回收站恢复。
 *
 * 归档时间格式与 `deleteStamp` 一致（`YYYY-MM-DD HH:mm:ss`，Asia/Shanghai），
 * 这样按字符串排序就是按时间排序，界面不用再解析。
 * @returns {{archived:string[], skipped:{profile_id:string, reason:string}[]}}
 */
export function archiveProfiles(ids = []) {
  const db = getDb();
  const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const archived = [];
  const skipped = [];
  for (const id of ids) {
    const key = String(id);
    const row = db.prepare('SELECT archived_at, deleted_at FROM profiles WHERE id = ?').get(key);
    if (!row) { skipped.push({ profile_id: key, reason: 'not_found' }); continue; }
    // 回收站里的不能被「归档」：那会把两套语义混在一起（用户会以为归档等于删了）
    if (row.deleted_at) { skipped.push({ profile_id: key, reason: 'in_recycle_bin' }); continue; }
    if (row.archived_at) { skipped.push({ profile_id: key, reason: 'already_archived' }); continue; }
    db.prepare('UPDATE profiles SET archived_at = ?, updated_at = ? WHERE id = ?')
      .run(stamp, new Date().toISOString(), key);
    archived.push(key);
  }
  return { archived, skipped };
}

/**
 * 批量恢复（**从归档里恢复**，不是从回收站恢复 —— 那是 `/recycle-bin/restore`）。
 * @returns {{restored:string[], skipped:{profile_id:string, reason:string}[]}}
 */
export function unarchiveProfiles(ids = []) {
  const db = getDb();
  const restored = [];
  const skipped = [];
  for (const id of ids) {
    const key = String(id);
    const row = db.prepare('SELECT archived_at, deleted_at FROM profiles WHERE id = ?').get(key);
    if (!row) { skipped.push({ profile_id: key, reason: 'not_found' }); continue; }
    if (row.deleted_at) { skipped.push({ profile_id: key, reason: 'in_recycle_bin' }); continue; }
    if (!row.archived_at) { skipped.push({ profile_id: key, reason: 'not_archived' }); continue; }
    db.prepare('UPDATE profiles SET archived_at = NULL, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), key);
    restored.push(key);
  }
  return { restored, skipped };
}

/**
 * 回收站 item 的时间口径（照抄对手的可观测行为，2026-11-12 逆向 `22-回收站响应形状.md`）：
 *   - 空 → `""`
 *   - 数字 → `String(Math.trunc(n))`（**上游给毫秒不除 1000**，这里同样不动它）
 *   - 纯数字串 → 原样
 *   - `YYYY-MM-DD HH:mm:ss`（严格、写死 Asia/Shanghai）→ **秒级 unix 时间戳字符串**
 *   - 其它 → 原串
 * 我们库里存的就是第 4 种（见 repo.js 的 deleteStamp），所以正常的 delete_time 是 10 位数字串。
 */
export function deleteTimeOf(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(Math.trunc(value));
  const s = String(value).trim();
  if (!s) return '';
  if (/^\d+$/.test(s)) return s;
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (m) {
    const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`);
    if (Number.isFinite(ms)) return String(Math.trunc(ms / 1000));
  }
  return String(value);
}

/**
 * 回收站 item：**严格 6 字段子集**，对手是新建对象而不是 merge ——
 * 所以这里逐字段挑，绝不 `...profile` 展开（代理、指纹、标签、状态一个都不能带出来）。
 */
export function toRecycleBinItem(profile) {
  return {
    profile_id: profile.id,
    profile_no: profile.profile_no,
    name: profile.name ?? '',
    group_name: groupName(profile.group_id),
    remark: profile.remark ?? '',
    delete_time: deleteTimeOf(profile.deleted_at),
  };
}

/** 回收站列表：只给数据层结果，响应形状由路由层决定（`data = {list, page, limit}`）。
 *  `total` **不往上传**（2026-11-12 巡检）：对手这条路由的回包里没有它，多一个键就是形状不符；
 *  路由层另有一道显式枚举兜底，这里也从源头收掉，两处口径一致。 */
export function listRecycleBin({ page = 1, page_size = 50 } = {}) {
  const r = dbListDeleted(getDb(), { page, page_size });
  return { list: r.list.map(toRecycleBinItem), page: r.page, page_size: r.page_size };
}

/**
 * 在回收站里按 id 或 profile_no 找一个（恢复用）。
 * 注意不能拿 getProfile/getProfileByNo 顶替：那两个**故意**把已删项过滤掉了。
 */
export function getRecycledProfile({ profile_id: profileId = null, profile_no: profileNo = null } = {}) {
  const db = getDb();
  let row = null;
  if (profileId !== null && profileId !== undefined && String(profileId) !== '') {
    row = db.prepare('SELECT id FROM profiles WHERE id = ? AND deleted_at IS NOT NULL').get(String(profileId));
  } else {
    const n = Number(profileNo);
    if (Number.isFinite(n)) row = db.prepare('SELECT id FROM profiles WHERE profile_no = ? AND deleted_at IS NOT NULL').get(n);
  }
  return row ? dbGet(db, row.id, { includeDeleted: true }) : null;
}

/**
 * 从回收站恢复。id / profile_no 原样保留 —— 恢复出来的必须是同一个环境，
 * 否则脚本里存着的 profile_id、user-data 目录、绑过的代理对不上。
 * `groupId` 是上层契约的必填项（对手的 restore 要求显式选分组），路由层一定会传。
 * @returns {{id:string, restored:boolean}[]} 每个 id 的恢复结果（不在回收站里的 restored=false）
 */
export function restoreProfiles(ids = [], groupId) {
  const db = getDb();
  return ids.map((id) => ({ id, restored: dbRestore(db, id, groupId) }));
}

/**
 * 彻底清理（purge）：**只对回收站里的环境生效**，删记录 + 清勾选。
 * user-data 目录不在这里删 —— 那是文件系统的事，由路由层（它拿得到 userDataDirFor）做，
 * 这样 store 仍然只碰库，测试也不用为了删目录去起内核。
 *
 * 为什么不在「删除」那一步做：删除是软删除，回收站里的环境必须还能原样启动；
 * 真正不可逆的动作只能由用户显式点（回收站里的「彻底删除 / 清空」）。
 * @returns {{purged:string[], skipped:{profile_id:string, reason:string}[]}}
 */
export function purgeProfiles(ids = []) {
  const db = getDb();
  const purged = [];
  const skipped = [];
  for (const id of ids) {
    const key = String(id);
    // 只有回收站里的能彻底删：在用环境走 purge 就是绕过软删除的硬删，不给这个口子
    const row = db.prepare('SELECT 1 AS ok FROM profiles WHERE id = ? AND deleted_at IS NOT NULL').get(key);
    if (!row) { skipped.push({ profile_id: key, reason: 'not_in_recycle_bin' }); continue; }
    // profile_extensions 故意没有外键（见 schema 注释），所以这里必须显式清；
    // profile_tags 有 ON DELETE CASCADE，但删一次不费事，两边口径一致更不容易漏。
    db.prepare('DELETE FROM profile_extensions WHERE profile_id = ?').run(key);
    db.prepare('DELETE FROM profile_tags WHERE profile_id = ?').run(key);
    db.prepare('DELETE FROM profiles WHERE id = ?').run(key);
    purged.push(key);
  }
  return { purged, skipped };
}

export function regroupProfiles(ids = [], groupId = '0') {  const db = getDb();
  let changed = 0;
  for (const id of ids) {
    // 回收站里的环境不改分组：它现在不在任何列表里，改它等于给用户看一个「改成功了」的假象
    if (!db.prepare('SELECT 1 FROM profiles WHERE id = ? AND deleted_at IS NULL').get(id)) continue;
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

/**
 * 分组列表。`profile_count` 只数**在用的**环境（回收站里的不算）——
 * 界面上那个数字是给人看「这个组里有多少环境」的，把已删的算进去会误导。
 * 对手这条是 B 类透传（07- 号文 §181「自己设计返回即可」），多给一个计数不算破坏契约。
 */
export function listGroups() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT g.id AS group_id, g.name AS group_name, g.sort,
           (SELECT COUNT(*) FROM profiles p
             WHERE p.group_id = g.id AND p.deleted_at IS NULL) AS profile_count
      FROM groups g ORDER BY g.sort ASC, g.created_at ASC`).all();
  // 备注存在 meta 表（groups 表没这一列，见 updateGroup）；meta 表不存在就一律空串
  const hasMeta = !!db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  const remarks = new Map();
  if (hasMeta) {
    for (const r of db.prepare("SELECT key, value FROM meta WHERE key LIKE 'group_remark:%'").all()) {
      remarks.set(r.key.slice('group_remark:'.length), r.value);
    }
  }
  return rows.map((r) => ({ ...r, remark: remarks.get(String(r.group_id)) ?? '' }));
}

export function createGroup(groupNameStr) {
  const db = getDb();
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort), 0) AS n FROM groups').get().n;
  const id = String(maxSort + 1);
  db.prepare('INSERT INTO groups (id, name, sort, created_at) VALUES (?, ?, ?, ?)')
    .run(id, groupNameStr, maxSort + 1, new Date().toISOString());
  return { group_id: id, group_name: groupNameStr };
}

export function getGroup(groupId) {
  return getDb().prepare('SELECT id AS group_id, name AS group_name, sort FROM groups WHERE id = ?').get(String(groupId)) || null;
}

export function updateGroup({ group_id: groupId, group_name: groupName, remark } = {}) {
  const db = getDb();
  const cur = getGroup(groupId);
  if (!cur) return null;
  const name = groupName !== undefined ? String(groupName) : cur.group_name;
  // groups 表没有 remark 列：先放在 meta 里（对手这里 remark 可为 null）
  db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, String(groupId));
  if (remark !== undefined) {
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(`group_remark:${groupId}`, remark === null ? '' : String(remark));
  }
  return { group_id: String(groupId), group_name: name, remark: remark ?? null };
}

/**
 * 删分组：不允许删 Default(0)；组里的环境不删，统一挪回 Default。
 * 对手（云端）是先拦「组里有环境」，我们本地更实用：挪回默认组并如实返回数量。
 */
export function deleteGroup(groupId) {
  const db = getDb();
  const id = String(groupId);
  if (id === '0') return { ok: false, reason: 'default_group_protected' };
  const cur = getGroup(id);
  if (!cur) return { ok: false, reason: 'not_found' };
  // 回收站里的也算上一并挪走（否则恢复出来会挂在一个已经不存在的分组上）；
  // 但只把「在用」的那些计入 moved，返回值说的必须是人能看见的环境数。
  const alive = db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE group_id = ? AND deleted_at IS NULL').get(id).n;
  db.prepare('UPDATE profiles SET group_id = ? WHERE group_id = ?').run('0', id);
  db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  return { ok: true, moved: alive };
}

export function markStatus(profileId, status) {
  setStatus(getDb(), profileId, status);
}

/**
 * 记一次「这个环境真的启动过」（0.4.7 ④ 的事实源）。
 *
 * 为什么必须自己记：`last_launch_at` 这个列一直存在，但**从来没人写过**（0.4.6 之前是空列）。
 * 而「按天数删缓存」要判「多久没开过」，唯一可信的来源就是这个时间戳 ——
 * **不能拿文件 mtime 猜**：mtime 会被备份、复制、杀毒软件、解压工具改掉，删错就是不可逆的数据损失。
 *
 * 什么时候写：**内核真的起来、页面装配完之后**（不是"开始启动"就写）——
 * 启动失败的那次不该算「开过」，否则一个起不来的环境会永远删不掉。
 */
export function markLaunched(profileId, at = new Date()) {
  getDb().prepare('UPDATE profiles SET last_launch_at = ? WHERE id = ?').run(at.toISOString(), String(profileId));
}

/**
 * 「最后启动时间」的只读视图，给「按天数删缓存」用（0.4.7 ④）。
 *
 * 三类，**必须分开**，因为「判定不了」和「很久没开」是完全不同的结论：
 *   - `known`   ：有 `last_launch_at` 记录 → 用它算天数；
 *   - `unknown` ：没有记录（这一版之前创建/启动过的环境都是这种）→ **不删**，如实报「判定不了」；
 *   - `running` ：现在就在跑 → **不删**（不能删一个正在用的环境的数据）。
 *
 * @returns {{profile_id:string, profile_no:number, name:string, state:'known'|'unknown'|'running',
 *            last_launch_at:string|null, days:number|null, reason:string|null}}
 */
export function lastLaunchOf(profile, { now = new Date() } = {}) {
  const at = String(profile.last_launch_at || '').trim();
  const base = {
    profile_id: profile.id || profile.profile_id,
    profile_no: profile.profile_no ?? null,
    name: profile.name ?? '',
    last_launch_at: at || null,
  };
  if (String(profile.status || '') === 'running') {
    return { ...base, state: 'running', days: null, reason: '这个环境现在就在运行，不参与清理' };
  }
  if (!at) {
    return {
      ...base,
      state: 'unknown',
      days: null,
      reason: '没有「最后启动时间」的记录（这一版之前启动过的环境都没有），无法判定多久没开 —— 不删',
    };
  }
  const t = Date.parse(at);
  if (!Number.isFinite(t)) {
    return { ...base, state: 'unknown', days: null, reason: `「最后启动时间」不是合法时间（${at}），无法判定 —— 不删` };
  }
  const days = Math.floor((now.getTime() - t) / 86400000);
  return { ...base, state: 'known', days: Math.max(days, 0), reason: null };
}

/**
 * 启动前一致性校验。分两级（见 packages/profile/src/validate.js）：
 *   - 字段级错误（值域非法）+ 硬冲突 → 阻断
 *   - 软冲突（语言↔时区、核数↔内存、没绑代理…）→ 只告警
 * `force` 是显式覆盖开关：知道自己在做什么时可以越过硬冲突，但会记录到启动响应与日志。
 * @returns {{ok:boolean, errors:object[], hard:object[], soft:object[], warnings:object[], forced:boolean}}
 */
export function checkProfile(profile, { force = false } = {}) {
  const input = {};
  for (const f of BY_NAME.keys()) {
    if (profile[f] !== undefined && profile[f] !== null) input[f] = profile[f];
  }
  // 契约层是数组，字段表里是字符串列 —— 校验前先还原成存储形态
  if (Array.isArray(input.launch_args)) input.launch_args = JSON.stringify(input.launch_args);
  const res = validateProfile(input, { mode: 'update', fillDefaults: false });
  const hard = res.warnings.filter((w) => w.severity === 'hard');
  const soft = res.warnings.filter((w) => w.severity !== 'hard');
  const errors = [...res.errors, ...hard];
  return {
    ok: res.errors.length === 0 && (force || hard.length === 0),
    errors,
    hard,
    soft,
    warnings: res.warnings,
    forced: Boolean(force) && hard.length > 0,
  };
}

/** 直接按字段落库（UA 跟版、出口信息回写用），不走 API 的「运行中不许改」限制 */
export function applyProfileFields(profileId, patch = {}) {
  const res = dbUpdate(getDb(), profileId, patch);
  if (!res.ok) {
    throw new Error(res.errors.map((e) => `${e.field}: ${e.message}`).join('; ') || 'update failed');
  }
  return toApi(res.profile);
}

/** 把出口探测结果写回 ip / ip_country / ip_city / ip_region（字段表里本来就有这四个） */
export function persistEgress(profileId, egress = {}) {
  if (!egress || !egress.ok || !egress.ip) return null;
  const patch = { ip: String(egress.ip), ipchecker: 'freepower' };
  if (egress.countryCode) patch.ip_country = String(egress.countryCode).toUpperCase();
  if (egress.city) patch.ip_city = String(egress.city);
  if (egress.region) patch.ip_region = String(egress.region);
  try {
    return applyProfileFields(profileId, patch);
  } catch {
    return null;
  }
}