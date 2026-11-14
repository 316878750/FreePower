/**
 * 还原 / 合并 Cookie（0.4.3 ③）判据 —— B 层：**真内核**。
 *
 * 为什么要真内核：cookie 在 Chrome 的 SQLite 里、值用 DPAPI 加密，只有走 CDP 才是真读写。
 * 而这两个动作最容易做错的地方正好是**语义**：
 *   还原 = 覆盖（文件里没有的要删掉）；合并 = 并集（同名以现有为准，绝不动登录态）。
 * 只靠纯函数测不够 —— 还得证明 `Network.deleteCookies` 真的删掉了、`Storage.setCookies` 真的覆盖了。
 *
 * 这里验四件事：
 *   A. 还原的**预览**数字与真写之后读回的**实际差集**一致（预览不是猜的）；
 *   B. 还原真覆盖：文件里没有的那条被删掉、同名的被改成新值；
 *   C. 合并真并集：同名的保留**现有**值（不是文件里的旧值）、只补缺的那条、一条都不删；
 *   D. 预览里**没有 cookie 的值**（登录凭据不出现在响应里）。
 *
 * 跑法：node --no-warnings test/batch-cookie-kernel.test.mjs   （约 30–60 秒，需本机 Chrome）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = path.join(os.tmpdir(), `freepower-cookie-k-${Date.now()}`);
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
process.env.FREEPOWER_EGRESS_TIMEOUT = '800';

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

let server = null;
let profileId = null;

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
    return json;
  }

  const p = profiles.createProfile({ name: `cookie-k-${Date.now()}`, group_id: '0' });
  profileId = p.profile_id;

  console.log('— 启动真内核 —');
  const started = await manager.startProfile(profiles.getProfile(profileId));
  console.log(`  pid=${started.pid} 内核 ${started.real_version}`);
  check('真内核起来了（下面所有读写都是真的）',
    Number(started.pid) > 0 && !!started.real_version, `${started.pid} / ${started.real_version}`);

  const inst = manager.getInstance(profileId);
  /** 当前内核里的 cookie：name → value */
  async function current() {
    const list = await readCookies(inst.client);
    const m = new Map();
    for (const c of list) if (c.domain === 'example.com' || c.domain === '.example.com') m.set(c.name, c.value);
    return m;
  }
  const exp = Math.floor(Date.now() / 1000) + 86400;
  const cookie = (name, value) => ({ name, value, domain: 'example.com', path: '/', expires: exp, httpOnly: false, secure: false });

  /* 初始状态：sid=old、gone=g（这两条名字就说明了各自要经历什么） */
  const seed = await api('POST', '/api/v2/browser-profile/cookie/import', {
    profile_id: profileId, cookies: [cookie('sid', 'old'), cookie('gone', 'g')],
  });
  check('预置两条 cookie 成功（走真实 /cookie/import）',
    seed?.code === 0 && seed.data.imported === 2, JSON.stringify(seed?.data));
  check('预置后内核里能读到 sid=old、gone=g',
    (await current()).get('sid') === 'old' && (await current()).get('gone') === 'g',
    JSON.stringify([...await current()]));

  /* ---------------- A / B. 还原 = 覆盖 ---------------- */
  console.log('\n— A/B. 还原（覆盖）：预览数字要对得上，文件里没有的要真删掉 —');
  const incomingRestore = [cookie('sid', 'new'), cookie('added', 'a')];
  const preview = await api('POST', '/api/v2/browser-profile/batch/cookie', {
    profile_ids: [profileId], cookies: incomingRestore, mode: 'restore', preview: true,
  });
  const pv = preview?.data?.list?.[0];
  check('还原预览：改 1（sid）、加 1（added）、删 1（gone）',
    preview?.code === 0 && pv?.will_update === 1 && pv?.will_add === 1 && pv?.will_delete === 1,
    JSON.stringify({ u: pv?.will_update, a: pv?.will_add, d: pv?.will_delete }));
  check('预览**不写内核**：这一轮之后 sid 还是 old、gone 还在',
    (await current()).get('sid') === 'old' && (await current()).get('gone') === 'g',
    JSON.stringify([...await current()]));
  check('预览里不带 cookie 的值（登录凭据不上界面、不进日志）',
    !JSON.stringify(preview?.data).includes('"old"') && !JSON.stringify(preview?.data).includes('"new"'),
    JSON.stringify(pv?.sample?.update));

  const applied = await api('POST', '/api/v2/browser-profile/batch/cookie', {
    profile_ids: [profileId], cookies: incomingRestore, mode: 'restore', preview: false,
  });
  const ap = applied?.data?.list?.[0];
  check('还原真写：code=0、写入 2 条、删除 1 条',
    applied?.code === 0 && ap?.applied === true && ap?.written === 2 && ap?.deleted === 1,
    JSON.stringify({ w: ap?.written, d: ap?.deleted, v: ap?.verified }));
  const afterRestore = await current();
  check('覆盖生效：sid 变成 new（同名被改写，不是只跳过）', afterRestore.get('sid') === 'new', String(afterRestore.get('sid')));
  check('覆盖生效：文件里没有的 gone 真的被删掉了（这就是「还原」和「合并」的区别）',
    afterRestore.get('gone') === undefined, JSON.stringify([...afterRestore]));
  check('覆盖生效：added 写进来了',
    afterRestore.get('added') === 'a', String(afterRestore.get('added')));
  check('回读确认数 = 实际写入数（没有假装成功）', ap?.verified === 2, String(ap?.verified));

  /* ---------------- C. 合并 = 并集 ---------------- */
  console.log('\n— C. 合并（并集）：同名以现有为准，只补缺的，一条都不删 —');
  const incomingMerge = [cookie('sid', 'from-file-old-value'), cookie('only-in-file', 'x')];
  const mergePreview = await api('POST', '/api/v2/browser-profile/batch/cookie', {
    profile_ids: [profileId], cookies: incomingMerge, mode: 'merge', preview: true,
  });
  const mp = mergePreview?.data?.list?.[0];
  check('合并预览：加 1（only-in-file）、改 0、删 0、保留现有 1（sid 冲突不覆盖）',
    mp?.will_add === 1 && mp?.will_update === 0 && mp?.will_delete === 0 && mp?.will_keep === 1,
    JSON.stringify({ a: mp?.will_add, u: mp?.will_update, d: mp?.will_delete, k: mp?.will_keep }));

  const merged = await api('POST', '/api/v2/browser-profile/batch/cookie', {
    profile_ids: [profileId], cookies: incomingMerge, mode: 'merge', preview: false,
  });
  const mg = merged?.data?.list?.[0];
  const afterMerge = await current();
  check('合并真写：只写了 1 条、一条都没删',
    merged?.code === 0 && mg?.written === 1 && mg?.deleted === 0,
    JSON.stringify({ w: mg?.written, d: mg?.deleted }));
  check('合并**没覆盖**登录态：sid 仍是 new，不是文件里的 from-file-old-value',
    afterMerge.get('sid') === 'new', String(afterMerge.get('sid')));
  check('合并补上了只存在于文件里的那条', afterMerge.get('only-in-file') === 'x', String(afterMerge.get('only-in-file')));
  check('合并一条都没删（added 还在）', afterMerge.get('added') === 'a', JSON.stringify([...afterMerge]));

  /* ---------------- D. 第二次还原：并集之后仍能整体覆盖 ---------------- */
  console.log('\n— D. 再还原一次：把并集的结果整体覆盖回文件里那份 —');
  const final = await api('POST', '/api/v2/browser-profile/batch/cookie', {
    profile_ids: [profileId], cookies: [cookie('sid', 'final')], mode: 'restore', preview: false,
  });
  const fn = final?.data?.list?.[0];
  const afterFinal = await current();
  check('还原成只剩 sid=final（added / only-in-file 都被删掉）',
    final?.code === 0 && afterFinal.get('sid') === 'final' && afterFinal.size === 1,
    JSON.stringify([...afterFinal]));
  check('删掉的那两条都点了名（N 条删除不是黑箱）',
    fn?.deleted === 2 && fn?.written === 1, JSON.stringify({ w: fn?.written, d: fn?.deleted }));
} catch (e) {
  check('B 层跑完没有抛异常', false, `${e && e.message}`);
  console.error(e);
} finally {
  if (profileId) await manager.stopProfile(profileId).catch(() => {});
  if (server) server.close();
  dbmod.closeDb();
  await sleep(300);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄还在 */ }
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);