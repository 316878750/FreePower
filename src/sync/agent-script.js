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
 * @param {boolean} [opt.probe] 是否在页面里装「存活探针」（R5 的 `alive` 读它；默认不装）
 * @param {number} [opt.moveIntervalMs] mousemove 节流间隔（默认 30ms，太快会把受控窗口压死）
 * @param {number} [opt.flushMs] 批量上送间隔（默认 16ms）
 */
export function buildCaptureScript({ bindingName, probe = false, moveIntervalMs = 30, flushMs = 16 } = {}) {
  if (!bindingName) throw new Error('bindingName is required');
  // 名字要进模板字符串：用 JSON.stringify 转义，避免名字里的引号破坏脚本
  const NAME = JSON.stringify(String(bindingName));
  const PROBE = probe === true ? 'true' : 'false';
  return `(() => {
  'use strict';
  var NAME = ${NAME};
  var PROBE = ${PROBE};
  var MOVE_MS = ${Number(moveIntervalMs) || 30};
  var FLUSH_MS = ${Number(flushMs) || 16};

  /* 幂等 + 可重装（R6 看门狗要能「重装捕获」）：
     上一次装过就把它的监听器全摘掉再装新的 —— 不摘就会一个输入转发两次。
     上一版探针在 window 上留了一个**字符串名**，被 P0 判据当场抓出来：
     那是个持久检测面（own names 里一条 _s 开头 8 位 hex）。现在改成 **Symbol 键 + 不可枚举**，
     见脚本末尾的说明。 */
  var prev = null;
  try {
    var syms = Object.getOwnPropertySymbols(window);
    for (var si = 0; si < syms.length; si++) {
      var v; try { v = window[syms[si]]; } catch (e) { continue; }
      if (v && typeof v === 'object' && typeof v.off === 'function' && typeof v.at === 'number') { prev = v; break; }
    }
  } catch (e) {}
  if (prev && typeof prev.off === 'function') { try { prev.off(); } catch (e) {} }

  var send = null;
  var queue = [];
  var flushTimer = null;
  var lastMove = 0;
  var probeRec = null;

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
    if (probeRec) { try { probeRec.at = Date.now(); } catch (e) {} }
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

  /* 坐标：**原值 1:1**，不归一化、不缩放（R3，依据 34 号文 §5.1/§5.2）。
     越界由主进程按受控页 innerWidth/innerHeight 丢弃 —— 页面这边不做 clamp，
     否则「主控视口内、受控视口外」的点会被压到边上点歪。 */
  /* iframe：clientX/Y 是相对**本帧**视口的。同进程（同源）的帧链在这里累加到本 target 的根帧；
     跨进程 iframe（OOPIF）是独立 target，剩余偏移由主进程按 DOM.getFrameOwner 补（见 session.js）。
     缓存 100ms：mousemove 每条都 getBoundingClientRect 会触发布局。 */
  var offAt = 0, offX = 0, offY = 0;
  function frameOffset() {
    var now = Date.now();
    if (now - offAt < 100) return;
    offAt = now; offX = 0; offY = 0;
    try {
      var w = window;
      while (w !== w.parent) {
        var fe = null;
        try { fe = w.frameElement; } catch (e) { fe = null; }
        if (!fe) break;                       // 上一层跨源：到本 target 根帧了
        var r = fe.getBoundingClientRect();
        offX += r.left + (fe.clientLeft || 0);
        offY += r.top + (fe.clientTop || 0);
        w = w.parent;
      }
    } catch (e) { offX = 0; offY = 0; }
  }
  function px(e) { frameOffset(); return e.clientX + offX; }
  function py(e) { frameOffset(); return e.clientY + offY; }

  function onMove(e) {
    var now = Date.now();
    if (now - lastMove < MOVE_MS) return;
    lastMove = now;
    push({ t: 'move', x: px(e), y: py(e), btns: e.buttons, m: mods(e) });
  }
  function onDown(e) {
    push({ t: 'down', x: px(e), y: py(e), b: e.button, btns: e.buttons, m: mods(e) });
  }
  function onUp(e) {
    push({ t: 'up', x: px(e), y: py(e), b: e.button, btns: e.buttons, m: mods(e) });
  }
  function onWheel(e) {
    push({ t: 'wheel', x: px(e), y: py(e), dx: e.deltaX, dy: e.deltaY, m: mods(e) });
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
  var handlers = [
    ['mousemove', onMove], ['mousedown', onDown], ['mouseup', onUp], ['wheel', onWheel],
    ['keydown', onKey], ['keyup', onKey], ['compositionend', onCompositionEnd], ['paste', onPaste]
  ];
  for (var i = 0; i < handlers.length; i++) window.addEventListener(handlers[i][0], handlers[i][1], opts);

  /* 存活探针（R5 的 alive 读它）：证明「捕获脚本真的在这个文档里跑过」。
   *
   * 为什么是 **Symbol 键 + 不可枚举**，而不是一个字符串名：
   *   第一版用的是每会话随机的 _s 开头 8 位 hex 字符串名，结果被 P0 判据当场抓出来 ——
   *   Object.getOwnPropertyNames(window) 里多一条，**而且整个会话期间都在**，
   *   比 binding 名（抓完就 delete）还糟。那是个持久检测面。
   *   Symbol 键不进 own names、不进 for...in、不进 Object.keys、不进 JSON；
   *   主进程靠「枚举 own symbols 找一个 {at, off} 形状的对象」读它，不需要名字。
   *
   * 残留暴露面（如实写）：Object.getOwnPropertySymbols(window) 能看到一个无名 Symbol，
   * 其值带 off()。真实站点几乎不会枚举 window 的 symbol；这比规格里建议的
   * 「固定字符串名」严格更安全（固定名只要一句 if 就能被站点识别）。 */
  if (PROBE) {
    try {
      probeRec = {
        at: Date.now(),
        off: function () {
          for (var j = 0; j < handlers.length; j++) {
            try { window.removeEventListener(handlers[j][0], handlers[j][1], opts); } catch (e) {}
          }
          if (flushTimer) { try { clearTimeout(flushTimer); } catch (e) {} }
        }
      };
      Object.defineProperty(window, Symbol(), {
        value: probeRec, enumerable: false, configurable: true, writable: false
      });
    } catch (e) { probeRec = null; }
  }

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
 * 受控窗口的「当前激活标签」上报脚本（0.4.7.11 第二轮）。
 *
 * 为什么必须事件驱动，而不是主进程轮询 `document.visibilityState`：
 * 实测（`.tmp/e2e/vis2.cjs`，真内核 157.0.8103.78）——
 *
 *   后台页 未开焦点模拟: {"vis":"hidden","focus":false}
 *   后台页 开了焦点模拟: {"vis":"visible","focus":true}   ← 一开就翻成 visible
 *   后台页 关掉焦点模拟: {"vis":"hidden","focus":false}
 *
 * 也就是说 R7 的 `Emulation.setFocusEmulationEnabled(true)` 会把**可见性信号一起覆盖**。
 * 一旦给新开的标签也补开焦点模拟，两张页同时报 visible，轮询就再也分不出哪张在前台，
 * 只能退回列表顺序第一张 —— 用户切到 B2、输入却一直打在 B1（2026-11-21 的现场）。
 *
 * 两条纪律：
 *   1. **只在被激活的那一刻上报**：`visibilitychange` / `focus` 一响就推一条 `{v, f}`；
 *      主进程只认 `v === 'visible'`，所以「谁最后变成可见，谁就是当前激活标签」。
 *   2. **不留 window 属性**：抓引用之后立刻 `delete`，和捕获脚本同一套做法
 *      （抓到的引用 delete 之后仍能推消息，实测过）。脚本第二次跑时 `window[B]` 已经是
 *      undefined，于是直接 return —— 天然幂等，不需要任何标记位。
 *
 * @param {object} opt
 * @param {string} opt.bindingName 本会话随机的 binding 名（与捕获用的**不同**一个）
 */
export function buildActivationScript({ bindingName } = {}) {
  const name = JSON.stringify(String(bindingName || ''));
  return `(function () {
  var B = ${name};
  if (!B) return;
  var tries = 0;
  function grab() {
    var send = null;
    try { send = window[B]; } catch (e) { send = null; }
    if (typeof send !== 'function') return false;
    try { delete window[B]; } catch (e) { /* 删不掉也继续：引用已经拿到 */ }
    function fire() {
      try {
        send(JSON.stringify({ v: document.visibilityState, f: document.hasFocus() }));
      } catch (e) { /* binding 已失效：下一次导航会补装 */ }
    }
    document.addEventListener('visibilitychange', fire, true);
    window.addEventListener('focus', fire, true);
    window.addEventListener('blur', fire, true);
    window.addEventListener('pageshow', fire, true);
    fire();
    return true;
  }
  if (grab()) return;
  var timer = setInterval(function () {
    tries++;
    if (grab() || tries > 100) clearInterval(timer);
  }, 50);
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