import fs from 'node:fs';
import path from 'node:path';
import { PROFILES_DIR, LOG_DIR, START_TIMEOUT_MS } from '../config.js';
import { findChrome, buildArgs, launchChrome, waitForDevToolsPort, killProcessTree } from '../kernel/chrome.js';
import { CdpClient, fetchJson } from '../kernel/cdp.js';
import { buildInjectionSource } from '../kernel/inject.js';

/** 运行中实例：profile_id -> instance */
const running = new Map();

export function listRunning() {
  return [...running.values()].map((i) => ({
    profile_id: i.profile_id,
    pid: i.pid,
    debug_port: String(i.port),                                   // 对手契约：字符串
    ws: { puppeteer: i.wsUrl, selenium: `127.0.0.1:${i.port}` },   // selenium 只放 host:port
    status: i.status,
    started_at: i.started_at,
  }));
}

export function getRunning(profileId) {
  return running.get(profileId) || null;
}

function userDataDirFor(profileId) {
  return path.join(PROFILES_DIR, profileId, 'userdata');
}

function log(profileId, ...parts) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`;
    fs.appendFileSync(path.join(LOG_DIR, `${profileId}.log`), line);
  } catch { /* 日志失败不影响启动 */ }
}

/**
 * 启动环境。
 * 关键顺序：页面在「暂停态」被接住 -> 装 addScriptToEvaluateOnNewDocument + Emulation 覆盖 -> 放行。
 * 保证页面第一条脚本执行前指纹就已生效，不给检测方留「首帧原始值」的窗口。
 */
export async function startProfile(profile) {
  const id = profile.profile_id;
  if (running.has(id)) {
    const inst = running.get(id);
    return {
      profile_id: id,
      pid: inst.pid,
      debug_port: String(inst.port),
      ws: { puppeteer: inst.wsUrl, selenium: `127.0.0.1:${inst.port}` },
      status: inst.status,
      already_running: true,
    };
  }

  const chrome = findChrome();
  if (!chrome) throw new Error('找不到 Chrome 内核：设置 FREEPOWER_CHROME，或把内核放到 data/kernels/<version>/ 下');

  const fp = profile.fingerprint_config || {};
  const udd = userDataDirFor(id);
  fs.mkdirSync(udd, { recursive: true });

  const args = buildArgs(profile, { userDataDir: udd, proxy: profile.proxy_config });
  log(id, 'launch', chrome.path, chrome.version, args.join(' '));

  const child = launchChrome(chrome.path, args);
  const pid = child.pid;

  let client = null;
  try {
    const { port, browserPath } = await waitForDevToolsPort(udd, { timeoutMs: START_TIMEOUT_MS });
    const fallbackWs = `ws://127.0.0.1:${port}${browserPath}`;

    // 确认端口上确实是我们的实例（顺便拿真实内核版本）
    const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    const reportedWs = version.webSocketDebuggerUrl || fallbackWs;

    client = await CdpClient.connect(reportedWs);
    const bv = await client.send('Browser.getVersion');
    const realVersion = bv.product.replace(/^.*\//, '');
    if (fp.kernel && fp.kernel.major && String(realVersion).split('.')[0] !== String(fp.kernel.major)) {
      log(id, `WARN 内核版本漂移：指纹声明 ${fp.kernel.major}，实际 ${realVersion}`);
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

    child.once('exit', (code) => {
      log(id, 'exit', String(code));
      const cur = running.get(id);
      if (cur && cur.pid === pid) running.delete(id);
      try { if (client) client.close(); } catch { /* ignore */ }
    });

    await injectAndOpen(instance, profile, fp);

    instance.status = 'running';
    return {
      profile_id: id,
      pid,
      debug_port: String(port),
      ws: { puppeteer: reportedWs, selenium: `127.0.0.1:${port}` },
      status: 'running',
      real_version: realVersion,
      already_running: false,
    };
  } catch (err) {
    log(id, 'start failed', err.message);
    try { if (client) client.close(); } catch { /* ignore */ }
    killProcessTree(pid);
    running.delete(id);
    throw err;
  }
}

