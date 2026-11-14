/** 控制台入口：hash 路由 + 侧栏 + 全局状态角标。没有依赖，四个页面按需 import。 */
import { h, mount, toast } from './ui.js';
import { api } from './api.js';
import profilesList from './pages/profiles.js';
import groupsPage from './pages/groups.js';
import recyclePage from './pages/recycle.js';
import profileEdit from './pages/edit.js';
import proxiesPage from './pages/proxies.js';
import appsPage from './pages/apps.js';
import selfcheckPage from './pages/selfcheck.js';
import agentPage from './pages/agent.js';
import apiPage from './pages/api.js';
import syncPage from './pages/sync.js';
import syncPanelPage from './pages/sync-panel.js';
import settingsPage from './pages/settings.js';
import diagnosticsPage from './pages/diagnostics.js';
import { FOLD_KEY, parseFold, isFolded, toggleFold, writeFold } from './nav.js';
import { DENSITIES, readDensity, setDensity } from './density.js';

const routes = [
  { re: /^\/profiles$/, nav: 'profiles', page: profilesList },
  // 环境管理页内 tabs（0.4.3 ②）：这三块是同一页的三个 tab，侧栏仍然只有一个「环境管理」。
  // **必须排在 /profiles/([^/]+) 前面**，否则 groups / recycle 会被当成环境 id 吃掉。
  { re: /^\/profiles\/groups$/, nav: 'profiles', page: groupsPage },
  { re: /^\/profiles\/recycle$/, nav: 'profiles', page: recyclePage },
  { re: /^\/profiles\/new$/, nav: 'profiles', page: profileEdit, params: () => ({ id: null }) },
  { re: /^\/profiles\/([^/]+)$/, nav: 'profiles', page: profileEdit, params: (m) => ({ id: m[1] }) },
  { re: /^\/profiles\/([^/]+)\/selfcheck$/, nav: 'profiles', page: selfcheckPage, params: (m) => ({ id: m[1] }) },
  { re: /^\/proxies$/, nav: 'proxies', page: proxiesPage },
  { re: /^\/apps$/, nav: 'apps', page: appsPage },
  { re: /^\/api$/, nav: 'api', page: apiPage },
  { re: /^\/sync$/, nav: 'sync', page: syncPage },
  // 独立小窗（desktop/main.js 的置顶面板）加载的就是这一条
  { re: /^\/sync-panel$/, nav: 'sync', page: syncPanelPage },
  // 可选带工作流 id：刷新页面 / 从地址栏打开时还能捞回同一条工作流
  { re: /^\/agent(?:\/([^/]+))?$/, nav: 'agent', page: agentPage, params: (m) => ({ id: m[1] || null }) },
  // 侧栏底部账号菜单的两页（0.4.3 ④）：不占侧栏分组，地址栏直达
  { re: /^\/settings$/, nav: 'settings', page: settingsPage },
  { re: /^\/diagnostics$/, nav: 'diagnostics', page: diagnosticsPage },
];

const head = document.getElementById('page-head');
const page = document.getElementById('page');
const navRoot = document.getElementById('nav');
let current = null;

/* ---- 侧栏折叠 ----
   只有带 data-fold 的组能折（现在只有「自动化」）；「常用」那组没有折叠入口，
   所以它「不能折」是结构上做不到，不是靠一个默认值。
   状态存 localStorage，读写都走 nav.js 的容错函数：隐私模式下写不进去也不该崩。 */
function storage() {
  try { return window.localStorage || null; } catch { return null; }
}

let foldState = parseFold(storage() ? storage().getItem(FOLD_KEY) : null);

function applyFold() {
  for (const group of document.querySelectorAll('.nav-group[data-fold]')) {
    const id = group.dataset.fold;
    const folded = isFolded(foldState, id);
    group.classList.toggle('collapsed', folded);
    const btn = group.querySelector('[data-fold-toggle]');
    if (btn) {
      btn.setAttribute('aria-expanded', folded ? 'false' : 'true');
      btn.title = folded ? '展开' : '折叠';
    }
  }
}

function setFold(next) {
  foldState = next;
  writeFold(storage(), foldState);
  applyFold();
}

