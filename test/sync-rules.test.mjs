/**
 * 窗口同步阶段 1 的 A 层判据：**纯函数 + 路由清单，不需要 Chrome**。
 *
 * 覆盖四块：
 *   1. 坐标映射 `mapPoint`（视口比例，含退化输入）；
 *   2. 事件 → CDP 计划 `buildInputPlan` / `buildKeyPlan`（顺序、修饰键、滚动增量）；
 *   3. 四个开关 `enabledBySwitch`（**两个方向都测** —— 只测「开着能用」等于没测）；
 *   4. 调度与随机 `SyncScheduler` / `makeRng` / 文本工具；
 *   5. 捕获脚本的形状（binding 名、delete 而非覆盖、不含检测面字面量）；
 *   6. 会话状态与 5 条 sync 路由。
 *
 * 反向断言（阻抗）：每块都带一条「把它改成显然错的实现就会红」的检查，
 * 例如「不同视口必须给出不同坐标」——直传绝对像素的实现过不了；
 * 「click:false 必须丢 down/up」——恒真实现过不了。
 *
 * 跑法：node --no-warnings test/sync-rules.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// 会话模块会 import manager → config：数据目录必须在 import 之前指到临时目录，
// 否则会把测试产物写进仓库 data/（那是用户真实数据所在）。
const dataDir = path.join(os.tmpdir(), `freepower-sync-${Date.now()}`);
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_SELFCHECK = '0';

const { mapPoint, buildInputPlan, buildKeyPlan, enabledBySwitch, EVENT_SWITCH, MOD } =
  await import('../src/sync/replay.js');
const { makeRng, SyncScheduler, pickLine, randomNumber, typingDelays } =
  await import('../src/sync/scheduler.js');
const { buildCaptureScript, FORBIDDEN_IN_SCRIPT } = await import('../src/sync/agent-script.js');
const { normalizeSettings, DEFAULT_SETTINGS, syncStatus, unusableMasterPage } = await import('../src/sync/session.js');

/** 保持事件循环活着：调度器的定时器是 unref 的，只 await promise 进程会提前退出 */
function keepAlive() {
  const t = setInterval(() => {}, 50);
  return () => clearInterval(t);
}

/* ============================ 1. 坐标映射 ============================ */
console.log('\n— 1. 坐标映射（客户区原值 1:1，越界丢弃）—');

/* 依据 `adspower-reverse/8.9.23/34-窗口同步真实行为.md` §5.1/§5.2 实测：
 * 主控 clientX = 246/446/646 时受控收到的**完全相同**；主控 900/900 时受控 **0 条**。
 * 所以规则是「原值直传 + 越界丢弃」，不是「按视口比例缩放」。 */
const c720 = mapPoint({ x: 246, y: 180 }, { vw: 1280, vh: 720 });
check('原值直传：246,180 在 1280×720 里仍是 246,180',
  c720 && c720.x === 246 && c720.y === 180, JSON.stringify(c720));

const c1080 = mapPoint({ x: 246, y: 180 }, { vw: 1920, vh: 1080 });
check('同一坐标在 1920×1080 里也不变（1:1，不按视口缩放）',
  c1080 && c1080.x === 246 && c1080.y === 180, JSON.stringify(c1080));

// 反向：如果实现又退回「按比例缩放」，两个视口会给出不同结果 —— 这条会红
check('不同视口给出**相同**坐标（防「按视口比例缩放」的实现）',
  c720.x === c1080.x && c720.y === c1080.y, `${c720.x},${c720.y} vs ${c1080.x},${c1080.y}`);

check('(0,0) 合法（左上角真的能点）',
  JSON.stringify(mapPoint({ x: 0, y: 0 }, { vw: 800, vh: 600 })) === '{"x":0,"y":0}',
  JSON.stringify(mapPoint({ x: 0, y: 0 }, { vw: 800, vh: 600 })));

