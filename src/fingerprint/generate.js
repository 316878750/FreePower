/**
 * 指纹生成器 v1 —— 输出「平铺字段模型」（与 packages/profile 的字段表一一对应）。
 *
 * 原则不变：先自洽再伪装。任何取值都要和 UA 平台、屏幕、时区、内核真实版本对得上。
 * 与 v0 的区别：不再产出嵌套的 FreePower 私有结构，直接产出 Local API 认识的字段；
 * 注入层需要的嵌套视图由 src/fingerprint/view.js 从平铺字段派生。
 */
import { seededRng, pick, newSeed } from './rng.js';

/** 内核真实版本兜底（找不到系统 Chrome 时用） */
export const FALLBACK_KERNEL = '156.0.8078.80';

const SCREENS = [
  { width: 1920, height: 1080, scale: 1 },
  { width: 1536, height: 864, scale: 1.25 },
  { width: 2560, height: 1440, scale: 1 },
  { width: 1366, height: 768, scale: 1 },
  { width: 1600, height: 900, scale: 1 },
];

/** 真实的 Windows ANGLE/D3D11 组合；不造「报 NVIDIA 却像 SwiftShader」的高危组合 */
const WEBGL_WINDOWS = [
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)' },
];

/**
 * 国家 → 时区/语言/经纬度。
 * P3 接代理后由出口 IP 推导，这里作为离线兜底表。
 */
const GEO = {
  US: { timezone: 'America/New_York', language: ['en-US', 'en'], lat: 40.7128, lng: -74.006 },
  GB: { timezone: 'Europe/London', language: ['en-GB', 'en'], lat: 51.5074, lng: -0.1278 },
  DE: { timezone: 'Europe/Berlin', language: ['de-DE', 'de', 'en'], lat: 52.52, lng: 13.405 },
  FR: { timezone: 'Europe/Paris', language: ['fr-FR', 'fr'], lat: 48.8566, lng: 2.3522 },
  JP: { timezone: 'Asia/Tokyo', language: ['ja-JP', 'ja', 'en'], lat: 35.6762, lng: 139.6503 },
  SG: { timezone: 'Asia/Singapore', language: ['en-SG', 'en'], lat: 1.3521, lng: 103.8198 },
  HK: { timezone: 'Asia/Hong_Kong', language: ['zh-HK', 'zh', 'en'], lat: 22.3193, lng: 114.1694 },
  TW: { timezone: 'Asia/Taipei', language: ['zh-TW', 'zh'], lat: 25.033, lng: 121.5654 },
  CN: { timezone: 'Asia/Shanghai', language: ['zh-CN', 'zh'], lat: 31.2304, lng: 121.4737 },
  BR: { timezone: 'America/Sao_Paulo', language: ['pt-BR', 'pt'], lat: -23.5505, lng: -46.6333 },
  VN: { timezone: 'Asia/Ho_Chi_Minh', language: ['vi-VN', 'vi'], lat: 10.8231, lng: 106.6297 },
  TH: { timezone: 'Asia/Bangkok', language: ['th-TH', 'th'], lat: 13.7563, lng: 100.5018 },
  ID: { timezone: 'Asia/Jakarta', language: ['id-ID', 'id'], lat: -6.2088, lng: 106.8456 },
};

export function geoFor(country) {
  return GEO[String(country || 'US').toUpperCase()] || GEO.US;
}

/** UA-CH 的 brands/fullVersionList 必须和内核真实版本一致，否则 UA↔UA-CH 对不上 */
function userAgentMetadata(kernelFull, platformVersion) {
  const major = String(kernelFull).split('.')[0];
  const grease = '24';
  return {
    brands: [
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major },
      { brand: 'Not_A Brand', version: grease },
    ],
    fullVersionList: [
      { brand: 'Chromium', version: kernelFull },
      { brand: 'Google Chrome', version: kernelFull },
      { brand: 'Not_A Brand', version: `${grease}.0.0.0` },
    ],
    platform: 'Windows',
    platformVersion,
    architecture: 'x86',
    model: '',
    mobile: false,
    bitness: '64',
    wow64: false,
  };
}

