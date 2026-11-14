/**
 * 批量菜单 11 项 + 视图密度（0.4.3 ③）判据 —— A 层：不起内核，几秒跑完。
 *
 * 形态依据逆向 `28-远端UI界面结构.md` 的「批量操作」清单与「列表设置」：
 *   批量：修改代理 / 修改UA内核 / 修改备注 / 更新环境信息 / 批量删除 / 批量归档 / 批量恢复
 *   行内：显示窗口 / 检查代理 / 还原Cookie / 合并Cookie
 *   列表设置：紧凑 / 标准 / 超高（`lineHeight`）
 *
 * 这里钉五类事（每条都对着 CEO 的四条要求）：
 *   1. **归档 ≠ 删除**：只写 `archived_at`、不碰 `deleted_at`、不动 user-data；
 *      回收站的 `/recycle-bin/*` 一次都没被复用成归档（静态断言 + 行为断言两条）。
 *   2. **检查代理**：并发有上限、逐条结果、成功/失败/超时分开且**超时带具体秒数**；
 *      一条挂掉不中断整批；直连环境如实标 `direct`，**不编一个「检查通过」**。
 *   3. **还原 / 合并 Cookie**：还原=覆盖、合并=并集（同名以现有为准）；两者都要**预览**，
 *      预览**不写**（环境没跑时只能是「没跑」而不是「写成功」）；预览里**不带 cookie 的值**。
 *   4. **参数缺失一律报错**：九条批量路由逐个验，缺 `profile_ids` 必须 `100002` 且带 field，
 *      绝不当成「一条都没选」然后回 code=0。
 *   5. **视图密度只存本地**：三档齐全、认不出回标准、只写 localStorage（模块里没有任何 API/DB 依赖）。
 *
 * 跑法：node --no-warnings test/batch.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startFakeProxy } from './fake-proxy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(os.tmpdir(), `freepower-batch-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });

process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_RATE_LIMIT_MCP = '10000';
process.env.FREEPOWER_SELFCHECK = '0';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const okProxy = await startFakeProxy({ ip: '203.0.113.9', country: 'Japan', countryCode: 'JP', city: 'Tokyo', timezone: 'Asia/Tokyo' });
// 黑洞：TCP 连得上、永不回包 → 这条一定超时（和「连接被拒」是两回事）
// 要自己记 socket：`server.close()` 只会停止 accept，已经连上的那条会一直挂着，
// 进程就退不出去（第一次跑就是这么卡住的）。收尾时挨个 destroy。
const holeSockets = new Set();
const hole = net.createServer((s) => {
  holeSockets.add(s);
  s.on('close', () => holeSockets.delete(s));
  s.on('error', () => { /* 我们主动 destroy 时会报 aborted，忽略 */ });
  /* 什么都不发 */
});
await new Promise((r) => hole.listen(0, '127.0.0.1', r));
const holePort = hole.address().port;