/* 越界：实测是**丢弃**，不是夹到边上（夹边会点在完全不同的元素上） */
check('主控 900/900 超出受控 800×600 → null（越界丢弃，不夹边）',
  mapPoint({ x: 900, y: 900 }, { vw: 800, vh: 600 }) === null);
check('x 刚好等于视口宽 → null（客户区是 [0,vw) 半开区间）',
  mapPoint({ x: 800, y: 100 }, { vw: 800, vh: 600 }) === null);
check('x = vw-1 仍在视口内（边界不能多丢一个像素）',
  JSON.stringify(mapPoint({ x: 799, y: 599 }, { vw: 800, vh: 600 })) === '{"x":799,"y":599}',
  JSON.stringify(mapPoint({ x: 799, y: 599 }, { vw: 800, vh: 600 })));
check('负坐标 → null（不夹到 0）', mapPoint({ x: -5, y: 10 }, { vw: 800, vh: 600 }) === null);

for (const bad of [{ vw: 0, vh: 0 }, { vw: NaN, vh: 720 }, { vw: 1280, vh: -1 }, {}, { vw: 'x', vh: 'y' }]) {
  check(`退化视口 ${JSON.stringify(bad)} → null（宁可不发，也不在 (0,0) 乱点）`,
    mapPoint({ x: 10, y: 10 }, bad) === null, String(mapPoint({ x: 10, y: 10 }, bad)));
}

const nonNum = mapPoint({ x: 'a', y: 5 }, { vw: 100, vh: 100 });
check('坐标不是数字 → null', nonNum === null, JSON.stringify(nonNum));

/* 分开「为什么没投」：out_of_view 是正常现象（要计数），no_viewport 是异常（要降级） */
const { mapPointStatus } = await import('../src/sync/replay.js');
check('mapPointStatus 区分 no_viewport（视口读不到）',
  mapPointStatus({ x: 1, y: 1 }, null).reason === 'no_viewport', JSON.stringify(mapPointStatus({ x: 1, y: 1 }, null)));
check('mapPointStatus 区分 out_of_view（越界）',
  mapPointStatus({ x: 900, y: 900 }, { vw: 800, vh: 600 }).reason === 'out_of_view',
  JSON.stringify(mapPointStatus({ x: 900, y: 900 }, { vw: 800, vh: 600 })));
check('mapPointStatus 区分 bad_input（没有坐标）',
  mapPointStatus({ t: 'move' }, { vw: 800, vh: 600 }).reason === 'bad_input',
  JSON.stringify(mapPointStatus({ t: 'move' }, { vw: 800, vh: 600 })));
check('mapPointStatus 正常时给 ok + 整数坐标',
  JSON.stringify(mapPointStatus({ x: 12.4, y: 7.6 }, { vw: 800, vh: 600 })) === '{"ok":true,"x":12,"y":8}',
  JSON.stringify(mapPointStatus({ x: 12.4, y: 7.6 }, { vw: 800, vh: 600 })));

/* ============================ 2. 事件 → CDP 计划 ============================ */
console.log('\n— 2. 事件 → CDP 输入计划 —');
const VP = { vw: 1000, vh: 500 };

const movePlan = buildInputPlan({ t: 'move', x: 100, y: 100 }, VP);
check('move → 一条 mouseMoved，button 为 none',
  movePlan.length === 1 && movePlan[0].method === 'Input.dispatchMouseEvent'
  && movePlan[0].params.type === 'mouseMoved' && movePlan[0].params.button === 'none',
  JSON.stringify(movePlan[0]?.params));
check('move 的坐标是原值（100,100 不缩放）',
  movePlan[0].params.x === 100 && movePlan[0].params.y === 100,
  JSON.stringify({ x: movePlan[0].params.x, y: movePlan[0].params.y }));

