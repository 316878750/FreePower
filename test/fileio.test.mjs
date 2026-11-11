/**
 * P10 真机验收：环境导入/导出往返、环境复制（种子重生）、cookie 导入/导出。
 *
 * 跑法：npm run test:fileio（约 1–2 分钟；需要真实 Chrome）
 *
 * 断言（每一条都配了「对照」，不拿默认值当证据）：
 *   1. 导出 → 删掉 → 再导入：**逐字段相等**（身份/时间戳除外），且四个噪点哈希也相等
 *      （导入是搬运，不是重建 —— 换台机器导入同一个环境，指纹不能变）。
 *   2. 同一环境**重启一次**，四个哈希必须不变（对照：证明第 3 条里「不同」不是随机噪声）。
 *   3. 复制出来的环境：时区 / UA / 屏幕 / 核数相同，fp_seed 与四个种子全部不同，
 *      **canvas / webgl_image / audio / client_rects 四个哈希都不同**。
 *   4. cookie：导入 2 条 → json / netscape 两种导出对得上 → 停掉环境后导出明确报 800002
 *      （不偷偷起内核）→ 把 netscape 导入另一个运行中的环境，条数/名字/值一致。
 *
 * 收尾：try/finally 里 stop-all + 删环境 + 删数据目录；跑完机器上不应留 chrome。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, '.tmp', `fileio-${Date.now()}`);
fs.mkdirSync(DATA, { recursive: true });
process.env.FREEPOWER_DATA = DATA;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
process.env.FREEPOWER_EGRESS_TIMEOUT = '1000';

const { createApiServer } = await import('../src/api/server.js');
const { CdpClient } = await import('../src/kernel/cdp.js');
const { buildProbeSource } = await import('../src/selfcheck/probe.js');

const { results, check } = (() => {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  };
  return { results, check };
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 一个本地空页：哈希探针要 document.body 和可绘制的 canvas
const web = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>fileio</title><body>fileio</body>');
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${web.address().port}`;

const { server: api, apiKey } = createApiServer();
const apiPort = await new Promise((r) => api.listen(0, '127.0.0.1', () => r(api.address().port)));
const base = `http://127.0.0.1:${apiPort}`;

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', api_key: apiKey, 'x-freepower-client': 'mcp' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

const HASH_KEYS = ['canvas', 'webgl_image', 'audio', 'client_rects'];

/** 起环境 → 连 CDP 开一张注入好的页 → 读四个噪点哈希 + 声明值 */
async function hashOf(startData) {
  const c = await CdpClient.connect(startData.ws.puppeteer);
  try {
    const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
    await c.send('Page.enable', {}, sessionId).catch(() => {});
    // 等注入生效（空白页由产品的补重载兜底）
    for (let i = 0; i < 60; i++) {
      const r = await c.send('Runtime.evaluate', { expression: 'typeof window.__fpApplied', returnByValue: true }, sessionId).catch(() => null);
      if (r?.result?.value === 'object') break;
      await sleep(100);
    }
    await c.send('Page.navigate', { url: origin }, sessionId).catch(() => {});
    await sleep(1200);
    const nav = await c.send('Runtime.evaluate', {
      expression: `({
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ua: navigator.userAgent,
        lang: navigator.language,
        screen: screen.width + '_' + screen.height,
        hc: navigator.hardwareConcurrency,
        applied: typeof window.__fpApplied
      })`,
      returnByValue: true,
    }, sessionId);
    const probe = await c.send('Runtime.evaluate', {
      expression: buildProbeSource(), returnByValue: true, awaitPromise: true,
    }, sessionId);
    const v = probe?.result?.value || {};
    return {
      ...(nav?.result?.value || {}),
      canvas: v.canvas?.hash,
      webgl_image: v.webgl?.image_hash,
      audio: v.audio?.hash,
      client_rects: v.client_rects?.hash,
    };
  } finally {
    c.close();
  }
}

