/**
 * 关闭环境时自动备份（0.4.7 ③）判据 —— **B 层：真内核**。
 *
 * 为什么必须有这一层：A 层是直接打 `autoSnapshotOnClose()`，证明的是「那个函数会/不会拍」。
 * 但用户真正的路径是「点停止 → 内核退出 → 备份」。中间隔着 `stopProfile` 的一整串动作
 * （detach 同步、`Browser.close`、杀进程树、`markStatus`），任何一处顺序错了都可能是
 * 「备份到了正在写的 userdata」或者「根本没被调到」。所以这里走**真启动 → 真停止**：
 *
 *   1. 开关**关** → 真停一次 → 断言 `snapshots/` 目录里**一份都没多**（盘上的真相，不看返回值）。
 *   2. 开关**开** → 真停一次 → 断言盘上真的多了一份 `on_close`，且里面**有真 Cookies 库**
 *      （不是空目录）。
 *   3. 那一份**能真恢复、恢复后能真启动、探针 cookie 还在** —— 「自动备份出来的东西能用」
 *      才算备份，否则只是占地方。
 *   4. 自动备份失败（把快照目录占住）时，**环境照样停成功**（`stopped:true`），失败看得见。
 *   5. 开着的时候，`clear_cache_after_closing` 同时打开：备份必须**在清缓存之前**做完，
 *      否则备份到的是被删空的目录 —— 这条最容易在重构时把顺序搞反。
 *
 * 数据根一律 `os.tmpdir()` 下的一次性目录，绝不碰仓库 `data/`。
 *
 * 跑法：node --no-warnings test/snapshot-on-close-kernel.test.mjs （已进 npm run smoke）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

// 自己的数据根：**绝不用仓库里的 data/**，这条判据会真删目录
const dataDir = path.join(os.tmpdir(), `freepower-onclose-kernel-${Date.now()}`);
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

const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head><meta charset="utf-8"><title>onclose probe</title></head>'
    + '<body><div id="d">onclose</div></body></html>');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PROBE_URL = `http://127.0.0.1:${srv.address().port}/probe.html`;

const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');
const dbmod = await import('../src/store/db.js');
const snap = await import('../src/store/snapshots.js');
const prefs = await import('../src/settings/prefs.js');
const { readCookies, writeCookies } = await import('../src/kernel/cookies.js');

const PROBE_NAME = 'fp_onclose';
const PROBE_VALUE = 'onclose-value-4a91';
const dirOf = (p) => manager.userDataDirFor(profiles.getProfile(p.profile_id || p.id));
/** 盘上快照目录里的子目录数（**真相**，不看任何返回值） */
const snapDirsOnDisk = (profileId) => {
  try {
    return fs.readdirSync(snap.profileSnapshotsDir(profileId)).filter((n) => !n.startsWith('.')).length;
  } catch { return 0; }
};
const cookieDbOf = (base) => [
  path.join(base, 'Default', 'Network', 'Cookies'),
  path.join(base, 'Default', 'Cookies'),
].find((f) => fs.existsSync(f)) || null;

