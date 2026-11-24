/**
 * 第 1–3 步的 B 层判据：**真内核、1 主 + 1 受控**，两条投递路径（win32 / cdp）各跑一遍。
 *
 * 判据（每条只认**受控页自己的 DOM 读数**，不认 scheduler.sent / errors —— 规格 §3 硬规则）：
 *   D1 被遮挡：把主控窗口挪到受控窗口正上方完全盖住，主控点按钮 → 受控页计数 +1。
 *      同时读受控页的后台定时器：1s 内 setInterval(100) 至少跑 7 次（第 1 步的反节流真生效）。
 *   D2 同源 iframe：主控点 iframe 里的按钮 → 受控 iframe 里的计数 +1（坐标按偏移换算对了才命中）。
 *   D3 跨进程 iframe（127.0.0.1 ↔ localhost 不同站点 = OOPIF）：同上。
 *   D4 受控切标签：受控窗口切到第二个标签后，主控点按钮 → 新标签 +1、旧标签不变。
 *   D5 打字：主控输入框敲 "ab" → 受控输入框值是 "ab"（不许 "aabb"）。
 *   D6 状态：win32 轮 delivery_via='win32' 且 win_ok>0；cdp 轮 delivery_via='cdp'。
 *
 * 为什么用 CDP 在主控派发输入：不动用户真实鼠标（同 sync-kernel.test.mjs 的立场）；
 * 主控捕获脚本收到的是同样的 DOM 事件，受控侧走的才是被测的投递路径。
 * 非 Windows 上 win32 轮自动跳过（记 SKIP，不算通过也不算失败）。
 *
 * 跑法：node --no-warnings test/sync-deliver-kernel.test.mjs（约 60 秒）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const skip = (name, why) => console.log(`SKIP  ${name}  — ${why}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dataDir = path.join(os.tmpdir(), `freepower-deliver-${Date.now()}`);
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
process.env.FREEPOWER_EGRESS_TIMEOUT = '800';

/* 同一个服务：127.0.0.1 当主站，localhost 当跨站 iframe（不同 site → Chrome 站点隔离成 OOPIF） */
const counterPage = (id) => `<button id="${id}" style="position:absolute;left:40px;top:40px;width:160px;height:60px">${id}</button>
<script>window.n=0;document.getElementById('${id}').addEventListener('click',()=>{window.n++;});</script>`;
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/frame') return res.end(`<!doctype html><body style="margin:0">${counterPage('fb')}</body>`);
  if (u.pathname === '/tab2') return res.end(`<!doctype html><title>tab2</title><body style="margin:0">${counterPage('b')}</body>`);
  res.end(`<!doctype html><title>main</title><body style="margin:0">
${counterPage('b')}
<input id="i" style="position:absolute;left:40px;top:130px;width:200px;height:30px">
<iframe id="same" src="/frame" style="position:absolute;left:300px;top:200px;width:300px;height:180px;border:3px solid #000"></iframe>
<iframe id="cross" src="http://localhost:${PORT}/frame" style="position:absolute;left:40px;top:420px;width:300px;height:180px;border:3px solid #000"></iframe>
<script>window.ticks=0;setInterval(()=>{window.ticks++;},100);</script></body>`);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const U = (p) => `http://127.0.0.1:${PORT}${p}`;

const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');
const sync = await import('../src/sync/session.js');

const started = [];

async function pageOf(id, pathPrefix = '/main') {
  const inst = manager.getInstance(id);
  const { targetInfos } = await inst.client.send('Target.getTargets');
  const t = targetInfos.find((x) => x.type === 'page' && x.url.startsWith(U(pathPrefix)));
  if (!t) return null;
  const { sessionId } = await inst.client.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  return { inst, targetId: t.targetId, sessionId };
}
async function ev(p, expression) {
  const r = await p.inst.client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, p.sessionId).catch(() => null);
  return r?.result?.value;
}
/** 读 iframe 里的 window.n：同源直接 contentWindow；跨站要走它自己的 target */
async function frameN(id, which) {
  if (which === 'same') return ev(await pageOf(id), "document.getElementById('same').contentWindow.n");
  const inst = manager.getInstance(id);
  const { targetInfos } = await inst.client.send('Target.getTargets');
  const f = targetInfos.find((x) => x.type === 'iframe' && x.url.includes('localhost'));
  if (!f) return null;
  const { sessionId } = await inst.client.send('Target.attachToTarget', { targetId: f.targetId, flatten: true });
  return ev({ inst, sessionId }, 'window.n');
}
async function click(p, x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await p.inst.client.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 }, p.sessionId);
    await sleep(30);
  }
}
async function typeKeys(p, s) {
  for (const ch of s) {
    const kc = ch.toUpperCase().charCodeAt(0);
    await p.inst.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: kc, text: ch }, p.sessionId);
    await p.inst.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: kc }, p.sessionId);
    await sleep(40);
  }
}
async function winBounds(p) {
  return (await p.inst.client.send('Browser.getWindowForTarget', { targetId: p.targetId }));
}

