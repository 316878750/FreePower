/**
 * 窗口排列的 A 层判据（零 Chrome）：纯函数 + 显示器交接 + 路由/界面静态扫描。
 *
 * 这一层钉四件事：
 *   ① 坐标**算得对**（对手 `26-窗口同步实现细节.md` §5 的 Grid / range=1 / 多屏三段公式，逐条对照）；
 *   ② 原点用**可用区 workArea**，不是整块屏 bounds —— 用 bounds 会把窗口压到任务栏底下；
 *   ③ 成功只由**回读比对**决定（`placeOne` 里注入假读数测：命令返回成功但窗口没到位 → 必须 ok:false）；
 *   ④ 显示器交接（桌面壳写文件 → 服务进程读）只暴露 workArea。
 *
 * 真正把窗口改掉那层在 `sync-arrange-kernel.test.mjs`（真内核）。
 * 跑法：npm run test:sync-arrange
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const t = (name, fn) => {
  try { fn(); check(name, true); } catch (e) { check(name, false, e?.message || String(e)); }
};

/* 显示器交接要写文件：先把数据目录指到临时目录，别污染真实 data/ */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-arrange-'));
process.env.FREEPOWER_DATA = TMP;

const {
  MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT, MAX_PER_ROW, normalizeArrange, gridPosition, overlapLayout,
  autoFit, planArrange, auditPlan, verifyPlacement, summarizeArrange, placeOne,
} = await import('../src/sync/arrange.js');
const { writeDisplays, readDisplays, screensForArrange } = await import('../src/sync/displays.js');

/* 一块「有任务栏」的主屏：bounds 从 y=0 开始，workArea 从 y=40 开始 —— 排列只许用 workArea */
const PRIMARY = {
  id: 1, label: '主屏', primary: true, scaleFactor: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 40, width: 1920, height: 1040 },
};
const SECOND = {
  id: 2, label: '扩展屏', primary: false, scaleFactor: 1,
  bounds: { x: 1920, y: 0, width: 1080, height: 1920 },
  workArea: { x: 1920, y: 0, width: 1080, height: 1920 },
};
const SCREENS = [
  { id: 1, primary: true, workArea: { ...PRIMARY.workArea } },
  { id: 2, primary: false, workArea: { ...SECOND.workArea } },
];

/* ============================ 1. 参数归一 ============================ */
console.log('\n— 1. 参数归一：超范围要夹住并说出来 —');
t('默认值：1000×700，间距 0，网格，主屏', () => {
  const p = normalizeArrange({});
  assert.equal(p.width, 1000);
  assert.equal(p.height, 700);
  assert.equal(p.hs, 0);
  assert.equal(p.vs, 0);
  assert.equal(p.range, 0);
  assert.equal(p.screenId, null);
  assert.equal(p.row, -1);          // -1 = 没给（由 planArrange 按窗口数算）
  assert.deepEqual(p.warnings, []);
});
t('窗口尺寸下限：宽 516（系统夹出来的）/ 高 200（我们自己选的，系统能给到 151）', () => {
  assert.equal(MIN_WINDOW_WIDTH, 516, 'Chrome 157.0.8103.78 实测：请求 500 得 516、请求 520 得 520');
  assert.equal(MIN_WINDOW_HEIGHT, 200);
});
t('窗口尺寸低于下限 → 夹到下限并 warn', () => {
  const p = normalizeArrange({ width: 100, height: 50 });
  assert.equal(p.width, MIN_WINDOW_WIDTH);
  assert.equal(p.height, MIN_WINDOW_HEIGHT);
  assert.equal(p.warnings.length, 2);
  assert.match(p.warnings[0], /窗口宽度 100 超出范围，按 516 处理/);
});
t('每行个数超上限 → 夹到上限并 warn', () => {
  const p = normalizeArrange({ row: 99 });
  assert.equal(p.row, MAX_PER_ROW);
  assert.match(p.warnings.join(''), /每行个数 99 超出范围/);
});
t('row=0 是「显式给了 0」，不是「没给」', () => {
  assert.equal(normalizeArrange({ row: 0 }).row, 0);
  assert.equal(normalizeArrange({}).row, -1);
});
t('range 只认 1，其它一律 0（含字符串 "1"）', () => {
  assert.equal(normalizeArrange({ range: 1 }).range, 1);
  assert.equal(normalizeArrange({ range: '1' }).range, 1);
  assert.equal(normalizeArrange({ range: 2 }).range, 0);
  assert.equal(normalizeArrange({ range: 'overlap' }).range, 0);
});
/* 0.4.7.5 改口径：显示器编号是**系统给的不透明 id**（Windows 上是大整数，本机实测
 * 479047157 / 2139135862），只有字面量 -1 才是「全部屏幕」。老实现把它夹到 [-1,999]：
 * 夹值 → 匹配不到 → 静默回落到 list[0]（左边那块扩展屏），用户点「排到 3440 屏」却跨了两块屏，
 * 而 summary 还报成功。所以这条断言从「越界要变成 -1」改成「原样保留、由 planArrange 明确报错」。 */
