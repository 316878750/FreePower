/**
 * 中继的**排队预算 / 拨号预算分离**判据（0.4.7.5 红④，CEO 2026-11-18 18:40 定的口径）。
 *
 * 为什么加这条：真站验收那趟（单环境 10055）29 条连接只建成 3 条隧道，
 * `queued=25 / peak_queue=12 / lastError=queue_timeout`。机制是：
 *   并发 4 × 单次拨号 21s × 3 次重试 ⇒ 一个槽位最坏被占 63s，吞吐 ≈ 每 16 秒 1 条；
 *   排在队里的连接**还没轮到拨号**就先超时了（`queue_timeout` 不是拨号失败）。
 * 所以两段预算必须分开：
 *   - 排队：独立上限（默认 45s），超时计 `stats.queue_timeout`；
 *   - 拨号+握手：60s，**从真正开始拨号那一刻起算**，超时计 `stats.dial_timeout`；
 *   - `stats.max_queue_wait_ms` 让下次一眼看出是排队还是拨号。
 *
 * 判据（先红后绿，全部用假上游 / TEST-NET 黑洞，**不碰用户真代理**）：
 *   ① 默认值：concurrency=8、queue_timeout_ms=20000、timeout_ms=60000、
 *      单次拨号 8000 / 单连接总预算 20000 / 最多 2 次（19:45 由 45s、21s×3 收窄）；
 *   ② 排队超时独立生效并单独计数：慢拨号（3s/次）+ 并发 2 + 排队 700ms → 4 条排队超时，
 *      拿到槽位的 2 条是拨号超时（两类计数不混）；
 *   ③ 排队不吃拨号预算：并发 1 + 慢拨号 1.2s → 3 条串行，每条都拿到完整 1.2s 预算；
 *   ④ 拨号超时单独计数：黑洞上游（192.0.2.1，SYN 被丢）+ timeoutMs=600 → dial_timeout=1、
 *      queue_timeout=0，lastError.reason=timeout；
 *   ⑤ 两个计数恒为数字，max_queue_wait_ms 有真实读数。
 *
 * 跑法：npm run test:proxy-relay-queue-budget
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
const PASS = 'relay-pass-budget-4c1';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const echo = await startEchoServer({ ip: '203.0.113.88' });

try {
  // ① 默认值（不传任何参数：判据钉的是产品默认）
  {
    const up = await startFakeSocks5({ requireAuth: [USER, PASS], label: 'defaults' });
    const relay = await startRelay({ type: 'socks5', host: '127.0.0.1', port: up.port, username: USER, password: PASS });
    const st = relay.stats;
    check('① 默认并发 = 8（旧版 4 会把 29 条连接排到 7 分钟）', st.concurrency === 8, `concurrency=${st.concurrency}`);
    check('① 默认排队上限 = 20000ms（独立于拨号预算；19:45 由 45s 收到 20s）', st.queue_timeout_ms === 20000, `queue_timeout_ms=${st.queue_timeout_ms}`);
    check('① 默认拨号+握手预算 = 60000ms', st.timeout_ms === 60000, `timeout_ms=${st.timeout_ms}`);
    check('① 默认单次拨号 21s / 单连接总预算 45s / 最多 2 次（TCP 重传 1s/3s/7s/15s 要跑完）',
      st.dial_attempt_ms === 21000 && st.dial_budget_ms === 45000 && st.dial_attempts_max === 2,
      `dial_attempt_ms=${st.dial_attempt_ms} budget=${st.dial_budget_ms} max=${st.dial_attempts_max}`);
    check('① 两个超时计数初始为 0、max_queue_wait_ms 有初值',
      st.queue_timeout === 0 && st.dial_timeout === 0 && st.max_queue_wait_ms === 0,
      JSON.stringify({ queue_timeout: st.queue_timeout, dial_timeout: st.dial_timeout, max_queue_wait_ms: st.max_queue_wait_ms }));
    await relay.close();
    await up.close();
  }

  // ② 排队超时独立生效并单独计数（用**慢拨号**造队，不是慢握手）：
  //    0.4.7.5 19:45 起槽位只覆盖一次拨号，握手不再占槽 —— 慢握手造不出队列了。
  {
    const relay = await startRelay(
      { type: 'socks5', host: '192.0.2.1', port: 47283, username: USER, password: PASS },
      { timeoutMs: 60000, queueTimeoutMs: 700, concurrency: 2, dialAttemptMs: 3000, dialBudgetMs: 3000, dialAttempts: 1 },
    );
    const N = 6;
    const settled = await Promise.all(Array.from({ length: N }, async () => {
      try {
        const s = await connectViaRelay(relay.port, { targetPort: echo.port, timeoutMs: 30000 });
        s.destroy();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message, rep: e.rep };
      }
    }));
    const st = relay.stats;
    const ok = settled.filter((x) => x.ok).length;
    const failed = settled.filter((x) => !x.ok).length;
    console.log(`② 6 并发（并发上限 2 / 排队 700ms / 拨号 3000ms×1）：通 ${ok} / 失败 ${failed}；stats=${JSON.stringify({
      queued: st.queued, peak_queue: st.peak_queue, queue_timeout: st.queue_timeout, dial_timeout: st.dial_timeout, max_queue_wait_ms: st.max_queue_wait_ms,
    })}`);
    check('② 排队超时的连接被单独计数（queue_timeout ≥ 4）', st.queue_timeout >= 4, `queue_timeout=${st.queue_timeout}`);
    check('② 拿到槽位的 2 条走的是拨号超时（dial_timeout = 2），两类计数不混',
      st.dial_timeout === 2, `dial_timeout=${st.dial_timeout}`);
    check('② max_queue_wait_ms 记录到真实排队时长（≥ 650ms）', st.max_queue_wait_ms >= 650, `max_queue_wait_ms=${st.max_queue_wait_ms}`);
    check('② 排队超时单独留痕（lastQueueError 里能看到），不是混在拨号里',
      /排队超时/.test(String(relay.lastQueueError?.message || '')), String(relay.lastQueueError?.message || '').slice(0, 60));
    await relay.close();
  }

  // ③ 排队不吃拨号预算：排在队里的连接，轮到自己时仍拿到**完整**的一次拨号预算
  //    （0.4.7.5 19:45 起槽位只覆盖一次拨号，所以这里用「慢拨号」造队；
  //     若排队把预算吃掉，后两条的拨号会被截断 → dial_ms_total 明显小于 3 × 1.1s）
  {
    const relay = await startRelay(
      { type: 'socks5', host: '192.0.2.1', port: 47283, username: USER, password: PASS },
      { timeoutMs: 60000, queueTimeoutMs: 20000, concurrency: 1, dialAttemptMs: 1200, dialBudgetMs: 1200, dialAttempts: 1 },
    );
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 3 }, async () => {
      try { const s = await connectViaRelay(relay.port, { targetPort: echo.port, timeoutMs: 30000 }); s.destroy(); } catch { /* 预期失败 */ }
    }));
    const elapsed = Date.now() - t0;
    const st = relay.stats;
    check('③ 排完队的那条仍拿到完整拨号预算（dial_ms_total ≥ 3 × 1100ms）',
      st.dial_ms_total >= 3 * 1100 && st.max_dial_ms >= 1100,
      `dial_ms_total=${st.dial_ms_total} max_dial_ms=${st.max_dial_ms} 总耗时=${elapsed}ms`);
    check('③ 这一轮只有拨号超时、没有排队超时（排队 3.6s 也还在 20s 上限内）',
      st.queue_timeout === 0 && st.dial_timeout === 3,
      `queue_timeout=${st.queue_timeout} dial_timeout=${st.dial_timeout} max_queue_wait_ms=${st.max_queue_wait_ms}`);
    await relay.close();
  }

  // ④ 拨号超时单独计数：TEST-NET-1 黑洞（SYN 被丢，Windows 上 21s 才报 ETIMEDOUT，这里 600ms 截断）
  {
    const relay = await startRelay(
      { type: 'socks5', host: '192.0.2.1', port: 47283, username: USER, password: PASS },
      { timeoutMs: 600, dialAttempts: 1, concurrency: 1, queueTimeoutMs: 5000 },
    );
    let failed = false;
    try { await connectViaRelay(relay.port, { targetPort: echo.port, timeoutMs: 15000 }); } catch { failed = true; }
    const st = relay.stats;
    check('④ 拨号超时被单独计数（dial_timeout = 1）', failed && st.dial_timeout === 1, `failed=${failed} dial_timeout=${st.dial_timeout}`);
    check('④ 拨号超时不算排队超时（queue_timeout = 0）', st.queue_timeout === 0, `queue_timeout=${st.queue_timeout}`);
    check('④ lastError 如实标 timeout、且不含凭据',
      relay.lastError?.reason === 'timeout' && !JSON.stringify(st).includes(PASS) && !String(relay.lastError?.message || '').includes(PASS),
      `reason=${relay.lastError?.reason} msg=${String(relay.lastError?.message || '').slice(0, 50)}`);
    check('④ max_dial_ms 记录到这次拨号耗时', st.max_dial_ms >= 500, `max_dial_ms=${st.max_dial_ms}`);
    await relay.close();
  }

  // ⑤ 计数恒为数字（未发生也是 0，不能是 undefined）
  {
    const up = await startFakeSocks5({ requireAuth: [USER, PASS], label: 'idle' });
    const relay = await startRelay({ type: 'socks5', host: '127.0.0.1', port: up.port, username: USER, password: PASS });
    const st = relay.stats;
    check('⑤ 空闲中继的 queue_timeout / dial_timeout / max_queue_wait_ms 都是数字',
      Number.isFinite(st.queue_timeout) && Number.isFinite(st.dial_timeout) && Number.isFinite(st.max_queue_wait_ms),
      JSON.stringify({ q: st.queue_timeout, d: st.dial_timeout, m: st.max_queue_wait_ms }));
    await relay.close();
    await up.close();
  }
} finally {
  await echo.close().catch(() => {});
  await sleep(50);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);
