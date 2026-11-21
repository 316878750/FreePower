/**
 * 「运行中跟随」的真内核判据（0.4.7.11）——**肉眼可见**那一层。
 *
 * 为什么必须单独写一条：`sync-kernel.test.mjs` 里的点击/打字/滚动断言是真的看受控页 DOM，
 * 但它把主窗口的多余标签**关掉了**（那边注释写着「多标签时 pickPageTarget 取哪张不确定，见 0.4.8」），
 * 输入也是测试自己 `Input.dispatchMouseEvent` 打到**自己选的那条 session** 上。
 * 所以它证明的是「绑定对了之后转发链路是通的」，证明不了「绑定会跟着用户走」。
 * 用户现场恰恰是 3–4 个标签 + 中途切换 —— 那一段从来没有判据进过。
 *
 * 覆盖规格 `docs/29-窗口同步规格-按实测行为对齐.md` 的 C1–C4 与 C6（C5 端到端像素由 CEO 自己跑）：
 *   C1 会话中途切可见标签 → 自动改投递到新标签，新标签的点击打到受控页 DOM
 *   C2 关标签 / 开新标签 → 关掉的自动重选；新开的立刻补装捕获，点击照样通
 *   C3 主控当前 target 被销毁（0.4.7.10 的真实失败场景）→ 捕获不丢、事件继续涨
 *   C4 坐标 1:1（受控页收到的 clientX/clientY 与主控**完全相同**）+ 越界丢弃计数
 *   C6 状态自证：正常时 alive=true；把页面里的探针拆掉 → alive=false（不是看进程在不在）
 *   C7 受控窗口切标签：R7 的焦点模拟会把后台页的 visibilityState 也改成 visible，
 *      投递仍必须跟到用户真正切过去的那张（0.4.7.11 第二轮 CEO 实机红的就是这条）
 *
 * 硬规则：**任何一条都不把 `scheduler.sent>0` / `errors===0` 当通过条件**。
 * 每条断言读的都是「受控页自己的 DOM / 页面里的事件计数 / 探针在不在」。
 *
 * 跑法：npm run test:sync-follow-kernel（会起 2 个真环境，约 1–2 分钟）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dataDir = path.join(os.tmpdir(), `freepower-syncfollow-${Date.now()}`);
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_SELFCHECK = '0';

/* 两张**布局完全相同**的页面：只有 `window.__tag` 不同。
 * 布局相同是为了让「主窗口点的位置」在受控窗口能落到同一个元素上（1:1 坐标的前提）；
 * `__tag` 用来在读数里说清「受控窗口现在是哪张页」；
 * `__last` 记下**受控页自己收到的** clientX/clientY —— C4 的 1:1 就靠它证明。 */
const PAGE = (tag) => `<!doctype html><html><head><meta charset="utf-8"><title>follow-${tag}</title>
<style>
  body { margin: 0; font: 14px/1.4 monospace; }
  #target { position: absolute; left: 40px; top: 60px; width: 220px; height: 90px; background: #dde; }
</style></head><body>
<div id="target">TARGET-${tag}</div>
<script>
window.__tag = ${JSON.stringify(tag)};
window.__hits = [];
window.__last = null;
document.addEventListener('click', function (e) {
  window.__last = { x: e.clientX, y: e.clientY, tag: window.__tag };
  window.__hits.push(e.target && e.target.id ? e.target.id : (e.target ? e.target.tagName : '?'));
}, true);
</script></body></html>`;

