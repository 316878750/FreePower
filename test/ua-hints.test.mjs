/**
 * UA ↔ UA-CH 版本自洽（0.4.7.1 修 P0）判据 —— A 层：不起内核，几秒跑完。
 *
 * 这一项是 0.4.7 发布后「所有环境都打不开」的修复判据。那个 P0 的形态是这样的：
 *
 *   老记录（0.4.4/0.4.6 建的）：`ua` = 导入时带的 `Chrome/133.0.6943.127`，
 *   `client_hints.ua_full_version` = 建环境那一刻按本机内核填的 `157.0.8103.78`。
 *   0.4.6 把「UA 大版本 ≠ ua_full_version 大版本」定成**硬冲突** → 读出来就自相矛盾 →
 *   `checkProfile.ok === false` → 启动前直接拦。用户 50 个环境 50/50 全中。
 *
 * 所以这里钉的六件事，一件都不能少：
 *
 *   1. **读路径的默认值不许造矛盾**：hints 缺失时按 UA 的 `Chrome/<major>` 派生，
 *      **不许拿本机内核版本**（那正是矛盾的来源）。
 *   2. **读路径零写入**：连读多次之后，库里那一行必须**逐字节没变**。读的时候顺手「修好」
 *      用户的数据，等于把一次只读操作变成迁移 —— 出了问题没人能回退。
 *   3. **显式给的 hints 不许被本机内核覆盖**：UA 133 + 显式 `ua_full_version=133.x` 要原样留着。
 *   4. **UA 缺失才回落到本机内核**（这条不许被第 1 条改坏）。
 *   5. **保存侧也不许写进矛盾对**：新建/更新落库前就要对齐，不许「存进去了、打开才报错」。
 *   6. **启动前预对齐只治「只剩版本号」这一种病**：`webgl` 空开关、UA 平台 ↔ `navigator.platform`
 *      矛盾这类硬冲突必须继续阻断（`preAlignForLaunch` 自己判，不满足就一个字节都不动）。
 *
 * 真内核那部分（UA 133 的老环境真能启动、启动后 UA 与 UA-CH 都是本机内核）在 B 层
 * `test/ua-hints-kernel.test.mjs`。
 *
 * 数据根一律 `os.tmpdir()` 下的一次性目录，绝不碰仓库 `data/`。
 *
 * 跑法：node --no-warnings test/ua-hints.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dataDir = path.join(os.tmpdir(), `freepower-uahints-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_SELFCHECK = '0';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const skip = (name, detail) => console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`);

const UA133 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.6943.127 Safari/537.36';
const uaOf = (major) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;

try {
  const prof = await import('../src/store/profiles.js');
  const hints = await import('../src/fingerprint/hints.js');
  const transfer = await import('../src/store/transfer.js');
  const { getDb, closeDb } = await import('../src/store/db.js');

  const kernelVersion = prof.kernelVersionForNewProfile();
  const kernelMajor = String(kernelVersion).split('.')[0];

  /** 库里那一行的原样（读路径「有没有写」就比它） */
  const rawRow = (id) => getDb().prepare('SELECT * FROM profiles WHERE id = ?').get(id);
  const rawFp = (id) => JSON.parse(rawRow(id).fingerprint_config || '{}');
  const setFp = (id, fp) => getDb()
    .prepare('UPDATE profiles SET fingerprint_config = ? WHERE id = ?')
    .run(JSON.stringify(fp), id);
  /** 把 hints 从库里摘掉 = 0.4.4 那种「client_hints 列是 NULL」的老形态 */
  const stripHints = (id) => {
    const fp = rawFp(id);
    delete fp.client_hints;
    setFp(id, fp);
  };
  const hintsOf = (id) => rawFp(id).client_hints || null;
  const uniq = (n) => `${n}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;

  /* ==================== 1. 老记录没有 client_hints：hints 必须按 UA 派生 ==================== */
  console.log('\n— 1. 老记录（没有 client_hints，UA 是 133）：默认值不许造矛盾 —');
  {
    const p = prof.createProfile({ name: uniq('ua-old'), group_id: '0', ua: UA133 });
    stripHints(p.profile_id);
    check('（前提）库里确实没有 client_hints 了（0.4.4 形态）', hintsOf(p.profile_id) === null,
      JSON.stringify(hintsOf(p.profile_id)));

    const before = JSON.stringify(rawRow(p.profile_id));
    const got = prof.getProfile(p.profile_id);
    const again = prof.getProfile(p.profile_id);
    prof.listProfiles({ page: 1, page_size: 500 });
    const after = JSON.stringify(rawRow(p.profile_id));

    check('hints 缺失 → 按 UA 的 Chrome/133 派生（**不是本机内核 ' + kernelMajor + '**）',
      got.client_hints?.ua_full_version === '133.0.0.0',
      `ua_full_version=${got.client_hints?.ua_full_version} 内核=${kernelVersion}`);
    check('大版本自洽：UA 133 ↔ ua_full_version 133', prof.checkProfile(got).ok === true,
      JSON.stringify(prof.checkProfile(got).hard));
    check('hints 平台也来自 UA（Windows），没有凭空改成别的平台',
      got.client_hints?.platform === 'Windows', String(got.client_hints?.platform));
    check('**读路径零写入**：连读 3 次之后库里那一行逐字节没变', before === after,
      before === after ? '' : '行被改写过');
    check('两次读出来一模一样（不是每次都重新派生出一个新值）',
      JSON.stringify(again.client_hints) === JSON.stringify(got.client_hints));
  }

  /* ==================== 2. 用户库里那种矛盾对：UA 133 + hints 157 ==================== */
  console.log('\n— 2. 矛盾对（UA 133 + hints 157，用户库的真实形态）：读出来必须自洽 —');
  {
    const p = prof.createProfile({ name: uniq('ua-conflict'), group_id: '0', ua: UA133 });
    const stored = {
      platform: 'Windows',
      platform_version: '10.0.0',
      architecture: 'x86',
      model: '',
      mobile: '0',
      wow64: '0',
      ua_full_version: kernelVersion,
      bitness: '64',
      brands: [
        { brand: 'Chromium', version: kernelMajor },
        { brand: 'Google Chrome', version: kernelMajor },
        { brand: 'Not_A Brand', version: '24' },
      ],
      fullVersionList: [
        { brand: 'Chromium', version: kernelVersion },
        { brand: 'Google Chrome', version: kernelVersion },
        { brand: 'Not_A Brand', version: '99.0.0.0' },
      ],
    };
    setFp(p.profile_id, { ...rawFp(p.profile_id), client_hints: stored });

    // 原始行（不过 toApi）仍然是矛盾的 —— 证明「校验没被放宽」，只是读路径给了自洽视图
    check('（前提）库里的原样确实是矛盾对（hints 是内核 ' + kernelMajor + '）',
      hintsOf(p.profile_id).ua_full_version === kernelVersion);

    const before = JSON.stringify(rawRow(p.profile_id));
    const got = prof.getProfile(p.profile_id);
    const after = JSON.stringify(rawRow(p.profile_id));

    check('读出来：hints 版本段对齐到 UA 的 133', got.client_hints?.ua_full_version === '133.0.0.0',
      String(got.client_hints?.ua_full_version));
    check('**platform 一个字节都不动**（那是另一条硬冲突，不许在这里被顺手放宽）',
      got.client_hints?.platform === 'Windows', String(got.client_hints?.platform));
    check('brands / fullVersionList 的版本段同步对齐（Not_A Brand 保持原样）',
      got.client_hints?.brands?.find((b) => b.brand === 'Google Chrome')?.version === '133'
      && got.client_hints?.fullVersionList?.find((b) => b.brand === 'Google Chrome')?.version === '133.0.0.0'
      && got.client_hints?.brands?.find((b) => b.brand === 'Not_A Brand')?.version === '24');
    check('checkProfile.ok === true（这就是 P0 那个 50/50 全红的入口）',
      prof.checkProfile(got).ok === true, JSON.stringify(prof.checkProfile(got).hard));
    check('读路径零写入：矛盾对还在库里（读视图不是迁移）',
      before === after && hintsOf(p.profile_id).ua_full_version === kernelVersion,
      `raw=${hintsOf(p.profile_id).ua_full_version}`);
  }

  /* ==================== 3. UA 缺失：回落本机内核（不许被第 1 条改坏） ==================== */
  console.log('\n— 3. UA 缺失 → 默认 hints 仍取本机内核 —');
  {
    const direct = hints.withClientHints({ ua: null, client_hints: null }, { kernelVersion });
    check('UA 缺失 + 无 hints → 用本机内核版本派生', direct.client_hints?.ua_full_version === kernelVersion,
      String(direct.client_hints?.ua_full_version));

    const p = prof.createProfile({ name: uniq('ua-none'), group_id: '0' });
    getDb().prepare('UPDATE profiles SET ua = NULL WHERE id = ?').run(p.profile_id);
    const got = prof.getProfile(p.profile_id);
    check('库里 UA 是 NULL → 读出来的 hints 仍是本机内核（不是空、不是猜测）',
      got.client_hints?.ua_full_version === kernelVersion, String(got.client_hints?.ua_full_version));
    check('UA 为空时 checkProfile 也不炸（只报该报的）', typeof prof.checkProfile(got).ok === 'boolean');
  }

  /* ==================== 4. 显式 hints 133：原样保留 ==================== */
  console.log('\n— 4. 显式给 client_hints.ua_full_version=133 → 原样保留 —');
  {
    const explicit = {
      platform: 'Windows', platform_version: '10.0.0', architecture: 'x86', model: '',
      mobile: '0', wow64: '0', ua_full_version: '133.0.6943.127', bitness: '64',
    };
    const p = prof.createProfile({ name: uniq('ua-explicit'), group_id: '0', ua: UA133, client_hints: explicit });
    const got = prof.getProfile(p.profile_id);
    check('显式 133 没被本机内核覆盖', got.client_hints?.ua_full_version === '133.0.6943.127',
      String(got.client_hints?.ua_full_version));
    check('落库的也是显式那一个（保存侧不擅自改写已是自洽的记录）',
      hintsOf(p.profile_id)?.ua_full_version === '133.0.6943.127', String(hintsOf(p.profile_id)?.ua_full_version));
    check('checkProfile.ok === true', prof.checkProfile(got).ok === true);
  }

  /* ==================== 5. 保存侧：不许写进矛盾对 ==================== */
  console.log('\n— 5. 保存侧（新建 / 更新）不许写进矛盾对 —');
  {
    // 新建：UA 133 配 hints 157（用户导入文件 + 我们按内核填的默认值撞在一起就是这个组合）
    const p = prof.createProfile({
      name: uniq('ua-save'),
      group_id: '0',
      ua: UA133,
      client_hints: { platform: 'Windows', ua_full_version: kernelVersion },
    });
    check('新建：UA 133 + hints ' + kernelMajor + ' → 落库前已对齐到 133（存进去的就自洽）',
      String(hintsOf(p.profile_id)?.ua_full_version || '').startsWith('133.'), String(hintsOf(p.profile_id)?.ua_full_version));
    const raw = (await import('../packages/profile/src/repo.js')).getProfile(getDb(), p.profile_id);
    check('新建：不过读路径（原始记录）也 checkProfile.ok === true', prof.checkProfile(raw).ok === true,
      JSON.stringify(prof.checkProfile(raw).hard));

    // 更新：只改 UA → hints 必须跟着走
    const p2 = prof.createProfile({ name: uniq('ua-upd'), group_id: '0', ua: UA133 });
    prof.updateProfile(p2.profile_id, { ua: uaOf(kernelMajor) });
    check('更新：只改 UA 到 ' + kernelMajor + ' → 库里的 hints 跟着到 ' + kernelMajor + '（不许留下旧版本）',
      String(hintsOf(p2.profile_id)?.ua_full_version || '').startsWith(`${kernelMajor}.`),
      String(hintsOf(p2.profile_id)?.ua_full_version));
    check('更新：改完的原始记录 checkProfile.ok === true',
      prof.checkProfile(prof.getProfile(p2.profile_id)).ok === true);

    // 更新：同时给 UA 133 和 hints 157（编辑页/脚本会这么传）→ 按 UA 对齐
    const upd = prof.updateProfile(p2.profile_id, {
      ua: UA133,
      client_hints: { platform: 'Windows', ua_full_version: kernelVersion },
    });
    check('更新：同一笔里 UA 133 + hints ' + kernelMajor + ' → 存进去的是 133（按 UA 这个身份对齐）',
      String(hintsOf(p2.profile_id)?.ua_full_version || '').startsWith('133.'),
      String(hintsOf(p2.profile_id)?.ua_full_version));
    check('更新：响应里也带 `ua_notice`（保存时就能看见「这个环境的 UA 会按内核对齐」）',
      upd?.ua_notice?.ua_major === '133' && upd?.ua_notice?.kernel_major === kernelMajor,
      JSON.stringify(upd?.ua_notice));
  }

  /* ==================== 6. 启动前预对齐：只治「只剩版本号」 ==================== */
  console.log('\n— 6. preAlignForLaunch：只治版本号，别的硬冲突继续阻断 —');
  {
    const base = () => ({
      ua: UA133,
      platform: 'Win32',
      client_hints: { platform: 'Windows', ua_full_version: kernelVersion },
      kernel_version: kernelVersion,
    });
    const chk = (x) => prof.checkProfile(x);

    check('（前提）只剩版本冲突 → checkProfile 红，且红的就是 ua_full_version',
      chk(base()).ok === false && chk(base()).hard.some((h) => h.field === 'client_hints.ua_full_version'),
      JSON.stringify(chk(base()).hard.map((h) => h.field)));

    const pre = hints.preAlignForLaunch(base(), { kernelVersion, check: chk });
    check('预对齐生效：applied=true，且**对齐后重查 ok === true** 才采用', pre.applied === true && chk(pre.profile).ok === true,
      JSON.stringify(pre.reasons));
    check('预对齐把 UA 与 hints 都拉到本机内核 ' + kernelMajor,
      String(pre.profile.client_hints?.ua_full_version) === kernelVersion
      && String(pre.profile.ua).includes(`Chrome/${kernelMajor}.`),
      `${pre.profile.client_hints?.ua_full_version} / ${/Chrome\/[\d.]+/.exec(String(pre.profile.ua))?.[0]}`);
    check('预对齐**不落库**（只改这一轮要启动的视图）',
      /不改库|不落库/.test(fs.readFileSync(new URL('../src/runtime/manager.js', import.meta.url), 'utf8')));

    // webgl 空开关：必须继续阻断，不许借版本对齐的口子放行
    const webglBad = { ...base(), webgl: '2', webgl_config: { unmasked_vendor: '', unmasked_renderer: '' } };
    const preW = hints.preAlignForLaunch(webglBad, { kernelVersion, check: chk });
    check('webgl 空开关 + 版本冲突 → 预对齐**不动**（applied=false，硬冲突留着）',
      preW.applied === false && preW.hardLeft.length >= 1,
      JSON.stringify(preW.hardLeft.map((h) => h.field)));

    // UA 平台 ↔ navigator.platform 矛盾：必须继续阻断
    const platBad = { ...base(), platform: 'MacIntel' };
    const preP = hints.preAlignForLaunch(platBad, { kernelVersion, check: chk });
    check('UA 是 Windows 但 platform=MacIntel → 预对齐**不动**（平台矛盾继续阻断）',
      preP.applied === false, JSON.stringify(preP.hardLeft.map((h) => h.field)));

    check('内核版本读不出来 → 预对齐什么都不做（不乱对齐）',
      hints.preAlignForLaunch(base(), { kernelVersion: 'abc', check: chk }).applied === false);
    check('本来就 ok 的记录 → 预对齐不碰它（applied=false）',
      hints.preAlignForLaunch({ ...base(), ua: uaOf(kernelMajor) }, { kernelVersion, check: chk }).applied === false);
  }

  /* ==================== 7. 导入提前说（要求 3） ==================== */
  console.log('\n— 7. 导入时就说，别等点开才发现 —');
  {
    const r = transfer.importProfiles([{ name: uniq('imp-133'), ua: UA133 }]);
    check('导入只带 UA 133 → 建出来的记录自洽、checkProfile.ok === true',
      r.imported === 1 && prof.checkProfile(r.list[0]).ok === true, `imported=${r.imported}`);
    check('导入结果带 `ua_aligned` 计数（1 个）', r.ua_aligned === 1, String(r.ua_aligned));
    check('导入结果带一句人话（0.4.7.2 起说「UA 不会被改」，不再承诺自动对齐）',
      /UA 不会被改/.test(r.ua_notice?.message || '') && !/首次打开会按内核对齐/.test(r.ua_notice?.message || ''),
      r.ua_notice?.message);
    check('逐条也带 `ua_notice`（哪个环境的 UA 是哪版）',
      r.list[0].ua_notice?.ua_major === '133' && r.list[0].ua_notice?.kernel_major === kernelMajor,
      JSON.stringify(r.list[0].ua_notice));
    check('这句文案里没有 Markdown 记号 `**`（界面文案规矩）', !/\*\*/.test(r.ua_notice?.message || ''));

    const same = transfer.importProfiles([{ name: uniq('imp-same'), ua: uaOf(kernelMajor) }]);
    check('UA 与本机内核同版 → 不报 `ua_aligned`（不凭空多一行）',
      same.ua_aligned === 0 && same.ua_notice === null, JSON.stringify(same.ua_notice));
  }

  /* ==================== 8. 静态：这几处接线不许被后人拆掉 ==================== */
  console.log('\n— 8. 静态断言（接线位置） —');
  {
    const readSrc = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    const hintsSrc = readSrc('../src/fingerprint/hints.js');
    const mgrSrc = readSrc('../src/runtime/manager.js');
    const routesSrc = readSrc('../src/api/routes.js');
    const xferSrc = readSrc('../src/store/transfer.js');
    const webSrc = readSrc('../web/pages/profiles.js');
    const splitSrc = readSrc('../web/txt-split.js');

    check('静态：hints.js 复用 `kernel/version.js` 的对齐实现，不许自己再写一份',
      /from '\.\.\/kernel\/version\.js'/.test(hintsSrc) && !/function alignToKernel/.test(hintsSrc));
    check('静态：manager 在校验**之前**调 `preAlignForLaunch`，并把结果换成这一轮要启动的 profile',
      /preAlignForLaunch\(launchProfile/.test(mgrSrc) && /profile = launchProfile/.test(mgrSrc));
    check('静态：启动响应里有 `ua_realign_precheck` 这条 soft 告警，并记一行日志',
      /ua_realign_precheck/.test(mgrSrc) && /log\(id, 'UA 预对齐'/.test(mgrSrc));
    check('静态：导入两条路（JSON / txt）都把 `ua_aligned` 透传给界面',
      (routesSrc.match(/ua_aligned: r\.ua_aligned/g) || []).length >= 2);
    check('静态：导入汇总的人话在 store 与分批合并两处都拼得出来',
      /UA 不会被改/.test(xferSrc) && /UA 不会被改/.test(splitSrc));
    check('静态：界面真的把这句显示出来（toast + 导入结果清单）',
      /r\.ua_notice\.message/.test(webSrc) && /sum\.ua_notice\.message/.test(webSrc)
      && /if \(r\.ua_notice\) lines\.push/.test(webSrc));
  }

  /* ==================== 9. 验收硬指标：用户库副本 50/50 ==================== */
  console.log('\n— 9. 验收：拿用户库副本跑同一套 getProfile + checkProfile —');
  {
    const copyBase = process.env.FREEPOWER_USER_DB_COPY
      || path.join(os.homedir(), '.dsh', 'bot', 'workspace', '.tmp', 'ceo-user-db-copy.db');
    if (!fs.existsSync(copyBase)) {
      skip('用户库副本全部通过', `副本不在（${copyBase}），本机判不了 —— 这条要在有副本的机器上跑`);
    } else {
      // 必须开子进程：FREEPOWER_DATA 在 config.js 里是模块加载时读的，本进程已经开了自己的库
      const helper = path.join(dataDir, 'userdb-accept.mjs');
      fs.writeFileSync(helper, `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const src = process.env.FP_USERDB_COPY;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-userdb-'));
