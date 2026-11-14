/**
 * 「API & MCP」（0.4.2）的判据。
 *
 * 覆盖四组，全部离线、不需要 Chrome：
 *   1. 端点自述：数量来自 buildRoutes()、每条有说明、不支持的如实标出；
 *   2. API 验证开关：关掉不校验 key、打开恢复 401（两条方向都要测，只测一边等于没测）；
 *   3. key 重置：库里换、发现文件换、本进程立刻按新 key 校验；
 *   4. MCP server（真起子进程、真走 stdio JSON-RPC）+ CLI（真起子进程）。
 * 另加页面模块的纯函数（loadState / mcpConfig / maskKey）—— 401 与 200 两条分支。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const dataDir = path.join(os.tmpdir(), `freepower-apimcp-${Date.now()}`);
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_RATE_LIMIT = '1';
// 测试自己走 mcp 通道（30/s），别被自己的限流打断
process.env.FREEPOWER_RATE_LIMIT_MCP = '10000';

const { createApiServer } = await import('../src/api/server.js');
const { buildRoutes } = await import('../src/api/routes.js');

const { server, apiKey: initialKey } = createApiServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const base = `http://127.0.0.1:${PORT}`;
let apiKey = initialKey;

async function call(method, p, body, { key = apiKey, mcp = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers['api-key'] = key;
  if (mcp) headers['x-freepower-client'] = 'mcp';
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 纯文本 */ }
  return { status: res.status, json, text };
}

/**
 * 跑 CLI 子进程。
 * **不能用 spawnSync**：被测试的服务就跑在本进程里，spawnSync 会阻塞事件循环，
 * 服务没法回包，CLI 只能等到超时 —— 那是测试自己造的假失败。
 */
function runCli(argv, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'bin', 'fp.mjs'), ...argv], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { err += c.toString('utf8'); });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 20000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, stdout: out, stderr: err }); });
  });
}

/** MCP stdio 客户端：一行一条 JSON-RPC */
function startMcp(env) {
  const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'mcp', 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const waiters = new Map();
  const stderr = [];
  child.stderr.on('data', (c) => stderr.push(c.toString('utf8')));
  child.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });
  const request = (obj, timeoutMs = 10000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`MCP 超时：${obj.method}`)), timeoutMs);
    waiters.set(obj.id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(`${JSON.stringify(obj)}\n`);
  });
  const close = () => { try { child.stdin.end(); } catch { /* ignore */ } try { child.kill(); } catch { /* ignore */ } };
  return { child, request, close, stderr };
}