const srv = http.createServer((req, res) => {
  const p = String(req.url || '/').split('?')[0];
  const tag = p === '/b' ? 'b' : 'a';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE(tag));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const URL_A = `http://127.0.0.1:${PORT}/a`;
const URL_B = `http://127.0.0.1:${PORT}/b`;

const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');
const sync = await import('../src/sync/session.js');

const started = [];
let instA = null;
let instB = null;

async function evalIn(inst, sessionId, expression) {
  const r = await inst.client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    .catch(() => null);
  if (r?.exceptionDetails) return { error: r.exceptionDetails.text };
  return r?.result?.value;
}

/** 轮询等到条件成立（跟随是 450ms 一轮，不能「发完就断言」） */
async function waitFor(fn, { timeoutMs = 8000, stepMs = 200, label = '' } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (last) return last;
    await sleep(stepMs);
  }
  if (label) console.log(`  （等超时：${label}）`);
  return last;
}

/** 主窗口点一下：移动 + 按下 + 抬起（和真鼠标走的同一条 CDP 路径） */
async function clickAtPoint(inst, sessionId, x, y) {
  await inst.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }, sessionId);
  await inst.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
  await inst.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
  return { x, y };
}

async function clickAt(inst, sessionId, selector) {
  const box = await evalIn(inst, sessionId, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (!box || typeof box.x !== 'number') return null;
  return clickAtPoint(inst, sessionId, box.x, box.y);
}

async function pageTargets(inst) {
  const r = await inst.client.send('Target.getTargets');
  return (r.targetInfos || []).filter((t) => t.type === 'page');
}

const masterWin = () => sync.syncStatus().windows.find((w) => w.role === 'master') || null;
const slaveWin = () => sync.syncStatus().windows.find((w) => w.role === 'slave') || null;

/**
 * R5 自检接口（`POST /api/v2/sync/selftest` 的内核）。
 * 老实现没有它 —— 这里返回 null 而不是抛异常，好让「先红后绿」那一轮的红是
 * **这条判据自己的断言红**（信息明确），而不是「import 崩了」那种糊成一片的红。
 */
async function runSelftest() {
  if (typeof sync.selftestOf !== 'function') return null;
  const s = typeof sync.getSession === 'function' ? sync.getSession() : null;
  return sync.selftestOf(s);
}

/** 受控页 DOM 里有没有记到一次点击（这是「肉眼可见」的唯一证据） */
async function slaveHits() {
  const h = await evalIn(instB, pageB1.sessionId, 'JSON.stringify(window.__hits)');
  return String(h);
}

let pageB1 = null;

try {
  for (const name of ['follow-master', 'follow-slave']) {
    const p = profiles.createProfile({ name: `${name}-${Date.now()}`, group_id: '0', remark: 'sync follow 真内核判据' });
    const st = await manager.startProfile(profiles.getProfile(p.profile_id));
    started.push(p.profile_id);
    console.log(`环境 ${name} = ${p.profile_id} · 内核 ${st.real_version}`);
  }
  [instA, instB] = [manager.getInstance(started[0]), manager.getInstance(started[1])];

  /* 主窗口：先开 A，再开 B（第二张自动成为前台 —— 这就是「用户开了两个标签」） */
  const pageA1 = await instA.openPage(URL_A);
  const pageA2 = await instA.openPage(URL_B);
  pageB1 = await instB.openPage(URL_A);
  await sleep(1500);
  console.log(`主窗口标签：${(await pageTargets(instA)).map((t) => String(t.url).replace(`http://127.0.0.1:${PORT}`, '')).join(' , ')}`);

  /* ------------------------------ 前置：可见性真的读得到 ------------------------------ */
  const visA1 = await evalIn(instA, pageA1.sessionId, 'document.visibilityState');
  const visA2 = await evalIn(instA, pageA2.sessionId, 'document.visibilityState');
  console.log(`主窗口两张标签的 visibilityState：A=${visA1} B=${visA2}`);
  check('前置：主窗口两张标签里恰好一张可见（跟随判据靠这个，读不到就没法测）',
    (visA1 === 'visible') !== (visA2 === 'visible'), `A=${visA1} B=${visA2}`);

  /* ------------------------------ ① 同步起来 + 每张标签都装捕获 ------------------------------ */
  console.log('\n— ① 多标签主窗口：同步起来，**每一张**标签都装捕获 —');
  const st0 = await sync.startSync({ masterId: started[0], slaveIds: [started[1]], settings: {}, rngSeed: 2026 });
  await sleep(1200);
  const mw0 = masterWin();
  check('① 会话起来了，两个窗口都在', st0.running === true && st0.windows.length === 2,
    JSON.stringify(st0.windows.map((w) => w.role)));
  const pageCount0 = (await pageTargets(instA)).length;
  check('① 主窗口**每一张**标签都装了捕获（不只可见那张）',
    sync.syncStatus().master_pages === pageCount0,
    `master_pages=${sync.syncStatus().master_pages} 窗口里的 page=${pageCount0}`);
  check('① 当前目标是「可见」那张（source=visible、confident=true）',
    mw0.target_source === 'visible' && mw0.confident === true, `${mw0.target_source}/${mw0.confident}`);

  /* R5：alive 必须读得到（正常路径的基线，C6 要拿它做对照） */
  const alive0 = await waitFor(() => (sync.syncStatus().alive === true ? true : null),
    { timeoutMs: 6000, label: 'alive 变成 true' });
  check('① alive=true（探针在主控当前页里，2s 看门狗读到的）', alive0 === true,
    `alive=${sync.syncStatus().alive} targets_attached=${sync.syncStatus().targets_attached}`);
  check('① targets_attached 与窗口里的 page 数一致',
    sync.syncStatus().targets_attached === pageCount0,
    `targets_attached=${sync.syncStatus().targets_attached} page=${pageCount0}`);

  /* R5 自检接口：脚本真的在页上，接口必须说 true */
  const selftest0 = await runSelftest();
  const masterRows0 = (selftest0?.windows || []).filter((w) => w.role === 'master');
  check('① selftest：主控每一张标签都报 capture_installed=true',
    masterRows0.length === pageCount0 && masterRows0.every((r) => r.capture_installed === true),
    selftest0 ? JSON.stringify(masterRows0.map((r) => [r.target_url, r.capture_installed])) : '老实现没有 selftest 接口');

  /* ------------------------------ ② 在可见那张上点 → 受控窗口 DOM 真的变 ------------------------------ */
  console.log('\n— ② 在可见标签上点一下 → 受控窗口的页面真的记到这次点击 —');
  await evalIn(instB, pageB1.sessionId, 'window.__hits = []; window.__last = null; "ok"');
  const visibleTarget0 = masterWin().target_id;
  const visibleSid0 = visibleTarget0 === pageA1.targetId ? pageA1.sessionId : pageA2.sessionId;
  const click0 = await clickAt(instA, visibleSid0, '#target');
  const hits1 = await waitFor(async () => {
    const h = await slaveHits();
    return h.includes('target') ? h : null;
  }, { label: '受控窗口第一次收到点击' });
  check('② 受控窗口页面的 DOM 变了（__hits 记到 target，不是「CDP 返回 0 错误」）',
    Boolean(hits1), `受控 hits=${hits1}`);

  /* ------------------------------ C4：坐标 1:1 ------------------------------ */
  console.log('\n— C4 坐标 1:1：受控页收到的 clientX/clientY 必须与主控**完全相同** —');
  const last0 = await evalIn(instB, pageB1.sessionId, 'JSON.stringify(window.__last)');
  let parsed0 = null;
  try { parsed0 = JSON.parse(String(last0)); } catch { parsed0 = null; }
  check('C4 受控页的点击坐标 = 主控点击坐标（原值直传，不缩放）',
    parsed0 && click0 && parsed0.x === click0.x && parsed0.y === click0.y,
    `主控=${JSON.stringify(click0)} 受控=${String(last0)}`);

  /* ------------------------------ C1：用户切标签 → 目标自动跟过去 ------------------------------ */
  console.log('\n— C1 用户切到另一张标签 → 同步目标自动跟过去（这次的核心）—');
  const otherTarget = visibleTarget0 === pageA1.targetId ? pageA2 : pageA1;
  const otherSid = otherTarget === pageA1 ? pageA1.sessionId : pageA2.sessionId;
  await instA.client.send('Page.bringToFront', {}, otherSid).catch(() => {});
  const followed = await waitFor(async () => {
    const cur = masterWin();
    return cur && cur.target_id === otherTarget.targetId ? cur : null;
  }, { label: '同步目标跟随切换后的标签' });
  check('C1 切换后状态里的 target_id 跟到了新标签（老实现会一直绑在旧页上）',
    Boolean(followed), `现在=${masterWin()?.target_id} 期望=${otherTarget.targetId}`);
  check('C1 跟过去之后 alive=true、来源是实测可见',
    followed?.alive === true && followed?.target_source === 'visible',
    `alive=${followed?.alive} source=${followed?.target_source}`);

  console.log('  C1 切过去之后再点一下 → 受控窗口照样收到');
  await evalIn(instB, pageB1.sessionId, 'window.__hits = []; window.__last = null; "ok"');
  const eventsBefore = sync.syncStatus().events;
  await clickAt(instA, otherSid, '#target');
  const hits2 = await waitFor(async () => {
    const h = await slaveHits();
    return h.includes('target') ? h : null;
  }, { label: '受控窗口收到切换后的点击' });
  check('C1 切标签之后再点，受控窗口的 DOM 又变了', Boolean(hits2), `受控 hits=${hits2}`);
  const stAfter = sync.syncStatus();
  check('C1 新标签的点击**真的从当前 target 采到**（events_from_current_target 涨了）',
    stAfter.events > eventsBefore && stAfter.events_from_current_target > 0,
    `events ${eventsBefore}→${stAfter.events} 当前target贡献=${stAfter.events_from_current_target}`);

  /* ------------------------------ C2：开新标签 → 立刻补装捕获 ------------------------------ */
  console.log('\n— C2 用户开一张新标签（并切过去）→ 立刻补装捕获，点击照样通 —');
  const created = await instA.client.send('Target.createTarget', { url: URL_B });
  const newTargetId = created?.targetId;
  const grew = await waitFor(() => {
    const n = sync.syncStatus().master_pages || 0;
    return n >= pageCount0 + 1 ? n : null;
  }, { label: '新标签被补装捕获' });
  check('C2 新标签出现后 master_pages 立刻 +1（targetCreated 就注入，不等轮询）',
    Boolean(grew), `master_pages=${sync.syncStatus().master_pages} 之前=${pageCount0}`);

  const newSid = await waitFor(async () => {
    const cur = masterWin();
    return cur && cur.target_id === newTargetId ? cur : null;
  }, { label: '新标签成为投递/捕获目标' });
  check('C2 新开的标签成为当前目标（用户开完就在这张上操作）',
    Boolean(newSid), `现在=${masterWin()?.target_id} 期望=${newTargetId}`);

  await evalIn(instB, pageB1.sessionId, 'window.__hits = []; "ok"');
  if (newTargetId) {
    const { sessionId: newSess } = await instA.client.send('Target.attachToTarget', { targetId: newTargetId, flatten: true });
    // 等新文档真的加载完（脚本装上了、元素在），否则 querySelector 是 null、点了也没东西
    await waitFor(async () => {
      const r = await evalIn(instA, newSess, `document.readyState === 'complete' && !!document.querySelector('#target')`);
      return r === true ? true : null;
    }, { label: '新标签加载完成' });
    await clickAt(instA, newSess, '#target');
    const hits3 = await waitFor(async () => {
      const h = await slaveHits();
      return h.includes('target') ? h : null;
    }, { label: '受控窗口收到新标签的点击' });
    check('C2 在新标签上点一下，受控窗口的 DOM 也变了（不是只装了个空脚本）',
      Boolean(hits3), `受控 hits=${hits3}`);
  } else {
    check('C2 在新标签上点一下，受控窗口的 DOM 也变了（不是只装了个空脚本）', false, '没拿到新 targetId');
  }

  /* ------------------------------ C3：当前 target 被销毁 → 捕获不丢 ------------------------------ */
  console.log('\n— C3 主控当前 target 被销毁（0.4.7.10 的真实失败场景）→ 捕获不丢 —');
  const before3 = masterWin();
  await instA.closePage(newTargetId);
  const fallback = await waitFor(() => {
    const cur = masterWin();
    return cur && cur.target_id !== newTargetId && cur.alive === true ? cur : null;
  }, { label: '关标签后重新选目标' });
  check('C3 目标自动落到剩下那张标签（不是绑在已经关掉的页上）',
    Boolean(fallback), `之前=${before3?.target_id} 现在=${masterWin()?.target_id}`);
  check('C3 会话还活着（关一张标签不该把同步搞死）', sync.syncStatus().running === true,
    String(sync.syncStatus().running));

  const fbSid = fallback?.target_id === pageA1.targetId ? pageA1.sessionId : pageA2.sessionId;
  await evalIn(instB, pageB1.sessionId, 'window.__hits = []; "ok"');
  await clickAt(instA, fbSid, '#target');
  const hits4 = await waitFor(async () => {
    const h = await slaveHits();
    return h.includes('target') ? h : null;
  }, { label: '受控窗口收到重选后的点击' });
  check('C3 重选之后点击照样打到受控页 DOM（捕获没丢）', Boolean(hits4), `受控 hits=${hits4}`);

  /* ------------------------------ C4（续）：越界丢弃 ------------------------------ */
  console.log('\n— C4 越界丢弃：把受控窗口改小，主控在受控视口外点击 → 丢弃并计数 —');
  const slaveWinInfo = await instB.client.send('Browser.getWindowForTarget', { targetId: pageB1.targetId });
  let c4ok = false;
  let c4detail = '';
  if (slaveWinInfo?.windowId) {
    /* 先把窗口恢复成 normal 再改尺寸：最大化/全屏下 `Browser.setWindowBounds` 的宽高会被**静默忽略**
     * （`sync/session.js` 的 unifySize 也踩过这个坑）。第一次跑这条判据就是因为没恢复，
     * 受控窗口还是 1500 宽，于是「受控视口外的点」在主控里根本放不下 → 核不了。 */
    await instB.client.send('Browser.setWindowBounds', {
      windowId: slaveWinInfo.windowId, bounds: { windowState: 'normal' },
    }).catch(() => {});
    await sleep(300);
    /* 改尺寸可能被忽略（窗口有最小尺寸、或刚恢复 normal 还没稳定）：重试 + 回读确认。
     * 判据不能因为「没改成」就假绿，也不能因为一次没改成就算产品失败 —— 核不了要如实说。 */
    let sv = null;
    let via = 'window';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await instB.client.send('Browser.setWindowBounds', {
        windowId: slaveWinInfo.windowId, bounds: { width: 760, height: 560 },
      }).catch(() => {});
      await sleep(1000);
      const vp = await evalIn(instB, pageB1.sessionId, 'JSON.stringify({w: innerWidth, h: innerHeight})');
      try { sv = JSON.parse(String(vp)); } catch { sv = null; }
      if (sv && Number.isFinite(sv.w) && sv.w <= 900) break;
    }
    if (!sv || !Number.isFinite(sv.w) || sv.w > 900) {
      /* 这台机器上窗口尺寸改不动（最大化恢复后的 normal 尺寸就很大，setWindowBounds 的宽高被忽略）。
       * 换成**确定性的视口覆盖**：这是测试页，改的是渲染视口，正好就是「受控页比主控小」这个场景。
       * 产品侧读的是页面的 `innerWidth`，两条路径对它没有区别。 */
      await instB.client.send('Emulation.setDeviceMetricsOverride', {
        width: 620, height: 420, deviceScaleFactor: 1, mobile: false,
      }, pageB1.sessionId).catch(() => {});
      await sleep(600);
      const vp = await evalIn(instB, pageB1.sessionId, 'JSON.stringify({w: innerWidth, h: innerHeight})');
      try { sv = JSON.parse(String(vp)); } catch { sv = null; }
      via = 'emulation';
    }
    const masterVp = await evalIn(instA, fbSid, 'JSON.stringify({w: innerWidth, h: innerHeight})');
    let mv = null;
    try { mv = JSON.parse(String(masterVp)); } catch { /* 读不到就核不了 */ }
    if (sv && mv && Number.isFinite(sv.w) && Number.isFinite(mv.w)) {
      const outX = Math.min(sv.w + 120, mv.w - 40);
      if (outX >= sv.w && outX > 0) {
        await evalIn(instB, pageB1.sessionId, 'window.__hits = []; "ok"');
        const dropBefore = sync.syncStatus().dropped_out_of_view;
        await clickAtPoint(instA, fbSid, outX, 80);
        const dropAfter = await waitFor(() => {
          const st = sync.syncStatus();
          return st.dropped_out_of_view > dropBefore ? st.dropped_out_of_view : null;
        }, { timeoutMs: 4000, label: 'dropped_out_of_view 增长' });
        const hitsAfter = await slaveHits();
        c4ok = Boolean(dropAfter) && !hitsAfter.includes('target');
        c4detail = `受控视口=${sv.w}x${sv.h}（${via}） 主控视口=${mv.w} 点击x=${outX} `
          + `dropped ${dropBefore}→${sync.syncStatus().dropped_out_of_view} 受控hits=${hitsAfter}`;
      } else {
        c4detail = `主控视口只有 ${mv.w}，放不下「受控视口外」的点（核不了）`;
      }
    } else {
      c4detail = `读不到视口：slave=${String(slaveVp)} master=${String(masterVp)}（核不了）`;
    }
  } else {
    c4detail = '拿不到受控窗口 windowId（核不了）';
  }
  check('C4 主控在受控视口外点击 → 丢弃（受控页没收到）且 dropped_out_of_view 计数增长',
    c4ok, c4detail);

  /* ------------------------------ C7：焦点模拟污染下的激活判定 ------------------------------ */
  /**
   * 0.4.7.11 第二轮现场（CEO 实机 `run.cjs --no-arrange`，5 项里 S2/S3 红）：
   *   受控窗口标题已经是 FP-E2E-LAB:B2，投递却还打在 B1；两张标签同时报
   *   `vis=visible focus=true`，`delivery_target_url` 一直是 B1。
   *
   * 实测根因：`Emulation.setFocusEmulationEnabled(true)`（R7）会把**可见性一起覆盖**——
   *   后台页 未开焦点模拟: {"vis":"hidden","focus":false}
   *   后台页 开了焦点模拟: {"vis":"visible","focus":true}
   * 所以「开在所有受控页上」= 每张都报 visible = 轮询永远选列表第一张。
   *
   * 这条判据钉两件事：① 切过去之后投递目标真的换到新标签（不是只有状态在变）；
   * ② 依据是页面自己上报的激活事件（`target_signal=event`），而不是轮询猜的。
   */
  console.log('\n— C7 受控窗口切标签：焦点模拟会谎报 visible，投递仍必须跟到新标签 —');
  const pageB2 = await instB.openPage(URL_B);
  await sleep(700);
  await instB.client.send('Page.bringToFront', {}, pageB2.sessionId).catch(() => {});
  const b2TargetId = pageB2.targetId;
  const movedToB2 = await waitFor(() => {
    const w = slaveWin();
    return w && w.target_id === b2TargetId ? w : null;
  }, { timeoutMs: 8000, label: '投递目标跟到 B2' });
  check('C7 受控窗口切到新标签 → 投递目标跟过去（不是一直投第一张）',
    Boolean(movedToB2), `现在=${slaveWin()?.target_id} 期望=${b2TargetId} delivery=${slaveWin()?.delivery_target_url}`);
  check('C7 依据是页面自己上报的激活事件（target_signal=event，不是轮询猜的）',
    movedToB2?.target_signal === 'event', `target_signal=${movedToB2?.target_signal} activation=${movedToB2?.activation}`);

  /* 旧标签的焦点模拟必须已经关掉，否则它会继续谎报 visible，下一轮又会被选回去 */
  const b1Hidden = await waitFor(() => {
    const w = slaveWin();
    const p = (w?.pages || []).find((x) => x.target_id === pageB1.targetId);
    return p && p.visible === false ? p : null;
  }, { timeoutMs: 6000, label: 'B1 恢复 hidden' });
  check('C7 旧标签不再谎报 visible（焦点模拟只开在当前投递目标上）',
    Boolean(b1Hidden), JSON.stringify((slaveWin()?.pages || []).map((p) => [p.target_id.slice(0, 6), p.visible, p.active, p.is_current])));

  /* 真正的「肉眼可见」：在主控上点一下，必须落在 B2 的 DOM 里，B1 一条都不许有 */
  const curMaster = masterWin();
  let masterSid2 = null;
  for (const p of [pageA1, pageA2]) if (p && p.targetId === curMaster?.target_id) masterSid2 = p.sessionId;
  if (!masterSid2 && curMaster?.target_id) {
    const att = await instA.client.send('Target.attachToTarget', { targetId: curMaster.target_id, flatten: true }).catch(() => null);
    masterSid2 = att?.sessionId || null;
  }
  await evalIn(instB, pageB2.sessionId, 'window.__hits = []; window.__last = null; "ok"');
  await evalIn(instB, pageB1.sessionId, 'window.__hits = []; "ok"');
  if (masterSid2) {
    await clickAt(instA, masterSid2, '#target');
    const b2Got = await waitFor(async () => {
      const h = String(await evalIn(instB, pageB2.sessionId, 'JSON.stringify(window.__hits)'));
      return h.includes('target') ? h : null;
    }, { label: 'B2 收到点击' });
    const b1Hits = String(await evalIn(instB, pageB1.sessionId, 'JSON.stringify(window.__hits)'));
    check('C7 切过去之后点击落到新标签的 DOM（B2 收到、B1 一条都没有）',
      Boolean(b2Got) && !b1Hits.includes('target'), `B2 hits=${b2Got} B1 hits=${b1Hits}`);
  } else {
    check('C7 切过去之后点击落到新标签的 DOM（B2 收到、B1 一条都没有）', false,
      `拿不到主控当前 session（target=${curMaster?.target_id}）`);
  }

  /* ------------------------------ C6：alive 自证 ------------------------------ */
  console.log('\n— C6 状态自证：把页面里的探针拆掉 → alive 必须变 false（不是看进程）—');
  const curSid = masterWin().target_id === pageA1.targetId ? pageA1.sessionId : pageA2.sessionId;
  /* 探针是 **Symbol 键 + 不可枚举**（字符串名本身就是检测面，P0 判据钉着这一条）。
   * 所以「拆探针」也得按形状枚举来找 —— 主进程读 `alive` 用的就是同一段逻辑。 */
  const PROBE_FIND_JS = `(function () {
    var ss = Object.getOwnPropertySymbols(window);
    for (var i = 0; i < ss.length; i++) {
      var v; try { v = window[ss[i]]; } catch (e) { continue; }
      if (v && typeof v === 'object' && typeof v.off === 'function' && typeof v.at === 'number') return ss[i];
    }
    return null;
  })()`;
  const foundProbe = await evalIn(instA, curSid, `!!${PROBE_FIND_JS}`);
  check('C6 主控当前页里能按形状找到探针（自证的前提）', foundProbe === true, String(foundProbe));
  check('C6 探针不占任何字符串键（own names 里没有 _s 形状的名字）',
    String(await evalIn(instA, curSid,
      `JSON.stringify(Object.getOwnPropertyNames(window).filter((n) => /^_s[0-9a-f]{8}$/.test(n)))`)) === '[]',
    String(await evalIn(instA, curSid,
      `JSON.stringify(Object.getOwnPropertyNames(window).filter((n) => /^_s[0-9a-f]{8}$/.test(n)))`)));
  const removed = await evalIn(instA, curSid,
    `(function () { var s = ${PROBE_FIND_JS}; if (!s) return false; try { window[s].off(); } catch (e) {} try { delete window[s]; } catch (e) {} return !(${PROBE_FIND_JS}); })()`);
  check('C6 探针已从主控当前页里拆掉（前置：删除真的生效）', removed === true, String(removed));
  const aliveFalse = await waitFor(() => (sync.syncStatus().alive === false ? true : null),
    { timeoutMs: 8000, label: 'alive 变 false' });
  check('C6 探针没了 → alive=false（0.4.7.10 那种「脚本不在页上却报 running」必须能看出来）',
    aliveFalse === true, `alive=${sync.syncStatus().alive}`);
  const selftest1 = await runSelftest();
  const curRow = (selftest1?.windows || []).find((r) => r.role === 'master' && r.is_delivery_target);
  check('C6 selftest 也如实报 capture_installed=false（接口不能自欺）',
    Boolean(curRow) && curRow.capture_installed === false,
    selftest1 ? JSON.stringify(curRow) : '老实现没有 selftest 接口');

  /* ------------------------------ 收尾：受控全关 → 降级；主控全关 → 会话结束 ------------------------------ */
  console.log('\n— 收尾 受控窗口标签全关 → degraded；主控标签全关 → 会话明确结束 —');
  for (const tid of (await pageTargets(instB)).map((t) => t.targetId)) await instB.closePage(tid);
  const degraded = await waitFor(() => {
    const cur = slaveWin();
    return cur && cur.degraded ? cur : null;
  }, { label: '受控窗口标 degraded' });
  check('受控窗口一张标签都不剩 → degraded 有值（用户/日志能看出这个窗口废了）',
    Boolean(degraded?.degraded),
    `degraded=${degraded?.degraded} pages=${degraded?.pages} running=${sync.syncStatus().running} `
    + `windows=${JSON.stringify(sync.syncStatus().windows.map((w) => [w.role, w.pages, w.degraded]))}`);

  for (const tid of (await pageTargets(instA)).map((t) => t.targetId)) await instA.closePage(tid);
  const ended = await waitFor(() => {
    const st = sync.syncStatus();
    return st.running === false ? st : null;
  }, { label: '主窗口无页面后会话结束' });
  check('主窗口一张页都不剩 → running 变成 false（不许继续假装运行）',
    ended?.running === false, `running=${ended?.running}`);
  check('结束原因写清是 master_target_gone', ended?.last_end?.reason === 'master_target_gone',
    `last_end=${JSON.stringify(ended?.last_end)}`);
  check('结束原因有给人看的一句话', Boolean(ended?.last_end?.message), String(ended?.last_end?.message));
} catch (e) {
  check('判据整体没炸', false, e?.stack || String(e));
} finally {
  try { await sync.stopSync(); } catch { /* ignore */ }
  for (const id of started) {
    try { await manager.stopProfile(id); } catch { /* ignore */ }
  }
  for (const id of started) {
    try { profiles.deleteProfiles([id]); } catch { /* ignore */ }
  }
  try { srv.close(); } catch { /* ignore */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
