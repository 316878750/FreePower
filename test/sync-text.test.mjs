/**
 * 窗口同步阶段 2 · 文本输入的 A 层判据（零 Chrome，纯函数）。
 *
 * 判的是**语义**，不是「能跑」：
 *   · `相同文本输入` 与 `随机数字输入` 是两个独立开关，都开时随机数字优先；
 *   · 随机数字按**一次输入**（连击）算，不是每个按键各抽一个；
 *   · 随机数字每窗口各抽一个值（同一批环境不能撞值）；
 *   · 粘贴不受「相同文本输入」管，有自己的开关；
 *   · 「模拟人工输入」= 逐字投递 + 字间随机间隔；关掉就是一条整体 insertText；
 *   · 不带字符的按键（退格/方向键/回车）在「相同文本关掉」时仍然同步 ——
 *     关的是**字符**，不是键盘。
 *
 * 跑法：npm run test:sync-text
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

const { makeTextResolver, textCalls, textOf, baseTextAllowed } = await import('../src/sync/text-input.js');
const { buildSyncPlan, buildInputPlan, enabledBySwitch, EVENT_SWITCH } = await import('../src/sync/replay.js');
const { normalizeSettings, DEFAULT_SETTINGS } = await import('../src/sync/session.js');
const { typingDelays, randomNumber } = await import('../src/sync/scheduler.js');

const KEY = (ch, extra = {}) => ({ t: 'key', down: true, k: ch, c: `Key${ch.toUpperCase()}`, kc: ch.toUpperCase().charCodeAt(0), m: 0, text: ch, ...extra });
const PASTE = (s) => ({ t: 'paste', s });

/* ============================ 1. 设置归一 ============================ */
console.log('\n— 1. 设置归一（四个文本开关互相独立）—');
t('默认：相同文本开、粘贴开、人工输入关、随机数字关', () => {
  assert.equal(DEFAULT_SETTINGS.text_sync, true);
  assert.equal(DEFAULT_SETTINGS.paste, true);
  assert.equal(DEFAULT_SETTINGS.typing, false);
  assert.equal(DEFAULT_SETTINGS.random_number, false);
});
t('只关「相同文本」不会顺带关掉粘贴/人工输入', () => {
  const st = normalizeSettings({ text_sync: false });
  assert.equal(st.text_sync, false);
  assert.equal(st.paste, true);
  assert.equal(st.typing, false);
  assert.equal(st.input, true, '键盘输入开关也不该被连带关掉');
});
t('字符串 "false" 也真的变成 false（恒真实现过不了）', () => {
  const st = normalizeSettings({ text_sync: 'false', paste: 'false', random_number: 'false' });
  assert.equal(st.text_sync, false);
  assert.equal(st.paste, false);
  assert.equal(st.random_number, false);
});
t('打字间隔上下界反了会自动换过来', () => {
  const st = normalizeSettings({ typing_min_ms: 200, typing_max_ms: 50 });
  assert.equal(st.typing_min_ms, 50);
  assert.equal(st.typing_max_ms, 200);
});
t('随机数字范围反了会自动换过来', () => {
  const st = normalizeSettings({ random_min: 9999, random_max: 1000 });
  assert.equal(st.random_min, 1000);
  assert.equal(st.random_max, 9999);
});
t('随机数字上限不受 5000 的限制（原来复用延迟的 num() 会被静默夹到 5000）', () => {
  const st = normalizeSettings({ random_min: 1, random_max: 999999 });
  assert.equal(st.random_max, 999999);
});
t('负数/非数字回落默认值', () => {
  const st = normalizeSettings({ typing_min_ms: 'abc', random_min: -5 });
  assert.equal(st.typing_min_ms, DEFAULT_SETTINGS.typing_min_ms);
  assert.equal(st.random_min, 0);
});

/* ============================ 2. 文本来源 ============================ */
console.log('\n— 2. 文本内容从哪儿来 —');
t('键盘字符 / 输入法结果 / 粘贴都能取到文本', () => {
  assert.equal(textOf(KEY('a')), 'a');
  assert.equal(textOf({ t: 'text', s: '你好' }), '你好');
  assert.equal(textOf(PASTE('abc')), 'abc');
});
t('非文本事件不产生文本（鼠标/滚动）', () => {
  assert.equal(textOf({ t: 'move', x: 0.1, y: 0.2 }), '');
  assert.equal(textOf({ t: 'wheel', dy: 100 }), '');
});
t('keyUp 不重复算字符（否则每个字符会进两遍）', () => {
  assert.equal(textOf({ ...KEY('a'), down: false }), '');
});
t('退格/回车这类没有 text 的按键不产生文本', () => {
  assert.equal(textOf({ t: 'key', down: true, k: 'Backspace', c: 'Backspace', kc: 8, m: 0, text: '' }), '');
});
t('相同文本关掉只拦「打字」，不拦粘贴', () => {
  assert.equal(baseTextAllowed('typed', { text_sync: false }), false);
  assert.equal(baseTextAllowed('paste', { text_sync: false }), true);
});

