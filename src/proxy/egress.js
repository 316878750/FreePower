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
import { FALLBACK_PROBE_URLS, parseExitInfo } from './probe.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 三次尝试之间的等待（第 1 次不等）。与起始页那条口径一致（src/start/probe.js）。 */
export const EGRESS_RETRY_DELAYS_MS = [0, 1500, 4000];

/**
 * @param {import('../kernel/cdp.js').CdpClient} client
 * @param {{ url?: string, urls?: string[], timeoutMs?: number, onTarget?: (targetId: string) => void, retries?: number[] }} [opt]
 *   `onTarget` 在目标刚建好、导航之前同步调用：调用方用它给这张探测页登记「别被 blank-reload 碰」。
 *   不传也能工作（只是会在 400ms 那一拍和 watcher 抢一下）。
 *   `retries` 传 `[0]` 可以关掉重试（判据里模拟「单发」时用）。
 *   `urls` 多端点轮换（0.4.7.7）：默认 `[url, ...FALLBACK_PROBE_URLS]`，任一成功即止。
 * @returns {Promise<{ok:boolean, ip?:string, country?:string, countryCode?:string, city?:string,
 *   timezone?:string, isp?:string, url:string, attempts?:number, error?:string}>}
 */
export async function probeEgressInBrowser(client, {
  url = EGRESS_PROBE_URL,
  urls = null,
  timeoutMs = EGRESS_TIMEOUT_MS,
  onTarget = null,
  retries = EGRESS_RETRY_DELAYS_MS,
} = {}) {
  const delays = Array.isArray(retries) && retries.length ? retries : [0];
  // 端点顺序：显式给的 url 打头，后面接备用源（去重）
  const endpoints = (Array.isArray(urls) && urls.length ? urls : [url, ...FALLBACK_PROBE_URLS])
    .filter((u, i, a) => u && a.indexOf(u) === i);
  let last = null;
  let tries = 0;
  const dead = new Set(); // 已经明确「这个源被限流/给了 fail」的端点，后面几轮不再试
  for (let i = 0; i < delays.length; i += 1) {
    if (delays[i]) await sleep(delays[i]);
    for (const u of endpoints) {
      if (dead.has(u)) continue;
      tries += 1;
      last = await probeOnce(client, { url: u, timeoutMs, onTarget });
      if (last.ok) return { ...last, attempts: tries };
      // 拿到了 HTTP 响应但内容是 `status=fail` / 空 body → 源的问题，换源，别再重试同一个源
      if (last.definitive) dead.add(u);
    }
    if (dead.size === endpoints.length) break;
  }
  return { ...(last || { ok: false, url, error: '没有可用的探测端点' }), attempts: tries };
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
        // 优先 textContent：标签页被遮挡（visibilityState=hidden）时 innerText 会是空串，
        // 而 textContent 有内容（0.4.7.6 逆向实测：innerText 空、textContent 27,216 字符）
        expression: 'document.readyState + "\\u0000" + ((document.body && (document.body.textContent || document.body.innerText)) || (document.documentElement && document.documentElement.textContent) || "")',
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
      // 0.4.7.5 19:45：**区分「代理不通」与「探测源不可用」**。
      // 落点是 chrome-error:// 才算这一跳（代理）出了问题；落在探测 URL 上却没内容、
      // 或者还停在 about:blank，说明是探测目标/它上游不可达 —— 那是探测源的问题，
      // 起始页与日志都不许写成「代理未连通」。
      const onErrorPage = /^chrome-error:\/\//i.test(String(href || ''));
      return {
        ok: false, url,
        kind: onErrorPage ? 'proxy' : 'probe_site',
        error: onErrorPage
          ? '出口探测页打不开（代理这一跳失败）'
          : '出口探测页没有内容（探测源不可用，不是代理不通）',
        targetId, readyState: state || '(空)', finalUrl: href || '(空)',
      };
    }
    const info = parseExitInfo(text, url);
    // `definitive`：页面真的打开了、也读到了响应，只是这个源给了 `status=fail` 或格式不对
    // → 换源有用，重试同一个源没用（0.4.7.7 多源轮换靠它决定跳过）
    if (info.error) return { ok: false, url, kind: 'probe_site', error: info.error, raw: text.slice(0, 200), definitive: true };
    if (!info.ip) return { ok: false, url, kind: 'probe_site', error: `出口探测页不是预期格式：${text.slice(0, 120)}`, definitive: true };
    return { ok: true, ...info, url };
  } catch (e) {
    return { ok: false, url, kind: 'proxy', error: e.message };
  } finally {
    if (targetId) client.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}