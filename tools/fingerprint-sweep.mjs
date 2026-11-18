#!/usr/bin/env node
/**
 * 43 环境全量指纹扫描（0.4.7.5 之后给 CEO 用的运维脚本）
 *
 * 口径（CEO 2026-11-18 18:22 定）：
 *   1. **逐个串行**：开一个 → 测两个站 → 关掉 → 下一个；同一时刻只允许一个环境在跑；
 *   2. 每站最多等 45s，读 title + 正文前 80 字 + 是否 chrome-error + 耗时；
 *   3. 环境清单 = `.tmp/db-1118/freepower.db`（用户库副本，只读）里、`.tmp/proxy-sweep.json`
 *      中 `tcp.ok` 的 43 个健康代理环境；
 *   4. 输出 JSON + Markdown 表；失败归类只分 `代理` / `中继` / `指纹`，判不了写 `我核不了`；
 *   5. 单个失败不中断；最后汇总过 / 不过 / 各原因计数；
 *   6. 每个环境跑完用 `browser/local-active` + pid 双重确认真的退了。
 *
 * 用法（在仓库根目录）：
 *   node --no-warnings tools/fingerprint-sweep.mjs                 # 跑全部 43 个
 *   node --no-warnings tools/fingerprint-sweep.mjs --limit 3       # 只跑前 3 个（自测用）
 *   node --no-warnings tools/fingerprint-sweep.mjs --skip 10053,10054
 *   node --no-warnings tools/fingerprint-sweep.mjs --only 10053,10054,10056
 *
 * 参数：
 *   --limit N        只跑前 N 个（过滤后）
 *   --skip a,b,c     跳过这些环境（profile_no 或 uuid，逗号分隔，可重复）
 *   --only a,b,c     只跑这些环境（同上）
 *   --db <path>      环境库副本，默认 `.tmp/db-1118/freepower.db`
 *   --sweep <path>   健康代理清单，默认 `.tmp/proxy-sweep.json`
 *   --out <dir>      输出目录，默认 `.tmp/fingerprint-sweep/<时间戳>/`
 *   --wait <ms>      每站等待上限，默认 45000
 *   --keep           跑完保留临时数据目录（排障用；默认删除）
 *
 * 重要：
 *   - **单发判别器**（0.4.7.5 19:45）：每个环境启动前先直连上游探**一次**（不并发、不经中继），
 *     归类以它为准 —— 单发通而产品里不通，绝不归「代理」（今天三个环境就是这么被误判的）；
 *   - 只读用户库副本，**不碰** `%APPDATA%\FreePower`；所有运行数据落在 `.tmp/sweep-data-*`；
 *   - 凭据只用于建立代理，不打印、不写进 JSON / Markdown（表里只有 host:port）；
 *   - 需要完整权限（沙箱会挡 Chrome 命名管道，内核起不来）。
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowStamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
/** ISO（UTC）→ 本机时区可读时间；JSON 里保留 ISO，表格给人看 */
const fmtLocal = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/* ------------------------------ 参数 ------------------------------ */
function parseArgs(argv) {
  const out = { limit: 0, skip: [], only: [], db: null, sweep: null, out: null, wait: 45000, keep: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--limit') out.limit = Math.max(0, Number(next()) || 0);
    else if (a === '--skip') out.skip.push(...String(next() || '').split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--only') out.only.push(...String(next() || '').split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--db') out.db = next();
    else if (a === '--sweep') out.sweep = next();
    else if (a === '--out') out.out = next();
    else if (a === '--wait') out.wait = Math.max(5000, Number(next()) || 45000);
    else if (a === '--keep') out.keep = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`不认识的参数：${a}`);
  }
  return out;
}

const USAGE = `用法：node --no-warnings tools/fingerprint-sweep.mjs [--limit N] [--skip a,b] [--only a,b] [--db path] [--sweep path] [--out dir] [--wait ms] [--keep]`;

const SITES = [
  { key: 'xpoints', label: '站1 defi.xstocks.fi/points', url: 'https://defi.xstocks.fi/points', titleIncludes: 'xPoints' },
  { key: 'startale', label: '站2 app.startale.com', url: 'https://app.startale.com/', titleIncludes: 'Startale' },
];

