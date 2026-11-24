/**
 * 窗口尺寸/排列的 A 层判据（零 Chrome）：纯函数 + 路由与界面静态扫描。
 *
 * 这里钉的是「算得对、报得实」：真正把窗口改掉那层在 `sync-window-kernel.test.mjs`。
 * 一条核心立场：**命令成功 ≠ 窗口变了**。所以「成功」只能由回读比对（verifyBounds）决定，
 * 这里先把比对逻辑本身钉死（含差 1px、状态不是 normal 这些真会发生的边界）。
 *
 * 跑法：npm run test:sync-window
 */
import assert from 'node:assert/strict';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const t = (name, fn) => {
  try { fn(); check(name, true); } catch (e) { check(name, false, e?.message || String(e)); }
};

const {
  WINDOW_STATES, normalizeState, needsRestoreBeforeResize, verifyBounds, summarizeResize,
} = await import('../src/sync/window.js');

/* ============================ 1. 状态归一 ============================ */
console.log('\n— 1. 窗口状态（最大化/全屏下 setWindowBounds 会被静默忽略）—');
t('四种状态原样认', () => {
  for (const s of WINDOW_STATES) assert.equal(normalizeState(s), s);
});
t('缺省当 normal（CDP 的默认值）', () => {
  assert.equal(normalizeState(undefined), 'normal');
  assert.equal(normalizeState(null), 'normal');
  assert.equal(normalizeState(''), 'normal');
});
t('不认识的状态不猜，当 normal', () => assert.equal(normalizeState('tiled'), 'normal'));
t('只有 normal 不需要先恢复', () => {
  assert.equal(needsRestoreBeforeResize('normal'), false);
  assert.equal(needsRestoreBeforeResize(undefined), false);
});
t('最大化 / 全屏 / 最小化都要先恢复', () => {
  assert.equal(needsRestoreBeforeResize('maximized'), true);
  assert.equal(needsRestoreBeforeResize('fullscreen'), true);
  assert.equal(needsRestoreBeforeResize('minimized'), true);
});

/* ============================ 2. 回读比对 ============================ */
console.log('\n— 2. 回读比对：只有它说了算 —');
t('宽高一致且 normal → 成功', () => {
  const v = verifyBounds({ width: 1000, height: 700 }, { width: 1000, height: 700, state: 'normal' });
  assert.equal(v.ok, true);
  assert.deepEqual(v.mismatches, []);
});
t('差 1px 也算不一致（不许四舍五入糊过去）', () => {
  const v = verifyBounds({ width: 1000, height: 700 }, { width: 999, height: 700, state: 'normal' });
  assert.equal(v.ok, false);
  assert.equal(v.mismatches[0].field, 'width');
  assert.equal(v.mismatches[0].expected, 1000);
  assert.equal(v.mismatches[0].actual, 999);
});
t('宽高都对但状态是 maximized → 不一致（尺寸对不等于能同步）', () => {
  const v = verifyBounds({ width: 1920, height: 1080 }, { width: 1920, height: 1080, state: 'maximized' });
  assert.equal(v.ok, false);
  assert.deepEqual(v.mismatches.map((m) => m.field), ['windowState']);
});
t('读不到宽高（null）→ 不一致，且 actual 如实带 null', () => {
  const v = verifyBounds({ width: 1000, height: 700 }, { width: null, height: null, state: 'normal' });
  assert.equal(v.ok, false);
  assert.equal(v.mismatches.length, 2);
  assert.equal(v.mismatches[0].actual, null);
});
t('expected 的宽高不是数字 → 不一致（不静默通过）', () => {
  const v = verifyBounds({ width: NaN, height: 700 }, { width: 1000, height: 700, state: 'normal' });
  assert.equal(v.ok, false);
  assert.equal(v.mismatches[0].field, 'width');
});
t('windowState 字段名两种写法都认（CDP 里两种都出现过）', () => {
  assert.equal(verifyBounds({ width: 10, height: 10 }, { width: 10, height: 10, windowState: 'maximized' }).ok, false);
});

