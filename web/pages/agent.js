/**
 * AI Agent 面板：**选环境 → 填目标 → 生成 → 逐条批准 → 运行 → 每步结果**。
 *
 * 最小闭环，不多做：没有对话历史、没有多轮修改、没有自动批准。
 * HITL 是这套东西的硬约束 —— 生成只是提案，每一步都得人点「批准」。
 *
 * 两条口径（与 `presentWorkflow` / `runBrowserTask` 一致）：
 *   - **不回显敏感原文**：`fill` 的值、`cookie set` 的值在服务端已经换成 `***`，
 *     这里 `paramText` 再兜一层（不依赖"服务端一定打了码"）；
 *   - 截图链接走**短期票据**（`screenshot-ticket`），master key 绝不进 URL。
 *
 * 文件上半截是**纯函数**（不碰 DOM），`test/ui.test.mjs` 直接 import 这几个做断言；
 * 下半截才是页面渲染。别把 DOM 调用挪进纯函数里，否则那条测试会在 Node 里炸。
 */
import { h, mount, clear, toast, confirmDialog, pill, empty, fmtTime } from '../ui.js';
import { api } from '../api.js';

/* ============================ 纯渲染逻辑 ============================ */

const TERMINAL = new Set(['completed', 'failed', 'rejected', 'aborted']);
const HIDDEN_VALUE = '••••';

/** digest 前 8 位：审批时人核对的就这 8 位（64 位太长，眼睛比不出来） */
export function digest8(digest) {
  const s = String(digest ?? '');
  return s ? s.slice(0, 8) : '—';
}

/**
 * 一步的参数对：动作之外的所有字段，`value` 一律打码。
 * `fill` / `cookie set` 的值可能是密码或 token —— 这里只给占位符。
 */
export function paramPairs(step) {
  const params = (step && step.params) || {};
  const out = [];
  for (const k of Object.keys(params)) {
    if (k === 'action') continue;
    const raw = params[k];
    const v = k === 'value' ? HIDDEN_VALUE : raw;
    out.push([k, v === true ? 'true' : v === false ? 'false' : String(v)]);
  }
  return out;
}

/** 一行参数摘要：`selector=#q · value=••••`；没参数就是「（无参数）」 */
export function paramText(step) {
  const pairs = paramPairs(step);
  return pairs.length ? pairs.map(([k, v]) => `${k}=${v}`).join(' · ') : '（无参数）';
}

/** 截图链接：票据 URL + 这一张的相对路径（相对 DATA_DIR/agent/screenshots/） */
export function shotHref(ticketUrl, rel) {
  const base = String(ticketUrl || '');
  const p = String(rel || '');
  if (!base || !p) return '';
  return `${base}${base.includes('?') ? '&' : '?'}path=${encodeURIComponent(p)}`;
}

/** 状态 → pill 色调（只影响颜色，不影响任何判断） */
export function statusKind(status) {
  const s = String(status || '');
  if (s === 'completed' || s === 'approved' || s === 'ok') return 'ok';
  if (s === 'failed' || s === 'rejected' || s === 'aborted') return 'bad';
  if (s === 'running') return 'warn';
  return 'idle';
}

const ACTION_LABEL = {
  open: '打开页面', click: '点击', fill: '填写', wait: '等待', text: '取文本', screenshot: '截图', cookie: 'Cookie',
};

/** `open · 打开页面` 这种两段式标签：脚本读者看英文动作，人看中文 */
export function actionLabel(action) {
  const a = String(action || '');
  return a ? `${a} · ${ACTION_LABEL[a] || '动作'}` : '—';
}

/* ============================ 页面 ============================ */

