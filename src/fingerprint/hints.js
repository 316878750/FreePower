/**
 * UA ↔ UA-CH（client_hints）的版本自洽（0.4.7.1）。
 *
 * ## 这一版为什么会有这个文件
 *
 * 0.4.4 时代建的环境：`ua` 是导入时带进来的 `Chrome/133.0.6943.127`，
 * 而 `client_hints` 是**建环境那一刻**按本机内核填的（`157.0.8103.78`）。
 * 0.4.6 把「UA 里的 Chrome 大版本 vs `client_hints.ua_full_version`」升级成了**硬冲突**，
 * 于是这些记录一读出来就自相矛盾、一启动就被拦 —— 用户 50 个环境全挂（0.4.7.1 修的 P0）。
 *
 * ## 三条规则（按顺序，前一条命中就不走后面）
 *
 *   1. **有完整 `ua_full_version`**：只在「它和 UA 里的 Chrome 大版本矛盾」时，
 *      把**版本段**对齐到 UA 的大版本（`<major>.0.0.0`），`brands` / `fullVersionList`
 *      若存在也一起对齐。**`platform` 一个字节都不动** —— 那是另一条硬冲突
 *      （UA 平台 vs `navigator.platform`），不许在这里被顺手放宽。
 *   2. **没有 hints（或没有完整版本）**：UA 能解析出 `Chrome/<major>` → **用那个 major 派生**，
 *      不许用本机内核版本（用内核就等于凭空造一个矛盾出来）。
 *   3. **UA 缺失 / 解析不出 Chrome 版本**：才回落到本机内核版本（此时 UA-CH 与内核一致，
 *      而 UA 本来也没声明任何版本，怎么都对得上）。
 *
 * ## 两条纪律
 *
 * - **读路径零写入**：`withClientHints` 返回新对象，绝不改入参、绝不写库
 *   （判据 `test/ua-hints.test.mjs` 第 2 组钉这一条：调用之后库里的列还是原样）。
 * - **只对齐版本号**，不对齐平台、不猜品牌。要改平台请改 `platform` 字段本身。
 */

import { alignProfileToKernel } from '../kernel/version.js';

const CHROME_RE = /Chrome\/(\d+)\./;

/** UA 里的 Chrome 大版本（`Chrome/133.0.6943.127` → `'133'`）；解析不出返回 `null` */
export function chromeMajorOf(ua) {
  const s = typeof ua === 'string' ? ua : '';
  const m = CHROME_RE.exec(s);
  return m ? m[1] : null;
}

/** 内核完整版本号的大版本（`157.0.8103.78` → `'157'`） */
export function majorOf(version) {
  const s = String(version ?? '').trim();
  if (!/^\d+(\.\d+)*$/.test(s)) return null;
  return s.split('.')[0];
}

/**
 * 从 UA 推 UA-CH 的平台三件套。
 *
 * 为什么平台也跟着 UA 走：`platform` / `platform_version` / `mobile` 是 UA 的函数，
 * 让它们来自同一条字符串才不会又造出一个新矛盾（比如 UA 是 Windows、UA-CH 说 macOS）。
 * 只有 `platform` 字段（`navigator.platform`）是用户显式配置的那一个，不在这里动。
 */
export function platformHintsFromUa(ua) {
  const s = typeof ua === 'string' ? ua : '';
  if (/Android/i.test(s)) return { platform: 'Android', platform_version: '13.0.0', mobile: '1' };
  if (/iPhone|iPad/i.test(s)) return { platform: 'iOS', platform_version: '17.0.0', mobile: '1' };
  if (/Macintosh|Mac OS X/i.test(s)) return { platform: 'macOS', platform_version: '10.15.7', mobile: '0' };
  if (/Linux/i.test(s)) return { platform: 'Linux', platform_version: '', mobile: '0' };
  return { platform: 'Windows', platform_version: '10.0.0', mobile: '0' };
}

/** 一套「完整版本号 + 平台」的默认 hints（`major` 来自 UA 或内核） */
function hintsFor(major, full, ua) {
  const plat = platformHintsFromUa(ua);
  return {
    platform: plat.platform,
    platform_version: plat.platform_version,
    architecture: 'x86',
    model: '',
    mobile: plat.mobile,
    wow64: '0',
    ua_full_version: full,
    bitness: '64',
  };
}

