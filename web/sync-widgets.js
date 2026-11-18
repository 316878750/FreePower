/**
 * 窗口同步的两个共用区块：**窗口排列**（`tileWin`）与**显示窗口**（`viewWin`）。
 *
 * 为什么抽出来：操作台（独立小窗）和「窗口同步」页都要这两个入口。
 * CEO 明确要求「复用现有 API 与组件，**不许另写一套**」——
 * 所以两个页面 import 的是同一个模块，打的是同两条既有路由
 * （`POST /api/v2/sync/arrange`、`POST /api/v2/sync/show`），没有任何页面自己拼请求。
 *
 * 两块的**能力边界**都写在界面上（不是藏在代码注释里）：
 *   · 排列：只在用户点按钮时改窗口（改窗口是可见副作用，绝不自动）；
 *   · 显示：最小化的能真到前台；只是被盖住的只能做页面级激活，如实报 `page_only`。
 */
import { h, mount, toast } from './ui.js';
import { api } from './api.js';

import { ARRANGE_KINDS, readArrangePrefs, writeArrangePrefs } from './sync-prefs.js';

/**
 * **窗口排列请求体**的唯一构造函数（两处界面共用，不许各拼一份）。
 *
 * @param {{mode?:'grid'|'over'|'vertical'|'custom', screenId?:any, ids?:string[], custom?:object|null}} o
 *   mode: grid = 一键排列（宫格平铺）；over = 重叠平铺；vertical = 垂直平铺（单列铺满）；
 *         custom = 自定义参数
 * @returns {object} 直接交给 `api.syncArrange`
 */
export function buildArrangeBody({ mode = 'grid', screenId = null, ids = [], custom = null } = {}) {
  let body;
  if (mode === 'custom') {
    body = { ...(custom || {}) };
  } else if (mode === 'over') {
    /* 重叠平铺：尺寸与步长都由服务端按工作区算（30 硬编码），只把「起始位置」带过去。
     * 宽/高/间距/每行个数对它无效 —— 这一点界面上要写出来，不能让用户以为填了有用。 */
    body = { range: 1 };
    if (custom) {
      if (custom.left !== undefined) body.left = custom.left;
      if (custom.top !== undefined) body.top = custom.top;
    }
  } else if (mode === 'vertical') {
    // 垂直平铺 = 单列纵向：一行一个，高度按窗口数等分所选屏的可用区。
    // 用既有自定义参数表达，不新增后端分支。
    const area = (custom && custom.area) || { x: 0, y: 0, width: 1280, height: 800 };
    const n = Math.max(1, (ids || []).length || 1);
    body = {
      width: area.width, height: Math.max(200, Math.floor(area.height / n)),
      row: 1, hs: 0, vs: 0, left: area.x, top: area.y, range: 0,
    };
  } else {
    body = { auto: true };
  }
  if (screenId !== null && screenId !== undefined) body.screenId = screenId;
  const list = (ids || []).filter(Boolean).map(String);
  if (list.length) body.ids = list;
  return body;
}

/**
 * **排列的唯一执行入口**：构造请求体 + 打 `POST /api/v2/sync/arrange`。
 *
 * 为什么连「调用」也放这里：两处界面（窗口同步页 / 操作台小窗）的**视觉骨架**按 31 号文
 * 故意不同（一个是屏幕卡片 + 单选，一个是下拉 + 数字输入），但**请求只许有一个出处** ——
 * 否则参数一改就得改两遍，早晚走岔。
 *
 * @returns {Promise<object>} 服务端原样返回（`placed` / `skipped` / `warnings` / `auto`）
 */
export async function runArrange(opts) {
  return api.syncArrange(buildArrangeBody(opts));
}

/**
 * **「显示窗口」的唯一执行入口**（与 `runArrange` 同一条理由）：
 * 两处界面的按钮长得不一样，但打的必须是同一条路由、同一套参数形状。
 *
 * @param {string[]|null} ids 传 null/空数组 = 用当前同步会话里的窗口
 */
