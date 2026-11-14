/**
 * 回收站 tab（环境管理页内，0.4.3 ②）。
 *
 * 语义来自两处：
 *   1. 逆向 `22-回收站响应形状.md`：`recycle-bin/list` 的 item **只有 6 个键**
 *      （profile_id / profile_no / name / group_name / remark / delete_time），
 *      没有 total，`limit` 上限 100；`restore` 必须带 `group_id`（不能「恢复回原分组」而不传）。
 *   2. 我们自己加的 `recycle-bin/purge`（对手无此路由，22- §5.4 无证据）：
 *      只能恢复不能清的回收站等于磁盘只进不出，所以给了「彻底删除 / 清空」，
 *      但**必须用户显式点**，而且弹窗里写清不可恢复。
 *
 * 一个刻意的差异：对手的删除文案写「保留 30 天」，我们**不做自动清理**（会不打招呼删用户数据），
 * 所以页面如实写「不会自动清理」，让用户自己决定什么时候清。
 */
import { h, mount, clear, toast, confirmDialog, pill, empty } from '../ui.js';
import { api } from '../api.js';
import { tabBar } from '../tabs.js';

const PAGE_SIZE = 100; // 服务端 limit 上限就是 100

export default async function renderRecycle({ head, page }) {
  let pageNo = 1;
  let groups = [];
  let rows = [];

  mount(head,
    h('h1', null, '环境管理'),
    h('span', { class: 'sub', id: 'recycle-sub' }, '加载中…'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm', onClick: () => load() }, '刷新'));

  const body = h('tbody');
  const pager = h('div', { class: 'toolbar' });

  mount(page,
    tabBar('recycle'),
    h('div', { class: 'panel' },
      h('div', { class: 'panel-body' },
        h('div', { class: 'toolbar' },
          h('span', { class: 'muted small' },
            '删除的环境会进这里：user-data（cookie、登录态）还在盘上，恢复后能直接启动。'),
          h('span', { class: 'grow' }),
          h('button', { class: 'btn danger sm', onClick: emptyAll }, '清空回收站')),
        h('table', { class: 'grid' },
          h('thead', null,
            h('tr', null,
              h('th', null, '环境'),
              h('th', { style: { width: '120px' } }, '分组'),
              h('th', null, '备注'),
              h('th', { style: { width: '150px' } }, '删除时间'),
              h('th', { style: { width: '190px' } }, '操作'))),
          body),
        pager,
        h('div', { class: 'muted small', style: { marginTop: '8px' } },
          '回收站里的环境不会自动清理（对手写的是「保留 30 天」）。要腾磁盘，用「彻底删除」或「清空回收站」——'
          + '那一步会真的删掉记录和 user-data 目录，不可恢复。'))));

  await loadGroups();
  await load();

  async function loadGroups() {
    try {
      const r = await api.groups();
      groups = r.list || [];
    } catch { groups = []; } // 分组取不到不挡恢复：下面会退回只给 Default
  }

  async function load() {
    try {
      const r = await api.recycleList(pageNo, PAGE_SIZE);
      rows = r.list || [];
      paint();
    } catch (e) {
      mount(body, h('tr', null, h('td', { colspan: 5 }, h('div', { class: 'notice bad' }, e.message))));
    }
  }

  function paint() {
    const sub = document.getElementById('recycle-sub');
    if (sub) mount(sub, rows.length ? `本页 ${rows.length} 个` : '空的');
    if (!rows.length) {
      mount(body, h('tr', null, h('td', { colspan: 5 }, empty('回收站是空的。'))));
      mount(pager);
      return;
    }
    clear(body);
    for (const r of rows) body.appendChild(row(r));
    mount(pager,
      h('button', { class: 'btn sm', disabled: pageNo <= 1, onClick: () => { pageNo -= 1; load(); } }, '上一页'),
      h('span', { class: 'muted small' }, `第 ${pageNo} 页`),
      h('button', { class: 'btn sm', disabled: rows.length < PAGE_SIZE, onClick: () => { pageNo += 1; load(); } }, '下一页'));
  }

  function row(r) {
    return h('tr', null,
      h('td', null,
        h('div', null, r.name || '(未命名)'),
        h('span', { class: 'muted small mono' }, `#${r.profile_no || '—'}`)),
      h('td', null, r.group_name || 'Default'),
      h('td', { class: 'muted' }, r.remark || '—'),
      h('td', null, pill(fmtDeleteTime(r.delete_time), 'idle')),
      h('td', { class: 'actions' },
        h('button', { class: 'btn sm primary', onClick: () => restore(r) }, '恢复'),
        ' ',
        h('button', { class: 'btn sm danger', onClick: () => purgeOne(r) }, '彻底删除')));
  }

  async function restore(r) {
    // 对手要求恢复时必须显式选分组，所以这里给一个下拉，默认选中它原来的组
    const sel = h('select', null, ...(groups.length ? groups : [{ group_id: '0', group_name: 'Default' }]).map((g) => h('option', {
      value: g.group_id,
      selected: String(g.group_name || '') === String(r.group_name || ''),
    }, g.group_name || `分组 ${g.group_id}`)));
    const yes = await confirmDialog({
      title: '恢复环境',
      body: h('div', { class: 'stack' },
        h('div', null, '把 ', h('strong', null, r.name || r.profile_id), ' 恢复到哪个分组？'),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, '分组'), sel),
        h('div', { class: 'muted small' }, '恢复的是同一个环境：id、编号、user-data 目录都不变。')),
      okLabel: '恢复',
    });
    if (!yes) return;
    try {
      await api.recycleRestore(r.profile_id, sel.value);
      toast(`已恢复到「${sel.options[sel.selectedIndex]?.textContent || sel.value}」`, 'ok');
      await load();
    } catch (e) { toast(`恢复失败：${e.message}`, 'bad'); }
  }

  async function purgeOne(r) {
    const yes = await confirmDialog({
      title: '彻底删除',
      body: h('div', { class: 'stack' },
        h('div', null, '即将彻底删除 ', h('strong', null, r.name || r.profile_id)),
        h('div', { class: 'notice bad' },
          '这一步不可恢复：会删掉这条记录和它的 user-data 目录（cookie、登录态、缓存）。')),
      okLabel: '彻底删除', danger: true,
    });
    if (!yes) return;
    try {
      const res = await api.recyclePurge({ profile_id: [r.profile_id] });
      const okN = (res.purged || []).length;
      if (okN) toast('已彻底删除', 'ok');
      // 盘删不掉时后端不删库（留个还能再点的入口），这里必须如实说，不能报成功
      else toast(`没能删掉：${skipReason(res.skipped)}`, 'bad');
      await load();
    } catch (e) { toast(`彻底删除失败：${e.message}`, 'bad'); }
  }

  async function emptyAll() {
    if (!rows.length && pageNo === 1) { toast('回收站已经是空的'); return; }
    const yes = await confirmDialog({
      title: '清空回收站',
      body: h('div', { class: 'stack' },
        h('div', null, '会彻底删除回收站里的全部环境（不只是这一页）。'),
        h('div', { class: 'notice bad' }, '不可恢复：记录和每个环境的 user-data 目录都会被删掉。')),
      okLabel: '清空', danger: true,
    });
    if (!yes) return;
    try {
      const res = await api.recyclePurge({ all: true });
      const okN = (res.purged || []).length;
      const badN = (res.skipped || []).length;
      // 「没删掉几个」不够：得说为什么没删掉，否则用户只能干瞪眼
      toast(`已彻底删除 ${okN} 个${badN ? `，${badN} 个没删掉：${skipReason(res.skipped)}` : ''}`, badN ? 'bad' : 'ok');
      pageNo = 1;
      await load();
    } catch (e) { toast(`清空失败：${e.message}`, 'bad'); }
  }
}

