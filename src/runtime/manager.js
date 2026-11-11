import fs from 'node:fs';
import path from 'node:path';
import {
  PROFILES_DIR, LOG_DIR, START_TIMEOUT_MS,
  EGRESS_PROBE_URL, PROXY_PROBE_TIMEOUT_MS, EGRESS_TIMEOUT_MS, UA_AUTOALIGN, SELFCHECK_ON_START, FP_DEBUG,
} from '../config.js';
import { findChrome, buildArgs, launchChrome, waitForDevToolsPort, killProcessTree, rememberVersion } from '../kernel/chrome.js';
import { CdpClient, fetchJson } from '../kernel/cdp.js';
import { buildInjectionSource, buildWorkerInjectionSource } from '../kernel/inject.js';
import { alignProfileToKernel } from '../kernel/version.js';
import { fingerprintView } from '../fingerprint/view.js';
import { ensureNoiseSeeds } from '../fingerprint/seeds.js';
import { checkProfile, markStatus, applyProfileFields, persistEgress } from '../store/profiles.js';
import { checkProxy, hasProxy } from '../proxy/probe.js';
import { pacInUse, pacMessage } from '../proxy/pac.js';
import { probeEgressInBrowser } from '../proxy/egress.js';
import { runSelfCheck } from '../selfcheck/index.js';
import { summarize } from '../selfcheck/store.js';
import { checkEgress } from '../../packages/profile/src/validate.js';

/** profile_id -> instance */
const running = new Map();
/** profile_id -> 启动中的 Promise（防并发重复启动） */
const starting = new Map();

const soft = (field, message) => ({ field, message, severity: 'soft' });

/**
 * worker 注入的等待上限。
 * 正常是毫秒级（实测专用 worker 2ms、SW 在 resume 后立即回）；3s 只是「卡死就记账放弃」的兜底，
 * 超时会把该项写进 failed 清单，**不静默丢**。
 */
const WORKER_INJECT_TIMEOUT_MS = 3000;
/** 被 auto-attach 接住、需要注入 JS 的 target 类型 */
const WORKER_TARGET_TYPES = new Set(['worker', 'shared_worker', 'service_worker']);

/** 运行中实例 → 对外契约形状（ws.selenium 只放 host:port；debug_port 是字符串） */
function toStartData(i, { alreadyRunning = false } = {}) {
  return {
    profile_id: i.profile_id,
    pid: i.pid,
    debug_port: String(i.port),
    ws: { puppeteer: i.wsUrl, selenium: `127.0.0.1:${i.port}` },
    webdriver: `127.0.0.1:${i.port}`,
    status: i.status,
    real_version: i.real_version,
    started_at: i.started_at,
    already_running: alreadyRunning,
    // P3 前置新增（超集，不影响只读旧字段的调用方）
    proxy: i.proxy || null,
    egress: i.egress || null,
    ua_aligned: i.ua_aligned || null,
    launch_args: i.launch_args || { applied: [], rejected: [] },
    warnings: i.warnings || [],
    // P7 新增：worker 注入实况（总挂载数 / 真注入数 / 跳过与失败清单），自检与排障都读它
    workers: i.workerStats || null,
    // P2 新增：启动后自动跑一次自检的摘要（完整报告走 selfcheck 接口）
    selfcheck: i.selfcheck || null,
  };
}

export function listRunning() {
  return [...running.values()].map((i) => toStartData(i));
}

export function getRunning(profileId) {
  const i = running.get(profileId);
  return i ? toStartData(i, { alreadyRunning: true }) : null;
}

/** 实例内部对象（自检页/调试用） */
export function getInstance(profileId) {
  return running.get(profileId) || null;
}

/**
 * profile 目录：**由系统算，不接受用户覆盖**（对齐对手的目录约定，而不是 --user-data-dir 入参）。
 * 命名：<profile_no>_<id 前 8 位>/userdata
 */
export function userDataDirFor(profile) {
  const id = typeof profile === 'string' ? profile : profile.id || profile.profile_id;
  const no = (typeof profile === 'object' && profile.profile_no) || 'x';
  return path.join(PROFILES_DIR, `${no}_${String(id).slice(0, 8)}`, 'userdata');
}

