// FreePower · 字段校验与一致性检查
// 值域严格照拆解表 §12，默认值来自人工覆盖层（服务端默认值未拿到 → 标【推测】）。
import { BY_NAME } from './fields.js';

const IANA_TZ = new Set(Intl.supportedValuesOf('timeZone'));

/**
 * 时区合法性：`Intl.supportedValuesOf('timeZone')` 不含 UTC / Etc/GMT 这类
 * 「合法但不在枚举里」的 ID（`Asia/Calcutta` 这种别名同理），
 * 真正的判据是 Intl 自己认不认，所以先查表、表里没有再让 Intl 试一次。
 */
export function isValidTimezone(value) {
  if (typeof value !== 'string' || !value) return false;
  const tz = value.replace(/ /g, '_');
  if (IANA_TZ.has(tz)) return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 常量：值域硬约束。静态拆解与官方 API 文档冲突时取并集（见 reference/overrides.mjs DOMAIN_NOTES） */
export const DOMAINS = {
  hardware_concurrency: ['default', 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 32],
  device_memory: ['default', 2, 4, 6, 8],
  webgl: ['0', '2', '3'],
  webrtc: ['disabled', 'forward', 'proxy', 'local', 'disable_udp'],
  location: ['block', 'allow', 'ask'],
  flash: ['allow', 'block'],
  do_not_track: ['default', 'true', 'false'],
  media_devices: ['0', '1', '2'],
  device_name_switch: ['0', '1', '2'],
  headless: ['0', '1', '2'],
  open_tabs: ['1', '2'],
  mac_model: ['0', '1', '2'],
  webgpu_switch: ['0', '1', '2'],
  switches_01: ['0', '1'],
};

const err = (field, message) => ({ field, message });

/**
 * 一致性问题分两级：
 *   hard = 结构上自相矛盾（UA 说 Windows、platform 报 MacIntel），几乎必然被指纹库抓 → 默认阻断
 *   soft = 不像真机 / 业务上风险高，但不是硬矛盾（语言↔时区、核数↔内存、没绑代理…）→ 只告警
 * 分级让「软冲突」不再拦住启动，硬冲突仍然是红灯。见 docs/03。
 */
const hard = (field, message) => ({ field, message, severity: 'hard' });
const soft = (field, message) => ({ field, message, severity: 'soft' });

function coerceNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return NaN;
}

