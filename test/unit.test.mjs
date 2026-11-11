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
import { fingerprintView } from '../src/fingerprint/view.js';
import { buildReport } from '../src/selfcheck/report.js';
import { renderHtml } from '../src/selfcheck/html.js';
import { pacInUse, pacMessage } from '../src/proxy/pac.js';
import { buildArgs } from '../src/kernel/chrome.js';
import { ok, unsupported } from '../src/api/contract.js';
import { clampConcurrency } from '../src/runtime/batch.js';
import { cookieToStorage, cookieText } from '../src/store/profiles.js';
import { startFakeProxy } from './fake-proxy.mjs';
import vm from 'node:vm';
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

test('P7 page 层：注入后硬件/语言与声明一致，且只装一次（重复注入不叠 patch）', () => {
  const view = p7View();
  const realm = makeRealm('page', view);
  assert.equal(realm.sandbox.navigator.platform, view.platform);
  assert.equal(realm.sandbox.navigator.hardwareConcurrency, view.hardware_concurrency);
  assert.equal(realm.sandbox.navigator.deviceMemory, view.device_memory);
  assert.equal(realm.sandbox.navigator.language, view.language[0]);
  assert.equal(realm.sandbox.__fpInstalled, true);

  const before = offscreenHash(realm);
  vm.runInContext(buildInjectionSource(view), realm.context); // 再来一遍
  assert.equal(offscreenHash(realm), before, '重复注入不能改变噪声结果');
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

test('P9-C 媒体设备：注入源里不再留「伪造整套列表 / 派生 deviceId」的痕迹', () => {
  const page = buildInjectionSource(p7View());
  assert.ok(!page.includes('buildFakeDevices'), '不许再伪造整套设备列表');
  assert.ok(!page.includes('fakeDeviceId'), '不许再派生 deviceId —— 那正是跨 origin 恒定的根因');
  assert.ok(page.includes('origEnumerate'), '必须基于真实 enumerateDevices 改名');
  assert.ok(page.includes("query({ name })") || page.includes('query({name})'), '授权判定要问 Permissions API');
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
