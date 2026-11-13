/**
 * 不需要 Chrome 的单元测试：代理预检 / 启动参数白名单 / UA 跟版 / 校验分级。
 * 跑法：node --test test/unit.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { checkProxy, httpGetViaProxy, normalizeProxyConfig, hasProxy, parseExitInfo } from '../src/proxy/probe.js';
import { checkOne, checkMany, classifyProxyFailure } from '../src/proxy/health.js';
import { mergeLaunchArgs, parseLaunchArgs } from '../src/kernel/launch-args.js';
import { alignProfileToKernel } from '../src/kernel/version.js';
import { checkProfile } from '../src/store/profiles.js';
import { checkEgress, validateField, isValidTimezone, normalizeValue, csvToArray } from '../packages/profile/src/validate.js';
import { deriveNoiseSeeds, ensureNoiseSeeds, seedOf } from '../src/fingerprint/seeds.js';
import { generateFingerprint } from '../src/fingerprint/generate.js';
import { fingerprintView, geoPolicy } from '../src/fingerprint/view.js';
import { buildReport } from '../src/selfcheck/report.js';
import { renderHtml } from '../src/selfcheck/html.js';
import { pacInUse, pacMessage } from '../src/proxy/pac.js';
import { buildArgs, waitForDevToolsPort } from '../src/kernel/chrome.js';
import { ok, unsupported } from '../src/api/contract.js';
import { clampConcurrency } from '../src/runtime/batch.js';
import { cookieToStorage, cookieText } from '../src/store/profiles.js';
import { publicCookie, cdpCookieParam } from '../src/kernel/cookies.js';
import { normalizeImportItem } from '../src/store/transfer.js';
import { parseAdspowerTxt, formatAdspowerTxt, proxyLineOf } from '../src/store/adspower-txt.js';
import { startFakeProxy } from './fake-proxy.mjs';
import { profileFormSchema } from '../src/api/schema.js';
import { FIELDS as REGISTRY_FIELDS } from '../packages/profile/src/fields.js';
import { COVERAGE as OVERRIDES_COVERAGE, EFFECT as OVERRIDES_EFFECT, INERT_EXTRA as OVERRIDES_INERT_EXTRA } from '../packages/profile/reference/overrides.mjs';
import vm from 'node:vm';
import fs from 'node:fs';
import { buildArtifacts } from '../tools/gen-schema.mjs';
import { buildInjectionSource, buildWorkerInjectionSource, sharedNoiseCoreSource } from '../src/kernel/inject.js';

/** 找一个当前没人监听的端口（起一个 server 再关掉） */
async function deadPort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

test('代理预检：活的 HTTP 代理返回出口 IP / 地理 / 时区', async () => {
  const fake = await startFakeProxy({ ip: '198.51.100.7', countryCode: 'JP', timezone: 'Asia/Tokyo' });
  try {
    const r = await checkProxy(fake.proxy, { url: 'http://ip-api.com/json/', timeoutMs: 3000, fallbackUrls: [] });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.ip, '198.51.100.7');
    assert.equal(r.countryCode, 'JP');
    assert.equal(r.timezone, 'Asia/Tokyo');
    assert.ok(r.latency_ms >= 0);
    // 预检确实经过了代理，而不是直连
    assert.ok(fake.requests.length >= 1, '代理必须收到请求');
  } finally {
    await fake.close();
  }
});

test('代理预检：坏代理快速失败，不抛异常，只给 ok:false', async () => {
  const port = await deadPort();
  const t0 = Date.now();
  const r = await checkProxy({ proxy_type: 'http', host: '127.0.0.1', port }, {
    url: 'http://ip-api.com/json/', timeoutMs: 1500, fallbackUrls: [],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /连接 .* 失败/);
  assert.ok(Date.now() - t0 < 4000, '坏代理要快速返回');
});

test('代理预检：认证失败（407）也算不可用', async () => {
  const fake = await startFakeProxy({ requireAuth: ['u1', 'p1'] });
  try {
    const bad = await checkProxy({ ...fake.proxy, username: 'u1', password: 'wrong' }, {
      url: 'http://ip-api.com/json/', timeoutMs: 3000, fallbackUrls: [],
    });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /407/);

    const good = await checkProxy({ ...fake.proxy, username: 'u1', password: 'p1' }, {
      url: 'http://ip-api.com/json/', timeoutMs: 3000, fallbackUrls: [],
    });
    assert.equal(good.ok, true, good.error);
  } finally {
    await fake.close();
  }
});

test('代理预检：配置不完整 / 不支持的类型都不放行', async () => {
  assert.deepEqual(normalizeProxyConfig({ proxy_type: 'socks', host: 'h', port: 1 }).type, 'socks5');
  assert.equal(hasProxy({ host: '', port: 1 }), false);
  assert.equal(hasProxy({ host: 'h', port: 0 }), false);
  const empty = await checkProxy({ host: '', port: 0 });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /不完整/);
  const socks4 = await checkProxy({ proxy_type: 'socks4', host: '127.0.0.1', port: 1080 });
  assert.equal(socks4.ok, false);
  assert.match(socks4.error, /不支持/);
});

test('代理字段：AdsPower 形状（proxy_host/proxy_port/proxy_user/proxy_password）全链路认', () => {
  const adspower = {
    proxy_type: 'http', proxy_host: '203.0.113.5', proxy_port: 8000,
    proxy_user: 'u1', proxy_password: 'p1',
  };
  const c = normalizeProxyConfig(adspower);
  assert.deepEqual(c, { type: 'http', host: '203.0.113.5', port: 8000, username: 'u1', password: 'p1' });
  assert.equal(hasProxy(adspower), true);

  // buildArgs：形状不同也必须拼出 --proxy-server（否则预检过、内核直连 = fail-open）
  const built = buildArgs({ webgl_config: {} }, { userDataDir: 'C:\\fp\\udd', proxy: adspower, proxyBound: true, userArgs: [] });
  assert.ok(built.args.includes('--proxy-server=http://203.0.113.5:8000'), built.args.join(' '));
  assert.ok(built.args.includes('--proxy-bypass-list=<-loopback>'));

  // proxyBound 但配置不可用：宁可抛错也不许起一个直连内核
  assert.throws(() => buildArgs({ webgl_config: {} }, { userDataDir: 'C:\\fp\\udd', proxy: { proxy_type: 'http' }, proxyBound: true }), /不完整|直连/);
});

test('P2 disable_save_password：只有 "1" 才加两个参数，且不冲掉基线特性', () => {
  const built = (profile, userArgs = []) => buildArgs(profile, { userDataDir: 'C:\\fp\\udd', userArgs });
  const featsOf = (r) => {
    const line = r.args.find((a) => a.startsWith('--disable-features='));
    return { line, feats: line.slice('--disable-features='.length).split(',') };
  };

  const on = built({ webgl_config: {}, disable_save_password: '1' });
  assert.ok(on.args.includes('--password-store=basic'), on.args.join(' '));
  const onFeats = featsOf(on);
  assert.ok(onFeats.feats.includes('EnablePasswordsAccountStorage'), onFeats.line);
  // 这两个是 CEO 核过的「无证据」名字：不许再写进来（写进去只会被内核静默忽略）
  assert.equal(onFeats.feats.includes('PasswordManager'), false, onFeats.line);
  assert.equal(onFeats.feats.includes('AutofillServerCommunication'), false, onFeats.line);
  // 基线那几项不许被冲掉（合并在同一条 --disable-features 里）
  for (const f of ['Translate', 'OptimizationHints', 'MediaRouter', 'CalculateNativeWinOcclusion']) {
    assert.ok(onFeats.feats.includes(f), `${f} 被冲掉了：${onFeats.line}`);
  }

  // 其余写法一律不加（0 / 空串 / 缺省 / 非 "1" 字符串）
  for (const v of ['0', '', undefined, 'false', '2']) {
    const off = built({ webgl_config: {}, disable_save_password: v });
    assert.equal(off.args.includes('--password-store=basic'), false, `"${v}" 不该加 password-store`);
    assert.equal(featsOf(off).feats.includes('EnablePasswordsAccountStorage'), false, `"${v}" 不该关账号密码存储`);
  }

  // 用户 launch_args 里的 --disable-features 是并集，不是覆盖
  const merged = built({ webgl_config: {}, disable_save_password: '1' }, ['--disable-features=SmokeKeep']);
  const mergedFeats = featsOf(merged).feats;
  assert.ok(mergedFeats.includes('EnablePasswordsAccountStorage') && mergedFeats.includes('SmokeKeep'), featsOf(merged).line);

  // 落库前归一成字符串：对手是 `"1" === value` 的严格比较，数字 1 落成整数再读出来会被当成「关」
  assert.equal(normalizeValue('disable_save_password', 1), '1');
  assert.equal(normalizeValue('disable_save_password', 0), '0');
  assert.equal(normalizeValue('disable_save_password', '1'), '1');
});

test('P2 automation_controlled：只有 "1" 才放开 navigator.webdriver，注入兜底跟着让路', () => {
  const FLAG = '--disable-blink-features=AutomationControlled';
  const built = (v) => buildArgs({ webgl_config: {}, automation_controlled: v }, { userDataDir: 'C:\\fp\\udd' });
  const has = (r) => r.args.includes(FLAG);

  // "1"：不放这个 flag（内核原生 navigator.webdriver=true），其余写法维持基线（false）
  assert.equal(has(built('1')), false, 'automation_controlled=1 时不该再摘 AutomationControlled');
  for (const v of ['0', '', undefined, 'false', '2']) assert.equal(has(built(v)), true, `"${v}" 应维持基线`);
  // 基线其它参数不受影响：同一个环境只是少了这一条
  const off = built('0').args;
  assert.ok(off.includes('--disable-features=Translate,OptimizationHints,MediaRouter,CalculateNativeWinOcclusion'), off.join(' '));

  // 数字 1 归一成 "1"（对手是 `"1" === value` 的严格比较，数字落库会被当成「关」）
  assert.equal(normalizeValue('automation_controlled', 1), '1');
  assert.equal(normalizeValue('automation_controlled', 0), '0');
  assert.equal(normalizeValue('automation_controlled', '1'), '1');

  // 注入层那句「webdriver 本该 false 却不是才补」必须受 CFG.automationControlled 控制：
  // 否则 "1" 会被我们自己的兜底改回 false —— 字段看起来接了、其实空转。
  const pageOn = buildInjectionSource({ seed: 'x', automationControlled: true });
  const pageOff = buildInjectionSource({ seed: 'x', automationControlled: false });
  const workerOn = buildWorkerInjectionSource({ seed: 'x', automationControlled: true });
  const workerOff = buildWorkerInjectionSource({ seed: 'x', automationControlled: false });
  assert.match(pageOn, /"automationControlled":true/);
  assert.match(pageOff, /"automationControlled":false/);
  assert.match(workerOn, /"automationControlled":true/);
  assert.match(workerOff, /"automationControlled":false/);
  for (const src of [pageOn, pageOff, workerOn, workerOff]) {
    assert.match(src, /if \(!CFG\.automationControlled\)/, 'webdriver 兜底没有被 CFG.automationControlled 控住');
  }
});

