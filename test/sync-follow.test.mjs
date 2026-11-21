/**
 * 「运行中跟随」的判据（0.4.7.11）。
 *
 * 起因（用户 2026-11-21 第二次反馈「同步还是不联动」，CEO 实测）：
 *   status: master target=DB4B3123AD url=app.startale.com/sign-up visible=true confident=true
 *   主控窗口现在只有两个标签：defi.xstocks.fi/points 和起始页 —— **DB4B3123AD 已经不在里面了**
 *   往主控当前可见的 xstocks 页注入 5 个事件，计数 delta=0（21→21）
 *   → 0.4.7.10「选可见标签」是对的，但**只对了一瞬间**：会话绑死在启动时那张 target 上，
 *     用户中途切标签 / 关标签 / 开新标签之后，同步还打在旧页上，而 running 依然是 true、日志一行不报。
 *
 * 这条判据用**假 CDP 客户端**真求值 `PageFollower` / `statusOf`：
 *   ① 会话中途切换可见标签 → 自动改投递到新标签（不重开同步）
 *   ② 主控 target 被销毁 → 重新选目标；新标签出现 → 补装捕获（每页只装一次，不许装两份）
 *   ③ 主控所有 page 都没了 → 明确触发「结束」，且 status/hint 说人话
 *   ④ 受控 target 消失 → 改到剩下那张；全关 → 明确报降级
 *   ⑤ R2 投递目标解析：≤500ms 缓存、生命周期事件立刻失效、解析不到返回 null（→ skipped_no_target）
 *   ⑥ 反向自证：不刷新（= 老实现不跟随）时上面的断言必须不成立
 *   ⑦ status 新增 alive / events_from_this_target / last_event_at / stale_ms / hint
 *
 * 0.4.7.11 规格变更：R1 明确**不要**「只转发当前可见页」的闸门（`masterGate` 已删）。
 * 依据是 34 号文：AdsPower 投递对象是窗口句柄、没有 target 概念，切/关/开标签全即时跟随；
 * 我们用「所有 page 都装捕获」达到同样效果 —— 真实用户输入本来就只落在前台那张页上。
 *
 * 跑法：npm run test:sync-follow
 */
import assert from 'node:assert/strict';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
async function t(name, fn) {
  try { await fn(); check(name, true); } catch (e) { check(name, false, e?.message || String(e)); }
}

const {
  PageFollower, staleHint, choosePage, pageKind, FOLLOW_INTERVAL_MS,
} = await import('../src/sync/follow.js');
const { statusOf } = await import('../src/sync/session.js');

const START = 'http://start.freepower.test:9/start?profile=1';
const XSTOCKS = 'https://defi.xstocks.fi/points';
const STARTALE = 'https://app.startale.com/sign-up';

/* ================================================================== */
/* 假 CDP 客户端：`state.pages` 可以在测试中途改（模拟用户切/关/开标签）   */
/* ================================================================== */
/**
 * @param {Array<{targetId:string, url:string, visibility?:'visible'|'hidden'|null,
 *                href?:string, readFail?:boolean, injected?:boolean}>} pages
 */
function makeScene(pages) {
  const state = {
    pages: pages.map((p) => ({ ...p })),
    attached: new Map(), // sessionId -> targetId
    calls: [],
  };
  const handlers = new Map(); // event -> [fn]
  const client = {
    state,
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(fn);
    },
    emit(ev, payload) {
      for (const fn of handlers.get(ev) || []) fn(payload);
    },
    async send(method, params = {}, sessionId = null) {
      state.calls.push({ method, sessionId, targetId: params.targetId || null });
      if (method === 'Target.getTargets') {
        return { targetInfos: state.pages.map((p) => ({ type: 'page', targetId: p.targetId, url: p.url })) };
      }
      if (method === 'Target.attachToTarget') {
        const sid = `sess-${params.targetId}`;
        state.attached.set(sid, params.targetId);
        return { sessionId: sid };
      }
      if (method === 'Runtime.evaluate') {
        const tid = state.attached.get(sessionId);
        const p = state.pages.find((x) => x.targetId === tid);
        if (!p) throw new Error(`target 已经不在了：${tid}`);
        if (p.readFail) throw new Error('读不到（窗口最小化）');
        const v = p.visibility === undefined ? 'hidden' : p.visibility;
        const h = p.href !== undefined ? p.href : p.url;
        return {
          result: {
            value: JSON.stringify({
              v, h, i: p.injected === true,
              w: p.vw === undefined ? 1280 : p.vw,
              g: p.vh === undefined ? 800 : p.vh,
            }),
          },
        };
      }
      if (method === 'Target.detachFromTarget') {
        // 真 CDP 的 sessionId 在 params 里（不是 send 的第三个参数）
        state.attached.delete(params.sessionId ?? sessionId);
        return {};
      }
      return {};
    },
  };
  return client;
}
const countCalls = (scene, method) => scene.state.calls.filter((c) => c.method === method).length;

