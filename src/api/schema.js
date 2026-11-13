/**
 * 环境编辑表单的 schema（给 Web 控制台用）。
 *
 * 为什么要有这个接口：138 个字段的分组、类型、值域、必填、默认值，
 * 事实源都是 packages/profile 的字段注册表。前端不该再抄一份 ——
 * 抄一份的后果是后端改值域、前端还在放行，两边文案打架。
 * 所以这里把注册表原样吐出去，表单按它渲染；错误文案仍然由后端
 * `validateProfile()` 产出（前端只负责把 errors[].field 定位到输入框）。
 */
import { FIELDS } from '../../packages/profile/src/fields.js';
import { DOMAINS } from '../../packages/profile/src/validate.js';

const GROUP_LABELS = {
  identity: '基本信息',
  browser: '浏览器与内核',
  ua_and_language: 'UA 与语言',
  noise_quad: '噪声四维',
  fonts: '字体',
  screen_hardware: '屏幕与硬件',
  media_devices: '媒体设备',
  network: '网络与代理',
  geolocation: '地理定位',
  privacy_switches: '隐私开关',
  launch_and_cache: '启动与缓存',
};

/** 只有这些字段配了中文名；其余直接显示 API 字段名（它们本来就是给脚本看的旋钮，别硬翻） */
const LABELS = {
  name: '环境名称', group_id: '分组', profile_tag_ids: '标签', remark: '备注',
  domain_name: '目标域名（v1 的 platform 参数）', open_urls: '启动打开的网址', cookie: 'Cookie',
  username: '账号', password: '密码', fakey: '2FA 密钥', login_user: '登录用户备注',
  random_fingerprint: '每次启动换随机指纹',
  browser: '浏览器内核', platform: 'navigator.platform', device_scale: 'devicePixelRatio',
  gpu: 'GPU 厂商串',
  ua: 'User-Agent', language: '语言列表', language_switch: '跟随语言自动生成',
  timezone: '时区', automatic_timezone: '按时区自动匹配语言', client_hints: 'UA-CH（Client Hints）',
  canvas: 'Canvas 噪声', webgl: 'WebGL 掩码', webgl_image: 'WebGL 图像噪声',
  audio: 'Audio 噪声', client_rects: 'ClientRects 噪声', webgl_config: 'WebGL vendor/renderer',
  fonts: '字体列表', disabled_fonts: '禁用字体',
  screen_resolution: '屏幕分辨率', hardware_concurrency: 'CPU 核心数', device_memory: '内存（GB）',
  device_name: '设备名', device_name_switch: '设备名开关', mac_address_config: 'MAC 地址',
  network_information_type: '网络类型', gyroscope: '陀螺仪',
  media_devices: '媒体设备数量', media_devices_num: '各设备数量', speech_switch: '语音合成',
  speech_voices: '语音列表',
  webrtc: 'WebRTC', ipchecker: 'IP 检测服务', bypass_proxy_check: '跳过代理预检',
  is_multi_level_proxy: '多级代理', scan_port_type: '端口扫描', allow_scan_ports: '放行端口',
  location: '地理位置权限', location_switch: '地理位置开关', longitude: '经度', latitude: '纬度',
  accuracy: '定位精度（米）',
  do_not_track: 'Do Not Track', automation_controlled: '自动化受控标记',
  disable_image: '禁用图片', disable_video: '禁用视频', disable_console: '禁用控制台',
  disable_save_password: '禁用保存密码', disable_password_filling: '禁用密码填充',
  blacklist: '域名黑名单', whitelist: '域名白名单', hidden_notification: '隐藏通知',
  launch_args: '额外启动参数', headless: '无头模式', window_position: '窗口位置',
  win_x: '窗口 X', win_y: '窗口 Y', new_startup_page: '启动页', clear_cache_after_closing: '关闭后清缓存',
};

/** 0/1/2 这类哨兵值，光看数字没法选；只影响展示，提交的仍是原值 */
const VALUE_LABELS = {
  canvas: { 0: '关闭', 1: '开启（同种子稳定）' },
  webgl_image: { 0: '关闭', 1: '开启（同种子稳定）' },
  audio: { 0: '关闭', 1: '开启（同种子稳定）' },
  client_rects: { 0: '关闭', 1: '开启（同种子稳定）' },
  webgl: { 0: '关闭', 2: '手动掩码（需填 vendor/renderer）' },
  random_fingerprint: { 0: '固定', 1: '每次随机' },
  language_switch: { 0: '手填', 1: '自动生成' },
  automatic_timezone: { 0: '手填', 1: '自动匹配' },
  headless: { 0: '否', 1: '是', 2: '按环境' },
  media_devices: { 0: '不伪装', 1: '伪装数量', 2: '伪装设备列表' },
  webrtc: { disabled: '禁用', local: '本地地址', proxy: '代理地址', forward: '转发', disable_udp: '禁用 UDP' },
  location: { block: '拒绝', allow: '允许', ask: '每次询问' },
  do_not_track: { true: '开启', false: '关闭', default: '跟随浏览器' },
  browser: { chrome: 'Chrome（本地）', firefox: 'Firefox（不支持）' },
};

