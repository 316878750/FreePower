/**
 * 「显示窗口 / 置前」的 A 层判据（零 Chrome）：分档 + 回读判定 + 文案 + 静态扫描。
 *
 * 这一层钉五件事：
 *   ① 分档**保守且如实**：只有最小化的窗口才算「真能到前台」（`restore`），
 *      normal / maximized 一律只承诺「页面级激活」（`page_only`）—— 因为零依赖实测
 *      `Page.bringToFront` 在被盖住时**不抬 OS 窗口**（`.tmp/foreground-probe*.mjs`）。
 *   ② 回读判定：恢复成功只认状态，并且**位置尺寸不许被搬走**（多屏窗口被搬回主屏是硬伤）；
 *      最大化过的窗口不比尺寸（系统给 -8 边框补偿）；全屏的不许被我们改状态。
 *   ③ 文案不许骗人：`page_only` 必须显式写「可能仍被其它窗口盖住」。
 *   ④ `page_only` 的 `document.hasFocus()` 只作读数，**绝不参与 ok**（拿 ① 冒充 ③）。
 *   ⑤ 不引原生依赖、不默认用「先最小化再恢复」的闪动来伪造置前。
 *
 * 真内核那层在 `sync-show-kernel.test.mjs`。
 * 跑法：npm run test:sync-show
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const t = (name, fn) => {
  try { fn(); check(name, true); } catch (e) { check(name, false, e?.message || String(e)); }
};

const {
  planShow, verifyShown, summarizeShow, isMinimized, needsRestore,
  planForce, verifyForced, summarizeForce,
} = await import('../src/sync/show.js');

/** 取一个函数/导出块在源码里的片段，静态扫描只在这个范围里看 */
function slice(src, from, to) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `源码里找不到「${from}」`);
  const b = to ? src.indexOf(to, a) : -1;
  return src.slice(a, b > a ? b : src.length);
}

/* ============================ 1. 分档：只有最小化才承诺真到前台 ============================ */
console.log('\n— 1. 分档（planShow）：最小化才给 restore，其余一律 page_only —');

t('最小化 → restore（实测恢复会同时成为 OS 前台窗口）', () => {
  const [p] = planShow([{ profile_id: 'a', state: 'minimized' }]);
  assert.equal(p.action, 'restore');
  assert.equal(p.profile_id, 'a');
  assert.equal(p.state_before, 'minimized');
});

t('normal → page_only（不承诺到前台，只做页面级激活）', () => {
  const [p] = planShow([{ profile_id: 'a', state: 'normal' }]);
  assert.equal(p.action, 'page_only');
});

t('maximized → page_only，且不许顺手把它缩回 normal', () => {
  const [p] = planShow([{ profile_id: 'a', state: 'maximized' }]);
  assert.equal(p.action, 'page_only');
  assert.equal(p.state_before, 'maximized');
});

t('fullscreen → none（用户主动全屏的窗口不动它）', () => {
  const [p] = planShow([{ profile_id: 'a', state: 'fullscreen' }]);
  assert.equal(p.action, 'none');
});

t('状态读不到（null/空/怪值）→ 当 normal，只做 page_only（不猜它是最小化）', () => {
  for (const raw of [null, undefined, '', 'HIDDEN', 'MINIMIZED', 0]) {
    const [p] = planShow([{ profile_id: 'a', state: raw }]);
    assert.equal(p.action, 'page_only', `state=${String(raw)}`);
    assert.equal(p.state_before, 'normal');
  }
});

t('一批窗口逐条给计划，顺序与 profile_id 不变', () => {
  const plan = planShow([
    { profile_id: 'm', state: 'minimized' },
    { profile_id: 's1', state: 'normal' },
    { profile_id: 's2', state: 'maximized' },
    { profile_id: 's3', state: 'fullscreen' },
  ]);
  assert.deepEqual(plan.map((p) => p.profile_id), ['m', 's1', 's2', 's3']);
  assert.deepEqual(plan.map((p) => p.action), ['restore', 'page_only', 'page_only', 'none']);
  assert.deepEqual(plan.map((p) => p.state_before), ['minimized', 'normal', 'maximized', 'fullscreen']);
});

