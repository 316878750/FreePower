/**
 * 应用中心（0.4.3 ①）判据 —— B 层：**真内核**（本机 Google Chrome 157.0.8103.78）。
 *
 * 这一段只回答一个问题：**勾了扩展，环境启动后浏览器里真的有它吗？** 读数一律不取我们的自述：
 *   - 页面侧：扩展的 content script 会往 `document.documentElement` 写一个标记，读 DOM 属性；
 *   - 浏览器侧：`Target.getTargets` 里有没有该扩展的 service_worker（要 CDP 报的，不是我们算的）。
 *
 * 覆盖：
 *   A. 勾一个扩展 → 启动 → 页面被标记、SW 在线、`/start` 的 `extensions.loaded` 里 chrome_id 等于导入时算的；
 *   B. 同一环境勾两个扩展 → 两个都活着（一次 loadUnpacked 装一个，逐个都要成功）；
 *   C. 取消勾选 → 重启 → 标记消失（**证明「环境级启用」是真的**，不是浏览器自己记着）；
 *   D. 库级停用 → 启动 → 不加载；
 *   E. 目录被人删了 → 启动不崩、`warnings` 里如实说少了哪个。
 *
 * 为什么扩展不是 `--load-extension`：那条在 157 上已经不生效（四组隔离对照实测），
 * 读数与理由写在 `src/kernel/extensions.js` 顶部。这里恰好也**顺带证明**这个结论 ——
 * 我们真的没往命令行塞它，扩展照样起来了。
 *
 * 跑法：node --no-warnings test/apps-kernel.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dataDir = path.join(os.tmpdir(), `freepower-apps-k-${Date.now()}`);
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
process.env.FREEPOWER_EGRESS_TIMEOUT = '800';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 一个真能跑的 MV3 扩展：content script 写 DOM 标记，SW 只留个标记 */
function makeExt(dir, name, { mark, version = '1.0.0' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name,
    version,
    background: { service_worker: 'sw.js' },
    content_scripts: [{ matches: ['http://*/*'], js: ['content.js'], run_at: 'document_start' }],
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'sw.js'), `self.__fpSw = ${JSON.stringify(mark)};`);
  fs.writeFileSync(path.join(dir, 'content.js'),
    `document.documentElement.setAttribute('data-fp-ext', ${JSON.stringify(mark)});`);
  return dir;
}

const srcRoot = path.join(dataDir, '_src');
const extOne = makeExt(path.join(srcRoot, 'one'), 'FP One', { mark: 'one' });
const extTwo = makeExt(path.join(srcRoot, 'two'), 'FP Two', { mark: 'two', version: '2.0.0' });
const extDead = makeExt(path.join(srcRoot, 'dead'), 'FP Dead', { mark: 'dead' });

/* 页面服务器：探针只读 DOM 属性，不需要任何接口 */
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><title>fp-apps-${String(req.url || '/').slice(1) || 'p'}</title><h1>probe</h1>`);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PAGE = `http://127.0.0.1:${srv.address().port}/p`;

const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');
const ext = await import('../src/store/extensions.js');
const dbmod = await import('../src/store/db.js');

const started = [];
let profileId = null;

/** 开一张真页面，读扩展 content script 写下的标记 */
async function markOf(id) {
  const inst = manager.getInstance(id);
  const { targetId, sessionId } = await inst.openPage(PAGE);
  await sleep(1200);
  try {
    const r = await inst.client.send('Runtime.evaluate', {
      expression: 'document.documentElement.getAttribute("data-fp-ext")',
      returnByValue: true,
    }, sessionId);
    return r?.result?.value ?? null;
  } finally {
    await inst.closePage(targetId).catch(() => {});
  }
}

/** CDP 报回来的 service_worker 扩展 id 集合 */
async function serviceWorkerIds(id) {
  const inst = manager.getInstance(id);
  const { targetInfos } = await inst.client.send('Target.getTargets');
  return (targetInfos || [])
    .filter((t) => t.type === 'service_worker' && String(t.url).startsWith('chrome-extension://'))
    .map((t) => String(t.url).split('/')[2]);
}

async function restart(id) {
  await manager.stopProfile(id);
  await sleep(600);
  return manager.startProfile(profiles.getProfile(id));
}

