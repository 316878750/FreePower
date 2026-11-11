#!/usr/bin/env node
/**
 * P7 · 双 Realm 真机测试（worker / SharedWorker / ServiceWorker / AudioWorklet）
 *
 * 为什么要有这个文件：`.tmp` 里的临时探针不进版本库 —— 换台机器、换个人就没法复跑，
 * 而「五个 canvas 哈希一致」是 W2 唯一的真机证据。所以把它固化成能单独跑的测试：
 *
 *   node test/workers.test.mjs
 *
 * 断言（全部是真机实测，不是推断）：
 *   ① 三类 worker 的脚本**第一行**就能读到 self.__fpRealm === 'worker'（无裸窗口）
 *   ② 主帧 DOM canvas / 主帧 OffscreenCanvas / 专用 worker / SharedWorker / ServiceWorker
 *      五处 canvas 哈希完全一致（噪声同源同值）
 *   ③ 硬件、语言、时区、UA 在 worker 与主帧一致
 *   ④ workerStats.injected 精确等于 3（不多不少），failed 为空
 *   ⑤ 自检报告里四项新条目（三个 realm + AudioWorklet）存在且状态符合预期
 *
 * 自带起环境与收尾：本地 http 源、临时数据目录、退出前 stop + 杀进程、删临时目录。
 * 需要真实 Chrome 与完整权限（沙箱挡命名管道，Chrome 起不来）。
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'freepower-workers-'));
process.env.FREEPOWER_DATA = DATA;
process.env.FREEPOWER_SELFCHECK = '0';            // 本测试自己显式跑自检
process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never'; // 出口探测必然失败，只是告警
process.env.FREEPOWER_EGRESS_TIMEOUT = '1500';
process.env.FREEPOWER_UA_AUTOALIGN = '1';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const { startProfile, stopProfile, getInstance } = await import('../src/runtime/manager.js');
const { createProfile, getProfile, deleteProfiles } = await import('../src/store/profiles.js');
const { openSelfcheckOrigin } = await import('../src/selfcheck/origin.js');
const { buildProbeSource } = await import('../src/selfcheck/probe.js');
const { runSelfCheck } = await import('../src/selfcheck/index.js');
const { findChrome, killProcessTree } = await import('../src/kernel/chrome.js');
const { closeDb } = await import('../src/store/db.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等进程真的退出（Windows 上 user-data-dir 要等它放手才能删） */
async function waitPidGone(targetPid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(targetPid, 0); } catch { return true; }
    await sleep(150);
  }
  return false;
}

const chrome = findChrome();
if (!chrome) {
  console.error('没有可用内核，设置 FREEPOWER_CHROME 后重试');
  process.exit(2);
}
console.log(`内核：${chrome.version} (${chrome.source})`);
console.log(`临时数据目录：${DATA}\n`);

let origin = null;
let id = null;
let pid = null;
let udd = null;

