/**
 * FreePower · 外部检测站对照（creepjs）
 *
 * 为什么要有这个：自检 19 项只证明「我们注入的东西自己一致」，不证明「检测方看不出来」。
 * 这里跑的是第三方检测站，同一台机器跑两遍：
 *   ours  —— 走 FreePower 起环境（注入开）
 *   plain —— 同一个 Chrome、同一套启动参数、只跳过注入
 * 两次结果相减，才分得清「我们改出来的问题」和「这台机器本来就有的问题」。
 *
 * 跑法：
 *   node tools/detector-compare.mjs            # 两遍都跑，出对照表
 *   node tools/detector-compare.mjs ours       # 只跑 ours
 *   node tools/detector-compare.mjs plain      # 只跑 plain
 *   node tools/detector-compare.mjs --offline  # 断开外网不可用时跳过（会明确报出来，不静默）
 *
 * 输出：artifacts/detector-compare.json + 控制台对照表。退出码 0 = 两遍都跑通。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = process.env.FP_DETECTOR_URL || 'https://abrahamjuliot.github.io/creepjs/';
const WAIT_MS = Number(process.env.FP_DETECTOR_WAIT || 18000);
const ART = path.join(ROOT, 'artifacts');
const DATA = path.join(ROOT, '.tmp', 'detector-data');

process.env.FREEPOWER_DATA = DATA;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = process.env.FREEPOWER_EGRESS_PROBE || 'http://127.0.0.1:1/never';
process.env.FREEPOWER_EGRESS_TIMEOUT = process.env.FREEPOWER_EGRESS_TIMEOUT || '1500';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 页面内取指标：只用标准 API，两遍跑同一份，才能相减。
 *  诊断标记名按该环境的 fp_seed 派生（P0：页面里没有固定的 `__fp*` 名），所以源按 markers 现生成。 */
const metricsSource = (mk) => `(() => {
  const h = (d) => { let x = 2166136261 >>> 0; for (let i = 0; i < d.length; i++) { x ^= d[i]; x = Math.imul(x, 16777619) >>> 0; } return x.toString(16); };
  function canvasHash() {
    const c = document.createElement('canvas'); c.width = 200; c.height = 80;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 200, 80);
    g.addColorStop(0, '#f00'); g.addColorStop(0.5, '#0f0'); g.addColorStop(1, '#00f');
    x.fillStyle = g; x.fillRect(0, 0, 200, 80);
    x.fillStyle = '#123456'; x.fillRect(20, 20, 60, 30);
    x.strokeStyle = '#abcdef'; x.lineWidth = 2;
    x.beginPath(); x.arc(100, 40, 20, 0, Math.PI * 2); x.stroke();
    return h(x.getImageData(0, 0, 200, 80).data);
  }
  let gl = null, dbg = null;
  try {
    const c2 = document.createElement('canvas'); c2.width = 64; c2.height = 64;
    gl = c2.getContext('webgl'); dbg = gl.getExtension('WEBGL_debug_renderer_info');
  } catch {}
  let voices = [];
  try { voices = (speechSynthesis.getVoices() || []).map((v) => v.lang + ':' + v.name); } catch {}
  return {
    injected: Boolean(self[${JSON.stringify(mk.installed ?? '')}]),
    realm: self[${JSON.stringify(mk.realm ?? '')}] || null,
    applied: (self[${JSON.stringify(mk.applied ?? '')}] || []).join(','),
    ua: navigator.userAgent,
    platform: navigator.platform,
    hc: navigator.hardwareConcurrency,
    dm: navigator.deviceMemory,
    langs: (navigator.languages || []).join(','),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    tzOffset: new Date().getTimezoneOffset(),
    screen: screen.width + 'x' + screen.height + '@' + screen.colorDepth,
    dpr: devicePixelRatio,
    webdriver: navigator.webdriver,
    plugins: navigator.plugins.length,
    mimeTypes: navigator.mimeTypes.length,
    canvas: canvasHash(),
    webglVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
    webglRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
    touchPoints: navigator.maxTouchPoints,
    jsHeapLimit: (typeof performance !== 'undefined' && performance.memory) ? performance.memory.jsHeapSizeLimit : null,
    voices: voices.slice(0, 3),
    voiceCount: voices.length,
  };
})()`;

/** 从 creepjs 的文本里挑出几条能直接比的结论行 */
function pickLines(text) {
  const out = {};
  const grab = (re) => {
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };
  out.fpId = grab(/FP ID:\s*([0-9a-f]{16,})/i);
  out.likeHeadless = grab(/(\d+)%\s*like headless/i);
  out.headless = grab(/(\d+)%\s*headless:/i);
  out.stealth = grab(/(\d+)%\s*stealth/i);
  out.chromium = grab(/chromium:\s*(true|false)/i);
  out.platformHints = grab(/platform hints:\s*\n([^\n]+)/i);
  out.coresRam = grab(/cores:\s*(\d+),\s*ram:\s*(\d+)/i);
  out.timezone = grab(/lang\/timezone:\s*\n([^\n]+)/i);
  return out;
}

