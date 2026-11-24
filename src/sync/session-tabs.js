/**
 * 窗口同步 · 标签操作：打开网址 / 标签状态 / 关闭 / 复制 / 统一 / 刷新视口（从 session.js 拆出，行为不变）。
 */
import { getInstance } from '../runtime/manager.js';
import { closeTabAt, isBlankUrl, listTabs, navigateAt, openTabFor, parseOpenUrls, planCloseBlank, planCloseOthers, planUnify, settle, targetIndex, visibleTabIndex } from './tabs.js';
import { windowSizeOf } from './session-cdp.js';
import { state } from './session-state.js';

/**
 * 打开网址（`syncOperateOpenUrl`）：在每个同步窗口里打开同一批网址，**最多 10 个**
 * （对手的提示原文 `syncOperateOpenUrlsMaxCountExceed` 是「一键最多打开10个网址」）。
 * 超过 10 个**直接报错**，不静默截断 —— 用户填了 12 个却发现只开了 10 个，比报错难查得多。
 *
 * **姿势不能错**：`Target.createTarget({url})` 会在 attach 之前就把首个文档建好，
 * 注入脚本只对下一个文档生效 —— 那张标签的首帧就是原始指纹（`manager.js:807` 的实测）。
 * 所以一律 `about:blank` → 登记 blank-reload 豁免 → attach → `Page.navigate`。
 * 判据钉的就是这个：首个文档的**注入完成标记**（按该环境 `fp_seed` 派生的名字，见 `kernel/markers.js`）
 * 是 `object`，且 `navigation.type === 'navigate'`，并且**服务器只收到一次请求**。
 *
 * 只有一条选项（对手也是这么表达的）：
 *   `current_tab_url`（首个网址在当前标签页打开）→ **第一个**网址在窗口当前标签页里跳（`navigateAt`），
 *   其余网址照常新开。关掉（默认）时全部新开。
 */
export async function openTabInAll(rawUrl) {
  if (!state.current) throw new Error('没有正在运行的同步会话');
  const { urls, error } = parseOpenUrls(rawUrl);
  if (error) throw new Error(error);

  const opened = [];
  const masterTabs = await listTabs(state.current.targets.get(state.current.master).client);
  const masterVis = await visibleTabIndex(state.current.targets.get(state.current.master).client, masterTabs);
  for (const id of [state.current.master, ...current.slaves]) {
    const t = state.current.targets.get(id);
    if (!t) continue;
    const isMaster = id === state.current.master;
    const inst = getInstance(id);
    try {
      const tabs = isMaster ? masterTabs : await listTabs(t.client);
      const vis = isMaster ? masterVis : await visibleTabIndex(t.client, tabs);
      for (let n = 0; n < urls.length; n++) {
        const url = urls[n];
        // 「首个网址在当前标签页打开」只对**第一个**网址生效，其余照常新开（对手就是这么分的）
        if (n === 0 && state.current.settings.current_tab_url) {
          const idx = isMaster ? vis.index : slaveAnchor(masterVis.index, vis.index, tabs.length, state.current.settings.same_tab);
          const tab = tabs[idx];
          if (!tab) {
            opened.push({ profile_id: id, target_id: null, url, mode: 'current_tab', error: '没有可导航的标签' });
            continue;
          }
          await navigateAt(t.client, tab.targetId, url);
          opened.push({ profile_id: id, role: isMaster ? 'master' : 'slave', target_id: tab.targetId, url, mode: 'current_tab' });
          continue;
        }
        const r = await openTabFor(t.client, { url, onTarget: (tid) => inst?.exemptBlankReload?.(tid) });
        opened.push({ profile_id: id, role: isMaster ? 'master' : 'slave', target_id: r.targetId, url, mode: 'new_tab' });
      }
    } catch (e) {
      opened.push({ profile_id: id, target_id: null, urls, error: e?.message || String(e) });
    }
  }
  return { opened, urls };
}

/* ------------------------------ 标签页：状态 / 关 / 复制 / 统一 ------------------------------ */

