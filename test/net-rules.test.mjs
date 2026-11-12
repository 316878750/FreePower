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
check('白名单：名单内但命中黑名单 → 拦',
  block('https://only.com/a', 'Document', compileNetRules({ whitelist: 'only.com', blacklist: 'only.com' })).reason === 'blacklist');

/* ---------------------------------- 视频 ---------------------------------- */
const vid = compileNetRules({ disable_video: '1' });
check('disable_video：Media 请求被拦', block('https://a.com/v.mp4', 'Media', vid).reason === 'disable_video');
check('disable_video：其它类型不受影响', block('https://a.com/a.js', 'Script', vid).block === false);
check('disable_video=0：不拦（默认关）',
  block('https://a.com/v.mp4', 'Media', compileNetRules({ disable_video: '0' })).block === false);

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
