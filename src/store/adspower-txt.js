/**
 * AdsPower「环境导出」的 `.txt` 块格式（P10，逆向实测 8.9.23）。
 *
 * 文件长这样（单文件、LF、无 BOM、无版本号）：
 *
 *   acc_id=10001
 *   id=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 *   group=0
 *   name=env-a
 *   remark=
 *   platform=facebook.com
 *   username=acc
 *   password=pw
 *   fakey=
 *   cookie=[{"domain":".facebook.com",...}]
 *   proxytype=http
 *   ipchecker=ipapi
 *   proxy=198.51.100.10:1080:proxyuser:proxypass
 *   proxyurl=
 *   proxyid=px_xxx
 *   ip=203.0.113.7
 *   countrycode=US
 *   ua=Mozilla/5.0 ...
 *   ******************
 *
 * 关键事实（都来自实测，不自己发明）：
 *   - 18 个字段、块尾 18 个星号；`=` 只切第一个，空值是合法值；
 *   - `proxy` 是**一整个字符串** `host:port:user:pass`（无认证时 `host:port`）；密码可含 `:`；
 *   - `cookie` 是**对象数组**（不是 `a=b; c=d` 文本），只有它需要 `JSON.parse`；
 *   - `platform` 是站点域名（对应我们的 `domain_name`），不是 navigator.platform；
 *   - 这是一张「账号 + 代理 + cookie + UA」的**搬运单，不是环境全量备份**：
 *     指纹配置（四个种子、字体、媒体、时区、屏幕、open_urls…）一个都不在里面。
 *     保真备份请用我们的 JSON 导出。
 */

export const ADP_FIELDS = [
  'acc_id', 'id', 'group', 'name', 'remark', 'platform', 'username', 'password', 'fakey', 'cookie',
  'proxytype', 'ipchecker', 'proxy', 'proxyurl', 'proxyid', 'ip', 'countrycode', 'ua',
];

export const ADP_BLOCK_SEP = '*'.repeat(18);

/** AdsPower 的 proxytype 值 → 我们的 proxy_type（认不出的原样小写交给下游，下游会兜底 http） */
function proxyTypeOf(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return undefined;
  if (s === 'socks5' || s === 'socks') return 'socks5';
  if (s === 'https') return 'https';
  if (s === 'http') return 'http';
  return s;
}

/** 一块 key=value → 我们的导入项（再交给 normalizeImportItem 统一走字段表/validate） */
function blockToItem(block) {
  const warnings = [];
  const item = {};
  const put = (k, v) => { if (v !== undefined && v !== null && String(v) !== '') item[k] = v; };

  put('name', String(block.name || '').trim());
  put('remark', block.remark);
  put('domain_name', String(block.platform || '').trim()); // AdsPower 的 platform = 站点域名
  put('username', block.username);
  put('password', block.password);
  put('fakey', block.fakey);
  put('ua', block.ua);
  put('ip', block.ip);
  put('ip_country', String(block.countrycode || '').trim());
  put('ipchecker', String(block.ipchecker || '').trim());
  put('proxy_id', String(block.proxyid || '').trim());

  const pt = proxyTypeOf(block.proxytype);
  if (pt) item.proxy_type = pt;
  // 代理字符串原样交给 normalizeImportItem 里的 parseProxyString（host:port[:user:pass]），
  // 只把我们自己写出去的密码 `%3A` 还原成 `:` —— 对方真实导出里密码的 `:` 是原样出现的，
  // 那条路径靠 parseProxyString 的「其余全归密码」兜住，不走这个解码。
  const rawProxy = typeof block.proxy === 'string' ? block.proxy.trim() : block.proxy;
  put('proxy', typeof rawProxy === 'string' ? decodeProxyPasswordInLine(rawProxy) : rawProxy);

  // 分组：AdsPower 里是**分组名**，我们是分组 id。纯数字才认，否则进默认分组并告警
  const g = String(block.group ?? '').trim();
  if (g && /^\d+$/.test(g)) item.group_id = g;
  else if (g) warnings.push(`分组「${g}」不是数字 id，已放入默认分组（可在控制台再指派）`);

  // cookie：只有它需要 JSON.parse，且必须是对象数组
  const rawCookie = block.cookie;
  if (typeof rawCookie === 'string' && rawCookie.trim()) {
    try {
      const parsed = JSON.parse(rawCookie);
      if (Array.isArray(parsed)) item.cookie = parsed;
      else warnings.push('cookie 不是 JSON 数组（已忽略；账号仍会导入）');
    } catch {
      warnings.push('cookie 不是合法 JSON（已忽略；账号仍会导入）');
    }
  }

  // 键集合不全不许整批失败：缺了就点名（空值 `key=` 是合法值，不算缺）
  if (!('ua' in block)) warnings.push('缺少字段 ua（已按默认 UA 建库，与你文件里那条不一致）');
  // `ua=` 空值也是合法值，但空 UA 建不了库，只能补默认 —— 这也得说一声
  else if (!String(block.ua || '').trim()) warnings.push('ua 是空值（已按默认 UA 建库，与你文件里那条不一致）');
  if (!('platform' in block)) warnings.push('缺少字段 platform（站点域名为空）');
  if (!('cookie' in block)) warnings.push('缺少字段 cookie（该环境不带登录 cookie）');
  return { item, warnings };
}

