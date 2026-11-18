/**
 * 带凭据代理的本地中继（0.4.7.3，P0）
 *
 * 为什么要有这个文件：**Chrome 内核不支持 SOCKS5 认证**。
 * `--proxy-server=socks5://host:port` 只会发 `no-auth(0x00)`；服务端要求
 * `0x02`（用户名密码）时握手直接失败 → 所有请求 ERR_BLOCKED_BY_CLIENT，页面全打不开。
 * 而我们在 Node 侧做的代理预检是**带凭据**的，能通 —— 于是出现「预检绿、浏览器全红」
 * 的静默错配（用户 50 个 socks5 环境全中）。HTTP 代理的认证虽然内核能靠
 * `Fetch.authRequired` 挑战走通，但那条路依赖页面级事件、每次新会话都要重走一遍；
 * 凭据一律走中继更稳，也少一层页面可见的挑战。
 *
 * 结构：
 *   浏览器 --socks5://127.0.0.1:<port>--> 本模块（**对浏览器不要求认证**）
 *          --(上游协议与凭据)--> 上游代理 --> 目标
 *
 * 硬约束（都不是可选项）：
 *   - 只 bind `127.0.0.1`，端口由系统分配（`listen(0)`）—— 绝不 0.0.0.0，
 *     否则局域网里谁都能白用这个环境的代理出口；
 *   - 凭据只出现在发往**上游**的握手报文里：日志、启动响应、页面里都不许出现
 *     （调用方只打 `127.0.0.1:<port> → host:port`）；
 *   - 上游失败 → 给浏览器回 SOCKS5 失败码，并把原因记进 `lastError`；
 *     上层据此 fail-closed（**绝不降级直连**）；
 *   - `close()` 先 destroy 所有 socket 再 close 监听 —— 否则反复起停会漏端口。
 */
import net from 'node:net';

const CRLF = '\r\n';
/**
 * 单连接（上游拨号 + SOCKS5 握手）的超时。
 *
 * 0.4.7.5：10s → **60s**。两次实测支撑这个数：
 *   ① 用户 4 个环境同开时，Chrome 一个实例会对中继开 14 条连接（10 条是 Google 后台），
 *      远端代理在 14 并发下 TCP connect 排队 3.6s→10.6s，再加 SOCKS5 认证就超过 10s ——
 *      中继回 REP_FAIL，Chrome 报 `ERR_SOCKS_CONNECTION_FAILED(-120)`，页面全打不开；
 *   ② CEO 2026-11-18 复测**单连接**（不并发、不经中继、直连上游）：第 1 发 35,572ms 才通
 *      （其中主探测源 ip-api.com 25 秒超时失败，靠备用源 ipinfo.io 救回来），第 2 发 691ms。
 *      冷启动第一发 25 秒都不够，所以 30s 仍偏紧 —— 定 60s。
 * 真正的解法是下面的有界并发（不把上游 accept 队列打满），超时只是兜底预算。
 */
const DEFAULT_TIMEOUT_MS = 60000;
/**
 * 上游拨号的**有界并发**上限（0.4.7.5）。
 *
 * 为什么必须有：无上限扇出会把上游的 accept 队列打满 —— 我们这边 14 条一起拨，
 * 上游侧就排队到 10 秒以上；而用户那台代理在 40+ 连接时直接被供应商限流。
 * 4 是实测值：4 并发打同一台上游全通、~500ms；再多的收益只是把排队从上游挪到我们这边，
 * 但**我们有队列、有 30s 预算，上游没有**。可用 `FREEPOWER_RELAY_CONCURRENCY` 覆盖。
 *
 * 槽位只覆盖「拨号 + 握手」这一段，隧道建好立刻释放 —— 长连接不占槽，
 * 否则一个开着 6 个标签页的环境会把 4 个槽全占死。
 */
