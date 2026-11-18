import fs from 'node:fs';
import path from 'node:path';
import {
  PROFILES_DIR, LOG_DIR, START_TIMEOUT_MS,
  EGRESS_PROBE_URL, PROXY_PROBE_TIMEOUT_MS, EGRESS_TIMEOUT_MS, SELFCHECK_ON_START, FP_DEBUG,
} from '../config.js';
import { uaAutoAlignEnabled, readAlwaysStartPage } from '../settings/prefs.js';
import { findChrome, buildArgs, launchChrome, waitForDevToolsPort, killProcessTree, rememberVersion } from '../kernel/chrome.js';
import { CdpClient, fetchJson } from '../kernel/cdp.js';
import { buildInjectionSource, buildWorkerInjectionSource, buildUaChOnlySource } from '../kernel/inject.js';
import { markerNames, installedExpression, workerRealmExpression } from '../kernel/markers.js';
import { compileNetRules, decideRequest } from '../kernel/net-rules.js';
import { blockPageResponse } from '../kernel/block-page.js';
import { writeCookies } from '../kernel/cookies.js';
import { alignProfileToKernel } from '../kernel/version.js';
import { preAlignForLaunch } from '../fingerprint/hints.js';
import { fingerprintView, geoPolicy } from '../fingerprint/view.js';
import { ensureNoiseSeeds } from '../fingerprint/seeds.js';
import { checkProfile, markStatus, markLaunched, applyProfileFields, persistEgress, getProfile } from '../store/profiles.js';
import { extensionsForProfile, rememberUniqueId } from '../store/extensions.js';
import { loadUnpackedExtensions } from '../kernel/extensions.js';
import { checkProxy, hasProxy, isHardProxyFailure, normalizeProxyConfig } from '../proxy/probe.js';
import { resolveChain, startChain } from '../proxy/chain.js';
import { startRelay } from '../proxy/relay.js';
// 环境 → 中继端口：起始页的出口探测要跟浏览器走**同一条链路**（0.4.7.5）
import { setRelayPort, clearRelayPort } from '../proxy/relay-registry.js';
import { pacInUse, pacMessage } from '../proxy/pac.js';
import { probeEgressInBrowser } from '../proxy/egress.js';
import { runSelfCheck } from '../selfcheck/index.js';
import { summarize } from '../selfcheck/store.js';
import { checkEgress } from '../../packages/profile/src/validate.js';
import { startPageUrl } from '../start/page.js';
import { ensureRestoreOnStartup, RESTORE_ON_STARTUP } from './prefs.js';

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
/**
 * 子帧（OOPIF）装配的等待上限：CDP 覆写 + UA-CH 最小脚本注册，两件事都落地才放行子帧。
 * 正常毫秒级；超时只是「别把子帧永远停着」的兜底 —— 停住的子帧 = 页面白屏。
 */
