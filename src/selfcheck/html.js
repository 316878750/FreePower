/**
 * 自检报告 HTML（本地服务渲染，无前端构建、无外链资源）。
 * 产品里给用户看的就是这一页：绿色=声明已生效，黄色=值对上了但维度本身可被识别，红色=没生效。
 */
const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const show = (v) => (v == null ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

const STATUS_LABEL = { pass: '通过', warn: '标黄', fail: '未生效' };
const COVER_LABEL = { full: 'full', partial: 'partial', none: 'none', 'n/a': 'n/a' };

export function renderHtml(report) {
  if (!report) return '<!doctype html><meta charset="utf-8"><p>没有自检报告</p>';
  const s = report.summary || {};
  const det = report.determinism || {};
  const rows = (report.items || []).map((it) => `
    <tr class="${esc(it.status)}">
      <td><b>${esc(it.label)}</b><div class="muted">${esc(it.field)}</div></td>
      <td><span class="cov ${esc(it.coverage)}">${esc(COVER_LABEL[it.coverage] || it.coverage)}</span></td>
      <td><span class="badge ${esc(it.status)}">${esc(STATUS_LABEL[it.status] || it.status)}</span></td>
      <td class="mono">${esc(show(it.declared))}</td>
      <td class="mono">${esc(show(it.actual))}</td>
      <td>${esc(it.note || '')}</td>
    </tr>`).join('');

  const hashRows = Object.entries(report.hashes || {})
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v || '—')}</td></tr>`).join('');

  /* 双 Realm 单独开一节：这是检测方最容易交叉验证的地方，值得单独看 */
  const realmItems = (report.items || []).filter((it) => String(it.id || '').startsWith('realm_'));
  const mainCanvas = (report.raw && report.raw.workers && report.raw.workers.main) ? report.raw.workers.main : null;
  const realmSection = realmItems.length ? `
<h2>双 Realm（worker 内实测，与主帧对照）</h2>
<table><thead><tr><th>Realm</th><th>结果</th><th>首行注入</th><th>canvas 哈希</th><th>说明</th></tr></thead>
<tbody>${realmItems.map((it) => {
    const a = it.actual || {};
    return `<tr class="${esc(it.status)}">
      <td><b>${esc(it.label)}</b><div class="muted">${esc(it.field)}</div></td>
      <td><span class="badge ${esc(it.status)}">${esc(STATUS_LABEL[it.status] || it.status)}</span></td>
      <td class="mono">${esc(a.atTop == null ? '—' : a.atTop)}</td>
      <td class="mono">${esc(a.canvas || '—')}</td>
      <td>${esc(it.note || '')}</td>
    </tr>`;
  }).join('')}</tbody></table>