const DEFAULT_CONCURRENCY = Number(process.env.FREEPOWER_RELAY_CONCURRENCY || 4) || 4;
/**
 * 上游拨号**重试**（0.4.7.5 追加）。
 *
 * 为什么光有队列不够：供应商限流时不是「慢」，而是**直接丢 SYN** —— 我们实测串行 5/5 通，
 * 4 并发时 14 条里只成 3 条，失败全是 `connect ETIMEDOUT`（Windows 上 SYN 被丢约 21s 才报）。
 * 一次丢包就报废一条浏览器连接，页面自然打不开。重拨一次就是重新掷骰子（实测单次成功率 ~1/3）。
 *
 * 每次拨号上限 21s（再等也还是 ETIMEDOUT），总预算仍受 `timeoutMs` 约束，不会把 60s 花光。
 */
const DIAL_ATTEMPT_MS = 21000;
const DEFAULT_DIAL_ATTEMPTS = Math.max(1, Math.min(5, Number(process.env.FREEPOWER_RELAY_DIAL_ATTEMPTS || 3) || 3));
const MAX_HEAD_BYTES = 64 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* SOCKS5 常量 */
const VER = 0x05;
const M_NOAUTH = 0x00;
const M_USERPASS = 0x02;
const M_NONE = 0xff;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;

/* SOCKS5 回复码 */
const REP_OK = 0x00;
const REP_FAIL = 0x01;
const REP_HOST_UNREACH = 0x04;
const REP_REFUSED = 0x05;
const REP_CMD_UNSUPPORTED = 0x07;

/** 读 socket 的小工具：按需拿够 N 字节，多余字节留在缓冲里（之后交给裸 pipe） */
class Reader {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.error = null;
    this.waiters = new Set();
    this.onData = (c) => { this.buf = Buffer.concat([this.buf, c]); this.wake(); };
    this.onClose = () => { this.error = this.error || new Error('连接被对端关闭'); this.wake(); };
    this.onErr = (e) => { this.error = e; this.wake(); };
    socket.on('data', this.onData);
    socket.on('close', this.onClose);
    socket.on('error', this.onErr);
  }

  wake() { for (const fn of [...this.waiters]) fn(); }

  async readExactly(n, timeoutMs, what = '数据') {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.buf.length >= n) {
        const out = this.buf.subarray(0, n);
        this.buf = this.buf.subarray(n);
        return out;
      }
      if (this.error) throw this.error;
      if (Date.now() >= deadline) throw new Error(`等${what}超时（${timeoutMs}ms）`);
      await new Promise((resolve) => {
        const done = () => { this.waiters.delete(done); clearTimeout(t); resolve(); };
        const t = setTimeout(done, Math.min(50, Math.max(deadline - Date.now(), 1)));
        this.waiters.add(done);
      });
    }
  }

  /** 读到 \r\n\r\n 为止（HTTP 响应头） */
  async readHead(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.buf.indexOf(`${CRLF}${CRLF}`);
      if (idx >= 0) {
        const head = this.buf.subarray(0, idx).toString('latin1');
        this.buf = this.buf.subarray(idx + 4);
        return head;
      }
      if (this.buf.length > MAX_HEAD_BYTES) throw new Error('上游响应头过大');
      if (this.error) throw this.error;
      if (Date.now() >= deadline) throw new Error(`上游握手超时（${timeoutMs}ms）`);
      await new Promise((resolve) => {
        const done = () => { this.waiters.delete(done); clearTimeout(t); resolve(); };
        const t = setTimeout(done, Math.min(50, Math.max(deadline - Date.now(), 1)));
        this.waiters.add(done);
      });
    }
  }

  detach() {
    this.socket.off('data', this.onData);
    this.socket.off('close', this.onClose);
    this.socket.off('error', this.onErr);
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    return rest;
  }
}

function dial(host, port, timeoutMs, label = '上游') {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(Object.assign(new Error(`连不上${label} ${host}:${port}（${timeoutMs}ms 超时）`), { reason: 'timeout' }));
    }, timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); sock.setNoDelay(true); resolve(sock); });
    sock.once('error', (e) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`连不上${label} ${host}:${port}：${e.message}`), { reason: e.code || 'error' }));
    });
  });
}

/**
 * 上游拨号（带重试）。只有「连不上」才重试 —— 握手阶段失败（认证错、上游拒绝）重试没有意义，
 * 那是配置问题，重试只会把错误拖成超时。
 */
