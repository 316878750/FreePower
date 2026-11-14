/**
 * 窗口同步阶段 1 的 B 层判据：**真内核、两个环境、CDP 派发模拟输入**。
 *
 * 为什么不用真实鼠标：这个测试会连点带敲，动真实鼠标就等于接管用户电脑；
 * CDP 的 `Input.dispatchMouseEvent` 派发的是**页面里的 DOM 事件**，主窗口的捕获脚本照样收得到，
 * 而受控窗口收到的是我们回放的 CDP 输入 —— 链路完全一样，且不碰用户。
 *
 * 判据编号沿用方案：
 *   · 8a：两窗口统一尺寸时，按**元素 id** 断言命中（必须绿）；
 *   · 8b：2 倍尺寸差 + 响应式页时，**只**断言面板/状态给出「尺寸不一致」与各窗口实际尺寸，
 *         不断言命中（比例映射在响应式页面上本来就会点偏，断言命中就是假绿）；
 *   · 四个开关两个方向；
 *   · binding 名每会话随机、页面 own names 里查不到（覆盖前/后的读数）；
 *   · 新判据 ①：同步开的新标签首个文档 `__fpApplied === 'object'` 且 `navigation.type === 'navigate'`；
 *   · OOPIF iframe 里的输入能不能捕获（读数，写进 README 的「不同步」清单）。
 *
 * 跑法：npm run test:sync-kernel（会起 2 个真环境，约 1–2 分钟）
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

const dataDir = path.join(os.tmpdir(), `freepower-synck-${Date.now()}`);
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_SELFCHECK = '0';

/* ------------------------------ 测试页 ------------------------------ */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>sync-target</title>
<style>
  body { margin: 0; font: 14px/1.4 monospace; }
  #target { position: absolute; left: 40px; top: 60px; width: 220px; height: 90px; background: #dde; }
  #ta { position: absolute; left: 40px; top: 200px; width: 320px; height: 60px; }
  #tail { position: absolute; top: 2600px; left: 0; width: 100%; height: 400px; background: #efe; }
</style></head><body>
<div id="target">TARGET</div>
<textarea id="ta"></textarea>
<div id="tail">TAIL</div>
<iframe id="frame" src="__OOPIF__" style="position:absolute;left:400px;top:60px;width:400px;height:200px"></iframe>
<script>
window.__hits = []; window.__keys = []; window.__moves = 0;
document.addEventListener('click', function (e) { window.__hits.push(e.target && e.target.id ? e.target.id : (e.target ? e.target.tagName : '?')); }, true);
document.addEventListener('mousemove', function () { window.__moves += 1; }, true);
document.addEventListener('keydown', function (e) { window.__keys.push(e.key); }, true);
</script></body></html>`;

const OOPIF_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>oopif</title></head><body style="margin:0">
<textarea id="ita" style="width:300px;height:120px"></textarea></body></html>`;

const srv = http.createServer((req, res) => {
  const p = String(req.url || '/').split('?')[0];
  if (p === '/oopif') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(OOPIF_PAGE);
    return;
  }
  // iframe 用 localhost（另一个 site）→ 强制 OOPIF
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE.replace('__OOPIF__', `http://localhost:${srv.address().port}/oopif`));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const URL_MAIN = `http://127.0.0.1:${PORT}/page`;

const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');
const sync = await import('../src/sync/session.js');
const { markerNames } = await import('../src/kernel/markers.js');
const { fingerprintView } = await import('../src/fingerprint/view.js');

const started = [];
let instA = null;
let instB = null;
let pageA = null;
let pageB = null;

async function evalIn(inst, sessionId, expression) {
  const r = await inst.client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    .catch(() => null);
  if (r?.exceptionDetails) return { error: r.exceptionDetails.text };
  return r?.result?.value;
}

