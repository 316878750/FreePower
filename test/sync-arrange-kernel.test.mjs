/**
 * 窗口排列的 B 层判据：**真内核、1 主 + 2 受控**。
 *
 * CEO 点的判据，逐条断言：
 *   ① 2 个窗口 → 不重叠、都在目标显示器 workArea 内、间距等于设定值；
 *   ② 每行 2 个时第 3 个换行；
 *   ③ 受控窗口原本最大化 → 也能排到位（先回 normal，否则宽高会被静默忽略）；
 *   ③ 做不到 / 改不动要能报出来：
 *      ③a 宽度小于系统下限 516 → 出计划前就夹到 516 并 warn（不静默给一个做不到的数）；
 *      ③b 杀掉一个内核 → 如实 ok:false + 原因，汇总「有 N 个窗口没能排到位」，其它窗口不受影响。
 *
 * 两条只在这里能证明的事：
 *   - **原点用 workArea 不是 bounds**：测试写的 displays.json 里两块矩形故意不同
 *     （bounds.y=0 / workArea.y=60），实现用错了一眼就看出来（y 会差 60）。
 *   - **成功只认回读**：所有断言读 `Browser.getWindowForTarget` 的实测 left/top/width/height，
 *     不读 arrangeWindows 自己回报的数字。
 *
 * 跑法：npm run test:sync-arrange-kernel（起 3 个真环境，约 40 秒）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dataDir = path.join(os.tmpdir(), `freepower-arrange-${Date.now()}`);
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
process.env.FREEPOWER_EGRESS_TIMEOUT = '800';

const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end('<!doctype html><title>arrange</title><h1>arrange</h1>');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const U = (p) => `http://127.0.0.1:${PORT}${p}`;

const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');
const sync = await import('../src/sync/session.js');
const { writeDisplays } = await import('../src/sync/displays.js');

/**
 * 目标显示器：故意让 workArea 和 bounds 不一样（模拟任务栏/停靠栏占掉一条）。
 * 尺寸控制在真机屏幕内（本机 3440×1440），这样窗口位置不会被系统夹掉。
 */
const WA = { x: 40, y: 60, width: 1400, height: 820 };
const FAKE_SCREEN = [{
  id: 7, label: '判据屏', primary: true, scaleFactor: 1,
  bounds: { x: 0, y: 0, width: WA.width + 80, height: WA.height + 100 },
  workArea: { ...WA },
}];

const started = [];

/** 直接读 CDP 的窗口实测矩形（判据只认这个） */
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
const rectsOf = (ids) => Promise.all(ids.map(rectOf));

async function maximize(id) {
  const inst = manager.getInstance(id);
  const w = await rectOf(id);
  await inst.client.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'maximized' } });
  await sleep(350);
}

const overlapsAny = (list) => {
  const hits = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]; const b = list[j];
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) hits.push([i, j]);
    }
  }
  return hits;
};
const insideWA = (r) => r.x >= WA.x && r.y >= WA.y
  && r.x + r.width <= WA.x + WA.width && r.y + r.height <= WA.y + WA.height;

