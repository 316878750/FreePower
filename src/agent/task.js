/**
 * `browser_task` DSL —— 解析 + 形状校验（0.4.0 第一版只做 7 个动作）。
 *
 * 为什么单独一个文件：这是**对外的契约**（模型/脚本要按它写），也是 HITL 审批的
 * 计算对象（`digestTask` 的结果进审批单）。解析与校验是纯函数，执行在文件尾的
 * `runBrowserTask`（CDP，由 `workflow.js` 提供会话）。
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
 *   - `screenshot.path` 只接相对路径（相对 `DATA_DIR/agent/screenshots/`）、必须 `.png`，
 *     不许绝对路径与 `..` —— 出参也只回相对路径；
 *   - 校验失败一律 `TaskError`，带 `field`（哪个字段错了）与 `code=100002`（我们的参数错统一码）。
 *
 * `digestTask` 用 sha256 覆盖**规范化后的整条任务**（键排序、去空白），得到 64 位十六进制。
 * 长度 64 与对手的 `approval.digest` 一致，但**算法与覆盖内容是我们的**——对手那边
 * 只知长度 64、算法【无证据】（逆向 `24-` §4.5），别写成"对齐了对手"。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_STEP_TIMEOUT_MS, AGENT_SCREENSHOT_DIR } from '../config.js';

/** 结果封顶：text 10KB、单条 cookie value 4KB（超了截断并带 truncated/original_len） */
export const TEXT_MAX_BYTES = 10 * 1024;
export const COOKIE_VALUE_MAX_BYTES = 4 * 1024;

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
 * 截图路径：只许相对路径、不许 `..`、只出 png（第一版截图格式固定 png）。
 * 校验放在解析层：审批时就能看到错，不必等到执行到那一步才发现文件被写到别处。
 */
function normalizeShotPath(value) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/');
  if (!raw) throw new TaskError('screenshot: path 不能是空串', { field: 'path' });
  if (raw.length > 200) throw new TaskError('screenshot: path 太长（上限 200）', { field: 'path' });
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('/')) {
    throw new TaskError('screenshot: path 必须是相对 DATA_DIR/agent/screenshots/ 的相对路径', { field: 'path' });
  }
  if (raw.split('/').some((s) => s === '..' || s === '.' || s === '')) {
    throw new TaskError('screenshot: path 不许包含 "." / ".." / 空段', { field: 'path' });
  }
  if (!/\.png$/i.test(raw)) throw new TaskError('screenshot: path 必须以 .png 结尾（第一版只出 png）', { field: 'path' });
  return raw;
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
      if (until === 'selector' && !hasSel) throw new TaskError('wait: until="selector" 需要同时给 selector', { field: 'selector' });
      out.until = until;
    }
  }
  if (action === 'screenshot') {
    if (spec.full_page !== undefined) out.full_page = spec.full_page === true || spec.full_page === '1';
    if (spec.path !== undefined) out.path = normalizeShotPath(spec.path);
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
 * 执行期错误：`reason` 是给调用方/日志看的稳定标识（不进 API 错误码表）。
 * `code` 只在「这条错误本质上还是参数错」时才用 100002（例如越界截图路径），其余 -1。
 */
export class ExecutionError extends Error {
  constructor(message, { reason = 'execution_failed', code = -1, field = '' } = {}) {
    super(message);
    this.name = 'ExecutionError';
    this.reason = reason;
    this.code = code;
    this.field = field;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** 按 UTF-8 字节截断，不切坏多字节字符（返回的串重新编码后 ≤ maxBytes） */
function truncateBytes(value, maxBytes) {
  const s = String(value ?? '');
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return { value: s, truncated: false, original_len: buf.length };
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // 10xxxxxx 是续接字节，退到字符边界
  return { value: buf.subarray(0, end).toString('utf8'), truncated: true, original_len: buf.length };
}

/** 单次 Runtime.evaluate：页面抛错变成 ExecutionError，别把 CDP 异常原样往上扔 */
async function pageEval(send, expression, { awaitPromise = false } = {}) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r && r.exceptionDetails) {
    const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面脚本抛错';
    throw new ExecutionError(String(desc).split('\n')[0], { reason: 'page_error' });
  }
  return r?.result?.value;
}

/** 在 deadline 前反复问一个问题；到点还没成立就按 step_timeout 失败 */
async function pollUntil(fn, deadline, what) {
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= deadline) throw new ExecutionError(`${what} 超时`, { reason: 'step_timeout' });
    await sleep(100);
  }
}

/** 选择器是否存在（-1 = 选择器本身非法，不是「没找到」） */
async function querySelectorState(send, selector) {
  const v = await pageEval(send, `(() => { try { return document.querySelector(${JSON.stringify(selector)}) ? 1 : 0; } catch (e) { return -1; } })()`);
  if (v === -1) throw new ExecutionError(`选择器不合法：${selector}`, { reason: 'invalid_selector', code: 100002 });
  return v === 1;
}