/** 单字段校验，返回错误数组 */
export function validateField(name, value) {
  const f = BY_NAME.get(name);
  if (!f) return [err(name, `unknown field`)];

  // ---- 特例：值域写死的 ----
  if (name === 'hardware_concurrency') {
    if (!DOMAINS.hardware_concurrency.includes(value) && !DOMAINS.hardware_concurrency.includes(coerceNumber(value))) {
      return [err(name, `must be one of ${DOMAINS.hardware_concurrency.join('|')}`)];
    }
    return [];
  }
  if (name === 'device_memory') {
    if (!DOMAINS.device_memory.includes(value) && !DOMAINS.device_memory.includes(coerceNumber(value))) {
      return [err(name, `must be one of ${DOMAINS.device_memory.join('|')}`)];
    }
    return [];
  }
  if (name === 'webgl') {
    if (!DOMAINS.webgl.includes(String(value))) return [err(name, 'must be "0" | "2" | "3"（"2" 手动掩码 / "3" 随机）')];
    return [];
  }
  // 拆解表只列 true|false，官方另有 "default"（见 reference/overrides.mjs）→ 取并集
  if (name === 'do_not_track') {
    if (!DOMAINS.do_not_track.includes(String(value))) return [err(name, `must be one of ${DOMAINS.do_not_track.join('|')}`)];
    return [];
  }
  // 拆解里是 csv 字符串，官方 API 是数组 → 两种都收
  if (name === 'allow_scan_ports') {
    if (Array.isArray(value)) {
      if (!value.every((v) => /^\d+$/.test(String(v)))) return [err(name, 'array items must be ports')];
      return [];
    }
    if (typeof value === 'string' && /^[\d,\s]*$/.test(value)) return [];
    return [err(name, 'must be csv string or array of ports')];
  }

  // ---- 通用 enum ----
  if (f.type === 'enum' && Array.isArray(f.values)) {
    const ok = f.values.some((v) => String(v) === String(value));
    if (!ok) return [err(name, `must be one of ${f.values.map(String).join('|')}`)];
    return [];
  }

  switch (f.type) {
    case 'number': {
      const n = coerceNumber(value);
      if (Number.isNaN(n)) return [err(name, 'must be a number')];
      if (name === 'device_scale' && !(n > 0 && n < 2.1)) return [err(name, 'must satisfy 0 < x < 2.1')];
      if (name === 'accuracy' && !(n >= 10 && n <= 5000 && Number.isInteger(n))) return [err(name, 'must be an integer 10..5000')];
      if (['longitude', 'latitude'].includes(name) && Math.abs(n) > 180) return [err(name, 'out of range')];
      return [];
    }
    case 'string': {
      if (typeof value !== 'string') return [err(name, 'must be a string')];
      if (f.max && value.length > f.max) return [err(name, `max length ${f.max}`)];
      if (name === 'cookie') {
        try {
          const parsed = JSON.parse(value);
          if (!Array.isArray(parsed)) return [err(name, 'cookie must be list string')];
        } catch {
          return [err(name, 'cookie must be list string')];
        }
      }
      if (name === 'screen_resolution' && value !== 'none' && value !== 'random' && !/^\d{2,5}_\d{2,5}$/.test(value)) {
        return [err(name, 'must be "none" | "random" | "<W>_<H>"')];
      }
      if (name === 'allow_scan_ports' && !/^[\d,\s]*$/.test(value)) return [err(name, 'must be csv ports')];
      if (name === 'timezone' && !isValidTimezone(value)) {
        return [err(name, `not an IANA timezone: ${value}`)];
      }
      return [];
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return [err(name, 'must be an object')];
      if (name === 'webgl_config') {
        if (value.webgpu !== undefined && typeof value.webgpu !== 'object') return [err(`${name}.webgpu`, 'must be an object')];
        const sw = value?.webgpu?.webgpu_switch;
        if (sw !== undefined && !DOMAINS.webgpu_switch.includes(String(sw))) return [err(`${name}.webgpu.webgpu_switch`, 'must be "0"|"1"|"2"')];
      }
      if (name === 'media_devices_num') {
        for (const k of ['audioinput_num', 'videoinput_num', 'audiooutput_num']) {
          const v = value[k];
          if (v === undefined) continue;
          const n = coerceNumber(v);
          if (!(n >= 1 && n <= 9)) return [err(`${name}.${k}`, 'must be 1..9')];
        }
      }
      if (name === 'mac_address_config') {
        if (value.model !== undefined && !DOMAINS.mac_model.includes(String(value.model))) return [err(`${name}.model`, 'must be "0" or "2"')];
        if (value.model === '2' && value.address !== undefined && !/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(String(value.address))) {
          return [err(`${name}.address`, 'must be a MAC address')];
        }
      }
      if (name === 'client_hints' && value.platform !== undefined) {
        const ok = ['Windows', 'macOS', 'Linux', 'Android', 'iOS', 'Chrome OS', ''].includes(String(value.platform));
        if (!ok) return [err(`${name}.platform`, `unexpected UA-CH platform: ${value.platform}`)];
      }
      return [];
    }
    case 'array<string>':
    case 'array<object>':
    case 'array<enum>': {
      if (!Array.isArray(value)) return [err(name, 'must be an array')];
      if (name === 'fonts' && value.length === 1 && value[0] === 'all') return [];
      if (f.type === 'array<string>' && value.some((v) => typeof v !== 'string')) return [err(name, 'array items must be strings')];
      if (name === 'tabAssistantFeatures') {
        const allowed = ['tabAssistant', 'chromeValidationHeaders', 'chromeWebstoreValidationHeaders', 'extensionManagement'];
        const bad = value.filter((v) => !allowed.includes(v));
        if (bad.length) return [err(name, `unexpected: ${bad.join(',')}`)];
      }
      return [];
    }
    default:
      return [];
  }
}

/** 把 API 传入的值规范成内部表示（数字字段转 number、时区空格转下划线、经纬度截 6 位） */
export function normalizeValue(name, value) {
  const n = coerceNumber(value);
  if (['device_scale', 'accuracy', 'longitude', 'latitude'].includes(name) && !Number.isNaN(n)) {
    if (['longitude', 'latitude'].includes(name)) return Number(n.toFixed(6));
    return n;
  }
  if (['win_x', 'win_y', 'image_size', 'canvas_id', 'webgl_image_id', 'audio_id', 'client_rects_id'].includes(name) && !Number.isNaN(n)) return Math.trunc(n);
  if (['hardware_concurrency', 'device_memory'].includes(name)) {
    if (value === 'default') return 'default';
    if (!Number.isNaN(n)) return n;
  }
  if (name === 'timezone' && typeof value === 'string') return value.replace(/ /g, '_');
  if (name === 'allow_scan_ports' && Array.isArray(value)) return value.join(',');
  if (['webgl', 'canvas', 'audio', 'webgl_image', 'client_rects', 'media_devices'].includes(name) && typeof value === 'number') return String(value);
  return value;
}

