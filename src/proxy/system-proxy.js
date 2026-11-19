/**
 * 「上游走本地链」的链地址解析（0.4.7.7）。
 *
 * 为什么要它：AdsPower 在这台机器上的页面流量走 `127.0.0.1:10808`（用户的 v2rayN），
 * 由泰国节点再去连环境代理 —— 本机到环境代理这一段丢 SYN 的路径被绕开了，
 * 而页面出口仍是环境代理的 IP。FreePower 要对齐这个行为，就需要知道「本地链」在哪。
 *
 * 读注册表复用 `chain.js` 的 `readSystemProxy()`（同一份只读实现，别在这里再写一遍）。
 * 只认**显式 SOCKS**（`socks=host:port` / `socks5=host:port`）：
 * 系统代理写的是 HTTP 代理时不能当 SOCKS 用，宁可返回 null 走直连。
 *
 * 注意与 `chain.js` 的 `resolveChain()` 区分：那是「环境的多级代理开关」，
 * 这里只是给中继找一条本地 SOCKS5 链，两者互不影响。
 */
import { readSystemProxy, parseProxyServer } from './chain.js';

/** 把 `ProxyServer` 的值解析成 `{host,port}`；不是显式 socks 就返回 null */
export function parseSocksFromProxyServer(raw) {
  const { entries } = parseProxyServer(String(raw || ''));
  const socks = entries.find((e) => e.type === 'socks5');
  return socks ? { host: socks.host, port: socks.port, type: 'socks5' } : null;
}

/**
 * 读 Windows 系统代理里的 SOCKS5 链。
 * @returns {{host:string, port:number, type:string}|null} 没有/没开/不是 socks 都返回 null
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
 * - `FREEPOWER_RELAY_CHAIN=socks5://host:port` → 显式指定
 * - 不设 → 读系统代理；系统代理是显式 SOCKS 才走链，否则直连
 *
 * @returns {{host:string, port:number, source:string}|null}
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
  return sys ? { ...sys, source: 'system' } : null;
}
