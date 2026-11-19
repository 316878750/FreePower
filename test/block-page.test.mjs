/**
 * 拦截页 · B 层真机判据（**真内核、全离线**）。
 *
 * A 层（test/net-rules.test.mjs）只证明「HTML 转义对、响应头对、__fpBlock 三字段对」；
 * 证明不了「浏览器真的把那张页显示出来了，而且没有误伤别的请求」。这条补的就是这半步：
 *
 *   ① 黑名单命中**顶层文档** → 页面是我们那张拦截页（200、标题、`window.__fpBlock`、`#fp-blocked`）；
 *   ② **不误伤对照**：同一环境访问不在名单里的 host → 原始页面照常（缺这条就是「全给拦截页」的假绿）；
 *   ③ **子资源对照**：被拦 host 的 `<img>` 仍是 `failRequest`（`img.complete=false` +
 *      `Network.loadingFailed.blockedReason === 'inspector'`）—— 证明我们没有把 HTML 往图片里塞；
 *   ④ 白名单模式：名单外 → 拦截页（`not_in_whitelist`）；名单内 → 原始页面。
 *
 * 全部本机自起 http server，不依赖外网。页面用 `127.0.0.1`、被拦目标用 `localhost`，
 * 这样黑/白名单只拦一个 host，不会把页面本身也拦掉。
 *
 * 跑法：npm run test:block-page（`npm run smoke` 里有它）
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'freepower-block-'));
process.env.FREEPOWER_DATA = DATA;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
process.env.FREEPOWER_EGRESS_TIMEOUT = '1000';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ 本机页面与资源 ------------------------------ */

let PORT = 0;
const hits = new Map();
const hit = (p, host) => hits.set(`${p}@${host}`, (hits.get(`${p}@${host}`) || 0) + 1);
const count = (p, host) => hits.get(`${p}@${host}`) || 0;

