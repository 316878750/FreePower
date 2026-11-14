/**
 * 标签页同步的 A 层判据（零 Chrome）：纯计划函数 + 两个开关的语义 + 界面静态扫描。
 *
 * 为什么先判纯函数：真内核那层（`test/sync-tabs-kernel.test.mjs`）跑一次要 1 分钟，
 * 而「序号越界该跳过还是该猜」「关其它该从大到小关」「统一标签页该开几个」这些是**算出来的**，
 * 在这里一秒就能钉死，真内核那层只负责证明「按计划执行真的落到浏览器上」。
 *
 * 跑法：npm run test:sync-tabs
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
  isBlankUrl, normalizeUrl, targetIndex, planCloseOthers, planCloseBlank, planUnify,
} = await import('../src/sync/tabs.js');
const { normalizeSettings, DEFAULT_SETTINGS } = await import('../src/sync/session.js');

/* ============================ 1. 空白页判定 ============================ */
console.log('\n— 1. 空白页判定（「关空白标签页」的判据就是它）—');
t('about:blank 是空白', () => assert.equal(isBlankUrl('about:blank'), true));
t('chrome://newtab 与 chrome://new-tab-page 都是空白', () => {
  assert.equal(isBlankUrl('chrome://newtab'), true);
  assert.equal(isBlankUrl('chrome://new-tab-page'), true);
  assert.equal(isBlankUrl('chrome://new-tab-page/'), true);
});
t('空串与 undefined 也算空白（没加载出东西的标签同样是空白）', () => {
  assert.equal(isBlankUrl(''), true);
  assert.equal(isBlankUrl(undefined), true);
  assert.equal(isBlankUrl(null), true);
});
t('大小写不敏感', () => assert.equal(isBlankUrl('ABOUT:BLANK'), true));
t('真网址不是空白', () => {
  assert.equal(isBlankUrl('https://example.com'), false);
  assert.equal(isBlankUrl('http://127.0.0.1:8080/a'), false);
});

/* ============================ 2. 网址归一 ============================ */
console.log('\n— 2. 打开网址的归一 —');
t('没有协议的补 https://', () => assert.equal(normalizeUrl('example.com'), 'https://example.com/'));
t('http/https 原样保留', () => {
  assert.equal(normalizeUrl('http://a.test/x'), 'http://a.test/x');
  assert.equal(normalizeUrl('https://b.test'), 'https://b.test/');
});
t('非 http(s) 协议一律拒（file: / javascript: / data:）', () => {
  assert.equal(normalizeUrl('file:///C:/a.html'), null);
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('data:text/html,x'), null);
});
t('空串与垃圾串返回 null', () => {
  assert.equal(normalizeUrl(''), null);
  assert.equal(normalizeUrl('   '), null);
  assert.equal(normalizeUrl('http://'), null);
});

/* ============================ 3. 序号映射 ============================ */
console.log('\n— 3. 序号映射（相同标签页那个开关就是它）—');
t('相同标签页开：主第 1 → 受控第 1', () => assert.equal(targetIndex(1, 3, true), 1));
t('相同标签页关：返回 null（调用方改用「当前可见」）', () => assert.equal(targetIndex(1, 3, false), null));
t('受控标签比主窗口少 → null（跳过，不猜、不乱关）', () => assert.equal(targetIndex(2, 2, true), null));
t('负序号 / 非数字 → null', () => {
  assert.equal(targetIndex(-1, 3, true), null);
  assert.equal(targetIndex('abc', 3, true), null);
});
t('主第 0 个永远能对上（受控至少 1 个标签）', () => assert.equal(targetIndex(0, 1, true), 0));

/* ============================ 4. 关标签计划 ============================ */
console.log('\n— 4. 关标签的计划 —');
t('关其它：留第 0 个 → 关 2、1（**从大到小**，边关边挪位不会漏）', () => {
  assert.deepEqual(planCloseOthers(3, 0), [2, 1]);
});
t('关其它：留中间那个', () => assert.deepEqual(planCloseOthers(4, 1), [3, 2, 0]));
t('只有 1 个标签时关其它 → 一个都不关（留下的是它自己）', () => {
  assert.deepEqual(planCloseOthers(1, 0), []);
});
t('keepIndex 越界时全关（没有要留的）', () => assert.deepEqual(planCloseOthers(2, 9), [1, 0]));
t('关空白：按 URL 判，也**从大到小**', () => {
  assert.deepEqual(planCloseBlank(['https://a', 'about:blank', 'https://b', 'chrome://newtab']), [3, 1]);
});
t('没有空白就一个都不关（别把真网页关掉）', () => {
  assert.deepEqual(planCloseBlank(['https://a', 'https://b']), []);
});

/* ============================ 5. 统一标签页 ============================ */
console.log('\n— 5. 统一标签页的计划 —');
t('完全一致 → 什么都不做', () => {
  assert.deepEqual(planUnify(['a', 'b'], ['a', 'b']), { navigate: [], open: [], close: [] });
});
t('同序号 URL 不同 → 原地导航（不关不开）', () => {
  assert.deepEqual(planUnify(['a', 'b'], ['a', 'x']), { navigate: [{ index: 1, url: 'b' }], open: [], close: [] });
});
t('受控窗口标签多 → 关尾部（从大到小）', () => {
  assert.deepEqual(planUnify(['a'], ['a', 'b', 'c']), { navigate: [], open: [], close: [2, 1] });
});
t('受控窗口标签少 → 尾部补开', () => {
  assert.deepEqual(planUnify(['a', 'b', 'c'], ['a']), { navigate: [], open: ['b', 'c'], close: [] });
});
t('主窗口 1 个、受控 0 个 → 全开', () => {
  assert.deepEqual(planUnify(['a', 'b'], []), { navigate: [], open: ['a', 'b'], close: [] });
});

