/**
 * 扩展加载（内核侧）。**这里改过方案，先把实测记录写清楚**，别让后来人按老文档改回去。
 *
 * ## 2026-11-14 实测（真内核 Google Chrome 157.0.8103.78，本机）
 *
 * 1. **`--load-extension` 已经彻底没用**。四组隔离对照（每次全新 `--user-data-dir`）：
 *    ```
 *    A  --load-extension + --disable-extensions-except                   → 没装进来
 *    B  A + --disable-features=DisableLoadExtensionCommandLineSwitch     → 没装进来
 *    C  只 --load-extension + 关特性开关                                  → 没装进来
 *    D  B + --enable-unsafe-extension-debugging                          → 没装进来
 *    ```
 *    读数方式：`Target.getTargets` 里没有该扩展的 service_worker，且
 *    `Default/Preferences` 的 `extensions.settings` 里没有条目。
 *    → `src/kernel/launch-args.js` 里那两条白名单（及其「Chrome 137+ 要关特性开关」的说法）
 *      在 157 上只是**静默空转**：参数进了命令行、用户以为装上了、实际没有。
 *      本版起改为**明确拒绝并提示改用应用中心**，不再假装成功。
 *
 * 2. **能用的路是 CDP `Extensions.loadUnpacked`**（Chrome 126+ 的 Extensions 域）：
 *    ```
 *    Extensions.loadUnpacked { path } → { id: "ejlcoabbkkleleoeihhipbeaicabpnfa" }
 *    ```
 *    - **不需要** `--enable-unsafe-extension-debugging`：带不带都返回同一个 id（实测两组）。
 *      所以产品不多带任何 debug 参数，命令行与以前逐字节一样。
 *    - 真生效：自造 MV3 扩展 + content script，页面 `document.documentElement` 上读到了
 *      它写的属性（不是只看「注册成功」）。
 *    - 一次装多个可以（两个扩展的 service_worker 同时在线）。
 *    - **不持久**：同一个 user-data-dir 重启后不调 `loadUnpacked`，扩展就不在
 *      （没有 service_worker、页面也没有 content script 的痕迹）。
 *      → 这正好是我们要的语义：**每次启动按环境勾选加载**，取消勾选下次启动自然就没了，
 *        不需要去 `Secure Preferences` 里改 `.extensions.settings[].path`（对手的做法）。
 *
 * 3. **扩展 ID 由加载路径派生，算法已复算出来**（见下面 `chromeIdFromPath` 的注释）：
 *    路径字符串按 **UTF-16LE** 编码做 sha256、前 16 字节 → `a-p`。
 *    所以导入时就能显示 Chrome 里那个 ID；启动后 CDP 报回来的值再核一遍，
 *    对不上说明目录被搬动/改名过（别的地方依赖这个 ID 稳定）。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * 由**加载路径**推算 Chrome 扩展 ID。
 *
 * 算法是实测反推出来的（不是猜）：对同一批扩展，把路径按几种编码/写法各算一遍
 * sha256、取前 16 字节、hex 的 `0-9a-f` 映射成 `a-p`，只有一种和 CDP 返回的真值一致 ——
 * **路径字符串按 UTF-16LE 编码**（Windows 原生宽字符串），两种目录都对上：
 * ```
 * <数据根>\ext_env\mark  → ejlcoabbkkleleoeihhipbeaicabpnfa   ✅ utf16le 命中
 * <数据根>\ext_env\hello → dfcmapjnbhkkbmdphgifkdmbfgjcepek  ✅ utf16le 命中
 * ```
 * 所以产品能在导入时就显示「这个扩展在 Chrome 里的 ID」，不用等启动。
 *
 * 但要说清楚：**ID 是路径的函数**。数据目录一搬（换盘、换成便携版路径），ID 就变 ——
 * `path` 一变，扩展就在浏览器眼里变成了另一个扩展（它的 localStorage/存储也跟着分家）。
 * 所以 `ext_env/<id>` 目录名不许改，数据目录也别随便搬。
 */
export function chromeIdFromPath(dir) {
  const h = crypto.createHash('sha256').update(Buffer.from(String(dir), 'utf16le')).digest();
  return [...h.subarray(0, 16)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

/** 把 `<数据根>/ext_env/<id>` 这种库内相对路径还原成绝对路径 */
export function absExtPath(dataDir, relPath) {
  return `${dataDir}${String(relPath).split('/').join('\\')}`;
}

/**
 * 把一个环境勾选的扩展逐个加载进来。
 *
 * 单个失败不中断整体（其余扩展照装），失败项**逐条回给调用方**去告警 ——
 * 不许出现「界面显示 3 个，实际只装了 2 个」这种沉默缺口。
 *
 * @param {{send:Function}} client 浏览器级 CDP 客户端
 * @param {{id:string,name:string,dir:string}[]} extensions
 * @returns {Promise<{loaded:{ext_id:string,chrome_id:string,name:string,dir:string}[],
 *                    failed:{ext_id:string,name:string,dir:string,error:string}[]}>}
 */
export async function loadUnpackedExtensions(client, extensions) {
  const loaded = [];
  const failed = [];
  for (const e of extensions || []) {
    const dir = e.dir || e.path;
    if (!dir || !fs.existsSync(dir)) {
      failed.push({ ext_id: e.id, name: e.name, dir, error: '目录不存在' });
      continue;
    }
    try {
      const r = await client.send('Extensions.loadUnpacked', { path: dir });
      loaded.push({ ext_id: String(e.id), chrome_id: String(r?.id || ''), name: e.name, dir });
    } catch (err) {
      failed.push({ ext_id: String(e.id), name: e.name, dir, error: String(err?.message || err) });
    }
  }
  return { loaded, failed };
}
