/**
 * 标签页同步：主窗口的标签 ↔ 受控窗口的标签（按**序号**对应）。
 *
 * 两层分开：
 *   · 纯函数（`targetIndex` / `planUnify` / `planCloseOthers` / `planCloseBlank` / `isBlankUrl`）
 *     —— 只算「该动哪几个、动成什么样」，A 层判据直接测它们，不需要 Chrome；
 *   · CDP 操作（`listTabs` / `visibleTabIndex` / `openTabFor` / `closeTabAt`）
 *     —— 真正去开、关、跳。
 *
 * 一条选项 + 一条硬约束（照对手界面，`28-远端UI界面结构.md:156-161`）：
 *   选项 `current_tab_url`：**首个网址在当前标签页打开**（`syncOperateCurrentTabURL`）
 *     —— 第一个网址在当前标签页里跳，其余照常新开。
 *   硬约束「先空白再导航」：`Target.createTarget({url})` 会在 attach 之前就把首个文档建好，
 *   注入脚本只对**下一个**文档生效 —— 那张标签的首帧就是原始指纹（manager 里有实测记录）。
 *   所以这里的 `openTabFor` 一律 about:blank → 登记 blank-reload 豁免 → attach → `Page.navigate`。
 *   **这条不做成开关**：首帧指纹不是可选项，两个分支迟早腐化成一个（拦截页不加开关同一个理由）。
 */
import { setTimeout as delay } from 'node:timers/promises';
import { isStartPageUrl } from '../start/host.js';

/* 自己带一个 sleep：不从 session.js 借 —— session 会 import 本模块，
 * 互相 import 在 ESM 里虽然能跑，但初始化顺序会变得难解释，不值得。 */
const sleep = (ms) => delay(ms);

/** 空白标签：这些 URL 算「空白页」（关空白标签的判据就是它）。 */
export function isBlankUrl(url) {
  const u = String(url || '').trim().toLowerCase();
  return u === '' || u === 'about:blank'
    || u === 'chrome://newtab' || u === 'chrome://new-tab-page'
    || u.startsWith('chrome://new-tab-page/') || u.startsWith('chrome://newtab');
}

