/**
 * 全链路判据（B 层，真内核）：**浏览器 → 本地中继 → 本地假 SOCKS5 → 本地 HTTP 页面**。
 *
 * 存在的理由（2026-11-18）：中继那批判据全是协议层的（假上游 + 裸 socket），
 * 没有任何一条证明「浏览器经过中继真的能渲染出页面」。今天这一整轮绕了那么久，
 * 就是因为缺这一环 —— 出了问题分不清是我们的链路还是上游。
 *
 * 链路：
 *   1. 本地假 SOCKS5 上游（带账号密码，40 条并发连接不排队；目标是 `*.test` 时真拨 127.0.0.1，
 *      其它域名 —— Chrome 那 3 条关不掉的后台请求 —— 回 OK 后丢弃，中继侧照样算隧道建成）；
 *   2. 本地 HTTP 服务：`<title>FreePower Relay E2E</title><h1>relay-ok</h1>` + 6 张来自
 *      **6 个不同域名**的图（强制 Chrome 开多条连接，而不是复用一条）；
 *   3. 我们的 `startRelay()`，上游指向假 SOCKS5；
 *   4. 真内核 `--proxy-server=socks5://127.0.0.1:<relay>`，导航到 `http://relay-e2e.test:<port>/`。
 *
 * 断言（CEO 派工）：
 *   - `document.title === 'FreePower Relay E2E'`、正文含 `relay-ok`；
 *   - 6 张图全部真的加载出来（证明不是只渲染了一张空壳）；
 *   - 中继读数：`connections ≥ 5`、`failed === 0`、
 *     `tunnels + client_closed === connections`（每条连接都有交代：要么建成隧道，要么是
 *     浏览器自己 RST 掉的预连接）、`max_dial_ms < 1000`、`queue_timeout === 0`；
 *   - 上游确实收到了环境里的账号密码、确实看到了 `relay-e2e.test` 这个目标。
 *
 * 红（2026-11-18 20:40，开发时真跑过）：把 `src/proxy/relay.js` 退回 `ddd5afa` 那版
 * （槽位覆盖「拨号 + 握手 + 重试」），并 `E2E_RELAY_CONCURRENCY=2` +
 * `E2E_HANDSHAKE_MS=1200` + `E2E_HANDSHAKE_CONCURRENCY=1`：
 *   `connections=19 tunnels=10 failed=9 queue_timeout=9 max_dial_ms=2421`，6 张图只加载出 2 张
 *   → **8 PASS / 5 FAIL**（⑤⑧⑨⑩⑪ 红）。
 * 同一份配置换回现在的代码（槽位只覆盖一次拨号）：
 *   `connections=14 tunnels=14 failed=0 client_closed=0 queue_timeout=0 max_dial_ms=1`，6/6 图
 *   → **13 PASS / 0 FAIL**。
 *
 * 跑法：`npm run test:e2e`（单独一条，也接在 `npm run smoke` 末尾；不进 `npm test`，避免拖慢常规回归）。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findChrome, launchChrome, killProcessTree, buildArgs, waitForDevToolsPort } from '../src/kernel/chrome.js';
import { CdpClient, fetchJson } from '../src/kernel/cdp.js';
import { startRelay } from '../src/proxy/relay.js';
import { startFakeSocks5 } from './fake-socks5.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const fmt = (x) => JSON.stringify(x);

const PROXY_USER = 'e2e-user-7f';
const PROXY_PASS = 'e2e-pass-91c';
const PAGE_HOST = 'relay-e2e.test';
const IMG_HOSTS = Array.from({ length: 6 }, (_, i) => `relay-e2e-${i + 1}.test`);
const PAGE_TITLE = 'FreePower Relay E2E';
const BODY_MARK = 'relay-ok';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const chrome = findChrome();
if (!chrome?.path) {
  console.error('找不到内核，B 层判据没法跑');
  process.exit(2);
}

/* ------------------------------ 本地 HTTP 目标 ------------------------------ */

const hits = [];
let PORT = 0;
const pageHtml = () => `<!doctype html><html><head><meta charset="utf-8"><title>${PAGE_TITLE}</title></head>
<body><h1>${BODY_MARK}</h1><div id="imgs">${IMG_HOSTS.map((h) => `<img src="http://${h}:${PORT}/pixel.png">`).join('')}</div></body></html>`;

