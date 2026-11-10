/**
 * FreePower · 代理探测（fail-closed 的第一道闸）
 *
 * 原则：**代理不可用就不许启动**。启动浏览器之前先从这里走一遍真实出口：
 *   1. 用同一套 host/port/账号密码建立连接（HTTP / HTTPS / SOCKS5）；
 *   2. 通过它请求出口信息接口，拿到出口 IP / 国家 / 城市 / 时区；
 *   3. 任何一步失败 → 上层阻断启动，绝不让内核生成「静默直连」。
 *
 * 这个模块零第三方依赖：HTTP 代理自己拼 CONNECT / absolute-form，
 * SOCKS5 自己做握手（无认证 + 用户名密码认证）。
 */
import net from 'node:net';
import tls from 'node:tls';
import { EGRESS_PROBE_URL, PROXY_PROBE_TIMEOUT_MS } from '../config.js';

/** 主探测失败后的备用出口源（https 走 CONNECT + TLS） */
const FALLBACK_PROBE_URLS = ['https://ipinfo.io/json'];

export function normalizeProxyConfig(p = {}) {
  const raw = String(p.proxy_type || p.type || 'http').toLowerCase();
  const type = raw === 'socks' ? 'socks5' : raw === 'socks5h' ? 'socks5' : raw;
  return {
    type,
    host: String(p.host ?? p.proxy_host ?? '').trim(),
    port: Number(p.port ?? p.proxy_port ?? 0),
    username: String(p.username ?? p.proxy_user ?? ''),
    password: String(p.password ?? p.proxy_pwd ?? ''),
  };
}

export function hasProxy(p) {
  const c = normalizeProxyConfig(p || {});
  return Boolean(c.host) && c.port > 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 增量式 socket 读取器：支持 readExactly / readUntil，避免手写状态机 */
class Reader {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.error = null;
    this.notify = new Set();
    this.onData = (c) => { this.buf = Buffer.concat([this.buf, c]); this.wake(); };
    this.onClose = () => { this.error = this.error || new Error('连接被对端关闭'); this.wake(); };
    this.onError = (e) => { this.error = e; this.wake(); };
    socket.on('data', this.onData);
    socket.on('close', this.onClose);
    socket.on('error', this.onError);
  }

  wake() { for (const fn of [...this.notify]) fn(); }

  detach() {
    this.socket.off('data', this.onData);
    this.socket.off('close', this.onClose);
    this.socket.off('error', this.onError);
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    return rest;
  }

  async wait(match, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = match(this.buf);
      if (hit) {
        this.buf = this.buf.subarray(hit.consumed);
        return hit.value;
      }
      if (this.error) throw this.error;
      if (Date.now() >= deadline) throw new Error(`${label} 超时（${timeoutMs}ms）`);
      await new Promise((resolve) => {
        const done = () => { this.notify.delete(done); clearTimeout(t); resolve(); };
        const t = setTimeout(done, Math.min(50, Math.max(deadline - Date.now(), 1)));
        this.notify.add(done);
      });
    }
  }

  read(n, timeoutMs, label) {
    return this.wait((b) => (b.length >= n ? { consumed: n, value: b.subarray(0, n) } : null), timeoutMs, label);
  }

  readUntil(token, timeoutMs, label) {
    return this.wait((b) => {
      const i = b.indexOf(token);
      return i >= 0 ? { consumed: i + token.length, value: b.subarray(0, i) } : null;
    }, timeoutMs, label);
  }

  /** 读到连接关闭为止（没有 content-length 的响应） */
  async readToEnd(timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (!this.error) {
      if (Date.now() >= deadline) throw new Error(`${label} 超时（${timeoutMs}ms）`);
      await sleep(30);
    }
    const out = this.buf;
    this.buf = Buffer.alloc(0);
    return out;
  }
}

function connectTcp({ host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`连接 ${host}:${port} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.setNoDelay(true); resolve(socket); });
    socket.once('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`连接 ${host}:${port} 失败：${e.code || e.message}`));
    });
  });
}

function tlsUpgrade(socket, servername, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TLS 握手超时：${servername}`)), timeoutMs);
    const s = tls.connect({ socket, servername }, () => { clearTimeout(timer); resolve(s); });
    s.once('error', (e) => { clearTimeout(timer); reject(new Error(`TLS 握手失败：${e.message}`)); });
  });
}

const basicAuth = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

/* --------------------------- SOCKS5 --------------------------- */

function need(reader, n, timeoutMs, label) {
  return reader.read(n, timeoutMs, label);
}

