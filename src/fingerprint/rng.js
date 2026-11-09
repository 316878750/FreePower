import crypto from 'node:crypto';

/** mulberry32：同一种子出同一序列，canvas/audio 噪声必须可复现，否则用户每次启动都被判「换设备」 */
export function seededRng(seedStr) {
  const h = crypto.createHash('sha256').update(String(seedStr)).digest();
  let a = h.readUInt32LE(0) || 1;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

export function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

export function newSeed() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');
}

/** AdsPower 风格的短 id；profile_id 全局唯一即可，不猜测对方编码 */
export function newProfileId(rng = crypto.randomBytes(6)) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (const b of rng) out += alphabet[b % alphabet.length];
  return out.slice(0, 8);
}