export async function runShow(ids) {
  const list = (ids || []).filter(Boolean).map(String);
  return list.length ? api.syncShow(list) : api.syncShow();
}

/**
 * 窗口排列区块。
 *
 * 参数逐项对齐对手 `toRangeBrowser`（`26-窗口同步实现细节.md` / `28-远端UI界面结构.md:174-178`）：
 *   排列方式 `syncOperateArrangement` → 一键排列 `sync90` / 自定义排列 `customRange`
 *   起始位置 `startSide` → left / top
 *   窗口大小 `windowSize` → width / height
 *   窗口间距 `windowMarge` → hs / vs
 *   窗口数量 `windowNum` + `syncOperate5`「个/行」→ row
 *   显示器 `sync84` → screenId（-1 = 全部屏幕）
 *
 * **作用范围**（0.4.7.4 解绑）：对手的流程是「勾选环境 → 窗口排列 → 启动同步」，
 * 排列**不需要同步已经起来**。所以这里多一个范围选择：
 *   · 已选环境（默认）：把页面上勾选的那些运行中环境 id 发给服务端（`ids`）；
 *   · 当前同步会话：不传 ids，用会话里的窗口（解绑前的老行为）。
 * 两页（操作台 / 窗口同步页）都用这一份组件，**不各写一套**。
 *
 * @param {{nameOf:(id:string)=>string, getDisplays:()=>object[], getSelectionIds?:()=>string[], compact?:boolean}} opt
 * @returns {{el:HTMLElement, refresh:(displays?:object[])=>void}}
 */
