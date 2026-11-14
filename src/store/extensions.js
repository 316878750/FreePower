/**
 * 应用中心 · 扩展库（本地仓储 + 文件布局）。
 *
 * 拆解结论（`adspower-reverse/8.9.23/27b`）说清了两件事，这里照着做：
 *   1. **扩展文件全局共享一份**，按扩展 id 一个目录：`<数据根>/ext_env/<id>/`。
 *      不给每个环境复制副本（对手 8.9.23 也不是每环境一份，磁盘和启动速度都受不了）。
 *   2. **启用状态是环境级的**：共享的是文件，不是「开没开」。哪个环境用哪些扩展落在
 *      `profile_extensions`（显式勾选）。对手那个 `sysAppCateId==="0" → 库内 status=1 全加载」
 *      的隐式语义**不实现**：勾了才加载，没勾就不加载，界面上看得见。
 *
 * 和对手不一样的地方（如实写在这，别让后来人以为是漏了）：
 *   - 对手的扩展是**云端应用商店**下载的；FreePower 不转发别人的分发，
 *     只支持**本地导入**（已解压的目录，或 zip 包）。
 *   - 对手把 `ext_env/record` 当索引文件（单行 JSON）。我们**不写这个文件** ——
 *     DB 已经是唯一事实源，再写一份只会两边不一致（27b §5.3 就卡在「谁是权威」上）。
 *   - 对手靠 `Secure Preferences` 的 `.extensions.settings[<id>].path` 指向共享目录来加载；
 *     我们这条路在 Chrome 157 上已经不通（见 `src/kernel/extensions.js` 顶部实测记录）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../config.js';
import { getDb } from './db.js';
import { extractZipFile } from '../kernel/zip.js';
import { chromeIdFromPath } from '../kernel/extensions.js';

/** 共享目录根：一个扩展一个子目录，**所有环境共用** */
export const EXT_ROOT = path.join(DATA_DIR, 'ext_env');

/** 导入上限：扩展包再大也不该是这个量级，挡住误导入整个磁盘/zip 炸弹 */
const MAX_FILES = 5000;
const MAX_BYTES = 200 * 1024 * 1024;

const ID_START = 1000001;

function now() {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ */
/* manifest.json：只读我们真用得上的字段，解析不出来就明确报错         */
/* ------------------------------------------------------------------ */

/** `__MSG_appName__` → `_locales/<default_locale>/messages.json` 里的真名（解析不出就保留原文） */
function resolveMsg(raw, manifest, dir) {
  const s = String(raw ?? '').trim();
  const m = /^__MSG_(.+)__$/.exec(s);
  if (!m) return s;
  const key = m[1];
  const locales = [manifest.default_locale, 'en', 'en_US', 'zh_CN', 'zh'].filter(Boolean);
  for (const loc of locales) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, '_locales', loc, 'messages.json'), 'utf8'));
      const hit = j[key]
        || j[key.toLowerCase()]
        || (Object.entries(j).find(([k]) => k.toLowerCase() === key.toLowerCase()) || [])[1];
      if (hit && typeof hit.message === 'string' && hit.message.trim()) return hit.message.trim();
    } catch { /* 这个 locale 没有就试下一个 */ }
  }
  // 解不出来就保留 `__MSG_x__` 原文 —— 编一个名字出来比显示原文更糟
  return s;
}

/**
 * 读扩展目录的 manifest。**只接受 manifest.json 就在这个目录根上**：
 * Chrome 加载的就是这个路径，manifest 在子目录里等于加载失败，导入时就要拦住。
 */
