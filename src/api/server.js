import http from 'node:http';
import { API_HOST, RATE_LIMIT_DEFAULT, RATE_LIMIT_MCP } from '../config.js';
import { ensureApiKey } from '../store/db.js';
import {
  createProfile, getProfile, listProfiles, updateProfile, deleteProfiles, regroupProfiles,
  newFingerprintFor, listGroups, createGroup,
} from '../store/profiles.js';
import { startProfile, stopProfile, listRunning, getRunning, stopAll } from '../runtime/manager.js';

const MAX_BODY = 2 * 1024 * 1024;

class ApiError extends Error {
  constructor(code, msg, httpStatus = 200) {
    super(msg);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

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
  const h = req.headers['api_key'] || req.headers['x-api-key'];
  if (h) return String(h);
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1] : '';
}

function corsOrigin(origin) {
  if (!origin) return null;
  try {
    const u = new URL(origin);
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return origin;
  } catch { /* ignore */ }
  return false;
}

/* ------------------------------- 路由 ------------------------------- */
function buildRoutes(apiKey) {
  const routes = [];
  const add = (method, path, handler, opts = {}) => routes.push({ method, path, handler, ...opts });

  // 探活：无鉴权，形状对齐 AdsPower（{"code":0,"msg":"success"}）
  add('GET', '/status', () => ({ code: 0, msg: 'success' }), { auth: false });

  add('GET', '/api/v1/user/list', (ctx) => {
    const r = listProfiles({
      page: ctx.query.page,
      page_size: ctx.query.page_size,
      group_id: ctx.query.group_id,
      name: ctx.query.name,
    });
    return { code: 0, msg: 'success', data: { list: r.list, page: r.page, page_size: r.page_size, total: r.total } };
  });

  add('GET', '/api/v1/user/detail', (ctx) => {
    const p = getProfile(ctx.query.user_id || ctx.query.profile_id);
    if (!p) throw new ApiError(-1, 'profile not found');
    return { code: 0, msg: 'success', data: p };
  });

  add('POST', '/api/v1/user/create', (ctx) => {
    const p = createProfile(ctx.body || {});
    return { code: 0, msg: 'success', data: p };
  });

  add('POST', '/api/v1/user/update', (ctx) => {
    const id = ctx.body.user_id || ctx.body.profile_id;
    const p = updateProfile(id, ctx.body);
    if (!p) throw new ApiError(-1, 'profile not found');
    return { code: 0, msg: 'success', data: p };
  });

  add('POST', '/api/v1/user/delete', (ctx) => {
    const ids = ctx.body.user_ids || (ctx.body.user_id ? [ctx.body.user_id] : []);
    if (!ids.length) throw new ApiError(-1, 'user_ids required');
    // 运行中的环境先停，避免删了记录还留一个活进程
    for (const id of ids) if (getRunning(id)) stopProfile(id);
    const deleted = deleteProfiles(ids);
    return { code: 0, msg: 'success', data: { deleted } };
  });

  add('POST', '/api/v1/user/regroup', (ctx) => {
    const ids = ctx.body.user_ids || [];
    const changed = regroupProfiles(ids, ctx.body.group_id ?? '0');
    return { code: 0, msg: 'success', data: { changed } };
  });

  add('POST', '/api/v1/user/new-fingerprint', (ctx) => {
    const id = ctx.body.user_id || ctx.body.profile_id;
    const p = newFingerprintFor(id);
    if (!p) throw new ApiError(-1, 'profile not found');
    return { code: 0, msg: 'success', data: p };
  });

  add('GET', '/api/v1/group/list', () => ({ code: 0, msg: 'success', data: { list: listGroups() } }));

  add('POST', '/api/v1/group/create', (ctx) => {
    if (!ctx.body.group_name) throw new ApiError(-1, 'group_name required');
    return { code: 0, msg: 'success', data: createGroup(ctx.body.group_name) };
  });

  add('GET', '/api/v1/browser/start', async (ctx) => {
    const id = ctx.query.user_id || ctx.query.profile_id;
    const p = getProfile(id);
    if (!p) throw new ApiError(-1, 'profile not found');
    try {
      const r = await startProfile(p);
      return { code: 0, msg: 'success', data: r };
    } catch (e) {
      throw new ApiError(-1, `start failed: ${e.message}`);
    }
  });

  add('GET', '/api/v1/browser/stop', async (ctx) => {
    const id = ctx.query.user_id || ctx.query.profile_id;
    if (!id) throw new ApiError(-1, 'user_id required');
    const r = await stopProfile(id);
    return { code: 0, msg: 'success', data: r };
  });

  add('GET', '/api/v1/browser/active', (ctx) => {
    const id = ctx.query.user_id || ctx.query.profile_id;
    if (id) {
      const r = getRunning(id);
      return { code: 0, msg: 'success', data: r ? { list: listRunning().filter((x) => x.profile_id === id) } : { list: [] } };
    }
    return { code: 0, msg: 'success', data: { list: listRunning() } };
  });

  add('GET', '/api/v1/browser/local-active', () => ({ code: 0, msg: 'success', data: { list: listRunning() } }));

  return routes;
}

/* ------------------------------- 服务 ------------------------------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new ApiError(-1, 'body too large', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new ApiError(-1, 'invalid json body')); }
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

export function createApiServer() {
  const apiKey = ensureApiKey();
  const routes = buildRoutes(apiKey);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${API_HOST}`);
    const origin = req.headers.origin;

    // CORS：只放 127.0.0.1 / localhost，其他 Origin 直接 403（对手也是这么做的）
    const allowed = corsOrigin(origin);
    const corsHeaders = allowed ? {
      'access-control-allow-origin': allowed,
      'access-control-allow-headers': 'content-type,api_key,authorization,x-api-key,x-freepower-client',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    } : {};
    if (origin && allowed === false) {
      // 对齐对手：CORS 拒绝是 403 + 纯文本，不是 JSON
      const body = 'CORS ERROR';
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      return res.end(body);
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      return res.end();
    }

    const route = routes.find((r) => r.method === req.method && r.path === url.pathname);
    if (!route) return send(res, 404, { code: -1, msg: `no route ${req.method} ${url.pathname}` }, corsHeaders);

    if (route.auth !== false) {
      const key = extractKey(req, url);
      if (!key || key !== apiKey) return send(res, 401, { code: -2, msg: 'invalid api_key' }, corsHeaders);
      const limit = req.headers['x-freepower-client'] === 'mcp' ? RATE_LIMIT_MCP : RATE_LIMIT_DEFAULT;
      if (!rateLimit(key + '|' + (req.headers['x-freepower-client'] || ''), limit)) {
        // 超限报文与对手逐字对齐（HTTP 200 + code:-1）
        return send(res, 200, { code: -1, msg: 'Too many request per second, please check' }, corsHeaders);
      }
    }

    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const ctx = {
        req,
        url,
        query: Object.fromEntries(url.searchParams.entries()),
        body,
      };
      const out = await route.handler(ctx);
      send(res, 200, out, corsHeaders);
    } catch (e) {
      if (e instanceof ApiError) return send(res, e.httpStatus, { code: e.code, msg: e.message }, corsHeaders);
      send(res, 500, { code: -1, msg: e.message }, corsHeaders);
    }
  });

  server.on('close', () => { stopAll(); });
  return { server, apiKey };
}