try {
  for (const name of ['arr-master', 'arr-slave1', 'arr-slave2']) {
    const p = profiles.createProfile({ name: `${name}-${Date.now()}`, group_id: '0', remark: '窗口排列 B 层判据' });
    const st = await manager.startProfile(profiles.getProfile(p.profile_id));
    started.push(p.profile_id);
    console.log(`环境 ${name} = ${p.profile_id} · 内核 ${st.real_version}`);
  }
  for (const id of started) await manager.getInstance(id).openPage(U('/base'));
  await sleep(2500);

  const st = await sync.startSync({ masterId: started[0], slaveIds: [started[1], started[2]], settings: {}, rngSeed: 4242 });
  check('会话起来了（1 主 + 2 受控）', st.running === true && st.windows.length === 3,
    JSON.stringify(st.windows.map((w) => w.role)));

  check('显示器交接写成功（桌面壳那一侧的入口）', writeDisplays(FAKE_SCREEN) === true);

  /* ------------------ ① 网格：3 个窗口、每行 2 个 → 第 3 个换行 ------------------ */
  console.log('\n— ① 每行 2 个、3 个窗口 → 第 3 个换行；不重叠、都在 workArea 内、间距 = 设定值 —');
  const P1 = { width: 600, height: 350, row: 2, hs: 25, vs: 35, left: 10, top: 10 };
  const r1 = await sync.arrangeWindows(P1);
  const a1 = await rectsOf(started);
  console.log(`排列后：${a1.map((w) => `${w.x},${w.y} ${w.width}×${w.height}(${w.state})`).join(' / ')}`);

  check('回报里 3 条记录、每一条 ok=true（回读通过才算成功）',
    (r1.placed || []).length === 3 && (r1.placed || []).every((x) => x.ok === true),
    JSON.stringify((r1.placed || []).map((x) => ({ ok: x.ok, actual: x.actual }))));
  check('三个窗口都是 normal', a1.every((w) => w.state === 'normal'), a1.map((w) => w.state).join(' / '));
  check('三个窗口尺寸都是设定值 600×350', a1.every((w) => w.width === 600 && w.height === 350),
    a1.map((w) => `${w.width}×${w.height}`).join(' / '));
  check('① 原点 = workArea.x + left（不是 bounds 的 0）', a1[0].x === WA.x + P1.left, `实际 ${a1[0].x}，期望 ${WA.x + P1.left}`);
  check('① 原点 = workArea.y + top（bounds.y=0，用错会差 60）', a1[0].y === WA.y + P1.top, `实际 ${a1[0].y}，期望 ${WA.y + P1.top}`);
  check('① 水平间距 = hs（25）', a1[1].x - (a1[0].x + 600) === P1.hs, `实际 ${a1[1].x - (a1[0].x + 600)}`);
  check('② 第 3 个换行：x 回到起始列、y 下移 = height + vs',
    a1[2].x === a1[0].x && a1[2].y === a1[0].y + P1.height + P1.vs,
    `${a1[2].x},${a1[2].y} vs 期望 ${a1[0].x},${a1[0].y + P1.height + P1.vs}`);
  check('① 三个窗口互不重叠', overlapsAny(a1).length === 0, JSON.stringify(overlapsAny(a1)));
  check('① 三个窗口都在目标显示器 workArea 内', a1.every(insideWA), JSON.stringify(a1.map((w) => [w.x, w.y])));
  check('① 汇总说「已排列 3 个窗口」', r1.summary?.ok === true && /已排列 3 个窗口/.test(r1.summary?.message || ''), r1.summary?.message);
  check('① 计划自检无重叠无越界', r1.audit?.ok === true, JSON.stringify(r1.audit));
  check('① 没有「没有显示器信息」的 warning（说明用上了 workArea）',
    !(r1.warnings || []).some((w) => /没有显示器信息/.test(w)), JSON.stringify(r1.warnings));

  /* ------------------ ② 受控窗口原本最大化 → 也要排到位 ------------------ */
  console.log('\n— ② 受控窗口原本最大化 → 也要排到位（先回 normal 再摆）—');
  await maximize(started[2]);
  const maxed = await rectOf(started[2]);
  check('前置条件：受控 2 确实是 maximized', maxed.state === 'maximized', JSON.stringify(maxed));

  const P2 = { width: 520, height: 400, row: 1, hs: 0, vs: 12, left: 30, top: 20 };
  const r2 = await sync.arrangeWindows(P2);
  const a2 = await rectsOf(started);
  console.log(`排列后：${a2.map((w) => `${w.x},${w.y} ${w.width}×${w.height}(${w.state})`).join(' / ')}`);
  check('② 最大化那个窗口也回到 normal + 计划里的位置',
    a2[2].state === 'normal' && a2[2].x === WA.x + P2.left
      && a2[2].y === WA.y + P2.top + 2 * (P2.height + P2.vs)
      && a2[2].width === P2.width && a2[2].height === P2.height,
    JSON.stringify(a2[2]));
  check('② 回报里记下了它原来是 maximized（如实带出去）',
    (r2.placed || []).find((x) => x.profile_id === started[2])?.state_before === 'maximized',
    JSON.stringify((r2.placed || []).map((x) => x.state_before)));
  check('② 每行 1 个 → 横向不动、纵向按 height+vs 递增',
    a2[1].x === a2[0].x && a2[2].x === a2[0].x
      && a2[1].y === a2[0].y + P2.height + P2.vs && a2[2].y === a2[1].y + P2.height + P2.vs,
    a2.map((w) => `${w.x},${w.y}`).join(' / '));
  check('② 全部 ok=true', r2.summary?.ok === true, r2.summary?.message);

  /* ------------------ ③ 改不动 / 做不到都要能报出来 ------------------ */
  console.log('\n— ③a 宽度小于系统下限（516）→ 参数归一就夹上去并说明，不许静默给一个做不到的数 —');
  // 实测读数（.tmp/min-width-probe.mjs）：请求 300 宽，系统给 516，而 setWindowBounds 返回成功。
  // 所以「不静默」的正确做法是在**出计划之前**就夹到 516 并 warn，而不是事后报一堆失败。
  const r3a = await sync.arrangeWindows({ width: 300, height: 320, row: 2, hs: 10, vs: 10, left: 0, top: 0 });
  const a3a = await rectsOf(started);
  console.log(`请求 300 宽之后：${a3a.map((w) => `${w.x},${w.y} ${w.width}×${w.height}`).join(' / ')}`);
  check('③a 三个窗口实际宽度都是 516（系统下限，命令本身不会报错）',
    a3a.every((w) => w.width === 516), a3a.map((w) => w.width).join(' / '));
  check('③a 回报里带着「窗口宽度 300 超出范围，按 516 处理」（不静默）',
    (r3a.warnings || []).some((w) => /窗口宽度 300 超出范围，按 516 处理/.test(w)), JSON.stringify(r3a.warnings));
  check('③a 计划按 516 出，回读也就对得上（不是「假装 300 成功」）',
    (r3a.placed || []).every((x) => x.expected?.width === 516 && x.actual?.width === 516),
    JSON.stringify((r3a.placed || []).map((x) => [x.expected?.width, x.actual?.width])));
  check('③a 间距按 516 的宽度算，窗口仍然互不重叠', overlapsAny(a3a).length === 0, JSON.stringify(overlapsAny(a3a)));

  console.log('\n— ③b 内核死掉的窗口：必须如实报，不许当成功，也不许拖垮其它窗口 —');
  const victim = started[1];
  const victimPid = manager.getInstance(victim).pid;
  try { process.kill(victimPid, 'SIGKILL'); } catch { /* 已经没了也算 */ }
  await sleep(1200);
  let crashed = null;
  try { await rectOf(victim); } catch (e) { crashed = e?.message || String(e); }
  check('前置条件：这张窗口确实读不到了（内核已死）', !!crashed, crashed || '（居然还读得到）');

  const r3 = await sync.arrangeWindows({ width: 600, height: 320, row: 2, hs: 10, vs: 10, left: 0, top: 0 });
  const bad = (r3.placed || []).filter((x) => !x.ok);
  check('③b 回报里这一条 ok=false', bad.length === 1,
    JSON.stringify((r3.placed || []).map((x) => ({ id: String(x.profile_id).slice(0, 8), ok: x.ok }))));
  check('③b 汇总文案是「有 1 个窗口没能排到位」',
    r3.summary?.ok === false && r3.summary?.failed === 1 && /有 1 个窗口没能排到位/.test(r3.summary?.message || ''),
    r3.summary?.message);
  check('③b 失败原因如实带出（不是空话）', !!(r3.summary?.details?.[0]?.reason), r3.summary?.details?.[0]?.reason);
  check('③b 主控与另一个受控仍然排到位（一个坏的没拖垮全部）',
    (r3.placed || []).filter((x) => x.ok).length === 2,
    JSON.stringify((r3.placed || []).map((x) => x.ok)));
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