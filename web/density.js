/**
 * 视图密度（0.4.3 ③）：紧凑 / 标准 / 超高。
 *
 * 形态依据逆向 `28-远端UI界面结构.md` 的「列表设置」：紧凑 `fbcc2` / 标准 `standard` /
 * 超高 `broad`，另有 `lineHeight`。**那篇只给了名字，没给具体行高数字**，
 * 所以这里的行高是**我们选的**（界面与 README 都这么写，不假称是对手原值）：
 *   compact  30px        标准 44px         ultra（超高）64px
 *
 * 存储：**只写 localStorage**，一个键 `fp.view_density`。
 * 为什么不写库：这是「这台机器上这个用户看着舒服」的显示偏好，不是环境数据；
 * 写进库就意味着一份配置要跟着库走（换机器/恢复备份时被别人的习惯覆盖），
 * 还会因为「两个窗口不同密度」打架。CEO 明确要求只存本地、不同步。
 */

export const VIEW_STORAGE_KEY = 'fp.view_density';

/**
 * 三档密度。`rowHeight` 是**我们选的**值（见文件顶部），`id` 与对手的语义名对齐：
 * compact = 对手的「紧凑」，standard = 「标准」，ultra = 「超高」。
 */
export const DENSITIES = [
  { id: 'compact', label: '紧凑', rowHeight: 30, padY: 4, font: '12.5px' },
  { id: 'standard', label: '标准', rowHeight: 44, padY: 8, font: '13px' },
  { id: 'ultra', label: '超高', rowHeight: 64, padY: 14, font: '13.5px' },
];

const BY_ID = new Map(DENSITIES.map((d) => [d.id, d]));

/** 认不出来的一律回标准（别因为 localStorage 里存了个脏值把列表画坏） */
export function densityOf(id) {
  return BY_ID.get(String(id || '')) || BY_ID.get('standard');
}

/** 读本地偏好：读不到 / 存了脏值 / 根本没法用 localStorage → 标准 */
export function readDensity(storage) {
  try {
    const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!s) return 'standard';
    return densityOf(s.getItem(VIEW_STORAGE_KEY)).id;
  } catch {
    return 'standard';
  }
}

/** 写本地偏好。**这里唯一的持久化出口** —— 不许顺手写进库 */
export function writeDensity(id, storage) {
  const d = densityOf(id);
  try {
    const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (s) s.setItem(VIEW_STORAGE_KEY, d.id);
  } catch { /* 隐私模式 / 配额满：不影响本次使用，下次打开回标准 */ }
  return d.id;
}

/** 把密度落到 DOM 上（`body` 上的 class，CSS 见 style.css） */
export function applyDensity(id, doc) {
  const d = densityOf(id);
  const target = doc || (typeof document !== 'undefined' ? document : null);
  if (!target || !target.body) return d.id;
  for (const x of DENSITIES) target.body.classList.remove(`density-${x.id}`);
  target.body.classList.add(`density-${d.id}`);
  return d.id;
}

/** 改密度：写本地 + 立刻落 DOM，返回生效的 id */
export function setDensity(id, { storage, doc } = {}) {
  const saved = writeDensity(id, storage);
  applyDensity(saved, doc);
  return saved;
}
