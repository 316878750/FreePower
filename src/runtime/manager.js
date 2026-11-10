import fs from 'node:fs';
import path from 'node:path';
import {
  PROFILES_DIR, LOG_DIR, START_TIMEOUT_MS,
  EGRESS_PROBE_URL, PROXY_PROBE_TIMEOUT_MS, EGRESS_TIMEOUT_MS, UA_AUTOALIGN,
} from '../config.js';
import { findChrome, buildArgs, launchChrome, waitForDevToolsPort, killProcessTree, rememberVersion } from '../kernel/chrome.js';
import { CdpClient, fetchJson } from '../kernel/cdp.js';
import { buildInjectionSource } from '../kernel/inject.js';
import { alignProfileToKernel } from '../kernel/version.js';
import { fingerprintView } from '../fingerprint/view.js';
import { checkProfile, markStatus, applyProfileFields, persistEgress } from '../store/profiles.js';
import { checkProxy, hasProxy } from '../proxy/probe.js';
import { probeEgressInBrowser } from '../proxy/egress.js';
import { checkEgress } from '../../packages/profile/src/validate.js';

/** profile_id -> instance */
const running = new Map();
/** profile_id -> 启动中的 Promise（防并发重复启动） */
const starting = new Map();

const soft = (field, message) => ({ field, message, severity: 'soft' });

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

  // 所有新页面（我们建的、用户 Ctrl+T 建的、页面自己 window.open 的）都在「暂停态」接住，
  // 装配完再放行 —— 否则运行中手动开新标签，指纹就裸奔了。
  client.on('Target.attachedToTarget', (params) => {
    const { sessionId, targetInfo, waitingForDebugger } = params;
    if (targetInfo.type !== 'page') {
      if (waitingForDebugger) client.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      return;
    }
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
    })();
    pageReady.set(targetInfo.targetId, { prep, sessionId });
  });

  await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

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
    }
  }
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
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: buildInjectionSource(view) }, s);

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