test('P2 location：block/allow/ask 三档语义（权限 + 坐标覆盖）', () => {
  const coords = { latitude: 37.7749, longitude: -122.4194, accuracy: 12 };

  const allow = geoPolicy({ location: 'allow', ...coords });
  assert.equal(allow.permission, 'granted');
  assert.equal(allow.override, true);
  assert.deepEqual([allow.latitude, allow.longitude, allow.accuracy], [37.7749, -122.4194, 12]);

  const ask = geoPolicy({ location: 'ask', ...coords });
  assert.equal(ask.permission, 'prompt', 'ask 不授权（靠内核默认 prompt）');
  assert.equal(ask.override, true, 'ask 也下发坐标（对手 ask 同样下发）');

  // block 必须显式拒绝：「什么都不做」在内核里等于 prompt（= ask），那样 block 与 ask 分不开
  const block = geoPolicy({ location: 'block', ...coords });
  assert.equal(block.permission, 'denied');
  assert.equal(block.override, false, 'block 不许覆盖坐标');

  // 缺经纬度：只做权限，不把 undefined 塞进 CDP
  const noCoords = geoPolicy({ location: 'allow', accuracy: 1000 });
  assert.equal(noCoords.permission, 'granted');
  assert.equal(noCoords.override, false);
  assert.equal(noCoords.latitude, undefined);
  assert.equal(noCoords.longitude, undefined);
  // null / 空串不算坐标：Number(null) === 0，会把「没填」当成 (0,0)——几内亚湾（探针抓到过）
  const nullCoords = geoPolicy({ location: 'allow', latitude: null, longitude: null, accuracy: 1000 });
  assert.equal(nullCoords.override, false, 'null 经纬度不许被当成 (0,0)');
  assert.equal(nullCoords.latitude, undefined);
  assert.equal(geoPolicy({ location: 'allow', latitude: '', longitude: '' }).override, false);

  // 纯空白串同理：`Number('  ') === 0`。漏了这条，表单里打一个空格就下发 (0,0)（几内亚湾）。
  // 断言到「不下发」为止：override=false 是 applyToSession 里 setGeolocationOverride 的唯一开关
  // （manager.js:942 `if (geo.override)`），所以这里 false 就等于「一个字节的坐标都没发给内核」。
  for (const blank of ['  ', '\t', '   ', '\r\n', ' \t ']) {
    const g = geoPolicy({ location: 'allow', latitude: blank, longitude: blank, accuracy: 12 });
    assert.equal(g.override, false, `经纬度是 ${JSON.stringify(blank)} 时不许下发坐标覆盖`);
    assert.equal(g.latitude, undefined, `经纬度是 ${JSON.stringify(blank)} 时 latitude 不许有值`);
    assert.equal(g.longitude, undefined);
    // 只填了一边是空白、另一边是真值，同样不许下发（两边都得是真坐标）
    assert.equal(geoPolicy({ location: 'allow', latitude: blank, longitude: -122.4 }).override, false);
  }
  // 正例成对：带前后空白的真坐标仍然认（Number 自己会 trim），别把「空格」修成「空格包着的数字也不认」
  const padded = geoPolicy({ location: 'allow', latitude: ' 12.5 ', longitude: ' -77.25 ', accuracy: 12 });
  assert.equal(padded.override, true);
  assert.deepEqual([padded.latitude, padded.longitude], [12.5, -77.25]);

  // accuracy 非法/缺失时不传（CDP 校验：10..5000 的整数）；合法值取整
  assert.equal(geoPolicy({ location: 'allow', ...coords, accuracy: 1000.6 }).accuracy, 1001);
  assert.equal(geoPolicy({ location: 'allow', latitude: 1, longitude: 2, accuracy: 0 }).accuracy, undefined);

  // location_switch 不参与判断（它在 idle 表里：对手客户端不消费）
  assert.equal(geoPolicy({ location: 'allow', location_switch: '0', ...coords }).permission, 'granted');
  // 记录里没有 location 时按 ask 兜底（不主动授权）；正常记录由 db/generate 默认成 allow
  assert.equal(geoPolicy({ ...coords }).permission, 'prompt');
});

test('P2 do_not_track：只有 "true" 才做两半，其余写法一个字节都不改', () => {
  // 视图：只有字符串 "true" 才是 '1'；"false" / "default" 在对手那边不可区分，都是不下发
  assert.equal(fingerprintView({ do_not_track: 'true' }).doNotTrack, '1');
  for (const v of ['false', 'default', '', undefined, '1', 'yes', 1]) {
    assert.equal(fingerprintView({ do_not_track: v }).doNotTrack, null, `"${v}" 不该做任何事`);
  }

  // 注入源：CFG 里带这个值，且固定 navigator.doNotTrack 的那段只认 CFG.doNotTrack === '1'
  const on = buildInjectionSource({ seed: 'x', doNotTrack: '1' });
  const off = buildInjectionSource({ seed: 'x', doNotTrack: null });
  assert.match(on, /"doNotTrack":"1"/);
  assert.match(on, /CFG\.doNotTrack === '1'/);
  assert.match(off, /"doNotTrack":null/);
  // 不许发明第三种状态：两版源码里都不许出现把 doNotTrack 固定成 '0' 的写法
  assert.equal(on.includes("defGetter(Navigator.prototype, 'doNotTrack', '0')"), false);
  assert.equal(off.includes("defGetter(Navigator.prototype, 'doNotTrack', '0')"), false);
});

/**
 * 源码级判据（不是行为判据，行为要靠真内核才测得到）：`Network.enable` 失败**不许静默吞**。
 * 理由：未 enable 时 `setExtraHTTPHeaders` 返回 ok 但一个请求都不改 —— 失败被 `.catch(() => {})`
 * 吃掉，就变成「DNT 配了却没生效」且没有任何线索。这里钉住「失败要留一句日志、且仍继续设头」。
 */
test('P2 do_not_track：Network.enable 失败不许静默吞（要留日志，行为仍是继续设头）', () => {
  const src = fs.readFileSync(new URL('../src/runtime/manager.js', import.meta.url), 'utf8');
  const start = src.indexOf("view.doNotTrack === '1'");
  assert.ok(start > 0, 'manager.js 里找不到 DNT 那段');
  // 用**带引号的**调用名定位，避开注释里的同名标识符（注释里是反引号写法）
  const enableAt = src.indexOf("'Network.enable'", start);
  const setAt = src.indexOf("'Network.setExtraHTTPHeaders'", start);
  assert.ok(enableAt > start && setAt > enableAt, 'DNT 段里应当先 enable 再设头');
  const head = src.slice(enableAt, setAt);
  assert.equal(head.includes('.catch(() => {})'), false, 'Network.enable 的失败被静默吞了');
  assert.match(head, /WARN Network\.enable 失败/, 'enable 失败没有留日志');
});

test('httpGetViaProxy：非 200 也完整返回，交给上层判断', async () => {
  const fake = await startFakeProxy();
  try {
    const res = await httpGetViaProxy(fake.proxy, 'http://example.com/x?y=1', { timeoutMs: 3000 });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /json/);
    assert.equal(fake.requests[0].url, 'http://example.com/x?y=1', '必须用 absolute-form 发给代理');
  } finally {
    await fake.close();
  }
});

test('出口信息解析：JSON / 纯文本 / fail 都能归一', () => {
  assert.equal(parseExitInfo('{"query":"1.2.3.4","countryCode":"us"}').countryCode, 'US');
  assert.equal(parseExitInfo('5.6.7.8\n').ip, '5.6.7.8');
  assert.match(parseExitInfo('{"status":"fail","message":"reserved range"}').error, /reserved range/);
  assert.deepEqual(parseExitInfo('<html>'), {});
});

/* ------------------------- launch_args 白名单 ------------------------- */

const BASE = [
  '--user-data-dir=C:\\fp\\x\\userdata',
  '--remote-debugging-port=0',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=Translate,OptimizationHints',
  '--proxy-server=http://127.0.0.1:8080',
  '--proxy-bypass-list=<-loopback>',
];

test('launch_args：保护名单里的参数一条都不进 argv，并回报原因', () => {
  const r = mergeLaunchArgs(BASE, [
    '--user-data-dir=C:\\evil',
    '--remote-debugging-port=9222',
    '--lang=ja-JP',
    '--proxy-server=http://1.2.3.4:1',
    '--enable-automation',
    '--disable-gpu',
  ], { proxyBound: true });
  assert.deepEqual(r.applied, []);
  assert.equal(r.rejected.length, 6);
  for (const raw of r.args) {
    assert.ok(!raw.includes('evil'));
    assert.ok(!raw.startsWith('--enable-automation'));
    assert.ok(!raw.startsWith('--disable-gpu'));
  }
  assert.ok(r.rejected.some((x) => x.arg === '--user-data-dir=C:\\evil' && /系统计算/.test(x.reason)));
});

test('launch_args：白名单里的 feature 列表按并集合并，不覆盖系统值', () => {
  const r = mergeLaunchArgs(BASE, ['--disable-features=Foo,Bar', '--enable-features=Baz'], { proxyBound: true });
  assert.deepEqual(r.applied, ['--disable-features=Foo,Bar', '--enable-features=Baz']);
  assert.ok(r.args.includes('--disable-features=Translate,OptimizationHints,Foo,Bar'));
  assert.ok(r.args.includes('--enable-features=Baz'));
});

test('launch_args：AutomationControlled 不许被放出来', () => {
  const add = mergeLaunchArgs(BASE, ['--enable-blink-features=AutomationControlled'], { proxyBound: true });
  assert.equal(add.applied.length, 0);
  assert.match(add.rejected[0].reason, /webdriver/);

  const strip = mergeLaunchArgs(BASE, ['--disable-blink-features=AutomationControlled,Foo'], { proxyBound: true });
  const line = strip.args.find((a) => a.startsWith('--disable-blink-features='));
  assert.ok(line.includes('Foo'));
  assert.ok(strip.warnings.some((w) => /AutomationControlled/.test(w.message)));
});

test('launch_args：绑定代理时禁止自定义 bypass（否则等于给直连开后门）', () => {
  const r = mergeLaunchArgs(BASE, ['--proxy-bypass-list=*'], { proxyBound: true });
  assert.equal(r.applied.length, 0);
  assert.match(r.rejected[0].reason, /fail-closed/);
  assert.ok(r.args.includes('--proxy-bypass-list=<-loopback>'));
});

test('launch_args：load-extension 自动补 Chrome 137+ 需要的特性开关', () => {
  const r = mergeLaunchArgs(BASE, ['--load-extension=C:\\ext'], { proxyBound: true });
  assert.deepEqual(r.applied, ['--load-extension=C:\\ext']);
  const line = r.args.find((a) => a.startsWith('--disable-features='));
  assert.ok(line.includes('DisableLoadExtensionCommandLineSwitch'));
  assert.ok(r.args.includes('--load-extension=C:\\ext'));
});

test('launch_args：名单外的参数拒绝，不猜用户意图', () => {
  const r = mergeLaunchArgs(BASE, ['--some-unknown-flag=1'], { proxyBound: true });
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].reason, /白名单/);
  assert.deepEqual(parseLaunchArgs('["--a","--b"]'), ['--a', '--b']);
  assert.deepEqual(parseLaunchArgs('--a\n--b'), ['--a', '--b']);
  assert.deepEqual(parseLaunchArgs(null), []);
});

/* ------------------------- 内核起不来的报错 ------------------------- */

/**
 * 实测踩到过：内核秒退（STATUS_BREAKPOINT）时旧实现只会报「20000ms 内没暴露 DevTools 端口」，
 * 把人往端口/防火墙方向带。这里钉住「内核自己退出了就立刻带退出码失败」。
 */
test('内核秒退：立刻带退出码失败，不空等满超时', async () => {
  const t0 = Date.now();
  await assert.rejects(
    waitForDevToolsPort('.tmp-no-such-dir-fp', { timeoutMs: 20000, child: { exitCode: 0x80000003 } }),
    /立即退出.*2147483651.*0x80000003.*STATUS_BREAKPOINT/s,
  );
  const waited = Date.now() - t0;
  assert.ok(waited < 2000, `应当立刻失败，实际等了 ${waited}ms`);

  // 没传 child 时保持老行为：超时就报「未在 Nms 内暴露」
  await assert.rejects(waitForDevToolsPort('.tmp-no-such-dir-fp', { timeoutMs: 300 }), /未在 300ms 内暴露/);
});

/* ------------------------- UA 跟版 ------------------------- */

test('UA 跟版：156 的环境在内核 157 上被整体拉齐', () => {
  const profile = {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
    platform: 'Win32',
    client_hints: {
      platform: 'Windows', ua_full_version: '156.0.8078.80', platform_version: '10.0.0',
      brands: [{ brand: 'Chromium', version: '156' }, { brand: 'Google Chrome', version: '156' }],
      fullVersionList: [{ brand: 'Chromium', version: '156.0.8078.80' }],
    },
    kernel_version: '156.0.8078.80',
  };
  const r = alignProfileToKernel(profile, '157.0.8103.40');
  assert.equal(r.changed, true);
  assert.match(r.patch.ua, /Chrome\/157\.0\.0\.0/);
  assert.equal(r.patch.client_hints.ua_full_version, '157.0.8103.40');
  assert.equal(r.patch.client_hints.brands[0].version, '157');
  assert.equal(r.patch.client_hints.fullVersionList[0].version, '157.0.8103.40');
  assert.equal(r.patch.kernel_version, '157.0.8103.40');
  assert.equal(r.from, '156.0.8078.80');
});

test('UA 跟版：已经一致就不动', () => {
  const same = alignProfileToKernel({
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/157.0.0.0 Safari/537.36',
    client_hints: { ua_full_version: '157.0.8103.40' },
    kernel_version: '157.0.8103.40',
  }, '157.0.8103.40');
  assert.equal(same.changed, false);
  assert.deepEqual(same.patch, {});
});