function log(profileId, ...parts) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`;
    fs.appendFileSync(path.join(LOG_DIR, `${profileId}.log`), line);
  } catch { /* 日志失败不影响启动 */ }
}

/**
 * 启动环境。幂等：已启动直接返回现成的 ws，不开第二个。
 *
 * 关键顺序（任何一步不满足都不许起进程）：
 *   一致性校验 → 内核解析 → UA 跟版 → **代理预检（fail-closed）** → 起内核 →
 *   页面在暂停态接住并装配 → 浏览器内出口探测 → 地理/时区一致性告警
 *
 * @param {object} profile
 * @param {{force?:boolean}} opts force=1 时允许越过硬冲突（软冲突本来就只告警）
 */
export async function startProfile(profile, { force = false } = {}) {
  const id = profile.id || profile.profile_id;

  const inst = running.get(id);
  if (inst) return toStartData(inst, { alreadyRunning: true });
  if (starting.has(id)) {
    await starting.get(id).catch(() => {});
    const done = running.get(id);
    if (done) return toStartData(done, { alreadyRunning: true });
  }

  const p = (async () => {
    // 1) 启动前校验：硬冲突 + 值域错误阻断，软冲突只告警
    const check = checkProfile(profile, { force });
    if (!check.ok) {
      const err = new Error(check.errors.map((e) => `${e.field}: ${e.message}`).join('; '));
      err.code = 800005;
      err.reason = 'consistency';
      err.errors = check.errors;
      throw err;
    }
    const warnings = [...check.soft];
    if (check.forced) {
      warnings.unshift(soft('$', `已强制启动：${check.hard.length} 条硬冲突被 force=1 越过（${check.hard.map((e) => e.field).join(',')}）`));
    }

    // 1.5) PAC 明确拒绝：不能为了「支持」而留一个 DIRECT 回退的后门
    const pac = pacInUse(profile);
    if (pac) {
      const err = new Error(pacMessage(pac));
      err.code = 800003;
      err.reason = 'pac_unsupported';
      throw err;
    }

    // 1.6) 噪点种子补齐：老环境可能没有 *_id，按 fp_seed 派生并落库，保证跨重启一致
    const seedPatch = ensureNoiseSeeds(profile);
    if (Object.keys(seedPatch).length) {
      profile = { ...profile, ...seedPatch };
      try { applyProfileFields(id, seedPatch); log(id, '补齐噪点种子', Object.keys(seedPatch).join(',')); }
      catch (e) { log(id, '噪点种子落库失败', e.message); }
    }

    const chrome = findChrome();
    if (!chrome) {
      const err = new Error('找不到内核：设置 FREEPOWER_CHROME，或把内核放到 data/kernels/<version>/ 下');
      err.code = 800003;
      throw err;
    }

    // 2) 代理 fail-closed：先证明代理活着、能出网，再决定要不要起内核
    const proxy = profile.user_proxy_config || profile.proxy_config || null;
    const proxyBound = hasProxy(proxy);
    let proxyCheck = null;
    if (proxyBound) {
      if (String(profile.bypass_proxy_check) === '1') {
        warnings.push(soft('bypass_proxy_check', '已跳过代理预检（bypass_proxy_check=1）：代理若失效就不会有兜底，请自行确认'));
        log(id, 'WARN 跳过代理预检（bypass_proxy_check=1）');
      } else {
        proxyCheck = await checkProxy(proxy, { url: EGRESS_PROBE_URL, timeoutMs: PROXY_PROBE_TIMEOUT_MS });
        if (!proxyCheck.ok) {
          log(id, '代理预检失败，拒绝启动', proxyCheck.error);
          const err = new Error(`代理不可用，已阻止启动（fail-closed）：${proxyCheck.error}`);
          err.code = 800003;
          err.reason = 'proxy_unreachable';
          err.proxy_check = proxyCheck;
          throw err;
        }
        log(id, '代理预检通过', `${proxyCheck.ip} ${proxyCheck.countryCode || ''} ${proxyCheck.latency_ms}ms`);
      }
    } else {
      warnings.push(soft('proxy', '未绑定代理：出口即本机 IP，跑真实账号请务必绑代理'));
    }

    // 3) 起内核：用户 launch_args 走白名单合并进真实 argv
    //    UA 跟版放在拿到 Browser.getVersion 之后做 —— 目录名不是版本真值（Application 里可能同时躺着两个版本）
    let effective = profile;
    let view = fingerprintView(effective);
    let uaAligned = null;
    const udd = userDataDirFor(effective);
    fs.mkdirSync(udd, { recursive: true });
    // 上一次运行留下的 DevToolsActivePort 会让本轮读到旧端口 → 连到一个已经死掉的端口。
    // 必须在新内核写文件之前删掉（重启同一环境的常见坑）。
    try { fs.rmSync(path.join(udd, 'DevToolsActivePort'), { force: true }); } catch { /* ignore */ }

    const built = buildArgs(effective, {
      userDataDir: udd,
      proxy,
      proxyBound,
      userArgs: effective.launch_args,
    });
    warnings.push(...built.warnings);
    for (const r of built.rejected) {
      warnings.push(soft('launch_args', `参数被拒绝：${r.arg} —— ${r.reason}`));
    }
    log(id, 'launch', chrome.path, chrome.version, built.args.join(' '));

    const child = launchChrome(chrome.path, built.args);
    const pid = child.pid;
    let client = null;

    try {
      const { port, browserPath } = await waitForDevToolsPort(udd, { timeoutMs: START_TIMEOUT_MS });
      const fallbackWs = `ws://127.0.0.1:${port}${browserPath}`;
      const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
      const reportedWs = version.webSocketDebuggerUrl || fallbackWs;

      client = await CdpClient.connect(reportedWs);
      const bv = await client.send('Browser.getVersion');
      const realVersion = String(bv.product || '').replace(/^.*\//, '');
      rememberVersion(chrome.path, realVersion);

      // 4) UA / 内核版本跟版：以真实内核版本为准，系统 Chrome 自动升级后不用人手改
      if (UA_AUTOALIGN && realVersion) {
        const aligned = alignProfileToKernel(profile, realVersion);
        if (aligned.changed) {
          effective = aligned.profile;
          view = fingerprintView(effective);
          uaAligned = { from: aligned.from, to: aligned.to, patch: aligned.patch, reasons: aligned.reasons };
          log(id, 'UA 跟版', aligned.reasons.join('; '));
          try { applyProfileFields(id, aligned.patch); } catch (e) { log(id, 'UA 跟版落库失败', e.message); }
        }
      }

      // 内核版本漂移检查：UA 声明的版本必须等于真实内核版本（跟版之后这里应当已经一致）
      const declared = effective.client_hints?.ua_full_version;
      if (declared && realVersion && declared !== realVersion) {
        warnings.push(soft('client_hints.ua_full_version', `UA 声明 ${declared}，真实内核 ${realVersion}（未开自动跟版？）`));
      }

      const instance = {
        profile_id: id,
        pid,
        port,
        wsUrl: reportedWs,
        client,
        child,
        status: 'starting',
        started_at: Math.floor(Date.now() / 1000),
        real_version: realVersion,
        user_data_dir: udd,
        proxy: proxyCheck,
        egress: null,
        ua_aligned: uaAligned,
        launch_args: { applied: built.applied, rejected: built.rejected },
        warnings,
        selfcheck: null,
        selfcheckReport: null,
      };
      running.set(id, instance);
      markStatus(id, 'starting');

      child.once('exit', (code) => {
        log(id, 'exit', String(code));
        const cur = running.get(id);
        if (cur && cur.pid === pid) {
          running.delete(id);
          markStatus(id, 'idle');
        }
        try { if (client) client.close(); } catch { /* ignore */ }
      });

      await injectAndOpen(instance, effective, view);

      // 5) 浏览器内出口探测：验证「流量真的走了代理」，而不是只证明代理活着
      const egress = await probeEgressInBrowser(client, {
        url: EGRESS_PROBE_URL,
        timeoutMs: EGRESS_TIMEOUT_MS,
      });
      instance.egress = egress;
      if (egress.ok) {
        log(id, '出口', `${egress.ip} ${egress.countryCode || ''} ${egress.timezone || ''}`);
        if (proxyBound && proxyCheck?.ok && proxyCheck.ip && egress.ip !== proxyCheck.ip) {
          warnings.push(soft('ip', `出口 IP 与代理预检不一致：预检 ${proxyCheck.ip}，浏览器 ${egress.ip}（轮换代理属正常；固定代理则说明流量没走代理）`));
        }
        warnings.push(...checkEgress(effective, egress));
        persistEgress(id, egress);
      } else {
        log(id, 'WARN 出口探测失败', egress.error || '');
        warnings.push(soft('ip', `浏览器出口探测失败：${egress.error || '未知原因'}`));
      }

      // 6) 自检：在环境自己的页面里读回真实指纹，逐项对照声明值。
      //    自检失败只告警，不影响启动（它是证据，不是启动的前置条件）。
      if (SELFCHECK_ON_START) {
        try {
          const report = await runSelfCheck(instance, effective);
          instance.selfcheck = summarize(report);
          if (report.summary.fail > 0) {
            const bad = report.items.filter((i) => i.status === 'fail').map((i) => i.id);
            warnings.push(soft('selfcheck', `自检有 ${bad.length} 项未生效：${bad.join(', ')}（详见 selfcheck 报告）`));
          }
          log(id, '自检', `score=${report.summary.score} pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail}`);
        } catch (e) {
          log(id, 'WARN 自检失败', e.message);
          warnings.push(soft('selfcheck', `自检失败：${e.message}`));
        }
      }

      instance.status = 'running';
      markStatus(id, 'running');
      return toStartData(instance);
    } catch (err) {
      log(id, 'start failed', err.message);
      try { if (client) client.close(); } catch { /* ignore */ }
      running.delete(id);
      markStatus(id, 'idle');
      killProcessTree(pid);
      if (!err.code) err.code = 800003;
      throw err;
    }
  })().finally(() => starting.delete(id));

  starting.set(id, p);
  return p;
}

