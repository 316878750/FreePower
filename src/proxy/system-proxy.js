/**
 * 「上游走本地链」的链地址解析（0.4.7.7）。
 *
 * 为什么要它：AdsPower 在这台机器上的页面流量走 `127.0.0.1:10808`（用户的 v2rayN），
 * 由泰国节点再去连环境代理 —— 本机到环境代理这一段丢 SYN 的路径被绕开了，
 * 而页面出口仍是环境代理的 IP。FreePower 要对齐这个行为，就需要知道「本地链」在哪。
 *
 * 读注册表复用 `chain.js` 的 `readSystemProxy()`（同一份只读实现，别在这里再写一遍）。
 *
 * 取值口径（0.4.7.7，CEO 2026-11-19 实测更正）：
 *   - `socks=` / `socks5=host:port` → 用
 *   - **裸 `host:port` 也当 SOCKS5 候选** —— Windows 惯例裸值是 HTTP，但这台机器上
 *     `ProxyServer = 127.0.0.1:10808` 就是 v2rayN 的 SOCKS 端口（实测可用 SOCKS5）。
 *     裸值是「候选」不是「保证」：真 HTTP 代理会握手失败 → 中继 `chain_fail`+1 退回直连，
 *     不 fail-closed、不拦启动。这条兜底是上面的口径成立的前提，不能删。
 *   - 显式 `http=` / `https=` 条目**不认**（连上去也握不成 SOCKS5）。
 *
 * 分段格式（`http=host:1;https=host:2;socks=host:3`）由 `parseProxyServer` 拆开后按上面顺序挑。
 *
 * 注意与 `chain.js` 的 `resolveChain()` 区分：那是「环境的多级代理开关」，
 * 这里只是给中继找一条本地 SOCKS5 链，两者互不影响。
 */
import { readSystemProxy, parseProxyServer } from './chain.js';

/**
 * 把 `ProxyServer` 的值解析成 SOCKS5 链地址。
 * @param {string} raw 注册表里的 `ProxyServer` 原值
 * @returns {{host:string, port:number, type:string, kind:'socks'|'bare'}|null}
 */
export function parseSocksFromProxyServer(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const { entries } = parseProxyServer(value);
  // 先显式 socks，再裸值；裸值是 HTTP 代理时会握不成，由中继的 chain_fail 兜底退回直连
  const socks = entries.find((e) => e.type === 'socks5');
  if (socks) return { host: socks.host, port: socks.port, type: 'socks5', kind: 'socks' };
  const bare = entries.find((e) => e.bare === true);
  if (bare) return { host: bare.host, port: bare.port, type: 'socks5', kind: 'bare' };
  return null;
}

/**
 * 读 Windows 系统代理里的 SOCKS5 链。
 * @returns {{host:string, port:number, type:string, kind:string}|null} 没有/没开都返回 null
 */
export function readSystemSocksChain() {
  if (process.platform !== 'win32') return null;
  const sys = readSystemProxy();
  if (!sys.proxyEnable) return null;
  return parseSocksFromProxyServer(sys.server);
}

/**
 * 解析链式配置（中继用）。
 *
 * - `FREEPOWER_RELAY_CHAIN=0|off|false` → 关闭（直连）
 * - `FREEPOWER_RELAY_CHAIN=socks5://host:port` / `host:port` → 显式指定
 * - 不设 → 读系统代理（见文件头的取值口径）
 *
 * @returns {{host:string, port:number, source:string, kind?:string}|null}
 */
export function resolveUpstreamChain(env = process.env) {
  const raw = String(env.FREEPOWER_RELAY_CHAIN ?? '').trim();
  if (/^(0|off|false|no)$/i.test(raw)) return null;
  if (raw) {
    // 只认 socks 协议：写成 http:// 的地址不能当 SOCKS 链用（连上去也握手不通）
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^socks5?:\/\//i.test(raw)) return null;
    const m = raw.match(/^(?:socks5?:\/\/)?\[?([^\]/]+?)\]?:(\d+)$/i);
    if (m && Number(m[2]) > 0 && Number(m[2]) < 65536 && !m[1].includes('/')) {
      return { host: m[1], port: Number(m[2]), source: 'env' };
    }
    return null;
  }
  const sys = readSystemSocksChain();
  return sys ? { host: sys.host, port: sys.port, source: 'system', kind: sys.kind } : null;
}