/* ------------------------- 校验分级 ------------------------- */

function profile(over = {}) {
  return {
    group_id: '1',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
    platform: 'Win32',
    client_hints: { platform: 'Windows', ua_full_version: '157.0.8103.40' },
    webgl: '2',
    webgl_config: { unmasked_vendor: 'Google Inc. (NVIDIA)', unmasked_renderer: 'ANGLE (NVIDIA, RTX 3060, D3D11)' },
    language: ['en-US', 'en'],
    timezone: 'America/New_York',
    hardware_concurrency: 8,
    device_memory: 8,
    webrtc: 'disabled',
    ...over,
  };
}

test('校验分级：硬冲突（UA↔platform）阻断', () => {
  const r = checkProfile(profile({ platform: 'MacIntel' }));
  assert.equal(r.ok, false);
  assert.ok(r.hard.some((e) => e.field === 'platform'));
});

test('校验分级：软冲突（语言↔时区）只告警，不拦启动', () => {
  const r = checkProfile(profile({ language: ['ja-JP'], timezone: 'America/New_York' }));
  assert.equal(r.ok, true, JSON.stringify(r.hard));
  assert.ok(r.soft.some((w) => w.field === 'timezone'));
});

test('校验分级：force=1 可以越过硬冲突，并标记 forced', () => {
  const r = checkProfile(profile({ platform: 'MacIntel' }), { force: true });
  assert.equal(r.ok, true);
  assert.equal(r.forced, true);
  assert.equal(r.hard.length, 2, 'UA↔platform 与 UA-CH platform 两条硬冲突');
});

test('校验分级：值域错误 force 也越不过去', () => {
  const r = checkProfile(profile({ webgl: '9' }), { force: true });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'webgl' && !e.severity));
});

/* ------------------------- 出口一致性 ------------------------- */

test('出口一致性：时区对不上、语言国家对不上、内网出口都要报', () => {
  const w = checkEgress(profile({ timezone: 'Asia/Tokyo', language: ['ja-JP'] }), {
    ok: true, ip: '203.0.113.9', countryCode: 'US', country: 'United States', timezone: 'America/New_York',
  });
  const fields = w.map((x) => x.field);
  assert.ok(fields.includes('timezone'), '声明东京、出口纽约要报');
  assert.ok(fields.includes('language'), '日语环境出口美国要报');

  const local = checkEgress(profile(), { ok: true, ip: '192.168.1.5', timezone: 'America/New_York' });
  assert.ok(local.some((x) => /内网/.test(x.message)));
});

test('出口一致性：一致的出口不报', () => {
  const w = checkEgress(profile({ timezone: 'Asia/Tokyo', language: ['ja-JP'] }), {
    ok: true, ip: '203.0.113.9', countryCode: 'JP', country: 'Japan', timezone: 'Asia/Tokyo',
  });
  assert.deepEqual(w, []);
});

/* ------------------------- P2：噪点种子 ------------------------- */

test('噪点种子：四个维度独立、同种子稳定、同种子同 id', () => {
  const a = deriveNoiseSeeds('abc');
  const b = deriveNoiseSeeds('abc');
  assert.deepEqual(a, b);
  assert.equal(new Set(Object.values(a).map(String)).size, 4, '四个维度不能共用一个种子');
  assert.equal(seedOf('abc', 1), a.canvas_id);
  assert.notEqual(deriveNoiseSeeds('abd').canvas_id, a.canvas_id, '换种子必须整组换');
});

test('噪点种子：老环境缺哪个补哪个，已有值不动', () => {
  const patch = ensureNoiseSeeds({ fp_seed: 'legacy' });
  assert.deepEqual(Object.keys(patch).sort(), ['audio_id', 'canvas_id', 'client_rects_id', 'webgl_image_id']);
  const kept = ensureNoiseSeeds({ fp_seed: 'legacy', canvas_id: 7, audio_id: null });
  assert.equal(kept.canvas_id, undefined, '已有 canvas_id 不能被覆盖');
  assert.equal(typeof kept.audio_id, 'number');
});

test('指纹生成：四个种子入库、同种子跨调用不变、媒体设备默认随机模式', () => {
  const p1 = generateFingerprint({ seed: 'stable-seed', kernel: '156.0.8078.80', country: 'US' });
  const p2 = generateFingerprint({ seed: 'stable-seed', kernel: '156.0.8078.80', country: 'US' });
  for (const k of ['canvas_id', 'webgl_image_id', 'audio_id', 'client_rects_id']) {
    assert.equal(typeof p1[k], 'number', k);
    assert.equal(p1[k], p2[k], `${k} 必须确定性`);
  }
  assert.equal(p1.media_devices, '1', '0=真实 1=随机 2=手动');
  assert.notEqual(generateFingerprint({ seed: 'other', kernel: '156.0.8078.80' }).canvas_id, p1.canvas_id);
});

test('媒体设备视图：0=真实不注入、1=按数量、2=用手动 label', () => {
  assert.equal(fingerprintView({ media_devices: '0' }).media, null);
  const random = fingerprintView({ media_devices: '1', media_devices_num: { audioinput_num: '2', videoinput_num: '1', audiooutput_num: '3' } });
  assert.deepEqual(random.media.counts, { audioinput_num: 2, videoinput_num: 1, audiooutput_num: 3 });
  const manual = fingerprintView({
    media_devices: '2',
    media_devices_num: { audioinput_num: 1, videoinput_num: 1, audiooutput_num: 1 },
    media_devices_config: [{ kind: 'audioinput', label: 'My Mic' }],
  });
  assert.equal(manual.media.devices[0].label, 'My Mic');
});

/* ------------------------- P2：PAC 明确拒绝 ------------------------- */

test('PAC：full_pac_url 与 proxy_type=pac 都要识别，空值不算', () => {
  assert.match(pacInUse({ full_pac_url: 'http://x/proxy.pac' }), /full_pac_url/);
  assert.match(pacInUse({ proxy_config: { proxy_type: 'pac' } }), /proxy_type=pac/);
  assert.equal(pacInUse({ full_pac_url: '' }), null);
  assert.equal(pacInUse({ full_pac_url: '   ' }), null);
  assert.match(pacMessage('x'), /不支持 PAC/);
});

test('PAC：buildArgs 纵深防御，绝不生成 --proxy-pac-url', () => {
  assert.throws(() => buildArgs({
    full_pac_url: 'http://x/proxy.pac',
    webgl_config: {},
  }, { userDataDir: 'C:\\fp\\udd' }), /不支持 PAC/);
});

/* ------------------------- P2：自检报告 ------------------------- */

function selfProfile(over = {}) {
  const base = generateFingerprint({ seed: 'selfcheck-seed', kernel: '156.0.8078.80', country: 'US' });
  return { id: 'unit-profile', profile_no: 10001, name: 'unit', kernel_version: '156.0.8078.80', ...base, ...over };
}

function fakeRaw(p) {
  const v = fingerprintView(p);
  const mc = v.media
    ? { audioinput: v.media.counts.audioinput_num, videoinput: v.media.counts.videoinput_num, audiooutput: v.media.counts.audiooutput_num }
    : { audioinput: 1, videoinput: 1, audiooutput: 1 };
  return {
    ua: v.ua,
    platform: v.platform,
    languages: v.language.slice(),
    language: v.language[0],
    timezone: v.timezone,
    locale: v.locale,
    cores: v.hardware_concurrency,
    memory: v.device_memory,
    screen: { width: v.screen.width, height: v.screen.height, dpr: v.device_scale_factor },
    applied: ['canvas', 'webgl_image', 'audio', 'client_rects', 'webgl', 'media_devices'],
    installed: true,
    uaData: { brands: v.ua_metadata.brands, mobile: false, platform: v.ua_metadata.platform },
    uaDataHigh: {
      fullVersionList: v.ua_metadata.fullVersionList,
      platform: v.ua_metadata.platform,
      platformVersion: v.ua_metadata.platformVersion,
    },
    canvas: { hash: 'aaaa0001', stable: true },
    webgl: {
      supported: true, vendor: v.webgl.vendor, renderer: v.webgl.renderer, stable: true,
      image_hash: 'bbbb0002', image_hash2: 'bbbb0002',
    },
    audio: { hash: 'cccc0003', stable: true },
    client_rects: { hash: 'dddd0004', stable: true },
    fonts: { detected: ['Arial', 'Calibri'], declared: v.fonts },
    media_devices: {
      supported: true,
      permissions: { camera: 'prompt', microphone: 'prompt' },
      granted: false,
      labelsEmpty: true,
      counts: mc,
      list: [{ kind: 'audioinput', label: '', deviceId: '', groupId: '' }],
    },
    webrtc: { supported: true, count: 0, types: [], addresses: [] },
  };
}

test('自检报告：声明一致时 full=pass、partial=warn、字体=none 标黄', () => {
  const p = selfProfile();
  const report = buildReport(p, fakeRaw(p), { kernelVersion: '156.0.8078.80' });
  const byId = Object.fromEntries(report.items.map((i) => [i.id, i]));
  // 15 项（P6）+ 3 项双 Realm + 1 项 AudioWorklet = 19
  assert.equal(report.items.length, 19);
  assert.equal(byId.ua.status, 'pass');
  assert.equal(byId.ua.coverage, 'full');
  assert.equal(byId.webgl.status, 'warn');
  assert.equal(byId.webgl.coverage, 'partial');
  assert.equal(byId.canvas.status, 'warn');
  assert.equal(byId.fonts.coverage, 'none');
  assert.equal(byId.fonts.status, 'warn');
  assert.match(byId.fonts.note, /自编译 Chromium/, 'P9-B：要说清根治路径');
  assert.match(byId.fonts.note, /不等于字体指纹裸奔/, 'P9-B：none 不等于裸奔，这一句必须在');
  assert.equal(byId.webrtc.status, 'pass');
  assert.equal(report.summary.full, 7, JSON.stringify(report.summary));
  assert.equal(report.summary.partial, 10);
  assert.equal(report.summary.none, 2);
  assert.equal(report.summary.fail, 0);
  assert.equal(report.determinism.cross_restart, null);
  assert.ok(report.summary.score > 70 && report.summary.score < 100);
});

test('自检报告：三类 worker 未跑到时标「未验证」而不是「通过」', () => {
  const p = selfProfile();
  // fakeRaw 里没有 workers / audioworklet 字段 —— 等价于「自检页回落 about:blank 跑不到 worker」
  const report = buildReport(p, fakeRaw(p), { kernelVersion: '156.0.8078.80' });
  const byId = Object.fromEntries(report.items.map((i) => [i.id, i]));
  for (const key of ['realm_dedicated', 'realm_shared', 'realm_service']) {
    assert.equal(byId[key].status, 'warn', key);
    assert.match(byId[key].note, /没有跑到|未验证/, key);
  }
  assert.equal(byId.audio_worklet.status, 'warn');
  assert.equal(byId.audio_worklet.coverage, 'none');
  assert.equal(report.summary.fail, 0, '「没跑到」不许算成 fail，否则自检天天红');
});

test('自检报告：媒体设备（P9-C）未授权 label 为空=标黄，未授权有名字=fail', () => {
  const p = selfProfile();
  const base = fakeRaw(p);
  const withMedia = (m) => {
    const raw = {
      ...base,
      media_devices: { supported: true, counts: { audioinput: 1, audiooutput: 1 }, ...m },
    };
    return Object.fromEntries(buildReport(p, raw, { kernelVersion: '156.0.8078.80' }).items.map((i) => [i.id, i])).media_devices;
  };

  const unauthorized = withMedia({ granted: false, labelsEmpty: true, list: [{ kind: 'audioinput', label: '' }] });
  assert.equal(unauthorized.status, 'warn');
  assert.match(unauthorized.note, /真实枚举/);
  assert.match(unauthorized.note, /label 全部为空/);

  const leaked = withMedia({ granted: false, labelsEmpty: false, list: [{ kind: 'audioinput', label: 'Microphone (Realtek)' }] });
  assert.equal(leaked.status, 'fail', '未授权却有设备名，正是检测方抓的那条');
  assert.match(leaked.note, /未授权却返回了设备名/);

  const granted = withMedia({ granted: true, labelsEmpty: false, list: [{ kind: 'audioinput', label: 'Microphone (Realtek(R) Audio)' }] });
  assert.equal(granted.status, 'warn');
  assert.match(granted.note, /只按配置改了 label/);

  const grantedEmpty = withMedia({ granted: true, labelsEmpty: true, list: [{ kind: 'audioinput', label: '' }] });
  assert.equal(grantedEmpty.status, 'fail', '授权后 label 仍为空反而异常');
});