/**
 * 风控 / 验证码 / 拦截页关键词。只认**页面正文**里的明确字眼；
 * 命中就归「指纹」（页面通了但被拦），不命中不猜。
 */
const BLOCK_RE = /captcha|verify (?:that )?you are (?:a )?human|checking your browser|just a moment|attention required|access denied|cloudflare|人机验证|验证码|安全验证|滑动验证|访问被拒绝|访问被拒/i;

/* ------------------------------ 小工具 ------------------------------ */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function body80(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** 站点结果的一句话标签（Markdown 单元格用） */
function siteCell(site) {
  if (!site) return '未测';
  const secs = (site.ms / 1000).toFixed(1);
  return `${site.label} ${secs}s`;
}

/* ------------------------------ 主流程 ------------------------------ */
const args = parseArgs(process.argv.slice(2));
if (args.help) { console.log(USAGE); process.exit(0); }

const dbSrc = args.db
  ? path.resolve(ROOT, args.db)
  : [path.join(ROOT, '.tmp/db-1118/freepower.db'), path.join(ROOT, '..', '.tmp/db-1118/freepower.db')].find((p) => fs.existsSync(p))
    || path.join(ROOT, '.tmp/db-1118/freepower.db');
const sweepSrc = args.sweep
  ? path.resolve(ROOT, args.sweep)
  : [path.join(ROOT, '.tmp/proxy-sweep.json'), path.join(ROOT, '..', '.tmp/proxy-sweep.json')].find((p) => fs.existsSync(p))
    || path.join(ROOT, '.tmp/proxy-sweep.json');
for (const p of [dbSrc, sweepSrc]) {
  if (!fs.existsSync(p)) { console.error(`找不到文件：${p}`); process.exit(2); }
}

/* 1. 健康代理清单 + 环境库副本（只读） */
const sweep = JSON.parse(fs.readFileSync(sweepSrc, 'utf8'));
const healthy = (Array.isArray(sweep) ? sweep : []).filter((s) => s && s.tcp && s.tcp.ok !== false);
const db = new DatabaseSync(dbSrc, { readOnly: true });
const rows = db.prepare('select id, name, profile_no, user_proxy_config, open_urls from profiles').all();
db.close();
const byNo = new Map(rows.map((r) => [String(r.profile_no), r]));

const wanted = (v) => args.only.length === 0 || args.only.includes(String(v));
const skipped = (v) => args.skip.includes(String(v));

let entries = healthy
  .map((s) => {
    const r = byNo.get(String(s.no));
    /** 库里那份代理配置（含凭据，只留在内存里；打印只出 host:port） */
    let cfg = null;
    try { cfg = r?.user_proxy_config ? JSON.parse(r.user_proxy_config) : null; } catch { cfg = null; }
    return {
      no: s.no,
      id: r?.id || null,
      name: r?.name || s.name || `no-${s.no}`,
      host: s.host,
      port: Number(s.port),
      type: s.type || 'socks5',
      expectIp: s.expectIp || s.egress || null,
      cfg,
      open_urls: r?.open_urls || null,
      in_db: Boolean(r),
    };
  })
  .filter((e) => wanted(e.no) || (e.id && wanted(e.id)))
  .filter((e) => !skipped(e.no) && !(e.id && skipped(e.id)));
if (args.limit > 0) entries = entries.slice(0, args.limit);
if (!entries.length) { console.error('没有可跑的环境（检查 --only / --skip / 清单）'); process.exit(2); }

const missingInDb = entries.filter((e) => !e.in_db);
console.log(`环境库 ${dbSrc}`);
console.log(`健康代理清单 ${sweepSrc}：${healthy.length} 个；本次跑 ${entries.length} 个${missingInDb.length ? `（其中 ${missingInDb.length} 个在库里找不到，直接记「我核不了」）` : ''}\n`);

/* 2. 一次性数据根：复制库副本，绝不碰用户真实数据 */
const DATA = path.join(ROOT, '.tmp', `sweep-data-${process.pid}-${Date.now()}`);
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.copyFileSync(dbSrc, path.join(DATA, 'freepower.db'));
process.env.FREEPOWER_DATA = DATA;
process.env.FREEPOWER_SELFCHECK = '0';

const { createApiServer } = await import('../src/api/server.js');
const { CdpClient } = await import('../src/kernel/cdp.js');
const { setStartPagePort } = await import('../src/start/page.js');
const manager = await import('../src/runtime/manager.js');
/** 单发判别器（0.4.7.5 19:45）：产品里不通 ≠ 代理不通，必须先单发探一次再归类 */
const { checkProxy, isHardProxyFailure } = await import('../src/proxy/probe.js');

const { server, apiKey } = createApiServer();
const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
setStartPagePort(port);
const base = `http://127.0.0.1:${port}`;

async function api(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', api_key: apiKey, 'x-freepower-client': 'mcp' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

async function localActive() {
  const r = await api('GET', '/api/v2/browser-profile/local-active');
  return Array.isArray(r.json?.data?.list) ? r.json.data.list : [];
}

/** 起下一个之前必须保证一个都没在跑；有残留就停掉、再不行强杀 */
async function ensureIdle() {
  let list = await localActive();
  if (!list.length) return { ok: true, killed: [] };
  await api('POST', '/api/v2/browser-profile/stop-all', {}).catch(() => {});
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    list = await localActive();
    if (!list.length) return { ok: true, killed: [] };
  }
  const killed = [];
  for (const it of list) {
    if (it.pid) { try { process.kill(it.pid); killed.push(it.pid); } catch { /* 已退 */ } }
  }
  await sleep(1500);
  return { ok: (await localActive()).length === 0, killed };
}

/** 跑完一个环境：local-active 里没了 + pid 真的退了，两条都满足才算退干净 */
async function waitGone(id, pid, timeoutMs = 20000) {
  const t0 = Date.now();
  let gone = false;
  let pidDead = !pid;
  while (Date.now() - t0 < timeoutMs) {
    const list = await localActive();
    gone = !list.some((x) => String(x.profile_id) === String(id));
    pidDead = !pid || !alive(pid);
    if (gone && pidDead) break;
    await sleep(500);
  }
  return { gone, pid_dead: pidDead, waited_ms: Date.now() - t0 };
}

/* 3. CDP 小工具（与 test/smoke.mjs 同一套用法） */
/**
 * 每个 CDP 调用都要有上限：页面在等代理超时时，`Runtime.evaluate` / `Page.navigate`
 * 会一直不返回，把「每站 45s」撑成 60s+（2026-11-18 自测踩到：实测 62.3s）。
 * 超时只放弃这一次调用，下一次轮询继续读。
 */
function withTimeout(p, ms, label) {
  p.catch(() => { /* 被放弃的调用，别让 rejection 变成 unhandled */ });
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)),
  ]);
}