/** 按 UA 的 Chrome 大版本派生一套 hints（规则 2） */
export function hintsFromUa(ua) {
  const major = chromeMajorOf(ua);
  if (!major) return null;
  return hintsFor(major, `${major}.0.0.0`, ua);
}

/** 按内核完整版本派生一套 hints（规则 3） */
export function hintsFromKernel(kernelVersion, ua) {
  const full = String(kernelVersion ?? '').trim();
  const major = majorOf(full);
  if (!major) return null;
  return hintsFor(major, full, ua);
}

/** `brands` / `fullVersionList` 的版本段对齐到 `major`（没有就不造，别凭空加字段） */
function alignBrandVersions(hints, major, full) {
  const out = { ...hints };
  if (Array.isArray(hints.brands)) {
    out.brands = hints.brands.map((b) => (b && b.brand === 'Not_A Brand'
      ? { ...b }
      : { ...b, version: major }));
  }
  if (Array.isArray(hints.fullVersionList)) {
    out.fullVersionList = hints.fullVersionList.map((b) => (b && b.brand === 'Not_A Brand'
      ? { ...b }
      : { ...b, version: full }));
  }
  return out;
}

/** hints 里有没有「完整版本号」这一项（空串 / 非字符串都算没有） */
export function fullVersionOf(hints) {
  const v = hints && typeof hints === 'object' ? hints.ua_full_version : null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

/**
 * 读路径：给一条记录补齐 / 对齐 `client_hints`。**返回新对象，不改入参，不写库。**
 *
 * @param {object} profile 平铺记录（`getProfile` 出来的那种）
 * @param {{kernelVersion?:string}} [opts] `kernelVersion` 只用于「UA 也没有」时的兜底
 * @returns {object} 原对象，或一个带自洽 `client_hints` 的浅拷贝
 */
export function withClientHints(profile, { kernelVersion = null } = {}) {
  if (!profile || typeof profile !== 'object') return profile;
  const ua = typeof profile.ua === 'string' ? profile.ua : '';
  const cur = profile.client_hints && typeof profile.client_hints === 'object' ? profile.client_hints : null;
  const curFull = fullVersionOf(cur);
  const uaMajor = chromeMajorOf(ua);

  // 规则 1：已有完整版本 —— 只在大版本矛盾时对齐版本段（platform 不动）
  if (curFull) {
    if (!uaMajor) return profile; // UA 不可解析：没有依据，保持原样
    if (String(curFull).split('.')[0] === uaMajor) return profile;
    const next = alignBrandVersions({ ...cur, ua_full_version: `${uaMajor}.0.0.0` }, uaMajor, `${uaMajor}.0.0.0`);
    return { ...profile, client_hints: next };
  }

  // 规则 2 / 3：没有完整版本 → UA 能解析就按 UA，否则按本机内核
  const base = hintsFromUa(ua) || hintsFromKernel(kernelVersion, ua);
  if (!base) return profile;
  // 老记录里可能只存了 platform 之类的一半字段：保留它们，只补版本
  const merged = { ...base, ...(cur || {}) };
  merged.ua_full_version = base.ua_full_version;
  return { ...profile, client_hints: merged };
}

/**
 * 写路径：把要落库的 `client_hints` 与 `ua` 对齐，**保证存进去的这一对是自洽的**。
 *
 * - 有 UA 的可解析大版本 → hints 的版本段一律对齐到它（这就是「UA 是身份」）；
 * - UA 不可解析（缺失 / 非 Chrome）→ 原样保留调用方给的 hints（可能是内核版本）。
 *
 * @returns {{client_hints:object|null, changed:boolean, from:string|null, to:string|null}}
 */
export function reconcileForWrite({ ua, client_hints, kernel_version } = {}) {
  const cur = client_hints && typeof client_hints === 'object' ? client_hints : null;
  const curFull = fullVersionOf(cur);
  const uaMajor = chromeMajorOf(ua);

  // UA 解析不出：不动调用方的 hints（新建时它已经是内核版本了）
  if (!uaMajor) {
    const base = cur || hintsFromKernel(kernel_version, ua);
    return { client_hints: base, changed: false, from: curFull, to: fullVersionOf(base) };
  }

  // 没有完整版本 → 按 UA 派生整份
  if (!curFull) {
    const derived = hintsFromUa(String(ua));
    const merged = { ...derived, ...(cur || {}), ua_full_version: derived.ua_full_version };
    return {
      client_hints: merged,
      changed: true,
      from: curFull,
      to: derived.ua_full_version,
    };
  }

  // 有完整版本：大版本不一致就对齐（版本段）
  if (String(curFull).split('.')[0] === uaMajor) {
    return { client_hints: cur, changed: false, from: curFull, to: curFull };
  }
  const full = `${uaMajor}.0.0.0`;
  return {
    client_hints: alignBrandVersions({ ...cur, ua_full_version: full }, uaMajor, full),
    changed: true,
    from: curFull,
    to: full,
  };
}

/**
 * 启动前「只剩版本号冲突」时的一次性对齐（0.4.7.1 要求 2：不许留死胡同）。
 *
 * **0.4.7.2 起调用方必须先看开关**（`uaAutoAlignEnabled()`，设置页「UA 跟随内核版本升级」，
 * 默认关）：关着的时候这一轮呈现的 UA 也不许改 —— 用户存 133 就按 133 打开。
 * 这个函数本身不动库，但它会改「这一轮启动的视图」，所以同样属于「改写」。
 *
 * 判据只有一条：**去掉版本号那几条之后，别的硬冲突一条都没有**。
 * 满足才按本机内核做 `alignProfileToKernel` 同一套对齐，否则原样返回、照旧阻断
 * （webgl 空开关、UA 平台 ↔ `navigator.platform` 矛盾这些必须继续拦）。
 *
 * @param {object} profile
 * @param {{kernelVersion?:string, check?:function}} opts `check(profile)` 注入给判据用
 * @returns {{applied:boolean, profile:object, reasons:string[], hardLeft:object[]}}
 */
export const VERSION_ONLY_FIELDS = new Set(['client_hints.ua_full_version']);

export function preAlignForLaunch(profile, { kernelVersion = null, check = null } = {}) {
  const unchanged = { applied: false, profile, reasons: [], hardLeft: [] };
  if (!profile || typeof profile !== 'object') return unchanged;
  const kernel = String(kernelVersion ?? '').trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(kernel)) return unchanged;
  const probe = typeof check === 'function' ? check : null;
  if (!probe) return unchanged;

  const before = probe(profile);
  if (before.ok) return unchanged;
  const hard = Array.isArray(before.hard) ? before.hard : [];
  if (!hard.length) return unchanged;
  // 只剩「UA 版本 vs UA-CH 版本」这一类才动；别的硬冲突一律不动
  if (!hard.every((h) => VERSION_ONLY_FIELDS.has(String(h.field)))) {
    return { ...unchanged, hardLeft: hard };
  }

  /*
   * 对齐用的是 `src/kernel/version.js` 的 **同一个** `alignProfileToKernel`，
   * 不是这里的第二份实现：启动前这次（校验之前）和启动后那次（拿到 Browser.getVersion 之后）
   * 一旦各写一份，迟早会漂成两套规则，而漂的那天没有任何判据会报。
   */
  const aligned = alignProfileToKernel(profile, kernel);
  const after = probe(aligned.profile);
  if (!after.ok) return { applied: false, profile, reasons: [], hardLeft: after.hard || [] };
  return { applied: true, profile: aligned.profile, reasons: aligned.reasons, hardLeft: [] };
}

/**
 * 导入结果里那一条「这个环境的 UA 不是本机内核这一版」（要求 3：别让用户点开才发现）。
 *
 * 0.4.7.2 起这句话**不再承诺「首次打开会按内核对齐」** —— 跟版默认关，
 * 按环境自己的 UA 打开才是正常行为（对手也是这样）。只有用户显式打开
 * 「UA 跟随内核版本升级」之后，才会真的对齐。
 *
 * @returns {{ua_major:string, kernel_major:string, message:string}|null}
 */
export function uaKernelNotice(profile) {
  const uaMajor = chromeMajorOf(profile?.ua);
  const kernelMajor = majorOf(profile?.kernel_version);
  if (!uaMajor || !kernelMajor || uaMajor === kernelMajor) return null;
  return {
    ua_major: uaMajor,
    kernel_major: kernelMajor,
    message: `UA 是 Chrome/${uaMajor}，本机内核是 ${kernelMajor}；按环境自己的 UA 打开，UA 不会被改（要跟内核版本走，请到设置里打开「UA 跟随内核版本升级」）`,
  };
}
