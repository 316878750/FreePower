/**
 * 本地中继（src/proxy/relay.js）的**单元判据**：不启内核，只验协议与生命周期。
 *
 * 为什么要单独一层：内核那条（test/proxy-relay-kernel.test.mjs）跑一次要几秒，
 * 而「上游握手到底带没带凭据」「只 bind 回环没有」「close 之后端口还在不在」
 * 这些问题在 socket 层就能钉死，红了能立刻定位到 relay.js 而不是「内核又抽风了」。
 *
 * 判据清单（对应 CEO 0.4.7.3 任务 A 的第 2/3/4 条）：
 *   1. 上游 SOCKS5 要用户名密码 → 中继替浏览器完成子协商，请求成功，且**上游收到的凭据 = 环境账密**；
 *   2. 上游 HTTP 代理要 Basic 认证 → 同样通（CONNECT + Proxy-Authorization）；
 *   3. 凭据错了 → 请求失败、`stats.failed` 增加、`lastError` 说明是认证失败；
 *   4. 只 bind `127.0.0.1`（netstat 读数，不是看代码猜）；
 *   5. `close()` 之后端口不再 LISTEN、socket 集合清零（反复起停不漏端口）；
 *   6. **凭据不进日志面**：`stats` / `lastError` 里都查不到用户名密码。
 *
 * 跑法：npm run test:proxy-relay
 */
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { startRelay } from '../src/proxy/relay.js';
import { httpGetViaProxy } from '../src/proxy/probe.js';
import { startEchoServer } from './fake-proxy.mjs';
import { startFakeSocks5, startFakeConnectProxy } from './fake-socks5.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const fmt = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const USER = 'relay-user';
const PASS = 'relay-pass-7c1d';

/** `127.0.0.1:<port>` 上还有没有人 LISTEN */
function portState(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const t = setTimeout(() => { s.destroy(); resolve('timeout'); }, 1500);
    s.once('connect', () => { clearTimeout(t); s.destroy(); resolve('open'); });
    s.once('error', (e) => { clearTimeout(t); resolve(e.code || 'error'); });
  });
}

/**
 * 本机所有 LISTENING 套接字的本地地址（形如 `127.0.0.1:54321` / `0.0.0.0:54321`）。
 * 判「只 bind 回环」必须看这个 —— 代码里写了 `'127.0.0.1'` 不等于运行时就是这样。
 */
function listenAddrs(port) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 15000 });
    const hit = [];
    for (const line of String(out).split(/\r?\n/)) {
      const m = /^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+\d+/i.exec(line);
      if (!m) continue;
      const local = m[1];
      if (local.endsWith(`:${port}`)) hit.push(local);
    }
    return hit;
  } catch {
    return null;   // 量不到就如实报「量不到」，不当成 0
  }
}

const asJson = async (r) => {
  try { return JSON.parse(r.body); } catch { return {}; }
};

