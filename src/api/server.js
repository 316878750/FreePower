import http from 'node:http';
import { API_HOST, RATE_LIMIT_DEFAULT, RATE_LIMIT_MCP, RATE_LIMIT_UI, RATE_LIMIT_FBBIRD, API_PORT } from '../config.js';
import { ensureApiKey } from '../store/db.js';
import { stopAll } from '../runtime/manager.js';
import { ApiError, ERR, TOO_MANY_MSG } from './contract.js';
import { isStaticPath, renderIndex, resolveStatic, sendStatic } from './static.js';
import { buildRoutes } from './routes.js';
import { redeemTicket } from './tickets.js';

const MAX_BODY = 2 * 1024 * 1024;
const VERSION = '0.3.2';

/* ------------------------------- 限流 ------------------------------- */
const buckets = new Map();
function rateLimit(key, limit) {
  const now = Date.now();
  const b = buckets.get(key) || { tokens: limit, ts: now };
  const elapsed = (now - b.ts) / 1000;
  b.tokens = Math.min(limit, b.tokens + elapsed * limit);
  b.ts = now;
  if (b.tokens < 1) { buckets.set(key, b); return false; }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}

/* ------------------------------- 鉴权 ------------------------------- */
function extractKey(req, url) {
  const q = url.searchParams.get('api_key');
  if (q) return q;
  // 对手的头是 api-key；另外两种是我们自己的风格，老的也说不要直接扔掉
  const h = req.headers['api-key'] || req.headers['api_key'] || req.headers['x-api-key'];
  if (h) return String(h);
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1] : '';
}

function corsOrigin(origin) {
  if (!origin) return null;
  try {
    const u = new URL(origin);
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]') return origin;
  } catch { /* ignore */ }
  return false;
}

/* ------------------------------- 传输 ------------------------------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new ApiError(ERR.INVALID, 'body too large', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        // proxy-list/create 的 body 是顶层数组：包一层，路由里再拆
        resolve(parsed);
      } catch { reject(new ApiError(ERR.INVALID, 'invalid json body')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, status, text, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

function sendHtml(res, html, extraHeaders = {}) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    ...extraHeaders,
  });
  res.end(html);
}

export function createApiServer({ port } = {}) {
  const apiKey = ensureApiKey({ port: port || API_PORT });
  const routes = buildRoutes();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${API_HOST}`);
    const origin = req.headers.origin;

    const allowed = corsOrigin(origin);
    const corsHeaders = allowed ? {
      'access-control-allow-origin': allowed,
      'access-control-allow-headers': 'content-type,api-key,api_key,authorization,x-api-key,x-freepower-client,x-adspower-client',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    } : {};
    // 对手的行为：Origin 不在白名单 → 403 + 纯文本 `CORS ERROR`（不是 JSON）
    if (origin && allowed === false) return sendText(res, 403, 'CORS ERROR');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      return res.end();
    }

    // Web 控制台：静态页不走 API 鉴权（页面自己拿注入的 key 去调 API），
    // 但同样受 Origin 白名单约束 —— 别的站点嵌不了这个控制台。
    if (isStaticPath(url.pathname)) {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        try {
          return sendHtml(res, renderIndex({ apiKey, port: port || API_PORT, version: VERSION }));
        } catch {
          return sendText(res, 500, 'web console not found: missing web/index.html');
        }
      }
      const file = resolveStatic(url.pathname.slice('/ui/'.length));
      if (!file) return sendText(res, 404, 'not found');
      return sendStatic(res, file, corsHeaders);
    }

    const route = routes.find((r) => r.methods.includes(req.method) && r.path === url.pathname);
    if (!route) return send(res, 404, { code: ERR.GENERIC, msg: `no route ${req.method} ${url.pathname}`, data: { supported: false, path: url.pathname } }, corsHeaders);

    if (route.auth !== false) {
      // 自检报告页在浏览器里直接打开，不能带 master key：允许 route.ticket 声明的路由
      // 用短期票据代替 key（票据绑定 profile_id，泄露影响面只有一个环境的报告）
      const usesTicket = !!route.ticket
        && redeemTicket(url.searchParams.get('ticket'), url.searchParams.get('profile_id'));
      if (!usesTicket) {
        const key = extractKey(req, url);
        if (!key || key !== apiKey) return send(res, 401, { code: ERR.GENERIC, msg: 'invalid api_key' }, corsHeaders);
        const client = String(req.headers['x-freepower-client'] || '').toLowerCase();
        const isMcp = ['mcp', '1'].includes(client)
          || String(req.headers['x-adspower-client'] || '').toLowerCase() === 'mcp';
        const isUi = client === 'ui';
        // 档位：mcp / ui 头照旧升档；否则看路由自己声明的档位（目前只有 fbbird 列表是 10/s），默认 1/s。
        // 桶键里带上档位名，所以 fbbird 那 10 发不会占掉同一把 key 的 std 配额（对手也是分开的两个桶）。
        const tier = isMcp ? 'mcp' : isUi ? 'ui' : (route.rateTier || 'std');
        const limit = tier === 'mcp' ? RATE_LIMIT_MCP
          : tier === 'ui' ? RATE_LIMIT_UI
          : tier === 'fbbird' ? RATE_LIMIT_FBBIRD
          : RATE_LIMIT_DEFAULT;
        const bucket = `${key}|${tier}`;
        if (!rateLimit(bucket, limit)) {
          // 超限报文逐字对齐对手（脚本按这句判断要不要重试）
          return send(res, 200, { code: ERR.GENERIC, msg: TOO_MANY_MSG }, corsHeaders);
        }
      }
    }

    try {
      // 对手的 v2 active 允许 GET 带 body，这里只要客户端发了 body 就读
      const hasBody = req.method === 'POST' || Number(req.headers['content-length'] || 0) > 0;
      const body = hasBody ? await readBody(req) : {};
      const ctx = {
        req,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        body,
      };
      const out = await route.handler(ctx);
      if (out && typeof out.__html === 'string') sendHtml(res, out.__html, corsHeaders);
      else send(res, 200, out, corsHeaders);
    } catch (e) {
      if (e instanceof ApiError) {
        const extra = Object.keys(e.extra || {}).length ? { data: e.extra } : {};
        return send(res, e.httpStatus, { code: e.code, msg: e.message, ...extra }, corsHeaders);
      }
      if (e && e.fieldErrors) {
        // profile schema 校验失败：100002 + 字段级明细
        return send(res, 200, { code: ERR.INVALID, msg: e.message, data: { errors: e.fieldErrors, warnings: e.warnings || [] } }, corsHeaders);
      }
      send(res, 500, { code: ERR.GENERIC, msg: e.message }, corsHeaders);
    }
  });

  server.on('close', () => { stopAll(); });
  return { server, apiKey };
}
