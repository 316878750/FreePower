/**
 * 「API & MCP」页（0.4.2）。
 *
 * 三块内容，对齐 AdsPower 的 API 页面 + MCP 配置：
 *   1. 本地 API 状态：地址、key（可显示 / 复制 / 重置）、**API 验证开关**、请求计数；
 *   2. 端点清单：从后端 `buildRoutes()` 派生（页面不写死任何路由），可搜、可按分组筛；
 *   3. MCP 配置：Claude Desktop / Cursor / Codex 三段可直接复制的配置，端口与 key 自动填。
 *
 * 这个文件**在 Node 里 import 也不碰 DOM**（判据要直接 import 测 loadState / mcpConfig）——
 * 所有 DOM 操作都在默认导出的渲染函数里。
 */
import { h, mount, clear, toast, confirmDialog } from '../ui.js';
import { api } from '../api.js';

/** 读不到状态时的统一提示（401 与「服务没起来」分开说，用户才知道该修哪个） */
export const NO_KEY_NOTICE = '读不到本地 API 状态：API Key 无效，或服务没在运行。'
  + '先确认 FreePower 桌面端在跑；如果刚重置过 key，刷新这个页面（页面里的 key 是启动时注入的）。';

export const NETWORK_NOTICE = '连不上本地 API（127.0.0.1）。FreePower 服务没在运行，或端口被改了。';

/* ------------------------------ 纯函数（可测） ------------------------------ */

