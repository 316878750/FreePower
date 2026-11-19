/**
 * 链式上游判据（0.4.7.7）：中继先连**本地 SOCKS5 链**，在隧道里再去连环境代理。
 *
 * 为什么：AdsPower 在这台机器上把「拨环境代理」这件事放到隧道对端（泰国节点）去做，
 * 绕开了「本机 → 环境代理」这段会丢 SYN 的路径，页面出口仍是环境代理的 IP。
 * 我们要对齐这个行为，且必须证明三件事，缺一条都不能算对：
 *   ① 两层 SOCKS5 能套起来，页面数据真的穿过来了；
 *   ② **最后一跳是内层（环境代理）**，外层只看到「CONNECT 到内层 host:port」—— 否则出口就变成泰国节点了；
 *   ③ 链本身不可用时退回直连（`chain_fail` 计数），不许 fail-closed 拦住用户。
 *
 * 口径：全部假上游（本机两层 SOCKS5 + 本地 HTTP 服务），不碰真代理。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { startFakeSocks5 } from './fake-socks5.mjs';
import { startRelay } from '../src/proxy/relay.js';
import { resolveUpstreamChain } from '../src/proxy/system-proxy.js';

const CREDS = ['socks-user', 'socks-pass'];
const PAGE = '<html><head><title>FreePower Relay E2E</title></head><body><h1>relay-ok</h1></body></html>';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个只回固定 HTML 的本地站点（判据用真 HTTP，不 mock 字节） */
function startTarget() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise((r) => server.close(() => r())),
    }));
  });
}

/** 经中继建一条隧道（浏览器侧无认证），返回 socket 与 REP */
function socksConnect(relayPort, host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(relayPort, '127.0.0.1', () => {
      s.write(Buffer.from([5, 1, 0]));
      s.once('data', () => {
        const h = Buffer.from(host);
        s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]));
        s.once('data', (r) => resolve({ s, rep: r[1] }));
      });
    });
    s.on('error', reject);
  });
}

/** 在隧道里发一个 HTTP GET，读回整段响应 */
function httpThrough(socket, host) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('隧道里没读到 HTTP 响应')), 5000);
    socket.on('data', (c) => {
      buf += c.toString('latin1');
      if (buf.includes('relay-ok')) { clearTimeout(timer); resolve(buf); }
    });
    socket.on('error', (e) => { clearTimeout(timer); reject(e); });
    socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  });
}

/** 起两层假 SOCKS5：外层（本地链，无认证）+ 内层（环境代理，要账号密码） */
async function startTwoLayers() {
  const target = await startTarget();
  const inner = await startFakeSocks5({
    requireAuth: CREDS,
    dialHost: (h) => (h === 'target.test' ? '127.0.0.1' : h),
  });
  const outer = await startFakeSocks5({ requireAuth: null });
  return { target, inner, outer };
}

async function closeAll(...objs) {
  for (const o of objs) { try { await o.close(); } catch { /* ignore */ } }
}

/** 拿一个确定没人听的端口（先监听再关掉） */
function closedPort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

test('① 两层套起来能通：页面数据穿过链，最后一跳是内层（环境代理）', async () => {
  const { target, inner, outer } = await startTwoLayers();
  const relay = await startRelay(
    { type: 'socks5', host: '127.0.0.1', port: inner.port, username: CREDS[0], password: CREDS[1] },
    { chain: { host: '127.0.0.1', port: outer.port } },
  );
  try {
    const { s, rep } = await socksConnect(relay.port, 'target.test', target.port);
    assert.equal(rep, 0, '中继应回 REP_OK');
    const body = await httpThrough(s, 'target.test');
    s.destroy();
    assert.match(body, /relay-ok/, '页面内容应穿过两层代理到达浏览器');

    // 外层（本地链）只看到「CONNECT 到内层代理」—— 出口没被链换掉
    assert.equal(outer.connects.length, 1, `外层应只有 1 条 CONNECT，实际 ${outer.connects.length}`);
    assert.equal(outer.connects[0].host, '127.0.0.1');
    assert.equal(outer.connects[0].port, inner.port, '外层必须连的是内层（环境代理）的 host:port');
    assert.equal(outer.authSeen.length, 0, '外层（本地链）不该收到环境代理的账号密码');

    // 内层（环境代理）才是连目标的那一跳，且凭据是环境里配的
    assert.equal(inner.records.length, 1);
    assert.equal(inner.records[0].host, 'target.test', '最后一跳必须是内层去连目标（出口 = 环境代理）');
    assert.deepEqual(inner.authSeen[0], { username: CREDS[0], password: CREDS[1] });

    assert.equal(relay.stats.chain, `127.0.0.1:${outer.port}`);
    assert.equal(relay.stats.chain_used, 1, '走链成功应记 chain_used=1');
    assert.equal(relay.stats.chain_fail, 0);
    assert.ok(Number.isFinite(relay.stats.chain_tcp_ms) && relay.stats.chain_tcp_ms >= 0, '要记连本地链的耗时');
    assert.equal(relay.stats.tunnels, 1);
    assert.equal(relay.stats.failed, 0);
  } finally {
    await relay.close().catch(() => {});
    await closeAll(inner, outer, target);
  }
});