/** 各窗口的标签列表 + 当前可见序号（界面与判据都读这个，不靠猜）。 */
export async function tabState() {
  if (!state.current) return { running: false, windows: [] };
  const windows = [];
  for (const id of [state.current.master, ...current.slaves]) {
    const t = state.current.targets.get(id);
    if (!t) continue;
    const tabs = await listTabs(t.client).catch(() => []);
    const vis = await visibleTabIndex(t.client, tabs).catch(() => ({ index: 0, confident: false }));
    windows.push({
      profile_id: id,
      role: id === state.current.master ? 'master' : 'slave',
      visible: vis.index,
      visible_confident: vis.confident,   // false = CDP 读不到前台标签，这条是猜的（如实带出去）
      tabs: tabs.map((x) => ({ index: x.index, url: x.url, title: x.title })),
    });
  }
  return {
    running: true,
    same_tab: state.current.settings.same_tab,          // 内部字段，面板不展示
    current_tab_url: state.current.settings.current_tab_url,
    windows,
  };
}

/**
 * 受控窗口该动第几个标签。
 *   `same_tab` 开：跟**主窗口**的序号（主窗口动第 2 个，受控也动第 2 个）；
 *   `same_tab` 关：各自动自己当前前台那个（`ownVisible`）。
 * 主窗口序号越界（受控窗口标签更少）时退回自己的前台标签 —— 跳过并如实记，不猜着乱关。
 */
function slaveAnchor(masterIndex, ownVisible, slaveCount, sameTab) {
  if (!sameTab || masterIndex === null || masterIndex === undefined) return ownVisible;
  return targetIndex(masterIndex, slaveCount, true) ?? ownVisible;
}

/**
 * 关标签：`current` 关当前 / `others` 关其它（留当前）/ `blank` 关空白。
 * 返回每个窗口实际关了哪些序号 —— 界面和判据都看这个，不看「应该关什么」。
 */
export async function closeTabs(which = 'current') {
  if (!state.current) throw new Error('没有正在运行的同步会话');
  const mode = ['current', 'others', 'blank'].includes(which) ? which : 'current';
  const closed = [];
  // 「相同标签页」的锚点是**主窗口**的序号：受控窗口按主窗口那个序号动，
  // 而不是拿自己的前台标签当锚（那样等于没开这个开关，2026-11-14 B 层判据抓到过）。
  let masterAnchor = null;
  const masterT = state.current.targets.get(state.current.master);
  if (masterT) {
    const mTabs = await listTabs(masterT.client).catch(() => []);
    if (mTabs.length) {
      masterAnchor = (await visibleTabIndex(masterT.client, mTabs).catch(() => ({ index: 0, confident: false }))).index;
    }
  }
  for (const id of [state.current.master, ...current.slaves]) {
    const t = state.current.targets.get(id);
    if (!t) continue;
    const tabs = await listTabs(t.client).catch(() => []);
    if (!tabs.length) continue;
    const vis = await visibleTabIndex(t.client, tabs).catch(() => ({ index: 0, confident: false }));
    const isMaster = id === state.current.master;

    let plan = [];
    if (mode === 'others') {
      const keep = isMaster ? vis.index : slaveAnchor(masterAnchor, vis.index, tabs.length, state.current.settings.same_tab);
      plan = planCloseOthers(tabs.length, keep).map((i) => tabs[i]);
    } else if (mode === 'blank') {
      plan = planCloseBlank(tabs.map((x) => x.url)).map((i) => tabs[i]);
    } else {
      const idx = isMaster ? vis.index : slaveAnchor(masterAnchor, vis.index, tabs.length, state.current.settings.same_tab);
      if (tabs[idx]) plan = [tabs[idx]];
    }

    for (const tab of plan) {
      const ok = await closeTabAt(t.client, tab.targetId);
      closed.push({ profile_id: id, role: isMaster ? 'master' : 'slave', index: tab.index, url: tab.url, ok });
    }
  }
  await settle(150);
  return { which: mode, closed };
}

/**
 * 复制标签到其它窗口：把主窗口第 `index` 个标签的 URL 在受控窗口打开。
 * 这是「复制」不是「同步」——只往受控窗口去，不会反过来动主窗口。
 */