<p class="muted">主帧对照：DOM canvas <span class="mono">${esc((mainCanvas && mainCanvas.canvas_dom) || '—')}</span> ·
主帧 OffscreenCanvas <span class="mono">${esc((mainCanvas && mainCanvas.canvas_offscreen) || '—')}</span>。
三者一致说明 worker 与主帧用的是同一份噪声实现（种子相同、算法相同）。</p>` : '';

  const workletItem = (report.items || []).find((it) => it.id === 'audio_worklet');
  const workletKey = (report.raw && report.raw.audioworklet) ? report.raw.audioworklet : null;

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FreePower 自检 · ${esc(report.name || report.profile_id)}</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;padding:28px;background:#0f1115;color:#e8eaf0;font:14px/1.55 "Segoe UI",system-ui,sans-serif}
  h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:26px 0 10px;color:#aab2c5}
  .muted{color:#7f8798;font-size:12px}.mono{font-family:Consolas,monospace;font-size:12px;word-break:break-all}
  .cards{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}
  .card{background:#171a21;border:1px solid #262b36;border-radius:10px;padding:10px 14px;min-width:104px}
  .card .n{font-size:22px;font-weight:600}.card .l{font-size:12px;color:#8b93a6}
  .pass .n,.n.pass{color:#45d483}.warn .n,.n.warn{color:#f0b849}.fail .n,.n.fail{color:#ff6b6b}
  table{width:100%;border-collapse:collapse;background:#14171d;border:1px solid #262b36;border-radius:10px;overflow:hidden}
  th,td{text-align:left;vertical-align:top;padding:9px 10px;border-bottom:1px solid #22262f}
  th{background:#1a1e26;color:#9aa3b5;font-size:12px;font-weight:500}
  tr:last-child td{border-bottom:0}
  .badge,.cov{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;border:1px solid}
  .badge.pass,.cov.full{color:#45d483;border-color:#2b6b48;background:#12261b}
  .badge.warn,.cov.partial{color:#f0b849;border-color:#6b5522;background:#2a2312}
  .badge.fail,.cov.none{color:#ff6b6b;border-color:#6b2b2b;background:#2a1414}
  .cov.n\/a{color:#8b93a6;border-color:#3a3f4b}
  .note{background:#171a21;border-left:3px solid #4c7dff;padding:10px 14px;border-radius:0 8px 8px 0;color:#b9c1d2}
  .foot{margin-top:22px;color:#7f8798;font-size:12px}
</style></head><body>
<h1>FreePower 自检报告</h1>
<div class="muted">${esc(report.name || '')} · ${esc(report.profile_id)} · 内核 ${esc(report.kernel_version || '未知')} · ${esc(report.generated_at)}</div>

<div class="cards">
  <div class="card"><div class="n">${esc(s.score ?? 0)}</div><div class="l">自检符合度（非检测站通过率）</div></div>
  <div class="card pass"><div class="n pass">${esc(s.pass ?? 0)}</div><div class="l">通过</div></div>
  <div class="card warn"><div class="n warn">${esc(s.warn ?? 0)}</div><div class="l">标黄</div></div>
  <div class="card fail"><div class="n fail">${esc(s.fail ?? 0)}</div><div class="l">未生效</div></div>
  <div class="card"><div class="n">${esc(s.full ?? 0)} / ${esc(s.partial ?? 0)} / ${esc(s.none ?? 0)}</div><div class="l">full / partial / none</div></div>
</div>

<h2>逐项对照（声明值 vs 页面实际值）</h2>
<table><thead><tr><th>维度</th><th>覆盖度</th><th>结果</th><th>声明</th><th>实际</th><th>说明</th></tr></thead>
<tbody>${rows}</tbody></table>

<h2>噪点哈希（同一种子跨重启应不变）</h2>
<table><tbody>${hashRows}</tbody></table>
<p class="muted">同页确定性：canvas=${esc(det.canvas)} · webgl_image=${esc(det.webgl_image)} · audio=${esc(det.audio)} · client_rects=${esc(det.client_rects)} ·
跨重启一致：${esc(det.cross_restart == null ? '本次不判断（无同内核历史报告）' : det.cross_restart)}${det.compared_with ? `（对比 ${esc(det.compared_with)}）` : ''}</p>
${realmSection}
${workletItem ? `<h2>AudioWorklet 作用域（覆盖度 none，这是设计选择）</h2>
<div class="note"><b>「AudioWorklet 标 none」不等于「音频指纹裸奔」。</b>
这个作用域没有独立 target、也没有干净的注入通道，靠拦截 JS 改源码会被 <code>import.meta.url</code> 与模块完整性检测直接抓，所以明确不做。
真正的音频指纹本体是主帧 <code>OfflineAudioContext</code> 的浮点采样，已经由 audio 噪声覆盖（见上表 audio 项）；
在这个作用域里裸着的只有 <code>sampleRate</code> / <code>currentTime</code>
${workletKey && workletKey.ok ? `（本次实测 ${esc(workletKey.sampleRate)} / ${esc(workletKey.currentTime)}）` : ''}。</div>` : ''}

<div class="note">${esc(report.caveat || '')}</div>
<div class="foot">覆盖度来自字段表 coverage 标注：full=值可完全对齐，partial=值能对上但维度本身仍可被识别，none=未伪装。自检只证明「声明已按声明生效」，不等于通过检测站。</div>
</body></html>`;
}