/** 把一个动作的结果包上预算：到点未完成 → step_timeout（不会再重试） */
async function withBudget(promise, ms, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ExecutionError(`${label} 超时（${ms}ms）`, { reason: 'step_timeout' })), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 解析后的相对路径 → 绝对路径（调用方已保证相对、无 `..`；这里再兜一次） */
function resolveShotPath(relOrName, dir, fallbackName) {
  const rel = String(relOrName || fallbackName || '').trim().replace(/\\/g, '/');
  const abs = path.resolve(dir, rel);
  const base = path.resolve(dir);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new ExecutionError('截图路径越出截图目录', { reason: 'screenshot_path_invalid', code: 100002 });
  }
  return { rel, abs };
}

/**
 * 执行一条任务（CDP）。
 *
 * @param {object} task `parseBrowserTask` 的产物
 * @param {object} env
 * @param {(method:string, params?:object) => Promise<object>} env.send 已绑定到页面会话的 CDP 发送函数
 * @param {string} [env.screenshotDir] 截图根目录（默认 `DATA_DIR/agent/screenshots`）
 * @param {string} [env.screenshotName] 任务没给 `path` 时的默认文件名（相对）
 * @param {number} [env.timeoutMs] 单步预算（默认 `AGENT_STEP_TIMEOUT_MS`）
 * @returns {Promise<object>} 按动作分形状：见 README「steps[].result」表
 *
 * 约定（三条硬约束，来自 CEO 的拍板）：
 *   - **不回吐任务原文**：`fill` 的值、`cookie set` 的值都不出现在结果里；
 *   - **大小封顶**：`text` 10KB、单条 cookie value 4KB；
 *   - **截图路径只回相对路径**（相对 `DATA_DIR/agent/screenshots/`）。
 *
 * 不做重试、不负责起浏览器 —— 生命周期由 `workflow.js` 管。
 */