async function dialUpstream(upstream, timeoutMs, state) {
  const deadline = Date.now() + timeoutMs;
  const attempts = state.dialAttempts;
  let last = null;
  for (let i = 1; i <= attempts; i += 1) {
    const left = deadline - Date.now();
    if (left <= 250) break;
    state.stats.dial_attempts += 1;
    try {
      return await dial(upstream.host, upstream.port, Math.min(DIAL_ATTEMPT_MS, left));
    } catch (e) {
      last = e;
      if (i < attempts) {
        state.stats.dial_retries += 1;
        state.lastError = e;
        await sleep(Math.min(400, Math.max(deadline - Date.now(), 1)));
      }
    }
  }
  throw last || Object.assign(
    new Error(`连不上上游 ${upstream.host}:${upstream.port}（${timeoutMs}ms 内没连上）`),
    { reason: 'timeout' },
  );
}

/* ------------------------------ 上游握手 ------------------------------ */

/**
 * SOCKS5 上游：greeting（同时提供 no-auth 与用户名密码）→ 必要时 RFC1929 子协商 → CONNECT。
 * 目标用**域名**形式交给上游（DNS 在上游解析，语义等同 socks5h）—— 本机不做 DNS 泄漏。
 */
async function openSocks5Upstream(upstream, host, port, timeoutMs, state) {
  const sock = await dialUpstream(upstream, timeoutMs, state);
  const rd = new Reader(sock);
  try {
    const methods = (upstream.username || upstream.password) ? [M_NOAUTH, M_USERPASS] : [M_NOAUTH];
    sock.write(Buffer.from([VER, methods.length, ...methods]));
    const [v, chosen] = await rd.readExactly(2, timeoutMs, '上游 SOCKS5 方法选择');
    if (v !== VER) throw Object.assign(new Error('上游不是 SOCKS5（版本号不对）'), { reason: 'bad_upstream' });
    if (chosen === M_NONE) {
      throw Object.assign(new Error('上游不接受我们提供的认证方式'), { reason: 'proxy_auth_unsupported' });
    }
    if (chosen === M_USERPASS) {
      const user = Buffer.from(String(upstream.username || ''), 'utf8');
      const pass = Buffer.from(String(upstream.password || ''), 'utf8');
      if (!user.length) throw Object.assign(new Error('上游要求用户名密码，但环境里没有配用户名'), { reason: 'proxy_auth_missing' });
      sock.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
      const [sv, status] = await rd.readExactly(2, timeoutMs, '上游 SOCKS5 认证结果');
      if (sv !== 0x01) throw Object.assign(new Error('上游不是 SOCKS5 用户名密码子协商'), { reason: 'bad_upstream' });
      if (status !== 0x00) throw Object.assign(new Error('上游代理认证失败（用户名或密码不对）'), { reason: 'proxy_auth_failed' });
    }

    // CONNECT：域名优先（域名长度 > 255 时退回 IPv4 字面量，正常不会发生）
    const name = Buffer.from(String(host), 'utf8');
    let req;
    if (name.length > 0 && name.length <= 255) {
      req = Buffer.concat([Buffer.from([VER, CMD_CONNECT, 0x00, ATYP_DOMAIN, name.length]), name, Buffer.from([(port >> 8) & 0xff, port & 0xff])]);
    } else {
      throw Object.assign(new Error(`目标主机名不合法：${host}`), { reason: 'bad_target' });
    }
    sock.write(req);
    const head = await rd.readExactly(4, timeoutMs, '上游 SOCKS5 CONNECT 回复');
    if (head[0] !== VER) throw Object.assign(new Error('上游 SOCKS5 回复版本不对'), { reason: 'bad_upstream' });
    if (head[1] !== REP_OK) {
      const reason = head[1] === REP_REFUSED ? 'proxy_refused'
        : head[1] === REP_HOST_UNREACH ? 'host_unreachable' : 'proxy_error';
      throw Object.assign(new Error(`上游代理拒绝连接 ${host}:${port}（SOCKS5 码 ${head[1]}）`), { reason, code: head[1] });
    }
    // 吃掉 BND.ADDR + BND.PORT（长度取决于地址类型）
    const atyp = head[3];
    const addrLen = atyp === ATYP_IPV4 ? 4 : atyp === ATYP_IPV6 ? 16 : atyp === ATYP_DOMAIN ? null : 0;
    if (addrLen === null) {
      const [len] = await rd.readExactly(1, timeoutMs, '上游 SOCKS5 绑定地址长度');
      await rd.readExactly(len + 2, timeoutMs, '上游 SOCKS5 绑定地址');
    } else {
      await rd.readExactly(addrLen + 2, timeoutMs, '上游 SOCKS5 绑定地址');
    }
    const rest = rd.detach();
    return { socket: sock, rest };
  } catch (e) {
    rd.detach();
    try { sock.destroy(); } catch { /* 已经断了 */ }
    throw e;
  }
}