t('显示器编号原样保留（只有字面 -1 是「全部屏幕」）', () => {
  assert.equal(normalizeArrange({ screenId: -5 }).screenId, -5);
  assert.equal(normalizeArrange({ screenId: -1 }).screenId, -1);
  assert.equal(normalizeArrange({ screenId: '2139135862' }).screenId, '2139135862');
  assert.equal(normalizeArrange({ screenId: 2139135862 }).screenId, 2139135862);
  assert.equal(normalizeArrange({ screenId: null }).screenId, null);
  assert.equal(normalizeArrange({}).screenId, null);
  assert.equal(normalizeArrange({ screenId: 479047157 }).warnings.length, 0);
});
t('找不到的编号不许静默换屏：明确 warn「找不到显示器 X，按主屏处理」', () => {
  const plan = planArrange({ count: 2, screens: SCREENS, params: { width: 800, height: 600, screenId: -5 } });
  assert.match(plan.warnings.join(''), /找不到显示器 -5，按主屏处理/);
  assert.doesNotMatch(plan.warnings.join(''), /超出范围/);
});

/* ============================ 2. Grid 公式（对手 §5 直译） ============================ */
console.log('\n— 2. Grid：x = left + (width+hs)*col，y = top + (height+vs)*rowIndex —');
t('每行 2 个：第 1、2 个在第一行，第 3 个换行', () => {
  const base = { row: 2, width: 800, height: 600, hs: 10, vs: 20, left: 5, top: 7 };
  assert.deepEqual(gridPosition({ index: 0, ...base }), { x: 5, y: 7 });
  assert.deepEqual(gridPosition({ index: 1, ...base }), { x: 815, y: 7 });
  assert.deepEqual(gridPosition({ index: 2, ...base }), { x: 5, y: 627 });   // 换行
  assert.deepEqual(gridPosition({ index: 3, ...base }), { x: 815, y: 627 });
});
t('间距真的等于设定值：相邻两窗右边到左边 = hs', () => {
  const a = gridPosition({ index: 0, row: 2, width: 800, height: 600, hs: 37, vs: 0, left: 0, top: 0 });
  const b = gridPosition({ index: 1, row: 2, width: 800, height: 600, hs: 37, vs: 0, left: 0, top: 0 });
  assert.equal(b.x - (a.x + 800), 37);
});
t('每行 1 个：全部竖着排', () => {
  assert.deepEqual(gridPosition({ index: 2, row: 1, width: 800, height: 600, hs: 10, vs: 20, left: 0, top: 0 }), { x: 0, y: 1240 });
});
/* 0.4.7.5 改口径：`range=1` 的重叠式**实测出来了**（31 号文 §12），老公式
 * （逆序叠、用 vs 当步长）来自静态读码、没有实测过，已被推翻。现在的语义：
 *   第 i 个 x = 工作区.x + 30×i，y = 工作区.y，宽 = 工作区宽 − 30×(n−1)，高 = 工作区高。
 * 步长 30 是硬编码（界面没有对应设置项），窗口被拉到工作区大小、**不跟主控窗口**。 */
t('重叠平铺：n=2 → 宽 = 工作区宽−30，落在 x=0/30', () => {
  const area = { x: 0, y: 0, width: 3440, height: 1392 };
  const a = overlapLayout({ index: 0, count: 2, area });
  const b = overlapLayout({ index: 1, count: 2, area });
  assert.deepEqual(a, { x: 0, y: 0, width: 3410, height: 1392 });
  assert.deepEqual(b, { x: 30, y: 0, width: 3410, height: 1392 });
});
t('重叠平铺：n=3 → 宽 = 工作区宽−60，落在 x=0/30/60', () => {
  const area = { x: 0, y: 0, width: 3440, height: 1392 };
  const xs = [0, 1, 2].map((i) => overlapLayout({ index: i, count: 3, area }));
  assert.deepEqual(xs.map((w) => w.x), [0, 30, 60]);
  assert.deepEqual(xs.map((w) => w.width), [3380, 3380, 3380]);
  assert.deepEqual(xs.map((w) => w.height), [1392, 1392, 1392]);
});
t('重叠平铺：原点跟着工作区走（扩展屏 x=-1080 时也在那块屏上）', () => {
  const area = { x: -1080, y: 0, width: 1080, height: 1920 };
  const w = overlapLayout({ index: 1, count: 2, area });
  assert.equal(w.x, -1050);
  assert.equal(w.width, 1050);
});
t('重叠平铺：数量太多时宽度夹到系统下限并 warn（不静默排到屏外）', () => {
  const area = { x: 0, y: 0, width: 3440, height: 1392 };
  const plan = planArrange({
    count: 120, screens: [{ id: 'a', primary: true, workArea: area }],
    params: { screenId: 'a', range: 1 },
  });
  assert.match(plan.warnings.join(''), /低于系统下限/);
  assert.ok(plan.windows.every((w) => w.width >= MIN_WINDOW_WIDTH));
});
t('重叠平铺 vs 宫格：同屏同数量是**两套语义**（n=2：3410 对 1720）', () => {
  const area = { x: 0, y: 0, width: 3440, height: 1392 };
  const screens = [{ id: 'a', primary: true, workArea: area }];
  const over = planArrange({ count: 2, screens, params: { screenId: 'a', range: 1 } });
  const grid = planArrange({ count: 2, screens, params: { screenId: 'a', auto: true } });
  assert.deepEqual(over.windows.map((w) => [w.x, w.width]), [[0, 3410], [30, 3410]]);
  assert.ok(grid.windows.every((w) => w.width < 3410), JSON.stringify(grid.windows));
  assert.equal(grid.windows[0].x, 0);
  assert.notEqual(grid.windows[1].x, 30);
});
t('重叠平铺 + 「全部屏幕」：不静默改语义，明确 warn 按宫格处理', () => {
  const plan = planArrange({ count: 2, screens: SCREENS, params: { screenId: -1, range: 1 } });
  assert.equal(plan.screen_id, -1);
  assert.match(plan.warnings.join(''), /重叠平铺不支持「全部屏幕」/);
});