try {
  /* -------------------- 1. 端点自述 -------------------- */
  const noKeyInfo = await call('GET', '/api/v2/api/info', undefined, { key: null });
  check('无 key 读 /api/v2/api/info → 401（验证默认开）', noKeyInfo.status === 401 && noKeyInfo.json?.code === -1, `${noKeyInfo.status}`);

  const info = await call('GET', '/api/v2/api/info');
  const d = info.json?.data;
  check('带 key 读自述：code 0 且字段齐', info.json?.code === 0
    && typeof d?.port === 'number' && typeof d?.api_key === 'string'
    && typeof d?.verify === 'boolean' && !!d?.stats && Array.isArray(d?.endpoints), JSON.stringify(Object.keys(d || {})));
  check('自述里的端口 = 这次请求实际端口', d?.port === PORT, `${d?.port} vs ${PORT}`);
  check('自述里的 url 指向 127.0.0.1', d?.url === `http://127.0.0.1:${PORT}/`, d?.url);

  const realRoutes = buildRoutes();
  check('端点数量 = 同一次 buildRoutes().length（页面与路由表同源）',
    d?.endpoints?.length === realRoutes.length && d?.endpoint_total === realRoutes.length,
    `页面 ${d?.endpoints?.length} / 路由表 ${realRoutes.length}`);
  check('清单里包含本页自己这条（自洽，不是截断过的）',
    d.endpoints.some((e) => e.path === '/api/v2/api/info'));

  const missingDesc = d.endpoints.filter((e) => !e.desc || !String(e.desc).trim());
  check('每条端点都有说明（没有空说明）', missingDesc.length === 0, `${missingDesc.length} 条缺说明`);
  check('说明是中文（不是把路径原样贴回来）',
    d.endpoints.filter((e) => /[\u4e00-\u9fa5]/.test(e.desc)).length > d.endpoints.length * 0.9,
    `${d.endpoints.filter((e) => /[\u4e00-\u9fa5]/.test(e.desc)).length}/${d.endpoints.length}`);
  check('每条端点都有 methods / path / group / supported',
    d.endpoints.every((e) => Array.isArray(e.methods) && e.methods.length && e.path && e.group && typeof e.supported === 'boolean'));
  check('分组不止一个（页面能按分组筛）', new Set(d.endpoints.map((e) => e.group)).size >= 5,
    String(new Set(d.endpoints.map((e) => e.group)).size));

  const unsupported = d.endpoints.filter((e) => e.supported === false);
  check('「明确不支持」的路由被标出来（不是 0 条，也不是全标）',
    unsupported.length > 0 && unsupported.length < d.endpoints.length / 4, `${unsupported.length} 条`);
  const un1 = await call('GET', '/api/v2/user/list');
  check('标了 supported:false 的路由真的报不支持',
    un1.json?.code === -1 && un1.json?.data?.supported === false, `${un1.json?.code}`);

  /* -------------------- 2. 建两个环境（给 MCP / CLI 用真实数据） -------------------- */
  const p1 = await call('POST', '/api/v2/browser-profile/create', { name: 'mcp-alpha', group_id: '0', country: 'JP' });
  const p2 = await call('POST', '/api/v2/browser-profile/create', { name: 'mcp-beta', group_id: '0', country: 'US' });
  check('准备数据：建了 2 个环境', p1.json?.code === 0 && p2.json?.code === 0);

  /* -------------------- 3. MCP server -------------------- */
  const mcp = startMcp({ FREEPOWER_PORT: String(PORT), FREEPOWER_API_KEY: apiKey, FREEPOWER_DATA: dataDir });
  try {
    const init = await mcp.request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    check('MCP initialize：回协议版本 + serverInfo',
      init.result?.protocolVersion === '2024-11-05' && init.result?.serverInfo?.name === 'freepower' && !!init.result?.capabilities?.tools,
      JSON.stringify(init.result?.serverInfo));

    const tl = await mcp.request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = tl.result?.tools || [];
    const names = tools.map((t) => t.name);
    check('MCP tools/list：至少 8 个工具且都有 inputSchema',
      tools.length >= 8 && tools.every((t) => t.name && t.description && t.inputSchema), names.join(','));
    check('MCP 工具覆盖：列环境 / 启停 / 建环境 / 换指纹 / 代理',
      ['list_profiles', 'start_profile', 'stop_profile', 'create_profile', 'new_fingerprint', 'list_proxies'].every((n) => names.includes(n)), names.join(','));

    const listed = await mcp.request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_profiles', arguments: { limit: 20 } } });
    const payloadText = listed.result?.content?.[0]?.text || '';
    let payload = null;
    try { payload = JSON.parse(payloadText); } catch { /* 非 JSON */ }
    check('MCP tools/call list_profiles：拿到真实环境数据',
      listed.result?.isError === false && payload?.total === 2
      && payload.list.some((p) => p.name === 'mcp-alpha') && payload.list.some((p) => p.name === 'mcp-beta'),
      `total=${payload?.total} names=${(payload?.list || []).map((p) => p.name).join(',')}`);

    const unknown = await mcp.request({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } });
    check('MCP 未知工具 → isError（不是协议层 error）',
      unknown.result?.isError === true && !unknown.error, JSON.stringify(unknown.result?.content?.[0]?.text || '').slice(0, 80));

    const badId = await mcp.request({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_profile', arguments: { profile_id: 'does-not-exist' } } });
    check('MCP 工具真报错时透传原因（不假装成功）',
      badId.result?.isError === true && /Profile does not exist/.test(badId.result?.content?.[0]?.text || ''),
      (badId.result?.content?.[0]?.text || '').slice(0, 80));

    const badMethod = await mcp.request({ jsonrpc: '2.0', id: 6, method: 'no/such', params: {} });
    check('MCP 未知方法 → JSON-RPC -32601', badMethod.error?.code === -32601, String(badMethod.error?.code));
  } finally {
    mcp.close();
  }

  /* -------------------- 4. CLI -------------------- */
  const cli = await runCli(['list', '--port', String(PORT), '-k', apiKey]);
  check('CLI `fp list`：退出码 0 且列出真实环境',
    cli.status === 0 && cli.stdout.includes('mcp-alpha') && cli.stdout.includes('共 2 个'),
    `exit=${cli.status} out=${(cli.stdout || '').replace(/\s+/g, ' ').slice(0, 90)}`);

  const cliStatus = await runCli(['status', '--port', String(PORT), '-k', apiKey]);
  check('CLI `fp status`：退出码 0 且报在线 + 运行中数量',
    cliStatus.status === 0 && /在线/.test(cliStatus.stdout) && /运行中\s+0 个/.test(cliStatus.stdout),
    (cliStatus.stdout || '').replace(/\s+/g, ' ').slice(0, 90));

  // 没有 key 又没有发现文件 → 必须失败并给提示（不能静默成功）
  const emptyData = path.join(os.tmpdir(), `freepower-apimcp-empty-${Date.now()}`);
  fs.mkdirSync(emptyData, { recursive: true });
  const cliNoKey = await runCli(['list', '--port', String(PORT)], { FREEPOWER_DATA: emptyData, FREEPOWER_API_KEY: '' });
  check('CLI 没有 key 时如实失败（退出码非 0 + 提示怎么给 key）',
    cliNoKey.status !== 0 && /API key/.test(cliNoKey.stderr || ''), `exit=${cliNoKey.status} err=${(cliNoKey.stderr || '').slice(0, 60)}`);
  fs.rmSync(emptyData, { recursive: true, force: true });

  /* -------------------- 5. API 验证开关（两个方向） -------------------- */
  const badToggle = await call('POST', '/api/v2/api/verify', {});
  check('开关：缺 enabled → 100002', badToggle.json?.code === 100002, String(badToggle.json?.code));

  const off = await call('POST', '/api/v2/api/verify', { enabled: false });
  check('开关：关掉 → 回 verify:false', off.json?.code === 0 && off.json?.data?.verify === false);

  const openList = await call('POST', '/api/v2/browser-profile/list', { limit: 5 }, { key: null });
  check('验证关掉后：不带 key 也能调 API（200 + code 0）',
    openList.status === 200 && openList.json?.code === 0 && openList.json?.data?.total === 2,
    `${openList.status} code=${openList.json?.code}`);

  const openInfo = await call('GET', '/api/v2/api/info', undefined, { key: null });
  check('验证关掉后：自述也免 key 可读，且 verify=false',
    openInfo.json?.code === 0 && openInfo.json?.data?.verify === false);
  check('免验放行有单独计数（用户能看出开关生效了）',
    openInfo.json?.data?.stats?.open >= 2, `open=${openInfo.json?.data?.stats?.open}`);

  const on = await call('POST', '/api/v2/api/verify', { enabled: true });
  check('开关：开回来 → 回 verify:true', on.json?.code === 0 && on.json?.data?.verify === true);
  const backTo401 = await call('POST', '/api/v2/browser-profile/list', { limit: 5 }, { key: null });
  check('验证开回来后：不带 key 又是 401', backTo401.status === 401 && backTo401.json?.code === -1, `${backTo401.status}`);

  /* -------------------- 6. key 重置 -------------------- */
  const statsBefore = (await call('GET', '/api/v2/api/info')).json?.data?.stats;
  const reset = await call('POST', '/api/v2/api/key/reset', {});
  const newKey = reset.json?.data?.api_key;
  check('重置：回了一把新 key（格式 fp_ + 48 位十六进制）',
    reset.json?.code === 0 && typeof newKey === 'string' && /^fp_[0-9a-f]{48}$/.test(newKey), String(newKey).slice(0, 12));
  check('重置：新 key 与旧 key 不同', newKey !== apiKey);

  const oldKeyCall = await call('GET', '/api/v2/browser-profile/list', undefined, { key: apiKey });
  check('重置后：旧 key 立刻失效（401，不用重启）', oldKeyCall.status === 401, `${oldKeyCall.status}`);

  apiKey = newKey;
  const newKeyCall = await call('GET', '/api/v2/browser-profile/list');
  check('重置后：新 key 立刻可用', newKeyCall.json?.code === 0);

  const discovery = fs.readFileSync(path.join(dataDir, 'local_api'), 'utf8');
  check('重置后：data/local_api 里的 key 一起换了（脚本/MCP 才跟得上）',
    discovery.includes(newKey) && !discovery.includes(initialKey), discovery.split('\n')[1]?.slice(0, 16));

  const statsAfter = (await call('GET', '/api/v2/api/info')).json?.data?.stats;
  // 重置请求自己也被计数、然后被 resetStats 抹掉；之后只发生 3 次请求
  // （旧 key 一次 401、新 key 一次 200、这次 info 自己）
  check('重置后计数归零（换了 key 等于换了一个使用阶段）',
    statsBefore?.total >= 15 && statsAfter?.total === 3 && statsAfter?.rejected >= 1,
    `重置前 ${statsBefore?.total} → 重置后 ${statsAfter?.total}（其中拒绝 ${statsAfter?.rejected}）`);

  /* -------------------- 7. 页面模块的纯函数 -------------------- */
  const pageMod = await import('../web/pages/api.js');

  const fake401 = async () => ({ status: 401, ok: false, json: async () => ({ code: -1, msg: 'invalid api_key' }) });
  const r401 = await pageMod.loadState({ fetchImpl: fake401, apiKey: 'bad' });
  check('页面：401 时给出「API Key 无效」提示（不静默空白）',
    r401.ok === false && r401.reason === '401' && /API Key/.test(r401.notice), r401.notice.slice(0, 40));

  const fake200 = async () => ({ status: 200, ok: true, json: async () => ({ code: 0, data: { port: 53380, api_key: 'fp_x', endpoints: [] } }) });
  const r200 = await pageMod.loadState({ fetchImpl: fake200, apiKey: 'ok' });
  check('页面：200 时返回数据（ok:true）', r200.ok === true && r200.data?.port === 53380);

  const fakeNet = async () => { throw new Error('ECONNREFUSED'); };
  const rNet = await pageMod.loadState({ fetchImpl: fakeNet, apiKey: 'x' });
  check('页面：连不上时说的是「服务没在运行」而不是「key 错」',
    rNet.ok === false && rNet.reason === 'network' && /127\.0\.0\.1/.test(rNet.notice), rNet.notice.slice(0, 40));

  const json = pageMod.mcpConfig('claude', { port: 53380, apiKey: 'fp_secret', script: 'C:\\app\\mcp\\server.mjs' });
  let parsed = null;
  try { parsed = JSON.parse(json); } catch { /* 解析失败 */ }
  check('MCP 配置（Claude/Cursor）：是合法 JSON，端口与 key 自动填',
    !!parsed?.mcpServers?.freepower
    && parsed.mcpServers.freepower.env.FREEPOWER_PORT === '53380'
    && parsed.mcpServers.freepower.env.FREEPOWER_API_KEY === 'fp_secret'
    && parsed.mcpServers.freepower.args[0] === 'C:\\app\\mcp\\server.mjs',
    json.split('\n')[2] || '');

  const toml = pageMod.mcpConfig('codex', { port: 53380, apiKey: 'fp_secret', script: 'C:\\app\\mcp\\server.mjs' });
  check('MCP 配置（Codex）：是 TOML 段，反斜杠已转义',
    toml.includes('[mcp_servers.freepower]') && toml.includes('C:\\\\app\\\\mcp\\\\server.mjs')
    && toml.includes('FREEPOWER_API_KEY = "fp_secret"'), toml.split('\n')[2]);

  const masked = pageMod.maskKey('fp_0123456789abcdef0123456789abcdef');
  check('key 打码：露头露尾、不泄露全文',
    masked !== 'fp_0123456789abcdef0123456789abcdef' && masked.startsWith('fp_012') && masked.endsWith('cdef'),
    masked);

  const grouped = pageMod.groupEndpoints([
    { group: '环境', path: '/a' }, { group: '环境', path: '/b' }, { group: '代理', path: '/c' },
  ]);
  check('端点按分组聚合（页面分组表用）', grouped.size === 2 && grouped.get('环境').length === 2, `${grouped.size} 组`);

  /* -------------------- 8. 控制台入口（静态层） -------------------- */
  const home = await fetch(base + '/');
  const homeHtml = await home.text();
  check('侧栏有「API & MCP」入口', homeHtml.includes('data-nav="api"') && homeHtml.includes('#/api'));

  const pageJs = await fetch(base + '/ui/pages/api.js');
  check('/ui/pages/api.js 200 + js 类型',
    pageJs.status === 200 && /javascript/.test(pageJs.headers.get('content-type') || ''),
    `${pageJs.status} ${pageJs.headers.get('content-type')}`);

  const appJs = await (await fetch(base + '/ui/app.js')).text();
  check('app.js 里注册了 #/api 路由', /\/\^\\\/api\$/.test(appJs) || appJs.includes('nav: \'api\''));
} catch (e) {
  check('测试异常', false, e.stack || e.message);
} finally {
  server.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(` - ${f.name}  ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
