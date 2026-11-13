import fs from 'node:fs';
import path from 'node:path';
import {
  PROFILES_DIR, LOG_DIR, START_TIMEOUT_MS,
  EGRESS_PROBE_URL, PROXY_PROBE_TIMEOUT_MS, EGRESS_TIMEOUT_MS, UA_AUTOALIGN, SELFCHECK_ON_START, FP_DEBUG,
} from '../config.js';
import { findChrome, buildArgs, launchChrome, waitForDevToolsPort, killProcessTree, rememberVersion } from '../kernel/chrome.js';
import { CdpClient, fetchJson } from '../kernel/cdp.js';
import { buildInjectionSource, buildWorkerInjectionSource } from '../kernel/inject.js';
import { compileNetRules, decideRequest } from '../kernel/net-rules.js';
import { alignProfileToKernel } from '../kernel/version.js';
import { fingerprintView, geoPolicy } from '../fingerprint/view.js';
import { ensureNoiseSeeds } from '../fingerprint/seeds.js';
import { checkProfile, markStatus, applyProfileFields, persistEgress } from '../store/profiles.js';
import { checkProxy, hasProxy, normalizeProxyConfig } from '../proxy/probe.js';
import { resolveChain, startChain } from '../proxy/chain.js';
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
 * @param {{force?:boolean, systemProxy?:object}} opts force=1 时允许越过硬冲突（软冲突本来就只告警）；
 *   `systemProxy` 只给测试用：显式注入本机系统代理的注册表值（**测试不改用户注册表**）
 */