test('自检报告：双 Realm 三态 —— 首行前注入+同值=pass，值漂移=warn，首行读到 null=fail', () => {
  const p = selfProfile();
  const base = fakeRaw(p);
  const main = {
    realm: 'page',
    ua: base.ua,
    platform: base.platform,
    cores: base.cores,
    memory: base.memory,
    language: base.language,
    languages: base.languages.join(','),
    timezone: base.timezone,
    canvas_dom: 'aaaa0001',
    canvas_offscreen: 'aaaa0001',
  };
  const good = { ok: true, atTop: 'worker', realm: 'worker', ua: base.ua, platform: base.platform,
    cores: base.cores, memory: base.memory, language: base.language, languages: base.languages.join(','),
    timezone: base.timezone, canvas: 'aaaa0001', applied: ['canvas'] };

  // 全部一致 + 首行前注入 → pass
  let report = buildReport(p, {
    ...base,
    workers: { main, dedicated: good, shared: good, service: good },
    audioworklet: { ok: true, sampleRate: 48000, currentTime: 0, fpInjected: false, surfaces: ['sampleRate', 'currentTime'] },
  }, { kernelVersion: '156.0.8078.80' });
  let byId = Object.fromEntries(report.items.map((i) => [i.id, i]));
  assert.equal(byId.realm_dedicated.status, 'pass');
  assert.equal(byId.realm_shared.status, 'pass');
  assert.equal(byId.realm_service.status, 'pass');
  assert.equal(byId.realm_dedicated.actual.canvas, 'aaaa0001');
  assert.equal(byId.realm_dedicated.actual.atTop, 'worker');

  // canvas 不同 → warn，并把两边的值都写进说明
  report = buildReport(p, {
    ...base,
    workers: { main, dedicated: { ...good, canvas: 'ffff9999' }, shared: good, service: good },
    audioworklet: { ok: true, sampleRate: 48000, currentTime: 0, fpInjected: false, surfaces: ['sampleRate', 'currentTime'] },
  }, { kernelVersion: '156.0.8078.80' });
  byId = Object.fromEntries(report.items.map((i) => [i.id, i]));
  assert.equal(byId.realm_dedicated.status, 'warn');
  assert.match(byId.realm_dedicated.note, /ffff9999/);
  assert.match(byId.realm_dedicated.note, /aaaa0001/);

  // 首行读到 null → fail（真洞，不许糊成 warn）
  report = buildReport(p, {
    ...base,
    workers: { main, dedicated: { ...good, atTop: null, realm: 'worker' }, shared: good, service: good },
    audioworklet: { ok: true, sampleRate: 48000, currentTime: 0, fpInjected: false, surfaces: ['sampleRate', 'currentTime'] },
  }, { kernelVersion: '156.0.8078.80' });
  byId = Object.fromEntries(report.items.map((i) => [i.id, i]));
  assert.equal(byId.realm_dedicated.status, 'fail');
  assert.match(byId.realm_dedicated.note, /裸窗口/);

  // 硬件不一致也要抓到（双 Realm 取一遍核数是最省事的检测手法）
  report = buildReport(p, {
    ...base,
    workers: { main, dedicated: { ...good, cores: 2 }, shared: good, service: good },
    audioworklet: { ok: true, sampleRate: 48000, currentTime: 0, fpInjected: false, surfaces: ['sampleRate', 'currentTime'] },
  }, { kernelVersion: '156.0.8078.80' });
  byId = Object.fromEntries(report.items.map((i) => [i.id, i]));
  assert.equal(byId.realm_dedicated.status, 'warn');
  assert.match(byId.realm_dedicated.note, /核数/);
});

test('自检 HTML：双 Realm 一节与「音频指纹没裸奔」都要出现', () => {
  const p = selfProfile();
  const base = fakeRaw(p);
  const main = {
    realm: 'page', ua: base.ua, platform: base.platform, cores: base.cores, memory: base.memory,
    language: base.language, languages: base.languages.join(','), timezone: base.timezone,
    canvas_dom: 'aaaa0001', canvas_offscreen: 'aaaa0001',
  };
  const good = { ok: true, atTop: 'worker', realm: 'worker', ua: base.ua, platform: base.platform,
    cores: base.cores, memory: base.memory, language: base.language, languages: base.languages.join(','),
    timezone: base.timezone, canvas: 'aaaa0001', applied: ['canvas'] };
  const report = buildReport(p, {
    ...base,
    workers: { main, dedicated: good, shared: good, service: good },
    audioworklet: { ok: true, sampleRate: 48000, currentTime: 0, fpInjected: false, surfaces: ['sampleRate', 'currentTime'] },
  }, { kernelVersion: '156.0.8078.80' });
  const html = renderHtml(report);
  assert.match(html, /双 Realm/);
  assert.match(html, /音频指纹裸奔/);
  assert.match(html, /sampleRate/);
  assert.match(html, /48000/);
});

test('自检报告：声明没生效要报 fail（UA / WebGL / WebRTC 泄漏）', () => {
  const p = selfProfile({ webrtc: 'disabled' });
  const raw = fakeRaw(p);
  raw.ua = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0 Safari/537.36';
  raw.webgl.vendor = 'Google Inc. (Intel)';
  raw.webrtc.addresses = ['203.0.113.9'];
  const report = buildReport(p, raw, { kernelVersion: '156.0.8078.80' });
  const byId = Object.fromEntries(report.items.map((i) => [i.id, i]));
  assert.equal(byId.ua.status, 'fail');
  assert.equal(byId.webgl.status, 'fail');
  assert.equal(byId.webrtc.status, 'fail');
  assert.equal(report.summary.fail, 3);
  assert.match(byId.webrtc.note, /203\.0\.113\.9/);
});

test('自检报告：同内核历史哈希一致 → 跨重启一致；不一致 → 对应项 fail', () => {
  const p = selfProfile();
  const raw = fakeRaw(p);
  const first = buildReport(p, raw, { kernelVersion: '156.0.8078.80' });
  const prev = { kernel_version: '156.0.8078.80', generated_at: '2026-11-10T00:00:00.000Z', hashes: first.hashes };
  const again = buildReport(p, raw, { kernelVersion: '156.0.8078.80', previous: prev });
  assert.equal(again.determinism.cross_restart, true);

  const drift = buildReport(p, { ...raw, canvas: { ...raw.canvas, hash: 'ffff0000' } }, {
    kernelVersion: '156.0.8078.80', previous: prev,
  });
  assert.equal(drift.determinism.cross_restart, false);
  assert.equal(drift.items.find((i) => i.id === 'canvas').status, 'fail');

  // 换内核版本时不拿旧哈希下结论（渲染会随内核变）
  const newKernel = buildReport(p, raw, { kernelVersion: '157.0.8103.40', previous: prev });
  assert.equal(newKernel.determinism.cross_restart, null);
});

test('自检 HTML：本地渲染、内容转义、不引外链', () => {
  const p = selfProfile({ name: '<script>alert(1)</script>' });
  const report = buildReport(p, fakeRaw(p), { kernelVersion: '156.0.8078.80' });
  const html = renderHtml(report);
  assert.match(html, /<!doctype html>/);
  assert.ok(!html.includes('<script>alert(1)</script>'), '必须转义');
  assert.match(html, /自检符合度/);
  assert.ok(!/https?:\/\//.test(html), '不引外部资源');
});

/* --------------------------- P4：本地 API 契约 --------------------------- */

test('响应外壳：data 为 null 时整个 key 不出现（照抄对手）', () => {
  assert.deepEqual(ok(null), { code: 0, msg: 'success' });
  assert.equal('data' in ok(undefined), false);
  assert.deepEqual(ok({ a: 1 }).data, { a: 1 });
});

test('未实现接口：明确说不支持，错误码是已知的 -1', () => {
  const e = unsupported('/api/v2/browser-profile/share');
  assert.equal(e.code, -1);
  assert.equal(e.httpStatus, 200);
  assert.match(e.message, /不支持/);
  assert.equal(e.extra.supported, false);
  assert.equal(e.extra.path, '/api/v2/browser-profile/share');
});

test('批量启停的并发上限夹在 1..10', () => {
  assert.equal(clampConcurrency(3), 3);
  assert.equal(clampConcurrency(0), 1);
  assert.equal(clampConcurrency(-5), 1);
  assert.equal(clampConcurrency(99), 10);
  assert.equal(clampConcurrency('4'), 4);
  assert.equal(clampConcurrency(undefined, 2), 2);
  assert.equal(clampConcurrency('abc', 7), 7);
  assert.equal(clampConcurrency(2.9), 2);
});

test('cookie 存储形状：原始串与 JSON 数组串都能进，读出来是原文', () => {
  // 原始 cookie 串 → 包成单元素数组（校验要求 JSON 数组）
  const stored = cookieToStorage('sid=abc; uid=7');
  assert.equal(stored, JSON.stringify(['sid=abc; uid=7']));
  assert.equal(cookieText(stored), 'sid=abc; uid=7');
  // 已经是数组串 → 规整后原样返回
  const arr = cookieToStorage('["a=1","b=2"]');
  assert.equal(arr, '["a=1","b=2"]');
  assert.equal(cookieText(arr), 'a=1; b=2');
  // 空值
  assert.equal(cookieToStorage(''), '');
  assert.equal(cookieText(null), '');
  // 坏 JSON 不抛异常，按原文处理
  assert.equal(cookieText('[not json'), '[not json');
});

test('时区校验：UTC / Etc 这类合法 ID 不能被 Intl 枚举表误杀', () => {
  // Intl.supportedValuesOf('timeZone') 不含 UTC、Etc/GMT±N、亚洲老别名，
  // 早期直接查表，导致「环境默认时区 UTC」在控制台里永远报错、存不上。
  assert.deepEqual(validateField('timezone', 'UTC'), []);
  assert.deepEqual(validateField('timezone', 'Etc/UTC'), []);
  assert.deepEqual(validateField('timezone', 'Etc/GMT+3'), []);
  assert.deepEqual(validateField('timezone', 'Asia/Tokyo'), []);
  assert.deepEqual(validateField('timezone', 'America/Argentina/Buenos_Aires'), []);
  // 空格写法按 IANA 规范归一
  assert.deepEqual(validateField('timezone', 'America/New York'), []);
  // 真错的还是要拦，且文案不变（前端直接显示这句）
  assert.equal(validateField('timezone', 'Mars/Olympus')[0].message, 'not an IANA timezone: Mars/Olympus');
  assert.equal(isValidTimezone(''), false);
  assert.equal(isValidTimezone(null), false);
});

/* ---------------- P7 前置：DisabledFonts 落盘是 csv，入参要能收 ---------------- */

test('字体字段：对手落盘是 csv 字符串，入参收 csv 但存储仍是 JSON 数组', () => {
  // 对手 StaticConfig.DisabledFonts 是 "Arial,SimSun" 这种串；迁移脚本会照这个语义传
  assert.deepEqual(csvToArray('Arial,SimSun'), ['Arial', 'SimSun']);
  assert.deepEqual(csvToArray(' Arial , , SimSun '), ['Arial', 'SimSun']);
  assert.deepEqual(csvToArray(''), []);
  assert.deepEqual(csvToArray(['Arial']), ['Arial'], '已经是数组就原样返回');

  // 校验放行
  assert.deepEqual(validateField('disabled_fonts', 'Arial,SimSun'), []);
  assert.deepEqual(validateField('fonts', 'all'), []);
  assert.deepEqual(validateField('blacklist', 'a.com,b.com'), []);
  // 归一成数组（存储形状不跟着对手的文件格式走）
  assert.deepEqual(normalizeValue('disabled_fonts', 'Arial,SimSun'), ['Arial', 'SimSun']);
  assert.deepEqual(normalizeValue('fonts', 'all'), ['all']);

  // 非 csv 字段不许被误当成 csv 收下
  assert.equal(validateField('tabAssistantFeatures', 'tabAssistant').length, 1);
});

test('字体视图：库里是 csv 串（手工改库/老数据）也要读成数组', () => {
  const v1 = fingerprintView({ fonts: 'Arial,SimSun', fp_seed: 's1' });
  assert.deepEqual(v1.fonts, ['Arial', 'SimSun']);
  const v2 = fingerprintView({ fonts: ['all'], fp_seed: 's1' });
  assert.deepEqual(v2.fonts, ['all']);
  const v3 = fingerprintView({ fonts: null, fp_seed: 's1' });
  assert.deepEqual(v3.fonts, ['all']);
});

/* ------------------- P7：注入分层（core/page/worker）与双 Realm 同源 ------------------- */

const P7_W = 300;
const P7_H = 150;

/** 一张确定性的「原始画布」：每次调用都返回新副本，便于重复测量 */
function basePixels() {
  const data = new Uint8ClampedArray(P7_W * P7_H * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37 + (i >> 3) * 11) & 0xff;
  return data;
}

function hashBytes(bytes) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16);
}

