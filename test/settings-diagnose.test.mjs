/**
 * 设置 + 网络诊断（0.4.3 ④）判据 —— A 层：不起内核，几秒跑完。
 *
 * 三条要求（CEO 原话）逐条钉死：
 *   1. **网络诊断只读**：不改配置、不写库、不起停内核 —— 行为验（快照前后库里的值不变、
 *      代理的 `checked_at` 不变）+ 静态扫（`src/api/diagnose.js` 里没有任何写操作）；
 *   2. **设置页的项要真生效**：`sync_defaults` 存进库、`/sync/start` 读它（`mergeSyncSettings`
 *      直接验合并结果）、`/sync/status` 没在跑时显示的就是存的那份；
 *   3. **外观沿用 ③ 的密度口径**：同一个 localStorage 键 `fp.view_density`、同一套三档，
 *      不新造存储（静态扫 + 事件广播）。
 *
 * 跑法：node --no-warnings test/settings-diagnose.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startFakeProxy } from './fake-proxy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(os.tmpdir(), `freepower-settings-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });

process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_RATE_LIMIT_MCP = '10000';
process.env.FREEPOWER_SELFCHECK = '0';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/**
 * 去掉注释再扫代码：这些文件里都**明确写着**「不许 rmSync / 不许 localStorage」，
 * 直接全文 grep 会把自己的告诫当成违规（第一版就这么红了两条）。
 * 只去注释、不动字符串 —— 真写进字符串里的调用名照样会被抓住。
 */