const downPlan = buildInputPlan({ t: 'down', x: 500, y: 250, b: 0, btns: 1, m: 0 }, VP);
check('down → 先 mouseMoved 再 mousePressed（顺序不能反）',
  downPlan.length === 2
  && downPlan[0].params.type === 'mouseMoved'
  && downPlan[1].params.type === 'mousePressed',
  downPlan.map((c) => c.params.type).join(' → '));
check('down 的 mousePressed 坐标 = 原值，clickCount=1',
  downPlan[1].params.x === 500 && downPlan[1].params.y === 250 && downPlan[1].params.clickCount === 1,
  JSON.stringify({ x: downPlan[1].params.x, y: downPlan[1].params.y }));

const upPlan = buildInputPlan({ t: 'up', x: 500, y: 250, b: 0, btns: 0, m: 0 }, VP);
check('up → 只发 mouseReleased（不重复发移动）',
  upPlan.length === 1 && upPlan[0].params.type === 'mouseReleased', String(upPlan.length));

const wheelPlan = buildInputPlan({ t: 'wheel', x: 500, y: 250, dx: 0, dy: 120, m: 0 }, VP);
check('wheel → mouseWheel，deltaY 原样不缩放（缩放会让不同窗口滚动距离不同）',
  wheelPlan[0].params.type === 'mouseWheel' && wheelPlan[0].params.deltaY === 120,
  String(wheelPlan[0].params.deltaY));

const keyText = buildKeyPlan({ t: 'key', down: true, k: 'a', c: 'KeyA', kc: 65, m: 0, text: 'a' });
check('可打印字符 keyDown 带 text（一次 keyDown 就真的输入）',
  keyText[0].params.text === 'a' && keyText[0].params.unmodifiedText === 'a',
  JSON.stringify(keyText[0].params.text));
check('keyDown 的 windowsVirtualKeyCode 来自事件', keyText[0].params.windowsVirtualKeyCode === 65,
  String(keyText[0].params.windowsVirtualKeyCode));

const keyCtrl = buildKeyPlan({ t: 'key', down: true, k: 'a', c: 'KeyA', kc: 65, m: MOD.ctrl, text: 'a' });
check('带 Ctrl 的 keyDown 不带 text（否则 Ctrl+A 变成插入 "a"）',
  keyCtrl[0].params.text === undefined, String(keyCtrl[0].params.text));

const keyUp = buildKeyPlan({ t: 'key', down: false, k: 'a', c: 'KeyA', kc: 65, m: 0, text: 'a' });
check('keyUp 从不带 text', keyUp[0].params.type === 'keyUp' && keyUp[0].params.text === undefined,
  String(keyUp[0].params.text));

const textPlan = buildInputPlan({ t: 'text', s: '你好' }, VP);
check('compositionend → 一条 insertText', textPlan.length === 1
  && textPlan[0].method === 'Input.insertText' && textPlan[0].params.text === '你好',
  JSON.stringify(textPlan[0]?.params));
check('空文本不产生 insertText', buildInputPlan({ t: 'text', s: '' }, VP).length === 0);

check('未知事件类型 → 空计划（不发明调用）',
  buildInputPlan({ t: 'touch', x: 500, y: 250 }, VP).length === 0);
check('视口无效时点类事件 → 空计划',
  buildInputPlan({ t: 'down', x: 500, y: 250 }, { vw: 0, vh: 0 }).length === 0);
check('坐标越界时点类事件 → 空计划（越界丢弃）',
  buildInputPlan({ t: 'down', x: 2000, y: 250 }, VP).length === 0);

/* ============================ 3. 四个开关 ============================ */
console.log('\n— 3. 四个开关（两个方向）—');
const ALL_ON = normalizeSettings({});
check('缺省全开：move/down/up/wheel/key/text 全部放行',
  ['move', 'down', 'up', 'wheel', 'key', 'text'].every((t) => enabledBySwitch({ t }, ALL_ON)),
  JSON.stringify(ALL_ON));
