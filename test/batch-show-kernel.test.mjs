/**
 * 批量「显示窗口」（0.4.3 ③）判据 —— B 层：**真内核**。
 *
 * 与 `sync-show-kernel.test.mjs` 的区别：那一份验的是**同步会话里**的显示窗口；
 * 这一份验的是**环境列表里勾选一批、直接点「显示窗口」**那条路（不要求开同步会话）。
 * 判定逻辑是同一份（`src/sync/show.js` 的 planShow / verifyShown / summarizeShow），
 * 但这里的两个读取器（页面 target、窗口矩形）是新的，所以必须真起内核读一次。
 *
 * 验四件事：
 *   A. 最小化的窗口 → `raise: 'restored'`、`windowState` 回读 normal、位置尺寸**一个像素没被搬**；
 *   B. 没最小化（只是没在前台）→ 如实报 `page_only`、`os_foreground: false`（不假装置前）；
 *   C. `force:true`（用户显式点「强制抬到前台」）→ 做一次 minimize→restore，回读 normal，且位置尺寸回到原样；
 *   D. 没在跑的环境 → `skipped: not_running`，不拖垮整批。
 *
 * 跑法：node --no-warnings test/batch-show-kernel.test.mjs   （约 30–50 秒）
 * 注意：这个套件会**真的动 Chrome 窗口**（最小化 / 恢复），这就是被测行为。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = path.join(os.tmpdir(), `freepower-batch-show-${Date.now()}`);
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
process.env.FREEPOWER_EGRESS_TIMEOUT = '800';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');
const dbmod = await import('../src/store/db.js');
const { createApiServer } = await import('../src/api/server.js');
const { showWindowsOfProfiles } = await import('../src/sync/batch-show.js');

const started = [];
let server = null;

/** 读窗口矩形 + 状态（判据自己的读数，不借用被测代码的私有函数） */
async function rectOf(id) {
  const inst = manager.getInstance(id);
  const { targetInfos = [] } = await inst.client.send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page');
  const { windowId, bounds } = await inst.client.send('Browser.getWindowForTarget', { targetId: page.targetId });
  return {
    x: bounds?.left ?? null, y: bounds?.top ?? null,
    width: bounds?.width ?? null, height: bounds?.height ?? null,
    state: bounds?.windowState || null, windowId,
  };
}

try {
  const { server: srv } = createApiServer();
  server = srv;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const p1 = profiles.createProfile({ name: `show-k1-${Date.now()}`, group_id: '0' });
  const p2 = profiles.createProfile({ name: `show-k2-${Date.now()}`, group_id: '0' });
  const p3 = profiles.createProfile({ name: `show-k3-${Date.now()}`, group_id: '0' });  // 不启动

  console.log('— 起两个真内核 —');
  for (const p of [p1, p2]) {
    const st = await manager.startProfile(profiles.getProfile(p.profile_id));
    started.push(p.profile_id);
    console.log(`  ${p.name}: pid=${st.pid} 内核 ${st.real_version}`);
  }
  await sleep(800);

  /* ---------------- A. 最小化 → 批量显示 → 恢复且不搬位置 ---------------- */
  console.log('\n— A. 最小化的窗口：批量「显示窗口」要真恢复，且位置尺寸不许被搬 —');
  const before1 = await rectOf(p1.profile_id);
  await manager.getInstance(p1.profile_id).client.send('Browser.setWindowBounds', {
    windowId: before1.windowId, bounds: { windowState: 'minimized' },
  });
  await sleep(600);
  const minimized = await rectOf(p1.profile_id);
  check('前置条件：窗口真的被最小化了（不是假装）', minimized.state === 'minimized', String(minimized.state));

  const r1 = await showWindowsOfProfiles([p1.profile_id]);
  const e1 = (r1.shown || [])[0];
  const after1 = await rectOf(p1.profile_id);
  check('最小化的窗口：raise=restored（这一档是真到前台）',
    e1?.raise === 'restored' && e1?.ok === true, JSON.stringify({ raise: e1?.raise, ok: e1?.ok, reason: e1?.reason }));
  check('回读 windowState 是 normal（不是只回了个 code=0）', after1.state === 'normal', String(after1.state));
  check('恢复后位置尺寸一个像素都没被搬（多屏窗口不会被拉回主屏）',
    after1.x === before1.x && after1.y === before1.y
    && after1.width === before1.width && after1.height === before1.height,
    JSON.stringify({ before: before1, after: after1 }));

  /* ---------------- B. 没最小化 → page_only，如实说 ---------------- */
  console.log('\n— B. 没最小化的窗口：只能页面级激活，如实报 page_only —');
  const r2 = await showWindowsOfProfiles([p2.profile_id]);
  const e2 = (r2.shown || [])[0];
  check('没最小化：raise=page_only、并且 os_foreground=false（不假装已经置前）',
    e2?.raise === 'page_only' && r2.os_foreground === false,
    JSON.stringify({ raise: e2?.raise, os: r2.os_foreground }));
  check('page_only 也带页面焦点读数（作参考，不当成功）',
    e2?.page_focused !== undefined, JSON.stringify(e2?.page_focused));
  check('汇总文案直说「可能仍被其它窗口盖住」',
    /盖住/.test(String(r2.summary?.message || '')), String(r2.summary?.message));

  /* ---------------- C. 强制置前（显式动作） ---------------- */
  console.log('\n— C. 强制抬到前台：做一次 minimize→restore，回读 normal、位置回到原样 —');
  const before2 = await rectOf(p2.profile_id);
  const r3 = await showWindowsOfProfiles([p2.profile_id], { force: true });
  const e3 = (r3.shown || [])[0];
  const after2 = await rectOf(p2.profile_id);
  check('强制：action=force、raise=restored、ok=true',
    e3?.action === 'force' && e3?.raise === 'restored' && e3?.ok === true,
    JSON.stringify({ a: e3?.action, r: e3?.raise, ok: e3?.ok, reason: e3?.reason }));
  check('强制后回读 windowState=normal', after2.state === 'normal', String(after2.state));
  check('强制之后位置尺寸回到原样（动过窗口也要还原，不许把窗口挪走）',
    after2.x === before2.x && after2.y === before2.y
    && after2.width === before2.width && after2.height === before2.height,
    JSON.stringify({ before: before2, after: after2 }));
  check('强制档的汇总明说只确认了「窗口已恢复」，没确认在最前面',
    r3.summary?.confirmed === 'window_restored' && r3.force === true,
    JSON.stringify({ c: r3.summary?.confirmed, f: r3.force }));
  check('默认档（不点按钮）的返回值里 force=false（不是偷偷自动做）', r2.force === false, String(r2.force));

  /* ---------------- D. 没在跑的环境 ---------------- */
  console.log('\n— D. 混进一个没在跑的环境：skipped 点名，不拖垮整批 —');
  const r4 = await showWindowsOfProfiles([p1.profile_id, p3.profile_id]);
  check('没在跑的那条进 skipped=not_running，在跑的那条照常处理',
    (r4.skipped || []).some((s) => s.profile_id === p3.profile_id && s.reason === 'not_running')
    && (r4.shown || []).length === 1,
    JSON.stringify({ shown: (r4.shown || []).length, skipped: r4.skipped }));
} catch (e) {
  check('B 层跑完没有抛异常', false, `${e && e.message}`);
  console.error(e);
} finally {
  for (const id of started) await manager.stopProfile(id).catch(() => {});
  if (server) server.close();
  dbmod.closeDb();
  await sleep(300);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄还在 */ }
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);