#!/usr/bin/env node
/**
 * 会话恢复（差距清单第 5 条）· B 层真机判据 —— **真内核、真重启**。
 *
 * 对手往内核配置 `StaticConfig.RestoreLastSession = true` 塞（逆向 `03b` L236）；我们没有内核改造能力，
 * 走 Chrome 自己的 `session.restore_on_startup = 1`（「继续浏览上次打开的网页」）。这是**我们的实现、
 * 不是复刻**：语义一样（强制开启），落点不一样。
 *
 * 这条为什么必须真机跑：`Preferences` 里写着 `1` **不等于**恢复成功 —— 它只是「告诉了 Chrome 要恢复」。
 * 只有「起环境 → 开两个页 → 正常 stop → 再 start → 真的看到那两个页」才算证明。所以：
 *   ① 第一次启动后开两个不同 URL 的页面；
 *   ② `stopProfile`（优雅 `Browser.close`，让 Chrome 把 session 落盘）；
 *   ③ 再 `startProfile`；
 *   ④ 用 CDP `Target.getTargets` 数 page，断言**两个 URL 都回来了**（不是只看「标签数 ≥ 2」——
 *      新标签页本身就能凑够 2，那样是假绿）。
 *
 * 进 `npm run smoke`（真机那套），不进 `npm test`（不联网、不起内核那套）。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'freepower-session-'));
process.env.FREEPOWER_DATA = DATA;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
process.env.FREEPOWER_EGRESS_TIMEOUT = '1500';
process.env.FREEPOWER_UA_AUTOALIGN = '1';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { startProfile, stopProfile, getInstance } = await import('../src/runtime/manager.js');
const { createProfile, getProfile, deleteProfiles } = await import('../src/store/profiles.js');
const { findChrome, killProcessTree } = await import('../src/kernel/chrome.js');
const { prefsPathOf } = await import('../src/runtime/prefs.js');
const { closeDb } = await import('../src/store/db.js');

const chrome = findChrome();
if (!chrome) {
  console.error('没有可用内核，设置 FREEPOWER_CHROME 后重试');
  process.exit(2);
}
console.log(`内核：${chrome.version} (${chrome.source})`);
console.log(`临时数据目录：${DATA}\n`);

/** 两个能被区分开的页面（恢复之后要按 URL 认出来） */
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/a' || p === '/b') {
    const body = `<!doctype html><title>page ${p.slice(1)}</title><h1>${p}</h1>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  res.writeHead(404);
  res.end('nope');
});

let id = null;
let origin = '';

/** 当前所有 page 目标的 URL（真机读法：CDP `Target.getTargets`） */
async function pageUrls(inst) {
  const r = await inst.client.send('Target.getTargets');
  return (r.targetInfos || []).filter((t) => t.type === 'page').map((t) => t.url);
}

try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;

  const created = createProfile({ name: `p-session-${Date.now()}`, group_id: '0', remark: '会话恢复真机判据' });
  id = created.profile_id;

  /* ---------- 第一次启动：开两个页 ---------- */
  const first = await startProfile(getProfile(id));
  let inst = getInstance(id);
  const udd = inst.user_data_dir;
  const prefsFile = prefsPathOf(udd);
  console.log(`第一次启动 pid=${first.pid} port=${first.debug_port}`);

  const prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
  check('启动前写入了 session.restore_on_startup = 1（Preferences 真实落盘）',
    prefs?.session?.restore_on_startup === 1,
    `${prefsFile} → ${JSON.stringify(prefs?.session || null)}`);

  await inst.openPage(`${origin}/a`);
  await inst.openPage(`${origin}/b`);
  await sleep(600); // 让两个页面把标题/URL 都落进 session
  const beforeUrls = await pageUrls(inst);
  check('第一次启动后两个页都在', beforeUrls.some((u) => u.endsWith('/a')) && beforeUrls.some((u) => u.endsWith('/b')),
    beforeUrls.join(' | '));

  /* ---------- 正常 stop：让 Chrome 自己把 session 落盘 ---------- */
  await stopProfile(id);
  await sleep(1200); // Browser.close 之后 Chrome 还要写 Session Storage

  /* ---------- 再启动：必须把两个页恢复出来 ---------- */
  const second = await startProfile(getProfile(id));
  inst = getInstance(id);
  console.log(`第二次启动 pid=${second.pid} port=${second.debug_port}`);

  let afterUrls = [];
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    afterUrls = await pageUrls(inst).catch(() => []);
    if (afterUrls.some((u) => u.endsWith('/a')) && afterUrls.some((u) => u.endsWith('/b'))) break;
    await sleep(400);
  }
  check('重启后两个页**真的恢复**了（按 URL 认，不只看标签数）',
    afterUrls.some((u) => u.endsWith('/a')) && afterUrls.some((u) => u.endsWith('/b')),
    afterUrls.join(' | '));

  // 第三条：用户手动把值改回 5（打开新标签页），下次启动必须被**顶回 1** —— 这就是「强制开启」语义
  // （对手强制内核配置，我们强制 Preferences；用户改回去不生效，README 已写明）
  await stopProfile(id);
  await sleep(800);
  const prefs2 = JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
  prefs2.session = { ...(prefs2.session || {}), restore_on_startup: 5 };
  fs.writeFileSync(prefsFile, JSON.stringify(prefs2), 'utf8');
  await startProfile(getProfile(id));
  inst = getInstance(id);
  const prefs3 = JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
  check('每次启动都会把 restore_on_startup 顶回 1（用户手动改回 5 也会被改回来 —— 强制开启语义）',
    prefs3?.session?.restore_on_startup === 1,
    `改前 5 → 启动后 ${JSON.stringify(prefs3?.session?.restore_on_startup)}`);

  await stopProfile(id);

  /* ---------- 启动标签不累积（0.4.1 修的是 0.4.0 的回归） ---------- */
  /*
   * 一句话判据：`open_urls` 里那个地址，**连起三次都只能有 1 张**。
   * 改动前（334ac5d 带进来的）：会话恢复把上次的标签带回来，启动流程又无条件按 open_urls
   * 新建一张，于是第 2 次启动 2 张、第 3 次 3 张，越积越多。
   *
   * 三条边界都在这条判据里：
   *   - 第 1 轮 = **首次启动（没有 session）** → 会话恢复不出东西 → open_urls 必须照常生效（对照）；
   *   - 第 2/3 轮 = 恢复成功的路径 → 不能再按 open_urls 新建；
   *   - 「恢复失败退回老行为」不单独造场景（造不出来也验不准），由第 1 轮同一个代码分支覆盖。
   */
  const staged = createProfile({
    name: `p-tabs-${Date.now()}`, group_id: '0', open_urls: [`${origin}/a`], remark: '启动标签不累积',
  });
  const stagedId = staged.profile_id;
  const counts = [];
  try {
    for (let round = 1; round <= 3; round++) {
      await startProfile(getProfile(stagedId));
      const sInst = getInstance(stagedId);
      const countA = async () => (await pageUrls(sInst).catch(() => [])).filter((u) => u.endsWith('/a')).length;
      const dl = Date.now() + 12000;
      while (Date.now() < dl) {
        if ((await countA()) >= 1) break;
        await sleep(300);
      }
      // 多出来的那几张是「恢复 + 新建」里新建的，给它们一点时间出现，别抢跑
      await sleep(900);
      const n = await countA();
      counts.push(n);
      check(`启动标签不累积：第 ${round} 次启动后 /a 正好 1 张`, n === 1, `实际 ${n} 张`);
      if (round === 1) {
        check('对照：首次启动（没有 session）open_urls 照常生效 —— /a 在', n >= 1, `实际 ${n} 张`);
      }
      await stopProfile(stagedId);
      await sleep(1000);
    }
    check('连起三次都是 1 张（恢复之后不再按 open_urls 新建）',
      counts.join(',') === '1,1,1', counts.join(','));
  } finally {
    try { await stopProfile(stagedId); } catch { /* ignore */ }
    try { killProcessTree(getInstance(stagedId)?.pid || 0); } catch { /* ignore */ }
    try { deleteProfiles([stagedId]); } catch { /* ignore */ }
  }
} catch (e) {
  check('会话恢复测试异常', false, e.stack || e.message);
} finally {
  try { if (id) await stopProfile(id); } catch { /* ignore */ }
  try { if (id) killProcessTree(getInstance(id)?.pid || 0); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
  try { closeDb(); } catch { /* ignore */ }
  await sleep(600);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 句柄没放开就算了 */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(` - ${f.name}  ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
