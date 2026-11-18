/**
 * 中继的**有界并发**判据（0.4.7.5 红①）：不启内核，只压 relay.js。
 *
 * 用户实测的真相（2026-11-18 14:32，4 个环境）：
 *   Chrome 一个实例启动瞬间对中继开 **14 条连接**（10 条是 Google 后台：clients2.google.com、
 *   update.googleapis.com、redirector.gvt1.com …），中继**每条都现拨上游**、没有上限，
 *   上游 TCP connect 排队 3.6s→10.6s，超过 10 秒硬超时 → `ERR_SOCKS_CONNECTION_FAILED(-120)`
 *   → 页面全打不开、起始页写「代理未连通」。
 *
 * 这里用一个**串行握手**的假上游复现同一件事（不许拿用户的真代理压测）：
 *   握手并发 1、每个握手 900ms → 14 条同时来，第 12 条起就等过 10 秒。
 *
 * 判据：
 *   ① 14 并发必须**全通**（改之前第 12 条起就 REP_FAIL）；
 *   ② 上游同时看到的握手数 ≤ 4（默认上限），排队的连接数 ≥ 10；
 *   ③ 单连接超时是 30s（不是 10s）；
 *   ④ 每条隧道真的能读回出口内容（不是只握手成功）；
 *   ⑤ 上限可配（concurrency: 2 → 上游最多同时看到 2）；
 *   ⑥ 超时/失败进 stats 与 lastError，且**不含凭据**。
 *
 * 跑法：npm run test:proxy-relay-queue
 */
import net from 'node:net';
import { startRelay } from '../src/proxy/relay.js';
import { startEchoServer } from './fake-proxy.mjs';
import { startFakeSocks5 } from './fake-socks5.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const USER = 'relay-user';
const PASS = 'relay-pass-queue-91f';

/** 通过中继 CONNECT 一个 IPv4 目标；成功返回 socket，失败抛带 rep 的错 */
function connectViaRelay(relayPort, { targetPort, timeoutMs = 40000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port: relayPort });
    let buf = Buffer.alloc(0);
    let phase = 'greet';
    const done = (err) => {
      clearTimeout(timer);
      sock.off('data', onData);
      if (err) { try { sock.destroy(); } catch { /* ignore */ } reject(err); } else resolve(sock);
    };
    const timer = setTimeout(() => done(new Error(`中继 CONNECT 超时（${timeoutMs}ms）`)), timeoutMs);
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      if (phase === 'greet') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return done(new Error(`中继没给 no-auth（${[...buf.subarray(0, 2)]}）`));
        buf = buf.subarray(2);
        phase = 'reply';
        sock.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, (targetPort >> 8) & 0xff, targetPort & 0xff]));
        return;
      }
      if (buf.length < 10) return;
      const rep = buf[1];
      if (rep !== 0x00) {
        const err = new Error(`中继回 REP=${rep}`);
        err.rep = rep;
        return done(err);
      }
      buf = buf.subarray(10);
      if (buf.length) sock.unshift(buf);
      return done(null);
    };
    sock.on('data', onData);
    sock.once('error', (e) => done(e));
    sock.once('connect', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
  });
}

/** 隧道里发一个最小 HTTP/1.0 请求，读回 body */
function httpGetOver(sock, path = '/exit', timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('隧道内 HTTP 读超时')); }, timeoutMs);
    sock.setEncoding('utf8');
    sock.on('data', (c) => {
      buf += c;
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const head = buf.slice(0, i);
      const len = Number((/content-length:\s*(\d+)/i.exec(head) || [])[1] || 0);
      const body = buf.slice(i + 4);
      if (body.length >= len) { clearTimeout(timer); resolve({ head, body }); }
    });
    sock.once('error', (e) => { clearTimeout(timer); reject(e); });
    sock.write(`GET ${path} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n`);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const echo = await startEchoServer({ ip: '203.0.113.77' });
const upstream = await startFakeSocks5({
  requireAuth: [USER, PASS],
  label: 'slow-upstream',
  handshakeConcurrency: 1,   // 串行：复现「上游排队」
  handshakeMs: 900,
});
// 注意：这里**不传** timeoutMs / concurrency —— 判据要钉的是**产品默认值**（30s / 4）。
// 传了就等于自己给自己放宽，红测也就不会红了。
const relay = await startRelay(
  { type: 'socks5', host: '127.0.0.1', port: upstream.port, username: USER, password: PASS },
);

