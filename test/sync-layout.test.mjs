/**
 * 窗口同步页**布局**判据（0.4.7.5，照逆向 `31-窗口同步页布局规格.md`）。
 *
 * 这一版把竖排卡片改成对手那套骨架：顶部操作条 → 左表格卡 → 右操作台卡（两列）。
 * 不需要 Chrome：读源码 + 读 CSS，断言结构与文案。
 *
 * 判据：
 *   ① 区块顺序：顶部条 → 左表格卡 → 右操作台，且 CSS 是两列（flex + 480 定宽）
 *   ② 表格 7 列的顺序与列宽（40/100/100/80/90/160/100）
 *   ③ 三条空态文案**逐字**
 *   ④ **没有假控件**：AI 自动操作 / 外观 / 仿真操作 / 文本管理 / 帮助中心 一律不出现
 *   ⑤ 操作列 fixed：横向滚动后仍可见（`position:sticky; right:0`）
 *   ⑥ 少于 2 个选中点启动同步 → toast 文案逐字，且**不发启动请求**
 *   ⑦ 行高 56 / 表头 38 / 主控行 #D2ECFF / 三态颜色
 *
 * 跑法：npm run test:sync-layout
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'web/pages/sync.js'), 'utf8');
const WIDGET = fs.readFileSync(path.join(ROOT, 'web/sync-widgets.js'), 'utf8');
const PREFS = fs.readFileSync(path.join(ROOT, 'web/sync-prefs.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'web/style.css'), 'utf8');
/** 偏好模块是纯数据（不 import ui/api），可以直接跑 —— 脏值收敛与往返都在这里测 */
const prefsMod = await import('../web/sync-prefs.js');
/** 去掉注释后的「真正会渲染的代码」：假控件断言看的是页面上会出现什么，不是注释里提到什么 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail += 1; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};
const at = (s) => SRC.indexOf(s);

/* ① 区块顺序 + 两列骨架 */
{
  const top = at('mount(page, topBar, warnBar, wrap)');
  check('① 页面按 顶部条 → 尺寸提示 → wrap(左表格 + 右操作台) 挂载', top > 0, top > 0 ? '' : '没找到 mount(page, topBar, warnBar, wrap)');
  const wrapDecl = at("h('div', { class: 'sync-wrap' }, tableCard, operateCard)");
  check('① 左表格卡在右操作台卡之前', wrapDecl > 0);
  check('① CSS：.sync-wrap 是 flex 两列',
    /\.sync-wrap\s*\{[^}]*display:\s*flex/.test(CSS));
  check('① CSS：左卡 flex:1 + min-width:540 + margin-right:12',
    /\.sync-table-card\s*\{[^}]*flex:\s*1;[^}]*min-width:\s*540px;[^}]*margin-right:\s*12px/.test(CSS));
  check('① CSS：右卡 480 定宽 + flex-shrink:0',
    /\.sync-operate-card\s*\{[^}]*width:\s*480px;[^}]*flex-shrink:\s*0/.test(CSS));
  check('① CSS：页面内边距 12', /\.page\.sync-page\s*\{\s*padding:\s*12px/.test(CSS));
  check('① CSS：顶部条高 40 + 下间距 12',
    /\.sync-top\s*\{[^}]*height:\s*40px;[^}]*margin-bottom:\s*12px/.test(CSS));
  check('① CSS：卡片圆角 8', /\.sync-table-card\s*\{[^}]*border-radius:\s*8px/.test(CSS)
    && /\.sync-operate-card\s*\{[^}]*border-radius:\s*8px/.test(CSS));
}

/* ② 表格 7 列 */
{
  const cols = SRC.match(/const cols = \[([^\]]+)\]/);
  check('② 列宽 = 40/100/100/80/90/160/100',
    Boolean(cols) && cols[1].replace(/\s/g, '') === '40,100,100,80,90,160,100',
    cols ? cols[1] : '没找到 cols');
  const order = ["'序号'", "'环境编号'", "'分组'", "'环境名称'", "'状态'", "'操作'"].map(at);
  check('② 表头 6 个文字列的顺序对', order.every((n) => n > 0) && order.every((n, i) => i === 0 || n > order[i - 1]),
    `位置 ${order.join(',')}`);
  check('② 复选框列在 序号 之前', at("class: 'sync-col-check' }") < order[0]);
}

/* ③ 三条空态文案逐字 */
{
  check('③ 空态①「暂无已打开的浏览器环境」', SRC.includes("'暂无已打开的浏览器环境'"));
  check('③ 空态②「打开2个浏览器，即开启窗口同步操作」', SRC.includes("'打开2个浏览器，即开启窗口同步操作'"));
  check('③ 空态③「前往打开」且跳到环境管理', SRC.includes("'前往打开'") && SRC.includes("location.hash = '#/profiles'"));
}

