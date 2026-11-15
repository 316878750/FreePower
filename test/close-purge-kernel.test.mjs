/**
 * `clear_cache_after_closing` 真删目录 —— B 层：**真内核**（0.4.6）。
 *
 * 为什么要这条：这是 0.4.6 里唯一一个**会真的删用户数据**的接线。它删的不是「浏览器 cache 子目录」，
 * 而是**整个环境数据目录**（cache / cookie / localStorage / 书签）。这种改动只靠读代码点头是不够的：
 *   - 删不掉时静默（照抄对手语义）→ 代码里看起来「成功」，实际一个字节没动；
 *   - 反过来的风险更糟：**别的路径顺手删了**，字段没生效也照样「目录没了」。
 * 所以判据必须是**一对**：开着 → 真没了；关着 → 真还在。只有「删了」不能证明是这个字段干的。
 *
 * 另外钉两条语义细节（逆向 `30-假字段消费机制.md` §1 的机制）：
 *   - **2 秒延迟**：停止后 1 秒时目录必须**还在**（不是立刻删；立刻删在 Windows 上必撞占用）；
 *   - 删的是 `userdata` 这一层（`userDataDirFor` 算出来的那个），**不是**它的父目录
 *     （父目录里还可能有别的东西，删过头就是另一个事故）。
 *
 * 跑法：node --no-warnings test/close-purge-kernel.test.mjs   （约 40–60 秒，需本机 Chrome）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 自己的数据根：**绝不用仓库里的 data/**，这条判据会真删目录
const dataDir = path.join(os.tmpdir(), `freepower-close-purge-${Date.now()}`);
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

const LOG_DIR = path.join(dataDir, 'logs');
const logText = (id) => {
  const p = path.join(LOG_DIR, `${id}.log`);
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
};

/** 等到 dir 消失（真删是异步的，rm 本身要时间）；返回用掉的毫秒数，超时返回 -1 */
async function waitGone(dir, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!fs.existsSync(dir)) return Date.now() - t0;
    await sleep(100);
  }
  return -1;
}

const ids = [];
try {
  /* ---------------- A. 对照组：clear_cache_after_closing='0' → 目录必须还在 ---------------- */
  console.log('\n— A. 对照组：clear_cache_after_closing=0 —');
  const off = profiles.createProfile({ name: `purge-off-${Date.now()}`, group_id: '0', clear_cache_after_closing: '0' });
  ids.push(off.profile_id);
  const offDir = manager.userDataDirFor(profiles.getProfile(off.profile_id));
  const offStart = await manager.startProfile(profiles.getProfile(off.profile_id));
  check('对照：环境启动成功（先证明这个环境本来就能起）',
    !!offStart.real_version && Number(offStart.pid) > 0, `pid=${offStart.pid} 内核 ${offStart.real_version}`);
  check('对照：启动后数据目录真的建出来了（后面「还在」才有意义）', fs.existsSync(offDir), offDir);

  await manager.stopProfile(off.profile_id);
  await sleep(1000);
  check('对照：停止后 1 秒目录还在（关着的时候不许删）', fs.existsSync(offDir), offDir);
  await sleep(5000);
  check('对照：停止后 6 秒目录仍然在（不是延迟删、也不是没删干净）', fs.existsSync(offDir), offDir);
  check('对照：日志里没有任何「删数据目录」的痕迹',
    !/clear_cache_after_closing/.test(logText(off.profile_id)), logText(off.profile_id).split('\n').slice(-2).join(' | '));

  /* ---------------- B. 正例：='1' → 停止后真的没了 ---------------- */
  console.log('\n— B. 正例：clear_cache_after_closing=1 —');
  const on = profiles.createProfile({ name: `purge-on-${Date.now()}`, group_id: '0', clear_cache_after_closing: '1' });
  ids.push(on.profile_id);
  const onDir = manager.userDataDirFor(profiles.getProfile(on.profile_id));
  check('正例：两个环境的数据目录不是同一个（否则下面「删一个不伤另一个」无从判断）',
    onDir !== offDir, `${onDir} vs ${offDir}`);
  const onStart = await manager.startProfile(profiles.getProfile(on.profile_id));
  check('正例：环境启动成功',
    !!onStart.real_version && Number(onStart.pid) > 0, `pid=${onStart.pid} 内核 ${onStart.real_version}`);
  check('正例：启动后数据目录存在（删之前确实有东西可删）', fs.existsSync(onDir), onDir);
  check('正例：这个目录里有内核真的落盘的东西（不是空壳目录）',
    fs.existsSync(path.join(onDir, 'Default')) || fs.readdirSync(onDir).length > 0,
    JSON.stringify(fs.readdirSync(onDir).slice(0, 6)));

  await manager.stopProfile(on.profile_id);
  await sleep(1000);
  check('正例：停止后 1 秒目录还在（照抄对手的 2 秒延迟，不是同步删）', fs.existsSync(onDir), onDir);

  const took = await waitGone(onDir, 6000);
  check('正例：停止后（约 2 秒起）数据目录**真的没了**', took >= 0, took >= 0 ? `停止后 ${1000 + took}ms 消失` : '6 秒后仍存在');
  check('正例：日志里有一行「已删除内核数据目录」（删了要留证据，不是静默走运）',
    /clear_cache_after_closing/.test(logText(on.profile_id)), logText(on.profile_id).split('\n').slice(-2).join(' | '));

  // 删的是 userdata 这一层：父目录（<no>_<id8>）不该跟着一起被抹掉 —— 那是「删过头」
  const parent = path.dirname(onDir);
  check('正例：只删了 userdata 这一层，父目录还在（没删过头）', fs.existsSync(parent), parent);

  /* ---------------- C. 没伤到别人 ---------------- */
  console.log('\n— C. 删自己那份的时候，别人那份一个字节没动 —');
  check('对照环境的数据目录仍在（这条判据自己没删错对象）', fs.existsSync(offDir), offDir);

  /* ---------------- D. 停止之后重启：目录会重新建出来 ---------------- */
  console.log('\n— D. 清完之后再启动：目录重建、环境照常能起 —');
  const again = await manager.startProfile(profiles.getProfile(on.profile_id));
  check('清完之后再启动成功（不是「删了一次就再也起不来」）',
    !!again.real_version && Number(again.pid) > 0, `pid=${again.pid}`);
  check('清完之后再启动：数据目录重新建出来了', fs.existsSync(onDir), onDir);
  await manager.stopProfile(on.profile_id);
  // 这一轮同样会再清一次（字段还是 '1'）：等它删完，别把删到一半的目录留给下一次
  await waitGone(onDir, 6000);
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