const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected),
  `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);

const okProxy = await startFakeProxy({ ip: '198.51.100.7', country: 'Germany', countryCode: 'DE', city: 'Berlin', timezone: 'Europe/Berlin' });
const holeSockets = new Set();
const hole = net.createServer((s) => {
  holeSockets.add(s);
  s.on('close', () => holeSockets.delete(s));
  s.on('error', () => { /* 主动 destroy 时报 aborted，忽略 */ });
});
await new Promise((r) => hole.listen(0, '127.0.0.1', r));
const holePort = hole.address().port;

try {
  const prof = await import('../src/store/profiles.js');
  const proxies = await import('../src/store/proxies.js');
  const db = await import('../src/store/db.js');
  const prefs = await import('../src/settings/prefs.js');
  const settingsMod = await import('../src/sync/settings.js');
  const sessionMod = await import('../src/sync/session.js');
  const { createApiServer } = await import('../src/api/server.js');
  const { closeDb } = await import('../src/store/db.js');
  const density = await import('../web/density.js');

  const { server, apiKey } = createApiServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function api(method, p, body) {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', 'api-key': apiKey, 'x-freepower-client': 'mcp' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 纯文本 */ }
    return { status: res.status, json };
  }

  /* ============================ 1. 设置：默认值 / 合并 / 越界 ============================ */
  console.log('\n— 1. 设置：初始状态与合并语义 —');
  const fresh = await api('GET', '/api/v2/settings');
  check('GET /settings：初始 saved=false（没存过）',
    fresh.json?.code === 0 && fresh.json.data.sync_defaults_saved === false,
    JSON.stringify(fresh.json?.data?.sync_defaults_saved));
  eq('初始 settings 就是内置默认（16 个键）',
    Object.keys(fresh.json.data.sync_defaults).sort(),
    Object.keys(settingsMod.DEFAULT_SETTINGS).sort());

  const w1 = await api('POST', '/api/v2/settings/sync-defaults', { input: false, nope: 1 });
  check('改一项：code=0 且真的改了', w1.json?.code === 0 && w1.json.data.settings.input === false);
  eq('不认识的字段如实回报在 ignored 里（不静默吞）', w1.json.data.ignored, ['nope']);
  check('其余字段保持默认（合并语义，不是整体覆盖）',
    w1.json.data.settings.click === true && w1.json.data.settings.delay_ms === 0);

  const w2 = await api('POST', '/api/v2/settings/sync-defaults', { click: false });
  check('再改一项：前一项还在（确实是合并）',
    w2.json.data.settings.input === false && w2.json.data.settings.click === false);

  const w3 = await api('POST', '/api/v2/settings/sync-defaults', { delay_ms: 999999, jitter_ms: -5 });
  check('越界值夹回区间（delay 上限 5000、负数回默认）',
    w3.json.data.settings.delay_ms === 5000 && w3.json.data.settings.jitter_ms === 0,
    `delay=${w3.json.data.settings.delay_ms} jitter=${w3.json.data.settings.jitter_ms}`);

  const w4 = await api('POST', '/api/v2/settings/sync-defaults', { typing_min_ms: 300, typing_max_ms: 50 });
  check('打字间隔上下界反了自动换过来',
    w4.json.data.settings.typing_min_ms === 50 && w4.json.data.settings.typing_max_ms === 300,
    `${w4.json.data.settings.typing_min_ms}–${w4.json.data.settings.typing_max_ms}`);

  const readBack = await api('GET', '/api/v2/settings');
  check('读回来 saved=true，diff 里列出改过的项',
    readBack.json.data.sync_defaults_saved === true && readBack.json.data.sync_defaults_diff.length >= 2,
    JSON.stringify(readBack.json.data.sync_defaults_diff));

  /* ============================ 2. 设置真生效 ============================ */
  console.log('\n— 2. 真生效：开始同步读它、状态页显示它 —');
  const merged = prefs.mergeSyncSettings({});
  check('mergeSyncSettings() 就是存的那份（开始同步会用这个）',
    merged.input === false && merged.click === false && merged.delay_ms === 5000,
    JSON.stringify({ input: merged.input, click: merged.click, delay_ms: merged.delay_ms }));
  const mergedOver = prefs.mergeSyncSettings({ input: true, random_number: true });
  check('请求里显式给了就覆盖默认（其余仍取默认）',
    mergedOver.input === true && mergedOver.random_number === true && mergedOver.click === false);

  const st = await api('GET', '/api/v2/sync/status');
  check('/sync/status 没在跑时显示的是**存的那份默认**（不是写死的常量）',
    st.json?.data?.running === false && st.json.data.settings.input === false
    && st.json.data.settings.delay_ms === 5000,
    JSON.stringify(st.json?.data?.settings));

  const routesSrc = read('src/api/routes.js');
  const startBlock = routesSrc.slice(
    routesSrc.indexOf("add(['POST'], ['/api/v2/sync/start']"),
    routesSrc.indexOf("add(['POST'], ['/api/v2/sync/stop']"),
  );
  check('start 路由里用的是 mergeSyncSettings（不是把 settings 直接传下去）',
    /mergeSyncSettings\(b\.settings\)/.test(startBlock), '');
  check('start 路由没有再回退成「空对象 → 内置默认」的老写法',
    !/settings: b\.settings && typeof b\.settings === 'object' \? b\.settings : \{\}/.test(startBlock));

  /* ============================ 3. 存坏了回默认 ============================ */
  console.log('\n— 3. 存坏了：回默认 + 如实说（不静默） —');
  db.setMeta(prefs.SYNC_DEFAULTS_KEY, '{这不是 JSON');
  const broken = await api('GET', '/api/v2/settings');
  check('库里是坏 JSON → saved=false、broken=true、settings 回内置默认',
    broken.json.data.sync_defaults_saved === false && broken.json.data.sync_defaults_broken === true
    && broken.json.data.sync_defaults.input === true,
    JSON.stringify(broken.json.data.sync_defaults_broken));

  const rs = await api('POST', '/api/v2/settings/sync-defaults/reset');
  check('恢复默认：saved=false，settings 回内置值',
    rs.json.data.saved === false && rs.json.data.settings.input === true && rs.json.data.settings.delay_ms === 0);
  const st2 = await api('GET', '/api/v2/sync/status');
  check('恢复后 /sync/status 也跟着回默认',
    st2.json.data.settings.input === true && st2.json.data.settings.delay_ms === 0);

  /* ============================ 4. 网络诊断快照（只读） ============================ */
  console.log('\n— 4. 网络诊断快照：内容对、只读 —');
  const pkg = JSON.parse(read('package.json'));
  const snap = await api('GET', '/api/v2/diagnose/network');
  check('GET /diagnose/network：code=0 且 readonly:true',
    snap.json?.code === 0 && snap.json.data.readonly === true);
  check('端口是这次请求实际落到的那个端口',
    snap.json.data.service.port === port, `${snap.json.data.service.port} vs ${port}`);
  check('pid 是本进程', snap.json.data.service.pid === process.pid, String(snap.json.data.service.pid));
  check('版本号来自 package.json', snap.json.data.service.version === pkg.version, snap.json.data.service.version);
  check('数据库路径指向 freepower.db，且报的是真实字节数（不是 0）',
    /freepower\.db$/.test(snap.json.data.service.db.path)
    && Number(snap.json.data.service.db.bytes) > 0,
    `${snap.json.data.service.db.bytes} B`);
  check('监听端口里有本地 API 那一条，端口对得上',
    snap.json.data.listeners.some((x) => x.kind === 'api' && x.port === port));
  check('没有环境在跑 → kernels.running 是空的、没有 CDP 端口条目（不为了报告去起内核）',
    snap.json.data.kernels.running.length === 0
    && snap.json.data.listeners.filter((x) => x.kind === 'cdp').length === 0);
  check('notes 里写明「只读」', snap.json.data.notes.join(' ').includes('只读'));

  /* 建两个环境共用同一条代理 + 一条死端口代理 */
  const px1 = proxies.createProxies([{ proxy_type: 'http', host: '127.0.0.1', port: okProxy.port, username: 'diag-user', password: 'diag-pass', remark: 'diag-ok' }]);
  const px2 = proxies.createProxies([{ proxy_type: 'http', host: '127.0.0.1', port: holePort, remark: 'diag-hole' }]);
  const px1Id = (px1.list || px1)[0]?.proxy_id || (px1.list || px1)[0]?.id;
  const px2Id = (px2.list || px2)[0]?.proxy_id || (px2.list || px2)[0]?.id;
  const pa = prof.createProfile({ name: 'diag-a', group_id: '0', proxy_id: px1Id });
  const pb = prof.createProfile({ name: 'diag-b', group_id: '0', proxy_id: px1Id });
  const pc = prof.createProfile({ name: 'diag-c', group_id: '0', proxy_id: px2Id });

  const snap2 = await api('GET', '/api/v2/diagnose/network');
  check('两个环境共用一条代理 → 去重后 2 条代理、3 个绑了代理的环境',
    snap2.json.data.proxies.distinct === 2 && snap2.json.data.proxies.bound_profiles === 3,
    JSON.stringify({ d: snap2.json.data.proxies.distinct, b: snap2.json.data.proxies.bound_profiles }));
  const leak = JSON.stringify(snap2.json.data);
  check('快照里**没有**代理密码（连字段名都不出现）',
    !/diag-pass/.test(leak) && !/"password"/.test(leak), leak.slice(0, 80));
  check('代理账号是打码的（只留首字母）',
    snap2.json.data.proxies.list.some((x) => x.username_masked === 'd***'),
    JSON.stringify(snap2.json.data.proxies.list.map((x) => x.username_masked)));

  /* 只读：快照前后库里的东西一个字节没变 */
  const before = {
    profile: JSON.stringify(prof.getProfile(pa.id)),
    proxy: JSON.stringify(proxies.listProxies({ ids: [px1Id] }).list[0]),
    meta: db.getMeta('api_verify'),
  };
  await api('GET', '/api/v2/diagnose/network');
  await api('GET', '/api/v2/diagnose/network');
  const after = {
    profile: JSON.stringify(prof.getProfile(pa.id)),
    proxy: JSON.stringify(proxies.listProxies({ ids: [px1Id] }).list[0]),
    meta: db.getMeta('api_verify'),
  };
  check('连着读两次快照，环境 / 代理 / 设置**一个字节都没变**（真只读）',
    JSON.stringify(before) === JSON.stringify(after), '');

  /* ============================ 5. 代理探测（只读、限并发、三态） ============================ */
  console.log('\n— 5. 代理探测：通 / 不通 / 超时分开，且不落盘 —');
  const checkedAtBefore = proxies.listProxies({ ids: [px1Id, px2Id] }).list.map((x) => x.checked_at);
  const probe = await api('POST', '/api/v2/diagnose/proxy', { timeout_ms: 1200 });
  check('探测返回 code=0 且标了 readonly / persisted:false',
    probe.json?.code === 0 && probe.json.data.readonly === true && probe.json.data.persisted === false);
  check('两条代理各一条结果（按 host:port:账号 去重）', probe.json.data.total === 2, String(probe.json.data.total));
  const okRow = probe.json.data.list.find((x) => x.ok);
  check('活的代理：ok + 出口 IP / 国家 / 延迟',
    okRow && okRow.ip === '198.51.100.7' && okRow.country === 'Germany' && okRow.latency_ms >= 0,
    JSON.stringify(okRow && { ip: okRow.ip, country: okRow.country }));
  check('共用一条代理的两个环境都列在这条结果上（不是只报第一个）',
    okRow && okRow.profiles.length === 2, String(okRow?.profiles?.length));
  const holeRow = probe.json.data.list.find((x) => !x.ok);
  check('黑洞代理：outcome=timeout 且**带具体秒数**',
    holeRow && holeRow.outcome === 'timeout' && holeRow.timeout_seconds === 1.2
    && holeRow.timeout_ms === 1200,
    JSON.stringify(holeRow && { o: holeRow.outcome, s: holeRow.timeout_seconds }));
  check('汇总里 ok / fail / timeout 分开计数',
    probe.json.data.ok === 1 && probe.json.data.fail === 1 && probe.json.data.timeout === 1,
    JSON.stringify({ ok: probe.json.data.ok, fail: probe.json.data.fail, t: probe.json.data.timeout }));

  const checkedAtAfter = proxies.listProxies({ ids: [px1Id, px2Id] }).list.map((x) => x.checked_at);
  check('探测**没有**写代理的 checked_at（诊断不落盘，与代理管理页那条不同）',
    JSON.stringify(checkedAtBefore) === JSON.stringify(checkedAtAfter),
    `${JSON.stringify(checkedAtBefore)} → ${JSON.stringify(checkedAtAfter)}`);

  /* 全直连：不是错误，是一条说明 */
  const pd = prof.createProfile({ name: 'diag-direct', group_id: '0' });
  const probeDirect = await api('POST', '/api/v2/diagnose/proxy', { profile_ids: [pd.id] });
  check('只挑直连环境 → code=0、total=0，并说明「没有可探测的代理」（不是报错）',
    probeDirect.json?.code === 0 && probeDirect.json.data.total === 0
    && String(probeDirect.json.data.message).includes('直连'),
    probeDirect.json?.data?.message);

  /* ============================ 6. 静态：只读与「不新造存储」 ============================ */
  console.log('\n— 6. 静态约束 —');
  const diagSrc = read('src/api/diagnose.js');
  const diagCode = codeOnly(diagSrc);
  const WRITE_OPS = ['setMeta(', 'updateProfile(', 'startProfile(', 'stopProfile(', 'writeFileSync', 'appendFileSync', 'rmSync', 'unlinkSync', 'renameSync', 'rememberProxyCheck('];
  const foundWrites = WRITE_OPS.filter((x) => diagCode.includes(x));
  check('diagnose.js 的**代码**里没有任何写操作（setMeta/updateProfile/start/stop/writeFile/rm/rememberProxyCheck）',
    foundWrites.length === 0, foundWrites.join(','));
  check('diagnose.js 明确声明只读（头注释 + 返回里 readonly）', /只读/.test(diagSrc) && /readonly: true/.test(diagSrc));

  const prefsCode = codeOnly(read('src/settings/prefs.js'));
  check('设置存库（meta 表），不是 localStorage',
    /getMeta|setMeta/.test(prefsCode) && !/localStorage/.test(prefsCode));

  const htmlSrc = read('web/index.html');
  check('侧栏底部有账号菜单挂载点，且在 sidebar-foot 里',
    /id="account-menu"/.test(htmlSrc)
    && htmlSrc.indexOf('sidebar-foot') < htmlSrc.indexOf('account-menu'));
  const appSrc = read('web/app.js');
  check('账号菜单三项都在：设置 / 外观 / 网络诊断',
    /'设置'/.test(appSrc) && /'外观'/.test(appSrc) && /'网络诊断'/.test(appSrc));
  check('外观用的是 ③ 的密度模块（DENSITIES + setDensity），没有新造一套',
    /from '\.\/density\.js'/.test(appSrc) && /DENSITIES\.map/.test(appSrc) && /setDensity\(/.test(appSrc));
  const newKeys = (appSrc.match(/localStorage\.setItem\('([^']+)'/g) || []);
  check('app.js 没有自己写新的 localStorage 键（密度走 density.js 的 fp.view_density）',
    newKeys.length === 0, newKeys.join(','));
  check('两条新路由注册了（#/settings、#/diagnostics）',
    /re: \/\^\\\/settings\$\/, nav: 'settings'/.test(appSrc)
    && /re: \/\^\\\/diagnostics\$\/, nav: 'diagnostics'/.test(appSrc));
  check('账号菜单项用 account-item（不是 nav-item，不参与侧栏折叠的计数）',
    /'data-nav': 'settings'/.test(appSrc) && /class: 'account-item'/.test(appSrc));

  const settingsSrc = read('web/pages/settings.js');
  check('设置页把同步默认真的存了（调 saveSyncDefaults），不是只在本页记着',
    /api\.saveSyncDefaults\(/.test(settingsSrc) && /api\.resetSyncDefaults\(/.test(settingsSrc));
  check('设置页把「没做 / 在别处」逐条写出来了（语言 / 主题 / 自动更新 / 退出登录 / 开机自启）',
    ['界面语言', '主题', '自动更新', '退出登录', '开机自启'].every((x) => settingsSrc.includes(x)));
  check('设置页写明外观只存本地、与列表页同一个键',
    /fp\.view_density/.test(settingsSrc) && /不写库/.test(settingsSrc));

  const diagPageSrc = read('web/pages/diagnostics.js');
  check('诊断页没有任何写接口调用（不出现 update/save/batch/start/stop）',
    !/api\.(update|save|batch|start|stop|create|remove)/.test(diagPageSrc),
    (diagPageSrc.match(/api\.\w+/g) || []).join(','));
  check('诊断页上写明只读', /只读/.test(diagPageSrc));
  check('同步页「没在跑」时改开关会真的存起来（不再只是提示「已记住」）',
    /api\.saveSyncDefaults\(/.test(read('web/pages/sync.js')));

  /* ============================ 7. 纯函数 ============================ */
  console.log('\n— 7. 纯函数与导出契约 —');
  check('session.js 仍导出同一份 DEFAULT_SETTINGS / normalizeSettings（对外契约没变）',
    sessionMod.DEFAULT_SETTINGS === settingsMod.DEFAULT_SETTINGS
    && sessionMod.normalizeSettings === settingsMod.normalizeSettings);
  /* 17 = 原 16 键 + deliver（投递路径 win32/cdp，见 src/sync/settings.js） */
  check('normalizeSettings 对空入参给全套 17 键',
    Object.keys(settingsMod.normalizeSettings({})).length === 17);
  eq('diffSettings 只报不同的键', settingsMod.diffSettings(
    { ...settingsMod.DEFAULT_SETTINGS, input: false }, settingsMod.DEFAULT_SETTINGS,
  ), ['input']);

  const cur = density.readDensity(null);
  check('密度读不到存储时回标准（与 ③ 一致）', cur === 'standard', cur);

  /* ---- 收尾 ---- */
  server.close();
  closeDb();
  await okProxy.close();
  for (const s of holeSockets) { try { s.destroy(); } catch { /* 已断 */ } }
  await new Promise((r) => hole.close(() => r()));
  await new Promise((r) => setTimeout(r, 100));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 句柄可能还开着 */ }
} catch (e) {
  check('测试脚本自身异常', false, e.stack || e.message);
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);