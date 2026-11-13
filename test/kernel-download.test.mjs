/**
 * 内核下载判定门 A 层（0.4.1）—— **不联网、不起内核、不碰 %APPDATA%\FreePower**。
 *
 * 假源是 `node:http` 起在 127.0.0.1 随机端口上的一个 zip 分发点，zip 由本文件自己造
 * （store 方法 + 真 CRC32，走的是 `src/kernel/zip.js` 的真解包路径）。
 * 覆盖 CEO 点的六条，一条不少：
 *   A1 正常下载 → 解压 → 校验 → completed（含盘上布局、`kernels` 列表认账、无 `.tmp-*` 残留）
 *   A2 content-length 不符 → 失败（**用注入的 fetch 造「干净结束但长度不对」**，
 *      真 HTTP 早断会被 undici 判成 terminated，走不到这条分支）
 *   A3 `kernel_type` 大小写错 → 契约文案，且响应里没有 `data` 键
 *   A4 `Firefox` → 明确「不支持」，不是 `No matching kernel version available.`
 *   A5 同名已装 → 幂等 `completed`（带 `msg:"success"`，分支 A）
 *   A6 网络中途断 → 失败，且不留 `installing` 僵尸状态、不留半成品目录
 * 另加：缺参 / 版本非数字 / `"0"` / 目录里没有该版本 / 并发只下一次 / 版本自检不一致 / 404。
 *
 * 真 `chrome.exe --version` 在这里跑不了（假源里那个 chrome.exe 是文本占位），所以换掉
 * `hooks.verifyExe` —— 它只影响「解压后自检」这一步，**不改下载/解压/改名任何逻辑**。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(repoRoot, '.tmp', `pa3-kernel-test-${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ 造 zip ------------------------------ */

