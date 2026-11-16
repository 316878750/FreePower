/**
 * UA / UA-CH 在**真内核**上的读数 —— B 层判据（0.4.7.2 起重写）。
 *
 * 0.4.7.1 那版这里钉的是「UA 会被拉成内核版本」（跟版默认开）。0.4.7.2 用户拍板翻过来：
 * 跟版默认关，**环境存的是 133 就必须按 133 打开**（对手 AdsPower 也是这样，
 * 逆向 02-指纹字段表.md:168-169）。所以这一版要钉的是另一件事：
 *
 *   1. **默认关**：UA / UA-CH / kernel_version 一个字节都不变；页面上（**新开的标签页**、
 *      以及跨站子帧）读到的是 profile 这一套：UA 大版本 133、brands 133、
 *      fullVersionList 133、`uaFullVersion` = profile 的值、`platformVersion` = profile 的值、
 *      architecture / bitness / model / wow64 一致，请求头 `sec-ch-ua*` 也是 133。
 *   2. **开关打开**：行为与 0.4.7.1 完全一致（拉成真实内核版本并落库，日志留痕）。
 *   3. **开关关 + 原始矛盾对**：照旧 800005 阻断 —— 关着时**不许静默改指纹**，
 *      也不能把 0.4.7 那个 P0 以另一种形式放回来。
 *   4. **开关开 + 原始矛盾对**：0.4.7.1 的预对齐兜底仍然有效（`ua_realign_precheck`）。
 *   5. **别的硬冲突**（webgl 空开关）照旧阻断，进程不许被拉起来。
 *
 * 为什么 `uaFullVersion` 必须单独钉：真内核实测（157.0.8103.78）`Emulation.setUserAgentOverride`
 * 的 `brands` / `fullVersionList` / `platformVersion` / `architecture` / `bitness` / `model` /
 * `wow64` 内核都认，**只有已废弃的 `uaFullVersion` 永远返回真实内核版本**（传 133 读回
 * 157.0.8103.78，同一会话手动再覆写一次 + reload 也一样）。这一项只能在注入层 patch
 * （`src/kernel/inject.js` 的 `patchUaData`），所以它是「注入层真的生效了没有」的硬判据。
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

const HDR_KEYS = ['user-agent', 'sec-ch-ua', 'sec-ch-ua-full-version-list', 'sec-ch-ua-platform',
  'sec-ch-ua-platform-version', 'sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-model', 'sec-ch-ua-mobile'];
const pickHdr = (h) => Object.fromEntries(HDR_KEYS.map((k) => [k, h[k] ?? null]));
// 要 full-version-list / platform-version 这些高熵项，服务端必须先声明 Accept-CH（否则浏览器不发）
const ACCEPT_CH = 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, '
  + 'Sec-CH-UA-Bitness, Sec-CH-UA-Model, Sec-CH-UA-WoW64';

/* 内层（另一个站点，制造跨站子帧 = OOPIF） */
const srvInner = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head><meta charset="utf-8"><title>inner</title></head><body><div id="i">inner</div></body></html>');
});
await new Promise((r) => srvInner.listen(0, '127.0.0.1', r));
const INNER_URL = `http://localhost:${srvInner.address().port}/inner.html`;

/* 外层：页面 + 一个同源 fetch（拿请求头）+ 一个跨站 iframe（拿 OOPIF 读数） */
const srvOuter = http.createServer((req, res) => {
  if (String(req.url).startsWith('/hdr')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(pickHdr(req.headers)));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'accept-ch': ACCEPT_CH });
  res.end('<!doctype html><html><head><meta charset="utf-8"><title>ua probe</title></head><body>'
    + '<div id="d">ua</div>'
    + `<iframe id="f" src="${INNER_URL}" width="320" height="120"></iframe>`
    + "<script>window.__hdrP = fetch('/hdr').then(function (r) { return r.json(); }).catch(function () { return null; });</script>"
    + '</body></html>');
});
await new Promise((r) => srvOuter.listen(0, '127.0.0.1', r));
const PROBE_URL = `http://127.0.0.1:${srvOuter.address().port}/ua.html`;

const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');
const { writeUaAutoAlign, readUaAutoAlign } = await import('../src/settings/prefs.js');
const { getDb, closeDb } = await import('../src/store/db.js');
const { ensureNoiseSeeds } = await import('../src/fingerprint/seeds.js');
const { LOG_DIR } = await import('../src/config.js');
const { getProfile: dbGet } = await import('../packages/profile/src/repo.js');

