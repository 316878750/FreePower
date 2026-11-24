import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { CHROME_BIN, DATA_DIR, KERNELS_DIR, START_TIMEOUT_MS } from '../config.js';
import { fingerprintView } from '../fingerprint/view.js';
import { normalizeProxyConfig } from '../proxy/probe.js';
import { START_BYPASS_ENTRY, START_RESOLVER_RULE } from '../start/host.js';
import { mergeLaunchArgs } from './launch-args.js';

const CANDIDATE_DIRS = [
  'C:\\Program Files\\Google\\Chrome\\Application',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application'),
];

function exeIn(dir) {
  const p = path.join(dir, 'chrome.exe');
  return fs.existsSync(p) ? p : null;
}

/**
 * 读内核版本。三条路：
 * 1) 路径里就有版本号（`...\Application\<version>\chrome.exe`、内核矩阵目录）
 * 2) Windows 版 Chrome 的 chrome.exe 在 Application 根目录，版本号是同级的 `156.0.8078.80\` 目录名
 * 3) 都没有就返回 null（上层用兜底版本）
 */
function versionFromPath(exe) {
  const dirs = [path.dirname(exe), path.dirname(path.dirname(exe))];
  for (const d of dirs) {
    const base = path.basename(d);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(base)) return base;
  }
  const parent = path.dirname(exe);
  try {
    const versions = fs.readdirSync(parent)
      .filter((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n))
      .sort((a, b) => compareVersion(b, a));
    if (versions.length) return versions[0];
  } catch { /* ignore */ }
  return null;
}

/**
 * 内核解析顺序：FREEPOWER_CHROME 指定 → 内核矩阵（data/kernels/<version>/） → 系统 Chrome。
 *
 * 注意：`Application\chrome.exe` 这个启动器实际跑哪个版本由注册表决定，**和目录名不一定一致**
 * （实测目录里有 156/157 两个，启动器跑的是 156）。所以这里解析出的 version 只是「猜」，
 * 真值以启动后 Browser.getVersion 为准，并写进 data/kernel-version.json 供下次直接复用。
 */
export function findChrome() {
  const resolved = resolveChrome();
  if (!resolved) return null;
  const known = readKnownVersion();
  if (known && known.path === resolved.path) {
    return { ...resolved, version: known.version, guessed_version: resolved.version, source: `${resolved.source}+probe` };
  }
  return resolved;
}

/**
 * 本机可用的内核清单（kernels 路由用）。
 * 只报「磁盘上真的有可执行文件」的版本：系统 Chrome 的版本子目录 + 我们的内核矩阵目录。
 *
 * 出参形状照对手的 `/browser-profile/kernels`：**核心只有 `kernel_type` / `kernel` / `is_downloaded` 三个键**
 * （另加我们自己的诊断位 `guessed_kernel` / `probed`）。可执行文件路径、来源与「当前在用的是哪个」
 * 只在函数内部用 `_path` / `_source` / `_in_use` 传，**不出现在返回的对象里** ——
 * 最后是按白名单显式建对象，不是把内部记录展开，所以内部再加字段也不会漏到 API。
 * 理由：巡检比形状时多一个 `path` 或 `in_use` 就是「API 形状不符」，而它们属于本机内部信息，对方也没有。
 */
