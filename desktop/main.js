/**
 * FreePower 桌面壳（Electron 主进程）。
 *
 * 设计前提：**壳不重写服务**。这里在进程内起同一个 node:http（src/boot.js），
 * 窗口只是一个浏览器视图，loadURL 到 127.0.0.1:<port>/。所以四页界面、
 * Local API、静态托管全都还是原来那一份，壳塌了用户仍能用 API 兜底。
 *
 * 安全姿势：renderer 不需要任何 Node 能力 —— contextIsolation 开、nodeIntegration 关、
 * sandbox 开、不挂 preload。window.open 一律拒（同源链接交给系统浏览器），
 * 页面试图导航到别处也拦下来。
 */
// electron 是 CJS 包，ESM 下拿不到具名导出，只能整体引入再解构
import electron from 'electron';

const { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog, session } = electron;
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureNoChrome } from './residue.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');

app.setName('FreePower');
app.setAppUserModelId('com.freepower.desktop');

const ARGS = process.argv.slice(1);
const START_HIDDEN = ARGS.includes('--hidden');
const SELFTEST = ARGS.includes('--selftest');

/** 数据目录：打包后必须落在 userData（asar 里不可写），开发时允许用环境变量指定 */
const DATA_DIR = process.env.FREEPOWER_DATA || path.join(app.getPath('userData'), 'data');
process.env.FREEPOWER_DATA = DATA_DIR;
fs.mkdirSync(DATA_DIR, { recursive: true });

const LOG_FILE = path.join(DATA_DIR, 'desktop.log');

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* 日志写不进去不能挡启动 */ }
  if (!app.isPackaged) console.log(line);
}

function assetPath(...p) {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'desktop', 'assets')
    : path.join(APP_ROOT, 'desktop', 'assets');
  return path.join(base, ...p);
}

let win = null;
let tray = null;
let baseUrl = '';
let server = null;
let quitting = false;
let boot = null;
let runtime = null;
let menuLabels = [];
let poller = null;
let lastCount = -1;
let selftestSteps = null;

/* ------------------------------ 单实例 ------------------------------ */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 第二个实例：什么都不起，直接退；已有实例会在 second-instance 里把窗口拉到前台
  app.quit();
} else {
  app.on('second-instance', () => {
    log('second-instance: 拉起已有窗口');
    showWindow();
  });
  main().catch((e) => {
    log('启动失败', e && e.stack ? e.stack : String(e));
    dialog.showErrorBox('FreePower 启动失败', String(e && e.message ? e.message : e));
    app.exit(1);
  });
}

async function main() {
  boot = await import('../src/boot.js');
  runtime = await import('../src/runtime/manager.js');

  await app.whenReady();

  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  const started = await boot.startApiServer();
  server = started.server;
  baseUrl = started.url;
  for (const line of boot.describeStartup(started)) log(line);
  log(`desktop mode=${app.isPackaged ? 'packaged' : 'dev'} data=${DATA_DIR}`);

  createTray();
  createWindow();

  poller = setInterval(() => {
    const n = safeCount();
    if (n !== lastCount) {
      lastCount = n;
      refreshMenu();
      try { tray.setToolTip(`FreePower · 运行中 ${n}`); } catch { /* ignore */ }
    }
  }, 2000);
  poller.unref?.();

  // 文档/诊断用：把托盘菜单弹出来（图标在系统折叠区里时，截图和面对面对菜单都用它）
  if (ARGS.includes('--show-tray-menu')) {
    setTimeout(() => {
      try { tray.popUpContextMenu(); log('tray menu popped'); }
      catch (e) { log('popUpContextMenu 失败', e.message); }
    }, 2500).unref?.();
  }

  // 自动化验收入口：N 毫秒后走和托盘「退出」同一条路径（不给界面加任何私有通道）
  const quitAfter = ARGS.find((a) => a.startsWith('--quit-after-ms='));
  if (quitAfter) {
    const ms = Math.max(1000, Number(quitAfter.split('=')[1]) || 5000);
    log(`quit-after 定时 ${ms}ms`);
    setTimeout(() => quitApp('arg'), ms).unref?.();
  }

  if (SELFTEST) setTimeout(() => runSelfTest().catch((e) => {
    log('selftest 失败', e && e.stack ? e.stack : String(e));
    writeSelftest({ ok: false, error: String(e && e.message ? e.message : e) });
    app.exit(1);
  }), 1500);

  app.on('before-quit', (e) => {
    if (!quitting) { e.preventDefault(); quitApp('before-quit'); }
  });
  app.on('window-all-closed', () => {
    // 关窗不退出：窗口全关了就留在托盘里，等托盘「退出」
    log('window-all-closed: 保持托盘常驻');
  });
  app.on('activate', () => showWindow());
}

