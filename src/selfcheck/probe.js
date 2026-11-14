/**
 * 自检探针：在**目标环境自己的页面里**跑，读回页面真实看到的指纹。
 *
 * 不在主进程里「模拟」，因为主进程不知道 CDP/注入有没有真的生效。
 * 这个脚本对页面只读 + 建临时 DOM（测完删掉）、起临时 worker/SW（测完注销），
 * 不联网（WebRTC 不配 STUN），所以代理环境里也能跑，不依赖出口接口。
 */
import { REALM_RECIPE } from './worker-probe.js';
import { markerNames } from '../kernel/markers.js';

/**
 * @param {object} [markers] 按 fp_seed 派生的诊断标记名（src/kernel/markers.js）。
 *   不传就按默认种子算 —— **绝不回落到固定名**（固定名等于给对手一行判定代码）。
 */
export function buildProbeSource(markers = markerNames()) {
  return `(async () => {
  'use strict';
  const MK = ${JSON.stringify(markers)};
  const out = {};
  const hashStr = (str) => {
    let h = 2166136261 >>> 0;
    const s = String(str);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return (h >>> 0).toString(16).padStart(8, '0');
  };
  const hashBytes = (arr, limit) => {
    let h = 2166136261 >>> 0;
    const n = Math.min(arr.length, limit || arr.length);
    for (let i = 0; i < n; i++) { h ^= arr[i] & 0xff; h = Math.imul(h, 16777619) >>> 0; }
    return (h >>> 0).toString(16).padStart(8, '0');
  };

  /* ---------- 基础值 ---------- */
  out.ua = navigator.userAgent;
  out.platform = navigator.platform;
  out.languages = navigator.languages ? Array.prototype.slice.call(navigator.languages) : [navigator.language];
  out.language = navigator.language;
  out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  out.locale = Intl.DateTimeFormat().resolvedOptions().locale;
  out.webdriver = !!navigator.webdriver;
  out.cores = navigator.hardwareConcurrency;
  out.memory = typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : null;
  out.screen = {
    width: screen.width, height: screen.height,
    availWidth: screen.availWidth, availHeight: screen.availHeight,
    colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth,
    dpr: window.devicePixelRatio,
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
  };
  out.isSecureContext = !!window.isSecureContext;
  out.mediaMode = window[MK.mediaMode] || null;
  out.applied = window[MK.applied] ? Array.prototype.slice.call(window[MK.applied]) : [];
  out.seeds = window[MK.seeds] || null;
  out.fontsDeclared = window[MK.fontsDeclared] || null;
  out.installed = !!window[MK.installed];

  /* ---------- UA-CH ---------- */
  try {
    if (navigator.userAgentData) {
      out.uaData = {
        brands: navigator.userAgentData.brands,
        mobile: navigator.userAgentData.mobile,
        platform: navigator.userAgentData.platform,
      };
      try {
        out.uaDataHigh = await navigator.userAgentData.getHighEntropyValues(
          ['architecture', 'bitness', 'fullVersionList', 'model', 'platformVersion', 'wow64']
        );
      } catch (e) { out.uaDataHigh = { error: String(e) }; }
    } else {
      out.uaData = null;
    }
  } catch (e) { out.uaData = { error: String(e) }; }

  /* ---------- Canvas 哈希（同页读两次，验确定性） ---------- */
  function canvasSample() {
    const c = document.createElement('canvas');
    c.width = 280; c.height = 80;
    const x = c.getContext('2d');
    x.fillStyle = '#f60'; x.fillRect(0, 0, 280, 80);
    x.fillStyle = '#069'; x.font = '16px "Arial"';
    x.fillText('FreePower 自检 / canvas ✓', 6, 30);
    x.strokeStyle = 'rgba(102,204,0,0.7)'; x.lineWidth = 2;
    x.beginPath(); x.arc(140, 40, 30, 0, Math.PI * 2); x.stroke();
    x.fillStyle = 'rgba(255,255,255,0.55)';
    x.fillRect(12, 52, 120, 14);
    const url = c.toDataURL();
    const img = x.getImageData(0, 0, 60, 30);
    return { hash: hashStr(url), url_len: url.length, pixels: hashBytes(img.data, 4000) };
  }
  try {
    const a = canvasSample();
    const b = canvasSample();
    out.canvas = { ...a, hash2: b.hash, pixels2: b.pixels, stable: a.hash === b.hash && a.pixels === b.pixels };
  } catch (e) { out.canvas = { error: String(e) }; }

  /* ---------- WebGL：vendor/renderer + 真实渲染读回 ---------- */
  try {
    const c = document.createElement('canvas');
    c.width = 200; c.height = 100;
    const gl = c.getContext('webgl', { preserveDrawingBuffer: true }) || c.getContext('experimental-webgl', { preserveDrawingBuffer: true });
    if (!gl) {
      out.webgl = { supported: false };
    } else {
      const readPixels = () => {
        gl.clearColor(0.2, 0.4, 0.6, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const px = new Uint8Array(200 * 100 * 4);
        gl.readPixels(0, 0, 200, 100, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return hashBytes(px, 20000);
      };
      const h1 = readPixels();
      const h2 = readPixels();
      let urlHash = null;
      try { urlHash = hashStr(c.toDataURL()); } catch (e) {}
      out.webgl = {
        supported: true,
        vendor: gl.getParameter(37445),
        renderer: gl.getParameter(37446),
        version: gl.getParameter(7938),
        shading: gl.getParameter(7937),
        extensions: (gl.getSupportedExtensions() || []).length,
        maxTextureSize: gl.getParameter(3379),
        maxRenderbufferSize: gl.getParameter(34024),
        precision: (() => {
          try {
            const p = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
            return p ? { rangeMin: p.rangeMin, rangeMax: p.rangeMax, precision: p.precision } : null;
          } catch (e) { return null; }
        })(),
        image_hash: h1,
        image_hash2: h2,
        image_url_hash: urlHash,
        stable: h1 === h2,
      };
    }
  } catch (e) { out.webgl = { supported: false, error: String(e) }; }

  /* ---------- Audio 哈希（OfflineAudioContext，同页渲染两次） ---------- */
  async function audioSample() {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx) return { supported: false };
    const ctx = new Ctx(1, 4096, 44100);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 440;
    const gain = ctx.createGain();
    gain.gain.value = 0.3;
    osc.connect(gain).connect(ctx.destination);
    osc.start(0);
    const buf = await ctx.startRendering();
    const ch = buf.getChannelData(0);
    let sum = 0;
    const parts = [];
    // 整段 buffer 都进哈希。原来只取前 128 个采样，而噪声每 1000 个采样才落一次 ——
    // 两个不同种子的「早期窗口」可能算出同一个哈希（P10 复制验收真撞到过）。
    // 那是测量口径的坑，不是注入没生效：真实检测库哈希的是整段 buffer / 全样本和。
    for (let i = 0; i < ch.length; i++) {
      sum += Math.abs(ch[i]);
      parts.push(ch[i].toFixed(8));
    }
    return { supported: true, sum: sum.toFixed(10), hash: hashStr(parts.join(',') + '|sum:' + sum.toFixed(10)) };
  }
  try {
    const a = await audioSample();
    const b = a.supported ? await audioSample() : a;
    out.audio = { ...a, hash2: b.hash, sum2: b.sum, stable: a.supported && a.hash === b.hash && a.sum === b.sum };
  } catch (e) { out.audio = { error: String(e) }; }

  /* ---------- ClientRects 哈希（固定 DOM，读两次） ---------- */
  function rectSample() {
    const host = document.createElement('div');
    host.setAttribute('style', 'position:absolute;left:7px;top:11px;width:640px;font:14px Arial;visibility:hidden');
    host.innerHTML = '<div style="padding:3px 5px">FreePower</div><span style="letter-spacing:0.4px">自检 rects</span><p style="margin:7px 0">abcdefghijklmnopqrstuvwxyz</p><div style="border:1px solid #000;width:220px;height:33px"></div>';
    document.body.appendChild(host);
    try {
      const vals = [];
      for (const el of host.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        vals.push([r.x, r.y, r.width, r.height].map((v) => Number(v).toFixed(5)).join(','));
      }
      return { hash: hashStr(vals.join('|')), rects: vals.length };
    } finally {
      host.remove();
    }
  }
  try {
    const a = rectSample();
    const b = rectSample();
    out.client_rects = { ...a, hash2: b.hash, stable: a.hash === b.hash };
  } catch (e) { out.client_rects = { error: String(e) }; }

  /* ---------- 字体：检测真实安装的字体（不伪装，只观察） ----------
   * P9-B：这一项的价值不是「值对上了」，而是把「宿主装了哪些字体」这个枚举面摆出来
   * （creepjs 的 platform hints 就是靠它暴露 Microsoft YaHei UI 的）。
   */
  try {
    const FONTS = ['Arial', 'Arial Black', 'Calibri', 'Cambria', 'Comic Sans MS', 'Consolas',
      'Courier New', 'Georgia', 'Impact', 'Segoe UI', 'Tahoma', 'Times New Roman',
      'Trebuchet MS', 'Verdana', 'Microsoft YaHei', 'Microsoft YaHei UI', 'SimSun', 'SimHei',
      'KaiTi', 'FangSong', 'Microsoft JhengHei', 'Segoe UI Emoji', 'Wingdings'];
    const EAST_ASIAN = /YaHei|SimSun|SimHei|KaiTi|FangSong|JhengHei|MingLiU|PMingLiU|Yu Gothic|Meiryo|MS Gothic|Malgun/i;
    const probeCanvas = document.createElement('canvas');
    const pc = probeCanvas.getContext('2d');
    const base = ['monospace', 'sans-serif', 'serif'];
    const detected = [];
    for (const f of FONTS) {
      let hit = false;
      for (const b of base) {
        pc.font = '72px "' + f + '", ' + b;
        const w1 = pc.measureText('mmmmmmmmmmlli').width;
        pc.font = '72px ' + b;
        const w2 = pc.measureText('mmmmmmmmmmlli').width;
        if (w1 !== w2) { hit = true; break; }
      }
      if (hit) detected.push(f);
    }
    out.fonts = {
      probed: FONTS,
      detected,
      eastAsian: detected.filter((f) => EAST_ASIAN.test(f)),
      declared: out.fontsDeclared,
      check: (() => {
        try { return FONTS.filter((f) => document.fonts && document.fonts.check('12px "' + f + '"')).slice(0, 18); }
        catch (e) { return []; }
      })(),
    };
  } catch (e) { out.fonts = { error: String(e) }; }

  /* ---------- 媒体设备 ----------
   * P9-C 起设备列表来自**真实枚举**，我们只改 label；所以这里要一起读「权限状态」，
   * 否则分不清「label 为空」是原生（未授权）还是注入没生效。
   */
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      let permissions = null;
      try {
        if (navigator.permissions && navigator.permissions.query) {
          const states = await Promise.all(['camera', 'microphone'].map((name) => navigator.permissions
            .query({ name }).then((s) => s.state).catch(() => 'unknown')));
          permissions = { camera: states[0], microphone: states[1] };
        }
      } catch (e) { permissions = null; }
      const list = await navigator.mediaDevices.enumerateDevices();
      out.media_devices = {
        supported: true,
        permissions,
        granted: !!(permissions && (permissions.camera === 'granted' || permissions.microphone === 'granted')),
        labelsEmpty: list.every((d) => !d.label),
        list: list.map((d) => ({ kind: d.kind, label: d.label, deviceId: d.deviceId, groupId: d.groupId })),
        counts: list.reduce((acc, d) => { acc[d.kind] = (acc[d.kind] || 0) + 1; return acc; }, {}),
      };
    } else {
      out.media_devices = { supported: false };
    }
  } catch (e) { out.media_devices = { supported: false, error: String(e) }; }

  /* ---------- WebRTC：短时间收集候选，看有没有真实出口 IP 泄漏 ---------- */
  try {
    if (typeof RTCPeerConnection !== 'function') {
      out.webrtc = { supported: false };
    } else {
      const pc = new RTCPeerConnection({ iceServers: [], iceCandidatePoolSize: 0 });
      const cands = [];
      pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        const c = e.candidate;
        let addr = '';
        try {
          const s = String(c.candidate || '');
          const m = /(?:candidate:\\S+ \\d+ \\S+ \\d+ )([^ ]+) (\\d+) (\\S+)/.exec(s);
          addr = (m && m[1]) || c.address || '';
        } catch (err) {}
        cands.push({ candidate: String(c.candidate || ''), type: c.type || '', protocol: c.protocol || '', address: addr });
      };
      try {
        pc.createDataChannel('fp');
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await new Promise((r) => setTimeout(r, 900));
      } catch (e) {}
      try { pc.close(); } catch (e) {}
      const ips = [];
      for (const c of cands) {
        const v4 = /\\b(\\d{1,3}(?:\\.\\d{1,3}){3})\\b/g;
        let m;
        while ((m = v4.exec(c.candidate))) if (ips.indexOf(m[1]) < 0) ips.push(m[1]);
      }
      out.webrtc = {
        supported: true,
        count: cands.length,
        types: cands.map((c) => c.type).filter((v, i, a) => v && a.indexOf(v) === i),
        addresses: ips,
        candidates: cands.map((c) => c.candidate).slice(0, 20),
      };
    }
  } catch (e) { out.webrtc = { supported: false, error: String(e) }; }

  /* ---------- 双 Realm：专用 worker / SharedWorker / ServiceWorker ----------
   * 配方与 worker 脚本共用 worker-probe.js 里那一份（主帧这边只多一个 DOM canvas 对照）。
   * 只有真 http(s) 源才能构造 SharedWorker（opaque origin 会 SecurityError），
   * 且 ServiceWorker 必须用真实 URL 注册 —— 所以这几项在 about:blank 下如实标「未验证」。
   */
${REALM_RECIPE}
  const realmOut = { main: null, dedicated: null, shared: null, service: null, note: null };
  const withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms)),
  ]);
  try {
    realmOut.main = Object.assign(fpNavSnapshot(), { realm: 'page', canvas_dom: fpCanvasDomHash(), canvas_offscreen: fpCanvasOffscreenHash() });
    const httpOrigin = /^https?:$/.test(location.protocol);
    if (!httpOrigin) {
      realmOut.note = '自检页不在 http(s) 源（' + location.href + '）：SharedWorker 在 opaque origin 下构造会 SecurityError，ServiceWorker 无法注册，三项本次未验证';
    } else {
      /* 专用 worker */
      try {
        const w = new Worker('/fp-worker.js');
        try {
          const data = await withTimeout(new Promise((res, rej) => {
            w.onmessage = (e) => res(e.data);
            w.onerror = (e) => rej(new Error((e && e.message) || 'worker error'));
            w.postMessage({ go: 1 });
          }), 6000, 'dedicated worker 超时');
          realmOut.dedicated = data;
        } finally { try { w.terminate(); } catch (e) {} }
      } catch (e) { realmOut.dedicated = { ok: false, error: String(e.message || e) }; }

      /* SharedWorker */
      try {
        const sw = new SharedWorker('/fp-worker.js');
        try {
          sw.port.start();
          const data = await withTimeout(new Promise((res) => {
            sw.port.onmessage = (e) => res(e.data);
            sw.port.postMessage({ go: 1 });
          }), 6000, 'SharedWorker 超时');
          realmOut.shared = data;
        } finally { try { sw.port.close(); } catch (e) {} }
      } catch (e) { realmOut.shared = { ok: false, error: String(e.message || e) }; }

      /* ServiceWorker：注册 → 等 active → 端口取数 → **必须注销**
       * 不注销就会给环境留一个常驻注册，下次启动时它已「在运行」，按已知限制就不在覆盖范围里了。
       */
      try {
        if (!navigator.serviceWorker) throw new Error('navigator.serviceWorker 不可用');
        const reg = await navigator.serviceWorker.register('/fp-sw.js', { scope: '/' });
        try {
          await withTimeout(navigator.serviceWorker.ready, 8000, 'SW ready 超时');
          const target = reg.active || reg.waiting || reg.installing;
          if (!target) throw new Error('SW 未进入 active');
          const ch = new MessageChannel();
          const data = await withTimeout(new Promise((res) => {
            ch.port1.onmessage = (e) => res(e.data);
            target.postMessage({ go: 1 }, [ch.port2]);
          }), 8000, 'SW 消息超时');
          realmOut.service = data;
        } finally {
          try { await reg.unregister(); } catch (e) {}
        }
      } catch (e) { realmOut.service = { ok: false, error: String(e.message || e) }; }
    }
  } catch (e) { realmOut.error = String(e.message || e).split('\\n')[0]; }
  out.workers = realmOut;

  /* ---------- AudioWorklet：故意不注入，只把「这里有什么」读出来 ---------- */
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      out.audioworklet = { supported: false, error: '没有 AudioContext' };
    } else if (!/^https?:$/.test(location.protocol)) {
      out.audioworklet = { supported: false, error: '非安全上下文，AudioWorklet 不可用' };
    } else {
      let ctx = null;
      try {
        ctx = new AC();
        await withTimeout(ctx.audioWorklet.addModule('/fp-worklet.js'), 6000, 'AudioWorklet addModule 超时');
        const node = new AudioWorkletNode(ctx, 'fp-probe');
        const data = await withTimeout(new Promise((res) => { node.port.onmessage = (e) => res(e.data); }), 5000, 'AudioWorklet 取数超时');
        out.audioworklet = data;
      } finally { try { if (ctx) await ctx.close(); } catch (e) {} }
    }
  } catch (e) { out.audioworklet = { supported: false, error: String(e.message || e) }; }

  return out;
})()`;
}