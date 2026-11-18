/**
 * 窗口排列的**纯计算**部分（不需要 Chrome、不需要显示器）。
 *
 * 参数与对手一一对齐（`26-窗口同步实现细节.md` §5，逐字读过它的 Grid 算法）：
 *   `row`   每行放几个
 *   `hs`    列间距（水平）
 *   `vs`    行间距（垂直）
 *   `top` / `left`  起始偏移（相对目标屏幕的可用区）
 *   `width` / `height`  每个窗口尺寸
 *   `range` 1 = 重叠式（逆序叠在一条线上），0 = 网格
 *   `screenId` -1 = 全部屏幕（按 `screenList` 逐屏填）
 *
 * 对手的公式（化简后，与我这里一致）：
 *   col = i % row;  rowIndex = floor(i / row)
 *   x = left + (width + hs) * col
 *   y = top  + (height + vs) * rowIndex
 *
 * 一条我们自己加进去的硬约束：**原点一律加目标屏幕 workArea 的偏移**。
 * 对手用的是显示器原点（`screenList` 里的 top/left 就是屏幕原点），在 Windows 上
 * 直接拿显示器 bounds 当原点会把窗口压到任务栏底下 —— 所以我们用 Electron 的
 * `display.workArea`（已扣掉任务栏），而不是 `display.bounds`。
 */
import { needsRestoreBeforeResize, normalizeState } from './window.js';

/**
 * 窗口尺寸的下限。**这两个数不是拍脑袋的**，是 2026-11-14 在本机 Chrome 157.0.8103.78 上量出来的
 * （`.tmp/min-width-probe.mjs`）：
 *
 *   请求 200×200 → 得到 516×200
 *   请求 300×300 → 得到 516×300
 *   请求 400×300 → 得到 516×300
 *   请求 500×320 → 得到 516×320
 *   请求 520×400 → 得到 520×400   ← 从这往上不夹
 *
 * 也就是说宽度低于 516 时，`Browser.setWindowBounds` **返回成功但宽度被系统夹到 516**。
 * 把下限设成 516 是为了让「计划」和「现实」一致：否则用户填 300，每个窗口都回读不符，
 * 面板每次都报「有 N 个窗口没能排到位」——那是实话，但根源在我们给了一个做不到的数。
 *
 * **高度 200 不是系统下限**：高度请求 150 实测回读 151，系统真实下限约 151。
 * 200 是**我们自己选的下限**（窗口太扁没意义，也没法看网页）。数字来源要分清：
 * 宽度是系统夹出来的，高度是我们定的。
 */
export const MIN_WINDOW_WIDTH = 516;
export const MIN_WINDOW_HEIGHT = 200;
/** 每行几个的上限：再多也排不进屏幕，只会全部叠在一起 */
export const MAX_PER_ROW = 20;

const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const int = (v, dflt, lo, hi) => {
  const n = Math.round(num(v, dflt));
  return Math.min(Math.max(n, lo), hi);
};

/**
 * 排列参数归一。**不静默改语义**：超范围的夹到边界，并在 `warnings` 里说出来。
 */
