/**
 * 「这个环境现在的中继端口是多少」——一张按 profile_id 索引的小表（0.4.7.5）。
 *
 * 为什么需要它：起始页的实测出口探测（src/start/probe.js）原来**直连上游**（带凭据）。
 * 那证明的是「上游活着」，不是「浏览器这条链路通」——用户 2026-11-18 遇到的正是
 * 「中继起来了、探测也说通、浏览器却全是 ERR_SOCKS_CONNECTION_FAILED」。
 * 现在探测改走中继（`socks5://127.0.0.1:<port>`），与浏览器**同一条链路**；
 * 要拿到这个端口，就得有一张环境 → 中继端口的表。
 *
 * 生命周期跟着 runtime 实例走：manager 起中继后 `setRelayPort`，停/失败时 `clearRelayPort`。
 * 表里只有端口，没有凭据（凭据只在上游握手报文里）。
 */
const ports = new Map();

/** 记下这个环境正在用的中继端口（`null` = 清掉） */
export function setRelayPort(profileId, port) {
  const id = String(profileId || '');
  if (!id) return;
  if (Number(port) > 0) ports.set(id, Number(port));
  else ports.delete(id);
}

export function clearRelayPort(profileId) {
  ports.delete(String(profileId || ''));
}

/** 这个环境有没有在跑的中继；没有返回 null */
export function relayPortFor(profileId) {
  return ports.get(String(profileId || '')) || null;
}

/** 判据用：清空整张表 */
export function resetRelayPorts() {
  ports.clear();
}
