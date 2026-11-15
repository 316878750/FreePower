/**
 * 本地备份快照（0.4.7 ②）判据 —— B 层：**真内核**。
 *
 * A 层验的是「文件拷对没拷对、列写对没写对」；这一层只验一件 A 层根本验不了的事：
 * **从快照恢复之后，环境还能真启动，而且登录态真的回来了。**
 *
 * 为什么这条非要有：一份快照最容易骗人的地方是「文件都在、恢复也报成功，但内核起不来」——
 * 比如把 `Cookies` / `Local State` 这类文件拷成了半截、或者漏了 Chrome 启动必需的那个文件。
 * 那种失败在文件层面完全看不出来（大小、数量都对），只有真起一次才知道。
 *
 * 具体做法（全部真磁盘、真内核 157.0.8103.78）：
 *   1. 真启动一个环境 → 用 CDP `Network.setCookie` 在 127.0.0.1 上种一条**探针 cookie**（登录态的替身）
 *      → `Network.getCookies` 读回来确认它在 → 停止；
 *   2. 拍一份快照（此时 userdata 里有真 Chrome 落的 Cookies 库、缓存目录也在）；
 *   3. **模拟丢数据**：把整个 userdata 目录删掉，同时把库里的名字改坏；
 *   4. 从快照恢复；
 *   5. **再真启动一次** → 断言：进程起来了、内核版本对、页面 load 完、
 *      **探针 cookie 还在**（登录态真回来了）、名字回到快照里那个；
 *   6. 反向对照：**在跑的时候不许恢复**（真进程占着 userdata）；
 *   7. 轮转：连拍 6 份 → 最旧那份目录真的从磁盘消失，剩下 5 份里最新的那份仍能恢复并启动。
 *
 * 跑法：node --no-warnings test/snapshots-kernel.test.mjs   （约 60–90 秒，需本机 Chrome）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 自己的数据根：**绝不用仓库里的 data/**，这条判据会真删目录
const dataDir = path.join(os.tmpdir(), `freepower-snapshots-kernel-${Date.now()}`);
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
process.env.FREEPOWER_EGRESS_TIMEOUT = '800';

import http from 'node:http';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 探针页：只要能 load 完就行
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head><meta charset="utf-8"><title>snap probe</title></head>'
    + '<body><div id="d">snap</div></body></html>');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PROBE_URL = `http://127.0.0.1:${srv.address().port}/probe.html`;

const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');
const dbmod = await import('../src/store/db.js');
const snap = await import('../src/store/snapshots.js');
const { readCookies, writeCookies } = await import('../src/kernel/cookies.js');

const PROBE_NAME = 'fp_snap';
const PROBE_VALUE = 'snap-value-7c21';
const dirOf = (p) => manager.userDataDirFor(profiles.getProfile(p.profile_id || p.id));

/** 起环境 → 开探针页 → 等 load 完；返回 {started, inst, ready} */
async function startAndOpen(profileId) {
  const started = await manager.startProfile(profiles.getProfile(profileId));
  const inst = manager.getInstance(profileId);
  const { sessionId } = await inst.openPage(PROBE_URL);
  let ready = '';
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const r = await inst.client.send('Runtime.evaluate', {
      expression: 'document.readyState', returnByValue: true,
    }, sessionId).catch(() => null);
    ready = String(r?.result?.value ?? '');
    if (ready === 'complete') break;
    await sleep(150);
  }
  return { started, inst, ready, sessionId };
}