export function listKernels({ type = 'chrome' } = {}) {
  const t = String(type).toLowerCase();
  if (t !== 'chrome') return [];
  const out = [];
  const seen = new Set();
  const push = (version, exePath, source) => {
    if (!version || seen.has(`${version}|${exePath}`)) return;
    seen.add(`${version}|${exePath}`);
    out.push({ kernel_type: 'chrome', kernel: version, is_downloaded: true, _path: exePath, _source: source });
  };

  if (CHROME_BIN && fs.existsSync(CHROME_BIN)) {
    push(versionFromPath(CHROME_BIN) || 'unknown', CHROME_BIN, 'env');
  }
  if (fs.existsSync(KERNELS_DIR)) {
    for (const v of fs.readdirSync(KERNELS_DIR).filter((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x))) {
      for (const rel of ['chrome.exe', 'chrome-win64\\chrome.exe', 'chrome-win\\chrome.exe']) {
        const p = path.join(KERNELS_DIR, v, rel);
        if (fs.existsSync(p)) { push(v, p, 'kernel-matrix'); break; }
      }
    }
  }
  for (const dir of CANDIDATE_DIRS) {
    if (!dir || !fs.existsSync(dir)) continue;
    const versions = fs.readdirSync(dir).filter((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v));
    for (const v of versions) {
      const p = exeIn(path.join(dir, v));
      if (p) push(v, p, 'system');
    }
    const direct = exeIn(dir);
    if (direct) push(versionFromPath(direct) || 'unknown', direct, 'system');
  }
  const current = findChrome();
  const known = readKnownVersion();
  const enriched = out
    .map((k) => {
      // `_in_use` / `_path` / `_source` 都是内部信息，最后一步按白名单投影，不会下传。
      const item = { ...k, _in_use: !!current && current.path === k._path };
      // 目录名只是猜：同一个 chrome.exe 的版本子目录可能有多个（实测有 156/157，跑的是 156）。
      // 启动探测过就报真值，把目录猜测留在 guessed_kernel 里，别让调用方按错版本号挑内核。
      if (known && known.path === k._path && known.version !== k.kernel) {
        return { ...item, kernel: known.version, guessed_kernel: k.kernel, probed: true };
      }
      return item;
    })
    .sort((a, b) => compareVersion(b.kernel, a.kernel));
  // 出参白名单（巡检 2026-11-12）：对手这条路由只有 `kernel_type` / `kernel` / `is_downloaded`。
  // `_in_use` 内侧留着（「当前在用的是哪个内核」以后 detail/诊断要用，别再回头改形状），但不序列化；
  // `guessed_kernel` / `probed` 是已知限制 15 的判据要用的，保留。
  return enriched.map((k) => {
    const pub = { kernel_type: 'chrome', kernel: k.kernel, is_downloaded: k.is_downloaded };
    if (k.guessed_kernel) { pub.guessed_kernel = k.guessed_kernel; pub.probed = true; }
    return pub;
  });
}

function resolveChrome() {
  if (CHROME_BIN && fs.existsSync(CHROME_BIN)) {
    return { path: CHROME_BIN, version: versionFromPath(CHROME_BIN), source: 'env' };
  }
  if (fs.existsSync(KERNELS_DIR)) {
    const versions = fs.readdirSync(KERNELS_DIR)
      .filter((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => compareVersion(b, a));
    for (const v of versions) {
      for (const rel of ['chrome.exe', 'chrome-win64\\chrome.exe', 'chrome-win\\chrome.exe']) {
        const p = path.join(KERNELS_DIR, v, rel);
        if (fs.existsSync(p)) return { path: p, version: v, source: 'kernel-matrix' };
      }
    }
  }
  for (const dir of CANDIDATE_DIRS) {
    if (!dir || !fs.existsSync(dir)) continue;
    const versions = fs.readdirSync(dir).filter((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v)).sort((a, b) => compareVersion(b, a));
    for (const v of versions) {
      const p = exeIn(path.join(dir, v));
      if (p) return { path: p, version: v, source: 'system' };
    }
    const direct = exeIn(dir);
    if (direct) return { path: direct, version: versionFromPath(direct), source: 'system' };
  }
  return null;
}

const KNOWN_FILE = () => path.join(DATA_DIR, 'kernel-version.json');

/** 上一次实测到的内核真实版本（启动成功后写入） */
export function readKnownVersion() {
  try {
    const j = JSON.parse(fs.readFileSync(KNOWN_FILE(), 'utf8'));
    if (j && typeof j.path === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(String(j.version))) return j;
  } catch { /* 没缓存过 */ }
  return null;
}

export function rememberVersion(exePath, version) {
  if (!exePath || !/^\d+\.\d+\.\d+\.\d+$/.test(String(version || ''))) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KNOWN_FILE(), JSON.stringify({ path: exePath, version, at: new Date().toISOString() }, null, 2));
  } catch { /* 写不进缓存不影响启动 */ }
}

export function compareVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * 启动参数：只放「参数级真实行为」的东西（UA/时区等走 CDP Emulation，不在这伪造）。
 * 返回 {args, applied, rejected, warnings}：argv 是系统基线与用户白名单参数合并后的结果。
 */