/* ================================================================== */
/* ① 会话中途切换可见标签 → 自动改投递到新标签                          */
/* ================================================================== */
console.log('\n— ① 用户中途切标签：投递目标必须跟着换（老实现绑死不换）—');
await t('① 一开始选可见的 xstocks（A 是后台的 startale）', async () => {
  const scene = makeScene([
    { targetId: 'A', url: STARTALE, visibility: 'hidden' },
    { targetId: 'B', url: XSTOCKS, visibility: 'visible' },
  ]);
  const f = new PageFollower({ client: scene });
  await f.refreshOnce();
  assert.equal(f.chosen.targetId, 'B', `选中了 ${f.chosen.targetId}`);
  assert.equal(f.chosen.source, 'visible');
  assert.equal(f.visibleTargetId, 'B');
});

await t('① 用户切到 A 标签 → chosen 变成 A，投递 session 指向 A', async () => {
  const scene = makeScene([
    { targetId: 'A', url: STARTALE, visibility: 'hidden' },
    { targetId: 'B', url: XSTOCKS, visibility: 'visible' },
  ]);
  const changes = [];
  const f = new PageFollower({ client: scene, onChosen: (next, prev) => changes.push({ next, prev }) });
  await f.refreshOnce();
  assert.equal(f.chosen.targetId, 'B');

  // 用户点了另一张标签：可见性对调
  scene.state.pages[0].visibility = 'visible';
  scene.state.pages[1].visibility = 'hidden';
  await f.refreshOnce();

  assert.equal(f.chosen.targetId, 'A', `还停在 ${f.chosen.targetId}`);
  assert.equal(f.chosen.url, STARTALE);
  assert.equal(changes.at(-1).next.targetId, 'A', 'onChosen 没被叫到');
  assert.equal(changes.at(-1).prev.targetId, 'B', '回调没带上一张');
  // 投递用的就是 A 的会话（受控窗口就是靠 sessionId 发 Input 的）
  assert.equal(scene.state.attached.get(f.pages.get('A').sessionId), 'A');
});

await t('① 轮询 5 次不会反复 attach/detach（每张页只有一条持久会话）', async () => {
  const scene = makeScene([
    { targetId: 'A', url: STARTALE, visibility: 'hidden' },
    { targetId: 'B', url: XSTOCKS, visibility: 'visible' },
  ]);
  const f = new PageFollower({ client: scene });
  for (let i = 0; i < 5; i++) await f.refreshOnce();
  assert.equal(countCalls(scene, 'Target.attachToTarget'), 2, `attach 了 ${countCalls(scene, 'Target.attachToTarget')} 次`);
  assert.equal(countCalls(scene, 'Target.detachFromTarget'), 0, '轮询不该 detach');
  assert.equal(f.ticks, 5);
});

/* ================================================================== */
/* ② 主控 target 被销毁 → 重新选目标；新标签出现 → 补装捕获            */
/* ================================================================== */
console.log('\n— ② 主控的标签被关掉 / 新开：重选 + 补装捕获 —');
await t('② 可见那张被关掉 → 自动落到剩下那张，并摘掉死掉的会话', async () => {
  const scene = makeScene([
    { targetId: 'A', url: XSTOCKS, visibility: 'visible' },
    { targetId: 'B', url: STARTALE, visibility: 'hidden' },
  ]);
  const removed = [];
  const f = new PageFollower({ client: scene, onPageRemoved: (tid) => removed.push(tid) });
  await f.refreshOnce();
  assert.equal(f.chosen.targetId, 'A');

  scene.state.pages = scene.state.pages.filter((p) => p.targetId !== 'A'); // 用户关掉了可见那张
  await f.refreshOnce();

  assert.deepEqual(removed, ['A'], `onPageRemoved=${JSON.stringify(removed)}`);
  assert.equal(f.chosen.targetId, 'B', `没有重选：${f.chosen.targetId}`);
  assert.equal(f.pages.has('A'), false, '死掉的 target 还留在表里');
  assert.equal(scene.state.attached.has('sess-A'), false, '死掉的会话没摘');
});

