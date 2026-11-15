/**
 * 撤销「合并 Cookie」（0.4.7 ①）判据 —— A 层：不起内核，几秒跑完。
 *
 * 为什么这条判据要单独写一份：合并是**破坏性**的批量操作（选错环境、拿错文件就污染一片），
 * 而「撤销」最容易骗自己的地方有三个，每一个都必须被钉住：
 *
 *   1. **条数对上 ≠ 回到合并前**。合并加 3 条、撤销删 3 条，条数一样，但被覆盖的那条
 *      `value` 可能还是新值。所以判据必须比到 `name/value/domain/path`，不能比条数。
 *   2. **「没有可撤销的合并」不许假装成功**。只保留最近一次 → 撤销过一次再撤，必须如实报
 *      `no_merge_to_undo`，不能回 code=0 让人以为又撤了一次。
 *   3. **环境没了不许崩**。合并之后环境被删（进回收站 / 彻底删掉），撤销必须如实报
 *      `in_recycle_bin` / `not_found`，而不是 500。
 *
 * 这里验的是**纯函数 + 落盘记录 + 不需要内核的几条路由分支**。
 * 「合并 → 撤销 → 真的回到合并前（真内核）」在 B 层 `test/cookie-undo-kernel.test.mjs`。
 *
 * 跑法：node --no-warnings test/cookie-undo.test.mjs   （已进 npm test）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = path.join(os.tmpdir(), `freepower-cookie-undo-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_RATE_LIMIT_MCP = '10000';
process.env.FREEPOWER_SELFCHECK = '0';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/** 一条 cookie 的对外形状（与 readCookies 的返回一致） */
const ck = (name, value, domain = 'example.com', extra = {}) => ({
  name, value, domain, path: '/', expires: -1, httpOnly: false, secure: false, ...extra,
});