/* ============================ 3. 出计划 ============================ */
console.log('\n— 3. 出计划：用 workArea 当原点，不用 bounds —');
t('2 个窗口：不重叠、都在主屏 workArea 内、间距等于设定值', () => {
  const plan = planArrange({
    count: 2, screens: SCREENS,
    params: { width: 800, height: 600, row: 2, hs: 40, vs: 50 },
  });
  const audit = auditPlan(plan.windows, PRIMARY.workArea);
  assert.equal(audit.overlaps.length, 0, '不许重叠');
  assert.equal(audit.outside.length, 0, '不许出可用区');
  assert.equal(plan.windows[1].x - (plan.windows[0].x + 800), 40, '水平间距 = hs');
});
t('原点加的是 workArea 偏移（y=40 任务栏），不是 bounds 的 y=0', () => {
  const plan = planArrange({ count: 1, screens: SCREENS, params: { width: 800, height: 600, row: 1 } });
  assert.equal(plan.windows[0].y, 40);        // bounds 会是 0
  assert.equal(plan.windows[0].x, 0);
});
t('起始位置是相对可用区的偏移（left/top 叠加在 workArea 上）', () => {
  const plan = planArrange({ count: 1, screens: SCREENS, params: { width: 800, height: 600, row: 1, left: 30, top: 20 } });
  assert.equal(plan.windows[0].x, 30);
  assert.equal(plan.windows[0].y, 60);
});
t('指定扩展屏 → 原点落在扩展屏的可用区', () => {
  const plan = planArrange({ count: 2, screens: SCREENS, params: { width: 800, height: 600, row: 2, screenId: 2 } });
  assert.equal(plan.screen_id, 2);
  assert.equal(plan.windows[0].x, 1920);
  assert.equal(plan.windows[1].x, 2720);
});
t('每行 2 个、3 个窗口 → 第 3 个换行（y 加一个窗口高）', () => {
  const plan = planArrange({ count: 3, screens: SCREENS, params: { width: 800, height: 600, row: 2, hs: 10, vs: 20 } });
  assert.deepEqual(plan.windows.map((w) => [w.x, w.y]), [[0, 40], [810, 40], [0, 660]]);
});
t('没给「每行几个」→ 按窗口数取方阵（4 个 → 2×2）', () => {
  const plan = planArrange({ count: 4, screens: SCREENS, params: { width: 600, height: 300 } });
  assert.deepEqual(plan.windows.map((w) => [w.x, w.y]), [[0, 40], [600, 40], [0, 340], [600, 340]]);
  assert.equal(auditPlan(plan.windows, PRIMARY.workArea).overlaps.length, 0);
});
t('row=0（显式）→ 全部堆到 (0,0)，并且**说出来**（不静默）', () => {
  const plan = planArrange({ count: 2, screens: SCREENS, params: { width: 800, height: 600, row: 0, left: 50, top: 60 } });
  assert.deepEqual(plan.windows.map((w) => [w.x, w.y]), [[0, 0], [0, 0]]);
  assert.match(plan.warnings.join(''), /会完全重叠/);
});
t('range=1 → 横向层叠 30px、尺寸拉满工作区（实测语义，不是老公式的 vs 间距）', () => {
  const plan = planArrange({ count: 3, screens: SCREENS, params: { width: 800, height: 600, range: 1, vs: 12, left: 10, top: 50 } });
  const area = PRIMARY.workArea;
  assert.deepEqual(plan.windows.map((w) => w.x), [area.x + 10, area.x + 40, area.x + 70]);
  assert.deepEqual(plan.windows.map((w) => w.y), [area.y + 50, area.y + 50, area.y + 50]);
  assert.deepEqual(plan.windows.map((w) => w.width), [area.width - 60, area.width - 60, area.width - 60]);
  assert.deepEqual(plan.windows.map((w) => w.height), [area.height, area.height, area.height]);
  // 自定义里的宽/高/间距对它无效 —— 这是「两套语义」的关键，钉住
  assert.notEqual(plan.windows[0].width, 800);
});
t('没有显示器信息 → 按 (0,0) 算并带 warning（不假装知道多屏布局）', () => {
  const plan = planArrange({ count: 1, screens: [], params: { width: 800, height: 600, row: 1 } });
  assert.equal(plan.windows[0].x, 0);
  assert.equal(plan.windows[0].y, 0);
  assert.match(plan.warnings.join(''), /没有显示器信息/);
});

