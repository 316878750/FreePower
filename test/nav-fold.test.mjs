/**
 * 侧栏折叠的判据（不需要 Chrome，纯 node）。
 *
 * 两层：
 *  A. web/nav.js 的纯逻辑 —— 存下来的状态不可信（用户能改、旧版本能写脏），
 *     脏数据必须退化成「都没折」，不能让整个侧栏崩掉；
 *  B. 静态结构 —— 「常用」组**没有折叠入口**、「自动化」组有，
 *     顺序、以及「应用中心必须是真页面而不是灰占位」（0.4.3 之前它是「不许放占位」，
 *     做出来之后这一条就改严成「导航项 + 路由 + 页面模块三样都得在」）。
 *
 * 这些是「便宜但一旦错了用户立刻踩到」的判据：侧栏是每天第一眼看到的东西。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  FOLD_KEY, FOLDABLE_GROUPS, isFoldable, parseFold, isFolded, toggleFold,
  serializeFold, readFold, writeFold, ariaExpanded,
} from '../web/nav.js';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};
const equal = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `期望 ${e}，实际 ${a}`);
};

/* ============ A 层：纯逻辑 ============ */

// 1. 默认不折
equal('parseFold(null) → 都没折', parseFold(null), {});
equal('parseFold("") → 都没折', parseFold(''), {});

// 2. 脏数据一律退化成「都没折」，且不许抛
let threw = false;
let junk = {};
try {
  for (const raw of ['{', 'not json', '[]', '[true]', '42', '"automation"', 'true', 'null']) {
    junk[raw] = parseFold(raw);
  }
} catch {
  threw = true;
}
check('parseFold 对 8 种脏数据都不抛', !threw);
check('脏数据全部退化成空对象', Object.values(junk).every((v) => JSON.stringify(v) === '{}'));

// 3. 只认严格 true —— "yes" / 1 / "true" 都不算
equal('{"automation":1} 不算折', parseFold('{"automation":1}'), {});
equal('{"automation":"yes"} 不算折', parseFold('{"automation":"yes"}'), {});
equal('{"automation":"true"} 不算折', parseFold('{"automation":"true"}'), {});
equal('{"automation":true} 算折', parseFold('{"automation":true}'), { automation: true });

// 4. 未知分组（含「常用」）不许留
equal('{"primary":true} 被丢弃', parseFold('{"primary":true}'), {});
check('FOLDABLE_GROUPS 里没有常用组', !FOLDABLE_GROUPS.includes('primary'));
check('isFoldable("primary") === false', isFoldable('primary') === false);
check('isFoldable("automation") === true', isFoldable('automation') === true);

// 5. toggle 往返 + 不改入参
const s0 = {};
const s1 = toggleFold(s0, 'automation');
check('折起来', s1.automation === true);
check('toggle 不改入参', Object.keys(s0).length === 0);
const s2 = toggleFold(s1, 'automation');
check('再 toggle 展开', s2.automation === undefined);
equal('不可折叠的分组 toggle 无效果', toggleFold({}, 'primary'), {});
equal('不可折叠的分组即使传进来也不折', toggleFold({ primary: true }, 'primary'), { primary: true });

// 6. isFolded 对空值安全
check('isFolded(null) 不抛且为 false', isFolded(null, 'automation') === false);
check('isFolded(undefined) 为 false', isFolded(undefined, 'automation') === false);
check('isFolded 对常用组恒 false', isFolded({ primary: true }, 'primary') === false);

// 7. 序列化只写折起来的
check('serializeFold 未折 → "{}"', serializeFold({}) === '{}');
check('serializeFold 折了 → 带 automation', serializeFold({ automation: true }) === '{"automation":true}');
check('serializeFold 丢掉未知分组', serializeFold({ automation: true, primary: true }) === '{"automation":true}');
check('serialize+parse 往返一致', JSON.stringify(parseFold(serializeFold({ automation: true }))) === '{"automation":true}');

// 8. storage 不可用/会抛时不许崩
check('readFold(null) → {}', JSON.stringify(readFold(null)) === '{}');
const throwingStore = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceeded'); },
};
// 自己包一层 try：直接崩掉进程虽然也是「红」，但没有失败项名，看不出哪条判据没守住
let readErr = null;
let readVal = null;
try { readVal = readFold(throwingStore); } catch (e) { readErr = e.message; }
check('readFold 遇到会抛的 storage 不抛', readErr === null, readErr || '');
check('readFold 遇到会抛的 storage → {}', JSON.stringify(readVal) === '{}');
check('writeFold 遇到会抛的 storage → false 且不抛', writeFold(throwingStore, { automation: true }) === false);

// 9. 真 storage 往返
const mem = new Map();
const store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
check('writeFold 成功', writeFold(store, { automation: true }) === true);
check('写进约定的键', mem.has(FOLD_KEY));
equal('读回来一致', readFold(store), { automation: true });
writeFold(store, {});
equal('展开后读回来是空', readFold(store), {});

