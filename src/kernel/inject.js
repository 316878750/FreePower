/**
 * 指纹注入脚本（CDP: Page.addScriptToEvaluateOnNewDocument）
 *
 * 定位：P0 只做「JS 层能做得干净」的部分，且默认不造假 GPU 行为。
 * 每一条 patch 都记在 window.__fpApplied（不可枚举）里，自检页（P1）据此比对「声明值 vs 实际值」。
 */

export function buildInjectionSource(fp, { debug = false } = {}) {
  const cfg = {
    seed: fp.seed,
    platform: fp.platform,
    language: fp.language,
    hardwareConcurrency: fp.hardware_concurrency,
    deviceMemory: fp.device_memory,
    webgl: fp.webgl,
    canvas: fp.canvas,
    audio: fp.audio,
  };
  const json = JSON.stringify(cfg);
  const debugFlag = debug ? 'true' : 'false';

  return `(() => {
  'use strict';
  if (window.__fpInstalled) return;
  const CFG = ${json};
  const DEBUG = ${debugFlag};

  // 种子化 PRNG（同种子同序列，保证 canvas/audio 每次启动一致）
  const seedStr = String(CFG.seed || 'freepower');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const BASE = h || 1;
  let _s = BASE;
  function rnd() {
    _s ^= _s << 13; _s >>>= 0;
    _s ^= _s >>> 17;
    _s ^= _s << 5; _s >>>= 0;
    return _s / 4294967296;
  }
  // 每次取噪声前重置序列：同一页面里连取两次必须得到同一结果，
  // 否则「同一次加载两次读 canvas 不一样」本身就是检测点。
  function resetRng() { _s = BASE; }

  const applied = [];
  function native(fn, name) {
    try {
      Object.defineProperty(fn, 'name', { value: name, configurable: true });
      Object.defineProperty(fn, 'toString', {
        value: function toString() { return 'function ' + name + '() { [native code] }'; },
        configurable: true, writable: true,
      });
    } catch (e) {}
    return fn;
  }
  function def(obj, prop, value) {
    try {
      Object.defineProperty(obj, prop, { get: native(function () { return value; }, 'get ' + prop), configurable: true, enumerable: true });
      applied.push(prop);
    } catch (e) {}
  }
  function defMethod(obj, prop, fn) {
    try { Object.defineProperty(obj, prop, { value: fn, configurable: true, writable: true }); } catch (e) {}
  }

  /* ---------- Navigator ---------- */
  if (CFG.platform) def(Navigator.prototype, 'platform', CFG.platform);
  if (CFG.hardwareConcurrency) def(Navigator.prototype, 'hardwareConcurrency', CFG.hardwareConcurrency);
  if (CFG.deviceMemory) def(Navigator.prototype, 'deviceMemory', CFG.deviceMemory);
  if (CFG.language && CFG.language.length) {
    def(Navigator.prototype, 'language', CFG.language[0]);
    def(Navigator.prototype, 'languages', Object.freeze(CFG.language.slice()));
  }
  try { delete Navigator.prototype.webdriver; } catch (e) {}
  try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined, configurable: true }); } catch (e) {}
  def(Navigator.prototype, 'vendor', 'Google Inc.');

  /* ---------- Canvas：种子化确定性噪声 ---------- */
  const strength = (CFG.canvas && CFG.canvas.strength) || 1;
  function noisyCopy(imgData) {
    resetRng();
    const d = imgData.data;
    // 只扰动约 1/1200 的像素、幅度 ±1，肉眼看不出，但哈希每次一致
    const step = 1200;
    let i = Math.floor(rnd() * step);
    for (; i < d.length; i += 4 * step) {
      const delta = rnd() < 0.5 ? -1 : 1;
      d[i] = Math.max(0, Math.min(255, d[i] + delta * strength));
      if (d[i + 1] !== undefined && rnd() < 0.5) d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + delta * strength));
    }
    return imgData;
  }

  try {
    const ctxProto = CanvasRenderingContext2D.prototype;
    const origGet = ctxProto.getImageData;
    defMethod(ctxProto, 'getImageData', native(function getImageData() {
      const r = origGet.apply(this, arguments);
      try { return noisyCopy(r); } catch (e) { return r; }
    }, 'getImageData'));

    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    defMethod(HTMLCanvasElement.prototype, 'toDataURL', native(function toDataURL() {
      let src = this;
      try {
        const c = document.createElement('canvas');
        c.width = this.width; c.height = this.height;
        const cx = c.getContext('2d');
        cx.drawImage(this, 0, 0);
        // 用原始 getImageData，避免和上面的噪声叠加两次
        cx.putImageData(noisyCopy(origGet.call(cx, 0, 0, c.width, c.height)), 0, 0);
        src = c;
      } catch (e) {}
      return origToDataURL.apply(src, arguments);
    }, 'toDataURL'));

    if (HTMLCanvasElement.prototype.toBlob) {
      const origToBlob = HTMLCanvasElement.prototype.toBlob;
      defMethod(HTMLCanvasElement.prototype, 'toBlob', native(function toBlob() {
        const args = Array.prototype.slice.call(arguments);
        let src = this;
        try {
          const c = document.createElement('canvas');
          c.width = this.width; c.height = this.height;
          const cx = c.getContext('2d');
          cx.drawImage(this, 0, 0);
          cx.putImageData(noisyCopy(origGet.call(cx, 0, 0, c.width, c.height)), 0, 0);
          src = c;
        } catch (e) {}
        return origToBlob.apply(src, args);
      }, 'toBlob'));
    }
    applied.push('canvas');
  } catch (e) {}

  /* ---------- WebGL：只改 unmasked 标识，不动扩展/精度/行为 ---------- */
  if (CFG.webgl) {
    const patchGL = (proto) => {
      if (!proto) return;
      const orig = proto.getParameter;
      defMethod(proto, 'getParameter', native(function getParameter(p) {
        if (p === 37445) return CFG.webgl.vendor;
        if (p === 37446) return CFG.webgl.renderer;
        return orig.apply(this, arguments);
      }, 'getParameter'));
    };
    try { patchGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype); } catch (e) {}
    try { patchGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype); } catch (e) {}
    applied.push('webgl');
  }

  /* ---------- Audio：种子化确定性噪声 ---------- */
  if (CFG.audio && window.AudioBuffer) {
    try {
      const orig = AudioBuffer.prototype.getChannelData;
      defMethod(AudioBuffer.prototype, 'getChannelData', native(function getChannelData() {
        const arr = orig.apply(this, arguments);
        resetRng();
        for (let i = 0; i < arr.length; i += 1000) {
          arr[i] = arr[i] + (rnd() - 0.5) * 1e-7;
        }
        return arr;
      }, 'getChannelData'));
      applied.push('audio');
    } catch (e) {}
  }

  /* ---------- 诊断：自检页要读「实际生效了哪些 patch」 ---------- */
  try {
    Object.defineProperty(window, '__fpApplied', { value: applied, enumerable: false, configurable: false });
    Object.defineProperty(window, '__fpSeed', { value: String(CFG.seed), enumerable: false, configurable: false });
    if (DEBUG) Object.defineProperty(window, '__fpConfig', { value: CFG, enumerable: false, configurable: false });
  } catch (e) {}
  window.__fpInstalled = true;
})();`;
}