async function socks5Handshake(reader, socket, proxy, { host, port }, timeoutMs) {
  const withAuth = Boolean(proxy.username);
  socket.write(Buffer.from(withAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
  const [ver, method] = await need(reader, 2, timeoutMs, 'SOCKS5 握手');
  if (ver !== 0x05) throw new Error(`SOCKS5 版本异常：${ver}`);
  if (method === 0xff) throw new Error('SOCKS5 代理不接受任何认证方式');
  if (method === 0x02) {
    if (!withAuth) throw new Error('SOCKS5 代理要求用户名密码，但配置里没有');
    const u = Buffer.from(proxy.username, 'utf8');
    const p = Buffer.from(proxy.password || '', 'utf8');
    socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
    const [, status] = await need(reader, 2, timeoutMs, 'SOCKS5 认证');
    if (status !== 0x00) throw new Error('SOCKS5 用户名密码认证失败');
  }

  const name = Buffer.from(host, 'utf8');
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port);
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, portBuf]));

  const head = await need(reader, 4, timeoutMs, 'SOCKS5 CONNECT 响应');
  if (head[1] !== 0x00) throw new Error(`SOCKS5 CONNECT 被拒绝（code ${head[1]}）`);
  const atyp = head[3];
  if (atyp === 0x01) await need(reader, 4 + 2, timeoutMs, 'SOCKS5 绑定地址');
  else if (atyp === 0x04) await need(reader, 16 + 2, timeoutMs, 'SOCKS5 绑定地址');
  else if (atyp === 0x03) {
    const [len] = await need(reader, 1, timeoutMs, 'SOCKS5 绑定域名长度');
    await need(reader, len + 2, timeoutMs, 'SOCKS5 绑定域名');
  } else throw new Error(`SOCKS5 响应地址类型异常：${atyp}`);
}

/* --------------------------- HTTP 响应 --------------------------- */

function parseHeaders(head) {
  const lines = head.split('\r\n');
  const status = Number(/^HTTP\/\d\.\d\s+(\d+)/.exec(lines[0])?.[1] || 0);
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status, statusLine: lines[0], headers };
}

async function readChunked(reader, timeoutMs) {
  const parts = [];
  for (;;) {
    const line = (await reader.readUntil('\r\n', timeoutMs, '读取分块长度')).toString('latin1');
    const size = parseInt(line.split(';')[0].trim(), 16);
    if (!Number.isFinite(size)) throw new Error(`分块长度非法：${line}`);
    if (size === 0) {
      await reader.readUntil('\r\n', timeoutMs, '读取分块结尾').catch(() => Buffer.alloc(0));
      break;
    }
    parts.push(await reader.read(size, timeoutMs, '读取分块内容'));
    await reader.read(2, timeoutMs, '读取分块换行').catch(() => Buffer.alloc(0));
  }
  return Buffer.concat(parts);
}

async function readHttpResponse(reader, timeoutMs) {
  const headBuf = await reader.readUntil('\r\n\r\n', timeoutMs, '读取响应头');
  const { status, statusLine, headers } = parseHeaders(headBuf.toString('latin1'));
  let body;
  if (String(headers['transfer-encoding'] || '').toLowerCase().includes('chunked')) {
    body = await readChunked(reader, timeoutMs);
  } else if (headers['content-length'] !== undefined) {
    body = await reader.read(Number(headers['content-length']), timeoutMs, '读取响应体');
  } else {
    body = await reader.readToEnd(timeoutMs, '读取响应体');
  }
  return { status, statusLine, headers, body: body.toString('utf8') };
}

/**
 * 通过代理发一个 GET（明文 HTTP 走 absolute-form，HTTPS 走 CONNECT + TLS）。
 * @returns {Promise<{status:number, headers:object, body:string}>}
 */
