import http from 'node:http';
import { API_HOST, RATE_LIMIT_DEFAULT, RATE_LIMIT_MCP, API_PORT } from '../config.js';
import { ensureApiKey } from '../store/db.js';
import {
  createProfile, getProfile, listProfiles, updateProfile, deleteProfiles, regroupProfiles,
  newFingerprintFor, listGroups, createGroup,
} from '../store/profiles.js';
import { startProfile, stopProfile, listRunning, getRunning, stopAll } from '../runtime/manager.js';
import { toCanonical, toV2 } from '../../packages/profile/src/aliases.js';
import {
  ApiError, ERR, ok, normalizeLaunchArgs, serializeLaunchArgs, normalizePasswordFilling, serializePasswordFilling,
} from './contract.js';

const MAX_BODY = 2 * 1024 * 1024;

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
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]') return origin;
  } catch { /* ignore */ }
  return false;
}

/* --------------------------- 出站整形 --------------------------- */

/** 内部记录 → 对外（v1 补 user_id/serial_number，v2 用 profile_id/profile_no） */
function present(profile, version) {
  if (!profile) return null;
  const base = version === 'v2' ? toV2(profile) : { ...profile, user_id: profile.id, serial_number: profile.profile_no };
  if (profile.launch_args !== undefined) base.launch_args = serializeLaunchArgs(profile.launch_args, version);
  Object.assign(base, serializePasswordFilling(profile.disable_password_filling === '1'));
  return base;
}

/** 入站：v1/v2 参数名 → 内部键，并处理边界类型 */
function input(body = {}, version) {
  const canonical = toCanonical(body, version);
  if (body.launch_args !== undefined || body.browser_run_args !== undefined) {
    canonical.launch_args = normalizeLaunchArgs(body.launch_args ?? body.browser_run_args);
  }
  const pf = normalizePasswordFilling(body);
  if (pf !== undefined) canonical.disable_password_filling = pf ? '1' : '0';
  // v1 的 platform 是域名（toCanonical 已映到 domain_name），别覆盖 navigator.platform
  if (version === 'v1') delete canonical.platform;
  return canonical;
}

function requireId(ctx, version) {
  const id = version === 'v1'
    ? (ctx.query.user_id || ctx.body.user_id || ctx.query.profile_id)
    : (ctx.query.profile_id || ctx.body.profile_id || ctx.query.user_id);
  if (!id) throw new ApiError(ERR.INVALID, version === 'v2' ? 'profile_id is required' : 'user_id is required');
  return String(id);
}