t('空输入 / 非数组 → 空计划（不抛）', () => {
  assert.deepEqual(planShow([]), []);
  assert.deepEqual(planShow(null), []);
  assert.deepEqual(planShow(undefined), []);
  assert.deepEqual(planShow('nope'), []);
});

/* ============================ 2. 回读判定 ============================ */
console.log('\n— 2. 回读判定（verifyShown）：成功只认回读，位置尺寸不许被搬走 —');

const rect = (x, y, width, height, state) => ({ x, y, width, height, state });

t('最小化 → normal 且位置尺寸一致 → ok', () => {
  const v = verifyShown(
    { state_before: 'minimized', rect_before: rect(2400, 200, 900, 600, 'minimized') },
    rect(2400, 200, 900, 600, 'normal'));
  assert.equal(v.ok, true);
  assert.deepEqual(v.problems, []);
});

t('最小化 → 恢复后被搬到 (0,0)（多屏窗口跳回主屏）→ 不 ok，并指出是 x / y', () => {
  const v = verifyShown(
    { state_before: 'minimized', rect_before: rect(2400, 200, 900, 600, 'minimized') },
    rect(0, 0, 900, 600, 'normal'));
  assert.equal(v.ok, false);
  assert.deepEqual(v.problems.map((p) => p.field).sort(), ['x', 'y']);
  assert.equal(v.problems.find((p) => p.field === 'x').expected, 2400);
  assert.equal(v.problems.find((p) => p.field === 'x').actual, 0);
});

t('最小化 → 恢复后尺寸被改了 → 不 ok（width / height 都要报）', () => {
  const v = verifyShown(
    { state_before: 'minimized', rect_before: rect(100, 100, 900, 600, 'minimized') },
    rect(100, 100, 1000, 700, 'normal'));
  assert.equal(v.ok, false);
  assert.deepEqual(v.problems.map((p) => p.field).sort(), ['height', 'width']);
});

t('最小化前是最大化（最大化后最小化）→ 恢复成 maximized 算 ok，且不比尺寸', () => {
  const v = verifyShown(
    { state_before: 'minimized', rect_before: rect(-8, -8, 3456, 1408, 'maximized') },
    rect(-8, -8, 3440, 1400, 'maximized'));
  assert.equal(v.ok, true, '最大化窗口的 bounds 允许系统补偿差，不该判失败');
  assert.deepEqual(v.problems, []);
});

t('最小化 → 回读还是 minimized → 不 ok（并给出期望 / 实际）', () => {
  const v = verifyShown(
    { state_before: 'minimized', rect_before: rect(10, 10, 900, 600, 'minimized') },
    rect(10, 10, 900, 600, 'minimized'));
  assert.equal(v.ok, false);
  assert.equal(v.problems[0].field, 'windowState');
  assert.equal(v.problems[0].expected, 'normal');
  assert.equal(v.problems[0].actual, 'minimized');
});

t('回读读不到（null）→ 不 ok，不许当成功', () => {
  const v = verifyShown({ state_before: 'minimized', rect_before: rect(10, 10, 900, 600, 'minimized') }, null);
  assert.equal(v.ok, false);
  assert.equal(v.problems[0].field, 'windowState');
  assert.equal(v.problems[0].actual, null);
});

t('normal 保持 normal → ok（page_only 这档不许改状态）', () => {
  const v = verifyShown({ state_before: 'normal', rect_before: rect(0, 0, 900, 600, 'normal') },
    rect(0, 0, 900, 600, 'normal'));
  assert.equal(v.ok, true);
});

t('maximized 被我们改成 normal → 不 ok（显示窗口不该改窗口状态）', () => {
  const v = verifyShown({ state_before: 'maximized', rect_before: rect(-8, -8, 3456, 1408, 'maximized') },
    rect(0, 0, 900, 600, 'normal'));
  assert.equal(v.ok, false);
  assert.equal(v.problems[0].expected, 'maximized');
});

t('fullscreen 保持 fullscreen → ok；被缩回来 → 不 ok', () => {
  const before = { state_before: 'fullscreen', rect_before: rect(0, 0, 3440, 1440, 'fullscreen') };
  assert.equal(verifyShown(before, rect(0, 0, 3440, 1440, 'fullscreen')).ok, true);
  const v = verifyShown(before, rect(0, 0, 3440, 1440, 'normal'));
  assert.equal(v.ok, false);
  assert.equal(v.problems[0].expected, 'fullscreen');
});

