/**
 * 中继「拨号超时砍掉 TCP 重传」判据（2026-11-18 21:40，CEO 在干净代理 10057 上实测后定的口径）。
 *
 * 实测（10057，上游端口直接量）：
 *   8s 超时：并发 1 → 通 4/8（4 条 8s 超时）；并发 2 → 8/8；并发 4 → 8/8
 *   21s 超时：并发 1 → 8/8，成功耗时 [124, 170, 204, 209, 1146, 3235, 4264, **15239**]
 *             并发 8 → 8/8，成功耗时 [120, 121, 165, 171, 206, 213, 215, 1193]
 *
 * 那些 3.2s / 4.3s / 15.2s 就是 TCP 自己的 SYN 重传（1s / 3s / 7s / 15s）。
 * **拨号超时 8s 正好把 15s 那次重传砍掉** —— 不是并发上限，也不是我们把代理打坏。
 *
 * 判据怎么造这个时序：本机 loopback 不会真丢 SYN，所以在 `net.connect` 上做一个测试替身 ——
 * 目标是 `syn-drop.test` 时，socket 延迟 `E2E_SYN_MS`（默认 16000，对应第 4 次重传）才真正 connect。
 * 这不是 mock 掉中继逻辑：拨号、槽位、超时、重试、握手、隧道全走真代码，只是让「TCP 建连」慢下来。
 *
 * ① 产品默认（单次 21s）：16s 才连上 → 仍然建成隧道，`max_dial_ms ≥ 15000`、`dial_attempts=1`；
 * ② 8s 版本（显式 dialAttemptMs:8000）：两次尝试都砍在 15s 重传之前 → 客户端拿到 REP≠0，
 *    `tunnels=0`、`dial_attempts=2`、`dial_timeout=1`（按连接计）—— **这条就是红**，
 *    证明 8s 会把能救回来的连接判死。
 *
 * 跑法：`npm run test:e2e`（与真内核全链路一起跑）。
 */
import net from 'node:net';
import { startRelay } from '../src/proxy/relay.js';
import { startFakeSocks5 } from './fake-socks5.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const USER = 'syn-user-3d';
const PASS = 'syn-pass-77a';
const SYN_HOST = 'syn-drop.test';
const SYN_MS = Number(process.env.E2E_SYN_MS || 16000);

/* ------------------------------ SYN 丢失的测试替身 ------------------------------ */

