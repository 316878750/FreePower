/**
 * FreePower 桌面壳（Electron 主进程）。
 *
 * 设计前提：**壳不重写服务**。这里在进程内起同一个 node:http（src/boot.js），
 * 窗口只是一个浏览器视图，loadURL 到 127.0.0.1:<port>/。所以四页界面、
 * Local API、静态托管全都还是原来那一份，壳塌了用户仍能用 API 兜底。
 *
 * 安全姿势：renderer 不需要任何 Node 能力 —— contextIsolation 开、nodeIntegration 关、sandbox 开。
 * **preload 只挂在主窗口上**，且只暴露 `isDesktop` 与 `openSyncPanel()` 两个东西（见 ./preload.cjs）；
 * 操作台小窗不挂 preload（它改形态走 Local API + 请求文件，不走 IPC）。
 * window.open 一律拒（同源链接交给系统浏览器），页面试图导航到别处也拦下来。
 */
// electron 是 CJS 包，ESM 下拿不到具名导出，只能整体引入再解构
import electron from 'electron';

const {
  app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog, session, globalShortcut, screen, ipcMain,
} = electron;
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureNoChrome } from './residue.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');

/**
 * preload 路径：**只给主窗口用**。
 *
 * 后缀是 `.cjs` 而不是 `.js`：`package.json` 里有 `"type": "module"`，`.js` 在 Electron 里
 * 可能被当 ESM 解析，而 sandboxed preload **只能**是 CommonJS。用 `.cjs` 把这件事钉死，
 * 不依赖 Electron 版本对「`.js` + type:module」的处理方式。
 *
 * 打包后它在 app.asar 里（preload 从 asar 加载是支持的），所以直接用 `__dirname` 拼即可。
 */
const PRELOAD_FILE = path.join(HERE, 'preload.cjs');

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
let syncPanel = null;
let syncSession = null;
let syncHotkeyOk = null;
let syncHotkeyError = '';
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
  syncSession = await import('../src/sync/session.js');
  hotkeyMod = await import('../src/sync/hotkey.js');
  displaysMod = await import('../src/sync/displays.js');
  consoleMod = await import('../src/sync/console.js');

  await app.whenReady();

  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  const started = await boot.startApiServer();
  server = started.server;
  baseUrl = started.url;
  for (const line of boot.describeStartup(started)) log(line);
  log(`desktop mode=${app.isPackaged ? 'packaged' : 'dev'} data=${DATA_DIR}`);

  createTray();
  createWindow();
  // 显示器布局交给服务进程（窗口排列要用 `workArea`，只有主进程拿得到）
  publishDisplays('startup');
  // 用户插拔显示器、改缩放、任务栏移位都要跟着更新，否则排列会算到旧布局上
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) {
    try { screen.on(ev, () => publishDisplays(ev)); } catch { /* ignore */ }
  }
  // 用上次保存的快捷键（用户改过就用改过的），没有就用默认
  const storedHotkey = hotkeyMod.readHotkeyStatus();
  registerSyncHotkey(storedHotkey.managed ? storedHotkey.accelerator : SYNC_HOTKEY_DEFAULT);
  watchHotkeyRequests();

  // 操作台：恢复上次的形态/设置/位置；主窗口「打开操作台」走这一个 IPC 通道
  const storedConsole = consoleMod.readConsoleState();
  consoleMode = consoleMod.normalizeConsoleMode(storedConsole.mode);
  consolePrefs = consoleMod.normalizeConsolePrefs(storedConsole.prefs);
  consolePos = storedConsole.rects || {};
  ipcMain.handle('fp:open-sync-panel', (event) => {
    // 只认主窗口的渲染进程：别让任意 webContents（哪怕是我们自己的操作台）拉起浮窗
    if (!win || win.isDestroyed() || event.sender !== win.webContents) {
      log('拒绝非主窗口的 open-sync-panel');
      return { ok: false, error: '只允许主窗口打开操作台' };
    }
    showSyncPanel();
    return { ok: true };
  });
  watchConsoleRequests();
  log(`console 恢复 mode=${consoleMode} open=${consolePrefs.open} auto_shrink=${consolePrefs.auto_shrink} pos=${JSON.stringify(consolePos)}`);

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
      // 只挂主窗口：暴露 isDesktop + openSyncPanel()，见 ./preload.cjs
      preload: PRELOAD_FILE,
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

