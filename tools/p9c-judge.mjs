#!/usr/bin/env node
/**
 * p9c-judge.mjs — P9-C（媒体设备）复验的独立裁判，检测方视角。
 *
 * SOURCE: adspower-reverse/tools/probes/fp-p9c-judge.mjs
 * 拷贝日: 2026-11-11
 * 上游 sha256: 8503ed42b40f781c622b3138de12f2a183aefcf225f0b717bab090747b2eb57a
 * 本仓库相对上游只改了 2 行路径常量（第 29、30 行：仓库根默认指向本仓库、证据落 .tmp/p9c-judge/）；
 * 其余逐字一致。裁判以逆向仓库那份为准，他改判据时同步覆盖本文件。
 * 不放进默认 `npm test`：它现在恒红（M7/M8/L1），混进默认套件会让人习惯性忽略红色。
 *
 * 与 FreePower 自己的 test/media-devices.test.mjs 的区别：
 *   1. 断言是我写的，不从它的测试里抄判据；
 *   2. A/B 对照：同一套探针跑 media_devices=1（注入）与 media_devices=0（宿主真实基线），
 *      只承认两者不同的结论 —— 单跑注入环境，「label 来自命名池」与「根本没改名」无法区分；
 *   3. 加了它没测的可检测残留：getOwnPropertyNames / structuredClone / 原型指针 /
 *      Function.prototype.toString / 撤销授权后是否还原；
 *   4. 加了它没测的 CDP 直建页面导航类型（performance navigation type 是否留下 reload 痕迹）。
 *
 * 用法：
 *   npm run test:p9c-judge               跑两套环境并给结论
 *   node tools/p9c-judge.mjs --only=1    只跑注入环境（调试用）
 *   node tools/p9c-judge.mjs --keep      保留环境目录（排查用）
 *
 * 退出码：0 = 判据全过；1 = 有判据失败；2 = 环境错误。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FP_REPO = process.env.FP_P9C_REPO || path.resolve(HERE, '..');
const OUT_DIR = process.env.FP_P9C_OUT || path.join(HERE, '..', '.tmp', 'p9c-judge');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简 CDP 客户端：Node 24 内置 WebSocket，自己管 id/sessionId。 */
class MiniCdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.closed = false;
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message + (msg.error.data ? ' / ' + msg.error.data : '')));
        else resolve(msg.result);
      }
    });
    ws.addEventListener('close', () => { this.closed = true; for (const { reject } of this.pending.values()) reject(new Error('CDP closed')); this.pending.clear(); });
    ws.addEventListener('error', () => { this.closed = true; });
  }

  static connect(wsUrl, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const t = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error('CDP connect timeout')); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(new MiniCdp(ws)); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('CDP connect error')); }, { once: true });
    });
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP closed'));
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 20000).unref?.();
      try { this.ws.send(JSON.stringify(payload)); } catch (e) { this.pending.delete(id); reject(e); }
    });
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/* ================================================================== *
 * 子进程：起一套环境，采原始观测，写 JSON。不做判定（判定交给父进程）。
 * ================================================================== */

