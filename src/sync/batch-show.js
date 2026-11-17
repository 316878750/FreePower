/**
 * 批量菜单里的「显示窗口」（0.4.3 ③）—— **不依赖同步会话**。
 *
 * 为什么单独一层：`src/sync/session.js` 的 `showWindows` 只认**正在跑的同步会话**
 * （主控 + 受控那批窗口）。而环境列表里的「显示窗口」是对任意勾选的环境用，
 * 跟同步开没开没关系。这里直接对每个环境的浏览器级 CDP 连接做同一件事。
 *
 * **判定逻辑不重写**：`planShow` / `verifyShown` / `summarizeShow`（以及强制置前的
 * `planForce` / `verifyForced` / `summarizeForce`）全部从 `./show.js` 复用 ——
 * 那是「显示窗口」唯一的一份判定，两处各写一套必然分叉。
 * 这里只补两个**读取器**（页面 target 与窗口矩形），session.js 里那份是私有的。
 *
 * 能确认到哪：零依赖下最小化的窗口恢复后会真到前台；**只是被盖住**的窗口
 * `Page.bringToFront` 抬不动，所以 `raise: 'page_only'`、`os_foreground: false`，
 * 由界面如实显示（文案不许写成「已置前」）。强制那档只有用户显式点才会走。
 */
import { getInstance } from '../runtime/manager.js';
import { planForce, planShow, summarizeForce, summarizeShow, verifyForced, verifyShown } from './show.js';
import { isStartPageUrl } from '../start/host.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 选一张页面 target：优先真实 URL（跳过 about:blank / chrome://newtab / 我们自己的起始页） */
async function pageTargetOf(client) {
  const { targetInfos = [] } = await client.send('Target.getTargets');
  const pages = targetInfos.filter((t) => t.type === 'page');
  if (!pages.length) return null;
  return pages.find((t) => t.url
    && !t.url.startsWith('about:blank')
    && !t.url.startsWith('chrome://newtab')
    && !isStartPageUrl(t.url)) || pages[0];
}

/** 窗口位置 + 尺寸 + 状态（回读比对读它） */
async function rectOf(client, targetId) {
  try {
    const { windowId, bounds } = await client.send('Browser.getWindowForTarget', { targetId });
    return {
      windowId,
      x: bounds?.left ?? null,
      y: bounds?.top ?? null,
      width: bounds?.width ?? null,
      height: bounds?.height ?? null,
      state: bounds?.windowState || null,
    };
  } catch {
    return null;
  }
}

/** 页面文档有没有焦点（**只作读数**，不当作「窗口到前台」） */
async function pageHasFocus(client, sessionId) {
  try {
    const r = await client.send('Runtime.evaluate', {
      expression: 'JSON.stringify({hasFocus: document.hasFocus(), visibility: document.visibilityState})',
      returnByValue: true,
    }, sessionId);
    return JSON.parse(r?.result?.value || '{}');
  } catch {
    return null;
  }
}

/**
 * 最小化 → 恢复原状态。**只给强制置前用**（与 session.js 的同名动作一致）。
 * 最大化窗口要显式恢复成 maximized：`windowState: normal` 对它是「取消最大化」。
 */
async function nudgeToFront(client, windowId, stateBefore) {
  await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  await sleep(140);
  const back = String(stateBefore || '').toLowerCase() === 'maximized' ? 'maximized' : 'normal';
  await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: back } });
  await sleep(240);
}

/**
 * 显示一批环境的窗口。
 * @param {string[]} profileIds
 * @param {{ force?: boolean }} [opts] `force` 是**显式的一次性动作**（会闪任务栏），默认 false
 * @returns {Promise<{shown:object[], skipped:object[], summary:object, os_foreground:boolean, force:boolean}>}
 */
export async function showWindowsOfProfiles(profileIds = [], { force = false } = {}) {
  const shown = [];
  const skipped = [];

  for (const id of profileIds.map(String)) {
    const inst = getInstance(id);
    if (!inst) { skipped.push({ profile_id: id, reason: 'not_running' }); continue; }
    const entry = {
      profile_id: id,
      ok: false,
      action: 'none',
      raise: 'none',
      force: Boolean(force),
      state_before: null,
      state_after: null,
      rect_before: null,
      rect_after: null,
    };
    try {
      const target = await pageTargetOf(inst.client);
      if (!target) throw new Error('这个环境没有页面标签，读不到窗口');
      const { sessionId } = await inst.client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      const before = await rectOf(inst.client, target.targetId);
      if (!before?.windowId) throw new Error('读不到窗口 id');
      entry.state_before = String(before.state || '').toLowerCase() || null;
      entry.rect_before = before;

      if (force) {
        const [plan] = planForce([{ profile_id: id, state: before.state }]);
        entry.action = plan.action;
        if (plan.action === 'skip') {
          entry.ok = true;
          entry.reason = plan.reason;
          shown.push(entry);
          continue;
        }
        await nudgeToFront(inst.client, before.windowId, entry.state_before);
        entry.raise = 'restored';
      } else {
        const [plan] = planShow([{ profile_id: id, state: before.state }]);
        entry.action = plan.action;
        if (plan.action === 'restore') {
          await inst.client.send('Browser.setWindowBounds', { windowId: before.windowId, bounds: { windowState: 'normal' } });
          await sleep(160);
          entry.raise = 'restored';
        } else if (plan.action === 'page_only') {
          await inst.client.send('Page.bringToFront', {}, sessionId);
          await sleep(160);
          entry.raise = 'page_only';
        }
      }

      const after = await rectOf(inst.client, target.targetId);
      entry.rect_after = after;
      entry.state_after = after ? String(after.state || '').toLowerCase() || null : null;
      const v = force
        ? verifyForced({ state_before: entry.state_before, rect_before: before }, after)
        : verifyShown({ state_before: entry.state_before, rect_before: before }, after);
      if (!force && entry.action === 'page_only') entry.page_focused = await pageHasFocus(inst.client, sessionId);
      entry.ok = v.ok;
      entry.problems = v.problems;
      if (!v.ok) entry.reason = v.problems.map((m) => `${m.field} 期望 ${m.expected} 实际 ${m.actual}`).join('；');
    } catch (e) {
      entry.reason = e?.message || String(e);
    }
    shown.push(entry);
  }

  const summary = force ? summarizeForce(shown) : summarizeShow(shown);
  return {
    shown,
    skipped,
    summary,
    /** 只有全都能真到前台（restored）才是 true；被盖住那批是 false，界面据此提示 */
    os_foreground: shown.length > 0 && shown.every((r) => r.raise === 'restored'),
    force: Boolean(force),
  };
}