/* ------------------------------ 窗口同步操作台 ------------------------------ */

/** 默认快捷键（与对手一致）；实际生效值可能被用户在面板里改过 */
const SYNC_HOTKEY_DEFAULT = process.env.FREEPOWER_SYNC_HOTKEY || 'CommandOrControl+Alt+S';
let syncHotkey = SYNC_HOTKEY_DEFAULT;
let hotkeyMod = null;
let displaysMod = null;
let consoleMod = null;
let hotkeyPoll = null;
let lastHotkeyRequestAt = null;

/**
 * 操作台的形态与位置（对手叫 Console 桌面小组件）。
 *
 * 两种形态**靠真改窗口尺寸**实现（`setBounds`），不是在一个大窗里换布局 ——
 * 展开态 430×620 始终置顶，同步时正好挡住主控窗口要点的位置；
 * 收起态 360×56 只剩一条横条。尺寸与默认值都是**我们选的**（对手无证据，README 已标）。
 */
let consoleMode = 'expanded';
let consolePrefs = { open: true, auto_shrink: true };
/** 两种形态各记各的左上角（共用会让「收起 → 展开」每次都跳位置） */
let consolePos = {};
let consolePoll = null;
let consoleReqAt = null;
let consoleHeartbeatAt = 0;
let lastSyncRunning = false;
let autoCollapsed = false;
let consoleSaveTimer = null;

/**
 * 面板是**独立小窗 + 始终置顶**，且同步过程中**绝不 focus()** ——
 * 用户正在主窗口里打字，面板一抢焦点，按键就打到面板上，整个同步当场废掉。
 * 所以显示一律走 `showInactive()`：出现、但不抢焦点。
 */
function syncPanelUrl(extra = '') {
  return `${baseUrl}#/sync-panel${extra ? `?${extra}` : ''}`;
}

function consoleSize(mode) {
  return consoleMod?.consoleSizeOf ? consoleMod.consoleSizeOf(mode) : (mode === 'collapsed' ? { width: 360, height: 56 } : { width: 430, height: 620 });
}

function safeDisplays() {
  try { return screen.getAllDisplays(); } catch { return []; }
}

/** 当前该用哪个 rect：有保存值且还在屏幕上就用保存的，否则回主屏居中（纯函数在 src/sync/console.js） */
function pickRect(mode) {
  const saved = consolePos[mode] || null;
  if (consoleMod?.pickConsoleRect) {
    return consoleMod.pickConsoleRect({ saved, displays: safeDisplays(), mode });
  }
  const size = consoleSize(mode);
  return { rect: { x: 80, y: 80, ...size }, source: 'reset', reason: 'no_module' };
}

function persistConsoleState() {
  try {
    consoleHeartbeatAt = Date.now();
    consoleMod?.writeConsoleState?.({
      mode: consoleMode,
      prefs: consolePrefs,
      rect: syncPanel && !syncPanel.isDestroyed() ? syncPanel.getBounds() : null,
      rects: consolePos,
      displays_count: safeDisplays().length,
    });
  } catch (e) {
    log('console state 写入失败', e && e.message ? e.message : String(e));
  }
}

/**
 * 切换形态：**真改窗口尺寸**（`setBounds`），改完**回读**（CEO 的硬约束：改窗口必回读验证）。
 *
 * 两个坑：
 *   · `setBounds` 受最小尺寸约束 —— 收起态 360×56 会被展开态的 `minWidth 380` 挡住，
 *     所以先把最小尺寸降下来，再 setBounds；
 *   · 收起态不许用户拉大（`setResizable(false)`），否则一拉就露馅成一个奇怪的大窗。
 */
