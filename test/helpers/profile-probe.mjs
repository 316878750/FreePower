/**
 * 真机探针的公共脚手架：起一个环境 + 一个本地 http 页，给断言脚本两个 origin
 *
 * 为什么抽出来：媒体设备（P9-C）与语音投影（P9-A）都要「真内核 + 两个 origin」，
 * 但它们是两次独立提交，证据也得能分别复跑。这里只做启动/导航/回收，不含任何断言。
 *
 * 环境变量必须在 import manager 之前设好（DATA_DIR 等是模块加载时读的），
 * 所以 manager / profiles 都用动态 import，放在 withProbe 里面。
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 统一的 PASS/FAIL 记录器，返回 results 给末尾汇总 */
export function makeChecker() {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  };
  return { results, check };
}

/** 末尾统一收尾：打印汇总并按失败数设退出码 */
export function finish(results) {
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fail} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/**
 * @param {(ctx: {evalIn: Function, nav: Function, grant: Function, URL_A: string, URL_B: string}) => Promise<void>} fn
 */
export async function withProbe(fn) {
  const DATA = path.join(ROOT, '.tmp', `probe-${process.pid}-${Date.now()}`);
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  process.env.FREEPOWER_DATA = DATA;
  process.env.FREEPOWER_SELFCHECK = '0';
  process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
  process.env.FREEPOWER_EGRESS_TIMEOUT = '1000';

  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>probe</title><body>probe</body>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const manager = await import('../../src/runtime/manager.js');
  const profiles = await import('../../src/store/profiles.js');
  let client = null;
  let profileId = null;
  try {
    const created = profiles.createProfile({ name: `probe-${Date.now()}`, group_id: '0', remark: 'P9 真机探针' });
    profileId = created.profile_id;
    const started = await manager.startProfile(profiles.getProfile(profileId));
    console.log(`环境 ${profileId} · 内核 ${started.real_version}`);
    const inst = manager.getInstance(profileId);
    client = inst.client;
    const sessionId = (await inst.openPage('about:blank')).sessionId;
    await client.send('Page.enable', {}, sessionId).catch(() => {});
    // 语音事件计数器：必须在文档创建时就在（原生 voiceschanged 只触发一次）
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__voiceEvents = 0; try { speechSynthesis.onvoiceschanged = function () { window.__voiceEvents = (window.__voiceEvents || 0) + 1; }; } catch (e) {}',
    }, sessionId).catch(() => {});

    const evalIn = async (expression) => {
      const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) return { error: r.exceptionDetails.text };
      return r.result.value;
    };
    const nav = async (url) => {
      await client.send('Page.navigate', { url }, sessionId);
      await sleep(1200);
    };
    const grant = async (origin) => {
      await client.send('Browser.grantPermissions', { permissions: ['videoCapture', 'audioCapture'], origin }, sessionId).catch(() => {});
    };

    await fn({
      evalIn, nav, grant,
      URL_A: `http://127.0.0.1:${port}/a`,
      URL_B: `http://localhost:${port}/b`,
    });
  } finally {
    const withTimeout = (p, ms = 3000) => Promise.race([Promise.resolve(p).catch(() => {}), sleep(ms)]);
    try { if (client) client.close(); } catch { /* ignore */ }
    try { if (profileId) await withTimeout(manager.stopProfile(profileId)); } catch { /* ignore */ }
    try { if (profileId) profiles.deleteProfiles([profileId]); } catch { /* ignore */ }
    try { srv.closeAllConnections?.(); } catch { /* ignore */ }
    try { srv.close(); } catch { /* ignore */ }
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
