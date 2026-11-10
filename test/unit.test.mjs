/**
 * 不需要 Chrome 的单元测试：代理预检 / 启动参数白名单 / UA 跟版 / 校验分级。
 * 跑法：node --test test/unit.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { checkProxy, httpGetViaProxy, normalizeProxyConfig, hasProxy, parseExitInfo } from '../src/proxy/probe.js';
import { mergeLaunchArgs, parseLaunchArgs } from '../src/kernel/launch-args.js';
import { alignProfileToKernel } from '../src/kernel/version.js';
import { checkProfile } from '../src/store/profiles.js';
import { checkEgress, validateField, isValidTimezone } from '../packages/profile/src/validate.js';
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
    media_devices: { supported: true, counts: mc, list: [] },
    webrtc: { supported: true, count: 0, types: [], addresses: [] },
  };
}

test('自检报告：声明一致时 full=pass、partial=warn、字体=none 标黄', () => {
  const p = selfProfile();
  const report = buildReport(p, fakeRaw(p), { kernelVersion: '156.0.8078.80' });
  const byId = Object.fromEntries(report.items.map((i) => [i.id, i]));
  assert.equal(report.items.length, 15);
  assert.equal(byId.ua.status, 'pass');
  assert.equal(byId.ua.coverage, 'full');
  assert.equal(byId.webgl.status, 'warn');
  assert.equal(byId.webgl.coverage, 'partial');
  assert.equal(byId.canvas.status, 'warn');
  assert.equal(byId.fonts.coverage, 'none');
  assert.equal(byId.fonts.status, 'warn');
  assert.equal(byId.webrtc.status, 'pass');
  assert.equal(report.summary.full, 7, JSON.stringify(report.summary));
  assert.equal(report.summary.partial, 7);
  assert.equal(report.summary.none, 1);
  assert.equal(report.summary.fail, 0);
  assert.equal(report.determinism.cross_restart, null);
  assert.ok(report.summary.score > 70 && report.summary.score < 100);
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