export function normalizeArrange(raw = {}) {
  const warnings = [];
  const width0 = int(raw.width, 1000, MIN_WINDOW_WIDTH, 20000);
  const height0 = int(raw.height, 700, MIN_WINDOW_HEIGHT, 20000);
  if (raw.width !== undefined && Number(raw.width) !== width0) warnings.push(`窗口宽度 ${raw.width} 超出范围，按 ${width0} 处理`);
  if (raw.height !== undefined && Number(raw.height) !== height0) warnings.push(`窗口高度 ${raw.height} 超出范围，按 ${height0} 处理`);

  // row = 每行几个。**没给**（-1）和**给了 0** 是两件事：
  //   没给 → 由 planArrange 按窗口数算一个方阵（不给就等于全堆在 0,0，太反直觉）；
  //   给了 0 → 对手的 `row===0` 分支，全部堆到 (0,0)，照它的行为并在 warnings 里说明。
  const row0 = int(raw.row, -1, -1, MAX_PER_ROW);
  if (raw.row !== undefined && Number(raw.row) !== row0) warnings.push(`每行个数 ${raw.row} 超出范围，按 ${row0} 处理`);

  const hs = int(raw.hs, 0, 0, 5000);
  const vs = int(raw.vs, 0, 0, 5000);
  const top = int(raw.top, 0, -20000, 20000);
  const left = int(raw.left, 0, -20000, 20000);
  const range = num(raw.range, 0) === 1 ? 1 : 0;
  /* 显示器编号（0.4.7.5）：**只有 -1 是特殊值**（全部屏幕），其它值当不透明 id 原样保留。
   *
   * 老实现把它夹到 [-1, 999]，但 Windows 的显示器 id 是大整数
   * （本机实测：479047157 = 24G4，2139135862 = CU34G3X）。夹成 999 之后
   * `areaOf(999)` 匹配不到任何屏 → 静默回落到 list[0]（左边那块扩展屏），
   * 于是「把窗口排到 3440 屏」变成了跨两块屏，而 summary 还报「已排列 4 个窗口」。
   * 编号不是我们自己编的序号，是系统给的不透明 id —— 夹值等于改语义。
   * 类型也不硬转数字：UI 传的是字符串，按字符串比对即可（见 planArrange 的 areaOf）。 */
  const rawScreenId = raw.screenId;
  const screenId = rawScreenId === undefined || rawScreenId === null || rawScreenId === ''
    ? null
    : (String(rawScreenId).trim() === '-1' ? -1 : rawScreenId);

  const screenList = Array.isArray(raw.screenList)
    ? raw.screenList
      .filter((s) => s && typeof s === 'object')
      .map((s) => ({
        screen_id: s.screen_id ?? s.screenId ?? null,
        top: int(s.top, 0, -20000, 20000),
        left: int(s.left, 0, -20000, 20000),
        col: int(s.col, 1, 1, MAX_PER_ROW),
        num: int(s.num, 0, 0, 200),
      }))
    : [];

  return {
    width: width0, height: height0, row: row0, hs, vs, top, left, range, screenId, screenList, warnings,
  };
}

/**
 * 单个窗口在网格里的位置（对手公式的直译）。
 * @param {{index:number, row:number, width:number, height:number, hs:number, vs:number, left:number, top:number}} p
 */
export function gridPosition({ index, row, width, height, hs = 0, vs = 0, left = 0, top = 0 }) {
  const i = Math.max(0, Math.floor(Number(index) || 0));
  const r = Math.max(1, Math.floor(Number(row) || 1));
  const col = i % r;
  const rowIndex = Math.floor(i / r);
  return {
    x: left + (width + hs) * col,
    y: top + (height + vs) * rowIndex,
  };
}

/**
 * 重叠平铺的横向步长。**30 是硬编码**（31 号文 §12 实测：n=2 落在 x=0/30，n=3 落在 0/30/60），
 * 界面上没有对应设置项、不可配。
 */
export const OVERLAP_STEP = 30;

/**
 * 重叠平铺（`range=1`）：**横向层叠，窗口被拉到工作区大小**。
 *
 *   第 i 个（i 从 0 起）：x = 工作区.x + 30×i，y = 工作区.y
 *                        宽 = 工作区宽 − 30×(n−1)，高 = 工作区高
 *
 * 实测对照（3440×1392 那块屏）：n=2 → 3410×1392 落在 x=0/30；n=3 → 3380×1392 落在 0/30/60。
 * 同屏同数量下宫格是等分（n=2 各 1720），所以这是**两套完全不同的语义**，不是宫格加个偏移。
 *
 * 注意两点（容易搞混）：
 *   · 它**不跟主控窗口大小**（那是「统一大小」按钮的事），尺寸一律由工作区算；
 *   · 自定义排列里的 宽/高 对它无效 —— 所以界面上选着重叠平铺时要说明这一点。
 */
export function overlapLayout({ index, count, area, left = 0, top = 0 }) {
  const i = Math.max(0, Math.floor(Number(index) || 0));
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const a = area || {};
  const w = Math.max(1, Math.floor(Number(a.width) || 1));
  const h = Math.max(1, Math.floor(Number(a.height) || 1));
  return {
    x: Math.round(Number(a.x) || 0) + left + OVERLAP_STEP * i,
    y: Math.round(Number(a.y) || 0) + top,
    width: Math.max(MIN_WINDOW_WIDTH, w - OVERLAP_STEP * (n - 1)),
    height: Math.max(MIN_WINDOW_HEIGHT, h),
  };
}

/**
 * @deprecated 0.4.7.5 起 `range=1` 用实测出来的 {@link overlapLayout}（正向层叠 + 拉满工作区）。
 * 这条老公式（逆序叠、用 vs 当步长）来自 `26-窗口同步实现细节.md` §5 的静态读码，没有实测过；
 * 2026-11-18 逆向补测推翻了它。保留导出只为兼容旧调用点，**新代码别用**。
 */
