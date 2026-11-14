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
  // browser_kernel_config：**假 full 纠错**（effect 注册表那批）。对象照字段表收着，但 src 里
  // 没有任何代码读它 —— 内核版本走 kernel_version + ua_auto，这份 JSON 只是存下来。
  browser_kernel_config: 'none',
  browser_head: 'partial',
  platform: 'partial',
  new_mobile_mode: 'partial',
  kernelSandboxMode: 'n/a',
  browser_compatibility_mode: 'n/a',
  gpu: 'partial',
  gpu_switch: 'partial',
  // cdp_mask / ban_dev_tools：假 full 纠错。`--remote-debugging-port` 是启动必需（没它连不上内核），
  // 禁用 DevTools 是内核级能力 —— 两个字段在 src 里都零读取。
  cdp_mask: 'none',
  ban_dev_tools: 'none',
  renderer_accessibility: 'n/a',
  device_scale: 'full',
  virtual_camera: 'none',

  // UA / 语言
  ua: 'full',
  client_hints: 'full',
  language: 'full',
  // language_switch / page_language_switch / automatic_timezone：假 full 纠错。三个「自动生成」开关
  // 只有生成器把默认值写进新环境（`generate.js` 的 `language_switch: '0'` 之类），**没有任何分支
  // 按开关选语言/时区** —— 语言与时区是 country/geo 表直接生成的。改了开关，启动结果一个字节不变。
  language_switch: 'none',
  lang: 'n/a',
  page_language: 'full',
  page_language_switch: 'none',
  timezone: 'full',
  automatic_timezone: 'none',

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
  // media_devices_num：**假 partial 纠错**（effect 注册表那批）。P9-C 起设备列表来自内核真实
  // enumerateDevices，数量字段只进 `CFG.media.counts`，注入层**不按它造设备**（伪造数量会同时踩
  // 跨 origin deviceId / 未授权 label / 枚举与 getUserMedia 不一致三条检测面）；自检页拿它比「声明值」。
  media_devices_num: 'none',
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
  // location（P2 ③）：真接了 —— allow=grantPermissions(+有坐标就 override)、ask=不授权但
  // 仍 override、block=显式 setPermission denied 且不 override。坐标与权限都走 CDP 原生，无 JS 痕迹。
  location: 'full',
  // location_switch：**假 full 纠错**。对手客户端根本不消费这个字段（"1"=按 IP 由服务端填坐标），
  // 我们也没有本地生效路径 → 标 none + idle（真正的「拒绝定位」看 location="block"）。
  location_switch: 'none',
  longitude: 'full',
  latitude: 'full',
  accuracy: 'full',

  // 隐私开关
  // do_not_track（P2 ④）：只有 "true" 做两半 —— 注入固定 navigator.doNotTrack="1" + 会话级
  // `Network.setExtraHTTPHeaders({DNT:'1'})`。"false" / "default" 什么都不做（对手那边两者不可区分）。
  // 标 partial：navigator 那半是 JS getter（虽然做了 native 伪装），DNT 头是**对手未证实、我们补的**；
  // `--enable-do-not-track` 在 157 上实测无效，没用它。
  do_not_track: 'partial',
  tls: 'partial',
  tls_switch: 'partial',
  flash: 'n/a',
  // automation_controlled：P2 起两条极性都真生效 —— "1" 不放
  // `--disable-blink-features=AutomationControlled`（内核原生 `navigator.webdriver === true`），
  // "0" / 缺省摘掉它（false）；纯启动参数、注入层的 webdriver 兜底也跟着让路，没有 JS 层痕迹。
  // 这一档 full 从 P2 起才名副其实：此前它是**假 full**（字段零消费，行为恒等于 "0"）。
  // 注意口径：对手是自家内核的 `staticConfig.AutomationControlled`，我们是行为等价的 Chrome
  // flag 方案，不是复刻（见 README §8「P2 隐私开关」）。
  automation_controlled: 'full',
  disable_image: 'partial',
  disable_video: 'partial',
  image_size: 'n/a',
  disable_console: 'partial',
  // disable_save_password：P2 起真接了启动参数（--password-store=basic +
  // --disable-features=EnablePasswordsAccountStorage；对手是自家内核的
  // --protected-disablesavepassword=1，我们没有那条路）。标 partial 的理由：参数进了命令行、
  // 启动与 CDP 都正常，但「保存密码条不再出现」是浏览器 UI 层行为，本机没有稳定可观测量 ——
  // 不把「参数进去了」写成「行为验证过」。同类启动参数开关
  // （disable_image / disable_video / disable_console）也都 partial。
  disable_save_password: 'partial',
  // disable_password_filling：仍无消费点（API 边界归一 + 落库，chrome.js 里没有对应参数）。
  disable_password_filling: 'none',
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
  // browser_run_args / no_args / cover_args：假 full 纠错。前两个是 v1 的旧参数名（合并参数只认
  // launch_args），cover_args 在 src 里零读取 —— 三个都只是「能存」。
  browser_run_args: 'none',
  no_args: 'none',
  cover_args: 'none',
  headless: 'full',
  optimize_launch: 'n/a',
  use_launch_optimize: 'n/a',
  // open_tabs / new_startup_page / win_x / win_y / clear_cache_after_closing：假 full 纠错。
  // 打开哪些页面只看 open_urls；启动页、标签数、窗口 X/Y、关闭后清缓存都没有实现，
  // 窗口只有 window_position（maximize/default）这一个真生效的取值。
  open_tabs: 'none',
  new_startup_page: 'none',
  window_position: 'full',
  win_x: 'none',
  win_y: 'none',
  clear_cache_after_closing: 'none',
  cache_backup: 'n/a',
  storage_strategy: 'partial',
  storage_cloud_option: 'n/a',
  sync_localstorage_cache: 'n/a',
  sync_indexeddb_cache: 'n/a',
  sync_extension_cache: 'n/a',
  sync_history: 'n/a',
  not_sync_cache_not_open: 'n/a',
  browser_security_lock: 'none',
  browser_security_lock_ignore_ids: 'n/a',
  api_merged: 'n/a',
  is_fb_network_acceleration: 'n/a',
  ignore_agent_config: 'n/a',
};

