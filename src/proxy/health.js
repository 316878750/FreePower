/**
 * 代理健康检查：单条 + 批量。
 *
 * 探测本身在 `probe.js`（零依赖、fail-closed，别在这里重写一遍）。这里只补三件事：
 *   1) **统一上限**：单条 10s，批量里一条超时不许拖住整批；
 *   2) **错误归类**：超时 / 认证失败 / 连接被拒 / CONNECT 被拒 / DNS / TLS 分开报，
 *      只回一句「失败」等于没报（用户没法判断是代理挂了还是密码错了）；
 *   3) **限并发**：批量默认 3，别一口气把几百条连接怼出去。
 *
 * 只读：本模块不写代理配置、不改环境，成功结果由调用方决定要不要 `rememberProxyCheck`。
 */
import { checkProxy, normalizeProxyConfig, hasProxy } from './probe.js';

export const HEALTH_TIMEOUT_MS = 10000;
export const HEALTH_CONCURRENCY = 3;

/** 失败原因 → 给人看的一句话（界面直接用，别在 UI 里再拼一遍） */
export const FAILURE_LABELS = {
  timeout: '连接超时（10s 内没完成握手或响应）',
  auth: '认证失败（407 或 SOCKS5 用户名密码被拒）',
  connect_refused: '连接被拒（端口没人监听）',
  connect_rejected: '代理拒绝 CONNECT',
  dns: '域名解析失败',
  tls: 'TLS 握手失败',
  config: '配置不完整或类型不支持',
  other: '其它错误',
};

/**
 * 把探测层的错误文本归类。
 * 顺序有讲究：认证的报错里也可能带「连接」，先判认证；超时要早于泛化的连接失败。
 */
export function classifyProxyFailure(error) {
  const s = String(error || '');
  if (!s) return 'other';
  if (/超时|timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(s)) return 'timeout';
  if (/407|认证失败|authentication|Proxy-Authorization/i.test(s)) return 'auth';
  if (/拒绝 CONNECT|CONNECT 被拒绝|statusLine|CONNECT 响应 → HTTP/i.test(s)) return 'connect_rejected';
  // DNS 要先判：探测层的报错是「连接 x 失败：ENOTFOUND」，按字面会被当成「连接被拒」
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(s)) return 'dns';
  if (/ECONNREFUSED|连接 .* 失败/i.test(s)) return 'connect_refused';
  if (/TLS/i.test(s)) return 'tls';
  if (/不支持的代理类型|配置不完整/.test(s)) return 'config';
  return 'other';
}

/** 给批量结果补上人话，UI 直接渲染，不再二次映射 */
function withLabel(r) {
  if (r.ok) return r;
  const kind = r.error_kind || 'other';
  return { ...r, error_kind: kind, error_label: FAILURE_LABELS[kind] || FAILURE_LABELS.other };
}

/**
 * 检查一条代理。
 * @param {object} cfg 代理配置（或已有的 user_proxy_config 形状）
 * @param {{timeoutMs?:number, probe?:Function}} opts probe 可注入，离线测并发/超时用
 */
export async function checkOne(cfg, { timeoutMs = HEALTH_TIMEOUT_MS, probe = checkProxy } = {}) {
  const checked_at = new Date().toISOString();
  const proxy = normalizeProxyConfig(cfg || {});
  if (!hasProxy(proxy)) {
    return withLabel({ ok: false, error_kind: 'config', error: '代理配置不完整（host/port 为空）', latency_ms: 0, checked_at });
  }
  const t0 = Date.now();
  let timer = null;
  try {
    const r = await Promise.race([
      probe(proxy, { timeoutMs }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`检查超时（${timeoutMs}ms）`), { timeout: true })), timeoutMs);
        if (timer.unref) timer.unref();
      }),
    ]);
    if (r && r.ok) {
      return {
        ok: true,
        ip: r.ip || null,
        country: r.country || null,
        countryCode: r.countryCode || null,
        region: r.region || null,
        city: r.city || null,
        timezone: r.timezone || null,
        isp: r.isp || null,
        latency_ms: Date.now() - t0,
        checked_at,
        proxy,
      };
    }
    const error = (r && r.error) || '代理不可用';
    return withLabel({
      ok: false,
      error,
      error_kind: classifyProxyFailure(error),
      latency_ms: Date.now() - t0,
      checked_at,
      proxy,
    });
  } catch (e) {
    const error = String((e && e.message) || e);
    return withLabel({
      ok: false,
      error,
      error_kind: e && e.timeout ? 'timeout' : classifyProxyFailure(error),
      latency_ms: Date.now() - t0,
      checked_at,
      proxy,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 批量检查（限并发）。
 * @param {Array<{proxy_id?:string, proxy?:object}>|object[]} items
 */
export async function checkMany(items, {
  concurrency = HEALTH_CONCURRENCY,
  timeoutMs = HEALTH_TIMEOUT_MS,
  probe = checkProxy,
} = {}) {
  const list = Array.isArray(items) ? items : [];
  const requested = Math.min(Math.max(1, Number(concurrency) || HEALTH_CONCURRENCY), 10);
  const limit = Math.min(requested, Math.max(list.length, 1));
  const results = new Array(list.length);
  const t0 = Date.now();
  let cursor = 0;

  // 固定 N 个 worker 抢队头：并发上限是**同时进行的探测数**，不是「分批 sleep」
  const runners = Array.from({ length: limit }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= list.length) return;
      const item = list[i] || {};
      const cfg = item.proxy || item;
      const r = await checkOne(cfg, { timeoutMs, probe });
      results[i] = { ...r, index: i, proxy_id: item.proxy_id ?? cfg.proxy_id ?? null };
    }
  });
  await Promise.all(runners);

  const ok = results.filter((r) => r && r.ok).length;
  return {
    list: results,
    total: results.length,
    ok,
    fail: results.length - ok,
    concurrency: limit,
    /** 配置的并发上限（条数比上限少时，实际只会开条数那么多） */
    concurrency_limit: requested,
    timeout_ms: timeoutMs,
    elapsed_ms: Date.now() - t0,
  };
}
