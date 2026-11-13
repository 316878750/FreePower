/**
 * 内核下载 + 安装 —— `POST /api/v2/browser-profile/download-kernel` 的真实现。
 *
 * 契约（`adspower_reverse/8.9.23/23-内核下载契约.md`）里最要紧的三条，这里逐条对上：
 *   1. **同步状态机、没有 task id、没有轮询端点**：每次调用都重新算「已装 / 正在下 / 正在装 / 该下」，
 *      立刻回 `{code:0,data:{status[,progress]}}`；要进度就再调一次同一个端点。
 *      对外状态只有 `pending` / `downloading` / `installing` / `completed` —— **`failed` 到不了调用方**，
 *      失败后下一次调用直接重新开始（契约 §2.1 的 `FAIL → RE_DOWNLOAD`）。
 *   2. **幂等推进，不是「下载一次」**：已经装好的再调一次回 `completed`（带 `msg:"success"`）。
 *   3. **只有「什么都不做」那条分支带 `msg:"success"`**；触发下载/安装的响应没有 msg（契约 §2.2）。
 *
 * 有意差异（写进 README，别当成 bug）：
 *   - 源是 **Chrome for Testing**（`storage.googleapis.com/chrome-for-testing-public`），不是对手的
 *     `version.adspower.net`（那是它自家分发的 SunBrowser 二进制，我们不转发别人的构建）。
 *   - **只做 Chrome**：`Firefox` 明确回「不支持」，不拿 `No matching kernel version available.` 糊
 *     （那句在契约里是「目录里没有这个版本」的意思）。
 *   - 版本号放宽到 1–4 段点分数字：对手用 `Number(kernel_version)` 判真假，`"157.0.8103.78"` 在它那儿
 *     会算出 `NaN` 被自己拒掉 —— 但 CfT 是按完整四段版本号发版的，不放宽就等于下不了任何内核。
 *     `"0"` 仍按契约拒（`Number("0")` 为假）。
 *
 * 落盘布局：`<KERNELS_DIR>/<完整版本号>/chrome.exe`（CfT 的 zip 里多一层 `chrome-win64/`，解包时剥掉），
 * 与 `listKernels` 认的三种 rel 的第一种一致，所以下完 `GET …/kernels` 立刻能看到。
 * 过程：下到 `.tmp-*` → content-length 比对 → 解压 → `chrome.exe --version` 对版本 → **原子改名**。
 * 失败一律删掉 `.tmp-*`（不留半成品目录、不留 `installing` 僵尸状态），下次调用重下。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  KERNELS_DIR, CFT_META_URL, CFT_VERSIONS_URL, CFT_ZIP_BASE,
  KERNEL_DOWNLOAD_TIMEOUT_MS, KERNEL_DOWNLOAD_STALL_MS, KERNEL_DOWNLOAD_ATTEMPTS, KERNEL_MIRROR,
} from '../config.js';
import { cftPlatform, resolveCftKernel, cftZipName } from './cft.js';
import { extractZipFile } from './zip.js';

/** 解压后认的三种布局（与 `listKernels` 同一份口径，顺序也一样） */
const EXE_RELS = ['chrome.exe', 'chrome-win64/chrome.exe', 'chrome-win/chrome.exe'];

/** 装好之后写在版本目录里的来源标记（隐藏文件；`listKernels` 只认目录，不受影响） */
const SOURCE_MARKER = '.freepower-source.json';

/** 镜像核验：默认抽几段、每段多大（CEO 2026-11-13 定的口径：5 段 × 128 KB） */
export const MIRROR_VERIFY_SEGMENTS = 5;
export const MIRROR_VERIFY_CHUNK = 131072;

/**
 * 官方端点偶发**连接层**故障时的有限重试（2026-11-13 真机实测：冷连接首个 HEAD 被
 * `ECONNRESET` 重置，第 2 次就 200；Range 抽段连打三次都 206）。
 *
 * 只对**网络错误 / 5xx / 429** 重试 —— 这些是「这一秒的连接」坏了，不是「这个包的答案」。
 * **不重试**：404 之类 4xx、官方不认 Range、抽段长度不对、**sha256 不符**。
 * 最后一条最要紧：重试一个「内容错了」的答案，只是把失败拖长，还会让人以为「多试几次就好了」。
 * 重试也不换抽样位置（位置在重试之前就定死），否则等于放宽判据。
 */
export const MIRROR_VERIFY_ATTEMPTS = 3;
export const MIRROR_VERIFY_RETRY_MS = 400;

/**
 * 镜像基地址 → 可用值（`''` = 禁用）。
 * `off` / `0` / `false` / 空串都算「明确关掉」，**不做「配错就静默回落到默认镜像」**。
 */
export function mirrorBaseOf(value = KERNEL_MIRROR) {
  const v = String(value ?? '').trim().replace(/\/+$/, '');
  if (!v) return '';
  if (/^(off|0|false|no|none)$/i.test(v)) return '';
  return v;
}

/** 镜像上的包体地址：与官方同构（`<base>/<版本>/<平台>/chrome-<平台>.zip`） */
export function mirrorZipUrl(mirrorBase, version, platform = cftPlatform()) {
  return `${String(mirrorBase).replace(/\/+$/, '')}/${version}/${platform}/${cftZipName(platform)}`;
}

/** Firefox 的明确说法：CfT 没有 Firefox 构建，我们不假装「目录里没有」 */
export const FIREFOX_UNSUPPORTED_MSG = 'Firefox kernel download is not supported: FreePower downloads Chrome kernels from Chrome for Testing only (there is no Firefox build there).';

/** 契约 §4 的六条文案（逐字），第 4 条在 `cft.js` 里抛 */
export const MSG = {
  REQUIRED: 'kernel_type and kernel_version are required',
  BAD_TYPE: 'Kernel type must be Chrome or Firefox.',
  BAD_VERSION: 'kernel_version is not a numeric strings',
  NO_KERNEL: 'No matching kernel version available.',
};