await t('② 新开一个标签并切过去 → 立刻补装捕获、并成为投递目标', async () => {
  const scene = makeScene([{ targetId: 'A', url: XSTOCKS, visibility: 'visible' }]);
  const added = [];
  const f = new PageFollower({ client: scene, onPageAdded: (tid) => added.push(tid) });
  await f.refreshOnce();
  assert.deepEqual(added, ['A'], `首次装捕获=${JSON.stringify(added)}`);

  scene.state.pages.push({ targetId: 'C', url: STARTALE, visibility: 'visible' });
  scene.state.pages[0].visibility = 'hidden';
  await f.refreshOnce();

  assert.deepEqual(added, ['A', 'C'], `新标签没装捕获：${JSON.stringify(added)}`);
  assert.equal(f.chosen.targetId, 'C');
});

await t('② 同一张页不会被重复装捕获（装两份 = 一条输入转发两次）', async () => {
  const scene = makeScene([
    { targetId: 'A', url: XSTOCKS, visibility: 'visible' },
    { targetId: 'B', url: STARTALE, visibility: 'hidden' },
  ]);
  const added = [];
  const f = new PageFollower({ client: scene, onPageAdded: (tid) => added.push(tid) });
  for (let i = 0; i < 4; i++) await f.refreshOnce();
  assert.deepEqual(added, ['A', 'B'], `装了 ${JSON.stringify(added)}`);
});

/* ================================================================== */
/* ③ 主控一张页都不剩 → 明确结束 + 人话                              */
/* ================================================================== */
console.log('\n— ③ 主窗口标签全关：必须明确结束，不许继续假装 running —');
await t('③ pages 归零 → onEmpty 触发一次，chosen 为 null', async () => {
  const scene = makeScene([{ targetId: 'A', url: XSTOCKS, visibility: 'visible' }]);
  let emptied = 0;
  const f = new PageFollower({ client: scene, onEmpty: () => { emptied += 1; } });
  await f.refreshOnce();
  assert.equal(emptied, 0);

  scene.state.pages = []; // 用户把主窗口所有标签都关了
  await f.refreshOnce();
  await f.refreshOnce();

  assert.equal(emptied >= 1, true, 'onEmpty 没触发（会话会一直假装 running）');
  assert.equal(f.pages.size, 0);
  assert.equal(f.chosen, null);
});

await t('③ staleHint 对「没有页面 / 停在起始页 / 很久没输入」各说人话', () => {
  assert.match(String(staleHint({ running: true, master_pages: 0 })), /标签/, staleHint({ running: true, master_pages: 0 }));
  assert.match(String(staleHint({ running: true, master_pages: 2, master_page_state: 'start', stale_ms: 0 })), /起始页/);
  assert.match(String(staleHint({ running: true, master_pages: 2, master_page_state: 'real', stale_ms: 8000 })), /没有捕获到输入/);
  assert.equal(staleHint({ running: true, master_pages: 2, master_page_state: 'real', stale_ms: 100 }), null);
  assert.equal(staleHint({ running: false, master_pages: 0 }), null, '没在跑时不该报警');
});

/* ================================================================== */
/* ④ 受控窗口的 target 消失                                            */
/* ================================================================== */
console.log('\n— ④ 受控窗口：标签没了要改投递，全没了要报降级 —');
await t('④ 受控窗口可见那张被关 → 改投递到剩下那张（sessionId 跟着换）', async () => {
  const scene = makeScene([
    { targetId: 'S1', url: XSTOCKS, visibility: 'visible' },
    { targetId: 'S2', url: STARTALE, visibility: 'hidden' },
  ]);
  const f = new PageFollower({ client: scene });
  await f.refreshOnce();
  const first = f.pages.get(f.chosen.targetId).sessionId;
  assert.equal(f.chosen.targetId, 'S1');

  scene.state.pages = scene.state.pages.filter((p) => p.targetId !== 'S1');
  await f.refreshOnce();

  assert.equal(f.chosen.targetId, 'S2');
  const now = f.pages.get(f.chosen.targetId).sessionId;
  assert.notEqual(now, first, '投递会话还是死掉那条');
  assert.equal(scene.state.attached.get(now), 'S2');
});

