/**
 * 环境编辑：11 组分栏 + 值域校验。
 *
 * 两条硬规矩：
 *   1. 字段清单、值域、必填全来自 /browser-profile/schema（后端注册表），前端不抄第二份；
 *   2. 校验文案全部来自后端 /browser-profile/validate（和 create/update 同一个 validateProfile），
 *      前端只负责把 errors[].field 定位到那个输入框，不自己编一句话。
 */
import { h, mount, clear, toast, debounce, drawer, confirmDialog } from '../ui.js';
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

  const [schema, groups, tags, proxies] = await Promise.all([
    api.schema(),
    api.groups().catch(() => ({ list: [] })),
    api.tags().catch(() => ({ list: [] })),
    api.proxies().catch(() => ({ list: [] })),
  ]);
  state.schema = schema;
  state.groups = groups.list || [];
  state.tags = tags.list || [];
  state.proxies = proxies.list || [];

  const id = params.id;
  state.editing = id || null;
  state.model = id ? await loadProfile(id) : newProfile();

  const title = id ? `编辑环境 #${state.model.profile_no || ''}` : '新建环境';
  const saveBtn = h('button', { class: 'btn primary', onClick: save }, id ? '保存修改' : '创建环境');
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

  function paintTabs(tabBar, formArea) {
    clear(tabBar);
    for (const g of state.schema.groups) {
      tabBar.appendChild(h('button', {
        class: `tab ${state.active === g.id ? 'active' : ''}`,
        onClick: () => { state.active = g.id; paintTabs(tabBar, formArea); },
      }, g.label, h('span', { class: 'cnt' }, String(g.total))));
    }
    paintGroup(formArea);
  }

  function paintGroup(formArea) {
    const g = state.schema.groups.find((x) => x.id === state.active);
    state.refs = {};
    clear(formArea);
    if (!g) return;
    const grid = h('div', { class: 'form-grid' });
    const basics = g.fields.filter((f) => f.basic);
    const advanced = g.fields.filter((f) => !f.basic);

    if (g.id === 'identity') grid.appendChild(countryField());
    if (g.id === 'identity') grid.appendChild(groupField());
    if (g.id === 'identity') grid.appendChild(tagsField());
    if (g.id === 'network') grid.appendChild(proxyField());
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

  function proxyField() {
    const cur = state.model.proxy_id || '';
    const hasCustom = !cur && state.model._has_custom_proxy;
    const sel = h('select', { onChange: (e) => setValue('proxy_id', e.target.value) },
      h('option', { value: '', selected: !cur }, hasCustom ? '自定义（列表外，编辑会覆盖）' : '直连（不绑代理）'),
      ...state.proxies.map((p) => h('option', { value: p.proxy_id, selected: String(cur) === String(p.proxy_id) },
        `${p.remark || p.host}:${p.port}（${p.type || 'http'}）`)));
    return h('label', { class: 'field wide' },
      h('span', { class: 'lbl' }, '绑定代理'),
      h('div', { class: 'row' }, sel, h('a', { class: 'small', href: '#/proxies' }, '管理代理 →')),
      h('span', { class: 'hint' }, '没绑定代理时出口就是本机 IP，跑真实账号务必绑。绑定后启动会先预检，坏代理不会起内核。'));
  }

  function hintOf(f) {
    const bits = [];
    if (f.note) bits.push(f.note);
    if (f.range) bits.push(`范围 ${f.range}`);
    if (f.max) bits.push(`最长 ${f.max}`);
    if (f.cloudOnly) bits.push('云端字段：FreePower 本地不生效，改了也只是存着');
    return bits.join(' · ');
  }

  function field(f) {
    const val = state.model[f.name];
    let input;
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
    } else {
      input = h('input', { type: 'text', value: val === undefined || val === null ? '' : String(val), onInput: (e) => onChange(e.target.value) });
    }
    if (f.cloudOnly) input.disabled = true;

    const errEl = h('div', { class: 'field-error', style: { display: 'none' } });
    const wrap = h('label', { class: `field ${wide ? 'wide' : ''}`, dataset: { field: f.name } },
      h('span', { class: 'lbl' },
        f.label,
        f.required ? h('span', { class: 'req' }, '*') : null,
        f.coverage !== 'n/a' && f.coverage ? h('span', { class: 'tag' }, f.coverage) : null),
      input,
      hintOf(f) ? h('span', { class: 'hint' }, hintOf(f)) : null,
      errEl);
    state.refs[f.name] = wrap;
    return wrap;
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
        await api.update({ ...payload, profile_id: state.editing });
        toast('已保存', 'ok');
      } else {
        const p = await api.create(payload);
        toast(`已创建 #${p.profile_no || ''}`, 'ok');
      }
      state.dirty = false;
      location.hash = '#/profiles';
    } catch (e) {
      const errs = (e.data && e.data.errors) || [];
      mount(checkBox, h('div', { class: 'notice bad' },
        h('div', null, `保存失败：${e.message}`),
        errs.length ? h('ul', null, errs.slice(0, 8).map((x) => h('li', null, h('span', { class: 'mono' }, x.field), ' — ', x.message))) : null));
      paintFieldErrors({ errors: errs });
      toast(e.message, 'bad');
    } finally {
      state.busy = false;
      saveBtn.disabled = false;
    }
  }

  function groupOfField(name) {
    for (const g of state.schema.groups) if (g.fields.some((f) => f.name === name)) return g.id;
    return state.active;
  }
}