/**
 * effect 注册表：这个字段**在哪一层**真的改变内核/页面的行为。
 *
 * 为什么要有它（coverage 与 idle 都不够用）：
 *   coverage 说的是「CDP 这条路能做到什么程度」，是技术判断；idle 说的是「表单灰不灰」，是 UI 状态。
 *   两者都不回答一个问题：**这个字段到底有没有一行代码读它**。于是出现了三批假标签：
 *   `disable_save_password` / `location_switch` / `location` / `do_not_track` 那种「字段表收了、
 *   代码没读，UI 却当它能配」，以及反过来的「代码删了、标签还写着 full」。
 *
 * 取值（`effect`）：
 *   args   —— 只进内核命令行（`src/kernel/chrome.js`、`src/kernel/launch-args.js`、代理装配）
 *   cdp    —— 走 CDP（`src/runtime/manager.js` 的 Emulation/Browser/Network、`src/kernel/net-rules.js` 的 Fetch）
 *   inject —— 走页面注入（`src/kernel/inject.js` 生成的源码）
 *   none   —— 内核层没有任何代码读它（**必须**配 `inert`，说明为什么没有）
 * 一个字段同时走两条路就写数组（如 `do_not_track` = 注入 `navigator.doNotTrack` + 会话级 DNT 头）。
 *
 * `sites`：读取点锚，`<文件>#<代码里真的出现的字符串>`。unit 会去掉注释后逐条核「这个文件里
 * 还有没有这串」—— 代码删了、改名了，注册表没跟上就红。锚是**证据**，不是装饰：写一条不存在的锚
 * 等于没登记。
 *
 * `inert`：**读了但不改变行为**的理由（诊断变量、只喂自检的「声明值」对比、生成器只写默认值）。
 * 有 `inert` 的字段在 UI 里就是空转（`idle`）—— 空转的判定从此只有这一处事实源，`schema.js` 不再
 * 自己维护一张表。没有 `inert` 的字段才是真生效。
 *
 * 判定在 `test/unit.test.mjs`（「effect 注册表」那条）：
 *   ① 每个指纹/隐私字段（coverage ≠ n/a）必须登记，n/a 字段不许登记；
 *   ② `effect: 'none'` 必须写 `inert`，且**内核层零读取**（属性读取扫描，注释不算）；
 *   ③ 非 none 必须至少一条 `sites`，且每条锚在文件里真的存在；
 *   ④ `inert` 与 `idle` 必须一致（有 inert ⇔ 表单灰显）；
 *   ⑤ 各档数量钉死（改一个字段就得改数字，防「悄悄加一个」）。
 */