/* ============================ 4. 多屏（screenId = -1） ============================ */
console.log('\n— 4. 全部屏幕：按显示器顺序填满一屏再进下一屏 —');
t('3 个窗口 2 块屏：第一屏 2 个、第二屏 1 个', () => {
  const plan = planArrange({ count: 3, screens: SCREENS, params: { width: 800, height: 600, screenId: -1 } });
  assert.equal(plan.screen_id, -1);
  assert.deepEqual(plan.windows.map((w) => [w.screen_id, w.x, w.y]), [[1, 0, 40], [1, 800, 40], [2, 1920, 0]]);
});
t('多屏分支不带间距（对手那段只用了宽高，没有 hs/vs）', () => {
  // 3 个窗口 2 块屏 → 第一屏放 2 个，它们的横向差就该是 width（不带 hs）
  const plan = planArrange({ count: 3, screens: SCREENS, params: { width: 800, height: 600, screenId: -1, hs: 99, vs: 99 } });
  assert.equal(plan.windows[1].x - plan.windows[0].x, 800);
});
t('调用方给了 screenList 就照它排（col/num/top/left）', () => {
  const plan = planArrange({
    count: 3, screens: SCREENS,
    params: {
      width: 800, height: 600, screenId: -1,
      screenList: [{ screen_id: 2, top: 10, left: 20, col: 1, num: 3 }],
    },
  });
  assert.deepEqual(plan.windows.map((w) => [w.x, w.y]), [[1940, 10], [1940, 610], [1940, 1210]]);
});
t('screenList 不够放 → 如实 warn，不静默少排', () => {
  const plan = planArrange({
    count: 3, screens: SCREENS,
    params: { width: 800, height: 600, screenId: -1, screenList: [{ screen_id: 1, col: 1, num: 1 }] },
  });
  assert.equal(plan.windows.length, 1);
  assert.match(plan.warnings.join(''), /只安排了 1 个窗口，还有 2 个没排进去/);
});

/* ============ 4.5 真实多屏：大整数显示器 id + 主屏标记（0.4.7.5 用户实测的坑） ============
 *
 * 用户机器：左边 24G4（id 479047157，x=-1080，1080×1920）、主屏 CU34G3X（id 2139135862，
 * x=0，3440×1440，可用区 3440×1392）。他在 UI 里选「3440 那块」点排列，结果窗口跨了两块屏，
 * 而 summary 还报「已排列 4 个窗口」。
 *
 * 根因两条：
 *   ① `normalizeArrange` 把 screenId 夹到 [-1,999] → 2139135862 变 999 → 匹配不到 → 回落 list[0]；
 *   ② `displays.json` 里两块屏 primary 都是 false（Electron 的 Display 没有 primary 字段，
 *      桌面壳却直接透传 `d.primary === true`）→ UI 不显示「内置屏幕」、不传 screenId 也落不到主屏。
 */
console.log('\n— 4.5 真实多屏：大整数 id 与主屏标记 —');
const USER_SCREENS = [
  { id: 479047157, primary: false, workArea: { x: -1080, y: 0, width: 1080, height: 1920 } },
  { id: 2139135862, primary: true, workArea: { x: 0, y: 0, width: 3440, height: 1392 } },
];
const inArea = (w, a) => w.x >= a.x && w.y >= a.y
  && w.x + w.width <= a.x + a.width && w.y + w.height <= a.y + a.height;