/**
 * @param {object} opts
 * @param {string} [opts.seed]      指纹种子（同种子出同一套指纹）
 * @param {string} [opts.kernel]    内核完整版本号，必须等于真实内核
 * @param {string} [opts.country]   ISO 国家码，决定时区/语言/经纬度
 * @param {object} [opts.base]      在已有字段上做增量（随机指纹时用）
 */
export function generateFingerprint(opts = {}) {
  const seed = opts.seed ?? newSeed();
  const rng = seededRng(String(seed));
  const kernelFull = opts.kernel || FALLBACK_KERNEL;
  const kernelMajor = String(kernelFull).split('.')[0];
  const win11 = rng() < 0.7;
  const geo = geoFor(opts.country);
  const screen = pick(rng, SCREENS);
  const gl = pick(rng, WEBGL_WINDOWS);
  const cores = pick(rng, [8, 12, 16, 4, 6]);
  const memory = cores <= 6 ? 8 : pick(rng, [8, 16, 32]);
  const audioIn = pick(rng, [1, 2, 3]);
  const videoIn = pick(rng, [1, 2]);

  return {
    // 身份自洽：UA 的版本段必须等于内核版本
    ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${kernelMajor}.0.0.0 Safari/537.36`,
    client_hints: {
      platform: 'Windows',
      platform_version: win11 ? '15.0.0' : '10.0.0',
      architecture: 'x86',
      model: '',
      mobile: '0',
      wow64: '0',
      ua_full_version: kernelFull,
      bitness: '64',
    },
    platform: 'Win32',
    // 语言 / 时区 / 地理 不随 IP 自动，避免「声明自动但没代理」时变成真实本机值
    language: geo.language,
    language_switch: '0',
    page_language: geo.language[0],
    page_language_switch: '1',
    timezone: geo.timezone,
    automatic_timezone: '0',
    location: 'allow',
    location_switch: '0',
    latitude: Number(geo.lat.toFixed(6)),
    longitude: Number(geo.lng.toFixed(6)),
    accuracy: 1000,
    // 屏幕 / 硬件
    screen_resolution: `${screen.width}_${screen.height}`,
    device_scale: screen.scale,
    hardware_concurrency: cores,
    device_memory: memory,
    device_name_switch: '1',
    // 噪点四件套：全部开，种子确定性
    canvas: '1',
    canvas_id: seedOf(seed, 1),
    webgl_image: '1',
    webgl_image_id: seedOf(seed, 2),
    audio: '1',
    audio_id: seedOf(seed, 3),
    client_rects: '1',
    client_rects_id: seedOf(seed, 4),
    webgl: '2',
    webgl_config: {
      unmasked_vendor: gl.vendor,
      unmasked_renderer: gl.renderer,
      webgpu: { webgpu_switch: '1' },
    },
    // 字体：MVP 不伪装系统字体（CDP 路线硬伤，标黄）
    fonts: ['all'],
    // 媒体设备
    media_devices: '2',
    media_devices_num: { audioinput_num: audioIn, videoinput_num: videoIn, audiooutput_num: 2 },
    // 网络：默认禁非代理 UDP；端口扫描白名单空 = 一个都不许
    webrtc: 'disable_udp',
    scan_port_type: '1',
    allow_scan_ports: '',
    // 隐私开关
    flash: 'block',
    do_not_track: 'default',
    automation_controlled: '0',
    tls_switch: '0',
    ban_dev_tools: '0',
    // 窗口
    headless: '0',
    window_position: 'default',
  };
}

/** 有符号 32 位整数种子（对齐拆解实测：AudioFp / ClientRectFp 用有符号整数） */
function seedOf(seedStr, salt) {
  let h = (2166136261 ^ salt) >>> 0;
  const s = `${seedStr}:${salt}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h | 0;
}

/** 新指纹：只换种子重算，保证「整组换」，不是零散改一个字段 */
export function regenerateFingerprint(base = {}, opts = {}) {
  return { ...base, ...generateFingerprint({ seed: opts.seed ?? newSeed(), kernel: opts.kernel, country: opts.country }) };
}