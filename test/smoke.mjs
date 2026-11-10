/**
 * FreePower 冒烟（P1 + P3 前置）
 *
 *  P1：并发 3 环境、cookie 隔离、幂等、契约形状、校验挡启动、无残留进程
 *  P3 前置：
 *   1. 代理预检（活代理 / 坏代理 / 认证失败）
 *   2. fail-closed：坏代理时 start 直接失败，且一个内核进程都不许起
 *   3. 浏览器出口探测：代理环境的流量真的走了代理（连 127.0.0.1 都不许绕过）
 *   4. launch_args 白名单：保护参数被丢、白名单参数真进了命令行
 *   5. UA 跟版：旧版本 UA 在启动时被拉到真实内核版本并落库
 *
 * 跑法：npm run smoke
 * 注意：需要完整权限（沙箱会挡命名管道，Chrome 起不来、powershell 也读不到命令行）。
 */
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { startFakeProxy, startEchoServer } from './fake-proxy.mjs';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listen(server, port) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
}

async function deadPort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
}

/** 读某个 pid 的真实命令行（验证参数真的进了 argv，而不是只在我们自己的响应里） */
function commandLineOf(pid) {
  try {
    return ps(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`);
  } catch (e) {
    return `ps-error: ${e.message}`;
  }
}

/** 找命令行里带某段文字的 chrome 进程（fail-closed 断言「一个都没起」） */
function chromePidsMatching(fragment) {
  try {
    const out = ps(`Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${fragment}*' } | Select-Object -ExpandProperty ProcessId`);
    return out ? out.split(/\s+/).filter(Boolean) : [];
  } catch (e) {
    return [`ps-error: ${e.message}`];
  }
}

async function waitPidGone(pid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    await sleep(150);
  }
  return false;
}

