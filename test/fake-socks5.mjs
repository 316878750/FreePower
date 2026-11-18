/**
 * 测试用「假 SOCKS5 代理」（要求用户名密码，RFC1929）＋ 一个带 Basic 认证的 HTTP CONNECT 代理。
 *
 * 存在的理由（0.4.7.3 P0）：用户 50 个环境全是 `socks5 + 用户名密码`，而 **Chrome 内核不支持
 * SOCKS5 认证**（只发 no-auth 0x00，服务端要 0x02 → 握手失败）。要证明「装中继前必失败、
 * 装中继后能通、且凭据真的送到了上游」，就必须有一个**真的会拒绝匿名客户端**的上游。
 * mock 掉这一步等于把判据写成「自己跟自己对上」。
 *
 * 记录口径（判据直接读这些数组）：
 *   - `records[]`：每条连接一条 `{ offered, method, auth:{username,password,ok}, cmd, host, port, status }`
 *   - `authSeen[]`：`{username, password}` —— 断言「凭据 = 环境里的账号密码」用它
 *   - `connects[]`：`{host, port, status}` —— 断言「隧道目标真的是那个站」
 *
 * 目标解析：`host` 是 `target.test` 这类测试主机名时交给 `dialHost` 映射到 127.0.0.1，
 * 这样浏览器/中继侧的 DNS 都不用碰外网。
 */
import net from 'node:net';

const CRLF = '\r\n';

function readExactly(socket, state, n) {
  return new Promise((resolve, reject) => {
    const tryTake = () => {
      if (state.buf.length >= n) {
        const out = state.buf.subarray(0, n);
        state.buf = state.buf.subarray(n);
        cleanup();
        resolve(out);
        return true;
      }
      return false;
    };
    const onData = (c) => { state.buf = Buffer.concat([state.buf, c]); tryTake(); };
    const onErr = (e) => { cleanup(); reject(e); };
    const onClose = () => { cleanup(); reject(new Error('客户端提前断开')); };
    const cleanup = () => {
      socket.off('data', onData); socket.off('error', onErr); socket.off('close', onClose);
    };
    if (tryTake()) return;
    socket.on('data', onData);
    socket.on('error', onErr);
    socket.on('close', onClose);
  });
}

/**
 * @param {object} opt
 * @param {[string,string]|null} opt.requireAuth 要求用户名密码时传 `['user','pass']`
 * @param {(h:string)=>string} opt.dialHost 目标主机名映射（测试主机名 → 127.0.0.1）
 * @param {string} opt.ip 出口 IP（本假代理不返回出口信息，这条只用于文档/日志）
 * @param {number} opt.handshakeConcurrency 同时处理几个握手；传有限值就**串行排队**（0.4.7.5 用）
 * @param {number} opt.handshakeMs 每个握手占用的时间（模拟远端代理的握手成本）
 * @param {boolean} opt.sink true = 回 OK 后不真拨目标、数据全丢（只数域名，0.4.7.5 用）
 * @param {number} opt.failFirstN 前 N 个握手回 REP_FAIL（验退避重试真的重试了）
 * @param {number} opt.port 指定监听端口（0 = 系统分配）；「稍后再起来」的重试判据要它
 */