/** 表单不渲染的字段：运行时产物或走别的面板 */
const HIDDEN = new Set([
  'ip', 'ip_country', 'ip_city', 'ip_region',           // 出口探测结果，不是配置
  'user_proxy_config',                                   // 代理在「代理」面板里绑
  'browser_run_args',                                    // launch_args 的旧别名
  'ext_obj',                                             // 透传原始体，脚本用
]);

/** 云端才有意义的字段：表单里禁用并说明，不假装能配 */
const CLOUD_ONLY = new Set([
  'category_id', 'app_ids', 'platform_account', 'sys_user_id', 'company_id', 'invite_code',
  'storage_cloud_option', 'sync_localstorage_cache', 'sync_indexeddb_cache', 'sync_extension_cache',
  'sync_history', 'not_sync_cache_not_open', 'fb_cloud_password_manager', 'is_fb_network_acceleration',
]);

/**
 * 空转字段：**字段表照对手收了、这一版代码不消费**。
 *
 * 事实源只有一个：`packages/profile/reference/overrides.mjs` 的 `effect` 注册表 ——
 * 字段带 `inert`（读了不生效的理由）或 `effect: 'none'`（内核层零读取）就是空转，
 * 由 `tools/gen-schema.mjs` 写进 `fields.generated.json`，这里**只是把它翻译成 UI 状态**。
 * 这里不再维护第二张表（以前那张硬编码 24 条的 IDLE 表，和代码对不上时没人发现）。
 *
 * 出参带 `idle: true` + `idle_reason`（= 注册表里的 `inert` 原文）+ `effect`（在哪一层生效）。
 * 表单据此灰显并浮层说明；判定在 `test/unit.test.mjs`（effect 注册表那条 + 空转那条）。
 */
function inertReason(f) {
  return f.inert && String(f.inert).trim() ? String(f.inert).trim() : null;
}


/** 基础区（其余进「高级」折叠） */
const BASIC = new Set([
  'name', 'group_id', 'profile_tag_ids', 'remark', 'domain_name', 'open_urls', 'cookie',
  'browser', 'platform', 'device_scale', 'gpu',
  'ua', 'language', 'language_switch', 'timezone', 'automatic_timezone',
  'canvas', 'webgl', 'webgl_image', 'audio', 'client_rects',
  'fonts', 'disabled_fonts',
  'screen_resolution', 'hardware_concurrency', 'device_memory', 'device_name', 'device_name_switch',
  'media_devices', 'media_devices_num', 'speech_switch', 'speech_voices',
  'webrtc', 'bypass_proxy_check', 'scan_port_type', 'allow_scan_ports',
  'location', 'location_switch', 'longitude', 'latitude', 'accuracy',
  'do_not_track', 'automation_controlled', 'disable_image', 'disable_video', 'disable_console',
  'disable_save_password', 'disable_password_filling', 'blacklist', 'whitelist', 'hidden_notification',
  'launch_args', 'headless', 'window_position', 'win_x', 'win_y', 'new_startup_page',
  'clear_cache_after_closing',
]);

function uiKind(f) {
  if (f.type === 'enum') return 'select';
  if (f.type === 'number') return 'number';
  if (f.type === 'array<string>') return 'list';
  if (f.type === 'array<enum>') return 'multiselect';
  if (f.type === 'object' || f.type === 'array<object>') return 'json';
  if (f.name === 'cookie') return 'cookie';
  return 'text';
}

function valuesOf(f) {
  if (f.name === 'hardware_concurrency') return DOMAINS.hardware_concurrency;
  if (f.name === 'device_memory') return DOMAINS.device_memory;
  if (Array.isArray(f.values)) return f.values;
  return null;
}

/**
 * @returns {{groups: Array, fields: Array, total: number}}
 * groups 里带每个字段的渲染信息；fields 是扁平索引，方便前端按名字查。
 */
export function profileFormSchema() {
  const fields = FIELDS.filter((f) => !HIDDEN.has(f.name)).map((f) => {
    const values = valuesOf(f);
    return {
      name: f.name,
      label: LABELS[f.name] || f.name,
      group: f.group,
      type: f.type,
      kind: uiKind(f),
      values,
      value_labels: VALUE_LABELS[f.name] || null,
      required: !!f.required,
      max: f.max ?? null,
      range: f.range ?? null,
      default: f.default ?? null,
      note: f.note || null,
      coverage: f.coverage,
      storage: f.storage,
      basic: BASIC.has(f.name),
      cloudOnly: CLOUD_ONLY.has(f.name),
      // 空转字段：填了能存、但不影响内核。表单按它灰显 + 浮层，别让用户以为「配了就有用」
      idle: inertReason(f) !== null,
      idle_reason: inertReason(f),
      // 生效层（args / cdp / inject / none，或它们的数组）：注册表的原样，给 UI/脚本看「这条走哪条路」
      effect: f.effect ?? null,
      effectSites: Array.isArray(f.effectSites) ? f.effectSites : [],
      apiV2Alias: f.apiV2Alias || null,
    };
  });

  const groups = Object.entries(GROUP_LABELS)
    .map(([id, label]) => {
      const items = fields.filter((f) => f.group === id);
      if (!items.length) return null;
      return {
        id,
        label,
        fields: items,
        basic: items.filter((f) => f.basic).length,
        total: items.length,
      };
    })
    .filter(Boolean);

  return { groups, fields, total: fields.length };
}