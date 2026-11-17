/**
 * 起始页的「实测出口」探测 —— **全部在服务进程里做**（0.4.7.3）。
 *
 * 为什么不能在页面里探测：起始页之所以能在代理全挂时打开，是因为它自己**绕过了代理**
 * （`start.freepower.test` 在 `--proxy-bypass-list` 里）。如果让它自己去请求外网，
 * 那一发请求要么走代理（代理挂着 → 永远「检测中」）、要么绕过代理（拿到的是**本机真实 IP**，
 * 恰好是最不能给页面看的东西）。所以页面一个外连请求都不发，读数由这里探好、注入进去。
 *
 * 两条路径：
 *   - 绑了代理 → `checkProxy`（与启动前预检**同一个实现**，带凭据、fail-closed）；
 *   - 没绑代理 → 直连探测（此时浏览器也是直连，两边口径一致）。
 *
 * 结果按环境缓存 15 秒：起始页一打开会请求一次，用户连点「重新检测」不该把出口接口打爆。
 * `force:true` 绕过缓存（那是用户明确要的「再测一次」）。
 */
import { EGRESS_PROBE_URL, PROXY_PROBE_TIMEOUT_MS } from '../config.js';
import { checkProxy, hasProxy, normalizeProxyConfig, parseExitInfo } from '../proxy/probe.js';

const CACHE_TTL_MS = 15000;
/** profileId -> { at:number, result:object } */
const cache = new Map();
/** profileId -> Promise（并发去重：页面刷新与「重新检测」撞一起时只探一次） */
const inflight = new Map();

/** 判据用 */
export function resetStartProbeCache() {
  cache.clear();
  inflight.clear();
}

/** 直连探测（没绑代理时）：与 `checkProxy` 的直连版等价，只是不经过任何 hop */
async function probeDirect({ url = EGRESS_PROBE_URL, timeoutMs = PROXY_PROBE_TIMEOUT_MS } = {}) {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    const text = await res.text();
    if (res.status !== 200) return { ok: false, error: `出口接口返回 HTTP ${res.status}`, latency_ms: Date.now() - t0 };
    const info = parseExitInfo(text, url);
    if (info.error) return { ok: false, error: info.error, latency_ms: Date.now() - t0 };
    if (!info.ip) return { ok: false, error: '出口接口的响应里没有 IP', latency_ms: Date.now() - t0 };
    return { ok: true, ...info, latency_ms: Date.now() - t0 };
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return {
      ok: false,
      error: aborted ? `直连探测超时（${timeoutMs}ms）` : `直连探测失败：${e?.message || e}`,
      latency_ms: Date.now() - t0,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 探一次这个环境的出口。
 * @param {object} profile 库里的环境记录（含 user_proxy_config）
 * @param {{force?:boolean, timeoutMs?:number}} [opt]
 * @returns {Promise<{ok:boolean, ip?:string, country?:string, countryCode?:string, city?:string,
 *   region?:string, timezone?:string, isp?:string, latency_ms:number, at:string,
 *   via:'proxy'|'direct', proxy:{type:string,host:string,port:number,has_auth:boolean}|null,
 *   error?:string}>}
 */
export async function probeStartEgress(profile, { force = false, timeoutMs = PROXY_PROBE_TIMEOUT_MS } = {}) {
  const id = String(profile?.profile_id || profile?.id || '');
  const now = Date.now();
  if (!force) {
    const hit = cache.get(id);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.result;
    const running = inflight.get(id);
    if (running) return running;
  }

  const cfg = profile?.user_proxy_config || profile?.proxy_config || null;
  const bound = hasProxy(cfg);
  const norm = bound ? normalizeProxyConfig(cfg) : null;
  const meta = bound
    ? { type: norm.type, host: norm.host, port: norm.port, has_auth: Boolean(norm.username || norm.password) }
    : null;

  const job = (async () => {
    const t0 = Date.now();
    const raw = bound
      ? await checkProxy(cfg, { url: EGRESS_PROBE_URL, timeoutMs })
      : await probeDirect({ url: EGRESS_PROBE_URL, timeoutMs });
    const result = {
      ok: raw.ok === true,
      ...(raw.ip ? { ip: raw.ip } : {}),
      ...(raw.country ? { country: raw.country } : {}),
      ...(raw.countryCode ? { countryCode: raw.countryCode } : {}),
      ...(raw.city ? { city: raw.city } : {}),
      ...(raw.region ? { region: raw.region } : {}),
      ...(raw.timezone ? { timezone: raw.timezone } : {}),
      ...(raw.isp ? { isp: raw.isp } : {}),
      latency_ms: Number.isFinite(raw.latency_ms) ? raw.latency_ms : Date.now() - t0,
      at: new Date().toISOString(),
      via: bound ? 'proxy' : 'direct',
      proxy: meta,
      ...(raw.ok ? {} : { error: String(raw.error || '出口探测失败').slice(0, 400) }),
    };
    cache.set(id, { at: Date.now(), result });
    return result;
  })().finally(() => { inflight.delete(id); });

  inflight.set(id, job);
  return job;
}
