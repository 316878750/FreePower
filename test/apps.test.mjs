/**
 * 应用中心 / 扩展管理（0.4.3 ①）判据 —— A 层：不起内核，几百毫秒跑完。
 *
 * 拆解依据（`adspower-reverse/8.9.23/27b`）：**扩展文件全局共享一份**（按扩展 id 一个目录），
 * **启用状态是环境级的**。所以这里钉的是这几件事：
 *   1. 库与文件：导入目录/zip、同内容去重、manifest 解析（含 `__MSG_` 本地化名）、MV2 告警；
 *      落盘位置只能是 `<数据根>/ext_env/<id>/`，临时目录不残留。
 *   2. 关系：勾选是**全量替换**、不存在的 id 报错不静默丢、库级停用的不参与加载、目录缺了要如实报。
 *   3. 删除：关系一起清、目录真的删掉、**回收站里的环境勾选保留**（恢复后要能原样回来）。
 *   4. 路由：六条 `/api/v2/app/*` 的成功形状与错误码（错误码不返回 0，别假成功）。
 *   5. 复制环境：复制勾选、不复制文件（文件共享一份）。
 *   6. 代码约束（静态）：`--load-extension` 已从白名单挪到保护名单；
 *      扩展加载发生在 `injectAndOpen` **之前**（否则已开的页面没有 content script）。
 *
 * 真内核那一层（扩展真的装进浏览器、content script 真的跑起来）在 `test/apps-kernel.test.mjs`。
 *
 * 跑法：node --no-warnings test/apps.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(os.tmpdir(), `freepower-apps-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });

process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_RATE_LIMIT_MCP = '10000';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/* ------------------------------------------------------------------ */
/* 自造扩展目录与 zip（不依赖任何外部夹具）                            */
/* ------------------------------------------------------------------ */

const work = path.join(dataDir, '_src');
fs.mkdirSync(work, { recursive: true });

/** 写一个扩展目录：manifest + 可选 content script / locales */
function makeExt(name, { version = '1.0.0', msgName = null, mv = 3, extra = {} } = {}) {
  const dir = path.join(work, name);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    manifest_version: mv,
    name: msgName ? '__MSG_extName__' : name,
    version,
    description: `probe ${name}`,
  };
  if (msgName) {
    manifest.default_locale = 'en';
    fs.mkdirSync(path.join(dir, '_locales', 'en'), { recursive: true });
    fs.writeFileSync(path.join(dir, '_locales', 'en', 'messages.json'),
      JSON.stringify({ extName: { message: msgName } }));
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'sw.js'), 'self.__fp = 1;');
  for (const [rel, body] of Object.entries(extra)) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}

/** 手搓一个 store-only（不压缩）的 zip：只为走真实的 zip 导入路径，不引依赖 */
function makeZip(entries, outPath) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(data) >>> 0 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // method 0 = stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const cenBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  fs.writeFileSync(outPath, Buffer.concat([...parts, cenBuf, eocd]));
  return outPath;
}

/* ------------------------------------------------------------------ */

const ext = await import('../src/store/extensions.js');
const prof = await import('../src/store/profiles.js');
const transfer = await import('../src/store/transfer.js');
const { mergeLaunchArgs } = await import('../src/kernel/launch-args.js');
const { chromeIdFromPath } = await import('../src/kernel/extensions.js');
const { createApiServer } = await import('../src/api/server.js');
const { closeDb } = await import('../src/store/db.js');

const EXT_ROOT = path.join(dataDir, 'ext_env');
/** 共享目录里的扩展目录（排除导入过程中的 .import-* 临时目录） */
const extDirs = () => fs.readdirSync(EXT_ROOT).filter((n) => !n.startsWith('.'));

/* ============================ 1. 库与文件 ============================ */

console.log('\n— 1. 扩展库：导入 / 去重 / manifest 解析 —');

const dirA = makeExt('alpha', { version: '2.3.4', msgName: 'Alpha 本地化名' });
const r1 = ext.importExtension(dirA);
check('导入已解压目录：拿到 id / 版本 / 名字（名字由 _locales 解析）',
  r1.extension.id && r1.extension.version === '2.3.4' && r1.extension.name === 'Alpha 本地化名',
  JSON.stringify({ id: r1.extension.id, name: r1.extension.name, version: r1.extension.version }));