async function connectCdp(wsUrl) {
  let last = null;
  for (let i = 0; i < 20; i += 1) {
    try { return await CdpClient.connect(wsUrl); } catch (e) { last = e; await sleep(500); }
  }
  throw last || new Error('CDP 连不上');
}

async function pageTargets(c) {
  const r = await withTimeout(c.send('Target.getTargets'), 5000, 'Target.getTargets').catch(() => null);
  return (r?.targetInfos || []).filter((t) => t.type === 'page');
}

async function readPage(c, targetId, sessionId, perCallMs = 5000) {
  const expr = `JSON.stringify({
    href: location.href,
    title: document.title,
    ready: document.readyState,
    body: (document.body ? document.body.innerText : ''),
  })`;
  const attempts = perCallMs >= 4000 ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const r = await withTimeout(
      c.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId),
      Math.max(300, perCallMs),
      'Runtime.evaluate',
    ).catch(() => null);
    if (r?.result?.value) {
      try { return JSON.parse(String(r.result.value)) || {}; } catch { /* 重试 */ }
    }
    await sleep(250);
  }
  return {};
}

async function probeSite(c, targetId, sessionId, site, waitMs) {
  const t0 = Date.now();
  let cancelled = false;
  let snap = {};
  let timedOut = true;

  // 用「一个到点就结束的计时器」和轮询赛跑：轮询里的 sleep 会被事件循环拖慢，
  // 单靠 while (Date.now() < deadline) 实测会等到 46.9s / 52s（自测踩到），
  // 赛跑才能保证「每站最多等 45s」是硬上限。
  const deadline = new Promise((resolve) => { setTimeout(() => resolve('deadline'), waitMs); });
  let navMs = 0;
  const work = (async () => {
    await withTimeout(c.send('Page.enable', {}, sessionId), 3000, 'Page.enable').catch(() => {});
    if (cancelled) return 'cancelled';
    const navStart = Date.now();
    await withTimeout(c.send('Page.navigate', { url: site.url }, sessionId), 5000, 'Page.navigate').catch(() => {});
    navMs = Date.now() - navStart;
    while (!cancelled) {
      await sleep(1000);
      if (cancelled) return 'cancelled';
      snap = await readPage(c, targetId, sessionId, 5000);
      // 先看预算再看结果：到点之后才 complete 的，按「超时」记（不把 45s 撑成 50s）
      if (Date.now() - t0 >= waitMs) return 'deadline';
      if (snap.ready === 'complete' && snap.href && !String(snap.href).startsWith('about:')) return 'done';
    }
    return 'cancelled';
  })().catch(() => 'error');

  const winner = await Promise.race([work, deadline]);
  cancelled = true;
  // 「耗时」= 到页面 complete（或到 45s 上限）为止；之后读最终正文的 1.2s 不算进去，
  // 否则 44.9s 完成 + 1.2s settle + 一次读会把 45s 的读数写成 50s（自测踩到过）。
  const readyMs = Date.now() - t0;
  if (winner === 'done') {
    timedOut = false;
    await sleep(1200); // 给前端渲染留一点时间，再读最终态
    const again = await readPage(c, targetId, sessionId, 1500);
    if (again.href) snap = again;
  }
  const rec = {
    url: site.url,
    ms: readyMs,
    timeout: timedOut,
    winner,
    nav_ms: navMs,
    href: snap.href ?? null,
    title: snap.title ?? null,
    chrome_error: String(snap.href || '').startsWith('chrome-error://'),
    body80: body80(snap.body),
    body_len: String(snap.body || '').replace(/\s+/g, ' ').trim().length,
  };
  // 归类：chrome-error / 超时不算「被拦」；命中关键词或标题不符才算「指纹」候选
  const m = rec.chrome_error ? null : BLOCK_RE.exec(String(snap.body || ''));
  if (rec.chrome_error) { rec.label = 'chrome-error'; rec.blocked = null; }
  else if (rec.timeout) { rec.label = '超时'; rec.blocked = null; }
  else if (!rec.href || rec.href.startsWith('about:')) { rec.label = '没打开'; rec.blocked = null; }
  else if (m) { rec.label = `被拦(${m[0].slice(0, 16)})`; rec.blocked = '被拦'; }
  else if (site.titleIncludes && !String(rec.title || '').includes(site.titleIncludes)) { rec.label = '标题不符'; rec.blocked = '标题不符'; }
  else if (rec.body_len < 20) { rec.label = '正文为空'; rec.blocked = null; }
  else { rec.label = '过'; rec.blocked = null; }
  return rec;
}

