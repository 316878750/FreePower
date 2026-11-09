// FreePower · profile 层验收测试
// 跑法：node --test packages/profile/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { FIELDS, BY_NAME, FIELD_META, FP_KEYS, GROUPS, coverageSummary } from '../src/fields.js';
import { openDatabase, createProfile, getProfile, updateProfile, listProfiles, deleteProfile, seedFromId } from '../src/repo.js';
import { validateField, validateProfile } from '../src/validate.js';
import { toCanonical, toV2 } from '../src/aliases.js';

const db = () => openDatabase(':memory:');

/** 给每个字段造一个合法值，用来做全字段往返 */
function plausible(f) {
  if (f.name === 'cookie') return JSON.stringify([{ name: 'c', value: 'v', domain: '.example.com', path: '/' }]);
  if (f.name === 'timezone') return 'Asia/Shanghai';
  if (f.name === 'screen_resolution') return '1920_1080';
  if (f.name === 'ua') return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  if (f.name === 'fonts') return ['all'];
  if (f.name === 'allow_scan_ports') return ['4000', '4001'];
  if (f.name === 'webgl_config') return { unmasked_vendor: 'Google Inc. (NVIDIA)', unmasked_renderer: 'ANGLE (NVIDIA, GeForce RTX 3060)', webgpu: { webgpu_switch: '1' } };
  if (f.name === 'client_hints') return { platform: 'Windows', platform_version: '10.0.0', architecture: 'x86', bitness: '64', mobile: '0', wow64: '0', ua_full_version: '131.0.0.0', model: '' };
  if (f.name === 'mac_address_config') return { model: '2', address: '1a:2b:3c:4d:5e:6f' };
  if (f.name === 'media_devices_num') return { audioinput_num: 2, videoinput_num: 1, audiooutput_num: 2 };
  if (f.type.startsWith('array')) {
    if (f.type === 'array<string>') return f.name === 'fonts' ? ['all'] : ['tag-1'];
    if (f.type === 'array<object>') return [{ kind: 'audioinput', label: 'Mic' }];
    return ['tabAssistant'];
  }
  if (Array.isArray(f.values)) {
    const pick = f.values.find((v) => v !== 'default' && v !== 0) ?? f.values[0];
    return pick;
  }
  switch (f.type) {
    case 'number':
      if (f.name === 'device_scale') return 1;
      if (['longitude', 'latitude'].includes(f.name)) return 121.473701;
      if (f.name === 'accuracy') return 1000;
      return 1;
    case 'object':
      if (f.name === 'browser_kernel_config') return { version: '131', type: 'chrome' };
      if (f.name === 'user_proxy_config') return { proxy_type: 'http', proxy_host: '127.0.0.1', proxy_port: 8080 };
      if (f.name === 'storage_cloud_option') return {};
      return {};
    case 'array<string>':
      return ['tag-1'];
    case 'array<object>':
      return [{ kind: 'audioinput', label: 'Mic' }];
    case 'array<enum>':
      return ['tabAssistant'];
    default:
      return 'x';
  }
}

test('字段表：138 个唯一字段、11 个分组、6 个进 fingerprint_config', () => {
  assert.equal(FIELD_META.count, 138);
  assert.equal(FIELDS.length, 138);
  assert.equal(GROUPS.length, 11);
  assert.deepEqual(FP_KEYS.sort(), ['client_hints', 'mac_address_config', 'media_devices_config', 'media_devices_config_v2', 'media_devices_num', 'webgl_config']);
  // 拆解表 139 条原始记录里 virtual_camera 在两组重复出现 → 去重后 138
  assert.equal(BY_NAME.get('virtual_camera').alsoIn.length, 1);
});

