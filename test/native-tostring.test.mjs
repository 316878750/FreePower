/**
 * P11：注入函数不许把自己的源码交给页面。
 *
 * 为什么单开一份：`test/media-devices.test.mjs` 里的 `toJSONNative` 只测 `String(fn)`，
 * 覆盖不到 `Function.prototype.toString.call(fn)` —— 那条断言通过≠没泄漏（逆向 P9-C 裁判指出）。
 *
 * 判据是**集合相等**，不是计数：删一个入口、或入口改成泄漏别的东西，计数都会骗人。
 * P11 的目标是**空集**，所以 EXPECTED_LEAKS 是空数组；谁再往里加名字，等于当场承认又漏了。
 *
 * 单独一条「跨 realm」的断言（不是并进泄漏集合）：那是另一个补丁面（iframe / worker 里取一份
 * 原生 toString 再回来调），当前**仍能读到真源码**，钉死现状 = README 已知限制 35b。
 * 它哪天变绿，说明跨 realm 也堵住了，届时改文档 + 改这条断言，而不是悄悄删掉。
 *
 * 跑法：npm run test:native-tostring   （真 Chrome，约 20 秒）
 */
import { withProbe, makeChecker, finish } from './helpers/profile-probe.mjs';

/** 已知会泄漏的入口（`Function.prototype.toString.call` 返回真源码而非 [native code]） */
const EXPECTED_LEAKS = [];

const PROBE = `(() => {
  const t = (fn) => { try { return Function.prototype.toString.call(fn); } catch (e) { return 'ERR:' + e.name; } };
  const entries = {
    enumerateDevices: MediaDevices.prototype.enumerateDevices,
    toJSON: MediaDeviceInfo.prototype.toJSON,
    hardwareConcurrency: Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency')?.get,
    toDataURL: HTMLCanvasElement.prototype.toDataURL,
    getImageData: CanvasRenderingContext2D.prototype.getImageData,
    getBoundingClientRect: Element.prototype.getBoundingClientRect,
    getParameter: WebGLRenderingContext.prototype.getParameter,
    getChannelData: AudioBuffer.prototype.getChannelData,
    getVoices: SpeechSynthesis.prototype.getVoices,
  };
  const out = {};
  for (const [k, fn] of Object.entries(entries)) {
    if (typeof fn !== 'function') { out[k] = { missing: true }; continue; }
    const src = t(fn);
    out[k] = { native: /\\[native code\\]/.test(src), head: src.replace(/\\s+/g, ' ').slice(0, 60) };
  }
  // 对照：宿主原生函数必须是 [native code]，否则是探针自己坏了（会误报全泄漏）
  out.__control = { native: /\\[native code\\]/.test(t(Array.prototype.map)), head: t(Array.prototype.map) };

  // 别做过头：页面自定义的必须仍是真源码
  const foo = function foo() { return 1; };
  out.__pageDefined = { src: t(foo), isNative: /\\[native code\\]/.test(t(foo)) };

  // 跨 realm：iframe 里取一份原生 toString，再拿回来调我们的包装函数（README 35b）
  try {
    const f = document.createElement('iframe');
    f.style.display = 'none';
    document.documentElement.appendChild(f);
    const otherT = f.contentWindow.Function.prototype.toString;
    const src = otherT.call(HTMLCanvasElement.prototype.toDataURL);
    out.__crossRealm = { gotSource: !/\\[native code\\]/.test(src), head: String(src).replace(/\\s+/g, ' ').slice(0, 60) };
    f.remove();
  } catch (e) {
    out.__crossRealm = { error: String(e && e.name) };
  }
  return out;
})()`;

/**
 * worker realm 的同一套判据（用 String.raw 保住正则里的反斜杠）。
 * worker 里没有 CanvasRenderingContext2D / MediaDevices / AudioBuffer，能测的是：
 * OffscreenCanvas.getImageData / convertToBlob、WebGL.getParameter、hardwareConcurrency getter、
 * toString 自己、以及「worker 里定义的函数仍是真源码」。
 */
const WORKER_PROBE_SRC = String.raw`
const T = (fn) => { try { return Function.prototype.toString.call(fn); } catch (e) { return 'ERR:' + e.name; } };
const out = { entries: {} };
const put = (k, fn) => {
  if (typeof fn !== 'function') { out.entries[k] = { missing: true }; return; }
  const s = T(fn);
  out.entries[k] = {
    native: /\[native code\]/.test(s),
    head: s.replace(/\s+/g, ' ').slice(0, 60),
    name: String(fn.name),
    length: Number(fn.length),
    ownToString: Object.prototype.hasOwnProperty.call(fn, 'toString'),
    toStringIsProto: fn.toString === Function.prototype.toString,
  };
};
put('ocGetImageData', typeof OffscreenCanvasRenderingContext2D !== 'undefined' && OffscreenCanvasRenderingContext2D.prototype.getImageData);
put('ocConvertToBlob', typeof OffscreenCanvas !== 'undefined' && OffscreenCanvas.prototype.convertToBlob);
put('getParameter', typeof WebGLRenderingContext !== 'undefined' && WebGLRenderingContext.prototype.getParameter);
put('hardwareConcurrency', Object.getOwnPropertyDescriptor(Object.getPrototypeOf(self.navigator), 'hardwareConcurrency')?.get);
const foo = function foo() { return 1; };
out.samples = { src: T(foo), isNative: /\[native code\]/.test(T(foo)) };
out.hc = self.navigator.hardwareConcurrency;
out.toStringSelf = {
  native: /\[native code\]/.test(T(Function.prototype.toString)),
  name: Function.prototype.toString.name,
  length: Function.prototype.toString.length,
};
self.postMessage(out);
`;

