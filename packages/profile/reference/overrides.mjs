// FreePower · profile 字段表人工覆盖层
//
// 来源：拆解手 8.9.23 字段表（packages/profile/reference/ads-8.9.23-fields.json）。
// 这里只写「我们自己的判断」，没写的字段走默认：
//   storage: 'column'（平铺标量列）
//   coverage: 'n/a'（与指纹无关的元信息）
//
// coverage 取值：
//   full    —— CDP / 启动参数能做到与声明值一致，且不留 JS 层痕迹
//   partial —— 能做到「声明值生效」，但底层真实行为不一致或有注入痕迹（详见 docs/00-技术方案.md §2.2）
//   none    —— 当前 CDP 路线做不到，明确不做（产品里标黄，不吹）
//   n/a     —— 不是指纹维度（元信息 / 我们的自研开关）

/** 字段存储方式：column 平铺列 | csv 逗号串 | json 独立 JSON 列 | fp 进 fingerprint_config */
export const STORAGE = {
  // 数组型标识：简单 id 列表，用 csv 存（对齐对方的 join(",") 行为）
  profile_tag_ids: 'csv',
  repeat_config: 'csv',
  app_ids: 'csv',

  // URL 规则里可能含逗号，csv 会损坏数据 → 用独立 JSON 列
  open_urls: 'json',
  tabs: 'json',
  blacklist: 'json',
  whitelist: 'json',
  language: 'json',
  fonts: 'json',
  disabled_fonts: 'json',
  speech_voices: 'json',
  browser_security_lock_ignore_ids: 'json',
  platform_account: 'json',
  browser_kernel_config: 'json',
  user_proxy_config: 'json',
  storage_cloud_option: 'json',

  // 结构化指纹对象 → 统一收进 fingerprint_config（推测，见 docs/01-数据模型.md §2）
  webgl_config: 'fp',
  client_hints: 'fp',
  mac_address_config: 'fp',
  media_devices_num: 'fp',
  media_devices_config: 'fp',
  media_devices_config_v2: 'fp',
};

