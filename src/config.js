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

/**
 * 内核下载（`POST /api/v2/browser-profile/download-kernel`）—— 源是 **Chrome for Testing**，
 * 不是对手的 CDN（那是它自家分发的 SunBrowser 二进制，我们不转发别人的构建）。
 * 三个地址都可覆盖：内网镜像 / 离线自测时改 `FREEPOWER_CFT_*` 即可，测试用它指本地假源。
 */
export const CFT_META_URL = String(
  process.env.FREEPOWER_CFT_META_URL
    || 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json',
).trim();
export const CFT_VERSIONS_URL = String(
  process.env.FREEPOWER_CFT_VERSIONS_URL
    || 'https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json',
).trim();
export const CFT_ZIP_BASE = String(
  process.env.FREEPOWER_CFT_ZIP_BASE
    || 'https://storage.googleapis.com/chrome-for-testing-public',
).trim().replace(/\/+$/, '');

/**
 * 下载+安装的整体预算（默认 **60 分钟**）。
 *
 * 为什么这么长：本机实测到 `storage.googleapis.com` 只有 **50–160 KB/s**（同一时刻
 * Cloudflare 有 860 KB/s），一个 `chrome-win64.zip` 是 **209,854,321 B**，慢网要几十分钟。
 * 而且这不是「挂住请求」——`download-kernel` 立刻回 `pending`，下载在后台跑，用户/脚本轮询。
 * 原来默认 10 分钟，在这条链路上必然超时（实测 10 分钟只下到 85 MB 左右）。
 */
export const KERNEL_DOWNLOAD_TIMEOUT_MS = Number(process.env.FREEPOWER_KERNEL_DOWNLOAD_TIMEOUT || 3600000);

/**
 * 单次连接「多久没收到字节」就判定卡死并重连续传（默认 120 s）。
 * 与上面的总预算分工不同：总预算管「这次下载一共允许多久」，
 * 这个管「连接是不是已经不动了」—— 不动就断开重连，用 `Range` 从断点接着下。
 */
export const KERNEL_DOWNLOAD_STALL_MS = Number(process.env.FREEPOWER_KERNEL_DOWNLOAD_STALL || 120000);

/**
 * 续传最多重连几次（默认 12）。每次重连都用 `Range: bytes=<已收>-` 接着下，
 * 不从头再来；连满还下不完就明确失败，不留半成品。
 */
export const KERNEL_DOWNLOAD_ATTEMPTS = Number(process.env.FREEPOWER_KERNEL_DOWNLOAD_ATTEMPTS || 12);

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

/* --------------------------- 0.4.0 AI Agent（骨架） --------------------------- */

/**
 * 模型接入：**用户自己的 endpoint / key / model**，OpenAI 兼容协议
 * （`POST <endpoint>/chat/completions`）。对手走自家网关 `https://ai.adspower.com/api`、
 * Bearer 是登录 token（逆向 `24-` §5.2）—— 我们不碰那条路，也不默认填任何厂商地址。
 * 三样缺一就算"没配"，不做默认模型猜测。
 */
export const AGENT_LLM_ENDPOINT = String(process.env.FREEPOWER_AGENT_LLM_ENDPOINT || '').trim();
export const AGENT_LLM_KEY = String(process.env.FREEPOWER_AGENT_LLM_KEY || '').trim();
export const AGENT_LLM_MODEL = String(process.env.FREEPOWER_AGENT_LLM_MODEL || '').trim();
export const AGENT_LLM_TIMEOUT_MS = Number(process.env.FREEPOWER_AGENT_LLM_TIMEOUT || 60000);

/**
 * 工作流落盘目录：`DATA_DIR/agent/workflows/<id>.json`，一个工作流一个文件。
 * HITL 批完到真跑之间可能隔着几分钟：进程一崩就丢审批 = 用户得重批，所以**必须落盘**。
 * 终态就地保留、不进归档目录（列表接口要能看到全部历史）；清理另开 `agent/workflow/purge`。
 */
export const AGENT_WORKFLOW_DIR = path.join(DATA_DIR, 'agent', 'workflows');

/**
 * 单步执行超时（`wait.ms` 另算：`wait({ms})` 按 ms + 5s 放宽，ms 本身已在 DSL 里封顶 120000）。
 * 超时 → 工作流 `failed`、`error.reason='step_timeout'`，**不自动重试**。
 */
export const AGENT_STEP_TIMEOUT_MS = Number(process.env.FREEPOWER_AGENT_STEP_TIMEOUT || 30000);

/**
 * 截图目录。工作流的 `screenshot` 出参只回**相对这里**的路径（DSL 里的 `path` 也必须是
 * 相对路径、不许 `..`）—— 不让模型把文件写到 `C:\Windows\...`。
 */
export const AGENT_SCREENSHOT_DIR = path.join(DATA_DIR, 'agent', 'screenshots');

/**
 * HITL 缺省裁决。**只认 `approve` 才放行，其余（含没配、写错、空串）一律 `deny`** ——
 * 这条是 Agent 在本地跑自动化时的安全底线，别做成"配错就默认同意"。
 */
export const AGENT_HITL_DEFAULT = String(process.env.FREEPOWER_AGENT_HITL || 'deny').trim().toLowerCase() === 'approve'
  ? 'approve'
  : 'deny';
