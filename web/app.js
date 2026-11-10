/** 控制台入口：hash 路由 + 侧栏 + 全局状态角标。没有依赖，四个页面按需 import。 */
import { h, mount, toast } from './ui.js';
import { api } from './api.js';
import profilesList from './pages/profiles.js';
import profileEdit from './pages/edit.js';
import proxiesPage from './pages/proxies.js';
import selfcheckPage from './pages/selfcheck.js';

const routes = [
  { re: /^\/profiles$/, nav: 'profiles', page: profilesList },
  { re: /^\/profiles\/new$/, nav: 'profiles', page: profileEdit, params: () => ({ id: null }) },
  { re: /^\/profiles\/([^/]+)$/, nav: 'profiles', page: profileEdit, params: (m) => ({ id: m[1] }) },
  { re: /^\/profiles\/([^/]+)\/selfcheck$/, nav: 'profiles', page: selfcheckPage, params: (m) => ({ id: m[1] }) },
  { re: /^\/proxies$/, nav: 'proxies', page: proxiesPage },
];

const head = document.getElementById('page-head');
const page = document.getElementById('page');
let current = null;

function hashPath() {
  const raw = location.hash.replace(/^#/, '') || '/profiles';
  return raw.split('?')[0];
}

async function route() {
  const path = hashPath();
  let hit = null;
  let params = {};
  for (const r of routes) {
    const m = r.re.exec(path);
    if (m) { hit = r; params = r.params ? r.params(m) : {}; break; }
  }
  if (!hit) { location.hash = '#/profiles'; return; }
  for (const a of document.querySelectorAll('.nav-item')) {
    a.classList.toggle('active', a.dataset.nav === hit.nav);
  }
  current = hit;
  try {
    await hit.page({ head, page, params, navigate });
  } catch (e) {
    mount(head, h('h1', null, '出错了'));
    mount(page, h('div', { class: 'notice bad' }, `页面加载失败：${e.message}`));
    toast(e.message, 'bad');
  }
}

export function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

/* ---- 侧栏角标：端口 + 当前在跑几个环境 ---- */
const footPort = document.getElementById('foot-port');
const footRunning = document.getElementById('foot-running');
document.getElementById('brand-version').textContent = `控制台 v${api.boot.version || '—'}`;
footPort.textContent = `127.0.0.1:${api.boot.port || '—'}`;

async function tickRunning() {
  try {
    const r = await api.running();
    const n = (r && r.list ? r.list.length : 0);
    footRunning.textContent = n ? `运行中 ${n} 个` : '没有环境在运行';
    footRunning.style.color = n ? '#8fd6a8' : '#78828f';
  } catch {
    footRunning.textContent = '服务未响应';
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason && e.reason.message ? e.reason.message : String(e.reason);
  toast(msg, 'bad');
});

route();
tickRunning();
setInterval(tickRunning, 5000);

/* 供页面判断「当前是不是还在这一页」，避免异步回来后往别的页面写 DOM */
export function stillOn(path) {
  return hashPath() === path;
}