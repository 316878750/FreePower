/**
 * AI Agent 判定门 A 层（0.4.0）—— **不启内核**，全部走假 CDP / 纯函数 / 本地 mock LLM。
 *
 * 断言清单来自巡检（CEO 转达），A1–A5 一条不多一条不少：
 *   A1 批完改盘上任务 → run 当场 100002 + field=digest，状态仍 approved（含反例）
 *   A2 没批完就 run → 100002 + field=status；不存在的 id → 100001；approve 不存在的 step → 100001
 *   A3 截图路径越界 → 解析层 100002（含执行层 resolveShotPath 的 Windows 大小写越界）
 *   A4 fill.value / cookie set 的值不出现在 status JSON（digest 还在）
 *   A5 text 超 10KB / cookie value 超 4KB → 截断 + truncated + original_len（含未超限不带键）
 *
 * 0.4.0 收尾补的 LLM 判定（同样不进 `npm test` 之外的任何东西）：
 *   A6/A7 合法 JSON 与 ```json 围栏都过；prompt 只有 goal + 动作清单，body 里没有 key、也没塞 profile 数据
 *   A8 未知动作 / 未知字段 / 空数组 / 超 20 步 → 100002 + field
 *   A9 401 / 500 / 超时 / 非 JSON：reason 与文案各不相同、code 不新造（-1）、文案里没有 key
 *   A10 生成的动作直接建工作流 → 每步 64 位 digest 且全 pending_approval
 *   A11 没配 / goal 空 → 100002 带 field；redactKey 不吐原文
 *   A12 `params` 走 `TASK_SPECS` 白名单（fail-closed）：键 ⊆ required+optional、
 *       裸对象里的 `secret:'SENT'` 不出现、`value` 一律 `***`（2026-11-13 CEO 纠偏 ⓪）
 *
 * B 层（真内核 happy path / 失败即停 / 超时 / 跑完浏览器仍 Active）在
 * `test/agent-smoke.test.mjs`，属于 `npm run smoke`，**不进** `npm test`。
 *
 * 数据目录一次性：`<repo>/.tmp/pa2-agent-test-<pid>`，跑完删；不碰 `%APPDATA%\FreePower`。
 * **不联网**：mock LLM 是 `node:http` 起在 127.0.0.1 的随机端口上。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(repoRoot, '.tmp', `pa2-agent-test-${process.pid}`);

// 必须在 import 业务模块之前设：config 在模块求值时读 env
process.env.FREEPOWER_DATA = DATA;
process.env.FREEPOWER_AGENT_STEP_TIMEOUT = '4000';
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const { AGENT_WORKFLOW_DIR } = await import('../src/config.js');
const {
  createWorkflow, getWorkflow, approveStep, presentWorkflow, presentTaskParams, assertWorkflowRunnable,
} = await import('../src/agent/workflow.js');
const {
  parseBrowserTask, runBrowserTask, resolveShotPath, TASK_ACTIONS, TASK_SPECS,
} = await import('../src/agent/task.js');
const {
  planTasksFromGoal, resolveLlmConfig, redactKey, LLM_TASK_LIMIT,
} = await import('../src/agent/llm.js');

after(() => {
  fs.rmSync(DATA, { recursive: true, force: true });
});

const OPEN_1 = { action: 'open', url: 'http://127.0.0.1:9/a' };
const OPEN_2 = { action: 'open', url: 'http://127.0.0.1:9/b' };

/** 建一个工作流并把每步都批掉（用内存里算出来的 digest） */
function approvedWorkflow(tasks) {
  const wf = createWorkflow({ profile_id: 'profile-for-tests', goal: 'gate', tasks });
  for (const s of wf.steps) approveStep(wf.id, { step_id: s.step_id, decision: 'approve', digest: s.digest });
  return getWorkflow(wf.id);
}

/** 读盘上那份工作流文件 */
function onDisk(wf) {
  return JSON.parse(fs.readFileSync(path.join(AGENT_WORKFLOW_DIR, `${wf.id}.json`), 'utf8'));
}

