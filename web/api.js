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
  /** 运行中改配置：stop → apply → start，一个请求里做完（不用用户先停再启） */
  restart: (p) => call('/api/v2/browser-profile/restart', { method: 'POST', body: p }),
  remove: (ids) => call('/api/v2/browser-profile/delete', { method: 'POST', body: { profile_id: ids } }),
  start: (id) => call('/api/v2/browser-profile/start', { query: { profile_id: id } }),
  stop: (id) => call('/api/v2/browser-profile/stop', { query: { profile_id: id } }),
  running: () => call('/api/v2/browser-profile/local-active'),
  batchStart: (ids, opts) => call('/api/v2/browser-profile/batch-start', { method: 'POST', body: { profile_ids: ids, ...opts } }),
  batchStop: (ids, opts) => call('/api/v2/browser-profile/batch-stop', { method: 'POST', body: { profile_ids: ids, ...opts } }),
  stopAll: () => call('/api/v2/browser-profile/stop-all', { method: 'POST', body: {} }),

  /* ---- 导入 / 导出 / 复制（P10） ---- */
  importProfiles: (list) => call('/api/v2/browser-profile/import', { method: 'POST', body: { list } }),
  /** AdsPower `.txt` 块格式（账号+代理+cookie+UA 的搬运单，不是全量备份） */
  importProfilesTxt: (content) => call('/api/v2/browser-profile/import', { method: 'POST', body: { format: 'txt', content } }),
  exportProfiles: (ids, format = 'json') => call('/api/v2/browser-profile/export', { method: 'POST', body: { profile_id: ids, format } }),
  copyProfile: (id, name) => call('/api/v2/browser-profile/copy', { method: 'POST', body: { profile_id: id, name } }),
  /** cookie 只走运行中的内核；环境没在跑会拿到 800002（不会为了导出偷偷起内核） */
  cookieExport: (id, format = 'json') => call('/api/v2/browser-profile/cookie/export', { query: { profile_id: id, format } }),
  cookieImport: (id, body) => call('/api/v2/browser-profile/cookie/import', { method: 'POST', body: { profile_id: id, ...body } }),

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
  /** 批量健康检查：服务端限并发 3、单条 10s（超时记 fail，不拖住整批） */
  proxyCheckBatch: (ids) => call('/api/v2/proxy/check-batch', { method: 'POST', body: { proxy_ids: ids }, timeoutMs: 120000 }),

  /* ---- 自检 ---- */
  selfcheck: (id, { rerun = false } = {}) => call('/api/v2/browser-profile/selfcheck', { query: { profile_id: id, rerun: rerun ? 1 : '' } }),
  selfcheckSummary: (ids) => call('/api/v2/browser-profile/selfcheck-summary', { method: 'POST', body: { profile_ids: ids } }),
  selfcheckHtmlUrl: async (id) => {
    const t = await call('/api/v2/browser-profile/selfcheck-ticket', { method: 'POST', body: { profile_id: id } });
    return t.url;
  },

  /* ---- 内核 ---- */
  kernels: () => call('/api/v2/browser-profile/kernels', { query: { kernel_type: 'chrome' } }),

  /* ---- 本地 API 自述（0.4.2） ---- */
  /** 地址 / key / 验证开关 / 请求计数 / 端点清单，一次拿完 */
  apiInfo: () => call('/api/v2/api/info'),
  /** 关掉 = 不校验 api_key（对齐对手的开关语义）；代价见 README 的安全边界 */
  setVerify: (enabled) => call('/api/v2/api/verify', { method: 'POST', body: { enabled } }),
  resetKey: () => call('/api/v2/api/key/reset', { method: 'POST', body: {} }),

  /* ---- 窗口同步（0.4.2） ---- */
  syncStart: (body) => call('/api/v2/sync/start', { method: 'POST', body }),
  syncStop: () => call('/api/v2/sync/stop', { method: 'POST', body: {} }),
  syncStatus: () => call('/api/v2/sync/status'),
  syncSettings: (body) => call('/api/v2/sync/settings', { method: 'POST', body }),
  syncRefresh: () => call('/api/v2/sync/refresh', { method: 'POST', body: {} }),
  syncUnifySize: () => call('/api/v2/sync/unify-size', { method: 'POST', body: {} }),
  /**
   * 窗口排列（`tileWin`）。参数照对手 `toRangeBrowser`：
   * `{width,height,row,top,left,hs,vs,range,screenId,screenList}`，`auto:true` = 一键排列。
   * 服务端摆完会回读每个窗口，`summary.failed>0` 就是「有 N 个窗口没能排到位」，必须显示出来。
   */
  syncArrange: (body) => call('/api/v2/sync/arrange', { method: 'POST', body }),
  /** 显示器列表（桌面壳写、服务进程读）。没有桌面壳时 `managed:false`，不是错误 */
  syncDisplays: () => call('/api/v2/sync/displays'),
  /**
   * 显示窗口（`viewWin`）：最小化的恢复出来并放到前台。
   * 返回值里 `raise` 逐窗口说明是真到前台（`restored`）还是只做了页面级激活（`page_only`），
   * `os_foreground` 只有全部真到前台时才是 true —— 面板据此显示提示，不假装都到前面了。
   */
  syncShow: (profileIds) => call('/api/v2/sync/show', {
    method: 'POST',
    body: profileIds === undefined ? {} : { profile_ids: Array.isArray(profileIds) ? profileIds : [profileIds] },
  }),
  /** 全局快捷键状态（managed=false 表示没有桌面壳在管，不是失败） */
  syncHotkey: () => call('/api/v2/sync/hotkey'),
  syncHotkeySet: (accelerator) => call('/api/v2/sync/hotkey', { method: 'POST', body: { accelerator } }),
  /* ---- 标签页管理（阶段 2） ---- */
  syncTabs: () => call('/api/v2/sync/tabs'),
  // 多行文本原样交给服务端切行（每行一个，最多 10 个；超了服务端报「一键最多打开10个网址」）
  syncOpenTab: (urls) => call('/api/v2/sync/tab', { method: 'POST', body: { urls } }),
  /** which: current（关当前）/ others（留当前，关其它）/ blank（关空白） */
  syncCloseTabs: (which) => call('/api/v2/sync/tab-close', { method: 'POST', body: { which } }),
  /** index 省略 = 复制主窗口当前可见那个标签 */
  syncCopyTab: (index) => call('/api/v2/sync/tab-copy', { method: 'POST', body: index === undefined ? {} : { index } }),
  syncUnifyTabs: () => call('/api/v2/sync/tab-unify', { method: 'POST', body: {} }),

  /* ---- AI Agent（0.4.0） ---- */
  /** 一句话目标 → 工作流：等服务端调模型（默认 60s 超时），所以给足本端等待时间 */
  agentCreateFromGoal: (body) => call('/api/v1/agent/workflow/create-from-goal', { method: 'POST', body }),
  agentStatus: (id) => call(`/api/v1/agent/workflow/${encodeURIComponent(id)}/status`),
  agentApprove: (id, body) => call(`/api/v1/agent/workflow/${encodeURIComponent(id)}/approve`, { method: 'POST', body }),
  agentRun: (id) => call(`/api/v1/agent/workflow/${encodeURIComponent(id)}/run`, { method: 'POST', body: {} }),
  /**
   * 截图要放进 `<img src>`，带不了 api-key 头；换一张 120 秒、绑 profile 的票据
   * （master key 绝不进 URL）。返回 `{url, ticket, expires_in, profile_id}`。
   */
  agentScreenshotTicket: (id) => call(`/api/v1/agent/workflow/${encodeURIComponent(id)}/screenshot-ticket`, { method: 'POST', body: {} }),
};