/** HTTP/HTTPS 上游：CONNECT + `Proxy-Authorization: Basic`（凭据只在这一段出现） */
async function openHttpUpstream(upstream, host, port, timeoutMs, state) {
  const sock = await dialUpstream(upstream, timeoutMs, state);
  const rd = new Reader(sock);
  try {
    const authority = `${host}:${port}`;
    const auth = (upstream.username || upstream.password)
      ? `Proxy-Authorization: Basic ${Buffer.from(`${upstream.username || ''}:${upstream.password || ''}`).toString('base64')}${CRLF}`
      : '';
    sock.write(`CONNECT ${authority} HTTP/1.1${CRLF}Host: ${authority}${CRLF}${auth}${CRLF}`);
    const head = await rd.readHead(timeoutMs);
    const status = Number(String(head.split(CRLF)[0] || '').split(' ')[1]);
    if (status === 407) {
      throw Object.assign(new Error('上游代理认证失败（407，用户名或密码不对）'), { reason: 'proxy_auth_failed', status });
    }
    if (status !== 200) {
      throw Object.assign(new Error(`上游代理拒绝 CONNECT ${authority}（HTTP ${status}）`), { reason: 'proxy_refused', status });
    }
    const rest = rd.detach();
    return { socket: sock, rest };
  } catch (e) {
    rd.detach();
    try { sock.destroy(); } catch { /* 已经断了 */ }
    throw e;
  }
}

function openUpstream(upstream, host, port, timeoutMs, state) {
  const type = String(upstream.type || 'http').toLowerCase();
  if (type === 'socks5' || type === 'socks') return openSocks5Upstream(upstream, host, port, timeoutMs, state);
  return openHttpUpstream(upstream, host, port, timeoutMs, state);
}

/* ------------------------------ 本地监听 ------------------------------ */

/**
 * 上游拨号的槽位门（有界并发 + 排队）。
 * 槽位只覆盖「拨号 + 握手」；隧道建好立刻 release。
 */
function createGate(limit, state) {
  let active = 0;
  const queue = [];
  const grant = () => {
    active += 1;
    state.stats.active = active;
    state.stats.peak_active = Math.max(state.stats.peak_active || 0, active);
  };
  const release = () => {
    active -= 1;
    state.stats.active = active;
    const next = queue.shift();
    state.stats.queue_depth = queue.length;
    if (next) { clearTimeout(next.timer); grant(); next.resolve(); }
  };
  return {
    async acquire(timeoutMs) {
      if (state.closed) throw Object.assign(new Error('中继已关闭，不再接新连接'), { reason: 'relay_closed' });
      if (active < limit) { grant(); return release; }
      state.stats.queued += 1;
      state.stats.queue_depth = queue.length + 1;
      state.stats.peak_queue = Math.max(state.stats.peak_queue || 0, queue.length + 1);
      await new Promise((resolve, reject) => {
        const waiter = { resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const i = queue.indexOf(waiter);
          if (i >= 0) queue.splice(i, 1);
          state.stats.queue_depth = queue.length;
          reject(Object.assign(
            new Error(`上游拨号排队超时（${timeoutMs}ms，并发上限 ${limit}）`),
            { reason: 'queue_timeout' },
          ));
        }, timeoutMs);
        queue.push(waiter);
      });
      return release;
    },
    /** close 时把还在排队的全部拒掉，别让它们挂到超时 */
    drain(reason = 'relay_closed') {
      while (queue.length) {
        const w = queue.shift();
        clearTimeout(w.timer);
        w.reject(Object.assign(new Error('中继已关闭'), { reason }));
      }
      state.stats.queue_depth = 0;
    },
  };
}

