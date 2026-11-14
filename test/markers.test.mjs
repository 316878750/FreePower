/**
 * P0 判据（A 层：不需要 Chrome）。
 *
 * 背景：注入层原来在 window/self 上挂了 **7 个固定名** 的标记
 * （`__fpApplied` / `__fpInstalled` / `__fpRealm` / `__fpSeeds` / `__fpSeed`
 *  / `__fpMediaMode` / `__fpFontsDeclared`）。网站一句
 * `Object.getOwnPropertyNames(window).some(n => n.startsWith('__fp'))` 就能认出我们，
 * 而且这个洞**每个环境、每个页面、每次打开**都在 —— 是常驻检测面，不是偶发。
 * 其中 `__fpInstalled` 还是**普通赋值**（可枚举，`for...in` 就能看见）。
 *
 * 修法与判据口径（对齐要求）：
 *   1. 名字按 fp_seed 派生：`_` + 8 位小写 hex，不含 `fp`、没有 `__` 前缀；
 *      同一环境稳定、不同环境不同 —— 名字每次都变本身就是另一个信号。
 *   2. 全部走 `defineProperty({enumerable:false})`，`__fpInstalled` 那条不许再用普通赋值。
 *   3. `__fpSeed` 零消费者 → 直接删，不给它派生名。
 *   4. 注入源（page + worker）里**代码行**不许再出现 `__fp` 字面量（注释允许，
 *      注释是给人看的历史说明，不是页面能读到的东西）。
 *
 * 真内核那半在 test/markers-kernel.test.mjs（`npm run test:markers-kernel`）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { markerNames, MARKER_KEYS, MARKER_NAME_RE, markerConstSource } from '../src/kernel/markers.js';
import { buildInjectionSource, buildWorkerInjectionSource } from '../src/kernel/inject.js';
import { fingerprintView } from '../src/fingerprint/view.js';
import { generateFingerprint } from '../src/fingerprint/generate.js';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};

/* ============================ 一、名字派生 ============================ */

const seedA = 'fp-seed-alpha';
const seedB = 'fp-seed-bravo';
const namesA = markerNames(seedA);
const namesA2 = markerNames(seedA);
const namesB = markerNames(seedB);

check('派生 8 个名字（applied/seeds/realm/installed/mediaMode/fontsDeclared/config/orig）',
  Object.keys(namesA).length === 8, Object.keys(namesA).join(','));
check('MARKER_KEYS 与派生结果一一对应',
  MARKER_KEYS.every((k) => typeof namesA[k] === 'string') && Object.keys(namesA).length === MARKER_KEYS.length);

// 同一 fp_seed 必须稳定：刷新前后名字变了本身就是另一个信号
check('同一 seed 两次派生完全相同（稳定性）', JSON.stringify(namesA) === JSON.stringify(namesA2));
check('不同 seed 派生不同（环境之间不可关联）',
  MARKER_KEYS.every((k) => namesA[k] !== namesB[k]), `${namesA.applied} vs ${namesB.applied}`);

// 形状：_xxxxxxxx，不含 fp、不带 __ 前缀
check('全部符合 _<8位小写hex>', MARKER_KEYS.every((k) => MARKER_NAME_RE.test(namesA[k])),
  Object.values(namesA).join(','));
check('8 个名字互不相同（不能有两个标记撞名）',
  new Set(Object.values(namesA)).size === 8);
check('名字里不含 "fp"（大小写都算）',
  MARKER_KEYS.every((k) => !/fp/i.test(namesA[k])), Object.values(namesA).join(','));
check('名字没有 __ 前缀（看起来像普通临时变量）',
  MARKER_KEYS.every((k) => !namesA[k].startsWith('__')));
check('__fpSeed 没有派生的对应名（零消费者的标记已删，不给它留位置）',
  !Object.keys(namesA).some((k) => /seed(s)?$/i.test(k) && k !== 'seeds'),
  Object.keys(namesA).join(','));

// 缺省也要能算（不许因为没种子就回落固定名）
const fallback = markerNames();
check('不传 seed 也能派生，且仍是派生名（不回落固定名）',
  MARKER_KEYS.every((k) => MARKER_NAME_RE.test(fallback[k])));
check('缺省 seed 与 "freepower" 一致（与注入层缺省口径同源）',
  JSON.stringify(fallback) === JSON.stringify(markerNames('freepower')));

/* ============================ 二、注入源静态扫描 ============================ */

/**
 * 去掉注释后再找 `__fp`。
 * 注释里写「以前叫 __fpSeed，已删」是给人和复盘用的，页面读不到；
 * 但**代码行里**出现就等于把固定名又放回页面了。
 * 这里的 stripping 只处理行注释与块注释的「整行」形态（block 注释正文行以 * 开头），
 * 够用且不会误删代码 —— 宁可漏掉一行注释，也不许把真代码当注释放过。
 */