export function startFakeSocks5({
  requireAuth = ['socks-user', 'socks-pass'],
  dialHost = (h) => h,
  label = 'fake-socks5',
  timeoutMs = 8000,
  handshakeConcurrency = Infinity,
  handshakeMs = 0,
  sink = false,
  capture = false,
  failFirstN = 0,
  port = 0,
} = {}) {
  const records = [];
  const authSeen = [];
  const connects = [];
  const sockets = new Set();
  /** 握手并发读数：判据断言「有界」用它 */
  const stats = { connections: 0, handshakes: 0, failed: 0, inFlight: 0, maxInFlight: 0, queued: 0 };
  const gated = Number.isFinite(handshakeConcurrency);
  let active = 0;
  const waiters = [];
  const acquire = async () => {
    if (active < handshakeConcurrency) { active += 1; return; }
    stats.queued += 1;
    await new Promise((r) => waiters.push(r));
    active += 1;
  };
  const release = () => {
    active -= 1;
    const next = waiters.shift();
    if (next) next();
  };

  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => { /* 对端断，正常 */ });
    const state = { buf: Buffer.alloc(0) };
    const rec = { label, offered: [], method: null, auth: null, cmd: null, host: null, port: null, status: null };
    records.push(rec);
    stats.connections += 1;
    const run = async () => {
      if (gated) { await acquire(); stats.inFlight += 1; stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight); }
      try {
        if (handshakeMs > 0) await new Promise((r) => setTimeout(r, handshakeMs));
        await handle(client, state, rec);
      } finally {
        if (gated) { stats.inFlight -= 1; release(); }
      }
    };
    run().catch((e) => { rec.status = rec.status || `error:${e.message}`; try { client.destroy(); } catch { /* ignore */ } });
  });

  async function handle(client, state, rec) {
    // ① 问候
    const [ver, n] = await readExactly(client, state, 2);
    if (ver !== 0x05) { rec.status = 'bad_version'; client.destroy(); return; }
    const methods = await readExactly(client, state, n);
    rec.offered = [...methods];
    // 前 N 个握手直接失败（验退避重试）
    if (stats.handshakes < failFirstN) {
      stats.handshakes += 1;
      stats.failed += 1;
      rec.status = 'forced_fail';
      client.write(Buffer.from([0x05, 0x01]));
      client.end();
      return;
    }
    const wantUserPass = Boolean(requireAuth);
    if (wantUserPass) {
      if (!methods.includes(0x02)) {
        // 用户那台代理的行为：只报 no-auth 就回 0x02（必须用户名密码）→ 客户端失败
        rec.status = 'reject_no_auth_offered';
        client.write(Buffer.from([0x05, 0x02]));
        client.end();
        return;
      }
      client.write(Buffer.from([0x05, 0x02]));
    } else {
      if (!methods.includes(0x00)) { rec.status = 'reject_no_noauth_method'; client.write(Buffer.from([0x05, 0xff])); client.end(); return; }
      client.write(Buffer.from([0x05, 0x00]));
    }
    rec.method = wantUserPass ? 0x02 : 0x00;

    // ② RFC1929 子协商
    if (wantUserPass) {
      const [sv] = await readExactly(client, state, 1);
      const [ulen] = await readExactly(client, state, 1);
      const uname = (await readExactly(client, state, ulen)).toString('utf8');
      const [plen] = await readExactly(client, state, 1);
      const passwd = (await readExactly(client, state, plen)).toString('utf8');
      const ok = sv === 0x01 && uname === requireAuth[0] && passwd === requireAuth[1];
      rec.auth = { username: uname, password: passwd, ok };
      authSeen.push({ username: uname, password: passwd });
      if (!ok) { rec.status = 'auth_failed'; client.write(Buffer.from([0x01, 0x01])); client.end(); return; }
      client.write(Buffer.from([0x01, 0x00]));
    }

    // ③ 请求
    const head = await readExactly(client, state, 4);
    rec.cmd = head[1];
    const atyp = head[3];
    let host = '';
    if (atyp === 0x01) host = [...(await readExactly(client, state, 4))].join('.');
    else if (atyp === 0x04) {
      const b = await readExactly(client, state, 16);
      const parts = [];
      for (let i = 0; i < 16; i += 2) parts.push(b.readUInt16BE(i).toString(16));
      host = parts.join(':');
    } else if (atyp === 0x03) {
      const [len] = await readExactly(client, state, 1);
      host = (await readExactly(client, state, len)).toString('utf8');
    } else { rec.status = `bad_atyp:${atyp}`; client.destroy(); return; }
    const port = (await readExactly(client, state, 2)).readUInt16BE(0);
    rec.host = host; rec.port = port;

    if (rec.cmd !== 0x01) {
      rec.status = 'cmd_unsupported';
      client.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      client.end();
      return;
    }

    stats.handshakes += 1;

    // sink：只数域名，不真拨目标（0.4.7.5 数「Chrome 想连哪些域名」用）
    if (sink) {
      rec.status = 'sink';
      connects.push({ host, port, status: 'sink' });
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      // 记下第一条明文（HTTP 请求行能直接看出是哪个后台任务；TLS 只有 SNI，看不出路径）
      if (capture) {
        rec.first = '';
        client.once('data', (c) => { rec.first = c.subarray(0, 200).toString('latin1'); });
      }
      client.on('data', () => { /* 丢弃 */ });
      return;
    }

    const up = net.connect({ host: dialHost(host), port });
    sockets.add(up);
    up.on('close', () => sockets.delete(up));
    up.setTimeout(timeoutMs, () => { up.destroy(); });
    up.once('error', (e) => {
      rec.status = `upstream:${e.code || e.message}`;
      connects.push({ host, port, status: rec.status });
      try { client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch { /* ignore */ }
      try { client.destroy(); } catch { /* ignore */ }
    });
    up.once('connect', () => {
      up.setTimeout(0);
      rec.status = 'tunnel';
      connects.push({ host, port, status: 'tunnel' });
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      client.pipe(up);
      up.pipe(client);
    });
  }

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        label,
        port,
        records,
        authSeen,
        connects,
        sockets,
        stats,
        /** 记录到的目标域名（去重、按出现顺序） */
        hostnames: () => [...new Set(records.map((r) => r.host).filter(Boolean))],
        url: `socks5://127.0.0.1:${port}`,
        close: () => new Promise((r) => {
          for (const s of sockets) { try { s.destroy(); } catch { /* ignore */ } }
          sockets.clear();
          server.close(() => r());
        }),
      });
    });
  });
}

