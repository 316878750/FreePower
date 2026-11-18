/**
 * 起始页（0.4.7.3）—— 修「打开环境是一片空白」。
 *
 * 事实（CEO 实测确认）：用户库里 102 个环境有 101 个 `open_urls` 是 `[]`，
 * 老代码 `const firstUrl = urls[0] || 'about:blank'` 于是每个环境开出来都是空白页；
 * 代理一挂更是 Chrome 错误页。用户看到的就是「指纹显示是空白」。
 *
 * 对手的做法（逆向 `08-指纹注入落点矩阵.md:238`、`09-动态验证.md:57`）：
 * 第一张标签是它自己的 `https://start.adspower.net/?id=<env>`，并且把那个域名放进
 * `--proxy-bypass-list` —— **所以代理挂了这张页也能开**。我们照这个思路，但用本地页：
 *
 *   1. 页面由**本机服务进程**出（`GET /start?id=&sig=`），签名绑定 profile_id、24 小时过期，
 *      **不需要 api_key**（不能把 master key 拼进浏览器地址栏）；
 *   2. 页面自己**一个外连请求都不发**：它靠绕代理才能打开，若自己去请求外网，要么永远卡住、
 *      要么绕过代理拿到本机真实 IP（那是最不能给页面看的东西）。所有探测都在服务进程里做，
 *      结果注入 HTML，页面只对**同源**的 `/start/data` 取一次；
 *   3. 代理不通时**明确写「代理未连通：<原因>」**，不许空白、不许停在内核错误页；
 *   4. 触发规则：`open_urls` 为空 → 开起始页；有值 → 保持现状；
 *      设置里的「总是打开起始页」默认**关**（开了就在第一张多开这一页）。
 *
 * 绕代理的方式（实测三种写法，见 `test/start-page-kernel.test.mjs` 的读数）：
 * 保留 `--proxy-bypass-list=<-loopback>`（127.0.0.1 仍走代理，fail-closed 不变），
 * 额外把 `start.freepower.test` 加进绕行名单，并用 `--host-resolver-rules` 把它钉到 127.0.0.1。
 * 这样既没给 loopback 开口子，起始页在代理全挂时也一定能开。
 */
import { API_PORT } from '../config.js';
import { getProfile } from '../store/profiles.js';
import { hasProxy, normalizeProxyConfig } from '../proxy/probe.js';
import { START_HOST } from './host.js';
import { signStart, verifyStart } from './sign.js';
import { probeStartEgress } from './probe.js';

export { START_HOST };

/** 起始页响应头：页面不许连任何外部地址（`connect-src 'self'` 就是这一条的运行时版本） */
export const START_PAGE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "connect-src 'self'",
  "img-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

let apiPort = Number(API_PORT) || 53380;

/**
 * 真实监听端口（`boot.js` 起完服务后调）。端口被占会往后顺延，
 * 起始页的 URL 必须指到**真正在听**的那个端口，否则开出来是错误页。
 */
export function setStartPagePort(port) {
  const n = Number(port);
  if (Number.isFinite(n) && n > 0) apiPort = n;
  return apiPort;
}

export function startPagePort() {
  return apiPort;
}

/**
 * 起始页地址（带签名）。
 * @param {string} profileId
 * @param {{port?:number}} [opt]
 */
export function startPageUrl(profileId, { port } = {}) {
  const p = Number(port) > 0 ? Number(port) : apiPort;
  const id = encodeURIComponent(String(profileId));
  const sig = encodeURIComponent(signStart(profileId));
  return `http://${START_HOST}:${p}/start?id=${id}&sig=${sig}`;
}

/** 判据/排障用：只给 host:port，不带签名（签名不进日志） */
export function startPageOrigin(port) {
  const p = Number(port) > 0 ? Number(port) : apiPort;
  return `http://${START_HOST}:${p}`;
}

/**
 * 校验签名并取出环境。
 * @returns {{ok:true, profile:object}|{ok:false, status:number, reason:string}}
 */