const realConnect = net.connect.bind(net);
net.connect = function patchedConnect(...args) {
  const opts = (args[0] && typeof args[0] === 'object') ? args[0] : { host: args[0], port: args[1] };
  if (opts.host === SYN_HOST) {
    // 返回一个还没连的 socket：`setTimeout` 照样计时（真跑过探针），到点才真正 connect。
    const s = new net.Socket();
    setTimeout(() => { if (!s.destroyed) s.connect({ host: '127.0.0.1', port: opts.port }); }, SYN_MS);
    return s;
  }
  return realConnect(...args);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 通过中继 CONNECT 一个 IPv4 目标；成功返回 socket，失败抛带 rep 的错 */
function connectViaRelay(relayPort, { targetPort, timeoutMs = 60000 } = {}) {
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

/* ------------------------------ 本地目标 ------------------------------ */

const echo = net.createServer((s) => { s.on('error', () => {}); s.pipe(s); });
await new Promise((r) => echo.listen(0, '127.0.0.1', r));
const echoPort = echo.address().port;
const up = await startFakeSocks5({ requireAuth: [USER, PASS], dialHost: () => '127.0.0.1', label: 'syn-upstream' });

console.log(`SYN 延迟 ${SYN_MS}ms（模拟第 4 次 TCP 重传）；假上游 127.0.0.1:${up.port}`);

try {
  /* ==========================================================================
   * ① 产品默认 21s：16s 才连上也要建成隧道
   * ======================================================================== */
  {
    const relay = await startRelay({ type: 'socks5', host: SYN_HOST, port: up.port, username: USER, password: PASS });
    const t0 = Date.now();
    let ok = false;
    let err = null;
    try {
      const s = await connectViaRelay(relay.port, { targetPort: echoPort });
      s.destroy();
      ok = true;
    } catch (e) { err = e; }
    const elapsed = Date.now() - t0;
    const st = relay.stats;
    console.log(`① 默认 21s：${ok ? '建成隧道' : `失败（${err?.message}）`}，耗时 ${elapsed}ms；stats=${JSON.stringify({
      tunnels: st.tunnels, failed: st.failed, max_dial_ms: st.max_dial_ms,
      dial_attempts: st.dial_attempts, dial_retries: st.dial_retries, dial_timeout: st.dial_timeout,
      dial_attempt_ms: st.dial_attempt_ms, dial_budget_ms: st.dial_budget_ms,
    })}`);

    check('① 16s 才连上（TCP 第 4 次重传）仍然建成隧道 —— 21s 窗口够',
      ok && st.tunnels === 1, ok ? `tunnels=${st.tunnels}` : `失败：${err?.message}`);
    check('① 确实等满了 TCP 重传（耗时 ≥ 15000ms）', elapsed >= 15000, `elapsed=${elapsed}ms`);
    check('① max_dial_ms ≥ 15000（8s 版本在这里必然是 timeout）', st.max_dial_ms >= 15000, `max_dial_ms=${st.max_dial_ms}`);
    check('① 一次尝试就成功，没有靠重试掩盖（dial_attempts=1 / retries=0 / dial_timeout=0）',
      st.dial_attempts === 1 && st.dial_retries === 0 && st.dial_timeout === 0,
      `attempts=${st.dial_attempts} retries=${st.dial_retries} timeout=${st.dial_timeout}`);
    check('① 产品默认值：单次 21s / 总预算 45s / 最多 2 次',
      st.dial_attempt_ms === 21000 && st.dial_budget_ms === 45000 && st.dial_attempts_max === 2,
      `attempt=${st.dial_attempt_ms} budget=${st.dial_budget_ms} max=${st.dial_attempts_max}`);
    await relay.close();
  }

  /* ==========================================================================
   * ② 8s 版本（红）：两次 8s 都砍在 15s 重传之前 → 客户端拿到 REP≠0、0 隧道
   * ======================================================================== */
  {
    const relay = await startRelay(
      { type: 'socks5', host: SYN_HOST, port: up.port, username: USER, password: PASS },
      { dialAttemptMs: 8000, dialBudgetMs: 20000, dialAttempts: 2 },
    );
    const t0 = Date.now();
    let ok = false;
    let rep = null;
    try {
      const s = await connectViaRelay(relay.port, { targetPort: echoPort });
      s.destroy();
      ok = true;
    } catch (e) { rep = e.rep ?? null; }
    const elapsed = Date.now() - t0;
    const st = relay.stats;
    console.log(`② 8s 版本：${ok ? '意外成功' : `失败（REP=${rep}）`}，耗时 ${elapsed}ms；stats=${JSON.stringify({
      tunnels: st.tunnels, failed: st.failed, dial_timeout: st.dial_timeout,
      dial_attempts: st.dial_attempts, dial_retries: st.dial_retries, max_dial_ms: st.max_dial_ms,
    })}`);

    check('② 8s 版本把能救回来的连接判死（客户端拿到 REP≠0，tunnels=0）',
      !ok && rep !== null && st.tunnels === 0, ok ? '意外成功' : `REP=${rep} tunnels=${st.tunnels}`);
    check('② 这条连接两次尝试都超时（dial_timeout=1 按连接计 / attempts=2 / retries=1）',
      st.dial_timeout === 1 && st.dial_attempts === 2 && st.dial_retries === 1,
      `timeout=${st.dial_timeout} attempts=${st.dial_attempts} retries=${st.dial_retries}`);
    check('② 每次拨号都没超过 8s 窗口（max_dial_ms ≤ 8200）',
      st.max_dial_ms <= 8200, `max_dial_ms=${st.max_dial_ms}`);
    await relay.close();
  }
} finally {
  await up.close().catch(() => {});
  await new Promise((r) => echo.close(r));
  await sleep(50);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);