/**
 * 整体校验。
 * @param {object} input
 * @param {{mode?: 'create'|'update', fillDefaults?: boolean}} opts
 */
export function validateProfile(input, opts = {}) {
  const { mode = 'create', fillDefaults = true } = opts;
  const errors = [];
  const warnings = [];
  const out = {};

  if (!input || typeof input !== 'object') return { ok: false, errors: [err('$', 'body must be an object')], warnings, value: {} };

  // 必填
  if (mode === 'create' && !input.group_id) errors.push(err('group_id', 'group_id is required'));

  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    const f = BY_NAME.get(k);
    if (!f) {
      warnings.push(err(k, 'unknown field, 透传到 ext_obj'));
      continue;
    }
    const e = validateField(k, v);
    if (e.length) errors.push(...e);
    else out[k] = normalizeValue(k, v);
  }

  if (fillDefaults) {
    for (const [k, v] of Object.entries(DEFAULTS_VIEW())) {
      if (out[k] === undefined) out[k] = v;
    }
  }

  if (errors.length === 0) warnings.push(...checkConsistency({ ...out, ...input }, new Set(Object.keys(input))));
  return { ok: errors.length === 0, errors, warnings, value: out };
}

function DEFAULTS_VIEW() {
  const out = {};
  for (const f of require_fields()) if (f.default !== null && f.default !== undefined) out[f.name] = f.default;
  return out;
}

let _fields = null;
function require_fields() {
  if (!_fields) _fields = [...BY_NAME.values()];
  return _fields;
}

// ---- 一致性检查：这是产品能不能「活着」的核心，见 docs/00-技术方案.md §6 ----
const UA_PLATFORM_RULES = [
  { re: /Windows NT/i, platform: 'Win32', hints: 'Windows' },
  { re: /Android/i, platform: 'Android', hints: 'Android' },
  { re: /iPhone|iPad/i, platform: 'iPhone', hints: 'iOS' },
  { re: /Macintosh|Mac OS X/i, platform: 'MacIntel', hints: 'macOS' },
  { re: /Linux/i, platform: null, hints: 'Linux' },
];

export function checkConsistency(p, explicit = new Set()) {
  const w = [];
  const ua = typeof p.ua === 'string' ? p.ua : '';
  const platform = p.platform;
  const hints = p.client_hints ?? {};

  // 1. UA 平台 token vs navigator.platform
  if (ua && platform) {
    const rule = UA_PLATFORM_RULES.find((r) => r.re.test(ua));
    if (rule && rule.platform && rule.platform !== platform) {
      w.push(hard('platform', `UA 声明 ${rule.re} 但 platform=${platform}，会被 UA↔platform 交叉校验抓`));
    }
  }
  // 2. UA-CH platform vs navigator.platform
  if (hints.platform && platform) {
    const map = { Win32: 'Windows', MacIntel: 'macOS', Android: 'Android', iPhone: 'iOS' };
    const want = map[platform] ?? (platform.startsWith('Linux') ? 'Linux' : null);
    if (want && hints.platform !== want) w.push(hard('client_hints.platform', `platform=${platform} 期望 UA-CH platform=${want}，实际 ${hints.platform}`));
  }
  // 3. UA 里的版本 vs client_hints.ua_full_version
  if (ua && hints.ua_full_version) {
    const m = ua.match(/Chrome\/(\d+)\./);
    if (m && !String(hints.ua_full_version).startsWith(`${m[1]}.`)) {
      w.push(hard('client_hints.ua_full_version', `UA 报 Chrome/${m[1]} 但 ua_full_version=${hints.ua_full_version}`));
    }
  }
  // 4. webgl=2 必须带 vendor/renderer，否则等于开了个空开关
  if (String(p.webgl) === '2') {
    const cfg = p.webgl_config ?? {};
    if (!cfg.unmasked_vendor || !cfg.unmasked_renderer) w.push(hard('webgl_config', 'webgl="2" 但缺少 unmasked_vendor / unmasked_renderer'));
  }
  // 5. SwiftShader + 桌面平台 = 高危组合
  if (hints.renderer_swiftshader || /SwiftShader/i.test(String(p.webgl_config?.unmasked_renderer ?? ''))) {
    if (platform && platform !== 'Android' && platform !== 'iPhone') w.push(soft('webgl_config.unmasked_renderer', '桌面平台报 SwiftShader 是经典高危指纹'));
  }
  // 6. 语言 vs 时区（粗粒度国家映射，只提醒）
  const lang0 = Array.isArray(p.language) && p.language[0] ? p.language[0] : null;
  const tz = typeof p.timezone === 'string' ? p.timezone : null;
  if (lang0 && tz && (explicit.has('timezone') || String(p.automatic_timezone) !== '1')) {
    const LANG_TZ = { 'zh-CN': 'Asia/', 'zh-TW': 'Asia/Taipei', 'ja': 'Asia/Tokyo', 'ko': 'Asia/Seoul', 'ru': 'Europe/Moscow', 'de': 'Europe/', 'fr': 'Europe/Paris', 'es': 'Europe/Madrid', 'vi': 'Asia/', 'th': 'Asia/', 'id': 'Asia/' };
    // zh-CN / ja-JP 这种带区域的标签，先查全名再退回主语言
    const langRegion = LANG_TZ[lang0] || LANG_TZ[String(lang0).split('-')[0]];
    const enUS = lang0 === 'en-US' || lang0 === 'en';
    if (langRegion && !tz.startsWith(langRegion)) w.push(soft('timezone', `language=${lang0} 与 timezone=${tz} 不像同一个国家`));
    if (enUS && !(tz.startsWith('America/') || tz === 'UTC')) w.push(soft('timezone', `language=en-US 与 timezone=${tz} 不像同一个国家`));
  }
  // 7. 内存/核心数组合是否像真机
  const cores = typeof p.hardware_concurrency === 'number' ? p.hardware_concurrency : null;
  const mem = typeof p.device_memory === 'number' ? p.device_memory : null;
  if (cores && mem && cores >= 16 && mem <= 4) w.push(soft('hardware_concurrency', `${cores} 核配 ${mem}G 内存不像真实机器`));
  if (cores && cores > 8 && String(p.device_name_switch) === '0') w.push(soft('device_name', '高核心数通常对应工作站命名，device_name 建议同步'));
  // 8. 代理类 webrtc 但没有代理
  if (['proxy', 'forward'].includes(String(p.webrtc)) && !p.user_proxy_config && !p.proxy_id) {
    w.push(soft('webrtc', `webrtc=${p.webrtc} 需要绑定代理，否则出口地址无从谈起`));
  }
  return w;
}

