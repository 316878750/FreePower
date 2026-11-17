/**
 * 带凭据代理的本地中继：**真内核判据**（0.4.7.3 P0）
 *
 * 要证明的事（CEO 0.4.7.3 任务 A 的判据 1/3/5/6）：
 *   R) **红测**：同一个内核、同一条 `--proxy-server=socks5://<上游>`（0.4.7.2 的写法）打一个
 *      「要求用户名密码」的 SOCKS5 → 必失败，并留下上游侧读数（我们只报了 no-auth）。
 *      这一条**先跑**，它红说明缺陷真的存在；后面绿才有意义。
 *   G) **绿**：同一个假代理，走**产品启动链路**（manager.startProfile）→ 页面/出口探测读到假代理
 *      那侧的值；内核 argv 只出现 127.0.0.1:<中继端口>；上游收到的凭据 = 环境账密；
 *      stop 之后中继端口不再 LISTEN。
 *   N) 不带凭据的 socks5 **仍走直连写法**（`--proxy-server=socks5://<上游>`），没有多出中继 ——
 *      钉住「别为了统一把它也塞进中继」。
 *   H) http 带凭据代理同样走中继并通（判据④）。
 *
 * 全部用一次性数据根；不碰用户真实库、不碰外网（出口探测指向本机目标 server）。
 * 跑法：npm run test:proxy-relay-kernel
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const fmt = (x) => JSON.stringify(x);

const TEST_HOST = 'target.test';
const FAKE_IP = '203.0.113.77';
const USER = 'socks-user-9d';
const PASS = 'socks-pass-4f2a';

/**
 * `target.test` 这类测试主机名由**代理侧**解析到 127.0.0.1（浏览器与中继都不需要 DNS）。
 * 不映射的话上游会报 ENOTFOUND，看起来像「中继坏了」，其实是假代理不会解名。
 */
const dialHost = (h) => (h === TEST_HOST ? '127.0.0.1' : h);

/* ------------------------------ 目标 server ------------------------------ */

const hits = [];
let PORT = 0;
const srv = http.createServer((req, res) => {
  const p = String(req.url || '/').split('?')[0];
  hits.push({ path: p, host: req.headers.host || '' });
  if (p === '/exit') {
    const body = JSON.stringify({
      status: 'success', country: 'Japan', countryCode: 'JP', regionName: 'Tokyo',
      city: 'Tokyo', timezone: 'Asia/Tokyo', isp: 'Relay Lab', query: FAKE_IP,
    });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  if (p === '/page.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>relay</title></head><body>RELAY-PAGE-OK</body></html>');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('no');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
PORT = srv.address().port;
const targetHit = (p) => hits.filter((h) => h.path === p).length;

/* ------------------------------ 一次性数据根 ------------------------------ */

const DATA = path.join(ROOT, '.tmp', `relay-${process.pid}-${Date.now()}`);
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.FREEPOWER_DATA = DATA;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = `http://${TEST_HOST}:${PORT}/exit`;
process.env.FREEPOWER_PROXY_TIMEOUT = '4000';
process.env.FREEPOWER_EGRESS_TIMEOUT = '4000';
process.env.FREEPOWER_UA_AUTOALIGN = '0';

const { startFakeSocks5, startFakeConnectProxy } = await import('./fake-socks5.mjs');
const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');
const chromeLib = await import('../src/kernel/chrome.js');
const { CdpClient } = await import('../src/kernel/cdp.js');

/* ------------------------------ 工具 ------------------------------ */

/** 本环境的 chrome 进程命令行（按 user-data-dir 里的 profile id 前 8 位归类，不看总数） */
function chromeProcsFor(frag) {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object -ExpandProperty CommandLine",
    ], { encoding: 'utf8', timeout: 20000 });
    return String(out).split(/\r?\n/).filter((l) => l.includes(frag));
  } catch {
    return null;   // 量不到就如实报「量不到」，不当成 0
  }
}

/** `127.0.0.1:<port>` 上还有没有人 LISTEN */
function portState(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const t = setTimeout(() => { s.destroy(); resolve('timeout'); }, 1500);
    s.once('connect', () => { clearTimeout(t); s.destroy(); resolve('open'); });
    s.once('error', (e) => { clearTimeout(t); resolve(e.code || 'error'); });
  });
}