function applyConsoleMode(mode, reason = 'manual') {
  consoleMode = consoleMod?.normalizeConsoleMode ? consoleMod.normalizeConsoleMode(mode) : (mode === 'collapsed' ? 'collapsed' : 'expanded');
  if (!syncPanel || syncPanel.isDestroyed()) { persistConsoleState(); return null; }
  const pick = pickRect(consoleMode);
  try {
    syncPanel.setResizable(consoleMode === 'expanded');
    if (consoleMode === 'collapsed') syncPanel.setMinimumSize(320, 48);
    else syncPanel.setMinimumSize(380, 420);
    syncPanel.setBounds(pick.rect);
    const got = syncPanel.getBounds();
    const ok = Math.abs(got.width - pick.rect.width) <= 2 && Math.abs(got.height - pick.rect.height) <= 2;
    consolePos[consoleMode] = { x: got.x, y: got.y };
    log(`console mode=${consoleMode} reason=${reason} source=${pick.reason} want=${pick.rect.width}x${pick.rect.height}@${pick.rect.x},${pick.rect.y} got=${got.width}x${got.height}@${got.x},${got.y} ${ok ? 'ok' : 'MISMATCH'}`);
  } catch (e) {
    log('console setBounds 失败', e && e.message ? e.message : String(e));
  }
  persistConsoleState();
  return syncPanel.getBounds();
}

function createSyncPanel(extra = '') {
  const size = consoleSize(consoleMode);
  syncPanel = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: consoleMode === 'collapsed' ? 320 : 380,
    minHeight: consoleMode === 'collapsed' ? 48 : 420,
    show: false,
    title: 'FreePower 窗口同步操作台',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: consoleMode === 'expanded',
    minimizable: false,
    maximizable: false,
    backgroundColor: '#171a1f',
    icon: assetPath('tray.png'),
    // 操作台小窗**不挂 preload**：它要改形态走 Local API + 请求文件，不走 IPC
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  syncPanel.setAlwaysOnTop(true, 'floating');
  syncPanel.loadURL(syncPanelUrl(extra));
  // 关面板 = 收起来，不销毁（同步可能还在跑，状态得留着）
  syncPanel.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    syncPanel.hide();
  });
  syncPanel.on('closed', () => { syncPanel = null; });

  /** 用户拖动 / 拉大 → 记住这个形态的位置（400ms 防抖，拖的过程不写盘） */
  const remember = () => {
    if (consoleSaveTimer) clearTimeout(consoleSaveTimer);
    consoleSaveTimer = setTimeout(() => {
      consoleSaveTimer = null;
      try {
        if (!syncPanel || syncPanel.isDestroyed()) return;
        const b = syncPanel.getBounds();
        consolePos[consoleMode] = { x: b.x, y: b.y };
        persistConsoleState();
      } catch { /* ignore */ }
    }, 400);
    consoleSaveTimer.unref?.();
  };
  syncPanel.on('moved', remember);
  syncPanel.on('resized', remember);

  syncPanel.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  // 建出来就按当前形态摆到该在的位置（保存值 / 回主屏居中）
  applyConsoleMode(consoleMode, 'create');
  return syncPanel;
}

/** 显示操作台：只出现不抢焦点（这是本条最关键的语义，别改成 show()+focus()） */
function showSyncPanel(extra = '') {
  if (!syncPanel || syncPanel.isDestroyed()) createSyncPanel(extra);
  else if (extra) syncPanel.loadURL(syncPanelUrl(extra));
  syncPanel.showInactive();
  syncPanel.setAlwaysOnTop(true, 'floating');
  return syncPanel;
}

/**
 * 轮询界面请求（收起/展开、设置、复位）并盯着「同步开始」这个时刻。
 *
 * 为什么走请求文件而不是 IPC：渲染进程没有 Node、没有 preload（**操作台小窗不挂 preload**），
 * 与快捷键同一套姿势（见 `src/sync/hotkey.js`）。400ms 的延迟对「点收起」这种低频操作够用。
 *
 * 自动收起（`automaticShrink`）在这里生效：**同步从没跑变成在跑的那一下**，按设置进收起态。
 * 只在状态跳变时动手 —— 用户手动展开后不会被下一轮轮询又收回去。
 */
