/**
 * P0 判据（B 层：真内核，要 Chrome）。
 *
 * 跑法：npm run test:markers-kernel   （约 30–40 秒；起 2 个环境）
 *
 * A 层（test/markers.test.mjs）证明的是「注入源码里没有固定名、沙箱里标记不可枚举」；
 * 这一层证明的是**真的浏览器里、真的页面里**没有检测面，以及同一个环境两次启动名字稳定。
 *
 * 断言：
 *   1. 页面：`Object.getOwnPropertyNames(window)` 里 `__fp*` 数量为 0；
 *   2. 页面：`for (const k in window)` 里没有任何 `__fp*` 键（这条专门钉 `__fpInstalled`
 *      曾经是普通赋值、可枚举那个洞）；
 *   3. 同样的两条在**三类 worker**（专用 / SharedWorker / ServiceWorker）里成立；
 *   4. 注入确实生效（派生名存在、applied 是 object、四个噪点种子读得到）——
 *      否则「没有检测面」只是因为什么都没挂上，那是假绿；
 *   5. 同一环境连开两次，派生名**相同**；两个不同环境，派生名**不同**。
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'freepower-markers-'));
process.env.FREEPOWER_DATA = DATA;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
process.env.FREEPOWER_EGRESS_TIMEOUT = '1000';

const { startProfile, stopProfile, getInstance } = await import('../src/runtime/manager.js');
const { createProfile, getProfile, deleteProfiles } = await import('../src/store/profiles.js');
const { fingerprintView } = await import('../src/fingerprint/view.js');
const { markerNames } = await import('../src/kernel/markers.js');
const { findChrome } = await import('../src/kernel/chrome.js');
const { openSelfcheckOrigin } = await import('../src/selfcheck/origin.js');
const { workerScript, serviceWorkerScript } = await import('../src/selfcheck/worker-probe.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const chromeBin = findChrome();
if (!chromeBin) {
  console.error('没有可用内核，设置 FREEPOWER_CHROME 后重试');
  process.exit(2);
}

/* 页面侧的探针：一次读回「检测面」和「注入证据」两件事 */
const PAGE_PROBE = (mk) => `(() => {
  const MK = ${JSON.stringify(mk)};
  const own = Object.getOwnPropertyNames(window);
  const forIn = [];
  for (const k in window) forIn.push(String(k));
  return {
    fpOwn: own.filter((n) => /^__fp/i.test(n)),
    fpForIn: forIn.filter((n) => /^__fp/i.test(n)),
    ownCount: own.length,
    appliedType: typeof window[MK.applied],
    appliedList: window[MK.applied] ? Array.prototype.slice.call(window[MK.applied]) : [],
    realm: window[MK.realm] || null,
    installed: window[MK.installed] === true,
    seeds: window[MK.seeds] || null,
    installedEnumerable: Object.prototype.propertyIsEnumerable.call(window, MK.installed),
    appliedEnumerable: Object.prototype.propertyIsEnumerable.call(window, MK.applied),
  };
})()`;

/* worker 侧：在三类 worker 里只读「检测面」，不依赖注入是否到位 */
const WORKER_PROBE = `(async () => {
  const own = (t) => Object.getOwnPropertyNames(t);
  const forIn = (t) => { const out = []; for (const k in t) out.push(String(k)); return out; };
  const out = {};

  // 专用 worker
  try {
    const w = new Worker('/fp-marker-worker.js');
    try {
      out.dedicated = await new Promise((res, rej) => {
        w.onmessage = (e) => res(e.data);
        w.onerror = (e) => rej(new Error(String((e && e.message) || 'worker error')));
        setTimeout(() => rej(new Error('dedicated 超时')), 6000);
        w.postMessage({ go: 1 });
      });
    } finally { try { w.terminate(); } catch (e) {} }
  } catch (e) { out.dedicated = { ok: false, error: String(e.message || e) }; }

  // SharedWorker
  try {
    const sw = new SharedWorker('/fp-marker-worker.js');
    try {
      sw.port.start();
      out.shared = await new Promise((res, rej) => {
        sw.port.onmessage = (e) => res(e.data);
        setTimeout(() => rej(new Error('shared 超时')), 6000);
        sw.port.postMessage({ go: 1 });
      });
    } finally { try { sw.port.close(); } catch (e) {} }
  } catch (e) { out.shared = { ok: false, error: String(e.message || e) }; }

  // ServiceWorker
  try {
    const reg = await navigator.serviceWorker.register('/fp-marker-sw.js', { scope: '/' });
    try {
      await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 8000))]);
      const target = reg.active || reg.waiting || reg.installing;
      const ch = new MessageChannel();
      out.service = await new Promise((res, rej) => {
        ch.port1.onmessage = (e) => res(e.data);
        setTimeout(() => rej(new Error('sw 超时')), 8000);
        target.postMessage({ go: 1 }, [ch.port2]);
      });
    } finally { try { await reg.unregister(); } catch (e) {} }
  } catch (e) { out.service = { ok: false, error: String(e.message || e) }; }

  return out;
})()`;

