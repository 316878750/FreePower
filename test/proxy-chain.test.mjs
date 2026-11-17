/**
 * 多级代理链：**真机判据**（真内核 + 三个本机件，不碰外网、不碰注册表）
 *
 * 口径（CEO 2026-11-12 拍板，见 docs/13-P-第二批-多级代理链设计回执.md）：
 *   hop0 = **本机 Windows 系统代理**（用 `readSystemProxy` 的注入值模拟，测试绝不改用户注册表）
 *   hop1 = **环境代理**（`user_proxy_config`）
 *   浏览器只看到 `--proxy-server=http://127.0.0.1:<relayPort>`，上游 host/port/凭据都不进 argv
 *   （这条判据是**我们自己的口径**，不是对手口径 —— 对手走内核 `--protected-staticconfig`）。
 *
 * 三个本机件：
 *   - 假系统代理（记录型，当 hop0）
 *   - 假环境代理（记录型，当 hop1；可要求 Basic 认证）
 *   - 目标 server（按 `target.test:<port>` 访问，代理负责解析到 127.0.0.1 —— 不用 loopback 字面量，
 *     免得 `--proxy-bypass-list=<-loopback>` 万一没生效时，「0 命中」是因为流量压根没进链而假绿）
 *
 * 每条「0 命中」都**成对**给正例（同一次跑里必须另有 >0 的读数），否则红。
 *
 * 跑法：npm run test:proxy-chain
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

/* ------------------------------ 目标 server ------------------------------ */

const TEST_HOST = 'target.test';
const hits = [];
let PORT = 0;

const srv = http.createServer((req, res) => {
  const p = String(req.url || '/').split('?')[0];
  hits.push({ path: p, host: req.headers.host || '' });
  if (p === '/exit') {
    // 出口接口形状（checkProxy 与浏览器内探测都读它）
    const body = JSON.stringify({
      status: 'success', country: 'Japan', countryCode: 'JP', regionName: 'Tokyo',
      city: 'Tokyo', timezone: 'Asia/Tokyo', isp: 'Chain Lab', query: '203.0.113.7',
    });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  if (p === '/page.html' || p === '/after-break.html') {
    const marker = p === '/page.html' ? 'PAGE-OK' : 'AFTER-BREAK-OK';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>chain</title></head><body>${marker}</body></html>`);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('no');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
PORT = srv.address().port;
const targetHit = (p) => hits.filter((h) => h.path === p).length;

/* ------------------------------ 记录型代理 ------------------------------ */

/** `target.test` 这类测试主机名由代理侧解析到 127.0.0.1（浏览器不需要 DNS） */
const dialHost = (h) => (h === TEST_HOST ? '127.0.0.1' : h);

function splitAuthority(authority) {
  const s = String(authority || '');
  const i = s.lastIndexOf(':');
  if (i <= 0) return [s, 80];
  return [s.slice(0, i).replace(/^\[|\]$/g, ''), Number(s.slice(i + 1)) || 80];
}

/**
 * 起一个「记录 + 转发」的 HTTP 代理。两种请求都记：
 *   - 绝对 URI（明文 http 直接交给代理时）
 *   - CONNECT（隧道）—— 记下上游 socket 的**本地端口**，用来证明「上游确实是上一跳」
 * @param {{label:string, auth?:[string,string]|null}} opt
 */
function startRecorder({ label, auth = null } = {}) {
  const records = [];
  const sockets = new Set();
  const wantAuth = auth ? `Basic ${Buffer.from(`${auth[0]}:${auth[1]}`).toString('base64')}` : null;

  const server = http.createServer((req, res) => {
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400); res.end('bad request'); return; }
    const rec = {
      hop: label, method: req.method, target: `${u.hostname}:${u.port || 80}`, path: u.pathname,
      auth: req.headers['proxy-authorization'] || '', clientPort: req.socket.remotePort,
      upstreamLocalPort: null, status: null,
    };
    records.push(rec);
    if (wantAuth && rec.auth !== wantAuth) {
      rec.status = 407;
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="rec"' });
      res.end('auth required');
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const up = http.request({
      host: dialHost(u.hostname), port: Number(u.port || 80), method: req.method,
      path: `${u.pathname}${u.search}`, headers,
    }, (ur) => {
      rec.status = ur.statusCode;
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    up.on('socket', (s) => { if (s.localPort) rec.upstreamLocalPort = s.localPort; });
    up.on('error', () => {
      rec.status = 502;
      try { res.writeHead(502); res.end('hop upstream error'); } catch { /* ignore */ }
    });
    req.pipe(up);
  });

  server.on('connect', (req, clientSocket, head) => {
    clientSocket.on('error', () => { /* 浏览器/中继主动断 */ });
    sockets.add(clientSocket);
    clientSocket.on('close', () => sockets.delete(clientSocket));
    const rec = {
      hop: label, method: 'CONNECT', target: req.url,
      auth: req.headers['proxy-authorization'] || '', clientPort: clientSocket.remotePort,
      upstreamLocalPort: null, status: null,
    };
    records.push(rec);
    if (wantAuth && rec.auth !== wantAuth) {
      rec.status = 407;
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="rec"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const [host, port] = splitAuthority(req.url);
    const up = net.connect({ host: dialHost(host), port });
    sockets.add(up);
    up.on('close', () => sockets.delete(up));
    up.on('connect', () => {
      rec.status = 200;
      rec.upstreamLocalPort = up.localPort;
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) up.write(head);
      clientSocket.pipe(up);
      up.pipe(clientSocket);
    });
    up.on('error', () => {
      rec.status = 502;
      try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); } catch { /* ignore */ }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        label,
        port,
        records,
        url: `http://127.0.0.1:${port}`,
        /** 关掉：先断所有连接再 close —— 「运行中断链」那条要求真的不可连 */
        close: () => new Promise((r) => {
          for (const s of sockets) { try { s.destroy(); } catch { /* ignore */ } }
          sockets.clear();
          server.close(() => r());
        }),
      });
    });
  });
}

