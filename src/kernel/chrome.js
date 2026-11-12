import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { CHROME_BIN, DATA_DIR, KERNELS_DIR, START_TIMEOUT_MS } from '../config.js';
import { fingerprintView } from '../fingerprint/view.js';
import { normalizeProxyConfig } from '../proxy/probe.js';
import { mergeLaunchArgs } from './launch-args.js';

const CANDIDATE_DIRS = [
  'C:\\Program Files\\Google\\Chrome\\Application',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application'),
];

function exeIn(dir) {
  const p = path.join(dir, 'chrome.exe');
  return fs.existsSync(p) ? p : null;
}

/**
 * 读内核版本。三条路：
 * 1) 路径里就有版本号（`...\Application\<version>\chrome.exe`、内核矩阵目录）
 * 2) Windows 版 Chrome 的 chrome.exe 在 Application 根目录，版本号是同级的 `156.0.8078.80\` 目录名
 * 3) 都没有就返回 null（上层用兜底版本）
 */
function versionFromPath(exe) {
  const dirs = [path.dirname(exe), path.dirname(path.dirname(exe))];
  for (const d of dirs) {
    const base = path.basename(d);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(base)) return base;
  }
  const parent = path.dirname(exe);
  try {
    const versions = fs.readdirSync(parent)
      .filter((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n))
      .sort((a, b) => compareVersion(b, a));
    if (versions.length) return versions[0];
  } catch { /* ignore */ }
  return null;
}

/**
 * 内核解析顺序：FREEPOWER_CHROME 指定 → 内核矩阵（data/kernels/<version>/） → 系统 Chrome。
 *
 * 注意：`Application\chrome.exe` 这个启动器实际跑哪个版本由注册表决定，**和目录名不一定一致**
 * （实测目录里有 156/157 两个，启动器跑的是 156）。所以这里解析出的 version 只是「猜」，
 * 真值以启动后 Browser.getVersion 为准，并写进 data/kernel-version.json 供下次直接复用。
 */
export function findChrome() {
  const resolved = resolveChrome();
  if (!resolved) return null;
  const known = readKnownVersion();
  if (known && known.path === resolved.path) {
    return { ...resolved, version: known.version, guessed_version: resolved.version, source: `${resolved.source}+probe` };
  }
  return resolved;
}

/**
 * 本机可用的内核清单（kernels 路由用）。
 * 只报「磁盘上真的有可执行文件」的版本：系统 Chrome 的版本子目录 + 我们的内核矩阵目录。
 */
export function listKernels({ type = 'chrome' } = {}) {
  const t = String(type).toLowerCase();
  if (t !== 'chrome') return [];
  const out = [];
  const seen = new Set();
  const push = (version, exePath, source) => {
    if (!version || seen.has(`${version}|${exePath}`)) return;
    seen.add(`${version}|${exePath}`);
    out.push({ kernel_type: 'chrome', kernel: version, is_downloaded: true, path: exePath, source });
  };

  if (CHROME_BIN && fs.existsSync(CHROME_BIN)) {
    push(versionFromPath(CHROME_BIN) || 'unknown', CHROME_BIN, 'env');
  }
  if (fs.existsSync(KERNELS_DIR)) {
    for (const v of fs.readdirSync(KERNELS_DIR).filter((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x))) {
      for (const rel of ['chrome.exe', 'chrome-win64\\chrome.exe', 'chrome-win\\chrome.exe']) {
        const p = path.join(KERNELS_DIR, v, rel);
        if (fs.existsSync(p)) { push(v, p, 'kernel-matrix'); break; }
      }
    }
  }
  for (const dir of CANDIDATE_DIRS) {
    if (!dir || !fs.existsSync(dir)) continue;
    const versions = fs.readdirSync(dir).filter((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v));
    for (const v of versions) {
      const p = exeIn(path.join(dir, v));
      if (p) push(v, p, 'system');
    }
    const direct = exeIn(dir);
    if (direct) push(versionFromPath(direct) || 'unknown', direct, 'system');
  }
  const current = findChrome();
  const known = readKnownVersion();
  return out
    .map((k) => {
      const item = { ...k, in_use: !!current && current.path === k.path };
      // 目录名只是猜：同一个 chrome.exe 的版本子目录可能有多个（实测有 156/157，跑的是 156）。
      // 启动探测过就报真值，把目录猜测留在 guessed_kernel 里，别让调用方按错版本号挑内核。
      if (known && known.path === k.path && known.version !== k.kernel) {
        return { ...item, kernel: known.version, guessed_kernel: k.kernel, probed: true };
      }
      return item;
    })
    .sort((a, b) => compareVersion(b.kernel, a.kernel));
}

