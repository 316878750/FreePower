/**
 * 导航自掐回归（P12）：非 HTML 页面在 FreePower 环境里必须能打开。
 *
 * 真实现象（2026-11-11 实测，安装包 0.3.0）：环境自己那张既有页导航 JSON 端点正常，
 * 但「CDP 新建空白目标 → 导航同一个 URL」拿到 `net::ERR_ABORTED`，页面停在 about:blank；
 * 裸内核（同一份 buildArgs、不注入）全部正常。三种端点（ipify / ipinfo / ip-api）无差别复现。
 *
 * 根因：新建标签的首个文档早于 `Page.addScriptToEvaluateOnNewDocument`，所以要补一次
 * `Page.reload`（否则首帧裸指纹）。旧写法是「400ms 后读 location.href，还是 about:blank 就
 * reload」—— 慢导航在 400ms 时还没 commit，href 仍是 about:blank，于是 reload 把在飞的导航顶掉。
 * example.com 够快所以看起来「只有 JSON 打不开」。
 *
 * 本测试全离线：本地起一个**延迟 800ms 才返回 application/json** 的 http 服务，
 * 不依赖外网、不依赖系统代理。跑法：npm run test:nav-race
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeChecker, finish, sleep } from './helpers/profile-probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { check, results } = makeChecker();

/* ---------- 本地假端点：慢 JSON / 快餐 HTML ---------- */
const EXIT_JSON = {
  ip: '198.51.100.9',
  country: 'United States',
  countryCode: 'US',
  regionName: 'Test Region',
  city: 'Testville',
  timezone: 'UTC',
  isp: 'FreePower Test',
  status: 'success',
  query: '198.51.100.9',
};

let hits = { slow: 0, fast: 0, exit: 0 };
const server = http.createServer((req, res) => {
  const url = String(req.url || '');
  if (url.startsWith('/slow.json')) {
    hits.slow += 1;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(EXIT_JSON));
    }, 800);
    return;
  }
  if (url.startsWith('/exit')) {
    hits.exit += 1;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(EXIT_JSON));
    }, 800);
    return;
  }
  if (url.startsWith('/fast.html')) {
    hits.fast += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>fast</title><body>fast</body>');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('nope');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const SLOW = `${BASE}/slow.json`;
const FAST = `${BASE}/fast.html`;

/* ---------- 起一个真环境（open_urls 直接指向慢 JSON：用户可见面一起测） ---------- */
const DATA = path.join(ROOT, '.tmp', `nav-race-${process.pid}-${Date.now()}`);
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.FREEPOWER_DATA = DATA;
process.env.FREEPOWER_SELFCHECK = '0';
// 出口探测也指向本地慢端点：探测页是「我们自己建/自己关」的那类目标，必须被 watcher 放过
process.env.FREEPOWER_EGRESS_PROBE = `${BASE}/exit`;
process.env.FREEPOWER_EGRESS_TIMEOUT = '8000';

const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');

let profileId = null;
let client = null;
const openTargets = [];

const evalIn = async (sessionId, expression) => {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) return { error: r.exceptionDetails.text || 'exception' };
  return r.result.value;
};

/** 开一张空白目标 + 自己的 session（模拟 puppeteer/外部自动化最常见的开页方式） */
async function openBlankTarget() {
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  openTargets.push(targetId);
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Page.enable', {}, sessionId).catch(() => {});
  return { targetId, sessionId };
}

const navReport = `(() => {
  let navType = null;
  try { navType = performance.getEntriesByType('navigation')[0]?.type ?? null; } catch (e) {}
  return {
    href: location.href,
    text: ((document.body && document.body.textContent) || '').slice(0, 300),
    navType,
    injected: window.__fpInstalled === true,
    readyState: document.readyState,
  };
})()`;