/** 断言抛出的错误形状（WorkflowError / TaskError / ExecutionError 都带 code） */
function throwsWith(fn, { code, field, reason, match }) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, '期望抛错，实际没抛');
  if (code !== undefined) assert.equal(err.code, code, `code 应为 ${code}，实际 ${err.code}（${err.message}）`);
  if (field !== undefined) assert.equal(err.field, field, `field 应为 ${field}，实际 ${err.field}（${err.message}）`);
  if (reason !== undefined) assert.equal(err.reason, reason, `reason 应为 ${reason}，实际 ${err.reason}（${err.message}）`);
  if (match) assert.match(String(err.message), match, `message 应匹配 ${match}，实际：${err.message}`);
  return err;
}

/* ============================================================================
 * A1：批完改盘上任务 → run 当场 100002 + field=digest，状态仍 approved
 * ==========================================================================*/
test('A1 盘上任务被改过：assertWorkflowRunnable 当场 100002 + field=digest，状态仍 approved', () => {
  const wf = approvedWorkflow([OPEN_1, { action: 'text', selector: '#x' }]);
  assert.equal(wf.state, 'approved', '两步批完应为 approved');
  assert.ok(wf.steps.every((s) => s.state === 'approved'));

  // 反例（成对）：盘上不动，同一条必须过
  assertWorkflowRunnable(getWorkflow(wf.id));

  // 直接改盘上那份：把第一步的 url 换掉，**内存不动**
  const disk = onDisk(wf);
  disk.steps[0].task.url = 'http://127.0.0.1:9/changed';
  fs.writeFileSync(path.join(AGENT_WORKFLOW_DIR, `${wf.id}.json`), JSON.stringify(disk, null, 2));

  throwsWith(() => assertWorkflowRunnable(getWorkflow(wf.id)), {
    code: 100002, field: 'digest', match: /digest does not match/,
  });

  // 报错之后：状态还是 approved，一步都没进 running
  const after = presentWorkflow(getWorkflow(wf.id));
  assert.equal(after.status, 'approved', `报错后状态必须仍是 approved，实际 ${after.status}`);
  assert.ok(after.steps.every((s) => s.status === 'approved'), JSON.stringify(after.steps.map((s) => s.status)));
});

/* ============================================================================
 * A2：没批完就 run → 100002 + field=status；不存在的 id → 100001
 * ==========================================================================*/
test('A2 没批完 / 不存在的工作流 / 不存在的 step', () => {
  // created（一步没批）
  const fresh = createWorkflow({ profile_id: 'profile-for-tests', tasks: [OPEN_1, OPEN_2] });
  throwsWith(() => assertWorkflowRunnable(getWorkflow(fresh.id)), {
    code: 100002, field: 'status', match: /workflow is created/,
  });

  // 只批第一步，第二步还是 pending_approval
  const half = createWorkflow({ profile_id: 'profile-for-tests', tasks: [OPEN_1, OPEN_2] });
  approveStep(half.id, { step_id: 'step-1', decision: 'approve', digest: half.steps[0].digest });
  const halfState = getWorkflow(half.id);
  assert.equal(halfState.state, 'created');
  assert.equal(halfState.steps[1].state, 'pending_approval');
  throwsWith(() => assertWorkflowRunnable(halfState), { code: 100002, field: 'status' });

  // 不存在的 workflow id
  assert.equal(getWorkflow('does-not-exist'), null);
  throwsWith(() => assertWorkflowRunnable(null), { code: 100001, match: /Workflow does not exist/ });

  // approve 不存在的 step_id
  throwsWith(() => approveStep(fresh.id, { step_id: 'step-9', decision: 'approve' }), {
    code: 100001, field: 'step_id', match: /Step does not exist/,
  });
});

/* ============================================================================
 * A3：截图路径越界 → 解析层 100002（含执行层 Windows 大小写越界）
 * ==========================================================================*/