function watchConsoleRequests() {
  consolePoll = setInterval(() => {
    try {
      const req = consoleMod?.readConsoleRequest?.();
      if (req && req.at !== consoleReqAt) {
        consoleReqAt = req.at;
        if (req.prefs) {
          consolePrefs = req.prefs;
          log(`console prefs → open=${consolePrefs.open} auto_shrink=${consolePrefs.auto_shrink}`);
        }
        if (req.reset_position === true) {
          consolePos = {};
          log('console 复位位置 → 主屏居中');
        }
        if (req.mode && req.mode !== consoleMode) {
          if (!syncPanel || syncPanel.isDestroyed()) showSyncPanel();
          applyConsoleMode(req.mode, 'request');
        } else if (req.reset_position === true) {
          applyConsoleMode(consoleMode, 'reset_position');
        } else {
          persistConsoleState();
        }
      }

      let running = false;
      try { running = !!syncSession?.getSession?.(); } catch { running = false; }
      if (running && !lastSyncRunning) {
        lastSyncRunning = true;
        if (!consolePrefs.open) {
          // 「操作台」关掉 = 同步开始时不弹这个小组件
          if (syncPanel && !syncPanel.isDestroyed()) syncPanel.hide();
          log('console: 操作台已关闭，同步开始时不显示');
        } else if (consolePrefs.auto_shrink) {
          showSyncPanel();
          applyConsoleMode('collapsed', 'auto_shrink');
          autoCollapsed = true;
        }
      } else if (!running && lastSyncRunning) {
        lastSyncRunning = false;
        if (autoCollapsed) {
          autoCollapsed = false;
          applyConsoleMode('expanded', 'auto_restore');
          log('console: 同步结束，恢复展开态');
        }
      }

      // 心跳：状态文件太旧界面会以为「没有桌面壳在管」
      if (Date.now() - consoleHeartbeatAt > 10000) persistConsoleState();
    } catch (e) {
      log('console 轮询失败', e && e.message ? e.message : String(e));
    }
  }, 400);
  consolePoll.unref?.();
}

/**
 * 把显示器布局写给服务进程（跨进程走文件，理由见 `src/sync/displays.js`）。
 *
 * **只写 `workArea` 那一份**：`bounds` 含任务栏，拿它当原点排窗口会把窗口压在任务栏底下
 * （CEO 明确要求过）。插拔显示器 / 改缩放时会连着触发好几个事件，这里合并 300ms 再写一次，
 * 免得同一个瞬间写五遍。
 */
let displayTimer = null;
function publishDisplays(reason) {
  if (displayTimer) return;
  displayTimer = setTimeout(() => {
    displayTimer = null;
    try {
      const list = screen.getAllDisplays();
      const okWrite = displaysMod?.writeDisplays?.(list);
      log(`displays ${reason} → ${list.length} 块屏 ${okWrite ? 'ok' : 'FAILED'}`
        + ` ${list.map((d) => `${d.id}:${d.workArea.width}x${d.workArea.height}@${d.workArea.x},${d.workArea.y}${d.primary ? '*' : ''}`).join(' ')}`);
    } catch (e) {
      log('displays 写入失败', e && e.message ? e.message : String(e));
    }
  }, 300);
  displayTimer.unref?.();
}

/**
 * 自检读数：服务进程到底读到了几块屏（不是「我写了没」，是「对面读到了没」）。
 * 两边对不上就说明文件交接坏了，窗口排列会退化成按原点算。
 */
function displayModuleStatus() {
  const r = displaysMod?.readDisplays?.() || { managed: false, displays: [] };
  return { managed: r.managed === true, count: (r.displays || []).length };
}

/**
 * 注册全局快捷键。注册失败**不许静默**：用户按了没反应会以为功能坏了，
 * 所以把结果写进 status 文件（界面读得到），面板上显示「快捷键注册失败，请在这里改一个」。
 * `Ctrl+Alt+S` 在装了 AdsPower 的机器上大概率被占（实测 RegisterHotKey err=1409）。
 */