async function startEnv(id) {
  const r = await call('GET', `/api/v2/browser-profile/start?profile_id=${id}`);
  if (r.json.code !== 0) throw new Error(`启动失败：${r.json.code} ${r.json.msg}`);
  return r.json.data;
}
async function stopEnv(id) {
  await call('GET', `/api/v2/browser-profile/stop?profile_id=${id}`).catch(() => {});
}

const created = [];
try {
  /* ---------------- 1) 建源环境 ---------------- */
  const src = (await call('POST', '/api/v2/browser-profile/create', {
    name: 'fileio-src',
    group_id: '0',
    country: 'DE',
    timezone: 'Europe/Berlin',
    language: ['en-US', 'en'],
    page_language: 'en-US',
    screen_resolution: '1920_1080',
    device_scale: 1,
    hardware_concurrency: 8,
  })).json.data;
  created.push(src.profile_id);
  check('建源环境', !!src.profile_id && src.timezone === 'Europe/Berlin', `${src.profile_id} ${src.screen_resolution}`);

  /* ---------------- 2) 导出 ---------------- */
  const expRes = await call('POST', '/api/v2/browser-profile/export', { profile_id: [src.profile_id] });
  const exp = expRes.json.data?.list?.[0] || {};
  check('导出：返回 {list} 且带我们自己的键', expRes.json.code === 0 && exp.profile_id === src.profile_id
    && exp.screen_resolution === '1920_1080' && Array.isArray(exp.launch_args), JSON.stringify({ code: expRes.json.code, keys: Object.keys(exp).length }));

  /* ---------------- 3) 复制（此时源没在跑，copy_cookies 默认关） ---------------- */
  const cpRes = await call('POST', '/api/v2/browser-profile/copy', { profile_id: src.profile_id, name: 'fileio-copy' });
  const cp = cpRes.json.data || {};
  created.push(cp.profile_id);
  check('复制：新环境 + seeds_regenerated', cpRes.json.code === 0 && cp.profile_id && cp.profile_id !== src.profile_id
    && cp.seeds_regenerated === true, JSON.stringify({ code: cpRes.json.code, id: cp.profile_id, seeds: cp.seeds_regenerated }));

  const srcDetail = (await call('GET', `/api/v2/browser-profile/detail?profile_id=${src.profile_id}`)).json.data;
  const cpDetail = (await call('GET', `/api/v2/browser-profile/detail?profile_id=${cp.profile_id}`)).json.data;
  check('复制：时区/屏幕/UA/核数相同（配置复制）',
    cpDetail.timezone === srcDetail.timezone && cpDetail.screen_resolution === srcDetail.screen_resolution
    && cpDetail.ua === srcDetail.ua && cpDetail.hardware_concurrency === srcDetail.hardware_concurrency,
    JSON.stringify({ tz: [srcDetail.timezone, cpDetail.timezone], screen: [srcDetail.screen_resolution, cpDetail.screen_resolution] }));
  check('复制：fp_seed 与四个噪点种子全部不同',
    cpDetail.fp_seed !== srcDetail.fp_seed && ['canvas_id', 'webgl_image_id', 'audio_id', 'client_rects_id']
      .every((k) => cpDetail[k] !== srcDetail[k] && cpDetail[k] !== null),
    JSON.stringify({
      seed: [srcDetail.fp_seed, cpDetail.fp_seed],
      canvas: [srcDetail.canvas_id, cpDetail.canvas_id],
      webgl: [srcDetail.webgl_image_id, cpDetail.webgl_image_id],
      audio: [srcDetail.audio_id, cpDetail.audio_id],
      rects: [srcDetail.client_rects_id, cpDetail.client_rects_id],
    }));

  /* ---------------- 4) 真机哈希：源 → 重启（对照） ---------------- */
  const s1 = await startEnv(src.profile_id);
  const h1 = await hashOf(s1);
  check('源环境注入生效、四个哈希都读得到', h1.applied === 'object'
    && HASH_KEYS.every((k) => typeof h1[k] === 'string' && h1[k].length), JSON.stringify({ applied: h1.applied, ...Object.fromEntries(HASH_KEYS.map((k) => [k, h1[k]])) }));
  await stopEnv(src.profile_id);
  const s2 = await startEnv(src.profile_id);
  const h2 = await hashOf(s2);
  check('对照：同一环境重启后四个哈希不变（种子稳定）',
    HASH_KEYS.every((k) => h1[k] === h2[k]), JSON.stringify(Object.fromEntries(HASH_KEYS.map((k) => [k, [h1[k], h2[k]]]))));
  await stopEnv(src.profile_id);

  /* ---------------- 5) 导出 → 删掉 → 再导入：逐字段 + 哈希 ---------------- */
  await call('POST', '/api/v2/browser-profile/delete', { profile_id: [src.profile_id] });
  created.splice(created.indexOf(src.profile_id), 1);
  const reRes = await call('POST', '/api/v2/browser-profile/import', { list: [exp] });
  const reId = reRes.json.data?.list?.[0]?.profile_id;
  created.push(reId);
  check('往返：删掉后用导出的那份重新导入', reRes.json.code === 0 && reRes.json.imported === 1 && !!reId, JSON.stringify({ code: reRes.json.code, imported: reRes.json.imported, msg: reRes.json.msg }));

  const exp2 = (await call('POST', '/api/v2/browser-profile/export', { profile_id: [reId] })).json.data?.list?.[0] || {};
  const SKIP = new Set(['id', 'profile_id', 'user_id', 'profile_no', 'serial_number', 'created_at', 'updated_at', 'status', 'last_launch_at']);
  const diffs = [];
  for (const k of Object.keys(exp)) {
    if (SKIP.has(k)) continue;
    if (JSON.stringify(exp[k]) !== JSON.stringify(exp2[k])) diffs.push(k);
  }
  check('往返：逐字段相等（身份/时间戳除外）', diffs.length === 0, diffs.length ? `${diffs.length} 个字段不同：${diffs.slice(0, 8).join(',')}` : '0 个字段不同');

  const s3 = await startEnv(reId);
  const h3 = await hashOf(s3);
  check('往返：导入后的四个哈希与原环境一致（搬运不是重建）',
    HASH_KEYS.every((k) => h1[k] === h3[k]), JSON.stringify(Object.fromEntries(HASH_KEYS.map((k) => [k, [h1[k], h3[k]]]))));

  /* ---------------- 6) cookie：导出两种格式 ---------------- */
  const ckIn = await call('POST', '/api/v2/browser-profile/cookie/import', {
    profile_id: reId,
    cookies: [
      { name: 'p10a', value: 'v1', domain: '127.0.0.1', path: '/', secure: false, httpOnly: false, sameSite: 'Lax' },
      { name: 'p10b', value: 'v2', domain: '127.0.0.1', path: '/', secure: false, httpOnly: true, sameSite: 'Lax' },
    ],
  });
  check('cookie 导入：2 条且回读校验通过', ckIn.json.code === 0 && ckIn.json.imported === 2 && ckIn.json.verified === 2,
    JSON.stringify({ imported: ckIn.json.imported, verified: ckIn.json.verified, failed: ckIn.json.failed }));

  const ckJson = (await call('GET', `/api/v2/browser-profile/cookie/export?profile_id=${reId}&format=json`)).json.data;
  const gotNames = (ckJson.cookies || []).filter((c) => c.name.startsWith('p10')).map((c) => `${c.name}=${c.value}`).sort();
  check('cookie 导出 json：两条名字/值都在', gotNames.join(',') === 'p10a=v1,p10b=v2', `${gotNames.join(',')}（共 ${ckJson.count} 条）`);

  const ckNetscape = (await call('GET', `/api/v2/browser-profile/cookie/export?profile_id=${reId}&format=netscape`)).json.data;
  const firstLine = String(ckNetscape.content || '').split(/\r?\n/)[0];
  check('cookie 导出 netscape：首行标识 + tab 分隔 + p10a\\tv1',
    firstLine === '# Netscape HTTP Cookie File' && /\tp10a\tv1(\r?\n|$)/.test(ckNetscape.content),
    firstLine);

  /* ---------------- 7) 没在跑时导出必须报错（门里的 K2a，用真正停掉的环境验） ---------------- */
  await stopEnv(reId);
  const idle = await call('GET', `/api/v2/browser-profile/cookie/export?profile_id=${reId}&format=json`);
  const liveNow = (await call('GET', '/api/v2/browser-profile/local-active')).json.data?.list || [];
  check('cookie 导出：环境没在跑 → 明确报错且没有偷偷起内核',
    idle.json.code !== 0 && /运行/.test(String(idle.json.msg || '')) && !liveNow.some((i) => i.profile_id === reId),
    JSON.stringify({ code: idle.json.code, msg: String(idle.json.msg).slice(0, 60) }));

  /* ---------------- 8) 复制体：真起内核比四个哈希 ---------------- */
  const c1 = await startEnv(cp.profile_id);
  const hc = await hashOf(c1);
  check('复制体注入生效', hc.applied === 'object', String(hc.applied));
  const diff = HASH_KEYS.filter((k) => !h1[k] || !hc[k] || h1[k] !== hc[k]);
  check('复制体：canvas / webgl_image / audio / client_rects 四个哈希都与源不同（种子真重生）',
    diff.length === 4, JSON.stringify(Object.fromEntries(HASH_KEYS.map((k) => [k, [h1[k], hc[k]]]))));
  check('复制体：UA / 时区 / 屏幕 / 核数与源相同',
    hc.ua === h1.ua && hc.tz === h1.tz && hc.screen === h1.screen && hc.hc === h1.hc,
    JSON.stringify({ ua: [h1.ua, hc.ua], tz: [h1.tz, hc.tz], screen: [h1.screen, hc.screen], hc: [h1.hc, hc.hc] }));

  /* ---------------- 9) netscape 导入另一个运行中的环境 ---------------- */
  const ckIn2 = await call('POST', '/api/v2/browser-profile/cookie/import', {
    profile_id: cp.profile_id,
    format: 'netscape',
    content: ckNetscape.content,
  });
  // 源环境的 netscape 里本来就可能有别的 cookie（内核自带的），按导出的条数对账，不写死 2
  check('cookie 导入 netscape：条数与源导出一致且回读校验通过',
    ckIn2.json.code === 0 && ckIn2.json.imported === ckJson.count && ckIn2.json.verified === ckIn2.json.imported,
    JSON.stringify({ imported: ckIn2.json.imported, verified: ckIn2.json.verified, expect: ckJson.count, failed: ckIn2.json.failed }));

  const ckJson2 = (await call('GET', `/api/v2/browser-profile/cookie/export?profile_id=${cp.profile_id}&format=json`)).json.data;
  const got2 = (ckJson2.cookies || []).filter((c) => c.name.startsWith('p10')).map((c) => `${c.name}=${c.value}`).sort();
  check('cookie 跨环境搬运：条数与名字/值一致', got2.join(',') === 'p10a=v1,p10b=v2', `${got2.join(',')}（共 ${ckJson2.count} 条）`);

  await stopEnv(cp.profile_id);
} catch (e) {
  check('脚本跑完没有异常', false, e.stack || String(e));
} finally {
  // 收尾必须做干净：stop-all、删环境、删目录（CEO 这轮的硬要求）
  await call('POST', '/api/v2/browser-profile/stop-all', {}).catch(() => {});
  const ids = created.filter(Boolean);
  if (ids.length) await call('POST', '/api/v2/browser-profile/delete', { profile_id: ids }).catch(() => {});
  try { api.close(); } catch { /* ignore */ }
  web.close();
  // node:sqlite 的连接不关，Windows 上目录删不掉（会留下 .tmp/fileio-* 脏目录）
  try {
    const { getDb } = await import('../src/store/db.js');
    getDb().close?.();
  } catch { /* ignore */ }
  await sleep(600);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 文件被占用就留给下次 */ }
}

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
