/**
 * 窗口同步（0.4.7.5 布局：照逆向 `31-窗口同步页布局规格.md` 重排）。
 *
 * 骨架是**两列**，不是竖排卡片：
 *   顶部操作条（高 40 + 下间距 12）
 *   ├─ 左：窗口列表表格卡（flex:1, min-width 540, 圆角 8）
 *   └─ 右：操作台卡（480 定宽）：标题条 60 → tabs 32 → 内容 padding 16
 *
 * 三条硬口径（CEO 定的，改版时别丢）：
 *   1. **不摆假控件**：AI 自动操作 / 外观颜色 / 仿真速度 / 文本组 / 帮助中心 —— 我们没有对应能力，
 *      一律不渲染。判据里有一条专门扫这个（`test/sync-layout.test.mjs`）。
 *   2. 表格三态：`同步中(主控)` / `同步中` / `-`；未同步时显示 `主控窗口` / `被控窗口` / `-`。
 *      **表格里没有「同步异常」** —— 逆向确认那三个 i18n 键在页面 chunk 里零引用。
 *   3. 少于 2 个选中时「启动同步」**不置灰**（对手实测就是不置灰），点了给 toast 文案。
 *
 * 能力边界照旧写在界面上：窗口尺寸不一致时坐标按视口比例映射会点偏，顶部会显著提示。
 */
import { h, mount, toast } from '../ui.js';
import { api } from '../api.js';
import { runArrange, runShow } from '../sync-widgets.js';
/* 排列方式的选项与「自定义排列 4 个字段」的记忆：与操作台组件共用同一份（web/sync-prefs.js），
 * 页面不自己写一份选项、也不自己拼一套存储。 */
import { ARRANGE_KINDS, readArrangePrefs, writeArrangePrefs } from '../sync-prefs.js';

const state = {
  running: [],
  profiles: new Map(),
  groups: [],
  groupId: '',
  selected: new Set(),
  masterId: '',
  settings: {
    input: true, click: true, scroll: true, move: true,
    text_sync: true, typing: false, paste: true, random_number: false,
    typing_min_ms: 30, typing_max_ms: 120, random_min: 1000, random_max: 9999,
    same_tab: true, current_tab_url: false,
    delay_ms: 0, jitter_ms: 0,
  },
  status: null,
  displays: [],
  tab: 'windows',       // 'windows' | 'tabs'
  autoArrange: true,    // 「根据显示器的分辨率自动排列」开关：开=一键排列，关=自定义排列
  tileMode: 'grid',     // 排列方式：'grid' 宫格平铺 / 'over' 重叠平铺（两个模式下都渲染）
  custom: { left: 0, top: 0, width: 500, height: 200, hs: 0, vs: 0, row: 3 },
  screenId: null,
  timer: null,
  busy: false,
};

/* 自定义排列那 4 行（8 个数字框）与两个开关的偏好：切页/退出重进都还在。
 * 存储口径沿用仓库既有约定（`fp.view_density` 那一套），只写 localStorage，不写库。 */
{
  const saved = readArrangePrefs();
  state.autoArrange = saved.autoArrange;
  state.tileMode = saved.tileMode;
  state.custom = { ...saved.custom };
}

/** 把当前排列偏好落盘（每次改都调，不做防抖：这几个框改得很稀疏） */
function rememberArrange() {
  writeArrangePrefs({
    autoArrange: state.autoArrange,
    tileMode: state.tileMode,
    custom: { ...state.custom },
  });
}

/** 桌面壳只通过 preload 暴露 `openSyncPanel()`（见 desktop/preload.cjs）；纯网页里没有这个对象 */
function desktopBridge() {
  const d = (typeof window !== 'undefined' && window.fpDesktop) || null;
  return d && d.isDesktop === true ? d : null;
}