/* 4. 失败归类（单发判别器 + 三类 + 我核不了；不猜）
 *
 * 0.4.7.5 19:45 的教训：**产品里打不开 ≠ 代理不通**。当时 3 个环境全被我归成「代理」，
 * 而 CEO 单发探同一台代理 649ms / 748ms 就通 —— 真因是中继把槽位占死了（max_dial_ms=60015）。
 * 所以归类必须以「单发 TCP/checkProxy 通不通」为判别器：
 *   - 单发都不通且是 TCP/认证失败 → `代理`
 *   - 单发都不通但只是探测源不可用（软失败）→ `我核不了`（判不了代理好坏）
 *   - 单发通、产品里不通 → **不许归代理**：有中继证据归 `中继`，否则归 `产品`
 */
function verdictOf(run) {
  const single = run.single;
  if (single && single.ok === false) {
    return isHardProxyFailure(single.kind) ? '代理' : '我核不了';
  }
  if (run.start_error) return '产品';
  const st = run.relay || {};
  const q = Number(st.queue_timeout) || 0;
  const d = Number(st.dial_timeout) || 0;
  const conn = Number(st.connections) || 0;
  const tun = Number(st.tunnels) || 0;
  if ((q > 0 || d > 0) && tun < conn / 2) return '中继';
  if (run.sites.length === SITES.length && run.sites.every((s) => s.label === '过')) return '过';
  if (run.sites.some((s) => s.blocked)) return '指纹';
  // 页面有内容但标题不符（改版/被换页）：算指纹类，不算「核不了」
  if (run.sites.some((s) => !s.chrome_error && String(s.body || '').trim())) return '指纹';
  return '产品';
}

