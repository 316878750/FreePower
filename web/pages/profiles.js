/** 环境列表：启动/停止/自检状态/批量操作。所有动作都打 Local API，没有私有通道。 */
import { h, mount, clear, toast, confirmDialog, pill, empty, fmtTime } from '../ui.js';
import { api } from '../api.js';

const state = {
  rows: [],
  running: new Map(),
  checks: {},
  groups: [],
  selected: new Set(),
  busy: new Set(),
  q: '',
  groupId: '',
  total: 0,
  timer: null,
};

export default async function renderProfiles({ head, page }) {
  clearInterval(state.timer);
  mount(head,
    h('h1', null, '环境管理'),
    h('span', { class: 'sub', id: 'count-sub' }, '加载中…'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm', onClick: () => load(true) }, '刷新'));

  const body = h('tbody');
  const selBar = h('span', { class: 'sub' });
  const toolbar = h('div', { class: 'toolbar' },
    h('input', {
      type: 'text', placeholder: '搜索名称 / 编号', value: state.q,
      onInput: (e) => { state.q = e.target.value.trim(); paintRows(body); },
    }),
    h('select', {
      onChange: (e) => { state.groupId = e.target.value; load(false); },
    },
      h('option', { value: '' }, '全部分组'),
      ...state.groups.map((g) => h('option', { value: g.id, selected: state.groupId === String(g.id) }, `${g.name}（${g.profile_count || 0}）`))),
    h('span', { class: 'grow' }),
    selBar,
    h('button', { class: 'btn primary', onClick: () => { location.hash = '#/profiles/new'; } }, '新建环境'),
    h('button', { class: 'btn', onClick: () => batch('start') }, '批量启动'),
    h('button', { class: 'btn', onClick: () => batch('stop') }, '批量停止'),
    h('button', { class: 'btn', onClick: stopAll }, '全部停止'));

  mount(page,
    h('div', { class: 'panel' },
      h('div', { class: 'panel-body' },
        toolbar,
        h('table', { class: 'grid' },
          h('thead', null,
            h('tr', null,
              h('th', { style: { width: '28px' } }, h('input', { type: 'checkbox', onChange: (e) => toggleAll(e.target.checked) })),
              h('th', null, '环境'),
              h('th', null, '分组'),
              h('th', null, '代理'),
              h('th', null, '状态'),
              h('th', null, '自检'),
              h('th', { style: { width: '210px' } }, '操作'))),
          body))));

  await loadGroups();
  await load(true);

  // 运行态 3 秒一刷：列表本身不重拉，只更新运行信息
  state.timer = setInterval(() => { tick().catch(() => {}); }, 3000);
  window.addEventListener('hashchange', () => clearInterval(state.timer), { once: true });

  function toggleAll(on) {
    state.selected.clear();
    if (on) for (const r of filtered()) state.selected.add(r.profile_id);
    paintRows(body);
    paintSel();
  }
  function paintSel() {
    mount(selBar, state.selected.size ? `已选 ${state.selected.size} 个` : '');
  }
  state.paintSel = paintSel;

  async function loadGroups() {
    try {
      const r = await api.groups();
      state.groups = r.list || [];
      // 分组下拉已经渲染过，重建一次（只在首屏，不影响输入焦点）
      const sel = toolbar.querySelector('select');
      clear(sel);
      sel.appendChild(h('option', { value: '' }, '全部分组'));
      for (const g of state.groups) {
        sel.appendChild(h('option', { value: g.id, selected: state.groupId === String(g.id) }, `${g.name}（${g.profile_count || 0}）`));
      }
    } catch { /* 分组取不到不影响列表 */ }
  }

  async function load(showToast) {
    try {
      const [listRes, runRes] = await Promise.all([
        api.list({ limit: 200, page: 1, name: state.q || undefined, group_id: state.groupId || undefined }),
        api.running(),
      ]);
      state.rows = listRes.list || [];
      state.total = listRes.total || state.rows.length;
      state.running = new Map((runRes.list || []).map((i) => [i.profile_id, i]));
      paintSel();
      paintRows(body);
      paintSub();
      refreshChecks();
    } catch (e) {
      mount(body, h('tr', null, h('td', { colspan: 7 }, h('div', { class: 'notice bad' }, e.message))));
      if (showToast) toast(e.message, 'bad');
    }
  }

  async function refreshChecks() {
    const ids = state.rows.map((r) => r.profile_id);
    if (!ids.length) return;
    try {
      const r = await api.selfcheckSummary(ids);
      state.checks = r.list || {};
      paintRows(body);
    } catch { /* 自检摘要失败不挡列表 */ }
  }

  async function tick() {
    const runRes = await api.running();
    state.running = new Map((runRes.list || []).map((i) => [i.profile_id, i]));
    paintRows(body);
    paintSub();
  }

  function paintSub() {
    const n = state.running.size;
    mount(document.getElementById('count-sub'),
      `${state.total} 个环境${state.q ? `（含搜索：${state.q}）` : ''} · 运行中 ${n} 个`);
  }

  function filtered() {
    const q = state.q.toLowerCase();
    if (!q) return state.rows;
    return state.rows.filter((r) => `${r.name} ${r.profile_no} ${r.remark || ''}`.toLowerCase().includes(q));
  }

  function paintRows(tbody) {
    const rows = filtered();
    if (!rows.length) {
      mount(tbody, h('tr', null, h('td', { colspan: 7 }, empty('还没有环境。点「新建环境」建第一个。'))));
      return;
    }
    clear(tbody);
    for (const r of rows) tbody.appendChild(row(r));
  }

  function row(r) {
    const id = r.profile_id;
    const live = state.running.get(id);
    const busy = state.busy.has(id);
    const chk = state.checks[id];
    const px = r.proxy_config && r.proxy_config.host ? `${r.proxy_config.proxy_type || 'http'}://${r.proxy_config.host}:${r.proxy_config.port}` : '直连';

    const checkCell = !chk
      ? h('span', { class: 'muted small' }, '未自检')
      : h('a', { href: `#/profiles/${id}/selfcheck`, title: chk.stale ? '上一次运行的自检报告（当前未运行）' : '本次运行的自检报告' },
        pill(`${chk.pass}✓ ${chk.warn}⚠ ${chk.fail}✗`, chk.fail ? 'bad' : chk.warn ? 'warn' : 'ok'));

    return h('tr', null,
      h('td', null, h('input', {
        type: 'checkbox', checked: state.selected.has(id),
        onChange: (e) => { if (e.target.checked) state.selected.add(id); else state.selected.delete(id); paintSel(); },
      })),
      h('td', null,
        h('div', null, h('a', { href: `#/profiles/${id}` }, r.name), h('span', { class: 'muted small' }, `  #${r.profile_no}`)),
        r.remark ? h('div', { class: 'muted small' }, r.remark) : null),
      h('td', null, r.group_name || 'Default'),
      h('td', { class: 'num' }, px),
      h('td', null, live
        ? h('span', { class: 'row' }, pill('运行中', 'ok'), h('span', { class: 'muted small mono' }, `:${live.debug_port}`))
        : h('span', { class: 'row' }, pill('未启动', 'idle'), r.last_launch_at ? h('span', { class: 'muted small' }, fmtTime(r.last_launch_at)) : null)),
      h('td', null, checkCell),
      h('td', { class: 'actions' },
        live
          ? h('button', { class: 'btn sm', disabled: busy, onClick: () => act(id, 'stop') }, busy ? '停止中…' : '停止')
          : h('button', { class: 'btn sm', disabled: busy, onClick: () => act(id, 'start') }, busy ? '启动中…' : '启动'),
        ' ',
        h('button', { class: 'btn sm ghost', onClick: () => { location.hash = `#/profiles/${id}`; } }, '编辑'),
        ' ',
        h('button', { class: 'btn sm ghost', onClick: () => { location.hash = `#/profiles/${id}/selfcheck`; } }, '自检'),
        ' ',
        h('button', { class: 'btn sm danger', onClick: () => removeOne(r) }, '删除')));
  }

  async function act(id, what) {
    state.busy.add(id);
    paintRows(body);
    try {
      if (what === 'start') {
        const r = await api.start(id);
        toast(`已启动，调试端口 ${r.debug_port}${r.already_running ? '（本来就在跑）' : ''}`, 'ok');
        // 启动会跑一次自检，把摘要取回来
        if (r.selfcheck) { state.checks[id] = { ...r.selfcheck, stale: false }; }
      } else {
        await api.stop(id);
        toast('已停止', 'ok');
      }
    } catch (e) {
      toast(`${what === 'start' ? '启动' : '停止'}失败：${e.message}`, 'bad');
    } finally {
      state.busy.delete(id);
      await load(false);
    }
  }

  async function batch(what) {
    const ids = [...state.selected];
    if (!ids.length) { toast('先勾选环境（表头复选框可以全选）'); return; }
    try {
      const r = what === 'start' ? await api.batchStart(ids) : await api.batchStop(ids);
      const okN = what === 'start' ? (r.started || []).length : (r.stopped || []).length;
      const failN = (r.failed || []).length;
      const skipN = (r.skipped || []).length;
      let msg = `${what === 'start' ? '启动' : '停止'}完成：成功 ${okN}`;
      if (failN) msg += ` / 失败 ${failN}`;
      if (skipN) msg += ` / 跳过 ${skipN}`;
      msg += ` · ${r.elapsed_ms}ms`;
      toast(msg, failN ? 'bad' : 'ok');
      if (failN || skipN) showBatchDetail(r, what);
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      await load(false);
    }
  }

  function showBatchDetail(r, what) {
    const lines = [];
    for (const f of r.failed || []) lines.push(`✗ ${f.profile_id.slice(0, 8)}：${f.code} ${f.message || f.reason}`);
    for (const s of r.skipped || []) lines.push(`- 跳过 ${String(s.profile_id || s).slice(0, 8)}（前一个失败后不再硬起）`);
    confirmDialog({
      title: `${what === 'start' ? '批量启动' : '批量停止'}有未完成的`,
      body: h('div', null,
        h('div', null, `已成功 ${what === 'start' ? (r.started || []).length : (r.stopped || []).length} 个${r.interrupted ? '，中途中断' : ''}。`),
        h('div', { class: 'code-block', style: { whiteSpace: 'pre-wrap' } }, lines.join('\n') || '（没有失败明细）')),
      okLabel: '知道了', cancelLabel: '关闭',
    });
  }

  async function stopAll() {
    if (!state.running.size) { toast('没有在运行的环境'); return; }
    const yes = await confirmDialog({
      title: '全部停止',
      body: `会停掉本机所有运行中的环境（${state.running.size} 个）。正在跑的脚本会连接断开。`,
      okLabel: '全部停止', danger: true,
    });
    if (!yes) return;
    try {
      const r = await api.stopAll();
      toast(`已停止 ${(r.stopped || []).length} 个`, 'ok');
    } catch (e) { toast(e.message, 'bad'); }
    await load(false);
  }

  async function removeOne(r) {
    const live = state.running.has(r.profile_id);
    const yes = await confirmDialog({
      title: '删除环境',
      body: h('div', { class: 'stack' },
        h('div', null, '即将删除 ', h('strong', null, r.name), `（#${r.profile_no}）`),
        live ? h('div', { class: 'notice warn' }, '该环境正在运行：会先停止浏览器，再删除。') : null,
        h('div', { class: 'notice bad' }, '这是本地硬删，不可恢复。会连它的 user-data 目录（cookie、登录态、缓存）一起删掉。')),
      okLabel: '删除', danger: true,
    });
    if (!yes) return;
    try {
      await api.remove([r.profile_id]);
      toast(`已删除 ${r.name}`, 'ok');
    } catch (e) { toast(`删除失败：${e.message}`, 'bad'); }
    state.selected.delete(r.profile_id);
    await load(false);
  }
}