export default async function renderSync({ head, page }) {
  clearInterval(state.timer);
  document.body.classList.add('sync-mode');
  document.getElementById('page')?.classList.add('sync-page');

  const topBar = h('div', { class: 'sync-top' });
  const warnBar = h('div', { class: 'sync-warn' });
  const tableCard = h('div', { class: 'sync-table-card' });
  const operateCard = h('div', { class: 'sync-operate-card' });
  const wrap = h('div', { class: 'sync-wrap' }, tableCard, operateCard);

  mount(head, h('h1', null, '窗口同步'));
  mount(page, topBar, warnBar, wrap);

  /* ---------------------- 派生数据（必须在第一个 await 之前） ----------------------
   * 0.4.7.7 的线上事故：这几行原来在 `reload(true)` 后面，而 `renderSync` 是 async 函数，
   * `await reload(true)` 一挂起，续体里的 `paintAll()` 就会先读 `isRunning` ——
   * 那时 `const` 还没执行到，直接 `Cannot access 'isRunning' before initialization`（TDZ），
   * 整页只剩「出错了」。所以：凡是 paintAll / paintTop / tick 用到的派生函数，
   * 一律在第一个 await 之前定义，也不要写成「先 await 再 paint」。
   * 判据见 test/sync-page-import.test.mjs（用真 ESM 把整页跑一遍）。 */
  const running = () => state.running.filter((r) => !state.groupId || String(state.profiles.get(r.id)?.group_id ?? '0') === state.groupId);
  const nameOf = (id) => state.profiles.get(id)?.name || id;
  const groupNameOf = (id) => {
    const gid = String(state.profiles.get(id)?.group_id ?? '0');
    return state.groups.find((g) => g.id === gid)?.name || '未分组';
  };
  const selectedIds = () => [...state.selected];
  const isRunning = () => state.status?.running === true;

  await reload(true);
  paintAll();

  state.timer = setInterval(() => { tick().catch(() => {}); }, 1000);
  window.addEventListener('hashchange', () => {
    clearInterval(state.timer);
    document.body.classList.remove('sync-mode');
    document.getElementById('page')?.classList.remove('sync-page');
  }, { once: true });

  /* ------------------------------ 数据 ------------------------------ */

  async function reload(full = false) {
    try {
      if (full) {
        const [run, list, groups] = await Promise.all([
          api.running().catch(() => ({ list: [] })),
          api.list({ page: 1, page_size: 500 }).catch(() => ({ list: [] })),
          api.groups().catch(() => ({ list: [] })),
        ]);
        state.running = (run?.list || []).map((r) => ({ id: r.profile_id || r.id })).filter((r) => r.id);
        state.profiles = new Map((list?.list || []).map((p) => [p.profile_id, p]));
        state.groups = (groups?.list || []).map((g) => ({ id: String(g.group_id ?? g.id ?? ''), name: g.group_name || g.name || '' }));
        const alive = new Set(state.running.map((r) => r.id));
        for (const id of [...state.selected]) if (!alive.has(id)) state.selected.delete(id);
        if (state.masterId && !alive.has(state.masterId)) state.masterId = '';
        const displays = await api.syncDisplays().catch(() => null);
        state.displays = Array.isArray(displays?.displays) ? displays.displays : [];
      }
      state.status = await api.syncStatus().catch(() => null);
      if (state.status?.running) {
        state.masterId = state.status.master_id || state.masterId;
        for (const id of state.status.slave_ids || []) state.selected.add(id);
        if (state.masterId) state.selected.add(state.masterId);
        state.settings = { ...state.settings, ...(state.status.settings || {}) };
      }
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

  async function tick() {
    const st = await api.syncStatus().catch(() => null);
    if (!st) return;
    state.status = st;
    paintTop();
    paintWarn();
    paintTable();
  }

  function paintAll() {
    paintTop();
    paintWarn();
    paintTable();
    paintOperate();
  }

  /* ------------------------------ 顶部操作条 ------------------------------ */

  function paintTop() {
    const groupSel = h('select', {
      class: 'sync-groups',
      onChange: (e) => { state.groupId = e.target.value; paintTable(); },
    },
      h('option', { value: '', selected: state.groupId === '' }, '全部分组'),
      ...state.groups.map((g) => h('option', { value: g.id, selected: state.groupId === g.id }, g.name)));

    const startBtn = isRunning()
      ? h('button', { class: 'sync-btn sync-btn-stop', onClick: stop }, '停止同步 (Ctrl+Alt+D)')
      : h('button', { class: 'sync-btn sync-btn-start', onClick: start }, '启动同步');

    const restartBtn = h('button', {
      class: 'sync-btn sync-btn-text', disabled: !isRunning(),
      title: '用当前配置重新开始（停止 → 开始），不用重选窗口',
      onClick: () => restart(),
    }, '重启同步');

    const n = state.selected.size;
    const selChip = n
      ? h('span', { class: 'sync-sel' },
        `已选 ${n} 列`,
        h('button', {
          class: 'sync-sel-clear', title: '清空选择',
          onClick: () => { state.selected.clear(); paintTop(); paintTable(); },
        }, '✕'))
      : null;

    const gear = h('button', {
      class: 'sync-gear', title: '同步设置', onClick: () => openSettings(),
    }, '⚙');

    mount(topBar,
      h('div', { class: 'sync-top-left' }, groupSel, startBtn, restartBtn, selChip),
      h('div', { class: 'sync-top-right' }, gear));
  }

  /* ------------------------------ 左：窗口列表 ------------------------------ */

  function paintTable() {
    const list = running();
    if (!list.length) {
      mount(tableCard, h('div', { class: 'sync-empty' },
        h('div', { class: 'sync-empty-title' }, '暂无已打开的浏览器环境'),
        h('div', { class: 'sync-empty-sub' }, '打开2个浏览器，即开启窗口同步操作'),
        h('button', {
          class: 'sync-empty-link',
          onClick: () => { location.hash = '#/profiles'; },
        }, '前往打开')));
      return;
    }

    const cols = [40, 100, 100, 80, 90, 160, 100];
    /* 同步运行中**列表勾选被锁**（31 号文 §12 更正 3 实测的对手行为）：点了不生效。
     * 我们做成 disabled + tooltip 说明，不静默失效 —— 用户得知道为什么点不动。 */
    const locked = isRunning();
    const lockTip = locked ? '同步进行中，停止同步后才能修改选择' : '';
    const headRow = h('tr', null,
      h('th', { class: 'sync-col-check' }, h('input', {
        type: 'checkbox',
        checked: list.length > 0 && list.every((r) => state.selected.has(r.id)),
        disabled: locked,
        title: lockTip,
        onChange: (e) => {
          if (locked) return;
          state.selected.clear();
          if (e.target.checked) for (const r of list) state.selected.add(r.id);
          paintTop(); paintTable();
        },
      })),
      h('th', null, '序号'),
      h('th', null, '环境编号'),
      h('th', null, '分组'),
      h('th', null, '环境名称'),
      h('th', null, '状态'),
      h('th', { class: 'sync-col-op' }, '操作'));

    const rows = list.map((r, i) => {
      const p = state.profiles.get(r.id) || {};
      const isMaster = state.masterId === r.id;
      const isSel = state.selected.has(r.id);
      const tr = h('tr', {
        class: `${isMaster ? 'is-main' : ''}${i % 2 === 1 ? ' is-alt' : ''}`,
        onClick: (e) => {
          // 点行（不是点按钮/勾选框）= 切换这一行的选中；同步中锁住
          if (e.target && /^(INPUT|BUTTON|svg|path)$/i.test(e.target.tagName || '')) return;
          if (locked) return;
          if (state.selected.has(r.id)) state.selected.delete(r.id);
          else state.selected.add(r.id);
          paintTop(); paintTable();
        },
      },
        h('td', { class: 'sync-col-check' }, h('input', {
          type: 'checkbox', checked: isSel,
          disabled: locked,
          title: lockTip,
          onChange: (e) => {
            if (locked) return;
            if (e.target.checked) state.selected.add(r.id);
            else state.selected.delete(r.id);
            paintTop(); paintTable();
          },
        })),
        h('td', null, String(i + 1)),
        h('td', null, String(p.profile_no ?? r.id.slice(0, 8))),
        h('td', { class: 'sync-ellipsis' }, groupNameOf(r.id)),
        h('td', { class: 'sync-ellipsis', title: nameOf(r.id) }, nameOf(r.id)),
        h('td', null, statusCell(r.id)),
        h('td', { class: 'sync-col-op' },
          h('div', { class: 'sync-ops' },
            h('button', {
              class: `sync-icon${isMaster ? ' is-on' : ''}`, title: '设为主控',
              onClick: () => { state.masterId = r.id; state.selected.add(r.id); paintTop(); paintTable(); },
            }, '◉'),
            h('button', {
              class: 'sync-icon', title: '显示窗口',
              onClick: () => showOne(r.id),
            }, '⤢'))));
      return tr;
    });

    mount(tableCard,
      h('div', { class: 'sync-table-scroll' },
        h('table', { class: 'sync-table' },
          h('colgroup', null, ...cols.map((w, i) => h('col', {
            style: { width: `${w}px` },
            class: i === 6 ? 'sync-col-op' : '',
          }))),
          h('thead', null, headRow),
          h('tbody', null, ...rows))),
      // 会话读数条：表格底部一条，不占操作台的位（规格里没有它，但这两个读数
      // 「被开关拦下多少 / 文本发了多少」是用户判断「同步到底有没有在干活」的唯一依据，
      // 改版不能把它弄丢）。它不是控件，只是读数。
      isRunning() ? h('div', { class: 'sync-foot' },
        `已转发 ${state.status?.events ?? 0} 条`,
        `　被开关拦下 ${state.status?.dropped ?? 0} 条`,
        `　文本已发 ${state.status?.text_sent ?? 0} / 按策略吞掉 ${state.status?.text_swallowed ?? 0}`,
        `　已发出 ${state.status?.scheduler?.sent ?? 0} / 待发 ${state.status?.scheduler?.pending ?? 0}`,
        state.status?.binding_name ? `　binding ${state.status.binding_name}` : '')
        : null,
      /* 0.4.7.11：抓不到输入时**必须说出来**。
       * 用户报「同步没反应」时，界面一片「同步中」是最坑的 —— 他没有任何线索知道
       * 是主窗口的标签被切走/关掉了，还是引擎坏了。服务端算好的人话提示直接摆在这里。 */
      isRunning() && state.status?.hint
        ? h('div', { class: 'notice warn', style: { margin: '8px 12px' } }, state.status.hint)
        : null,
      /* 31 号文 §12 更正 3 第二条：同步启动后才打开的环境**不会**自动加入。
       * 我们本来就是启动时固定窗口集，但必须**在界面上说出来** —— 否则用户会以为新开的环境加进去了。 */
      isRunning() ? h('div', { class: 'sync-hint' },
        '同步启动后才打开的环境不会自动加入本次同步；需要停止同步后重新开始') : null);
  }

  /** 状态列三态（表格里**没有**「同步异常」，那是操作台的） */
  function statusCell(id) {
    const isMaster = state.masterId === id;
    const isSel = state.selected.has(id);
    if (isRunning()) {
      if (isMaster) return h('span', { class: 'sync-st-main' }, h('span', { class: 'sync-st-icon' }, '◉'), '同步中(主控)');
      if (isSel) return h('span', { class: 'sync-st-syncing' }, '同步中');
      return h('span', { class: 'sync-st-idle' }, '-');
    }
    if (isMaster) return h('span', { class: 'sync-st-main' }, '主控窗口');
    if (isSel) return h('span', { class: 'sync-st-charge' }, '被控窗口');
    return h('span', { class: 'sync-st-idle' }, '-');
  }

  /* ------------------------------ 右：操作台 ------------------------------ */

  function paintOperate() {
    const desktop = desktopBridge();
    const headBar = h('div', { class: 'sync-console-head' },
      h('span', { class: 'sync-console-title' }, '操作台'),
      desktop
        ? h('button', {
          class: 'sync-widget-btn', title: '打开桌面小组件（独立置顶小窗）',
          onClick: () => openConsole(desktop),
        }, '桌面小组件')
        // 没有桌面壳时**不摆按钮**（不放假开关），但要把原因写在原来的位置
        : h('span', { class: 'sync-tip' }, '桌面版才有操作台'));

    const tabBtn = (key, label) => h('button', {
      class: `sync-tab${state.tab === key ? ' is-active' : ''}`,
      onClick: () => { state.tab = key; paintOperate(); },
    }, label);

    const body = h('div', { class: 'sync-console-body' },
      state.tab === 'windows' ? windowsTab() : tabsTab());

    mount(operateCard, headBar,
      h('div', { class: 'sync-tabs' }, tabBtn('windows', '窗口管理'), tabBtn('tabs', '标签管理')),
      body);
  }

  /**
   * 窗口管理 tab（照 31 号文 §11 更正后的形态）：
   *   ① 显示窗口 / 统一大小 —— 同一行、各占 50%、高 40（统一大小未同步时 disabled）
   *   ② 窗口排列 → 显示器卡片
   *   ③ 「根据显示器的分辨率自动排列所选窗口」= **开关**：
   *      开 → 大按钮 `一键排列 (Ctrl+Alt+Z)`（排列方式只剩宫格平铺，单选项不摆 radio）
   *      关 → 大按钮变 `自定义排列 (Ctrl+Alt+Z)`，按钮**上方内联展开 4 行字段**
   */
  function windowsTab() {
    const displays = state.displays || [];
    let ext = 0;
    const cards = displays.length
      ? displays.map((d) => {
        const label = d.primary ? '内置屏幕' : `扩展屏幕 ${(ext += 1)}`;
        const on = state.screenId === null ? d.primary === true : String(state.screenId) === String(d.id);
        return h('button', {
          class: `sync-screen${on ? ' is-active' : ''}`,
          onClick: () => { state.screenId = d.primary ? null : d.id; paintOperate(); },
        },
          h('div', { class: 'sync-screen-name' }, label),
          h('div', { class: 'sync-screen-size' }, `${d.work_area.width}×${d.work_area.height}`));
      })
      : [h('button', {
        class: 'sync-screen is-active',
        onClick: () => { state.screenId = null; paintOperate(); },
      }, h('div', { class: 'sync-screen-name' }, '内置屏幕'),
      h('div', { class: 'sync-screen-size' }, '按原点 (0,0) 计算'))];

    const autoOn = state.autoArrange;
    const customRows = autoOn ? null : customFields();

    /* 排列方式：宫格平铺 / 重叠平铺。**两个模式下都一直渲染**（31 号文 §12 更正 2：
     * 「仅自动模式显示」那条是错的）。唯一显隐规则：显示器选「全部屏幕」时重叠平铺不出现
     * —— 跨屏拉满没意义，对手那边也是这个行为。只剩一个选项时不摆 radio，直接写文字。 */
    const kinds = ARRANGE_KINDS.filter((k) => !(k.key === 'over' && state.screenId === -1));
    const kindRow = kinds.length > 1
      ? h('div', { class: 'sync-kinds' },
        h('span', { class: 'sync-custom-label' }, '排列方式'),
        ...kinds.map((k) => h('label', { class: 'sync-kind' },
          h('input', {
            type: 'radio', name: 'sync-tile-mode', checked: state.tileMode === k.key,
            onChange: () => { state.tileMode = k.key; rememberArrange(); paintOperate(); },
          }),
          h('span', null, k.label))))
      : h('div', { class: 'sync-kinds' },
        h('span', { class: 'sync-custom-label' }, '排列方式'),
        h('span', { class: 'sync-tip' }, kinds[0]?.label || '宫格平铺'));

    return h('div', { class: 'sync-tab-body' },
      // ① 一行两个等宽按钮（不是设置项、不是开关）
      h('div', { class: 'sync-grid-row' },
        h('button', { class: 'sync-grid-btn', onClick: () => showSelected() }, '显示窗口'),
        h('button', {
          class: 'sync-grid-btn',
          disabled: !isRunning(),
          title: '所选窗口跟主控窗口大小一致',
          onClick: () => unifySize(),
        }, '统一大小')),
      h('div', { class: 'sync-section-title' }, '窗口排列'),
      h('div', { class: 'sync-screens' }, ...cards),
      // ② 自动排列开关：这就是 rangeTips 那行
      h('label', { class: 'sync-switch' },
        h('input', {
          type: 'checkbox', checked: autoOn,
          onChange: (e) => { state.autoArrange = e.target.checked; rememberArrange(); paintOperate(); },
        }),
        h('span', { class: 'sync-switch-dot' }),
        h('span', { class: 'sync-tip' }, '根据显示器的分辨率自动排列所选窗口')),
      kindRow,
      customRows,
      state.tileMode === 'over'
        ? h('div', { class: 'sync-tip' }, '重叠平铺：窗口拉到工作区大小、按 30px 横向层叠（宽/高/间距/每行个数对它无效）')
        : null,
      h('div', { class: 'sync-row' },
        h('button', {
          class: 'sync-btn sync-btn-start sync-btn-wide',
          onClick: () => arrange(autoOn ? undefined : readCustom()),
        }, autoOn ? '一键排列 (Ctrl+Alt+Z)' : '自定义排列 (Ctrl+Alt+Z)')));
  }

  /**
   * 自定义排列的 4 行字段（顺序固定，只有第 4 行有单位）：
   *   起始位置 X / Y · 窗口大小 宽 / 高 · 窗口间距 横向 / 纵向 · 窗口数量 个/行
   * 改完**不会自动重排**，必须点按钮（对手实测行为）。
   */
  function customFields() {
    const a = state.custom;
    const num = (key, { min = -9999, max = 9999 } = {}) => h('input', {
      type: 'number', min, max, value: String(a[key]),
      onInput: (e) => { a[key] = Number(e.target.value) || 0; rememberArrange(); },
    });
    const row = (label, ...kids) => h('div', { class: 'sync-custom-row' },
      h('span', { class: 'sync-custom-label' }, label), ...kids);
    const pre = (t) => h('span', { class: 'sync-custom-pre' }, t);
    return h('div', { class: 'sync-custom' },
      row('起始位置', pre('X'), num('left'), pre('Y'), num('top')),
      row('窗口大小', pre('宽'), num('width', { min: 0 }), pre('高'), num('height', { min: 0 })),
      row('窗口间距', pre('横向'), num('hs', { min: -999, max: 999 }), pre('纵向'), num('vs', { min: -999, max: 999 })),
      row('窗口数量', num('row', { min: 0, max: 10000 }), h('span', { class: 'sync-custom-pre' }, '个/行')));
  }

  function readCustom() {
    const a = state.custom;
    return { width: a.width, height: a.height, row: a.row, hs: a.hs, vs: a.vs, left: a.left, top: a.top, range: 0 };
  }

  /** 标签管理 tab：全部打既有路由（`/sync/tab*`），没有一个控件是摆设 */
  function tabsTab() {
    const urlInput = h('textarea', {
      rows: 3, placeholder: '请输入网址，每行一个，示例：\nwww.google.com\nwww.facebook.com',
    });
    const act = (label, fn) => h('button', { class: 'sync-link', onClick: () => runTab(fn) }, label);
    /* 「打开」走一个具名函数：它比别的动作多一道「最多 10 个」的前端预检 */
    const openUrls = () => {
      const list = String(urlInput.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (list.length > 10) return Promise.reject(new Error('一键最多打开10个网址'));
      return api.syncOpenTab(list);
    };
    return h('div', { class: 'sync-tab-body' },
      h('label', { class: 'sync-check' },
        h('input', {
          type: 'checkbox', checked: (state.settings.current_tab_url ?? false) === true,
          onChange: (e) => applySettings({ current_tab_url: e.target.checked }),
        }),
        h('span', null, '首个网址在当前标签页打开')),
      h('div', { class: 'sync-row' }, urlInput, act('打开', openUrls)),
      h('div', { class: 'sync-tip' }, '每行一个，最多 10 个'),
      h('div', { class: 'sync-row' },
        act('统一标签页', () => api.syncUnifyTabs()),
        act('关闭其他', () => api.syncCloseTabs('others')),
        act('关闭当前标签页', () => api.syncCloseTabs('current')),
        act('关闭空白标签页', () => api.syncCloseTabs('blank'))),
      h('div', { class: 'sync-row' }, act('复制当前标签到其它窗口', () => api.syncCopyTab())));
  }

  /* ------------------------------ 动作 ------------------------------ */

  async function openConsole(desktop) {
    try {
      const r = await desktop.openSyncPanel();
      if (r && r.ok === false) toast(r.error || '操作台没能打开', 'bad');
    } catch (e) { toast(e.message, 'bad'); }
  }

  /** 排列：作用在**已选环境**上（同步没开始也能用），不传 ids 时服务端用会话 */
  async function arrange(custom) {
    const ids = selectedIds();
    // 重叠平铺优先于「一键/自定义」：它的尺寸由工作区算，自定义的宽/高对它无效
    const mode = state.tileMode === 'over' ? 'over' : (custom ? 'custom' : 'grid');
    // 请求体与调用都只由 sync-widgets 的 runArrange 负责（两处界面共用，不各拼一份）
    const opts = {
      mode,
      screenId: state.screenId,
      ids,
      custom: custom ? { ...custom } : null,
    };
    try {
      const r = await runArrange(opts);
      const bad = (r?.placed || []).filter((x) => !x.ok);
      const skipped = r?.skipped || [];
      const warn = r?.warnings || [];
      toast(bad.length ? `有 ${bad.length} 个窗口没能排到位` : `已排列 ${r?.placed?.length ?? 0} 个窗口`, bad.length ? 'bad' : '');
      if (skipped.length) toast(`${skipped.length} 个窗口跳过：${skipped[0].reason}`, 'bad');
      if (warn.length) toast(warn[0], 'bad');
    } catch (e) { toast(e.message, 'bad'); }
  }

  function currentWorkArea() {
    const list = state.displays || [];
    if (!list.length) return { x: 0, y: 0, width: 1280, height: 800 };
    const hit = state.screenId === null
      ? (list.find((d) => d.primary === true) || list[0])
      : (list.find((d) => String(d.id) === String(state.screenId)) || list.find((d) => d.primary === true) || list[0]);
    const a = hit.work_area || {};
    return { x: a.x || 0, y: a.y || 0, width: a.width || 1280, height: a.height || 800 };
  }

  async function showSelected() {
    const ids = selectedIds();
    if (!ids.length) { toast('先勾选要显示的窗口', 'bad'); return; }
    try {
      const r = await runShow(ids);
      const s = r?.summary || {};
      toast(s.message || '已显示', s.failed ? 'bad' : '');
    } catch (e) { toast(e.message, 'bad'); }
  }

  async function showOne(id) {
    try {
      const r = await runShow([id]);
      const s = r?.summary || {};
      toast(s.message || '已显示', s.failed ? 'bad' : '');
    } catch (e) { toast(e.message, 'bad'); }
  }

  async function unifySize() {
    if (!isRunning()) { toast('先启动同步，再统一大小', 'bad'); return; }
    try {
      const r = await api.syncUnifySize();
      const bad = (r?.resized || []).filter((x) => !x.ok);
      // 失败数如实显示：优先用服务端算好的 summary.message，不自己拼「成功」
      const msg = r?.summary?.message || (bad.length ? `有 ${bad.length} 个窗口没能改成同尺寸` : '已统一大小');
      toast(bad.length ? `${msg}：${bad[0].reason || ''}` : msg, bad.length ? 'bad' : '');
      await reload(false);
      paintAll();
    } catch (e) { toast(e.message, 'bad'); }
  }

  /** 尺寸不一致的显著提示（0.4.7.4 的要求，改版不许丢）：顶部一条 + 一键统一尺寸 */
  function paintWarn() {
    const st = state.status;
    if (!st?.running || !st.size_mismatch) { mount(warnBar); return; }
    const sizes = (st.windows || []).filter((w) => w.window?.width)
      .map((w) => `${w.role === 'master' ? '主' : '受控'}=${w.window.width}×${w.window.height}`).join('，');
    mount(warnBar, h('div', { class: 'sync-warn-inner' },
      h('strong', null, '窗口尺寸不一致：'),
      `各窗口实际尺寸 ${sizes}。坐标按视口比例映射，响应式页面会点偏。`,
      h('button', { class: 'sync-btn sync-btn-start', style: { marginLeft: '12px' }, onClick: () => unifySize() }, '一键统一尺寸')));
  }

  async function runTab(fn) {
    if (!isRunning()) { toast('先启动同步', 'bad'); return; }
    try {
      await fn();
      toast('完成');
    } catch (e) { toast(e.message, 'bad'); }
  }

  async function start() {
    if (!state.running.length) { toast('暂无已打开的浏览器环境', 'bad'); return; }
    if (state.selected.size < 2) { toast('请选择至少两个浏览器进行操作', 'bad'); return; }
    const ids = selectedIds();
    const master = state.masterId && state.selected.has(state.masterId) ? state.masterId : ids[0];
    state.busy = true;
    try {
      state.status = await api.syncStart({
        master_id: master,
        slave_ids: ids.filter((id) => id !== master),
        settings: state.settings,
      });
      toast('同步已启动');
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      state.busy = false;
      await reload(false);
      paintAll();
    }
  }

  async function stop() {
    state.busy = true;
    try {
      await api.syncStop();
      toast('已停止');
    } catch (e) { toast(e.message, 'bad'); }
    finally {
      state.busy = false;
      await reload(false);
      paintAll();
    }
  }

  async function restart() {
    state.busy = true;
    try {
      state.status = await api.syncRestart();
      toast('同步已重启');
    } catch (e) { toast(e.message, 'bad'); }
    finally {
      state.busy = false;
      await reload(false);
      paintAll();
    }
  }

  async function applySettings(patch) {
    state.settings = { ...state.settings, ...patch };
    if (!isRunning()) {
      try {
        const r = await api.saveSyncDefaults(patch);
        state.settings = { ...state.settings, ...(r?.settings || {}) };
        toast('已存为默认设置，启动同步时生效');
      } catch (e) { toast(`保存失败：${e.message}`, 'bad'); }
      return;
    }
    try {
      const r = await api.syncSettings(patch);
      state.settings = { ...state.settings, ...(r?.settings || {}) };
      toast('已生效');
    } catch (e) { toast(e.message, 'bad'); }
  }

  /**
   * ⚙ 设置：只摆**真有的**三组 —— 同步（键盘/鼠标→点击/滚动/轨迹）、
   * 文本输入（相同文本/粘贴/模拟人工/随机数字 + 间隔）、延迟。
   * 对手的「外观颜色」「仿真输入/点击速度」引擎没有对应能力，这里**不摆**。
   */
  function openSettings() {
    const sw = (key, label, hint) => h('label', { class: 'sync-check' },
      h('input', {
        type: 'checkbox', checked: (state.settings[key] ?? true) === true,
        onChange: (e) => applySettings({ [key]: e.target.checked }),
      }),
      h('span', null, label),
      hint ? h('span', { class: 'sync-tip' }, hint) : null);
    const num = (key, min, max) => h('input', {
      type: 'number', min, max, value: String(state.settings[key] ?? 0), style: { width: '84px' },
      onChange: (e) => applySettings({ [key]: Number(e.target.value) || 0 }),
    });
    const close = () => overlay.remove();
    const overlay = h('div', { class: 'sync-overlay', onClick: (e) => { if (e.target === overlay) close(); } },
      h('div', { class: 'sync-dialog' },
        h('div', { class: 'sync-dialog-head' }, h('span', null, '同步设置'),
          h('button', { class: 'sync-sel-clear', onClick: close }, '✕')),
        h('div', { class: 'sync-dialog-body' },
          h('div', { class: 'sync-section-title' }, '同步'),
          sw('move', '鼠标移动', '按 30ms 节流'),
          sw('click', '鼠标点击'),
          sw('scroll', '鼠标滚动'),
          sw('input', '键盘输入'),
          h('div', { class: 'sync-section-title' }, '文本输入'),
          sw('text_sync', '相同文本输入'),
          sw('paste', '粘贴同步'),
          sw('typing', '模拟人工输入'),
          sw('random_number', '随机数字输入'),
          h('div', { class: 'sync-row' },
            h('span', { class: 'sync-label' }, '打字间隔'), num('typing_min_ms', 0, 2000),
            h('span', { class: 'sync-tip' }, '–'), num('typing_max_ms', 0, 2000),
            h('span', { class: 'sync-tip' }, 'ms')),
          h('div', { class: 'sync-row' },
            h('span', { class: 'sync-label' }, '随机数字'), num('random_min', 0, 1000000000),
            h('span', { class: 'sync-tip' }, '–'), num('random_max', 0, 1000000000)),
          h('div', { class: 'sync-section-title' }, '延迟'),
          h('div', { class: 'sync-row' },
            h('span', { class: 'sync-label' }, '延迟'), num('delay_ms', 0, 5000),
            h('span', { class: 'sync-tip' }, 'ms'),
            h('span', { class: 'sync-label' }, '抖动'), num('jitter_ms', 0, 5000),
            h('span', { class: 'sync-tip' }, 'ms')))));
    document.body.appendChild(overlay);
  }
}
