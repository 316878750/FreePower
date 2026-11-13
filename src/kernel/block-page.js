/**
 * 拦截页：命中环境网络规则时，给浏览器一张**我们自己的 HTML**，而不是让它报
 * `net::ERR_BLOCKED_BY_CLIENT`（Chrome 的「无法访问此网站」）。
 *
 * 为什么要有这个（差距清单：拦截的呈现不同）：对手在 `StaticConfig.BlockPage` 里塞一整页
 * base64 HTML，命中后由自编译内核直接返回；页面脚本还用 `window.blockUrl` 再判一次子域。
 * 我们没有内核改造能力，走 CDP `Fetch.fulfillRequest` —— 语义一样（拦到之后给页面），
 * 落点不一样（它改内核，我们改拦截应答）。**不搬它的页面与素材**，这页是自己写的。
 *
 * 分工（改这里之前先读 `src/runtime/manager.js` 的 `installRequestGating`）：
 *   - **只有顶层文档**（`resourceType === 'Document'`、request 阶段）给拦截页；
 *   - 子资源（图片 / 脚本 / XHR）仍然 `Fetch.failRequest` —— 往 `<img>` 里塞 HTML 是垃圾，
 *     还会把站点的错误处理搞乱；
 *   - **response 阶段**（视频开关那条）不给页面 —— 响应已经在路上了，换不掉。
 *
 * 三件被钉死的事（都是被要求写死、不是可选项）：
 *   1. **CSP 钉零外链**：`default-src 'none'`。页面里一个外链都不写只是自觉，CSP 才是约束 ——
 *      将来谁手滑加个 `<img src=https://…>` 也加载不出来；
 *   2. **`Cache-Control: no-store`**：拦截页不能被缓存之后当正常页面回放；
 *   3. **`window.__fpBlock = { url, reason, host }`**：脚本判「这页是被拦的」的唯一可靠判据
 *      （`goto` 不再抛 `ERR_BLOCKED_BY_CLIENT` 了，见 README「0.4.1 破坏性变更」）。
 *      所以 `url` 与 `reason` 两个入口都必须**全转义**，否则拦截页自己就是个 XSS 面。
 *
 * 纯函数、零 IO：本文件不碰 fs / 网络，判据在 `test/net-rules.test.mjs` 里不跑内核就能验。
 */
import crypto from 'node:crypto';

/** 页面标题。也是 B 层判据认「这是我们的拦截页」的依据之一。 */
export const BLOCK_PAGE_TITLE = '已拦截 · FreePower';

/** 拦截页体积上限（判据用：这页不该长成第二个网站） */
export const BLOCK_PAGE_MAX_BYTES = 8192;

/**
 * reason → 给用户看的中文。**这是一个封闭枚举**：`reason` 来自 `decideRequest()`，
 * 只有这三个值；加新档位时这里要一起加，兜底文案保证「没登记的值也不会漏出一句英文」。
 */
const REASON_TEXT = Object.freeze({
  blacklist: '命中此环境的域名黑名单',
  not_in_whitelist: '不在此环境的域名白名单内',
  disable_video: '此环境关闭了视频加载',
});

const REASON_FALLBACK = '被此环境的网络规则拦截';

export function blockReasonText(reason) {
  return REASON_TEXT[String(reason || '')] || REASON_FALLBACK;
}

/** HTML 文本转义。`url` 与 `reason` 都从这里过，别给任何一个开后门。 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 把对象嵌进 `<script>` 里用的 JS 字面量。
 *
 * 必须比 `JSON.stringify` 多做一步：`<` `>` `&` 与 U+2028/U+2029 换成 `\uXXXX`。
 * 不换 `</script>` 就能提前闭合脚本块 —— 那是这个文件里最容易犯的错，所以单独一个函数，
 * 判据里也拿 `</script><script>alert(1)</script>` 直接打它。
 * 注意转义后 JS 解析出来的**值不变**（`\u003c` 在字符串字面量里就是 `<`），数据不丢。
 */
