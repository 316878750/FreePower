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

    /* ================= P2：启动后自动自检 ================= */
    for (const [i, s] of started.entries()) {
      const sc = s.data.selfcheck || {};
      check(`${countries[i]} 启动后自动自检`, sc.total === 15 && sc.fail === 0, JSON.stringify(sc));
      check(`${countries[i]} 自检覆盖度对齐字段表 (7/7/1)`, sc.full === 7 && sc.partial === 7 && sc.none === 1, `${sc.full}/${sc.partial}/${sc.none}`);
      check(`${countries[i]} 四个噪点哈希都有`, !!sc.hashes?.canvas && !!sc.hashes?.webgl_image && !!sc.hashes?.audio && !!sc.hashes?.client_rects, JSON.stringify(sc.hashes));
      check(`${countries[i]} 同页两次读取一致`, sc.determinism?.canvas === true && sc.determinism?.webgl_image === true && sc.determinism?.audio === true && sc.determinism?.client_rects === true, JSON.stringify(sc.determinism));
    }

    {
      const first = started[0].profile.profile_id;
      const scj = await api('GET', `/api/v1/browser/selfcheck?user_id=${first}`);
      const report = scj.json.data || {};
      const byId = Object.fromEntries((report.items || []).map((x) => [x.id, x]));
      check('自检 API 返回 15 项报告', scj.json.code === 0 && report.items?.length === 15, scj.json.msg);
      check('字体项覆盖度 none 且标黄', byId.fonts?.coverage === 'none' && byId.fonts?.status === 'warn', JSON.stringify(byId.fonts));
      check('自检注明 CDP 结构性上限', /结构性/.test(String(report.caveat)), String(report.caveat).slice(0, 60));
      check('自检在安全上下文里跑（UA-CH 可验证）', report.context?.secure === true, JSON.stringify(report.context));
      check('媒体设备数量与声明一致', byId.media_devices?.status === 'warn' && byId.media_devices?.actual?.counts?.audioinput === report.declared?.media_counts?.audioinput_num, JSON.stringify(byId.media_devices?.actual));

      const rerun = await api('GET', `/api/v2/browser-profile/selfcheck?profile_id=${first}&rerun=1`);
      check('rerun=1 重新跑并返回新报告', rerun.json.code === 0 && rerun.json.data?.generated_at !== report.generated_at, `${report.generated_at} -> ${rerun.json.data?.generated_at}`);

      const htmlRes = await fetch(base + `/api/v2/browser-profile/selfcheck?profile_id=${first}&format=html`, {
        headers: { api_key: apiKey, 'x-freepower-client': 'mcp' },
      });
      const html = await htmlRes.text();
      check('自检 HTML 可读（本地渲染，无外链）', /text\/html/.test(htmlRes.headers.get('content-type') || '')
        && html.includes('自检报告') && html.includes('覆盖度') && !/https?:\/\//.test(html), String(htmlRes.status));
    }

  /* ---------- 本地探测端点（不连公网） ---------- */
    if (started[0]) {
      const c = await CdpClient.connect(started[0].data.ws.puppeteer);
      try {
        const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
        await sleep(1200);
        const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
        const r = await c.send('Runtime.evaluate', { expression: 'window.__fpApplied || null', returnByValue: true }, sessionId);
        check('新开标签完成注入（首帧不漏）', Array.isArray(r.result.value) && r.result.value.includes('canvas'), JSON.stringify(r.result.value));
        const cores = await c.send('Runtime.evaluate', { expression: 'navigator.hardwareConcurrency', returnByValue: true }, sessionId);
        check('新开标签硬件参数已覆写', typeof cores.result.value === 'number', String(cores.result.value));
        await c.send('Target.closeTarget', { targetId });
      } finally {
        c.close();
      }
    }

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

    /* ================= PAC：明确拒绝，绝不静默降级 ================= */
    {
      const pacCreate = await api('POST', '/api/v2/browser-profile/create', {
        name: 'p2-pac', country: 'US', full_pac_url: 'http://example.com/proxy.pac',
      });
      check('PAC：创建直接报错', pacCreate.json.code === 100002 && /不支持 PAC/.test(String(pacCreate.json.msg)), `${pacCreate.json.code} ${pacCreate.json.msg}`);

      const pacCreate2 = await api('POST', '/api/v2/browser-profile/create', {
        name: 'p2-pac2', proxy_config: { proxy_type: 'pac', host: '127.0.0.1', port: 1 },
      });
      check('PAC：proxy_type=pac 也直接报错', pacCreate2.json.code === 100002 && /不支持 PAC/.test(String(pacCreate2.json.msg)), `${pacCreate2.json.code} ${pacCreate2.json.msg}`);

      // 老数据（迁移/手改库）里的 PAC：启动前拦，且不许拉起内核
      const pacP = await api('POST', '/api/v1/user/create', { name: 'p2-pac-db', country: 'US' });
      const pacId = pacP.json.data.profile_id;
      created.push(pacId);
      getDb().prepare('UPDATE profiles SET full_pac_url = ? WHERE id = ?').run('http://example.com/proxy.pac', pacId);
      const uddPac = `profiles\\${pacP.json.data?.profile_no}_${String(pacId).slice(0, 8)}`;
      const beforePac = chromePidsMatching(uddPac);
      const pacStart = await api('GET', `/api/v1/browser/start?user_id=${pacId}`);
      check('PAC：旧数据启动返回 800003', pacStart.json.code === 800003, `${pacStart.json.code} ${pacStart.json.msg}`);
      check('PAC：reason=pac_unsupported', pacStart.json.data?.reason === 'pac_unsupported', String(pacStart.json.data?.reason));
      check('PAC：零内核进程', chromePidsMatching(uddPac).length === 0 && beforePac.length === 0, String(chromePidsMatching(uddPac).length));
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

    /* ================= P2：跨重启噪点确定性 ================= */
    {
      const rp = await api('POST', '/api/v1/user/create', { name: 'p2-restart', country: 'DE' });
      const rid = rp.json.data.profile_id;
      created.push(rid);
      const keys = ['canvas_id', 'webgl_image_id', 'audio_id', 'client_rects_id'];
      const seedsBefore = keys.map((k) => rp.json.data?.[k]);
      check('噪点种子在建环境时入库', seedsBefore.every((v) => typeof v === 'number'), JSON.stringify(seedsBefore));

      const r1 = await api('GET', `/api/v1/browser/start?user_id=${rid}`);
      const h1 = r1.json.data?.selfcheck?.hashes || {};
      check('第一次启动自检通过', r1.json.code === 0 && r1.json.data?.selfcheck?.fail === 0, JSON.stringify(r1.json.data?.selfcheck));
      await api('GET', `/api/v1/browser/stop?user_id=${rid}`);
      await sleep(900);

      const r2 = await api('GET', `/api/v1/browser/start?user_id=${rid}`);
      const h2 = r2.json.data?.selfcheck?.hashes || {};
      for (const k of ['canvas', 'webgl_image', 'audio', 'client_rects']) {
        check(`跨重启 ${k} 哈希一致`, !!h1[k] && h1[k] === h2[k], `${h1[k]} vs ${h2[k]}`);
      }
      check('自检报告确认跨重启一致', r2.json.data?.selfcheck?.determinism?.cross_restart === true, JSON.stringify(r2.json.data?.selfcheck?.determinism));

      const after = await api('GET', `/api/v1/user/detail?user_id=${rid}`);
      const seedsAfter = keys.map((k) => after.json.data?.[k]);
      check('重启后种子没漂移', JSON.stringify(seedsAfter) === JSON.stringify(seedsBefore), `${JSON.stringify(seedsBefore)} vs ${JSON.stringify(seedsAfter)}`);
      await api('GET', `/api/v1/browser/stop?user_id=${rid}`);
      await sleep(500);
    }

    /* ================= P4-A：不依赖内核的本地 API ================= */
    {
      const ids3 = started.map((s) => s.profile.profile_id);

      // 批量启动的「中断」：第一个必然失败（死代理），后面的不许硬起
      const b1 = await api('POST', '/api/v1/browser/batch-start', { user_ids: [badProxyId, 'ghost-a', 'ghost-b'], concurrency: 2 });
      const d1 = b1.json.data || {};
      check('批量启动：失败清单带 code/message', b1.json.code === 0 && d1.failed?.length >= 1 && typeof d1.failed[0].code === 'number', JSON.stringify(d1.failed));
      check('批量启动：中途失败即中断，剩下的进 skipped', d1.interrupted === true && d1.started?.length === 0 && d1.skipped?.length >= 1, `started=${d1.started?.length} skipped=${d1.skipped?.length}`);
      check('批量启动：回显并发上限', d1.concurrency === 2, String(d1.concurrency));

      // cloud-active 必须明确报错
      const cloud = await api('POST', '/api/v1/browser/cloud-active', { user_ids: ids3.join(',') });
      check('cloud-active：明确报不支持，不假成功', cloud.json.code === -1 && cloud.json.data?.supported === false && /不支持 cloud-active/.test(cloud.json.msg), cloud.json.msg);

      // 其余本地组装路由
      const ck = await api('GET', `/api/v2/browser-profile/cookies?profile_id=${ids3[0]}`);
      check('cookies：{cookies:"..."}', ck.json.code === 0 && typeof ck.json.data?.cookies === 'string');
      const kn = await api('GET', '/api/v2/browser-profile/kernels?kernel_type=chrome');
      check('kernels：本机内核列表', kn.json.code === 0 && (kn.json.data?.list || []).length > 0, JSON.stringify(kn.json.data?.list?.map((x) => x.kernel)));
      const knBad = await api('GET', '/api/v2/browser-profile/kernels?kernel_type=opera');
      check('kernels：非法类型 100002', knBad.json.code === 100002, knBad.json.msg);

      // 标签 / 代理列表：本地 CRUD
      const tag = await api('POST', '/api/v2/browser-tags/create', { tags: { name: 'smoke-tag', color: 'green' } });
      check('标签：建', tag.json.code === 0 && tag.json.data?.list?.[0]?.color === 'green');
      const tagId = tag.json.data?.list?.[0]?.id;
      const px = await api('POST', '/api/v2/proxy-list/create', [{ type: 'socks5', host: '127.0.0.1', port: dead, remark: 'smoke' }]);
      check('代理列表：建（顶层数组）', px.json.code === 0 && px.json.data?.[0]?.type === 'socks5');
      const pxId = px.json.data?.[0]?.proxy_id;
      const pxList = await api('POST', '/api/v2/proxy-list/list', { limit: 10 });
      check('代理列表：列表', pxList.json.code === 0 && pxList.json.data?.list?.some((x) => x.proxy_id === pxId));
      await api('POST', '/api/v2/proxy-list/delete', { proxy_id: [pxId] });
      if (tagId) await api('POST', '/api/v2/browser-tags/delete', { ids: [tagId] });

      // 占位：明确不支持
      const ph = await api('POST', '/api/v2/browser-profile/recycle-bin/list', { page: 1 });
      check('占位路由：明确不支持', ph.json.code === -1 && ph.json.data?.supported === false);
    }

    /* ================= 契约基础 ================= */
    const pids = started.map((s) => Number(s.data.pid));
    const stops = await Promise.all(started.map((s) => api('GET', `/api/v1/browser/stop?user_id=${s.profile.profile_id}`)));
    check('3 个环境都停掉', stops.every((r) => r.json.code === 0 && r.json.data === undefined));
    const gone = await Promise.all(pids.map((pid) => waitPidGone(pid)));
    check('主进程全部退出', gone.every(Boolean), pids.join(','));

    const stopAgain = await api('GET', `/api/v1/browser/stop?user_id=${started[0].profile.profile_id}`);
    check('重复 stop 返回 800002', stopAgain.json.code === 800002, String(stopAgain.json.code));

    const active = await api('GET', `/api/v1/browser/active?user_id=${started[0].profile.profile_id}`);
    check('active：停掉后是 {status:"Inactive"}', active.json.data?.status === 'Inactive', JSON.stringify(active.json.data));
    const activeNoId = await api('GET', '/api/v1/browser/active');
    check('active：缺 id 报 100002', activeNoId.json.code === 100002, String(activeNoId.json.code));

    /* ================= P4-B：真起 3 个 + 批量停 ================= */
    {
      const ids3 = started.map((s) => s.profile.profile_id);
      const b2 = await api('POST', '/api/v2/browser-profile/batch-start', { profile_ids: ids3, concurrency: 3 });
      const d2 = b2.json.data || {};
      check('批量启动：一次起 3 个', b2.json.code === 0 && d2.started?.length === 3 && d2.failed?.length === 0, JSON.stringify(d2.failed));
      check('批量启动：每个都有 ws/debug_port', (d2.started || []).every((x) => x.ws?.puppeteer && typeof x.debug_port === 'string'));
      for (const x of d2.started || []) extraPids.push(Number(x.pid));
      check('批量启动：并发上限生效（3）', d2.concurrency === 3, String(d2.concurrency));

      const act2 = await api('GET', `/api/v2/browser-profile/active?profile_id=${ids3[0]}`);
      check('active：开着的时候是 {status:"Active"}', act2.json.data?.status === 'Active' && !!act2.json.data?.ws?.puppeteer, JSON.stringify(act2.json.data));
      const la2 = await api('GET', '/api/v1/browser/local-active');
      check('local-active：3 个都在列表里', la2.json.data?.list?.length === 3, String(la2.json.data?.list?.length));

      const b3 = await api('POST', '/api/v2/browser-profile/batch-stop', { profile_ids: ids3, concurrency: 5 });
      check('批量停止：3 个都停掉', b3.json.code === 0 && b3.json.data?.stopped?.length === 3, JSON.stringify(b3.json.data));
      const la3 = await api('GET', '/api/v1/browser/local-active');
      check('批量停止后 local-active 为空', la3.json.data?.list?.length === 0);
      await Promise.all((d2.started || []).map((x) => waitPidGone(Number(x.pid))));
      await sleep(800);
    }

    /* ================= P5：Web 控制台的静态层与 schema ================= */
    {
      const idx = await fetch(base + '/');
      const idxText = await idx.text();
      check('控制台首页可打开并带 api_key', idx.status === 200 && idxText.includes(apiKey) && idxText.includes('window.__FP__'), `${idx.status}`);
      const uiJs = await fetch(base + '/ui/app.js');
      check('控制台脚本可加载', uiJs.status === 200 && /javascript/.test(uiJs.headers.get('content-type') || ''));
      const schema = await api('GET', '/api/v2/browser-profile/schema');
      check('编辑表单 schema：11 组', schema.json.data?.groups?.length === 11, `${schema.json.data?.groups?.length} 组 / ${schema.json.data?.total} 字段`);
      const vchk = await api('POST', '/api/v2/browser-profile/validate', { mode: 'create', profile: { group_id: '0', timezone: 'UTC', cookie: '' } });
      check('表单校验接口：UTC 时区与空 cookie 都放行', vchk.json.data?.ok === true, JSON.stringify(vchk.json.data?.errors));
    }

    const leftovers = chromePidsMatching('freepower').filter((x) => /^\d+$/.test(x));
    check('无残留 chrome 进程', leftovers.length === 0, leftovers.join(',') || 'none');
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