check('未知事件类型一律不放行', enabledBySwitch({ t: 'touch' }, ALL_ON) === false);

check('click:false → down 与 up 都丢',
  !enabledBySwitch({ t: 'down' }, { click: false }) && !enabledBySwitch({ t: 'up' }, { click: false }));
check('click:false **不影响** move（开关是独立的，不是一把总开关）',
  enabledBySwitch({ t: 'move' }, { click: false }) === true);
check('input:false → key 与 text 都丢，wheel 照常',
  !enabledBySwitch({ t: 'key' }, { input: false })
  && !enabledBySwitch({ t: 'text' }, { input: false })
  && enabledBySwitch({ t: 'wheel' }, { input: false }) === true);
check('scroll:false → 只丢 wheel',
  !enabledBySwitch({ t: 'wheel' }, { scroll: false })
  && enabledBySwitch({ t: 'down' }, { scroll: false }) === true);
check('move:false → 只丢 move',
  !enabledBySwitch({ t: 'move' }, { move: false })
  && enabledBySwitch({ t: 'key' }, { move: false }) === true);

// 映射表本身不能漏项：漏了某一类就等于那类永远不同步
check('EVENT_SWITCH 覆盖全部 6 类事件',
  ['move', 'down', 'up', 'wheel', 'key', 'text'].every((t) => EVENT_SWITCH[t]),
  Object.keys(EVENT_SWITCH).join(','));

/* ============================ 4. 调度与随机 ============================ */
console.log('\n— 4. 调度与随机 —');
const seqA = Array.from({ length: 5 }, makeRng(42));
const seqB = Array.from({ length: 5 }, makeRng(42));
const seqC = Array.from({ length: 5 }, makeRng(43));
check('同种子同序列（判据可复现）', JSON.stringify(seqA) === JSON.stringify(seqB), seqA.join(','));
check('不同种子不同序列', JSON.stringify(seqA) !== JSON.stringify(seqC), seqC.join(','));

const zeroDelay = new SyncScheduler({ delayMs: 0, jitterMs: 0, now: () => 1000 });
check('delay=0 jitter=0 → dueFor = now', zeroDelay.dueFor(1000) === 1000, String(zeroDelay.dueFor(1000)));
const withJitter = new SyncScheduler({ delayMs: 100, jitterMs: 100, rng: () => 0.5, now: () => 0 });
check('jitter 由 rng 决定（rng=0.5 → +50ms）', withJitter.dueFor(0) === 150, String(withJitter.dueFor(0)));

{
  const release = keepAlive();
  const sched = new SyncScheduler({ delayMs: 0, rng: () => 0, now: () => Date.now() });
  const order = [];
  await Promise.all(Array.from({ length: 20 }, (_, i) => sched.push('a', async () => {
    await new Promise((r) => setTimeout(r, 1));
    order.push(i);
  })));
  check('同一目标严格保序（20 条按入队顺序执行）',
    order.join(',') === Array.from({ length: 20 }, (_, i) => i).join(','), order.slice(0, 6).join(','));

  const sched2 = new SyncScheduler({ delayMs: 0 });
  const finished = [];
  const slow = sched2.push('a', async () => { await new Promise((r) => setTimeout(r, 80)); finished.push('slow'); });
  const fast = sched2.push('b', async () => { finished.push('fast'); });
  await Promise.all([slow, fast]);
  check('跨目标不互相阻塞（b 先于慢的 a 完成）', finished.join(',') === 'fast,slow', finished.join(','));

  const sched3 = new SyncScheduler({ delayMs: 500 });
  let ran = 0;
  const pending = sched3.push('a', async () => { ran += 1; });
  sched3.stop();
  await pending;
  check('stop() 丢弃未发出的任务，且入队 promise 仍然 resolve', ran === 0 && sched3.stats().pending === 0,
    `ran=${ran} pending=${sched3.stats().pending}`);
  // 光看「stop 之后立刻」不够：泄漏的定时器会在稍后才发。等一个完整延迟窗口再核一遍。
  await new Promise((r) => setTimeout(r, 700));
  check('stop() 之后 700ms 内没有任何一条补发（定时器真的被清掉）', ran === 0, `ran=${ran}`);
  check('stop() 后 stats.sent 不增长', sched3.stats().sent === 0, String(sched3.stats().sent));

  const sched4 = new SyncScheduler({ delayMs: 60 });
  const t0 = Date.now();
  await sched4.push('a', async () => {});
  const elapsed = Date.now() - t0;
  check('delay 真的生效（60ms 档实测 ≥50ms）', elapsed >= 50, `${elapsed}ms`);
  check('发完计数 += 1', sched4.stats().sent === 1, String(sched4.stats().sent));
  release();
}

