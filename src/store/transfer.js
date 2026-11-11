/**
 * 环境导入 / 导出 / 复制（P10）。
 *
 * 三条原则：
 *   1. **导入是「搬运」不是「重建」**：指纹字段（含四个噪点种子与 fp_seed）原样落库，
 *      这样导出到另一台机器再导入，canvas/webgl/audio/client_rects 四个哈希不变。
 *   2. **复制是「克隆配置、换指纹」**：指纹字段原样复制，但 `fp_seed` 重新生成，
 *      canvas_id / webgl_image_id / audio_id / client_rects_id 四个种子全部重生。
 *      复制出两个种子相同的环境 = 主动把两个账号关联起来，这条不许省。
 *   3. **形状容错、语义不放宽**：三种 body 形状（`{list}` / `{data:{list}}` / 裸数组）都认；
 *      未知字段收集进 warnings 而不是报错；但字段值该拒的照拒（validate 还是那一份）。
 *
 * AdsPower 兼容：`proxy_host / proxy_port / proxy_user / proxy_password` 与
 * `user_proxy_config` / `proxy_config` 都认，统一交给 createProfile 里的 normalizeProxy
 * （单一实现，不在这里造第二套）。
 */
import { createProfile, getProfile, cookieToStorage } from './profiles.js';
import { BY_NAME } from '../../packages/profile/src/fields.js';
import { toCanonical } from '../../packages/profile/src/aliases.js';
import { newSeed } from '../fingerprint/rng.js';
import { deriveNoiseSeeds } from '../fingerprint/seeds.js';

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** JSON 字符串也收（老导出/手写文件常见） */
function asObject(v) {
  if (isObject(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try {
      const p = JSON.parse(v);
      return isObject(p) ? p : null;
    } catch { return null; }
  }
  return null;
}

/** 顶层结构键：不是字段，但也不该报「未知」 */
const STRUCTURAL = new Set([
  'id', 'profile_id', 'user_id', 'profile_no', 'serial_number',
  'fingerprint_config', 'proxy_config', 'user_proxy_config', 'proxy',
  'login_cookie', 'country', 'fingerprint_seed', 'seed',
  'group_name', 'password_filling', 'disable_password_filling',
  'proxy_id', 'proxy_soft', 'proxy_type', 'proxy_host', 'proxy_port', 'proxy_user', 'proxy_password', 'proxy_pwd',
]);

/** fingerprint_config 里我们认识的派生键（导出里本来就有，别再报未知） */
const NESTED_KNOWN = new Set([
  'ua', 'platform', 'languages', 'timezone', 'locale', 'hardware_concurrency', 'device_memory',
  'screen', 'device_scale', 'device_scale_factor', 'webgl', 'webgl_image', 'webrtc',
  'media_devices', 'media_counts', 'speech', 'fonts', 'seed', 'kernel', 'spoofed',
  'proxy_soft', 'proxy_type', 'proxy_host', 'proxy_port', 'proxy_user', 'proxy_password', 'proxy_pwd',
]);

const PROXY_KEYS = ['proxy_host', 'host', 'proxy_port', 'port', 'proxy_user', 'username', 'proxy_password', 'password', 'proxy_pwd', 'proxy_type', 'type', 'proxy_soft', 'proxy_id'];

/**
 * AdsPower `.txt` 里的代理是**一整个字符串**：`host:port:user:pass`，无认证时 `host:port`。
 * 密码理论上可含 `:`，所以「前 3 段定宽、其余全归密码」（逆向实测的切法）。
 * 也认 `socks5://host:port:user:pass` 这种带协议前缀的写法。
 */
function parseProxyString(v) {
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (!s) return null;
  let scheme = '';
  const m = /^([a-z0-9+.-]+):\/\//i.exec(s);
  if (m) { scheme = m[1].toLowerCase(); s = s.slice(m[0].length); }
  // JSON 串是对象，不是这种格式
  if (s.startsWith('{')) return null;
  const parts = s.split(':');
  if (parts.length < 2) return null;
  const host = parts[0].trim();
  const port = Number(parts[1]);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return {
    proxy_type: scheme || undefined,
    proxy_host: host,
    proxy_port: port,
    proxy_user: parts.length >= 3 ? parts[2].trim() : '',
    proxy_password: parts.length >= 4 ? parts.slice(3).join(':') : '',
  };
}

/**
 * 从任意一层抓代理配置（顶层 proxy_* / proxy / proxy_config / user_proxy_config / fingerprint_config）。
 * `proxy` 是字符串（AdsPower .txt）时按 `host:port:user:pass` 解析；
 * **解析不出来要返回 error，让调用方进 warnings** —— 静默丢代理等于「用户以为走代理、实际裸奔」。
 */
function proxyOf(item, nested) {
  const candidates = [
    item.proxy,
    item.proxy_config,
    item.user_proxy_config,
    item.fingerprint_config,
    nested,
  ];
  for (const c of candidates) {
    const o = asObject(c);
    if (o && (o.host || o.proxy_host)) return { proxy: o };
  }
  const fromString = parseProxyString(item.proxy);
  if (fromString) {
    return {
      proxy: {
        proxy_type: item.proxy_type || item.proxytype || fromString.proxy_type,
        proxy_soft: item.proxy_soft,
        ...fromString,
      },
    };
  }
  if (item.proxy_host || item.proxy_user || item.proxy_password) {
    return {
      proxy: {
        proxy_type: item.proxy_type,
        proxy_soft: item.proxy_soft,
        proxy_host: item.proxy_host,
        proxy_port: item.proxy_port,
        proxy_user: item.proxy_user,
        proxy_password: item.proxy_password,
      },
    };
  }
  if (typeof item.proxy === 'string' && item.proxy.trim()) {
    const shown = item.proxy.trim().slice(0, 60);
    return { proxy: null, error: `代理字段 proxy="${shown}" 无法解析成 host:port[:user:pass]，**该环境的代理为空**（不会静默当成直连可用）` };
  }
  return { proxy: null };
}

/**
 * 一条导入项 → createProfile 的入参。
 * 不复用 API 的 `input()`：导入要额外认 AdsPower 的嵌套键，且未知字段只告警不报错。
 *
 * @returns {{input: object, warnings: string[]}|{error: string}}
 */
export function normalizeImportItem(raw) {
  if (!isObject(raw)) return { error: '不是对象（每条必须是一个 JSON 对象）' };
  const canon = toCanonical(raw, 'v2');
  const nested = asObject(canon.fingerprint_config) || asObject(raw.fingerprint_config) || {};
  const input = {};
  const warnings = [];
  const seen = new Set();
  const warn = (msg) => { if (!seen.has(msg)) { seen.add(msg); warnings.push(msg); } };

  // 1) 顶层：只认字段表里的名字；其余进 warnings
  for (const [k, v] of Object.entries(canon)) {
    if (v === undefined) continue;
    if (BY_NAME.has(k)) { input[k] = v; continue; }
    if (STRUCTURAL.has(k)) continue;
    warn(`未知字段 ${k}（已忽略）`);
  }

  // 2) fingerprint_config 嵌套：先映射派生键，再补顶层没有的字段
  for (const [k, v] of Object.entries(nested)) {
    if (v === undefined) continue;
    if (k === 'seed') { input.fingerprint_seed = v; continue; }
    if (k === 'languages') { if (Array.isArray(v)) input.language = v; continue; }
    if (k === 'screen') {
      if (Array.isArray(v) && v.length === 2) input.screen_resolution = `${v[0]}_${v[1]}`;
      continue;
    }
    if (k === 'device_scale' || k === 'device_scale_factor') { input.device_scale = v; continue; }
    if (k === 'fonts') { if (Array.isArray(v)) input.fonts = v; else if (Array.isArray(v?.list)) input.fonts = v.list; continue; }
    if (BY_NAME.has(k)) {
      if (input[k] === undefined) input[k] = v;
      continue;
    }
    if (NESTED_KNOWN.has(k)) continue;
    warn(`未知字段 fingerprint_config.${k}（已忽略）`);
  }

  // 3) 身份/代理边界：cookie 原样串、launch_args 两种写法、代理统一交 normalizeProxy
  if (canon.login_cookie !== undefined && canon.login_cookie !== null) {
    input.cookie = cookieToStorage(canon.login_cookie);
  }
  if (typeof input.launch_args === 'string') {
    const s = input.launch_args.trim();
    if (!s) delete input.launch_args;
    else if (s.startsWith('[')) {
      try {
        const arr = JSON.parse(s);
        if (Array.isArray(arr)) input.launch_args = arr.map(String);
      } catch { /* 保留原串，交给 validate 判 */ }
    } else {
      input.launch_args = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    }
  }
  const proxy = proxyOf(canon, nested);
  if (proxy.proxy) input.proxy_config = proxy.proxy;
  if (proxy.error) warn(proxy.error);
  if (input.group_id === undefined || input.group_id === null || String(input.group_id).trim() === '') input.group_id = '0';
  if (input.name !== undefined) input.name = String(input.name).slice(0, 100);

  return { input, warnings };
}

/**
 * 批量导入。一条失败不影响其余：失败项带 index + 可读原因。
 * @param {object[]} items
 * @param {{unit?: string}} [opts] 告警前缀的单位（JSON 用「项」、.txt 用「块」）
 * @returns {{imported:number, failed:object[], warnings:string[], list:object[]}}
 */
export function importProfiles(items = [], { unit = '项' } = {}) {
  const failed = [];
  const warnings = [];
  const list = [];
  for (let i = 0; i < items.length; i++) {
    const n = normalizeImportItem(items[i]);
    if (n.error) {
      failed.push({ index: i, reason: n.error });
      continue;
    }
    for (const w of n.warnings) warnings.push(`第 ${i + 1} ${unit}：${w}`);
    try {
      const created = createProfile(n.input);
      list.push(created);
    } catch (e) {
      failed.push({ index: i, reason: e.message || String(e) });
    }
  }
  return { imported: list.length, failed, warnings, list };
}

/** 复制时用到的字段：全部指纹/行为字段，去掉身份、运行态与 cookie（cookie 由 copy_cookies 决定） */
const COPY_SKIP = new Set([
  'cookie',
  'ip', 'ip_country', 'ip_city', 'ip_region', 'ipchecker',
]);

/**
 * 复制环境：配置原样、指纹种子整组重生。
 *
 * 为什么四个种子都要重生：canvas / webgl_image / audio / client_rects 由同一份 seed 派生，
 * 只换 canvas 会在 WebGL 图像噪声那条上仍然同源 —— 等于没换。
 *
 * @returns {object|null} 新环境（API 形状）；源环境不存在返回 null
 */
export function copyProfile(profileId, { name } = {}) {
  const src = getProfile(profileId);
  if (!src) return null;

  const flat = {};
  for (const key of BY_NAME.keys()) {
    if (COPY_SKIP.has(key)) continue;
    const v = src[key];
    if (v !== undefined && v !== null) flat[key] = v;
  }

  const seed = newSeed();
  const input = {
    ...flat,
    name: String(name || `${src.name}-copy`).slice(0, 100),
    fingerprint_seed: seed,
    // 四个维度种子全部换成新 seed 派生的值（放最后，覆盖掉源环境的值）
    ...deriveNoiseSeeds(seed),
    random_fingerprint: '0',
    kernel_version: src.kernel_version,
    proxy_id: src.proxy_id || undefined,
  };
  if (src.remark !== undefined) input.remark = `${src.remark ? src.remark + ' · ' : ''}复制自 ${src.profile_no}`;

  const created = createProfile(input);
  return { ...created, seeds_regenerated: true, copied_from: src.id };
}
