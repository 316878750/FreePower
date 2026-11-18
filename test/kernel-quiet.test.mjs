/**
 * 内核「安静启动」判据（0.4.7.5 红②，B 层，真内核）。
 *
 * 用户 2026-11-18 14:32 的实测：4 个环境同开，Chrome 一个实例启动瞬间对代理开 **14 条连接**，
 * 其中 10 条是 Google 后台（clients2 / clientservices / update.googleapis / redirector.gvt1 /
 * chromewebstore / www.googleapis / accounts.google / www.gstatic …）。它们和业务请求抢同一台
 * 上游的拨号槽位，14 并发把上游 accept 队列打满 → 中继 10 秒超时 → 整页打不开。
 *
 * 这里用**只数域名的假 SOCKS5**（sink 模式：回 OK 后丢弃数据，不真拨）量启动瞬间的连接，
 * 完全不碰用户的真代理。
 *
 * 实测读数（2026-11-18，内核 157.0.8103.78，同一份 buildArgs）：
 *   改之前（无这 8 个 flag）：13 条连接 / 8 个后台域名
 *     clients2.google.com, clientservices.googleapis.com, update.googleapis.com,
 *     accounts.google.com, www.googleapis.com, chromewebstore.googleapis.com,
 *     www.gstatic.com, www.google.com
 *   改之后：8 条连接 / 3 个后台域名
 *     accounts.google.com（ListAccounts）、www.gstatic.com（OHTTP 公钥）、www.google.com（地址栏 zero-suggest）
 *
 * **剩下这 3 个是 headed Chrome 的 UI 自身请求，不是后台网络任务**，这 8 个 flag 关不掉：
 *   - `accounts.google.com/ListAccounts?...` → Chrome 登录态查询；
 *   - `www.gstatic.com/ohttp_gateway/hpke_public_keys/...` → 隐私沙箱 OHTTP 公钥；
 *   - `www.google.com/async/folae?...` → 地址栏联想。
 * 关它们要动 Preferences（`signin.allowed` / `search.suggest_enabled` / 隐私沙箱预置），
 * 会真的影响用户「在 Chrome 里登录 Google / 地址栏联想」这些功能 —— 本版不做，按已知限制记。
 * 判据因此钉的是**真实读数**：后台域名 ⊆ 这三个、连接数 ≤ 8（改之前是 13）。
 *
 * 跑法：npm run test:kernel-quiet
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findChrome, launchChrome, killProcessTree, buildArgs } from '../src/kernel/chrome.js';
import { startFakeSocks5 } from './fake-socks5.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/** 这 8 个 flag 必须都在 argv 里（改了名字或删掉一条，这条会红） */
const QUIET_FLAGS = [
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-domain-reliability',
  '--no-pings',
  '--disable-client-side-phishing-detection',
  '--disable-default-apps',
  '--metrics-recording-only',
];
/** 允许残留的三个「Chrome UI 自身请求」（见文件头） */
const ALLOWED_RESIDUE = ['accounts.google.com', 'www.gstatic.com', 'www.google.com'];
const isGoogle = (h) => /(^|\.)(google|gstatic|gvt1)\.com$/.test(h) || /googleapis\.com$/.test(h);

const chrome = findChrome();
if (!chrome?.path) {
  console.error('找不到内核，B 层判据没法跑');
  process.exit(2);
}

const proxy = await startFakeSocks5({ requireAuth: null, sink: true, capture: true, label: 'quiet' });
const udd = path.join(os.tmpdir(), `fp-quiet-${Date.now()}`);
fs.mkdirSync(udd, { recursive: true });

const profile = { profile_id: 'quiet', webgl_config: {}, fingerprint_config: {} };
const built = buildArgs(profile, {
  userDataDir: udd,
  proxy: { type: 'socks5', host: '127.0.0.1', port: proxy.port },
  proxyBound: true,
});
const args = [...built.args, 'http://example.test/quiet'];

console.log(`内核 ${chrome.version}；假代理 127.0.0.1:${proxy.port}（只数域名）`);

let child = null;
try {
  // ① 参数层：8 个 flag 一个都不能少
  const missing = QUIET_FLAGS.filter((f) => !args.includes(f));
  check('① 启动参数里有全部 8 个「关后台网络」的 flag', missing.length === 0, missing.length ? `缺 ${missing.join(',')}` : '8/8');

  child = launchChrome(chrome.path, args);
  // 启动瞬间的后台连接基本都在前 10 秒内发出来（CEO 实测 12 秒读完全部 14 条）
  await new Promise((r) => setTimeout(r, 11000));
  killProcessTree(child.pid);
  child = null;
  await new Promise((r) => setTimeout(r, 500));

  const hosts = proxy.hostnames();
  const google = hosts.filter(isGoogle);
  const residue = google.filter((h) => !ALLOWED_RESIDUE.includes(h));
  console.log(`总连接=${proxy.stats.connections} 去重域名=${hosts.length}：${JSON.stringify(hosts)}`);

  // ② 业务请求真的到了代理（否则「0 个后台域名」可能只是内核没起来）
  check('② 业务请求（example.test）真的经过了代理 —— 内核确实起来了',
    proxy.records.some((r) => r.host === 'example.test'), `records=${proxy.records.length}`);

  // ③ 后台域名：改之前 8 个，现在只允许那 3 个 UI 自身请求
  check('③ 后台域名只剩 3 个 Chrome UI 自身请求（改之前 8 个）',
    google.length <= 3 && residue.length === 0,
    `google=${google.length} ${JSON.stringify(google)}${residue.length ? ` 意外=${JSON.stringify(residue)}` : ''}`);

  // ④ 连接总数：改之前 13，现在 ≤ 8（抢槽位的扇出被砍掉）
  check('④ 启动瞬间的连接总数 ≤ 8（改之前 13）',
    proxy.stats.connections <= 8, `connections=${proxy.stats.connections}`);

  // ⑤ 被砍掉的必须是「一个都不剩」，不是「少了一点」
  const killed = ['clients2.google.com', 'clientservices.googleapis.com', 'update.googleapis.com',
    'redirector.gvt1.com', 'chromewebstore.googleapis.com', 'www.googleapis.com'];
  const survived = killed.filter((h) => hosts.includes(h));
  check('⑤ CEO 点名的那几条后台连接一条都不剩',
    survived.length === 0, survived.length ? `还在：${survived.join(',')}` : '0/6');
} finally {
  if (child) killProcessTree(child.pid);
  await proxy.close().catch(() => {});
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch { /* 句柄还在 */ }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);
