/**
 * 网络诊断（0.4.3 ④）：**只读**。
 *
 * 三条纪律（CEO 明确要求，也是「诊断」这个词的底线）：
 *   1. **不改任何配置**：不写库、不写设置、不改代理、不起停内核；
 *   2. **不为了出一份报告去启动内核**：只报「现在在跑什么」，没跑就是没跑；
 *   3. **代理探测不落盘**：走的 `proxy/health.js` 是纯探测（`checkProxy`），
 *      与代理管理页那条会写 `last_check` 的路由不是同一条。
 *
 * 判据（`test/settings-diagnose.test.mjs`）静态扫描本文件：不许出现
 * `setMeta` / `updateProfile` / `startProfile` / `writeFile` / `appendFile` / `rmSync` 之类。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { API_HOST, API_PORT, DATA_DIR, DB_PATH, ROOT } from '../config.js';
import { listRunning } from '../runtime/manager.js';
import { listKernels } from '../kernel/chrome.js';
import { listProfiles } from '../store/profiles.js';
import { checkMany, HEALTH_CONCURRENCY, HEALTH_TIMEOUT_MS } from '../proxy/health.js';
import { hasProxy } from '../proxy/probe.js';
import { apiVerifyEnabled, getStats } from './info.js';

/** 版本号：与桌面壳 `server.js` 用的是同一份 package.json */
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
})();

/** 文件大小；读不到给 null（不是 0 —— 0 会被当成「空文件」） */
function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

/** 路径显示：数据目录之外的路径不打全（诊断页会被截图发给别人） */
function relToData(p) {
  if (!p) return null;
  const abs = path.resolve(String(p));
  const base = path.resolve(DATA_DIR);
  if (abs === base) return '.';
  if (abs.startsWith(base + path.sep)) return path.relative(base, abs);
  return abs;
}

/** 绑在环境上的代理去重（同一 host:port:user 只探测一次，结果回填到所有用它环境） */
function collectBoundProxies(profileIds = null) {
  const want = profileIds ? new Set(profileIds.map(String)) : null;
  const rows = listProfiles({ page: 1, page_size: 500, archived: 'include' }).list || [];
  const map = new Map();
  for (const p of rows) {
    const id = String(p.profile_id ?? p.id ?? '');
    if (want && !want.has(id)) continue;
    const cfg = p.proxy_config;
    if (!hasProxy(cfg)) continue;
    const key = `${String(cfg.proxy_type || 'http').toLowerCase()}|${cfg.host}|${cfg.port}|${cfg.username || ''}`;
    const item = map.get(key) || {
      key,
      proxy: { proxy_type: String(cfg.proxy_type || 'http').toLowerCase(), host: cfg.host, port: Number(cfg.port) },
      has_auth: Boolean(cfg.username || cfg.password),
      // 账号只回打码后的样子：诊断页可能被截图，完整账号也是凭据的一半
      username_masked: cfg.username ? `${String(cfg.username).slice(0, 1)}***` : null,
      profiles: [],
    };
    item.profiles.push({ profile_id: id, profile_no: p.profile_no ?? null, name: p.name ?? '' });
    map.set(key, item);
  }
  return [...map.values()];
}

/**
 * 网络 / 内核 / 监听端口的快照。**纯读**：只 stat、只读内存里的表、不碰内核。
 */
