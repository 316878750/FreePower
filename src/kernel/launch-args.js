/**
 * FreePower · launch_args 白名单合并
 *
 * 环境里可以让用户加启动参数，但**只有白名单里的参数会真的进命令行**：
 *   - 白名单：能安全叠加的（扩展、feature 列表、窗口起始态…），feature 列表按并集合并，不覆盖系统值；
 *   - 保护名单：会破坏隔离 / 指纹自洽 / fail-closed 的一律丢弃（不是静默丢弃，会回报原因）；
 *   - 名单外的：拒绝并回报，不猜用户意图。
 *
 * 对外的 launch_args 契约不变（v1 是 JSON 字符串、v2 是数组）；这里只负责「怎么变成真实 argv」。
 */

/** kind: flag 无值 | path-list 逗号路径 | feature-list 逗号特性 | bypass 绕过列表 */
const WHITELIST = new Map([
  ['--load-extension', { kind: 'path-list', note: '扩展目录' }],
  ['--disable-extensions-except', { kind: 'path-list', note: '只启用这些扩展' }],
  ['--disable-features', { kind: 'feature-list' }],
  ['--enable-features', { kind: 'feature-list' }],
  ['--disable-blink-features', { kind: 'feature-list' }],
  ['--enable-blink-features', { kind: 'feature-list' }],
  ['--proxy-bypass-list', { kind: 'bypass' }],
  ['--start-maximized', { kind: 'flag' }],
]);

const PROTECTED = new Map([
  ['--user-data-dir', '环境隔离目录由系统计算，不接受覆盖'],
  ['--remote-debugging-port', '调试端口由系统随机分配并回读 DevToolsActivePort'],
  ['--remote-debugging-pipe', '调试通道由系统管理'],
  ['--remote-debugging-address', '调试监听地址由系统固定在 127.0.0.1'],
  ['--extended-parameters', '内核策略通道由 FreePower 自己管理'],
  ['--lang', '界面语言由环境字段决定'],
  ['--accept-lang', 'Accept-Language 由环境字段决定'],
  ['--user-agent', 'UA 由环境字段 + CDP 覆写，命令行注入会被运行时覆盖'],
  ['--proxy-server', '代理由环境绑定决定，禁止绕开（fail-closed）'],
  ['--proxy-pac-url', 'PAC 会引入 DIRECT 回退，禁止在环境参数里指定'],
  ['--proxy-auto-detect', '系统代理自动发现会绕过环境绑定'],
  ['--enable-automation', '会打开 navigator.webdriver'],
  ['--disable-web-security', '会破坏同源策略，且是强指纹特征'],
  ['--allow-running-insecure-content', '会破坏安全模型'],
  ['--ignore-certificate-errors', '会破坏安全模型，且是强指纹特征'],
  ['--disable-gpu', '会让 WebGL 退回软件渲染，和 webgl_config 声明的 vendor/renderer 冲突'],
  ['--disable-software-rasterizer', '会让 WebGL 直接不可用，和目标指纹冲突'],
  ['--headless', '无头模式由环境的 headless 字段决定'],
  ['--window-size', '窗口尺寸由屏幕指纹决定'],
  ['--window-position', '窗口位置由环境的 window_position 决定'],
  ['--profile-directory', '一个环境一个独立 profile 目录'],
  ['--incognito', '会关掉 cookie 落盘，环境持久化失效'],
]);

