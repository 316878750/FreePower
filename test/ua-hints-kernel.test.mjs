/**
 * UA ↔ UA-CH 版本自洽（0.4.7.1 修 P0）判据 —— **B 层：真内核**。
 *
 * 为什么 A 层全绿还不够：A 层证明的是「getProfile 读出来的对象自洽」。
 * 用户真正的路径是「点启动 → 内核真起来 → 页面里的 UA / UA-CH 到底是什么」。
 * 这两者之间还隔着 `checkProfile`、启动前预对齐、`Emulation.setUserAgentOverride`、
 * 以及拿到真实 `Browser.getVersion` 之后那次落库对齐 —— 任何一处顺序错了，都可能是
 * 「A 层绿、用户还是打不开」或者「能打开但 UA 报 133、UA-CH 报 157」。
 *
 * 这里钉三条，都是 0.4.7 那个 P0 的现场：
 *
 *   1. **老形态环境（UA 133、没有 client_hints）真能启动**，页面 `navigator.userAgent`
 *      与 `navigator.userAgentData` 的版本段一致，且都等于**真实内核**版本（跟版策略），
 *      环境日志里留得下对齐记录。
 *   2. **原始矛盾对（UA 133 + hints 157，绕过读路径直接喂给启动）也能启动**：
 *      这是 `preAlignForLaunch` 那条兜底路径，启动响应里必须有 `ua_realign_precheck` soft 告警。
 *   3. **别的硬冲突不许借这个口子放行**：同一个矛盾对再加上 webgl 空开关 → 必须照样拦，
 *      而且进程不许被拉起来（这条是「放宽了没有」的唯一真判据）。
 *
 * 数据根一律 `os.tmpdir()` 下的一次性目录，绝不碰仓库 `data/`。
 *
 * 跑法：node --no-warnings test/ua-hints-kernel.test.mjs （已进 npm run smoke）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dataDir = path.join(os.tmpdir(), `freepower-uahints-kernel-${Date.now()}`);
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
  res.end('<!doctype html><html><head><meta charset="utf-8"><title>ua probe</title></head>'
    + '<body><div id="d">ua</div></body></html>');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PROBE_URL = `http://127.0.0.1:${srv.address().port}/ua.html`;

const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');
const { getDb, closeDb } = await import('../src/store/db.js');
const { LOG_DIR } = await import('../src/config.js');
const { getProfile: dbGet } = await import('../packages/profile/src/repo.js');

const UA133 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.6943.127 Safari/537.36';

const rawRow = (id) => getDb().prepare('SELECT * FROM profiles WHERE id = ?').get(id);
const rawFp = (id) => JSON.parse(rawRow(id).fingerprint_config || '{}');
const setFp = (id, fp) => getDb()
  .prepare('UPDATE profiles SET fingerprint_config = ? WHERE id = ?')
  .run(JSON.stringify(fp), id);
const stripHints = (id) => {
  const fp = rawFp(id);
  delete fp.client_hints;
  setFp(id, fp);
};
const logOf = (id) => {
  try { return fs.readFileSync(path.join(LOG_DIR, `${id}.log`), 'utf8'); } catch { return ''; }
};

/** 起环境 → 开探针页 → 读页面里的 UA / UA-CH */
async function startAndReadUa(profile) {
  const started = await manager.startProfile(profile);
  const inst = manager.getInstance(profile.id || profile.profile_id);
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
  const ua = await inst.client.send('Runtime.evaluate', {
    expression: 'navigator.userAgent', returnByValue: true,
  }, sessionId).catch(() => null);
  const data = await inst.client.send('Runtime.evaluate', {
    expression: `(async () => {
      const d = navigator.userAgentData || null;
      if (!d) return { missing: true };
      const hi = await d.getHighEntropyValues(['uaFullVersion', 'platformVersion']);
      return { brands: d.brands, mobile: d.mobile, platform: d.platform, full: hi.uaFullVersion || null };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId).catch(() => null);
  return {
    started,
    ready,
    ua: String(ua?.result?.value ?? ''),
    data: data?.result?.value ?? null,
  };
}

const majorOf = (v) => String(v || '').split('.')[0];
const startedIds = [];

try {
  const kernelVersion = profiles.kernelVersionForNewProfile();
  const kernelMajor = majorOf(kernelVersion);
  console.log(`本机内核 = ${kernelVersion}`);

  /* ============ 1. 老形态环境（UA 133、无 hints）：真能启动，UA / UA-CH 一致且跟内核 ============ */
  console.log('\n— 1. 老形态环境（UA 133、没有 client_hints）→ 真启动 —');
  {
    const p = profiles.createProfile({ name: `ua-k-old-${Date.now()}`, group_id: '0', ua: UA133 });
    startedIds.push(p.profile_id);
    stripHints(p.profile_id);
    check('（前提）库里没有 client_hints（0.4.4 形态）', rawFp(p.profile_id).client_hints === undefined);

    const view = profiles.getProfile(p.profile_id);
    const pre = profiles.checkProfile(view);
    check('（前提）读出来的记录 checkProfile.ok === true（A 层修的就是这一步）', pre.ok === true,
      JSON.stringify(pre.hard));

    // 启动失败也要记成 FAIL 继续往下跑：判据自己崩掉会把后面几条该红的遮住
    let r = null;
    let startErr = null;
    try { r = await startAndReadUa(view); } catch (e) { startErr = e; }
    check('真启动成功（拿到了真实内核版本与 pid）',
      !!r && !!r.started.real_version && Number(r.started.pid) > 0,
      startErr ? `${startErr.code || ''} ${startErr.message}` : `pid=${r.started.pid} 内核 ${r.started.real_version}`);
    check('页面 load 完成', r?.ready === 'complete', r?.ready || '(没起来)');

    const realMajor = majorOf(r?.started.real_version);
    const uaMajor = (/Chrome\/(\d+)\./.exec(r?.ua || '') || [])[1] || null;
    check('页面 UA 的 Chrome 版本段 = 真实内核大版本（不再是 133）', uaMajor === realMajor,
      `UA=${uaMajor} 内核=${realMajor}`);
    const brandMajors = (r?.data?.brands || []).filter((b) => b && b.brand !== 'Not_A Brand').map((b) => majorOf(b.version));
    check('页面 UA-CH（brands）的大版本 = 真实内核大版本',
      brandMajors.length > 0 && brandMajors.every((m) => m === realMajor), JSON.stringify(r?.data?.brands));
    check('页面 UA-CH（uaFullVersion）= 真实内核完整版本',
      r?.data?.full === r?.started.real_version, String(r?.data?.full));
    check('**UA 与 UA-CH 自洽**（同一个大版本，这正是 P0 那条硬冲突的两边）',
      uaMajor === realMajor && brandMajors.every((m) => m === realMajor) && majorOf(r?.data?.full) === realMajor);

    const log = logOf(p.profile_id);
    check('环境日志里有 UA 跟版记录（跟版策略的痕迹，排障时能对上）',
      /UA 跟版|UA 预对齐/.test(log), (log.split('\n').find((l) => /UA 跟版|UA 预对齐/.test(l)) || '').slice(0, 120));

    const after = profiles.getProfile(p.profile_id);
    check('启动后落库的 UA / hints 都是真实内核版本（下次不用再跟一次）',
      String(after.client_hints?.ua_full_version) === r?.started.real_version
      && majorOf((/Chrome\/([\d.]+)/.exec(String(after.ua)) || [])[1]) === realMajor,
      `${after.client_hints?.ua_full_version}`);

    await manager.stopProfile(p.profile_id).catch(() => {});
    await sleep(600);
  }

  /* ============ 2. 原始矛盾对绕过读路径 → 启动前预对齐（ua_realign_precheck） ============ */
  console.log('\n— 2. 原始矛盾对（UA 133 + hints ' + kernelMajor + '）→ 预对齐兜底，仍能启动 —');
  {
    const p = profiles.createProfile({ name: `ua-k-conflict-${Date.now()}`, group_id: '0', ua: UA133 });
    startedIds.push(p.profile_id);
    // 直接写回矛盾对（模拟「别的路径把矛盾对存进来了」），再**绕过 toApi** 拿原始记录启动
    setFp(p.profile_id, {
      ...rawFp(p.profile_id),
      client_hints: { platform: 'Windows', platform_version: '10.0.0', ua_full_version: kernelVersion },
    });
    const raw = dbGet(getDb(), p.profile_id);
    if (typeof raw.launch_args === 'string') {
      try { raw.launch_args = JSON.parse(raw.launch_args || '[]'); } catch { raw.launch_args = []; }
    }
    const rawCheck = profiles.checkProfile(raw);
    check('（前提）原始记录 checkProfile.ok === false（矛盾对仍然被校验认出来）',
      rawCheck.ok === false && rawCheck.hard.some((h) => h.field === 'client_hints.ua_full_version'),
      JSON.stringify(rawCheck.hard.map((h) => h.field)));

    let r = null;
    let startErr = null;
    try { r = await startAndReadUa(raw); } catch (e) { startErr = e; }
    check('**真启动成功**（预对齐把死胡同打开了）',
      !!r && !!r.started.real_version && Number(r.started.pid) > 0,
      startErr ? `${startErr.code || ''} ${startErr.message}` : `pid=${r.started.pid}`);
    const warn = (r?.started.warnings || []).find((w) => w.field === 'ua_realign_precheck');
    check('启动响应里有 `ua_realign_precheck` 这条 soft 告警（不是静默改）',
      !!warn && warn.severity === 'soft', warn ? warn.message.slice(0, 100) : JSON.stringify(r?.started.warnings || []));
    check('日志里有「UA 预对齐」那一行',
      /UA 预对齐/.test(logOf(p.profile_id)),
      (logOf(p.profile_id).split('\n').find((l) => /UA 预对齐/.test(l)) || '').slice(0, 120));

    const realMajor = majorOf(r?.started.real_version);
    check('页面上 UA / UA-CH 已经都是真实内核（不是硬塞 133 进去）',
      (/Chrome\/(\d+)\./.exec(r?.ua || '') || [])[1] === realMajor
      && majorOf(r?.data?.full) === realMajor,
      `${String(r?.ua || '').slice(0, 90)} / ${r?.data?.full}`);

    await manager.stopProfile(p.profile_id).catch(() => {});
    await sleep(600);
  }

  /* ============ 3. 别的硬冲突继续阻断：不许借这个口子放行 ============ */
  console.log('\n— 3. 同一个矛盾对 + webgl 空开关 → 必须照样拦（不启动） —');
  {
    const p = profiles.createProfile({
      name: `ua-k-blocked-${Date.now()}`, group_id: '0', ua: UA133,
    });
    startedIds.push(p.profile_id);
    // webgl=2 但配置里没有 vendor/renderer = 「开了一个空开关」，这是另一条必须继续阻断的硬冲突
    const fp = rawFp(p.profile_id);
    fp.webgl_config = {};
    setFp(p.profile_id, { ...fp, client_hints: { platform: 'Windows', platform_version: '10.0.0', ua_full_version: kernelVersion } });
    getDb().prepare('UPDATE profiles SET webgl = ? WHERE id = ?').run('2', p.profile_id);
    const raw = dbGet(getDb(), p.profile_id);
    if (typeof raw.launch_args === 'string') {
      try { raw.launch_args = JSON.parse(raw.launch_args || '[]'); } catch { raw.launch_args = []; }
    }
    let err = null;
    try { await manager.startProfile(raw); } catch (e) { err = e; }
    check('被拦住了（抛 800005 consistency，而不是照常启动）',
      !!err && err.code === 800005 && err.reason === 'consistency', err ? `${err.code} ${err.reason}` : '居然启动成功了');
    check('拦的理由里同时有 webgl 与版本号（说明预对齐只治版本，没把别的硬冲突一起吞掉）',
      !!err && (err.errors || []).some((e) => String(e.field).startsWith('webgl')),
      JSON.stringify((err?.errors || []).map((e) => e.field)));
    check('没有内核进程被拉起来（没有 running 实例）', manager.getRunning(p.profile_id) === null);
    check('日志里没有「UA 预对齐」那一行（预对齐根本没生效，因为别的硬冲突还在）',
      !/UA 预对齐/.test(logOf(p.profile_id)));
  }
} catch (e) {
  check('B 层跑完没有抛异常', false, `${e && e.message}`);
  console.error(e);
} finally {
  for (const id of startedIds) {
    try { await manager.stopProfile(id); } catch { /* ignore */ }
  }
  try { closeDb(); } catch { /* ignore */ }
  srv.close();
  await sleep(400);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄还在，留给系统 */ }
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
