/**
 * 「窗口同步」页**真的能加载**的判据（0.4.7.8）。
 *
 * 起因：用户装上 0.4.7.7 点开窗口同步，页面显示
 *   出错了 / 页面加载失败：Cannot access 'isRunning' before initialization
 * 这是 TDZ（`const`/`let` 在声明前被读）。之前的判据全是**对源码做正则匹配**
 * （如 `sync-layout.test.mjs` 里的 `assert(/const isRunning = …/)`），页面从来没被真的求值过一遍，
 * 所以「`await` 之后先用到下面才声明的 `const`」这种**执行顺序**错误一路漏到了用户手上。
 * 正则能扫出「有没有这行」，扫不出「这行在什么时候才初始化」。
 *
 * 这条判据补上那个洞：用**真 ESM**（`data:` URL + 相对 specifier 改写成 `file://`，Node 原生求值，
 * 不是我手写的打包器）把 `web/pages/sync.js` 的整张依赖图加载起来，把 `renderSync()` 跑完，
 * 断言页面画出来了、不带 ReferenceError / TDZ。
 *
 * 为什么不能只靠正则、也不能只靠静态检查：
 *   - 静态分析看不出 `paintAll() → paintTop() → isRunning()` 这条调用链；
 *   - 换序 / 挪声明这类修法，只有真跑一遍才算数。
 *
 * 不需要 Chrome、不起服务、不碰代理、零依赖。
 *
 * 另外还有一条「日志门」：跑完会起一个**子进程重跑本文件**、抓真实的 stdout/stderr，
 * 断言整段输出里没有 `data:` URL 的长 base64 串（见最后的 ⑨）。这堆东西以前每跑一次
 * `npm test` 就滚 80 行乱码，等于把判据废掉 —— 所以它自己也必须是一条判据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const WEB = path.join(ROOT, 'web');
const ENTRY = path.join(WEB, 'pages', 'sync.js');

/* 子进程模式：只在子进程里做一次性探针。
 * FP_SPI_DUMP=1 时把它抓到的终端文本里「长串 / 堆栈帧」两件事数出来打一行 —— 这是父进程
 * 「⑨-a 眼睛自证」的素材：先证明父进程这双眼睛**看得见**泄漏，⑨-b 的 0 才有意义。 */
const IN_CHILD = process.env.FP_SPI_PROBE === '1';
const DUMP = process.env.FP_SPI_DUMP === '1';

/* 报错时只留「文件:行:列」+ 消息，不要把整份 base64 data: URL 的调用栈倒进日志 */
const brief = (e) => {
  if (!e) return '';
  const at = String(e.stack || '').split('\n')
    .filter((l) => /^\s+at /.test(l) && !/base64/.test(l))
    .slice(0, 3)
    .map((l) => l.trim().replace(/\(?data:[^)]*\)?/g, '').trim());
  return `${e.name}: ${e.message}${at.length ? `  [${at.join(' | ')}]` : ''}`;
};

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  const line = `${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`;
  if (cond) pass++;
  else fail++;
  emit(line);
  return !!cond;
}

/* ================================================================== */
/* 一、最小 DOM 桩（挂在真 globalThis 上，模块才会看见）                */
/* ================================================================== */

class El {
  constructor(tag = 'div', text = '') {
    this.tagName = String(tag).toUpperCase();
    this.nodeName = this.tagName;
    this.children = [];
    this.childNodes = this.children;
    this.attrs = {};
    this.style = {};
    this.dataset = {};
    this.listeners = {};
    this._text = text;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.className = '';
    this.parentNode = null;
    const set = new Set();
    this.classList = {
      add: (...xs) => xs.forEach((x) => set.add(x)),
      remove: (...xs) => xs.forEach((x) => set.delete(x)),
      toggle: (x, force) => {
        const on = force === undefined ? !set.has(x) : !!force;
        if (on) set.add(x); else set.delete(x);
        return on;
      },
      contains: (x) => set.has(x),
    };
  }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this._text || this.children.map((c) => c.textContent || '').join(''); }
  set textContent(v) { this._text = String(v); this.children.length = 0; }
  appendChild(kid) { if (kid) { kid.parentNode = this; this.children.push(kid); } return kid; }
  append(...kids) { for (const k of kids) this.appendChild(k); return this; }
  insertBefore(kid) { return this.appendChild(kid); }
  replaceChildren(...kids) { this.children.length = 0; for (const k of kids) this.appendChild(k); }
  removeChild(kid) { const i = this.children.indexOf(kid); if (i >= 0) this.children.splice(i, 1); return kid; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  toggleAttribute(k, force) {
    const on = force === undefined ? !(k in this.attrs) : !!force;
    if (on) this.attrs[k] = ''; else delete this.attrs[k];
    return on;
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((x) => x !== fn); }
  dispatch(type, ev = {}) {
    const e = { target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...ev };
    for (const fn of this.listeners[type] || []) fn(e);
    return e;
  }
  focus() {}
  select() {}
  click() { this.dispatch('click'); }
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; }
  /** 递归取全部文本：判据里查页面内容用 */
  allText() {
    const out = [];
    const walk = (n) => { if (n._text) out.push(n._text); for (const c of n.children) walk(c); };
    walk(this);
    return out.join(' ');
  }
}

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