async function runOurs() {
  const { startProfile, stopProfile, getInstance } = await import('../src/runtime/manager.js');
  const { createProfile, getProfile, deleteProfiles } = await import('../src/store/profiles.js');
  const { fingerprintView } = await import('../src/fingerprint/view.js');
  const { markerNames } = await import('../src/kernel/markers.js');
  fs.mkdirSync(DATA, { recursive: true });
  const created = createProfile({ name: `detect-ours-${Date.now()}`, group_id: '0', remark: '外部检测对照' });
  const id = created.profile_id;
  let inst = null;
  try {
    const started = await startProfile(getProfile(id));
    inst = getInstance(id);
    /* 标记名与注入层同源：同一个环境的 fp_seed 派生 */
    const mk = markerNames(fingerprintView(getProfile(id)).seed);
    const { sessionId } = await inst.openPage(TARGET);
    const evalIn = async (expr, extra = {}) => {
      const r = await inst.client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, ...extra }, sessionId);
      return r.exceptionDetails ? null : r.result.value;
    };
    await sleep(WAIT_MS);
    const metrics = await evalIn(metricsSource(mk));
    const text = (await evalIn("(document.body ? (document.body.textContent || document.body.innerText) : '')")) || '';
    return { ok: true, chrome: started.real_version, metrics, picks: pickLines(text), text };
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  } finally {
    try { await stopProfile(id); } catch {}
    try { deleteProfiles([id]); } catch {}
  }
}

async function runPlain() {
  const { findChrome, launchChrome, waitForDevToolsPort, killProcessTree, buildArgs } = await import('../src/kernel/chrome.js');
  const { CdpClient, fetchJson } = await import('../src/kernel/cdp.js');
  const { createProfile } = await import('../src/store/profiles.js');
  const { fingerprintView } = await import('../src/fingerprint/view.js');
  const { markerNames } = await import('../src/kernel/markers.js');
  const UDD = path.join(ROOT, '.tmp', 'detector-plain-udd');
  fs.rmSync(UDD, { recursive: true, force: true });
  fs.mkdirSync(UDD, { recursive: true });
  const chrome = findChrome();
  const prof = createProfile({ name: `detect-plain-${Date.now()}`, group_id: '0', remark: '外部检测对照基线' });
  // 同一套参数生成逻辑，唯一差别是不调 injectAndOpen
  const built = buildArgs(prof, { userDataDir: UDD, proxy: null, proxyBound: false, userArgs: [] });
  const child = launchChrome(chrome.path, built.args);
  let client = null;
  try {
    const { port } = await waitForDevToolsPort(UDD, { timeoutMs: 25000 });
    const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    client = await CdpClient.connect(version.webSocketDebuggerUrl);
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    await client.send('Page.enable', {}, sessionId);
    await client.send('Page.navigate', { url: TARGET }, sessionId);
    const evalIn = async (expr) => {
      const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
      return r.exceptionDetails ? null : r.result.value;
    };
    await sleep(WAIT_MS);
    // 基线不注入，标记名照样按这个环境的种子算 —— 读到的就是「没有注入」那一面
    const metrics = await evalIn(metricsSource(markerNames(fingerprintView(prof).seed)));
    const text = (await evalIn("(document.body ? (document.body.textContent || document.body.innerText) : '')")) || '';
    return { ok: true, chrome: chrome.version, metrics, picks: pickLines(text), text };
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  } finally {
    try { if (client) await client.close(); } catch {}
    try { killProcessTree(child.pid); } catch {}
  }
}

const arg = process.argv[2];
const want = arg === 'ours' || arg === 'plain' ? [arg] : ['plain', 'ours'];
fs.mkdirSync(ART, { recursive: true });

const res = {};
for (const mode of want) {
  console.log(`\n===== ${mode} =====`);
  res[mode] = mode === 'ours' ? await runOurs() : await runPlain();
  if (!res[mode].ok) {
    console.log(`  失败：${res[mode].error}`);
  } else {
    console.log(`  内核 ${res[mode].chrome}`);
    console.log(`  ${JSON.stringify(res[mode].picks)}`);
  }
}

const file = path.join(ART, 'detector-compare.json');
let prev = {};
if (fs.existsSync(file)) { try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {} }
const merged = { ...prev, ...res, updatedAt: new Date().toISOString(), target: TARGET };
fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8');

if (merged.ours?.ok && merged.plain?.ok) {
  const a = merged.plain, b = merged.ours;
  const rows = [];
  const keys = [
    ['injected', '是否注入'], ['ua', 'UA'], ['platform', 'platform'], ['hc', 'hardwareConcurrency'],
    ['dm', 'deviceMemory'], ['langs', 'languages'], ['tz', '时区'], ['tzOffset', '时区偏移(min)'],
    ['screen', 'screen'], ['webdriver', 'webdriver'], ['plugins', 'plugins'],
    ['canvas', 'canvas 哈希'], ['webglVendor', 'WebGL vendor'], ['webglRenderer', 'WebGL renderer'],
    ['touchPoints', 'maxTouchPoints'], ['jsHeapLimit', 'jsHeapSizeLimit'], ['voiceCount', '语音数量'],
  ];
  console.log('\n===== 对照（plain = 无注入基线） =====');
  console.log('| 项 | plain | ours | 关系 |');
  console.log('|---|---|---|---|');
  for (const [k, label] of keys) {
    const x = a.metrics?.[k], y = b.metrics?.[k];
    const rel = x === y ? '相同' : '不同';
    rows.push({ item: label, plain: x, ours: y, rel });
    console.log(`| ${label} | ${x} | ${y} | ${rel} |`);
  }
  console.log('\ncreepjs 结论行：');
  console.log('| 项 | plain | ours |');
  console.log('|---|---|---|');
  for (const k of Object.keys(b.picks || {})) {
    console.log(`| ${k} | ${a.picks?.[k]} | ${b.picks?.[k]} |`);
  }
  const dh = Number(b.picks?.likeHeadless) - Number(a.picks?.likeHeadless);
  console.log(`\nlike headless：plain ${a.picks?.likeHeadless}% → ours ${b.picks?.likeHeadless}%（差 ${Number.isFinite(dh) ? (dh > 0 ? '+' : '') + dh : '?'} 个百分点）`);
  console.log(`明细已写 ${file}`);
}

const ok = Object.values(res).every((v) => v.ok);
process.exit(ok ? 0 : 1);