/** 只接受 http/https（和「打开网址」那条同一口径）：其它协议一律拒，不猜用户想开什么。 */
export function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let withScheme = s;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) withScheme = `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * 「打开网址」的输入解析：切行、去空、归一，**最多 10 个**。
 * 超过 10 个返回 error（文案用对手原文 `syncOperateOpenUrlsMaxCountExceed`），
 * **不静默截断** —— 用户填 12 个却只开 10 个，比直接报错难查得多。
 * 入参可以是数组，也可以是**多行文本**（对手的 `syncOperateUrlList` 就是多行文本框）。
 */
export function parseOpenUrls(raw) {
  const list = (Array.isArray(raw) ? raw : [raw])
    .flatMap((v) => String(v ?? '').split(/\r?\n/))
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length) return { urls: [], error: 'url 必须是 http/https 地址' };
  if (list.length > 10) return { urls: [], error: '一键最多打开10个网址' };
  const urls = [];
  for (const item of list) {
    const u = normalizeUrl(item);
    if (!u) return { urls: [], error: 'url 必须是 http/https 地址' };
    urls.push(u);
  }
  return { urls, error: null };
}

/**
 * 主窗口第 `masterIndex` 个标签 → 受控窗口应该动第几个。
 * `same_tab=false` 返回 `null`（调用方改用「当前可见标签」）。
 * 序号越界（受控窗口标签比主窗口少）也返回 `null` —— **跳过并记下来，不猜、不乱关**。
 */
export function targetIndex(masterIndex, slaveCount, sameTab = true) {
  if (!sameTab) return null;
  const i = Math.floor(Number(masterIndex));
  const n = Math.floor(Number(slaveCount));
  if (!Number.isFinite(i) || !Number.isFinite(n) || i < 0 || i >= n) return null;
  return i;
}

/** 关其它：留 `keepIndex`，其余全关。**从大到小**返回，避免边关边挪位。 */
export function planCloseOthers(count, keepIndex = 0) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const keep = Math.floor(Number(keepIndex));
  const out = [];
  for (let i = n - 1; i >= 0; i--) if (i !== keep) out.push(i);
  return out;
}

/** 关空白：按 URL 判，空 URL 也算空白（about:blank 之外的「没加载出东西」也在这条里）。 */
export function planCloseBlank(urls) {
  const out = [];
  const list = Array.isArray(urls) ? urls : [];
  for (let i = list.length - 1; i >= 0; i--) if (isBlankUrl(list[i])) out.push(i);
  return out;
}

/**
 * 统一标签页：把受控窗口的标签弄成和主窗口一致（数量 + 每个序号的 URL）。
 *
 * 只出**计划**，不动手：调用方按计划执行（这样 A 层可以离线判「该开几个、该关几个、该跳哪个」）。
 * 顺序上也只做我们真能做到的：多余的在尾部关、缺的在尾部开、同序号 URL 不同就原地导航。
 * **不做「把新标签插到中间」** —— CDP 没有这个能力（造出来就会骗人）。
 */
export function planUnify(masterUrls, slaveUrls) {
  const m = (Array.isArray(masterUrls) ? masterUrls : []).map(String);
  const s = (Array.isArray(slaveUrls) ? slaveUrls : []).map(String);
  const navigate = [];
  for (let i = 0; i < Math.min(m.length, s.length); i++) {
    /* 0.4.7.3：**任一边**是起始页就跳过这个序号。
     * 起始页 URL 里带的是**各自环境**的 id 与签名（端口也可能不同），照字面比一定不相等；
     * 硬导航过去只会让受控窗口显示一张 403 的起始页（签名不属于它），
     * 反过来把用户那张起始页导航成业务页也是错的。两种不对称都要挡住。 */
    if (isStartPageUrl(m[i]) || isStartPageUrl(s[i])) continue;
    if (m[i] !== s[i]) navigate.push({ index: i, url: m[i] });
  }
  const open = m.slice(s.length);
  const close = [];
  for (let i = s.length - 1; i >= m.length; i--) close.push(i);
  return { navigate, open, close };
}

/* ============================ CDP 操作 ============================ */

/**
 * 标签顺序登记表（每个 CDP 连接一份）。
 *
 * 为什么不能直接拿 `Target.getTargets` 的返回顺序当序号（2026-11-14 实测，Chrome 157.0.8103.78）：
 * 那个顺序是**内部哈希序**，既不是标签栏顺序、也不是创建顺序。同一个窗口顺序开 a1 → a2 → a3，
 * 读回来是 `a3, a1, a2`；再开一个，旧的相对顺序还会挪。拿它当「第 N 个标签」，
 * 「主窗口关第 2 个 → 受控窗口关第 2 个」就会关到别的页面上去。
 *
 * 能当序号的是 `Target.targetCreated` 的**事件顺序**：新标签一律追加在标签栏末尾，
 * 关掉一个只是从序列里去掉、其余相对顺序不变。所以这里自己维护一张表。
 *
 * 订阅之前就存在的标签（启动时 Chrome 自带的那几张）拿不到创建事件，只能用别的信号定序：
 * 按 URL 排序 —— CDP 里没有「真标签栏顺序」这个信息，URL 排序至少保证**两侧算出来一致**
 * （同一批启动页在两个窗口里会得到同样的序号）。这条是已知限制，写在 README。
 */
const orderRegistry = new WeakMap();

function registryFor(client) {
  let reg = orderRegistry.get(client);
  if (!reg) {
    reg = { ids: [], pending: null };
    orderRegistry.set(client, reg);
  }
  return reg;
}

function subscribeOrder(client, reg) {
  if (reg.pending) return reg.pending;
  reg.pending = (async () => {
    // 先抓「订阅之前就有的」那一批：setDiscoverTargets 也会为它们补发 created 事件，
    // 补发的顺序同样不可靠，所以先自己定序，再让事件只负责**之后**新建的。
    const pre = await client.send('Target.getTargets').catch(() => ({ targetInfos: [] }));
    const pages = (pre.targetInfos || []).filter((t) => t.type === 'page');
    reg.ids = [...pages]
      .sort((a, b) => String(a.url || '').localeCompare(String(b.url || ''))
        || String(a.targetId).localeCompare(String(b.targetId)))
      .map((t) => t.targetId);

    client.on('Target.targetCreated', (p) => {
      const t = p?.targetInfo;
      if (!t || t.type !== 'page') return;
      if (!reg.ids.includes(t.targetId)) reg.ids.push(t.targetId);
    });
    client.on('Target.targetDestroyed', (p) => {
      const i = reg.ids.indexOf(p?.targetId);
      if (i >= 0) reg.ids.splice(i, 1);
    });
    await client.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
  })();
  return reg.pending;
}

/** 浏览器里的真标签列表，序号 = **创建顺序**（0 起）。 */
export async function listTabs(client) {
  const reg = registryFor(client);
  await subscribeOrder(client, reg);
  const { targetInfos } = await client.send('Target.getTargets');
  const pages = (targetInfos || []).filter((t) => t.type === 'page');
  const byId = new Map(pages.map((t) => [t.targetId, t]));
  // 事件有延迟（关掉之后 destroyed 还没到）：以 getTargets 为准先剔掉已经不在的
  for (let i = reg.ids.length - 1; i >= 0; i--) if (!byId.has(reg.ids[i])) reg.ids.splice(i, 1);
  // 事件漏掉的（订阅瞬间建的）补在末尾，别丢
  for (const t of pages) if (!reg.ids.includes(t.targetId)) reg.ids.push(t.targetId);
  return reg.ids.map((id, i) => {
    const t = byId.get(id);
    return { index: i, targetId: id, url: t.url || '', title: t.title || '' };
  });
}

/**
 * 当前**可见**（前台）标签的序号。
 * CDP 没有「现在哪个标签是激活的」这个字段，只能 attach 上去读 `document.visibilityState`。
 * 读不到就退回 0 —— 但把 `confident:false` 带回去，调用方可以如实记「这条是猜的」。
 */
export async function visibleTabIndex(client, tabs) {
  const list = Array.isArray(tabs) ? tabs : await listTabs(client);
  for (const t of list) {
    try {
      const { sessionId } = await client.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      const r = await client.send('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true }, sessionId);
      await client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      if (r?.result?.value === 'visible') return { index: t.index, confident: true };
    } catch { /* 这个 target 挂了就试下一个 */ }
  }
  return { index: 0, confident: false };
}

/**
 * 新开一个标签并导航（唯一允许的姿势）。
 * @param {{url: string, onTarget?: (targetId: string) => void}} opt
 */
export async function openTabFor(client, { url, onTarget } = {}) {
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  try { onTarget?.(targetId); } catch { /* 豁免登记失败不该挡住开标签 */ }
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Page.enable', {}, sessionId).catch(() => {});
  await client.send('Page.navigate', { url }, sessionId);
  return { targetId, sessionId };
}

/** 在当前可见标签里直接跳（「首个网址在当前标签页打开」那条用它）。 */
export async function navigateAt(client, targetId, url) {
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Page.enable', {}, sessionId).catch(() => {});
  await client.send('Page.navigate', { url }, sessionId);
  return { targetId, sessionId };
}

/** 关一个标签。已经关掉的不报错（关标签是幂等的：重试/重复点不该炸）。 */
export async function closeTabAt(client, targetId) {
  try {
    await client.send('Target.closeTarget', { targetId });
    return true;
  } catch {
    return false;
  }
}

/** 关完等一拍，让 `Target.getTargets` 的列表稳定下来（紧接着读序号才不会读到旧表）。 */
export async function settle(ms = 120) {
  await sleep(ms);
}