/** worker 脚本：只回「self 上的检测面」，不读注入标记（那部分由自检覆盖） */
const MARKER_WORKER = `self.onmessage = function (e) {
  const own = Object.getOwnPropertyNames(self).filter((n) => /^__fp/i.test(n));
  const forIn = [];
  for (const k in self) if (/^__fp/i.test(k)) forIn.push(String(k));
  const data = { ok: true, fpOwn: own, fpForIn: forIn, ownCount: Object.getOwnPropertyNames(self).length };
  const port = e && e.ports && e.ports[0];
  if (port) port.postMessage(data); else self.postMessage(data);
};
self.onconnect = function (e) {
  const own = Object.getOwnPropertyNames(self).filter((n) => /^__fp/i.test(n));
  const forIn = [];
  for (const k in self) if (/^__fp/i.test(k)) forIn.push(String(k));
  e.ports[0].postMessage({ ok: true, fpOwn: own, fpForIn: forIn, ownCount: Object.getOwnPropertyNames(self).length });
};`;

const MARKER_SW = `self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('message', function (e) {
  const port = e.ports && e.ports[0];
  if (!port) return;
  const own = Object.getOwnPropertyNames(self).filter((n) => /^__fp/i.test(n));
  const forIn = [];
  for (const k in self) if (/^__fp/i.test(k)) forIn.push(String(k));
  port.postMessage({ ok: true, fpOwn: own, fpForIn: forIn, ownCount: Object.getOwnPropertyNames(self).length });
});`;

const created = [];
let origin = null;

/** 起一个环境，在它的页面里跑 PAGE_PROBE 和 WORKER_PROBE */
async function inspect(profile) {
  const started = await startProfile(profile);
  const inst = getInstance(profile.profile_id);
  try {
    const mk = markerNames(fingerprintView(getProfile(profile.profile_id)).seed);
    const page = await inst.openPage('about:blank');
    // 等注入落地（空白页由产品的补重载兜底）
    for (let i = 0; i < 60; i++) {
      const r = await inst.client.send('Runtime.evaluate', {
        expression: `typeof window[${JSON.stringify(mk.applied)}]`, returnByValue: true,
      }, page.sessionId).catch(() => null);
      if (r?.result?.value === 'object') break;
      await sleep(100);
    }
    const pageRes = await inst.client.send('Runtime.evaluate', {
      expression: PAGE_PROBE(mk), returnByValue: true,
    }, page.sessionId);
    const pageValue = pageRes.result?.value || {};

    // worker 那三条要真 http 源
    let workerValue = {};
    if (origin) {
      await inst.client.send('Page.navigate', { url: origin.url }, page.sessionId).catch(() => {});
      for (let i = 0; i < 40; i++) {
        const r = await inst.client.send('Runtime.evaluate', {
          expression: 'document.title === "FreePower markers"', returnByValue: true,
        }, page.sessionId).catch(() => null);
        if (r?.result?.value === true) break;
        await sleep(150);
      }
      const wr = await inst.client.send('Runtime.evaluate', {
        expression: WORKER_PROBE, awaitPromise: true, returnByValue: true, userGesture: true,
      }, page.sessionId);
      workerValue = wr.result?.value || {};
    }
    try { await inst.closePage(page.targetId); } catch { /* 可能已关 */ }
    return { started, mk, pageValue, workerValue };
  } finally {
    await stopProfile(profile.profile_id).catch(() => {});
  }
}

