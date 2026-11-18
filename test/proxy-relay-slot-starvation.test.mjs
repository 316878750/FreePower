/**
 * 中继「槽位被自己占死」判据（0.4.7.5 红⑤，CEO 2026-11-18 19:30 定的口径）。
 *
 * 现场：扫描脚本自测 3 个环境全失败，我判成「代理」；CEO 单发探同一台代理 649ms 就通。
 * 真正的中继读数是：
 *   `{"connections":26,"tunnels":7,"failed":11,"queued":7,"queue_timeout":0,
 *     "max_dial_ms":60015,"dial_timeout":8,"dial_attempts":51,"dial_retries":25}`
 * **一条连接在拨号上耗掉整整 60 秒**，同一时刻单发只要 649ms —— 不是供应商不给连，
 * 是我们自己的槽位被重试占死了：
 *   并发 8 × （单次 21s × 最多 3 次）⇒ 8 个槽全卡在重试里 60s，Chrome 后面 18 条全排队。
 *
 * 修法（本判据钉的就是这三条）：
 *   ① 单次拨号 **21s**（2026-11-18 21:40 更正：8s 会砍掉 TCP 第 4 次重传）、最多 **2 次**、
 *      单连接拨号总预算 **45s**（`dial_attempt_ms=21000`）；
 *   ② **槽位只覆盖一次拨号**：失败立刻还槽，绝不带着槽位重试；
 *   ③ 槽位不再覆盖握手（握手慢是上游的事，别让它占公共槽位）。
 *
 * 判据（先红后绿，全部用假上游 / TEST-NET-1 黑洞，**不碰用户真代理**）：
 *   ① 26 条并发打黑洞上游：红 = `max_dial_ms≈60015`、`dial_attempts=51`；
 *      绿 = `max_dial_ms < 21000`、`dial_timeout ≥ 1`、结束后 `active=0`、26 条都有明确失败；
 *   ② 并发 1 时一条坏连接在重试，好连接必须能立刻拿到槽位（红 ≈2.8s，绿 < 1.8s）；
 *   ③ 握手慢不占槽：上游握手 1.2s/条、并发 1，3 条连接都该通且 `queue_timeout=0`。
 *
 * 跑法：npm run test:proxy-relay-slot
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
const PASS = 'relay-pass-slot-9f2';

/** TEST-NET-1：SYN 被丢（Windows 上 21s 才报 ETIMEDOUT，这里由拨号预算截断） */
const BLACKHOLE = { host: '192.0.2.1', port: 47283 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 通过中继 CONNECT 一个 IPv4 目标；成功返回 socket，失败抛带 rep 的错 */
function connectViaRelay(relayPort, { targetPort, timeoutMs = 70000 } = {}) {
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

const echo = await startEchoServer({ ip: '203.0.113.91' });

try {
  // ⓪ 产品默认值：单次拨号 21s（TCP SYN 重传 1s/3s/7s/15s 要跑完）、最多 2 次、总预算 45s
  //    只读 stats、不真的拨号，所以不花 21s。
  {
    const relay = await startRelay({ type: 'socks5', ...BLACKHOLE, username: USER, password: PASS });
    const st = relay.stats;
    check('⓪ 产品默认：单次拨号 21s、最多 2 次、总预算 45s、并发 8、排队 20s',
      st.dial_attempt_ms === 21000 && st.dial_attempts_max === 2 && st.dial_budget_ms === 45000
        && st.concurrency === 8 && st.queue_timeout_ms === 20000,
      `attempt=${st.dial_attempt_ms} max=${st.dial_attempts_max} budget=${st.dial_budget_ms} concurrency=${st.concurrency} queue=${st.queue_timeout_ms}`);
    await relay.close();
  }

  // ① 26 条并发打黑洞上游：一条连接不许在拨号上吃掉 60 秒
  //    判据把拨号窗口压小（1.2s × 2 / 总 3s），否则每条都要等满 21s，26 条要跑两分钟。
  {
    const relay = await startRelay(
      { type: 'socks5', ...BLACKHOLE, username: USER, password: PASS },
      { concurrency: 8, queueTimeoutMs: 20000, dialAttemptMs: 1200, dialBudgetMs: 3000, dialAttempts: 2 },
    );
    const N = 26;
    const t0 = Date.now();
    const settled = await Promise.all(Array.from({ length: N }, async () => {
      try {
        const s = await connectViaRelay(relay.port, { targetPort: echo.port, timeoutMs: 70000 });
        s.destroy();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }));
    const elapsed = Date.now() - t0;
    const st = relay.stats;
    console.log(`① ${N} 并发（并发上限 8 / 排队 20s / 默认拨号预算）：通 ${settled.filter((x) => x.ok).length} / 失败 ${settled.filter((x) => !x.ok).length}，耗时 ${elapsed}ms`);
    console.log(`① stats=${JSON.stringify({
      connections: st.connections, tunnels: st.tunnels, failed: st.failed,
      queued: st.queued, peak_queue: st.peak_queue, queue_timeout: st.queue_timeout,
      max_queue_wait_ms: st.max_queue_wait_ms, dial_timeout: st.dial_timeout,
      max_dial_ms: st.max_dial_ms, dial_attempts: st.dial_attempts, dial_retries: st.dial_retries,
      dial_attempt_ms: st.dial_attempt_ms, dial_budget_ms: st.dial_budget_ms,
      dial_attempts_max: st.dial_attempts_max, active: st.active,
    })}`);

    check('① 判据窗口：单次拨号 1.2s、最多 2 次、单连接总预算 3s',
      st.dial_attempt_ms === 1200 && st.dial_attempts_max === 2 && st.dial_budget_ms === 3000,
      `dial_attempt_ms=${st.dial_attempt_ms} max=${st.dial_attempts_max} budget=${st.dial_budget_ms}`);
    check('① 单条连接的拨号耗时不再到 60s（max_dial_ms < 21000）',
      st.max_dial_ms < 21000,
      `max_dial_ms=${st.max_dial_ms}（红：≈60015，一条连接在拨号上耗掉整个 60s 预算）`);
    check('① 拨号超时被单独计数（dial_timeout ≥ 1）', st.dial_timeout >= 1, `dial_timeout=${st.dial_timeout}`);
    check('① 每次尝试都只花一次拨号预算（dial_attempts ≤ 26 × 2）',
      st.dial_attempts <= N * 2, `dial_attempts=${st.dial_attempts}（红：51）`);
    check('① 结束后槽位与队列都归零（失败连接不占槽）',
      st.active === 0 && st.queue_depth === 0, `active=${st.active} queue_depth=${st.queue_depth}`);
    check('① 26 条连接都有明确结果（没有挂死的）',
      st.connections === N && st.failed + st.tunnels === N, `connections=${st.connections} failed=${st.failed} tunnels=${st.tunnels}`);
    check('① 读数里不含凭据', !JSON.stringify(st).includes(PASS) && !String(relay.lastError?.message || '').includes(PASS),
      String(relay.lastError?.message || '').slice(0, 60));
    await relay.close();
  }

  // ② 失败不许占着槽位重试：并发 1、排队 2s、单次拨号 1.2s、最多 2 次
  //    红（占着槽位重试）：坏连接 A 一直占到 2.8s（2×1.2s + 400ms 间隔）→ B 排满 2s → queue_timeout ≥ 1
  //    绿（失败立刻还槽）：A 第一次拨完（1.2s）就还槽 → B 在 1.2s 内拿到槽位 → queue_timeout = 0
  {
    const relay = await startRelay(
      { type: 'socks5', ...BLACKHOLE, username: USER, password: PASS },
      { concurrency: 1, queueTimeoutMs: 2000, dialAttemptMs: 1200, dialBudgetMs: 3000, dialAttempts: 2 },
    );
    const both = await Promise.all([1, 2].map(async () => {
      try {
        const s = await connectViaRelay(relay.port, { targetPort: echo.port, timeoutMs: 20000 });
        s.destroy();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }));
    const st = relay.stats;
    console.log(`② 2 条并发（并发 1 / 排队 2s / 拨号 1.2s×2）：通 ${both.filter((x) => x.ok).length} / 失败 ${both.filter((x) => !x.ok).length}；`
      + `queue_timeout=${st.queue_timeout} dial_timeout=${st.dial_timeout} max_queue_wait_ms=${st.max_queue_wait_ms} active=${st.active}`);
    check('② 失败立刻还槽：第二条连接没被第一条的重试排到超时（queue_timeout = 0）',
      st.queue_timeout === 0, `queue_timeout=${st.queue_timeout}（红：≥1，槽位被 2.8s 的重试占住）`);
    check('② 两条都如实失败、结束后槽位归零',
      both.every((x) => !x.ok) && st.active === 0 && st.tunnels === 0, `failed=${st.failed} active=${st.active} tunnels=${st.tunnels}`);
    await relay.close();
  }

  // ③ 槽位只覆盖拨号：握手慢不占槽（否则一个慢上游会把公共槽位全占死）
  {
    const up = await startFakeSocks5({
      requireAuth: [USER, PASS], label: 'slow-handshake',
      handshakeConcurrency: 1, handshakeMs: 1200,
    });
    const relay = await startRelay(
      { type: 'socks5', host: '127.0.0.1', port: up.port, username: USER, password: PASS },
      { concurrency: 1, queueTimeoutMs: 5000 },
    );
    const settled = await Promise.all(Array.from({ length: 3 }, async () => {
      try {
        const s = await connectViaRelay(relay.port, { targetPort: echo.port, timeoutMs: 20000 });
        s.destroy();
        return true;
      } catch { return false; }
    }));
    const st = relay.stats;
    check('③ 上游握手慢（1.2s/条、串行）不再吃掉我们的槽位：3/3 通、无排队超时',
      settled.every(Boolean) && st.queue_timeout === 0 && st.tunnels === 3,
      `通=${settled.filter(Boolean).length}/3 queue_timeout=${st.queue_timeout} tunnels=${st.tunnels} active=${st.active}`);
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
