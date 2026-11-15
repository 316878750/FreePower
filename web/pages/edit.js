/**
 * 环境编辑：11 组分栏 + 值域校验。
 *
 * 两条硬规矩：
 *   1. 字段清单、值域、必填全来自 /browser-profile/schema（后端注册表），前端不抄第二份；
 *   2. 校验文案全部来自后端 /browser-profile/validate（和 create/update 同一个 validateProfile），
 *      前端只负责把 errors[].field 定位到那个输入框，不自己编一句话。
 */
import { h, mount, clear, toast, debounce, drawer, confirmDialog, downloadText, pickFile } from '../ui.js';
import { api } from '../api.js';

const COUNTRIES = [
  ['US', '美国'], ['GB', '英国'], ['DE', '德国'], ['FR', '法国'], ['JP', '日本'],
  ['SG', '新加坡'], ['HK', '香港'], ['TW', '台湾'], ['CN', '中国'], ['BR', '巴西'],
  ['VN', '越南'], ['TH', '泰国'], ['ID', '印尼'],
];

const state = {
  schema: null,
  groups: [],
  tags: [],
  proxies: [],
  model: {},
  rawJson: {},
  active: 'identity',
  refs: {},
  editing: null,
  dirty: false,
  lastCheck: null,
  busy: false,
  touched: new Set(),
  // 新建时也要发出去的「环境身份」字段；其余字段留给后端生成器
  core: new Set(['name', 'group_id', 'remark', 'domain_name', 'open_urls', 'cookie', 'profile_tag_ids']),
};

