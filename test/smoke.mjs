/**
 * P0 冒烟：端到端验证「建环境 → 起真 Chrome → 指纹生效 → 关环境 → 再起指纹不变 → 不同环境指纹不同」。
 * 跑法：npm run smoke
 */
import { createApiServer } from '../src/api/server.js';
import { CdpClient } from '../src/kernel/cdp.js';
import { stopAll } from '../src/runtime/manager.js';
import { findChrome } from '../src/kernel/chrome.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function listen(server, port) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
}

const CANVAS_EXPR = `(() => {
  const c = document.createElement('canvas'); c.width = 220; c.height = 60;
  const x = c.getContext('2d');
  x.textBaseline = 'top';
  x.font = '15px Arial';
  x.fillStyle = '#f60'; x.fillRect(0, 0, 220, 60);
  x.fillStyle = '#069'; x.fillText('FreePower 自检 AaBb 123', 3, 3);
  const d = x.getImageData(0, 0, 220, 60).data;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < d.length; i += 4) { h ^= d[i]; h = Math.imul(h, 16777619) >>> 0; }
  const again = x.getImageData(0, 0, 220, 60).data;
  let h2 = 2166136261 >>> 0;
  for (let i = 0; i < again.length; i += 4) { h2 ^= again[i]; h2 = Math.imul(h2, 16777619) >>> 0; }
  return { hash: h >>> 0, hashAgain: h2 >>> 0, dataUrl: c.toDataURL().length, urlAgain: c.toDataURL().length };
})()`;

const PROBE_EXPR = `(() => {
  const gl = document.createElement('canvas').getContext('webgl');
  const out = {
    installed: typeof window.__fpApplied !== 'undefined',
    applied: window.__fpApplied || null,
    ua: navigator.userAgent,
    platform: navigator.platform,
    webdriver: navigator.webdriver,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    languages: navigator.languages,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    screen: [screen.width, screen.height, window.devicePixelRatio],
    webglVendor: gl ? gl.getParameter(37445) : null,
    webglRenderer: gl ? gl.getParameter(37446) : null,
    uaData: navigator.userAgentData ? {
      brands: navigator.userAgentData.brands.map(b => b.brand + '/' + b.version),
      platform: navigator.userAgentData.platform,
      mobile: navigator.userAgentData.mobile,
    } : null,
  };
  return out;
})()`;

