/**
 * 假字段静态不变式（0.4.6）—— **「界面上能配、但全仓库没人读」这件事，从今往后由判据兜住。**
 *
 * 为什么要这条：0.4.5 之前有 48 个字段能在编辑页填/切、能存进库，却没有任何一行代码读它去改变
 * 浏览器行为（`docs/21-FreePower实现清单.md` §5）。用户配了以为生效，实际什么都没发生 ——
 * 这是「每次等用户使用中发现问题」的根源。以前只有一份人工清单，没人能保证它不再长回来。
 *
 * 这条判据一共三组，都是**可证伪**的：
 *
 *   A · 可配但无消费 → 红
 *     表单里**没被禁用**的字段（用户真的能改），必须在「行为层」被读到，否则就是假字段。
 *     唯一出路两种：接上消费路径，或在 `overrides.mjs` 的 `METADATA` 里**逐条列名**豁免
 *     （带 `why` + `site`，`site` 会被核对真的存在 —— 不许拿通配当后门）。
 *
 *   B · 灰了但没理由 → 红
 *     表单里被禁用的字段（空转 / 云端专属），必须有**用户看得懂的「本版不支持」文案**：
 *     键集必须与禁用集**恰好相等**，文案里不许有黑话（`未实现` / `零读取` / `字段表` …），
 *     且 `web/pages/edit.js` 必须真的把它渲染成可见文字（不是 `title`）。
 *
 *   C · 本轮接上的字段：消费路径必须还在（删掉就红，防「接线又被回退」）。
 *
 * 「行为层」的口径与 `test/unit.test.mjs` 的 `KERNEL_LAYERS` 一致：
 *   - 算：kernel / runtime / fingerprint/view / proxy / sync / agent（读了会改变内核或页面行为）
 *   - 不算：`src/api/*`、`src/store/*`（传输与持久化）、`src/selfcheck/*`（喂自检的声明值）、
 *           `src/fingerprint/generate.js`（只写默认值）
 * 之所以「不算」是诚实问题：`routes.js` 里出现 40 次 `fakey`，证明的是「这个字段能存能取」，
 * 不证明它对浏览器有任何影响。
 *
 * 跑法：`node --no-warnings test/fields-invariant.test.mjs`（在 `npm test` 链里）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { profileFormSchema } from '../src/api/schema.js';
import { FIELDS } from '../packages/profile/src/fields.js';
import * as OVERRIDES from '../packages/profile/reference/overrides.mjs';

/**
 * 为什么用 `import * as` + 兜底空对象：这条判据的价值一半在「先红后绿」——
 * 把**同一个文件**丢进 0.4.5 的检出目录里跑，它必须能直接给出「哪 48 个字段是假的」，
 * 而不是在 import 阶段就 SyntaxError（那时候 overrides.mjs 里还没有这两张表）。
 * 缺表 → 空对象 → A 组立刻把可配字段全点名、B 组因为「禁用没理由」也红。
 * 在**当前**树上这两张表都在，兜底不会掩盖问题（B 的「键集恰好相等」会先响）。
 */
const UNSUPPORTED = OVERRIDES.UNSUPPORTED || {};
const METADATA = OVERRIDES.METADATA || {};

const ROOT = new URL('../', import.meta.url);

/** 行为层：读到它 = 内核/页面行为真的可能不同 */
const BEHAVIOR_LAYERS = [
  'src/kernel/chrome.js', 'src/kernel/launch-args.js', 'src/kernel/inject.js', 'src/kernel/net-rules.js',
  'src/kernel/cookies.js', 'src/kernel/cdp.js', 'src/kernel/version.js', 'src/kernel/block-page.js',
  'src/kernel/extensions.js', 'src/kernel/download.js',
  'src/runtime/manager.js', 'src/runtime/batch.js', 'src/runtime/prefs.js',
  'src/fingerprint/view.js',
  'src/proxy/chain.js', 'src/proxy/pac.js', 'src/proxy/egress.js', 'src/proxy/health.js', 'src/proxy/probe.js',
  'src/sync/session.js', 'src/sync/window.js', 'src/sync/arrange.js', 'src/sync/show.js',
  'src/agent/task.js', 'src/agent/workflow.js',
];