async function injectAndOpen(instance, profile, view) {
  const client = instance.client;
  const profileId = instance.profile_id;

  /** targetId -> { prep, sessionId } */
  const pageReady = new Map();

  /**
   * worker 注入实况（自检与排障读它，也是「不许说理论上支持」的证据）。
   * 口径：total = 被 auto-attach 接住的非 page target 总数；injected = 注入后 realm 真标记成 worker 的。
   */
  const workerStats = {
    total: 0,
    injected: 0,
    skipped_extension: 0,
    iframes: 0,
    other: 0,
    failed: [],
    last: null,
    /** 按类型分账，自检和排障看这个（injected 总数不够解释「为什么是 4 不是 3」） */
    by_type: {},
  };
  instance.workerStats = workerStats;
  /**
   * 同一个 worker 可能被浏览器层与页面层各接住一次（两个**不同的 sessionId**），
   * 所以按 targetId 去重 —— 按 sessionId 去重会把同一个 worker 数成两个。
   */
  const seenWorkerTargets = new Set();

  const resumeNow = (sessionId, waitingForDebugger) => {
    if (!waitingForDebugger) return;
    client.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
  };

  /**
   * 非 page target 的分流。**page 那条路径一行不动**（P2 跑通的装配 + 空白页重载不碰），
   * 新逻辑只落在这里的 worker / shared_worker / service_worker 分支上。
   */
  function handleNonPageTarget({ sessionId, targetInfo, waitingForDebugger }) {
    const type = String(targetInfo.type || '');
    const url = String(targetInfo.url || '');
    const targetId = String(targetInfo.targetId || '');
    workerStats.total += 1;
    workerStats.by_type[type] = (workerStats.by_type[type] || 0) + 1;

    // iframe 是 DOM 上下文，不是 worker：塞 worker 脚本只会补半套、还多一层痕迹。
    // 本轮不覆盖（P2 起就是放行），只计数，写进已知限制。
    if (type === 'iframe') {
      workerStats.iframes += 1;
      resumeNow(sessionId, waitingForDebugger);
      return;
    }
    if (!WORKER_TARGET_TYPES.has(type)) {
      workerStats.other += 1;
      resumeNow(sessionId, waitingForDebugger);
      return;
    }
    // 扩展自带的 SW 不归我们管：注入它既没必要，还可能把扩展搞坏
    if (/^(chrome-extension|devtools|chrome):/i.test(url)) {
      workerStats.skipped_extension += 1;
      resumeNow(sessionId, waitingForDebugger);
      return;
    }
    // 同一个 target 只注一次；第二次接住时只放行
    if (targetId && seenWorkerTargets.has(targetId)) {
      resumeNow(sessionId, waitingForDebugger);
      return;
    }
    if (targetId) seenWorkerTargets.add(targetId);

    injectWorkerTarget({ sessionId, type, url, waitingForDebugger }).catch((e) => {
      workerStats.failed.push({ type, url: url.slice(0, 120), reason: e.message });
      log(profileId, 'WARN worker 注入异常', type, e.message);
    });
  }

  /**
   * worker 注入的三步顺序（实测得来，反过来就有裸窗口）：
   *   ① 先发 Runtime.evaluate（**不 await**）—— 暂停态里脚本已生效
   *   ② 再 runIfWaitingForDebugger 放行
   *   ③ 最后取结果
   * ServiceWorker 的 evaluate 响应要等 resume 才回来（实测 3s 超时），
   * 但副作用发生在脚本顶层执行之前，所以「先发后放行」不会漏。
   */
  async function injectWorkerTarget({ sessionId, type, url, waitingForDebugger }) {
    const started = Date.now();
    // 末行回显 __fpRealm：注入真跑过才等于 'worker'，这是「真值」而不是「发过就算」
    const expression = buildWorkerInjectionSource(view, { debug: FP_DEBUG }) + '\n;(self.__fpRealm || null)';
    const pending = client
      .send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false }, sessionId)
      .then((r) => ({ ok: true, r }), (e) => ({ ok: false, error: e.message }));

    resumeNow(sessionId, waitingForDebugger);

    const res = await withTimeout(pending, WORKER_INJECT_TIMEOUT_MS, 'worker 注入超时（未收到 evaluate 结果）');
    const ms = Date.now() - started;
    const realm = res.ok ? res.r?.result?.value : null;
    const exc = res.ok && res.r?.exceptionDetails
      ? String(res.r.exceptionDetails.text || res.r.exceptionDetails.exception?.description || 'exception')
      : null;

    if (realm === 'worker') {
      workerStats.injected += 1;
      workerStats.last = { type, url: url.slice(0, 120), ms };
      log(profileId, 'worker 注入', type, `${ms}ms`, url.slice(0, 80));
    } else {
      const reason = exc || (res.ok ? `realm 未标记（值=${JSON.stringify(realm)}）` : res.error);
      workerStats.failed.push({ type, url: url.slice(0, 120), reason });
      log(profileId, 'WARN worker 注入失败', type, url.slice(0, 80), reason);
    }
  }

  // 所有新页面（我们建的、用户 Ctrl+T 建的、页面自己 window.open 的）都在「暂停态」接住，
  // 装配完再放行 —— 否则运行中手动开新标签，指纹就裸奔了。
  client.on('Target.attachedToTarget', (params) => {
    const { sessionId, targetInfo, waitingForDebugger } = params;
    if (targetInfo.type !== 'page') {
      handleNonPageTarget({ sessionId, targetInfo, waitingForDebugger });
      return;
    }
    // 新建标签（我们建的 / 用户 Ctrl+T / window.open）的**首个文档**在 attach 之前就存在，
    // 注册脚本只对下一个文档生效 —— 空白页必须重载一次，否则这张页面上是首帧原始指纹。
    const blank = !targetInfo.url || targetInfo.url === 'about:blank' || targetInfo.url.startsWith('chrome://newtab');
    const prep = (async () => {
      try {
        await applyToSession(client, sessionId, profile, view);
      } catch (e) {
        log(profileId, 'session 装配失败', targetInfo.targetId, e.message);
      } finally {
        if (waitingForDebugger) {
          await client.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
        }
      }
      if (blank) scheduleBlankReload(client, sessionId);
    })();
    pageReady.set(targetInfo.targetId, { prep, sessionId });
  });

  await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  client.on('Target.detachedFromTarget', (params) => { pageReady.delete(params.targetId); });

  /**
   * 启动时 Chrome 自带的那张空白页在 setAutoAttach 之前就存在，脚本已经跑过一轮。
   * 对这类「已有页面」：先装配，再重载一次让 addScriptToEvaluateOnNewDocument 生效。
   * 不处理它就是「首帧原始指纹」的漏点。
   */
  async function prepareExistingTabs() {
    const { targetInfos } = await client.send('Target.getTargets').catch(() => ({ targetInfos: [] }));
    for (const t of targetInfos.filter((x) => x.type === 'page')) {
      const entry = pageReady.get(t.targetId) || await waitFor(() => pageReady.get(t.targetId), 3000);
      if (!entry) continue;
      await entry.prep.catch(() => {});
      if (t.url === 'about:blank' || t.url.startsWith('chrome://newtab')) {
        await client.send('Page.reload', {}, entry.sessionId).catch(() => {});
      }
    }
  }
  await prepareExistingTabs();

  const urls = Array.isArray(profile.open_urls) && profile.open_urls.length ? profile.open_urls : ['about:blank'];
  for (const url of urls) {
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const entry = pageReady.get(targetId) || await waitFor(() => pageReady.get(targetId), 5000);
    if (entry) await entry.prep.catch(() => {});
    if (url && url !== 'about:blank') {
      const sessionId = entry?.sessionId || await sessionForTarget(client, targetId);
      if (sessionId) {
        await client.send('Page.navigate', { url }, sessionId)
          .catch((e) => log(profileId, 'navigate 失败', url, e.message));
      }
    } else if (entry) {
      // 空白页不会再有新文档，补一次重载让注入脚本跑上
      await ensureInjected(client, entry.sessionId);
    }
  }

  /** 内部工具（自检等）：开一张已经装配好指纹的页面 */
  instance.openPage = async (url = 'about:blank', { timeoutMs = 8000 } = {}) => {
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const entry = pageReady.get(targetId) || await waitFor(() => pageReady.get(targetId), timeoutMs);
    if (!entry) throw new Error('新页面没有被 auto-attach 接住');
    await entry.prep.catch(() => {});
    // 首个 about:blank 文档早于脚本注册，先确认注入真的生效，再决定要不要导航
    await ensureInjected(client, entry.sessionId);
    if (url && url !== 'about:blank') {
      await client.send('Page.navigate', { url }, entry.sessionId)
        .catch((e) => log(profileId, 'navigate 失败', url, e.message));
    }
    return { targetId, sessionId: entry.sessionId };
  };
  instance.closePage = async (targetId) => {
    try { await client.send('Target.closeTarget', { targetId }); } catch { /* 已关闭 */ }
  };
}

