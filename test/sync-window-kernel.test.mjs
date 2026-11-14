/**
 * 统一尺寸的 B 层判据：**真内核、1 主 + 2 受控**。
 *
 * CEO 点的三条，逐条断言：
 *   ① 主控/受控原本都是 normal，设成不同尺寸 → 统一尺寸后三个窗口 windowState=normal、
 *      外框宽高全等于主控；
 *   ② 受控窗口原本**最大化** → 也能改成功（这条是「先回 normal 再设宽高」的判据：
 *      不先恢复的话 setWindowBounds 的宽高会被静默忽略）；
 *   ③ 「改不了」要能报出来：把受控窗口的内核杀掉，统一尺寸必须如实记 ok:false + 原因，
 *      汇总文案是「有 N 个窗口没能改成同尺寸」，**不许当成功**。
 *
 * 为什么每条都要回读：`Browser.setWindowBounds` 返回成功不代表窗口真的变了。
 * 这里所有断言读的都是 `Browser.getWindowForTarget` 的**实测值**，不是命令返回值。
 *
 * 跑法：npm run test:sync-window-kernel（起 3 个真环境，约 40 秒）
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

const dataDir = path.join(os.tmpdir(), `freepower-winsize-${Date.now()}`);
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
process.env.FREEPOWER_EGRESS_TIMEOUT = '800';

const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end('<!doctype html><title>w</title><h1>w</h1>');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const U = (p) => `http://127.0.0.1:${PORT}${p}`;

const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');
const sync = await import('../src/sync/session.js');

const started = [];
let insts = [];

/** 直接读 CDP 的窗口实测值（判据只认这个，不读产品回报里的数字） */
async function winOf(id) {
  const inst = manager.getInstance(id);
  const { targetInfos } = await inst.client.send('Target.getTargets');
  const page = (targetInfos || []).filter((t) => t.type === 'page')
    .find((t) => t.url && !t.url.startsWith('about:blank') && !t.url.startsWith('chrome://newtab'))
    || (targetInfos || []).find((t) => t.type === 'page');
  const { windowId, bounds } = await inst.client.send('Browser.getWindowForTarget', { targetId: page.targetId });
  return { windowId, width: bounds?.width ?? null, height: bounds?.height ?? null, state: bounds?.windowState || 'normal' };
}

/** 把某个窗口设成给定尺寸（先回 normal） */
async function setSize(id, width, height) {
  const inst = manager.getInstance(id);
  const w = await winOf(id);
  await inst.client.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'normal' } });
  await sleep(150);
  await inst.client.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { width, height } });
  await sleep(250);
}

async function maximize(id) {
  const inst = manager.getInstance(id);
  const w = await winOf(id);
  await inst.client.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'maximized' } });
  await sleep(300);
}