/** 原始页：带一个「被拦 host」的图片，用来证明子资源仍然是 fail */
const rawPage = () => `<!doctype html><html><head><meta charset="utf-8"><title>raw-page</title></head><body>
<h1>raw-page</h1>
<img id="im" src="http://localhost:${PORT}/img.png">
</body></html>`;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const srv = http.createServer((req, res) => {
  const p = String(req.url || '/').split('?')[0];
  hit(p, String(req.headers.host || ''));
  if (p === '/page.html') {
    const body = rawPage();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  if (p === '/img.png') {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
    return;
  }
  res.writeHead(404);
  res.end('no');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
PORT = srv.address().port;
const ALLOWED = `http://127.0.0.1:${PORT}`;
const BLOCKED = `http://localhost:${PORT}`;

/* ------------------------------ 被测代码 ------------------------------ */

const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');
const { findChrome, killProcessTree } = await import('../src/kernel/chrome.js');
const { closeDb } = await import('../src/store/db.js');

const chrome = findChrome();
if (!chrome) {
  console.error('没有可用内核，设置 FREEPOWER_CHROME 后重试');
  process.exit(2);
}
console.log(`内核：${chrome.version} (${chrome.source})`);

const SNAPSHOT = `(() => JSON.stringify({
  ready: document.readyState,
  title: document.title,
  hasMarker: !!document.getElementById('fp-blocked'),
  blocked: window.__fpBlock || null,
  imgComplete: document.images.length ? document.images[0].complete : null,
  imgNatural: document.images.length ? document.images[0].naturalWidth : null,
  navStatus: (performance.getEntriesByType('navigation')[0] || {}).responseStatus ?? null,
  text: (document.body ? (document.body.textContent || document.body.innerText) : '').slice(0, 80),
}))()`;

/**
 * 起一个环境、开一张页、导航到 url，读回快照 + 这次导航的 CDP 事件。
 * @returns {{snap:object|null, failures:object[], responses:object[]}}
 */
async function navigateCase(label, fields, url) {
  const created = profiles.createProfile({ name: `bp-${label}-${Date.now()}`, group_id: '0', ...fields });
  const id = created.profile_id;
  const failures = [];
  const responses = [];
  try {
    await manager.startProfile(profiles.getProfile(id));
    const inst = manager.getInstance(id);
    const { sessionId } = await inst.openPage('about:blank');
    await inst.client.send('Network.enable', {}, sessionId).catch(() => {});
    inst.client.on('Network.loadingFailed', (p, sid) => {
      if (sid === sessionId) failures.push({ url: p.url || '', reason: p.blockedReason || p.errorText || '' });
    });
    inst.client.on('Network.responseReceived', (p, sid) => {
      if (sid === sessionId) responses.push({ url: p.response?.url || '', status: p.response?.status, headers: p.response?.headers || {} });
    });

    // 先把请求发出去（别等 load：被拦的导航不会给「加载成功」的收尾），再轮询快照
    await inst.client.send('Page.navigate', { url }, sessionId).catch(() => {});
    let snap = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const r = await inst.client.send('Runtime.evaluate', {
        expression: SNAPSHOT, returnByValue: true,
      }, sessionId).catch(() => null);
      try { snap = JSON.parse(r?.result?.value || 'null'); } catch { snap = null; }
      if (snap && snap.ready === 'complete' && snap.title) break;
      await sleep(150);
    }
    await sleep(400); // 给子资源那几条事件一点时间落地
    return { snap, failures, responses, id };
  } finally {
    await Promise.race([manager.stopProfile(id).catch(() => {}), sleep(4000)]);
    try { profiles.deleteProfiles([id]); } catch { /* ignore */ }
  }
}

const fmt = (x) => JSON.stringify(x);

try {
  /* -------------------- ① 黑名单命中顶层文档 → 拦截页 -------------------- */
  console.log('\n=== blacklist=localhost，导航到被拦 host ===');
  const blockedCase = await navigateCase('black', { blacklist: 'localhost' }, `${BLOCKED}/page.html`);
  const s1 = blockedCase.snap;
  console.log(`快照 ${fmt(s1)}`);
  console.log(`响应 ${fmt(blockedCase.responses.filter((r) => r.url.includes('/page.html')))}`);
  check('黑名单：顶层文档变成我们的拦截页（#fp-blocked 在 DOM 里）', s1?.hasMarker === true, fmt(s1?.hasMarker));
  check('黑名单：标题是「已拦截 · FreePower」', s1?.title === '已拦截 · FreePower', fmt(s1?.title));
  check('黑名单：window.__fpBlock.reason = blacklist（脚本唯一可靠判据）',
    s1?.blocked?.reason === 'blacklist', fmt(s1?.blocked));
  check('黑名单：__fpBlock.host / url 指向被拦的那个地址',
    String(s1?.blocked?.host || '').startsWith('localhost:') && String(s1?.blocked?.url || '').includes('/page.html'),
    fmt({ host: s1?.blocked?.host, url: s1?.blocked?.url }));
  {
    const doc = blockedCase.responses.find((r) => r.url.includes('/page.html') && r.status === 200);
    const h = doc?.headers || {};
    const headerOf = (n) => h[n] || h[n.toLowerCase()] || h[n.toUpperCase()] || '';
    check('黑名单：拦截页真的以 HTTP 200 下来（不是网络错误页）', doc?.status === 200, fmt(doc?.status ?? null));
    check('黑名单：响应头带 Cache-Control: no-store（防止被缓存回放）',
      String(headerOf('Cache-Control')).includes('no-store'), headerOf('Cache-Control'));
    check('黑名单：响应头带 CSP default-src \'none\'（零外链是钉死的）',
      String(headerOf('Content-Security-Policy')).includes("default-src 'none'"), headerOf('Content-Security-Policy'));
  }
  check('黑名单：被拦的顶层文档**没有打到服务器**',
    count('/page.html', `localhost:${PORT}`) === 0, `命中 ${count('/page.html', `localhost:${PORT}`)}`);

  /* -------------------- ② 不误伤：同一环境访问名单外 host -------------------- */
  console.log('\n=== 同一个环境，导航到不在名单里的 host ===');
  const allowedCase = await navigateCase('allow', { blacklist: 'localhost' }, `${ALLOWED}/page.html`);
  const s2 = allowedCase.snap;
  console.log(`快照 ${fmt(s2)}`);
  check('不误伤：名单外顶层文档照常是原始页面（title=raw-page）', s2?.title === 'raw-page', fmt(s2?.title));
  check('不误伤：原始页面没有被塞进 __fpBlock', s2?.blocked === null, fmt(s2?.blocked));
  check('不误伤：原始页面真的从服务器拿到了', count('/page.html', `127.0.0.1:${PORT}`) > 0,
    `命中 ${count('/page.html', `127.0.0.1:${PORT}`)}`);
  // 注意判 `naturalWidth === 0`，**不能判 `img.complete === false`**：按规范，加载失败的图片
  // 也会进入 complete 状态（只是 `naturalWidth` 为 0）。第一版写成 complete=false，红在这里，
  // 是判据写错、不是实现错 —— 记一笔免得下一个人照抄。
  check('子资源对照：被拦 host 的 <img> 仍是被拒（naturalWidth=0，没有像素）',
    s2?.imgNatural === 0, fmt({ complete: s2?.imgComplete, natural: s2?.imgNatural }));
  check('子资源对照：CDP 里 blockedReason = inspector（不是被换成拦截页）',
    allowedCase.failures.some((f) => f.reason === 'inspector'), fmt(allowedCase.failures));
  check('子资源对照：那张图没有打到服务器', count('/img.png', `localhost:${PORT}`) === 0,
    `命中 ${count('/img.png', `localhost:${PORT}`)}`);

  /* -------------------- ③ 白名单：名单外给拦截页 -------------------- */
  console.log('\n=== whitelist=127.0.0.1，导航到名单外 ===');
  const wlOut = await navigateCase('wlout', { whitelist: '127.0.0.1' }, `${BLOCKED}/page.html`);
  const s3 = wlOut.snap;
  console.log(`快照 ${fmt(s3)}`);
  check('白名单：名单外顶层文档给拦截页', s3?.hasMarker === true && s3?.title === '已拦截 · FreePower',
    fmt({ marker: s3?.hasMarker, title: s3?.title }));
  check('白名单：reason = not_in_whitelist', s3?.blocked?.reason === 'not_in_whitelist', fmt(s3?.blocked));

  /* -------------------- ④ 白名单：名单内照常 -------------------- */
  console.log('\n=== 同一个白名单环境，导航到名单内 ===');
  const wlIn = await navigateCase('wlin', { whitelist: '127.0.0.1' }, `${ALLOWED}/page.html`);
  const s4 = wlIn.snap;
  console.log(`快照 ${fmt(s4)}`);
  check('白名单：名单内顶层文档照常是原始页面', s4?.title === 'raw-page' && s4?.blocked === null,
    fmt({ title: s4?.title, blocked: s4?.blocked }));
} catch (e) {
  check('拦截页测试异常', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
} finally {
  try { srv.closeAllConnections?.(); } catch { /* ignore */ }
  try { srv.close(); } catch { /* ignore */ }
  try { closeDb(); } catch { /* ignore */ }
  await sleep(400);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(` - ${f.name}  ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);