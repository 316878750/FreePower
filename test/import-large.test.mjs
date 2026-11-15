#!/usr/bin/env node
/**
 * B 层 · 大文件导入真 HTTP 端到端（0.4.4）
 *
 * 出处：用户从 AdsPower 导出的 `profiles_2026_11_15_14_03_44.txt` 报「导入失败」。
 * CEO 复现出两个真缺陷（现场读数）：
 *
 *   缺陷 ①：`MAX_BODY = 2 MB`，超限时 `reject` 先于响应 `destroy()` 连接 —— 客户端拿不到
 *           任何 JSON，界面只显示英文 `Failed to fetch`。整份文件 body 21,157,002 B。
 *           切 3 块（1,145,291 B）就 200、`imported:3` —— 导入逻辑本身没坏，是整份塞不进一个请求。
 *   缺陷 ②：`.txt` 的 `proxytype=socks5` 被 spread 顺序覆盖成 `http`（静默写错、无告警）。
 *           50 个环境全是 socks5，会全部按 http 去连。
 *
 * 这个文件用**合成的 18.9 MB / 50 块**数据复现，走控制台真实那条路：
 *   `splitTxtChunks`（界面用的同一个函数）→ 逐批 POST（带界面的 `x-freepower-client: ui` 头）
 *   → `mergeBatchResults` 汇总。
 *
 * **不使用用户的真实文件**：那份里有 cookie 值和代理密码。这里的 cookie 全是合成的假串。
 *
 * 不需要 Chrome（纯 HTTP + SQLite），几十秒跑完，已进 `npm run smoke`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'freepower-importlarge-'));
process.env.FREEPOWER_DATA = DATA;
process.env.FREEPOWER_SELFCHECK = '0';
// 控制台通道默认 60/s，这里一次导入要发十几发（每批 1 发 + 收尾查询），抬高免得测试自己被挡
process.env.FREEPOWER_RATE_LIMIT_UI = '1000';
delete process.env.FREEPOWER_MAX_BODY;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const { createApiServer } = await import('../src/api/server.js');
const { getDb, closeDb } = await import('../src/store/db.js');
const { splitTxtChunks, mergeBatchResults } = await import('../web/txt-split.js');

const { server, apiKey } = createApiServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

/** 一次真实 HTTP 调用，头和控制台发的一模一样。**不吞网络层异常** —— 要能分辨「连接被掐」和「拿到 413」。 */
async function post(p, body) {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-key': apiKey, 'x-freepower-client': 'ui' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（比如纯文本 CORS ERROR） */ }
  return { status: res.status, json, text };
}

/* ---------------------- 合成 18.9 MB / 50 块（最大 cookie 行 ~50 万字符） ---------------------- */
const SEP = '*'.repeat(18);
const PAD = 'x'.repeat(4000);
function cookieLine(i, n) {
  const arr = [];
  for (let k = 0; k < n; k++) {
    arr.push({
      domain: '.example.com',
      expires: 1793580000,
      httpOnly: k % 2 === 0,
      name: `c${k}`,
      path: '/',
      sameSite: k % 3 === 0 ? 'no_restriction' : 'unspecified',
      secure: true,
      session: true,
      value: `B${i}_${k}_${PAD}`,
    });
  }
  return `cookie=${JSON.stringify(arr)}`;
}
/** 第 50 块故意做大（122 条 × 约 4.1 KB ≈ 50 万字符），对齐用户那份的最大 cookie 行 */
function mkBlock(i) {
  return [
    `acc_id=${10000 + i}`, `id=ads-${i}`, 'group=', `name=big-${i}`, 'remark=', 'platform=example.com',
    'username=', 'password=', 'fakey=', cookieLine(i, i === 50 ? 122 : 110),
    'proxytype=socks5', 'ipchecker=ipapi', `proxy=198.51.100.${(i % 250) + 1}:1080:puser:ppass`,
    'proxyurl=', 'proxyid=', 'ip=203.0.113.7', 'countrycode=US',
    'ua=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    SEP, '',
  ].join('\n');
}
const TEXT = Array.from({ length: 50 }, (_, i) => mkBlock(i + 1)).join('');
const TEXT_BYTES = Buffer.byteLength(TEXT);
const cookieLens = TEXT.split('\n').filter((l) => l.startsWith('cookie=')).map((l) => l.length);
const MAX_COOKIE_LINE = Math.max(...cookieLens);

console.log(`合成文件：${TEXT_BYTES} 字节 / 50 块 / 最大 cookie 行 ${MAX_COOKIE_LINE} 字符`);
check('合成数据量级与用户那份同阶（≥18 MB、恰好 50 块、最大 cookie 行 ≥45 万字符）',
  TEXT_BYTES >= 18 * 1024 * 1024 && cookieLens.length === 50 && MAX_COOKIE_LINE >= 450000,
  `${TEXT_BYTES} B / ${cookieLens.length} 块 / ${MAX_COOKIE_LINE}`);

