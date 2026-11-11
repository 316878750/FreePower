/** 代理管理：本地代理列表的增删改 + 单条/批量健康检查（出口 IP / 国家 / 延迟 / 具体失败原因）。 */
import { h, mount, clear, toast, confirmDialog, drawer, pill, empty, fmtTime } from '../ui.js';
import { api } from '../api.js';

const TYPES = ['http', 'https', 'socks5', 'ssh'];
const CHECKABLE = ['http', 'https', 'socks5'];
/** 超过这个时间的结果只当参考（代理换了出口/掉线都是常事） */
const STALE_MS = 24 * 3600 * 1000;

export default async function renderProxies({ head, page }) {
  /** proxy_id -> 最近一次检测结果（内存里的，含失败原因；刷新页面就没了，DB 只存成功那次的出口） */
  const checks = new Map();
  let current = [];

  const batchBtn = h('button', { class: 'btn', onClick: () => checkAll() }, '全部检测');
  mount(head,
    h('h1', null, '代理管理'),
    h('span', { class: 'sub', id: 'px-sub' }, ''),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm', onClick: () => load(false) }, '刷新'),
    batchBtn,
    h('button', { class: 'btn primary', onClick: () => openForm(null) }, '新增代理'));

  const summaryBox = h('div', { class: 'stack' });
  const body = h('tbody');
  mount(page,
    summaryBox,
    h('div', { class: 'panel' },
      h('div', { class: 'panel-body' },
        h('table', { class: 'grid' },
          h('thead', null,
            h('tr', null,
              h('th', null, '备注 / 地址'),
              h('th', null, '类型'),
              h('th', null, '账号'),
              h('th', null, '最近检测'),
              h('th', { style: { width: '220px' } }, '操作'))),
          body))));

  await load(false);

  async function load(showToast) {
    try {
      const r = await api.proxies();
      current = r.list || [];
      mount(document.getElementById('px-sub'), `${current.length} 个代理 · 只在本机保存`);
      if (!current.length) {
        mount(body, h('tr', null, h('td', { colspan: 5 }, empty('还没有代理。新增后可以在环境里绑定。'))));
        return;
      }
      clear(body);
      for (const p of current) body.appendChild(row(p));
    } catch (e) {
      if (showToast) toast(e.message, 'bad');
      mount(body, h('tr', null, h('td', { colspan: 5 }, h('div', { class: 'notice bad' }, e.message))));
    }
  }

  /* ------------------------------ 结果展示 ------------------------------ */

  function relTime(iso) {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return `${s} 秒前`;
    if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
    return `${Math.round(s / 86400)} 天前`;
  }

  /** 失败原因：一句人话 + 原文（原文太长就截断，别把表格撑爆） */
  function failureCell(r) {
    const label = r.error_label || '失败';
    const raw = String(r.error || '').trim();
    const short = raw.length > 90 ? `${raw.slice(0, 90)}…` : raw;
    return h('div', { class: 'stack', style: { gap: '2px' } },
      h('div', null, pill(label, 'bad')),
      short ? h('div', { class: 'muted small mono', title: raw }, short) : null,
      h('div', { class: 'muted small' }, r.checked_at ? relTime(r.checked_at) : ''));
  }

  function okCell(r) {
    const geo = [r.country || r.countryCode || '', r.city || ''].filter(Boolean).join(' ');
    return h('div', { class: 'stack', style: { gap: '2px' } },
      h('div', null, pill(r.ip || '无出口 IP', 'ok')),
      h('div', { class: 'muted small' },
        [geo, Number.isFinite(r.latency_ms) ? `${r.latency_ms}ms` : '', r.checked_at ? relTime(r.checked_at) : '']
          .filter(Boolean).join(' · ')));
  }

  function lastCheckCell(p) {
    // 1) 本次会话里刚检测过的（含失败原因，DB 不存失败）
    const live = checks.get(p.proxy_id);
    if (live) return live.ok ? okCell(live) : failureCell(live);
    // 2) 库里上次成功的结果（rememberProxyCheck 落的）
    if (!p.checked_at) return h('span', { class: 'muted small' }, '没检查过');
    const age = Date.now() - new Date(p.checked_at).getTime();
    const geo = [p.last_country || '', p.last_ip || ''].filter(Boolean).join(' · ');
    if (age > STALE_MS) {
      return h('div', { class: 'stack', style: { gap: '2px' } },
        h('div', null, pill('结果过期', 'warn')),
        h('div', { class: 'muted small' }, `${geo || '无出口 IP'} · ${relTime(p.checked_at)}`));
    }
    return h('div', { class: 'stack', style: { gap: '2px' } },
      h('div', null, pill(p.last_ip || '无出口 IP', p.last_ip ? 'ok' : 'warn')),
      h('div', { class: 'muted small' }, `${geo} · ${relTime(p.checked_at)}`));
  }

  function row(p) {
    return h('tr', null,
      h('td', null,
        h('div', null, p.remark || `${p.host}:${p.port}`),
        h('div', { class: 'muted small mono' }, `${p.host}:${p.port}`)),
      h('td', null, h('span', { class: 'tag' }, p.type)),
      h('td', { class: 'mono' }, p.user ? `${p.user}${p.password ? ' / ••••' : ''}` : '—'),
      h('td', null, lastCheckCell(p)),
      h('td', { class: 'actions' },
        h('button', {
          class: 'btn sm',
          disabled: !CHECKABLE.includes(p.type),
          title: CHECKABLE.includes(p.type) ? '检测这条代理' : `${p.type} 代理不支持预检（README 已知限制 8）`,
          onClick: (e) => checkOne(p, e.target),
        }, '检测'),
        ' ',
        h('button', { class: 'btn sm ghost', onClick: () => openForm(p) }, '编辑'),
        ' ',
        h('button', { class: 'btn sm danger', onClick: () => removeOne(p) }, '删除')));
  }

  /* ------------------------------ 检测 ------------------------------ */

  async function checkOne(p, btn) {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '检测中…';
    try {
      const r = await api.proxyCheck({ type: p.type, host: p.host, port: p.port, username: p.user, password: p.password });
      // 失败也要落到行里 —— 只弹 toast 的话，用户点第二行就再也看不到原因了
      const rec = r.ok
        ? { ok: true, ip: r.ip, country: r.country, countryCode: r.countryCode, latency_ms: r.latency_ms, checked_at: new Date().toISOString() }
        : { ok: false, error: r.error, error_label: errorLabel(r.error), checked_at: new Date().toISOString() };
      checks.set(p.proxy_id, rec);
      toast(rec.ok ? `出口 ${rec.ip} · ${rec.country || ''} · ${rec.latency_ms}ms` : `${rec.error_label}：${String(r.error || '').slice(0, 80)}`, rec.ok ? 'ok' : 'bad');
      await load(false);
    } catch (e) {
      checks.set(p.proxy_id, { ok: false, error: e.message, error_label: '检测失败', checked_at: new Date().toISOString() });
      toast(e.message, 'bad');
      await load(false);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  /** 前端兜底归类（服务端 /proxy/check 只回 error 文本；批量接口自带 error_label） */
  function errorLabel(error) {
    const s = String(error || '');
    if (/超时|timeout|ETIMEDOUT/i.test(s)) return '连接超时';
    if (/407|认证失败|authentication/i.test(s)) return '认证失败';
    if (/拒绝 CONNECT|CONNECT 被拒绝/i.test(s)) return '代理拒绝 CONNECT';
    if (/ECONNREFUSED|连接 .* 失败/i.test(s)) return '连接被拒';
    if (/ENOTFOUND|getaddrinfo/i.test(s)) return '域名解析失败';
    if (/TLS/i.test(s)) return 'TLS 握手失败';
    return '失败';
  }

  async function checkAll() {
    if (!current.length) { toast('还没有代理可检测', 'bad'); return; }
    const old = batchBtn.textContent;
    batchBtn.disabled = true;
    batchBtn.textContent = '检测中…';
    mount(summaryBox, h('div', { class: 'notice info' }, `正在检测 ${current.length} 个代理（并发 3，单条最多 10s）…`));
    try {
      const r = await api.proxyCheckBatch(current.map((p) => p.proxy_id));
      for (const x of (r.list || [])) checks.set(x.proxy_id, x);
      renderSummary(r);
      await load(false);
    } catch (e) {
      toast(e.message, 'bad');
      mount(summaryBox, h('div', { class: 'notice bad' }, `批量检测失败：${e.message}`));
    } finally {
      batchBtn.disabled = false;
      batchBtn.textContent = old;
    }
  }

  function renderSummary(r) {
    const okList = (r.list || []).filter((x) => x.ok);
    const failList = (r.list || []).filter((x) => !x.ok);
    const nameOf = (id) => {
      const p = current.find((x) => x.proxy_id === id);
      return p ? (p.remark || `${p.host}:${p.port}`) : id;
    };
    mount(summaryBox,
      h('div', { class: 'notice', style: { borderColor: failList.length ? '' : '' } },
        h('div', null,
          h('strong', null, `批量检测完成：${r.total} 条 · `),
          h('span', { class: 'pill ok' }, `ok ${okList.length}`), ' ',
          failList.length ? h('span', { class: 'pill bad' }, `fail ${failList.length}`) : h('span', { class: 'pill ok' }, 'fail 0'),
          h('span', { class: 'muted' }, ` · ${r.elapsed_ms}ms · 并发 ${r.concurrency} · 单条上限 ${r.timeout_ms}ms`)),
        h('div', { class: 'row', style: { gap: '24px', alignItems: 'flex-start' } },
          h('div', { style: { flex: '1' } },
            h('div', { class: 'muted small' }, 'ok'),
            okList.length
              ? h('ul', null, okList.map((x) => h('li', null,
                h('span', { class: 'mono' }, nameOf(x.proxy_id)), ' — ', `${x.ip || '?'} · ${x.latency_ms}ms`)))
              : h('div', { class: 'muted small' }, '（无）')),
          h('div', { style: { flex: '1' } },
            h('div', { class: 'muted small' }, 'fail'),
            failList.length
              ? h('ul', null, failList.map((x) => h('li', null,
                h('span', { class: 'mono' }, nameOf(x.proxy_id)), ' — ',
                h('strong', null, x.error_label || '失败'),
                h('span', { class: 'muted small' }, ` ${String(x.error || '').slice(0, 60)}`))))
              : h('div', { class: 'muted small' }, '（无）')))));
  }

  /* ------------------------------ 增删改 ------------------------------ */

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
      checks.delete(p.proxy_id);
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
      h('div', { class: 'muted small' }, '保存不会自动预检 —— 想先验证就保存后点「检测」（检测只读，不改配置、不动环境）。'));

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