test('覆盖度统计：明确区分 full / partial / none', () => {
  const c = coverageSummary();
  assert.equal(c.full.length + c.partial.length + c.none.length + c['n/a'].length, 138);
  // 字体是 CDP 路线的硬伤，必须诚实标 none
  assert.ok(c.none.includes('fonts'), 'fonts 必须标 none');
  assert.ok(c.none.includes('disabled_fonts'));
  // WebRTC 走启动参数，是真行为
  assert.ok(c.full.includes('webrtc'));
  assert.ok(c.full.includes('timezone'));
  assert.ok(c.full.includes('client_hints'));
});

test('值域硬约束：按拆解表 §12 逐条卡', () => {
  assert.deepEqual(validateField('hardware_concurrency', 5), [{ field: 'hardware_concurrency', message: validateField('hardware_concurrency', 5)[0].message }]);
  assert.equal(validateField('hardware_concurrency', 5).length, 1);
  assert.equal(validateField('hardware_concurrency', 12).length, 0);
  assert.equal(validateField('hardware_concurrency', 'default').length, 0);
  assert.equal(validateField('device_memory', 3).length, 1);
  assert.equal(validateField('device_memory', 8).length, 0);
  assert.equal(validateField('webgl', '1').length, 1, 'webgl 没有 "1"');
  assert.equal(validateField('webgl', '2').length, 0);
  assert.equal(validateField('device_scale', 2.5).length, 1);
  assert.equal(validateField('device_scale', 1.25).length, 0);
  assert.equal(validateField('webrtc', 'bogus').length, 1);
  assert.equal(validateField('cookie', 'not json').length, 1);
  assert.equal(validateField('cookie', '{"a":1}').length, 1, 'cookie 必须是 list string');
  assert.equal(validateField('timezone', 'Asia/Shang').length, 1);
  assert.equal(validateField('screen_resolution', '1920x1080').length, 1);
  assert.equal(validateField('media_devices_num', { audioinput_num: 12 }).length, 1);
  assert.equal(validateField('mac_address_config', { model: '2', address: 'zz' }).length, 1);
});

test('建库 + 全字段写入 + 读回（平铺列 / csv / json / fingerprint_config）', () => {
  const d = db();
  const input = { group_id: 'g1', name: 'env-1' };
  for (const f of FIELDS) input[f.name] = plausible(f);
  input.group_id = 'g1';
  input.name = 'env-1';

  const res = createProfile(d, input);
  assert.equal(res.ok, true, JSON.stringify(res.errors));

  const back = getProfile(d, res.profile.id);
  // 平铺标量
  assert.equal(back.name, 'env-1');
  assert.equal(back.ua, input.ua);
  assert.equal(back.webgl, String(input.webgl));
  // csv 列
  assert.deepEqual(back.profile_tag_ids, ['tag-1']);
  // 独立 JSON 列
  assert.deepEqual(back.open_urls, input.open_urls);
  assert.equal(back.browser_kernel_config.version, '131');
  // fingerprint_config
  assert.equal(back.webgl_config.unmasked_vendor, 'Google Inc. (NVIDIA)');
  assert.equal(back.client_hints.platform, 'Windows');
  assert.deepEqual(back.mac_address_config, { model: '2', address: '1a:2b:3c:4d:5e:6f' });

  // 库里只有一个 JSON 列承载指纹对象
  const row = d.prepare('SELECT fingerprint_config FROM profiles WHERE id = ?').get(back.id);
  const fp = JSON.parse(row.fingerprint_config);
  assert.deepEqual(Object.keys(fp).sort(), FP_KEYS.sort());
});

test('fp_seed 确定性：同 id 同种子，不同 id 不同种子', () => {
  assert.equal(seedFromId('a'), seedFromId('a'));
  assert.notEqual(seedFromId('a'), seedFromId('b'));
});

test('更新是合并：只改 webgl_config 一半不能丢另一半', () => {
  const d = db();
  const { profile } = createProfile(d, { group_id: 'g1', name: 'e', webgl: '2', webgl_config: { unmasked_vendor: 'V1', unmasked_renderer: 'R1', webgpu: { webgpu_switch: '1' } } });
  const up = updateProfile(d, profile.id, { webgl_config: { unmasked_renderer: 'R2' } });
  assert.equal(up.ok, true);
  const back = getProfile(d, profile.id);
  assert.equal(back.webgl_config.unmasked_renderer, 'R2');
  assert.equal(back.webgl_config.unmasked_vendor, 'V1', '旧键必须保留');
  assert.equal(back.webgl_config.webgpu.webgpu_switch, '1');
});