async function main() {
  /* ---------- 本地探测端点（不连公网） ---------- */
  const echo = await startEchoServer({ ip: '198.51.100.20', countryCode: 'US', timezone: 'America/New_York' });
  const fake = await startFakeProxy({ ip: '203.0.113.9', countryCode: 'JP', country: 'Japan', timezone: 'Asia/Tokyo', city: 'Tokyo' });
  const badProxy = await startFakeProxy({ requireAuth: ['u1', 'p1'] });
  const dead = await deadPort();

  // 先改环境变量，再动态 import 应用模块（config 在 import 时读 env）
  process.env.FREEPOWER_EGRESS_PROBE = echo.url;
  process.env.FREEPOWER_PROXY_TIMEOUT = '2500';
  process.env.FREEPOWER_EGRESS_TIMEOUT = '6000';
  process.env.FREEPOWER_UA_AUTOALIGN = '1';

  const { createApiServer } = await import('../src/api/server.js');
  const { CdpClient } = await import('../src/kernel/cdp.js');
  const { stopAll } = await import('../src/runtime/manager.js');
  const { findChrome } = await import('../src/kernel/chrome.js');
  const { getDb } = await import('../src/store/db.js');

  const chrome = findChrome();
  if (!chrome) {
    console.error('没有可用内核，设置 FREEPOWER_CHROME 后重试');
    process.exit(2);
  }
  console.log(`内核：${chrome.version} (${chrome.source}) ${chrome.path}${chrome.guessed_version ? ` / 目录猜测 ${chrome.guessed_version}` : ''}`);
  console.log(`出口探测端点：${echo.url} / 假代理：127.0.0.1:${fake.port} / 死代理端口：${dead}\n`);

  async function evalInPage(wsUrl, expr, { url = null } = {}) {
    const c = await CdpClient.connect(wsUrl);
    try {
      const { targetInfos } = await c.send('Target.getTargets');
      const page = targetInfos.find((t) => t.type === 'page');
      if (!page) return null;
      const { sessionId } = await c.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
      if (url) {
        await c.send('Page.enable', {}, sessionId).catch(() => {});
        await c.send('Page.navigate', { url }, sessionId);
        await sleep(700);
      }
      // 页面可能正在导航（执行上下文被销毁）→ 重试几次，别把竞态当失败
      for (let attempt = 0; attempt < 4; attempt++) {
        const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId).catch(() => null);
        if (r && !r.exceptionDetails) return r.result.value;
        await sleep(250);
      }
      return null;
    } finally {
      c.close();
    }
  }

  const { server, apiKey } = createApiServer();
  const port = await listen(server, 0);
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', api_key: apiKey, 'x-freepower-client': 'mcp' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() };
  };

  const created = [];
  const started = [];
  const extraPids = [];
  try {
    /* ================= 契约基础 ================= */
    const status = await api('GET', '/status');
    check('/status 形状', status.json.code === 0 && status.json.msg === 'success', JSON.stringify(status.json));
    const noauth = await fetch(base + '/api/v2/browser-profile/list');
    check('无 key 被拒（HTTP 401）', noauth.status === 401);

    /* ================= v2 契约 ================= */
    const c2 = await api('POST', '/api/v2/browser-profile/create', {
      name: 'p1-v2', batch_id: '0', country: 'SG',
      launch_args: ['--disable-features=SmokeKeep'],
      password_filling: '1',
    });
    check('v2 建环境成功', c2.json.code === 0, c2.json.msg);
    const p2 = c2.json.data || {};
    created.push(p2.profile_id);
    check('v2 返回 profile_id/profile_no', !!p2.profile_id && typeof p2.profile_no === 'number');
    check('v2 launch_args 出站是数组', Array.isArray(p2.launch_args) && p2.launch_args[0] === '--disable-features=SmokeKeep', JSON.stringify(p2.launch_args));
    check('password_filling 内部单布尔', p2.disable_password_filling === '0', JSON.stringify(p2.disable_password_filling));

    const c2v1 = await api('GET', `/api/v1/user/detail?user_id=${p2.profile_id}`);
    check('v1 出站 launch_args 是 JSON 字符串', typeof c2v1.json.data?.launch_args === 'string', String(c2v1.json.data?.launch_args));

    /* ================= 代理预检 ================= */
    const goodCheck = await api('POST', '/api/v2/proxy/check', { proxy_config: fake.proxy });
    check('代理预检 API：活代理 ok', goodCheck.json.code === 0 && goodCheck.json.data?.ok === true, JSON.stringify(goodCheck.json.data));
    check('代理预检拿到出口 IP', goodCheck.json.data?.ip === '203.0.113.9', String(goodCheck.json.data?.ip));

    const deadCheck = await api('POST', '/api/v2/proxy/check', { proxy_config: { proxy_type: 'http', host: '127.0.0.1', port: dead } });
    check('代理预检 API：死代理 ok:false', deadCheck.json.code === 0 && deadCheck.json.data?.ok === false, String(deadCheck.json.data?.error).slice(0, 80));

    const authCheck = await api('POST', '/api/v2/proxy/check', { proxy_config: { ...badProxy.proxy, username: 'u1', password: 'nope' } });
    check('代理预检 API：密码错被拒', authCheck.json.data?.ok === false, String(authCheck.json.data?.error).slice(0, 80));

    /* ================= fail-closed：坏代理不许起浏览器 ================= */
    const badProxyProfile = await api('POST', '/api/v1/user/create', {
      name: 'p1-badproxy', country: 'US',
      proxy_config: { proxy_type: 'http', host: '127.0.0.1', port: dead },
    });
    const badProxyId = badProxyProfile.json.data?.profile_id;
    created.push(badProxyId);
    const uddBad = `profiles\\${badProxyProfile.json.data?.profile_no}_${String(badProxyId).slice(0, 8)}`;
    const before = chromePidsMatching(uddBad);
    const fc = await api('GET', `/api/v1/browser/start?user_id=${badProxyId}`);
    check('坏代理：start 返回 800003', fc.json.code === 800003, `${fc.json.code} ${fc.json.msg}`);
    check('坏代理：原因是 proxy_unreachable', fc.json.data?.reason === 'proxy_unreachable', String(fc.json.data?.reason));
    check('坏代理：错误里带代理诊断', /连接 |代理不可用/.test(String(fc.json.data?.proxy_check?.error || fc.json.msg)), String(fc.json.data?.proxy_check?.error || '').slice(0, 80));
    const after = chromePidsMatching(uddBad);
    check('坏代理：没有拉起任何内核进程', after.length === 0 && before.length === 0, `before=${before.length} after=${after.length}`);

    /* ================= 3 个环境并发（无代理） ================= */
    const countries = ['US', 'JP', 'SG'];
    const profiles = [];
    for (const country of countries) {
      const r = await api('POST', '/api/v1/user/create', { name: `p1-${country}`, country });
      check(`建环境 ${country}`, r.json.code === 0, r.json.msg || '');
      profiles.push(r.json.data);
      created.push(r.json.data.profile_id);
    }

    const started3 = await Promise.all(profiles.map((p) =>
      api('GET', `/api/v1/browser/start?user_id=${p.profile_id}`)));
    for (const [i, r] of started3.entries()) {
      const d = r.json.data || {};
      check(`启动 ${countries[i]}`, r.json.code === 0, r.json.msg);
      check(`${countries[i]} debug_port 是字符串`, typeof d.debug_port === 'string' && Number(d.debug_port) > 0, String(d.debug_port));
      check(`${countries[i]} ws.puppeteer 是 ws://`, typeof d.ws?.puppeteer === 'string' && d.ws.puppeteer.startsWith('ws://'));
      check(`${countries[i]} ws.selenium 是 host:port`, /^127\.0\.0\.1:\d+$/.test(String(d.ws?.selenium)), String(d.ws?.selenium));
      check(`${countries[i]} webdriver 字段存在`, /^127\.0\.0\.1:\d+$/.test(String(d.webdriver)), String(d.webdriver));
      check(`${countries[i]} 未绑代理有告警`,
        Array.isArray(d.warnings) && d.warnings.some((w) => w.field === 'proxy'), JSON.stringify((d.warnings || []).map((w) => w.field)));
      check(`${countries[i]} 出口探测可用（直连本机端点）`, d.egress?.ok === true && d.egress?.ip === '198.51.100.20', JSON.stringify(d.egress));
      if (d.ws?.puppeteer) started.push({ profile: profiles[i], data: d });
    }
    check('3 个环境都在跑', started.length === 3, String(started.length));

    /* ---------- 幂等 ---------- */
    if (started[0]) {
      const again = await api('GET', `/api/v1/browser/start?user_id=${started[0].profile.profile_id}`);
      check('重复 start 幂等（already_running）', again.json.data?.already_running === true, JSON.stringify(again.json.data?.already_running));
      check('幂等返回同一个 ws', again.json.data?.ws?.puppeteer === started[0].data.ws.puppeteer);
      check('幂等没有新起进程', String(again.json.data?.pid) === String(started[0].data.pid));
    }

    /* ---------- 指纹生效 ---------- */
    const PROBE = `(() => ({
      ua: navigator.userAgent,
      platform: navigator.platform,
      webdriver: navigator.webdriver,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      languages: navigator.languages,
      cores: navigator.hardwareConcurrency,
      memory: navigator.deviceMemory,
      gl: (() => { const g = document.createElement('canvas').getContext('webgl'); return g ? [g.getParameter(37445), g.getParameter(37446)] : null; })(),
      fpApplied: window.__fpApplied || null,
    }))()`;
    const probes = await Promise.all(started.map((s) => evalInPage(s.data.ws.puppeteer, PROBE)));
    // 启动时可能发生 UA 跟版（目录名不是版本真值），所以拿库里的现值来比
    const details = await Promise.all(started.map((s) => api('GET', `/api/v1/user/detail?user_id=${s.profile.profile_id}`)));
    for (const [i, v] of probes.entries()) {
      const live = details[i].json.data || {};
      check(`${countries[i]} 注入已生效`, !!v?.fpApplied, JSON.stringify(v?.fpApplied));
      check(`${countries[i]} UA 一致`, v?.ua === live.ua, String(v?.ua).slice(0, 50));
      check(`${countries[i]} 时区一致`, v?.timezone === live.timezone, `${v?.timezone} vs ${live.timezone}`);
      check(`${countries[i]} webdriver 未暴露`, v?.webdriver === undefined || v?.webdriver === false, String(v?.webdriver));
      check(`${countries[i]} WebGL vendor 一致`, v?.gl?.[0] === live.webgl_config?.unmasked_vendor, String(v?.gl?.[0]));
      check(`${countries[i]} 无内核版本漂移告警`,
        !(started[i].data.warnings || []).some((w) => w.field === 'client_hints.ua_full_version'),
        JSON.stringify((started[i].data.warnings || []).map((w) => w.message)));
    }
    check('3 个环境指纹两两不同', new Set(probes.map((v) => `${v?.ua}|${v?.timezone}|${JSON.stringify(v?.gl)}`)).size === 3);

    /* ---------- cookie 隔离（浏览器级 CDP 读写，不依赖页面状态） ---------- */
    const cookieOrigin = `${base}/`;
    async function setCookie(wsUrl, name, value) {
      const c = await CdpClient.connect(wsUrl);
      try {
        await c.send('Storage.setCookies', { cookies: [{ name, value, url: cookieOrigin, path: '/' }] });
      } finally { c.close(); }
    }
    async function listCookies(wsUrl) {
      const c = await CdpClient.connect(wsUrl);
      try {
        const r = await c.send('Storage.getCookies');
        return (r.cookies || []).map((x) => `${x.name}=${x.value}`);
      } finally { c.close(); }
    }
    for (const [i, s] of started.entries()) {
      await setCookie(s.data.ws.puppeteer, 'fp_isolation', `env${i}`);
      const got = await listCookies(s.data.ws.puppeteer);
      check(`cookie 写入 env${i}`, got.includes(`fp_isolation=env${i}`), got.join(';'));
    }
    for (const [i, s] of started.entries()) {
      const cookie = (await listCookies(s.data.ws.puppeteer)).join(';');
      const others = [0, 1, 2].filter((j) => j !== i).map((j) => `fp_isolation=env${j}`);
      check(`env${i} cookie 只看到自己`, cookie.includes(`fp_isolation=env${i}`) && others.every((o) => !cookie.includes(o)), cookie);
    }

    /* ================= 一致性校验：硬冲突阻断 / force 越过 ================= */
    const bad = await api('POST', '/api/v1/user/create', { name: 'p1-bad', country: 'US' });
    const badId = bad.json.data.profile_id;
    created.push(badId);
    getDb().prepare('UPDATE profiles SET platform = ?, ua = ? WHERE id = ?')
      .run('MacIntel', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', badId);
    const badStart = await api('GET', `/api/v1/browser/start?user_id=${badId}`);
    check('一致性冲突被挡（800005）', badStart.json.code === 800005, `${badStart.json.code} ${badStart.json.msg}`);

    const forced = await api('GET', `/api/v1/browser/start?user_id=${badId}&force=1`);
    check('force=1 越过硬冲突', forced.json.code === 0, `${forced.json.code} ${forced.json.msg}`);
    check('force=1 有显式告警', (forced.json.data?.warnings || []).some((w) => /force=1/.test(w.message)), JSON.stringify((forced.json.data?.warnings || []).map((w) => w.message)));
    if (forced.json.data?.ws?.puppeteer) {
      extraPids.push(Number(forced.json.data.pid));
      await api('GET', `/api/v1/browser/stop?user_id=${badId}`);
    }

    /* ================= 代理环境：流量必须真的走代理 ================= */
    const proxied = await api('POST', '/api/v1/user/create', {
      name: 'p1-proxied', country: 'US',
      proxy_config: fake.proxy,
    });
    const proxiedId = proxied.json.data.profile_id;
    created.push(proxiedId);
    const fakeHitsBefore = fake.requests.length;
    const ps1 = await api('GET', `/api/v1/browser/start?user_id=${proxiedId}`);
    const pd = ps1.json.data || {};
    check('绑代理环境能启动', ps1.json.code === 0, ps1.json.msg);
    check('启动响应带代理预检结果', pd.proxy?.ok === true && pd.proxy?.ip === '203.0.113.9', JSON.stringify(pd.proxy));
    check('浏览器出口 = 代理出口（流量真的走了代理）', pd.egress?.ok === true && pd.egress?.ip === '203.0.113.9', JSON.stringify(pd.egress));
    check('出口时区与声明不一致被告警',
      (pd.warnings || []).some((w) => w.field === 'timezone'), JSON.stringify((pd.warnings || []).map((w) => w.message)));
    const loopbackViaProxy = fake.requests.slice(fakeHitsBefore).filter((r) => String(r.url).includes(`127.0.0.1:${echo.port}`));
    check('连 127.0.0.1 也走代理（没有 loopback bypass）', loopbackViaProxy.length >= 2, `hits=${loopbackViaProxy.length}`);
    if (pd.ws?.puppeteer) {
      extraPids.push(Number(pd.pid));
      const body = String(await evalInPage(pd.ws.puppeteer, 'document.body.innerText', { url: echo.url }));
      let exitIp = '';
      try { exitIp = JSON.parse(body).query; } catch { /* 解析失败下面断言报 */ }
      check('页面内单独验证出口 IP', exitIp === '203.0.113.9', String(exitIp || body.slice(0, 80)));
      await api('GET', `/api/v1/browser/stop?user_id=${proxiedId}`);
      const gone = await waitPidGone(Number(pd.pid));
      check('代理环境停掉后进程退出', gone, String(pd.pid));
    }

    /* ================= launch_args 白名单 ================= */
    const la = await api('POST', '/api/v1/user/create', {
      name: 'p1-launchargs', country: 'US',
      launch_args: JSON.stringify(['--disable-features=SmokeProbe', '--user-data-dir=C:\\evil', '--no-such-flag=1']),
    });
    const laId = la.json.data.profile_id;
    created.push(laId);
    const laStart = await api('GET', `/api/v1/browser/start?user_id=${laId}`);
    const ld = laStart.json.data || {};
    check('带 launch_args 的环境能启动', laStart.json.code === 0, laStart.json.msg);
    check('白名单参数被应用', (ld.launch_args?.applied || []).includes('--disable-features=SmokeProbe'), JSON.stringify(ld.launch_args?.applied));
    check('保护参数 + 名单外参数被拒绝', (ld.launch_args?.rejected || []).length === 2, JSON.stringify(ld.launch_args?.rejected));
    if (ld.pid) {
      extraPids.push(Number(ld.pid));
      const cmd = commandLineOf(Number(ld.pid));
      check('真实命令行含用户特性', cmd.includes('SmokeProbe'), cmd.slice(0, 120));
      check('真实命令行保留系统特性', cmd.includes('Translate'), cmd.slice(0, 120));
      check('真实命令行没有 --user-data-dir=C:\\evil', !cmd.includes('evil'), cmd.slice(0, 120));
      const realUdd = (cmd.match(/--user-data-dir=([^ ]+)/) || [])[1] || '';
      check('真实命令行用的是系统算的目录', realUdd.includes('profiles\\'), realUdd);
      await api('GET', `/api/v1/browser/stop?user_id=${laId}`);
    }

    /* ================= UA 跟版 ================= */
    const uaP = await api('POST', '/api/v1/user/create', { name: 'p1-ua', country: 'US' });
    const uaId = uaP.json.data.profile_id;
    created.push(uaId);
    {
      // 故意写成一个不可能在跑的老版本，确保一定触发跟版（不管本机内核是 156 还是 157）
      const db = getDb();
      const row = db.prepare('SELECT fingerprint_config FROM profiles WHERE id = ?').get(uaId);
      const fp = JSON.parse(row.fingerprint_config);
      fp.client_hints = { ...(fp.client_hints || {}), ua_full_version: '150.0.7000.1' };
      db.prepare('UPDATE profiles SET ua = ?, kernel_version = ?, fingerprint_config = ? WHERE id = ?')
        .run('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
          '150.0.7000.1', JSON.stringify(fp), uaId);
    }
    const uaStart = await api('GET', `/api/v1/browser/start?user_id=${uaId}`);
    const ud = uaStart.json.data || {};
    check('旧版本环境能启动', uaStart.json.code === 0, uaStart.json.msg);
    check('启动时自动跟版（对齐真实内核）', ud.ua_aligned?.to === ud.real_version, `${JSON.stringify(ud.ua_aligned?.reasons)} real=${ud.real_version}`);
    const realMajor = String(ud.real_version || '').split('.')[0];
    const uaDetail = await api('GET', `/api/v1/user/detail?user_id=${uaId}`);
    check('跟版后 UA 已落库', String(uaDetail.json.data?.ua).includes(`Chrome/${realMajor}.`), String(uaDetail.json.data?.ua).slice(0, 90));
    check('跟版后 kernel_version 已落库', uaDetail.json.data?.kernel_version === ud.real_version, String(uaDetail.json.data?.kernel_version));
    if (ud.ws?.puppeteer) {
      extraPids.push(Number(ud.pid));
      const agent = String(await evalInPage(ud.ws.puppeteer, 'navigator.userAgent'));
      check('跟版后注入的 UA 是真实内核版本', agent.includes(`Chrome/${realMajor}.`), agent.slice(0, 90));
      await api('GET', `/api/v1/browser/stop?user_id=${uaId}`);
    }

    /* ================= 停止与回收 ================= */
    const pids = started.map((s) => Number(s.data.pid));
    const stops = await Promise.all(started.map((s) => api('GET', `/api/v1/browser/stop?user_id=${s.profile.profile_id}`)));
    check('3 个环境都停掉', stops.every((r) => r.json.code === 0 && r.json.data?.stopped === true));
    const gone = await Promise.all(pids.map((pid) => waitPidGone(pid)));
    check('主进程全部退出', gone.every(Boolean), pids.join(','));
    await sleep(1500);

    const leftovers = chromePidsMatching('freepower').filter((x) => /^\d+$/.test(x));
    check('无残留 chrome 进程', leftovers.length === 0, leftovers.join(',') || 'none');

    const stopAgain = await api('GET', `/api/v1/browser/stop?user_id=${started[0].profile.profile_id}`);
    check('重复 stop 返回 800002', stopAgain.json.code === 800002, String(stopAgain.json.code));

    const active = await api('GET', '/api/v1/browser/active');
    check('active 列表为空', active.json.data?.list?.length === 0, JSON.stringify((active.json.data?.list || []).map((x) => x.profile_id)));
  } catch (e) {
    check('冒烟异常', false, e.stack || e.message);
  } finally {
    await stopAll();
    for (const pid of extraPids) await waitPidGone(pid, 3000);
    for (const id of created) await api('POST', '/api/v1/user/delete', { user_ids: [id] }).catch(() => {});
    server.close();
    await fake.close();
    await badProxy.close();
    await echo.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) console.log('失败项：\n' + failed.map((f) => ` - ${f.name} ${f.detail}`).join('\n'));
  process.exit(failed.length ? 1 : 0);
}

main();