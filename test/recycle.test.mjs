/**
 * 回收站（第一批 ②）判据 —— 数据层语义 + 两条路由的响应形状。
 *
 * 形状来源：逆向 `22-回收站响应形状.md`（2026-11-12）。
 * 判据分四段：
 *   1. 迁移：用**改造前的 DDL**（把 `deleted_at` 两行摘掉）造一个 0.3.2 形状的库 + 3 条环境，
 *      跑真迁移后：列补上了、3 条一条不少、全部算「在用」。老库平滑升级是这一段的唯一目的。
 *   2. 删除 = 进回收站：只置标记，**user-data 目录留在盘上**（恢复后要能直接启动）；
 *      `list`（v1/v2）不再出现、`detail`/`start`/`update` 一律 100001、重复删除不重复计数。
 *   3. `recycle-bin/list`：`data = {list, page, limit}`（**没有 total**），item **严格 6 字段**。
 *   4. `recycle-bin/restore`：`profile_id`/`profile_no` 单个 + `group_id` 必填，五条错误文案逐字；
 *      恢复后 id/profile_no/指纹不变；重启（**真起一个新进程读库**）状态保持。
 *
 * 跑法：node --no-warnings test/recycle.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, '.tmp', 'recycle-data');
const MIG = path.join(ROOT, '.tmp', 'recycle-migrate');
for (const d of [DATA, MIG]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(MIG, { recursive: true });

process.env.FREEPOWER_DATA = DATA;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
process.env.FREEPOWER_EGRESS_TIMEOUT = '1000';
process.env.FREEPOWER_RATE_LIMIT_MCP = '10000';

const configUrl = pathToFileURL(path.join(ROOT, 'src/config.js')).href;
const dbUrl = pathToFileURL(path.join(ROOT, 'src/store/db.js')).href;
const schemaPath = path.join(ROOT, 'packages/profile/src/schema.sql');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/** 子进程：真起一次 node，用同一份代码打开同一个库 —— 这就是「重启后还在」的证据 */
function runChild(dataDir, script) {
  const out = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
    env: { ...process.env, FREEPOWER_DATA: dataDir },
    encoding: 'utf8',
  });
  const lines = out.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

/* ============================ 1. 迁移 ============================ */

const MIGRATE_SCRIPT = `
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const { DB_PATH } = await import(${JSON.stringify(configUrl)});
const schema = fs.readFileSync(${JSON.stringify(schemaPath)}, 'utf8');
// 还原「改造前」的 DDL：把软删除那一列与它的索引摘掉，剩下的就是 0.3.2 的库形状
const legacy = schema.split(/\\r?\\n/).filter((l) => !l.includes('"deleted_at" TEXT') && !l.includes('idx_profiles_deleted')).join('\\n');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const pre = new DatabaseSync(DB_PATH);
pre.exec(legacy);
const ins = pre.prepare('INSERT INTO profiles (id, profile_no, name, group_id, status, ua, fingerprint_config, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
for (let i = 1; i <= 3; i++) ins.run('legacy-' + i, 10000 + i, 'legacy-' + i, '0', 'idle', 'UA-legacy-' + i, '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
pre.close();
// 真迁移：getDb() 里跑 migrate()
const { getDb } = await import(${JSON.stringify(dbUrl)});
const db = getDb();
const cols = db.prepare('PRAGMA table_info(profiles)').all().map((c) => c.name);
const rows = db.prepare('SELECT id, profile_no, name, ua, deleted_at FROM profiles ORDER BY profile_no').all();
console.log(JSON.stringify({ cols, rows }));
`;

const READ_SCRIPT = `
const { getDb } = await import(${JSON.stringify(dbUrl)});
const db = getDb();
console.log(JSON.stringify(db.prepare('SELECT id, profile_no, deleted_at FROM profiles ORDER BY profile_no').all()));
`;

const mig = runChild(MIG, MIGRATE_SCRIPT);
check('迁移：老库（无 deleted_at）补上了该列', mig.cols.includes('deleted_at'), `deleted_at=${mig.cols.includes('deleted_at')}`);
check('迁移：3 条老环境一条不少、字段原样', mig.rows.length === 3 && mig.rows[1].name === 'legacy-2' && mig.rows[1].ua === 'UA-legacy-2', JSON.stringify(mig.rows.map((r) => r.id)));
check('迁移：老数据全部算「在用」（deleted_at 为 NULL）', mig.rows.every((r) => r.deleted_at === null), JSON.stringify(mig.rows.map((r) => r.deleted_at)));
check('迁移：profile_no 没被重排', mig.rows.map((r) => r.profile_no).join(',') === '10001,10002,10003', mig.rows.map((r) => r.profile_no).join(','));
// 幂等：同一个库再开一次（= 应用又启动了一次），不能报错、不能重复加列
const mig2 = runChild(MIG, READ_SCRIPT);
check('迁移幂等：老库再开一次不炸、还是那 3 条',
  mig2.length === 3 && mig2.every((r) => r.deleted_at === null), String(mig2.length));

