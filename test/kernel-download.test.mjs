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

  const m = /^\/(ok|cut|mismatch|missing404)\/([\d.]+)\/win64\/chrome-win64\.zip$/.exec(p);
  if (!m) { res.writeHead(404); res.end('nope'); return; }
  const [, mode, version] = m;
  if (mode === 'missing404') { res.writeHead(404); res.end('not here'); return; }
  const zip = mode === 'mismatch'
    ? (zips.get('mismatch') || zips.set('mismatch', zipFor('156.0.0.0')).get('mismatch'))
    : (zips.get(version) || zips.set(version, zipFor(version)).get(version));

  if (mode === 'cut') {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.length });
    res.write(zip.subarray(0, Math.floor(zip.length / 3)));
    setTimeout(() => res.destroy(), 30); // 中途断线
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
  check('A1 completed 的 data 只有 status 一个键', JSON.stringify(Object.keys(settled?.data || {})) === '["status"]', JSON.stringify(settled?.data));

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
  check('A5 已装再调：completed + msg:"success"（分支 A），data 只有 status',
    again.json.code === 0 && again.json.data?.status === 'completed' && again.json.msg === 'success'
      && JSON.stringify(Object.keys(again.json.data)) === '["status"]',
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
