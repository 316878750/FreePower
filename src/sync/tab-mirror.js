/**
 * 窗口同步 · 标签镜像（0.4.7.14）：主控**新开标签 / 打开链接 / 切标签 / 关标签**，受控窗口跟着做。
 *
 * 为什么需要：键鼠回放只能复现「页面里」的操作。地址栏输入网址、点「+」新开标签、Ctrl+T、
 * 标签栏切换/关闭都发生在**浏览器界面**，页面 JS 捕获不到（docs/30 §5 第 6 条）。
 * 这里改从 CDP 的 target 事件看结果：主控多了一张标签、某张标签导航到新地址、前台标签换了，
 * 就在每个受控窗口里做同样的事。
 *
 * 为什么按「映射」而不是按「序号」对应：用户 9 窗口实测（2026-11-25 diag）主控与受控的标签
 * **顺序不一致**（有的起始页在前、有的真站在前），按序号对应会动错标签。所以只镜像
 * 「会话开始时的前台标签」和「会话期间新开的标签」，每张主控标签记下它在每个受控窗口里对应哪张。
 * 会话开始前就存在的其它标签不动 —— 宁可不跟，也不要关错/跳错用户的页面。
 *
 * 防重复：主控里点 `target=_blank` 的链接，点击本身会被回放到受控窗口，受控也会自己开出一张。
 * 所以新标签有 opener 时先等一拍，受控窗口里若已出现「opener 是对应标签」的新页就**认领**它，不再另开。
 * 导航同理：等一拍再比 URL，点击已经让受控跳到同一地址的就不再跳第二次。
 */
import { getInstance, logProfile } from '../runtime/manager.js';
import { closeTabAt, isBlankUrl, navigateAt, openTabFor } from './tabs.js';

/** 认领 / 比对前等多久：给「点击回放让受控自己开/跳」留时间 */
export const MIRROR_SETTLE_MS = 1200;