/* ============================ 5. 文本工具（阶段 2 已备） ============================ */
console.log('\n— 5. 文本工具 —');
const TEXT = 'l1\nl2\nl3';
check('pickLine sequential 按 index 取', pickLine(TEXT, { index: 1 }) === 'l2', pickLine(TEXT, { index: 1 }));
check('pickLine sequential 超出取模（index=4 → l2）', pickLine(TEXT, { index: 4 }) === 'l2', pickLine(TEXT, { index: 4 }));
check('pickLine random 用 rng 落行', pickLine(TEXT, { mode: 'random', rng: () => 0.99 }) === 'l3',
  pickLine(TEXT, { mode: 'random', rng: () => 0.99 }));
check('pickLine 空文本 → 空串', pickLine('', { index: 0 }) === '');

check('randomNumber 闭区间：rng=0 → min', randomNumber(100, 200, { rng: () => 0 }) === '100',
  randomNumber(100, 200, { rng: () => 0 }));
check('randomNumber rng=0.999… → max 一侧', randomNumber(100, 200, { rng: () => 0.9999 }) === '200',
  randomNumber(100, 200, { rng: () => 0.9999 }));
check('randomNumber 反序入参也对', randomNumber(200, 100, { rng: () => 0 }) === '100',
  randomNumber(200, 100, { rng: () => 0 }));

const delays = typingDelays('abcd', { minMs: 30, maxMs: 40, rng: () => 0.5 });
check('typingDelays 长度 = 字符数', delays.length === 4, String(delays.length));
check('typingDelays 落在区间内', delays.every((d) => d >= 30 && d <= 40), delays.join(','));

/* ============================ 6. 捕获脚本形状 ============================ */
console.log('\n— 6. 捕获脚本形状（检测面）—');

/* binding 名：形状由实现模块统一给，判据不许自己另写一套正则（那会掩盖「改了实现没改判据」） */
const { BINDING_NAME_RE, newBindingName } = await import('../src/sync/binding.js');
const draws = Array.from({ length: 200 }, () => newBindingName());
check('binding 名形状 _s<8位小写 hex>', draws.every((n) => BINDING_NAME_RE.test(n)),
  draws.slice(0, 3).join(','));
check('binding 名不含固定签名：没有 fp 子串、没有 __ 前缀',
  draws.every((n) => !/fp/i.test(n) && !n.startsWith('__') && !n.includes('S_')),
  draws.slice(0, 3).join(','));
check('两次生成不会撞名（4 字节随机，200 次全不同）', new Set(draws).size === draws.length,
  `${new Set(draws).size}/${draws.length}`);
check('形状正则本身抓得住旧名（__fpS_deadbeef 必须不匹配）', BINDING_NAME_RE.test('__fpS_deadbeef') === false);

const NAME = '_sdeadbeef';
const src = buildCaptureScript({ bindingName: NAME });

check('脚本里出现本次会话的随机 binding 名', src.includes(NAME), NAME);
check('抓引用后 delete 掉名字（实测 delete 后 own names 里没有它）',
  src.includes('delete window[NAME]'), '有 delete window[NAME]');