async function main() {
  const echo = await startEchoServer({ ip: '203.0.113.77', country: 'Japan', countryCode: 'JP', timezone: 'Asia/Tokyo' });

  /* ==========================================================================
   * 1) 上游 = 要求用户名密码的 SOCKS5
   * ======================================================================== */
  console.log('\n=== 1) 中继 → 要认证的 SOCKS5 上游 ===');
  {
    const up = await startFakeSocks5({ requireAuth: [USER, PASS] });
    const relay = await startRelay({ type: 'socks5', host: '127.0.0.1', port: up.port, username: USER, password: PASS });
    try {
      const addrs = listenAddrs(relay.port);
      check('1. 中继只 bind 127.0.0.1（netstat 读数里没有 0.0.0.0 / [::]）',
        Array.isArray(addrs) && addrs.length > 0 && addrs.every((a) => a.startsWith('127.0.0.1:')),
        Array.isArray(addrs) ? fmt(addrs) : '量不到（netstat 失败）');

      const res = await httpGetViaProxy({ type: 'socks5', host: '127.0.0.1', port: relay.port }, echo.url, { timeoutMs: 6000 });
      const body = await asJson(res);
      check('1. 请求经中继成功（HTTP 200）', res.status === 200, fmt(res.status));
      check('1. 读到的是假代理那侧的出口 IP', body.query === '203.0.113.77', fmt(body.query));
      check('1. 上游 SOCKS5 确实收到了用户名密码子协商（method=0x02）',
        up.records.some((r) => r.method === 0x02), fmt(up.records.map((r) => ({ offered: r.offered, method: r.method, status: r.status })).slice(0, 3)));
      check('1. 上游收到的凭据 = 环境里的账号密码',
        up.authSeen.length >= 1 && up.authSeen.every((a) => a.username === USER && a.password === PASS),
        `${up.authSeen.length} 次认证`);
      check('1. 隧道目标 = 出口接口的 host:port',
        up.connects.some((c) => c.status === 'tunnel' && c.port === echo.port), fmt(up.connects.slice(0, 3)));
      check('1. 中继计数：tunnels ≥ 1、failed = 0', relay.stats.tunnels >= 1 && relay.stats.failed === 0,
        fmt({ tunnels: relay.stats.tunnels, failed: relay.stats.failed }));

      /* 凭据不许出现在日志面（stats / lastError 是唯一会往外打的两个对象） */
      const logFace = `${fmt(relay.stats)} ${String(relay.lastError?.message || '')}`;
      check('1. stats / lastError 里查不到用户名密码（凭据不进日志面）',
        !logFace.includes(USER) && !logFace.includes(PASS), logFace.slice(0, 120));

      /* close：先断连接再关监听 */
      const before = await portState(relay.port);
      await relay.close();
      await sleep(200);
      const after = await portState(relay.port);
      check('1. 运行中中继端口可连（正例）', before === 'open', fmt(before));
      check('1. close 后端口不再 LISTEN', after !== 'open', fmt(after));
      check('1. close 后 socket 集合清零', relay.sockets.size === 0, `剩 ${relay.sockets.size}`);
    } finally {
      await relay.close().catch(() => {});
      await up.close().catch(() => {});
    }
  }

  /* ==========================================================================
   * 2) 上游 = 要 Basic 认证的 HTTP 代理（判据④）
   * ======================================================================== */
  console.log('\n=== 2) 中继 → 要认证的 HTTP 上游（CONNECT） ===');
  {
    const up = await startFakeConnectProxy({ requireAuth: ['http-user', 'http-pass'] });
    const relay = await startRelay({ type: 'http', host: '127.0.0.1', port: up.port, username: 'http-user', password: 'http-pass' });
    try {
      const res = await httpGetViaProxy({ type: 'socks5', host: '127.0.0.1', port: relay.port }, echo.url, { timeoutMs: 6000 });
      const body = await asJson(res);
      const want = `Basic ${Buffer.from('http-user:http-pass').toString('base64')}`;
      check('2. HTTP 上游 + 凭据：请求经中继成功', res.status === 200 && body.query === '203.0.113.77', fmt({ status: res.status, ip: body.query }));
      check('2. 上游收到的 Proxy-Authorization 正是环境账密',
        up.authSeen.includes(want), `${up.authSeen.length} 次 CONNECT`);
    } finally {
      await relay.close().catch(() => {});
      await up.close().catch(() => {});
    }
  }

  /* ==========================================================================
   * 3) 凭据错了：失败要记账，不许静默成功
   * ======================================================================== */
  console.log('\n=== 3) 上游凭据错了 → 失败并记账 ===');
  {
    const up = await startFakeSocks5({ requireAuth: [USER, PASS] });
    const relay = await startRelay({ type: 'socks5', host: '127.0.0.1', port: up.port, username: USER, password: 'wrong-pass' });
    try {
      let err = null;
      try {
        await httpGetViaProxy({ type: 'socks5', host: '127.0.0.1', port: relay.port }, echo.url, { timeoutMs: 5000 });
      } catch (e) { err = e; }
      check('3. 凭据错时请求失败（不静默成功）', Boolean(err), err ? err.message.slice(0, 80) : '居然成功了');
      check('3. 上游记录到认证失败（正例：不是没试就下结论）',
        up.records.some((r) => r.status === 'auth_failed'), fmt(up.records.map((r) => r.status)));
      check('3. relay.stats.failed ≥ 1', relay.stats.failed >= 1, `failed=${relay.stats.failed}`);
      check('3. relay.lastError 说明是上游认证失败',
        /认证失败|auth/i.test(String(relay.lastError?.message || '')), String(relay.lastError?.message || '').slice(0, 80));
      check('3. lastError 里没有密码明文', !String(relay.lastError?.message || '').includes('wrong-pass'),
        String(relay.lastError?.message || '').slice(0, 80));
    } finally {
      await relay.close().catch(() => {});
      await up.close().catch(() => {});
    }
  }

  /* ==========================================================================
   * 4) 参数校验：缺 host/port 直接抛，不许起一个「看起来在跑」的空监听
   * ======================================================================== */
  console.log('\n=== 4) 参数不完整 → 立刻抛错 ===');
  {
    let e1 = null;
    try { await startRelay({ type: 'socks5', host: '', port: 0 }); } catch (e) { e1 = e; }
    check('4. 缺 host/port 时 startRelay 抛错', Boolean(e1), e1 ? e1.message : '没有抛错');
  }

  await echo.close().catch(() => {});
}

try {
  await main();
} catch (e) {
  console.log('异常：', e && e.stack ? e.stack.split('\n').slice(0, 6).join(' | ') : e);
  check('整体跑通（无异常）', false, String(e && e.message));
}

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
