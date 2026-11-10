import { startApiServer, describeStartup, shutdownRuntime } from './boot.js';

async function main() {
  const { port, apiKey } = await startApiServer();
  for (const line of describeStartup({ port, apiKey })) console.log(line);

  const shutdown = async () => {
    console.log('\n关闭中：回收运行中的环境…');
    await shutdownRuntime();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('启动失败：', e.message);
  process.exit(1);
});