/**
 * 窗口同步阶段 2 · 文本输入的 B 层判据：**真内核、1 主 + 2 受控**。
 *
 * 为什么要两个受控窗口：随机数字的产品承诺是「同一批环境不会写出相同的值」，
 * 只开一个窗口根本证不了这件事。这里三个环境各开一个页面，都 focus 到 `#ta`。
 *
 * 判的是：
 *   ① 相同文本输入：主窗口打字 → 两个受控窗口都拿到同一串字；
 *   ② 粘贴同步：主窗口粘贴 → 两个受控窗口都拿到粘贴的内容；
 *   ③ 粘贴开关关掉：粘贴不同步，但打字照旧同步（两个方向都测，只测一边是假绿）；
 *   ④ 随机数字：主窗口打 `1234` → 每个受控窗口各自一个 4 位随机数，
 *      **两窗口的值不同**、都不是 `1234`、都在配置范围内；
 *   ⑤ 相同文本关掉：字符不落进去，但**退格仍然同步**（关的是字符，不是键盘）；
 *   ⑥ 模拟人工输入：逐字投递 —— 受控窗口收到的是多个 input 事件、且有时间间隔。
 *
 * 跑法：npm run test:sync-text-kernel（起 3 个真环境，约 40–60 秒）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dataDir = path.join(os.tmpdir(), `freepower-synct-${Date.now()}`);
process.env.FREEPOWER_DATA = dataDir;
process.env.FREEPOWER_SELFCHECK = '0';
process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
process.env.FREEPOWER_EGRESS_TIMEOUT = '800';

/* 每个页面都记下自己的 input 事件（逐字投递会留下多条，整体投递只有一条） */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>sync-text</title>
<style>body{margin:0;font:14px/1.4 monospace}#ta{position:absolute;left:20px;top:40px;width:420px;height:80px}</style>
</head><body>
<textarea id="ta"></textarea>
<script>
window.__inputs = [];
document.addEventListener('input', function (e) {
  window.__inputs.push({ v: e.target && e.target.value, at: Math.round(performance.now()) });
}, true);
</script></body></html>`;

const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(PAGE);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const URL_MAIN = `http://127.0.0.1:${PORT}/page`;

const manager = await import('../src/runtime/manager.js');
const profiles = await import('../src/store/profiles.js');
const sync = await import('../src/sync/session.js');

const started = [];

async function evalIn(inst, sessionId, expression) {
  const r = await inst.client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    .catch(() => null);
  if (r?.exceptionDetails) return { error: r.exceptionDetails.text };
  return r?.result?.value;
}

/** 用 CDP 打一个真实按键（带 text，和用户在键盘上打一样） */
async function typeChar(inst, sessionId, ch) {
  const code = `Key${ch.toUpperCase()}`;
  const kc = ch.toUpperCase().charCodeAt(0);
  await inst.client.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: ch, code, text: ch, unmodifiedText: ch,
    windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc,
  }, sessionId);
  await inst.client.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: ch, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc,
  }, sessionId);
}

async function typeText(inst, sessionId, text, gapMs = 90) {
  for (const ch of text) {
    await typeChar(inst, sessionId, ch);
    await sleep(gapMs);
  }
}

async function pressKey(inst, sessionId, key, kc) {
  await inst.client.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc,
  }, sessionId);
  await inst.client.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code: key, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc,
  }, sessionId);
}

/** 三个窗口都把 #ta 清空 + focus（insertText 落到焦点元素上） */
async function resetAll(insts, sessions) {
  for (let i = 0; i < insts.length; i++) {
    await evalIn(insts[i], sessions[i],
      'document.querySelector("#ta").value = ""; window.__inputs = []; document.querySelector("#ta").focus(); "ok"');
  }
  await sleep(120);
}

const valueIn = (inst, sessionId) => evalIn(inst, sessionId, 'document.querySelector("#ta").value');