export const EFFECT = {
  // 浏览器 / 内核
  browser_kernel_config: { effect: 'none', inert: '零读取：内核版本走 kernel_version + ua_auto，这份 JSON 只是照字段表存着' },
  browser_head: { effect: 'none', inert: '零读取（表单能填，启动与注入都不读）' },
  platform: { effect: 'inject', sites: ['src/fingerprint/view.js#p.platform', 'src/kernel/inject.js#CFG.platform'] },
  new_mobile_mode: { effect: 'none', inert: '零读取（移动端模式没有对应启动参数，也没有 CDP 分支）' },
  gpu: { effect: 'none', inert: '零读取：GPU 相关只有 webgl_config.webgpu_switch 与用户白名单里的 --disable-gpu' },
  gpu_switch: { effect: 'none', inert: '零读取：--disable-gpu 只能由用户在 launch_args 里手填，开关字段本身没有读取点' },
  cdp_mask: { effect: 'none', inert: '零读取：--remote-debugging-port 是启动必需，没有「隐藏 CDP 特征」的分支读它' },
  ban_dev_tools: { effect: 'none', inert: '零读取：禁用 DevTools 是内核级能力（对手自编译内核），我们没有对应参数' },
  device_scale: { effect: 'cdp', sites: ['src/fingerprint/view.js#p.device_scale', 'src/runtime/manager.js#deviceScaleFactor: view.device_scale_factor'] },

  // 杂项：明确不做
  virtual_camera: { effect: 'none', inert: '零读取（虚拟摄像头是内核级特性，CDP/启动参数做不到）' },

  // UA / 语言
  ua: { effect: ['inject', 'cdp'], sites: ['src/kernel/inject.js#CFG.ua', 'src/runtime/manager.js#Emulation.setUserAgentOverride'] },
  client_hints: { effect: 'cdp', sites: ['src/fingerprint/view.js#p.client_hints', 'src/runtime/manager.js#userAgentMetadata: view.ua_metadata'] },
  language: { effect: ['args', 'inject'], sites: ['src/kernel/chrome.js#--accept-lang', 'src/kernel/inject.js#CFG.language'] },
  language_switch: { effect: 'none', inert: '零读取：生成器只把 "0" 写进默认值，没有任何分支按它选语言（语言由 country/geo 表生成）' },
  page_language: { effect: ['args', 'cdp'], sites: ['src/fingerprint/view.js#p.page_language', 'src/kernel/chrome.js#view.locale', 'src/runtime/manager.js#Emulation.setLocaleOverride'] },
  page_language_switch: { effect: 'none', inert: '零读取：生成器只写默认值，页面语言由 country/geo 表直接生成' },
  timezone: { effect: 'cdp', sites: ['src/runtime/manager.js#Emulation.setTimezoneOverride'] },
  automatic_timezone: { effect: 'none', inert: '零读取：生成器只写默认值，时区由 country/geo 表直接生成' },

  // 噪点四件套 + WebGL
  canvas: { effect: 'inject', sites: ['src/kernel/inject.js#CFG.canvas'] },
  webgl_image: { effect: 'inject', sites: ['src/kernel/inject.js#CFG.webgl_image'] },
  webgl: { effect: 'inject', sites: ['src/fingerprint/view.js#p.webgl', 'src/kernel/inject.js#CFG.webgl'] },
  webgl_config: { effect: ['args', 'inject'], sites: ['src/kernel/chrome.js#webgl_config?.webgpu?.webgpu_switch', 'src/fingerprint/view.js#p.webgl_config'] },
  audio: { effect: 'inject', sites: ['src/kernel/inject.js#CFG.audio'] },
  client_rects: { effect: 'inject', sites: ['src/kernel/inject.js#CFG.client_rects'] },

  // 字体：CDP 路线的结构性硬伤
  fonts: {
    effect: 'inject',
    sites: ['src/kernel/inject.js#Object.defineProperty(window, MK.fontsDeclared'],
    inert: '注入层只把列表挂成一条按种子的派生名（不可枚举，自检页拿它比对「声明的字体」），没有禁用/过滤；页面能枚举到的字体一条不变',
  },
  disabled_fonts: { effect: 'none', inert: '全 src 零读取（只在校验与详情视图里出现）' },

  // 屏幕 / 硬件
  screen_resolution: { effect: ['cdp', 'inject'], sites: ['src/fingerprint/view.js#p.screen_resolution', 'src/runtime/manager.js#screenWidth: view.screen.width', 'src/kernel/inject.js#CFG.screen'] },
  hardware_concurrency: { effect: ['cdp', 'inject'], sites: ['src/runtime/manager.js#Emulation.setHardwareConcurrencyOverride', 'src/kernel/inject.js#hardwareConcurrency: fp.hardware_concurrency'] },
  device_memory: { effect: 'inject', sites: ['src/fingerprint/view.js#p.device_memory', 'src/kernel/inject.js#deviceMemory: fp.device_memory'] },
  device_name: { effect: 'none', inert: '零读取：device_name_switch 有默认值，device_name 本身没有任何读取点' },
  mac_address_config: { effect: 'none', inert: '零读取（storage=fp，只存不注入）' },
  gyroscope: { effect: 'none', inert: '零读取：传感器是内核级设备面，CDP 没有对应域，页面注入也改不了' },
  network_information_type: { effect: 'none', inert: '零读取：NetInfo 走 networkInformation.type，启动参数与 CDP 都没有对应旋钮' },

  // 媒体设备 / 语音
  media_devices: { effect: 'inject', sites: ['src/fingerprint/view.js#profile.media_devices', 'src/kernel/inject.js#CFG.media'] },
  media_devices_num: {
    effect: 'none',
    inert: '只进 CFG.media.counts：注入层不按它造设备（P9-C 起列表来自内核真实枚举），只有自检页拿它比「声明值」',
  },
  media_devices_config: { effect: 'inject', sites: ['src/fingerprint/view.js#profile.media_devices_config', 'src/kernel/inject.js#CFG.media'] },
  media_devices_config_v2: { effect: 'none', inert: '零读取：生效的是 media_devices_config，v2 设备列表没人读' },
  speech_switch: { effect: 'inject', sites: ['src/fingerprint/view.js#profile.speech_switch', 'src/kernel/inject.js#CFG.speech'] },
  speech_voices: { effect: 'none', inert: '零读取：speech_switch 只投影 getVoices() 的启用状态，音色列表没人读' },

  // 网络 / 代理
  webrtc: { effect: 'args', sites: ['src/fingerprint/view.js#p.webrtc', 'src/kernel/chrome.js#view.webrtc'] },
  user_proxy_config: { effect: 'args', sites: ['src/runtime/manager.js#profile.user_proxy_config', 'src/kernel/chrome.js#--proxy-server'] },
  is_multi_level_proxy: { effect: 'args', sites: ['src/proxy/chain.js#profile.is_multi_level_proxy'] },
  mutli_level_proxy: { effect: 'args', sites: ['src/proxy/chain.js#profile.mutli_level_proxy'] },
  full_pac_url: { effect: 'args', sites: ['src/kernel/chrome.js#profile.full_pac_url', 'src/proxy/pac.js#input.full_pac_url'] },
  scan_port_type: { effect: 'none', inert: '零读取；端口扫描是内核级特性，我们走 CDP/启动参数做不了' },
  allow_scan_ports: { effect: 'none', inert: '零读取；同上' },

  // 地理
  // `location` 的第二条锚原来是 `#geoPolicy` —— 那个词在 manager.js 里首先命中的是第 12 行的
  // **import 行**，把 `:292` / `:941` 两处调用全删掉它照样绿（巡检④）。改成真正决定权限分支的
  // 读取表达式：`geoMode.permission`。`latitude/longitude/accuracy` 那三条锚的是 `geo.*`
  // 读取点（`:942` 的 `if (geo.override)` 一带），本来就是真读取。
  location: { effect: 'cdp', sites: ['src/fingerprint/view.js#profile.location', 'src/runtime/manager.js#geoMode.permission'] },
  location_switch: { effect: 'none', inert: '对手客户端不消费此字段："1"=按 IP 是服务端填充坐标，无本地生效路径；真正的拒绝定位是 location="block"' },
  longitude: { effect: 'cdp', sites: ['src/fingerprint/view.js#profile.longitude', 'src/runtime/manager.js#geo.longitude'] },
  latitude: { effect: 'cdp', sites: ['src/fingerprint/view.js#profile.latitude', 'src/runtime/manager.js#geo.latitude'] },
  accuracy: { effect: 'cdp', sites: ['src/fingerprint/view.js#profile.accuracy', 'src/runtime/manager.js#geo.accuracy'] },

  // 隐私开关
  do_not_track: { effect: ['inject', 'cdp'], sites: ['src/fingerprint/view.js#p.do_not_track', 'src/kernel/inject.js#CFG.doNotTrack', 'src/runtime/manager.js#Network.setExtraHTTPHeaders'] },
  tls: { effect: 'none', inert: '零读取（同名 tls 在代理代码里是协议名 node:tls，不是这个字段）' },
  tls_switch: { effect: 'none', inert: '零读取：只有生成器写默认值，没有分支读它' },
  automation_controlled: { effect: ['args', 'inject'], sites: ['src/kernel/chrome.js#profile.automation_controlled', 'src/fingerprint/view.js#p.automation_controlled', 'src/kernel/inject.js#CFG.automationControlled'] },
  disable_image: { effect: 'args', sites: ['src/kernel/chrome.js#profile.disable_image'] },
  disable_video: { effect: 'cdp', sites: ['src/kernel/net-rules.js#profile.disable_video'] },
  disable_console: { effect: 'none', inert: '零读取；禁用控制台是内核级特性，我们走 CDP/启动参数做不了' },
  disable_save_password: { effect: 'args', sites: ['src/kernel/chrome.js#profile.disable_save_password'] },
  disable_password_filling: { effect: 'none', inert: 'API 边界有归一与落库，chrome.js 零消费' },
  open_google_api: { effect: 'none', inert: '零读取：Google API 密钥注入是客户端内建能力，我们没有对应入口' },
  translate_webpages: { effect: 'none', inert: '零读取：内置翻译只在启动参数里禁掉了 Translate 特性，这个开关本身没人读' },
  blacklist: { effect: 'cdp', sites: ['src/kernel/net-rules.js#profile.blacklist'] },
  whitelist: { effect: 'cdp', sites: ['src/kernel/net-rules.js#profile.whitelist'] },
  domain_https: { effect: 'none', inert: '零读取：HTTPS 强制跳转是请求级规则，我们没有实现（黑白名单只做阻断）' },

  // 启动 / 缓存
  launch_args: { effect: 'args', sites: ['src/runtime/manager.js#effective.launch_args', 'src/kernel/launch-args.js#WHITELIST.get(key)'] },
  browser_run_args: { effect: 'none', inert: '零读取：v1 的旧别名，合并参数用的是 launch_args' },
  no_args: { effect: 'none', inert: '零读取（v1 的参数开关，启动链路没有对应分支）' },
  cover_args: { effect: 'none', inert: '零读取（同上，启动链路没有对应分支）' },
  headless: { effect: 'args', sites: ['src/kernel/chrome.js#profile.headless'] },
  open_tabs: { effect: 'none', inert: '零读取：打开哪些页面只看 open_urls，没有「开几个标签」的实现' },
  new_startup_page: { effect: 'none', inert: '零读取：启动页没有实现（启动打开的仍然是 open_urls）' },
  window_position: { effect: 'args', sites: ['src/kernel/chrome.js#profile.window_position'] },
  win_x: { effect: 'none', inert: '零读取：窗口只有 window_position（maximize/default），X/Y 没人读' },
  win_y: { effect: 'none', inert: '零读取：同上' },
  clear_cache_after_closing: { effect: 'none', inert: '零读取：关闭后清缓存没有实现（缓存清理走的是另一条显式接口）' },
  storage_strategy: { effect: 'none', inert: '零读取：存储策略是内核级的目录布局，我们没有对应实现' },
  browser_security_lock: { effect: 'none', inert: '零读取：环境密码锁没有实现（API 与启动链路都不读）' },
};

/**
 * coverage = n/a（不是指纹维度）却也读不到的字段。
 *
 * 这些字段不在 `EFFECT` 的范围内（n/a 不是一个「效果档」），但它们同样是空转，UI 一样要灰显 ——
 * 所以 `inert` 单独写在这里，由生成器一并写进字段表。四个都是「声明了、代码不读」。
 */
export const INERT_EXTRA = {
  device_name_switch: '字段表登记但 src 零消费，连开关本身都没搭生效路径',
  hidden_notification: '基线不带 --enable-automation，本来就没有「受自动化控制」横幅可消（基线已覆盖）',
  image_size: '零读取',
  whitelist_open: '零读取（白名单本体走 whitelist + net-rules）',
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