async function injectAndOpen(instance, profile, fp) {
  const client = instance.client;

  /** targetId -> 该页装配完成的 Promise（注入 + 覆盖都装完才算 ready） */
  const pageReady = new Map();

  // 所有新页面（我们建的、用户 Ctrl+T 建的、页面自己 window.open 的）都在「暂停态」接住，
  // 装配完再放行 —— 否则用户运行中手动开新标签，指纹就裸奔了。
  client.on('Target.attachedToTarget', (params) => {
    const { sessionId, targetInfo, waitingForDebugger } = params;
    if (targetInfo.type !== 'page') {
      if (waitingForDebugger) client.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      return;
    }
    const p = (async () => {
      try {
        await applyToSession(client, sessionId, profile, fp);
      } catch (e) {
        log(profile.profile_id, 'session 装配失败', targetInfo.targetId, e.message);
      } finally {
        if (waitingForDebugger) await client.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      }
    })();
    pageReady.set(targetInfo.targetId, p);
  });

  await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

  const urls = Array.isArray(profile.open_urls) && profile.open_urls.length ? profile.open_urls : ['about:blank'];

  for (let i = 0; i < urls.length; i++) {
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const prep = pageReady.get(targetId) || await waitFor(() => pageReady.get(targetId), 5000);
    if (prep) await prep.catch(() => {});

    if (urls[i] && urls[i] !== 'about:blank') {
      const sessionId = await sessionForTarget(client, targetId);
      if (sessionId) {
        await client.send('Page.navigate', { url: urls[i] }, sessionId)
          .catch((e) => log(profile.profile_id, 'navigate 失败', urls[i], e.message));
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
async function applyToSession(client, sessionId, profile, fp) {
  const s = sessionId;
  const source = buildInjectionSource(fp, { debug: false });
  await client.send('Page.enable', {}, s);
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source }, s);

  if (fp.ua) {
    await client.send('Emulation.setUserAgentOverride', {
      userAgent: fp.ua,
      acceptLanguage: (fp.language || []).join(','),
      platform: fp.platform || 'Win32',
      userAgentMetadata: fp.ua_metadata || undefined,
    }, s);
  }
  if (fp.timezone) await client.send('Emulation.setTimezoneOverride', { timezoneId: fp.timezone }, s).catch(() => {});
  if (fp.locale) await client.send('Emulation.setLocaleOverride', { locale: fp.locale }, s).catch(() => {});
  if (fp.screen) {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: fp.screen.width,
      height: fp.screen.height,
      deviceScaleFactor: fp.device_scale_factor || 1,
      mobile: false,
      screenWidth: fp.screen.width,
      screenHeight: fp.screen.height,
    }, s).catch(() => {});
  }

  const proxy = profile.proxy_config;
  if (proxy && proxy.username && proxy.host) {
    await setupProxyAuth(client, s, proxy).catch((e) => log(profile.profile_id, 'proxy auth 挂载失败', e.message));
  }
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
      authChallengeResponse: {
        response: 'ProvideCredentials',
        username: proxy.username,
        password: proxy.password || '',
      },
    }, sid).catch(() => {});
  });
}

export async function stopProfile(profileId) {
  const inst = running.get(profileId);
  if (!inst) return { profile_id: profileId, stopped: false, reason: 'not running' };
  log(profileId, 'stop');
  try {
    // 先让 Chrome 自己优雅退出（保留 cookie 落盘），再兜底杀进程树
    await inst.client.send('Browser.close').catch(() => {});
  } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 400));
  killProcessTree(inst.pid);
  try { inst.client.close(); } catch { /* ignore */ }
  running.delete(profileId);
  return { profile_id: profileId, stopped: true };
}

export async function stopAll() {
  const ids = [...running.keys()];
  for (const id of ids) await stopProfile(id);
  return ids;
}