await t('④ 受控窗口标签全关 → chosen=null + onEmpty（调用方据此标 degraded）', async () => {
  const scene = makeScene([{ targetId: 'S1', url: XSTOCKS, visibility: 'visible' }]);
  let emptied = 0;
  const f = new PageFollower({ client: scene, onEmpty: () => { emptied += 1; } });
  await f.refreshOnce();
  scene.state.pages = [];
  await f.refreshOnce();
  assert.equal(f.chosen, null);
  assert.equal(emptied >= 1, true, '没有通知调用方（会静默跳过这个受控窗口）');
});

/* ================================================================== */
/* ⑤ R2：投递目标解析（每条事件派发前问一次，≤500ms 缓存）              */
/* ================================================================== */
console.log('\n— ⑤ 投递目标解析：缓存 ≤500ms、生命周期立刻失效、解析不到必须 null —');

await t('⑤ deliveryTarget 返回当前可见页的 sessionId + 视口（1:1 要用 innerWidth）', async () => {
  const scene = makeScene([
    { targetId: 'A', url: STARTALE, visibility: 'hidden', vw: 1000, vh: 700 },
    { targetId: 'B', url: XSTOCKS, visibility: 'visible', vw: 1600, vh: 900 },
  ]);
  const f = new PageFollower({ client: scene });
  const d = await f.deliveryTarget();
  assert.equal(d.targetId, 'B', `投到了 ${d.targetId}`);
  assert.equal(d.sessionId, 'sess-B');
  assert.equal(d.vw, 1600, `视口宽=${d.vw}`);
  assert.equal(d.vh, 900);
  assert.equal(d.url, XSTOCKS);
});

await t('⑤ 500ms 内连问 5 次只轮询一次（mousemove 风暴不许把内核压死）', async () => {
  const scene = makeScene([{ targetId: 'A', url: XSTOCKS, visibility: 'visible' }]);
  const f = new PageFollower({ client: scene });
  await f.deliveryTarget();
  const base = countCalls(scene, 'Target.getTargets');
  for (let i = 0; i < 5; i++) await f.deliveryTarget();
  assert.equal(countCalls(scene, 'Target.getTargets'), base,
    `又多轮询了 ${countCalls(scene, 'Target.getTargets') - base} 次`);
});

await t('⑤ 缓存过期后重新解析：用户切了标签 → 投递目标跟着换', async () => {
  const scene = makeScene([
    { targetId: 'A', url: STARTALE, visibility: 'hidden' },
    { targetId: 'B', url: XSTOCKS, visibility: 'visible' },
  ]);
  const f = new PageFollower({ client: scene });
  assert.equal((await f.deliveryTarget()).targetId, 'B');
  // 用户切到 A 标签
  scene.state.pages[0].visibility = 'visible';
  scene.state.pages[1].visibility = 'hidden';
  // maxAgeMs=0 = 强制重新解析（等价于「距上次已超过 500ms」）
  const d = await f.deliveryTarget({ maxAgeMs: 0 });
  assert.equal(d.targetId, 'A', `还投给 ${d.targetId}`);
  assert.equal(d.sessionId, 'sess-A');
});

await t('⑤ targetDestroyed 立刻让缓存失效（不等 500ms，也不等下一轮轮询）', async () => {
  const scene = makeScene([
    { targetId: 'A', url: STARTALE, visibility: 'hidden' },
    { targetId: 'B', url: XSTOCKS, visibility: 'visible' },
  ]);
  const f = new PageFollower({ client: scene });
  assert.equal((await f.deliveryTarget()).targetId, 'B');
  // 用户把可见那张关掉：生命周期事件立刻到
  scene.state.pages = scene.state.pages.filter((p) => p.targetId !== 'B');
  scene.emit('Target.targetDestroyed', { targetId: 'B' });
  const d = await f.deliveryTarget(); // 没有 maxAgeMs:0 —— 靠失效，不靠过期
  assert.ok(d, '投递目标解析成 null 了');
  assert.equal(d.targetId, 'A', `还投给 ${d.targetId}（那张已经没了）`);
});

