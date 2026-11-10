/** 自检报告：一份报告看全 15 项的声明值 / 实测值 / 覆盖度，以及四个哈希是否跨重启稳定。 */
import { h, mount, toast, pill, fmtTime } from '../ui.js';
import { api } from '../api.js';

const STATUS_LABEL = { pass: '通过', warn: '告警', fail: '失败' };
const COV = { full: '完全覆盖', partial: '部分覆盖', none: '不覆盖', 'n/a': '不适用' };

export default async function renderSelfcheck({ head, page, params }) {
  const id = params.id;
  mount(head, h('h1', null, '自检报告'), h('span', { class: 'sub' }, '加载中…'), h('span', { class: 'spacer' }));
  mount(page, h('div', { class: 'muted' }, '正在读报告…'));

  let profile = null;
  try { profile = await api.detail(id); } catch { /* 环境可能刚被删 */ }
  const name = profile ? `${profile.name} #${profile.profile_no}` : id.slice(0, 8);

  let report = null;
  try {
    report = await api.selfcheck(id);
  } catch (e) {
    mount(head,
      h('h1', null, `自检报告 · ${name}`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onClick: () => { location.hash = '#/profiles'; } }, '返回列表'));
    mount(page, h('div', { class: 'notice warn' },
      h('div', null, h('strong', null, '还没有报告'), ` — ${e.message}`),
      h('div', { class: 'muted small' }, '启动这个环境时会自动跑一次自检；也可以在环境列表里点「启动」后再回来。')));
    return;
  }

  const sum = report.summary || {};
  const det = report.determinism || {};
  const hashes = report.hashes || {};

  mount(head,
    h('h1', null, `自检报告 · ${name}`),
    h('span', { class: 'sub' }, `${fmtTime(report.generated_at)}${report.stale ? ' · 上次运行留下的' : ' · 本次运行'}`),
    h('span', { class: 'spacer' }),
    h('button', {
      class: 'btn',
      title: report.running ? '重新在本机跑一遍探针' : '环境没在运行，不能重跑',
      disabled: !report.running,
      onClick: rerun,
    }, '重跑自检'),
    h('button', {
      class: 'btn',
      title: '在新标签打开可打印的 HTML 报告（地址带一次性票据，不含 api_key）',
      onClick: openHtml,
    }, 'HTML 报告'),
    h('button', { class: 'btn', onClick: () => { location.hash = '#/profiles'; } }, '返回列表'));

  const content = h('div', { class: 'stack' });
  mount(page, content);

  if (report.stale) {
    content.appendChild(h('div', { class: 'notice warn' },
      '这份报告是上一次运行时留下的，环境现在已经停了 —— 哈希和声明值仍然有效，但「运行中才有的项」不会更新。'));
  }

  content.appendChild(h('div', { class: 'metrics' },
    metric('自检评分', String(sum.score ?? '—'), sum.fail ? '还有失败项' : '没有失败项', sum.fail ? 'bad' : 'ok'),
    metric('通过 / 告警 / 失败', `${sum.pass ?? 0} / ${sum.warn ?? 0} / ${sum.fail ?? 0}`, `共 ${sum.total ?? '—'} 项`),
    metric('覆盖度', `${sum.full ?? 0} / ${sum.partial ?? 0} / ${sum.none ?? 0}`, '完全 / 部分 / 不覆盖'),
    metric('内核', report.kernel_version || '—', `种子 ${report.seed ?? '—'}`)));

  content.appendChild(h('div', { class: 'panel' },
    h('div', { class: 'panel-head' }, '四个噪声维度的哈希'),
    h('div', { class: 'panel-body' },
      h('div', { class: 'metrics' },
        hashCard('Canvas', hashes.canvas, det.canvas),
        hashCard('WebGL 图像', hashes.webgl_image, det.webgl_image),
        hashCard('Audio', hashes.audio, det.audio),
        hashCard('ClientRects', hashes.client_rects, det.client_rects))),
    h('div', { class: 'panel-body', style: { borderTop: '1px solid var(--line-2)' } },
      h('div', { class: 'row' },
        det.cross_restart === true ? pill('跨重启一致', 'ok')
          : det.cross_restart === false ? pill('跨重启变了（种子没落库？）', 'bad')
            : pill('首次运行，还没有可比的上一份', 'idle'),
        det.compared_with ? h('span', { class: 'muted small' }, `对比基准 ${fmtTime(det.compared_with)}`) : null),
      det.note ? h('div', { class: 'muted small', style: { marginTop: '6px' } }, det.note) : null)));

  const items = Array.isArray(report.items) ? report.items : [];
  const tbody = h('tbody');
  for (const it of items) {
    tbody.appendChild(h('tr', null,
      h('td', null, it.label || it.id),
      h('td', null, h('span', { class: 'tag' }, COV[it.coverage] || it.coverage || '—')),
      h('td', null, pill(STATUS_LABEL[it.status] || it.status || '—', it.status === 'pass' ? 'ok' : it.status === 'fail' ? 'bad' : 'warn')),
      h('td', { class: 'mono', style: { maxWidth: '220px', wordBreak: 'break-all' } }, fmtVal(it.declared)),
      h('td', { class: 'mono', style: { maxWidth: '260px', wordBreak: 'break-all' } }, fmtVal(it.actual)),
      h('td', { class: 'muted small' }, it.note || '')));
  }
  content.appendChild(h('div', { class: 'panel' },
    h('div', { class: 'panel-head' }, `逐项实测（${items.length} 项）`,
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted small' }, '声明值 = 环境配置；实测值 = 浏览器里读回来的')),
    h('div', { class: 'panel-body', style: { padding: 0 } },
      h('table', { class: 'grid' },
        h('thead', null, h('tr', null,
          h('th', null, '项目'), h('th', null, '覆盖度'), h('th', null, '结果'),
          h('th', null, '声明值'), h('th', null, '实测值'), h('th', null, '说明'))),
        tbody))));

  async function rerun() {
    try {
      toast('正在跑探针，大约十几秒…');
      await api.selfcheck(id, { rerun: true });
      toast('自检完成', 'ok');
      await renderSelfcheck({ head, page, params });
    } catch (e) {
      toast(`重跑失败：${e.message}`, 'bad');
    }
  }

  async function openHtml() {
    try {
      const url = await api.selfcheckHtmlUrl(id);
      window.open(url, '_blank', 'noreferrer');
    } catch (e) {
      toast(`打不开报告：${e.message}`, 'bad');
    }
  }
}

function metric(k, v, sub, tone) {
  return h('div', { class: 'metric' },
    h('div', { class: 'k' }, k),
    h('div', { class: 'v', style: tone === 'ok' ? { color: 'var(--ok)' } : tone === 'bad' ? { color: 'var(--bad)' } : null }, v),
    sub ? h('div', { class: 'k' }, sub) : null);
}

function hashCard(label, hash, stable) {
  return h('div', { class: 'metric' },
    h('div', { class: 'k' }, `${label}${stable === false ? '（不稳定）' : ''}`),
    h('div', { class: 'v', style: { fontSize: '15px', fontFamily: 'var(--mono)' } }, hash || '—'));
}

function fmtVal(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}