try {
  /* ---------- A. 复现缺陷 ①：整份一个请求（body 21 MB 级） ---------- */
  const whole = await post('/api/v2/browser-profile/import', { format: 'txt', content: TEXT });
  check('A1 整份 18.9 MB 一个请求能导入（默认上限 64 MB，不再被 2 MB 拦下）',
    whole.status === 200 && whole.json?.code === 0 && whole.json?.data?.imported === 50,
    `HTTP ${whole.status} imported=${whole.json?.data?.imported} failed=${JSON.stringify(whole.json?.data?.failed || [])}`);

  /* ---------- B. 控制台那条分批路：切块 → 顺序发 → 汇总 ---------- */
  const split = splitTxtChunks(TEXT);
  const reqBodies = split.chunks.map((c) => Buffer.byteLength(JSON.stringify({ format: 'txt', content: c.text })));
  console.log(`  切块：${split.chunks.length} 批，每批块数 ${split.chunks.map((c) => c.blocks).join(',')}，`
    + `每批请求体 ${reqBodies.join(',')} B`);
  check('B1 每批请求体都 ≤8 MB（分批阈值生效）', reqBodies.every((b) => b <= 8 * 1024 * 1024),
    reqBodies.join(','));

  const raw = [];
  for (const c of split.chunks) {
    try {
      raw.push(await post('/api/v2/browser-profile/import', { format: 'txt', content: c.text }));
    } catch (e) {
      raw.push({ network_error: e.message });
    }
  }
  const netBad = raw.filter((r) => r.network_error);
  check('B2 每一批都拿到了 HTTP 响应 —— 没有一批是「连接被掐」（这正是用户看到的 Failed to fetch）',
    netBad.length === 0, netBad.length ? netBad.map((r) => r.network_error).join('; ') : `全部 200（${raw.length} 批）`);

  const sum = mergeBatchResults(
    split.chunks,
    raw.map((r) => (r.network_error ? { error: r.network_error } : (r.json?.data || {}))),
  );
  check('B3 50 块全部导入、failed 为空',
    sum.imported === 50 && sum.failed.length === 0,
    `imported=${sum.imported} failed=${JSON.stringify(sum.failed)} 批数=${sum.batches}`);
  check('B4 服务端每批解析出的块数与切块预期一致（块号换算的前提）',
    raw.every((r, i) => !r.network_error && Number(r.json?.data?.blocks) === split.chunks[i].blocks),
    raw.map((r, i) => `${r.json?.data?.blocks}/${split.chunks[i].blocks}`).join(','));

  /* ---------- C. 落库核对：缺陷 ② 端到端 ---------- */
  const db = getDb();
  const rows = db.prepare("SELECT name, user_proxy_config, cookie FROM profiles WHERE name LIKE 'big-%' ORDER BY name").all();
  const px = rows.map((r) => { try { return JSON.parse(r.user_proxy_config || '{}'); } catch { return {}; } });
  const types = [...new Set(px.map((x) => x.proxy_type))];
  check('C1 100 个环境都落库了（整份 50 + 分批 50）', rows.length === 100, String(rows.length));
  check('C2 proxytype=socks5 真的存成 socks5 —— 一条都没有被改成 http（这是缺陷 ② 的端到端判据）',
    types.length === 1 && types[0] === 'socks5', `proxy_type 取值 = ${JSON.stringify(types)}`);
  check('C3 代理 host/port/账号都在（分批没把代理字段切坏）',
    px.every((x) => x.host && Number(x.port) === 1080 && x.username === 'puser' && x.password === 'ppass'),
    JSON.stringify(px[0]));
  let big = 0;
  try { big = JSON.parse(String(rows.find((r) => r.name === 'big-50')?.cookie || '[]')).length; } catch { big = 0; }
  check('C4 最大那块（cookie 行 ~50 万字符）的 122 条 cookie 一条不少',
    big === 122, `${big} 条`);

  /* ---------- D. 超限：必须是 413 + 中文 msg，不是连接被掐 ---------- */
  const bodyBytes = Buffer.byteLength(JSON.stringify({ format: 'txt', content: TEXT }));
  process.env.FREEPOWER_MAX_BODY = String(2 * 1024 * 1024); // 临时复现旧上限
  let over = null;
  let overErr = null;
  try {
    over = await post('/api/v2/browser-profile/import', { format: 'txt', content: TEXT });
  } catch (e) { overErr = e.message; }
  process.env.FREEPOWER_MAX_BODY = '';
  delete process.env.FREEPOWER_MAX_BODY;

  check('D1 超限时客户端**没有**抛网络错误（不是 `fetch failed`）', overErr === null,
    overErr ? `抛了：${overErr}` : '拿到了响应');
  check('D2 超限返回 HTTP 413', over?.status === 413, `HTTP ${over?.status}`);
  check('D3 msg 是中文、带真实字节数与上限、并说清怎么办',
    !!over?.json?.msg && /请求体过大/.test(over.json.msg)
    && over.json.msg.includes(String(bodyBytes)) && over.json.msg.includes(String(2 * 1024 * 1024))
    && /分批/.test(over.json.msg),
    over?.json?.msg || over?.text?.slice(0, 120));
  check('D4 msg 里没有把英文底层报错原样抛给用户',
    !/Failed to fetch|ECONNRESET|socket hang up/i.test(String(over?.json?.msg || '')),
    String(over?.json?.msg || '').slice(0, 60));

  /* ---------- E. 上限可配 ---------- */
  process.env.FREEPOWER_MAX_BODY = String(40 * 1024 * 1024);
  const raised = await post('/api/v2/browser-profile/import', { format: 'txt', content: TEXT });
  delete process.env.FREEPOWER_MAX_BODY;
  check('E1 FREEPOWER_MAX_BODY 调大后同一份文件又能过（上限可配，不是写死）',
    raised.status === 200 && raised.json?.data?.imported === 50,
    `HTTP ${raised.status} imported=${raised.json?.data?.imported}`);
} catch (e) {
  check('大文件导入测试异常', false, e.stack || e.message);
} finally {
  try { server.close(); } catch { /* ignore */ }
  try { closeDb(); } catch { /* ignore */ }
  let cleaned = false;
  for (let i = 0; i < 12; i++) {
    try { fs.rmSync(DATA, { recursive: true, force: true }); cleaned = true; break; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!cleaned) console.log(`临时目录没删净：${DATA}（不影响结论，可手工删）`);
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