function noteOf(run, verdict) {
  if (verdict === '过') return '';
  const one = run.single
    ? `单发 ${run.single.ok ? '通' : '不通'} ${run.single.latency_ms || 0}ms${run.single.ok ? ` 出口 ${run.single.ip || '?'}` : `（${run.single.kind || '?'}）`}`
    : '单发未跑';
  if (run.start_error) return `启动失败：${String(run.start_error).replace(/\s+/g, ' ').slice(0, 90)}；${one}`;
  if (verdict === '代理') {
    return `${one}；${String(run.single?.error || run.proxy?.error || run.egress?.error || '').slice(0, 60)}`;
  }
  if (verdict === '中继') {
    const st = run.relay || {};
    return `${one}；queue_timeout=${st.queue_timeout || 0} dial_timeout=${st.dial_timeout || 0} tunnels=${st.tunnels || 0}/${st.connections || 0}`;
  }
  if (verdict === '指纹') {
    const bad = run.sites.find((s) => s.blocked) || run.sites.find((s) => s.label !== '过');
    return `${one}；${bad ? `${bad.label}（${bad.title || '无标题'}）` : ''}`;
  }
  if (verdict === '产品') {
    const bad = run.sites.filter((s) => s.label !== '过').map((s) => `${s.label}`);
    return `${one}；页面未通过：${bad.join(' / ') || '无站点读数'}`;
  }
  const bad = run.sites.filter((s) => s.label !== '过').map((s) => `${s.label}`);
  return `${one}；未命中三类：${bad.join(' / ') || '无站点读数'}`;
}

/* 5. 输出目录 */
const outDir = path.resolve(ROOT, args.out || path.join('.tmp', 'fingerprint-sweep', nowStamp()));
fs.mkdirSync(outDir, { recursive: true });

/* 6. 逐环境串行 */
const startedAt = new Date().toISOString();
const results = [];
let interrupted = false;
process.on('SIGINT', async () => {
  interrupted = true;
  console.log('\n收到中断，正在停掉运行中的环境…');
  await manager.stopAll().catch(() => {});
  await sleep(1000);
  try { server.close(); } catch { /* ignore */ }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(130);
});

console.log(`串行开始：${entries.length} 个环境，每站最多等 ${(args.wait / 1000).toFixed(0)}s\n`);