/** key 打码：只露前 6 位与后 4 位，够人认、不够人抄 */
export function maskKey(key) {
  const k = String(key || '');
  if (!k) return '—';
  if (k.length <= 12) return `${k.slice(0, 3)}…`;
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

/**
 * MCP 配置文本。
 * Claude Desktop 与 Cursor 都是 `mcpServers` 那段 JSON（同一形状，放在各自配置文件里）；
 * Codex 是 TOML（`~/.codex/config.toml`），所以单独拼一份。
 */
export function mcpConfig(kind, { port, apiKey, script, node = 'node' } = {}) {
  const env = { FREEPOWER_PORT: String(port || ''), FREEPOWER_API_KEY: String(apiKey || '') };
  const args = [String(script || '')];
  if (kind === 'codex') {
    // TOML basic string：用 JSON.stringify 生成转义（Windows 反斜杠必须双写）
    return [
      '[mcp_servers.freepower]',
      `command = ${JSON.stringify(node)}`,
      `args = [${args.map((a) => JSON.stringify(a)).join(', ')}]`,
      '',
      '[mcp_servers.freepower.env]',
      ...Object.entries(env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`),
      '',
    ].join('\n');
  }
  return JSON.stringify({ mcpServers: { freepower: { command: node, args, env } } }, null, 2);
}

/**
 * 读一次状态。
 * 依赖注入（fetchImpl / apiKey）是为了能在 Node 里测两条分支：401 → 提示，200 → 数据。
 * @returns {Promise<{ok: true, data: object} | {ok: false, notice: string, reason: string}>}
 */
export async function loadState({ fetchImpl, apiKey, base = '' } = {}) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return { ok: false, notice: NO_KEY_NOTICE, reason: 'no-fetch' };
  let res;
  try {
    res = await f(`${base}/api/v2/api/info`, {
      headers: { 'api-key': String(apiKey || ''), 'x-freepower-client': 'ui' },
    });
  } catch (e) {
    return { ok: false, notice: `${NETWORK_NOTICE}（${e.message}）`, reason: 'network' };
  }
  if (res.status === 401) return { ok: false, notice: NO_KEY_NOTICE, reason: '401' };
  if (!res.ok) return { ok: false, notice: `本地 API 返回 HTTP ${res.status}`, reason: `http-${res.status}` };
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  if (!json || json.code !== 0) {
    return { ok: false, notice: `读取失败：${json?.msg || '响应不是 JSON'}`, reason: 'bad-body' };
  }
  return { ok: true, data: json.data || {} };
}

/** 端点清单按分组聚合（保持后端给的顺序，不排序 —— 顺序本身就是「路由表的顺序」） */
export function groupEndpoints(list = []) {
  const out = new Map();
  for (const e of list) {
    const g = e.group || '其他';
    if (!out.has(g)) out.set(g, []);
    out.get(g).push(e);
  }
  return out;
}

/* ------------------------------ 渲染 ------------------------------ */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(String(text));
    toast('已复制');
  } catch {
    toast('复制失败，请手动选择文本', 'bad');
  }
}

export default async function renderApiPage({ head, page }) {
  const key = api.key();
  let state = null;
  let showKey = false;
  let filter = '';
  let groupFilter = '';

  const sub = h('span', { class: 'sub' }, '');
  mount(head,
    h('h1', null, 'API & MCP'),
    sub,
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm', onClick: () => load(true) }, '刷新'));

  const body = h('div', { class: 'stack' });
  mount(page, body);

  await load(false);

  async function load(showToast) {
    const r = await loadState({ apiKey: key });
    if (!r.ok) {
      state = null;
      mount(sub, '读不到状态');
      mount(body,
        h('div', { class: 'notice bad' },
          h('div', null, r.notice),
          h('div', { class: 'row', style: { marginTop: '8px' } },
            h('button', { class: 'btn sm', onClick: () => load(true) }, '重试'),
            h('button', { class: 'btn sm', onClick: () => location.reload() }, '刷新页面'))));
      if (showToast) toast(r.notice, 'bad');
      return;
    }
    state = r.data;
    mount(sub, `${state.endpoint_total} 条端点 · 验证${state.verify ? '开启' : '关闭'} · 本机 ${state.url}`);
    render();
  }

  function render() {
    const d = state;
    const stats = d.stats || {};

    /* ---- 1. 状态 ---- */
    const keyCell = h('dd', null,
      h('span', null, showKey ? (d.api_key || '—') : maskKey(d.api_key)),
      h('span', { class: 'row', style: { display: 'inline-flex', marginLeft: '8px', gap: '6px' } },
        h('button', { class: 'btn ghost sm', onClick: () => { showKey = !showKey; render(); } }, showKey ? '隐藏' : '显示'),
        h('button', { class: 'btn ghost sm', onClick: () => copyText(d.api_key) }, '复制'),
        h('button', {
          class: 'btn danger sm',
          onClick: async () => {
            const ok = await confirmDialog({
              title: '重置 API Key？',
              body: h('div', { class: 'stack' },
                h('div', null, '旧 key 立刻失效，所有用旧 key 的脚本、MCP 客户端都要改。'),
                h('div', { class: 'muted small' }, 'data/local_api 会同步更新，页面会自动重载。')),
              okLabel: '重置',
              danger: true,
            });
            if (!ok) return;
            try {
              const r = await api.resetKey();
              toast(`已重置：${maskKey(r.api_key)}`);
              setTimeout(() => location.reload(), 600);
            } catch (e) { toast(e.message, 'bad'); }
          },
        }, '重置')));

    const verifyBtn = h('button', {
      class: `btn sm ${d.verify ? 'primary' : 'danger'}`,
      onClick: async () => {
        const next = !d.verify;
        if (!next) {
          const ok = await confirmDialog({
            title: '关闭 API 验证？',
            body: h('div', { class: 'stack' },
              h('div', null, '关闭后**不再校验 api_key**：本机任何程序都能调 API，包括改环境、重置 key。'),
              h('div', { class: 'muted small' }, '只在完全信任本机、且脚本不想带 key 时关掉。')),
            okLabel: '关闭验证',
            danger: true,
          });
          if (!ok) return;
        }
        try {
          const r = await api.setVerify(next);
          d.verify = r.verify;
          toast(r.verify ? 'API 验证已开启' : 'API 验证已关闭');
          render();
        } catch (e) { toast(e.message, 'bad'); }
      },
    }, d.verify ? '已开启（点此关闭）' : '已关闭（点此开启）');

    const kv = h('dl', { class: 'kv' },
      h('dt', null, '地址'), h('dd', null, d.url),
      h('dt', null, 'API Key'), keyCell,
      h('dt', null, 'API 验证'), h('dd', null, verifyBtn),
      h('dt', null, '请求计数'), h('dd', null,
        `总 ${stats.total ?? 0} · 放行 ${stats.allowed ?? 0} · 拒绝 ${stats.rejected ?? 0} · 限流 ${stats.limited ?? 0}`
        + (stats.open ? ` · 免验放行 ${stats.open}` : '')),
      h('dt', null, '最近请求'), h('dd', null, stats.last_at ? `${stats.last_at}${stats.last_path ? `  ${stats.last_path}` : ''}` : '—'),
      h('dt', null, '启动时间'), h('dd', null, stats.started_at || '—'));

    const statusPanel = h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, '本地 API')),
      h('div', { class: 'panel-body stack' },
        kv,
        d.verify ? null : h('div', { class: 'notice warn' },
          '验证已关闭：不带 api_key 也能调本机 API。这是开关的语义，不是故障 —— 不信任本机时请打开。')));

    /* ---- 2. 端点清单 ---- */
    const all = d.endpoints || [];
    const groups = groupEndpoints(all);
    const tableBody = h('tbody');
    const countLine = h('span', { class: 'muted small' }, '');

    const search = h('input', {
      type: 'search',
      placeholder: '按路径或说明过滤…',
      value: filter,
      onInput: (e) => { filter = e.target.value; drawTable(); },
    });
    const groupSel = h('select', {
      onChange: (e) => { groupFilter = e.target.value; drawTable(); },
    },
    h('option', { value: '' }, '全部分组'),
    [...groups.keys()].map((g) => h('option', { value: g }, g)));

    function drawTable() {
      clear(tableBody);
      const q = filter.trim().toLowerCase();
      let shown = 0;
      for (const [g, list] of groups) {
        if (groupFilter && g !== groupFilter) continue;
        const rows = list.filter((e) => !q
          || e.path.toLowerCase().includes(q)
          || String(e.desc || '').toLowerCase().includes(q));
        if (!rows.length) continue;
        tableBody.appendChild(h('tr', null,
          h('td', { colspan: 5, class: 'muted small' }, `${g}（${rows.length}）`)));
        for (const e of rows) {
          shown++;
          tableBody.appendChild(h('tr', null,
            h('td', null, e.methods.map((m) => h('span', { class: `pill ${m === 'GET' ? 'info' : 'ok'}`, style: { marginRight: '4px' } }, m))),
            h('td', { class: 'mono' }, e.path),
            h('td', null, e.desc || '—'),
            h('td', null, e.auth ? (e.ticket ? pill('票据/Key', 'warn') : pill('需要 Key', 'idle')) : pill('免鉴权', 'ok')),
            h('td', { class: 'muted small' }, e.supported ? (e.rate_tier === 'std' ? '' : e.rate_tier) : '不支持')));
        }
      }
      if (!shown) {
        tableBody.appendChild(h('tr', null, h('td', { colspan: 5, class: 'muted small' }, '没有匹配的端点。')));
      }
      mount(countLine, `显示 ${shown} / 共 ${all.length} 条`);
    }

    const endpointsPanel = h('div', { class: 'panel' },
      h('div', { class: 'panel-head' },
        h('h2', null, '端点清单'),
        h('span', { class: 'spacer' }),
        countLine),
      h('div', { class: 'panel-body stack' },
        h('div', { class: 'row' }, search, groupSel),
        h('div', { class: 'muted small' },
          '这份清单由后端的路由表直接生成，不是手写的 —— 页面显示的条数就是真实路由数。'),
        h('table', { class: 'grid' },
          h('thead', null, h('tr', null,
            h('th', { style: { width: '90px' } }, '方法'),
            h('th', null, '路径'),
            h('th', null, '说明'),
            h('th', { style: { width: '90px' } }, '鉴权'),
            h('th', { style: { width: '80px' } }, '限流'))),
          tableBody)));

    /* ---- 3. MCP 配置 ---- */
    const kinds = [
      { id: 'claude', label: 'Claude Desktop', note: 'claude_desktop_config.json（Windows: %APPDATA%\\Claude\\claude_desktop_config.json）' },
      { id: 'cursor', label: 'Cursor', note: '.cursor/mcp.json（项目内）或 ~/.cursor/mcp.json（全局）' },
      { id: 'codex', label: 'Codex', note: '~/.codex/config.toml' },
    ];
    let kind = 'claude';
    const code = h('pre', { class: 'code-block' }, '');
    const kindNote = h('div', { class: 'muted small' }, '');
    const tabs = h('div', { class: 'tabs' });

    function drawMcp() {
      clear(tabs);
      for (const k of kinds) {
        tabs.appendChild(h('button', {
          class: `btn sm ${k.id === kind ? 'primary' : ''}`,
          onClick: () => { kind = k.id; drawMcp(); },
        }, k.label));
      }
      mount(code, mcpConfig(kind, { port: d.port, apiKey: d.api_key, script: d.mcp?.script }));
      mount(kindNote, kinds.find((k) => k.id === kind)?.note || '');
    }

    const mcpPanel = h('div', { class: 'panel' },
      h('div', { class: 'panel-head' },
        h('h2', null, 'MCP'),
        h('span', { class: 'spacer' }),
        h('button', {
          class: 'btn sm',
          onClick: () => copyText(mcpConfig(kind, { port: d.port, apiKey: d.api_key, script: d.mcp?.script })),
        }, '复制配置')),
      h('div', { class: 'panel-body stack' },
        h('div', { class: 'muted small' },
          'MCP 让 Claude Desktop / Cursor / Codex 直接用自然语言操作本机环境。',
          '它是个 stdio 服务，只连 127.0.0.1 的本地 API，不向外发请求。'),
        tabs,
        code,
        kindNote,
        h('div', { class: 'muted small' },
          '需要本机有 node（18+）。若客户端提示找不到 node，把配置里的 "node" 换成 cmd、args 前面加 "/c" 与 "node"。')));

    mount(body, statusPanel, endpointsPanel, mcpPanel);
    drawTable();
    drawMcp();
  }

  function pill(text, kind) {
    return h('span', { class: `pill ${kind}` }, text);
  }
}