t('位置读数是小数时按四舍五入比（900.4 对 900 算一致）', () => {
  const v = verifyShown(
    { state_before: 'minimized', rect_before: rect(100.4, 200.6, 900.2, 600.5, 'minimized') },
    rect(100, 201, 900, 601, 'normal'));
  assert.equal(v.ok, true);
});

t('最小化前读不到位置（null）→ 不拿 null 跟自己比，只判状态', () => {
  const v = verifyShown(
    { state_before: 'minimized', rect_before: { x: null, y: null, width: null, height: null, state: null } },
    rect(500, 500, 900, 600, 'normal'));
  assert.equal(v.ok, true, '最小化时读不到位置是常态，不该因此判失败');
});

/* ============================ 3. 文案：不许骗人 ============================ */
console.log('\n— 3. 文案（summarizeShow）：page_only 必须明说「可能仍被盖住」—');

const okEntry = (id, raise, role = 'slave') => ({ profile_id: id, role, ok: true, raise });
const badEntry = (id, reason, role = 'slave') => ({ profile_id: id, role, ok: false, raise: 'none', reason });

t('全部 restored → 说「已恢复 N 个最小化的窗口」，不带「盖住」的提示', () => {
  const s = summarizeShow([okEntry('a', 'restored'), okEntry('b', 'restored', 'master')]);
  assert.equal(s.total, 2);
  assert.equal(s.ok, true);
  assert.equal(s.failed, 0);
  assert.equal(s.restored, 2);
  assert.equal(s.page_only, 0);
  assert.match(s.message, /已恢复 2 个最小化的窗口/);
  assert.doesNotMatch(s.message, /盖住/);
  assert.deepEqual(s.details, []);
});

t('混合（restored + page_only）→ 两句都写出来，数量各算各的', () => {
  const s = summarizeShow([okEntry('a', 'restored'), okEntry('b', 'page_only'), okEntry('c', 'page_only')]);
  assert.equal(s.ok, true);
  assert.equal(s.restored, 1);
  assert.equal(s.page_only, 2);
  assert.match(s.message, /已恢复 1 个最小化的窗口/);
  assert.match(s.message, /2 个窗口只做了页面级激活（可能仍被其它窗口盖住）/);
});

t('全部 page_only → 绝不出现「已恢复」，只承认页面级激活', () => {
  const s = summarizeShow([okEntry('a', 'page_only'), okEntry('b', 'page_only')]);
  assert.equal(s.restored, 0);
  assert.equal(s.page_only, 2);
  assert.match(s.message, /只做了页面级激活/);
  assert.doesNotMatch(s.message, /已恢复/);
});

t('有失败 → ok:false，主文案是「没能显示出来」，明细带原因和角色', () => {
  const s = summarizeShow([okEntry('a', 'restored'), badEntry('b', '读不到窗口 id', 'master')]);
  assert.equal(s.ok, false);
  assert.equal(s.failed, 1);
  assert.match(s.message, /有 1 个窗口没能显示出来/);
  assert.equal(s.details.length, 1);
  assert.equal(s.details[0].profile_id, 'b');
  assert.equal(s.details[0].role, 'master');
  assert.match(s.details[0].reason, /读不到窗口 id/);
});

t('失败但只有 problems 没有 reason → 明细用 problems 拼出「字段 期望 实际」', () => {
  const s = summarizeShow([{
    profile_id: 'a', role: 'slave', ok: false, raise: 'none',
    problems: [{ field: 'windowState', expected: 'normal', actual: 'minimized' }],
  }]);
  assert.match(s.details[0].reason, /windowState 期望 normal 实际 minimized/);
});

t('空列表 → 不报成功也不报失败，说「没有需要显示的窗口」', () => {
  const s = summarizeShow([]);
  assert.equal(s.total, 0);
  assert.equal(s.ok, true);
  assert.equal(s.message, '没有需要显示的窗口');
});