/**
 * 起一个只 bind `127.0.0.1` 的 SOCKS5 中继（对浏览器不要求认证），
 * 上游用 `upstream` 的协议与凭据。
 *
 * @param {{type?:string, host:string, port:number, username?:string, password?:string}} upstream
 * @param {{timeoutMs?:number, concurrency?:number}} [opt]
 *   `concurrency` = 上游拨号并发上限（默认 4）；槽位只覆盖握手，隧道建好即释放。
 * @returns {Promise<{port:number, close:Function, lastError:object|null, sockets:Set, stats:object}>}
 */
export async function startRelay(upstream, { timeoutMs = DEFAULT_TIMEOUT_MS, concurrency = DEFAULT_CONCURRENCY, dialAttempts = DEFAULT_DIAL_ATTEMPTS } = {}) {
  if (!upstream || !upstream.host || !(Number(upstream.port) > 0)) {
    throw new Error('startRelay 需要上游代理的 host 与 port');
  }
  const limit = Math.max(1, Math.floor(Number(concurrency) || DEFAULT_CONCURRENCY));
  const up = {
    type: String(upstream.type || 'http').toLowerCase(),
    host: String(upstream.host),
    port: Number(upstream.port),
    username: String(upstream.username || ''),
    password: String(upstream.password || ''),
  };
  const state = {
    port: 0,
    lastError: null,
    sockets: new Set(),
    closed: false,
    dialAttempts: Math.max(1, Math.min(5, Math.floor(Number(dialAttempts) || DEFAULT_DIAL_ATTEMPTS))),
    /** 只记读数，不含凭据 */
    stats: {
      connections: 0,
      tunnels: 0,
      failed: 0,
      /** 排过队的连接数（累计）与当前队列深度 */
      queued: 0,
      queue_depth: 0,
      peak_queue: 0,
      /** 正在握手 / 峰值 / 上限 */
      active: 0,
      peak_active: 0,
      concurrency: limit,
      timeout_ms: timeoutMs,
      /** 上游拨号：尝试次数（累计）与其中重试次数 */
      dial_attempts: 0,
      dial_retries: 0,
      upstream: `${up.type} ${up.host}:${up.port}`,
    },
  };
  const gate = createGate(limit, state);

  const server = net.createServer((socket) => {
    state.stats.connections += 1;
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
    socket.on('error', () => { /* 浏览器主动断，正常 */ });
    handleClient(socket, up, state, timeoutMs, gate).catch((e) => {
      state.lastError = state.lastError || e;
      state.stats.failed += 1;
      try { socket.destroy(); } catch { /* ignore */ }
    });
  });
  server.on('error', (e) => { state.lastError = state.lastError || e; });

  await new Promise((resolve, reject) => {
    const onErr = (e) => reject(e);
    server.once('error', onErr);
    // 只 bind 回环：绝不 0.0.0.0（多开的内核不该把代理暴露给局域网），端口 0 = 系统分配
    server.listen(0, '127.0.0.1', () => { server.off('error', onErr); resolve(); });
  });
  state.port = server.address().port;

  state.close = () => new Promise((resolve) => {
    state.closed = true;
    gate.drain();
    for (const s of state.sockets) { try { s.destroy(); } catch { /* ignore */ } }
    state.sockets.clear();
    server.close(() => resolve());
  });
  return state;
}

