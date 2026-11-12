/**
 * 工作流容器（0.4.0 AI Agent 骨架）。
 *
 * 一次工作流 = **1 个环境 + N 条 `browser_task` + 每步一次人工审批**。
 * 范围按 CEO 拍的口径：不做并发池、不做 `browser-worker` 编排、不做技能市场。
 *
 * 状态机（第一版只有前三个会真的出现，执行器未接）：
 *
 *   created ──approve──▶ approved ──(执行器)──▶ running ──▶ completed
 *      │                     │                     │
 *      └──reject──▶ rejected └─────────────┘        └──▶ failed / aborted
 *
 * **HITL 是硬约束**：每一步默认 `pending_approval`，`AGENT_HITL_DEFAULT` 默认 `deny`；
 * 没有 `approve` 的步一步都不许执行。审批单带 `digest`（`task.js` 的 `digestTask`），
 * 防"批的是 A、跑的是 B"。
 *
 * 这一版把**解析 + 审批 + 状态查询**做真，`runStep` 抛 `NotImplementedError` ——
 * 所以工作流会停在 `approved`，不会假装跑完。
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
    /** 每一步：审批状态 + digest；执行结果留到执行器接上再填 */
    steps: parsed.map((task, i) => ({
      step_id: `step-${i + 1}`,
      index: i,
      task,
      digest: digestTask(task),
      state: 'pending_approval',
      approved_at: null,
      decision: null,
    })),
    /** 执行器未接：这个字段让调用方一眼看出"批了也不会跑" */
    executor: 'skeleton',
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
 * 跑工作流 —— **骨架版未接执行器**。
 * 真实现时：只跑 `approved` 的步、按顺序、每步前后发事件；任何一步抛错 → `failed` 并停。
 * 这里刻意抛 NotImplementedError，让调用方看到「approved 但不执行」，而不是假 completed。
 */
export async function runWorkflow() {
  throw new NotImplementedError('工作流执行器未接（0.4.0 骨架版）：审批与状态机已就绪，执行留到下一轮');
}

export { TaskError, NotImplementedError };

function touch(wf) {
  wf.updated_at = new Date().toISOString();
  saveWorkflow(wf); // 每次状态转移都落盘：create / approve / reject / 执行器推进的每一跳
}
