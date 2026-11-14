/**
 * 应用中心 / 扩展管理。
 *
 * 三条设计决定，改之前先读：
 *
 * 1. **扩展文件全局共享一份**（`<数据根>/ext_env/<id>/`），每个环境只存「勾了哪些」。
 *    这是照拆解结论（`adspower-reverse/8.9.23/27b`）做的：对手 8.9.23 也不是每环境一份副本，
 *    共享文件 + 环境级启用状态。给每个环境复制一份的代价是盘和启动时间都翻倍。
 *
 * 2. **导入收本机路径，不做上传**。这是个本机程序，用户手里的扩展也在本机，
 *    给路径比把几百 MB 走 HTTP 上传更短、更可核对（落盘路径会回显在列表里）。
 *    界面上不假装有「拖拽上传」——拖进来的文件浏览器给不了真实路径。
 *
 * 3. **加载发生在环境启动之后**（CDP `Extensions.loadUnpacked`），不是命令行 `--load-extension`
 *    ——那条在 Chrome 137+ 已经被移除，本机 157 实测四组对照全部不生效。
 *    所以「勾了扩展但环境正在跑」时必须告诉用户**重启才生效**，不能假装立刻生效。
 */
import { h, mount, clear, toast, confirmDialog, promptDialog, pill, empty } from '../ui.js';
import { api } from '../api.js';

