/**
 * 起始页的**假域名**（0.4.7.3）。
 *
 * 为什么不用 `127.0.0.1`：我们有 `--proxy-bypass-list=<-loopback>`（fail-closed：
 * 内核不许绕过代理直连本机，否则页面能扫本地端口、本地流量也会漏真实 IP）。
 * 起始页恰恰**必须**在代理全挂时还能打开，所以给它一个独立域名单独放行，
 * 而不是把整个 loopback 的口子打开。
 *
 * `.test` 是 RFC 2606 保留域：公网永远解析不到；由 `--host-resolver-rules` 钉到 127.0.0.1。
 * 单独一个零依赖模块：`src/kernel/chrome.js` 也要用它拼启动参数，
 * 不能为了一个常量把 store / db 整条依赖链拖进内核参数模块。
 */
export const START_HOST = 'start.freepower.test';

/** 内核参数里「这个域名走直连」的那一段（实测：`<-loopback>` 不会吃掉显式条目） */
export const START_BYPASS_ENTRY = START_HOST;

/** 把假域名钉到回环：`--host-resolver-rules=MAP start.freepower.test 127.0.0.1` */
export const START_RESOLVER_RULE = `MAP ${START_HOST} 127.0.0.1`;

/**
 * 这个 URL 是不是**我们自己的起始页**（0.4.7.3 起，每个环境第一张可能就是它）。
 *
 * 用途：凡是「挑一张真页面」的启发式（窗口同步、批量显示、截图选页）都要把它跳过 ——
 * 它是我们自己的 UI，不是用户的业务页。不跳过就会「同步起来点哪都没反应」：
 * 受控窗口的同步目标被选成了起始页，点击全落在起始页上（0.4.7.3 第一轮 smoke 实测 7 条红）。
 *
 * 只认 `http://start.freepower.test[:port]/...`（假域名只有我们能解析到），
 * 不做任何「猜」——避免把用户自己的同名路径也误杀。
 */
export function isStartPageUrl(url) {
  const u = String(url || '');
  return u.startsWith(`http://${START_HOST}:`) || u.startsWith(`http://${START_HOST}/`);
}
