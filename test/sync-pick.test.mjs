/**
 * 「同步到底连哪张标签」的判据（0.4.7.10）。
 *
 * 起因（用户 2026-11-21 实测，CEO 把链路量到底）：
 *   指纹正常、窗口排列正常、同步能启动，但**操作主控受控窗口不跟着动**。
 *   采集端 events=105 / forwarded=105 / dropped=0、调度器 sent=311 errors=0，全正常；
 *   受控窗口也吃 CDP 输入（注入 5 次 mouseWheel，scrollY 0→1500）。
 *   断的是「连错了标签」：主控和 3 个受控窗口各开了 3–4 个标签，**可见**的都是
 *   `defi.xstocks.fi/points`，但后台挂着 `app.startale.com/sign-up`；
 *   旧 `pickPageTarget()` 取「第一张 URL 像真站的 page」，startale 在 `/json/list` 里排前面，
 *   于是输入全打到那张看不见的页上。
 *   11-18 那轮能过（events=89 forwarded=89），是因为当时每个窗口只有起始页一张。
 *
 * 这条判据用**假 CDP 客户端**（不发真内核、不碰用户环境）真求值 `pickPageTarget()`：
 *   ① 可见的不是第一张 → 必须选可见那张（旧代码必红）
 *   ② 反向自证：把可见性读不到（等价于旧实现不看可见性）→ 选中的是后台那张，与 ① 不同
 *   ③ 一个都读不到可见 → 退回兜底，`confident:false`，不许假称自信
 *   ④ 主控那条同口径（可见页不是第一张时选可见的）+ 主窗口「前台是起始页」的守卫
 *   ⑤ 起始页仍是可见标签 → 按原口径跳过起始页，不许把 0.4.7.3 那条修好的东西搞丢
 *   ⑥ status.windows[] 必须自报 target_url / visible（这次就是没人看得出「连错页」）
 *
 * 跑法：npm run test:sync-pick
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

const { pickPageTarget, masterBlockReason, statusOf } = await import('../src/sync/session.js');

/* ================================================================== */
/* 假 CDP 客户端：只实现 pickPageTarget 用到的四条命令                  */
/* ================================================================== */
/**
 * @param {Array<{targetId:string, url:string, visibility?:'visible'|'hidden'|null, href?:string, readFail?:boolean}>} pages
 *   `visibility: null` = 读得到 evaluate，但 `document.visibilityState` 不是 visible/hidden（异常值）
 *   `readFail: true`  = attach/evaluate 直接抛错（窗口最小化、target 已关）
 *   `href`            = 页面**真实** location.href（不给就用 url；用来模拟「targetInfo 的 url 是假的」）
 */
function fakeClient(pages) {
  const attached = new Map();   // sessionId -> targetId
  const calls = [];
  return {
    calls,
    async send(method, params = {}, sessionId = null) {
      calls.push({ method, sessionId });
      if (method === 'Target.getTargets') {
        return { targetInfos: pages.map((p) => ({ type: 'page', targetId: p.targetId, url: p.url })) };
      }
      if (method === 'Target.attachToTarget') {
        const sid = `sess-${params.targetId}`;
        attached.set(sid, params.targetId);
        return { sessionId: sid };
      }
      if (method === 'Runtime.evaluate') {
        const tid = attached.get(sessionId);
        const p = pages.find((x) => x.targetId === tid);
        if (!p) throw new Error(`unknown session ${sessionId}`);
        if (p.readFail) throw new Error('attach 失败：窗口已最小化');
        const v = p.visibility === undefined ? 'hidden' : p.visibility;
        const h = p.href !== undefined ? p.href : p.url;
        return { result: { value: JSON.stringify({ v, h }) } };
      }
      if (method === 'Target.detachFromTarget') return {};
      return {};
    },
  };
}

const START = 'http://start.freepower.test:9/start?profile=1';
const XSTOCKS = 'https://defi.xstocks.fi/points';
const STARTALE = 'https://app.startale.com/sign-up';

/* ================================================================== */
/* ① 用户这次的现场：startale 排前面（后台），xstocks 可见             */
/* ================================================================== */
console.log('\n— ① 可见的不是第一张：必须选可见那张（旧代码选 startale，必红）—');
/** 现场还原：/json/list 顺序 = startale, xstocks；可见的是 xstocks */
const scene = () => [
  { targetId: 'EC27CBC176', url: STARTALE, visibility: 'hidden' },
  { targetId: '8F51836F0E', url: XSTOCKS, visibility: 'visible' },
];

await t('① 选中的是可见的 xstocks（不是排在前面的 startale）', async () => {
  const got = await pickPageTarget(fakeClient(scene()));
  assert.equal(got.targetId, '8F51836F0E', `选中了 ${got.targetId} / ${got.url}`);
  assert.equal(got.url, XSTOCKS);
});
await t('① 标成「实测可见」：visible=true、confident=true、source=visible', async () => {
  const got = await pickPageTarget(fakeClient(scene()));
  assert.equal(got.visible, true);
  assert.equal(got.confident, true);
  assert.equal(got.source, 'visible');
});

