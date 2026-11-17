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

/* 内层（另一个站点，制造跨站子帧 = OOPIF）。
 * **读数由子帧自己读、自己 postMessage 回父页** —— 判据不许用 CDP 直读子帧 target：
 * CDP 会话里读到的是「补丁装好了没有」，不是「页面看到的是什么」（0.4.7.2 第三版实测：
 * 同一子帧，页面侧 `uaFullVersion` 是 157.0.8103.78，CDP 侧是 133.0.6943.127）。 */
const srvInner = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head><meta charset="utf-8"><title>inner</title></head><body>'
    + '<div id="i">inner</div>'
    + `<script>
(function () {
  var buf = [];
  function push(tag) {
    var d = navigator.userAgentData;
    if (!d) { buf.push({ tag: tag, no: 1 }); try { parent.postMessage(JSON.stringify(buf), '*'); } catch (e) {} return; }
    d.getHighEntropyValues(['uaFullVersion', 'platformVersion', 'fullVersionList']).then(function (hi) {
      buf.push({
        tag: tag,
        ua: navigator.userAgent,
        ufv: hi.uaFullVersion,
        pv: hi.platformVersion,
        fvl: hi.fullVersionList || null,
        at: Math.round(performance.now()),
      });
      try { parent.postMessage(JSON.stringify(buf), '*'); } catch (e) {}
    }).catch(function () {});
  }
  push('parse');
  document.addEventListener('DOMContentLoaded', function () { push('dcl'); });
  window.addEventListener('load', function () { push('load'); });
})();
</script>`
    + '</body></html>');
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
    + "<script>window.__child = [];addEventListener('message', function (e) { try { var v = JSON.parse(e.data); if (Array.isArray(v)) window.__child = v; } catch (err) {} });</script>"
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
const chromeMod = await import('../src/kernel/chrome.js');

/**
 * 「本机内核」必须是**真值**：真启动一次内核，读 `Browser.getVersion`。
 *
 * 不能取 `Application\` 下最大版本目录名 —— Windows 上 Chrome 自动更新是「先把新版本目录落盘、
 * 等 Chrome 完全退出才把 `new_chrome.exe` 换成 `chrome.exe`」，落盘到生效之间启动器跑的仍是旧版。
 * 2026-11-17 实测：目录里有 `.78`（11-12）和 `.79`（当天 17:38 落盘），`chrome.exe` 的
 * FileVersion 还是 .78，注册表 pv 已是 .79 —— 按目录名取最大值就会把判据基准钉到 .79，
 * 而产品真值是 .78，于是「uaFullVersion = 真实内核版本」那几条假红。
 */
async function probeRealKernelVersion() {
  const k = chromeMod.findChrome();
  if (!k || !k.path) throw new Error('找不到本机内核，判据没法钉基准');
  const ud = path.join(os.tmpdir(), `freepower-uahints-probe-${Date.now()}`);
  const child = chromeMod.launchChrome(k.path, [
    `--user-data-dir=${ud}`,
    '--remote-debugging-port=0',
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ]);
  try {
    const { port } = await chromeMod.waitForDevToolsPort(ud, { timeoutMs: 25000, child });
    const browser = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 8000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => { try { resolve(JSON.parse(body).Browser); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
    const m = /Chrome\/(\d+\.\d+\.\d+\.\d+)/.exec(String(browser || ''));
    if (!m) throw new Error(`Browser.getVersion 里没有四段版本号：${browser}`);
    return { version: m[1], browser, exe: k.path, guessed: k.version || null, source: k.source || null };
  } finally {
    try { chromeMod.killProcessTree(child.pid); } catch { /* 已经退了 */ }
    await sleep(300);
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch { /* 句柄还在，留给系统 */ }
  }
}

/** 产品 `kernelVersionForNewProfile()` 的取法：内核 exe 同级目录里版本号目录的最大值 */
function maxVersionDirOf(exePath) {
  const cmp = (a, b) => {
    const x = a.split('.').map(Number);
    const y = b.split('.').map(Number);
    for (let i = 0; i < 4; i += 1) if (x[i] !== y[i]) return y[i] - x[i];
    return 0;
  };
  try {
    const list = fs.readdirSync(path.dirname(exePath))
      .filter((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x))
      .sort(cmp);
    return list[0] || null;
  } catch {
    return null;
  }
}

const UA133 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.6943.127 Safari/537.36';
/** 只有大版本、没有补丁号的那种 UA（导入文件里偶尔就是这么写的） */
const UA133_BARE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133 Safari/537.36';

const rawRow = (id) => getDb().prepare('SELECT * FROM profiles WHERE id = ?').get(id);
const rawFp = (id) => JSON.parse(rawRow(id).fingerprint_config || '{}');
const setFp = (id, fp) => getDb()
  .prepare('UPDATE profiles SET fingerprint_config = ? WHERE id = ?')
  .run(JSON.stringify(fp), id);
const logOf = (id) => {
  try { return fs.readFileSync(path.join(LOG_DIR, `${id}.log`), 'utf8'); } catch { return ''; }
};
/** 把 hints 从库里摘掉 = 0.4.4 那种「client_hints 列是 NULL」的老形态（0.4.7.2 版本号判据要用） */
const stripHints = (id) => {
  const fp = rawFp(id);
  delete fp.client_hints;
  setFp(id, fp);
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

/**
 * 读**父页里**那个 `window.__child`（子帧自己 postMessage 出来的读数）。
 * 口径就是「页面自己看到什么」—— 不再 attach 子帧 target 用 CDP 读。
 */
async function readChildReadings(client, sessionId, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let reads = [];
  while (Date.now() < deadline) {
    const r = await client.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__child || [])', returnByValue: true,
    }, sessionId).catch(() => null);
    try { reads = JSON.parse(r?.result?.value || '[]'); } catch { reads = []; }
    if (reads.some((x) => x.tag === 'load')) break;
    await sleep(150);
  }
  if (!reads.length) console.log('  (oopif: 子帧一条读数都没送出来)');
  return { reads, parse: reads.find((x) => x.tag === 'parse') || null, load: reads.find((x) => x.tag === 'load') || null };
}