try {
  /* ------------------------------ 起 3 个环境 ------------------------------ */
  for (const name of ['txt-master', 'txt-slave1', 'txt-slave2']) {
    const p = profiles.createProfile({ name: `${name}-${Date.now()}`, group_id: '0', remark: 'sync 文本 B 层判据' });
    const st = await manager.startProfile(profiles.getProfile(p.profile_id));
    started.push(p.profile_id);
    console.log(`环境 ${name} = ${p.profile_id} · 内核 ${st.real_version}`);
  }
  const insts = started.map((id) => manager.getInstance(id));
  const pages = [];
  for (const inst of insts) pages.push(await inst.openPage(URL_MAIN));
  const sessions = pages.map((p) => p.sessionId);
  // 等内核把启动尺寸应用完再动手（实测它会在启动后自己再应用一次）
  await sleep(2200);

  const st0 = await sync.startSync({
    masterId: started[0], slaveIds: [started[1], started[2]], settings: {}, rngSeed: 20261114,
  });
  check('会话起来了（1 主 + 2 受控）', st0.running === true && st0.windows.length === 3,
    JSON.stringify(st0.windows.map((w) => w.role)));

  /* ------------------------------ ① 相同文本输入 ------------------------------ */
  console.log('\n— ① 相同文本输入 —');
  await resetAll(insts, sessions);
  await typeText(insts[0], sessions[0], 'abc');
  await sleep(700);
  const v1 = [await valueIn(insts[1], sessions[1]), await valueIn(insts[2], sessions[2])];
  const m1 = await valueIn(insts[0], sessions[0]);
  check('主窗口打 abc → 两个受控窗口都是 abc', v1.every((v) => v === 'abc'), `受控=${JSON.stringify(v1)} 主=${m1}`);

  /* ------------------------------ ② 粘贴同步 ------------------------------ */
  console.log('\n— ② 粘贴同步 —');
  await resetAll(insts, sessions);
  await evalIn(insts[0], sessions[0],
    `(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'PASTED-文本');
      document.querySelector('#ta').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return 'sent'; })()`);
  await sleep(700);
  const p1 = [await valueIn(insts[1], sessions[1]), await valueIn(insts[2], sessions[2])];
  check('主窗口粘贴 → 两个受控窗口拿到同一段粘贴内容', p1.every((v) => v === 'PASTED-文本'), JSON.stringify(p1));

  /* ------------------------------ ③ 粘贴开关关掉 ------------------------------ */
  console.log('\n— ③ 粘贴开关关掉（打字不受影响）—');
  sync.updateSettings({ paste: false });
  await resetAll(insts, sessions);
  await evalIn(insts[0], sessions[0],
    `(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'NOPE');
      document.querySelector('#ta').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return 'sent'; })()`);
  await sleep(500);
  const p2 = [await valueIn(insts[1], sessions[1]), await valueIn(insts[2], sessions[2])];
  check('paste:false → 粘贴不同步（受控窗口仍为空）', p2.every((v) => v === ''), JSON.stringify(p2));
  const droppedBefore = sync.syncStatus().dropped;
  check('paste:false 时被开关拦下的条数 > 0（是拦下，不是没捕获）', droppedBefore > 0, String(droppedBefore));

  await resetAll(insts, sessions);
  await typeText(insts[0], sessions[0], 'xy');
  await sleep(600);
  const p3 = [await valueIn(insts[1], sessions[1]), await valueIn(insts[2], sessions[2])];
  check('关掉粘贴不影响打字（两个受控窗口仍是 xy）', p3.every((v) => v === 'xy'), JSON.stringify(p3));
  sync.updateSettings({ paste: true });

  /* ------------------------------ ④ 随机数字：两窗口必须不同 ------------------------------ */
  console.log('\n— ④ 随机数字输入（每窗口一个值）—');
  sync.updateSettings({ random_number: true, random_min: 1000, random_max: 9999 });
  await resetAll(insts, sessions);
  const before4 = sync.syncStatus();
  await typeText(insts[0], sessions[0], '1234');    // 连打 4 个字符 = 一次输入
  await sleep(900);
  const after4 = sync.syncStatus();
  const rnd = [await valueIn(insts[1], sessions[1]), await valueIn(insts[2], sessions[2])];
  const mainVal = await valueIn(insts[0], sessions[0]);
  console.log(`随机数字：受控 ${JSON.stringify(rnd)} · 主窗口 ${mainVal}`);
  check('两个受控窗口都是 4 位数字', rnd.every((v) => /^\d{4}$/.test(String(v))), JSON.stringify(rnd));
  check('两个受控窗口的值**不同**（同一批环境不会写出相同的值）', rnd[0] !== rnd[1], `${rnd[0]} vs ${rnd[1]}`);
  check('都不是主窗口打的那个 1234（确实是替换）', rnd.every((v) => v !== '1234' && v !== '123' && v !== '12344'),
    JSON.stringify(rnd));
  check('两个值都在配置范围内 [1000,9999]',
    rnd.every((v) => Number(v) >= 1000 && Number(v) <= 9999), JSON.stringify(rnd));
  check('主窗口自己仍然是 1234（我们只改受控窗口，不干扰用户正在打的字）', mainVal === '1234', String(mainVal));

  const stRnd = sync.syncStatus();
  check('随机数字那次只算「一次输入」（连击后续被吞掉，不是每键抽一个数）',
    (stRnd.text_sent ?? 0) > 0 && rnd.every((v) => String(v).length === 4), JSON.stringify({ sent: stRnd.text_sent, rnd }));
  /* 精确读数：4 个字符 = 1 条发出（抽数字）+ 3 条吞掉（连击后续）。
   * 这条比「值不同」更狠 —— 它钉的是「不是每键抽一个数」这件事本身。 */
  check('4 个字符的连击：text_sent +1、text_swallowed +3（正好一次输入）',
    (after4.text_sent - before4.text_sent) === 1 && (after4.text_swallowed - before4.text_swallowed) === 3,
    JSON.stringify({ sent: after4.text_sent - before4.text_sent, swallowed: after4.text_swallowed - before4.text_swallowed }));

  /* ------------------------------ ⑤ 相同文本关掉：字符不发，退格照发 ------------------------------ */
  console.log('\n— ⑤ 相同文本输入关掉 —');
  sync.updateSettings({ random_number: false, text_sync: false });
  await resetAll(insts, sessions);
  await evalIn(insts[0], sessions[0], 'document.querySelector("#ta").value = "KEEP"; "ok"');
  await evalIn(insts[1], sessions[1], 'document.querySelector("#ta").value = "KEEP"; "ok"');
  await evalIn(insts[2], sessions[2], 'document.querySelector("#ta").value = "KEEP"; "ok"');
  await typeText(insts[0], sessions[0], 'zz');
  await sleep(600);
  const t2 = [await valueIn(insts[1], sessions[1]), await valueIn(insts[2], sessions[2])];
  const m2 = await valueIn(insts[0], sessions[0]);
  check('text_sync:false → 打进去的字符不到受控窗口（仍是 KEEP）', t2.every((v) => v === 'KEEP'),
    `受控=${JSON.stringify(t2)} 主=${m2}`);
  const swallowed = sync.syncStatus().text_swallowed;
  check('被「文本策略」吞掉的计到了 text_swallowed（与开关拦下的 dropped 分开记）',
    swallowed > 0, String(swallowed));

  await pressKey(insts[0], sessions[0], 'Backspace', 8);
  await sleep(500);
  const t3 = [await valueIn(insts[1], sessions[1]), await valueIn(insts[2], sessions[2])];
  check('退格仍然同步（关的是字符，不是键盘）', t3.every((v) => v === 'KEE'), JSON.stringify(t3));
  sync.updateSettings({ text_sync: true });

  /* ------------------------------ ⑥ 模拟人工输入：逐字投递 ------------------------------ */
  console.log('\n— ⑥ 模拟人工输入（逐字）—');
  sync.updateSettings({ typing: true, typing_min_ms: 70, typing_max_ms: 110 });
  await resetAll(insts, sessions);
  await typeText(insts[0], sessions[0], 'abcd', 120);
  await sleep(1400);
  const v3 = [await valueIn(insts[1], sessions[1]), await valueIn(insts[2], sessions[2])];
  check('逐字投递后最终值仍是 abcd', v3.every((v) => v === 'abcd'), JSON.stringify(v3));

  const events = await evalIn(insts[1], sessions[1], 'JSON.stringify(window.__inputs)');
  let list = [];
  try { list = JSON.parse(String(events)); } catch { list = []; }
  check('受控窗口收到多个 input 事件（逐字），不是一次性一条', list.length >= 4,
    `${list.length} 条：${JSON.stringify(list.slice(0, 6))}`);
  const spread = list.length >= 2 ? list[list.length - 1].at - list[0].at : 0;
  check('事件之间有时间间隔（≥150ms，说明真的在逐字投）', spread >= 150, `${spread}ms`);
  sync.updateSettings({ typing: false });

  /* ------------------------------ 状态读数 ------------------------------ */
  console.log('\n— 状态读数 —');
  const fin = sync.syncStatus();
  check('status 带 text_sent / text_swallowed 两个计数（与被拦下的 dropped 分开）',
    typeof fin.text_sent === 'number' && typeof fin.text_swallowed === 'number', JSON.stringify({ sent: fin.text_sent, swallowed: fin.text_swallowed }));
  check('settings 回读里四个文本开关都在',
    ['text_sync', 'typing', 'paste', 'random_number'].every((k) => typeof fin.settings?.[k] === 'boolean'),
    JSON.stringify(fin.settings));
} catch (e) {
  console.log('异常：', e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : e);
  check('整体跑通（无异常）', false, String(e && e.message));
} finally {
  try { await sync.stopSync(); } catch { /* ignore */ }
  const withTimeout = (p, ms = 8000) => Promise.race([Promise.resolve(p).catch(() => {}), sleep(ms)]);
  for (const id of started) {
    try { await withTimeout(manager.stopProfile(id)); } catch { /* ignore */ }
    try { profiles.deleteProfiles([id]); } catch { /* ignore */ }
  }
  try { srv.closeAllConnections?.(); } catch { /* ignore */ }
  try { srv.close(); } catch { /* ignore */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail}/${results.length} 通过`);
process.exit(fail ? 1 : 0);