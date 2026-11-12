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

/**
 * 对手的分桶不是「所有路由一个额度」：54 条里除 `/status` 外都是 **1/s**，**只有
 * `/api/v1/fbbird/user/list` 单独一个桶、10/s**（`docs/reverse/07-LocalAPI路由全量清单.md` 的限流分桶那一行）。
 * 这个桶只属于那一条路由，别把默认档一起抬上去 —— 默认还是 1/s。
 */
export const RATE_LIMIT_FBBIRD = Number(process.env.FREEPOWER_RATE_LIMIT_FBBIRD || 10);

/**
 * Web 控制台的额度：界面一次操作会连发几个请求（列表 + 运行态 + 自检），
 * 按 1/s 限会自己把自己挡在门外。给 60/s，仍然限量，不做成「带某头的就免限」。
 */
export const RATE_LIMIT_UI = Number(process.env.FREEPOWER_RATE_LIMIT_UI || 60);

/** 内核：优先环境变量指定的可执行文件，其次内核矩阵目录，最后系统 Chrome */
export const CHROME_BIN = process.env.FREEPOWER_CHROME || '';

/** 环境启动后保持的调试端口随机分配；外部脚本通过返回的 ws 地址接入 */
export const START_TIMEOUT_MS = Number(process.env.FREEPOWER_START_TIMEOUT || 20000);

/**
 * 出口探测：默认走明文 HTTP 的 ip-api（不用 TLS 也能过 CONNECT 受限的代理），
 * 备用 https://ipinfo.io/json。两个都失败才算代理不可用。
 */
export const EGRESS_PROBE_URL = process.env.FREEPOWER_EGRESS_PROBE
  || 'http://ip-api.com/json/?fields=status,country,countryCode,regionName,city,timezone,isp,query';

/** 代理预检超时：连接 + 首包。坏代理要「快速失败」，不能拖住整个启动 */
export const PROXY_PROBE_TIMEOUT_MS = Number(process.env.FREEPOWER_PROXY_TIMEOUT || 6000);

/** 浏览器内出口探测超时（页面加载 + 读完 JSON） */
export const EGRESS_TIMEOUT_MS = Number(process.env.FREEPOWER_EGRESS_TIMEOUT || 8000);

/** UA 跟版：内核升级后自动把 UA/UA-CH/内核版本号对齐真实内核（1=开，0=只告警） */
export const UA_AUTOALIGN = process.env.FREEPOWER_UA_AUTOALIGN !== '0';

/**
 * 自检：环境启动后自动跑一次（0=关闭，用 API 手动触发）。
 * 探针在页面里跑（含 1.2s WebRTC 候选收集），失败只告警，不影响启动。
 */
export const SELFCHECK_ON_START = process.env.FREEPOWER_SELFCHECK !== '0';
export const SELFCHECK_TIMEOUT_MS = Number(process.env.FREEPOWER_SELFCHECK_TIMEOUT || 25000);

/** 指纹调试：把注入前的原生函数暴露到 window.__fpOrig（排查「哈希为什么变了」用，默认关） */
export const FP_DEBUG = process.env.FREEPOWER_FP_DEBUG === '1';

/**
 * 批量启停的并发上限。默认 3：再高会同时抢 CPU/磁盘，内核反而起得更慢，
 * 也容易把代理预检压出超时（10 个环境 × 每个 3 条连接）。
 */
export const BATCH_CONCURRENCY = Math.max(1, Number(process.env.FREEPOWER_BATCH_CONCURRENCY || 3));
