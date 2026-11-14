/**
 * 分组管理 tab（环境管理页内，0.4.3 ②）。
 *
 * 对应逆向 `28-` 号文里「环境管理 → 页内 tabs：环境列表 / 分组管理 / 回收站」的第二项。
 * 行为以我们自己的后端为准（`group/*` 是 B 类，07- 号文 §181「自己设计返回即可」）：
 *   - 新建：只收名字（+备注，存在 meta 表里，因为 groups 表没这一列）；
 *   - 重命名 / 改备注：改名不影响组里的环境；
 *   - 删除：**不删环境**，组里的环境统一挪回 Default，并如实告诉用户挪了几个；
 *     Default（id=0）不许删。
 */
import { h, mount, clear, toast, confirmDialog, promptDialog, pill, empty } from '../ui.js';
import { api } from '../api.js';
import { tabBar } from '../tabs.js';

export default async function renderGroups({ head, page }) {
  mount(head,
    h('h1', null, '环境管理'),
    h('span', { class: 'sub', id: 'group-sub' }, '加载中…'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm', onClick: () => load() }, '刷新'));

  const body = h('tbody');
  mount(page,
    tabBar('groups'),
    h('div', { class: 'panel' },
      h('div', { class: 'panel-body' },
        h('div', { class: 'toolbar' },
          h('button', { class: 'btn primary', onClick: createOne }, '新建分组'),
          h('span', { class: 'grow' }),
          h('span', { class: 'muted small' }, '删除分组不会删环境：组里的环境会挪回 Default。')),
        h('table', { class: 'grid' },
          h('thead', null,
            h('tr', null,
              h('th', null, '分组'),
              h('th', null, '备注'),
              h('th', { style: { width: '90px' } }, '环境数'),
              h('th', { style: { width: '230px' } }, '操作'))),
          body))));

  await load();

  async function load() {
    try {
      const r = await api.groups();
      paint(r.list || []);
    } catch (e) {
      mount(body, h('tr', null, h('td', { colspan: 4 }, h('div', { class: 'notice bad' }, e.message))));
    }
  }

  function paint(list) {
    const sub = document.getElementById('group-sub');
    if (sub) mount(sub, `${list.length} 个分组`);
    if (!list.length) {
      mount(body, h('tr', null, h('td', { colspan: 4 }, empty('还没有分组。点「新建分组」建一个。'))));
      return;
    }
    clear(body);
    for (const g of list) body.appendChild(row(g));
  }

  function row(g) {
    const isDefault = String(g.group_id) === '0';
    const count = Number(g.profile_count || 0);
    return h('tr', null,
      h('td', null,
        h('span', null, g.group_name || `分组 ${g.group_id}`),
        isDefault ? h('span', { class: 'muted small' }, '  （默认分组）') : null),
      h('td', { class: 'muted' }, g.remark || '—'),
      h('td', null, count ? pill(`${count} 个`, 'info') : h('span', { class: 'muted small' }, '空')),
      h('td', { class: 'actions' },
        h('button', { class: 'btn sm ghost', onClick: () => rename(g) }, '重命名'),
        ' ',
        h('button', { class: 'btn sm ghost', onClick: () => editRemark(g) }, '改备注'),
        ' ',
        h('button', {
          class: 'btn sm danger', disabled: isDefault,
          title: isDefault ? '默认分组不能删除' : '组里的环境会挪回 Default，环境本身不删',
          onClick: () => remove(g),
        }, '删除')));
  }

  async function createOne() {
    const name = await promptDialog({ title: '新建分组', label: '分组名称', placeholder: '例如：广告投放', okLabel: '创建' });
    if (name === null) return;
    if (!name.trim()) { toast('分组名称不能为空'); return; }
    try {
      const r = await api.groupCreate(name.trim());
      toast(`已创建分组「${r.group_name || name.trim()}」`, 'ok');
      await load();
    } catch (e) { toast(`新建失败：${e.message}`, 'bad'); }
  }

  async function rename(g) {
    const name = await promptDialog({ title: '重命名分组', label: '分组名称', value: g.group_name || '', okLabel: '保存' });
    if (name === null) return;
    if (!name.trim()) { toast('分组名称不能为空'); return; }
    try {
      await api.groupUpdate({ group_id: g.group_id, group_name: name.trim() });
      toast('已重命名', 'ok');
      await load();
    } catch (e) { toast(`重命名失败：${e.message}`, 'bad'); }
  }

  async function editRemark(g) {
    const remark = await promptDialog({
      title: '分组备注', label: '备注（可以留空）', value: g.remark || '', okLabel: '保存',
    });
    if (remark === null) return;
    try {
      await api.groupUpdate({ group_id: g.group_id, group_name: g.group_name, remark });
      toast('已保存备注', 'ok');
      await load();
    } catch (e) { toast(`保存失败：${e.message}`, 'bad'); }
  }

  async function remove(g) {
    const count = Number(g.profile_count || 0);
    const yes = await confirmDialog({
      title: '删除分组',
      body: h('div', { class: 'stack' },
        h('div', null, '即将删除分组 ', h('strong', null, g.group_name || g.group_id)),
        h('div', { class: 'notice' }, count
          ? `组里的 ${count} 个环境不会被删除，会挪回 Default（默认分组）。`
          : '这个组里没有环境。')),
      okLabel: '删除分组', danger: true,
    });
    if (!yes) return;
    try {
      const r = await api.groupDelete(g.group_id);
      toast(r && r.moved ? `已删除分组，${r.moved} 个环境挪回 Default` : '已删除分组', 'ok');
      await load();
    } catch (e) { toast(`删除失败：${e.message}`, 'bad'); }
  }
}