// 10. aria：折叠对读屏软件可见
check('折起来 aria-expanded=false', ariaExpanded({ automation: true }, 'automation') === 'false');
check('展开 aria-expanded=true', ariaExpanded({}, 'automation') === 'true');
check('常用组恒 true', ariaExpanded({ primary: true }, 'primary') === 'true');

// 11. nav.js 必须是纯逻辑：不碰 DOM / 不自己读 localStorage
const navSrc = fs.readFileSync(path.join(ROOT, 'web', 'nav.js'), 'utf8');
check('nav.js 不碰 document', !/\bdocument\./.test(navSrc));
check('nav.js 不碰 window', !/\bwindow\./.test(navSrc));
check('nav.js 不直接读 localStorage', !/localStorage\.(get|set)Item/.test(navSrc));

/* ============ B 层：静态结构 ============ */

const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'web', 'style.css'), 'utf8');

// 12. 「常用」组没有折叠入口（没有 data-fold，标题是 div 不是 button）
// 先把注释剥掉：注释里提到 data-fold 是在解释另一组，不算这组的属性。
const htmlClean = html.replace(/<!--[\s\S]*?-->/g, '');
const groups = htmlClean.split('<div class="nav-group"').slice(1);
check('侧栏有两个分组', groups.length === 2, `实际 ${groups.length}`);
const primaryGroup = groups[0] || '';
const autoGroup = groups[1] || '';
check('常用组没有 data-fold', !/data-fold\s*=/.test(primaryGroup));
check('常用组标题不是按钮', !primaryGroup.includes('<button'));
check('常用组里是环境管理 + 代理管理', /环境管理/.test(primaryGroup) && /代理管理/.test(primaryGroup));

// 13. 「自动化」组有折叠入口
check('自动化组带 data-fold="automation"', autoGroup.includes('data-fold="automation"'));
check('自动化组标题是 button', autoGroup.includes('<button'));
check('按钮带 data-fold-toggle="automation"', autoGroup.includes('data-fold-toggle="automation"'));
check('按钮带 aria-expanded', autoGroup.includes('aria-expanded="true"'));

// 14. 侧栏顺序（用户习惯的排法，不能乱）
const order = ['data-nav="profiles"', 'data-nav="proxies"', 'data-nav="apps"', 'data-nav="agent"', 'data-nav="sync"', 'data-nav="api"'];
const idx = order.map((k) => html.indexOf(k));
check('6 个导航项都在', idx.every((i) => i >= 0), JSON.stringify(idx));
check('顺序 环境→代理→应用中心→Agent→同步→API', idx.every((v, i) => i === 0 || v > idx[i - 1]));
check('窗口同步在 AI Agent 之后、API 之前', html.indexOf('data-nav="sync"') > html.indexOf('data-nav="agent"')
  && html.indexOf('data-nav="sync"') < html.indexOf('data-nav="api"'));

// 15. 应用中心：0.4.3 已经做出来了，所以这一条从「不许放灰占位」改严成「必须是真页面」
//     （原判据是「还没做就别放个点不动的灰条」，现在做了，就要求它真的接上路由与页面模块）
check('应用中心在「常用」组里、是能点的链接', /<a class="nav-item" data-nav="apps" href="#\/apps">应用中心<\/a>/.test(primaryGroup));
check('应用中心不是灰占位（没有 disabled / aria-disabled）',
  !/data-nav="apps"[^>]*(disabled|aria-disabled)/.test(htmlClean));
check('app.js 注册了 /apps 路由并 import 了页面模块',
  /import appsPage from '\.\/pages\/apps\.js'/.test(appSrc) && /nav: 'apps', page: appsPage/.test(appSrc));

// 16. CSS：折起来真的收走条目 + 小三角转向
check('CSS 有 .nav-group.collapsed 隐藏条目', /\.nav-group\.collapsed\s+\.nav-item\s*\{[^}]*display:\s*none/.test(css));
check('CSS 有 .nav-group.collapsed 旋转小三角', /\.nav-group\.collapsed\s+\.nav-caret\s*\{[^}]*rotate/.test(css));

// 17. app.js 接上了：import nav.js、点标题翻转、写回、当前页自动展开
check('app.js 从 ./nav.js 引入', /from '\.\/nav\.js'/.test(appSrc));
check('app.js 调用 toggleFold', /toggleFold\(/.test(appSrc));
check('app.js 写回折叠状态', /writeFold\(/.test(appSrc));
check('app.js 读回折叠状态', /parseFold\(/.test(appSrc));
// 调用点（带分号）—— 不能只匹配名字，`function revealActive() {` 也会被 /revealActive\(\)/ 命中
check('app.js 路由后展开当前页所在组', /revealActive\(\);/.test(appSrc));
check('app.js 监听标题点击', /data-fold-toggle/.test(appSrc));

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);