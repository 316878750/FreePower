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
  const state = {
    mode: 'auto', // 'auto'（一键排列）| 'custom'（自定义排列）
    scope: 'selection', // 'selection'（已选环境）| 'session'（当前同步会话）
    left: 0, top: 0, width: 1000, height: 700, hs: 0, vs: 0, row: 2,
    screenId: null, // null = 主屏；-1 = 全部屏幕
  };
  const el = h('div');
  const resBox = h('div');

  function paint() {
    const a = state;
    const field = (label, ...inputs) => h('div', { class: 'row', style: { marginTop: '6px' } },
      h('span', { class: 'muted small', style: { minWidth: '56px' } }, label), ...inputs);
    const num = (key, { min = 0, max = 20000, w = '68px' } = {}) => h('input', {
      type: 'number', min, max, value: String(a[key]), style: { width: w },
      onInput: (e) => { a[key] = Number(e.target.value) || 0; },
    });

    const modeSel = h('select', {
      onChange: (e) => { a.mode = e.target.value; paint(); },
    },
      h('option', { value: 'auto', selected: a.mode === 'auto' }, '一键排列'),
      h('option', { value: 'custom', selected: a.mode === 'custom' }, '自定义排列'));

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
      displays.forEach((d, i) => {
        screenOpts.push(h('option', {
          value: String(d.id),
          selected: String(a.screenId) === String(d.id),
        }, `${d.primary ? '内置屏幕' : `扩展屏幕 ${i}`} ${d.work_area.width}×${d.work_area.height}`));
      });
      screenOpts.push(h('option', { value: '-1', selected: a.screenId === -1 }, '全部屏幕'));
    }
    const screenSel = h('select', {
      onChange: (e) => {
        const v = e.target.value;
        a.screenId = v === '-1' ? -1 : (v === 'primary' ? null : Number(v));
      },
    }, ...screenOpts);

    mount(el,
      h('div', { class: 'row' },
        h('span', { class: 'muted small' }, '作用范围'), scopeSel,
        h('span', { class: 'muted small' }, a.scope === 'selection'
          ? `已选 ${selectionIds().length} 个环境（同步没开始时也能排列）`
          : '用当前同步会话里的窗口')),
      h('div', { class: 'row', style: { marginTop: '6px' } },
        h('span', { class: 'muted small' }, '排列方式'), modeSel,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary sm', onClick: () => run() }, '窗口排列')),
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
        a.mode === 'auto'
          ? '根据显示器的分辨率自动排列所选窗口'
          : '跨屏同步：建议使用【自定义排列】设置相同的窗口大小'),
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
    const ids = a.scope === 'selection' ? selectionIds() : null;
    const body = a.mode === 'auto'
      ? { auto: true, screenId: a.screenId === null ? undefined : a.screenId }
      : {
        width: a.width, height: a.height, row: a.row, hs: a.hs, vs: a.vs,
        left: a.left, top: a.top, range: 0,
        screenId: a.screenId === null ? undefined : a.screenId,
      };
    if (ids) body.ids = ids;
    try {
      const r = await api.syncArrange(body);
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
      const r = await api.syncShow(ids || undefined);
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