check('落盘在共享目录 <数据根>/ext_env/<id>/', r1.extension.path === `ext_env/${r1.extension.id}`
  && fs.existsSync(path.join(EXT_ROOT, r1.extension.id, 'manifest.json')), r1.extension.abs_path);
check('导入时按路径推算 Chrome 扩展 ID（UTF-16LE sha256 → a-p）',
  /^[a-p]{32}$/.test(r1.extension.unique_id || '')
  && r1.extension.unique_id === chromeIdFromPath(path.join(EXT_ROOT, r1.extension.id)),
  r1.extension.unique_id);
check('源目录没被搬走/改动（导入是复制，不是移动）', fs.existsSync(path.join(dirA, 'manifest.json')));

const r2 = ext.importExtension(dirA);
check('同样的内容再导一次：不重复占盘，回 duplicate',
  r2.duplicate === true && r2.extension.id === r1.extension.id && r2.warnings.length === 1,
  r2.warnings[0]);
check('去重后共享目录里只有一个副本、没有 .import-* 残留',
  extDirs().length === 1, extDirs().join(','));

const dirB = makeExt('beta', { version: '0.1.0' });
const r3 = ext.importExtension(dirB, { name: '我自己起的名字' });
check('导入时可以改显示名', r3.extension.name === '我自己起的名字');

const zipPath = makeZip({
  'gamma/manifest.json': JSON.stringify({ manifest_version: 3, name: 'Gamma', version: '9.9.9' }),
  'gamma/background.js': '// sw',
}, path.join(work, 'gamma.zip'));
const r4 = ext.importExtension(zipPath);
check('导入 zip（里面套了一层目录）：找到 manifest 根、解出文件',
  r4.extension.name === 'Gamma' && r4.extension.version === '9.9.9' && r4.extension.files === 2
  && fs.existsSync(path.join(EXT_ROOT, r4.extension.id, 'background.js')),
  `${r4.extension.files} 个文件`);
check('zip 导入后临时目录不残留',
  !fs.readdirSync(EXT_ROOT).some((n) => n.startsWith('.import-')), extDirs().join(','));

const dirMv2 = makeExt('legacy', { version: '1.2.3', mv: 2 });
const r5 = ext.importExtension(dirMv2);
check('Manifest V2 扩展能导入，但明确告警（Chrome 137 起不支持 MV2）',
  r5.extension.manifest_version === 2 && r5.warnings.some((w) => /Manifest V2/.test(w)),
  r5.warnings.join('|'));

function importError(p) {
  try { ext.importExtension(p); return null; } catch (e) { return e.message; }
}
check('路径不存在 → 明确报错', /路径不存在/.test(importError(path.join(work, 'nope')) || ''));
fs.mkdirSync(path.join(work, 'empty'), { recursive: true });
check('目录里没有 manifest.json → 明确报错（不猜）',
  /找不到 manifest\.json/.test(importError(path.join(work, 'empty')) || ''));
fs.mkdirSync(path.join(work, 'broken'), { recursive: true });
fs.writeFileSync(path.join(work, 'broken', 'manifest.json'), '{ oops');
check('manifest.json 坏 JSON → 报错带原文',
  /不是合法 JSON/.test(importError(path.join(work, 'broken')) || ''));
fs.writeFileSync(path.join(work, 'x.crx'), 'not a zip');
check('.crx 明确要求先解压（不假装能装）',
  /\.crx/.test(importError(path.join(work, 'x.crx')) || ''));
check('导入共享根目录本身 → 明确报错（里面每个子目录才是一个扩展）',
  /共享根目录/.test(importError(EXT_ROOT) || ''));

/* ============================ 2. 关系 ============================ */

console.log('\n— 2. 环境 ↔ 扩展：全量替换、停用不加载、缺失要报 —');

const pa = prof.createProfile({ name: 'env-a', group_id: '0' });
const pb = prof.createProfile({ name: 'env-b', group_id: '0' });

const idA = r1.extension.id;
const idB = r3.extension.id;
const idC = r5.extension.id;

