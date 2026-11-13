/**
 * 指纹注入脚本（CDP: Page.addScriptToEvaluateOnNewDocument / worker: Runtime.evaluate）
 *
 * 原则：**先自洽，再伪装**。能做到原生行为的地方用 CDP（UA / UA-CH / 时区 / 地理 / 屏幕），
 * JS 层只补 CDP 没有的那几项（硬件、媒体设备、canvas/audio/webgl_image/client_rects 噪声）。
 *
 * 结构（P7 起）：
 *   core    —— CFG / PRNG / 四维噪声实现 / 原生伪装工具。**只有一份**，
 *              page 层与 worker 层共用同一份字符串，改一处同时影响两侧。
 *   page    —— DOM 相关：Navigator、HTMLCanvasElement、WebGL、AudioBuffer、DOMRect、媒体设备、字体。
 *   worker  —— WorkerGlobalScope 相关：WorkerNavigator、OffscreenCanvas、WebGL（OffscreenCanvas 也有）。
 *
 * 为什么必须共用：主帧与 worker 里取到的 canvas/audio 哈希一旦不同，检测方只要让页面和 worker
 * 各算一遍再比对就穿帮。噪声算法的种子派生、步长、幅度只要有一份副本漂移，就会变成两套指纹。
 *
 * 每条 patch 都记在 `__fpApplied`（不可枚举），自检页据此判断「声明已生效」。
 * 四个噪点维度用各自的入库种子：canvas_id / webgl_image_id / audio_id / client_rects_id，
 * 同一种子跨重启、跨页面加载结果一致 —— 这是不被判「换设备」的前提。
 */

function injectionConfig(fp) {
  return {
    seed: String(fp.seed ?? 'freepower'),
    platform: fp.platform || null,
    ua: fp.ua || null,
    timezone: fp.timezone || null,
    language: Array.isArray(fp.language) ? fp.language.slice() : null,
    hardwareConcurrency: fp.hardware_concurrency ?? null,
    deviceMemory: fp.device_memory ?? null,
    webgl: fp.webgl || null,
    canvas: fp.canvas || null,
    webgl_image: fp.webgl_image || null,
    audio: fp.audio || null,
    client_rects: fp.client_rects || null,
    media: fp.media || null,
    /**
     * 语音合成：`{ enabled, voices }`。
     * enabled = 按环境 language 投影 getVoices()；voices 是可选的自定义命名池。
     */
    speech: fp.speech || null,
    fonts: Array.isArray(fp.fonts) ? fp.fonts.slice() : null,
    /**
     * 自动化受控标记（P2）：`automation_controlled === '1'` 时 `navigator.webdriver` 保持原生 true。
     * 下面那句「本该 false 却不是才补」的兜底必须让路，否则字段会被自己的兜底吃掉（静默空转）。
     */
    automationControlled: fp.automationControlled === true,
    /** P2 `do_not_track`：只有 `"true"` 才是 `'1'`（这里把 `navigator.doNotTrack` 固定成 `"1"`）。 */
    doNotTrack: fp.doNotTrack || null,
    /**
     * 屏幕尺寸 + 可用区（avail*）。CDP 的 setDeviceMetricsOverride 只能设 screen 尺寸，
     * availWidth/availHeight 会被撑成和它一样 —— 而「没有任务栏」正是 headless 的特征。
     */
    screen: fp.screen ? {
      width: fp.screen.width,
      height: fp.screen.height,
      avail_width: fp.screen.avail_width ?? fp.screen.width,
      avail_height: fp.screen.avail_height ?? (fp.screen.height - 40),
    } : null,
  };
}

/**
 * 共用核心：四维噪声 + 原生伪装工具。
 *
 * ⚠️ 这里的 canvas / webgl_image / audio / client_rects 噪声实现是**唯一一份**：
 *    主帧（page 层）和 worker（worker 层）都调用它。**此处改动会同时影响主帧与 worker**，
 *    改完必须跑 `test/unit.test.mjs` 里的「主帧与 worker 噪声同源同值」断言与冒烟双 Realm 对比。
 */
