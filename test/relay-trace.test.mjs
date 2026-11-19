/**
 * 可观测判据：`FREEPOWER_RELAY_TRACE` / `FREEPOWER_RELAY_PROBE_MS`（0.4.7.6 之后补，默认关）。
 *
 * 为什么有这条：0.4.7.6 给中继加逐条明细时踩过一个坑 —— 数组建在 `stats` 上、写入端读的是
 * `state.trace`，两个不是同一个对象，结果「明细永远是空的」，汇总数却全对，肉眼看不出来。
 * 所以这里除了断言「记到了」，还**专门断言 stats 与写入端是同一份**（③），防止再犯。
 *
 * 口径：假上游（不碰真代理）；trace/probe 默认必须是关的（不占内存、不产生额外连接）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startFakeSocks5 } from './fake-socks5.mjs';
import { startRelay } from '../src/proxy/relay.js';

const UPSTREAM = { type: 'socks5', host: '127.0.0.1', username: 'socks-user', password: 'socks-pass' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 走中继建一条隧道（浏览器侧无认证），返回 REP 与 socket */
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

async function withRelay(env, fn) {
  const saved = { trace: process.env.FREEPOWER_RELAY_TRACE, probe: process.env.FREEPOWER_RELAY_PROBE_MS };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const up = await startFakeSocks5({ sink: true });
  const relay = await startRelay({ ...UPSTREAM, port: up.port });
  try {
    await fn({ relay, up });
  } finally {
    await relay.close().catch(() => {});
    await up.close().catch(() => {});
    for (const [k, v] of Object.entries({ FREEPOWER_RELAY_TRACE: saved.trace, FREEPOWER_RELAY_PROBE_MS: saved.probe })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('① 默认关：trace / probes 都是 null（不占内存、不多开连接）', async () => {
  await withRelay({ FREEPOWER_RELAY_TRACE: undefined, FREEPOWER_RELAY_PROBE_MS: undefined }, async ({ relay }) => {
    const { s, rep } = await socksConnect(relay.port, 'example.test', 80);
    await sleep(150);
    assert.equal(rep, 0);
    assert.equal(relay.stats.trace, null, '默认不该记明细');
    assert.equal(relay.stats.probes, null, '默认不该跑对照探针');
    s.destroy();
  });
});

test('② 开 trace：一条连接记一条，含目标 / 拨号尝试 / 结果 / 耗时', async () => {
  await withRelay({ FREEPOWER_RELAY_TRACE: '1' }, async ({ relay }) => {
    const { s, rep } = await socksConnect(relay.port, 'example.test', 80);
    await sleep(150);
    assert.equal(rep, 0);
    const trace = relay.stats.trace;
    assert.equal(trace.length, 1, `应记 1 条，实际 ${trace.length}`);
    const rec = trace[0];
    assert.equal(rec.target, 'example.test:80');
    assert.equal(rec.result, 'tunnel');
    assert.equal(rec.attempts.length, 1);
    assert.equal(rec.attempts[0].ok, true);
    assert.ok(Number.isFinite(rec.attempts[0].ms), '每次拨号要有耗时');
    assert.ok(Number.isFinite(rec.total_ms), '整条连接要有总耗时');
    s.destroy();
  });
});

test('③ stats 与写入端同一份（明细为空那个 bug 的回归）', async () => {
  await withRelay({ FREEPOWER_RELAY_TRACE: '1', FREEPOWER_RELAY_PROBE_MS: '200' }, async ({ relay }) => {
    const { s } = await socksConnect(relay.port, 'example.test', 80);
    await sleep(450);
    assert.equal(relay.trace, relay.stats.trace, '写入端 state.trace 必须就是 stats.trace');
    assert.equal(relay.probes, relay.stats.probes, '写入端 state.probes 必须就是 stats.probes');
    assert.ok(relay.stats.trace.length >= 1, '明细不该为空');
    assert.ok(relay.stats.probes.length >= 1, '对照探针不该为空');
    s.destroy();
  });
});

test('④ 对照探针：单条直连上游，记耗时与当时在飞的拨号数', async () => {
  await withRelay({ FREEPOWER_RELAY_PROBE_MS: '200' }, async ({ relay }) => {
    await sleep(650);
    const probes = relay.stats.probes;
    assert.ok(probes.length >= 2, `至少两次探针，实际 ${probes.length}`);
    for (const p of probes) {
      assert.ok(Number.isFinite(p.ms), '探针要有耗时');
      assert.equal(typeof p.ok, 'boolean');
      assert.ok(Number.isFinite(p.in_flight), '要记探针时刻在飞的拨号数（对照用）');
    }
    assert.ok(probes.some((p) => p.ok), '假上游正常，至少有一次探针是通的');
  });
});
