/**
 * 撤销「合并 Cookie」（0.4.7 ①）判据 —— B 层：**真内核**。
 *
 * A 层（`test/cookie-undo.test.mjs`）验了纯函数、落盘记录、以及不需要内核的路由分支。
 * 这里验的是它证不了的那件事：**真合并 → 真撤销 → 真回到合并前的集合**。
 *
 * 为什么必须真内核：cookie 在 Chrome 的 SQLite 里、值用 DPAPI 加密，只有走 CDP 才是真读写。
 * 「撤销看起来成功了」和「撤销真的把值写回去了」是两件事 —— 后者只有读回来逐条比才知道。
 *
 * 判据覆盖 CEO 点名的四条：
 *   1. 合并 A+B → 撤销 → A 与 B **各自**回到合并前的集合（逐条 deepEqual，含 value）。
 *   2. 撤销两次：第二次如实报「没有可撤销的合并」，不许假装又撤了一次。
 *   3. 合并后环境被删了再撤销 → 如实报失败，不崩。
 *   4. 只保留最近一次：连合并两次，撤销只回到**第二次合并前**那一刻。
 *
 * 另外钉两条容易被忽略的语义：
 *   - **合并之后新产生的 cookie 会被撤销删掉**（「回到合并前」就是这个意思）；
 *   - 撤销之后**快照文件真的被删了**（否则第二次撤销还能再撤一次，就是无限历史）。
 *
 * 跑法：node --no-warnings test/cookie-undo-kernel.test.mjs   （约 40–60 秒，需本机 Chrome）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = path.join(os.tmpdir(), `freepower-cookie-undo-k-${Date.now()}`);
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
process.env.FREEPOWER_EGRESS_TIMEOUT = '800';
process.env.FREEPOWER_RATE_LIMIT_MCP = '10000';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');
const dbmod = await import('../src/store/db.js');
const { readCookies } = await import('../src/kernel/cookies.js');
const { createApiServer } = await import('../src/api/server.js');
const undoStore = await import('../src/store/cookie-undo.js');

const exp = Math.floor(Date.now() / 1000) + 86400;
const ck = (name, value, domain = 'fp-undo.test') => ({
  name, value, domain, path: '/', expires: exp, httpOnly: false, secure: false,
});

/** 从内核读回「属于判据域名的」cookie，按 name 排序 —— 比较用（含 value） */
async function snapshotOf(client, domain = 'fp-undo.test') {
  const list = await readCookies(client);
  return list
    .filter((c) => String(c.domain || '').replace(/^\./, '') === domain)
    .map((c) => ({ name: c.name, value: c.value, domain: String(c.domain || '').replace(/^\./, ''), path: c.path }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

let server = null;
const ids = [];
try {
  const { server: srv, apiKey } = createApiServer();
  server = srv;
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

  /* ---------------- 两个环境，各带不同的初始 cookie ---------------- */
  console.log('— 启动两个真内核 —');
  const a = profiles.createProfile({ name: `undo-a-${Date.now()}`, group_id: '0' });
  const b = profiles.createProfile({ name: `undo-b-${Date.now()}`, group_id: '0' });
  ids.push(a.profile_id, b.profile_id);

  for (const [p, label] of [[a, 'A'], [b, 'B']]) {
    const st = await manager.startProfile(profiles.getProfile(p.profile_id));
    console.log(`  ${label} pid=${st.pid} 内核 ${st.real_version}`);
    check(`${label} 真内核起来了（下面所有读写都是真的）`, Number(st.pid) > 0 && !!st.real_version, `${st.pid}`);
  }
  const instA = manager.getInstance(a.profile_id);
  const instB = manager.getInstance(b.profile_id);

  // 预置初始 cookie（走真实 /cookie/import，与用户导入同一条路）
  const initA = [ck('sid', 'A-old'), ck('uid', 'A-7')];
  const initB = [ck('sid', 'B-old'), ck('theme', 'dark')];
  for (const [p, list, label] of [[a, initA, 'A'], [b, initB, 'B']]) {
    const r = await api('POST', '/api/v2/browser-profile/cookie/import', { profile_id: p.profile_id, cookies: list });
    check(`${label} 预置 2 条 cookie 成功（走真实 /cookie/import）`,
      r.json?.code === 0 && r.json?.data?.imported === 2, JSON.stringify(r.json?.data));
  }
  const beforeA = await snapshotOf(instA.client);
  const beforeB = await snapshotOf(instB.client);
  check('A 的合并前集合就是预置那两条（含值）',
    JSON.stringify(beforeA) === JSON.stringify([...initA].map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: '/' })).sort((x, y) => x.name.localeCompare(y.name))),
    JSON.stringify(beforeA));
  check('B 的合并前集合就是预置那两条（含值）', beforeB.length === 2, JSON.stringify(beforeB));

  /* ---------------- 1. 合并 A+B → 撤销 → 各自回到合并前 ---------------- */
  console.log('\n— 1. 合并（并集）→ 撤销 → A 与 B 各自回到合并前 —');
  // 合并用的文件：带一条新的、以及一条与 A 同名的（同名以现有为准，不覆盖）
  const incoming = [ck('sid', 'FROM-FILE-should-not-win'), ck('fromfile', 'f1')];
  const merged = await api('POST', '/api/v2/browser-profile/batch/cookie', {
    profile_ids: [a.profile_id, b.profile_id], cookies: incoming, mode: 'merge', preview: false,
  });
  check('合并真写：两个环境都 applied、各写入 1 条、一条都没删',
    merged.json?.code === 0 && (merged.json?.data?.summary?.applied) === 2
    && (merged.json?.data?.list || []).every((x) => x.written === 1 && x.deleted === 0),
    JSON.stringify((merged.json?.data?.list || []).map((x) => [x.written, x.deleted])));
  check('合并结果里带 undo_available=true（界面据此显示「可撤销」）',
    (merged.json?.data?.list || []).every((x) => x.undo_available === true),
    JSON.stringify((merged.json?.data?.list || []).map((x) => x.undo_available)));

  const mergedA = await snapshotOf(instA.client);
  const mergedB = await snapshotOf(instB.client);
  check('合并后 A 多了 fromfile 那条、sid 仍是自己的 A-old（同名不覆盖登录态）',
    mergedA.some((c) => c.name === 'fromfile') && mergedA.find((c) => c.name === 'sid')?.value === 'A-old',
    JSON.stringify(mergedA.map((c) => c.name)));
  check('合并后 B 也多了 fromfile、sid 仍是 B-old',
    mergedB.some((c) => c.name === 'fromfile') && mergedB.find((c) => c.name === 'sid')?.value === 'B-old',
    JSON.stringify(mergedB.map((c) => c.name)));

  // 撤销预览：只算不写
  const pv = await api('POST', '/api/v2/browser-profile/batch/cookie/undo', { profile_ids: [a.profile_id, b.profile_id], preview: true });
  const pvA = (pv.json?.data?.list || []).find((x) => x.profile_id === a.profile_id);
  check('撤销预览：A 会删掉 1 条（合并加进来的 fromfile）、写回 0 条',
    pv.json?.code === 0 && pvA?.preview === true && pvA?.will_delete === 1 && pvA?.will_add === 0,
    JSON.stringify({ d: pvA?.will_delete, a: pvA?.will_add, u: pvA?.will_update }));
  check('预览**没写内核**：A 里 fromfile 还在',
    (await snapshotOf(instA.client)).some((c) => c.name === 'fromfile'));

  // 真撤销
  const undone = await api('POST', '/api/v2/browser-profile/batch/cookie/undo', { profile_ids: [a.profile_id, b.profile_id], preview: false });
  check('撤销真写：两个环境都 restored=true、verified=true（逐条比对一致）',
    undone.json?.code === 0 && (undone.json?.data?.summary?.restored) === 2
    && (undone.json?.data?.list || []).every((x) => x.restored === true && x.verified === true),
    JSON.stringify((undone.json?.data?.list || []).map((x) => [x.restored, x.verified])));

  const afterA = await snapshotOf(instA.client);
  const afterB = await snapshotOf(instB.client);
  check('**A 逐条 deepEqual 回到合并前**（含 value：sid=A-old）',
    JSON.stringify(afterA) === JSON.stringify(beforeA),
    JSON.stringify({ before: beforeA, after: afterA }));
  check('**B 逐条 deepEqual 回到合并前**（含 value：sid=B-old）',
    JSON.stringify(afterB) === JSON.stringify(beforeB),
    JSON.stringify({ before: beforeB, after: afterB }));
  check('合并加进来的 fromfile 被撤销删掉了（「回到合并前」就是这个意思）',
    !afterA.some((c) => c.name === 'fromfile') && !afterB.some((c) => c.name === 'fromfile'),
    JSON.stringify(afterA.map((c) => c.name)));
  check('撤销报告里 deleted=1、written=0（说的是它真做的事）',
    (undone.json?.data?.list || []).every((x) => x.deleted === 1 && x.written === 0),
    JSON.stringify((undone.json?.data?.list || []).map((x) => [x.written, x.deleted])));

  /* ---------------- 2. 撤销两次 ---------------- */
  console.log('\n— 2. 再撤一次：必须如实说「没有可撤销的合并」 —');
  check('撤销后快照文件真的被删了（否则就成了无限历史）',
    !undoStore.hasMergeSnapshot(a.profile_id) && !undoStore.hasMergeSnapshot(b.profile_id));
  const twice = await api('POST', '/api/v2/browser-profile/batch/cookie/undo', { profile_ids: [a.profile_id], preview: false });
  const tItem = (twice.json?.data?.failed || [])[0];
  check('第二次撤销 → failed 里 reason=no_merge_to_undo，restored=0（不假装又撤了一次）',
    twice.json?.code === 0 && (twice.json?.data?.summary?.restored) === 0 && tItem?.reason === 'no_merge_to_undo',
    JSON.stringify({ restored: twice.json?.data?.summary?.restored, reason: tItem?.reason }));
  check('第二次撤销**没动内核**：A 的集合还是合并前那份',
    JSON.stringify(await snapshotOf(instA.client)) === JSON.stringify(beforeA));

  /* ---------------- 3. 只保留最近一次 ---------------- */
  console.log('\n— 3. 连合并两次：撤销只回到**第二次合并前** —');
  const first = [ck('one', '1')];
  const second = [ck('two', '2')];
  await api('POST', '/api/v2/browser-profile/batch/cookie', { profile_ids: [a.profile_id], cookies: first, mode: 'merge', preview: false });
  const afterFirstMerge = await snapshotOf(instA.client);
  await api('POST', '/api/v2/browser-profile/batch/cookie', { profile_ids: [a.profile_id], cookies: second, mode: 'merge', preview: false });
  const afterSecondMerge = await snapshotOf(instA.client);
  check('两次合并之后 A 里 one 和 two 都在', afterSecondMerge.some((c) => c.name === 'one') && afterSecondMerge.some((c) => c.name === 'two'),
    JSON.stringify(afterSecondMerge.map((c) => c.name)));
  const undo2 = await api('POST', '/api/v2/browser-profile/batch/cookie/undo', { profile_ids: [a.profile_id], preview: false });
  const undo2Item = (undo2.json?.data?.list || [])[0];
  const afterUndo2 = await snapshotOf(instA.client);
  check('撤销回到**第二次合并前**（one 还在、two 被删）—— 这就是「只保留最近一次」的含义',
    undo2Item?.restored === true
    && JSON.stringify(afterUndo2) === JSON.stringify(afterFirstMerge)
    && afterUndo2.some((c) => c.name === 'one') && !afterUndo2.some((c) => c.name === 'two'),
    JSON.stringify({ after: afterUndo2.map((c) => c.name), expected: afterFirstMerge.map((c) => c.name) }));
  check('界面能看到「回到哪一刻」：报告里带 merged_at',
    !!undo2Item?.merged_at, String(undo2Item?.merged_at || ''));

  /* ---------------- 4. 合并后环境被删 ---------------- */
  console.log('\n— 4. 合并后环境被删 → 撤销如实报失败，不崩 —');
  const c = profiles.createProfile({ name: `undo-c-${Date.now()}`, group_id: '0' });
  ids.push(c.profile_id);
  await manager.startProfile(profiles.getProfile(c.profile_id));
  const instC = manager.getInstance(c.profile_id);
  await api('POST', '/api/v2/browser-profile/cookie/import', { profile_id: c.profile_id, cookies: [ck('sid', 'C-old')] });
  await api('POST', '/api/v2/browser-profile/batch/cookie', { profile_ids: [c.profile_id], cookies: [ck('x', 'y')], mode: 'merge', preview: false });
  check('C 合并后有可撤销记录', undoStore.hasMergeSnapshot(c.profile_id));
  await manager.stopProfile(c.profile_id);
  await sleep(400);
  profiles.deleteProfiles([c.profile_id]);  // 进回收站
  const recycled = await api('POST', '/api/v2/browser-profile/batch/cookie/undo', { profile_ids: [c.profile_id], preview: false });
  const rcItem = (recycled.json?.data?.failed || [])[0];
  check('环境在回收站 → HTTP 200 + in_recycle_bin（不是 500、不是假装成功）',
    recycled.status === 200 && rcItem?.reason === 'in_recycle_bin',
    JSON.stringify({ status: recycled.status, reason: rcItem?.reason }));
  check('失败时**保留**快照（用户恢复环境后还能撤）', undoStore.hasMergeSnapshot(c.profile_id));
  profiles.purgeProfiles([c.profile_id]);
  const purged = await api('POST', '/api/v2/browser-profile/batch/cookie/undo', { profile_ids: [c.profile_id], preview: false });
  const pgItem = (purged.json?.data?.failed || [])[0];
  check('环境被彻底删除 → not_found，接口不崩', purged.status === 200 && pgItem?.reason === 'not_found',
    JSON.stringify({ status: purged.status, reason: pgItem?.reason }));

  /* ---------------- 5. 还原（restore）不落撤销记录 ---------------- */
  console.log('\n— 5. 「还原（覆盖）」不该产生撤销记录（只有合并有撤销） —');
  const rest = await api('POST', '/api/v2/browser-profile/batch/cookie', {
    profile_ids: [b.profile_id], cookies: [ck('sid', 'B-new')], mode: 'restore', preview: false,
  });
  check('还原真写成功（覆盖）', rest.json?.code === 0 && (rest.json?.data?.list || [])[0]?.applied === true,
    JSON.stringify(rest.json?.data?.summary));
  check('还原**没有**留下撤销记录（它的语义是「以文件为准」，不提供撤销）',
    undoStore.hasMergeSnapshot(b.profile_id) === false);
  check('还原报告里 undo_available=false（界面不会显示一个假的「可撤销」）',
    (rest.json?.data?.list || [])[0]?.undo_available === false);
} catch (e) {
  check('B 层跑完没有抛异常', false, `${e && e.message}`);
  console.error(e);
} finally {
  for (const id of ids) await manager.stopProfile(id).catch(() => {});
  if (server) server.close();
  dbmod.closeDb();
  await sleep(300);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄还在，留给系统 */ }
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
