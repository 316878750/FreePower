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
  // disable_video：**保持接线**（0.4.6 复核后不改）。
  // 对手的实现是往 `StaticConfig.NetFilters` 追加 3 条 mimeType 全拦（`video/`、
  // `application/vnd.yt-ump`、`application/vnd.apple.mpegurl`，逆向 `30-假字段消费机制.md` §5），
  // 那是定制内核私有键 —— 但**我们不需要那个键**：我们走 CDP `Fetch` 请求拦截
  // （`src/kernel/net-rules.js` 的 `isMediaRequest` / `decideRequest`），按同样的三条 mime
  // 加 `resourceType=Media` 拦，且 response 阶段再判一次（HLS/yt-ump 伪装成 XHR 的情况）。
  // 有真内核证据：`test/switches.test.mjs` 的 `disable_video=1` 用例实测「服务器侧 media
  // 命中 0、`<video>` 停在 readyState=0/networkState=3」；纯函数判定在 `test/net-rules.test.mjs`。
  // 所以它不属于「内核不读私有键」那一类，禁用反而是能力倒退。
  disable_video: 'partial',
  // image_size（0.4.6 裁决：**禁用**）：对手机制是 `StaticConfig.NetFilters[{mimeType:"image/",
  // maxSize:1024×KB}]`（逆向 `30-假字段消费机制.md` §5），那是**定制内核**才读的私有键 ——
  // 官方 Chrome for Testing 一个都不读。CDP `Fetch` 能做出等价拦截，但「按 mimeType + 字节数
  // 拦」要逐响应过一遍 CDP、且 `unknownSizeBlock` 的语义边界无证据（`30-` §12 第 4 条）。
  // 没实测就不许宣称接上，所以标 none + 禁用，界面上写明「本版不支持按大小限制」。
  image_size: 'none',
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
  hidden_notification: 'partial',

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
  // open_tabs / new_startup_page / clear_cache_after_closing：假 full 纠错。
  // 打开哪些页面只看 open_urls；启动页、标签数、关闭后清缓存都没有实现，
  // 窗口只有 window_position（maximize/default）这一个真生效的取值。
  open_tabs: 'none',
  new_startup_page: 'none',
  window_position: 'full',
  // win_x / win_y（0.4.6）：真接了 —— `--window-position=x,y`（逆向 `03-启动参数拼装.md:86`
  // 记的就是这条映射）。标 partial：位置由窗口管理器裁决，越界坐标会被系统挪回可见区，
  // 「传进去了」不等于「窗口一定停在那个像素」。
  win_x: 'partial',
  win_y: 'partial',
  // clear_cache_after_closing（0.4.6 接线）：**纯磁盘操作，零内核依赖**。对手机制是
  // 「关闭流程末尾起 2 秒定时器，把整个 cacheFloder 目录 rm 掉；删失败只记日志不抛错」
  // （逆向 `30-假字段消费机制.md` §1）。我们照同一语义做：延迟 2 秒、删整个环境数据目录
  // （等价于对手的 cacheFloder，含 cookie/登录态，**不是**浏览器 cache 子目录）、失败只写日志。
  // 标 partial：延迟窗口内目录若被占用，Windows 上会删不掉 —— 那时「日志里只有一行失败」，
  // 与对手的静默行为一致，不报错、也不假装删掉了。
  clear_cache_after_closing: 'partial',
  // hidden_notification（0.4.6 接线）：对手机制是 CDP `evaluateOnNewDocument` 改写
  // `Notification.requestPermission`（逆向 `30-` §2），**不需要自编译内核**，与我们同一机制。
  // 标 partial：JS 层改写（带 `native code` 前置判断，防重复注入），有注入痕迹但页面可见效果一致。
  hidden_notification: 'partial',
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
  // disable_video：走 CDP Fetch 请求拦截（不是内核私有键），见 COVERAGE 里那段说明。
  disable_video: { effect: 'cdp', sites: ['src/kernel/net-rules.js#profile.disable_video'] },
  disable_console: { effect: 'none', inert: '零读取：禁用控制台是内核级特性；对手侧也是死链（IS_DISABLE_CONSOLE 只有默认赋值、无读取者，见 30- §3）' },
  disable_save_password: { effect: 'args', sites: ['src/kernel/chrome.js#profile.disable_save_password'] },
  disable_password_filling: { effect: 'none', inert: 'API 边界有归一与落库，chrome.js 零消费' },
  // image_size（0.4.6 裁决：禁用）：对手机制落 `StaticConfig.NetFilters`，官方内核不读；
  // CDP 等价拦截未实测、`unknownSizeBlock` 语义边界无证据（`30-` §5 / §12④）→ 不宣称接上。
  image_size: { effect: 'none', inert: '零读取：按字节数挡图要内核 NetFilters（定制内核私有键），官方内核不读；CDP 等价拦截未实测，不做' },
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
  // win_x / win_y（0.4.6 接线）：一条 `--window-position=x,y`，两个字段一起读，
  // **且只在 `window_position === "topLeft"` 时**（逆向 `30-` §7：对手也只有 topLeft 分支推这两个数，
  // maximize 推 --start-maximized、lastPosition 什么都不推）。锚是 `position.x` / `position.y`
  // 这个读取表达式（不是函数名），见 chrome.js 的 windowPositionOf()。
  win_x: { effect: 'args', sites: ['src/kernel/chrome.js#position.x'] },
  win_y: { effect: 'args', sites: ['src/kernel/chrome.js#position.y'] },
  // clear_cache_after_closing（0.4.6 接线）：纯磁盘操作，**不经内核也不经页面**，所以是 `local`
  // 这一档（新增档位：本地运行时动作）。锚是 manager.js 里那个真读取表达式 ——
  // `String(effective.clear_cache_after_closing) === '1'` 决定实例要不要在关闭后删目录。
  clear_cache_after_closing: { effect: 'local', sites: ['src/runtime/manager.js#effective.clear_cache_after_closing'] },
  storage_strategy: { effect: 'none', inert: '零读取：存储策略是内核级的目录布局，我们没有对应实现' },
  browser_security_lock: { effect: 'none', inert: '零读取：环境密码锁没有实现（API 与启动链路都不读）' },
  // hidden_notification（0.4.6 接线）：CDP 注入改写 `Notification.requestPermission`
  // —— 与对手同一机制（逆向 `30-` §2）。锚是注入配置里那一项。
  hidden_notification: { effect: 'inject', sites: ['src/kernel/inject.js#CFG.hiddenNotification'] },
};

