/**
 * 自检探针：在**目标环境自己的页面里**跑，读回页面真实看到的指纹。
 *
 * 不在主进程里「模拟」，因为主进程不知道 CDP/注入有没有真的生效。
 * 这个脚本对页面只读 + 建临时 DOM（测完删掉），不联网（WebRTC 不配 STUN），
 * 所以代理环境里也能跑，不依赖出口接口。
 */
export function buildProbeSource() {
  return `(async () => {
  'use strict';
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
  out.mediaMode = window.__fpMediaMode || null;
  out.applied = window.__fpApplied ? Array.prototype.slice.call(window.__fpApplied) : [];
  out.seeds = window.__fpSeeds || null;
  out.fontsDeclared = window.__fpFontsDeclared || null;
  out.installed = !!window.__fpInstalled;

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
    for (let i = 0; i < Math.min(ch.length, 2048); i++) {
      sum += Math.abs(ch[i]);
      if (i < 128) parts.push(ch[i].toFixed(8));
    }
    return { supported: true, sum: sum.toFixed(10), hash: hashStr(parts.join(',')) };
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

  /* ---------- 字体：检测真实安装的字体（不伪装，只观察） ---------- */
  try {
    const FONTS = ['Arial', 'Arial Black', 'Calibri', 'Cambria', 'Comic Sans MS', 'Consolas',
      'Courier New', 'Georgia', 'Impact', 'Segoe UI', 'Tahoma', 'Times New Roman',
      'Trebuchet MS', 'Verdana', 'Microsoft YaHei', 'SimSun', 'Segoe UI Emoji', 'Wingdings'];
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
      declared: out.fontsDeclared,
      check: (() => {
        try { return FONTS.filter((f) => document.fonts && document.fonts.check('12px "' + f + '"')).slice(0, 18); }
        catch (e) { return []; }
      })(),
    };
  } catch (e) { out.fonts = { error: String(e) }; }

  /* ---------- 媒体设备 ---------- */
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      const list = await navigator.mediaDevices.enumerateDevices();
      out.media_devices = {
        supported: true,
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

  return out;
})()`;
}