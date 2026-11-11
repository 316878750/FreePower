/**
 * P8-B 真机验证：代理健康检查（单条 + 批量 + 超时 + 错端口）
 *
 * 为什么要在版本库里：报告里的数字必须能复跑。`.tmp/p8b-verify.mjs` 是一次性探针，
 * 这份是同一套断言的可重复版本，和 `test/restart.test.mjs` 同一层（真 Chrome + 真 HTTP 服务）。
 *
 * 跑法：npm run test:proxy-health   （约 40 秒；需真实 Chrome + 完整权限，不打进 npm run smoke）
 *
 * 四种代理：
 *   ok    —— 假代理，固定出口 203.0.113.9 / JP
 *   auth  —— 假代理要求 u1/p1，库里存错密码 → 407（注意：`startFakeProxy` 会真校验密码；
 *            自建假代理若不校验，认证分支会被「放行」骗过去，测了等于没测）
 *   dead  —— 127.0.0.1:1，没人监听 → 连接被拒
 *   slow  —— 黑洞 TCP（accept 后不回包）→ 触发单条 10s 上限，且不许拖住整批
 *
 * 断言：
 *   1. 单条三态：ok / 认证失败 / 连接被拒，各自带具体原因（不是笼统「失败」）
 *   2. 批量：ok 1 / fail 3；并发 3；单条上限 10000ms；整批在 20s 内收口
 *   3. 脏 id 单独报 not_found，不打挂整批；结果项带 remark / name
 *   4. 检测只读：代理库条数与配置不变
 *   5. 控制台代理页真的点得动，页面文字里有「批量检测完成」和三条具体失败原因
 */
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startFakeProxy } from './fake-proxy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, '.tmp', `proxy-health-${Date.now()}`);
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.FREEPOWER_DATA = DATA;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
process.env.FREEPOWER_EGRESS_TIMEOUT = '1500';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { createApiServer } = await import('../src/api/server.js');
const { findChrome, launchChrome, waitForDevToolsPort, killProcessTree, buildArgs } = await import('../src/kernel/chrome.js');
const { CdpClient, fetchJson } = await import('../src/kernel/cdp.js');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const okProxy = await startFakeProxy({ ip: '203.0.113.9', country: 'Japan', countryCode: 'JP', city: 'Tokyo', timezone: 'Asia/Tokyo' });
const authProxy = await startFakeProxy({ requireAuth: ['u1', 'p1'] });
// 黑洞：TCP 能连上，但永远不回包 —— 这是「超时」与「连接被拒」的区别
const slowSrv = net.createServer(() => { /* 什么都不发 */ });
await new Promise((r) => slowSrv.listen(0, '127.0.0.1', r));
const slowPort = slowSrv.address().port;

const { server, apiKey } = createApiServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const api = async (method, p, body) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', 'api-key': apiKey, 'x-freepower-client': 'ui' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
};

