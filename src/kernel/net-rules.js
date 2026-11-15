/**
 * 环境级网络开关：图片 / 视频 / 域名黑白名单
 *
 * 这三个字段（`disable_image`、`disable_video`、`blacklist`、`whitelist`）原来只在
 * schema 里有名字、没有任何生效路径 —— 也就是「配了什么都不会发生」。这里补上真行为，
 * 分工是**故意的**：
 *
 *   - `disable_image` 走内核开关 `--blink-settings=imagesEnabled=false`（见 chrome.js）：
 *     Blink 直接不请求图片，服务器侧连一条请求都看不到，`img.complete` 恒为 false。
 *     不用 CDP 拦，是因为「不请求」比「请求了再拦」更接近用户对「禁用图片」的预期。
 *   - `disable_video` / `blacklist` / `whitelist` 走 CDP `Fetch` 请求拦截（见 manager.js）：
 *     内核没有「不加载视频」的开关，只能按 resourceType 拦；黑/白名单本来就该按请求判。
 *
 * 匹配规则（黑/白名单每一项都按下面三种写法解释，都不区分大小写）：
 *   - `example.com`        → 该域及其子域
 *   - `*.example.com`      → 子域（不含 example.com 本身）
 *   - `http://a.com/p*`    → URL 通配（`*` 任意串），用于按路径放行/拦截
 *   - `host:8080`          → 带端口的精确 host
 *
 * 白名单非空时是**只放行**语义：不在名单里的请求一律拦（含顶层文档），这与「白名单」
 * 三个字的直觉一致。非 http(s) 的 scheme（about: / data: / blob: / chrome:）不参与判定。
 *
 * 白名单与黑名单**互斥、白名单优先**（2026-11-12 按逆向 `21-` §3 改的）：
 * 对手在白名单开关为真时只走白名单分支，环境黑名单的项根本不会进它的 `NetFilters`；
 * 所以「白名单内的域名同时命中黑名单」在对手那边是**放行**。我们之前是「先判白名单、
 * 再判黑名单」，会拦 —— 那不是更严，是**语义不同**，脚本按对手行为写的规则会失效。
 */