/**
 * coverage = n/a（不是指纹维度）却也读不到的字段。
 *
 * 这些字段不在 `EFFECT` 的范围内（n/a 不是一个「效果档」），但它们同样是空转，UI 一样要灰显 ——
 * 所以 `inert` 单独写在这里，由生成器一并写进字段表。四个都是「声明了、代码不读」。
 */
export const INERT_EXTRA = {
  device_name_switch: '字段表登记但 src 零消费，连开关本身都没搭生效路径',
  whitelist_open: '零读取（白名单本体走 whitelist + net-rules）',
  // 0.4.6 裁决：这三个「表单能填、行为层零读取」，且**没有可接的消费路径**：
  //   browser —— 值域只有 "chrome"，内核解析走 kernel_version/ua_auto，没有按它分支的代码；
  //   tabs    —— 语义（启动标签页）与 open_urls 重叠，不自己发明，禁用并指向 open_urls；
  //   flash   —— Chrome 157 早已没有 Flash，没有可开关的对象。
  browser: '零读取：值域只有 "chrome"，内核解析走 kernel_version + ua_auto，没有按它分支的代码',
  tabs: '零读取：打开哪些页面只看 open_urls（与对手的启动标签页语义重叠，不自己发明）',
  flash: '零读取：Chrome 已移除 Flash，没有可开关的对象',

  // 0.4.6 补登记：这 15 个是「表单能填、全仓库零消费」漏网的那批（coverage 是 n/a，
  // 所以既不在 EFFECT 的覆盖范围里、也没被标成空转）。它们不接线，是因为**没有证据路径**：
  // 要么是内核层能力（我们没有自编译内核），要么是云端/客户端内建能力，要么是 v1 旧参数。
  // 归属与理由写在下面的 UNSUPPORTED 里（用户看得见的那一句话）。
  repeat_config: '零读取：重复环境检测没有实现，字段只进 csv 列',
  kernelSandboxMode: '零读取：内核沙箱只有 FREEPOWER_KERNEL_NO_SANDBOX 这一个环境变量兜底，没有按环境切换的分支',
  browser_compatibility_mode: '零读取：兼容模式是内核级渲染开关，我们走原生 Chrome',
  renderer_accessibility: '零读取：无障碍树是内核/启动参数层面的事，没有对应旋钮',
  dis_canvas_url: '零读取：canvas 噪声不按 URL 分流',
  ipchecker: '零读取：出口 IP 走内置探测（启动预检那条），不支持自定义检测服务',
  sync_password: '零读取：环境密码/云端同步密码，本版没有云端',
  tabAssistantExt: '零读取：对手的标签助手扩展，本版没有这个扩展',
  tabAssistantFeatures: '零读取：同上，扩展功能位没有落点',
  optimize_launch: '零读取：启动优化是客户端自己的预热策略，本版启动链路没有对应分支',
  use_launch_optimize: '零读取：同上',
  cache_backup: '零读取：缓存备份没有实现（备份/快照排在 0.4.7）',
  browser_security_lock_ignore_ids: '零读取：环境密码锁没有实现，配套的忽略清单同样没人读',
  api_merged: '零读取：v1 参数合并开关，本版 API 不走那条路',
  ignore_agent_config: '零读取：忽略 Agent 配置是客户端自己的开关，本版没有对应分支',
};

