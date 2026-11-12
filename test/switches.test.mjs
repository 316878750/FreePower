/**
 * 真机判据：隐私开关「配了到底有没有生效」（P-第一批 ①）
 *
 * 判的是**网络侧的事实**，不是页面观感：
 *   - `disable_image`：图片请求到服务器了吗（命中计数）+ 页面里 `img.complete`
 *   - `disable_video`：媒体请求到服务器了吗 + `<video>.readyState / networkState`
 *   - `blacklist`：被拉黑的 host 命中 0，同页其它请求照常（证明只拦目标，不是把页打死）
 *   - `whitelist`：名单内命中 >0、名单外命中 0
 *
 * 每个开关都有一组**同机对照**（关着的那份必须命中 >0），所以「全 0」不会被误读成通过 ——
 * 页面自己起不来时两项一起归零，这条判据会红。
 *
 * 目标地址全部是本机自起的 http server（不依赖外网）；页面与「被拦目标」故意用不同 host
 * （`127.0.0.1` 与 `localhost`），这样黑/白名单能只拦一个、不连页面一起打死。
 *
 * 跑法：npm run test:switches
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/* ------------------------------ 被测页面与资源 ------------------------------ */

/** 1x1 透明 PNG（固定字节，避免依赖外部文件） */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** 0.1 秒 8kHz 单声道 8bit 静音 WAV：`<video>` 也吃音频容器，够触发 Media 请求 */
function wavBytes() {
  const samples = 800;
  const data = Buffer.alloc(samples, 128);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const WAV = wavBytes();

const hits = new Map();
const hit = (p) => hits.set(p, (hits.get(p) || 0) + 1);

let PORT = 0;
const page = () => `<!doctype html><html><head><meta charset="utf-8"><title>switches</title></head><body>
<img id="im" src="/img.png">
<video id="vd" src="/media.wav" preload="auto" muted></video>
<script>
  const done = (k, v) => { window[k] = v; };
  fetch('http://127.0.0.1:${PORT}/api/allowed.json')
    .then((r) => r.json()).then(() => done('__allowed', 'ok'))
    .catch((e) => done('__allowed', 'error:' + (e && e.name)));
  fetch('http://localhost:${PORT}/api/blocked.json')
    .then((r) => r.json()).then(() => done('__blocked', 'ok'))
    .catch((e) => done('__blocked', 'error:' + (e && e.name)));
</script>
</body></html>`;

const srv = http.createServer((req, res) => {
  const u = String(req.url || '/');
  const p = u.split('?')[0];
  hit(p + '@' + (req.headers.host || ''));
  const cors = { 'access-control-allow-origin': '*' };
  if (p === '/page.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page());
    return;
  }
  if (p === '/img.png') {
    res.writeHead(200, { 'content-type': 'image/png', ...cors });
    res.end(PNG);
    return;
  }
  if (p === '/media.wav') {
    res.writeHead(200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', ...cors });
    res.end(WAV);
    return;
  }
  if (p === '/api/allowed.json' || p === '/api/blocked.json') {
    res.writeHead(200, { 'content-type': 'application/json', ...cors });
    res.end('{"ok":1}');
    return;
  }
  res.writeHead(404, { ...cors });
  res.end('no');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
PORT = srv.address().port;
const hostOf = (host) => `${host}:${PORT}`;
const count = (prefix, suffix) => {
  let n = 0;
  for (const [k, v] of hits) if (k.startsWith(prefix) && k.endsWith(suffix)) n += v;
  return n;
};

/* ------------------------------ 一次性数据目录 ------------------------------ */

const DATA = path.join(ROOT, '.tmp', `switches-${process.pid}-${Date.now()}`);
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.FREEPOWER_DATA = DATA;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
process.env.FREEPOWER_EGRESS_TIMEOUT = '1000';

const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');

const SNAPSHOT = `(() => {
  const im = document.getElementById('im');
  const vd = document.getElementById('vd');
  return JSON.stringify({
    ready: document.readyState,
    imgComplete: im ? im.complete : null,
    imgNatural: im ? im.naturalWidth : null,
    videoReadyState: vd ? vd.readyState : null,
    videoNetworkState: vd ? vd.networkState : null,
    allowed: window.__allowed === undefined ? 'pending' : window.__allowed,
    blocked: window.__blocked === undefined ? 'pending' : window.__blocked,
  });
})()`;

/** 起一个带这些字段的环境，打开判据页，读回读数后收尾 */
async function runCase(label, fields) {
  const base = {
    p: count('/page.html', hostOf('127.0.0.1')),
    a: count('/api/allowed.json', hostOf('127.0.0.1')),
    b: count('/api/blocked.json', hostOf('localhost')),
    i: count('/img.png', hostOf('127.0.0.1')),
    m: count('/media.wav', hostOf('127.0.0.1')),
  };

  const created = profiles.createProfile({ name: `sw-${label}-${Date.now()}`, group_id: '0', ...fields });
  const id = created.profile_id;
  let snap = null;
  try {
    const started = await manager.startProfile(profiles.getProfile(id));
    const inst = manager.getInstance(id);
    const { sessionId } = await inst.openPage(`http://127.0.0.1:${PORT}/page.html`);
    const read = async () => {
      const r = await inst.client.send('Runtime.evaluate', { expression: SNAPSHOT, returnByValue: true }, sessionId).catch(() => null);
      try { return JSON.parse(r?.result?.value || 'null'); } catch { return null; }
    };
    // 等页面到 complete 且两条 fetch 都有结论；视频再单独给一帧余量（解码是异步的）
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      snap = (await read()) || snap;
      if (snap && snap.ready === 'complete' && snap.allowed !== 'pending' && snap.blocked !== 'pending') break;
      await sleep(150);
    }
    await sleep(800);
    snap = (await read()) || snap;
    return {
      snap,
      kernel: started.real_version,
      pathHits: count('/page.html', hostOf('127.0.0.1')) - base.p,
      imgHits: count('/img.png', hostOf('127.0.0.1')) - base.i,
      mediaHits: count('/media.wav', hostOf('127.0.0.1')) - base.m,
      allowedHits: count('/api/allowed.json', hostOf('127.0.0.1')) - base.a,
      blockedHits: count('/api/blocked.json', hostOf('localhost')) - base.b,
    };
  } finally {
    await Promise.race([manager.stopProfile(id).catch(() => {}), sleep(4000)]);
    try { profiles.deleteProfiles([id]); } catch { /* ignore */ }
  }
}

const fmt = (x) => JSON.stringify(x);

try {
  /* ------------------------------ 对照组（全关） ------------------------------ */
  console.log('\n=== 对照组：四个开关全关 ===');
  const c = await runCase('control', {});
  console.log(`内核 ${c.kernel}  读数 ${fmt(c.snap)}`);
  console.log(`服务器命中：page=${c.pathHits} img=${c.imgHits} allowed=${c.allowedHits} blocked=${c.blockedHits}`);
  check('对照：页面确实加载成功（document.readyState=complete）', c.snap?.ready === 'complete', fmt(c.snap?.ready));
  check('对照：图片真的被请求了（服务器命中 > 0）', c.imgHits > 0, `img 命中 ${c.imgHits}`);
  check('对照：图片真的解码了（img.complete=true 且 naturalWidth>0）',
    c.snap?.imgComplete === true && Number(c.snap?.imgNatural) > 0, fmt({ complete: c.snap?.imgComplete, nw: c.snap?.imgNatural }));
  check('对照：视频真的加载了（readyState>0）', Number(c.snap?.videoReadyState) > 0, `readyState=${c.snap?.videoReadyState}`);
  check('对照：白名单那路 fetch 通（allowed=ok）', c.snap?.allowed === 'ok', fmt(c.snap?.allowed));
  check('对照：黑名单那路 fetch 通（blocked=ok）', c.snap?.blocked === 'ok', fmt(c.snap?.blocked));

  /* ------------------------------ disable_image ------------------------------ */
  console.log('\n=== disable_image=1 ===');
  const im = await runCase('noimg', { disable_image: '1' });
  console.log(`读数 ${fmt(im.snap)}`);
  console.log(`服务器命中：page=${im.pathHits} img=${im.imgHits} allowed=${im.allowedHits} blocked=${im.blockedHits}`);
  check('disable_image：图片请求数 = 0（服务器侧一条都没收到）', im.imgHits === 0, `img 命中 ${im.imgHits}`);
  check('disable_image：页面里 img 没加载（complete=false）', im.snap?.imgComplete === false, fmt(im.snap?.imgComplete));
  check('disable_image：页面本身照常加载（readyState=complete）', im.snap?.ready === 'complete', fmt(im.snap?.ready));
  check('disable_image：视频不受影响（对照项仍是 readyState>0）',
    Number(im.snap?.videoReadyState) > 0, `readyState=${im.snap?.videoReadyState}`);

  /* ------------------------------ disable_video ------------------------------ */
  console.log('\n=== disable_video=1 ===');
  const vid = await runCase('novid', { disable_video: '1' });
  console.log(`读数 ${fmt(vid.snap)}`);
  console.log(`服务器命中：page=${vid.pathHits} img=${vid.imgHits} media=${vid.mediaHits} allowed=${vid.allowedHits} blocked=${vid.blockedHits}`);
  check('disable_video：媒体请求数 = 0（服务器侧一条都没收到）', vid.mediaHits === 0, `media 命中 ${vid.mediaHits}`);
  check('disable_video：<video> 停在 readyState=0 / networkState=3（NO_SOURCE）',
    vid.snap?.videoReadyState === 0 && vid.snap?.videoNetworkState === 3,
    fmt({ rs: vid.snap?.videoReadyState, ns: vid.snap?.videoNetworkState }));
  check('disable_video：图片不受影响（对照项仍有命中）', vid.imgHits > 0, `img 命中 ${vid.imgHits}`);

  /* ------------------------------ blacklist ------------------------------ */
  console.log('\n=== blacklist=localhost ===');
  const bl = await runCase('blacklist', { blacklist: 'localhost' });
  console.log(`读数 ${fmt(bl.snap)}`);
  console.log(`服务器命中：page=${bl.pathHits} img=${bl.imgHits} allowed=${bl.allowedHits} blocked=${bl.blockedHits}`);
  check('blacklist：被拉黑的 host 命中 = 0', bl.blockedHits === 0, `blocked 命中 ${bl.blockedHits}`);
  check('blacklist：页面里那条 fetch 被拒（error 而不是 ok）', String(bl.snap?.blocked).startsWith('error'), fmt(bl.snap?.blocked));
  check('blacklist：同页其它请求照常（allowed=ok、img 命中>0）',
    bl.snap?.allowed === 'ok' && bl.imgHits > 0, fmt({ allowed: bl.snap?.allowed, img: bl.imgHits }));

  /* ------------------------------ whitelist ------------------------------ */
  console.log('\n=== whitelist=127.0.0.1 ===');
  const wl = await runCase('whitelist', { whitelist: '127.0.0.1' });
  console.log(`读数 ${fmt(wl.snap)}`);
  console.log(`服务器命中：page=${wl.pathHits} img=${wl.imgHits} allowed=${wl.allowedHits} blocked=${wl.blockedHits}`);
  check('whitelist：名单外命中 = 0', wl.blockedHits === 0, `blocked 命中 ${wl.blockedHits}`);
  check('whitelist：名单内命中 > 0（allowed=ok）', wl.snap?.allowed === 'ok' && wl.allowedHits > 0,
    fmt({ allowed: wl.snap?.allowed, hits: wl.allowedHits }));
  check('whitelist：页面在名单内 → 照常加载', wl.snap?.ready === 'complete', fmt(wl.snap?.ready));
} catch (e) {
  console.log('异常：', e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : e);
  check('整体跑通（无异常）', false, String(e && e.message));
} finally {
  try { srv.closeAllConnections?.(); } catch { /* ignore */ }
  try { srv.close(); } catch { /* ignore */ }
  await sleep(200);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
}

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