/**
 * skipped 里那条原因 → 给用户看的中文。
 *
 * 后端给的是**稳定的机器可读串**（`reason` + `error_code` + `error_message`），
 * 翻译放在界面上做：脚本按 reason 判断，人看中文，两件事不挤在同一条串里。
 * 认不出来的 reason **原样显示**，不猜、不吞掉 —— 未知原因被吞成「未知原因」才是最坏的结果。
 */
export function skipReasonText(s) {
  if (!s) return '未知原因';
  const code = s.error_code ? `（${s.error_code}）` : '';
  switch (s.reason) {
    case 'not_in_recycle_bin':
      return '不在回收站里（只有回收站里的环境能彻底删除）';
    case 'userdata_remove_failed':
      return `user-data 目录删不掉${code}：可能有程序还占着它（比如没退干净的浏览器进程），`
        + '关掉之后可以再试一次。记录已保留。';
    default:
      return s.reason ? `${s.reason}${code}` : '未知原因';
  }
}

/** 一批 skipped → 一句话（去重，别把同一条原因印十遍） */
export function skipReason(skipped) {
  const list = (skipped || []).map(skipReasonText);
  const uniq = [...new Set(list)];
  if (!uniq.length) return '未知原因';
  return uniq.length === 1 ? uniq[0] : uniq.slice(0, 2).join('；');
}

/**
 * `delete_time` 是**秒级 Unix 时间戳字符串**（对手口径，见 22- §1.4）。
 * 空串 / 认不出来就原样显示 —— 不猜、不编一个时间出来。
 */
export function fmtDeleteTime(v) {
  const s = String(v ?? '').trim();
  if (!s) return '—';
  if (!/^\d+$/.test(s)) return s;
  const d = new Date(Number(s) * 1000);
  if (Number.isNaN(d.getTime())) return s;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