/* ============================ 2. 删除 = 进回收站 ============================ */

const { createApiServer } = await import('../src/api/server.js');
const store = await import('../src/store/profiles.js');

const { server, apiKey } = createApiServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const api = async (method, p, body) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', 'api-key': apiKey, 'x-freepower-client': 'mcp' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};
const listV2 = async () => (await api('POST', '/api/v2/browser-profile/list', { page: 1, limit: 200 })).json.data || {};
const binList = async (body = { page: 1, limit: 50 }) => (await api('POST', '/api/v2/browser-profile/recycle-bin/list', body)).json;
const restore = async (body) => (await api('POST', '/api/v2/browser-profile/recycle-bin/restore', body)).json;

const BIN_KEYS = ['delete_time', 'group_name', 'name', 'profile_id', 'profile_no', 'remark'];

try {
  const mk = async (name, extra = {}) => (await api('POST', '/api/v2/browser-profile/create', { name, group_id: '0', country: 'JP', ...extra })).json.data;
  const a = await mk('rc-a', { remark: '回收站备注' });
  const b = await mk('rc-b');
  const c = await mk('rc-c');
  const idA = a.profile_id;
  check('准备：建了 3 个环境', [a, b, c].every((x) => x && x.profile_id), [a, b, c].map((x) => x.profile_no).join(','));

  // 造一个 user-data 目录（真实环境里它由启动内核生成）
  const envDir = path.join(DATA, 'profiles', `${a.profile_no}_${String(idA).slice(0, 8)}`);
  fs.mkdirSync(path.join(envDir, 'userdata', 'Default'), { recursive: true });
  fs.writeFileSync(path.join(envDir, 'userdata', 'Default', 'Cookies'), 'sentinel');

  // 删除前把「指纹身份」快照下来，恢复后要逐字对得上
  const before = (await api('GET', `/api/v2/browser-profile/detail?profile_id=${idA}`)).json.data;
  const identity = ['profile_id', 'profile_no', 'name', 'group_id', 'ua', 'timezone', 'language', 'canvas_id', 'webgl_image_id', 'audio_id', 'fp_seed'];

  const del = await api('POST', '/api/v2/browser-profile/delete', { profile_id: [idA] });
  check('删除：返回 deleted=[该 id] 且 userdata_removed=0',
    del.json.code === 0 && JSON.stringify(del.json.data?.deleted) === JSON.stringify([idA]) && del.json.data?.userdata_removed === 0,
    JSON.stringify(del.json.data));
  check('删除：user-data 目录与文件都还在（软删除不删盘）',
    fs.existsSync(path.join(envDir, 'userdata', 'Default', 'Cookies')));

  const l2 = await listV2();
  check('v2 list：不再出现', !l2.list.some((p) => p.profile_id === idA) && l2.total === 2, `total=${l2.total}`);
  const l1 = (await api('GET', '/api/v1/user/list?page_size=100')).json.data || {};
  check('v1 list：同样不再出现', !(l1.list || []).some((p) => p.profile_id === idA), `total=${l1.total}`);

  const det = await api('GET', `/api/v2/browser-profile/detail?profile_id=${idA}`);
  check('detail：对已删项报 100001（不返回半死记录）', det.json.code === 100001, String(det.json.code));
  const st = await api('GET', `/api/v2/browser-profile/start?profile_id=${idA}`);
  check('start：已删项起不来，报 100001（没有偷偷起内核）', st.json.code === 100001, String(st.json.code));
  const upd = await api('POST', '/api/v2/browser-profile/update', { profile_id: idA, name: 'renamed' });
  check('update：已删项改不了，报 100001', upd.json.code === 100001, String(upd.json.code));
  const rg = await api('POST', '/api/v2/browser-profile/regroup', { profile_ids: [idA], group_id: '0' });
  check('regroup：已删项不计入 changed', rg.json.code === 0 && rg.json.data?.changed === 0, JSON.stringify(rg.json.data));

  const del2 = await api('POST', '/api/v2/browser-profile/delete', { profile_id: [idA] });
  check('重复删除：deleted=[]（不重复计数）', del2.json.code === 0 && (del2.json.data?.deleted || []).length === 0, JSON.stringify(del2.json.data));

  /* ============================ 3. recycle-bin/list ============================ */

  const bin = await binList();
  const item = bin.data?.list?.[0] || {};
  check('list：code 0、data.list 有 1 条', bin.code === 0 && bin.data?.list?.length === 1, `list=${bin.data?.list?.length}`);
  check('list：data 里**没有** total / total_count / total_pages（对手零出现）',
    bin.data?.total === undefined && bin.data?.total_count === undefined && bin.data?.total_pages === undefined,
    Object.keys(bin.data || {}).join(','));
  check('list：入参回显 page/limit（本地改写成 page_size）', bin.data?.page === 1 && bin.data?.limit === 50, JSON.stringify({ page: bin.data?.page, limit: bin.data?.limit }));
  const binEmpty = await binList({});
  check('list：data 是**恒定三键**（不传参数也是 list,page,limit=1/50；对手整形函数里这两个字段永远存在）',
    JSON.stringify(Object.keys(binEmpty.data || {}).sort()) === JSON.stringify(['limit', 'list', 'page'])
    && binEmpty.data?.page === 1 && binEmpty.data?.limit === 50,
    `${Object.keys(binEmpty.data || {}).sort().join(',')} page=${binEmpty.data?.page} limit=${binEmpty.data?.limit}`);
  check('list：item 严格 6 字段（多一个算失败）',
    JSON.stringify(Object.keys(item).sort()) === JSON.stringify(BIN_KEYS), Object.keys(item).sort().join(','));
  check('list：item 值对上（id/no/name/group_name/remark）',
    item.profile_id === idA && item.profile_no === a.profile_no && item.name === 'rc-a'
    && item.group_name === 'Default' && item.remark === '回收站备注', JSON.stringify(item));
  check('list：delete_time 是秒级 unix 时间戳字符串（库里存 YYYY-MM-DD HH:mm:ss → 秒）',
    /^\d{10}$/.test(String(item.delete_time)) && Math.abs(Number(item.delete_time) * 1000 - Date.now()) < 600000,
    String(item.delete_time));

  const badPage0 = await binList({ page: 0 });
  check('list 校验：page 小于 1 文案逐字', badPage0.code === 100002 && badPage0.msg === 'page must be greater than or equal to 1', badPage0.msg);
  const badPageX = await binList({ page: 'x' });
  check('list 校验：page 非数字文案逐字', badPageX.code === 100002 && badPageX.msg === 'page must be a number', badPageX.msg);
  const badLimit = await binList({ limit: 0 });
  check('list 校验：limit 越界文案逐字', badLimit.code === 100002 && badLimit.msg === 'limit must be between 1 and 100', badLimit.msg);

  // 重启：真进程读库
  const afterDelete = runChild(DATA, READ_SCRIPT);
  const rowA = afterDelete.find((r) => r.id === idA);
  check('重启（新进程读库）：删除态落盘、B/C 仍在用',
    Boolean(rowA) && typeof rowA.deleted_at === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rowA.deleted_at)
    && afterDelete.filter((r) => r.deleted_at === null).length === 2,
    `deleted_at=${rowA?.deleted_at}`);

  /* ============================ 4. recycle-bin/restore ============================ */

  const e1 = await restore({});
  check('restore 校验：都没给 → 文案逐字', e1.code === 100002 && e1.msg === 'profile_id or profile_no is required', e1.msg);
  const e2 = await restore({ profile_id: [idA], group_id: '0' });
  check('restore 校验：profile_id 是数组 → "must be a string"', e2.code === 100002 && e2.msg === 'profile_id must be a string', e2.msg);
  const e3 = await restore({ profile_no: { x: 1 }, group_id: '0' });
  check('restore 校验：profile_no 是对象 → "must be a string"', e3.code === 100002 && e3.msg === 'profile_no must be a string', e3.msg);
  const e4 = await restore({ profile_id: idA });
  check('restore 校验：group_id 不传 → "group_id is required"（不能"回原分组"）', e4.code === 100002 && e4.msg === 'group_id is required', e4.msg);
  const e5 = await restore({ profile_id: idA, group_id: 'abc' });
  check('restore 校验：group_id 非数字串 → "group_id must be a number"', e5.code === 100002 && e5.msg === 'group_id must be a number', e5.msg);
  const e6 = await restore({ profile_id: 'no-such-id', group_id: '0' });
  check('restore：目标不在回收站 → 100001（不假装成功）', e6.code === 100001, `${e6.code} ${e6.msg}`);

  const r1 = await restore({ profile_id: idA, group_id: '0' });
  check('restore：成功，且 data 不出现（响应体无对手证据，取 null）',
    r1.code === 0 && r1.data === undefined, JSON.stringify(r1.data));
  const l2b = await listV2();
  check('恢复后 list：回来了', l2b.list.some((p) => p.profile_id === idA) && l2b.total === 3, `total=${l2b.total}`);
  const det2 = (await api('GET', `/api/v2/browser-profile/detail?profile_id=${idA}`)).json;
  check('恢复后：id 与 profile_no 不变', det2.code === 0 && det2.data?.profile_id === idA && det2.data?.profile_no === before.profile_no,
    `${det2.data?.profile_id} / ${det2.data?.profile_no}`);
  check('恢复后：指纹身份逐字不变（恢复的是同一个环境，不是新建一个）',
    identity.every((k) => JSON.stringify(det2.data?.[k] ?? null) === JSON.stringify(before?.[k] ?? null)),
    identity.filter((k) => JSON.stringify(det2.data?.[k] ?? null) !== JSON.stringify(before?.[k] ?? null)).join(',') || 'all-same');
  check('恢复后：user-data 目录还在（能直接启动的前提）', fs.existsSync(path.join(envDir, 'userdata', 'Default', 'Cookies')));
  check('恢复后回收站：不再有它', (await binList()).data?.list?.length === 0, `list=${(await binList()).data?.list?.length}`);
  const r2 = await restore({ profile_id: idA, group_id: '0' });
  check('重复恢复：100001（不在回收站里的恢复不了）', r2.code === 100001, String(r2.code));
  check('数据层重复恢复：restored=false（不假装成功）', store.restoreProfiles([idA], '0')[0].restored === false);

  // 按 profile_no 恢复 + 恢复到指定分组
  const g2 = (await api('POST', '/api/v2/group/create', { group_name: 'rc-restore-target' })).json.data;
  await api('POST', '/api/v2/browser-profile/delete', { profile_id: [c.profile_id] });
  const rNo = await restore({ profile_no: String(c.profile_no), group_id: g2.group_id });
  const cBack = (await api('GET', `/api/v2/browser-profile/detail?profile_id=${c.profile_id}`)).json.data;
  check('restore：可用 profile_no（字符串）+ 指定 group_id 恢复',
    rNo.code === 0 && cBack?.profile_id === c.profile_id && cBack?.group_id === String(g2.group_id),
    `${rNo.code} group_id=${cBack?.group_id}`);

  const afterRestore = runChild(DATA, READ_SCRIPT);
  check('重启（新进程读库）：恢复态落盘', afterRestore.every((r) => r.deleted_at === null),
    afterRestore.map((r) => (r.deleted_at === null ? 'alive' : 'bin')).join(','));

  /* ============================ 5. 回收站 + 删分组 ============================ */

  const g = (await api('POST', '/api/v2/group/create', { group_name: 'rc-group' })).json.data;
  const d = await mk('rc-d');
  await api('POST', '/api/v2/browser-profile/regroup', { profile_ids: [d.profile_id], group_id: g.group_id });
  await api('POST', '/api/v2/browser-profile/delete', { profile_id: [d.profile_id] });
  const gd = await api('POST', '/api/v2/group/delete', { group_id: g.group_id });
  // 组里只剩回收站里的 D：删组时 moved 只说人看得见的环境（D 不算），但 D 的分组也要挪回 Default，
  // 否则恢复出来会挂在一个已经不存在的分组上
  check('删分组：moved 只算在用环境（0），组照样删掉', gd.json.code === 0 && gd.json.data?.moved === 0, JSON.stringify(gd.json.data));
  await restore({ profile_id: d.profile_id, group_id: '0' });
  const dBack = (await api('GET', `/api/v2/browser-profile/detail?profile_id=${d.profile_id}`)).json.data;
  check('删组后恢复：环境落回 Default（不挂在已删分组上）', dBack?.group_id === '0', String(dBack?.group_id));
} catch (e) {
  check('回收站测试异常', false, e.stack || e.message);
} finally {
  server.close();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 句柄没放手就下次再删 */ }
  try { fs.rmSync(MIG, { recursive: true, force: true }); } catch { /* 同上 */ }
}

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