test('一致性检查：UA / platform / UA-CH / webgl / 语言时区 对不上要报', () => {
  const bad = validateProfile({
    group_id: 'g1',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    client_hints: { platform: 'macOS', ua_full_version: '141.0.7390.0' },
    webgl: '2',
    webgl_config: { unmasked_renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))' },
    language: ['en-US'],
    timezone: 'Asia/Tokyo',
    hardware_concurrency: 24,
    device_memory: 2,
    webrtc: 'proxy',
  });
  const fields = bad.warnings.map((w) => w.field);
  assert.ok(fields.includes('platform'), 'UA 说 Windows 但 platform=MacIntel 要报');
  assert.ok(fields.includes('client_hints.ua_full_version'), 'UA 131 vs ua_full_version 141 要报');
  assert.ok(fields.includes('webgl_config'), 'webgl=2 缺 vendor 要报');
  assert.ok(fields.includes('webgl_config.unmasked_renderer'), 'SwiftShader 要报');
  assert.ok(fields.includes('timezone'), 'en-US 配 Asia/Tokyo 要报');
  assert.ok(fields.includes('hardware_concurrency'), '24 核配 2G 要报');
  assert.ok(fields.includes('webrtc'), 'proxy 模式没绑代理要报');
});

test('一致性检查：干净的配置不该报警', () => {
  const good = validateProfile({
    group_id: 'g1',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'Win32',
    client_hints: { platform: 'Windows', ua_full_version: '131.0.6778.86' },
    webgl: '2',
    webgl_config: { unmasked_vendor: 'Google Inc. (NVIDIA)', unmasked_renderer: 'ANGLE (NVIDIA, GeForce RTX 3060)', webgpu: { webgpu_switch: '1' } },
    language: ['zh-CN', 'zh'],
    timezone: 'Asia/Shanghai',
    hardware_concurrency: 8,
    device_memory: 8,
    webrtc: 'disabled',
  });
  assert.deepEqual(good.warnings, []);
});

test('别名：v1/v2 同一 handler 两套参数名', () => {
  // v1：platform 是域名，random_fingerprint 不是 switch_random_finger
  assert.deepEqual(toCanonical({ platform: 'facebook.com', group_id: '9', random_fingerprint: '1' }, 'v1'), {
    domain_name: 'facebook.com', group_id: '9', random_fingerprint: '1',
  });
  // v2
  assert.deepEqual(toCanonical({ batch_id: '9', profile_tag_ids: undefined, fbcc_user_tag_ids: ['t1'], switch_random_finger: '1', sys_app_cate_id: 'c1' }, 'v2'), {
    group_id: '9', profile_tag_ids: ['t1'], random_fingerprint: '1', category_id: 'c1',
  });
  const v2 = toV2({ id: 'p1', profile_no: 10001, group_id: '9', profile_tag_ids: ['t1'] });
  assert.equal(v2.profile_id, 'p1');
  assert.equal(v2.batch_id, '9');
  assert.equal(v2.fbcc_user_tag_ids[0], 't1');
  // 老脚本兼容
  assert.equal(v2.user_id, 'p1');
});

test('CRUD 与列表过滤', () => {
  const d = db();
  const a = createProfile(d, { group_id: 'g1', name: 'a' }).profile;
  createProfile(d, { group_id: 'g2', name: 'b' });
  assert.equal(listProfiles(d).length, 2);
  assert.equal(listProfiles(d, { group_id: 'g2' }).length, 1);
  assert.equal(listProfiles(d, { group_id: 'g2' })[0].name, 'b');
  assert.equal(deleteProfile(d, a.id), true);
  assert.equal(getProfile(d, a.id), null);
});