/** 本机 LISTENING 套接字的本地地址（判「只 bind 回环」用真读数） */
function listenAddrs(port) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 15000 });
    const hit = [];
    for (const line of String(out).split(/\r?\n/)) {
      const m = /^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+\d+/i.exec(line);
      if (m && m[1].endsWith(`:${port}`)) hit.push(m[1]);
    }
    return hit;
  } catch { return null; }
}

/** 开页并读回：**必须等到目标文档落地**（about:blank 也是 complete，不能拿它当成功） */
async function openAndRead(inst, url, { timeoutMs = 15000 } = {}) {
  const wantPath = new URL(url).pathname;
  const { sessionId } = await inst.openPage(url);
  const deadline = Date.now() + timeoutMs;
  let snap = null;
  while (Date.now() < deadline) {
    const r = await inst.client.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ready:document.readyState,href:location.href,body:(document.body?document.body.innerText:"").slice(0,200)})',
      returnByValue: true,
    }, sessionId).catch(() => null);
    try { snap = JSON.parse(r?.result?.value || 'null'); } catch { /* ignore */ }
    if (snap && snap.ready === 'complete' && String(snap.href || '').includes(wantPath)) break;
    await sleep(150);
  }
  await sleep(250);   // 给服务器计数一点余量
  return { sessionId, snap };
}

function createCaseProfile(label, proxy) {
  const created = profiles.createProfile({
    name: `relay-${label}-${Date.now()}`,
    group_id: '0',
    user_proxy_config: proxy,
  });
  if (!created.profile_id) throw new Error(`建环境失败：${fmt(created)}`);
  return created.profile_id;
}

/** 读环境日志全文（判「凭据不进日志」用） */
function profileLog(id) {
  try { return fs.readFileSync(path.join(DATA, 'logs', `${id}.log`), 'utf8'); } catch { return ''; }
}

/**
 * **红测专用**：按 0.4.7.2 的写法直接起一个裸内核（`--proxy-server=socks5://<上游>`），
 * 不经过 manager、不装中继。这就是用户那 50 个环境当时的真实 argv。
 * @returns {Promise<{body:string, href:string, fakeStatus:string[]}>}
 */
async function rawKernelThroughUpstream(upstreamPort, { timeoutMs = 20000 } = {}) {
  const chrome = chromeLib.findChrome();
  if (!chrome) throw new Error('找不到内核');
  const udd = path.join(DATA, 'raw-kernel');
  fs.mkdirSync(udd, { recursive: true });
  const args = [
    `--user-data-dir=${udd}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--proxy-bypass-list=<-loopback>',
    `--proxy-server=socks5://127.0.0.1:${upstreamPort}`,
    'about:blank',
  ];
  const child = chromeLib.launchChrome(chrome.path, args);
  let client = null;
  try {
    const { port, browserPath } = await chromeLib.waitForDevToolsPort(udd, { timeoutMs, child });
    client = await CdpClient.connect(`ws://127.0.0.1:${port}${browserPath}`);
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    await client.send('Page.enable', {}, sessionId).catch(() => {});
    await client.send('Page.navigate', { url: `http://${TEST_HOST}:${PORT}/exit` }, sessionId).catch(() => {});
    const deadline = Date.now() + 6000;
    let snap = null;
    while (Date.now() < deadline) {
      const r = await client.send('Runtime.evaluate', {
        expression: 'JSON.stringify({ready:document.readyState,href:location.href,body:(document.body?document.body.innerText:"").slice(0,200)})',
        returnByValue: true,
      }, sessionId).catch(() => null);
      try { snap = JSON.parse(r?.result?.value || 'null'); } catch { /* ignore */ }
      if (snap && snap.ready === 'complete' && snap.href && !snap.href.startsWith('about:')) break;
      await sleep(200);
    }
    return { body: String(snap?.body || ''), href: String(snap?.href || '') };
  } finally {
    try { if (client) client.close(); } catch { /* ignore */ }
    chromeLib.killProcessTree(child.pid);
    await sleep(400);
  }
}