function makeZip(files) {
  const locals = [];
  const cds = [];
  const names = Object.keys(files);
  let offset = 0;
  for (const name of names) {
    const nameBuf = Buffer.from(name, 'utf8');
    const buf = Buffer.isBuffer(files[name]) ? files[name] : Buffer.from(String(files[name]));
    const crc = typeof zlib.crc32 === 'function' ? zlib.crc32(buf) >>> 0 : 0;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6); // flags：无 data descriptor
    lfh.writeUInt16LE(0, 8); // method：store
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(buf.length, 18);
    lfh.writeUInt32LE(buf.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    locals.push(lfh, nameBuf, buf);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(buf.length, 20);
    cd.writeUInt32LE(buf.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    cds.push(cd, nameBuf);
    offset += 30 + nameBuf.length + buf.length;
  }
  const cdBuf = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

/** 一份「像 CfT 的 zip」：多一层 chrome-win64/，剥掉后正好是 <版本>/chrome.exe */
const zipFor = (version) => makeZip({
  'chrome-win64/chrome.exe': `FAKE_CHROME ${version}\n`,
  'chrome-win64/chrome.dll': Buffer.alloc(2048, 7),
  'chrome-win64/locales/en-US.pak': 'pak',
});

/* ------------------------------ 假源 ------------------------------ */

const zips = new Map();
const hits = new Map();
/** 镜像侧收到的请求（断言「换源后整包请求不带 Range」用） */
const mirrorHits = [];
let BASE = '';

const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  hits.set(p, (hits.get(p) || 0) + 1);
  const sendJson = (obj) => {
    const b = Buffer.from(JSON.stringify(obj));
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': b.length });
    res.end(b);
  };
  if (p === '/meta/last-known-good-versions-with-downloads.json') {
    return sendJson({
      channels: {
        Stable: {
          version: '157.0.8103.78',
          downloads: { chrome: [{ platform: 'win64', url: `${BASE}/ok/157.0.8103.78/win64/chrome-win64.zip` }] },
        },
      },
    });
  }
  if (p === '/meta/known-good-versions-with-downloads.json') return sendJson({ versions: [] });

  /* ---------- 镜像那批用的端点（官方侧） ---------- */
  // 官方「卡死」：整包 GET **一个字节都不给**（客户端靠 stall 检测断开 → 判定这一源不可用 → 换镜像）；
  // 但 HEAD 与 Range 正常 —— 因为装之前的交叉核验要用官方 URL 抽段比对。
  const officialSlow = /^\/slow-official\/([\d.]+)\/win64\/chrome-win64\.zip$/.exec(p);
  if (officialSlow) {
    const z = zipFor(officialSlow[1]);
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': z.length });
      res.end();
      return;
    }
    const range = req.headers.range;
    if (range) {
      const start = Number((/bytes=(\d+)-/.exec(range) || [])[1] || 0);
      const end = Number((/bytes=\d+-(\d+)/.exec(range) || [])[1] || z.length - 1);
      const body = z.subarray(start, Math.min(end + 1, z.length));
      res.writeHead(206, {
        'content-type': 'application/zip',
        'content-length': body.length,
        'content-range': `bytes ${start}-${start + body.length - 1}/${z.length}`,
      });
      res.end(body);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': z.length });
    return; // 永不结束、也不发字节 → 客户端 stall
  }

  // 官方「先给 40% 再断、之后一律 500」：用来打「**中途换源必须从头下**」。
  // 有字节流进来的时候我们**不换源**（CEO 口径：不是一慢就切），但重连撞上 500 就算这一源不可用。
  const officialFlaky = /^\/flaky-official\/([\d.]+)\/win64\/chrome-win64\.zip$/.exec(p);
  if (officialFlaky) {
    const z = zipFor(officialFlaky[1]);
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': z.length });
      res.end();
      return;
    }
    const range = req.headers.range;
    // 续传请求（`bytes=991-`，**没有结束位置**）→ 500：模拟官方这条链路彻底坏了
    if (range && /-$/.test(range)) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
      return;
    }
    // 抽段请求（`bytes=a-b`，有结束位置）→ 正常 206：装之前的交叉核验要用官方 URL 抽段
    if (range) {
      const start = Number((/bytes=(\d+)-/.exec(range) || [])[1] || 0);
      const end = Number((/bytes=\d+-(\d+)/.exec(range) || [])[1] || z.length - 1);
      const body = z.subarray(start, Math.min(end + 1, z.length));
      res.writeHead(206, {
        'content-type': 'application/zip',
        'content-length': body.length,
        'content-range': `bytes ${start}-${start + body.length - 1}/${z.length}`,
      });
      res.end(body);
      return;
    }
    // 第一条：给 40% 就断（客户端会带 Range 重连）；重连那次走上面的 500 分支
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': z.length });
    res.write(z.subarray(0, Math.floor(z.length * 0.4)));
    setTimeout(() => res.destroy(), 20);
    return;
  }

  /* ---------- 镜像侧 ---------- */
  const mirror = /^\/mirror-(ok|badlen|badhash)\/([\d.]+)\/win64\/chrome-win64\.zip$/.exec(p);
  if (mirror) {
    const [, kind, version] = mirror;
    const real = zipFor(version);
    // 记下这次镜像请求带没带 Range —— 「换源必须从头下」靠这条断言（带了就是跨源拼接）
    mirrorHits.push({ kind, version, range: req.headers.range || null });
    if (kind === 'badlen') {
      // 长度不符：少给 1 字节，且 content-length 也按少的报（这样「下完」是干净的，只有核验能抓）
      const short = real.subarray(0, real.length - 1);
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': short.length });
      res.end(short);
      return;
    }
    if (kind === 'badhash') {
      // 抽样不符：长度与官方一模一样，只改中间一个字节（只有逐段 sha256 能抓）
      const tampered = Buffer.from(real);
      tampered[Math.floor(tampered.length / 2)] ^= 0xff;
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': tampered.length });
      res.end(tampered);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': real.length });
    res.end(real);
    return;
  }

  const m = /^\/(ok|cut|mismatch|missing404|resume|stall)\/([\d.]+)\/win64\/chrome-win64\.zip$/.exec(p);
  if (!m) { res.writeHead(404); res.end('nope'); return; }
  const [, mode, version] = m;
  if (mode === 'missing404') { res.writeHead(404); res.end('not here'); return; }
  const zip = mode === 'mismatch'
    ? (zips.get('mismatch') || zips.set('mismatch', zipFor('156.0.0.0')).get('mismatch'))
    : (zips.get(version) || zips.set(version, zipFor(version)).get(version));

  if (mode === 'cut') {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.length });
    res.write(zip.subarray(0, Math.floor(zip.length / 3)));
    setTimeout(() => res.destroy(), 30); // 中途断线，且**不认 Range**（不响应续传）
    return;
  }

  // resume / stall：认 Range，用来打「断点续传」这条路（2026-11-13 真机测出 GCS 单连接越下越慢后加的）
  if (mode === 'resume' || mode === 'stall') {
    const range = req.headers.range;
    const start = range ? Number((/bytes=(\d+)-/.exec(range) || [])[1] || 0) : 0;
    const body = zip.subarray(start);
    const headers = { 'content-type': 'application/zip', 'accept-ranges': 'bytes' };
    if (range) {
      res.writeHead(206, {
        ...headers,
        'content-length': body.length,
        'content-range': `bytes ${start}-${zip.length - 1}/${zip.length}`,
      });
    } else {
      res.writeHead(200, { ...headers, 'content-length': zip.length });
    }
    if (mode === 'stall' && !range) {
      // 发一小截然后**永不结束**：客户端靠 stall 检测主动断开，重连时带 Range 续上
      res.write(body.subarray(0, 100));
      return;
    }
    if (mode === 'resume' && start === 0) {
      res.write(body.subarray(0, Math.floor(body.length * 0.4)));
      setTimeout(() => res.destroy(), 20); // 第一次只给 40% 就断
      return;
    }
    res.end(body);
    return;
  }

  res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.length });
  res.end(zip);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