/**
 * 造一个最小的 realm（page 或 worker），把注入源真跑一遍。
 * 目的不是模拟浏览器，而是让**同一份注入代码**在两种全局环境下执行，
 * 再比对它们产出的噪声结果 —— 这才是「同源同值」的实证，而不是读源码猜。
 */
function makeRealm(kind, view, navOverrides = {}) {
  const sandbox = {};

  // 2D 画布（page 用 HTMLCanvasElement，两边都有 OffscreenCanvas）
  class OCR2D {
    getImageData() { return { width: P7_W, height: P7_H, data: basePixels() }; }
    putImageData() {}
    drawImage() {}
  }
  class OffscreenCanvas {
    constructor(w = P7_W, h = P7_H) { this.width = w; this.height = h; }
    getContext() { return new OCR2D(); }
    convertToBlob() { return Promise.resolve({ size: 1 }); }
  }
  sandbox.OffscreenCanvas = OffscreenCanvas;
  sandbox.OffscreenCanvasRenderingContext2D = OCR2D;

  class CanvasRenderingContext2D {
    getImageData() { return { width: P7_W, height: P7_H, data: basePixels() }; }
    putImageData() {}
    drawImage() {}
  }
  class HTMLCanvasElement {
    constructor() { this.width = P7_W; this.height = P7_H; }
    getContext() { return new CanvasRenderingContext2D(); }
    toDataURL() { return 'data:image/png;base64,ORIGINAL'; }
    toBlob(cb) { if (cb) cb(null); }
  }
  sandbox.HTMLCanvasElement = HTMLCanvasElement;
  sandbox.CanvasRenderingContext2D = CanvasRenderingContext2D;
  sandbox.document = { createElement: () => new HTMLCanvasElement() };

  class DOMRect {
    constructor(x, y, w, h) { this.x = x; this.y = y; this.width = w; this.height = h; }
  }
  class Element {
    getBoundingClientRect() { return { x: 10, y: 20, width: 100, height: 30 }; }
    getAttribute() { return null; }
  }
  sandbox.DOMRect = DOMRect;
  sandbox.Element = Element;

  class AudioBuffer {
    constructor(len = 2048) { this._d = new Float32Array(len); for (let i = 0; i < len; i++) this._d[i] = Math.sin(i / 7) * 0.5; }
    getChannelData() { return this._d.slice(); }
    copyFromChannel(dest) { dest.set(this._d.subarray(0, dest.length)); }
  }
  sandbox.AudioBuffer = AudioBuffer;

  // 媒体设备：列表来自「内核」（这里是一份固定样本），注入层只许改 label
  const MEDIA_LIST = [
    { deviceId: 'default', groupId: 'g-mic', kind: 'audioinput', label: '' },
    { deviceId: 'a1b2c3d4e5f6', groupId: 'g-mic', kind: 'audioinput', label: '' },
    { deviceId: 'default', groupId: 'g-out', kind: 'audiooutput', label: '' },
  ];
  class MediaDevices { enumerateDevices() { return Promise.resolve(MEDIA_LIST.map((d) => ({ ...d }))); } }
  sandbox.MediaDevices = MediaDevices;
  class MediaDeviceInfo {}
  sandbox.MediaDeviceInfo = MediaDeviceInfo;

  // 语音合成：宿主样本 = 中文 2 条 + 英文 2 条（形状与真机一致：字段都在原型上，原生 default 是中文那条）
  const HOST_VOICES = [
    { name: 'Microsoft Huihui - Chinese (Simplified, PRC)', lang: 'zh-CN', localService: true, default: true },
    { name: 'Microsoft Mark - English (United States)', lang: 'en-US', localService: true, default: false },
    { name: 'Microsoft Kangkang - Chinese (Simplified, PRC)', lang: 'zh-CN', localService: true, default: false },
    { name: 'Microsoft Zira - English (United States)', lang: 'en-US', localService: true, default: false },
  ].map((v) => ({ ...v, voiceURI: v.name }));
  class SpeechSynthesisVoice {
    constructor(o) { Object.defineProperty(this, '_v', { value: o, enumerable: false }); }
    get name() { return this._v.name; }
    get lang() { return this._v.lang; }
    get voiceURI() { return this._v.voiceURI; }
    get localService() { return this._v.localService; }
    get default() { return this._v.default; }
  }
  const VOICE_OBJS = HOST_VOICES.map((o) => new SpeechSynthesisVoice(o));
  class SpeechSynthesis { getVoices() { return VOICE_OBJS.slice(); } }
  sandbox.SpeechSynthesisVoice = SpeechSynthesisVoice;
  sandbox.SpeechSynthesis = SpeechSynthesis;
  sandbox.speechSynthesis = new SpeechSynthesis();

  // Navigator：值全挂在原型上，注入层改的也是原型 —— 与真实浏览器一致
  const NavClass = kind === 'page' ? class Navigator {} : class WorkerNavigator {};
  const navValues = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
    appVersion: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
    platform: 'Linux x86_64', // 故意给个错的，验证 page/worker 都会纠正
    hardwareConcurrency: 4,
    deviceMemory: 4,
    language: 'en-US',
    languages: ['en-US', 'en'],
    webdriver: false,
    vendor: 'Google Inc.',
    mediaDevices: new MediaDevices(),
    permissions: { query: () => Promise.resolve({ state: 'prompt' }) },
    ...navOverrides,
  };
  for (const [k, v] of Object.entries(navValues)) {
    Object.defineProperty(NavClass.prototype, k, { get() { return v; }, configurable: true, enumerable: true });
  }
  sandbox.Navigator = NavClass;
  sandbox.WorkerNavigator = NavClass;
  sandbox.navigator = new NavClass();

  sandbox.window = sandbox;
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);
  const source = kind === 'page' ? buildInjectionSource(view) : buildWorkerInjectionSource(view);
  vm.runInContext(source, context, { filename: `${kind}.inject.js` });
  return { sandbox, context };
}

/** 在某个 realm 里量 OffscreenCanvas 的 2D 像素哈希 */
function offscreenHash(realm) {
  const oc = new realm.sandbox.OffscreenCanvas(P7_W, P7_H);
  const ctx = oc.getContext('2d');
  const img = ctx.getImageData(0, 0, P7_W, P7_H);
  return hashBytes(img.data);
}

const p7View = () => fingerprintView(generateFingerprint({ seed: 'p7-dual-realm', kernel: '156.0.8078.80' }));

test('P7 分层：噪声实现只有一份，page 与 worker 内联的是同一段字节', () => {
  const view = p7View();
  const core = sharedNoiseCoreSource();
  const page = buildInjectionSource(view);
  const worker = buildWorkerInjectionSource(view);

  assert.ok(core.includes('function noiseImageData'), '核心必须含 2D 噪声');
  assert.ok(core.includes('function noiseChannel'), '核心必须含 audio 噪声');
  assert.ok(core.includes('function noisePixels'), '核心必须含 webgl 像素噪声');
  assert.ok(page.includes(core), 'page 层必须内联同一份核心');
  assert.ok(worker.includes(core), 'worker 层必须内联同一份核心');

  // 不许出现第二份定义：copy 一份就会漂移，这是「防根因」那条
  for (const name of ['function noiseImageData', 'function noisePixels', 'function noiseChannel', 'function makeRng']) {
    assert.equal(page.split(name).length - 1, 1, `page 层 ${name} 只能定义一次`);
    assert.equal(worker.split(name).length - 1, 1, `worker 层 ${name} 只能定义一次`);
  }

  // 分层边界：page 层不碰 WorkerNavigator，worker 层不碰 document
  assert.ok(!page.includes('WorkerNavigator'), 'page 层不该有 worker 补丁');
  assert.ok(!worker.includes('document.createElement'), 'worker 层不该有 DOM 依赖');
});

test('P7 双 Realm：同一配置下主帧与 worker 的 OffscreenCanvas 噪声同源同值', () => {
  const view = p7View();
  const page = makeRealm('page', view);
  const worker = makeRealm('worker', view);

  const pageHash = offscreenHash(page);
  const workerHash = offscreenHash(worker);
  assert.equal(pageHash, workerHash, `主帧 ${pageHash} 与 worker ${workerHash} 必须同值`);

  // 确实加过噪：不等于原图像素
  assert.notEqual(pageHash, hashBytes(basePixels()), '噪声必须真的改动了像素');
  // 同一个 realm 重复测量稳定（同种子跨次一致）
  assert.equal(offscreenHash(page), pageHash);
  assert.equal(offscreenHash(worker), workerHash);

  // 诊断字段：realm 标识正确，四个种子快照一致
  assert.equal(page.sandbox.__fpRealm, 'page');
  assert.equal(worker.sandbox.__fpRealm, 'worker');
  assert.equal(
    JSON.stringify(page.sandbox.__fpSeeds),
    JSON.stringify(worker.sandbox.__fpSeeds),
    '四个噪点种子在两侧必须完全一致',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(worker.sandbox.__fpSeeds)), {
    canvas: view.canvas.seed,
    webgl_image: view.webgl_image.seed,
    audio: view.audio.seed,
    client_rects: view.client_rects.seed,
  });
});

test('P7 双 Realm：换种子必须换结果（噪声不是常量）', () => {
  const a = makeRealm('page', p7View());
  const b = makeRealm('page', fingerprintView(generateFingerprint({ seed: 'p7-other-seed', kernel: '156.0.8078.80' })));
  assert.notEqual(offscreenHash(a), offscreenHash(b), '不同种子的画布哈希必须不同');
});

test('P7 双 Realm：core 的 audio 噪声在主帧与 worker 里逐字节相同', () => {
  const view = p7View();
  const core = sharedNoiseCoreSource()
    + '\n;globalThis.__core = { noiseChannel, noisePixels };';
  const page = makeRealm('page', view);
  const worker = makeRealm('worker', view);
  vm.runInContext(core, page.context);
  vm.runInContext(core, worker.context);

  const sample = () => { const a = new Float32Array(2048); for (let i = 0; i < a.length; i++) a[i] = Math.sin(i / 7) * 0.5; return a; };
  const pa = page.sandbox.__core.noiseChannel(sample(), view.audio.seed, 0);
  const wa = worker.sandbox.__core.noiseChannel(sample(), view.audio.seed, 0);
  assert.equal(
    hashBytes(new Uint8Array(pa.buffer)),
    hashBytes(new Uint8Array(wa.buffer)),
    '同一份 core 在两个 realm 里必须给出同一串采样值',
  );

  // noisePixels 是原地改、无返回值，别把返回值当结果用
  const px = new Uint8Array(4096);
  for (let i = 0; i < px.length; i++) px[i] = i & 0xff;
  const ppx = px.slice();
  const wpx = px.slice();
  page.sandbox.__core.noisePixels(ppx, view.webgl_image.seed);
  worker.sandbox.__core.noisePixels(wpx, view.webgl_image.seed);
  assert.equal(hashBytes(ppx), hashBytes(wpx), 'webgl 像素噪声两侧同值');
  assert.notEqual(hashBytes(ppx), hashBytes(px), '像素噪声必须真的改了数据');
});