const CORE = `
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

  /* ---------- 伪装成原生函数（P11：Function.prototype.toString 也要对） ----------
   *
   * P11 前这里给每个包装函数挂了一个 own toString 属性，三条一行就能判的破绽：
   *   1) Object.prototype.hasOwnProperty.call(fn,'toString') → 原生 false，我们 true；
   *   2) fn.toString === Function.prototype.toString → 原生恒等，我们不等；
   *   3) 最关键：Function.prototype.toString.call(fn) 照样读到**真源码**
   *      （变量名、seedForCanvas、CFG 全交出去）—— 只骗了 String(fn)。
   *
   * 现在：包装函数只登记进 WeakSet，Function.prototype.toString 一次性接管；
   * 命中登记表才返回 function NAME() { [native code] }，未命中一律交回原生实现。
   * 所以页面自己定义的函数 / 箭头 / class / 内核自带的内置方法，源码逐字不变
   * —— 「别做过头」和「藏住」是同一个机制的两面，不是两套开关。
   *
   * 字面量照裸内核（157.0.8103.40）实测对齐：**括号永远空的**，形参个数只体现在 fn.length
   * （toString.call(CanvasRenderingContext2D.prototype.getImageData) 是
   *   'function getImageData() { [native code] }'，而它的 length 是 4）。
   * 补形参名会造出 'function getImageData(a, b, c, d) { [native code] }' —— 比不伪装更显眼。
   *
   * ⚠️ 已知边界（README 35b）：这个补丁只对它**所在 realm** 生效。iframe / worker 里取一份
   *   原生 Function.prototype.toString 再拿回来调用，仍能读到我们的真源码。跨 realm 无法
   *   从 JS 侧堵住（bound function 能堵，但源码会变成无名的 function () { [native code] }，
   *   与裸内核不一致，等于换一个更明显的 tell），所以按已知限制交，不在这里假装修好。
   */
  const WRAPPED = new WeakSet();
  const origFnToString = Function.prototype.toString;

  /** 原生源码字面量：'function NAME() { [native code] }'（getter 的 name 自带 'get ' 前缀） */
  function nativeSourceOf(fn) {
    let name = '';
    try { name = typeof fn.name === 'string' ? fn.name : ''; } catch (e) { name = ''; }
    return 'function ' + name + '() { [native code] }';
  }

  /**
   * 接管 Function.prototype.toString：每个 realm 各一份（page / worker 是不同的
   * Function.prototype），每个 realm 只装一次。
   *
   * 四个必须和裸内核逐项相同的点（漏一个就是新的检测点，检测器会拿 toString 自己开刀）：
   *   - toString.toString() 也要是 [native code]（把 patched 自己登记进 WRAPPED）
   *   - name === 'toString'、length === 0
   *   - descriptor writable:true, enumerable:false, configurable:true
   *   - 非函数 this 仍抛 TypeError（走原生实现，不返回字符串兜底）
   */
  function installToStringTrap() {
    try {
      const patched = function toString() {
        try { if (WRAPPED.has(this)) return nativeSourceOf(this); } catch (e) {}
        return origFnToString.apply(this, arguments);
      };
      Object.defineProperty(patched, 'name', { value: 'toString', writable: false, enumerable: false, configurable: true });
      Object.defineProperty(patched, 'length', { value: 0, writable: false, enumerable: false, configurable: true });
      WRAPPED.add(patched);
      Object.defineProperty(Function.prototype, 'toString', {
        value: patched, writable: true, enumerable: false, configurable: true,
      });
    } catch (e) {
      /* 装不上就放弃伪装（宁可泄漏，也不让页面少一个 API） */
    }
  }

  /**
   * 登记一个「我们装的」函数，并把 name / length 对齐原生。
   * @param {Function} fn 包装函数
   * @param {string} [name] 原生函数名（getter 传 'get xxx'）
   * @param {number} [length] 原生形参个数 —— **必须从裸内核量出来**，不要抄 fn.length
   *   （我们的包装函数形参个数常常是错的：getImageData 原生 4，我们写成 0 就是一行就能判的破绽）
   */
  function native(fn, name, length) {
    try { WRAPPED.add(fn); } catch (e) {}
    try {
      if (typeof name === 'string' && name && fn.name !== name) {
        Object.defineProperty(fn, 'name', { value: name, writable: false, enumerable: false, configurable: true });
      }
      if (typeof length === 'number' && fn.length !== length) {
        Object.defineProperty(fn, 'length', { value: length, writable: false, enumerable: false, configurable: true });
      }
    } catch (e) {}
    return fn;
  }
  function defGetter(obj, prop, value, name) {
    try {
      Object.defineProperty(obj, prop, {
        // getter 的 length 原生恒为 0（'get hardwareConcurrency' 也是这样）
        get: native(function () { return value; }, name || ('get ' + prop), 0),
        configurable: true, enumerable: true,
      });
      mark(prop);
    } catch (e) {}
  }
  function defMethod(obj, prop, fn) {
    try { Object.defineProperty(obj, prop, { value: fn, configurable: true, writable: true }); } catch (e) {}
  }

  // 先接管 toString，再让各层开始登记 —— 顺序不能反（反了先装的函数会有一小段裸窗口）
  installToStringTrap();

  /* ---------- 2D 像素噪声（page 的 HTMLCanvasElement 与 worker 的 OffscreenCanvas 共用） ---------- */
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

  /* ---------- WebGL 像素噪声 ---------- */
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

  /* ---------- Audio 浮点噪声（同一 buffer 只加一次，重复读结果不变） ---------- */
  const audioNoised = new WeakSet();
  function noiseChannel(arr, seedStr, channel) {
    if (!arr || audioNoised.has(arr)) return arr;
    const rnd = makeRng(seedStr + ':audio:' + channel + ':' + arr.length);
    for (let i = 0; i < arr.length; i += 1000) arr[i] = arr[i] + (rnd() - 0.5) * 1e-7;
    audioNoised.add(arr);
    return arr;
  }

  /* ---------- OffscreenCanvas：主帧与 worker 共用同一份实现（含种子） ---------- */
  const patchOffscreenCanvasNoise = () => {
    if (!CFG.canvas) return;
    try {
      if (typeof OffscreenCanvas === 'undefined') return;
      const ocProto = (typeof OffscreenCanvasRenderingContext2D !== 'undefined') && OffscreenCanvasRenderingContext2D.prototype;
      const origOcGet = ocProto && ocProto.getImageData;
      if (origOcGet) {
        defMethod(ocProto, 'getImageData', native(function getImageData() {
          const r = origOcGet.apply(this, arguments);
          try { return noiseImageData(r, CFG.canvas.seed, CFG.canvas.strength || 1); } catch (e) { return r; }
        }, 'getImageData', 4));
      }
      if (OffscreenCanvas.prototype.convertToBlob && origOcGet) {
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
        }, 'convertToBlob', 0));
      }
      mark('offscreen_canvas');
    } catch (e) {}
  };

  /* ---------- WebGL：unmasked 标识 + 像素噪声（主帧与 OffscreenCanvas WebGL 共用） ---------- */
  const patchGL = (proto) => {
    if (!proto) return;
    const origGetParameter = proto.getParameter;
    defMethod(proto, 'getParameter', native(function getParameter(p) {
      if (CFG.webgl && p === 37445) return CFG.webgl.vendor;
      if (CFG.webgl && p === 37446) return CFG.webgl.renderer;
      return origGetParameter.apply(this, arguments);
    }, 'getParameter', 1));

    if (CFG.webgl_image) {
      const origReadPixels = proto.readPixels;
      defMethod(proto, 'readPixels', native(function readPixels() {
        const r = origReadPixels.apply(this, arguments);
        try { noisePixels(arguments[6], CFG.webgl_image.seed); } catch (e) {}
        return r;
      }, 'readPixels', 7));
    }
  };

  /* ---------- 诊断用的种子快照 ---------- */
  const seedsSnapshot = () => ({
    canvas: CFG.canvas && CFG.canvas.seed || null,
    webgl_image: CFG.webgl_image && CFG.webgl_image.seed || null,
    audio: CFG.audio && CFG.audio.seed || null,
    client_rects: CFG.client_rects && CFG.client_rects.seed || null,
  });
`;