for (const suffix of ['', '-wal', '-shm']) {
  const from = src + suffix;
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(work, 'freepower.db' + suffix));
}
process.env.FREEPOWER_DATA = work;
process.env.FREEPOWER_SELFCHECK = '0';
const prof = await import(${JSON.stringify(new URL('../src/store/profiles.js', import.meta.url).href)});
const { getDb, closeDb } = await import(${JSON.stringify(new URL('../src/store/db.js', import.meta.url).href)});
const ids = getDb().prepare('SELECT id FROM profiles WHERE deleted_at IS NULL').all();
let pass = 0;
const reasons = [];
for (const r of ids) {
  const p = prof.getProfile(r.id);
  const chk = p ? prof.checkProfile(p) : { ok: false, errors: [{ field: '$', message: 'getProfile 返回 null' }] };
  if (chk.ok) pass += 1;
  else reasons.push(\`\${chk.errors[0]?.field}: \${chk.errors[0]?.message}\`);
}
try { closeDb(); } catch { /* ignore */ }
try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(JSON.stringify({ total: ids.length, pass, reasons: [...new Set(reasons)] }));
`, 'utf8');
      const out = execFileSync(process.execPath, ['--no-warnings', helper], {
        encoding: 'utf8',
        env: { ...process.env, FP_USERDB_COPY: copyBase },
        timeout: 180000,
      });
      const j = JSON.parse(String(out).trim().split(/\r?\n/).pop());
      check(`用户库副本：${j.total} 个未删除环境全部通过`, j.total > 0 && j.pass === j.total,
        `pass=${j.pass}/${j.total}${j.reasons.length ? ' | ' + j.reasons.slice(0, 3).join(' | ') : ''}`);
    }
  }

  try { closeDb(); } catch { /* ignore */ }
} catch (e) {
  check('A 层跑完没有抛异常', false, `${e && e.message}`);
  console.error(e);
} finally {
  await new Promise((r) => setTimeout(r, 200));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄还在，留给系统 */ }
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