export async function httpGetViaProxy(proxyRaw, rawUrl, { timeoutMs = PROXY_PROBE_TIMEOUT_MS, headers = {} } = {}) {
  const proxy = normalizeProxyConfig(proxyRaw);
  if (!hasProxy(proxy)) throw new Error('代理配置不完整（host/port 为空）');
  if (!['http', 'https', 'socks5'].includes(proxy.type)) throw new Error(`不支持的代理类型：${proxy.type}`);

  const u = new URL(rawUrl);
  const secure = u.protocol === 'https:';
  const host = u.hostname;
  const port = Number(u.port || (secure ? 443 : 80));
  const target = `${u.pathname}${u.search || ''}`;
  const authHeader = proxy.username ? `Proxy-Authorization: ${basicAuth(proxy.username, proxy.password)}\r\n` : '';
  const commonHeaders = Object.entries({ Accept: '*/*', 'Accept-Encoding': 'identity', ...headers })
    .map(([k, v]) => `${k}: ${v}\r\n`).join('');

  let socket;
  let reader;

  if (proxy.type === 'socks5') {
    socket = await connectTcp({ host: proxy.host, port: proxy.port, timeoutMs });
    reader = new Reader(socket);
    await socks5Handshake(reader, socket, proxy, { host, port }, timeoutMs);
    if (secure) {
      const rest = reader.detach();
      if (rest.length) socket.unshift(rest);
      socket = await tlsUpgrade(socket, host, timeoutMs);
      reader = new Reader(socket);
    }
    socket.write(`GET ${target} HTTP/1.1\r\nHost: ${u.host}\r\n${commonHeaders}Connection: close\r\n\r\n`);
    return readHttpResponse(reader, timeoutMs);
  }

  // HTTP / HTTPS 代理
  if (proxy.type === 'https') {
    const raw = await connectTcp({ host: proxy.host, port: proxy.port, timeoutMs });
    raw.removeAllListeners('error');
    socket = await tlsUpgrade(raw, proxy.host, timeoutMs);
  } else {
    socket = await connectTcp({ host: proxy.host, port: proxy.port, timeoutMs });
  }
  reader = new Reader(socket);

  if (secure) {
    if (proxy.type === 'https') throw new Error('https 代理 + https 目标暂不支持（TLS in TLS）');
    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${authHeader}\r\n`);
    const headBuf = await reader.readUntil('\r\n\r\n', timeoutMs, 'CONNECT 响应');
    const { status, statusLine } = parseHeaders(headBuf.toString('latin1'));
    if (status !== 200) throw new Error(`代理拒绝 CONNECT：${statusLine}`);
    const rest = reader.detach();
    if (rest.length) socket.unshift(rest);
    socket = await tlsUpgrade(socket, host, timeoutMs);
    reader = new Reader(socket);
    socket.write(`GET ${target} HTTP/1.1\r\nHost: ${u.host}\r\n${commonHeaders}Connection: close\r\n\r\n`);
    return readHttpResponse(reader, timeoutMs);
  }

  // 明文目标：absolute-form，HTTP/HTTPS 代理都吃这套
  socket.write(
    `GET ${u.href} HTTP/1.1\r\nHost: ${u.host}\r\n${authHeader}${commonHeaders}Connection: close\r\n\r\n`,
  );
  return readHttpResponse(reader, timeoutMs);
}

/* --------------------------- 出口信息 --------------------------- */

/** 把各家的出口接口响应（或纯文本 IP）归一成同一形状 */
export function parseExitInfo(body, sourceUrl = '') {
  const text = String(body || '').trim();
  if (!text) return {};
  if (!text.startsWith('{') && !text.startsWith('[')) {
    const ip = /^(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{6,})$/i.exec(text.split(/\s+/)[0] || '');
    return ip ? { ip: ip[1], source: sourceUrl } : {};
  }
  let j = {};
  try { j = JSON.parse(text); } catch { return {}; }
  if (j.status === 'fail') return { error: j.message || '出口接口返回 fail' };
  const ip = j.query || j.ip || j.origin || '';
  return {
    ip: ip ? String(ip).split(',')[0].trim() : undefined,
    country: j.country || j.country_name || undefined,
    countryCode: String(j.countryCode || j.country_code || '').toUpperCase() || undefined,
    region: j.regionName || j.region || undefined,
    city: j.city || undefined,
    timezone: j.timezone || undefined,
    isp: j.isp || j.org || undefined,
    source: sourceUrl,
  };
}

/**
 * 代理预检。**这是 fail-closed 的判定点**：返回 ok:false 时上层必须拒绝启动。
 * @returns {Promise<{ok:boolean, ip?:string, country?:string, countryCode?:string, city?:string,
 *   timezone?:string, isp?:string, latency_ms:number, probe_url?:string, error?:string,
 *   proxy:{type:string, host:string, port:number}}>}
 */
export async function checkProxy(proxyRaw, {
  url = EGRESS_PROBE_URL,
  timeoutMs = PROXY_PROBE_TIMEOUT_MS,
  fallbackUrls = FALLBACK_PROBE_URLS,
} = {}) {
  const proxy = normalizeProxyConfig(proxyRaw);
  const meta = { type: proxy.type, host: proxy.host, port: proxy.port };
  const t0 = Date.now();
  if (!hasProxy(proxy)) return { ok: false, error: '代理配置不完整（host/port 为空）', latency_ms: 0, proxy: meta };
  if (!['http', 'https', 'socks5'].includes(proxy.type)) {
    return { ok: false, error: `不支持的代理类型：${proxy.type}（只支持 http/https/socks5）`, latency_ms: 0, proxy: meta };
  }

  const attempts = [];
  for (const u of [url, ...fallbackUrls.filter((x) => x !== url)]) {
    try {
      const res = await httpGetViaProxy(proxy, u, { timeoutMs });
      if (res.status === 407) { attempts.push(`${u} → 407 认证失败`); continue; }
      if (res.status !== 200) { attempts.push(`${u} → HTTP ${res.status}`); continue; }
      const info = parseExitInfo(res.body, u);
      if (info.error) { attempts.push(`${u} → ${info.error}`); continue; }
      if (!info.ip) { attempts.push(`${u} → 响应里没有 IP`); continue; }
      return { ok: true, ...info, latency_ms: Date.now() - t0, proxy: meta };
    } catch (e) {
      attempts.push(`${u} → ${e.message}`);
    }
  }
  return {
    ok: false,
    error: `代理不可用：${attempts.join(' | ')}`,
    latency_ms: Date.now() - t0,
    proxy: meta,
  };
}