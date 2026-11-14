/**
 * 调度层：延迟、抖动、逐目标保序。
 *
 * 为什么全在主进程（方案 Q5）：
 *   ① 页面里做延迟 = 把定时器暴露给被检测的站点；
 *   ② N 个受控窗口的节奏要统一调度，页面之间互相看不见；
 *   ③ 随机源要可复现 —— 种子化 RNG 才写得出判据。
 *
 * 受控窗口侧因此**零注入**：它们只收 CDP `Input`，`window` 上一个我们的东西都没有。
 */

/** 确定性 RNG（mulberry32）：同一个种子给同一串数，判据才能复现 */
export function makeRng(seed = 1) {
  let a = Number(seed) >>> 0 || 1;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 每目标一条串行队列：同一目标内**严格保序**（乱序会让「按下」跑到「抬起」后面），
 * 跨目标互不阻塞。
 *
 * 延迟语义：`dueAt = 入队时刻 + delayMs + rand()*jitterMs`，
 * 队列内按 dueAt 单调执行；如果前一条还没发完，后一条顺延（保证顺序优先于精确时刻）。
 */
export class SyncScheduler {
  constructor({ delayMs = 0, jitterMs = 0, rng = Math.random, now = () => Date.now() } = {}) {
    this.delayMs = Math.max(0, Number(delayMs) || 0);
    this.jitterMs = Math.max(0, Number(jitterMs) || 0);
    this.rng = rng;
    this.now = now;
    this.queues = new Map();
    this.timers = new Map();
    this.stopped = false;
    this.sent = 0;
    this.errors = 0;
  }

  /** 算出这条该在什么时候发（抽出来是为了能单测，不用等真时间） */
  dueFor(at = this.now()) {
    return at + this.delayMs + (this.jitterMs ? this.rng() * this.jitterMs : 0);
  }

  /**
   * 入队一条任务。`run` 是 async 函数（真的去发 CDP）。
   * @returns {Promise<void>} 任务跑完/被丢弃时 resolve（调用方一般不等）
   */
  push(key, run) {
    if (this.stopped) return Promise.resolve();
    const dueAt = this.dueFor();
    let q = this.queues.get(key);
    if (!q) { q = []; this.queues.set(key, q); }
    return new Promise((resolve) => {
      q.push({ dueAt, run, resolve });
      this._pump(key);
    });
  }

  _pump(key) {
    if (this.stopped) return;
    if (this.timers.has(key)) return;   // 已经有人在跑这个队列
    const q = this.queues.get(key);
    if (!q || !q.length) return;

    const wait = Math.max(0, q[0].dueAt - this.now());
    const timer = setTimeout(async () => {
      this.timers.delete(key);
      if (this.stopped) return;
      const item = q.shift();
      if (!item) return;
      try {
        await item.run();
        this.sent += 1;
      } catch {
        this.errors += 1;
      } finally {
        item.resolve();
        // 队列里还有就继续（严格按顺序，不并发）
        if (q.length) this._pump(key);
      }
    }, wait);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  /** 停：清所有定时器、丢弃未发的任务（环境停了就不该再往它身上发输入） */
  stop() {
    this.stopped = true;
    for (const [, t] of this.timers) { clearTimeout(t); }
    this.timers.clear();
    for (const [, q] of this.queues) {
      for (const item of q) item.resolve();
      q.length = 0;
    }
    this.queues.clear();
  }

  stats() {
    return { sent: this.sent, errors: this.errors, pending: [...this.queues.values()].reduce((n, q) => n + q.length, 0) };
  }
}

/* ------------------------------ 文本工具（阶段 2 用，先给纯函数） ------------------------------ */

/**
 * 按行取文本。
 * @param {string} text 多行文本
 * @param {{mode?: 'sequential'|'random', rng?: function, index?: number}} opt
 *   sequential：按 index 取（超出取模）；random：随机取一行
 */
export function pickLine(text, { mode = 'sequential', rng = Math.random, index = 0 } = {}) {
  const lines = String(text ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return '';
  if (mode === 'random') return lines[Math.floor(rng() * lines.length) % lines.length];
  return lines[Math.abs(Math.floor(index)) % lines.length];
}

/** 随机数字串（范围闭区间） */
export function randomNumber(min, max, { rng = Math.random } = {}) {
  const lo = Math.ceil(Math.min(Number(min), Number(max)));
  const hi = Math.floor(Math.max(Number(min), Number(max)));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return '';
  return String(lo + Math.floor(rng() * (hi - lo + 1)));
}

/**
 * 逐字打散：模拟人工输入时每个字符之间带随机间隔。
 * @returns {number[]} 每个字符的延迟（ms），长度 = 字符数
 */
export function typingDelays(text, { minMs = 30, maxMs = 120, rng = Math.random } = {}) {
  const s = String(text ?? '');
  const lo = Math.max(0, Math.min(Number(minMs) || 0, Number(maxMs) || 0));
  const hi = Math.max(lo, Math.max(Number(minMs) || 0, Number(maxMs) || 0));
  const out = [];
  for (let i = 0; i < s.length; i++) out.push(lo + Math.floor(rng() * (hi - lo + 1)));
  return out;
}