/* ------------------------------- 路由 ------------------------------- */
function buildRoutes() {
  const routes = [];
  const add = (methods, paths, handler, opts = {}) => {
    for (const path of paths) routes.push({ methods, path, handler, ...opts });
  };
  const both = (nameV1, nameV2) => [`/api/v1/${nameV1}`, `/api/v2/${nameV2}`];
  const versionOf = (p) => (p.startsWith('/api/v2/') ? 'v2' : 'v1');

  add(['GET'], ['/status'], () => ({ code: 0, msg: 'success' }), { auth: false });

  /* ---- 列表 / 详情 ---- */
  add(['GET'], both('user/list', 'browser-profile/list'), (ctx) => {
    const r = listProfiles({
      page: ctx.query.page,
      page_size: ctx.query.page_size,
      group_id: ctx.query.group_id ?? ctx.query.batch_id,
      name: ctx.query.name,
    });
    const v = versionOf(ctx.path);
    return ok({ list: r.list.map((p) => present(p, v)), page: r.page, page_size: r.page_size, total: r.total });
  });

  add(['GET'], ['/api/v1/user/detail', '/api/v2/browser-profile/detail'], (ctx) => {
    const v = versionOf(ctx.path);
    const p = getProfile(requireId(ctx, v));
    if (!p) throw new ApiError(ERR.NOT_FOUND, 'profile not found');
    return ok(present(p, v));
  });

  /* ---- 创建 / 更新 ---- */
  add(['POST'], both('user/create', 'browser-profile/create'), (ctx) => {
    const v = versionOf(ctx.path);
    const p = createProfile(input(ctx.body, v));
    return ok(present(p, v));
  });

  add(['POST'], both('user/update', 'browser-profile/update'), (ctx) => {
    const v = versionOf(ctx.path);
    const id = requireId(ctx, v);
    if (getRunning(id)) throw new ApiError(ERR.GENERIC, 'profile is running, stop it before update');
    const p = updateProfile(id, input(ctx.body, v));
    if (!p) throw new ApiError(ERR.NOT_FOUND, 'profile not found');
    return ok(present(p, v));
  });

  add(['POST'], both('user/delete', 'browser-profile/delete'), async (ctx) => {
    const v = versionOf(ctx.path);
    const raw = v === 'v1' ? (ctx.body.user_ids || []) : (ctx.body.profile_ids || []);
    const ids = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map(String);
    if (!ids.length) throw new ApiError(ERR.INVALID, v === 'v2' ? 'profile_ids is required' : 'user_ids is required');
    for (const id of ids) if (getRunning(id)) await stopProfile(id);
    return ok({ deleted: deleteProfiles(ids) });
  });

  add(['POST'], ['/api/v1/user/regroup', '/api/v2/browser-profile/regroup'], (ctx) => {
    const ids = ctx.body.user_ids || ctx.body.profile_ids || [];
    const group = ctx.body.group_id ?? ctx.body.batch_id ?? '0';
    return ok({ changed: regroupProfiles(ids, group) });
  });

  add(['POST'], both('user/new-fingerprint', 'browser-profile/new-fingerprint'), (ctx) => {
    const v = versionOf(ctx.path);
    const p = newFingerprintFor(requireId(ctx, v));
    if (!p) throw new ApiError(ERR.NOT_FOUND, 'profile not found');
    return ok(present(p, v));
  });

  /* ---- 分组 ---- */
  add(['GET'], ['/api/v1/group/list', '/api/v2/group/list'], () => ok({ list: listGroups() }));
  add(['POST'], ['/api/v1/group/create', '/api/v2/group/create'], (ctx) => {
    if (!ctx.body.group_name) throw new ApiError(ERR.INVALID, 'group_name required');
    return ok(createGroup(ctx.body.group_name));
  });

  /* ---- 浏览器生命周期 ---- */
  add(['GET'], both('browser/start', 'browser-profile/start'), async (ctx) => {
    const v = versionOf(ctx.path);
    const id = requireId(ctx, v);
    const p = getProfile(id);
    if (!p) throw new ApiError(ERR.NOT_FOUND, 'profile not found');
    const live = getRunning(id);
    if (live) return ok({ ...live, already_running: true });
    try {
      return ok(await startProfile({ ...p, id }));
    } catch (e) {
      throw new ApiError(e.code === 800005 ? ERR.CONSISTENCY : ERR.START_FAILED, `start failed: ${e.message}`, 200, { errors: e.errors });
    }
  });

  add(['GET'], both('browser/stop', 'browser-profile/stop'), async (ctx) => {
    const v = versionOf(ctx.path);
    const r = await stopProfile(requireId(ctx, v));
    if (!r.stopped) throw new ApiError(ERR.NOT_RUNNING, 'profile is not running');
    return ok(r);
  });

  add(['GET'], both('browser/active', 'browser-profile/active'), (ctx) => {
    const v = versionOf(ctx.path);
    const id = ctx.query.user_id || ctx.query.profile_id;
    const list = id ? listRunning().filter((x) => x.profile_id === String(id)) : listRunning();
    return ok({ list: list.map((x) => present(x, v)) });
  });

  add(['GET'], ['/api/v1/browser/local-active', '/api/v2/browser-profile/local-active'], () => ok({ list: listRunning() }));

  return routes;
}

/* ------------------------------- 服务 ------------------------------- */
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
      try { resolve(JSON.parse(text)); } catch { reject(new ApiError(ERR.INVALID, 'invalid json body')); }
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

export function createApiServer({ port } = {}) {
  const apiKey = ensureApiKey({ port: port || API_PORT });
  const routes = buildRoutes();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${API_HOST}`);
    const origin = req.headers.origin;

    const allowed = corsOrigin(origin);
    const corsHeaders = allowed ? {
      'access-control-allow-origin': allowed,
      'access-control-allow-headers': 'content-type,api_key,authorization,x-api-key,x-freepower-client',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    } : {};
    if (origin && allowed === false) return send(res, 403, { code: ERR.GENERIC, msg: 'origin not allowed' });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      return res.end();
    }

    const route = routes.find((r) => r.methods.includes(req.method) && r.path === url.pathname);
    if (!route) return send(res, 404, { code: ERR.GENERIC, msg: `no route ${req.method} ${url.pathname}` }, corsHeaders);

    if (route.auth !== false) {
      const key = extractKey(req, url);
      if (!key || key !== apiKey) return send(res, 401, { code: ERR.GENERIC, msg: 'invalid api_key' }, corsHeaders);
      const limit = req.headers['x-freepower-client'] === 'mcp' ? RATE_LIMIT_MCP : RATE_LIMIT_DEFAULT;
      if (!rateLimit(key + '|' + (req.headers['x-freepower-client'] || ''), limit)) {
        return send(res, 429, { code: ERR.GENERIC, msg: `rate limit: ${limit}/s` }, corsHeaders);
      }
    }

    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const ctx = {
        req,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        body,
      };
      const out = await route.handler(ctx);
      send(res, 200, out, corsHeaders);
    } catch (e) {
      if (e instanceof ApiError) {
        const extra = Object.keys(e.extra || {}).length ? { data: e.extra } : {};
        return send(res, e.httpStatus, { code: e.code, msg: e.message, ...extra }, corsHeaders);
      }
      send(res, 500, { code: ERR.GENERIC, msg: e.message }, corsHeaders);
    }
  });

  server.on('close', () => { stopAll(); });
  return { server, apiKey };
}