const byId = new Map();
const g = globalThis;

g.document = {
  body: new El('body'),
  documentElement: new El('html'),
  head: new El('head'),
  getElementById(id) {
    if (!byId.has(id)) byId.set(id, new El('div'));
    return byId.get(id);
  },
  createElement: (tag) => new El(tag),
  createTextNode: (t) => { const n = new El('#text', String(t)); n.nodeName = '#text'; return n; },
  createDocumentFragment: () => new El('#fragment'),
  createEvent: () => ({ initEvent() {} }),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};
/* `web/ui.js` 第 35 行判 `k instanceof Node`：桩必须挂成真构造器，否则每个子节点都退化成 toString */
g.Node = El;
g.HTMLElement = El;
g.Element = El;
g.Event = class { constructor(type, init = {}) { Object.assign(this, init); this.type = type; } };
g.CustomEvent = g.Event;
g.location = {
  origin: 'http://127.0.0.1:59999',
  href: 'http://127.0.0.1:59999/#/sync',
  hash: '#/sync',
  protocol: 'http:',
  host: '127.0.0.1:59999',
  search: '',
};
g.localStorage = makeStorage();
g.sessionStorage = makeStorage();
/* 浏览器里 `window === globalThis`：页面里 `window.addEventListener(...)` 这类调用要能落到桩上 */
g.window = g;
g.self = g;
g.history = { pushState() {}, replaceState() {}, back() {} };
g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
g.requestAnimationFrame = (fn) => setTimeout(fn, 0);
g.cancelAnimationFrame = (id) => clearTimeout(id);
g.addEventListener = () => {};
g.removeEventListener = () => {};
g.alert = () => {};
g.confirm = () => true;
/* 判据里**不联网**：所有 API 一律失败 → 页面走「空数据」分支（和用户没开任何环境时的样子一致） */
g.fetch = async () => { throw new Error('判据里不联网'); };

/* ================================================================== */
/* 日志必须干净：把 console 收进 buffer，末尾一起断言                     */
/*                                                                    */
/* 起因：`web/api.js:53` 每个失败请求都 `console.warn('[fp] 请求失败', path, e)`，*/
/* Node 会把 Error 连同栈一起打印，栈帧里带着本页的 `data:text/javascript;base64,…` */
/* —— 一次页面渲染 5 个失败请求 × 80 行 base64 = 刷屏。以前这些只是漏到 stderr， */
/* 每次 `npm test` 都滚一遍，没人会去看。这里把 console 接管掉，并把它变成判据。 */
/* ================================================================== */
const consoleBuf = [];
let consoleCaptured = 0;
const realWarn = console.warn;
const realError = console.error;
const realLog = console.log;
const fmtArg = (a) => {
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
};
/* 捕获计数单独存 `consoleCaptured`：父进程会 `report.push = …` 架空报告数组，
 * 不能拿 `consoleBuf.length` 当「接住了几条」的证据。 */
console.warn = (...args) => {
  consoleCaptured++;
  if (!IN_CHILD) consoleBuf.push({ level: 'warn', text: args.map(fmtArg).join(' ') });
};
console.error = (...args) => {
  consoleCaptured++;
  if (!IN_CHILD) consoleBuf.push({ level: 'error', text: args.map(fmtArg).join(' ') });
};
/* 子进程模式下**故意**把真 warn 放出去：这样父进程就能直接看到那条 warn 的真实形状（⑩）。 */
const WARN_PROBE = IN_CHILD && process.env.FP_SPI_WARN === '1';
if (WARN_PROBE) console.warn = realWarn;
/* 子进程一律不跑「日志门」（⑨）—— 否则子进程再起子进程，无限套娃；
 * 因此子进程的 pass/fail 只统计它就有的那些条目，这里单独算。 */