const PAGE = {
  snapshot: `(async () => {
    const list = await navigator.mediaDevices.enumerateDevices();
    const snapOne = (d) => {
      if (!d) return null;
      const desc = (() => {
        try { const x = Object.getOwnPropertyDescriptor(d, 'label'); return x
          ? { enumerable: x.enumerable, configurable: x.configurable, writable: x.writable, hasValue: 'value' in x }
          : null; } catch (e) { return 'THROW:' + e.name; }
      })();
      return {
        kind: d.kind, label: d.label, deviceId: d.deviceId, groupId: d.groupId,
        own_keys: Object.keys(d),
        own_names: Object.getOwnPropertyNames(d),
        own_label_desc: desc,
        has_own_label: Object.prototype.hasOwnProperty.call(d, 'label'),
        spread_keys: Object.keys(Object.assign({}, d)),
        instanceof_mdi: typeof MediaDeviceInfo === 'undefined' ? null : d instanceof MediaDeviceInfo,
        proto_is_mdi_proto: typeof MediaDeviceInfo === 'undefined' ? null : Object.getPrototypeOf(d) === MediaDeviceInfo.prototype,
        json_one: (() => { try { return JSON.stringify(d); } catch (e) { return 'THROW:' + e.name + ':' + e.message; } })(),
        clone: (() => { try { structuredClone(d); return 'ok'; } catch (e) { return 'THROW:' + e.name; } })(),
      };
    };
    const counts = {};
    for (const d of list) counts[d.kind] = (counts[d.kind] || 0) + 1;
    const jsonAll = (() => {
      try { const s = JSON.stringify(list); const p = JSON.parse(s); return { ok: true, bytes: s.length, labels: p.map((x) => x && x.label) }; }
      catch (e) { return { ok: false, err: e.name + ': ' + e.message }; }
    })();
    const enumDesc = (() => {
      try { const x = Object.getOwnPropertyDescriptor(MediaDevices.prototype, 'enumerateDevices');
        return { enumerable: x.enumerable, writable: x.writable, configurable: x.configurable, src: Function.prototype.toString.call(x.value) };
      } catch (e) { return 'THROW:' + e.name; }
    })();
    const leak = [];
    const probeFn = (name, get) => {
      try {
        const fn = get();
        if (typeof fn !== 'function') { leak.push({ name, fn: typeof fn }); return; }
        const s = Function.prototype.toString.call(fn);
        leak.push({
          name,
          native: /\\[native code\\]/.test(s),
          len: s.length,
          head: s.replace(/\\s+/g, ' ').slice(0, 48),
          own_tostring: (() => { try { return Object.prototype.hasOwnProperty.call(fn, 'toString'); } catch (e) { return null; } })(),
          lookalike: (() => { try { return String(fn).slice(0, 40); } catch (e) { return null; } })(),
        });
      } catch (e) { leak.push({ name, error: e.name }); }
    };
    const descOf = (proto, key) => { try { const d = Object.getOwnPropertyDescriptor(proto, key); return d && (d.value || d.get); } catch (e) { return undefined; } };
    probeFn('MediaDevices.enumerateDevices', () => MediaDevices.prototype.enumerateDevices);
    probeFn('MediaDeviceInfo.toJSON', () => MediaDeviceInfo.prototype.toJSON);
    probeFn('Navigator.hardwareConcurrency', () => descOf(Navigator.prototype, 'hardwareConcurrency'));
    probeFn('Navigator.deviceMemory', () => descOf(Navigator.prototype, 'deviceMemory'));
    probeFn('Navigator.platform', () => descOf(Navigator.prototype, 'platform'));
    probeFn('Navigator.languages', () => descOf(Navigator.prototype, 'languages'));
    probeFn('Navigator.userAgent', () => descOf(Navigator.prototype, 'userAgent'));
    probeFn('Navigator.plugins', () => descOf(Navigator.prototype, 'plugins'));
    probeFn('Screen.width', () => descOf(Screen.prototype, 'width'));
    probeFn('Screen.colorDepth', () => descOf(Screen.prototype, 'colorDepth'));
    probeFn('HTMLCanvasElement.toDataURL', () => HTMLCanvasElement.prototype.toDataURL);
    probeFn('Canvas2D.getImageData', () => CanvasRenderingContext2D.prototype.getImageData);
    probeFn('Element.getBoundingClientRect', () => Element.prototype.getBoundingClientRect);
    probeFn('WebGL.getParameter', () => window.WebGLRenderingContext && WebGLRenderingContext.prototype.getParameter);
    probeFn('AudioBuffer.getChannelData', () => window.AudioBuffer && AudioBuffer.prototype.getChannelData);
    probeFn('SpeechSynthesis.getVoices', () => window.SpeechSynthesis && SpeechSynthesis.prototype.getVoices);
    probeFn('Intl.DateTimeFormat.resolvedOptions', () => Intl.DateTimeFormat.prototype.resolvedOptions);
    const gum = (constraints) => Promise.race([
      navigator.mediaDevices.getUserMedia(constraints)
        .then((s) => ({ ok: true, labels: s.getTracks().map((t) => t.label), kinds: s.getTracks().map((t) => t.kind) }))
        .catch((e) => ({ ok: false, name: e.name })),
      new Promise((r) => setTimeout(() => r({ ok: false, name: 'PROBE_TIMEOUT' }), 6000)),
    ]);
    return {
      origin: location.origin,
      counts,
      devices: list.map((d) => snapOne(d)),
      json_all: jsonAll,
      toJSON: (() => {
        try { return { type: typeof MediaDeviceInfo.prototype.toJSON, src: Function.prototype.toString.call(MediaDeviceInfo.prototype.toJSON) }; }
        catch (e) { return { err: String(e) }; }
      })(),
      enumerate_devices_desc: enumDesc,
      leak,
      gum_audio: await gum({ audio: true }),
      gum_video: await gum({ video: true }),
    };
  })()`,
};

