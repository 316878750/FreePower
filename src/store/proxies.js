/**
 * 代理列表（proxy-list）本地仓储。
 *
 * 对手的 4 条 proxy-list 路由是云端透传；这里按同样的入参形状自己写，
 * 并且能被环境直接引用：环境上的 `proxy_id` 解析成 user_proxy_config 再启动。
 */
import { getDb } from './db.js';

const TYPES = ['http', 'https', 'socks5', 'ssh'];
const MAX_BATCH = 500;
const MAX_IDS = 100;

function toApi(row) {
  if (!row) return null;
  return {
    proxy_id: String(row.id),
    type: row.proxy_type,
    host: row.host,
    port: Number(row.port),
    user: row.username || '',
    password: row.password || '',
    remark: row.remark || '',
    ipchecker: row.ipchecker || '',
    // 最近一次预检的结果（没检查过就是 null）
    last_ip: row.last_ip || null,
    last_country: row.last_country || null,
    last_region: row.last_region || null,
    last_city: row.last_city || null,
    last_tz: row.last_tz || null,
    checked_at: row.checked_at || null,
    created_at: row.created_at,
  };
}

/** 入参（对手形状）→ 表列；校验文案逐字对齐 07 号清单 */
function normalize(item = {}, { partial = false } = {}) {
  const out = {};
  if (item.type !== undefined || !partial) {
    const t = String(item.type ?? 'http').toLowerCase();
    if (!TYPES.includes(t)) throw new Error('proxy type must be one of http/https/socks5/ssh');
    out.proxy_type = t;
  }
  if (item.host !== undefined || !partial) {
    const host = String(item.host ?? '').trim();
    if (!host) throw new Error('host is required');
    out.host = host;
  }
  if (item.port !== undefined || !partial) {
    if (typeof item.port !== 'number' || Number.isNaN(item.port)) throw new Error('port must be number');
    if (item.port < 0 || item.port > 65535) throw new Error('port must be between 0 and 65535');
    out.port = Math.trunc(item.port);
  }
  if (item.user !== undefined) out.username = String(item.user ?? '');
  if (item.username !== undefined) out.username = String(item.username ?? '');
  if (item.password !== undefined) out.password = String(item.password ?? '');
  if (item.remark !== undefined) out.remark = String(item.remark ?? '');
  if (item.ipchecker !== undefined) out.ipchecker = String(item.ipchecker ?? '');
  if (item.proxy_url !== undefined && !out.host) {
    // proxy_url 形如 http://user:pass@host:port
    try {
      const u = new URL(String(item.proxy_url));
      out.proxy_type = u.protocol.replace(':', '') || out.proxy_type;
      out.host = u.hostname;
      out.port = Number(u.port || 0);
      if (u.username) out.username = decodeURIComponent(u.username);
      if (u.password) out.password = decodeURIComponent(u.password);
    } catch { throw new Error('proxy_url is invalid'); }
  }
  return out;
}

function newId() {
  return 'px_' + Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(8))).toString('hex');
}

export function createProxies(body) {
  if (!Array.isArray(body)) throw new Error('request body must be array');
  if (!body.length) throw new Error('request body must not be empty');
  if (body.length > MAX_BATCH) throw new Error('proxy length must be less than 500');
  const db = getDb();
  const created = [];
  for (const item of body) {
    const rec = normalize(item);
    const id = newId();
    const name = rec.remark || `${rec.host}:${rec.port}`;
    db.prepare(`INSERT INTO proxies (id, name, proxy_type, host, port, username, password, remark, ipchecker, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, name, rec.proxy_type, rec.host, rec.port, rec.username || '', rec.password || '', rec.remark || '', rec.ipchecker || '', new Date().toISOString());
    created.push(toApi(db.prepare('SELECT * FROM proxies WHERE id = ?').get(id)));
  }
  return created;
}

export function updateProxy(body = {}) {
  const id = String(body.proxy_id ?? body.id ?? '');
  if (!id) throw new Error('proxy_id is required');
  const db = getDb();
  const cur = db.prepare('SELECT * FROM proxies WHERE id = ?').get(id);
  if (!cur) return null;
  const rec = normalize(body, { partial: true });
  const next = {
    proxy_type: rec.proxy_type ?? cur.proxy_type,
    host: rec.host ?? cur.host,
    port: rec.port ?? cur.port,
    username: rec.username !== undefined ? rec.username : cur.username,
    password: rec.password !== undefined ? rec.password : cur.password,
    remark: rec.remark !== undefined ? rec.remark : cur.remark,
    ipchecker: rec.ipchecker !== undefined ? rec.ipchecker : cur.ipchecker,
  };
  const name = next.remark || `${next.host}:${next.port}`;
  db.prepare(`UPDATE proxies SET name=?, proxy_type=?, host=?, port=?, username=?, password=?, remark=?, ipchecker=? WHERE id=?`)
    .run(name, next.proxy_type, next.host, next.port, next.username || '', next.password || '', next.remark || '', next.ipchecker || '', id);
  return toApi(db.prepare('SELECT * FROM proxies WHERE id = ?').get(id));
}

export function listProxies({ ids = null, page = 1, limit = 50 } = {}) {
  const db = getDb();
  const where = [];
  const args = [];
  if (Array.isArray(ids) && ids.length) {
    if (ids.length > MAX_IDS) throw new Error('proxy_id length must be less than 100');
    where.push(`id IN (${ids.map(() => '?').join(',')})`);
    args.push(...ids.map(String));
  }
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM proxies ${sqlWhere}`).get(...args).n;
  const size = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * size;
  const rows = db.prepare(`SELECT * FROM proxies ${sqlWhere} ORDER BY created_at ASC LIMIT ? OFFSET ?`).all(...args, size, offset);
  return { list: rows.map(toApi), page: Number(page) || 1, limit: size, total };
}

export function deleteProxies(ids = []) {
  if (ids.length > MAX_IDS) throw new Error('proxy_id length must be less than 100');
  const db = getDb();
  const deleted = [];
  for (const id of ids.map(String)) {
    if (db.prepare('DELETE FROM proxies WHERE id = ?').run(id).changes) deleted.push(id);
  }
  // 引用了被删代理的环境：清空绑定，免得启动时拿不到代理还静默直连
  for (const id of deleted) {
    db.prepare(`UPDATE profiles SET proxy_id = NULL WHERE proxy_id = ?`).run(id);
  }
  return deleted;
}

export function getProxy(id) {
  if (!id) return null;
  return toApi(getDb().prepare('SELECT * FROM proxies WHERE id = ?').get(String(id)));
}

/** 环境引用代理 → 启动用的 user_proxy_config 形状 */
export function proxyConfigOf(proxy) {
  if (!proxy) return null;
  return {
    proxy_soft: 'other',
    proxy_type: proxy.type,
    host: proxy.host,
    port: proxy.port,
    username: proxy.user || '',
    password: proxy.password || '',
    proxy_id: proxy.proxy_id,
  };
}

/** 写入最近一次预检结果（代理列表页展示「这个代理还能用吗」） */
export function rememberProxyCheck(proxyId, r = {}) {
  if (!proxyId || !r) return;
  try {
    getDb().prepare(`UPDATE proxies SET last_ip=?, last_country=?, last_region=?, last_city=?, last_tz=?, checked_at=? WHERE id=?`)
      .run(r.ip || null, r.countryCode || null, r.region || null, r.city || null, r.timezone || null, new Date().toISOString(), String(proxyId));
  } catch { /* 展示用的缓存，失败不影响 */ }
}