export default async function renderEdit({ head, page, params }) {
  mount(head, h('h1', null, '加载中…'));
  mount(page, h('div', { class: 'muted' }, '正在取字段表…'));
  state.active = 'identity';
  state.refs = {};
  state.rawJson = {};
  state.dirty = false;
  state.lastCheck = null;
  state.touched = new Set();
  state.snapCount = undefined;

  const [schema, groups, tags, proxies, apps] = await Promise.all([
    api.schema(),
    api.groups().catch(() => ({ list: [] })),
    api.tags().catch(() => ({ list: [] })),
    api.proxies().catch(() => ({ list: [] })),
    api.apps().catch(() => ({ list: [] })),
  ]);
  state.schema = schema;
  state.groups = groups.list || [];
  state.tags = tags.list || [];
  state.proxies = proxies.list || [];
  state.apps = apps.list || [];

  const id = params.id;
  state.editing = id || null;
  state.model = id ? await loadProfile(id) : newProfile();
  /**
   * 这个环境勾了哪些扩展。**不是** profile 表里的字段（扩展是独立的库 + 关系表，
   * 见 src/store/extensions.js），所以单独取、单独存，不进 buildPayload。
   */
  state.extIds = new Set();
  if (id) {
    const owned = await api.appForProfile(id).catch(() => null);
    for (const x of (owned?.ext_ids || [])) state.extIds.add(String(x));
  }
  // 运行状态以运行时注册表为准（profile.status 是库里的快照，内核崩了会滞后）
  state.running = false;
  if (id) {
    const live = await api.running().catch(() => ({ list: [] }));
    state.running = (live.list || []).some((i) => i.profile_id === id);
  }

  const title = id ? `编辑环境 #${state.model.profile_no || ''}` : '新建环境';
  const saveLabel = !id ? '创建环境' : state.running ? '保存并重启' : '保存修改';
  const saveBtn = h('button', { class: 'btn primary', onClick: save }, saveLabel);
  mount(head,
    h('h1', null, title),
    h('span', { class: 'sub', id: 'dirty-flag' }, ''),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn', onClick: () => { location.hash = '#/profiles'; } }, '返回列表'),
    saveBtn);

  const checkBox = h('div', { class: 'stack' });
  const tabBar = h('div', { class: 'tabs' });
  const formArea = h('div', { class: 'panel-body' });

  mount(page,
    h('div', { class: 'stack' },
      state.running
        ? h('div', { class: 'notice info' },
          h('div', null, h('strong', null, '这个环境正在运行')),
          h('div', null, '代理 / 时区 / 指纹的改动要重启内核才生效。点「保存并重启」会先停掉当前内核、落库、再按新配置启动；重启期间该环境会短暂离线，页面会重新加载。'))
        : null,
      unsupportedSummary(),
      checkBox,
      h('div', { class: 'panel' }, tabBar, formArea)));

  paintTabs(tabBar, formArea);
  runCheck();

  function markDirty() {
    state.dirty = true;
    mount(document.getElementById('dirty-flag'), '有未保存的修改');
  }

  function setValue(name, value) {
    state.model[name] = value;
    state.touched.add(name);
    markDirty();
    scheduleCheck();
  }

  const scheduleCheck = debounce(() => { runCheck(); }, 500);

  async function runCheck() {
    const payload = buildPayload();
    try {
      const r = await api.validate(payload, state.editing ? 'update' : 'create');
      state.lastCheck = r;
      paintCheck(checkBox);
      paintFieldErrors(r);
    } catch (e) {
      mount(checkBox, h('div', { class: 'notice bad' }, `校验接口调用失败：${e.message}`));
    }
  }

  function paintCheck(box) {
    const r = state.lastCheck;
    if (!r) { mount(box, ''); return; }
    const errs = r.errors || [];
    const warns = r.warnings || [];
    const kids = [];
    if (errs.length) {
      kids.push(h('div', { class: 'notice bad' },
        h('div', null,
          h('strong', null, `${errs.length} 个字段不合法`),
          h('span', { class: 'muted' }, '（后端校验原文，保存会被拒）')),
        h('ul', null, errs.slice(0, 8).map((e) => h('li', null, h('span', { class: 'mono' }, e.field), ' — ', e.message))),
        errs.length > 8 ? h('div', { class: 'muted small' }, `…还有 ${errs.length - 8} 条`) : null));
    }
    if (warns.length) {
      kids.push(h('div', { class: 'notice warn' },
        h('div', null, h('strong', null, `${warns.length} 条一致性提醒`), h('span', { class: 'muted' }, '（软告警，不拦保存）')),
        h('ul', null, warns.slice(0, 6).map((w) => h('li', null,
          h('span', { class: `pill ${w.severity === 'hard' ? 'bad' : 'warn'}` }, w.severity === 'hard' ? '硬冲突' : '软提醒'),
          ' ', h('span', { class: 'mono' }, w.field || ''), ' — ', w.message))),
        warns.length > 6 ? h('div', { class: 'muted small' }, `…还有 ${warns.length - 6} 条`) : null));
    }
    if (!kids.length) {
      kids.push(h('div', { class: 'notice ok' }, '校验通过：没有硬冲突，也没有软告警。'));
    }
    mount(box, ...kids);
  }

  function paintFieldErrors(r) {
    for (const wrap of Object.values(state.refs)) {
      wrap.classList.remove('has-error');
      const el = wrap.querySelector('.field-error');
      if (el) { el.textContent = ''; el.style.display = 'none'; }
    }
    const byField = new Map();
    for (const e of (r.errors || [])) {
      const root = String(e.field || '').split('.')[0];
      if (!byField.has(root)) byField.set(root, []);
      byField.get(root).push(e);
    }
    for (const [name, list] of byField) {
      const wrap = state.refs[name];
      if (!wrap) continue;
      wrap.classList.add('has-error');
      const el = wrap.querySelector('.field-error');
      if (el) {
        el.style.display = 'block';
        el.textContent = list.map((e) => e.message).join('；');
      }
    }
  }

  /* ------------------------------ 渲染 ------------------------------ */

  /**
   * 页面顶部的汇总：「本页 N 项在本版不可用」。
   *
   * 为什么要这一条：48 个假字段修完之后，界面上会出现一批灰格子。用户不该靠逐个去找
   * 哪格是灰的 —— 先告诉他总数，再让他按需看某一格旁边的理由。
   */
  function unsupportedSummary() {
    const all = state.schema?.fields || [];
    const off = all.filter((f) => f.disabled);
    if (!off.length) return null;
    return h('div', { class: 'notice warn' },
      h('div', null,
        h('strong', null, `本页 ${off.length} 项在本版不可用`),
        h('span', { class: 'muted' }, `（共 ${all.length} 项字段；灰显的每一项旁边都写了原因，不用悬停）`)),
      h('div', { class: 'muted small' },
        '这些字段仍然能被 API 读写、也会存进库（导入导出的字段映射不变），只是本版不会因为它们改变浏览器行为。'));
  }

  function paintTabs(tabBar, formArea) {
    clear(tabBar);
    for (const g of state.schema.groups) {
      const off = g.fields.filter((f) => f.disabled).length;
      tabBar.appendChild(h('button', {
        class: `tab ${state.active === g.id ? 'active' : ''}`,
        onClick: () => { state.active = g.id; paintTabs(tabBar, formArea); },
      }, g.label,
        h('span', { class: 'cnt' }, String(g.total)),
        off ? h('span', { class: 'cnt off' }, `${off} 项不可用`) : null));
    }
    /*
     * 「备份」不是字段分组，是独立的一块（0.4.7 ②）：它改的不是指纹配置，
     * 而是「这个环境存过几份、能不能退回去」。新建环境时还没有 id，所以不给这一页。
     */
    if (state.editing) {
      tabBar.appendChild(h('button', {
        class: `tab ${state.active === '__backup' ? 'active' : ''}`,
        onClick: () => { state.active = '__backup'; paintTabs(tabBar, formArea); },
      }, '备份快照',
        state.snapCount !== undefined ? h('span', { class: 'cnt' }, String(state.snapCount)) : null));
    }
    paintGroup(formArea);
  }

  /** 重画当前分组（联动禁用要跟着「窗口位置」的改动即时变化） */
  function repaintGroup() {
    if (state.formArea) paintGroup(state.formArea);
  }

  function paintGroup(formArea) {
    const g = state.schema.groups.find((x) => x.id === state.active);
    state.refs = {};
    state.formArea = formArea;
    clear(formArea);
    if (state.active === '__backup') { paintBackup(formArea); return; }
    if (!g) return;
    const grid = h('div', { class: 'form-grid' });
    const basics = g.fields.filter((f) => f.basic);
    const advanced = g.fields.filter((f) => !f.basic);

    if (g.id === 'identity') grid.appendChild(countryField());
    if (g.id === 'identity') grid.appendChild(groupField());
    if (g.id === 'identity') grid.appendChild(tagsField());
    if (g.id === 'identity') grid.appendChild(appField());
    if (g.id === 'network') grid.appendChild(proxyField());
    if (g.id === 'network') grid.appendChild(ipOriginField());
    for (const f of basics) grid.appendChild(field(f));
    formArea.appendChild(grid);

    if (advanced.length) {
      const advGrid = h('div', { class: 'form-grid' });
      for (const f of advanced) advGrid.appendChild(field(f));
      formArea.appendChild(h('details', { class: 'advanced' },
        h('summary', null, `高级字段（${advanced.length} 个，脚本旋钮，平时不用动）`),
        advGrid));
    }
    if (state.lastCheck) paintFieldErrors(state.lastCheck);
  }

  /* ------------------------------ 备份快照（0.4.7 ②） ------------------------------
   *
   * 这一页只做三件事：拍一份、恢复一份、删一份。所有文案都从服务端 `scope` 里取
   * （「包含什么、不包含什么」只有一份事实源，界面不另写一遍）。
   *
   * 恢复是**破坏性**的，所以画面上必须写清楚三句：会覆盖什么、会先自动留一份、恢复后要重新登录。
   */
  async function paintBackup(box) {
    mount(box, h('div', { class: 'muted' }, '正在读取快照…'));
    let data;
    try {
      data = await api.snapshotList(state.editing);
    } catch (e) {
      mount(box, h('div', { class: 'notice bad' }, `读取快照失败：${e.message}`));
      return;
    }
    state.snapCount = data.count;
    // 标签上的计数也跟着变（不整页重画，只改那个数字）
    const tab = [...tabBar.querySelectorAll('.tab')].find((b) => b.textContent.startsWith('备份快照'));
    if (tab) {
      let cnt = tab.querySelector('.cnt');
      if (!cnt) { cnt = h('span', { class: 'cnt' }); tab.appendChild(cnt); }
      cnt.textContent = String(data.count);
    }

    const fmtBytes = (b) => (b === null || b === undefined ? '—' : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
    const list = data.list || [];

    const rows = list.map((s) => h('tr', null,
      h('td', { class: 'muted small' }, (s.taken_at || '').slice(0, 19).replace('T', ' ')),
      h('td', null, s.reason_label || s.reason),
      h('td', { class: 'num' }, fmtBytes(s.includes?.userdata_bytes || 0)),
      h('td', { class: 'small' }, s.includes?.userdata
        ? `记录 + 数据（${s.includes.userdata_files} 个文件）`
        : '仅记录（拍的时候没有数据目录）'),
      h('td', { class: 'actions' },
        h('button', { class: 'btn sm', onClick: () => restoreOne(s) }, '恢复'),
        ' ',
        h('button', { class: 'btn sm ghost danger', onClick: () => deleteOne(s) }, '删除'))));

    const scope = data.scope || { included: [], excluded: [] };
    const body = h('div', { class: 'stack' },
      h('div', { class: 'toolbar' },
        h('div', null,
          h('strong', null, '本地备份快照'),
          h('span', { class: 'muted small' }, `　最多保留 ${data.keep} 份，第 ${data.keep + 1} 份会挤掉最旧的那份`)),
        h('span', { class: 'spacer' }),
        h('span', { class: 'muted small' }, `当前 ${data.count} 份，共 ${fmtBytes(data.usage?.bytes || 0)}`),
        h('button', { class: 'btn sm primary', onClick: createOne }, '现在备份一份')),
      h('div', { class: 'notice' },
        h('div', null, h('strong', null, '快照里有什么：')),
        h('ul', null, ...scope.included.map((x) => h('li', null, x))),
        h('div', null, h('strong', null, '没有什么：')),
        h('ul', null, ...scope.excluded.map((x) => h('li', null, x)))),
      state.running
        ? h('div', { class: 'notice warn' },
          '环境正在运行：',
          h('strong', null, '可以备份'),
          '（现在这份就是运行中的样子），但',
          h('strong', null, '不能恢复'),
          '，恢复前先停止。')
        : null,
      list.length
        ? h('table', { class: 'grid' },
          h('thead', null, h('tr', null,
            h('th', { style: { width: '170px' } }, '时间'),
            h('th', { style: { width: '150px' } }, '类型'),
            h('th', { style: { width: '90px' } }, '大小'),
            h('th', null, '内容'),
            h('th', { style: { width: '150px' } }, '操作'))),
          h('tbody', null, ...rows))
        : h('div', { class: 'empty' }, '还没有快照。点「现在备份一份」把当前状态存下来。'),
      h('div', { class: 'muted small', style: { marginTop: '8px' } },
        '快照存在数据目录的 snapshots 下，和库文件同一块盘。它救的是「环境被改坏 / 数据被误删」，'
        + '不是「整块硬盘坏了」——后者要靠系统备份。'));
    mount(box, body);

    async function refresh() {
      await paintBackup(box);
    }

    async function createOne() {
      try {
        const r = await api.snapshotCreate(state.editing, 'manual');
        const ev = r.evicted || [];
        const bad = ev.filter((x) => x.removed !== true);
        toast(`已备份一份（${r.list.length} 份）${ev.length ? `，挤掉最旧 1 份` : ''}${bad.length ? `，但有 ${bad.length} 份没删掉（暂时超过上限）` : ''}`,
          bad.length ? 'warn' : 'ok');
        await refresh();
      } catch (e) { toast(`备份失败：${e.message}`, 'bad'); }
    }

    async function restoreOne(s) {
      if (state.running) { toast('环境正在运行，先停止再恢复', 'bad'); return; }
      const yes = await confirmDialog({
        title: '从快照恢复 · 确认',
        body: h('div', { class: 'stack' },
          h('div', null, `把 #${state.model.profile_no || ''} 恢复成 ${(s.taken_at || '').slice(0, 19).replace('T', ' ')} 那一刻的样子？`),
          h('div', { class: 'notice bad' },
            h('strong', null, '这会覆盖当前状态'),
            '：cookie / 登录态、LocalStorage、书签、指纹配置、UA、代理全部变成快照里那份。'),
          h('div', { class: 'notice' },
            '恢复前会',
            h('strong', null, '自动先给当前状态留一份快照'),
            '（排在列表第一行，类型「恢复前自动留存」），所以恢复到错的快照还能再退回来。'),
          h('div', { class: 'muted small' },
            '恢复完要重新启动环境才生效；如果快照是很久以前的，登录态可能已经过期，需要重新登录。')),
        okLabel: '确认恢复', danger: true,
      });
      if (!yes) return;
      try {
        const r = await api.snapshotRestore(state.editing, s.snap_id);
        toast(r.verified
          ? `已恢复，逐列核对通过${r.before_snapshot ? '（当前状态已自动存为一份快照）' : ''}`
          : '已恢复，但逐列核对有不一致，请检查字段后再决定是否重试', r.verified ? 'ok' : 'warn');
        // 表单里的值已经过时了，重新取一遍，避免「保存」把旧值写回去
        state.model = await loadProfile(state.editing);
        state.touched.clear();
        state.dirty = false;
        mount(document.getElementById('dirty-flag'), '');
        await refresh();
      } catch (e) { toast(`恢复失败：${e.message}`, 'bad'); }
    }

    async function deleteOne(s) {
      const yes = await confirmDialog({
        title: '删除这份快照',
        body: h('div', null, `删掉 ${(s.taken_at || '').slice(0, 19).replace('T', ' ')} 那份（${s.reason_label || s.reason}）？删了就没了。`),
        okLabel: '删除', danger: true,
      });
      if (!yes) return;
      try {
        await api.snapshotDelete(state.editing, s.snap_id);
        toast('已删除这份快照', 'ok');
        await refresh();
      } catch (e) { toast(`删除失败：${e.message}`, 'bad'); }
    }
  }

  function countryField() {
    const sel = h('select', {
      onChange: (e) => {
        setValue('country', e.target.value);
        toast('改国家会在保存时整组重算时区/语言/经纬度');
      },
    }, ...COUNTRIES.map(([code, label]) => h('option', { value: code, selected: (state.model.country || 'US') === code }, `${label}（${code}）`)));
    return h('label', { class: 'field', dataset: { field: 'country' } },
      h('span', { class: 'lbl' }, '国家 / 地区'),
      sel,
      h('span', { class: 'hint' }, '决定 UA 平台、时区、语言、经纬度的生成；换国家会整组重算，指纹种子不变'));
  }

  function groupField() {
    const sel = h('select', { onChange: (e) => setValue('group_id', e.target.value) },
      ...state.groups.map((x) => h('option', { value: String(x.id), selected: String(state.model.group_id ?? '0') === String(x.id) }, x.name)));
    if (!state.groups.length) sel.appendChild(h('option', { value: '0' }, 'Default'));
    return h('label', { class: 'field' },
      h('span', { class: 'lbl' }, '分组', h('span', { class: 'req' }, '*')),
      h('div', { class: 'row' }, sel, h('button', { class: 'btn sm ghost', onClick: createGroup }, '+ 新建分组')));
  }

  async function createGroup() {
    const input = h('input', { type: 'text', placeholder: '分组名，例如「美区-养号」' });
    const d = drawer({
      title: '新建分组',
      body: h('div', { class: 'stack' }, input, h('div', { class: 'muted small' }, '分组只在本机用，删除分组时里面的环境会回到 Default。')),
      footer: h('button', { class: 'btn primary', onClick: async () => {
        const name = input.value.trim();
        if (!name) { toast('分组名不能为空', 'bad'); return; }
        try {
          await api.groupCreate(name);
          const r = await api.groups();
          state.groups = r.list || [];
          const g = state.groups.find((x) => x.name === name);
          if (g) state.model.group_id = String(g.id);
          d.close();
          await renderEditRefresh();
        } catch (e) { toast(e.message, 'bad'); }
      } }, '创建'),
    });
  }

  function tagsField() {
    const cur = new Set((state.model.profile_tag_ids || []).map(String));
    const boxes = state.tags.map((t) => h('label', null,
      h('input', {
        type: 'checkbox', checked: cur.has(String(t.id)),
        onChange: (e) => {
          const next = new Set(state.model.profile_tag_ids || []);
          if (e.target.checked) next.add(String(t.id)); else next.delete(String(t.id));
          setValue('profile_tag_ids', [...next]);
        },
      }), t.name));
    const input = h('input', { type: 'text', placeholder: '新标签名', style: { width: '120px' } });
    return h('label', { class: 'field wide' },
      h('span', { class: 'lbl' }, '标签'),
      boxes.length ? h('div', { class: 'checks' }, ...boxes) : h('span', { class: 'muted small' }, '还没有标签'),
      h('div', { class: 'row' }, input, h('button', { class: 'btn sm ghost', onClick: async () => {
        const name = input.value.trim();
        if (!name) return;
        try {
          await api.tagCreate([{ name }]);
          const r = await api.tags();
          state.tags = r.list || [];
          await renderEditRefresh();
        } catch (e) { toast(`建标签失败：${e.message}`, 'bad'); }
      } }, '新建标签')));
  }

  /**
   * 扩展：从应用中心（扩展库）里勾选。**文件全局共享一份**，这里存的只是「这个环境用哪些」。
   * 没勾的不会加载；改完勾选要重启环境才生效（扩展在启动后由 CDP 装进去，不是命令行参数）。
   */
  function appField() {
    const enabled = state.apps.filter((x) => x.status !== '0');
    const boxes = enabled.map((x) => h('label', null,
      h('input', {
        type: 'checkbox', checked: state.extIds.has(String(x.id)),
        onChange: (e) => {
          if (e.target.checked) state.extIds.add(String(x.id));
          else state.extIds.delete(String(x.id));
          markDirty();
        },
      }), `${x.name} ${x.version ? `v${x.version}` : ''}`.trim()));
    const disabledCount = state.apps.length - enabled.length;
    return h('label', { class: 'field wide' },
      h('span', { class: 'lbl' }, '扩展'),
      boxes.length
        ? h('div', { class: 'checks' }, ...boxes)
        : h('span', { class: 'muted small' }, '应用中心里还没有扩展'),
      h('div', { class: 'row' },
        h('a', { class: 'small', href: '#/apps' }, '打开应用中心 →'),
        disabledCount ? h('span', { class: 'muted small' }, `（${disabledCount} 个扩展在应用中心里被停用，这里不显示）`) : null),
      h('span', { class: 'hint' },
        '扩展文件在本机只存一份，所有环境共用；这里选的是「这个环境启动时加载哪些」。' +
        '环境正在运行时改这一项，保存后会重启才生效。'));
  }

  function proxyField() {    const cur = state.model.proxy_id || '';    const hasCustom = !cur && state.model._has_custom_proxy;
    const sel = h('select', { onChange: (e) => setValue('proxy_id', e.target.value) },
      h('option', { value: '', selected: !cur }, hasCustom ? '自定义（列表外，编辑会覆盖）' : '直连（不绑代理）'),
      ...state.proxies.map((p) => h('option', { value: p.proxy_id, selected: String(cur) === String(p.proxy_id) },
        `${p.remark || p.host}:${p.port}（${p.type || 'http'}）`)));
    return h('label', { class: 'field wide' },
      h('span', { class: 'lbl' }, '绑定代理'),
      h('div', { class: 'row' }, sel, h('a', { class: 'small', href: '#/proxies' }, '管理代理 →')),
      h('span', { class: 'hint' }, '没绑定代理时出口就是本机 IP，跑真实账号务必绑。绑定后启动会先预检，坏代理不会起内核。'));
  }

  /**
   * 出口 IP 归属（只读，0.4.6）：`ip` / `ip_country` / `ip_region` / `ip_city` 这四个字段
   * 原来属于「API 可写、界面不显示」那批 —— 写进去没人读，也没人看得见。
   *
   * 它们的语义不是配置而是**记录**（导入 txt 时服务端会带上），所以正确的归宿是只读展示：
   * 看得见值、改不了、也不会让人以为「填了会生效」。本版不主动探测归属地。
   */
  function ipOriginField() {
    const pick = (k) => {
      const v = state.model[k];
      return v === undefined || v === null || v === '' ? '' : String(v);
    };
    const ip = pick('ip');
    const place = [pick('ip_country'), pick('ip_region'), pick('ip_city')].filter(Boolean).join(' / ');
    const text = ip || place ? [ip, place].filter(Boolean).join('  ·  ') : '（还没有记录）';
    return h('label', { class: 'field wide', dataset: { field: 'ip' } },
      h('span', { class: 'lbl' }, '出口 IP 归属（只读）'),
      h('div', { class: 'mono small' }, text),
      h('span', { class: 'hint' },
        '这一项不是配置：值来自导入文件或 API 写入，本版不主动探测归属地，也改不了。真实出口 IP 看启动预检的结果。'));
  }

  function hintOf(f) {
    const bits = [];
    if (f.note) bits.push(f.note);
    if (f.range) bits.push(`范围 ${f.range}`);
    if (f.max) bits.push(`最长 ${f.max}`);
    return bits.join(' · ');
  }

  /**
   * 「本版不支持」那一行小字 —— **必须是页面上看得见的文字，不是 title / hover**（0.4.6 规矩）。
   * 文案来自后端字段表（`overrides.mjs` 的 UNSUPPORTED），前端只加统一前缀，不自己编理由。
   */
  function unsupportedLine(f) {
    if (!f.disabled) return null;
    const why = f.unsupported_reason;
    return h('span', { class: 'unsupported' }, why ? `本版不支持 · ${why}` : '本版不支持 · （字段表没写原因，这是缺陷）');
  }

  /** 元信息字段（备注/标签这类）的说明：能填，但本来就不改变浏览器行为 */
  function metadataLine(f) {
    if (f.disabled || !f.metadata_note) return null;
    return h('span', { class: 'hint' }, `只保存与显示，不改变浏览器行为 · ${f.metadata_note}`);
  }

  /**
   * 联动禁用（0.4.6）：`win_x` / `win_y` 只有在「窗口位置」是 topLeft 时才会被用上。
   *
   * 为什么必须做：对手那边填了 `win_x=800` 但窗口位置是 maximize 时，这两个数被**静默忽略**
   * （逆向 `30-假字段消费机制.md` §7：只有 topLeft 分支才推 `--window-position=`）。
   * 用户看到的正是「填了没用」—— 假字段感的来源之一。我们做得比对手好：不静默，
   * 直接禁用这两个输入框，并说清「为什么现在不生效、要改成什么才生效」。
   *
   * 空值按对手的默认口径当 topLeft（`e.windowPosition||"topLeft"`），所以没填窗口位置时可用。
   * @returns {string|null} 不生效的原因；null = 现在可用
   */
  function linkageNote(f) {
    if (f.name !== 'win_x' && f.name !== 'win_y') return null;
    if (f.disabled) return null;
    const wp = String(state.model.window_position || '').trim() || 'topLeft';
    if (wp === 'topLeft') return null;
    return `当前「窗口位置」是 ${wp}，这两个坐标不会被使用；要按坐标摆放，请把窗口位置改成 topLeft`;
  }

  function field(f) {
    const val = state.model[f.name];
    let input;
    let extra = null;
    const wide = ['list', 'json', 'cookie'].includes(f.kind) || f.name === 'launch_args' || f.name === 'ua';
    const onChange = (v) => setValue(f.name, v);

    if (f.kind === 'select') {
      const cur = val === undefined || val === null ? '' : String(val);
      const values = f.values || [];
      input = h('select', { onChange: (e) => onChange(e.target.value) },
        ...values.map((v) => {
          const raw = String(v);
          const lbl = f.value_labels && f.value_labels[raw] ? `${f.value_labels[raw]}（${raw}）` : raw;
          return h('option', { value: raw, selected: cur === raw }, lbl);
        }));
    } else if (f.kind === 'number') {
      input = h('input', {
        type: 'number', step: 'any', value: val === undefined || val === null ? '' : String(val),
        onInput: (e) => onChange(e.target.value === '' ? null : Number(e.target.value)),
      });
    } else if (f.kind === 'list') {
      input = h('textarea', {
        rows: 3, placeholder: '一行一个',
        onInput: (e) => onChange(e.target.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)),
      });
      input.value = Array.isArray(val) ? val.join('\n') : (val || '');
    } else if (f.kind === 'multiselect') {
      const cur = new Set((val || []).map(String));
      input = h('div', { class: 'checks' }, ...(f.values || []).map((v) => h('label', null,
        h('input', {
          type: 'checkbox', checked: cur.has(String(v)),
          onChange: (e) => {
            const next = new Set(state.model[f.name] || []);
            if (e.target.checked) next.add(String(v)); else next.delete(String(v));
            onChange([...next]);
          },
        }), String(v))));
    } else if (f.kind === 'json') {
      const text = JSON.stringify(val === undefined || val === null ? (f.type === 'array<object>' ? [] : {}) : val, null, 2);
      state.rawJson[f.name] = text;
      input = h('textarea', {
        rows: 4,
        onInput: (e) => { state.rawJson[f.name] = e.target.value; markDirty(); try { onChange(JSON.parse(e.target.value)); } catch { /* 解析失败先不写模型，保存前再拦 */ } },
      });
      input.value = text;
    } else if (f.name === 'launch_args') {
      input = h('textarea', {
        rows: 3,
        onInput: (e) => { state.rawJson[f.name] = e.target.value; markDirty(); try { onChange(JSON.parse(e.target.value)); } catch { /* 同上 */ } },
      });
      input.value = JSON.stringify(Array.isArray(val) ? val : [], null, 0);
    } else if (f.kind === 'cookie') {
      input = h('textarea', { rows: 2, placeholder: 'sid=xxx; uid=7（原始 cookie 串）', onInput: (e) => onChange(e.target.value) });
      input.value = val || '';
      // cookie 导入/导出走运行中内核的 CDP，和这个「登录 cookie 文本」不是一份数据
      extra = h('div', { class: 'row', style: { marginTop: '6px' } },
        h('button', { class: 'btn sm', type: 'button', onClick: () => cookieExport('json') }, '导出 cookie（JSON）'),
        h('button', { class: 'btn sm', type: 'button', onClick: () => cookieExport('netscape') }, '导出 cookie（netscape）'),
        h('button', { class: 'btn sm', type: 'button', onClick: cookieImport }, '导入 cookie 文件'),
        h('span', { class: 'muted small' }, '需要环境运行中：cookie 在内核里'));
    } else {
      input = h('input', { type: 'text', value: val === undefined || val === null ? '' : String(val), onInput: (e) => onChange(e.target.value) });
    }
    if (f.cloudOnly) input.disabled = true;
    if (f.idle) input.disabled = true;
    // 联动禁用：窗口位置不是 topLeft 时，win_x / win_y 填了也不会被用（见 linkageNote）
    const link = linkageNote(f);
    if (link) input.disabled = true;
    // 改了「窗口位置」要重画这一栏 —— win_x / win_y 的可用状态跟着它变（change 而非 input，避免打字时丢焦点）
    if (f.name === 'window_position') input.addEventListener('change', () => repaintGroup());

    const errEl = h('div', { class: 'field-error', style: { display: 'none' } });
    const wrap = h('label', {
      class: `field ${wide ? 'wide' : ''}${f.disabled || link ? ' idle' : ''}`,
      dataset: { field: f.name },
    },
      h('span', { class: 'lbl' },
        f.label,
        f.required ? h('span', { class: 'req' }, '*') : null,
        f.coverage !== 'n/a' && f.coverage ? h('span', { class: 'tag' }, f.coverage) : null),
      input,
      unsupportedLine(f),
      link ? h('span', { class: 'unsupported' }, `当前不生效 · ${link}`) : null,
      metadataLine(f),
      hintOf(f) ? h('span', { class: 'hint' }, hintOf(f)) : null,
      extra,
      errEl);
    state.refs[f.name] = wrap;
    return wrap;
  }

  /* ------------------------ cookie 导入 / 导出（P10） ------------------------ */

  async function envRunning() {
    if (!state.editing) return false;
    const live = await api.running().catch(() => ({ list: [] }));
    state.running = (live.list || []).some((i) => i.profile_id === state.editing);
    return state.running;
  }

  async function cookieExport(format) {
    if (!(await envRunning())) { toast('需要环境运行中：cookie 存在内核里，请先在列表里启动这个环境', 'bad'); return; }
    try {
      const d = await api.cookieExport(state.editing, format);
      const no = state.model.profile_no || state.editing;
      if (format === 'netscape') downloadText(`cookies-${no}.txt`, d.content, 'text/plain');
      else downloadText(`cookies-${no}.json`, JSON.stringify(d.cookies, null, 2));
      toast(`已从内核导出 ${d.count} 条 cookie`, 'ok');
    } catch (e) { toast(`导出 cookie 失败：${e.message}`, 'bad'); }
  }

  async function cookieImport() {
    if (!(await envRunning())) { toast('需要环境运行中：cookie 只能写进内核，请先启动这个环境', 'bad'); return; }
    const file = await pickFile('.txt,.json,text/plain,application/json');
    if (!file) return;
    const text = await file.text();
    let body;
    if (/^\s*[[{]/.test(text)) {
      try {
        const p = JSON.parse(text);
        body = { cookies: Array.isArray(p) ? p : p.cookies };
      } catch (e) { toast(`JSON 解析失败：${e.message}`, 'bad'); return; }
      if (!Array.isArray(body.cookies)) { toast('JSON 里没有 cookies 数组', 'bad'); return; }
    } else {
      body = { format: 'netscape', content: text };
    }
    try {
      const r = await api.cookieImport(state.editing, body);
      const bits = [`导入 cookie：${r.imported} 条`];
      if (r.failed?.length) bits.push(`失败 ${r.failed.length} 条`);
      if (r.warnings?.length) bits.push(r.warnings[0]);
      toast(bits.join(' · '), r.failed?.length ? 'bad' : 'ok');
      if (r.imported > 0) toast(`内核回读校验通过 ${r.verified ?? r.imported} 条`, 'ok');
    } catch (e) { toast(`导入 cookie 失败：${e.message}`, 'bad'); }
  }

  /* ------------------------------ 数据 ------------------------------ */

  function newProfile() {
    const m = { country: 'US', group_id: '0' };
    for (const g of state.schema.groups) {
      for (const f of g.fields) {
        if (f.default !== null && f.default !== undefined) m[f.name] = f.default;
      }
    }
    return m;
  }

  async function loadProfile(id) {
    const p = await api.detail(id);
    const m = { ...p };
    // 表单只认 schema 里的字段 + country/proxy_id；其余（profile_id、fingerprint_config 快照）不往回发
    m.launch_args = Array.isArray(p.launch_args) ? p.launch_args : [];
    m._has_custom_proxy = !!(p.proxy_config && p.proxy_config.host && !p.proxy_id);
    if (p.proxy_config && p.proxy_config.proxy_id) m.proxy_id = p.proxy_config.proxy_id;
    return m;
  }

  function buildPayload() {
    const out = {};
    const isNew = !state.editing;
    for (const g of state.schema.groups) {
      for (const f of g.fields) {
        if (f.cloudOnly) continue;
        const v = state.model[f.name];
        // null/undefined = 这个字段没填。原样发回去会被当成「非法值」校验（例如空 cookie），
        // 所以这里只发真正有值的字段。
        if (v === undefined || v === null) continue;
        // 新建时没动过的字段一律不发：UA / 时区 / 语言 / 分辨率 / 硬件参数都由后端
        // 按 country + 种子生成，前端把默认值发回去反而会把生成结果覆盖成错的
        // （例如选了日本，却带着控件默认的 UTC 建库）。
        if (isNew && !state.core.has(f.name) && !state.touched.has(f.name)) continue;
        out[f.name] = v;
      }
    }
    if (state.model.country) out.country = state.model.country;
    if (state.model.group_id !== undefined) out.group_id = String(state.model.group_id);
    if (state.model.proxy_id !== undefined) out.proxy_id = state.model.proxy_id;
    return out;
  }

  async function renderEditRefresh() {
    const p = { head: document.getElementById('page-head'), page: document.getElementById('page'), params: { id: state.editing } };
    await renderEdit(p);
  }

  /* ------------------------------ 保存 ------------------------------ */

  /**
   * 扩展勾选的落库顺序**刻意放在环境保存之前**（编辑时）：
   * 保存并重启这条路径里，重启时读的就是库里的勾选，后写就等于这次重启白跑一趟。
   * 代价：勾选写成功、随后的字段保存被拒时，勾选已经改过了 —— 环境本身没变，用户改回来只需再点一次，
   * 比「重启后扩展没生效、用户以为勾错了」好判断。
   */
  async function saveExtensions(profileId) {
    const ids = [...state.extIds];
    const r = await api.appSetForProfile(profileId, ids);
    return r;
  }

  async function save() {
    if (state.busy) return;
    // JSON 类字段先自己把格式问题拦下，否则发出去只会拿到一句 "must be an object"
    for (const [name, text] of Object.entries(state.rawJson)) {
      try { JSON.parse(text); } catch {
        toast(`${name} 不是合法 JSON，先修好再保存`, 'bad');
        state.active = groupOfField(name);
        paintTabs(tabBar, formArea);
        return;
      }
    }
    state.busy = true;
    saveBtn.disabled = true;
    try {
      const payload = buildPayload();
      const check = await api.validate(payload, state.editing ? 'update' : 'create');
      state.lastCheck = check;
      paintCheck(checkBox);
      paintFieldErrors(check);
      if (!check.ok) {
        toast(`${(check.errors || []).length} 个字段不合法，看上方红框`, 'bad');
        return;
      }
      if (state.editing) {
        const extSave = await saveExtensions(state.editing);
        if (state.running) {
          // 运行中：stop → apply → start 由后端一个请求做完（前端不自己停，避免半路失败留下停着的环境）
          saveBtn.textContent = '重启中…';
          const r = await api.restart({ ...payload, profile_id: state.editing });
          const n = (r && r.changed) ? r.changed.length : 0;
          toast(n ? `已按新配置重启（变更 ${n} 项）` : '已重启（没有字段变化）', 'ok');
        } else {
          await api.update({ ...payload, profile_id: state.editing });
          toast(extSave.restart_required ? '已保存；扩展改动要重启环境后生效' : '已保存', 'ok');
        }
      } else {
        const p = await api.create(payload);
        // 新环境：先把 id 拿到，再把勾选写进去（创建接口不收扩展字段）
        await saveExtensions(p.profile_id);
        toast(`已创建 #${p.profile_no || ''}`, 'ok');
      }
      state.dirty = false;
      location.hash = '#/profiles';
    } catch (e) {
      const errs = (e.data && e.data.errors) || [];
      const stopped = !!(e.data && e.data.stopped);
      mount(checkBox, h('div', { class: 'notice bad' },
        h('div', null, `保存失败：${e.message}`),
        stopped ? h('div', { class: 'muted small' }, '这个环境现在是「已停止」：重启失败不会留下还在跑旧配置的内核，修好再点一次就行。') : null,
        errs.length ? h('ul', null, errs.slice(0, 8).map((x) => h('li', null, h('span', { class: 'mono' }, x.field), ' — ', x.message))) : null));
      paintFieldErrors({ errors: errs });
      toast(e.message, 'bad');
    } finally {
      state.busy = false;
      saveBtn.disabled = false;
      saveBtn.textContent = saveLabel;
    }
  }

  function groupOfField(name) {
    for (const g of state.schema.groups) if (g.fields.some((f) => f.name === name)) return g.id;
    return state.active;
  }
}