/* ------------------------------ 一次性数据目录 ------------------------------ */

const DATA = path.join(ROOT, '.tmp', `chain-${process.pid}-${Date.now()}`);
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.FREEPOWER_DATA = DATA;
process.env.FREEPOWER_SELFCHECK = '0';
// 出口探测走本机目标 server：整条链的预检（checkProxy）与浏览器内探测都不依赖外网
process.env.FREEPOWER_EGRESS_PROBE = `http://${TEST_HOST}:${PORT}/exit`;
process.env.FREEPOWER_PROXY_TIMEOUT = '4000';
process.env.FREEPOWER_EGRESS_TIMEOUT = '4000';

const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');

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

/** 127.0.0.1:<port> 上还有没有人 LISTEN */
function portState(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const t = setTimeout(() => { s.destroy(); resolve('timeout'); }, 1500);
    s.once('connect', () => { clearTimeout(t); s.destroy(); resolve('open'); });
    s.once('error', (e) => { clearTimeout(t); resolve(e.code || 'error'); });
  });
}

/** 开页并读回：**必须等到目标文档落地**（about:blank 也是 complete，不能拿它当成功） */
async function openAndRead(inst, url, { timeoutMs = 15000 } = {}) {
  const wantPath = new URL(url).pathname;
  const { sessionId } = await inst.openPage(url);
  const deadline = Date.now() + timeoutMs;
  let snap = null;
  while (Date.now() < deadline) {
    const r = await inst.client.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ready:document.readyState,href:location.href,body:(document.body?document.body.innerText:"").slice(0,160)})',
      returnByValue: true,
    }, sessionId).catch(() => null);
    try { snap = JSON.parse(r?.result?.value || 'null'); } catch { /* ignore */ }
    if (snap && snap.ready === 'complete' && String(snap.href || '').includes(wantPath)) break;
    await sleep(150);
  }
  await sleep(250);   // 给服务器计数一点余量
  return { sessionId, snap };
}

function createCaseProfile(label, { envProxy = null, chainOn = '1' } = {}) {
  const fields = {
    name: `chain-${label}-${Date.now()}`,
    group_id: '0',
    is_multi_level_proxy: chainOn,
  };
  if (envProxy) fields.user_proxy_config = envProxy;
  const created = profiles.createProfile(fields);
  if (!created.profile_id) throw new Error(`建环境失败：${fmt(created)}`);
  return created.profile_id;
}

const asCase = (label, { envProxy = null, chainOn = '1' } = {}) => createCaseProfile(label, { envProxy, chainOn });

