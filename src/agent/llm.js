/**
 * LLM 接入（0.4.0 AI Agent）—— **OpenAI 兼容协议**，key 用户自己填。
 *
 * 与对手最关键的一处**有意差异**：
 *   对手把模型放在自家网关 `https://ai.adspower.com/api`，Bearer 就是你的**登录 token**
 *   （逆向 `24-` §3.3 / §5.2），用户在本地没有 key 输入项、也不知道花了多少钱。
 *   我们反过来：endpoint / key / model 都是用户自己的配置（`AGENT_LLM_*`），请求直连那个
 *   endpoint，**不经过任何 adspower 域名，也不拿登录 token 当 key**。
 *
 * 只支持 OpenAI 兼容的 `POST <endpoint>/chat/completions`（DeepSeek / OpenAI /
 * 各种兼容网关都是这套）。Anthropic 原生协议等下一版再加，别在这里偷偷转协议。
 * **不新增 npm 依赖**：用 Node 内置 `fetch`。
 *
 * 三条硬规矩（CEO 拍的口径）：
 *   1. **key 不许出现在任何错误文案、日志、响应体里** —— 出站前统一 `redactAll`
 *      （`chat()` 的 catch 会对整条 message 再脱敏一次，兜住"上游把 key 回显在 body 里"）；
 *   2. 401 / 403 / 404 / 429 / 5xx / 超时 / 非 JSON / 形状不对 **各给不同文案**，
 *      每条都带 endpoint + model，能直接定位是哪一层出的问题；
 *   3. prompt 里只放 **goal + 动作/字段白名单**（从 `task.js` 的 `TASK_SPECS` 生成，
 *      不另抄一份）；profile 的 cookies / UA / 代理账密一律不进 prompt。
 *
 * 错误码不新造：**配置缺项 / 参数非法 / 模型产出的动作不合法 = 100002**（带 `field`），
 * 上游那一层（网络、HTTP、超时、解析）= `-1` 通用失败；靠 `reason` 区分具体原因。
 */
import { AGENT_LLM_ENDPOINT, AGENT_LLM_KEY, AGENT_LLM_MODEL, AGENT_LLM_TIMEOUT_MS } from '../config.js';
import { TASK_ACTIONS, TASK_SPECS, canonicalTask, parseTaskList, TaskError } from './task.js';

/** 一次模型调用最多产出多少步（比 `parseTaskList` 的 200 硬上限紧：模型一次给太多步人批不过来） */
export const LLM_TASK_LIMIT = 20;

/** goal 上限：提示词里只放目标本身，超长几乎一定是贴错东西了 */
export const GOAL_MAX_CHARS = 4000;

/**
 * LLM 层错误：`code` 沿用我们的码表（见文件头），`reason` 是给人/日志看的稳定标识，
 * `status` 是上游 HTTP 状态（本地没发出去就是 0）。
 */
export class LlmError extends Error {
  constructor(message, { code = -1, field = '', reason = 'llm_failed', status = 0 } = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.field = field;
    this.reason = reason;
    this.status = status;
  }
}

/** 解析 LLM 配置：显式参数 > 环境变量/配置文件；空串一律视为"没配" */
export function resolveLlmConfig(overrides = {}) {
  const pick = (a, b) => String(a ?? b ?? '').trim();
  const endpoint = pick(overrides.endpoint, AGENT_LLM_ENDPOINT).replace(/\/+$/, '');
  const key = pick(overrides.key, AGENT_LLM_KEY);
  const model = pick(overrides.model, AGENT_LLM_MODEL);
  return {
    endpoint,
    key,
    model,
    timeout_ms: Number(overrides.timeout_ms ?? AGENT_LLM_TIMEOUT_MS) || 60000,
    /** 三样齐了才算配好；缺一样就明确报没配，不做"默认模型"猜测 */
    configured: Boolean(endpoint && key && model),
  };
}