t('none（全屏没动）不算失败，也不算「已恢复」', () => {
  const s = summarizeShow([okEntry('a', 'none', 'master')]);
  assert.equal(s.ok, true);
  assert.equal(s.failed, 0);
  assert.equal(s.restored, 0);
  assert.equal(s.page_only, 0);
  assert.equal(s.message, '没有需要显示的窗口');
});

/* ============================ 4. 小工具 ============================ */
console.log('\n— 4. isMinimized / needsRestore —');
t('isMinimized 只认 minimized', () => {
  assert.equal(isMinimized('minimized'), true);
  assert.equal(isMinimized('normal'), false);
  assert.equal(isMinimized('maximized'), false);
  assert.equal(isMinimized(null), false);
});
t('needsRestore：非 normal 都要先恢复（复用 window.js 的判定）', () => {
  assert.equal(needsRestore('minimized'), true);
  assert.equal(needsRestore('maximized'), true);
  assert.equal(needsRestore('fullscreen'), true);
  assert.equal(needsRestore('normal'), false);
});

/* ============================ 4b. 强制置前（显式按钮那一档） ============================ */
console.log('\n— 4b. 强制置前（planForce / verifyForced / summarizeForce）：只有点了才走 —');

t('planForce：normal / maximized / minimized 都做一次 force', () => {
  const p = planForce([
    { profile_id: 'a', state: 'normal' },
    { profile_id: 'b', state: 'maximized' },
    { profile_id: 'c', state: 'minimized' },
  ]);
  assert.deepEqual(p.map((x) => x.action), ['force', 'force', 'force']);
  assert.deepEqual(p.map((x) => x.state_before), ['normal', 'maximized', 'minimized']);
});

t('planForce：fullscreen 不动（它本来就在最前面，动它反而破坏沉浸状态）', () => {
  const [p] = planForce([{ profile_id: 'a', state: 'fullscreen' }]);
  assert.equal(p.action, 'skip');
  assert.match(p.reason, /全屏/);
});

t('planForce：状态读不到当 normal，仍然 force（不猜）', () => {
  const [p] = planForce([{ profile_id: 'a', state: null }]);
  assert.equal(p.action, 'force');
  assert.equal(p.state_before, 'normal');
});

t('verifyForced 复用 verifyShown 的判定：normal 动完回到原状态、位置尺寸原样 → ok', () => {
  const v = verifyForced(
    { state_before: 'normal', rect_before: rect(2400, 200, 900, 600, 'normal') },
    rect(2400, 200, 900, 600, 'normal'));
  assert.equal(v.ok, true);
});

t('verifyForced 比普通 verifyShown 更严：动过窗口就要求位置尺寸回原样', () => {
  const before = { state_before: 'normal', rect_before: rect(2400, 200, 900, 600, 'normal') };
  const moved = rect(0, 0, 900, 600, 'normal');
  assert.equal(verifyShown(before, moved).ok, true, '默认档只做页面级激活、没碰窗口，不该因为位置报失败');
  const v = verifyForced(before, moved);
  assert.equal(v.ok, false, '强制档确实动过窗口，被搬走必须报出来');
  assert.deepEqual(v.problems.map((p) => p.field).sort(), ['x', 'y']);
});

t('verifyForced：最大化窗口恢复后仍是 maximized 算 ok，不比尺寸', () => {
  const v = verifyForced(
    { state_before: 'maximized', rect_before: rect(-8, -8, 3456, 1408, 'maximized') },
    rect(-8, -8, 3440, 1400, 'maximized'));
  assert.equal(v.ok, true);
});

t('verifyForced：恢复失败（还是 minimized）或读不到 → 不 ok', () => {
  const before = { state_before: 'normal', rect_before: rect(10, 10, 900, 600, 'normal') };
  assert.equal(verifyForced(before, rect(10, 10, 900, 600, 'minimized')).ok, false);
  assert.equal(verifyForced(before, null).ok, false);
});

t('summarizeForce：全成功说「已恢复显示并尝试置前 N 个窗口」，**不说「已置前」**', () => {
  const s = summarizeForce([
    { profile_id: 'a', role: 'slave', ok: true, action: 'force', raise: 'restored' },
    { profile_id: 'b', role: 'master', ok: true, action: 'force', raise: 'restored' },
  ]);
  assert.equal(s.ok, true);
  assert.equal(s.restored, 2);
  assert.match(s.message, /已恢复显示并尝试置前 2 个窗口/);
  assert.doesNotMatch(s.message, /已置前/);
  assert.equal(s.confirmed, 'window_restored', '能确认的只有窗口恢复，不是在最前面');
});