export function buildArrangePanel({ nameOf, getDisplays, getSelectionIds = null, compact = false }) {
  const saved = readArrangePrefs();
  const state = {
    mode: 'auto', // 'auto'（一键排列）| 'custom'（自定义排列）
    tileMode: saved.tileMode, // 'grid'（宫格平铺）| 'over'（重叠平铺）
    scope: 'selection', // 'selection'（已选环境）| 'session'（当前同步会话）
    left: saved.custom.left, top: saved.custom.top,
    width: saved.custom.width, height: saved.custom.height,
    hs: saved.custom.hs, vs: saved.custom.vs, row: saved.custom.row,
    screenId: null, // null = 主屏；-1 = 全部屏幕
  };
  const el = h('div');
  const resBox = h('div');

  /** 自定义那 4 行（8 个数字框）每次改都落盘，切页/重进都还在 */
  function remember() {
    writeArrangePrefs({
      autoArrange: state.mode === 'auto',
      tileMode: state.tileMode,
      custom: {
        left: state.left, top: state.top, width: state.width, height: state.height,
        hs: state.hs, vs: state.vs, row: state.row,
      },
    });
  }

  function paint() {
    const a = state;
    const field = (label, ...inputs) => h('div', { class: 'row', style: { marginTop: '6px' } },
      h('span', { class: 'muted small', style: { minWidth: '56px' } }, label), ...inputs);
    const num = (key, { min = 0, max = 20000, w = '68px' } = {}) => h('input', {
      type: 'number', min, max, value: String(a[key]), style: { width: w },
      onInput: (e) => { a[key] = Number(e.target.value) || 0; remember(); },
    });

    const modeSel = h('select', {
      onChange: (e) => { a.mode = e.target.value; remember(); paint(); },
    },
      h('option', { value: 'auto', selected: a.mode === 'auto' }, '一键排列'),
      h('option', { value: 'custom', selected: a.mode === 'custom' }, '自定义排列'));

    /* 排列方式：宫格平铺 / 重叠平铺。两个模式都渲染；只有「重叠平铺」在
     * 「全部屏幕」时按对手行为不出现（跨屏拉满没有意义）。 */
    const kindRow = h('div', { class: 'row', style: { marginTop: '6px' } },
      h('span', { class: 'muted small', style: { minWidth: '56px' } }, '排列方式'),
      ...ARRANGE_KINDS
        .filter((k) => !(k.key === 'over' && a.screenId === -1))
        .map((k) => h('label', { class: 'row', style: { marginRight: '12px', cursor: 'pointer' } },
          h('input', {
            type: 'radio', name: 'fp-arrange-kind', checked: a.tileMode === k.key,
            onChange: () => { a.tileMode = k.key; remember(); paint(); },
          }),
          h('span', { class: 'muted small' }, k.label))));

    const scopeSel = h('select', {
      onChange: (e) => { a.scope = e.target.value; paint(); },
    },
      h('option', { value: 'selection', selected: a.scope === 'selection' }, '已选环境'),
      h('option', { value: 'session', selected: a.scope === 'session' }, '当前同步会话'));

    const displays = getDisplays() || [];
    const screenOpts = [];
    if (!displays.length) {
      // 没有桌面壳在管（命令行跑服务）时只有一项，并如实说明按原点算
      screenOpts.push(h('option', { value: 'primary', selected: a.screenId === null }, '内置屏幕'));
    } else {
      // 编号只给扩展屏用：主屏叫「内置屏幕」，其余按 1、2… 排（0.4.7.5）。
      // 老实现用数组下标，于是主屏也被叫成「扩展屏幕 1」，用户根本分不清哪块是主屏。
      let extIndex = 0;
      displays.forEach((d) => {
        const label = d.primary ? '内置屏幕' : `扩展屏幕 ${(extIndex += 1)}`;
        screenOpts.push(h('option', {
          value: String(d.id),
          selected: String(a.screenId) === String(d.id),
        }, `${label} ${d.work_area.width}×${d.work_area.height}`));
      });
      screenOpts.push(h('option', { value: '-1', selected: a.screenId === -1 }, '全部屏幕'));
    }
    const screenSel = h('select', {
      onChange: (e) => {
        const v = e.target.value;
        // 显示器 id 是系统给的不透明值（Windows 上是大整数），能原样保留就原样保留
        a.screenId = v === '-1' ? -1 : (v === 'primary' ? null : (/^-?\d+$/.test(v) ? Number(v) : v));
        // 「全部屏幕」下没有重叠平铺：把选择归回宫格，别让界面显示一个不会生效的选项
        if (a.screenId === -1) a.tileMode = 'grid';
        remember();
        paint();
      },
    }, ...screenOpts);

    mount(el,
      h('div', { class: 'row' },
        h('span', { class: 'muted small' }, '作用范围'), scopeSel,
        h('span', { class: 'muted small' }, a.scope === 'selection'
          ? `已选 ${selectionIds().length} 个环境（同步没开始时也能排列）`
          : '用当前同步会话里的窗口')),
      h('div', { class: 'row', style: { marginTop: '6px' } },
        h('span', { class: 'muted small' }, '排列模式'), modeSel,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary sm', onClick: () => run() }, '窗口排列')),
      kindRow,
      a.mode === 'custom'
        ? h('div', null,
          field('起始位置', num('left'), num('top')),
          field('窗口大小', num('width', { min: 516 }), num('height', { min: 200 })),
          field('窗口间距', num('hs'), num('vs')),
          field('窗口数量', num('row', { min: 0, max: 20, w: '56px' }), h('span', { class: 'muted small' }, '个/行')),
          field('显示器', screenSel))
        : h('div', null,
          field('显示器', screenSel)),
      h('div', { class: 'muted small', style: { marginTop: '6px' } },
        a.tileMode === 'over'
          ? '重叠平铺：窗口拉到工作区大小、按 30px 横向层叠（宽/高/间距/每行个数对它无效）'
          : (a.mode === 'auto'
            ? '根据显示器的分辨率自动排列所选窗口'
            : '跨屏同步：建议使用【自定义排列】设置相同的窗口大小')),
      resBox);
  }

  /** 「已选环境」是页面上勾选的那些运行中环境（两页各自提供，组件不自己猜） */
  function selectionIds() {
    if (!getSelectionIds) return [];
    try {
      const list = getSelectionIds();
      return Array.isArray(list) ? list.filter(Boolean).map(String) : [];
    } catch { return []; }
  }

  async function run() {
    const a = state;
    const ids = a.scope === 'selection' ? selectionIds() : [];
    const opts = {
      // 重叠平铺优先：它不看自定义的宽/高/间距（服务端按工作区算），但起始位置照样带过去
      mode: a.tileMode === 'over' ? 'over' : (a.mode === 'auto' ? 'grid' : 'custom'),
      screenId: a.screenId,
      ids,
      custom: a.mode === 'auto' ? null : {
        width: a.width, height: a.height, row: a.row, hs: a.hs, vs: a.vs,
        left: a.left, top: a.top, range: 0,
      },
    };
    try {
      const r = await runArrange(opts);
      const bad = (r?.placed || []).filter((x) => !x.ok);
      const warn = (r?.warnings || []).slice();
      const skipped = r?.skipped || [];
      toast(bad.length ? `有 ${bad.length} 个窗口没能排到位` : `已排列 ${r?.placed?.length ?? 0} 个窗口`, bad.length ? 'bad' : '');
      mount(resBox,
        bad.length
          ? h('div', { class: 'notice bad', style: { marginTop: '6px' } },
            h('strong', null, `有 ${bad.length} 个窗口没能排到位：`),
            ...bad.map((x) => h('div', { class: 'muted small' },
              `${nameOf(x.profile_id)}（${roleLabel(x.role)}）：${x.reason || '位置不符'}`)))
          : h('div', { class: 'muted small', style: { marginTop: '6px' } },
            `已排列 ${r?.placed?.length ?? 0} 个窗口${r?.auto ? `（每行 ${r.auto.cols} 个，${r.auto.width}×${r.auto.height}）` : ''}`),
        skipped.length
          ? h('div', { class: 'notice warn', style: { marginTop: '6px' } },
            ...skipped.map((x) => h('div', { class: 'muted small' },
              `${nameOf(x.profile_id)} 跳过了：${x.reason}`)))
          : null,
        warn.length
          ? h('div', { class: 'notice warn', style: { marginTop: '6px' } }, ...warn.map((w) => h('div', { class: 'muted small' }, w)))
          : null);
    } catch (e) {
      toast(e.message, 'bad');
      mount(resBox, h('div', { class: 'notice bad', style: { marginTop: '6px' } }, e.message));
    }
  }

  paint();
  return { el, refresh: () => paint(), compact };
}

/**
 * 角色文案：同步会话里有主/受控；解绑后按 id 动的那些窗口没有角色，就叫「窗口」。
 * 只有一处定义，两个区块共用（不各写一套）。
 */
function roleLabel(role) {
  if (role === 'master') return '主控';
  if (role === 'slave') return '受控';
  return '窗口';
}

/**
 * 显示窗口区块（`viewWin`）。
 *
 * **能力边界必须写在界面上**：最小化的窗口恢复后实测会真的到 OS 前台；
 * 只是被别的窗口盖住（没最小化）的窗口，零依赖只能把**页面**激活，窗口可能仍在后面。
 * 所以按钮下面那行小字是「恢复最小化并把窗口放到前面」，结果显示 `page_only` 时
 * 明确写「有 N 个窗口只做了页面级激活（可能仍被其它窗口盖住）」，不假装都到前面了。
 *
 * 作用范围与排列区块同源（0.4.7.4）：已选环境 / 当前同步会话。
 *
 * @param {{nameOf:(id:string)=>string, getSelectionIds?:()=>string[]}} opt
 * @returns {{el:HTMLElement}}
 */
export function buildShowPanel({ nameOf, getSelectionIds = null }) {
  const el = h('div');
  const resBox = h('div');
  const state = { scope: 'selection' };

  function selectionIds() {
    if (!getSelectionIds) return [];
    try {
      const list = getSelectionIds();
      return Array.isArray(list) ? list.filter(Boolean).map(String) : [];
    } catch { return []; }
  }

  function scopeRow(onChange) {
    const sel = h('select', {
      onChange: (e) => { state.scope = e.target.value; onChange(); },
    },
      h('option', { value: 'selection', selected: state.scope === 'selection' }, '已选环境'),
      h('option', { value: 'session', selected: state.scope === 'session' }, '当前同步会话'));
    return h('div', { class: 'row', style: { marginBottom: '6px' } },
      h('span', { class: 'muted small' }, '作用范围'), sel,
      h('span', { class: 'muted small' }, state.scope === 'selection'
        ? `已选 ${selectionIds().length} 个环境`
        : '用当前同步会话里的窗口'));
  }

  async function showAll() {
    const ids = state.scope === 'selection' ? selectionIds() : null;
    try {
      const r = await runShow(ids);
      const s = r?.summary || {};
      toast(s.message || '已显示', s.failed ? 'bad' : '');
      /* page_only 那批：给一个**显式**的补救按钮。默认绝不做「最小化→恢复」（会闪任务栏），
       * 但用户点这个按钮的意图就是「我现在要看见它」，所以必须给他一个能真做完的手段。 */
      const forceBox = h('div', { style: { marginTop: '6px' } });
      const pageOnlyIds = (r?.shown || []).filter((x) => x.ok && x.raise === 'page_only').map((x) => x.profile_id);
      mount(resBox,
        s.failed
          ? h('div', { class: 'notice bad', style: { marginTop: '6px' } },
            h('strong', null, s.message),
            ...(s.details || []).map((x) => h('div', { class: 'muted small' },
              `${nameOf(x.profile_id)}（${roleLabel(x.role)}）：${x.reason || '没显示出来'}`)))
          : h('div', { class: 'muted small', style: { marginTop: '6px' } }, s.message),
        s.ok && s.page_only
          ? h('div', { class: 'notice warn', style: { marginTop: '6px' } },
            `有 ${s.page_only} 个窗口只做了页面级激活（可能仍被其它窗口盖住）。`
            + '最小化的窗口会真的到前台；没最小化、只是被盖住的，当前版本抬不上来。')
          : null,
        pageOnlyIds.length ? forceBox : null);
      if (pageOnlyIds.length) {
        mount(forceBox, h('button', {
          class: 'btn sm',
          onClick: () => forceShow(forceBox, pageOnlyIds),
        }, '强制抬到前台（会闪一下）'));
      }
    } catch (e) {
      toast(e.message, 'bad');
      mount(resBox, h('div', { class: 'notice bad', style: { marginTop: '6px' } }, e.message));
    }
  }

  /**
   * 强制抬到前台：**一次性动作，不写设置、不做开关**。
   *
   * 手段是「最小化 → 恢复」，零依赖下唯一能真的把被盖住的窗口抬到 OS 前台的办法
   * （实测会到前台，代价是任务栏闪一下、每个窗口 0.6–1.0 秒）。
   * 产品里不调 Win32，所以**能确认的只有「窗口已恢复正常」，确认不了「它在最前面」** ——
   * 文案因此是「已恢复显示并尝试置前」，不是「已置前」。
   */
  async function forceShow(box, ids) {
    try {
      const r = await api.syncShowForce(ids);
      const s = r?.summary || {};
      toast(s.message || '已恢复显示', s.failed ? 'bad' : '');
      mount(box,
        s.failed
          ? h('div', { class: 'notice bad', style: { marginTop: '6px' } },
            h('strong', null, s.message),
            ...(s.details || []).map((x) => h('div', { class: 'muted small' },
              `${nameOf(x.profile_id)}（${roleLabel(x.role)}）：${x.reason || '未能确认'}`)))
          : h('div', { class: 'muted small', style: { marginTop: '6px' } },
            `${s.message}。窗口已恢复正常显示；这一版确认不了它是否在最前面。`));
    } catch (e) {
      toast(e.message, 'bad');
      mount(box, h('div', { class: 'notice bad', style: { marginTop: '6px' } }, e.message));
    }
  }

  function paint() {
    mount(el,
      scopeRow(paint),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary sm', onClick: showAll }, '显示窗口'),
        h('span', { class: 'muted small' }, '恢复最小化的窗口，并把它放到前面')),
      resBox);
  }
  paint();
  return { el, refresh: paint };
}