/* ============================ 3. 随机数字：按一次输入算 ============================ */
console.log('\n— 3. 随机数字输入（连击 = 一次输入）—');
{
  let now = 1000;
  let n = 0;
  const rng = () => { n += 1; return (n * 0.137) % 1; };
  const r = makeTextResolver({ burstMs: 800, now: () => now, rng });
  const st = normalizeSettings({ random_number: true, random_min: 1000, random_max: 9999 });

  const first = r(KEY('1'), st);
  check('第一次按键：替换成一个随机数', first.replaced === true && /^\d{4}$/.test(first.text), JSON.stringify(first));

  now += 120;
  const second = r(KEY('2'), st);
  check('同一次输入里的第二个按键：吞掉，不再抽新数', second.text === '' && second.replaced === false, JSON.stringify(second));

  now += 150;
  const third = r(KEY('3'), st);
  check('同一次输入里的第三个按键：仍然吞掉（不是「每隔一个抽一次」）', third.text === '', JSON.stringify(third));

  now += 2000;
  const nextBurst = r(KEY('4'), st);
  check('停手超过 burstMs 再打：新的一次输入，抽新数',
    nextBurst.replaced === true && /^\d{4}$/.test(nextBurst.text), JSON.stringify(nextBurst));

  const v = Number(first.text);
  check('抽出来的数在 [random_min, random_max] 内', v >= 1000 && v <= 9999, String(v));
}
{
  /* 每窗口一个解析器 → 同一个按键序列，两个窗口拿到不同的数 */
  const st = normalizeSettings({ random_number: true, random_min: 10000, random_max: 99999 });
  let a = 0; let b = 0;
  const ra = makeTextResolver({ now: () => 5000, rng: () => { a += 1; return (a * 0.37) % 1; } });
  const rb = makeTextResolver({ now: () => 5000, rng: () => { b += 1; return (b * 0.61) % 1; } });
  const va = ra(KEY('7'), st).text;
  const vb = rb(KEY('7'), st).text;
  check('两个受控窗口各自抽一个值（同一批环境不会写出相同的值）', va !== vb, `${va} vs ${vb}`);
  check('两个值都在配置范围内', [va, vb].every((x) => Number(x) >= 10000 && Number(x) <= 99999), `${va},${vb}`);
}
{
  const st = normalizeSettings({ random_number: true, paste: true });
  const r = makeTextResolver({ now: () => 1 });
  const p = r(PASTE('hello'), st);
  check('粘贴不参与随机数字（粘什么就发什么）', p.text === 'hello' && p.replaced === false, JSON.stringify(p));
}

/* ============================ 4. 相同文本关掉 ============================ */
console.log('\n— 4. 相同文本输入关掉时到底关了什么 —');
{
  const st = normalizeSettings({ text_sync: false });
  const r = makeTextResolver({ now: () => 1 });
  const k = r(KEY('q'), st);
  check('关掉后打字不产生字符', k.text === '' && k.swallowed === true, JSON.stringify(k));

  const plan = buildSyncPlan(KEY('q'), { vw: 800, vh: 600 }, st, (ev, s) => r(ev, s));
  check('但仍然发 keyDown（不是整条丢掉）', plan.length === 1 && plan[0].params.type === 'keyDown', JSON.stringify(plan));
  check('keyDown 上不带 text（字符不落进去）', plan[0].params.text === undefined, JSON.stringify(plan[0].params));

  const back = buildSyncPlan({ t: 'key', down: true, k: 'Backspace', c: 'Backspace', kc: 8, m: 0, text: '' }, { vw: 800, vh: 600 }, st, makeTextResolver());
  check('退格在「相同文本关掉」时仍然同步（关的是字符，不是键盘）',
    back.length === 1 && back[0].params.key === 'Backspace', JSON.stringify(back));
}
{
  const st = normalizeSettings({ text_sync: false, paste: true });
  const r = makeTextResolver({ now: () => 1 });
  const plan = buildSyncPlan(PASTE('粘贴内容'), { vw: 800, vh: 600 }, st, (ev, s) => r(ev, s));
  check('粘贴仍照发（粘贴不受「相同文本输入」管）',
    plan.length === 1 && plan[0].params.text === '粘贴内容', JSON.stringify(plan));
}
{
  const st = normalizeSettings({ paste: false });
  check('粘贴开关关掉：enabledBySwitch 在进到文本层之前就拦下', enabledBySwitch(PASTE('x'), st) === false);
  check('粘贴开关开着：放行', enabledBySwitch(PASTE('x'), normalizeSettings({ paste: true })) === true);
  check('EVENT_SWITCH 里粘贴归 paste 开关，不归 input', EVENT_SWITCH.paste === 'paste');
}

