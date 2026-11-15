/**
 * 窗口同步**操作台**（对手的 Console 桌面小组件；独立小窗 `#/sync-panel`，始终置顶）。
 *
 * 两种形态（由桌面壳用 `setBounds` 真改窗口尺寸，不是在一个大窗里换布局）：
 *   · 展开态 430×620：完整面板（选择 / 状态 / 排列 / 显示 / 快捷键）；
 *   · 收起态 360×56：**只有五项** —— 状态词、主控环境名、受控几个、停止、展开。
 *     收起态存在的意义就是「不挡主控窗口，但还看得见在同步」，所以别的读数一律不进来。
 *
 * 四条硬约束（来自实际使用场景，不是审美）：
 *   1. **不抢焦点**：面板由主进程 `showInactive()` 打开；同步时你是在主窗口里打字的，
 *      面板一旦拿到焦点，按键就打到面板上，同步当场废掉。所以这里**不做任何自动 focus**。
 *   2. **快捷键注册失败必须显示**：否则用户按了没反应会以为功能坏了。
 *   3. 尺寸不一致要显著提示，并把「一键统一尺寸」放在伸手可及的地方。
 *   4. **纯网页跑服务时没有操作台**：形态切换是桌面壳的能力，按钮禁用并写明原因，
 *      不摆一个点了没反应的入口。
 */
import { h, mount, toast, pill } from '../ui.js';
import { api } from '../api.js';
import { buildArrangePanel, buildShowPanel } from '../sync-widgets.js';

const state = {
  status: null,
  running: [],
  profiles: new Map(),
  masterId: '',
  slaves: new Set(),
  timer: null,
  displays: [],
  console: null,       // GET /sync/console 的结果（managed / mode / prefs / model）
  mode: null,          // 当前渲染的形态（null = 还没画过）
};

function hashQuery() {
  const raw = String(location.hash || '');
  const i = raw.indexOf('?');
  if (i < 0) return new URLSearchParams();
  return new URLSearchParams(raw.slice(i + 1));
}

