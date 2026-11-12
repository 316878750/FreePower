/**
 * `adspower_cli` —— 我们自己那套调用层（不是对手那个 158 KB 的 Node CLI）。
 *
 * 只做一件事：**把 Agent 要的浏览器动作落到我们自己的本地 API 上**：
 *   start / stop / active / list  → `/api/v2/browser-profile/*`（就是 `07-` 里那 54 条路由）
 *   CDP 地址                       → start 的回包里取 `ws.puppeteer`（等价对手的
 *                                    `/api/ai/getOpenedById`，我们不需要单开一条）
 *
 * **不调对手云、不调对手的 `/api/ai/plus/*`**。对手那套是「宿主窗口 + 5.3 MB Agent Core
 * 子进程 + 自家模型网关」，我们这里只有一层薄封装（逆向 `24-` §6.1 指出它自己也是走 Local API）。
 *
 * 来源标记：每个请求带 `x-freepower-agent: 1`（**我们的扩展**，对手用的是
 * `X-AdsPower-Client: mcp` 被内部记成 `AI_REQUEST_LOCAL_API`，见 `24-` §6.1）。
 * 限流档位暂时复用 `x-freepower-client: mcp`（30/s），**没有**为 agent 单独开档。
 */
import { API_PORT } from '../config.js';

export class AgentCliError extends Error {
  constructor(message, { code = -1, status = 0 } = {}) {
    super(message);
    this.name = 'AgentCliError';
    this.code = code;
    this.status = status;
  }
}

export class AgentCli {
  /**
   * @param {object} [opts]
   * @param {string} [opts.base] 本地 API 根地址（默认 `http://127.0.0.1:<API_PORT>`）
   * @param {string} [opts.apiKey] 本地 API key（调用方从小库 `ensureApiKey()` 拿，别写死）
   * @param {number} [opts.timeoutMs] 单次请求超时（默认 20s，与 `START_TIMEOUT_MS` 同量级）
   */
  constructor({ base = `http://127.0.0.1:${API_PORT}`, apiKey = '', timeoutMs = 20000 } = {}) {
    this.base = String(base).replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  /** 唯一的出口：所有命令都经这里，方便以后统一加重试/审计 */
  async request(method, path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.base + path, {
        method,
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          api_key: this.apiKey,
          'x-freepower-client': 'mcp',
          'x-freepower-agent': '1',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new AgentCliError(`local api ${method} ${path} → HTTP ${res.status}`, { status: res.status });
      if (!json || json.code !== 0) {
        throw new AgentCliError(json?.msg || `local api ${method} ${path} failed`, { code: json?.code ?? -1, status: res.status });
      }
      return json.data;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------ 环境（开/关/查） ------------------------------ */

  /** 列环境（v2；`limit` 不给时对手只回 1 条，这里显式给上限） */
  async listProfiles({ limit = 200, page = 1 } = {}) {
    return this.request('POST', '/api/v2/browser-profile/list', { page, limit });
  }

  /**
   * 起环境，回 `{pid, ws:{puppeteer,selenium}, debug_port, ...}`。
   * **必须是 GET**：我们自己的 `/api/v2/browser-profile/start` 只注册了 GET（对齐对手），
   * 骨架版这里写成 POST，真接执行器时才发现会 404 —— 2026-11-12 修。
   */
  async startBrowser(profileId) {
    return this.request('GET', `/api/v2/browser-profile/start?profile_id=${encodeURIComponent(profileId)}`);
  }

  /** 停环境 */
  async stopBrowser(profileId) {
    return this.request('POST', '/api/v2/browser-profile/stop', { profile_id: profileId });
  }

  /** 运行态（Active/Inactive + ws），不启动任何东西 */
  async getBrowser(profileId) {
    return this.request('GET', `/api/v2/browser-profile/active?profile_id=${encodeURIComponent(profileId)}`);
  }

  /**
   * 从 start/active 的回包里取 CDP 地址。
   * 取不到就抛：别让上层拿着空地址去 connect，错会堆在 CDP 层看不出根因。
   */
  cdpUrl(result) {
    const ws = result?.ws?.puppeteer || result?.ws?.selenium || '';
    if (!ws) throw new AgentCliError('local api 回包里没有 ws 地址（环境没起来？）');
    return String(ws);
  }
}

export function createCli(opts) {
  return new AgentCli(opts);
}
