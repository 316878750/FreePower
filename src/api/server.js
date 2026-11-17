import http from 'node:http';
import { createRequire } from 'node:module';
import { API_HOST, RATE_LIMIT_DEFAULT, RATE_LIMIT_MCP, RATE_LIMIT_UI, RATE_LIMIT_FBBIRD, API_PORT } from '../config.js';
import { ensureApiKey } from '../store/db.js';
import { apiVerifyEnabled, recordRequest } from './info.js';
import { stopAll } from '../runtime/manager.js';
import { ApiError, ERR, TOO_MANY_MSG } from './contract.js';
import { isStaticPath, renderIndex, resolveStatic, sendStatic } from './static.js';
import { buildRoutes } from './routes.js';
import { redeemTicket } from './tickets.js';

/**
 * 请求体上限：默认 64 MB，`FREEPOWER_MAX_BODY`（字节）可覆盖。
 *
 * 为什么从 2 MB 提到 64 MB：用户从 AdsPower 导出的 `.txt` 实测 18,884,174 B / 50 块
 * （单块 cookie 行最长 559,542 字符），整份塞进一个请求是 21,157,002 B —— 2 MB 上限下
 * 连接被直接掐断，界面只看到英文 `Failed to fetch`。
 * 64 MB 是「一份 50 块的导出文件 × 3 倍余量」，不是无上限；超过照样明确报 413。
 */
const MAX_BODY_DEFAULT = 64 * 1024 * 1024;
/**
 * 超限后**最多再读这么多字节然后放弃**。
 * 正常超限（几十 MB）会读完再回 413；只有客户端真往本机灌 >512 MB 这种极端情况才断开。
 */
const MAX_DRAIN = 512 * 1024 * 1024;

/** 每次请求现读 env：改了不用重启进程也能生效，判据里也好改 */
function maxBodyBytes() {
  const v = Number(process.env.FREEPOWER_MAX_BODY);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : MAX_BODY_DEFAULT;
}

// 版本号**从 package.json 读**，别再写死常量：0.3.2 那个常量让控制台一直显示 v0.3.2，
// 升了版本看起来像没升（巡检在 0.4.1 上实测到过）。
// 相对路径：本文件在 src/api/，应用根 = ../../package.json；打进 asar 后目录结构不变，
// 所以 asar 内同样解析得到（0.4.1 在解包出来的 app.asar 上验过）。
const require = createRequire(import.meta.url);
const VERSION = require('../../package.json').version;

/* ------------------------------- 限流 ------------------------------- */
const buckets = new Map();;
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

/* ------------------------------ 路由匹配 ------------------------------ */
/**
 * 路径匹配：静态路径仍然全等（54 条老路由的行为一个字节不变）；
 * 带 `:name` 的段按「一段非空」匹配，取出来的值进 `ctx.params`。
 * 目前只有 AI Agent 的三条动态路由（`/agent/workflow/:id/...`）用到。
 * 编译结果按路径字符串缓存 —— 路由表只建一次，不必每请求重编译。
 */