/**
 * 确认这张页面的「当前文档」真跑过注入；没有就重载一次等新文档。
 * 注意重载会丢掉页面里的状态，只对空白页/我们自己的内部页用。
 */
async function ensureInjected(client, sessionId) {
  const r = await client.send('Runtime.evaluate', {
    expression: 'window.__fpInstalled === true',
    returnByValue: true,
  }, sessionId).catch(() => null);
  if (r?.result?.value === true) return true;
  await reloadSession(client, sessionId).catch(() => {});
  return false;
}

/**
 * 空白页补一次重载：addScriptToEvaluateOnNewDocument 只对「下一个文档」生效，
 * 而新建标签的首个文档在 attach 之前就存在。
 * 但不能无脑 reload —— 出口探测 / open_urls 可能正在这张页上导航，抢过去会把它们的导航顶掉。
 * 所以延迟一拍，确认它还停在空白页才重载。
 */
function scheduleBlankReload(client, sessionId, delayMs = 400) {
  const timer = setTimeout(async () => {
    try {
      const r = await client.send('Runtime.evaluate', {
        expression: 'location.href',
        returnByValue: true,
      }, sessionId);
      const href = String(r?.result?.value ?? '');
      if (href === '' || href === 'about:blank' || href === 'chrome://newtab/') {
        await reloadSession(client, sessionId).catch(() => {});
      }
    } catch { /* 页面已关或会话已断 */ }
  }, delayMs);
  timer.unref?.();
}

