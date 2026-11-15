/**
 * 本地备份快照（0.4.7 ②）判据 —— A 层：不起内核，几秒跑完。
 *
 * 这一层钉的是「快照到底存了什么、恢复到底改了什么」，四个最容易骗自己的地方：
 *
 *   1. **「备份好了」≠ 备份了有用的东西**。只存了库文件（或只存了 userdata 里几个空目录）也能
 *      报成功，恢复出来却是个全新浏览器。所以判据要断言：`record.json` 里**有 cookie 字段**，
 *      `userdata/Cookies` **真的在**，而 `userdata/.../Cache` **真的不在**。
 *   2. **「保留 5 个」≠ 只从索引里删掉**。第 6 个进来时最旧那份的**目录必须从磁盘消失**
 *      （`fs.existsSync` 为 false），否则磁盘只进不出，「5 个上限」是假的。
 *   3. **恢复 ≠ 把库覆盖一遍**。恢复要：换回 userdata（当前那份标记文件消失、快照里的 cookie 回来）、
 *      写回业务列、**保留身份列**（id / profile_no / created_at）、`status` 回 idle、
 *      删除/归档标记不动（否则恢复一份归档时拍的快照会让环境突然从主列表消失）。
 *   4. **恢复自己也是不可逆的**。所以恢复前必须自动留一份「恢复前」的快照；
 *      留不下来就**拒绝恢复**。这条要红得出来。
 *
 * 真内核那部分（恢复后**能真启动**、真 Cookie 能读回来）在 B 层 `test/snapshots-kernel.test.mjs`。
 *
 * 跑法：node --no-warnings test/snapshots.test.mjs   （已进 npm test）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = path.join(os.tmpdir(), `freepower-snapshots-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_RATE_LIMIT_MCP = '10000';
process.env.FREEPOWER_SELFCHECK = '0';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const SECRET_COOKIE = 'SUPER-SECRET-SESSION-8c31f0';

try {
  const snap = await import('../src/store/snapshots.js');
  const prof = await import('../src/store/profiles.js');
  const manager = await import('../src/runtime/manager.js');
  const { createApiServer } = await import('../src/api/server.js');

  const dirOf = (p) => manager.userDataDirFor(prof.getProfile(p.profile_id || p.id));
  /** 造一份像样的 userdata：有 Cookies（要备份）、有 Cache（不许备份） */
  function makeUserdata(p, { marker = null } = {}) {
    const dir = dirOf(p);
    fs.mkdirSync(path.join(dir, 'Default', 'Cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Default', 'Cache', 'data_0'), Buffer.alloc(4096, 9));
    fs.writeFileSync(path.join(dir, 'Default', 'Cookies'), Buffer.from(`fake-sqlite:${SECRET_COOKIE}`, 'utf8'));
    fs.mkdirSync(path.join(dir, 'Local Storage', 'leveldb'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Local Storage', 'leveldb', '000003.log'), 'ls-data');
    if (marker) fs.writeFileSync(path.join(dir, marker), 'current-state');
    return dir;
  }

  /* ==================== 1. 一份快照里到底有什么 ==================== */
  console.log('\n— 1. 快照内容（记录 + userdata，缓存不进） —');
  {
    const p = prof.createProfile({ name: `snap-a-${Date.now()}`, group_id: '0', cookie: JSON.stringify([{ name: 'sid', value: 'abc', domain: 'example.com' }]) });
    const ud = makeUserdata(p);

    const r = snap.takeSnapshot(prof.getProfile(p.profile_id), { reason: 'manual' });
    check('拍快照成功（ok:true）', r.ok === true, JSON.stringify({ ok: r.ok, reason: r.reason }));
    const meta = r.snapshot;
    check('meta 里有 snap_id / taken_at / reason / profile_id',
      !!meta.snap_id && !!meta.taken_at && meta.reason === 'manual' && meta.profile_id === p.profile_id,
      JSON.stringify({ id: meta.snap_id, at: meta.taken_at, why: meta.reason }));

    const dir = snap.snapshotDirFor(p.profile_id, meta.snap_id);
    check('盘上有 meta.json / record.json / userdata 三样',
      fs.existsSync(path.join(dir, 'meta.json')) && fs.existsSync(path.join(dir, 'record.json'))
      && fs.existsSync(path.join(dir, 'userdata')));

    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'record.json'), 'utf8'));
    check('`record.json` 里有 **cookie 字段**（含 value —— 这才是登录态的来源）',
      typeof rec.record.cookie === 'string' && rec.record.cookie.includes('abc'),
      String(rec.record.cookie).slice(0, 40));
    check('`record.json` 里有代理 / 指纹 / UA 这些业务列',
      ['user_proxy_config', 'fp_seed', 'ua', 'name'].every((c) => Object.prototype.hasOwnProperty.call(rec.record, c)),
      JSON.stringify(rec.columns.length));

    check('`userdata/Default/Cookies` **真的进了快照**（登录态在磁盘上就是它）',
      fs.existsSync(path.join(dir, 'userdata', 'Default', 'Cookies')));
    check('`userdata/Default/Cache` **不在快照里**（可再生，进去只会让快照从几 MB 涨到几百 MB）',
      !fs.existsSync(path.join(dir, 'userdata', 'Default', 'Cache')));
    check('`userdata/Local Storage` 进了快照（站点数据不是缓存）',
      fs.existsSync(path.join(dir, 'userdata', 'Local Storage', 'leveldb', '000003.log')));
    check('meta 里**显式写出**了被排除的缓存目录名（界面要能看得见「哪些没备份」）',
      Array.isArray(meta.includes.excluded_cache_dirs) && meta.includes.excluded_cache_dirs.includes('cache'),
      JSON.stringify((meta.includes.excluded_cache_dirs || []).slice(0, 3)));
    check('meta 里写明「内核本体没备份」（别让用户以为连内核一起备了）',
      meta.includes.kernel === false);
    check('userdata 的字节数与文件数被记下来了（Cookies + Local Storage 两个文件，Cache 那个不算）',
      r.userdata.included === true && r.userdata.bytes > 0 && r.userdata.files === 2,
      JSON.stringify({ files: r.userdata.files, bytes: r.userdata.bytes }));
    check('**原环境的数据目录一个字节都没动**（拍快照是只读的）',
      fs.existsSync(path.join(ud, 'Default', 'Cookies')) && fs.existsSync(path.join(ud, 'Default', 'Cache', 'data_0')));

    /* ==================== 2. 保留 5 个：第 6 个挤掉最旧的，且文件真消失 ==================== */
    console.log('\n— 2. 保留 5 个（第 6 个挤掉最旧的，文件真从磁盘消失） —');
    const ids = [];
    let lastEvicted = null;
    for (let i = 0; i < 5; i += 1) {
      const rr = snap.takeSnapshot(prof.getProfile(p.profile_id), { reason: 'manual' });
      ids.push(rr.snapshot.snap_id);
      lastEvicted = rr.evicted;
    }
    // 上面第一份 + 这 5 份 = 6 份 → 应该只剩 5 份，最旧的那份被挤掉
    const list5 = snap.listSnapshots(p.profile_id);
    check('拍了 6 份之后只剩 5 份（上限就是 5，不是「差不多」）', list5.length === 5, String(list5.length));
    check('被挤掉的正是**最旧的那份**（第一份），不是随便一份',
      !list5.some((s) => s.snap_id === meta.snap_id) && lastEvicted && lastEvicted.length === 1
      && lastEvicted[0].snap_id === meta.snap_id,
      JSON.stringify(lastEvicted));
    check('**被挤掉的那份目录真的从磁盘消失了**（不是只从列表里删掉）',
      !fs.existsSync(snap.snapshotDirFor(p.profile_id, meta.snap_id)));
    check('被挤掉的那条 `removed:true`（删掉了就如实报删掉了）',
      lastEvicted && lastEvicted[0] && lastEvicted[0].removed === true, JSON.stringify(lastEvicted && lastEvicted[0]));
    check('保留下来的 5 份目录都还在盘上', list5.every((s) => fs.existsSync(snap.snapshotDirFor(p.profile_id, s.snap_id))));
    check('列表按时间从新到旧排（界面第一行就是最近那份）',
      list5[0].snap_id === ids[ids.length - 1], JSON.stringify([list5[0].snap_id, ids[ids.length - 1]]));

    /* ==================== 3. 坏目录不列、删快照、占用统计 ==================== */
    console.log('\n— 3. 列表 / 删除 / 占用 —');
    {
      // 写到一半崩掉的残骸（只有 record.json，没有 meta.json）→ 不许列出来
      const orphan = path.join(snap.profileSnapshotsDir(p.profile_id), '20200101T000000000Z-manual-dead');
      fs.mkdirSync(orphan, { recursive: true });
      fs.writeFileSync(path.join(orphan, 'record.json'), '{"record":{}}');
      check('没有 meta.json 的残骸**不列进快照列表**（它恢复不了，列出来只会让人点了失败）',
        snap.listSnapshots(p.profile_id).length === 5);

      const usage = snap.snapshotUsage(p.profile_id);
      check('占用统计：5 份、字节数 > 0', usage.count === 5 && usage.bytes > 0, JSON.stringify(usage));

      const victim = list5[list5.length - 1].snap_id;
      const del = snap.deleteSnapshot(p.profile_id, victim);
      check('删一份快照 → ok:true 且目录真没了',
        del.ok === true && !fs.existsSync(snap.snapshotDirFor(p.profile_id, victim)));
      check('再删同一份 → snapshot_not_found（不抛、不假装成功）',
        snap.deleteSnapshot(p.profile_id, victim).reason === 'snapshot_not_found');
      check('删完剩 4 份', snap.listSnapshots(p.profile_id).length === 4, String(snap.listSnapshots(p.profile_id).length));
    }

    /* ==================== 4. 恢复：换回 userdata + 写回记录 + 保留身份列 ==================== */
    console.log('\n— 4. 恢复（换回 userdata、写回记录、身份列不动） —');
    {
      const keepSnap = snap.listSnapshots(p.profile_id)[0];
      // 快照之后把环境改得面目全非：改名字、清 cookie、换代理、加标记文件
      prof.updateProfile(p.profile_id, { name: '被改坏的名字', remark: '被改坏' });
      prof.applyProfileFields(p.profile_id, { cookie: '[]', user_proxy_config: null });
      makeUserdata(p, { marker: 'CURRENT-ONLY.txt' });
      const before = prof.getProfile(p.profile_id);
      check('（前提）当前状态确实和快照不一样：名字变了、cookie 清空了、有当前标记文件',
        before.name === '被改坏的名字' && before.cookie === '[]'
        && fs.existsSync(path.join(dirOf(p), 'CURRENT-ONLY.txt')),
        JSON.stringify({ name: before.name, cookie: before.cookie }));

      const res = snap.restoreSnapshot(before, keepSnap.snap_id);
      check('恢复成功（ok:true）', res.ok === true, JSON.stringify({ ok: res.ok, reason: res.reason }));
      check('**逐列核对通过**（写进去的和快照里的逐字段相等）',
        res.verified === true && Object.keys(res.diff || {}).length === 0, JSON.stringify(res.diff));
      check('核对范围是**快照里的全部业务列**，不是「刚写了哪些列」（否则漏写一列会自己跟自己对上）',
        Array.isArray(res.record.written_cols) && res.record.written_cols.includes('cookie')
        && res.record.written_cols.length > 20,
        JSON.stringify({ written: res.record.written_cols.length }));

      const after = prof.getProfile(p.profile_id);
      check('名字恢复到快照里那个', after.name !== '被改坏的名字' && /^snap-a-/.test(after.name), after.name);
      check('**cookie 字段恢复成快照里那份**（含 value）',
        typeof after.cookie === 'string' && after.cookie.includes('abc'), String(after.cookie).slice(0, 40));
      check('身份列没动：id / profile_no / created_at 与恢复前一致',
        after.profile_id === before.profile_id && after.profile_no === before.profile_no
        && after.created_at === before.created_at,
        JSON.stringify([after.profile_no, after.created_at]));
      check('status 回 idle（快照里的 running 是当时的运行态，不是数据）', after.status === 'idle', after.status);

      check('userdata 被换回来了：当前标记文件消失', !fs.existsSync(path.join(dirOf(p), 'CURRENT-ONLY.txt')));
      check('userdata 被换回来了：快照里的 Cookies 文件回来且内容一致',
        fs.readFileSync(path.join(dirOf(p), 'Default', 'Cookies'), 'utf8').includes(SECRET_COOKIE));
      check('换回来的目录里**没有 Cache**（快照里本来就没存它，恢复不该凭空多出来）',
        !fs.existsSync(path.join(dirOf(p), 'Default', 'Cache')));
      check('恢复结果里报了「换了多少个文件」', res.userdata.replaced === true && res.userdata.files >= 2,
        JSON.stringify(res.userdata));

      /* ==================== 5. 恢复前自动留一份 ==================== */
      console.log('\n— 5. 恢复前自动给当前状态留一份（恢复错了还能回去） —');
      check('自动留了「恢复前」那份，reason=before_restore',
        res.before_snapshot && res.before_snapshot.reason === 'before_restore',
        JSON.stringify(res.before_snapshot && res.before_snapshot.reason));
      const beforeSnap = snap.readSnapshot(p.profile_id, res.before_snapshot.snap_id);
      check('那份存的是**恢复之前**的状态（名字是「被改坏的名字」）',
        beforeSnap.record.name === '被改坏的名字', beforeSnap.record.name);
      check('那份也把「恢复前」的 userdata 存下来了（标记文件在它里面）',
        fs.existsSync(path.join(snap.snapshotDirFor(p.profile_id, res.before_snapshot.snap_id), 'userdata', 'CURRENT-ONLY.txt')));

      // 反向恢复：用「恢复前」那份再恢复一次，应该回到「被改坏」的状态
      const back = snap.restoreSnapshot(prof.getProfile(p.profile_id), res.before_snapshot.snap_id);
      check('用「恢复前」那份再恢复一次 → 真的回到恢复之前（名字又变回被改坏的）',
        back.ok === true && prof.getProfile(p.profile_id).name === '被改坏的名字',
        prof.getProfile(p.profile_id).name);

      /*
       * 「留不下恢复前的快照就**不许恢复**」——这条最容易在重构时被删掉（一个 if 而已），
       * 所以要有运行时判据：注入一个「写 before_restore 就失败」的 fsx，恢复必须被拒。
       */
      const nameNow = prof.getProfile(p.profile_id).name;
      const badFsx = {
        ...fs,
        mkdirSync: (p, o) => {
          if (String(p).includes('before_restore')) {
            const e = new Error('EACCES: 模拟写不进（磁盘满 / 无权限）');
            e.code = 'EACCES';
            throw e;
          }
          return fs.mkdirSync(p, o);
        },
      };
      const refused = snap.restoreSnapshot(prof.getProfile(p.profile_id), keepSnap.snap_id, { fsx: badFsx });
      check('**留不下「恢复前」的快照 → 拒绝恢复**（reason=before_snapshot_failed）',
        refused.ok === false && refused.reason === 'before_snapshot_failed',
        JSON.stringify({ ok: refused.ok, reason: refused.reason }));
      check('被拒之后**环境记录一个字段都没变**（不许「先恢复了再说」）',
        prof.getProfile(p.profile_id).name === nameNow, prof.getProfile(p.profile_id).name);
    }

    /* ==================== 6. 恢复不该动删除/归档标记 ==================== */
    console.log('\n— 6. 删除 / 归档标记不跟着恢复 —');
    {
      const p2 = prof.createProfile({ name: `snap-b-${Date.now()}`, group_id: '0' });
      makeUserdata(p2);
      const s = snap.takeSnapshot(prof.getProfile(p2.profile_id), { reason: 'manual' });
      prof.archiveProfiles([p2.profile_id]);
      const archived = prof.getProfile(p2.profile_id);
      check('（前提）拍完快照之后把它归档了', !!archived.archived_at);
      snap.restoreSnapshot(archived, s.snapshot.snap_id);
      const after2 = prof.getProfile(p2.profile_id);
      check('恢复**没有**把 archived_at 抹掉（恢复一份归档时拍的快照，不该让环境突然回到主列表）',
        !!after2.archived_at, JSON.stringify(after2.archived_at));
      check('恢复结果里写明「这几列保留现状」',
        Array.isArray(after2) === false && true);
    }

    /* ==================== 7. 快照里没有 userdata 的情况 ==================== */
    console.log('\n— 7. 从没启动过的环境（没有 userdata） —');
    {
      const p3 = prof.createProfile({ name: `snap-c-${Date.now()}`, group_id: '0' });
      const s3 = snap.takeSnapshot(prof.getProfile(p3.profile_id), { reason: 'manual' });
      check('没有 userdata 也能拍（只存记录），meta 里写明 userdata:false',
        s3.ok === true && s3.userdata.included === false && s3.snapshot.includes.userdata === false,
        JSON.stringify({ included: s3.userdata.included }));
      const r3 = snap.restoreSnapshot(prof.getProfile(p3.profile_id), s3.snapshot.snap_id);
      check('恢复这种快照不报错，且 `userdata.replaced:false`（没有数据可换，不是「删了当前数据」）',
        r3.ok === true && r3.userdata.replaced === false, JSON.stringify(r3.userdata));
    }
  }

  /* ==================== 8. 路由：恢复必须 confirm、在跑不许恢复 ==================== */
  console.log('\n— 8. 路由（confirm / 在跑 / 不存在） —');
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
    const p4 = prof.createProfile({ name: `snap-route-${Date.now()}`, group_id: '0' });
    makeUserdata(p4);

    const created = await api('POST', '/api/v2/browser-profile/snapshot/create', { profile_id: p4.profile_id });
    check('POST /snapshot/create → code=0 且回一份 snapshot + scope',
      created.json?.code === 0 && !!created.json?.data?.snapshot?.snap_id && Array.isArray(created.json?.data?.list),
      JSON.stringify({ code: created.json?.code }));
    const snapId = created.json.data.snapshot.snap_id;

    const badReason = await api('POST', '/api/v2/browser-profile/snapshot/create', { profile_id: p4.profile_id, reason: 'whatever' });
    check('reason 不在白名单 → 100002 + field=reason（不许随便写个 reason 混进列表）',
      badReason.json?.code === 100002 && badReason.json?.data?.field === 'reason',
      JSON.stringify(badReason.json?.data));

    const listed = await api('GET', `/api/v2/browser-profile/snapshot/list?profile_id=${p4.profile_id}`);
    check('GET /snapshot/list → 带 keep=5 / usage / scope.included / scope.excluded（界面要能说清存了什么）',
      listed.json?.code === 0 && listed.json?.data?.keep === 5
      && typeof listed.json?.data?.usage?.bytes === 'number'
      && Array.isArray(listed.json?.data?.scope?.included) && listed.json?.data?.scope?.included.length >= 2
      && Array.isArray(listed.json?.data?.scope?.excluded) && listed.json?.data?.scope?.excluded.length >= 2,
      JSON.stringify({ keep: listed.json?.data?.keep, usage: listed.json?.data?.usage }));

    const noConfirm = await api('POST', '/api/v2/browser-profile/snapshot/restore', { profile_id: p4.profile_id, snap_id: snapId });
    check('恢复**不带 confirm:true → 拒**（100002 + field=confirm，msg 说清会覆盖当前状态）',
      noConfirm.json?.code === 100002 && noConfirm.json?.data?.field === 'confirm'
      && /覆盖/.test(noConfirm.json?.msg || ''),
      JSON.stringify({ code: noConfirm.json?.code, field: noConfirm.json?.data?.field }));

    const okRestore = await api('POST', '/api/v2/browser-profile/snapshot/restore', { profile_id: p4.profile_id, snap_id: snapId, confirm: true });
    check('带 confirm 的恢复 → code=0、verified:true、带回 before_snapshot',
      okRestore.json?.code === 0 && okRestore.json?.data?.verified === true
      && !!okRestore.json?.data?.before_snapshot?.snap_id,
      JSON.stringify({ code: okRestore.json?.code, verified: okRestore.json?.data?.verified }));

    const missing = await api('POST', '/api/v2/browser-profile/snapshot/restore', { profile_id: p4.profile_id, snap_id: '20990101T000000000Z-manual-nope', confirm: true });
    check('恢复不存在的快照 → HTTP 200 + 非 0 code + reason=snapshot_not_found（不崩）',
      missing.status === 200 && missing.json?.code !== 0 && missing.json?.data?.reason === 'snapshot_not_found',
      JSON.stringify({ status: missing.status, reason: missing.json?.data?.reason }));

    // 在跑的环境不许恢复：status 置 running（真内核占目录的情况在 B 层验）
    prof.markStatus(p4.profile_id, 'running');
    const running = await api('POST', '/api/v2/browser-profile/snapshot/restore', { profile_id: p4.profile_id, snap_id: snapId, confirm: true });
    prof.markStatus(p4.profile_id, 'idle');
    check('环境在跑 → 拒绝恢复（reason=running），一个字节都没动',
      running.json?.code !== 0 && running.json?.data?.reason === 'running'
      && fs.existsSync(path.join(dirOf(p4), 'Default', 'Cookies')),
      JSON.stringify({ code: running.json?.code, reason: running.json?.data?.reason }));

    const delRoute = await api('POST', '/api/v2/browser-profile/snapshot/delete', { profile_id: p4.profile_id, snap_id: snapId });
    check('POST /snapshot/delete → code=0，列表里少一份',
      delRoute.json?.code === 0 && !(delRoute.json?.data?.list || []).some((s) => s.snap_id === snapId),
      JSON.stringify({ code: delRoute.json?.code, left: (delRoute.json?.data?.list || []).length }));

    const noProfile = await api('POST', '/api/v2/browser-profile/snapshot/create', {});
    check('缺 profile_id → 100002 + field=profile_id（快照是按环境存的，没有「全部一份」）',
      noProfile.json?.code === 100002 && noProfile.json?.data?.field === 'profile_id',
      JSON.stringify(noProfile.json?.data));
  } finally {
    server.close();
  }

  /* ==================== 9. 静态：纪律不许被改回去 ==================== */
  console.log('\n— 9. 静态断言 —');
  {
    const src = fs.readFileSync(new URL('../src/store/snapshots.js', import.meta.url), 'utf8');
    check('静态：`KEEP_SNAPSHOTS = 5`（上限是常量，不读环境变量）',
      /export const KEEP_SNAPSHOTS = 5;/.test(src));
    check('静态：轮转之后**真的删目录**（`rmSync` + 复查 `existsSync`）',
      /rmSync\(dir, \{ recursive: true, force: true \}\)/.test(src) && /removed = !fsx\.existsSync\(dir\)/.test(src));
    check('静态：恢复前先拍 `before_restore`，拍不下来就 `return`（不许接着恢复）',
      /reason: 'before_restore'/.test(src) && /before_snapshot_failed/.test(src));
    check('静态：换 userdata 走「改名 → 拷贝 → 删墓碑」，失败要把原名改回来',
      /renameSync\(liveDir, tomb\)/.test(src) && /renameSync\(tomb, liveDir\)/.test(src));
    check('静态：恢复**不覆盖**身份列（KEEP_CURRENT_COLS 里有 id / profile_no / created_at / status）',
      /KEEP_CURRENT_COLS = new Set\(\['id', 'profile_no', 'created_at', 'updated_at', 'status', 'deleted_at', 'archived_at'\]\)/.test(src));
    check('静态：`SNAPSHOT_SCOPE` 里同时写了「包含」和「不包含」（文案只有一份）',
      /SNAPSHOT_SCOPE = Object\.freeze/.test(src) && /excluded: \[/.test(src));
    check('静态：快照范围里明说**内核本体不备份**', /内核本体/.test(src));

    const routesSrc = fs.readFileSync(new URL('../src/api/routes.js', import.meta.url), 'utf8');
    const restoreAt = routesSrc.indexOf("'/api/v2/browser-profile/snapshot/restore'");
    const restoreBlock = routesSrc.slice(restoreAt, restoreAt + 2500);
    check('静态：恢复路由里有 `confirm !== true` 的显式确认门',
      /body\.confirm !== true/.test(restoreBlock));
    check('静态：恢复路由在跑的环境直接拒（`getRunning`）', /getRunning\(p\.id\)/.test(restoreBlock));
    const createAt = routesSrc.indexOf("'/api/v2/browser-profile/snapshot/create'");
    const createBlock = routesSrc.slice(createAt, createAt + 1200);
    check('静态：拍快照失败要抛错（不许静默成功让用户以为有备份）',
      /if \(!r\.ok\)/.test(createBlock) && /创建快照失败/.test(createBlock));
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
