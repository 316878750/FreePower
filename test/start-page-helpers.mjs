/**
 * 判据共用：起一个**真端口**的本地 API（起始页由它出，内核要连这个端口）。
 *
 * 为什么不直接 `startApiServer({ port: 0 })`：`src/boot.js` 的端口顺延循环里，
 * `listen(0)` 拿到的是系统分配的真端口，但那个函数把「解析出来的端口」当返回值，
 * 0 是假值 → 它以为「被占」→ 对同一个 server 再 listen 一次 → ERR_SERVER_ALREADY_LISTEN。
 * 所以这里先借一个空闲端口再还回去，然后让服务起在那个端口上。
 */
import http from 'node:http';

export async function startPageHostPort() {
  const tmp = http.createServer();
  await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
  const port = tmp.address().port;
  await new Promise((r) => tmp.close(r));
  const { startApiServer } = await import('../src/boot.js');
  return startApiServer({ port, writeDiscovery: false });
}