/** 字段可能来自 CSV 串、JSON 数组或逗号串 —— 统一成去空、去重的小写数组 */
export function toRuleList(value) {
  let arr = [];
  if (Array.isArray(value)) arr = value;
  else if (typeof value === 'string' && value.trim()) {
    const s = value.trim();
    if (s.startsWith('[')) {
      try { arr = JSON.parse(s); } catch { arr = s.split(','); }
    } else {
      arr = s.split(/[\r\n,]+/);
    }
  }
  const out = [];
  for (const x of arr) {
    const v = String(x ?? '').trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** 把一条规则编译成可复用的判定器（编译一次，逐请求复用） */
export function compileRule(entry) {
  const e = String(entry || '').trim().toLowerCase();
  if (!e) return null;
  if (e.includes('://')) {
    const re = new RegExp(`^${e.split('*').map(escapeRe).join('.*')}$`);
    return (url) => re.test(url.toLowerCase());
  }
  const subOnly = e.startsWith('*.');
  const hostPort = subOnly ? e.slice(2) : e;
  if (hostPort.includes(':')) {
    // 显式端口：host:port 全等（URL 里省略端口时 parseTarget 已补成 80/443）
    return (url, host, port) => `${host}:${port}` === hostPort;
  }
  if (subOnly) return (url, host) => host.endsWith(`.${hostPort}`);
  return (url, host) => host === hostPort || host.endsWith(`.${hostPort}`);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {object} profile 环境记录（扁平字段）
 * @returns {{active:boolean, blockMedia:boolean, blacklist:string[],
 *            whitelist:string[], matchers:{blacklist:Function[], whitelist:Function[]}}}
 */
export function compileNetRules(profile = {}) {
  // 门 2（逆向 `21-` §1，对手 `main-v2.9.0.1.pretty.js:454`）：`url_list_user_role_active === "0"`
  // 表示「团队/风控访问限制」关着，此时白/黑名单三个字段**一律当空串**，配了也不生效。
  // 注意是字符串 `"0"`（字段本身是 enum 串），数字 0 也按同一口径认。
  if (String(profile.url_list_user_role_active) === '0') {
    return { active: false, blockMedia: false, blacklist: [], whitelist: [], matchers: { blacklist: [], whitelist: [] } };
  }
  const blacklist = toRuleList(profile.blacklist);
  const whitelist = toRuleList(profile.whitelist);
  const blockMedia = String(profile.disable_video) === '1';
  return {
    active: blockMedia || blacklist.length > 0 || whitelist.length > 0,
    blockMedia,
    blacklist,
    whitelist,
    matchers: {
      blacklist: blacklist.map(compileRule).filter(Boolean),
      whitelist: whitelist.map(compileRule).filter(Boolean),
    },
  };
}

/** 拆 URL，拿 host/port；解析不了就返回 null（这种请求一律放行，别把内建页拦死） */
export function parseTarget(url) {
  try {
    const u = new URL(String(url));
    if (!/^https?:$/.test(u.protocol)) return null;
    return { href: u.href.toLowerCase(), host: u.hostname.toLowerCase(), port: u.port || (u.protocol === 'https:' ? '443' : '80') };
  } catch {
    return null;
  }
}

/**
 * 一次请求算不算「媒体」（逆向 `21-` §7，对手 `:1973-1988`）：
 * 不只是 `resourceType === 'Media'`，还包括 mime —— `video/*`、HLS 清单
 * `application/vnd.apple.mpegurl`、YouTube 的 `application/vnd.yt-ump`。
 *
 * 为什么要分两种判法：`Fetch.requestPaused` 在 **request 阶段没有 mime**（Content-Type 还没回来），
 * 只有 response 阶段才有。而 HLS 走 hls.js/MSE 时，清单 `.m3u8` 与分片以 `XHR`/`Fetch` 到达，
 * resourceType 根本不是 `Media` —— 只按 resourceType 判就会**静默漏拦**。所以：
 *   - request 阶段：resourceType + URL 扩展名兜底（`.m3u8` 清单、`.ts` / `.m4s` 分片）；
 *   - response 阶段：`responseMimeType` 再判一次（yt-ump 这类伪装成 XHR、URL 上又没扩展名的）。
 */
function isMediaRequest(request, target) {
  if (String(request?.resourceType || '') === 'Media') return true;
  const mt = String(request?.responseMimeType || request?.mimeType || '').toLowerCase();
  if (mt.startsWith('video/') || mt === 'application/vnd.apple.mpegurl' || mt === 'application/vnd.yt-ump') return true;
  const path = String(target?.href || '').replace(/[?#].*$/, '');
  return /\.(m3u8|m4s|ts)$/i.test(path);
}

/**
 * 判定一条被 Fetch 拦下的请求。
 * @param {{url:string, resourceType?:string, method?:string, mimeType?:string, responseMimeType?:string}} request
 *        CDP `Fetch.requestPaused` 的 request 字段（response 阶段另带 mime）
 * @returns {{block:boolean, reason?:string}}
 */
export function decideRequest(request, rules) {
  if (!rules || !rules.active) return { block: false };
  const t = parseTarget(request?.url);
  if (!t) return { block: false };
  if (rules.blockMedia && isMediaRequest(request, t)) {
    return { block: true, reason: 'disable_video' };
  }
  const hit = (list) => list.some((fn) => fn(t.href, t.host, t.port));
  // 白名单模式下**完全不看黑名单**：与对手互斥（见文件头），不要"两个都判、取更严"
  if (rules.matchers.whitelist.length) {
    return hit(rules.matchers.whitelist) ? { block: false } : { block: true, reason: 'not_in_whitelist' };
  }
  if (hit(rules.matchers.blacklist)) return { block: true, reason: 'blacklist' };
  return { block: false };
}
