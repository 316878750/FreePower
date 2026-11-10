/**
 * Local API 客户端。
 *
 * 界面只走 HTTP Local API，没有任何私有通道 —— 界面能做的事，
 * 用 curl 一定也能做（出问题时用户能绕开界面救急，这也顺带压着 API 契约别乱长）。
 */

const boot = (typeof window !== 'undefined' && window.__FP__) || {};

export class FpError extends Error {
  constructor(payload, httpStatus = 200) {
    super(payload && payload.msg ? payload.msg : `HTTP ${httpStatus}`);
    this.code = payload && payload.code !== undefined ? payload.code : -1;
    this.data = (payload && payload.data) || {};
    this.httpStatus = httpStatus;
  }
}

function key() {
  return boot.apiKey || sessionStorage.getItem('fp_key') || '';
}

async function call(path, { method = 'GET', body, query, timeoutMs = 90000 } = {}) {
  const url = new URL(path, location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }
  const ctrl = new AbortController();
  // 启动一个环境可能要十几秒（拉起内核 + 自检），不能几十毫秒就掐
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'api-key': key(),
        'x-freepower-client': 'ui',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    throw new FpError({ code: -1, msg: 'API Key 无效：确认服务还开着，或重启控制台页面' }, 401);
  }
  if (res.status === 403) {
    throw new FpError({ code: -1, msg: '请求被拒绝（Origin 不在白名单）' }, 403);
  }
  let json = null;
  try { json = await res.json(); } catch { /* 空响应或纯文本 */ }
  if (!json) throw new FpError({ code: -1, msg: `HTTP ${res.status}` }, res.status);
  if (json.code !== 0) throw new FpError(json, res.status);
  return json.data === undefined ? null : json.data;
}

export const api = {
  boot,
  key,
  get: (path, query) => call(path, { query }),
  post: (path, body) => call(path, { method: 'POST', body: body || {} }),

  /* ---- 环境 ---- */
  list: (q) => call('/api/v2/browser-profile/list', { method: 'POST', body: { ...q } }),
  detail: (id) => call('/api/v2/browser-profile/detail', { query: { profile_id: id } }),
  create: (p) => call('/api/v2/browser-profile/create', { method: 'POST', body: p }),
  update: (p) => call('/api/v2/browser-profile/update', { method: 'POST', body: p }),
  remove: (ids) => call('/api/v2/browser-profile/delete', { method: 'POST', body: { profile_id: ids } }),
  start: (id) => call('/api/v2/browser-profile/start', { query: { profile_id: id } }),
  stop: (id) => call('/api/v2/browser-profile/stop', { query: { profile_id: id } }),
  running: () => call('/api/v2/browser-profile/local-active'),
  batchStart: (ids, opts) => call('/api/v2/browser-profile/batch-start', { method: 'POST', body: { profile_ids: ids, ...opts } }),
  batchStop: (ids, opts) => call('/api/v2/browser-profile/batch-stop', { method: 'POST', body: { profile_ids: ids, ...opts } }),
  stopAll: () => call('/api/v2/browser-profile/stop-all', { method: 'POST', body: {} }),

  /* ---- schema / 校验 ---- */
  schema: () => call('/api/v2/browser-profile/schema'),
  validate: (profile, mode) => call('/api/v2/browser-profile/validate', { method: 'POST', body: { mode, profile } }),

  /* ---- 分组 / 标签 ---- */
  groups: () => call('/api/v2/group/list'),
  groupCreate: (name) => call('/api/v2/group/create', { method: 'POST', body: { group_name: name } }),
  tags: () => call('/api/v2/browser-tags/list', { method: 'POST', body: { limit: 200 } }),
  tagCreate: (tags) => call('/api/v2/browser-tags/create', { method: 'POST', body: { tags } }),

  /* ---- 代理 ---- */
  proxies: () => call('/api/v2/proxy-list/list', { method: 'POST', body: { limit: 500 } }),
  proxyCreate: (list) => call('/api/v2/proxy-list/create', { method: 'POST', body: list }),
  proxyUpdate: (one) => call('/api/v2/proxy-list/update', { method: 'POST', body: one }),
  proxyDelete: (ids) => call('/api/v2/proxy-list/delete', { method: 'POST', body: { proxy_id: ids } }),
  proxyCheck: (cfg) => call('/api/v2/proxy/check', { method: 'POST', body: { proxy_config: cfg }, timeoutMs: 30000 }),

  /* ---- 自检 ---- */
  selfcheck: (id, { rerun = false } = {}) => call('/api/v2/browser-profile/selfcheck', { query: { profile_id: id, rerun: rerun ? 1 : '' } }),
  selfcheckSummary: (ids) => call('/api/v2/browser-profile/selfcheck-summary', { method: 'POST', body: { profile_ids: ids } }),
  selfcheckHtmlUrl: (id) => `/api/v2/browser-profile/selfcheck?profile_id=${encodeURIComponent(id)}&format=html&api_key=${encodeURIComponent(key())}`,

  /* ---- 内核 ---- */
  kernels: () => call('/api/v2/browser-profile/kernels', { query: { kernel_type: 'chrome' } }),
};