function stripCommentLines(src) {
  const out = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true;
      continue;
    }
    if (t.startsWith('//') || t.startsWith('*')) continue;
    out.push(line);
  }
  return out.join('\n');
}

const viewA = fingerprintView(generateFingerprint({ seed: seedA, kernel: '157.0.8103.78' }));
const viewB = fingerprintView(generateFingerprint({ seed: seedB, kernel: '157.0.8103.78' }));
const pageSrcA = buildInjectionSource(viewA);
const workerSrcA = buildWorkerInjectionSource(viewA);
const pageSrcNoComment = stripCommentLines(pageSrcA);
const workerSrcNoComment = stripCommentLines(workerSrcA);

const leaks = (src) => (src.match(/__fp\w*/g) || []);
check('page 注入源代码行里没有 __fp 字面量', leaks(pageSrcNoComment).length === 0, leaks(pageSrcNoComment).join(',') || 'none');
check('worker 注入源代码行里没有 __fp 字面量', leaks(workerSrcNoComment).length === 0, leaks(workerSrcNoComment).join(',') || 'none');
check('注入源里带着这个环境的派生名（不是空壳）',
  Object.values(markerNames(viewA.seed)).every((n) => pageSrcA.includes(n))
  && Object.values(markerNames(viewA.seed)).every((n) => workerSrcA.includes(n)));
check('不同种子的注入源字节不同（名字真的随环境走）', pageSrcA !== buildInjectionSource(viewB));

// 静态防回流：源码里也不许有「赋值固定名」的写法
const injectSrc = fs.readFileSync(path.join(ROOT, 'src', 'kernel', 'inject.js'), 'utf8');
const managerSrc = fs.readFileSync(path.join(ROOT, 'src', 'runtime', 'manager.js'), 'utf8');
const probeSrc = fs.readFileSync(path.join(ROOT, 'src', 'selfcheck', 'probe.js'), 'utf8');
const workerProbeSrc = fs.readFileSync(path.join(ROOT, 'src', 'selfcheck', 'worker-probe.js'), 'utf8');
for (const [label, src] of [['inject.js', injectSrc], ['manager.js', managerSrc],
  ['probe.js', probeSrc], ['worker-probe.js', workerProbeSrc]]) {
  const code = stripCommentLines(src);
  const found = leaks(code);
  check(`${label} 代码里没有 __fp 字面量（防回流）`, found.length === 0, found.slice(0, 4).join(',') || 'none');
}

/* ============================ 三、沙箱里真的跑一遍 ============================ */

/**
 * 最小沙箱跑真源码。
 *
 * 入参**故意只给 `{ seed }`**：没有 UA / 没有 canvas / 没有 webgl / 没有媒体设备，
 * 注入脚本里那些 patch 分支全部跳过，剩下跑到的就是「噪声核心 + 诊断标记」这条尾段 ——
 * 也就是这条判据真正要验的东西。给全量指纹就得造一整套 DOM 桩（那是 unit.test.mjs 的事），
 * 这里为了验「标记怎么写上去」再造一遍只会多一份会漂移的假 DOM。
 */
function runInjection(kind, fp) {
  // 桩只给「无条件执行」的那几行用：拿到原型上的方法就能过，
  // 任何 patch 分支（canvas/webgl/media/speech）在 fp 只有 seed 时都不会进。
  class CanvasRenderingContext2DStub {
    getImageData() { return { data: new Uint8ClampedArray(4) }; }
    putImageData() {}
  }
  class HTMLCanvasElementStub {
    getContext() { return new CanvasRenderingContext2DStub(); }
    toDataURL() { return 'data:image/png;base64,'; }
    toBlob(cb) { if (cb) cb(null); }
  }
  class ElementStub {
    getBoundingClientRect() { return { x: 0, y: 0, width: 0, height: 0 }; }
    getAttribute() { return null; }
  }
  const sandbox = {
    navigator: { platform: 'Win32', userAgent: 'UA', language: 'en-US', languages: ['en-US'] },
    CanvasRenderingContext2D: { prototype: CanvasRenderingContext2DStub.prototype },
    HTMLCanvasElement: { prototype: HTMLCanvasElementStub.prototype },
    Element: { prototype: ElementStub.prototype },
    DOMRect: class { constructor(x = 0, y = 0, w = 0, h = 0) { Object.assign(this, { x, y, width: w, height: h }); } },
    document: { createElement: () => new HTMLCanvasElementStub() },
    screen: { width: 1920, height: 1080 },
    location: { protocol: 'https:', href: 'https://example.test/' },
    devicePixelRatio: 1,
    innerWidth: 1280,
    innerHeight: 800,
    console,
    setTimeout,
    clearTimeout,
  };
  Object.defineProperty(sandbox.HTMLCanvasElement, 'prototype', { value: HTMLCanvasElementStub.prototype });
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  const src = kind === 'page' ? buildInjectionSource(fp) : buildWorkerInjectionSource(fp);
  vm.runInContext(src, context, { filename: `${kind}.inject.js` });
  return { sandbox, context };
}