const web = http.createServer((req, res) => {
  const p = String(req.url || '/').split('?')[0];
  hits.push({ host: String(req.headers.host || ''), path: p });
  if (p === '/pixel.png') {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length, 'cache-control': 'no-store' });
    res.end(PNG);
    return;
  }
  const html = pageHtml();
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html), 'cache-control': 'no-store' });
  res.end(html);
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
PORT = web.address().port;

/* ------------------------------ 假上游 + 中继 ------------------------------ */

/** 只有 `*.test` 目标真拨本机 HTTP 服务；其它（Chrome 后台请求）回 OK 后丢弃 */
const isE2EHost = (h) => h === PAGE_HOST || IMG_HOSTS.includes(h);
const up = await startFakeSocks5({
  requireAuth: [PROXY_USER, PROXY_PASS],
  dialHost: () => '127.0.0.1',
  sinkWhen: (h) => !isE2EHost(h),
  label: 'e2e-upstream',
  // 红判据要它慢：`E2E_HANDSHAKE_MS` / `E2E_HANDSHAKE_CONCURRENCY` 只在开发验证红时设
  handshakeMs: Number(process.env.E2E_HANDSHAKE_MS || 0),
  handshakeConcurrency: Number(process.env.E2E_HANDSHAKE_CONCURRENCY || Infinity),
});

const relay = await startRelay(
  { type: 'socks5', host: '127.0.0.1', port: up.port, username: PROXY_USER, password: PROXY_PASS },
  {
    // 红判据开发验证时用：`E2E_RELAY_CONCURRENCY=2` 把槽位压到 2（配 `E2E_HANDSHAKE_MS` 慢握手）
    concurrency: Number(process.env.E2E_RELAY_CONCURRENCY || 8),
    // 压小排队窗口：槽位一旦被别的阶段占住，这里会立刻暴露成 queue_timeout（红判据靠它）
    queueTimeoutMs: 2000,
    dialAttemptMs: 21000,
    dialBudgetMs: 45000,
    dialAttempts: 2,
  },
);

/* ------------------------------ 真内核 ------------------------------ */

const udd = path.join(os.tmpdir(), `fp-relay-e2e-${process.pid}-${Date.now()}`);
fs.mkdirSync(udd, { recursive: true });
const profile = { profile_id: 'relay-e2e', fingerprint_config: {}, webgl_config: {} };
const built = buildArgs(profile, {
  userDataDir: udd,
  proxy: { type: 'socks5', host: '127.0.0.1', port: relay.port },
  proxyBound: true,
});
const pageUrl = `http://${PAGE_HOST}:${PORT}/`;
const args = [...built.args, pageUrl];

console.log(`内核 ${chrome.version}；中继 127.0.0.1:${relay.port} → 假上游 127.0.0.1:${up.port}；页面 ${pageUrl}`);