await t('⑤ 窗口里一张 page 都没有 → deliveryTarget 返回 null（调用方记 skipped_no_target）', async () => {
  const scene = makeScene([]);
  const f = new PageFollower({ client: scene });
  assert.equal(await f.deliveryTarget(), null);
});

await t('⑤ 页面读不到（最小化）时仍给兜底目标，不是 null（不能因为读不到就全丢）', async () => {
  const scene = makeScene([{ targetId: 'A', url: XSTOCKS, readFail: true }]);
  const f = new PageFollower({ client: scene });
  const d = await f.deliveryTarget();
  assert.ok(d, '读不到可见性就返回 null 了 —— 用户会看到「没反应」');
  assert.equal(d.targetId, 'A');
  assert.equal(d.visible, null, '读不到就该是 null，不许伪装成 true/false');
});

await t('⑤ stop 之后 deliveryTarget 返回 null（别往已经拆掉的会话里投）', async () => {
  const scene = makeScene([{ targetId: 'A', url: XSTOCKS, visibility: 'visible' }]);
  const f = new PageFollower({ client: scene });
  await f.deliveryTarget();
  f.stop();
  assert.equal(await f.deliveryTarget(), null);
});

/* ================================================================== */
/* ⑥ 反向自证：不刷新（= 老实现不跟随）时，①的断言必须不成立            */
/* ================================================================== */
console.log('\n— ⑥ 反向自证：不跟随就必须还是旧的那张 —');
await t('⑥ 切了标签但不刷新 → chosen 仍是旧的那张（证明「跟随」不是白给的）', async () => {
  const scene = makeScene([
    { targetId: 'A', url: STARTALE, visibility: 'hidden' },
    { targetId: 'B', url: XSTOCKS, visibility: 'visible' },
  ]);
  const f = new PageFollower({ client: scene });
  await f.refreshOnce();
  assert.equal(f.chosen.targetId, 'B');
  scene.state.pages[0].visibility = 'visible';
  scene.state.pages[1].visibility = 'hidden';
  // 不 refresh：等价于老实现「启动时定死，之后不跟」
  assert.equal(f.chosen.targetId, 'B', '不刷新居然也变了，说明这条判据测不到东西');
  await f.refreshOnce();
  assert.equal(f.chosen.targetId, 'A', '刷新后必须变 —— 否则跟随逻辑没生效');
});

await t('⑥ 轮询间隔是 450ms（CEO 定的 400–500ms 区间）', () => {
  assert.equal(FOLLOW_INTERVAL_MS, 450);
});

/* ================================================================== */
/* ⑦ status 形状                                                      */
/* ================================================================== */
console.log('\n— ⑦ status 必须自己暴露「绑在死页上 / 很久没抓到」—');
function fakeSession(over = {}) {
  const now = Date.now();
  return {
    id: 'sess-1', master: 'm', slaves: ['s'], settings: {}, binding_name: 'bnd', probe_name: '_sdeadbeef',
    started_at: new Date(now - 9000).toISOString(),
    events: 5, forwarded: 4, dropped: 0,
    skipped_no_target: 0, dropped_out_of_view: 3, capture_reinstalled: 0,
    text_sent: 0, text_swallowed: 0,
    alive: true, alive_checked_ms: now - 500, last_capture_target_url: XSTOCKS,
    last_event_at: new Date(now - 8000).toISOString(), last_event_at_ms: now - 8000, started_ms: now - 9000,
    targets: new Map([
      ['m', { targetId: 'A', targetUrl: XSTOCKS, visible: true, confident: true, source: 'visible', viewport: { vw: 1, vh: 1 }, window: { width: 100 } }],
      ['s', {
        targetId: 'S1', targetUrl: XSTOCKS, visible: true, confident: true, source: 'visible',
        viewport: { vw: 1, vh: 1 }, window: { width: 100 },
        delivery_ok: true, delivery_target_url: XSTOCKS, skipped_no_target: 2, dropped_out_of_view: 3,
      }],
    ]),
    capture_pages: new Map([['A', 'sess-A']]),
    degraded: new Map(),
    followers: new Map([
      ['m', { pages: new Map([['A', {}]]), visibleTargetId: 'A', visibleHref: XSTOCKS }],
      ['s', { pages: new Map([['S1', {}]]), visibleTargetId: 'S1', visibleHref: XSTOCKS }],
    ]),
    targetEvents: new Map([['A', 5], ['S1', 4]]),
    scheduler: { stats: () => ({ sent: 1, pending: 0, errors: 0 }) },
    stopped: false,
    ...over,
  };
}

