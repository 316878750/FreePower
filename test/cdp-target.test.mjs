/**
 * 真机验证：CDP 直接 Target.createTarget({ url }) 建出来的页面必须也带注入
 *
 * 为什么单列一条：这是外部自动化（puppeteer / CDP 脚本）最常见的开页方式。
 * attach 时首个文档已经在加载，addScriptToEvaluateOnNewDocument 只对下一个文档生效 ——
 * 这条路径如果只靠「空白页重载」，带 URL 建出来的页面首帧就是裸指纹
 * （实测 navigator.hardwareConcurrency 是宿主 32，而环境配的是 6）。
 *
 * 跑法：npm run test:cdp-page
 */
import { withProbe, makeChecker, finish, sleep } from './helpers/profile-probe.mjs';

const { results, check } = makeChecker();
try {
  await withProbe(async ({ client, profileId, URL_A }) => {
    const { getProfile } = await import('../src/store/profiles.js');
    const { fingerprintView } = await import('../src/fingerprint/view.js');
    const view = fingerprintView(getProfile(profileId));
    const wantHc = Number(view.hardware_concurrency);
    const wantLang = String((view.language || [])[0] || '').toLowerCase();
    const url = `${URL_A}?cdp-created=1`;

    const { targetId } = await client.send('Target.createTarget', { url });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    try {
      // 轮询到「注入已生效」或超时；期间 manager 可能补一次 reload，sessionId 不变
      let seen = { applied: '', ready: '', hc: '', lang: '', href: '' };
      for (let i = 0; i < 80; i++) {
        const r = await client.send('Runtime.evaluate', {
          expression: 'typeof window.__fpApplied + "|" + document.readyState + "|" + navigator.hardwareConcurrency + "|" + navigator.language + "|" + location.href',
          returnByValue: true,
        }, sessionId).catch(() => null);
        const [applied, ready, hc, lang, href] = String(r?.result?.value ?? '').split('|');
        seen = { applied, ready, hc, lang, href };
        if (applied === 'object' && ready === 'complete') break;
        await sleep(100);
      }
      console.log(`\nCDP 直建页面：${JSON.stringify(seen)}`);

      check('CDP 直建带 URL 的页面：注入最终生效（__fpApplied 是 object）', seen.applied === 'object', JSON.stringify(seen));
      check('CDP 直建带 URL 的页面：hardwareConcurrency 是配置值，不是宿主值',
        Number(seen.hc) === wantHc, `实测 ${seen.hc}，配置 ${wantHc}`);
      check('CDP 直建带 URL 的页面：navigator.language 是配置值',
        String(seen.lang).toLowerCase() === wantLang, `实测 ${seen.lang}，配置 ${wantLang}`);
    } finally {
      await client.send('Target.closeTarget', { targetId }).catch(() => {});
    }
  });
} catch (e) {
  console.log('异常：', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
  check('整体跑通（无异常）', false, String(e && e.message));
}
finish(results);