/**
 * 重载一张页面并等 load：让 addScriptToEvaluateOnNewDocument 真正跑一遍。
 * about:blank 的初始文档早于脚本注册，只有新文档才会执行注入。
 */
async function reloadSession(client, sessionId, timeoutMs = 6000) {
  const loaded = new Promise((resolve) => {
    const off = client.on('Page.loadEventFired', (params, sid) => { if (sid === sessionId) { off(); resolve(); } });
    setTimeout(() => { off(); resolve(); }, timeoutMs);
  });
  await client.send('Page.reload', {}, sessionId).catch(() => {});
  await loaded;
  // load 之后脚本可能还在跑最后几行（注入是同步的，但给一帧余量）
  await new Promise((r) => setTimeout(r, 30));
}

async function waitFor(fn, timeoutMs = 5000, step = 60) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  return null;
}

/** 给 Promise 套一层超时：超时返回失败对象而不是抛出，调用方统一记账 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: label }), ms);
    timer.unref?.();
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
  });
}

async function sessionForTarget(client, targetId) {
  try {
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  } catch {
    return null;
  }
}

/** 单个页面会话的指纹装配：先注入脚本，再打浏览器原生覆盖 */
async function applyToSession(client, sessionId, profile, view) {
  const s = sessionId;
  await client.send('Page.enable', {}, s);
  // 页面会话层再挂一次 auto-attach：**专用 worker 只在页面层被接住**（浏览器层接不住，实测）。
  // waitForDebuggerOnStart 让 worker 停在首行之前，注入完再放行 —— 宁可多几毫秒，不留裸窗口。
  await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, s)
    .catch((e) => log(instance_profile(profile), 'worker auto-attach 失败', e.message));
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: buildInjectionSource(view, { debug: FP_DEBUG }) }, s);

  if (view.ua) {
    await client.send('Emulation.setUserAgentOverride', {
      userAgent: view.ua,
      acceptLanguage: (view.language || []).join(','),
      platform: view.platform || 'Win32',
      userAgentMetadata: view.ua_metadata || undefined,
    }, s).catch((e) => log(instance_profile(profile), 'UA 覆写失败', e.message));
  }
  if (view.timezone) await client.send('Emulation.setTimezoneOverride', { timezoneId: view.timezone }, s).catch(() => {});
  if (view.locale) await client.send('Emulation.setLocaleOverride', { locale: view.locale }, s).catch(() => {});
  if (view.screen) {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: view.screen.width,
      height: view.screen.height,
      deviceScaleFactor: view.device_scale_factor || 1,
      mobile: false,
      screenWidth: view.screen.width,
      screenHeight: view.screen.height,
    }, s).catch(() => {});
  }

  const proxy = profile.user_proxy_config || profile.proxy_config;
  if (proxy && proxy.username && proxy.host) {
    await setupProxyAuth(client, s, proxy).catch((e) => log(profile.id, 'proxy auth 挂载失败', e.message));
  }
}