let chromeChild = null;
let client = null;
try {
  const created = await api('POST', '/api/v2/proxy-list/create', [
    { type: 'http', host: '127.0.0.1', port: okProxy.port, remark: 'P8B-好代理' },
    { type: 'http', host: '127.0.0.1', port: authProxy.port, user: 'u1', password: 'wrong-pass', remark: 'P8B-密码错' },
    { type: 'http', host: '127.0.0.1', port: 1, remark: 'P8B-端口写错' },
    { type: 'http', host: '127.0.0.1', port: slowPort, remark: 'P8B-黑洞超时' },
  ]);
  const ids = (created.data || []).map((p) => p.proxy_id);
  const before = await api('POST', '/api/v2/proxy-list/list', { page: 1, page_size: 100 });
  console.log(`代理：好=${okProxy.port} 认证=${authProxy.port} 死=1 黑洞=${slowPort}\n`);

  /* ---------- 1. 单条：三种状态各自带原因 ---------- */
  const single = {};
  for (const [name, cfg] of [
    ['ok', { type: 'http', host: '127.0.0.1', port: okProxy.port }],
    ['auth', { type: 'http', host: '127.0.0.1', port: authProxy.port, username: 'u1', password: 'wrong-pass' }],
    ['dead', { type: 'http', host: '127.0.0.1', port: 1 }],
  ]) {
    const r = await api('POST', '/api/v2/proxy/check', { proxy_config: cfg });
    single[name] = r.data;
  }
  console.log('=== 单条 /proxy/check ===');
  for (const [k, v] of Object.entries(single)) {
    console.log(`${k}: ${JSON.stringify({ ok: v.ok, ip: v.ip, country: v.countryCode, latency_ms: v.latency_ms, error: v.ok ? undefined : String(v.error).slice(0, 100) })}`);
  }
  check('单条好代理：ok 且拿到出口 IP', single.ok?.ok === true && single.ok?.ip === '203.0.113.9', String(single.ok?.ip));
  check('单条密码错：报「407 认证失败」而不是笼统失败', /407 认证失败/.test(String(single.auth?.error)), String(single.auth?.error).slice(0, 60));
  check('单条死端口：报 ECONNREFUSED（连接被拒）', /ECONNREFUSED/.test(String(single.dead?.error)), String(single.dead?.error).slice(0, 60));

  /* ---------- 2. 批量：并发 3、单条 10s、超时那条不拖整批 ---------- */
  const t0 = Date.now();
  const batch = await api('POST', '/api/v2/proxy/check-batch', { proxy_ids: [...ids, 'ghost-proxy'] });
  const wall = Date.now() - t0;
  const list = batch.data?.list || [];
  console.log('\n=== 批量 /proxy/check-batch ===');
  console.log(JSON.stringify({
    total: batch.data?.total, ok: batch.data?.ok, fail: batch.data?.fail,
    concurrency: batch.data?.concurrency, timeout_ms: batch.data?.timeout_ms,
    server_elapsed_ms: batch.data?.elapsed_ms, wall_ms: wall,
    items: list.map((x) => ({ remark: x.remark || null, ok: x.ok, ip: x.ip || null, kind: x.error_kind || null, ms: x.latency_ms })),
  }, null, 1));

  check('批量：总 5 条（4 代理 + 1 脏 id）', batch.data?.total === 5, String(batch.data?.total));
  check('批量：ok 1 / fail 4', batch.data?.ok === 1 && batch.data?.fail === 4, `${batch.data?.ok}/${batch.data?.fail}`);
  check('批量：并发上限报 3、单条上限 10000ms', batch.data?.concurrency === 3 && batch.data?.timeout_ms === 10000, `${batch.data?.concurrency}/${batch.data?.timeout_ms}`);
  const slow = list.find((x) => x.remark === 'P8B-黑洞超时');
  check('批量：黑洞那条归 timeout，且没拖死整批', slow?.error_kind === 'timeout' && batch.data?.elapsed_ms < 20000, `kind=${slow?.error_kind} elapsed=${batch.data?.elapsed_ms}`);
  check('批量：认证/连接被拒各自归对类', list.find((x) => x.remark === 'P8B-密码错')?.error_kind === 'auth' && list.find((x) => x.remark === 'P8B-端口写错')?.error_kind === 'connect_refused',
    JSON.stringify(list.map((x) => [x.remark, x.error_kind])));
  check('批量：脏 id 单独报 not_found，带错误文案', list.find((x) => x.proxy_id === 'ghost-proxy')?.error_kind === 'not_found' && list.find((x) => x.proxy_id === 'ghost-proxy')?.error_label === '代理不存在', '');
  check('批量：每条带可读标识（remark）', list.find((x) => x.remark === 'P8B-好代理')?.name === 'P8B-好代理' && list.find((x) => x.proxy_id === 'ghost-proxy')?.remark === null, JSON.stringify(list.map((x) => x.remark)));

  /* ---------- 3. 只读：代理库与配置不变 ---------- */
  const after = await api('POST', '/api/v2/proxy-list/list', { page: 1, page_size: 100 });
  const pick = (r) => JSON.stringify((r.data?.list || []).map((p) => [p.proxy_id, p.type, p.host, p.port, p.user, p.password, p.remark]).sort());
  check('检测只读：代理库条数与字段没变', (after.data?.list || []).length === 4 && pick(before) === pick(after), `${(after.data?.list || []).length} 条`);

  /* ---------- 4. 真浏览器打开控制台，点按钮，抠页面文字 ---------- */
  const chrome = findChrome();
  const UDD = path.join(DATA, 'ui-udd');
  fs.mkdirSync(UDD, { recursive: true });
  const { createProfile } = await import('../src/store/profiles.js');
  const uiProfile = createProfile({ name: 'p8b-ui', group_id: '0', remark: 'P8-B UI' });
  const built = buildArgs(uiProfile, { userDataDir: UDD, proxy: null, proxyBound: false, userArgs: [] });
  chromeChild = launchChrome(chrome.path, built.args);
  const { port: cdpPort } = await waitForDevToolsPort(UDD, { timeoutMs: 25000 });
  const version = await fetchJson(`http://127.0.0.1:${cdpPort}/json/version`);
  client = await CdpClient.connect(version.webSocketDebuggerUrl);
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Page.enable', {}, sessionId);
  const evalIn = async (expr) => {
    const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) return `ERR: ${r.exceptionDetails.text}`;
    return r.result.value;
  };
  await client.send('Page.navigate', { url: `${base}/` }, sessionId);
  await sleep(1500);
  await evalIn(`location.hash = '#/proxies'; 1`);
  await sleep(1200);

  await evalIn(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent === '全部检测'); if (!b) return 'no-button'; b.click(); return 'clicked'; })()`);
  let summary = '';
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    summary = await evalIn(`(document.querySelector('.notice') && document.querySelector('.notice').innerText) || ''`);
    if (/批量检测完成/.test(String(summary))) break;
    await sleep(500);
  }
  const bodyText = await evalIn(`document.body.innerText`);
  console.log('\n=== UI 批量检测结果（页面渲染文字）===');
  console.log(summary);

  const lines = String(bodyText).split('\n').map((s) => s.trim()).filter(Boolean);
  const has = (re) => lines.some((l) => re.test(l));
  check('UI：批量检测完成并给出 ok/fail 两栏', /批量检测完成/.test(String(summary)) && /ok/.test(String(summary)) && /fail/.test(String(summary)), String(summary).split('\n')[0]);
  check('UI：三条失败原因都显示具体原因', has(/认证失败/) && has(/连接被拒/) && has(/连接超时/), '');
  check('UI：并发与单条上限写进汇总', /并发 3/.test(String(summary)) && /单条上限 10000ms/.test(String(summary)), '');

  // 单条：点「好代理」那一行的「检测」
  await evalIn(`(() => {
    const tr = [...document.querySelectorAll('tbody tr')].find((t) => t.innerText.includes('P8B-好代理'));
    const b = tr && [...tr.querySelectorAll('button')].find((x) => x.textContent === '检测');
    if (b) { b.click(); return 'clicked'; }
    return 'no-row';
  })()`);
  await sleep(2500);
  const rowText = await evalIn(`(() => { const tr = [...document.querySelectorAll('tbody tr')].find((t) => t.innerText.includes('P8B-好代理')); return tr ? tr.innerText : 'no-row'; })()`);
  console.log('\n=== UI 单条检测后「好代理」那行 ===');
  console.log(rowText);
  check('UI：单条检测后行里显示出口 IP 与延迟', /203\.0\.113\.9/.test(String(rowText)) && /ms/.test(String(rowText)), '');
} catch (e) {
  console.log('异常：', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
  check('整体跑通（无异常）', false, String(e && e.message));
} finally {
  // 清理必须不会挂住：真机测试里最容易踩的是「server.close() 等 keep-alive 连接」，
  // 一等就是永远 —— 前面所有断言跑完却在收尾卡死，报告永远出不来。
  const withTimeout = (p, ms = 1500) => Promise.race([Promise.resolve(p).catch(() => {}), sleep(ms)]);
  try { if (client) client.close(); } catch {}
  try { if (chromeChild) killProcessTree(chromeChild.pid); } catch {}
  for (const s of [okProxy.server, authProxy.server, slowSrv, server]) {
    try { s.closeAllConnections?.(); } catch {}
  }
  try { await withTimeout(okProxy.close()); } catch {}
  try { await withTimeout(authProxy.close()); } catch {}
  try { await withTimeout(new Promise((r) => slowSrv.close(r))); } catch {}
  try { server.close(); } catch {}
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
}

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
