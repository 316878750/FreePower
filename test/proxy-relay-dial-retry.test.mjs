/**
 * 中继的**上游拨号重试**判据（0.4.7.5 追加红③）：不启内核，只压 relay.js。
 *
 * 为什么加这条：供应商限流时不是「慢」，是**直接丢 SYN**。2026-11-18 实测（真上游）：
 *   - 串行 5 次 checkProxy：5/5 通（16452 / 626 / 7518 / 1104 / 668 ms）
 *   - 4 并发 14 条打中继：只成 3 条，11 条失败，`lastError = 连不上上游 …：connect ETIMEDOUT`，
 *     每条要等约 21 秒（Windows 上 SYN 被丢的 ETIMEDOUT 就是这个数）
 * 一次丢包报废一条浏览器连接 → 页面打不开。重拨一次就是重新掷骰子。
 *
 * 判据：
 *   ① 上游端口没有监听（ECONNREFUSED）→ 必须**试 3 次**（`dial_attempts=3`、`dial_retries=2`），
 *      客户端拿到非 0 REP（不能假成功）；改之前只试 1 次。
 *   ② 上游在重试窗口内起来 → **隧道最终成功**（证明重拨真的救了连接，不只是计数）。
 *   ③ `dialAttempts: 1` → 只试 1 次（可配、能关）。
 *   ④ 握手阶段失败（密码错）**不重试** —— 配置问题重试没有意义，只会把错误拖成超时。
 *
 * 跑法：npm run test:proxy-relay-dial
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 找一个当前空闲的端口（listen 0 → 读端口 → 立刻关），给「稍后再起来」用 */
async function pickFreePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

/** 通过中继 CONNECT 一个 IPv4 目标；resolve {ok, rep, ms} */
function connectViaRelay(relayPort, { targetPort, timeoutMs = 90000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host: '127.0.0.1', port: relayPort });
    let buf = Buffer.alloc(0);
    let phase = 'greet';
    let settled = false;
    const done = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* ignore */ }
      resolve({ ...out, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => done({ ok: false, rep: null, note: '客户端超时' }), timeoutMs);
    sock.on('error', (e) => done({ ok: false, rep: null, note: e.code || e.message }));
    sock.on('connect', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (phase === 'greet') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return done({ ok: false, rep: null, note: `中继没给 no-auth（${[...buf.subarray(0, 2)]}）` });
        buf = buf.subarray(2);
        phase = 'reply';
        sock.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, (targetPort >> 8) & 0xff, targetPort & 0xff]));
        return;
      }
      if (buf.length < 10) return;
      done({ ok: buf[1] === 0x00, rep: buf[1] });
    });
  });
}

/* ------------------------------------------------------------------ */

// ① 上游没有监听：必须试 3 次、客户端拿到失败（不假成功）
{
  const deadPort = await pickFreePort();
  const relay = await startRelay({ type: 'socks5', host: '127.0.0.1', port: deadPort, username: 'u', password: 'p' }, { timeoutMs: 20000 });
  const r = await connectViaRelay(relay.port, { targetPort: 443 });
  check('① 上游连不上时客户端拿到非 0 REP（不假成功）', r.ok === false && r.rep !== 0, `rep=${r.rep} ${r.ms}ms ${r.note || ''}`);
  check('① 拨号试了 3 次（dial_attempts=3）', relay.stats.dial_attempts === 3, `dial_attempts=${relay.stats.dial_attempts}`);
  check('① 其中重试 2 次（dial_retries=2）', relay.stats.dial_retries === 2, `dial_retries=${relay.stats.dial_retries}`);
  check('① 失败进 stats.failed 与 lastError', relay.stats.failed >= 1 && Boolean(relay.lastError), `failed=${relay.stats.failed} lastError=${relay.lastError?.message || 'none'}`);
  await relay.close();
}

// ② 上游在重试窗口内起来：重拨必须救回这条连接
{
  const echo = await startEchoServer();
  const laterPort = await pickFreePort();
  const relay = await startRelay({ type: 'socks5', host: '127.0.0.1', port: laterPort, username: 'retry-user', password: 'retry-pass-77c' }, { timeoutMs: 20000 });
  // 第 1 次拨号必然 ECONNREFUSED；重试间隔 400ms，第 3 次在 ~800ms 左右 → 700ms 起来
  let fake = null;
  const timer = setTimeout(async () => {
    fake = await startFakeSocks5({ requireAuth: ['retry-user', 'retry-pass-77c'], port: laterPort });
  }, 700);
  const r = await connectViaRelay(relay.port, { targetPort: echo.port });
  clearTimeout(timer);
  check('② 上游中途起来时重拨救回连接（隧道成功）', r.ok === true, `rep=${r.rep} ${r.ms}ms ${r.note || ''}`);
  check('② 至少发生过一次重拨', relay.stats.dial_retries >= 1, `dial_retries=${relay.stats.dial_retries} attempts=${relay.stats.dial_attempts}`);
  check('② 成功后 tunnels 计数为 1', relay.stats.tunnels === 1, `tunnels=${relay.stats.tunnels}`);
  await relay.close();
  if (fake) await fake.close();
  await echo.close();
}

// ③ dialAttempts 可配（1 = 不重试）
{
  const deadPort = await pickFreePort();
  const relay = await startRelay({ type: 'socks5', host: '127.0.0.1', port: deadPort, username: 'u', password: 'p' }, { timeoutMs: 20000, dialAttempts: 1 });
  const r = await connectViaRelay(relay.port, { targetPort: 443 });
  check('③ dialAttempts:1 → 只试 1 次', relay.stats.dial_attempts === 1 && relay.stats.dial_retries === 0, `attempts=${relay.stats.dial_attempts} retries=${relay.stats.dial_retries}`);
  check('③ 仍然如实失败', r.ok === false && r.rep !== 0, `rep=${r.rep}`);
  await relay.close();
}

// ④ 握手阶段失败（密码错）不重试
{
  const echo = await startEchoServer();
  const fake = await startFakeSocks5({ requireAuth: ['right-user', 'right-pass'] });
  const relay = await startRelay({ type: 'socks5', host: '127.0.0.1', port: fake.port, username: 'wrong-user', password: 'wrong-pass' }, { timeoutMs: 20000 });
  const r = await connectViaRelay(relay.port, { targetPort: echo.port });
  check('④ 密码错：客户端拿到失败', r.ok === false && r.rep !== 0, `rep=${r.rep} ${r.note || ''}`);
  check('④ 密码错**不重试**（dial_retries=0、dial_attempts=1）', relay.stats.dial_retries === 0 && relay.stats.dial_attempts === 1, `attempts=${relay.stats.dial_attempts} retries=${relay.stats.dial_retries}`);
  check('④ 错误里不含凭据', !JSON.stringify(relay.stats).includes('wrong-pass') && !String(relay.lastError?.message || '').includes('wrong-pass'), `lastError=${relay.lastError?.message || 'none'}`);
  await relay.close();
  await fake.close();
  await echo.close();
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass} PASS / ${results.length - pass} FAIL`);
await sleep(50);
process.exit(pass === results.length ? 0 : 1);