const IFRAME_ARM_TIMEOUT_MS = 1500;
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
    // 应用中心：本次按环境勾选真的加载了哪些扩展（loaded/failed 都回，缺失不静默）
    extensions: i.extensions || null,
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
    /**
     * 1) 启动前校验：硬冲突 + 值域错误阻断，软冲突只告警。
     *
     * **1.1) 只剩「UA 版本 vs UA-CH 版本」这一类硬冲突时，先按本机内核预对齐**（0.4.7.1 要求 2）。
     *
     * 0.4.6 把「UA 报 Chrome/133、`client_hints.ua_full_version`=157」升级成硬冲突是对的，
     * 但它和历史数据撞在一起就成了死胡同：老记录的 UA 是导入时带的 133，UA-CH 是建环境
     * 那一刻按本机内核填的 157 —— 一读出来就自相矛盾，而启动后那次 `alignProfileToKernel`
     * 压根轮不到执行（校验在它前面就 throw 了）。用户 50 个环境全被这一条拦住（P0）。
     *
     * 这里只在**别的硬冲突一条都没有**时做一次（`preAlignForLaunch` 自己判），
     * 对齐后必须重查 `ok === true` 才采用；`webgl` 空开关、UA 平台 ↔ `navigator.platform`
     * 矛盾这些继续阻断，一个口子都不开。
     *
     * 对齐结果**不落库**：这是「这一轮拿来启动」的临时视图，落库只走启动后那次
     * （以 Browser.getVersion 的真值为准，目录名/注册表给的版本只是猜）。
     *
     * **0.4.7.2 起整段挂在开关之下**（`uaAutoAlign`，设置页「UA 跟随内核版本升级」，默认关）：
     * 关着的时候连「这一轮呈现的 UA」都不许改 —— 用户存的是 133，就必须按 133 打开。
     * 开关关着又碰上真矛盾对（库里的 hints 与 UA 版本打架）时，照旧抛 800005 阻断，
     * **不静默改指纹**；正常路径不会走到这里（读路径 `withClientHints` 已经让记录自洽）。
     */
    /** 这次启动要不要跟版（默认关；关 = 任何路径都不改写 ua / client_hints / kernel_version） */
    const uaAutoAlign = uaAutoAlignEnabled();
    let launchProfile = profile;
    let check = checkProfile(launchProfile, { force });
    let uaRealign = null;
    if (!check.ok && !force && uaAutoAlign) {
      const chromeForPreAlign = findChrome();
      const guessed = chromeForPreAlign && chromeForPreAlign.version;
      if (guessed) {
        const pre = preAlignForLaunch(launchProfile, {
          kernelVersion: guessed,
          check: (x) => checkProfile(x, { force }),
        });
        if (pre.applied) {
          launchProfile = pre.profile;
          check = checkProfile(launchProfile, { force });
          uaRealign = {
            from: (profile.client_hints && profile.client_hints.ua_full_version) || null,
            to: guessed,
            reasons: pre.reasons,
          };
        }
      }
    }
    if (!check.ok) {
      const err = new Error(check.errors.map((e) => `${e.field}: ${e.message}`).join('; '));
      err.code = 800005;
      err.reason = 'consistency';
      err.errors = check.errors;
      throw err;
    }
    const warnings = [...check.soft];
    if (uaRealign) {
      warnings.unshift(soft('ua_realign_precheck',
        `UA 与 UA-CH 的版本号不一致，已在启动前按本机内核 ${uaRealign.to} 对齐：${uaRealign.reasons.join('; ')}`));
      log(id, 'UA 预对齐', uaRealign.reasons.join('; '));
    }
    if (check.forced) {
      warnings.unshift(soft('$', `已强制启动：${check.hard.length} 条硬冲突被 force=1 越过（${check.hard.map((e) => e.field).join(',')}）`));
    }
    // 本轮就用对齐后的视图启动（不改库；库由启动后那次真值对齐负责）
    profile = launchProfile;

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
    /**
     * 带凭据代理的本地中继（0.4.7.3 P0）。
     * **Chrome 内核不支持 SOCKS5 认证**：`--proxy-server=socks5://host:port` 只会发 `no-auth(0x00)`，
     * 服务端要求 `0x02` 时握手直接失败 → 所有请求 ERR_BLOCKED_BY_CLIENT、页面全打不开；
     * 而 Node 侧的代理预检是**带凭据**的，能通 —— 于是「预检绿、浏览器死」。
     * 带 username/password 的代理一律换成 `127.0.0.1:<port>` 的本地中继（src/proxy/relay.js）。
     * 生命周期同 chainServer：停止 / 内核自己退出 / 启动失败 / 链式路径，四条都要 close。
     */
    let relayServer = null;
    let proxyCheck = null;

    // 2.1) 多级代理链：hop0 = 本机 **Windows 系统代理**，hop1 = 环境自己的代理（对手也是这样两跳拼出来的）
    //      - 本机没配系统代理 → **塌成单跳、正常启动**（不算失败，误报 800003 才是错）
    //      - 确实是两跳 → 浏览器只看到本地回环监听，链在浏览器外由我们逐跳转发
    const chain = resolveChain(profile, { systemProxy });
    /**
     * 内核眼里的代理形态：'off' | 'none' | 'single' | 'chain' | 'relay'。
     * 'chain' 与 'relay' 都是「内核连的是本地无认证监听」→ 必须关掉 Fetch 的代理认证路径
     * （见 applyToSession 的 proxyAuth 与 installRequestGating 的 needAuth）。
     */
    let chainMode = chain.mode;
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
          if (!isHardProxyFailure(proxyCheck.kind)) {
            /* 0.4.7.5 19:45：**探测源挂了 ≠ 代理不通**。
             * 现场：10056 的代理单发 748ms 就通，但 ip-api.com 被我们打了几百次触发了限流
             * （免费额度 45 次/分钟），启动被 fail-closed 拦住，报「代理不可用」。
             * 现在只有 TCP 不通 / 握手被拒（认证失败）才拦；「所有探测源都不可达」只记一条
             * `探测源不可用（不是代理不通）`，按「未验证」继续启动，起始页如实写。 */
            log(id, 'WARN 探测源不可用（不是代理不通），按「未验证」继续启动', proxyCheck.error);
            warnings.push(soft('proxy_probe_unavailable',
              `探测源不可用（不是代理不通）：${proxyCheck.error}。已按「未验证」启动，`
              + '起始页会显示「探测源不可用」；代理是否真能用，以页面实际打开为准'));
          } else {
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
        } else {
          log(id, '代理预检通过', `${proxyCheck.ip} ${proxyCheck.countryCode || ''} ${proxyCheck.latency_ms}ms`);
        }
      }
    } else {
      warnings.push(soft('proxy', '未绑定代理：出口即本机 IP，跑真实账号请务必绑代理'));
    }

    /* 2.2) 带凭据的代理 → 本地 SOCKS5 中继（0.4.7.3 P0，见 src/proxy/relay.js 顶部）
     *
     * 只对**带 username 或 password** 的代理生效，而且是**在预检之后**：
     * 预检必须继续打真实上游（带凭据），否则「预检绿」就变成「探自己」——
     * 那正是这一版要修的假绿灯，绝不能换个地方再造一个。
     *
     * 不带凭据的 socks5 **保持直连写法**（Chrome 自己能跑，多一层中继纯属浪费），
     * 这条由 `username || password` 这个条件本身保证，别为了「统一」把它也塞进来。
     *
     * 中继起不来 → 800003 拒绝启动，**绝不降级直连**（降级 = 用户以为在用代理、其实在用本机 IP）。
     * 凭据只出现在发往上游的握手报文里：日志只打 `127.0.0.1:<port> → 上游 host:port`。 */
    if (proxyBound && chain.mode !== 'chain' && (effectiveProxy.username || effectiveProxy.password)) {
      const upstream = normalizeProxyConfig(effectiveProxy);
      try {
        relayServer = await startRelay(upstream);
      } catch (e) {
        log(id, '代理中继失败，拒绝启动', e.message);
        const err = new Error(`代理带认证，但本地中继起不来，已阻止启动（fail-closed）：${e.message}`);
        err.code = 800003;
        err.reason = 'proxy_relay_failed';
        throw err;
      }
      log(id, '代理中继', `127.0.0.1:${relayServer.port} → 上游 ${upstream.type} ${upstream.host}:${upstream.port}`);
      // 起始页探测要用这个端口（与浏览器同一条链路）；生命周期与 relayServer 一致
      setRelayPort(id, relayServer.port);
      warnings.push(soft('proxy_auth_relay',
        `代理带用户名密码：Chrome 内核不支持 SOCKS5 认证（只会发 no-auth），已由本地中继转发 —— `
        + `内核只看到 127.0.0.1:${relayServer.port}，认证在 FreePower 这一侧对上游完成`));
      effectiveProxy = { type: 'socks5', host: '127.0.0.1', port: relayServer.port, username: '', password: '' };
      chainMode = 'relay';
    }

    // 3) 起内核：用户 launch_args 走白名单合并进真实 argv
    //    UA 跟版放在拿到 Browser.getVersion 之后做 —— 目录名不是版本真值（Application 里可能同时躺着两个版本）

    /**
     * 2.9) 应用中心：这个环境勾选了哪些扩展。
     * 拼参数**不用它**（Chrome 157 起 `--load-extension` 已失效，见 src/kernel/extensions.js 顶部），
     * 但「目录不见了」这件事要在这里就告警 —— 等启动完再报，用户看到的是一个安静的缺口。
     */
    const extForProfile = extensionsForProfile(id);
    for (const miss of extForProfile.missing) {
      warnings.push(soft('extensions', `扩展「${miss.name}」的目录不见了（${miss.path}），本次不加载`));
    }
    const extensions = extForProfile.extensions;

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

      // 3.0) 会话恢复（差距清单第 5 条）：每次启动都把 `session.restore_on_startup` 顶成 1。
      //      **必须在起内核之前写** —— 内核一启动就会读 Preferences，写完再写就晚一轮。
      //      读-改-写 + 原子写 + 坏文件先备份，幂等（已经是 1 就一个字节都不动）。
      try {
        const restored = ensureRestoreOnStartup(udd, { log: (m) => log(id, m) });
        if (restored.backed_up) {
          warnings.push(soft('session', `Preferences 不是合法 JSON，已备份为 ${path.basename(restored.backed_up)} 并重建（会话恢复已重新写入）`));
        }
        if (restored.changed) log(id, '会话恢复', `session.restore_on_startup=${RESTORE_ON_STARTUP}`, restored.created ? '（新建）' : '（改写）');
      } catch (e) {
        // 写不上不阻断启动：内核自己会建 Preferences，只是这轮不保证「继续上次会话」
        warnings.push(soft('session', `会话恢复设置失败：${e.message}`));
      }

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
      // 中继同理：拼参数/起进程这一步抛错也要立刻还端口
      if (relayServer) { await relayServer.close().catch(() => {}); relayServer = null; clearRelayPort(id); }
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

      // 4) UA / 内核版本跟版：**只在开关打开时**才以真实内核版本为准（0.4.7.2 起默认关）。
      //    关着的时候这里一行都不写库 —— 用户存的是 Chrome/133，本机内核是 157，那就按 133 开。
      if (uaAutoAlign && realVersion) {
        const aligned = alignProfileToKernel(profile, realVersion);
        if (aligned.changed) {
          effective = aligned.profile;
          view = fingerprintView(effective);
          uaAligned = { from: aligned.from, to: aligned.to, patch: aligned.patch, reasons: aligned.reasons };
          log(id, 'UA 跟版', aligned.reasons.join('; '));
          try { applyProfileFields(id, aligned.patch); } catch (e) { log(id, 'UA 跟版落库失败', e.message); }
        }
      }

      // 内核版本漂移检查：**只在开了跟版时才算异常**（开了却没对上 = 真出了问题，要告警）。
      // 关着时「UA 声明 133、本机内核 157」正是用户要的状态（对手也是这样），
      // 只在环境日志里留一行给排障看，不往启动响应里塞告警 —— 否则 50 个环境每次启动都弹一条。
      const declared = effective.client_hints?.ua_full_version;
      if (declared && realVersion && declared !== realVersion) {
        if (uaAutoAlign) {
          warnings.push(soft('client_hints.ua_full_version', `UA 声明 ${declared}，真实内核 ${realVersion}（跟版开着却没对上）`));
        } else {
          log(id, 'UA 与内核版本不同', `UA 声明 ${declared}，本机内核 ${realVersion}；未开「UA 跟随内核版本升级」，按环境自己的 UA 打开`);
        }
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
        // 带凭据代理的本地中继（0.4.7.3）：生命周期与 chain 完全相同，四条路径都要 close
        relay: relayServer,
        // 'off' | 'none' | 'single' | 'chain' | 'relay'：'chain' 与 'relay' 都要关掉 Fetch 的代理认证路径
        chain_mode: chainMode,
        egress: null,
        ua_aligned: uaAligned,
        launch_args: { applied: built.applied, rejected: built.rejected },
        warnings,
        selfcheck: null,
        selfcheckReport: null,
        // 应用中心：加载结果（null = 这个环境没勾扩展）
        extensions: null,
        // 关闭后清缓存（0.4.6）：在启动时定死，关闭时不再回读库（库可能已经被改过）
        cache_purge_on_close: String(effective.clear_cache_after_closing) === '1',
      };
      running.set(id, instance);
      markStatus(id, 'starting');

      child.once('exit', (code) => {
        log(id, 'exit', String(code));
        const cur = running.get(id);
        if (cur && cur.pid === pid) {
          running.delete(id);
          markStatus(id, 'idle');
          // 用户直接关窗口（没走 stopProfile）也算「关闭环境」：对手的关闭任务同样覆盖这条路径
          scheduleCachePurgeOnClose(cur);
        }
        if (chainServer) { chainServer.close().catch(() => {}); chainServer = null; }
        if (relayServer) { relayServer.close().catch(() => {}); relayServer = null; clearRelayPort(id); }
        try { if (client) client.close(); } catch { /* ignore */ }
      });

      /**
       * 4.5) 应用中心：按环境勾选逐个加载扩展。
       * **必须在 injectAndOpen 之前** —— content script 只对「扩展加载之后才创建的文档」生效；
       * 先开页面再装扩展，那一批页面就没有扩展的注入（实测）。
       * 这条路是一堆真内核实测选出来的（`--load-extension` 在 157 上已失效），
       * 理由与读数都在 src/kernel/extensions.js 顶部。
       */
      if (extensions.length) {
        const r = await loadUnpackedExtensions(client, extensions);
        instance.extensions = {
          requested: extensions.length,
          loaded: r.loaded.map((x) => ({ ext_id: x.ext_id, chrome_id: x.chrome_id, name: x.name })),
          failed: r.failed,
        };
        for (const x of r.loaded) {
          try {
            // 导入时按路径推算的 ID 应等于内核报回来的；不等就是目录被搬过/改过名
            const predicted = extensions.find((e) => e.id === x.ext_id)?.unique_id || null;
            if (predicted && x.chrome_id && predicted !== x.chrome_id) {
              warnings.push(soft('extensions',
                `扩展「${x.name}」的 ID 与导入时推算的不一致（${predicted} → ${x.chrome_id}）：目录被搬动或改名过，扩展的本地存储会跟着分家`));
            }
            rememberUniqueId(x.ext_id, x.chrome_id);
          } catch { /* 记不到观察值不影响加载 */ }
        }
        for (const f of r.failed) {
          log(id, 'WARN 扩展加载失败', f.name, f.error);
          warnings.push(soft('extensions', `扩展「${f.name}」加载失败：${f.error}`));
        }
        log(id, '扩展', `已加载 ${r.loaded.length}/${extensions.length}`,
          r.loaded.map((x) => `${x.name}=${x.chrome_id}`).join(' '));
        if (r.failed.length === 0 && r.loaded.length === 0) {
          warnings.push(soft('extensions', '这个环境勾了扩展，但一个都没加载起来（详见启动日志）'));
        }
      }

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
        log(id, egress.kind === 'probe_site' ? 'WARN 出口探测源不可用（不是代理不通）' : 'WARN 出口探测失败', `${egress.error || ''}${diag}`);
        warnings.push(soft('ip', `${egress.kind === 'probe_site' ? '出口探测源不可用（不是代理不通）' : '浏览器出口探测失败'}：${egress.error || '未知原因'}${diag}`));
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
      // 「最后启动时间」（0.4.7 ④）：**成功之后**才写。启动失败的那次不该算「开过」，
      // 否则一个起不来的环境会永远删不掉。它是「按天数删缓存」唯一可信的时间来源 ——
      // 不拿文件 mtime 猜（mtime 会被备份/复制/杀毒改掉）。
      try { markLaunched(id); } catch (e) { log(id, 'WARN 记录最后启动时间失败', e.message); }
      return toStartData(instance);
    } catch (err) {
      log(id, 'start failed', err.message);
      try { if (client) client.close(); } catch { /* ignore */ }
      running.delete(id);
      markStatus(id, 'idle');
      killProcessTree(pid);
      // 链监听一定要关：失败路径漏端口，几轮反复起停之后才会炸，最难查
      if (chainServer) { await chainServer.close().catch(() => {}); chainServer = null; }
      // 带凭据代理的本地中继同理（0.4.7.3）：漏一个端口就是下次启动「端口被占」
      if (relayServer) { await relayServer.close().catch(() => {}); relayServer = null; clearRelayPort(id); }
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
  /* 诊断标记名按 fp_seed 派生：每环境不同、同环境稳定。
   * 全仓库不再有固定的 `__fp*` 名 —— 固定名等于给对手一行判定代码（P0）。 */
  const markers = markerNames(view?.seed);
  /* 别的模块（窗口同步的前置检查）也要判「这张页注入过没有」。
   * 标记名是按 `view.seed` 派生的，重算一遍就可能与这里不一致（种子来源有多层回落），
   * 所以**只算一次、挂到实例上**，谁要用谁来读 —— 判据与生产读的是同一份名字。 */
  instance.markers = markers;

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
        expression: installedExpression(markers),
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
    /**
     * 子帧（跨站子帧 = OOPIF，是独立 target）的 UA / UA-CH 装配结果。
     * 0.4.7.2 起两条通道都发：**CDP 原生** `Emulation.setUserAgentOverride`
     * （brands / fullVersionList / platformVersion / …）＋ **只做 UA-CH 的最小脚本**
     * （`uaFullVersion`，CDP 永远不认这一项）。四条各自记账 ——
     * 「发了」不等于「生效」，排障时要能看出是哪一条没落地。
     */
    iframes_ua: 0,
    iframes_ua_failed: 0,
    iframes_ua_ch: 0,
    iframes_ua_ch_failed: 0,
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

    /* iframe：**注入层的整套 JS 不覆盖子帧**（塞 worker 脚本只会补半套、还多一层痕迹），
     * 但 UA / UA-CH 必须补 —— 两条不同的通道，缺一条就漏一项。
     *
     * 为什么必须补（2026-11-16 实测，内核 157.0.8103.78）：**跨站子帧是独立 target（OOPIF）**，
     * 不设 Emulation 时它里面读到的是宿主真值 —— 父帧是我们配的 133 / platformVersion 10.0.0，
     * 子帧却是 `Chrome/157` / `platformVersion 19.0.0` / 真 `uaFullVersion`。
     * 检测页把一致性检查放进跨站 iframe（这是常态做法）就能一眼看出破绽。
     * 同站子帧不是独立 target（跟随父帧会话），本来就已经覆盖。
     *
     * **两条通道都要，缺一不可**（0.4.7.2 第二版，CEO 复验打回的那条）：
     *   ① `Emulation.setUserAgentOverride`：`brands` / `fullVersionList` / `platformVersion` /
     *      `architecture` / `bitness` / `model` / `wow64` 内核都认，原生覆写、零 JS 痕迹；
     *   ② `Page.addScriptToEvaluateOnNewDocument` + **只做 UA-CH 的最小脚本**
     *      （`buildUaChOnlySource`）：`uaFullVersion` 是 CDP **永远改不动**的那一项，
     *      只发 ① 的话子帧里它必然还是宿主真值 —— 第一版就是这么漏的。
     *      脚本只装 `patchUaData`（+ 它依赖的原生伪装工具），canvas/字体/WebGL 在 OOPIF 里
     *      仍然一个都不碰（那是已知限制，别读成「子帧已全套伪装」）。
     *
     * 时序：`waitForDebuggerOnStart` 把子帧停在首行之前，**两件事都落地再放行**，
     * 所以子帧的首个文档就是我们配置的那一套。设不上不拖死：每条各自记账、超时也照常放行
     * （子帧永远停着 = 页面白屏，比漏一项指纹严重得多）。 */
    if (type === 'iframe') {
      workerStats.iframes += 1;
      const jobs = [];
      if (view && view.ua) {
        jobs.push(client.send('Emulation.setUserAgentOverride', {
          userAgent: view.ua,
          acceptLanguage: (view.language || []).join(','),
          platform: view.platform || 'Win32',
          userAgentMetadata: view.ua_metadata || undefined,
        }, sessionId).then(() => { workerStats.iframes_ua += 1; }, (e) => {
          workerStats.iframes_ua_failed += 1;
          log(profileId, 'WARN 子帧 UA 覆写失败', targetId, e.message);
        }));
      }
      const uaChSource = view ? buildUaChOnlySource(view, { markers }) : null;
      if (uaChSource) {
        /* `runImmediately: true` 是这一刀的关键（0.4.7.2 第二版实测）：
         * 子帧被 `waitForDebuggerOnStart` 停住时，**它的首个文档已经建好了** ——
         * 只注册「对下一个文档生效」的脚本，当前文档里 `uaFullVersion` 仍是宿主真值
         * （探针读数：注册成功、CDP 覆写也生效、brands/platformVersion 都对，唯独这一项 157）。
         * `runImmediately` 让脚本在当前文档里立刻跑一遍，同时又注册给后续文档。
         * 此刻目标停在首行之前，页面的脚本还没跑，所以补上去仍然赶在它自己读之前。 */
        jobs.push(client.send('Page.addScriptToEvaluateOnNewDocument', { source: uaChSource, runImmediately: true }, sessionId)
          .then(() => { workerStats.iframes_ua_ch += 1; }, (e) => {
            workerStats.iframes_ua_ch_failed += 1;
            log(profileId, 'WARN 子帧 UA-CH 脚本注册失败', targetId, e.message);
          }));
      }
      if (!jobs.length) {
        resumeNow(sessionId, waitingForDebugger);
        return;
      }
      withTimeout(Promise.all(jobs), IFRAME_ARM_TIMEOUT_MS, '子帧装配超时')
        .then(() => resumeNow(sessionId, waitingForDebugger));
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
    // 末行回显 realm 标记：注入真跑过才等于 'worker'，这是「真值」而不是「发过就算」
    const expression = buildWorkerInjectionSource(view, { debug: FP_DEBUG, markers }) + `\n;${workerRealmExpression(markers)}`;
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
        await applyToSession(client, sessionId, profile, view, { proxyAuth: !['chain', 'relay'].includes(instance.chain_mode) });
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
        await ensureInjectedOrReload(client, sessionId, markers).catch(() => {});
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
   *
   * 入参是**启动那一刻抓的** page 目标（见下面 initialTargets）：只抓一次，两处复用 ——
   *   ① 本函数装已有页面；
   *   ② 判断「这次是不是从上次会话恢复回来的」。
   */
  async function prepareExistingTabs(targetInfos) {
    for (const t of targetInfos.filter((x) => x.type === 'page')) {
      const entry = pageReady.get(t.targetId) || await waitFor(() => pageReady.get(t.targetId), 3000);
      if (!entry) continue;
      await entry.prep.catch(() => {});
      if (t.url === 'about:blank' || t.url.startsWith('chrome://newtab')) {
        await client.send('Page.reload', {}, entry.sessionId).catch(() => {});
      }
    }
  }
  // 登录 cookie 落进内核（0.4.6 接线）：**必须早于第一张页面的导航**，否则首帧就是未登录态，
  // 站点会把用户当成游客、甚至先把「未登录」写进 sessionStorage。所以放在 open_urls 之前。
  await seedLoginCookies(client, profile, profileId).catch((e) => log(profileId, 'WARN 登录 cookie 写入失败', e.message));

  const initialTargets = (await client.send('Target.getTargets').catch(() => ({ targetInfos: [] }))).targetInfos || [];
  await prepareExistingTabs(initialTargets);
  // 会话恢复（0.4.1 起每次启动强制开，见 runtime/prefs.js）会把上次的标签带回来。
  // 这时候再按 open_urls 新建，就是「每次启动 = 恢复 N 张 + 新建 M 张」，越积越多（0.4.0 的回归）。
  // 与 Chrome 自己的语义一致：「继续浏览上次打开的网页」时启动页本来就不生效。
  //
  // 判定只认**真页面**：about:blank 与 chrome://newtab 不算恢复（那是「上次把标签全关了」或者
  // 「内核没恢复出东西」的情况）—— 那两种都退回按 open_urls 开页。取舍写在 README：
  // 宁可多开一次，也不要「恢复了却什么都不开」。
  const restored = initialTargets.filter((t) => t.type === 'page'
    && t.url
    && !t.url.startsWith('about:blank')
    && !t.url.startsWith('chrome://newtab'));

  if (restored.length > 0) {
    log(profileId, '会话已恢复', `${restored.length} 个页面，跳过 open_urls（否则每次启动多一张）`);
  } else {
    /**
     * 复用**启动时那一张空白页**当第一个标签（2026-11-14 修，CEO 实测确认的缺陷）。
     *
     * 老行为是「不管三七二十一按 open_urls 新建」，于是新环境开出来两张白屏：
     * Chrome 自己开的 `chrome://newtab` + 我们建的 `about:blank`（实测 page 目标 2 个，
     * 系统 Chrome 同一套参数只开 1 个）。用户看到的就是两个白页叠在一起。
     *
     * 现在：把初始目标里那张空白页拿来用（装配 → 导航），open_urls 有 N 条就只再新开 N-1 张。
     *
     * **不许为了少一张改成命令行直接传 URL**：那样首个文档在建 target 之前就存在，
     * `addScriptToEvaluateOnNewDocument` 赶不上，首帧是原始指纹 —— 拿「少一张标签」换
     * 「首帧裸奔」是倒过来取值。
     */
    const isBlankStartup = (t) => t.type === 'page'
      && (!t.url || t.url === 'about:blank' || t.url.startsWith('chrome://newtab'));
    const keeper = initialTargets.find(isBlankStartup) || null;
    const urls = (Array.isArray(profile.open_urls) ? profile.open_urls : [])
      .map((u) => String(u || '').trim())
      .filter(Boolean);
    /* 起始页（0.4.7.3，见 src/start/page.js 顶部）：
     *   - `open_urls` 为空 → 开起始页。**这条不需要开关**：空白页对用户没有任何价值，
     *     用户库里 101/102 个环境就是 `[]`，老行为等于「打开是空白」；
     *   - 有值 → 只有「总是打开起始页」开着才多开第一张（默认关，行为与 0.4.7.2 逐字节一致）。
     * 起始页地址带签名，**不进日志**（签名等于这一页的访问凭证）。 */
    const alwaysStart = readAlwaysStartPage().enabled;
    const wantStartPage = urls.length === 0 || alwaysStart;
    const startUrl = wantStartPage ? startPageUrl(profileId) : null;
    if (startUrl) {
      log(profileId, '起始页',
        urls.length === 0 ? 'open_urls 为空，第一张打开起始页' : '「总是打开起始页」已开，第一张打开起始页');
    }
    const tabs = startUrl ? [startUrl, ...urls] : urls.slice();
    const firstUrl = tabs[0] || 'about:blank';

    let reused = false;
    if (keeper) {
      const entry = pageReady.get(keeper.targetId) || await waitFor(() => pageReady.get(keeper.targetId), 3000);
      if (entry) {
        await entry.prep.catch(() => {});
        /* 这张页我们接管了：先摘掉它身上挂着的 blank-reload。
         * 它 400ms 后本该自己 reload 一次（首个文档早于脚本注册），但 prepareExistingTabs 已经
         * 显式 reload 过了；现在我们要么导航走、要么就停在 about:blank，那一拍只会白顶一次。 */
        instance.exemptBlankReload(keeper.targetId);
        if (firstUrl !== keeper.url) {
          await client.send('Page.navigate', { url: firstUrl }, entry.sessionId)
            .catch((e) => log(profileId, 'navigate 失败', firstUrl, e.message));
          // 导航之后确认注入真跑上了（新文档走的是已注册的脚本，正常情况下一次就好）
          const ok = await ensureInjectedOrReload(client, entry.sessionId, markers).catch(() => false);
          if (!ok) log(profileId, '启动页注入确认失败', firstUrl);
        } else {
          await ensureInjected(client, entry.sessionId, markers);
        }
        reused = true;
      }
    }

    // 第一个网址由复用页承担；其余照常新开（新建的走 about:blank → 装配 → navigate）
    const rest = reused ? tabs.slice(1) : (tabs.length ? tabs : ['about:blank']);
    for (const url of rest) {
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
        await ensureInjected(client, entry.sessionId, markers);
      }
    }
  }

  /** 内部工具（自检等）：开一张已经装配好指纹的页面 */
  instance.openPage = async (url = 'about:blank', { timeoutMs = 8000 } = {}) => {
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const entry = pageReady.get(targetId) || await waitFor(() => pageReady.get(targetId), timeoutMs);
    if (!entry) throw new Error('新页面没有被 auto-attach 接住');
    await entry.prep.catch(() => {});
    // 首个 about:blank 文档早于脚本注册，先确认注入真的生效，再决定要不要导航
    await ensureInjected(client, entry.sessionId, markers);
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
async function ensureInjectedOrReload(client, sessionId, markers, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await client.send('Runtime.evaluate', {
      expression: `typeof window[${JSON.stringify(markers.applied)}] + "|" + document.readyState`,
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
async function ensureInjected(client, sessionId, markers) {
  const r = await client.send('Runtime.evaluate', {
    expression: installedExpression(markers),
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
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: buildInjectionSource(view, { debug: FP_DEBUG, markers: markerNames(view?.seed) }) }, s);

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
 * 登录 cookie 的**存储形状** → 能直接喂 `Storage.setCookies` 的 cookie 数组（纯函数，可单测）。
 *
 * 存储形状（`src/store/profiles.js:cookieToStorage`）：JSON 数组，元素两种 ——
 *   - 结构化对象（AdsPower 形状：`{name,value,domain,path,httpOnly,secure,sameSite,expires}`）；
 *   - 原始串（`"sid=xxx; uid=7"`，txt 导入里的 `cookie` 列常见这种）。
 *
 * 原始串**没有域名**，必须挂到某个 host 上才写得进去：取这个环境的第一个启动网址
 * （`open_urls[0]`）的 host，退一步用 `domain_name`。两个都没有就没法写 —— 如实记一条
 * `failed`，**不猜**（写成 `.example.com` 或者乱挂一个域，等于把登录态发给别的站点）。
 *
 * @returns {{cookies:object[], failed:{reason:string, sample:string}[], source:'object'|'raw'|'mixed'|'none'}}
 */
export function loginCookiePlan(profile = {}) {
  const raw = profile.cookie;
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { cookies: [], failed: [], source: 'none' };
  let arr = null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) arr = parsed;
  } catch { /* 不是 JSON 数组：下面按「单个原始串」处理 */ }
  if (!arr) arr = [text];

  // 原始串的落点：第一个启动网址的 host，其次 domain_name
  let fallbackUrl = '';
  const first = (Array.isArray(profile.open_urls) ? profile.open_urls : [])
    .map((u) => String(u || '').trim()).filter(Boolean)[0];
  const domainName = String(profile.domain_name || '').trim();
  for (const candidate of [first, domainName]) {
    if (!candidate) continue;
    try {
      const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
      fallbackUrl = `${u.protocol}//${u.host}`;
      break;
    } catch { /* 换下一个 */ }
  }

  const cookies = [];
  const failed = [];
  let sawObject = false;
  let sawRaw = false;
  for (const item of arr) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      sawObject = true;
      const hasDomain = String(item.domain ?? '').trim() || String(item.url ?? '').trim();
      cookies.push(hasDomain || !fallbackUrl ? item : { ...item, url: fallbackUrl });
      continue;
    }
    const s = String(item ?? '').trim();
    if (!s) continue;
    sawRaw = true;
    if (!fallbackUrl) {
      failed.push({ reason: '没有域名可挂（这个环境没填启动网址，也没有目标域名）', sample: s.slice(0, 24) });
      continue;
    }
    let pairs = 0;
    for (const pair of s.split(/;\s*/)) {
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      cookies.push({ name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), url: fallbackUrl });
      pairs += 1;
    }
    // 有内容却一个 name=value 都切不出来（乱码 / 整段 JSON 被截断 / 人贴了别的东西）：
    // 必须如实记一条失败，否则「字段里明明有东西、启动后却是游客态」会变成零日志的静默失败。
    if (!pairs) failed.push({ reason: 'cookie 串里没有可用的 name=value 对', sample: s.slice(0, 24) });
  }
  return { cookies, failed, source: sawObject && sawRaw ? 'mixed' : sawObject ? 'object' : sawRaw ? 'raw' : 'none' };
}

/**
 * 把环境的登录 cookie 写进内核（0.4.6）。
 *
 * 为什么必须做：`cookie` 是基础页上最常用的字段之一（txt 导入整批带着它），但 0.4.5 之前
 * **启动链路一次都没读它** —— 导入完 cookie 存在库里，一启动还是游客态。对手的行为是把
 * cookie 写进 `CookiesFile` 由内核启动时加载（逆向 `25-隐私开关落点核对.md` §1.2 的
 * 7 个排除键里就有 `CookiesFile`），我们是启动后经 CDP 写进同一个内核，落点不同、效果一致。
 *
 * 失败**不拦启动**：cookie 坏了不该让环境起不来（那是「导入的脏数据把环境锁死」）。
 * 但也不许静默 —— 逐条失败原因进日志，条数进返回值。
 */
async function seedLoginCookies(client, profile, profileId) {
  const plan = loginCookiePlan(profile);
  if (!plan.cookies.length) {
    if (plan.failed.length) log(profileId, 'WARN 登录 cookie 没写进去', plan.failed.map((f) => f.reason).join('；'));
    return { written: 0, failed: plan.failed.length };
  }
  const r = await writeCookies(client, plan.cookies);
  if (r.written.length) log(profileId, '登录 cookie 已写入', `${r.written.length} 条（来源 ${plan.source}）`);
  const failed = r.failed.length + plan.failed.length;
  if (failed) log(profileId, 'WARN 登录 cookie 有失败', `${failed} 条`);
  return { written: r.written.length, failed };
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
  // 链式 / 带凭据中继环境：Chrome 连的都是**无认证的本地监听**（chain.js / relay.js），
  // 认证由我们在浏览器外逐跳完成；这时候再开 `handleAuthRequests`
  // 只会让 authRequired 去应答一个根本不存在的挑战（而且环境代理的账密不该出现在这一层）。
  // 单跳仍走原来的 Fetch.authRequired 路径 —— 那条是老坑，别一刀切关掉。
  //
  // 「双重保险」的两道防线，各防一种改动（巡检 S2，2026-11-12）：
  //   第一道 —— 调用方 `applyToSession` 调用点在本文件内显式传
  //              `proxyAuth: !['chain','relay'].includes(instance.chain_mode)`，认证路径根本不进来；
  //   第二道 —— 下一行的 `!!(proxy.username && proxy.host)` 短路，兜「将来有人加了新调用点
  //              却忘了传 `proxyAuth:false`」：链式/中继环境的 `effectiveProxy.username` 恒为空串
  //              （本文件组装本地监听时写死）。
  // 两道**不是**冗余：拆掉任何一道，另一道的默认前提都会破（本地监听上会冒出一个不存在的认证挑战）。
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
      // 顶层文档命中 → 给它一张**我们自己的拦截页**（200 + HTML），而不是让浏览器报
      // `net::ERR_BLOCKED_BY_CLIENT`。对手是自编译内核塞 `StaticConfig.BlockPage`，
      // 我们没那条路，走 `Fetch.fulfillRequest`，语义一样、落点不一样（见 kernel/block-page.js）。
      //
      // 只给 `Document`、只给 request 阶段，两条都是故意的：
      //   - 子资源（图片/脚本/XHR）仍 `failRequest` —— 往 `<img>` 里塞 HTML 是垃圾，
      //     站点自己的错误处理也会被搞乱；
      //   - response 阶段（视频开关）不给页面 —— 响应已经在路上，换不掉。
      // fulfill 失败（内核不支持 / 会话已断）退回老路径，别把一个请求永久挂住。
      if (!atResponse && params.resourceType === 'Document') {
        const page = blockPageResponse({ url: params.request?.url, reason: verdict.reason });
        client.send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: page.status,
          responseHeaders: page.headers,
          body: page.bodyBase64,
        }, sid).catch(() => {
          client.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }, sid).catch(() => {});
        });
        return;
      }
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