function resolveChrome() {
  if (CHROME_BIN && fs.existsSync(CHROME_BIN)) {
    return { path: CHROME_BIN, version: versionFromPath(CHROME_BIN), source: 'env' };
  }
  if (fs.existsSync(KERNELS_DIR)) {
    const versions = fs.readdirSync(KERNELS_DIR)
      .filter((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => compareVersion(b, a));
    for (const v of versions) {
      for (const rel of ['chrome.exe', 'chrome-win64\\chrome.exe', 'chrome-win\\chrome.exe']) {
        const p = path.join(KERNELS_DIR, v, rel);
        if (fs.existsSync(p)) return { path: p, version: v, source: 'kernel-matrix' };
      }
    }
  }
  for (const dir of CANDIDATE_DIRS) {
    if (!dir || !fs.existsSync(dir)) continue;
    const versions = fs.readdirSync(dir).filter((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v)).sort((a, b) => compareVersion(b, a));
    for (const v of versions) {
      const p = exeIn(path.join(dir, v));
      if (p) return { path: p, version: v, source: 'system' };
    }
    const direct = exeIn(dir);
    if (direct) return { path: direct, version: versionFromPath(direct), source: 'system' };
  }
  return null;
}

const KNOWN_FILE = () => path.join(DATA_DIR, 'kernel-version.json');

/** 上一次实测到的内核真实版本（启动成功后写入） */
export function readKnownVersion() {
  try {
    const j = JSON.parse(fs.readFileSync(KNOWN_FILE(), 'utf8'));
    if (j && typeof j.path === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(String(j.version))) return j;
  } catch { /* 没缓存过 */ }
  return null;
}

export function rememberVersion(exePath, version) {
  if (!exePath || !/^\d+\.\d+\.\d+\.\d+$/.test(String(version || ''))) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KNOWN_FILE(), JSON.stringify({ path: exePath, version, at: new Date().toISOString() }, null, 2));
  } catch { /* 写不进缓存不影响启动 */ }
}

export function compareVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * 启动参数：只放「参数级真实行为」的东西（UA/时区等走 CDP Emulation，不在这伪造）。
 * 返回 {args, applied, rejected, warnings}：argv 是系统基线与用户白名单参数合并后的结果。
 */