export async function startProfile(profile, { force = false, systemProxy = null } = {}) {
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
    let proxyBound = hasProxy(proxy);
    /** 真正交给内核的代理：单跳就是它本身，多级链则换成本地链监听（127.0.0.1:<port>） */
    let effectiveProxy = proxy;
    /** 多级链的本地监听；失败/停止时必须 close，否则反复起停会漏端口 */
    let chainServer = null;
    let proxyCheck = null;

    // 2.1) 多级代理链：hop0 = 本机 **Windows 系统代理**，hop1 = 环境自己的代理（对手也是这样两跳拼出来的）
    //      - 本机没配系统代理 → **塌成单跳、正常启动**（不算失败，误报 800003 才是错）
    //      - 确实是两跳 → 浏览器只看到本地回环监听，链在浏览器外由我们逐跳转发
    const chain = resolveChain(profile, { systemProxy });
    if (chain.active && !chain.ok) {
      // PAC / 组不成链 → 拒绝启动，**绝不静默降级成单跳或直连**
      const err = new Error(chain.reason === 'pac_unsupported'
        ? chain.message
        : `多级代理链不可用，拒绝启动（fail-closed）：${chain.message}`);
      err.code = 800003;
      err.reason = chain.reason;
      throw err;
    }
    if (chain.mode === 'chain') {
      chainServer = await startChain(chain.hops);
      effectiveProxy = { type: 'http', host: '127.0.0.1', port: chainServer.port, username: '', password: '' };
      proxyBound = true;
      warnings.push(soft('is_multi_level_proxy',
        `多级代理链：hop0=系统代理 ${chain.hops[0].host}:${chain.hops[0].port}，hop1=环境代理 ${chain.hops[1].host}:${chain.hops[1].port}；`
        + `内核只看到 127.0.0.1:${chainServer.port}（链由 FreePower 在浏览器外转发，内核没有 --protected-staticconfig 通道）`));
      log(id, '代理链', `hops=${chain.hops.length} local_port=${chainServer.port}`);
    } else if (chain.mode === 'single') {
      // 只找到一跳：直接用那条代理（与单代理完全等价 —— 认证仍走 Fetch.authRequired 老路径）
      effectiveProxy = chain.hops[0];
      proxyBound = true;
      warnings.push(soft('is_multi_level_proxy',
        `多级代理链：只找到 1 跳（${chain.hops[0].source === 'system' ? '只有系统代理，环境未配代理' : '只有环境代理，本机未启用系统代理'}）→ 与单跳等价`));
      log(id, '代理链', `collapsed hops=1 source=${chain.hops[0].source}`);
    } else if (chain.active) {
      warnings.push(soft('is_multi_level_proxy', '多级代理链：本机未启用系统代理、环境也没有代理 → 与不设代理等价'));
    }

    if (proxyBound) {
      if (String(profile.bypass_proxy_check) === '1') {
        warnings.push(soft('bypass_proxy_check', '已跳过代理预检（bypass_proxy_check=1）：代理若失效就不会有兜底，请自行确认'));
        log(id, 'WARN 跳过代理预检（bypass_proxy_check=1）');
      } else {
        // 链式环境下这就是「整条链 + 目标」的端到端探测：探通即每一跳都通
        proxyCheck = await checkProxy(effectiveProxy, { url: EGRESS_PROBE_URL, timeoutMs: PROXY_PROBE_TIMEOUT_MS });
        if (!proxyCheck.ok) {
          const hop = chainServer && chainServer.lastError ? chainServer.lastError.hop : undefined;
          if (chainServer) { await chainServer.close().catch(() => {}); chainServer = null; }
          log(id, '代理预检失败，拒绝启动', proxyCheck.error);
          const err = new Error(`代理不可用，已阻止启动（fail-closed）：${proxyCheck.error}`);
          err.code = 800003;
          // 链式：那一跳是「连不上 / 认证失败」→ proxy_chain_hop_failed（带 hop 下标）；
          // 单代理：保持原来的 proxy_unreachable
          err.reason = chain.mode === 'chain' ? 'proxy_chain_hop_failed' : 'proxy_unreachable';
          err.proxy_check = proxyCheck;
          if (Number.isInteger(hop)) err.failed_hop = hop;
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
    let built;
    let child;
    let pid;
    // 链监听已经起来了：下面这段任何一步抛错都要把它关掉，否则漏端口
    try {
      fs.mkdirSync(udd, { recursive: true });
      // 上一次运行留下的 DevToolsActivePort 会让本轮读到旧端口 → 连到一个已经死掉的端口。
      // 必须在新内核写文件之前删掉（重启同一环境的常见坑）。
      try { fs.rmSync(path.join(udd, 'DevToolsActivePort'), { force: true }); } catch { /* ignore */ }

      built = buildArgs(effective, {
        userDataDir: udd,
        // 多级链在这里已经换成本地回环监听：内核只认 --proxy-server=http://127.0.0.1:<port>
        proxy: effectiveProxy,
        proxyBound,
        userArgs: effective.launch_args,
      });
      warnings.push(...built.warnings);
      for (const r of built.rejected) {
        warnings.push(soft('launch_args', `参数被拒绝：${r.arg} —— ${r.reason}`));
      }
      log(id, 'launch', chrome.path, chrome.version, built.args.join(' '));

      child = launchChrome(chrome.path, built.args);
      pid = child.pid;
    } catch (e) {
      if (chainServer) { await chainServer.close().catch(() => {}); chainServer = null; }
      throw e;
    }
    let client = null;

    try {
      const { port, browserPath } = await waitForDevToolsPort(udd, { timeoutMs: START_TIMEOUT_MS, child });
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

      // P2 · 位置权限（浏览器级，设一次）：allow=授权 / ask=保持 prompt（不碰）/ block=显式拒绝。
      // 坐标覆盖是 target 级的，挂在 applyToSession 里 —— 两处合起来才是 `location` 的完整语义。
      const geoMode = geoPolicy(effective);
      if (geoMode.permission === 'granted') {
        await client.send('Browser.grantPermissions', { permissions: ['geolocation'] })
          .catch((e) => warnings.push(soft('location', `授权定位失败：${e.message}`)));
      } else if (geoMode.permission === 'denied') {
        await client.send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'denied' })
          .catch((e) => warnings.push(soft('location', `拒绝定位失败：${e.message}`)));
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
        // 多级链的本地监听：`stop` 与「内核自己退出」两条路径都要 close（见 stopProfile / exit 回调）
        chain: chainServer,
        // 'off' | 'none' | 'single' | 'chain'：只有 'chain' 才关掉 Fetch 的代理认证路径（见 applyToSession）
        chain_mode: chain.mode,
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
        if (chainServer) { chainServer.close().catch(() => {}); chainServer = null; }
        try { if (client) client.close(); } catch { /* ignore */ }
      });

      await injectAndOpen(instance, effective, view);

      // 5) 浏览器内出口探测：验证「流量真的走了代理」，而不是只证明代理活着
      const egress = await probeEgressInBrowser(client, {
        url: EGRESS_PROBE_URL,
        timeoutMs: EGRESS_TIMEOUT_MS,
        // 探测页是它自己建、自己关的：显式告诉 injectAndOpen 的 blank-reload watcher 别碰它。
        // 不加这一句就是「探测页刚 navigate，watcher 400ms 后 reload 把它顶成 ERR_ABORTED」。
        onTarget: (targetId) => instance.exemptBlankReload(targetId),
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
        // 失败时把诊断字段一起带出来：代理侧看到隧道建成、我们却读到空 body 时，
        // 需要 readyState / finalUrl / target 才能区分「没加载」和「读错 target」
        const diag = egress.readyState || egress.finalUrl
          ? `（readyState=${egress.readyState || '?'} finalUrl=${egress.finalUrl || '?'} target=${String(egress.targetId || '?').slice(0, 8)}）`
          : '';
        log(id, 'WARN 出口探测失败', `${egress.error || ''}${diag}`);
        warnings.push(soft('ip', `浏览器出口探测失败：${egress.error || '未知原因'}${diag}`));
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
      // 链监听一定要关：失败路径漏端口，几轮反复起停之后才会炸，最难查
      if (chainServer) { await chainServer.close().catch(() => {}); chainServer = null; }
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
  // 同一张页面会被两个会话各判一次（外部自动化自己再 attach 一次）→ 补加载只做一次，
  // 否则一张页会被补两遍（实测文档请求从 2 次变 3 次）。
  const repairedTargets = new Set();

  /* ============================================================================
   * 导航自掐（net::ERR_ABORTED）：空白页补 reload 时，不许顶掉**正在飞**的导航
   * ============================================================================
   *
   * 真实现象（2026-11-11 A/B 实测，安装包 0.3.0）：CDP 新建空白目标后立刻 navigate
   * 一个非 HTML 地址（JSON/API），结果 `net::ERR_ABORTED`、页面停在 about:blank；
   * 同一个 URL 用环境自己那张既有页导航就正常，裸内核也正常 —— 是我们自己掐的。
   *
   * 机理：新建标签的首个文档早于 addScriptToEvaluateOnNewDocument，所以 attach 之后
   * 要补一次 Page.reload（否则首帧是原始指纹）。原来的写法是「400ms 后读 location.href，
   * 还是 about:blank 就 reload」——慢一点的导航在 400ms 时**还没 commit**，href 仍是
   * about:blank，于是 reload 把在飞的导航顶掉。example.com 够快所以看起来「只有 JSON 打不开」。
   *
   * 修法：改用 CDP 事件判「这张页有人在导航」，不用定时器猜：
   *   - `Page.frameRequestedNavigation` / `Page.frameStartedLoading` → 打「在飞」标记；
   *   - `Page.frameNavigated` 落到非 about:blank → 清标记（说明导航真落地了）。
   * 另外给「我们自己建、自己会关」的目标（出口探测页）一个**显式豁免**，
   * 不靠「看起来是空白」去推断。
   *
   * 明确不做的事：这条路径上**永不用 `Page.stopLoading`** —— 那会把别人的导航掐死，
   * 比 reload 更狠，而且拿不到任何可诊断的错误。
   */
  /** 有人正在导航的 session */
  const navBusy = new Set();
  /** 豁免 blank-reload 的 targetId（我们自己建的目标：出口探测页等） */
  const blankReloadExempt = new Set();
  /** 因为「有人在导航」而暂时跳过补注入的 session：等导航落地后再确认一次 */
  const pendingInjectCheck = new Set();

  /** 导航落地之后确认注入是否真跑过；没跑过才补一次 reload（此刻已经没有在飞的导航可顶） */
  async function verifyInjectedAfterNav(sessionId) {
    try {
      const r = await client.send('Runtime.evaluate', {
        expression: 'window.__fpInstalled === true',
        returnByValue: true,
      }, sessionId);
      if (r?.result?.value === true) return true;
      await reloadSession(client, sessionId).catch(() => {});
      return false;
    } catch { return false; }
  }

  client.on('Page.frameRequestedNavigation', (params, sid) => { if (sid) navBusy.add(sid); });
  client.on('Page.frameStartedLoading', (params, sid) => { if (sid) navBusy.add(sid); });
  client.on('Page.frameNavigated', (params, sid) => {
    if (!sid) return;
    const url = String(params?.frame?.url || '');
    // 落到 about:blank 不算「落地」：reload 也会先报一次 about:blank，这时候清标记会让
    // 后面那一下 reload 直接顶掉在飞的导航。只有真实 URL commit 才清。
    if (!url || url === 'about:blank') return;
    navBusy.delete(sid);
    // 这一拍之前有张空白页因为「有人在导航」被放过了：现在导航落地，补一次注入确认。
    // 不是无脑 reload —— 注入真跑过（脚本注册早于这次导航）就什么都不做。
    if (pendingInjectCheck.has(sid)) {
      pendingInjectCheck.delete(sid);
      verifyInjectedAfterNav(sid).catch(() => {});
    }
  });

  /**
   * 空白页补一次 reload（见上面那段注释）。**只对「确实还停在空白页、且没人正在导航」的页生效。**
   * 有人在导航时不 reload，改为登记一次「导航落地后再确认注入」，两头都不牺牲：
   * 既不掐掉在飞的导航，也不让「脚本注册晚于导航」的页面裸着指纹。
   * @param {{ targetId?: string, sessionId: string, delayMs?: number }} opt
   */
  function scheduleBlankReload({ targetId = null, sessionId, delayMs = 400 }) {
    const timer = setTimeout(async () => {
      try {
        if (targetId && blankReloadExempt.has(targetId)) return;   // 我们自己建的目标：完全不碰
        if (navBusy.has(sessionId)) {                              // 有人在导航：让开，落地后再确认
          pendingInjectCheck.add(sessionId);
          return;
        }
        const r = await client.send('Runtime.evaluate', {
          expression: 'location.href',
          returnByValue: true,
        }, sessionId);
        const href = String(r?.result?.value ?? '');
        if (href !== '' && href !== 'about:blank' && href !== 'chrome://newtab/') return;
        // 读 href 这一拍里也可能刚好有人开始导航 —— 再让一次，宁可这张空白页晚点补注入，
        // 也不要把别人的导航掐掉（漏注入是可修的，ERR_ABORTED 是用户可见的故障）
        if (navBusy.has(sessionId)) {
          pendingInjectCheck.add(sessionId);
          return;
        }
        await reloadSession(client, sessionId).catch(() => {});
      } catch { /* 页面已关或会话已断 */ }
    }, delayMs);
    timer.unref?.();
  }

  /**
   * 让某个 target 免于 blank-reload（出口探测页自己会导航、自己会关）。
   * 必须在它导航之前调用；调用方是 probeEgressInBrowser 的 onTarget 回调。
   */
  instance.exemptBlankReload = (targetId) => {
    if (targetId) blankReloadExempt.add(targetId);
  };

  /**
   * worker 注入实况（自检与排障读它，也是「不许说理论上支持」的证据）。
   * 口径：total = 被 auto-attach 接住的非 page target 总数；injected = 注入后 realm 真标记成 worker 的。
   */
  const workerStats = {
    total: 0,
    injected: 0,
    skipped_extension: 0,
    /** Chrome 自己的 UI target（type='browser_ui'）：不属于页面，跳过并单独计数 */
    browser_ui: 0,
    iframes: 0,
    /** AudioWorklet 也是独立 target（type='worklet'），但按设计不注入，单独记账 */
    worklets: 0,
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
    // Chrome 自己的 UI target（type='browser_ui'）不是页面起的 worker。
    // 把它计进 total/other，刚启动的环境就会显示 total:1 other:1 —— 看着像
    // 「接住了一个不知道是什么的 target」，实际什么都没漏。显式跳过、单独计数。
    if (type === 'browser_ui') {
      workerStats.browser_ui += 1;
      resumeNow(sessionId, waitingForDebugger);
      return;
    }
    workerStats.total += 1;
    workerStats.by_type[type] = (workerStats.by_type[type] || 0) + 1;

    // iframe 是 DOM 上下文，不是 worker：塞 worker 脚本只会补半套、还多一层痕迹。
    // 本轮不覆盖（P2 起就是放行），只计数，写进已知限制。
    if (type === 'iframe') {
      workerStats.iframes += 1;
      resumeNow(sessionId, waitingForDebugger);
      return;
    }
    // AudioWorklet 有独立 target（type='worklet'），但里面没有可注入的指纹表面
    // （见自检 audio_worklet 项与 README），按设计不注入，只放行并单独计数 ——
    // 不能让它掉进 other 里变成「不知道怎么就没处理」。
    if (type === 'worklet') {
      workerStats.worklets += 1;
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
   * 给 worker 会话自己也挂一次 auto-attach —— 这是「嵌套 worker」的唯一接法。
   *
   * worker 里再 `new Worker` 出来的子 target 只挂到**父 worker 的会话**下，页面层和
   * 浏览器层的 auto-attach 都够不着；不挂这一层，嵌套 worker 就裸跑（实测泄漏真实
   * hardwareConcurrency，跟主帧的伪装值当场自相矛盾）。每层都挂，自然覆盖任意深度，
   * 所以不设递归深度上限。
   *
   * 必须**先于** evaluate（也就先于 resume）：否则父 worker 顶层已经跑完，子 worker
   * 早建出来了，挂晚了接不住。代价是每层多一次本地 CDP 往返。
   */
  async function armChildAutoAttach(sessionId, type) {
    try {
      await client.send('Target.setAutoAttach', {
        autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      }, sessionId);
    } catch (e) {
      // 挂不上就要如实记账：这个 worker 的嵌套层本轮没覆盖，别当成已支持
      workerStats.failed.push({ type: `${type}#child-auto-attach`, url: '', reason: e.message });
      log(profileId, 'WARN worker 子会话 auto-attach 失败', type, e.message);
    }
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
    // 先把自己的子会话也挂上（嵌套 worker 只在这一层接得住），再注入、再放行
    await armChildAutoAttach(sessionId, type);
    /* 核数覆写对 worker 要单独设一次：page session 上的覆写**不传播**进 worker（实测 page=2 / worker=32），
     * 但设在 worker 自己的 session 上是生效的（实测：设 3 → resume 之前读到的就是 3）。
     * 必须在 evaluate 之前 —— 否则注入脚本里那条「值不对才补」的兜底会先于 CDP 判断，白装一层 JS。
     *
     * **只对专用 worker（type='worker'）用 CDP**：实测把这条命令发到 ServiceWorker 的 session 上，
     * 它会把「先发 evaluate 再放行」那条时序拖坏 —— SW 的顶层脚本先跑完，注入才落地
     * （`npm run test:workers` 实测 atTop=null、自检 realm_service 变 fail）。
     * SharedWorker / ServiceWorker 因此只走注入脚本里那条「值不对才补」的 JS 兜底
     * （P11 之后这层兜底的源码也是 [native code]，不再是泄漏）。
     * 再加一层超时：CDP 万一不回，也不许把注入/放行拖死（拖死 = 这个 realm 裸奔）。 */
    if (type === 'worker') {
      const hc = Number(view?.hardware_concurrency);
      if (Number.isInteger(hc) && hc > 0) {
        await withTimeout(
          client.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: hc }, sessionId)
            .catch((e) => { log(profileId, 'WARN hc 覆写失败(worker)', type, e.message); return null; }),
          1000,
          'hc 覆写超时(worker)',
        );
      }
    }
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
        await applyToSession(client, sessionId, profile, view, { proxyAuth: instance.chain_mode !== 'chain' });
      } catch (e) {
        log(profileId, 'session 装配失败', targetInfo.targetId, e.message);
      } finally {
        if (waitingForDebugger) {
          await client.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
        }
      }
      if (blank) scheduleBlankReload({ targetId: targetInfo.targetId, sessionId });
      else if (!repairedTargets.has(targetInfo.targetId)) {
        repairedTargets.add(targetInfo.targetId);
        await ensureInjectedOrReload(client, sessionId).catch(() => {});
      }
    })();
    pageReady.set(targetInfo.targetId, { prep, sessionId });
  });

  await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  client.on('Target.detachedFromTarget', (params) => { pageReady.delete(params.targetId); repairedTargets.delete(params.targetId); });

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
 * 非空白页的兜底：CDP 的 `Target.createTarget({ url })`（外部自动化/ puppeteer 最常见的开页方式）
 * 会在 attach 之前就把首个文档建好，`addScriptToEvaluateOnNewDocument` 只对下一个文档生效，
 * 于是这张页面的首帧是原始指纹（hardwareConcurrency 等全是宿主值）。
 *
 * 做法：等文档就绪后确认 `__fpApplied`，没有就补一次**重新导航到当前 URL**（不是 `Page.reload`）。
 *
 * 为什么不用 reload（P13，2026-11-11 实测）：页面读一条
 * `performance.getEntriesByType('navigation')[0].type` 就能知道「刚被 reload 过」，这是逆向裁判 C4
 * 记录的残留。改成同 URL 导航后，那个值是 `navigate`，页面自己看不出被重来过。
 *
 * **代价照实说**：仍然是**两次文档加载**（首次文档 + 这一次），服务器日志/前端埋点照样看得见；
 * 变的只是「reload 这个标记」。别把这里读成「只加载了一次」。
 *
 * 为什么不能靠「暂停 → 注入 → 放行」省掉这一次（2026-11-11 裸内核 + 本仓库环境实测，读数记在提交说明里）：
 * `Target.setAutoAttach + waitForDebuggerOnStart` 确实能把新页面停在首文档之前，裸内核单会话
 * 实测也能靠它把注入覆盖到首文档（`__p13=1`、文档请求 1 次）。但**外部自动化建页后必然紧跟一次
 * `Target.attachToTarget`**，而第二会话一 attach，暂停就被放掉（实测：谁都不发
 * `Runtime.runIfWaitingForDebugger`，页面照样 load 完），于是我们注册的脚本永远赶不上首文档。
 * 也就是说这条路上「零额外加载」做不到，能消掉的只有 reload 标记。
 */