for (let i = 0; i < entries.length; i += 1) {
  const e = entries[i];
  const tag = `[${i + 1}/${entries.length}] ${e.name}(${e.no})`;
  const run = {
    index: i + 1,
    profile_no: e.no,
    profile_id: e.id,
    name: e.name,
    proxy: `${e.host}:${e.port}`,
    proxy_type: e.type,
    expect_ip: e.expectIp,
    start_ms: 0,
    start_ok: false,
    start_error: null,
    /** 单发判别（直连上游、不经中继、不并发）—— 归类的第一依据 */
    single: null,
    proxy_check: null,
    egress: null,
    relay: null,
    relay_last_error: null,
    sites: [],
    stop: null,
    total_ms: 0,
    verdict: null,
    note: '',
  };
  const tEnv = Date.now();

  if (!e.id) {
    run.start_error = '环境库副本里没有这个 profile_no';
    run.verdict = '我核不了';
    run.note = run.start_error;
    run.total_ms = Date.now() - tEnv;
    results.push(run);
    console.log(`${tag} 跳过：库里找不到`);
    continue;
  }

  const idle = await ensureIdle();
  if (!idle.ok) {
    run.start_error = '上一个环境的进程没退干净，拒绝并发开下一个';
    run.verdict = '我核不了';
    run.note = run.start_error;
    run.total_ms = Date.now() - tEnv;
    results.push(run);
    console.log(`${tag} 跳过：${run.start_error}`);
    continue;
  }

  let cdp = null;
  try {
    // 单发判别器（0.4.7.5 19:45）：不并发、不经中继，直连上游探**一次**。
    // 产品里不通时用它回答「是代理坏了，还是我们自己坏了」—— 今天就是没这一步，
    // 三个环境全被误判成「代理」，差点把方向定反。
    run.single = null;
    if (e.cfg) {
      const t1 = Date.now();
      try {
        run.single = await checkProxy(e.cfg, { timeoutMs: 30000 });
      } catch (err) {
        run.single = { ok: false, kind: 'tcp', error: err.message, latency_ms: Date.now() - t1 };
      }
      console.log(`${tag} 单发判别：${run.single.ok
        ? `通 ${run.single.latency_ms}ms 出口 ${run.single.ip || '?'}`
        : `不通 ${run.single.kind || '?'} ${String(run.single.error || '').slice(0, 70)}`}`);
    }

    const t0 = Date.now();
    const started = await api('GET', `/api/v2/browser-profile/start?profile_id=${encodeURIComponent(e.id)}`);
    run.start_ms = Date.now() - t0;
    const data = started.json?.data || null;
    if (!data || started.json?.code !== 0) {
      run.start_error = started.json?.msg || `start 失败（HTTP ${started.status}）`;
      run.proxy_check = data?.proxy_check || null;
      throw Object.assign(new Error(run.start_error), { handled: true });
    }
    run.start_ok = true;
    run.pid = data.pid ?? null;
    run.real_version = data.real_version ?? null;
    run.proxy_check = data.proxy || null;
    run.egress = data.egress || null;

    // 等第一张标签（起始页）出来
    cdp = await connectCdp(data.ws.puppeteer);
    let pages = [];
    for (let k = 0; k < 40; k += 1) {
      pages = await pageTargets(cdp);
      if (pages.length) break;
      await sleep(500);
    }
    if (!pages.length) throw new Error('内核起来了但没有 page target');
    const target = pages[0].targetId;
    const attached = await withTimeout(cdp.send('Target.attachToTarget', { targetId: target, flatten: true }), 5000, 'Target.attachToTarget');
    const sessionId = attached.sessionId;
    const first = await readPage(cdp, target, sessionId);
    run.first_tab = { href: first.href ?? null, title: first.title ?? null };

    for (const site of SITES) {
      const rec = await probeSite(cdp, target, sessionId, site, args.wait);
      run.sites.push(rec);
      console.log(`${tag} ${site.url} → ${rec.label} ${(rec.ms / 1000).toFixed(1)}s title=${JSON.stringify(rec.title)}`);
    }

    const inst = manager.getInstance(e.id);
    run.relay = inst?.relay?.stats ? JSON.parse(JSON.stringify(inst.relay.stats)) : null;
    run.relay_last_error = inst?.relay?.lastError ? String(inst.relay.lastError.reason || inst.relay.lastError.message || '') : null;
  } catch (err) {
    if (!run.start_error) run.start_error = err?.message || String(err);
  } finally {
    try { cdp?.close(); } catch { /* ignore */ }
    const stopped = await api('GET', `/api/v2/browser-profile/stop?profile_id=${encodeURIComponent(e.id)}`).catch(() => null);
    if (stopped && stopped.json && stopped.json.code !== 0) {
      // not running 不算错，交给下面的 waitGone 判
    }
    run.stop = await waitGone(e.id, run.pid);
    if (!run.stop.gone || !run.stop.pid_dead) {
      const forced = await ensureIdle();
      run.stop.forced = forced.killed;
      run.stop = { ...run.stop, ...(await waitGone(e.id, run.pid, 8000)) };
    }
  }

  run.total_ms = Date.now() - tEnv;
  run.verdict = verdictOf(run);
  run.note = noteOf(run, run.verdict);
  results.push(run);
  console.log(`${tag} → ${run.verdict}${run.note ? `（${run.note}）` : ''} 用时 ${(run.total_ms / 1000).toFixed(1)}s 退出确认=${run.stop?.gone && run.stop?.pid_dead}\n`);
}

/* 7. 收尾：确认全退，写 JSON + Markdown */
const residual = await localActive();
await manager.stopAll().catch(() => {});
const finishedAt = new Date().toISOString();

const summary = { total: results.length, pass: 0, fail: 0, by_reason: { 代理: 0, 中继: 0, 指纹: 0, 产品: 0, 我核不了: 0 } };
for (const r of results) {
  if (r.verdict === '过') summary.pass += 1;
  else { summary.fail += 1; summary.by_reason[r.verdict] = (summary.by_reason[r.verdict] || 0) + 1; }
}