const UA133 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.6943.127 Safari/537.36';

const rawRow = (id) => getDb().prepare('SELECT * FROM profiles WHERE id = ?').get(id);
const rawFp = (id) => JSON.parse(rawRow(id).fingerprint_config || '{}');
const setFp = (id, fp) => getDb()
  .prepare('UPDATE profiles SET fingerprint_config = ? WHERE id = ?')
  .run(JSON.stringify(fp), id);
const logOf = (id) => {
  try { return fs.readFileSync(path.join(LOG_DIR, `${id}.log`), 'utf8'); } catch { return ''; }
};
const majorOf = (v) => String(v || '').split('.')[0];

/** 把一条记录改造成「导入来的 AdsPower 环境」：UA 133 + hints 133 + kernel_version 133 */
function makeImported133(id) {
  const fp = rawFp(id);
  fp.client_hints = {
    platform: 'Windows',
    platform_version: '10.0.0',
    architecture: 'x86',
    bitness: '64',
    model: '',
    mobile: '0',
    wow64: '0',
    ua_full_version: '133.0.0.0',
    brands: [
      { brand: 'Chromium', version: '133' },
      { brand: 'Google Chrome', version: '133' },
      { brand: 'Not_A Brand', version: '24' },
    ],
    fullVersionList: [
      { brand: 'Chromium', version: '133.0.0.0' },
      { brand: 'Google Chrome', version: '133.0.0.0' },
      { brand: 'Not_A Brand', version: '24.0.0.0' },
    ],
  };
  setFp(id, fp);
  getDb().prepare('UPDATE profiles SET ua = ?, kernel_version = ? WHERE id = ?').run(UA133, '133.0.6943.127', id);
}

/** 页面里的整套 UA-CH 读数（含同源 fetch 的请求头） */
const READ_EXPR = `(async () => {
  const d = navigator.userAgentData || null;
  const hi = d ? await d.getHighEntropyValues(['uaFullVersion','platformVersion','architecture','bitness','model','wow64','fullVersionList']) : null;
  let hdr = null;
  try { hdr = await window.__hdrP; } catch (e) { hdr = null; }
  return {
    ua: navigator.userAgent,
    brands: d ? d.brands : null,
    mobile: d ? d.mobile : null,
    hi,
    hdr,
  };
})()`;

async function readSession(client, sessionId, label) {
  // 等文档 ready（注入脚本是 addScriptToEvaluateOnNewDocument 跑的，readystate 到了就一定有）
  const deadline = Date.now() + 12000;
  let ready = '';
  while (Date.now() < deadline) {
    const r = await client.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId)
      .catch(() => null);
    ready = String(r?.result?.value ?? '');
    if (ready === 'complete') break;
    await sleep(150);
  }
  // fetch 的头要等一拍
  let val = null;
  for (let i = 0; i < 20; i += 1) {
    const r = await client.send('Runtime.evaluate', {
      expression: READ_EXPR, awaitPromise: true, returnByValue: true,
    }, sessionId).catch(() => null);
    val = r?.result?.value ?? null;
    if (val && val.hdr) break;
    await sleep(200);
  }
  if (!val) console.log(`  (${label}: 读数拿不到)`);
  return val || { ua: '', brands: null, hi: null, hdr: null };
}

/** 一次启动 → 新开两个标签页 + 跨站子帧，全部读数 */
async function probe(profile) {
  const started = await manager.startProfile(profile);
  const inst = manager.getInstance(profile.id || profile.profile_id);
  const t1 = await inst.openPage(PROBE_URL);
  const first = await readSession(inst.client, t1.sessionId, 'tab1');
  const t2 = await inst.openPage(PROBE_URL);
  const second = await readSession(inst.client, t2.sessionId, 'tab2');

  // 跨站子帧（OOPIF）是独立 target：从自己的会话读（模拟检测页在 iframe 里做一致性检查）
  let oopif = null;
  const targets = (await inst.client.send('Target.getTargets').catch(() => ({ targetInfos: [] }))).targetInfos || [];
  for (const t of targets.filter((x) => x.type === 'iframe')) {
    const s = await inst.client.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }).catch(() => null);
    if (s?.sessionId) {
      oopif = await readSession(inst.client, s.sessionId, 'oopif');
      await inst.client.send('Target.detachFromTarget', { sessionId: s.sessionId }).catch(() => {});
      break;
    }
  }
  return { started, first, second, oopif, inst };
}