export async function copyTabToSlaves({ index = null } = {}) {
  if (!state.current) throw new Error('没有正在运行的同步会话');
  const mt = state.current.targets.get(state.current.master);
  if (!mt) throw new Error('主窗口连接已不在');
  const masterTabs = await listTabs(mt.client);
  const vis = await visibleTabIndex(mt.client, masterTabs).catch(() => ({ index: 0, confident: false }));
  const idx = index === null || index === undefined ? vis.index : Math.floor(Number(index));
  const src = masterTabs[idx];
  if (!src) throw new Error(`主窗口没有第 ${idx} 个标签`);
  if (!src.url || isBlankUrl(src.url)) throw new Error('主窗口这个标签是空白页，没有可复制的地址');

  const copied = [];
  for (const id of state.current.slaves) {
    const t = state.current.targets.get(id);
    if (!t) continue;
    try {
      const inst = getInstance(id);
      // 复制标签**永远新开一张**（没有「目标空白」这个开关，也没有原地跳的分支）：
      // 复制到其它窗口的语义就是「多出一张」，原地跳是「替换掉现在这张」，那是另一件事。
      const r = await openTabFor(t.client, { url: src.url, onTarget: (tid) => inst?.exemptBlankReload?.(tid) });
      copied.push({ profile_id: id, target_id: r.targetId, url: src.url, mode: 'new_tab' });
    } catch (e) {
      copied.push({ profile_id: id, target_id: null, url: src.url, error: e?.message || String(e) });
    }
  }
  return { from_index: idx, url: src.url, copied };
}

/**
 * 统一标签页：把受控窗口的标签弄成与主窗口一致（数量 + 每个序号的 URL）。
 * 只做 CDP 真能做到的：多关尾部、缺开尾部、同序号 URL 不同就地跳。**不假装能插到中间**。
 */
export async function unifyTabs() {
  if (!state.current) throw new Error('没有正在运行的同步会话');
  const mt = state.current.targets.get(state.current.master);
  if (!mt) throw new Error('主窗口连接已不在');
  const masterTabs = await listTabs(mt.client);
  const masterUrls = masterTabs.map((t) => t.url);
  const result = [];
  for (const id of state.current.slaves) {
    const t = state.current.targets.get(id);
    if (!t) continue;
    const inst = getInstance(id);
    const slaveTabs = await listTabs(t.client).catch(() => []);
    const plan = planUnify(masterUrls, slaveTabs.map((x) => x.url));
    const done = { profile_id: id, navigated: [], opened: [], closed: [], errors: [] };
    for (const n of plan.navigate) {
      const tab = slaveTabs[n.index];
      if (!tab) continue;
      try { await navigateAt(t.client, tab.targetId, n.url); done.navigated.push(n); } catch (e) { done.errors.push(String(e?.message || e)); }
    }
    for (const i of plan.close) {
      const tab = slaveTabs[i];
      if (!tab) continue;
      const ok = await closeTabAt(t.client, tab.targetId);
      done.closed.push({ index: i, url: tab.url, ok });
    }
    for (const url of plan.open) {
      if (!url || isBlankUrl(url)) { done.opened.push({ url, skipped: 'blank' }); continue; }
      try {
        const r = await openTabFor(t.client, { url, onTarget: (tid) => inst?.exemptBlankReload?.(tid) });
        done.opened.push({ url, target_id: r.targetId });
      } catch (e) { done.errors.push(String(e?.message || e)); }
    }
    result.push(done);
  }
  await settle(150);
  return { master_urls: masterUrls, windows: result };
}

/** 重读所有窗口的视口（用户改了窗口尺寸之后调；8b 判据也用它） */
export async function refreshAll() {
  if (!state.current) return null;
  for (const id of [state.current.master, ...current.slaves]) {
    await state.current.refreshViewport(id).catch(() => {});
    const t = state.current.targets.get(id);
    if (t) t.window = await windowSizeOf(t.client, t.targetId).catch(() => t.window);
  }
  return state.current.status();
}
