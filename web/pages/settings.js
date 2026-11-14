/**
 * 设置页（0.4.3 ④）。
 *
 * 这一页的规矩（比功能本身重要）：
 *   1. **摆上来的项必须真生效** —— 同步默认设置改了，下一次「开始同步」就按新值走
 *      （`/api/v2/sync/start` 读 `meta.sync_defaults`）；快捷键改了，桌面壳真的重新注册。
 *   2. **做不到的不许当装饰** —— 每一行要么可用，要么写明「未实现」+ 为什么，
 *      或者「入口在别处」+ 在哪。摆一个点了没反应的开关，比不摆更糟。
 *   3. **外观沿用 ③ 的密度口径**：只写 localStorage（`fp.view_density`），
 *      不写库、不同步到别的机器 —— 与列表页那个「视图」下拉是同一个键、同一套值。
 */
import { h, mount, toast } from '../ui.js';
import { api } from '../api.js';
import { DENSITIES, readDensity, setDensity } from '../density.js';

const panel = (title, ...kids) => h('section', { class: 'panel' },
  h('div', { class: 'panel-head' }, h('h3', { style: { margin: 0, fontSize: '13px' } }, title)),
  h('div', { class: 'panel-body' }, ...kids));

export default async function settingsPage({ head, page }) {
  mount(head,
    h('h1', null, '设置'),
    h('div', { class: 'sub' }, '只放真的会生效的项；做不到的写在最后一节，并说明原因。'));

  const body = h('div', { class: 'stack', style: { gap: '14px' } });
  mount(page, body);

  /* ======================= 1. 窗口同步的默认设置 ======================= */
  const syncBox = h('div', { class: 'stack' });
  const syncNote = h('div', { class: 'muted small' });
  body.appendChild(panel('窗口同步：默认设置', syncBox, syncNote));

  let defaults = null;

  function syncForm(st) {
    const numBox = (key, min, max, step, width = '90px') => h('input', {
      type: 'number', min, max, step, value: st[key] ?? 0,
      style: { width },
      onChange: (e) => save({ [key]: Number(e.target.value) || 0 }),
    });
    const sw = (key, label, hint) => h('label', { class: 'checks', style: { display: 'inline-flex' } },
      h('input', { type: 'checkbox', checked: !!st[key], onChange: (e) => save({ [key]: e.target.checked }) }),
      h('span', null, label),
      hint ? h('span', { class: 'muted small' }, `　${hint}`) : null);

    mount(syncBox,
      h('div', { class: 'row' },
        sw('move', '鼠标移动'), sw('click', '点击'), sw('scroll', '滚动'), sw('input', '键盘输入')),
      h('div', { class: 'row', style: { marginTop: '6px' } },
        sw('text_sync', '相同文本输入', '关掉只同步按键、不落字符'),
        sw('paste', '粘贴同步'), sw('typing', '模拟人工输入', '逐字 + 随机间隔'),
        sw('random_number', '随机数字输入', '每窗各自一个数')),
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('span', { class: 'muted small' }, '打字间隔'),
        numBox('typing_min_ms', 0, 2000, 5, '70px'), h('span', { class: 'muted small' }, '–'),
        numBox('typing_max_ms', 0, 2000, 5, '70px'), h('span', { class: 'muted small' }, 'ms'),
        h('span', { class: 'muted small', style: { marginLeft: '16px' } }, '随机数字范围'),
        numBox('random_min', 0, 1000000000, 1, '110px'), h('span', { class: 'muted small' }, '–'),
        numBox('random_max', 0, 1000000000, 1, '110px')),
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('span', { class: 'muted small' }, '延迟'),
        numBox('delay_ms', 0, 5000, 10), h('span', { class: 'muted small' }, 'ms'),
        h('span', { class: 'muted small', style: { marginLeft: '16px' } }, '随机抖动'),
        numBox('jitter_ms', 0, 5000, 10), h('span', { class: 'muted small' }, 'ms')),
      h('div', { class: 'row', style: { marginTop: '10px' } },
        h('button', { class: 'btn', onClick: reset }, '恢复内置默认'),
        h('span', { class: 'muted small' }, '只影响「下一次开始同步」，不会打断正在跑的会话。')));
  }

  function paintSync() {
    syncForm(defaults);
    const diff = diffOf(defaults);
    mount(syncNote,
      diff.length
        ? `已改 ${diff.length} 项：${diff.join('、')}。下一次「开始同步」按这些值走（正在跑的会话不受影响，可在同步页运行中直接改）。`
        : '当前与内置默认一致。这些值会真的用在「开始同步」上 —— 不是只记在界面上。');
  }

  function diffOf(st) {
    const builtin = {
      input: true, click: true, scroll: true, move: true,
      text_sync: true, typing: false, paste: true, random_number: false,
      typing_min_ms: 30, typing_max_ms: 120, random_min: 1000, random_max: 9999,
      same_tab: true, current_tab_url: false, delay_ms: 0, jitter_ms: 0,
    };
    return Object.keys(builtin).filter((k) => k !== 'same_tab' && st?.[k] !== builtin[k]);
  }

  async function save(patch) {
    try {
      const r = await api.saveSyncDefaults(patch);
      defaults = r.settings;
      paintSync();
      toast(r.changed?.length ? `已保存（改了 ${r.changed.length} 项）` : '已保存', 'ok');
      if (r.ignored?.length) toast(`这些字段不认，没有保存：${r.ignored.join('、')}`, 'warn');
    } catch (e) {
      toast(`保存失败：${e.message}`, 'bad');
      await loadSettings(false);
    }
  }

  async function reset() {
    try {
      const r = await api.resetSyncDefaults();
      defaults = r.settings;
      paintSync();
      toast('已恢复内置默认', 'ok');
    } catch (e) { toast(`恢复失败：${e.message}`, 'bad'); }
  }

  /* ======================= 2. 全局快捷键 ======================= */
  const hotBox = h('div', { class: 'row' });
  body.appendChild(panel('窗口同步：全局快捷键', hotBox,
    h('div', { class: 'muted small' },
      '注册全局快捷键是桌面壳的能力（网页端没有），所以这里改、桌面壳那边重新注册。'
      + '「没被桌面壳管着」不是失败：用 `npm start` 直接起服务时就是这种状态。')));

  function paintHotkey(st) {
    const input = h('input', { type: 'text', value: st?.accelerator || 'CommandOrControl+Alt+S', style: { width: '260px' } });
    mount(hotBox,
      input,
      h('button', { class: 'btn', onClick: () => saveHotkey(input.value) }, '保存'),
      h('span', { class: st?.managed ? 'pill ok' : 'pill idle' }, st?.managed ? '桌面壳已接管' : '没有桌面壳'),
      // ok === false 才是「真的注册失败」（ok === null = 还没试过，不能报错）
      st?.ok === false ? h('span', { class: 'pill bad' }, `注册失败：${st?.error || '组合键可能被别的程序占着'}`) : null,
      st?.managed ? h('span', { class: 'muted small' }, `上次更新：${st.updated_at || '—'}`) : null);
  }

  async function saveHotkey(acc) {
    try {
      const r = await api.syncHotkeySet(String(acc || '').trim());
      const st = r?.status || r;
      paintHotkey(st);
      toast(st?.managed === false ? '已记下，但没有桌面壳在管，重启桌面版后生效' : '快捷键已更新', st?.managed === false ? 'warn' : 'ok');
    } catch (e) { toast(`改快捷键失败：${e.message}`, 'bad'); }
  }

  /* ======================= 3. 外观（= 视图密度） ======================= */
  const lookBox = h('div', { class: 'stack' });
  body.appendChild(panel('外观', lookBox,
    h('div', { class: 'muted small' },
      '视图密度与列表页工具条那个「视图」是**同一个设置**（同一个 localStorage 键 `fp.view_density`）。'
      + '只存在这台机器的这个浏览器里，不写库、不同步到别的机器。')));

  function paintLook() {
    const cur = readDensity();
    mount(lookBox,
      h('div', { class: 'row' },
        ...DENSITIES.map((d) => h('label', { class: 'checks', style: { display: 'inline-flex' } },
          h('input', {
            type: 'radio', name: 'fp-density', checked: cur === d.id,
            onChange: () => { setDensity(d.id); paintLook(); toast(`视图密度：${d.label}`, 'ok'); },
          }),
          h('span', null, `${d.label}（行高 ${d.rowHeight}px）`)))),
      h('div', { class: 'muted small' },
        '三档行高 30 / 44 / 64 px 是我们选的值：对手界面只给了「紧凑 / 标准 / 超高」三个名字，没给数字。'));
  }

  /* ======================= 4. 本地 API（只读摘要） ======================= */
  const apiBox = h('div', { class: 'stack' });
  body.appendChild(panel('本地 API', apiBox,
    h('div', { class: 'muted small' },
      '开关、key 重置、端点清单都在「API & MCP」页 —— 这里不重复摆一份，免得两处状态打架。')));

  function paintApi(info) {
    mount(apiBox,
      h('dl', { class: 'kv' },
        h('dt', null, '地址'), h('dd', null, info?.url || `127.0.0.1:${api.boot.port || '—'}`),
        h('dt', null, '验证'), h('dd', null, info?.verify === false ? '关（不校验 api_key）' : '开（校验 api_key）'),
        h('dt', null, '本次请求'), h('dd', null, String(info?.stats?.total ?? '—'))),
      h('div', { class: 'row' },
        h('a', { class: 'btn', href: '#/api' }, '去 API & MCP 页')));
  }

  /* ======================= 5. 未实现 / 入口在别处 ======================= */
  const notBox = h('div', { class: 'stack' });
  body.appendChild(panel('没做 / 在别处（如实写，不当装饰）', notBox));

  mount(notBox,
    h('table', { class: 'grid' },
      h('thead', null, h('tr', null, h('th', null, '项'), h('th', null, '状态'), h('th', null, '说明'))),
      h('tbody', null,
        row('开机自启', '已实现，入口在别处', '桌面版托盘菜单里（默认关）。网页端没有 Electron 能力，不重复提供一个点了不生效的开关。'),
        row('界面语言', '未实现', '现在界面文案直接写在代码里、只有中文；做多语言要给全部文案建键表并逐页核对，这一版没做。'),
        row('主题（跟随系统 / 浅色 / 深色）', '未实现', '当前只有一套配色。深色主题要重做整套 CSS 变量并逐页核对对比度，不是加一个开关的事。'),
        row('退出登录', '不适用', 'FreePower 是纯本地产品，没有账号体系，也就没有登录态可退。'),
        row('自动更新', '未实现', '需要更新源与签名校验；现在升级方式是装新版本安装包（升级说明里写了怎么退回去）。'))));

  function row(name, state, why) {
    const kind = state.startsWith('未实现') ? 'warn' : state.startsWith('不适用') ? 'idle' : 'ok';
    return h('tr', null,
      h('td', null, name),
      h('td', null, h('span', { class: `pill ${kind}` }, state)),
      h('td', { class: 'muted small' }, why));
  }

  /* ======================= 6. 关于 ======================= */
  const aboutBox = h('div', { class: 'stack' });
  body.appendChild(panel('关于', aboutBox));

  function paintAbout(snap) {
    const s = snap?.service || {};
    const kb = (n) => (n === null || n === undefined ? '—' : `${(n / 1024).toFixed(0)} KB`);
    mount(aboutBox,
      h('dl', { class: 'kv' },
        h('dt', null, '版本'), h('dd', null, s.version || api.boot.version || '—'),
        h('dt', null, '本地地址'), h('dd', null, s.url || `127.0.0.1:${api.boot.port || '—'}`),
        h('dt', null, '数据目录'), h('dd', null, s.data_dir || '—'),
        h('dt', null, '数据库'), h('dd', null, `${s.db?.path || '—'}（${kb(s.db?.bytes)}，WAL ${kb(s.db?.wal_bytes)}）`),
        h('dt', null, '内核'), h('dd', null, `已装 ${snap?.kernels?.installed?.length ?? 0} 个 · 运行中 ${snap?.kernels?.running?.length ?? 0} 个`)),
      h('div', { class: 'muted small' }, '只拷 `freepower.db` 等于没备份：数据在 `-wal` 里（升级前备份要连 `-wal` 一起拷）。'),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/diagnostics' }, '去网络诊断')));
  }

  /* ======================= 载入 ======================= */
  async function loadSettings(showToast = true) {
    try {
      const r = await api.settings();
      defaults = r.sync_defaults;
      paintSync();
      if (r.sync_defaults_broken) {
        toast('库里的同步默认设置存坏了，已回内置默认（保存一次就会覆盖掉坏数据）', 'warn');
      }
    } catch (e) {
      mount(syncBox, h('div', { class: 'notice bad' }, e.message));
      if (showToast) toast(e.message, 'bad');
    }
  }

  paintLook();

  const [hot, info, snap] = await Promise.all([
    api.syncHotkey().catch(() => null),
    api.apiInfo().catch(() => null),
    api.diagnoseNetwork().catch(() => null),
  ]);
  paintHotkey(hot);
  paintApi(info);
  paintAbout(snap);
  await loadSettings(false);
}