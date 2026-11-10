/**
 * 自检用的安全上下文页。
 *
 * 为什么需要：`navigator.userAgentData`（UA-CH）和 `navigator.mediaDevices`
 * 只在 secure context 里暴露，而 `about:blank`（Target.createTarget 建出来的）是
 * opaque origin，不算安全上下文 —— 在上面自检会把这两项误判成「没生效」。
 *
 * `http://127.0.0.1` 在 Chromium 里被当作 potentially trustworthy origin，
 * 所以这里起一个只服务一张空页的本地 HTTP 服务，跑完就关。
 * 注意：环境绑了远程代理且 loopback 被强制走代理时，这个页面可能加载不到；
 * 调用方要允许回落到 about:blank，并在报告里如实写明「本次未验证」。
 */
import http from 'node:http';

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>FreePower selfcheck</title></head><body>FreePower selfcheck</body></html>';

export async function openSelfcheckOrigin() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'connection': 'close',
      'content-length': Buffer.byteLength(PAGE),
    });
    res.end(PAGE);
  });
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  return {
    url: `http://127.0.0.1:${port}/selfcheck`,
    title: 'FreePower selfcheck',
    // 关键：Chrome 会留着 keep-alive 连接，只调 server.close() 会一直等下去（自检永远不返回）。
    close: () => new Promise((resolve) => {
      try { server.closeAllConnections(); } catch { /* 老 Node 没有 */ }
      server.close(() => resolve());
      setTimeout(resolve, 1000).unref?.();
    }),
  };
}