/**
 * `clear_cache_after_closing`（0.4.6 接线）：关闭环境后删掉这个环境的内核数据目录。
 *
 * 对手机制（逆向 `30-假字段消费机制.md` §1，@187439 / @337200）：关闭流程末尾起一个 2 秒
 * 定时器，`isExists(cacheFloder)` 为真才 `rm(cacheFloder)`，删失败**只记日志、不抛错**。
 * 这是纯磁盘操作、零内核依赖，所以照抄得起 —— 三个细节照抄，一个都不「优化」：
 *   ① 2 秒延迟（给内核落盘与句柄释放留时间；立刻删在 Windows 上必然撞占用）；
 *   ② 先判存在再删（不存在就当无事发生，不刷日志）；
 *   ③ 失败静默（一行日志），不弹错、不拦停止流程 —— 用户关环境时不该看到「删不掉」的报错。
 *
 * 删的是**整个内核数据目录**（`userdata`：cache + cookie + localStorage + 书签），
 * 不是 `Default/Cache` 这种子目录 —— 与对手「删整个 cacheFloder，含 cookie/tabs/bookmark
 * 落盘文件」同范围（`30-` §1 复刻风险②）。
 *
 * 后果在界面上写明（edit.js 那一项的 hint）：删完之后下次启动是全新浏览器，登录态只有
 * `cookie` 字段里存着的那些会被重新写回去（见 seedLoginCookies）。
 *
 * @param {{cache_purge_on_close?:boolean, user_data_dir?:string, profile_id?:string}} instance
 * @param {number} delayMs 只有单测会传别的值，生产恒为 2000（对手就是 2e3）
 * @returns {boolean} 是否真的安排了清理
 */
