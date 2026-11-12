/**
 * `browser_task` DSL —— 解析 + 形状校验（0.4.0 第一版只做 7 个动作）。
 *
 * 为什么单独一个文件：这是**对外的契约**（模型/脚本要按它写），也是 HITL 审批的
 * 计算对象（`digestTask` 的结果进审批单）。把它做成纯函数，后面真接执行器时
 * 只加 `runBrowserTask` 的实现，解析与校验不用动。
 *
 * 动作子集（CEO 拍的范围，其他动作暂不做，遇到就报 100002，不静默忽略）：
 *
 *   { action:'open',       url:'https://…' }
 *   { action:'click',      selector:'#login' }
 *   { action:'fill',       selector:'input[name=q]', value:'hello' }
 *   { action:'wait',       selector?:'#done' | ms?:1200, until?:'load'|'selector' }
 *   { action:'text',       selector:'.price', save_as?:'price' }
 *   { action:'screenshot', full_page?:true, path?:'shot.png' }
 *   { action:'cookie',     op:'get'|'set', name?, value?, url? }
 *
 * 约定：
 *   - 只收 http(s)；`about:` / `chrome:` 这种内建页不给模型碰（否则能把内核自己的页当目标）；
 *   - `selector` 是 CSS 选择器字符串，**不做** XPath（第一版不引第三方解析）；
 *   - 校验失败一律 `TaskError`，带 `field`（哪个字段错了）与 `code=100002`（我们的参数错统一码）。
 *
 * `digestTask` 用 sha256 覆盖**规范化后的整条任务**（键排序、去空白），得到 64 位十六进制。
 * 长度 64 与对手的 `approval.digest` 一致，但**算法与覆盖内容是我们的**——对手那边
 * 只知长度 64、算法【无证据】（逆向 `24-` §4.5），别写成"对齐了对手"。
 */
import crypto from 'node:crypto';

/** 第一版支持的动作（不在表里的一律拒绝） */
export const TASK_ACTIONS = ['open', 'click', 'fill', 'wait', 'text', 'screenshot', 'cookie'];

/** 每个动作的字段表：required 缺一不可，optional 之外的键一律拒绝（防"写了不生效"） */
const SPECS = {
  open: { required: ['url'], optional: [] },
  click: { required: ['selector'], optional: [] },
  fill: { required: ['selector', 'value'], optional: [] },
  wait: { required: [], optional: ['selector', 'ms', 'until'] },
  text: { required: ['selector'], optional: ['save_as'] },
  screenshot: { required: [], optional: ['full_page', 'path'] },
  cookie: { required: ['op'], optional: ['name', 'value', 'url'] },
};