export function overlapPosition({ index, count, left = 0, top = 0, vs = 0 }) {
  const i = Math.max(0, Math.floor(Number(index) || 0));
  const c = Math.max(0, Math.floor(Number(count) || 0));
  return { x: left + vs * Math.abs(i - (c - 1)), y: top };
}

/**
 * 一键排列：按可用区自动算「每行几个」与窗口尺寸（对手 `sync90` 一键排列）。
 * `minWidth` 默认就是**系统的宽度下限**（516，实测）：算出一个系统给不了的宽度，
 * 后面每个窗口都会回读不符，等于让一键排列永远报失败。
 */
export function autoFit(count, workArea, { gap = 0, minWidth = MIN_WINDOW_WIDTH, minHeight = MIN_WINDOW_HEIGHT } = {}) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const w = Math.max(1, Math.floor(Number(workArea?.width) || 1));
  const h = Math.max(1, Math.floor(Number(workArea?.height) || 1));
  // 先按「尽量方」定列数，再按能不能放下缩列数
  let cols = Math.ceil(Math.sqrt(n));
  while (cols > 1 && (w - gap * (cols - 1)) / cols < minWidth) cols -= 1;
  cols = Math.min(cols, n);
  let rows = Math.ceil(n / cols);
  let width = Math.max(MIN_WINDOW_WIDTH, Math.floor((w - gap * (cols - 1)) / cols));
  // 下限抬上去之后可能反而放不下：继续减列，直到放得下或者只剩 1 列
  while (cols > 1 && cols * width + gap * (cols - 1) > w) {
    cols -= 1;
    rows = Math.ceil(n / cols);
    width = Math.max(MIN_WINDOW_WIDTH, Math.floor((w - gap * (cols - 1)) / cols));
  }
  let height = Math.max(MIN_WINDOW_HEIGHT, Math.floor((h - gap * (rows - 1)) / rows));
  if (height < minHeight) height = Math.max(MIN_WINDOW_HEIGHT, Math.floor(h / rows));
  return { cols, rows, width, height };
}

/**
 * 出排列计划：每个窗口该摆在哪、多大。
 *
 * @param {{count:number, params:object, screens?:Array}} opt
 *   screens: `[{id, workArea:{x,y,width,height}, primary}]`（来自桌面壳的 `screen.getAllDisplays()`）；
 *            不给就按「单屏、原点 0,0」算 —— 但**会带一条 warning**，不假装知道显示器。
 * @returns {{windows:Array, screen_id:any, warnings:string[]}}
 */
