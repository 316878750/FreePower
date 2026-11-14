/**
 * 自检执行器：开一张临时页（走同一套注入）→ 跑探针 → 生成报告 → 落盘。
 *
 * 页面策略：
 *   1. 先开 about:blank（一定能开，但非安全上下文，UA-CH / mediaDevices 不可用）；
 *   2. 尽量导航到本地 127.0.0.1 的空页（secure context），拿到 UA-CH / 媒体设备；
 *      绑远程代理且 loopback 被强制走代理时这一步会失败，**回落到 about:blank 并如实标注**。
 *
 * 依赖实例提供：
 *   instance.client         浏览器级 CDP
 *   instance.openPage(url)  建 target 并等注入装配完
 *   instance.closePage(id)
 *   instance.real_version   内核真实版本（Browser.getVersion）
 */
import { SELFCHECK_TIMEOUT_MS } from '../config.js';
import { buildProbeSource } from './probe.js';
import { buildReport } from './report.js';
import { loadPrevious, saveReport } from './store.js';
import { openSelfcheckOrigin } from './origin.js';
import { fingerprintView } from '../fingerprint/view.js';
import { markerNames } from '../kernel/markers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function pageState(client, sessionId) {
  const r = await client.send('Runtime.evaluate', {
    expression: 'document.readyState + "\\u0000" + document.title',
    returnByValue: true,
  }, sessionId).catch(() => null);
  const v = String(r?.result?.value ?? '');
  const i = v.indexOf('\u0000');
  return { readyState: i >= 0 ? v.slice(0, i) : '', title: i >= 0 ? v.slice(i + 1) : '' };
}

/** 等页面加载完成；title 给了就同时校验（防止代理/错误页冒充） */
async function waitPage(client, sessionId, { title = null, timeoutMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await pageState(client, sessionId);
    if (s.readyState === 'complete' && (!title || s.title === title)) return true;
    await sleep(100);
  }
  return false;
}

async function goto(client, sessionId, url) {
  await client.send('Page.navigate', { url }, sessionId).catch(() => {});
}

export async function runSelfCheck(instance, profile, { timeoutMs = SELFCHECK_TIMEOUT_MS } = {}) {
  if (!instance || !instance.client) throw new Error('selfcheck: 环境没有运行中的 CDP 连接');
  if (typeof instance.openPage !== 'function') throw new Error('selfcheck: 实例缺少 openPage');

  const page = await withTimeout(instance.openPage('about:blank'), Math.min(timeoutMs, 10000), '自检页创建');
  if (!page || !page.sessionId) throw new Error('selfcheck: 自检页没有拿到 CDP session');

  /* 诊断标记名必须与这个环境的注入一致（按 fp_seed 派生）：
   * 名字对不上，探针就会读不到「注入已生效」，把好环境误判成没生效。 */
  const markers = markerNames(fingerprintView(profile).seed);

  let origin = null;
  const context = { secure: false, url: 'about:blank', note: null };
  try {
    // 尝试切到本地安全上下文页（127.0.0.1 是 potentially trustworthy origin）
    try {
      origin = await openSelfcheckOrigin({ markers });
      await goto(instance.client, page.sessionId, origin.url);
      if (await waitPage(instance.client, page.sessionId, { title: origin.title, timeoutMs: 3500 })) {
        context.secure = true;
        context.url = origin.url;
      } else {
        context.note = '本地安全上下文页加载失败（绑了远程代理且 loopback 被强制走代理），UA-CH / 媒体设备本次未验证';
        await goto(instance.client, page.sessionId, 'about:blank');
        await waitPage(instance.client, page.sessionId, { timeoutMs: 2500 });
      }
    } catch (e) {
      context.note = `安全上下文页准备失败：${e.message}`;
      await goto(instance.client, page.sessionId, 'about:blank').catch(() => {});
    }

    const res = await withTimeout(
      instance.client.send('Runtime.evaluate', {
        expression: buildProbeSource(markers),
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      }, page.sessionId),
      timeoutMs,
      '自检探针',
    );
    if (res.exceptionDetails) {
      const msg = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'unknown';
      throw new Error(`自检探针异常：${String(msg).split('\n')[0]}`);
    }
    const raw = res.result && res.result.value;
    if (!raw || typeof raw !== 'object') throw new Error('自检探针没有返回值');
    raw.context = context;

    const previous = loadPrevious(profile.id || profile.profile_id);
    const report = buildReport(profile, raw, {
      kernelVersion: instance.real_version || null,
      previous,
      context,
    });
    saveReport(report);
    instance.selfcheckReport = report;
    return report;
  } finally {
    try { await instance.closePage(page.targetId); } catch { /* 页面可能已被用户关掉 */ }
    if (origin) await origin.close().catch(() => {});
  }
}