test('② 链不可达 → 退回直连，页面仍能出内容（不 fail-closed）', async () => {
  const { target, inner, outer } = await startTwoLayers();
  const deadPort = await closedPort();
  const relay = await startRelay(
    { type: 'socks5', host: '127.0.0.1', port: inner.port, username: CREDS[0], password: CREDS[1] },
    { chain: { host: '127.0.0.1', port: deadPort } },
  );
  try {
    const { s, rep } = await socksConnect(relay.port, 'target.test', target.port);
    assert.equal(rep, 0, '链挂了也必须能直连出去（不许拦启动/拦连接）');
    const body = await httpThrough(s, 'target.test');
    s.destroy();
    assert.match(body, /relay-ok/);
    assert.equal(relay.stats.chain_used, 0);
    assert.ok(relay.stats.chain_fail >= 1, `应记 chain_fail，实际 ${relay.stats.chain_fail}`);
    assert.equal(relay.stats.tunnels, 1);
    assert.equal(relay.stats.failed, 0);
    // 直连时外层没被碰过，内层直接收到 CONNECT
    assert.equal(outer.connects.length, 0, '链不通时不该有任何流量经过外层');
    assert.equal(inner.records.length, 1);
  } finally {
    await relay.close().catch(() => {});
    await closeAll(inner, outer, target);
  }
});

test('③ 环境代理认证失败 → 不退回直连（不许绕过用户配的代理）', async () => {
  const { target, inner, outer } = await startTwoLayers();
  const relay = await startRelay(
    { type: 'socks5', host: '127.0.0.1', port: inner.port, username: CREDS[0], password: 'wrong-pass' },
    { chain: { host: '127.0.0.1', port: outer.port } },
  );
  try {
    const { rep } = await socksConnect(relay.port, 'target.test', target.port);
    assert.notEqual(rep, 0, '内层认证失败必须报错，不能悄悄改走直连');
    await sleep(100);
    assert.equal(relay.stats.chain_used, 0, '内层失败不算走链成功');
    assert.equal(relay.stats.chain_fail, 0, 'chain_fail 只统计「链本身不可用」，不统计内层失败');
    assert.ok(relay.stats.dial_fail_stage.auth >= 1, `认证失败应落在 auth 段，实际 ${JSON.stringify(relay.stats.dial_fail_stage)}`);
    assert.equal(relay.stats.tunnels, 0);
  } finally {
    await relay.close().catch(() => {});
    await closeAll(inner, outer, target);
  }
});

test('④ 开关：FREEPOWER_RELAY_CHAIN=0 关链；显式 socks5:// 指定链', () => {
  assert.equal(resolveUpstreamChain({ FREEPOWER_RELAY_CHAIN: '0' }), null);
  assert.equal(resolveUpstreamChain({ FREEPOWER_RELAY_CHAIN: 'off' }), null);
  assert.equal(resolveUpstreamChain({ FREEPOWER_RELAY_CHAIN: 'false' }), null);
  const pick = (o) => (o ? { host: o.host, port: o.port } : null);
  assert.deepEqual(pick(resolveUpstreamChain({ FREEPOWER_RELAY_CHAIN: 'socks5://127.0.0.1:10808' })), { host: '127.0.0.1', port: 10808 });
  assert.deepEqual(pick(resolveUpstreamChain({ FREEPOWER_RELAY_CHAIN: '127.0.0.1:1080' })), { host: '127.0.0.1', port: 1080 });
  assert.equal(resolveUpstreamChain({ FREEPOWER_RELAY_CHAIN: 'http://127.0.0.1:7890' }), null, 'HTTP 系统代理不能当 SOCKS 链用');
});

test('⑤ 关掉链（chain=null）行为与直连完全一致', async () => {
  const { target, inner, outer } = await startTwoLayers();
  const relay = await startRelay(
    { type: 'socks5', host: '127.0.0.1', port: inner.port, username: CREDS[0], password: CREDS[1] },
    {},
  );
  try {
    const { s, rep } = await socksConnect(relay.port, 'target.test', target.port);
    assert.equal(rep, 0);
    assert.match(await httpThrough(s, 'target.test'), /relay-ok/);
    s.destroy();
    assert.equal(relay.stats.chain, null);
    assert.equal(relay.stats.chain_used, 0);
    assert.equal(relay.stats.chain_fail, 0);
    assert.equal(outer.records.length, 0, '关链时不该碰本地链');
  } finally {
    await relay.close().catch(() => {});
    await closeAll(inner, outer, target);
  }
});