const out = {
  started_at: startedAt,
  finished_at: finishedAt,
  wait_ms: args.wait,
  sites: SITES.map((s) => ({ key: s.key, url: s.url, title_includes: s.titleIncludes })),
  filters: { only: args.only, skip: args.skip, limit: args.limit },
  summary,
  residual_running: residual.map((x) => ({ profile_id: x.profile_id, pid: x.pid })),
  rows: results,
};
fs.writeFileSync(path.join(outDir, 'sweep.json'), JSON.stringify(out, null, 2), 'utf8');

const md = [];
md.push(`# FreePower 指纹扫描（本机时间 ${fmtLocal(startedAt)} → ${fmtLocal(finishedAt)}）`);
md.push('');
md.push(`- 环境库：\`${dbSrc}\`；健康代理清单：\`${sweepSrc}\``);
md.push(`- 口径：串行、一次一个；每站最多等 ${(args.wait / 1000).toFixed(0)}s；共 ${results.length} 个`);
md.push(`- 汇总：**过 ${summary.pass} / 不过 ${summary.fail}**（代理 ${summary.by_reason['代理'] || 0} · 中继 ${summary.by_reason['中继'] || 0} · 指纹 ${summary.by_reason['指纹'] || 0} · 产品 ${summary.by_reason['产品'] || 0} · 我核不了 ${summary.by_reason['我核不了'] || 0}）`);
md.push(`- 残留运行环境：${residual.length ? residual.map((x) => x.profile_id).join(', ') : '0（全部确认退出）'}`);
md.push('');
md.push('| # | 环境 id | 名字 | 代理 | 单发判别 | 站1 defi.xstocks.fi/points | 站2 app.startale.com | 耗时 | 失败归类 | 备注 |');
md.push('|---|---|---|---|---|---|---|---|---|---|');
for (const r of results) {
  const id = r.profile_id ? `${String(r.profile_id).slice(0, 8)}…` : '-';
  const s1 = r.sites[0] ? siteCell(r.sites[0]) : (r.start_error ? '未测' : '-');
  const s2 = r.sites[1] ? siteCell(r.sites[1]) : (r.start_error ? '未测' : '-');
  const one = r.single
    ? (r.single.ok ? `通 ${r.single.latency_ms}ms` : `不通（${r.single.kind || '?'}）`)
    : '未跑';
  md.push(`| ${r.index} | ${id} | ${r.name} | ${r.proxy} | ${one} | ${s1} | ${s2} | ${(r.total_ms / 1000).toFixed(1)}s | ${r.verdict} | ${r.note || ''} |`);
}
md.push('');
md.push('> 归类口径：**判别器是「单发 checkProxy 通不通」**（不并发、不经中继、只探一次）。'
  + '`代理` = 单发就 TCP 不通 / 握手被拒（认证失败）；单发通而产品里不通 → **不许归代理**：'
  + '`中继` = 中继读数里 `queue_timeout`/`dial_timeout` 且隧道数 < 连接数一半；'
  + '`产品` = 单发通、页面仍打不开且没有中继证据；`指纹` = 页面通了但被拦（验证码/风控页/标题不符）；'
  + '单发不通但只是探测源不可用（软失败）→ `我核不了`，不猜。');
/* 表格带 BOM：Windows 记事本 / Excel / PowerShell 默认编码都能直接读对中文 */
fs.writeFileSync(path.join(outDir, 'sweep.md'), `\uFEFF${md.join('\n')}\n`, 'utf8');

console.log('=== 汇总 ===');
console.log(`过 ${summary.pass} / 不过 ${summary.fail}（代理 ${summary.by_reason['代理'] || 0} / 中继 ${summary.by_reason['中继'] || 0} / 指纹 ${summary.by_reason['指纹'] || 0} / 产品 ${summary.by_reason['产品'] || 0} / 我核不了 ${summary.by_reason['我核不了'] || 0}）`);
console.log(`残留运行环境：${residual.length}`);
console.log(`JSON：${path.join(outDir, 'sweep.json')}`);
console.log(`表格：${path.join(outDir, 'sweep.md')}`);

/* 8. 清理 */
try { server.close(); } catch { /* ignore */ }
await sleep(300);
if (!args.keep) { try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ } }
process.exit(interrupted ? 130 : 0);