/* 0.4.7.11：探针用 defineProperty 装（Symbol 键 + 不可枚举），但**不许**拿它去覆盖 binding 名 ——
 * 那会把名字永久留在 own names 里（实测检测面）。所以这条只钉「不对 NAME 用 defineProperty」。 */
check('**不**用 defineProperty 覆盖 binding 名（名字必须 delete 掉）',
  !/defineProperty\s*\(\s*window\s*,\s*NAME/.test(src),
  (src.match(/defineProperty\([^)]{0,40}/g) || []).join(' | ') || 'none');

const forbiddenHits = FORBIDDEN_IN_SCRIPT.filter((f) => src.includes(f));
check('脚本不含任一检测面/逃逸面字面量（含 __fp / fpS）', forbiddenHits.length === 0, forbiddenHits.join(',') || 'none');

/* 上一条用的是手写的干净名字，只能证明模板干净；这一条用**实现生成的名字**再构造一次，
 * 把「生成器退回旧前缀」这条也钉在 A 层（真内核那层另有一条同样的断言）。 */
const genName = newBindingName();
const genSrc = buildCaptureScript({ bindingName: genName });
const genHits = FORBIDDEN_IN_SCRIPT.filter((f) => genSrc.includes(f));
check('用实现生成的 binding 名构造脚本：脚本里也没有 __fp / fpS 字面量',
  genHits.length === 0, `${genName} → ${genHits.join(',') || 'none'}`);

/* 0.4.7.11：脚本会装一个**存活探针**（R5 的 `alive` 要读它）。
 * 第一版用的是每会话随机的 `_s<8hex>` **字符串名**，被 P0 判据当场抓出来：
 * own names 里多一条且整个会话期间都在 —— 比 binding 名（抓完就 delete）还糟。
 * 现在改成 **Symbol 键 + 不可枚举**，所以这里钉的是「没有任何字符串键属性」+「探针是 symbol」。 */
const bareWindowAssign = src.match(/window\.[A-Za-z_$][\w$]*\s*=(?!=)/g) || [];
check('脚本不往 window 上挂固定名属性',
  bareWindowAssign.length === 0, bareWindowAssign.join(',') || 'none');
check('脚本不用字符串键往 window 上赋值（探针不是字符串名）',
  !/window\[[^\]]+\]\s*=(?!=)/.test(src),
  (src.match(/window\[[^\]]+\]\s*=(?!=)/g) || []).join(' | ') || 'none');

const srcWithProbe = buildCaptureScript({ bindingName: NAME, probe: true });
check('装了探针：走 Symbol 键 + 不可枚举（不进 own names / for...in）',
  srcWithProbe.includes('Object.defineProperty(window, Symbol(),')
  && srcWithProbe.includes('enumerable: false'), 'symbol probe');
check('探针带 off()（会话结束能摘干净）', srcWithProbe.includes('off: function'));
check('探针名不会写死在源码里（源码里没有 __fpSyncProbe）',
  !fs.readFileSync(new URL('../src/sync/agent-script.js', import.meta.url), 'utf8').includes('__fpSyncProbe'));
check('没要探针 → PROBE=false（运行时走 if (PROBE) 分支，不挂任何东西）',
  buildCaptureScript({ bindingName: NAME }).includes('var PROBE = false;'));

const listeners = ['mousemove', 'mousedown', 'mouseup', 'wheel', 'keydown', 'keyup', 'compositionend']
  .filter((e) => src.includes(`'${e}'`));
check('七类事件全部监听', listeners.length === 7, listeners.join(','));
/* 0.4.7.11 R3：坐标用**原值**，页面这边不归一化（归一化是上一版的做法，实测行为是 1:1） */
check('坐标取 clientX/clientY 原值（不按 innerWidth/innerHeight 归一）',
  src.includes('e.clientX') && src.includes('e.clientY')
  && !src.includes('window.innerWidth || 1') && !src.includes('/ w;'));