try {
  const created = profiles.createProfile({
    name: `nav-race-${Date.now()}`,
    group_id: '0',
    remark: 'P12 导航自掐回归',
    open_urls: [SLOW],
  });
  profileId = created.profile_id;
  const started = await manager.startProfile(profiles.getProfile(profileId));
  const inst = manager.getInstance(profileId);
  client = inst.client;
  console.log(`  环境 ${profileId} · 内核 ${started.real_version}`);

  check('环境启动成功', Boolean(started?.profile_id || started?.pid), JSON.stringify({
    pid: started?.pid, debug_port: started?.debug_port,
  }));

  /* ---------- ① open_urls 指向慢 JSON（用户可见面） ---------- */
  {
    let page = null;
    for (let i = 0; i < 40 && !page; i++) {
      const t = await client.send('Target.getTargets');
      page = (t.targetInfos || []).find((x) => x.type === 'page' && String(x.url).startsWith(SLOW));
      if (!page) await sleep(250);
    }
    check('open_urls 指向 JSON 时有页面真的落在那个 URL（不是 about:blank）',
      Boolean(page), page ? page.url.slice(0, 60) : '没找到落在 ' + SLOW + ' 的页面');

    if (page) {
      const { sessionId } = await client.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
        .catch(() => ({}));
      if (sessionId) {
        openTargets.push(page.targetId);
        await sleep(400);
        const r = await evalIn(sessionId, navReport);
        console.log(`  open_urls 页：${JSON.stringify({ href: r?.href, navType: r?.navType, injected: r?.injected })}`);
        check('open_urls：location.href 就是那个 JSON 地址', String(r?.href) === SLOW, String(r?.href));
        check('open_urls：能读到 JSON 正文（不是空 body）', /198\.51\.100\.9/.test(String(r?.text)), String(r?.text).slice(0, 80));
        check('open_urls：navigation type 不是 reload（没被我们顶掉重来）', r?.navType !== 'reload', String(r?.navType));
      }
    }
  }

  /* ---------- ② 出口探测页（我们自己建、自己关的那类目标） ---------- */
  {
    const egress = inst.egress || {};
    check('出口探测读到 JSON（探测页没被 blank-reload 掐掉）',
      egress.ok === true && egress.ip === EXIT_JSON.ip,
      JSON.stringify({ ok: egress.ok, ip: egress.ip, error: egress.error, readyState: egress.readyState, finalUrl: egress.finalUrl }));
  }

  /* ---------- ③ CDP 新建空白目标 → 导航慢 JSON（就是那个 ERR_ABORTED 场景） ---------- */
  {
    const { sessionId } = await openBlankTarget();
    await client.send('Page.navigate', { url: SLOW }, sessionId).catch(() => {});
    await sleep(2200);
    const r = await evalIn(sessionId, navReport);
    console.log(`  CDP 空目标 → 慢 JSON：${JSON.stringify({ href: r?.href, navType: r?.navType, injected: r?.injected, readyState: r?.readyState })}`);
    check('CDP 新建目标导航慢 JSON：location.href 落在目标上（不再停在 about:blank）', String(r?.href) === SLOW, String(r?.href));
    check('CDP 新建目标导航慢 JSON：body 能读到 JSON（ERR_ABORTED 已消失）', /198\.51\.100\.9/.test(String(r?.text)), String(r?.text).slice(0, 80));
    check('CDP 新建目标导航慢 JSON：navigation type 不是 reload', r?.navType !== 'reload', String(r?.navType));
    check('CDP 新建目标导航慢 JSON：注入仍然生效（包装函数没丢）', r?.injected === true, String(r?.injected));
  }

  /* ---------- ④ 反面对照：blank-reload 这条功能本身没被删掉 ---------- */
  {
    // 4a. 纯空白页（没人导航）：watcher 必须照旧补一次 reload 让注入生效
    const { targetId, sessionId } = await openBlankTarget();
    await sleep(1500);
    const r = await evalIn(sessionId, '({ href: location.href, injected: window.__fpInstalled === true })');
    check('反面对照：纯空白页仍会被补注入（watcher 没被关掉）', r?.injected === true,
      JSON.stringify({ targetId: String(targetId).slice(0, 8), ...r }));

    // 4b. 快页面：`Target.createTarget({url})` 那条「首文档早于脚本注册 → 补 reload」的用途仍然有效
    const t = await client.send('Target.createTarget', { url: FAST });
    openTargets.push(t.targetId);
    let sess = null;
    for (let i = 0; i < 30 && !sess; i++) {
      const a = await client.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }).catch(() => null);
      sess = a?.sessionId || null;
      if (!sess) await sleep(150);
    }
    await sleep(1500);
    const r2 = sess ? await evalIn(sess, '({ href: location.href, injected: window.__fpInstalled === true })') : {};
    check('反面对照：CDP 直建带 URL 的快页面仍然注入成功（bff86c6 的用途没退化）',
      r2?.injected === true, JSON.stringify({ href: r2?.href, injected: r2?.injected }));
  }

  /* ---------- ⑤ 慢端点确实被请求过（防「其实没打开」的假绿） ---------- */
  check('慢 JSON 端点真的被请求过（hits.slow > 0）', hits.slow > 0, JSON.stringify(hits));
} catch (e) {
  console.log('异常:', e && (e.stack || e.message));
  check('脚本跑完没有异常', false, String(e && e.message));
} finally {
  for (const targetId of openTargets) { try { await client?.send('Target.closeTarget', { targetId }); } catch {} }
  try { if (client) client.close(); } catch {}
  if (profileId) {
    try { await Promise.race([manager.stopProfile(profileId), sleep(4000)]); } catch {}
    try { profiles.deleteProfiles([profileId]); } catch {}
  }
  try { server.closeAllConnections?.(); } catch {}
  try { server.close(); } catch {}
  await sleep(500);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  finish(results);
}