async function ensureInjectedOrReload(client, sessionId, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await client.send('Runtime.evaluate', {
      expression: 'typeof window.__fpApplied + "|" + document.readyState',
      returnByValue: true,
    }, sessionId).catch(() => null);
    const [applied, ready] = String(r?.result?.value ?? '').split('|');
    if (applied === 'object') return true;
    if (ready === 'complete' || ready === 'interactive' || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  const href = await client.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId)
    .then((r) => String(r?.result?.value ?? '')).catch(() => '');
  if (href === '' || href === 'about:blank') return false;   // 空白页另有 scheduleBlankReload
  if (/^(https?|file):/i.test(href)) await renavigateSession(client, sessionId, href).catch(() => {});
  else await reloadSession(client, sessionId).catch(() => {});
  return false;
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

/* 注：blank-reload 的实现已挪进 injectAndOpen（`scheduleBlankReload`），
 * 因为它要读「这张页有没有人在导航」的事件状态（navBusy）和豁免表（blankReloadExempt），
 * 那两份状态都是每个实例/每条 CDP 连接自己的。模块级那份已删除，别再在别处补一份。 */

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

/**
 * 重新导航到同一个 URL（P13）：效果上等于再加载一次，但 `navigation.type` 是 `navigate` 而不是 `reload`。
 * 只用于「文档已经在、注入没赶上」的兜底；空白页与内部页仍用 reloadSession。
 */
async function renavigateSession(client, sessionId, url, timeoutMs = 6000) {
  const loaded = new Promise((resolve) => {
    const off = client.on('Page.loadEventFired', (params, sid) => { if (sid === sessionId) { off(); resolve(); } });
    setTimeout(() => { off(); resolve(); }, timeoutMs);
  });
  await client.send('Page.navigate', { url }, sessionId).catch(() => {});
  await loaded;
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

/**
 * 单个页面会话的指纹装配：先注入脚本，再打浏览器原生覆盖
 * @param {{proxyAuth?:boolean}} gate `proxyAuth=false` 时**不挂** Fetch 的代理认证路径（多级链专用：
 *   链式环境的认证由本地中继逐跳完成，Chrome 看到的是一个不需要认证的回环代理）
 */
async function applyToSession(client, sessionId, profile, view, { proxyAuth = true } = {}) {
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

  /* hardwareConcurrency 走 CDP 原生覆写（P11）：JS 层不再有这一段，页面里的 getter 就是内核真身，
   * `Function.prototype.toString` 也不存在「要伪装」的问题。三个实测约束（内核 157.0.8103.40）：
   *   ① 清不掉：传 0 → `HardwareConcurrency must be a positive number`，不传 → `Invalid parameters`；
   *      「还原」只能显式设回真值或换 session（所以别写成「设 0 = 撤销」）。
   *   ② 作用域是 target/session 级，**新 target 不继承**：每张页面在这里装配时都要重设一次，
   *      漏一张就是「同一个环境里两个页面一个说 4 核一个说 32 核」，比伪装不像更致命。
   *   ③ 不传播给专用 worker（实测 page=2 时 worker 仍是 32）→ worker 那条在 injectWorkerTarget 里另设。
   * 设不上不抛：worker / JS 兜底各自按「值不对才补」处理，宁可多一层也不能少一个值。 */
  const hc = Number(view.hardware_concurrency);
  if (Number.isInteger(hc) && hc > 0) {
    await client.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: hc }, s)
      .catch((e) => log(instance_profile(profile), 'WARN hc 覆写失败', e.message));
  }

  if (view.screen) {
    // 视口按「窗口」而不是「屏幕」设：窗口 == 屏幕是 headless 的默认形态，
    // creepjs 的 hasVvpScreenRes 就是查 innerWidth/outerHeight 是否等于 screen 尺寸。
    const win = view.window || { width: view.screen.width, height: view.screen.height };
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: win.width,
      height: win.height,
      deviceScaleFactor: view.device_scale_factor || 1,
      mobile: false,
      screenWidth: view.screen.width,
      screenHeight: view.screen.height,
    }, s).catch(() => {});
  }

  // P2 · 位置覆盖：target/session 级（新 target 不继承），所以挂在每个页面会话的装配里。
  // 权限是浏览器级的，在 start 里设一次（见 geoPolicy）。block 不覆盖；缺经纬度不传 undefined。
  const geo = geoPolicy(profile);
  if (geo.override) {
    await client.send('Emulation.setGeolocationOverride', {
      latitude: geo.latitude,
      longitude: geo.longitude,
      ...(geo.accuracy !== undefined ? { accuracy: geo.accuracy } : {}),
    }, s).catch((e) => log(instance_profile(profile), 'WARN 定位覆盖失败', e.message));
  }

  // P2 · DNT 请求头：只有 `do_not_track === "true"` 才加，会话级一次调用。
  // **必须先 `Network.enable`**：实测未 enable 时 `Network.setExtraHTTPHeaders` 返回 ok、
  // 但一个请求都没被改（静默空转的典型）。不走 `Fetch.requestPaused` —— 那条是拦截用的，
  // 拿来逐请求改头会把 installRequestGating 的职责搅混。
  if (view.doNotTrack === '1') {
    // 这一条**不许静默吞**：enable 失败时 `setExtraHTTPHeaders` 照样返回 ok，但一个请求都不改，
    // 表现为「DNT 头配了却没生效」——正是踩过的那种静默空转。行为不变（仍继续设头），
    // 但失败要留一句日志，不然下次还得靠人肉抓包才发现。
    await client.send('Network.enable', {}, s)
      .catch((e) => log(instance_profile(profile), 'WARN Network.enable 失败，DNT 头可能不生效', e.message));
    await client.send('Network.setExtraHTTPHeaders', { headers: { DNT: '1' } }, s)
      .catch((e) => log(instance_profile(profile), 'WARN DNT 头设置失败', e.message));
  }

  // 与预检 / --proxy-server 同源：AdsPower 形状（proxy_user / proxy_password）也要认，
  // 否则账号密码挂不上，内核收到 407 后页面直接空白。
  const proxy = normalizeProxyConfig(profile.user_proxy_config || profile.proxy_config || {});
  await installRequestGating(client, s, profile, proxy, { proxyAuth }).catch((e) => log(profile.id, '请求闸门挂载失败', e.message));
}

