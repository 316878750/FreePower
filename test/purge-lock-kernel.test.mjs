/**
 * 回收站「彻底删除」的数据安全判据 —— B 层：**真内核**。
 *
 * 起因：2026-11-14 CEO 复验抓到一个真缺陷 —— 老的实现直接
 * `fs.rmSync(dir,{recursive:true,force:true})`，它**先删内容、再删目录**；
 * 目录被占住时内容已删光，最后一步抛 EPERM，接口于是报「没删掉、还能恢复」，
 * 用户点恢复拿回来一个空壳环境。**报的和做的正好相反**，比静默成功更糟。
 *
 * 修法：先 rename 成墓碑（原子），rename 失败 = 一个字节没动；rename 成功再删墓碑。
 *
 * A 层的 `test/profiles-tabs.test.mjs` 用真占用的 `EBUSY/EPERM` 验了「3 个文件一个不少 + 能恢复」。
 * 这里再补一件 A 层验不了的事：**恢复之后环境真的能启动**（真内核）。
 * 空壳环境是「能恢复、起不来」或「起来了但没有登录态」，所以必须真起一次。
 *
 * 跑法：node --no-warnings test/purge-lock-kernel.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dataDir = path.join(os.tmpdir(), `freepower-purge-k-${Date.now()}`);
process.env.FREEPOWER_DATA = dataDir;
// 这一段只关心 user-data 是否完好，不需要自检与出口探测（少等十几秒）
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

let profileId = null;

/** user-data 里除了 Chrome 自己造的东西，还要数我们放的这几个「登录态」 */
const MARKERS = ['Cookies', 'Login Data', 'Preferences'];

function snapshot(udd) {
  if (!fs.existsSync(udd)) return null;
  const out = {};
  for (const name of MARKERS) {
    const p = path.join(udd, name);
    out[name] = fs.existsSync(p) ? fs.statSync(p).size : null;
  }
  return out;
}

