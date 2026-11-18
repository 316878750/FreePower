/**
 * 窗口同步页/操作台的**界面偏好**（纯数据，不碰 DOM、不碰后端）。
 *
 * 单独一个文件的两个理由：
 *   1. 它要能被判据直接 import 跑（`test/sync-layout.test.mjs`），所以不能依赖 `ui.js`/`api.js`；
 *   2. 页面（`pages/sync.js`）与操作台组件（`sync-widgets.js`）都要用同一份默认值、
 *      同一套脏值收敛逻辑 —— 不许各写一套。
 *
 * 存储口径沿用仓库既有约定（`web/density.js` 的 `fp.view_density` 那一套）：
 * **界面偏好只写 localStorage，不写库、不同步**。它不影响任何服务端行为。
 */

/**
 * 排列方式（31 号文 §11 更正 1 + §12 实测）：
 *   · `宫格平铺` grid —— 一键排列，按可用区等分；
 *   · `重叠平铺` over —— 横向层叠、窗口拉到工作区大小（步长 30 硬编码，不可配）。
 *
 * 两个选项**在自定义模式下也一直渲染**（§12 更正 2：原来写「仅自动模式显示」是错的）；
 * 唯一的显隐规则是「重叠平铺」在显示器选「全部屏幕」时不出现（跨屏拉满没有意义）。
 */
export const ARRANGE_KINDS = Object.freeze([
  { key: 'grid', label: '宫格平铺' },
  { key: 'over', label: '重叠平铺' },
]);

/** localStorage 键。带前缀：以后结构变了直接换键，不写迁移。 */
export const ARRANGE_PREFS_KEY = 'fp.sync_arrange';

/** 自定义排列 4 行的默认值（0/0、500/200、0/0、3 —— 与对手实测的初始值一致） */
export const DEFAULT_ARRANGE_CUSTOM = Object.freeze({
  left: 0, top: 0, width: 500, height: 200, hs: 0, vs: 0, row: 3,
});

const intOr = (v, dflt, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.round(n), lo), hi);
};

/**
 * 把 localStorage 里读到的脏值收敛成可用形状。
 * 认不出来的一律回默认 —— 用户手改过存储、升过级、JSON 坏了都不该把页面画坏。
 */
export function normalizeArrangePrefs(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const c = o.custom && typeof o.custom === 'object' ? o.custom : {};
  return {
    autoArrange: o.autoArrange === undefined ? true : o.autoArrange === true,
    tileMode: o.tileMode === 'over' ? 'over' : 'grid',
    custom: {
      left: intOr(c.left, DEFAULT_ARRANGE_CUSTOM.left, -9999, 9999),
      top: intOr(c.top, DEFAULT_ARRANGE_CUSTOM.top, -9999, 9999),
      width: intOr(c.width, DEFAULT_ARRANGE_CUSTOM.width, 0, 20000),
      height: intOr(c.height, DEFAULT_ARRANGE_CUSTOM.height, 0, 20000),
      hs: intOr(c.hs, DEFAULT_ARRANGE_CUSTOM.hs, -999, 999),
      vs: intOr(c.vs, DEFAULT_ARRANGE_CUSTOM.vs, -999, 999),
      row: intOr(c.row, DEFAULT_ARRANGE_CUSTOM.row, 0, 20),
    },
  };
}

/** 默认 storage 用 `window.localStorage`；隐私模式/没有 window 时返回 null，不抛 */
function defaultStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch { return null; }
}

export function readArrangePrefs(storage = null) {
  const s = storage || defaultStorage();
  if (!s) return normalizeArrangePrefs(null);
  try {
    const txt = s.getItem(ARRANGE_PREFS_KEY);
    if (!txt) return normalizeArrangePrefs(null);
    return normalizeArrangePrefs(JSON.parse(txt));
  } catch {
    return normalizeArrangePrefs(null);
  }
}

export function writeArrangePrefs(prefs, storage = null) {
  const s = storage || defaultStorage();
  if (!s) return false;
  try {
    s.setItem(ARRANGE_PREFS_KEY, JSON.stringify(normalizeArrangePrefs(prefs)));
    return true;
  } catch { return false; }
}