function jsonForScript(value) {
  const ESC = { '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' };
  return String(JSON.stringify(value)).replace(/[<>&\u2028\u2029]/g, (c) => ESC[c]);
}

/** 拿 URL 的 host（解析不了就空串，不要因此让整页报错） */
export function hostOfUrl(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return '';
  }
}

/**
 * 渲染拦截页。
 * @param {{url?:string, host?:string, reason?:string}} opts
 * @returns {{html:string, nonce:string}}
 */
export function blockPageHtml({ url = '', host = '', reason = '' } = {}) {
  const href = String(url || '');
  const hostText = String(host || hostOfUrl(href) || '（未知主机）');
  const reasonKey = String(reason || '');
  const reasonText = blockReasonText(reasonKey);
  const nonce = crypto.randomBytes(16).toString('base64');

  // __fpBlock 的三个字段是对外契约，别改名、别加必填项（脚本只认这三个）。
  const payload = { url: href, reason: reasonKey || 'unknown', host: hostText };

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(BLOCK_PAGE_TITLE)}</title>
<style>
:root{color-scheme:light dark}
html,body{margin:0;min-height:100%}
body{display:flex;align-items:center;justify-content:center;background:#f6f7f9;color:#1b1d21;font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei UI",sans-serif}
@media (prefers-color-scheme:dark){body{background:#16181d;color:#e6e8ec}main{background:#1e2128;border-color:#2c3040}dl{background:#22252e}dt,.hint{color:#98a0ae}.badge{background:#262a35;color:#a9b2c0}}
main{max-width:640px;margin:24px;padding:28px 32px;background:#fff;border:1px solid #e3e6ea;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.08)}
.badge{display:inline-block;margin:0 0 12px;padding:2px 8px;border-radius:999px;background:#eef1f5;color:#5b6472;font-size:12px;letter-spacing:.04em}
h1{margin:0 0 8px;font-size:20px}
.why{margin:0 0 18px;color:#3c4149}
dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 14px;margin:0 0 18px;padding:14px 16px;background:#f8f9fb;border-radius:8px}
dt{color:#7a828e;font-size:13px}
dd{margin:0;word-break:break-all;font-family:ui-monospace,Consolas,monospace;font-size:13px}
.hint{margin:0;color:#7a828e;font-size:13px}
</style>
</head>
<body>
<main id="fp-blocked">
<p class="badge">FreePower 拦截页</p>
<h1>已拦截</h1>
<p class="why">此请求${escapeHtml(reasonText)}，没有发出去。</p>
<dl>
<dt>主机</dt><dd id="fp-host">${escapeHtml(hostText)}</dd>
<dt>地址</dt><dd id="fp-url">${escapeHtml(href)}</dd>
</dl>
<p class="hint">这不是网站返回的内容。要放行，请在环境设置里调整域名黑名单 / 白名单，或关掉对应开关后重新打开环境。</p>
</main>
<script nonce="${escapeHtml(nonce)}">window.__fpBlock = ${jsonForScript(payload)};</script>
</body>
</html>`;

  return { html, nonce };
}

/**
 * 给 CDP `Fetch.fulfillRequest` 用的应答（CDP 要 base64 body）。
 * @returns {{status:number, headers:{name:string,value:string}[], bodyBase64:string, html:string}}
 */
export function blockPageResponse({ url = '', host = '', reason = '' } = {}) {
  const { html, nonce } = blockPageHtml({ url, host, reason });
  return {
    status: 200,
    headers: [
      { name: 'Content-Type', value: 'text/html; charset=utf-8' },
      // 零外链不靠自觉：default-src 'none' 把 img/style/font/frame/connect 全按死；
      // script-src 单独开一个 nonce，只为让下面那句 window.__fpBlock 执行。
      {
        name: 'Content-Security-Policy',
        value: `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      },
      { name: 'Cache-Control', value: 'no-store' },
      { name: 'X-Content-Type-Options', value: 'nosniff' },
      { name: 'Referrer-Policy', value: 'no-referrer' },
    ],
    bodyBase64: Buffer.from(html, 'utf8').toString('base64'),
    html,
  };
}