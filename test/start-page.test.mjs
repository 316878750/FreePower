/**
 * 起始页（0.4.7.3）—— **A 层判据**：不起内核，只验「服务进程出的这一页」。
 *
 * 要证明的事：
 *   1) 签名：没有 key 也能读，但只有**绑对这个环境**的未过期签名能读；换个 id / 改一位 / 过期 → 403；
 *   2) 内容：环境名、代理 host:port、**期望出口**（导入时带的 ip/国家/城市）、内核版本、UA 都在页面上；
 *   3) 页面**一个外连都不发**：HTML 里没有 `<script src>` / `<link>` / `<img>` / 绝对 URL，
 *      内联脚本只 fetch **同源**的 `/start/data`；响应头带 CSP（`connect-src 'self'`）；
 *   4) 探测在**服务进程**里做：直连与代理两条路都能拿到出口 IP；代理不通时页面写「代理未连通：<原因>」；
 *   5) 凭据不进页面/JSON（只写「带用户名密码」）；
 *   6) 结果按环境缓存 15 秒，`force=1` 才重探。
 *
 * 真内核那半边（起始页在代理全挂时也能打开、open_urls 为空时第一张就是它）在
 * `test/start-page-kernel.test.mjs`。跑法：npm run test:start-page
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const fmt = (x) => JSON.stringify(x);

const FAKE_IP = '203.0.113.88';
const PROXY_USER = 'start-user-7c';
const PROXY_PASS = 'start-pass-91ab';

/* ------------------------------ 假出口接口 ------------------------------ */

const exitHits = [];
const exitSrv = http.createServer((req, res) => {
  exitHits.push({ url: req.url, host: req.headers.host || '' });
  const body = JSON.stringify({
    status: 'success', country: 'Japan', countryCode: 'JP', regionName: 'Tokyo',
    city: 'Tokyo', timezone: 'Asia/Tokyo', isp: 'Start Page Lab', query: FAKE_IP,
  });
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
});
await new Promise((r) => exitSrv.listen(0, '127.0.0.1', r));
const EXIT_PORT = exitSrv.address().port;

/* ------------------------------ 一次性数据根 ------------------------------ */

const DATA = path.join(ROOT, '.tmp', `startpage-${process.pid}-${Date.now()}`);
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.FREEPOWER_DATA = DATA;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = `http://127.0.0.1:${EXIT_PORT}/exit`;
process.env.FREEPOWER_PROXY_TIMEOUT = '3000';
process.env.FREEPOWER_UA_AUTOALIGN = '0';

const { startFakeSocks5 } = await import('./fake-socks5.mjs');
const { startApiServer } = await import('../src/boot.js');
const profiles = await import('../src/store/profiles.js');
const page = await import('../src/start/page.js');
const { resetStartProbeCache } = await import('../src/start/probe.js');
const { signStart } = await import('../src/start/sign.js');

/* `boot.js` 的端口顺延循环不接受 0（`listen(0)` 返回的 0 是假值，会被当成「被占」继续 listen
 * 同一个 server → ERR_SERVER_ALREADY_LISTEN）。所以先借一个空闲端口再还回去，然后起真服务。 */
const tmpSrv = http.createServer();
await new Promise((r) => tmpSrv.listen(0, '127.0.0.1', r));
const API_PORT_FOR_TEST = tmpSrv.address().port;
await new Promise((r) => tmpSrv.close(r));

const api = await startApiServer({ port: API_PORT_FOR_TEST, writeDiscovery: false });
const BASE = `http://127.0.0.1:${api.port}`;

/* ------------------------------ 工具 ------------------------------ */

async function getText(url) {
  const res = await fetch(url);
  return { status: res.status, text: await res.text(), headers: res.headers };
}
async function getJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}
/** 带 api_key 调受保护的路由（设置页那条走的是主 key，不是签名）。
 *  带 `x-freepower-client: ui` 走界面档位（60/s）—— 标准档位 1/s，连续几条设置断言会自己把自己挡住。 */