try {
  origin = await openSelfcheckOrigin();
  console.log(`本地源：${origin.url}`);

  const created = createProfile({ name: `p7-workers-${Date.now()}`, group_id: '0', remark: 'P7 双 Realm 真机测试' });
  id = created.profile_id;

  const started = await startProfile(getProfile(id));
  pid = started.pid;
  const inst = getInstance(id);
  udd = inst.user_data_dir;
  console.log(`已启动 pid=${pid} port=${started.debug_port} version=${started.real_version}\n`);

  /* ---------- 1. 真机探针：主帧 + 三类 worker 同页对照 ---------- */
  const page = await inst.openPage(origin.url);
  for (let i = 0; i < 50; i++) {
    const r = await inst.client.send('Runtime.evaluate', {
      expression: 'document.title === "FreePower selfcheck"',
      returnByValue: true,
    }, page.sessionId).catch(() => null);
    if (r?.result?.value === true) break;
    await sleep(150);
  }

  const res = await inst.client.send('Runtime.evaluate', {
    expression: buildProbeSource(),
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, page.sessionId);
  if (res.exceptionDetails) {
    throw new Error(`自检探针异常：${JSON.stringify(res.exceptionDetails).slice(0, 400)}`);
  }
  const raw = res.result.value;
  const w = raw.workers || {};

  check('探针跑到主帧', !!w.main, w.main ? `realm=${w.main.realm}` : 'w.main 为空');
  check('主帧不在 about:blank 回落（worker 只能在真 http 源上构造）', !w.note, w.note || '在安全上下文里');

  const realms = ['dedicated', 'shared', 'service'];
  const hashes = {
    'main.DOM': w.main?.canvas_dom,
    'main.Offscreen': w.main?.canvas_offscreen,
  };
  for (const k of realms) hashes[k] = w[k]?.canvas;

  console.log('\n  canvas 哈希：');
  for (const [k, v] of Object.entries(hashes)) console.log(`    ${k.padEnd(16)} ${v ?? '—'}`);

  const hashValues = Object.values(hashes).filter(Boolean);
  check('五处 canvas 哈希全部取到', hashValues.length === 5, `${hashValues.length}/5`);
  check('五处 canvas 哈希完全一致（噪声同源同值）',
    hashValues.length === 5 && hashValues.every((v) => v === hashValues[0]),
    hashValues.join(' / '));

  for (const k of realms) {
    const r = w[k] || {};
    check(`${k}：脚本首行已注入（atTop === 'worker'）`, r.atTop === 'worker',
      `atTop=${JSON.stringify(r.atTop ?? null)} realm=${JSON.stringify(r.realm ?? null)}`);
    const diffs = [];
    for (const f of ['ua', 'platform', 'cores', 'memory', 'language', 'languages', 'timezone']) {
      if (w.main && w.main[f] !== undefined && String(w.main[f]) !== String(r[f])) {
        diffs.push(`${f}: ${w.main[f]} != ${r[f]}`);
      }
    }
    check(`${k}：硬件/语言/时区/UA 与主帧一致`, diffs.length === 0, diffs.join('; ') || '全一致');
  }

  /* ---------- 2. AudioWorklet：核实「裸的只有 sampleRate / currentTime」 ---------- */
  const wl = raw.audioworklet || {};
  check('AudioWorklet 探针取到实测值', wl.ok === true, JSON.stringify({ sr: wl.sampleRate, t: wl.currentTime, err: wl.error }));
  check('AudioWorklet 确实没被注入（fpInjected=false）', wl.ok === true && !wl.fpInjected);
  check('AudioWorklet 的可测表面只有 sampleRate/currentTime',
    Array.isArray(wl.surfaces) && wl.surfaces.join(',') === 'sampleRate,currentTime', (wl.surfaces || []).join(','));

  /* ---------- 3. workerStats 计数 ---------- */
  const stats = inst.workerStats || {};
  console.log(`\n  workerStats: ${JSON.stringify(stats)}`);
  check('injected 精确等于 3（专用 worker + SharedWorker + ServiceWorker）', stats.injected === 3, `injected=${stats.injected}`);
  check('没有注入失败', Array.isArray(stats.failed) && stats.failed.length === 0,
    (stats.failed || []).map((f) => `${f.type}:${f.reason}`).join('; ') || '无');

  /* ---------- 4. 自检报告四项 ---------- */
  const report = await runSelfCheck(inst, getProfile(id));
  const byId = Object.fromEntries((report.items || []).map((it) => [it.id, it]));
  for (const [key, label] of [['realm_dedicated', '专用 Worker'], ['realm_shared', 'SharedWorker'], ['realm_service', 'ServiceWorker']]) {
    const it = byId[key];
    check(`自检含「${label}（双 Realm）」且通过`, !!it && it.status === 'pass',
      it ? `status=${it.status} canvas=${it.actual?.canvas} atTop=${it.actual?.atTop}` : '缺这一项');
  }
  const aw = byId.audio_worklet;
  check('自检含 AudioWorklet 且标 none/标黄', !!aw && aw.coverage === 'none' && aw.status === 'warn',
    aw ? `coverage=${aw.coverage} status=${aw.status}` : '缺这一项');
  check('自检符合度汇总里 partial 至少 3 项（三个 realm）', (report.summary?.partial || 0) >= 3,
    `full=${report.summary?.full} partial=${report.summary?.partial} none=${report.summary?.none} pass=${report.summary?.pass} warn=${report.summary?.warn} fail=${report.summary?.fail}`);
  check('自检没有 fail 项', (report.summary?.fail || 0) === 0, `fail=${report.summary?.fail}`);
} finally {
  /* ---------- 收尾：停环境 → 等内核真退出 → 删临时目录 ---------- */
  if (id) { try { await stopProfile(id); } catch (e) { console.log(`stop 失败：${e.message}`); } }
  if (pid) {
    try { killProcessTree(pid); } catch { /* 已退出 */ }
    // 关键：内核进程退出前 user-data-dir 还被占着，立刻 rmSync 会 EPERM。
    // 先等它真的没了，再删；等了也删不掉就明确报出来，不静默留下垃圾。
    const gone = await waitPidGone(pid);
    if (!gone) console.log(`注意：pid ${pid} 在 8s 内没有退出`);
  }
  if (id) { try { deleteProfiles([id]); } catch { /* ignore */ } }
  // 关键：我们自己的 SQLite 连接还开着 freepower.db，不关就删不掉整个数据目录
  // （Windows 上表现为 EPERM，很容易被误判成「内核没退干净」）。
  try { closeDb(); } catch { /* ignore */ }
  if (origin) await origin.close().catch(() => {});
  // Windows 上内核退出后句柄还会松一会儿（实测能到 1~2s，偶发更久），重试而不是当场放弃
  let cleaned = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    try { fs.rmSync(DATA, { recursive: true, force: true }); cleaned = true; break; } catch { await sleep(500); }
  }
  if (!cleaned) console.log(`临时目录没删净：${DATA}（不影响结论，可手工删）`);
  if (!cleaned && udd && fs.existsSync(path.join(udd, 'DevToolsActivePort'))) {
    console.log(`注意：${udd} 里还有 DevToolsActivePort，确认内核已退出`);
  }
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);