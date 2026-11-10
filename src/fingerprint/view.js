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

/** hardware_concurrency / device_memory：'default' 表示不覆盖，数字字符串也认 */
function numOrDefault(v) {
  if (v === undefined || v === null || v === 'default' || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
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

/** 噪点维度：关掉返回 null；种子取各自入库的 *_id，缺省才回落到 fp_seed */
function noiseConfig(profile, field, strength = 1) {
  if (String(profile[field]) !== '1') return null;
  const idField = `${field}_id`;
  return {
    seed: String(profile[idField] ?? profile.fp_seed ?? profile.id ?? 'freepower'),
    strength,
  };
}

/**
 * 媒体设备视图：
 *   media_devices 0=真实（不注入）、1=随机（按数量随机生成）、2=手动（用 media_devices_config）
 * 数量字段在拆解里是字符串 "1".."9"，这里统一成数字。
 */
function mediaView(profile) {
  const mode = String(profile.media_devices ?? '0');
  if (mode !== '1' && mode !== '2') return null;
  const raw = profile.media_devices_num || {};
  const count = (v, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 9) : dflt;
  };
  const counts = {
    audioinput_num: count(raw.audioinput_num, 1),
    videoinput_num: count(raw.videoinput_num, 1),
    audiooutput_num: count(raw.audiooutput_num, 2),
  };
  const devices = Array.isArray(profile.media_devices_config) ? profile.media_devices_config : [];
  return { mode, counts, devices };
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
    seed: String(p.fp_seed ?? p.canvas_id ?? p.id ?? 'freepower'),
    platform: p.platform || 'Win32',
    language,
    locale: p.page_language && p.page_language !== 'native' ? p.page_language : language[0],
    timezone: p.timezone || 'UTC',
    ua: p.ua || undefined,
    ua_metadata: uaMetadata(p.client_hints),
    hardware_concurrency: numOrDefault(p.hardware_concurrency),
    device_memory: numOrDefault(p.device_memory),
    webgl: webglOn ? { vendor: gl.unmasked_vendor, renderer: gl.unmasked_renderer } : null,
    canvas: noiseConfig(p, 'canvas'),
    webgl_image: noiseConfig(p, 'webgl_image'),
    audio: noiseConfig(p, 'audio'),
    client_rects: noiseConfig(p, 'client_rects'),
    screen: parseScreen(p.screen_resolution),
    device_scale_factor: typeof p.device_scale === 'number' ? p.device_scale : 1,
    webrtc: p.webrtc || 'disabled',
    media: mediaView(p),
    fonts: Array.isArray(p.fonts) ? p.fonts : ['all'],
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
    hardware_concurrency: view.hardware_concurrency ?? null,
    device_memory: view.device_memory ?? null,
    screen: view.screen ? [view.screen.width, view.screen.height] : null,
    device_scale: view.device_scale_factor,
    webgl: view.webgl ? [view.webgl.vendor, view.webgl.renderer] : null,
    webgl_image: !!view.webgl_image,
    webrtc: view.webrtc,
    media_devices: view.media ? view.media.mode : '0',
    media_counts: view.media ? view.media.counts : null,
    fonts: view.fonts,
    seed: String(view.seed),
  };
}