/* ============================ 3. 结果汇总（面板文案） ============================ */
console.log('\n— 3. 结果汇总：改不动要如实说 —');
t('全部成功 → ok、文案说清楚改了几个', () => {
  const s = summarizeResize([
    { profile_id: 'a', role: 'slave', ok: true },
    { profile_id: 'b', role: 'slave', ok: true },
  ]);
  assert.equal(s.ok, true);
  assert.equal(s.failed, 0);
  assert.equal(s.total, 2);
  assert.match(s.message, /已把 2 个窗口改成同尺寸/);
});
t('有一个失败 → 文案「有 N 个窗口没能改成同尺寸」，并带上原因', () => {
  const s = summarizeResize([
    { profile_id: 'a', role: 'slave', ok: true },
    { profile_id: 'b', role: 'slave', ok: false, mismatches: [{ field: 'width', expected: 1000, actual: 900 }] },
  ]);
  assert.equal(s.ok, false);
  assert.equal(s.failed, 1);
  assert.match(s.message, /有 1 个窗口没能改成同尺寸/);
  assert.match(s.details[0].reason, /width 期望 1000 实际 900/);
});
t('失败原因是异常时原样带出（不吞）', () => {
  const s = summarizeResize([{ profile_id: 'x', role: 'slave', ok: false, reason: 'connection lost' }]);
  assert.equal(s.details[0].reason, 'connection lost');
});

/* ============================ 4. 路由与界面 ============================ */
console.log('\n— 4. 路由与界面（静态扫描）—');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const routeSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../src/api/routes.js'), 'utf8');
  const uiSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../web/pages/sync.js'), 'utf8');
  // 0.4.7.13：session.js 拆成门面 + session-*.js，静态扫描读全部
const sessionSrc = ['session.js','session-state.js','session-cdp.js','session-live.js','session-windows.js','session-tabs.js'].map((f) => fs.readFileSync(path.resolve(import.meta.dirname, '../src/sync', f), 'utf8')).join('\n');
  const sessionCode = sessionSrc.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');

  check('路由存在：/api/v2/sync/unify-size', routeSrc.includes("'/api/v2/sync/unify-size'"));
  check('界面有「一键统一尺寸」按钮并接上 API', uiSrc.includes('一键统一尺寸') && uiSrc.includes('syncUnifySize'));
  check('界面把失败数如实显示出来（用 summary.message，不是自己拼「成功」）',
    uiSrc.includes('summary?.message') || uiSrc.includes('summary.message'));
  check('统一尺寸走「先回 normal 再设宽高」', /windowState: 'normal'/.test(sessionCode) && /bounds: \{ width: ref\.width, height: ref\.height \}/.test(sessionCode));
  check('统一尺寸设完**回读**校验（调 verifyBounds）', /verifyBounds\(/.test(sessionCode));
  check('统一尺寸不静默成功：失败带 summary', /summarizeResize\(/.test(sessionCode));
  /**
   * 「统一尺寸不碰显示器/系统设置」这条要**按函数扫**：同一个文件里现在还有窗口排列，
   * 排列确实要用 `workArea`（那是从桌面壳的显示器交接里读的，不是改系统设置）。
   * 所以把断言收紧到 `unifySize` 函数体：它里面**一个字都不许提**显示器相关的东西。
   */
  const bodyOf = (src, name) => {
    const at = src.indexOf(`export async function ${name}`);
    if (at < 0) return null;
    const rest = src.slice(at + 10);
    const end = rest.indexOf('export ');
    return end < 0 ? rest : rest.slice(0, end);
  };
  const unifyBody = bodyOf(sessionCode, 'unifySize');
  check('统一尺寸不碰显示器/系统设置（不 import electron / 不调 display API）',
    !/electron/.test(sessionCode) && !/getAllDisplays/.test(sessionCode));
  check('统一尺寸函数体里不出现显示器相关调用（workArea / getAllDisplays / screen.）',
    !!unifyBody && unifyBody.length > 200 && !/workArea|getAllDisplays|screen\./.test(unifyBody),
    unifyBody ? '' : '找不到 unifySize 函数体');
}

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail}/${results.length} 通过`);
process.exit(fail ? 1 : 0);