t('screenId = 2139135862（>999）不再被夹：4 个窗口全在 3440 屏 workArea 内', () => {
  const area = USER_SCREENS[1].workArea;
  const fit = autoFit(4, area);
  const plan = planArrange({
    count: 4, screens: USER_SCREENS,
    params: { screenId: 2139135862, width: fit.width, height: fit.height },
  });
  assert.equal(plan.screen_id, 2139135862);
  assert.doesNotMatch(plan.warnings.join(''), /超出范围/);
  assert.doesNotMatch(plan.warnings.join(''), /找不到显示器/);
  for (const w of plan.windows) {
    assert.ok(inArea(w, area), `窗口 ${w.index} 跑到屏外了：${JSON.stringify(w)}（可用区 ${JSON.stringify(area)}）`);
    assert.ok(w.x >= 0, `窗口 ${w.index} 的 x=${w.x} 落到了左边那块屏`);
  }
  // 4 个窗口互不重叠
  for (let i = 0; i < plan.windows.length; i += 1) {
    for (let j = i + 1; j < plan.windows.length; j += 1) {
      const a = plan.windows[i];
      const b = plan.windows[j];
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      assert.ok(!overlap, `窗口 ${i} 与 ${j} 重叠`);
    }
  }
});
t('screenId 传字符串（UI 就是这么传的）也认', () => {
  const area = USER_SCREENS[1].workArea;
  const plan = planArrange({
    count: 2, screens: USER_SCREENS,
    params: { screenId: '2139135862', width: 800, height: 600, row: 2 },
  });
  assert.equal(String(plan.screen_id), '2139135862');
  for (const w of plan.windows) assert.ok(inArea(w, area), JSON.stringify(w));
});
t('显示器交接：Electron 形状（没有 primary 字段）+ primaryId → 恰好一块 primary', () => {
  const electron = [
    { id: 479047157, label: '24G4', scaleFactor: 1, bounds: { x: -1080, y: 0, width: 1080, height: 1920 }, workArea: { x: -1080, y: 0, width: 1080, height: 1920 } },
    { id: 2139135862, label: 'CU34G3X', scaleFactor: 1, bounds: { x: 0, y: 0, width: 3440, height: 1440 }, workArea: { x: 0, y: 0, width: 3440, height: 1392 } },
  ];
  assert.equal(writeDisplays(electron, { primaryId: 2139135862 }), true);
  const back = readDisplays();
  const prim = back.displays.filter((d) => d.primary === true);
  assert.equal(prim.length, 1, `primary 数量不对：${JSON.stringify(back.displays.map((d) => [d.id, d.primary]))}`);
  assert.equal(String(prim[0].id), '2139135862');
  const forArrange = screensForArrange();
  assert.equal(String(forArrange.find((s) => s.primary)?.id), '2139135862');
});
t('不传 screenId → 落在主屏（3440 那块）workArea 内，不是 list[0]', () => {
  const plan = planArrange({ count: 2, screens: USER_SCREENS, params: { width: 800, height: 600, row: 2 } });
  assert.equal(String(plan.screen_id), '2139135862');
  for (const w of plan.windows) assert.ok(inArea(w, USER_SCREENS[1].workArea), JSON.stringify(w));
});
t('回归：没有任何屏被标 primary 时，不传 screenId 仍能排（回落 list[0]，不许抛）', () => {
  const noPrimary = USER_SCREENS.map((s) => ({ ...s, primary: false }));
  const plan = planArrange({ count: 2, screens: noPrimary, params: { width: 800, height: 600, row: 2 } });
  assert.equal(plan.windows.length, 2);
  assert.equal(String(plan.screen_id), '479047157');
});
t('回归：screenId:-1（全部屏幕）语义不变', () => {
  const plan = planArrange({ count: 4, screens: USER_SCREENS, params: { width: 800, height: 600, screenId: -1 } });
  assert.equal(plan.screen_id, -1);
  assert.equal(plan.windows.length, 4);
});
// 上面写了一份 displays.json：后面第 10 节要测「没有文件时 managed:false」，这里清掉，
// 免得把顺序依赖带进判据（清不掉也不影响本节断言，只是第 10 节会红）。
try { fs.rmSync(path.join(TMP, 'displays.json'), { force: true }); } catch { /* ignore */ }

/* ============================ 5. 计划自检 ============================ */
console.log('\n— 5. 计划自检：重叠 / 越界算得出来 —');
t('重叠被抓出来（含「差 1px 不算重叠」的边界）', () => {
  const a = { index: 0, x: 0, y: 0, width: 800, height: 600 };
  assert.deepEqual(auditPlan([a, { index: 1, x: 800, y: 0, width: 800, height: 600 }]).overlaps, []);
  assert.deepEqual(auditPlan([a, { index: 1, x: 799, y: 0, width: 800, height: 600 }]).overlaps, [[0, 1]]);
});
t('越界被抓出来（贴着右下边界算在内）', () => {
  const wa = { x: 0, y: 40, width: 1920, height: 1040 };
  assert.deepEqual(auditPlan([{ index: 0, x: 1120, y: 40, width: 800, height: 600 }], wa).outside, []);
  assert.deepEqual(auditPlan([{ index: 0, x: 1121, y: 40, width: 800, height: 600 }], wa).outside, [0]);
  assert.deepEqual(auditPlan([{ index: 0, x: 0, y: 0, width: 800, height: 600 }], wa).outside, [0]);
});

/* ============================ 6. 回读比对 ============================ */
console.log('\n— 6. 回读比对：命令成功 ≠ 窗口到位 —');
t('四个字段全对上 → ok', () => {
  const v = verifyPlacement({ x: 10, y: 20, width: 800, height: 600 }, { x: 10, y: 20, width: 800, height: 600, state: 'normal' });
  assert.equal(v.ok, true);
  assert.deepEqual(v.mismatches, []);
});
t('差 1px 也算没到位（不四舍五入糊过去）', () => {
  const v = verifyPlacement({ x: 10, y: 20, width: 800, height: 600 }, { x: 11, y: 20, width: 800, height: 600 });
  assert.equal(v.ok, false);
  assert.deepEqual(v.mismatches.map((m) => m.field), ['x']);
});
t('读不到位置（null）→ 没到位，actual 如实带 null', () => {
  const v = verifyPlacement({ x: 0, y: 0, width: 800, height: 600 }, { x: null, y: null, width: 800, height: 600 });
  assert.equal(v.ok, false);
  assert.equal(v.mismatches.length, 2);
  assert.equal(v.mismatches[0].actual, null);
});

