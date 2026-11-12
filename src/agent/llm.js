/**
 * LLM 接入（0.4.0 AI Agent 骨架）—— **OpenAI 兼容协议**，key 用户自己填。
 *
 * 与对手最关键的一处**有意差异**：
 *   对手把模型放在自家网关 `https://ai.adspower.com/api`，Bearer 就是你的**登录 token**
 *   （逆向 `24-` §3.3 / §5.2），用户在本地没有 key 输入项、也不知道花了多少钱。
 *   我们反过来：endpoint / key / model 都是用户自己的配置（`AGENT_LLM_*`），请求直连那个
 *   endpoint，**不经过任何 adspower 域名，也不拿登录 token 当 key**。
 *
 * 第一版只支持 OpenAI 兼容的 `POST <endpoint>/chat/completions`（DeepSeek / OpenAI /
 * 各种兼容网关都是这套）。Anthropic 原生协议等下一版再加，别在这里偷偷转协议。
 *
 * 这一版**不发请求**：`chat()` 抛 `NotImplementedError`，先把配置解析、请求体构造、
 * key 脱敏做好 —— 免得骨架阶段有人以为已经能对话、或者把 key 打进日志。
 */
import { AGENT_LLM_ENDPOINT, AGENT_LLM_KEY, AGENT_LLM_MODEL, AGENT_LLM_TIMEOUT_MS } from '../config.js';
import { NotImplementedError } from './task.js';

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

/**
 * 构造一次 OpenAI 兼容请求（**不发送**）。
 * 落点在真实现时直接用：`chatCompletion(config, { messages, temperature })`。
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

/**
 * 真调一次模型 —— **骨架版未接**。
 * 接的时候要点（写死在这里）：读 `choices[0].message`（非流式）或按 `choices[].delta` 拼（流式）、
 * 兼容 `reasoning_content`；超时用 `config.timeout_ms`；**任何错误都要先过 `redactKey` 再 log**。
 */
export async function chat() {
  throw new NotImplementedError('LLM 调用未接（0.4.0 骨架版）：配置解析与请求构造已就绪，真正发请求留到下一轮');
}