/**
 * 把窗口强行设成指定尺寸，**读回来核对**再返回。
 * 为什么要重试：内核刚启动时还会自己应用一次启动尺寸，把我们的设置覆盖掉（实测 A 被设回 1266×648）；
 * 也可能是最大化状态没退干净。所以「设一次就信」是错的，必须读回来看。
 */
async function forceSize(inst, targetId, width, height, tries = 4) {
  const { windowId } = await inst.client.send('Browser.getWindowForTarget', { targetId });
  let last = null;
  for (let i = 0; i < tries; i++) {
    await inst.client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {});
    await sleep(200);
    await inst.client.send('Browser.setWindowBounds', { windowId, bounds: { width, height } }).catch(() => {});
    await sleep(500);
    last = (await inst.client.send('Browser.getWindowForTarget', { targetId }).catch(() => null))?.bounds || last;
    if (last && Math.abs(last.width - width) <= 4 && Math.abs(last.height - height) <= 4) return last;
  }
  return last;
}

async function setWindowSize(inst, targetId, width, height) {
  const got = await inst.client.send('Browser.getWindowForTarget', { targetId });
  const windowId = got.windowId;
  // 最大化/最小化下 setWindowBounds 会被忽略（实测）：先回 normal，等一下再设尺寸
  await inst.client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {});
  await sleep(250);
  await inst.client.send('Browser.setWindowBounds', { windowId, bounds: { width, height } }).catch(() => {});
  await sleep(450);
  const after = await inst.client.send('Browser.getWindowForTarget', { targetId }).catch(() => null);
  return { windowId, bounds: after?.bounds || null };
}

/** 等两窗口视口相同（窗口尺寸设置是异步的，OS 还会夹到屏幕内） */
async function waitSameViewport(instA2, sidA, instB2, sidB, tries = 12) {
  let va = '';
  let vb = '';
  for (let i = 0; i < tries; i++) {
    va = String(await evalIn(instA2, sidA, 'innerWidth + "x" + innerHeight'));
    vb = String(await evalIn(instB2, sidB, 'innerWidth + "x" + innerHeight'));
    if (va === vb) return { va, vb, same: true };
    await sleep(300);
  }
  return { va, vb, same: false };
}

/** 在页面里按元素 id 取中心点（CSS px），再派发一条「移动 + 按下 + 抬起」 */
async function clickAtElement(inst, sessionId, selector) {
  const box = await evalIn(inst, sessionId, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), vw: innerWidth, vh: innerHeight };
  })()`);
  if (!box || typeof box.x !== 'number') return null;
  await inst.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', buttons: 0 }, sessionId);
  await inst.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
  await inst.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
  return box;
}

async function typeText(inst, sessionId, text) {
  for (const ch of text) {
    await inst.client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, text: ch, unmodifiedText: ch,
      windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
    }, sessionId);
    await inst.client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`,
      windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
    }, sessionId);
  }
}