export function planArrange({ count, params = {}, screens = [] } = {}) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const p = normalizeArrange(params);
  const warnings = [...p.warnings];
  const list = Array.isArray(screens) ? screens : [];
  const out = [];

  const areaOf = (screenId, { explicit = false } = {}) => {
    if (!list.length) {
      warnings.push('没有显示器信息（没有桌面壳在跑），按原点 (0,0) 排列 —— 多屏环境下可能排到屏幕外');
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    // 不透明 id：按字符串比对（UI 传的是 `String(d.id)`，服务端拿到的可能是数字）
    const hit = screenId === null || screenId === undefined
      ? null
      : list.find((s) => String(s.id) === String(screenId));
    if (hit) return hit.workArea;
    /* 明确指定了某块屏却找不到：**说出来**，不许静默换成别的屏（0.4.7.5）。
     * 用户 2026-11-18 就是这么被坑的：编号被夹成 999 → 匹配不到 → 排到 list[0]，
     * 结果跨了两块屏，而响应里只写「已排列 4 个窗口」。 */
    if (explicit && screenId !== null && screenId !== undefined) {
      warnings.push(`找不到显示器 ${screenId}，按主屏处理`);
    }
    const fallback = list.find((s) => s.primary) || list[0];
    return fallback?.workArea || { x: 0, y: 0, width: 0, height: 0 };
  };

  /* 全部屏幕：按 screenList 逐屏填满再进下一屏（对手 `screenId === -1` 的分支）。
   * 对手公式直译：`x = left + (d % col) * width`、`y = top + floor(d / col) * height`
   * —— 注意**多屏分支不带间距**（它只用了 n[0]/n[1] 宽高，没有 hs/vs），照它来。 */
  if (p.screenId === -1) {
    /* 重叠平铺在「全部屏幕」下没有意义（一块屏拉满才对，跨屏拉满会横跨两块屏），
     * 而且对手那边这个选项在「全部屏幕」时**根本不出现**。这里不静默改语义，说出来。 */
    if (p.range === 1) warnings.push('重叠平铺不支持「全部屏幕」，按宫格平铺处理');
    const plan = p.screenList.length ? p.screenList : buildScreenList(n, p, list);
    let i = 0;
    for (const s of plan) {
      const area = areaOf(s.screen_id, { explicit: true });
      const originX = area.x + s.left;
      const originY = area.y + s.top;
      for (let k = 0; k < s.num && i < n; k++, i++) {
        out.push({
          index: i,
          screen_id: s.screen_id,
          x: originX + (k % s.col) * p.width,
          y: originY + Math.floor(k / s.col) * p.height,
          width: p.width,
          height: p.height,
        });
      }
    }
    if (i < n) warnings.push(`screenList 只安排了 ${i} 个窗口，还有 ${n - i} 个没排进去`);
    return { windows: out, screen_id: -1, warnings };
  }

  const targetScreen = p.screenId === null ? (list.find((s) => s.primary)?.id ?? list[0]?.id ?? null) : p.screenId;
  const area = areaOf(targetScreen, { explicit: p.screenId !== null });
  const originX = area.x + p.left;
  const originY = area.y + p.top;

  /* 没给「每行几个」：按窗口数取一个方阵（2 个 → 2 个/行；4 个 → 2；5 个 → 3） */
  const row = p.row < 0 ? Math.max(1, Math.ceil(Math.sqrt(n))) : p.row;

  /* 对手 `row===0` 分支：全部堆到 (0,0)（连起始偏移都不加）。照它的行为，
   * 但**不静默** —— 这排出来必然全叠在一起，得说出来。 */
  if (row === 0 && p.range !== 1) {
    warnings.push('每行 0 个：全部窗口堆到起始位置（对手行为），会完全重叠');
    for (let i = 0; i < n; i++) {
      out.push({ index: i, screen_id: targetScreen, x: 0, y: 0, width: p.width, height: p.height });
    }
    return { windows: out, screen_id: targetScreen, warnings };
  }

  /* 重叠平铺（range=1）：横向层叠、窗口拉到工作区大小（实测语义，见 overlapLayout）。
   * 它**不看** width/height/row/hs/vs —— 尺寸一律由工作区算，步长硬编码 30。 */
  if (p.range === 1) {
    const cascade = OVERLAP_STEP * Math.max(0, n - 1);
    if (area.width - cascade < MIN_WINDOW_WIDTH) {
      warnings.push(`重叠平铺：${n} 个窗口按 ${OVERLAP_STEP}px 步长层叠后宽度低于系统下限 ${MIN_WINDOW_WIDTH}，按 ${MIN_WINDOW_WIDTH} 处理，后面的窗口会超出屏幕`);
    }
    for (let i = 0; i < n; i++) {
      const pos = overlapLayout({ index: i, count: n, area, left: p.left, top: p.top });
      out.push({ index: i, screen_id: targetScreen, x: pos.x, y: pos.y, width: pos.width, height: pos.height });
    }
    return { windows: out, screen_id: targetScreen, warnings };
  }

  for (let i = 0; i < n; i++) {
    const pos = gridPosition({ index: i, row: row || Math.max(1, n), width: p.width, height: p.height, hs: p.hs, vs: p.vs, left: originX, top: originY });
    out.push({ index: i, screen_id: targetScreen, x: pos.x, y: pos.y, width: p.width, height: p.height });
  }
  return { windows: out, screen_id: targetScreen, warnings };
}

/**
 * 「全部屏幕」但调用方没给 `screenList` 时，按显示器布局自己分：
 * 按顺序一屏一屏填，每屏放几个 = 剩余窗口数 / 剩余屏数（向上取整），
 * 每行几个 = 这块屏横向放得下几个（至少 1、不超过本屏窗口数）。
 * `left/top` 是**相对该屏可用区的偏移**（我们的约定；对手那边是屏幕绝对原点，
 * 但它的屏幕原点就是它自己算的 bounds，在 Windows 上会把窗口压到任务栏底下，所以不照抄）。
 */