/* ================================================================== */
/* ② 反向自证：让可见性读不到（等价于旧实现「完全不看可见性」）          */
/* ================================================================== */
console.log('\n— ② 反向自证：不看可见性时选的是 startale（证明 ① 这条门不是空的）—');
await t('② 可见性全读不到 → 退回第一张真站 = startale（正是旧的错误结果）', async () => {
  const blind = scene().map((p) => ({ ...p, readFail: true }));
  const got = await pickPageTarget(fakeClient(blind));
  assert.equal(got.targetId, 'EC27CBC176', `本该退回 startale，实际 ${got.targetId}`);
  assert.equal(got.confident, false);
});
await t('② ① 与 ② 结果必须不同（否则这条判据区分不出「看没看可见性」）', async () => {
  const a = await pickPageTarget(fakeClient(scene()));
  const b = await pickPageTarget(fakeClient(scene().map((p) => ({ ...p, readFail: true }))));
  assert.notEqual(a.targetId, b.targetId, '两种情况下选的是同一张 → 判据没有区分力');
});

/* ================================================================== */
/* ③ 一个都读不到可见 → 兜底 + confident:false                          */
/* ================================================================== */
console.log('\n— ③ 读不到可见（窗口最小化等）→ 兜底且如实标「不自信」—');
await t('③ 全部 attach 失败 → 选第一张真站、confident=false、source=real-fallback', async () => {
  const got = await pickPageTarget(fakeClient(scene().map((p) => ({ ...p, readFail: true }))));
  assert.equal(got.source, 'real-fallback');
  assert.equal(got.confident, false);
  assert.equal(got.visible, null, 'visible 应该是 null（没读到），不许瞎猜成 false');
});
await t('③ 可见性读到的是异常值（不是 visible/hidden）→ 同样走兜底、confident=false', async () => {
  const got = await pickPageTarget(fakeClient(scene().map((p) => ({ ...p, visibility: null }))));
  assert.equal(got.source, 'real-fallback');
  assert.equal(got.confident, false);
});
await t('③ 兜底时仍跳过起始页（起始页排在第一个也不选它）', async () => {
  const got = await pickPageTarget(fakeClient([
    { targetId: 'START', url: START, readFail: true },
    { targetId: 'HIDDEN', url: STARTALE, readFail: true },
  ]));
  assert.equal(got.targetId, 'HIDDEN');
});

/* ================================================================== */
/* ④ 主控那条：同一套口径 + 「前台是起始页」的守卫                      */
/* ================================================================== */
console.log('\n— ④ 主控同口径：可见页不是第一张时，捕获目标要选可见的 —');
await t('④ 主控窗口 3 张页（startale 在前、xstocks 可见）→ 选 xstocks', async () => {
  const got = await pickPageTarget(fakeClient([
    { targetId: 'M-STARTALE', url: STARTALE, visibility: 'hidden' },
    { targetId: 'M-XSTOCKS', url: XSTOCKS, visibility: 'visible' },
    { targetId: 'M-OTHER', url: 'https://example.com/', visibility: 'hidden' },
  ]));
  assert.equal(got.targetId, 'M-XSTOCKS');
  assert.equal(got.confident, true);
});
await t('④ 主控：可见页停在起始页、真站在后台 → 拒绝（不许悄悄同步后台页）', async () => {
  const why = masterBlockReason({ href: XSTOCKS, injected: true, visibleUrl: START });
  assert.ok(why, '本该拒绝，却返回了 null（能同步）');
  assert.match(String(why), /起始页/);
});
await t('④ 主控：可见页就是真站 → 允许（不误伤正常场景）', async () => {
  assert.equal(masterBlockReason({ href: XSTOCKS, injected: true, visibleUrl: XSTOCKS }), null);
});
await t('④ 主控：读不到可见信息时，仍按 0.4.7.5 原口径判（起始页 → 拒绝）', async () => {
  assert.match(String(masterBlockReason({ href: START, injected: true, visibleUrl: null })), /起始页/);
});
await t('④ 主控：错误页仍然拒绝（0.4.7.4 那条不许丢）', async () => {
  assert.match(String(masterBlockReason({ href: 'chrome-error://chromewebdata/', injected: true })), /错误页/);
});