/* ------------------------------ 窗口 ------------------------------ */
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    title: 'FreePower',
    backgroundColor: '#171a1f',
    icon: assetPath('tray.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  Menu.setApplicationMenu(null);

  win.loadURL(baseUrl);

  win.once('ready-to-show', () => {
    if (START_HIDDEN) return;
    win.show();
    win.focus();
  });

  // 关窗 = 收进托盘，不退出、不停服务
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    log('window close → hide（服务与内核保持运行）');
  });

  // 页面里任何 window.open / target=_blank 都不许开新窗口：外链丢系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });

  // 控制台只允许停在本地服务上；导航到别处同样丢给系统浏览器
  const guard = (event, url) => {
    if (url.startsWith(baseUrl)) return;
    event.preventDefault();
    openExternal(url);
  };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-redirect', guard);

  // 不允许把 <webview> 挂进来
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());

  win.webContents.on('render-process-gone', (_e, details) => {
    log('renderer gone', JSON.stringify(details));
  });

  return win;
}

function openExternal(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(url);
    else log('拒绝打开外部协议', url);
  } catch {
    log('拒绝打开非法 URL', String(url));
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); win.once('ready-to-show', () => win.show()); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ------------------------------ 托盘 ------------------------------ */
function createTray() {
  const iconFile = assetPath('tray.png');
  const img = nativeImage.createFromPath(iconFile);
  log(`tray image ${iconFile} empty=${img.isEmpty()} size=${JSON.stringify(img.getSize())}`);
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('FreePower');
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  lastCount = safeCount();
  refreshMenu();
  // getBounds 只有图标真的注册进通知区域才有值；全 0 说明图标进了折叠区或 Shell_NotifyIcon 失败
  log(`tray bounds ${JSON.stringify(tray.getBounds())}`);
  // 万一 Shell_NotifyIcon 第一次没成（Explorer 刚重启时确实会），补一次
  setTimeout(() => {
    try {
      const b = tray.getBounds();
      if (!b || (!b.width && !b.height)) {
        log('tray bounds 仍为 0，重建一次图标');
        tray.setImage(img.isEmpty() ? nativeImage.createEmpty() : img);
        refreshMenu();
        log(`tray bounds retry ${JSON.stringify(tray.getBounds())}`);
      }
    } catch (e) { log('tray retry 失败', e.message); }
  }, 1200).unref?.();
}

function safeCount() {
  try { return runtime ? runtime.listRunning().length : 0; } catch { return 0; }
}

function loginItemOn() {
  try { return !!app.getLoginItemSettings({ path: process.execPath }).openAtLogin; } catch { return false; }
}

function refreshMenu() {
  const n = safeCount();
  const template = [
    { label: '打开控制台', click: () => showWindow() },
    { label: `运行中：${n} 个环境`, enabled: false },
    {
      label: '停止全部环境',
      enabled: n > 0,
      click: () => stopAllFromTray(),
    },
    { type: 'separator' },
    {
      label: app.isPackaged ? '开机自启' : '开机自启（打包后可用）',
      type: 'checkbox',
      checked: loginItemOn(),
      enabled: app.isPackaged,
      click: (item) => setLoginItem(item.checked),
    },
    { type: 'separator' },
    { label: '退出 FreePower', click: () => quitApp('tray') },
  ];
  menuLabels = template.map((i) => i.label || i.type);
  try { tray.setContextMenu(Menu.buildFromTemplate(template)); } catch (e) { log('tray menu 失败', e.message); }
}

async function stopAllFromTray() {
  log('tray: 停止全部环境');
  try {
    const r = await boot.shutdownRuntime();
    log(`tray: 已停止 ${r.stopped.length} 个${r.error ? '（有错误：' + r.error.message + '）' : ''}`);
    refreshMenu();
    if (win && !win.isDestroyed()) win.webContents.send?.('noop');
  } catch (e) {
    log('tray stopAll 失败', e.message);
  }
}

function setLoginItem(on) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!on,
      path: process.execPath,
      // 开机自启直接进托盘，不弹窗打断用户
      args: ['--hidden'],
    });
    log(`login item → ${on}`);
  } catch (e) {
    log('setLoginItemSettings 失败', e.message);
  }
  refreshMenu();
}

