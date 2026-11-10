import net from 'node:net';
import crypto from 'node:crypto';

/**
 * 极简 CDP over WebSocket 客户端（零依赖）。
 * 只实现我们需要的：文本帧、掩码、扩展长度、分片、ping/pong、close。
 * Chrome 的 DevTools WebSocket 不做 permessage-deflate 协商，所以不用管压缩。
 */
export class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.buf = Buffer.alloc(0);
    this.fragOpcode = 0;
    this.fragBuf = [];
    this.closed = false;
    this.sessionId = null;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onClose(new Error('CDP socket closed')));
    socket.on('error', (err) => this._onClose(err));
  }

  static async connect(wsUrl, { timeoutMs = 10000 } = {}) {
    const u = new URL(wsUrl);
    const port = Number(u.port || 80);
    const host = u.hostname;
    const socket = await new Promise((resolve, reject) => {
      const s = net.connect({ host, port });
      const t = setTimeout(() => { s.destroy(); reject(new Error(`CDP connect timeout: ${wsUrl}`)); }, timeoutMs);
      s.once('connect', () => { clearTimeout(t); resolve(s); });
      s.once('error', (e) => { clearTimeout(t); reject(e); });
    });

    const key = crypto.randomBytes(16).toString('base64');
    const pathWithQuery = u.pathname + (u.search || '');
    socket.write(
      `GET ${pathWithQuery} HTTP/1.1\r\n` +
      `Host: ${host}:${port}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n\r\n'
    );

    return await new Promise((resolve, reject) => {
      let head = Buffer.alloc(0);
      const onData = (chunk) => {
        head = Buffer.concat([head, chunk]);
        const idx = head.indexOf('\r\n\r\n');
        if (idx === -1) return;
        socket.off('data', onData);
        const text = head.subarray(0, idx).toString('latin1');
        if (!/^HTTP\/1\.1 101/.test(text)) {
          socket.destroy();
          reject(new Error(`CDP handshake failed: ${text.split('\r\n')[0]}`));
          return;
        }
        const rest = head.subarray(idx + 4);
        const client = new CdpClient(socket);
        if (rest.length) client._onData(rest);
        resolve(client);
      };
      socket.on('data', onData);
      socket.once('error', reject);
    }).then((c) => c);
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const frame = this._readFrame();
      if (!frame) break;
      this._handleFrame(frame);
    }
  }

  _readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const big = b.readBigUInt64BE(off); off += 8;
      if (big > BigInt(64 * 1024 * 1024)) throw new Error('CDP frame too large');
      len = Number(big);
    }
    let maskKey = null;
    if (masked) {
      if (b.length < off + 4) return null;
      maskKey = b.subarray(off, off + 4); off += 4;
    }
    if (b.length < off + len) return null;
    let payload = b.subarray(off, off + len);
    if (maskKey) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }
    this.buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    if (opcode === 0x8) { this.socket.destroy(); this._onClose(new Error('CDP closed by peer')); return; }
    if (opcode === 0x9) { this._sendFrame(0xa, payload); return; }
    if (opcode === 0xa) return;
    if (opcode === 0x0) {
      this.fragBuf.push(payload);
      if (!fin) return;
      payload = Buffer.concat(this.fragBuf);
      this.fragBuf = [];
      opcode = this.fragOpcode;
    } else if (!fin) {
      this.fragOpcode = opcode;
      this.fragBuf = [payload];
      return;
    }
    if (opcode !== 0x1) return;
    let msg;
    try { msg = JSON.parse(payload.toString('utf8')); } catch { return; }
    this._dispatch(msg);
  }

  _dispatch(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? ' — ' + msg.error.data : ''}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      const list = this.handlers.get(msg.method);
      if (list) for (const fn of list) { try { fn(msg.params, msg.sessionId); } catch { /* 单个 handler 异常不影响其他 */ } }
      const any = this.handlers.get('*');
      if (any) for (const fn of any) { try { fn(msg); } catch { /* ignore */ } }
    }
  }

  _sendFrame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    let header;
    if (masked.length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | masked.length;
    } else if (masked.length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(masked.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(masked.length), 2);
    }
    header[0] = 0x80 | opcode;
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(method, params = {}, sessionId = this.sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP client closed'));
    const id = this.nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this._sendFrame(0x1, Buffer.from(JSON.stringify(msg), 'utf8'));
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
    return () => {
      const l = this.handlers.get(method) || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    };
  }

  _onClose(err) {
    if (this.closed) return;
    this.closed = true;
    for (const [, { reject }] of this.pending) reject(err);
    this.pending.clear();
  }

  close() {
    if (this.closed) return;
    try { this._sendFrame(0x8, Buffer.alloc(0)); } catch { /* ignore */ }
    try { this.socket.destroy(); } catch { /* ignore */ }
    this._onClose(new Error('CDP client closed by us'));
  }
}

export async function fetchJson(url, { timeoutMs = 5000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}
