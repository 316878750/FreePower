/**
 * FreePower · 浏览器内出口探测
 *
 * 预检（probe.js）只证明「代理这一跳活着」。这里再证明第二件事：
 * **浏览器自己的流量真的走了那条代理**（命令行参数写对了、没有被 bypass 规则放行、没有 PAC 回退）。
 *
 * 做法：开一张临时标签加载出口信息接口，读回 JSON，然后立刻关掉。
 * 这张标签和其它标签一样会走注入层，不影响指纹一致性。
 *
 * 0.4.7.5：**3 次退避重试（0 / 1.5s / 4s）**。CEO 实测代理冷启动第一发 35.5s 才通、
 * 第二发 691ms —— 一次失败就写「代理未连通」会把「慢」判成「坏」，起始页上就是一句
 * 假的「代理未连通」。重试是这一版的口径，不是放宽判据（每次尝试的判定完全不变）。
 */
import { EGRESS_PROBE_URL, EGRESS_TIMEOUT_MS } from '../config.js';
import { parseExitInfo } from './probe.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 三次尝试之间的等待（第 1 次不等）。与起始页那条口径一致（src/start/probe.js）。 */
export const EGRESS_RETRY_DELAYS_MS = [0, 1500, 4000];

/**
 * @param {import('../kernel/cdp.js').CdpClient} client
 * @param {{ url?: string, timeoutMs?: number, onTarget?: (targetId: string) => void, retries?: number[] }} [opt]
 *   `onTarget` 在目标刚建好、导航之前同步调用：调用方用它给这张探测页登记「别被 blank-reload 碰」。
 *   不传也能工作（只是会在 400ms 那一拍和 watcher 抢一下）。
 *   `retries` 传 `[0]` 可以关掉重试（判据里模拟「单发」时用）。
 * @returns {Promise<{ok:boolean, ip?:string, country?:string, countryCode?:string, city?:string,
 *   timezone?:string, isp?:string, url:string, attempts?:number, error?:string}>}
 */
export async function probeEgressInBrowser(client, {
  url = EGRESS_PROBE_URL,
  timeoutMs = EGRESS_TIMEOUT_MS,
  onTarget = null,
  retries = EGRESS_RETRY_DELAYS_MS,
} = {}) {
  const delays = Array.isArray(retries) && retries.length ? retries : [0];
  let last = null;
  for (let i = 0; i < delays.length; i += 1) {
    if (delays[i]) await sleep(delays[i]);
    last = await probeOnce(client, { url, timeoutMs, onTarget });
    if (last.ok) return { ...last, attempts: i + 1 };
  }
  return { ...last, attempts: delays.length };
}

async function probeOnce(client, { url, timeoutMs, onTarget }) {
  let targetId = null;
  try {
    ({ targetId } = await client.send('Target.createTarget', { url: 'about:blank' }));
    // 先登记豁免，再做任何可能被 watcher 抢的事（attach / enable / navigate）
    try { if (typeof onTarget === 'function') onTarget(targetId); } catch { /* 登记失败不致命 */ }
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    await client.send('Page.enable', {}, sessionId).catch(() => {});
    await client.send('Page.navigate', { url }, sessionId);

    const deadline = Date.now() + timeoutMs;
    let text = '';
    let state = '';
    const read = async () => {
      const r = await client.send('Runtime.evaluate', {
        // innerText 在某些响应（JSON 走 <pre>、重定向中途）会是空串，退回 textContent 兜一层
        expression: 'document.readyState + "\\u0000" + ((document.body && document.body.innerText) || (document.documentElement && document.documentElement.textContent) || "")',
        returnByValue: true,
      }, sessionId).catch(() => null);
      const value = String(r?.result?.value ?? '');
      const sep = value.indexOf('\u0000');
      state = sep >= 0 ? value.slice(0, sep) : '';
      text = sep >= 0 ? value.slice(sep + 1) : '';
    };
    while (Date.now() < deadline) {
      await read();
      if (state === 'complete' && text.trim()) break;
      await sleep(150);
    }
    // 认证代理上实测出现过「隧道已建成、代理侧看到 200，但这一轮读到空 body」：
    // 不直接判死，给页面半拍再读一次（重定向/HSTS 升级后的落点常常慢半拍）。
    if (!text.trim()) {
      await sleep(200);
      await read();
    }

    if (!text.trim()) {
      const href = await client.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId)
        .then((r) => String(r?.result?.value ?? '')).catch(() => '');
      // 诊断字段：下次复现时能区分「页面没加载」和「读错 target / 被拦截」。
      // 文案保持中性 —— 实测过「readyState=complete + finalUrl=about:blank」这种导航根本没提交的情况，
      // 那既不是被代理拦，也不是没加载完，而是探测目标（或它上游）不可达。
      // 另一种典型：探测 URL 在 HSTS 预载列表里（如 example.com），http 被升到 https → 需要 CONNECT，
      // 而代理不支持 CONNECT 就会落成 chrome-error://chromewebdata/ —— 这时 finalUrl 会直接显示它。
      // ⚠️ 2026-11-11 复核推翻了上面这条作为「启动期读到空 body」的解释：真根因是我们自己的
      // blank-reload watcher 把在飞的导航顶掉了（`net::ERR_ABORTED`，`readyState=complete` +
      // `finalUrl=about:blank` 正是它的指纹）。HSTS/CONNECT 仍是**另一个独立可能**，但不再是主因；
      // 修法与回归见 src/runtime/manager.js 的 scheduleBlankReload 与 README 已知限制 37。
      return {
        ok: false, url, error: '出口探测页没有内容（探测目标不可达或被拦截）',
        targetId, readyState: state || '(空)', finalUrl: href || '(空)',
      };
    }
    const info = parseExitInfo(text, url);
    if (info.error) return { ok: false, url, error: info.error, raw: text.slice(0, 200) };
    if (!info.ip) return { ok: false, url, error: `出口探测页不是预期格式：${text.slice(0, 120)}` };
    return { ok: true, ...info, url };
  } catch (e) {
    return { ok: false, url, error: e.message };
  } finally {
    if (targetId) client.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}