/* ④ 没有假控件（硬要求） */
{
  const banned = ['AI 自动操作', 'AI自动操作', '仿真操作', '帮助中心'];
  for (const w of banned) {
    check(`④ 页面上不出现「${w}」（我们没有这能力）`, !CODE.includes(w) && !CSS.includes(w));
  }
  // 「外观」是词，别把「外观」误伤到别的词里：只在控件文案位置断言
  check('④ 页面上没有「外观」设置项', !/['"]外观['"]/.test(CODE));
  // 文本管理 tab：我们没做「文本组」，这一版不摆
  check('④ 不摆「文本管理」tab', !CODE.includes("'文本管理'"));
  // 桌面小组件：**只在有桌面壳时**渲染（没有就整条不摆，不是画个死开关）
  const widget = at("'桌面小组件'");
  const desktopGuard = at('desktopBridge()');
  check('④ 「桌面小组件」只在 desktop 存在时渲染', widget > 0 && desktopGuard > 0 && desktopGuard < widget,
    `desktopBridge@${desktopGuard} widget@${widget}`);
  // 每个 onClick 都必须落到真实动作上（不许空函数/占位）
  const empties = (SRC.match(/onClick:\s*\(\)\s*=>\s*\{\s*\}/g) || []).length;
  check('④ 没有空的 onClick 占位', empties === 0, `空 onClick ${empties} 个`);
  const apiCalls = (SRC.match(/api\.\w+\(/g) || []).length;
  check('④ 页面真实调了后端接口（api.* 调用数 ≥ 12）', apiCalls >= 12, `api.* = ${apiCalls}`);
}

/* ⑤ 操作列固定 */
{
  check('⑤ CSS：操作列 position:sticky + right:0',
    /\.sync-table \.sync-col-op\s*\{[^}]*position:\s*sticky;[^}]*right:\s*0/.test(CSS));
  check('⑤ 表头也有固定列样式', /\.sync-table thead \.sync-col-op/.test(CSS));
}

/* ⑥ 少于 2 个选中：toast 逐字 + 不发请求 */
{
  const fn = SRC.slice(at('async function start()'), at('async function stop()'));
  const guard = fn.indexOf("state.selected.size < 2");
  const call = fn.indexOf('api.syncStart');
  check('⑥ 少于 2 个选中 → toast「请选择至少两个浏览器进行操作」', fn.includes("'请选择至少两个浏览器进行操作'"));
  check('⑥ 0 个已打开 → toast「暂无已打开的浏览器环境」', fn.includes("'暂无已打开的浏览器环境'"));
  check('⑥ 两个拦截都在 api.syncStart 之前', guard > 0 && call > guard, `guard@${guard} call@${call}`);
  check('⑥ 启动按钮**不置灰**（没有 disabled 依赖选中数）',
    !/class: 'sync-btn sync-btn-start',\s*disabled/.test(SRC));
}

/* ⑦ 尺寸与颜色 */
{
  check('⑦ CSS：数据行高 56', /\.sync-table tbody td\s*\{[^}]*height:\s*56px/.test(CSS));
  check('⑦ CSS：表头高 38 + 2px #F8FAFF 分隔线',
    /\.sync-table thead th\s*\{[^}]*height:\s*38px;[^}]*border-bottom:\s*2px solid #F8FAFF/.test(CSS));
  check('⑦ CSS：偶数行 #F8FAFF', /tr:nth-child\(even\) td\s*\{\s*background:\s*#F8FAFF/.test(CSS));
  check('⑦ CSS：悬停 #E8EDFF', /tr:hover td\s*\{\s*background:\s*#E8EDFF/.test(CSS));
  check('⑦ CSS：主控行 #D2ECFF', /tr\.is-main td\s*\{\s*background:\s*#D2ECFF/.test(CSS));
  check('⑦ 三态颜色：#1E4DFF / 默认 / #C9CAD1',
    /\.sync-st-main\s*\{[^}]*color:\s*#1E4DFF/.test(CSS) && /\.sync-st-idle\s*\{[^}]*color:\s*#C9CAD1/.test(CSS));
  check('⑦ 三态文案：同步中(主控) / 同步中 / -',
    SRC.includes("'同步中(主控)'") && SRC.includes("'同步中'") && SRC.includes("' - '") === false);
  check('⑦ 未同步时显示 主控窗口 / 被控窗口',
    SRC.includes("'主控窗口'") && SRC.includes("'被控窗口'"));
  check('⑦ 表格里**没有**「同步异常」', !CODE.includes('同步异常'));
}

/* ⑧ 文案逐字（对手 i18n 取准的那批） */
{
  const words = ['启动同步', '停止同步', '重启同步', '窗口排列', '显示窗口', '统一大小', '自定义排列',
    '起始位置', '窗口大小', '窗口间距', '窗口数量', '一键排列', '显示器', '内置屏幕', '扩展屏幕',
    '操作台', '窗口管理', '标签管理', '设为主控'];
  const missing = words.filter((w) => !SRC.includes(w));
  check('⑧ 规格里的控件文案都在', missing.length === 0, missing.length ? `缺：${missing.join('、')}` : `${words.length} 条`);
}


/* ⑨ 31 号文 §11 的两条更正 */
{
  // 「统一大小」是按钮、和「显示窗口」同一行等宽，未同步时 disabled，且点了不发请求
  check('⑨ 「统一大小」和「显示窗口」在同一行（sync-grid-row）',
    /class: 'sync-grid-row'/.test(SRC) && SRC.includes("'显示窗口'") && SRC.includes("'统一大小'"));
  check('⑨ CSS：两个按钮各占 50%（flex:1 + 高 40）',
    /\.sync-grid-btn\s*\{[^}]*flex:\s*1;[^}]*height:\s*40px/.test(CSS));
  check('⑨ 「统一大小」未同步时 disabled（disabled: !isRunning()）',
    /'统一大小'[\s\S]{0,200}disabled: !isRunning\(\)/.test(SRC) || /disabled: !isRunning\(\)[\s\S]{0,200}'统一大小'/.test(SRC));
  const uni = SRC.slice(at('async function unifySize'), at('async function runTab'));
  check('⑨ 未同步时点「统一大小」不发请求（函数入口就 return）',
    uni.indexOf('isRunning()') > 0 && uni.indexOf('isRunning()') < uni.indexOf('api.syncUnifySize'));
  check('⑨ tooltip 文案「所选窗口跟主控窗口大小一致」', SRC.includes('所选窗口跟主控窗口大小一致'));

  // 「自定义排列」= 自动排列开关关掉后的模式，4 行字段顺序与前后缀
  const cf = SRC.slice(at('function customFields'), at('function readCustom'));
  const order = ["'起始位置'", "'窗口大小'", "'窗口间距'", "'窗口数量'"].map((w) => cf.indexOf(w));
  check('⑨ 自定义排列 4 行字段顺序：起始位置 / 窗口大小 / 窗口间距 / 窗口数量',
    order.every((n) => n > 0) && order.every((n, i) => i === 0 || n > order[i - 1]), `位置 ${order.join(',')}`);
  check('⑨ 前缀/后缀：X / Y / 宽 / 高 / 横向 / 纵向 / 个/行',
    ['X', 'Y', '宽', '高', '横向', '纵向'].every((w) => cf.includes(`pre('${w}')`)) && cf.includes("'个/行'"),
    ['X', 'Y', '宽', '高', '横向', '纵向'].filter((w) => !cf.includes(`pre('${w}')`)).join('、') || '');
  check('⑨ 默认值 0/0、500/200、0/0、3',
    /width:\s*500, height:\s*200/.test(SRC) && /row:\s*3/.test(SRC) && /left:\s*0, top:\s*0/.test(SRC));
  check('⑨ 开关开→「一键排列 (Ctrl+Alt+Z)」，关→「自定义排列 (Ctrl+Alt+Z)」',
    SRC.includes("'一键排列 (Ctrl+Alt+Z)'") && SRC.includes("'自定义排列 (Ctrl+Alt+Z)'"));
  // 0.4.7.5 §12 更正：重叠平铺的真实语义测出来了（横向层叠 30px + 拉满工作区），所以现在**要摆**；
  // 「垂直平铺」是 OCR 误读，从来没有这个选项，仍然不许出现。
  check('⑨ 摆「重叠平铺」（§12 已测出真实语义）', CODE.includes('重叠平铺'));
  check('⑨ 不摆「垂直平铺」（那是 OCR 误读，没有这个选项）', !CODE.includes('垂直平铺'));
  check('⑨ 同步中顶部按钮文案「停止同步 (Ctrl+Alt+D)」', SRC.includes("'停止同步 (Ctrl+Alt+D)'"));
}

/* ⑩ 31 号文 §12 的四条（重叠平铺 / radio 常驻 / 同步态锁勾选 / 字段记忆） */
{
  // ① 排列方式 radio：两个模式下都渲染（不在 autoOn 的三元里）
  check('⑩ 排列方式用共享的 ARRANGE_KINDS（页面不自己写一份选项）',
    /import \{[^}]*ARRANGE_KINDS[^}]*\} from '\.\.\/sync-prefs\.js'/.test(SRC));
  check('⑩ kindRow 在返回树里、且与 autoOn 无关（两个模式都渲染）',
    /kindRow,/.test(SRC) && !/autoOn\s*\?\s*[^;]*kindRow/.test(SRC),
    'kindRow 不许挂在自动排列开关的三元分支里');
  check('⑩ 「重叠平铺」在显示器 = 全部屏幕时不出现',
    /k\.key === 'over' && state\.screenId === -1/.test(SRC));
  check('⑩ 只剩一个选项时不摆 radio（直接写文字）', /kinds\.length > 1/.test(SRC));
  // ② 重叠平铺的请求体：range:1，且不带自定义宽高
  check('⑩ 重叠平铺走 range:1（尺寸由服务端按工作区算）',
    /mode === 'over'[\s\S]{0,160}range: 1/.test(WIDGET));
  check('⑩ 页面把重叠平铺传给 runArrange（mode 由 tileMode 决定）',
    /state\.tileMode === 'over' \? 'over'/.test(SRC));
  check('⑩ 重叠平铺时界面说明「宽/高/间距/每行个数对它无效」',
    SRC.includes('宽/高/间距/每行个数对它无效'));

  // ③ 同步运行中列表勾选被锁 + 说清楚
  check('⑩ 同步中复选框 disabled（表头 + 行内都锁）',
    (SRC.match(/disabled: locked/g) || []).length >= 2);
  check('⑩ 锁定态有 tooltip「同步进行中，停止同步后才能修改选择」',
    SRC.includes('同步进行中，停止同步后才能修改选择'));
  check('⑩ 同步中点整行也不改选择（row click 提前 return）',
    /if \(locked\) return;/.test(SRC) && /onClick: \(e\) => \{[\s\S]{0,300}if \(locked\) return;/.test(SRC));
  check('⑩ 同步中说清楚「启动后才打开的环境不会自动加入」',
    SRC.includes('同步启动后才打开的环境不会自动加入本次同步'));

  // ④ 自定义排列 4 个字段记住上次的值（localStorage，沿用仓库口径）
  check('⑩ 偏好键是 fp.sync_arrange（只写 localStorage，不写库）',
    /ARRANGE_PREFS_KEY = 'fp\.sync_arrange'/.test(PREFS));
  check('⑩ 页面每次改都落盘（开关/radio/4 行数字框都调 rememberArrange）',
    (SRC.match(/rememberArrange\(\)/g) || []).length >= 4);
  check('⑩ 页面启动时读回偏好', /const saved = readArrangePrefs\(\)/.test(SRC));
  // 纯函数直接跑：脏值收敛 + 往返
  const C = prefsMod;
  check('⑩ 脏值收敛：认不出来的一律回默认（不把页面画坏）', (() => {
    const a = C.normalizeArrangePrefs({ autoArrange: 'yes', tileMode: 'diagonal', custom: { width: 'abc', row: 999 } });
    return a.autoArrange === false && a.tileMode === 'grid'
      && a.custom.width === C.DEFAULT_ARRANGE_CUSTOM.width && a.custom.row === 20;
  })());
  check('⑩ 往返：写进去 7 个/行，读回来还是 7（切页/重进都在）', (() => {
    const mem = new Map();
    const store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
    C.writeArrangePrefs({ autoArrange: false, tileMode: 'over', custom: { ...C.DEFAULT_ARRANGE_CUSTOM, row: 7 } }, store);
    const back = C.readArrangePrefs(store);
    return back.autoArrange === false && back.tileMode === 'over' && back.custom.row === 7;
  })());
  check('⑩ 没有 localStorage（隐私模式）也不抛，回默认', (() => {
    const back = C.readArrangePrefs({ getItem: () => { throw new Error('denied'); } });
    return back.custom.row === C.DEFAULT_ARRANGE_CUSTOM.row;
  })());
  check('⑩ 两个界面共用同一份偏好模块（操作台组件也 import sync-prefs）',
    /from '\.\/sync-prefs\.js'/.test(WIDGET));
}

/* ⑪ 语法自检：页面/组件必须真的能被 JS 引擎解析
 * 踩过：改版时少了一个右括号，`node --check` 一跑就红，但所有静态字符串断言全绿 ——
 * 页面根本加载不了，判据却一条都没红。这类「文件压根不合法」必须单独钉一条。 */
{
  const files = ['web/pages/sync.js', 'web/sync-widgets.js', 'web/sync-prefs.js'];
  for (const f of files) {
    let ok = true;
    let msg = '';
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
    } catch (e) {
      ok = false;
      msg = String(e.stderr || e.message).split('\n').slice(0, 3).join(' ');
    }
    check(`⑪ ${f} 能通过 node --check（括号/语法没错）`, ok, ok ? '' : msg);
  }
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
assert.equal(fail, 0);