BASE = `http://127.0.0.1:${server.address().port}`;

// config 在模块求值时读 env，所以先起假源再 import
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_RATE_LIMIT_MCP = '10000';
process.env.FREEPOWER_CFT_ZIP_BASE = `${BASE}/ok`;
process.env.FREEPOWER_CFT_META_URL = `${BASE}/meta/last-known-good-versions-with-downloads.json`;
process.env.FREEPOWER_CFT_VERSIONS_URL = `${BASE}/meta/known-good-versions-with-downloads.json`;
// **默认关掉镜像回落**：这个文件必须全程不联网。产品默认是 npmmirror 镜像，
// 但判据里凡是官方失败的那几条（断线 / 404 / 自检不一致）如果不关，就会真的去请求公网。
// 镜像那批用例单独用 `mirrorBase` 显式指到本地假镜像。
process.env.FREEPOWER_KERNEL_MIRROR = 'off';
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const { KERNELS_DIR } = await import('../src/config.js');
const {
  runKernelDownload, installKernel, installedExe, kernelDownloadState, lastKernelFailure,
  clearKernelDownloadCache, hooks, MSG, FIREFOX_UNSUPPORTED_MSG,
} = await import('../src/kernel/download.js');
const { listKernels } = await import('../src/kernel/chrome.js');
const { createApiServer } = await import('../src/api/server.js');

// 假源里的 chrome.exe 是文本占位：按文件内容报版本（mismatch 那份故意报 156.0.0.0）
hooks.verifyExe = (exe) => {
  const m = /FAKE_CHROME ([\d.]+)/.exec(fs.readFileSync(exe, 'utf8'));
  if (!m) throw new Error('假 chrome.exe 内容不对');
  return m[1];
};

const { server: apiServer, apiKey } = createApiServer();
await new Promise((r) => apiServer.listen(0, '127.0.0.1', r));
const apiBase = `http://127.0.0.1:${apiServer.address().port}`;