/** 日志/回执里只出现这种 key：前后各 4 位，中间打码（短 key 直接全码） */
export function redactKey(key) {
  const s = String(key ?? '');
  if (!s) return '';
  if (s.length <= 12) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** 把一段文本里出现的 key 全部换掉（错误文案/上游 body 摘要都要先过这一道） */
export function redactAll(text, key) {
  const s = String(text ?? '');
  const k = String(key ?? '');
  if (!k) return s;
  return s.split(k).join(redactKey(k));
}

/** 上游 body 摘要：单行、封顶、key 已脱敏 —— 给"非 JSON / 未知 HTTP 错误"定位用 */
function bodySnippet(text, key, max = 240) {
  const s = redactAll(String(text ?? '').replace(/\s+/g, ' ').trim(), key);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 构造 system prompt：动作与字段白名单**从 `TASK_SPECS` 生成**（唯一事实源，见 `task.js`）。
 * 这里只描述动作本身，不带任何环境信息 —— 模型不该知道用户有哪些 cookies/proxy。
 */
export function buildSystemPrompt() {
  const lines = [
    '你是浏览器自动化动作规划器。把用户的目标拆成一串 browser_task 动作，按执行顺序排列。',
    '输出要求：**只输出一个 JSON 数组**，不要解释、不要前后缀、不要 markdown 围栏；数组元素是动作对象，例如 [{"action":"open","url":"https://example.com"}]。',
    `最多 ${LLM_TASK_LIMIT} 个动作；目标无法用下面的动作完成时输出 []。`,
    '动作与字段白名单（每个动作只允许出现列出的字段，多一个都会被拒绝）：',
  ];
  for (const action of TASK_ACTIONS) {
    const spec = TASK_SPECS[action] || { required: [], optional: [] };
    const req = spec.required.length ? spec.required.join(', ') : '（无）';
    const opt = spec.optional.length ? spec.optional.join(', ') : '（无）';
    lines.push(`- ${action}：必需 ${req}；可选 ${opt}`);
  }
  lines.push(
    '字段约定：',
    '- open.url 只收 http/https；click / fill / text / wait 的 selector 是 CSS 选择器（不支持 XPath）；',
    '- fill 需要 selector + value；wait 的 selector / ms / until 至少给一个（until 只认 load|selector，ms ≤ 120000）；',
    '- text 的 save_as 是给结果起的名字；screenshot.path 必须是相对路径且以 .png 结尾；',
    '- cookie.op 只认 get|set（set 需要 name + value，url 可省）。',
    '安全约定：不要编造用户没给的 cookie / 密码 / token；动作对象里不写注释、不写额外说明。',
  );
  return lines.join('\n');
}

/** 由 goal 构造 messages：system 是动作清单，user 只有目标本身（不夹带 profile 数据） */
export function buildGoalMessages(goal) {
  const g = String(goal ?? '').trim();
  if (!g) throw new LlmError('goal 不能为空', { code: 100002, field: 'goal', reason: 'goal_required' });
  if (g.length > GOAL_MAX_CHARS) {
    throw new LlmError(`goal 太长（${g.length} 字符，上限 ${GOAL_MAX_CHARS}）`, { code: 100002, field: 'goal', reason: 'goal_too_long' });
  }
  return [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: g },
  ];
}

/**
 * 构造一次 OpenAI 兼容请求（**不发送**）。
 * 落点在真实现时直接用：`chat(config, { messages, temperature })`。
 */
export function buildChatRequest(config, { messages = [], temperature = 0.1, stream = false } = {}) {
  const { endpoint, key, model } = config || {};
  if (!endpoint || !key || !model) {
    const err = new Error('LLM 未配置：需要 endpoint / key / model 三样（AGENT_LLM_*）');
    err.code = 100002;
    throw err;
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    const err = new Error('messages must be a non-empty array');
    err.code = 100002;
    throw err;
  }
  return {
    url: `${endpoint}/chat/completions`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, temperature, stream }),
    },
    // 只给日志用：别把 init.headers 里那把 key 打出去
    safe: { url: `${endpoint}/chat/completions`, model, messages: messages.length, stream },
  };
}