check('勾选：全量替换（第二次只留一个）',
  JSON.stringify(ext.setProfileExtensions(pa.id, [idA, idB])) === JSON.stringify([idA, idB])
  && JSON.stringify(ext.setProfileExtensions(pa.id, [idA])) === JSON.stringify([idA]));
check('勾不存在的扩展 → 报错，不静默丢',
  /扩展不存在/.test((() => { try { ext.setProfileExtensions(pa.id, ['9999999']); return ''; } catch (e) { return e.message; } })()));
check('报错时原来的勾选没被清掉',
  JSON.stringify(ext.profileExtensionIds(pa.id)) === JSON.stringify([idA]));

const before = ext.extensionsForProfile(pa.id);
check('要加载的清单：只有勾了的、带绝对目录',
  before.extensions.length === 1 && before.extensions[0].dir === path.join(EXT_ROOT, idA),
  before.extensions[0]?.dir);

ext.updateExtension(idA, { status: '0' });
const disabled = ext.extensionsForProfile(pa.id);
check('库级停用 → 不参与加载（勾着也不加载）', disabled.extensions.length === 0
  && ext.profileExtensionIds(pa.id).length === 1, JSON.stringify(disabled));
const listed = ext.listExtensions().find((x) => x.id === idA);
check('列表里仍看得到它，状态是停用、被 1 个环境勾着',
  listed.status === '0' && listed.used_by === 1, JSON.stringify({ s: listed.status, u: listed.used_by }));
ext.updateExtension(idA, { status: '1' });

fs.rmSync(path.join(EXT_ROOT, idB), { recursive: true, force: true });
ext.setProfileExtensions(pb.id, [idB, idC]);
const withMissing = ext.extensionsForProfile(pb.id);
check('目录被删了 → 不静默少一个，进 missing 清单',
  withMissing.extensions.length === 1 && withMissing.missing.length === 1
  && withMissing.missing[0].id === idB, JSON.stringify(withMissing.missing));

/* ============================ 3. 复制 / 删除 / 回收站 ============================ */

console.log('\n— 3. 复制环境带勾选；删除扩展清关系清目录；回收站保留勾选 —');

const copied = transfer.copyProfile(pa.id, { name: 'env-a-copy' });
check('复制环境：勾选跟着复制（文件不复制）',
  JSON.stringify(ext.profileExtensionIds(copied.id)) === JSON.stringify(ext.profileExtensionIds(pa.id))
  && ext.profileExtensionIds(copied.id).length === 1,
  `copy=${JSON.stringify(ext.profileExtensionIds(copied.id))}`);

const delTarget = ext.importExtension(makeExt('delta')).extension;
ext.setProfileExtensions(pb.id, [delTarget.id]);
const del = ext.deleteExtensions([delTarget.id]);
check('删除扩展：关系一起清（pb 的勾选里没它了）',
  del.deleted.length === 1 && del.skipped.length === 0
  && !ext.profileExtensionIds(pb.id).includes(delTarget.id), JSON.stringify(del));
check('删除扩展：目录真的从盘上没了', !fs.existsSync(path.join(EXT_ROOT, delTarget.id)));
check('删除不存在的扩展：报 skipped 而不是假装成功',
  ext.deleteExtensions(['9999999']).skipped.length === 1);

prof.deleteProfiles([pa.id]);
check('环境进回收站后勾选保留（恢复回来要能原样加载）',
  ext.profileExtensionIds(pa.id).length === 1 && !prof.getProfile(pa.id), '');
prof.restoreProfiles([pa.id], '0');
check('从回收站恢复后勾选还在', ext.profileExtensionIds(pa.id).length === 1);

/* ============================ 4. 路由 ============================ */

console.log('\n— 4. 路由 /api/v2/app/* —');

const { server, apiKey } = createApiServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function api(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', 'api-key': apiKey, 'x-freepower-client': 'mcp' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 纯文本 */ }
  return { status: res.status, json };
}

