/**
 * 一次性报告票据。
 *
 * 之前 HTML 自检报告的链接是 `?format=html&api_key=<master key>`：本机控制台能接受，
 * 但一旦打包成桌面版，这条带 master key 的地址会留在浏览器历史、下载记录、错误日志里，
 * 一个看日志的旁观者就能拿到整个本地 API 的钥匙。
 *
 * 这里换成一个绑定了 profile 的短期票据（默认 120 秒、只在本进程内存里）：
 * 泄露了也只能在有效期内读那一个环境的报告，且主 key 不再出现在 URL 上。
 * 契约不动：`api_key` 查询参数照旧可用，脚本不受影响。
 */

const TTL_MS = Math.max(10, Number(process.env.FREEPOWER_TICKET_TTL || 120)) * 1000;
const MAX = 200;

/** token -> { profileId, exp } */
const tickets = new Map();

function sweep(now = Date.now()) {
  for (const [k, v] of tickets) if (v.exp <= now) tickets.delete(k);
  // 上限兜底：极端情况下（脚本狂刷）不让内存无限长
  while (tickets.size >= MAX) {
    const oldest = tickets.keys().next();
    if (oldest.done) break;
    tickets.delete(oldest.value);
  }
}

export function issueTicket(profileId) {
  const id = String(profileId || '');
  if (!id) throw new Error('profile_id required');
  sweep();
  const token = `fp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
  const exp = Date.now() + TTL_MS;
  tickets.set(token, { profileId: id, exp });
  return { ticket: token, expires_in: Math.floor(TTL_MS / 1000), profile_id: id };
}

/**
 * 校验票据。票据绑定 profile_id —— 拿 A 的票据读不了 B 的报告。
 * 在有效期内可重复用（用户刷新报告页不该 401）。
 */
export function redeemTicket(token, profileId) {
  const t = String(token || '');
  if (!t) return false;
  const v = tickets.get(t);
  if (!v) return false;
  if (v.exp <= Date.now()) { tickets.delete(t); return false; }
  if (profileId !== undefined && String(profileId) !== v.profileId) return false;
  return true;
}

export function _resetTickets() { tickets.clear(); }