test('P7 worker 层：UA 已被 CDP 给对就不重复覆盖，没给对才用 JS 补', () => {
  const view = p7View();
  // 专用 worker：CDP 已传播 UA → 不该再叠一层 JS 覆盖（少一层痕迹）
  const good = makeRealm('worker', view, { userAgent: view.ua });
  assert.ok(!JSON.stringify(good.sandbox.__fpApplied).includes('userAgent'), 'CDP 已给对时不该再 patch');

  // SharedWorker / ServiceWorker：实测 CDP 不传播 UA → JS 必须补上
  const bad = makeRealm('worker', view);
  assert.equal(bad.sandbox.navigator.userAgent, view.ua);
  assert.equal(bad.sandbox.navigator.appVersion, view.ua.replace(/^Mozilla\//, ''));
  assert.equal(bad.sandbox.navigator.platform, view.platform);
  assert.equal(bad.sandbox.navigator.hardwareConcurrency, view.hardware_concurrency);
  assert.ok(JSON.stringify(bad.sandbox.__fpApplied).includes('userAgent'));
});

test('P11 page 层：注入后硬件/语言与声明一致，且只装一次（重复注入不叠 patch）', () => {
  const view = p7View();
  const realm = makeRealm('page', view);
  assert.equal(realm.sandbox.navigator.platform, view.platform);
  // hc 自 P11 起走 CDP（Emulation.setHardwareConcurrencyOverride），**JS 层一个字都不碰**：
  // 沙箱里没有 CDP，所以读到的仍是沙箱自己那个值（4），不会被改成 view 的声明值。
  assert.equal(realm.sandbox.navigator.hardwareConcurrency, 4, 'page 层不该再有 hardwareConcurrency 的 JS 覆盖');
  assert.equal(realm.sandbox.navigator.deviceMemory, view.device_memory);
  assert.equal(realm.sandbox.navigator.language, view.language[0]);
  assert.equal(realm.sandbox.__fpInstalled, true);

  const before = offscreenHash(realm);
  vm.runInContext(buildInjectionSource(view), realm.context); // 再来一遍
  assert.equal(offscreenHash(realm), before, '重复注入不能改变噪声结果');
});

/* ============================================================================
 * P11：Function.prototype.toString 一致性
 * ==========================================================================*/

test('P11 toString 补丁：我们装的函数返回 [native code]，页面自定义函数与内置函数逐字不变', () => {
  const realm = makeRealm('page', p7View());
  const sb = realm.sandbox;
  const T = (fn) => vm.runInContext('Function.prototype.toString', realm.context).call(fn);

  // ① 藏住：字面量与裸内核逐字相同（括号永远是空的，长度只在 .length 上）
  assert.equal(T(sb.HTMLCanvasElement.prototype.toDataURL), 'function toDataURL() { [native code] }');
  assert.equal(T(sb.CanvasRenderingContext2D.prototype.getImageData), 'function getImageData() { [native code] }');
  assert.equal(T(sb.AudioBuffer.prototype.getChannelData), 'function getChannelData() { [native code] }');
  assert.equal(T(Object.getOwnPropertyDescriptor(sb.Navigator.prototype, 'platform').get),
    'function get platform() { [native code] }');
  // 形参个数照裸内核（getImageData 4 / getChannelData 1），源码里不展开
  assert.equal(sb.CanvasRenderingContext2D.prototype.getImageData.length, 4);
  assert.equal(sb.AudioBuffer.prototype.getChannelData.length, 1);

  // ② own `toString` 不许有，`fn.toString` 必须就是原型上那个
  const fn = sb.HTMLCanvasElement.prototype.toDataURL;
  assert.equal(Object.prototype.hasOwnProperty.call(fn, 'toString'), false);
  assert.equal(fn.toString, vm.runInContext('Function.prototype.toString', realm.context));

  // ③ 别做过头：页面/沙箱自己定义的函数必须仍是真源码
  const own = vm.runInContext('(() => { const f = function foo() { return 1; }; return [Function.prototype.toString.call(f), f.toString()]; })()', realm.context);
  assert.match(own[0], /return 1/);
  assert.match(own[1], /return 1/);
  assert.doesNotMatch(own[0], /\[native code\]/);
  assert.match(vm.runInContext('Function.prototype.toString.call(class A {})', realm.context), /class A/);

  // ④ toString 自己：四项与裸内核一致 + 非函数 this 仍抛 TypeError
  const ts = vm.runInContext('Function.prototype.toString', realm.context);
  assert.equal(ts.call(ts), 'function toString() { [native code] }');
  assert.equal(ts.name, 'toString');
  assert.equal(ts.length, 0);
  assert.deepEqual(
    (({ writable, enumerable, configurable }) => ({ writable, enumerable, configurable }))(
      Object.getOwnPropertyDescriptor(vm.runInContext('Function.prototype', realm.context), 'toString')),
    { writable: true, enumerable: false, configurable: true },
  );
  // vm 里抛的是那个 realm 的 TypeError，不 instanceOf 宿主的，所以按消息判
  assert.throws(() => ts.call(42), /requires that 'this' be a Function/);
});

test('P11 已知限制 35b：跨 realm 读源码仍能读到（这里钉死现状，修好就得来改这条）', () => {
  const realm = makeRealm('page', p7View());
  // 另一个 realm（等价于 iframe / worker）取一份**原生** toString，再拿我们的包装函数去调
  const other = vm.createContext({});
  const otherT = vm.runInContext('Function.prototype.toString', other);
  const src = otherT.call(realm.sandbox.HTMLCanvasElement.prototype.toDataURL);
  assert.equal(/\[native code\]/.test(src), false,
    '跨 realm 目前读得到真源码 = README 35b 的已知限制；若这里变红说明跨 realm 已被堵住，改文档与这条断言');
  assert.match(src, /seedForCanvas|toDataURL/);
});

/* ============================================================================
 * P9-C 媒体设备：真实枚举 + 只改 label（检测方实测三条抓手的根因）
 * ==========================================================================*/

test('P9-C 媒体设备：未授权不改 label、授权后只改 label，deviceId / 条数保持内核原值', async () => {
  const view = p7View();

  const prompt = makeRealm('page', view);
  const raw = await prompt.sandbox.navigator.mediaDevices.enumerateDevices();
  assert.equal(raw.length, 3, '条数必须来自内核枚举，不能被配置里的数量改写');
  assert.deepEqual(raw.map((d) => d.label), ['', '', ''], '未授权时不许自己造设备名（原生是空串）');
  assert.deepEqual(raw.map((d) => d.deviceId), ['default', 'a1b2c3d4e5f6', 'default'], 'deviceId 必须是内核原值');

  const granted = makeRealm('page', view, { permissions: { query: () => Promise.resolve({ state: 'granted' }) } });
  const named = await granted.sandbox.navigator.mediaDevices.enumerateDevices();
  assert.equal(named.length, 3);
  assert.deepEqual(named.map((d) => d.deviceId), ['default', 'a1b2c3d4e5f6', 'default'], '改名不许改身份');
  assert.equal(named[0].kind, 'audioinput');
  assert.match(named[0].label, /Microphone|Microphone Array|Line In/);
  assert.equal(named[2].label, 'Speakers (Realtek(R) Audio)', '按 kind 各自取名');
});

test('P9-C 媒体设备：权限按 kind 判，只给摄像头时音频设备不改名', async () => {
  const view = p7View();
  const realm = makeRealm('page', view, {
    permissions: {
      query: ({ name }) => Promise.resolve({ state: name === 'camera' ? 'granted' : 'denied' }),
    },
  });
  const list = await realm.sandbox.navigator.mediaDevices.enumerateDevices();
  assert.deepEqual(list.filter((d) => d.kind !== 'videoinput').map((d) => d.label), ['', '', ''],
    '只授权摄像头时，音频 label 必须保持空串（原生按 kind 判权限）');
});

test('P9-C 媒体设备：注入源里不再留「伪造整套列表 / 派生 deviceId」的痕迹', () => {
  const page = buildInjectionSource(p7View());
  assert.ok(!page.includes('buildFakeDevices'), '不许再伪造整套设备列表');
  assert.ok(!page.includes('fakeDeviceId'), '不许再派生 deviceId —— 那正是跨 origin 恒定的根因');
  assert.ok(page.includes('origEnumerate'), '必须基于真实 enumerateDevices 改名');
  assert.ok(page.includes("query({ name })") || page.includes('query({name})'), '授权判定要问 Permissions API');
});

/* ============================================================================
 * P9-A 语音合成：按环境 language 投影 getVoices()
 * ==========================================================================*/

test('P9-A 语音：按环境语言投影，中文声音被挡掉、default 仍恰好一条、形状完整', () => {
  const view = p7View(); // en-US
  const realm = makeRealm('page', view);
  const voices = realm.sandbox.speechSynthesis.getVoices();

  assert.equal(voices.length, 2, '只保留 en-US 的声音');
  assert.ok(voices.every((v) => v.lang === 'en-US'));
  assert.ok(voices.every((v) => !/Huihui|Kangkang|zh-CN/.test(v.name + '|' + v.lang)));
  assert.equal(voices.filter((v) => v.default === true).length, 1, 'default 必须恰好一条（原生也正好一条）');
  assert.equal(voices[0].default, true, '原生 default 被过滤掉时，取剩余列表第一条');

  // 形状完整：五个字段都能读到（原生挂在原型上，不该变成自有字段）
  for (const k of ['name', 'lang', 'voiceURI', 'localService', 'default']) assert.notEqual(voices[0][k], undefined, k);
  assert.equal(Object.keys(voices[0]).join(','), '', 'voice 上不许挂自有可枚举字段（原生没有）');

  // 跨次调用稳定：同一批对象，不是每次 new 一批
  assert.equal(realm.sandbox.speechSynthesis.getVoices()[0], voices[0]);
  assert.ok(JSON.stringify(realm.sandbox.__fpApplied).includes('speech'));
});

test('P9-A 语音：宿主没有该语言的声音时不凭空造（保持原生列表）', () => {
  const view = p7View();
  view.language = ['vi-VN', 'vi'];
  view.locale = 'vi-VN';
  const realm = makeRealm('page', view);
  const voices = realm.sandbox.speechSynthesis.getVoices();
  assert.equal(voices.length, 4, '一条都不匹配时返回原生列表，不造 speak 点不着的声音');
});
/* ============================================================================
 * P8-B 代理健康检查：并发上限 / 单条超时 / 失败归类
 * ==========================================================================*/

test('代理健康检查：真连假代理拿到出口 IP；死端口报「连接被拒」', async () => {
  const fake = await startFakeProxy({ ip: '203.0.113.9', countryCode: 'JP' });
  try {
    const r = await checkOne({ proxy_type: 'http', host: '127.0.0.1', port: fake.port });
    assert.equal(r.ok, true);
    assert.equal(r.ip, '203.0.113.9');
    assert.equal(typeof r.latency_ms, 'number');
    assert.ok(r.checked_at);
  } finally { await fake.close(); }
  const port = await deadPort();
  const bad = await checkOne({ proxy_type: 'http', host: '127.0.0.1', port }, { timeoutMs: 3000 });
  assert.equal(bad.ok, false);
  assert.equal(bad.error_kind, 'connect_refused');
  assert.match(bad.error_label, /连接被拒/);
});

test('代理健康检查：407 归类为认证失败', async () => {
  const fake = await startFakeProxy({ requireAuth: ['u1', 'p1'] });
  try {
    const r = await checkOne({ proxy_type: 'http', host: '127.0.0.1', port: fake.port, username: 'u1', password: 'wrong' }, { timeoutMs: 3000 });
    assert.equal(r.ok, false);
    assert.equal(r.error_kind, 'auth');
    assert.match(r.error_label, /认证失败/);
  } finally { await fake.close(); }
});

test('代理健康检查：并发峰值不超过 3，且每条都跑到', async () => {
  let active = 0, peak = 0, done = 0;
  const probe = async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 30));
    active -= 1; done += 1;
    return { ok: true, ip: '203.0.113.9', latency_ms: 1 };
  };
  const items = Array.from({ length: 9 }, (_, i) => ({ proxy_id: `p${i}`, proxy: { proxy_type: 'http', host: '127.0.0.1', port: 1 } }));
  const r = await checkMany(items, { probe, concurrency: 3 });
  assert.equal(peak, 3, `峰值并发应为 3，实测 ${peak}`);
  assert.equal(done, 9);
  assert.equal(r.ok, 9);
  assert.equal(r.fail, 0);
  assert.equal(r.concurrency, 3);
});

test('代理健康检查：并发传 0 / 超大都被夹在 1..条数', async () => {
  const probe = async () => ({ ok: true, ip: 'x', latency_ms: 1 });
  const one = [{ proxy: { proxy_type: 'http', host: '127.0.0.1', port: 1 } }];
  assert.equal((await checkMany(one, { probe, concurrency: 0 })).concurrency, 1);
  assert.equal((await checkMany(one, { probe, concurrency: 99 })).concurrency, 1);
  const three = [1, 2, 3].map(() => ({ proxy: { proxy_type: 'http', host: '127.0.0.1', port: 1 } }));
  assert.equal((await checkMany(three, { probe, concurrency: 99 })).concurrency, 3);
});

