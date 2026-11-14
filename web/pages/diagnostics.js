/**
 * 网络诊断（0.4.3 ④）：**只读**。
 *
 * 这一页回答三个问题，且**不改任何东西**（不写库、不改配置、不起停内核）：
 *   1. 本机在听哪些端口（本地 API + 各运行中环境的 CDP 端口）；
 *   2. 内核在不在跑、跑的是哪个版本、出口 IP 是什么；
 *   3. 绑在环境上的代理通不通（按钮触发，按 host:port:user 去重）。
 *
 * 「只读」不是一句口号：服务端两条路由都在 `src/api/diagnose.js`，那边有静态判据扫
 * （不许出现 setMeta / updateProfile / startProfile / writeFile 之类）。
 * 界面上也不给任何「保存 / 应用」按钮 —— 能改的都在别的页。
 */
import { h, mount, toast } from '../ui.js';
import { api } from '../api.js';

const panel = (title, ...kids) => h('section', { class: 'panel' },
  h('div', { class: 'panel-head' }, h('h3', { style: { margin: 0, fontSize: '13px' } }, title)),
  h('div', { class: 'panel-body' }, ...kids));

const kb = (n) => (n === null || n === undefined ? '—' : `${(n / 1024).toFixed(0)} KB`);
const secs = (n) => {
  const s = Number(n) || 0;
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 时 ${Math.floor((s % 3600) / 60)} 分`;
};

export default async function diagnosticsPage({ head, page }) {
  mount(head,
    h('h1', null, '网络诊断'),
    h('div', { class: 'sub' }, '只读：不改配置、不写库、不起停内核。'),
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn', onClick: () => load(true) }, '刷新快照'));

  const body = h('div', { class: 'stack', style: { gap: '14px' } });
  mount(page, body);

  const metrics = h('div', { class: 'metrics' });
  const svcBox = h('div', { class: 'stack' });
  body.appendChild(panel('服务', metrics, svcBox));

  const portBox = h('div', { class: 'stack' });
  body.appendChild(panel('监听端口（本产品自己的）', portBox,
    h('div', { class: 'muted small' }, '只列本地 API 与各运行中环境的 CDP 端口；不扫全机端口（那不是本产品的职责，也不该去探别人的端口）。')));

  const kernelBox = h('div', { class: 'stack' });
  body.appendChild(panel('内核', kernelBox));

  const proxyBox = h('div', { class: 'stack' });
  body.appendChild(panel('代理（绑在环境上的）', proxyBox,
    h('div', { class: 'row' },
      h('button', { class: 'btn', onClick: probe }, '探测代理（只读）'),
      h('span', { class: 'muted small' }, '按 host:port:账号 去重，一条失败不影响其它条；探测结果**不落盘**（代理管理页那条才记最近结果）。'))));

  let snapshot = null;

  function paintService(s) {
    mount(metrics,
      metric('版本', s.version || '—'),
      metric('已运行', secs(s.uptime_seconds)),
      metric('内存', `${s.memory_mb} MB`),
      metric('API 请求', String(s.api?.requests?.total ?? 0), `拒绝 ${s.api?.requests?.rejected ?? 0} · 限流 ${s.api?.requests?.limited ?? 0}`),
      metric('运行中内核', String(snapshot?.kernels?.running?.length ?? 0), `已装 ${snapshot?.kernels?.installed?.length ?? 0} 个`));
    mount(svcBox,
      h('dl', { class: 'kv' },
        h('dt', null, '地址'), h('dd', null, s.url),
        h('dt', null, '进程'), h('dd', null, `pid ${s.pid}`),
        h('dt', null, '启动于'), h('dd', null, s.started_at),
        h('dt', null, '运行时'), h('dd', null, `${s.node} · ${s.platform}`),
        h('dt', null, '数据目录'), h('dd', null, s.data_dir),
        h('dt', null, '数据库'), h('dd', null, `${kb(s.db?.bytes)}（WAL ${kb(s.db?.wal_bytes)}）`),
        h('dt', null, 'API 验证'), h('dd', null, s.api?.verify === false ? '关（不校验 api_key）' : '开'),
        h('dt', null, '最后一次请求'), h('dd', null, s.api?.last_at ? `${s.api.last_path || '—'} · ${s.api.last_at}` : '—')));
  }

  function metric(k, v, caption) {
    return h('div', { class: 'metric' },
      h('div', { class: 'k' }, k),
      h('div', { class: 'v' }, v),
      caption ? h('div', { class: 'k' }, caption) : null);
  }

  function paintPorts(list) {
    if (!list?.length) { mount(portBox, h('div', { class: 'empty' }, '没有端口')); return; }
    mount(portBox,
      h('table', { class: 'grid' },
        h('thead', null, h('tr', null,
          h('th', null, '用途'), h('th', null, '地址'), h('th', null, '类型'), h('th', null, '环境'))),
        h('tbody', null, ...list.map((x) => h('tr', null,
          h('td', null, x.label),
          h('td', { class: 'mono' }, `${x.host}:${x.port}`),
          h('td', null, x.kind === 'api' ? h('span', { class: 'pill info' }, '本地 API') : h('span', { class: 'pill ok' }, 'CDP')),
          h('td', { class: 'mono' }, x.profile_id ? x.profile_id.slice(0, 8) : '—'))))));
  }

  function paintKernels(k) {
    const installed = k?.installed || [];
    const running = k?.running || [];
    mount(kernelBox,
      h('div', { class: 'muted small' }, `已装内核 ${installed.length} 个`),
      installed.length
        ? h('div', { class: 'row' }, ...installed.map((x) => h('span', { class: 'tag' }, `${x.kernel}${x.source ? ` · ${x.source}` : ''}`)))
        : h('div', { class: 'notice warn' }, '本机没有装内核（启动环境时会用系统 Chrome，或去内核页下载一个）'),
      h('div', { class: 'muted small', style: { marginTop: '8px' } }, `运行中 ${running.length} 个`),
      running.length
        ? h('table', { class: 'grid' },
          h('thead', null, h('tr', null,
            h('th', null, '环境'), h('th', null, 'pid'), h('th', null, 'CDP 端口'), h('th', null, '内核版本'), h('th', null, '出口 IP'), h('th', null, '启动于'))),
          h('tbody', null, ...running.map((r) => h('tr', null,
            h('td', { class: 'mono' }, String(r.profile_id).slice(0, 8)),
            h('td', null, String(r.pid)),
            h('td', null, String(r.debug_port)),
            h('td', null, r.real_version || '—'),
            h('td', null, r.egress?.ip ? `${r.egress.ip}${r.egress.country ? ` · ${r.egress.country}` : ''}` : '—'),
            h('td', { class: 'muted small' }, r.started_at || '—')))))
        : h('div', { class: 'empty' }, '没有环境在跑'));
  }

  function paintProxies(p) {
    const list = p?.list || [];
    mount(proxyBox,
      h('div', { class: 'muted small' },
        `绑了代理的环境 ${p?.bound_profiles ?? 0} 个，去重后 ${p?.distinct ?? 0} 条代理`),
      list.length
        ? h('table', { class: 'grid' },
          h('thead', null, h('tr', null,
            h('th', null, '代理'), h('th', null, '账号'), h('th', null, '用在几个环境'), h('th', null, '探测结果'))),
          h('tbody', null, ...list.map((x) => h('tr', null,
            h('td', { class: 'mono' }, `${x.proxy.proxy_type}://${x.proxy.host}:${x.proxy.port}`),
            h('td', null, x.username_masked || '—'),
            h('td', null, String((x.profiles || []).length)),
            h('td', { class: 'muted small' }, '点上面的按钮探测')))))
        : h('div', { class: 'empty' }, '没有环境绑代理（全部直连）'));
  }

  function paintProbe(r) {
    const list = r?.list || [];
    const box = h('div', { class: 'stack' });
    if (!list.length) {
      mount(box, h('div', { class: 'notice' }, r?.message || '没有可探测的代理'));
      proxyBox.appendChild(box);
      return;
    }
    const tag = (x) => (x.ok ? h('span', { class: 'pill ok' }, `通 · ${x.ip || '—'}${x.country ? ` · ${x.country}` : ''}`)
      : x.outcome === 'timeout' ? h('span', { class: 'pill warn' }, `超时（${x.timeout_seconds} 秒）`)
        : h('span', { class: 'pill bad' }, x.error_label || '不通'));
    mount(box,
      h('div', { class: 'muted small' },
        `探测 ${r.total} 条：通 ${r.ok} · 不通 ${r.fail}（其中超时 ${r.timeout}）· 用时 ${r.elapsed_ms} ms · 并发 ${r.concurrency}`
        + (r.persisted === false ? ' · **没有落盘**' : '')),
      h('table', { class: 'grid' },
        h('thead', null, h('tr', null,
          h('th', null, '代理'), h('th', null, '环境'), h('th', null, '结果'), h('th', null, '延迟'))),
        h('tbody', null, ...list.map((x) => h('tr', null,
          h('td', { class: 'mono' }, `${x.proxy.proxy_type}://${x.proxy.host}:${x.proxy.port}`),
          h('td', { class: 'mono' }, (x.profiles || []).map((p) => String(p.name || p.profile_id).slice(0, 12)).join('、')),
          h('td', null, tag(x)),
          h('td', null, `${x.latency_ms} ms`))))));
    proxyBox.appendChild(box);
  }

  async function probe() {
    try {
      const r = await api.diagnoseProxy();
      paintProbe(r);
      toast(r.fail ? `${r.fail} 条代理不通` : '代理都通', r.fail ? 'warn' : 'ok');
    } catch (e) { toast(`探测失败：${e.message}`, 'bad'); }
  }

  async function load(showToast) {
    try {
      snapshot = await api.diagnoseNetwork();
      paintService(snapshot.service);
      paintPorts(snapshot.listeners);
      paintKernels(snapshot.kernels);
      paintProxies(snapshot.proxies);
      if (showToast) toast('已刷新', 'ok');
    } catch (e) {
      mount(body, h('div', { class: 'notice bad' }, e.message));
      if (showToast) toast(e.message, 'bad');
    }
  }

  await load(false);
}