/* ============================ page 层 ============================ */
const PAGE_BODY = `
  /* ---------- Navigator：只补 CDP 覆盖不到的 ---------- */
  // platform 由 Emulation.setUserAgentOverride 原生覆盖；CDP 没生效时才兜底（少一层 JS 痕迹）
  if (CFG.platform && navigator.platform !== CFG.platform) defGetter(Navigator.prototype, 'platform', CFG.platform);

  /* hardwareConcurrency：P11 起**不在 JS 层覆盖**，改由 CDP 原生覆写
   * （Emulation.setHardwareConcurrencyOverride，见 src/runtime/manager.js 的 applyToSession）。
   * 它是 9 个入口里唯一有 CDP 出口的一个 —— 挪过去之后页面里的 getter 是**内核真身**，
   * 既没有 JS 注入痕迹，也不存在「源码/name/length 要伪装」的问题。
   *
   * CDP 侧的三个实测约束（同一个内核 157.0.8103.40）写在这里，免得后人踩：
   *   ① 清不掉：传 0 → 'HardwareConcurrency must be a positive number'，不传 → 'Invalid parameters'；
   *      「还原」只能显式设回真值或换 session；
   *   ② 作用域是 target/session 级，**新 target 不继承** → 每次 attach / 每张新页都要重设一次；
   *   ③ 不需要赶在首文档之前（和 media_devices 完全不同），attach 之后设也立即生效。
   * 另外实测它**不传播给专用 worker**（page=2 / worker=32），所以 worker 层保留「值不对才补」的
   * JS 兜底（见 WORKER_BODY），CDP 一旦生效那段就自然不装。 */
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
  // automation_controlled="1" 时相反：原生就是 true，这里一个字都不碰（碰了才是痕迹）
  if (!CFG.automationControlled) { try { if (navigator.webdriver) defGetter(Navigator.prototype, 'webdriver', false); } catch (e) {} }
  // P2 do_not_track="true"：固定 navigator.doNotTrack="1"（"false"/"default" 什么都不做）
  if (CFG.doNotTrack === '1') {
    try { if (navigator.doNotTrack !== '1') defGetter(Navigator.prototype, 'doNotTrack', '1'); } catch (e) {}
  }
  try { if (navigator.vendor !== 'Google Inc.') defGetter(Navigator.prototype, 'vendor', 'Google Inc.'); } catch (e) {}

  /* ---------- Screen：avail* 必须留出任务栏 ---------- */
  // CDP 只能设 screen 尺寸，availWidth/availHeight 于是等于它 → screen.height === screen.availHeight。
  // creepjs 的 like-headless 里 noTaskbar 查的正是这两组相等；裸 Chrome 对照是 1440 / 1392
  // （差的 48 就是 Win11 任务栏）。这里按视图里的 avail_* 改回来。
  if (CFG.screen && typeof Screen !== 'undefined') {
    defGetter(Screen.prototype, 'availWidth', CFG.screen.avail_width);
    defGetter(Screen.prototype, 'availHeight', CFG.screen.avail_height);
    defGetter(Screen.prototype, 'availTop', 0);
    defGetter(Screen.prototype, 'availLeft', 0);
  }

  /* ---------- Canvas 2D：确定性像素噪声 ---------- */
  const origGetImageData2d = CanvasRenderingContext2D.prototype.getImageData;
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  const canvasKind = new WeakMap();
  const origGetContext = HTMLCanvasElement.prototype.getContext;

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
    }, 'getContext', 1));
  }

  if (CFG.canvas) {
    defMethod(CanvasRenderingContext2D.prototype, 'getImageData', native(function getImageData() {
      const r = origGetImageData2d.apply(this, arguments);
      try { return noiseImageData(r, CFG.canvas.seed, CFG.canvas.strength || 1); } catch (e) { return r; }
    }, 'getImageData', 4));
    mark('canvas');
  }

  if (CFG.canvas || CFG.webgl_image) {
    defMethod(HTMLCanvasElement.prototype, 'toDataURL', native(function toDataURL() {
      const spec = seedForCanvas(this);
      if (!spec) return origToDataURL.apply(this, arguments);
      try { return origToDataURL.apply(noisyClone(this, spec), arguments); }
      catch (e) { return origToDataURL.apply(this, arguments); }
    }, 'toDataURL', 0));

    if (origToBlob) {
      defMethod(HTMLCanvasElement.prototype, 'toBlob', native(function toBlob() {
        const spec = seedForCanvas(this);
        if (!spec) return origToBlob.apply(this, arguments);
        const args = Array.prototype.slice.call(arguments);
        try { return origToBlob.apply(noisyClone(this, spec), args); }
        catch (e) { return origToBlob.apply(this, arguments); }
      }, 'toBlob', 1));
    }
  }

  // OffscreenCanvas 在主帧也有；和 worker 共用 core 里那一份实现
  patchOffscreenCanvasNoise();

  try { patchGL(typeof WebGLRenderingContext !== 'undefined' && WebGLRenderingContext.prototype); } catch (e) {}
  try { patchGL(typeof WebGL2RenderingContext !== 'undefined' && WebGL2RenderingContext.prototype); } catch (e) {}
  if (CFG.webgl) mark('webgl');
  if (CFG.webgl_image) mark('webgl_image');

  /* ---------- Audio：确定性浮点噪声 ---------- */
  if (CFG.audio && typeof AudioBuffer !== 'undefined') {
    const origGetChannelData = AudioBuffer.prototype.getChannelData;
    defMethod(AudioBuffer.prototype, 'getChannelData', native(function getChannelData() {
      const arr = origGetChannelData.apply(this, arguments);
      try { return noiseChannel(arr, CFG.audio.seed, Number(arguments[0]) || 0); } catch (e) { return arr; }
    }, 'getChannelData', 1));

    const origCopyFromChannel = AudioBuffer.prototype.copyFromChannel;
    if (origCopyFromChannel) {
      defMethod(AudioBuffer.prototype, 'copyFromChannel', native(function copyFromChannel(dest, channel) {
        const r = origCopyFromChannel.apply(this, arguments);
        try { noiseChannel(dest, CFG.audio.seed, Number(channel) || 0); } catch (e) {}
        return r;
      }, 'copyFromChannel', 2));
    }
    mark('audio');
  }

  /* ---------- ClientRects：亚像素确定性噪声（同一元素重复读一致） ---------- */
  if (CFG.client_rects && typeof DOMRect !== 'undefined') {
    const DOMRectCtor = DOMRect;
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
    }, 'getBoundingClientRect', 0));
    mark('client_rects');
  }

  /* ---------- 媒体设备：真实枚举 + 只改 label（不伪造列表、不伪造 deviceId） ----------
   *
   * 为什么改成这样（P9-C，检测方实测三条，全是伪造列表带来的）：
   *   1) **跨 origin deviceId 恒定**：原来用 fnv(seed:kind:i:k) 派生，跟 origin 无关，
   *      两个 origin 各读一次就能对上；而 Chrome 原生 deviceId 是**按 origin 加盐**的。
   *   2) **未授权就有 label**：原生未授权时 label 是空串，我们却直接给了名字。
   *   3) **枚举与真实能力对不上**：报得出摄像头，getUserMedia({video:true}) 却 NotFoundError。
   *
   * 所以这里只做一件事：拿真实的 enumerateDevices 列表，按配置改 label。
   * deviceId / groupId / kind 原样保留 —— 跨 origin 加盐、授权前后条数变化（实测：未授权 1 麦 1 喇叭，
   * 授权后 3 麦 8 喇叭）全由内核负责，我们不掺和。**「给真实设备改名」比「造一整套假设备」隐蔽**，
   * 这也是对手走的路（docs/08 落点矩阵的 media_devices 一行）。
   *
   * 未授权时原样返回（label 本来就是空串）；只有该 kind 权限 granted 之后才改名。
   * **权限按 kind 判**：Chrome 只给摄像头时，音频 label 仍是空串（实测 media_devices=0 基线）；
   * 所以 videoinput 看 camera，audioinput/audiooutput 看 microphone，不能一把梭。
   *
   * 复验后补的两条（P9-C 第二轮，CEO 实测）：
   *   - 必须改**真实对象**，不能 Object.create(MediaDeviceInfo.prototype) 造假的：
   *     假对象没有内核内部槽位，页面一 JSON.stringify 就抛 Illegal invocation；
   *   - 原生 MediaDeviceInfo.prototype.toJSON 按槽位取宿主真名，等于绕过改名，必须一起覆盖。
   *     这条下面原来还挂着「own property 的 label」这个残留（逆向裁判 R1）；P14 已经把 label
   *     挪到原型 getter 上，实例上不再有任何 own 属性 —— 见下面 labelOnProto 那段。
   */
  const DEVICE_LABELS = {
    audioinput: ['Microphone (Realtek(R) Audio)', 'Microphone Array (2- Conexant SmartAudio HD)', 'Line In (Realtek(R) Audio)'],
    videoinput: ['HD WebCam', 'USB Video Device', 'Integrated Camera'],
    audiooutput: ['Speakers (Realtek(R) Audio)', 'Headphones (Realtek(R) Audio)', 'Digital Audio (S/PDIF)'],
  };

  if (CFG.media && CFG.media.mode !== '0'
      && typeof navigator !== 'undefined' && navigator.mediaDevices
      && typeof MediaDevices !== 'undefined' && MediaDevices.prototype.enumerateDevices) {
    const mdProto = MediaDevices.prototype;
    const origEnumerate = mdProto.enumerateDevices;
    const origGetUserMedia = mdProto.getUserMedia;
    /** getUserMedia 成功过一次 = 该 origin 已授权（Permissions API 不可用时的兜底） */
    let gumGranted = false;

    /** 与原生同源：分别查 camera / microphone，**按设备类型分别给名字**。
     *  Chrome 就是按 kind 判权限：只授权了摄像头，音频设备的 label 仍然是空串。
     *  之前用 some(Boolean) 一把梭，只给摄像头时音频也被改名 —— 一眼能抓的不一致
     *  （真实基线 media_devices=0 实测：camera=granted、microphone=denied 时音频 label 全空）。 */
    const permissionState = () => {
      const query = (name) => {
        try {
          if (typeof navigator.permissions === 'undefined' || !navigator.permissions.query) {
            return Promise.resolve(gumGranted);
          }
          return navigator.permissions.query({ name })
            .then((s) => s.state === 'granted')
            .catch(() => gumGranted);
        } catch (e) { return Promise.resolve(gumGranted); }
      };
      return Promise.all([query('camera'), query('microphone')]).then(function (states) {
        return { camera: !!states[0], microphone: !!states[1] };
      });
    };

    /** 真实 label → 我们的 label。给 getUserMedia 的 track 用：
     *  原生里 track.label 就等于对应设备的 label，只改枚举不改 track 会立刻对不上。 */
    const labelMap = {};
    /** track → 我们给的 label（不污染原生对象，自己的 WeakMap 兜住） */
    const trackLabels = new WeakMap();
    /** 真实设备对象 → 我们给它的 label（MediaDeviceInfo.prototype.toJSON 要用） */
    const deviceLabels = new WeakMap();
    /** 被我们打过补丁的真实对象（授权撤销 / 该 kind 未授权时要还原） */
    const patched = new WeakSet();

    /** 还原成内核原样：清掉 WeakMap 里的映射（原型 getter 立刻回落到原生 getter）；
     *  兜底路径（拿不到原型、只能挂实例属性）时再把那个 own property 删掉。 */
    const resetDevice = (d) => {
      try {
        if (patched.has(d)) {
          delete d.label;
          patched.delete(d);
          deviceLabels.delete(d);
        }
      } catch (e) { /* 冻结对象等极端情况：保持现状 */ }
      return d;
    };

    /** 按 kind 的第 i 个设备取名字：自定义配置优先，否则用内置命名池。
     *  设备数超过命名池时用 Windows 自己的去重写法 "2- " 前缀（宿主真名里就有
     *  "Microphone Array (2- Conexant SmartAudio HD)" 这种），**不能让两个不同 deviceId
     *  挂同一个 label** —— 重复 label 本身就是「批量伪造」的破绽。 */
    const labelFor = (kind, i) => {
      const media = CFG.media || {};
      const custom = Array.isArray(media.devices) ? media.devices : [];
      const pool = custom.filter((d) => d && d.kind === kind && d.label).map((d) => d.label);
      const base = pool.length ? pool : (DEVICE_LABELS[kind] || []);
      if (!base.length) return null;
      const name = base[i % base.length];
      const round = Math.floor(i / base.length);
      return round === 0 ? name : (round + 1) + '- ' + name;
    };

    /* P14：label 走 MediaDeviceInfo.prototype 的 getter，实例上不再挂 own property。
     *
     * 破绽（逆向裁判 R1）：原来用 Object.defineProperty(d,'label',…) 往实例上写，
     * 实例就多出一个 own property label；而原生设备对象上**一个 own 属性都没有**
     * （本机 media_devices=0 基线实测：8 个实例的 Object.getOwnPropertyNames 全是 []）。
     * 页面一行 Object.getOwnPropertyNames(device) 就能读出「这个环境被改过」。
     *
     * 先量后改（157.0.8103.40，.tmp/p14-measure.mjs）：
     *   - 原型上的 label 是 accessor：enumerable:true、configurable:true、get 是原生函数；
     *   - 整条 descriptor 能换（defineProperty 成功；包一层 getter 后 d.label 立刻走新 getter）；
     *   - 原生 getter 用 this = 真实设备对象 调得通（返回宿主真名，不是抛 Illegal invocation）；
     *   - 音频输入设备的原型是 InputDeviceInfo.prototype（MediaDeviceInfo 的子类），
     *     它自己不定义 label（own 只有 constructor / getCapabilities），所以也走这条链 ——
     *     只改 MediaDeviceInfo.prototype 就够，不必逐个 constructor 补。
     *
     * getter 用**对象字面量的 getter 语法**取出来，而不是普通函数表达式：方法/访问器定义
     * 没有 own prototype，和原生 getter 的 own 属性形状一致（都是 length + name）。
     *
     * 边界（别读成「已消除」）：
     *   - 只在这一层 realm 生效；iframe 是另一个 realm、另一份原型，仍走原生（README 35b）；
     *   - 内核若换成不可 configurable 的原型 accessor，这里装不上，就退回实例 own property
     *     （labelOnProto = false）—— 那时 R1 会重新出现，这是已知的降级，不是修好了。
     */
    let labelOnProto = false;
    try {
      if (typeof MediaDeviceInfo !== 'undefined' && MediaDeviceInfo.prototype) {
        const mdInfoProto = MediaDeviceInfo.prototype;
        const d0 = Object.getOwnPropertyDescriptor(mdInfoProto, 'label');
        if (d0 && typeof d0.get === 'function' && d0.configurable) {
          const origLabelGet = d0.get;
          const wrappedGet = Object.getOwnPropertyDescriptor({
            get label() {
              const mapped = deviceLabels.get(this);
              return mapped === undefined ? origLabelGet.call(this) : mapped;
            },
          }, 'label').get;
          Object.defineProperty(mdInfoProto, 'label', {
            get: native(wrappedGet, 'get label', 0),
            enumerable: d0.enumerable,
            configurable: true,
          });
          labelOnProto = true;
        }
      }
    } catch (e) { labelOnProto = false; }

    /** 只换 label：设备对象本身仍是**真实对象**（instanceof 仍 true、原生内部槽位还在），
     *  但名字记在 WeakMap 里、由上面那个原型 getter 投影出去 —— 实例上一个 own 属性都不挂。
     *  不能再 Object.create(MediaDeviceInfo.prototype) —— 那种对象没有内部槽位，
     *  JSON.stringify 一调原生 toJSON 就抛 Illegal invocation（P9-C 复验实测）。 */
    const project = (list, perm) => {
      const counter = {};
      const map = {};
      const out = list.map((d) => {
        const kind = String(d.kind || '');
        const i = counter[kind] = (counter[kind] || 0);
        counter[kind] = i + 1;
        const allowed = kind === 'videoinput' ? !!perm.camera
          : (kind === 'audioinput' || kind === 'audiooutput') ? !!perm.microphone : false;
        const label = allowed ? labelFor(kind, i) : null;
        if (!label) return resetDevice(d);
        try {
          // 读的这一刻 WeakMap 里还没有这条，getter 回落到原生 → 拿到宿主真名做映射
          if (d.label) map[d.label] = label;
          deviceLabels.set(d, label);
          patched.add(d);
          // 兜底：原型改不动时只能挂 own property（R1 会重现，见上面边界）
          if (!labelOnProto) {
            Object.defineProperty(d, 'label', {
              value: label, enumerable: false, configurable: true, writable: false,
            });
          }
          return d;
        } catch (e) { deviceLabels.delete(d); patched.delete(d); return d; }
      });
      return { list: out, map };
    };

    /* MediaDeviceInfo.prototype.toJSON 按内核内部槽位取字段：
     *   - 对 Object.create 出来的假对象直接抛 Illegal invocation（页面里任何 JSON.stringify 都会炸）；
     *   - 对真实对象返回宿主真名，等于绕过我们的改名。
     * 所以覆盖掉：先用原生 toJSON 拿到完整字段，再把 label 换成我们给的。 */
    try {
      if (typeof MediaDeviceInfo !== 'undefined' && typeof MediaDeviceInfo.prototype.toJSON === 'function') {
        const mdInfoProto = MediaDeviceInfo.prototype;
        const origToJSON = mdInfoProto.toJSON;
        defMethod(mdInfoProto, 'toJSON', native(function toJSON() {
          const base = origToJSON.call(this);
          const mapped = deviceLabels.get(this);
          if (mapped !== undefined && base && typeof base === 'object') base.label = mapped;
          return base;
        }, 'toJSON', 0));
      }
    } catch (e) { /* 没有 toJSON 的内核：JSON.stringify 走普通枚举，行为同原生 */ }

    const remember = (map) => {
      for (const k of Object.keys(map || {})) labelMap[k] = map[k];
    };

    /* track.label 跟着枚举一起改：原生两者相等，只改一边就是新的破绽 */
    try {
      if (typeof MediaStreamTrack !== 'undefined') {
        const desc = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'label');
        if (desc && desc.get && desc.configurable) {
          Object.defineProperty(MediaStreamTrack.prototype, 'label', {
            get: native(function () {
              const v = trackLabels.get(this);
              return v === undefined ? desc.get.call(this) : v;
            }, 'get label', 0),
            enumerable: desc.enumerable,
            configurable: true,
          });
        }
      }
    } catch (e) {}

    const renameTracks = (stream) => {
      try {
        const tracks = stream && stream.getTracks ? stream.getTracks() : [];
        for (const t of tracks) {
          const mapped = labelMap[t.label];
          if (mapped) trackLabels.set(t, mapped);
        }
      } catch (e) {}
      return stream;
    };

    defMethod(mdProto, 'enumerateDevices', native(function enumerateDevices() {
      const p = origEnumerate.apply(this, arguments);
      return Promise.resolve(p).then((list) => permissionState().then((perm) => {
        if (!perm.camera && !perm.microphone) {
          // 未授权：原生 label 是空串，原样返回；之前打过补丁的对象要还原，别把假名粘在上面
          for (let i = 0; i < list.length; i++) resetDevice(list[i]);
          return list;
        }
        try {
          const proj = project(list, perm);
          remember(proj.map);
          return proj.list;
        } catch (e) { return list; }
      }), (e) => Promise.reject(e));
    }, 'enumerateDevices', 0));

    if (typeof origGetUserMedia === 'function') {
      defMethod(mdProto, 'getUserMedia', native(function getUserMedia() {
        const p = origGetUserMedia.apply(this, arguments);
        if (!p || typeof p.then !== 'function') return p;
        const self = this;
        return p.then((stream) => {
          gumGranted = true;
          if (Object.keys(labelMap).length) return renameTracks(stream);
          // 还没枚举过：先补一次真实枚举把映射建起来，再改 track.label
          return Promise.resolve(origEnumerate.call(self))
            .then((list) => permissionState().then((perm) => {
              try { remember(project(list, perm).map); } catch (e) {}
              return renameTracks(stream);
            }))
            .catch(() => renameTracks(stream));
        }, (e) => Promise.reject(e));
      }, 'getUserMedia', 0));
    }

    mark('media_devices');
    try { Object.defineProperty(window, '__fpMediaMode', { value: 'native', enumerable: false, configurable: false }); } catch (e) {}
  }

  /* ---------- 语音合成：按环境 language 投影 getVoices() ----------
   *
   * 宿主是中文 Windows：裸 Chrome 在 https 页返回 25 条声音，第一条是
   * Microsoft Huihui - Chinese (Simplified, PRC)（zh-CN）。同一份 en-US 环境在中文机器和
   * 英文机器上产出的声音列表不一样 —— 这是跨机一致性的硬伤（P9-A 实测，plain 与 ours 都是 25 条中文）。
   *
   * 做法：从内核真实列表里**只保留环境语言（含同语种变体）的声音**，其它原样丢弃。
   * 三个必须守住的点：
   *   1) voice 对象形状完整：name / lang / voiceURI / localService / default 全在（原生本来就在原型上）。
   *      我们只纠正 default：被过滤掉的恰好是原生 default 那条时，取剩余列表的第一条当 default。
   *   2) 宿主还没加载完时照原生返回空数组；onvoiceschanged 仍由内核触发一次，**不自己造事件**。
   *   3) SpeechSynthesisUtterance / speak / cancel 一个字不碰 —— 返回的本来就是原生 voice 对象，
   *      所以 speak 行为不受影响（这条比「自己 new 一批 voice」稳）。
   *
   * 边界：宿主连一条该语言的声音都没有时（本机实测缺 vi-VN / th-TH），**保持原生**，
   * 不凭空造 voice 名 —— 造出来的名字 speak 点不着，反而多一层破绽。已写进 README 已知限制。
   */
  if (CFG.speech && CFG.speech.enabled
      && typeof speechSynthesis !== 'undefined'
      && typeof SpeechSynthesis !== 'undefined'
      && typeof SpeechSynthesisVoice !== 'undefined') {
    const langs = (CFG.language || []).map(function (x) { return String(x).toLowerCase(); });
    const primary = langs[0] || '';
    const baseLang = primary.split('-')[0];
    const wanted = function (lang) {
      const l = String(lang || '').toLowerCase();
      if (!l) return false;
      if (langs.indexOf(l) >= 0) return true;
      return !!baseLang && l.split('-')[0] === baseLang;
    };

    const VOICE_PROTO = SpeechSynthesisVoice.prototype;
    const defaultDesc = Object.getOwnPropertyDescriptor(VOICE_PROTO, 'default');
    const forcedDefault = new WeakMap();
    if (defaultDesc && defaultDesc.get && defaultDesc.configurable) {
      Object.defineProperty(VOICE_PROTO, 'default', {
        get: native(function () {
          const v = forcedDefault.get(this);
          return v === undefined ? defaultDesc.get.call(this) : v;
        }, 'get default', 0),
        enumerable: defaultDesc.enumerable,
        configurable: true,
      });
    }
    const nativeDefault = function (v) {
      try { return !!(defaultDesc && defaultDesc.get && defaultDesc.get.call(v)); } catch (e) { return false; }
    };

    const origGetVoices = SpeechSynthesis.prototype.getVoices;
    const cache = { sig: null, list: null };
    defMethod(SpeechSynthesis.prototype, 'getVoices', native(function getVoices() {
      const host = origGetVoices.call(this);
      try {
        if (!host || !host.length) return host;   // 还没加载：和原生一样给空数组
        const keep = Array.prototype.filter.call(host, function (v) {
          try { return wanted(v.lang); } catch (e) { return false; }
        });
        // 宿主没有该语言的任何声音：不造，保持原生（见上面边界）
        if (!keep.length) return host;
        const sig = keep.map(function (v) {
          return v.name + '|' + v.lang + '|' + v.voiceURI + '|' + (nativeDefault(v) ? 1 : 0);
        }).join('~');
        if (cache.sig === sig && cache.list) return cache.list;
        let def = null;
        for (let i = 0; i < keep.length; i++) {
          if (nativeDefault(keep[i])) { def = keep[i]; break; }
        }
        if (!def) def = keep[0];
        const list = keep.map(function (v) { forcedDefault.set(v, v === def); return v; });
        cache.sig = sig;
        cache.list = list;
        return list;
      } catch (e) { return host; }
    }, 'getVoices', 0));
    mark('speech');
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
    Object.defineProperty(window, '__fpSeeds', { value: seedsSnapshot(), enumerable: false, configurable: false });
    Object.defineProperty(window, '__fpRealm', { value: 'page', enumerable: false, configurable: false });
    if (DEBUG) {
      Object.defineProperty(window, '__fpConfig', { value: CFG, enumerable: false, configurable: false });
      // 排查用：注入前的原生函数（自检/支持人员可比对「基础渲染」和「加噪后」）
      Object.defineProperty(window, '__fpOrig', {
        value: { toDataURL: origToDataURL, getImageData: origGetImageData2d },
        enumerable: false, configurable: false,
      });
    }
  } catch (e) {}
`;

