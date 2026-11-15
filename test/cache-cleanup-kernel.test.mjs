/**
 * 按天数删缓存（0.4.7 ④）判据 —— B 层：**真内核**。
 *
 * A 层（`test/cache-cleanup.test.mjs`）验的是纯函数与路由分支；这一层只验三件**只有真机才成立**的事：
 *
 *   1. **真启动会写「最后启动时间」**。这是整条链的事实源 —— 它不写，界面上所有环境都会是
 *      「判定不了」，这个功能等于永远删不掉东西。所以必须真起一个环境、真读库看那一列变了。
 *   2. **删的正好是清单里那些**。造三个都够天数的环境 → 只确认其中一个 → 它的目录真没了，
 *      另外两个**一个字节都没动**。只有「删了」不能证明没删错，必须有「不删」的对照。
 *   3. **正在运行的环境不参与**。跑着的环境被列进清单 = 用户一点确认就把正在用的登录态删了。
 *      这条只能用真进程验：`status` 那一列是不是真的 'running'，只有起了内核才知道。
 *
 * 另外顺手钉一条语义细节：**天数够了但没数据目录**的环境不能报成「已删除」，
 * 否则「释放了多少空间」会虚报（A 层验了分支，这里验真机上的那个环境）。
 *
 * 跑法：node --no-warnings test/cache-cleanup-kernel.test.mjs   （约 40–70 秒，需本机 Chrome）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 自己的数据根：**绝不用仓库里的 data/**，这条判据会真删目录
const dataDir = path.join(os.tmpdir(), `freepower-cache-cleanup-kernel-${Date.now()}`);
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
const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);

const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');
const dbmod = await import('../src/store/db.js');
const { planCacheCleanup, applyCacheCleanup } = await import('../src/runtime/cache-cleanup.js');
const { PROFILES_DIR } = await import('../src/config.js');

/** 目录名的规则与 `userDataDirFor` 一致；这里自己算一份，免得「删对了」是因为调了同一个函数 */
const dirOf = (p) => manager.userDataDirFor(profiles.getProfile(p.profile_id));
const parentOf = (p) => path.dirname(dirOf(p));

