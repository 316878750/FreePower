/**
 * 端点清单：**从 `buildRoutes()` 的返回值派生**，不另存一份手写列表。
 *
 * 为什么这么做：控制台「API & MCP」页要展示「方法 + 路径 + 一句话说明」。手写一份清单
 * 第一周就会和路由表脱节 —— 加了路由页面不显示、删了路由页面还留着，用户按页面调接口
 * 拿到 404，然后没人知道该信哪个。这里只维护**词表**（名词 / 动作 → 中文），
 * 路径本身永远来自路由表；词表漏了词就原样显示英文段，不会说谎。
 *
 * 判据：`test/api-mcp.test.mjs` 断言「页面拿到的端点数量 === 同一次 buildRoutes().length」。
 */

/** 路径里的名词段 → 中文（按段全等匹配，不做前缀猜测） */
const NOUN = new Map([
  ['user', '环境'],
  ['browser-profile', '环境'],
  ['browser', '环境'],
  ['fbbird', '环境（fbbird）'],
  ['group', '分组'],
  ['user-group', '分组'],
  ['browser-tags', '标签'],
  ['proxy-list', '代理'],
  ['proxy', '代理'],
  ['dynamic-proxy-traffic', '代理流量'],
  ['cookie', 'Cookie'],
  ['recycle-bin', '回收站'],
  ['agent', 'AI Agent'],
  ['workflow', '工作流'],
  ['selfcheck', '自检'],
  ['kernels', '内核'],
  ['download-kernel', '内核下载'],
  ['schema', '字段表'],
  ['validate', '校验'],
  ['application', '应用'],
  ['category', '分类'],
  ['fb', 'Facebook'],
  ['api', '本地 API'],
  ['sync', '窗口同步'],
]);

/** 最后一个路径段（动作）→ 中文 */
const VERB = new Map([
  ['list', '列表'],
  ['detail', '详情'],
  ['create', '创建'],
  ['update', '更新'],
  ['update-patch', '局部更新'],
  ['delete', '删除'],
  ['start', '启动'],
  ['stop', '停止'],
  ['stop-all', '全部停止'],
  ['restart', '重启'],
  ['active', '运行中环境'],
  ['local-active', '本机运行中环境'],
  ['cloud-active', '云端运行中环境'],
  ['batch-start', '批量启动'],
  ['batch-stop', '批量停止'],
  ['regroup', '移动分组'],
  ['new-fingerprint', '重新生成指纹'],
  ['cookies', '读 Cookie'],
  ['kernels', '内核列表'],
  ['download-kernel', '下载内核'],
  ['selfcheck', '自检'],
  ['selfcheck-ticket', '自检报告票据'],
  ['selfcheck-summary', '自检汇总'],
  ['ua', '改 UA'],
  ['delete-cache', '清缓存'],
  ['check', '检测'],
  ['check-batch', '批量检测'],
  ['import', '导入'],
  ['export', '导出'],
  ['copy', '复制'],
  ['run', '运行'],
  ['status', '状态'],
  ['screenshot', '截图'],
  ['screenshot-ticket', '截图票据'],
  ['approve', '审批'],
  ['create-from-goal', '按目标生成'],
  ['share', '共享'],
  ['reset_password', '重置密码'],
  ['info', '信息'],
  ['verify', '验证开关'],
  ['reset', '重置 Key'],
  // 窗口同步（0.4.2 阶段 1–3）：词表漏一个词，页面上就露出一段英文路径
  ['refresh', '刷新读数'],
  ['settings', '改同步设置'],
  ['unify-size', '统一尺寸'],
  ['arrange', '窗口排列'],
  ['displays', '显示器列表'],
  ['hotkey', '快捷键'],
  ['tab', '打开网址'],
  ['tabs', '标签列表'],
  ['tab-close', '关闭标签'],
  ['tab-copy', '复制标签到其它窗口'],
  ['tab-unify', '统一标签页'],
]);

/** `/api/v1/x/y` → ['x','y']；`api`、版本段、动态段（`:id`）都不是名词 */
function segments(pathname) {
  const out = [];
  for (const raw of String(pathname || '').split('/')) {
    if (!raw) continue;
    if (raw === 'api') continue;
    if (/^v\d+$/.test(raw)) continue;
    if (raw.startsWith(':')) continue;
    out.push(raw);
  }
  return out;
}

/** 一句话说明：名词段按词表翻，动作段按词表翻，翻不出来就原样给英文段 */
export function describePath(pathname) {
  if (pathname === '/status') return '服务状态（免鉴权）';
  const segs = segments(pathname);
  if (!segs.length) return String(pathname);
  const last = segs[segs.length - 1];
  const nouns = segs.slice(0, -1).map((s) => NOUN.get(s) || s);
  const verb = VERB.get(last) || last;
  return nouns.length ? `${nouns.join(' / ')} · ${verb}` : verb;
}

/** 页面分组用：取第一个名词段 */
export function groupOf(pathname) {
  if (pathname === '/status') return '服务';
  const segs = segments(pathname);
  if (!segs.length) return '其他';
  return NOUN.get(segs[0]) || segs[0];
}

/**
 * 路由表 → 对外清单。
 * `supported: false` 只给路由表里显式标了 `unsupported` 的占位路由（routes.js 里那批
 * 「明确报不支持」的），**不是猜的** —— 页面必须能让人一眼看出哪些调了会拿到 -1。
 */
export function routeCatalog(routes) {
  return routes.map((r) => ({
    methods: r.methods,
    path: r.path,
    desc: describePath(r.path),
    group: groupOf(r.path),
    auth: r.auth !== false,
    ticket: !!r.ticket,
    rate_tier: r.rateTier || 'std',
    supported: r.unsupported !== true,
  }));
}