export class KernelError extends Error {
  constructor(message, { reason = 'kernel_error', cause } = {}) {
    super(message);
    this.name = 'KernelError';
    this.code = -1;
    this.reason = reason;
    if (cause) this.cause = cause;
  }
}

/**
 * 校验钩子：默认跑真的 `chrome.exe --version`。
 * **只有 `test/kernel-download.test.mjs` 会换掉它** —— A 层用假源，zip 里的 `chrome.exe` 是几字节文本，
 * 不是 PE、跑不起来；换掉只是为了把「下载 → 解压 → 校验 → 改名」整条路在**不联网**的前提下走完。
 * 生产代码不写这个对象。
 */
export const hooks = { verifyExe: null };

/* ------------------------------ 请求解析 ------------------------------ */

/**
 * 入参校验（契约 §1 + §4 前三条）。
 * `kernel_type` **大小写敏感**（`"chrome"` 被拒，与 `kernels` 列表的 `toLowerCase` 口径不同，照抄对手）。
 */
export function parseKernelRequest(body = {}) {
  const type = body?.kernel_type;
  const ver = body?.kernel_version;
  if (!type || !ver) throw new KernelError(MSG.REQUIRED, { reason: 'missing_params' });
  if (!['Chrome', 'Firefox'].includes(type)) throw new KernelError(MSG.BAD_TYPE, { reason: 'bad_kernel_type' });
  const raw = String(ver).trim();
  // 1–4 段点分数字；`Number(raw) === 0` 把 "0" / "0.0" 拒掉（对齐契约的 `Number(m)` 为假）
  if (!/^\d+(\.\d+){0,3}$/.test(raw) || Number(raw) === 0) {
    throw new KernelError(MSG.BAD_VERSION, { reason: 'bad_kernel_version' });
  }
  if (type === 'Firefox') throw new KernelError(FIREFOX_UNSUPPORTED_MSG, { reason: 'firefox_unsupported' });
  return { kernel_type: type, kernel_version: raw };
}

/* ------------------------------ 已装判定 ------------------------------ */

