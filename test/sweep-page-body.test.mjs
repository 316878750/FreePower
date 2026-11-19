/**
 * 判据：扫描脚本的「正文取法」与「标题基准」（0.4.7.7，CEO 2026-11-19 从 trace 读出）。
 *
 * 两条真踩过的坑，都是**判据看错**而不是产品坏：
 *   ① 站2 `body_len=27396`、开头 80 字是 `@layer dynamic-sdk-styles{...}` —— `<style>` 的内容
 *      也被算进 `textContent`，拿长度当判据等于用样式表骗自己；
 *   ② 站1 三条隧道都建了（`points-api.xstocks.fi` 也建了），但 `readyState=complete` 时 React 还没挂载，
 *      读到空正文 → 判「标题不符」。**拿 readyState 当完成条件对 SPA 天然假红。**
 *
 * 口径：纯函数 + 静态读源码，不起内核、不碰真代理。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.SWEEP_IMPORT_ONLY = '1';
const sweep = await import('../tools/fingerprint-sweep.mjs');

const SRC = fs.readFileSync(path.join(import.meta.dirname, '..', 'tools', 'fingerprint-sweep.mjs'), 'utf8');

test('① 正文剥离：<style>/<script>/<noscript> 的内容不计入可见文字', () => {
  const html = `<html><head><style>@layer dynamic-sdk-styles{iframe[src*="wallet"]{display:none}}</style></head>
    <body><script>window.__INIT__={"a":1}</script><noscript>请启用 JavaScript</noscript>
    <h1>Sign up</h1><p>Create your account</p></body></html>`;
  const text = sweep.visibleTextFromHtml(html);
  assert.equal(text, 'Sign up Create your account', `实际是：${text}`);
  assert.ok(!/@layer|__INIT__|iframe/.test(text), 'CSS / JS / iframe 规则不能算正文');
  assert.ok(!/请启用/.test(text), 'noscript 不算可见文字');
});

test('② 站2 那 27396 字符的死法：剥掉 CSS 后长度骤降，且不再以 @layer 开头', () => {
  const cssOnly = `<body><style>${'@layer dynamic-sdk-styles{iframe[src*="wallet-dev.blocto.app"],iframe[src*="wall"]{border:0}}'.repeat(400)}</style></body>`;
  assert.ok(cssOnly.length > 20000, '构造的样例应该有 2 万多字符');
  assert.equal(sweep.visibleTextFromHtml(cssOnly), '', '只有 CSS 的页面可见文字必须是空');
});

test('③ 普通文字 / 实体 / 标签照常读出', () => {
  const html = '<body><div><span>Hello</span>&nbsp;<b>World</b></div><p>a &amp; b</p></body>';
  assert.equal(sweep.visibleTextFromHtml(html), 'Hello World a & b');
});

test('④ 站1 标题基准：xPoints 或 xStocks 任一命中都算过（实测 title 两个都在）', () => {
  const s1 = sweep.SITES.find((s) => s.key === 'xpoints');
  assert.ok(s1, '站1 还在');
  assert.deepEqual(s1.titleIncludesAny, ['xPoints', 'xStocks'], '基准应是两个都接受');
  // 2026-11-19 五个环境实测标题
  assert.ok(sweep.titleOk(s1, 'xPoints Rewards Program - xStocks'), '实测标题要过');
  assert.ok(sweep.titleOk(s1, 'xPoints Rewards Program'), '站点只留 xPoints 也要过');
  assert.ok(sweep.titleOk(s1, 'xStocks'), '站点只留 xStocks 也要过');
  assert.ok(!sweep.titleOk(s1, 'Startale App'), '别的站标题要判不符');
  assert.ok(!sweep.titleOk(s1, ''), '空标题要判不符');
  // 站2 照旧：单串子串
  const s2 = sweep.SITES.find((s) => s.key === 'startale');
  assert.ok(sweep.titleOk(s2, 'Startale App'));
  assert.ok(!sweep.titleOk(s2, 'Something Else'));
});

test('⑤ 判据改成「正文非空」：源码里不再拿 readyState 当完成条件', () => {
  // probeSite 里除了记录 `ready` 字段，不许出现「ready === 'complete' 就结束」
  assert.ok(!/snap\.ready === 'complete'/.test(SRC), '不允许再用 readyState 当完成条件');
  assert.ok(/firstBodyMs/.test(SRC), '要记正文首次非空的时刻');
  assert.ok(/settle_ms|settleMs/.test(SRC), '要记正文稳定下来的时刻');
  assert.ok(/body300/.test(SRC), '要把正文前 300 字写进读数');
  // 每站轮询间隔 500ms
  assert.ok(/const pollMs = 500/.test(SRC), '轮询间隔应为 500ms');
  // 到上限才算「没打开」：timeout 由「从没读到非空正文」决定
  assert.ok(/timeout: !everBody/.test(SRC), 'timeout 必须由「从没读到非空正文」决定');
});