/* ============================ 5. 逐字投递 ============================ */
console.log('\n— 5. 模拟人工输入 —');
{
  const st = normalizeSettings({ typing: false });
  const calls = textCalls('abc', st);
  check('不勾人工输入：一条整体 insertText', calls.length === 1 && calls[0].params.text === 'abc', JSON.stringify(calls));
  check('整体投递没有等待', calls[0].waitMs === 0);
}
{
  const st = normalizeSettings({ typing: true, typing_min_ms: 30, typing_max_ms: 40 });
  const calls = textCalls('abcd', st, () => 0.5);
  check('勾上人工输入：逐字投递（4 个字符 → 4 条）', calls.length === 4, String(calls.length));
  check('每条只带一个字符', calls.every((c) => Array.from(c.params.text).length === 1), JSON.stringify(calls.map((c) => c.params.text)));
  check('第一条不等，后面每条都等', calls[0].waitMs === 0 && calls.slice(1).every((c) => c.waitMs >= 30 && c.waitMs <= 40),
    JSON.stringify(calls.map((c) => c.waitMs)));
}
t('emoji 按码点切，不会被拆成半个字符', () => {
  const st = normalizeSettings({ typing: true, typing_min_ms: 0, typing_max_ms: 0 });
  const calls = textCalls('a🙂b', st);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.params.text), ['a', '🙂', 'b']);
});
t('typingDelays 的长度是码点数（不是 UTF-16 长度）', () => {
  assert.equal(typingDelays('🙂🙂', { minMs: 1, maxMs: 2 }).length, 2);
});
t('空文本不产生任何调用', () => {
  assert.equal(textCalls('', normalizeSettings({ typing: true })).length, 0);
  assert.equal(textCalls(null).length, 0);
});

/* ============================ 6. 组合：随机数字 + 逐字 ============================ */
console.log('\n— 6. 随机数字与投递方式组合 —');
{
  const st = normalizeSettings({ random_number: true, random_min: 100000, random_max: 999999, typing: true, typing_min_ms: 0, typing_max_ms: 0 });
  const r = makeTextResolver({ now: () => 100, rng: () => 0.5 });
  const plan = buildSyncPlan(KEY('5'), { vw: 800, vh: 600 }, st, (ev, s) => r(ev, s));
  check('随机数字：先一个不带字符的 keyDown', plan[0]?.params?.type === 'keyDown' && plan[0].params.text === undefined,
    JSON.stringify(plan[0]?.params));
  check('随机数字：后面跟着 6 条逐字 insertText（6 位随机数逐字打进去）',
    plan.length === 7 && plan.slice(1).every((c) => c.method === 'Input.insertText'), String(plan.length));
  check('打进去的 6 个字符拼起来是一个 6 位数字',
    /^\d{6}$/.test(plan.slice(1).map((c) => c.params.text).join('')),
    plan.slice(1).map((c) => c.params.text).join(''));
}

/* ============================ 7. 不回归 ============================ */
console.log('\n— 7. 原有行为不回归 —');
{
  const VP = { vw: 1280, vh: 720 };
  const st = normalizeSettings({});
  const r = makeTextResolver();
  const plain = buildSyncPlan(KEY('a'), VP, st, (ev, s) => r(ev, s));
  check('默认设置下打字：keyDown 带 text、不额外 insertText（否则双字符）',
    plain.length === 1 && plain[0].params.text === 'a', JSON.stringify(plain));
  check('鼠标事件仍然走坐标映射', buildInputPlan({ t: 'move', x: 0.5, y: 0.5 }, VP).length === 1);
  check('没有视口的鼠标事件仍然被丢', buildInputPlan({ t: 'move', x: 0.5, y: 0.5 }, null).length === 0);
  check('键盘事件没有视口也照发（文本不需要视口）',
    buildSyncPlan(KEY('a'), null, st, (ev, s) => r(ev, s)).length === 1);
}
t('随机数字范围退化（min=max）时也给得出值', () => {
  assert.equal(randomNumber(7, 7, { rng: () => 0.5 }), '7');
});

/* ============================ 8. 界面不许把开关合并 ============================ */
console.log('\n— 8. 界面（静态扫描，防「顺手合并成一个开关」）—');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const uiSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../web/pages/sync.js'), 'utf8');
  for (const key of ['text_sync', 'typing', 'paste', 'random_number']) {
    check(`同步页有独立的「${key}」开关`, new RegExp(`sw\\('${key}'`).test(uiSrc), key);
  }
  check('同步页把「相同文本输入」和「随机数字输入」分成两个勾选框（不是二选一的下拉）',
    /sw\('text_sync'/.test(uiSrc) && /sw\('random_number'/.test(uiSrc), /text_sync|random_number/);
  check('同步页有打字间隔与随机数字范围的输入框',
    ['typing_min_ms', 'typing_max_ms', 'random_min', 'random_max'].every((k) => uiSrc.includes(`'${k}'`)),
    ['typing_min_ms', 'typing_max_ms', 'random_min', 'random_max'].filter((k) => !uiSrc.includes(`'${k}'`)).join(',') || 'none');
  check('状态区显示被开关拦下与文本吞吐两个读数',
    uiSrc.includes('dropped') && uiSrc.includes('text_sent'), 'dropped/text_sent');
}

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail}/${results.length} 通过`);
process.exit(fail ? 1 : 0);