const GATE_ON = !IN_CHILD;
/* 判据自己的 PASS/FAIL 走 emit()：既打终端、也在 report 里留一份 */
const report = [];
const emit = (line) => { report.push(line); if (!IN_CHILD) realLog(line); };

/* 子进程模式：判据行不往外写，父进程要的只是「有没有泄漏」 */
if (IN_CHILD) report.push = (line) => { void line; return report.length; };
/* 自证素材：子进程把「它这趟接住了几条 console」单独打一行（只打计数，不打内容）。
 * 必须**直接写 stdout**：`realLog` 在 emit 里是被 report.push 架空的，打不出来。
 * 注意这行在 WARN_PROBE 下要排在真 warn 之前写出去 —— 见 ⑨-a 的注释。 */
if (DUMP) {
  process.on('exit', () => {
    process.stdout.write(`[fp-spi-dump] 捕获 ${consoleCaptured} 条\n`);
  });
}
/* ⑨-c 的自证素材：故意往终端漏一段长串（只有父进程用 FP_SPI_DUMP_LEAK=1 拉起时才会跑）。
 * 同样直接写 stderr —— 此时 console.error 正被接管着。 */
if (IN_CHILD && process.env.FP_SPI_DUMP_LEAK === '1') {
  process.on('exit', () => process.stderr.write('base64,' + 'A'.repeat(120) + '\n'));
}

/* ================================================================== */
/* 二、真 ESM 加载：data: URL + 相对 specifier 改写成 file://            */
/*                                                                    */
/* 不用自己写打包器（写过一个，TDZ / 循环依赖 / export 分类处处是坑，   */
/* 而且打包器自己有 bug 时判据会「假绿」—— 那正是漏掉这次的根因）。      */
/* Node 原生 ESM 求值与浏览器同一套规范，`const` 的 TDZ 一模一样。       */
/* ================================================================== */

const toFileUrl = (p) => 'file:///' + path.resolve(p).replace(/\\/g, '/');

