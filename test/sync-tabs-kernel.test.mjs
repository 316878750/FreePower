/**
 * 标签页同步的 B 层判据：**真内核、1 主 + 2 受控**。
 *
 * CEO 点名要的三件事各一条（不许合成一条判据）：
 *   ① 关标签（按序号映射：主窗口关第 2 个 → 受控窗口关第 2 个）
 *   ② 关其它标签（留当前，其余全关）
 *   ③ 复制标签到其它窗口（不是「同步」—— 只往受控窗口去，不动主窗口）
 * 另外三条：
 *   ④ 关空白标签页（有空白才关，没空白一个都不许关）
 *   ⑤ 统一标签页（受控窗口的标签数量与每个序号的 URL 对齐主窗口）
 *   ⑥ 目标空白开关：新开标签的首个文档必须**注入已生效**且 `navigation.type === 'navigate'`
 *      —— 这条就是「不许用 Target.createTarget({url})」的判据。
 *
 * 跑法：npm run test:sync-tabs-kernel（起 3 个真环境，约 60–90 秒）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dataDir = path.join(os.tmpdir(), `freepower-synctabs-${Date.now()}`);
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
process.env.FREEPOWER_EGRESS_TIMEOUT = '800';

/**
 * 每个路径被**请求**了几次 —— 用来判「这张标签到底加载了几个文档」。
 *
 * 为什么不能用 `performance.getEntriesByType('navigation').length`：那个数组是**当前文档**的，
 * 二次加载会把当前文档整个换掉，读回来仍然是 1 条。实测（2026-11-14）：把 `openTabFor`
 * 改成 `Target.createTarget({url})` 直建带网址的标签（首帧原始指纹），那三条判据全绿 —— 抓不住。
 * 服务器计数才抓得住：好姿势 1 次，坏姿势 2 次（首帧 + 补注入时的那次重新导航）。
 */
