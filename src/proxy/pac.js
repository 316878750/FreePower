/**
 * PAC 支持策略：**明确拒绝，不静默降级。**
 *
 * 为什么不做：PAC 脚本里可以写 `DIRECT` / `PROXY a; DIRECT`，我们无法在启动前证明
 * 「所有流量都走代理」。默默忽略 PAC 或退化成直连，比不支持更危险 —— 用户会以为
 * 自己在代理后面，实际用的是本机 IP。所以配了 PAC 就直接报错，让用户换固定代理。
 */

export function pacInUse(input = {}) {
  const url = input.full_pac_url;
  if (typeof url === 'string' && url.trim()) return `full_pac_url=${url.trim()}`;
  const proxy = input.proxy_config || input.user_proxy_config || {};
  const type = String(proxy.proxy_type || proxy.type || input.proxy_type || '').toLowerCase();
  if (type === 'pac') return 'proxy_type=pac';
  return null;
}

export function pacMessage(hit) {
  return `不支持 PAC（${hit}）：PAC 可能含 DIRECT 回退，无法保证 fail-closed；请改用固定 HTTP / SOCKS5 代理`;
}
