/**
 * 网络开关的匹配逻辑单测（不需要 Chrome）
 *
 * 为什么单独一个文件：`disable_video` / `blacklist` / `whitelist` 的判定是纯函数，
 * 把它钉住之后，真机判据（test/switches.test.mjs）只需要回答「CDP 到底有没有按判定执行」，
 * 出问题能被分成两类：**判定错**（这里红）和**没落地**（那边红）。
 *
 * 跑法：npm run test:net-rules
 */
import { toRuleList, compileNetRules, decideRequest, parseTarget } from '../src/kernel/net-rules.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------------------------------- 列表归一 ---------------------------------- */
check('toRuleList：CSV 串 → 数组（去空、去重、小写）',
  eq(toRuleList(' Example.com, ,example.com\nA.com '), ['example.com', 'a.com']),
  JSON.stringify(toRuleList(' Example.com, ,example.com\nA.com ')));
check('toRuleList：JSON 数组串也认',
  eq(toRuleList('["a.com","b.com"]'), ['a.com', 'b.com']),
  JSON.stringify(toRuleList('["a.com","b.com"]')));
check('toRuleList：空值 → 空数组',
  toRuleList(null).length === 0 && toRuleList('').length === 0 && toRuleList([]).length === 0);

/* ---------------------------------- URL 解析 ---------------------------------- */
check('parseTarget：http 默认端口 80',
  eq(parseTarget('http://A.com/x'), { href: 'http://a.com/x', host: 'a.com', port: '80' }));
check('parseTarget：https 默认端口 443',
  parseTarget('https://a.com/x').port === '443');
check('parseTarget：非 http(s) 返回 null（about/data/chrome 不参与判定）',
  parseTarget('about:blank') === null && parseTarget('data:text/html,x') === null && parseTarget('chrome://newtab') === null);

/* ---------------------------------- 黑名单 ---------------------------------- */
const bl = compileNetRules({ blacklist: 'example.com,*.wild.com,http://a.com/private*' });
const block = (url, resourceType, rules) => decideRequest({ url, resourceType }, rules);

check('黑名单：主机命中', block('https://example.com/x', 'Document', bl).reason === 'blacklist');
check('黑名单：子域命中', block('https://cdn.example.com/a.png', 'Image', bl).reason === 'blacklist');
check('黑名单：相似但不同的域不命中', block('https://notexample.com/x', 'Document', bl).block === false);
check('黑名单：*.wild.com 命中子域', block('https://x.wild.com/a', 'Script', bl).reason === 'blacklist');
check('黑名单：*.wild.com 不命中裸域', block('https://wild.com/a', 'Script', bl).block === false);
check('黑名单：URL 通配命中路径', block('http://a.com/private/1', 'XHR', bl).reason === 'blacklist');
check('黑名单：URL 通配不命中同域其它路径', block('http://a.com/public/1', 'XHR', bl).block === false);
check('黑名单：不相关站点放行', block('https://b.com/a', 'Document', bl).block === false);

const blPort = compileNetRules({ blacklist: '127.0.0.1:8080' });
check('黑名单：带端口精确匹配（同端口被拦）', block('http://127.0.0.1:8080/a', 'Document', blPort).block === true);
check('黑名单：带端口精确匹配（别的端口放行）', block('http://127.0.0.1:9090/a', 'Document', blPort).block === false);

/* ---------------------------------- 白名单 ---------------------------------- */
const wl = compileNetRules({ whitelist: 'only.com' });
check('白名单：名单内放行', block('https://only.com/a', 'Document', wl).block === false);
check('白名单：名单外被拦', block('https://other.com/a', 'Document', wl).reason === 'not_in_whitelist');
check('白名单：子域算名单内', block('https://cdn.only.com/a.js', 'Script', wl).block === false);
check('白名单：与黑名单同时存在时，白名单外先被拦',
  block('https://other.com/a', 'Document', compileNetRules({ whitelist: 'only.com', blacklist: 'other.com' })).reason === 'not_in_whitelist');

/* 白名单模式**忽略**黑名单 —— 这条 2026-11-12 按逆向 21- §3 改了期望值（原来是"拦"）。
   对手的实现里，白名单开关为真时只走白名单分支，环境黑名单的项根本不会进 `NetFilters`；
   两个模式互斥、白名单优先。所以「名单内且同时命中黑名单」在对手那边是放行。
   我们原来"先判白名单、再判黑名单"会拦，那不是更严，是语义不同：按对手行为写的规则
   （比如黑名单压着历史域名、临时开白名单放行）在我们这儿会静默失效。 */
check('白名单：名单内且同时命中黑名单 → 放行（互斥、白名单优先）',
  block('https://only.com/a', 'Document', compileNetRules({ whitelist: 'only.com', blacklist: 'only.com' })).block === false);
check('白名单：黑名单整体不参与（子域也放行）',
  block('https://cdn.only.com/a.js', 'Script', compileNetRules({ whitelist: 'only.com', blacklist: '*.only.com' })).block === false);
