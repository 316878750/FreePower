/**
 * 窗口同步的**默认设置**（纯逻辑：常量 + 归一化）。
 *
 * 为什么单独一个文件：0.4.3 ④ 的「设置」页要把这份默认**存进库**（`meta.sync_defaults`），
 * 而读它的是 `src/settings/prefs.js`。如果这些还留在 `session.js` 里，
 * `prefs.js → session.js` 会把整个运行时（CDP 客户端、内核管理器）拖进来，
 * 而 `session.js` 又要用 prefs —— 一个循环。所以常量与归一化下移到这里，
 * `session.js` 原样再导出（对外契约不变，`import { DEFAULT_SETTINGS } from './session.js'` 照旧能用）。
 */

/** 默认设置：键鼠四开关全开、无延迟；文本三个开关按对手面板的默认（相同文本/粘贴开，人工输入/随机数字关） */
export const DEFAULT_SETTINGS = Object.freeze({
  input: true,
  click: true,
  scroll: true,
  move: true,
  /* ---- 文本输入：四个开关互相独立，别合并（语义见 text-input.js） ---- */
  text_sync: true,        // 相同文本输入
  typing: false,          // 模拟人工输入（逐字 + 随机间隔）
  paste: true,            // 粘贴同步
  random_number: false,   // 随机数字输入（每窗口各自一个数，替换原文）
  typing_min_ms: 30,
  typing_max_ms: 120,
  random_min: 1000,
  random_max: 9999,
  /* ---- 标签页 ----
   * `same_tab` 是**内部**字段、默认 true、**面板不暴露**：按序号对应是「同步」成立的前提，
   * 关掉这个能力没有使用场景（对手界面上也没有这个开关，实测 `28-远端UI界面结构.md:156-161`
   * 的标签区只有「统一标签页 / 关闭其他 / 关闭当前标签页 / 关闭空白标签页 / 打开网址
   * + 首个网址在当前标签页打开」）。
   * 「目标空白」同理**不是开关**：先开空白页再导航是**首帧指纹的硬约束**，
   * 不是可选项 —— 去掉关闭分支，两个分支迟早腐化成一个（和拦截页不加开关同一个理由）。
   */
  same_tab: true,
  current_tab_url: false, // 首个网址在当前标签页打开（syncOperateCurrentTabURL）
  delay_ms: 0,
  jitter_ms: 0,
  /* 投递路径：'cdp'（默认）/ 'win32'（实验）。
   * 0.4.7.14 改回 CDP 默认：环境指纹用 setDeviceMetricsOverride 固定了页面尺寸（如 3170×1800），
   * 而排列后的真实窗口只有 1146×464，Win32 按「页面坐标 × DPI」换算的点全落在窗口外被丢弃（用户 9 窗口实测 63/64 越界）。 */
  deliver: 'cdp',
});

/** 设置页**不暴露**的字段（内部语义，给了只会造出两种行为）：面板上也不许出现这些开关 */
export const INTERNAL_SETTING_KEYS = Object.freeze(['same_tab']);

export function normalizeSettings(raw = {}) {
  const bool = (v, dflt) => (v === undefined ? dflt : v === true || v === 'true' || v === 1 || v === '1');
  const num = (v, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, 5000) : dflt;
  };
  /* 文本相关的数值上限大得多（随机数可以到十亿位、打字间隔到 2 秒），
   * 不能复用 num() 的 5000 上限 —— 否则「随机数 1–99999」会被静默改成 5000。 */
  const int = (v, dflt, lo, hi) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt;
  };
  let typingMin = int(raw.typing_min_ms, DEFAULT_SETTINGS.typing_min_ms, 0, 2000);
  let typingMax = int(raw.typing_max_ms, DEFAULT_SETTINGS.typing_max_ms, 0, 2000);
  if (typingMin > typingMax) [typingMin, typingMax] = [typingMax, typingMin];
  let randMin = int(raw.random_min, DEFAULT_SETTINGS.random_min, 0, 1e9);
  let randMax = int(raw.random_max, DEFAULT_SETTINGS.random_max, 0, 1e9);
  if (randMin > randMax) [randMin, randMax] = [randMax, randMin];
  return {
    input: bool(raw.input, true),
    click: bool(raw.click, true),
    scroll: bool(raw.scroll, true),
    move: bool(raw.move, true),
    text_sync: bool(raw.text_sync, true),
    typing: bool(raw.typing, false),
    paste: bool(raw.paste, true),
    random_number: bool(raw.random_number, false),
    typing_min_ms: typingMin,
    typing_max_ms: typingMax,
    random_min: randMin,
    random_max: randMax,
    same_tab: bool(raw.same_tab, true),
    current_tab_url: bool(raw.current_tab_url, false),
    delay_ms: num(raw.delay_ms, 0),
    jitter_ms: num(raw.jitter_ms, 0),
    deliver: raw.deliver === 'win32' ? 'win32' : 'cdp',
  };
}

/** 两份设置里哪些字段不一样（设置页要如实说「改了 3 项」，也要能说「和内置默认一致」） */
export function diffSettings(a = {}, b = {}) {
  const out = [];
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (a?.[k] !== b?.[k]) out.push(k);
  }
  return out;
}
