/**
 * 工作流容器（0.4.0 AI Agent）。
 *
 * 一次工作流 = **1 个环境 + N 条 `browser_task` + 每步一次人工审批**。
 * 范围按 CEO 拍的口径：不做并发池、不做 `browser-worker` 编排、不做技能市场。
 *
 * 状态机：
 *
 *   created ──approve──▶ approved ──runWorkflow──▶ running ──▶ completed
 *      │                     │                        │
 *      └──reject──▶ rejected └──────────────────┘     └──▶ failed / aborted
 *
 * **HITL 是硬约束**：每一步默认 `pending_approval`，`AGENT_HITL_DEFAULT` 默认 `deny`；
 * 没有 `approve` 的步一步都不许执行。审批单带 `digest`（`task.js` 的 `digestTask`），
 * 防"批的是 A、跑的是 B"——**执行每一步之前还会从盘上再核一次**（批完到真跑之间，
 * 文件是可能被外部改的）。
 *
 * 执行（`runWorkflow`）：环境没起来就调 `cli.startBrowser` 拉起来；**跑完不关浏览器**
 * （用户可能还要看页面，关是用户的事）。单步失败/超时不重试、不跳过，整条工作流落 `failed`。
 *
 * 存储：`DATA_DIR/agent/workflows/<id>.json`，一个工作流一个文件，**每次状态转移都落盘**
 * （`<id>.json.tmp` → `rename`，半写崩进程只留 `.tmp`，读侧跳过），与对手的
 * `RUNTIME_PATH=<data>\ai_agent` + `/conversation_history/` 同构（逆向 `24-` §4.4）。
 * 重启时扫目录恢复；**`running` 一律落成 `aborted`** —— 重启意味着那次执行已经没了
 * （浏览器那边早没了），不能留在 `running` 上假装还在跑。终态就地保留、不进归档目录。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseTaskList, digestTask, runBrowserTask, TaskError, NotImplementedError } from './task.js';
import { createCli } from './cli.js';
import { getMeta } from '../store/db.js';
import { CdpClient } from '../kernel/cdp.js';
import { AGENT_HITL_DEFAULT, AGENT_WORKFLOW_DIR } from '../config.js';

export const WORKFLOW_STATES = ['created', 'approved', 'running', 'completed', 'failed', 'rejected', 'aborted'];
const TERMINAL = new Set(['completed', 'failed', 'rejected', 'aborted']);

export class WorkflowError extends Error {
  constructor(code, message, { field = '' } = {}) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
    this.field = field;
  }
}

/**
 * 进程内热副本。**盘上那份才是权威**：`Map` 只做读加速，状态转移一律先落盘
 * （反过来就会出现「内存 approved、重启丢审批」）。
 */
const workflows = new Map();
let loaded = false;

export function isTerminal(state) {
  return TERMINAL.has(state);
}

function warn(msg) {
  try { console.warn(`[agent] ${msg}`); } catch { /* ignore */ }
}

/**
 * 原子写：先写 `<id>.json.tmp` 再 `rename` —— 崩在写一半只留 `.tmp`，
 * 正式文件要么是上一版、要么是新版，不可能是半截 JSON。
 * 落盘失败不改内存里的结论，但必须留痕（否则调用方以为重启还读得到）。
 */