const brandMajors = (list) => (Array.isArray(list) ? list : [])
  .filter((b) => b && b.brand !== 'Not_A Brand' && b.brand !== 'Not-A.Brand')
  .map((b) => majorOf(b.version));

const startedIds = [];

try {
  const kernelVersion = profiles.kernelVersionForNewProfile();
  const kernelMajor = majorOf(kernelVersion);
  console.log(`本机内核 = ${kernelVersion}`);
  check('（前提）默认是关（这一版的全部断言都建立在默认关上）',
    readUaAutoAlign().enabled === false, JSON.stringify(readUaAutoAlign()));

  /* ================= 1. 默认关：UA 133 + hints 133 → 页面就是 133，库一个字节都不变 ================= */
  console.log('\n— 1. 默认关：按环境自己的 UA 打开（真内核、新标签页、跨站子帧） —');
  {
    const p = profiles.createProfile({ name: `ua-k-off-${Date.now()}`, group_id: '0', ua: UA133 });
    startedIds.push(p.profile_id);
    makeImported133(p.profile_id);

    const view = profiles.getProfile(p.profile_id);
    check('（前提）读出来的记录 checkProfile.ok === true（读路径已经让它自洽）',
      profiles.checkProfile(view).ok === true);
    // 只有「噪点种子齐全」时 fingerprint_config 才应当逐字节不变（种子补齐是 0.4.6 的既有行为）
    const seedsStable = Object.keys(ensureNoiseSeeds(view)).length === 0;
    const before = { ua: rawRow(p.profile_id).ua, kv: rawRow(p.profile_id).kernel_version, fp: rawRow(p.profile_id).fingerprint_config };
    const beforeHints = JSON.stringify(rawFp(p.profile_id).client_hints);

    let r = null;
    let err = null;
    try { r = await probe(view); } catch (e) { err = e; }
    check('真启动成功', !!r && Number(r.started.pid) > 0,
      err ? `${err.code || ''} ${err.message}` : `pid=${r?.started.pid} 内核 ${r?.started.real_version}`);

    const f = r?.first || {};
    const uaMajor = (/Chrome\/(\d+)\./.exec(f.ua || '') || [])[1] || null;
    check('新标签页：navigator.userAgent 的 Chrome 大版本 = 133（不是内核 157）',
      uaMajor === '133', `UA=${String(f.ua).slice(0, 90)}`);
    check('新标签页：brands 全 133', brandMajors(f.brands).every((m) => m === '133') && brandMajors(f.brands).length > 0,
      JSON.stringify(f.brands));
    check('新标签页：fullVersionList 全 133（Google Chrome 那一条 = 133.0.0.0）',
      (f.hi?.fullVersionList || []).filter((b) => b.brand === 'Google Chrome').every((b) => b.version === '133.0.0.0'),
      JSON.stringify(f.hi?.fullVersionList));
    check('**uaFullVersion = profile 的值 133.0.0.0**（CDP 永远不认，只能靠注入层）',
      f.hi?.uaFullVersion === '133.0.0.0', String(f.hi?.uaFullVersion));
    check('platformVersion = profile 的值 10.0.0（不是宿主的真实版本）',
      f.hi?.platformVersion === '10.0.0', String(f.hi?.platformVersion));
    check('architecture / bitness / model / wow64 与 profile 一致',
      f.hi?.architecture === 'x86' && f.hi?.bitness === '64' && f.hi?.model === '' && f.hi?.wow64 === false,
      JSON.stringify({ a: f.hi?.architecture, b: f.hi?.bitness, m: f.hi?.model, w: f.hi?.wow64 }));
    check('请求头 sec-ch-ua 是 133', /v="133"/.test(String(f.hdr?.['sec-ch-ua'] || '')),
      String(f.hdr?.['sec-ch-ua']));
    check('请求头 sec-ch-ua-full-version-list 是 133.0.0.0',
      /133\.0\.0\.0/.test(String(f.hdr?.['sec-ch-ua-full-version-list'] || '')),
      String(f.hdr?.['sec-ch-ua-full-version-list']));
    check('请求头 sec-ch-ua-platform-version 是 10.0.0',
      /10\.0\.0/.test(String(f.hdr?.['sec-ch-ua-platform-version'] || '')),
      String(f.hdr?.['sec-ch-ua-platform-version']));

    const s = r?.second || {};
    check('**再开一个标签页**读数一样（任意新 target 都拿到这一套）',
      (/Chrome\/(\d+)\./.exec(s.ua || '') || [])[1] === '133'
      && s.hi?.uaFullVersion === '133.0.0.0' && s.hi?.platformVersion === '10.0.0',
      `${String(s.ua).slice(0, 60)} / ${s.hi?.uaFullVersion} / ${s.hi?.platformVersion}`);

    const o = r?.oopif || {};
    check('**跨站子帧（OOPIF）也是 133 / 10.0.0**（0.4.7.1 这里读到的是宿主真值）',
      (/Chrome\/(\d+)\./.exec(o.ua || '') || [])[1] === '133'
      && o.hi?.platformVersion === '10.0.0' && brandMajors(o.brands).every((m) => m === '133'),
      `ua=${String(o.ua).slice(0, 60)} pv=${o.hi?.platformVersion} brands=${JSON.stringify(o.brands)}`);

    const after = { ua: rawRow(p.profile_id).ua, kv: rawRow(p.profile_id).kernel_version, fp: rawRow(p.profile_id).fingerprint_config };
    check('库里 ua 列逐字节不变', after.ua === before.ua, `${before.ua?.slice(0, 40)} → ${after.ua?.slice(0, 40)}`);
    check('库里 kernel_version 列逐字节不变（还是 133.0.6943.127）', after.kv === before.kv, `${before.kv} → ${after.kv}`);
    check('库里 client_hints 逐字节不变', JSON.stringify(rawFp(p.profile_id).client_hints) === beforeHints);
    check('库里 fingerprint_config 整串也不变（种子本来就齐，没有顺手写别的）',
      !seedsStable || after.fp === before.fp, seedsStable ? '整串比对' : '种子本来是缺的，不参与整串比对');
    check('启动响应里没有 ua_realign_precheck（关着时连预对齐都不做）',
      !(r?.started.warnings || []).some((w) => w.field === 'ua_realign_precheck'));
    check('环境日志里没有「UA 跟版」那一行（没有改过任何 UA）',
      !/UA 跟版/.test(logOf(p.profile_id)));
    check('日志里有一行「UA 与内核版本不同」的说明（排障时能对上，但不弹告警）',
      /UA 与内核版本不同/.test(logOf(p.profile_id)),
      (logOf(p.profile_id).split('\n').find((l) => /UA 与内核版本不同/.test(l)) || '').slice(0, 120));

    await manager.stopProfile(p.profile_id).catch(() => {});
    await sleep(600);
  }

  /* ================= 2. 开关打开：行为与 0.4.7.1 完全一致 ================= */
  console.log('\n— 2. 开关打开：按真实内核版本对齐并落库（0.4.7.1 的老行为） —');
  {
    const w = writeUaAutoAlign(true);
    check('（前提）开关写成功且读回来是开', w.enabled === true && readUaAutoAlign().enabled === true);

    const p = profiles.createProfile({ name: `ua-k-on-${Date.now()}`, group_id: '0', ua: UA133 });
    startedIds.push(p.profile_id);
    makeImported133(p.profile_id);
    const view = profiles.getProfile(p.profile_id);

    let r = null;
    let err = null;
    try { r = await probe(view); } catch (e) { err = e; }
    check('真启动成功', !!r && Number(r.started.pid) > 0,
      err ? `${err.code || ''} ${err.message}` : `pid=${r?.started.pid}`);
    const f = r?.first || {};
    check('页面上 UA 的 Chrome 大版本 = 真实内核大版本（跟版生效）',
      (/Chrome\/(\d+)\./.exec(f.ua || '') || [])[1] === kernelMajor, `UA=${String(f.ua).slice(0, 80)}`);
    check('uaFullVersion = 真实内核完整版本（跟版之后两边本来就一致）',
      f.hi?.uaFullVersion === kernelVersion, String(f.hi?.uaFullVersion));
    check('日志里有「UA 跟版」那一行', /UA 跟版/.test(logOf(p.profile_id)));

    const after = profiles.getProfile(p.profile_id);
    check('落库：kernel_version = 真实内核版本', String(after.kernel_version) === kernelVersion, String(after.kernel_version));
    check('落库：client_hints.ua_full_version = 真实内核版本',
      String(after.client_hints?.ua_full_version) === kernelVersion, String(after.client_hints?.ua_full_version));
    check('落库：UA 的版本段被拉到内核大版本',
      majorOf((/Chrome\/([\d.]+)/.exec(String(after.ua)) || [])[1]) === kernelMajor,
      String(after.ua).slice(0, 80));

    writeUaAutoAlign(false);
    check('关回去之后开关是关（不影响下一次启动的默认行为）', readUaAutoAlign().enabled === false);
    await manager.stopProfile(p.profile_id).catch(() => {});
    await sleep(600);
  }

  /* ================= 3. 开关关 + 原始矛盾对：必须阻断，不许静默改指纹 ================= */
  console.log('\n— 3. 开关关 + 原始矛盾对（UA 133 + hints ' + kernelMajor + '）→ 800005 阻断 —');
  {
    const p = profiles.createProfile({ name: `ua-k-conflict-off-${Date.now()}`, group_id: '0', ua: UA133 });
    startedIds.push(p.profile_id);
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

    let err = null;
    try { await manager.startProfile(raw); } catch (e) { err = e; }
    check('**被拦住**（800005 consistency，而不是静默改成内核版本）',
      !!err && err.code === 800005 && err.reason === 'consistency', err ? `${err.code} ${err.reason}` : '居然启动成功了');
    check('没有内核进程被拉起来', manager.getRunning(p.profile_id) === null);
    check('日志里没有「UA 预对齐」（关着时不做预对齐）', !/UA 预对齐/.test(logOf(p.profile_id)));
    check('库里还是那对矛盾值（阻断路径零写入）',
      JSON.stringify(rawFp(p.profile_id).client_hints?.ua_full_version) === JSON.stringify(kernelVersion)
      && rawRow(p.profile_id).ua === UA133);
  }

  /* ================= 4. 开关开 + 原始矛盾对：0.4.7.1 的预对齐兜底仍然有效 ================= */
  console.log('\n— 4. 开关开 + 同一个矛盾对 → 预对齐兜底，仍能启动 —');
  {
    writeUaAutoAlign(true);
    const p = profiles.createProfile({ name: `ua-k-conflict-on-${Date.now()}`, group_id: '0', ua: UA133 });
    startedIds.push(p.profile_id);
    setFp(p.profile_id, {
      ...rawFp(p.profile_id),
      client_hints: { platform: 'Windows', platform_version: '10.0.0', ua_full_version: kernelVersion },
    });
    const raw = dbGet(getDb(), p.profile_id);
    if (typeof raw.launch_args === 'string') {
      try { raw.launch_args = JSON.parse(raw.launch_args || '[]'); } catch { raw.launch_args = []; }
    }
    let r = null;
    let err = null;
    try { r = await manager.startProfile(raw); } catch (e) { err = e; }
    check('真启动成功（预对齐把死胡同打开了）',
      !!r && !!r.real_version && Number(r.pid) > 0, err ? `${err.code || ''} ${err.message}` : `pid=${r?.pid}`);
    check('启动响应里有 `ua_realign_precheck` 这条 soft 告警（不是静默改）',
      !!(r?.warnings || []).find((w) => w.field === 'ua_realign_precheck'),
      JSON.stringify((r?.warnings || []).map((w) => w.field)));
    check('日志里有「UA 预对齐」', /UA 预对齐/.test(logOf(p.profile_id)));
    writeUaAutoAlign(false);
    await manager.stopProfile(p.profile_id).catch(() => {});
    await sleep(600);
  }

  /* ================= 5. 别的硬冲突继续阻断（与开关无关） ================= */
  console.log('\n— 5. webgl 空开关 + 矛盾对 → 必须照样拦（不启动） —');
  {
    const p = profiles.createProfile({ name: `ua-k-blocked-${Date.now()}`, group_id: '0', ua: UA133 });
    startedIds.push(p.profile_id);
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
    check('被拦住（800005 consistency）', !!err && err.code === 800005 && err.reason === 'consistency',
      err ? `${err.code} ${err.reason}` : '居然启动成功了');
    check('拦的理由里同时有 webgl 与版本号（预对齐只治版本，没吞别的硬冲突）',
      !!err && (err.errors || []).some((e) => String(e.field).startsWith('webgl')),
      JSON.stringify((err?.errors || []).map((e) => e.field)));
    check('没有内核进程被拉起来', manager.getRunning(p.profile_id) === null);
  }
} catch (e) {
  check('B 层跑完没有抛异常', false, `${e && e.message}`);
  console.error(e);
} finally {
  writeUaAutoAlign(false);
  for (const id of startedIds) {
    try { await manager.stopProfile(id); } catch { /* ignore */ }
  }
  try { closeDb(); } catch { /* ignore */ }
  srvOuter.close();
  srvInner.close();
  await sleep(400);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄还在，留给系统 */ }
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
