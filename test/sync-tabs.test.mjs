/**
 * 标签页同步的 A 层判据（零 Chrome）：纯计划函数 + 设置归一 + 界面静态扫描。
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
  isBlankUrl, normalizeUrl, parseOpenUrls, targetIndex, planCloseOthers, planCloseBlank, planUnify,
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

/* ========== 6. 标签区只有「首个网址在当前标签页打开」一个选项 ========== */
console.log('\n— 6. 自创开关必须去掉，只留对手界面上真有的那一个 —');
t('默认：内部 same_tab 开、首个网址在当前标签页打开关', () => {
  assert.equal(DEFAULT_SETTINGS.same_tab, true);
  assert.equal(DEFAULT_SETTINGS.current_tab_url, false);
});
t('「目标空白」不再是设置项（先开空白再导航是硬约束，不可关）', () => {
  assert.equal('target_blank' in DEFAULT_SETTINGS, false);
  const st = normalizeSettings({ target_blank: false });
  assert.equal(st.target_blank, undefined);
});
t('「首个网址在当前标签页打开」是独立开关，字符串 "true" 也认', () => {
  assert.equal(normalizeSettings({}).current_tab_url, false);
  assert.equal(normalizeSettings({ current_tab_url: true }).current_tab_url, true);
  assert.equal(normalizeSettings({ current_tab_url: 'true' }).current_tab_url, true);
  assert.equal(normalizeSettings({ current_tab_url: '1' }).current_tab_url, true);
  assert.equal(normalizeSettings({ current_tab_url: 'false' }).current_tab_url, false);
});
t('关掉它不影响内部 same_tab，反之亦然', () => {
  const a = normalizeSettings({ current_tab_url: true });
  assert.equal(a.same_tab, true);
  const b = normalizeSettings({ same_tab: false });
  assert.equal(b.current_tab_url, false);
});

/* ================== 6b. 打开网址：多行、最多 10 个、不静默截断 ================== */
console.log('\n— 6b. 打开网址的列表解析（对手原文：一键最多打开10个网址）—');
t('多行文本按行切，空行丢掉', () => {
  assert.deepEqual(parseOpenUrls('www.a.com\n  \nwww.b.com\n').urls, ['https://www.a.com/', 'https://www.b.com/']);
});
t('数组入参同样接受（面板传的是行数组）', () => {
  assert.deepEqual(parseOpenUrls(['a.com', 'https://b.com/x']).urls, ['https://a.com/', 'https://b.com/x']);
});
t('恰好 10 个可以', () => {
  const r = parseOpenUrls(Array.from({ length: 10 }, (_, i) => `https://e${i}.com/`));
  assert.equal(r.error, null);
  assert.equal(r.urls.length, 10);
});
t('11 个直接报错，**不静默截断**（不许返回前 10 个就说成功）', () => {
  const r = parseOpenUrls(Array.from({ length: 11 }, (_, i) => `https://e${i}.com/`));
  assert.equal(r.error, '一键最多打开10个网址');
  assert.deepEqual(r.urls, []);
});
t('超过 10 个时错误文案就是对手原文', () => {
  assert.match(parseOpenUrls(Array.from({ length: 12 }, () => 'a.com')).error, /^一键最多打开10个网址$/);
});
t('非 http/https 协议拒掉', () => {
  assert.equal(parseOpenUrls('ftp://a.com/x').error, 'url 必须是 http/https 地址');
  assert.equal(parseOpenUrls('javascript:alert(1)').error, 'url 必须是 http/https 地址');
});
t('全空 → 报错（不当作「什么都不用做」静默成功）', () => {
  assert.equal(parseOpenUrls('  \n\n ').error, 'url 必须是 http/https 地址');
});

/* ============================ 7. 界面与路由 ============================ */
console.log('\n— 7. 界面与路由 —');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const uiSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../web/pages/sync.js'), 'utf8');
  const apiSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../web/api.js'), 'utf8');
  const routeSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../src/api/routes.js'), 'utf8');

  check('同步页有「首个网址在当前标签页打开」勾选项（对手原文）',
    uiSrc.includes('首个网址在当前标签页打开') && uiSrc.includes('current_tab_url'));
  check('同步页**不再**有「目标空白」这个名字（自创名去掉）', !uiSrc.includes('目标空白'));
  check('同步页**不再**有「相同标签页」这个用户可见开关', !uiSrc.includes('相同标签页'));
  check('打开网址的输入是多行文本框（不是单行 input）', /h\('textarea'/.test(uiSrc));
  check('提示语用对手原文「一键最多打开10个网址」', uiSrc.includes('一键最多打开10个网址'));
  check('网址框的占位文案用对手原文（请输入网址，每行一个）', uiSrc.includes('请输入网址，每行一个'));
  for (const [label, fn] of [
    ['关闭当前标签页', 'syncCloseTabs(\'current\')'],
    ['关闭其他', 'syncCloseTabs(\'others\')'],
    ['关闭空白标签页', 'syncCloseTabs(\'blank\')'],
    ['复制当前标签到其它窗口', 'syncCopyTab'],
    ['统一标签页', 'syncUnifyTabs'],
  ]) {
    check(`同步页有「${label}」按钮并接到了对应 API`, uiSrc.includes(label) && uiSrc.includes(fn), fn);
  }
  /* 「打开」两个字太短，includes 会被别的按钮名蹭过去，用带 act(' 的形式钉 */
  check('同步页有「打开」按钮并接到了 syncOpenTab',
    /act\('打开',\s*openUrls\)/.test(uiSrc) && uiSrc.includes('api.syncOpenTab(list)'),
    (uiSrc.match(/act\('打开'[^\n]*/) || ['?'])[0]);
  for (const r of ['/api/v2/sync/tabs', '/api/v2/sync/tab-close', '/api/v2/sync/tab-copy', '/api/v2/sync/tab-unify', '/api/v2/sync/tab']) {
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
  // 0.4.7.13：session.js 拆成门面 + session-*.js，静态扫描读全部
  const sessionSrc = ['session.js','session-state.js','session-cdp.js','session-live.js','session-windows.js','session-tabs.js'].map((f) => fs.readFileSync(path.resolve(import.meta.dirname, '../src/sync', f), 'utf8')).join('\n');
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