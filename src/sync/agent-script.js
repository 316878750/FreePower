/**
 * 主窗口的页面侧捕获脚本（字符串，注入到主窗口的每个文档）。
 *
 * 为什么在页面侧抓：CDP 的 `Input` 域**只能发不能收**，没有任何 CDP 方法能订阅「用户在这个页面里
 * 按了什么」。OS 级钩子要 ffi、要拿屏幕坐标反推 DOM 位置、还要处理 DPI 缩放，而且拿到的是坐标
 * 而不是元素 —— 页面侧直接拿到 CSS px 与视口比例，反而更准。
 *
 * 三条硬约束（都是实测出来的，不是设计洁癖）：
 *   1. **binding 不跨文档存活**：`Runtime.addBinding` 只对调用时已存在的 context 生效，
 *      导航到新文档后 `window[name]` 就没了（实测：about:blank 上有、导航后 `typeof` 为 undefined）。
 *      所以脚本必须在 document start 之后**轮询等它出现**，主进程在 `Page.frameNavigated` 补装。
 *   2. **抓引用之后要 `delete`，不是 `defineProperty`**：实测 `delete` 之后
 *      `Object.getOwnPropertyNames(window).includes(name) === false`（名字彻底消失），
 *      而 `defineProperty(..., {value: undefined})` 名字还留在 own names 里 —— 那是个检测面。
 *      抓到的引用在 delete 之后**仍然能推消息**（实测 CDP 收到 1 条）。
 *   3. **不留任何 window 属性**：不挂调试入口、不往 window 上打标记。所有状态都在闭包里。
 *
 * 残留暴露窗口（如实写）：从主进程补装 binding 到脚本 delete 掉它之间，实测约 4 ms
 * （轮询第 1 次就抓到）。这段时间内**页面自己的 document-start 脚本看不到它**
 * （实测页面 inline script 读到 `typeof === 'undefined'`），但同一时刻枚举 own names 的脚本能看到。
 * 这条写进 README 的已知限制。
 */

/** 事件类型 → 是否鼠标类（用于四个开关的分流） */
export const EVENT_KIND = {
  move: 'move',
  down: 'click',
  up: 'click',
  wheel: 'scroll',
  key: 'input',
  text: 'input',
};

/**
 * 生成捕获脚本。
 * @param {object} opt
 * @param {string} opt.bindingName 本次会话随机的 binding 名（`_s<8位 hex>`，见 ./binding.js）
 * @param {number} [opt.moveIntervalMs] mousemove 节流间隔（默认 30ms，太快会把受控窗口压死）
 * @param {number} [opt.flushMs] 批量上送间隔（默认 16ms）
 */
