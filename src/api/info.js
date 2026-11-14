/**
 * 「API & MCP」页要的那份状态：API 验证开关、请求计数、端点清单、MCP 脚本路径。
 *
 * 三件事都在这里，因为它们都是**进程级状态**，不属于某个环境：
 *   1. 验证开关（`meta.api_verify`）：关掉就不校验 api_key（对齐对手的「API 验证」开关）；
 *   2. 请求计数（内存）：进程起来后累计，重启归零 —— 不落库，避免每次请求都写盘；
 *   3. 端点清单（从 `buildRoutes()` 派生，见 catalog.js）。
 *
 * **开关关掉意味着本机任何进程都能调 API**（包括重置 key、改环境）。这是开关本身的语义，
 * 不是漏洞：用户要的正是「不校验」。README 的「安全边界」里写清了这一点。
 */
import path from 'node:path';
import { API_HOST, API_PORT, ROOT } from '../config.js';
import { getMeta, setMeta } from '../store/db.js';
import { routeCatalog } from './catalog.js';

/** MCP server 的绝对路径：控制台把它填进 Claude Desktop / Cursor / Codex 的配置里 */
export const MCP_SCRIPT_PATH = path.join(ROOT, 'mcp', 'server.mjs');

const VERIFY_META_KEY = 'api_verify';

/**
 * 验证开关，默认**开**（= 校验 key）。
 * 只有库里明确写了 '0' 才算关 —— 键不存在、写坏了、空串，一律按「开」处理，
 * 别做成「配错就放行」。
 */
export function apiVerifyEnabled() {
  try {
    return getMeta(VERIFY_META_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setApiVerify(enabled) {
  const on = !!enabled;
  setMeta(VERIFY_META_KEY, on ? '1' : '0');
  return on;
}

/* ------------------------------ 请求计数 ------------------------------ */

const stats = {
  total: 0,
  allowed: 0,
  rejected: 0,
  limited: 0,
  /** 验证关掉之后放行的请求数（单独计一份，便于用户判断开关是不是生效了） */
  open: 0,
  started_at: new Date().toISOString(),
  last_at: null,
  last_path: '',
};

export function recordRequest(kind, pathname) {
  stats.total += 1;
  if (kind === 'allowed') stats.allowed += 1;
  else if (kind === 'rejected') stats.rejected += 1;
  else if (kind === 'limited') stats.limited += 1;
  else if (kind === 'open') { stats.open += 1; stats.allowed += 1; }
  stats.last_at = new Date().toISOString();
  if (pathname) stats.last_path = pathname;
}

export function getStats() {
  return { ...stats };
}

export function resetStats() {
  stats.total = 0;
  stats.allowed = 0;
  stats.rejected = 0;
  stats.limited = 0;
  stats.open = 0;
  stats.started_at = new Date().toISOString();
  stats.last_at = null;
  stats.last_path = '';
}

/* ------------------------------ 汇总出参 ------------------------------ */

/**
 * `GET /api/v2/api/info` 的 data。
 * 端口取**这次请求实际落在的端口**（不是配置值）：端口被占时会顺延，页面必须显示真地址。
 */
export function apiInfoPayload(ctx, routes) {
  const port = Number(ctx?.port || ctx?.req?.socket?.localPort || API_PORT);
  return {
    host: API_HOST,
    port,
    url: `http://${API_HOST}:${port}/`,
    api_key: String(ctx?.apiKey || ''),
    verify: apiVerifyEnabled(),
    stats: getStats(),
    mcp: {
      script: MCP_SCRIPT_PATH,
      // 说明「怎么起」由页面拼配置，这里只给事实：脚本路径 + 解释器
      command: 'node',
    },
    endpoint_total: routes.length,
    endpoints: routeCatalog(routes),
  };
}