check('白名单：名单外即使不在黑名单里也拦',
  block('https://other.com/a', 'Document', compileNetRules({ whitelist: 'only.com', blacklist: '' })).reason === 'not_in_whitelist');
check('白名单 + disable_video：视频仍按 Media 拦（互斥只针对两张名单，不是针对视频开关）',
  block('https://only.com/v.mp4', 'Media', compileNetRules({ whitelist: 'only.com', disable_video: '1' })).reason === 'disable_video');

/* ---------------------------------- 视频 ---------------------------------- */
const vid = compileNetRules({ disable_video: '1' });
check('disable_video：Media 请求被拦', block('https://a.com/v.mp4', 'Media', vid).reason === 'disable_video');
check('disable_video：其它类型不受影响', block('https://a.com/a.js', 'Script', vid).block === false);
check('disable_video=0：不拦（默认关）',
  block('https://a.com/v.mp4', 'Media', compileNetRules({ disable_video: '0' })).block === false);

/* 视频的「mime 分支」（逆向 21- §7，对手 `:1973-1988`）：Media 不只是 resourceType。
   HLS 走 hls.js/MSE 时清单与分片以 XHR/Fetch 到达，resourceType 根本不是 Media；
   只按 resourceType 判会**静默漏拦**。request 阶段没有 Content-Type，所以：
   mime 那几条把 mime 直接喂给 decideRequest（= response 阶段的实际形状），
   扩展名那条不喂 mime（= request 阶段的兜底路径）。 */
check('HLS .m3u8 按 mime 命中 Media（伪装成 XHR，resourceType 不是 Media）',
  decideRequest({ url: 'https://cdn.x.com/v.m3u8', resourceType: 'XHR', mimeType: 'application/vnd.apple.mpegurl' }, vid).reason === 'disable_video');
check('video/* mime 命中 Media（连 resourceType 都是 Document）',
  decideRequest({ url: 'https://x/v', resourceType: 'Document', mimeType: 'video/mp4' }, vid).block === true);
check('Youtube UMP mime 命中 Media（application/vnd.yt-ump，URL 上没扩展名）',
  decideRequest({ url: 'https://rr1---sn-x.googlevideo.com/videoplayback?id=1', resourceType: 'XHR', responseMimeType: 'application/vnd.yt-ump' }, vid).block === true);
check('request 阶段没有 mime：.m3u8 清单 / .ts 分片按扩展名兜底',
  decideRequest({ url: 'https://cdn.x.com/index.m3u8?token=1', resourceType: 'XHR' }, vid).block === true
  && decideRequest({ url: 'https://cdn.x.com/seg-1.ts', resourceType: 'XHR' }, vid).block === true
  && decideRequest({ url: 'https://cdn.x.com/seg-1.m4s', resourceType: 'XHR' }, vid).block === true);
check('扩展名兜底不误伤：.tsx 与查询串里的 .m3u8 都不算',
  decideRequest({ url: 'https://x/app.tsx', resourceType: 'Script' }, vid).block === false
  && decideRequest({ url: 'https://x/v.js?f=.m3u8', resourceType: 'Script' }, vid).block === false);
check('视频开关关着时 mime 也不拦（开关才是总闸，防「配了 mtime 就永远拦」）',
  decideRequest({ url: 'https://x/v', resourceType: 'XHR', mimeType: 'video/mp4' }, compileNetRules({ disable_video: '0' })).block === false);

/* 门 2（逆向 21- §1，对手 `main-v2.9.0.1.pretty.js:454`）：`url_list_user_role_active === "0"`
   时白/黑名单三个字段一律当空串。这条以前是**字段空转**：schema 认字段、判定层不读。 */
check('url_list_user_role_active="0"：compileNetRules 整条不生效（名单 + 视频一起关）',
  compileNetRules({ blacklist: 'a.com', whitelist: 'b.com', disable_video: '1', url_list_user_role_active: '0' }).active === false);
check('url_list_user_role_active 是数字 0 也按同一口径关',
  compileNetRules({ blacklist: 'a.com', url_list_user_role_active: 0 }).active === false);
check('url_list_user_role_active="1" 或不传：名单照旧生效（正例，防门写反成假绿）',
  compileNetRules({ blacklist: 'a.com', url_list_user_role_active: '1' }).active === true
  && compileNetRules({ blacklist: 'a.com' }).active === true
  && block('https://a.com/x', 'Document', compileNetRules({ blacklist: 'a.com', url_list_user_role_active: '1' })).reason === 'blacklist');

/* ---------------------------------- 空规则 ---------------------------------- */
const none = compileNetRules({});
check('无规则：active=false、任何请求都放行',
  none.active === false && block('https://a.com/x', 'Document', none).block === false);
check('disable_image 不进 net-rules（它走内核开关，不在这里）',
  compileNetRules({ disable_image: '1' }).active === false);

/* ---------------------------------- 汇总 ---------------------------------- */
const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
