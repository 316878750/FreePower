/**
 * 指纹注入脚本（CDP: Page.addScriptToEvaluateOnNewDocument）
 *
 * 原则：**先自洽，再伪装**。能做到原生行为的地方用 CDP（UA / UA-CH / 时区 / 地理 / 屏幕），
 * JS 层只补 CDP 没有的那几项（硬件、媒体设备、canvas/audio/webgl_image/client_rects 噪声）。
 *
 * 每条 patch 都记在 window.__fpApplied（不可枚举），自检页据此判断「声明已生效」。
 * 四个噪点维度用各自的入库种子：canvas_id / webgl_image_id / audio_id / client_rects_id，
 * 同一种子跨重启、跨页面加载结果一致 —— 这是不被判「换设备」的前提。
 */

export function buildInjectionSource(fp, { debug = false } = {}) {
  const cfg = {
    seed: String(fp.seed ?? 'freepower'),
    platform: fp.platform || null,
    language: Array.isArray(fp.language) ? fp.language.slice() : null,
    hardwareConcurrency: fp.hardware_concurrency ?? null,
    deviceMemory: fp.device_memory ?? null,
    webgl: fp.webgl || null,
    canvas: fp.canvas || null,
    webgl_image: fp.webgl_image || null,
    audio: fp.audio || null,
    client_rects: fp.client_rects || null,
    media: fp.media || null,
    fonts: Array.isArray(fp.fonts) ? fp.fonts.slice() : null,
  };
  const json = JSON.stringify(cfg);
  const debugFlag = debug ? 'true' : 'false';

  return `(() => {
  'use strict';
  if (window.__fpInstalled) return;
  const CFG = ${json};
  const DEBUG = ${debugFlag};
  const applied = [];
  const mark = (name) => { if (!applied.includes(name)) applied.push(name); };

  /* ---------- 确定性 PRNG：同一个 seed 永远同一个序列 ---------- */
  function fnv(str) {
    let h = 2166136261 >>> 0;
    const s = String(str);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function makeRng(seedStr) {
    let s = fnv(seedStr) || 1;
    return function rnd() {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }
  function clampByte(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

  /* ---------- 伪装成原生函数（浅层，深层的 toString.call 仍可识别） ---------- */
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
  function defGetter(obj, prop, value, name) {
    try {
      Object.defineProperty(obj, prop, {
        get: native(function () { return value; }, name || ('get ' + prop)),
        configurable: true, enumerable: true,
      });
      mark(prop);
    } catch (e) {}
  }
  function defMethod(obj, prop, fn) {
    try { Object.defineProperty(obj, prop, { value: fn, configurable: true, writable: true }); } catch (e) {}
  }

  /* ---------- Navigator：只补 CDP 覆盖不到的 ---------- */
  // platform 由 Emulation.setUserAgentOverride 原生覆盖；CDP 没生效时才兜底（少一层 JS 痕迹）
  if (CFG.platform && navigator.platform !== CFG.platform) defGetter(Navigator.prototype, 'platform', CFG.platform);

  if (typeof CFG.hardwareConcurrency === 'number' && navigator.hardwareConcurrency !== CFG.hardwareConcurrency) {
    defGetter(Navigator.prototype, 'hardwareConcurrency', CFG.hardwareConcurrency);
  }
  if (typeof CFG.deviceMemory === 'number' && navigator.deviceMemory !== CFG.deviceMemory) {
    defGetter(Navigator.prototype, 'deviceMemory', CFG.deviceMemory);
  }
  if (CFG.language && CFG.language.length) {
    const lang0 = CFG.language[0];
    const langs = Object.freeze(CFG.language.slice());
    if (navigator.language !== lang0) defGetter(Navigator.prototype, 'language', lang0);
    const nativeLangs = navigator.languages ? Array.prototype.join.call(navigator.languages, ',') : '';
    if (nativeLangs !== CFG.language.join(',')) {
      defGetter(Navigator.prototype, 'languages', langs);
    }
  }
  // --disable-blink-features=AutomationControlled 已让原生 webdriver=false；只有兜底失败才改，别主动造痕迹
  try { if (navigator.webdriver) defGetter(Navigator.prototype, 'webdriver', false); } catch (e) {}
  try { if (navigator.vendor !== 'Google Inc.') defGetter(Navigator.prototype, 'vendor', 'Google Inc.'); } catch (e) {}

  /* ---------- Canvas 2D：确定性像素噪声 ---------- */
  const origGetImageData2d = CanvasRenderingContext2D.prototype.getImageData;
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  const canvasKind = new WeakMap();
  const origGetContext = HTMLCanvasElement.prototype.getContext;

  function noiseImageData(img, seedStr, strength) {
    const d = img.data;
    const rnd = makeRng(seedStr + ':' + d.length);
    const step = 1200; // 约 1/1200 像素，幅度 ±strength：肉眼不可见，但哈希稳定
    for (let i = Math.floor(rnd() * step); i < d.length; i += 4 * step) {
      const delta = rnd() < 0.5 ? -1 : 1;
      d[i] = clampByte(d[i] + delta * strength);
      if (rnd() < 0.5) d[i + 1] = clampByte(d[i + 1] + delta * strength);
    }
    return img;
  }

  function seedForCanvas(canvas) {
    const kind = canvasKind.get(canvas) || '';
    if (kind.indexOf('webgl') === 0) return CFG.webgl_image || CFG.canvas || null;
    return CFG.canvas || CFG.webgl_image || null;
  }

  function noisyClone(canvas, spec) {
    const c = document.createElement('canvas');
    c.width = canvas.width; c.height = canvas.height;
    const cx = c.getContext('2d');
    cx.drawImage(canvas, 0, 0);
    const data = origGetImageData2d.call(cx, 0, 0, c.width, c.height);
    noiseImageData(data, spec.seed, spec.strength || 1);
    cx.putImageData(data, 0, 0);
    return c;
  }

  if (CFG.canvas || CFG.webgl_image) {
    // 记录 canvas 用的是哪种 context，toDataURL/toBlob 才能选对种子
    defMethod(HTMLCanvasElement.prototype, 'getContext', native(function getContext() {
      const ctx = origGetContext.apply(this, arguments);
      try { if (ctx) canvasKind.set(this, String(arguments[0])); } catch (e) {}
      return ctx;
    }, 'getContext'));
  }

  if (CFG.canvas) {
    defMethod(CanvasRenderingContext2D.prototype, 'getImageData', native(function getImageData() {
      const r = origGetImageData2d.apply(this, arguments);
      try { return noiseImageData(r, CFG.canvas.seed, CFG.canvas.strength || 1); } catch (e) { return r; }
    }, 'getImageData'));
    mark('canvas');
  }

  if (CFG.canvas || CFG.webgl_image) {
    defMethod(HTMLCanvasElement.prototype, 'toDataURL', native(function toDataURL() {
      const spec = seedForCanvas(this);
      if (!spec) return origToDataURL.apply(this, arguments);
      try { return origToDataURL.apply(noisyClone(this, spec), arguments); }
      catch (e) { return origToDataURL.apply(this, arguments); }
    }, 'toDataURL'));

    if (origToBlob) {
      defMethod(HTMLCanvasElement.prototype, 'toBlob', native(function toBlob() {
        const spec = seedForCanvas(this);
        if (!spec) return origToBlob.apply(this, arguments);
        const args = Array.prototype.slice.call(arguments);
        try { return origToBlob.apply(noisyClone(this, spec), args); }
        catch (e) { return origToBlob.apply(this, arguments); }
      }, 'toBlob'));
    }
  }

  // OffscreenCanvas：检测站常用它绕开 HTMLCanvasElement 的 patch
  if (CFG.canvas && window.OffscreenCanvas) {
    try {
      const ocProto = window.OffscreenCanvasRenderingContext2D && OffscreenCanvasRenderingContext2D.prototype;
      const origOcGet = ocProto && ocProto.getImageData;
      if (origOcGet) {
        defMethod(ocProto, 'getImageData', native(function getImageData() {
          const r = origOcGet.apply(this, arguments);
          try { return noiseImageData(r, CFG.canvas.seed, CFG.canvas.strength || 1); } catch (e) { return r; }
        }, 'getImageData'));
      }
      if (OffscreenCanvas.prototype.convertToBlob) {
        const origConvert = OffscreenCanvas.prototype.convertToBlob;
        defMethod(OffscreenCanvas.prototype, 'convertToBlob', native(function convertToBlob() {
          try {
            const c = new OffscreenCanvas(this.width, this.height);
            const cx = c.getContext('2d');
            cx.drawImage(this, 0, 0);
            const data = origOcGet.call(cx, 0, 0, c.width, c.height);
            noiseImageData(data, CFG.canvas.seed, CFG.canvas.strength || 1);
            cx.putImageData(data, 0, 0);
            return origConvert.apply(c, arguments);
          } catch (e) { return origConvert.apply(this, arguments); }
        }, 'convertToBlob'));
      }
      mark('offscreen_canvas');
    } catch (e) {}
  }

  /* ---------- WebGL：unmasked 标识 + 像素噪声（驱动行为不动，自检里标 partial） ---------- */
  function noisePixels(pixels, seedStr) {
    if (!pixels || !ArrayBuffer.isView(pixels)) return;
    const arr = pixels;
    const rnd = makeRng(seedStr + ':px:' + arr.length);
    const step = 997;
    const isByte = arr instanceof Uint8Array || arr instanceof Uint8ClampedArray;
    for (let i = Math.floor(rnd() * step); i < arr.length; i += step) {
      const delta = rnd() < 0.5 ? -1 : 1;
      if (isByte) arr[i] = clampByte(arr[i] + delta);
      else arr[i] = arr[i] + delta;
    }
  }

  const patchGL = (proto) => {
    if (!proto) return;
    const origGetParameter = proto.getParameter;
    defMethod(proto, 'getParameter', native(function getParameter(p) {
      if (CFG.webgl && p === 37445) return CFG.webgl.vendor;
      if (CFG.webgl && p === 37446) return CFG.webgl.renderer;
      return origGetParameter.apply(this, arguments);
    }, 'getParameter'));

    if (CFG.webgl_image) {
      const origReadPixels = proto.readPixels;
      defMethod(proto, 'readPixels', native(function readPixels() {
        const r = origReadPixels.apply(this, arguments);
        try { noisePixels(arguments[6], CFG.webgl_image.seed); } catch (e) {}
        return r;
      }, 'readPixels'));
    }
  };
  try { patchGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype); } catch (e) {}
  try { patchGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype); } catch (e) {}
  if (CFG.webgl) mark('webgl');
  if (CFG.webgl_image) mark('webgl_image');

  /* ---------- Audio：确定性浮点噪声（同一 buffer 只加一次，重复读结果不变） ---------- */
  if (CFG.audio && window.AudioBuffer) {
    const noised = new WeakSet();
    function noiseChannel(arr, seedStr, channel) {
      if (!arr || noised.has(arr)) return arr;
      const rnd = makeRng(seedStr + ':audio:' + channel + ':' + arr.length);
      for (let i = 0; i < arr.length; i += 1000) arr[i] = arr[i] + (rnd() - 0.5) * 1e-7;
      noised.add(arr);
      return arr;
    }
    const origGetChannelData = AudioBuffer.prototype.getChannelData;
    defMethod(AudioBuffer.prototype, 'getChannelData', native(function getChannelData() {
      const arr = origGetChannelData.apply(this, arguments);
      try { return noiseChannel(arr, CFG.audio.seed, Number(arguments[0]) || 0); } catch (e) { return arr; }
    }, 'getChannelData'));

    const origCopyFromChannel = AudioBuffer.prototype.copyFromChannel;
    if (origCopyFromChannel) {
      defMethod(AudioBuffer.prototype, 'copyFromChannel', native(function copyFromChannel(dest, channel) {
        const r = origCopyFromChannel.apply(this, arguments);
        try { noiseChannel(dest, CFG.audio.seed, Number(channel) || 0); } catch (e) {}
        return r;
      }, 'copyFromChannel'));
    }
    mark('audio');
  }

  /* ---------- ClientRects：亚像素确定性噪声（同一元素重复读一致） ---------- */
  if (CFG.client_rects && window.DOMRect) {
    const DOMRectCtor = window.DOMRect;
    function elementKey(el) {
      let idx = 0;
      try {
        const parent = el.parentElement;
        if (parent) idx = Array.prototype.indexOf.call(parent.children, el);
      } catch (e) {}
      const cls = typeof el.className === 'string' ? el.className : '';
      const text = (el.textContent || '').slice(0, 32);
      const style = (el.getAttribute && el.getAttribute('style')) || '';
      return (el.tagName || '') + '|' + cls + '|' + text + '|' + idx + '|' + style;
    }
    const rectOffset = (el) => {
      const rnd = makeRng(CFG.client_rects.seed + ':rect:' + elementKey(el));
      return { dx: (rnd() - 0.5) * 0.05, dy: (rnd() - 0.5) * 0.05 };
    };
    const origRect = Element.prototype.getBoundingClientRect;
    defMethod(Element.prototype, 'getBoundingClientRect', native(function getBoundingClientRect() {
      const r = origRect.apply(this, arguments);
      try {
        const o = rectOffset(this);
        return new DOMRectCtor(r.x + o.dx, r.y + o.dy, Math.max(0, r.width + o.dx), Math.max(0, r.height + o.dy));
      } catch (e) { return r; }
    }, 'getBoundingClientRect'));
    mark('client_rects');
  }

  /* ---------- 媒体设备：只改 enumerateDevices 的返回（getUserMedia 拦截不了，标 partial） ---------- */
  function fakeDeviceId(seedStr, kind, i) {
    let out = '';
    for (let k = 0; k < 8; k++) out += fnv(seedStr + ':' + kind + ':' + i + ':' + k).toString(16).padStart(8, '0');
    return out;
  }
  const DEVICE_LABELS = {
    audioinput: ['Microphone (Realtek(R) Audio)', 'Microphone Array (2- Conexant SmartAudio HD)', 'Line In (Realtek(R) Audio)'],
    videoinput: ['HD WebCam', 'USB Video Device', 'Integrated Camera'],
    audiooutput: ['Speakers (Realtek(R) Audio)', 'Headphones (Realtek(R) Audio)', 'Digital Audio (S/PDIF)'],
  };
  function buildFakeDevices() {
    const media = CFG.media || {};
    const counts = media.counts || {};
    const custom = Array.isArray(media.devices) ? media.devices : [];
    const out = [];
    for (const kind of ['audioinput', 'videoinput', 'audiooutput']) {
      const n = Math.max(0, Math.min(Number(counts[kind + '_num']) || 0, 9));
      const pool = custom.filter((d) => d && d.kind === kind && d.label);
      const labels = DEVICE_LABELS[kind];
      for (let i = 0; i < n; i++) {
        const label = (pool[i] && pool[i].label) || labels[i % labels.length];
        out.push({ deviceId: fakeDeviceId(CFG.seed, kind, i), groupId: fakeDeviceId(CFG.seed, 'group', 0), kind, label });
      }
    }
    return out;
  }
  function toDeviceInfo(d) {
    try {
      if (!window.MediaDeviceInfo) return d;
      const o = Object.create(MediaDeviceInfo.prototype);
      Object.defineProperties(o, {
        deviceId: { value: d.deviceId, enumerable: true },
        groupId: { value: d.groupId, enumerable: true },
        kind: { value: d.kind, enumerable: true },
        label: { value: d.label, enumerable: true },
      });
      return o;
    } catch (e) { return d; }
  }

  if (CFG.media && CFG.media.mode !== '0') {
    const fakeEnumerate = native(function enumerateDevices() {
      try { return Promise.resolve(buildFakeDevices().map(toDeviceInfo)); }
      catch (e) { return Promise.reject(e); }
    }, 'enumerateDevices');
    try {
      let mode = 'fallback';
      if (navigator.mediaDevices && window.MediaDevices && MediaDevices.prototype.enumerateDevices) {
        defMethod(MediaDevices.prototype, 'enumerateDevices', fakeEnumerate);
        mode = 'native';
      } else {
        // 非安全上下文里 navigator.mediaDevices 为空：补一个最小对象，
        // 否则页面会直接看到 undefined（比数量不对更容易被抓）。
        const fake = {
          enumerateDevices: fakeEnumerate,
          addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
        };
        defGetter(Navigator.prototype, 'mediaDevices', fake);
      }
      mark('media_devices');
      try { Object.defineProperty(window, '__fpMediaMode', { value: mode, enumerable: false, configurable: false }); } catch (e) {}
    } catch (e) {}
  }

  /* ---------- 字体：只声明，不伪造 ---------- */
  // 字体度量来自 DirectWrite，JS 改不了；这里只把「声明值」暴露给自检页，不 patch measureText。
  try {
    Object.defineProperty(window, '__fpFontsDeclared', {
      value: CFG.fonts || ['all'], enumerable: false, configurable: false,
    });
  } catch (e) {}

  /* ---------- 诊断 ---------- */
  try {
    Object.defineProperty(window, '__fpApplied', { value: applied, enumerable: false, configurable: false });
    Object.defineProperty(window, '__fpSeed', { value: CFG.seed, enumerable: false, configurable: false });
    Object.defineProperty(window, '__fpSeeds', {
      value: {
        canvas: CFG.canvas && CFG.canvas.seed || null,
        webgl_image: CFG.webgl_image && CFG.webgl_image.seed || null,
        audio: CFG.audio && CFG.audio.seed || null,
        client_rects: CFG.client_rects && CFG.client_rects.seed || null,
      },
      enumerable: false, configurable: false,
    });
    if (DEBUG) {
      Object.defineProperty(window, '__fpConfig', { value: CFG, enumerable: false, configurable: false });
      // 排查用：注入前的原生函数（自检/支持人员可比对「基础渲染」和「加噪后」）
      Object.defineProperty(window, '__fpOrig', {
        value: { toDataURL: origToDataURL, getImageData: origGetImageData2d },
        enumerable: false, configurable: false,
      });
    }
  } catch (e) {}
  window.__fpInstalled = true;
})();`;
}