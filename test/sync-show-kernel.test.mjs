/**
 * 「显示窗口 / 置前」的 B 层判据：**真内核、1 主 + 2 受控、真实 Windows 前台读数**。
 *
 * 这一层只证明一件事：**零依赖我们能拿到哪一层置前**，并且如实报出来。判据分三类读数：
 *   ① 页面文档有焦点 —— `Runtime.evaluate: document.hasFocus()`，**只作参考，不当成功**
 *   ② 窗口状态/几何 —— `Browser.getWindowForTarget` 回读的 state/x/y/width/height
 *   ③ OS 前台窗口 —— Win32 `GetForegroundWindow()` 的标题与进程（`tools/win-foreground.ps1`，只作测试用）
 *
 * 逐条断言的结论（都是实测，不是推理）：
 *   A 最小化的窗口 →「显示窗口」后 state=normal、位置尺寸**一个像素都没被搬**，并且真成为 ③ OS 前台；
 *   B 没最小化只是被盖住的窗口 →`Page.bringToFront` 只让 ① 变 true，③ 仍是别的窗口，我们如实报 `page_only`；
 *   C 离主屏很远的坐标（负 x / 大 x）恢复后不被搬回主屏；
 *   D 最大化后被最小化的窗口 → 恢复回 maximized（状态保留）；
 *   E `profile_ids` 只动指定的那个；F 内核死掉的那个如实 ok:false，不拖垮其它窗口。
 *
 * 跑法：npm run test:sync-show-kernel（起 3 个真环境，约 50 秒）
 * 注意：这个套件会**真的把 Chrome 窗口抬到前台**（这就是被测行为），跑的时候别指望桌面不闪。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PS1 = path.join(ROOT, 'tools', 'win-foreground.ps1');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dataDir = path.join(os.tmpdir(), `freepower-show-${Date.now()}`);
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
process.env.FREEPOWER_EGRESS_TIMEOUT = '800';

/* 每个环境开一个**标题不同**的页面：OS 前台读数靠标题认窗口（比 pid 更直接） */
const srv = http.createServer((req, res) => {
  const tag = String(req.url || '/').replace(/[^a-z0-9-]/gi, '') || 'page';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><title>fp-show-${tag}</title><h1>fp-show-${tag}</h1>`);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const U = (p) => `http://127.0.0.1:${PORT}${p}`;

/* ---------------- Win32：OS 前台窗口（③）。这是整份判据里唯一不依赖 CDP 的读数 ---------------- */
function win32(args = []) {
  const out = execFileSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...args],
    { encoding: 'utf8', timeout: 25000, windowsHide: true });
  const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || '{}';
  return JSON.parse(line);
}
function fg() {
  try {
    return win32();
  } catch (e) {
    return { ok: false, error: e?.message || String(e), title: '' };
  }
}
/** 当前 OS 前台窗口的标题里有没有这个标记 */
function fgTitleIs(tag) {
  const r = fg();
  return { hit: String(r.title || '').includes(tag), title: r.title || '', pid: r.fg_pid ?? null, ok: r.ok !== false };
}
/** 某个标题的窗口在 z 序里第几层（0 = 最上层）；找不到给 -1 */
function zOf(tag) {
  try {
    const r = win32(['-ListWindows']);
    const hit = (r.windows || []).find((w) => String(w.title || '').includes(tag));
    return hit ? hit.z : -1;
  } catch {
    return -1;
  }
}

const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');
const sync = await import('../src/sync/session.js');

const started = [];

/** 直接读 CDP 的窗口实测矩形（判据只认这个，不读我们自己回报的数字） */
async function rectOf(id) {
  const inst = manager.getInstance(id);
  const { targetInfos } = await inst.client.send('Target.getTargets');
  const page = (targetInfos || []).filter((t) => t.type === 'page')
    .find((t) => t.url && !t.url.startsWith('about:blank') && !t.url.startsWith('chrome://newtab'))
    || (targetInfos || []).find((t) => t.type === 'page');
  const { bounds, windowId } = await inst.client.send('Browser.getWindowForTarget', { targetId: page.targetId });
  return {
    windowId,
    x: bounds?.left ?? null,
    y: bounds?.top ?? null,
    width: bounds?.width ?? null,
    height: bounds?.height ?? null,
    state: bounds?.windowState || 'normal',
  };
}
const sameRect = (a, b) => ['x', 'y', 'width', 'height'].every((f) => Math.round(a[f]) === Math.round(b[f]));
const rectStr = (r) => `${r.x},${r.y} ${r.width}×${r.height}(${r.state})`;