try {
  const prof = await import('../src/store/profiles.js');
  const { userDataDirFor } = await import('../src/runtime/manager.js');
  const { createApiServer } = await import('../src/api/server.js');
  const { closeDb } = await import('../src/store/db.js');
  const cookies = await import('../src/kernel/cookies.js');
  const density = await import('../web/density.js');

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

  /* ============================ 1. 参数纪律 ============================ */
  console.log('\n— 1. 九条批量路由：缺 profile_ids 必须报错（不静默当成「没选」） —');
  const BATCH_ROUTES = [
    'batch/archive', 'batch/unarchive', 'batch/proxy', 'batch/check-proxy', 'batch/ua',
    'batch/remark', 'batch/update-info', 'batch/show', 'batch/cookie',
  ];
  for (const route of BATCH_ROUTES) {
    const r = await api('POST', `/api/v2/browser-profile/${route}`, {});
    check(`${route} 一个字段不给 → 100002 + data.field=profile_ids`,
      r.json?.code === 100002 && r.json?.data?.field === 'profile_ids',
      `${r.json?.code} ${r.json?.msg}`);
  }
  const typoIds = await api('POST', '/api/v2/browser-profile/batch/archive', { profileIds: ['x'] });
  check('字段名拼错（profileIds）→ 也是 100002（不是「0 个成功」）',
    typoIds.json?.code === 100002, String(typoIds.json?.code));

  /* ============================ 2. 归档 / 恢复 ============================ */
  console.log('\n— 2. 归档：移出主列表但不是删除 —');

  const a1 = prof.createProfile({ name: 'batch-arch-1', group_id: '0' });
  const a2 = prof.createProfile({ name: 'batch-arch-2', group_id: '0' });
  const a3 = prof.createProfile({ name: 'batch-arch-3', group_id: '0' });
  // 给 a1 造一个真的 user-data 文件：归档**不许**动它
  const udd1 = userDataDirFor(prof.getProfile(a1.id));
  fs.mkdirSync(udd1, { recursive: true });
  fs.writeFileSync(path.join(udd1, 'Cookies'), 'cookie-value');

  const arch = await api('POST', '/api/v2/browser-profile/batch/archive', { profile_ids: [a1.id, a2.id] });
  check('批量归档：code=0，两个都归档了',
    arch.json?.code === 0 && (arch.json.data.archived || []).length === 2, JSON.stringify(arch.json?.data));
  check('归档只写 archived_at：记录还在、deleted_at 仍为空（没进回收站）',
    !!prof.getProfile(a1.id) && !prof.getRecycledProfile({ profile_id: a1.id }),
    JSON.stringify({
      arch: prof.getProfile(a1.id)?.archived_at,
      deleted: prof.getProfile(a1.id)?.deleted_at ?? null,
    }));
  check('归档不动 user-data（Cookies 逐字节还在）',
    fs.existsSync(udd1) && fs.readFileSync(path.join(udd1, 'Cookies'), 'utf8') === 'cookie-value');

  const listDefault = await api('POST', '/api/v2/browser-profile/list', { limit: 200 });
  const namesDefault = (listDefault.json?.data?.list || []).map((x) => x.name);
  check('默认列表不含已归档（「移出主列表」就是这个意思）',
    !namesDefault.includes('batch-arch-1') && !namesDefault.includes('batch-arch-2'), namesDefault.join(','));

  const listOnly = await api('POST', '/api/v2/browser-profile/list', { limit: 200, archived: 'only' });
  const namesOnly = (listOnly.json?.data?.list || []).map((x) => x.name);
  check('archived:only 只看已归档（归档的东西没消失，只是挪了筛选）',
    namesOnly.includes('batch-arch-1') && namesOnly.includes('batch-arch-2') && !namesOnly.includes('batch-arch-3'),
    namesOnly.join(','));

  const listAll = await api('POST', '/api/v2/browser-profile/list', { limit: 200, archived: 'include' });
  const namesAll = (listAll.json?.data?.list || []).map((x) => x.name);
  check('archived:include 全都算（含已归档）',
    namesAll.includes('batch-arch-1') && namesAll.includes('batch-arch-3'), String(namesAll.length));

  const again = await api('POST', '/api/v2/browser-profile/batch/archive', { profile_ids: [a1.id, a3.id] });
  check('重复归档 → skipped 里点名 already_archived，a3 是真归档',
    (again.json?.data?.archived || []).includes(a3.id)
    && (again.json?.data?.skipped || []).some((s) => s.profile_id === a1.id && s.reason === 'already_archived'),
    JSON.stringify(again.json?.data));

  // 回收站里的不能归档（两套语义不许混）
  await api('POST', '/api/v2/browser-profile/delete', { profile_id: [a3.id] });
  const archRecycled = await api('POST', '/api/v2/browser-profile/batch/archive', { profile_ids: [a3.id] });
  check('回收站里的环境不能被归档：skipped=in_recycle_bin（归档 ≠ 删除，两套语义不许混）',
    (archRecycled.json?.data?.skipped || []).some((s) => s.reason === 'in_recycle_bin'),
    JSON.stringify(archRecycled.json?.data));
  await api('POST', '/api/v2/browser-profile/recycle-bin/restore', { profile_id: a3.id, group_id: '0' });

  const unarch = await api('POST', '/api/v2/browser-profile/batch/unarchive', { profile_ids: [a1.id, a2.id, a3.id] });
  check('批量恢复（从归档）：两个 restored，a3 报 not_archived',
    (unarch.json?.data?.restored || []).length === 2
    && (unarch.json?.data?.skipped || []).some((s) => s.profile_id === a3.id && s.reason === 'not_archived'),
    JSON.stringify(unarch.json?.data));
  check('恢复后回到主列表',
    (await api('POST', '/api/v2/browser-profile/list', { limit: 200 })).json.data.list.some((x) => x.name === 'batch-arch-1'));

  // 归档过的环境被删除再恢复 → 不能带着「已归档」回来（否则用户找不到它）
  await api('POST', '/api/v2/browser-profile/batch/archive', { profile_ids: [a2.id] });
  await api('POST', '/api/v2/browser-profile/delete', { profile_id: [a2.id] });
  await api('POST', '/api/v2/browser-profile/recycle-bin/restore', { profile_id: a2.id, group_id: '0' });
  check('归档 → 删除 → 从回收站恢复：archived_at 已清空（不然它会「隐身」在主列表外）',
    prof.getProfile(a2.id)?.archived_at === null || prof.getProfile(a2.id)?.archived_at === undefined,
    String(prof.getProfile(a2.id)?.archived_at));

  /* ============================ 3. 检查代理 ============================ */
  console.log('\n— 3. 检查代理：限并发 + 逐条结果（成功/失败/超时分开，超时给秒数） —');

  const pOk = prof.createProfile({
    name: 'px-ok', group_id: '0',
    proxy_config: { proxy_type: 'http', host: '127.0.0.1', port: okProxy.port },
  });
  const pDead = prof.createProfile({
    name: 'px-dead', group_id: '0',
    proxy_config: { proxy_type: 'http', host: '127.0.0.1', port: 1 },
  });
  const pSlow = prof.createProfile({
    name: 'px-slow', group_id: '0',
    proxy_config: { proxy_type: 'http', host: '127.0.0.1', port: holePort },
  });
  const pDirect = prof.createProfile({ name: 'px-direct', group_id: '0' });

  const ids = [pOk.id, pDead.id, pSlow.id, pDirect.id];
  const t0 = Date.now();
  const chk = await api('POST', '/api/v2/browser-profile/batch/check-proxy', { profile_ids: ids, timeout_ms: 1200 });
  const elapsed = Date.now() - t0;
  const byId = new Map((chk.json?.data?.list || []).map((x) => [x.profile_id, x]));
  check('批量检查：code=0、逐条结果、顺序与入参一致',
    chk.json?.code === 0 && JSON.stringify((chk.json.data.list || []).map((x) => x.profile_id)) === JSON.stringify(ids),
    String((chk.json?.data?.list || []).length));
  check('好代理：outcome=ok、带出口 IP（真走了代理）',
    byId.get(pOk.id)?.outcome === 'ok' && byId.get(pOk.id)?.ip === '203.0.113.9',
    JSON.stringify(byId.get(pOk.id)));
  check('死端口：outcome=fail（不是 ok、也不是 timeout）',
    byId.get(pDead.id)?.outcome === 'fail', JSON.stringify(byId.get(pDead.id)?.outcome));
  check('黑洞：outcome=timeout，且带具体秒数（1.2 秒，不是一句「超时」）',
    byId.get(pSlow.id)?.outcome === 'timeout'
    && byId.get(pSlow.id)?.timeout_ms === 1200
    && byId.get(pSlow.id)?.timeout_seconds === 1.2,
    JSON.stringify({ o: byId.get(pSlow.id)?.outcome, ms: byId.get(pSlow.id)?.timeout_ms, s: byId.get(pSlow.id)?.timeout_seconds }));
  check('直连环境：outcome=direct（没有代理可查，不编一个「检查通过」）',
    byId.get(pDirect.id)?.outcome === 'direct' && byId.get(pDirect.id)?.ok === false,
    JSON.stringify(byId.get(pDirect.id)));
  check('一条失败不中断整批：4 条都有结果，汇总三态分开',
    (chk.json?.data?.list || []).length === 4
    && chk.json.data.ok === 1 && chk.json.data.fail === 1 && chk.json.data.timeout === 1 && chk.json.data.direct === 1,
    JSON.stringify({ ok: chk.json?.data?.ok, fail: chk.json?.data?.fail, t: chk.json?.data?.timeout, d: chk.json?.data?.direct }));
  check('并发有上限（回包里带 concurrency，且 ≤ 10）',
    Number(chk.json?.data?.concurrency) >= 1 && Number(chk.json?.data?.concurrency) <= 10,
    String(chk.json?.data?.concurrency));
  check('整批在「超时上限 × 条数」之内收口（并发真的在起作用）',
    elapsed < 1200 * 4 + 3000, `${elapsed}ms`);

  /* ============================ 4. 改 UA / 内核 ============================ */
  console.log('\n— 4. 改 UA / 内核：必须身份自洽 —');
  const kernels = (await api('GET', '/api/v2/browser-profile/kernels?kernel_type=chrome')).json?.data?.list || [];
  const k0 = kernels[0]?.kernel;
  if (!k0) {
    check('本机没有可用内核，UA 一致性的正向断言跳过（如实记录，不假装通过）', true, 'no kernel installed');
  } else {
    const major = String(k0).split('.')[0];
    const bad = await api('POST', '/api/v2/browser-profile/batch/ua', {
      profile_ids: [pOk.id],
      kernel_version: k0,
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    check('UA 大版本与内核不一致 → 100002（不静默改其中一个，那会造出自相矛盾的指纹）',
      bad.json?.code === 100002 && bad.json?.data?.field === 'ua', bad.json?.msg);
    check('被拒之后环境一个字段都没变',
      prof.getProfile(pOk.id)?.kernel_version !== undefined
      && !String(prof.getProfile(pOk.id)?.ua || '').includes('Chrome/120.'));

    const good = await api('POST', '/api/v2/browser-profile/batch/ua', { profile_ids: [pOk.id], kernel_version: k0 });
    const after = prof.getProfile(pOk.id);
    check('只给内核 → UA 按内核大版本重写、ua_full_version 同步（两个一起写才自洽）',
      good.json?.code === 0
      && String(after.ua).includes(`Chrome/${major}.`)
      && String(after.client_hints?.ua_full_version) === k0,
      JSON.stringify({ ua: String(after?.ua).slice(0, 60), hints: after?.client_hints?.ua_full_version }));
    check('改 UA 不会偷偷重启（在跑才需要重启；这里没跑，restart_required=false）',
      good.json?.data?.restart_required === false, String(good.json?.data?.restart_required));

    const uaOnly = await api('POST', '/api/v2/browser-profile/batch/ua', {
      profile_ids: [pDead.id],
      ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    });
    check('只给 UA → 从 UA 抽出内核版本一起写',
      uaOnly.json?.code === 0 && String(prof.getProfile(pDead.id)?.kernel_version).split('.')[0] === major,
      String(prof.getProfile(pDead.id)?.kernel_version));
  }

  /* ============================ 5. 改备注 ============================ */
  console.log('\n— 5. 改备注：四种方式都要真的按说的做 —');
  prof.updateProfile(pDirect.id, { remark: '原备注' });
  const rep = await api('POST', '/api/v2/browser-profile/batch/remark', { profile_ids: [pDirect.id], remark: '新备注', mode: 'replace' });
  check('replace 覆盖', rep.json?.code === 0 && prof.getProfile(pDirect.id).remark === '新备注', prof.getProfile(pDirect.id).remark);
  await api('POST', '/api/v2/browser-profile/batch/remark', { profile_ids: [pDirect.id], remark: '+加', mode: 'append', separator: ' ' });
  check('append 追加在末尾', prof.getProfile(pDirect.id).remark === '新备注 +加', prof.getProfile(pDirect.id).remark);
  await api('POST', '/api/v2/browser-profile/batch/remark', { profile_ids: [pDirect.id], remark: '【前】', mode: 'prefix', separator: '' });
  check('prefix 加到开头', prof.getProfile(pDirect.id).remark === '【前】新备注 +加', prof.getProfile(pDirect.id).remark);
  const badMode = await api('POST', '/api/v2/browser-profile/batch/remark', { profile_ids: [pDirect.id], remark: 'x', mode: 'nope' });
  check('不认识的 mode → 100002（不猜用户想干什么）', badMode.json?.code === 100002, badMode.json?.msg);

  /* ============================ 6. 更新环境信息 ============================ */
  console.log('\n— 6. 更新环境信息：白名单 + 分组校验 —');
  const g = await api('POST', '/api/v2/group/create', { group_name: '批量组' });
  const gid = g.json?.data?.group_id;
  const upd = await api('POST', '/api/v2/browser-profile/batch/update-info', {
    profile_ids: [pDirect.id, pOk.id],
    fields: { group_id: gid, domain_name: 'example.com', fp_seed: 999 },  // fp_seed 不在白名单，必须被忽略
  });
  check('更新生效 + 非白名单字段如实回 ignored（不静默改指纹）',
    upd.json?.code === 0 && upd.json.data.count === 2 && (upd.json.data.ignored_fields || []).includes('fp_seed'),
    JSON.stringify(upd.json?.data?.ignored_fields));
  check('分组真的改了、fps_seed 一个都没动',
    String(prof.getProfile(pDirect.id).group_id) === String(gid) && prof.getProfile(pDirect.id).fp_seed !== 999,
    JSON.stringify({ g: prof.getProfile(pDirect.id).group_id, seed: prof.getProfile(pDirect.id).fp_seed }));
  const badGroup = await api('POST', '/api/v2/browser-profile/batch/update-info', { profile_ids: [pDirect.id], fields: { group_id: '99999' } });
  check('不存在的分组 → 100002', badGroup.json?.code === 100002, badGroup.json?.msg);
  const emptyFields = await api('POST', '/api/v2/browser-profile/batch/update-info', { profile_ids: [pDirect.id], fields: { nameless: 1 } });
  check('一个合法字段都没有 → 100002（不是「0 个成功」）', emptyFields.json?.code === 100002, emptyFields.json?.msg);

  /* ============================ 7. 批量改代理 ============================ */
  console.log('\n— 7. 批量改代理：三种写法 + 在跑才需要重启 —');
  const setPx = await api('POST', '/api/v2/browser-profile/batch/proxy', {
    profile_ids: [pDirect.id],
    proxy_config: { proxy_type: 'http', host: '127.0.0.1', port: okProxy.port },
  });
  check('手填一条代理：写进去了（回包里只给 host/port/type，不吐密码）',
    setPx.json?.code === 0
    && prof.getProfile(pDirect.id).proxy_config?.host === '127.0.0.1'
    && JSON.stringify(setPx.json.data.changed[0].proxy_config).includes(okProxy.port)
    && !JSON.stringify(setPx.json.data).includes('password'),
    JSON.stringify(setPx.json?.data?.changed?.[0]));
  const prefix = await api('POST', '/api/v1/proxy-list/create', [{ type: 'http', host: '127.0.0.1', port: okProxy.port, remark: '批量用' }]);
  const pxId = prefix.json?.data?.[0]?.proxy_id;
  const byPreset = await api('POST', '/api/v2/browser-profile/batch/proxy', { profile_ids: [pDirect.id], proxy_id: pxId });
  check('按代理列表里的 proxy_id 绑：code=0', byPreset.json?.code === 0, byPreset.json?.msg);
  const cleared = await api('POST', '/api/v2/browser-profile/batch/proxy', { profile_ids: [pDirect.id], clear: true });
  check('改成直连：clear:true 生效（host 空）',
    cleared.json?.code === 0 && !prof.getProfile(pDirect.id).proxy_config?.host,
    JSON.stringify(prof.getProfile(pDirect.id).proxy_config));
  const pxMissing = await api('POST', '/api/v2/browser-profile/batch/proxy', { profile_ids: [pDirect.id] });
  check('什么都没给 → 100002（不会静默改成直连）', pxMissing.json?.code === 100002, pxMissing.json?.msg);

  /* ============================ 8. Cookie：还原 / 合并 ============================ */
  console.log('\n— 8. 还原 / 合并 Cookie：覆盖 vs 并集（纯函数逐条验） —');
  const existing = [
    { name: 'sid', value: 'old', domain: '.example.com', path: '/', expires: 1800000000, httpOnly: true, secure: true },
    { name: 'keep', value: 'k', domain: 'example.com', path: '/', expires: -1, httpOnly: false, secure: false },
    { name: 'gone', value: 'g', domain: 'example.com', path: '/', expires: -1, httpOnly: false, secure: false },
  ];
  const incoming = [
    { name: 'sid', value: 'new', domain: 'example.com', path: '/', expires: 1800000000, httpOnly: true, secure: true }, // 同名不同值（前导点已归一）
    { name: 'keep', value: 'k', domain: 'example.com', path: '/', expires: -1, httpOnly: false, secure: false },          // 完全一样
    { name: 'added', value: 'a', domain: 'example.com', path: '/', expires: -1, httpOnly: false, secure: false },         // 新增
    { name: '', value: 'x', domain: 'example.com' },                                                                      // 非法（没 name）
  ];

  const pr = cookies.planCookieWrite(existing, incoming, 'restore');
  check('还原=覆盖：加 1（added）、改 1（sid）、删 1（gone）、不变 1（keep）、非法 1 条单独报',
    pr.will_add === 1 && pr.will_update === 1 && pr.will_delete === 1 && pr.unchanged === 1 && pr.invalid.length === 1,
    JSON.stringify({ a: pr.will_add, u: pr.will_update, d: pr.will_delete, same: pr.unchanged, bad: pr.invalid.length }));
  const pm = cookies.planCookieWrite(existing, incoming, 'merge');
  check('合并=并集：加 1（added）、改 0（同名以现有为准）、删 0（并集不删）、保留现有 1',
    pm.will_add === 1 && pm.will_update === 0 && pm.will_delete === 0 && pm.will_keep === 1,
    JSON.stringify({ a: pm.will_add, u: pm.will_update, d: pm.will_delete, keep: pm.will_keep }));
  check('预览里**不带 cookie 的值**（登录凭据不上界面、不进日志）',
    !JSON.stringify(pr.sample).includes('old') && !JSON.stringify(pr.sample).includes('new')
    && !JSON.stringify(pr.sample).includes('"value"'),
    JSON.stringify(pr.sample.update));
  check('还原的待写集合正好是「要加的 + 要改的」；待删集合正好是被覆盖掉的那条',
    pr._write.length === 2 && pr._delete.length === 1 && pr._delete[0].name === 'gone',
    JSON.stringify(pr._delete));
  check('合并的待删集合为空（并集绝不删东西）', pm._delete.length === 0);

  const noMode = await api('POST', '/api/v2/browser-profile/batch/cookie', {
    profile_ids: [pOk.id], cookies: incoming,
  });
  check('没给 mode → 100002（还原和合并必须让用户显式选，不替他决定）',
    noMode.json?.code === 100002 && noMode.json?.data?.field === 'mode', noMode.json?.msg);

  const previewNotRunning = await api('POST', '/api/v2/browser-profile/batch/cookie', {
    profile_ids: [pOk.id], cookies: incoming, mode: 'restore', preview: true,
  });
  check('环境没在跑 → preview 也如实回 skipped=not_running（不为了改 cookie 偷偷起内核）',
    previewNotRunning.json?.code === 0
    && (previewNotRunning.json.data.skipped || []).some((s) => s.reason === 'not_running')
    && (previewNotRunning.json.data.list || []).length === 0,
    JSON.stringify(previewNotRunning.json?.data?.skipped));

  const applyNotRunning = await api('POST', '/api/v2/browser-profile/batch/cookie', {
    profile_ids: [pOk.id], cookies: incoming, mode: 'restore', preview: false,
  });
  check('真写也拒绝：没在跑就一条都写不进去（skipped，不是 applied）',
    applyNotRunning.json?.code === 0
    && (applyNotRunning.json.data.list || []).length === 0
    && (applyNotRunning.json.data.skipped || []).some((s) => s.reason === 'not_running'),
    JSON.stringify(applyNotRunning.json?.data?.summary));

  /* ============================ 9. 显示窗口 ============================ */
  console.log('\n— 9. 显示窗口（批量版，不要求开同步会话） —');
  const showRes = await api('POST', '/api/v2/browser-profile/batch/show', { profile_ids: [pOk.id, pDirect.id] });
  check('没在跑的环境 → skipped=not_running，不当成「已显示」',
    showRes.json?.code === 0
    && (showRes.json.data.skipped || []).length === 2
    && (showRes.json.data.skipped || []).every((s) => s.reason === 'not_running'),
    JSON.stringify(showRes.json?.data?.skipped));
  check('返回值里带着 os_foreground 与 force 两个字段（能不能真到前台要说清）',
    typeof showRes.json?.data?.os_foreground === 'boolean' && showRes.json?.data?.force === false,
    JSON.stringify({ f: showRes.json?.data?.force, o: showRes.json?.data?.os_foreground }));

  /* ============================ 10. 视图密度 ============================ */
  console.log('\n— 10. 视图密度：三档、只存 localStorage —');
  check('三档齐全且顺序是 紧凑 / 标准 / 超高',
    density.DENSITIES.map((d) => d.label).join('/') === '紧凑/标准/超高',
    density.DENSITIES.map((d) => d.label).join('/'));
  check('行高逐档递增（紧凑 < 标准 < 超高）',
    density.DENSITIES[0].rowHeight < density.DENSITIES[1].rowHeight
    && density.DENSITIES[1].rowHeight < density.DENSITIES[2].rowHeight,
    density.DENSITIES.map((d) => d.rowHeight).join('/'));

  const fake = (() => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m };
  })();
  density.setDensity('ultra', { storage: fake });
  check('setDensity 写进 localStorage 的键是 fp.view_density，值为 ultra',
    fake._m.get(density.VIEW_STORAGE_KEY) === 'ultra', JSON.stringify([...fake._m]));
  fake._m.set(density.VIEW_STORAGE_KEY, '某个脏值');
  check('存了脏值 → 读回标准（不把列表画坏）', density.readDensity(fake) === 'standard', density.readDensity(fake));
  check('认不出来的 id → densityOf 回标准', density.densityOf('huge').id === 'standard');

  const densitySrc = read('web/density.js');
  check('密度模块只写一个 localStorage 键，且没有 fetch / API 调用（偏好不出本机）',
    !/\bfetch\(/.test(densitySrc) && !/from '\.\/api\.js'/.test(densitySrc) && (densitySrc.match(/setItem\(/g) || []).length === 1,
    `${(densitySrc.match(/setItem\(/g) || []).length} 处 setItem`);

  const densityClass = (() => {
    const classes = new Set();
    const doc = { body: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } } };
    density.applyDensity('compact', doc);
    const after = [...classes];
    density.applyDensity('ultra', doc);
    return { compact: after, ultra: [...classes] };
  })();
  check('applyDensity 把 body 上的 class 换掉（同一时间只有一档生效）',
    densityClass.compact.join(',') === 'density-compact'
    && densityClass.ultra.join(',') === 'density-ultra',
    JSON.stringify(densityClass));

  /* ============================ 11. 页面与静态约束 ============================ */
  console.log('\n— 11. 页面：11 项菜单都在，且归档没复用回收站 —');
  const listSrc = read('web/pages/profiles.js');
  const MENU = [
    '修改代理', '修改 UA / 内核', '修改备注', '更新环境信息', '批量归档', '批量恢复', '批量删除',
    '显示窗口', '检查代理', '还原 Cookie（覆盖）', '合并 Cookie（并集）',
  ];
  const missing = MENU.filter((x) => !listSrc.includes(x));
  check(`批量菜单 11 项都在（${MENU.length} 项）`, missing.length === 0, missing.join(','));
  check('菜单里**没有**把回收站的接口当归档用（归档归档、删除删除）',
    /api\.batchArchive/.test(listSrc) && /api\.batchUnarchive/.test(listSrc)
    && /recycleRestore|recyclePurge/.test(listSrc) === false || !/batchArchive[\s\S]{0,200}recyclePurge/.test(listSrc));
  const archiveRouteSrc = read('src/api/routes.js');
  const archiveBlock = archiveRouteSrc.slice(
    archiveRouteSrc.indexOf("/api/v2/browser-profile/batch/archive"),
    archiveRouteSrc.indexOf("/api/v2/browser-profile/batch/unarchive"),
  );
  check('归档路由里出现的是 deleted_at 的**只读判断**，没有写 deleted_at（没被实现成删除）',
    !/deleted_at\s*=\s*\?/.test(archiveBlock) && !/purgeProfiles|deleteProfiles/.test(archiveBlock),
    archiveBlock.replace(/\s+/g, ' ').slice(0, 120));
  check('视图密度是这个页面自己的控件（不是写死的 CSS 类）',
    /DENSITIES/.test(listSrc) && /setDensity\(/.test(listSrc) && /localStorage|VIEW_STORAGE_KEY/.test(read('web/density.js')));

  const cookieSrc = read('web/pages/profiles.js');
  check('还原/合并 cookie 必须先预览：页面里先 preview:true 再 preview:false',
    /preview:\s*true/.test(cookieSrc) && /preview:\s*false/.test(cookieSrc)
    && cookieSrc.indexOf('preview: true') < cookieSrc.indexOf('preview: false'));
  check('「还原=覆盖 / 合并=并集」的差别写在界面上（用户能看懂会发生什么）',
    /还原」是\*\*覆盖\*\*|「还原」是\*\*覆盖\*\*|「还原」是覆盖/.test(cookieSrc)
    && /「合并」是\*\*并集\*\*|「合并」是并集/.test(cookieSrc),
    '');
  check('检查代理的结果界面把「超时」单独显示并带秒数',
    /超时（\$\{x\.timeout_seconds\} 秒/.test(listSrc), '');

  /* ---- 11b. 「更新环境信息」：字段清单必须能看见，且口径要说清是我们的解释 ---- */
  const INFO_FIELDS = [
    'name', 'remark', 'group_id', 'domain_name', 'open_urls',
    'username', 'password', 'fakey', 'platform_account', 'profile_tag_ids',
  ];
  const infoBlock = listSrc.slice(
    listSrc.indexOf('UPDATE_INFO_FIELDS'),
    listSrc.indexOf('function batchUpdateInfo'),
  );
  check(`更新环境信息：界面把白名单 ${INFO_FIELDS.length} 个字段全列出来（勾完知道改了啥）`,
    INFO_FIELDS.every((k) => new RegExp(`key: '${k}'`).test(infoBlock)),
    INFO_FIELDS.filter((k) => !new RegExp(`key: '${k}'`).test(infoBlock)).join(','));
  check('界面写明「勾了才发、没勾的原样不动」（不是静默全量覆盖）',
    /勾上才会改/.test(listSrc) && /没勾的字段\*\*原样不动\*\*|没勾的字段一个都不动/.test(listSrc));
  check('界面写明「这条的语义是我们自己的解释、对手只留了名字」',
    /updateUserInfo/.test(listSrc) && /没有证据|是我们自己的解释/.test(listSrc));
  check('README 与 17 号文档都写了这条口径声明（不许当成对齐对手）',
    /updateUserInfo/.test(read('README.md')) && /没有字段清单|没有证据/.test(read('README.md'))
    && /没有字段清单|没有证据/.test(read('docs/17-批量菜单与视图密度.md')));

  /* ---- 收尾 ---- */
  server.close();
  closeDb();
  await okProxy.close();
  for (const s of holeSockets) { try { s.destroy(); } catch { /* 已经断了 */ } }
  await new Promise((r) => hole.close(() => r()));
  await new Promise((r) => setTimeout(r, 100));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 句柄可能还开着 */ }
} catch (e) {
  check('测试脚本自身异常', false, e.stack || e.message);
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