/** 目录里第一个存在的 chrome.exe（三种 rel 都认，先认扁平布局） */
export function firstExe(dir) {
  for (const rel of EXE_RELS) {
    const p = path.join(dir, ...rel.split('/'));
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** `<kernels>/<版本>/` 下真的可用的 chrome.exe；没有就 null */
export function installedExe(version, root = KERNELS_DIR) {
  return firstExe(path.join(root, String(version)));
}

/**
 * 读来源标记（`source` / `mirror_verified` 的唯一事实源）。
 *
 * 没有标记有两种情况，都如实报 `unknown`、不猜：① 这份内核是本版本之前装的（那时候还没这个文件）；
 * ② 用户自己把一份 Chrome 目录拷进了 kernels。**不许默认成 `official`** —— 那是在没有证据时撒谎。
 */
export function readSourceMarker(version, root = KERNELS_DIR) {
  try {
    const p = path.join(root, String(version), SOURCE_MARKER);
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/* ------------------------------ 版本解析（带缓存） ------------------------------ */

/** 目录解析缓存：契约里对手的 sysVersion 缓存 300 s，这里对齐；只缓存成功结果 */
const resolveCache = new Map();
const RESOLVE_TTL_MS = 300000;

/** 测试用：清掉解析缓存与失败记录（跨用例互不污染） */
export function clearKernelDownloadCache() {
  resolveCache.clear();
  failures.clear();
}

async function resolveKernel(version, opts) {
  const platform = opts.platform || cftPlatform();
  const zipBase = opts.zipBase || CFT_ZIP_BASE;
  const key = `${zipBase}|${platform}|${version}`;
  const hit = resolveCache.get(key);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.value;
  const value = await resolveCftKernel({ version }, {
    fetchImpl: opts.fetchImpl || fetch,
    metaUrl: opts.metaUrl || CFT_META_URL,
    versionsUrl: opts.versionsUrl || CFT_VERSIONS_URL,
    zipBase,
    platform,
  });
  resolveCache.set(key, { at: Date.now(), value });
  return value;
}

/* ------------------------------ 状态表 ------------------------------ */

/** key = 版本串（`"157"` 与 `"157.0.8103.78"` 各一条，解析完会并到具体版本上） */
const inflight = new Map();
/** 失败记录：只给日志/诊断看，**不进响应**（契约对外没有 `failed` 状态） */
const failures = new Map();

/** 当前状态快照（测试与诊断用；没有在跑就 null） */
export function kernelDownloadState(version) {
  const e = inflight.get(String(version));
  return e ? snapshot(e) : null;
}

/** 最近一次失败（测试用；失败后 `kernelDownloadState` 立刻是 null，不是僵尸 installing） */
export function lastKernelFailure(version) {
  return failures.get(String(version)) || null;
}

function snapshot(entry) {
  // 来源与「镜像是否核验过」跟着状态一起回，**任何分支都带**（脚本据此判断这份是谁给的）
  const tag = { source: entry.source || null, mirror_verified: entry.mirror_verified === true };
  if (entry.status === 'completed') return { status: 'completed', ...tag };
  if (entry.status === 'installing') return { status: 'installing', ...tag };
  const progress = Math.max(0, Math.min(100, Math.round(entry.progress || 0)));
  return { status: entry.status === 'downloading' ? 'downloading' : 'pending', progress, ...tag };
}

/** 已装：来源从盘上的标记读；没有标记如实报 `unknown`（不猜成 official） */
const completedRes = (version, root = KERNELS_DIR) => {
  const m = readSourceMarker(version, root);
  return {
    code: 0,
    data: { status: 'completed', source: m?.source || 'unknown', mirror_verified: m?.mirror_verified === true },
    msg: 'success',
  };
};
const noopRes = (entry) => ({ code: 0, data: snapshot(entry), msg: 'success' });

/* ------------------------------ 对外入口 ------------------------------ */

/**
 * 一次调用 = 一次「推进」。
 *
 * @param {{kernel_type?: string, kernel_version?: string}} body
 * @param {{root?: string, fetchImpl?: Function, verifyExe?: Function, platform?: string,
 *          zipBase?: string, metaUrl?: string, versionsUrl?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<{code: 0, data: {status: string, progress?: number}, msg?: 'success'}>}
 *
 * 错误（`KernelError`，code -1）在这里**同步抛出**：缺参 / 类型错 / 版本非数字 / Firefox 不支持 /
 * 目录里没有该版本。真正下载/解压/校验发生在后台，失败不进响应（下次调用自动重试）。
 */
export async function runKernelDownload(body = {}, opts = {}) {
  const req = parseKernelRequest(body);
  const root = opts.root || KERNELS_DIR;
  const ctx = {
    root,
    fetchImpl: opts.fetchImpl || fetch,
    verifyExe: opts.verifyExe || null,
    platform: opts.platform || cftPlatform(),
    zipBase: opts.zipBase || CFT_ZIP_BASE,
    metaUrl: opts.metaUrl || CFT_META_URL,
    versionsUrl: opts.versionsUrl || CFT_VERSIONS_URL,
    timeoutMs: opts.timeoutMs || KERNEL_DOWNLOAD_TIMEOUT_MS,
    stallMs: opts.stallMs || KERNEL_DOWNLOAD_STALL_MS,
    maxAttempts: opts.maxAttempts || KERNEL_DOWNLOAD_ATTEMPTS,
    // `undefined` = 用全局配置（默认 npmmirror）；`''` / `'off'` = 明确禁用回落
    mirrorBase: opts.mirrorBase,
    verifySegments: opts.verifySegments,
    verifyChunk: opts.verifyChunk,
    verifyAttempts: opts.verifyAttempts,
    verifyRetryMs: opts.verifyRetryMs,
    randomInt: opts.randomInt,
  };

  // ① 已装：幂等 completed（分支 A，带 msg）
  if (installedExe(req.kernel_version, root)) return completedRes(req.kernel_version, root);

  // ② 正在下/装：只回报状态，不重复触发（契约 §2.3 的并发去重）
  const running = inflight.get(req.kernel_version);
  if (running) return noopRes(running);

  // 先占位再解析：两次并发调用不能都走到「触发下载」（解析要 await，中间有窗口）
  const entry = { status: 'pending', progress: 0, startedAt: Date.now(), version: req.kernel_version };
  inflight.set(req.kernel_version, entry);

  let resolved;
  try {
    resolved = await resolveKernel(req.kernel_version, ctx);
  } catch (e) {
    inflight.delete(req.kernel_version);
    throw toKernelError(e);
  }

  // ③ 解析出来的具体版本已经装好了（请求 `"157"`、盘上有 `157.0.8103.78`）
  if (installedExe(resolved.version, root)) {
    inflight.delete(req.kernel_version);
    return completedRes(resolved.version, root);
  }
  // ④ 同一个具体版本已经在跑（`"157"` 与 `"157.0.8103.78"` 同时来）：并到那条上
  const same = inflight.get(resolved.version);
  if (same && same !== entry) {
    inflight.delete(req.kernel_version);
    return noopRes(same);
  }
  entry.version = resolved.version;
  if (resolved.version !== req.kernel_version) {
    inflight.set(resolved.version, entry);
    inflight.delete(req.kernel_version);
  }

  startJob(entry, resolved, ctx);
  // 分支 B：触发了下载 —— **没有 msg**（契约 §2.2），status 固定 `pending`、progress 固定 0
  // （契约形状不能因为后台跑快了就变成 downloading）。
  // `source` 此刻还**不知道**（先试官方，卡死才切镜像），所以如实给 null，不预设成 official；
  // 轮询时按真实进度给。要「这份是谁给的」看 `completed` 那一发（读盘上的来源标记）。
  return { code: 0, data: { status: 'pending', progress: 0, source: null, mirror_verified: false } };
}

/** 目录/网络错误 → 带契约文案的 KernelError */
function toKernelError(e) {
  if (e instanceof KernelError) return e;
  if (e?.reason === 'kernel_not_found') return new KernelError(MSG.NO_KERNEL, { reason: 'kernel_not_found' });
  return new KernelError(
    `内核目录不可用（${e?.reason || 'network'}）：${e?.message || e}，稍后重试`,
    { reason: e?.reason || 'catalog_unreachable', cause: e },
  );
}

function startJob(entry, resolved, ctx) {
  (async () => {
    try {
      const r = await installKernel(resolved, {
        root: ctx.root,
        fetchImpl: ctx.fetchImpl,
        verifyExe: ctx.verifyExe,
        timeoutMs: ctx.timeoutMs,
        stallMs: ctx.stallMs,
        maxAttempts: ctx.maxAttempts,
        mirrorBase: ctx.mirrorBase,
        verifySegments: ctx.verifySegments,
        verifyChunk: ctx.verifyChunk,
        verifyAttempts: ctx.verifyAttempts,
        verifyRetryMs: ctx.verifyRetryMs,
        randomInt: ctx.randomInt,
        onPhase: (ph) => { entry.status = ph; },
        onProgress: (p) => { entry.progress = p; },
        onSource: (kind) => { entry.source = kind; },
      });
      entry.status = 'completed';
      entry.progress = 100;
      entry.source = r.source;
      entry.mirror_verified = r.mirror_verified;
      entry.result = r;
      inflight.delete(entry.version);
      failures.delete(entry.version);
    } catch (e) {
      // 失败就清状态：下一次调用重新开始（契约 FAIL → RE_DOWNLOAD），**不留 installing 僵尸**
      inflight.delete(entry.version);
      failures.set(entry.version, {
        at: Date.now(),
        reason: e?.reason || 'kernel_error',
        message: e?.message || String(e),
      });
      try {
        console.warn(`[kernel] 内核 ${entry.version} 下载/安装失败（${e?.reason || 'kernel_error'}）：${e?.message || e}`);
      } catch { /* ignore */ }
    }
  })();
}

/* ------------------------------ 下载 + 安装 ------------------------------ */

function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/**
 * 下载到文件，**断了就带 `Range` 接着下**（2026-11-13 实测后加的，理由见下）。
 *
 * 为什么要续传：本机实测 `storage.googleapis.com` 的**单条连接会越下越慢** ——
 * 前 15 秒 138 KB/s，两分钟掉到 47 KB/s；而同一个包另开一条连接又能跑 100 KB/s 以上。
 * 209,854,321 B 的包在「一条连接下到底」的策略下要一两个小时，中途一断还得从头再来。
 * 所以这里做两件事，都不改「包必须完整」这条底线：
 *   1. **停顿检测**：`stallMs` 内一个字节都没收到 → 主动断开这条连接，重连；
 *   2. **断点续传**：重连时带 `Range: bytes=<已收>-`，服务端回 206 就接着写；
 *      服务端不认 Range（回 200 整包）就老老实实从头写（`truncate` 到 0）。
 *
 * 不续传的情况（明确报错，不硬凑）：4xx 除 408/429 之外一律不重试（404 重试一万次还是 404）；
 * 重连次数用尽仍不完整 → 失败，由调用方删掉 `.tmp-*`。
 *
 * @returns {Promise<{bytes: number, total: number, attempts: number, resumed: boolean}>}
 */
export async function downloadToFile(url, zipPath, {
  fetchImpl = fetch,
  timeoutMs = KERNEL_DOWNLOAD_TIMEOUT_MS,
  stallMs = KERNEL_DOWNLOAD_STALL_MS,
  maxAttempts = KERNEL_DOWNLOAD_ATTEMPTS,
  onProgress = () => {},
  giveUpOn = null,
  /** 总预算的截止时刻（毫秒时间戳）。传了就用它，**不再按本函数自己算** —— 见 `downloadFromSources` */
  deadline: givenDeadline = 0,
} = {}) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  // 预算**跨源共享**：`downloadFromSources` 传同一个 deadline 给每个源，
  // 切源只重置「已收字节数」，不重置时间。否则官方卡满 timeout 再切镜像又是 timeout，
  // 最坏变成 2×timeout（默认 2h → 4h），用户等 4 小时等来一个失败。
  const deadline = givenDeadline || (Date.now() + timeoutMs);
  let received = 0;
  let total = 0;
  let attempts = 0;
  let resumed = false;
  let lastErr = null;

  /**
   * 「这个源不用再试了，换下一个」——由调用方判定（见 `downloadFromSources`）。
   * 命中就**立刻抛出**，不再重试本源；异常上带 `sourceUnusable` 标记，调用方据此切源。
   */
  const bailIfUnusable = (err, got) => {
    if (typeof giveUpOn !== 'function') return;
    if (giveUpOn(err, got)) {
      err.sourceUnusable = true;
      throw err;
    }
  };

  while (attempts < maxAttempts) {
    if (Date.now() > deadline) {
      throw new KernelError(`内核包下载超时（总预算 ${timeoutMs} ms 用完，已收 ${received}/${total || '?'} 字节）`, {
        reason: 'download_timeout',
        cause: lastErr,
      });
    }
    attempts += 1;
    const ac = new AbortController();
    let stallTimer = null;
    const bump = () => {
      if (stallTimer) clearTimeout(stallTimer);
      const left = Math.max(0, deadline - Date.now());
      stallTimer = setTimeout(() => ac.abort(), Math.min(stallMs, left || 1));
    };
    bump();

    try {
      const headers = {};
      if (received > 0) headers.range = `bytes=${received}-`;
      const res = await fetchImpl(url, { signal: ac.signal, redirect: 'follow', headers });

      if (res.status === 416 && received > 0) {
        // 服务端说「这个区间没有」：要么我们已经下完，要么本地长度不对 —— 交给后面的长度校验判
        total = received;
        break;
      }
      if (!res.ok) {
        const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
        const err = new KernelError(`内核包下载失败：HTTP ${res.status}（${url}）`, { reason: `download_http_${res.status}` });
        bailIfUnusable(err, received);
        if (!retryable) throw err;
        lastErr = err;
        continue;
      }

      // 206 的 `content-range: bytes 100-999/1000` 才带全长；200 就是整包
      const cr = String(res.headers.get('content-range') || '');
      const crStart = Number((/^bytes\s+(\d+)-/i.exec(cr) || [])[1] || -1);
      const crTotal = Number((/\/\s*(\d+)\s*$/.exec(cr) || [])[1] || 0);
      if (crTotal > 0) total = crTotal;
      else total = Number(res.headers.get('content-length') || 0) + (res.status === 206 ? received : 0);

      let fh;
      if (res.status === 206 && received > 0) {
        // 续传的起点必须正好是本地已有的字节数，否则拼出来的包是坏的 —— 明确报错，不硬拼
        if (crStart >= 0 && crStart !== received) {
          throw new KernelError(
            `内核包续传位置不对：本地已收 ${received} 字节，服务端从 ${crStart} 开始给`,
            { reason: 'download_resume_mismatch' },
          );
        }
        resumed = true;
        fh = fs.openSync(zipPath, 'a');
      } else {
        // 200：整包重来（服务端不认 Range，或这是第一次请求）
        received = 0;
        fh = fs.openSync(zipPath, 'w');
      }
      try {
        for await (const chunk of res.body) {
          bump();
          const buf = Buffer.from(chunk);
          fs.writeSync(fh, buf);
          received += buf.length;
          if (total > 0) onProgress(Math.min(99, Math.floor((received / total) * 100)));
        }
      } finally {
        fs.closeSync(fh);
      }

      if (total > 0 && received >= total) break;
      if (total === 0) break; // 服务端没给长度：靠后面的结构校验兜（解包时会红）
      // 流干净结束但没下完：当作一次中断，接着续
      lastErr = new KernelError(`内核包不完整：content-length 声明 ${total} 字节，实收 ${received} 字节`, { reason: 'download_length_mismatch' });
      bailIfUnusable(lastErr, received);
    } catch (e) {
      if (e?.sourceUnusable) throw e;
      if (e instanceof KernelError && !/^download_http_(408|429|5\d\d)$/.test(String(e.reason))) throw e;
      lastErr = e instanceof KernelError
        ? e
        : new KernelError(
          ac.signal.aborted
            ? `内核包下载卡住：${Math.min(stallMs, timeoutMs)} ms 没收到数据（第 ${attempts} 次，已收 ${received} 字节）`
            : `内核包下载中断：${e?.cause?.code || e?.message || e}`,
          { reason: ac.signal.aborted ? 'download_stalled' : 'download_interrupted', cause: e },
        );
      bailIfUnusable(lastErr, received);
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }
  }

  if (total > 0 && received < total) {
    const reason = lastErr?.reason === 'download_stalled' ? 'download_timeout' : (lastErr?.reason || 'download_interrupted');
    throw new KernelError(
      `内核包下载失败（重连 ${attempts} 次，已收 ${received}/${total} 字节）：${lastErr?.message || '未知原因'}`,
      { reason, cause: lastErr },
    );
  }
  return { bytes: received, total, attempts, resumed };
}

/**
 * 多源下载：**官方优先，镜像只在「这个源根本给不出字节」时回落**。
 *
 * CEO 2026-11-13 定的口径（六条里落在这里的四条）：
 *   - 触发条件写死：**官方这一源零字节卡死（`stallMs` 内一个字节都没有）或任何 HTTP 错误**
 *     才换源。**不是「一慢就切」** —— 实测 34 KB/s 时字节还在流，切了反而丢进度；
 *   - **不许跨源拼接**：每次换源前把半成品删掉、从 0 重下。两个不同来源的字节拼在一起，
 *     长度对得上也可能内容错位（这条最容易被忽略，所以测试里钉「镜像收到的请求不带 Range」）；
 *   - 镜像**只当传输层**：这里的 `sources` 由调用方按官方元数据算出来，镜像不参与「有哪些版本」；
 *   - 如实标注：返回值带 `source` / `switched`，装完由 `installKernel` 落进来源标记。
 *
 * @param {{kind: 'official'|'mirror', url: string}[]} sources 按优先级排列
 * @returns {Promise<{bytes:number,total:number,attempts:number,resumed:boolean,
 *                    source:'official'|'mirror',url:string,switched:boolean,previousError?:Error}>}
 */
export async function downloadFromSources(sources, zipPath, {
  fetchImpl = fetch,
  timeoutMs = KERNEL_DOWNLOAD_TIMEOUT_MS,
  stallMs = KERNEL_DOWNLOAD_STALL_MS,
  maxAttempts = KERNEL_DOWNLOAD_ATTEMPTS,
  onProgress = () => {},
  onSource = () => {},
} = {}) {
  const list = (Array.isArray(sources) ? sources : []).filter((s) => s && s.url);
  if (!list.length) throw new KernelError('没有可用的内核包源', { reason: 'kernel_no_source' });

  // **总预算在这里算一次**：所有源共用同一个 deadline。切源只重置「已收字节数」，
  // 不重置时间 —— 否则「官方卡满 2h → 切镜像再卡 2h」= 最坏 4h（默认配置）。
  const deadline = Date.now() + timeoutMs;

  let lastErr = null;
  for (let i = 0; i < list.length; i += 1) {
    const src = list[i];
    const isLast = i === list.length - 1;

    // 换源必丢半成品（含第一次：上一次失败留下的前一个源的文件不能留）
    try { fs.rmSync(zipPath, { force: true }); } catch { /* 首次本来就没有 */ }
    onSource(src.kind);

    try {
      const r = await downloadToFile(src.url, zipPath, {
        fetchImpl, timeoutMs, stallMs, maxAttempts, onProgress, deadline,
        giveUpOn: isLast ? null : (err, received) => {
          // ① 零字节卡死；② 任何 HTTP 错误（404 也算 —— 官方没有这个包，镜像也许有，
          //    但反过来「官方 500、镜像好」正是要救的场面）。**字节还在流时绝不换源。**
          if (received === 0 && err?.reason === 'download_stalled') return true;
          if (/^download_http_\d+$/.test(String(err?.reason))) return true;
          return false;
        },
      });
      return { ...r, source: src.kind, url: src.url, switched: i > 0, previousError: lastErr };
    } catch (e) {
      // 失败路径也要带走**上一个源**的原因：`lastErr` 此刻还是前一个源的错（本源的错是 `e`）。
      // 最后一个源失败时把两件事分开给：`previous_error.{reason,message}` + message 末尾一句短因果。
      if (isLast || !e?.sourceUnusable) throw withPreviousError(e, lastErr);
      lastErr = e;
    }
  }
  throw lastErr || new KernelError('没有可用的内核包源', { reason: 'kernel_no_source' });
}

/**
 * 把**前一个源**的失败原因挂到当前错误上（CEO 2026-11-13 巡检 ①）。
 *
 * 原来的写法 `if (isLast || !e?.sourceUnusable) throw e;` 在最后一个源失败时直接抛镜像的错，
 * 官方那次 `lastErr` 留在局部变量里没人看见 —— 用户只看到「镜像 404」，看不到「官方先卡死了」。
 * 成功路径反而记了 `switched_reason`，失败路径没有，正好反了。
 *
 * 两段 message **不拼成一坨**：字段分开（`previous_error.reason` / `.message`），脚本要能判；
 * 只在本条 message 后面接一句短的「官方源此前失败：<reason>」，让人一眼看到因果。
 */
function withPreviousError(err, prev) {
  if (!prev || prev === err) return err;
  if (!(err instanceof KernelError)) return err;
  err.previous_error = { reason: prev.reason || 'kernel_error', message: prev.message || String(prev) };
  if (!String(err.message).includes('此前失败')) {
    err.message = `${err.message}（官方源此前失败：${err.previous_error.reason}）`;
  }
  return err;
}

/* ------------------------------ 镜像字节核验 ------------------------------ */

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 「再问一次」的通用壳：`fn` 抛 `KernelError` 就是**判据失败**，直接往外扔；
 * 抛别的（连接层错误、被我们转成 Error 的 5xx/429）才按 `attempts` 重试。
 */
async function withRetry(fn, {
  attempts = MIRROR_VERIFY_ATTEMPTS,
  retryMs = MIRROR_VERIFY_RETRY_MS,
  sleep = sleepMs,
} = {}) {
  const n = Math.max(1, Math.floor(Number(attempts) || 1));
  let lastErr;
  for (let i = 0; i < n; i += 1) {
    if (i > 0 && retryMs > 0) await sleep(retryMs * i);
    try {
      return await fn(i);
    } catch (e) {
      if (e instanceof KernelError) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('fetch failed');
}

/** 5xx / 429 是「服务器这一秒不行」，可以再问；其它状态码是「答案」，问几次都一样 */
const retriableStatus = (s) => s === 429 || (s >= 500 && s <= 599);

/**
 * 官方端点的包体总长：先 HEAD，服务端不认 HEAD（或被连接层重置）再用 `Range: bytes=0-0`
 * 读 `content-range`。两次都拿不到就返回 0 —— 调用方据此**拒绝装**（读不到总长 = 没法证明）。
 */
async function officialSize(url, {
  fetchImpl = fetch,
  timeoutMs = 60000,
  attempts = MIRROR_VERIFY_ATTEMPTS,
  retryMs = MIRROR_VERIFY_RETRY_MS,
  sleep = sleepMs,
} = {}) {
  const grab = (init) => withRetry(async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...init, signal: ac.signal, redirect: 'follow' });
      if (res && retriableStatus(res.status)) {
        try { await res.body?.cancel?.(); } catch { /* 关不掉就算了，反正要重试 */ }
        throw new Error(`HTTP ${res.status}`);
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }, { attempts, retryMs, sleep });

  try {
    const head = await grab({ method: 'HEAD' });
    if (head?.ok) {
      const n = Number(head.headers?.get?.('content-length') || 0);
      if (n > 0) return n;
    }
  } catch { /* HEAD 被重置 / 5xx 用尽：下面用 Range 再问一次总长 */ }
  try {
    const probe = await grab({ headers: { range: 'bytes=0-0' } });
    const cr = /\/\s*(\d+)\s*$/.exec(String(probe?.headers?.get?.('content-range') || ''));
    return Number(cr?.[1] || 0);
  } catch {
    return 0;
  }
}

/**
 * **装之前**用官方 URL 交叉核验镜像给的字节（CEO 口径第 3 条）。
 *
 * 做两件事：
 *   1. 总长：镜像给的 `content-length` 必须等于官方端点报的总长；
 *   2. 抽样：从**官方 URL** 随机抽 `segments` 段、每段 `chunk` 字节（默认 5 × 128 KB），
 *      逐段 sha256 与本地文件同一偏移的字节比对。抽样位置每次随机（`crypto.randomInt`），不许固定。
 *
 * 任一不符（长度、任一段哈希、官方端点不认 Range）→ 抛 `kernel_mirror_verify_failed`，
 * 调用方负责删包、不装。
 *
 * **重试只在连接层**（见 `MIRROR_VERIFY_ATTEMPTS` 的注释）：网络错误 / 5xx / 429 会再问
 * `attempts` 次（同一段、同一位置）；**哈希不符、404、不认 Range 一次就判失败**。
 * 重试用尽仍连不上官方 → 同样报 `kernel_mirror_verify_failed`：**没有证据就不装**，
 * 不因为「这次没连上」就把镜像的字节当成官方字节放过去。
 *
 * **能证明什么、不能证明什么（README 原样写）**：「抽样区间与官方一致 + 总长一致」
 * **不等于**「全文件逐字节等同」。
 */
export async function verifyMirrorBytes({
  officialUrl, zipPath, total = 0,
  fetchImpl = fetch,
  segments = MIRROR_VERIFY_SEGMENTS,
  chunk = MIRROR_VERIFY_CHUNK,
  timeoutMs = 60000,
  attempts = MIRROR_VERIFY_ATTEMPTS,
  retryMs = MIRROR_VERIFY_RETRY_MS,
  sleep = sleepMs,
  randomInt = crypto.randomInt,
} = {}) {
  const fail = (message, cause) => new KernelError(message, { reason: 'kernel_mirror_verify_failed', cause });

  const size = fs.statSync(zipPath).size;
  if (total > 0 && size !== total) {
    throw fail(`镜像包长度与它自己声明的 content-length 不符（声明 ${total}，实收 ${size}）`);
  }
  const officialTotal = await officialSize(officialUrl, { fetchImpl, timeoutMs, attempts, retryMs, sleep });
  if (!officialTotal) {
    throw fail(`读不到官方包体总长，无法核验镜像（${officialUrl}）`);
  }
  if (size !== officialTotal) {
    throw fail(`镜像包总长 ${size} 与官方 ${officialTotal} 不一致`);
  }

  const fd = fs.openSync(zipPath, 'r');
  const local = Buffer.alloc(Math.min(chunk, size));
  const checked = [];
  try {
    // **每段 128 KB 各自独立随机会重叠**（巡检 2026-11-13 ④）：`randomInt(0, span)` 抽 5 次，
    // 抽到相邻位置时两段就盖在一起，于是「5 段 = 640 KB」是虚的，README 那句 0.3% 也跟着高估。
    // 改成**分桶**：把文件切成 `count` 个等宽桶，每桶里随机取一个起点。
    // 桶宽 >= chunk（下面先按这个条件夹 count），所以桶内起点 + chunk 一定还在本桶内 →
    // 段与段**必然不重叠**，合起来恰好 `count × chunk` 字节。
    const len0 = local.length;
    const maxSegs = Math.max(1, Math.floor(size / Math.max(1, len0)));
    const count = Math.max(1, Math.min(Number(segments) || 1, maxSegs));
    const bucket = Math.floor(size / count);
    for (let i = 0; i < count; i += 1) {
      // 抽样位置**只随机一次**：重试核的是同一段，不许「换个位置再试」（那是放宽判据）
      const lo = i * bucket;
      const hi = i === count - 1 ? size - len0 : (i + 1) * bucket - len0;
      const start = hi > lo ? randomInt(lo, hi + 1) : Math.min(lo, size - len0);
      const len = Math.min(local.length, size - start);
      let got;
      try {
        got = await withRetry(() => readOfficialRange({ start, len }), { attempts, retryMs, sleep });
      } catch (e) {
        if (e instanceof KernelError) throw e;
        // 连接层怎么都问不到官方：**没有证据就不能装**，仍按 `kernel_mirror_verify_failed` 报
        throw fail(`从官方 URL 抽段失败：网络错误（偏移 ${start}）：${e?.message || e}`, e);
      }
      fs.readSync(fd, local, 0, len, start);
      const a = crypto.createHash('sha256').update(got).digest('hex');
      const b = crypto.createHash('sha256').update(local.subarray(0, len)).digest('hex');
      if (a !== b) throw fail(`抽段哈希与官方不一致（偏移 ${start}，长度 ${len}）`);
      checked.push({ start, length: len, sha256: a });
    }
  } finally {
    fs.closeSync(fd);
  }

  /** 读官方的一段：网络层错误原样抛（交给 `withRetry`），判据不符抛 `KernelError`（不重试） */
  async function readOfficialRange({ start, len }) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(officialUrl, {
        signal: ac.signal,
        redirect: 'follow',
        headers: { range: `bytes=${start}-${start + len - 1}` },
      });
      if (!res?.ok) {
        if (retriableStatus(res?.status)) throw new Error(`HTTP ${res?.status}`);
        throw fail(`从官方 URL 抽段失败：HTTP ${res?.status}（偏移 ${start}）`);
      }
      if (res.status !== 206) {
        // 官方端点不认 Range 就退回整包 —— 那等于没法「只核一段」，宁可失败也不瞎猜
        throw fail(`官方 URL 不认 Range（偏移 ${start} 返回 ${res.status}），无法核验镜像`);
      }
      const buf = Buffer.concat(await collectBody(res, len));
      if (buf.length !== len) throw fail(`官方抽段长度不对：要 ${len} 字节，实收 ${buf.length}（偏移 ${start}）`);
      return buf;
    } finally {
      clearTimeout(timer);
    }
  }

  return { size, official_total: officialTotal, segments: checked.length, chunk: local.length, ranges: checked };
}

/** 读响应体，最多要 `want` 字节（多出来的不读，省流量） */
async function collectBody(res, want) {
  const out = [];
  let got = 0;
  for await (const part of res.body) {
    const buf = Buffer.from(part);
    out.push(buf);
    got += buf.length;
    if (got >= want) break;
  }
  return out;
}

/**
 * 下载 → 校验 → 解压 → 自检 → 原子改名。**await 到「真装好」才返回**。
 *
 * 失败：`.tmp-*` 整个删掉（zip、半解压目录一起），目标版本目录不会出现半个。
 * @returns {Promise<{version: string, path: string, bytes: number, files: number,
 *                    checksum_source: 'metadata'|'none', verified_by: string,
 *                    download_attempts: number, resumed: boolean,
 *                    source: 'official'|'mirror', mirror_verified: boolean}>}
 */
export async function installKernel(resolved, {
  root = KERNELS_DIR,
  fetchImpl = fetch,
  verifyExe = null,
  timeoutMs = KERNEL_DOWNLOAD_TIMEOUT_MS,
  stallMs = KERNEL_DOWNLOAD_STALL_MS,
  maxAttempts = KERNEL_DOWNLOAD_ATTEMPTS,
  mirrorBase = undefined,
  verifySegments = MIRROR_VERIFY_SEGMENTS,
  verifyChunk = MIRROR_VERIFY_CHUNK,
  verifyAttempts = MIRROR_VERIFY_ATTEMPTS,
  verifyRetryMs = MIRROR_VERIFY_RETRY_MS,
  randomInt = undefined,
  onPhase = () => {},
  onProgress = () => {},
  onSource = () => {},
} = {}) {
  const { version, url, platform = cftPlatform(), checksum = '' } = resolved || {};
  if (!version || !url) throw new KernelError('内核下载参数不完整（缺 version / url）', { reason: 'kernel_bad_resolve' });

  const done = installedExe(version, root);
  if (done) return { version, path: done, bytes: 0, files: 0, checksum_source: 'none', verified_by: 'already-installed' };

  // 镜像只当传输层：地址按**官方元数据解析出来的版本**拼，镜像没有「决定有哪些版本」的资格
  const mirror = mirrorBaseOf(mirrorBase === undefined ? KERNEL_MIRROR : mirrorBase);
  const mirrorUrl = mirror ? mirrorZipUrl(mirror, version, platform) : '';
  const sources = [{ kind: 'official', url }];
  if (mirrorUrl && mirrorUrl !== url) sources.push({ kind: 'mirror', url: mirrorUrl });

  fs.mkdirSync(root, { recursive: true });
  const dst = path.join(root, version);
  const tmp = path.join(root, `.tmp-${version}-${process.pid}-${Date.now().toString(36)}`);
  const zipPath = path.join(tmp, `chrome-${platform}.zip`);
  const xDir = path.join(tmp, 'x');
  try {
    onPhase('downloading');
    const dl = await downloadFromSources(sources, zipPath, {
      fetchImpl, timeoutMs, stallMs, maxAttempts, onProgress, onSource,
    });
    const received = dl.bytes;

    // ① content-length 比对（CfT 没有 sha256，这是能拿到的最硬的完整性信号）
    if (dl.total > 0 && received !== dl.total) {
      throw new KernelError(
        `内核包不完整：content-length 声明 ${dl.total} 字节，实收 ${received} 字节`,
        { reason: 'download_length_mismatch' },
      );
    }
    // ② 万一元数据里带了校验串（CfT 现在没有，`cft.js` 留了口子）就核对
    let checksumSource = 'none';
    if (/^[0-9a-f]{64}$/i.test(String(checksum))) {
      const got = sha256File(zipPath);
      if (got !== String(checksum).toLowerCase()) {
        throw new KernelError(`内核包 sha256 不符（期望 ${checksum}，实得 ${got}）`, { reason: 'download_checksum_mismatch' });
      }
      checksumSource = 'metadata';
    }
    // ③ **镜像的字节必须能对回官方**才允许装（见 `verifyMirrorBytes`）。
    //    不符就抛 `kernel_mirror_verify_failed`，下面是 finally 里删包的路径 —— 绝不「先装了再说」。
    let mirrorVerify = null;
    if (dl.source === 'mirror') {
      mirrorVerify = await verifyMirrorBytes({
        officialUrl: url,
        zipPath,
        total: dl.total,
        fetchImpl,
        segments: verifySegments,
        chunk: verifyChunk,
        attempts: verifyAttempts,
        retryMs: verifyRetryMs,
        ...(randomInt ? { randomInt } : {}),
      });
    }

    onPhase('installing');
    const ex = extractZipFile(zipPath, xDir, { flatten: true });
    const exe = firstExe(xDir);
    if (!exe) throw new KernelError(`解压后没找到 chrome.exe（${xDir}）`, { reason: 'kernel_exe_missing' });

    // ③ 自检：跑一遍 `chrome.exe --version`，版本必须与目录名/请求一致（「下完」不等于「装好」）
    const verify = verifyExe || hooks.verifyExe || verifyChromeVersion;
    const reported = await verify(exe, version);
    if (typeof reported === 'string' && reported && !versionMatches(reported, version)) {
      throw new KernelError(
        `内核自检失败：解压出来的 chrome.exe 报 ${reported}，与请求的 ${version} 不一致`,
        { reason: 'kernel_version_mismatch' },
      );
    }

    // ④ 原子改名：要么整份出现，要么完全不出现
    if (!fs.existsSync(dst)) fs.renameSync(xDir, dst);
    const installed = installedExe(version, root);
    if (!installed) throw new KernelError(`内核安装后仍找不到 chrome.exe（${dst}）`, { reason: 'kernel_install_failed' });

    // ⑤ 来源标记：装好之后才知道「这份是谁给的」，落在版本目录里（隐藏文件，不动 chrome 自己的布局）。
    //    为什么不写数据库：kernels 目录是可搬迁的（换 DATA_DIR、拷 U 盘都行），标记要跟着走。
    const mirror_verified = !!mirrorVerify;
    const sourceInfo = {
      version,
      source: dl.source,
      mirror_verified,
      bytes: received,
      verified_at: new Date().toISOString(),
      ...(mirrorVerify
        ? {
          mirror_segments: mirrorVerify.segments,
          mirror_chunk: mirrorVerify.chunk,
          // **抽样区间原样落盘**（巡检 2026-11-13 ③）：这是证据，不是日志，不截断。
          // 只记「抽了 5 段」而不记抽哪 —— 事后出问题根本没法复核「那 640 KB 到底是哪 640 KB」。
          mirror_ranges: mirrorVerify.ranges,
        }
        : {}),
      ...(dl.switched ? { switched_from: 'official', switched_reason: dl.previousError?.reason || null } : {}),
    };
    try {
      fs.writeFileSync(path.join(dst, SOURCE_MARKER), `${JSON.stringify(sourceInfo, null, 2)}\n`, 'utf8');
    } catch (e) {
      // 标记写不上不影响内核可用，但要留痕：否则 `completed` 会退化成 source:'unknown'
      try { console.warn(`[kernel] 写来源标记失败（${dst}）：${e?.message || e}`); } catch { /* ignore */ }
    }

    return {
      version,
      path: installed,
      bytes: received,
      files: ex.files.length,
      checksum_source: checksumSource,
      verified_by: 'chrome.exe --version',
      download_attempts: dl.attempts,
      resumed: dl.resumed,
      source: dl.source,
      mirror_verified,
      ...(mirrorVerify ? { mirror_verify: mirrorVerify } : {}),
    };
  } finally {
    // 成功路径：xDir 已被改名走，这里只剩 zip 和空壳；失败路径：zip + 半解压目录一起删
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      try { console.warn(`[kernel] 清理临时目录失败（${tmp}）：${e?.message || e}`); } catch { /* ignore */ }
    }
  }
}

/** `157.0.8103.78` 与 `157.0.8103.78` 相等；请求是短版本（`157`）时按前缀认 */
function versionMatches(reported, expected) {
  const a = String(reported).trim();
  const b = String(expected).trim();
  return a === b || a.startsWith(`${b}.`);
}

/**
 * 真自检：`chrome.exe --version` → `Google Chrome 157.0.8103.78`（Windows 实测输出在 stdout，退出码 0）。
 * 只跑这一条命令，**不启动浏览器、不加载任何环境**。
 */
export function verifyChromeVersion(exe, expectedVersion) {
  let out = '';
  try {
    out = execFileSync(exe, ['--version'], { timeout: 30000, windowsHide: true, encoding: 'utf8' });
  } catch (e) {
    throw new KernelError(`内核自检失败：${exe} --version 没跑起来（${e?.message || e}）`, {
      reason: 'kernel_verify_failed',
      cause: e,
    });
  }
  const m = /(\d+\.\d+\.\d+\.\d+)/.exec(String(out || ''));
  if (!m) {
    throw new KernelError(`内核自检失败：chrome.exe --version 没报出版本号（输出：${String(out || '').trim().slice(0, 200)}）`, {
      reason: 'kernel_verify_no_version',
    });
  }
  return m[1];
}