const ids = [];
try {
  /* ---------------- 1. 造出真登录态：真内核里种一条 cookie ---------------- */
  console.log('\n— 1. 先造一份真登录态（真内核里种 cookie） —');
  const p = profiles.createProfile({ name: `snapk-${Date.now()}`, group_id: '0' });
  ids.push(p.profile_id);
  const first = await startAndOpen(p.profile_id);
  check('环境真启动成功（整条判据的前提）',
    !!first.started.real_version && Number(first.started.pid) > 0,
    `pid=${first.started.pid} 内核 ${first.started.real_version}`);
  check('探针页 load 完（页面是活的，不是白屏）', first.ready === 'complete', first.ready);

  // 用产品自己的写入路径种 cookie（`Storage.setCookies`）—— 和我们「登录态」的定义同一条路
  const seeded = await writeCookies(first.inst.client, [{
    name: PROBE_NAME, value: PROBE_VALUE, domain: '127.0.0.1', path: '/',
  }]);
  check('种 cookie 没报失败', seeded.failed.length === 0, JSON.stringify(seeded.failed));
  const cookiesBefore = await readCookies(first.inst.client).catch(() => []);
  check('种下的探针 cookie 读得回来（这是「恢复后要对上的东西」）',
    cookiesBefore.some((c) => c.name === PROBE_NAME && c.value === PROBE_VALUE),
    JSON.stringify(cookiesBefore.map((c) => c.name)));

  const liveDir = dirOf(p);
  const liveBytes = (() => {
    let n = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const abs = path.join(d, e.name);
        try { if (e.isDirectory()) walk(abs); else n += fs.statSync(abs).size; } catch { /* skip */ }
      }
    };
    walk(liveDir);
    return n;
  })();
  /**
   * 现代 Chrome 把 cookie 库放在 `Default/Network/Cookies`（网络进程独立），
   * 老版本在 `Default/Cookies`。两处都认 —— 这里验的是「登录态的库到底在不在」，不是路径。
   */
  const cookieDbOf = (base) => [
    path.join(base, 'Default', 'Network', 'Cookies'),
    path.join(base, 'Default', 'Cookies'),
  ].find((f) => fs.existsSync(f)) || null;
  check('真内核的 userdata 里有 Cookies 库（不是空目录）',
    !!cookieDbOf(liveDir),
    JSON.stringify(fs.readdirSync(path.join(liveDir, 'Default')).slice(0, 8)));

  await manager.stopProfile(p.profile_id);
  await sleep(600);
  check('停止之后环境不再占着数据目录（后面要整份删掉它）',
    profiles.getProfile(p.profile_id).status !== 'running');

  /* ---------------- 2. 拍快照 ---------------- */
  console.log('\n— 2. 拍快照（缓存不进，登录态进） —');
  const taken = snap.takeSnapshot(profiles.getProfile(p.profile_id), { reason: 'manual' });
  check('快照拍成功', taken.ok === true, JSON.stringify({ ok: taken.ok, reason: taken.reason }));
  const snapId = taken.snapshot.snap_id;
  const snapDir = snap.snapshotDirFor(p.profile_id, snapId);
  check('快照里有 Cookies 库（真内核落盘的登录态库）', !!cookieDbOf(path.join(snapDir, 'userdata')),
    JSON.stringify(cookieDbOf(path.join(snapDir, 'userdata'))));
  check('快照里**没有** `Cache` 这类缓存目录（不然一份快照就是几十 MB）',
    !fs.existsSync(path.join(snapDir, 'userdata', 'Default', 'Cache')));
  check('快照比原 userdata **小**（缓存真的被排除了，不是「排了但没生效」）',
    taken.userdata.bytes > 0 && taken.userdata.bytes < liveBytes,
    JSON.stringify({ snapshot: taken.userdata.bytes, live: liveBytes }));

  /* ---------------- 3. 模拟丢数据：删掉整个 userdata + 改坏名字 ---------------- */
  console.log('\n— 3. 模拟丢数据（删掉整个 userdata，改坏名字） —');
  fs.rmSync(liveDir, { recursive: true, force: true });
  profiles.updateProfile(p.profile_id, { name: '数据丢了的名字' });
  check('（前提）userdata 真的没了', !fs.existsSync(liveDir));
  check('（前提）名字被改坏了', profiles.getProfile(p.profile_id).name === '数据丢了的名字');

  /* ---------------- 4. 从快照恢复 ---------------- */
  console.log('\n— 4. 从快照恢复 —');
  const restored = snap.restoreSnapshot(profiles.getProfile(p.profile_id), snapId);
  check('恢复成功且逐列核对通过',
    restored.ok === true && restored.verified === true,
    JSON.stringify({ ok: restored.ok, verified: restored.verified, reason: restored.reason, diff: restored.diff }));
  check('userdata 被整份换回来（文件数 > 0）',
    restored.userdata.replaced === true && restored.userdata.files > 0, JSON.stringify(restored.userdata));
  check('Cookies 库回到磁盘上', !!cookieDbOf(liveDir), JSON.stringify(cookieDbOf(liveDir)));
  check('名字回到快照里那个', profiles.getProfile(p.profile_id).name !== '数据丢了的名字',
    profiles.getProfile(p.profile_id).name);
  check('恢复前自动留了「恢复前」那份（这时它存的是「数据丢了」的状态）',
    !!restored.before_snapshot?.snap_id && restored.before_snapshot.reason === 'before_restore',
    JSON.stringify(restored.before_snapshot?.snap_id));

  /* ---------------- 5. 恢复之后**能真启动**，而且登录态真的回来了 ---------------- */
  console.log('\n— 5. 恢复后真启动：进程起来 + 登录态回来 —');
  const second = await startAndOpen(p.profile_id);
  check('**恢复后环境真的能启动**（这是整条判据最重要的一条：文件对不对，只有起一次才知道）',
    !!second.started.real_version && Number(second.started.pid) > 0,
    `pid=${second.started.pid} 内核 ${second.started.real_version}`);
  check('恢复后启动用的还是同一个内核版本', second.started.real_version === first.started.real_version,
    `${second.started.real_version} vs ${first.started.real_version}`);
  check('恢复后页面照常 load 完', second.ready === 'complete', second.ready);

  const cookiesAfter = await readCookies(second.inst.client).catch(() => []);
  check('**探针 cookie 还在**（恢复出来的是同一个登录态，不是全新浏览器）',
    cookiesAfter.some((c) => c.name === PROBE_NAME && c.value === PROBE_VALUE),
    JSON.stringify(cookiesAfter.map((c) => c.name)));

  /* ---------------- 6. 在跑的时候不许恢复 ---------------- */
  console.log('\n— 6. 在跑的时候不许恢复（真进程占着 userdata） —');
  const runningNow = profiles.getProfile(p.profile_id);
  const refused = snap.restoreSnapshot(runningNow, snapId);
  check('运行中恢复 → 拒绝（reason=running），不半途失败',
    refused.ok === false && refused.reason === 'running', JSON.stringify({ reason: refused.reason }));
  const alive = await second.inst.client.send('Runtime.evaluate', {
    expression: '1+1', returnByValue: true,
  }, second.sessionId).catch(() => null);
  check('拒绝之后环境照常运行、页面还活着（没被搞坏）',
    !!manager.getRunning(p.profile_id) && second.ready === 'complete' && alive?.result?.value === 2,
    JSON.stringify({ running: !!manager.getRunning(p.profile_id), ready: second.ready, alive: alive?.result?.value }));

  await manager.stopProfile(p.profile_id);
  await sleep(600);

  /* ---------------- 7. 轮转：连拍 6 份，最旧的真从磁盘消失 ---------------- */
  console.log('\n— 7. 连拍 6 份 → 只留 5 份，最旧的真从磁盘消失 —');
  const seen = [snapId];
  let lastEvicted = null;
  for (let i = 0; i < 5; i += 1) {
    const r = snap.takeSnapshot(profiles.getProfile(p.profile_id), { reason: 'manual' });
    seen.push(r.snapshot.snap_id);
    lastEvicted = r.evicted;
  }
  const list = snap.listSnapshots(p.profile_id);
  check('只剩 5 份（上限是 5）', list.length === 5, String(list.length));
  check('被挤掉的是**最旧那份**，且目录真的从磁盘消失',
    !!lastEvicted?.length && !fs.existsSync(snap.snapshotDirFor(p.profile_id, seen[0]))
    && !list.some((s) => s.snap_id === seen[0]),
    JSON.stringify(lastEvicted));

  // 最新那份仍然能恢复 + 能启动（证明轮转没有把「能用的快照」挤掉成坏的）
  const newest = list[0];
  const r2 = snap.restoreSnapshot(profiles.getProfile(p.profile_id), newest.snap_id);
  check('最新那份仍能恢复且核对通过', r2.ok === true && r2.verified === true,
    JSON.stringify({ ok: r2.ok, verified: r2.verified }));
  const third = await manager.startProfile(profiles.getProfile(p.profile_id));
  check('轮转之后再恢复一次，环境仍能真启动',
    !!third.real_version && Number(third.pid) > 0, `pid=${third.pid}`);
  await manager.stopProfile(p.profile_id);
  await sleep(600);

  /* ---------------- 8. 池子满 5 份时恢复最旧那份（目标不许被自己的「恢复前」快照挤掉） ---------------- */
  console.log('\n— 8. 池子满 5 份时恢复最旧那份 → 登录态必须真回来 —');
  {
    const pool = snap.listSnapshots(p.profile_id);
    check('（前提）快照池子满 5 份', pool.length === 5, String(pool.length));
    const oldestSnap = pool[pool.length - 1];

    // 造「登录态没了」：整份 userdata 删掉（不删的话恢复了也看不出差别，会自己跟自己对上）
    fs.rmSync(liveDir, { recursive: true, force: true });
    check('（前提）当前 userdata 已删除', !fs.existsSync(liveDir));

    const rOld = snap.restoreSnapshot(profiles.getProfile(p.profile_id), oldestSnap.snap_id);
    check('恢复最旧那份：成功', rOld.ok === true, JSON.stringify({ ok: rOld.ok, reason: rOld.reason }));
    check('**目标快照没被自己的「恢复前」快照挤掉**（目录还在盘上，还能重试）',
      fs.existsSync(snap.snapshotDirFor(p.profile_id, oldestSnap.snap_id)));
    check('**数据层真的换上了**：verified / verified_data 为 true 且 `replaced:true`',
      rOld.verified === true && rOld.verified_data === true && rOld.userdata.replaced === true,
      JSON.stringify({ verified: rOld.verified, verified_data: rOld.verified_data, userdata: rOld.userdata }));
    check('被挤掉的是**另一份**更旧的快照，且如实报出来（`evicted`）',
      (rOld.evicted || []).length === 1 && rOld.evicted[0].snap_id !== oldestSnap.snap_id
      && rOld.evicted[0].removed === true,
      JSON.stringify(rOld.evicted));

    // 只有起一次内核才知道「登录态真回来了」—— 文件对不代表能读出来
    const fourth = await startAndOpen(p.profile_id);
    check('恢复最旧那份之后环境仍能真启动',
      !!fourth.started.real_version && Number(fourth.started.pid) > 0, `pid=${fourth.started.pid}`);
    const cookiesBack = await readCookies(fourth.inst.client).catch(() => []);
    check('**探针 cookie 真回来了**（半恢复报成功就是这个模式：记录回了、登录态没回）',
      cookiesBack.some((c) => c.name === PROBE_NAME && c.value === PROBE_VALUE),
      JSON.stringify(cookiesBack.map((c) => c.name)));
    await manager.stopProfile(p.profile_id);
    await sleep(600);
  }
} catch (e) {
  check('B 层跑完没有抛异常', false, `${e && e.message}`);
  console.error(e);
} finally {
  for (const id of ids) await manager.stopProfile(id).catch(() => {});
  srv.close();
  dbmod.closeDb();
  await sleep(300);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄还在，留给系统 */ }
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
