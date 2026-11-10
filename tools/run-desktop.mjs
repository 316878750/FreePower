/**
 * 启动桌面壳（开发用）。
 *
 * 为什么不用 `electron .` 直接跑：有些环境（包括这台开发机）全局设了
 * `ELECTRON_RUN_AS_NODE=1`，那会让 electron.exe 退化成普通 Node —— 没有窗口、没有托盘，
 * 报错还长得像「模块没有具名导出」，极难排查。这里显式剥掉这个变量再起。
 *
 * 用法：node tools/run-desktop.mjs [--selftest] [--hidden]
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let bin;
try {
  bin = require('electron'); // 这里按理是「二进制路径」字符串；在 ELECTRON_RUN_AS_NODE 下也一样
} catch (e) {
  console.error('没找到 electron，先 npm install');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(bin, [ROOT, ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));