/* ============================ 7. 摆一个窗口：判定只认回读 ============================ */
console.log('\n— 7. 摆一个窗口：命令成功 ≠ 到位（用假读数测，真内核测不了这条）—');
{
  /** 假 CDP：记录调用，回读由用例决定 */
  function fake({ readRect }) {
    const calls = [];
    return {
      calls,
      setBounds: async (windowId, bounds) => { calls.push({ windowId, bounds }); return {}; },
      readRect: async () => readRect(),
      wait: async () => {},
    };
  }
  const WANT = { x: 50, y: 70, width: 600, height: 350 };

  { // ① 命令成功 + 回读一致 → ok
    const f = fake({ readRect: () => ({ x: 50, y: 70, width: 600, height: 350, state: 'normal' }) });
    const r = await placeOne({ windowId: 7, want: WANT, setBounds: f.setBounds, readRect: f.readRect, wait: f.wait });
    check('回读一致 → ok=true，且确实发了 left/top/width/height',
      r.ok === true && f.calls.length === 1 && f.calls[0].bounds.width === 600 && f.calls[0].bounds.left === 50,
      JSON.stringify({ ok: r.ok, calls: f.calls }));
  }
  { // ② 命令成功（返回 {}）但回读不符 → 必须 ok=false
    const f = fake({ readRect: () => ({ x: 50, y: 70, width: 516, height: 350, state: 'normal' }) });
    const r = await placeOne({ windowId: 7, want: { ...WANT, width: 300 }, setBounds: f.setBounds, readRect: f.readRect, wait: f.wait });
    check('命令成功但回读不符 → ok=false（不许相信命令返回值）', r.ok === false, JSON.stringify(r));
    check('原因写清「width 期望 300 实际 516」', /width 期望 300 实际 516/.test(r.reason || ''), r.reason);
    check('actual 如实记录回读到的真实值', r.actual?.width === 516, JSON.stringify(r.actual));
  }
  { // ③ 尺寸对但状态不是 normal → ok=false（尺寸对不等于能同步）
    const f = fake({ readRect: () => ({ x: 50, y: 70, width: 600, height: 350, state: 'maximized' }) });
    const r = await placeOne({ windowId: 7, want: WANT, setBounds: f.setBounds, readRect: f.readRect, wait: f.wait });
    check('回读状态是 maximized → ok=false，原因说状态',
      r.ok === false && /窗口状态是 maximized/.test(r.reason || ''), JSON.stringify(r));
  }
  { // ④ 非 normal 起手：必须先发 windowState=normal，再发矩形
    const f = fake({ readRect: () => ({ x: 50, y: 70, width: 600, height: 350, state: 'normal' }) });
    const r = await placeOne({
      windowId: 7, want: WANT, stateBefore: 'maximized', setBounds: f.setBounds, readRect: f.readRect, wait: f.wait,
    });
    check('本来最大化 → 第一条命令是 windowState=normal',
      f.calls.length === 2 && f.calls[0].bounds.windowState === 'normal', JSON.stringify(f.calls.map((c) => c.bounds)));
    check('先回 normal 再摆 → ok=true', r.ok === true, JSON.stringify(r));
  }
  { // ⑤ normal 起手不要多发一条命令（少一次可见抖动）
    const f = fake({ readRect: () => ({ x: 50, y: 70, width: 600, height: 350, state: 'normal' }) });
    await placeOne({
      windowId: 7, want: WANT, stateBefore: 'normal', setBounds: f.setBounds, readRect: f.readRect, wait: f.wait,
    });
    check('本来 normal → 只发一条命令', f.calls.length === 1, JSON.stringify(f.calls.length));
  }
  { // ⑥ 读不到位置（抛异常）→ ok=false 且原因如实带出
    const f = fake({ readRect: () => { throw new Error('Target closed'); } });
    const r = await placeOne({ windowId: 7, want: WANT, setBounds: f.setBounds, readRect: f.readRect, wait: f.wait });
    check('回读抛异常 → ok=false，原因原样带出（不吞）',
      r.ok === false && r.reason === 'Target closed', JSON.stringify(r));
  }
  { // ⑦ 命令本身抛异常 → 也如实报
    const f = fake({ readRect: () => ({ x: 0, y: 0, width: 1, height: 1, state: 'normal' }) });
    const r = await placeOne({
      windowId: 7, want: WANT,
      setBounds: async () => { throw new Error('Browser.setWindowBounds failed'); },
      readRect: f.readRect, wait: f.wait,
    });
    check('设窗口失败 → ok=false，原因原样带出',
      r.ok === false && /setWindowBounds failed/.test(r.reason || ''), JSON.stringify(r));
  }
}

