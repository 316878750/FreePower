/**
 * FreePower · 浏览器内出口探测
 *
 * 预检（probe.js）只证明「代理这一跳活着」。这里再证明第二件事：
 * **浏览器自己的流量真的走了那条代理**（命令行参数写对了、没有被 bypass 规则放行、没有 PAC 回退）。
 *
 * 做法：开一张临时标签加载出口信息接口，读回 JSON，然后立刻关掉。
 * 这张标签和其它标签一样会走注入层，不影响指纹一致性。
 */
import { EGRESS_PROBE_URL, EGRESS_TIMEOUT_MS } from '../config.js';
import { parseExitInfo } from './probe.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {import('../kernel/cdp.js').CdpClient} client
 * @returns {Promise<{ok:boolean, ip?:string, country?:string, countryCode?:string, city?:string,
 *   timezone?:string, isp?:string, url:string, error?:string}>}
 */
export async function probeEgressInBrowser(client, {
  url = EGRESS_PROBE_URL,
  timeoutMs = EGRESS_TIMEOUT_MS,
} = {}) {
  let targetId = null;
  try {
    ({ targetId } = await client.send('Target.createTarget', { url: 'about:blank' }));
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
      // 诊断字段：下次复现时能区分「页面没加载」和「读错 target / 被拦截」
      return {
        ok: false, url, error: '出口探测页没有内容（代理拦截或页面没加载完）',
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