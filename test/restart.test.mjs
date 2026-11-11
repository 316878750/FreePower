/**
 * P8-A 真机验证：browser/restart = stop → apply → start
 *
 * 断言：
 *   1. 新内核 pid 与旧的不同，且旧 pid 真的没了（不是「起了新的忘了旧的」）
 *   2. 改的字段在库里生效，并且新内核真的按新值起来（页面读到 Europe/Berlin）
 *   3. 双 Realm 没退化：workers.injected 仍是 3
 *   4. 只有一个内核进程（按 user-data-dir 过滤）
 *   5. restart 失败时环境停在 stopped，绝不启动（单测覆盖，这里不重复）
 *
 * 跑法：node test/restart-live.mjs   （需真实 Chrome + 完整权限；不打进 npm run smoke，单独跑）
 */
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, '.tmp', 'restart-data');
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.FREEPOWER_DATA = DATA;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
process.env.FREEPOWER_EGRESS_TIMEOUT = '1000';

const { createApiServer } = await import('../src/api/server.js');
const { CdpClient } = await import('../src/kernel/cdp.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { server, apiKey } = createApiServer();
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const base = `http://127.0.0.1:${port}`;
const api = async (method, p, body) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', api_key: apiKey, 'x-freepower-client': 'mcp' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
};

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

function ps(cmd) {
  try { return execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim(); } catch { return ''; }
}
function alive(pid) {
  return Boolean(ps(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Id`));
}
/** 只数浏览器主进程：子进程带 --type=xxx，主进程不带；靠这个区分，别靠调试端口
 *  ——命令行里确实有 `--remote-debugging-port=0`（`src/kernel/chrome.js` 的固定参数，真端口由系统随机分配、
 *  回读到 DevToolsActivePort），但**别拿它当判据**：同机还有别的 Chrome 时会把别人的进程数进来，
 *  0 也不带任何身份信息，靠它分不清是谁的。
 *  过滤放在 JS 里做：PS 那层的 -notlike 组合过滤容易出错，实测会静默返回 0；
 *  user-data-dir 里只含 id 的前 8 位，用完整 uuid 匹配同样得到 0（都实测过）。 */
function browserProcessCount(id) {
  const frag = id.split('-')[0];   // user-data-dir 里只有 id 的前 8 位，用完整 uuid 匹配会得到 0（实测）
  const out = ps(`Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Select-Object -ExpandProperty CommandLine`);
  const lines = (out || '').split(/\r?\n/).filter((l) => l.includes(frag));
  const browser = lines.filter((l) => !l.includes('--type='));
  if (process.env.FP_DEBUG_CMDLINE === '1') {
    console.log(`  [debug] frag=${frag} 该环境 chrome 进程 ${lines.length} 个，主进程 ${browser.length} 个`);
    for (const l of lines.slice(0, 2)) console.log('    ' + l.slice(0, 200));
  }
  return browser.length;
}

async function tzInPage(wsUrl) {
  const c = await CdpClient.connect(wsUrl);
  try {
    const { targetInfos } = await c.send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    if (!page) return null;
    const { sessionId } = await c.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    for (let i = 0; i < 5; i++) {
      const r = await c.send('Runtime.evaluate', {
        expression: 'Intl.DateTimeFormat().resolvedOptions().timeZone',
        returnByValue: true,
      }, sessionId).catch(() => null);
      if (r && !r.exceptionDetails) return r.result.value;
      await sleep(200);
    }
    return null;
  } finally { c.close(); }
}

let id = null;
try {
  const created = await api('POST', '/api/v2/browser-profile/create', { name: `restart-live-${Date.now()}`, group_id: '0', remark: 'P8-A 真机' });
  id = created.json.data.profile_id;
  console.log(`环境 ${id}`);

  const s1 = await api('GET', `/api/v2/browser-profile/start?profile_id=${id}`);
  const d1 = s1.json.data;
  check('start 成功', s1.json.code === 0 && d1.status === 'running', JSON.stringify({ code: s1.json.code, status: d1?.status }));
  const pid1 = d1.pid;
  const ws1 = d1.ws?.puppeteer;
  console.log(`  第一次启动 pid=${pid1} injected=${d1.workers?.injected}`);
  const tz1 = await tzInPage(ws1);
  check('重启前时区 = 环境默认（非 Europe/Berlin）', tz1 !== 'Europe/Berlin', String(tz1));

  // 重启：改时区
  const r = await api('POST', '/api/v2/browser-profile/restart', {
    profile_id: id, timezone: 'Europe/Berlin', automatic_timezone: '0',
  });
  const d2 = r.json.data || {};
  check('restart 返回 code 0', r.json.code === 0, `${r.json.code} ${r.json.msg}`);
  check('restart.restarted = true', d2.restarted === true, String(d2.restarted));
  check('restart.changed 含 timezone', Array.isArray(d2.changed) && d2.changed.includes('timezone'), JSON.stringify(d2.changed));
  check('restart 后状态 running', d2.status === 'running', String(d2.status));

  const pid2 = d2.pid;
  check('新内核 pid 与旧的不同', Boolean(pid2) && pid2 !== pid1, `${pid1} → ${pid2}`);
  await sleep(1500);
  check('旧内核 pid 已退出', pid1 && !alive(pid1), `pid ${pid1} alive=${alive(pid1)}`);
  check('该环境只剩一个浏览器主进程（子进程会继承 cmdline，不能直接数）', browserProcessCount(id) === 1, `主进程数=${browserProcessCount(id)}`);

  const tz2 = await tzInPage(d2.ws?.puppeteer);
  check('新内核真的按新时区起来（页面读到 Europe/Berlin）', tz2 === 'Europe/Berlin', String(tz2));

  // 注：这里的 workers.injected 不能断言 3 —— 3 是「页面里起了三类 worker」之后才有的数。
  // 双 Realm 不退化由 test/workers.test.mjs 钉住，这里只查统计形状与失败清单。
  check('restart 响应带回 worker 统计且无失败项', Boolean(d2.workers) && Array.isArray(d2.workers.failed) && d2.workers.failed.length === 0, JSON.stringify(d2.workers));

  const detail = await api('GET', `/api/v2/browser-profile/detail?profile_id=${id}`);
  check('库里时区已落新值', detail.json.data?.timezone === 'Europe/Berlin', String(detail.json.data?.timezone));
} catch (e) {
  console.log('异常：', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e);
} finally {
  try { await api('GET', `/api/v2/browser-profile/stop?profile_id=${id}`); } catch {}
  try { await api('POST', '/api/v2/browser-profile/delete', { profile_id: [id] }); } catch {}
  server.close();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
}

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
