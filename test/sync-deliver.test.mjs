/**
 * 第 1–3 步（后台不节流 / iframe 捕获 / Win32 投递）的 A 层判据（零 Chrome、零 Win32）。
 *
 * 钉三件事：
 *   ① 启动参数里**真的**有四个反节流开关（少一个，被遮挡的受控窗口就会「命令成功但页面不动」）；
 *   ② 捕获脚本把同源 iframe 偏移累加到根视口、mousemove 带 buttons（拖拽要用）；
 *   ③ toWinCommand 的分流与字段：文本策略类不走 Win32、扩展键、rawKeysOnly 不带字符；
 *      settings.deliver 归一化（只认 'cdp'，其它一律 win32）。
 *
 * 跑法：node --no-warnings test/sync-deliver.test.mjs
 */
import assert from 'node:assert/strict';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const t = (name, fn) => {
  try { fn(); check(name, true); } catch (e) { check(name, false, e?.message || String(e)); }
};

const { buildArgs } = await import('../src/kernel/chrome.js');
const { buildCaptureScript } = await import('../src/sync/agent-script.js');
const { toWinCommand } = await import('../src/sync/win-input.js');
const { normalizeSettings, DEFAULT_SETTINGS } = await import('../src/sync/settings.js');

/* ============================ 1. 反节流启动参数 ============================ */
console.log('\n— 1. 后台/被遮挡窗口不降级 —');
const argv = (() => {
  const r = buildArgs({ fingerprint_config: {} }, { userDataDir: 'X:/fp-test' });
  return Array.isArray(r) ? r : (r.args || []);
})();
for (const flag of ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling']) {
  t(`启动参数含 ${flag}`, () => assert.ok(argv.includes(flag), argv.join(' ')));
}
t('disable-features 含 IntensiveWakeUpThrottling 且 CalculateNativeWinOcclusion 仍在', () => {
  const df = argv.filter((a) => a.startsWith('--disable-features='));
  assert.equal(df.length, 1, `disable-features 只能有一条（多条后者覆盖前者）：${df.join(' | ')}`);
  const list = df[0].split('=')[1].split(',');
  assert.ok(list.includes('IntensiveWakeUpThrottling'), list.join(','));
  assert.ok(list.includes('CalculateNativeWinOcclusion'), list.join(','));
});

/* ============================ 2. 捕获脚本 ============================ */
console.log('\n— 2. 捕获脚本：iframe 偏移 + 拖拽 —');
const src = buildCaptureScript({ bindingName: '_s0123abcd', probe: true });
t('脚本能被解析（语法）', () => { new Function(src); });   // eslint-disable-line no-new-func
t('同源 iframe：沿 frameElement 累加偏移', () => {
  assert.match(src, /frameElement/);
  assert.match(src, /e\.clientX \+ offX/);
  assert.match(src, /e\.clientY \+ offY/);
});
t('mousemove 带 btns（拖拽时受控侧要按住）', () => assert.match(src, /t: 'move'[^}]*btns: e\.buttons/));

