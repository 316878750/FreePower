/**
 * AI Agent 判定门 B 层（0.4.0）—— **真内核**，属于 `npm run smoke`，不进 `npm test`。
 *
 * 断言清单来自巡检（CEO 转达），B1–B4 一条不多一条不少：
 *   B1 七动作 happy path：open → click → fill → wait(selector) → text → screenshot →
 *      cookie set → cookie get；status=completed；text 读回 fill 的值；截图是 png；
 *      cookie get 能看到 set 的 name；status JSON 里没有 fill/cookie 原文
 *   B2 失败即停：第二步 click 不存在的选择器 → failed + step_id=step-2 +
 *      reason=selector_not_found（用执行器实际抛的串）；第三步 result===null 且没跑
 *   B3 超时：wait 一个永不出现的 selector（预算用测试注入的短超时）→ failed +
 *      reason=step_timeout；后续步 result===null；没有重试
 *   B4 跑完浏览器仍 Active：在 stop 清理**之前**取状态
 *
 * 不写成断言的三条（README 已知限制）：click 的 isTrusted=false、open 重开同 URL 让半拍、
 * Chrome 自己把 cookie 封顶 ~4096 B。
 *
 * 数据目录一次性：`<repo>/.tmp/pa2-agent-smoke-<pid>`，跑完删；不碰 %APPDATA%\FreePower。
 * 跑法：npm run smoke（或 node --no-warnings test/agent-smoke.test.mjs）
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(repoRoot, '.tmp', `pa2-agent-smoke-${process.pid}`);

// 必须在 import 业务模块之前设（config 在模块求值时读 env）
process.env.FREEPOWER_DATA = DATA;
process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
process.env.FREEPOWER_EGRESS_TIMEOUT = '800';
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_AGENT_STEP_TIMEOUT = '4000'; // B3 靠它，别让整组拖到分钟级
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><meta charset="utf-8"><title>agent-gate</title><body>
<input id="q"><button id="btn">go</button><div id="out"></div>
<script>
  const q = document.getElementById('q');
  const out = document.getElementById('out');
  // 注意：标记挂在 data-done 上，**别改 out 的 id** —— 后一步 text 还要按 '#out' 找它
  document.getElementById('btn').addEventListener('click', () => { out.dataset.done = '1'; out.textContent = q.value; });
  q.addEventListener('input', () => { out.textContent = q.value; });
</script></body>`;

const pageSrv = http.createServer((req, res) => {
  if (req.url === '/gate') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('nope');
});
await new Promise((r) => pageSrv.listen(0, '127.0.0.1', r));
const PAGE_URL = `http://127.0.0.1:${pageSrv.address().port}/gate`;

const { createApiServer } = await import('../src/api/server.js');
const { stopAll } = await import('../src/runtime/manager.js');
const { findChrome } = await import('../src/kernel/chrome.js');
const { AGENT_SCREENSHOT_DIR } = await import('../src/config.js');

const chrome = findChrome();
if (!chrome) {
  console.error('没有可用内核，设置 FREEPOWER_CHROME 后重试');
  process.exit(2);
}
console.log(`内核：${chrome.version} (${chrome.source}) ${chrome.path}`);
console.log(`测试页：${PAGE_URL}\n数据目录：${DATA}\n`);

const { server, apiKey } = createApiServer();
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const base = `http://127.0.0.1:${port}`;
const api = async (method, p, body) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', api_key: apiKey, 'x-freepower-client': 'mcp' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};

/** 建工作流 → 逐步批 → 返回 id（digest 用创建时给的，模拟人看到审批单再批） */
async function makeApprovedWorkflow(tasks) {
  const created = await api('POST', '/api/v1/agent/workflow/run', { profile_id: profileId, goal: 'gate', tasks });
  if (created.json.code !== 0) throw new Error('建工作流失败：' + JSON.stringify(created.json));
  const wf = created.json.data;
  for (const s of wf.steps) {
    const a = await api('POST', `/api/v1/agent/workflow/${wf.workflow_id}/approve`, {
      step_id: s.step_id, decision: 'approve', digest: s.digest,
    });
    if (a.json.code !== 0) throw new Error(`批 ${s.step_id} 失败：` + JSON.stringify(a.json));
  }
  return wf.workflow_id;
}