t('summarizeForce：有失败 → 两说分开，失败明细带原因', () => {
  const s = summarizeForce([
    { profile_id: 'a', role: 'slave', ok: true, action: 'force' },
    { profile_id: 'b', role: 'master', ok: false, action: 'force', reason: '读不到窗口 id' },
  ]);
  assert.equal(s.ok, false);
  assert.equal(s.restored, 1);
  assert.equal(s.failed, 1);
  assert.match(s.message, /已恢复显示并尝试置前 1 个窗口/);
  assert.match(s.message, /1 个窗口未能确认置前/);
  assert.equal(s.details[0].reason, '读不到窗口 id');
});

t('summarizeForce：全屏跳过不算失败，单独说「没动」', () => {
  const s = summarizeForce([{ profile_id: 'a', role: 'slave', ok: true, action: 'skip' }]);
  assert.equal(s.ok, true);
  assert.equal(s.failed, 0);
  assert.equal(s.skipped, 1);
  assert.match(s.message, /1 个全屏窗口没动/);
});

/* ============================ 5. 静态扫描 ============================ */
console.log('\n— 5. 静态扫描：路由 / 分档落点 / page_only 不参与 ok / 面板 / 不引依赖 —');

const sessionSrc = readSrc('src/sync/session.js');
const routesSrc = readSrc('src/api/routes.js');
const apiSrc = readSrc('web/api.js');
const panelSrc = readSrc('web/pages/sync-panel.js');
/**
 * 「显示窗口」区块 0.4.5 起搬进了共用组件 `web/sync-widgets.js`（操作台与「窗口同步」页各摆一份，
 * CEO 要求复用组件、不许另写一套）。所以下面扫的是**共用组件**，并额外钉住两个页面都 import 它。
 */
const widgetSrc = readSrc('web/sync-widgets.js');
const syncPageSrc = readSrc('web/pages/sync.js');
const showSrc = readSrc('src/sync/show.js');
const showBody = slice(sessionSrc, 'export async function showWindows(', '/** 页面文档有没有焦点');
const routesBlock = slice(routesSrc, '显示窗口（`viewWin`', "add(['POST'], ['/api/v2/sync/tab']");

t('路由 POST /api/v2/sync/show 存在，并调用 showWindows', () => {
  assert.match(routesBlock, /showWindows\(/);
  assert.match(routesBlock, /body\.profile_ids/);
});

t('路由返回值里带 os_foreground 说明（调用方不用猜）', () => {
  assert.match(routesBlock, /os_foreground/);
});

t('session.js 引入 show.js 的三件套，且分档写进 raise', () => {
  assert.match(sessionSrc, /import \{[^}]*planShow[^}]*\} from '\.\/show\.js'/);
  assert.match(sessionSrc, /entry\.raise = 'restored'/);
  assert.match(sessionSrc, /entry\.raise = 'page_only'/);
  assert.match(sessionSrc, /raise: 'none'/);
});

t('只有最小化才走 setWindowBounds(normal)；page_only 走 Page.bringToFront', () => {
  const restoreBranch = slice(showBody, "if (plan.action === 'restore') {", "} else if (plan.action === 'page_only')");
  assert.match(restoreBranch, /Browser\.setWindowBounds/);
  assert.match(restoreBranch, /windowState: 'normal'/);
  const pageBranch = slice(showBody, "} else if (plan.action === 'page_only') {", '}');
  assert.match(pageBranch, /Page\.bringToFront/);
  assert.doesNotMatch(pageBranch, /setWindowBounds/, 'page_only 这档不许去改窗口状态');
});