try {
  const list = await api('POST', '/api/v2/app/list', {});
  check('app/list：data.list 是数组、带 used_by', list.json?.code === 0 && Array.isArray(list.json.data.list)
    && typeof list.json.data.list[0]?.used_by === 'number', `共 ${list.json?.data?.list?.length} 个`);

  const imported = await api('POST', '/api/v2/app/import', { path: makeExt('epsilon', { version: '5.5.5' }) });
  check('app/import：code=0、回 id 与 duplicate=false',
    imported.json?.code === 0 && imported.json.data.duplicate === false && imported.json.data.version === '5.5.5',
    JSON.stringify({ c: imported.json?.code, id: imported.json?.data?.id }));
  const importedId = imported.json.data.id;

  const badImport = await api('POST', '/api/v2/app/import', { path: path.join(work, 'nope') });
  check('app/import 失败：code=100002 且带原因（不静默成功）',
    badImport.json?.code === 100002 && /路径不存在/.test(badImport.json.msg), badImport.json?.msg);
  const noPath = await api('POST', '/api/v2/app/import', {});
  check('app/import 没给路径：100002', noPath.json?.code === 100002, noPath.json?.msg);

  const upd = await api('POST', '/api/v2/app/update', { id: importedId, status: '0' });
  check('app/update：改成停用', upd.json?.code === 0 && upd.json.data.status === '0');
  const updBad = await api('POST', '/api/v2/app/update', { id: '9999999', status: '0' });
  check('app/update 不存在的 id：100001（找不到，不是乱报 -1）',
    updBad.json?.code === 100001, JSON.stringify(updBad.json));
  await api('POST', '/api/v2/app/update', { id: importedId, status: '1' });

  const set = await api('POST', '/api/v2/app/profile/set', { profile_id: pb.id, ext_ids: [importedId, idC] });
  check('app/profile/set：回写入后的清单，没在跑时 restart_required=false',
    set.json?.code === 0 && set.json.data.ext_ids.length === 2 && set.json.data.restart_required === false,
    JSON.stringify(set.json?.data));
  const setBad = await api('POST', '/api/v2/app/profile/set', { profile_id: pb.id, ext_ids: ['9999999'] });
  check('app/profile/set 写了不存在的扩展：100002 报扩展不存在',
    setBad.json?.code === 100002 && /扩展不存在/.test(setBad.json.msg), setBad.json?.msg);

  /**
   * 全量替换语义的坑：字段名拼错/没给时绝不能当成「清空」。
   * 早先这里取到 undefined → 空数组 → 勾选被无声清光还回 code=0。
   */
  const keep = await api('POST', '/api/v2/app/profile', { profile_id: pb.id });
  const keepIds = keep.json?.data?.ext_ids || [];
  const typo = await api('POST', '/api/v2/app/profile/set', { profile_id: pb.id, extension_ids: [importedId] });
  check('app/profile/set 字段名拼错（extension_ids）：code 非 0，不当成清空',
    typo.json?.code !== 0 && typo.json.code === 100002 && typo.json.data?.field === 'ext_ids',
    JSON.stringify({ c: typo.json?.code, field: typo.json?.data?.field, msg: typo.json?.msg }));
  const afterTypo = await api('POST', '/api/v2/app/profile', { profile_id: pb.id });
  check('app/profile/set 拼错字段后：库里勾选一条不少（没被静默清空）',
    JSON.stringify(afterTypo.json?.data?.ext_ids) === JSON.stringify(keepIds),
    JSON.stringify({ before: keepIds, after: afterTypo.json?.data?.ext_ids }));

  const noField = await api('POST', '/api/v2/app/profile/set', { profile_id: pb.id });
  check('app/profile/set 一个字段都没给：100002 且 field=ext_ids',
    noField.json?.code === 100002 && noField.json.data?.field === 'ext_ids', JSON.stringify(noField.json));
  const afterNone = await api('POST', '/api/v2/app/profile', { profile_id: pb.id });
  check('app/profile/set 缺字段后：勾选仍在', JSON.stringify(afterNone.json?.data?.ext_ids) === JSON.stringify(keepIds));

  const explicitClear = await api('POST', '/api/v2/app/profile/set', { profile_id: pb.id, ext_ids: [] });
  check('app/profile/set 显式传 []：才真的清空',
    explicitClear.json?.code === 0 && explicitClear.json.data.ext_ids.length === 0,
    JSON.stringify(explicitClear.json?.data));
  const afterClear = await api('POST', '/api/v2/app/profile', { profile_id: pb.id });
  check('app/profile/set 显式清空后：读回确实是空的', afterClear.json?.data?.ext_ids?.length === 0);
  // 复位，后面的断言（页面/启动）还指望 pb 勾着东西
  await api('POST', '/api/v2/app/profile/set', { profile_id: pb.id, ext_ids: keepIds });

  const one = await api('POST', '/api/v2/app/profile', { profile_id: pb.id });
  check('app/profile：回这个环境勾的扩展（含 enabled 标记）',
    one.json?.code === 0 && one.json.data.list.length === 2
    && one.json.data.list.every((x) => typeof x.enabled === 'boolean'),
    JSON.stringify(one.json?.data?.ext_ids));
  const oneMissing = await api('POST', '/api/v2/app/profile', { profile_id: 'nope' });
  check('app/profile 环境不存在：100001', oneMissing.json?.code === 100001, JSON.stringify(oneMissing.json));

  const delRoute = await api('POST', '/api/v2/app/delete', { ids: [importedId] });
  check('app/delete：回 deleted + running_affected（正在跑的环境要到重启才真没）',
    delRoute.json?.code === 0 && delRoute.json.data.deleted.length === 1
    && Array.isArray(delRoute.json.data.running_affected), JSON.stringify(delRoute.json?.data));
  const delNoIds = await api('POST', '/api/v2/app/delete', {});
  check('app/delete 没给 ids：100002', delNoIds.json?.code === 100002, delNoIds.json?.msg);

  const info = await api('GET', '/api/v2/api/info');
  const paths = new Set((info.json?.data?.endpoints || []).map((e) => e.path || e));
  check('API & MCP 页的端点清单里出现 app/*（新路由自动登记）',
    ['/api/v2/app/list', '/api/v2/app/import', '/api/v2/app/delete'].every((p) => paths.has(p)),
    [...paths].filter((p) => String(p).includes('/app/')).join(','));
} finally {
  await new Promise((r) => server.close(r));
}