async function status(id) {
  const r = await api('GET', `/api/v1/agent/workflow/${id}/status`);
  return r.json.data;
}

async function runAndWait(id, { timeoutMs = 60000 } = {}) {
  const started = await api('POST', `/api/v1/agent/workflow/${id}/run`);
  if (started.json.code !== 0) throw new Error('run 返回错误：' + JSON.stringify(started.json));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await status(id);
    if (['completed', 'failed', 'rejected', 'aborted'].includes(st.status)) return st;
    if (Date.now() > deadline) throw new Error(`工作流 ${id} 在 ${timeoutMs}ms 内没到终态：${st.status}`);
    await sleep(200);
  }
}

let profileId = null;
try {
  /* ---------------- 建环境（headless，不弹窗） ---------------- */
  const c = await api('POST', '/api/v1/user/create', { name: 'agent-gate', country: 'US', headless: '1' });
  if (c.json.code !== 0) throw new Error('建环境失败：' + JSON.stringify(c.json));
  profileId = c.json.data.profile_id;
  check('建环境成功（headless）', !!profileId, profileId);

  /* ============================================================================
   * B1 七动作 happy path
   * ==========================================================================*/
  const FILL = 'hello-e2e-9f3a';
  const wf1 = await makeApprovedWorkflow([
    { action: 'open', url: PAGE_URL },
    { action: 'click', selector: '#btn' },
    { action: 'fill', selector: '#q', value: FILL },
    { action: 'wait', selector: '#out[data-done="1"]' },
    { action: 'text', selector: '#out' },
    { action: 'screenshot', full_page: true },
    { action: 'cookie', op: 'set', name: 'gate', value: 'COOKIE_SENTINEL_9f3a' },
    { action: 'cookie', op: 'get' },
  ]);
  const st1 = await runAndWait(wf1);
  check('B1 status=completed', st1.status === 'completed', st1.status + ' ' + JSON.stringify(st1.error));
  check('B1 八步都 completed', st1.steps.every((s) => s.status === 'completed'), JSON.stringify(st1.steps.map((s) => s.status)));

  const textStep = st1.steps.find((s) => s.action === 'text');
  check('B1 text 读回 fill 写入的值', textStep?.result?.value === FILL, JSON.stringify(textStep?.result));

  const shotStep = st1.steps.find((s) => s.action === 'screenshot');
  const shotRel = shotStep?.result?.path;
  const shotAbs = shotRel ? path.join(AGENT_SCREENSHOT_DIR, shotRel) : '';
  const shotOk = !!shotAbs && fs.existsSync(shotAbs) && fs.readFileSync(shotAbs).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  check('B1 截图落盘且是 png', shotOk, `${shotRel}`);
  check('B1 screenshot.path 是相对路径', !!shotRel && !path.isAbsolute(shotRel), String(shotRel));

  const cookieStep = st1.steps.find((s) => s.action === 'cookie' && Array.isArray(s.result?.cookies));
  const names = (cookieStep?.result?.cookies || []).map((x) => x.name);
  check('B1 cookie get 能看到 set 的 name', names.includes('gate'), JSON.stringify(names));

  // A4 在真跑之后再验一次：status JSON 里没有「任务原文」。
  // 注意 `text` 会读回同一个字符串 —— 那是**页面内容**，不是任务原文；判据是
  // 「没有 task 对象被回吐」：selector 与 cookie 值都不该出现。
  const st1json = JSON.stringify(st1);
  check('B1 status JSON 里没有 fill 任务原文（selector）', !st1json.includes('"selector":"#q"'));
  // cookie get 会把值读回来（那是内核对页面数据的回答，属于「动作的产物」，结果里本来就带
  // name/value）；这里验的是**任务原文**没被回吐：结果里不该出现任务键 `op`。
  check('B1 status JSON 里没有 cookie 任务原文（op）', !st1json.includes('"op":"set"'));
  check('B1 fill 结果只有 ok/took_ms', JSON.stringify(Object.keys(st1.steps.find((s) => s.action === 'fill').result).sort()) === '["ok","took_ms"]');
  const setStep = st1.steps.filter((s) => s.action === 'cookie').find((s) => s.result?.ok === true);
  check('B1 cookie set 结果只有 ok/took_ms', !!setStep && JSON.stringify(Object.keys(setStep.result).sort()) === '["ok","took_ms"]', JSON.stringify(setStep?.result));

  /* ============================================================================
   * B4（紧跟 B1，在 stop 之前）：跑完浏览器仍 Active
   * ==========================================================================*/
  const active = await api('GET', `/api/v1/browser/active?user_id=${profileId}`);
  check('B4 跑完浏览器仍 Active（执行器不关浏览器）', active.json.data?.status === 'Active', JSON.stringify(active.json.data));

  /* ============================================================================
   * B2 失败即停
   * ==========================================================================*/
  const wf2 = await makeApprovedWorkflow([
    { action: 'open', url: PAGE_URL },
    { action: 'click', selector: '#nope' },
    { action: 'text', selector: '#out' },
  ]);
  const st2 = await runAndWait(wf2);
  check('B2 status=failed', st2.status === 'failed', st2.status);
  check('B2 error.step_id=step-2', st2.error?.step_id === 'step-2', JSON.stringify(st2.error));
  check('B2 error.reason=selector_not_found', st2.error?.reason === 'selector_not_found', String(st2.error?.reason));
  check('B2 第一步 completed', st2.steps[0].status === 'completed', st2.steps[0].status);
  check('B2 第三步没跑（result=null）', st2.steps[2].result === null && st2.steps[2].status !== 'completed', JSON.stringify({ status: st2.steps[2].status, result: st2.steps[2].result }));

  /* ============================================================================
   * B3 超时（wait 一个永不出现的 selector）
   * ==========================================================================*/
  const wf3 = await makeApprovedWorkflow([
    { action: 'open', url: PAGE_URL },
    { action: 'wait', selector: '#never-appears' },
    { action: 'text', selector: '#out' },
  ]);
  const t0 = Date.now();
  const st3 = await runAndWait(wf3);
  const took = Date.now() - t0;
  check('B3 status=failed', st3.status === 'failed', st3.status);
  check('B3 error.reason=step_timeout', st3.error?.reason === 'step_timeout', String(st3.error?.reason));
  check('B3 超时步是 step-2', st3.error?.step_id === 'step-2', JSON.stringify(st3.error));
  check('B3 后续步 result=null', st3.steps[2].result === null, JSON.stringify(st3.steps[2].result));
  check('B3 按注入的短预算收尾（<15s）', took < 15000, `${took}ms`);
  check('B3 没有重试（只有一步带 step_timeout）', st3.steps.filter((s) => s.reason === 'step_timeout').length === 1, JSON.stringify(st3.steps.map((s) => s.reason)));
} catch (e) {
  check('执行过程不抛异常', false, String(e?.stack || e).split('\n').slice(0, 4).join(' | '));
} finally {
  try { await stopAll(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
  try { pageSrv.close(); } catch { /* ignore */ }
  await sleep(500);
  // Chrome 停完可能还占着 user-data-dir 的文件锁（Windows），删不掉不是测试失败：
  // 如实打出来，留下的是 .tmp 里的一次性目录，核对无进程引用后可手工删。
  try {
    fs.rmSync(DATA, { recursive: true, force: true });
  } catch (e) {
    console.log(`\n注意：一次性数据目录没删干净（${e.code || e.message}）：${DATA}`);
  }
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed} passed, ${results.length - passed} failed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
