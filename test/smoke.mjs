/**
 * P1 验收冒烟：
 *  1. 并发起 3 个环境（US / JP / SG），互不干扰
 *  2. 每个环境的 cookie 隔离（同一个 origin，互相看不到）
 *  3. 幂等：重复 start 返回现成 ws，不新开进程
 *  4. 契约：ws.puppeteer / ws.selenium(host:port) / debug_port(字符串) / webdriver
 *  5. 一致性校验挡在启动前（改坏 platform 后 start 返回 800005）
 *  6. 关掉后进程不残留
 *
 * 跑法：npm run smoke
 */
import { execFileSync } from 'node:child_process';
import { createApiServer } from '../src/api/server.js';
import { CdpClient } from '../src/kernel/cdp.js';
import { stopAll } from '../src/runtime/manager.js';
import { findChrome } from '../src/kernel/chrome.js';
import { getDb } from '../src/store/db.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function listen(server, port) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
}

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
      await new Promise((r) => setTimeout(r, 600));
    }
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    return r.exceptionDetails ? null : r.result.value;
  } finally {
    c.close();
  }
}

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

const COOKIE_READ = 'document.cookie';
const cookieWrite = (v) => `(document.cookie = 'fp_isolation=${v}; path=/', document.cookie)`;

async function waitPidGone(pid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error('没有可用内核，设置 FREEPOWER_CHROME 后重试');
    process.exit(2);
  }
  console.log(`内核：${chrome.version} (${chrome.source}) ${chrome.path}\n`);

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
  try {
    /* ---------- 契约基础 ---------- */
    const status = await api('GET', '/status');
    check('/status 形状', status.json.code === 0 && status.json.msg === 'success', JSON.stringify(status.json));
    const noauth = await fetch(base + '/api/v2/browser-profile/list');
    check('无 key 被拒（HTTP 401）', noauth.status === 401);

    /* ---------- v2 契约：launch_args 数组 + password_filling ---------- */
    const c2 = await api('POST', '/api/v2/browser-profile/create', {
      name: 'p1-v2', batch_id: '0', country: 'SG',
      launch_args: ['--disable-gpu'],
      password_filling: '1',
    });
    check('v2 建环境成功', c2.json.code === 0, c2.json.msg);
    const p2 = c2.json.data || {};
    created.push(p2.profile_id);
    check('v2 返回 profile_id/profile_no', !!p2.profile_id && typeof p2.profile_no === 'number');
    check('v2 launch_args 出站是数组', Array.isArray(p2.launch_args) && p2.launch_args[0] === '--disable-gpu', JSON.stringify(p2.launch_args));
    check('password_filling 内部单布尔', p2.disable_password_filling === '0', JSON.stringify(p2.disable_password_filling));

    const c2v1 = await api('GET', `/api/v1/user/detail?user_id=${p2.profile_id}`);
    check('v1 出站 launch_args 是 JSON 字符串', typeof c2v1.json.data?.launch_args === 'string', String(c2v1.json.data?.launch_args));

    /* ---------- 并发建 3 个环境 ---------- */
    const countries = ['US', 'JP', 'SG'];
    const profiles = [];
    for (const country of countries) {
      const r = await api('POST', '/api/v1/user/create', { name: `p1-${country}`, country });
      check(`建环境 ${country}`, r.json.code === 0, r.json.msg || '');
      profiles.push(r.json.data);
      created.push(r.json.data.profile_id);
    }

    /* ---------- 并发启动 ---------- */
    const started3 = await Promise.all(profiles.map((p) =>
      api('GET', `/api/v1/browser/start?user_id=${p.profile_id}`)));
    for (const [i, r] of started3.entries()) {
      const d = r.json.data || {};
      check(`启动 ${countries[i]}`, r.json.code === 0, r.json.msg);
      check(`${countries[i]} debug_port 是字符串`, typeof d.debug_port === 'string' && Number(d.debug_port) > 0, String(d.debug_port));
      check(`${countries[i]} ws.puppeteer 是 ws://`, typeof d.ws?.puppeteer === 'string' && d.ws.puppeteer.startsWith('ws://'));
      check(`${countries[i]} ws.selenium 是 host:port`, /^127\.0\.0\.1:\d+$/.test(String(d.ws?.selenium)), String(d.ws?.selenium));
      check(`${countries[i]} webdriver 字段存在`, /^127\.0\.0\.1:\d+$/.test(String(d.webdriver)), String(d.webdriver));
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
    const probes = await Promise.all(started.map((s) => evalInPage(s.data.ws.puppeteer, PROBE)));
    for (const [i, v] of probes.entries()) {
      const profile = started[i].profile;
      check(`${countries[i]} 注入已生效`, !!v?.fpApplied, JSON.stringify(v?.fpApplied));
      check(`${countries[i]} UA 一致`, v?.ua === profile.ua, String(v?.ua).slice(0, 50));
      check(`${countries[i]} 时区一致`, v?.timezone === profile.timezone, `${v?.timezone} vs ${profile.timezone}`);
      check(`${countries[i]} webdriver 未暴露`, v?.webdriver === undefined || v?.webdriver === false, String(v?.webdriver));
      check(`${countries[i]} WebGL vendor 一致`, v?.gl?.[0] === profile.webgl_config?.unmasked_vendor, String(v?.gl?.[0]));
    }
    check('3 个环境指纹两两不同', new Set(probes.map((v) => `${v?.ua}|${v?.timezone}|${JSON.stringify(v?.gl)}`)).size === 3);

    /* ---------- cookie 隔离 ---------- */
    const originUrl = `${base}/status`;
    for (const [i, s] of started.entries()) {
      const got = await evalInPage(s.data.ws.puppeteer, cookieWrite(`env${i}`), { url: originUrl });
      check(`cookie 写入 env${i}`, String(got).includes(`fp_isolation=env${i}`), String(got));
    }
    for (const [i, s] of started.entries()) {
      const cookie = String(await evalInPage(s.data.ws.puppeteer, COOKIE_READ));
      const others = [0, 1, 2].filter((j) => j !== i).map((j) => `fp_isolation=env${j}`);
      check(`env${i} cookie 只看到自己`, cookie.includes(`fp_isolation=env${i}`) && others.every((o) => !cookie.includes(o)), cookie);
    }

    /* ---------- 一致性校验挡启动 ---------- */
    const bad = await api('POST', '/api/v1/user/create', { name: 'p1-bad', country: 'US' });
    const badId = bad.json.data.profile_id;
    created.push(badId);
    getDb().prepare('UPDATE profiles SET platform = ?, ua = ? WHERE id = ?')
      .run('MacIntel', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', badId);
    const badStart = await api('GET', `/api/v1/browser/start?user_id=${badId}`);
    check('一致性冲突被挡（800005）', badStart.json.code === 800005, `${badStart.json.code} ${badStart.json.msg}`);

    /* ---------- 停止与回收 ---------- */
    const pids = started.map((s) => Number(s.data.pid));
    const stops = await Promise.all(started.map((s) => api('GET', `/api/v1/browser/stop?user_id=${s.profile.profile_id}`)));
    check('3 个环境都停掉', stops.every((r) => r.json.code === 0 && r.json.data?.stopped === true));
    const gone = await Promise.all(pids.map((pid) => waitPidGone(pid)));
    check('主进程全部退出', gone.every(Boolean), pids.join(','));
    await new Promise((r) => setTimeout(r, 1500));

    let leftovers = '';
    try {
      leftovers = execFileSync('powershell.exe', ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*freepower*' } | Select-Object -ExpandProperty ProcessId"],
      { encoding: 'utf8' }).trim();
    } catch (e) {
      leftovers = `check failed: ${e.message}`;
    }
    check('无残留 chrome 进程', leftovers === '', leftovers || 'none');

    const stopAgain = await api('GET', `/api/v1/browser/stop?user_id=${started[0].profile.profile_id}`);
    check('重复 stop 返回 800002', stopAgain.json.code === 800002, String(stopAgain.json.code));

    const active = await api('GET', '/api/v1/browser/active');
    check('active 列表为空', active.json.data?.list?.length === 0);
  } catch (e) {
    check('冒烟异常', false, e.stack || e.message);
  } finally {
    await stopAll();
    for (const id of created) await api('POST', '/api/v1/user/delete', { user_ids: [id] });
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) console.log('失败项：\n' + failed.map((f) => ` - ${f.name} ${f.detail}`).join('\n'));
  process.exit(failed.length ? 1 : 0);
}

main();