async function postApi(pathname, body) {
  return getJson(`${BASE}${pathname}?api_key=${encodeURIComponent(api.apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-freepower-client': 'ui' },
    body: JSON.stringify(body ?? {}),
  });
}
async function getApi(pathname) {
  return getJson(`${BASE}${pathname}?api_key=${encodeURIComponent(api.apiKey)}`, {
    headers: { 'x-freepower-client': 'ui' },
  });
}
/** 起始页地址：用真服务的端口（与产品拼出来的形状一致） */
function urlFor(id, { sig, port } = {}) {
  const s = sig === undefined ? signStart(id) : sig;
  return `${BASE}/start?id=${encodeURIComponent(id)}&sig=${encodeURIComponent(s)}`;
}
function newProfile(over = {}) {
  const created = profiles.createProfile({
    name: over.name || `start-${Date.now()}`,
    group_id: '0',
    ...over,
  });
  if (!created.profile_id) throw new Error(`建环境失败：${fmt(created)}`);
  return created.profile_id;
}

try {
  /* ==========================================================================
   * 1) 签名
   * ======================================================================== */
  console.log('\n=== 1) 签名：没有 api_key 也能读，但只认绑对这个环境的未过期签名 ===');
  const idA = newProfile({
    name: '起始页-甲',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    kernel_version: '157.0.8103.78',
    ip: FAKE_IP, ip_country: 'JP', ip_city: 'Tokyo',
    user_proxy_config: { proxy_type: 'socks5', host: '127.0.0.1', port: 1080 },
  });
  {
    const okRes = await getText(urlFor(idA));
    check('1. 带正确签名 → 200 且是 HTML', okRes.status === 200 && /^<!doctype html>/i.test(okRes.text), `${okRes.status}`);

    const noSig = await getText(`${BASE}/start?id=${encodeURIComponent(idA)}`);
    check('1. 不带签名 → 403（不许裸读）', noSig.status === 403, `${noSig.status}`);

    const otherId = newProfile({ name: '起始页-乙' });
    const cross = await getText(urlFor(otherId, { sig: signStart(idA) }));
    check('1. 拿甲环境的签名去读乙环境 → 403（签名绑 id）', cross.status === 403, `${cross.status}`);

    const tampered = await getText(urlFor(idA, { sig: `${signStart(idA).slice(0, -2)}xx` }));
    check('1. 签名改两位 → 403', tampered.status === 403, `${tampered.status}`);

    // 过期：`signStart` 的最小 TTL 是 1 秒（不许签出一个「立刻过期」的票），所以签完等它过期
    const shortSig = signStart(idA, { ttlMs: 1000 });
    await sleep(1200);
    const expired = await getText(urlFor(idA, { sig: shortSig }));
    check('1. 过期签名 → 403', expired.status === 403, `${expired.status}`);

    const noProfile = await getText(urlFor('no-such-profile-id'));
    check('1. 环境不存在 → 404（不 500）', noProfile.status === 404, `${noProfile.status}`);
  }

  /* ==========================================================================
   * 2) 内容：一屏能看出「我在哪个环境、走的哪个代理、出口该是哪」
   * ======================================================================== */
  console.log('\n=== 2) 内容：环境名 / 代理 / 期望出口 / 内核 / UA ===');
  const html = (await getText(urlFor(idA))).text;
  {
    check('2. 页面标题与环境名都在', html.includes('起始页-甲') && html.includes('FreePower 起始页'), '');
    check('2. 代理 host:port 在页面上（127.0.0.1:1080）', html.includes('socks5://127.0.0.1:1080'), '');
    check('2. 期望出口（导入时带的 ip/国家/城市）在页面上',
      html.includes(FAKE_IP) && html.includes('JP') && html.includes('Tokyo'), '');
    check('2. 内核版本在页面上', html.includes('157.0.8103.78'), '');
    check('2. UA 在页面上（用户存的那份，不是内核真值）', html.includes('Chrome/133.0.0.0'), '');
    check('2. 不是空白页：正文有实际内容（>1500 字节）', html.length > 1500, `${html.length} 字节`);
    check('2. 页面上没有 about:blank 这种「空白」痕迹', !html.includes('about:blank'), '');
  }

  /* ==========================================================================
   * 3) 页面自己不许发外连请求（静态 + 响应头两道）
   * ======================================================================== */
  console.log('\n=== 3) 页面自己不发外连：静态扫描 + CSP ===');
  {
    const inlineScript = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
    check('3. 没有外链 <script src>', !/<script[^>]+src=/i.test(html), '');
    check('3. 没有 <link> / <img> / <iframe> 外部资源', !/<link\b|<img\b|<iframe\b/i.test(html), '');
    check('3. 内联脚本里没有任何绝对 URL（http:// / https://）',
      !/https?:\/\//i.test(inlineScript), '');
    check('3. 内联脚本里没有 XMLHttpRequest / sendBeacon / WebSocket',
      !/XMLHttpRequest|sendBeacon|WebSocket/i.test(inlineScript), '');
    check('3. 内联脚本只 fetch 同源的 /start/data',
      inlineScript.includes("'/start/data?id='") && !/fetch\(\s*['"]https?:/i.test(inlineScript), '');
    const h = await fetch(urlFor(idA));
    const csp = String(h.headers.get('content-security-policy') || '');
    check('3. 响应头带 CSP：default-src none + connect-src self',
      /default-src 'none'/.test(csp) && /connect-src 'self'/.test(csp), csp.slice(0, 120));
    check('3. 响应头 no-store（起始页不进缓存）',
      String(h.headers.get('cache-control') || '').includes('no-store'), '');
  }

  /* ==========================================================================
   * 4) 探测在服务进程里做：直连 / 代理 / 代理不通
   * ======================================================================== */
  console.log('\n=== 4) 实测出口：服务进程探测（直连 / 代理 / 代理不通） ===');
  {
    resetStartProbeCache();
    const idDirect = newProfile({ name: '直连环境' });
    const before = exitHits.length;
    const d = await getJson(`${BASE}/start/data?id=${encodeURIComponent(idDirect)}&sig=${encodeURIComponent(signStart(idDirect))}`);
    check('4. 直连环境：code=0 且 probe.ok', d.status === 200 && d.json?.code === 0 && d.json?.data?.probe?.ok === true,
      fmt({ status: d.status, code: d.json?.code, ok: d.json?.data?.probe?.ok, err: d.json?.data?.probe?.error }));
    check('4. 直连：实测 IP = 假出口接口给的值', d.json?.data?.probe?.ip === FAKE_IP, fmt(d.json?.data?.probe?.ip));
    check('4. 直连：via=direct、带时间戳', d.json?.data?.probe?.via === 'direct' && Boolean(d.json?.data?.probe?.at), fmt(d.json?.data?.probe?.at));
    check('4. 直连：探测真的打到了出口接口（服务进程发的）', exitHits.length > before, `${exitHits.length - before} 次`);

    // 代理那条路：假 SOCKS5（**要求用户名密码**）→ 出口读数同样来自假出口接口，但 via=proxy，
    // 且上游侧能读到「真的送来了环境里的账号密码」（不是空跑）
    const up = await startFakeSocks5({ requireAuth: [PROXY_USER, PROXY_PASS] });
    try {
      const idProxy = newProfile({
        name: '代理环境',
        user_proxy_config: { proxy_type: 'socks5', host: '127.0.0.1', port: up.port, username: PROXY_USER, password: PROXY_PASS },
      });
      resetStartProbeCache();
      const p = await getJson(`${BASE}/start/data?id=${encodeURIComponent(idProxy)}&sig=${encodeURIComponent(signStart(idProxy))}`);
      check('4. 带凭据代理：probe.ok 且 via=proxy',
        p.json?.data?.probe?.ok === true && p.json?.data?.probe?.via === 'proxy',
        fmt({ ok: p.json?.data?.probe?.ok, via: p.json?.data?.probe?.via, err: p.json?.data?.probe?.error }));
      check('4. 带凭据代理：实测 IP = 假出口接口给的值', p.json?.data?.probe?.ip === FAKE_IP, fmt(p.json?.data?.probe?.ip));
      check('4. 带凭据代理：上游收到了账号密码（凭据真的送到了代理）',
        up.authSeen.length >= 1 && up.authSeen.every((a) => a.username === PROXY_USER && a.password === PROXY_PASS),
        `${up.authSeen.length} 次认证`);

      const html2 = (await getText(urlFor(idProxy))).text;
      check('4. 带凭据代理：页面写「带用户名密码」但**不写**账号密码',
        html2.includes('带用户名密码') && !html2.includes(PROXY_USER) && !html2.includes(PROXY_PASS), '');
      check('4. 带凭据代理：/start/data 的 JSON 里也没有账号密码',
        !JSON.stringify(p.json).includes(PROXY_USER) && !JSON.stringify(p.json).includes(PROXY_PASS), '');

      // 缓存：同一环境连打两次，上游只多一次认证；force=1 才会重探
      const authAfterFirst = up.authSeen.length;
      await getJson(`${BASE}/start/data?id=${encodeURIComponent(idProxy)}&sig=${encodeURIComponent(signStart(idProxy))}`);
      check('4. 15 秒内重复请求走缓存（上游认证次数不再增长）', up.authSeen.length === authAfterFirst,
        `${authAfterFirst} → ${up.authSeen.length}`);
      await getJson(`${BASE}/start/data?id=${encodeURIComponent(idProxy)}&sig=${encodeURIComponent(signStart(idProxy))}&force=1`);
      check('4. force=1 绕过缓存（上游认证次数增长）', up.authSeen.length > authAfterFirst,
        `${authAfterFirst} → ${up.authSeen.length}`);
    } finally {
      await up.close().catch(() => {});
    }

    // 代理不通：页面必须写明「代理未连通」+ 原因，不许空白
    resetStartProbeCache();
    const idDead = newProfile({
      name: '代理挂了的环境',
      user_proxy_config: { proxy_type: 'socks5', host: '127.0.0.1', port: 9 },
    });
    const dead = await getJson(`${BASE}/start/data?id=${encodeURIComponent(idDead)}&sig=${encodeURIComponent(signStart(idDead))}`);
    check('4. 代理不通：probe.ok=false 且带 error', dead.json?.data?.probe?.ok === false && Boolean(dead.json?.data?.probe?.error),
      fmt({ ok: dead.json?.data?.probe?.ok, err: dead.json?.data?.probe?.error }));
    const deadHtml = page.renderStartHtml(profiles.getProfile(idDead), { probe: dead.json.data.probe });
    check('4. 代理不通：页面写「代理未连通」', deadHtml.includes('代理未连通'), '');
    check('4. 代理不通：页面写出代理 host:port（用户一眼看出是哪条代理）', deadHtml.includes('127.0.0.1:9'), '');
    check('4. 代理不通：页面写出失败原因（不是一句「失败」）',
      Boolean(dead.json?.data?.probe?.error) && deadHtml.includes(String(dead.json.data.probe.error).slice(0, 20)),
      fmt(String(dead.json?.data?.probe?.error).slice(0, 80)));
    check('4. 代理不通：页面正文仍有内容（不是空白页）', deadHtml.length > 1500, `${deadHtml.length} 字节`);
  }

  /* ==========================================================================
   * 5) 设置：总是打开起始页（默认关）
   * ======================================================================== */
  console.log('\n=== 5) 设置项：always_start_page（默认关） ===');
  {
    const s1 = await getApi('/api/v2/settings');
    check('5. 默认 always_start_page=false 且 saved=false（没存过）',
      s1.json?.data?.always_start_page === false && s1.json?.data?.always_start_page_saved === false,
      fmt({ v: s1.json?.data?.always_start_page, saved: s1.json?.data?.always_start_page_saved }));

    const on = await postApi('/api/v2/settings/always-start-page', { enabled: true });
    check('5. 打开开关：changed=true', on.json?.data?.enabled === true && on.json?.data?.changed === true, fmt(on.json?.data));
    const s2 = await getApi('/api/v2/settings');
    check('5. 回读是开', s2.json?.data?.always_start_page === true, fmt(s2.json?.data?.always_start_page));

    const bad = await postApi('/api/v2/settings/always-start-page', { enabled: 'maybe' });
    check('5. 非布尔值 → 100002 + field=enabled（不猜意图）',
      bad.json?.code === 100002 && bad.json?.data?.field === 'enabled', fmt(bad.json));

    await postApi('/api/v2/settings/always-start-page', { enabled: false });
    const s3 = await getApi('/api/v2/settings');
    check('5. 关回去：回读是关', s3.json?.data?.always_start_page === false, fmt(s3.json?.data?.always_start_page));
  }

  /* ==========================================================================
   * 5b) 设置页真有这一格（不能只有路由、界面里找不到）
   * ======================================================================== */
  console.log('\n=== 5b) 设置页接线（静态） ===');
  {
    const web = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
    const apiSrc = web('web/api.js');
    const setSrc = web('web/pages/settings.js');
    check('5b. 界面 API：setAlwaysStartPage 打到 /api/v2/settings/always-start-page',
      /setAlwaysStartPage: \(enabled\) => call\('\/api\/v2\/settings\/always-start-page'/.test(apiSrc), '');
    check('5b. 设置页有这一格，且勾选框接的是 setAlwaysStartPage',
      /paintStartPage\(/.test(setSrc) && /await api\.setAlwaysStartPage\(want\)/.test(setSrc), '');
    check('5b. 设置页读的是接口回的三字段（不自己猜默认值）',
      /always_start_page === true/.test(setSrc) && /always_start_page_saved/.test(setSrc)
      && /always_start_page_broken/.test(setSrc), '');
    // 只看新增的这一段（JSDoc 注释里的 /** 会误伤，所以按块截取）
    const seg = setSrc.slice(setSrc.indexOf('3d. 启动'), setSrc.indexOf('4. 本地 API'));
    check('5b. 文案里没有 Markdown 记号（设置页文案规矩）', seg.length > 200 && !/\*\*/.test(seg), `${seg.length} 字节`);
    check('5b. 文案写明默认关', /默认是关/.test(setSrc) || /当前：关（默认）/.test(setSrc), '');
  }

  /* ==========================================================================
   * 6) 起始页地址的形状（内核要用的那个 URL）
   * ======================================================================== */
  console.log('\n=== 6) 起始页 URL 形状 ===');
  {
    const u = page.startPageUrl(idA, { port: 53380 });
    const parsed = new URL(u);
    check('6. host 是起始页专用假域名（不是 127.0.0.1）', parsed.hostname === page.START_HOST, parsed.hostname);
    check('6. 端口就是服务真在听的端口', parsed.port === '53380', parsed.port);
    check('6. 带 id 与 sig 两个参数', Boolean(parsed.searchParams.get('id')) && Boolean(parsed.searchParams.get('sig')), '');
    check('6. 用 .test 保留域（公网解析不到）', parsed.hostname.endsWith('.test'), parsed.hostname);
  }
  /* ==========================================================================
   * 7) 与窗口同步的相互作用（起始页是「我们自己的 UI」，不能被当成业务页）
   * ======================================================================== */
  console.log('\n=== 7) 起始页 vs 窗口同步（静态 + 纯函数） ===');
  {
    const host = await import('../src/start/host.js');
    const { planUnify } = await import('../src/sync/tabs.js');
    check('7. isStartPageUrl 认起始页（带端口/不带端口都算）',
      host.isStartPageUrl(`http://${host.START_HOST}:53380/start?id=x&sig=y`)
      && host.isStartPageUrl(`http://${host.START_HOST}/start?id=x`), '');
    check('7. isStartPageUrl 不误伤业务页（同名路径也不行）',
      !host.isStartPageUrl('https://start.freepower.test/start')
      && !host.isStartPageUrl('http://127.0.0.1:53380/start?id=x')
      && !host.isStartPageUrl('https://example.com/start'), '');

    // 同步「挑一张真页面」的两个入口都要跳过起始页，否则点了没反应（smoke 实测 7 条红）
    const syncSrc = fs.readFileSync(path.join(ROOT, 'src/sync/session.js'), 'utf8');
    const showSrc = fs.readFileSync(path.join(ROOT, 'src/sync/batch-show.js'), 'utf8');
    check('7. 同步选页跳过起始页（session.js）',
      /isStartPageUrl\(t\.url\)/.test(syncSrc) && /import \{ isStartPageUrl \}/.test(syncSrc), '');
    check('7. 批量显示选页跳过起始页（batch-show.js）',
      /isStartPageUrl\(t\.url\)/.test(showSrc) && /import \{ isStartPageUrl \}/.test(showSrc), '');

    // 两边各自一张起始页（id/签名/端口都不同）→ 不许互相导航（会显示 403 的起始页）
    const a = `http://${host.START_HOST}:53380/start?id=aaa&sig=1`;
    const b = `http://${host.START_HOST}:53380/start?id=bbb&sig=2`;
    const plan = planUnify([a, 'https://example.com/x'], [b, 'https://example.com/x']);
    check('7. 标签统一时两边都是起始页 → 不导航（各自保留自己那张）',
      plan.navigate.length === 0 && plan.open.length === 0 && plan.close.length === 0, fmt(plan));
    const plan2 = planUnify([a, 'https://example.com/y'], [b, 'https://example.com/x']);
    check('7. 但业务页不同照旧导航（起始页那条跳过不影响别的序号）',
      plan2.navigate.length === 1 && plan2.navigate[0].index === 1 && plan2.navigate[0].url === 'https://example.com/y',
      fmt(plan2.navigate));
    // 不对称：主窗口有起始页、受控窗口没有（用户手动关掉了）→ 不许把受控窗口那张业务页导航成起始页（会 403）
    const plan3 = planUnify([a, 'https://example.com/x'], ['https://example.com/x']);
    check('7. 只有一边是起始页 → 也不导航（不把业务页换成别人的起始页）',
      plan3.navigate.length === 0, fmt(plan3.navigate));
  }
} catch (e) {
  console.log('异常：', e && e.stack ? e.stack.split('\n').slice(0, 8).join(' | ') : e);
  check('整体跑通（无异常）', false, String(e && e.message));
} finally {
  try { await api.close(); } catch { /* ignore */ }
  try { exitSrv.closeAllConnections?.(); } catch { /* ignore */ }
  try { exitSrv.close(); } catch { /* ignore */ }
  await sleep(200);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
}

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
