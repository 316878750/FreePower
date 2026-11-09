import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { CHROME_BIN, KERNELS_DIR, START_TIMEOUT_MS } from '../config.js';

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
 * P0 用系统 Chrome 跑通链路，P1 换成 CfT 矩阵（按 major 下载 118→最新）。
 */
export function findChrome() {
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
 * 注意：不加 --enable-automation，并从 Blink 特性里摘掉 AutomationControlled。
 */
export function buildArgs(profile, { userDataDir, proxy }) {
  const fp = profile.fingerprint_config || {};
  const screen = fp.screen || { width: 1920, height: 1080 };
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-service-autorun',
    '--disable-blink-features=AutomationControlled',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    `--lang=${fp.locale || 'en-US'}`,
    `--accept-lang=${(fp.language || ['en-US']).join(',')}`,
    `--window-size=${screen.width},${screen.height}`,
    '--disable-features=Translate,OptimizationHints,MediaRouter,CalculateNativeWinOcclusion',
    '--disable-search-engine-choice-screen',
    '--hide-crash-restore-bubble',
  ];
  if (proxy && proxy.host && proxy.port) {
    const scheme = proxy.proxy_type === 'https' ? 'https' : proxy.proxy_type === 'socks5' ? 'socks5' : 'http';
    args.push(`--proxy-server=${scheme}://${proxy.host}:${proxy.port}`);
  }
  return args;
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
