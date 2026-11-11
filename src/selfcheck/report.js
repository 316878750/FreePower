/**
 * 自检报告：把「页面实际读到的值」和「环境声明的值」逐项对齐。
 *
 * 覆盖度（full / partial / none）直接取字段表 packages/profile 的 coverage 标注，
 * 不自己发明一套 —— 这样报告里的黄/绿和产品文案里的 38/36/4 是同一份事实。
 *
 * 报告是产品卖点，也是唯一能自证「没吹牛」的东西：partial 就写 partial，
 * 不把「值对上了」说成「不会被检测」。
 */
import { BY_NAME } from '../../packages/profile/src/fields.js';
import { isPrivateIp } from '../../packages/profile/src/validate.js';
import { fingerprintView, declaredSnapshot } from '../fingerprint/view.js';

const coverageOf = (field) => (BY_NAME.get(field) || {}).coverage || 'n/a';

function verdict(match, coverage) {
  if (!match) return 'fail';
  return coverage === 'full' ? 'pass' : 'warn';
}

function sameList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function findBrandVersion(list) {
  if (!Array.isArray(list)) return null;
  const hit = list.find((b) => b && (b.brand === 'Google Chrome' || b.brand === 'Chromium'));
  return hit ? String(hit.version) : null;
}

function publicIpv4(ips) {
  return (ips || []).filter((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !isPrivateIp(ip) && ip !== '0.0.0.0');
}

function item(id, field, label, { match, declared, actual, note, coverage, status }) {
  const cov = coverage || coverageOf(field);
  return {
    id,
    label,
    field,
    coverage: cov,
    status: status || verdict(match, cov),
    declared: declared === undefined ? null : declared,
    actual: actual === undefined ? null : actual,
    note: note || null,
  };
}

/** 噪点维度：关了算「按配置关闭」，开了要求 patch 生效 + 同页两次一致 + 跨重启一致 */
function noiseItem({ id, field, label, enabled, applied, stable, hash, crossOk, noteWhenOn }) {
  const on = !!enabled;
  if (!on) {
    return item(id, field, label, {
      match: true,
      status: 'pass',
      declared: 'off',
      actual: 'off',
      note: '环境按配置关闭了该维度噪声（该维度不具备保护，属于显式选择）',
    });
  }
  const appliedOk = applied.includes(id === 'webgl_image' ? 'webgl_image' : id);
  const match = appliedOk && stable !== false && crossOk !== false;
  const notes = [];
  if (!appliedOk) notes.push('注入未生效（页面里没有对应 patch 标记）');
  if (stable === false) notes.push('同页两次读取不一致（会被判为随机噪声）');
  if (crossOk === false) notes.push('跨重启哈希变化（种子没落库或被重置）');
  if (noteWhenOn) notes.push(noteWhenOn);
  return item(id, field, label, {
    match,
    declared: 'on',
    actual: appliedOk ? `hash=${hash || 'n/a'}` : 'not applied',
    note: notes.join('；') || null,
  });
}

/**
 * @param {object} profile 平铺记录
 * @param {object} raw 探针返回值
 * @param {object} opts { kernelVersion, previous }
 */
export function buildReport(profile, raw, { kernelVersion = null, previous = null, context = null } = {}) {
  const view = fingerprintView(profile);
  const applied = Array.isArray(raw.applied) ? raw.applied : [];
  const ctx = context || { secure: !!raw.isSecureContext, url: null, note: null };
  const insecureNote = ctx.secure === false
    ? `本次在非安全上下文（${ctx.url || 'about:blank'}）里跑：navigator.userAgentData 只在 secure context 暴露，UA-CH 未能验证${ctx.note ? `；${ctx.note}` : ''}`
    : null;
  const items = [];

  /* 1. UA */
  {
    const declared = view.ua || null;
    const actual = raw.ua || '';
    const match = !declared || actual === declared;
    items.push(item('ua', 'ua', 'User-Agent', {
      match,
      declared,
      actual,
      note: match ? null : '页面 UA 与声明不一致：注入/命令行没生效，或内核改了默认 UA',
    }));
  }

  /* 2. UA-CH */
  {
    const md = view.ua_metadata || null;
    const high = raw.uaDataHigh && !raw.uaDataHigh.error ? raw.uaDataHigh : null;
    const brands = (raw.uaData && raw.uaData.brands) || (high && high.fullVersionList) || [];
    const wantFull = md && md.fullVersionList ? findBrandVersion(md.fullVersionList) : null;
    const gotFull = findBrandVersion(high && high.fullVersionList) || findBrandVersion(brands);
    const wantPlatform = md ? md.platform : null;
    const gotPlatform = (high && high.platform) || (raw.uaData && raw.uaData.platform) || null;
    const wantMajor = md && md.brands ? findBrandVersion(md.brands) : null;
    const gotMajor = findBrandVersion(brands);
    const match = !md ? true
      : (!wantFull || gotFull === wantFull) && (!wantPlatform || gotPlatform === wantPlatform) && (!wantMajor || gotMajor === wantMajor);
    const unverified = raw.uaData == null;
    items.push(item('client_hints', 'client_hints', 'UA-CH / Client Hints', {
      match: unverified && ctx.secure === false ? true : match,
      status: unverified ? (ctx.secure === false ? 'warn' : 'fail') : undefined,
      declared: md ? { platform: wantPlatform, fullVersionList: md.fullVersionList } : null,
      actual: raw.uaData ? { platform: gotPlatform, brands, fullVersionList: high ? high.fullVersionList : null } : null,
      note: raw.uaData ? (match ? null : 'UA-CH 与声明不一致（常见原因：内核升级后没跟版）')
        : (insecureNote || '页面没有 navigator.userAgentData（非 Chromium）'),
    }));
  }

  /* 3. platform */
  {
    const declared = view.platform;
    const actual = raw.platform;
    items.push(item('platform', 'platform', 'navigator.platform', {
      match: String(declared) === String(actual),
      declared,
      actual,
      note: String(declared) === String(actual) ? null : 'CDP UA override 的 platform 没生效',
    }));
  }

  /* 4. 语言 */
  {
    const declared = view.language.slice();
    const actual = Array.isArray(raw.languages) ? raw.languages : [];
    const match = sameList(declared, actual);
    items.push(item('languages', 'language', '语言 / Accept-Language', {
      match,
      declared,
      actual,
      note: match ? null : 'navigator.languages 与声明不一致（--accept-lang / Emulation 没生效）',
    }));
  }

  /* 5. 时区 */
  {
    const declared = view.timezone;
    const actual = raw.timezone;
    const match = declared === actual;
    items.push(item('timezone', 'timezone', '时区（Intl）', {
      match,
      declared,
      actual,
      note: match ? null : 'Emulation.setTimezoneOverride 没生效',
    }));
  }

  /* 6. 屏幕 */
  {
    const s = view.screen;
    const want = s ? [s.width, s.height, view.device_scale_factor] : null;
    const got = raw.screen ? [raw.screen.width, raw.screen.height, raw.screen.dpr] : null;
    const match = !want || (String(want[0]) === String(got[0]) && String(want[1]) === String(got[1]) && Number(want[2]) === Number(got[2]));
    items.push(item('screen', 'screen_resolution', '屏幕 / DPR', {
      match,
      declared: want,
      actual: got,
      note: match ? null : 'Emulation.setDeviceMetricsOverride 没生效',
    }));
  }

  /* 7. 硬件 */
  {
    const declared = { hardwareConcurrency: view.hardware_concurrency ?? null, deviceMemory: view.device_memory ?? null };
    const actual = { hardwareConcurrency: raw.cores ?? null, deviceMemory: raw.memory ?? null };
    const match = (declared.hardwareConcurrency == null || String(declared.hardwareConcurrency) === String(actual.hardwareConcurrency))
      && (declared.deviceMemory == null || String(declared.deviceMemory) === String(actual.deviceMemory));
    items.push(item('hardware', 'hardware_concurrency', '硬件参数（cores / memory）', {
      match,
      declared,
      actual,
      note: match ? null : 'navigator 属性覆写没生效',
    }));
  }

  /* 8. WebGL 标识 */
  {
    const declared = view.webgl;
    const w = raw.webgl || {};
    const match = !declared || (w.vendor === declared.vendor && w.renderer === declared.renderer);
    items.push(item('webgl', 'webgl', 'WebGL vendor / renderer', {
      match,
      declared: declared ? [declared.vendor, declared.renderer] : null,
      actual: w.supported ? {
        vendor: w.vendor, renderer: w.renderer, version: w.version,
        extensions: w.extensions, maxTextureSize: w.maxTextureSize, precision: w.precision,
      } : { supported: false },
      note: match
        ? 'vendor/renderer 已对齐；扩展、精度、最大纹理尺寸与实际渲染输出仍来自真实 GPU 驱动'
        : 'getParameter 覆写没生效',
    }));
  }

  /* 9-12. 四个噪点维度 */
  const wgl = raw.webgl || {};
  const det = raw.canvas && raw.canvas.stable != null ? raw.canvas.stable : null;
  const hashes = {
    canvas: raw.canvas && raw.canvas.hash || null,
    webgl_image: wgl.image_hash || null,
    audio: raw.audio && raw.audio.hash || null,
    client_rects: raw.client_rects && raw.client_rects.hash || null,
  };
  const prevHashes = previous && previous.hashes ? previous.hashes : null;
  const prevSameKernel = prevHashes && previous.kernel_version && kernelVersion && previous.kernel_version === kernelVersion;
  const cross = (key, enabled) => (enabled && prevSameKernel && prevHashes[key] != null && hashes[key] != null
    ? prevHashes[key] === hashes[key] : null);

  items.push(noiseItem({
    id: 'canvas', field: 'canvas', label: 'Canvas 哈希',
    enabled: !!view.canvas, applied, stable: det, hash: hashes.canvas,
    crossOk: cross('canvas', !!view.canvas),
    noteWhenOn: '像素噪声只在 getImageData/toDataURL/toBlob/OffscreenCanvas 上；WebGPU、createImageBitmap 等新 API 是盲区',
  }));
  items.push(noiseItem({
    id: 'webgl_image', field: 'webgl_image', label: 'WebGL 图像哈希',
    enabled: !!view.webgl_image, applied, stable: wgl.stable, hash: hashes.webgl_image,
    crossOk: cross('webgl_image', !!view.webgl_image),
    noteWhenOn: '只扰动 readPixels 返回值；真实光栅化结果与 GPU 计时仍来自驱动',
  }));
  items.push(noiseItem({
    id: 'audio', field: 'audio', label: 'Audio 哈希',
    enabled: !!view.audio, applied, stable: raw.audio && raw.audio.stable, hash: hashes.audio,
    crossOk: cross('audio', !!view.audio),
    noteWhenOn: '只改 AudioBuffer 读出值；AudioWorklet/实时音频线程是盲区',
  }));
  items.push(noiseItem({
    id: 'client_rects', field: 'client_rects', label: 'ClientRects 哈希',
    enabled: !!view.client_rects, applied, stable: raw.client_rects && raw.client_rects.stable, hash: hashes.client_rects,
    crossOk: cross('client_rects', !!view.client_rects),
    noteWhenOn: '只改 getBoundingClientRect；getClientRects/Range 与真实布局引擎仍可交叉验证',
  }));

  /* 13. 字体：只声明，不伪装 */
  {
    const declared = view.fonts;
    const f = raw.fonts || {};
    const detected = Array.isArray(f.detected) ? f.detected : [];
    const specific = Array.isArray(declared) && !(declared.length === 1 && declared[0] === 'all');
    const missing = specific ? declared.filter((x) => !detected.includes(x)) : [];
    items.push(item('fonts', 'fonts', '字体可检测项', {
      match: true,
      status: 'warn',
      declared,
      actual: { detected: detected.length, sample: detected.slice(0, 8), missingDeclared: missing },
      note: specific && missing.length
        ? `字体未伪装，且声明的 ${missing.length} 个字体本机不存在：${missing.slice(0, 5).join(', ')}`
        : '字体未伪装：只声明，真实字形与宽度度量仍来自系统 DirectWrite（字段表标 none）',
    }));
  }

  /* 14. 媒体设备 */
  {
    const m = raw.media_devices || {};
    const mode = view.media ? view.media.mode : '0';
    if (mode === '0') {
      items.push(item('media_devices', 'media_devices', '媒体设备', {
        match: true, status: 'pass', declared: 'real', actual: m.counts || null,
        note: '按配置使用真实设备（未注入）',
      }));
    } else {
      const want = view.media.counts;
      const got = m.counts || {};
      const match = m.supported && String(want.audioinput_num) === String(got.audioinput || 0)
        && String(want.videoinput_num) === String(got.videoinput || 0)
        && String(want.audiooutput_num) === String(got.audiooutput || 0);
      const fallback = raw.mediaMode === 'fallback';
      items.push(item('media_devices', 'media_devices', '媒体设备', {
        match,
        status: m.supported ? undefined : 'warn',
        declared: want,
        actual: m.supported ? { counts: got, sample: (m.list || []).slice(0, 4).map((d) => `${d.kind}: ${d.label || '(空)'}`) } : { supported: false, error: m.error },
        note: !m.supported
          ? `媒体设备接口不可用（${ctx.secure === false ? '非安全上下文' : '页面未暴露'}），数量无法验证`
          : (match
            ? `enumerateDevices 已按声明数量返回${fallback ? '（非安全上下文，由注入兜底实现；真实设备行为拦不住）' : '；getUserMedia 的真实设备行为拦不住'}`
            : 'enumerateDevices 与声明数量不一致'),
      }));
    }
  }

  /* 15. WebRTC */
  {
    const w = raw.webrtc || {};
    const policy = view.webrtc;
    const pub = publicIpv4(w.addresses);
    let match = true;
    let status;
    let note;
    if (policy === 'disabled' && pub.length) {
      match = false;
      status = 'fail';
      note = `WebRTC 已声明 disabled，但仍暴露公网地址：${pub.join(', ')}`;
    } else if (pub.length) {
      status = 'warn';
      note = `候选里出现公网地址 ${pub.join(', ')}；请确认它等于代理出口（UDP 不经代理时就是泄漏）`;
    } else {
      status = 'pass';
      note = !w.supported ? '浏览器不支持 RTCPeerConnection'
        : (w.count === 0
          ? '没有产生任何 ICE 候选（UDP 已被启动参数策略关闭）；自检不配 STUN（配了才会真去泄漏），所以这里验证的是「策略生效」'
          : '未发现公网候选地址（只有 mDNS/本机候选）');
    }
    items.push(item('webrtc', 'webrtc', 'WebRTC 泄漏', {
      match, status,
      declared: policy,
      actual: w.supported ? { candidates: w.count, types: w.types, publicAddresses: pub } : { supported: false },
      note,
    }));
  }

  /* ---------- 16-18. 双 Realm：专用 worker / SharedWorker / ServiceWorker ----------
   * 这是 P7 的核心断言：worker 里取一遍原生函数、再和主帧比对，是检测方的常规套路。
   * 所以这里不只要求「注入过」，还要求「脚本首行之前就注入了」+「关键值与主帧同值」。
   */
  {
    const realm = raw.workers || {};
    const main = realm.main || null;
    const realmNote = realm.note || null;
    /** 必须与主帧一致的字段（canvas 单独比，因为它才是噪声同源的直接证据） */
    const REALM_FIELDS = [
      ['ua', 'UA'],
      ['platform', 'platform'],
      ['cores', '核数'],
      ['memory', '内存'],
      ['language', '语言'],
      ['languages', 'languages'],
      ['timezone', '时区'],
    ];
    const kinds = [
      ['worker', 'dedicated', '专用 Worker'],
      ['shared_worker', 'shared', 'SharedWorker'],
      ['service_worker', 'service', 'ServiceWorker'],
    ];
    for (const [field, key, label] of kinds) {
      const id = `realm_${key}`;
      const w = realm[key] || null;
      if (!w) {
        items.push(item(id, field, `${label}（双 Realm）`, {
          match: true,
          status: 'warn',
          coverage: 'partial',
          declared: '首行前注入 + 与主帧同值',
          actual: null,
          note: realmNote || `${label} 本次没有跑到，未能验证`,
        }));
        continue;
      }
      if (w.ok === false) {
        items.push(item(id, field, `${label}（双 Realm）`, {
          match: false,
          status: 'warn',
          coverage: 'partial',
          declared: '首行前注入 + 与主帧同值',
          actual: { error: w.error || 'unknown' },
          note: `${label} 本次未能取到数：${w.error || 'unknown'}（属于「本次未验证」，不是「已验证失败」）`,
        }));
        continue;
      }

      const diffs = [];
      for (const [k, name] of REALM_FIELDS) {
        const a = main ? main[k] : undefined;
        if (a === undefined || a === null) continue;
        if (String(a) !== String(w[k])) diffs.push(`${name} 主帧 ${a} / worker ${w[k]}`);
      }
      if (main && main.canvas_dom && w.canvas && main.canvas_dom !== w.canvas) {
        diffs.push(`canvas 主帧 DOM ${main.canvas_dom} / worker ${w.canvas}`);
      }
      if (main && main.canvas_offscreen && w.canvas && main.canvas_offscreen !== w.canvas) {
        diffs.push(`canvas 主帧 OffscreenCanvas ${main.canvas_offscreen} / worker ${w.canvas}`);
      }

      const injectedAtTop = w.atTop === 'worker';
      let status;
      let note;
      if (!injectedAtTop) {
        status = 'fail';
        note = `注入没有在脚本首行之前生效（首行读到 realm=${JSON.stringify(w.atTop == null ? null : w.atTop)}），worker 顶层存在裸窗口`;
      } else if (diffs.length) {
        status = 'warn';
        note = `与主帧不一致：${diffs.slice(0, 4).join('；')}`;
      } else {
        status = 'pass';
        note = '脚本首行即已注入；硬件、语言、时区、canvas 哈希与主帧同值';
      }
      items.push(item(id, field, `${label}（双 Realm）`, {
        match: status === 'pass',
        status,
        coverage: 'partial',
        declared: '首行前注入 + 与主帧同值',
        actual: {
          atTop: w.atTop,
          realm: w.realm || null,
          ua: w.ua || null,
          platform: w.platform || null,
          cores: w.cores ?? null,
          memory: w.memory ?? null,
          timezone: w.timezone || null,
          canvas: w.canvas || null,
          applied: Array.isArray(w.applied) ? w.applied : [],
        },
        note,
      }));
    }
  }

  /* 19. AudioWorklet：明确 none，并说清「裸的不是音频指纹本体」 */
  {
    const wl = raw.audioworklet || {};
    const detail = wl.ok === false || wl.error
      ? { supported: false, error: wl.error || 'unknown' }
      : {
        hasNavigator: wl.hasNavigator,
        hasCanvas: wl.hasCanvas,
        fpInjected: wl.fpInjected,
        sampleRate: wl.sampleRate,
        currentTime: wl.currentTime,
        surfaces: wl.surfaces || null,
      };
    items.push(item('audio_worklet', 'audio', 'AudioWorklet 作用域', {
      match: true,
      status: 'warn',
      coverage: 'none',
      declared: 'none（明确不注入）',
      actual: detail,
      note: wl.error ? `本次未能取到 AudioWorklet 实测值：${wl.error}`
        : `AudioWorkletGlobalScope 没有独立 target、没有干净注入通道，靠 Fetch 改 JS 会被 import.meta.url 与模块完整性检测抓，所以明确标 none。`
          + `但**音频指纹本体不在这里**：本体是主帧 OfflineAudioContext 的浮点采样，已由 audio 维度覆盖；这个作用域里裸的只有 sampleRate / currentTime（实测 ${wl.sampleRate} / ${wl.currentTime}）。`,
    }));
  }

  /* ---------- 汇总 ---------- */
  const summary = {
    total: items.length,
    full: items.filter((i) => i.coverage === 'full').length,
    partial: items.filter((i) => i.coverage === 'partial').length,
    none: items.filter((i) => i.coverage === 'none').length,
    pass: items.filter((i) => i.status === 'pass').length,
    warn: items.filter((i) => i.status === 'warn').length,
    fail: items.filter((i) => i.status === 'fail').length,
  };
  const weight = { pass: 1, warn: 0.6, fail: 0 };
  summary.score = Math.round((items.reduce((s, i) => s + weight[i.status], 0) / items.length) * 100);

  const determinism = {
    canvas: raw.canvas ? raw.canvas.stable !== false : null,
    webgl_image: wgl.stable !== false,
    audio: raw.audio ? raw.audio.stable !== false : null,
    client_rects: raw.client_rects ? raw.client_rects.stable !== false : null,
    cross_restart: prevSameKernel ? ['canvas', 'webgl_image', 'audio', 'client_rects']
      .filter((k) => (k === 'canvas' ? !!view.canvas : k === 'webgl_image' ? !!view.webgl_image : k === 'audio' ? !!view.audio : !!view.client_rects))
      .every((k) => hashes[k] === prevHashes[k]) : null,
    compared_with: prevSameKernel ? previous.generated_at : null,
    note: prevSameKernel ? null : '没有同内核留存的上一份报告，本次不判断跨重启一致性',
  };

  return {
    generated_at: new Date().toISOString(),
    profile_id: profile.id || profile.profile_id || null,
    profile_no: profile.profile_no ?? null,
    name: profile.name || null,
    kernel_version: kernelVersion,
    engine: 'cdp-js',
    seed: String(view.seed),
    summary,
    determinism,
    hashes,
    declared: declaredSnapshot(profile, view),
    context: ctx,
    items,
    caveat: 'CDP 天花板是结构性的：值对得上不等于过检测站。partial 项仍可被识别——本机实测的残留方向：嵌套 worker（worker 内再起 worker，未覆盖）、OOPIF 子帧（只计数不注入）、AudioWorklet 作用域（标 none）、Function.prototype.toString 痕迹、字体度量与驱动行为。',
    raw,
  };
}