/**
 * 起始页（0.4.7.3）—— **B 层判据：真内核**。
 *
 * 要证明的四件事（CEO 派工的 红①~红④ + 静态）：
 *   红① 代理不通 + `open_urls` 空 → 启动后第一张是起始页（不是 about:blank、不是 chrome-error），
 *       页面上写着「代理未连通」与代理 host:port；
 *   红② 代理通（**带账号密码** → 顺便走 0.4.7.3 的本地中继）+ `open_urls` 空 → 起始页显示实测出口 IP，
 *       且等于 `profile.ip`（导入时带的期望出口）；
 *   红③ `open_urls` 有值 + 开关关 → 行为与 0.4.7.2 逐字节一致（只有那一张，没有起始页）；
 *   红④ 代理全挂（指向一个不存在的端口）时起始页**仍然能打开**（真内核，靠 bypass 名单）；
 *   静态 起始页这条路上**不许起内核**（页面只是被打开，不自己 launch），
 *       且 bypass 名单里没有 127.0.0.1（fail-closed 不许为了起始页丢）。
 *
 * 全部一次性数据根；不碰用户真实库；出口探测指向本机假接口。
 * 跑法：npm run test:start-page-kernel
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

const FAKE_IP = '203.0.113.66';
const PROXY_USER = 'kp-user-3a';
const PROXY_PASS = 'kp-pass-88d1';

/* ------------------------------ 本机目标 + 假出口 ------------------------------ */

