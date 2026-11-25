/**
 * 0.4.7.14 标签镜像的 A 层判据（零 Chrome）：假 CDP 客户端驱动 TabMirror。
 *
 * 钉的是用户 2026-11-25 报的两件事：主控**新开标签**、主控**打开新链接**，受控必须跟着做；
 * 以及两条防重复：点击回放已让受控开出/跳到同一页时，**不许再开一张 / 再跳一次**。
 *
 * 跑法：node --no-warnings test/sync-tab-mirror.test.mjs
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

const { TabMirror, sameUrl, mirrorableUrl } = await import('../src/sync/tab-mirror.js');

/** 最小假浏览器：targets 表 + 记录收到的命令 */
function fakeBrowser(name, pages = []) {
  let n = 0;
  const b = {
    name, calls: [],
    targets: pages.map((p) => ({ type: 'page', ...p })),
    async send(method, params = {}) {
      b.calls.push({ method, params });
      if (method === 'Target.getTargets') return { targetInfos: b.targets.map((x) => ({ ...x })) };
      if (method === 'Target.createTarget') { const id = `${name}-new${++n}`; b.targets.push({ type: 'page', targetId: id, url: params.url }); return { targetId: id }; }
      if (method === 'Target.attachToTarget') return { sessionId: `s-${params.targetId}` };
      if (method === 'Page.navigate') {
        const tid = params.__tid; return {};
      }
      if (method === 'Target.closeTarget') { b.targets = b.targets.filter((x) => x.targetId !== params.targetId); return { success: true }; }
      return {};
    },
  };
  // navigate 要知道是哪张页：从最近一次 attach 推出来
  const orig = b.send;
  let lastAttach = null;
  b.send = async (method, params = {}, sid) => {
    if (method === 'Target.attachToTarget') lastAttach = params.targetId;
    if (method === 'Page.navigate' && lastAttach) {
      const p = b.targets.find((x) => x.targetId === lastAttach); if (p) p.url = params.url;
    }
    return orig(method, params, sid);
  };
  return b;
}
const count = (b, m) => b.calls.filter((c) => c.method === m).length;

function setup() {
  const M = fakeBrowser('M', [{ targetId: 'M1', url: 'https://a.test/' }]);
  const S1 = fakeBrowser('S1', [{ targetId: 'A1', url: 'https://a.test/' }]);
  const S2 = fakeBrowser('S2', [{ targetId: 'B1', url: 'https://a.test/' }]);
  const slaves = { S1, S2 };
  const mirror = new TabMirror({
    masterClient: M, masterId: 'M', slaves: () => ['S1', 'S2'], slaveClient: (id) => slaves[id],
    settings: () => ({}), settleMs: 5,
  });
  mirror.seed('M1', new Map([['S1', 'A1'], ['S2', 'B1']]));
  return { M, S1, S2, mirror };
}

console.log('\n— 1. 纯函数 —');
await t('sameUrl 忽略 #hash 与末尾斜杠', () => {
  assert.ok(sameUrl('https://x.test/a#b', 'https://x.test/a/'));
  assert.ok(!sameUrl('https://x.test/a', 'https://x.test/b'));
});
await t('mirrorableUrl 只放行 http/https，chrome:// 新标签页当空白', () => {
  assert.equal(mirrorableUrl('chrome://new-tab-page/'), null);
  assert.equal(mirrorableUrl('https://x.test/'), 'https://x.test/');
});

console.log('\n— 2. 主控新开标签 —');
await t('主控新开空白标签 → 每个受控各开一张', async () => {
  const { M, S1, S2, mirror } = setup();
  M.targets.push({ type: 'page', targetId: 'M2', url: 'chrome://new-tab-page/' });
  await mirror.onMasterTabAdded('M2');
  assert.equal(count(S1, 'Target.createTarget'), 1);
  assert.equal(count(S2, 'Target.createTarget'), 1);
  assert.equal(mirror.status().opened, 2);
});
await t('新开标签后在里面打开网址 → 受控对应那张跟着跳', async () => {
  const { M, S1, S2, mirror } = setup();
  M.targets.push({ type: 'page', targetId: 'M2', url: 'chrome://new-tab-page/' });
  await mirror.onMasterTabAdded('M2');
  M.targets.find((x) => x.targetId === 'M2').url = 'https://b.test/';
  await mirror.onMasterNavigated('M2', 'https://b.test/');
  for (const S of [S1, S2]) assert.ok(S.targets.some((x) => x.url === 'https://b.test/'), `${S.name} 没跳到 b.test`);
  assert.equal(mirror.status().navigated, 2);
});
await t('target=_blank：受控已被点击回放带出同 opener 的新页 → 认领，不再另开', async () => {
  const { M, S1, S2, mirror } = setup();
  M.targets.push({ type: 'page', targetId: 'M2', url: 'https://c.test/', openerId: 'M1' });
  S1.targets.push({ type: 'page', targetId: 'A2', url: 'https://c.test/', openerId: 'A1' });
  S2.targets.push({ type: 'page', targetId: 'B2', url: 'https://c.test/', openerId: 'B1' });
  await mirror.onMasterTabAdded('M2');
  assert.equal(count(S1, 'Target.createTarget') + count(S2, 'Target.createTarget'), 0, '不许多开');
  assert.equal(mirror.status().adopted, 2);
});

console.log('\n— 3. 主控打开新链接 —');
await t('主控当前标签跳到新地址（地址栏 / 点链接）→ 受控跟着跳', async () => {
  const { M, S1, S2, mirror } = setup();
  M.targets[0].url = 'https://d.test/x';
  await mirror.onMasterNavigated('M1', 'https://d.test/x');
  assert.equal(S1.targets[0].url, 'https://d.test/x');
  assert.equal(S2.targets[0].url, 'https://d.test/x');
});
await t('点击回放已让受控跳到同一页 → 不再跳第二次', async () => {
  const { M, S1, S2, mirror } = setup();
  M.targets[0].url = 'https://e.test/';
  S1.targets[0].url = 'https://e.test/';
  S2.targets[0].url = 'https://e.test/#top';
  await mirror.onMasterNavigated('M1', 'https://e.test/');
  assert.equal(count(S1, 'Page.navigate') + count(S2, 'Page.navigate'), 0);
});
await t('没镜像过的主控标签（会话开始前就在后台的）不动受控', async () => {
  const { S1, S2, mirror } = setup();
  await mirror.onMasterNavigated('M-old', 'https://f.test/');
  assert.equal(count(S1, 'Page.navigate') + count(S2, 'Page.navigate'), 0);
});

console.log('\n— 4. 切换 / 关闭 —');
await t('主控切到镜像过的标签 → 受控 activateTarget 对应那张', async () => {
  const { S1, S2, mirror } = setup();
  await mirror.onMasterActivated('M1');
  assert.ok(S1.calls.some((c) => c.method === 'Target.activateTarget' && c.params.targetId === 'A1'));
  assert.ok(S2.calls.some((c) => c.method === 'Target.activateTarget' && c.params.targetId === 'B1'));
});
await t('主控关掉新开的标签 → 受控对应的也关', async () => {
  const { M, S1, S2, mirror } = setup();
  M.targets.push({ type: 'page', targetId: 'M2', url: 'chrome://new-tab-page/' });
  await mirror.onMasterTabAdded('M2');
  await mirror.onMasterTabRemoved('M2');
  assert.equal(count(S1, 'Target.closeTarget'), 1);
  assert.equal(count(S2, 'Target.closeTarget'), 1);
});

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail}/${results.length} 通过`);
process.exit(fail ? 1 : 0);