/** HTTP 非 2xx → LlmError：每一档文案都不同，且都带 endpoint/model 便于定位 */
function httpError(status, bodyText, config) {
  const where = `endpoint=${config.endpoint}, model=${config.model}`;
  const detail = bodySnippet(bodyText, config.key);
  const tail = detail ? `；上游：${detail}` : '';
  const mk = (message, reason) => new LlmError(`${message}（${where}）${tail}`, { reason, status });
  if (status === 401) return mk('LLM 认证失败：HTTP 401，key 无效/过期或没有该模型权限', 'llm_unauthorized');
  if (status === 403) return mk('LLM 拒绝访问：HTTP 403，key 没有调用权限（或该地区/该模型被限制）', 'llm_forbidden');
  if (status === 404) return mk('LLM 接口不存在：HTTP 404，endpoint 是不是少/多了一层路径，或模型名不对', 'llm_not_found');
  if (status === 429) return mk('LLM 限流：HTTP 429，请求太密或额度用尽，稍后重试', 'llm_rate_limited');
  if (status >= 500) return mk(`LLM 上游错误：HTTP ${status}，是对方服务的问题，不是本地配置`, 'llm_upstream_error');
  return mk(`LLM 调用失败：HTTP ${status}`, 'llm_http_error');
}

/**
 * 真调一次模型（非流式）。
 *
 * @param {object} config `resolveLlmConfig` 的产物（endpoint/key/model/timeout_ms）
 * @param {{messages?: Array, temperature?: number, timeout_ms?: number}} [opts]
 * @returns {Promise<{content: string, model: string, usage: object|null, status: number}>}
 *
 * 只读 `choices[0].message.content`，兼容 `reasoning_content`（只当没有正文时的兜底）。
 * 不做重试：429/5xx 让调用方（路由）决定要不要再来一次，重试逻辑藏在这里会让人以为"没花钱"。
 */
export async function chat(config, { messages = [], temperature = 0.1, timeout_ms } = {}) {
  const cfg = config && typeof config === 'object' ? config : resolveLlmConfig();
  try {
    const req = buildChatRequest(cfg, { messages, temperature });
    const ms = Math.max(1, Number(timeout_ms ?? cfg.timeout_ms) || 60000);

    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, ms);

    let res;
    let bodyText = '';
    try {
      res = await fetch(req.url, { ...req.init, signal: ac.signal });
      bodyText = await res.text();
    } catch (e) {
      if (timedOut) {
        throw new LlmError(
          `LLM 请求超时：${ms}ms 内没有回应（endpoint=${cfg.endpoint}, model=${cfg.model}；超时可调 AGENT_LLM_TIMEOUT_MS）`,
          { reason: 'llm_timeout' },
        );
      }
      const why = e?.cause?.code || e?.cause?.message || e?.message || String(e);
      throw new LlmError(
        `连不上 LLM endpoint（${cfg.endpoint}）：${why}（检查地址/网络/代理，model=${cfg.model}）`,
        { reason: 'llm_unreachable' },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) throw httpError(res.status, bodyText, cfg);

    let json;
    try {
      json = JSON.parse(bodyText);
    } catch {
      throw new LlmError(
        `LLM 返回的不是 JSON（HTTP ${res.status}，endpoint=${cfg.endpoint}）：${bodySnippet(bodyText, cfg.key) || '（空 body）'}`,
        { reason: 'llm_bad_json', status: res.status },
      );
    }

    const choice = json?.choices?.[0];
    const content = typeof choice?.message?.content === 'string'
      ? choice.message.content
      : (typeof choice?.text === 'string' ? choice.text : '');
    if (!content.trim()) {
      // 有的兼容网关把正文放 reasoning_content；仍然空就是形状不对，别静默当"模型没意见"
      const reasoning = typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content : '';
      if (!reasoning.trim()) {
        throw new LlmError(
          `LLM 响应形状不对：choices[0].message.content 是空的（HTTP ${res.status}, model=${json?.model || cfg.model}）`,
          { reason: 'llm_bad_shape', status: res.status },
        );
      }
      return { content: reasoning, model: String(json?.model || cfg.model), usage: json?.usage || null, status: res.status };
    }
    return { content, model: String(json?.model || cfg.model), usage: json?.usage || null, status: res.status };
  } catch (e) {
    // 最后一道：任何错误文案都不许带 key（含上游把 key 回显在 body 里的情况）
    if (e && typeof e.message === 'string') e.message = redactAll(e.message, cfg?.key);
    throw e;
  }
}

