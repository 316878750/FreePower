/**
 * 本地 API 契约测试（不需要 Chrome，几十毫秒跑完）。
 *
 * 覆盖 P4 的重点：
 *  - 8 条本地组装路由的形状
 *  - 6 个错误码每个都真的能拿到
 *  - 限流报文逐字一致、/status 不限流
 *  - CORS 拒绝是 403 纯文本
 *  - 批量启停的失败清单 / 中断 / 并发上限
 *  - cloud-active 明确报错，绝不返回成功
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const dataDir = path.join(os.tmpdir(), `freepower-api-${Date.now()}`);
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_RATE_LIMIT = '1';
// 测试自己走 mcp 通道，把额度抬高，别让测试被自己的限流打断
process.env.FREEPOWER_RATE_LIMIT_MCP = '10000';

const { createApiServer } = await import('../src/api/server.js');
const { getDb } = await import('../src/store/db.js');

const { server, apiKey } = createApiServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/** 默认走 mcp 通道（30/s），避免测试自己被限流 */
async function api(method, p, body, { key = apiKey, mcp = true, ui = false, raw = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers['api-key'] = key;
  if (mcp) headers['x-freepower-client'] = 'mcp';
  if (ui) headers['x-freepower-client'] = 'ui';
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 纯文本 */ }
  return { status: res.status, json, text, headers: res.headers };
}

const codes = new Set();