async function loadFresh(file) {
  const src = fs.readFileSync(file, 'utf8')
    .replace(/(\bfrom\s*['"]|\bimport\s*['"])(\.{1,2}\/[^'"]+)(['"])/g,
      (m, a, spec, q) => a + toFileUrl(path.join(path.dirname(file), spec)) + q);
  // 每次带不同的 fragment，绕开模块缓存（同一条判据里要重复求值）
  const url = 'data:text/javascript;base64,' + Buffer.from(src).toString('base64') + '#v' + Math.random();
  return import(url);
}

/* ① 先钉「真 ESM 会抓到 TDZ」这件事本身：否则下面的绿没有意义。
 * 探针必须是**确定会抛**的形状：模块求值过程中（`const` 还没执行到）同步读它。
 * 不要用 `await` 版的探针 —— 微任务续体什么时候跑取决于引擎排期，测出来不稳定。 */
{
  const dir = path.join(ROOT, '.tmp', 'tdz-probe');
  fs.mkdirSync(dir, { recursive: true });
  const w = (n, s) => fs.writeFileSync(path.join(dir, n), s);
  w('probe.mjs', [
    'let captured = null;',
    'try { paint(); } catch (e) { captured = e; }',
    'function paint() { return isRunning(); }',
    'const isRunning = () => true;',
    'export const result = captured;',
  ].join('\n'));
  let err5 = null;
  let probeRes = null;
  try { probeRes = (await loadFresh(path.join(dir, 'probe.mjs'))).result; } catch (e) { err5 = e; }
  const tdzed = (!!err5 && err5 instanceof ReferenceError && /before initialization/.test(err5.message))
    || (probeRes instanceof ReferenceError && /before initialization/.test(probeRes.message));
  check('① 真 ESM 能抓到 TDZ（const 声明前被读）', tdzed,
    err5 ? `${err5.name}: ${err5.message}` : (probeRes ? `${probeRes.name}: ${probeRes.message}` : '没抛'));
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ② 真页面：整张依赖图加载 + renderSync() 跑完 */
let ns = null;
let loadErr = null;
try { ns = await loadFresh(ENTRY); } catch (e) { loadErr = e; }
check('②「窗口同步」页整张依赖图能加载（import 全部解析、顶层能求值）', !loadErr,
  loadErr ? `${loadErr.name}: ${loadErr.message}` : '');

const renderSync = ns && typeof ns.default === 'function' ? ns.default : null;
check('③ 页面导出 renderSync', !!renderSync);

let renderErr = null;
if (renderSync) {
  try {
    await renderSync({
      head: g.document.getElementById('page-head'),
      page: g.document.getElementById('page'),
      params: {},
      navigate() {},
    });
  } catch (e) { renderErr = e; }
}
check('④ renderSync() 跑完不抛', !!renderSync && !renderErr,
  renderErr ? brief(renderErr) : (renderSync ? '' : '没拿到 renderSync，等于没跑'));
check('⑤ 不是 TDZ 错（ReferenceError / Cannot access … before initialization）',
  !!renderSync && (!renderErr || !(renderErr instanceof ReferenceError || /before initialization/.test(String(renderErr.message || '')))),
  renderErr ? String(renderErr.message) : (renderSync ? '—' : '没跑，不算通过'));

/* ⑥ 页面真画了出来：标题「窗口同步」+ 正常空态（判据里 fetch 全失败 → 空数据），不是「出错了」 */
const pageText = g.document.getElementById('page').allText().replace(/\s+/g, ' ');
const headText = g.document.getElementById('page-head').allText().replace(/\s+/g, ' ');
check('⑥ 页面画出来了（标题 + 正常空态，不是「出错了」）',
  headText.includes('窗口同步') && pageText.includes('暂无已打开的浏览器环境') && !pageText.includes('页面加载失败'),
  `head="${headText.slice(0, 30)}" page="${pageText.slice(0, 100)}"`);

/* ⑦ 同一个页面**再进一次**也得能画（切页回来不是首发，`state` 是模块级的） */
let againErr = null;
g.document.getElementById('page').textContent = '';
if (renderSync) {
  try {
    await renderSync({
      head: g.document.getElementById('page-head'),
      page: g.document.getElementById('page'),
      params: {},
      navigate() {},
    });
  } catch (e) { againErr = e; }
}
const pageText2 = g.document.getElementById('page').allText().replace(/\s+/g, ' ');
check('⑦ 重复进入页面（清空重画）同样正常',
  !!renderSync && !againErr && pageText2.includes('暂无已打开的浏览器环境'),
  againErr ? brief(againErr) : (renderSync ? `page="${pageText2.slice(0, 80)}"` : '没跑'));

/* ⑧ 页面 console 里说的话不含 data: URL 长串（这把 console 接管确实兜住了） */
const leakRe = /base64,[A-Za-z0-9+/=]{80,}/;
const leakInConsole = consoleBuf.filter((c) => leakRe.test(c.text));
check('⑧ 页面发出的 console 全部干净（被接管、无非预期刷屏）',
  leakInConsole.length === 0,
  `console 捕获 ${consoleBuf.length} 条，其中脏的 ${leakInConsole.length} 条`);

/* ⑨ 日志门（真读终端）：起子进程**重跑本文件**，抓它真实的 stdout+stderr。
 *    为什么不能只查当前进程的 console：即使这里接了 console，`web/api.js` 里 `console.warn(...)`
 *    或别处 `process.stderr.write` 照样能漏到终端上；只有抓真进程输出才兜得住。
 *    另有两道自证，防「这条门是假的」：
 *      - ⑨-a：子进程得报出「它接住了几条 console」，且接收与泄漏正则两件事都验过（否则 0 处等于没在数）；
 *      - ⑨-c：真往终端漏一段长串（子进程收到 FP_SPI_DUMP_LEAK 就把它打到 stderr），父进程必须数得到。
 *
 *    注：自证子进程**必须**用 `FP_SPI_WARN=1` 拉起。不开的话，`web/api.js` 的 warn 被接管后
 *    什么都不往外写，父进程永远数不到「泄漏」—— ⑨-a 就会假红（这条判据第一版就是这么红的）。 */
if (GATE_ON) {
  const runChild = (extraEnv = {}) => spawnSync(process.execPath, ['--no-warnings', process.argv[1]], {
    cwd: ROOT,
    env: { ...process.env, FP_SPI_PROBE: '1', FP_SPI_DUMP: '0', FP_SPI_WARN: '0', ...extraEnv },
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  });
  const childOut = (r) => `${r.stdout || ''}\n${r.stderr || ''}`;
  const countLeak = (t) => (t.match(/base64,[A-Za-z0-9+/=]{80,}/g) || []).length;
  const countStack = (t) => (t.match(/^\s+at .+/gm) || []).length;
  /* 子进程打出来的 api.js 请求失败日志：「`[fp] 请求失败 <path> `」后面跟的余下部分 */
  const warnTails = (t) => (t.match(/\[fp\] 请求失败 [^\n]*/g) || []);
  const DUMP_RE = /\[fp-spi-dump\] 捕获 (\d+) 条/;
  /* 剥掉 PowerShell 5.1 对「原生命令 stderr」的包装，免得带尖括号的行把正则打断：
   *   `node : [fp-spi-dump] 捕获 <10> 条` + `<字符串>:1 字符: 1` + `+ ...` + `+ CategoryInfo ...` */
  const unwrap = (t) => (t || '')
    .split('\n')
    .filter((l) => !/^\s*(\+ |CategoryInfo\s*:|FullyQualifiedErrorId\s*:|所在位置 行)/.test(l))
    .join('\n')
    .replace(/<\d+>,<字符串>/g, '');
  const leakNeedle = 'base64,' + 'A'.repeat(120);

  /* 干净那趟：报告头 + 日志门，证明「真读终端」是 0 处 */
  const clean = runChild();
  const cleanText = childOut(clean);
  const cleanLeak = countLeak(cleanText);

  /* 自证那趟：接住 console（不开 FP_SPI_WARN），让子进程报出「它接住了几条」。
   * 注意：这两件事不能同一趟做 —— 开了 FP_SPI_WARN 就等于把接收函数换掉，计数必然是 0。 */
  const probe = runChild({ FP_SPI_DUMP: '1' });
  const probeText = unwrap(childOut(probe));
  const probeDump = probeText.match(DUMP_RE);

  /* ⑩ 那趟：真 warn 放出去，父进程看 warn 的真实形状 */
  const shape = runChild({ FP_SPI_WARN: '1' });
  const shapeText = childOut(shape);

  /* ⑨-c 那趟：故意往终端的 stderr 漏一段长串 */
  const leaky = runChild({ FP_SPI_DUMP_LEAK: '1' });
  const leakyLeak = countLeak(childOut(leaky));

  /* ⑨-a 的两件事：接住了 console（计数 > 0），且泄漏正则对一段已知长串数得回去（不空跑） */
  const probeSees = countLeak(`x ${leakNeedle} y`);
  check('⑨-a 探针自证：子进程确实接住了 console，且泄漏正则数得回去（这双眼睛不是瞎的）',
    probe.status === 0 && !!probeDump && Number(probeDump[1]) > 0 && probeSees === 1,
    `探针子进程 status=${probe.status}，${probeDump ? probeDump[0].replace('[fp-spi-dump] ', '') : '没拿到 dump'}`
    + `，注入长串数得 ${probeSees} 处`);
  check('⑨-b 正常跑：子进程 stdout+stderr 里 data: URL 长串 0 处（真读终端，不是查 buffer）',
    cleanLeak === 0 && clean.status === 0,
    `子进程 status=${clean.status}，输出 ${cleanText.split('\n').length} 行，长串 ${cleanLeak} 处`);
  check('⑨-c 探针自证：真往终端漏一段长串时，父进程数得到（否则 ⑨-b 的 0 不算数）',
    leakyLeak > 0,
    `探针子进程 status=${leaky.status}，数得 ${leakyLeak} 处`);

  /* ⑩ 那条 warn 的**形状**：网络失败时 `[fp] 请求失败 <path> {…}` 后面不许挂 Error 对象 / 堆栈。
   *    素材是真 warn 放出去的子进程，断言形状、不断言文案：
   *    - `{ name: 'Error', message: '…' }` 是白的：name/message 都是字符串字面量；
   *    - `{ name: 'Error', message: Error: … }` 或 `Error: …\n    at …` 是黑的：那是把 Error 整个丢进去了。 */
  const stackLines = countStack(shapeText);
  const warnLines = warnTails(shapeText);
  const warnBad = warnLines.filter((l) => /message:\s*Error\b/.test(l) || /^\s+at\s/.test(l));
  const shapeLeak = countLeak(shapeText);
  check('⑩ 网络失败的 console.warn 只带白名单字段（不挂 Error / 堆栈）',
    warnLines.length > 0 && stackLines === 0 && warnBad.length === 0 && shapeLeak === 0,
    `warn ${warnLines.length} 条、堆栈帧 ${stackLines} 行、形状不合格 ${warnBad.length} 条、长串 ${shapeLeak} 处`);
}

emit(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
