import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 数据根目录：库、环境 user-data-dir、内核矩阵、日志都在这下面 */
export const DATA_DIR = process.env.FREEPOWER_DATA || path.join(ROOT, 'data');
export const DB_PATH = path.join(DATA_DIR, 'freepower.db');
export const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
export const KERNELS_DIR = path.join(DATA_DIR, 'kernels');
export const LOG_DIR = path.join(DATA_DIR, 'logs');

/**
 * 本地 API：端口从 53380 起（50325 是用户本机 AdsPower 的，避开）。
 * 只绑 127.0.0.1，不对外。
 */
export const API_HOST = process.env.FREEPOWER_HOST || '127.0.0.1';
export const API_PORT = Number(process.env.FREEPOWER_PORT || 53380);

/** 限流：默认 1 req/s，带 x-freepower-client: mcp 头走 30 req/s（对齐对手档位，可用环境变量覆盖） */
export const RATE_LIMIT_DEFAULT = Number(process.env.FREEPOWER_RATE_LIMIT || 1);
export const RATE_LIMIT_MCP = Number(process.env.FREEPOWER_RATE_LIMIT_MCP || 30);

/** 内核：优先环境变量指定的可执行文件，其次内核矩阵目录，最后系统 Chrome */
export const CHROME_BIN = process.env.FREEPOWER_CHROME || '';

/** 环境启动后保持的调试端口随机分配；外部脚本通过返回的 ws 地址接入 */
export const START_TIMEOUT_MS = Number(process.env.FREEPOWER_START_TIMEOUT || 20000);