await t('⑦ windows[] 带 alive / events_from_this_target / pages（逐张明细，不是数字）', () => {
  const st = statusOf(fakeSession());
  const m = st.windows.find((w) => w.role === 'master');
  const s = st.windows.find((w) => w.role === 'slave');
  assert.equal(m.alive, true);
  assert.equal(m.events_from_this_target, 5);
  assert.equal(s.events_from_this_target, 4);
  /* 0.4.7.11 第二轮：`pages` 从数字改成数组 —— 用户报「投错标签」时，
   * 只给 `pages=2` 等于让人去 /json/list 里人肉映射 target_id。 */
  assert.equal(Array.isArray(m.pages), true, `pages 还是 ${typeof m.pages}`);
  assert.equal(m.pages.length, 1);
  assert.equal(m.pages[0].target_id, 'A');
  assert.equal(m.pages[0].is_current, true);
  assert.equal(m.pages_count, 1);
});

await t('⑦ R5：windows[] 带 delivery_target_url / delivery_ok / skipped_no_target / dropped_out_of_view', () => {
  const st = statusOf(fakeSession());
  const s = st.windows.find((w) => w.role === 'slave');
  assert.equal(s.delivery_target_url, XSTOCKS);
  assert.equal(s.delivery_ok, true);
  assert.equal(s.skipped_no_target, 2);
  assert.equal(s.dropped_out_of_view, 3);
  // 主控不投递，这几项必须是 0 / null，不能伪装成「投递成功」
  const m = st.windows.find((w) => w.role === 'master');
  assert.equal(m.delivery_ok, null);
  assert.equal(m.skipped_no_target, 0);
});

await t('⑦ R5 会话级：alive / targets_attached / last_capture_target_url / events_from_current_target', () => {
  const st = statusOf(fakeSession());
  assert.equal(st.alive, true);
  assert.equal(st.targets_attached, 1);
  assert.equal(st.last_capture_target_url, XSTOCKS);
  assert.equal(st.events_from_current_target, 5);
  assert.equal(st.capture_reinstalled, 0);
  assert.equal(st.skipped_no_target, 0);
  assert.equal(st.dropped_out_of_view, 3);
});

await t('⑦ alive=false（探针读不到）→ 必须如实报 false，不许看进程在不在', () => {
  const st = statusOf(fakeSession({ alive: false, last_capture_target_url: null }));
  assert.equal(st.alive, false);
  assert.equal(st.last_capture_target_url, null);
});

await t('⑦ 绑在已经不存在的 target 上 → alive=false（0.4.7.10 就是这里没人看得出）', () => {
  const sess = fakeSession();
  // follower 里已经没有 A 了（用户把那张页关了），但 targets 还记着它
  sess.followers = new Map([['m', { pages: new Map(), visibleTargetId: null, visibleHref: null }]]);
  const st = statusOf(sess);
  const m = st.windows.find((w) => w.role === 'master');
  assert.equal(m.alive, false, 'status 还在把死掉的 target 当活的');
  assert.equal(st.master_pages, 0);
});

await t('⑦ last_event_at / stale_ms / hint：8 秒没输入要给人话', () => {
  const st = statusOf(fakeSession());
  assert.equal(typeof st.last_event_at, 'string');
  assert.equal(st.stale_ms >= 7000, true, `stale_ms=${st.stale_ms}`);
  assert.match(String(st.hint), /没有捕获到输入/, String(st.hint));
  /* R1 删掉闸门之后这两项恒为 0 —— 但形状要保住，老界面/判据还在读 */
  assert.equal(st.gated, 0);
  assert.equal(st.master_page_state, 'real');
});

await t('⑦ 会话已停 → stale_ms 归零、不再报警、带 end_reason', () => {
  const st = statusOf(fakeSession({ stopped: true, end_reason: 'master_target_gone', end_message: '主窗口的标签全部关闭了' }));
  assert.equal(st.running, false);
  assert.equal(st.stale_ms, 0);
  assert.equal(st.hint, null);
  assert.equal(st.end_reason, 'master_target_gone');
});

