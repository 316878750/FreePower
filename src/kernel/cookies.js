/**
 * Cookie 的 CDP 读写 + 文本格式（P10）。
 *
 * 为什么只走内核：Chrome 的 cookie 在 user-data-dir 的 SQLite 里、值加密（DPAPI），
 * 硬解既不可靠也跨不了机器。所以「导入/导出」都要求环境在跑，走 CDP `Storage.*`：
 *   - `Storage.getCookies`  浏览器级，拿这个内核的全部 cookie；
 *   - `Storage.setCookies`  浏览器级，逐条写，**失败要能报到具体 name/domain**。
 * 环境没在跑就明确报错，**不为了导出偷偷起内核**（起内核 = 换进程、可能改 UA/代理，副作用太大）。
 *
 * 格式两种：
 *   - json：`[{name,value,domain,path,expires,httpOnly,secure,sameSite}]`
 *   - netscape：标准 cookies.txt（首行 `# Netscape HTTP Cookie File`，tab 分隔）
 *
 * 单位约定（写清楚，免得两边对不上）：
 *   - `expires` 对外一律是 **unix 秒**；session cookie 在 json 里是 `-1`，在 netscape 里是 `0`；
 *   - 导入时容忍毫秒（> 1e12 视为毫秒，除以 1000），也认 AdsPower/扩展常见的
 *     `sameSite: "no_restriction" | "lax" | "strict" | "unspecified"`。
 */

/** CDP 的 partitionKey（CHIPS 分区 cookie）→ 对外两种写法：CDP 形状 + AdsPower 兼容键 */
function publicPartition(c) {
  const pk = c && typeof c.partitionKey === 'object' && c.partitionKey ? c.partitionKey : null;
  const raw = String(pk?.topLevelSite ?? (typeof c?.partitionKey === 'string' ? c.partitionKey : '')).trim();
  if (!raw) return null;
  const site = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return {
    partitionKey: { topLevelSite: site, hasCrossSiteAncestor: !!pk?.hasCrossSiteAncestor },
    // AdsPower 导出里的键名叫 CookiePartitionKey，值是 `https://<host>`
    CookiePartitionKey: site,
  };
}

/** 落库/导出用的同一把尺子：CDP 的值 → 对外 JSON 形状 */
export function publicCookie(c) {
  const out = {
    name: String(c.name ?? ''),
    value: String(c.value ?? ''),
    domain: String(c.domain ?? ''),
    path: String(c.path || '/'),
    expires: c.session ? -1 : Math.round(Number(c.expires ?? -1)),
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
  };
  // CDP 对「未声明 sameSite」的 cookie 不返回该字段。**不补默认值**：
  // 补成 Lax 会把 unspecified 变成明确的 Lax（跨站场景「发」变「不发」），是改语义不是补字段。
  const sameSite = normalizeSameSite(c.sameSite);
  if (sameSite) out.sameSite = sameSite;
  const part = publicPartition(c);
  if (part) Object.assign(out, part);
  return out;
}

/** sameSite 两边都认：CDP 的 Strict/Lax/None + 扩展常见的 no_restriction/lax/unspecified */
export function normalizeSameSite(v) {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (!s || s === 'unspecified' || s === 'default' || s === 'null') return undefined;
  if (s === 'no_restriction' || s === 'no-restriction' || s === 'none') return 'None';
  if (s === 'lax') return 'Lax';
  if (s === 'strict') return 'Strict';
  return undefined;
}

/**
 * expires 归一化到 unix 秒。
 * @returns {number|undefined} 0/负数/空 → undefined（session cookie，不写 expires）
 */
export function normalizeExpires(v) {
  if (v === undefined || v === null || v === '') return undefined;
  let n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // 1e12 秒是公元 33658 年，现实里的秒值远到不了；超过就是毫秒（1.7e12 ≈ 2023 年）
  if (n > 1e12) n = n / 1000;
  return Math.floor(n);
}

