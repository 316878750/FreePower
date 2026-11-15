/**
 * `cookie` 字段启动写入 —— B 层：**真内核**（0.4.6）。
 *
 * 为什么要这条：`cookie` 是 txt / xlsx 批量导入最常带的字段。0.4.5 之前启动链路**一次都没读它** ——
 * cookie 存在库里，一启动还是游客态。这种缺陷最典型的表现就是用户说的那句
 * 「导入完，一启动还是没登录」，而所有 A 层判据（存得住、取得出）当时都是绿的。
 *
 * 所以这里判的是**页面自己看得见的东西**，不是「CDP 里存着一条」：
 *   A. 配了 cookie → 启动后 `document.cookie` 里真有它（页面视角，用户视角）；
 *   B. 对照组：不配 cookie 的同类环境 → 同一条 cookie **不在**（否则「在」可能来自别处）；
 *   C. 配了**坏 cookie**（乱码）→ 环境**照样起得来**，日志里有 WARN。
 *      「导入的脏数据把环境锁死」比「cookie 没写进去」更糟，所以这条必须单独钉。
 *
 * 隐私：cookie 是登录凭据，判据里**只断言存在与否**，不打印值；还要反过来断言
 * 「日志里没有那个值」（我们写日志时不许顺手把凭据打出去）。
 *
 * 跑法：node --no-warnings test/login-cookie-kernel.test.mjs   （约 40–60 秒，需本机 Chrome）
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = path.join(os.tmpdir(), `freepower-login-cookie-${Date.now()}`);
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

/* ------------------------------ 判据页（只为了让页面读一次 document.cookie） ------------------------------ */
const srv = http.createServer((req, res) => {
  const p = String(req.url || '/').split('?')[0];
  if (p === '/probe.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>cookie probe</title></head>'
      + '<body><div id="d">probe</div></body></html>');
    return;
  }
  res.writeHead(404);
  res.end('no');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PROBE_URL = `http://127.0.0.1:${srv.address().port}/probe.html`;

const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');
const dbmod = await import('../src/store/db.js');
const { readCookies } = await import('../src/kernel/cookies.js');

/** 探针 cookie：值故意做成一眼能认出来的串，好在日志里反查「有没有被打印出去」 */
const PROBE_NAME = 'fp_probe';
const PROBE_VALUE = 'fp-probe-value-9f3a';
const LOG_DIR = path.join(dataDir, 'logs');
const logText = (id) => {
  const p = path.join(LOG_DIR, `${id}.log`);
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
};

/** 起环境 → 开判据页 → 读回 `document.cookie`（页面视角，等文档真的 load 完） */
async function startAndReadCookie(profileId) {
  const started = await manager.startProfile(profiles.getProfile(profileId));
  const inst = manager.getInstance(profileId);
  const { sessionId } = await inst.openPage(PROBE_URL);
  let doc = '';
  let ready = '';
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const r = await inst.client.send('Runtime.evaluate', {
      expression: 'document.readyState + "|" + document.cookie', returnByValue: true,
    }, sessionId).catch(() => null);
    const v = String(r?.result?.value ?? '');
    if (v.includes('|')) {
      ready = v.slice(0, v.indexOf('|'));
      doc = v.slice(v.indexOf('|') + 1);
      if (ready === 'complete') break;
    }
    await sleep(150);
  }
  const cdp = await readCookies(inst.client).catch(() => []);
  return { started, doc, ready, cdp };
}

const hasProbe = (cookies) => cookies.some((c) => c.name === PROBE_NAME && c.value === PROBE_VALUE);
const ids = [];

/* ---------------- 0. 纯函数先过一遍：形状解析是整条路的地基 ---------------- */
console.log('— 0. loginCookiePlan（纯函数）：三种形状各归各位 —');
const { loginCookiePlan } = manager;
{
  const obj = loginCookiePlan({ cookie: JSON.stringify([{ name: 'a', value: '1', domain: 'x.test' }]) });
  check('结构化对象：直接可写（1 条、0 失败、source=object）',
    obj.cookies.length === 1 && obj.failed.length === 0 && obj.source === 'object', JSON.stringify(obj.source));

  const noDomain = loginCookiePlan({ cookie: 'a=1; b=2' });
  check('原始串但没有域名可挂：**如实失败**，不猜域名（0 条可写、1 条失败）',
    noDomain.cookies.length === 0 && noDomain.failed.length === 1 && /域名/.test(noDomain.failed[0].reason),
    JSON.stringify(noDomain.failed));

  const raw = loginCookiePlan({ cookie: 'a=1; b=2', open_urls: ['https://x.test/p'] });
  check('原始串 + 启动网址：按网址的域名挂上 2 条',
    raw.cookies.length === 2 && raw.cookies.every((c) => c.url === 'https://x.test'),
    JSON.stringify(raw.cookies.map((c) => c.url)));

  // 有内容却切不出 name=value：必须记失败，否则就是零日志的静默失败（B 层 C 段就是钉这个）
  const junk = loginCookiePlan({ cookie: '一段乱码没有等号', open_urls: ['https://x.test/p'] });
  check('乱码串（给了域名）：切不出 name=value → 记一条失败，不许静默',
    junk.cookies.length === 0 && junk.failed.length === 1 && /name=value/.test(junk.failed[0].reason),
    JSON.stringify(junk.failed));

  const empty = loginCookiePlan({});
  check('cookie 为空：不产生任何写入、也不报失败（没配就是没配）',
    empty.cookies.length === 0 && empty.failed.length === 0 && empty.source === 'none', empty.source);
}

