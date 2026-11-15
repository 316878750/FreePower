/**
 * 关闭环境时自动备份（0.4.7 ③）判据 —— A 层：不起内核，几秒跑完。
 *
 * 这一项最容易骗自己的地方，按顺序：
 *
 *   1. **「默认关」≠「代码里写着默认关」**。必须断言：没存过开关时读出来是 `false`，
 *      而且关着的时候**快照目录里一份都不多** —— 不是「没触发」，是盘上真的没有新东西。
 *   2. **关着的时候一次都不许造**：连拍两次 stop 之后，快照目录必须**一个子目录都没有**。
 *      只看返回 `created:false` 不够 —— 那是「我以为没造」。
 *   3. **自动备份失败不许影响关环境**：把快照写不进去（注入失败的 fsx / 把目录占住）时，
 *      `stopProfile` 必须照常返回 `stopped:true`，且状态里能看见「上次自动备份失败」。
 *   4. **池子满时不许挤掉 `before_restore`**：那是「恢复错了还能退回来」的唯一退路。
 *      关环境自动备份会让池子更快满，所以这条必须单独钉。
 *   5. 走的是 `on_close` 那个 reason（不是 manual / before_restore），且**记录为静态断言**。
 *
 * 真内核那部分（真启动 → 真停止 → 断言快照真的出现/没出现）在 B 层
 * `test/snapshot-on-close-kernel.test.mjs`。
 *
 * 跑法：node --no-warnings test/snapshot-on-close.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = path.join(os.tmpdir(), `freepower-onclose-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_SELFCHECK = '0';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const prefs = await import('../src/settings/prefs.js');
  const snap = await import('../src/store/snapshots.js');
  const prof = await import('../src/store/profiles.js');
  const manager = await import('../src/runtime/manager.js');
  const { createApiServer } = await import('../src/api/server.js');

  const dirOf = (p) => manager.userDataDirFor(prof.getProfile(p.profile_id || p.id));
  function makeUserdata(p, { marker = 'x' } = {}) {
    const dir = dirOf(p);
    fs.mkdirSync(path.join(dir, 'Default', 'Cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Default', 'Cache', 'data_0'), Buffer.alloc(2048, 3));
    fs.writeFileSync(path.join(dir, 'Default', 'Cookies'), 'fake-sqlite');
    fs.writeFileSync(path.join(dir, marker), 'v');
    return dir;
  }
  /** 快照目录下有几个子目录（**盘上的真相**，不看返回值） */
  const snapDirsOnDisk = (profileId) => {
    try {
      return fs.readdirSync(snap.profileSnapshotsDir(profileId)).filter((n) => !n.startsWith('.')).length;
    } catch { return 0; }
  };

  /* ==================== 1. 默认必须是关 ==================== */
  console.log('\n— 1. 默认关（没存过就是关） —');
  {
    const r = prefs.readSnapshotOnClose();
    check('没存过开关 → `enabled:false`（**默认关**，不替用户决定占磁盘）',
      r.enabled === false && r.saved === false && r.broken === false, JSON.stringify(r));

    // 存坏了也必须当关（这是会占磁盘的开关，读不懂就偏向「不占」）
    const { setMeta } = await import('../src/store/db.js');
    setMeta(prefs.SNAPSHOT_ON_CLOSE_KEY, 'yes-please');
    const broken = prefs.readSnapshotOnClose();
    check('库里存了读不懂的值 → 仍按关处理，且 `broken:true` 如实报',
      broken.enabled === false && broken.broken === true, JSON.stringify(broken));
    setMeta(prefs.SNAPSHOT_ON_CLOSE_KEY, '');
    check('清掉之后回到「没存过」', prefs.readSnapshotOnClose().saved === false);

    check('写 `true` → 读回 true；写 `false` → 读回 false',
      prefs.writeSnapshotOnClose(true).enabled === true && prefs.readSnapshotOnClose().enabled === true
      && prefs.writeSnapshotOnClose(false).enabled === false && prefs.readSnapshotOnClose().enabled === false);
    let threw = null;
    try { prefs.writeSnapshotOnClose('maybe'); } catch (e) { threw = e.code; }
    check('写非布尔（`maybe`）→ 抛 `INVALID_ENABLED`，不猜用户意图', threw === 'INVALID_ENABLED', String(threw));
  }

  /* ==================== 2. 关着的时候：一次都不许造 ==================== */
  console.log('\n— 2. 关着的时候一次都不许造（盘上真的没有新东西） —');
  {
    prefs.writeSnapshotOnClose(false);
    const p = prof.createProfile({ name: `onclose-off-${Date.now()}`, group_id: '0' });
    makeUserdata(p);
    check('（前提）关着时快照目录里 0 份', snapDirsOnDisk(p.profile_id) === 0);

    // 直接打「关环境时会调的那个函数」：它就是 stopProfile 里那一步
    const r1 = await manager.autoSnapshotOnClose(p.profile_id);
    const r2 = await manager.autoSnapshotOnClose(p.profile_id);
    check('关着时调自动备份 → `created:false` + `reason:disabled`',
      r1.created === false && r1.reason === 'disabled' && r2.created === false, JSON.stringify(r1));
    check('**盘上一份都没多**（不是「没触发」，是真的没有新目录）',
      snapDirsOnDisk(p.profile_id) === 0, String(snapDirsOnDisk(p.profile_id)));
    check('`listSnapshots` 也是空（没有 meta.json 被写出来）',
      snap.listSnapshots(p.profile_id).length === 0);
    check('关着的时候**连状态都不记**（不写「上次自动备份」）',
      prefs.readSnapshotOnCloseState(p.profile_id) === null,
      JSON.stringify(prefs.readSnapshotOnCloseState(p.profile_id)));
  }

  /* ==================== 3. 开着的时候：造一份，reason=on_close ==================== */
  console.log('\n— 3. 开着的时候：造一份，reason=on_close、不算「运行中拍摄」 —');
  {
    prefs.writeSnapshotOnClose(true);
    const p = prof.createProfile({ name: `onclose-on-${Date.now()}`, group_id: '0' });
    makeUserdata(p);

    const r = await manager.autoSnapshotOnClose(p.profile_id);
    check('开着时调自动备份 → `created:true` 且带 snapshot',
      r.created === true && !!r.snapshot?.snap_id, JSON.stringify({ created: r.created, reason: r.reason }));
    check('**reason 是 `on_close`**（不是 manual / before_restore —— 界面上要能分清是谁拍的）',
      r.snapshot?.reason === 'on_close' && r.snapshot?.reason_label === '关闭环境时自动',
      `${r.snapshot?.reason} / ${r.snapshot?.reason_label}`);
    check('盘上真的多了一份', snapDirsOnDisk(p.profile_id) === 1, String(snapDirsOnDisk(p.profile_id)));
    check('`taken_while_running:false`（刚停的内核，数据是静的，跟「运行中拍摄」不是一回事）',
      r.snapshot?.taken_while_running === false, String(r.snapshot?.taken_while_running));
    check('快照里含 userdata（Cookies 在、Cache 不在）',
      fs.existsSync(path.join(snap.snapshotDirFor(p.profile_id, r.snapshot.snap_id), 'userdata', 'Default', 'Cookies'))
      && !fs.existsSync(path.join(snap.snapshotDirFor(p.profile_id, r.snapshot.snap_id), 'userdata', 'Default', 'Cache')));
    check('状态记成成功（界面显示「上次自动备份：成功」）',
      prefs.readSnapshotOnCloseState(p.profile_id)?.ok === true,
      JSON.stringify(prefs.readSnapshotOnCloseState(p.profile_id)));

    // 再停一次 → 又一份（受 5 份上限约束）
    for (let i = 0; i < 6; i += 1) await manager.autoSnapshotOnClose(p.profile_id);
    check('连开 7 次关 → 仍只留 5 份（自动备份同样受上限约束，不会无限涨）',
      snap.listSnapshots(p.profile_id).length === 5, String(snap.listSnapshots(p.profile_id).length));
    check('盘上也只有 5 个目录（挤掉的真的删了）',
      snapDirsOnDisk(p.profile_id) === 5, String(snapDirsOnDisk(p.profile_id)));
  }

  /* ==================== 4. 池子满时不许挤掉 before_restore ==================== */
  console.log('\n— 4. 池子满时：先淘汰普通快照，`before_restore` 最后才动 —');
  {
    const p = prof.createProfile({ name: `onclose-keep-${Date.now()}`, group_id: '0' });
    makeUserdata(p);
    /*
     * 池子布局刻意让**最旧的正是恢复点**：先拍 2 份 `before_restore`，再拍 3 份手动。
     * 这样「纯按时间淘汰」会杀掉恢复点，而正确行为应该杀掉更旧的手动快照 ——
     * 如果反过来把恢复点放在最新，两种实现的结果一样，判据就分辨不出来（第一次就踩了这个坑）。
     */
    const restoreIds = [];
    for (let i = 0; i < 2; i += 1) {
      const r = snap.takeSnapshot(prof.getProfile(p.profile_id), { reason: 'before_restore' });
      restoreIds.push(r.snapshot.snap_id);
      await sleep(3);
    }
    const manualIds = [];
    for (let i = 0; i < 3; i += 1) {
      const r = snap.takeSnapshot(prof.getProfile(p.profile_id), { reason: 'manual' });
      manualIds.push(r.snapshot.snap_id);
      await sleep(3);
    }
    check('（前提）池子 5 份：2 份恢复点（**最旧**）+ 3 份手动',
      snap.listSnapshots(p.profile_id).length === 5
      && snap.listSnapshots(p.profile_id).filter((s) => s.reason === 'before_restore').length === 2
      && snap.listSnapshots(p.profile_id)[4].reason === 'before_restore');

    // 关环境自动备份进来第 6 份 → 应该挤掉**最旧的手动**那份，两份恢复点都留着
    const r = await manager.autoSnapshotOnClose(p.profile_id);
    const left = snap.listSnapshots(p.profile_id);
    check('自动备份进来后仍只 5 份', left.length === 5, String(left.length));
    check('**两份 `before_restore` 都还在**（恢复点不许被自动备份挤掉）',
      left.filter((s) => s.reason === 'before_restore').length === 2,
      JSON.stringify(left.map((s) => s.reason)));
    check('被挤掉的是**最旧的手动快照**（不是最旧的恢复点），且 `restore_point:false`',
      r.evicted?.length === 1 && r.evicted[0].snap_id === manualIds[0] && r.evicted[0].restore_point === false,
      JSON.stringify(r.evicted));
    check('被挤掉的那份目录真的从磁盘消失',
      !fs.existsSync(snap.snapshotDirFor(p.profile_id, manualIds[0])));
    check('两份恢复点的目录都还在盘上',
      restoreIds.every((id) => fs.existsSync(snap.snapshotDirFor(p.profile_id, id))));

    // 极端情况：池子里全是恢复点 → 才允许动恢复点，并标出来
    const p2 = prof.createProfile({ name: `onclose-allrestore-${Date.now()}`, group_id: '0' });
    makeUserdata(p2);
    const rIds = [];
    for (let i = 0; i < 5; i += 1) {
      const rr = snap.takeSnapshot(prof.getProfile(p2.profile_id), { reason: 'before_restore' });
      rIds.push(rr.snapshot.snap_id);
      await sleep(3);
    }
    const r2 = await manager.autoSnapshotOnClose(p2.profile_id);
    check('池子全是恢复点时：**才**动恢复点，并在 `evicted` 里标 `restore_point:true`',
      r2.created === true && r2.evicted?.length === 1 && r2.evicted[0].restore_point === true,
      JSON.stringify(r2.evicted));
    check('动的是最旧的恢复点（不是随便一份）', r2.evicted?.[0]?.snap_id === rIds[0],
      JSON.stringify({ evicted: r2.evicted?.[0]?.snap_id, oldest: rIds[0] }));

    /*
     * 空壳恢复点（拍的时候没有 userdata，只剩记录）要**最先淘汰**，排在普通快照之前。
     * 真实场景：数据被删掉之后又恢复了一次，那次拍的 `before_restore` 就是没有 userdata 的；
     * 如果只按「恢复点最后动」，这个空壳会长期占着名额、把完整备份挤掉
     * （0.4.7 ③ 的 B 层第一次跑就是这么挂的）。
     */
    const p3 = prof.createProfile({ name: `onclose-emptyrestore-${Date.now()}`, group_id: '0' });
    const emptyRestore = snap.takeSnapshot(prof.getProfile(p3.profile_id), { reason: 'before_restore' });
    check('（前提）没有 userdata 时拍的恢复点：`includes.userdata:false`',
      emptyRestore.snapshot.includes.userdata === false);
    await sleep(3);
    const fullManual = [];
    for (let i = 0; i < 4; i += 1) {
      makeUserdata(p3);
      const rr = snap.takeSnapshot(prof.getProfile(p3.profile_id), { reason: 'manual' });
      fullManual.push(rr.snapshot.snap_id);
      await sleep(3);
    }
    check('（前提）池子 5 份：1 份空壳恢复点（最旧）+ 4 份完整手动',
      snap.listSnapshots(p3.profile_id).length === 5
      && snap.listSnapshots(p3.profile_id)[4].includes.userdata === false);
    const r3 = await manager.autoSnapshotOnClose(p3.profile_id);
    check('**空壳恢复点最先被淘汰**（`restore_point:true` 且 `has_userdata:false`），完整备份留着',
      r3.evicted?.length === 1 && r3.evicted[0].snap_id === emptyRestore.snapshot.snap_id
      && r3.evicted[0].restore_point === true && r3.evicted[0].has_userdata === false,
      JSON.stringify(r3.evicted));
    check('4 份完整手动备份一份都没少',
      fullManual.every((id) => fs.existsSync(snap.snapshotDirFor(p3.profile_id, id))));
  }

  /* ==================== 5. 自动备份失败不许影响关环境 ==================== */
  console.log('\n— 5. 自动备份失败 → 关环境照常成功，且失败看得见 —');
  {
    prefs.writeSnapshotOnClose(true);
    const p = prof.createProfile({ name: `onclose-fail-${Date.now()}`, group_id: '0' });
    makeUserdata(p);

    /*
     * 造真实失败：把 `snapshots/<id>` 的父目录换成**文件**，`mkdirSync(recursive)` 会 EEXIST/ENOTDIR。
     * 不用 mock：这条路是真的写不进去，和磁盘满/权限没了是同一种失败。
     */
    const root = snap.profileSnapshotsDir(p.profile_id);
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.writeFileSync(root, 'not a directory');
    const r = await manager.autoSnapshotOnClose(p.profile_id);
    check('自动备份失败 → `created:false` 且带 reason（**不抛异常**）',
      r.created === false && !!r.reason, JSON.stringify(r));
    check('**失败被记下来了**（界面要能显示「上次自动备份失败」）',
      prefs.readSnapshotOnCloseState(p.profile_id)?.ok === false
      && !!prefs.readSnapshotOnCloseState(p.profile_id)?.reason,
      JSON.stringify(prefs.readSnapshotOnCloseState(p.profile_id)));
    const logFile = path.join(dataDir, 'logs', `${p.profile_id}.log`);
    const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    check('日志里有一行 `snapshot_on_close - fail`（只记一行，不刷屏）',
      logText.includes('snapshot_on_close - fail'), logText.split('\n').filter((x) => x.includes('snapshot_on_close')).join(' | '));
    fs.rmSync(root, { force: true });
    check('环境记录没被搞坏（status 仍是 idle、能再拍）',
      prof.getProfile(p.profile_id).status === 'idle');

    // 失败之后开关仍然开着：不该因为一次失败就自己关掉
    check('一次失败不会把开关自动关掉（那是用户的选择）',
      prefs.readSnapshotOnClose().enabled === true);

    /*
     * 异常路径（`ok:false` 之外的另一种失败）：`takeSnapshot` 自己抛。
     * 这条不能用「目录占住」造 —— 那走的是 `ok:false`。所以注入一个会抛的实现，
     * 断言 **`autoSnapshotOnClose` 不把异常抛出去**（抛出去就是关环境失败）。
     */
    let escaped = null;
    let res = null;
    try {
      res = await manager.autoSnapshotOnClose(p.profile_id, {
        takeSnapshotImpl: () => { throw new Error('模拟快照模块炸了'); },
      });
    } catch (e) { escaped = e.message; }
    check('`takeSnapshot` 抛异常 → **不冒泡**（`autoSnapshotOnClose` 自己吃掉）',
      escaped === null, String(escaped));
    check('吃掉之后如实回报 `created:false` + `reason:exception`',
      res?.created === false && res?.reason === 'exception', JSON.stringify(res));
    check('异常也被记进状态（界面照样能显示「上次自动备份失败」）',
      prefs.readSnapshotOnCloseState(p.profile_id)?.reason === 'exception',
      JSON.stringify(prefs.readSnapshotOnCloseState(p.profile_id)));
  }

  /* ==================== 6. 路由：开关 + 状态可读、非法值拒 ==================== */
  console.log('\n— 6. 路由（读开关 / 改开关 / 非法值拒） —');
  const { server, apiKey } = createApiServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(method, p, body) {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', 'api-key': apiKey, 'x-freepower-client': 'mcp' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 纯文本 */ }
    return { status: res.status, json };
  }
  try {
    prefs.writeSnapshotOnClose(false);
    const s0 = await api('GET', '/api/v2/settings');
    check('GET /settings 带 `snapshot_on_close:false` + `saved:true`',
      s0.json?.code === 0 && s0.json?.data?.snapshot_on_close === false
      && s0.json?.data?.snapshot_on_close_saved === true,
      JSON.stringify({ on: s0.json?.data?.snapshot_on_close, saved: s0.json?.data?.snapshot_on_close_saved }));

    const on = await api('POST', '/api/v2/settings/snapshot-on-close', { enabled: true });
    check('POST 开 → code=0 + enabled:true + changed:true',
      on.json?.code === 0 && on.json?.data?.enabled === true && on.json?.data?.changed === true,
      JSON.stringify(on.json?.data));
    const again = await api('POST', '/api/v2/settings/snapshot-on-close', { enabled: true });
    check('再开一次 → changed:false（幂等）', again.json?.data?.changed === false, JSON.stringify(again.json?.data));

    const missing = await api('POST', '/api/v2/settings/snapshot-on-close', {});
    check('缺 enabled → 100002 + field=enabled（不许当成 false 静默关掉）',
      missing.json?.code === 100002 && missing.json?.data?.field === 'enabled',
      JSON.stringify({ code: missing.json?.code, field: missing.json?.data?.field }));
    const bad = await api('POST', '/api/v2/settings/snapshot-on-close', { enabled: 'maybe' });
    check('enabled 非布尔 → 100002 + field=enabled',
      bad.json?.code === 100002 && bad.json?.data?.field === 'enabled',
      JSON.stringify({ code: bad.json?.code, field: bad.json?.data?.field }));

    // 环境「备份快照」列表里要能读到开关状态 + 这个环境上次自动备份的结果
    const p = prof.createProfile({ name: `onclose-route-${Date.now()}`, group_id: '0' });
    makeUserdata(p);
    prefs.writeSnapshotOnCloseState(p.profile_id, { ok: false, reason: 'disk_full', message: '模拟' });
    const listed = await api('GET', `/api/v2/browser-profile/snapshot/list?profile_id=${p.profile_id}`);
    check('snapshot/list 带 `on_close.enabled` + **这个环境**的 `on_close.last`（失败看得见）',
      listed.json?.data?.on_close?.enabled === true
      && listed.json?.data?.on_close?.last?.ok === false
      && listed.json?.data?.on_close?.last?.reason === 'disk_full',
      JSON.stringify(listed.json?.data?.on_close));
    const other = prof.createProfile({ name: `onclose-other-${Date.now()}`, group_id: '0' });
    const listedOther = await api('GET', `/api/v2/browser-profile/snapshot/list?profile_id=${other.profile_id}`);
    check('别的环境读不到这个环境的失败记录（状态是按环境存的）',
      listedOther.json?.data?.on_close?.last === null,
      JSON.stringify(listedOther.json?.data?.on_close?.last));
  } finally {
    server.close();
  }

  /* ==================== 7. 静态：纪律不许被改回去 ==================== */
  console.log('\n— 7. 静态断言 —');
  {
    const mgrSrc = fs.readFileSync(new URL('../src/runtime/manager.js', import.meta.url), 'utf8');
    const stopAt = mgrSrc.indexOf('export async function stopProfile');
    const stopBlock = mgrSrc.slice(stopAt, stopAt + 3000);
    check('静态：`stopProfile` 里真调了 `autoSnapshotOnClose`',
      /autoSnapshotOnClose\(profileId\)/.test(stopBlock));
    check('静态：**排在 `scheduleCachePurgeOnClose` 之前**（否则备份到的是被清空的目录）',
      stopBlock.indexOf('autoSnapshotOnClose') < stopBlock.indexOf('scheduleCachePurgeOnClose')
      && stopBlock.indexOf('scheduleCachePurgeOnClose') > 0);
    check('静态：调用点外面还有一层 try（关环境不许因为备份崩掉）',
      /try \{\s*\n\s*snapshotOnClose = await autoSnapshotOnClose/.test(stopBlock));
    check('静态：自动备份用 `reason: \'on_close\'`（不是 manual / before_restore）',
      /reason: 'on_close'/.test(mgrSrc));
    check('静态：自动备份传 `running: false`（刚停的内核，数据是静的）',
      /running: false/.test(mgrSrc.slice(mgrSrc.indexOf('export async function autoSnapshotOnClose'))));

    const prefsSrc = fs.readFileSync(new URL('../src/settings/prefs.js', import.meta.url), 'utf8');
    check('静态：开关读不到就**当关**（`enabled: false` 是默认分支）',
      /if \(raw === null \|\| raw === undefined \|\| String\(raw\)\.trim\(\) === ''\) \{\s*\n\s*return \{ enabled: false/.test(prefsSrc));

    const snapSrc = fs.readFileSync(new URL('../src/store/snapshots.js', import.meta.url), 'utf8');
    check('静态：轮转按「有用程度」分三档淘汰（空壳恢复点 → 普通快照 → 带数据的恢复点）',
      /keepRestorePoints = true/.test(snapSrc)
      && /const tier = \(s\) => \{/.test(snapSrc)
      && /return hasUserdata\(s\) \? 3 : 1;/.test(snapSrc)
      && /if \(!isRestorePoint\(s\)\) return 2;/.test(snapSrc)
      && /\.sort\(\(a, b\) => tier\(a\) - tier\(b\)\)/.test(snapSrc));
    check('静态：`evicted` 里带 `restore_point` 与 `has_userdata`（动的是哪种快照要说清）',
      /restore_point: isRestorePoint\(s\)/.test(snapSrc) && /has_userdata: hasUserdata\(s\)/.test(snapSrc));
  }
} catch (e) {
  check('A 层跑完没有抛异常', false, `${e && e.message}`);
  console.error(e);
} finally {
  try { (await import('../src/store/db.js')).closeDb(); } catch { /* ignore */ }
  await sleep(200);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄还在，留给系统 */ }
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