test('A3 截图路径：解析层挡越界，执行层挡大小写不同的越界', () => {
  const badPaths = [
    '../x.png', 'a/../../x.png', 'C:/x.png', '/tmp/x.png', 'a\\..\\x.png',
    '', '.'.repeat(201) + '.png', 'x.jpg', './a.png',
  ];
  for (const p of badPaths) {
    throwsWith(() => parseBrowserTask({ action: 'screenshot', path: p }), {
      code: 100002, field: 'path',
    });
  }

  // 正例：合法相对路径解析后仍是相对路径
  const okTask = parseBrowserTask({ action: 'screenshot', path: 'shots/a.png' });
  assert.equal(okTask.path, 'shots/a.png');

  // 执行层：Windows 下大小写不敏感 —— 用大小写不同的段名 + `..` 爬出去，必须挡
  const dir = path.join(DATA, 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const caseDir = path.join(DATA, 'SCREENSHOTS'); // Windows 上是同一个目录，只是大小写不同
  throwsWith(() => resolveShotPath('..\\SCREENSHOTS\\..\\outside.png', caseDir, ''), {
    code: 100002, reason: 'screenshot_path_invalid',
  });
  // 普通越界同样挡
  throwsWith(() => resolveShotPath('..\\outside.png', dir, ''), {
    code: 100002, reason: 'screenshot_path_invalid',
  });
  // 正例：目录内、同大小写
  const ok = resolveShotPath('ok.png', dir, '');
  assert.equal(ok.rel, 'ok.png');
  assert.equal(ok.abs, path.resolve(dir, 'ok.png'));
});

/* ============================================================================
 * A4：fill.value / cookie set 的值不出现在 status JSON
 * ==========================================================================*/
test('A4 敏感值不回吐：status JSON 里搜不到 fill / cookie set 的值，digest 还在', async () => {
  const FILL = 'SENTINEL_FILL_9f3a';
  const COOKIE = 'SENTINEL_COOKIE_9f3a';

  const wf = approvedWorkflow([
    { action: 'fill', selector: '#pw', value: FILL },
    { action: 'cookie', op: 'set', name: 'tok', value: COOKIE, url: 'http://127.0.0.1:9/' },
  ]);

  const json = JSON.stringify(presentWorkflow(wf));
  assert.equal(json.split(FILL).length - 1, 0, 'fill 的值不应出现在 status JSON 里');
  assert.equal(json.split(COOKIE).length - 1, 0, 'cookie set 的值不应出现在 status JSON 里');
  // 摘要必须在（否则「批的是哪条」就无从核对）
  assert.ok(wf.steps.every((s) => /^[0-9a-f]{64}$/.test(s.digest)), '每步都应带 64 位 digest');

  // 真跑一遍（假 CDP）：结果只有 {ok, took_ms}，没有 value
  const fillResult = await runBrowserTask(
    parseBrowserTask({ action: 'fill', selector: '#pw', value: FILL }),
    { send: async (method) => (method === 'Runtime.evaluate' ? { result: { value: { ok: true } } } : {}) },
  );
  assert.deepEqual(Object.keys(fillResult).sort(), ['ok', 'took_ms'], JSON.stringify(fillResult));
  assert.equal(String(fillResult.ok), 'true');

  const cookieResult = await runBrowserTask(
    parseBrowserTask({ action: 'cookie', op: 'set', name: 'tok', value: COOKIE, url: 'http://127.0.0.1:9/' }),
    {
      send: async (method) => {
        if (method === 'Network.setCookie') return { success: true };
        if (method === 'Runtime.evaluate') return { result: { value: 'http://127.0.0.1:9' } };
        return {};
      },
    },
  );
  assert.deepEqual(Object.keys(cookieResult).sort(), ['ok', 'took_ms'], JSON.stringify(cookieResult));

  // 把结果挂到工作流上再序列化一遍：哨兵仍然 0 次
  wf.steps[0].result = fillResult;
  wf.steps[1].result = cookieResult;
  const after = JSON.stringify(presentWorkflow(wf));
  assert.equal(after.split(FILL).length - 1, 0);
  assert.equal(after.split(COOKIE).length - 1, 0);
});

/* ============================================================================
 * A5：text 10KB / cookie 4KB 截断（假 CDP）
 * ==========================================================================*/
const evalReturning = (value) => async (method) => (method === 'Runtime.evaluate'
  ? { result: { value } }
  : {});

test('A5 text 超 10KB：按 UTF-8 字节截断，不切坏多字节字符', async () => {
  // 10239 个 'a' + '你'（3 字节，正好骑在 10240 边界上）+ 尾巴
  const big = 'a'.repeat(10239) + '你' + 'b'.repeat(100);
  const r = await runBrowserTask(
    parseBrowserTask({ action: 'text', selector: '#t' }),
    { send: evalReturning({ ok: true, value: big }) },
  );
  assert.equal(Buffer.byteLength(r.value, 'utf8') <= 10240, true, `截断后 ${Buffer.byteLength(r.value, 'utf8')} B`);
  assert.equal(r.truncated, true);
  assert.equal(r.original_len, Buffer.byteLength(big, 'utf8'));
  assert.equal(Buffer.from(r.value, 'utf8').toString('utf8'), r.value, '重新编码不应抛/变样');
  assert.equal(r.value.includes('\uFFFD'), false, '截断不许出现替换字符');
  assert.equal(r.value.endsWith('a'), true, '应退到字符边界（最后一个完整字符是 a）');

  // 未超限：没有 truncated / original_len 这两个键（不是 truncated:false）
  const short = await runBrowserTask(
    parseBrowserTask({ action: 'text', selector: '#t' }),
    { send: evalReturning({ ok: true, value: 'short' }) },
  );
  assert.deepEqual(Object.keys(short), ['value'], JSON.stringify(short));
  assert.equal(short.value, 'short');

  // 恰好 10240 字节：不截断、不带键
  const exact = 'x'.repeat(10240);
  const edge = await runBrowserTask(
    parseBrowserTask({ action: 'text', selector: '#t' }),
    { send: evalReturning({ ok: true, value: exact }) },
  );
  assert.deepEqual(Object.keys(edge), ['value']);
  assert.equal(Buffer.byteLength(edge.value, 'utf8'), 10240);
});

test('A5 cookie value 超 4KB：单条截断，恰好 4096 不截断', async () => {
  const cookie = (value) => async (method) => {
    if (method === 'Network.enable') return {};
    if (method === 'Network.getCookies') {
      return { cookies: [{ name: 'big', value, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }] };
    }
    return {};
  };

  const bigVal = 'v'.repeat(6000);
  const r = await runBrowserTask(
    parseBrowserTask({ action: 'cookie', op: 'get', url: 'http://127.0.0.1:9/' }),
    { send: cookie(bigVal) },
  );
  assert.equal(r.cookies.length, 1);
  assert.equal(Buffer.byteLength(r.cookies[0].value, 'utf8'), 4096);
  assert.equal(r.cookies[0].truncated, true);
  assert.equal(r.cookies[0].original_len, 6000);

  const exactVal = 'w'.repeat(4096);
  const edge = await runBrowserTask(
    parseBrowserTask({ action: 'cookie', op: 'get', url: 'http://127.0.0.1:9/' }),
    { send: cookie(exactVal) },
  );
  assert.equal(Buffer.byteLength(edge.cookies[0].value, 'utf8'), 4096);
  assert.equal('truncated' in edge.cookies[0], false, '恰好 4096 不该带 truncated');
  assert.equal('original_len' in edge.cookies[0], false);
});

/* ============================================================================
 * LLM 判定（A6–A11）：mock LLM 起在 127.0.0.1 随机端口，**不联网**
 * ==========================================================================*/

const KEY = 'sk-gate-0123456789abcdef';

/**
 * 起一个本地 mock OpenAI 兼容端点。
 * @param {(req:{headers:object, body:string}) => object} reply
 *        返回 `{status?, json?, text?, type?, hang?}`；`hang:true` = 永不回应（超时用）
 */
async function mockLlm(reply) {
  const state = { last: null };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      state.last = { headers: req.headers, body: raw };
      const r = reply({ headers: req.headers, body: raw }) || {};
      if (r.hang) return;
      res.writeHead(r.status || 200, { 'content-type': r.type || 'application/json' });
      res.end(r.text !== undefined ? r.text : JSON.stringify(r.json ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () => { try { server.closeAllConnections?.(); } catch { /* ignore */ } server.close(); },
  };
}

/** 一次指向 mock 的显式配置（不读 AGENT_LLM_*，测试不依赖本机环境） */
const llmCfg = (base, extra = {}) => ({ endpoint: base, key: KEY, model: 'mock-model', timeout_ms: 3000, ...extra });
const replyWith = (content) => ({ json: { choices: [{ message: { content } }], usage: { total_tokens: 7 } } });

test('A6 合法 JSON / ```json 围栏 / 前后空白都能过，canonicalTask 后键序稳定', async () => {
  const good = JSON.stringify([
    { action: 'open', url: 'http://127.0.0.1:9/a' },
    { selector: 'h1', action: 'text' }, // 故意把键序写反
  ]);
  for (const content of [good, '```json\n' + good + '\n```', `  ${good}  `]) {
    const m = await mockLlm(() => replyWith(content));
    try {
      const r = await planTasksFromGoal(llmCfg(m.base), { goal: '打开本地页读标题' });
      assert.equal(r.tasks.length, 2, content.slice(0, 30));
      assert.equal(r.tasks[0].action, 'open');
      assert.equal(JSON.stringify(Object.keys(r.tasks[1])), '["action","selector"]', '键序应按字典序稳定');
      assert.equal(r.model, 'mock-model');
      assert.equal(r.usage?.total_tokens, 7);
    } finally { m.close(); }
  }
});

test('A7 prompt 只带 goal + 动作清单：body 里没有 key、没有 profile 的 cookie/UA/代理', async () => {
  const m = await mockLlm(() => replyWith('[{"action":"wait","ms":5}]'));
  try {
    await planTasksFromGoal(llmCfg(m.base), { goal: 'GOAL_SENTINEL_A7' });
    const { headers, body } = m.state.last;
    const sent = JSON.parse(body);
    assert.equal(sent.messages.length, 2, 'system + user 两条');
    assert.equal(sent.messages[0].role, 'system');
    assert.equal(sent.messages[1].content, 'GOAL_SENTINEL_A7');
    for (const a of TASK_ACTIONS) assert.ok(body.includes(a), `动作清单里应该有 ${a}`);
    assert.equal(/SENTINEL_(COOKIE|UA|PROXY)/.test(body), false, '不许把 profile 数据拼进 prompt');
    assert.equal(body.includes(KEY), false, 'key 只能进 Authorization 头，不能进 body');
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    assert.equal(sent.model, 'mock-model');
  } finally { m.close(); }
});

test('A8 未知动作 / 未知字段 / 空数组 / 超 20 步：100002 + field', async () => {
  const many = JSON.stringify(Array.from({ length: LLM_TASK_LIMIT + 1 }, (_, i) => ({ action: 'open', url: `https://a.test/${i}` })));
  const cases = [
    ['[{"action":"hover","selector":"#a"}]', 'tasks[0].action', /unsupported action/],
    ['[{"action":"open","url":"https://a.test","cookie":"x"}]', 'tasks[0].cookie', /unknown field/],
    ['[]', 'tasks', /空数组/],
    [many, 'tasks', /超过上限/],
  ];
  assert.equal(LLM_TASK_LIMIT, 20, '模型一次最多 20 步（别和 parseTaskList 的 200 混）');
  for (const [content, field, match] of cases) {
    const m = await mockLlm(() => replyWith(content));
    try {
      await assert.rejects(() => planTasksFromGoal(llmCfg(m.base), { goal: 'x' }), (e) => {
        assert.equal(e.code, 100002, `${field}: code 应为 100002，实际 ${e.code}（${e.message}）`);
        assert.equal(e.field, field);
        assert.match(e.message, match);
        return true;
      });
    } finally { m.close(); }
  }
});

test('A9 401 / 500 / 超时 / 非 JSON：reason 与文案各不相同，code 不新造，都不含 key', async () => {
  const cases = [
    [{ status: 401, json: { error: { message: `invalid key ${KEY}` } } }, 'llm_unauthorized'],
    [{ status: 500, text: 'upstream boom' }, 'llm_upstream_error'],
    [{ hang: true }, 'llm_timeout'],
    [{ text: '<html>gateway</html>', type: 'text/html' }, 'llm_bad_json'],
  ];
  const messages = new Set();
  for (const [reply, reason] of cases) {
    const m = await mockLlm(() => reply);
    try {
      const t0 = Date.now();
      await assert.rejects(() => planTasksFromGoal(llmCfg(m.base, { timeout_ms: 300 }), { goal: 'x' }), (e) => {
        assert.equal(e.reason, reason, `实际 ${e.reason}：${e.message}`);
        assert.equal(e.code, -1, '上游那一层用 -1（通用失败），不发明新码');
        assert.equal(String(e.message).includes(KEY), false, `文案里不许出现 key：${e.message}`);
        assert.ok(String(e.message).length > 10, '错误文案要能定位，不能是空话');
        messages.add(e.message);
        return true;
      });
      if (reason === 'llm_timeout') assert.ok(Date.now() - t0 >= 250, `超时该真的等过：${Date.now() - t0}ms`);
    } finally { m.close(); }
  }
  assert.equal(messages.size, cases.length, '四档文案必须各不相同，不能一句"LLM 失败"糊过去');
});

test('A10 生成的动作直接建工作流：每步 64 位 digest 且全 pending_approval', async () => {
  const m = await mockLlm(() => replyWith('[{"action":"open","url":"http://127.0.0.1:9/a"},{"action":"wait","selector":"#x"}]'));
  try {
    const plan = await planTasksFromGoal(llmCfg(m.base), { goal: 'gate' });
    const view = presentWorkflow(createWorkflow({ profile_id: 'profile-for-tests', goal: 'gate', tasks: plan.tasks }));
    assert.equal(view.status, 'created');
    assert.deepEqual(view.steps.map((s) => s.action), ['open', 'wait']);
    assert.ok(view.steps.every((s) => s.status === 'pending_approval'), JSON.stringify(view.steps.map((s) => s.status)));
    assert.ok(view.steps.every((s) => /^[0-9a-f]{64}$/.test(s.digest)), JSON.stringify(view.steps.map((s) => s.digest)));
    // 参数摘要要给审批的人看，但 model 的键序不影响 digest
    assert.equal(view.steps[1].params.selector, '#x');
  } finally { m.close(); }
});

test('A11 没配 / goal 空 → 100002 带 field；redactKey 不吐原文', async () => {
  assert.equal(resolveLlmConfig({ endpoint: '', key: '', model: '' }).configured, false);
  await assert.rejects(() => planTasksFromGoal({ endpoint: '', key: '', model: '' }, { goal: 'x' }), (e) => {
    assert.equal(e.code, 100002);
    assert.equal(e.field, 'llm');
    assert.match(e.message, /未配置/);
    return true;
  });

  // goal 空：在发请求之前就该拦下（endpoint 指向一个没人监听的端口，真发出去会变成 llm_unreachable）
  await assert.rejects(() => planTasksFromGoal(llmCfg('http://127.0.0.1:9'), { goal: '   ' }), (e) => {
    assert.equal(e.code, 100002);
    assert.equal(e.field, 'goal');
    return true;
  });

  assert.equal(redactKey(KEY).includes(KEY), false);
  assert.equal(redactKey('short').includes('short'), false);
  assert.equal(redactKey(''), '');
});

/* ============================================================================
 * A12：params 走 TASK_SPECS 白名单（fail-closed）
 *
 * 背景（2026-11-13 CEO 纠偏 ⓪）：原来的 `presentTaskParams` 是「复制所有键、只把 value 打码」，
 * 安全性押在上游 `canonicalTask` 兜底上 —— 哪天有人给它一个没经过 parseTaskList 的对象
 * （或上游加了个直通字段），敏感键就漏出去了。改成只遍历该动作 `required + optional` 的键，
 * 没登记过的**不出现**，不依赖上游。
 * ==========================================================================*/

/** 每个动作一份「全字段」任务：required + optional 全给上，再塞两个不该出现的键 */
const FULL_FIELD_CASES = {
  open: { action: 'open', url: 'http://127.0.0.1:9/a' },
  click: { action: 'click', selector: '#btn' },
  fill: { action: 'fill', selector: '#pw', value: 'SENT_FILL' },
  wait: { action: 'wait', selector: '#x', ms: 10, until: 'visible' },
  text: { action: 'text', selector: 'h1', save_as: 'title' },
  screenshot: { action: 'screenshot', full_page: true, path: 'shots/a.png' },
  cookie: { action: 'cookie', op: 'set', name: 'tok', value: 'SENT_COOKIE', url: 'http://127.0.0.1:9/' },
};

test('A12 每个动作的 params 键 ⊆ TASK_SPECS 的 required+optional，且没有 action 本身', () => {
  assert.deepEqual(Object.keys(FULL_FIELD_CASES).sort(), [...TASK_ACTIONS].sort(), '七动作一个不能漏');

  for (const [action, task] of Object.entries(FULL_FIELD_CASES)) {
    const spec = TASK_SPECS[action];
    assert.ok(spec, `${action} 必须在 TASK_SPECS 里登记`);
    const allowed = new Set([...spec.required, ...spec.optional]);
    const keys = Object.keys(presentTaskParams(task));
    for (const k of keys) {
      assert.ok(allowed.has(k), `${action}: params 里出现了没登记的键 ${k}（allowed=${[...allowed].join(',')}）`);
    }
    assert.equal(keys.includes('action'), false, `${action}: params 里不该再带 action`);
    // 该给的都得给：required 一个不少
    for (const k of spec.required) {
      assert.ok(keys.includes(k), `${action}: required 的 ${k} 必须出现在 params 里（审批的人要看）`);
    }
  }
});

test('A12 裸对象里的 secret / 未登记键不出现（不依赖上游 canonicalTask 兜底）', () => {
  const dirty = {
    action: 'fill',
    selector: '#pw',
    value: 'SENT_VALUE',
    secret: 'SENT_SECRET',
    token: 'SENT_TOKEN',
    __proto__x: 'SENT_PROTO',
  };
  const params = presentTaskParams(dirty);
  const json = JSON.stringify(params);
  assert.equal(json.includes('SENT_SECRET'), false, `secret 漏了：${json}`);
  assert.equal(json.includes('SENT_TOKEN'), false, `token 漏了：${json}`);
  assert.equal(json.includes('SENT_PROTO'), false, `未登记键漏了：${json}`);
  assert.equal('secret' in params, false);
  assert.equal('token' in params, false);
  assert.deepEqual(Object.keys(params).sort(), ['selector', 'value'], JSON.stringify(params));

  // 动作都没登记 / 不是对象 → 空对象，不抛、不猜
  assert.deepEqual(presentTaskParams({ action: 'hover', selector: '#a' }), {});
  assert.deepEqual(presentTaskParams({ selector: '#a' }), {});
  assert.deepEqual(presentTaskParams(null), {});
  assert.deepEqual(presentTaskParams(undefined), {});
  assert.deepEqual(presentTaskParams('open'), {});
});

test('A12 value 一律 ***（fill / cookie set），其余字段原样', () => {
  // 直接喂：两种带 value 的动作
  for (const task of [FULL_FIELD_CASES.fill, FULL_FIELD_CASES.cookie]) {
    const p = presentTaskParams(task);
    assert.equal(p.value, '***', `${task.action}: value 必须是 ***，实际 ${p.value}`);
    assert.equal(JSON.stringify(p).includes(task.value), false, `${task.action}: 原文不该出现在 params 里`);
  }
  // 不带 value 的动作：不许凭空多出一个 value
  assert.equal('value' in presentTaskParams(FULL_FIELD_CASES.click), false);
  // 非敏感字段原样保留（审批的人得看得见自己在批什么）
  const shot = presentTaskParams(FULL_FIELD_CASES.screenshot);
  assert.equal(shot.path, 'shots/a.png');
  assert.equal(shot.full_page, true);
  assert.equal(presentTaskParams(FULL_FIELD_CASES.wait).ms, 10);

  // 走一遍 presentWorkflow：status JSON 里也必须是 ***，且原值 0 次
  const wf = createWorkflow({
    profile_id: 'profile-for-tests',
    goal: 'A12',
    tasks: [
      { action: 'fill', selector: '#pw', value: 'SENT_VIA_WF_FILL' },
      { action: 'cookie', op: 'set', name: 'tok', value: 'SENT_VIA_WF_COOKIE', url: 'http://127.0.0.1:9/' },
    ],
  });
  const view = presentWorkflow(wf);
  assert.equal(view.steps[0].params.value, '***');
  assert.equal(view.steps[1].params.value, '***');
  const json = JSON.stringify(view);
  assert.equal(json.includes('SENT_VIA_WF_FILL'), false);
  assert.equal(json.includes('SENT_VIA_WF_COOKIE'), false);
  // 没登记过的键（哪怕有人往盘上塞）不会因为 presentWorkflow 就漏出来
  assert.equal(json.includes('"task"'), false, '不许回吐 task 原对象');
});