try {
  for (const name of ['win-master', 'win-slave1', 'win-slave2']) {
    const p = profiles.createProfile({ name: `${name}-${Date.now()}`, group_id: '0', remark: '统一尺寸 B 层判据' });
    const st = await manager.startProfile(profiles.getProfile(p.profile_id));
    started.push(p.profile_id);
    console.log(`环境 ${name} = ${p.profile_id} · 内核 ${st.real_version}`);
  }
  insts = started.map((id) => manager.getInstance(id));
  for (const inst of insts) await inst.openPage(U('/base'));
  await sleep(2500);

  const st = await sync.startSync({ masterId: started[0], slaveIds: [started[1], started[2]], settings: {}, rngSeed: 4242 });
  check('会话起来了（1 主 + 2 受控）', st.running === true && st.windows.length === 3,
    JSON.stringify(st.windows.map((w) => w.role)));

  /* ------------------ ① 三个 normal 窗口、尺寸不同 → 统一 ------------------ */
  console.log('\n— ① 三个普通窗口，尺寸不同 → 统一成主控的尺寸 —');
  await setSize(started[0], 1000, 700);
  await setSize(started[1], 800, 600);
  await setSize(started[2], 900, 650);
  const before = await Promise.all(started.map(winOf));
  console.log(`统一前：${before.map((w) => `${w.width}×${w.height}(${w.state})`).join(' / ')}`);
  check('前置条件：三个窗口确实不一样大', new Set(before.map((w) => `${w.width}x${w.height}`)).size === 3,
    before.map((w) => `${w.width}×${w.height}`).join(' / '));

  const r1 = await sync.unifySize();
  const after1 = await Promise.all(started.map(winOf));
  console.log(`统一后：${after1.map((w) => `${w.width}×${w.height}(${w.state})`).join(' / ')}`);
  check('统一尺寸回报里参考尺寸 = 主窗口实测尺寸',
    r1.reference.width === after1[0].width && r1.reference.height === after1[0].height,
    `${r1.reference.width}×${r1.reference.height} vs 主 ${after1[0].width}×${after1[0].height}`);
  check('三个窗口外框宽高全相等', after1.every((w) => w.width === after1[0].width && w.height === after1[0].height),
    after1.map((w) => `${w.width}×${w.height}`).join(' / '));
  check('三个窗口 windowState 都是 normal', after1.every((w) => w.state === 'normal'),
    after1.map((w) => w.state).join(' / '));
  check('统一尺寸回报里每一条 ok=true（回读通过才算成功）',
    (r1.resized || []).length === 2 && (r1.resized || []).every((x) => x.ok === true),
    JSON.stringify((r1.resized || []).map((x) => ({ ok: x.ok, actual: x.actual }))));
  check('汇总说「已把 2 个窗口改成同尺寸」', r1.summary?.ok === true && /已把 2 个窗口改成同尺寸/.test(r1.summary?.message || ''),
    r1.summary?.message);

  /* ------------------ ② 受控窗口原本最大化 → 也能改成功 ------------------ */
  console.log('\n— ② 受控窗口原本最大化 → 也要能改成功（先回 normal 再设宽高）—');
  /**
   * **先把受控 1 设成一个和主控不同的尺寸，再最大化。**
   * 为什么必须这么做（2026-11-14 实测，见 .tmp/window-state-probe.mjs）：
   * 最大化 / 最小化 / 全屏状态下只发 width+height，命令返回 **ok**，但宽高**被忽略** ——
   * 窗口只是回到 normal，尺寸是它**原来的**那个。所以如果恢复后的旧尺寸刚好等于目标尺寸，
   * 这条判据就抓不住「没先回 normal」的实现（第一次变异就是这么漏过去的：16/16 全绿）。
   * 现在把它设成 850×620 ≠ 主控 1000×700，漏做恢复就会停在 850×620。
   */
  await setSize(started[1], 850, 620);
  const preMax = await winOf(started[1]);
  const masterNow = await winOf(started[0]);
  check('前置条件：受控 1 的 normal 尺寸 ≠ 主控尺寸（否则下面那条抓不住）',
    preMax.width !== masterNow.width || preMax.height !== masterNow.height,
    `${preMax.width}×${preMax.height} vs 主控 ${masterNow.width}×${masterNow.height}`);
  await maximize(started[1]);
  const maxed = await winOf(started[1]);
  check('前置条件：受控 1 确实是 maximized', maxed.state === 'maximized', JSON.stringify(maxed));

  const r2 = await sync.unifySize();
  const after2 = await Promise.all(started.map(winOf));
  console.log(`统一后：${after2.map((w) => `${w.width}×${w.height}(${w.state})`).join(' / ')}`);
  check('最大化那个窗口也被改成了 normal + 主控尺寸',
    after2[1].state === 'normal' && after2[1].width === after2[0].width && after2[1].height === after2[0].height,
    JSON.stringify(after2[1]));
  check('回报里记下了它原来是 maximized（如实带出去）',
    (r2.resized || []).find((x) => x.profile_id === started[1])?.state_before === 'maximized',
    JSON.stringify((r2.resized || []).map((x) => x.state_before)));
  check('② 全部 ok=true', r2.summary?.ok === true, r2.summary?.message);

  /* ------------------ ③ 改不了要能报出来 ------------------ */
  console.log('\n— ③ 改不了的情况：杀掉受控窗口的内核 → 必须如实报，不许当成功 —');
  const victim = started[2];
  const victimPid = manager.getInstance(victim).pid;
  try { process.kill(victimPid, 'SIGKILL'); } catch { /* 已经没了也算 */ }
  await sleep(1200);
  let crashed = null;
  try { await winOf(victim); } catch (e) { crashed = e?.message || String(e); }
  check('前置条件：这张窗口确实读不到了（内核已死）', !!crashed, crashed || '（居然还读得到）');

  const r3 = await sync.unifySize();
  const bad = (r3.resized || []).filter((x) => !x.ok);
  check('③ 回报里这一条 ok=false', bad.length === 1, JSON.stringify((r3.resized || []).map((x) => ({ id: x.profile_id.slice(0, 8), ok: x.ok }))));
  check('③ 汇总文案是「有 1 个窗口没能改成同尺寸」',
    r3.summary?.ok === false && r3.summary?.failed === 1 && /有 1 个窗口没能改成同尺寸/.test(r3.summary?.message || ''),
    r3.summary?.message);
  check('③ 失败原因如实带出（不是空话）', !!(r3.summary?.details?.[0]?.reason),
    r3.summary?.details?.[0]?.reason);
  check('③ 主窗口与另一个受控窗口仍然正常（一个坏的不该拖垮全部）',
    (r3.resized || []).filter((x) => x.ok).length === 1,
    JSON.stringify((r3.resized || []).map((x) => x.ok)));
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