function registerSyncHotkey(accelerator) {
  const want = accelerator || syncHotkey || SYNC_HOTKEY_DEFAULT;
  try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
  syncHotkeyError = '';
  try {
    syncHotkeyOk = globalShortcut.register(want, () => {
      toggleSyncFromHotkey().catch((e) => log('hotkey 失败', e.message));
    });
    if (!syncHotkeyOk) syncHotkeyError = '快捷键已被其他程序占用（可能是 AdsPower）';
  } catch (e) {
    syncHotkeyOk = false;
    syncHotkeyError = e && e.message ? e.message : String(e);
  }
  syncHotkey = want;
  log(`sync hotkey ${want} → ${syncHotkeyOk ? 'ok' : 'FAILED ' + syncHotkeyError}`);
  try { hotkeyMod?.writeHotkeyStatus({ accelerator: want, ok: syncHotkeyOk, error: syncHotkeyError || null }); } catch { /* ignore */ }
  if (!syncHotkeyOk && syncPanel && !syncPanel.isDestroyed()) {
    // 已经开着面板：立刻把失败提示带进去
    syncPanel.loadURL(syncPanelUrl('shortcut=failed'));
  }
  refreshMenu();   // 托盘里的文案要跟着变
}

/**
 * 用户可能在面板里改快捷键：轮询请求文件（跨进程不走 IPC，见 `src/sync/hotkey.js`）。
 * 1500ms 的轮询对「点保存」这种低频操作绰绰有余，也不值得为它开 IPC。
 */
function watchHotkeyRequests() {
  hotkeyPoll = setInterval(() => {
    try {
      const req = hotkeyMod?.readHotkeyRequest?.();
      if (!req?.accelerator) return;
      if (req.at === lastHotkeyRequestAt) return;
      lastHotkeyRequestAt = req.at;
      if (req.accelerator === syncHotkey && syncHotkeyOk) return;
      log(`hotkey 请求改为 ${req.accelerator}`);
      registerSyncHotkey(req.accelerator);
      if (syncPanel && !syncPanel.isDestroyed()) syncPanel.loadURL(syncPanelUrl(syncHotkeyOk === false ? 'shortcut=failed' : ''));
    } catch (e) {
      log('hotkey 轮询失败', e.message);
    }
  }, 1500);
  hotkeyPoll.unref?.();
}

/**
 * 快捷键语义：同步在跑 → 停；没在跑 → 把面板拿出来让用户选窗口。
 * **不自动开始**：主窗口是谁、受控窗口有哪些，只有用户知道（猜错就是把输入发到别人窗口）。
 */
