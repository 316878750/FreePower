/**
 * 诊断标记的名字派生。
 *
 * 为什么要有这个文件：注入脚本要在页面/worker 上留几个「我跑过了」的标记，
 * 自检页和宿主要靠它们判断注入是否真的生效。**但这些名字以前是写死的**：
 * `window.__fpApplied`、`__fpInstalled`、`__fpRealm` … 全仓库 7 个固定名。
 * 对手网站只要一句 `Object.getOwnPropertyNames(window).some(n => n.startsWith('__fp'))`
 * 就能认出这是 FreePower —— 而且这个洞在**每个环境、每个页面、每次打开**都在，
 * 比任何一条指纹参数都更容易被拿来做判定。
 *
 * 现在的做法：**按 fp_seed 派生每环境不同的名字**。
 *   - 同一个环境每次算出来一样（刷新前后名字不变 —— 名字每次都变本身就是信号）；
 *   - 不同环境名字不同（跨环境关联不起来）；
 *   - 形状是 `_` + 8 位小写 hex，**不含 `fp` 子串、没有 `__` 前缀**，
 *     看起来就是页面上一个随手起的临时变量，而不是我们的签名。
 *
 * 确定性：sha256(`freepower|marker|<key>|<seed>`)，取前 8 位。
 * 只在 Node 侧（建注入源时）和判据里算，**注入脚本内部不算哈希** ——
 * 名字是作为常量塞进脚本的，页面里没有我们的哈希实现可供比对。
 */
import crypto from 'node:crypto';

/**
 * 标记的种类。每加一种就要同步改注入脚本里的写入点与读取点。
 *   applied / seeds / realm / installed / mediaMode / fontsDeclared —— 自检与宿主判注入用
 *   config / orig —— 只在 FP_DEBUG 时出现（排查用，平时页面里没有）
 */
export const MARKER_KEYS = Object.freeze([
  'applied', 'seeds', 'realm', 'installed', 'mediaMode', 'fontsDeclared', 'config', 'orig',
]);

/** 标记名允许的形状：下划线开头 + 8 位小写 hex。判据也用它钉住「不许退化回固定名」。 */
export const MARKER_NAME_RE = /^_[0-9a-f]{8}$/;

/**
 * 按种子派生一组标记名。
 * @param {string|number} seed 指纹种子（fp_seed）；缺省与注入层一致用 'freepower'
 * @returns {Record<string, string>} 每种标记一个名字
 */
export function markerNames(seed) {
  const s = String(seed ?? 'freepower');
  const out = {};
  for (const key of MARKER_KEYS) {
    const hex = crypto.createHash('sha256').update(`freepower|marker|${key}|${s}`).digest('hex');
    out[key] = `_${hex.slice(0, 8)}`;
  }
  return out;
}

/**
 * 宿主侧判断「这张页注入过」用的表达式（自检、导航兜底、新标签确认都走这里）。
 * 表达式只读一个派生名，不读任何固定名。
 */
export function installedExpression(markers) {
  return `window[${JSON.stringify(markers.installed)}] === true`;
}

/** worker 侧判断注入是否跑过的表达式（self 上那个 realm 标记） */
export function workerRealmExpression(markers) {
  return `(self[${JSON.stringify(markers.realm)}] || null)`;
}

/**
 * 给一段「本身不含名字」的脚本注入一个常量表：
 * `const MK = {...}`。page / worker 两侧都用它，保证脚本里的名字集中在一处。
 */
export function markerConstSource(markers) {
  return `const MK = ${JSON.stringify(markers)};`;
}