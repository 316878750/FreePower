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

/** 快照占用的显示格式（彻底删除确认框里要说清「占 X MB」） */
function fmtBytes(b) {
  if (b === null || b === undefined) return '—';
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

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
          + '那一步会真的删掉记录和 user-data 目录，不可恢复。'))),
    cacheCleanupPanel());

  /**
   * 按天数删缓存（0.4.7 ④）。
   *
   * 为什么放在回收站页：这一页本来就是「腾磁盘」的地方。但它和回收站**不是一回事** ——
   * 回收站删的是**记录**，这里删的是**还在用的环境的数据目录**（环境本身留着）。
   *
   * 三步，一步都不省（不可逆操作的标准姿势）：
   *   1. 选天数 → 预览：**列出将删哪些、每个多大、哪些不删以及为什么**；
   *   2. 用户逐条看过、勾掉不想删的；
   *   3. 真删，报「删了几个、释放多少、哪几个没删掉以及为什么」。
   *
   * 天数只认我们自己记录的「最后启动时间」，**不看文件时间** —— 所以清单里那一列是真的，
   * 而「判定不了」的环境会单独列出来并说明「不删」。
   */
  function cacheCleanupPanel() {
    const daysInput = h('input', { type: 'number', min: '0', step: '1', value: '30', style: { width: '90px' } });
    const resultBox = h('div', { class: 'stack', style: { marginTop: '10px' } });

    async function preview() {
      const days = Number(daysInput.value);
      if (!Number.isFinite(days) || days < 0) { toast('天数要填 ≥0 的整数', 'bad'); return; }
      let r;
      try { r = await api.cacheCleanupPreview({ days }); } catch (e) { toast(`预览失败：${e.message}`, 'bad'); return; }
      const del = r.will_delete || [];
      const keep = r.keep || [];
      const fmt = (b) => (b === null || b === undefined ? '—' : `${(b / 1048576).toFixed(1)} MB`);

      if (!del.length) {
        mount(resultBox,
          h('div', { class: 'notice' }, `没有 ${days} 天以上没启动过的环境（扫了 ${r.summary.scanned} 个）。`),
          keep.length ? keepList(keep) : null);
        return;
      }

      const checks = new Map();
      const rows = del.map((x) => {
        const cb = h('input', { type: 'checkbox', checked: true });
        checks.set(x.profile_id, cb);
        return h('tr', null,
          h('td', null, cb),
          h('td', null, h('div', null, x.name || '(未命名)'), h('span', { class: 'muted small mono' }, `#${x.profile_no ?? '—'}`)),
          h('td', null, `${x.days_unused} 天前`),
          h('td', { class: 'muted small' }, x.last_launch_at ? x.last_launch_at.slice(0, 19).replace('T', ' ') : '—'),
          h('td', null, fmt(x.size_bytes)));
      });

      mount(resultBox,
        h('div', { class: 'notice warn' },
          `将删除 ${del.length} 个环境的数据目录，共 ${fmt(r.total_bytes)}。删掉的是 cache / cookie / localStorage / 书签 / 登录态 —— `,
          h('strong', null, '下次启动是全新浏览器'),
          '，环境本身（记录、代理、指纹配置）都还在。'),
        h('div', { class: 'muted small' },
          '「多久没开」用的是我们自己记录的「最后启动时间」，不是文件时间（文件时间会被备份、复制、杀毒软件改掉，拿它判断会删错）。'),
        (r.unknown_count > 0)
          ? h('div', { class: 'notice' },
            `其中 ${r.unknown_count} 个环境没有「最后启动时间」的记录（0.4.7 之前启动过的都是这样），`,
            h('strong', null, '判定不了多久没开，一律不删'),
            ' —— 它们在环境里真启动一次之后才会有记录。')
          : null,
        h('table', { class: 'grid' },
          h('thead', null, h('tr', null,
            h('th', { style: { width: '40px' } }, ''),
            h('th', null, '环境'),
            h('th', { style: { width: '110px' } }, '未启动'),
            h('th', { style: { width: '170px' } }, '最后启动'),
            h('th', { style: { width: '100px' } }, '占用'))),
          h('tbody', null, ...rows)),
        keep.length ? keepList(keep) : null,
        h('div', { class: 'toolbar', style: { marginTop: '10px' } },
          h('button', {
            class: 'btn danger',
            onClick: () => confirmAndRun(days, del.filter((x) => checks.get(x.profile_id)?.checked), fmt),
          }, '删除勾选的这些数据目录')));

      async function confirmAndRun(d, list, fmtSize) {
        if (!list.length) { toast('一个都没勾'); return; }
        const yes = await confirmDialog({
          title: '按天数删缓存 · 确认',
          body: h('div', { class: 'stack' },
            h('div', null, `将删除 ${list.length} 个环境的数据目录，共 ${fmtSize(list.reduce((n, x) => n + (x.size_bytes || 0), 0))}。`),
            h('div', { class: 'notice bad' },
              h('strong', null, '这一步不可恢复'),
              '。删掉的是整个环境数据目录：cache、cookie、localStorage、书签、登录态。'
              + '下次启动是全新浏览器，要重新登录。'),
            h('div', { class: 'muted small' },
              '环境本身不会被删：记录、代理、指纹配置都还在，只是浏览器里的东西没了。'),
            h('div', { class: 'code-block', style: { whiteSpace: 'pre-wrap', maxHeight: '30vh', overflow: 'auto' } },
              list.map((x) => `· ${x.name || x.profile_id}（#${x.profile_no ?? '—'}）：${x.days_unused} 天未启动，${fmtSize(x.size_bytes)}`).join('\n'))),
          okLabel: '确认删除', danger: true,
        });
        if (!yes) { toast('已取消，一个字节都没动'); return; }
        let res;
        try {
          res = await api.cacheCleanup({
            days: d,
            confirm_ids: list.map((x) => x.profile_id),
          });
        } catch (e) { toast(`删除失败：${e.message}`, 'bad'); return; }
        const s = res.summary || {};
        const failed = res.failed || [];
        const absentN = s.already_absent || 0;
        mount(resultBox,
          h('div', { class: failed.length ? 'notice warn' : 'notice ok' },
            `已删除 ${s.deleted} 个环境的数据目录，释放 ${fmtSize(s.freed_bytes)}。`
            + (absentN ? `另有 ${absentN} 个本来就没有数据目录（没东西可删，不算删除）。` : '')
            + (failed.length ? `${failed.length} 个没删掉。` : '')),
          failed.length ? h('div', { class: 'code-block', style: { whiteSpace: 'pre-wrap' } },
            failed.map((f) => `· ${f.name || f.profile_id}：${f.intact ? '一个字节都没动（被占用，关掉占用后可以再试）' : '数据已不在原位置'}${f.error_code ? `（${f.error_code}）` : ''}`).join('\n')) : null,
          (res.kept_after_confirm || []).length
            ? h('div', { class: 'muted small' }, `有 ${res.kept_after_confirm.length} 个在你确认之后状态变了（比如刚被启动），已经跳过没删。`)
            : null,
          h('button', { class: 'btn sm', onClick: () => preview() }, '重新扫一遍'));
      }
    }

    function keepList(keep) {
      const byReason = new Map();
      for (const k of keep) {
        if (!byReason.has(k.reason)) byReason.set(k.reason, []);
        byReason.get(k.reason).push(k);
      }
      const LABEL = {
        recent: '最近启动过，不够天数',
        unknown: '判定不了多久没开（没有「最后启动时间」的记录）—— 一律不删',
        running: '现在就在运行',
        no_data: '天数够了，但没有数据目录',
      };
      return h('details', { style: { marginTop: '10px' } },
        h('summary', { class: 'muted small' }, `不删的 ${keep.length} 个（点开看原因）`),
        h('div', { class: 'stack', style: { marginTop: '6px' } },
          ...[...byReason].map(([reason, list]) => h('div', null,
            h('div', { class: 'muted small' }, `${LABEL[reason] || reason}：${list.length} 个`),
            h('div', { class: 'code-block', style: { whiteSpace: 'pre-wrap', maxHeight: '160px', overflow: 'auto' } },
              list.slice(0, 50).map((x) => `· ${x.name || x.profile_id}${x.why ? `：${x.why}` : ''}`).join('\n'))))));
    }

    return h('div', { class: 'panel', style: { marginTop: '14px' } },
      h('div', { class: 'panel-body' },
        h('div', { class: 'toolbar' },
          h('strong', null, '按天数清理未开环境的缓存'),
          h('span', { class: 'grow' })),
        h('div', { class: 'muted small', style: { marginBottom: '8px' } },
          '环境多了 data\\profiles 会占很多磁盘。这里按「多久没启动」筛出可以清掉的数据目录 —— ',
          h('strong', null, '会先列出将删哪些、各占多少'),
          '，你确认之后才真删。'),
        h('div', { class: 'toolbar' },
          h('span', null, '删除'),
          daysInput,
          h('span', null, '天以上没启动的环境数据'),
          h('button', { class: 'btn sm', onClick: () => preview() }, '先看看会删哪些')),
        resultBox));
  }

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
    /*
     * 彻底删除前必须先问一次「会连多少份备份一起删」。
     *
     * 用户如果以为「删环境还留着备份」，那才是真误导 —— 环境记录一删，快照就再也没入口恢复了
     * （`restoreSnapshot` 需要 profile 记录）。所以确认框里把份数和占用直接写出来。
     * 预览是只读的；拿不到也不拦着删，只是那句话不说（不许因此假装「没有备份」）。
     */
    let snapInfo = null;
    try {
      const pv = await api.snapshotPurgePreview({ profile_id: [r.profile_id] });
      snapInfo = { count: pv.total_count || 0, bytes: pv.total_bytes || 0 };
    } catch { snapInfo = null; }

    const yes = await confirmDialog({
      title: '彻底删除',
      body: h('div', { class: 'stack' },
        h('div', null, '即将彻底删除 ', h('strong', null, r.name || r.profile_id)),
        h('div', { class: 'notice bad' },
          '这一步不可恢复：会删掉这条记录和它的 user-data 目录（cookie、登录态、缓存）。'),
        snapInfo && snapInfo.count > 0
          ? h('div', { class: 'notice bad' },
            '会一并删掉这个环境的 ',
            h('strong', null, `${snapInfo.count} 份备份快照`),
            `（占 ${fmtBytes(snapInfo.bytes)}）。`,
            '环境记录删掉之后这些快照就再也恢复不了了，所以要留着备份请先取消、把环境从回收站恢复。')
          : null,
        snapInfo && snapInfo.count === 0
          ? h('div', { class: 'muted small' }, '这个环境没有备份快照。')
          : null),
      okLabel: '彻底删除', danger: true,
    });
    if (!yes) return;
    try {
      const res = await api.recyclePurge({ profile_id: [r.profile_id] });
      const okN = (res.purged || []).length;
      const snapGone = res.snapshots_removed || 0;
      const snapKept = res.snapshots_kept || 0;
      // 盘删不掉时后端不删库（留个还能再点的入口），这里必须如实说，不能报成功
      if (!okN) { toast(`没能删掉：${skipReason(res.skipped)}`, 'bad'); await load(); return; }
      const tail = [
        snapGone ? `，连同 ${snapGone} 份备份快照` : '',
        snapKept ? `，但有 ${snapKept} 份备份没删掉（被占用，占着磁盘）` : '',
      ].join('');
      toast(`已彻底删除${tail}`, snapKept ? 'warn' : 'ok');
      await load();
    } catch (e) { toast(`彻底删除失败：${e.message}`, 'bad'); }
  }

  async function emptyAll() {
    if (!rows.length && pageNo === 1) { toast('回收站已经是空的'); return; }
    let snapInfo = null;
    try {
      const pv = await api.snapshotPurgePreview({ all: true });
      snapInfo = { count: pv.total_count || 0, bytes: pv.total_bytes || 0 };
    } catch { snapInfo = null; }
    const yes = await confirmDialog({
      title: '清空回收站',
      body: h('div', { class: 'stack' },
        h('div', null, '会彻底删除回收站里的全部环境（不只是这一页）。'),
        h('div', { class: 'notice bad' }, '不可恢复：记录和每个环境的 user-data 目录都会被删掉。'),
        snapInfo && snapInfo.count > 0
          ? h('div', { class: 'notice bad' },
            '还会一并删掉 ',
            h('strong', null, `${snapInfo.count} 份备份快照`),
            `（占 ${fmtBytes(snapInfo.bytes)}）—— 环境记录没了，这些备份就再也恢复不了。`)
          : null),
      okLabel: '清空', danger: true,
    });
    if (!yes) return;
    try {
      const res = await api.recyclePurge({ all: true });
      const okN = (res.purged || []).length;
      const badN = (res.skipped || []).length;
      const snapGone = res.snapshots_removed || 0;
      const snapKept = res.snapshots_kept || 0;
      // 「没删掉几个」不够：得说为什么没删掉，否则用户只能干瞪眼
      toast(`已彻底删除 ${okN} 个${snapGone ? `、连同 ${snapGone} 份备份快照` : ''}`
        + `${snapKept ? `，有 ${snapKept} 份备份没删掉（被占用）` : ''}`
        + `${badN ? `，${badN} 个环境没删掉：${skipReason(res.skipped)}` : ''}`,
      (badN || snapKept) ? 'bad' : 'ok');
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
      // 这一支保证「一个字节都没动」（先改名再删，改名失败就没动过），所以能放心说「还能恢复」
      return `user-data 目录删不掉${code}：可能有程序还占着它（比如没退干净的浏览器进程）。`
        + '数据一点没动，关掉之后可以再试一次。';
    case 'userdata_remove_failed_after_rename':
      // 这一支数据已经不在原路径上了 —— 必须说清「不能恢复」，不能再让用户以为还能救回来
      return '目录已被移走但删不掉（数据已不在原位置）：这条环境不能再恢复了。'
        + `记录已清除，残留目录在 ${s.detached_path || '数据目录下'}，可手动删除${code}。`;
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