function buildScreenList(n, p, screens) {
  if (!screens.length) return [];
  const out = [];
  let left = n;
  for (let idx = 0; idx < screens.length && left > 0; idx++) {
    const s = screens[idx];
    const remainingScreens = screens.length - idx;
    const num = Math.ceil(left / remainingScreens);
    const area = s.workArea || { width: 0 };
    const fit = area.width > 0 ? Math.max(1, Math.floor(area.width / Math.max(1, p.width))) : 1;
    out.push({
      screen_id: s.id,
      top: 0,
      left: 0,
      col: Math.max(1, Math.min(fit, num)),
      num,
    });
    left -= num;
  }
  return out;
}

/**
 * 计划自检：重叠 / 越界。
 * 这两件事**算得出来**，所以放在 A 层钉；真内核那层只证明「按计划执行确实变成那样」。
 */
export function auditPlan(windows, workArea = null) {
  const list = Array.isArray(windows) ? windows : [];
  const overlaps = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const hit = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      if (hit) overlaps.push([i, j]);
    }
  }
  let outside = [];
  if (workArea && Number(workArea.width) > 0 && Number(workArea.height) > 0) {
    outside = list.filter((w) => w.x < workArea.x || w.y < workArea.y
      || w.x + w.width > workArea.x + workArea.width
      || w.y + w.height > workArea.y + workArea.height).map((w) => w.index);
  }
  return { overlaps, outside, ok: overlaps.length === 0 && outside.length === 0 };
}

/** 比对「计划」和「回读到的真实位置」：改窗口这件事只认回读 */
export function verifyPlacement(expected, actual) {
  const off = [];
  const fields = ['x', 'y', 'width', 'height'];
  for (const f of fields) {
    const e = expected?.[f];
    const a = actual?.[f];
    if (a === null || a === undefined || Math.round(Number(a)) !== Math.round(Number(e))) {
      off.push({ field: f, expected: Math.round(Number(e)), actual: a === null || a === undefined ? null : Math.round(Number(a)) });
    }
  }
  return { ok: off.length === 0, mismatches: off };
}

/**
 * 摆**一个**窗口，并且只用**回读**判定它到底有没有到位。
 *
 * 为什么单独抽出来、为什么把 `setBounds`/`readRect` 做成注入参数：
 * 「命令返回成功但窗口没到位」这种事，用真内核是**造不出来**的（系统要么照做、要么连不上），
 * 所以真内核判据只能证明「正常情况能摆对」，抓不住「相信命令返回值」这种坏实现
 * （踩过：把 `entry.ok` 改成恒 true，B 层 28 条全绿）。
 * 注入假读数才测得了：命令 ok、回读不符 → 必须 ok:false。
 *
 * @param {{windowId:number, want:object, stateBefore?:string,
 *          setBounds:(windowId:number, bounds:object)=>Promise,
 *          readRect:()=>Promise<object>, wait?:(ms:number)=>Promise}} opt
 */
export async function placeOne({
  windowId, want, stateBefore = null, setBounds, readRect, wait = async () => {},
}) {
  const entry = { ok: false, expected: want, actual: null, mismatches: [] };
  try {
    // 非 normal 状态下宽高会被系统静默忽略（实测见 README 阶段 3 第 1 件），先回 normal
    if (needsRestoreBeforeResize(stateBefore)) {
      await setBounds(windowId, { windowState: 'normal' });
      await wait(120);
    }
    await setBounds(windowId, { left: want.x, top: want.y, width: want.width, height: want.height });
    await wait(140);
    const after = await readRect();
    entry.actual = after;
    const v = verifyPlacement(want, after);
    entry.mismatches = v.mismatches;
    const stateOk = normalizeState(after?.state) === 'normal';
    entry.ok = v.ok && stateOk;
    if (!entry.ok) {
      entry.reason = stateOk
        ? v.mismatches.map((m) => `${m.field} 期望 ${m.expected} 实际 ${m.actual}`).join('；')
        : `窗口状态是 ${after?.state}，不是 normal`;
    }
  } catch (e) {
    entry.reason = e?.message || String(e);
  }
  return entry;
}

/** 排列结果汇总（面板文案与判据都读它） */
export function summarizeArrange(results) {
  const list = Array.isArray(results) ? results : [];
  const failed = list.filter((r) => !r.ok);
  return {
    total: list.length,
    ok: failed.length === 0,
    failed: failed.length,
    message: failed.length
      ? `有 ${failed.length} 个窗口没能排到位`
      : `已排列 ${list.length} 个窗口`,
    details: failed.map((r) => ({
      profile_id: r.profile_id,
      role: r.role,
      reason: r.reason || (r.mismatches || []).map((m) => `${m.field} 期望 ${m.expected} 实际 ${m.actual}`).join('；'),
    })),
  };
}