/* ============================ 5. 静态约束 ============================ */

console.log('\n— 5. 代码约束（静态） —');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

check('--load-extension 从白名单挪到保护名单（157 上已失效，不许再假装生效）',
  /PROTECTED[\s\S]*'--load-extension'/.test(read('src/kernel/launch-args.js'))
  && !/WHITELIST[\s\S]{0,600}\['--load-extension'/.test(read('src/kernel/launch-args.js')));
const rejected = mergeLaunchArgs(['--x'], ['--load-extension=C:\\x'], {});
check('用户写 --load-extension 时被拒绝、并指向应用中心',
  rejected.applied.length === 0 && /应用中心/.test(rejected.rejected[0].reason));

const mgr = read('src/runtime/manager.js');
check('启动流程：先按环境取扩展 → 加载 → 再 injectAndOpen（顺序反了页面就没有 content script）',
  mgr.indexOf('loadUnpackedExtensions(client') > 0
  && mgr.indexOf('loadUnpackedExtensions(client') < mgr.indexOf('await injectAndOpen(instance'));

check('页面：侧栏有「应用中心」入口、路由注册了 /apps',
  /data-nav="apps"/.test(read('web/index.html'))
  && /nav: 'apps'/.test(read('web/app.js'))
  && /import appsPage/.test(read('web/app.js')));
check('页面：环境编辑页能勾扩展（调 app/profile/set）',
  /appSetForProfile/.test(read('web/pages/edit.js')));
check('页面：应用中心页说明收的是本机路径（不假装能上传）',
  /本机路径/.test(read('web/pages/apps.js')));
check('产品代码不调 Win32 / 不引原生依赖（这条一直是我们自己的约束）',
  !/user32|SetForegroundWindow|koffi/.test(read('src/store/extensions.js') + read('src/kernel/extensions.js')));

/* ============================ 汇总 ============================ */

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass} PASS / ${fail} FAIL`);
closeDb();
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* SQLite 句柄还没放，临时目录留给系统清 */ }
process.exit(fail ? 1 : 0);
