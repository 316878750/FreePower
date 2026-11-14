/**
 * 侧栏分组折叠的**纯逻辑**（不碰 DOM、不碰网络，node 里可直接跑）。
 *
 * 为什么要单独一个文件：折叠这套东西的坑全在「存下来的状态」上 ——
 * 用户手改过 localStorage、升过级、JSON 坏了、以后加了新分组。
 * 这些都不能让侧栏整个崩掉，而 DOM 里没法把这类分支测全。
 *
 * 规则（对齐用户的使用习惯，不是我们自创的）：
 * 1. 「常用」组**不可折叠** —— 这几项每天都点，收起来只多一次点击。
 *    它不是「默认展开」，是压根没有折叠入口；所以 FOLDABLE_GROUPS 里没有它。
 * 2. 折叠状态存 localStorage，键 FOLD_KEY；只存「折起来了」的分组，
 *    展开的不写 —— 这样以后加的新分组默认展开，不会被旧状态误折。
 * 3. 存的东西不可信（用户能改、旧版本能写脏），parse 一律容错成「都没折」。
 */

/** localStorage 键。带版本号：以后结构变了直接换键，不用写迁移。 */
export const FOLD_KEY = 'fp.nav.fold.v1';

/**
 * 允许折叠的分组 id（= index.html 里的 data-fold 值）。
 * **「常用」刻意不在这里**：不可折叠是靠「没有折叠入口」实现的，不是靠默认值。
 */
export const FOLDABLE_GROUPS = ['automation'];

/** 这个分组有没有折叠入口 */
export function isFoldable(group) {
  return FOLDABLE_GROUPS.includes(group);
}

/**
 * 把 localStorage 里的原始字符串解析成折叠状态。
 * 任何脏数据（null / 空串 / 非 JSON / 数组 / 数字 / 未知分组 / 非 true 的值）
 * 都变成「未折」，绝不抛。
 */
export function parseFold(raw) {
  const out = {};
  if (typeof raw !== 'string' || raw === '') return out;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
  // 只认 FOLDABLE_GROUPS 里的、且值严格为 true 的键：
  // 用户把 "automation" 写成 "yes" / 1 都不算，避免把「看着像真」的脏数据当真。
  for (const g of FOLDABLE_GROUPS) {
    if (data[g] === true) out[g] = true;
  }
  return out;
}

/** 这个分组现在是不是折起来了（不可折叠的一律 false） */
export function isFolded(fold, group) {
  return isFoldable(group) && fold != null && fold[group] === true;
}

/**
 * 翻转一个分组的折叠状态，返回新对象（不改入参）。
 * 不可折叠的分组原样返回 —— 传「常用」进来也不会凭空多一个折叠状态。
 */
export function toggleFold(fold, group) {
  const base = fold && typeof fold === 'object' ? fold : {};
  if (!isFoldable(group)) return { ...base };
  const next = { ...base };
  if (next[group] === true) delete next[group];
  else next[group] = true;
  return next;
}

/** 折叠状态 → 存进 localStorage 的字符串（只写「折起来的」） */
export function serializeFold(fold) {
  const out = {};
  for (const g of FOLDABLE_GROUPS) {
    if (fold && fold[g] === true) out[g] = true;
  }
  return JSON.stringify(out);
}

/**
 * 从 storage 读折叠状态。storage 可以传 null（无痕模式 / 被策略禁用），
 * 也可以抛（Safari 隐私模式历史上会抛）—— 一律当「都没折」，不能让侧栏挂掉。
 */
export function readFold(storage) {
  if (!storage) return {};
  try {
    return parseFold(storage.getItem(FOLD_KEY));
  } catch {
    return {};
  }
}

/** 写回 storage；写不进去就算了（隐私模式），不影响本次会话内的折叠 */
export function writeFold(storage, fold) {
  if (!storage) return false;
  try {
    storage.setItem(FOLD_KEY, serializeFold(fold));
    return true;
  } catch {
    return false;
  }
}

/**
 * aria-expanded 的值：折叠状态下是 "false"。
 * 单独抽出来是为了让判据能钉住「折叠必须对读屏软件可见」，
 * 而不只是视觉上把元素 display:none 掉。
 */
export function ariaExpanded(fold, group) {
  return isFolded(fold, group) ? 'false' : 'true';
}