export function buildArgs(profile, { userDataDir, proxy, proxyBound = false, userArgs = [] } = {}) {
  const fp = profile.fingerprint_config || {};
  const view = fingerprintView(profile);
  const screen = view.screen || { width: 1920, height: 1080 };
  // 窗口默认比屏幕小一圈：窗口 == 屏幕是 headless 的默认形态（creepjs hasVvpScreenRes 就是查这个）
  const win = view.window || { width: screen.width, height: screen.height };

  const disableFeatures = ['Translate', 'OptimizationHints', 'MediaRouter', 'CalculateNativeWinOcclusion'];
  if (fp.webgl_config?.webgpu?.webgpu_switch === '0') disableFeatures.push('WebGPU', 'WebGPUService');

  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-service-autorun',
    // 不加 --enable-automation，并从 Blink 特性里摘掉 AutomationControlled（navigator.webdriver 的来源）
    '--disable-blink-features=AutomationControlled',
    `--lang=${view.locale || 'en-US'}`,
    `--accept-lang=${(view.language || ['en-US']).join(',')}`,
    `--window-size=${profile.window_size || `${win.width},${win.height}`}`,
    `--disable-features=${[...new Set(disableFeatures)].join(',')}`,
    '--disable-search-engine-choice-screen',
    '--hide-crash-restore-bubble',
    // 2D canvas 固定走软件光栅化：GPU 2D canvas 在「全新 profile 首次启动」和之后的启动之间
    // 会给出不同的抗锯齿/渐变像素（实测 raw PNG 都不同），跨会话就是「你换了设备」。
    // 代价：chrome://gpu 里 Canvas 显示 Software only，重 canvas 场景略慢。见 README 已知限制。
    '--disable-accelerated-2d-canvas',
  ];

  // WebRTC：只放浏览器真实支持的策略位
  if (view.webrtc === 'disabled') {
    args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp');
  } else if (view.webrtc === 'disable_udp' || view.webrtc === 'proxy' || view.webrtc === 'forward') {
    args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp');
  }

  if (profile.headless === '1' || profile.headless === '2') {
    args.push(profile.headless === '2' ? '--headless=new' : '--headless');
  }
  if (profile.window_position === 'maximize') args.push('--start-maximized');

  const warnings = [];

  /**
   * 环境兜底：在受限环境里（CI、远程会话、被别的宿主进程代起时）内核自己的 Chromium 沙箱
   * 可能起不来，症状是 Chrome 秒退（STATUS_BREAKPOINT）且从不写 DevToolsActivePort。
   * 默认**不加** —— 沙箱该开着；只有用户显式 FREEPOWER_KERNEL_NO_SANDBOX=1 才退化，并且如实标注。
   */
  if (process.env.FREEPOWER_KERNEL_NO_SANDBOX === '1') {
    args.push('--no-sandbox');
    warnings.push({
      field: 'kernel_sandbox',
      message: '内核以 --no-sandbox 启动（FREEPOWER_KERNEL_NO_SANDBOX=1）：只在沙箱起不来的受限环境用',
      severity: 'soft',
    });
  }

  /**
   * 禁用图片：Blink 层直接不请求图片（`img.complete` 恒为 false，服务器侧零请求）。
   * 视频/域名黑白名单是请求级规则，走 CDP Fetch 拦截（见 src/kernel/net-rules.js 与
   * manager.js 的 installRequestGating）—— 内核没有「不加载视频」的等价开关。
   */
  if (String(profile.disable_image) === '1') {
    args.push('--blink-settings=imagesEnabled=false');
  }

  // PAC 明确拒绝（调用方已先拦，这里是纵深防御）：PAC 的 DIRECT 回退无法 fail-closed
  if (profile.full_pac_url) {
    throw Object.assign(new Error('不支持 PAC：请改用固定 HTTP / SOCKS5 代理'), { code: 800003, reason: 'pac_unsupported' });
  }

  if (proxyBound) {
    // fail-closed 的浏览器侧：只认这一个代理，且把「本机/内网直连」的隐含 bypass 也去掉。
    // `<-loopback>` 是 Chromium 的「减掉 loopback 隐含绕过」写法；不加它就还能直连 localhost。
    args.push('--proxy-bypass-list=<-loopback>');
  }

  // 代理字段统一走 normalizeProxyConfig：AdsPower 形状是 proxy_host / proxy_port / proxy_user /
  // proxy_password，这里直读 proxy.host 会让 --proxy-server 拼不出来 —— 预检通过、内核却直连（fail-open）。
  const px = proxy ? normalizeProxyConfig(proxy) : null;
  if (proxyBound && !(px && px.host && px.port > 0)) {
    throw Object.assign(new Error('已绑定代理但代理配置不完整（host/port 为空）：拒绝以直连方式启动'), {
      code: 800003, reason: 'proxy_config_incomplete',
    });
  }
  if (px && px.host && px.port > 0) {
    const scheme = px.type === 'https' ? 'https' : px.type === 'socks5' ? 'socks5' : 'http';
    args.push(`--proxy-server=${scheme}://${px.host}:${px.port}`);
  }

  if (String(profile.is_multi_level_proxy) === '1' || String(profile.mutli_level_proxy) === '1') {
    warnings.push({
      field: 'is_multi_level_proxy',
      message: '多级代理（链式）暂未实现：只对第一跳做预检与注入，链路中间跳不可见',
      severity: 'soft',
    });
  }

  const merged = mergeLaunchArgs(args, userArgs, {
    proxyBound,
    fileExists: (p) => fs.existsSync(p),
  });
  merged.warnings.push(...warnings);
  return merged;
}

/** 等 Chrome 把 DevToolsActivePort 写出来 */
export async function waitForDevToolsPort(userDataDir, { timeoutMs = START_TIMEOUT_MS } = {}) {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const txt = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
      const port = Number(txt[0]);
      if (port > 0 && txt[1]) return { port, browserPath: txt[1] };
    } catch { /* 还没写出来 */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`Chrome 未在 ${timeoutMs}ms 内暴露 DevTools 端口：${file}`);
}

export function launchChrome(exePath, args) {
  const child = spawn(exePath, args, { stdio: 'ignore', windowsHide: false });
  child.on('error', () => { /* 由上层 waitForDevToolsPort 超时暴露 */ });
  return child;
}

/** 进程树回收：Chrome 会拉一堆子进程，只 kill 父进程会留孤儿 */
export function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch { /* 已经退出了 */ }
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  }
}