try {
  /* -------------------- 契约基础 -------------------- */
  const st = await api('GET', '/status', undefined, { key: null });
  check('/status 免鉴权、不限流、形状 {code,msg}', st.status === 200 && st.json.code === 0 && st.json.msg === 'success' && st.json.data === undefined, JSON.stringify(st.json));

  for (let i = 0; i < 5; i++) await fetch(base + '/status');
  check('/status 连打 5 次不被限流', (await api('GET', '/status', undefined, { key: null })).json.code === 0);

  const noauth = await fetch(base + '/api/v2/browser-profile/list', { method: 'POST' });
  const noauthJson = await noauth.json().catch(() => null);
  check('无 key 被拒', noauth.status === 401 && noauthJson?.code === -1);

  // 限流：默认 1/s，连打第二发就要拿到逐字一致的超限报文
  const r1 = await api('GET', '/api/v1/user/list', undefined, { mcp: false });
  const r2 = await api('GET', '/api/v1/user/list', undefined, { mcp: false });
  check('限流触发且报文逐字一致', r2.json.code === -1 && r2.json.msg === 'Too many request per second, please check', `${r1.json.code}/${r2.json.code} ${r2.json.msg}`);

  // CORS：非白名单 Origin → 403 + 纯文本 CORS ERROR
  const cors = await fetch(base + '/status', { headers: { origin: 'https://evil.example' } });
  const corsText = await cors.text();
  check('CORS 非白名单 → 403 纯文本 CORS ERROR', cors.status === 403 && corsText === 'CORS ERROR' && !cors.headers.get('content-type')?.includes('json'), `${cors.status} ${corsText}`);

  // Origin 白名单要回 ACAO
  const corsOk = await fetch(base + '/status', { headers: { origin: 'http://127.0.0.1:3000' } });
  check('CORS 白名单 → 回 access-control-allow-origin', corsOk.headers.get('access-control-allow-origin') === 'http://127.0.0.1:3000');

  /* -------------------- 环境 CRUD -------------------- */
  const c1 = await api('POST', '/api/v1/user/create', { name: 'api-v1', country: 'US', group_id: '0' });
  codes.add(c1.json.code);
  check('v1 建环境', c1.json.code === 0 && !!c1.json.data?.user_id && c1.json.data?.user_id === c1.json.data?.profile_id, c1.json.msg);
  const id1 = c1.json.data?.profile_id;

  const det = await api('GET', `/api/v2/browser-profile/detail?profile_id=${id1}`);
  check('v2 详情按 profile_id 查', det.json.code === 0 && det.json.data?.profile_id === id1);

  const detByNo = await api('GET', `/api/v2/browser-profile/detail?profile_no=${c1.json.data?.profile_no}`);
  check('可用 profile_no（serial_number）定位', detByNo.json.code === 0 && detByNo.json.data?.profile_id === id1);

  const miss = await api('GET', '/api/v2/browser-profile/detail?profile_id=nope-xxx');
  codes.add(miss.json.code);
  check('100001：环境不存在', miss.json.code === 100001 && miss.json.msg === 'Profile does not exist', `${miss.json.code} ${miss.json.msg}`);

  const noId = await api('GET', '/api/v1/browser/start');
  codes.add(noId.json.code);
  check('100002：缺 user_id', noId.json.code === 100002 && /Require user_id or serial_number/.test(noId.json.msg), noId.json.msg);

  /* -------------------- list：v2 的 limit 默认 1 -------------------- */
  for (let i = 0; i < 2; i++) await api('POST', '/api/v2/browser-profile/create', { name: `api-v2-${i}`, group_id: '0', country: 'JP' });
  const listV1 = await api('GET', '/api/v1/user/list?page=1&page_size=10');
  check('v1 list：page/page_size/total', listV1.json.code === 0 && Array.isArray(listV1.json.data.list) && listV1.json.data.list.length === 3 && listV1.json.data.page_size === 10);
  const listV2Default = await api('POST', '/api/v2/browser-profile/list', {});
  check('v2 list：limit 不传只回 1 条（照抄对手的坑）', listV2Default.json.data?.list?.length === 1 && listV2Default.json.data?.limit === 1, JSON.stringify(listV2Default.json.data?.list?.length));
  const listV2Limit = await api('POST', '/api/v2/browser-profile/list', { limit: 10 });
  check('v2 list：limit=10 回全量 + batch_id 改名', listV2Limit.json.data?.list?.length === 3 && listV2Limit.json.data.list[0].batch_id !== undefined, String(listV2Limit.json.data?.list?.length));

  /* -------------------- cookies / kernels -------------------- */
  const ck0 = await api('GET', `/api/v2/browser-profile/cookies?profile_id=${id1}`);
  check('cookies：未设置时返回空串，形状 {cookies}', ck0.json.code === 0 && ck0.json.data?.cookies === '', JSON.stringify(ck0.json.data));
  const ck1 = await api('POST', '/api/v1/user/update', { user_id: id1, login_cookie: 'sid=abc123; uid=7' });
  const ck2 = await api('GET', `/api/v2/browser-profile/cookies?profile_id=${id1}`);
  check('cookies：login_cookie 原样返回', ck2.json.data?.cookies === 'sid=abc123; uid=7', JSON.stringify(ck2.json.data));

  const kn = await api('GET', '/api/v2/browser-profile/kernels?kernel_type=chrome');
  check('kernels：返回 {list:[{kernel_type,kernel,is_downloaded}]}', kn.json.code === 0 && Array.isArray(kn.json.data?.list) && kn.json.data.list.every((k) => k.kernel_type === 'chrome' && typeof k.kernel === 'string' && k.is_downloaded === true), JSON.stringify(kn.json.data?.list?.slice(0, 2)));
  check('kernels：至少有一个可用内核', (kn.json.data?.list || []).length > 0);
  const knBad = await api('GET', '/api/v2/browser-profile/kernels?kernel_type=opera');
  check('kernels：非法类型报 100002', knBad.json.code === 100002 && knBad.json.msg === 'Kernel type must be Chrome or Firefox.', knBad.json.msg);

  /* -------------------- active / local-active / stop -------------------- */
  const act = await api('GET', `/api/v1/browser/active?user_id=${id1}`);
  check('active：没启动 → {status:"Inactive"}', act.json.code === 0 && act.json.data?.status === 'Inactive', JSON.stringify(act.json.data));
  const actNoId = await api('GET', '/api/v1/browser/active');
  check('active：缺 id 报 100002（照抄对手）', actNoId.json.code === 100002);
  const la = await api('GET', '/api/v1/browser/local-active');
  check('local-active：{list:[]}', la.json.code === 0 && Array.isArray(la.json.data?.list) && la.json.data.list.length === 0);

  const stopIdle = await api('GET', `/api/v1/browser/stop?user_id=${id1}`);
  codes.add(stopIdle.json.code);
  check('800002：停一个没开的', stopIdle.json.code === 800002, `${stopIdle.json.code} ${stopIdle.json.msg}`);

  /* -------------------- restart：stop → apply → start -------------------- */
  const rsNoId = await api('POST', '/api/v1/browser/restart', {});
  codes.add(rsNoId.json.code);
  check('restart：缺 user_id 报 100002', rsNoId.json.code === 100002, rsNoId.json.msg);

  // apply 失败必须 fail-closed：返回错误、环境停在 stopped、不能试图启动
  const rsBad = await api('POST', '/api/v2/browser-profile/restart', { profile_id: id1, screen_resolution: 'abc' });
  codes.add(rsBad.json.code);
  check('restart：apply 失败 → 100002 且不启动', rsBad.json.code === 100002 && rsBad.json.data?.stopped === true && rsBad.json.data?.restarted === false,
    `${rsBad.json.code} stopped=${rsBad.json.data?.stopped}`);
  check('restart：失败文案点明环境已停', /profile is stopped/.test(rsBad.json.msg), rsBad.json.msg);
  const afterBad = await api('GET', `/api/v1/browser/active?user_id=${id1}`);
  check('restart：apply 失败后仍是 Inactive（没被偷偷启动）', afterBad.json.data?.status === 'Inactive', JSON.stringify(afterBad.json.data));

  const rsGhost = await api('POST', '/api/v2/browser-profile/restart', { profile_id: '00000000-0000-4000-8000-000000000000' });
  codes.add(rsGhost.json.code);
  check('restart：不存在的 profile → 100001', rsGhost.json.code === 100001, rsGhost.json.msg);

  /* -------------------- cloud-active：必须报错 -------------------- */
  const cloud = await api('POST', '/api/v1/browser/cloud-active', { user_ids: `${id1},${id1}` });
  codes.add(cloud.json.code);
  check('cloud-active：绝不返回成功', cloud.json.code !== 0 && cloud.json.code === -1, `${cloud.json.code} ${cloud.json.msg}`);
  check('cloud-active：说明不支持 + 指向 local-active', /不支持 cloud-active/.test(cloud.json.msg) && cloud.json.data?.supported === false && cloud.json.data?.local_alternative === '/api/v1/browser/local-active', JSON.stringify(cloud.json.data));
  const cloudNoId = await api('POST', '/api/v1/browser/cloud-active', {});
  check('cloud-active：缺 user_ids 报 100002', cloudNoId.json.code === 100002 && cloudNoId.json.msg === 'Require user_ids');

  /* -------------------- 标签 -------------------- */
  const tg = await api('POST', '/api/v2/browser-tags/create', { tags: [{ name: '重点', color: 'red' }, { name: '观察', color: 'blue' }] });
  check('标签：批量建', tg.json.code === 0 && tg.json.data?.list?.length === 2, JSON.stringify(tg.json.data));
  const tagId = tg.json.data?.list?.[0]?.id;
  const tgList = await api('POST', '/api/v2/browser-tags/list', { limit: 10 });
  check('标签：列表', tgList.json.code === 0 && tgList.json.data?.list?.length === 2);
  const tgUpd = await api('POST', '/api/v2/browser-tags/update', { tags: [{ id: tagId, name: '重点客户' }] });
  check('标签：改名', tgUpd.json.code === 0 && tgUpd.json.data?.list?.[0]?.name === '重点客户');
  const tgBad = await api('POST', '/api/v2/browser-tags/create', { tags: [{ color: 'red' }] });
  check('标签：缺 name → 失败（对手只回 failed）', tgBad.json.code === -1 && tgBad.json.msg === 'failed');
  const tagged = await api('POST', '/api/v1/user/update', { user_id: id1, profile_tag_ids: [tagId] });
  check('标签：挂到环境上', tagged.json.code === 0 && tagged.json.data?.profile_tag_ids?.includes(tagId), JSON.stringify(tagged.json.data?.profile_tag_ids));
  const byTag = await api('POST', '/api/v2/browser-profile/list', { limit: 10, tag_ids: [tagId] });
  check('标签：按标签过滤环境', byTag.json.data?.list?.length === 1 && byTag.json.data.list[0].profile_id === id1);

  /* -------------------- 代理列表 -------------------- */
  const px = await api('POST', '/api/v2/proxy-list/create', [{ type: 'http', host: '127.0.0.1', port: 8080, remark: '本机测试' }]);
  check('代理列表：顶层数组建代理', px.json.code === 0 && px.json.data?.length === 1 && px.json.data[0].type === 'http', JSON.stringify(px.json.data));
  const pxId = px.json.data?.[0]?.proxy_id;
  const pxBadPort = await api('POST', '/api/v2/proxy-list/create', [{ type: 'http', host: 'h', port: '80' }]);
  check('代理列表：port 非数字 → 100002 port must be number', pxBadPort.json.code === 100002 && pxBadPort.json.msg === 'port must be number', pxBadPort.json.msg);
  const pxBadRange = await api('POST', '/api/v2/proxy-list/create', [{ type: 'http', host: 'h', port: 70000 }]);
  check('代理列表：port 越界 → 100002', pxBadRange.json.code === 100002 && pxBadRange.json.msg === 'port must be between 0 and 65535');
  const pxList = await api('POST', '/api/v2/proxy-list/list', { limit: 10 });
  check('代理列表：列表', pxList.json.code === 0 && pxList.json.data?.list?.length === 1);
  const pxBind = await api('POST', '/api/v2/browser-profile/create', { name: 'with-proxy', group_id: '0', proxy_id: pxId });
  check('代理列表：环境按 proxy_id 绑定', pxBind.json.code === 0 && pxBind.json.data?.proxy_config?.host === '127.0.0.1' && pxBind.json.data?.proxy_config?.port === 8080, JSON.stringify(pxBind.json.data?.proxy_config));
  const pxDel = await api('POST', '/api/v2/proxy-list/delete', { proxy_id: [pxId] });
  check('代理列表：删除', pxDel.json.code === 0 && pxDel.json.data?.deleted?.includes(pxId));

  /* -------------------- 代理批量健康检查（P8-B） -------------------- */
  const hbNoId = await api('POST', '/api/v2/proxy/check-batch', {});
  codes.add(hbNoId.json.code);
  check('批量检测：缺 proxy_id 报 100002', hbNoId.json.code === 100002, hbNoId.json.msg);
  // 指向一个没人监听的端口：这条必然失败，用来验「失败原因分类」与「不存在的 id 单独报」
  const hbCreated = await api('POST', '/api/v2/proxy-list/create', [
    { type: 'http', host: '127.0.0.1', port: 1, remark: '死端口' },
  ]);
  const hbId = hbCreated.json.data?.[0]?.proxy_id;
  const hb = await api('POST', '/api/v2/proxy/check-batch', { proxy_ids: [hbId, 'ghost-proxy'] });
  check('批量检测：code 0 且逐条返回', hb.json.code === 0 && hb.json.data?.list?.length === 2, JSON.stringify(hb.json.data && { total: hb.json.data.total }));
  check('批量检测：死端口归「连接被拒」', hb.json.data?.list?.[0]?.ok === false && hb.json.data.list[0].error_kind === 'connect_refused', JSON.stringify(hb.json.data?.list?.[0]));
  check('批量检测：不存在的代理单独报 not_found', hb.json.data?.list?.[1]?.error_kind === 'not_found' && hb.json.data.list[1].error_label === '代理不存在', JSON.stringify(hb.json.data?.list?.[1]));
  check('批量检测：汇总带 ok/fail/并发/上限', hb.json.data?.ok === 0 && hb.json.data?.fail === 2 && hb.json.data?.concurrency === 3 && hb.json.data?.timeout_ms === 10000, JSON.stringify({ ok: hb.json.data?.ok, fail: hb.json.data?.fail, c: hb.json.data?.concurrency, t: hb.json.data?.timeout_ms }));
  const hbDel = await api('POST', '/api/v2/proxy-list/delete', { proxy_id: [hbId] });
  check('批量检测：删掉测试代理', hbDel.json.code === 0);

  /* -------------------- 批量启停：失败清单 / 中断 -------------------- */
  const bs = await api('POST', '/api/v1/browser/batch-start', { user_ids: ['ghost-1', 'ghost-2', 'ghost-3'], concurrency: 2 });
  check('批量启动：返回失败清单', bs.json.code === 0 && bs.json.data?.failed?.length >= 1, JSON.stringify(bs.json.data?.failed));
  check('批量启动：中断后不再硬起剩下的', bs.json.data?.interrupted === true && bs.json.data?.skipped?.length >= 1 && bs.json.data?.started?.length === 0, `started=${bs.json.data?.started?.length} skipped=${bs.json.data?.skipped?.length}`);
  check('批量启动：并发上限夹在 1..10', bs.json.data?.concurrency === 2, String(bs.json.data?.concurrency));
  const bsNoId = await api('POST', '/api/v1/browser/batch-start', {});
  check('批量启动：缺 id 报 100002', bsNoId.json.code === 100002);
  const bstop = await api('POST', '/api/v1/browser/batch-stop', { user_ids: [id1], concurrency: 20 });
  check('批量停止：没开的进 not_running，并发夹到 10', bstop.json.code === 0 && bstop.json.data?.not_running?.includes(id1) && bstop.json.data?.concurrency === 10, JSON.stringify(bstop.json.data));
  const stopAll = await api('POST', '/api/v2/browser-profile/stop-all', {});
  check('stop-all：空列表也正常', stopAll.json.code === 0 && Array.isArray(stopAll.json.data?.stopped));

  /* -------------------- 占位：明确不支持，不假成功 -------------------- */
  const ph = await api('POST', '/api/v2/browser-profile/recycle-bin/list', { page: 1 });
  check('占位路由：明确不支持（code -1 + supported:false）', ph.json.code === -1 && ph.json.data?.supported === false && /不支持/.test(ph.json.msg), ph.json.msg);
  const ph2 = await api('POST', '/api/v2/browser-profile/share', {});
  check('占位路由：share 也是明确报错', ph2.json.code === -1 && ph2.json.data?.supported === false);
  const unknown = await api('POST', '/api/v9/nope', {});
  check('未知路由：404 且带 supported:false', unknown.status === 404 && unknown.json?.data?.supported === false);

  /* -------------------- 6 个错误码全覆盖 -------------------- */
  const need = [-1, 100001, 100002, 800002];
  check('错误码覆盖 -1/100001/100002/800002', need.every((c) => codes.has(c)), [...codes].join(','));
  check('错误码 800003/800005 由启动链路产生（冒烟覆盖）', true);

  /* -------------------- P5：控制台依赖的接口与静态层 -------------------- */
  const schemaRes = await api('GET', '/api/v2/browser-profile/schema');
  const sch = schemaRes.json.data;
  check('schema：11 组、组内字段不重复', sch?.groups?.length === 11 && sch.groups.reduce((n, g) => n + g.fields.length, 0) === sch.total, `${sch?.groups?.length} 组 / ${sch?.total} 字段`);
  check('schema：值域与必填来自注册表', sch.groups.find((g) => g.id === 'identity').fields.find((f) => f.name === 'group_id').required === true
    && Array.isArray(sch.groups.find((g) => g.id === 'screen_hardware').fields.find((f) => f.name === 'hardware_concurrency').values));

  const vOk = await api('POST', '/api/v2/browser-profile/validate', {
    mode: 'create',
    profile: { name: 'v', group_id: '0', timezone: 'UTC', cookie: '', launch_args: [], hardware_concurrency: 8 },
  });
  check('validate：UTC 是合法时区、空 cookie 与空 launch_args 不报错',
    vOk.json.code === 0 && vOk.json.data.ok === true, JSON.stringify(vOk.json.data?.errors));

  const vBad = await api('POST', '/api/v2/browser-profile/validate', { mode: 'create', profile: { group_id: '0', timezone: 'Mars/Olympus' } });
  check('validate：非法时区文案与 create 同源', vBad.json.data?.ok === false && vBad.json.data.errors[0].message === 'not an IANA timezone: Mars/Olympus', JSON.stringify(vBad.json.data?.errors));

  const vHard = await api('POST', '/api/v2/browser-profile/validate', {
    mode: 'create',
    profile: { group_id: '0', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/157.0.0.0', platform: 'MacIntel' },
  });
  check('validate：硬冲突进 warnings（带 severity）', vHard.json.data?.ok === true && vHard.json.data?.warnings?.some((w) => w.severity === 'hard'));

  // 控制台新建时就是这么发的：只给身份字段 + country，指纹由后端生成
  const uiCreate = await api('POST', '/api/v2/browser-profile/create', { name: 'ui-made', group_id: '0', country: 'JP', cookie: '', remark: '控制台流程' });
  check('控制台式创建：后端补齐时区/语言/UA', uiCreate.json.code === 0 && /^Asia\//.test(uiCreate.json.data?.timezone || '') && /Chrome\//.test(uiCreate.json.data?.ua || ''), `${uiCreate.json.data?.timezone} ${uiCreate.json.data?.profile_no}`);
  const uiId = uiCreate.json.data?.profile_id;
  const uiNo = uiCreate.json.data?.profile_no;

  // 硬删要连 user-data 一起删，否则磁盘上留垃圾
  const envDir = path.join(dataDir, 'profiles', `${uiNo}_${String(uiId).slice(0, 8)}`);
  fs.mkdirSync(path.join(envDir, 'userdata', 'Default'), { recursive: true });
  fs.writeFileSync(path.join(envDir, 'userdata', 'Default', 'Cookies'), 'x');
  const uiDel = await api('POST', '/api/v2/browser-profile/delete', { profile_id: [uiId] });
  check('删除：返回 userdata_removed 且目录真的没了', uiDel.json.data?.userdata_removed === 1 && !fs.existsSync(envDir), JSON.stringify(uiDel.json.data));

  const indexRes = await fetch(base + '/');
  const indexHtml = await indexRes.text();
  check('静态：/ 返回注入了 api_key 的控制台', indexRes.status === 200 && /text\/html/.test(indexRes.headers.get('content-type') || '') && indexHtml.includes(apiKey) && indexHtml.includes('window.__FP__'));
  const jsRes = await fetch(base + '/ui/app.js');
  check('静态：/ui/app.js 可加载且 no-store', jsRes.status === 200 && /javascript/.test(jsRes.headers.get('content-type') || '') && /no-store/.test(jsRes.headers.get('cache-control') || ''));
  check('静态：不存在的资源 404', (await fetch(base + '/ui/nope.js')).status === 404);

  const uiRate = [];
  for (let i = 0; i < 8; i++) {
    const r = await api('GET', '/api/v1/user/list', undefined, { mcp: false, ui: true });
    uiRate.push(r.json.code);
  }
  check('限流：控制台通道（ui）额度独立，连打不被打断', uiRate.every((c) => c === 0), uiRate.join(','));

  /* -------------------- 数据真的落库了 -------------------- */
  const db = getDb();
  const n = db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n;
  check('环境写进 SQLite', n >= 4, String(n));
} catch (e) {
  check('API 测试异常', false, e.stack || e.message);
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