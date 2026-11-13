/**
 * 极简 ZIP 解包 —— 只服务内核下载（Chrome for Testing 给的是 `chrome-win64.zip`）。
 *
 * 为什么自己写而不是拉依赖：这个仓库**不新增 npm 依赖**（与 LLM 那批同一条规矩），
 * 而 Node 内置只有 zlib、没有 zip 容器解析。这里只实现内核包真的会用到的那一小撮：
 *   中央目录 → 本地头 → `store`(0) / `deflate`(8) 两种方法 + CRC32 校验。
 *
 * **明确不做（遇到就红，别静默糊过去）**：
 *   - ZIP64（条目数 / 偏移 / 尺寸溢出 0xFFFF / 0xFFFFFFFF）→ `zip_zip64_unsupported`；
 *   - 加密条目（flag bit 0）→ `zip_encrypted`；
 *   - 其它压缩方法（bzip2 / lzma…）→ `zip_unsupported_method`；
 *   - 绝对路径 / 盘符 / `..` 段 → `zip_unsafe_path`（解包前就拒，别等到写文件）。
 *
 * 判据：`test/kernel-download.test.mjs` 用**自己现造的 zip**（store + deflate + 路径穿越）
 * 打这一层；另用 PowerShell 的 `Compress-Archive` 产物手工对过一次真实 zips 的行为。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export class ZipError extends Error {
  constructor(message, { reason = 'zip_error' } = {}) {
    super(message);
    this.name = 'ZipError';
    this.code = -1;
    this.reason = reason;
  }
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
/** 解压后总量上限：内核包约 350 MB，2 GB 足够，同时挡住 zip bomb */
export const ZIP_MAX_BYTES = 2 * 1024 * 1024 * 1024;

function findEocd(buf) {
  const floor = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) !== EOCD_SIG) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    if (i + 22 + commentLen === buf.length) return i;
  }
  throw new ZipError('找不到 ZIP 中央目录尾部（EOCD）：文件可能不完整或被截断', { reason: 'zip_no_eocd' });
}

/** 读中央目录，返回条目元数据（不解压） */
export function readZipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('不是有效的 ZIP：内容太短', { reason: 'zip_too_short' });
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new ZipError('ZIP64 暂不支持（内核包不该到这个尺寸，遇到先别下）', { reason: 'zip_zip64_unsupported' });
  }
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) {
      throw new ZipError(`中央目录第 ${i} 条损坏`, { reason: 'zip_bad_central_dir' });
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError('ZIP64 暂不支持（条目尺寸/偏移溢出）', { reason: 'zip_zip64_unsupported' });
    }
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, flags, method, crc, csize, usize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 条目名 → 安全的相对路径；目录条目（以 `/` 结尾）返回 null */
function safeRel(name) {
  const rel = String(name).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!rel) return null;
  if (rel.endsWith('/')) return null;
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) {
    throw new ZipError(`ZIP 里有绝对路径条目：${rel}`, { reason: 'zip_unsafe_path' });
  }
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) {
    throw new ZipError(`ZIP 里有越界路径条目：${rel}`, { reason: 'zip_unsafe_path' });
  }
  return segs.join('/');
}

function entryData(buf, e) {
  if (e.flags & 0x1) throw new ZipError(`ZIP 条目被加密：${e.name}`, { reason: 'zip_encrypted' });
  const p = e.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LFH_SIG) {
    throw new ZipError(`本地头损坏：${e.name}`, { reason: 'zip_bad_local_header' });
  }
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const end = start + e.csize;
  if (end > buf.length) throw new ZipError(`条目数据越界：${e.name}`, { reason: 'zip_truncated' });
  const raw = buf.subarray(start, end);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) {
    try {
      return zlib.inflateRawSync(raw);
    } catch (err) {
      throw new ZipError(`解压失败（${e.name}）：${err.message}`, { reason: 'zip_inflate_failed' });
    }
  }
  throw new ZipError(`不支持的压缩方法 ${e.method}（${e.name}）`, { reason: 'zip_unsupported_method' });
}

/**
 * 从内存里的 ZIP 解到 destDir。
 *
 * @param {Buffer} buf
 * @param {string} destDir
 * @param {{flatten?: boolean, maxBytes?: number}} [opts]
 *        `flatten`（默认 true）：若所有文件都在同一个顶层目录下，就把这一层剥掉
 *        —— CfT 的 `chrome-win64/…` 剥完正好是 `<kernels>/<version>/chrome.exe`，
 *        与 `listKernels` 认的布局一致。
 * @returns {{files: string[], bytes: number, stripped: string}}
 */
export function extractZipBuffer(buf, destDir, { flatten = true, maxBytes = ZIP_MAX_BYTES } = {}) {
  const entries = readZipEntries(buf);
  const files = [];
  const dirs = new Set();
  let total = 0;
  for (const e of entries) {
    const rel = safeRel(e.name);
    if (!rel) { dirs.add(e.name); continue; }
    total += e.usize;
    if (total > maxBytes) {
      throw new ZipError(`解压后总量超过上限（${maxBytes} 字节），拒绝继续`, { reason: 'zip_too_large' });
    }
    files.push({ rel, entry: e });
  }
  if (!files.length) throw new ZipError('ZIP 里没有文件', { reason: 'zip_empty' });

  let stripped = '';
  if (flatten) {
    const tops = new Set(files.map((f) => f.rel.split('/')[0]));
    if (tops.size === 1 && files.every((f) => f.rel.includes('/'))) stripped = [...tops][0];
  }

  const root = path.resolve(destDir);
  fs.mkdirSync(root, { recursive: true });
  const written = [];
  for (const { rel, entry } of files) {
    const outRel = stripped ? rel.slice(stripped.length + 1) : rel;
    const out = path.resolve(root, ...outRel.split('/'));
    if (out !== root && !out.startsWith(root + path.sep)) {
      throw new ZipError(`ZIP 条目越出解压目录：${rel}`, { reason: 'zip_unsafe_path' });
    }
    const data = entryData(buf, entry);
    if (entry.usize !== 0 && data.length !== entry.usize) {
      throw new ZipError(`条目长度不符：${rel}（头写 ${entry.usize}，实际 ${data.length}）`, { reason: 'zip_size_mismatch' });
    }
    // CRC32：Node 20.15+ 有 zlib.crc32；没有就跳过（仍然有长度校验 + 版本校验兜底）
    if (typeof zlib.crc32 === 'function' && entry.crc) {
      const got = zlib.crc32(data) >>> 0;
      if (got !== (entry.crc >>> 0)) throw new ZipError(`CRC 不符：${rel}`, { reason: 'zip_crc_mismatch' });
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    written.push(outRel);
  }
  return { files: written, bytes: total, stripped };
}

/** 从磁盘上的 zip 文件解包（内核下载用这个） */
export function extractZipFile(zipPath, destDir, opts) {
  return extractZipBuffer(fs.readFileSync(zipPath), destDir, opts);
}