async function childMain(mode, outFile, keep) {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-p9c-' + mode + '-'));
  const obs = { mode, data_dir: DATA, started_at: new Date().toISOString(), steps: {}, errors: [] };
  process.env.FREEPOWER_DATA = DATA;
  process.env.FREEPOWER_SELFCHECK = '0';
  process.env.FREEPOWER_EGRESS_PROBE = 'http://127.0.0.1:1/never';
  process.env.FREEPOWER_EGRESS_TIMEOUT = '800';

  const html = '<!doctype html><meta charset="utf-8"><title>judge</title><body>judge</body>';
  const srvA = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  });
  await new Promise((r) => srvA.listen(0, '127.0.0.1', r));
  const srvB = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  });
  await new Promise((r) => srvB.listen(0, '127.0.0.1', r));
  const ORIGIN_A = 'http://127.0.0.1:' + srvA.address().port;
  const ORIGIN_B = 'http://127.0.0.1:' + srvB.address().port;
  obs.origins = { a: ORIGIN_A, b: ORIGIN_B };

  const manager = await import(pathToFileURL(path.join(FP_REPO, 'src/runtime/manager.js')).href);
  const profiles = await import(pathToFileURL(path.join(FP_REPO, 'src/store/profiles.js')).href);
  const { fingerprintView } = await import(pathToFileURL(path.join(FP_REPO, 'src/fingerprint/view.js')).href);

  let profileId = null;
  let cdp = null;
  try {
    const created = profiles.createProfile({
      name: 'judge-md' + mode + '-' + Date.now(),
      group_id: '0',
      remark: 'P9-C judge',
      media_devices: mode,
      media_devices_num: { audioinput_num: 2, videoinput_num: 1, audiooutput_num: 2 },
      hardware_concurrency: 6,
      language: ['en-US'],
    });
    profileId = created.profile_id;
    const started = await manager.startProfile(profiles.getProfile(profileId));
    const inst = manager.getInstance(profileId);
    obs.env = { profile_id: profileId, real_version: started.real_version, ws: String(inst.wsUrl || '').replace(/\/devtools\/browser\/.*/, '/devtools/browser/***') };
    const view = fingerprintView(profiles.getProfile(profileId));
    obs.config = { media: view.media, hardware_concurrency: view.hardware_concurrency, language: view.language };

    cdp = await MiniCdp.connect(inst.wsUrl, { timeoutMs: 15000 });
    const sendB = (m, p = {}) => cdp.send(m, p);

    const created2 = await sendB('Target.createTarget', { url: 'about:blank' });
    const att = await sendB('Target.attachToTarget', { targetId: created2.targetId, flatten: true });
    const sessionId = att.sessionId;
    const send = (m, p = {}) => cdp.send(m, p, sessionId);
    await send('Page.enable');
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r && r.exceptionDetails) return { __exception: r.exceptionDetails.text || String(r.exceptionDetails) };
      return r && r.result ? r.result.value : null;
    };
    const nav = async (url) => { await send('Page.navigate', { url }); await sleep(1500); };
    const grant = async (origin, permissions) => {
      await sendB('Browser.grantPermissions', { origin, permissions }).catch((e) => obs.errors.push('grant:' + e.message));
      await sleep(150);
    };
    const resetPerms = async () => {
      await sendB('Browser.resetPermissions', {}).catch((e) => obs.errors.push('reset:' + e.message));
      await sleep(150);
    };

    /* 1. 未授权 */
    await nav(ORIGIN_A + '/a');
    obs.steps.unauth = await evaluate(PAGE.snapshot);

    /* 2. 只授权摄像头（缺陷 2 回归点：音频不该跟着改名） */
    await grant(ORIGIN_A, ['videoCapture']);
    obs.steps.camera_only = await evaluate(PAGE.snapshot);

    /* 3. 再授权麦克风 */
    await grant(ORIGIN_A, ['videoCapture', 'audioCapture']);
    obs.steps.mic = await evaluate(PAGE.snapshot);

    /* 4. 撤销授权 + 重载 */
    await resetPerms();
    await nav(ORIGIN_A + '/a');
    obs.steps.revoked = await evaluate(PAGE.snapshot);

    /* 5. 同 origin 重载后 deviceId 稳定 */
    const idsOf = (step) => ((step && step.devices) || []).filter((d) => d.label && d.deviceId && d.deviceId.length >= 16).map((d) => d.deviceId);
    const idsBefore = idsOf(obs.steps.mic);
    await grant(ORIGIN_A, ['videoCapture', 'audioCapture']);
    await nav(ORIGIN_A + '/a');
    obs.steps.reload = await evaluate(PAGE.snapshot);
    const idsAfter = idsOf(obs.steps.reload);
    obs.device_id_stable_same_origin = { before: idsBefore, after: idsAfter, same: JSON.stringify(idsBefore) === JSON.stringify(idsAfter) };

    /* 6. 另一个 origin */
    await grant(ORIGIN_B, ['videoCapture', 'audioCapture']);
    await nav(ORIGIN_B + '/b');
    obs.steps.origin_b = await evaluate(PAGE.snapshot);

    /* 7. CDP 直建带 URL 的页面 */
    const t2 = await sendB('Target.createTarget', { url: ORIGIN_A + '/cdp-created' });
    const att2 = await sendB('Target.attachToTarget', { targetId: t2.targetId, flatten: true });
    const send2 = (m, p = {}) => cdp.send(m, p, att2.sessionId);
    await send2('Page.enable').catch(() => {});
    let cdpSeen = null;
    for (let i = 0; i < 60; i++) {
      const r = await send2('Runtime.evaluate', {
        expression: "(() => { const n = performance.getEntriesByType('navigation')[0] || {}; return JSON.stringify({ applied: typeof window.__fpApplied, ready: document.readyState, hc: navigator.hardwareConcurrency, lang: navigator.language, nav_type: n.type || null, href: location.href }); })()",
        returnByValue: true,
      }).catch(() => null);
      const v = r && r.result ? r.result.value : null;
      if (v) { try { cdpSeen = JSON.parse(v); } catch { cdpSeen = { raw: v }; } }
      if (cdpSeen && cdpSeen.applied === 'object' && cdpSeen.ready === 'complete') break;
      await sleep(200);
    }
    obs.steps.cdp_created = cdpSeen;
    await sendB('Target.closeTarget', { targetId: t2.targetId }).catch(() => {});
  } catch (e) {
    obs.errors.push('fatal: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)));
  } finally {
    const withTimeout = (p, ms = 4000) => Promise.race([Promise.resolve(p).catch(() => {}), sleep(ms)]);
    try { if (cdp) cdp.close(); } catch { /* ignore */ }
    try { if (profileId) await withTimeout(manager.stopProfile(profileId)); } catch { /* ignore */ }
    try { if (profileId) profiles.deleteProfiles([profileId]); } catch { /* ignore */ }
    try { srvA.closeAllConnections?.(); srvA.close(); } catch { /* ignore */ }
    try { srvB.closeAllConnections?.(); srvB.close(); } catch { /* ignore */ }
    obs.finished_at = new Date().toISOString();
    fs.writeFileSync(outFile, JSON.stringify(obs, null, 2));
    if (!keep) { try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ } }
    process.exit(obs.errors.length ? 2 : 0);
  }
}

