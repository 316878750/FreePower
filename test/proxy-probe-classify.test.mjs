/**
 * 代理预检的**失败归类**判据（0.4.7.5 红⑥，CEO 2026-11-18 19:30 定的口径）。
 *
 * 现场：10056 的代理单发 748ms 就通（出口 38.190.243.212），但产品启动被拦住：
 *   `start failed: 代理不可用，已阻止启动（fail-closed）：代理不可用：http://ip-api.com/...`
 * 真因是 ip-api.com 被我们打了几百次、触发免费额度限流（45 次/分钟）——
 * **探测源挂了，不是代理不通**。这条错判会让人去换一条本来好的代理（今天差点定反方向）。
 *
 * 口径（本判据钉的就是它）：
 *   - 硬失败（才允许 fail-closed 拦启动）：`tcp` = TCP 连不上上游；`auth` = 握手被拒 / 认证失败；
 *   - 软失败（只说明「没验证成功」，不许拦启动）：`probe_site` = 探测站 429/403/5xx/空 body/慢；
 *     `target` = 上游连不上目标。
 *
 * 判据（全部用假上游，**不碰用户真代理**）：
 *   ① 两个探测源都 429 → kind=probe_site、`isHardProxyFailure=false`、error 写「探测源不可用（不是代理不通）」
 *   ② 探测站 200 但空 body → kind=probe_site
 *   ③ TCP 不通（端口没监听）→ kind=tcp、硬失败
 *   ④ SOCKS5 认证失败 → kind=auth、硬失败
 *   ⑤ 上游连不上目标（SOCKS5 回 0x05）→ kind=target、软失败
 *   ⑥ 软失败的起始页文案写「探测源不可用」，**不写**「代理未连通」
 *
 * 跑法：npm run test:proxy-probe-classify
 */
import net from 'node:net';
import { startFakeSocks5 } from './fake-socks5.mjs';
import { renderStartHtml } from '../src/start/page.js';

// 动态取：旧版 probe.js 没有归类函数时，判据要逐条红（不是整个文件 import 崩掉看不见读数）
const probeMod = await import('../src/proxy/probe.js');
const checkProxy = probeMod.checkProxy;
const isHardProxyFailure = probeMod.isHardProxyFailure || (() => false);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/** 假 HTTP 代理：收到请求头就按 `respond(requestHead)` 回一段固定报文 */
function startFakeHttpProxy(respond) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.on('error', () => { /* 对端断，正常 */ });
      let buf = '';
      sock.on('data', (c) => {
        buf += c.toString('latin1');
        if (buf.includes('\r\n\r\n')) sock.end(respond(buf));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => { server.close(() => r()); }),
      });
    });
  });
}

const RATE_LIMITED = 'HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';
const EMPTY_OK = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';

const USER = 'probe-user';
const PASS = 'probe-pass-6b1';

const upSocks = await startFakeSocks5({ requireAuth: [USER, PASS], label: 'classify' });

try {
  // ① 两个探测源都 429（ip-api 限流的真实形状）
  {
    const fake = await startFakeHttpProxy(() => RATE_LIMITED);
    const r = await checkProxy({ type: 'http', host: '127.0.0.1', port: fake.port }, { timeoutMs: 4000 });
    check('① 探测源 429 → 归类 probe_site（软失败）', r.ok === false && r.kind === 'probe_site', `ok=${r.ok} kind=${r.kind}`);
    check('① 软失败不算代理不可用（isHardProxyFailure=false）', isHardProxyFailure(r.kind) === false, `kind=${r.kind}`);
    check('① 文案写「探测源不可用（不是代理不通）」，不写「代理不可用」',
      /探测源不可用（不是代理不通）/.test(String(r.error)) && !/^代理不可用/.test(String(r.error)),
      String(r.error).slice(0, 90));
    check('① 两个源都试过（attempts 有两条）', Array.isArray(r.attempts) && r.attempts.length === 2, `attempts=${r.attempts?.length}`);
    await fake.close();
  }

  // ② 探测站 200 但空 body（代理通了，探测站没给内容）
  {
    const fake = await startFakeHttpProxy(() => EMPTY_OK);
    const r = await checkProxy({ type: 'http', host: '127.0.0.1', port: fake.port }, { timeoutMs: 4000 });
    check('② 空 body → 归类 probe_site（软失败）', r.ok === false && r.kind === 'probe_site', `kind=${r.kind} err=${String(r.error).slice(0, 60)}`);
    await fake.close();
  }

  // ③ TCP 不通（端口没监听）→ 硬失败，必须拦启动
  {
    const r = await checkProxy({ type: 'socks5', host: '127.0.0.1', port: 9 }, { timeoutMs: 1500 });
    check('③ TCP 连不上 → 归类 tcp（硬失败）', r.ok === false && r.kind === 'tcp' && isHardProxyFailure(r.kind) === true, `kind=${r.kind}`);
    check('③ 文案仍是「代理不可用」', /^代理不可用/.test(String(r.error)), String(r.error).slice(0, 60));
  }

  // ④ SOCKS5 认证失败 → 硬失败
  {
    const r = await checkProxy(
      { type: 'socks5', host: '127.0.0.1', port: upSocks.port, username: 'wrong', password: 'wrong' },
      { timeoutMs: 4000 },
    );
    check('④ 认证失败 → 归类 auth（硬失败）', r.ok === false && r.kind === 'auth' && isHardProxyFailure(r.kind) === true, `kind=${r.kind} err=${String(r.error).slice(0, 60)}`);
  }

  // ⑤ 上游连不上目标（假上游把目标拨到死端口，回 0x05）→ 软失败
  {
    const r = await checkProxy(
      { type: 'socks5', host: '127.0.0.1', port: upSocks.port, username: USER, password: PASS },
      { timeoutMs: 4000, url: 'http://127.0.0.1:1/', fallbackUrls: ['http://127.0.0.1:2/'] },
    );
    check('⑤ 上游连不上目标 → 归类 target（软失败）', r.ok === false && r.kind === 'target' && isHardProxyFailure(r.kind) === false, `kind=${r.kind} err=${String(r.error).slice(0, 70)}`);
  }

  // ⑥ 起始页文案：软失败写「探测源不可用」，不写「代理未连通」
  {
    const profile = {
      profile_id: 'probe-classify-1', name: '分类判据', proxy_config: { type: 'socks5', host: '127.0.0.1', port: 1080 },
    };
    const softHtml = renderStartHtml(profile, {
      probe: { ok: false, kind: 'probe_site', error: '探测源不可用（不是代理不通）：ip-api 429', via: 'proxy', latency_ms: 1200, at: new Date().toISOString() },
    });
    const hardHtml = renderStartHtml(profile, {
      probe: { ok: false, kind: 'tcp', error: '代理不可用：连接超时', via: 'proxy', latency_ms: 300, at: new Date().toISOString() },
    });
    // 页面里那段内联脚本本来就含 '代理未连通' 这个字符串（客户端重绘用），
    // 所以断言要钉**服务端渲染出来的状态标签**：>探测源不可用< / >代理未连通<
    check('⑥ 软失败：状态标签写「探测源不可用」', softHtml.includes('>探测源不可用<'), '');
    check('⑥ 软失败：状态标签**不是**「代理未连通」', !softHtml.includes('>代理未连通<'), '');
    check('⑥ 软失败：状态块用的是 warn 样式（不是 bad）', /class="status warn"/.test(softHtml), '');
    check('⑥ 硬失败：状态标签仍写「代理未连通」', hardHtml.includes('>代理未连通<'), '');
  }
} finally {
  await upSocks.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);