export default async function renderApps({ head, page }) {
  let list = [];

  const sub = h('span', { class: 'sub' }, '');
  mount(head,
    h('h1', null, '应用中心'),
    sub,
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm', onClick: () => load(true) }, '刷新'),
    h('button', { class: 'btn primary', onClick: () => openImport() }, '导入扩展'));

  const noticeBox = h('div', { class: 'stack' });
  const body = h('tbody');
  mount(page,
    noticeBox,
    h('div', { class: 'panel' },
      h('div', { class: 'panel-body' },
        h('table', { class: 'grid' },
          h('thead', null,
            h('tr', null,
              h('th', null, '扩展'),
              h('th', { style: { width: '90px' } }, '版本'),
              h('th', { style: { width: '110px' } }, '状态'),
              h('th', { style: { width: '110px' } }, '被几个环境用'),
              h('th', null, '落盘目录'),
              h('th', { style: { width: '200px' } }, '操作'))),
          body))));

  mount(noticeBox, h('div', { class: 'notice info' },
    h('div', null, '扩展文件在本机只存一份，所有环境共用；「哪个环境用哪些」在环境里勾选。'),
    h('div', { class: 'muted small' },
      '导入方式：把已解压的扩展目录（里面有 manifest.json）或扩展的 .zip 完整路径粘进来。' +
      '加载发生在环境启动之后，所以改完勾选要重启该环境才生效。')));

  await load(false);

  async function load(showToast) {
    try {
      const r = await api.apps();
      list = r.list || [];
      mount(sub, `${list.length} 个扩展 · 文件全局共享一份`);
      if (!list.length) {
        mount(body, h('tr', null, h('td', { colspan: 6 }, empty('还没有扩展。点右上角「导入扩展」。'))));
        return;
      }
      clear(body);
      for (const e of list) body.appendChild(row(e));
    } catch (e) {
      if (showToast) toast(e.message, 'bad');
      mount(body, h('tr', null, h('td', { colspan: 6 }, h('div', { class: 'notice bad' }, e.message))));
    }
  }

  function row(e) {
    const on = e.status !== '0';
    const used = Number(e.used_by || 0);
    return h('tr', null,
      h('td', null,
        h('div', null, e.name || `扩展 ${e.id}`),
        h('div', { class: 'muted small' },
          [
            e.manifest_version ? `MV${e.manifest_version}` : '',
            e.unique_id ? `ID ${e.unique_id}` : 'ID 未知（启动过一次后才会记录）',
            e.description ? String(e.description).slice(0, 60) : '',
          ].filter(Boolean).join(' · '))),
      h('td', { class: 'mono' }, e.version || '—'),
      h('td', null, pill(on ? '已启用' : '已停用', on ? 'ok' : 'idle')),
      h('td', null,
        used
          ? h('span', null, `${used} 个`)
          : h('span', { class: 'muted small' }, '没环境在用')),
      h('td', { class: 'muted small mono', title: e.abs_path || '' },
        h('div', null, e.path || ''),
        h('div', null, `${e.files || 0} 个文件 · ${fmtBytes(e.bytes)}`)),
      h('td', { class: 'actions' },
        h('button', { class: 'btn sm', onClick: () => toggle(e) }, on ? '停用' : '启用'),
        ' ',
        h('button', { class: 'btn sm ghost', onClick: () => rename(e) }, '改名'),
        ' ',
        h('button', { class: 'btn sm danger', onClick: () => removeOne(e) }, '删除')));
  }

  function fmtBytes(n) {
    const v = Number(n || 0);
    if (!v) return '0 B';
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${(v / 1024 / 1024).toFixed(1)} MB`;
  }

  /* ------------------------------ 操作 ------------------------------ */

  async function toggle(e) {
    const next = e.status === '0' ? '1' : '0';
    try {
      await api.appUpdate({ id: e.id, status: next });
      toast(next === '1' ? `已启用「${e.name}」` : `已停用「${e.name}」：勾了它的环境重启后就不再加载`, 'ok');
      await load(false);
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  async function rename(e) {
    const v = await promptDialog({ title: '给扩展改个名字', label: '显示名（只改 FreePower 里显示的名字，不动扩展本身）', value: e.name });
    if (v === null) return;
    try {
      await api.appUpdate({ id: e.id, name: v });
      await load(false);
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  async function removeOne(e) {
    const used = Number(e.used_by || 0);
    const ok = await confirmDialog({
      title: '删除扩展',
      danger: true,
      okLabel: '删除',
      body: h('div', { class: 'stack' },
        h('div', null, `确定删除「${e.name} ${e.version}」？`),
        h('div', { class: 'muted small' }, `会同时删掉落盘目录 ${e.path}。`),
        used ? h('div', { class: 'notice warn' }, `有 ${used} 个环境勾着它：删除后这些环境重启时就没有这个扩展了。`) : null),
    });
    if (!ok) return;
    try {
      const r = await api.appDelete([e.id]);
      const running = (r.running_affected || []).length;
      toast(running
        ? `已删除。有 ${running} 个正在运行的环境还加载着它，重启后才真的没有`
        : '已删除', 'ok');
      await load(false);
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  function openImport() {
    const pathInput = h('input', { type: 'text', placeholder: 'C:\\Users\\你\\Downloads\\some-extension  或  …\\ext.zip' });
    const nameInput = h('input', { type: 'text', placeholder: '留空 = 用 manifest.json 里的名字' });
    const hint = h('div', { class: 'muted small' }, '');
    const okBtn = h('button', { class: 'btn primary', onClick: () => submit() }, '导入');
    const root = document.getElementById('dialog-root');
    const done = () => overlay.remove();
    const overlay = h('div', { class: 'overlay', onClick: (ev) => { if (ev.target === overlay) done(); } },
      h('div', { class: 'dialog', role: 'dialog' },
        h('h3', null, '导入扩展'),
        h('div', { class: 'body stack' },
          h('label', { class: 'field' }, h('span', { class: 'lbl' }, '本机路径（目录或 .zip）'), pathInput),
          h('label', { class: 'field' }, h('span', { class: 'lbl' }, '显示名（可选）'), nameInput),
          hint,
          h('div', { class: 'notice' },
            h('div', null, '收的是本机路径，不是上传：扩展文件会被复制到 FreePower 的共享目录，' +
              '之后原目录删掉也不影响。'),
            h('div', { class: 'muted small' }, '.crx 是 Chrome 的签名包，请先解压成目录再导入。'))),
        h('div', { class: 'foot' },
          h('button', { class: 'btn', onClick: done }, '取消'),
          okBtn)));
    root.appendChild(overlay);
    pathInput.focus();

    async function submit() {
      const p = pathInput.value.trim();
      if (!p) { mount(hint, h('span', { class: 'pill bad' }, '先填路径')); return; }
      okBtn.disabled = true;
      okBtn.textContent = '导入中…';
      try {
        const r = await api.appImport({ path: p, name: nameInput.value.trim() || undefined });
        done();
        const warns = (r.warnings || []).filter(Boolean);
        toast(r.duplicate ? `这个扩展已经在库里了（${r.name} ${r.version}），没有重复导入` : `已导入「${r.name} ${r.version}」`,
          r.duplicate ? '' : 'ok');
        for (const w of warns) toast(w, w.includes('Manifest V2') ? 'bad' : '');
        await load(false);
      } catch (err) {
        mount(hint, h('span', { class: 'pill bad' }, err.message));
        okBtn.disabled = false;
        okBtn.textContent = '导入';
      }
    }
  }
}
