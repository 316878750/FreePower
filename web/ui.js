/**
 * 极简视图层：h() 造节点、mount() 挂载、几个小工具。
 *
 * 为什么不用框架：这套界面是"四个页面 + 一堆表格和表单"，
 * 引入构建链的代价（打包、版本、产物入库）比省下的代码多。
 * 这里只有同步渲染，没有 diff —— 需要局部更新的地方直接操作 DOM。
 */

/** 建节点：h('div', {class:'x', onClick: fn}, '文本', h('b', null, '粗')) */
export function h(tag, props, ...kids) {
  if (typeof tag === 'function') return tag(props || {}, kids);
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'for') el.htmlFor = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'disabled') el.disabled = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, kids);
  return el;
}

export function append(el, kids) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false || k === true) continue;
    if (Array.isArray(k)) { append(el, k); continue; }
    el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...kids) {
  clear(el);
  append(el, kids);
  return el;
}

/** 小图标（内联 SVG，不引图标库） */
export function icon(name) {
  const paths = {
    play: 'M8 5v14l11-7z',
    stop: 'M6 6h12v12H6z',
    edit: 'M4 17.2V20h2.8L17 9.8 14.2 7 4 17.2zM19.7 7.3a1 1 0 0 0 0-1.4l-1.6-1.6a1 1 0 0 0-1.4 0l-1.2 1.2 3 3 1.2-1.2z',
    trash: 'M9 3h6l1 2h4v2H4V5h4l1-2zM6 9h12l-1 12H7L6 9z',
    check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
    refresh: 'M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z',
    plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z',
  };
  return h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor' },
    h('path', { d: paths[name] || paths.check }));
}

export function debounce(fn, ms = 350) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function toast(msg, kind = '') {
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast ${kind}` }, msg);
  box.appendChild(el);
  setTimeout(() => { el.remove(); }, kind === 'bad' ? 6000 : 3200);
}

/**
 * 常驻进度提示（导入这种要跑一会儿、有多批的操作）。
 * 不是 toast：toast 会自己消失，进度条要一直挂到 `done()`。
 * @returns {{update:(msg:string)=>void, done:(msg?:string, kind?:string)=>void}}
 */
export function progressToast(initial) {
  const box = document.getElementById('toasts');
  const el = h('div', { class: 'toast' }, initial);
  box.appendChild(el);
  let finished = false;
  return {
    update(msg) { if (!finished) el.textContent = msg; },
    done(msg = '', kind = '') {
      if (finished) return;
      finished = true;
      el.className = `toast ${kind}`.trim();
      if (msg) el.textContent = msg;
      setTimeout(() => { el.remove(); }, kind === 'bad' ? 6000 : 3200);
    },
  };
}

/**
 * 二次确认。danger 类按钮必须是用户主动点的，不能靠「反正能撤销」放行。
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, body, okLabel = '确定', cancelLabel = '取消', danger = false }) {
  return new Promise((resolve) => {
    const root = document.getElementById('dialog-root');
    const done = (v) => { overlay.remove(); resolve(v); };
    const okBtn = h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onClick: () => done(true) }, okLabel);
    const overlay = h('div', { class: 'overlay', onClick: (e) => { if (e.target === overlay) done(false); } },
      h('div', { class: 'dialog', role: 'dialog' },
        h('h3', null, title),
        h('div', { class: 'body' }, body),
        h('div', { class: 'foot' },
          h('button', { class: 'btn', onClick: () => done(false) }, cancelLabel),
          okBtn)));
    root.appendChild(overlay);
    okBtn.focus();
  });
}

/**
 * 单行输入弹窗（复制环境改名字、重命名这类短输入）。
 * @returns {Promise<string|null>} null = 取消
 */
export function promptDialog({ title, label = '', value = '', placeholder = '', okLabel = '确定', cancelLabel = '取消' }) {
  return new Promise((resolve) => {
    const root = document.getElementById('dialog-root');
    const input = h('input', { type: 'text', value, placeholder });
    const done = (v) => { overlay.remove(); resolve(v); };
    const okBtn = h('button', { class: 'btn primary', onClick: () => done(input.value) }, okLabel);
    const overlay = h('div', { class: 'overlay', onClick: (e) => { if (e.target === overlay) done(null); } },
      h('div', { class: 'dialog', role: 'dialog' },
        h('h3', null, title),
        h('div', { class: 'body' },
          h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), input)),
        h('div', { class: 'foot' },
          h('button', { class: 'btn', onClick: () => done(null) }, cancelLabel),
          okBtn)));
    root.appendChild(overlay);
    input.focus();
    input.select();
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value); });
  });
}

/** 浏览器里下载一段文本（导出环境/导出 cookie 用，不经过任何外部服务） */
export function downloadText(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 选一个本地文件并读成文本（导入用） */
export function pickFile(accept = '.json,application/json') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', () => {
      const file = input.files && input.files[0] ? input.files[0] : null;
      input.remove();
      resolve(file);
    });
    document.body.appendChild(input);
    input.click();
  });
}

/** 右侧抽屉，用于新建/编辑代理这种短表单 */
export function drawer({ title, body, footer, onClose }) {
  const root = document.getElementById('dialog-root');
  const close = () => { el.remove(); if (onClose) onClose(); };
  const el = h('div', { class: 'drawer-overlay', onClick: (e) => { if (e.target === el) close(); } },
    h('div', { class: 'drawer' },
      h('div', { class: 'd-head' },
        h('h3', null, title),
        h('button', { class: 'btn ghost sm', onClick: close }, '关闭')),
      h('div', { class: 'd-body' }, body),
      footer ? h('div', { class: 'd-foot' }, footer) : null));
  root.appendChild(el);
  return { close, el };
}

export function pill(text, kind = 'idle') {
  return h('span', { class: `pill ${kind}` }, h('span', { class: 'dot' }), text);
}

export function empty(text) {
  return h('div', { class: 'empty' }, text);
}