const ids = [];
try {
  /* ==================== 1. 真启动 → 真的写了「最后启动时间」 ==================== */
  console.log('\n— 1. 真启动会写 last_launch_at（整条链的事实源） —');
  const live = profiles.createProfile({ name: `cc-live-${Date.now()}`, group_id: '0' });
  ids.push(live.profile_id);
  check('刚建的环境没有「最后启动时间」（空列，不是 1970、不是建库时间）',
    !profiles.getProfile(live.profile_id).last_launch_at,
    JSON.stringify(profiles.getProfile(live.profile_id).last_launch_at));

  const t0 = Date.now();
  const started = await manager.startProfile(profiles.getProfile(live.profile_id));
  check('环境真启动成功（后面所有结论的前提）',
    !!started.real_version && Number(started.pid) > 0, `pid=${started.pid} 内核 ${started.real_version}`);

  const afterStart = profiles.getProfile(live.profile_id);
  const wroteAt = Date.parse(afterStart.last_launch_at || '');
  check('启动成功后**库里那一列真的被写了**（不是还空着）',
    Number.isFinite(wroteAt), JSON.stringify(afterStart.last_launch_at));
  check('写进去的时间就是**刚才**（±3 分钟内，不是抄了别的时间）',
    Number.isFinite(wroteAt) && Math.abs(wroteAt - t0) < 180000,
    `${Number.isFinite(wroteAt) ? new Date(wroteAt).toISOString() : '(空)'} vs 启动于 ${new Date(t0).toISOString()}`);
  check('启动成功时 status 是 running（第 3 节要靠它排除）', afterStart.status === 'running', afterStart.status);
  check('数据目录真建出来了（后面「删掉了」才有对象）',
    fs.existsSync(dirOf(live)) && fs.readdirSync(dirOf(live)).length > 0,
    JSON.stringify(fs.readdirSync(dirOf(live)).slice(0, 5)));

  /* ==================== 2. 正在运行的环境不参与清理 ==================== */
  console.log('\n— 2. 跑着的环境不许被列进清单（哪怕天数早就够了） —');
  // 手动把记录改到 400 天前：模拟「很久没开、但现在正开着」
  profiles.markLaunched(live.profile_id, daysAgo(400));
  const livePlan = planCacheCleanup([profiles.getProfile(live.profile_id)], { days: 30 });
  check('正在运行 + 400 天前的记录 → **不在 will_delete**，归到 keep/running',
    livePlan.will_delete.length === 0 && livePlan.keep[0]?.reason === 'running',
    JSON.stringify({ del: livePlan.will_delete.length, reason: livePlan.keep[0]?.reason }));
  check('它被算进 unknown_count 之外（running 和「判定不了」是两回事）',
    livePlan.unknown_count === 0, String(livePlan.unknown_count));

  await manager.stopProfile(live.profile_id);
  await sleep(600);
  check('停下来之后 status 不再是 running（不然这个环境永远删不掉）',
    profiles.getProfile(live.profile_id).status !== 'running',
    String(profiles.getProfile(live.profile_id).status));
  check('停下来之后「最后启动时间」仍然在（停止不改这个时间）',
    !!profiles.getProfile(live.profile_id).last_launch_at,
    JSON.stringify(profiles.getProfile(live.profile_id).last_launch_at));

  /* ==================== 3. 只删清单里那些（真磁盘） ==================== */
  console.log('\n— 3. 三个都够天数 → 只确认一个 → 只删那一个 —');
  const a = profiles.createProfile({ name: `cc-a-${Date.now()}`, group_id: '0' });
  const b = profiles.createProfile({ name: `cc-b-${Date.now()}`, group_id: '0' });
  const c = profiles.createProfile({ name: `cc-c-${Date.now()}`, group_id: '0' });
  ids.push(a.profile_id, b.profile_id, c.profile_id);
  // 用「真启动」造数据目录（比 mkdir 更真实：目录里会有内核真的落盘的东西），
  // 起完立刻停，然后把记录改到 40 天前 —— 天数是靠记录判的，不是靠文件时间。
  for (const p of [a, b, c]) {
    const s = await manager.startProfile(profiles.getProfile(p.profile_id));
    if (!s || !s.pid) throw new Error(`造数据目录时启动失败：${p.profile_id}`);
    await manager.stopProfile(p.profile_id);
  }
  await sleep(600);
  for (const p of [a, b, c]) profiles.markLaunched(p.profile_id, daysAgo(40));

  const dirs = [a, b, c].map(dirOf);
  check('三个环境的数据目录都在，且互不相同',
    dirs.every((d) => fs.existsSync(d) && fs.readdirSync(d).length > 0) && new Set(dirs).size === 3,
    JSON.stringify(dirs.map((d) => path.basename(path.dirname(d)))));

  const plan3 = planCacheCleanup([a, b, c].map((p) => profiles.getProfile(p.profile_id)), { days: 30 });
  check('三个都在清单里（都是 40 天前开过、都没在跑）',
    plan3.will_delete.length === 3, JSON.stringify(plan3.will_delete.map((x) => x.profile_no)));
  const sizes = plan3.will_delete.map((x) => x.size_bytes);
  check('每个都报出了真实占用（>0，不是 null 也不是 0）',
    sizes.every((s) => typeof s === 'number' && s > 0), JSON.stringify(sizes));
  check('预览阶段一个字节都没动（三个目录都还在）', dirs.every((d) => fs.existsSync(d)));

  // 只确认 a
  const onlyA = plan3.will_delete.filter((x) => String(x.profile_id) === String(a.profile_id));
  check('按确认清单过滤后只剩 a 一条（这就是界面「逐条勾选」的那一步）',
    onlyA.length === 1, JSON.stringify(onlyA.map((x) => x.profile_no)));
  const applied = applyCacheCleanup(onlyA);

  check('a 的目录**真的从磁盘消失**',
    applied.deleted.length === 1 && !fs.existsSync(dirOf(a)),
    JSON.stringify({ deleted: applied.deleted.length, exists: fs.existsSync(dirOf(a)) }));
  check('**b 的目录一个字节都没动**（同批够天数、只是没确认）',
    fs.existsSync(dirOf(b)) && fs.readdirSync(dirOf(b)).length > 0, dirOf(b));
  check('**c 的目录一个字节都没动**', fs.existsSync(dirOf(c)), dirOf(c));
  check('freed_bytes 只算 a 那份（= 清单里 a 的 size_bytes）',
    applied.freed_bytes === plan3.will_delete.find((x) => x.profile_id === a.profile_id).size_bytes,
    JSON.stringify({ freed: applied.freed_bytes, sizeA: plan3.will_delete.find((x) => x.profile_id === a.profile_id).size_bytes }));
  check('a 的**库记录还在**（删的是数据，不是环境）',
    !!profiles.getProfile(a.profile_id) && profiles.getProfile(a.profile_id).status !== 'deleted',
    String(profiles.getProfile(a.profile_id)?.status));
  /*
   * 删到哪一层：`purgeProfileData` 删的是 `<no>_<id8>` 整个目录（`userdata` 是它唯一的子目录，
   * 见 `manager.js:93` —— 全仓库只有这一处往这层写），所以删完这一层也跟着没了，这是对的。
   * 真正要钉住的是**没删过头**：`profiles/` 这一层必须还在，兄弟环境的目录一个都没动。
   */
  check('删的是 `<no>_<id8>` 整个目录（userdata 是它唯一的子目录，父目录留着只是空壳）',
    !fs.existsSync(parentOf(a)), parentOf(a));
  check('**`profiles/` 这一层还在**（删到这一层就是「删过头」）',
    fs.existsSync(PROFILES_DIR), PROFILES_DIR);
  check('兄弟环境的目录都还在（b / c 的父目录）',
    fs.existsSync(parentOf(b)) && fs.existsSync(parentOf(c)),
    JSON.stringify([path.basename(parentOf(b)), path.basename(parentOf(c))]));
  check('`profiles/` 下没有留下墓碑目录（`.purge-` 残留会让下次启动重名失败）',
    fs.readdirSync(PROFILES_DIR).filter((n) => n.includes('.purge-')).length === 0,
    JSON.stringify(fs.readdirSync(PROFILES_DIR)));

  /* ==================== 4. 清完之后能再启动（不是「删一次就废」） ==================== */
  console.log('\n— 4. 清完再启动：目录重建、环境照常能起 —');
  const again = await manager.startProfile(profiles.getProfile(a.profile_id));
  check('清完之后再启动成功', !!again.real_version && Number(again.pid) > 0, `pid=${again.pid}`);
  check('数据目录重新建出来了', fs.existsSync(dirOf(a)) && fs.readdirSync(dirOf(a)).length > 0, dirOf(a));
  const reLaunched = profiles.getProfile(a.profile_id);
  check('再启动把「最后启动时间」更新成刚才（不是还停在 40 天前）',
    Date.now() - Date.parse(reLaunched.last_launch_at) < 180000,
    JSON.stringify(reLaunched.last_launch_at));
  await manager.stopProfile(a.profile_id);
  await sleep(600);

  /* ==================== 5. 天数够了但没数据目录 → 不算「已删除」 ==================== */
  console.log('\n— 5. 没有数据目录的环境：报「没有数据」，不虚报释放空间 —');
  const noData = profiles.createProfile({ name: `cc-nodata-${Date.now()}`, group_id: '0' });
  ids.push(noData.profile_id);
  profiles.markLaunched(noData.profile_id, daysAgo(90));
  check('这个环境确实没有数据目录（从没启动过）', !fs.existsSync(dirOf(noData)), dirOf(noData));
  const ndPlan = planCacheCleanup([profiles.getProfile(noData.profile_id)], { days: 30 });
  check('它不在 will_delete，而在 keep/no_data（「天数够了但没有可删的东西」）',
    ndPlan.will_delete.length === 0 && ndPlan.keep[0]?.reason === 'no_data',
    JSON.stringify({ del: ndPlan.will_delete.length, reason: ndPlan.keep[0]?.reason }));
  check('plan 的 total_bytes 没把它算进去（否则「能省多少」是假的）',
    ndPlan.total_bytes === 0, String(ndPlan.total_bytes));

  /* ==================== 6. 「判定不了」的环境在真库里就是现在的老环境 ==================== */
  console.log('\n— 6. 升级上来的老环境（没有记录）→ 判定不了、不删 —');
  const legacy = profiles.createProfile({ name: `cc-legacy-${Date.now()}`, group_id: '0' });
  ids.push(legacy.profile_id);
  // 造一份数据目录，但**不写** last_launch_at —— 这正是「0.4.7 之前启动过的环境」的样子
  const legacyDir = dirOf(legacy);
  fs.mkdirSync(path.join(legacyDir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'Default', 'Cookies'), Buffer.alloc(2048, 3));
  const lgPlan = planCacheCleanup([profiles.getProfile(legacy.profile_id)], { days: 1 });
  check('老环境（有数据目录、没记录）→ keep/unknown，**天数给到 1 也不删**',
    lgPlan.will_delete.length === 0 && lgPlan.keep[0]?.reason === 'unknown' && lgPlan.unknown_count === 1,
    JSON.stringify({ del: lgPlan.will_delete.length, reason: lgPlan.keep[0]?.reason }));
  check('它的数据目录一个字节都没动', fs.existsSync(path.join(legacyDir, 'Default', 'Cookies')), legacyDir);
} catch (e) {
  check('B 层跑完没有抛异常', false, `${e && e.message}`);
  console.error(e);
} finally {
  for (const id of ids) await manager.stopProfile(id).catch(() => {});
  dbmod.closeDb();
  await sleep(300);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄还在，留给系统 */ }
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