async function api(body) {
  const res = await fetch(`${apiBase}/api/v2/browser-profile/download-kernel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-key': apiKey, 'x-freepower-client': 'mcp' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

/** 轮询端点直到不再 pending/downloading/installing */
async function pollUntilSettled(version, ms = 15000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = (await api({ kernel_type: 'Chrome', kernel_version: version })).json;
    const st = last?.data?.status;
    if (st === 'completed') return last;
    if (st !== 'pending' && st !== 'downloading' && st !== 'installing') return last;
    await sleep(40);
  }
  return last;
}

/** 等后台任务失败落账（失败后 inflight 立刻清空，只能看 lastKernelFailure） */
async function waitFailure(version, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const f = lastKernelFailure(version);
    if (f) return f;
    await sleep(25);
  }
  return null;
}

/**
 * 等**当前这个**后台任务自己结束（成功或失败），**不调 API**。
 *
 * 为什么不能拿 `pollUntilSettled` 等：那个走 HTTP 路由，路由不带 `mirrorBase`（用全局配置），
 * 任务一失败它就**再触发一次下载** —— 而测试里全局 `CFT_ZIP_BASE` 指在假源的 `/ok` 目录，
 * 于是重试那次会走 `/ok` 成功，把「镜像回落」的断言污染成 `source:official`。
 * 这里只读进程内状态表，不产生副作用。
 */
async function waitJob(version, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const st = kernelDownloadState(version);
    if (st?.status === 'completed') return { ok: true, state: st };
    // 成功分支会把 inflight 里那条**删掉**（只留盘上的东西），所以「装好了」才是成功判据
    if (installedExe(version, KERNELS_DIR)) return { ok: true, state: st };
    if (!st) {
      const f = lastKernelFailure(version);
      if (f) return { ok: false, failure: f };
    }
    await sleep(25);
  }
  return { ok: false, failure: lastKernelFailure(version), timeout: true };
}

const tmpLeftovers = () => (fs.existsSync(KERNELS_DIR)
  ? fs.readdirSync(KERNELS_DIR).filter((n) => n.startsWith('.tmp-'))
  : []);

try {
  /* -------------------- A1 正常下载 -------------------- */
  const V1 = '157.0.8103.78';
  const first = await api({ kernel_type: 'Chrome', kernel_version: V1 });
  check('A1 触发下载：code 0 + status pending + progress 0，且**没有** msg（分支 B）',
    first.json.code === 0 && first.json.data?.status === 'pending' && first.json.data?.progress === 0 && !('msg' in first.json),
    JSON.stringify(first.json));

  const settled = await pollUntilSettled(V1);
  check('A1 轮询到 completed', settled?.code === 0 && settled?.data?.status === 'completed', JSON.stringify(settled));
  // 0.4.1 起 completed 的 data 多了 `source` / `mirror_verified`（CEO 2026-11-13 批的镜像口径：
  // 要如实告诉调用方「这份是谁给的、镜像的字节有没有对回官方」）。键集合钉死，防止再悄悄加键。
  check('A1 completed 的 data 键集合 = status + source + mirror_verified（走官方 → official / false）',
    JSON.stringify(Object.keys(settled?.data || {})) === '["status","source","mirror_verified"]'
      && settled?.data?.source === 'official' && settled?.data?.mirror_verified === false,
    JSON.stringify(settled?.data));

  const exe = path.join(KERNELS_DIR, V1, 'chrome.exe');
  check('A1 落盘 <kernels>/<版本>/chrome.exe（chrome-win64/ 那层被剥掉）',
    fs.existsSync(exe) && !fs.existsSync(path.join(KERNELS_DIR, V1, 'chrome-win64')),
    exe);
  check('A1 同一份 zip 里的 chrome.dll / locales 也解出来了',
    fs.existsSync(path.join(KERNELS_DIR, V1, 'chrome.dll')) && fs.existsSync(path.join(KERNELS_DIR, V1, 'locales', 'en-US.pak')));

  const k = listKernels({ type: 'chrome' });
  check('A1 kernels 列表认账（is_downloaded:true，且只有三个键）',
    k.some((x) => x.kernel === V1 && x.is_downloaded === true && Object.keys(x).length === 3),
    JSON.stringify(k.find((x) => x.kernel === V1)));
  check('A1 没有 .tmp-* 残留', tmpLeftovers().length === 0, tmpLeftovers().join(','));

  /* -------------------- A5 幂等 -------------------- */
  const again = await api({ kernel_type: 'Chrome', kernel_version: V1 });
  check('A5 已装再调：completed + msg:"success"（分支 A），data 键集合与 A1 相同',
    again.json.code === 0 && again.json.data?.status === 'completed' && again.json.msg === 'success'
      && JSON.stringify(Object.keys(again.json.data)) === '["status","source","mirror_verified"]',
    JSON.stringify(again.json));

  const partial = await api({ kernel_type: 'Chrome', kernel_version: '157' });
  check('A5 短版本 "157" 解析到已装的具体版本 → completed（不重下）',
    partial.json.code === 0 && partial.json.data?.status === 'completed', JSON.stringify(partial.json));

  /* -------------------- A3 大小写 -------------------- */
  const lower = await api({ kernel_type: 'chrome', kernel_version: '157' });
  check('A3 kernel_type 大小写敏感："chrome" → 契约文案，响应里没有 data 键',
    lower.json.code === -1 && lower.json.msg === MSG.BAD_TYPE && !('data' in lower.json),
    JSON.stringify(lower.json));

  /* -------------------- A4 Firefox -------------------- */
  const ff = await api({ kernel_type: 'Firefox', kernel_version: '157' });
  check('A4 Firefox → 明确「不支持」，不是 No matching kernel version available.',
    ff.json.code === -1 && ff.json.msg === FIREFOX_UNSUPPORTED_MSG && ff.json.msg !== MSG.NO_KERNEL
      && /not supported/i.test(ff.json.msg) && !('data' in ff.json),
    ff.json.msg);

  /* -------------------- 缺参 / 版本非数字 -------------------- */
  const miss1 = await api({ kernel_version: '157' });
  const miss2 = await api({ kernel_type: 'Chrome' });
  check('缺参 → kernel_type and kernel_version are required（两条都试）',
    miss1.json.msg === MSG.REQUIRED && miss2.json.msg === MSG.REQUIRED && miss1.json.code === -1,
    `${miss1.json.msg} / ${miss2.json.msg}`);

  const nan = await api({ kernel_type: 'Chrome', kernel_version: 'abc' });
  const zero = await api({ kernel_type: 'Chrome', kernel_version: '0' });
  check('版本非数字 / "0" → kernel_version is not a numeric strings（契约 Number("0") 也为假）',
    nan.json.msg === MSG.BAD_VERSION && zero.json.msg === MSG.BAD_VERSION,
    `${nan.json.msg} / ${zero.json.msg}`);

  /* -------------------- 目录里没有该版本 -------------------- */
  const none = await api({ kernel_type: 'Chrome', kernel_version: '999' });
  check('目录里没有该版本 → No matching kernel version available.（同步错误，不是后台失败）',
    none.json.code === -1 && none.json.msg === MSG.NO_KERNEL, JSON.stringify(none.json));

  /* -------------------- A2 content-length 不符 -------------------- */
  const V2 = '157.0.9001.1';
  const zip2 = zipFor(V2);
  const shortFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-length' ? String(zip2.length + 500) : null) },
    body: (async function* gen() { yield zip2; })(),
  });
  let lenErr = null;
  try {
    await installKernel({ version: V2, url: `${BASE}/ok/${V2}/win64/chrome-win64.zip`, platform: 'win64' },
      { root: KERNELS_DIR, fetchImpl: shortFetch, verifyExe: hooks.verifyExe });
  } catch (e) { lenErr = e; }
  check('A2 content-length 不符 → download_length_mismatch（「下完」不算「装好」）',
    lenErr?.reason === 'download_length_mismatch' && /content-length/.test(lenErr.message), String(lenErr?.reason || lenErr));
  check('A2 失败后不留版本目录、不留 .tmp-*',
    !fs.existsSync(path.join(KERNELS_DIR, V2)) && tmpLeftovers().length === 0, tmpLeftovers().join(','));

  /* -------------------- A6 中途断线 -------------------- */
  // 断线/404/版本不一致都得换一个「坏的」zipBase：CfT 的四段版本号是直接拼 URL 的，
  // 换 base 就等于换一个假源目录，不改被测代码。
  const download = (version, mode) => runKernelDownload(
    { kernel_type: 'Chrome', kernel_version: version },
    { zipBase: `${BASE}/${mode}` },
  );

  const V3 = '157.0.9002.2';
  const cut = await download(V3, 'cut');
  const cutFail = await waitFailure(V3);
  check('A6 中途断线 → 后台失败，且状态表里没有僵尸 installing',
    cut.code === 0 && ['download_interrupted', 'download_length_mismatch'].includes(cutFail?.reason)
      && kernelDownloadState(V3) === null,
    `${cut.data?.status} / ${cutFail?.reason}`);
  check('A6 断线后不留半成品目录、不留 .tmp-*',
    !fs.existsSync(path.join(KERNELS_DIR, V3)) && tmpLeftovers().length === 0, tmpLeftovers().join(','));

  /* -------------------- 重试：失败后下一次调用重新开始 -------------------- */
  const retry = await download(V3, 'ok');
  const retryOk = await pollUntilSettled(V3);
  check('失败后重试：同一版本再调一次会重下（契约 FAIL → RE_DOWNLOAD），这次装好',
    retry.data?.status === 'pending' && retryOk?.data?.status === 'completed'
      && fs.existsSync(path.join(KERNELS_DIR, V3, 'chrome.exe')),
    `${retry.data?.status} → ${retryOk?.data?.status}`);

  /* -------------------- 版本自检不一致 -------------------- */
  const V4 = '157.0.9003.3';
  const mis = await download(V4, 'mismatch');
  const misFail = await waitFailure(V4);
  check('自检不一致（解压出来的 exe 报 156.0.0.0）→ kernel_version_mismatch，不留目录',
    mis.code === 0 && misFail?.reason === 'kernel_version_mismatch' && !fs.existsSync(path.join(KERNELS_DIR, V4)),
    String(misFail?.reason));

  /* -------------------- 404 -------------------- */
  const V5 = '157.0.9004.4';
  const nf = await download(V5, 'missing404');
  const nfFail = await waitFailure(V5);
  check('包体 404 → 后台失败 download_http_404（同步只回 pending，不假成功）',
    nf.code === 0 && nf.data?.status === 'pending' && nfFail?.reason === 'download_http_404', String(nfFail?.reason));

  /* -------------------- 断点续传 + 停顿重连（2026-11-13 真机测速后加） -------------------- */
  // 背景：本机到 storage.googleapis.com 只有 50–160 KB/s 且**单连接越下越慢**
  // （前 15s 138 KB/s，两分钟掉到 47 KB/s），209 MB 的包一条连接下不完。
  // 所以下载层改成「停顿检测 + Range 续传」；这两条钉住它真的会续、且续完的包是完整的。
  const resumeBase = `${BASE}/resume`;
  const V7 = '157.0.9006.6';
  const dl7 = await runKernelDownload(
    { kernel_type: 'Chrome', kernel_version: V7 },
    { zipBase: resumeBase },
  );
  const ok7 = await pollUntilSettled(V7, 20000);
  const hits7 = hits.get(`/resume/${V7}/win64/chrome-win64.zip`) || 0;
  const res7 = lastKernelFailure(V7);
  check('断点续传：第一次只给 40% 就断 → 带 Range 续上 → 装好（假源收到 2 次请求）',
    dl7.code === 0 && ok7?.data?.status === 'completed' && hits7 === 2 && !res7
      && fs.existsSync(path.join(KERNELS_DIR, V7, 'chrome.exe')),
    `${ok7?.data?.status} hits=${hits7} fail=${res7?.reason || 'none'}`);
  // 续出来的包必须与「一次给完的同一个包」解出来逐字节相同（不是「拼起来的坏包」）
  const expect7 = makeZip({
    'chrome-win64/chrome.exe': `FAKE_CHROME ${V7}\n`,
    'chrome-win64/chrome.dll': Buffer.alloc(2048, 7),
    'chrome-win64/locales/en-US.pak': 'pak',
  });
  const oneShot = path.join(dataDir, 'oneshot-7');
  fs.mkdirSync(oneShot, { recursive: true });
  const { extractZipBuffer } = await import('../src/kernel/zip.js');
  extractZipBuffer(expect7, oneShot, { flatten: true });
  check('续传出来的内核与「一次给完的同一个包」解出来逐字节一致（不是「拼起来的坏包」）',
    fs.readFileSync(path.join(KERNELS_DIR, V7, 'chrome.exe'))
      .equals(fs.readFileSync(path.join(oneShot, 'chrome.exe')))
    && fs.readFileSync(path.join(KERNELS_DIR, V7, 'chrome.dll'))
      .equals(fs.readFileSync(path.join(oneShot, 'chrome.dll'))));

  // 停顿：第一次发 100 字节后永不结束，客户端必须自己判卡死、断开、带 Range 重连
  const V8 = '157.0.9007.7';
  const dl8 = await runKernelDownload(
    { kernel_type: 'Chrome', kernel_version: V8 },
    { zipBase: `${BASE}/stall`, stallMs: 600, maxAttempts: 5 },
  );
  const ok8 = await pollUntilSettled(V8, 20000);
  const hits8 = hits.get(`/stall/${V8}/win64/chrome-win64.zip`) || 0;
  check('停顿检测：连接不动了主动断开重连（stall=600ms），不干等到总超时',
    dl8.code === 0 && ok8?.data?.status === 'completed' && hits8 >= 2
      && fs.existsSync(path.join(KERNELS_DIR, V8, 'chrome.exe')),
    `${ok8?.data?.status} hits=${hits8}`);

  /* -------------------- 并发只下一次 -------------------- */
  clearKernelDownloadCache();
  const V6 = '157.0.9005.5';
  const before = hits.get(`/ok/${V6}/win64/chrome-win64.zip`) || 0;
  const [c1, c2] = await Promise.all([
    api({ kernel_type: 'Chrome', kernel_version: V6 }),
    api({ kernel_type: 'Chrome', kernel_version: V6 }),
  ]);
  const st1 = c1.json.data?.status;
  const st2 = c2.json.data?.status;
  const done6 = await pollUntilSettled(V6, 20000);
  const after = hits.get(`/ok/${V6}/win64/chrome-win64.zip`) || 0;
  check('并发两次调用：只有一次真下（假源只收到 1 次请求），两次都回已知状态',
    ['pending', 'downloading'].includes(st1) && ['pending', 'downloading'].includes(st2)
      && after - before === 1 && done6?.data?.status === 'completed',
    `${st1}/${st2} hits=${after - before} final=${done6?.data?.status}`);

  /* ============================================================================
   * 镜像回落（2026-11-13 CEO 定的六条口径）—— 全部本地假源，不联网
   *
   * 口径要点（代码在 `src/kernel/download.js` 的 `downloadFromSources` / `verifyMirrorBytes`）：
   *   - 元数据只从官方取（这里的 `metaUrl` 就是假「官方」）；
   *   - **官方这一源零字节卡死 / HTTP 错误**才换镜像；字节还在流时不换（34 KB/s 那种不切）；
   *   - 换源必丢半成品（镜像收到的整包请求**不带 Range**）；
   *   - 装之前用官方 URL 随机抽 5 段 128 KB 逐段核 sha256，不符 → 删包、不装、报
   *     `kernel_mirror_verify_failed`；
   *   - 响应/落盘标记如实给 `source` 与 `mirror_verified`。
   * ========================================================================== */
  const dlMirror = (version, { official, mirror, ...rest }) => runKernelDownload(
    { kernel_type: 'Chrome', kernel_version: version },
    { zipBase: `${BASE}/${official}`, mirrorBase: `${BASE}/${mirror}`, stallMs: 700, maxAttempts: 4, ...rest },
  );

  /* M1 官方零字节卡死 → 切镜像 → 装好，且镜像整包请求不带 Range */
  const V9 = '157.0.9010.10';
  const r9 = await dlMirror(V9, { official: 'slow-official', mirror: 'mirror-ok' });
  const j9 = await waitJob(V9);
  const mh9 = mirrorHits.filter((h) => h.version === V9);
  check('镜像回落：官方零字节卡死（stall）→ 切镜像 → 装好',
    r9.code === 0 && j9.ok
      && fs.existsSync(path.join(KERNELS_DIR, V9, 'chrome.exe')),
    `${j9.ok ? 'completed' : j9.failure?.reason} 镜像请求 ${mh9.length} 次`);
  // 装好之后走一次 HTTP 路由，读它对外报的形状（此时已 installed，不会再触发下载）
  const ok9 = (await api({ kernel_type: 'Chrome', kernel_version: V9 })).json;
  check('镜像回落：completed 如实标 source=mirror + mirror_verified=true',
    ok9?.data?.source === 'mirror' && ok9?.data?.mirror_verified === true,
    JSON.stringify(ok9?.data));
  check('镜像回落：换源后**整包请求不带 Range**（半成品已丢弃，不跨源拼接）',
    mh9.length === 1 && mh9[0].range === null,
    JSON.stringify(mh9.map((h) => h.range)));

  /* M2 官方 404 → 会试镜像，但**官方拿不到包体总长就没法核验** → 不装（fail-closed） */
  const V10 = '157.0.9011.11';
  const r10 = await dlMirror(V10, { official: 'missing404', mirror: 'mirror-ok' });
  const f10 = await waitFailure(V10, 25000);
  const mh10 = mirrorHits.filter((h) => h.version === V10);
  check('镜像核验：官方包体 404 → 镜像试过，但官方拿不到总长 → 不装（宁可失败也不装没证明的东西）',
    r10.code === 0 && f10?.reason === 'kernel_mirror_verify_failed' && mh10.length >= 1
      && !fs.existsSync(path.join(KERNELS_DIR, V10)),
    `${f10?.reason} 镜像请求 ${mh10.length} 次 / ${f10?.message || ''}`.slice(0, 180));

  /* M3 镜像长度与官方不符 → 删包、不装 */
  const V11 = '157.0.9012.12';
  const r11 = await dlMirror(V11, { official: 'slow-official', mirror: 'mirror-badlen' });
  const f11 = await waitFailure(V11, 25000);
  check('镜像核验：长度与官方不符 → kernel_mirror_verify_failed，不留目录、不留 .tmp-*',
    r11.code === 0 && f11?.reason === 'kernel_mirror_verify_failed'
      && !fs.existsSync(path.join(KERNELS_DIR, V11)) && tmpLeftovers().length === 0,
    `${f11?.reason} ${tmpLeftovers().join(',')}`);

  /* M4 镜像长度对、内容改了一个字节 → 抽样 sha256 抓出来 */
  const V12 = '157.0.9013.13';
  const r12 = await dlMirror(V12, { official: 'slow-official', mirror: 'mirror-badhash' });
  const f12 = await waitFailure(V12, 25000);
  check('镜像核验：长度相同但内容被改 → 抽样 sha256 抓出 kernel_mirror_verify_failed',
    r12.code === 0 && f12?.reason === 'kernel_mirror_verify_failed'
      && !fs.existsSync(path.join(KERNELS_DIR, V12)),
    `${f12?.reason} ${f12?.message || ''}`.slice(0, 160));

  /* M5 中途换源：官方先给 40% 再断、续传撞 500 → 换镜像，且必须从头下 */
  const V13 = '157.0.9014.14';
  const r13 = await dlMirror(V13, { official: 'flaky-official', mirror: 'mirror-ok' });
  const j13 = await waitJob(V13);
  const mh13 = mirrorHits.filter((h) => h.version === V13);
  const ok13 = (await api({ kernel_type: 'Chrome', kernel_version: V13 })).json;
  check('镜像回落：官方先给 40% 再断、续传撞 500 → 换镜像后**从头下**（不带 Range）',
    r13.code === 0 && j13.ok && ok13?.data?.source === 'mirror'
      && mh13.length === 1 && mh13[0].range === null,
    `${JSON.stringify(ok13?.data)} 镜像请求 ${JSON.stringify(mh13.map((h) => h.range))}`);
  // 装出来的必须与「一次给完的同一个包」逐字节相同 —— 证明没把两个源的字节拼在一起
  const { extractZipBuffer: unzip } = await import('../src/kernel/zip.js');
  const oneShot13 = path.join(dataDir, 'oneshot-13');
  fs.mkdirSync(oneShot13, { recursive: true });
  unzip(zipFor(V13), oneShot13, { flatten: true });
  check('中途换源装出来的内核与「一次给完的同一个包」逐字节一致（没有跨源拼接）',
    fs.readFileSync(path.join(KERNELS_DIR, V13, 'chrome.exe'))
      .equals(fs.readFileSync(path.join(oneShot13, 'chrome.exe'))));

  /* M6 镜像明确关掉（off）→ 官方卡死就是失败，绝不偷偷用镜像 */
  const V14 = '157.0.9015.15';
  const r14 = await runKernelDownload(
    { kernel_type: 'Chrome', kernel_version: V14 },
    { zipBase: `${BASE}/slow-official`, mirrorBase: 'off', stallMs: 700, maxAttempts: 2 },
  );
  const f14 = await waitFailure(V14, 25000);
  const mh14 = mirrorHits.filter((h) => h.version === V14);
  check('FREEPOWER_KERNEL_MIRROR=off：官方卡死 → 失败，且**一次镜像请求都没发**',
    r14.code === 0 && !!f14 && mh14.length === 0 && !fs.existsSync(path.join(KERNELS_DIR, V14)),
    `${f14?.reason} 镜像请求 ${mh14.length} 次`);

  /* M7 走官方时不带 mirror_verified，且 source=official（标记写进盘上） */
  const { readSourceMarker } = await import('../src/kernel/download.js');
  const mk9 = readSourceMarker(V9, KERNELS_DIR);
  const mk3 = readSourceMarker(V3, KERNELS_DIR);
  check('来源标记：镜像装的那份盘上记 source=mirror + mirror_verified=true；走官方的是 official',
    mk9?.source === 'mirror' && mk9?.mirror_verified === true
      && mk3?.source === 'official' && mk3?.mirror_verified === false,
    `mirror=${JSON.stringify(mk9?.source)}/${mk9?.mirror_verified} official=${JSON.stringify(mk3?.source)}/${mk3?.mirror_verified}`);
  const again9 = await api({ kernel_type: 'Chrome', kernel_version: V9 });
  check('已装的再调一次：completed 仍如实报 source=mirror（读盘上标记，不猜成 official）',
    again9.json.data?.source === 'mirror' && again9.json.data?.mirror_verified === true,
    JSON.stringify(again9.json.data));

  /* -------------------- 收尾：目录里只剩合法版本 -------------------- */
  const dirs = fs.readdirSync(KERNELS_DIR).sort();
  check('kernels 目录里只剩合法版本目录（.tmp-* 全清）',
    dirs.every((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n)) && dirs.length >= 3, dirs.join(','));
} catch (e) {
  check('内核下载测试异常', false, e.stack || e.message);
} finally {
  apiServer.close();
  server.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 句柄没放开就算了 */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(` - ${f.name}  ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