check('脚本里没有 eval / new Function', !src.includes('eval(') && !src.includes('new Function'));

let threw = false;
try { buildCaptureScript({}); } catch { threw = true; }
check('缺 bindingName 直接抛错（不允许无名会话）', threw);

/* ============================ 7. 设置归一 + 会话状态 ============================ */
console.log('\n— 7. 设置归一与会话状态 —');
check('默认设置四个开关全开、延迟 0',
  DEFAULT_SETTINGS.input && DEFAULT_SETTINGS.click && DEFAULT_SETTINGS.scroll && DEFAULT_SETTINGS.move
  && DEFAULT_SETTINGS.delay_ms === 0 && DEFAULT_SETTINGS.jitter_ms === 0,
  JSON.stringify(DEFAULT_SETTINGS));

const off = normalizeSettings({ click: false, input: 'false' });
check('把开关传 false/字符串 "false" 都真的变成 false（恒真实现过不了）',
  off.click === false && off.input === false, JSON.stringify(off));
check('只关一个不会顺带关别的', off.scroll === true && off.move === true, JSON.stringify(off));
check('delay 超过 5000 被夹到 5000', normalizeSettings({ delay_ms: 999999 }).delay_ms === 5000,
  String(normalizeSettings({ delay_ms: 999999 }).delay_ms));
check('delay 负数回落默认 0', normalizeSettings({ delay_ms: -5 }).delay_ms === 0,
  String(normalizeSettings({ delay_ms: -5 }).delay_ms));

const idle = syncStatus();
check('没会话时 syncStatus 形状稳定（running:false + 空窗口）',
  idle.running === false && Array.isArray(idle.windows) && idle.windows.length === 0
  && idle.master_id === null && idle.size_mismatch === false, JSON.stringify(idle));

/* ============================ 8. 路由清单 ============================ */
console.log('\n— 8. 同步路由 —');
const { buildRoutes } = await import('../src/api/routes.js');
const routes = buildRoutes();
const findRoute = (p, method) => routes.find((r) => r.path === p && (r.methods || []).includes(method));
for (const [p, method] of [
  ['/api/v2/sync/start', 'POST'],
  ['/api/v2/sync/stop', 'POST'],
  ['/api/v2/sync/status', 'GET'],
  ['/api/v2/sync/settings', 'POST'],
  ['/api/v2/sync/refresh', 'POST'],
  ['/api/v2/sync/unify-size', 'POST'],
  ['/api/v2/sync/tab', 'POST'],
  ['/api/v2/sync/selftest', 'POST'],
]) {
  check(`路由存在：${method} ${p}`, !!findRoute(p, method), findRoute(p, method) ? 'ok' : 'missing');
}
check('sync 路由的 handler 都是函数',
  routes.filter((r) => String(r.path).startsWith('/api/v2/sync')).every((r) => typeof r.handler === 'function'));
check('sync 路由不进「明确不支持」清单',
  routes.filter((r) => String(r.path).startsWith('/api/v2/sync')).every((r) => !r.unsupported));

/* ============================ 9. 快捷键归一 ============================ */
console.log('\n— 9. 全局快捷键归一与跨进程交接 —');
const { normalizeAccelerator, readHotkeyStatus, requestHotkey, readHotkeyRequest, DEFAULT_ACCELERATOR } =
  await import('../src/sync/hotkey.js');

check('默认快捷键是 CommandOrControl+Alt+S', DEFAULT_ACCELERATOR === 'CommandOrControl+Alt+S', DEFAULT_ACCELERATOR);
check('标准串原样通过', normalizeAccelerator('CommandOrControl+Alt+S') === 'CommandOrControl+Alt+S',
  normalizeAccelerator('CommandOrControl+Alt+S'));