/* ================================================================== */
/* ⑧ 选目标口径与 0.4.7.10 一致（choosePage 就是 pickPageTarget 的内核）*/
/* ================================================================== */
console.log('\n— ⑧ choosePage：可见优先、兜底跳过起始页、口径不变 —');
await t('⑧ 可见 + 真站优先', () => {
  const vis = new Map([['A', { state: 'hidden', href: STARTALE }], ['B', { state: 'visible', href: XSTOCKS }]]);
  const got = choosePage([{ targetId: 'A', url: STARTALE }, { targetId: 'B', url: XSTOCKS }], vis);
  assert.equal(got.targetId, 'B');
  assert.equal(got.source, 'visible');
});

await t('⑧ 可见的是起始页 → 退回第一张真站，confident=false', () => {
  const vis = new Map([['S', { state: 'visible', href: START }], ['A', { state: 'hidden', href: XSTOCKS }]]);
  const got = choosePage([{ targetId: 'S', url: START }, { targetId: 'A', url: XSTOCKS }], vis);
  assert.equal(got.targetId, 'A');
  assert.equal(got.source, 'real-fallback');
  assert.equal(got.confident, false);
  assert.equal(got.visible_url, START);
});

await t('⑧ pageKind 认得出起始页 / 错误页 / 内部页 / 真站', () => {
  assert.equal(pageKind(START), 'start');
  assert.equal(pageKind('chrome-error://chromewebdata/'), 'error');
  assert.equal(pageKind('chrome://settings'), 'internal');
  assert.equal(pageKind('about:blank'), 'blank');
  assert.equal(pageKind(XSTOCKS), 'real');
});

/* ================================================================== */
/* ⑨ 事件驱动定激活标签（0.4.7.11 第二轮：焦点模拟把 visibility 覆盖了）*/
/* ================================================================== */
/**
 * 现场（2026-11-21，CEO 实机 `node .tmp/e2e/run.cjs --no-arrange`）：
 *   受控窗口标题已经是 FP-E2E-LAB:B2，但投递还打在 B1；两张标签**同时**报
 *   `vis=visible focus=true`。
 *
 * 实测根因（`.tmp/e2e/vis2.cjs`，真内核）：
 *   后台页 未开焦点模拟: {"vis":"hidden","focus":false}
 *   后台页 开了焦点模拟: {"vis":"visible","focus":true}   ← R7 把可见性信号一起覆盖了
 *
 * 所以「两张都 visible」时，轮询只能退回列表第一张；必须靠页面自己上报
 * `visibilitychange` 才能知道用户真的切到了哪张。
 */
console.log('\n— ⑨ 事件驱动：两张都报 visible 时，也要跟到用户真正切过去的那张 —');

await t('⑨ 两张都 visible（焦点模拟污染的现场）→ 轮询选第一张，事件上报能纠正', async () => {
  const scene = makeScene([
    { targetId: 'B1', url: XSTOCKS, visibility: 'visible' },
    { targetId: 'B2', url: STARTALE, visibility: 'visible' },
  ]);
  const f = new PageFollower({ client: scene });
  await f.refreshOnce();
  // 轮询口径：两张都 visible，只能选列表第一张（这就是 bug 的表现）
  assert.equal(f.chosen.targetId, 'B1', `轮询选了 ${f.chosen.targetId}`);
  assert.equal(f.chosen.signal, 'poll');
  // 用户真的切到了 B2：B2 页面自己上报「我变成可见了」
  f.setActiveTarget('B2', STARTALE);
  assert.equal(f.chosen.targetId, 'B2', `上报之后还停在 ${f.chosen.targetId}`);
  assert.equal(f.chosen.signal, 'event');
  assert.equal(f.chosen.source, 'visible');
  assert.equal(f.chosen.confident, true);
  assert.equal(f.activeTargetId, 'B2');
  assert.equal(f.activationSeen, true);
});

