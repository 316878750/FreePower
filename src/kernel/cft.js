/**
 * Chrome for Testing（CfT）元数据解析 —— 内核下载的"目录服务"。
 *
 * 为什么是 CfT：对手的 `download-kernel` 下的是自家 `version.adspower.net` 上的
 * SunBrowser 二进制（逆向 `23-内核下载契约.md` §3），**我们不转发别人的构建**；
 * CfT 是 Google 官方构建，端点公开可用：
 *   - 元数据（Stable 通道 + 下载地址）：`last-known-good-versions-with-downloads.json`
 *   - 历史版本目录：`known-good-versions-with-downloads.json`
 *   - 包体：`https://storage.googleapis.com/chrome-for-testing-public/<版本>/<平台>/chrome-<平台>.zip`
 *
 * **只做 Chrome**：CfT 没有 Firefox 对应物，`download.js` 会明确回「不支持 Firefox」，
 * 不拿对手那句 `No matching kernel version available.` 糊过去（那是"目录里没有这个版本"的语义）。
 *
 * **没有官方校验串**：CfT 的元数据里**没有 sha256 字段**（实测两个 JSON 都没有）。
 * 所以这里如实返回 `checksum: null` / `checksum_source: 'none'`，由下载层用
 * content-length + 解压后的 `chrome.exe --version` 判成功；若哪天元数据里出现
 * `sha256`/`checksum`，这里会带上、下载层会校验（不用改调用方）。
 */
import { compareVersion } from './chrome.js';

/** CfT 的平台标签（Windows 只有 win32/win64；mac/linux 留着，便于以后不在 Windows 上跑） */
export function cftPlatform() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (process.platform === 'linux') return 'linux64';
  return process.arch === 'ia32' ? 'win32' : 'win64';
}

/** zip 文件名跟着平台走：chrome-win64.zip / chrome-win32.zip / chrome-mac-x64.zip … */
export function cftZipName(platform = cftPlatform()) {
  return `chrome-${platform}.zip`;
}

function pickZip(downloads, platform) {
  const list = Array.isArray(downloads?.chrome) ? downloads.chrome : [];
  const hit = list.find((d) => d && d.platform === platform && d.url);
  return hit ? String(hit.url) : '';
}

/** 元数据里的校验串（CfT 现在没有，留好口子：字段名可能叫 sha256 / checksum） */
function pickChecksum(entry) {
  const v = entry?.sha256 || entry?.checksum || '';
  return /^[0-9a-f]{64}$/i.test(String(v)) ? String(v).toLowerCase() : '';
}

/**
 * 从元数据 JSON 里抽出「版本 → 下载地址」。
 * 两种形状都吃：`{channels:{Stable:{version,downloads}}}` 与 `{versions:[{version,downloads}]}`。
 */
export function versionsFromMeta(json, platform = cftPlatform()) {
  const out = [];
  const stable = json?.channels?.Stable;
  if (stable?.version) {
    out.push({
      version: String(stable.version),
      url: pickZip(stable.downloads, platform),
      checksum: pickChecksum(stable),
    });
  }
  for (const v of Array.isArray(json?.versions) ? json.versions : []) {
    if (!v?.version) continue;
    out.push({ version: String(v.version), url: pickZip(v.downloads, platform), checksum: pickChecksum(v) });
  }
  return out.filter((x) => x.url);
}

/**
 * 在目录里找匹配的版本：`"157"` / `"157.0"` / `"157.0.8103"` 按前缀匹配最新，
 * 完整四段（`"157.0.8103.78"`）要精确命中。
 */
export function matchVersion(list, wanted) {
  const w = String(wanted ?? '').trim();
  if (!w) return null;
  const hits = list.filter((x) => x.version === w || x.version.startsWith(`${w}.`));
  if (!hits.length) return null;
  return hits.sort((a, b) => compareVersion(b.version, a.version))[0];
}

async function getJson(url, { fetchImpl, timeoutMs = 20000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ac.signal, redirect: 'follow' });
    if (!res.ok) {
      const err = new Error(`内核目录不可用：HTTP ${res.status}（${url}）`);
      err.reason = 'catalog_http_error';
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } catch (e) {
    if (e && !e.reason) {
      e.reason = ac.signal.aborted ? 'catalog_timeout' : 'catalog_unreachable';
      e.message = `读不到内核目录（${url}）：${e.cause?.code || e.message || e}`;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 请求的版本 → 具体下载地址。
 *
 * @param {{version: string}} input 版本号（1–4 段纯数字）
 * @param {{fetchImpl?: Function, metaUrl: string, versionsUrl?: string, zipBase: string,
 *          platform?: string, timeoutMs?: number}} opts
 * @returns {Promise<{version: string, url: string, platform: string, checksum: string, checksum_source: string,
 *                    source: 'direct'|'stable'|'versions'}>}
 *
 * 四段完整版本号**不查目录**：CfT 的 URL 规则稳定，省一次网络往返；
 * 查不到再说 —— 反正下载 404 会以 `download_http_404` 明确失败。
 */
export async function resolveCftKernel({ version } = {}, {
  fetchImpl = fetch, metaUrl, versionsUrl, zipBase, platform = cftPlatform(), timeoutMs,
} = {}) {
  const wanted = String(version ?? '').trim();
  const zipName = cftZipName(platform);
  const full = /^\d+\.\d+\.\d+\.\d+$/.test(wanted);

  if (full) {
    return {
      version: wanted,
      url: `${zipBase}/${wanted}/${platform}/${zipName}`,
      platform,
      checksum: '',
      checksum_source: 'none',
      source: 'direct',
    };
  }

  const meta = await getJson(metaUrl, { fetchImpl, timeoutMs });
  let hit = matchVersion(versionsFromMeta(meta, platform), wanted);
  let source = 'stable';
  if (!hit && versionsUrl) {
    const all = await getJson(versionsUrl, { fetchImpl, timeoutMs });
    hit = matchVersion(versionsFromMeta(all, platform), wanted);
    source = 'versions';
  }
  if (!hit) {
    const err = new Error('No matching kernel version available.');
    err.reason = 'kernel_not_found';
    throw err;
  }
  return {
    version: hit.version,
    url: hit.url,
    platform,
    checksum: hit.checksum,
    checksum_source: hit.checksum ? 'metadata' : 'none',
    source,
  };
}
