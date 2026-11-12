/**
 * 服务启动引导：CLI（src/main.js）和 Electron 壳（desktop/main.js）共用这一份。
 *
 * 壳不重写服务：Electron 主进程里直接起同一个 node:http，窗口 loadURL 到它。
 * 所以这里只做「找一个能听的端口、写好发现文件、把句柄交出去」，不做任何界面相关的事。
 */
import fs from 'node:fs';
import path from 'node:path';
import { API_HOST, API_PORT, DATA_DIR } from './config.js';
import { createApiServer } from './api/server.js';
import { loadWorkflows } from './agent/workflow.js';
import { stopAll, listRunning } from './runtime/manager.js';
import { findChrome } from './kernel/chrome.js';

/** 端口被占时往后顺延；20 个够用，再全被占就是本机有别的东西在乱扫 */
export const PORT_TRIES = 20;

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

/**
 * 起本地 API 服务。
 * @returns {Promise<{server, port, apiKey, url, close}>}
 */
export async function startApiServer({ port = API_PORT, tries = PORT_TRIES, writeDiscovery = true } = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 先把盘上的工作流收进来再对外服务：重启时这一步会把残留的 running 落成 aborted，
  // 别让调用方在 status 里看到「还在跑」而浏览器其实早没了。
  loadWorkflows();
  const { server, apiKey } = createApiServer({ port });

  let actualPort = null;
  for (let i = 0; i < tries; i++) {
    actualPort = await listen(server, port + i);
    if (actualPort) break;
  }
  if (!actualPort) {
    server.close();
    throw new Error(`端口 ${port}~${port + tries - 1} 全被占`);
  }

  // 发现文件：脚本读它拿地址 + key（对齐对手写 local_api 文件的做法）
  if (writeDiscovery) {
    fs.writeFileSync(
      path.join(DATA_DIR, 'local_api'),
      `http://${API_HOST}:${actualPort}/\napi_key=${apiKey}\n`
    );
  }

  const close = () => new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    server.close(fin);
    setTimeout(fin, 3000).unref();
  });

  return { server, port: actualPort, apiKey, url: `http://${API_HOST}:${actualPort}/`, close };
}

/** CLI 打印的那几行，壳里也调一次（日志进 desktop.log，排查用） */
export function describeStartup({ port, apiKey }) {
  const chrome = findChrome();
  return [
    `FreePower API  http://${API_HOST}:${port}`,
    `data dir      ${DATA_DIR}`,
    `kernel        ${chrome ? `${chrome.path} (${chrome.version}, ${chrome.source})` : '未找到（设置 FREEPOWER_CHROME）'}`,
    `api key       ${apiKey.slice(0, 6)}…（完整值见 data/local_api）`,
    `running       ${listRunning().length}`,
  ];
}

/** 退出前收尾：停掉所有环境（壳和 CLI 都走这条） */
export async function shutdownRuntime() {
  let stopped = [];
  let error = null;
  try { stopped = await stopAll(); } catch (e) { error = e; }
  return { stopped, error };
}

export { listRunning, stopAll };