/**
 * 所有用例都在 main() 里跑：任何一步抛异常（例如实现被改坏导致启动被拒）都要变成**一条红的读数**，
 * 而不是把进程直接崩掉 —— 崩掉只会留下半截日志和临时目录，看不出「哪条判据没过去」。
 */
async function main() {

  /* ==========================================================================
   * A) 链开 + 有系统代理：两跳都真被走过（每一跳都有命中，且「上一跳→下一跳」对得上）
   * ======================================================================== */
  console.log('\n=== A) is_multi_level_proxy=1 + 系统代理存在 → 两跳 ===');
  {
    const hop0 = await startRecorder({ label: 'A-hop0' });
    const envAuth = ['env-user', 'env-pass-9f3a'];
    const hop1 = await startRecorder({ label: 'A-hop1', auth: envAuth });
    const id = asCase('a', {
      envProxy: { proxy_type: 'http', host: '127.0.0.1', port: hop1.port, username: envAuth[0], password: envAuth[1] },
    });
    const frag = id.split('-')[0];
    try {
      const started = await manager.startProfile(profiles.getProfile(id), {
        systemProxy: { ProxyEnable: 1, ProxyServer: `127.0.0.1:${hop0.port}`, ProxyOverride: '<local>' },
      });
      const inst = manager.getInstance(id);
      const relayPort = inst?.chain?.port || 0;
      const page = await openAndRead(inst, `http://${TEST_HOST}:${PORT}/page.html`);
      const hop0ToHop1 = hop0.records.filter((r) => r.method === 'CONNECT' && r.target === `127.0.0.1:${hop1.port}`);
      const hop1ToTarget = hop1.records.filter((r) => r.method === 'CONNECT' && r.target === `${TEST_HOST}:${PORT}`);

      check('A. 环境起来了（real_version 有值）', Boolean(started.real_version), fmt(started.real_version));
      check('A. 页面经链加载成功（正文有 PAGE-OK）', String(page.snap?.body || '').includes('PAGE-OK'), fmt(page.snap?.body));
      check('A. 目标 server 命中 ≥1（正例：流量真的到站了）', targetHit('/page.html') >= 1, `命中 ${targetHit('/page.html')}`);
      check('A. hop0 命中 ≥1（系统代理这一跳真被走了）', hop0ToHop1.length >= 1, `CONNECT→hop1 次数 ${hop0ToHop1.length}`);
      check('A. hop1 命中 ≥1（环境代理这一跳真被走了）', hop1ToTarget.length >= 1, `CONNECT→target 次数 ${hop1ToTarget.length}`);
      check('A. hop0 记录的上游目标 = hop1 的 host:port（不是目标 server）',
        hop0ToHop1.length >= 1 && hop0ToHop1.every((r) => r.status === 200),
        fmt(hop0ToHop1.map((r) => `${r.target} status=${r.status}`)));
      check('A. hop1 记录的上游目标 = 目标 server',
        hop1ToTarget.length >= 1 && hop1ToTarget.every((r) => r.status === 200),
        fmt(hop1ToTarget.map((r) => r.target)));
      check('A. hop1 看到的 client 源端口 = hop0 出站 socket 的本地端口（证明「上游是上一跳」）',
        hop0ToHop1.some((r) => hop1.records.some((x) => x.clientPort === r.upstreamLocalPort)),
        fmt({ hop0Out: hop0ToHop1.map((r) => r.upstreamLocalPort).slice(0, 4), hop1In: hop1.records.map((r) => r.clientPort).slice(0, 4) }));

      /* 凭据不串层：系统代理没有凭据，hop1 的账密只能出现在 hop1 那一跳 */
      check('A. hop0 收到的 Proxy-Authorization 里没有 hop1 的账密（一个都没有）',
        hop0.records.every((r) => !r.auth)
        && !fmt(hop0.records).includes(envAuth[1]) && !fmt(hop0.records).includes(envAuth[0]),
        fmt({ hop0Auths: hop0.records.map((r) => r.auth).filter(Boolean).length }));
      const wantEnv = `Basic ${Buffer.from(`${envAuth[0]}:${envAuth[1]}`).toString('base64')}`;
      check('A. hop1 收到的 Proxy-Authorization 正是它自己的账密（凭据挂对了层）',
        hop1.records.some((r) => r.auth === wantEnv), fmt(hop1.records.map((r) => r.auth).filter(Boolean).slice(0, 2)));

      /* argv 判据（我们自己的口径）：只许出现本地中继，上游 host/port/凭据都不许进命令行 */
      const lines = chromeProcsFor(frag);
      check('A. 能量到本环境的 chrome 进程（正例：不是「读了个空串所以全过」）',
        Array.isArray(lines) && lines.length > 0, Array.isArray(lines) ? `${lines.length} 个进程` : '量不到（powershell 失败）');
      const argv = (lines || []).join('\n');
      check('A. --proxy-server 只指向 127.0.0.1:<relayPort>',
        relayPort > 0 && argv.includes(`--proxy-server=http://127.0.0.1:${relayPort}`), fmt({ relayPort }));
      check('A. argv 里没有 hop1 的端口、用户名、密码',
        relayPort > 0 && !(new RegExp(`:${hop1.port}(?!\\d)`)).test(argv)
        && !argv.includes(envAuth[0]) && !argv.includes(envAuth[1]), '');

      /* stop 之后本地监听必须真的关掉（漏端口几轮后才炸） */
      const before = await portState(relayPort);
      await manager.stopProfile(id);
      await sleep(300);
      const after = await portState(relayPort);
      check('A. 运行时 relayPort 在 127.0.0.1 上可连（正例）', before === 'open', fmt(before));
      check('A. stop 后 relayPort 查不到 LISTEN（连接被拒/超时）', after !== 'open', fmt(after));
    } finally {
      await manager.stopProfile(id).catch(() => {});
      await hop0.close().catch(() => {});
      await hop1.close().catch(() => {});
    }
  }

  /* ==========================================================================
   * B) 无系统代理：塌成单跳，仍然正常启动（hop0 命中 0，hop1 命中 >0）
   * ======================================================================== */
  console.log('\n=== B) is_multi_level_proxy=1 但系统代理未启用 → 塌成单跳 ===');
  {
    const hop0 = await startRecorder({ label: 'B-hop0' });      // 备着，但 ProxyEnable=0，不该被用
    const hop1 = await startRecorder({ label: 'B-hop1' });
    const id = asCase('b', { envProxy: { proxy_type: 'http', host: '127.0.0.1', port: hop1.port } });
    try {
      const started = await manager.startProfile(profiles.getProfile(id), {
        systemProxy: { ProxyEnable: 0, ProxyServer: `127.0.0.1:${hop0.port}` },
      });
      const inst = manager.getInstance(id);
      const relayPort = inst?.chain?.port || 0;
      const page = await openAndRead(inst, `http://${TEST_HOST}:${PORT}/page.html`);
      // 单跳时 Chrome 对明文 http 直接用绝对 URI 请求代理（不是 CONNECT），所以按「路径 + 上游主机」认
      const hop1ToTarget = hop1.records.filter((r) => r.target === `${TEST_HOST}:${PORT}`);
      const hop1Page = hop1ToTarget.filter((r) => r.path === '/page.html');
      check('B. 环境起来了（塌成单跳不是失败）', Boolean(started.real_version), fmt(started.real_version));
      check('B. 没有起本地中继（单跳直接交给内核）', relayPort === 0, fmt({ relay: relayPort }));
      check('B. 页面加载成功（正文有 PAGE-OK）', String(page.snap?.body || '').includes('PAGE-OK'), fmt(page.snap?.body));
      check('B. hop0 命中 = 0（系统代理未启用，这一跳完全不参与）', hop0.records.length === 0, `hop0 记录 ${hop0.records.length}`);
      check('B. hop1 命中 ≥1 且 page.html 走它到站（成对正例）',
        hop1ToTarget.length >= 1 && hop1Page.length >= 1 && hop1Page.every((r) => r.status === 200),
        `hop1 命中 ${hop1ToTarget.length}（page ${hop1Page.length}）：${fmt(hop1Page.map((r) => `${r.method} ${r.target}${r.path} status=${r.status}`))}`);
    } finally {
      await manager.stopProfile(id).catch(() => {});
      await hop0.close().catch(() => {});
      await hop1.close().catch(() => {});
    }
  }

  /* ==========================================================================
   * C) 断链 fail-closed：hop1 关掉 → 800003 + proxy_chain_hop_failed + 零内核
   * ======================================================================== */
  console.log('\n=== C) 两跳但 hop1 不可达 → fail-closed 拒绝启动 ===');
  {
    const hop0 = await startRecorder({ label: 'C-hop0' });
    const hop1 = await startRecorder({ label: 'C-hop1' });
    await hop1.close();   // 环境代理这一跳直接不可达
    const id = asCase('c', { envProxy: { proxy_type: 'http', host: '127.0.0.1', port: hop1.port } });
    try {
      let err = null;
      try {
        await manager.startProfile(profiles.getProfile(id), { systemProxy: { ProxyEnable: 1, ProxyServer: `127.0.0.1:${hop0.port}` } });
      } catch (e) { err = e; }
      check('C. 启动被拒（抛错而不是静默直连）', Boolean(err), err ? err.message : '没有抛错');
      check('C. code=800003 + reason=proxy_chain_hop_failed', err?.code === 800003 && err?.reason === 'proxy_chain_hop_failed',
        fmt({ code: err?.code, reason: err?.reason }));
      check('C. failed_hop = 1（是第二跳没能穿过去）', err?.failed_hop === 1, fmt(err?.failed_hop));
      check('C. hop0 确实被连过并回报了上游失败（正例：不是没试就下结论）',
        hop0.records.length >= 1 && hop0.records.every((r) => r.status === 502),
        fmt(hop0.records.map((r) => `${r.target} status=${r.status}`).slice(0, 3)));
      const procs = chromeProcsFor(id.split('-')[0]);
      check('C. 零内核进程（按 --user-data-dir 归类；量不到也算红）',
        Array.isArray(procs) && procs.length === 0, Array.isArray(procs) ? `${procs.length} 个` : '量不到（powershell 失败）');
      check('C. 目标 server 命中 = 0（直连反例）', targetHit('/case-c.html') === 0, `命中 ${targetHit('/case-c.html')}`);
    } finally {
      await manager.stopProfile(id).catch(() => {});
      await hop0.close().catch(() => {});
    }
  }

  /* ==========================================================================
   * C2) 系统代理要求认证（注册表里没有凭据）→ 同样 fail-closed，failed_hop=0
   * ======================================================================== */
  console.log('\n=== C2) 系统代理要求认证 → fail-closed（failed_hop=0） ===');
  {
    const hop0 = await startRecorder({ label: 'C2-hop0', auth: ['sys-user', 'sys-pass'] });
    const hop1 = await startRecorder({ label: 'C2-hop1' });
    const id = asCase('c2', { envProxy: { proxy_type: 'http', host: '127.0.0.1', port: hop1.port } });
    try {
      let err = null;
      try {
        await manager.startProfile(profiles.getProfile(id), { systemProxy: { ProxyEnable: 1, ProxyServer: `127.0.0.1:${hop0.port}` } });
      } catch (e) { err = e; }
      check('C2. 启动被拒（缺系统代理凭据时报错，不假装能用）',
        Boolean(err) && err.code === 800003 && err.reason === 'proxy_chain_hop_failed',
        fmt({ code: err?.code, reason: err?.reason }));
      check('C2. failed_hop = 0（407 是**这一跳**不认凭据，不是下一跳）', err?.failed_hop === 0, fmt(err?.failed_hop));
      check('C2. hop0 确实收到了我们的 CONNECT 并回了 407（正例：不是没试就下结论）',
        hop0.records.some((r) => r.status === 407), fmt(hop0.records.map((r) => r.status).slice(0, 3)));
      const procs = chromeProcsFor(id.split('-')[0]);
      check('C2. 零内核进程', Array.isArray(procs) && procs.length === 0, Array.isArray(procs) ? `${procs.length} 个` : '量不到（powershell 失败）');
    } finally {
      await manager.stopProfile(id).catch(() => {});
      await hop0.close().catch(() => {});
      await hop1.close().catch(() => {});
    }
  }

  /* ==========================================================================
   * D) 运行中断链：关掉 hop0 → 再请求失败，且目标命中不增加（防回落直连）
   * ======================================================================== */
  console.log('\n=== D) 起来之后关掉 hop0 → 请求失败、目标命中不增加 ===');
  {
    const hop0 = await startRecorder({ label: 'D-hop0' });
    const hop1 = await startRecorder({ label: 'D-hop1' });
    const id = asCase('d', { envProxy: { proxy_type: 'http', host: '127.0.0.1', port: hop1.port } });
    try {
      await manager.startProfile(profiles.getProfile(id), { systemProxy: { ProxyEnable: 1, ProxyServer: `127.0.0.1:${hop0.port}` } });
      const inst = manager.getInstance(id);
      const page = await openAndRead(inst, `http://${TEST_HOST}:${PORT}/page.html`);
      check('D. 断链前页面正常（正例：链本来是通的）', String(page.snap?.body || '').includes('PAGE-OK'), fmt(page.snap?.body));

      await hop0.close();
      await sleep(200);
      const beforeHit = targetHit('/after-break.html');
      const page2 = await openAndRead(inst, `http://${TEST_HOST}:${PORT}/after-break.html`, { timeoutMs: 8000 });
      await sleep(400);
      check('D. 断链后页面拿不到内容（正文没有 AFTER-BREAK-OK）',
        !String(page2.snap?.body || '').includes('AFTER-BREAK-OK'), fmt(page2.snap?.body));
      check('D. 断链后目标 server 命中不增加（**没有**回落直连）',
        beforeHit === 0 && targetHit('/after-break.html') === 0, `命中 ${beforeHit} → ${targetHit('/after-break.html')}`);
    } finally {
      await manager.stopProfile(id).catch(() => {});
      await hop0.close().catch(() => {});
      await hop1.close().catch(() => {});
    }
  }

  /* ==========================================================================
   * E) 单跳认证回归：0.4.7.3 起带凭据的单跳**改走本地中继**（内核不支持 SOCKS5 认证）
   *    —— 这里钉两件事：① 页面照样能开；② 代理侧照样收到本环境的账密（认证真的发生了）。
   *    注意口径变了：不再是 `Fetch.authRequired` 那条路，而是中继对上游完成认证。
   * ======================================================================== */
  console.log('\n=== E) 单跳 + 代理认证 → 走本地中继（0.4.7.3 起） ===');
  {
    const hop0 = await startRecorder({ label: 'E-hop0' });
    const hop = await startRecorder({ label: 'E-hop', auth: ['single-user', 'single-pass'] });
    const id = asCase('e', {
      envProxy: { proxy_type: 'http', host: '127.0.0.1', port: hop.port, username: 'single-user', password: 'single-pass' },
      chainOn: '0',
    });
    try {
      const started = await manager.startProfile(profiles.getProfile(id), {
        systemProxy: { ProxyEnable: 1, ProxyServer: `127.0.0.1:${hop0.port}` },
      });
      const inst = manager.getInstance(id);
      const page = await openAndRead(inst, `http://${TEST_HOST}:${PORT}/page.html`);
      const want = `Basic ${Buffer.from('single-user:single-pass').toString('base64')}`;
      const authSeen = hop.records.filter((r) => r.auth === want);
      check('E. 链关着时环境正常起来（系统代理不参与）', Boolean(started.real_version), fmt(started.real_version));
      check('E. 页面加载成功（认证由本地中继对上游完成）',
        String(page.snap?.body || '').includes('PAGE-OK'), fmt(page.snap?.body));
      check('E. 代理侧确实收到了本环境的账密（正例：认证真的发生了）', authSeen.length >= 1, `命中 ${authSeen.length}`);
      check('E. 链关着时 hop0 一次都没被用（对照）', hop0.records.length === 0, `hop0 记录 ${hop0.records.length}`);
      check('E. 带凭据的单跳走的是中继（chain_mode=relay，内核只看到 127.0.0.1）',
        inst?.chain_mode === 'relay' && Boolean(inst?.relay?.port), fmt({ mode: inst?.chain_mode, relay: inst?.relay?.port }));
    } finally {
      await manager.stopProfile(id).catch(() => {});
      await hop0.close().catch(() => {});
      await hop.close().catch(() => {});
    }
  }

}   // main()

/* ------------------------------ 收尾 ------------------------------ */
try {
  await main();
} catch (e) {
  console.log('异常：', e && e.stack ? e.stack.split('\n').slice(0, 6).join(' | ') : e);
  check('整体跑通（无异常）', false, String(e && e.message));
}
try { srv.closeAllConnections?.(); } catch { /* ignore */ }
try { srv.close(); } catch { /* ignore */ }
await sleep(200);
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