/** CDP 覆盖度 */
export const COVERAGE = {
  // 浏览器 / 内核
  browser_kernel_config: 'full',
  browser_head: 'partial',
  platform: 'partial',
  new_mobile_mode: 'partial',
  kernelSandboxMode: 'n/a',
  browser_compatibility_mode: 'n/a',
  gpu: 'partial',
  gpu_switch: 'partial',
  cdp_mask: 'full',
  ban_dev_tools: 'full',
  renderer_accessibility: 'n/a',
  device_scale: 'full',
  virtual_camera: 'none',

  // UA / 语言
  ua: 'full',
  client_hints: 'full',
  language: 'full',
  language_switch: 'full',
  lang: 'n/a',
  page_language: 'full',
  page_language_switch: 'full',
  timezone: 'full',
  automatic_timezone: 'full',

  // 噪点四件套
  canvas: 'partial',
  canvas_id: 'n/a',
  webgl_image: 'partial',
  webgl_image_id: 'n/a',
  webgl: 'partial',
  webgl_config: 'partial',
  audio: 'partial',
  audio_id: 'n/a',
  client_rects: 'partial',
  client_rects_id: 'n/a',
  dis_canvas_url: 'n/a',

  // 字体：CDP 路线的结构性硬伤，明确不做
  fonts: 'none',
  disabled_fonts: 'none',

  // 屏幕 / 硬件
  screen_resolution: 'full',
  hardware_concurrency: 'full',
  device_memory: 'full',
  device_name: 'partial',
  device_name_switch: 'n/a',
  mac_address_config: 'partial',
  gyroscope: 'none',
  network_information_type: 'partial',

  // 媒体设备
  media_devices: 'partial',
  media_devices_num: 'partial',
  media_devices_config: 'partial',
  media_devices_config_v2: 'partial',
  speech_switch: 'partial',
  speech_voices: 'partial',

  // 网络 / 代理
  webrtc: 'full',
  user_proxy_config: 'full',
  ip: 'n/a',
  ip_country: 'n/a',
  ip_city: 'n/a',
  ip_region: 'n/a',
  ipchecker: 'n/a',
  is_multi_level_proxy: 'partial',
  mutli_level_proxy: 'partial',
  bypass_proxy_check: 'n/a',
  full_pac_url: 'full',
  scan_port_type: 'partial',
  allow_scan_ports: 'partial',

  // 地理
  location: 'full',
  location_switch: 'full',
  longitude: 'full',
  latitude: 'full',
  accuracy: 'full',

  // 隐私开关
  do_not_track: 'partial',
  tls: 'partial',
  tls_switch: 'partial',
  flash: 'n/a',
  automation_controlled: 'full',
  disable_image: 'partial',
  disable_video: 'partial',
  image_size: 'n/a',
  disable_console: 'partial',
  disable_save_password: 'full',
  disable_password_filling: 'full',
  sync_password: 'n/a',
  fb_cloud_password_manager: 'n/a',
  open_google_api: 'partial',
  translate_webpages: 'partial',
  blacklist: 'partial',
  whitelist: 'partial',
  whitelist_open: 'n/a',
  domain_https: 'partial',
  tabAssistantExt: 'n/a',
  tabAssistantFeatures: 'n/a',
  hidden_notification: 'n/a',

  // 启动 / 缓存
  launch_args: 'full',
  browser_run_args: 'full',
  no_args: 'full',
  cover_args: 'full',
  headless: 'full',
  optimize_launch: 'n/a',
  use_launch_optimize: 'n/a',
  open_tabs: 'full',
  new_startup_page: 'full',
  window_position: 'full',
  win_x: 'full',
  win_y: 'full',
  clear_cache_after_closing: 'full',
  cache_backup: 'n/a',
  storage_strategy: 'partial',
  storage_cloud_option: 'n/a',
  sync_localstorage_cache: 'n/a',
  sync_indexeddb_cache: 'n/a',
  sync_extension_cache: 'n/a',
  sync_history: 'n/a',
  not_sync_cache_not_open: 'n/a',
  browser_security_lock: 'full',
  browser_security_lock_ignore_ids: 'n/a',
  api_merged: 'n/a',
  is_fb_network_acceleration: 'n/a',
  ignore_agent_config: 'n/a',
};

/**
 * 默认值。
 * 来源分两档，见 DEFAULT_SOURCE：
 *   official —— AdsPower 官方 skill 文档 fingerprint-config.md（8.9.23 随包自带），权威
 *   guessed  —— 拆解静态推断，未实证
 */
export const DEFAULTS = {
  browser: 'chrome',
  platform: 'Win32',
  random_fingerprint: '0',
  cdp_mask: '0',
  device_scale: 1,
  ua_auto_kernel: 'ua_auto',
  // 噪点四件套：官方文档说 canvas / webgl_image / audio 默认就是 1（加噪）
  canvas: '1',
  webgl_image: '1',
  webgl: '0',
  audio: '1',
  client_rects: '0',
  media_devices: '0',
  // P9-A：默认开。宿主声音列表（中文 Windows 上 en-US 环境第一条是 Microsoft Huihui）是
  // 跨机一致性的硬伤，关掉才是显式选择。投影只按环境语言过滤，不改声音名。
  speech_switch: '1',
  // 官方：webrtc 默认 disabled
  webrtc: 'disabled',
  location: 'ask',
  do_not_track: 'default',
  // 官方：flash 默认 block
  flash: 'block',
  automation_controlled: '1',
  hardware_concurrency: 'default',
  device_memory: 'default',
  screen_resolution: 'none',
  fonts: ['all'],
  timezone: 'UTC',
  automatic_timezone: '1',
  language_switch: '1',
  page_language_switch: '1',
  location_switch: '1',
  scan_port_type: '1',
  device_name_switch: '0',
  tls_switch: '0',
  headless: '0',
  accuracy: 1000,
  webgpu_switch: '1',
};

