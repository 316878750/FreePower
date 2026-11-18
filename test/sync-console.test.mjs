/**
 * 窗口同步操作台（对手的 Console 桌面小组件）的 A 层判据：零 Chrome、零 Electron。
 *
 * 这里钉四件事，都是「改回去就废」的：
 *   1. **收起态是真改尺寸**：收起态的窗口高度必须真的小于展开态。只在大窗里换个布局 = 照样挡住主控窗口。
 *   2. **位置校验不许只信保存值**：拔副屏 / 改缩放后坐标会落到屏幕外，必须回主屏居中。
 *      这条是「窗口看不见还置顶、用户只能去任务管理器杀进程」的唯一防线。
 *   3. **收起条只放五项**，且状态词如实（没有对手那个「同步异常」的对应状态，不许硬造）。
 *   4. **preload 边界**：只暴露 `isDesktop` + `openSyncPanel()`，不许透传 `ipcRenderer`；
 *      只挂主窗口，操作台小窗不挂。
 *
 * 真窗口那一层（真 setBounds、真拔副屏）本机验不了：agent shell 里 Electron 起不来（0x80000003），
 * 那部分在 `desktop:selftest` 里报 skip，README 与升级说明另列「需要在你桌面上复验」清单。
 *
 * 跑法：npm run test:sync-console
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

// 文件交接要落盘：先指到临时目录，别污染真实数据目录
const DATA = path.join(os.tmpdir(), `fp-console-${process.pid}`);
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.FREEPOWER_DATA = DATA;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const t = (name, fn) => {
  try { fn(); check(name, true); } catch (e) { check(name, false, e?.message || String(e)); }
};

const C = await import('../src/sync/console.js');

/* ============================ 1. 两种形态 ============================ */
console.log('\n— 1. 两种形态：收起必须是真的更小 —');
t('展开态 430×620、收起态 360×56（尺寸是我们选的，不是对手原值）', () => {
  assert.deepEqual(C.CONSOLE_EXPANDED, { width: 430, height: 620 });
  assert.deepEqual(C.CONSOLE_COLLAPSED, { width: 360, height: 56 });
});
t('收起态高度**真的**小于展开态（只换布局不改尺寸的话这条会红）', () => {
  assert.ok(C.CONSOLE_COLLAPSED.height < C.CONSOLE_EXPANDED.height,
    `collapsed=${C.CONSOLE_COLLAPSED.height} expanded=${C.CONSOLE_EXPANDED.height}`);
  // 不是「小一点点」，得是小到不挡主控窗口的操作区
  assert.ok(C.CONSOLE_EXPANDED.height - C.CONSOLE_COLLAPSED.height >= 400);
});
t('收起态宽度也小于展开态', () => assert.ok(C.CONSOLE_COLLAPSED.width < C.CONSOLE_EXPANDED.width));
t('形态归一：只认 collapsed，其余都是 expanded', () => {
  assert.equal(C.normalizeConsoleMode('collapsed'), 'collapsed');
  assert.equal(C.normalizeConsoleMode('expanded'), 'expanded');
  assert.equal(C.normalizeConsoleMode('tiny'), 'expanded');
  assert.equal(C.normalizeConsoleMode(undefined), 'expanded');
  assert.equal(C.normalizeConsoleMode(null), 'expanded');
});
t('consoleSizeOf 按形态给尺寸（宽高都只由形态决定）', () => {
  assert.deepEqual(C.consoleSizeOf('collapsed'), { width: 360, height: 56 });
  assert.deepEqual(C.consoleSizeOf('expanded'), { width: 430, height: 620 });
  assert.deepEqual(C.consoleSizeOf('???'), { width: 430, height: 620 });
});
t('consoleSizeOf 返回副本（改返回值不许污染常量）', () => {
  const s = C.consoleSizeOf('collapsed');
  s.width = 9999;
  assert.equal(C.CONSOLE_COLLAPSED.width, 360);
});
t('展开态最小尺寸不许拉成一条缝', () => {
  assert.ok(C.CONSOLE_MIN_EXPANDED.width >= 300 && C.CONSOLE_MIN_EXPANDED.height >= 300);
});
t('「算还在屏幕上」的门槛是 64×24（能看见一角、能拖回来）', () => {
  assert.deepEqual(C.CONSOLE_MIN_VISIBLE, { width: 64, height: 24 });
});

