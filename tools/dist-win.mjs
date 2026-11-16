/**
 * `npm run dist:win` —— Windows 安装包的本机打包入口（0.4.7.2）。
 *
 * ## 为什么要包一层
 *
 * 1. **electron-builder 不认四段版本号**。它用 `semver.valid(version, true)` 校验
 *    `package.json` 的 `version`，而 semver 只有三段 —— 我们的热修版本是 `0.4.7.2`
 *    这种四段号（Windows 的 VersionInfo 本来就支持四段），于是直接报
 *    `⨯ Invalid version: "0.4.7.2"`。这层做法是：
 *      - 打包**期间**把 `package.json` 的 version 临时写成 semver 合法的 `0.4.7-2`
 *        （只改这一行，其余字节不动）；
 *      - 用 `--config.extraMetadata.version=0.4.7.2` 把**真实版本号**塞回去 ——
 *        electron-builder 在读完、校验完 package.json 之后才合并 extraMetadata，
 *        所以 asar 里的 package.json 与控制台显示的版本仍然是 0.4.7.2；
 *      - `--config.buildVersion` / `--config.buildNumber` 让 VersionInfo 的
 *        FileVersion / ProductVersion 也是 `0.4.7.2`（`buildNumber` 就是第 4 段）。
 *      - 打完**按字节还原** `package.json`，并核 sha256；还原失败就非 0 退出（不许留脏工作区）。
 *
 * 2. **本机三个坑**（README §六）：内核包不能用默认下载、7za 要包装器、缓存/临时目录
 *    不能落在工作区外。这里把三件事都设好，省得每次手抄：
 *      - `--config.electronDist=node_modules/electron/dist`
 *      - 缓存与 TMP/TEMP 指到 `.tmp/` 下
 *      - 二进制镜像走 npmmirror（可用 ELECTRON_BUILDER_BINARIES_MIRROR 覆盖）
 *
 * 3. 打完**不安装、不运行**产物（用户的机器归用户）。
 *
 * 用法：`npm run dist:win`（可选 `--dir` 只出 win-unpacked、不压 NSIS，排障用）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(ROOT, 'package.json');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();

/** `0.4.7.2` → `{ pack: '0.4.7-2', buildNumber: '2' }`；三段版本原样用 */
function packVersionOf(version) {
  const parts = String(version).trim().split('.');
  if (parts.length <= 3) return { pack: version, buildNumber: '0' };
  if (parts.length !== 4) throw new Error(`版本号只支持 3 段或 4 段：${version}`);
  return { pack: `${parts[0]}.${parts[1]}.${parts[2]}-${parts[3]}`, buildNumber: parts[3] };
}

const rawPkg = fs.readFileSync(PKG);
const originalSha = sha256(rawPkg);
const pkg = JSON.parse(rawPkg.toString('utf8'));
const version = String(pkg.version || '');
const { pack, buildNumber } = packVersionOf(version);
if (!/^\d+\.\d+\.\d+(-\d+)?$/.test(pack)) throw new Error(`算出来的打包版本号不合法：${pack}`);

const dirOnly = process.argv.includes('--dir');
const extraArgs = [
  '--win', '--x64',
  ...(dirOnly ? ['--dir'] : []),
  '--config.electronDist=node_modules/electron/dist',
  `--config.extraMetadata.version=${version}`,
  `--config.buildVersion=${version}`,
  `--config.buildNumber=${buildNumber}`,
];

const env = {
  ...process.env,
  /* 这三个**必须强制指到工作区里**，不能"沿用外面的值"：
   * 本机 makensis 在工作区外写不进 mmap（实测 Internal compiler error #12345:
   * error creating mmap the size of 131888466），7za 也一样（工作区外退出码 2）。
   * 0.4.7.2 第一次打包就是栽在「TMP 已经存在就沿用」上 —— 外面那台机器上 TMP 是
   * %LOCALAPPDATA%\Temp，于是照旧挂。所以这里一律覆盖，只允许显式设 FREEPOWER_DIST_TMP 改。 */
  ELECTRON_BUILDER_CACHE: process.env.FREEPOWER_DIST_CACHE || path.join(ROOT, '.tmp', 'eb-cache'),
  TMP: process.env.FREEPOWER_DIST_TMP || path.join(ROOT, '.tmp', 'sys-tmp'),
  TEMP: process.env.FREEPOWER_DIST_TMP || path.join(ROOT, '.tmp', 'sys-tmp'),
  ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR
    || 'https://npmmirror.com/mirrors/electron-builder-binaries/',
};
for (const k of ['ELECTRON_BUILDER_CACHE', 'TMP', 'TEMP']) fs.mkdirSync(env[k], { recursive: true });

console.log(`[dist] 版本 ${version} → 打包期用 ${pack}（buildNumber=${buildNumber}）`);
console.log(`[dist] 缓存 ${env.ELECTRON_BUILDER_CACHE}`);

/** 只改 version 这一行：其余字节（含 BOM / 缩进 / 换行）原样保留 */
function withPackVersion(text) {
  const needle = `"version": ${JSON.stringify(version)}`;
  if (!text.includes(needle)) throw new Error(`package.json 里找不到 ${needle}`);
  return text.replace(needle, `"version": ${JSON.stringify(pack)}`);
}

let code = 1;
try {
  fs.writeFileSync(PKG, withPackVersion(rawPkg.toString('utf8')), 'utf8');
  code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'), ...extraArgs], {
      cwd: ROOT, env, stdio: 'inherit',
    });
    child.on('exit', (c) => resolve(c === null ? 1 : c));
    child.on('error', (e) => { console.error('[dist] 起不来：', e.message); resolve(1); });
  });
} finally {
  fs.writeFileSync(PKG, rawPkg);
  const back = sha256(fs.readFileSync(PKG));
  if (back !== originalSha) {
    console.error(`[dist] ！！package.json 没还原成功（${originalSha} → ${back}），请立刻 git checkout -- package.json`);
    process.exit(9);
  }
  console.log('[dist] package.json 已按字节还原（sha256 一致）');
}

if (code !== 0) {
  console.error(`[dist] electron-builder 退出码 ${code}`);
  process.exit(code);
}
const out = path.join(ROOT, 'release');
const made = fs.existsSync(out)
  ? fs.readdirSync(out).filter((f) => f.endsWith('.exe')).sort()
  : [];
console.log(`[dist] 产物目录 ${out}`);
for (const f of made) console.log(`[dist]   ${f}  ${fs.statSync(path.join(out, f)).size} B`);
process.exit(0);