export function readManifest(dir) {
  const file = path.join(dir, 'manifest.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error('这个目录里没有 manifest.json（要导入的是**已解压**的扩展目录，不是外层套文件夹的目录）');
  }
  let m;
  try {
    m = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new Error(`manifest.json 不是合法 JSON：${e.message}`);
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('manifest.json 不是一个 JSON 对象');
  const mv = Number(m.manifest_version);
  if (mv !== 2 && mv !== 3) throw new Error(`manifest_version=${m.manifest_version} 不认识（只支持 2 / 3）`);
  const name = resolveMsg(m.name, m, dir);
  if (!name) throw new Error('manifest.json 里没有 name');
  const version = String(m.version ?? '').trim();
  if (!version) throw new Error('manifest.json 里没有 version');
  return {
    manifest_version: mv,
    name,
    version,
    description: resolveMsg(m.description, m, dir) || '',
    key: typeof m.key === 'string' && m.key ? m.key : null,
  };
}

/* ------------------------------------------------------------------ */
/* 内容指纹：导入去重、判断「是不是同一个扩展的同一版」                 */
/* ------------------------------------------------------------------ */

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 递归列出相对路径（正斜杠、排序）。符号链接跳过：不许借导入把文件带出目录 */
function listFiles(dir) {
  const out = [];
  const walk = (cur) => {
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile()) out.push(path.relative(dir, abs).split(path.sep).join('/'));
    }
  };
  walk(dir);
  out.sort();
  return out;
}

/** 目录内容指纹：`<相对路径>\0<文件 sha256>` 逐行排序后再 sha256 */
export function contentHash(dir) {
  const files = listFiles(dir);
  if (files.length > MAX_FILES) throw new Error(`扩展目录里文件太多（${files.length} > ${MAX_FILES}）`);
  const h = crypto.createHash('sha256');
  let bytes = 0;
  for (const rel of files) {
    const abs = path.join(dir, rel.split('/').join(path.sep));
    const size = fs.statSync(abs).size;
    bytes += size;
    if (bytes > MAX_BYTES) throw new Error(`扩展太大（超过 ${Math.round(MAX_BYTES / 1024 / 1024)} MB）`);
    h.update(`${rel}\0${sha256File(abs)}\n`);
  }
  return { sha256: h.digest('hex'), files: files.length, bytes };
}

/* ------------------------------------------------------------------ */
/* 目录/zip 的搬运                                                     */
/* ------------------------------------------------------------------ */

function assertInsideRoot(p) {
  const root = path.resolve(EXT_ROOT);
  const target = path.resolve(p);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`拒绝在共享目录外写扩展文件：${target}`);
  }
  return target;
}

/** 复制已解压目录（跳过符号链接，不跟随） */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) copyDir(from, to);
    else if (ent.isFile()) fs.copyFileSync(from, to);
  }
}

/**
 * 找 manifest 根：用户手上常见「外层文件夹套着扩展目录」，所以允许**恰好一层**向下找，
 * 不无限递归猜 —— 猜错就会把一个不相干的目录当扩展加载。
 */
function findManifestRoot(dir) {
  if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
  const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const hits = subs.filter((e) => fs.existsSync(path.join(dir, e.name, 'manifest.json')));
  if (hits.length === 1) return path.join(dir, hits[0].name);
  if (hits.length > 1) throw new Error(`这里能找到 ${hits.length} 个扩展（多个 manifest.json），一次只导一个`);
  throw new Error('找不到 manifest.json：要导入的是**已解压**的扩展目录（目录里有 manifest.json），或者扩展的 zip 包');
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 删不掉就算了，下次覆盖 */ }
}

/* ------------------------------------------------------------------ */
/* 对外形状                                                           */
/* ------------------------------------------------------------------ */

function toApi(row, { usedBy = null } = {}) {
  if (!row) return null;
  return {
    id: String(row.id),
    // 只有真加载过（CDP 报回来的）才有值 —— 我们**不猜**扩展 ID
    unique_id: row.unique_id || null,
    name: row.name,
    version: row.version || '',
    description: row.description || '',
    manifest_version: row.manifest_version ?? null,
    status: row.status === '0' ? '0' : '1',
    path: row.path,
    abs_path: path.join(DATA_DIR, row.path.split('/').join(path.sep)),
    source: row.source || null,
    files: row.files ?? null,
    bytes: row.bytes ?? null,
    sha256: row.sha256 || null,
    used_by: usedBy === null ? undefined : usedBy,
    created_at: row.created_at,
    updated_at: row.updated_at || null,
  };
}