check('Ctrl 统一写成 CommandOrControl（Windows/mac 语义一致）',
  normalizeAccelerator('Ctrl+Alt+K') === 'CommandOrControl+Alt+K', String(normalizeAccelerator('Ctrl+Alt+K')));
check('大小写与空格不敏感（ctrl + shift + f2）',
  normalizeAccelerator('ctrl + shift + f2') === 'CommandOrControl+Shift+F2', String(normalizeAccelerator('ctrl + shift + f2')));
check('单字母自动大写', normalizeAccelerator('Alt+q') === 'Alt+Q', String(normalizeAccelerator('Alt+q')));

// 反向：没有修饰键的必须拒（否则会和页面里打字抢键，等于把输入吞掉）
check('没有修饰键 → 拒（"S" 会和页面输入抢）', normalizeAccelerator('S') === null, String(normalizeAccelerator('S')));
check('修饰键重复 → 拒', normalizeAccelerator('Alt+Alt+S') === null, String(normalizeAccelerator('Alt+Alt+S')));
check('不认识的键 → 拒', normalizeAccelerator('Alt+NoSuchKey') === null, String(normalizeAccelerator('Alt+NoSuchKey')));
check('空串 → 拒', normalizeAccelerator('') === null && normalizeAccelerator(null) === null);
check('修饰键位置写错（S+Alt）→ 拒', normalizeAccelerator('S+Alt') === null, String(normalizeAccelerator('S+Alt')));

const req = requestHotkey('ctrl+alt+j');
check('请求快捷键：规范化后落盘', req.ok === true && req.accelerator === 'CommandOrControl+Alt+J', JSON.stringify(req));
check('请求能被读回（跨进程交接靠这两个文件）', readHotkeyRequest()?.accelerator === 'CommandOrControl+Alt+J',
  JSON.stringify(readHotkeyRequest()));
const badReq = requestHotkey('NoModifierKey');
check('非法请求被拒且不落盘', badReq.ok === false && !!badReq.error, JSON.stringify(badReq));

const st = readHotkeyStatus();
check('没有桌面壳时 status 形状稳定（managed=false、ok=null，不伪装成功也不伪装失败）',
  st.managed === false && st.ok === null && typeof st.accelerator === 'string', JSON.stringify(st));

/* ================= 主窗口「可不可以同步」的口径（0.4.7.4 / 0.4.7.5） =================
 * 纯函数直接断言口径，真内核那条在 test/sync-kernel.test.mjs（错误页 → 明确报错）。
 * 0.4.7.5 新增起始页：用户 4 个环境全停在起始页（代理挂 → 打不开真站），
 * 会话起来了、事件也转发了，但点哪都没效果 —— 那就是「同步没反应」的真相。
 */
console.log('\n— 主窗口可同步性：起始页 / 错误页 / 空白页 —');
check('起始页 → 不能同步，原因点名「起始页」',
  /起始页/.test(String(unusableMasterPage('http://start.freepower.test:53380/start?id=p1&sig=abc') || '')),
  String(unusableMasterPage('http://start.freepower.test:53380/start?id=p1&sig=abc')));
check('起始页（不带端口）也认得',
  /起始页/.test(String(unusableMasterPage('http://start.freepower.test/start?id=p1&sig=abc') || '')));
check('Chrome 错误页 → 不能同步，原因点名「错误页」',
  /错误页/.test(String(unusableMasterPage('chrome-error://chromewebdata/') || '')));
check('注入过的 about:blank → 能同步（新建标签的常态）',
  unusableMasterPage('about:blank', { injected: true }) === null);
check('没注入的 about:blank → 不能同步',
  /空白页/.test(String(unusableMasterPage('about:blank', { injected: false }) || '')));
check('普通网页 → 能同步', unusableMasterPage('https://example.com/a') === null);

/* ============================ 收尾 ============================ */
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail}/${results.length} 通过`);
process.exit(fail ? 1 : 0);
