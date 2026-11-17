/**
 * 起始页的一次性签名（0.4.7.3）。
 *
 * 为什么需要它：起始页是**浏览器里直接打开的本地页面**，不能把 master api_key 拼进 URL
 * （会进浏览器历史、进内核日志、进截图）。所以用「绑定 profile_id 的短期签名」代替 key ——
 * 泄露影响面只有一个环境的起始页读数，且有过期时间。
 *
 * 与自检报告票据（`src/api/tickets.js`）的区别：那是内存里的**一次性**票据，只活 120 秒；
 * 起始页会在环境里停留很久，用户还会点「重新检测」、刷新页面，所以这里用**签名**（可重复校验、
 * 24 小时过期），而不是一次性票据。
 *
 * 密钥落在数据目录（`data/start.secret`，32 字节随机 hex）：
 *   - 每台机器不同：别的机器上伪造不出本机的签名；
 *   - 进程重启后仍然有效：否则「重启 FreePower → 环境里那张起始页一刷新就 403」；
 *   - 不写库、不进日志、不进任何响应。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

const SECRET_FILE = path.join(DATA_DIR, 'start.secret');

/** 签名有效期：24 小时。够长到「今天开的环境、明天刷新还能看」，短到泄漏也不长久 */
export const START_SIG_TTL_MS = 24 * 60 * 60 * 1000;

let cachedSecret = null;

function secret() {
  if (cachedSecret) return cachedSecret;
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (s.length >= 32) { cachedSecret = s; return cachedSecret; }
  } catch { /* 没写过 */ }
  const s = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  } catch { /* 写不上就只在内存里用：重启后旧签名失效，功能不残 */ }
  cachedSecret = s;
  return cachedSecret;
}

/** 判据用：换一把新密钥（只影响本进程） */
export function resetStartSecretForTest() {
  cachedSecret = null;
}

function mac(profileId, exp) {
  return crypto.createHmac('sha256', secret()).update(`${String(profileId)}\n${exp}`).digest('base64url');
}

/**
 * 签一个起始页参数。
 * @param {string} profileId
 * @returns {string} `<过期毫秒时间戳>.<base64url(HMAC)>`
 */
export function signStart(profileId, { ttlMs = START_SIG_TTL_MS } = {}) {
  const exp = Date.now() + Math.max(1000, Number(ttlMs) || START_SIG_TTL_MS);
  return `${exp}.${mac(profileId, exp)}`;
}

/**
 * 校验签名。
 * @returns {{ok:true}|{ok:false, reason:'malformed'|'expired'|'bad_sig'}}
 */
export function verifyStart(profileId, sig) {
  const text = String(sig || '');
  const dot = text.indexOf('.');
  if (dot <= 0) return { ok: false, reason: 'malformed' };
  const exp = Number(text.slice(0, dot));
  const given = text.slice(dot + 1);
  if (!Number.isFinite(exp) || !given) return { ok: false, reason: 'malformed' };
  if (Date.now() > exp) return { ok: false, reason: 'expired' };
  const want = mac(profileId, exp);
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  // 长度不同时 timingSafeEqual 会抛，先判长度（长度本身不是秘密）
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_sig' };
  return { ok: true };
}