/* ------------------------------------------------------------------ */
/* 读                                                                 */
/* ------------------------------------------------------------------ */

export function listExtensions() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM extensions ORDER BY CAST(id AS INTEGER) ASC').all();
  const counts = new Map(
    db.prepare('SELECT ext_id, COUNT(*) AS n FROM profile_extensions GROUP BY ext_id').all()
      .map((r) => [String(r.ext_id), Number(r.n)]),
  );
  return rows.map((r) => toApi(r, { usedBy: counts.get(String(r.id)) || 0 }));
}

export function getExtension(id) {
  const row = getDb().prepare('SELECT * FROM extensions WHERE id = ?').get(String(id));
  return row ? toApi(row) : null;
}

/** 库里的原始行（内部用：启动时拼加载清单） */
export function getExtensionRow(id) {
  return getDb().prepare('SELECT * FROM extensions WHERE id = ?').get(String(id)) || null;
}

/** 某个环境勾选了的扩展（含库级停用的 —— 停用的照样回，但 `enabled=false`） */
export function profileExtensionRows(profileId) {
  return getDb().prepare(
    `SELECT e.*, pe.created_at AS linked_at
       FROM profile_extensions pe JOIN extensions e ON e.id = pe.ext_id
      WHERE pe.profile_id = ?
      ORDER BY CAST(e.id AS INTEGER) ASC`,
  ).all(String(profileId));
}

/** 某个环境**真要加载**的扩展：库级启用 + 目录还在。返回 {rows, missing} */
export function extensionsForProfile(profileId) {
  const rows = profileExtensionRows(profileId);
  const usable = [];
  const missing = [];
  for (const row of rows) {
    if (row.status === '0') continue;
    const dir = path.join(DATA_DIR, row.path.split('/').join(path.sep));
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
      // 目录被人删了/搬走了：如实报，别让它静默少一个扩展（对手也是 isExists 后才纳入）
      missing.push({ id: String(row.id), name: row.name, path: row.path });
      continue;
    }
    usable.push({ id: String(row.id), name: row.name, version: row.version, dir, unique_id: row.unique_id || null });
  }
  return { extensions: usable, missing };
}

export function profileExtensionIds(profileId) {
  return getDb().prepare('SELECT ext_id FROM profile_extensions WHERE profile_id = ? ORDER BY ext_id')
    .all(String(profileId)).map((r) => String(r.ext_id));
}

/** 某个环境勾选的扩展（对外形状；`enabled` = 库级开关，勾了但库级停用则该环境也不加载） */
export function profileExtensions(profileId) {
  return profileExtensionRows(profileId).map((r) => ({ ...toApi(r), enabled: r.status !== '0' }));
}

/* ------------------------------------------------------------------ */
/* 导入                                                               */
/* ------------------------------------------------------------------ */

function nextId(db) {
  const r = db.prepare('SELECT MAX(CAST(id AS INTEGER)) AS m FROM extensions').get();
  const max = r && r.m != null ? Number(r.m) : 0;
  return String(Math.max(ID_START, max + 1));
}

/**
 * 导入一个扩展。`sourcePath` 是**本机路径**：已解压的目录，或一个 .zip。
 *
 * 为什么用路径而不是上传：本地 API 的 body 上限是 2 MB 且只吃 JSON，
 * 传二进制要另做 multipart —— 这个产品本来就是本机程序，用户手里的扩展也在本机，
 * 直接给路径更短、更可核对（界面上会把最终落盘路径回显出来）。
 *
 * @returns {{extension:object, duplicate:boolean, warnings:string[]}}
 */