let child = null;
let client = null;
try {
  child = launchChrome(chrome.path, args);
  const dev = await waitForDevToolsPort(udd, { timeoutMs: 30000, child });
  const version = await fetchJson(`http://127.0.0.1:${dev.port}/json/version`);
  client = await CdpClient.connect(version.webSocketDebuggerUrl || `ws://127.0.0.1:${dev.port}${dev.browserPath}`);

  // 等页面 target 出现并渲染完成
  let target = null;
  const targetDeadline = Date.now() + 20000;
  while (Date.now() < targetDeadline) {
    const { targetInfos = [] } = await client.send('Target.getTargets');
    target = targetInfos.find((t) => t.type === 'page' && String(t.url).startsWith(`http://${PAGE_HOST}:`))
      || targetInfos.find((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
    if (target && String(target.url).startsWith(`http://${PAGE_HOST}:`)) break;
    await sleep(200);
  }
  check('① 内核起来了，并打开了目标页 target', Boolean(target), fmt(target?.url?.slice(0, 80)));

  const { sessionId } = await client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  let snap = {};
  const pageDeadline = Date.now() + 45000;
  while (Date.now() < pageDeadline) {
    const r = await client.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        href: location.href,
        title: document.title,
        ready: document.readyState,
        body: (document.body ? document.body.innerText : '').slice(0, 200),
        imgs: document.images.length,
        loaded: [...document.images].filter((i) => i.complete && i.naturalWidth > 0).length,
      })`,
      returnByValue: true,
    }, sessionId).catch(() => null);
    try { snap = JSON.parse(String(r?.result?.value || 'null') || 'null') || {}; } catch { snap = {}; }
    if (snap.ready === 'complete' && snap.title === PAGE_TITLE && snap.loaded >= IMG_HOSTS.length) break;
    await sleep(200);
  }

  /* ------------------------------ 页面断言 ------------------------------ */
  check('② 页面不是错误页（href 是 http，不是 chrome-error）',
    String(snap.href || '').startsWith(`http://${PAGE_HOST}:`), fmt(String(snap.href || '').slice(0, 60)));
  check(`③ document.title === '${PAGE_TITLE}'`, snap.title === PAGE_TITLE, fmt(snap.title));
  check(`④ 正文含 '${BODY_MARK}'`, String(snap.body || '').includes(BODY_MARK), fmt(String(snap.body || '').slice(0, 60)));
  check('⑤ 6 张跨域名图片全部真的加载出来（证明多条连接都通了）',
    snap.imgs === IMG_HOSTS.length && snap.loaded === IMG_HOSTS.length, `imgs=${snap.imgs} loaded=${snap.loaded}`);
  check('⑥ 页面请求真的到了本地 HTTP 服务（不是缓存/空壳）',
    hits.some((h) => h.path === '/' && h.host.startsWith(PAGE_HOST)), `${hits.length} 次请求`);

  /* ------------------------------ 中继读数断言 ------------------------------ */
  // 页面加载完可能还有几条在途连接；等它收敛（tunnels 追上 connections），最多 8s
  const settleDeadline = Date.now() + 8000;
  while (Date.now() < settleDeadline) {
    const s = relay.stats;
    if (s.tunnels === s.connections && s.failed === 0) break;
    await sleep(200);
  }
  const st = relay.stats;
  console.log(`中继读数 ${fmt({
    connections: st.connections, tunnels: st.tunnels, failed: st.failed,
    client_closed: st.client_closed,
    queue_timeout: st.queue_timeout, max_dial_ms: st.max_dial_ms,
    dial_attempts: st.dial_attempts, dial_retries: st.dial_retries,
    max_queue_wait_ms: st.max_queue_wait_ms, peak_active: st.peak_active,
    dial_fail_kinds: st.dial_fail_kinds,
  })}`);
  if (relay.lastError) console.log(`中继 lastError：${relay.lastError.message || relay.lastError}`);
  const odd = up.records.filter((r) => r.status !== 'tunnel' && r.status !== 'sink');
  if (odd.length) console.log(`上游非隧道记录 ${fmt(odd.map((r) => ({ host: r.host, port: r.port, status: r.status })))}`);

  check('⑦ 中继 connections ≥ 5（真的开了多条连接）', st.connections >= 5, `connections=${st.connections}`);
  check('⑧ 每条连接都有交代：tunnels + client_closed === connections',
    st.tunnels + st.client_closed === st.connections,
    `tunnels=${st.tunnels} client_closed=${st.client_closed} connections=${st.connections}`);
  check('⑨ failed === 0（链路里没有任何一条失败；浏览器自己关掉的预连接单独记 client_closed）',
    st.failed === 0, `failed=${st.failed} client_closed=${st.client_closed}`);
  check('⑩ max_dial_ms < 1000（拨号是本机链路，不该慢）', st.max_dial_ms < 1000, `max_dial_ms=${st.max_dial_ms}`);
  check('⑪ queue_timeout === 0（槽位没有被占死）', st.queue_timeout === 0, `queue_timeout=${st.queue_timeout}`);

  check('⑫ 假上游收到了环境里的账号密码（中继真在转发）',
    up.authSeen.length >= 1 && up.authSeen.every((a) => a.username === PROXY_USER && a.password === PROXY_PASS),
    `${up.authSeen.length} 次认证`);
  check('⑬ 假上游真的看到目标 relay-e2e.test（不是只连了中继）',
    up.connects.some((c) => c.host === PAGE_HOST && c.status === 'tunnel'),
    fmt(up.connects.filter((c) => c.status === 'tunnel').map((c) => c.host)));
} catch (e) {
  console.log('异常：', e && e.stack ? e.stack.split('\n').slice(0, 8).join(' | ') : e);
  check('整体跑通（无异常）', false, String(e && e.message));
} finally {
  if (client) { try { client.close(); } catch { /* ignore */ } }
  if (child) killProcessTree(child.pid);
  await sleep(300);
  try { await relay.close(); } catch { /* ignore */ }
  try { await up.close(); } catch { /* ignore */ }
  try { web.closeAllConnections?.(); } catch { /* ignore */ }
  try { web.close(); } catch { /* ignore */ }
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch { /* 句柄还在 */ }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);