export function resolveStartRequest(idRaw, sigRaw) {
  const id = String(idRaw || '').trim();
  if (!id) return { ok: false, status: 400, reason: 'id_required' };
  const v = verifyStart(id, sigRaw);
  if (!v.ok) return { ok: false, status: 403, reason: v.reason };
  const profile = getProfile(id);
  if (!profile) return { ok: false, status: 404, reason: 'profile_not_found' };
  return { ok: true, profile };
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const dash = (s) => (s === undefined || s === null || String(s).trim() === '' ? '—' : String(s));

/** 期望出口（导入时带的 ip / ip_country / ip_city，不是探测结果） */
export function expectedEgress(profile) {
  const p = profile || {};
  const parts = [p.ip, p.ip_country, p.ip_city].map((x) => String(x ?? '').trim()).filter(Boolean);
  return {
    ip: String(p.ip ?? '').trim() || null,
    country: String(p.ip_country ?? '').trim() || null,
    city: String(p.ip_city ?? '').trim() || null,
    text: parts.length ? parts.join(' · ') : null,
  };
}

/** 代理的可显示形状：**只给协议与 host:port**，用户名密码一个字节都不进页面 */
export function proxyDisplay(profile) {
  const cfg = profile?.user_proxy_config || profile?.proxy_config || null;
  if (!hasProxy(cfg)) return { bound: false, text: '未绑定代理（直连，出口即本机 IP）', host: null, port: null };
  const c = normalizeProxyConfig(cfg);
  return {
    bound: true,
    type: c.type,
    host: c.host,
    port: c.port,
    has_auth: Boolean(c.username || c.password),
    text: `${c.type}://${c.host}:${c.port}${c.username || c.password ? '（带用户名密码）' : ''}`,
  };
}

function probeView(probe) {
  if (!probe) return { cls: 'pending', label: '检测中…', detail: '正在从本机探测出口，最多几秒' };
  if (probe.ok) {
    const where = [probe.country, probe.city].filter(Boolean).join(' · ');
    return {
      cls: 'ok',
      label: probe.via === 'proxy' ? '代理已连通' : '直连可用',
      detail: `${probe.ip}${where ? ` · ${where}` : ''}`,
    };
  }
  // 0.4.7.5 19:45：探测源挂了不许写成「代理未连通」——那是把「没验证成功」当「代理坏了」，
  // 用户会去换一条本来好的代理（10056 就是这么被误判的：代理 748ms 通，ip-api 被限流）。
  if (probe.kind === 'probe_site' || probe.kind === 'target') {
    return {
      cls: 'warn',
      label: '探测源不可用',
      detail: `不是代理不通：${String(probe.error || '出口探测源不可达').slice(0, 300)}`,
    };
  }
  return { cls: 'bad', label: '代理未连通', detail: String(probe.error || '出口探测失败') };
}

function whenText(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 渲染起始页 HTML。**纯 HTML + 内联样式 + 一段内联脚本**，零外部资源（CSP 也钉着这一条）。
 * @param {object} profile
 * @param {{probe?:object|null}} [opt] 已经探好的结果（有就直出，省掉「检测中」那一闪）
 */
export function renderStartHtml(profile, { probe = null } = {}) {
  const id = String(profile?.profile_id || profile?.id || '');
  const sig = signStart(id);
  const name = String(profile?.name ?? '').trim() || '未命名环境';
  const proxy = proxyDisplay(profile);
  const expected = expectedEgress(profile);
  const view = probeView(probe);
  const kernel = dash(profile?.kernel_version);
  const ua = dash(profile?.ua);
  const profileNo = dash(profile?.profile_no);

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} — FreePower</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 24px 48px; font: 14px/1.6 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
         background: #0f1115; color: #e6e8ee; }
  .wrap { max-width: 760px; margin: 0 auto; }
  .brand { display: flex; align-items: center; gap: 10px; font-size: 13px; letter-spacing: .04em;
           color: #8b93a7; text-transform: uppercase; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #4c8dff; }
  h1 { margin: 10px 0 4px; font-size: 26px; line-height: 1.25; word-break: break-all; }
  .sub { color: #8b93a7; font-size: 13px; margin-bottom: 22px; }
  .status { display: flex; gap: 12px; align-items: flex-start; padding: 14px 16px; border-radius: 10px;
            border: 1px solid #262b36; background: #151922; margin-bottom: 22px; }
  .status .tag { flex: none; font-weight: 600; padding: 2px 10px; border-radius: 999px; font-size: 12px; }
  .status.ok .tag { background: #14361f; color: #6ee7a0; border: 1px solid #1f5c35; }
  .status.bad .tag { background: #3a1717; color: #ff9b9b; border: 1px solid #6b2323; }
  .status.warn .tag { background: #3a2f14; color: #ffd68a; border: 1px solid #6b5a23; }
  .status.pending .tag { background: #23262f; color: #c3c9d8; border: 1px solid #333846; }
  .status .detail { color: #b9c0d0; font-size: 13px; word-break: break-all; }
  dl { display: grid; grid-template-columns: 104px 1fr; gap: 10px 16px; margin: 0; }
  dt { color: #8b93a7; font-size: 13px; }
  dd { margin: 0; word-break: break-all; }
  .mono { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12.5px; }
  .muted { color: #6f778a; }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  button { font: inherit; font-size: 12.5px; padding: 4px 12px; border-radius: 8px; cursor: pointer;
           border: 1px solid #333846; background: #1b202b; color: #cfd5e3; }
  button:hover { border-color: #4c8dff; color: #fff; }
  button[disabled] { opacity: .55; cursor: default; }
  hr { border: 0; border-top: 1px solid #222733; margin: 22px 0; }
  .foot { color: #6f778a; font-size: 12px; line-height: 1.8; }
  .foot b { color: #99a1b5; font-weight: 600; }
</style>
</head>
<body data-profile-id="${esc(id)}" data-sig="${esc(sig)}"
      data-proxy-host="${esc(proxy.host || '')}" data-proxy-port="${esc(proxy.port || '')}"
      data-expected-ip="${esc(expected.ip || '')}">
<div class="wrap">
  <div class="brand"><span class="dot"></span>FreePower 起始页</div>
  <h1 id="env-name">${esc(name)}</h1>
  <div class="sub">环境 #${esc(profileNo)} · ${esc(id.slice(0, 8))}…</div>

  <div class="status ${view.cls}" id="status">
    <span class="tag" id="status-tag">${esc(view.label)}</span>
    <span class="detail" id="status-detail">${esc(view.detail)}</span>
  </div>

  <dl>
    <dt>代理</dt>
    <dd id="proxy">${esc(proxy.text)}</dd>
    <dt>期望出口</dt>
    <dd id="expected">${esc(expected.text || '未记录（导入时没带出口信息）')}</dd>
    <dt>实测出口</dt>
    <dd>
      <span id="probe-ip" class="mono">${esc(probe && probe.ok ? probe.ip : '检测中…')}</span>
      <span id="probe-meta" class="muted">${esc(probe && probe.ok
        ? [probe.country, probe.city].filter(Boolean).join(' · ')
        : '')}</span>
      <div class="row" style="margin-top:6px">
        <span class="muted" id="probe-at">${esc(probe ? whenText(probe.at) : '')}</span>
        <button id="refresh" type="button">重新检测</button>
      </div>
    </dd>
    <dt>内核版本</dt>
    <dd class="mono" id="kernel">${esc(kernel)}</dd>
    <dt>User-Agent</dt>
    <dd class="mono" id="ua">${esc(ua)}</dd>
  </dl>

  <hr>
  <div class="foot">
    这一页由<b>本机 FreePower 服务</b>提供，不走代理，所以代理挂了也能打开。<br>
    页面自己<b>不发起任何外连请求</b>：出口读数由服务进程探测后填进来。<br>
    代理不通时这里会写明原因；要改代理请到 FreePower 控制台的环境编辑页。
  </div>
</div>
<script>
(function () {
  var body = document.body;
  var id = body.getAttribute('data-profile-id');
  var sig = body.getAttribute('data-sig');
  var btn = document.getElementById('refresh');
  var statusBox = document.getElementById('status');
  var tag = document.getElementById('status-tag');
  var detail = document.getElementById('status-detail');
  var ipEl = document.getElementById('probe-ip');
  var metaEl = document.getElementById('probe-meta');
  var atEl = document.getElementById('probe-at');

  function two(n) { return String(n).padStart(2, '0'); }
  function when(iso) {
    var d = new Date(iso);
    if (!d || isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' +
           two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
  }
  function paint(p) {
    if (!p) return;
    if (p.ok) {
      statusBox.className = 'status ok';
      tag.textContent = p.via === 'proxy' ? '代理已连通' : '直连可用';
      detail.textContent = [p.country, p.city].filter(Boolean).join(' · ') || '';
      ipEl.textContent = p.ip || '—';
      metaEl.textContent = [p.country, p.city].filter(Boolean).join(' · ');
    } else {
      // 探测源不可用 ≠ 代理不通：文案分开，别让用户去换一条本来好的代理
      var softProbe = p.kind === 'probe_site' || p.kind === 'target';
      statusBox.className = 'status ' + (softProbe ? 'warn' : 'bad');
      tag.textContent = softProbe ? '探测源不可用' : '代理未连通';
      detail.textContent = (softProbe ? '不是代理不通：' : '') + (p.error || '出口探测失败');
      ipEl.textContent = '—';
      metaEl.textContent = '';
    }
    atEl.textContent = when(p.at) + (p.latency_ms ? ' · ' + p.latency_ms + 'ms' : '');
  }
  function load(force) {
    btn.disabled = true;
    var url = '/start/data?id=' + encodeURIComponent(id) + '&sig=' + encodeURIComponent(sig);
    if (force) url += '&force=1';
    fetch(url, { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.code === 0 && j.data && j.data.probe) paint(j.data.probe);
        else if (j && j.msg) {
          statusBox.className = 'status bad';
          tag.textContent = '探测失败';
          detail.textContent = j.msg;
        }
      })
      .catch(function (e) {
        statusBox.className = 'status bad';
        tag.textContent = '探测失败';
        detail.textContent = String(e && e.message ? e.message : e);
      })
      .then(function () { btn.disabled = false; });
  }
  btn.addEventListener('click', function () { load(true); });
  load(false);
})();
</script>
</body>
</html>`;
}

/**
 * `/start/data` 的响应体：只给这一页自己用（同源 + 签名）。
 * @param {object} profile
 * @param {{force?:boolean}} [opt]
 */
export async function startPageData(profile, { force = false } = {}) {
  const probe = await probeStartEgress(profile, { force });
  return {
    profile_id: String(profile?.profile_id || profile?.id || ''),
    name: profile?.name ?? '',
    proxy: proxyDisplay(profile),
    expected: expectedEgress(profile),
    kernel_version: profile?.kernel_version ?? null,
    ua: profile?.ua ?? null,
    probe,
  };
}