/**
 * 带 Basic 认证的 HTTP CONNECT 代理（判据④：http 带凭据代理也走中继）。
 * 只做 CONNECT；明文 absolute-form 直接 405（中继只会对它发 CONNECT）。
 */
export function startFakeConnectProxy({ requireAuth = ['http-user', 'http-pass'], dialHost = (h) => h } = {}) {
  const records = [];
  const authSeen = [];
  const sockets = new Set();
  const want = `Basic ${Buffer.from(`${requireAuth[0]}:${requireAuth[1]}`).toString('base64')}`;

  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => { /* ignore */ });
    const state = { buf: Buffer.alloc(0) };
    const readHead = () => new Promise((resolve, reject) => {
      const tryTake = () => {
        const i = state.buf.indexOf(`${CRLF}${CRLF}`);
        if (i < 0) return false;
        const head = state.buf.subarray(0, i).toString('latin1');
        state.buf = state.buf.subarray(i + 4);
        cleanup(); resolve(head); return true;
      };
      const onData = (c) => { state.buf = Buffer.concat([state.buf, c]); tryTake(); };
      const onErr = (e) => { cleanup(); reject(e); };
      const onClose = () => { cleanup(); reject(new Error('客户端提前断开')); };
      const cleanup = () => { client.off('data', onData); client.off('error', onErr); client.off('close', onClose); };
      if (tryTake()) return;
      client.on('data', onData); client.on('error', onErr); client.on('close', onClose);
    });

    (async () => {
      const head = await readHead();
      const lines = head.split(CRLF);
      const [method, target] = String(lines[0] || '').split(' ');
      const headers = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      const rec = { method, target, auth: headers['proxy-authorization'] || '', status: null };
      records.push(rec);
      if (rec.auth !== want) {
        rec.status = 407;
        client.end(`HTTP/1.1 407 Proxy Authentication Required${CRLF}Proxy-Authenticate: Basic realm="fake"${CRLF}Content-Length: 0${CRLF}${CRLF}`);
        return;
      }
      if (String(method).toUpperCase() !== 'CONNECT') {
        rec.status = 405;
        client.end(`HTTP/1.1 405 Method Not Allowed${CRLF}Content-Length: 0${CRLF}${CRLF}`);
        return;
      }
      const i = String(target).lastIndexOf(':');
      const host = String(target).slice(0, i);
      const port = Number(String(target).slice(i + 1));
      const up = net.connect({ host: dialHost(host), port });
      sockets.add(up);
      up.on('close', () => sockets.delete(up));
      up.once('error', () => {
        rec.status = 502;
        try { client.end(`HTTP/1.1 502 Bad Gateway${CRLF}Content-Length: 0${CRLF}${CRLF}`); } catch { /* ignore */ }
      });
      up.once('connect', () => {
        rec.status = 200;
        // 记下凭据明文，判据直接比
        authSeen.push(rec.auth);
        client.write(`HTTP/1.1 200 Connection Established${CRLF}${CRLF}`);
        client.pipe(up);
        up.pipe(client);
      });
    })().catch(() => { try { client.destroy(); } catch { /* ignore */ } });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        records,
        authSeen,
        sockets,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => {
          for (const s of sockets) { try { s.destroy(); } catch { /* ignore */ } }
          sockets.clear();
          server.close(() => r());
        }),
      });
    });
  });
}
