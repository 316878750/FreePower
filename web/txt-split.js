/**
 * AdsPower `.txt` 导入的**切块**（纯函数，不碰 DOM、不碰网络）。
 *
 * 为什么要有它：用户从 AdsPower 导出的文件实测 18,884,174 B / 50 块，整份塞进一个
 * 请求是 21 MB —— 服务端 2 MB 上限下连接被掐断，界面只显示英文 `Failed to fetch`。
 * 服务端上限已经提到 64 MB，但界面这一侧仍然要分批：一个大文件不该依赖「上限刚好够大」，
 * 而且分批之后进度、失败定位都更清楚。
 *
 * 三条硬规矩：
 *   1. **只在块边界切**，绝不切在 `cookie=` 行中间（那一行可能 50 万字符）；
 *   2. 双阈值：每批 ≤ maxBytes 字节 **且** ≤ maxBlocks 块，谁先到就切；
 *   3. 所有批次的文本拼起来**逐字节等于原文**（不 trim、不改换行、不补 BOM）。
 *      这条是判据，也是「分批」能保证无损的唯一理由。
 *
 * 块边界定义（与 `src/store/adspower-txt.js` 的 `parseBlocks` 一致）：
 * 一整行 ≥10 个星号是块尾；块尾行连同它的换行属于当前块。
 */

/** 默认阈值：8 MB / 40 块（服务端上限 64 MB，留足余量；块数上限防「小块很多」把请求数打爆） */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_BLOCKS = 40;

const SEP_RE = /^\*{10,}$/;

/** UTF-8 字节数（不是字符数：cookie 里可能有非 ASCII） */
function bytesOf(s) {
  if (typeof Buffer !== 'undefined') return Buffer.byteLength(s, 'utf8');
  return new TextEncoder().encode(s).length;
}

/** 一行是不是块尾星号行 */
const isSepLine = (line) => SEP_RE.test(line.trim());

/**
 * 扫一遍全文，返回块尾行的位置与「末尾残留是否有内容」。
 * @returns {{sepEnds:number[], tailStart:number}}
 */
function scan(text) {
  const sepEnds = [];
  let tailStart = 0;
  let pos = 0;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const after = nl === -1 ? text.length : nl + 1;
    if (isSepLine(text.slice(pos, lineEnd))) {
      sepEnds.push(after);
      tailStart = after;
    }
    if (nl === -1) break;
    pos = after;
  }
  return { sepEnds, tailStart };
}

/** 块数（做进度用；与 parseBlocks 的分块口径一致：星号行数 + 末尾残留那一块） */
export function countTxtBlocks(text) {
  const src = String(text ?? '');
  const { sepEnds, tailStart } = scan(src);
  return sepEnds.length + (src.slice(tailStart).trim() ? 1 : 0);
}

/**
 * 切成若干批。
 * @param {string} text 整份文件
 * @param {{maxBytes?:number, maxBlocks?:number}} [opts]
 * @returns {{chunks: Array<{text:string, blocks:number, first_block:number, bytes:number, oversized:boolean}>,
 *            total_blocks:number, total_bytes:number}}
 *   `blocks` 本批几块；`first_block` 本批第一块在整份文件里的 **0 基块号**
 *   （服务端返回的 index 是「本请求内」的序号，界面要靠它换算成整份文件的块号）。
 *   `oversized: true` = 单块就超过 maxBytes，无法在不破块的前提下切小，如实标出。
 */
