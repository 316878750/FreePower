import { seededRng, pick, randInt, newSeed } from './rng.js';

/**
 * 指纹生成器 v0（P0）
 * 原则：**先保证自洽，再谈伪装**。任何一条取值都必须和 UA 平台、屏幕、时区对得上，
 * 否则检测方一条对不上，整组作废（技术方案 §6-1）。
 * 这里生成的字段名是「FreePower 内部 schema」，对外的 Local API 字段名等群里和拆解手对齐后映射。
 */

/** 内核真实版本兜底：找不到就用当前系统 Chrome 大版本 */
export const FALLBACK_KERNEL = '156.0.8078.80';

const SCREENS = [
  { width: 1920, height: 1080, device_scale_factor: 1 },
  { width: 1536, height: 864, device_scale_factor: 1.25 },
  { width: 2560, height: 1440, device_scale_factor: 1 },
  { width: 1366, height: 768, device_scale_factor: 1 },
  { width: 1600, height: 900, device_scale_factor: 1 },
];

/** Windows 上真实存在的 ANGLE/D3D11 组合；不造「NVIDIA 报 SwiftShader 行为」那种高危组合 */
const WEBGL_WINDOWS = [
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)' },
];

/** 地区 → 时区/语言。P3 接代理后由出口 IP 推导，P0 先按国家码查表 */
const GEO = {
  US: { timezone: 'America/New_York', language: ['en-US', 'en'], locale: 'en-US' },
  GB: { timezone: 'Europe/London', language: ['en-GB', 'en'], locale: 'en-GB' },
  DE: { timezone: 'Europe/Berlin', language: ['de-DE', 'de', 'en'], locale: 'de-DE' },
  JP: { timezone: 'Asia/Tokyo', language: ['ja-JP', 'ja', 'en'], locale: 'ja-JP' },
  SG: { timezone: 'Asia/Singapore', language: ['en-SG', 'en'], locale: 'en-SG' },
  HK: { timezone: 'Asia/Hong_Kong', language: ['zh-HK', 'zh', 'en'], locale: 'zh-HK' },
  TW: { timezone: 'Asia/Taipei', language: ['zh-TW', 'zh'], locale: 'zh-TW' },
  BR: { timezone: 'America/Sao_Paulo', language: ['pt-BR', 'pt'], locale: 'pt-BR' },
};

/** Windows 字体栈：MVP **不伪装系统字体**，只如实声明（见 README「已知限制」） */
export const WINDOWS_FONTS = [
  'Arial', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas', 'Constantia',
  'Corbel', 'Courier New', 'Ebrima', 'Franklin Gothic Medium', 'Gabriola', 'Gadugi',
  'Georgia', 'Impact', 'Ink Free', 'Javanese Text', 'Leelawadee UI', 'Lucida Console',
  'Lucida Sans Unicode', 'Malgun Gothic', 'Microsoft Himalaya', 'Microsoft JhengHei',
  'Microsoft New Tai Lue', 'Microsoft PhagsPa', 'Microsoft Sans Serif', 'Microsoft Tai Le',
  'Microsoft YaHei', 'Microsoft Yi Baiti', 'MingLiU-ExtB', 'Mongolian Baiti',
  'MS Gothic', 'MV Boli', 'Myanmar Text', 'Nirmala UI', 'Palatino Linotype',
  'Segoe MDL2 Assets', 'Segoe Print', 'Segoe Script', 'Segoe UI', 'Segoe UI Emoji',
  'Segoe UI Historic', 'Segoe UI Symbol', 'SimSun', 'Sitka', 'Sylfaen', 'Symbol',
  'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Webdings', 'Wingdings',
  'Yu Gothic',
];

function uaMetadataFor(kernelFull, winVersion) {
  const major = String(kernelFull).split('.')[0];
  const full = kernelFull;
  const greaseVersion = '24';
  const greaseBrand = 'Not_A Brand';
  return {
    brands: [
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major },
      { brand: greaseBrand, version: greaseVersion },
    ],
    fullVersionList: [
      { brand: 'Chromium', version: full },
      { brand: 'Google Chrome', version: full },
      { brand: greaseBrand, version: `${greaseVersion}.0.0.0` },
    ],
    platform: 'Windows',
    platformVersion: winVersion === '11' ? '15.0.0' : '10.0.0',
    architecture: 'x86',
    model: '',
    mobile: false,
    bitness: '64',
    wow64: false,
  };
}

/**
 * @param {object} opts
 * @param {string} [opts.seed]    指纹种子，同种子出同一指纹
 * @param {string} [opts.kernel]  内核完整版本号（必须等于真实内核，否则 UA 对不上 Browser.getVersion）
 * @param {string} [opts.country] ISO 国家码，决定时区/语言
 */
export function generateFingerprint(opts = {}) {
  const seed = opts.seed || newSeed();
  const rng = seededRng(seed);
  const kernelFull = opts.kernel || FALLBACK_KERNEL;
  const kernelMajor = String(kernelFull).split('.')[0];
  const winVersion = rng() < 0.7 ? '11' : '10';
  const winNT = winVersion === '11' ? '10.0' : '10.0';
  const geo = GEO[String(opts.country || 'US').toUpperCase()] || GEO.US;
  const screen = pick(rng, SCREENS);
  const webgl = pick(rng, WEBGL_WINDOWS);
  const hc = pick(rng, [8, 12, 16, 4]);
  const dm = hc === 4 ? 4 : 8;

  return {
    seed,
    kernel: {
      full_version: kernelFull,
      major: kernelMajor,
      channel: 'stable',
    },
    ua: `Mozilla/5.0 (Windows NT ${winNT}; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${kernelMajor}.0.0.0 Safari/537.36`,
    ua_metadata: uaMetadataFor(kernelFull, winVersion),
    platform: 'Win32',
    language: geo.language,
    locale: geo.locale,
    timezone: geo.timezone,
    screen: { width: screen.width, height: screen.height, color_depth: 24, avail_width: screen.width, avail_height: screen.height - 40 },
    device_scale_factor: screen.device_scale_factor,
    hardware_concurrency: hc,
    device_memory: dm,
    webgl,
    canvas: { mode: 'seeded-noise', seed, strength: 1 },
    audio: { mode: 'seeded-noise', seed },
    fonts: { list: WINDOWS_FONTS, spoofed: false, note: 'MVP 不伪装系统字体，见 README 已知限制' },
    webrtc: { policy: 'disable_non_proxied_udp' },
    media_devices: { audioinput: 2, videoinput: 1, audiooutput: 2 },
  };
}

/** 新指纹：只换种子重算，保证同环境换指纹是「整组换」，不是零散改一个字段 */
export function regenerateFingerprint(fp, opts = {}) {
  return generateFingerprint({ seed: opts.seed || newSeed(), kernel: fp?.kernel?.full_version, country: opts.country });
}
