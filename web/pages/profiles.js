/** 环境列表：启动/停止/自检状态/批量操作。所有动作都打 Local API，没有私有通道。 */
import { h, mount, clear, toast, confirmDialog, promptDialog, downloadText, pickFile, pill, empty, fmtTime, drawer } from '../ui.js';
import { api } from '../api.js';
import { tabBar } from '../tabs.js';
import {
  DENSITIES, densityOf, applyDensity, setDensity, VIEW_STORAGE_KEY,
} from '../density.js';

const state = {
  rows: [],
  running: new Map(),
  checks: {},
  groups: [],
  selected: new Set(),
  busy: new Set(),
  q: '',
  groupId: '',
  /** '' 主列表（不含已归档）/ only 只看已归档 / include 全都算 */
  archiveFilter: '',
  density: densityOf(),
  /** 上一次「显示窗口」的目标：强制置前要用同一批（不重新算勾选，避免用户中途改了勾选） */
  lastShowIds: null,
  total: 0,
  timer: null,
};

export default async function renderProfiles({ head, page }) {
  clearInterval(state.timer);
  // 密度是本地偏好：进页面就读一次并落到 body 上（别的页面不清它，全局一致）
  applyDensity(state.density);
  mount(head,
    h('h1', null, '环境管理'),
    h('span', { class: 'sub', id: 'count-sub' }, '加载中…'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm', onClick: () => load(true) }, '刷新'));

  const body = h('tbody');
  const selBar = h('span', { class: 'sub' });
  const menu = batchMenu();
  // 视图密度下拉：与侧栏底部账号菜单的「外观」是同一个设置（同一个 localStorage 键）。
  // 两边都要能改，所以互相跟着变 —— 靠 density.js 广播的 `fp:density` 事件，不互相 import。
  const densitySel = h('select', {
    title: '只影响本机显示，不写库、不同步到别的机器',
    onChange: (e) => {
      state.density = setDensity(e.target.value);
      paintSub();
    },
  },
    ...DENSITIES.map((d) => h('option', { value: d.id, selected: state.density === d.id }, `视图：${d.label}`)));
  document.addEventListener('fp:density', (e) => {
    const id = e?.detail?.id;
    if (!id || densitySel.value === id) return;
    state.density = densityOf(id).id;
    densitySel.value = state.density;
    paintSub();
  });

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
    // 归档筛选：默认「未归档」（= 主列表）；归档的还在我们能看见的地方，不是删除
    h('select', {
      title: '归档 = 移出主列表但不算删除：cookie、user-data、能启动，一样不少',
      onChange: (e) => { state.archiveFilter = e.target.value; load(false); },
    },
      h('option', { value: '', selected: state.archiveFilter === '' }, '未归档（主列表）'),
      h('option', { value: 'only', selected: state.archiveFilter === 'only' }, '只看已归档'),
      h('option', { value: 'include', selected: state.archiveFilter === 'include' }, '全部（含已归档）')),
    densitySel,
    h('span', { class: 'grow' }),
    selBar,
    menu,
    h('button', { class: 'btn primary', onClick: () => { location.hash = '#/profiles/new'; } }, '新建环境'),
    h('button', { class: 'btn', onClick: importFile, title: 'JSON（{list} / {data:{list}} / 裸数组）或 AdsPower 的 .txt 块格式；未知字段会列在结果里' }, '导入'),
    h('button', { class: 'btn', onClick: exportTxt, title: 'AdsPower .txt：账号+代理+cookie+UA 的搬运单，不含指纹配置；保真备份请用每行的「导出」JSON' }, '导出 txt'),
    h('button', { class: 'btn', onClick: () => batch('start') }, '批量启动'),
    h('button', { class: 'btn', onClick: () => batch('stop') }, '批量停止'),
    h('button', { class: 'btn', onClick: stopAll }, '全部停止'));

  mount(page,
    tabBar('list'),
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
              h('th', { style: { width: '330px' } }, '操作'))),
          body))));

  await loadGroups();
  await load(true);

  // 运行态 3 秒一刷：列表本身不重拉，只更新运行信息
  state.timer = setInterval(() => { tick().catch(() => {}); }, 3000);
  window.addEventListener('hashchange', () => clearInterval(state.timer), { once: true });

  /* ---------------------------- 批量操作菜单 ---------------------------- */
  /**
   * 11 项，顺序照逆向 `28-` 号文的「批量操作」清单 + 行内四项。
   * 分组（sep）是有意的：上面是「改配置」，中间是「归档 / 删除」（会改变列表归属），
   * 下面是「窗口与网络 / 登录态」这类会动运行时或登录信息的动作。
   */
  function batchMenu() {
    const wrap = h('div', { class: 'dropdown' });
    const panel = h('div', { class: 'menu' });
    const btn = h('button', {
      class: 'btn',
      onClick: (e) => { e.stopPropagation(); wrap.classList.toggle('open'); },
    }, '批量操作 ▾');
    const item = (label, fn, { danger = false, title = '' } = {}) => h('button', {
      class: danger ? 'danger' : '',
      title,
      onClick: (e) => { e.stopPropagation(); wrap.classList.remove('open'); fn(); },
    }, label);

    mount(panel,
      item('修改代理', () => batchProxy()),
      item('修改 UA / 内核', () => batchUa()),
      item('修改备注', () => batchRemark()),
      item('更新环境信息', () => batchUpdateInfo()),
      h('div', { class: 'sep' }),
      item('批量归档', () => batchArchive(), { title: '移出主列表，但不是删除：还能启动、还能在「只看已归档」里看到' }),
      item('批量恢复', () => batchUnarchive(), { title: '把归档的环境放回主列表（不是从回收站恢复）' }),
      item('批量删除', () => batchDelete(), { danger: true, title: '移入回收站，可以恢复' }),
      h('div', { class: 'sep' }),
      item('显示窗口', () => batchShow()),
      item('检查代理', () => batchCheckProxy()),
      item('还原 Cookie（覆盖）', () => batchCookie('restore'), { title: '写完之后以文件为准：文件里没有的会被删掉。先预览再确认' }),
      item('合并 Cookie（并集）', () => batchCookie('merge'), { title: '只补文件里有、环境里没有的；同名以环境现有为准，不动登录态' }));
    wrap.appendChild(btn);
    wrap.appendChild(panel);
    // 点别处收起（一次性监听，页面切走也无所谓）
    document.addEventListener('click', () => wrap.classList.remove('open'));
    return wrap;
  }

  /** 批量动作的统一前置：勾选非空 + 一次最多 500 条 */
  function picked() {
    const ids = [...state.selected];
    if (!ids.length) { toast('先勾选环境（表头复选框可以全选当前筛选结果）'); return null; }
    if (ids.length > 500) { toast('一次最多 500 个环境', 'bad'); return null; }
    return ids;
  }

  /** 批量动作的结果都要「如实分说」：成功多少、失败多少、跳过了什么 */
  function reportBatch(title, r, { okKey, failKey = 'failed', skipKey = 'skipped', extra = '' } = {}) {
    const okN = (r?.[okKey] || []).length;
    const failN = (r?.[failKey] || []).length;
    const skipN = (r?.[skipKey] || []).length;
    const bits = [`${title}：成功 ${okN}`];
    if (failN) bits.push(`失败 ${failN}`);
    if (skipN) bits.push(`跳过 ${skipN}`);
    if (extra) bits.push(extra);
    toast(bits.join(' · '), failN ? 'bad' : okN ? 'ok' : 'warn');
    if (failN || skipN) {
      const lines = [];
      for (const f of r[failKey] || []) lines.push(`✗ ${String(f.profile_id).slice(0, 8)}：${f.message || f.reason || '失败'}`);
      for (const s of r[skipKey] || []) lines.push(`- 跳过 ${String(s.profile_id).slice(0, 8)}：${skipReason(s.reason)}`);
      confirmDialog({
        title: `${title}：有未完成的`,
        body: h('div', null,
          h('div', null, `成功 ${okN} 个。`),
          h('div', { class: 'code-block', style: { whiteSpace: 'pre-wrap' } }, lines.join('\n'))),
        okLabel: '知道了', cancelLabel: '关闭',
      });
    }
  }

  /** 批量动作里跳过的原因 → 人话（认不出来就原样显示，不吞成「未知」） */
  function skipReason(reason) {
    return ({
      not_found: '环境不存在',
      not_running: '环境没在跑（cookie 存在内核里，先启动）',
      no_proxy: '没绑代理，没有代理可检查',
      in_recycle_bin: '在回收站里（这条要用回收站页，不是归档）',
      already_archived: '本来就已经归档了',
      not_archived: '本来就没有归档',
      read_failed: '读取现况失败',
      not_in_sync: '不在同步会话里',
    })[reason] || String(reason);
  }

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
        api.list({
          limit: 200,
          page: 1,
          name: state.q || undefined,
          group_id: state.groupId || undefined,
          // 归档筛选：'' = 主列表（不含已归档）；only = 只看已归档；include = 全都算
          archived: state.archiveFilter || undefined,
        }),
        api.running(),
      ]);
      state.rows = listRes.list || [];
      state.total = listRes.total || state.rows.length;
      state.running = new Map((runRes.list || []).map((i) => [i.profile_id, i]));
      // 勾选跟着列表走：归档/删除之后那些 id 已经不在当前视图里了，
      // 留着会让下一次批量动作打到一个「看不见的环境」上
      const visible = new Set(state.rows.map((r) => r.profile_id));
      for (const id of [...state.selected]) if (!visible.has(id)) state.selected.delete(id);
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
    const arch = state.archiveFilter === 'only' ? ' · 只看已归档'
      : state.archiveFilter === 'include' ? ' · 含已归档' : '';
    mount(document.getElementById('count-sub'),
      `${state.total} 个环境${state.q ? `（含搜索：${state.q}）` : ''}${arch} · 运行中 ${n} 个 · 视图${densityOf(state.density).label}`);
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
        h('div', { class: 'row-main' },
          h('a', { href: `#/profiles/${id}` }, r.name),
          h('span', { class: 'muted small' }, `  #${r.profile_no}`),
          // 归档 ≠ 删除：标出来是因为它默认不在主列表里，用户得知道自己看的是哪批
          r.archived_at ? h('span', { class: 'muted small' }, '  ', pill('已归档', 'warn')) : null),
        r.remark ? h('div', { class: 'muted small row-sub' }, r.remark) : null),
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
        h('button', { class: 'btn sm ghost', onClick: () => exportOne(r) }, '导出'),
        ' ',
        h('button', { class: 'btn sm ghost', onClick: () => copyOne(r) }, '复制'),
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
        // 启动告警要让用户看见（巡检 2026-11-13 S3）：prefs 写失败时后端把原因放进 `warnings`，
        // 前端原来一个字都不读 —— 用户看到的是「设置页写着 5、行为却在恢复上次会话」。
        const warns = (r.warnings || []).map((w) => (w && w.message) || String(w)).filter(Boolean);
        if (warns.length) {
          toast(`注意：${warns.slice(0, 2).join('；')}${warns.length > 2 ? `（共 ${warns.length} 条，详见自检）` : ''}`, 'warn');
        }
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

  /* ------------------------ 批量菜单的 11 个动作 ------------------------ */

  /** 一个简单的结果抽屉（批量动作要能看到逐条结果，不能只弹一个 toast） */
  function resultDrawer(title, intro, rows, { footer } = {}) {
    return drawer({
      title,
      body: h('div', { class: 'stack' },
        intro ? h('div', { class: 'muted small' }, intro) : null,
        h('div', { class: 'code-block', style: { whiteSpace: 'pre-wrap', maxHeight: '52vh', overflow: 'auto' } },
          rows.join('\n') || '（没有明细）')),
      footer,
    });
  }

  /** 抽屉里的一个字段行 */
  const field = (label, control, hint) => h('label', { class: 'field' },
    h('span', { class: 'lbl' }, label),
    control,
    hint ? h('span', { class: 'muted small' }, hint) : null);

  /* ---- 1. 修改代理 ---- */
  function batchProxy() {
    const ids = picked();
    if (!ids) return;
    let mode = 'config';
    const type = h('select', null,
      h('option', { value: 'http' }, 'HTTP'),
      h('option', { value: 'https' }, 'HTTPS'),
      h('option', { value: 'socks5' }, 'SOCKS5'));
    const host = h('input', { type: 'text', placeholder: 'host 或 IP' });
    const port = h('input', { type: 'text', placeholder: '端口' });
    const user = h('input', { type: 'text', placeholder: '用户名（可空）' });
    const pass = h('input', { type: 'password', placeholder: '密码（可空）' });
    const preset = h('select', null, h('option', { value: '' }, '（加载代理列表中…）'));
    const manual = h('div', { class: 'stack' },
      h('div', { class: 'row' }, type, port),
      host, user, pass);
    const presetBox = h('div', { class: 'stack' }, preset);
    const clearNote = h('div', { class: 'notice' }, '勾选的这批环境会改成直连（不经过任何代理）。');
    // 用显示/隐藏切换，不重建 DOM —— 重建会把用户刚填的内容清掉
    const sync = () => {
      manual.style.display = mode === 'config' ? '' : 'none';
      presetBox.style.display = mode === 'preset' ? '' : 'none';
      clearNote.style.display = mode === 'clear' ? '' : 'none';
    };

    const modeSel = h('select', {
      onChange: (e) => { mode = e.target.value; sync(); },
    },
      h('option', { value: 'config' }, '手填一条代理'),
      h('option', { value: 'preset' }, '用代理管理里的某条'),
      h('option', { value: 'clear' }, '改成直连（不绑代理）'));

    const d = drawer({
      title: `修改代理（${ids.length} 个环境）`,
      body: h('div', { class: 'stack' },
        field('怎么做', modeSel),
        manual,
        presetBox,
        clearNote,
        h('div', { class: 'notice warn' }, `同一条代理套到 ${ids.length} 个环境，它们会共用同一个出口 IP —— 同 IP 多开是最容易被平台识别的信号。`)),
      footer: h('button', { class: 'btn primary', onClick: submit }, '改代理'),
    });
    sync();

    api.proxies().then((r) => {
      clear(preset);
      preset.appendChild(h('option', { value: '' }, '选一条代理'));
      for (const p of r.list || []) {
        preset.appendChild(h('option', { value: p.proxy_id }, `${p.remark || `${p.host}:${p.port}`}（${p.type}）`));
      }
    }).catch(() => {
      clear(preset);
      preset.appendChild(h('option', { value: '' }, '（代理列表读取失败）'));
    });

    async function submit() {
      let body;
      if (mode === 'clear') body = { clear: true };
      else if (mode === 'preset') {
        if (!preset.value) { toast('先选一条代理'); return; }
        body = { proxy_id: preset.value };
      } else {
        if (!host.value.trim() || !Number(port.value)) { toast('host 与端口必填', 'bad'); return; }
        body = {
          proxy_config: {
            proxy_type: type.value, host: host.value.trim(), port: Number(port.value),
            username: user.value.trim(), password: pass.value,
          },
        };
      }
      try {
        const r = await api.batchProxy(ids, body);
        d.close();
        reportBatch('修改代理', r, { okKey: 'changed', extra: r.restart_required ? '在运行的环境需要重启才生效' : '' });
        await load(false);
      } catch (e) { toast(`改代理失败：${e.message}`, 'bad'); }
    }
  }

  /* ---- 2. 修改 UA / 内核 ---- */
  async function batchUa() {
    const ids = picked();
    if (!ids) return;
    let kernels = [];
    try { kernels = (await api.kernels()).list || []; } catch { /* 取不到就让用户手填 */ }
    const kernelSel = h('select', null,
      ...kernels.map((k) => h('option', { value: k.kernel }, `${k.kernel}${k.is_downloaded === false ? '（未下载）' : ''}`)),
      kernels.length ? null : h('option', { value: '' }, '（没读本机内核，手填）'));
    const kernelInput = h('input', { type: 'text', placeholder: '如 157.0.8103.78（留空 = 用上面选的）' });
    const ua = h('textarea', { rows: 3, placeholder: '留空 = 按内核版本自动生成一条自洽的 UA' });

    const d = drawer({
      title: `修改 UA / 内核（${ids.length} 个环境）`,
      body: h('div', { class: 'stack' },
        field('内核版本', kernelSel),
        field('或手填内核版本', kernelInput),
        field('UA', ua, 'UA 里的 Chrome 大版本必须与内核一致，否则会报错（指纹不能自相矛盾）'),
        h('div', { class: 'notice' }, '改完的 UA / 内核在**下次启动**生效；正在跑的环境不会自动重启。')),
      footer: h('button', { class: 'btn primary', onClick: submit }, '改 UA / 内核'),
    });

    async function submit() {
      const body = {};
      const k = kernelInput.value.trim() || kernelSel.value;
      if (k) body.kernel_version = k;
      if (ua.value.trim()) body.ua = ua.value.trim();
      if (!body.kernel_version && !body.ua) { toast('内核版本或 UA 至少给一个', 'bad'); return; }
      try {
        const r = await api.batchUa(ids, body);
        d.close();
        reportBatch('修改 UA / 内核', r, { okKey: 'changed', extra: r.restart_required ? '在运行的环境需要重启才生效' : '' });
        await load(false);
      } catch (e) { toast(`改 UA 失败：${e.message}`, 'bad'); }
    }
  }

  /* ---- 3. 修改备注 ---- */
  function batchRemark() {
    const ids = picked();
    if (!ids) return;
    const mode = h('select', null,
      h('option', { value: 'replace' }, '覆盖（会删掉原来的备注）'),
      h('option', { value: 'append' }, '追加到末尾'),
      h('option', { value: 'prefix' }, '加到开头'),
      h('option', { value: 'suffix' }, '加到末尾（同追加）'));
    const text = h('textarea', { rows: 3, placeholder: '备注内容（覆盖模式留空 = 清空备注）' });
    const d = drawer({
      title: `修改备注（${ids.length} 个环境）`,
      body: h('div', { class: 'stack' },
        field('方式', mode),
        field('内容', text),
        h('div', { class: 'notice warn' }, '「覆盖」会把这批环境原来的备注整条替换掉，选之前想清楚。')),
      footer: h('button', { class: 'btn primary', onClick: submit }, '改备注'),
    });
    async function submit() {
      if (mode.value === 'replace' && !text.value.trim()) {
        const yes = await confirmDialog({ title: '确认清空备注', body: `会把 ${ids.length} 个环境的备注清空。`, okLabel: '清空', danger: true });
        if (!yes) return;
      }
      try {
        const r = await api.batchRemark(ids, { remark: text.value, mode: mode.value });
        d.close();
        reportBatch('修改备注', r, { okKey: 'changed' });
        await load(false);
      } catch (e) { toast(`改备注失败：${e.message}`, 'bad'); }
    }
  }

  /* ---- 4. 更新环境信息 ---- */
  /**
   * 4. 更新环境信息。
   *
   * **语义是我们自己定的，不是抄来的**：逆向 `28-` 号文里对手只留下一个名字
   * `updateUserInfo`，没有字段清单、没有行为证据。所以这里的「批量改哪几个字段」
   * 是 FreePower 的解释（见 README 与 17 号文档），别当对手行为引用。
   *
   * 因此界面上把**白名单十个字段全列出来**（勾了才发，空着 = 不改）：
   * 不能让人「勾完不知道改了啥」，也不能让人以为没列出来的字段也能在这里改。
   */
  const UPDATE_INFO_FIELDS = [
    { key: 'name', label: '环境名称', type: 'text' },
    { key: 'remark', label: '备注', type: 'text', hint: '整条覆盖；要追加用「修改备注」' },
    { key: 'group_id', label: '分组', type: 'select' },
    { key: 'domain_name', label: '域名', type: 'text' },
    { key: 'open_urls', label: '启动时打开的网址', type: 'textarea', hint: '每行一个' },
    { key: 'username', label: '内置账号', type: 'text' },
    { key: 'password', label: '内置密码', type: 'password' },
    { key: 'fakey', label: '2FA 密钥', type: 'text' },
    { key: 'platform_account', label: '平台账号（JSON）', type: 'textarea' },
    { key: 'profile_tag_ids', label: '标签 id', type: 'text', hint: '逗号分隔；批量改标签容易串，建议用环境编辑页' },
  ];

  function batchUpdateInfo() {
    const ids = picked();
    if (!ids) return;
    const inputs = new Map();

    const rows = UPDATE_INFO_FIELDS.map((f) => {
      const box = h('input', { type: 'checkbox', 'data-field': f.key });
      let input;
      if (f.type === 'select') {
        input = h('select', { disabled: 'disabled' },
          h('option', { value: '' }, '（选一个分组）'),
          ...state.groups.map((g) => h('option', { value: g.id }, g.name)));
      } else if (f.type === 'textarea') {
        input = h('textarea', { rows: 2, disabled: 'disabled', placeholder: f.hint || '' });
      } else {
        input = h('input', { type: f.type, disabled: 'disabled', placeholder: f.hint || '' });
      }
      box.addEventListener('change', () => {
        if (box.checked) input.removeAttribute('disabled'); else input.setAttribute('disabled', 'disabled');
      });
      inputs.set(f.key, { box, input, type: f.type });
      return h('tr', null,
        h('td', null, h('label', { class: 'checks' }, box, h('span', null, f.label))),
        h('td', null, input),
        h('td', { class: 'muted small mono' }, f.key));
    });

    const d = drawer({
      title: `更新环境信息（${ids.length} 个环境）`,
      body: h('div', { class: 'stack' },
        h('div', { class: 'notice' }, '勾上才会改，没勾的字段**原样不动**。这里是整条覆盖，不是追加。'),
        h('table', { class: 'grid' },
          h('thead', null, h('tr', null,
            h('th', null, '改这个字段'), h('th', null, '新值'), h('th', null, '接口字段'))),
          h('tbody', null, ...rows)),
        h('div', { class: 'muted small' },
          `白名单就是上面这 ${UPDATE_INFO_FIELDS.length} 个。指纹、UA / 内核、代理、扩展都有专门的入口 —— `
          + '批量入口不给它们开口子，一个手滑就改掉一批指纹的代价太大。'),
        h('div', { class: 'muted small' },
          '「更新环境信息」这个动作名来自对手（28-号文只给了名字 `updateUserInfo`），'
          + '**它到底改哪些字段没有证据**，所以上面的字段表是我们自己的解释。')),
      footer: h('button', { class: 'btn primary', onClick: submit }, '更新'),
    });

    async function submit() {
      const fields = {};
      const bad = [];
      for (const [key, { box, input, type }] of inputs) {
        if (!box.checked) continue;
        const raw = String(input.value ?? '');
        if (type === 'select') {
          if (!raw) { bad.push(key); continue; }
          fields[key] = raw;
        } else if (type === 'textarea' && key === 'open_urls') {
          const lines = raw.split('\n').map((x) => x.trim()).filter(Boolean);
          if (!lines.length) { bad.push(key); continue; }
          fields[key] = lines;
        } else if (type === 'textarea' && key === 'platform_account') {
          const t = raw.trim();
          if (!t) { bad.push(key); continue; }
          try {
            fields[key] = JSON.parse(t);
          } catch {
            toast('平台账号要填 JSON（例如 {"fb":"user"}）', 'bad');
            return;
          }
        } else if (key === 'profile_tag_ids') {
          const list = raw.split(',').map((x) => x.trim()).filter(Boolean);
          if (!list.length) { bad.push(key); continue; }
          fields[key] = list;
        } else {
          // 勾了但留空：name / remark 允许清空（显式传空串），其余字段留空视为没填
          if (!raw.trim()) {
            if (key === 'name' || key === 'remark') fields[key] = '';
            else bad.push(key);
            continue;
          }
          fields[key] = raw;
        }
      }
      if (bad.length) {
        toast(`勾了但没填值：${bad.map((k) => UPDATE_INFO_FIELDS.find((f) => f.key === k)?.label || k).join('、')}`, 'bad');
        return;
      }
      if (!Object.keys(fields).length) { toast('至少勾一项'); return; }
      const overwriteName = 'name' in fields;
      const yes = await confirmDialog({
        title: '确认更新环境信息',
        body: h('div', { class: 'stack' },
          h('div', null, `会改这 ${ids.length} 个环境的 ${Object.keys(fields).length} 个字段：${Object.keys(fields).join('、')}。`),
          overwriteName ? h('div', { class: 'notice warn' }, '环境名称是整条覆盖：填什么就是什么。') : null,
          h('div', { class: 'muted small' }, '没勾的字段一个都不动。')),
        okLabel: '更新',
      });
      if (!yes) return;
      try {
        const r = await api.batchUpdateInfo(ids, fields);
        d.close();
        reportBatch('更新环境信息', r, { okKey: 'changed', extra: r.ignored_fields?.length ? `忽略字段：${r.ignored_fields.join(', ')}` : '' });
        await load(false);
      } catch (e) { toast(`更新失败：${e.message}`, 'bad'); }
    }
  }

  /* ---- 5. 批量归档 / 6. 批量恢复 / 7. 批量删除 ---- */
  async function batchArchive() {
    const ids = picked();
    if (!ids) return;
    const yes = await confirmDialog({
      title: '批量归档',
      body: h('div', { class: 'stack' },
        h('div', null, `把这 ${ids.length} 个环境移出主列表。`),
        h('div', { class: 'notice' }, '归档**不是删除**：cookie、user-data、绑定的代理全都原样保留，随时能启动、能编辑。'),
        h('div', { class: 'muted small' }, '归档的看「只看已归档」这一个筛选；要彻底删掉才用「批量删除」或回收站。')),
      okLabel: '归档',
    });
    if (!yes) return;
    try {
      const r = await api.batchArchive(ids);
      reportBatch('归档', r, { okKey: 'archived' });
      await load(false);
    } catch (e) { toast(`归档失败：${e.message}`, 'bad'); }
  }

  async function batchUnarchive() {
    const ids = picked();
    if (!ids) return;
    try {
      const r = await api.batchUnarchive(ids);
      reportBatch('从归档恢复', r, { okKey: 'restored' });
      await load(false);
    } catch (e) { toast(`恢复失败：${e.message}`, 'bad'); }
  }

  async function batchDelete() {
    const ids = picked();
    if (!ids) return;
    const yes = await confirmDialog({
      title: '批量删除',
      body: h('div', { class: 'stack' },
        h('div', null, `把这 ${ids.length} 个环境移入回收站。`),
        h('div', { class: 'notice' }, '环境会移入回收站：可以随时恢复，user-data 目录（cookie、登录态）原样留在盘上。'),
        h('div', { class: 'muted small' }, '正在运行的环境会先停止。')),
      okLabel: '移入回收站', danger: true,
    });
    if (!yes) return;
    try {
      const r = await api.remove(ids);
      toast(`已移入回收站 ${(r.deleted || []).length} 个（可在「回收站」里恢复）`, 'ok');
      state.selected.clear();
      await load(false);
    } catch (e) { toast(`删除失败：${e.message}`, 'bad'); }
  }

  /* ---- 8. 显示窗口 ---- */
  async function batchShow(force = false) {
    const ids = force ? (state.lastShowIds || []) : picked();
    if (!ids || !ids.length) return;
    try {
      const r = await api.batchShow(ids, force);
      const rows = (r.shown || []).map((x) => {
        const who = String(x.profile_id || '').slice(0, 8);
        if (x.raise === 'restored') return `✓ ${who}：已恢复显示并尝试置前`;
        if (x.raise === 'page_only') return `· ${who}：只做了页面级激活（可能仍被其它窗口盖住）`;
        return `${x.ok ? '·' : '✗'} ${who}：${x.reason || '没有动作'}`;
      });
      for (const s of r.skipped || []) rows.push(`- 跳过 ${String(s.profile_id).slice(0, 8)}：${skipReason(s.reason)}`);
      state.lastShowIds = ids;
      const summary = r.summary || {};
      // 文案边界：零依赖下「被盖住」的窗口抬不动，所以只能说「已恢复显示并尝试置前」
      const intro = force
        ? `${summary.message || ''}（能确认的是窗口已恢复正常，确认不了它是否在最前面）`
        : `${summary.message || ''}${summary.page_only ? '。要让被盖住的窗口真的到前面，点下面的「强制抬到前台（会闪一下）」' : ''}`;
      resultDrawer(force ? '强制抬到前台' : '显示窗口', intro, rows, {
        footer: (!force && summary.page_only)
          ? h('button', { class: 'btn', onClick: () => batchShow(true) }, '强制抬到前台（会闪一下）')
          : null,
      });
    } catch (e) { toast(`显示窗口失败：${e.message}`, 'bad'); }
  }

  /* ---- 9. 检查代理 ---- */
  async function batchCheckProxy() {
    const ids = picked();
    if (!ids) return;
    const d = drawer({ title: `检查代理（${ids.length} 个环境）`, body: h('div', { class: 'muted small' }, '正在逐条检查（限并发 3、单条 10 秒超时）…') });
    try {
      const r = await api.batchCheckProxy(ids);
      d.close();
      const rows = (r.list || []).map((x) => {
        const who = `${String(x.profile_id).slice(0, 8)}${x.name ? ` ${x.name}` : ''}`;
        const px = x.proxy ? `${x.proxy.proxy_type}://${x.proxy.host}:${x.proxy.port}` : '直连';
        if (x.outcome === 'ok') return `✓ ${who}　${px}　出口 ${x.ip || '?'} ${x.country || ''}　${x.latency_ms}ms`;
        if (x.outcome === 'timeout') return `⌛ ${who}　${px}　超时（${x.timeout_seconds} 秒内没完成握手）`;
        if (x.outcome === 'direct') return `· ${who}　${x.error_label}`;
        return `✗ ${who}　${px}　${x.error_label || x.error || '失败'}`;
      });
      const intro = `成功 ${r.ok} · 失败 ${r.fail} · 超时 ${r.timeout}${r.direct ? ` · 直连 ${r.direct}` : ''}（限并发 ${r.concurrency}，单条 ${r.timeout_seconds} 秒，用时 ${r.elapsed_ms}ms）`;
      resultDrawer('检查代理结果', intro, rows);
      if (r.fail || r.timeout) toast(`有 ${r.fail + r.timeout} 个代理不可用（明细已列出）`, 'bad');
      else if (r.ok) toast(`代理检查通过：${r.ok} 个`, 'ok');
    } catch (e) {
      d.close();
      toast(`检查代理失败：${e.message}`, 'bad');
    }
  }

  /* ---- 10 / 11. 还原 Cookie（覆盖）/ 合并 Cookie（并集） ---- */
  async function batchCookie(mode) {
    const ids = picked();
    if (!ids) return;
    const file = await pickFile('.json,.txt,application/json,text/plain');
    if (!file) return;
    const text = await file.text();
    const isTxt = /\.txt$/i.test(file.name) || !/^\s*[[{]/.test(text);
    let body;
    if (isTxt) {
      body = { format: 'netscape', content: text };
    } else {
      let parsed;
      try { parsed = JSON.parse(text); } catch (e) { toast(`JSON 解析失败：${e.message}`, 'bad'); return; }
      const list = Array.isArray(parsed) ? parsed
        : Array.isArray(parsed?.cookies) ? parsed.cookies
          : Array.isArray(parsed?.list) ? parsed.list
            : Array.isArray(parsed?.data?.cookies) ? parsed.data.cookies : null;
      if (!list) { toast('文件里没有 cookie 数组（支持裸数组 / {cookies} / {list}）', 'bad'); return; }
      body = { cookies: list };
    }
    const label = mode === 'restore' ? '还原 Cookie（覆盖）' : '合并 Cookie（并集）';
    try {
      // 第一步：**只算不写**。必须先让用户看到会加几条/改几条/删几条
      const pv = await api.batchCookie(ids, { ...body, mode, preview: true });
      const s = pv.summary || {};
      const lines = (pv.list || []).map((x) => `· ${String(x.profile_id).slice(0, 8)}${x.name ? ` ${x.name}` : ''}：现有 ${x.existing_total} 条 → 加 ${x.will_add} / 改 ${x.will_update} / 删 ${x.will_delete}${x.will_keep ? ` / 保留现有 ${x.will_keep}` : ''}`);
      for (const sk of pv.skipped || []) lines.push(`- 跳过 ${String(sk.profile_id).slice(0, 8)}：${skipReason(sk.reason)}`);
      const yes = await confirmDialog({
        title: `${label} · 预览`,
        body: h('div', { class: 'stack' },
          h('div', null, `合计：新增 ${s.will_add || 0} 条、修改 ${s.will_update || 0} 条、删除 ${s.will_delete || 0} 条${s.will_keep ? `、保留现有 ${s.will_keep} 条` : ''}。`),
          mode === 'restore'
            ? h('div', { class: 'notice warn' }, '「还原」是**覆盖**：写完以文件为准，文件里没有的 cookie 会被删掉。')
            : h('div', { class: 'notice' }, '「合并」是**并集**：只补文件里有、环境里没有的；同名以环境现有为准，不会覆盖登录态。'),
          h('div', { class: 'code-block', style: { whiteSpace: 'pre-wrap', maxHeight: '40vh', overflow: 'auto' } }, lines.join('\n') || '（没有明细）'),
          h('div', { class: 'muted small' }, '预览里不显示 cookie 的值（那是登录凭据）。')),
        okLabel: `确认${mode === 'restore' ? '覆盖' : '合并'}`,
        danger: mode === 'restore',
      });
      if (!yes) { toast('已取消，一条都没写'); return; }
      // 第二步：真写
      const r = await api.batchCookie(ids, { ...body, mode, preview: false });
      const rows = (r.list || []).map((x) => `✓ ${String(x.profile_id).slice(0, 8)}${x.name ? ` ${x.name}` : ''}：写入 ${x.written} 条、删除 ${x.deleted} 条、回读确认 ${x.verified ?? '?'} 条${x.write_failed ? `、失败 ${x.write_failed}` : ''}${(x.warnings || []).length ? `\n   ⚠ ${x.warnings.join('；')}` : ''}`);
      for (const sk of r.skipped || []) rows.push(`- 跳过 ${String(sk.profile_id).slice(0, 8)}：${skipReason(sk.reason)}${sk.error_message ? `（${sk.error_message}）` : ''}`);
      resultDrawer(`${label} · 结果`, `${(r.summary || {}).applied} 个环境已处理`, rows);
    } catch (e) { toast(`${label}失败：${e.message}`, 'bad'); }
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

  /* ------------------------ 导入 / 导出 / 复制（P10） ------------------------ */

  async function importFile() {
    const file = await pickFile('.json,.txt,application/json,text/plain');
    if (!file) return;
    const text = await file.text();
    // .txt（AdsPower 块格式）不是 JSON：按扩展名或首字符判断，别拿 JSON.parse 去硬解
    const isTxt = /\.txt$/i.test(file.name) || !/^\s*[[{]/.test(text);
    if (isTxt) {
      try {
        const r = await api.importProfilesTxt(text);
        reportImport(r);
        await load(false);
      } catch (e) { toast(`导入失败：${e.message}`, 'bad'); }
      return;
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { toast(`JSON 解析失败：${e.message}`, 'bad'); return; }
    const list = Array.isArray(parsed) ? parsed
      : Array.isArray(parsed?.list) ? parsed.list
        : Array.isArray(parsed?.data?.list) ? parsed.data.list : null;
    if (!list) { toast('文件里没有 list 数组（支持 {list} / {data:{list}} / 裸数组）', 'bad'); return; }
    try {
      const r = await api.importProfiles(list);
      reportImport(r);
      await load(false);
    } catch (e) { toast(`导入失败：${e.message}`, 'bad'); }
  }

  function reportImport(r) {
    const bits = [`导入完成：成功 ${r.imported} 条`];
    if (r.failed?.length) bits.push(`失败 ${r.failed.length} 条`);
    if (r.warnings?.length) bits.push(`${r.warnings.length} 条告警`);
    toast(bits.join(' · '), r.failed?.length ? 'bad' : 'ok');
    if (r.failed?.length || r.warnings?.length) showImportDetail(r);
  }

  /** AdsPower `.txt` 互操作导出（当前勾选的，或筛选出来的全部） */
  async function exportTxt() {
    const rows = state.selected.size
      ? state.rows.filter((r) => state.selected.has(r.profile_id))
      : filtered();
    if (!rows.length) { toast('没有可导出的环境'); return; }
    try {
      const d = await api.exportProfiles(rows.map((r) => r.profile_id), 'txt');
      downloadText(d.filename || 'profiles.txt', d.content, 'text/plain');
      const bits = [`已导出 ${d.count} 个环境为 AdsPower .txt`];
      if (d.warnings?.length) bits.push(d.warnings.join('；'));
      toast(bits.join(' · '), 'ok');
    } catch (e) { toast(`导出失败：${e.message}`, 'bad'); }
  }

  function showImportDetail(r) {
    const lines = [];
    for (const f of r.failed || []) lines.push(`✗ 第 ${Number(f.index) + 1} 条：${f.reason}`);
    for (const w of r.warnings || []) lines.push(`- ${w}`);
    confirmDialog({
      title: '导入结果',
      body: h('div', null,
        h('div', null, `成功 ${r.imported} 条${r.failed?.length ? `，失败 ${r.failed.length} 条` : ''}。`),
        h('div', { class: 'code-block', style: { whiteSpace: 'pre-wrap' } }, lines.join('\n') || '（没有问题）')),
      okLabel: '知道了', cancelLabel: '关闭',
    });
  }

  async function exportOne(r) {
    try {
      const d = await api.exportProfiles([r.profile_id]);
      const safe = String(r.name || 'profile').replace(/[\\/:*?"<>|]/g, '_');
      downloadText(`freepower-${r.profile_no}-${safe}.json`, JSON.stringify({ list: d.list }, null, 2));
      toast(`已导出 ${r.name}（含指纹与代理，代理密码原样）`, 'ok');
    } catch (e) { toast(`导出失败：${e.message}`, 'bad'); }
  }

  async function copyOne(r) {
    const name = await promptDialog({
      title: '复制环境',
      label: '新环境名称',
      value: `${r.name}-copy`,
      okLabel: '复制',
    });
    if (name === null) return;
    try {
      const c = await api.copyProfile(r.profile_id, name || undefined);
      toast(`已复制为 ${c.name}：配置一致，${c.seeds_regenerated ? '四个指纹种子已重生' : '种子状态未知'}`, 'ok');
      await load(false);
    } catch (e) { toast(`复制失败：${e.message}`, 'bad'); }
  }

  async function removeOne(r) {
    const live = state.running.has(r.profile_id);
    const yes = await confirmDialog({
      title: '删除环境',
      body: h('div', { class: 'stack' },
        h('div', null, '即将删除 ', h('strong', null, r.name), `（#${r.profile_no}）`),
        live ? h('div', { class: 'notice warn' }, '该环境正在运行：会先停止浏览器，再删除。') : null,
        // 文案必须跟真实行为一致：这里是**软删除**（进回收站），user-data 目录留在盘上。
        // 早先这里写的是「本地硬删，不可恢复」，那是错的 —— 用户会以为删了就找不回来。
        h('div', { class: 'notice' }, '环境会移入回收站：可以随时恢复，user-data 目录（cookie、登录态）原样留在盘上。'),
        h('div', { class: 'muted small' }, '回收站里的环境目前不会自动清理（对手写的是「保留 30 天」）。要腾磁盘，去回收站里彻底删除。')),
      okLabel: '移入回收站', danger: true,
    });
    if (!yes) return;
    try {
      await api.remove([r.profile_id]);
      toast(`已移入回收站：${r.name}（可在「回收站」里恢复）`, 'ok');
    } catch (e) { toast(`删除失败：${e.message}`, 'bad'); }
    state.selected.delete(r.profile_id);
    await load(false);
  }
}