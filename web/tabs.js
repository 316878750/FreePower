/**
 * 环境管理页内 tabs（环境列表 / 分组管理 / 回收站）。
 *
 * 形态照逆向 `28-远端UI界面结构.md`：对手的「环境管理」是**一个侧栏项 + 页内 tabs**
 * （`XY.environmentManagement.tabs` 三项，`meta.childrenAsTabs===true`），
 * 侧栏里**没有二级展开菜单**。所以我们也不在侧栏加第二个环境相关入口，
 * 只在这一页顶部加一条 tab 条。
 *
 * 两条实现上的取舍：
 * 1. tab 是 **<a href>**，不是 button —— 能中键新开、能收藏、地址栏能直接跳，
 *    也让「这三块是真页面」这件事可以被判据静态钉住（不是靠一个 JS 变量切内容）。
 * 2. 这里是纯数据 + 一个画 DOM 的小函数，不碰网络：页内 tab 的「当前是哪一页」
 *    由 hash 决定（`tabOf`），刷新后还在原 tab，不需要 localStorage。
 */
import { h } from './ui.js';

/** 顺序照对手：环境列表 / 分组管理 / 回收站 */
export const PROFILE_TABS = [
  { id: 'list', label: '环境列表', hash: '#/profiles' },
  { id: 'groups', label: '分组管理', hash: '#/profiles/groups' },
  { id: 'recycle', label: '回收站', hash: '#/profiles/recycle' },
];

/**
 * 从 hash 路径判断当前在哪个 tab。
 * 认不出来一律回 'list'：环境管理这一页的默认视图是列表。
 * 注意 `/profiles/<id>`（编辑页）**不是** tab，返回 null，让调用方自己决定。
 */
export function tabOf(path) {
  const p = String(path || '').split('?')[0].replace(/\/+$/, '');
  if (p === '/profiles' || p === '') return 'list';
  if (p === '/profiles/groups') return 'groups';
  if (p === '/profiles/recycle') return 'recycle';
  return null;
}

/**
 * 画 tab 条。`counts` 可选：`{list: 12, groups: 3, recycle: 2}`，数字挂在标签后面。
 * 当前 tab 带 `aria-current="page"`（读屏软件能听出来，不只是颜色不一样）。
 */
export function tabBar(activeId, counts = null) {
  const bar = h('div', { class: 'tabs', role: 'tablist', 'aria-label': '环境管理' });
  for (const t of PROFILE_TABS) {
    const n = counts && counts[t.id];
    bar.appendChild(h('a', {
      class: `tab${t.id === activeId ? ' active' : ''}`,
      href: t.hash,
      role: 'tab',
      'aria-current': t.id === activeId ? 'page' : null,
      'data-tab': t.id,
    }, t.label, n === undefined || n === null ? null : h('span', { class: 'cnt' }, String(n))));
  }
  return bar;
}
