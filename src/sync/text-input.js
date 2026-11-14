/**
 * 文本输入：把「主窗口里打的是什么」变成「受控窗口里输什么、怎么输」。
 *
 * 四个开关互相独立（照对手面板的语义，别合并成一个）：
 *   `text_sync`     相同文本输入 —— 主窗口打的字原样同步
 *   `typing`        模拟人工输入 —— 逐字投递、字间随机间隔（不勾时是一条整体 insertText）
 *   `paste`         粘贴同步     —— 主窗口粘贴的内容也同步（自己的开关，不受 text_sync 管）
 *   `random_number` 随机数字输入 —— 每个受控窗口各自抽一个随机数字串，**替换**打出来的字
 *
 * 为什么「相同文本」和「随机数字」必须是两个开关：它们是两种互斥的内容策略，但用户会
 * 两个都开（普通字段照抄，数字字段各自随机）—— 合并成一个就表达不了。
 * 随机数字的意义是：同一批环境填同一个字段时，不能写出一模一样的值。
 *
 * **随机数字按「一次输入」算，不是按每个按键算**：用户打 `1234` 是想要四个窗口各得到
 * 一个四位随机数，不是每个窗口被打进四个随机数。所以这里按**连击（burst）**处理 ——
 * 相邻两次输入间隔 ≤ `burstMs` 算同一次输入：第一次抽一个数，后面的字符吞掉不发，
 * 停手超过 `burstMs` 再打就是新的一次。
 *
 * 粘贴不参与随机数字：粘什么就发什么（把粘贴内容换成一个随机数没有任何意义）。
 *
 * 这一层全是纯函数 + 一个小的状态机，随机源由调用方传（会话种子化 RNG，可复现）：
 * 主窗口页面里不做任何判断，页面脚本只如实上报原始事件（页面侧零逻辑 = 零检测面）。
 */
import { randomNumber, typingDelays } from './scheduler.js';

/** 事件里的文本内容：键盘字符 / 输入法组合结果 / 粘贴。没有就返回空串。 */
export function textOf(ev) {
  if (ev?.t === 'text' || ev?.t === 'paste') return typeof ev?.s === 'string' ? ev.s : '';
  if (ev?.t === 'key' && ev.down && typeof ev?.text === 'string') return ev.text;
  return '';
}

/**
 * 「这段文本本身」在这个设置下会不会发出去（不看随机数字那层）。
 *   - 粘贴：只看 paste 开关（调用方已用 enabledBySwitch 判过，这里不再重复判）
 *   - 打字：看 text_sync
 */
export function baseTextAllowed(source, settings = {}) {
  if (source === 'paste') return true;
  return settings?.text_sync !== false;
}

/**
 * 建一个「文本解析器」：**每个受控窗口一个**。
 *
 * 为什么每个窗口一个：随机数字要每窗口各自抽（同一批环境不能撞值），
 * 连击状态也要各窗口独立（某个窗口卡住不影响别的窗口的节奏）。
 *
 * @param {{burstMs?: number, now?: () => number, rng?: () => number}} opt
 * @returns {(ev: object, settings: object) => {text: string, raw: string, replaced: boolean, source: 'typed'|'paste'|null, swallowed: boolean}}
 */
export function makeTextResolver({ burstMs = 800, now = () => Date.now(), rng = Math.random } = {}) {
  let lastAt = -Infinity;

  return function resolve(ev, settings = {}) {
    const raw = textOf(ev);
    if (!raw) return { text: '', raw: '', replaced: false, source: null, swallowed: false };
    const source = ev?.t === 'paste' ? 'paste' : 'typed';

    /* 粘贴：原样发（不参与随机数字） */
    if (source === 'paste') return { text: raw, raw, replaced: false, source, swallowed: false };

    /* 随机数字：按连击处理，一次输入只抽一个数 */
    if (settings?.random_number) {
      const t = Number(now());
      const newBurst = !(t - lastAt <= burstMs);
      lastAt = t;
      if (!newBurst) return { text: '', raw, replaced: false, source, swallowed: false, burst: false };
      return {
        text: randomNumber(settings.random_min, settings.random_max, { rng }),
        raw,
        replaced: true,
        source,
        swallowed: false,
        burst: true,
      };
    }

    /* 相同文本输入关掉：字符不发（物理按键照发，见 replay.js 的 buildSyncPlan） */
    if (!baseTextAllowed(source, settings)) {
      return { text: '', raw, replaced: false, source, swallowed: true };
    }
    return { text: raw, raw, replaced: false, source, swallowed: false };
  };
}

/**
 * 一段文本 → `Input.insertText` 调用序列（每条前面带 `waitMs`）。
 *   `typing` 关：一条整体投递（快，但页面上是一次性出现）。
 *   `typing` 开：逐字投递，每个字符之前随机间隔（模拟人工输入）。
 * 用 `Array.from` 按码点切，不是按 UTF-16 码元 —— emoji 不能被拆成两个半个字符。
 */
export function textCalls(text, settings = {}, rng = Math.random) {
  const s = String(text ?? '');
  if (!s) return [];
  if (!settings?.typing) return [{ method: 'Input.insertText', params: { text: s }, waitMs: 0 }];
  const chars = Array.from(s);
  const delays = typingDelays(chars.join(''), {
    minMs: settings.typing_min_ms,
    maxMs: settings.typing_max_ms,
    rng,
  });
  return chars.map((ch, i) => ({
    method: 'Input.insertText',
    params: { text: ch },
    waitMs: i === 0 ? 0 : (delays[i] ?? 0),
  }));
}