/** 把库里的 launch_args（数组 / JSON 字符串 / 多行字符串）统一成数组 */
export function parseLaunchArgs(value) {
  if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  const s = value.trim();
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed.map((x) => String(x).trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

function splitArg(arg) {
  const i = arg.indexOf('=');
  if (i < 0) return { key: arg.toLowerCase(), value: undefined };
  return { key: arg.slice(0, i).toLowerCase(), value: arg.slice(i + 1) };
}

function indexOfKey(args, key) {
  return args.findIndex((a) => a.toLowerCase() === key || a.toLowerCase().startsWith(`${key}=`));
}

function mergeCsv(args, key, values) {
  const i = indexOfKey(args, key);
  const current = i >= 0 && args[i].includes('=') ? args[i].slice(args[i].indexOf('=') + 1) : '';
  const merged = [...new Set([...current.split(',').map((s) => s.trim()).filter(Boolean), ...values])];
  const line = `${key}=${merged.join(',')}`;
  if (i >= 0) args[i] = line;
  else args.push(line);
  return merged;
}

/**
 * @param {string[]} baseArgs 系统生成的参数（顺序即优先级基线）
 * @param {string[]} userArgs 用户声明的 launch_args
 * @param {{proxyBound?:boolean, fileExists?:(p:string)=>boolean}} opts
 * @returns {{args:string[], applied:string[], rejected:{arg:string, reason:string}[], warnings:{field:string,message:string,severity:'soft'}[]}}
 */
export function mergeLaunchArgs(baseArgs, userArgs, { proxyBound = false, fileExists = null } = {}) {
  const args = [...baseArgs];
  const applied = [];
  const rejected = [];
  const warnings = [];

  for (const raw of parseLaunchArgs(userArgs)) {
    const { key, value } = splitArg(raw);

    if (PROTECTED.has(key)) {
      rejected.push({ arg: raw, reason: PROTECTED.get(key) });
      continue;
    }
    const rule = WHITELIST.get(key);
    if (!rule) {
      rejected.push({ arg: raw, reason: '不在白名单（只为确定性行为放行，见 docs/03）' });
      continue;
    }

    if (rule.kind === 'bypass') {
      if (proxyBound) {
        rejected.push({ arg: raw, reason: '绑定代理时禁止自定义 bypass，否则等于给直连开后门（fail-closed）' });
        continue;
      }
      mergeCsv(args, '--proxy-bypass-list', String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean));
      applied.push(raw);
      continue;
    }

    if (rule.kind === 'feature-list') {
      const items = String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!items.length) { rejected.push({ arg: raw, reason: '空的特性列表' }); continue; }

      // 这两条会把 navigator.webdriver 放出来，直接拒绝
      if (key === '--enable-blink-features' && items.some((x) => x === 'AutomationControlled')) {
        rejected.push({ arg: raw, reason: 'AutomationControlled 会暴露 navigator.webdriver' });
        continue;
      }
      if (key === '--disable-blink-features') {
        const kept = items.filter((x) => x !== 'AutomationControlled');
        if (kept.length !== items.length) {
          warnings.push({
            field: 'launch_args',
            message: `${raw} 里的 AutomationControlled 已忽略：那正是 navigator.webdriver 的来源`,
            severity: 'soft',
          });
        }
        if (!kept.length) { rejected.push({ arg: raw, reason: '去掉 AutomationControlled 后为空' }); continue; }
        mergeCsv(args, key, kept);
        applied.push(raw);
        continue;
      }
      mergeCsv(args, key, items);
      applied.push(raw);
      continue;
    }

    if (rule.kind === 'path-list') {
      const paths = String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!paths.length) { rejected.push({ arg: raw, reason: '缺少路径' }); continue; }
      const exists = typeof fileExists === 'function' ? fileExists : null;
      if (exists) {
        for (const p of paths) {
          if (!exists(p)) {
            warnings.push({ field: 'launch_args', message: `${key} 的路径不存在：${p}`, severity: 'soft' });
          }
        }
      }
      mergeCsv(args, key, paths);
      if (key === '--load-extension') {
        // Chrome 137 起 load-extension 默认被特性开关关掉，得显式把它关掉才算数
        mergeCsv(args, '--disable-features', ['DisableLoadExtensionCommandLineSwitch']);
      }
      applied.push(raw);
      continue;
    }

    if (rule.kind === 'flag') {
      if (value !== undefined) { rejected.push({ arg: raw, reason: `${key} 不接受值` }); continue; }
      if (indexOfKey(args, key) < 0) args.push(key);
      applied.push(raw);
    }
  }

  return { args, applied, rejected, warnings };
}