try {
  {
    const p = profiles.createProfile({ name: `apps-kernel-${Date.now()}`, group_id: '0', remark: '应用中心 B 层判据' });
    profileId = p.profile_id;
    started.push(profileId);

    const one = ext.importExtension(extOne).extension;
    const two = ext.importExtension(extTwo).extension;
    const dead = ext.importExtension(extDead).extension;
    console.log(`扩展：one=${one.id}/${one.unique_id} two=${two.id}/${two.unique_id}`);

    /* ---------------- A. 勾一个：真的装进浏览器 ---------------- */
    console.log('\n— A. 勾一个扩展 → 启动 → 页面被标记、SW 在线 —');
    ext.setProfileExtensions(profileId, [one.id]);
    let st = await manager.startProfile(profiles.getProfile(profileId));
    console.log(`  内核 ${st.real_version} · 命令行含 --load-extension: ${String(st.args || '').includes('--load-extension')}`);

    check('启动结果里如实报了加载了几个扩展',
      st.extensions && st.extensions.requested === 1 && st.extensions.loaded.length === 1 && st.extensions.failed.length === 0,
      JSON.stringify(st.extensions));
    check('加载到的 chrome_id 等于导入时按路径推算的 ID（推算算法被真内核认了）',
      st.extensions?.loaded?.[0]?.chrome_id === one.unique_id,
      `${st.extensions?.loaded?.[0]?.chrome_id} vs ${one.unique_id}`);
    check('命令行里没有 --load-extension（扩展不是靠它装的）',
      !String(st.args || '').includes('--load-extension'));

    const swA = await serviceWorkerIds(profileId);
    check('CDP 的 service_worker 列表里有这个扩展', swA.includes(one.unique_id), swA.join(','));

    const markA = await markOf(profileId);
    check('真页面被 content script 标记了（扩展确实在工作，不是只注册成功）', markA === 'one', String(markA));

    /* ---------------- B. 勾两个：都要活着 ---------------- */
    console.log('\n— B. 同一环境勾两个扩展 → 两个都要真的活 —');
    ext.setProfileExtensions(profileId, [one.id, two.id]);
    st = await restart(profileId);
    check('两个都报了加载成功', st.extensions?.loaded?.length === 2 && st.extensions.failed.length === 0,
      JSON.stringify(st.extensions?.loaded?.map((x) => x.name)));
    const swB = await serviceWorkerIds(profileId);
    check('两个扩展的 service_worker 同时在线',
      swB.includes(one.unique_id) && swB.includes(two.unique_id), swB.join(','));
    // content script 谁后跑谁覆盖属性：只要页面上的标记属于这两个之一就说明两个都注进去了
    const markB = await markOf(profileId);
    check('页面标记来自这个环境勾的扩展之一', markB === 'one' || markB === 'two', String(markB));

    /* ---------------- C. 取消勾选 → 重启 → 没了 ---------------- */
    console.log('\n— C. 取消勾选 → 重启 → 扩展不再加载（环境级启用是真的） —');
    ext.setProfileExtensions(profileId, []);
    st = await restart(profileId);
    check('重启后一个都没加载（extensions 为空）',
      st.extensions === null || st.extensions.loaded.length === 0, JSON.stringify(st.extensions));
    const markC = await markOf(profileId);
    check('真页面上再没有扩展标记（不是浏览器自己记着）', markC === null, String(markC));
    const swC = await serviceWorkerIds(profileId);
    check('两个扩展的 SW 都不在了',
      !swC.includes(one.unique_id) && !swC.includes(two.unique_id), swC.join(','));

    /* ---------------- D. 库级停用 → 不加载 ---------------- */
    console.log('\n— D. 勾着但库里停用 → 不加载 —');
    ext.setProfileExtensions(profileId, [one.id]);
    ext.updateExtension(one.id, { status: '0' });
    st = await restart(profileId);
    check('库级停用后重启：一个都没加载',
      st.extensions === null || st.extensions.loaded.length === 0, JSON.stringify(st.extensions));
    const markD = await markOf(profileId);
    check('页面无标记', markD === null, String(markD));
    ext.updateExtension(one.id, { status: '1' });

    /* ---------------- E. 目录被删 → 不崩，如实告警 ---------------- */
    console.log('\n— E. 扩展目录被删了 → 启动不崩，告警里点名 —');
    ext.setProfileExtensions(profileId, [dead.id]);
    fs.rmSync(path.join(dataDir, 'ext_env', dead.id), { recursive: true, force: true });
    st = await restart(profileId);
    check('启动成功（目录没了不等于环境起不来）',
      !!st.real_version && Number(st.pid) > 0, `pid=${st.pid} 内核 ${st.real_version}`);
    const warns = (st.warnings || []).map((w) => `${w.field}: ${w.message}`);
    check('warnings 里指名道姓说哪个扩展的目录不见了',
      warns.some((w) => w.startsWith('extensions:') && w.includes('FP Dead')), warns.filter((w) => w.includes('扩展')).join(' | '));
  }
} catch (e) {
  check('B 层跑完没有抛异常', false, `${e && e.message}`);
  console.error(e);
} finally {
  for (const id of started) await manager.stopProfile(id).catch(() => {});
  srv.close();
  dbmod.closeDb();
  await sleep(300);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄还在，留给系统 */ }
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