/* ============================ 2. 设置归一 ============================ */
console.log('\n— 2. 操作台设置（open / auto_shrink）—');
t('自动收起默认**开**（我们的选择，对手默认值无证据）', () => {
  assert.equal(C.DEFAULT_CONSOLE_PREFS.auto_shrink, true);
  assert.equal(C.DEFAULT_CONSOLE_PREFS.open, true);
});
t('空设置 → 取默认（两个都 true）', () => {
  assert.deepEqual(C.normalizeConsolePrefs({}), { open: true, auto_shrink: true });
  assert.deepEqual(C.normalizeConsolePrefs(), { open: true, auto_shrink: true });
  assert.deepEqual(C.normalizeConsolePrefs(null), { open: true, auto_shrink: true });
});
t('显式关掉自动收起 → false（用户说了算）', () => {
  assert.equal(C.normalizeConsolePrefs({ auto_shrink: false }).auto_shrink, false);
  assert.equal(C.normalizeConsolePrefs({ open: false }).open, false);
});
t('字符串/数字写法都认（设置可能从 JSON 里读回来）', () => {
  assert.equal(C.normalizeConsolePrefs({ auto_shrink: 'true' }).auto_shrink, true);
  assert.equal(C.normalizeConsolePrefs({ auto_shrink: 'false' }).auto_shrink, false);
  assert.equal(C.normalizeConsolePrefs({ auto_shrink: 1 }).auto_shrink, true);
  assert.equal(C.normalizeConsolePrefs({ auto_shrink: 0 }).auto_shrink, false);
});
t('不认识的键丢掉（设置只留这两个）', () => {
  assert.deepEqual(Object.keys(C.normalizeConsolePrefs({ open: true, foo: 'bar' })).sort(), ['auto_shrink', 'open']);
});