export async function runBrowserTask(task, env = {}) {
  const { send, screenshotDir = AGENT_SCREENSHOT_DIR, screenshotName = '', timeoutMs = AGENT_STEP_TIMEOUT_MS } = env;
  if (typeof send !== 'function') throw new ExecutionError('执行器没拿到 CDP 会话', { reason: 'no_cdp_session' });
  if (!isPlainObject(task)) throw new ExecutionError('task 不是对象', { reason: 'invalid_task' });

  const started = Date.now();
  // wait({ms}) 是「等这么久」，预算要给它让路（ms 已在 DSL 层封顶 120000）
  const budget = task.action === 'wait' && Number.isFinite(task.ms)
    ? Math.max(timeoutMs, task.ms + 5000)
    : timeoutMs;
  const deadline = started + budget;

  const work = async () => {
    switch (task.action) {
      case 'open': {
        await send('Page.enable').catch(() => {});
        const before = String(await pageEval(send, 'location.href').catch(() => '') || '');
        const r = await send('Page.navigate', { url: task.url });
        if (r && r.errorText) throw new ExecutionError(`open 失败：${r.errorText}`, { reason: 'navigate_failed' });
        // 刚 navigate 完这一瞬，readyState 还是**旧文档**的 complete；必须确认换过页面再判加载完成。
        // 重新打开同一个 URL 时 href 不会变，只能先让半拍再看（这条写清楚，别当成没问题）。
        const sameAsBefore = before === task.url;
        if (sameAsBefore) await sleep(150);
        await pollUntil(async () => {
          const state = String(await pageEval(send, 'document.readyState').catch(() => '') || '');
          if (state !== 'complete') return false;
          if (sameAsBefore) return true;
          const href = String(await pageEval(send, 'location.href').catch(() => '') || '');
          return !!href && href !== before;
        }, deadline, 'open 等待页面加载');
        return { ok: true, took_ms: Date.now() - started };
      }

      case 'click': {
        const expr = `(() => {
          let el;
          try { el = document.querySelector(${JSON.stringify(task.selector)}); } catch (e) { return { ok: false, reason: 'invalid_selector' }; }
          if (!el) return { ok: false, reason: 'selector_not_found' };
          if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'center' });
          const rect = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          if ((rect.width === 0 && rect.height === 0) || cs.display === 'none' || cs.visibility === 'hidden') {
            return { ok: false, reason: 'element_not_visible' };
          }
          if (typeof el.click !== 'function') return { ok: false, reason: 'element_not_clickable' };
          el.click();
          return { ok: true };
        })()`;
        const v = await pageEval(send, expr);
        if (!v || !v.ok) throw new ExecutionError(`click 失败：${v?.reason || 'unknown'}`, { reason: v?.reason || 'click_failed', code: v?.reason === 'invalid_selector' ? 100002 : -1 });
        return { ok: true, took_ms: Date.now() - started };
      }

      case 'fill': {
        const value = JSON.stringify(task.value);
        const expr = `(() => {
          let el;
          try { el = document.querySelector(${JSON.stringify(task.selector)}); } catch (e) { return { ok: false, reason: 'invalid_selector' }; }
          if (!el) return { ok: false, reason: 'selector_not_found' };
          if (!('value' in el)) return { ok: false, reason: 'element_not_fillable' };
          el.focus();
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, ${value}); else el.value = ${value};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true };
        })()`;
        const v = await pageEval(send, expr);
        if (!v || !v.ok) throw new ExecutionError(`fill 失败：${v?.reason || 'unknown'}`, { reason: v?.reason || 'fill_failed', code: v?.reason === 'invalid_selector' ? 100002 : -1 });
        return { ok: true, took_ms: Date.now() - started };
      }

      case 'wait': {
        if (task.ms !== undefined) await sleep(Math.min(task.ms, Math.max(0, deadline - Date.now())));
        if (task.until === 'load') {
          await pollUntil(async () => (await pageEval(send, 'document.readyState').catch(() => '')) === 'complete', deadline, 'wait(load)');
        }
        if (task.selector) {
          await pollUntil(() => querySelectorState(send, task.selector), deadline, `wait(${task.selector})`);
        }
        return { ok: true, took_ms: Date.now() - started };
      }

      case 'text': {
        const v = await pageEval(send, `(() => {
          let el;
          try { el = document.querySelector(${JSON.stringify(task.selector)}); } catch (e) { return { ok: false, reason: 'invalid_selector' }; }
          if (!el) return { ok: false, reason: 'selector_not_found' };
          const t = (typeof el.innerText === 'string' && el.innerText) ? el.innerText : (el.textContent ?? '');
          return { ok: true, value: String(t) };
        })()`);
        if (!v || !v.ok) throw new ExecutionError(`text 失败：${v?.reason || 'unknown'}`, { reason: v?.reason || 'text_failed', code: v?.reason === 'invalid_selector' ? 100002 : -1 });
        const t = truncateBytes(v.value, TEXT_MAX_BYTES);
        return t.truncated
          ? { value: t.value, truncated: true, original_len: t.original_len }
          : { value: t.value };
      }

      case 'screenshot': {
        const { rel, abs } = resolveShotPath(task.path, screenshotDir, screenshotName || `shot-${Date.now()}.png`);
        await send('Page.enable').catch(() => {});
        let params = { format: 'png' };
        if (task.full_page) {
          // 整页要自己给 clip；cssContentSize 是 CSS 像素，和 captureScreenshot 的坐标系一致
          const m = await send('Page.getLayoutMetrics').catch(() => null);
          const size = m?.cssContentSize || m?.contentSize;
          if (size && size.width > 0 && size.height > 0) {
            params = {
              format: 'png',
              captureBeyondViewport: true,
              clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 },
            };
          }
        }
        const shot = await send('Page.captureScreenshot', params);
        if (!shot?.data) throw new ExecutionError('截图没有返回数据', { reason: 'screenshot_failed' });
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, Buffer.from(shot.data, 'base64'));
        // 只回相对路径：绝对路径是我本机的，回给 LLM 既不必要也容易泄露目录结构
        return { path: rel };
      }

      case 'cookie': {
        await send('Network.enable').catch(() => {});
        if (task.op === 'get') {
          // 不给 url 就取**当前页**的 cookie：显式拿 location.href 再传 urls，
          // 不依赖 Chrome「省略 urls 时的默认行为」（实测那条返回空数组，靠不住）
          let urls = null;
          if (task.url) urls = [task.url];
          else {
            const href = String(await pageEval(send, 'location.href').catch(() => '') || '');
            if (isHttpUrl(href)) urls = [href];
          }
          const r = await send('Network.getCookies', urls ? { urls } : {});
          const cookies = (r?.cookies || []).map((c) => {
            const t = truncateBytes(c.value, COOKIE_VALUE_MAX_BYTES);
            const out = {
              name: c.name,
              value: t.value,
              domain: c.domain,
              path: c.path,
              expires: c.expires,
              httpOnly: c.httpOnly,
              secure: c.secure,
              sameSite: c.sameSite,
            };
            if (t.truncated) {
              out.truncated = true;
              out.original_len = t.original_len;
            }
            return out;
          });
          return { cookies };
        }
        // set：DSL 里 url 可省 —— 省了就用当前页 origin；页面不是 http(s) 就明确拒绝
        let url = task.url;
        if (!url) {
          const origin = String(await pageEval(send, 'location.origin').catch(() => '') || '');
          if (!origin || origin === 'null' || !isHttpUrl(origin)) {
            throw new ExecutionError('cookie set 需要 url：当前页不是 http(s) 页面', { reason: 'cookie_url_required', code: 100002 });
          }
          url = origin;
        }
        const r = await send('Network.setCookie', { name: task.name, value: task.value, url });
        if (r && r.success === false) throw new ExecutionError('cookie set 被浏览器拒绝', { reason: 'cookie_set_failed' });
        return { ok: true, took_ms: Date.now() - started };
      }

      default:
        // 解析层已经挡过，这里只兜「绕过解析直接调执行器」的情况
        throw new ExecutionError(`unsupported action "${task.action}"`, { reason: 'unsupported_action', code: 100002 });
    }
  };

  return withBudget(work(), budget, `step ${task.action}`);
}