/**
 * **分组改写**（0.4.6）：字段该出现在哪一栏 —— 只影响表单呈现，不动存储与 API。
 *
 * 为什么需要：`sync_password` / `fb_cloud_password_manager` 在对手的字段表里归在
 * `privacy_switches`，于是我们的「隐私开关」页里出现了两个「同步密码 / 云端密码管理器」——
 * 用户会以为是改指纹的开关。拆解手核出它们的真实语义是「环境缓存/密码是否跟云端同步」
 * （`30-假字段消费机制.md` §9），与 `storage_strategy` 同栏才对。
 *
 * 另 5 个 `sync_*`（localstorage/indexeddb/extension/history/not_sync_cache_not_open）
 * 本来就在 `launch_and_cache`，不用改写。
 */
export const GROUP_OVERRIDE = {
  sync_password: 'launch_and_cache',
  fb_cloud_password_manager: 'launch_and_cache',
};

/**
 * 用户可见的「本版不支持」原因 —— **界面直接显示在控件旁边的那一行小字**。
 *
 * 为什么单独一张表（而不是继续用 `inert`）：`inert` 是给维护者看的技术口径
 * （「零读取」「API 边界有归一与落库」），用户读不懂，也不该读。这一张写的是
 * 「用户配了会期待什么 / 本版实际会怎样」，句式统一成一句人话。
 *
 * 规矩（`test/fields-invariant.test.mjs` 钉死）：
 *   ① 键集必须**恰好等于**表单里被禁用的字段集（`idle` + `cloudOnly`），少一个多一个都红；
 *   ② 不许出现黑话与空话：`未实现` / `暂不支持` / `零读取` / `字段表` / `inert` / `消费` / `grep`；
 *   ③ 每条至少 8 个字符，且必须说清「本版会怎样」，不能只说「不支持」。
 *
 * 前端渲染成「本版不支持 · <原因>」，**不用 title / hover**（hover 才看得见等于没写）。
 */
