/**
 * 噪点四件套的确定性种子。
 *
 * 契约：canvas / webgl_image / audio / client_rects 各有独立种子（拆解实测是四个字段），
 * 种子落库（fingerprint_config 的 *_id），**跨重启必须一致**。
 * 同一环境换内核、改 UA、换代理都不能让这四个值漂移，否则等于告诉站点「你换了设备」。
 *
 * 这里只做「派生 + 补齐」：新环境由 generate.js 生成时写入，老环境缺哪个补哪个。
 */

/** 有符号 32 位整数（对齐拆解实测：AudioFp / ClientRectFp 是有符号整数） */
export function seedOf(seedStr, salt) {
  let h = (2166136261 ^ salt) >>> 0;
  const s = `${seedStr}:${salt}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h | 0;
}

export const NOISE_FIELDS = ['canvas_id', 'webgl_image_id', 'audio_id', 'client_rects_id'];

/** 种子 → 四个维度种子（salt 固定，改了就等于换指纹） */
export function deriveNoiseSeeds(seed) {
  const s = String(seed ?? 'freepower');
  return {
    canvas_id: seedOf(s, 1),
    webgl_image_id: seedOf(s, 2),
    audio_id: seedOf(s, 3),
    client_rects_id: seedOf(s, 4),
  };
}

/**
 * 老环境（迁移来的、手写的）可能缺 *_id：按 fp_seed 派生并返回补丁。
 * 已有值一个都不动 —— 那是这个环境的历史指纹。
 *
 * @returns {object} 需要落库的字段（空对象表示不缺）
 */
export function ensureNoiseSeeds(profile = {}) {
  const seed = profile.fp_seed ?? profile.id ?? profile.profile_id ?? 'freepower';
  const derived = deriveNoiseSeeds(seed);
  const patch = {};
  for (const key of NOISE_FIELDS) {
    const cur = profile[key];
    if (cur === undefined || cur === null || cur === '') patch[key] = derived[key];
  }
  return patch;
}
