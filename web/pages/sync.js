/**
 * 窗口同步（阶段 1 + 阶段 2 文本输入）：选主窗口 + 受控窗口 → 开始 → 开关与延迟 → 状态。
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
  settings: {
    input: true, click: true, scroll: true, move: true,
    text_sync: true, typing: false, paste: true, random_number: false,
    typing_min_ms: 30, typing_max_ms: 120, random_min: 1000, random_max: 9999,
    same_tab: true, current_tab_url: false,
    delay_ms: 0, jitter_ms: 0,
  },
  status: null,
  tabBox: null,
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
      h('div', { class: 'panel-head' }, h('h2', null, '标签页管理'), h('span', { class: 'sub' }, '按序号对应主窗口的标签')),
      h('div', { class: 'panel-body' }, buildTabs())),
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
    paintTabs().catch(() => {});
  }

  async function tick() {
    try {
      state.status = await api.syncStatus();
    } catch {
      return;
    }
    paintStatus();
    paintWarn();
    paintTabs().catch(() => {});
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
    const sw = (key, label, hint, dflt = true) => h('label', { class: 'check' },
      h('input', {
        type: 'checkbox', checked: (state.settings[key] ?? dflt) === true,
        onChange: (e) => applySettings({ [key]: e.target.checked }),
      }),
      h('span', null, label),
      hint ? h('span', { class: 'muted small' }, `　${hint}`) : null);

    const numBox = (key, min, max, step, width = '90px') => h('input', {
      type: 'number', min, max, step, value: state.settings[key] ?? 0,
      style: { width },
      onChange: (e) => applySettings({ [key]: Number(e.target.value) || 0 }),
    });

    const delayInput = numBox('delay_ms', 0, 5000, 10);
    const jitterInput = numBox('jitter_ms', 0, 5000, 10);

    mount(box,
      h('div', { class: 'row' },
        sw('move', '鼠标移动', '太快会压住受控窗口，已按 30ms 节流'),
        sw('click', '点击'),
        sw('scroll', '滚动'),
        sw('input', '键盘输入')),
      h('div', { class: 'row', style: { marginTop: '10px' } },
        h('span', { class: 'muted small', style: { width: '100%' } }, '文本输入')),
      h('div', { class: 'row' },
        sw('text_sync', '相同文本输入', '主窗口打的字原样同步（关掉只同步按键，不落字符）'),
        sw('paste', '粘贴同步', '主窗口粘贴的内容也同步到受控窗口'),
        sw('typing', '模拟人工输入', '逐字投递、字间随机间隔', false),
        sw('random_number', '随机数字输入', '每个受控窗口各自一个随机数，替换原文', false)),
      h('div', { class: 'row', style: { marginTop: '6px' } },
        h('span', { class: 'muted small' }, '打字间隔'),
        numBox('typing_min_ms', 0, 2000, 5, '70px'), h('span', { class: 'muted small' }, '–'),
        numBox('typing_max_ms', 0, 2000, 5, '70px'), h('span', { class: 'muted small' }, 'ms'),
        h('span', { class: 'muted small', style: { marginLeft: '16px' } }, '随机数字范围'),
        numBox('random_min', 0, 1000000000, 1, '110px'), h('span', { class: 'muted small' }, '–'),
        numBox('random_max', 0, 1000000000, 1, '110px')),
      h('div', { class: 'row', style: { marginTop: '10px' } },
        h('span', { class: 'muted small' }, '延迟'),
        delayInput, h('span', { class: 'muted small' }, 'ms'),
        h('span', { class: 'muted small', style: { marginLeft: '16px' } }, '随机抖动'),
        jitterInput, h('span', { class: 'muted small' }, 'ms')),
      h('div', { class: 'muted small', style: { marginTop: '8px' } },
        '延迟与抖动都在主进程做（受控窗口里没有任何我们的脚本）。抖动范围 = 0…该值，随机源按会话种子可复现。'),
      h('div', { class: 'muted small' },
        '「相同文本输入」和「随机数字输入」是两个独立开关：都开时数字输入优先（随机数字替换原文）；'
        + '随机数每个受控窗口各自抽，同一批环境不会写出相同的值。'));
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

  /* ------------------------------ 标签页管理 ------------------------------ */

  function buildTabs() {
    const box = h('div');
    const urlInput = h('textarea', {
      rows: 3,
      placeholder: '请输入网址，每行一个，示例：\nwww.google.com\nwww.facebook.com',
      style: { width: '420px', fontFamily: 'inherit' },
    });

    // 「首个网址在当前标签页打开」（对手原文 syncOperateCurrentTabURL）—— 标签区唯一的勾选项
    const currentTab = h('label', { class: 'check' },
      h('input', {
        type: 'checkbox', checked: (state.settings.current_tab_url ?? false) === true,
        onChange: (e) => applySettings({ current_tab_url: e.target.checked }),
      }),
      h('span', null, '首个网址在当前标签页打开'),
      h('span', { class: 'muted small' }, '　勾选后第一个网址在当前标签页里跳，其余网址照常新开'));

    const act = (label, fn) => h('button', {
      class: 'btn sm', disabled: !state.status?.running,
      onClick: () => runTabAction(fn),
    }, label);

    // 前端先数一遍只为**立刻**给出同一句提示；真正的判定在服务端（`parseOpenUrls`），单一来源
    const openUrls = () => {
      const list = String(urlInput.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (list.length > 10) return Promise.reject(new Error('一键最多打开10个网址'));
      return api.syncOpenTab(list);
    };

    state.tabBox = h('div', { class: 'muted small', style: { marginTop: '8px' } });

    mount(box,
      h('div', { class: 'row' }, currentTab),
      h('div', { class: 'row', style: { marginTop: '8px' } },
        urlInput, act('打开', openUrls)),
      h('div', { class: 'muted small' }, '每行一个，最多 10 个（超过会提示「一键最多打开10个网址」，不会偷偷少开）。'),
      h('div', { class: 'row', style: { marginTop: '8px' } },
        act('统一标签页', () => api.syncUnifyTabs()),
        act('关闭其他', () => api.syncCloseTabs('others')),
        act('关闭当前标签页', () => api.syncCloseTabs('current')),
        act('关闭空白标签页', () => api.syncCloseTabs('blank')),
        act('复制当前标签到其它窗口', () => api.syncCopyTab())),
      state.tabBox);
    return box;
  }

  async function runTabAction(fn) {
    if (!state.status?.running) { toast('先开始同步', 'bad'); return; }
    try {
      const r = await fn();
      const n = (r?.opened || r?.closed || r?.copied || r?.windows || []).length;
      toast(`完成（${n} 项）`);
      await paintTabs();
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

  /** 各窗口标签数与可见序号（每秒跟着状态一起刷，按钮点完也刷一次） */
  async function paintTabs() {
    if (!state.tabBox) return;
    if (!state.status?.running) { mount(state.tabBox, '同步没在跑。'); return; }
    try {
      const info = await api.syncTabs();
      const rows = (info.windows || []).map((w) => {
        const urls = (w.tabs || []).map((x) => (x.url || '').replace(/^https?:\/\//, '').slice(0, 40) || '(空白)');
        return `${w.role === 'master' ? '主' : '受控'} ${nameOf(w.profile_id)}：${w.tabs?.length ?? 0} 个`
          + `${w.visible_confident ? `（当前第 ${w.visible + 1} 个）` : '（当前标签读不到）'}`
          + `　${urls.join(' | ')}`;
      });
      mount(state.tabBox,
        h('div', null, `首个网址在当前标签页打开 ${info.current_tab_url ? '开' : '关'}`),
        ...rows.map((t) => h('div', null, t)));
    } catch { /* 状态刷新失败不弹错，下一秒会再试 */ }
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
        h('span', { class: 'muted small' }, `文本已发 ${st.text_sent ?? 0} / 按策略吞掉 ${st.text_swallowed ?? 0}`),
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