const hits = [];
let PORT = 0;
const srv = http.createServer((req, res) => {
  const p = String(req.url || '/').split('?')[0];
  hits.push(p);
  if (p === '/exit') {
    const body = JSON.stringify({
      status: 'success', country: 'Japan', countryCode: 'JP', regionName: 'Tokyo',
      city: 'Tokyo', timezone: 'Asia/Tokyo', isp: 'Start Lab', query: FAKE_IP,
    });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  if (p === '/page.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>START-TARGET-PAGE</body></html>');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('no');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
PORT = srv.address().port;

/* ------------------------------ 一次性数据根 ------------------------------ */

const DATA = path.join(ROOT, '.tmp', `startpage-k-${process.pid}-${Date.now()}`);
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.FREEPOWER_DATA = DATA;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = `http://127.0.0.1:${PORT}/exit`;
process.env.FREEPOWER_PROXY_TIMEOUT = '3000';
process.env.FREEPOWER_EGRESS_TIMEOUT = '3000';
process.env.FREEPOWER_UA_AUTOALIGN = '0';

const { startFakeSocks5 } = await import('./fake-socks5.mjs');
const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');
const prefs = await import('../src/settings/prefs.js');
const { startPageHostPort } = await import('./start-page-helpers.mjs');

/* ------------------------------ 工具 ------------------------------ */

/** 起一次本地 API（起始页由它出；内核要连这个端口） */
const api = await startPageHostPort();

function newProfile(over = {}) {
  const created = profiles.createProfile({ name: `sp-${Date.now()}`, group_id: '0', ...over });
  if (!created.profile_id) throw new Error(`建环境失败：${fmt(created)}`);
  return created.profile_id;
}

/** 当前所有 page target 的 url（去掉我们自己建的探测页不算，那个会自己关） */
async function pageTargets(inst) {
  const r = await inst.client.send('Target.getTargets');
  return (r.targetInfos || []).filter((t) => t.type === 'page');
}

/**
 * 在页面里读它**自己渲染出来的**读数。
 * 注意：这里读的是 DOM 文本，也就是用户眼睛看到的东西 —— 起始页的出口读数由服务进程探好后
 * 由页面自己的脚本填进来，所以这个读法就是「页面看到了什么」。
 */
async function readStartPage(inst, targetId, { timeoutMs = 25000 } = {}) {
  const { sessionId } = await inst.client.send('Target.attachToTarget', { targetId, flatten: true });
  const deadline = Date.now() + timeoutMs;
  let snap = null;
  try {
    while (Date.now() < deadline) {
      const r = await inst.client.send('Runtime.evaluate', {
        expression: `JSON.stringify({
          href: location.href,
          title: document.title,
          ready: document.readyState,
          status: (document.getElementById('status-tag') || {}).textContent || '',
          detail: (document.getElementById('status-detail') || {}).textContent || '',
          proxy: (document.getElementById('proxy') || {}).textContent || '',
          expected: (document.getElementById('expected') || {}).textContent || '',
          ip: (document.getElementById('probe-ip') || {}).textContent || '',
          meta: (document.getElementById('probe-meta') || {}).textContent || '',
          at: (document.getElementById('probe-at') || {}).textContent || '',
          body: (document.body ? (document.body.textContent || document.body.innerText) : '').slice(0, 300),
        })`,
        returnByValue: true,
      }, sessionId).catch(() => null);
      try { snap = JSON.parse(String(r?.result?.value || 'null') || 'null'); } catch { snap = null; }
      if (snap && snap.ready === 'complete' && snap.ip && snap.ip !== '检测中…') break;
      await sleep(200);
    }
  } finally {
    await inst.client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
  return snap || {};
}

/* ------------------------------ 用例 ------------------------------ */

try {
  /* ==========================================================================
   * 红① + 红④：代理全挂（端口 9 没人听）→ 起始页仍能打开，并写明「代理未连通」
   * ======================================================================== */
  console.log('\n=== 红①/红④ 代理全挂：起始页照样能打开、写明原因 ===');
  const deadId = newProfile({
    name: '代理全挂-起始页',
    open_urls: [],
    // 跳过预检才能让「代理挂着的内核」真的起来 —— 这正是用户当时的处境（预检绿、浏览器死）
    bypass_proxy_check: '1',
    user_proxy_config: { proxy_type: 'socks5', host: '127.0.0.1', port: 9 },
  });
  {
    const started = await manager.startProfile(profiles.getProfile(deadId));
    const inst = manager.getInstance(deadId);
    try {
      check('红① 环境起来了（预检被跳过，内核真在跑）', Boolean(started.real_version) && Boolean(inst), fmt(started.real_version));

      const pages = await pageTargets(inst);
      const startPage = pages.find((t) => String(t.url).startsWith('http://start.freepower.test:'));
      check('红① 第一张是起始页（不是 about:blank）',
        Boolean(startPage) && !pages.some((t) => !t.url || t.url === 'about:blank'),
        fmt(pages.map((t) => t.url.slice(0, 60))));
      check('红① 也不是 chrome-error（不是把错误页当起始页）',
        !pages.some((t) => String(t.url).startsWith('chrome-error://')), fmt(pages.map((t) => t.url.slice(0, 40))));
      check('红① 起始页只有一张（open_urls 为空，不多开）', pages.length === 1, `${pages.length} 张`);

      const snap = await readStartPage(inst, startPage.targetId);
      check('红① 起始页加载完成且正文非空', snap.ready === 'complete' && String(snap.body || '').length > 40, fmt(String(snap.body || '').slice(0, 60)));
      check('红④ 代理全挂时起始页**仍然能打开**（靠 bypass 名单，真内核）',
        String(snap.href || '').startsWith('http://start.freepower.test:'), fmt(snap.href));
      check('红① 页面上写「代理未连通」', String(snap.status).includes('代理未连通'), fmt(snap.status));
      check('红① 页面上写出代理 host:port（一眼看出是哪条代理）', String(snap.proxy).includes('127.0.0.1:9'), fmt(snap.proxy));
      check('红① 页面上写出失败原因（不是一句「失败」）', String(snap.detail || '').length > 10, fmt(String(snap.detail).slice(0, 80)));
      check('红① 页面上有环境名与内核版本', String(snap.title).includes('代理全挂-起始页') && String(snap.body).length > 0, fmt(snap.title));

      // fail-closed 没被起始页这件事顺手弄丢
      const src = fs.readFileSync(path.join(ROOT, 'src', 'kernel', 'chrome.js'), 'utf8');
      check('静态 bypass 名单里没有 127.0.0.1 / localhost（loopback 仍走代理）',
        !/proxy-bypass-list=[^'"`]*127\.0\.0\.1/.test(src) && !/proxy-bypass-list=[^'"`]*localhost/.test(src), '');
      check('静态 bypass 名单里保留了 <-loopback>', src.includes('<-loopback>;'), '');
      check('静态 起始页假域名在 bypass 名单里', src.includes('START_BYPASS_ENTRY'), '');
      check('静态 假域名被钉到回环（host-resolver-rules）',
        src.includes('START_RESOLVER_RULE') && fs.readFileSync(path.join(ROOT, 'src', 'start', 'host.js'), 'utf8').includes('MAP ${START_HOST} 127.0.0.1'), '');
    } finally {
      await manager.stopProfile(deadId).catch(() => {});
    }
  }

  /* ==========================================================================
   * 红②：代理通（带账号密码 → 走中继）+ open_urls 空 → 起始页显示实测出口 = profile.ip
   * ======================================================================== */
  console.log('\n=== 红② 代理通：起始页显示实测出口 IP（= 导入时记的期望出口） ===');
  {
    const up = await startFakeSocks5({ requireAuth: [PROXY_USER, PROXY_PASS] });
    const okId = newProfile({
      name: '代理可用-起始页',
      open_urls: [],
      ip: FAKE_IP, ip_country: 'JP', ip_city: 'Tokyo',
      user_proxy_config: { proxy_type: 'socks5', host: '127.0.0.1', port: up.port, username: PROXY_USER, password: PROXY_PASS },
    });
    try {
      const started = await manager.startProfile(profiles.getProfile(okId));
      const inst = manager.getInstance(okId);
      check('红② 环境起来了，且走的是本地中继', Boolean(started.real_version) && inst?.chain_mode === 'relay',
        fmt({ v: started.real_version, mode: inst?.chain_mode }));

      const pages = await pageTargets(inst);
      const startPage = pages.find((t) => String(t.url).startsWith('http://start.freepower.test:'));
      check('红② open_urls 为空 → 起始页是唯一一张', Boolean(startPage) && pages.length === 1, `${pages.length} 张`);

      const snap = await readStartPage(inst, startPage.targetId);
      check('红② 页面状态是「代理已连通」', String(snap.status).includes('代理已连通'), fmt(snap.status));
      check('红② 页面显示实测出口 IP = 假代理那侧的值', String(snap.ip).trim() === FAKE_IP, fmt(snap.ip));
      check('红② 实测出口 = profile.ip（期望出口与实测一致）',
        String(snap.ip).trim() === FAKE_IP && String(snap.expected).includes(FAKE_IP), fmt({ ip: snap.ip, expected: snap.expected }));
      check('红② 页面上有探测时间（不是「检测中」）', /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(String(snap.at)), fmt(snap.at));
      check('红② 页面上没有账号密码', !String(snap.body).includes(PROXY_USER) && !String(snap.body).includes(PROXY_PASS), '');
      check('红② 上游确实收到了环境里的账号密码（中继真在转发）',
        up.authSeen.length >= 1 && up.authSeen.every((a) => a.username === PROXY_USER && a.password === PROXY_PASS),
        `${up.authSeen.length} 次认证`);
    } finally {
      await manager.stopProfile(okId).catch(() => {});
      await up.close().catch(() => {});
    }
  }

  /* ==========================================================================
   * 红③：open_urls 有值 + 开关关 → 与 0.4.7.2 逐字节一致（只有那一张）
   * ======================================================================== */
  console.log('\n=== 红③ 有启动网址 + 开关关 → 不多开起始页（行为不变） ===');
  {
    prefs.writeAlwaysStartPage(false);
    const urlId = newProfile({ name: '有启动网址', open_urls: [`http://127.0.0.1:${PORT}/page.html`] });
    try {
      const started = await manager.startProfile(profiles.getProfile(urlId));
      const inst = manager.getInstance(urlId);
      check('红③ 环境起来了', Boolean(started.real_version), fmt(started.real_version));
      const pages = await pageTargets(inst);
      check('红③ 只有一张页面（不多开起始页）', pages.length === 1, `${pages.length} 张`);
      check('红③ 那张就是 open_urls[0]', pages.length === 1 && String(pages[0].url).includes('/page.html'), fmt(pages[0]?.url));
      check('红③ 没有任何起始页 target', !pages.some((t) => String(t.url).includes('start.freepower.test')), '');
      check('红③ 目标页面真的加载了（正文有 START-TARGET-PAGE）',
        hits.filter((h) => h === '/page.html').length >= 1, `${hits.filter((h) => h === '/page.html').length} 次`);
    } finally {
      await manager.stopProfile(urlId).catch(() => {});
    }
  }

  /* ==========================================================================
   * 开关开 + open_urls 有值 → 第一张起始页 + 网址照常开
   * ======================================================================== */
  console.log('\n=== 开关开：第一张起始页 + 启动网址照常开 ===');
  {
    prefs.writeAlwaysStartPage(true);
    const bothId = newProfile({ name: '开关开', open_urls: [`http://127.0.0.1:${PORT}/page.html`] });
    try {
      const started = await manager.startProfile(profiles.getProfile(bothId));
      const inst = manager.getInstance(bothId);
      const pages = await pageTargets(inst);
      check('开关开 起始页与启动网址都在（2 张）', pages.length === 2, fmt(pages.map((t) => t.url.slice(0, 50))));
      check('开关开 其中一张是起始页', pages.some((t) => String(t.url).includes('start.freepower.test')), '');
      check('开关开 其中一张是 open_urls[0]', pages.some((t) => String(t.url).includes('/page.html')), '');
      // 「第一张」= 启动时那张空白页被导航成起始页；CDP 的 target 列表是哈希序，量不到标签栏顺序，
      // 所以顺序由下面这条静态判据钉住（tabs[0] 必须是起始页）。
      const src = fs.readFileSync(path.join(ROOT, 'src', 'runtime', 'manager.js'), 'utf8');
      check('静态 起始页排在第一个（tabs = [startUrl, ...urls]）',
        src.includes('const tabs = startUrl ? [startUrl, ...urls] : urls.slice();'), '');
      check('静态 firstUrl 取 tabs[0]（起始页真的占第一张）',
        src.includes('const firstUrl = tabs[0]'), '');
    } finally {
      await manager.stopProfile(bothId).catch(() => {});
      prefs.writeAlwaysStartPage(false);
    }
  }

  /* ==========================================================================
   * 静态：起始页这条路上不许起内核；探测只在服务进程里
   * ======================================================================== */
  console.log('\n=== 静态：起始页不自己起内核、探测只在服务进程 ===');
  {
    const pageSrc = fs.readFileSync(path.join(ROOT, 'src', 'start', 'page.js'), 'utf8');
    const probeSrc = fs.readFileSync(path.join(ROOT, 'src', 'start', 'probe.js'), 'utf8');
    check('静态 src/start/page.js 不引用 manager / startProfile / launchChrome',
      !/runtime\/manager|startProfile|launchChrome/.test(pageSrc), '');
    check('静态 src/start/probe.js 不引用浏览器内探测（probeEgressInBrowser / egress.js）',
      !/probeEgressInBrowser|proxy\/egress/.test(probeSrc), '');
    check('静态 探测用的是与预检同一份实现（proxy/probe.js 的 checkProxy）',
      /from '\.\.\/proxy\/probe\.js'/.test(probeSrc) && probeSrc.includes('checkProxy('), '');
    check('静态 起始页 HTML 里没有外部资源（page.js 里没有 http(s):// 常量拼进页面）',
      !/https?:\/\//.test(pageSrc.split('export function renderStartHtml')[1] || ''), '');
  }
} catch (e) {
  console.log('异常：', e && e.stack ? e.stack.split('\n').slice(0, 8).join(' | ') : e);
  check('整体跑通（无异常）', false, String(e && e.message));
} finally {
  try { await manager.stopAll(); } catch { /* ignore */ }
  try { await api.close(); } catch { /* ignore */ }
  try { srv.closeAllConnections?.(); } catch { /* ignore */ }
  try { srv.close(); } catch { /* ignore */ }
  await sleep(300);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
}

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
