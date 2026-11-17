/**
 * 窗口排列 / 显示 / 统一尺寸 **与同步会话解绑** 的 B 层判据（0.4.7.4，真内核、2 个环境）。
 *
 * 用户实测的问题（2026-11-17，0.4.7.2、端口 53380）：
 *   `POST /api/v2/sync/arrange {"auto":true}` → `{"code":100002,"msg":"没有正在运行的同步会话"}`
 *   `POST /api/v2/sync/show {}`            → 同上
 * 而对手的正常流程是「勾选环境 → 窗口排列 → 启动同步」—— 排列**不需要同步已经起来**。
 *
 * 判据（先红后绿，红测钉「没有连坐」）：
 *   ① 无会话 + 2 个真环境 → `arrange {auto:true, ids:[...]}` 成功；回读每个窗口位置尺寸对、
 *      互不重叠、都在 workArea 内；
 *   ② 无会话 + 0 个 id → 100002，msg 说的是「先勾选正在运行的环境」，不是 500、不是旧文案；
 *   ③ 无会话先排列 → `startSync` → `status.size_mismatch === false`；排列本身 `attached === 0`
 *      （排列只走浏览器级命令，一个 CDP 会话都不开，所以不存在「第二次 attach」）；
 *   ④ 有会话时 arrange/show 行为与解绑前一致（`source === 'session'`、角色仍是主/受控）；
 *   静态：解绑路径里没有 `startProfile` / 起内核的调用，四个函数里没有无条件的 `if (!current) throw`。
 *
 * 跑法：npm run test:sync-detached-kernel（起 2 个真内核，约 40 秒）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dataDir = path.join(os.tmpdir(), `freepower-detached-${Date.now()}`);
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
process.env.FREEPOWER_EGRESS_TIMEOUT = '800';
// 本测试要连打几条本地 API，别被默认 1/s 限流打断（与 test/api.test.mjs 同一套做法）
process.env.FREEPOWER_RATE_LIMIT_MCP = '10000';

const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end('<!doctype html><title>detached</title><h1>detached</h1>');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const U = (p) => `http://127.0.0.1:${PORT}${p}`;

const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');
const sync = await import('../src/sync/session.js');
const { writeDisplays } = await import('../src/sync/displays.js');
const { createApiServer } = await import('../src/api/server.js');

const { server, apiKey } = createApiServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/** 走本地 API（与用户/CEO 实测的那条路完全一致，不看函数返回值） */
async function api(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', 'api-key': apiKey, 'x-freepower-client': 'mcp' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 纯文本 */ }
  return { status: res.status, json, text };
}

/**
 * 目标显示器：故意让 workArea 和 bounds 不一样（模拟任务栏占掉一条）。
 * 尺寸控制在真机屏幕内（本机 3440×1440），窗口位置不会被系统夹掉。
 */
const WA = { x: 40, y: 60, width: 1400, height: 820 };
const FAKE_SCREEN = [{
  id: 9, label: '判据屏', primary: true, scaleFactor: 1,
  bounds: { x: 0, y: 0, width: WA.width + 80, height: WA.height + 100 },
  workArea: { ...WA },
}];

const started = [];

/** 直接读 CDP 的窗口实测矩形（判据只认这个，不认 arrange 自己回抱的数字） */
async function rectOf(id) {
  const inst = manager.getInstance(id);
  const { targetInfos } = await inst.client.send('Target.getTargets');
  const page = (targetInfos || []).filter((t) => t.type === 'page')
    .find((t) => t.url && !t.url.startsWith('about:blank') && !t.url.startsWith('chrome://newtab'))
    || (targetInfos || []).find((t) => t.type === 'page');
  const { bounds, windowId } = await inst.client.send('Browser.getWindowForTarget', { targetId: page.targetId });
  return {
    windowId,
    x: bounds?.left ?? null,
    y: bounds?.top ?? null,
    width: bounds?.width ?? null,
    height: bounds?.height ?? null,
    state: bounds?.windowState || 'normal',
  };
}
const rectsOf = (ids) => Promise.all(ids.map(rectOf));

const overlapsAny = (list) => {
  const hits = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]; const b = list[j];
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) hits.push([i, j]);
    }
  }
  return hits;
};
const insideWA = (r) => r.x >= WA.x && r.y >= WA.y
  && r.x + r.width <= WA.x + WA.width && r.y + r.height <= WA.y + WA.height;

