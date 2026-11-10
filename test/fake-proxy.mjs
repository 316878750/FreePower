/**
 * 测试用「假代理」：一个只认绝对 URL 的 HTTP 代理，出口信息全部是编的。
 *
 * 用途：不依赖公网就能验证
 *   1. 代理预检真的走了代理（预检拿到的 IP 是假代理给的）；
 *   2. 浏览器的流量真的走了代理（浏览器内探测拿到的 IP 也是同一个）；
 *   3. 代理认证（407）路径。
 *
 * 只实现明文 HTTP（absolute-form）；CONNECT 一律 405，因为测试不需要 TLS。
 */
import http from 'node:http';

export function startFakeProxy({
  ip = '203.0.113.9',
  country = 'Japan',
  countryCode = 'JP',
  city = 'Tokyo',
  region = 'Tokyo',
  timezone = 'Asia/Tokyo',
  isp = 'FakeProxy Lab',
  requireAuth = null, // ['user', 'pass'] 时校验 Proxy-Authorization
  latencyMs = 0,
} = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers['proxy-authorization'] || '' });

    if (requireAuth) {
      const want = `Basic ${Buffer.from(`${requireAuth[0]}:${requireAuth[1]}`).toString('base64')}`;
      if ((req.headers['proxy-authorization'] || '') !== want) {
        res.writeHead(407, { 'proxy-authenticate': 'Basic realm="fake-proxy"', 'content-type': 'text/plain' });
        return res.end('proxy auth required');
      }
    }
    if (req.method === 'CONNECT') {
      res.writeHead(405);
      return res.end('CONNECT not supported by fake proxy');
    }

    const send = () => {
      const body = JSON.stringify({
        status: 'success', country, countryCode, regionName: region, city, timezone, isp, query: ip,
      });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    if (latencyMs > 0) setTimeout(send, latencyMs);
    else send();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        requests,
        proxy: { proxy_type: 'http', host: '127.0.0.1', port: server.address().port, username: '', password: '' },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/**
 * 测试用出口信息端点（直连场景用）：返回一组固定的出口信息。
 * 有了它，冒烟就不用连公网，出口检查也能确定性地断言。
 */
export function startEchoServer({
  ip = '198.51.100.20',
  country = 'United States',
  countryCode = 'US',
  city = 'New York',
  region = 'New York',
  timezone = 'America/New_York',
  isp = 'Echo Lab',
} = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, ua: req.headers['user-agent'] || '' });
    const body = JSON.stringify({ status: 'success', country, countryCode, regionName: region, city, timezone, isp, query: ip });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        hits,
        url: `http://127.0.0.1:${port}/exit`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}