/**
 * 从模型正文里抽出动作数组：容忍 ```json 围栏、前后空白、以及前后夹了说明文字
 * （说明文字里取第一对方括号）。解析失败/不是数组 → LlmError（-1，`reason=llm_not_array`）。
 */
export function extractTaskArray(content) {
  let s = String(content ?? '').trim();
  if (!s) throw new LlmError('LLM 返回了空内容', { reason: 'llm_empty_content' });

  const fence = s.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/);
  if (fence) s = fence[1].trim();
  if (!s.startsWith('[')) {
    const a = s.indexOf('[');
    const b = s.lastIndexOf(']');
    if (a >= 0 && b > a) s = s.slice(a, b + 1).trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch {
    throw new LlmError(`LLM 返回的不是合法 JSON：${bodySnippet(s, '', 200)}`, { reason: 'llm_not_array' });
  }
  if (!Array.isArray(parsed)) {
    throw new LlmError('LLM 返回的不是 JSON 数组（要的是动作数组，不是对象/字符串）', { reason: 'llm_not_array' });
  }
  return parsed;
}

/**
 * 模型正文 → 校验过的任务数组。
 *
 * 三道关：数组形状（空/超 20 步拒）→ `parseTaskList`（未知动作/字段一律 100002，带 `tasks[i].x`）
 * → `canonicalTask` 重建（键序稳定：模型把字段顺序写反也不影响 digest）。
 */
export function tasksFromContent(content) {
  const raw = extractTaskArray(content);
  if (raw.length === 0) {
    throw new LlmError('LLM 没有产出任何动作（空数组）：把目标写得更具体一点', { code: 100002, field: 'tasks', reason: 'llm_empty_tasks' });
  }
  if (raw.length > LLM_TASK_LIMIT) {
    throw new LlmError(`LLM 产出了 ${raw.length} 步，超过上限 ${LLM_TASK_LIMIT} 步：拆成两次目标再试`, { code: 100002, field: 'tasks', reason: 'llm_too_many_tasks' });
  }
  let parsed;
  try {
    parsed = parseTaskList(raw);
  } catch (e) {
    if (e instanceof TaskError) {
      throw new LlmError(`模型产出的动作不合法：${e.message}`, { code: e.code, field: e.field, reason: 'llm_invalid_task' });
    }
    throw e;
  }
  return parsed.map((t) => JSON.parse(canonicalTask(t)));
}

/**
 * 目标 → 动作列表（路由 `create-from-goal` 的唯一入口）。
 *
 * @param {object} [llmOverrides] `{endpoint,key,model,timeout_ms}`：显式参数优先于 `AGENT_LLM_*`
 * @param {{goal: string}} input 目标原文（**只要目标**，调用方别把 profile 数据拼进来）
 * @returns {Promise<{tasks: object[], model: string, usage: object|null}>}
 */
export async function planTasksFromGoal(llmOverrides, { goal } = {}) {
  const cfg = resolveLlmConfig(llmOverrides || {});
  if (!cfg.configured) {
    throw new LlmError('LLM 未配置：需要 endpoint / key / model 三样（请求里的 llm 参数或 AGENT_LLM_*）', {
      code: 100002, field: 'llm', reason: 'llm_not_configured',
    });
  }
  const messages = buildGoalMessages(goal);
  const r = await chat(cfg, { messages });
  const tasks = tasksFromContent(r.content);
  return { tasks, model: r.model, usage: r.usage || null };
}