try {
  for (const name of ['det-a', 'det-b']) {
    const p = profiles.createProfile({ name: `${name}-${Date.now()}`, group_id: '0', remark: '排列解绑 B 层判据' });
    const st = await manager.startProfile(profiles.getProfile(p.profile_id));
    started.push(p.profile_id);
    console.log(`环境 ${name} = ${p.profile_id} · 内核 ${st.real_version}`);
  }
  for (const id of started) await manager.getInstance(id).openPage(U('/base'));
  await sleep(2500);

  check('前置条件：同步会话确实没在跑', sync.getSession() === null, String(sync.getSession()));
  check('显示器交接写成功（桌面壳那一侧的入口）', writeDisplays(FAKE_SCREEN) === true);

  /* ------------------ ① 无会话 + 2 个 id → 排列成功 ------------------ */
  console.log('\n— ① 无同步会话，arrange {auto:true, ids:[a,b]} → 必须成功（这就是用户那条路）—');
  const r1 = await api('POST', '/api/v2/sync/arrange', { auto: true, ids: started });
  const d1 = r1.json?.data || {};
  console.log(`HTTP ${r1.status} code=${r1.json?.code} source=${d1.source} attached=${d1.attached} `
    + `placed=${(d1.placed || []).length} auto=${JSON.stringify(d1.auto)}`);
  check('① API 回 code=0（不再 100002）', r1.json?.code === 0, `${r1.json?.code} ${r1.json?.msg || ''}`);
  check('① 走的是 ids 这条路（source=ids）', d1.source === 'ids', String(d1.source));
  check('① 排列没开任何 CDP 会话（attached=0 → 不存在「第二次 attach」）', d1.attached === 0, String(d1.attached));
  check('① 两条记录都 ok=true（回读通过才算成功）',
    (d1.placed || []).length === 2 && (d1.placed || []).every((x) => x.ok === true),
    JSON.stringify((d1.placed || []).map((x) => ({ ok: x.ok, actual: x.actual }))));
  check('① 汇总说「已排列 2 个窗口」', d1.summary?.ok === true && /已排列 2 个窗口/.test(d1.summary?.message || ''), d1.summary?.message);

  const a1 = await rectsOf(started);
  console.log(`排列后（CDP 实测）：${a1.map((w) => `${w.x},${w.y} ${w.width}×${w.height}(${w.state})`).join(' / ')}`);
  check('① 两个窗口都是 normal', a1.every((w) => w.state === 'normal'), a1.map((w) => w.state).join(' / '));
  check('① 尺寸都等于自动排列算出来的值',
    a1.every((w) => w.width === d1.auto?.width && w.height === d1.auto?.height),
    `${a1.map((w) => `${w.width}×${w.height}`).join(' / ')} vs 计划 ${d1.auto?.width}×${d1.auto?.height}`);
  check('① 都在目标显示器 workArea 内', a1.every(insideWA), JSON.stringify(a1.map((w) => [w.x, w.y, w.width, w.height])));
  check('① 互不重叠', overlapsAny(a1).length === 0, JSON.stringify(overlapsAny(a1)));
  check('① 原点 = workArea 原点（不是 bounds 的 0,0）',
    a1[0].x === WA.x && a1[0].y === WA.y, `${a1[0].x},${a1[0].y} 期望 ${WA.x},${WA.y}`);

  /* ------------------ ② 无会话 + 0 个 id → 100002 说人话 ------------------ */
  console.log('\n— ② 无会话 + 没给 id → 100002，msg 必须是「先勾选正在运行的环境」—');
  const r2 = await api('POST', '/api/v2/sync/arrange', { auto: true });
  console.log(`HTTP ${r2.status} ${JSON.stringify(r2.json)}`);
  check('② code=100002（参数错误，不是 500）', r2.json?.code === 100002, String(r2.json?.code));
  check('② msg 说的是「先勾选正在运行的环境」',
    /先勾选正在运行的环境/.test(String(r2.json?.msg || '')), String(r2.json?.msg || ''));
  check('② msg 不再是旧的「没有正在运行的同步会话」',
    !/没有正在运行的同步会话/.test(String(r2.json?.msg || '')), String(r2.json?.msg || ''));

  const r2b = await api('POST', '/api/v2/sync/show', {});
  check('② show 同理：100002 + 同一句人话',
    r2b.json?.code === 100002 && /先勾选正在运行的环境/.test(String(r2b.json?.msg || '')),
    `${r2b.json?.code} ${r2b.json?.msg || ''}`);

  /* ------------------ ③ 先排列 → 再开始同步 ------------------ */
  console.log('\n— ③ 先排列 → startSync → size_mismatch 必须是 false（排列过不许误报）—');
  const st = await sync.startSync({ masterId: started[0], slaveIds: [started[1]], settings: {}, rngSeed: 9090 });
  console.log(`startSync：running=${st.running} windows=${st.windows.length} size_mismatch=${st.size_mismatch} `
    + `尺寸=${st.windows.map((w) => `${w.role}=${w.window?.width}×${w.window?.height}`).join(' / ')}`);
  check('③ 会话起来了（1 主 + 1 受控）', st.running === true && st.windows.length === 2,
    JSON.stringify(st.windows.map((w) => w.role)));
  check('③ status.size_mismatch === false（排列后的新尺寸被读到了）', st.size_mismatch === false, String(st.size_mismatch));
  check('③ 两个窗口读到的宽度相同', new Set(st.windows.map((w) => w.window?.width)).size === 1,
    st.windows.map((w) => w.window?.width).join(' / '));
  check('③ 没有降级窗口（两条连接都正常）', st.windows.every((w) => !w.degraded),
    JSON.stringify(st.windows.map((w) => w.degraded)));

  // 实例日志：只该有**一行**「同步开始」，没有「同步未开始」（后者说明被前置检查挡了）
  const logFile = path.join(dataDir, 'logs', `${started[0]}.log`);
  const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const starts = (logText.match(/同步开始/g) || []).length;
  check('③ 实例日志里「同步开始」只有一行（没有第二次 attach/重复起会话）', starts === 1, `行数=${starts}`);
  check('③ 实例日志里没有「同步未开始」', !/同步未开始/.test(logText),
    (logText.split('\n').find((l) => /同步未开始/.test(l)) || '（无）').slice(0, 120));

  /* ------------------ ④ 有会话时行为不变 ------------------ */
  console.log('\n— ④ 有会话时 arrange / show 不给 ids → 仍用会话窗口（source=session，角色主/受控）—');
  const r4 = await sync.arrangeWindows({ width: 620, height: 380, row: 2, hs: 12, vs: 12, left: 8, top: 8 });
  check('④ source=session', r4.source === 'session', String(r4.source));
  check('④ 两条记录角色是 master/slave',
    (r4.placed || []).map((x) => x.role).sort().join(',') === 'master,slave',
    JSON.stringify((r4.placed || []).map((x) => x.role)));
  check('④ 有会话时排列照旧成功', r4.summary?.ok === true, r4.summary?.message);
  const r5 = await sync.showWindows();
  check('④ show 不给 ids → source=session、两个窗口都过', r5.source === 'session' && (r5.shown || []).length === 2,
    `${r5.source} / ${(r5.shown || []).length}`);
  const r6 = await sync.unifySize();
  check('④ unifySize 不给 ids → source=session、参考窗口是主窗口',
    r6.source === 'session' && r6.reference_id === started[0],
    `${r6.source} ref=${String(r6.reference_id).slice(0, 8)} master=${started[0].slice(0, 8)}`);

  /* ------------------ 静态：解绑路径里没有起内核 / 没有无条件的 throw ------------------ */
  console.log('\n— 静态：解绑路径不许出现 startProfile / 起内核；四个函数里没有无条件的 if (!current) throw —');
  const src = fs.readFileSync(new URL('../src/sync/session.js', import.meta.url), 'utf8');
  const bodyOf = (name) => {
    const i = src.indexOf(`export async function ${name}`);
    if (i < 0) return '';
    const j = src.indexOf('\nexport ', i + 10);
    return src.slice(i, j < 0 ? undefined : j);
  };
  const four = ['arrangeWindows', 'showWindows', 'forceShowWindows', 'unifySize'];
  for (const name of four) {
    const body = bodyOf(name);
    check(`静态 ${name}：没有无条件的 if (!current) throw`, !!body && !/if \(!current\)\s*throw/.test(body));
    check(`静态 ${name}：没有起内核的调用`,
      !!body && !/startProfile|launchChrome|spawn\(|connectInstance\(/.test(body),
      (body.match(/startProfile|launchChrome|spawn\(|connectInstance\(/g) || []).join(','));
  }
  const resolveBody = (() => {
    const i = src.indexOf('async function resolveWindows');
    const j = src.indexOf('\nasync function pageSessionOf', i);
    return src.slice(i, j);
  })();
  check('静态 resolveWindows：用 getInstance 复用已连客户端，不新开连接',
    /getInstance\(/.test(resolveBody) && !/connectInstance\(/.test(resolveBody));
} catch (e) {
  console.log('异常：', e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : e);
  check('整体跑通（无异常）', false, String(e && e.message));
} finally {
  try { await sync.stopSync(); } catch { /* ignore */ }
  const withTimeout = (p, ms = 8000) => Promise.race([Promise.resolve(p).catch(() => {}), sleep(ms)]);
  for (const id of started) {
    try { await withTimeout(manager.stopProfile(id)); } catch { /* ignore */ }
    try { profiles.deleteProfiles([id]); } catch { /* ignore */ }
  }
  try { server.close(); } catch { /* ignore */ }
  try { srv.closeAllConnections?.(); } catch { /* ignore */ }
  try { srv.close(); } catch { /* ignore */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail}/${results.length} 通过`);
process.exit(fail ? 1 : 0);