async function evalInInjectedPages(wsUrl, expr) {
  const c = await CdpClient.connect(wsUrl);
  try {
    const { targetInfos } = await c.send('Target.getTargets');
    const pages = targetInfos.filter((t) => t.type === 'page');
    const out = [];
    for (const t of pages) {
      try {
        const { sessionId } = await c.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
        if (r.exceptionDetails) continue;
        out.push({ targetId: t.targetId, url: t.url, value: r.result.value });
      } catch { /* 某个 target 挂了跳过 */ }
    }
    return out;
  } finally {
    c.close();
  }
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
  try {
    // /status 形状对齐
    const status = await api('GET', '/status');
    check('/status 形状对齐', status.json.code === 0 && status.json.msg === 'success', JSON.stringify(status.json));

    // 鉴权
    const noauth = await fetch(base + '/api/v1/user/list');
    check('无 key 被拒', noauth.status === 401, `HTTP ${noauth.status}`);

    // 建环境
    const c1 = await api('POST', '/api/v1/user/create', { name: 'smoke-a', country: 'US' });
    const p1 = c1.json.data;
    created.push(p1.profile_id);
    check('建环境返回 profile_id', c1.json.code === 0 && !!p1.profile_id, p1.profile_id);
    check('指纹自洽：UA 版本 == 内核大版本',
      p1.fingerprint_config.ua.includes(`Chrome/${p1.fingerprint_config.kernel.major}.`),
      p1.fingerprint_config.kernel.major);

    // 起环境
    const s1 = await api('GET', `/api/v1/browser/start?user_id=${p1.profile_id}`);
    check('启动返回 code 0', s1.json.code === 0, s1.json.msg);
    if (s1.json.code !== 0) throw new Error('启动失败，后续跳过');
    const ws1 = s1.json.data.ws.puppeteer;
    check('返回 ws.puppeteer', typeof ws1 === 'string' && ws1.startsWith('ws://'), ws1);
    check('返回 debug_port', s1.json.data.debug_port > 0, String(s1.json.data.debug_port));

    // 探针
    const probes = await evalInInjectedPages(ws1, PROBE_EXPR);
    const probe = probes.find((p) => p.value && p.value.installed);
    check('注入脚本已生效（找到打过补丁的页面）', !!probe, `${probes.length} 个页面`);
    if (probe) {
      const v = probe.value;
      const fp = p1.fingerprint_config;
      check('UA 一致', v.ua === fp.ua, v.ua.slice(0, 60));
      check('UA-CH 有值', !!v.uaData && v.uaData.platform === 'Windows', JSON.stringify(v.uaData && v.uaData.brands));
      check('navigator.webdriver 为 undefined', v.webdriver === undefined || v.webdriver === false, String(v.webdriver));
      check('时区一致', v.timezone === fp.timezone, v.timezone);
      check('语言一致', (v.languages || []).join(',') === fp.language.join(','), (v.languages || []).join(','));
      check('hardwareConcurrency 一致', v.hardwareConcurrency === fp.hardware_concurrency, String(v.hardwareConcurrency));
      check('platform 一致', v.platform === fp.platform, v.platform);
      check('WebGL renderer 一致', v.webglRenderer === fp.webgl.renderer, v.webglRenderer);
      check('WebGL vendor 一致', v.webglVendor === fp.webgl.vendor, v.webglVendor);
    }

    const canvas1 = await evalInInjectedPages(ws1, CANVAS_EXPR);
    const cv1 = canvas1.map((c) => c.value).find(Boolean);
    check('canvas 同页连读两次一致', cv1 && cv1.hash === cv1.hashAgain, cv1 ? `${cv1.hash}/${cv1.hashAgain}` : 'n/a');

    // 关环境
    const stop1 = await api('GET', `/api/v1/browser/stop?user_id=${p1.profile_id}`);
    check('停止成功', stop1.json.code === 0 && stop1.json.data.stopped === true, JSON.stringify(stop1.json.data));
    const pidGone = await waitPidGone(s1.json.data.pid, 5000);
    check('进程树已回收', pidGone, `pid ${s1.json.data.pid}`);

    // 再起：同一环境指纹必须不变
    const s2 = await api('GET', `/api/v1/browser/start?user_id=${p1.profile_id}`);
    check('二次启动成功', s2.json.code === 0, s2.json.msg);
    const canvas2 = await evalInInjectedPages(s2.json.data.ws.puppeteer, CANVAS_EXPR);
    const cv2 = canvas2.map((c) => c.value).find(Boolean);
    check('重启后 canvas 指纹不变（同种子）', cv1 && cv2 && cv1.hash === cv2.hash, `${cv1 && cv1.hash} / ${cv2 && cv2.hash}`);

    // 另一个环境：指纹必须不同
    const c2 = await api('POST', '/api/v1/user/create', { name: 'smoke-b', country: 'JP' });
    created.push(c2.json.data.profile_id);
    const s3 = await api('GET', `/api/v1/browser/start?user_id=${c2.json.data.profile_id}`);
    check('第二个环境启动成功', s3.json.code === 0, s3.json.msg);
    const canvas3 = await evalInInjectedPages(s3.json.data.ws.puppeteer, CANVAS_EXPR);
    const cv3 = canvas3.map((c) => c.value).find(Boolean);
    check('不同环境 canvas 指纹不同', cv1 && cv3 && cv1.hash !== cv3.hash, `${cv1 && cv1.hash} / ${cv3 && cv3.hash}`);
    const probe3 = (await evalInInjectedPages(s3.json.data.ws.puppeteer, PROBE_EXPR)).find((p) => p.value && p.value.installed);
    check('第二个环境时区跟随国家（日本）', probe3 && probe3.value.timezone === 'Asia/Tokyo', probe3 && probe3.value.timezone);

    const active = await api('GET', '/api/v1/browser/active');
    check('active 列表有 2 个', active.json.data.list.length === 2, JSON.stringify(active.json.data.list.map((x) => x.profile_id)));
  } catch (e) {
    check('冒烟异常', false, e.message);
  } finally {
    await stopAll();
    for (const id of created) await api('POST', '/api/v1/user/delete', { user_ids: [id] });
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

async function waitPidGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

main();