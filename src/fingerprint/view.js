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

/**
 * 窗口尺寸：**默认不等于屏幕尺寸**。
 *
 * creepjs 的 like-headless 里有一条 `hasVvpScreenRes`：
 *   (innerWidth === screen.width && outerHeight === screen.height)
 *   || (visualViewport.width === screen.width && visualViewport.height === screen.height)
 * 我们原来把窗口和视口都按屏幕尺寸拉满，正好命中这一条（P8-C 实测：这条 + `noTaskbar`
 * 两条一起，把 `like headless` 从裸 Chrome 的 25% 抬到 38%）。
 * 屏幕分辨率本身仍是配置值（Emulation 的 screenWidth/screenHeight 不变），只是窗口小一圈。
 */
export function windowSizeFor(screen) {
  if (!screen) return null;
  const width = Math.max(800, Math.min(1600, screen.width - 100));
  const height = Math.max(600, Math.min(900, screen.height - 120));
  return { width: Math.min(width, screen.width), height: Math.min(height, screen.height) };
}

/** profile.window_size 支持 `1280,800` / `1280x800` 两种写法 */
export function parseWindowSize(raw) {
  if (!raw) return null;
  const m = /^(\d{2,5})\s*[,x]\s*(\d{2,5})$/.exec(String(raw).trim());
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
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
 *   media_devices 0=真实（不注入）、1=随机（按数量随机生成命名池）、2=手动（用 media_devices_config）
 *
 * P9-C 起**设备列表来自内核真实 enumerateDevices**，这里只决定「授权后叫什么名字」：
 * 第 i 个同类设备用命名池里第 i 个名字。数量字段不再决定列表长度 ——
 * 伪造数量会同时踩三条检测面（跨 origin deviceId、未授权 label、枚举与 getUserMedia 不一致）。
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
 * 语音合成视图（P9-A）：`speech_switch` '1' = 按环境语言投影 `getVoices()`。
 *
 * 默认**开**：宿主声音列表是跨机一致性的硬伤（本机中文 Windows 上 en-US 环境第一条声音是
 * `Microsoft Huihui - Chinese (Simplified, PRC)`，裸 Chrome 与注入后都是 25 条中文）。
 * 显式写 '0' 才关。投影只做「按环境语言过滤」，不改 voice 的名字，也不造 `speak` 点不着的声音。
 */
function speechView(profile) {
  const raw = profile.speech_switch;
  const on = raw === undefined || raw === null || raw === '' ? true : String(raw) === '1';
  return on ? { enabled: true } : null;
}

/**
 * fonts / disabled_fonts 的落库形状是 JSON 数组，但对手落盘是 csv 字符串，
 * 手工改库或从老数据导入时可能是 `"Arial,SimSun"`。这里两种都收，统一成数组。
 */
function stringList(v, dflt) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  if (typeof v === 'string') {
    const arr = v.split(',').map((s) => s.trim()).filter(Boolean);
    return arr.length ? arr : dflt;
  }
  return dflt;
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
  const screen = parseScreen(p.screen_resolution);
  const windowSize = parseWindowSize(p.window_size) || windowSizeFor(screen);
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
    screen,
    window: windowSize,
    device_scale_factor: typeof p.device_scale === 'number' ? p.device_scale : 1,
    webrtc: p.webrtc || 'disabled',
    // P2 `automation_controlled`：'1' = 保留原生 navigator.webdriver=true（启动层不放
    // --disable-blink-features=AutomationControlled，注入层的 webdriver 兜底也让路）
    automationControlled: String(p.automation_controlled ?? '0') === '1',
    // P2 `do_not_track`：只有 "true" 做两半（navigator.doNotTrack="1" + 请求头 DNT: 1）。
    // "false" / "default" 在对手那边完全不可区分、都是不下发 —— 我们也什么都不做（不发明第三种状态）。
    doNotTrack: String(p.do_not_track) === 'true' ? '1' : null,
    media: mediaView(p),
    speech: speechView(p),
    fonts: stringList(p.fonts, ['all']),
    kernel_version: p.kernel_version || null,
  };
}

/**
 * P2 · `location`（`block` / `allow` / `ask`）：位置权限策略 + 是否覆盖坐标。
 *
 * **按字段名办事，不是「什么都不做」**：
 *   allow → `Browser.grantPermissions(['geolocation'])`，有经纬度时再覆盖坐标
 *   ask   → 不授权（内核默认就是 prompt：有头会弹提示、无头自动拒），有经纬度时仍覆盖坐标
 *   block → **显式** `Browser.setPermission({setting:'denied'})`，不覆盖坐标
 *
 * 实测（内核 157.0.8103.78、headless）：不授权时 `getCurrentPosition` 直接 `code=1`
 * User denied Geolocation；只有 `grantPermissions` + `setGeolocationOverride` 一起上才拿得到
 * 坐标（`37.7749 / -122.4194 / 12`）。`setPermission denied` 与「什么都不做」在无头下读数相同，
 * 但**有头下不同**：什么都不做是 prompt（= ask，会弹提示），所以 block 必须显式拒绝，
 * 否则 `block` 与 `ask` 无法区分 —— 那正是这一轮要消灭的「两个取值一样」。
 *
 * `location_switch` 不参与判断：对手客户端根本不消费它（"1"=按 IP 是服务端填坐标）。
 */
export function geoPolicy(profile) {
  const mode = String(profile.location || 'ask');
  // null / 空串**不算坐标**：Number(null) === 0，直接 Number() 会把「没填经纬度」当成 (0,0)
  // —— 那是几内亚湾，比不覆盖更糟（探针实测抓到过这一版）。
  // **纯空白串也算没填**：`Number('  ') === 0`，漏了这一条，表单里打一个空格就中招（同样下发 (0,0)）。
  const num = (v) => {
    if (v === null || v === undefined) return NaN;
    if (typeof v === 'string' && v.trim() === '') return NaN;
    return Number(v);
  };
  const lat = num(profile.latitude);
  const lng = num(profile.longitude);
  const acc = num(profile.accuracy);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  return {
    mode,
    permission: mode === 'allow' ? 'granted' : mode === 'block' ? 'denied' : 'prompt',
    // block 一律不覆盖；缺经纬度时只做权限，**不把 undefined 塞进 CDP**
    override: mode !== 'block' && hasCoords,
    latitude: hasCoords ? lat : undefined,
    longitude: hasCoords ? lng : undefined,
    accuracy: Number.isFinite(acc) && acc > 0 ? Math.round(acc) : undefined,
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
    speech: !!view.speech,
    fonts: view.fonts,
    seed: String(view.seed),
  };
}