export function networkSnapshot(ctx = {}) {
  const port = Number(ctx.port || ctx?.req?.socket?.localPort || API_PORT);
  let running = [];
  try {
    running = listRunning();
  } catch {
    running = [];
  }
  let installed = [];
  try {
    installed = listKernels({ type: 'chrome' }).map((k) => ({
      kernel: k.kernel,
      source: k._source || null,
      path: relToData(k._path),
    }));
  } catch {
    installed = [];
  }
  let proxies = [];
  try {
    proxies = collectBoundProxies();
  } catch {
    proxies = [];
  }

  const listeners = [
    { kind: 'api', label: '本地 API', host: API_HOST, port },
    ...running.map((r) => ({
      kind: 'cdp',
      label: `环境 CDP（${r.profile_id.slice(0, 8)}）`,
      host: '127.0.0.1',
      port: Number(r.debug_port),
      profile_id: r.profile_id,
    })),
  ];

  const stats = getStats();
  return {
    generated_at: new Date().toISOString(),
    readonly: true,
    service: {
      version: VERSION,
      host: API_HOST,
      port,
      url: `http://${API_HOST}:${port}/`,
      pid: process.pid,
      uptime_seconds: Math.round(process.uptime()),
      started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      node: process.version,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      memory_mb: Math.round(process.memoryUsage().rss / 1048576),
      data_dir: DATA_DIR,
      db: {
        path: DB_PATH,
        bytes: sizeOf(DB_PATH),
        // 只拷 freepower.db 等于没备份：数据在 WAL 里（README 的升级说明也写着这句）
        wal_bytes: sizeOf(`${DB_PATH}-wal`),
      },
      api: {
        verify: apiVerifyEnabled(),
        requests: {
          total: stats.total,
          allowed: stats.allowed,
          rejected: stats.rejected,
          limited: stats.limited,
          open: stats.open,
        },
        started_at: stats.started_at,
        last_at: stats.last_at,
        last_path: stats.last_path,
      },
    },
    kernels: {
      installed,
      running: running.map((r) => ({
        profile_id: r.profile_id,
        pid: r.pid,
        debug_port: Number(r.debug_port),
        real_version: r.real_version || null,
        status: r.status,
        started_at: r.started_at || null,
        proxy: r.proxy || null,
        egress: r.egress ? { ip: r.egress.ip || null, country: r.egress.country || null } : null,
      })),
    },
    listeners,
    proxies: {
      bound_profiles: proxies.reduce((n, x) => n + x.profiles.length, 0),
      distinct: proxies.length,
      list: proxies.map(({ key, ...rest }) => rest),
    },
    notes: [
      '本页只读：不改配置、不写库、不起停内核。',
      '代理探测不落盘（与「代理管理」页那条会记录最近结果的不同）。',
      '端口只列本产品自己的：本地 API + 各运行中环境的 CDP 端口。',
    ],
  };
}

/**
 * 只读代理探测：把当前**绑在环境上**的代理逐个探一遍，按 host:port:user 去重。
 *
 * @param {{profileIds?: string[], timeoutMs?: number, concurrency?: number}} opt
 */
export async function probeBoundProxies({ profileIds = null, timeoutMs, concurrency } = {}) {
  const items = collectBoundProxies(profileIds);
  const t = Math.min(Math.max(Number(timeoutMs) || HEALTH_TIMEOUT_MS, 1000), 30000);
  const c = Math.min(Math.max(Number(concurrency) || HEALTH_CONCURRENCY, 1), 10);
  if (!items.length) {
    return {
      list: [],
      total: 0,
      ok: 0,
      fail: 0,
      timeout_ms: t,
      concurrency: c,
      elapsed_ms: 0,
      readonly: true,
      persisted: false,
      message: '没有绑代理的环境（全部直连），没有可探测的代理',
    };
  }
  const batch = await checkMany(items.map((x) => ({ proxy_id: x.key, proxy: x.proxy })), {
    concurrency: c,
    timeoutMs: t,
  });
  const list = items.map((x, i) => {
    const r = batch.list[i] || {};
    const timedOut = r.error_kind === 'timeout';
    return {
      proxy: x.proxy,
      has_auth: x.has_auth,
      username_masked: x.username_masked,
      profiles: x.profiles,
      ok: Boolean(r.ok),
      outcome: r.ok ? 'ok' : timedOut ? 'timeout' : 'fail',
      ip: r.ip ?? null,
      country: r.country ?? null,
      latency_ms: r.latency_ms ?? 0,
      error_kind: r.ok ? null : (r.error_kind || 'other'),
      error_label: r.ok ? null : (r.error_label || r.error || '代理不可用'),
      checked_at: r.checked_at ?? null,
      timeout_ms: timedOut ? t : null,
      timeout_seconds: timedOut ? Number((t / 1000).toFixed(1)) : null,
    };
  });
  return {
    list,
    total: list.length,
    ok: list.filter((x) => x.ok).length,
    fail: list.filter((x) => !x.ok).length,
    timeout: list.filter((x) => x.outcome === 'timeout').length,
    timeout_ms: t,
    concurrency: batch.concurrency_limit || c,
    elapsed_ms: batch.elapsed_ms,
    readonly: true,
    persisted: false,
  };
}