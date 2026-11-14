/**
 * 环境管理页内 tabs（0.4.3 ②）判据 —— A 层：不起内核，几百毫秒跑完。
 *
 * 形态依据：逆向 `28-远端UI界面结构.md` —— 对手的「环境管理」是**一个侧栏项 + 页内 tabs**
 * （环境列表 / 分组管理 / 回收站），侧栏没有二级展开菜单。
 *
 * 这里钉四件事：
 *   1. tabs 是**真页面**：三个 hash 各注册了路由、每个页面自己画 tab 条（切 tab 不丢条）、
 *      tab 是 <a href>（能中键开、能收藏），而且 `/profiles/groups|recycle` 不会被 `/profiles/:id` 吃掉。
 *   2. 分组：环境数只数在用的（回收站里的不算）、重命名/改备注、**删组不删环境**（挪回 Default）、
 *      Default 不能删。
 *   3. 回收站：list 形状仍是 6 字段 + 无 total；restore 必须带 group_id；
 *      purge（我们自己的路由）**只删回收站里的**、盘删不掉就不删库、
 *      **字段没给必须报错**（全量动作最怕拼错字段被当成「全清」）。
 *   4. 文案：列表页的「删除」必须说「进回收站、可恢复」——早先写的是「本地硬删，不可恢复」，那是错的。
 *
 * 跑法：node --no-warnings test/profiles-tabs.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(os.tmpdir(), `freepower-tabs-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });

process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_RATE_LIMIT_MCP = '10000';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

try {
  const tabs = await import('../web/tabs.js');
  const prof = await import('../src/store/profiles.js');
  const { userDataDirFor } = await import('../src/runtime/manager.js');
  const { createApiServer } = await import('../src/api/server.js');
  const { closeDb } = await import('../src/store/db.js');

  /* ============================ 1. tab 模型（纯函数） ============================ */
  console.log('\n— 1. tab 模型 —');

  check('三个 tab，顺序照对手：环境列表 / 分组管理 / 回收站',
    tabs.PROFILE_TABS.map((t) => t.label).join('/') === '环境列表/分组管理/回收站',
    tabs.PROFILE_TABS.map((t) => t.label).join('/'));
  check('三个 tab 各有自己的 hash（不是同一个页面里切变量）',
    tabs.PROFILE_TABS.map((t) => t.hash).join(' ') === '#/profiles #/profiles/groups #/profiles/recycle',
    tabs.PROFILE_TABS.map((t) => t.hash).join(' '));

  check('tabOf：/profiles → list', tabs.tabOf('/profiles') === 'list');
  check('tabOf：/profiles/groups → groups', tabs.tabOf('/profiles/groups') === 'groups');
  check('tabOf：/profiles/recycle → recycle', tabs.tabOf('/profiles/recycle') === 'recycle');
  check('tabOf：末尾斜杠也认（/profiles/groups/ → groups）', tabs.tabOf('/profiles/groups/') === 'groups');
  check('tabOf：环境编辑页 /profiles/<id> 不是 tab（返回 null，不能被当成列表页）',
    tabs.tabOf('/profiles/2f1c9a3e-0000') === null);

  /* ============================ 2. 路由与页面（静态） ============================ */
  console.log('\n— 2. 路由与页面 —');

  const appJs = read('web/app.js');
  const idRouteAt = appJs.indexOf('/^\\/profiles\\/([^/]+)$/');
  const groupsRouteAt = appJs.indexOf('/^\\/profiles\\/groups$/');
  const recycleRouteAt = appJs.indexOf('/^\\/profiles\\/recycle$/');
  check('app.js 注册了 /profiles/groups 与 /profiles/recycle 两条路由',
    groupsRouteAt > 0 && recycleRouteAt > 0);
  check('这两条排在 /profiles/([^/]+) 前面（否则 groups 会被当成环境 id 打开编辑页）',
    groupsRouteAt > 0 && recycleRouteAt > 0 && idRouteAt > 0 && groupsRouteAt < idRouteAt && recycleRouteAt < idRouteAt,
    `groups@${groupsRouteAt} recycle@${recycleRouteAt} id@${idRouteAt}`);
  check('app.js import 了分组页与回收站页',
    /import groupsPage from '\.\/pages\/groups\.js'/.test(appJs) && /import recyclePage from '\.\/pages\/recycle\.js'/.test(appJs));

  const pages = {
    list: read('web/pages/profiles.js'),
    groups: read('web/pages/groups.js'),
    recycle: read('web/pages/recycle.js'),
  };
  for (const [id, src] of Object.entries(pages)) {
    check(`页面 ${id}：自己画 tab 条（tabBar('${id}')），切过去不会丢条`,
      src.includes(`tabBar('${id}')`), '');
  }
  check('tab 是链接不是按钮（<a href>，能中键开 / 收藏 / 地址栏直达）',
    /href: t\.hash/.test(read('web/tabs.js')) && /aria-current/.test(read('web/tabs.js')));

  /* ============================ 3. 分组（真 HTTP） ============================ */
  console.log('\n— 3. 分组 —');

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

  const g = await api('POST', '/api/v2/group/create', { group_name: '投放组' });
  const gid = g.json?.data?.group_id;
  check('新建分组：code=0、回 group_id', g.json?.code === 0 && !!gid, JSON.stringify(g.json?.data));

  const p1 = prof.createProfile({ name: 'tab-a', group_id: gid });
  const p2 = prof.createProfile({ name: 'tab-b', group_id: gid });

  let list = await api('GET', '/api/v2/group/list');
  let mine = (list.json?.data?.list || []).find((x) => String(x.group_id) === String(gid));
  check('分组列表带 profile_count（界面上那个数字有真来源，不是写死的 0）',
    mine && mine.profile_count === 2, JSON.stringify(mine));

  const ren = await api('POST', '/api/v2/group/update', { group_id: gid, group_name: '投放组-改名', remark: '备注一句' });
  check('重命名 + 改备注：code=0', ren.json?.code === 0, JSON.stringify(ren.json?.data));
  list = await api('GET', '/api/v2/group/list');
  mine = (list.json?.data?.list || []).find((x) => String(x.group_id) === String(gid));
  check('改名与备注都读得回来',
    mine?.group_name === '投放组-改名' && mine?.remark === '备注一句', JSON.stringify(mine));

  const delDefault = await api('POST', '/api/v2/group/delete', { group_id: '0' });
  check('Default 分组不能删：100002（不是静默成功）',
    delDefault.json?.code === 100002 && /default group/.test(delDefault.json.msg), delDefault.json?.msg);

  const del = await api('POST', '/api/v2/group/delete', { group_id: gid });
  check('删分组：如实回挪走了几个环境（moved=2）',
    del.json?.code === 0 && del.json.data.moved === 2, JSON.stringify(del.json?.data));
  const afterMove = prof.getProfile(p1.id);
  check('删分组不删环境：环境还在，分组回到 Default',
    afterMove && String(afterMove.group_id) === '0', JSON.stringify({ g: afterMove?.group_id }));

  /* ============================ 4. 回收站 ============================ */
  console.log('\n— 4. 回收站 —');

  // 造一个 user-data 目录，purge 要把它真删掉
  const udd1 = userDataDirFor(prof.getProfile(p1.id));
  fs.mkdirSync(udd1, { recursive: true });
  fs.writeFileSync(path.join(udd1, 'Cookies'), 'not-a-real-cookie-db');

  await api('POST', '/api/v2/browser-profile/delete', { profile_id: [p1.id] });
  let bin = await api('POST', '/api/v2/browser-profile/recycle-bin/list', { page: 1, limit: 100 });
  check('删除后进回收站（不是硬删）：回收站里能看到它',
    (bin.json?.data?.list || []).some((x) => x.profile_id === p1.id), JSON.stringify(bin.json?.data?.list?.length));
  const item = (bin.json?.data?.list || []).find((x) => x.profile_id === p1.id);
  check('回收站 item 严格 6 字段（形状对齐 22- 号文）',
    Object.keys(item || {}).sort().join(',') === 'delete_time,group_name,name,profile_id,profile_no,remark',
    Object.keys(item || {}).join(','));
  check('data 只有 list/page/limit，没有 total', bin.json?.data?.total === undefined
    && Object.keys(bin.json?.data || {}).sort().join(',') === 'limit,list,page', Object.keys(bin.json?.data || {}).join(','));

  const badRestore = await api('POST', '/api/v2/browser-profile/recycle-bin/restore', { profile_id: p1.id });
  check('恢复不带 group_id：100002（对手要求显式选分组）',
    badRestore.json?.code === 100002 && badRestore.json.msg === 'group_id is required', badRestore.json?.msg);

  const restore = await api('POST', '/api/v2/browser-profile/recycle-bin/restore', { profile_id: p1.id, group_id: '0' });
  check('恢复：code=0，环境回到列表', restore.json?.code === 0 && !!prof.getProfile(p1.id));

  /* ---- purge：我们自己的路由，语义要严 ---- */
  await api('POST', '/api/v2/browser-profile/delete', { profile_id: [p1.id] });

  const noField = await api('POST', '/api/v2/browser-profile/recycle-bin/purge', {});
  check('purge 一个字段都没给：100002（不当成「清空」，这是全量动作最危险的静默截断）',
    noField.json?.code === 100002 && noField.json.data?.field === 'profile_id', JSON.stringify(noField.json));
  bin = await api('POST', '/api/v2/browser-profile/recycle-bin/list', { page: 1, limit: 100 });
  check('purge 缺字段后：回收站里那条还在（没被静默清掉）',
    (bin.json?.data?.list || []).some((x) => x.profile_id === p1.id));

  const typo = await api('POST', '/api/v2/browser-profile/recycle-bin/purge', { profile_ids: [p1.id] });
  check('purge 字段名拼错（profile_ids）：也是 100002', typo.json?.code === 100002, typo.json?.msg);

  const purged = await api('POST', '/api/v2/browser-profile/recycle-bin/purge', { profile_id: [p1.id] });
  check('purge 显式指定：purged=1、userdata_removed=1',
    purged.json?.code === 0 && purged.json.data.purged.length === 1 && purged.json.data.userdata_removed === 1,
    JSON.stringify(purged.json?.data));
  check('purge 真删了 user-data 目录（cookie 跟着没了）', !fs.existsSync(path.dirname(udd1)));
  check('purge 真删了库记录（getProfile 取不到，回收站里也没有）',
    !prof.getProfile(p1.id) && !prof.getRecycledProfile({ profile_id: p1.id }));
  check('purge 之后原来的 profile_no 不会再被它占着（记录真的没了）',
    !prof.getProfileByNo(p1.profile_no));

  // 在用环境不能被 purge（不许绕过软删除做硬删）
  const purgedLive = await api('POST', '/api/v2/browser-profile/recycle-bin/purge', { profile_id: [p2.id] });
  check('purge 在用环境：code=0 但 skipped 里点名 not_in_recycle_bin，且环境还在',
    purgedLive.json?.code === 0
    && (purgedLive.json.data.skipped || []).some((s) => s.profile_id === p2.id && s.reason === 'not_in_recycle_bin')
    && !!prof.getProfile(p2.id), JSON.stringify(purgedLive.json?.data));

  /* ---- 真实故障：盘删不掉时必须不删库（不用 mock） ---- */
  /**
   * 为什么必须用**真实**失败：mock 的失败等于没验。
   * 本机探过四种「让 rmSync 真失败」的路子（`.tmp/rm-fail-probe.mjs` 的读数）：
   *   A 独占打开文件 → 删掉了（Node 默认带 FILE_SHARE_DELETE）
   *   B 子进程 cwd 在目录里 → **EPERM，删不掉**（Windows 不许删任何进程的当前目录）
   *   C `attrib +R` 只读  → 删掉了（force 会重试）
   *   D 子进程 cwd 在被删目录本身 → **EPERM，删不掉**
   * 所以用 B：起一个真进程把 cwd 设在该环境的目录里，模拟「没退干净的浏览器进程占着目录」。
   * 这不是人为构造的怪场景 —— 内核残留时 user-data 目录就是被占着的。
   */
  console.log('\n— 4b. 真实故障：user-data 占着时 purge 不许删库 —');

  const p3 = prof.createProfile({ name: 'purge-locked', group_id: '0' });
  const udd3 = userDataDirFor(prof.getProfile(p3.id));
  const lockDir = path.dirname(udd3);
  fs.mkdirSync(udd3, { recursive: true });
  fs.writeFileSync(path.join(udd3, 'Cookies'), 'locked-cookie-db');
  await api('POST', '/api/v2/browser-profile/delete', { profile_id: [p3.id] });

  // 起一个真进程，cwd 钉在那个目录里并活着（stdio 'ignore'：沙箱里不收管道）
  const locker = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 30000)'], {
    cwd: lockDir, stdio: 'ignore', windowsHide: true,
  });
  await new Promise((r) => setTimeout(r, 600));

  const lockedPurge = await api('POST', '/api/v2/browser-profile/recycle-bin/purge', { profile_id: [p3.id] });
  const lockedSkip = (lockedPurge.json?.data?.skipped || []).find((s) => s.profile_id === p3.id);
  check('盘被占住：purge 回 code=0 但 purged 为空、skipped 点名该环境（不假成功）',
    lockedPurge.json?.code === 0
    && (lockedPurge.json.data.purged || []).length === 0
    && !!lockedSkip,
    JSON.stringify(lockedPurge.json?.data));
  check('盘被占住：skipped.reason 是稳定的机器可读串 userdata_remove_failed',
    lockedSkip?.reason === 'userdata_remove_failed', String(lockedSkip?.reason));
  check('盘被占住：错误码与原文分开带出（EPERM + 原文非空）',
    lockedSkip?.error_code === 'EPERM' && !!lockedSkip?.error_message?.length,
    JSON.stringify({ code: lockedSkip?.error_code, msg: String(lockedSkip?.error_message || '').slice(0, 60) }));
  check('盘被占住：库记录还在（还能再点一次，不会变成谁也管不着的目录）',
    !!prof.getRecycledProfile({ profile_id: p3.id }));
  check('盘被占住：回收站里还列得出来', (await (async () => {
    const b = await api('POST', '/api/v2/browser-profile/recycle-bin/list', { page: 1, limit: 100 });
    return (b.json?.data?.list || []).some((x) => x.profile_id === p3.id);
  })()));
  check('盘被占住：目录与 cookie 文件都还在', fs.existsSync(udd3) && fs.existsSync(path.join(udd3, 'Cookies')));

  // 放掉占用之后，同一条应该真的删得掉 —— 否则上面那些「还在」就只是功能坏了
  try { locker.kill(); } catch { /* 可能已经退了 */ }
  await new Promise((r) => setTimeout(r, 800));
  const retried = await api('POST', '/api/v2/browser-profile/recycle-bin/purge', { profile_id: [p3.id] });
  check('放掉占用后重试：purged=1、userdata_removed=1（同一条能删掉，证明前面是真故障不是死路）',
    retried.json?.code === 0 && (retried.json.data.purged || []).includes(p3.id) && retried.json.data.userdata_removed === 1,
    JSON.stringify(retried.json?.data));
  check('放掉占用后重试：目录与库记录都没了',
    !fs.existsSync(lockDir) && !prof.getRecycledProfile({ profile_id: p3.id }));

  // 清空：all:true
  await api('POST', '/api/v2/browser-profile/delete', { profile_id: [p2.id] });
  const empty = await api('POST', '/api/v2/browser-profile/recycle-bin/purge', { all: true });
  check('purge all:true 清空回收站：purged 非空、之后列表为空',
    empty.json?.code === 0 && empty.json.data.purged.length >= 1,
    JSON.stringify({ purged: empty.json?.data?.purged, skipped: empty.json?.data?.skipped }));
  bin = await api('POST', '/api/v2/browser-profile/recycle-bin/list', { page: 1, limit: 100 });
  check('清空后回收站真的空了', (bin.json?.data?.list || []).length === 0);

  /* ============================ 5. 文案（静态） ============================ */
  console.log('\n— 5. 文案与约束 —');

  const listSrc = read('web/pages/profiles.js');
  check('列表页「删除」说的是「移入回收站、可恢复」，不再是「这是本地硬删，不可恢复」',
    /移入回收站/.test(listSrc) && !/这是本地硬删/.test(listSrc));
  check('回收站页写清了「不会自动清理」（对手写 30 天，我们不替用户删数据）',
    /不会自动清理/.test(read('web/pages/recycle.js')));
  check('彻底删除的弹窗写清不可恢复（危险动作必须说后果）',
    /不可恢复/.test(read('web/pages/recycle.js')));

  /**
   * 后端给机器可读串、界面负责翻成人话 —— 这条要被单独钉住：
   * 未知 reason 必须原样显示，不许吞成「未知原因」（那才是最难查的一类）。
   */
  const { skipReasonText } = await import('../web/pages/recycle.js');
  check('skipped 翻译：userdata_remove_failed → 说清是目录被占 + 带错误码 + 说还能再试',
    /占着它/.test(skipReasonText({ reason: 'userdata_remove_failed', error_code: 'EPERM' }))
    && /EPERM/.test(skipReasonText({ reason: 'userdata_remove_failed', error_code: 'EPERM' }))
    && /再试/.test(skipReasonText({ reason: 'userdata_remove_failed', error_code: 'EPERM' })));
  check('skipped 翻译：not_in_recycle_bin → 说清只有回收站里的能删',
    /只有回收站里的环境能彻底删除/.test(skipReasonText({ reason: 'not_in_recycle_bin' })));
  check('skipped 翻译：认不出来的 reason 原样显示，不吞成「未知原因」',
    skipReasonText({ reason: 'some_new_reason', error_code: 'EXYZ' }) === 'some_new_reason（EXYZ）',
    skipReasonText({ reason: 'some_new_reason', error_code: 'EXYZ' }));

  /* ---- 收尾 ---- */
  server.close();
  closeDb();
  await new Promise((r) => setTimeout(r, 100));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 上句柄可能还开着 */ }
} catch (e) {
  check('测试脚本自身异常', false, e.stack || e.message);
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
