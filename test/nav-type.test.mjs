/**
 * 真机验证（P13 的门）：CDP 直建带 URL 的页面，`navigation.type` 必须不是 `reload`
 *
 * 背景：`Target.createTarget({ url })` 的首个文档在 attach 之前就建好了，
 * `Page.addScriptToEvaluateOnNewDocument` 只对下一个文档生效 —— 所以 `bff86c6` 补了一次
 * `Page.reload`，代价是这张页面自己读一条
 * `performance.getEntriesByType('navigation')[0].type` 就知道刚被刷过（逆向裁判 C4 的残留）。
 *
 * 这里只判**用户/页面能观测到的那一面**：
 *   ① `navigation.type` 是 `navigate`（修前实测是 `reload`）；
 *   ② 注入仍然生效（按该环境 fp_seed 派生的「注入完成」标记是 object，见 src/kernel/markers.js）；
 *   ③ hardwareConcurrency 是配置值（首帧不是宿主值）。
 *
 * 同时**判**文档请求次数 = 2：这条路径即使去掉了 reload 标记，仍然是两次文档加载
 * （首文档 + 补的那一次），别把它读成「零额外加载」——服务器端/埋点仍然看得见。
 * 判成 2 而不是随便打印，是为了让「悄悄多补一次」（2026-11-11 修过：两个会话各补一次 → 3 次）
 * 和「真的只加载一次」（将来做到了 → 1 次，这条会红，届时改判据并改 README）都能被看见。
 * 读不到计数时这里是 0，同样红 —— 这条断言得能证明自己真的量到了。
 *
 * 跑法：npm run test:nav-type
 */
import http from 'node:http';
import { withProbe, makeChecker, finish, sleep } from './helpers/profile-probe.mjs';

const { results, check } = makeChecker();

const hits = new Map();
const srv = http.createServer((req, res) => {
  const p = String(req.url || '/').split('?')[0];
  hits.set(p, (hits.get(p) || 0) + 1);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head><meta charset="utf-8"><title>nav-type</title></head><body>ok</body></html>');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

try {
  await withProbe(async ({ client, profileId, markers }) => {
    const { getProfile } = await import('../src/store/profiles.js');
    const { fingerprintView } = await import('../src/fingerprint/view.js');
    const view = fingerprintView(getProfile(profileId));
    const wantHc = Number(view.hardware_concurrency);
    /* 注入标记名按这个环境的 fp_seed 派生（P0：页面里没有固定的 __fp* 名）。
     * 名字从 markers 拿，不写死 —— 写死一个派生名等于换个固定名，检测面还在。 */
    const APPLIED = `window[${JSON.stringify(markers.applied)}]`;

    const path = '/nav-type.html';
    const url = `http://127.0.0.1:${port}${path}`;
    const { targetId } = await client.send('Target.createTarget', { url });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    try {
      let seen = { ready: '', applied: '', navType: '', hc: '', href: '' };
      for (let i = 0; i < 120; i++) {
        const r = await client.send('Runtime.evaluate', {
          expression: `document.readyState + "|" + typeof ${APPLIED} + "|" + (performance.getEntriesByType("navigation")[0] || {}).type + "|" + navigator.hardwareConcurrency + "|" + location.href`,
          returnByValue: true,
        }, sessionId).catch(() => null);
        const [ready, applied, navType, hc, href] = String(r?.result?.value ?? '').split('|');
        seen = { ready, applied, navType, hc, href };
        if (applied === 'object' && ready === 'complete') break;
        await sleep(80);
      }
      await sleep(500);
      const docRequests = hits.get(path) || 0;
      console.log(`\nCDP 直建页面：${JSON.stringify(seen)}`);
      console.log(`文档请求次数 = ${docRequests}（2 = 首文档 + 补的那次；这里只保证它不再被标记成 reload）`);

      check('CDP 直建带 URL 的页面：navigation.type 是 navigate（修前是 reload）',
        seen.navType === 'navigate', `实测 ${seen.navType}`);
      check('CDP 直建带 URL 的页面：注入生效（注入完成标记是 object）',
        seen.applied === 'object', JSON.stringify(seen));
      check('CDP 直建带 URL 的页面：hardwareConcurrency 是配置值',
        Number(seen.hc) === wantHc, `实测 ${seen.hc}，配置 ${wantHc}`);
      check('CDP 直建带 URL 的页面：最终文档就是目标 URL',
        String(seen.href).startsWith(url), String(seen.href));
      check('CDP 直建带 URL 的页面：文档请求 2 次（仍加载两次，只去掉 reload 标记）',
        docRequests === 2, `实测 ${docRequests} 次`);
    } finally {
      await client.send('Target.closeTarget', { targetId }).catch(() => {});
    }
  });
} catch (e) {
  console.log('异常：', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
  check('整体跑通（无异常）', false, String(e && e.message));
} finally {
  try { srv.closeAllConnections?.(); } catch { /* ignore */ }
  try { srv.close(); } catch { /* ignore */ }
}

finish(results);