export const UNSUPPORTED = {
  // ---- 浏览器与内核 ----
  browser: '本版只有 Chrome 内核（Firefox 内核不支持），这一项固定为 Chrome',
  tabs: '启动时打开哪些页面只看「启动打开的网址」，这一项不读',
  browser_kernel_config: '内核版本由实际启动的 Chrome 决定，这份配置不参与启动',
  browser_head: '本版不改浏览器头部标识，这一项不生效',
  new_mobile_mode: '本版没有移动端模式（Chrome 没有对应参数），这一项不生效',
  gpu: 'GPU 厂商串请填 WebGL 的 vendor/renderer（噪声四维里的「WebGL 配置」），这一项不参与注入',
  gpu_switch: '本版没有 GPU 模式切换；要关 GPU 请在「额外启动参数」里填 --disable-gpu',
  cdp_mask: '本版无法隐藏调试端口（启动内核必须用它），这一项不生效',
  ban_dev_tools: '本版无法在内核层禁用开发者工具',
  virtual_camera: '本版不提供虚拟摄像头',
  browser_compatibility_mode: '本版用原生 Chrome，没有兼容渲染模式',
  renderer_accessibility: '本版改不了无障碍树，这一项不生效',
  kernelSandboxMode: '内核沙箱默认开启；受限环境只能用环境变量 FREEPOWER_KERNEL_NO_SANDBOX=1 兜底，不按环境切换',

  // ---- UA 与语言 ----
  language_switch: '语言由环境的国家/地区自动生成，这个开关不改变结果；要指定语言请直接填「语言列表」',
  page_language_switch: '页面语言由环境的国家/地区自动生成，这个开关不改变结果',
  automatic_timezone: '时区由环境的国家/地区自动生成，这个开关不改变结果；要指定时区请直接填「时区」',

  // ---- 字体 ----
  fonts: '本版只能把字体列表挂成声明值，页面能枚举到的字体一条不变',
  disabled_fonts: '本版做不到禁用字体（要改内核层）',

  // ---- 屏幕与硬件 ----
  device_name: '设备名不会出现在网页能读到的任何接口里，本版只保存不注入',
  device_name_switch: '本版没有可注入的设备名，这个开关没有作用对象',
  mac_address_config: '网页读不到真实 MAC，本版只保存不注入',
  gyroscope: '本版伪造不了陀螺仪（内核设备层能力）',
  network_information_type: '本版改不了 navigator.connection 报的网络类型',
  dis_canvas_url: '本版 canvas 噪声不按域名分流，这一项不生效',

  // ---- 媒体设备 / 语音 ----
  media_devices_num: '设备列表来自内核真实枚举，不按数量造设备；这个数量只用于自检页对比「声明值」',
  media_devices_config_v2: '本版用的是「媒体设备」里的设备列表，v2 这一份不读取',
  speech_voices: '本版只用「语音合成」开关，音色列表不参与（页面枚举到的语音不变）',

  // ---- 网络与代理 ----
  ipchecker: '本版出口 IP 用内置探测（启动预检里那条），不支持自定义检测服务',
  scan_port_type: '端口扫描检测是内核层能力，本版没有',
  allow_scan_ports: '端口扫描放行是内核层能力，本版没有',

  // ---- 地理 ----
  location_switch: '「按 IP 定位」是云端按 IP 填坐标，本地没有这条路径；要拒绝定位请把「地理位置权限」设成拒绝',

  // ---- 隐私开关 ----
  tls: 'TLS 指纹是内核握手层的事，本版改不了',
  tls_switch: '本版没有 TLS 指纹开关（TLS 握手由内核决定）',
  disable_console: '本版无法禁用浏览器控制台（要改内核层）',
  image_size: '本版不支持按大小限制图片；只能整页关图（见「禁用图片」）',
  flash: 'Chrome 早已不再支持 Flash，本版没有可开关的 Flash',
  disable_password_filling: '本版没有能单独关掉密码填充的 Chrome 参数；要关请用「禁用保存密码」',
  open_google_api: 'Google API 密钥是客户端内建能力，本版没有',
  translate_webpages: '本版只把 Chrome 内置翻译关掉，不提供翻译开关',
  whitelist_open: '本版的白名单放行表用「域名白名单」，这一项不参与判定',
  domain_https: '本版黑白名单只做阻断，不做 HTTPS 强制跳转',
  sync_password: '本版没有云端同步，也就没有同步密码',
  tabAssistantExt: '本版没有标签助手扩展',
  tabAssistantFeatures: '本版没有标签助手扩展，这些功能位没有落点',

  // ---- 启动与缓存 ----
  no_args: 'v1 的旧参数开关，本版不读；要加参数请用「额外启动参数」',
  cover_args: 'v1 的旧参数开关，本版不读；要加参数请用「额外启动参数」',
  open_tabs: '本版打开哪些页面只看「启动打开的网址」，这一项不读',
  new_startup_page: '启动页没有单独设置；要开哪些页面请填「启动打开的网址」',
  storage_strategy: '存储目录布局是内核层的事，本版没有这个选项',
  cache_backup: '本版没有缓存备份（备份与快照排在后续版本）',
  optimize_launch: '启动优化是客户端自己的预热策略，本版启动链路没有对应分支',
  use_launch_optimize: '本版没有启动优化开关，这一项不生效',
  api_merged: 'v1 的参数合并开关，本版 API 不走那条路',
  ignore_agent_config: '忽略 Agent 配置是客户端自己的开关，本版没有对应分支',
  browser_security_lock: '本版没有环境密码锁（打开环境不需要密码）',
  browser_security_lock_ignore_ids: '本版没有环境密码锁，配套的忽略清单也不生效',
  repeat_config: '本版不提供重复环境检测，这一项不参与',

  // ---- 云端才有意义的（表单里一直是灰的）----
  category_id: '需要 AdsPower 云端账号；FreePower 是纯本地产品，分组请用上面的「分组」',
  app_ids: '需要 AdsPower 云端账号；FreePower 没有云端应用市场',
  platform_account: '需要 AdsPower 云端账号；FreePower 没有云端平台绑定',
  sys_user_id: '需要 AdsPower 云端账号；FreePower 是纯本地产品，没有云端账号',
  company_id: '需要 AdsPower 云端账号；FreePower 没有云端团队',
  invite_code: '邀请码是云端注册用的；FreePower 没有云端',
  fb_cloud_password_manager: '需要 AdsPower 云端账号；FreePower 没有云端密码管理器',
  storage_cloud_option: '需要 AdsPower 云端账号；FreePower 的环境数据都存在本机',
  sync_localstorage_cache: '需要 AdsPower 云端账号；FreePower 没有云端同步',
  sync_indexeddb_cache: '需要 AdsPower 云端账号；FreePower 没有云端同步',
  sync_extension_cache: '需要 AdsPower 云端账号；FreePower 没有云端同步',
  sync_history: '需要 AdsPower 云端账号；FreePower 没有云端同步',
  not_sync_cache_not_open: '需要 AdsPower 云端账号；FreePower 没有云端同步',
  is_fb_network_acceleration: '需要 AdsPower 云端账号；FreePower 没有云端网络加速',
};