export function scheduleCachePurgeOnClose(instance, delayMs = 2000) {
  if (!instance || !instance.cache_purge_on_close) return false;
  const dir = String(instance.user_data_dir || '');
  if (!dir) return false;
  // 停止流程与「内核自己退出」两条路都会走到这里，只排一次（重复删只是噪音日志）
  if (instance.purge_scheduled) return false;
  instance.purge_scheduled = true;
  const id = instance.profile_id;
  const timer = setTimeout(() => {
    try {
      if (!fs.existsSync(dir)) return;
      fs.promises.rm(dir, { recursive: true, force: true })
        .then(() => log(id, 'clear_cache_after_closing', `已删除内核数据目录 ${dir}`))
        .catch((e) => log(id, `clear_cache_after_closing - rm - ${dir} - ${e.message}`));
    } catch (e) {
      log(id, `clear_cache_after_closing - rm - ${dir} - ${e.message}`);
    }
  }, delayMs);
  // 定时器不许把进程吊着：stopAll 之后 node 要能正常退出
  if (typeof timer.unref === 'function') timer.unref();
  return true;
}

/**
 * 关闭环境时自动备份（0.4.7 ③）。
 *
 * 三条纪律：
 *   1. **默认关**。开关没存过就是关，关着的时候**一次都不许造**（连快照目录都不该多一个）。
 *      会持续占磁盘的事不许替用户决定 —— 见 `src/settings/prefs.js` 的说明。
 *   2. **失败不许影响关环境**：这个函数把异常全吃掉，只记一行日志 + 记一次状态，
 *      让界面（设置页 + 环境「备份快照」页）能显示「上次自动备份失败」。
 *   3. 必须**排在 `scheduleCachePurgeOnClose` 之前**：`clear_cache_after_closing` 会在 2 秒后
 *      删掉整个 userdata，排在后面就等于备份了一个空目录。
 *
 * 动态 import：`store/snapshots.js` 要 import 本模块的 `userDataDirFor`，静态 import 会成环。
 *
 * @param {{takeSnapshotImpl?:Function}} [opts] `takeSnapshotImpl` 只给判据用：注入一个会抛的实现，
 *   证明「异常不会冒泡到关环境」这条路真的有 try 兜着（真实失败走的是 `ok:false`，不会抛）
 * @returns {{created:boolean, reason?:string, snapshot?:object, evicted?:object[]}}
 */