/* ============================ 6. 两个开关独立 ============================ */
console.log('\n— 6. 两个开关必须独立（别合并成一个）—');
t('默认：相同标签页开、目标空白开', () => {
  assert.equal(DEFAULT_SETTINGS.same_tab, true);
  assert.equal(DEFAULT_SETTINGS.target_blank, true);
});
t('只关「相同标签页」不影响「目标空白」', () => {
  const st = normalizeSettings({ same_tab: false });
  assert.equal(st.same_tab, false);
  assert.equal(st.target_blank, true);
});
t('只关「目标空白」不影响「相同标签页」', () => {
  const st = normalizeSettings({ target_blank: false });
  assert.equal(st.target_blank, false);
  assert.equal(st.same_tab, true);
});
t('两个都能关（四种组合都表达得出来）', () => {
  const combos = [
    { same_tab: true, target_blank: true }, { same_tab: true, target_blank: false },
    { same_tab: false, target_blank: true }, { same_tab: false, target_blank: false },
  ];
  for (const c of combos) {
    const st = normalizeSettings(c);
    assert.equal(st.same_tab, c.same_tab);
    assert.equal(st.target_blank, c.target_blank);
  }
});
t('字符串 "false" 也真变 false', () => {
  const st = normalizeSettings({ same_tab: 'false', target_blank: 'false' });
  assert.equal(st.same_tab, false);
  assert.equal(st.target_blank, false);
});

/* ============================ 7. 界面与路由 ============================ */
console.log('\n— 7. 界面与路由 —');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const uiSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../web/pages/sync.js'), 'utf8');
  const apiSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../web/api.js'), 'utf8');
  const routeSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../src/api/routes.js'), 'utf8');

  check('同步页有独立的「相同标签页」开关', /sw\('same_tab'/.test(uiSrc));
  check('同步页有独立的「目标空白」开关', /sw\('target_blank'/.test(uiSrc));
  check('两个开关是两个勾选框，不是二选一', /sw\('same_tab'/.test(uiSrc) && /sw\('target_blank'/.test(uiSrc));
  for (const [label, fn] of [
    ['关当前标签页', 'syncCloseTabs(\'current\')'],
    ['关闭其他', 'syncCloseTabs(\'others\')'],
    ['关闭空白标签页', 'syncCloseTabs(\'blank\')'],
    ['复制当前标签到其它窗口', 'syncCopyTab'],
    ['统一标签页', 'syncUnifyTabs'],
    ['打开网址', 'syncOpenTab'],
  ]) {
    check(`同步页有「${label}」按钮并接到了对应 API`, uiSrc.includes(label) && uiSrc.includes(fn), fn);
  }
  for (const r of ['/api/v2/sync/tabs', '/api/v2/sync/tab-close', '/api/v2/sync/tab-copy', '/api/v2/sync/tab-unify']) {
    check(`路由存在：${r}`, routeSrc.includes(`'${r}'`), r);
  }
  check('web/api.js 四个标签接口都在', ['syncTabs', 'syncCloseTabs', 'syncCopyTab', 'syncUnifyTabs'].every((k) => apiSrc.includes(k)));
}

/* ============================ 8. 开标签的姿势（静态） ============================ */
console.log('\n— 8. 开标签必须走「先空白再导航」（静态扫描实现源）—');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const tabsSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../src/sync/tabs.js'), 'utf8');
  const codeOnly = tabsSrc.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  check('openTabFor 里 createTarget 只建 about:blank', /Target\.createTarget',\s*\{\s*url:\s*'about:blank'\s*\}/.test(codeOnly),
    (codeOnly.match(/Target\.createTarget[^\n]*/) || [''])[0]);
  const createCalls = codeOnly.match(/Target\.createTarget[^;]*/g) || [];
  check('本模块里每一条 createTarget 都只建 about:blank（没有带真网址的）',
    createCalls.length > 0 && createCalls.every((s) => s.includes("'about:blank'")), createCalls.join(' | '));
  /* session.js 里也不许自己再拼一份开标签的姿势：绕开 openTabFor 就会漏掉豁免登记 */
  const sessionSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../src/sync/session.js'), 'utf8');
  const sessionCode = sessionSrc.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  check('session.js 不再直接调 Target.createTarget（统一走 tabs.js 的 openTabFor）',
    !/Target\.createTarget/.test(sessionCode),
    (sessionCode.match(/Target\.createTarget[^\n]*/) || ['none'])[0]);
  check('openTabFor 里有 Page.navigate（空白页之后才导航）', /Page\.navigate/.test(codeOnly));
  check('openTabFor 在导航前调 onTarget（给 blank-reload 登记豁免）',
    codeOnly.indexOf('onTarget?.') >= 0 && codeOnly.indexOf('onTarget?.') < codeOnly.indexOf("Page.navigate', { url }"));
}

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail}/${results.length} 通过`);
process.exit(fail ? 1 : 0);