t('page_only 的 document.hasFocus() 只作读数：entry.ok 只能来自 verifyShown', () => {
  const assign = showBody.match(/entry\.ok\s*=\s*[^;]+;/g) || [];
  assert.equal(assign.length, 1, `希望只有一处赋值，实际 ${assign.length} 处`);
  assert.match(assign[0], /entry\.ok = v\.ok;/);
  /* page_focused 只在记录那一行出现，不许进 ok 判定 */
  const pf = showBody.match(/entry\.page_focused[^\n]*/g) || [];
  assert.ok(pf.length >= 1);
  assert.doesNotMatch(showBody, /entry\.ok\s*=[^;]*page_focused/);
  assert.doesNotMatch(showBody, /entry\.ok\s*=[^;]*hasFocus/);
});

t('os_foreground 只在全部 restored 时为 true（不许把 page_only 算进去）', () => {
  const line = showBody.match(/os_foreground:[^\n]*/)?.[0] || '';
  assert.match(line, /every\(\(r\) => r\.raise === 'restored'\)/);
});

t('showWindows 不默认用「先最小化再恢复」的闪动伪造置前', () => {
  assert.doesNotMatch(showBody, /windowState: 'minimized'/,
    '零依赖唯一能抬「被盖住」窗口的办法是 minimize→restore，但会闪任务栏，不能默认做');
  assert.doesNotMatch(showBody, /windowState:\s*"minimized"/);
});