/**
 * `.txt` 全文 → 原始块数组（只按「行/星号/第一个 =」切，不解释字段）。
 * 空行不结束块（块尾靠星号行）；不是 `key=value` 的行当作上一字段的续行。
 *
 * 三条容错（逆向实测基线：50 块 × 19 行 = 950 行、空值行 350、cookie 行含几十个 `=`）：
 *   1. `=` 只切第一个，右边整段是值；
 *   2. `key=` 是合法值（空串），不丢字段；
 *   3. 不依赖字段顺序。
 */
function parseBlocks(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const blocks = [];
  const warnings = [];
  let block = null;
  let pendingKey = null;

  const flush = () => {
    if (block && Object.keys(block).length) blocks.push(block);
    block = null;
    pendingKey = null;
  };

  for (const line of src.split('\n')) {
    if (/^\*{10,}$/.test(line.trim())) { flush(); continue; }
    if (!line.trim()) continue;
    const eq = line.indexOf('=');
    if (eq < 0) {
      if (block && pendingKey) block[pendingKey] += `\n${line}`;
      else warnings.push(`跳过无法识别的一行：${line.trim().slice(0, 60)}`);
      continue;
    }
    if (!block) block = {};
    const key = line.slice(0, eq).trim();
    block[key] = line.slice(eq + 1);
    pendingKey = key;
  }
  flush();
  return { blocks, warnings };
}

/**
 * `.txt` 全文 → 导入项数组（能建就建：缺字段/代理切不出来只告警，整块没有 name 才进 failed）。
 *
 * `itemBlockIndex`：第 i 个 item 来自第几块（0 基）。为什么要有它 —— 有的块因为缺 name
 * 根本没进 items，之后 `importProfiles` 报的 `index` 是**项号**，直接当块号会错位；
 * 界面还要把「本批第几块」换算成「整份文件第几块」（分批导入时）。
 * @returns {{items:object[], itemBlockIndex:number[], failed:{index:number,reason:string}[], warnings:string[]}}
 */
export function parseAdspowerTxt(text) {
  const { blocks, warnings } = parseBlocks(text);
  const items = [];
  const itemBlockIndex = [];
  const failed = [];
  blocks.forEach((block, i) => {
    if (!String(block.name || '').trim()) {
      failed.push({ index: i, reason: '缺少 name（整块无法建环境）' });
      return;
    }
    const r = blockToItem(block);
    // 块号从 1 开始（和用户看文件的行/块一致）
    for (const w of r.warnings) warnings.push(`第 ${i + 1} 块：${w}`);
    items.push(r.item);
    itemBlockIndex.push(i);
  });
  return { items, itemBlockIndex, failed, warnings };
}

/**
 * AdsPower 的 sameSite 是**四值词汇**（实测 73,573 条分布 no_restriction/lax/strict/unspecified），
 * 不是 CDP 的 `None/Lax/Strict`；内核没给（未声明）必须写 `unspecified`，不许默认成 `lax`。
 */
const ADP_SAME_SITE = {
  none: 'no_restriction',
  no_restriction: 'no_restriction',
  'no-restriction': 'no_restriction',
  lax: 'lax',
  strict: 'strict',
  unspecified: 'unspecified',
  default: 'unspecified',
  '': 'unspecified',
};

function sameSiteForTxt(v) {
  return ADP_SAME_SITE[String(v ?? '').trim().toLowerCase()] || 'unspecified';
}

