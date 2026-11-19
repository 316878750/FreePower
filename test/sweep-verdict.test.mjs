/**
 * 0.4.7.7 判据：43 全量里暴露的三件事
 *
 * ① **判定器误判**（环境 10090）：单发探针 55272ms 超时、可页面明明渲染了
 *    （body_ms 15436 / 35117、body_len 6616 / 192、非 chrome-error），却被归成「代理」。
 *    口径：**页面已经渲染 → 单发探针没有发言权**，不许把成功的页面判红；note 也不许拿单发覆盖页面。
 *
 * ② **出口 IP 探测 35/35 全失败**：只有 ip-api 一个源，被 35 环境 × 3 次退避打进限流。
 *    口径：多端点轮换（ip-api → ipinfo → ipify），任一成功即止；全失败写「未验证」。
 *
 * ③ **站1 body_len=3339 vs 6616**（10089 / 10091）：settle-body 只有 2030/2034ms，
 *    正好卡在最短稳定窗口上 → 稳定窗口 2s 太短，放宽到 4s。
 *
 * 全部用假数据/假上游，**不碰真代理、不起真内核**。
 *
 * 跑法：SWEEP_IMPORT_ONLY=1 node --no-warnings test/sweep-verdict.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.SWEEP_IMPORT_ONLY = '1';
const sweep = await import('../tools/fingerprint-sweep.mjs');
const { verdictOf, noteOf, pagesRendered } = sweep;

/** 一个「页面渲染了」的站 */
const okSite = (ms = 9000, len = 6616) => ({
  url: 'https://defi.xstocks.fi/points',
  ms, body_ms: ms, settle_ms: ms + 4000, timeout: false, winner: 'done',
  title: 'xPoints Rewards Program - xStocks', chrome_error: false, href: 'https://defi.xstocks.fi/points',
  body300: 'Products Bridge Wrap', body_len: len, label: '过', blocked: null,
});
/** 一个「没渲染」的站 */
const deadSite = (label = 'chrome-error') => ({
  url: 'https://app.startale.com/', ms: 60000, body_ms: null, settle_ms: 60000, timeout: true, winner: 'deadline',
  title: null, chrome_error: label === 'chrome-error', href: label === 'chrome-error' ? 'chrome-error://chromewebdata/' : null,
  body300: '', body_len: 0, label, blocked: null,
});

const run = (over = {}) => ({
  start_error: null,
  single: { ok: true, latency_ms: 900, ip: '38.190.239.119', kind: undefined },
  relay: { connections: 48, tunnels: 48, failed: 0, queue_timeout: 0, dial_timeout: 0 },
  sites: [okSite(), okSite(27000, 192)],
  ...over,
});

test('① 10090 原样复现：单发超时 + 两站都渲染 → 判「过」，不许判「代理」', () => {
  const r = run({
    single: { ok: false, kind: 'tcp', latency_ms: 55272, error: '代理不可用：SOCKS5 握手 超时（30000ms）' },
    sites: [okSite(15436, 6616), okSite(35117, 192)],
  });
  assert.equal(pagesRendered(r), true, '两站都出了正文');
  assert.equal(verdictOf(r), '过', '页面渲染了就是过，单发超时不能翻案');
  assert.equal(noteOf(r, '过'), '');
});

test('① 页面渲染但标题不符 → 判「指纹」，note 讲页面、单发只作附注', () => {
  const bad = { ...okSite(12000, 6616), label: '标题不符', blocked: '标题不符', title: 'Something Else' };
  const r = run({ single: { ok: false, kind: 'tcp', latency_ms: 55272 }, sites: [bad, okSite(27000, 192)] });
  assert.equal(verdictOf(r), '指纹', '页面有内容、只是标题变了');
  const note = noteOf(r, '指纹');
  assert.ok(/页面未通过/.test(note), `note 要先讲页面，实际：${note}`);
  assert.ok(/单发附注/.test(note), `单发只能作附注，实际：${note}`);
  assert.ok(!/^单发 不通/.test(note), 'note 不许以单发结论打头');
});

test('① 页面没渲染时才轮得到单发当判别器', () => {
  const tcpFail = run({ single: { ok: false, kind: 'tcp', latency_ms: 60000 }, sites: [deadSite(), deadSite()] });
  assert.equal(verdictOf(tcpFail), '代理', '页面全废 + 单发 TCP 不通 → 代理');
  assert.ok(/^单发 不通/.test(noteOf(tcpFail, '代理')), '页面没内容时 note 以单发起头是对的');

  const softFail = run({ single: { ok: false, kind: 'probe_site', latency_ms: 60000 }, sites: [deadSite(), deadSite()] });
  assert.equal(verdictOf(softFail), '我核不了', '页面全废 + 单发只是探测源不可用 → 判不了');

  const singleOk = run({ single: { ok: true, latency_ms: 800, ip: '1.2.3.4' }, sites: [deadSite(), deadSite()] });
  assert.equal(verdictOf(singleOk), '产品', '单发通、产品里不通 → 产品');
});