async function setState(id, windowState) {
  const w = await rectOf(id);
  await manager.getInstance(id).client.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState } });
  await sleep(450);
  return rectOf(id);
}
async function setRect(id, x, y, width, height) {
  const w = await rectOf(id);
  await manager.getInstance(id).client.send('Browser.setWindowBounds', {
    windowId: w.windowId, bounds: { left: x, top: y, width, height, windowState: 'normal' },
  });
  await sleep(350);
  return rectOf(id);
}

try {
  /* Win32 读数是这份判据的地基：读不到就别假装测过了 */
  const base = fg();
  check('Win32 前台读数可用（③ 这一层拿得到，不靠 CDP）', base.ok !== false,
    base.ok === false ? base.error : `前台标题「${base.title}」pid=${base.fg_pid}`);

  for (const tag of ['master', 'slave1', 'slave2']) {
    const p = profiles.createProfile({ name: `show-${tag}-${Date.now()}`, group_id: '0', remark: '显示窗口 B 层判据' });
    const st = await manager.startProfile(profiles.getProfile(p.profile_id));
    started.push(p.profile_id);
    console.log(`环境 ${tag} = ${p.profile_id} · 内核 ${st.real_version}`);
  }
  await manager.getInstance(started[0]).openPage(U('/master'));
  await manager.getInstance(started[1]).openPage(U('/slave1'));
  await manager.getInstance(started[2]).openPage(U('/slave2'));
  await sleep(2600);

  /* 三个窗口分开摆，别互相重叠：后面的「被盖住」要单独构造，不能开局就重叠 */
  await setRect(started[0], 120, 120, 700, 480);
  await setRect(started[1], 900, 120, 700, 480);
  await setRect(started[2], 1680, 120, 700, 480);

  const st0 = await sync.startSync({ masterId: started[0], slaveIds: [started[1], started[2]], settings: {}, rngSeed: 4242 });
  check('会话起来了（1 主 + 2 受控）', st0.running === true && st0.windows.length === 3,
    JSON.stringify(st0.windows.map((w) => w.role)));

  /* ------------------ A. 最小化 → 恢复：真的到 ③ OS 前台，且位置尺寸不动 ------------------ */
  console.log('\n— A. 最小化的受控窗口：显示后 state=normal、位置不变、成为 OS 前台（③）—');
  const aBefore = await rectOf(started[1]);
  const aMin = await setState(started[1], 'minimized');
  check('A 前置：受控 1 确实最小化了', aMin.state === 'minimized', rectStr(aMin));
  const aFg0 = fgTitleIs('fp-show-slave1');

  const rA = await sync.showWindows([started[1]]);
  const eA = rA.shown?.[0] || {};
  const aAfter = await rectOf(started[1]);
  const aFg1 = fgTitleIs('fp-show-slave1');
  console.log(`  最小化前 ${rectStr(aBefore)} → 恢复后 ${rectStr(aAfter)}`);
  console.log(`  OS 前台（恢复前）「${aFg0.title}」 → （恢复后）「${aFg1.title}」`);

  check('A 回报 raise=restored（最小化这一档才承诺真到前台）', eA.raise === 'restored', String(eA.raise));
  check('A 回报 ok=true 且 state_before=minimized / state_after=normal',
    eA.ok === true && eA.state_before === 'minimized' && eA.state_after === 'normal',
    JSON.stringify({ ok: eA.ok, b: eA.state_before, a: eA.state_after }));
  check('A 回读 state=normal（只认回读，不认命令返回值）', aAfter.state === 'normal', rectStr(aAfter));
  check('A 位置尺寸一个像素都没被搬', sameRect(aBefore, aAfter), `${rectStr(aBefore)} vs ${rectStr(aAfter)}`);
  check('A **真的成了 OS 前台窗口（③ Win32 读数）**', aFg1.hit, `前台标题「${aFg1.title}」`);
  check('A 恢复前它不是前台（说明这个命中不是巧合）', !aFg0.hit, `恢复前前台是「${aFg0.title}」`);
  check('A 汇总：restored=1 / page_only=0 / os_foreground=true',
    rA.summary?.restored === 1 && rA.summary?.page_only === 0 && rA.os_foreground === true,
    JSON.stringify({ restored: rA.summary?.restored, page_only: rA.summary?.page_only, os: rA.os_foreground }));

  /* ------------------ B. 被盖住（没最小化）：page_only，① 变 true 但 ③ 不变 ------------------ */
  console.log('\n— B. 没最小化、只是被盖住：只做页面级激活，如实报 page_only，OS 前台不许变 —');
  const bFgBefore = fgTitleIs('fp-show-slave1');
  const rB = await sync.showWindows();
  const bFgAfter = fgTitleIs('fp-show-slave1');
  const mFgAfter = fgTitleIs('fp-show-master');
  const eB = rB.shown || [];
  const masterB = eB.find((x) => x.profile_id === started[0]) || {};
  const zs = { master: zOf('fp-show-master'), slave1: zOf('fp-show-slave1') };
  console.log(`  前台（调用前）「${bFgBefore.title}」→（调用后）「${bFgAfter.title}」；master 在前台？${mFgAfter.hit}`);
  console.log(`  z 序：master=${zs.master} slave1=${zs.slave1}（0 = 最上层）`);
  console.log(`  master 这条：raise=${masterB.raise} page_focused=${JSON.stringify(masterB.page_focused)}`);

  check('B 三窗口都有记录（1 主 + 2 受控）', eB.length === 3, JSON.stringify(eB.map((x) => x.profile_id?.slice(0, 6))));
  check('B 主控（normal 没被最小化）报 page_only，不冒充 restored', masterB.raise === 'page_only', String(masterB.raise));
  check('B 它这档也算 ok（页面级激活做到了，状态没被改坏）', masterB.ok === true, JSON.stringify(masterB.problems));
  check('B 页面焦点读数拿到了（① 这一层）', masterB.page_focused?.hasFocus === true,
    JSON.stringify(masterB.page_focused));
  check('B **OS 前台没有变成 master（①≠③，不能拿页面焦点冒充窗口置前）**', !mFgAfter.hit,
    `前台仍是「${mFgAfter.title}」`);
  check('B OS 前台仍是刚才恢复的 slave1（窗口层次没被这次调用改变）', bFgAfter.hit, `前台「${bFgAfter.title}」`);
  check('B 汇总：restored=0 / page_only≥1，文案明说「可能仍被其它窗口盖住」',
    rB.summary?.restored === 0 && rB.summary?.page_only >= 1 && /可能仍被其它窗口盖住/.test(rB.summary?.message || ''),
    rB.summary?.message);
  check('B os_foreground=false（只有全部 restored 才是 true）', rB.os_foreground === false, String(rB.os_foreground));

  /* ------------------ C. 离主屏很远的坐标：恢复后不许搬回主屏 ------------------ */
  console.log('\n— C. 远离主屏坐标的窗口：恢复后位置必须原样（多屏硬伤）—');
  /* 本机两块屏：主屏 3440×1440；扩展屏在 x=-1080..0。先把窗口挪到扩展屏上试试（可能被系统夹住，如实记读数） */
  const cTried = await setRect(started[0], -1000, 200, 620, 420);
  console.log(`  请求 -1000,200 620×420 → 回读 ${rectStr(cTried)}`);
  const cBase = sameRect(cTried, { x: -1000, y: 200, width: 620, height: 420 })
    ? cTried
    : await setRect(started[0], 2400, 200, 620, 420);
  if (cBase !== cTried) console.log(`  负坐标没被接受，改用远离主屏的 ${rectStr(cBase)}`);
  const cMin = await setState(started[0], 'minimized');
  check('C 前置：主控确实最小化了', cMin.state === 'minimized', rectStr(cMin));

  const rC = await sync.showWindows([started[0]]);
  const cAfter = await rectOf(started[0]);
  const cFg = fgTitleIs('fp-show-master');
  console.log(`  最小化前 ${rectStr(cBase)} → 恢复后 ${rectStr(cAfter)}；OS 前台「${cFg.title}」`);
  check('C 恢复后位置尺寸原样，没被搬回主屏/主坐标', sameRect(cBase, cAfter),
    `${rectStr(cBase)} vs ${rectStr(cAfter)}`);
  check('C 恢复后 state=normal 且回报 ok', cAfter.state === 'normal' && rC.shown?.[0]?.ok === true,
    JSON.stringify({ state: cAfter.state, ok: rC.shown?.[0]?.ok }));
  check('C 恢复后它成为 OS 前台（③）', cFg.hit, `前台「${cFg.title}」`);

  /* ------------------ D. 最大化后被最小化：恢复回 maximized ------------------ */
  console.log('\n— D. 最大化过的窗口：最小化再显示 → 回到 maximized，状态不许被我们改掉 —');
  const dMax = await setState(started[2], 'maximized');
  const dMin = await setState(started[2], 'minimized');
  check('D 前置：先最大化再最小化', dMax.state === 'maximized' && dMin.state === 'minimized',
    `${dMax.state} → ${dMin.state}`);

  const rD = await sync.showWindows([started[2]]);
  const dAfter = await rectOf(started[2]);
  const dFg = fgTitleIs('fp-show-slave2');
  console.log(`  恢复后 ${rectStr(dAfter)}；OS 前台「${dFg.title}」`);
  check('D 恢复回 maximized（不是被我们缩成 normal）', dAfter.state === 'maximized', rectStr(dAfter));
  check('D 最大化窗口不比尺寸（系统边框补偿不算失败），回报 ok=true',
    rD.shown?.[0]?.ok === true, JSON.stringify({ ok: rD.shown?.[0]?.ok, problems: rD.shown?.[0]?.problems }));
  check('D 最大化窗口恢复后同样是 OS 前台（③）', dFg.hit, `前台「${dFg.title}」`);
  await setState(started[2], 'normal');

  /* ------------------ E. profile_ids 选择：只动指定的那个 ------------------ */
  console.log('\n— E. 指定 profile_ids：只显示指定的窗口，其它窗口不动 —');
  await setState(started[1], 'minimized');
  await setState(started[2], 'minimized');
  const eBoth = { s1: await rectOf(started[1]), s2: await rectOf(started[2]) };
  check('E 前置：两个受控都最小化了', eBoth.s1.state === 'minimized' && eBoth.s2.state === 'minimized',
    `${eBoth.s1.state} / ${eBoth.s2.state}`);

  const rE = await sync.showWindows([started[1]]);
  const e1 = await rectOf(started[1]);
  const e2 = await rectOf(started[2]);
  check('E 只处理一个窗口（回报 1 条）', (rE.shown || []).length === 1, String((rE.shown || []).length));
  check('E 指定的那个恢复了', e1.state === 'normal', e1.state);
  check('E 没指定的那个仍然最小化（没顺手全动）', e2.state === 'minimized', e2.state);

  const rE2 = await sync.showWindows();
  const e2b = await rectOf(started[2]);
  check('E 不传 profile_ids 时全部处理，剩下那个也恢复', e2b.state === 'normal', e2b.state);
  check('E 全量那次的汇总 ok=true', rE2.summary?.ok === true, rE2.summary?.message);

  /* ------------------ G. 强制置前（显式按钮那一档）：真的能到 ③ ------------------ */
  console.log('\n— G. 强制抬到前台：默认那档抬不动，点了 force 之后真的到 ③ OS 前台 —');
  /* 先把三个窗口都摆成 normal 且分开，别互相盖住，然后人为把「另一个程序」放到前面：
     用记事本挡是不行的（判据不该依赖用户桌面上有什么），所以改用**另一个 Chrome 窗口**当遮挡物：
     把受控 2 抬到前面（它现在也是 normal），受控 1 就在后面。 */
  await setState(started[2], 'normal');
  await setRect(started[1], 900, 120, 700, 480);
  await setRect(started[2], 900, 120, 700, 480); // 故意重叠：谁后动谁在上面
  await sleep(300);

  /* 默认档：受控 1 是 normal，只做页面级激活 —— 这里先记一次基线 */
  const g0 = await rectOf(started[1]);
  const rG0 = await sync.showWindows([started[1]]);
  check('G 前置：受控 1 是 normal（不是最小化）', g0.state === 'normal', g0.state);
  check('G 默认档报 page_only（抬不动就不假装抬动了）',
    rG0.shown?.[0]?.raise === 'page_only' && rG0.os_foreground === false,
    JSON.stringify({ raise: rG0.shown?.[0]?.raise, os: rG0.os_foreground }));

  const gBefore = await rectOf(started[1]);
  const rG = await sync.forceShowWindows([started[1]]);
  const gAfter = await rectOf(started[1]);
  const gFg = fgTitleIs('fp-show-slave1');
  console.log(`  force 前 ${rectStr(gBefore)} → force 后 ${rectStr(gAfter)}；OS 前台「${gFg.title}」`);

  check('G force 回报 ok=true、raise=restored、state_after=normal',
    rG.forced?.[0]?.ok === true && rG.forced?.[0]?.raise === 'restored' && rG.forced?.[0]?.state_after === 'normal',
    JSON.stringify({ ok: rG.forced?.[0]?.ok, raise: rG.forced?.[0]?.raise, after: rG.forced?.[0]?.state_after }));
  check('G force 之后**真的成了 ③ OS 前台**（Win32 读数）', gFg.hit, `前台「${gFg.title}」`);
  check('G 位置尺寸原样（minimize→restore 不搬窗口）', sameRect(gBefore, gAfter),
    `${rectStr(gBefore)} vs ${rectStr(gAfter)}`);
  check('G 汇总：说「已恢复显示并尝试置前」，不说「已置前」，confirmed=window_restored',
    /已恢复显示并尝试置前 1 个窗口/.test(rG.summary?.message || '')
      && !/已置前/.test(rG.summary?.message || '')
      && rG.summary?.confirmed === 'window_restored'
      && rG.os_foreground_confirmed === false,
    JSON.stringify({ msg: rG.summary?.message, c: rG.summary?.confirmed }));

  /* 全屏窗口不该被 force 动 */
  await setState(started[2], 'fullscreen');
  const gFull = await rectOf(started[2]);
  const rGf = await sync.forceShowWindows([started[2]]);
  const gFullAfter = await rectOf(started[2]);
  check('G 全屏窗口：force 直接跳过（action=skip），状态一点没动',
    rGf.forced?.[0]?.action === 'skip' && gFullAfter.state === 'fullscreen',
    `${gFull.state} → ${gFullAfter.state}`);
  await setState(started[2], 'normal');

  /* ------------------ F. 内核死掉的窗口：如实报，不拖垮其它窗口 ------------------ */
  console.log('\n— F. 一个内核死掉：那条 ok=false 且有原因，其它窗口照常 —');
  const victim = started[2];
  try { process.kill(manager.getInstance(victim).pid, 'SIGKILL'); } catch { /* 已经没了也算 */ }
  await sleep(1200);
  await setState(started[1], 'minimized');
  const rF = await sync.showWindows([victim, started[1]]);
  const fBad = (rF.shown || []).find((x) => x.profile_id === victim) || {};
  const fGood = (rF.shown || []).find((x) => x.profile_id === started[1]) || {};
  check('F 坏的那条 ok=false 且有原因', fBad.ok === false && !!(fBad.reason || fBad.problems?.length),
    `${fBad.ok} / ${fBad.reason}`);
  check('F 好的那条照常 recovered（restored + ok）', fGood.ok === true && fGood.raise === 'restored',
    JSON.stringify({ ok: fGood.ok, raise: fGood.raise }));
  check('F 汇总 ok=false、failed=1，文案说「有 1 个窗口没能显示出来」',
    rF.summary?.ok === false && rF.summary?.failed === 1 && /有 1 个窗口没能显示出来/.test(rF.summary?.message || ''),
    rF.summary?.message);
} catch (e) {
  console.log('异常：', e && e.stack ? e.stack.split('\n').slice(0, 6).join(' | ') : e);
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
