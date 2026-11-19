/**
 * 拨号两段埋点判据（`dial_tcp_ms` / `dial_reply_ms` / `dial_fail_stage`）。
 *
 * 为什么要这条：21s 到底烧在「到代理这一跳的 SYN 丢包」还是「代理去连目标失败」，直接决定方向。
 * 两段的判法必须能分开：tcp 段失败不能污染 reply 段，反之亦然。
 *
 * 口径：假上游 + TEST-NET-1 黑洞（192.0.2.1），不碰真代理。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startFakeSocks5 } from './fake-socks5.mjs';
import { startRelay } from '../src/proxy/relay.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function withRelay(upstream, opt, fn) {
  const relay = await startRelay(upstream, opt);
  try {
    await fn(relay);
  } finally {
    await relay.close().catch(() => {});
  }
}

test('① 建隧道成功：tcp 段与 reply 段都有耗时，三段失败计数全 0', async () => {
  const up = await startFakeSocks5({ handshakeMs: 60, sink: true });
  try {
    await withRelay({ type: 'socks5', host: '127.0.0.1', port: up.port, username: 'socks-user', password: 'socks-pass' }, {}, async (relay) => {
      const { s, rep } = await socksConnect(relay.port, 'example.test', 80);
      await sleep(100);
      assert.equal(rep, 0);
      const st = relay.stats;
      assert.ok(st.dial_tcp_ms_total > 0, `tcp 段耗时应 > 0，实际 ${st.dial_tcp_ms_total}`);
      assert.ok(Number.isFinite(st.dial_reply_ms_total) && st.dial_reply_ms_total >= 0, `reply 段耗时要记，实际 ${st.dial_reply_ms_total}`);
      assert.deepEqual(st.dial_fail_stage, { tcp: 0, auth: 0, reply: 0 });
      assert.equal(st.dial_tcp_fail, 0);
      assert.equal(st.dial_reply_fail, 0);
      s.destroy();
    });
  } finally { await up.close(); }
});

test('② 到代理这一跳连不上（TEST-NET-1 黑洞）：只记 tcp 段失败', async () => {
  await withRelay({ type: 'socks5', host: '192.0.2.1', port: 9 }, { dialAttemptMs: 300, dialAttempts: 1, dialBudgetMs: 800, timeoutMs: 2000 }, async (relay) => {
    const { s, rep } = await socksConnect(relay.port, 'example.test', 80);
    await sleep(100);
    assert.notEqual(rep, 0, '黑洞上游必须失败');
    const st = relay.stats;
    assert.equal(st.dial_tcp_fail, 1, 'tcp 段失败 1 次');
    assert.equal(st.dial_fail_stage.tcp, 1);
    assert.equal(st.dial_reply_fail, 0, 'TCP 都没连上，reply 段不该计数');
    assert.equal(st.dial_fail_stage.reply, 0);
    assert.equal(st.dial_fail_stage.auth, 0);
    assert.ok(st.dial_tcp_ms >= 250, `应等满 300ms 拨号窗口，实际 ${st.dial_tcp_ms}`);
    s.destroy();
  });
});

test('③ 认证被拒：只记 auth 段，tcp 段算成功', async () => {
  const up = await startFakeSocks5({ requireAuth: ['right-user', 'right-pass'] });
  try {
    await withRelay({ type: 'socks5', host: '127.0.0.1', port: up.port, username: 'wrong', password: 'wrong' }, {}, async (relay) => {
      const { s, rep } = await socksConnect(relay.port, 'example.test', 80);
      await sleep(100);
      assert.notEqual(rep, 0);
      const st = relay.stats;
      assert.equal(st.dial_fail_stage.auth, 1, '认证失败要记在 auth 段');
      assert.equal(st.dial_tcp_fail, 0, 'TCP 是通的，不该算 tcp 失败');
      assert.equal(st.dial_fail_stage.tcp, 0);
      assert.equal(st.dial_fail_stage.reply, 0);
      assert.ok(Number.isFinite(st.dial_tcp_ms_total) && st.dial_tcp_ms_total >= 0, 'tcp 段耗时要记（本机回环可能 0ms）');
      s.destroy();
    });
  } finally { await up.close(); }
});

test('④ 代理连目标失败（回 REP_FAIL）：只记 reply 段', async () => {
  const up = await startFakeSocks5({ failFirstN: 99 });
  try {
    await withRelay({ type: 'socks5', host: '127.0.0.1', port: up.port, username: 'socks-user', password: 'socks-pass' }, {}, async (relay) => {
      const { s, rep } = await socksConnect(relay.port, 'example.test', 80);
      await sleep(100);
      assert.notEqual(rep, 0);
      const st = relay.stats;
      assert.equal(st.dial_fail_stage.reply, 1, 'CONNECT 被拒要记在 reply 段');
      assert.equal(st.dial_reply_fail, 1);
      assert.equal(st.dial_fail_stage.tcp, 0);
      assert.equal(st.dial_fail_stage.auth, 0);
      s.destroy();
    });
  } finally { await up.close(); }
});
