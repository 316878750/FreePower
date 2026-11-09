import fs from 'node:fs';
import path from 'node:path';
import { PROFILES_DIR, LOG_DIR, START_TIMEOUT_MS } from '../config.js';
import { findChrome, buildArgs, launchChrome, waitForDevToolsPort, killProcessTree } from '../kernel/chrome.js';
import { CdpClient, fetchJson } from '../kernel/cdp.js';
import { buildInjectionSource } from '../kernel/inject.js';
import { fingerprintView } from '../fingerprint/view.js';
import { checkProfile, markStatus } from '../store/profiles.js';

/** profile_id -> instance */
const running = new Map();
/** profile_id -> 启动中的 Promise（防并发重复启动） */
const starting = new Map();

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
 * 关键顺序：页面在「暂停态」被接住 → 装 addScriptToEvaluateOnNewDocument + Emulation 覆盖 → 放行，
 * 保证页面第一条脚本执行前指纹就位，不给检测留「首帧原始值」的窗口。
 */
export async function startProfile(profile) {
  const id = profile.id || profile.profile_id;

  const inst = running.get(id);
  if (inst) return toStartData(inst, { alreadyRunning: true });
  if (starting.has(id)) {
    await starting.get(id).catch(() => {});
    const done = running.get(id);
    if (done) return toStartData(done, { alreadyRunning: true });
  }

  const p = (async () => {
    // 1) 启动前一致性校验：一条对不上就不让起，避免「带着已知冲突的指纹出门」
    const check = checkProfile(profile);
    if (!check.ok) {
      const err = new Error(check.errors.map((e) => `${e.field}: ${e.message}`).join('; '));
      err.code = 800005;
      err.errors = check.errors;
      throw err;
    }

    const chrome = findChrome();
    if (!chrome) {
      const err = new Error('找不到内核：设置 FREEPOWER_CHROME，或把内核放到 data/kernels/<version>/ 下');
      err.code = 800003;
      throw err;
    }

    const view = fingerprintView(profile);
    const udd = userDataDirFor(profile);
    fs.mkdirSync(udd, { recursive: true });

    const proxy = profile.user_proxy_config || profile.proxy_config || null;
    const args = buildArgs(profile, { userDataDir: udd, proxy });
    log(id, 'launch', chrome.path, chrome.version, args.join(' '));

    const child = launchChrome(chrome.path, args);
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

      // 内核版本漂移检查：UA 声明的版本必须等于真实内核版本
      const declared = profile.client_hints?.ua_full_version;
      if (declared && realVersion && declared !== realVersion) {
        log(id, `WARN 内核/UA 版本漂移：声明 ${declared}，实际 ${realVersion}`);
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

      await injectAndOpen(instance, profile, view);

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

  /** targetId -> 装配完成的 Promise */
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
    pageReady.set(targetInfo.targetId, prep);
  });

  await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

  const urls = Array.isArray(profile.open_urls) && profile.open_urls.length ? profile.open_urls : ['about:blank'];
  for (const url of urls) {
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const prep = pageReady.get(targetId) || await waitFor(() => pageReady.get(targetId), 5000);
    if (prep) await prep.catch(() => {});
    if (url && url !== 'about:blank') {
      const sessionId = await sessionForTarget(client, targetId);
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