/* 在一个假 window 里真跑一遍：iframe 内 (10,20) + frameElement 在 (100,50) + 边框 2 → 根视口 (112,72) */
t('偏移在假 DOM 里真求值：iframe(100,50)+border2 内的 (10,20) → (112,72)', () => {
  const sent = [];
  const handlers = {};
  const parent = {};
  parent.parent = parent;
  const fe = { getBoundingClientRect: () => ({ left: 100, top: 50 }), clientLeft: 2, clientTop: 2 };
  const win = {
    parent, frameElement: fe,
    _s0123abcd: (s) => sent.push(JSON.parse(s)),
    addEventListener: (type, fn) => { handlers[type] = fn; },
    removeEventListener() {},
  };
  const run = new Function('window', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', src); // eslint-disable-line no-new-func
  const timers = [];
  run(win, (fn) => { timers.push(fn); return timers.length; }, () => {}, () => 0, () => {});
  handlers.mousedown({ clientX: 10, clientY: 20, button: 0, buttons: 1 });
  for (const fn of timers.splice(0)) fn();
  const ev = sent.flatMap((b) => b.e).find((e) => e.t === 'down');
  assert.ok(ev, `没收到 down：${JSON.stringify(sent)}`);
  assert.equal(ev.x, 112); assert.equal(ev.y, 72);
});

/* ============================ 3. Win32 指令 ============================ */
console.log('\n— 3. toWinCommand —');
const H = 4242;
t('move/down/up/wheel 都能转成指令，坐标原值', () => {
  assert.deepEqual(toWinCommand({ t: 'move', x: 5, y: 6, btns: 1 }, H), { op: 'mouse', hwnd: H, t: 'move', x: 5, y: 6, btns: 1, m: 0 });
  const d = toWinCommand({ t: 'down', x: 1, y: 2, b: 2, btns: 2, m: 8 }, H);
  assert.equal(d.op, 'mouse'); assert.equal(d.t, 'down'); assert.equal(d.b, 2); assert.equal(d.m, 8);
  const w = toWinCommand({ t: 'wheel', x: 3, y: 4, dy: 100 }, H);
  assert.equal(w.op, 'wheel'); assert.equal(w.dy, 100); assert.equal(w.dx, 0);
});
t('text / paste 不走 Win32（文本策略在 CDP 那边）', () => {
  assert.equal(toWinCommand({ t: 'text', s: '你好' }, H), null);
  assert.equal(toWinCommand({ t: 'paste', s: 'x' }, H), null);
});
t('没有句柄 → null（调用方退回 CDP）', () => assert.equal(toWinCommand({ t: 'move', x: 1, y: 1 }, 0), null));
t('按键：不带字符的键走 Win32，kc / down 原样', () => {
  const k = toWinCommand({ t: 'key', down: true, k: 'Backspace', c: 'Backspace', kc: 8, text: '' }, H);
  assert.equal(k.op, 'key'); assert.equal(k.kc, 8); assert.equal(k.down, true); assert.equal(k.ext, false);
});
t('带字符的键一律交回 CDP（PostMessage 实测 "aabb" / "AB" 都不对）', () => {
  for (const [text, m] of [['a', 0], ['B', 8], ['!', 8], ['中', 0]]) {
    assert.equal(toWinCommand({ t: 'key', down: true, kc: 65, text, m }, H), null, text);
    assert.equal(toWinCommand({ t: 'key', down: true, kc: 65, text, m }, H, { rawKeysOnly: true }), null, text);
  }
});
t('rawKeysOnly 下不带字符的键（退格/方向键）仍走 Win32', () => {
  assert.equal(toWinCommand({ t: 'key', down: true, kc: 8, c: 'Backspace', text: '' }, H, { rawKeysOnly: true }).op, 'key');
});
t('方向键 / Delete / 右 Ctrl 是扩展键，字母不是', () => {
  for (const c of ['ArrowLeft', 'Delete', 'ControlRight', 'NumpadEnter']) assert.equal(toWinCommand({ t: 'key', c, kc: 1 }, H).ext, true, c);
  assert.equal(toWinCommand({ t: 'key', c: 'KeyA', kc: 65 }, H).ext, false);
});

/* ============================ 4. 设置 ============================ */
console.log('\n— 4. settings.deliver —');
t('默认 cdp（0.4.7.14：指纹固定页面尺寸 ≠ 真实窗口时 Win32 坐标全越界）', () => { assert.equal(DEFAULT_SETTINGS.deliver, 'cdp'); assert.equal(normalizeSettings({}).deliver, 'cdp'); });
t('只有 "win32" 能开 Win32 投递，其它值一律 cdp（不许出现第三种行为）', () => {
  assert.equal(normalizeSettings({ deliver: 'win32' }).deliver, 'win32');
  for (const v of ['WIN32', 'x', 1, null, true, 'cdp']) assert.equal(normalizeSettings({ deliver: v }).deliver, 'cdp', String(v));
});

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail}/${results.length} 通过`);
process.exit(fail ? 1 : 0);