async function round(deliver) {
  const tag = `[${deliver}]`;
  const [mid, sid] = started;
  for (const id of started) {
    const inst = manager.getInstance(id);
    await inst.openPage(U('/main'));
  }
  await sleep(2000);
  const M = await pageOf(mid);
  const S = await pageOf(sid);
  /* 两窗口同尺寸、同位置：主控在上，受控被**完全盖住**（D1 的前提） */
  for (const p of [S, M]) {
    const { windowId } = await winBounds(p);
    await p.inst.client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await p.inst.client.send('Browser.setWindowBounds', { windowId, bounds: { left: 80, top: 60, width: 1000, height: 760 } });
    await sleep(200);
  }
  await M.inst.client.send('Page.bringToFront', {}, M.sessionId);
  await sleep(600);

  const st0 = await sync.startSync({ masterId: mid, slaveIds: [sid], settings: { deliver }, rngSeed: 7 });
  check(`${tag} 会话起来了`, st0.running === true);
  await sleep(1200);

  /* D1 */
  const t0 = await ev(S, 'window.ticks'); await sleep(1000); const t1 = await ev(S, 'window.ticks');
  check(`${tag} D1 被遮挡的受控页定时器不被节流（1s ≥ 7 次）`, t1 - t0 >= 7, `${t0}→${t1}`);
  const n0 = await ev(S, 'window.n');
  await click(M, 120, 70); await sleep(700);
  check(`${tag} D1 被遮挡时主控点按钮 → 受控 +1`, (await ev(S, 'window.n')) === n0 + 1, `${n0}→${await ev(S, 'window.n')}`);

  /* D2：iframe 左上 (300,200) + 边框 3 + 按钮中心 (120,70) */
  const f0 = await frameN(sid, 'same');
  await click(M, 300 + 3 + 120, 200 + 3 + 70); await sleep(700);
  check(`${tag} D2 同源 iframe 里点击同步到受控 iframe`, (await frameN(sid, 'same')) === f0 + 1, `${f0}→${await frameN(sid, 'same')}`);

  /* D3：跨站 iframe (40,420) */
  const c0 = await frameN(sid, 'cross');
  await click(M, 40 + 3 + 120, 420 + 3 + 70); await sleep(900);
  const c1 = await frameN(sid, 'cross');
  check(`${tag} D3 跨进程 iframe 里点击同步到受控 iframe`, c0 !== null && c1 === c0 + 1, `${c0}→${c1}`);

  /* D5 */
  await click(M, 140, 145); await sleep(300);
  await typeKeys(M, 'ab'); await sleep(800);
  /* 注意 typeKeys 不带 Shift：大写/符号会走 CDP，这里只钉「小写字母走 Win32 不双字符」 */
  const v = await ev(S, "document.getElementById('i').value");
  check(`${tag} D5 打字 "ab" → 受控输入框正好是 "ab"`, v === 'ab', JSON.stringify(v));

  /* D4：受控开第二个标签并切过去 */
  await S.inst.openPage(U('/tab2'));
  await sleep(1500);
  const S2 = await pageOf(sid, '/tab2');
  await S2.inst.client.send('Page.bringToFront', {}, S2.sessionId);
  await M.inst.client.send('Page.bringToFront', {}, M.sessionId);   // 受控又被盖住
  await sleep(1200);
  const old0 = await ev(S, 'window.n'); const new0 = await ev(S2, 'window.n');
  await click(M, 120, 70); await sleep(800);
  const old1 = await ev(S, 'window.n'); const new1 = await ev(S2, 'window.n');
  check(`${tag} D4 受控切标签后 → 新标签 +1、旧标签不变`, new1 === new0 + 1 && old1 === old0, `new ${new0}→${new1} old ${old0}→${old1}`);

  /* D6 */
  const w = (sync.syncStatus().windows || []).find((x) => x.profile_id === sid) || {};
  if (deliver === 'win32') check(`${tag} D6 状态如实：delivery_via=win32 且 win_ok>0`, w.delivery_via === 'win32' && w.win_ok > 0, JSON.stringify({ via: w.delivery_via, ok: w.win_ok, fail: w.win_fail, why: w.win_last_reason }));
  else check(`${tag} D6 状态如实：delivery_via=cdp`, w.delivery_via === 'cdp', String(w.delivery_via));

  await sync.stopSync();
  /* 关掉本轮开的页，下一轮从干净状态开始 */
  for (const id of started) {
    const inst = manager.getInstance(id);
    const { targetInfos } = await inst.client.send('Target.getTargets');
    for (const x of targetInfos.filter((y) => y.type === 'page' && y.url.startsWith(U('')))) {
      await inst.client.send('Target.closeTarget', { targetId: x.targetId }).catch(() => {});
    }
  }
  await sleep(800);
}

try {
  for (const name of ['dl-master', 'dl-slave']) {
    const p = profiles.createProfile({ name: `${name}-${Date.now()}`, group_id: '0', remark: '投递路径 B 层判据' });
    const st = await manager.startProfile(profiles.getProfile(p.profile_id));
    started.push(p.profile_id);
    console.log(`环境 ${name} = ${p.profile_id} · 内核 ${st.real_version}`);
  }
  await round('cdp');
  if (process.platform === 'win32') await round('win32');
  else skip('[win32] 整轮', '非 Windows');
} catch (e) {
  console.log('异常：', e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : e);
  check('整体跑通（无异常）', false, String(e && e.message));
} finally {
  try { await sync.stopSync(); } catch { /* ignore */ }
  const withTimeout = (p, ms = 8000) => Promise.race([Promise.resolve(p).catch(() => {}), sleep(ms)]);
  for (const id of started) {
    try { await withTimeout(manager.stopProfile(id)); } catch { /* ignore */ }
    try { profiles.deleteProfiles([id]); } catch { /* ignore */ }
  }
  try { srv.closeAllConnections?.(); } catch { /* ignore */ }
  try { srv.close(); } catch { /* ignore */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail}/${results.length} 通过`);
process.exit(fail ? 1 : 0);