async function main() {
  /* ==========================================================================
   * R) 红测：0.4.7.2 的写法（内核直连要认证的 SOCKS5）→ 必失败
   * ======================================================================== */
  console.log('\n=== R) 红测：内核直连要认证的 SOCKS5（0.4.7.2 的 argv） ===');
  const redUp = await startFakeSocks5({ requireAuth: [USER, PASS], dialHost });
  try {
    const r = await rawKernelThroughUpstream(redUp.port);
    check('R. 页面拿不到出口信息（正文没有假代理的 IP）', !r.body.includes(FAKE_IP), fmt({ href: r.href, body: r.body.slice(0, 80) }));
    check('R. 上游记录：客户端只报了 no-auth（我们回了 0x02 后它就没法继续）',
      redUp.records.some((x) => x.status === 'reject_no_auth_offered' || (x.method === null && !x.offered.includes(0x02))),
      fmt(redUp.records.map((x) => ({ offered: x.offered, method: x.method, status: x.status })).slice(0, 3)));
    check('R. 上游一次都没收到过用户名密码（内核不会发）', redUp.authSeen.length === 0, `${redUp.authSeen.length} 次`);
    check('R. 目标 server 的 /exit 一次都没被命中（流量压根没出去）', targetHit('/exit') === 0, `命中 ${targetHit('/exit')}`);
  } finally {
    await redUp.close().catch(() => {});
  }

  /* ==========================================================================
   * G) 绿：产品链路 + 带凭据 SOCKS5 → 走中继，页面读到假代理那侧的值
   * ======================================================================== */
  console.log('\n=== G) 产品链路：带凭据 SOCKS5 → 本地中继 ===');
  {
    const up = await startFakeSocks5({ requireAuth: [USER, PASS], dialHost });
    const id = createCaseProfile('g', {
      proxy_type: 'socks5', host: '127.0.0.1', port: up.port, username: USER, password: PASS,
    });
    const frag = id.split('-')[0];
    try {
      const started = await manager.startProfile(profiles.getProfile(id));
      const inst = manager.getInstance(id);
      const relayPort = inst?.relay?.port || 0;

      check('G. 环境起来了（real_version 有值）', Boolean(started.real_version), fmt(started.real_version));
      check('G. chain_mode = relay（不是 chain / single）', inst?.chain_mode === 'relay', fmt(inst?.chain_mode));
      check('G. 中继起来了（relay.port > 0）', relayPort > 0, fmt({ relayPort }));

      const addrs = listenAddrs(relayPort);
      check('G. 中继只 bind 127.0.0.1（netstat 里没有 0.0.0.0）',
        Array.isArray(addrs) && addrs.length > 0 && addrs.every((a) => a.startsWith('127.0.0.1:')),
        Array.isArray(addrs) ? fmt(addrs) : '量不到（netstat 失败）');

      // ① 浏览器内出口探测：这是产品链路自己做的，读数在启动响应里
      check('G. 浏览器出口探测成功（egress.ok）', started.egress?.ok === true, fmt(started.egress?.error || ''));
      check('G. 出口 IP = 假代理那侧的值（流量真走了代理）', started.egress?.ip === FAKE_IP, fmt(started.egress?.ip));

      // ② 页面真的能开（不是只有探测页能开）
      const page = await openAndRead(inst, `http://${TEST_HOST}:${PORT}/page.html`);
      check('G. 页面经中继加载成功（正文有 RELAY-PAGE-OK）', String(page.snap?.body || '').includes('RELAY-PAGE-OK'), fmt(page.snap?.body));

      // ③ 凭据真的送到了上游
      check('G. 上游收到的凭据 = 环境里的账号密码',
        up.authSeen.length >= 1 && up.authSeen.every((a) => a.username === USER && a.password === PASS),
        `${up.authSeen.length} 次认证`);
      check('G. 上游隧道目标 = 目标 server 的 host:port',
        up.connects.some((c) => c.status === 'tunnel' && c.host === TEST_HOST && c.port === PORT),
        fmt(up.connects.slice(0, 3)));

      // ④ argv：只有本地中继，上游端口与凭据都不进命令行
      const lines = chromeProcsFor(frag);
      check('G. 能量到本环境的 chrome 进程（正例：不是「读了个空串所以全过」）',
        Array.isArray(lines) && lines.length > 0, Array.isArray(lines) ? `${lines.length} 个进程` : '量不到（powershell 失败）');
      const argv = (lines || []).join('\n');
      check('G. --proxy-server 只指向 127.0.0.1:<中继端口>',
        relayPort > 0 && argv.includes(`--proxy-server=socks5://127.0.0.1:${relayPort}`), fmt({ relayPort }));
      check('G. argv 里没有上游端口、用户名、密码',
        relayPort > 0 && !(new RegExp(`:${up.port}(?!\\d)`)).test(argv) && !argv.includes(USER) && !argv.includes(PASS), '');

      // ⑤ 凭据不进可见面：启动响应 / 环境日志 / 页面
      check('G. 启动响应里没有用户名密码', !fmt(started).includes(USER) && !fmt(started).includes(PASS),
        fmt({ hasUser: fmt(started).includes(USER), hasPass: fmt(started).includes(PASS) }));
      const logText = profileLog(id);
      check('G. 环境日志里有中继那一行（127.0.0.1:<port> → 上游 host:port）',
        logText.includes('代理中继') && logText.includes(`127.0.0.1:${relayPort}`), '');
      check('G. 环境日志里没有用户名密码', !logText.includes(USER) && !logText.includes(PASS),
        fmt({ hasUser: logText.includes(USER), hasPass: logText.includes(PASS) }));
      const nav = await inst.client.send('Runtime.evaluate', {
        expression: 'JSON.stringify({ua:navigator.userAgent,html:document.documentElement.outerHTML.slice(0,400)})',
        returnByValue: true,
      }, page.sessionId).catch(() => null);
      const navText = String(nav?.result?.value || '');
      check('G. 页面可见面（navigator / DOM）里没有用户名密码',
        navText.length > 0 && !navText.includes(USER) && !navText.includes(PASS), navText.slice(0, 80));

      // ⑥ 停止：端口不再 LISTEN、socket 清零
      const relayObj = inst?.relay || null;
      const before = await portState(relayPort);
      await manager.stopProfile(id);
      await sleep(300);
      const after = await portState(relayPort);
      check('G. 运行中中继端口可连（正例）', before === 'open', fmt(before));
      check('G. stop 后中继端口不再 LISTEN', after !== 'open', fmt(after));
      // 判据读的是**停止前抓住的那个中继对象**：stopProfile 会把 inst.relay 置 null，
      // 拿 inst.relay 判就成了「null 上没有 socket」的假绿。
      check('G. stop 后中继 socket 集合清零（读停止前抓住的对象）',
        Boolean(relayObj) && relayObj.sockets.size === 0 && relayObj.closed === true,
        fmt({ size: relayObj?.sockets?.size, closed: relayObj?.closed }));
    } finally {
      await manager.stopProfile(id).catch(() => {});
      await up.close().catch(() => {});
    }
  }

  /* ==========================================================================
   * N) 不带凭据的 socks5：仍走直连写法，**没有**多出中继
   * ======================================================================== */
  console.log('\n=== N) 无凭据 socks5 → 仍直连（不许顺手塞进中继） ===');
  {
    const up = await startFakeSocks5({ requireAuth: null, dialHost });
    const id = createCaseProfile('n', { proxy_type: 'socks5', host: '127.0.0.1', port: up.port });
    const frag = id.split('-')[0];
    try {
      const started = await manager.startProfile(profiles.getProfile(id));
      const inst = manager.getInstance(id);
      check('N. 环境起来了', Boolean(started.real_version), fmt(started.real_version));
      check('N. 没有起中继（inst.relay 为空）', !inst?.relay, fmt({ relay: inst?.relay ? inst.relay.port : null }));
      check('N. chain_mode 不是 relay', inst?.chain_mode !== 'relay', fmt(inst?.chain_mode));
      const page = await openAndRead(inst, `http://${TEST_HOST}:${PORT}/page.html`);
      check('N. 页面经上游 SOCKS5 加载成功（Chrome 自己能跑 no-auth）', String(page.snap?.body || '').includes('RELAY-PAGE-OK'), fmt(page.snap?.body));
      const lines = chromeProcsFor(frag);
      const argv = (lines || []).join('\n');
      check('N. --proxy-server 直接指向上游（socks5://127.0.0.1:<上游端口>）',
        Array.isArray(lines) && lines.length > 0 && argv.includes(`--proxy-server=socks5://127.0.0.1:${up.port}`), fmt({ upstream: up.port }));
      check('N. 上游收到的是 no-auth（method=0x00，没有子协商）',
        up.records.some((r) => r.method === 0x00), fmt(up.records.map((r) => r.method).slice(0, 3)));
    } finally {
      await manager.stopProfile(id).catch(() => {});
      await up.close().catch(() => {});
    }
  }

  /* ==========================================================================
   * H) http 带凭据代理：同样走中继并通（判据④）
   * ======================================================================== */
  console.log('\n=== H) http + Basic 认证 → 同样走中继 ===');
  {
    const up = await startFakeConnectProxy({ requireAuth: ['http-user', 'http-pass'], dialHost });
    const id = createCaseProfile('h', {
      proxy_type: 'http', host: '127.0.0.1', port: up.port, username: 'http-user', password: 'http-pass',
    });
    const frag = id.split('-')[0];
    try {
      const started = await manager.startProfile(profiles.getProfile(id));
      const inst = manager.getInstance(id);
      const relayPort = inst?.relay?.port || 0;
      check('H. 环境起来了', Boolean(started.real_version), fmt(started.real_version));
      check('H. chain_mode = relay', inst?.chain_mode === 'relay', fmt(inst?.chain_mode));
      check('H. 浏览器出口探测成功且 IP = 假代理那侧', started.egress?.ok === true && started.egress?.ip === FAKE_IP,
        fmt({ ok: started.egress?.ok, ip: started.egress?.ip, err: started.egress?.error }));
      const page = await openAndRead(inst, `http://${TEST_HOST}:${PORT}/page.html`);
      check('H. 页面加载成功（正文有 RELAY-PAGE-OK）', String(page.snap?.body || '').includes('RELAY-PAGE-OK'), fmt(page.snap?.body));
      check('H. 上游收到 Basic 凭据（CONNECT 上带着）', up.authSeen.length >= 1, `${up.authSeen.length} 次 CONNECT`);
      const lines = chromeProcsFor(frag);
      const argv = (lines || []).join('\n');
      check('H. 内核 argv 只指向本地中继，且不含 http 上游端口',
        relayPort > 0 && argv.includes(`--proxy-server=socks5://127.0.0.1:${relayPort}`) && !(new RegExp(`:${up.port}(?!\\d)`)).test(argv),
        fmt({ relayPort, upstream: up.port }));
    } finally {
      await manager.stopProfile(id).catch(() => {});
      await up.close().catch(() => {});
    }
  }

  /* ==========================================================================
   * X) 中继起不来 → fail-closed（800003，绝不降级直连）
   *
   * 说明口径：这条分支要 `listen(0,'127.0.0.1')` 自己失败才会触发，真机上造不出来
   * （端口是系统分的、回环永远在）。所以这里分两截，各自说清楚是哪一截的证据：
   *   ① 行为：`startRelay` 对坏参数**立刻抛**，不会起一个「看起来在跑」的空监听；
   *   ② 代码：manager 里那条 catch 把错误映射成 800003 + reason=proxy_relay_failed，
   *      并且它在 `buildArgs/launchChrome` **之前**，所以不存在「中继挂了还起内核」的路径。
   *      这是代码级判据，不冒充运行时读数。
   * ======================================================================== */
  console.log('\n=== X) 中继起不来 → fail-closed ===');
  {
    let err = null;
    try {
      const { startRelay } = await import('../src/proxy/relay.js');
      await startRelay({ type: 'socks5', host: '', port: 0 });
    } catch (e) { err = e; }
    check('X. startRelay 参数不全时立刻抛错（不会静默起空监听）', Boolean(err), err ? err.message : '没有抛错');

    const src = fs.readFileSync(path.join(ROOT, 'src', 'runtime', 'manager.js'), 'utf8');
    const iThrow = src.indexOf("reason = 'proxy_relay_failed'");
    const iLaunch = src.indexOf('child = launchChrome(');
    check('X. manager 把中继失败映射成 800003 + proxy_relay_failed',
      iThrow > 0 && /err\.code = 800003;/.test(src.slice(Math.max(0, iThrow - 400), iThrow)), fmt({ iThrow }));
    check('X. 该分支在 launchChrome 之前（不存在「中继挂了还起内核」的路径）',
      iThrow > 0 && iLaunch > 0 && iThrow < iLaunch, fmt({ iThrow, iLaunch }));
  }
}

try {
  await main();
} catch (e) {
  console.log('异常：', e && e.stack ? e.stack.split('\n').slice(0, 8).join(' | ') : e);
  check('整体跑通（无异常）', false, String(e && e.message));
}
try { await manager.stopAll(); } catch { /* ignore */ }
try { srv.closeAllConnections?.(); } catch { /* ignore */ }
try { srv.close(); } catch { /* ignore */ }
await sleep(300);
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