/* ============================ 8. 结果汇总 ============================ */
console.log('\n— 8. 结果汇总：改不动要如实说 —');
t('全部到位 → 「已排列 N 个窗口」', () => {
  const s = summarizeArrange([{ profile_id: 'a', ok: true }, { profile_id: 'b', ok: true }]);
  assert.equal(s.ok, true);
  assert.match(s.message, /已排列 2 个窗口/);
});
t('有失败 → 「有 N 个窗口没能排到位」，并带原因', () => {
  const s = summarizeArrange([
    { profile_id: 'a', ok: true },
    { profile_id: 'b', role: 'slave', ok: false, mismatches: [{ field: 'x', expected: 800, actual: 700 }] },
  ]);
  assert.equal(s.ok, false);
  assert.equal(s.failed, 1);
  assert.match(s.message, /有 1 个窗口没能排到位/);
  assert.match(s.details[0].reason, /x 期望 800 实际 700/);
});
t('异常原因原样带出（不吞成「位置不符」）', () => {
  const s = summarizeArrange([{ profile_id: 'x', ok: false, reason: 'connection lost' }]);
  assert.equal(s.details[0].reason, 'connection lost');
});

/* ============================ 9. 一键排列（按可用区自动算） ============================ */
console.log('\n— 9. 一键排列：排出来必须放得下、不重叠 —');
t('2 个窗口在 1920×1040 里 → 2 列 1 行，每格 960×1040', () => {
  const f = autoFit(2, PRIMARY.workArea, { gap: 0 });
  assert.equal(f.cols, 2);
  assert.equal(f.rows, 1);
  assert.equal(f.width, 960);
  assert.equal(f.height, 1040);
});
t('带间距时总宽不超出可用区', () => {
  const f = autoFit(4, PRIMARY.workArea, { gap: 10 });
  assert.ok(f.cols * f.width + (f.cols - 1) * 10 <= PRIMARY.workArea.width);
});
t('3 个窗口：排出来不重叠、不出界', () => {
  const f = autoFit(3, PRIMARY.workArea, { gap: 8 });
  const plan = planArrange({ count: 3, screens: SCREENS, params: { width: f.width, height: f.height, row: f.cols, hs: 8, vs: 8 } });
  const audit = auditPlan(plan.windows, PRIMARY.workArea);
  assert.equal(audit.overlaps.length, 0);
  assert.equal(audit.outside.length, 0);
});
t('窗口太多时尺寸不小于下限（宽 516 / 高 200），且仍然放得下', () => {
  const f = autoFit(12, { x: 0, y: 0, width: 900, height: 700 }, { gap: 0 });
  assert.ok(f.width >= MIN_WINDOW_WIDTH && f.height >= MIN_WINDOW_HEIGHT);
  assert.ok(f.cols * f.width <= 900, `${f.cols}×${f.width} > 900`);
});

/* ============================ 10. 显示器交接 ============================ */
console.log('\n— 10. 显示器交接：文件读写 + 只暴露 workArea —');
t('没有文件时 managed:false、空列表（不是错误）', () => {
  const r = readDisplays();
  assert.equal(r.managed, false);
  assert.deepEqual(r.displays, []);
});
t('写进去再读出来：workArea / bounds 都保留，managed:true', () => {
  assert.equal(writeDisplays([PRIMARY, SECOND]), true);
  const r = readDisplays();
  assert.equal(r.managed, true);
  assert.equal(r.displays.length, 2);
  assert.deepEqual(r.displays[0].work_area, PRIMARY.workArea);
  assert.deepEqual(r.displays[0].bounds, PRIMARY.bounds);
  assert.equal(r.displays[0].primary, true);
  assert.equal(r.displays[1].primary, false);
});
t('screensForArrange 只给 id/primary/workArea（排列不该看到 bounds）', () => {
  const s = screensForArrange();
  assert.deepEqual(Object.keys(s[0]).sort(), ['id', 'primary', 'workArea']);
  assert.deepEqual(s[0].workArea, PRIMARY.workArea);
  assert.equal(s.length, 2);
});
t('坏文件不抛异常，当没有桌面壳处理', () => {
  fs.writeFileSync(path.join(TMP, 'displays.json'), '{ not json');
  const r = readDisplays();
  assert.equal(r.managed, false);
  assert.deepEqual(r.displays, []);
});