async function toggleSyncFromHotkey() {
  let running = false;
  try { running = !!syncSession?.getSession(); } catch { /* ignore */ }
  if (running) {
    await syncSession.stopSync();
    log('hotkey: 已停止窗口同步');
    return;
  }
  showSyncPanel(syncHotkeyOk === false ? 'shortcut=failed' : '');
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
    {
      label: syncHotkeyOk === false ? '窗口同步操作台（快捷键不可用）' : `窗口同步操作台（${syncHotkey.replace('CommandOrControl', 'Ctrl')}）`,
      click: () => showSyncPanel(syncHotkeyOk === false ? 'shortcut=failed' : ''),
    },
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
  try { if (hotkeyPoll) clearInterval(hotkeyPoll); } catch { /* ignore */ }
  try { if (consolePoll) clearInterval(consolePoll); } catch { /* ignore */ }
  try { if (consoleSaveTimer) clearTimeout(consoleSaveTimer); } catch { /* ignore */ }
  try { ipcMain.removeHandler('fp:open-sync-panel'); } catch { /* ignore */ }
  try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
  try { if (syncPanel && !syncPanel.isDestroyed()) syncPanel.destroy(); } catch { /* ignore */ }
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

  // 同步面板：必须「出现但不抢焦点」。这几条只记录、不参与 ok ——
  // 无头/远程会话里窗口焦点语义不稳定，拿它当硬闸会造出假失败。
  steps.sync_hotkey = syncHotkey;
  steps.sync_hotkey_ok = syncHotkeyOk;
  try {
    // 窗口排列要用显示器可用区：这条读数证明服务进程真拿到了桌面壳写的布局
    const r = displayModuleStatus();
    steps.displays_managed = r.managed;
    steps.displays_count = r.count;
  } catch (e) {
    steps.displays_error = e && e.message ? e.message : String(e);
  }
  try {
    const p = showSyncPanel(syncHotkeyOk === false ? 'shortcut=failed' : '');
    await new Promise((r) => setTimeout(r, 600));
    steps.sync_panel_created = !!p && !p.isDestroyed();
    steps.sync_panel_visible = !!p && p.isVisible();
    steps.sync_panel_always_on_top = !!p && p.isAlwaysOnTop();
    steps.sync_panel_focused_after_show = !!p && p.isFocused();   // 期望 false
  } catch (e) {
    steps.sync_panel_error = e && e.message ? e.message : String(e);
  }

  // 操作台（桌面小组件）：两种形态是不是**真改窗口尺寸**、位置校验会不会把窗口拽回屏幕内。
  // 本机 agent shell 里 Electron 起不来（0x80000003），这类环境下面这些条目报 skip，不报失败。
  steps.console = { skipped: true, reason: 'no_panel' };
  if (syncPanel && !syncPanel.isDestroyed()) {
    const c = { skipped: false };
    steps.console = c;
    const startMode = consoleMode;
    const got = (mode, reason) => {
      const r = applyConsoleMode(mode, reason);
      return r || (syncPanel && !syncPanel.isDestroyed() ? syncPanel.getBounds() : null);
    };
    try {
      const exGot = got('expanded', 'selftest');
      await new Promise((r) => setTimeout(r, 300));
      const exReal = syncPanel.getBounds();
      c.expanded = { want: consoleMod.CONSOLE_EXPANDED, got: exReal, readback: exGot };
      const coGot = got('collapsed', 'selftest');
      await new Promise((r) => setTimeout(r, 300));
      const coReal = syncPanel.getBounds();
      c.collapsed = { want: consoleMod.CONSOLE_COLLAPSED, got: coReal, readback: coGot };
      // 收起态必须**真的**矮 —— 只换布局不改尺寸的话这条会红
      c.collapsed_shorter = coReal.height < exReal.height;
      c.collapsed_matches = coReal.height === consoleMod.CONSOLE_COLLAPSED.height
        && coReal.width === consoleMod.CONSOLE_COLLAPSED.width;
      c.expanded_matches = exReal.width === consoleMod.CONSOLE_EXPANDED.width
        && exReal.height === consoleMod.CONSOLE_EXPANDED.height;
      c.collapsed_not_resizable = syncPanel.isResizable() === false;

      const displays = safeDisplays();
      const primary = displays.find((d) => d.primary === true) || displays[0] || null;
      const wa = (primary && primary.workArea) || { x: 0, y: 0, width: 1920, height: 1080 };
      c.displays_count = displays.length;
      // 位置记忆：屏幕上能看见的点，校验后应当沿用保存值
      const kept = consoleMod.pickConsoleRect({ saved: { x: wa.x + 40, y: wa.y + 40 }, displays, mode: 'collapsed' });
      c.pos_kept = { source: kept.source, reason: kept.reason };
      // 副屏拔掉 / 缩放变化：保存值落在屏幕外 → 必须回主屏居中
      const offSaved = { x: wa.x + 3000, y: wa.y + 3000 };
      const off = consoleMod.pickConsoleRect({ saved: offSaved, displays, mode: 'collapsed' });
      c.pos_off_screen = { source: off.source, reason: off.reason, rect: off.rect };
      // 真窗口版：把保存位置写成屏幕外，再走一次形态应用，窗口必须回到可见区
      consolePos.collapsed = offSaved;
      const back = got('collapsed', 'selftest_offscreen');
      const backReal = syncPanel.getBounds();
      c.off_screen_recovered = !!backReal
        && backReal.x >= wa.x && backReal.y >= wa.y
        && backReal.x + backReal.width <= wa.x + wa.width
        && backReal.y + backReal.height <= wa.y + wa.height;
      c.off_screen_bounds = { saved: offSaved, got: backReal, readback: back };
      // 自动收起的默认值（对手无证据，是我们选的 true）
      c.prefs_default = consoleMod.DEFAULT_CONSOLE_PREFS;
      c.auto_shrink_default_on = consoleMod.DEFAULT_CONSOLE_PREFS.auto_shrink === true;
    } catch (e) {
      c.error = e && e.message ? e.message : String(e);
    }
    // 自检不能把用户的形态改掉：跑完回到进来时的样子
    try { applyConsoleMode(startMode, 'selftest_restore'); } catch { /* ignore */ }
  }

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