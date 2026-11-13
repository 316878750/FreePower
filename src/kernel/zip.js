/**
 * 极简 ZIP 解包 —— 只服务内核下载（Chrome for Testing 给的是 `chrome-win64.zip`）。
 *
 * 为什么自己写而不是拉依赖：这个仓库**不新增 npm 依赖**（与 LLM 那批同一条规矩），
 * 而 Node 内置只有 zlib、没有 zip 容器解析。这里只实现内核包真的会用到的那一小撮：
 *   中央目录 → 本地头 → `store`(0) / `deflate`(8) 两种方法 + CRC32 校验。
 *
 * **只认中央目录那一份**：CRC / 压缩前尺寸都从中央目录读；本地头（LFH）里的 CRC 与尺寸**从不读**
 * （LFH 在流式写出的包里常常是 0，读它等于给自己造假信号）。所以「校验」在这一层只有一处，别以为两处都查。
 *
 * **明确不做（遇到就红，别静默糊过去）**：
 *   - 运行时没有 `zlib.crc32`（Node < 22.5）→ `zip_crc_unavailable`（**不跳过校验**）；
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

/**
 * 取一个条目的解压数据。
 *
 * `maxOutputLength`（**解压时**的输出上限）不是可选项：没有它，一个零字节炸弹会先在内存里
 * 长到它的真实大小，再被尺寸判据抓到 —— 判据对了，进程已经炸了。传进 `zlib.inflateRawSync`
 * 后，超限在**灌数据的过程中**就抛 `ERR_BUFFER_TOO_LARGE`。
 *
 * 上限从哪来决定报什么错（`capSource`）：
 *   - `'declared'`：上限 = 中央目录声明的长度 + 1。诚实条目解压后必然正好等于 `usize`，
 *     所以**超过 `usize` 本身就证明声明撒谎**（实际长度超过声明）→ `zip_size_mismatch`；
 *     多给的那 1 字节是留给「刚刚好多 1 字节」的，让下面的等值校验去报，文案才对得上。
 *   - `'budget'`：剩余预算比声明值还小，是**预算**先拦住它 → `zip_too_large`。
 */