/* ================================================================== */
/* ⑤ 起始页仍是可见标签 → 按原口径跳过，不许把 0.4.7.3 的修法搞丢        */
/* ================================================================== */
console.log('\n— ⑤ 起始页可见时：跳过起始页（0.4.7.3 那条不许丢）—');
await t('⑤ 可见的是起始页、后台有真站 → 选真站（不选起始页）', async () => {
  const got = await pickPageTarget(fakeClient([
    { targetId: 'S1', url: START, visibility: 'visible' },
    { targetId: 'S2', url: XSTOCKS, visibility: 'hidden' },
  ]));
  assert.equal(got.targetId, 'S2');
  assert.equal(got.confident, false, '可见页不可用、走了兜底 → 必须标不自信');
});
await t('⑤ 只有起始页一张 → 只能选它（不返回 null，交给上层拒绝）', async () => {
  const got = await pickPageTarget(fakeClient([{ targetId: 'ONLY', url: START, visibility: 'visible' }]));
  assert.equal(got.targetId, 'ONLY');
  assert.equal(got.confident, false);
  assert.equal(got.source, 'first-page');
});
await t('⑤ 空白页 / chrome://newtab 永远不当真站', async () => {
  const got = await pickPageTarget(fakeClient([
    { targetId: 'B1', url: 'about:blank', visibility: 'visible' },
    { targetId: 'B2', url: 'chrome://newtab', visibility: 'hidden' },
    { targetId: 'B3', url: XSTOCKS, visibility: 'hidden' },
  ]));
  assert.equal(got.targetId, 'B3');
});

/* ================================================================== */
/* ⑥ 真实 href 优先于 targetInfo.url（错误页那里 targetInfo 会撒谎）     */
/* ================================================================== */
console.log('\n— ⑥ 用页面自己报的 href 判，不信 targetInfo.url —');
await t('⑥ targetInfo 说是真站、页面实际停在 chrome-error → 不当真站', async () => {
  const got = await pickPageTarget(fakeClient([
    { targetId: 'E1', url: 'http://127.0.0.1:1/nope', href: 'chrome-error://chromewebdata/', visibility: 'visible' },
    { targetId: 'E2', url: XSTOCKS, visibility: 'hidden' },
  ]));
  assert.equal(got.targetId, 'E2', '把错误页当真站选走了');
});
await t('⑥ 起始页同理：targetInfo 骗人也骗不过', async () => {
  const got = await pickPageTarget(fakeClient([
    { targetId: 'P1', url: 'https://looks-real.example/', href: START, visibility: 'visible' },
    { targetId: 'P2', url: XSTOCKS, visibility: 'hidden' },
  ]));
  assert.equal(got.targetId, 'P2');
});

/* ================================================================== */
/* ⑦ status.windows[] 必须自报「连的是哪张页、可见不可见」               */
/* ================================================================== */
console.log('\n— ⑦ status 可观测性：windows[] 带 target_url / visible —');
const fakeSession = () => ({
  id: 'sid', master: 'm', slaves: ['s'], settings: {}, binding_name: 'b', started_at: 'now',
  events: 0, forwarded: 0, dropped: 0, text_sent: 0, text_swallowed: 0, stopped: false,
  scheduler: { stats: () => ({ sent: 0, errors: 0, pending: 0 }) },
  degraded: new Map(),
  targets: new Map([
    ['m', { targetId: 'T-M', targetUrl: XSTOCKS, visible: true, confident: true, source: 'visible', viewport: { vw: 1, vh: 1 }, window: { width: 100 } }],
    ['s', { targetId: 'T-S', targetUrl: STARTALE, visible: false, confident: false, source: 'real-fallback', viewport: { vw: 1, vh: 1 }, window: { width: 100 } }],
  ]),
});

await t('⑦ windows[] 每条都有 target_url 与 visible', () => {
  const st = statusOf(fakeSession());
  for (const w of st.windows) {
    assert.ok('target_url' in w, `${w.profile_id} 缺 target_url`);
    assert.ok('visible' in w, `${w.profile_id} 缺 visible`);
  }
  assert.equal(st.windows.find((w) => w.role === 'master').target_url, XSTOCKS);
  assert.equal(st.windows.find((w) => w.role === 'slave').target_url, STARTALE);
});
await t('⑦ visible 如实反映：可见=true、后台=false，没读到=null', () => {
  const st = statusOf(fakeSession());
  assert.equal(st.windows.find((w) => w.role === 'master').visible, true);
  assert.equal(st.windows.find((w) => w.role === 'slave').visible, false);
  const unknown = fakeSession();
  unknown.targets.get('s').visible = null;
  assert.equal(statusOf(unknown).windows.find((w) => w.role === 'slave').visible, null);
});
await t('⑦ 还带 confident / target_source，一眼看出「这张是猜的」', () => {
  const st = statusOf(fakeSession());
  assert.equal(st.windows.find((w) => w.role === 'master').confident, true);
  assert.equal(st.windows.find((w) => w.role === 'slave').confident, false);
  assert.equal(st.windows.find((w) => w.role === 'slave').target_source, 'real-fallback');
});

/* ================================================================== */
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