export function importExtension(sourcePath, { name = '', status = '1' } = {}) {
  const src = String(sourcePath ?? '').trim();
  if (!src) throw new Error('要导入的路径不能为空');
  let stat;
  try {
    stat = fs.statSync(src);
  } catch {
    throw new Error(`路径不存在：${src}`);
  }

  fs.mkdirSync(EXT_ROOT, { recursive: true });
  const warnings = [];
  const tmp = assertInsideRoot(path.join(EXT_ROOT, `.import-${crypto.randomBytes(6).toString('hex')}`));
  let workDir = tmp;

  try {
    if (stat.isDirectory()) {
      const real = fs.realpathSync(src);
      // 从共享目录里再导一次 = 复制到自己的临时目录，允许（但多半是用户点错了）
      if (path.resolve(real) === path.resolve(EXT_ROOT)) throw new Error('这个目录是扩展共享根目录，里面每个子目录才是一个扩展');
      // 用户手上常是「外层文件夹套着扩展目录」，下钻一层是确定性规则，且会如实告警
      const rootSrc = findManifestRoot(real);
      if (path.resolve(rootSrc) !== path.resolve(real)) {
        warnings.push(`选的目录里扩展在子目录「${path.basename(rootSrc)}」，已按它导入`);
      }
      copyDir(rootSrc, tmp);
    } else if (stat.isFile()) {
      if (!/\.(zip|crx)$/i.test(src)) throw new Error('只支持 .zip 扩展包或已解压的目录（.crx 请先解压）');
      if (/\.crx$/i.test(src)) throw new Error('.crx 是 Chrome 的签名包，请先解压成目录再导入');
      fs.mkdirSync(tmp, { recursive: true });
      extractZipFile(src, tmp, { maxBytes: MAX_BYTES });
      workDir = findManifestRoot(tmp);
    } else {
      throw new Error('这个路径既不是文件也不是目录');
    }

    const manifest = readManifest(workDir);
    const digest = contentHash(workDir);

    const db = getDb();
    // 同样的内容已经在库里 → 不重复占盘，直接把已有的那条回给用户
    const same = db.prepare('SELECT * FROM extensions WHERE sha256 = ?').get(digest.sha256);
    if (same) {
      // 已经复制出来的临时目录要清掉：否则「导同一个包 10 次」就在盘上留 10 份垃圾
      rmrf(tmp);
      return {
        extension: toApi(same),
        duplicate: true,
        warnings: [`库里已经有内容完全相同的扩展（id=${same.id}，${same.name} ${same.version}），没有重复导入`],
      };
    }

    const id = nextId(db);
    const finalDir = assertInsideRoot(path.join(EXT_ROOT, id));
    fs.renameSync(workDir, finalDir);
    if (workDir !== tmp) rmrf(tmp); // zip 套了一层目录时，把外层空壳清掉

    // 目录名就是 id：Chrome 的 unpacked 扩展 ID 由**加载路径**派生，路径一变 ID 就变，
    // 所以这个目录一经创建就不许改名（见 docs/15 的实测记录）。
    const relPath = `ext_env/${id}`;
    const row = {
      id,
      // 按最终落盘路径算出来（不是按用户给的源路径）—— 算法已用 CDP 真值对过
      unique_id: chromeIdFromPath(finalDir),
      name: name && String(name).trim() ? String(name).trim() : manifest.name,
      version: manifest.version,
      description: manifest.description,
      manifest_version: manifest.manifest_version,
      path: relPath,
      status: status === '0' ? '0' : '1',
      source: stat.isDirectory() ? 'dir' : 'zip',
      files: digest.files,
      bytes: digest.bytes,
      sha256: digest.sha256,
      created_at: now(),
      updated_at: null,
    };
    db.prepare(
      `INSERT INTO extensions
         (id, unique_id, name, version, description, manifest_version, path, status, source, files, bytes, sha256, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.unique_id, row.name, row.version, row.description, row.manifest_version,
      row.path, row.status, row.source, row.files, row.bytes, row.sha256, row.created_at, row.updated_at);

    if (manifest.manifest_version === 2) {
      warnings.push('这是 Manifest V2 扩展：Chrome 137 起已不再支持 MV2，加载时可能被内核直接拒绝');
    }
    return { extension: toApi(row), duplicate: false, warnings };
  } catch (e) {
    rmrf(tmp);
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 改 / 删                                                            */
/* ------------------------------------------------------------------ */

export function updateExtension(id, { status, name } = {}) {
  const db = getDb();
  const row = getExtensionRow(id);
  if (!row) return null;
  const sets = [];
  const vals = [];
  if (status !== undefined) {
    const s = String(status) === '0' ? '0' : '1';
    sets.push('status = ?');
    vals.push(s);
  }
  if (name !== undefined) {
    const n = String(name ?? '').trim();
    if (!n) throw new Error('扩展名不能为空');
    sets.push('name = ?');
    vals.push(n);
  }
  if (!sets.length) return toApi(row);
  sets.push('updated_at = ?');
  vals.push(now());
  db.prepare(`UPDATE extensions SET ${sets.join(', ')} WHERE id = ?`).run(...vals, String(id));
  return getExtension(id);
}

/** 记录首次加载时 CDP 报回来的真实扩展 ID（我们不推算，只记录观察值） */
export function rememberUniqueId(id, uniqueId) {
  const v = String(uniqueId ?? '').trim();
  if (!/^[a-p]{32}$/.test(v)) return false;
  const db = getDb();
  const row = getExtensionRow(id);
  if (!row || row.unique_id === v) return false;
  db.prepare('UPDATE extensions SET unique_id = ?, updated_at = ? WHERE id = ?').run(v, now(), String(id));
  return true;
}

/**
 * 删扩展：先删关系，再删目录，最后删行。
 * 目录删除前**再核一遍**它确实在共享根下 —— 这是唯一一处会递归删文件的地方。
 */
export function deleteExtensions(ids) {
  const db = getDb();
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
  const deleted = [];
  const skipped = [];
  for (const id of list) {
    const row = getExtensionRow(id);
    if (!row) { skipped.push({ id, reason: 'not_found' }); continue; }
    const dir = assertInsideRoot(path.join(DATA_DIR, row.path.split('/').join(path.sep)));
    db.prepare('DELETE FROM profile_extensions WHERE ext_id = ?').run(id);
    db.prepare('DELETE FROM extensions WHERE id = ?').run(id);
    rmrf(dir);
    deleted.push(id);
  }
  return { deleted, skipped };
}

/* ------------------------------------------------------------------ */
/* 环境 ↔ 扩展                                                        */
/* ------------------------------------------------------------------ */

/**
 * 设置某个环境启用的扩展（**全量替换**，跟界面上勾选框的语义一致）。
 * 不存在的 id 直接报错，不静默丢 —— 否则用户以为勾上了。
 */
export function setProfileExtensions(profileId, extIds) {
  const db = getDb();
  const ids = [...new Set((Array.isArray(extIds) ? extIds : [extIds]).map(String).filter(Boolean))];
  for (const id of ids) {
    if (!getExtensionRow(id)) throw new Error(`扩展不存在：${id}`);
  }
  db.prepare('DELETE FROM profile_extensions WHERE profile_id = ?').run(String(profileId));
  const at = now();
  for (const id of ids) {
    db.prepare('INSERT OR REPLACE INTO profile_extensions (profile_id, ext_id, created_at) VALUES (?, ?, ?)')
      .run(String(profileId), id, at);
  }
  return profileExtensionIds(profileId);
}

/**
 * 环境删掉时**不清勾选**：删除是软删除（进回收站），恢复回来的环境必须连扩展勾选一起回来，
 * 否则「回收站恢复」就成了恢复出一个没扩展的壳。等真做了彻底清理（purge）再来清这里。
 */