export function splitTxtChunks(text, opts = {}) {
  const src = String(text ?? '');
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : DEFAULT_MAX_BYTES;
  const maxBlocks = Number(opts.maxBlocks) > 0 ? Number(opts.maxBlocks) : DEFAULT_MAX_BLOCKS;

  const totalBlocks = countTxtBlocks(src);
  if (!src || totalBlocks === 0) {
    return { chunks: [], total_blocks: 0, total_bytes: bytesOf(src) };
  }

  // 1) 段 = 一块（含块尾星号行与它的换行）。段区间首尾相接、覆盖全串，
  //    这样批次拼回去才可能逐字节等于原文。
  const { sepEnds, tailStart } = scan(src);
  const bounds = [...sepEnds];
  if (src.slice(tailStart).trim()) bounds.push(src.length);
  // bounds 里最后一项可能重复（末尾星号行之后没有残留时 tailStart == src.length 已包含）
  if (!bounds.length || bounds[bounds.length - 1] !== src.length) bounds.push(src.length);

  const segments = [];
  let from = 0;
  for (const to of bounds) {
    if (to <= from) continue;
    const piece = src.slice(from, to);
    segments.push({ start: from, end: to, blocks: piece.trim() ? 1 : 0 });
    from = to;
  }
  if (from < src.length) segments.push({ start: from, end: src.length, blocks: 0 });
  // 纯空白的段并进前一段（开头那段并进后一段），保证「每段至少一块」且字节不断
  const merged = [];
  for (const seg of segments) {
    if (seg.blocks === 0 && merged.length) { merged[merged.length - 1].end = seg.end; continue; }
    merged.push({ ...seg });
  }
  if (merged.length > 1 && merged[0].blocks === 0) {
    merged[1].start = merged[0].start;
    merged.shift();
  }

  // 2) 按双阈值装箱
  const boxes = [];
  let cur = null;
  for (const seg of merged) {
    const segBytes = bytesOf(src.slice(seg.start, seg.end));
    if (cur && (cur.bytes + segBytes > maxBytes || cur.blocks + seg.blocks > maxBlocks)) {
      boxes.push(cur);
      cur = null;
    }
    if (!cur) cur = { start: seg.start, end: seg.end, bytes: 0, blocks: 0 };
    cur.end = seg.end;
    cur.bytes += segBytes;
    cur.blocks += seg.blocks;
  }
  if (cur) boxes.push(cur);

  // 3) 出结果：first_block 累计，供界面把「本批第几条失败」换算成整份文件的块号
  let first = 0;
  const chunks = boxes.map((b) => {
    const t = src.slice(b.start, b.end);
    const item = {
      text: t,
      blocks: b.blocks,
      first_block: first,
      bytes: bytesOf(t),
      oversized: b.blocks <= 1 && b.bytes > maxBytes,
    };
    first += b.blocks;
    return item;
  });

  return { chunks, total_blocks: first, total_bytes: bytesOf(src) };
}

/**
 * 汇总分批结果 —— 把每批的 `failed.index`（**批内**序号）换算成整份文件的块号。
 *
 * 这是分批导入最容易做错的一步：服务端只知道自己这一批里第几块有问题，
 * 直接显示就会出现「第 2 批的第 3 块」被当成「整份文件的第 3 块」。
 *
 * @param {Array<{first_block:number, blocks:number}>} chunks splitTxtChunks 的 chunks
 * @param {Array<{imported?:number, failed?:object[], warnings?:string[], blocks?:number, error?:string}>} results
 *        每批的结果；`error` 表示这一批整体失败（网络断了/服务端 500），不中断其余批
 * @returns {{imported:number, failed:object[], warnings:string[], batches:number, failed_batches:number}}
 */
export function mergeBatchResults(chunks, results) {
  let imported = 0;
  let failedBatches = 0;
  const failed = [];
  const warnings = [];
  chunks.forEach((c, i) => {
    const r = results[i] || { error: '这一批没有结果' };
    if (r.error) {
      failedBatches += 1;
      failed.push({
        index: c.first_block,
        reason: `第 ${i + 1} 批（第 ${c.first_block + 1}–${c.first_block + c.blocks} 块）整批失败：${r.error}`,
      });
      return;
    }
    imported += Number(r.imported) || 0;
    for (const f of r.failed || []) {
      failed.push({ ...f, index: c.first_block + Number(f.index ?? 0) });
    }
    for (const w of r.warnings || []) warnings.push(w);
    // 服务端解析出的块数应等于这批的块数；不等说明两边分块口径有分歧，后面的块号可能偏移。
    // 宁可说出来，也不让用户拿一份错位的失败清单。
    const serverBlocks = Number(r.blocks);
    if (Number.isFinite(serverBlocks) && serverBlocks !== c.blocks) {
      warnings.push(`第 ${i + 1} 批：服务端解析出 ${serverBlocks} 块、预期 ${c.blocks} 块，`
        + '失败清单里的块号可能偏移（已导入的环境不受影响）');
    }
  });
  return { imported, failed, warnings, batches: chunks.length, failed_batches: failedBatches };
}