try {
  console.log(`内核：${chromeBin.version} (${chromeBin.source})`);
  console.log(`临时数据目录：${DATA}\n`);

  // 标记专用的本地源（覆盖默认的 worker/sw 路径，只回检测面）
  origin = await (async () => {
    const srv = http.createServer((req, res) => {
      const u = String(req.url || '/').split('?')[0];
      const send = (body, type, extra = {}) => {
        const buf = Buffer.from(body, 'utf8');
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store',
          'connection': 'close', 'content-length': buf.length, ...extra });
        res.end(buf);
      };
      if (u === '/fp-marker-worker.js') return send(MARKER_WORKER, 'text/javascript; charset=utf-8');
      if (u === '/fp-marker-sw.js') return send(MARKER_SW, 'text/javascript; charset=utf-8', { 'service-worker-allowed': '/' });
      return send('<!doctype html><meta charset="utf-8"><title>FreePower markers</title><body>markers</body>',
        'text/html; charset=utf-8');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    return {
      url: `http://127.0.0.1:${port}/page`,
      close: () => new Promise((resolve) => {
        try { srv.closeAllConnections(); } catch { /* 老 Node */ }
        srv.close(() => resolve());
        setTimeout(resolve, 1000).unref?.();
      }),
    };
  })();

  /* ---------------- 1) 环境甲：页面 + worker ---------------- */
  const p1 = createProfile({ name: `markers-a-${Date.now()}`, group_id: '0', remark: 'P0 标记检测面' });
  created.push(p1.profile_id);
  const a = await inspect(getProfile(p1.profile_id));
  const av = a.pageValue;
  console.log(`\n环境甲 ${p1.profile_id} · 派生名 ${JSON.stringify(a.mk)}`);
  console.log(`  页面 own names 总数 ${av.ownCount} · __fp* ${av.fpOwn.length} 条 · for...in __fp* ${av.fpForIn.length} 条`);
  console.log(`  注入证据：applied=${av.appliedType} realm=${av.realm} installed=${av.installed}`);
  console.log(`  worker：${JSON.stringify(a.workerValue)}`);

  check('页面 own names 里 __fp* 数量为 0', (av.fpOwn || []).length === 0, (av.fpOwn || []).join(',') || 'none');
  check('页面 for...in 里没有任何 __fp* 键', (av.fpForIn || []).length === 0, (av.fpForIn || []).join(',') || 'none');
  check('注入确实生效（派生名 applied 是 object）', av.appliedType === 'object', String(av.appliedType));
  check('注入确实生效（realm = page、installed = true）', av.realm === 'page' && av.installed === true,
    `realm=${av.realm} installed=${av.installed}`);
  check('四个噪点种子读得到（注入不是空壳）',
    !!av.seeds && ['canvas', 'webgl_image', 'audio', 'client_rects'].every((k) => !!av.seeds[k]),
    JSON.stringify(av.seeds));
  check('installed 标记不可枚举（原来那条普通赋值的洞）', av.installedEnumerable === false);
  check('applied 标记不可枚举', av.appliedEnumerable === false);

  for (const [kind, label] of [['dedicated', '专用 worker'], ['shared', 'SharedWorker'], ['service', 'ServiceWorker']]) {
    const w = a.workerValue[kind] || {};
    check(`${label} 里 __fp* 数量为 0（own names）`, w.ok === true && (w.fpOwn || []).length === 0,
      w.ok ? `${(w.fpOwn || []).length} 条 / own ${w.ownCount}` : String(w.error));
    check(`${label} 里 for...in 没有 __fp* 键`, w.ok === true && (w.fpForIn || []).length === 0,
      w.ok ? `${(w.fpForIn || []).length} 条` : String(w.error));
  }

  /* ---------------- 2) 环境甲再开一次：名字必须相同 ---------------- */
  const a2 = await inspect(getProfile(p1.profile_id));
  console.log(`\n环境甲第二次启动 · 派生名 ${JSON.stringify(a2.mk)}`);
  check('同一环境连开两次，派生名完全相同（名字随环境稳定，不是每次都变）',
    JSON.stringify(a.mk) === JSON.stringify(a2.mk));
  check('第二次开也仍然没有 __fp* 检测面',
    (a2.pageValue.fpOwn || []).length === 0 && (a2.pageValue.fpForIn || []).length === 0);

  /* ---------------- 3) 环境乙：名字必须不同 ---------------- */
  const p2 = createProfile({ name: `markers-b-${Date.now()}`, group_id: '0', remark: 'P0 标记检测面 乙' });
  created.push(p2.profile_id);
  const b = await inspect(getProfile(p2.profile_id));
  console.log(`\n环境乙 ${p2.profile_id} · 派生名 ${JSON.stringify(b.mk)}`);
  check('不同环境派生名不同（跨环境关联不起来）',
    Object.keys(a.mk).every((k) => a.mk[k] !== b.mk[k]),
    `${a.mk.applied} vs ${b.mk.applied}`);
  check('环境乙也没有 __fp* 检测面',
    (b.pageValue.fpOwn || []).length === 0 && (b.pageValue.fpForIn || []).length === 0);
  check('环境乙的注入也生效（applied 是 object）', b.pageValue.appliedType === 'object', String(b.pageValue.appliedType));
} catch (e) {
  console.log('异常：', e && e.stack ? e.stack.split('\n').slice(0, 6).join(' | ') : e);
  check('整体跑通（无异常）', false, String(e && e.message));
} finally {
  if (origin) await origin.close().catch(() => {});
  for (const id of created) {
    try { await stopProfile(id); } catch { /* 已停 */ }
    try { deleteProfiles([id]); } catch { /* 已删 */ }
  }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 占用中就算了 */ }
}

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail}/${results.length} 通过`);
process.exit(fail ? 1 : 0);