/** 当前页在折起来的组里时把它展开 —— 不能让当前页在侧栏里看不见 */
function revealActive() {
  const active = document.querySelector('.nav-item.active');
  const group = active && active.closest('.nav-group[data-fold]');
  if (!group) return;
  const id = group.dataset.fold;
  if (isFolded(foldState, id)) setFold(toggleFold(foldState, id));
}

navRoot.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-fold-toggle]');
  if (!btn) return;
  setFold(toggleFold(foldState, btn.dataset.foldToggle));
});

applyFold();

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
  for (const a of document.querySelectorAll('.nav-item, .account-item')) {
    a.classList.toggle('active', a.dataset.nav === hit.nav);
  }
  revealActive();
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

/* ---- 侧栏底部账号菜单（0.4.3 ④）----
   形态照逆向 `28-远端UI界面结构.md` 的侧栏底部：设置 / 外观（子菜单）/ 网络诊断。
   对手那六项里的「邀请奖励 / 语言 / 退出登录」我们没有对应能力（无账号体系、无多语言），
   不摆假入口 —— 设置页最后一节把这些逐条写明了。
   「外观」用的是 ③ 的密度口径：只写 localStorage（`fp.view_density`），不新造一套存储。 */
const accountRoot = document.getElementById('account-menu');

function buildAccountMenu() {
  if (!accountRoot) return;
  const panelEl = h('div', { class: 'account-panel', hidden: 'hidden' });
  const trigger = h('button', {
    class: 'account-trigger', type: 'button', 'aria-expanded': 'false', 'aria-haspopup': 'menu',
    onClick: (e) => { e.stopPropagation(); toggle(); },
  },
    h('span', { class: 'account-avatar', 'aria-hidden': 'true' }, 'FP'),
    h('span', { class: 'account-text' },
      h('strong', null, '本地运行'),
      h('small', null, '设置 · 外观 · 诊断')),
    h('span', { class: 'account-caret', 'aria-hidden': 'true' }, '▴'));

  const sub = h('div', { class: 'account-sub', hidden: 'hidden' });
  const appearanceBtn = h('button', {
    class: 'account-item', type: 'button', 'aria-expanded': 'false',
    onClick: (e) => {
      e.stopPropagation();
      const open = sub.hasAttribute('hidden');
      if (open) sub.removeAttribute('hidden'); else sub.setAttribute('hidden', 'hidden');
      appearanceBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      appearanceBtn.classList.toggle('open', open);
    },
  }, h('span', null, '外观'), h('span', { class: 'account-sub-caret', 'aria-hidden': 'true' }, '▸'));

  function paintDensity() {
    const cur = readDensity();
    for (const el of sub.querySelectorAll('[data-density]')) {
      el.classList.toggle('on', el.dataset.density === cur);
      el.setAttribute('aria-checked', el.dataset.density === cur ? 'true' : 'false');
    }
  }

  mount(sub, ...DENSITIES.map((d) => h('button', {
    class: 'account-sub-item', type: 'button', role: 'menuitemradio', 'data-density': d.id,
    onClick: (e) => {
      e.stopPropagation();
      setDensity(d.id);   // 写 localStorage + 落 DOM + 广播（列表页那个下拉框会跟着变）
      paintDensity();
    },
  }, h('span', { class: 'account-check', 'aria-hidden': 'true' }, '✓'), d.label)));
  paintDensity();
  // 别处改了密度（列表页工具条）→ 这里跟着变
  document.addEventListener('fp:density', paintDensity);

  mount(panelEl,
    h('a', { class: 'account-item', 'data-nav': 'settings', href: '#/settings' }, '设置'),
    appearanceBtn,
    sub,
    h('a', { class: 'account-item', 'data-nav': 'diagnostics', href: '#/diagnostics' }, '网络诊断'));

  function setOpen(open) {
    panelEl.toggleAttribute('hidden', !open);
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    accountRoot.classList.toggle('open', open);
  }
  function toggle() { setOpen(panelEl.hasAttribute('hidden')); }

  // 点菜单里的链接后收起（hashchange 也会到这一页）
  panelEl.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
  document.addEventListener('click', () => setOpen(false));
  // Esc 收起，键盘用户能退出来
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });

  mount(accountRoot, panelEl, trigger);
}

buildAccountMenu();

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