function entryData(buf, e, { maxOutputLength, capSource = 'budget' } = {}) {
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
      return zlib.inflateRawSync(raw, { maxOutputLength });
    } catch (err) {
      // 超上限在**解压时**就抛（不是解完再比长度）
      if (err?.code === 'ERR_BUFFER_TOO_LARGE' || /larger than|maxOutputLength/i.test(String(err?.message))) {
        if (capSource === 'declared') {
          throw new ZipError(
            `条目实际长度超过中央目录声明（声明 ${e.usize} 字节，解压到 ${maxOutputLength} 字节仍未结束）：${e.name}`,
            { reason: 'zip_size_mismatch' },
          );
        }
        throw new ZipError(
          `条目解压后超过剩余预算（剩余 ${maxOutputLength} 字节，中央目录声明 ${e.usize} 字节）：${e.name}`,
          { reason: 'zip_too_large' },
        );
      }
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
  // `total` 只是**按中央目录声明值**算的预检（便宜、能在写盘前就拦住一份明显超标的包）；
  // 真正的上限在下面按**实际解压出来的字节**再算一次 —— 声明值是包自己写的，不能当预算依据。
  let total = 0;
  for (const e of entries) {
    const rel = safeRel(e.name);
    if (!rel) { dirs.add(e.name); continue; }
    total += e.usize;
    if (total > maxBytes) {
      throw new ZipError(`解压后总量超过上限（${maxBytes} 字节，按中央目录声明值预检），拒绝继续`, { reason: 'zip_too_large' });
    }
    files.push({ rel, entry: e });
  }
  if (!files.length) throw new ZipError('ZIP 里没有文件', { reason: 'zip_empty' });

  // CRC32 是**必校验项**，不是「有就校验」：
  //   - 运行时没有 `zlib.crc32`（Node < 22.5 / 老 Electron）就**直接拒解**，不许静默跳过。
  //     跳过等于把「包体被动过」的检测整个丢掉 —— 和这轮在抓的 fail-open 是同一类问题。
  //     `package.json` 的 `engines` 写了 node >= 22.5、Electron ^45，正常机器一定有。
  //   - CRC 恒有值：`readZipEntries` 用 `readUInt32LE` 读它，**不存在「没有 CRC」的条目**；
  //     所以这里只判两件事 —— 运行时有没有 `zlib.crc32`（没有就拒）、算出来的等不等。
  //     曾经写成 `&& entry.crc` 是拿真假值判有无，`0` 是完全合法的 CRC32（有 1/2^32 的文件
  //     正好算出 0），那样会把这类条目**静默跳过校验**。
  if (typeof zlib.crc32 !== 'function') {
    throw new ZipError(
      '运行时没有 zlib.crc32（需要 Node >= 22.5 / Electron 45+），拒绝在无 CRC 校验的情况下解包',
      { reason: 'zip_crc_unavailable' },
    );
  }

  let stripped = '';
  if (flatten) {
    const tops = new Set(files.map((f) => f.rel.split('/')[0]));
    if (tops.size === 1 && files.every((f) => f.rel.includes('/'))) stripped = [...tops][0];
  }

  const root = path.resolve(destDir);
  const existedBefore = fs.existsSync(root);
  fs.mkdirSync(root, { recursive: true });
  const written = [];
  let actualBytes = 0;
  try {
    for (const { rel, entry } of files) {
      const outRel = stripped ? rel.slice(stripped.length + 1) : rel;
      const out = path.resolve(root, ...outRel.split('/'));
      if (out !== root && !out.startsWith(root + path.sep)) {
        throw new ZipError(`ZIP 条目越出解压目录：${rel}`, { reason: 'zip_unsafe_path' });
      }
      // 单条目解压上限 = min(剩余预算, 声明长度 + 1)。**不能只用剩余预算**：`maxBytes` 默认 2 GB，
      // 那等于「单条目没有上限」，炸弹会先长到真实大小再被判据抓到（判据绿、进程已经吃了 200 MB）。
      // 上限从**数据本身**推：诚实条目解压后必然正好等于 `usize`，所以超过 `usize` 就是声明撒谎。
      const budgetLeft = Math.max(1, maxBytes - actualBytes);
      const declaredCap = entry.usize + 1;
      const cap = Math.min(budgetLeft, declaredCap);
      const capSource = cap === declaredCap ? 'declared' : 'budget';
      const data = entryData(buf, entry, { maxOutputLength: cap, capSource });
      // **无条件比对**（巡检 2026-11-13 ①）：原来的 `entry.usize !== 0 &&` 等于「声明 0 就豁免」，
      // 一个声明 `usize=0`、实际 1 MB 的条目能整条跳过长度校验 —— 典型的 fail-open。
      if (data.length !== entry.usize) {
        throw new ZipError(`条目长度不符：${rel}（中央目录写 ${entry.usize}，实际 ${data.length}）`, { reason: 'zip_size_mismatch' });
      }
      // 上限按**真实解压量**算（`:139` 那个只是按声明值的预检，声明可以撒谎）
      actualBytes += data.length;
      if (actualBytes > maxBytes) {
        throw new ZipError(`解压后实际总量超过上限（${maxBytes} 字节），拒绝继续`, { reason: 'zip_too_large' });
      }
      // CRC32：**每个条目都校验**（可用性在上面统一把过关，这里不再静默跳过）
      const got = zlib.crc32(data) >>> 0;
      if (got !== (entry.crc >>> 0)) throw new ZipError(`CRC 不符：${rel}`, { reason: 'zip_crc_mismatch' });
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data);
      written.push(outRel);
    }
  } catch (e) {
    // 失败时把这一次已经写出去的清掉：**盘上不留半个包**（内核安装本来就该「要么整份，要么没有」）。
    //
    // 清场的边界（如实写清，别当成「什么都没动」）：
    //   - **调用方传进来的已有目录本身不动**（`existedBefore` 为真时不删根目录），
    //     但**里面与包内同名的文件会被覆盖**，然后在这里按 `written` 一起删掉 ——
    //     也就是说「覆盖 + 失败」对调用方的同名文件是破坏性的。生产路径不可达：
    //     `download.js` 每次都新建 `.tmp-*` 当 `xDir`，不会指向用户已有目录。
    //   - `dest` 已存在时失败，**我们建出来的空子目录会残留**（只删 `written` 里记的文件，
    //     不回溯删父目录）；下一次解包会覆盖同名文件，不影响正确性。
    for (const rel of written) {
      try { fs.rmSync(path.resolve(root, ...rel.split('/')), { force: true }); } catch { /* 清不掉就留给调用方 */ }
    }
    // 目录是我们建的就连目录一起删（调用方传进来的已有目录不动）
    if (!existedBefore) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 同上 */ }
    }
    throw e;
  }
  // 返回**实际解压量**，不是中央目录声明的那个数
  return { files: written, bytes: actualBytes, stripped };
}

/** 从磁盘上的 zip 文件解包（内核下载用这个） */
export function extractZipFile(zipPath, destDir, opts) {
  return extractZipBuffer(fs.readFileSync(zipPath), destDir, opts);
}