/** 起环境 → 开探针页 → 等 load 完 */
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
  /* ==================== 1. 开关关着：真停一次，盘上一份都不许多 ==================== */
  console.log('\n— 1. 开关关着 → 真启动、真停止 → 快照一份都没多 —');
  {
    prefs.writeSnapshotOnClose(false);
    const p = profiles.createProfile({ name: `onclose-k-off-${Date.now()}`, group_id: '0' });
    ids.push(p.profile_id);
    const first = await startAndOpen(p.profile_id);
    check('（前提）环境真启动成功', !!first.started.real_version && Number(first.started.pid) > 0,
      `pid=${first.started.pid} 内核 ${first.started.real_version}`);
    check('（前提）探针页 load 完', first.ready === 'complete', first.ready);
    check('（前提）启动时快照目录里 0 份', snapDirsOnDisk(p.profile_id) === 0, String(snapDirsOnDisk(p.profile_id)));

    const stopped = await manager.stopProfile(p.profile_id);
    await sleep(800);
    check('真停成功（`stopped:true`）', stopped.stopped === true, JSON.stringify(stopped));
    check('`stopProfile` 回报 `snapshot_on_close.reason = disabled`',
      stopped.snapshot_on_close?.created === false && stopped.snapshot_on_close?.reason === 'disabled',
      JSON.stringify(stopped.snapshot_on_close));
    check('**盘上一份快照都没多**（不是「没触发」，是真的没有新目录）',
      snapDirsOnDisk(p.profile_id) === 0, String(snapDirsOnDisk(p.profile_id)));
    check('userdata 还在（关着的时候不该动数据）', fs.existsSync(dirOf(p)));
  }

  /* ==================== 2. 开关开着：真停一次，盘上真多一份 on_close ==================== */
  console.log('\n— 2. 开关开着 → 真停止 → 盘上真多一份（含真 Cookies 库） —');
  {
    prefs.writeSnapshotOnClose(true);
    const p = profiles.createProfile({ name: `onclose-k-on-${Date.now()}`, group_id: '0' });
    ids.push(p.profile_id);
    const first = await startAndOpen(p.profile_id);
    check('（前提）环境真启动成功', !!first.started.real_version && Number(first.started.pid) > 0,
      `pid=${first.started.pid}`);
    // 种一条探针 cookie：这一份备份能不能用，要看它能不能把登录态带回来
    const seeded = await writeCookies(first.inst.client, [{
      name: PROBE_NAME, value: PROBE_VALUE, domain: '127.0.0.1', path: '/',
    }]);
    check('（前提）种探针 cookie 没报失败', seeded.failed.length === 0, JSON.stringify(seeded.failed));

    const stopped = await manager.stopProfile(p.profile_id);
    await sleep(800);
    check('真停成功', stopped.stopped === true);
    check('回报 `snapshot_on_close.created = true` 且带 snap_id',
      stopped.snapshot_on_close?.created === true && !!stopped.snapshot_on_close?.snapshot?.snap_id,
      JSON.stringify({ created: stopped.snapshot_on_close?.created, reason: stopped.snapshot_on_close?.reason }));
    check('**盘上真的多了一份**', snapDirsOnDisk(p.profile_id) === 1, String(snapDirsOnDisk(p.profile_id)));

    const list = snap.listSnapshots(p.profile_id);
    check('列表里那份 `reason = on_close`（界面上类型显示「关闭环境时自动」）',
      list.length === 1 && list[0]?.reason === 'on_close' && list[0]?.reason_label === '关闭环境时自动',
      JSON.stringify(list.map((s) => s.reason)));
    check('那份 `taken_while_running:false`（刚停的内核，数据是静的）',
      list[0]?.taken_while_running === false, String(list[0]?.taken_while_running));
    const snapUserdata = path.join(snap.snapshotDirFor(p.profile_id, list[0]?.snap_id || 'none'), 'userdata');
    check('**备份里有真 Cookies 库**（不是空目录 —— 空目录的「备份」等于没有）',
      !!cookieDbOf(snapUserdata), JSON.stringify(cookieDbOf(snapUserdata)));
    check('备份里没有 Cache（缓存不进快照）',
      !fs.existsSync(path.join(snapUserdata, 'Default', 'Cache')));
    check('状态记成成功（设置页显示「上次自动备份：成功」）',
      prefs.readSnapshotOnCloseState(p.profile_id)?.ok === true,
      JSON.stringify(prefs.readSnapshotOnCloseState(p.profile_id)));

    /* ==================== 3. 这一份能真恢复、恢复后能真启动、登录态还在 ==================== */
    console.log('\n— 3. 自动备份出来的那份：能真恢复 + 恢复后能真启动 + 探针 cookie 还在 —');
    // 先把当前数据搞坏（删掉整份 userdata），再恢复自动备份那份
    fs.rmSync(dirOf(p), { recursive: true, force: true });
    check('（前提）当前 userdata 已删除（恢复了才看得出差别）', !fs.existsSync(dirOf(p)));
    const restored = snap.restoreSnapshot(profiles.getProfile(p.profile_id), list[0]?.snap_id || 'none');
    check('从自动备份恢复成功且 `verified:true` / `verified_data:true`',
      restored.ok === true && restored.verified === true && restored.verified_data === true,
      JSON.stringify({ ok: restored.ok, verified: restored.verified, verified_data: restored.verified_data }));
    const second = await startAndOpen(p.profile_id);
    check('**恢复后环境能真启动**', !!second.started.real_version && Number(second.started.pid) > 0,
      `pid=${second.started.pid}`);
    const cookiesBack = await readCookies(second.inst.client).catch(() => []);
    check('**探针 cookie 真回来了**（自动备份存的是能用的登录态，不是摆设）',
      cookiesBack.some((c) => c.name === PROBE_NAME && c.value === PROBE_VALUE),
      JSON.stringify(cookiesBack.map((c) => c.name)));
    await manager.stopProfile(p.profile_id);
    await sleep(800);
    // 注意：上面那次 `restoreSnapshot` 自己也留了一份 `before_restore`，所以基数不是 1。
    // 这里断言的是「**又多了正好一份**」，不是写死总数 —— 写死总数会被「恢复也拍快照」这件事绊倒。
    check('开着开关再停一次 → 正好又拍一份（`on_close` 份数 +1，总数仍 ≤ 5）',
      snap.listSnapshots(p.profile_id).filter((s) => s.reason === 'on_close').length === 2
      && snap.listSnapshots(p.profile_id).length <= 5,
      JSON.stringify(snap.listSnapshots(p.profile_id).map((s) => s.reason)));
  }

  /* ==================== 4. 备份失败不许影响关环境 ==================== */
  console.log('\n— 4. 备份失败 → 环境照样停成功，失败看得见 —');
  {
    prefs.writeSnapshotOnClose(true);
    const p = profiles.createProfile({ name: `onclose-k-fail-${Date.now()}`, group_id: '0' });
    ids.push(p.profile_id);
    const first = await startAndOpen(p.profile_id);
    check('（前提）环境真启动成功', !!first.started.real_version, `pid=${first.started.pid}`);

    // 造真实失败：把 `snapshots/<id>` 的位置换成**文件**，mkdir 会 ENOTDIR（不是 mock）
    const root = snap.profileSnapshotsDir(p.profile_id);
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.writeFileSync(root, 'not a directory');

    const stopped = await manager.stopProfile(p.profile_id);
    await sleep(500);
    check('**环境照样停成功**（备份失败不许拦着关环境）', stopped.stopped === true, JSON.stringify(stopped));
    check('回报 `created:false` 且带 reason', stopped.snapshot_on_close?.created === false
      && !!stopped.snapshot_on_close?.reason, JSON.stringify(stopped.snapshot_on_close));
    check('**失败被记下来**（界面能显示「上次自动备份失败」）',
      prefs.readSnapshotOnCloseState(p.profile_id)?.ok === false,
      JSON.stringify(prefs.readSnapshotOnCloseState(p.profile_id)));
    check('进程真的没了（不是「报停了但内核还活着」）', !manager.getRunning(p.profile_id));
    check('环境记录 status 回到 idle', profiles.getProfile(p.profile_id).status === 'idle',
      profiles.getProfile(p.profile_id).status);
    const logFile = path.join(dataDir, 'logs', `${p.profile_id}.log`);
    const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    check('日志里有一行 `snapshot_on_close - fail`', logText.includes('snapshot_on_close - fail'),
      logText.split('\n').filter((x) => x.includes('snapshot_on_close')).join(' | '));
    fs.rmSync(root, { force: true });
  }

  /* ==================== 5. 与 clear_cache_after_closing 同时开：备份必须在清缓存之前 ==================== */
  console.log('\n— 5. 同时开 `clear_cache_after_closing`：备份先做完，再清目录 —');
  {
    prefs.writeSnapshotOnClose(true);
    const p = profiles.createProfile({ name: `onclose-k-purge-${Date.now()}`, group_id: '0' });
    ids.push(p.profile_id);
    profiles.applyProfileFields(p.profile_id, { clear_cache_after_closing: '1' });
    const first = await startAndOpen(p.profile_id);
    check('（前提）环境真启动成功', !!first.started.real_version, `pid=${first.started.pid}`);
    const seeded = await writeCookies(first.inst.client, [{
      name: PROBE_NAME, value: PROBE_VALUE, domain: '127.0.0.1', path: '/',
    }]);
    check('（前提）种探针 cookie 没报失败', seeded.failed.length === 0, JSON.stringify(seeded.failed));

    const stopped = await manager.stopProfile(p.profile_id);
    // clear_cache_after_closing 是 2 秒后删整个 userdata；等它做完再断言
    await sleep(3500);
    check('真停成功且备份 `created:true`', stopped.stopped === true
      && stopped.snapshot_on_close?.created === true, JSON.stringify(stopped.snapshot_on_close));
    check('（前提）`clear_cache_after_closing` 真的把 userdata 删了',
      !fs.existsSync(dirOf(p)), String(fs.existsSync(dirOf(p))));
    const list = snap.listSnapshots(p.profile_id);
    check('**备份在清缓存之前做完**：快照还在、且里面有真 Cookies 库（不是被删空的目录）',
      list.length === 1 && !!cookieDbOf(path.join(snap.snapshotDirFor(p.profile_id, list[0]?.snap_id || 'none'), 'userdata')),
      JSON.stringify({ count: list.length, cookie: cookieDbOf(path.join(snap.snapshotDirFor(p.profile_id, list[0]?.snap_id || 'none'), 'userdata')) }));
    // 恢复这份备份 → 环境能再启动（证明「关环境时顺手备份 + 清缓存」这条组合拳不是数据黑洞）
    const back = snap.restoreSnapshot(profiles.getProfile(p.profile_id), list[0]?.snap_id || 'none');
    check('从这份备份恢复成功', back.ok === true && back.verified === true,
      JSON.stringify({ ok: back.ok, verified: back.verified }));
    const again = await startAndOpen(p.profile_id);
    check('恢复后环境能真启动', !!again.started.real_version, `pid=${again.started.pid}`);
    const cookiesAgain = await readCookies(again.inst.client).catch(() => []);
    check('登录态也回来了', cookiesAgain.some((c) => c.name === PROBE_NAME && c.value === PROBE_VALUE),
      JSON.stringify(cookiesAgain.map((c) => c.name)));
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
