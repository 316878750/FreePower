/** 代理管理：本地代理列表的增删改 + 用 /proxy/check 预检出口。 */
import { h, mount, clear, toast, confirmDialog, drawer, pill, empty, fmtTime } from '../ui.js';
import { api } from '../api.js';

const TYPES = ['http', 'https', 'socks5', 'ssh'];
const CHECKABLE = ['http', 'https', 'socks5'];

export default async function renderProxies({ head, page }) {
  mount(head,
    h('h1', null, '代理管理'),
    h('span', { class: 'sub', id: 'px-sub' }, ''),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm', onClick: () => load(false) }, '刷新'),
    h('button', { class: 'btn primary', onClick: () => openForm(null) }, '新增代理'));

  const body = h('tbody');
  mount(page,
    h('div', { class: 'panel' },
      h('div', { class: 'panel-body' },
        h('table', { class: 'grid' },
          h('thead', null,
            h('tr', null,
              h('th', null, '备注 / 地址'),
              h('th', null, '类型'),
              h('th', null, '账号'),
              h('th', null, '最近预检'),
              h('th', { style: { width: '220px' } }, '操作'))),
          body))));

  await load(false);

  async function load(showToast) {
    try {
      const r = await api.proxies();
      const list = r.list || [];
      mount(document.getElementById('px-sub'), `${list.length} 个代理 · 只在本机保存`);
      if (!list.length) {
        mount(body, h('tr', null, h('td', { colspan: 5 }, empty('还没有代理。新增后可以在环境里绑定。'))));
        return;
      }
      clear(body);
      for (const p of list) body.appendChild(row(p));
    } catch (e) {
      if (showToast) toast(e.message, 'bad');
      mount(body, h('tr', null, h('td', { colspan: 5 }, h('div', { class: 'notice bad' }, e.message))));
    }
  }

  function row(p) {
    const checked = p.checked_at
      ? h('span', { class: 'row' },
        pill(p.last_ip ? `${p.last_ip}` : '无出口 IP', p.last_ip ? 'ok' : 'warn'),
        h('span', { class: 'muted small' }, `${p.last_country || ''} ${fmtTime(p.checked_at)}`))
      : h('span', { class: 'muted small' }, '没检查过');

    return h('tr', null,
      h('td', null,
        h('div', null, p.remark || `${p.host}:${p.port}`),
        h('div', { class: 'muted small mono' }, `${p.host}:${p.port}`)),
      h('td', null, h('span', { class: 'tag' }, p.type)),
      h('td', { class: 'mono' }, p.user ? `${p.user}${p.password ? ' / ••••' : ''}` : '—'),
      h('td', null, checked),
      h('td', { class: 'actions' },
        h('button', { class: 'btn sm', disabled: !CHECKABLE.includes(p.type), onClick: (e) => checkOne(p, e.target) }, '检测'),
        ' ',
        h('button', { class: 'btn sm ghost', onClick: () => openForm(p) }, '编辑'),
        ' ',
        h('button', { class: 'btn sm danger', onClick: () => removeOne(p) }, '删除')));
  }

  async function checkOne(p, btn) {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '检测中…';
    try {
      const r = await api.proxyCheck({ type: p.type, host: p.host, port: p.port, username: p.user, password: p.password });
      if (r.ok) {
        toast(`出口 ${r.ip} · ${r.country || ''} ${r.timezone || ''} · ${r.latency_ms}ms`, 'ok');
      } else {
        toast(`预检失败：${r.error || '未知原因'}`, 'bad');
      }
      await load(false);
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  async function removeOne(p) {
    const yes = await confirmDialog({
      title: '删除代理',
      body: h('div', { class: 'stack' },
        h('div', null, '删除 ', h('strong', null, p.remark || `${p.host}:${p.port}`), '？'),
        h('div', { class: 'notice warn' }, '正在引用它的环境会被解绑（回到直连），不会自动换代理。')),
      okLabel: '删除', danger: true,
    });
    if (!yes) return;
    try {
      await api.proxyDelete([p.proxy_id]);
      toast('已删除', 'ok');
      await load(false);
    } catch (e) { toast(e.message, 'bad'); }
  }

  function openForm(existing) {
    const f = {
      type: existing ? existing.type : 'http',
      host: existing ? existing.host : '',
      port: existing ? existing.port : '',
      user: existing ? existing.user : '',
      password: existing ? existing.password : '',
      remark: existing ? existing.remark : '',
    };
    const input = (key, props = {}) => h('input', {
      ...props,
      value: f[key] === undefined || f[key] === null ? '' : String(f[key]),
      onInput: (e) => { f[key] = e.target.value; },
    });

    const form = h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, '类型'),
        h('select', { onChange: (e) => { f.type = e.target.value; } },
          ...TYPES.map((t) => h('option', { value: t, selected: f.type === t }, t)))),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, '主机', h('span', { class: 'req' }, '*')), input('host', { placeholder: '1.2.3.4 或 proxy.example.com' })),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, '端口', h('span', { class: 'req' }, '*')), input('port', { type: 'number', placeholder: '8080' })),
      h('div', { class: 'row' },
        h('label', { class: 'field', style: { flex: '1' } }, h('span', { class: 'lbl' }, '账号'), input('user')),
        h('label', { class: 'field', style: { flex: '1' } }, h('span', { class: 'lbl' }, '密码'), input('password', { type: 'password' }))),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, '备注'), input('remark', { placeholder: '例如 美区-住宅-01' })),
      h('div', { class: 'notice info' },
        'http/socks5 支持账号密码；https 代理的 TLS-in-TLS 预检不支持（README 已知限制 8）。'),
      h('div', { class: 'muted small' }, '保存不会自动预检 —— 想先验证就保存后点「检测」。'));

    const d = drawer({
      title: existing ? '编辑代理' : '新增代理',
      body: form,
      footer: [
        h('button', { class: 'btn', onClick: () => d.close() }, '取消'),
        h('button', { class: 'btn primary', onClick: async () => {
          const host = String(f.host || '').trim();
          const port = Number(f.port);
          if (!host) { toast('主机不能为空', 'bad'); return; }
          if (!Number.isFinite(port) || port <= 0 || port > 65535) { toast('端口必须是 1..65535', 'bad'); return; }
          const payload = {
            type: f.type, host, port,
            user: String(f.user || ''),
            password: String(f.password || ''),
            remark: String(f.remark || '').trim(),
          };
          try {
            if (existing) await api.proxyUpdate({ ...payload, proxy_id: existing.proxy_id });
            else await api.proxyCreate([payload]);
            d.close();
            toast('已保存', 'ok');
            await load(false);
          } catch (e) { toast(e.message, 'bad'); }
        } }, existing ? '保存' : '创建'),
      ],
    });
  }
}