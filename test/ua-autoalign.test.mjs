/**
 * 「UA 跟随内核版本升级」开关（0.4.7.2）—— **A 层：不起内核**。
 *
 * 这一版翻的是**默认值**：0.4.4 ~ 0.4.7.1 启动后会把 `ua` / `client_hints` / `kernel_version`
 * 拉成真实内核版本并落库；用户 50 个环境的 UA 是导入时带的 Chrome/133、本机内核 157，
 * 一开环境就被永久改写 —— 而对手（AdsPower / SunBrowser）根本不这么做
 * （逆向 02-指纹字段表.md:168-169：`ua` 与 `client_hints` 是两个各自可配的字段）。
 *
 * 所以这里钉四组：
 *
 *   1. **默认关**：没存过设置就是关，出厂常量也是关；坏数据一律按关（读不懂就不许改用户数据）。
 *   2. **开关持久化**：写进 `meta.ua_autoalign`，重启后仍读得回来；只认布尔。
 *   3. **静态：改写点必须在开关之下**。`applyProfileFields(id, aligned.patch)` 与
 *      `preAlignForLaunch(...)` 两处都在 `uaAutoAlign` 之下 —— 关着时**任何路径**都不许改写
 *      `ua` / `client_hints` / `kernel_version`（含「这一轮呈现的指纹」）。
 *   4. **UA-CH 注入源**：`uaFullVersion` 与整套 UA-CH 的值真的被塞进注入脚本
 *      （真内核那层的判据在 `test/ua-hints-kernel.test.mjs`）。
 *
 * 数据根一律 `os.tmpdir()` 下的一次性目录，绝不碰仓库 `data/`。
 *
 * 跑法：node --no-warnings test/ua-autoalign.test.mjs （已进 npm test）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dataDir = path.join(os.tmpdir(), `freepower-uaalign-${Date.now()}`);
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_SELFCHECK = '0';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const readSrc = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

try {
  const config = await import('../src/config.js');
  const prefs = await import('../src/settings/prefs.js');
  const { getMeta, setMeta, closeDb } = await import('../src/store/db.js');
  const hints = await import('../src/fingerprint/hints.js');
  const { fingerprintView } = await import('../src/fingerprint/view.js');
  const { buildInjectionSource, buildWorkerInjectionSource, buildUaChOnlySource } = await import('../src/kernel/inject.js');
  const { markerNames } = await import('../src/kernel/markers.js');

  /* ==================== 1. 默认关 ==================== */
  console.log('\n— 1. 默认关（没存过设置 / 出厂常量） —');
  {
    check('出厂常量 UA_AUTOALIGN === false（0.4.7.2 起默认不跟版）', config.UA_AUTOALIGN === false,
      String(config.UA_AUTOALIGN));
    const r = prefs.readUaAutoAlign();
    check('没存过设置 → 关，且 saved=false（界面要能显示「默认」）',
      r.enabled === false && r.saved === false && r.broken === false, JSON.stringify(r));
    check('uaAutoAlignEnabled() === false（manager 只读这一个函数）',
      prefs.uaAutoAlignEnabled() === false);

    // 环境变量仍可把**出厂默认**改成开（测试/排障用），但库里的显式设置优先
    const out = execFileSync(process.execPath, ['--no-warnings', '-e',
      "import('./src/config.js').then(m=>console.log(String(m.UA_AUTOALIGN)))"], {
      cwd: path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..'),
      env: { ...process.env, FREEPOWER_UA_AUTOALIGN: '1' },
      encoding: 'utf8',
    }).trim();
    check('FREEPOWER_UA_AUTOALIGN=1 时出厂默认是开（排障与判据要用）', out === 'true', out);
  }

  /* ==================== 2. 开关持久化 ==================== */
  console.log('\n— 2. 开关持久化（meta.ua_autoalign） —');
  {
    const on = prefs.writeUaAutoAlign(true);
    check('写 true：返回 enabled=true、changed=true', on.enabled === true && on.changed === true, JSON.stringify(on));
    check('库里真的存了（`meta.ua_autoalign` = true，重启读的就是它）', getMeta(prefs.UA_AUTOALIGN_KEY) === 'true',
      String(getMeta(prefs.UA_AUTOALIGN_KEY)));
    const back = prefs.readUaAutoAlign();
    check('再读回来：enabled=true、saved=true（不是「没存过」）',
      back.enabled === true && back.saved === true, JSON.stringify(back));
    check('uaAutoAlignEnabled() 跟着变 true', prefs.uaAutoAlignEnabled() === true);

    const off = prefs.writeUaAutoAlign(false);
    check('写 false：enabled=false、changed=true', off.enabled === false && off.changed === true, JSON.stringify(off));
    check('关掉之后 uaAutoAlignEnabled() 立刻是 false', prefs.uaAutoAlignEnabled() === false);

    let err = null;
    try { prefs.writeUaAutoAlign('yes'); } catch (e) { err = e; }
    check('非布尔一律拒（INVALID_ENABLED），不猜用户意图',
      err && err.code === 'INVALID_ENABLED', err ? err.code : '居然接受了');
  }

  /* ==================== 3. 坏数据按关 ==================== */
  console.log('\n— 3. 存坏了：按关处理，不改用户数据 —');
  {
    setMeta(prefs.UA_AUTOALIGN_KEY, 'yes-please');
    const r = prefs.readUaAutoAlign();
    check('脏值 → enabled=false、broken=true（界面要如实说「已按关处理」）',
      r.enabled === false && r.broken === true, JSON.stringify(r));
    check('脏值时 uaAutoAlignEnabled() === false（宁可不动用户 UA）', prefs.uaAutoAlignEnabled() === false);
    setMeta(prefs.UA_AUTOALIGN_KEY, '');
    check('清空之后回到「没存过」（默认关）',
      prefs.readUaAutoAlign().saved === false && prefs.uaAutoAlignEnabled() === false);
  }

  /* ==================== 4. 静态：改写点都在开关之下 ==================== */
  console.log('\n— 4. 静态断言：关着时任何路径都不改写 UA —');
  {
    const mgrSrc = readSrc('../src/runtime/manager.js');
    check('manager 不再直接读 config 里的 UA_AUTOALIGN，改读 uaAutoAlignEnabled()',
      // 只要是从 prefs 里拿这个开关就行（import 里可以并列别的开关，0.4.7.3 加了 readAlwaysStartPage）
      /import \{[^}]*\buaAutoAlignEnabled\b[^}]*\} from '\.\.\/settings\/prefs\.js'/.test(mgrSrc)
      && !/UA_AUTOALIGN/.test(mgrSrc));
    check('启动后那次落库对齐在 `if (uaAutoAlign && realVersion)` 之下',
      /if \(uaAutoAlign && realVersion\)/.test(mgrSrc));

    // aligned.patch 落库那一条必须在这个 if 块里：取两者的字节位置，中间不许有第二个 applyProfileFields
    const guardAt = mgrSrc.indexOf('if (uaAutoAlign && realVersion)');
    const applyAt = mgrSrc.indexOf('applyProfileFields(id, aligned.patch)');
    const between = guardAt >= 0 && applyAt > guardAt ? mgrSrc.slice(guardAt, applyAt) : null;
    check('`applyProfileFields(id, aligned.patch)` 出现在开关块里（且在块内第一条落库调用）',
      between !== null && (between.match(/applyProfileFields\(/g) || []).length === 0,
      guardAt >= 0 && applyAt > guardAt ? `相隔 ${applyAt - guardAt} 字节` : '没找到');

    check('启动前的预对齐也在开关之下（`!check.ok && !force && uaAutoAlign`）',
      /if \(!check\.ok && !force && uaAutoAlign\)/.test(mgrSrc));
    check('全文件只有一处 `applyProfileFields(id, aligned.patch)`（不许留第二份没设防的写入口）',
      (mgrSrc.match(/applyProfileFields\(id, aligned\.patch\)/g) || []).length === 1);
    // 噪点种子那条是另一回事（0.4.6 就有、与 UA 无关），但**不许**它顺手写 ua/client_hints/kernel_version
    const seedAt = mgrSrc.indexOf('applyProfileFields(id, seedPatch)');
    check('噪点种子那条落库只写种子字段（不含 ua / client_hints / kernel_version）',
      seedAt > 0 && !/seedPatch\s*=\s*\{[^}]*(ua|client_hints|kernel_version)/.test(mgrSrc));
  }

  /* ==================== 5. 导入那句话不再承诺自动对齐 ==================== */
  console.log('\n— 5. 导入结果的人话 —');
  {
    const notice = hints.uaKernelNotice({ ua: 'Mozilla/5.0 Chrome/133.0.6943.127 Safari/537.36', kernel_version: '157.0.8103.78' });
    check('UA 133 / 内核 157 时给一句人话', !!notice && notice.ua_major === '133' && notice.kernel_major === '157',
      JSON.stringify(notice));
    check('这句话说「UA 不会被改」，不再承诺「首次打开会按内核对齐」',
      /UA 不会被改/.test(notice.message) && !/首次打开会按内核对齐/.test(notice.message), notice.message);
    check('这句话指向设置页的开关（用户要知道去哪儿改）',
      /UA 跟随内核版本升级/.test(notice.message), notice.message);
    check('这句文案里没有 Markdown 记号 `**`（界面文案规矩）', !/\*\*/.test(notice.message));
    check('UA 与内核同版 → 不报（不凭空多一行）',
      hints.uaKernelNotice({ ua: 'Mozilla/5.0 Chrome/157.0.0.0 Safari/537.36', kernel_version: '157.0.8103.78' }) === null);
  }

  /* ==================== 6. 注入源：UA-CH 的值真的进去了 ==================== */
  console.log('\n— 6. 注入源里的 UA-CH（真内核那层由 ua-hints-kernel 钉） —');
  {
    const view = fingerprintView({
      id: 'p1', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.6943.127 Safari/537.36',
      platform: 'Win32', language: ['en-US'], fp_seed: 'seed-1',
      client_hints: {
        platform: 'Windows', platform_version: '10.0.0', architecture: 'x86', bitness: '64',
        model: '', mobile: '0', wow64: '0', ua_full_version: '133.0.0.0',
      },
    });
    const page = buildInjectionSource(view);
    check('注入源里带上 uaFullVersion（CDP 永远不认的那一项）',
      /"uaFullVersion":"133\.0\.0\.0"/.test(page));
    check('注入源里带上 platformVersion（profile 的值，不是宿主真值）',
      /"platformVersion":"10\.0\.0"/.test(page));
    check('注入源里带上 architecture / bitness / model / wow64 全套',
      /"architecture":"x86"/.test(page) && /"bitness":"64"/.test(page)
      && /"model":""/.test(page) && /"wow64":false/.test(page));
    check('注入层有 native code 前置判断（防重复注入 / 不跟页面 polyfill 打架）',
      /indexOf\('native code'\) === -1/.test(page));
    check('主帧真的调了 patchUaData', /patchUaData\(window\)/.test(page));
    check('专用 worker 也调（worker 里 uaFullVersion 同样是宿主真值）',
      /patchUaData\(self\)/.test(buildWorkerInjectionSource(view)));
    check('值已经对时一个字段都不改（"值不对才补"）', /if \(same\(r\[k\], want\[k\]\)\) continue;/.test(page));
    check('返回的 brands 做成冻结数组（裸内核是 frozen 的）', /Object\.freeze/.test(page) && /freezeBrands/.test(page));

    const noHints = buildInjectionSource(fingerprintView({ id: 'p2', ua: view.ua, fp_seed: 's2' }));
    check('没有 client_hints 的视图 → 不生成 uaData（不凭空造 UA-CH）',
      /"uaData":null/.test(noHints));

    /* ---- 子帧那份「只做 UA-CH」的最小脚本（0.4.7.2 第二版，CEO 打回的那条） ---- */
    const uaChOnly = buildUaChOnlySource(view);
    check('子帧脚本存在，且带上 uaFullVersion / platformVersion',
      !!uaChOnly && /"uaFullVersion":"133\.0\.0\.0"/.test(uaChOnly) && /"platformVersion":"10\.0\.0"/.test(uaChOnly));
    check('子帧脚本真的调了 patchUaData(window)', /patchUaData\(window\)/.test(uaChOnly));
    check('子帧脚本**不装**整套注入（没有 canvas / WebGL / 媒体设备 / 字体 / Screen 那段）',
      !/noiseImageData|patchGL|enumerateDevices|speechSynthesis|availWidth|Screen\.prototype|HTMLCanvasElement/.test(uaChOnly)
      && !/MK\.fontsDeclared/.test(uaChOnly));
    check('子帧脚本也带 toString 伪装（否则 getHighEntropyValues.toString() 吐出真源码）',
      /installToStringTrap\(\)/.test(uaChOnly));
    check('子帧脚本带自己的防重复标记（uaCh，按种子派生、不是固定名）',
      uaChOnly.includes(markerNames(view.seed).uaCh) && !/__fp/.test(uaChOnly));
    check('没有 client_hints 时子帧脚本为 null（不装任何东西）',
      buildUaChOnlySource(fingerprintView({ id: 'p3', ua: view.ua, fp_seed: 's3' })) === null);
    const mgrSrc6 = readSrc('../src/runtime/manager.js');
    check('静态：iframe 分支既发 CDP 覆写、也注册 UA-CH 脚本，且两件都落地才放行',
      /Emulation\.setUserAgentOverride/.test(mgrSrc6) && /buildUaChOnlySource\(view/.test(mgrSrc6)
      && /runImmediately: true/.test(mgrSrc6)
      && /Promise\.all\(jobs\)[\s\S]{0,120}resumeNow/.test(mgrSrc6));
  }

  /* ==================== 7. 接线：路由 + 界面 ==================== */
  console.log('\n— 7. 接线（设置页开关 + 路由） —');
  {
    const routesSrc = readSrc('../src/api/routes.js');
    const apiSrc = readSrc('../web/api.js');
    const setSrc = readSrc('../web/pages/settings.js');
    check('路由：POST /api/v2/settings/ua-autoalign 存在',
      /'\/api\/v2\/settings\/ua-autoalign'/.test(routesSrc));
    check('路由：GET /api/v2/settings 里带 ua_autoalign 三个字段',
      /ua_autoalign: uaAlign\.enabled/.test(routesSrc) && /ua_autoalign_saved/.test(routesSrc)
      && /ua_autoalign_broken/.test(routesSrc));
    check('界面 API：setUaAutoAlign', /setUaAutoAlign: \(enabled\)/.test(apiSrc));
    check('设置页：有这一格，且勾选框接的是 setUaAutoAlign',
      /paintUaAutoAlign/.test(setSrc) && /api\.setUaAutoAlign\(want\)/.test(setSrc)
      && /UA 跟随内核版本升级/.test(setSrc));
    check('设置页文案里没有 Markdown 记号 `**`（新增文案规矩）',
      !/UA 跟随内核版本升级[\s\S]{0,900}\*\*/.test(setSrc));
  }
} catch (e) {
  check('A 层跑完没有抛异常', false, `${e && e.message}`);
  console.error(e);
} finally {
  try { closeDbSafe(); } catch { /* ignore */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function closeDbSafe() {
  const db = await import('../src/store/db.js');
  try { db.closeDb(); } catch { /* ignore */ }
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