export async function autoSnapshotOnClose(profileId, { takeSnapshotImpl } = {}) {
  let enabled = false;
  let writeState = null;
  try {
    const prefs = await import('../settings/prefs.js');
    enabled = prefs.readSnapshotOnClose().enabled === true;
    writeState = prefs.writeSnapshotOnCloseState;
  } catch (e) {
    log(profileId, `snapshot_on_close - pref_read_failed - ${e.message}`);
    return { created: false, reason: 'pref_read_failed' };
  }
  if (!enabled) return { created: false, reason: 'disabled' };

  try {
    let takeSnapshot = takeSnapshotImpl;
    if (!takeSnapshot) ({ takeSnapshot } = await import('../store/snapshots.js'));
    const profile = getProfile(profileId);
    if (!profile) {
      writeState(profileId, { ok: false, reason: 'profile_not_found' });
      log(profileId, 'snapshot_on_close - fail - profile_not_found');
      return { created: false, reason: 'profile_not_found' };
    }
    // 环境刚停：内核已退出、数据是静的，所以 running:false（与「运行中拍摄」区分开）
    const r = takeSnapshot(profile, { reason: 'on_close', running: false });
    if (!r.ok) {
      writeState(profileId, { ok: false, reason: r.reason, message: r.error_message });
      log(profileId, `snapshot_on_close - fail - ${r.reason}${r.error_message ? ` - ${r.error_message}` : ''}`);
      return { created: false, reason: r.reason };
    }
    writeState(profileId, { ok: true, snap_id: r.snapshot.snap_id });
    log(profileId, `snapshot_on_close - ok - ${r.snapshot.snap_id}`);
    return { created: true, snapshot: r.snapshot, evicted: r.evicted || [] };
  } catch (e) {
    // 任何意外都不许冒泡到停止流程：关环境失败比没有备份严重得多
    try { writeState(profileId, { ok: false, reason: 'exception', message: e.message }); } catch { /* ignore */ }
    log(profileId, `snapshot_on_close - exception - ${e.message}`);
    return { created: false, reason: 'exception' };
  }
}

