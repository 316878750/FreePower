/**
 * 起始页出口探测的**链路与重试**判据（0.4.7.5 红②③，A 层，不启内核）。
 *
 * 用户 2026-11-18 的现象：4 个环境的中继都起来了、启动日志里预检也绿，但 12 秒后全变成
 * 「出口探测失败 → 起始页写「代理未连通」」，而 Chrome 的 netlog 里是 81 次
 * `ERR_SOCKS_CONNECTION_FAILED(-120)`。两件事要分开验：
 *
 *   ① **链路**：起始页的探测必须走浏览器那条链路（`socks5://127.0.0.1:<relay>`），
 *      而不是直连上游。直连上游只证明「上游活着」，证明不了「浏览器这条路通」——
 *      这正是那次假绿灯的成因。这里用假上游记录「探测请求是不是从上游隧道过来的」。
 *   ② **重试**：CEO 实测冷启动第一发 35,572ms 才通（主源 25s 超时、靠备用源救回），
 *      第二发 691ms。单发失败就写「代理未连通」是错的 —— 3 次退避（0 / 1.5s / 4s）。
 *
 * 跑法：npm run test:start-probe-relay
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/* 数据目录 + 出口接口都要在 import 之前指好（config.js 在模块加载时读环境变量） */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-startprobe-'));
process.env.FREEPOWER_DATA = TMP;

const { startEchoServer } = await import('./fake-proxy.mjs');
const { startFakeSocks5 } = await import('./fake-socks5.mjs');
const { startRelay } = await import('../src/proxy/relay.js');
const { setRelayPort, clearRelayPort, resetRelayPorts } = await import('../src/proxy/relay-registry.js');

const echo = await startEchoServer({ ip: '203.0.113.88', country: 'Japan', countryCode: 'JP', city: 'Tokyo' });
process.env.FREEPOWER_EGRESS_PROBE = echo.url;

const { probeStartEgress, resetStartProbeCache } = await import('../src/start/probe.js');

const USER = 'probe-user';
const PASS = 'probe-pass-4b7e';
/* 备用源（https://ipinfo.io/json）在判据里必须快速失败，别真连公网：映射到本机 443（拒绝） */
const dialHost = (h) => (h === 'ipinfo.io' ? '127.0.0.1' : h);

const profileOf = (port) => ({
  profile_id: 'p1',
  name: '判据环境',
  user_proxy_config: {
    proxy_type: 'socks5', host: '127.0.0.1', port, username: USER, password: PASS,
  },
});

const up = await startFakeSocks5({ requireAuth: [USER, PASS], dialHost, label: 'probe-upstream' });
const relay = await startRelay({ type: 'socks5', host: '127.0.0.1', port: up.port, username: USER, password: PASS });

try {
  console.log(`假上游 127.0.0.1:${up.port}；中继 127.0.0.1:${relay.port}；出口接口 ${echo.url}`);

  // ① 有中继 → 探测走中继（与浏览器同一条链路）
  resetRelayPorts();
  resetStartProbeCache();
  setRelayPort('p1', relay.port);
  const viaRelay = await probeStartEgress(profileOf(up.port), { force: true });
  check('① 探测成功，且读数是假上游给的出口 IP', viaRelay.ok && viaRelay.ip === '203.0.113.88',
    `${viaRelay.ok} ip=${viaRelay.ip} err=${viaRelay.error || '-'}`);
  check('① 走的是本地中继（via_relay=true、relay_port 对得上）',
    viaRelay.via_relay === true && viaRelay.relay_port === relay.port,
    `via_relay=${viaRelay.via_relay} relay_port=${viaRelay.relay_port}`);
  check('① 上游确实收到了隧道请求（不是自己跟自己对上）',
    up.records.some((r) => r.status === 'tunnel' && r.host === '127.0.0.1' && r.port === echo.port),
    JSON.stringify(up.records.map((r) => `${r.host}:${r.port}:${r.status}`).slice(-3)));
  check('① 上游收到的凭据 = 环境里的账号密码（中继替浏览器认证）',
    up.authSeen.some((a) => a.username === USER && a.password === PASS),
    JSON.stringify(up.authSeen.slice(-1)));
  check('① 第一发就通时 attempts = 1（不做无意义的重试）', viaRelay.attempts === 1, `attempts=${viaRelay.attempts}`);

  // ② 没有中继（环境没跑）→ 回落直连上游，语义与老版本一致
  clearRelayPort('p1');
  resetStartProbeCache();
  const direct = await probeStartEgress(profileOf(up.port), { force: true });
  check('② 没有中继时回落直连上游（via_relay=false，仍然通）',
    direct.ok === true && direct.via_relay === false, `ok=${direct.ok} via_relay=${direct.via_relay}`);

  // ③ 3 次退避：前两次全失败（主源 + 备用源各一发），第三次必须通
  const up2 = await startFakeSocks5({
    requireAuth: [USER, PASS], dialHost, label: 'flaky-upstream', failFirstN: 4,
  });
  const relay2 = await startRelay({ type: 'socks5', host: '127.0.0.1', port: up2.port, username: USER, password: PASS });
  resetRelayPorts();
  resetStartProbeCache();
  setRelayPort('p1', relay2.port);
  const t0 = Date.now();
  const retried = await probeStartEgress(profileOf(up2.port), { force: true });
  const took = Date.now() - t0;
  check('③ 前两次失败后第三次成功（不是单发判死）',
    retried.ok === true && retried.attempts === 3,
    `ok=${retried.ok} attempts=${retried.attempts} 耗时=${took}ms`);
  check('③ 退避真的等了（0 + 1.5s + 4s ≈ 5.5s 起步）', took >= 5000, `${took}ms`);
  check('③ 失败那两轮的原因没有被丢掉（最后一次成功前有失败记录）',
    up2.stats.failed >= 4, `上游 forced_fail=${up2.stats.failed}`);
  await relay2.close();
  await up2.close();

  // ④ 缓存：15 秒内重复调用不再打上游
  resetRelayPorts();
  setRelayPort('p1', relay.port);
  resetStartProbeCache();
  const before = up.stats.connections;
  const first = await probeStartEgress(profileOf(up.port), { force: true });
  const mid = up.stats.connections;
  const second = await probeStartEgress(profileOf(up.port));
  const after = up.stats.connections;
  check('④ 15 秒缓存生效（第二次不重复探测）',
    first.ok === true && second.ok === true && mid > before && after === mid,
    `before=${before} mid=${mid} after=${after}`);
} finally {
  await relay.close().catch(() => {});
  await up.close().catch(() => {});
  await echo.close().catch(() => {});
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);