export default async function renderSyncPanel({ head, page }) {
  clearInterval(state.timer);
  document.body.classList.add('panel-mode');

  const shortcutFailed = hashQuery().get('shortcut') === 'failed';
  const banner = h('div');
  const pickBox = h('div');
  const statusBox = h('div');
  const consoleBox = h('div');
  const hotkeyBox = h('div');
  const collapsedBar = h('div');

  /** 环境 id → 名字（共用组件要它；必须在使用之前定义，别挪到后面去） */
  const nameOf = (id) => state.profiles.get(id)?.name || id;

  // 共用组件：操作台与「窗口同步」页用的是同一份代码、同两条路由
  const arrangePanel = buildArrangePanel({ nameOf, getDisplays: () => state.displays });
  const showPanel = buildShowPanel({ nameOf });

  await reload(true);
  await loadDisplays();
  await loadConsole();
  paintShell();
  try { await paintHotkey(); } catch { /* 快捷键读不到不影响操作台 */ }

  state.timer = setInterval(() => { tick().catch(() => {}); }, 1000);
  window.addEventListener('hashchange', () => {
    clearInterval(state.timer);
    document.body.classList.remove('panel-mode', 'console-collapsed');
  }, { once: true });

  /** 形态切换时整页重画（两种形态的内容差别就是全部内容，没必要增量 diff） */
  function paintShell() {
    const collapsed = state.mode === 'collapsed';
    document.body.classList.toggle('console-collapsed', collapsed);
    if (collapsed) {
      mount(head, null);
      mount(page, collapsedBar);
      paintCollapsed();
      return;
    }
    document.body.classList.remove('console-collapsed');
    mount(head, h('h1', null, '窗口同步'));
    mount(page,
      banner,
      h('div', { class: 'panel' }, h('div', { class: 'panel-body' }, consoleBox)),
      h('div', { class: 'panel' }, h('div', { class: 'panel-body' }, pickBox)),
      h('div', { class: 'panel' }, h('div', { class: 'panel-body' }, statusBox)),
      h('div', { class: 'panel' }, h('div', { class: 'panel-body' }, arrangePanel.el)),
      h('div', { class: 'panel' }, h('div', { class: 'panel-body' }, showPanel.el)),
      h('div', { class: 'panel' }, h('div', { class: 'panel-body' }, hotkeyBox)));
    paintConsoleSettings();
    paintPick();
    paintStatus();
    if (shortcutFailed && !banner.firstChild) {
      mount(banner, h('div', { class: 'notice bad' },
        h('strong', null, '快捷键注册失败，请手动开始。'),
        h('div', { class: 'muted small' }, '多半是 Ctrl+Alt+S 被别的程序占着（装了 AdsPower 的话就是它）。在下面改一个就能用。')));
    }
  }

  /** 收起条：**只放五项**（服务端 `consoleBarModel` 算的，界面不自己拼文案） */
  function paintCollapsed() {
    const model = state.console?.model || { items: ['同步已停止', '未选主窗口', '受控 0 个', '展开'], actions: [{ id: 'expand', label: '展开' }] };
    const actions = (model.actions || []).map((a) => h('button', {
      class: `btn sm${a.id === 'stop' ? ' danger' : ''}`,
      onClick: () => runConsoleAction(a.id),
    }, a.label));
    mount(collapsedBar,
      h('div', { class: 'console-bar' },
        h('span', { class: `console-dot ${model.tone || 'ok'}` }),
        h('span', { class: 'console-title', title: model.detail || '' }, model.title),
        h('span', { class: 'console-master', title: model.master }, model.master),
        h('span', { class: 'console-slaves' }, model.slaves),
        h('span', { class: 'spacer' }),
        ...actions));
  }

  async function runConsoleAction(id) {
    if (id === 'stop') {
      try { await api.syncStop(); toast('已停止'); } catch (e) { toast(e.message, 'bad'); }
      await reload(true);
      return;
    }
    if (id === 'expand') {
      try {
        const r = await api.syncConsoleSet({ mode: 'expanded' });
        if (r?.requested === false) toast(r.message || '没有桌面壳在管，无法展开', 'bad');
      } catch (e) { toast(e.message, 'bad'); }
    }
  }

  /* ------------------------------ 操作台设置 ------------------------------ */

  function paintConsoleSettings() {
    const con = state.console || { managed: false, prefs: { auto_shrink: true } };
    const autoShrink = h('input', {
      type: 'checkbox', checked: con.prefs?.auto_shrink === true, disabled: !con.managed,
      onChange: (e) => setPrefs({ auto_shrink: e.target.checked }),
    });
    mount(consoleBox,
      h('div', { class: 'row' },
        h('span', { class: 'muted small' }, '操作台'),
        con.managed ? pill('桌面小组件', 'ok') : pill('没有桌面壳在管', 'idle'),
        h('span', { class: 'spacer' }),
        h('button', {
          class: 'btn sm', disabled: !con.managed || state.mode === 'collapsed',
          onClick: () => collapse(),
        }, '收起')),
      h('label', { class: 'check', style: { marginTop: '6px' } },
        autoShrink, h('span', null, '同步开始时自动收起'),
        h('span', { class: 'muted small' }, '　默认开启：展开态置顶会挡住主控窗口（我们的选择，对手默认值无证据）')),
      h('div', { class: 'row', style: { marginTop: '6px' } },
        h('button', {
          class: 'btn sm', disabled: !con.managed,
          onClick: () => resetPosition(),
        }, '操作台复位到默认位置')),
      con.managed
        ? null
        : h('div', { class: 'muted small', style: { marginTop: '6px' } },
          '当前是纯网页（没有桌面壳）：操作台形态与位置由桌面版管理，这里只能看内容。'));
  }

  async function collapse() {
    try {
      const r = await api.syncConsoleSet({ mode: 'collapsed' });
      if (r?.requested === false) toast(r.message || '没有桌面壳在管，无法收起', 'bad');
    } catch (e) { toast(e.message, 'bad'); }
  }

  async function setPrefs(patch) {
    try {
      const r = await api.syncConsoleSet({ prefs: patch });
      if (r?.requested === false) toast(r.message || '没有桌面壳在管，设置没有生效', 'bad');
      else toast('已保存');
      await loadConsole();
      paintConsoleSettings();
    } catch (e) {
      toast(e.message, 'bad');
      await loadConsole();
      paintConsoleSettings();
    }
  }

  async function resetPosition() {
    try {
      const r = await api.syncConsoleSet({ reset_position: true });
      if (r?.requested === false) toast(r.message || '没有桌面壳在管，无法复位', 'bad');
      else toast('已请求复位到主屏中央');
    } catch (e) { toast(e.message, 'bad'); }
  }

  async function loadConsole() {
    state.console = await api.syncConsole().catch(() => null);
    state.mode = state.console?.managed && state.console?.mode === 'collapsed' ? 'collapsed' : 'expanded';
  }

  /* ------------------------------ 数据 ------------------------------ */

  async function reload(full) {
    if (full) {
      const [run, list] = await Promise.all([
        api.running().catch(() => ({ list: [] })),
        api.list({ page: 1, page_size: 500 }).catch(() => ({ list: [] })),
      ]);
      state.running = (run?.list || []).map((r) => ({ id: r.profile_id || r.id })).filter((r) => r.id);
      state.profiles = new Map((list?.list || []).map((p) => [p.profile_id, p]));
      const ids = new Set(state.running.map((r) => r.id));
      if (state.masterId && !ids.has(state.masterId)) state.masterId = '';
      for (const id of [...state.slaves]) if (!ids.has(id)) state.slaves.delete(id);
    }
    state.status = await api.syncStatus().catch(() => null);
    if (state.status?.running) {
      state.masterId = state.status.master_id || '';
      state.slaves = new Set(state.status.slave_ids || []);
    } else {
      // 停止后收起条要显示「同步已停止」，模型必须跟着刷新（服务端按真实状态算）
      state.console = await api.syncConsole().catch(() => state.console);
    }
    paintPick();
    paintStatus();
  }

  async function tick() {
    state.status = await api.syncStatus().catch(() => null);
    const con = await api.syncConsole().catch(() => null);
    if (con) state.console = con;
    const nextMode = con?.managed && con?.mode === 'collapsed' ? 'collapsed' : 'expanded';
    if (nextMode !== state.mode) {
      state.mode = nextMode;
      paintShell();
      return;
    }
    if (state.mode === 'collapsed') paintCollapsed();
    else paintStatus();
  }

  /**
   * 读显示器列表（桌面壳写的）。读不到不是错误：命令行跑服务时 `managed:false`，
   * 排列会退化成按原点 (0,0) 算，服务端会带一条 warning 回来。
   */
  async function loadDisplays() {
    const r = await api.syncDisplays().catch(() => null);
    state.displays = Array.isArray(r?.displays) ? r.displays : [];
    arrangePanel.refresh();
  }

  function paintPick() {
    if (state.status?.running) {
      mount(pickBox, h('div', { class: 'muted small' }, `主：${nameOf(state.masterId)}　受控 ${state.slaves.size} 个`));
      return;
    }
    if (!state.running.length) {
      mount(pickBox, h('div', { class: 'muted' }, '没有环境在运行。先启动至少两个环境。'));
      return;
    }
    const masterSel = h('select', {
      onChange: (e) => { state.masterId = e.target.value; state.slaves.delete(state.masterId); paintPick(); },
    },
      h('option', { value: '' }, '选主窗口'),
      ...state.running.map((r) => h('option', { value: r.id, selected: state.masterId === r.id }, nameOf(r.id))));

    const slaves = state.running.filter((r) => r.id !== state.masterId).map((r) => h('label', { class: 'check' },
      h('input', {
        type: 'checkbox', checked: state.slaves.has(r.id),
        onChange: (e) => { if (e.target.checked) state.slaves.add(r.id); else state.slaves.delete(r.id); },
      }),
      h('span', null, nameOf(r.id))));

    mount(pickBox,
      h('div', { class: 'row' }, h('span', { class: 'muted small' }, '主窗口'), masterSel),
      h('div', { style: { marginTop: '8px' } },
        h('div', { class: 'muted small' }, '受控窗口'),
        slaves.length ? h('div', null, slaves) : h('div', { class: 'muted small' }, '先选主窗口')),
      h('div', { class: 'row', style: { marginTop: '10px' } },
        h('button', { class: 'btn primary', onClick: start }, '开始同步')));
  }

  function paintStatus() {
    const st = state.status;
    if (state.mode === 'collapsed') return;
    if (!st?.running) { mount(statusBox, h('div', { class: 'muted small' }, '同步没在跑')); return; }
    const sizes = (st.windows || []).filter((w) => w.window?.width)
      .map((w) => `${w.role === 'master' ? '主' : '受控'} ${w.window.width}×${w.window.height}`).join('，');
    mount(statusBox,
      h('div', { class: 'row' },
        pill('同步中', 'ok'),
        h('span', { class: 'muted small' }, `${st.events ?? 0} 条已转发`),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn danger sm', onClick: stop }, '停止')),
      st.size_mismatch
        ? h('div', { class: 'notice warn', style: { marginTop: '8px' } },
          h('strong', null, '窗口尺寸不一致：'), `${sizes}。坐标按视口比例映射，响应式页面会点偏。`,
          h('div', { style: { marginTop: '6px' } },
            h('button', { class: 'btn sm primary', onClick: unify }, '一键统一尺寸')))
        : h('div', { class: 'muted small', style: { marginTop: '6px' } }, `尺寸一致：${sizes || '—'}`),
      h('div', { class: 'muted small', style: { marginTop: '6px' } },
        `已发出 ${st.scheduler?.sent ?? 0} / 待发 ${st.scheduler?.pending ?? 0}，被开关拦下 ${st.dropped ?? 0}`));
  }

  async function start() {
    if (!state.masterId) { toast('先选主窗口', 'bad'); return; }
    if (!state.slaves.size) { toast('至少选一个受控窗口', 'bad'); return; }
    try {
      await api.syncStart({ master_id: state.masterId, slave_ids: [...state.slaves] });
      toast('已开始');
    } catch (e) { toast(e.message, 'bad'); }
    await reload(true);
  }

  async function stop() {
    try { await api.syncStop(); toast('已停止'); } catch (e) { toast(e.message, 'bad'); }
    await reload(true);
  }

  async function unify() {
    try {
      const r = await api.syncUnifySize();
      const bad = (r?.resized || []).filter((x) => !x.ok);
      toast(bad.length ? `${bad.length} 个窗口没改成` : '已统一尺寸', bad.length ? 'bad' : '');
    } catch (e) { toast(e.message, 'bad'); }
    await reload(false);
  }

  /**
   * 快捷键区：显示当前值、注册状态，并给一个能改的输入框。
   * 为什么一定要有输入框：`Ctrl+Alt+S` 在装了 AdsPower 的机器上被它全局占着（实测 err=1409），
   * 我们注册不上是常态；只提示「失败」而不给改的入口，等于功能废一半。
   */
  async function paintHotkey() {
    const st = await api.syncHotkey().catch(() => null);
    if (!st) { mount(hotkeyBox, h('div', { class: 'muted small' }, '读不到快捷键状态')); return; }
    const input = h('input', { type: 'text', value: st.accelerator || st.default || '', style: { flex: '1' } });
    const save = h('button', {
      class: 'btn sm primary',
      onClick: async () => {
        try {
          await api.syncHotkeySet(input.value.trim());
          toast('已提交，桌面壳会重新注册（约 1–2 秒）');
          setTimeout(() => paintHotkey().catch(() => {}), 2200);
        } catch (e) { toast(e.message, 'bad'); }
      },
    }, '保存');
    mount(hotkeyBox,
      h('div', { class: 'row' },
        h('span', { class: 'muted small' }, '全局快捷键'),
        st.ok === false ? pill('注册失败', 'bad') : st.ok === true ? pill('已生效', 'ok') : pill('没有桌面壳在管', 'idle')),
      st.ok === false
        ? h('div', { class: 'notice bad', style: { marginTop: '6px' } },
          `${st.accelerator} 注册失败：${st.error || '被占用'}。请在这里改一个。`)
        : null,
      h('div', { class: 'row', style: { marginTop: '8px' } }, input, save),
      h('div', { class: 'muted small', style: { marginTop: '6px' } },
        `默认 ${st.default}。必须带至少一个修饰键（CommandOrControl / Alt / Shift）。`));
  }
}