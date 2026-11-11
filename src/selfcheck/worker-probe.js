/**
 * 双 Realm 探针的**共用配方**。
 *
 * 这里的东西有两个消费方，必须是同一份字节，否则「主帧和 worker 哈希一致」就成了自证：
 *   1. `probe.js` 在主帧里跑 DOM canvas 与 OffscreenCanvas 的对照
 *   2. `origin.js` 把 worker / ServiceWorker / AudioWorklet 三个脚本原样吐给浏览器
 *
 * 为什么 canvas 配方里不画文字：文字度量走字体，主帧和 worker 的字体回退链不完全一样，
 * 一旦不一致就分不清「噪声没同源」还是「字体不同」。用纯图形（渐变 + 矩形 + 圆弧）
 * 才能把变量收敛到「噪声实现是否同一份」这一件事上。
 */

/** 主帧与 worker 共用的绘制 + 哈希快照（不含 DOM 依赖的部分） */
export const REALM_RECIPE = `
function fpDraw(ctx) {
  const g = ctx.createLinearGradient(0, 0, 200, 80);
  g.addColorStop(0, '#ff0000');
  g.addColorStop(0.5, '#00ff00');
  g.addColorStop(1, '#0000ff');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 200, 80);
  ctx.fillStyle = '#123456';
  ctx.fillRect(20, 20, 60, 30);
  ctx.strokeStyle = '#abcdef';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(100, 40, 20, 0, Math.PI * 2);
  ctx.stroke();
}
function fpHashBytes(bytes) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i] & 0xff; h = Math.imul(h, 16777619) >>> 0; }
  return (h >>> 0).toString(16).padStart(8, '0');
}
function fpCanvasOffscreenHash() {
  const c = new OffscreenCanvas(200, 80);
  const x = c.getContext('2d');
  fpDraw(x);
  return fpHashBytes(x.getImageData(0, 0, 200, 80).data);
}
function fpCanvasDomHash() {
  const c = document.createElement('canvas');
  c.width = 200;
  c.height = 80;
  const x = c.getContext('2d');
  fpDraw(x);
  return fpHashBytes(x.getImageData(0, 0, 200, 80).data);
}
/** WorkerNavigator / Navigator 上「必须与主帧一致」的那几个值 */
function fpNavSnapshot() {
  return {
    realm: (typeof self !== 'undefined' && self.__fpRealm) || null,
    ua: navigator.userAgent,
    platform: navigator.platform,
    cores: navigator.hardwareConcurrency,
    memory: typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : null,
    language: navigator.language,
    languages: navigator.languages ? Array.prototype.join.call(navigator.languages, ',') : '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
function fpAppliedList() {
  try { return Array.prototype.slice.call(self.__fpApplied || []); } catch (e) { return []; }
}
`;

/**
 * 专用 worker 与 SharedWorker 共用这一个脚本：
 * 专用 worker 走 onmessage，SharedWorker 走 onconnect，两个都挂上互不影响。
 *
 * `atTop` 是本文件最重要的字段：它在**脚本第一行**读 `self.__fpRealm`。
 * 如果注入发生在脚本顶层之前，它必须是 'worker'；为 null 就说明存在「裸窗口」。
 */
export function workerScript() {
  return `${REALM_RECIPE}
const fpAtTop = (typeof self !== 'undefined' && self.__fpRealm) || null;

function fpReport() {
  return {
    ok: true,
    atTop: fpAtTop,
    applied: fpAppliedList(),
    canvas: fpCanvasOffscreenHash(),
    ...fpNavSnapshot(),
  };
}

self.onmessage = function (e) {
  const port = e && e.ports && e.ports[0];
  const data = fpReport();
  if (port) port.postMessage(data);
  else self.postMessage(data);
};
self.onconnect = function (e) { e.ports[0].postMessage(fpReport()); };
`;
}

/** ServiceWorker 脚本：只能通过 message 端口回话，没有 onmessage */
export function serviceWorkerScript() {
  return `${REALM_RECIPE}
const fpAtTop = (typeof self !== 'undefined' && self.__fpRealm) || null;

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('message', function (e) {
  const port = e.ports && e.ports[0];
  if (!port) return;
  port.postMessage({
    ok: true,
    atTop: fpAtTop,
    applied: fpAppliedList(),
    canvas: fpCanvasOffscreenHash(),
    ...fpNavSnapshot(),
  });
});
`;
}

/**
 * AudioWorklet 模块：**故意不注入**，只把「这个作用域里到底有什么」读出来，
 * 好让自检页能用实测值说明「裸的只有 sampleRate / currentTime」，
 * 而不是一句「不支持」了事。
 */
export function workletModule() {
  return `
class FpProbeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    let payload;
    try {
      payload = {
        ok: true,
        hasNavigator: typeof navigator !== 'undefined',
        hasDocument: typeof document !== 'undefined',
        hasCanvas: typeof OffscreenCanvas !== 'undefined',
        hasWorkerNavigator: typeof WorkerNavigator !== 'undefined',
        ua: (typeof navigator !== 'undefined' && navigator.userAgent) || null,
        sampleRate: typeof sampleRate === 'number' ? sampleRate : null,
        currentTime: typeof currentTime === 'number' ? currentTime : null,
        fpInjected: !!(typeof self !== 'undefined' && self.__fpRealm),
        // 这个作用域里「能当指纹用」的表面，实测就这两项
        surfaces: ['sampleRate', 'currentTime'],
      };
    } catch (e) {
      payload = { ok: false, error: String(e) };
    }
    this.done = true;
    this.port.postMessage(payload);
  }
  process() { return !this.done; }
}
registerProcessor('fp-probe', FpProbeProcessor);
`;
}