try {
  console.log(`假上游 127.0.0.1:${upstream.port}（握手并发 1 / 每个 900ms）；中继 127.0.0.1:${relay.port}；出口 ${echo.url}`);

  // ① 14 并发（Chrome 启动瞬间的实测条数）
  const t0 = Date.now();
  const N = 14;
  const settled = await Promise.all(Array.from({ length: N }, async () => {
    try {
      const s = await connectViaRelay(relay.port, { targetPort: echo.port });
      const r = await httpGetOver(s);
      s.destroy();
      return { ok: true, body: r.body };
    } catch (e) {
      return { ok: false, error: e.message, rep: e.rep };
    }
  }));
  const elapsed = Date.now() - t0;
  const okCount = settled.filter((x) => x.ok).length;
  const fails = settled.filter((x) => !x.ok);
  console.log(`${N} 并发：通 ${okCount} / 失败 ${fails.length}，耗时 ${elapsed}ms`);
  if (fails.length) console.log(`  失败样本：${JSON.stringify(fails.slice(0, 3))}`);

  check(`① 14 并发全部建立隧道（红：串行上游会把 10s 超时撑爆）`, okCount === N, `${okCount}/${N}，${elapsed}ms`);
  check('① 每条隧道都真的读回了出口内容（不是只握手成功）',
    settled.filter((x) => x.ok).every((x) => x.body.includes('203.0.113.77')),
    `样本 ${String(settled.find((x) => x.ok)?.body || '').slice(0, 60)}`);

  // ② 有界并发：上游同时看到的握手数
  const st = relay.stats || {};
  check('② 上游同时看到的握手数 ≤ 4（默认上限）',
    Number.isFinite(st.peak_active) && st.peak_active <= 4,
    `peak_active=${st.peak_active} 上游实测 maxInFlight=${upstream.stats.maxInFlight}`);
  check('② 排过队（不是一次性全放）', Number.isFinite(st.queued) && st.queued >= N - 4, `queued=${st.queued}`);
  check('② 隧道计数 = 14、失败 = 0', st.tunnels === N && st.failed === 0, JSON.stringify({ tunnels: st.tunnels, failed: st.failed }));
  check('② 全部排完没有残留占用', st.active === 0, `active=${st.active}`);

  // ③ 超时口径
  check('③ 单连接超时是 60s（不是 10s / 30s：CEO 实测冷启动第一发 35.5s 才通）',
    st.timeout_ms === 60000, `timeout_ms=${st.timeout_ms}`);

  // ⑤ 上限可配
  const up2 = await startFakeSocks5({
    requireAuth: [USER, PASS], label: 'slow-upstream-2', handshakeConcurrency: 1, handshakeMs: 400,
  });
  const relay2 = await startRelay(
    { type: 'socks5', host: '127.0.0.1', port: up2.port, username: USER, password: PASS },
    { timeoutMs: 60000, concurrency: 2 },
  );
  const batch = await Promise.all(Array.from({ length: 6 }, async () => {
    try {
      const s = await connectViaRelay(relay2.port, { targetPort: echo.port });
      s.destroy();
      return true;
    } catch { return false; }
  }));
  check('⑤ 上限可配：concurrency=2 → 上游最多同时看到 2 个握手',
    relay2.stats.concurrency === 2 && up2.stats.maxInFlight <= 2 && batch.every(Boolean),
    `concurrency=${relay2.stats.concurrency} 上游 maxInFlight=${up2.stats.maxInFlight} 通=${batch.filter(Boolean).length}/6`);
  await relay2.close();

  // ⑥ 超时进 stats/lastError，且不含凭据
  const up3 = await startFakeSocks5({
    requireAuth: [USER, PASS], label: 'very-slow', handshakeConcurrency: 1, handshakeMs: 3000,
  });
  const relay3 = await startRelay(
    { type: 'socks5', host: '127.0.0.1', port: up3.port, username: USER, password: PASS },
    { timeoutMs: 600, concurrency: 1 },
  );
  let timedOut = null;
  try { await connectViaRelay(relay3.port, { targetPort: echo.port, timeoutMs: 20000 }); } catch (e) { timedOut = e; }
  const st3 = relay3.stats || {};
  const surface = JSON.stringify({ stats: st3, lastError: String(relay3.lastError?.message || relay3.lastError || '') });
  check('⑥ 超时被记进 stats.failed 与 lastError（reason=timeout）',
    Boolean(timedOut) && st3.failed >= 1 && /timeout|超时/i.test(surface),
    `failed=${st3.failed} lastError=${String(relay3.lastError?.message || relay3.lastError || '').slice(0, 80)}`);
  check('⑥ 凭据不出现在 stats / lastError 里',
    !surface.includes(USER) && !surface.includes(PASS), surface.slice(0, 120));
  await relay3.close();
  await up3.close();

  // 生命周期：close 后端口不再 listen、socket 集合清零
  await relay.close();
  await sleep(120);
  const stillOpen = await new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: relay.port });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, 800);
    s.once('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.once('error', () => { clearTimeout(t); resolve(false); });
  });
  check('⑦ close 之后端口不再 LISTEN、socket 集合清零',
    !stillOpen && relay.sockets.size === 0, `listen=${stillOpen} sockets=${relay.sockets.size}`);
} finally {
  await relay.close().catch(() => {});
  await upstream.close().catch(() => {});
  await echo.close().catch(() => {});
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);
