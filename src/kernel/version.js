/**
 * FreePower · UA / 内核版本跟版
 *
 * 背景：直接用系统 Chrome 时它会在后台自动升级（实测 22 小时内 156 → 157），
 * 而环境里存着上一版生成的 UA。漂移的后果是「UA 报 156、内核真的 157」——最容易被抓的矛盾。
 *
 * 策略：启动时用 Browser.getVersion 拿到的**真实内核版本**做一次对齐，
 * 把 UA 的版本段、UA-CH 的 ua_full_version / brands、以及 kernel_version 列全部拉到真实值，
 * 并落库（下次启动就不用再对齐）。不想自动改就设 FREEPOWER_UA_AUTOALIGN=0。
 */

const majorOf = (v) => String(v || '').split('.')[0];

/**
 * @param {object} profile 平铺 profile 记录
 * @param {string} realVersion 内核真实完整版本（如 157.0.8103.40）
 * @returns {{profile:object, patch:object, changed:boolean, from:string|null, to:string|null, reasons:string[]}}
 */
export function alignProfileToKernel(profile, realVersion) {
  const real = String(realVersion || '').trim();
  if (!real || !/^\d+\.\d+\.\d+\.\d+$/.test(real)) {
    return { profile, patch: {}, changed: false, from: null, to: null, reasons: [] };
  }
  const realMajor = majorOf(real);
  const patch = {};
  const next = { ...profile };
  const reasons = [];

  // 1) UA 字符串里的 Chrome/<version>
  const ua = typeof profile.ua === 'string' ? profile.ua : '';
  const m = /Chrome\/([\d.]+)/.exec(ua);
  if (m) {
    const declaredMajor = majorOf(m[1]);
    if (declaredMajor !== realMajor) {
      const aligned = ua.replace(/Chrome\/[\d.]+/, `Chrome/${realMajor}.0.0.0`);
      if (aligned !== ua) {
        patch.ua = aligned;
        next.ua = aligned;
        reasons.push(`UA 版本段 ${m[1]} → ${realMajor}.0.0.0`);
      }
    }
  }

  // 2) UA-CH：ua_full_version / brands / fullVersionList
  const hints = profile.client_hints && typeof profile.client_hints === 'object'
    ? { ...profile.client_hints }
    : null;
  const declaredFull = hints?.ua_full_version ? String(hints.ua_full_version) : null;
  if (hints && declaredFull && declaredFull !== real) {
    hints.ua_full_version = real;
    if (Array.isArray(hints.brands)) {
      hints.brands = hints.brands.map((b) => ({ ...b, version: majorOf(b.version) === realMajor ? b.version : realMajor }));
    }
    if (Array.isArray(hints.fullVersionList)) {
      hints.fullVersionList = hints.fullVersionList.map((b) => ({ ...b, version: b.brand === 'Not_A Brand' ? b.version : real }));
    }
    patch.client_hints = hints;
    next.client_hints = hints;
    reasons.push(`UA-CH ua_full_version ${declaredFull} → ${real}`);
  }

  // 3) 记录列：内核版本以真实内核为准
  if (String(profile.kernel_version || '') !== real) {
    patch.kernel_version = real;
    next.kernel_version = real;
    reasons.push(`kernel_version ${profile.kernel_version || '(空)'} → ${real}`);
  }

  return {
    profile: next,
    patch,
    changed: Object.keys(patch).length > 0,
    from: declaredFull || (m ? m[1] : null),
    to: real,
    reasons,
  };
}