const fpA = { seed: seedA };
const pageRun = runInjection('page', fpA);
const page = pageRun.sandbox;
const mk = markerNames(seedA);

check('注入后 applied 标记是数组', Array.isArray(page[mk.applied]), typeof page[mk.applied]);
check('注入后 realm 标记是 page', page[mk.realm] === 'page', String(page[mk.realm]));
check('注入后 installed 标记是 true', page[mk.installed] === true, String(page[mk.installed]));
check('__fpSeed 对应的东西不再存在（零消费者标记已删）',
  !Object.values(mk).some((n) => page[n] !== undefined && page[n] === seedA));

/* 这三条是 CEO 专门要求「单独一根判据钉死」的那几条 */
const ownNames = Object.getOwnPropertyNames(page).filter((n) => /^__fp/i.test(n));
check('window own property names 里 0 个 __fp* 开头', ownNames.length === 0, ownNames.join(',') || 'none');

const forIn = [];
for (const k in page) if (/^__fp/i.test(k)) forIn.push(k);
check('for...in 枚举不到任何 __fp* 键', forIn.length === 0, forIn.join(',') || 'none');

const enumerable = Object.getOwnPropertyNames(page).filter((n) => Object.prototype.propertyIsEnumerable.call(page, n));
const markerEnumerable = Object.values(mk).filter((n) => enumerable.includes(n));
check('所有标记都不可枚举（Object.keys / for...in 都看不见）', markerEnumerable.length === 0, markerEnumerable.join(',') || 'none');

// 反过来：派生名必须**确实存在且不可枚举**，否则「没有检测面」是因为什么都没挂上（假绿）
check('派生名确实挂上了（4 个以上非 DEBUG 标记）',
  ['applied', 'seeds', 'realm', 'installed'].every((k) => page[mk[k]] !== undefined),
  ['applied', 'seeds', 'realm', 'installed'].map((k) => `${k}:${page[mk[k]] === undefined ? '缺' : '有'}`).join(','));

// 重复注入不许叠（installed 守卫仍然有效）—— 必须是同一个 context，换一个就验不到守卫。
// 判据用**引用相等**而不是长度：只给 seed 时 applied 是空数组，长度恒为 0 会假绿。
const appliedRef = page[mk.applied];
vm.runInContext(buildInjectionSource(fpA), pageRun.context, { filename: 'page.reinject.js' });
check('重复注入是幂等的（还是同一个 applied 数组，没重跑）', page[mk.applied] === appliedRef);
check('重复注入后 installed 仍是 true', page[mk.installed] === true);

const workerRun = runInjection('worker', fpA);
const worker = workerRun.sandbox;
const wOwn = Object.getOwnPropertyNames(worker).filter((n) => /^__fp/i.test(n));
const wForIn = [];
for (const k in worker) if (/^__fp/i.test(k)) wForIn.push(k);
check('worker self 的 own names 里 0 个 __fp*', wOwn.length === 0, wOwn.join(',') || 'none');
check('worker self 的 for...in 里 0 个 __fp*', wForIn.length === 0, wForIn.join(',') || 'none');
check('worker 的 realm 标记是 worker', worker[mk.realm] === 'worker', String(worker[mk.realm]));
check('worker 的 installed 不可枚举',
  !Object.prototype.propertyIsEnumerable.call(worker, mk.installed));

/* 变异观察窗：把名字换回固定名，上面第一条必须能红 —— 这里直接验「判据本身认得固定名」 */
const fixedNameSandbox = { window: null, self: null, navigator: {}, document: { createElement: () => ({ getContext: () => null }) }, console };
fixedNameSandbox.window = fixedNameSandbox;
fixedNameSandbox.self = fixedNameSandbox;
vm.runInContext('Object.defineProperty(window, "__fpApplied", { value: [], enumerable: false, configurable: false });',
  vm.createContext(fixedNameSandbox));
const fixedLeak = Object.getOwnPropertyNames(fixedNameSandbox).filter((n) => /^__fp/i.test(n));
check('判据能抓住固定名（把 __fpApplied 放回去 → 检出 1 条）', fixedLeak.length === 1, fixedLeak.join(','));

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);