/**
 * **元信息字段**：表单里可填、但本来就不该改变浏览器行为的那几个。
 *
 * 这是「假字段」判据（`test/fields-invariant.test.mjs`）的**唯一豁免来源**，规矩比 UNSUPPORTED 更严：
 *   - 必须逐条列名，**不许通配**；
 *   - 每条要有 `why`（为什么不改变行为）和 `site`（它到底被谁读，格式 `<文件>#<代码里真有的串>`）；
 *   - `site` 会被判据拿去逐条核对：那个文件里没有这串，判据就红 —— 豁免是**有证据的豁免**，
 *     不是「先加进白名单再说」。
 */
export const METADATA = {
  group_id: { why: '分组：列表分组、筛选与导入导出都按它组织', site: 'src/store/profiles.js#group_id' },
  profile_tag_ids: { why: '标签：标签接口与列表筛选读它（真消费，见 docs/21 §5.5）', site: 'src/store/tags.js#profile_tag_ids' },
  remark: { why: '备注：只用于显示与导出', site: 'src/store/profiles.js#remark' },
  domain_name: { why: '目标域名：v1 `platform` 参数的落点，导入/导出按它映射', site: 'src/store/adspower-txt.js#domain_name' },
  login_user: {
    why: '登录用户备注：没有专门代码读它，按字段表的通用列收放（flattenFingerprint / checkProfile 都走 BY_NAME），只在详情与导出里显示',
    site: 'src/store/profiles.js#BY_NAME.has(k)',
  },
  login_user_comment: {
    why: '同上：备注类字段，通用列收放，只保存与显示，不进内核也不进注入',
    site: 'src/store/profiles.js#BY_NAME.has(k)',
  },
  fakey: { why: '2FA 密钥：只保存（本版不生成动态验证码），API 可读', site: 'src/store/adspower-txt.js#fakey' },
  random_fingerprint: { why: '保存时按它重算整套指纹并写回 0（真消费，见 docs/21 §5.5）', site: 'src/store/profiles.js#random_fingerprint' },
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

  // 0.4.6 接线的字段：这里写的是**界面上显示给用户的那行提示**（`f.note` → edit.js 的 hintOf）。
  // 为什么必须写：这几个字段现在是真生效的，用户不看提示就不知道代价 —— 尤其是
  // `clear_cache_after_closing` 会**删掉整个环境数据目录**，那不是「清缓存」三个字能概括的。
  // 规矩：只有「用户不看就会踩坑」的才写，别把 hint 变成说明书。
  clear_cache_after_closing: '关环境 2 秒后删除整个环境数据目录（cache / cookie / localStorage / 书签），下次启动是全新浏览器；只有 Cookie 字段里存着的登录态会被写回',
  hidden_notification: '通知权限请求一律被拒（页面拿到 false / null），网页无法再弹通知授权框',
  win_x: '只有「窗口位置」是 topLeft 时才用这两个数；其它取值下会被禁用（对手是同一种行为，只是静默忽略）',
  win_y: '只有「窗口位置」是 topLeft 时才用这两个数；其它取值下会被禁用',
  disable_image: 'Blink 层直接不请求图片，服务器侧一条图片请求都收不到',
};