function instance_profile(p) {
  return p?.id || p?.profile_id;
}

/**
 * 请求级闸门：代理认证 + 环境级网络开关（`disable_video` / `blacklist` / `whitelist`）。
 *
 * 两件事都必须走 CDP 的 `Fetch` 域，所以**合成一次 enable、一个处理点**：分两次
 * `Fetch.enable` 会互相覆盖 patterns，两个 `requestPaused` 处理器还会争抢同一个请求
 * （一个 continue、一个 fail，最后谁先谁算）。判定逻辑本身在 kernel/net-rules.js，纯函数、可单测。
 *
 * 没有规则也没有代理认证时**完全不开 Fetch** —— 默认路径零额外开销（拦截会加每请求一跳）。
 */
async function installRequestGating(client, sessionId, profile, proxy, { proxyAuth = true } = {}) {
  const rules = compileNetRules(profile);
  // 链式环境：Chrome 连的是**无认证的本地中继**，认证由链逐跳完成；这时候再开 `handleAuthRequests`
  // 只会让 authRequired 去应答一个根本不存在的挑战（而且环境代理的账密不该出现在这一层）。
  // 单跳仍走原来的 Fetch.authRequired 路径 —— 那条是老坑，别一刀切关掉。
  //
  // 「双重保险」的两道防线，各防一种改动（巡检 S2，2026-11-12）：
  //   第一道 —— 调用方 `applyToSession` 调用点（本文件 :685）在链式环境显式传
  //              `proxyAuth: instance.chain_mode !== 'chain'`，认证路径根本不进来；
  //   第二道 —— 下一行的 `!!(proxy.username && proxy.host)` 短路，兜「将来有人加了新调用点
  //              却忘了传 `proxyAuth:false`」：链式环境的 `effectiveProxy.username` 恒为空串
  //              （本文件 :181 组装本地中继时写死）。
  // 两道**不是**冗余：拆掉任何一道，另一道的默认前提都会破（链上会冒出一个不存在的认证挑战）。
  const needAuth = proxyAuth && !!(proxy.username && proxy.host);
  if (!rules.active && !needAuth) return;

  await client.send('Fetch.enable', {
    handleAuthRequests: needAuth,
    // 视频开关要多挂一个 response 阶段：request 阶段拿不到 Content-Type，HLS/yt-ump 这类
    // 伪装成 XHR 的媒体只能等响应头回来再判（见 net-rules.js 的 isMediaRequest）。
    // 没有视频开关时不加这一阶段 —— 别给每一个响应都多一次暂停。
    patterns: rules.blockMedia
      ? [{ urlPattern: '*' }, { urlPattern: '*', requestStage: 'Response' }]
      : [{ urlPattern: '*' }],
  }, sessionId);

  client.on('Fetch.requestPaused', (params, sid) => {
    if (sid !== sessionId) return;
    // 两个阶段共用这一个事件：response 阶段才带 `responseStatusCode`（CDP 的约定），
    // request 阶段没有 mime，只能按 resourceType + 扩展名兜底。
    // `resourceType` 在 params 顶层，不在 params.request 里（实测：request.resourceType 是 undefined，
    // 只看它就永远判不出「这是不是 Media」——视频开关会静默不生效）。
    const atResponse = params.responseStatusCode !== undefined;
    const contentType = atResponse
      ? (params.responseHeaders || []).find((h) => String(h.name || '').toLowerCase() === 'content-type')?.value
      : undefined;
    const verdict = decideRequest(
      atResponse
        ? { url: params.request?.url, resourceType: params.resourceType, responseMimeType: contentType }
        : { ...(params.request || {}), resourceType: params.resourceType },
      rules,
    );
    if (verdict.block) {
      client.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }, sid).catch(() => {});
      return;
    }
    // response 阶段要用 continueResponse（continueRequest 只对请求阶段有意义）；
    // 老内核不认识 continueResponse 时退回 continueRequest，别把一个响应永久挂住。
    if (atResponse) {
      client.send('Fetch.continueResponse', { requestId: params.requestId }, sid)
        .catch(() => client.send('Fetch.continueRequest', { requestId: params.requestId }, sid).catch(() => {}));
    } else {
      client.send('Fetch.continueRequest', { requestId: params.requestId }, sid).catch(() => {});
    }
  });

  if (!needAuth) return;
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
  // 链监听跟实例同生命周期：不关它，反复起停会一直漏端口
  if (inst.chain) { await inst.chain.close().catch(() => {}); inst.chain = null; }
  running.delete(profileId);
  markStatus(profileId, 'idle');
  return { profile_id: profileId, stopped: true };
}

export async function stopAll() {
  const ids = [...running.keys()];
  for (const id of ids) await stopProfile(id);
  return ids;
}