/** 语言标签 → 国家码（只覆盖我们生成器会产出的语言，够用就行） */
const LANG_COUNTRY = {
  'zh-CN': 'CN', 'zh-TW': 'TW', 'zh-HK': 'HK', 'ja': 'JP', 'ja-JP': 'JP', 'ko': 'KR', 'ko-KR': 'KR',
  'ru': 'RU', 'ru-RU': 'RU', 'de': 'DE', 'de-DE': 'DE', 'fr': 'FR', 'fr-FR': 'FR', 'es': 'ES', 'es-ES': 'ES',
  'en-US': 'US', 'en-GB': 'GB', 'en-SG': 'SG', 'en-AU': 'AU', 'en-CA': 'CA',
  'pt-BR': 'BR', 'vi-VN': 'VN', 'th-TH': 'TH', 'id-ID': 'ID',
};

/** 内网/本机地址：出口报这些说明根本没出去 */
export function isPrivateIp(ip) {
  const s = String(ip || '');
  if (!s) return false;
  if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.)/.test(s)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true;
  if (/^(::1$|fc00:|fd00:|fe80:)/i.test(s)) return true;
  return false;
}

/**
 * 出口一致性（运行时检查，接在启动流程里）：声明的地理/时区 vs 真实出口。
 * 全部是 soft —— 出口只能证明「像不像」，不能因为探测失败就不让用。
 * @param {object} p profile 平铺记录
 * @param {{ok?:boolean, ip?:string, countryCode?:string, country?:string, timezone?:string, city?:string}} egress
 */
export function checkEgress(p, egress) {
  const w = [];
  if (!egress || egress.ok === false) return w;
  const ip = String(egress.ip || '');
  const declaredTz = typeof p.timezone === 'string' ? p.timezone.replace(/ /g, '_') : null;
  const exitTz = egress.timezone ? String(egress.timezone) : null;
  if (ip && isPrivateIp(ip)) {
    w.push(soft('ip', `出口 IP ${ip} 是内网/本机地址：流量没有真正经过代理`));
  }
  if (declaredTz && exitTz && declaredTz !== exitTz) {
    w.push(soft('timezone', `声明时区 ${declaredTz} 与出口时区 ${exitTz} 不一致（换 IP 后时区没跟着换，是被抓的常见原因）`));
  }
  const lang0 = Array.isArray(p.language) && p.language[0] ? String(p.language[0]) : null;
  const want = lang0 ? LANG_COUNTRY[lang0] || null : null;
  const exitCC = egress.countryCode ? String(egress.countryCode).toUpperCase() : null;
  if (want && exitCC && want !== exitCC) {
    w.push(soft('language', `语言 ${lang0} 指向 ${want}，出口国家是 ${exitCC}（${egress.country || '未知'}）`));
  }
  return w;
}
