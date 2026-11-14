/**
 * 窗口同步（阶段 1）：选主窗口 + 受控窗口 → 开始 → 四个开关与延迟 → 状态。
 *
 * 这一页只做「配置 + 看读数」。真正的捕获与回放全在主进程（`src/sync/*`），
 * 界面通过 Local API 驱动 —— 关掉这个页面同步照样跑（这也是为什么面板是独立窗口）。
 *
 * 已知边界的界面表达（不藏）：
 *   · 各窗口尺寸不一致时坐标按视口比例映射，响应式页面会点偏 → 顶部显著提示 + 一键统一尺寸按钮；
 *   · 环境没在跑不能进同步（不替用户偷偷起内核）；
 *   · 受控窗口零注入，主窗口只有一段捕获脚本（名字每次会话随机、抓完即删）。
 */
import { h, mount, toast, pill, empty } from '../ui.js';
import { api } from '../api.js';

const state = {
  running: [],
  profiles: new Map(),
  masterId: '',
  slaveIds: new Set(),
  settings: { input: true, click: true, scroll: true, move: true, delay_ms: 0, jitter_ms: 0 },
  status: null,
  timer: null,
  busy: false,
};

export default async function renderSync({ head, page }) {
  clearInterval(state.timer);
  const statusBox = h('div', { class: 'panel-body' });
  const pickBox = h('div', { class: 'panel-body' });
  const warnBox = h('div', { class: 'panel-body', id: 'sync-warn' });

  mount(head,
    h('h1', null, '窗口同步'),
    h('span', { class: 'sub' }, '主窗口的键鼠动作同步到受控窗口'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm', onClick: () => reload(true) }, '刷新'));

  mount(page,
    h('div', { class: 'panel' }, warnBox),
    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, '窗口选择'), h('span', { class: 'sub' }, '只有正在运行的环境能参与同步')),
      pickBox),
    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, '同步设置'), h('span', { class: 'sub' }, '运行中改也立刻生效，不用重开')),
      h('div', { class: 'panel-body' }, buildSettings())),
    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, '状态'), h('span', { class: 'sub' }, '每秒刷新')),
      statusBox));

  await reload(true);
  state.timer = setInterval(() => { tick().catch(() => {}); }, 1000);
  window.addEventListener('hashchange', () => clearInterval(state.timer), { once: true });

  /* ------------------------------ 数据 ------------------------------ */

  async function reload(full = false) {
    try {
      if (full) await loadRunning();
      state.status = await api.syncStatus();
      if (state.status?.running) {
        state.masterId = state.status.master_id || state.masterId;
        state.slaveIds = new Set(state.status.slave_ids || []);
        state.settings = { ...state.settings, ...(state.status.settings || {}) };
      }
    } catch (e) {
      toast(e.message, 'bad');
    }
    paintPick();
    paintStatus();
    paintWarn();
  }

  async function tick() {
    try {
      state.status = await api.syncStatus();
    } catch {
      return;
    }
    paintStatus();
    paintWarn();
  }

  async function loadRunning() {
    const [run, list] = await Promise.all([
      api.running().catch(() => ({ list: [] })),
      api.list({ page: 1, page_size: 500 }).catch(() => ({ list: [] })),
    ]);
    state.running = (run?.list || []).map((r) => ({
      id: r.profile_id || r.id,
      status: r.status || 'Active',
      ws: r.ws || '',
    })).filter((r) => r.id);
    state.profiles = new Map((list?.list || []).map((p) => [p.profile_id, p]));
    // 主窗口被关掉就清掉，免得「开始」按下去才报错
    const ids = new Set(state.running.map((r) => r.id));
    if (state.masterId && !ids.has(state.masterId)) state.masterId = '';
    for (const id of [...state.slaveIds]) if (!ids.has(id)) state.slaveIds.delete(id);
  }

  function nameOf(id) {
    const p = state.profiles.get(id);
    return p?.name || id;
  }

  /* ------------------------------ 选择区 ------------------------------ */

  function paintPick() {
    const running = state.running;
    if (!running.length) {
      mount(pickBox,
        empty('现在没有环境在运行。先去「环境管理」启动至少两个环境，再回来开同步。'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onClick: () => { location.hash = '#/profiles'; } }, '去环境管理')));
      return;
    }

    const rows = running.map((r) => {
      const isMaster = state.masterId === r.id;
      const isSlave = state.slaveIds.has(r.id);
      return h('tr', null,
        h('td', { style: { width: '90px' } },
          h('input', {
            type: 'radio', name: 'sync-master', checked: isMaster, disabled: state.busy || !!state.status?.running,
            onChange: () => { state.masterId = r.id; state.slaveIds.delete(r.id); paintPick(); },
          })),
        h('td', { style: { width: '90px' } },
          h('input', {
            type: 'checkbox', checked: isSlave, disabled: isMaster || state.busy || !!state.status?.running,
            onChange: (e) => {
              if (e.target.checked) state.slaveIds.add(r.id);
              else state.slaveIds.delete(r.id);
              paintPick();
            },
          })),
        h('td', null, nameOf(r.id), h('div', { class: 'muted small' }, r.id)),
        h('td', null, pill('运行中', 'ok')));
    });

    const startBtn = h('button', {
      class: 'btn primary', disabled: state.busy || !!state.status?.running,
      onClick: start,
    }, state.busy ? '正在建立连接…' : '开始同步');

    const stopBtn = h('button', {
      class: 'btn danger', disabled: !state.status?.running || state.busy, onClick: stop,
    }, '停止同步');

    mount(pickBox,
      h('div', { class: 'muted small', style: { marginBottom: '8px' } },
        '主窗口：捕获键鼠的那一个（你在这里操作）。受控窗口：跟着动的那些。'),
      h('table', { class: 'grid' },
        h('thead', null, h('tr', null,
          h('th', null, '主窗口'), h('th', null, '受控'), h('th', null, '环境'), h('th', null, '状态'))),
        h('tbody', null, rows)),
      h('div', { class: 'row', style: { marginTop: '12px' } },
        startBtn, stopBtn,
        h('span', { class: 'sub' },
          state.masterId ? `主：${nameOf(state.masterId)}　受控 ${state.slaveIds.size} 个` : '还没选主窗口')));
  }

  /* ------------------------------ 设置区 ------------------------------ */

  function buildSettings() {
    const box = h('div');
    const sw = (key, label, hint) => h('label', { class: 'check' },
      h('input', {
        type: 'checkbox', checked: state.settings[key] !== false,
        onChange: (e) => applySettings({ [key]: e.target.checked }),
      }),
      h('span', null, label),
      hint ? h('span', { class: 'muted small' }, `　${hint}`) : null);

    const delayInput = h('input', {
      type: 'number', min: 0, max: 5000, step: 10, value: state.settings.delay_ms ?? 0,
      style: { width: '90px' },
      onChange: (e) => applySettings({ delay_ms: Number(e.target.value) || 0 }),
    });
    const jitterInput = h('input', {
      type: 'number', min: 0, max: 5000, step: 10, value: state.settings.jitter_ms ?? 0,
      style: { width: '90px' },
      onChange: (e) => applySettings({ jitter_ms: Number(e.target.value) || 0 }),
    });

    mount(box,
      h('div', { class: 'row' },
        sw('move', '鼠标移动', '太快会压住受控窗口，已按 30ms 节流'),
        sw('click', '点击'),
        sw('scroll', '滚动'),
        sw('input', '键盘输入')),
      h('div', { class: 'row', style: { marginTop: '10px' } },
        h('span', { class: 'muted small' }, '延迟'),
        delayInput, h('span', { class: 'muted small' }, 'ms'),
        h('span', { class: 'muted small', style: { marginLeft: '16px' } }, '随机抖动'),
        jitterInput, h('span', { class: 'muted small' }, 'ms')),
      h('div', { class: 'muted small', style: { marginTop: '8px' } },
        '延迟与抖动都在主进程做（受控窗口里没有任何我们的脚本）。抖动范围 = 0…该值，随机源按会话种子可复现。'));
    return box;
  }

  async function applySettings(patch) {
    state.settings = { ...state.settings, ...patch };
    if (!state.status?.running) { toast('已记住，开始同步后生效'); return; }
    try {
      const r = await api.syncSettings(patch);
      state.settings = { ...state.settings, ...(r?.settings || {}) };
      toast('已生效');
    } catch (e) {
      toast(e.message, 'bad');
      await reload(false);
    }
  }

  /* ------------------------------ 状态区 ------------------------------ */

  function paintStatus() {
    const st = state.status;
    if (!st?.running) {
      mount(statusBox, empty('同步没在跑。选好窗口点「开始同步」。'));
      return;
    }
    const rows = (st.windows || []).map((w) => h('tr', null,
      h('td', null, w.role === 'master' ? pill('主窗口', 'ok') : pill('受控', 'idle')),
      h('td', null, nameOf(w.profile_id), h('div', { class: 'muted small' }, w.profile_id)),
      h('td', null, w.viewport ? `${w.viewport.vw}×${w.viewport.vh}` : '—'),
      h('td', null, w.window?.width ? `${w.window.width}×${w.window.height}` : '—'),
      h('td', null, w.degraded ? pill(w.degraded, 'bad') : '正常')));

    mount(statusBox,
      h('div', { class: 'row' },
        pill('同步中', 'ok'),
        h('span', { class: 'muted small' }, `会话 ${String(st.session_id || '').slice(0, 8)}`),
        h('span', { class: 'muted small' }, `已转发 ${st.events ?? 0} 条`),
        h('span', { class: 'muted small' }, `被开关拦下 ${st.dropped ?? 0} 条`),
        h('span', { class: 'muted small' }, `已发出 ${st.scheduler?.sent ?? 0} / 待发 ${st.scheduler?.pending ?? 0}`),
        h('span', { class: 'muted small' }, `binding ${st.binding_name || '—'}（每会话随机，抓完即删）`)),
      h('table', { class: 'grid', style: { marginTop: '10px' } },
        h('thead', null, h('tr', null,
          h('th', null, '角色'), h('th', null, '环境'), h('th', null, '视口'), h('th', null, '窗口'), h('th', null, '状态'))),
        h('tbody', null, rows)),
      h('div', { class: 'row', style: { marginTop: '10px' } },
        h('button', {
          class: 'btn sm',
          onClick: () => api.syncRefresh().then(() => reload(false)).catch((e) => toast(e.message, 'bad')),
        }, '重读窗口尺寸')));
  }

  /* ------------------------------ 尺寸不一致提示 ------------------------------ */

  function paintWarn() {
    const st = state.status;
    if (!st?.running) { mount(warnBox); return; }
    if (!st.size_mismatch) {
      mount(warnBox, h('div', { class: 'muted small' },
        '各窗口尺寸一致：鼠标坐标按视口比例映射，能落到同一个元素上。'));
      return;
    }
    const sizes = (st.windows || [])
      .filter((w) => w.window?.width)
      .map((w) => `${w.role === 'master' ? '主' : '受控'}=${w.window.width}×${w.window.height}`)
      .join('，');
    mount(warnBox,
      h('div', { class: 'notice warn' },
        h('strong', null, '窗口尺寸不一致：'),
        `各窗口实际尺寸 ${sizes}。坐标按视口比例映射，` +
        '响应式页面在不同宽度下布局本来就变了，会点偏 —— 这不是 bug，是比例映射的边界。',
        h('div', { class: 'row', style: { marginTop: '8px' } },
          h('button', {
            class: 'btn sm primary',
            onClick: async () => {
              try {
                const r = await api.syncUnifySize();
                const bad = (r?.resized || []).filter((x) => !x.ok);
                toast(bad.length ? `有 ${bad.length} 个窗口没改成（${bad[0].reason}）` : '已把受控窗口拉到主窗口尺寸', bad.length ? 'bad' : '');
                await reload(false);
              } catch (e) { toast(e.message, 'bad'); }
            },
          }, '一键统一尺寸'),
          h('span', { class: 'muted small' }, '不会自动改你的窗口，只在你点这个按钮时改'))));
  }

  /* ------------------------------ 开始 / 停止 ------------------------------ */

  async function start() {
    if (!state.masterId) { toast('先选一个主窗口', 'bad'); return; }
    if (!state.slaveIds.size) { toast('至少选一个受控窗口', 'bad'); return; }
    state.busy = true;
    paintPick();
    try {
      const st = await api.syncStart({
        master_id: state.masterId,
        slave_ids: [...state.slaveIds],
        settings: state.settings,
      });
      state.status = st;
      toast('同步已开始');
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      state.busy = false;
      await reload(true);
    }
  }

  async function stop() {
    state.busy = true;
    paintPick();
    try {
      await api.syncStop();
      toast('已停止');
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      state.busy = false;
      await reload(true);
    }
  }
}
