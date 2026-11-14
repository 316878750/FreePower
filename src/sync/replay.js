/**
 * 回放层：把主窗口的事件按受控窗口的视口还原成 CDP `Input` 调用。
 *
 * 坐标规则（方案 Q2）：**按视口比例映射**，不按绝对像素。
 *   nx = clientX / innerWidth  →  x = round(nx * 受控视口宽)
 * 这条只在「页面布局不随宽度变」时能命中同一个元素；响应式页面在尺寸不同时布局本来就变了，
 * 比例映射会点偏 —— 这是**已知边界**，产品上用「窗口尺寸不一致」提示 + 一键统一尺寸来兜
 * （见 `sync/session.js` 的 `windows` 读数），不假装能自动对齐。
 */

import { baseTextAllowed, textCalls } from './text-input.js';

/** CDP 修饰键位：Alt=1, Ctrl=2, Meta/Command=4, Shift=8（顺序与协议一致） */
export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

/**
 * 归一化坐标 → 目标视口坐标。
 * `vw` / `vh` 为 0（最小化、或 layoutMetrics 还没读到）时返回 `null`，调用方丢弃这条事件：
 * 宁可漏一次移动，也不要在 (0,0) 乱点。`viewport` 传 `null` 同样返回 `null`
 * （会话还没读到视口就是这样传的 —— 不要让它抛异常，一条事件不该弄崩整个会话）。
 */
export function mapPoint({ x, y }, viewport) {
  const { vw, vh } = viewport || {};
  const w = Number(vw);
  const h = Number(vh);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const nx = clamp01(Number(x));
  const ny = clamp01(Number(y));
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  return {
    x: Math.min(Math.round(nx * w), Math.max(0, Math.round(w) - 1)),
    y: Math.min(Math.round(ny * h), Math.max(0, Math.round(h) - 1)),
  };
}

function clamp01(v) {
  if (!Number.isFinite(v)) return NaN;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * 一条页面事件 → 一串 CDP 调用（按顺序）。
 * 返回 `[{ method, params }]`，由 session 决定怎么派发（延迟/顺序在 scheduler 里）。
 *
 * 关键细节：**点击前必须先发一次 `mouseMoved`** 到同一坐标。很多站点（下拉菜单、
 * hover 才出现的按钮）只认 `mousePressed` 之前的移动序列，直接派发按下会点空。
 */
export function buildInputPlan(ev, viewport) {
  // 键盘/文本事件**没有坐标**：必须先分流，否则会在地图映射那里被判成「无效视口事件」丢掉。
  // （这条是 A 层判据抓出来的真 bug：输入法组合结束的文本原来一条都发不出去。）
  if (ev?.t === 'key') return buildKeyPlan(ev);
  if (ev?.t === 'text') return textCalls(ev.s, { typing: false });
  const p = mapPoint(ev, viewport);
  if (!p) return [];
  switch (ev.t) {
    case 'move':
      return [{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 } }];
    case 'down':
      return [
        { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 } },
        {
          method: 'Input.dispatchMouseEvent',
          params: {
            type: 'mousePressed', x: p.x, y: p.y, button: buttonName(ev.b), buttons: buttonsMask(ev.btns),
            clickCount: 1, modifiers: Number(ev.m) || 0,
          },
        },
      ];
    case 'up':
      return [{
        method: 'Input.dispatchMouseEvent',
        params: {
          type: 'mouseReleased', x: p.x, y: p.y, button: buttonName(ev.b), buttons: buttonsMask(ev.btns),
          clickCount: 1, modifiers: Number(ev.m) || 0,
        },
      }];
    case 'wheel':
      return [{
        method: 'Input.dispatchMouseEvent',
        params: {
          type: 'mouseWheel', x: p.x, y: p.y,
          // 增量**不缩放**：缩放会让「滚一屏」在不同窗口里滚不同距离，反而更难用
          deltaX: Number(ev.dx) || 0, deltaY: Number(ev.dy) || 0, modifiers: Number(ev.m) || 0,
        },
      }];
    default:
      return [];
  }
}

/**
 * 键盘：`keyDown` 带上 `text` 就会真的把字符输进去（Chrome 的 keyboard 也是这么做的），
 * 所以「打字」不需要另发 insertText —— 发两遍会变成双字符。
 *
 * `withText:false` 明确要求**不带字符**（相同文本输入关掉、或字符要被随机数字替换时）：
 * 这时仍发 keyDown/keyUp，只是没有 `text` —— 物理按键（退格、方向键、回车）照常同步，
 * 只是不落字符。
 */