/* ============================ 3. 位置校验 ============================ */
console.log('\n— 3. 位置校验：拔副屏 / 改缩放后不许留在屏幕外 —');
const primary = { id: 1, primary: true, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
// 副屏在主屏左边：x 是负数（真实布局里很常见，最容易写错）
const leftScreen = { id: 2, primary: false, workArea: { x: -1920, y: 0, width: 1920, height: 1040 } };
const rightScreen = { id: 3, primary: false, workArea: { x: 1920, y: 0, width: 1280, height: 1024 } };

t('保存值还在屏幕上 → 用保存值', () => {
  const r = C.pickConsoleRect({ saved: { x: 300, y: 200 }, displays: [primary, rightScreen], mode: 'expanded' });
  assert.equal(r.source, 'saved');
  assert.equal(r.reason, 'saved');
  assert.deepEqual(r.rect, { x: 300, y: 200, width: 430, height: 620 });
});
t('没有保存值 → 回主屏居中', () => {
  const r = C.pickConsoleRect({ saved: null, displays: [primary], mode: 'collapsed' });
  assert.equal(r.source, 'reset');
  assert.equal(r.reason, 'no_saved');
  // 主屏 1920×1040 居中放 360×56
  assert.deepEqual(r.rect, { x: 780, y: 492, width: 360, height: 56 });
});
t('副屏还在时，负坐标上的保存值照样认（别把负数当坏值）', () => {
  const r = C.pickConsoleRect({ saved: { x: -1500, y: 120 }, displays: [primary, leftScreen], mode: 'collapsed' });
  assert.equal(r.source, 'saved');
  assert.equal(r.rect.x, -1500);
});
t('**副屏被拔掉** → 同一个保存值必须回主屏居中', () => {
  const saved = { x: -1500, y: 120 };
  const gone = C.pickConsoleRect({ saved, displays: [primary], mode: 'collapsed' });
  assert.equal(gone.source, 'reset');
  assert.equal(gone.reason, 'off_screen');
  assert.deepEqual(gone.rect, { x: 780, y: 492, width: 360, height: 56 });
});
t('**缩放/分辨率变小** → 越界的保存值回主屏居中', () => {
  // 原来在 4K 屏上右下角，改回 1080p 后落到了屏幕外
  const saved = { x: 3000, y: 1800 };
  const r = C.pickConsoleRect({ saved, displays: [primary], mode: 'expanded' });
  assert.equal(r.source, 'reset');
  assert.equal(r.reason, 'off_screen');
});
t('只露出一条缝（不足 64×24）也算看不见 → 回主屏', () => {
  const r = C.pickConsoleRect({ saved: { x: 1900, y: 1030 }, displays: [primary], mode: 'collapsed' });
  assert.equal(r.source, 'reset', `露出 ${JSON.stringify(C.visibleArea({ x: 1900, y: 1030, width: 360, height: 56 }, primary.workArea))}`);
});
t('刚好露出 64×24 就算还看得见 → 保留（边界值）', () => {
  // 左边缘对齐主屏右边界减 64
  const saved = { x: 1920 - 64, y: 1040 - 24 };
  const r = C.pickConsoleRect({ saved, displays: [primary], mode: 'collapsed' });
  assert.equal(r.source, 'saved');
});
t('保存值是垃圾（NaN / 缺字段）→ bad_saved，回主屏居中', () => {
  const a = C.pickConsoleRect({ saved: { x: NaN, y: 10 }, displays: [primary], mode: 'collapsed' });
  assert.equal(a.reason, 'bad_saved');
  const b = C.pickConsoleRect({ saved: { x: 10 }, displays: [primary], mode: 'collapsed' });
  assert.equal(b.reason, 'bad_saved');
});
t('一块屏都读不到 → 给稳定值，不返回 null', () => {
  const r = C.pickConsoleRect({ saved: { x: 5, y: 5 }, displays: [], mode: 'collapsed' });
  assert.equal(r.reason, 'no_displays');
  assert.equal(r.source, 'reset');
  assert.deepEqual(r.rect, { x: 0, y: 0, width: 360, height: 56 });
});
t('没有标 primary 的布局也能兜住（取第一块）', () => {
  const r = C.pickConsoleRect({ saved: null, displays: [{ id: 9, workArea: { x: 100, y: 50, width: 800, height: 600 } }], mode: 'collapsed' });
  assert.equal(r.source, 'reset');
  assert.ok(r.rect.x >= 100 && r.rect.y >= 50);
});
t('visibleArea：没有交集就是 0×0，不许出负数', () => {
  assert.deepEqual(C.visibleArea({ x: 5000, y: 5000, width: 10, height: 10 }, primary.workArea), { width: 0, height: 0 });
  assert.deepEqual(C.visibleArea({ x: 0, y: 0, width: 100, height: 50 }, primary.workArea), { width: 100, height: 50 });
});

/* ============================ 4. 收起条内容 ============================ */
console.log('\n— 4. 收起条：只放五项，状态词如实 —');
const runningStatus = {
  running: true,
  master_id: 'abcdef1234567890',
  slave_ids: ['s1', 's2', 's3'],
  windows: [{ degraded: false }, { degraded: false }, { degraded: false }, { degraded: false }],
};
t('同步中：标题「正在同步操作」+ 主控名 + 受控数 + 停止 + 展开', () => {
  const m = C.consoleBarModel({ status: runningStatus, masterName: '主控环境' });
  assert.equal(m.title, '正在同步操作');
  assert.equal(m.master, '主控环境');
  assert.equal(m.slaves, '受控 3 个');
  assert.deepEqual(m.actions.map((a) => a.id), ['stop', 'expand']);
  assert.deepEqual(m.actions.map((a) => a.label), ['停止', '展开']);
});
t('收起条内容**只有这五项**（事件计数/快捷键/尺寸警告都不许塞进来）', () => {
  const m = C.consoleBarModel({ status: runningStatus, masterName: '主控环境' });
  assert.equal(m.items.length, 5, JSON.stringify(m.items));
  assert.deepEqual(m.items, ['正在同步操作', '主控环境', '受控 3 个', '停止', '展开']);
});
t('没在跑：标题「同步已停止」、受控 0 个、没有停止按钮', () => {
  const m = C.consoleBarModel({ status: { running: false }, masterName: '主控环境' });
  assert.equal(m.title, '同步已停止');
  assert.equal(m.slaves, '受控 0 个');
  assert.deepEqual(m.actions.map((a) => a.id), ['expand']);
  assert.equal(m.tone, 'idle');
});
t('没选主控 → 用 master_id 前 8 位，再没有就说「未选主窗口」', () => {
  assert.equal(C.consoleBarModel({ status: { running: true, master_id: 'abcdef1234567890' } }).master, 'abcdef12');
  assert.equal(C.consoleBarModel({ status: { running: true } }).master, '未选主窗口');
});
t('有窗口断连 → tone=warn + detail 说清几个，但标题仍是「正在同步操作」', () => {
  const m = C.consoleBarModel({
    status: { running: true, slave_ids: ['s1'], windows: [{ degraded: true }, { degraded: false }] },
    masterName: '主控',
  });
  assert.equal(m.tone, 'warn');
  assert.equal(m.title, '正在同步操作', 'degraded 只是某个窗口连接断了，同步还在跑，不能改标题');
  assert.match(m.detail, /有 1 个窗口连接断了/);
});
t('不硬造对手的「同步异常」状态词', () => {
  const m = C.consoleBarModel({ status: { running: true, windows: [{ degraded: true }] } });
  assert.ok(!m.items.join(' ').includes('同步异常'), m.items.join(' '));
  assert.ok(!m.detail.includes('同步异常'));
});
t('全部正常时没有 detail（别加戏）', () => {
  assert.equal(C.consoleBarModel({ status: runningStatus }).detail, '');
});
t('展开态状态词与收起条同源（两处不许说法不一致）', () => {
  assert.equal(C.consoleStatusWord({ running: true }).text, '同步中');
  assert.equal(C.consoleStatusWord({ running: false }).text, '同步没在跑');
  assert.equal(C.consoleStatusWord({ running: true, windows: [{ degraded: true }] }).tone, 'warn');
});

/* ============================ 5. 文件交接 ============================ */
console.log('\n— 5. 文件交接（界面 ↔ 桌面壳）—');
const reqFile = C.CONSOLE_REQUEST_FILE;
fs.rmSync(reqFile, { force: true });

t('没有桌面壳在管时，requestConsole 不写请求文件（写了没人读 = 说了没做）', () => {
  const r = C.requestConsole({ mode: 'collapsed' });
  assert.equal(r.ok, false);
  assert.equal(r.managed, false);
  assert.ok(!fs.existsSync(reqFile), '请求文件不该被创建');
});
t('readConsoleState 没有状态文件 → managed:false、形态默认展开', () => {
  const st = C.readConsoleState();
  assert.equal(st.managed, false);
  assert.equal(st.mode, 'expanded');
  assert.deepEqual(st.prefs, { open: true, auto_shrink: true });
});
t('桌面壳写了状态 → managed:true，形态/设置/位置都能读回', () => {
  C.writeConsoleState({
    mode: 'collapsed',
    prefs: { open: true, auto_shrink: false },
    rect: { x: 10, y: 20, width: 360, height: 56 },
    rects: { expanded: { x: 100, y: 100 }, collapsed: { x: 10, y: 20 } },
    displays_count: 2,
  });
  const st = C.readConsoleState();
  assert.equal(st.managed, true);
  assert.equal(st.mode, 'collapsed');
  assert.equal(st.prefs.auto_shrink, false);
  assert.equal(st.displays_count, 2);
  assert.deepEqual(st.rects.collapsed, { x: 10, y: 20 });
  assert.deepEqual(st.rects.expanded, { x: 100, y: 100 });
});
t('位置**按形态分开记**（共用一个会让「收起 → 展开」每次跳位置）', () => {
  C.writeConsoleState({ mode: 'expanded', rects: { expanded: { x: 500, y: 400 }, collapsed: { x: 20, y: 30 } } });
  const st = C.readConsoleState();
  assert.notDeepEqual(st.rects.expanded, st.rects.collapsed);
});
t('状态文件太旧（30 秒没心跳）→ 当没有桌面壳在管', () => {
  const file = C.CONSOLE_STATE_FILE;
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  j.at = new Date(Date.now() - C.CONSOLE_STALE_MS - 5000).toISOString();
  fs.writeFileSync(file, JSON.stringify(j));
  assert.equal(C.readConsoleState().managed, false);
  // 恢复新鲜状态，后面的用例要用
  C.writeConsoleState({ mode: 'expanded', prefs: { open: true, auto_shrink: true } });
});
t('有桌面壳时 requestConsole 落请求文件（形态 / 设置 / 复位）', () => {
  const r = C.requestConsole({ mode: 'collapsed' });
  assert.equal(r.ok, true);
  assert.equal(r.managed, true);
  const back = C.readConsoleRequest();
  assert.equal(back.mode, 'collapsed');
  assert.ok(back.at);
  const r2 = C.requestConsole({ prefs: { auto_shrink: false } });
  assert.equal(r2.ok, true);
  assert.equal(C.readConsoleRequest().prefs.auto_shrink, false);
  const r3 = C.requestConsole({ reset_position: true });
  assert.equal(r3.ok, true);
  assert.equal(C.readConsoleRequest().reset_position, true);
});
t('空请求被拒（不许写一个没人能执行的文件）', () => {
  const r = C.requestConsole({});
  assert.equal(r.ok, false);
  assert.equal(r.managed, true);
  assert.match(r.error, /没有可执行的动作/);
});
t('readConsoleRequest 没有文件 → null', () => {
  fs.rmSync(reqFile, { force: true });
  assert.equal(C.readConsoleRequest(), null);
});

/* ============================ 6. preload 边界 ============================ */
console.log('\n— 6. preload 边界：只开一个口子 —');
const preloadSrc = fs.readFileSync(path.join(ROOT, 'desktop', 'preload.cjs'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8');
/** 剥注释：注释里会正当地提到 `preload` / `ipcRenderer`，不剥会误判成代码 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const preloadCode = stripComments(preloadSrc);
const mainCode = stripComments(mainSrc);

t('preload 是 CommonJS（sandboxed preload 不认 ESM）', () => {
  assert.match(preloadSrc, /require\('electron'\)/);
  assert.ok(!/^\s*import\s/m.test(preloadSrc), 'preload 里不许出现 import');
});
t('preload 只 exposeInMainWorld 一次，且只暴露 isDesktop + openSyncPanel', () => {
  const calls = preloadSrc.match(/exposeInMainWorld/g) || [];
  assert.equal(calls.length, 1, `exposeInMainWorld 出现 ${calls.length} 次`);
  const at = preloadSrc.indexOf("exposeInMainWorld('fpDesktop'");
  assert.ok(at > 0, '没有 fpDesktop 这个入口');
  const body = preloadSrc.slice(at);
  const keys = [...body.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]).sort();
  assert.deepEqual(keys, ['isDesktop', 'openSyncPanel'], JSON.stringify(keys));
});
t('preload **不透传 ipcRenderer**（只准用一次 invoke 打那一条通道）', () => {
  // 剥掉注释后应当只剩两处：解构拿到的那个、以及 invoke 那一行
  const uses = [...preloadCode.matchAll(/ipcRenderer/g)].length;
  assert.ok(uses <= 2, `代码里 ipcRenderer 出现 ${uses} 次，疑似把整个对象暴露出去`);
  assert.ok(!/exposeInMainWorld\([^)]*ipcRenderer/.test(preloadCode), 'ipcRenderer 被当值传出去了');
  assert.ok(!/\bipcRenderer\s*[,}]/.test(preloadCode.replace(/const\s*\{[^}]*\}\s*=\s*require\('electron'\);/, '')),
    'ipcRenderer 被当值传出去了');
  assert.ok(!/require\((?!'electron'\))/.test(preloadCode), 'preload 里不许再 require 别的东西');
});
t('preload 只打 fp:open-sync-panel 这一条通道', () => {
  const chans = [...preloadSrc.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(chans, ['fp:open-sync-panel'], JSON.stringify(chans));
});

const bodyOf = (src, header) => {
  const at = src.indexOf(header);
  if (at < 0) return '';
  const rest = src.slice(at + header.length);
  const end = rest.search(/\n\}/);
  return end < 0 ? rest : rest.slice(0, end);
};
const mainWindowBody = bodyOf(mainCode, 'function createWindow()');
const consolePanelBody = bodyOf(mainCode, 'function createSyncPanel(');

t('主窗口挂 preload（「打开操作台」的唯一入口）', () => {
  assert.ok(mainWindowBody.length > 200, '找不到 createWindow 函数体');
  assert.match(mainWindowBody, /preload:\s*PRELOAD_FILE/);
  assert.match(mainSrc, /const PRELOAD_FILE = path\.join\(HERE, 'preload\.cjs'\)/);
});
t('preload 后缀是 .cjs（package.json 有 type:module，sandboxed preload 只能是 CJS）', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'desktop', 'preload.cjs')), 'desktop/preload.cjs 不存在');
  assert.ok(!fs.existsSync(path.join(ROOT, 'desktop', 'preload.js')), '别留一个 .js 版本（会被当 ESM）');
  assert.match(mainSrc, /'preload\.cjs'/);
});
t('**操作台小窗不挂 preload**（它改形态走 Local API + 请求文件）', () => {
  assert.ok(consolePanelBody.length > 200, '找不到 createSyncPanel 函数体');
  assert.ok(!/preload/.test(consolePanelBody), '操作台小窗里出现了 preload');
});
t('两个窗口都还是 sandbox + contextIsolation（没被改成 false）', () => {
  for (const body of [mainWindowBody, consolePanelBody]) {
    assert.match(body, /sandbox:\s*true/);
    assert.match(body, /contextIsolation:\s*true/);
    assert.match(body, /nodeIntegration:\s*false/);
  }
  assert.ok(!/sandbox:\s*false/.test(mainSrc));
  assert.ok(!/contextIsolation:\s*false/.test(mainSrc));
});
t('主进程侧校验调用者：只允许主窗口的 webContents 打开操作台', () => {
  const at = mainSrc.indexOf("ipcMain.handle('fp:open-sync-panel'");
  assert.ok(at > 0, '没有注册 fp:open-sync-panel');
  const seg = mainSrc.slice(at, at + 600);
  assert.match(seg, /event\.sender\s*!==\s*win\.webContents/);
  assert.match(seg, /showSyncPanel\(\)/);
});
t('退出时清掉操作台轮询与 IPC 通道', () => {
  const quitAt = mainSrc.indexOf('async function quitApp');
  const seg = mainSrc.slice(quitAt, quitAt + 3000);
  assert.match(seg, /clearInterval\(consolePoll\)/);
  assert.match(seg, /removeHandler\('fp:open-sync-panel'\)/);
});

/* ============================ 7. 页面与路由 ============================ */
console.log('\n— 7. 页面按钮打的是既有路由 —');
const routesSrc = fs.readFileSync(path.join(ROOT, 'src', 'api', 'routes.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'web', 'api.js'), 'utf8');
const syncSrc = fs.readFileSync(path.join(ROOT, 'web', 'pages', 'sync.js'), 'utf8');
const panelSrc = fs.readFileSync(path.join(ROOT, 'web', 'pages', 'sync-panel.js'), 'utf8');
const widgetsSrc = fs.readFileSync(path.join(ROOT, 'web', 'sync-widgets.js'), 'utf8');
const sessionSrc = fs.readFileSync(path.join(ROOT, 'src', 'sync', 'session.js'), 'utf8');

t('三条新路由都在（restart / console GET / console POST）', () => {
  assert.ok(routesSrc.includes("'/api/v2/sync/restart'"));
  assert.ok(routesSrc.includes("'/api/v2/sync/console'"));
  const gets = (routesSrc.match(/add\(\['GET'\], \['\/api\/v2\/sync\/console'\]/g) || []).length;
  const posts = (routesSrc.match(/add\(\['POST'\], \['\/api\/v2\/sync\/console'\]/g) || []).length;
  assert.equal(gets, 1, `GET /sync/console 出现 ${gets} 次`);
  assert.equal(posts, 1, `POST /sync/console 出现 ${posts} 次`);
});
t('restart 是 stop + start（复用 session，不另写一套）', () => {
  const at = routesSrc.indexOf("'/api/v2/sync/restart'");
  const seg = routesSrc.slice(at, at + 500);
  assert.match(seg, /restartSync/);
  // 复用既有 session 的两步，不自己拼捕获/连接
  assert.match(sessionSrc, /await stopSync\(\)/);
  assert.match(sessionSrc, /startSync\(\{ masterId, slaveIds/);
});
t('restart 失败不静默（已停止但没能重新开始要写在错误里）', () => {
  assert.match(sessionSrc, /同步已停止，但没能重新开始/);
  assert.match(sessionSrc, /restarted = false/);
});
t('无桌面壳时 POST console 回 code 0 + requested:false（不是抛参数错误）', () => {
  const at = routesSrc.indexOf("add(['POST'], ['/api/v2/sync/console']");
  const seg = routesSrc.slice(at, at + 900);
  assert.match(seg, /no_desktop_shell/);
  assert.match(seg, /requested:\s*false/);
});
t('界面「重启同步」调的是 /api/v2/sync/restart', () => {
  assert.match(syncSrc, /api\.syncRestart\(/);
  assert.match(apiSrc, /syncRestart:\s*\(body\)\s*=>\s*call\('\/api\/v2\/sync\/restart'/);
});
t('「窗口排列」「显示窗口」两处界面共用同一份实现（不各写一套）', () => {
  /* 0.4.7.5 布局改版后，窗口同步页的**视觉骨架**按 31 号文重排（表格行内图标 + 操作台卡片），
   * 不再复用操作台小窗那两个 DOM 组件；但「不各写一套」的实质要求钉得更死：
   * 请求体构造与调用只有 sync-widgets.js 一处，页面必须走 runArrange / runShow。 */
  assert.match(syncSrc, /from '\.\.\/sync-widgets\.js'/);
  assert.match(panelSrc, /from '\.\.\/sync-widgets\.js'/);
  assert.match(syncSrc, /runArrange/);
  assert.match(syncSrc, /runShow/);
  assert.match(panelSrc, /buildArrangePanel/);
  assert.match(panelSrc, /buildShowPanel/);
  assert.ok(!syncSrc.includes('api.syncArrange'), '页面自己调了 api.syncArrange');
});
t('排列/显示打的就是既有那两条路由', () => {
  assert.match(widgetsSrc, /api\.syncArrange\(/);
  assert.match(widgetsSrc, /api\.syncShow\(/);
  assert.match(apiSrc, /syncArrange:\s*\(body\)\s*=>\s*call\('\/api\/v2\/sync\/arrange'/);
  assert.match(apiSrc, /syncShow:\s*\(profileIds\)\s*=>\s*call\('\/api\/v2\/sync\/show'/);
});
t('页面自己不许拼 sync/arrange、sync/show 请求（只能走共用组件）', () => {
  for (const [name, src] of [['sync.js', syncSrc], ['sync-panel.js', panelSrc]]) {
    assert.ok(!/['"`]\/api\/v2\/sync\/(arrange|show)/.test(src), `${name} 自己拼了请求`);
    assert.ok(!/\bfetch\(/.test(src), `${name} 里出现了裸 fetch`);
  }
});
t('操作台两种形态在页面里都有入口（收起 / 展开）', () => {
  assert.match(panelSrc, /syncConsoleSet\(\{\s*mode:\s*'collapsed'\s*\}\)/);
  assert.match(panelSrc, /syncConsoleSet\(\{\s*mode:\s*'expanded'\s*\}\)/);
});
t('自动收起开关与复位位置都在页面上（不是只有 API）', () => {
  assert.match(panelSrc, /auto_shrink/);
  assert.match(panelSrc, /reset_position:\s*true/);
});
t('纯网页时如实禁用并写明「桌面版才有操作台」', () => {
  assert.match(syncSrc, /桌面版才有操作台/);
  assert.match(syncSrc, /fpDesktop/);
});
t('页面打开操作台走的是 preload 那一个方法，不是自己造通道', () => {
  assert.match(syncSrc, /window\.fpDesktop/);
  assert.match(syncSrc, /\.openSyncPanel\(\)/);
  // 页面不许直接摸 IPC / Node（纯网页里这些根本不存在）；注释里提到不算
  assert.ok(!/require\(|ipcRenderer/.test(stripComments(syncSrc)), 'sync.js 里出现了 require/ipcRenderer');
});

const fail = results.filter((r) => !r.ok).length;
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 句柄没放干净也不阻塞结论 */ }
console.log(`\n${results.length - fail}/${results.length} 通过`);
process.exit(fail ? 1 : 0);