test('① 中继证据仍然优先（页面全废 + 排队超时）', () => {
  const r = run({
    single: { ok: true, latency_ms: 800, ip: '1.2.3.4' },
    relay: { connections: 40, tunnels: 3, failed: 9, queue_timeout: 12, dial_timeout: 9 },
    sites: [deadSite(), deadSite()],
  });
  assert.equal(verdictOf(r), '中继');
});

test('② 出口探测：三个端点按序轮换，任一成功即止；全失败才「未验证」', async () => {
  const probeMod = await import('../src/proxy/probe.js');
  assert.deepEqual(probeMod.FALLBACK_PROBE_URLS, ['https://ipinfo.io/json', 'https://api.ipify.org'],
    '备用源顺序：ipinfo → ipify（ip-api 是主源）');

  // 起始页文案：软失败 = 「未验证（探测源不可用）」，warn 样式，不是红色 bad
  const { renderStartHtml } = await import('../src/start/page.js');
  const profile = { profile_id: 'p-1', name: '判据', proxy_config: { type: 'socks5', host: '127.0.0.1', port: 1080 } };
  const html = renderStartHtml(profile, {
    probe: { ok: false, kind: 'probe_site', error: '三个源都不可用', via: 'proxy', latency_ms: 900, at: new Date().toISOString() },
  });
  assert.ok(html.includes('>未验证（探测源不可用）<'), '服务端渲染的状态标签');
  assert.ok(/class="status warn"/.test(html), '必须是警告样式');
  assert.ok(!html.includes('>代理未连通<'), '不许写成代理未连通');
});

test('② 起始页探测缓存：成功 10 分钟、失败 60 秒（不再每次启动都打出口接口）', async () => {
  const p = await import('../src/start/probe.js');
  assert.equal(p.CACHE_TTL_OK_MS, 10 * 60 * 1000, '成功缓存 10 分钟');
  assert.equal(p.CACHE_TTL_FAIL_MS, 60 * 1000, '失败缓存 60 秒');
  assert.ok(p.CACHE_TTL_OK_MS > 15000, '旧的 15 秒一律缓存就是打爆 ip-api 的原因');
});

test('② 浏览器内探测：第一个端点 status=fail → 自动落到第二个端点并成功', async () => {
  const { probeEgressInBrowser } = await import('../src/proxy/egress.js');
  const hits = [];
  const client = {
    async send(method, params = {}) {
      if (method === 'Target.createTarget') return { targetId: `t${hits.length}` };
      if (method === 'Target.attachToTarget') return { sessionId: 's1' };
      if (method === 'Page.navigate') { hits.push(params.url); return {}; }
      if (method === 'Runtime.evaluate') {
        const url = String(params.__url || '');
        // 用最近一次 navigate 的 url 决定回什么
        const cur = hits[hits.length - 1] || '';
        if (/ip-api\.com/.test(cur)) return { result: { value: 'complete\u0000{"status":"fail","message":"private range"}' } };
        if (/ipinfo\.io/.test(cur)) return { result: { value: 'complete\u0000{"ip":"203.0.113.7","country":"Nowhere"}' } };
        return { result: { value: 'complete\u0000' } };
      }
      return {};
    },
  };
  const r = await probeEgressInBrowser(client, {
    urls: ['http://ip-api.com/json/', 'https://ipinfo.io/json'],
    retries: [0],
    timeoutMs: 2000,
  });
  assert.equal(r.ok, true, `应落到第二个端点成功，实际 ${JSON.stringify(r).slice(0, 160)}`);
  assert.equal(r.ip, '203.0.113.7');
  assert.ok(hits.some((u) => /ip-api\.com/.test(u)) && hits.some((u) => /ipinfo\.io/.test(u)), `两个端点都试过：${hits}`);
});

test('③ 扫描脚本的正文稳定窗口是 4s（2s 会踩到 SPA 的渲染间隙）', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../tools/fingerprint-sweep.mjs', import.meta.url), 'utf8');
  assert.ok(/const stableMs = 4000;/.test(src), '稳定窗口应为 4000ms');
  assert.ok(!/const stableMs = 2000;/.test(src), '不许再是 2000ms');
  // body_ms 仍然是「正文首次非空」，放宽窗口不改变判据
  assert.ok(/body_ms: firstBodyMs/.test(src), 'body_ms 仍是首次非空时刻');
  assert.ok(/timeout: !everBody/.test(src), 'timeout 仍由「从没读到正文」决定');
});