/* ============================ worker 层 ============================ */
const WORKER_BODY = `
  /* ---------- WorkerNavigator ----------
   * 实测（Chrome 156）：Emulation.setUserAgentOverride 会传播到专用 worker，
   * 但**不会**传播到 SharedWorker / ServiceWorker（那两类仍拿到真实 UA）。
   * 所以这里按值判断：CDP 已经给对就不动，没给对才用 JS 补 —— 三类 worker 走同一条代码。
   */
  const NAV_PROTO = (typeof WorkerNavigator !== 'undefined' && WorkerNavigator.prototype)
    || (self.navigator && Object.getPrototypeOf(self.navigator))
    || null;

  if (NAV_PROTO && CFG.ua && self.navigator && self.navigator.userAgent !== CFG.ua) {
    defGetter(NAV_PROTO, 'userAgent', CFG.ua);
    // appVersion 是 UA 去掉前缀，不跟着改会比 UA 本身更容易被抓
    const av = String(CFG.ua).replace(/^Mozilla\\//, '');
    try { if (self.navigator.appVersion !== av) defGetter(NAV_PROTO, 'appVersion', av); } catch (e) {}
  }
  if (NAV_PROTO && CFG.platform && self.navigator && self.navigator.platform !== CFG.platform) {
    defGetter(NAV_PROTO, 'platform', CFG.platform);
  }
  /* hardwareConcurrency：先看 CDP 给没给对（manager.js 会在 worker session 上也设一次
   * Emulation.setHardwareConcurrencyOverride，实测 resume 之前就生效），给对了就一个字都不碰；
   * 设不上（老内核 / 该类 worker 不支持）才用 JS 兜底 —— 宁可多一层包装，也不能让 worker
   * 报宿主核数、跟主帧自相矛盾。兜底函数同样走 native() 登记，源码是 [native code]。 */
  if (NAV_PROTO && typeof CFG.hardwareConcurrency === 'number'
      && self.navigator && self.navigator.hardwareConcurrency !== CFG.hardwareConcurrency) {
    defGetter(NAV_PROTO, 'hardwareConcurrency', CFG.hardwareConcurrency);
  }
  if (NAV_PROTO && typeof CFG.deviceMemory === 'number'
      && self.navigator && self.navigator.deviceMemory !== CFG.deviceMemory) {
    defGetter(NAV_PROTO, 'deviceMemory', CFG.deviceMemory);
  }
  if (NAV_PROTO && CFG.language && CFG.language.length && self.navigator) {
    const lang0 = CFG.language[0];
    const langs = Object.freeze(CFG.language.slice());
    if (self.navigator.language !== lang0) defGetter(NAV_PROTO, 'language', lang0);
    const nativeLangs = self.navigator.languages ? Array.prototype.join.call(self.navigator.languages, ',') : '';
    if (nativeLangs !== CFG.language.join(',')) defGetter(NAV_PROTO, 'languages', langs);
  }
  // automation_controlled="1"：原生就是 true，worker 这边同样不碰（与主帧口径一致）
  if (!CFG.automationControlled) { try { if (self.navigator && self.navigator.webdriver) defGetter(NAV_PROTO, 'webdriver', false); } catch (e) {} }
  // do_not_track 在 worker 里不用补：WorkerNavigator **没有** doNotTrack 属性（实测 has:false）

  /* ---------- OffscreenCanvas：和主帧共用 core 里那份噪声实现 ---------- */
  patchOffscreenCanvasNoise();

  /* ---------- OffscreenCanvas 也能开 WebGL：标识与像素噪声一起补 ---------- */
  try { patchGL(typeof WebGLRenderingContext !== 'undefined' && WebGLRenderingContext.prototype); } catch (e) {}
  try { patchGL(typeof WebGL2RenderingContext !== 'undefined' && WebGL2RenderingContext.prototype); } catch (e) {}
  if (CFG.webgl) mark('webgl');
  if (CFG.webgl_image) mark('webgl_image');

  /* ---------- 诊断 ---------- */
  try {
    Object.defineProperty(self, '__fpApplied', { value: applied, enumerable: false, configurable: false });
    Object.defineProperty(self, '__fpSeed', { value: CFG.seed, enumerable: false, configurable: false });
    Object.defineProperty(self, '__fpSeeds', { value: seedsSnapshot(), enumerable: false, configurable: false });
    Object.defineProperty(self, '__fpRealm', { value: 'worker', enumerable: false, configurable: false });
    if (DEBUG) Object.defineProperty(self, '__fpConfig', { value: CFG, enumerable: false, configurable: false });
  } catch (e) {}
`;

/** 主帧注入源（Page.addScriptToEvaluateOnNewDocument） */
export function buildInjectionSource(fp, { debug = false } = {}) {
  const json = JSON.stringify(injectionConfig(fp));
  return `(() => {
  'use strict';
  if (window.__fpInstalled) return;
  const CFG = ${json};
  const DEBUG = ${debug ? 'true' : 'false'};
${CORE}${PAGE_BODY}
  window.__fpInstalled = true;
})();`;
}

/**
 * worker 注入源（Target.setAutoAttach → Runtime.evaluate）。
 * 与 page 层共用 CORE：四维噪声的种子派生只有这一份实现。
 */
export function buildWorkerInjectionSource(fp, { debug = false } = {}) {
  const json = JSON.stringify(injectionConfig(fp));
  return `(() => {
  'use strict';
  if (self.__fpInstalled) return;
  const CFG = ${json};
  const DEBUG = ${debug ? 'true' : 'false'};
${CORE}${WORKER_BODY}
  self.__fpInstalled = true;
})();`;
}

/** 测试用：把共用核心单独取出来，比对 page/worker 两边的字节是否完全一致 */
export function sharedNoiseCoreSource() {
  return CORE;
}