try {
  const { compareCookieSets } = await import('../src/kernel/cookies.js');
  const undoStore = await import('../src/store/cookie-undo.js');
  const prof = await import('../src/store/profiles.js');
  const { createApiServer } = await import('../src/api/server.js');
  const { closeDb } = await import('../src/store/db.js');

  /* ==================== 1. compareCookieSets：比的是 cookie 本身 ==================== */
  console.log('\n— 1. 逐条比对（撤销的判据本身） —');
  {
    const before = [ck('sid', 'old'), ck('uid', '7'), ck('gone', 'g')];
    const same = compareCookieSets(before, before.map((c) => ({ ...c })));
    check('完全一样 → ok（三个数组都空）',
      same.ok === true && same.missing.length === 0 && same.extra.length === 0 && same.changed.length === 0,
      JSON.stringify({ ok: same.ok, m: same.missing.length, e: same.extra.length, c: same.changed.length }));

    // 条数一样、值不同 —— 这正是「只看条数」会漏掉的那一类
    const swapped = [ck('sid', 'NEW-VALUE'), ck('uid', '7'), ck('gone', 'g')];
    const chg = compareCookieSets(before, swapped);
    check('**条数一样但值被换了 → 必须红**（只看条数会漏掉的就是这一类）',
      chg.ok === false && chg.changed.length === 1 && chg.changed[0].name === 'sid',
      JSON.stringify({ ok: chg.ok, changed: chg.changed, totals: [chg.expected_total, chg.actual_total] }));

    const missingOne = compareCookieSets(before, before.slice(0, 2));
    check('少一条 → missing 点名它', missingOne.ok === false && missingOne.missing.length === 1 && missingOne.missing[0].name === 'gone',
      JSON.stringify(missingOne.missing));

    const extraOne = compareCookieSets(before, [...before, ck('merged-in', 'x')]);
    check('多一条（合并加进来的那条还在）→ extra 点名它',
      extraOne.ok === false && extraOne.extra.length === 1 && extraOne.extra[0].name === 'merged-in',
      JSON.stringify(extraOne.extra));

    // 域名不同 = 另一条 cookie（同名同值也不行）
    const otherDomain = compareCookieSets([ck('sid', 'v', 'a.test')], [ck('sid', 'v', 'b.test')]);
    check('同名同值但域名不同 → 算「缺 1 多 1」，不是「一样」',
      otherDomain.ok === false && otherDomain.missing.length === 1 && otherDomain.extra.length === 1,
      JSON.stringify({ m: otherDomain.missing, e: otherDomain.extra }));

    // 路径不同同理
    const otherPath = compareCookieSets([ck('sid', 'v', 'example.com', { path: '/a' })], [ck('sid', 'v', 'example.com', { path: '/b' })]);
    check('同名同值但路径不同 → 也算不同的一条', otherPath.ok === false, JSON.stringify({ m: otherPath.missing.length, e: otherPath.extra.length }));

    // 前导点（.example.com 与 example.com）是同一条
    const dot = compareCookieSets([ck('sid', 'v', '.example.com')], [ck('sid', 'v', 'example.com')]);
    check('`.example.com` 与 `example.com` 视为同一条（不然每条带点的都会误报）', dot.ok === true, JSON.stringify(dot.missing));

    // 结果里不许带 value：这是登录凭据
    const secret = 'SUPER-SECRET-COOKIE-VALUE-9f3a';
    const leak = compareCookieSets([ck('sid', secret)], [ck('sid', 'other')]);
    check('比对结果里**不带 cookie 的值**（登录凭据不许跟着响应出去）',
      !JSON.stringify(leak).includes(secret) && !JSON.stringify(leak).includes('other'),
      JSON.stringify(leak.changed));
  }

  /* ==================== 2. 撤销记录：落盘、只留最近一次、坏了要报 ==================== */
  console.log('\n— 2. 撤销记录（落盘，不是记日志） —');
  {
    const pid = 'p-undo-store';
    check('一开始没有记录（读回 null，不是抛错）', undoStore.readMergeSnapshot(pid) === null);

    const before1 = [ck('sid', 'old'), ck('uid', '7')];
    const s1 = undoStore.saveMergeSnapshot(pid, before1, { incoming_total: 3 });
    check('落盘成功，文件真的在盘上', fs.existsSync(undoStore.undoFileFor(pid)), s1.path);
    const back = undoStore.readMergeSnapshot(pid);
    check('读回来的 cookie 与写进去的**逐条相等**（含值）',
      JSON.stringify(back.cookies) === JSON.stringify(before1) && back.total === 2,
      JSON.stringify(back.cookies.map((c) => c.name)));
    check('记录里带 taken_at 与 merge 时的 incoming_total（界面要显示「回到哪一刻」）',
      !!back.taken_at && back.incoming_total === 3, `${back.taken_at} / incoming=${back.incoming_total}`);

    // 只留最近一次：再合并一次就覆盖
    const before2 = [ck('sid', 'older'), ck('added', 'a')];
    undoStore.saveMergeSnapshot(pid, before2);
    const back2 = undoStore.readMergeSnapshot(pid);
    check('再合并一次 → 记录被**覆盖**（只保留最近一次，不做无限历史）',
      JSON.stringify(back2.cookies) === JSON.stringify(before2), JSON.stringify(back2.cookies.map((c) => c.name)));
    check('目录里只有一份记录（一个环境一个文件）',
      fs.readdirSync(undoStore.COOKIE_UNDO_DIR).filter((n) => n.startsWith(pid)).length === 1,
      JSON.stringify(fs.readdirSync(undoStore.COOKIE_UNDO_DIR)));

    // 原子写：临时文件不许残留
    check('没有 `.fp-tmp` 残留（原子写的临时文件写成功就该消失）',
      fs.readdirSync(undoStore.COOKIE_UNDO_DIR).filter((n) => n.endsWith('.fp-tmp')).length === 0,
      JSON.stringify(fs.readdirSync(undoStore.COOKIE_UNDO_DIR)));

    check('hasMergeSnapshot 说「有」', undoStore.hasMergeSnapshot(pid) === true);
    check('clear 之后文件没了、再读是 null',
      undoStore.clearMergeSnapshot(pid) === true && undoStore.readMergeSnapshot(pid) === null
      && undoStore.hasMergeSnapshot(pid) === false);
    check('再 clear 一次 → false（不抛错，重复调用是安全的）', undoStore.clearMergeSnapshot(pid) === false);

    // 坏文件：必须抛（报 snapshot_corrupt），不许当成「没有记录」
    fs.writeFileSync(undoStore.undoFileFor(pid), '{ 这不是合法 JSON', 'utf8');
    let threw = null;
    try { undoStore.readMergeSnapshot(pid); } catch (e) { threw = e; }
    check('记录损坏 → **抛错**（不许当成「没有可撤销的合并」糊过去）',
      !!threw && /损坏/.test(threw.message), threw ? threw.message.slice(0, 60) : '没有抛');
    undoStore.clearMergeSnapshot(pid);
  }

  /* ==================== 3. 路由：不需要内核的那几条分支 ==================== */
  console.log('\n— 3. 路由分支（环境没了 / 没记录 / 没在跑，都要如实报） —');
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
    const p1 = prof.createProfile({ name: `undo-a-${Date.now()}`, group_id: '0' });
    const p2 = prof.createProfile({ name: `undo-b-${Date.now()}`, group_id: '0' });
    const p3 = prof.createProfile({ name: `undo-c-${Date.now()}`, group_id: '0' });

    // ① 没有记录
    const none = await api('POST', '/api/v2/browser-profile/batch/cookie/undo', { profile_ids: [p1.profile_id], preview: false });
    const noneItem = (none.json?.data?.failed || [])[0];
    check('没有合并过 → 如实报 no_merge_to_undo（不是 code=0 假装成功）',
      none.json?.code === 0 && noneItem?.reason === 'no_merge_to_undo' && (none.json?.data?.summary?.restored) === 0,
      JSON.stringify({ code: none.json?.code, reason: noneItem?.reason, restored: none.json?.data?.summary?.restored }));

    // ② 有记录但环境没在跑
    undoStore.saveMergeSnapshot(p1.profile_id, [ck('sid', 'old')]);
    const notRun = await api('POST', '/api/v2/browser-profile/batch/cookie/undo', { profile_ids: [p1.profile_id], preview: false });
    const nrItem = (notRun.json?.data?.failed || [])[0];
    check('有记录但环境没跑 → not_running（不为了撤销偷偷起内核）',
      nrItem?.reason === 'not_running', JSON.stringify(nrItem?.reason));
    check('没跑的那条**没有**把记录删掉（还能等环境起来再撤）',
      undoStore.hasMergeSnapshot(p1.profile_id) === true);

    // ③ 环境进了回收站
    undoStore.saveMergeSnapshot(p2.profile_id, [ck('sid', 'old')]);
    prof.deleteProfiles([p2.profile_id]);
    const recycled = await api('POST', '/api/v2/browser-profile/batch/cookie/undo', { profile_ids: [p2.profile_id], preview: false });
    const rcItem = (recycled.json?.data?.failed || [])[0];
    check('环境在回收站 → in_recycle_bin（并说清「先恢复再撤销」），不是 500',
      recycled.status === 200 && rcItem?.reason === 'in_recycle_bin' && /回收站/.test(rcItem?.error_message || ''),
      JSON.stringify({ status: recycled.status, reason: rcItem?.reason }));

    // ④ 环境被彻底删掉
    undoStore.saveMergeSnapshot(p3.profile_id, [ck('sid', 'old')]);
    prof.deleteProfiles([p3.profile_id]);
    prof.purgeProfiles([p3.profile_id]);
    const gone = await api('POST', '/api/v2/browser-profile/batch/cookie/undo', { profile_ids: [p3.profile_id], preview: false });
    const gItem = (gone.json?.data?.failed || [])[0];
    check('环境被彻底删除 → not_found，接口不崩（HTTP 200 + 逐条原因）',
      gone.status === 200 && gItem?.reason === 'not_found', JSON.stringify({ status: gone.status, reason: gItem?.reason }));

    // ⑤ 记录损坏
    const p4 = prof.createProfile({ name: `undo-d-${Date.now()}`, group_id: '0' });
    fs.mkdirSync(undoStore.COOKIE_UNDO_DIR, { recursive: true });
    fs.writeFileSync(undoStore.undoFileFor(p4.profile_id), 'not json at all', 'utf8');
    const corrupt = await api('POST', '/api/v2/browser-profile/batch/cookie/undo', { profile_ids: [p4.profile_id], preview: false });
    const cItem = (corrupt.json?.data?.failed || [])[0];
    check('记录损坏 → snapshot_corrupt（明确是记录的问题，不是「没有可撤销」）',
      corrupt.status === 200 && cItem?.reason === 'snapshot_corrupt', JSON.stringify(cItem?.reason));

    // ⑥ GET 状态：点之前就知道有没有得撤
    undoStore.saveMergeSnapshot(p1.profile_id, [ck('sid', 'old')]);
    const st = await api('GET', `/api/v2/browser-profile/batch/cookie/undo?profile_ids=${p1.profile_id},${p4.profile_id}`);
    const stList = st.json?.data?.list || [];
    check('GET 状态：一个可撤销（available=true）、一个记录损坏（available=false + snapshot_corrupt），available_count=1',
      stList.length === 2
      && stList.find((x) => x.profile_id === p1.profile_id)?.available === true
      && stList.find((x) => x.profile_id === p4.profile_id)?.available === false
      && stList.find((x) => x.profile_id === p4.profile_id)?.reason === 'snapshot_corrupt'
      && st.json?.data?.available_count === 1,
      JSON.stringify(stList.map((x) => [x.profile_id.slice(0, 8), x.available, x.reason])));
    check('GET 状态里带 merged_at / before_total（界面能显示「撤销回到哪一刻」）',
      stList.find((x) => x.profile_id === p1.profile_id)?.before_total === 1
      && !!stList.find((x) => x.profile_id === p1.profile_id)?.merged_at,
      JSON.stringify(stList.find((x) => x.profile_id === p1.profile_id)));

    // ⑦ 缺 profile_ids 一律报错（批量纪律：不许当成「一条都没选」）
    const bad = await api('POST', '/api/v2/browser-profile/batch/cookie/undo', {});
    check('缺 profile_ids → 100002 + field（绝不当成「一条都没选」然后 code=0）',
      bad.json?.code === 100002 && bad.json?.data?.field === 'profile_ids',
      JSON.stringify({ code: bad.json?.code, field: bad.json?.data?.field }));

    // ⑧ 静态：合并路径**真的**调了 saveMergeSnapshot，且只对 merge 调
    const routesSrc = fs.readFileSync(new URL('../src/api/routes.js', import.meta.url), 'utf8');
    const mergeBlock = routesSrc.slice(routesSrc.indexOf("'/api/v2/browser-profile/batch/cookie'"), routesSrc.indexOf("'/api/v2/browser-profile/batch/cookie/undo'"));
    check('静态：合并路由里调了 saveMergeSnapshot，且被 `plan.mode === \'merge\'` 门控（restore 不落记录）',
      /saveMergeSnapshot\(/.test(mergeBlock) && /plan\.mode === 'merge'/.test(mergeBlock));
    check('静态：快照写失败会 `continue`（放弃这次合并），不是吞掉异常继续写',
      /snapshot_failed/.test(mergeBlock) && /continue;/.test(mergeBlock));
    check('静态：撤销成功后 clearMergeSnapshot（第二次撤销才能如实说「没有」）',
      /clearMergeSnapshot\(p\.id\)/.test(routesSrc));
  } finally {
    server.close();
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