/**
 * `win_x` / `win_y` → 窗口坐标。两个都是有限整数才返回（缺一个就返回 null，见 buildArgs 那条注释）。
 *
 * 取整数而不是 `Number()` 直接吃：字段是 REAL 列，脏数据（`0.5` / `"abc"` / `NaN`）传进
 * `--window-position` 会让内核启动参数解析失败 —— 宁可当作没填。
 */
export function windowPositionOf(profile = {}) {
  const x = Number(profile.win_x);
  const y = Number(profile.win_y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  // 负坐标是合法值（副屏在主屏左边/上面），别在这里拦
  return { x, y };
}

export function buildArgs(profile, { userDataDir, proxy, proxyBound = false, userArgs = [] } = {}) {
  const fp = profile.fingerprint_config || {};
  const view = fingerprintView(profile);
  const screen = view.screen || { width: 1920, height: 1080 };
  // 窗口默认比屏幕小一圈：窗口 == 屏幕是 headless 的默认形态（creepjs hasVvpScreenRes 就是查这个）
  const win = view.window || { width: screen.width, height: screen.height };

  const disableFeatures = ['Translate', 'OptimizationHints', 'MediaRouter', 'CalculateNativeWinOcclusion'];
  /* 窗口同步：受控窗口常被主控遮挡/在后台。Chrome 默认会降级被遮挡窗口的渲染器、
   * 节流后台定时器、冻结后台页 —— 这时 CDP `Input.*` 照样返回成功，但页面不执行/不重绘
   * （0.4.7.9「sent=311 errors=0 但不动」的根因）。IntensiveWakeUpThrottling 是 1 分钟级的强节流。 */
  disableFeatures.push('IntensiveWakeUpThrottling');
  /* 0.4.7.5：网络时间服务会去 `clients2.google.com/time/1/current`（明文 HTTP，启动瞬间一发）。
   * 它不是后台网络任务，`--disable-background-networking` 关不掉，只能用 feature 开关。
   * 判据读数：只加 8 个 flag 时 clients2 还在（4 个后台域名），加上这条才降到 3 个。 */
  disableFeatures.push('NetworkTimeServiceQuerying');
  if (fp.webgl_config?.webgpu?.webgpu_switch === '0') disableFeatures.push('WebGPU', 'WebGPUService');

  /**
   * P2 · 禁用保存密码。**对手机制不同**：对手把 `DisableSavePassword=true` 塞进自家
   * `--extended-parameters` 的 base64 JSON，由自编译内核渲成 `--protected-disablesavepassword=1`
   * —— 那条路我们没有（不自编译内核）。逆向核过：对手客户端 17 处 `--disable-features`
   * 里没有一处含 `PasswordManager`（那个名字大概率不是有效 feature，写进去会被静默忽略），
   * `AutofillServerCommunication` 也无证据；对手实际带的是 `--password-store=basic` 与
   * `--disable-features=EnablePasswordsAccountStorage`。
   *
   * 所以这里用**行为最接近的 Chrome 原生参数**（不是复刻）：`"1"` 时加
   * `--password-store=basic`（不用系统钥匙串后端）+ 关掉 `EnablePasswordsAccountStorage`
   * （账号级密码存储）。coverage 标 `partial`：参数进了内核命令行，但「保存密码条不再出现」
   * 是浏览器 UI 层行为，本机没有能稳定观测到它出现/消失的手段（见 README 该条的说明）。
   */
  if (String(profile.disable_save_password) === '1') {
    disableFeatures.push('EnablePasswordsAccountStorage');
  }

  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-service-autorun',
    `--lang=${view.locale || 'en-US'}`,
    `--accept-lang=${(view.language || ['en-US']).join(',')}`,
    `--window-size=${profile.window_size || `${win.width},${win.height}`}`,
    `--disable-features=${[...new Set(disableFeatures)].join(',')}`,
    '--disable-search-engine-choice-screen',
    '--hide-crash-restore-bubble',
    /* 0.4.7.5：把内核自己的后台网络全关掉。
     *
     * 为什么（用户 2026-11-18 14:32 的实测）：Chrome 一个实例启动瞬间会对代理开 14 条连接，
     * 其中 10 条是 Google 后台 —— clients2.google.com / clientservices.googleapis.com /
     * update.googleapis.com / redirector.gvt1.com / chromewebstore.googleapis.com /
     * www.googleapis.com / accounts.google.com / www.gstatic.com。
     * 这些连接对用户一个用处都没有，却和真正的业务请求**抢同一台代理的上游拨号槽位**：
     * 14 并发把上游 accept 队列打满 → 排队 10.6s → 中继 10s 超时 → 整页打不开
     * （netlog 里 81 次 `ERR_SOCKS_CONNECTION_FAILED(-120)`）。
     * 有界并发（src/proxy/relay.js）是兜底，这一组 flag 是**直接砍掉源头**。
     *
     * 逐条对得上哪条连接：
     *   --disable-background-networking      组件更新/安全浏览/域名可靠性等后台任务的总闸
     *   --disable-component-update           组件更新（update.googleapis.com）
     *   --disable-sync                       账号同步（accounts.google.com）
     *   --disable-domain-reliability         Domain Reliability 上报（clientservices）
     *   --no-pings                           <a ping> 上报
     *   --disable-client-side-phishing-detection  客户端钓鱼检测下载（chromewebstore）
     *   --disable-default-apps               默认应用安装（chromewebstore）
     *   --metrics-recording-only             只记本地指标、不上报
     * 判据：test/kernel-quiet.test.mjs（真内核 + 数域名的假代理，断言后台域名 0 个）。 */
    /* 窗口同步：后台/被遮挡窗口不降级、不节流（见上面 IntensiveWakeUpThrottling 的说明） */
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-background-timer-throttling',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-domain-reliability',
    '--no-pings',
    '--disable-client-side-phishing-detection',
    '--disable-default-apps',
    '--metrics-recording-only',
    // 会话恢复（差距清单第 5 条）：这条 flag 是**真正起作用的那一半**。
    // 实测（2026-11-13，Chrome 157.0.8103.78，裸 Chrome + 同一套 argv，两次独立探针）：
    // 只把 `Default/Preferences` 的 `session.restore_on_startup` 写成 1 → 重启后**不恢复**
    // （`Sessions/Session_*`/`Tabs_*` 都在、`profile.exit_type` 是 `Normal`、Preferences 里值仍是 1）；
    // 加上 `--restore-last-session` → 两个页**按 URL 回来了**。
    // 所以两件一起做：`src/runtime/prefs.js` 负责把设置项写成 1（语义载体、用户看得见），
    // 这条 flag 负责让 157 真的执行。别删其中任何一个 —— 删 flag 就不恢复，删 prefs 就变成
    // 「命令行偷偷恢复、设置页里却写着打开新标签页」。
    '--restore-last-session',
    // 2D canvas 固定走软件光栅化：GPU 2D canvas 在「全新 profile 首次启动」和之后的启动之间
    // 会给出不同的抗锯齿/渐变像素（实测 raw PNG 都不同），跨会话就是「你换了设备」。
    // 代价：chrome://gpu 里 Canvas 显示 Software only，重 canvas 场景略慢。见 README 已知限制。
    '--disable-accelerated-2d-canvas',
  ];

  // P2 · 禁用保存密码：与上面 disableFeatures 里那条配套，不走系统钥匙串后端
  if (String(profile.disable_save_password) === '1') args.push('--password-store=basic');

  /**
   * P2 · 自动化受控标记（`navigator.webdriver`）。**对手机制不同**：对手是自家内核的
   * `staticConfig.AutomationControlled` 布尔键（没有 `--protected-*` 开关，内核怎么读这个键
   * 逆向无证据）。我们不自编译内核，用**行为等价的 Chrome flag 方案**：不是复刻。
   *
   * 基线：不加 `--enable-automation`，并从 Blink 特性里摘掉 `AutomationControlled`
   * （`navigator.webdriver` 的来源）→ `navigator.webdriver === false`，与对手基线行为一致。
   * `"1"` 时**不放**这个 flag，内核原生就是 `true`（实测 157.0.8103.78）；`"0"` / 缺省维持基线。
   *
   * 配套（不配套就是静默空转）：注入层那句「webdriver 兜底」也跟着这个字段走 —— 见
   * `src/kernel/inject.js` 的 `CFG.automationControlled`。否则 `"1"` 会被自家兜底改回 false。
   */
  const automationControlled = String(profile.automation_controlled) === '1';
  if (!automationControlled) args.push('--disable-blink-features=AutomationControlled');

  // WebRTC：只放浏览器真实支持的策略位
  if (view.webrtc === 'disabled') {
    args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp');
  } else if (view.webrtc === 'disable_udp' || view.webrtc === 'proxy' || view.webrtc === 'forward') {
    args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp');
  }

  if (profile.headless === '1' || profile.headless === '2') {
    args.push(profile.headless === '2' ? '--headless=new' : '--headless');
  }
  if (profile.window_position === 'maximize') args.push('--start-maximized');

  // 窗口坐标（0.4.6 接线）：`win_x` / `win_y` 两个字段合成一条 `--window-position=x,y`。
  // 依据：逆向 `30-假字段消费机制.md` §7（`setWindowPosition` @5192）——**只有
  // `window_position === "topLeft"` 才推这两个数**，maximize 推 `--start-maximized`、
  // lastPosition 什么都不推。这就是「填了 win_x 但窗口位置是 maximize = 数字被静默忽略」
  // 的来源；我们在界面上把这两个输入框联动禁用（web/pages/edit.js 的 linkageNote）。
  // 空值按对手的默认口径当 topLeft（`e.windowPosition||"topLeft"`），不是我们自己定的默认。
  // 与对手的两处**故意不同**，都写在这里免得被当成漏做：
  //   ① 两个数都必须是有限整数才发（对手 `winX||0` 会把没填的当 0，我们宁可什么都不发）；
  //   ② 不照抄兜底分支 `--window-position=0,0`（那会把窗口钉在左上角、可能被任务栏压住），
  //      window_position 是别的值时我们什么都不加，让窗口管理器自己摆。
  const windowPos = String(profile.window_position || '').trim() || 'topLeft';
  const position = windowPos === 'topLeft' ? windowPositionOf(profile) : null;
  if (position) args.push(`--window-position=${position.x},${position.y}`);

  const warnings = [];

  /**
   * 环境兜底：在受限环境里（CI、远程会话、被别的宿主进程代起时）内核自己的 Chromium 沙箱
   * 可能起不来，症状是 Chrome 秒退（STATUS_BREAKPOINT）且从不写 DevToolsActivePort。
   * 默认**不加** —— 沙箱该开着；只有用户显式 FREEPOWER_KERNEL_NO_SANDBOX=1 才退化，并且如实标注。
   */
  if (process.env.FREEPOWER_KERNEL_NO_SANDBOX === '1') {
    args.push('--no-sandbox');
    warnings.push({
      field: 'kernel_sandbox',
      message: '内核以 --no-sandbox 启动（FREEPOWER_KERNEL_NO_SANDBOX=1）：只在沙箱起不来的受限环境用',
      severity: 'soft',
    });
  }

  /**
   * 禁用图片：Blink 层直接不请求图片（`img.complete` 恒为 false，服务器侧零请求）。
   * 视频/域名黑白名单是请求级规则，走 CDP Fetch 拦截（见 src/kernel/net-rules.js 与
   * manager.js 的 installRequestGating）—— 内核没有「不加载视频」的等价开关。
   *
   * `image_size`（按大小挡图）**不在这里**：0.4.6 裁决为禁用 —— 对手机制是定制内核的
   * `StaticConfig.NetFilters`，官方内核不读；CDP 等价拦截未实测，不宣称接上（见 overrides.mjs）。
   */
  if (String(profile.disable_image) === '1') {
    args.push('--blink-settings=imagesEnabled=false');
  }

  // PAC 明确拒绝（调用方已先拦，这里是纵深防御）：PAC 的 DIRECT 回退无法 fail-closed
  if (profile.full_pac_url) {
    throw Object.assign(new Error('不支持 PAC：请改用固定 HTTP / SOCKS5 代理'), { code: 800003, reason: 'pac_unsupported' });
  }

  if (proxyBound) {
    // fail-closed 的浏览器侧：只认这一个代理，且把「本机/内网直连」的隐含 bypass 也去掉。
    // `<-loopback>` 是 Chromium 的「减掉 loopback 隐含绕过」写法；不加它就还能直连 localhost。
    //
    // 0.4.7.3 起多放行一个 `start.freepower.test`（起始页专用假域名，见 src/start/host.js）：
    // 起始页必须在**代理全挂**时也能打开，但它不能用 127.0.0.1 —— 那等于给整个 loopback 开口子。
    // 实测（`.tmp/probe-bypass.mjs`，内核 157.0.8103.78，代理指向死端口）：
    //   只 `<-loopback>`            → ERR_PROXY_CONNECTION_FAILED（起始页打不开）
    //   `<-loopback>;127.0.0.1`     → 能开，但 loopback 的 fail-closed 没了（判据会红）
    //   `<-loopback>;start.freepower.test` → 能开，且 127.0.0.1 仍走代理（本条采用）
    args.push(`--proxy-bypass-list=<-loopback>;${START_BYPASS_ENTRY}`);
  }
  // 假域名钉到回环（不管有没有代理都加：解析规则本身不改任何别的域名）
  args.push(`--host-resolver-rules=${START_RESOLVER_RULE}`);

  // 代理字段统一走 normalizeProxyConfig：AdsPower 形状是 proxy_host / proxy_port / proxy_user /
  // proxy_password，这里直读 proxy.host 会让 --proxy-server 拼不出来 —— 预检通过、内核却直连（fail-open）。
  const px = proxy ? normalizeProxyConfig(proxy) : null;
  if (proxyBound && !(px && px.host && px.port > 0)) {
    throw Object.assign(new Error('已绑定代理但代理配置不完整（host/port 为空）：拒绝以直连方式启动'), {
      code: 800003, reason: 'proxy_config_incomplete',
    });
  }
  if (px && px.host && px.port > 0) {
    const scheme = px.type === 'https' ? 'https' : px.type === 'socks5' ? 'socks5' : 'http';
    args.push(`--proxy-server=${scheme}://${px.host}:${px.port}`);
  }

  // 多级代理链在这里没有额外参数：链由 FreePower 在浏览器外搭好（src/proxy/chain.js），
  // 内核只看到 `--proxy-server=http://127.0.0.1:<本地链端口>`。链路是「本机系统代理 + 环境代理」
  // 两跳拼出来的（对手也是这么拼的，没有可配置的 hop 列表），解析全在 chain.js 里，这里刻意不重复判，
  // 免得两处口径不一致（旧实现这里会推一条「多级代理暂未实现」的告警，0.3.3 起已不成立）。

  const merged = mergeLaunchArgs(args, userArgs, { proxyBound });
  merged.warnings.push(...warnings);
  return merged;
}