export function buildKeyPlan(ev, { withText = true } = {}) {
  const down = !!ev.down;
  const params = {
    type: down ? 'keyDown' : 'keyUp',
    key: String(ev.k || ''),
    code: String(ev.c || ''),
    windowsVirtualKeyCode: Number(ev.kc) || 0,
    nativeVirtualKeyCode: Number(ev.kc) || 0,
    modifiers: Number(ev.m) || 0,
  };
  // 可打印字符 + 没有 Ctrl/Meta/Alt：带 text，直接落进输入框
  if (withText && down && typeof ev.text === 'string' && ev.text && !(params.modifiers & (MOD.ctrl | MOD.meta | MOD.alt))) {
    params.text = ev.text;
    params.unmodifiedText = ev.text;
  }
  return [{ method: 'Input.dispatchKeyEvent', params }];
}

/**
 * 会话实际用的入口：一条页面事件 → 这个受控窗口要发的 CDP 调用（按顺序，带 `waitMs`）。
 *
 * 与 `buildInputPlan` 的区别：文本内容在这里按开关解析，并且**每个受控窗口各用各的解析器**
 * （随机数字要每窗口各自一个值、连击状态各窗口独立）。`buildInputPlan` 保留「原始语义」给单元判据用。
 *
 * @param {object} ev 页面脚本上报的原始事件
 * @param {{vw:number,vh:number}|null} viewport 受控窗口视口
 * @param {object} settings 会话当前设置（读当前值，不是启动快照）
 * @param {(ev: object, settings: object) => object} resolve 该受控窗口的文本解析器（makeTextResolver）
 * @param {() => number} rng 会话种子化随机源（逐字间隔用）
 */
export function buildSyncPlan(ev, viewport, settings = {}, resolve, rng = Math.random) {
  const t = ev?.t;
  if (t === 'key') {
    const r = resolve ? resolve(ev, settings) : { text: '', replaced: false, swallowed: false };
    /* withText：能带字符就带（Chrome 的 keyboard 也是这么干的，再发 insertText 会变双字符）。
       replaced（随机数字）要先发一个不带字符的 keyDown，再把随机数 insertText 进去。 */
    const withText = !!(r.text && !r.replaced);
    const plan = buildKeyPlan(ev, { withText });
    // keyDown 自己已经把字符打进去了（withText），**不能**再 insertText 一次（会变双字符）；
    // 只有「字符没随按键进」（随机数字替换）时才补一条 insertText。
    if (r.text && !withText) plan.push(...textCalls(r.text, settings, rng));
    return plan;
  }
  if (t === 'text' || t === 'paste') {
    const r = resolve ? resolve(ev, settings) : { text: '', swallowed: false };
    // 被吞掉的（相同文本关掉、或随机数字的连击后续）不产生任何调用，但**不是**「被开关拦下」
    return textCalls(r.text, settings, rng);
  }
  return buildInputPlan(ev, viewport);
}

const BUTTONS = ['left', 'middle', 'right', 'back', 'forward'];
function buttonName(b) {
  const i = Number(b);
  return BUTTONS[i] || 'left';
}

/** `buttons` 位掩码：1=左 2=右 4=中 8=后退 16=前进 */
function buttonsMask(btns) {
  const n = Number(btns);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 事件 → 受哪个开关管。开关互相独立（输入 / 点击 / 滚动 / 移动 / 粘贴），
 * 关掉哪类就丢哪类，其余照常 —— 判据里两个方向都要测，只测一边是假绿。
 *
 * 注意「相同文本输入」「模拟人工输入」「随机数字输入」**不在这张表里**：
 * 它们不是「丢事件」，而是决定文本内容与投递方式（见 text-input.js），
 * 所以还在 input / paste 这两个开关管住之后才生效。
 */
export const EVENT_SWITCH = {
  move: 'move',
  down: 'click',
  up: 'click',
  wheel: 'scroll',
  key: 'input',
  text: 'input',
  paste: 'paste',
};

export function enabledBySwitch(ev, settings = {}) {
  const sw = EVENT_SWITCH[ev?.t];
  if (!sw) return false;
  // 缺省全开：设置里没写这个键 = 用户没关过它
  return settings[sw] !== false;
}