try {
  const p = profiles.createProfile({ name: `purge-lock-${Date.now()}`, group_id: '0' });
  profileId = p.profile_id;
  const udd = manager.userDataDirFor(profiles.getProfile(profileId));

  /* ---------- A. 先真启动一次，让 Chrome 自己把 user-data 铺满（cookie / 登录库 / 配置） ---------- */
  console.log('\n— A. 真启动一次，让 user-data 有真实内容 —');
  const first = await manager.startProfile(profiles.getProfile(profileId));
  check('环境启动成功（正例：先证明这个环境本来就能起）',
    !!first.real_version && Number(first.pid) > 0, `pid=${first.pid} 内核 ${first.real_version}`);
  await manager.stopProfile(profileId);
  await sleep(800);

  // 再补三个「登录态」文件：真 Chrome 的 Cookies 是 SQLite+DPAPI，这里只要证明**文件与内容不被删**，
  // 用可比的字节内容更直接（大小与内容都能逐字节核对）
  fs.mkdirSync(udd, { recursive: true });
  const REAL = { Cookies: 'fp-cookie-bytes-0123456789', 'Login Data': 'fp-logins-bytes-9876543210', Preferences: '{"fp":true}' };
  for (const [name, content] of Object.entries(REAL)) fs.writeFileSync(path.join(udd, name), content);
  const before = snapshot(udd);
  check('启动后 user-data 里三样登录态文件都在（后面就靠它们判断有没有被提前删掉）',
    MARKERS.every((n) => before[n] !== null), JSON.stringify(before));

  /* ---------- B. 锁住目录 → purge 必须失败且一个字节不动 ---------- */
  console.log('\n— B. 目录被进程占住 → purge 失败，数据一个字节不动 —');
  profiles.deleteProfiles([profileId]);  const dir = path.dirname(udd);

  const locker = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 120000)'], {
    cwd: dir, stdio: 'ignore', windowsHide: true,
  });
  await sleep(700);

  const { purgeProfileData } = await import('../src/runtime/purge-data.js');
  const locked = purgeProfileData(profiles.getRecycledProfile({ profile_id: profileId }));
  check('目录被占住：purge 返回 ok:false + intact（说得出「什么都没动」）',
    locked.ok === false && locked.intact === true, JSON.stringify(locked));
  check('目录被占住：reason=userdata_remove_failed，带错误码（EBUSY/EPERM）',
    locked.reason === 'userdata_remove_failed' && ['EBUSY', 'EPERM'].includes(locked.error_code),
    `${locked.reason} / ${locked.error_code}`);

  const afterLocked = snapshot(udd);
  check('目录被占住：三个文件**大小逐个没变**（不是「还在但被清空」）',
    MARKERS.every((n) => afterLocked?.[n] === before[n]), JSON.stringify({ before, afterLocked }));
  check('目录被占住：Cookies 内容逐字节没变',
    fs.existsSync(path.join(udd, 'Cookies'))
    && fs.readFileSync(path.join(udd, 'Cookies'), 'utf8') === REAL.Cookies);
  check('目录被占住：没有墓碑目录残留（.purge-* 一个都没有）',
    fs.readdirSync(path.dirname(dir)).filter((n) => n.includes('.purge-')).length === 0,
    JSON.stringify(fs.readdirSync(path.dirname(dir))));

  /* ---------- C. 放开 → 恢复 → **真启动** ---------- */
  console.log('\n— C. 放开占用 → 从回收站恢复 → 环境真能启动（不是空壳） —');
  try { locker.kill(); } catch { /* 可能已经退了 */ }
  await sleep(900);

  const restored = profiles.restoreProfiles([profileId], '0')[0];
  check('从回收站恢复成功（id/no 不变）',
    restored?.restored === true && !!profiles.getProfile(profileId), JSON.stringify(restored));
  const afterRestore = snapshot(udd);
  check('恢复后三个文件大小仍与删除前一致（不是空壳）',
    MARKERS.every((n) => afterRestore?.[n] === before[n]), JSON.stringify({ before, afterRestore }));

  const second = await manager.startProfile(profiles.getProfile(profileId));
  check('恢复后**真启动成功**（pid 有、内核版本有）',
    !!second.real_version && Number(second.pid) > 0, `pid=${second.pid} 内核 ${second.real_version}`);
  check('恢复后启动的还是同一个 user-data 目录（没被当成新环境重开）',
    manager.getInstance(profileId)?.user_data_dir === udd, String(manager.getInstance(profileId)?.user_data_dir || ''));
  await manager.stopProfile(profileId);
  await sleep(800);

  /* ---------- D. 放开 → 再删 → purge 这次必须真删掉 ---------- */
  console.log('\n— D. 放开后再 purge：这次必须真删掉（第一次失败不许卡住第二次） —');
  profiles.deleteProfiles([profileId]);
  const ok = purgeProfileData(profiles.getRecycledProfile({ profile_id: profileId }));
  check('第二次 purge：ok:true、removed:true', ok.ok === true && ok.removed === true, JSON.stringify(ok));
  check('目录没了、也没有墓碑残留',
    !fs.existsSync(dir) && fs.readdirSync(path.dirname(dir)).filter((n) => n.includes('.purge-')).length === 0,
    JSON.stringify(fs.readdirSync(path.dirname(dir))));
  // 删盘与删库是两步（路由里连着做）：这一步单独验「盘删干净了，记录才允许删」
  const dropped = profiles.purgeProfiles([profileId]);
  check('盘删干净之后删记录：purged=1、回收站里不再挂着可恢复',
    dropped.purged.includes(profileId) && !profiles.getRecycledProfile({ profile_id: profileId }),
    JSON.stringify(dropped));
  profileId = null;
} catch (e) {
  check('B 层跑完没有抛异常', false, `${e && e.message}`);
  console.error(e);
} finally {
  if (profileId) await manager.stopProfile(profileId).catch(() => {});
  dbmod.closeDb();
  await sleep(300);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄还在，留给系统 */ }
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