async function handleClient(client, upstream, state, timeoutMs, gate) {
  const rd = new Reader(client);
  let upstreamSock = null;
  let releaseSlot = null;
  try {
    // ① 问候：只提供 no-auth（浏览器侧不需要认证 —— 凭据是我们的，不是它的）
    const [ver, n] = await rd.readExactly(2, timeoutMs, 'SOCKS5 问候');
    if (ver !== VER) throw Object.assign(new Error('客户端不是 SOCKS5'), { reason: 'bad_client' });
    const methods = await rd.readExactly(n, timeoutMs, 'SOCKS5 方法列表');
    if (!methods.includes(M_NOAUTH)) {
      client.write(Buffer.from([VER, M_NONE]));
      throw Object.assign(new Error('客户端要求认证，本中继对浏览器不要求认证'), { reason: 'client_auth_required' });
    }
    client.write(Buffer.from([VER, M_NOAUTH]));

    // ② 请求：只支持 CONNECT
    const head = await rd.readExactly(4, timeoutMs, 'SOCKS5 请求头');
    if (head[0] !== VER) throw Object.assign(new Error('客户端不是 SOCKS5'), { reason: 'bad_client' });
    const cmd = head[1];
    const atyp = head[3];
    let host = '';
    if (atyp === ATYP_IPV4) {
      const b = await rd.readExactly(4, timeoutMs, 'SOCKS5 IPv4');
      host = [...b].join('.');
    } else if (atyp === ATYP_IPV6) {
      const b = await rd.readExactly(16, timeoutMs, 'SOCKS5 IPv6');
      const parts = [];
      for (let i = 0; i < 16; i += 2) parts.push(b.readUInt16BE(i).toString(16));
      host = parts.join(':');
    } else if (atyp === ATYP_DOMAIN) {
      const [len] = await rd.readExactly(1, timeoutMs, 'SOCKS5 域名长度');
      host = (await rd.readExactly(len, timeoutMs, 'SOCKS5 域名')).toString('utf8');
    } else {
      throw Object.assign(new Error(`不认识的地址类型 ${atyp}`), { reason: 'bad_client' });
    }
    const portBuf = await rd.readExactly(2, timeoutMs, 'SOCKS5 端口');
    const port = portBuf.readUInt16BE(0);

    if (cmd !== CMD_CONNECT) {
      client.write(reply(REP_CMD_UNSUPPORTED));
      throw Object.assign(new Error(`不支持的 SOCKS5 命令 ${cmd}`), { reason: 'cmd_unsupported' });
    }
    if (!host) throw Object.assign(new Error('目标主机为空'), { reason: 'bad_target' });

    // ③ 连上游（协议与凭据都在这一段）
    //    有界并发：先排队拿槽位，**拿到才拨** —— 无上限扇出会把上游 accept 队列打满，
    //    上游排队时间最后变成我们这边的「超时」（用户 2026-11-18 那 4 个环境就是这么死的）。
    releaseSlot = await gate.acquire(timeoutMs);
    const t = await openUpstream(upstream, host, port, timeoutMs, state);
    upstreamSock = t.socket;
    state.stats.tunnels += 1;
    // 隧道建好即释放槽位：长连接不占槽，否则一个开 6 个标签的环境会把槽全占死
    releaseSlot();
    releaseSlot = null;

    client.write(reply(REP_OK));
    if (t.rest.length) { try { upstreamSock.write(t.rest); } catch { /* ignore */ } }
    const rest = rd.detach();
    if (rest.length) { try { upstreamSock.write(rest); } catch { /* ignore */ } }
    relay(client, upstreamSock);
  } catch (e) {
    state.lastError = e;
    state.stats.failed += 1;
    try { client.write(reply(repFor(e))); } catch { /* 已经断了 */ }
    try { client.destroy(); } catch { /* ignore */ }
    if (upstreamSock) { try { upstreamSock.destroy(); } catch { /* ignore */ } }
  } finally {
    if (releaseSlot) { try { releaseSlot(); } catch { /* ignore */ } }
  }
}

function reply(code) {
  // BND.ADDR / BND.PORT 全 0：浏览器不关心，也不该让它知道上游地址
  return Buffer.from([VER, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]);
}

function repFor(e) {
  if (e?.reason === 'proxy_auth_failed' || e?.reason === 'proxy_auth_missing') return REP_FAIL;
  if (e?.reason === 'proxy_refused' || e?.reason === 'host_unreachable') return REP_HOST_UNREACH;
  if (e?.reason === 'timeout') return REP_HOST_UNREACH;
  return REP_FAIL;
}

function relay(a, b) {
  const kill = () => {
    try { a.destroy(); } catch { /* ignore */ }
    try { b.destroy(); } catch { /* ignore */ }
  };
  a.on('error', kill);
  b.on('error', kill);
  a.on('close', kill);
  b.on('close', kill);
  a.pipe(b);
  b.pipe(a);
}