/** 默认值来源 */
export const DEFAULT_SOURCE = {
  canvas: 'official',
  webgl_image: 'official',
  audio: 'official',
  webrtc: 'official',
  flash: 'official',
  do_not_track: 'official',
  automatic_timezone: 'official',
  language_switch: 'official',
  page_language_switch: 'official',
  location_switch: 'official',
  location: 'official',
  screen_resolution: 'official',
  scan_port_type: 'official',
  device_name_switch: 'official',
  tls_switch: 'official',
  accuracy: 'official',
  hardware_concurrency: 'official',
  device_memory: 'official',
  webgl: 'official',
  cdp_mask: 'guessed',
  platform: 'guessed',
  browser: 'guessed',
  random_fingerprint: 'guessed',
  device_scale: 'guessed',
  client_rects: 'guessed',
  media_devices: 'guessed',
  speech_switch: 'guessed',
  automation_controlled: 'guessed',
  timezone: 'guessed',
  fonts: 'guessed',
  headless: 'guessed',
  webgpu_switch: 'official',
};

/**
 * 值域冲突：静态拆解（内核侧）与官方 API 文档不一致时取并集 —— 两边都要能收，
 * 因为客户端内部确实支持更多值，而官方文档只列了公开子集。
 */
export const DOMAIN_NOTES = {
  webgl: '拆解表只列 0|2，官方文档还有 "3"（random）；并集 0|2|3',
  hardware_concurrency: '拆解 2|3|4|6|8|10|12|16|20|24；官方 2|4|6|8|16|32 → 并集',
  mac_address_config: '拆解 model 只 0|2；官方 0|1|2（1=match）→ 并集',
  webgpu_switch: '拆解只见 "1"；官方 0=Disabled 1=WebGL matching 2=Real',
  do_not_track: '拆解只列 true|false；官方还有 "default"',
  allow_scan_ports: '拆解是 csv 字符串，官方 API 是 ["4000","4001"] 数组 → 两种都收，内部存 csv',
  screen_resolution: '官方还允许 "random"',
  device_memory: '拆解表只到 8（deviceMemory 上限 8G 的年代）；Chrome 157.0.8103.40 在本机（96G 实机）实测返回 32 → 扩到 16|32（P8-D）',
};

/**
 * 值域扩域：在拆解表的 values 后面追加。
 *
 * 规矩：**只放「内核实测真的会返回的值」**，不许为了自洽凭空扩域。
 * 每次扩都要在注释里写清 内核版本 / 机器 / 实测到什么。
 *
 * `device_memory` 是**我们改**的，而 `performance.memory.jsHeapSizeLimit` 跟着真实物理内存走。
 * 旧域封顶 8，在 96G 实机上就成了「声明 8G / 堆上限 4.09GB」并排显示（P8-D 实测）；
 * Chrome 157.0.8103.40 在同一台机器上报 `navigator.deviceMemory = 32`（2 的幂、封顶 32），
 * 所以扩到 32 是照着实测值走，不是定价。
 */
export const VALUES_EXTRA = {
  device_memory: [16, 32],
};

/** 注释：写进字段表，给后续维护者看 */
export const NOTES = {
  platform: 'v1 API 的 `platform` 参数映射到 domain_name，不是本字段（本字段 = navigator.platform）',
  webgl: '只有 "0" 和 "2" 两个值，没有 "1"；2 才是手动掩码 vendor/renderer',
  webgl_config: 'webgpu.webgpu_switch 是服务端自动补的，客户端也会塞，转存时不要当脏数据',
  fonts: '["all"] 是特殊值（不过滤）；语义是黑名单 DisabledFonts',
  cookie: '必须是 JSON 字符串，服务端会校验 cookie must be list string',
  group_id: '必填，缺则 group_id is required',
  device_scale: '0 < x < 2.1',
  timezone: 'IANA 名，空格转下划线',
  speech_voices: '音色列表，移动端/内核能力相关',
};