t('show.js 零原生依赖：不碰 electron / koffi / child_process / Win32', () => {
  for (const bad of ['electron', 'koffi', 'child_process', 'user32', 'SetForegroundWindow', 'ffi']) {
    assert.ok(!showSrc.includes(bad), `show.js 里不该出现「${bad}」`);
  }
  assert.doesNotMatch(showSrc, /^\s*import .* from '(?!\.\/)/m, 'show.js 只许 import 同目录模块');
});

t('面板有「显示窗口」按钮，且调 /api/v2/sync/show', () => {
  assert.match(widgetSrc, /显示窗口/);
  /* 0.4.7.3 起带作用范围：可以是 `api.syncShow()`（会话）也可以是 `api.syncShow(ids)`（已选环境），
   * 判据只钉「打的是这条路由」，不钉参数形状 —— 否则解绑就被判成回归。 */
  assert.match(widgetSrc, /api\.syncShow\(/);
  assert.match(apiSrc, /syncShow:[\s\S]{0,120}\/api\/v2\/sync\/show/);
});

t('两个页面用的是同一份「显示窗口」实现（不是各写一套）', () => {
  /* 0.4.7.5 布局改版：窗口同步页的视觉骨架按 31 号文重排（表格行内图标 + 操作台里的「显示窗口」），
   * 不再复用操作台小窗那个 DOM 组件。但**调用只有一处**：页面必须走 sync-widgets 的 runShow，
   * 自己不许出现 api.syncShow。 */
  assert.match(widgetSrc, /export function buildShowPanel/);
  assert.match(widgetSrc, /export async function runShow/);
  assert.match(panelSrc, /buildShowPanel/);
  assert.match(syncPageSrc, /runShow/);
  assert.doesNotMatch(syncPageSrc, /api\.syncShow\(/);
});

t('面板把 page_only 的能力边界写出来（不假装都到前面了）', () => {
  assert.match(widgetSrc, /只做了页面级激活/);
  assert.match(widgetSrc, /盖住/);
});

t('「显示窗口」在两个页面上都真的能用（不是定义了没人调用）', () => {
  // 组件内部建好就画；操作台直接 mount 它；窗口同步页走同一个 runShow
  assert.match(widgetSrc, /mount\(el,/, '组件内部必须先画一次');
  assert.match(panelSrc, /showPanel\.el/, '操作台要把它 mount 出来');
  assert.match(syncPageSrc, /runShow\(/, '「窗口同步」页要真的调它');
  assert.match(syncPageSrc, /'显示窗口'/, '「窗口同步」页要有这个入口');
});

/* ---- CEO 点的两条：强制置前的按钮 + 默认行为不许偷偷做 ---- */

t('① page_only 档下存在「强制抬到前台（会闪一下）」按钮，且点的是 force 路由', () => {
  assert.match(widgetSrc, /强制抬到前台（会闪一下）/, '按钮文案要写明代价');
  assert.match(widgetSrc, /api\.syncShowForce\(/, '必须调 /api/v2/sync/show/force');
  assert.match(apiSrc, /syncShowForce:[\s\S]{0,140}\/api\/v2\/sync\/show\/force/);
  assert.match(routesSrc, /add\(\['POST'\], \['\/api\/v2\/sync\/show\/force'\]/, 'force 要有独立路由');
  /* 只在 page_only 那批存在时才出现，不是常驻按钮 */
  assert.match(widgetSrc, /pageOnlyIds\.length \? forceBox : null/);
  assert.match(widgetSrc, /filter\(\(x\) => x\.ok && x\.raise === 'page_only'\)/);
});

t('① force 的判定走同一处（复用 verifyShown，不另造一套）', () => {
  assert.match(showSrc, /export function verifyForced\(before, after\) \{\s*return verifyShown\(before, after, \{ strictRect: true \}\);/,
    'verifyForced 必须就是 verifyShown 加一个选项，不许自己再写一套比对');
  assert.match(sessionSrc, /const v = verifyForced\(/);
  /* 强制置前里也不许出现「自己算一遍位置对不对」 */
  const forceBody = slice(sessionSrc, 'export async function forceShowWindows(', '/**\n * 最小化 → 恢复原状态');
  assert.doesNotMatch(forceBody, /entry\.ok = [^;]*Math\.round/, '不许自己比位置');
});

t('① force 是一次性动作：不写设置、不是开关', () => {
  const forceBody = slice(sessionSrc, 'export async function forceShowWindows(', '/**\n * 最小化 → 恢复原状态');
  for (const bad of ['updateSettings', 'saveSettings', 'writeSettings', 'setSetting']) {
    assert.ok(!forceBody.includes(bad), `force 不许写设置（出现「${bad}」）`);
  }
  /* 面板里这个按钮不是 checkbox/开关 */
  const btn = widgetSrc.match(/强制抬到前台（会闪一下）'[\s\S]{0,80}/)?.[0] || '';
  assert.ok(!/checkbox|type: 'checkbox'/.test(btn), '一次性动作不许做成开关');
});

t('① 强制置前文案不写「已置前」：只能确认窗口恢复，确认不了在最前面', () => {
  assert.match(showSrc, /已恢复显示并尝试置前/);
  assert.doesNotMatch(showSrc, /message:[^\n]*已置前/, '产品里不调 Win32，不能声称已置前');
  assert.match(showSrc, /confirmed: 'window_restored'/);
  assert.match(sessionSrc, /os_foreground_confirmed: false/);
});

t('② 默认行为里不含 minimize→restore：showWindows 不许调 nudgeToFront', () => {
  assert.doesNotMatch(showBody, /nudgeToFront/, '默认「显示窗口」不许走强制置前那套');
  assert.doesNotMatch(showBody, /windowState: 'minimized'/);
  /* 默认路由的 handler 只调 showWindows，不调 forceShowWindows */
  const defaultRoute = slice(routesSrc, "add(['POST'], ['/api/v2/sync/show']", "add(['POST'], ['/api/v2/sync/show/force']");
  assert.match(defaultRoute, /showWindows\(ids\)/);
  assert.doesNotMatch(defaultRoute, /forceShowWindows/, '默认路由不许顺手做强制置前');
});

t('产品里不调 Win32：src/ 与 web/ 不引用 win-foreground.ps1 / user32 / koffi', () => {
  const srcFiles = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(ent.name)) srcFiles.push(p);
    }
  };
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'web'));
  const hits = [];
  for (const f of srcFiles) {
    const txt = fs.readFileSync(f, 'utf8');
    for (const bad of ['win-foreground.ps1', 'SetForegroundWindow', 'user32.dll', "from 'koffi'", 'require(\'koffi\')']) {
      if (txt.includes(bad)) hits.push(`${path.relative(ROOT, f)}: ${bad}`);
    }
  }
  assert.deepEqual(hits, [], '产品代码里出现了 Win32 / 原生依赖引用');
});

t('面板不自动抢焦点（同步时用户在主窗口打字）', () => {
  assert.doesNotMatch(panelSrc, /\.focus\(\)/, '面板里出现 focus() 会把按键从主窗口抢走');
});

/* ============================ 汇总 ============================ */
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? 'FAILED' : 'OK'}  ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log(failed.map((r) => `  · ${r.name}`).join('\n'));
  process.exit(1);
}