export class TaskError extends Error {
  constructor(message, { field = '' } = {}) {
    super(message);
    this.name = 'TaskError';
    this.code = 100002;
    this.field = field;
  }
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isHttpUrl = (v) => {
  try {
    const u = new URL(String(v));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

function isSelector(v) {
  const s = String(v ?? '').trim();
  if (!s) return false;
  // 只排除明显不是选择器的写法；真正的合法性由浏览器在 click/fill 时决定
  return !/^(xpath=|text=|\/\/)/i.test(s) && s.length <= 512;
}

/**
 * 解析并规范化一条任务。
 * @param {object} spec 例如 `{ action:'open', url:'https://example.com' }`
 * @returns {object} 规范化后的任务（键顺序稳定，便于算 digest）
 */
export function parseBrowserTask(spec) {
  if (!isPlainObject(spec)) throw new TaskError('task must be an object');
  const action = String(spec.action ?? '').trim().toLowerCase();
  if (!action) throw new TaskError('action is required', { field: 'action' });
  if (!TASK_ACTIONS.includes(action)) {
    throw new TaskError(`unsupported action "${action}"（第一版只支持 ${TASK_ACTIONS.join('/')}）`, { field: 'action' });
  }
  const { required, optional } = SPECS[action];
  for (const k of required) {
    if (spec[k] === undefined || spec[k] === null || String(spec[k]).trim() === '') {
      throw new TaskError(`${action}: ${k} is required`, { field: k });
    }
  }
  const allowed = new Set(['action', ...required, ...optional]);
  for (const k of Object.keys(spec)) {
    if (!allowed.has(k)) throw new TaskError(`${action}: unknown field "${k}"`, { field: k });
  }

  const out = { action };
  if (action === 'open') {
    if (!isHttpUrl(spec.url)) throw new TaskError('open: url must be http(s)', { field: 'url' });
    out.url = String(spec.url).trim();
  }
  if (action === 'click' || action === 'fill' || action === 'text') {
    if (!isSelector(spec.selector)) throw new TaskError(`${action}: selector must be a CSS selector`, { field: 'selector' });
    out.selector = String(spec.selector).trim();
    if (action === 'fill') out.value = String(spec.value);
    if (action === 'text' && spec.save_as !== undefined) out.save_as = String(spec.save_as).trim();
  }
  if (action === 'wait') {
    const hasSel = spec.selector !== undefined && String(spec.selector).trim() !== '';
    const hasMs = spec.ms !== undefined && spec.ms !== null;
    if (!hasSel && !hasMs && spec.until === undefined) {
      throw new TaskError('wait: selector / ms / until 至少给一个', { field: 'selector' });
    }
    if (hasSel) {
      if (!isSelector(spec.selector)) throw new TaskError('wait: selector must be a CSS selector', { field: 'selector' });
      out.selector = String(spec.selector).trim();
    }
    if (hasMs) {
      const ms = Number(spec.ms);
      if (!Number.isFinite(ms) || ms < 0 || ms > 120000) throw new TaskError('wait: ms must be 0..120000', { field: 'ms' });
      out.ms = Math.round(ms);
    }
    if (spec.until !== undefined) {
      const until = String(spec.until).trim().toLowerCase();
      if (!['load', 'selector'].includes(until)) throw new TaskError('wait: until must be "load" or "selector"', { field: 'until' });
      out.until = until;
    }
  }
  if (action === 'screenshot') {
    if (spec.full_page !== undefined) out.full_page = spec.full_page === true || spec.full_page === '1';
    if (spec.path !== undefined) out.path = String(spec.path).trim();
  }
  if (action === 'cookie') {
    const op = String(spec.op).trim().toLowerCase();
    if (!['get', 'set'].includes(op)) throw new TaskError('cookie: op must be "get" or "set"', { field: 'op' });
    out.op = op;
    if (op === 'set') {
      if (spec.name === undefined || spec.value === undefined) throw new TaskError('cookie: set 需要 name 与 value', { field: 'name' });
      out.name = String(spec.name).trim();
      out.value = String(spec.value);
      if (spec.url !== undefined) {
        if (!isHttpUrl(spec.url)) throw new TaskError('cookie: url must be http(s)', { field: 'url' });
        out.url = String(spec.url).trim();
      }
    }
  }
  return out;
}

/** 解析任务数组（工作流用）；空数组直接拒绝，别让"空工作流"看起来像成功 */
export function parseTaskList(list) {
  if (!Array.isArray(list) || list.length === 0) throw new TaskError('tasks must be a non-empty array', { field: 'tasks' });
  if (list.length > 200) throw new TaskError('tasks: at most 200 steps（一条工作流的硬上限）', { field: 'tasks' });
  return list.map((t, i) => {
    try {
      return parseBrowserTask(t);
    } catch (e) {
      if (e instanceof TaskError) throw new TaskError(`tasks[${i}]: ${e.message}`, { field: `tasks[${i}].${e.field || ''}`.replace(/\.$/, '') });
      throw e;
    }
  });
}

/** 稳定序列化：键按字典序排，给 digest 用（同一份任务必须得到同一个 digest） */
export function canonicalTask(task) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v)) {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(task));
}

/** 一条任务的审批摘要：sha256(规范化 JSON) → 64 位十六进制（算法是我们自己的，见文件头） */
export function digestTask(task) {
  return crypto.createHash('sha256').update(canonicalTask(task)).digest('hex');
}

export class NotImplementedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotImplementedError';
    this.code = -1;
  }
}

/**
 * 执行一条任务 —— **骨架版未接**。
 *
 * 真实现时的落点（写在这里，免得下一个人重新推）：
 *   open/click/fill/wait/text/screenshot 走 CDP（`src/kernel/cdp.js` 的 `CdpClient`）：
 *   `Page.navigate` / `Runtime.evaluate`（选择器查询 + click）/ `Page.captureScreenshot` /
 *   `Network.getCookies`；cookie set 用 `Network.setCookie`。
 *   环境必须先由 `cli.startBrowser()` 起好、拿到 `ws`，本函数不负责起环境，也不做重试。
 */
export async function runBrowserTask() {
  throw new NotImplementedError('browser_task 执行器未接（0.4.0 骨架版）：解析与审批已就绪，执行留到下一轮');
}
