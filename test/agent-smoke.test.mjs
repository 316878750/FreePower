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
 * 0.4.0 收尾加的一条（按 CEO「B 层只加一条，别把 smoke 拖成分钟级」）：
 *   B5 一句话目标 → 工作流：mock LLM（127.0.0.1 随机端口）出 2 步（open 本地页 + text）
 *      → 逐步批准 → 真跑 → 两步 completed；生成响应里没有 key
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
// 单步预算 8s 不是魔法数（2026-11-13 CEO 批准的口径，改之前先读这段）：
//   · 本文件是 `npm run smoke` 的**最后一个**文件，跑它时前面 152 + 37 + 24 项刚压完，机器还在忙；
//   · 4000ms 在这个场景下误杀过 screenshot 步（14:29 实测），不是产品慢，是排队；
//   · 默认单步预算是 30s（FREEPOWER_AGENT_STEP_TIMEOUT），8s 仍远小于它，所以这里不会掩盖真超时；
//   · B3 那条「<15s 收尾」的上限不许动 —— 它才是防「预算悄悄放大」的锚。
process.env.FREEPOWER_AGENT_STEP_TIMEOUT = '8000';
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
let llmSrv = null;
try {
  /* ---------------- 建环境（headless，不弹窗） ---------------- */
  const c = await api('POST', '/api/v1/user/create', { name: 'agent-gate', country: 'US', headless: '1' });
  if (c.json.code !== 0) throw new Error('建环境失败：' + JSON.stringify(c.json));
  profileId = c.json.data.profile_id;
  check('建环境成功（headless）', !!profileId, profileId);

  /* ============================================================================
   * B1 七动作 happy path
   *
   * 单步预算是测试注入的 8s（不是默认 30s）。以前设 4s：整包 smoke 刚跑完、机器还在忙时
   * `screenshot` 那一步被 4s 误杀过一次（14:29 实测：step screenshot 超时 4000ms）。
   * 8s 既保留「短预算」的意思，又不会把 B3 的收尾拖过 15s。
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
  // 0.4.0 收尾**改了口径**（如实记）：`presentWorkflow` 现在给每步 `params` —— 控制台的审批面板
  // 必须显示「批的是什么」，所以 selector / op 出现是**预期**的；敏感值仍然一个字节都不回。
  // 注意 `text` 会读回 fill 写入的同一个字符串、`cookie get` 会读回 cookie 值 ——
  // 那是**页面/内核的产物**，不是任务原文；判据因此落在「params 里的 value 是占位符」+「没有 task 原对象」。
  const st1json = JSON.stringify(st1);
  const fillStep1 = st1.steps.find((s) => s.action === 'fill');
  check('B1 参数摘要里 fill 的值打码（#q 可见，值不可见）',
    fillStep1?.params?.value === '***' && fillStep1?.params?.selector === '#q'
    && !JSON.stringify(fillStep1.params).includes(FILL),
    JSON.stringify(fillStep1?.params));
  // cookie get 会把值读回来（属于「动作的产物」）；这里验的是 cookie **set** 那一步的参数打了码。
  const setParams = st1.steps.filter((s) => s.action === 'cookie').find((s) => s.params?.op === 'set')?.params;
  check('B1 参数摘要里 cookie set 的值打码', setParams?.value === '***', JSON.stringify(setParams));
  check('B1 没有把 task 原对象回吐（JSON 里没有 "task": 键）', !st1json.includes('"task":'));
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

  /* ============================================================================
   * B5 一句话目标 → 工作流 → 逐条批准 → 真跑（mock LLM，全程不联网）
   *    只加这一条：B 层的活已经由 B1–B4 覆盖，这条补的是「生成入口」这条路。
   * ==========================================================================*/
  const llmKey = 'sk-smoke-0123456789abcdef';
  llmSrv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const content = JSON.stringify([
        { action: 'open', url: PAGE_URL },
        { action: 'text', selector: 'body' },
      ]);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((r) => llmSrv.listen(0, '127.0.0.1', r));

  const goalRes = await api('POST', '/api/v1/agent/workflow/create-from-goal', {
    profile_id: profileId,
    goal: '打开本地测试页，读出正文',
    llm: { endpoint: `http://127.0.0.1:${llmSrv.address().port}`, key: llmKey, model: 'mock-model' },
  });
  const wf5 = goalRes.json.data || {};
  check('B5 create-from-goal 返回两步、全部待批',
    goalRes.json.code === 0 && wf5.steps?.length === 2 && wf5.steps.every((s) => s.status === 'pending_approval'),
    JSON.stringify(goalRes.json).slice(0, 200));
  check('B5 每步带 64 位 digest', (wf5.steps || []).length === 2 && wf5.steps.every((s) => /^[0-9a-f]{64}$/.test(s.digest || '')));
  check('B5 goal 原样保存', wf5.goal === '打开本地测试页，读出正文', String(wf5.goal));
  check('B5 生成响应里没有 key', !JSON.stringify(goalRes.json).includes(llmKey));

  for (const s of wf5.steps || []) {
    const a = await api('POST', `/api/v1/agent/workflow/${wf5.workflow_id}/approve`, {
      step_id: s.step_id, decision: 'approve', digest: s.digest,
    });
    if (a.json.code !== 0) throw new Error(`B5 批 ${s.step_id} 失败：` + JSON.stringify(a.json));
  }
  const st5 = await runAndWait(wf5.workflow_id);
  check('B5 两步都 completed',
    st5.status === 'completed' && st5.steps.every((s) => s.status === 'completed'),
    `${st5.status} ${JSON.stringify(st5.steps.map((s) => s.status))} ${JSON.stringify(st5.error)}`);
  const text5 = st5.steps.find((s) => s.action === 'text');
  check('B5 text 读到页面正文（含按钮文案 go）',
    String(text5?.result?.value || '').includes('go'), JSON.stringify(text5?.result).slice(0, 120));
} catch (e) {
  check('执行过程不抛异常', false, String(e?.stack || e).split('\n').slice(0, 4).join(' | '));
} finally {
  try { await stopAll(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
  try { pageSrv.close(); } catch { /* ignore */ }
  try { if (llmSrv) { llmSrv.closeAllConnections?.(); llmSrv.close(); } } catch { /* ignore */ }
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