function saveWorkflow(wf) {
  const file = path.join(AGENT_WORKFLOW_DIR, `${wf.id}.json`);
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(AGENT_WORKFLOW_DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(wf, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    warn(`工作流落盘失败 ${wf.id}：${e.message}`);
    return false;
  }
}

/**
 * 扫 `DATA_DIR/agent/workflows/` 把工作流收进内存（幂等）。
 * 启动时调一次；`getWorkflow` / `listWorkflows` 再兜一次（模块被单独 import 时也能读到盘）。
 * 坏文件只跳过并告警：一个半写的 JSON 不该让整个 Agent 起不来。
 *
 * **不做跨进程同步**：扫一次就置 `loaded`，之后以本进程内存为准。同一个 DATA_DIR 上
 * 起第二个 API 进程读不到对方后写的工作流 —— 一个数据目录只该有一个 API 进程
 * （发现文件 `data/local_api` 也只指向一个端口），多进程互斥不在本轮范围。
 */
export function loadWorkflows() {
  if (loaded) return [...workflows.values()];
  loaded = true;
  let names = [];
  try { names = fs.readdirSync(AGENT_WORKFLOW_DIR); } catch { return []; } // 第一次跑：目录还不存在
  for (const name of names) {
    if (!name.endsWith('.json')) continue; // `.json.tmp` 是没写完的残骸，别当正式记录
    const file = path.join(AGENT_WORKFLOW_DIR, name);
    let wf;
    try { wf = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      warn(`工作流文件读不了，跳过 ${name}：${e.message}`);
      continue;
    }
    if (!wf || typeof wf.id !== 'string' || !Array.isArray(wf.steps)) {
      warn(`工作流文件形状不对，跳过 ${name}`);
      continue;
    }
    if (wf.state === 'running') {
      // 重启 = 那次执行已经中断（浏览器那边早没了）。落 aborted，别留在 running 上骗人。
      // 错误码用 -1（通用失败）：码表里没有「中断」这一项，不为它新造一个码。
      wf.state = 'aborted';
      wf.error = { code: -1, msg: 'process restarted while running' };
      wf.updated_at = new Date().toISOString();
      saveWorkflow(wf);
    }
    workflows.set(wf.id, wf);
  }
  return [...workflows.values()];
}

/**
 * 建一个工作流：校验任务、给每步算审批 digest、置 `pending_approval`。
 * 不启动浏览器、不调模型（那是执行器的事）。
 *
 * @param {object} input
 * @param {string} input.profile_id 环境 id（调用方负责确认这个环境存在）
 * @param {string} [input.goal] 人类可读的目标，进日志与 UI
 * @param {object[]} input.tasks `browser_task` 数组
 * @returns {object} 内部记录（对外形状用 `presentWorkflow`）
 */
export function createWorkflow({ profile_id: profileId, goal = '', tasks } = {}) {
  if (!profileId || typeof profileId !== 'string') throw new WorkflowError(100002, 'profile_id is required', { field: 'profile_id' });
  const parsed = parseTaskList(tasks); // TaskError（100002）直接往上抛，路由层统一转 ApiError
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const wf = {
    id,
    profile_id: profileId,
    goal: String(goal ?? ''),
    state: 'created',
    created_at: now,
    updated_at: now,
    /** 每一步：审批状态 + digest + 执行结果（结果形状见 presentWorkflow / README） */
    steps: parsed.map((task, i) => ({
      step_id: `step-${i + 1}`,
      index: i,
      task,
      digest: digestTask(task),
      state: 'pending_approval',
      approved_at: null,
      decision: null,
      result: null,
      reason: null,
      started_at: null,
      finished_at: null,
    })),
    /** 执行器：`cdp` = 本地 CDP 真执行（对手那是云端 Agent Core，见 24- 契约） */
    executor: 'cdp',
    started_at: null,
    finished_at: null,
    error: null,
  };
  workflows.set(id, wf);
  saveWorkflow(wf);
  return wf;
}

export function getWorkflow(id) {
  loadWorkflows();
  return workflows.get(String(id)) || null;
}

/** 只给测试/诊断用：别借它做业务逻辑（返回内存热副本，顺序不保证） */
export function listWorkflows() {
  return loadWorkflows();
}

/** 对外形状：不把内部 task 全量回吐（模型看到的 DSL 可能含敏感值），只回动作与摘要 */
export function presentWorkflow(wf) {
  if (!wf) return null;
  return {
    workflow_id: wf.id,
    profile_id: wf.profile_id,
    goal: wf.goal,
    status: wf.state,
    executor: wf.executor,
    created_at: wf.created_at,
    updated_at: wf.updated_at,
    steps: wf.steps.map((s) => ({
      step_id: s.step_id,
      action: s.task.action,
      status: s.state,
      digest: s.digest,
      decision: s.decision,
      approved_at: s.approved_at,
      // 结果只回「动作的产物」：不回 task 原文（fill 的值、cookie set 的值可能是密码/token）
      result: s.result ?? null,
      reason: s.reason ?? null,
      started_at: s.started_at ?? null,
      finished_at: s.finished_at ?? null,
    })),
    hitl: { default_decision: AGENT_HITL_DEFAULT, required: true },
    error: wf.error,
  };
}

/**
 * 审批一步（HITL）。**默认拒**：`decision` 缺省或不是 `approve` 都按 reject 处理。
 *
 * @param {string} id 工作流 id
 * @param {{step_id?:string, decision?:string, digest?:string}} input
 *        `step_id` 省略 = 批当前第一个待审步骤；`digest` 给了就必须与任务摘要一致
 */
export function approveStep(id, input = {}) {
  const wf = getWorkflow(id);
  if (!wf) throw new WorkflowError(100001, 'Workflow does not exist');
  if (isTerminal(wf.state)) throw new WorkflowError(100002, `workflow is ${wf.state}`, { field: 'status' });

  const decision = String(input.decision ?? '').trim().toLowerCase();
  if (decision !== 'approve') {
    // 显式 reject 与"没给/给错"都落到 reject：**默认拒**，不给含糊态
    return rejectStep(wf, input, decision === 'reject' ? 'rejected by user' : 'default deny');
  }
  const wanted = String(input.digest ?? '').trim();
  const step = pickStep(wf, input.step_id);
  if (wanted && wanted !== step.digest) {
    throw new WorkflowError(100002, 'digest does not match the step task（防"批 A 跑 B"）', { field: 'digest' });
  }
  if (step.state !== 'pending_approval') throw new WorkflowError(100002, `step ${step.step_id} is ${step.state}`, { field: 'step_id' });

  step.state = 'approved';
  step.decision = 'approve';
  step.approved_at = new Date().toISOString();

  // 所有步都批完了 → 工作流进 approved；单步批完仍是 created（还有别的步待审）
  if (wf.steps.every((s) => s.state === 'approved')) wf.state = 'approved';
  touch(wf); // 状态定稿后再落盘，别把「created + 一步已批」的中间态写出去
  return wf;
}

function pickStep(wf, stepId) {
  if (stepId === undefined || stepId === null || String(stepId).trim() === '') {
    const next = wf.steps.find((s) => s.state === 'pending_approval');
    if (!next) throw new WorkflowError(100001, 'no step is waiting for approval');
    return next;
  }
  const step = wf.steps.find((s) => s.step_id === String(stepId));
  if (!step) throw new WorkflowError(100001, 'Step does not exist', { field: 'step_id' });
  return step;
}

function rejectStep(wf, input, reason) {
  const step = pickStep(wf, input.step_id);
  if (step.state !== 'pending_approval') throw new WorkflowError(100002, `step ${step.step_id} is ${step.state}`, { field: 'step_id' });
  step.state = 'rejected';
  step.decision = 'reject';
  step.approved_at = new Date().toISOString();
  step.reason = reason;
  wf.state = 'rejected';
  wf.error = { code: 100002, msg: `step ${step.step_id}: ${reason}` };
  touch(wf);
  return wf;
}

/**
 * 只有「全部步都批过、且盘上任务没被改过」的 `approved` 工作流才许跑。
 * 同步函数：路由层可以在返回前就拿到参数错（100002 带 `data.field`），不必等异步任务。
 */
export function assertWorkflowRunnable(wf) {
  if (!wf) throw new WorkflowError(100001, 'Workflow does not exist');
  if (wf.state === 'running') throw new WorkflowError(100002, 'workflow is already running', { field: 'status' });
  if (wf.state !== 'approved') {
    throw new WorkflowError(100002, `workflow is ${wf.state}（要全部步批完的 approved 才能跑）`, { field: 'status' });
  }
  for (const step of wf.steps) {
    if (step.state !== 'approved') throw new WorkflowError(100002, `step ${step.step_id} is ${step.state}`, { field: 'step_id' });
    assertStepDigestOnDisk(wf.id, step);
  }
}

function readWorkflowFile(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(AGENT_WORKFLOW_DIR, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 执行前再核 digest（**读盘上的版本**）：`approveStep` 时核过一次，但持久化之后
 * 文件是可能被外部改的 —— 内存里那份改不到，盘上那份能改。不一致就拒绝执行。
 */
function assertStepDigestOnDisk(id, step) {
  const onDisk = readWorkflowFile(id);
  if (!onDisk) throw new WorkflowError(100001, 'workflow file is missing on disk（持久化文件没了，拒绝执行）', { field: 'workflow_id' });
  const filed = Array.isArray(onDisk.steps) ? onDisk.steps.find((s) => s.step_id === step.step_id) : null;
  if (!filed) throw new WorkflowError(100002, `step ${step.step_id} is missing on disk（文件被改过）`, { field: 'step_id' });
  if (digestTask(filed.task) !== step.digest || filed.digest !== step.digest) {
    throw new WorkflowError(100002, `step ${step.step_id}: digest does not match（审批后任务被改过）`, { field: 'digest' });
  }
}

/** 环境已在跑就直接用；没起来才拉起。**不负责关** —— 关浏览器是用户的事 */
async function ensureBrowser(cli, profileId) {
  const active = await cli.getBrowser(profileId);
  if (active && active.status === 'Active') return cli.cdpUrl(active);
  const started = await cli.startBrowser(profileId);
  return cli.cdpUrl(started);
}

/** 挑一个普通页面目标 attach；一个都没有就新建一张 about:blank */
async function openPageSession(client) {
  const { targetInfos = [] } = await client.send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page' && !/^(devtools|chrome-extension):/i.test(String(t.url || '')));
  const targetId = page?.targetId || (await client.send('Target.createTarget', { url: 'about:blank' })).targetId;
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  return sessionId;
}

/**
 * 跑工作流：按顺序执行**已审批**的步；任何一步失败/超时 → `failed` 并停（不重试、不跳过）。
 *
 * @param {string} id 工作流 id
 * @param {{cli?: object}} [opts] `cli` 是 `cli.js` 的本地 API 调用层；不给就按默认端口 +
 *        库里的 api_key 建一个（路由会显式传，避免端口猜错）
 * @returns {Promise<object>} 内部记录（对外形状用 `presentWorkflow`）
 */
export async function runWorkflow(id, { cli = null } = {}) {
  const wf = getWorkflow(id);
  assertWorkflowRunnable(wf); // 状态 + 每步审批 + 盘上 digest，错了同步抛

  // 先置 running 再 await：并发进来的第二个请求会被上面那条挡掉
  wf.state = 'running';
  wf.started_at = new Date().toISOString();
  wf.error = null;
  touch(wf);

  const tool = cli || createCli({ apiKey: getMeta('api_key') || '' });
  let client = null;
  try {
    const wsUrl = await ensureBrowser(tool, wf.profile_id);
    client = await CdpClient.connect(wsUrl, { timeoutMs: 15000 });
    const sessionId = await openPageSession(client);
    const send = (method, params = {}) => client.send(method, params, sessionId);

    for (const step of wf.steps) {
      // 执行前再核一次（读盘）：防「批完到真跑之间任务被改」
      try {
        assertStepDigestOnDisk(wf.id, step);
      } catch (e) {
        return failWorkflow(wf, step, e);
      }

      step.state = 'running';
      step.started_at = new Date().toISOString();
      touch(wf);

      try {
        step.result = await runBrowserTask(step.task, { send, screenshotName: `${wf.id}-${step.step_id}.png` });
      } catch (e) {
        return failWorkflow(wf, step, e);
      }
      step.state = 'completed';
      step.finished_at = new Date().toISOString();
      touch(wf);
    }

    wf.state = 'completed';
    wf.finished_at = new Date().toISOString();
    touch(wf);
    return wf;
  } catch (e) {
    // 起浏览器 / 连 CDP / 开页面失败：整条工作流 failed，不猜是哪一步
    wf.state = 'failed';
    wf.finished_at = new Date().toISOString();
    wf.error = {
      code: Number.isFinite(e?.code) ? e.code : -1,
      msg: e?.message || 'executor failed',
      step_id: runningStepId(wf),
      reason: e?.reason || 'browser_unavailable',
    };
    touch(wf);
    return wf;
  } finally {
    try { if (client) client.close(); } catch { /* 只关 CDP 连接，浏览器不动 */ }
  }
}

function runningStepId(wf) {
  const s = wf.steps.find((x) => x.state === 'running');
  return s ? s.step_id : null;
}

/** 单步失败：落 step + 整条工作流 `failed`（不重试、不跳过），返回工作流供调用方读状态 */
function failWorkflow(wf, step, e) {
  step.state = 'failed';
  step.finished_at = new Date().toISOString();
  step.reason = e?.reason || 'execution_failed';
  wf.state = 'failed';
  wf.finished_at = step.finished_at;
  wf.error = {
    code: Number.isFinite(e?.code) ? e.code : -1,
    msg: e?.message || 'step failed',
    step_id: step.step_id,
    reason: step.reason,
  };
  touch(wf);
  return wf;
}

export { TaskError, NotImplementedError };

function touch(wf) {
  wf.updated_at = new Date().toISOString();
  saveWorkflow(wf); // 每次状态转移都落盘：create / approve / reject / 执行器推进的每一跳
}
