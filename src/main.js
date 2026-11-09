import fs from 'node:fs';
import path from 'node:path';
import { API_HOST, API_PORT, DATA_DIR } from './config.js';
import { createApiServer } from './api/server.js';
import { stopAll, listRunning } from './runtime/manager.js';
import { findChrome } from './kernel/chrome.js';

const PORT_TRIES = 20;

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      if (e.code === 'EADDRINUSE') { cleanup(); resolve(null); return; }
      cleanup(); reject(e);
    };
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onListening = () => { cleanup(); resolve(port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, API_HOST);
  });
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const { server, apiKey } = createApiServer();

  let actualPort = null;
  for (let i = 0; i < PORT_TRIES; i++) {
    actualPort = await listen(server, API_PORT + i);
    if (actualPort) break;
  }
  if (!actualPort) throw new Error(`端口 ${API_PORT}~${API_PORT + PORT_TRIES - 1} 全被占`);

  // 发现文件：脚本读它拿地址 + key（对齐对手写 local_api 文件的做法）
  fs.writeFileSync(
    path.join(DATA_DIR, 'local_api'),
    `http://127.0.0.1:${actualPort}/\napi_key=${apiKey}\n`
  );

  const chrome = findChrome();
  console.log('FreePower API  http://127.0.0.1:' + actualPort);
  console.log('data dir      ' + DATA_DIR);
  console.log('kernel        ' + (chrome ? `${chrome.path} (${chrome.version}, ${chrome.source})` : '未找到（设置 FREEPOWER_CHROME）'));
  console.log('api key       ' + apiKey.slice(0, 6) + '…（完整值见 data/local_api）');
  console.log('running       ' + listRunning().length);

  const shutdown = async () => {
    console.log('\n关闭中：回收运行中的环境…');
    try { await stopAll(); } catch { /* ignore */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('启动失败：', e.message);
  process.exit(1);
});
