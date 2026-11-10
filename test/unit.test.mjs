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
import { checkEgress } from '../packages/profile/src/validate.js';
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