export function buildCaptureScript({ bindingName, moveIntervalMs = 30, flushMs = 16 } = {}) {
  if (!bindingName) throw new Error('bindingName is required');
  // 名字要进模板字符串：用 JSON.stringify 转义，避免名字里的引号破坏脚本
  const NAME = JSON.stringify(String(bindingName));
  return `(() => {
  'use strict';
  var NAME = ${NAME};
  var MOVE_MS = ${Number(moveIntervalMs) || 30};
  var FLUSH_MS = ${Number(flushMs) || 16};

  /* 幂等：**不**在 window 上留任何标记（那本身就是检测面）。
     靠主进程按 executionContextId 记账，保证每个文档只执行一次。 */

  var send = null;
  var queue = [];
  var flushTimer = null;
  var lastMove = 0;

  /* 抓引用 → 立刻 delete（名字彻底消失，引用仍可用） */
  function grab() {
    if (send) return true;
    try {
      var f = window[NAME];
      if (typeof f !== 'function') return false;
      send = f;
      try { delete window[NAME]; } catch (e) {}
      return true;
    } catch (e) { return false; }
  }

  function flush() {
    flushTimer = null;
    if (!queue.length || !send) return;
    var batch = queue;
    queue = [];
    try { send(JSON.stringify({ t: 'batch', e: batch })); } catch (e) { /* 会话已断 */ }
  }

  function push(ev) {
    if (!grab()) return;          // binding 还没装：这一条丢掉（宁可丢，也不挂在 window 上等）
    queue.push(ev);
    if (queue.length >= 32) { if (flushTimer) { clearTimeout(flushTimer); } flush(); return; }
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  function mods(e) {
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  }

  /* 归一化坐标：视口比例。受控窗口按自己的视口还原（见 src/sync/replay.js） */
  function nx(e) {
    var w = window.innerWidth || 1;
    var v = e.clientX / w;
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }
  function ny(e) {
    var h = window.innerHeight || 1;
    var v = e.clientY / h;
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  function onMove(e) {
    var now = Date.now();
    if (now - lastMove < MOVE_MS) return;
    lastMove = now;
    push({ t: 'move', x: nx(e), y: ny(e) });
  }
  function onDown(e) {
    push({ t: 'down', x: nx(e), y: ny(e), b: e.button, btns: e.buttons, m: mods(e) });
  }
  function onUp(e) {
    push({ t: 'up', x: nx(e), y: ny(e), b: e.button, btns: e.buttons, m: mods(e) });
  }
  function onWheel(e) {
    push({ t: 'wheel', x: nx(e), y: ny(e), dx: e.deltaX, dy: e.deltaY, m: mods(e) });
  }
  function onKey(e) {
    // 只转发「按键事实」，字符输入由受控侧按 text 还原（见 replay.js）
    var text = '';
    if (typeof e.key === 'string' && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) text = e.key;
    push({
      t: 'key', down: e.type === 'keydown',
      k: e.key, c: e.code, kc: e.keyCode, m: mods(e), text: text,
      repeat: !!e.repeat,
    });
  }
  function onCompositionEnd(e) {
    // 输入法组合结束：一次性投递最终文本（逐字重放做不到，如实这样处理）
    var d = e.data || '';
    if (d) push({ t: 'text', s: d });
  }
  function onPaste(e) {
    /* 粘贴：把剪贴板里的纯文本投出去。**不 preventDefault** —— 主窗口自己该怎么粘就怎么粘，
       我们只是把「粘了什么」告诉主进程（受控窗口那边由主进程 insertText）。
       剪贴板可能是图片/富文本，只取 text/plain，取不到就这条不发。 */
    try {
      var cd = e.clipboardData || window.clipboardData;
      var s = cd && cd.getData ? cd.getData('text/plain') : '';
      if (s) push({ t: 'paste', s: String(s) });
    } catch (err) { /* 拿不到剪贴板就这条不发，不影响主窗口自己的粘贴 */ }
  }

  var opts = { capture: true, passive: true };
  window.addEventListener('mousemove', onMove, opts);
  window.addEventListener('mousedown', onDown, opts);
  window.addEventListener('mouseup', onUp, opts);
  window.addEventListener('wheel', onWheel, opts);
  window.addEventListener('keydown', onKey, opts);
  window.addEventListener('keyup', onKey, opts);
  window.addEventListener('compositionend', onCompositionEnd, opts);
  window.addEventListener('paste', onPaste, opts);

  /* binding 是新文档里懒安装的：轮询等它（实测 4ms 内出现），最多 2 秒。
     但**先同步抓一次**：当前文档这条路径上 binding 在脚本跑之前就装好了，
     抓完立刻 delete，名字在页面里只存活「同一个任务内」的几微秒。
     为什么不能只靠轮询：后台标签页的定时器会被 Chrome 节流到 1000ms，
     只靠轮询时暴露窗口会从 4ms 变成最多 1 秒（B 层判据实测到过残留）。 */
  grab();
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    if (grab() || tries > 500) clearInterval(timer);
  }, 4);
})();`;
}

/**
 * 给判据用：脚本里不该出现这些（检测面 / 逃逸面）。
 *
 * `__fp` 与 `fpS` 两条是 P0 那一类问题的防回流：binding 名现在也不带这两个形状，
 * 谁再往脚本里塞固定前缀的调试入口/标记，A 层判据会直接红。
 */
export const FORBIDDEN_IN_SCRIPT = [
  '__fp',
  'fpS',
  'eval(',
  'new Function',
  'document.write',
];