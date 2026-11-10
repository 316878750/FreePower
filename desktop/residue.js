/**
 * 残留内核检查（只在 Windows 上有意义，其他平台返回空）。
 *
 * 为什么要单独一个文件：托盘「退出」的硬验收是「退出后查不到残留 chrome 子进程」。
 * stopAll 走的是 CDP Browser.close + taskkill 进程树，理论上够；但内核有时会先 fork
 * 出渲染进程再断 CDP，父进程死了子进程还挂在后台。这里用命令行里的数据目录做**事后核对**，
 * 是我们自己能证明「没留僵尸」的唯一手段。
 */
import { execFile } from 'node:child_process';

const PS = 'powershell.exe';

function run(file, args, env) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, env: { ...process.env, ...env }, timeout: 15000 }, (err, stdout) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || '') });
    });
  });
}

/**
 * 找出命令行里带着 matchDir 的 chrome 进程。
 * 用 PowerShell 是因为 Node 没有读进程命令行的 API，而 WMI 只给「有哪些 chrome」不给完整命令行。
 */
export async function findChromePids(matchDir) {
  if (process.platform !== 'win32' || !matchDir) return [];
  const cmd = [
    '$d=$env:FP_RESIDUE_DIR;',
    'if (-not $d) { exit 0 };',
    'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" |',
    'Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($d,[StringComparison]::OrdinalIgnoreCase) -ge 0 } |',
    'ForEach-Object { $_.ProcessId }',
  ].join(' ');
  const r = await run(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { FP_RESIDUE_DIR: matchDir });
  return r.out.split(/\s+/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number);
}

export async function killPids(pids) {
  const killed = [];
  for (const pid of pids) {
    const r = await run('taskkill', ['/PID', String(pid), '/T', '/F']);
    if (r.code === 0) killed.push(pid);
  }
  return killed;
}

/**
 * 退出前的最后一道：查 → 杀 → 再查。
 * remaining 非空就是「真的杀不掉」，调用方必须把它当成退出失败来处理，不能静默放过。
 */
export async function ensureNoChrome(matchDir, { tries = 2, waitMs = 300 } = {}) {
  const before = await findChromePids(matchDir);
  let killed = [];
  let remaining = before;
  for (let i = 0; i < tries && remaining.length; i++) {
    killed = killed.concat(await killPids(remaining));
    await new Promise((r) => setTimeout(r, waitMs));
    remaining = await findChromePids(matchDir);
  }
  return { before, killed, remaining };
}