try {
  /* ------------------------------ 起两个环境 ------------------------------ */
  for (const name of ['sync-master', 'sync-slave']) {
    const p = profiles.createProfile({ name: `${name}-${Date.now()}`, group_id: '0', remark: 'sync B 层判据' });
    const st = await manager.startProfile(profiles.getProfile(p.profile_id));
    started.push(p.profile_id);
    console.log(`环境 ${name} = ${p.profile_id} · 内核 ${st.real_version}`);
  }
  [instA, instB] = [manager.getInstance(started[0]), manager.getInstance(started[1])];
  /* P0 起诊断标记名按 fp_seed 派生（页面里不再有固定的 __fp* 名）：
   * 判据读「注入过没有」必须用同一份派生，否则读到的永远是 undefined。 */
  const mkA = markerNames(fingerprintView(profiles.getProfile(started[0])).seed);
  const mkB = markerNames(fingerprintView(profiles.getProfile(started[1])).seed);
  pageA = await instA.openPage(URL_MAIN);
  pageB = await instB.openPage(URL_MAIN);
  // 等内核把启动尺寸应用完再动手，否则我们的 resize 会被它自己覆盖（实测过）
  await sleep(2200);

  const applied = await evalIn(instA, pageA.sessionId, `typeof window[${JSON.stringify(mkA.applied)}]`);
  check('主窗口页面注入生效（后面所有断言的前提）', applied === 'object', String(applied));

  /* ------------------------------ 8a：统一尺寸，按元素 id 命中 ------------------------------ */
  console.log('\n— 8a：统一尺寸 → 按元素 id 断言命中 —');
  /**
   * 8a 要测的是「视口相同 → 比例映射能落到同一个元素上」，不是「OS 会不会听我们的话改窗口」。
   * 实测：`Browser.setWindowBounds` 之后外框读数是 1436×744，而页面 `innerWidth` 还是 1600×900
   * （窗口最大化 / DPI 缩放 / 内核自己再应用一次启动尺寸，三种因素都会让这两者不一致）。
   * 所以这里用 `Emulation.setDeviceMetricsOverride` 把**两个页面的视口**钉成同一个值 ——
   * 这正是「统一尺寸」在坐标映射意义上的等价条件，且结果确定可复现。
   * 真实窗口尺寸不一致的场景由 8b 覆盖（它只断言提示与读数，不断言命中）。
   */
  const VIEW = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
  await instA.client.send('Emulation.setDeviceMetricsOverride', VIEW, pageA.sessionId).catch(() => {});
  await instB.client.send('Emulation.setDeviceMetricsOverride', VIEW, pageB.sessionId).catch(() => {});
  await sleep(400);
  const vp = await waitSameViewport(instA, pageA.sessionId, instB, pageB.sessionId);
  console.log(`视口 A=${vp.va} B=${vp.vb}（统一后应相同）`);
  const boundsA = (await instA.client.send('Browser.getWindowForTarget', { targetId: pageA.targetId })).bounds;

  let st = await sync.startSync({ masterId: started[0], slaveIds: [started[1]], settings: {}, rngSeed: 12345 });
  await sleep(800);
  check('同步会话起来了', st.running === true && st.windows.length === 2, JSON.stringify(st.windows.map((w) => w.profile_id)));
  check('8a 前置：两窗口视口相同（尺寸统一）', vp.same, `${vp.va} vs ${vp.vb}`);

  await evalIn(instB, pageB.sessionId, 'window.__hits = []; window.__keys = []; window.__moves = 0; "ok"');
  const box = await clickAtElement(instA, pageA.sessionId, '#target');
  await sleep(600);
  const hitsB = await evalIn(instB, pageB.sessionId, 'JSON.stringify(window.__hits)');
  check('8a：主窗口点 #target → 受控窗口也点在 #target 上（按元素 id）',
    String(hitsB).includes('target'), `主窗口点 (${box?.x},${box?.y})，受控窗口 hits=${hitsB}`);

  /* ------------------------------ 输入同步 + 输入开关两方向 ------------------------------ */
  console.log('\n— 键盘：同步 / 关掉输入 / 再打开 —');
  await clickAtElement(instA, pageA.sessionId, '#ta');
  // 点击是为了走真实路径；再显式 focus 一次，避免「窗口不在前台时键盘事件没人接」
  // 这种测试环境噪声被误读成产品缺陷。
  await evalIn(instA, pageA.sessionId, 'document.querySelector("#ta").focus(); "ok"');
  await sleep(250);
  await typeText(instA, pageA.sessionId, 'abc');
  await sleep(600);
  const ta1 = await evalIn(instB, pageB.sessionId, 'document.querySelector("#ta").value');
  const ta1a = await evalIn(instA, pageA.sessionId, 'document.querySelector("#ta").value');
  check('键盘输入同步到受控窗口（abc）', String(ta1) === 'abc', `受控="${ta1}" 主窗口="${ta1a}"`);

  sync.updateSettings({ input: false });
  await typeText(instA, pageA.sessionId, 'zz');
  await sleep(500);
  const ta2 = await evalIn(instB, pageB.sessionId, 'document.querySelector("#ta").value');
  check('input:false → 后续按键不同步（仍停在 abc）', String(ta2) === 'abc', JSON.stringify(ta2));
  const droppedAfterOff = sync.syncStatus().dropped;
  check('input:false 时被开关拦下的条数 > 0（不是「压根没捕获」）', droppedAfterOff > 0, String(droppedAfterOff));

  sync.updateSettings({ input: true });
  await typeText(instA, pageA.sessionId, 'd');
  await sleep(500);
  const ta3 = await evalIn(instB, pageB.sessionId, 'document.querySelector("#ta").value');
  check('input 再打开 → 立刻恢复同步（abcd）', String(ta3) === 'abcd', JSON.stringify(ta3));

  /* ------------------------------ 移动 / 滚动开关 ------------------------------ */
  console.log('\n— 移动与滚动开关 —');
  await evalIn(instB, pageB.sessionId, 'window.__moves = 0; document.scrollingElement.scrollTop = 0; "ok"');
  for (let i = 0; i < 6; i++) {
    await instA.client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: 120 + i * 12, y: 140 + i * 6, button: 'none', buttons: 0,
    }, pageA.sessionId);
    await sleep(60);
  }
  await sleep(400);
  const movesOn = await evalIn(instB, pageB.sessionId, 'window.__moves');
  check('move 开着：受控窗口收到鼠标移动', Number(movesOn) > 0, String(movesOn));

  sync.updateSettings({ move: false });
  await evalIn(instB, pageB.sessionId, 'window.__moves = 0; "ok"');
  for (let i = 0; i < 6; i++) {
    await instA.client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: 200 + i * 12, y: 200 + i * 6, button: 'none', buttons: 0,
    }, pageA.sessionId);
    await sleep(60);
  }
  await sleep(400);
  const movesOff = await evalIn(instB, pageB.sessionId, 'window.__moves');
  check('move:false → 受控窗口不再收到移动', Number(movesOff) === 0, String(movesOff));
  sync.updateSettings({ move: true });

  await instA.client.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: 300, y: 300, deltaX: 0, deltaY: 400,
  }, pageA.sessionId);
  await sleep(700);
  const scrollB = await evalIn(instB, pageB.sessionId, 'Math.round(document.scrollingElement.scrollTop)');
  check('滚动同步（受控窗口 scrollTop > 0）', Number(scrollB) > 0, String(scrollB));

  sync.updateSettings({ scroll: false });
  await evalIn(instB, pageB.sessionId, 'document.scrollingElement.scrollTop = 0; "ok"');
  await instA.client.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: 300, y: 300, deltaX: 0, deltaY: 400,
  }, pageA.sessionId);
  await sleep(700);
  const scrollOff = await evalIn(instB, pageB.sessionId, 'Math.round(document.scrollingElement.scrollTop)');
  check('scroll:false → 受控窗口不再滚动', Number(scrollOff) === 0, String(scrollOff));
  sync.updateSettings({ scroll: true });

  /* ------------------------------ binding：随机名 + 抓完即删 ------------------------------ */
  console.log('\n— binding 名与检测面 —');
  const stNow = sync.syncStatus();
  check('binding 名形状 __fpS_<8位 hex>（每会话随机）', /^__fpS_[0-9a-f]{8}$/.test(String(stNow.binding_name)),
    String(stNow.binding_name));
  const leftover = await evalIn(instA, pageA.sessionId,
    `JSON.stringify(Object.getOwnPropertyNames(window).filter((n) => n.startsWith('__fpS_')))`);
  check('主窗口 own names 里查不到 binding 名（抓完就 delete 了）', leftover === '[]', String(leftover));
  const typeofBinding = await evalIn(instA, pageA.sessionId, `typeof window[${JSON.stringify(String(stNow.binding_name))}]`);
  check('按名字直接取也拿不到（typeof undefined）', typeofBinding === 'undefined', String(typeofBinding));

  /* ------------------------------ 8b：尺寸不一致只报提示，不断言命中 ------------------------------ */
  console.log('\n— 8b：尺寸差 2 倍 → 只断言提示与读数 —');
  const wide = Math.min(Math.round(boundsA.width * 2), 3000);
  await forceSize(instB, pageB.targetId, wide, Math.round(boundsA.height * 1.5));
  await sleep(400);
  const refreshed = await sync.refreshAll();
  const widths = (refreshed.windows || []).map((w) => w.window?.width);
  console.log(`各窗口外框宽：${widths.join(' / ')}`);
  check('8b：status.size_mismatch === true', refreshed.size_mismatch === true, String(refreshed.size_mismatch));
  check('8b：status 里能看到各窗口实际尺寸（两个值不同）',
    new Set(widths.filter(Boolean)).size >= 2, widths.join(','));
  check('8b：没有把「尺寸不一致」当成同步失败（会话仍在跑）', refreshed.running === true, String(refreshed.running));

  /* ------------------------------ 新标签：首文档即注入 ------------------------------ */
  console.log('\n— 新标签：about:blank → attach → navigate —');
  const tab = await sync.openTabInAll(`http://127.0.0.1:${PORT}/page?tab=1`);
  const openedB = (tab.opened || []).find((o) => o.profile_id === started[1]);
  check('新标签在受控窗口也开出来了', !!openedB?.target_id, JSON.stringify(tab.opened.map((o) => !!o.target_id)));
  if (openedB?.target_id) {
    const att = await instB.client.send('Target.attachToTarget', { targetId: openedB.target_id, flatten: true });
    let seen = { applied: '', nav: '', entries: 0 };
    for (let i = 0; i < 60; i++) {
      const v = await evalIn(instB, att.sessionId,
        `typeof window[${JSON.stringify(mkB.applied)}] + "|" + ((performance.getEntriesByType("navigation")[0]||{}).type || "") + "|" + performance.getEntriesByType("navigation").length`);
      const [applied2, nav, entries] = String(v).split('|');
      seen = { applied: applied2, nav, entries: Number(entries) };
      if (applied2 === 'object' && nav) break;
      await sleep(100);
    }
    check('新标签首个文档 applied 标记就是 object（注入没被首帧绕过）', seen.applied === 'object', JSON.stringify(seen));
    check('新标签 navigation.type === navigate（不是 reload）', seen.nav === 'navigate', seen.nav);
    check('新标签只加载一次文档（navigation 条目 = 1）', seen.entries === 1, String(seen.entries));
  }

  /* ------------------------------ OOPIF iframe 能不能捕获 ------------------------------ */
  console.log('\n— OOPIF iframe 里的输入 —');
  let oopif = { typedInA: '', syncedInB: '', iframeTargets: 0 };
  try {
    // 在 A 里点 iframe 内部（iframe 左上角 + 偏移），再把焦点落到 iframe 的 textarea 上，
    // 然后敲字。焦点显式给：点击能否穿进 OOPIF 取决于窗口是否在前台，那是测试环境噪声，
    // 这里要测的是「键事件进了 iframe 之后，我们的捕获脚本收不收得到」。
    const fb = await evalIn(instA, pageA.sessionId, `(() => {
      const f = document.querySelector('#frame');
      const r = f.getBoundingClientRect();
      return { x: Math.round(r.left + 60), y: Math.round(r.top + 40) };
    })()`);
    await instA.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fb.x, y: fb.y, button: 'none', buttons: 0 }, pageA.sessionId);
    await instA.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fb.x, y: fb.y, button: 'left', buttons: 1, clickCount: 1 }, pageA.sessionId);
    await instA.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fb.x, y: fb.y, button: 'left', buttons: 0, clickCount: 1 }, pageA.sessionId);
    await sleep(200);

    // 找到 iframe target，在里面把 textarea focus 起来（并记录它的 document 是否真的能读到）
    const iframeTargets = (await instA.client.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'iframe' && t.url.includes('/oopif'));
    let focusedInOopif = false;
    let oopifSession = null;
    for (const t of iframeTargets) {
      const s = await instA.client.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }).catch(() => null);
      if (!s?.sessionId) continue;
      await instA.client.send('Runtime.enable', {}, s.sessionId).catch(() => {});
      const r = await evalIn(instA, s.sessionId, 'const el = document.querySelector("#ita"); if (el) { el.focus(); } !!el');
      if (r === true) { focusedInOopif = true; oopifSession = s.sessionId; break; }
    }
    check('OOPIF 前置：跨进程 iframe 里能读到 textarea 并 focus', focusedInOopif, String(focusedInOopif));

    // 键盘必须打到 **iframe 自己的 session** 上：主帧 session 的键盘只会给主帧的焦点元素，
    // 打不到 OOPIF 里（这是 CDP 的语义，不是我们的实现问题）。
    await typeText(instA, oopifSession || pageA.sessionId, 'oop');
    await sleep(700);

    const targets = (await instA.client.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'iframe');
    oopif.iframeTargets = targets.length;
    // 读 A 的 iframe 里 textarea（证明输入真的落进 iframe），再读 B 的同位置。
    // 诊断一起带上：拿不到值时要能分清「输入没落进去」和「探针自己没读到」。
    const readIframe = async (inst) => {
      const ts = (await inst.client.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'iframe');
      const diag = [];
      for (const t of ts) {
        const s = await inst.client.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }).catch(() => null);
        if (!s?.sessionId) { diag.push(`${t.url}:attach失败`); continue; }
        await inst.client.send('Runtime.enable', {}, s.sessionId).catch(() => {});
        const v = await evalIn(inst, s.sessionId, `(() => {
          const el = document.querySelector('#ita');
          return JSON.stringify({
            url: location.href,
            ready: document.readyState,
            has: !!el,
            value: el ? el.value : null,
            active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
          });
        })()`);
        await inst.client.send('Target.detachFromTarget', { sessionId: s.sessionId }).catch(() => {});
        diag.push(String(v));
        try {
          const j = JSON.parse(String(v));
          if (j.has && j.value) return { value: j.value, diag };
        } catch { /* 保留诊断 */ }
      }
      return { value: '', diag };
    };
    const readA = await readIframe(instA);
    const readB = await readIframe(instB);
    oopif.typedInA = readA.value;
    oopif.syncedInB = readB.value;
    console.log(`OOPIF 读数：A 的 iframe 里="${oopif.typedInA}"，B 的 iframe 里="${oopif.syncedInB}"，iframe target ${oopif.iframeTargets} 个`);
    console.log(`  A 诊断：${readA.diag.join(' | ').slice(0, 400)}`);
    console.log(`  B 诊断：${readB.diag.join(' | ').slice(0, 400)}`);
    check('OOPIF 实测：输入确实落进了 A 的跨进程 iframe（读数为真）',
      oopif.typedInA === 'oop', JSON.stringify(oopif.typedInA));
    // 这一条断言的是**我们记录下来的事实**：捕获不到就是捕获不到，写进 README 的「不同步」清单。
    check('OOPIF 实测：跨进程 iframe 里的输入不同步到受控窗口（已知限制）',
      oopif.syncedInB === '', `受控窗口 iframe 内容=${JSON.stringify(oopif.syncedInB)}`);
  } catch (e) {
    console.log('OOPIF 探针异常：', e?.message || e);
    check('OOPIF 探针跑通', false, e?.message || String(e));
  }

  /* ------------------------------ stop：binding 必须被摘掉 ------------------------------ */
  console.log('\n— stop 之后 binding 摘没摘 —');
  const name1 = sync.syncStatus().binding_name;
  const stopped = await sync.stopSync();
  check('停止后 running=false', sync.syncStatus().running === false);
  check('stop 回报里带 teardown 读数（removed 必须是 true）',
    stopped.teardown?.removed === true, JSON.stringify(stopped.teardown));
  check('teardown 记的 binding 名 = 本次会话那个', stopped.teardown?.binding_name === name1,
    `${stopped.teardown?.binding_name} vs ${name1}`);
  const afterStop = await evalIn(instA, pageA.sessionId, `typeof window[${JSON.stringify(String(name1))}]`);
  check('停止后主窗口页面里 typeof window[随机名] === undefined', afterStop === 'undefined', String(afterStop));

  /* ------------------------------ 会话重建：名字换新 + 抓完即删 ------------------------------ */
  console.log('\n— 会话重建 —');
  const st2 = await sync.startSync({ masterId: started[0], slaveIds: [started[1]], settings: {} });
  check('第二次会话的 binding 名与第一次不同（每次会话随机）',
    st2.binding_name !== name1 && /^__fpS_[0-9a-f]{8}$/.test(String(st2.binding_name)),
    `${name1} → ${st2.binding_name}`);

  // 不写死等待时间，**量**暴露窗口：从会话起来到名字从页面 own names 里消失用了多久。
  // 后台标签页的定时器会被 Chrome 节流（4ms → 1000ms），所以这个数字要如实打出来。
  const t0 = Date.now();
  let leftover2 = null;
  let elapsed = -1;
  for (let i = 0; i < 40; i++) {
    leftover2 = await evalIn(instA, pageA.sessionId,
      `JSON.stringify(Object.getOwnPropertyNames(window).filter((n) => n.startsWith('__fpS_')))`);
    if (leftover2 === '[]') { elapsed = Date.now() - t0; break; }
    await sleep(100);
  }
  console.log(`  第二次会话：binding 名从页面 own names 里消失用时 ${elapsed < 0 ? '>4000' : elapsed}ms`);
  check('第二次会话后 own names 里仍然查不到（新的那个也被 delete）', leftover2 === '[]', String(leftover2));
  // 暴露窗口的硬上限：脚本同步抓，正常在几毫秒内；1500ms 容差覆盖定时器节流这条兜底路径。
  check('binding 名的页面暴露窗口 ≤1500ms（同步抓 + 轮询兜底）', elapsed >= 0 && elapsed <= 1500, `${elapsed}ms`);

  // 第二次停：再核一遍 removeBinding 真的每次都摘（不是只有第一次碰巧成功）
  const stopped2 = await sync.stopSync();
  check('第二次 stop 也 removed=true', stopped2.teardown?.removed === true, JSON.stringify(stopped2.teardown));

  /* ------------------------------ 异常结束：连接断开要如实记 ------------------------------ */
  console.log('\n— 异常结束（内核被外部杀掉）—');
  await sync.startSync({ masterId: started[0], slaveIds: [started[1]], settings: {} });
  await sleep(300);
  const name3 = sync.syncStatus().binding_name;
  // 直接杀内核主进程（**不走 manager.stopProfile**）：这样不会有 detach 机会，
  // CDP 连接是被硬断开的 —— 这才是「异常结束」的真实形态。
  try { process.kill(instA.pid); } catch (e) { console.log('杀进程失败：', e.message); }
  await sleep(2000);
  const st3 = sync.syncStatus();
  console.log(`环境被杀后的状态：running=${st3.running} teardown=${JSON.stringify(st3.last_teardown)}`);
  check('环境被杀 → 会话自动结束（不留挂在死连接上的会话）', st3.running === false, String(st3.running));
  check('环境被杀 → teardown 如实记 removed=false + reason=connection_lost（不假装干净）',
    st3.last_teardown?.removed === false && st3.last_teardown?.reason === 'connection_lost',
    JSON.stringify(st3.last_teardown));
  check('环境被杀 → 记的正是当时那个 binding 名', st3.last_teardown?.binding_name === name3,
    `${st3.last_teardown?.binding_name} vs ${name3}`);
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