/* ------------------------------ 退出 ------------------------------ */
async function quitApp(reason) {
  if (quitting) return;
  quitting = true;
  log(`quit begin (${reason})`);

  let stopErr = null;
  let stopped = 0;
  try {
    const r = await boot.shutdownRuntime();
    stopped = r.stopped.length;
    stopErr = r.error;
  } catch (e) {
    stopErr = e;
  }
  log(`quit: stopAll → ${stopped} 个${stopErr ? '，错误 ' + stopErr.message : ''}`);

  // 硬验收：退出前确认没有残留 chrome 子进程
  let residue = { before: [], killed: [], remaining: [] };
  try {
    residue = await ensureNoChrome(DATA_DIR);
  } catch (e) {
    log('residue 检查失败', e.message);
  }
  log(`quit: chrome residue before=${residue.before.length} killed=${residue.killed.length} remaining=${residue.remaining.length}`);

  if (residue.remaining.length && !SELFTEST) {
    // 杀不掉就别装作干净退出：让用户选，默认留在托盘
    const idx = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['留在托盘', '仍然退出'],
      defaultId: 0,
      cancelId: 0,
      title: '还有内核进程没退出',
      message: `检测到 ${residue.remaining.length} 个内核进程结束不了（PID ${residue.remaining.join(', ')}）。`,
      detail: '继续退出可能留下孤儿进程；建议点「留在托盘」后手动结束这些进程再退出。',
    });
    if (idx === 0) {
      quitting = false;
      log('quit: 用户选择留在托盘');
      return;
    }
  }

  try { if (poller) clearInterval(poller); } catch { /* ignore */ }
  try { if (tray) tray.destroy(); } catch { /* ignore */ }
  try { if (server) await new Promise((r) => { server.close(r); setTimeout(r, 2000).unref(); }); } catch { /* ignore */ }

  // 自检模式：把整条链路的观测结果落盘，供外部脚本核对
  if (SELFTEST && selftestSteps) {
    selftestSteps.stopped = stopped;
    selftestSteps.stop_error = stopErr ? String(stopErr.message) : null;
    selftestSteps.residue_before = residue.before;
    selftestSteps.residue_killed = residue.killed;
    selftestSteps.residue_remaining = residue.remaining;
    selftestSteps.quit_reason = reason;
    selftestSteps.ok = !selftestSteps.window_visible_after_close
      && selftestSteps.tray_alive_after_close
      && selftestSteps.tray_host_window
      && residue.remaining.length === 0;
    writeSelftest(selftestSteps);
  }

  log('quit: done');
  app.exit(residue.remaining.length ? 1 : 0);
}

/* ------------------------------ 自检（打包验收用） ------------------------------ */
function writeSelftest(obj) {
  const file = path.join(DATA_DIR, 'desktop-selftest.json');
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...obj }, null, 2));
  log('selftest 写入', file);
}

/**
 * 这条只在 `--selftest` 下跑：把「窗口可见 → 关窗 → 托盘还在 → 退出（与托盘「退出」同一个函数）
 * → 无残留 chrome」整条链路走一遍，结果写成 JSON 供外部脚本核对。
 * 托盘图标是否出现在通知区域属于系统层，仍由外部 UI 自动化/人工看。
 */
async function runSelfTest() {
  const steps = {};
  selftestSteps = steps;
  await new Promise((r) => setTimeout(r, 1500));

  steps.version = app.getVersion();
  steps.packaged = app.isPackaged;
  steps.server_url = baseUrl;
  steps.window_visible_initial = !!win && win.isVisible();
  steps.window_title = win ? win.getTitle() : null;
  steps.tray_alive = !!tray && !tray.isDestroyed();
  steps.tray_bounds = tray ? tray.getBounds() : null;
  steps.tray_menu = menuLabels;
  steps.tray_host_window = steps.tray_alive;

  win.close();
  await new Promise((r) => setTimeout(r, 700));
  steps.window_visible_after_close = !!win && win.isVisible();
  steps.window_destroyed_after_close = !win || win.isDestroyed();
  steps.tray_alive_after_close = !!tray && !tray.isDestroyed();
  steps.server_alive_after_close = !!server && server.listening;
  steps.running_before_quit = runtime.listRunning().length;

  // 走托盘「退出」用的同一个函数
  await quitApp('selftest');
}