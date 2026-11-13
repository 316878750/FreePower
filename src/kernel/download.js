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
  KERNELS_DIR, CFT_META_URL, CFT_VERSIONS_URL, CFT_ZIP_BASE, KERNEL_DOWNLOAD_TIMEOUT_MS,
} from '../config.js';
import { cftPlatform, resolveCftKernel } from './cft.js';
import { extractZipFile } from './zip.js';

/** 解压后认的三种布局（与 `listKernels` 同一份口径，顺序也一样） */
const EXE_RELS = ['chrome.exe', 'chrome-win64/chrome.exe', 'chrome-win/chrome.exe'];

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
  if (entry.status === 'completed') return { status: 'completed' };
  if (entry.status === 'installing') return { status: 'installing' };
  const progress = Math.max(0, Math.min(100, Math.round(entry.progress || 0)));
  return { status: entry.status === 'downloading' ? 'downloading' : 'pending', progress };
}

const completedRes = () => ({ code: 0, data: { status: 'completed' }, msg: 'success' });
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
  };

  // ① 已装：幂等 completed（分支 A，带 msg）
  if (installedExe(req.kernel_version, root)) return completedRes();

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
    return completedRes();
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
  // 分支 B：触发了下载 —— 没有 msg（契约 §2.2）
  return { code: 0, data: { status: 'pending', progress: 0 } };
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
        onPhase: (ph) => { entry.status = ph; },
        onProgress: (p) => { entry.progress = p; },
      });
      entry.status = 'completed';
      entry.progress = 100;
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
 * 下载 → 校验 → 解压 → 自检 → 原子改名。**await 到「真装好」才返回**。
 *
 * 失败：`.tmp-*` 整个删掉（zip、半解压目录一起），目标版本目录不会出现半个。
 * @returns {Promise<{version: string, path: string, bytes: number, files: number,
 *                    checksum_source: 'metadata'|'none', verified_by: string}>}
 */
export async function installKernel(resolved, {
  root = KERNELS_DIR,
  fetchImpl = fetch,
  verifyExe = null,
  timeoutMs = KERNEL_DOWNLOAD_TIMEOUT_MS,
  onPhase = () => {},
  onProgress = () => {},
} = {}) {
  const { version, url, platform = cftPlatform(), checksum = '' } = resolved || {};
  if (!version || !url) throw new KernelError('内核下载参数不完整（缺 version / url）', { reason: 'kernel_bad_resolve' });

  const done = installedExe(version, root);
  if (done) return { version, path: done, bytes: 0, files: 0, checksum_source: 'none', verified_by: 'already-installed' };

  fs.mkdirSync(root, { recursive: true });
  const dst = path.join(root, version);
  const tmp = path.join(root, `.tmp-${version}-${process.pid}-${Date.now().toString(36)}`);
  const zipPath = path.join(tmp, `chrome-${platform}.zip`);
  const xDir = path.join(tmp, 'x');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let received = 0;
  try {
    onPhase('downloading');
    let res;
    try {
      res = await fetchImpl(url, { signal: ac.signal, redirect: 'follow' });
    } catch (e) {
      throw new KernelError(
        ac.signal.aborted ? `内核包下载超时（>${timeoutMs} ms）` : `内核包下载失败：${e?.cause?.code || e?.message || e}`,
        { reason: ac.signal.aborted ? 'download_timeout' : 'download_unreachable', cause: e },
      );
    }
    if (!res.ok) {
      throw new KernelError(`内核包下载失败：HTTP ${res.status}（${url}）`, { reason: `download_http_${res.status}` });
    }
    const total = Number(res.headers.get('content-length') || 0);

    fs.mkdirSync(tmp, { recursive: true });
    const fh = fs.openSync(zipPath, 'w');
    try {
      for await (const chunk of res.body) {
        const buf = Buffer.from(chunk);
        fs.writeSync(fh, buf);
        received += buf.length;
        if (total > 0) onProgress(Math.min(99, Math.floor((received / total) * 100)));
      }
    } catch (e) {
      throw new KernelError(
        ac.signal.aborted ? `内核包下载超时（>${timeoutMs} ms）` : `内核包下载中断：${e?.cause?.code || e?.message || e}`,
        { reason: ac.signal.aborted ? 'download_timeout' : 'download_interrupted', cause: e },
      );
    } finally {
      fs.closeSync(fh);
    }

    // ① content-length 比对（CfT 没有 sha256，这是能拿到的最硬的完整性信号）
    if (total > 0 && received !== total) {
      throw new KernelError(
        `内核包不完整：content-length 声明 ${total} 字节，实收 ${received} 字节`,
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
    return {
      version,
      path: installed,
      bytes: received,
      files: ex.files.length,
      checksum_source: checksumSource,
      verified_by: 'chrome.exe --version',
    };
  } finally {
    clearTimeout(timer);
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