export default async function renderAgent({ head, page, params }) {
  let wf = null;
  let profiles = [];
  let busy = false;
  let ticket = { url: '', at: 0, failAt: 0 };
  let pollTimer = null;

  const profileSel = h('select');
  const goalInput = h('textarea', {
    rows: 3,
    placeholder: '一句话目标，例如：打开 https://example.com，读出 h1 的文本，再截一张整页图',
  });
  const llmEndpoint = h('input', { placeholder: '留空用服务端 AGENT_LLM_ENDPOINT（不填任何厂商地址）' });
  const llmKey = h('input', { type: 'password', placeholder: '留空用服务端 AGENT_LLM_KEY（不回显、不写盘）' });
  const llmModel = h('input', { placeholder: '留空用服务端 AGENT_LLM_MODEL' });
  const genBtn = h('button', { class: 'btn primary', onClick: () => generate() }, '生成工作流');
  const errBox = h('div');
  const wfBox = h('div', { class: 'stack' });

  mount(head,
    h('h1', null, 'AI Agent'),
    h('span', { class: 'sub' }, '目标 → 动作清单 → 逐条人工批准 → 本地执行'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm', onClick: () => loadProfiles(true) }, '刷新环境'));

  mount(page,
    h('div', { class: 'panel' },
      h('div', { class: 'panel-body' },
        h('div', { class: 'stack' },
          h('label', { class: 'field' },
            h('span', { class: 'lbl' }, '环境', h('span', { class: 'req' }, '*')),
            profileSel),
          h('label', { class: 'field' },
            h('span', { class: 'lbl' }, '目标', h('span', { class: 'req' }, '*')),
            goalInput),
          h('details', null,
            h('summary', { class: 'muted small' }, '模型配置（不填就用服务端的 AGENT_LLM_*）'),
            h('div', { class: 'stack', style: { marginTop: '8px' } },
              h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'endpoint'), llmEndpoint),
              h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'key'), llmKey),
              h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'model'), llmModel),
              h('div', { class: 'muted small' },
                '三样要么都填、要么都留空（走服务端配置）。key 只随本次请求转发给本机服务，不落盘、不回显；FreePower 不带任何内置 key。'))),
          h('div', { class: 'row' },
            genBtn,
            h('span', { class: 'muted small' }, '生成只是提案：每一步都要你点「批准」才会执行。')),
          errBox))),
    wfBox);

  mount(wfBox, empty('还没有工作流：选环境、写一句目标，点「生成工作流」。'));
  await loadProfiles(false);

  // 直接打开 `#/agent/<id>`（刷新页面）时按 id 捞回工作流
  if (params && params.id) {
    try {
      wf = await api.agentStatus(params.id);
      if (wf && wf.status === 'running') poll();
      await refreshTicketIfNeeded();
      render();
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

  /* ------------------------------ 数据 ------------------------------ */

  async function loadProfiles(showToast) {
    try {
      const r = await api.list({ limit: 200, page: 1 });
      profiles = r.list || [];
      const keep = profileSel.value;
      clear(profileSel);
      profileSel.appendChild(h('option', { value: '' },
        profiles.length ? '— 选一个环境 —' : '还没有环境：先去「环境管理」建一个'));
      for (const p of profiles) {
        profileSel.appendChild(h('option', {
          value: p.profile_id,
          selected: p.profile_id === keep,
        }, `#${p.profile_no} ${p.name}`));
      }
    } catch (e) {
      if (showToast) toast(`读环境列表失败：${e.message}`, 'bad');
    }
  }

  /* ------------------------------ 生成 ------------------------------ */

  async function generate() {
    if (busy) return;
    mount(errBox);
    const profile_id = profileSel.value;
    const goal = goalInput.value.trim();
    if (!profile_id) { toast('先选一个环境', 'bad'); return; }
    if (!goal) { toast('目标不能为空', 'bad'); return; }

    const llm = {};
    if (llmEndpoint.value.trim()) llm.endpoint = llmEndpoint.value.trim();
    if (llmKey.value.trim()) llm.key = llmKey.value.trim();
    if (llmModel.value.trim()) llm.model = llmModel.value.trim();
    const given = Object.keys(llm).length;
    if (given && !(llm.endpoint && llm.key && llm.model)) {
      toast('显式模型配置要 endpoint / key / model 三样齐，或者三样都留空走服务端配置', 'bad');
      return;
    }

    busy = true;
    genBtn.disabled = true;
    genBtn.textContent = '生成中…（最多等 60 秒）';
    try {
      wf = await api.agentCreateFromGoal({ profile_id, goal, llm: given ? llm : undefined });
      ticket = { url: '', at: 0, failAt: 0 };
      // 地址里带上 id：刷新页面还能捞回来（replaceState 不触发 hashchange，不会把刚填的表单冲掉）
      try { history.replaceState(null, '', `#/agent/${wf.workflow_id}`); } catch { /* 忽略 */ }
      toast(`已生成 ${wf.steps.length} 步，全部待批准`, 'ok');
      render();
    } catch (e) {
      wf = null;
      mount(errBox, h('div', { class: 'notice bad' }, `生成失败：${e.message}`));
      mount(wfBox, empty('生成失败，没有创建工作流（也没有花掉执行额度）。'));
      toast(e.message, 'bad');
    } finally {
      busy = false;
      genBtn.disabled = false;
      genBtn.textContent = '生成工作流';
    }
  }

  /* ------------------------------ 审批 / 运行 ------------------------------ */

  async function decide(step, decision) {
    if (!wf || busy) return;
    if (decision === 'reject') {
      const yes = await confirmDialog({
        title: '拒绝这一步',
        body: h('div', { class: 'stack' },
          h('div', null, `拒绝第 ${step.step_id} 步（${step.action}）？`),
          h('div', { class: 'notice warn' }, '拒绝会让整条工作流落 rejected，剩余步骤不会再执行。')),
        okLabel: '拒绝', danger: true,
      });
      if (!yes) return;
    }
    busy = true;
    render();
    try {
      wf = await api.agentApprove(wf.workflow_id, { step_id: step.step_id, decision, digest: step.digest });
      toast(decision === 'approve' ? '已批准这一步' : '已拒绝', decision === 'approve' ? 'ok' : 'warn');
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      busy = false;
      render();
    }
  }

  async function approveAll() {
    if (!wf || busy) return;
    const pending = wf.steps.filter((s) => s.status === 'pending_approval');
    if (!pending.length) { toast('没有待批准的步骤'); return; }
    if (pending.length > 1) {
      const yes = await confirmDialog({
        title: '全部批准',
        body: `一次批掉 ${pending.length} 步？确认每一步的参数都看过了。`,
        okLabel: '全部批准',
      });
      if (!yes) return;
    }
    busy = true;
    render();
    try {
      for (const s of pending) {
        wf = await api.agentApprove(wf.workflow_id, { step_id: s.step_id, decision: 'approve', digest: s.digest });
      }
      toast('已全部批准', 'ok');
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      busy = false;
      render();
    }
  }

  async function run() {
    if (!wf || busy) return;
    busy = true;
    render();
    try {
      wf = await api.agentRun(wf.workflow_id);
      toast('开始执行：进度每 1.5 秒刷新一次', 'ok');
      poll();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      busy = false;
      render();
    }
  }

  function poll() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (!wf) { stopPoll(); return; }
      try {
        wf = await api.agentStatus(wf.workflow_id);
        if (!page.isConnected) { stopPoll(); return; }
        if (TERMINAL.has(wf.status)) {
          stopPoll();
          toast(`工作流 ${wf.status}`, wf.status === 'completed' ? 'ok' : 'bad');
        }
        await refreshTicketIfNeeded();
        render();
      } catch (e) {
        stopPoll();
        toast(`读状态失败：${e.message}`, 'bad');
      }
    }, 1500);
  }

  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function refreshStatus() {
    if (!wf) return;
    try {
      wf = await api.agentStatus(wf.workflow_id);
      await refreshTicketIfNeeded();
      render();
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

  /** 图要进 `<img src>`，带不了 api-key 头：换一张 120 秒票据（90 秒就主动续） */
  async function refreshTicketIfNeeded() {
    const shots = (wf && wf.steps ? wf.steps : []).filter((s) => s.action === 'screenshot' && s.result && s.result.path);
    if (!shots.length) return;
    if (ticket.url && Date.now() - ticket.at < 90 * 1000) return;
    if (ticket.failAt && Date.now() - ticket.failAt < 10 * 1000) return; // 失败别每 1.5 秒刷一次 toast
    try {
      const t = await api.agentScreenshotTicket(wf.workflow_id);
      ticket = { url: t.url, at: Date.now(), failAt: 0 };
    } catch (e) {
      ticket = { url: '', at: 0, failAt: Date.now() };
      toast(`取截图链接失败：${e.message}`, 'bad');
    }
  }

  /* ------------------------------ 渲染 ------------------------------ */

  function render() {
    if (!wf) {
      mount(wfBox, empty('还没有工作流：选环境、写一句目标，点「生成工作流」。'));
      return;
    }
    const pending = wf.steps.filter((s) => s.status === 'pending_approval').length;
    const canRun = wf.status === 'approved';
    const panelHead = h('div', { class: 'panel-head' },
      h('div', { class: 'stack', style: { gap: '4px' } },
        h('div', { class: 'row' },
          pill(wf.status, statusKind(wf.status)),
          h('span', { class: 'mono muted small' }, `工作流 ${String(wf.workflow_id).slice(0, 8)}…`),
          h('span', { class: 'muted small' }, fmtTime(wf.created_at)),
          h('span', { class: 'muted small' }, `HITL 默认 ${wf.hitl?.default_decision || 'deny'}`)),
        h('div', null, h('strong', null, '目标：'), wf.goal),
        h('div', { class: 'muted small' },
          `${wf.steps.length} 步 · 待批准 ${pending} · 执行器 ${wf.executor}`)),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn sm', disabled: busy, onClick: () => refreshStatus() }, '刷新'),
        h('button', {
          class: 'btn sm', disabled: busy || !pending, onClick: () => approveAll(),
        }, pending > 1 ? `全部批准（${pending}）` : '全部批准'),
        h('button', {
          class: 'btn primary sm',
          disabled: busy || !canRun,
          title: canRun ? '按顺序执行已批准的步骤' : '要全部步骤都批准才能跑',
          onClick: () => run(),
        }, wf.status === 'running' ? '执行中…' : '运行')));

    mount(wfBox,
      h('div', { class: 'panel' },
        panelHead,
        h('div', { class: 'panel-body' },
          h('div', { class: 'stack' },
            wf.error ? h('div', { class: 'notice bad' }, `工作流失败：${wf.error.code} ${wf.error.msg || ''}`) : null,
            ...wf.steps.map((s, i) => stepRow(s, i))))));
  }

  function stepRow(step, i) {
    const waiting = step.status === 'pending_approval';
    return h('div', { style: { display: 'flex', gap: '12px', alignItems: 'flex-start', padding: '8px 0', borderTop: i ? '1px solid #22282f' : 'none' } },
      h('div', { class: 'stack', style: { gap: '3px', flex: '1', minWidth: '0' } },
        h('div', { class: 'row' },
          h('span', { class: 'muted small' }, `${i + 1}.`),
          h('strong', null, actionLabel(step.action)),
          pill(step.status, statusKind(step.status)),
          h('span', { class: 'mono muted small', title: step.digest }, `digest ${digest8(step.digest)}`)),
        h('div', { class: 'muted small mono' }, paramText(step)),
        resultView(step)),
      h('div', { class: 'actions' },
        waiting ? h('button', { class: 'btn sm', disabled: busy, onClick: () => decide(step, 'approve') }, '批准') : null,
        waiting ? h('button', { class: 'btn sm danger', disabled: busy, onClick: () => decide(step, 'reject') }, '拒绝') : null));
  }

  function resultView(step) {
    const r = step.result;
    if (!r) {
      if (step.reason) return h('div', { class: 'muted small' }, `原因：${step.reason}`);
      if (TERMINAL.has(step.status) && step.status !== 'completed') return h('div', { class: 'muted small' }, '没有执行');
      return null;
    }
    if (step.action === 'text') {
      const v = String(r.value ?? '');
      return h('div', { class: 'stack', style: { gap: '4px' } },
        h('div', { class: 'muted small' },
          `取到 ${v.length} 字符${r.truncated ? `（原文 ${r.original_len} 字节，已按 10KB 截断）` : ''}`),
        h('pre', { class: 'code-block', style: { maxHeight: '180px', overflow: 'auto', margin: 0 } }, v));
    }
    if (step.action === 'screenshot') {
      const href = shotHref(ticket.url, r.path);
      return h('div', { class: 'stack', style: { gap: '4px' } },
        h('div', { class: 'muted small' }, '截图（相对 DATA_DIR/agent/screenshots/）'),
        href
          ? h('a', { href, target: '_blank', rel: 'noreferrer', class: 'mono small' }, r.path)
          : h('span', { class: 'mono small muted' }, r.path),
        href ? h('img', {
          src: href, alt: r.path,
          style: { maxWidth: '240px', border: '1px solid #2a3038', borderRadius: '4px' },
        }) : null);
    }
    if (step.action === 'cookie' && Array.isArray(r.cookies)) {
      return h('div', { class: 'muted small' }, `取到 ${r.cookies.length} 条 cookie（值不回显）`);
    }
    if (r.ok) {
      return h('div', { class: 'muted small' }, `ok${Number.isFinite(r.took_ms) ? ` · ${r.took_ms}ms` : ''}`);
    }
    return h('div', { class: 'muted small mono' }, JSON.stringify(r).slice(0, 200));
  }
}