await t('⑨ 事件上报能压过轮询（轮询仍说 B1 可见，目标不许被拉回去）', async () => {
  const scene = makeScene([
    { targetId: 'B1', url: XSTOCKS, visibility: 'visible' },
    { targetId: 'B2', url: STARTALE, visibility: 'visible' },
  ]);
  const f = new PageFollower({ client: scene });
  await f.refreshOnce();
  f.setActiveTarget('B2');
  await f.refreshOnce();
  await f.refreshOnce();
  assert.equal(f.chosen.targetId, 'B2', `轮询把目标拉回了 ${f.chosen.targetId}`);
  assert.equal(f.chosen.signal, 'event');
});

await t('⑨ 上报的那张页被关掉 → 事件信号清掉，退回轮询口径（不绑死死页）', async () => {
  const scene = makeScene([
    { targetId: 'B1', url: XSTOCKS, visibility: 'visible' },
    { targetId: 'B2', url: STARTALE, visibility: 'hidden' },
  ]);
  const f = new PageFollower({ client: scene });
  await f.refreshOnce();
  f.setActiveTarget('B2');
  assert.equal(f.chosen.targetId, 'B2');
  scene.state.pages = scene.state.pages.filter((p) => p.targetId !== 'B2');
  scene.emit('Target.targetDestroyed', { targetId: 'B2' });
  assert.equal(f.activeTargetId, null, '死页还挂在 activeTargetId 上');
  assert.equal(f.chosen.targetId, 'B1', `关掉 B2 之后选了 ${f.chosen.targetId}`);
});

await t('⑨ 上报来自一张表里还没有的页 → 先记下，入表后照样选中它', async () => {
  const scene = makeScene([{ targetId: 'B1', url: XSTOCKS, visibility: 'visible' }]);
  const f = new PageFollower({ client: scene });
  await f.refreshOnce();
  // targetCreated 还没到，页面先报了（顺序真的会反）
  f.setActiveTarget('B9', STARTALE);
  assert.equal(f.activeTargetId, 'B9');
  scene.state.pages.push({ targetId: 'B9', url: STARTALE, visibility: 'hidden' });
  await f.refreshOnce();
  assert.equal(f.chosen.targetId, 'B9', `入表之后没选它：${f.chosen.targetId}`);
});

await t('⑨ 上报的是起始页 → 不许把起始页当同步目标（口径不变）', async () => {
  const scene = makeScene([
    { targetId: 'S', url: START, visibility: 'visible' },
    { targetId: 'A', url: XSTOCKS, visibility: 'hidden' },
  ]);
  const f = new PageFollower({ client: scene });
  await f.refreshOnce();
  f.setActiveTarget('S', START);
  assert.equal(f.chosen.targetId, 'A', `把起始页选成目标了：${f.chosen.targetId}`);
  assert.equal(f.chosen.source, 'real-fallback');
});

await t('⑨ choosePage 的 activeTargetId 优先级（纯函数直测）', () => {
  const vis = new Map([['A', { state: 'visible', href: XSTOCKS }], ['B', { state: 'visible', href: STARTALE }]]);
  const pages = [{ targetId: 'A', url: XSTOCKS }, { targetId: 'B', url: STARTALE }];
  const polled = choosePage(pages, vis);
  assert.equal(polled.targetId, 'A', '轮询口径应选第一张');
  const byEvent = choosePage(pages, vis, { activeTargetId: 'B' });
  assert.equal(byEvent.targetId, 'B');
  assert.equal(byEvent.signal, 'event');
  // activeTargetId 不在列表里 → 不许凭空选它，退回轮询
  const stale = choosePage(pages, vis, { activeTargetId: 'GONE' });
  assert.equal(stale.targetId, 'A');
  assert.equal(stale.signal, 'poll');
});

await t('⑨ status 里能看到每张页的 active / is_current / target_signal', () => {
  const sess = fakeSession();
  const f = { pages: new Map([['S1', { targetId: 'S1', href: XSTOCKS, state: 'visible' }]]), visibleTargetId: 'S1', visibleHref: XSTOCKS, activeTargetId: 'S1', activationSeen: true };
  sess.followers = new Map([['m', f], ['s', f]]);
  const st = statusOf(sess);
  const s = st.windows.find((w) => w.role === 'slave');
  assert.equal(s.activation, 'event');
  assert.equal(Array.isArray(s.pages), true);
  assert.equal(s.pages[0].active, true);
  assert.equal(s.pages[0].is_current, true);
  assert.equal(s.pages[0].target_id, 'S1');
  assert.equal(s.pages[0].alive, true);
});

/* ================================================================== */
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