/** 我们存的 cookie（JSON 数组串）→ AdsPower 的 cookie 对象数组 */
function cookieForTxt(profile, issues = []) {
  const s = String(profile.cookie ?? '').trim();
  if (!s) return '';
  try {
    const parsed = JSON.parse(s);
    if (!Array.isArray(parsed)) return '';
    const domain = String(profile.domain_name || '');
    const out = parsed.map((x) => {
      if (x && typeof x === 'object' && !Array.isArray(x)) {
        // 数值码不映射（那是对手内部镜像形状），但**不许静默**：点名后按 unspecified 写
        if (typeof x.sameSite === 'number') {
          issues.push(`cookie「${String(x.name || '?')}」的 sameSite 是数值码 ${x.sameSite}，已按 unspecified 写出（未知数值码不做映射）`);
        }
        return { ...x, sameSite: sameSiteForTxt(x.sameSite) };
      }
      // 老数据是 `sid=xxx; uid=7` 文本 → 拆成对象，domain 用站点域名（没有就留空）
      const m = /^\s*([^=;]+)=([^;]*)\s*$/.exec(String(x));
      if (!m) return null;
      return {
        domain,
        expires: -1,
        httpOnly: false,
        name: m[1].trim(),
        path: '/',
        sameSite: 'unspecified',
        secure: false,
        session: true,
        value: m[2],
      };
    }).filter(Boolean);
    return out.length ? JSON.stringify(out) : '';
  } catch { return ''; }
}

/**
 * 代理行：**同一字段两套规则，不要统一**（写在注释里，免得以后有人来「顺手一致化」）。
 *
 *   - JSON 导出/导入：`host:port:user:pass` **原样保真**，密码里的 `:` 保留。我们的解析器
 *     认「前 3 段定宽、其余全归密码」，所以 JSON 往返无损。
 *   - AdsPower `.txt`：对方 150/150 块**恒 4 段**（逆向实测），密码里带 `:` 会被写成 6 段，
 *     对方多半按 4 段切 → 密码截断 → 导入成功但认证失败（最难查的一类）。所以 txt 里
 *     把密码的 `:` 写成 `%3A`（仍是 4 段），并在 warnings 里点名「导入后代理认证可能失败」。
 *     我们自己读回时会把 `%3A` 还原成 `:`，所以「自己导出 → 自己导入」仍然无损。
 */
function encodeProxyPassword(pass) {
  return String(pass).replace(/:/g, '%3A');
}

/** 读回时的还原：只处理第 4 段之后的密码部分（前 3 段是 host/port/user，不动） */
function decodeProxyPasswordInLine(line) {
  const s = String(line ?? '');
  if (s.indexOf('%3A') < 0) return s;
  const parts = s.split(':');
  if (parts.length < 4) return s;
  return [...parts.slice(0, 3), parts.slice(3).join(':').replace(/%3A/g, ':')].join(':');
}

/**
 * 代理对象 → AdsPower 的 `host:port:user:pass`（无认证 `host:port`）。
 * @param {object} p 环境
 * @param {{forTxt?: boolean}} [opt] `forTxt: true` 时按对手的 4 段形状写（密码 `:` 转 `%3A`）
 */
export function proxyLineOf(p, { forTxt = false } = {}) {
  const px = p.proxy_config || p.user_proxy_config || {};
  const host = String(px.host || px.proxy_host || '').trim();
  if (!host) return '';
  const port = Number(px.port || px.proxy_port) || 0;
  const user = String(px.username || px.proxy_user || '');
  const pass = String(px.password || px.proxy_password || '');
  if (!port) return host;
  if (!user && !pass) return `${host}:${port}`;
  return `${host}:${port}:${user}:${forTxt ? encodeProxyPassword(pass) : pass}`;
}

/** 一条环境的 18 个字段值（写出去之前的样子） */
function blockValues(p, issues = []) {
  const px = p.proxy_config || p.user_proxy_config || {};
  const pass = String(px.password || px.proxy_password || '');
  if (pass.includes(':')) {
    issues.push('代理密码含冒号，AdsPower 导出格式无法表示（只能 4 段），导入后代理认证可能失败');
  }
  const name = String(p.name ?? '');
  if (name.length >= 100) {
    issues.push('name 已达 100 字符上限（创建/导入时截断过的话，导出的是截断后的值；对方再导入也是这个长度）');
  }
  return {
    acc_id: p.profile_no ?? '',
    id: p.profile_id || p.id || '',
    // group：AdsPower 真实导出 150/150 恒空（我们存的是分组 id）。txt 写空串，
    // JSON 里仍然保留 group_id —— 两种格式不合并（分组语义只在我们的库里成立）
    group: '',
    name,
    remark: p.remark ?? '',
    platform: p.domain_name ?? '',
    username: p.username ?? '',
    password: p.password ?? '',
    fakey: p.fakey ?? '',
    cookie: cookieForTxt(p, issues),
    proxytype: String(px.proxy_type || px.type || 'http'),
    ipchecker: p.ipchecker ?? '',
    proxy: proxyLineOf(p, { forTxt: true }),
    proxyurl: '',
    proxyid: p.proxy_id ?? '',
    ip: p.ip ?? '',
    // countrycode：真实导出 150/150 全小写（我们库里是 `US`）→ txt 小写，JSON 保持原样
    countrycode: String(p.ip_country ?? '').trim().toLowerCase(),
    ua: p.ua ?? '',
  };
}