/** 去掉注释（整行注释 + 行尾 `//`；含 `://` 的行整行保留，别把 URL 后面的代码切掉） */
function stripComments(src) {
  return src.split('\n').map((line) => {
    const t = line.trim();
    if (!t) return '';
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
    if (line.includes('://')) return line;
    const m = /\s\/\//.exec(line);
    return m ? line.slice(0, m.index) : line;
  }).join('\n');
}

const cache = new Map();
function text(file) {
  if (!cache.has(file)) {
    const p = new URL(file, ROOT);
    cache.set(file, fs.existsSync(p) ? stripComments(fs.readFileSync(p, 'utf8')) : '');
  }
  return cache.get(file);
}

/**
 * 属性读取点：`.字段名` 或 `['字段名']`。
 * 不用「整词出现」：那样 `tls` 会撞上 `import tls from 'node:tls'`、`gpu_switch` 会撞上
 * `webgpu_switch`、`device_name` 会撞上 `device_name_switch` —— 全是子串误报。
 */
function readSites(fieldName) {
  const esc = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:\\.\\s*${esc}(?![\\w$])|\\[\\s*['"]${esc}['"]\\s*\\])`);
  const hits = [];
  for (const f of BEHAVIOR_LAYERS) {
    text(f).split('\n').forEach((line, i) => { if (re.test(line)) hits.push(`${f}:${i + 1}`); });
  }
  return hits;
}

/** 黑话 / 空话：用户读不懂的说法，或等于没说的说法 */
const JARGON = ['未实现', '暂不支持', '零读取', '字段表', 'inert', '消费', 'grep', 'TODO'];

const form = profileFormSchema();
const formNames = new Set(form.fields.map((f) => f.name));

/* ============================================================================
 * A · 可配但无消费 → 红
 * ==========================================================================*/

test('不变式 A：表单里能改的字段，必须真有一行代码读它（否则就是假字段）', () => {
  const configurable = form.fields.filter((f) => !f.disabled);
  assert.ok(configurable.length > 0, '一个可配字段都没有，这条判据失去意义');

  const fake = [];
  for (const f of configurable) {
    if (METADATA[f.name]) continue;
    // HIDDEN 字段不进表单，这里也进不来；只读展示那份单独由下面的 test 钉
    if (readSites(f.name).length === 0) fake.push(f.name);
  }
  assert.deepEqual(fake, [],
    `这 ${fake.length} 个字段在界面上能配、但行为层一次都没读（配了不会生效）：${fake.join(', ')}`);
});

test('不变式 A′：豁免清单逐条列名 + 有证据，不许通配', () => {
  const names = Object.keys(METADATA);

  // ① 每条都要有 why 与 site，且 why 不能糊弄
  for (const [n, m] of Object.entries(METADATA)) {
    assert.ok(String(m.why || '').trim().length >= 8, `${n}: 豁免必须写清「为什么不改变行为」`);
    assert.ok(String(m.site || '').includes('#'), `${n}: 豁免必须给证据锚 \`<文件>#<代码里真有的串>\``);
  }

  // ② 每个 site 真的在仓库里存在 —— 豁免是**有证据的豁免**，不是白名单
  const bad = [];
  for (const [n, m] of Object.entries(METADATA)) {
    const [file, symbol] = String(m.site).split('#');
    if (!file || !symbol) { bad.push(`${n}: 锚格式错 ${m.site}`); continue; }
    if (!fs.existsSync(new URL(file, ROOT))) { bad.push(`${n}: 锚指向不存在的文件 ${file}`); continue; }
    if (!text(file).includes(symbol)) bad.push(`${n}: ${file} 里已经没有 "${symbol}"`);
  }
  assert.deepEqual(bad, [], '豁免的证据锚点对不上代码');

  // ③ 豁免的字段必须真的还留在表单里、且真的可配（禁用了就不该占豁免名额）
  assert.deepEqual(names.filter((n) => !formNames.has(n)), [], '豁免清单里有字段表已经不存在的字段');
  const disabled = new Set(form.fields.filter((f) => f.disabled).map((f) => f.name));
  assert.deepEqual(names.filter((n) => disabled.has(n)), [], '这些字段已经被禁用了，不该再占豁免名额');

  // ④ 数量钉死：加一个豁免必须来改这条（上面四条断言就是「加之前先反驳」的门槛）
  assert.equal(names.length, 8, `豁免字段 ${names.length} 个：${names.join(',')} —— 新增请先证明它不改变浏览器行为`);
});

/* ============================================================================
 * B · 灰了但没理由 → 红
 * ==========================================================================*/

test('不变式 B：每个禁用的控件都必须有一句用户看得懂的理由（不许 hover 才有）', () => {
  const disabled = form.fields.filter((f) => f.disabled).map((f) => f.name).sort();
  const reasons = Object.keys(UNSUPPORTED).sort();

  // ① 键集必须恰好相等：禁用没理由、或有理由却没禁用，都是红
  assert.deepEqual(disabled.filter((n) => !UNSUPPORTED[n]), [],
    '这些字段被禁用了，却没有「本版不支持」的原因');
  assert.deepEqual(reasons.filter((n) => !disabled.includes(n)), [],
    '这些字段写了原因，但表单里并没有禁用它们（原因会没人看得到）');

  // ② 文案本身：不许黑话、不许空话、必须说清「本版会怎样」
  for (const [n, why] of Object.entries(UNSUPPORTED)) {
    assert.ok(String(why).trim().length >= 8, `${n}: 原因太短，等于没说`);
    const hit = JARGON.filter((w) => String(why).includes(w));
    assert.deepEqual(hit, [], `${n}: 原因里有黑话/空话 ${hit.join(',')} —— 写成用户能懂的一句话`);
  }

  // ③ 文案要真的被渲染成**可见文字**：edit.js 必须用 unsupportedLine 拼出「本版不支持 · 」
  const editJs = fs.readFileSync(new URL('web/pages/edit.js', ROOT), 'utf8');
  assert.match(editJs, /本版不支持 · /, 'edit.js 没有渲染「本版不支持 · …」那一行');
  assert.match(editJs, /unsupportedLine\(f\)/, 'edit.js 没有调用 unsupportedLine()');
  assert.ok(!/title:\s*f\.idle/.test(editJs), '原因又退回 title 了 —— 必须显示在页面上，不能只放浮层');

  // ④ 页面顶部要有总数汇总，不能让用户逐个找灰格子
  assert.match(editJs, /项在本版不可用/, 'edit.js 缺少页面顶部的「本页 N 项在本版不可用」汇总');

  // ⑤ 数量钉死
  assert.equal(disabled.length, 71, `禁用字段 ${disabled.length} 个`);
  assert.equal(reasons.length, 71, `不支持原因 ${reasons.length} 条`);
});

test('不变式 B′：字段表里的每个字段都有明确归宿（接上 / 禁用 / 元信息），不许第三种状态', () => {
  const reg = new Set(FIELDS.map((f) => f.name));
  const configurable = form.fields.filter((f) => !f.disabled).map((f) => f.name);
  const disabled = form.fields.filter((f) => f.disabled).map((f) => f.name);
  const hidden = [...reg].filter((n) => !formNames.has(n));

  // ① 三桶必须覆盖全量字段表，且互不重叠
  const buckets = [
    { name: '可配', list: configurable },
    { name: '禁用', list: disabled },
    { name: '不进表单', list: hidden },
  ];
  assert.equal(buckets.reduce((a, b) => a + b.list.length, 0), reg.size, '三桶之和 != 字段表总数（有字段没归宿或重复）');
  const seen = new Set();
  for (const b of buckets) {
    for (const n of b.list) {
      assert.ok(!seen.has(n), `${n} 同时进了两个桶`);
      seen.add(n);
    }
  }

  // ② 每个「可配」字段：要么有消费，要么在豁免里（A 已经查过，这里再钉一次总数）
  //    注意用并集：有的豁免字段（如 group_id / remark）也真被读到，直接相加会重复计数
  const wired = configurable.filter((n) => readSites(n).length > 0);
  const exempt = configurable.filter((n) => METADATA[n]);
  const covered = new Set([...wired, ...exempt]);
  assert.equal(covered.size, configurable.length, '可配字段里既没消费也没豁免的，A 那组应该已经红了');
  assert.equal(configurable.length, 60, `可配字段 ${configurable.length} 个`);
  assert.equal(exempt.length, 8, `豁免 ${exempt.length} 个`);

  // ③ 「不进表单」的那几个：三个 ip_* 必须接成只读展示，ext_obj 保持透传（写进 docs/23）
  assert.deepEqual(hidden.sort(), ['browser_run_args', 'ext_obj', 'ip', 'ip_city', 'ip_country', 'ip_region', 'user_proxy_config'].sort(),
    `不进表单的字段变了：${hidden.join(',')}`);
  const editJs = fs.readFileSync(new URL('web/pages/edit.js', ROOT), 'utf8');
  for (const f of ['ip_country', 'ip_region', 'ip_city']) {
    assert.ok(editJs.includes(`'${f}'`), `ip 归属只读展示里漏了 ${f}`);
  }
  assert.match(editJs, /出口 IP 归属（只读）/, '没有渲染「出口 IP 归属（只读）」');
});

/* ============================================================================
 * C · 本轮接上的字段：消费路径必须还在（删掉就红，防「接线又被回退」）
 * ==========================================================================*/

test('不变式 C：本轮接上的四个字段（clear_cache_after_closing / hidden_notification / win_x / win_y）消费路径必须还在', () => {
  const must = {
    clear_cache_after_closing: 'src/runtime/manager.js#scheduleCachePurgeOnClose',
    hidden_notification: 'src/kernel/inject.js#CFG.hiddenNotification',
    win_x: 'src/kernel/chrome.js#position.x',
    win_y: 'src/kernel/chrome.js#position.y',
  };
  for (const [field, anchor] of Object.entries(must)) {
    const [file, symbol] = anchor.split('#');
    assert.ok(text(file).includes(symbol), `${field} 的消费路径没了（${file} 里找不到 "${symbol}"）—— 要么接回去，要么改登记成禁用`);
    assert.ok(readSites(field).length > 0, `${field} 行为层已经没人读了`);
    assert.ok(!UNSUPPORTED[field], `${field} 已经接线了，不该再留在「本版不支持」清单里`);
  }
  // clear_cache_after_closing：三处语义必须都在（2 秒延迟 / 先判存在 / 失败只记日志）
  const mgr = text('src/runtime/manager.js');
  assert.match(mgr, /export function scheduleCachePurgeOnClose\(instance, delayMs = 2000\)/,
    'clear_cache_after_closing 的默认延迟必须是 2000ms（对手就是 2e3）');
  assert.match(mgr, /if \(!fs\.existsSync\(dir\)\) return;/, '删之前必须先判存在（对手的 isExists 前置）');
  assert.match(mgr, /clear_cache_after_closing - rm -/, '删失败必须只记一行日志（照抄静默语义）');
  // hidden_notification：native code 前置判断 + 回调 false/promise null
  const inj = text('src/kernel/inject.js');
  assert.match(inj, /indexOf\('native code'\)/, 'hidden_notification 漏了「原始 toString 含 native code 才替换」的前置判断');
  assert.match(inj, /if \(e\) e\(false\); resolve\(null\);/, 'hidden_notification 的行为必须是回调 false + promise null');
  assert.ok(!/hiddenNotification[\s\S]{0,400}denied/.test(inj), 'hidden_notification 不是返回 "denied" 字符串');
  // win_x/win_y 必须两个都有值才发参数（缺一个不发，不许按 0 算）
  assert.match(text('src/kernel/chrome.js'), /if \(!Number\.isFinite\(x\) \|\| !Number\.isFinite\(y\)\) return null;/,
    'windowPositionOf 必须要求 x/y 都是有限数才返回');
  // 且只在 window_position === 'topLeft' 时才算数（联动禁用那一条的代码侧）
  assert.match(text('src/kernel/chrome.js'), /===\s*'topLeft'/,
    'win_x/win_y 必须按 window_position 联动（只有 topLeft 才用这两个数）');

  // 接上之后**用户不看就会踩坑**的那几个，必须有页面上可见的提示（`f.note` → edit.js 的 hint）。
  // 为什么钉这条：`clear_cache_after_closing` 会删掉整个环境数据目录，界面上一句提示都没有的话，
  // 用户就是「用着用着发现登录态全没了」—— 那正是这一版要消灭的体验。
  const byName = new Map(form.fields.map((f) => [f.name, f]));
  const mustHint = {
    clear_cache_after_closing: /删除|数据目录/,
    hidden_notification: /通知|权限/,
  };
  for (const [n, re] of Object.entries(mustHint)) {
    const f = byName.get(n);
    assert.ok(f, `${n} 不在表单里了`);
    assert.ok(f.note && re.test(f.note), `${n} 已接线但界面没有可见提示（f.note 为空或不含关键信息）—— 用户不看就会踩坑`);
  }
});

/* ============================================================================
 * D · 注册表里不许有重复键（JS 会静默让最后一次覆盖，看不出来）
 * ==========================================================================*/

/**
 * 把源码变成「只有代码、没有注释与字符串内容」的文本，**换行一个不丢**（行号才对得上）。
 *
 * 为什么不能拿正则凑：`overrides.mjs` 的注释里满是反引号与中文括号（`30-假字段消费机制.md`
 * 那种引用），直接 `^  key:` 数行会把注释里的示例也算成键；而字符串里的 `{` `}` 会把深度带偏。
 * 所以这里逐字符走一遍：注释整段丢掉、字符串只留引号骨架、换行保留。
 */
function codeOnly(src) {
  let out = '';
  let mode = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (mode) {
      if (c === '\\') { i++; continue; }
      if (c === mode) { mode = null; continue; }
      if (c === '\n') out += '\n';
      continue;
    }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { mode = c; continue; }
    out += c;
  }
  return out;
}

/**
 * 扫出每个 `export const X = { … }` 的**顶层键**（大括号深度 === 1 时才收），
 * 返回 `[{ table, keys: [{ key, line }] }]`。
 *
 * 为什么必须按深度：`EFFECT` / `UNSUPPORTED` 里的值是嵌套对象
 * （`{ effect: 'local', sites: [...] }`），顶层键和嵌套键用同一条规则数会把
 * `effect` / `sites` 也算成顶层键，一有第二处就误报重复。
 */
function topLevelKeys(src) {
  const lines = codeOnly(src).split('\n');
  const tables = [];
  let depth = 0;
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const exp = /^\s*export const ([A-Za-z_$][\w$]*)\s*=\s*\{/.exec(line);
    if (exp) {
      cur = { table: exp[1], keys: [] };
      tables.push(cur);
    } else if (cur && depth === 1) {
      const k = /^\s*(?:['"]([A-Za-z_$][\w$]*)['"]|([A-Za-z_$][\w$]*))\s*:/.exec(line);
      if (k) cur.keys.push({ key: k[1] || k[2], line: i + 1 });
    }
    for (const ch of line) {
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
    }
    if (exp) depth = 1; // `export const X = {` 这一行自己把深度带到 1
    if (depth <= 0) { depth = 0; cur = null; }
  }
  return tables;
}

test('不变式 D：overrides.mjs 的注册表里不许有重复键（重复键会被静默覆盖，行为变了没人报）', () => {
  const src = fs.readFileSync(new URL('packages/profile/reference/overrides.mjs', ROOT), 'utf8');
  const tables = topLevelKeys(src);

  // ① 先证明扫描器真的扫到东西了 —— 扫空了的判据永远是绿的，比没有更坏
  const names = tables.map((t) => t.table);
  for (const must of ['COVERAGE', 'EFFECT', 'UNSUPPORTED', 'METADATA']) {
    assert.ok(names.includes(must), `扫描器没扫到 ${must} 这张表（判据自己坏了）`);
  }
  const totalKeys = tables.reduce((a, t) => a + t.keys.length, 0);
  assert.ok(totalKeys > 200, `只扫到 ${totalKeys} 个顶层键，明显不对（判据自己坏了）`);
  // COVERAGE 是「逐字段给 coverage」的那张表（138 个字段里有一部分不属于指纹维度、不在这张表里，
  // 所以是 115 不是 138）；这里钉个下限，只为了抓「扫描器自己坏了、扫出个空表也算绿」
  const cov = tables.find((t) => t.table === 'COVERAGE');
  assert.ok(cov.keys.length >= 110, `COVERAGE 只扫到 ${cov.keys.length} 个键`);

  // ② 同一个对象里同一个键出现两次 → 红，并点名「哪个对象、哪个键、哪几行」
  const dups = [];
  for (const t of tables) {
    const seen = new Map();
    for (const { key, line } of t.keys) {
      if (!seen.has(key)) { seen.set(key, [line]); continue; }
      seen.get(key).push(line);
    }
    for (const [key, lines] of seen) {
      if (lines.length > 1) dups.push(`${t.table}.${key}（第 ${lines.join(' / ')} 行，共 ${lines.length} 处）`);
    }
  }
  assert.deepEqual(dups, [],
    `注册表里有重复键，JS 会让最后一次静默覆盖前面的 —— 改一处另一处不生效，判据也看不出来：${dups.join('；')}`);
});