function instance_profile(p) {
  return p?.id || p?.profile_id;
}

async function setupProxyAuth(client, sessionId, proxy) {
  await client.send('Fetch.enable', { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] }, sessionId);
  client.on('Fetch.requestPaused', (params, sid) => {
    if (sid !== sessionId) return;
    client.send('Fetch.continueRequest', { requestId: params.requestId }, sid).catch(() => {});
  });
  client.on('Fetch.authRequired', (params, sid) => {
    if (sid !== sessionId) return;
    client.send('Fetch.continueWithAuth', {
      requestId: params.requestId,
      authChallengeResponse: { response: 'ProvideCredentials', username: proxy.username, password: proxy.password || '' },
    }, sid).catch(() => {});
  });
}

export async function stopProfile(profileId) {
  const inst = running.get(profileId);
  if (!inst) return { profile_id: profileId, stopped: false, reason: 'not running' };
  log(profileId, 'stop');
  try {
    // 先让 Chrome 优雅退出（cookie 落盘），再兜底杀进程树
    await inst.client.send('Browser.close').catch(() => {});
  } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 400));
  killProcessTree(inst.pid);
  try { inst.client.close(); } catch { /* ignore */ }
  running.delete(profileId);
  markStatus(profileId, 'idle');
  return { profile_id: profileId, stopped: true };
}

export async function stopAll() {
  const ids = [...running.keys()];
  for (const id of ids) await stopProfile(id);
  return ids;
}