const hits = new Map();
const srv = http.createServer((req, res) => {
  const p = String(req.url || '/');
  if (!p.startsWith('/favicon')) hits.set(p, (hits.get(p) || 0) + 1);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${p}</title></head>
<body><h1>${p}</h1></body></html>`);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const U = (p) => `http://127.0.0.1:${PORT}${p}`;

const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');
const sync = await import('../src/sync/session.js');
const { markerNames } = await import('../src/kernel/markers.js');
const { fingerprintView } = await import('../src/fingerprint/view.js');
const tabsMod = await import('../src/sync/tabs.js');

const started = [];
let insts = [];

async function evalIn(inst, sessionId, expression) {
  const r = await inst.client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    .catch(() => null);
  if (r?.exceptionDetails) return { error: r.exceptionDetails.text };
  return r?.result?.value;
}

/** 各窗口标签：URL 列表 + 数量（判据都读这个，不读「应该是什么」） */
async function tabsOf(id) {
  const inst = manager.getInstance(id);
  return tabsMod.listTabs(inst.client);
}

/**
 * 主窗口当前可见标签的序号：`visibleTabIndex` 无会话依赖，
 * 但需要「切到某张标签」才能让它变成可见 —— 用 `Target.activateTarget`。
 */
async function activate(inst, targetId) {
  await inst.client.send('Target.activateTarget', { targetId }).catch(() => {});
  await sleep(250);
}

/** 在某个环境里新开一个标签（走安全姿势，和产品同一条路径） */
async function openIn(id, url) {
  const inst = manager.getInstance(id);
  return tabsMod.openTabFor(inst.client, { url, onTarget: (tid) => inst.exemptBlankReload?.(tid) });
}

try {
  /* ------------------------------ 起 3 个环境 ------------------------------ */
  for (const name of ['tabs-master', 'tabs-slave1', 'tabs-slave2']) {
    const p = profiles.createProfile({ name: `${name}-${Date.now()}`, group_id: '0', remark: 'sync 标签页 B 层判据' });
    const st = await manager.startProfile(profiles.getProfile(p.profile_id));
    started.push(p.profile_id);
    console.log(`环境 ${name} = ${p.profile_id} · 内核 ${st.real_version}`);
  }
  insts = started.map((id) => manager.getInstance(id));
  const mkA = markerNames(fingerprintView(profiles.getProfile(started[0])).seed);
  const mkB = markerNames(fingerprintView(profiles.getProfile(started[1])).seed);

  // 三个窗口各一张页
  for (const inst of insts) await inst.openPage(U('/base'));
  await sleep(2200);

  const st0 = await sync.startSync({ masterId: started[0], slaveIds: [started[1], started[2]], settings: {}, rngSeed: 777 });
  check('会话起来了（1 主 + 2 受控）', st0.running === true && st0.windows.length === 3,
    JSON.stringify(st0.windows.map((w) => w.role)));

  /* ------------------------------ ⑥ 目标空白：新标签首帧注入 ------------------------------ */
  console.log('\n— ⑥ 目标空白：新开标签的首个文档必须已注入 —');
  {
    const opened = await sync.openTabInAll(U('/opened'));
    const bySlave = (opened.opened || []).filter((o) => o.role === 'slave');
    check('打开网址：三个窗口都开了新标签', (opened.opened || []).length === 3 && bySlave.length === 2,
      JSON.stringify((opened.opened || []).map((o) => o.role)));
    check('target_blank 开：都是「新开标签」模式（不是原地跳）',
      (opened.opened || []).every((o) => o.mode === 'new_tab'), JSON.stringify((opened.opened || []).map((o) => o.mode)));

    // 对受控窗口那张新标签：读首帧的注入标记 + navigation.type + 文档条数
    const o = bySlave[0];
    const att = await insts[1].client.send('Target.attachToTarget', { targetId: o.target_id, flatten: true });
    let seen = { applied: '', nav: '', entries: 0 };
    for (let i = 0; i < 60; i++) {
      const v = await evalIn(insts[1], att.sessionId,
        `typeof window[${JSON.stringify(mkB.applied)}] + "|" + ((performance.getEntriesByType("navigation")[0]||{}).type || "") + "|" + performance.getEntriesByType("navigation").length`);
      const [applied, nav, entries] = String(v).split('|');
      seen = { applied, nav, entries: Number(entries) };
      if (applied === 'object' && nav) break;
      await sleep(100);
    }
    check('新标签首个文档注入已生效（applied 标记是 object）', seen.applied === 'object', JSON.stringify(seen));
    check('新标签 navigation.type === navigate（不是 reload）', seen.nav === 'navigate', seen.nav);
    check('新标签当前文档只有一条导航记录（弱证据，真正的证据在下面那条）', seen.entries === 1, String(seen.entries));
    // 决定性判据：这张标签到底**加载了几个文档**，只有服务器计数说了算（理由见上面 hits 的注释）
    check('新标签只向服务器请求了一次（首帧不是靠二次加载补回来的）',
      hits.get('/opened') === 3, `/opened 被请求 ${hits.get('/opened')} 次（三个窗口各一次才正常）`);
    await insts[1].client.send('Target.detachFromTarget', { sessionId: att.sessionId }).catch(() => {});
    await sync.closeTabs('blank').catch(() => {});
    // 关掉刚才多开的：把三个窗口都退回只有一张页
    for (let i = 0; i < 3; i++) {
      const tabs = await tabsOf(started[i]);
      if (tabs.length > 1) await tabsMod.closeTabAt(manager.getInstance(started[i]).client, tabs[tabs.length - 1].targetId);
    }
    await sleep(400);
  }

  /* ------------------------------ 统一标签页 ------------------------------ */
  console.log('\n— ⑤ 统一标签页 —');
  {
    // 主窗口再开两张（三个不同地址），受控窗口只有一张
    await openIn(started[0], U('/m1'));
    await sleep(400);
    await openIn(started[0], U('/m2'));
    await sleep(600);
    const masterTabs = await tabsOf(started[0]);
    check('主窗口现在有 3 个标签', masterTabs.length === 3, JSON.stringify(masterTabs.map((t) => t.url)));

    const unify = await sync.unifyTabs();
    await sleep(900);
    const s1 = await tabsOf(started[1]);
    const s2 = await tabsOf(started[2]);
    check('统一后受控窗口 1 的标签数 = 主窗口', s1.length === masterTabs.length, `${s1.length} vs ${masterTabs.length}`);
    check('统一后受控窗口 2 的标签数 = 主窗口', s2.length === masterTabs.length, `${s2.length} vs ${masterTabs.length}`);
    check('统一后受控窗口 1 的 URL 列表与主窗口一致', JSON.stringify(s1.map((t) => t.url)) === JSON.stringify(masterTabs.map((t) => t.url)),
      JSON.stringify(s1.map((t) => t.url)));
    check('unify 回报里有 opened 记录（证明是真的开了，不是只报了数）',
      (unify.windows || []).some((w) => (w.opened || []).length > 0), JSON.stringify((unify.windows || []).map((w) => w.opened?.length)));
  }

  /* ------------------------------ ① 关标签（按序号） ------------------------------ */
  console.log('\n— ① 关标签：主窗口关第 2 个 → 受控窗口关第 2 个 —');
  {
    // 让主窗口第 2 个标签成为当前可见的（关「当前标签」就是关它）
    const mt = await tabsOf(started[0]);
    const target = mt[1];
    const wantUrl = target.url;
    await activate(insts[0], target.targetId);
    const before = { s1: await tabsOf(started[1]), s2: await tabsOf(started[2]) };
    const r = await sync.closeTabs('current');
    await sleep(700);
    const after = {
      master: await tabsOf(started[0]),
      s1: await tabsOf(started[1]),
      s2: await tabsOf(started[2]),
    };
    check('主窗口的当前标签被关掉', !after.master.some((t) => t.targetId === target.targetId), wantUrl);
    check('受控窗口 1 的第 2 个标签也被关掉（序号映射生效）',
      !after.s1.some((t) => t.url === wantUrl) && after.s1.length === before.s1.length - 1,
      `${before.s1.length} → ${after.s1.length}`);
    check('受控窗口 2 同理', !after.s2.some((t) => t.url === wantUrl) && after.s2.length === before.s2.length - 1,
      `${before.s2.length} → ${after.s2.length}`);
    check('closeTabs 回报逐窗口记了关掉的是哪一个',
      (r.closed || []).length === 3 && (r.closed || []).every((c) => c.ok === true),
      JSON.stringify((r.closed || []).map((c) => ({ role: c.role, index: c.index, ok: c.ok }))));
    check('关掉的正是同一个 URL（不是靠序号瞎关）',
      (r.closed || []).every((c) => c.url === wantUrl), JSON.stringify((r.closed || []).map((c) => c.url)));
  }

  /* ------------------------------ ② 关其它标签 ------------------------------ */
  console.log('\n— ② 关其它标签（留当前，其余全关）—');
  {
    // 先让三个窗口都回到 2 个标签，方便判「关完只剩 1 个」
    for (const id of started) {
      const tabs = await tabsOf(id);
      if (tabs.length < 2) await openIn(id, U(`/again-${id.slice(0, 4)}`));
    }
    await sleep(800);
    const before = await Promise.all(started.map((id) => tabsOf(id)));
    console.log(`关前标签数：${before.map((x) => x.length).join(' / ')}`);

    const mt = await tabsOf(started[0]);
    await activate(insts[0], mt[0].targetId);
    const keepUrl = mt[0].url;
    const r = await sync.closeTabs('others');
    await sleep(800);
    const after = await Promise.all(started.map((id) => tabsOf(id)));
    check('三个窗口都只剩 1 个标签', after.every((x) => x.length === 1), after.map((x) => x.length).join(' / '));
    check('留下的正是「当前」那个（同一个 URL）', after.every((x) => x[0].url === keepUrl),
      `留 ${keepUrl} / 实际 ${after.map((x) => x[0].url).join(' , ')}`);
    check('关其它：回报里一条都没失败', (r.closed || []).every((c) => c.ok === true),
      JSON.stringify((r.closed || []).filter((c) => !c.ok)));
  }

  /* ------------------------------ ④ 关空白标签页 ------------------------------ */
  console.log('\n— ④ 关空白标签页 —');
  {
    // 没有空白时：一个都不许关
    const clean = await sync.closeTabs('blank');
    await sleep(500);
    check('没有空白标签时「关空白」一个都不关', (clean.closed || []).length === 0,
      JSON.stringify((clean.closed || []).map((c) => c.url)));
    const stillThere = await Promise.all(started.map((id) => tabsOf(id)));
    check('真网页没有被误关（每个窗口仍有 1 个）', stillThere.every((x) => x.length === 1), stillThere.map((x) => x.length).join(' / '));

    // 三个窗口各开一张 about:blank（绕开产品路径，直接造空白页）
    for (const inst of insts) {
      await inst.client.send('Target.createTarget', { url: 'about:blank' }).catch(() => {});
    }
    await sleep(700);
    const withBlank = await Promise.all(started.map((id) => tabsOf(id)));
    console.log(`造空白后：${withBlank.map((x) => x.map((t) => t.url).join('|')).join(' // ')}`);
    check('三个窗口都有空白标签（前置条件，证明下面关的是真空白）',
      withBlank.every((x) => x.some((t) => t.url === 'about:blank')),
      JSON.stringify(withBlank.map((x) => x.length)));

    const r = await sync.closeTabs('blank');
    await sleep(700);
    const after = await Promise.all(started.map((id) => tabsOf(id)));
    check('关空白后三个窗口都不再有 about:blank', after.every((x) => !x.some((t) => t.url === 'about:blank')),
      JSON.stringify(after.map((x) => x.map((t) => t.url))));
    check('只关了空白（每个窗口仍留 1 个真网页）', after.every((x) => x.length === 1), after.map((x) => x.length).join(' / '));
    check('回报里每一条都是空白页', (r.closed || []).every((c) => tabsMod.isBlankUrl(c.url)),
      JSON.stringify((r.closed || []).map((c) => c.url)));
  }

  /* ------------------------------ ③ 复制标签到其它窗口 ------------------------------ */
  console.log('\n— ③ 复制标签到其它窗口（只往受控去，不动主窗口）—');
  {
    const mt = await tabsOf(started[0]);
    const src = mt[0];
    const before = { master: mt.length, s1: (await tabsOf(started[1])).length, s2: (await tabsOf(started[2])).length };
    const r = await sync.copyTabToSlaves({ index: 0 });
    await sleep(900);
    const after = {
      master: (await tabsOf(started[0])).length,
      s1: await tabsOf(started[1]),
      s2: await tabsOf(started[2]),
    };
    check('主窗口标签数不变（复制不反向动主窗口）', after.master === before.master, `${before.master} → ${after.master}`);
    check('受控窗口 1 多了 1 个标签', after.s1.length === before.s1 + 1, `${before.s1} → ${after.s1.length}`);
    check('受控窗口 2 多了 1 个标签', after.s2.length === before.s2 + 1, `${before.s2} → ${after.s2.length}`);
    check('新标签的 URL 就是主窗口那个', r.url === src.url && after.s1.some((t) => t.url === src.url) && after.s2.some((t) => t.url === src.url),
      `${r.url} / s1=${JSON.stringify(after.s1.map((t) => t.url))}`);

    // 复制出来的标签也要首帧注入（同一条姿势，判一次）
    const copyTarget = (r.copied || []).find((c) => c.profile_id === started[1] && c.target_id);
    if (copyTarget) {
      const att = await insts[1].client.send('Target.attachToTarget', { targetId: copyTarget.target_id, flatten: true });
      const applied = await evalIn(insts[1], att.sessionId, `typeof window[${JSON.stringify(mkB.applied)}]`);
      const nav = await evalIn(insts[1], att.sessionId, '((performance.getEntriesByType("navigation")[0]||{}).type || "")');
      check('复制出来的标签也注入生效（applied 是 object）', applied === 'object', String(applied));
      check('复制出来的标签 navigation.type === navigate', nav === 'navigate', String(nav));
      await insts[1].client.detachFromTarget?.({ sessionId: att.sessionId }).catch?.(() => {});
      await insts[1].client.send('Target.detachFromTarget', { sessionId: att.sessionId }).catch(() => {});
    } else {
      check('复制出来的标签也注入生效（applied 是 object）', false, '没有拿到 target_id');
      check('复制出来的标签 navigation.type === navigate', false, '没有拿到 target_id');
    }
  }

  /* ------------------------------ 相同标签页关掉的区别 ------------------------------ */
  console.log('\n— same_tab 关掉：不按序号对齐 —');
  {
    sync.updateSettings({ same_tab: false, target_blank: false });
    const before = await Promise.all(started.map((id) => tabsOf(id)));
    const opened = await sync.openTabInAll(U('/same-tab-mode'));
    await sleep(700);
    const after = await Promise.all(started.map((id) => tabsOf(id)));
    check('target_blank 关：不再新开标签（标签数不变）',
      after.every((x, i) => x.length === before[i].length),
      `${before.map((x) => x.length).join('/')} → ${after.map((x) => x.length).join('/')}`);
    check('target_blank 关：模式记为 same_tab（原地跳）',
      (opened.opened || []).every((o) => o.mode === 'same_tab'), JSON.stringify((opened.opened || []).map((o) => o.mode)));
    check('same_tab 关：受控窗口动的是自己当前那个标签（URL 变成新地址）',
      after.slice(1).every((x) => x.some((t) => t.url === U('/same-tab-mode'))),
      JSON.stringify(after.slice(1).map((x) => x.map((t) => t.url))));
    sync.updateSettings({ same_tab: true, target_blank: true });
  }
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