/** 输入的一条 cookie（任何来源）→ CDP Storage.setCookies 的参数；字段缺失给可读原因 */
export function cdpCookieParam(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'cookie 必须是对象' };
  }
  const name = String(raw.name ?? '').trim();
  if (!name) return { error: 'name 为空' };
  let domain = String(raw.domain ?? '').trim();
  if (!domain && raw.url) {
    try { domain = new URL(String(raw.url)).hostname; } catch { /* 留在下面的报错里 */ }
  }
  if (!domain) return { error: 'domain 为空（也不认识 url）' };
  const param = {
    name,
    value: String(raw.value ?? ''),
    domain,
    path: String(raw.path || '/'),
    secure: !!raw.secure,
    httpOnly: !!raw.httpOnly,
  };
  const sameSite = normalizeSameSite(raw.sameSite);
  if (sameSite) param.sameSite = sameSite;
  const expires = normalizeExpires(raw.expires);
  if (expires !== undefined) param.expires = expires;
  // 分区 cookie：认 CDP 形状 `partitionKey{topLevelSite}`，也认 AdsPower 的 `CookiePartitionKey: "https://<host>"`
  const pkRaw = raw.partitionKey ?? raw.CookiePartitionKey;
  const site = String((pkRaw && typeof pkRaw === 'object' ? pkRaw.topLevelSite : pkRaw) ?? '').trim();
  if (site) param.partitionKey = { topLevelSite: /^https?:\/\//i.test(site) ? site : `https://${site}` };
  return { param, name, domain };
}

/** netscape cookies.txt → cookie 数组（解析不了的进 failed，不整批失败） */
export function parseNetscape(text) {
  const cookies = [];
  const failed = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!line.trim()) continue;
    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) {
      httpOnly = true;
      line = line.slice('#HttpOnly_'.length);
    } else if (line.trimStart().startsWith('#')) {
      continue; // 注释/首行标识
    }
    const f = line.split('\t');
    if (f.length < 7) {
      failed.push({ index: i + 1, name: f[5] || '', domain: f[0] || '', reason: '列数不足（需要 7 列 tab 分隔）' });
      continue;
    }
    const [domain, , path, secure, expires, name, ...rest] = f;
    cookies.push({
      name,
      value: rest.join('\t'),
      domain,
      path: path || '/',
      expires: Number(expires) || undefined,
      httpOnly,
      secure: String(secure).toUpperCase() === 'TRUE',
    });
  }
  return { cookies, failed };
}