test('代理健康检查：单条卡死不拖住整批（超时记 fail，其余照跑）', async () => {
  const probe = (cfg) => (cfg.port === 9 ? new Promise(() => {}) : Promise.resolve({ ok: true, ip: '203.0.113.9', latency_ms: 1 }));
  const items = [
    { proxy_id: 'slow', proxy: { proxy_type: 'http', host: '127.0.0.1', port: 9 } },
    { proxy_id: 'fast', proxy: { proxy_type: 'http', host: '127.0.0.1', port: 1 } },
  ];
  const r = await checkMany(items, { probe, concurrency: 3, timeoutMs: 150 });
  assert.equal(r.fail, 1);
  assert.equal(r.ok, 1);
  const slow = r.list.find((x) => x.proxy_id === 'slow');
  assert.equal(slow.error_kind, 'timeout');
  assert.match(slow.error_label, /超时/);
  assert.ok(r.elapsed_ms < 3000, `整批应在超时上限附近结束，实测 ${r.elapsed_ms}ms`);
});

test('代理健康检查：错误归类（CONNECT 被拒 / DNS / 配置）', () => {
  assert.equal(classifyProxyFailure('代理拒绝 CONNECT：HTTP/1.1 403 Forbidden'), 'connect_rejected');
  assert.equal(classifyProxyFailure('连接 example.invalid:443 失败：ENOTFOUND'), 'dns');
  assert.equal(classifyProxyFailure('代理配置不完整（host/port 为空）'), 'config');
  assert.equal(classifyProxyFailure(''), 'other');
});

test('cookie：publicCookie 不补默认 sameSite（未声明不许写成 Lax）', () => {
  const c = publicCookie({ name: 'a', value: 'b', domain: '.x.com', path: '/', expires: 1700000000, httpOnly: false, secure: false });
  assert.equal('sameSite' in c, false, '内核没给 sameSite 时不许补默认值');
  assert.equal(publicCookie({ name: 'a', value: 'b', domain: '.x.com', sameSite: 'None' }).sameSite, 'None');
  assert.equal(publicCookie({ name: 'a', value: 'b', domain: '.x.com', sameSite: 'Strict' }).sameSite, 'Strict');
});

test('cookie：分区键双向（CDP partitionKey ↔ AdsPower CookiePartitionKey）', () => {
  const c = publicCookie({
    name: 'p', value: 'v', domain: '.x.com',
    partitionKey: { topLevelSite: 'https://a.com', hasCrossSiteAncestor: true },
  });
  assert.equal(c.partitionKey.topLevelSite, 'https://a.com');
  assert.equal(c.CookiePartitionKey, 'https://a.com');
  const p1 = cdpCookieParam({ name: 'p', value: 'v', domain: '.x.com', CookiePartitionKey: 'https://a.com' });
  assert.deepEqual(p1.param.partitionKey, { topLevelSite: 'https://a.com' });
  const p2 = cdpCookieParam({ name: 'p', value: 'v', domain: '.x.com', partitionKey: { topLevelSite: 'a.com' } });
  assert.equal(p2.param.partitionKey.topLevelSite, 'https://a.com');
});

test('cookie：cookieToStorage 保留对象数组（不是 "[object Object]"）', () => {
  const arr = [{ name: 'sid', value: 'v1', domain: '.example.com' }];
  assert.deepEqual(JSON.parse(cookieToStorage(arr)), arr);
  assert.deepEqual(JSON.parse(cookieToStorage(JSON.stringify(arr))), arr);
  assert.equal(cookieText(cookieToStorage(arr)), 'sid=v1');
  assert.deepEqual(JSON.parse(cookieToStorage('sid=v1; uid=2')), ['sid=v1; uid=2']);
  assert.equal(cookieText(cookieToStorage('sid=v1; uid=2')), 'sid=v1; uid=2');
});

test('导入：proxy 字符串 host:port:user:pass 切四段，密码里的冒号保留', () => {
  const n = normalizeImportItem({ name: 'p', proxy: '198.51.100.10:1080:proxyuser:proxypass:with:colons' });
  assert.equal(n.input.proxy_config.proxy_host, '198.51.100.10');
  assert.equal(n.input.proxy_config.proxy_port, 1080);
  assert.equal(n.input.proxy_config.proxy_user, 'proxyuser');
  assert.equal(n.input.proxy_config.proxy_password, 'proxypass:with:colons');
  const two = normalizeImportItem({ name: 'p', proxy: '198.51.100.10:1080' });
  assert.equal(two.input.proxy_config.proxy_user, '');
  const bad = normalizeImportItem({ name: 'p', proxy: 'not-a-proxy' });
  assert.equal(bad.input.proxy_config, undefined);
  assert.ok(bad.warnings.some((w) => /代理/.test(w) && /not-a-proxy/.test(w)), JSON.stringify(bad.warnings));
});

test('txt：写出 → 读回（19 行/块、18 星、换行替换、sameSite 四值）', () => {
  const cookie = JSON.stringify([
    { name: 'sid', value: 'abc=def==', domain: '.example.com', path: '/', expires: 1793580000, httpOnly: true, secure: true, sameSite: 'no_restriction' },
    { name: 'uid', value: '1', domain: '.example.com', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'unspecified' },
  ]);
  const { content, warnings } = formatAdspowerTxt([{
    profile_id: 'id-1', profile_no: 7, group_id: '0', name: 'a\nb', remark: 'r\r\nr2', domain_name: 'facebook.com',
    cookie, proxy_config: { host: '198.51.100.10', port: 1080, username: 'u', password: 'p:q', proxy_type: 'http' },
    ua: 'Mozilla/5.0 X',
  }]);
  const lines = content.split('\n').filter(Boolean);
  assert.equal(lines.length, 19);
  assert.equal(lines[18], '*'.repeat(18));
  assert.equal(content.includes('\r'), false);
  assert.ok(warnings.some((w) => /换行/.test(w)), JSON.stringify(warnings));
  const back = parseAdspowerTxt(content).items[0];
  assert.equal(back.name, 'a b');
  assert.equal(back.proxy, '198.51.100.10:1080:u:p:q');
  assert.equal(back.cookie[0].sameSite, 'no_restriction');
  assert.equal(back.cookie[1].sameSite, 'unspecified');
  assert.equal(proxyLineOf({ proxy_config: { host: 'h', port: 1 } }), 'h:1');
});

test('txt：key= 空值是合法值（ua 空值点名，不是静默补默认）', () => {
  const r = parseAdspowerTxt(`name=n1
ua=
group=
${'*'.repeat(18)}
`);
  assert.equal(r.items.length, 1);
  assert.equal(r.failed.length, 0);
  assert.ok(r.warnings.some((w) => /ua 是空值/.test(w)), JSON.stringify(r.warnings));
});

/* ============================================================================
 * 逆向侧 .txt 兼容性核对（8.9.23/14）的 5 条：3 条「不许静默」+ 2 条对齐
 * ==========================================================================*/

test('txt 必修 #1：代理仍是 4 段，密码里的冒号写成 %3A 并点名；JSON 那条规则不动', () => {
  const { content, warnings } = formatAdspowerTxt([{
    profile_id: 'id-1', name: 'n',
    proxy_config: { host: 'h', port: 1080, username: 'u', password: 'p:q:r', proxy_type: 'http' },
  }]);
  const line = content.split('\n').find((l) => l.startsWith('proxy='));
  assert.equal(line.slice('proxy='.length), 'h:1080:u:p%3Aq%3Ar');
  assert.equal(line.slice('proxy='.length).split(':').length, 4, 'txt 里必须还是 4 段（对方 150/150 恒 4 段）');
  assert.ok(warnings.some((w) => /第 1 块/.test(w) && /密码含冒号/.test(w) && /认证可能失败/.test(w)), JSON.stringify(warnings));
  // 自己读回：%3A 还原，所以「我们导出 → 我们导入」无损
  assert.equal(parseAdspowerTxt(content).items[0].proxy, 'h:1080:u:p:q:r');
  // JSON 侧规则没被改：默认仍原样保真（密码里的冒号保留）
  assert.equal(proxyLineOf({ proxy_config: { host: 'h', port: 1, username: 'u', password: 'p:q' } }), 'h:1:u:p:q');
  // 对方真实导出里密码原样带冒号 → 仍靠「前 3 段定宽、其余全归密码」读回
  const peer = parseAdspowerTxt(`name=n\nproxy=h:1080:u:p:q\n${'*'.repeat(18)}\n`);
  assert.equal(peer.items[0].proxy, 'h:1080:u:p:q');
});

test('txt 必修 #2：sameSite 未知数值码不静默塌成 unspecified（仍写 unspecified，但点名）', () => {
  const cookie = JSON.stringify([
    { name: 'a', value: '1', domain: '.x.com', path: '/', expires: -1, sameSite: 1 },
    { name: 'b', value: '2', domain: '.x.com', path: '/', expires: -1, sameSite: 'lax' },
  ]);
  const { content, warnings } = formatAdspowerTxt([{ profile_id: 'id-2', name: 'n2', cookie }]);
  const arr = JSON.parse(content.split('\n').find((l) => l.startsWith('cookie=')).slice('cookie='.length));
  assert.deepEqual(arr.map((c) => c.sameSite), ['unspecified', 'lax']);
  assert.ok(warnings.some((w) => /第 1 块/.test(w) && /sameSite 是数值码 1/.test(w) && /unspecified/.test(w)),
    JSON.stringify(warnings));
});

test('txt 必修 #3：name 100 字符上限 —— 导入截断要点名，导出到上限也点名', () => {
  const long = 'x'.repeat(120);
  const n = normalizeImportItem({ name: long });
  assert.equal(n.input.name.length, 100);
  assert.ok(n.warnings.some((w) => /截断/.test(w) && /120/.test(w)), JSON.stringify(n.warnings));

  const { warnings } = formatAdspowerTxt([{ profile_id: 'id-3', name: 'y'.repeat(100) }]);
  assert.ok(warnings.some((w) => /第 1 块/.test(w) && /100 字符上限/.test(w)), JSON.stringify(warnings));
});

test('txt 对齐：group 写空串、countrycode 写小写（JSON 侧各自保持原样）', () => {
  const { content } = formatAdspowerTxt([{
    profile_id: 'id-4', profile_no: 12, group_id: '7', name: 'n4', ip_country: 'US', domain_name: 'facebook.com',
  }]);
  const get = (k) => content.split('\n').find((l) => l.startsWith(`${k}=`)).slice(k.length + 1);
  assert.equal(get('group'), '', '真实导出 150/150 恒空 → 我们也写空串');
  assert.equal(get('countrycode'), 'us', '真实导出 150/150 全小写');
  // 读回：group 空 → 落默认分组；countrycode 原样进 ip_country（大小写不再翻转）
  const back = parseAdspowerTxt(content).items[0];
  assert.equal(back.ip_country, 'us');
  assert.equal(back.group_id, undefined, 'group 空串不产生 group_id（normalize 时会补默认 0）');
  assert.equal(normalizeImportItem(back).input.group_id, '0');
});

/* ============================================================================
 * 空转字段与生效层（0.4.0 追加）：字段表照对手收了，这一版到底哪一层读它
 * ==========================================================================*/

/**
 * coverage = n/a（不是指纹维度）**又在 BASIC 区**的字段。
 *
 * 它们不需要 `effect` 登记（n/a 没有「在哪一层生效」这回事），但也不该标 `idle` ——
 * 名字/分组/标签/备注/域名/启动网址/Cookie 都是「能填、能存、启动链路会读」的元信息。
 * 新加一个 BASIC 字段时三选一：进 effect 注册表（coverage ≠ n/a）、标 idle、登记到这里。
 */
const NON_FP_BASIC = new Set(['name', 'group_id', 'profile_tag_ids', 'remark', 'domain_name', 'open_urls', 'cookie']);