try {
  /* ---------------- A. 配了 cookie → 页面里真有 ---------------- */
  console.log('\n— A. cookie 字段配了一条登录 cookie —');
  const withCookie = profiles.createProfile({
    name: `cookie-on-${Date.now()}`,
    group_id: '0',
    cookie: JSON.stringify([{ name: PROBE_NAME, value: PROBE_VALUE, domain: '127.0.0.1', path: '/' }]),
  });
  ids.push(withCookie.profile_id);
  const a = await startAndReadCookie(withCookie.profile_id);
  check('配了 cookie：环境启动成功', !!a.started.real_version && Number(a.started.pid) > 0,
    `pid=${a.started.pid} 内核 ${a.started.real_version}`);
  check('配了 cookie：内核里能读到这条 cookie（CDP 落点）', hasProbe(a.cdp),
    `内核里 ${a.cdp.length} 条 cookie，命中=${hasProbe(a.cdp)}`);
  check('配了 cookie：**页面 document.cookie 里也有它**（用户视角：一启动就是登录态）',
    a.doc.includes(`${PROBE_NAME}=${PROBE_VALUE}`), `document.cookie 长度 ${a.doc.length}`);
  check('配了 cookie：日志里有一行「已写入」，而且**没有把 cookie 的值打出来**',
    /登录 cookie 已写入/.test(logText(withCookie.profile_id))
    && !logText(withCookie.profile_id).includes(PROBE_VALUE),
    logText(withCookie.profile_id).split('\n').filter((l) => l.includes('cookie')).slice(-2).join(' | '));

  /* ---------------- B. 对照组：不配 → 页面里没有 ---------------- */
  console.log('\n— B. 对照组：同样的环境，cookie 字段留空 —');
  const noCookie = profiles.createProfile({ name: `cookie-off-${Date.now()}`, group_id: '0' });
  ids.push(noCookie.profile_id);
  const b = await startAndReadCookie(noCookie.profile_id);
  check('对照：环境启动成功（同一条路，只是没 cookie）',
    !!b.started.real_version && Number(b.started.pid) > 0, `pid=${b.started.pid}`);
  check('对照：页面 document.cookie 里**没有**这条 cookie（证明 A 的「有」是这个字段给的）',
    !b.doc.includes(PROBE_NAME), `document.cookie 长度 ${b.doc.length}`);
  check('对照：内核里也没有这条 cookie', !hasProbe(b.cdp), `内核里 ${b.cdp.length} 条`);

  /* ---------------- C. 坏 cookie：环境照样起得来，日志有 WARN ---------------- */
  console.log('\n— C. 坏 cookie（乱码）：不许把环境锁死 —');
  // 这里**必须给启动网址**：没有网址时「没域名可挂」本身就会记一条失败，
  // 那样即使「切不出 name=value」这条检查没了，日志里照样有 WARN —— 判据就分不清是哪个原因。
  // 给了网址之后，唯一的失败来源就是「这串东西里一个 name=value 都没有」。
  const badCookie = profiles.createProfile({
    name: `cookie-bad-${Date.now()}`,
    group_id: '0',
    cookie: '这不是一条 cookie，是一段乱码，里面连等号都没有',
    open_urls: [PROBE_URL],
  });
  ids.push(badCookie.profile_id);
  const c = await startAndReadCookie(badCookie.profile_id);
  check('坏 cookie：环境**照样启动成功**（脏数据不该让环境起不来）',
    !!c.started.real_version && Number(c.started.pid) > 0, `pid=${c.started.pid} 内核 ${c.started.real_version}`);
  check('坏 cookie：页面照常打开、照常 load 完（不是起来了但页面废了）',
    c.ready === 'complete', `readyState=${c.ready}`);
  check('坏 cookie：内核里确实没写进这条（没瞎猜一个域名挂上去）', !hasProbe(c.cdp), `内核里 ${c.cdp.length} 条`);
  check('坏 cookie：日志里有一条**关于 cookie 的** WARN（失败要留痕，不许静默）',
    /WARN 登录 cookie/.test(logText(badCookie.profile_id)),
    logText(badCookie.profile_id).split('\n').filter((l) => l.includes('cookie')).slice(-2).join(' | '));

  /* ---------------- D. 原始串（txt 导入常见形状）也要能用 ---------------- */
  console.log('\n— D. 原始串形状 "a=b; c=d" + 启动网址给域名 —');
  const rawCookie = profiles.createProfile({
    name: `cookie-raw-${Date.now()}`,
    group_id: '0',
    cookie: `${PROBE_NAME}=${PROBE_VALUE}; other=1`,
    open_urls: [PROBE_URL],
  });
  ids.push(rawCookie.profile_id);
  const d = await startAndReadCookie(rawCookie.profile_id);
  check('原始串：环境启动成功', !!d.started.real_version && Number(d.started.pid) > 0, `pid=${d.started.pid}`);
  check('原始串：按启动网址的域名挂上去，页面里读得到（txt 导入那条路走通）',
    d.doc.includes(`${PROBE_NAME}=${PROBE_VALUE}`), `document.cookie 长度 ${d.doc.length}`);
  check('原始串：同一条串里的第二个键也写进去了', d.doc.includes('other=1'), d.doc.replace(/=[^;]*/g, '=***'));
} catch (e) {
  check('B 层跑完没有抛异常', false, `${e && e.message}`);
  console.error(e);
} finally {
  for (const id of ids) await manager.stopProfile(id).catch(() => {});
  try { srv.closeAllConnections?.(); } catch { /* ignore */ }
  try { srv.close(); } catch { /* ignore */ }
  dbmod.closeDb();
  await sleep(300);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄还在，留给系统 */ }
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