/* ============================ 11. 路由 / 界面 / 桌面壳（静态扫描） ============================ */
console.log('\n— 11. 接线（静态扫描）—');
{
  const read = (p) => fs.readFileSync(path.resolve(import.meta.dirname, '..', p), 'utf8');
  const routeSrc = read('src/api/routes.js');
  // 0.4.7.13：session.js 拆成门面 + session-*.js，静态扫描读全部
  const sessionSrc = ['session.js','session-state.js','session-cdp.js','session-live.js','session-windows.js','session-tabs.js'].map((f) => read(`src/sync/${f}`)).join('\n');
  const panelSrc = read('web/pages/sync-panel.js');
  /**
   * 排列区块 0.4.5 起搬进了共用组件 `web/sync-widgets.js`（操作台与「窗口同步」页各摆一份，
   * CEO 要求「复用组件、不许另写一套」）。所以下面这些断言扫的是**共用组件**，
   * 并且额外钉住「两个页面都 import 它」—— 比原来只扫一个页面更严。
   */
  const widgetSrc = read('web/sync-widgets.js');
  const syncPageSrc = read('web/pages/sync.js');
  const apiSrc = read('web/api.js');
  const desktopSrc = read('desktop/main.js');
  const arrangeSrc = read('src/sync/arrange.js');
  const code = (s) => s.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');

  check('路由存在：POST /api/v2/sync/arrange', routeSrc.includes("'/api/v2/sync/arrange'"));
  check('路由存在：GET /api/v2/sync/displays', routeSrc.includes("'/api/v2/sync/displays'"));
  check('路由真把 arrangeWindows / readDisplays 引进来了（不是只写在字符串里）',
    /import \{[^}]*arrangeWindows[^}]*\} from '\.\.\/sync\/session\.js'/.test(routeSrc)
    && /import \{ readDisplays \} from '\.\.\/sync\/displays\.js'/.test(routeSrc));
  check('界面有「窗口排列」按钮并接上 API', widgetSrc.includes('窗口排列') && widgetSrc.includes('syncArrange'));
  /*
   * 0.4.7.5 布局改版后，两处界面的**视觉骨架**按 31 号文故意不同（窗口同步页是屏幕卡片 + 单选，
   * 操作台小窗是下拉 + 数字输入），所以不再要求两边都 import 同一个 DOM 组件。
   * 但「不各写一套」的实质要求反而钉得更死了：**请求体构造与调用只有一处** ——
   * 页面自己不许出现 api.syncArrange，必须走 sync-widgets 的 runArrange。
   */
  check('两处界面共用同一份排列实现（请求体与调用都在 sync-widgets.js，页面不自己拼）',
    /import \{[^}]*runArrange[^}]*\} from '\.\.\/sync-widgets\.js'/.test(syncPageSrc)
    && /import \{[^}]*buildArrangePanel[^}]*\} from '\.\.\/sync-widgets\.js'/.test(panelSrc)
    && !syncPageSrc.includes('api.syncArrange')
    && (code(widgetSrc).match(/api\.syncArrange/g) || []).length === 1);
  check('界面的参数名对齐对手（排列方式/起始位置/窗口大小/窗口间距/窗口数量/个\\/行/显示器）',
    ['排列方式', '起始位置', '窗口大小', '窗口间距', '窗口数量', '个/行', '显示器', '一键排列', '自定义排列']
      .every((k) => widgetSrc.includes(k)));
  check('界面用对手原文提示语（rangeTips / sync85）',
    widgetSrc.includes('根据显示器的分辨率自动排列所选窗口')
    && widgetSrc.includes('跨屏同步：建议使用【自定义排列】设置相同的窗口大小'));
  check('界面把「没能排到位」如实显示（读 placed[].ok，不是自己拼成功）',
    widgetSrc.includes('placed') && /没能排到位/.test(widgetSrc));
  check('界面会读显示器列表（多屏选择不是摆设）',
    apiSrc.includes('syncDisplays')
    && panelSrc.includes('syncDisplays') && syncPageSrc.includes('syncDisplays')
    && /getDisplays/.test(widgetSrc));
  check('排列用 screensForArrange（服务进程侧读显示器）', /screensForArrange\(/.test(code(sessionSrc)));
  check('排列把窗口原状态交给 placeOne（非 normal 下宽高会被静默忽略）',
    /needsRestoreBeforeResize\(/.test(code(arrangeSrc)) && /stateBefore:/.test(code(sessionSrc)));
  check('排列设完**回读**比对：session 走 placeOne，placeOne 内部用 verifyPlacement',
    /placeOne\(/.test(code(sessionSrc)) && /verifyPlacement\(/.test(code(arrangeSrc)));
  // 只扫 arrangeWindows 这一段：unifySize 里也有一处 entry.ok =，那是它自己的判定，不在此列
  const arrangeBody = (() => {
    const src = code(sessionSrc);
    const at = src.indexOf('export async function arrangeWindows');
    if (at < 0) return '';
    const rest = src.slice(at + 10);
    const end = rest.indexOf('export async function');
    return end < 0 ? rest : rest.slice(0, end);
  })();
  check('arrangeWindows 不自己写 ok（判定只在 placeOne 里，防「相信命令」回流）',
    arrangeBody.length > 200 && !/entry\.ok\s*=/.test(arrangeBody),
    arrangeBody.length > 200 ? '' : '找不到 arrangeWindows 函数体');
  check('排列不静默成功：失败带 summary', /summarizeArrange\(/.test(code(sessionSrc)));
  check('桌面壳用 screen.getAllDisplays() 写显示器（服务进程拿不到这个 API）',
    /screen\.getAllDisplays\(\)/.test(desktopSrc) && /writeDisplays\??\.?\(/.test(desktopSrc));
  check('显示器变了要跟着更新（插拔/改缩放/任务栏移位）',
    ['display-added', 'display-removed', 'display-metrics-changed'].every((e) => desktopSrc.includes(e)));
  check('排列逻辑里没有 bounds（用 bounds 会把窗口压到任务栏底下）',
    !/\.bounds\b/.test(code(arrangeSrc)));
  check('排列不 import electron、不碰显示器/系统设置',
    !/electron/.test(code(sessionSrc)) && !/getAllDisplays/.test(code(sessionSrc)));
}

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail}/${results.length} 通过`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);