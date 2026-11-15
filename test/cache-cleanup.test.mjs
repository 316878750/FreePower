/**
 * 按天数删缓存（0.4.7 ④）判据 —— A 层：不起内核，几秒跑完。
 *
 * 这是**不可逆**操作，所以判据要钉住的不是「能删掉」，而是下面这四件容易骗自己的事：
 *
 *   1. **天数不能靠猜**。只认 `profiles.last_launch_at`（我们自己记的），
 *      没有记录的环境必须归到「判定不了、不删」。判据里有一条专门盯住
 *      「源码里出现 mtime 就红」——因为这是最容易顺手改回去的一处。
 *   2. **删的必须正好是清单里那些**。多删一个 = 用户没同意就丢了登录态。
 *      所以真删时用的是「用户确认的 ∩ 现在的计划」，两边都同意才删；
 *      确认之后状态变了（刚被启动）的要报回来、不删。
 *   3. **不删库记录**。环境还在（记录、代理、指纹都留着），只是数据没了。
 *   4. **「删不掉」必须报成「什么都没动」**，不能报成「删了一半」。
 *      真占用（Windows 文件锁）在 `purge-lock-kernel.test.mjs` 里用真锁验；
 *      这里用注入 fs 只验「失败被如实报成 intact」这个分支。
 *
 * 真磁盘 + 真内核那部分（真启动写 last_launch_at、真删目录、运行中的不删）
 * 在 B 层 `test/cache-cleanup-kernel.test.mjs`。
 *
 * 跑法：node --no-warnings test/cache-cleanup.test.mjs   （已进 npm test）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = path.join(os.tmpdir(), `freepower-cache-cleanup-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_RATE_LIMIT_MCP = '10000';
process.env.FREEPOWER_SELFCHECK = '0';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);

try {
  const { planCacheCleanup, applyCacheCleanup, dirSizeOf } = await import('../src/runtime/cache-cleanup.js');
  const prof = await import('../src/store/profiles.js');
  const { PROFILES_DIR } = await import('../src/config.js');
  const { createApiServer } = await import('../src/api/server.js');

  /** 目录名规则与 `userDataDirFor` 一致：`<profile_no>_<id 前 8 位>`（id 可能叫 id 也可能叫 profile_id） */
  const idOf = (p) => p.id || p.profile_id;
  const dataDirOf = (profile) => path.join(PROFILES_DIR, `${profile.profile_no}_${String(idOf(profile)).slice(0, 8)}`);
  /** 造一个真的 userdata 目录，塞一个已知大小的文件；返回它占的字节数 */
  function makeDataDir(profile, bytes) {
    const dir = path.join(dataDirOf(profile), 'userdata');
    fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Default', 'Cookies'), Buffer.alloc(bytes, 7));
    return bytes;
  }

  /* ==================== 1. lastLaunchOf：三态必须分开 ==================== */
  console.log('\n— 1. 「多久没开」的三态（known / unknown / running） —');
  {
    const { lastLaunchOf } = prof;

    const unknown = lastLaunchOf({ id: 'x1', profile_no: 1, name: 'n', last_launch_at: null, status: 'idle' });
    check('没有记录 → unknown（**不删**），且 reason 说清「判定不了」',
      unknown.state === 'unknown' && unknown.days === null && /无法判定/.test(unknown.reason || ''),
      JSON.stringify({ state: unknown.state, reason: unknown.reason }));

    const known = lastLaunchOf({ id: 'x2', profile_no: 2, name: 'n', last_launch_at: daysAgo(40).toISOString(), status: 'idle' });
    check('有记录 → known，天数算对（40 天前 = 40）',
      known.state === 'known' && known.days === 40, JSON.stringify({ state: known.state, days: known.days }));

    const running = lastLaunchOf({ id: 'x3', profile_no: 3, name: 'n', last_launch_at: daysAgo(400).toISOString(), status: 'running' });
    check('现在就在运行 → running（哪怕记录是 400 天前也不删）',
      running.state === 'running' && running.days === null, JSON.stringify({ state: running.state, reason: running.reason }));

    const broken = lastLaunchOf({ id: 'x4', profile_no: 4, name: 'n', last_launch_at: '不是时间', status: 'idle' });
    check('记录是乱码 → unknown（**不删**），不许当成「0 天前」',
      broken.state === 'unknown' && /不是合法时间/.test(broken.reason || ''), JSON.stringify(broken.reason));

    const future = lastLaunchOf({ id: 'x5', profile_no: 5, name: 'n', last_launch_at: new Date(Date.now() + 5 * DAY).toISOString(), status: 'idle' });
    check('记录在未来（系统时钟被改过）→ 天数夹到 0，不是负数',
      future.state === 'known' && future.days === 0, JSON.stringify({ state: future.state, days: future.days }));

    // markLaunched：真的写库（这是「事实源」，写不进就全废）
    const p = prof.createProfile({ name: `launch-${Date.now()}`, group_id: '0' });
    const before = prof.getProfile(p.profile_id);
    check('新建的环境没有「最后启动时间」（空列，不是 1970）',
      !before.last_launch_at, JSON.stringify(before.last_launch_at));
    const t12 = daysAgo(12);
    prof.markLaunched(p.profile_id, t12);
    const after = prof.getProfile(p.profile_id);
    check('markLaunched 写进库了，读回来与写进去的**是同一个时刻**',
      after.last_launch_at === t12.toISOString(), JSON.stringify(after.last_launch_at));
    let threw = null;
    try { prof.markLaunched('no-such-id-0000', daysAgo(1)); } catch (e) { threw = e; }
    check('markLaunched 给不存在的 id 不抛（UPDATE 影响 0 行是正常的）', threw === null, threw ? threw.message : '');
  }

  /* ==================== 2. dirSizeOf：算不出来给 null，不拿 0 冒充 ==================== */
  console.log('\n— 2. 目录大小（算不出来必须给 null） —');
  {
    const tmp = path.join(dataDir, 'size-probe');
    fs.mkdirSync(path.join(tmp, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'a', 'one.bin'), Buffer.alloc(1000, 1));
    fs.writeFileSync(path.join(tmp, 'a', 'b', 'two.bin'), Buffer.alloc(2345, 2));
    check('真目录 → 字节数准确（1000 + 2345 = 3345）', dirSizeOf(tmp) === 3345, String(dirSizeOf(tmp)));
    check('不存在的目录 → **null**（不是 0：0 会被当成「空目录可以删」）', dirSizeOf(path.join(tmp, 'nope')) === null);
    const empty = path.join(dataDir, 'size-empty');
    fs.mkdirSync(empty, { recursive: true });
    check('真空目录 → 0（和 null 区分开）', dirSizeOf(empty) === 0, String(dirSizeOf(empty)));
  }

  /* ==================== 3. planCacheCleanup：分类与边界 ==================== */
  console.log('\n— 3. 计划（只读，一个字节都不动） —');
  {
    const a = { id: 'aaaaaaaa-1', profile_no: 11, name: 'A 40天', last_launch_at: daysAgo(40).toISOString(), status: 'idle' };
    const b = { id: 'bbbbbbbb-1', profile_no: 12, name: 'B 1天', last_launch_at: daysAgo(1).toISOString(), status: 'idle' };
    const c = { id: 'cccccccc-1', profile_no: 13, name: 'C 无记录', last_launch_at: null, status: 'idle' };
    const d = { id: 'dddddddd-1', profile_no: 14, name: 'D 在跑', last_launch_at: daysAgo(100).toISOString(), status: 'running' };
    const e = { id: 'eeeeeeee-1', profile_no: 15, name: 'E 没目录', last_launch_at: daysAgo(40).toISOString(), status: 'idle' };
    const sizeA = makeDataDir(a, 4096);
    makeDataDir(b, 8192);
    makeDataDir(d, 16384);
    // e 故意不建目录

    const plan = planCacheCleanup([a, b, c, d, e], { days: 30 });
    const del = plan.will_delete.map((x) => x.profile_no);
    const keepBy = Object.fromEntries(plan.keep.map((x) => [x.profile_no, x.reason]));

    check('只删「够天数 + 有记录 + 有数据 + 没在跑」的那一个',
      del.length === 1 && del[0] === 11, JSON.stringify(del));
    check('1 天前启动的 → keep recent（不删）', keepBy[12] === 'recent', JSON.stringify(keepBy));
    check('没有记录 → keep unknown（**不删**，不拿 mtime 猜）', keepBy[13] === 'unknown', JSON.stringify(keepBy));
    check('正在运行 → keep running（不看天数）', keepBy[14] === 'running', JSON.stringify(keepBy));
    check('天数够了但没数据目录 → keep no_data（不是「已删除」）', keepBy[15] === 'no_data', JSON.stringify(keepBy));
    check('unknown_count 单独计数（界面要能说「N 个判定不了」）', plan.unknown_count === 1, String(plan.unknown_count));
    check('total_bytes = 将删那些的占用（4096）', plan.total_bytes === sizeA, String(plan.total_bytes));
    check('清单里带 days_unused / last_launch_at / size_bytes（用户要能自己判断）',
      plan.will_delete[0].days_unused === 40 && plan.will_delete[0].size_bytes === sizeA && !!plan.will_delete[0].last_launch_at,
      JSON.stringify({ days: plan.will_delete[0].days_unused, size: plan.will_delete[0].size_bytes }));
    check('预览阶段**一个字节都没删**（A 的目录还在）',
      fs.existsSync(dataDirOf(a)) && fs.existsSync(dataDirOf(b)));

    // 边界：天数正好等于阈值 → 删（>= 而不是 >）
    const edge = { id: 'ffffffff-1', profile_no: 16, name: 'edge', last_launch_at: daysAgo(30).toISOString(), status: 'idle' };
    makeDataDir(edge, 128);
    const edgePlan = planCacheCleanup([edge], { days: 30 });
    check('天数**正好等于**阈值 → 算够（>= 而不是 >，不然「30 天」永远删不掉第 30 天）',
      edgePlan.will_delete.length === 1, JSON.stringify(edgePlan.will_delete.map((x) => x.profile_no)));

    // 排序：越久没开越靠前
    const f = { id: 'ffffffff-2', profile_no: 17, name: 'F 90天', last_launch_at: daysAgo(90).toISOString(), status: 'idle' };
    makeDataDir(f, 64);
    const sorted = planCacheCleanup([a, f], { days: 30 }).will_delete.map((x) => x.profile_no);
    check('清单按「多久没开」从久到近排（用户先看最该删的）',
      sorted[0] === 17 && sorted[1] === 11, JSON.stringify(sorted));

    let bad = null;
    try { planCacheCleanup([a], { days: -1 }); } catch (err) { bad = err; }
    check('天数给负数 → 抛错（不静默当成 0）', !!bad && /days/.test(bad.message), bad ? bad.message : '没抛');
  }

  /* ==================== 4. applyCacheCleanup：只删清单里的 ==================== */
  console.log('\n— 4. 执行（只删清单里的那些） —');
  {
    // 用真库里的环境（这样「不删库记录」才是真验到库，不是验到我们自己造的壳）
    const a = prof.getProfile(prof.createProfile({ name: `apply-a-${Date.now()}`, group_id: '0' }).profile_id);
    const b = prof.getProfile(prof.createProfile({ name: `apply-b-${Date.now()}`, group_id: '0' }).profile_id);
    prof.markLaunched(a.id, daysAgo(50));
    prof.markLaunched(b.id, daysAgo(50));
    const bytesA = makeDataDir(a, 5000);
    makeDataDir(b, 5000);

    const plan = planCacheCleanup([prof.getProfile(a.id), prof.getProfile(b.id)], { days: 30 });
    check('两个都够天数 → 两个都在计划里（不然下面的对照没意义）',
      plan.will_delete.length === 2, JSON.stringify(plan.will_delete.map((x) => x.profile_no)));
    const onlyA = plan.will_delete.filter((x) => x.profile_id === a.id);
    const r = applyCacheCleanup(onlyA);

    check('清单里那一个 → 目录真从磁盘消失', r.deleted.length === 1 && !fs.existsSync(dataDirOf(a)),
      JSON.stringify({ deleted: r.deleted.map((x) => x.profile_no), exists: fs.existsSync(dataDirOf(a)) }));
    check('**清单外的那一个一个字节都没动**（这是「一个都不许多删」）',
      fs.existsSync(dataDirOf(b)), String(fs.existsSync(dataDirOf(b))));
    check('freed_bytes 只算真删掉的那些（5000，不含留下的 5000）', r.freed_bytes === bytesA, String(r.freed_bytes));
    check('不删库记录：环境记录还在（下次启动重建干净目录）',
      !!prof.getProfile(a.id) && !!prof.getProfile(b.id), a.id.slice(0, 8));

    // 目录本来就不在 → 进 already_absent（**不许算进 deleted 的条数**：界面会写成「已删除 N 个」）
    const gone = { profile_id: 'iiiiiiii-1', profile_no: 23, name: 'I 没目录', size_bytes: 999, days_unused: 40 };
    const r2 = applyCacheCleanup([gone]);
    check('目录本来就不在 → 进 `already_absent`（不在 deleted 里）、freed_bytes 不加',
      r2.deleted.length === 0 && (r2.already_absent || []).length === 1
      && r2.already_absent[0].profile_id === 'iiiiiiii-1' && r2.freed_bytes === 0,
      JSON.stringify({ deleted: r2.deleted.length, absent: (r2.already_absent || []).length, freed: r2.freed_bytes }));

    // 删不掉 → 必须报 intact（真占用在 purge-lock-kernel 里用真锁验）
    const j = { id: 'jjjjjjjj-1', profile_no: 24, name: 'J 占用', last_launch_at: daysAgo(50).toISOString(), status: 'idle' };
    makeDataDir(j, 1000);
    const fakeFs = {
      ...fs,
      renameSync: (from) => { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; },
      existsSync: fs.existsSync.bind(fs),
      readdirSync: fs.readdirSync.bind(fs),
      rmSync: fs.rmSync.bind(fs),
    };
    const r3 = applyCacheCleanup([{ profile_id: j.id, profile_no: 24, name: 'J', size_bytes: 1000, days_unused: 50 }], { fsx: fakeFs });
    check('删不掉（被占用）→ 进 failed 且 intact:true（「什么都没动」，不是「删了一半」）',
      r3.failed.length === 1 && r3.failed[0].intact === true && r3.freed_bytes === 0,
      JSON.stringify(r3.failed[0]));
    check('删不掉的那个目录**确实还在**（报 intact 就必须真 intact）', fs.existsSync(dataDirOf(j)));
  }

  /* ==================== 5. 路由：preview 只读、真删只删确认过的 ==================== */
  console.log('\n— 5. 路由（preview 与真删是两个阶段） —');
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
    // 造三个真环境：old / old2（都 60 天前开过，都够天数）、fresh（刚开过）
    const oldP = prof.createProfile({ name: `cleanup-old-${Date.now()}`, group_id: '0' });
    const old2P = prof.createProfile({ name: `cleanup-old2-${Date.now()}`, group_id: '0' });
    const freshP = prof.createProfile({ name: `cleanup-fresh-${Date.now()}`, group_id: '0' });
    prof.markLaunched(oldP.profile_id, daysAgo(60));
    prof.markLaunched(old2P.profile_id, daysAgo(61));
    prof.markLaunched(freshP.profile_id, daysAgo(0));
    makeDataDir(oldP, 3000);
    makeDataDir(old2P, 3000);
    makeDataDir(freshP, 3000);

    // ① 不给 profile_ids = 全部参与筛选（这条路由的本意）
    const prev = await api('POST', '/api/v2/browser-profile/cache-cleanup/preview', { days: 30 });
    const prevIds = (prev.json?.data?.will_delete || []).map((x) => x.profile_id);
    check('preview 不给 profile_ids → 扫全部环境（这条路由的本意是按天数筛，不是批量动作）',
      prev.json?.code === 0 && prevIds.includes(oldP.profile_id),
      JSON.stringify({ code: prev.json?.code, scanned: prev.json?.data?.summary?.scanned, hit: prevIds.includes(oldP.profile_id) }));
    check('preview 里刚启动过的不在清单里（fresh 不在 will_delete）',
      !prevIds.includes(freshP.profile_id), JSON.stringify(prevIds.length));
    check('preview **一个字节都没删**（两个目录都还在）',
      fs.existsSync(dataDirOf(oldP)) && fs.existsSync(dataDirOf(freshP)));
    check('preview 响应带 summary.scanned / will_delete / unknown（界面要能说「扫了几个」）',
      typeof prev.json?.data?.summary?.scanned === 'number' && typeof prev.json?.data?.summary?.will_delete === 'number'
      && typeof prev.json?.data?.unknown_count === 'number',
      JSON.stringify(prev.json?.data?.summary));

    // ② 天数非法
    const badDays = await api('POST', '/api/v2/browser-profile/cache-cleanup/preview', { days: 'abc' });
    check('days 不是数字 → 100002 + field=days（不许当成 0 天全删）',
      badDays.json?.code === 100002 && badDays.json?.data?.field === 'days',
      JSON.stringify({ code: badDays.json?.code, field: badDays.json?.data?.field }));

    // ③ **最要命的一条**：真删不带任何确认清单 → 必须拒，且一个字节都不许动。
    //    这不是「顺手加个校验」：API 是一等公民，脚本里一个 {days:30} 就能删掉几十个环境的登录态，
    //    而且会静默回 code=0 —— 恰好是这一版要防的事故。
    const noList = await api('POST', '/api/v2/browser-profile/cache-cleanup', { days: 30 });
    check('真删**不带 `confirm_ids` → 拒**（HTTP 200 + 非 0 code + field=confirm_ids，msg 说清「先 preview」）',
      noList.status === 200 && noList.json?.code !== 0 && noList.json?.code !== undefined
      && noList.json?.data?.field === 'confirm_ids'
      && /preview/.test(noList.json?.msg || ''),
      JSON.stringify({ status: noList.status, code: noList.json?.code, field: noList.json?.data?.field, msg: (noList.json?.msg || '').slice(0, 60) }));
    check('被拒的那次**一个字节都没动**（old / old2 / fresh 的目录都还在）',
      fs.existsSync(dataDirOf(oldP)) && fs.existsSync(dataDirOf(old2P)) && fs.existsSync(dataDirOf(freshP)),
      JSON.stringify([dataDirOf(oldP), dataDirOf(old2P), dataDirOf(freshP)].map((d) => fs.existsSync(d))));
    // `profile_ids` 是老字段名，一并认（脚本里两种写法都有人用）；但空串/空数组同样算「没带清单」
    const emptyList = await api('POST', '/api/v2/browser-profile/cache-cleanup', { days: 30, confirm_ids: [] });
    check('`confirm_ids: []`（空数组）→ 同样拒，不许当成「全选」',
      emptyList.json?.code !== 0 && emptyList.json?.data?.field === 'confirm_ids'
      && fs.existsSync(dataDirOf(old2P)),
      JSON.stringify({ code: emptyList.json?.code, field: emptyList.json?.data?.field }));

    // ④ 真删：只确认 old → 只删 old
    const run = await api('POST', '/api/v2/browser-profile/cache-cleanup', { days: 30, confirm_ids: [oldP.profile_id] });
    const runDeleted = (run.json?.data?.deleted || []).map((x) => x.profile_id);
    check('真删只删确认过的那个（old）', run.json?.code === 0 && runDeleted.length === 1 && runDeleted[0] === oldP.profile_id,
      JSON.stringify({ code: run.json?.code, deleted: runDeleted.length }));
    check('old 的目录真没了', !fs.existsSync(dataDirOf(oldP)));
    // old2 和 old **一样够天数、一样在计划里**，唯一区别是没被确认 —— 它必须完好
    check('**同批够天数但没确认的 old2 一个字节都没动**（计划里有它，确认里没有 → 不许删）',
      fs.existsSync(dataDirOf(old2P)) && prof.getProfile(old2P.profile_id).last_launch_at,
      JSON.stringify({ exists: fs.existsSync(dataDirOf(old2P)) }));
    check('**没确认的 fresh 一个字节都没动**（哪怕它也不够天数）',
      fs.existsSync(dataDirOf(freshP)));
    check('真删响应带 freed_bytes 与 summary，且 `deleted` 与 `already_absent` **分开计**（条数不许虚报）',
      typeof run.json?.data?.freed_bytes === 'number' && typeof run.json?.data?.summary?.deleted === 'number'
      && typeof run.json?.data?.summary?.already_absent === 'number'
      && run.json?.data?.summary?.deleted === 1 && run.json?.data?.summary?.already_absent === 0,
      JSON.stringify({ freed: run.json?.data?.freed_bytes, s: run.json?.data?.summary }));
    check('真删之后环境记录还在（数据没了、环境还在）',
      !!prof.getProfile(oldP.profile_id), oldP.profile_id.slice(0, 8));

    // ④ 确认之后状态变了：确认一个「刚启动」的 → 不在计划里 → 不删，如实报 kept_after_confirm
    const changed = await api('POST', '/api/v2/browser-profile/cache-cleanup', { days: 30, confirm_ids: [freshP.profile_id] });
    const keptIds = (changed.json?.data?.kept_after_confirm || []).map((x) => x.profile_id);
    check('确认之后它已经不该删（刚启动过）→ **不删**，并报在 kept_after_confirm',
      changed.json?.code === 0 && (changed.json?.data?.deleted || []).length === 0 && keptIds.includes(freshP.profile_id),
      JSON.stringify({ deleted: (changed.json?.data?.deleted || []).length, kept: keptIds.length }));
    check('那一个的目录确实还在', fs.existsSync(dataDirOf(freshP)));

    // ⑤ 真删时 confirm_ids 给一个不在计划里的陌生 id → 不崩、不删
    const stranger = await api('POST', '/api/v2/browser-profile/cache-cleanup', { days: 30, confirm_ids: ['00000000-0000-4000-8000-000000000000'] });
    check('confirm_ids 里有个不存在的 id → 不崩、不删（HTTP 200 + code 0）',
      stranger.status === 200 && stranger.json?.code === 0 && (stranger.json?.data?.deleted || []).length === 0,
      JSON.stringify({ status: stranger.status, code: stranger.json?.code }));
  } finally {
    server.close();
  }

  /* ==================== 6. 静态：不许改用文件时间、两阶段不许合并 ==================== */
  console.log('\n— 6. 静态断言（防止后人改回去） —');
  {
    const src = fs.readFileSync(new URL('../src/runtime/cache-cleanup.js', import.meta.url), 'utf8');
    // 注释里当然会提到 mtime（那是在解释「为什么不用它」），所以先去掉注释再查代码
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check('静态：`cache-cleanup.js` 的**代码里**没有 mtime（天数只认 last_launch_at，绝不拿文件时间猜）',
      !/mtime/i.test(code), (code.match(/mtime/gi) || []).length + ' 处 mtime');

    const routesSrc = fs.readFileSync(new URL('../src/api/routes.js', import.meta.url), 'utf8');
    const prevAt = routesSrc.indexOf("'/api/v2/browser-profile/cache-cleanup/preview'");
    const runAt = routesSrc.indexOf("'/api/v2/browser-profile/cache-cleanup']");
    check('静态：两条路由都在（preview 在前、真删在后）', prevAt > 0 && runAt > prevAt,
      JSON.stringify({ prevAt, runAt }));
    const prevBlock = routesSrc.slice(prevAt, runAt);
    check('静态：**preview 路由里不调 applyCacheCleanup**（预览不许顺手删）',
      !/applyCacheCleanup\(/.test(prevBlock));
    const runBlock = routesSrc.slice(runAt, runAt + 3000);
    check('静态：真删路由里用「确认 ∩ 计划」过滤（`targetIds.has`），不是按新计划全删',
      /applyCacheCleanup\(/.test(runBlock) && /targetIds\.has\(/.test(runBlock));
    check('静态：真删路由**缺清单时抛 100002 + field=confirm_ids**，不是 `: plan.will_delete` 兜底',
      /field: 'confirm_ids'/.test(runBlock) && !/toDelete = targetIds[\s\S]{0,80}:\s*plan\.will_delete/.test(runBlock));
    check('静态：`applyCacheCleanup` 把「本来就没有目录」单独放 `already_absent`（不算「已删除」条数）',
      /already_absent: alreadyAbsent/.test(fs.readFileSync(new URL('../src/runtime/cache-cleanup.js', import.meta.url), 'utf8')));
    check('静态：真删路由把「确认后变了」的如实报回来（kept_after_confirm）',
      /kept_after_confirm/.test(runBlock));

    const profSrc = fs.readFileSync(new URL('../src/store/profiles.js', import.meta.url), 'utf8');
    check('静态：markLaunched 写的是 last_launch_at 列',
      /UPDATE profiles SET last_launch_at = \?/.test(profSrc));

    const mgrSrc = fs.readFileSync(new URL('../src/runtime/manager.js', import.meta.url), 'utf8');
    const iRun = mgrSrc.indexOf("markStatus(id, 'running')");
    const iMark = mgrSrc.indexOf('markLaunched(id)');
    check('静态：`markLaunched` 在 `markStatus(id, \'running\')` **之后**调（启动失败的那次不算「开过」）',
      iRun > 0 && iMark > iRun, JSON.stringify({ iRun, iMark }));
    check('静态：记时间失败只 WARN 不抛（不许因为写不进一个时间戳就起不来）',
      /try \{ markLaunched\(id\); \} catch/.test(mgrSrc));
  }
} catch (e) {
  check('A 层跑完没有抛异常', false, `${e && e.message}`);
  console.error(e);
} finally {
  try { (await import('../src/store/db.js')).closeDb(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 200));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄还在，留给系统 */ }
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
