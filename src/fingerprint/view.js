/**
 * 平铺字段 → 注入层/启动层需要的嵌套视图。
 * 单一事实源是 profile 记录（平铺列 + fingerprint_config），这里只做派生，不回写。
 */

function toBool(v) {
  return v === true || v === '1' || v === 1;
}

function parseScreen(screenResolution) {
  if (!screenResolution || screenResolution === 'none' || screenResolution === 'random') return null;
  const m = /^(\d{2,5})_(\d{2,5})$/.exec(String(screenResolution));
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return { width, height, color_depth: 24, avail_width: width, avail_height: height - 40 };
}

/** CDP Emulation.setUserAgentOverride 的 userAgentMetadata 形状 */
function uaMetadata(clientHints) {
  const h = clientHints || {};
  const full = typeof h.ua_full_version === 'string' ? h.ua_full_version : null;
  if (!full) return undefined;
  const major = full.split('.')[0];
  return {
    brands: [
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major },
      { brand: 'Not_A Brand', version: '24' },
    ],
    fullVersionList: [
      { brand: 'Chromium', version: full },
      { brand: 'Google Chrome', version: full },
      { brand: 'Not_A Brand', version: '24.0.0.0' },
    ],
    platform: h.platform || 'Windows',
    platformVersion: h.platform_version || '10.0.0',
    architecture: h.architecture || 'x86',
    model: h.model || '',
    mobile: toBool(h.mobile),
    bitness: h.bitness || '64',
    wow64: toBool(h.wow64),
  };
}

/**
 * @param {object} profile 平铺记录
 * @returns {object} 注入层视图
 */
export function fingerprintView(profile) {
  const p = profile || {};
  const gl = p.webgl_config || {};
  const webglOn = String(p.webgl) === '2' && gl.unmasked_vendor && gl.unmasked_renderer;
  const language = Array.isArray(p.language) && p.language.length ? p.language : ['en-US'];
  return {
    seed: p.fp_seed ?? p.canvas_id ?? p.id ?? 'freepower',
    platform: p.platform || 'Win32',
    language,
    locale: p.page_language && p.page_language !== 'native' ? p.page_language : language[0],
    timezone: p.timezone || 'UTC',
    ua: p.ua || undefined,
    ua_metadata: uaMetadata(p.client_hints),
    hardware_concurrency: typeof p.hardware_concurrency === 'number' ? p.hardware_concurrency : undefined,
    device_memory: typeof p.device_memory === 'number' ? p.device_memory : undefined,
    webgl: webglOn ? { vendor: gl.unmasked_vendor, renderer: gl.unmasked_renderer } : null,
    canvas: String(p.canvas) === '1' ? { strength: 1, seed: p.canvas_id ?? p.fp_seed } : null,
    webgl_image: String(p.webgl_image) === '1',
    audio: String(p.audio) === '1' ? { seed: p.audio_id ?? p.fp_seed } : null,
    client_rects: String(p.client_rects) === '1' ? { seed: p.client_rects_id ?? p.fp_seed } : null,
    screen: parseScreen(p.screen_resolution),
    device_scale_factor: typeof p.device_scale === 'number' ? p.device_scale : 1,
    webrtc: p.webrtc || 'disabled',
    media_devices: p.media_devices,
    media_devices_num: p.media_devices_num || null,
    kernel_version: p.kernel_version || null,
  };
}

/** 自检页要用的「声明值」快照（不含注入层内部结构） */
export function declaredSnapshot(profile, view = fingerprintView(profile)) {
  return {
    ua: view.ua,
    platform: view.platform,
    languages: view.language,
    timezone: view.timezone,
    locale: view.locale,
    hardware_concurrency: view.hardware_concurrency,
    device_memory: view.device_memory,
    screen: view.screen ? [view.screen.width, view.screen.height] : null,
    device_scale: view.device_scale_factor,
    webgl: view.webgl ? [view.webgl.vendor, view.webgl.renderer] : null,
    webrtc: view.webrtc,
    seed: String(view.seed),
  };
}