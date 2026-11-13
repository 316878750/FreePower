/**
 * AI Agent 判定门 A 层（0.4.0）—— **不启内核**，全部走假 CDP / 纯函数。
 *
 * 断言清单来自巡检（CEO 转达），A1–A5 一条不多一条不少：
 *   A1 批完改盘上任务 → run 当场 100002 + field=digest，状态仍 approved（含反例）
 *   A2 没批完就 run → 100002 + field=status；不存在的 id → 100001；approve 不存在的 step → 100001
 *   A3 截图路径越界 → 解析层 100002（含执行层 resolveShotPath 的 Windows 大小写越界）
 *   A4 fill.value / cookie set 的值不出现在 status JSON（digest 还在）
 *   A5 text 超 10KB / cookie value 超 4KB → 截断 + truncated + original_len（含未超限不带键）
 *
 * B 层（真内核 happy path / 失败即停 / 超时 / 跑完浏览器仍 Active）在
 * `test/agent-smoke.test.mjs`，属于 `npm run smoke`，**不进** `npm test`。
 *
 * 数据目录一次性：`<repo>/.tmp/pa2-agent-test-<pid>`，跑完删；不碰 `%APPDATA%\FreePower`。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  createWorkflow, getWorkflow, approveStep, presentWorkflow, assertWorkflowRunnable,
} = await import('../src/agent/workflow.js');
const {
  parseBrowserTask, runBrowserTask, resolveShotPath,
} = await import('../src/agent/task.js');

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
