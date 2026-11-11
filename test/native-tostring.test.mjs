/**
 * P9-C 残留：注入函数会被 `Function.prototype.toString.call(fn)` 读到真源码。
 *
 * 为什么单开一份：`test/media-devices.test.mjs` 里的 `toJSONNative` 只测 `String(fn)`，
 * 覆盖不到 `Function.prototype.toString.call(fn)` —— 那条断言通过≠没泄漏（逆向 P9-C 裁判指出）。
 *
 * 判据是**集合相等**，不是计数：删一个入口、或入口改成泄漏别的东西，计数都会骗人。
 * 泄漏集合变了就逐个重推列表，别只改数字。
 *
 * 跑法：npm run test:native-tostring   （真 Chrome，约 20 秒）
 * 现在 9 个入口全泄漏（= 已知限制 README 第 35 条）。把 hc 挪到 CDP 层后这里应主动变红，
 * 同一个 commit 里把 EXPECTED 改成 8 并写清原因。
 */
import { withProbe, makeChecker, finish } from './helpers/profile-probe.mjs';

/** 已知会泄漏的入口（`Function.prototype.toString.call` 返回真源码而非 [native code]） */
const EXPECTED_LEAKS = [
  'enumerateDevices',
  'toJSON',
  'hardwareConcurrency',
  'toDataURL',
  'getImageData',
  'getBoundingClientRect',
  'getParameter',
  'getChannelData',
  'getVoices',
];

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
  return out;
})()`;

const { check, results } = makeChecker();

await withProbe(async ({ evalIn, nav, URL_A }) => {
  await nav(URL_A);
  const r = await evalIn(PROBE);
  if (!r || r.error) { check('探针执行', false, JSON.stringify(r)); return; }

  check('对照：宿主原生函数是 [native code]（探针自身没坏）', r.__control?.native === true, String(r.__control?.head).slice(0, 60));

  const names = Object.keys(r).filter((k) => k !== '__control');
  const missing = names.filter((k) => r[k].missing);
  check(`9 个入口都还在（缺了说明原型被换过）`, missing.length === 0, missing.join(',') || 'ok');

  const leaked = names.filter((k) => !r[k].missing && !r[k].native).sort();
  const expected = [...EXPECTED_LEAKS].sort();
  check('泄漏集合与已知限制完全相等（不是计数相等）',
    leaked.length === expected.length && leaked.every((n, i) => n === expected[i]),
    `actual=[${leaked.join(',')}] expected=[${expected.join(',')}]`);

  for (const k of names.sort()) {
    console.log(`  ${k.padEnd(22)} ${r[k].missing ? 'missing' : (r[k].native ? 'native' : 'LEAK  ' + r[k].head)}`);
  }

  if (leaked.length !== expected.length || leaked.some((n, i) => n !== expected[i])) {
    console.log('\n泄漏集合变了 → 逐个重推列表，别只改数字。');
  }
});

finish(results);