const { check, results } = makeChecker();

await withProbe(async ({ evalIn, nav, URL_A }) => {
  await nav(URL_A);
  const r = await evalIn(PROBE);
  if (!r || r.error) { check('探针执行', false, JSON.stringify(r)); return; }

  check('对照：宿主原生函数是 [native code]（探针自身没坏）', r.__control?.native === true, String(r.__control?.head).slice(0, 60));

  const names = Object.keys(r).filter((k) => !k.startsWith('__'));
  const missing = names.filter((k) => r[k].missing);
  check(`9 个入口都还在（缺了说明原型被换过）`, missing.length === 0, missing.join(',') || 'ok');

  const leaked = names.filter((k) => !r[k].missing && !r[k].native).sort();
  const expected = [...EXPECTED_LEAKS].sort();
  check('泄漏集合与期望集合完全相等（P11 后应为空集）',
    leaked.length === expected.length && leaked.every((n, i) => n === expected[i]),
    `actual=[${leaked.join(',')}] expected=[${expected.join(',')}]`);

  check('别做过头：页面自己定义的函数仍是真源码', r.__pageDefined?.isNative === false,
    String(r.__pageDefined?.src).slice(0, 60));

  // 这条是**已知限制**（README 35b / 逆向 L3）：红即意味着修好了，届时改文档与这条断言
  const xr = r.__crossRealm || {};
  check('已知限制 35b：跨 realm 仍能读到我们的源码（钉死现状，修好就来改这条）',
    xr.gotSource === true, JSON.stringify({ gotSource: xr.gotSource, head: xr.head, error: xr.error }));

  for (const k of names.sort()) {
    console.log(`  ${k.padEnd(22)} ${r[k].missing ? 'missing' : (r[k].native ? 'native' : 'LEAK  ' + r[k].head)}`);
  }

  if (leaked.length !== expected.length || leaked.some((n, i) => n !== expected[i])) {
    console.log('\n泄漏集合变了 → 逐个重推列表，别只改数字。');
  }

  /* ---------- worker realm：只测主世界是不够的 ----------
   * 主世界那 9 个入口走了 CDP/原型覆盖，worker 里还有一份自己的实现（CORE 与 page 共用，
   * 但 worker 是另一个 realm、另一个 Function.prototype）。只做主世界等于给检测方留一句
   * 「去 worker 里读一遍」—— 所以这里再跑一次同一套判据。
   * 注意 worker 里没有 CanvasRenderingContext2D / MediaDevices / AudioBuffer，
   * 能测的是：OffscreenCanvas 的 getImageData / convertToBlob、WebGL getParameter、
   * hardwareConcurrency getter、toString 自己、以及「worker 里定义的函数仍是真源码」。
   */
  const w = await evalIn(`(async () => {
    const src = ${JSON.stringify(WORKER_PROBE_SRC)};
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    const r = await new Promise((res, rej) => {
      w.onmessage = (e) => res(e.data);
      w.onerror = (e) => rej(new Error('worker error'));
      setTimeout(() => rej(new Error('worker timeout')), 8000);
    });
    return { pageHc: navigator.hardwareConcurrency, ...r };
  })()`);
  if (!w || w.error) {
    check('worker realm：探针能跑', false, JSON.stringify(w));
  } else {
    const wentries = Object.entries(w.entries || {});
    const wmissing = wentries.filter(([, v]) => v.missing).map(([k]) => k);
    check('worker realm：探针入口都在（OffscreenCanvas getImageData / convertToBlob / getParameter / hc）',
      wmissing.length === 0, wmissing.join(',') || 'ok');
    const wleaks = wentries.filter(([, v]) => !v.missing && !v.native).map(([k]) => k).sort();
    check('worker realm：泄漏集合也是空集（`Function.prototype.toString.call` 全 `[native code]`）',
      wleaks.length === 0, `leaks=[${wleaks.join(',')}]`);
    const wown = wentries.filter(([, v]) => v.ownToString).map(([k]) => k);
    check('worker realm：没有 own `toString`，且 `fn.toString === Function.prototype.toString`',
      wown.length === 0 && wentries.every(([, v]) => v.missing || v.toStringIsProto === true),
      `own=[${wown.join(',')}]`);
    check('worker realm：hardwareConcurrency 与主页面一致（CDP 不传播，worker 侧要单独设）',
      String(w.hc) === String(w.pageHc), `worker=${w.hc} page=${w.pageHc}`);
    check('worker realm：worker 里定义的函数仍是真源码（别把 toString 一律改成 native）',
      w.samples?.isNative === false, String(w.samples?.src).slice(0, 60));
    check('worker realm：toString 自己是 [native code]、name/length 与宿主一致',
      w.toStringSelf?.native === true && w.toStringSelf?.name === 'toString' && w.toStringSelf?.length === 0,
      JSON.stringify(w.toStringSelf));
  }
});

finish(results);