const pathMatchers = new Map();
function matcherFor(pattern) {
  const hit = pathMatchers.get(pattern);
  if (hit) return hit;
  const names = [];
  const src = pattern.split('/').map((seg) => {
    if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)'; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  const out = { re: new RegExp(`^${src}$`), names };
  pathMatchers.set(pattern, out);
  return out;
}

function matchRoute(routes, method, pathname) {
  for (const r of routes) {
    if (!r.methods.includes(method)) continue;
    if (r.path === pathname) return { route: r, params: {} };
    if (!r.path.includes(':')) continue;
    const { re, names } = matcherFor(r.path);
    const m = re.exec(pathname);
    if (!m) continue;
    const params = {};
    for (let i = 0; i < names.length; i++) {
      try { params[names[i]] = decodeURIComponent(m[i + 1]); } catch { params[names[i]] = m[i + 1]; }
    }
    return { route: r, params };
  }
  return null;
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
/**
 * 读请求体。超限时**先把剩下的字节读完再抛 413**，不是先断开。
 *
 * 为什么要「读完再回」：实测四种写法（Node 24 / undici fetch，body 21 MB、上限 2 MB）
 *
 *   先 reject + req.destroy()      → 客户端 `fetch failed`（现状，就是用户看到的英文报错）
 *   只 res.end(413) 不管剩余请求体   → 客户端 `fetch failed`
 *   res.end 之后再 destroy         → 客户端 `fetch failed`
 *   **读完剩余请求体，'end' 时回 413** → 客户端 HTTP 413 + 完整 JSON ✓
 *
 * 原因：客户端还在写的时候服务端就关连接，客户端把这次请求当网络错误，读不到响应。
 * 所以只有「让客户端把话说完，再告诉它太大」这条路能真把 msg 送到界面。
 */
function readBody(req) {
  const limit = maxBodyBytes();
  return new Promise((resolve, reject) => {
    let size = 0;
    let drained = 0;
    /** 超限时记下「已经收到的字节数」；非 null 表示已决定回 413，后续只读不存 */
    let overflowAt = null;
    const chunks = [];

    req.on('data', (c) => {
      size += c.length;
      if (overflowAt === null) {
        if (size > limit) {
          overflowAt = size;
          chunks.length = 0; // 已经没用了，早点放手
          return;
        }
        chunks.push(c);
        return;
      }
      drained += c.length;
      if (drained > MAX_DRAIN) {
        // 极端情况：客户端往本机灌超过 512 MB。不再等它说完，断开并如实报「太大」。
        reject(new ApiError(ERR.INVALID,
          `请求体过大：已收到 ${size} 字节，上限 ${limit} 字节；请分批导入`, 413));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (overflowAt !== null) {
        // 数字要能指导动作：告诉用户多大、上限多少、该怎么做
        return reject(new ApiError(ERR.INVALID,
          `请求体过大：${size} 字节，上限 ${limit} 字节；请分批导入`
          + `（控制台导入 .txt 会自动分批；脚本可调 FREEPOWER_MAX_BODY 调大上限）`, 413));
      }
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

/**
 * 二进制应答：只给工作流截图（PNG）用。**不**做成通用文件读取通道 ——
 * 路径校验在路由里（`normalizeShotPath` + `resolveShotPath`），这里只管写字节。
 */
function sendBytes(res, bytes, type = 'application/octet-stream', extraHeaders = {}) {
  res.writeHead(200, {
    'content-type': type,
    'content-length': bytes.length,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(bytes);
}

export function createApiServer({ port } = {}) {
  const initialKey = ensureApiKey({ port: port || API_PORT });
  /**
   * key 放在**可变引用**里：控制台能重置 key（`POST /api/v2/api/key/reset`），
   * 重置之后这个进程必须立刻用新 key 校验。做成常量的话，重置完只有重启才生效 ——
   * 用户点完「重置」，旧 key 还能用，那是安全缺陷。
   */
  const auth = { key: initialKey };
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
          return sendHtml(res, renderIndex({ apiKey: auth.key, port: port || API_PORT, version: VERSION }));
        } catch {
          return sendText(res, 500, 'web console not found: missing web/index.html');
        }
      }
      const file = resolveStatic(url.pathname.slice('/ui/'.length));
      if (!file) return sendText(res, 404, 'not found');
      return sendStatic(res, file, corsHeaders);
    }

    const matched = matchRoute(routes, req.method, url.pathname);
    const route = matched?.route;
    const routeParams = matched?.params || {};
    if (!route) return send(res, 404, { code: ERR.GENERIC, msg: `no route ${req.method} ${url.pathname}`, data: { supported: false, path: url.pathname } }, corsHeaders);

    if (route.auth !== false) {
      // 自检报告页在浏览器里直接打开，不能带 master key：允许 route.ticket 声明的路由
      // 用短期票据代替 key（票据绑定 profile_id，泄露影响面只有一个环境的报告）
      const usesTicket = !!route.ticket
        && redeemTicket(url.searchParams.get('ticket'), url.searchParams.get('profile_id'));
      if (usesTicket) {
        recordRequest('allowed', url.pathname);
      } else {
        // 「API 验证」开关（控制台可关）：关掉就不校验 key，对齐对手的开关语义。
        // 注意**限流照旧**：这个开关管的是「认不认人」，不是「能不能打爆本机」。
        const verify = apiVerifyEnabled();
        if (verify) {
          const key = extractKey(req, url);
          if (!key || key !== auth.key) {
            recordRequest('rejected', url.pathname);
            return send(res, 401, { code: ERR.GENERIC, msg: 'invalid api_key' }, corsHeaders);
          }
        }
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
        // 桶键用**服务自己的 key**（不是请求带来的 key）：验证关掉时匿名请求没有 key，
        // 用空串分桶会让所有匿名请求共用一个桶 —— 那正是想要的（它们本来就是同一批人）。
        const bucket = `${auth.key}|${tier}`;
        if (!rateLimit(bucket, limit)) {
          recordRequest('limited', url.pathname);
          // 超限报文逐字对齐对手（脚本按这句判断要不要重试）
          return send(res, 200, { code: ERR.GENERIC, msg: TOO_MANY_MSG }, corsHeaders);
        }
        recordRequest(verify ? 'allowed' : 'open', url.pathname);
      }
    }

    try {
      // 对手的 v2 active 允许 GET 带 body，这里只要客户端发了 body 就读
      const hasBody = req.method === 'POST' || Number(req.headers['content-length'] || 0) > 0;
      const body = hasBody ? await readBody(req) : {};
      const ctx = {
        req,
        // 服务自己的 key：agent 执行器要拿它回调本地 API（同一进程，不经网络再查库）
        apiKey: auth.key,
        // 控制台重置 key 用：改完这个引用，后续请求立刻按新 key 校验
        setApiKey: (k) => { auth.key = String(k || ''); },
        // 这次请求实际落在的端口（端口被占会顺延，页面必须显示真地址）
        port: req.socket?.localPort || port || API_PORT,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        body,
        // 动态段参数（静态路由恒为 {}），只有 `/agent/workflow/:id/...` 这组用
        params: routeParams,
      };
      const out = await route.handler(ctx);
      // `__htmlHeaders`：起始页要带 CSP（页面自己一个外连都不许发），
      // 头只能在服务端发 —— 页面里的 <meta> 是第二道，不是第一道。
      if (out && typeof out.__html === 'string') sendHtml(res, out.__html, { ...corsHeaders, ...(out.__htmlHeaders || {}) });
      else if (out && out.__bytes) sendBytes(res, out.__bytes, out.contentType, corsHeaders);
      else send(res, 200, out, corsHeaders);
    } catch (e) {
      if (e instanceof ApiError) {
        const extra = Object.keys(e.extra || {}).length ? { data: e.extra } : {};
        // 413 明确关连接：这次请求体我们没消费完（或刚好消费完），别让客户端拿这条连接再发
        const hdrs = e.httpStatus === 413 ? { ...corsHeaders, connection: 'close' } : corsHeaders;
        return send(res, e.httpStatus, { code: e.code, msg: e.message, ...extra }, hdrs);
      }
      if (e && e.fieldErrors) {
        // profile schema 校验失败：100002 + 字段级明细
        return send(res, 200, { code: ERR.INVALID, msg: e.message, data: { errors: e.fieldErrors, warnings: e.warnings || [] } }, corsHeaders);
      }
      send(res, 500, { code: ERR.GENERIC, msg: e.message }, corsHeaders);
    }
  });

  server.on('close', () => { stopAll(); });
  // 返回的 apiKey 是**启动时**那把；重置之后以 `ctx.apiKey` / `data/local_api` 为准。
  return { server, apiKey: initialKey };
}