/**
 * 等 Chrome 把 DevToolsActivePort 写出来。
 *
 * 传 `child` 时会**盯着内核自己退出**：内核秒退（典型是 STATUS_BREAKPOINT = 0x80000003）
 * 根本不会再写 DevToolsActivePort，死等超时只会给出「20000ms 内没暴露端口」这种误导性结论
 * （实测：内核目录/用户数据目录落在被限制 ACL 的路径下时就是秒退，报超时会让人往端口、
 * 防火墙方向查）。这里改成立刻带退出码失败。
 */
export async function waitForDevToolsPort(userDataDir, { timeoutMs = START_TIMEOUT_MS, child = null } = {}) {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const txt = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
      const port = Number(txt[0]);
      if (port > 0 && txt[1]) return { port, browserPath: txt[1] };
    } catch { /* 还没写出来 */ }
    if (child && child.exitCode !== null && child.exitCode !== undefined) {
      const hex = `0x${(child.exitCode >>> 0).toString(16).toUpperCase()}`;
      const hint = child.exitCode === 0x80000003
        ? '；0x80000003 是 STATUS_BREAKPOINT，常见于内核目录或用户数据目录不可写/不可删（受限 ACL、只读盘），或宿主限制了内核沙箱'
        : '';
      throw new Error(`Chrome 启动后立即退出（exit code ${child.exitCode} / ${hex}），未写 DevToolsActivePort：${file}${hint}`);
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`Chrome 未在 ${timeoutMs}ms 内暴露 DevTools 端口：${file}`);
}

export function launchChrome(exePath, args) {
  const child = spawn(exePath, args, { stdio: 'ignore', windowsHide: false });
  child.on('error', () => { /* 由上层 waitForDevToolsPort 超时暴露 */ });
  return child;
}

/** 进程树回收：Chrome 会拉一堆子进程，只 kill 父进程会留孤儿 */
export function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch { /* 已经退出了 */ }
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  }
}