/** cookie 数组 → 标准 cookies.txt（首行固定标识；httpOnly 用 #HttpOnly_ 前缀） */
export function formatNetscape(cookies = []) {
  const lines = ['# Netscape HTTP Cookie File', '# 由 FreePower 导出；环境在跑时从内核读取，过期时间为 unix 秒（0 = session）'];
  for (const c of cookies) {
    const domain = String(c.domain || '');
    const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const path = String(c.path || '/');
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expires = c.session || Number(c.expires) < 0 ? 0 : Math.round(Number(c.expires) || 0);
    const prefix = c.httpOnly ? '#HttpOnly_' : '';
    lines.push([`${prefix}${domain}`, includeSub, path, secure, expires, c.name, c.value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

/** 从运行中的内核读全部 cookie（调用方负责确认环境在跑） */
export async function readCookies(client) {
  const r = await client.send('Storage.getCookies');
  return (r.cookies || []).map(publicCookie);
}

/**
 * 逐条写入。一条坏 cookie 不能把整批打挂 —— 每条单独发，失败带 name/domain/reason。
 * @returns {{written:object[], failed:{name:string,domain:string,reason:string}[]}}
 */
export async function writeCookies(client, cookies = []) {
  const written = [];
  const failed = [];
  for (let i = 0; i < cookies.length; i++) {
    const raw = cookies[i];
    const mapped = cdpCookieParam(raw);
    if (mapped.error) {
      failed.push({
        index: i,
        name: String(raw?.name ?? ''),
        domain: String(raw?.domain ?? ''),
        reason: mapped.error,
      });
      continue;
    }
    try {
      await client.send('Storage.setCookies', { cookies: [mapped.param] });
      written.push({ name: mapped.name, domain: mapped.domain });
    } catch (e) {
      failed.push({ index: i, name: mapped.name, domain: mapped.domain, reason: e.message });
    }
  }
  return { written, failed };
}

/**
 * 导入后的回读校验：按 name+domain 数一遍还在不在。
 * 返回缺失清单（调用方把它写进 warnings，而不是假装成功）。
 */
export function missingAfterWrite(written, cookiesNow) {
  const key = (c) => `${c.name}|${String(c.domain || '').replace(/^\./, '')}`;
  const have = new Set(cookiesNow.map(key));
  return written.filter((c) => !have.has(key(c)));
}

/* ========================================================================
 * 还原 / 合并（0.4.3 ③ 批量菜单）
 *
 * 两种语义必须分清，**不能做成一个「导入」按钮**：
 *   还原（restore） = **覆盖**：目标状态就是文件里那份 —— 文件里有的写进去、库里多出来的删掉；
 *   合并（merge）   = **并集**：只补文件里有、库里没有的；**同名以现有为准**（不覆盖登录态）。
 *
 * 两个都先 `plan` 再 `apply`：plan 只读、回「会加几条/改几条/删几条」，
 * 用户看过预览、显式确认之后才写。**不许一键静默改登录态。**
 *
 * 预览里**不带 cookie 的值**：它是登录凭据，界面上不该出现、日志里更不该。
 * ====================================================================== */

/** cookie 的身份：name + domain(去前导点、小写) + path + 分区（CHIPS） */
export function cookieKey(c = {}) {
  const domain = String(c.domain || '').replace(/^\./, '').toLowerCase();
  const path = String(c.path || '/');
  const pk = c.partitionKey && typeof c.partitionKey === 'object'
    ? String(c.partitionKey.topLevelSite || '')
    : String(c.CookiePartitionKey || c.partitionKey || '');
  return `${c.name || ''}|${domain}|${path}|${pk}`;
}

/** 值以外还影响语义的字段；任何一个变了都算「改」 */
function cookieSignature(c = {}) {
  return [
    String(c.value ?? ''),
    Number(c.expires ?? -1),
    c.httpOnly ? '1' : '0',
    c.secure ? '1' : '0',
    String(normalizeSameSite(c.sameSite) || ''),
  ].join('\u0000');
}

/** 预览里一条 cookie 的可读摘要（**不含 value**） */
function cookieBrief(c = {}) {
  return { name: String(c.name ?? ''), domain: String(c.domain ?? ''), path: String(c.path || '/') };
}

/**
 * 算出写入计划。**纯函数**，不碰内核、不写任何东西。
 * @param {object[]} existing 现在内核里的 cookie（`readCookies` 的返回）
 * @param {object[]} incoming 要写进去的 cookie
 * @param {'restore'|'merge'} mode
 */
export function planCookieWrite(existing = [], incoming = [], mode = 'restore') {
  const target = mode === 'merge' ? 'merge' : 'restore';
  const have = new Map();
  for (const c of existing) have.set(cookieKey(c), c);

  const add = [];
  const update = [];
  const keep = [];
  const unchanged = [];
  const invalid = [];
  const incomingKeys = new Set();

  incoming.forEach((raw, index) => {
    const mapped = cdpCookieParam(raw);
    if (mapped.error) {
      invalid.push({ index, name: String(raw?.name ?? ''), domain: String(raw?.domain ?? ''), reason: mapped.error });
      return;
    }
    // 写进去的形状（CDP 参数）→ 用它算身份，保证「预览里说要写的」和「真写进去的」一致
    const param = mapped.param;
    const key = cookieKey(param);
    incomingKeys.add(key);
    const cur = have.get(key);
    if (!cur) { add.push({ ...cookieBrief(param), entry: param }); return; }
    if (cookieSignature(cur) === cookieSignature(param)) { unchanged.push(cookieBrief(param)); return; }
    if (target === 'merge') {
      // 合并：同名以**现有**为准，冲突只记账、不覆盖（登录态不能被悄悄换成另一份）
      keep.push({ ...cookieBrief(param), value_differs: true });
      return;
    }
    update.push({ ...cookieBrief(param), value_changed: String(cur.value ?? '') !== String(param.value ?? ''), entry: param });
  });

  const del = [];
  if (target === 'restore') {
    for (const [key, c] of have) {
      if (incomingKeys.has(key)) continue;
      del.push(cookieBrief(c));
    }
  }

  return {
    mode: target,
    existing_total: existing.length,
    incoming_total: incoming.length,
    will_add: add.length,
    will_update: update.length,
    will_delete: del.length,
    /** 合并模式下与现有同名、按「现有优先」保留的条数 */
    will_keep: keep.length,
    unchanged: unchanged.length,
    invalid,
    /** 给界面预览用：每类最多列 20 条（不含 value） */
    sample: {
      add: add.slice(0, 20).map(({ entry, ...rest }) => rest),
      update: update.slice(0, 20).map(({ entry, ...rest }) => rest),
      delete: del.slice(0, 20),
    },
    /* 内部用：apply 直接拿这几组去写/删，别在外面再算一遍（算两遍必然漂移） */
    _write: [...add, ...update].map((x) => x.entry),
    _delete: target === 'restore' ? existing.filter((c) => !incomingKeys.has(cookieKey(c))) : [],
  };
}

/**
 * 逐条比对两个 cookie 集合（0.4.7 ①：撤销合并之后**证明**真的回到了合并前）。
 *
 * 为什么必须比到这个粒度：撤销最容易糊弄自己的地方就是「条数对上了」——
 * 合并时新增 3 条、撤销时删掉 3 条，条数一样，但被覆盖的那条 `value` 可能还是新值。
 * 所以身份用 `cookieKey`（name + domain + path + 分区），**并且逐条比 `value`**。
 *
 * 返回里的三个数组**不带 value**（那是登录凭据）：只回 name/domain/path，够定位、不够泄露。
 *
 * @param {object[]} expected 期望的集合（合并前的快照）
 * @param {object[]} actual 现在的集合（撤销后从内核读回的）
 * @returns {{ok:boolean, expected_total:number, actual_total:number,
 *            missing:object[], extra:object[], changed:object[]}}
 */
export function compareCookieSets(expected = [], actual = []) {
  const index = (list) => {
    const m = new Map();
    for (const c of list) m.set(cookieKey(c), c);
    return m;
  };
  const want = index(expected);
  const have = index(actual);
  const brief = (c) => ({
    name: String(c.name ?? ''),
    domain: String(c.domain ?? ''),
    path: String(c.path || '/'),
  });
  const missing = [];
  const changed = [];
  const extra = [];
  for (const [key, c] of want) {
    const cur = have.get(key);
    if (!cur) { missing.push(brief(c)); continue; }
    if (String(cur.value ?? '') !== String(c.value ?? '')) changed.push(brief(c));
  }
  for (const [key, c] of have) if (!want.has(key)) extra.push(brief(c));
  return {
    ok: missing.length === 0 && changed.length === 0 && extra.length === 0,
    expected_total: want.size,
    actual_total: have.size,
    missing,
    extra,
    changed,
  };
}

/**
 * 删 cookie：`Network.deleteCookies` 是**页面级**方法，所以要借一个页面会话。
 * 一条失败不拖整批（失败带 name/domain/reason 回来）。
 */
export async function deleteCookies(client, cookies = []) {
  if (!cookies.length) return { deleted: [], failed: [] };
  let sessionId = null;
  try {
    const { targetInfos = [] } = await client.send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
    if (!page) throw new Error('没有可用的页面会话（删 cookie 需要页面级 CDP 会话）');
    ({ sessionId } = await client.send('Target.attachToTarget', { targetId: page.targetId, flatten: true }));
  } catch (e) {
    return {
      deleted: [],
      failed: cookies.map((c) => ({ ...cookieBrief(c), reason: `拿不到页面会话：${e.message}` })),
    };
  }
  const deleted = [];
  const failed = [];
  for (const c of cookies) {
    const mapped = cdpCookieParam(c);
    if (mapped.error) { failed.push({ ...cookieBrief(c), reason: mapped.error }); continue; }
    const param = { name: mapped.param.name, domain: mapped.param.domain, path: mapped.param.path };
    if (mapped.param.partitionKey) param.partitionKey = mapped.param.partitionKey;
    try {
      await client.send('Network.deleteCookies', param, sessionId);
      deleted.push(cookieBrief(c));
    } catch (e) {
      failed.push({ ...cookieBrief(c), reason: e.message });
    }
  }
  return { deleted, failed };
}

/**
 * 按计划执行写入：先删（只有还原模式会删），再写。
 * 顺序有讲究：先删再写，最后状态才是「文件里那份」；反过来的话刚写进去的会被删掉。
 */
export async function applyCookiePlan(client, plan) {
  const del = await deleteCookies(client, plan._delete || []);
  const written = await writeCookies(client, plan._write || []);
  return { deleted: del, written };
}