/** 只认 http/https/about:blank 这类能在受控窗口原样打开的地址；chrome:// 内部页一律当空白 */
export function mirrorableUrl(url) {
  const u = String(url || '');
  if (/^https?:\/\//i.test(u)) return u;
  return null;
}

/** 两个地址算不算「同一页」：忽略 #hash 与末尾斜杠（SPA 的锚点跳转不值得再导航一次） */
export function sameUrl(a, b) {
  const norm = (s) => String(s || '').replace(/#.*$/, '').replace(/\/+$/, '');
  return norm(a) === norm(b);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TabMirror {
  /**
   * @param {object} opt
   * @param {object} opt.masterClient 主控浏览器级 CDP 客户端
   * @param {string} opt.masterId
   * @param {() => string[]} opt.slaves 当前受控 profileId 列表
   * @param {(id: string) => object|null} opt.slaveClient 受控浏览器级 CDP 客户端
   * @param {() => object} opt.settings 会话当前设置（读 `tab_sync`）
   * @param {number} [opt.settleMs]
   */
  constructor({ masterClient, masterId, slaves, slaveClient, settings, settleMs = MIRROR_SETTLE_MS }) {
    this.mc = masterClient;
    this.masterId = masterId;
    this.slaves = slaves;
    this.slaveClient = slaveClient;
    this.settings = settings;
    this.settleMs = settleMs;
    /** masterTargetId → Map<slaveId, slaveTargetId> */
    this.map = new Map();
    /** 已认领的受控标签（防两张主控标签认领同一张） */
    this.claimed = new Map();   // slaveId → Set<targetId>
    this.chain = Promise.resolve();
    this.stopped = false;
    this.stats = { opened: 0, adopted: 0, navigated: 0, closed: 0, activated: 0, errors: 0 };
    this.lastError = null;
  }

  enabled() { return !this.stopped && this.settings()?.tab_sync !== false; }

  /** 串行执行：标签操作互相之间有先后（开完才能导航、导航完才能切） */
  run(label, fn) {
    this.chain = this.chain.then(async () => {
      if (!this.enabled()) return;
      try { await fn(); } catch (e) {
        this.stats.errors += 1;
        this.lastError = `${label}: ${e?.message || e}`;
        logProfile(this.masterId, 'WARN 标签同步', this.lastError);
      }
    });
    return this.chain;
  }

  /** 会话开始：主控前台标签 ↔ 每个受控窗口当前投递目标 */
  seed(masterTargetId, slaveTargets) {
    const m = new Map();
    for (const [sid, tid] of slaveTargets) {
      if (!tid) continue;
      m.set(sid, tid);
      this.claim(sid, tid);
    }
    this.map.set(masterTargetId, m);
  }

  claim(sid, tid) {
    if (!this.claimed.has(sid)) this.claimed.set(sid, new Set());
    this.claimed.get(sid).add(tid);
  }

  async targetInfo(client, targetId) {
    const { targetInfos } = await client.send('Target.getTargets');
    return (targetInfos || []).find((t) => t.targetId === targetId) || null;
  }

  /** 主控新开了一张标签 */
  onMasterTabAdded(targetId) {
    if (this.map.has(targetId)) return null;
    this.map.set(targetId, new Map());   // 先占位：随后到的导航事件要能找到它
    return this.run('新开标签', async () => {
      const info = await this.targetInfo(this.mc, targetId).catch(() => null);
      const openerM = info?.openerId || null;
      await sleep(this.settleMs);
      if (!this.map.has(targetId)) return;   // 等的这一拍里又被关了
      const fresh = await this.targetInfo(this.mc, targetId).catch(() => null);
      const url = mirrorableUrl(fresh?.url || info?.url);
      const row = this.map.get(targetId);
      for (const sid of this.slaves()) {
        const c = this.slaveClient(sid);
        if (!c || row.has(sid)) continue;
        // ① 有 opener：受控若已被点击回放带出一张「opener = 对应标签」的新页，认领它
        const openerS = openerM ? this.map.get(openerM)?.get(sid) : null;
        if (openerS) {
          const { targetInfos } = await c.send('Target.getTargets');
          const cand = (targetInfos || []).find((t) => t.type === 'page' && t.openerId === openerS
            && !this.claimed.get(sid)?.has(t.targetId));
          if (cand) {
            row.set(sid, cand.targetId); this.claim(sid, cand.targetId); this.stats.adopted += 1;
            continue;
          }
        }
        // ② 否则自己开一张（about:blank → 导航，首帧指纹规矩见 tabs.js openTabFor）
        const inst = getInstance(sid);
        const r = await openTabFor(c, { url: url || 'about:blank', onTarget: (tid) => inst?.exemptBlankReload?.(tid) });
        row.set(sid, r.targetId); this.claim(sid, r.targetId); this.stats.opened += 1;
        await c.send('Target.detachFromTarget', { sessionId: r.sessionId }).catch(() => {});
      }
      logProfile(this.masterId, '标签同步',
        `主控新开标签 ${String(url || 'about:blank').slice(0, 100)} → 受控 ${row.size}/${this.slaves().length} 个窗口`
        + `（新开 ${this.stats.opened} 认领 ${this.stats.adopted}）`);
    });
  }

  /** 主控某张标签的主帧导航到了新地址（含地址栏输入、点链接、前进后退） */
  onMasterNavigated(targetId, rawUrl) {
    const url = mirrorableUrl(rawUrl);
    if (!url || !this.map.has(targetId)) return null;
    return this.run('打开链接', async () => {
      await sleep(this.settleMs);
      const row = this.map.get(targetId);
      if (!row) return;
      // 等的这一拍里主控又跳走了：以主控**现在**的地址为准，别把受控带到中间页
      const now = await this.targetInfo(this.mc, targetId).catch(() => null);
      const want = mirrorableUrl(now?.url) || url;
      let n = 0;
      for (const [sid, stid] of row) {
        const c = this.slaveClient(sid);
        if (!c) continue;
        const cur = await this.targetInfo(c, stid).catch(() => null);
        if (!cur) { row.delete(sid); continue; }          // 受控这张已经被关了
        if (sameUrl(cur.url, want)) continue;             // 点击回放已经让它跳过去了
        const r = await navigateAt(c, stid, want);
        await c.send('Target.detachFromTarget', { sessionId: r.sessionId }).catch(() => {});
        n += 1; this.stats.navigated += 1;
      }
      if (n) logProfile(this.masterId, '标签同步', `主控打开 ${want.slice(0, 120)} → 受控 ${n} 个窗口跟着跳转`);
    });
  }

  /** 主控前台标签换了：受控切到对应那张，键鼠才会投到同一个页面 */
  onMasterActivated(targetId) {
    const row = this.map.get(targetId);
    if (!row || !row.size) return null;
    return this.run('切换标签', async () => {
      for (const [sid, stid] of row) {
        const c = this.slaveClient(sid);
        if (!c) continue;
        await c.send('Target.activateTarget', { targetId: stid }).catch(() => {});
        this.stats.activated += 1;
      }
    });
  }

  /** 主控关了一张标签：受控对应的也关 */
  onMasterTabRemoved(targetId) {
    const row = this.map.get(targetId);
    this.map.delete(targetId);
    if (!row || !row.size) return null;
    return this.run('关闭标签', async () => {
      for (const [sid, stid] of row) {
        const c = this.slaveClient(sid);
        if (!c) continue;
        if (await closeTabAt(c, stid)) this.stats.closed += 1;
        this.claimed.get(sid)?.delete(stid);
      }
    });
  }

  stop() { this.stopped = true; }

  status() {
    return { enabled: this.enabled(), mapped_tabs: this.map.size, ...this.stats, last_error: this.lastError };
  }
}

export { isBlankUrl };
