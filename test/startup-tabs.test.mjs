/**
 * 启动标签的 B 层判据：**新环境只开一张页**（真内核）。
 *
 * 缺陷（2026-11-14 用户/CEO 都实测确认）：不带 URL 启动内核时 Chrome 会自己开一张
 * `chrome://newtab`，我们原来又按 open_urls 新建一张 `about:blank` → 新环境开出来**两张白屏**。
 * 对照组：系统 Chrome 同一套参数只开 1 个 page 目标。
 *
 * 修法：复用启动时那张空白页当第一个标签（装配 → 导航），open_urls 有 N 条就只再新开 N-1 张。
 * **不许改成命令行传 URL**：那样首个文档早于注入脚本注册，首帧是原始指纹。
 *
 * CEO 要的四条读数，这里逐条断言：
 *   ① open_urls 空 → page 目标数 = 1
 *   ② open_urls 两条 → page 目标数 = 2
 *   ③ 目标列表里 chrome://newtab = 0 条
 *   ④ 那张页注入完成标记是 object、且指纹值确实是这个环境的（种子快照取自本环境 fp_seed）
 * 另加两条：复用的那张页只向服务器请求**一次**（证明没有为了补注入再导航一次）、
 *          第二个网址确实在自己的标签里。
 *
 * 跑法：npm run test:startup-tabs（起 2 个真环境，约 25 秒）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dataDir = path.join(os.tmpdir(), `freepower-startup-${Date.now()}`);
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
process.env.FREEPOWER_EGRESS_TIMEOUT = '800';

/** 每个路径被请求了几次：判「这张页加载了几个文档」只看服务器，不看页面自己的 performance */
const hits = new Map();
const srv = http.createServer((req, res) => {
  const p = String(req.url || '/');
  if (!p.startsWith('/favicon')) hits.set(p, (hits.get(p) || 0) + 1);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${p}</title></head>
<body><h1>${p}</h1></body></html>`);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const U = (p) => `http://127.0.0.1:${PORT}${p}`;

const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');
const { markerNames } = await import('../src/kernel/markers.js');
const { fingerprintView } = await import('../src/fingerprint/view.js');

const started = [];
const created = [];

/** 浏览器里所有 page 目标（原样读 CDP，不用我们自己的标签序号表 —— 这里要的就是「有几个」） */
async function pageTargets(id) {
  const inst = manager.getInstance(id);
  const { targetInfos } = await inst.client.send('Target.getTargets');
  return (targetInfos || []).filter((t) => t.type === 'page');
}

async function evalInPage(id, targetId, expression) {
  const inst = manager.getInstance(id);
  const { sessionId } = await inst.client.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    const r = await inst.client.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    return r?.result?.value;
  } finally {
    await inst.client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

try {
  /* ------------------ ① open_urls 空：只许 1 张页、不许有 chrome://newtab ------------------ */
  const pEmpty = profiles.createProfile({ name: `startup-empty-${Date.now()}`, group_id: '0', open_urls: [], remark: '启动标签判据：空' });
  created.push(pEmpty.profile_id);
  const stEmpty = await manager.startProfile(profiles.getProfile(pEmpty.profile_id));
  started.push(pEmpty.profile_id);
  console.log(`环境 A（open_urls 空）= ${pEmpty.profile_id} · 内核 ${stEmpty.real_version}`);
  await sleep(2500);   // blank-reload 那一拍也在 400ms 内，多等一拍确认它没有开出第二张

  const aPages = await pageTargets(pEmpty.profile_id);
  check('① open_urls 空 → 启动后 page 目标只有 1 个', aPages.length === 1,
    JSON.stringify(aPages.map((t) => t.url || '<empty>')));
  check('③ 目标列表里 chrome://newtab = 0 条',
    aPages.filter((t) => String(t.url || '').startsWith('chrome://newtab')).length === 0,
    JSON.stringify(aPages.map((t) => t.url || '<empty>')));

  const mkA = markerNames(fingerprintView(profiles.getProfile(pEmpty.profile_id)).seed);
  const viewA = fingerprintView(profiles.getProfile(pEmpty.profile_id));
  const aProbe = await evalInPage(pEmpty.profile_id, aPages[0].targetId, `JSON.stringify({
    applied: typeof window[${JSON.stringify(mkA.applied)}],
    installed: window[${JSON.stringify(mkA.installed)}] === true,
    realm: window[${JSON.stringify(mkA.realm)}] || null,
    seeds: window[${JSON.stringify(mkA.seeds)}] || null,
    href: location.href,
  })`);
  const aSeen = JSON.parse(String(aProbe || '{}'));
  check('④ 那张页注入完成标记是 object', aSeen.applied === 'object', JSON.stringify(aSeen.applied));
  check('④ 那张页 installed=true 且 realm=page', aSeen.installed === true && aSeen.realm === 'page',
    `installed=${aSeen.installed} realm=${aSeen.realm}`);
  check('④ 指纹值是这个环境的（canvas 种子 = 本环境 fp_seed 派生的那个）',
    aSeen.seeds && String(aSeen.seeds.canvas) === String(viewA.canvas?.seed ?? viewA.canvas ?? ''),
    `页面 ${JSON.stringify(aSeen.seeds)} / 环境 ${JSON.stringify(viewA.canvas)}`);

  /* ------------------ ② open_urls 两条：2 张页、第一条在复用页里、只请求一次 ------------------ */
  const pTwo = profiles.createProfile({
    name: `startup-two-${Date.now()}`, group_id: '0',
    open_urls: [U('/first'), U('/second')], remark: '启动标签判据：两条',
  });
  created.push(pTwo.profile_id);
  const stTwo = await manager.startProfile(profiles.getProfile(pTwo.profile_id));
  started.push(pTwo.profile_id);
  console.log(`环境 B（open_urls 两条）= ${pTwo.profile_id} · 内核 ${stTwo.real_version}`);
  await sleep(3000);

  const bPages = await pageTargets(pTwo.profile_id);
  check('② open_urls 两条 → 启动后 page 目标 2 个', bPages.length === 2,
    JSON.stringify(bPages.map((t) => t.url || '<empty>')));
  check('③ 环境 B 里也没有 chrome://newtab',
    bPages.filter((t) => String(t.url || '').startsWith('chrome://newtab')).length === 0,
    JSON.stringify(bPages.map((t) => t.url || '<empty>')));
  check('第一条网址在自己的标签里', bPages.some((t) => t.url === U('/first')),
    JSON.stringify(bPages.map((t) => t.url || '<empty>')));
  check('第二条网址也在自己的标签里（是**新开**的一张，不是复用页顶上）',
    bPages.some((t) => t.url === U('/second')), JSON.stringify(bPages.map((t) => t.url || '<empty>')));
  check('网页只被请求一次（复用页没有为了补注入再导航一遍）',
    hits.get('/first') === 1 && hits.get('/second') === 1,
    `/first ${hits.get('/first')} 次 / /second ${hits.get('/second')} 次`);

  const mkB = markerNames(fingerprintView(profiles.getProfile(pTwo.profile_id)).seed);
  const firstTarget = bPages.find((t) => t.url === U('/first'));
  const bProbe = firstTarget ? await evalInPage(pTwo.profile_id, firstTarget.targetId, `JSON.stringify({
    applied: typeof window[${JSON.stringify(mkB.applied)}],
    installed: window[${JSON.stringify(mkB.installed)}] === true,
    nav: (performance.getEntriesByType("navigation")[0] || {}).type || "",
  })`) : '';
  const bSeen = JSON.parse(String(bProbe || '{}'));
  check('② 复用页导航到第一条网址后，注入仍然生效（applied 是 object）',
    bSeen.applied === 'object', JSON.stringify(bSeen));
  check('② 复用页的 navigation.type 是 navigate（不是 reload）', bSeen.nav === 'navigate', bSeen.nav);
} catch (e) {
  console.log('异常：', e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : e);
  check('整体跑通（无异常）', false, String(e && e.message));
} finally {
  const withTimeout = (p, ms = 8000) => Promise.race([Promise.resolve(p).catch(() => {}), sleep(ms)]);
  for (const id of started) {
    try { await withTimeout(manager.stopProfile(id)); } catch { /* ignore */ }
  }
  for (const id of created) {
    try { profiles.deleteProfiles([id]); } catch { /* ignore */ }
  }
  try { srv.closeAllConnections?.(); } catch { /* ignore */ }
  try { srv.close(); } catch { /* ignore */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail}/${results.length} 通过`);
process.exit(fail ? 1 : 0);
