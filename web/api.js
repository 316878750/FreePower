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
  } catch (e) {
    /**
     * 网络层失败**不许把英文原文抛给用户**。以前这里直接冒泡，用户看到的是一句
     * `导入失败：Failed to fetch` —— 既不知道发生了什么，也不知道该做什么。
     * 最常见的原因是「请求体超过服务端上限、连接被掐」，其次是服务没起来/请求超时。
     * 原始错误只进 console（排障用），界面上只给中文和下一步动作。
     */
    const timedOut = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
    console.warn('[fp] 请求失败', path, e);
    throw new FpError({
      code: -1,
      msg: timedOut
        ? `请求超时（${Math.round(timeoutMs / 1000)} 秒）：本机服务可能正忙。稍后重试；导入大文件请用「导入」按钮，它会自动分批`
        : '连不上本机服务：请求被中断或服务没响应。确认 FreePower 还在运行；'
          + '导入大文件时不要整份一次提交 —— 控制台的「导入」会自动分批',
      data: { network_error: String((e && e.message) || e), path },
    }, 0);
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
  groupCreate: (name, remark) => call('/api/v2/group/create', { method: 'POST', body: { group_name: name, remark } }),
  groupUpdate: (body) => call('/api/v2/group/update', { method: 'POST', body }),
  groupDelete: (id) => call('/api/v2/group/delete', { method: 'POST', body: { group_id: id } }),
  tags: () => call('/api/v2/browser-tags/list', { method: 'POST', body: { limit: 200 } }),
  tagCreate: (tags) => call('/api/v2/browser-tags/create', { method: 'POST', body: { tags } }),

  /* ---- 回收站（0.4.3 ②） ---- */
  recycleList: (page = 1, limit = 100) => call('/api/v2/browser-profile/recycle-bin/list', { method: 'POST', body: { page, limit } }),
  /** group_id 必填（对齐对手：恢复必须显式选一个分组） */
  recycleRestore: (profileId, groupId) => call('/api/v2/browser-profile/recycle-bin/restore', {
    method: 'POST', body: { profile_id: profileId, group_id: groupId },
  }),
  /** 彻底删除（我们自己的路由，对手没有）：删记录 + 删 user-data 目录，不可恢复 */
  recyclePurge: (body) => call('/api/v2/browser-profile/recycle-bin/purge', { method: 'POST', body, timeoutMs: 120000 }),

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
  /** 重启同步（`syncRestart`）：用当前配置 stop + start；`body.settings` 不给就沿用已存默认 */
  syncRestart: (body) => call('/api/v2/sync/restart', { method: 'POST', body: body || {} }),
  /**
   * 操作台（Console 桌面小组件）：`{managed, mode, prefs, model, sync_running}`。
   * `managed:false` = 没有桌面壳在管（纯网页跑服务），这时操作台不存在，界面要如实说。
   */
  syncConsole: () => call('/api/v2/sync/console'),
  /** 收起/展开、改设置、复位位置：真正动手的是桌面壳（它轮询请求文件） */
  syncConsoleSet: (body) => call('/api/v2/sync/console', { method: 'POST', body }),
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
  /**
   * 强制抬到前台（**只有用户点那个按钮才调**）：对 page_only 那批窗口做「最小化 → 恢复」，
   * 会闪一下任务栏、每个窗口 0.6–1.0 秒。一次性动作，不写设置。
   * 返回值 `confirmed: 'window_restored'`：能确认窗口已恢复正常，确认不了它在最前面。
   */
  syncShowForce: (profileIds) => call('/api/v2/sync/show/force', {
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

  /* ---- 批量菜单（0.4.3 ③） ---- */
  /** 归档：移出主列表但**不是删除**（回收站那套是 `/recycle-bin/*`，语义不同，没复用） */
  batchArchive: (ids) => call('/api/v2/browser-profile/batch/archive', { method: 'POST', body: { profile_ids: ids } }),
  batchUnarchive: (ids) => call('/api/v2/browser-profile/batch/unarchive', { method: 'POST', body: { profile_ids: ids } }),
  /** 改代理：`{proxy_config}` 写死一条 / `{proxy_id}` 绑代理列表 / `{clear:true}` 直连 */
  batchProxy: (ids, body) => call('/api/v2/browser-profile/batch/proxy', { method: 'POST', body: { profile_ids: ids, ...body } }),
  /** 检查代理：服务端限并发 + 单条 10s，逐条回 ok/fail/timeout/direct，失败不中断整批 */
  batchCheckProxy: (ids, opts) => call('/api/v2/browser-profile/batch/check-proxy', {
    method: 'POST', body: { profile_ids: ids, ...opts }, timeoutMs: 180000,
  }),
  /** 改 UA / 内核：两者必须自洽（大版本一致），服务端不一致会 100002 */
  batchUa: (ids, body) => call('/api/v2/browser-profile/batch/ua', { method: 'POST', body: { profile_ids: ids, ...body } }),
  batchRemark: (ids, body) => call('/api/v2/browser-profile/batch/remark', { method: 'POST', body: { profile_ids: ids, ...body } }),
  batchUpdateInfo: (ids, fields) => call('/api/v2/browser-profile/batch/update-info', { method: 'POST', body: { profile_ids: ids, fields } }),
  /** 显示窗口（不要求开同步会话）；`force:true` 是会闪任务栏的一次性动作 */
  batchShow: (ids, force) => call('/api/v2/browser-profile/batch/show', {
    method: 'POST', body: { profile_ids: ids, force: force ? true : undefined },
  }),
  /**
   * 还原 / 合并 Cookie。`preview:true` **只算不写**（界面必须先预览再确认）；
   * restore = 覆盖、merge = 并集（同名以现有为准）。
   */
  batchCookie: (ids, body) => call('/api/v2/browser-profile/batch/cookie', { method: 'POST', body: { profile_ids: ids, ...body }, timeoutMs: 180000 }),

  /* ---- 应用中心 / 扩展（0.4.3） ---- */
  /**
   * 扩展库。**文件全局共享一份**（`<数据根>/ext_env/<id>/`），环境只存勾选关系。
   * 导入收的是**本机路径**（已解压目录或 .zip）：这是个本机程序，不走上传。
   */
  apps: () => call('/api/v2/app/list'),
  appImport: (body) => call('/api/v2/app/import', { method: 'POST', body, timeoutMs: 120000 }),
  appUpdate: (body) => call('/api/v2/app/update', { method: 'POST', body }),
  appDelete: (ids) => call('/api/v2/app/delete', { method: 'POST', body: { ids } }),
  appForProfile: (id) => call('/api/v2/app/profile', { query: { profile_id: id } }),
  appSetForProfile: (id, extIds) => call('/api/v2/app/profile/set', { method: 'POST', body: { profile_id: id, ext_ids: extIds } }),

  /* ---- 设置 / 网络诊断（0.4.3 ④） ---- */
  /** 设置：目前只有「窗口同步默认设置」（真的会在 `/sync/start` 生效） */
  settings: () => call('/api/v2/settings'),
  /** 改同步默认设置：**合并**语义，只传要改的字段；不认识的字段会在 `ignored` 里回报 */
  saveSyncDefaults: (patch) => call('/api/v2/settings/sync-defaults', { method: 'POST', body: patch }),
  resetSyncDefaults: () => call('/api/v2/settings/sync-defaults/reset', { method: 'POST', body: {} }),
  /** 网络诊断快照：**只读**（不改配置、不写库、不起停内核） */
  diagnoseNetwork: () => call('/api/v2/diagnose/network'),
  /** 只读探测环境绑定的代理（按 host:port:账号 去重，结果不落盘） */
  diagnoseProxy: (opts) => call('/api/v2/diagnose/proxy', { method: 'POST', body: opts || {}, timeoutMs: 180000 }),

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