test('空转字段：标了必须说清原因，BASIC 里一个都不许漏标', () => {
  const { fields } = profileFormSchema();
  const idle = fields.filter((f) => f.idle);

  // ① 每个 idle 都要有原因（不许只打个标记糊弄；最短的合法写法是「零读取」三个字）
  assert.deepEqual(idle.filter((f) => !f.idle_reason || f.idle_reason.trim().length < 3).map((f) => f.name), [],
    '这些字段标了 idle 却没写原因');

  // ② 不许把 coverage=full 的字段标成空转
  assert.deepEqual(idle.filter((f) => f.coverage === 'full').map((f) => f.name), [],
    'coverage=full 的字段不该标 idle');

  // ③ BASIC 区里 coverage='none'（字段表收了、代码一次没读）的字段必须标 idle
  assert.deepEqual(fields.filter((f) => f.basic && f.coverage === 'none' && !f.idle).map((f) => f.name), [],
    '这些 BASIC 字段 coverage=none 却没标 idle');

  // ④ 反过来：BASIC 里既没标 idle、又不是 n/a 的，必须在 effect 注册表里真的有生效层
  //    （「加了字段忘标」从此由注册表兜住：没登记就是红的，不用再维护一张 49 行的白名单）
  const notIdleNotNa = fields.filter((f) => f.basic && !f.idle && f.coverage !== 'n/a');
  assert.deepEqual(notIdleNotNa.filter((f) => {
    const kinds = Array.isArray(f.effect) ? f.effect : [f.effect];
    return !f.effect || kinds.includes('none');
  }).map((f) => f.name), [], '这些 BASIC 字段没标 idle，注册表里却没有生效层');

  // ⑤ n/a 的 BASIC 元信息字段：登记在清单里、coverage 必须是 n/a、不许标 idle
  const names = new Set(fields.map((f) => f.name));
  assert.deepEqual([...NON_FP_BASIC].filter((n) => !names.has(n)), [], '清单里有字段表已经不存在的字段');
  assert.deepEqual([...NON_FP_BASIC].filter((n) => {
    const f = fields.find((x) => x.name === n);
    return f.coverage !== 'n/a' || f.idle;
  }), [], '这些字段在清单里，却不是「n/a 且不空转」');

  // ⑥ 数量对得上（0.4.0 effect 注册表那批：从 24 变 43 个**表单可见**的空转字段 —— +19 个
  //    「内核层零读取」的假 full/partial 纠错（browser_kernel_config / cdp_mask / ban_dev_tools /
  //    language_switch / page_language_switch / automatic_timezone / browser_run_args / no_args /
  //    cover_args / open_tabs / new_startup_page / win_x / win_y / clear_cache_after_closing /
  //    browser_security_lock / gpu / gpu_switch / speech_voices / media_devices_config_v2）、
  //    +1 个 media_devices_num（数量字段 P9-C 起不再造设备）。注册表里总共 44 个空转，
  //    其中 browser_run_args 是 HIDDEN（launch_args 的旧别名，不进表单）。少一个或多一个都要先问清楚
  assert.equal(idle.length, 43, `idle 字段 ${idle.length} 个：${idle.map((f) => f.name).join(',')}`);
  // ⑦ 单独钉一条：hidden_notification 的原因是「基线已覆盖」，不是「还没做」
  const hn = idle.find((f) => f.name === 'hidden_notification');
  assert.match(hn.idle_reason, /基线/, 'hidden_notification 的原因是「基线已覆盖」，不是「还没做」');
  // ⑧ overrides.mjs（coverage 的事实源）与 idle 不许互相矛盾：idle 的字段不许标 full。
  //    判据是「不是 full」而不是「必须是 none|partial」：overrides 里还有 n/a（不是指纹维度），
  //    现有 idle 里 hidden_notification / whitelist_open / image_size / device_name_switch 就是 n/a，
  //    它们该留 n/a，不该为了过判据把标签改成 none。
  assert.deepEqual(idle.filter((f) => OVERRIDES_COVERAGE[f.name] === 'full').map((f) => f.name), [],
    '这些字段 schema 标了 idle，overrides 却标 coverage=full —— 假 full 标签');
});

/* ============================================================================
 * effect 注册表：每个字段「在哪一层真的生效」，登记与代码必须对得上
 * ==========================================================================*/

/**
 * 「内核层」：读字段是为了**改变内核/页面的行为**。只有这几类文件算数。
 *
 * 不算的三类（读了也只是搬运，不是生效）：
 *   - `src/api/*`、`src/store/*`：传输/校验/持久化 —— 它们按名字读写字段，但改了不会改行为；
 *   - `src/selfcheck/*`：探针与报告，读的是「声明值」用来比对；
 *   - `src/fingerprint/generate.js`：生成器只**写**默认值（`location_switch: '0'` 这种），不是读。
 * `src/fingerprint/view.js` 单独列为「派生层」：它把平铺字段翻译成注入/启动层要的视图，
 * 判据要它一起算 —— 否则 `screen_resolution`/`device_scale` 这种两条字段的读取点会被误判成零消费。
 */
const KERNEL_LAYERS = [
  'src/kernel/chrome.js', 'src/kernel/launch-args.js', 'src/kernel/inject.js', 'src/kernel/net-rules.js',
  'src/kernel/cookies.js', 'src/kernel/cdp.js', 'src/kernel/version.js',
  'src/runtime/manager.js', 'src/runtime/batch.js',
  'src/proxy/chain.js', 'src/proxy/pac.js', 'src/proxy/egress.js', 'src/proxy/health.js', 'src/proxy/probe.js',
];
const DERIVE_LAYERS = ['src/fingerprint/view.js'];

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

/** 去注释后的源码，按文件缓存（78 个字段 × 16 个文件，别每字段重读重切一遍） */
const layerCache = new Map();
function layerText(file) {
  if (!layerCache.has(file)) layerCache.set(file, stripComments(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')));
  return layerCache.get(file);
}

/**
 * 属性读取点：`.字段名` 或 `['字段名']`。
 * 不用「整词出现」——`tls` 会撞上 `import tls from 'node:tls'`，`location_switch: '0'`（生成器写默认值）
 * 也不是读取。写成 `.name` 之后这两种都不会误报。
 */
function readSites(fieldName, files) {
  const esc = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:\\.\\s*${esc}(?![\\w$])|\\[\\s*['"]${esc}['"]\\s*\\])`);
  const hits = [];
  for (const f of files) {
    layerText(f).split('\n').forEach((line, i) => { if (re.test(line)) hits.push(`${f}:${i + 1}`); });
  }
  return hits;
}

test('effect 注册表：每个字段说清在哪一层生效，登记与代码必须对得上', () => {
  const { fields } = profileFormSchema();
  // 判定用**全量注册表**（138）：schema 出参里有 HIDDEN 字段（launch_args 的旧别名等），
  // 拿它判覆盖范围会把 user_proxy_config / browser_run_args 误判成「n/a 却登记了」。
  const scoped = REGISTRY_FIELDS.filter((f) => f.coverage !== 'n/a').map((f) => f.name);
  const VALID = new Set(['args', 'cdp', 'inject', 'none']);
  const kindsOf = (e) => (Array.isArray(e.effect) ? e.effect : [e.effect]);

  // ① 覆盖范围：指纹/隐私字段一个不许漏、n/a 字段一个不许进
  assert.deepEqual(scoped.filter((n) => !OVERRIDES_EFFECT[n]), [], '这些字段（coverage ≠ n/a）没有登记 effect');
  assert.deepEqual(Object.keys(OVERRIDES_EFFECT).filter((n) => !scoped.includes(n)), [],
    '这些字段登记了 effect，但 coverage 是 n/a（n/a 没有「在哪一层生效」这回事）');
  assert.deepEqual(Object.keys(OVERRIDES_INERT_EXTRA).filter((n) => scoped.includes(n)), [],
    'INERT_EXTRA 是给 n/a 字段用的，scoped 字段的空转理由写在 EFFECT.inert 里');

  // ② 取值合法：none 不许混写；none 必须写 inert；非 none 必须至少一条锚
  for (const [n, e] of Object.entries(OVERRIDES_EFFECT)) {
    const kinds = kindsOf(e);
    assert.ok(kinds.length > 0 && kinds.every((k) => VALID.has(k)), `${n}: 非法 effect ${JSON.stringify(e.effect)}`);
    assert.equal(kinds.includes('none') && kinds.length > 1, false, `${n}: none 不能和别的档混写`);
    if (e.effect === 'none') {
      assert.ok(e.inert && e.inert.trim().length >= 4, `${n}: 登记 none 却没写 inert 理由`);
      assert.ok(!e.sites || !e.sites.length, `${n}: 登记 none 却写了 sites`);
    } else {
      assert.ok(Array.isArray(e.sites) && e.sites.length > 0, `${n}: 登记了 ${e.effect} 却没有 sites 锚`);
    }
  }

  // ③ 每个锚都得在文件里真的存在（代码删了/改名了，注册表没跟上就红）
  const badAnchors = [];
  for (const [n, e] of Object.entries(OVERRIDES_EFFECT)) {
    for (const s of e.sites ?? []) {
      const [file, symbol] = String(s).split('#');
      if (!file || !symbol) { badAnchors.push(`${n}: 锚格式错 ${s}`); continue; }
      let text;
      try { text = layerText(file); } catch { badAnchors.push(`${n}: 锚指向不存在的文件 ${file}`); continue; }
      if (!text.includes(symbol)) badAnchors.push(`${n}: ${file} 里已经没有 "${symbol}"`);
    }
  }
  assert.deepEqual(badAnchors, [], 'effect 锚点对不上代码');

  // ④ 反向：登记 none 的字段，内核层**零读取**；登记了生效层的，内核层/派生层至少读一处
  //    —— 两个方向都查，才是「既防假生效、也防假空转」
  const noneWithReads = [];
  const effectWithoutReads = [];
  for (const [n, e] of Object.entries(OVERRIDES_EFFECT)) {
    const kern = readSites(n, KERNEL_LAYERS);
    if (e.effect === 'none') {
      if (kern.length) noneWithReads.push(`${n}（${kern.slice(0, 3).join(' ')}）`);
    } else if (!readSites(n, [...KERNEL_LAYERS, ...DERIVE_LAYERS]).length) {
      effectWithoutReads.push(n);
    }
  }
  assert.deepEqual(noneWithReads, [], '登记 none，内核层却读到了它 —— 要么改登记，要么把那行代码删掉');
  assert.deepEqual(effectWithoutReads, [], '登记了生效层，但内核层与派生层一次都没读 —— 空转的另一种写法');

  // ⑤ inert 与 idle 必须一致（schema.js 的 idle 就是从 inert 派生的，这里钉死这条派生关系）
  const visible = new Set(fields.map((f) => f.name));
  const genIdle = fields.filter((f) => f.idle).map((f) => f.name).sort();
  const wantIdle = REGISTRY_FIELDS.filter((f) => f.inert && visible.has(f.name)).map((f) => f.name).sort();
  assert.deepEqual(genIdle, wantIdle, 'idle 与 inert 不一致（idle 应当 = 有 inert 且进表单的字段）');
  assert.deepEqual(
    REGISTRY_FIELDS.filter((f) => (OVERRIDES_EFFECT[f.name]?.inert ?? OVERRIDES_INERT_EXTRA[f.name] ?? null) !== (f.inert ?? null)).map((f) => f.name),
    [], '生成物里的 inert 与 overrides.mjs 不一致 —— 忘了重跑 tools/gen-schema.mjs？',
  );

  // ⑥ 各档数量钉死（改一个字段就得改数字，防「悄悄加一个」）
  const census = { none: 0, args: 0, cdp: 0, inject: 0, multi: 0 };
  for (const e of Object.values(OVERRIDES_EFFECT)) {
    const kinds = kindsOf(e);
    if (kinds.length > 1) census.multi += 1;
    else census[kinds[0]] += 1;
  }
  assert.deepEqual(census, { none: 39, args: 10, cdp: 10, inject: 11, multi: 8 },
    `生效层分布变了：${JSON.stringify(census)} —— 新增/删除字段时同步这条与 README 第 41 条`);
  assert.equal(scoped.length, 78, `指纹/隐私字段 ${scoped.length} 个`);
});


/* ============================================================================
 * 判据⑨：字段表产物必须是最新生成的结果
 * ==========================================================================*/

/** 首个不同字节的下标；完全相同 → -1（用来把「哪儿不一样」写进断言信息） */
function firstDiffByte(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

test('字段表产物是最新的：重新生成必须与仓库里那份逐字节相同', () => {
  const { fieldsJson, ddl } = buildArtifacts();
  const pairs = [
    ['fields.generated.json', fieldsJson],
    ['schema.sql', ddl],
  ];

  for (const [name, generated] of pairs) {
    // 读原始字节比对：连 CRLF / BOM / 末尾换行都算差异（这三样以前真出过）
    const onDisk = fs.readFileSync(new URL(`../packages/profile/src/${name}`, import.meta.url));
    const want = Buffer.from(generated, 'utf8');
    const at = firstDiffByte(onDisk, want);
    assert.equal(at, -1, at === -1 ? '' : `${name} 与 tools/gen-schema.mjs 的生成结果不一致：第一处差异在第 ${at} 字节`
      + `（仓库里 ${onDisk.length} B，生成器 ${want.length} B）—— 跑 \`node tools/gen-schema.mjs\` 再提交`);
  }
});
