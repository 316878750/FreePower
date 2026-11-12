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
 * 存储：进程内 `Map`（骨架版）。真做持久化时落 `DATA_DIR/agent/workflows/<id>.json`，
 * 与对手的 `RUNTIME_PATH=<data>\ai_agent` + `/conversation_history/` 同构（逆向 `24-` §4.4）。
 */
import crypto from 'node:crypto';
import { parseTaskList, digestTask, runBrowserTask, TaskError, NotImplementedError } from './task.js';
import { AGENT_HITL_DEFAULT } from '../config.js';

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

/** 进程内注册表（骨架版；重启即丢，别在这上面做长任务） */
const workflows = new Map();

export function isTerminal(state) {
  return TERMINAL.has(state);
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
  return wf;
}

export function getWorkflow(id) {
  return workflows.get(String(id)) || null;
}

/** 只给测试/诊断用：别借它做业务逻辑（骨架版内存表） */
export function listWorkflows() {
  return [...workflows.values()];
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
  touch(wf);

  // 所有步都批完了 → 工作流进 approved；单步批完仍是 created（还有别的步待审）
  if (wf.steps.every((s) => s.state === 'approved')) wf.state = 'approved';
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
}