export async function stopProfile(profileId) {
  const inst = running.get(profileId);
  if (!inst) return { profile_id: profileId, stopped: false, reason: 'not running' };
  log(profileId, 'stop');
  // 同步会话挂在环境上：环境停了还留着会话，就是挂在死连接上的定时器和刷屏日志。
  // 用动态 import 避免 manager ↔ sync 的循环依赖（sync/session.js 要 import manager）。
  try {
    const { detachProfile } = await import('../sync/session.js');
    await detachProfile(profileId);
  } catch { /* 没有会话或取不到，不影响停止 */ }
  try {
    // 先让 Chrome 优雅退出（cookie 落盘），再兜底杀进程树
    await inst.client.send('Browser.close').catch(() => {});
  } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 400));
  killProcessTree(inst.pid);
  try { inst.client.close(); } catch { /* ignore */ }
  // 链监听跟实例同生命周期：不关它，反复起停会一直漏端口
  if (inst.chain) { await inst.chain.close().catch(() => {}); inst.chain = null; }
  // 带凭据代理的本地中继（0.4.7.3）同理：**先 destroy 所有 socket 再 close 监听**（relay.close 内部就这么做）
  if (inst.relay) { await inst.relay.close().catch(() => {}); inst.relay = null; clearRelayPort(profileId); }
  running.delete(profileId);
  markStatus(profileId, 'idle');
  // 关闭时自动备份（0.4.7 ③，**默认关**）：必须在清缓存之前，否则备份到的是被删空的目录。
  // 它自己吞掉所有异常，这里再兜一层，保证关环境不受影响。
  let snapshotOnClose = { created: false, reason: 'disabled' };
  try {
    snapshotOnClose = await autoSnapshotOnClose(profileId);
  } catch (e) {
    log(profileId, `snapshot_on_close - unexpected - ${e.message}`);
    snapshotOnClose = { created: false, reason: 'exception' };
  }
  // 关闭后清缓存（0.4.6）：排在停止流程末尾、延迟 2 秒执行，见 scheduleCachePurgeOnClose
  scheduleCachePurgeOnClose(inst);
  return { profile_id: profileId, stopped: true, snapshot_on_close: snapshotOnClose };
}

export async function stopAll() {
  const ids = [...running.keys()];
  for (const id of ids) await stopProfile(id);
  return ids;
}

/**
 * 实例日志的写入口（`sync/session.js` 要用：同步的开始/结束必须落在**主窗口那个环境**的
 * 实例日志里，用户说「没反应」时能直接翻日志定责）。
 * 不另外实现一份格式化 —— 两份日志格式一分开，排查时就得两处对时间戳。
 */
export { log as logProfile };