/* ================================================================== *
 * 父进程：跑两个模式，做判定
 * ================================================================== */

const CRITICAL = [];
const INFO = [];
const check = (id, name, ok, detail, kind = 'critical') => {
  const row = { id, name, ok, detail };
  if (kind === 'critical') CRITICAL.push(row); else INFO.push(row);
  console.log((ok ? 'PASS' : 'FAIL') + '  [' + id + '] ' + name + (detail ? '  — ' + detail : ''));
};

const labelsOf = (step, kind) => ((step && step.devices) || []).filter((d) => !kind || d.kind === kind).map((d) => d.label);
const uniq = (a) => [...new Set(a)];

async function parentMain() {
  fs.mkdirSync(OUT_DIR, { recursive: true }); // 本仓库版证据落 .tmp/p9c-judge/，目录可能不存在
  const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
  const keep = process.argv.includes('--keep');
  const modes = only ? [only] : ['1', '0'];
  const raws = {};
  for (const mode of modes) {
    const outFile = path.join(OUT_DIR, 'p9c-judge-media' + mode + (only ? '-only' : '') + '.json');
    console.log('\n=== 起环境 media_devices=' + mode + ' ===');
    const code = await new Promise((resolve) => {
      const p = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', mode, outFile, ...(keep ? ['--keep'] : [])], { stdio: 'inherit' });
      p.on('exit', resolve);
    });
    if (!fs.existsSync(outFile)) { console.error('环境 media_devices=' + mode + ' 没产出观测（exit=' + code + '）'); process.exit(2); }
    raws[mode] = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    console.log('观测已写：' + outFile + '（exit=' + code + (code === 2 ? '，含错误' : '') + '）');
    if (code === 2) console.log('错误：' + (raws[mode].errors || []).join(' | '));
  }

  const inj = raws['1'];
  const base = raws['0'];
  if (!inj) { console.error('缺少 media_devices=1 的观测'); process.exit(2); }
  if (!only && !base) { console.error('缺少 media_devices=0 的观测'); process.exit(2); }
  const gInj = inj.steps;
  const gBase = base && base.steps;

  check('S0', '环境起得来且配置读到了', !!inj.config, 'media=' + JSON.stringify(inj.config && inj.config.media) + ' origin=' + (gInj.unauth && gInj.unauth.origin));
  const unauthLabels = labelsOf(gInj.unauth);
  check('M1', '未授权：所有 label 为空（原生行为）', unauthLabels.every((l) => l === ''), JSON.stringify(uniq(unauthLabels)));

  const camAudio = labelsOf(gInj.camera_only, 'audioinput').concat(labelsOf(gInj.camera_only, 'audiooutput'));
  check('M2', '只授权摄像头：音频 label 仍为空（权限按 kind 判）', camAudio.every((l) => l === ''), JSON.stringify(uniq(camAudio)));
  if (gBase) {
    const baseCamAudio = labelsOf(gBase.camera_only, 'audioinput').concat(labelsOf(gBase.camera_only, 'audiooutput'));
    check('M2b', '（A/B）宿主真实基线在只授权摄像头时音频 label 也为空', baseCamAudio.every((l) => l === ''), '基线 ' + JSON.stringify(uniq(baseCamAudio)));
  }

  const injAudio = labelsOf(gInj.mic, 'audioinput');
  const nonEmpty = injAudio.filter(Boolean);
  check('M3', '授权麦克风后 audioinput label 非空', nonEmpty.length > 0, JSON.stringify(injAudio));
  check('M3b', '同类内 label 不重复', uniq(injAudio).length === injAudio.length, JSON.stringify(injAudio));
  if (gBase) {
    const baseAudio = labelsOf(gBase.mic, 'audioinput');
    const leakedNames = nonEmpty.filter((l) => baseAudio.includes(l));
    check('M4', '（A/B）注入环境的设备名与宿主真名不同（证明是改名而非无操作）', nonEmpty.length > 0 && leakedNames.length === 0, '注入 ' + JSON.stringify(injAudio) + ' / 基线 ' + JSON.stringify(baseAudio));
    check('M4b', '（A/B）注入环境里没有出现宿主真实设备名', leakedNames.length === 0, '交集 ' + JSON.stringify(leakedNames));
  }

  const ja = gInj.mic && gInj.mic.json_all;
  check('M5', 'JSON.stringify(设备列表) 不抛 TypeError', !!(ja && ja.ok), ja ? (ja.ok ? 'bytes=' + ja.bytes : ja.err) : '未采到');
  const direct = labelsOf(gInj.mic, 'audioinput');
  const viaJson = (ja && ja.ok ? ja.labels : []).filter((x) => x && x !== undefined);
  check('M6', '序列化出的 label 与逐条 d.label 一致（toJSON 没绕过改名）', !!ja && ja.ok && viaJson.slice(0, direct.length).join('|') === direct.join('|'), 'json=' + JSON.stringify(viaJson) + ' direct=' + JSON.stringify(direct));
  const tj = gInj.mic && gInj.mic.toJSON;
  check('M7', 'MediaDeviceInfo.prototype.toJSON 仍是 [native code]（Function.prototype.toString.call）', !!tj && tj.type === 'function' && /\[native code\]/.test(String(tj.src)), tj ? String(tj.src).replace(/\s+/g, ' ').slice(0, 80) : '未采到');
  if (gBase && gBase.mic && gBase.mic.toJSON) {
    console.log('      · 基线 toJSON：' + String(gBase.mic.toJSON.src).replace(/\s+/g, ' ').slice(0, 60));
  }

  const ed = gInj.mic && gInj.mic.enumerate_devices_desc;
  check('M8', 'MediaDevices.prototype.enumerateDevices 仍是 [native code]', !!ed && /\[native code\]/.test(String(ed.src)), ed ? String(ed.src).replace(/\s+/g, ' ').slice(0, 80) : '未采到');
  if (gBase && gBase.mic && gBase.mic.enumerate_devices_desc) {
    const bed = gBase.mic.enumerate_devices_desc;
    check('M8b', '（A/B）enumerateDevices 的属性标志与宿主一致', ed && ed.enumerable === bed.enumerable && ed.writable === bed.writable && ed.configurable === bed.configurable, '注入 ' + JSON.stringify({ e: ed && ed.enumerable, w: ed && ed.writable, c: ed && ed.configurable }) + ' / 基线 ' + JSON.stringify({ e: bed.enumerable, w: bed.writable, c: bed.configurable }));
  }

  const first = (gInj.mic && gInj.mic.devices && gInj.mic.devices.find((d) => d.label)) || null;
  const baseFirst = (gBase && gBase.mic && (gBase.mic.devices || [])[0]) || null;
  check('M9', '设备对象仍是 MediaDeviceInfo 实例', !!first && first.instanceof_mdi === true, first ? 'instanceof=' + first.instanceof_mdi : '未采到');
  check('M9b', '（A/B）原型指针与宿主基线一致', !!first && !!baseFirst && first.proto_is_mdi_proto === baseFirst.proto_is_mdi_proto, '注入 ' + (first && first.proto_is_mdi_proto) + ' / 基线 ' + (baseFirst && baseFirst.proto_is_mdi_proto));

  if (first) {
    check('R1', '（残留）Object.getOwnPropertyNames 能看到我们挂的 label', Array.isArray(first.own_names) && first.own_names.includes('label'), 'own_names=' + JSON.stringify(first.own_names) + ' desc=' + JSON.stringify(first.own_label_desc), 'info');
    check('R2', '（残留）Object.keys / 展开运算符仍与原生一致', Array.isArray(first.own_keys) && first.own_keys.length === 0 && Array.isArray(first.spread_keys) && first.spread_keys.length === 0, 'own_keys=' + JSON.stringify(first.own_keys) + ' spread=' + JSON.stringify(first.spread_keys), 'info');
    check('R3', '（残留）structuredClone 行为与宿主一致', !!baseFirst && baseFirst.clone === first.clone, '注入 ' + first.clone + ' / 基线 ' + (baseFirst && baseFirst.clone), 'info');
  }

  const realIds = (step) => ((step && step.devices) || []).filter((d) => d.label && d.deviceId && d.deviceId.length >= 16 && d.deviceId !== 'default');
  const aIds = realIds(gInj.mic);
  const bIds = realIds(gInj.origin_b);
  const common = aIds.filter((d) => bIds.some((x) => x.deviceId === d.deviceId));
  check('M10', '同一设备在两个 origin 下 deviceId 不同（内核加盐，不是 JS 伪造）', aIds.length > 0 && bIds.length > 0 && common.length === 0, 'A=' + aIds.length + ' B=' + bIds.length + ' 共同=' + common.length);
  check('M11', '同 origin 重载后 deviceId 稳定', !!inj.device_id_stable_same_origin && inj.device_id_stable_same_origin.same && aIds.length > 0, 'n=' + aIds.length + ' same=' + (inj.device_id_stable_same_origin && inj.device_id_stable_same_origin.same));

  const gu = gInj.mic && gInj.mic.gum_audio;
  check('M12', 'getUserMedia(audio) 的 track.label 等于枚举里的名字', !!gu && gu.ok && gu.labels.length > 0 && direct.includes(gu.labels[0]), gu ? JSON.stringify(gu) : '未采到', 'info');
  check('M13', '枚举里没有摄像头时 getUserMedia(video) 报 NotFoundError', !!(gInj.mic && gInj.mic.gum_video) && gInj.mic.gum_video.ok === false && /NotFound/.test(String(gInj.mic.gum_video.name)), JSON.stringify(gInj.mic && gInj.mic.gum_video), 'info');

  const revoked = labelsOf(gInj.revoked);
  check('M14', '撤销授权并重载后 label 回到空（打过补丁的对象会还原）', revoked.every((l) => l === ''), JSON.stringify(uniq(revoked)), 'info');

  const leakRows = (gInj.mic && gInj.mic.leak) || [];
  const leaked = leakRows.filter((x) => x.native === false);
  check('L1', '注入替换过的函数不泄漏源码（Function.prototype.toString.call 仍是 [native code]）', leakRows.length > 0 && leaked.length === 0, leakRows.length ? '扫描 ' + leakRows.length + ' 个，泄漏 ' + leaked.length + ' 个：' + (leaked.map((x) => x.name).join(', ') || '无') : '未采到');
  for (const x of leaked) console.log('        - ' + x.name + ' → ' + x.head + '...  (ownToString=' + x.own_tostring + ', String(fn)=' + x.lookalike + ')');

  const cd = gInj.cdp_created;
  const wantHc = inj.config && inj.config.hardware_concurrency;
  const wantLang = String((inj.config && inj.config.language && inj.config.language[0]) || '').toLowerCase();
  check('C1', 'CDP 直建带 URL 的页面：注入生效', !!cd && cd.applied === 'object', JSON.stringify(cd));
  check('C2', 'CDP 直建页面：hardwareConcurrency 是配置值', !!cd && String(cd.hc) === String(wantHc), '实测 ' + (cd && cd.hc) + ' / 配置 ' + wantHc);
  check('C3', 'CDP 直建页面：navigator.language 是配置值', !!cd && String(cd.lang).toLowerCase() === wantLang, '实测 ' + (cd && cd.lang) + ' / 配置 ' + wantLang);
  check('C4', '（残留）CDP 直建页面是否留下 navigation type=reload', !!cd && cd.nav_type === 'reload', 'nav_type=' + (cd && cd.nav_type), 'info');

  const fails = CRITICAL.filter((r) => !r.ok);
  const infoFails = INFO.filter((r) => !r.ok);
  console.log('\n判据：' + (CRITICAL.length - fails.length) + '/' + CRITICAL.length + ' 过');
  if (infoFails.length) console.log('附加观察未命中 ' + infoFails.length + ' 条（不当失败）：' + infoFails.map((r) => r.id).join(','));
  const summary = {
    judge: 'fp-p9c-judge.mjs',
    ran_at: new Date().toISOString(),
    fp_repo: FP_REPO,
    fp_head: (() => { try { return fs.readFileSync(path.join(FP_REPO, '.git', 'HEAD'), 'utf8').trim(); } catch { return null; } })(),
    critical: CRITICAL,
    info: INFO,
    verdict: fails.length ? 'FAIL' : 'PASS',
  };
  fs.writeFileSync(path.join(OUT_DIR, 'p9c-judge-summary.json'), JSON.stringify(summary, null, 2));
  console.log('结论：' + summary.verdict + '  ·  证据 ' + path.join(OUT_DIR, 'p9c-judge-summary.json'));
  process.exit(fails.length ? 1 : 0);
}

const argv = process.argv.slice(2);
if (argv[0] === '--child') {
  childMain(argv[1], argv[2], argv.includes('--keep')).catch((e) => { console.error('child fatal', e); process.exit(2); });
} else {
  parentMain().catch((e) => { console.error('fatal', e); process.exit(2); });
}
