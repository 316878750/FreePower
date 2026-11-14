/**
 * 窗口同步面板（独立小窗 `#/sync-panel`，始终置顶）。
 *
 * 三条硬约束（来自实际使用场景，不是审美）：
 *   1. **不抢焦点**：面板由主进程 `showInactive()` 打开；同步时你是在主窗口里打字的，
 *      面板一旦拿到焦点，按键就打到面板上，同步当场废掉。所以这里**不做任何自动 focus**。
 *   2. **快捷键注册失败必须显示**：否则用户按了没反应会以为功能坏了。
 *   3. 尺寸不一致要显著提示，并把「一键统一尺寸」放在伸手可及的地方。
 */
import { h, mount, toast, pill } from '../ui.js';
import { api } from '../api.js';

const state = {
  status: null,
  running: [],
  profiles: new Map(),
  masterId: '',
  slaves: new Set(),
  timer: null,
  /* 窗口排列的参数：只有用户点「排列」时才用，不做自动重排（改窗口是可见副作用） */
  arrange: {
    mode: 'auto', // 'auto'（一键排列 sync90）| 'custom'（自定义排列 customRange）
    left: 0, top: 0, width: 1000, height: 700, hs: 0, vs: 0, row: 2,
    screenId: null, // null = 主屏；-1 = 全部屏幕
  },
  displays: [],
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
  const arrangeBox = h('div');
  const hotkeyBox = h('div');

  mount(head, h('h1', null, '窗口同步'));
  mount(page,
    banner,
    h('div', { class: 'panel' }, h('div', { class: 'panel-body' }, pickBox)),
    h('div', { class: 'panel' }, h('div', { class: 'panel-body' }, statusBox)),
    h('div', { class: 'panel' }, h('div', { class: 'panel-body' }, arrangeBox)),
    h('div', { class: 'panel' }, h('div', { class: 'panel-body' }, hotkeyBox)));

  if (shortcutFailed) {
    mount(banner, h('div', { class: 'notice bad' },
      h('strong', null, '快捷键注册失败，请手动开始。'),
      h('div', { class: 'muted small' }, '多半是 Ctrl+Alt+S 被别的程序占着（装了 AdsPower 的话就是它）。在下面改一个就能用。')));
  }

  await reload(true);
  await loadDisplays();
  paintArrange();
  await paintHotkey();
  state.timer = setInterval(() => { tick().catch(() => {}); }, 1000);
  window.addEventListener('hashchange', () => {
    clearInterval(state.timer);
    document.body.classList.remove('panel-mode');
  }, { once: true });

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
    }
    paintPick();
    paintStatus();
  }

  async function tick() {
    state.status = await api.syncStatus().catch(() => null);
    paintStatus();
  }

  const nameOf = (id) => state.profiles.get(id)?.name || id;

  /**
   * 读显示器列表（桌面壳写的）。读不到不是错误：命令行跑服务时 `managed:false`，
   * 排列会退化成按原点 (0,0) 算，服务端会带一条 warning 回来。
   */
  async function loadDisplays() {
    const r = await api.syncDisplays().catch(() => null);
    state.displays = Array.isArray(r?.displays) ? r.displays : [];
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
   * 窗口排列面板（对手的 `tileWin`）。参数逐项对齐 `toRangeBrowser`：
   *   排列方式 `syncOperateArrangement` → 一键排列 `sync90` / 自定义排列 `customRange`
   *   起始位置 `startSide` → left / top
   *   窗口大小 `windowSize` → width / height
   *   窗口间距 `windowMarge` → hs / vs
   *   窗口数量 `windowNum` + `syncOperate5`「个/行」→ row
   *   显示器 `sync84` → screenId（-1 = 全部屏幕）
   * **只在用户点按钮时改窗口** —— 改窗口是可见副作用，不能自己动。
   */
  function paintArrange() {
    const a = state.arrange;
    const field = (label, ...inputs) => h('div', { class: 'row', style: { marginTop: '6px' } },
      h('span', { class: 'muted small', style: { minWidth: '56px' } }, label), ...inputs);
    const num = (key, { min = 0, max = 20000, w = '68px' } = {}) => h('input', {
      type: 'number', min, max, value: String(a[key]), style: { width: w },
      onInput: (e) => { a[key] = Number(e.target.value) || 0; },
    });

    const modeSel = h('select', {
      onChange: (e) => { a.mode = e.target.value; paintArrange(); },
    },
      h('option', { value: 'auto', selected: a.mode === 'auto' }, '一键排列'),
      h('option', { value: 'custom', selected: a.mode === 'custom' }, '自定义排列'));

    const screenOpts = [];
    if (!state.displays.length) {
      // 没有桌面壳在管（命令行跑服务）时只有一项，并如实说明按原点算
      screenOpts.push(h('option', { value: 'primary', selected: a.screenId === null }, '内置屏幕'));
    } else {
      state.displays.forEach((d, i) => {
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

    const resBox = h('div');
    const runBtn = h('button', {
      class: 'btn primary sm',
      onClick: () => arrange(resBox),
    }, '窗口排列');

    mount(arrangeBox,
      h('div', { class: 'row' },
        h('span', { class: 'muted small' }, '排列方式'), modeSel,
        h('span', { class: 'spacer' }), runBtn),
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

  async function arrange(resBox) {
    const a = state.arrange;
    const body = a.mode === 'auto'
      ? { auto: true, screenId: a.screenId === null ? undefined : a.screenId }
      : {
        width: a.width, height: a.height, row: a.row, hs: a.hs, vs: a.vs,
        left: a.left, top: a.top, range: 0,
        screenId: a.screenId === null ? undefined : a.screenId,
      };
    try {
      const r = await api.syncArrange(body);
      const bad = (r?.placed || []).filter((x) => !x.ok);
      const warn = (r?.warnings || []).slice();
      toast(bad.length ? `有 ${bad.length} 个窗口没能排到位` : `已排列 ${r?.placed?.length ?? 0} 个窗口`, bad.length ? 'bad' : '');
      mount(resBox,
        bad.length
          ? h('div', { class: 'notice bad', style: { marginTop: '6px' } },
            h('strong', null, `有 ${bad.length} 个窗口没能排到位：`),
            ...bad.map((x) => h('div', { class: 'muted small' }, `${nameOf(x.profile_id)}（${x.role === 'master' ? '主控' : '受控'}）：${x.reason || '位置不符'}`)))
          : h('div', { class: 'muted small', style: { marginTop: '6px' } },
            `已排列 ${r?.placed?.length ?? 0} 个窗口${r?.auto ? `（每行 ${r.auto.cols} 个，${r.auto.width}×${r.auto.height}）` : ''}`),
        warn.length
          ? h('div', { class: 'notice warn', style: { marginTop: '6px' } }, ...warn.map((w) => h('div', { class: 'muted small' }, w)))
          : null);
    } catch (e) {
      toast(e.message, 'bad');
      mount(resBox, h('div', { class: 'notice bad', style: { marginTop: '6px' } }, e.message));
    }
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