/** 一次启动 → 新开两个标签页 + 跨站子帧，全部读数 */
async function probe(profile) {
  const started = await manager.startProfile(profile);
  const inst = manager.getInstance(profile.id || profile.profile_id);
  const t1 = await inst.openPage(PROBE_URL);
  const first = await readSession(inst.client, t1.sessionId, 'tab1');
  // 跨站子帧（OOPIF）是独立 target，但读数只能取「页面自己看到的」：子帧 postMessage → 父页收集
  const oopif = await readChildReadings(inst.client, t1.sessionId);
  const t2 = await inst.openPage(PROBE_URL);
  const second = await readSession(inst.client, t2.sessionId, 'tab2');
  return { started, first, second, oopif, inst };
}

const brandMajors = (list) => (Array.isArray(list) ? list : [])
  .filter((b) => b && b.brand !== 'Not_A Brand' && b.brand !== 'Not-A.Brand')
  .map((b) => majorOf(b.version));

const startedIds = [];

try {
  // 基准 = 真启动一次内核读 Browser.getVersion（不是目录名；见 probeRealKernelVersion 注释）
  const real = await probeRealKernelVersion();
  const kernelVersion = real.version;
  const kernelMajor = majorOf(kernelVersion);
  console.log(`本机内核 = ${kernelVersion}（真启动 Browser.getVersion；目录名猜的是 ${real.guessed}）`);
  check('（前提）判据基准取自真启动内核（Browser.getVersion），不是 Application\\ 下最大版本目录名',
    !!kernelVersion && /^\d+\.\d+\.\d+\.\d+$/.test(kernelVersion),
    `${kernelVersion}（${real.browser}）`);

  /* 已知缺陷单独钉一条（CEO 要求：接受缺陷不等于删断言）：
   * 产品新建环境的 `kernel_version` 取的是目录名，Chrome 更新落盘未生效时会比实际内核新一个补丁号。
   * 断言的是**当前真实行为**（取目录名）；哪天产品改成真值，这条会红，逼着改文档与口径。 */
  const maxDir = maxVersionDirOf(real.exe);
  const guess = profiles.kernelVersionForNewProfile();
  check('已知缺陷 · 计划 0.4.8 修：新建环境的 kernel_version 取 Application\\ 下最大版本目录名，'
    + 'Chrome 更新落盘未生效时会比实际内核新一个补丁号（本机此刻 '
    + (guess === kernelVersion ? '一致' : '不一致') + '）',
    maxDir ? guess === maxDir : guess === kernelVersion,
    `目录名=${guess} 实际内核=${kernelVersion}`
    + (maxDir ? ` 目录最大=${maxDir}` : '（找不到版本目录，退回比对真值）'));

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
    const oParse = o.parse || {};
    const oLoad = o.load || {};
    const fvlMajor = (list) => (Array.isArray(list) ? list : [])
      .filter((b) => b && b.brand !== 'Not_A Brand' && b.brand !== 'Not-A.Brand')
      .map((b) => majorOf(b.version));
    /* 口径：这两条读的是**子帧页面自己**看到的值（子帧 postMessage 回父页），
     * 不是 CDP 直读子帧 target —— CDP 侧那条只会继续骗人，已经删掉。
     *
     * ① CDP 原生覆写从首字节就生效：brands / fullVersionList / platformVersion 都对。
     * ② `uaFullVersion` 是**已知缺陷**：跨站子帧里页面在补丁落地前读到的是宿主真值，
     *    8 秒内都不会翻过来（补丁只在外部调试会话挂上去之后才"看得见"）。
     *    这条断言把缺陷钉死：哪天修好了它会红，逼着改文档、改口径。 */
    check('跨站子帧（OOPIF）**首字节**就是 133 / 10.0.0（页面自己读：UA、brands、fullVersionList、platformVersion 全对）',
      (/Chrome\/(\d+)\./.exec(oParse.ua || '') || [])[1] === '133'
      && fvlMajor(oParse.fvl).every((m) => m === '133') && fvlMajor(oParse.fvl).length > 0
      && oParse.pv === '10.0.0',
      `parse: ua=${String(oParse.ua).slice(-40)} pv=${oParse.pv} fvl=${JSON.stringify(oParse.fvl)}`);
    check('**已知缺陷（0.4.8 再修）：跨站子帧里页面在补丁落地前读到的 uaFullVersion 仍是真实内核版本**'
      + '（解析期与 load 后都一样；CDP 侧读到 133 是假象，判据不许用它）',
      !!oParse.ufv && oParse.ufv === kernelVersion && oLoad.ufv === kernelVersion,
      `parse=${oParse.ufv} load=${oLoad.ufv}（内核 ${kernelVersion}）`);

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

  /* ================= 1b. 版本号做实：UA 写全了就按 UA 的四段 ================= */
  console.log('\n— 1b. 读路径派生的完整版本号取自 UA（不再一律打码成 <major>.0.0.0） —');
  {
    // ① UA 写全了 133.0.6943.127 → 页面 uaFullVersion / fullVersionList 都是它
    const p = profiles.createProfile({ name: `ua-k-full-${Date.now()}`, group_id: '0', ua: UA133 });
    startedIds.push(p.profile_id);
    stripHints(p.profile_id);
    const view = profiles.getProfile(p.profile_id);
    check('（前提）UA 133.0.6943.127 + 无 hints → 读路径派生 133.0.6943.127（不是打码的 133.0.0.0）',
      view.client_hints?.ua_full_version === '133.0.6943.127', String(view.client_hints?.ua_full_version));
    let r = null;
    let err = null;
    try { r = await probe(view); } catch (e) { err = e; }
    check('真启动成功（UA 四段 + 派生 hints）', !!r && Number(r.started.pid) > 0,
      err ? `${err.code || ''} ${err.message}` : `pid=${r?.started.pid}`);
    const f = r?.first || {};
    check('**页面 uaFullVersion = 133.0.6943.127**（UA 里那四段，不是 133.0.0.0）',
      f.hi?.uaFullVersion === '133.0.6943.127', String(f.hi?.uaFullVersion));
    check('**页面 fullVersionList 的 Google Chrome = 133.0.6943.127**（UA 与 UA-CH 四段一致，不再露后三段）',
      (f.hi?.fullVersionList || []).filter((b) => b.brand === 'Google Chrome').every((b) => b.version === '133.0.6943.127')
      && (f.hi?.fullVersionList || []).some((b) => b.brand === 'Google Chrome'),
      JSON.stringify(f.hi?.fullVersionList));
    await manager.stopProfile(p.profile_id).catch(() => {});
    await sleep(600);

    // ② UA 只有 Chrome/133（没写全）→ 仍回落 133.0.0.0
    const p2 = profiles.createProfile({ name: `ua-k-bare-${Date.now()}`, group_id: '0', ua: UA133_BARE });
    startedIds.push(p2.profile_id);
    stripHints(p2.profile_id);
    const view2 = profiles.getProfile(p2.profile_id);
    check('（前提）UA 只有 Chrome/133 → 读路径仍回落 133.0.0.0',
      view2.client_hints?.ua_full_version === '133.0.0.0', String(view2.client_hints?.ua_full_version));
    let r2 = null;
    let err2 = null;
    try { r2 = await probe(view2); } catch (e) { err2 = e; }
    check('真启动成功（UA 只有大版本也能起）', !!r2 && Number(r2.started.pid) > 0,
      err2 ? `${err2.code || ''} ${err2.message}` : `pid=${r2?.started.pid}`);
    check('页面 uaFullVersion 仍是 133.0.0.0（UA 没声称补丁号，打码不自相矛盾）',
      r2?.first?.hi?.uaFullVersion === '133.0.0.0', String(r2?.first?.hi?.uaFullVersion));
    await manager.stopProfile(p2.profile_id).catch(() => {});
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