/**
 * 值里的换行必须处理：块是「一行一字段」，`name`/`remark` 里带 `\n` 就会写出几行假字段，
 * 这份文件随即解析不回来，而且看起来是「格式变了」不是「数据脏了」。统一替成一个空格并计数。
 * **cookie 不走这里**：它是 `JSON.stringify` 出来的单行，换行已被转义成 `\n` 两个字符。
 */
function flattenNewlines(v, stats) {
  const s = String(v ?? '');
  if (!/[\r\n]/.test(s)) return s;
  stats.newlines += 1;
  return s.replace(/[\r\n]+/g, ' ');
}

/**
 * 写出后立刻按同一套解析器读回来自校验：块数、18 键、cookie 可 JSON.parse、proxy 四段一致。
 * 失败直接抛错（路由翻成非 0 code），绝不输出半坏的文件。
 */
function selfCheck(content, expected) {
  const { blocks } = parseBlocks(content);
  if (blocks.length !== expected.length) {
    throw new Error(`自校验失败：写出去 ${expected.length} 块，读回来 ${blocks.length} 块`);
  }
  blocks.forEach((b, i) => {
    const keys = Object.keys(b);
    if (keys.length !== ADP_FIELDS.length) {
      throw new Error(`自校验失败：第 ${i + 1} 块有 ${keys.length} 个键（应为 ${ADP_FIELDS.length}）`);
    }
    for (const k of ADP_FIELDS) {
      if (b[k] !== String(expected[i][k] ?? '')) {
        throw new Error(`自校验失败：第 ${i + 1} 块字段 ${k} 读回不一致`);
      }
    }
    if (b.cookie) {
      let arr;
      try { arr = JSON.parse(b.cookie); } catch { throw new Error(`自校验失败：第 ${i + 1} 块 cookie 不是合法 JSON`); }
      if (!Array.isArray(arr)) throw new Error(`自校验失败：第 ${i + 1} 块 cookie 不是数组`);
    }
  });
}

/** 一条环境 → AdsPower 的一块文本（字段顺序按实测） */
export function formatAdspowerBlock(p) {
  const v = blockValues(p, []);
  const stats = { newlines: 0 };
  return ADP_FIELDS.map((k) => `${k}=${k === 'cookie' ? v[k] : flattenNewlines(v[k], stats)}`).join('\n');
}

/**
 * 多条环境 → 整份 `.txt`（每块以 18 个星号收尾，最后一块之后也有星号行，结尾一个换行）。
 *
 * `warnings` 里每条都带块号（「第 N 块：…」），因为用户要能拿着告警去文件里定位：
 *   - 换行被替换（会改变值本身）；
 *   - 代理密码含冒号（对方格式只能 4 段，导入后认证可能失败）；
 *   - cookie 的 sameSite 是未知数值码（按 unspecified 写，不静默）；
 *   - name 已到 100 字符上限（存储层截断过的话，导出的就是截断值）。
 * @returns {{content:string, warnings:string[]}}
 */
export function formatAdspowerTxt(profiles = []) {
  const stats = { newlines: 0 };
  const warnings = [];
  const expected = profiles.map((p, i) => {
    const issues = [];
    const v = blockValues(p, issues);
    for (const w of issues) warnings.push(`第 ${i + 1} 块：${w}`);
    const out = {};
    for (const k of ADP_FIELDS) out[k] = k === 'cookie' ? v[k] : flattenNewlines(v[k], stats);
    return out;
  });
  const content = expected
    .map((v) => `${ADP_FIELDS.map((k) => `${k}=${v[k]}`).join('\n')}\n${ADP_BLOCK_SEP}`)
    .join('\n') + '\n';
  selfCheck(content, expected);
  if (stats.newlines) warnings.unshift(`${stats.newlines} 个字段的换行已替换为空格（该格式一行一字段）`);
  return { content, warnings };
}

/** AdsPower 的文件名：`profiles_YYYY_MM_DD_HH_mm_ss.txt`（本地时间） */
export function txtFilename(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `profiles_${d.getFullYear()}_${p(d.getMonth() + 1)}_${p(d.getDate())}_${p(d.getHours())}_${p(d.getMinutes())}_${p(d.getSeconds())}.txt`;
}
