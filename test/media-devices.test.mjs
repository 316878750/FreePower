/**
 * P9-C 真机验证：MediaDevices「真实枚举 + 只改 label」
 *
 * 跑法：npm run test:media-devices   （约 30 秒；需真实 Chrome + 完整权限）
 *
 * 断言：
 *   1. 未授权时 label 全为空、deviceId 为空串（与原生一致，不再伪造设备名）
 *   2. 同 origin 刷新 deviceId 不变；跨 origin 不同（内核按 origin 加盐）
 *   3. 只授权摄像头时，音频设备 label 仍为空（权限按 kind 判，Chrome 原生行为）
 *   4. 授权麦克风后：label 来自命名池、同类内不重复，deviceId / kind / 条数保持内核原值
 *   5. JSON.stringify(enumerateDevices()) 不抛，且序列化里的 label 与逐条 d.label 相等
 *   6. 枚举里没有摄像头 → getUserMedia({video:true}) 也 NotFoundError
 *   7. 有麦克风 → audio 成功，track.label 等于枚举里对应设备的名字
 */
import { withProbe, makeChecker, finish } from './helpers/profile-probe.mjs';

const ENUM = `(async () => {
  const list = await navigator.mediaDevices.enumerateDevices();
  const dist = (k) => list.filter((d) => d.kind === k).length;
  return {
    injected: Boolean(window.__fpApplied),
    counts: { audioinput: dist('audioinput'), videoinput: dist('videoinput'), audiooutput: dist('audiooutput') },
    list: list.map((d) => ({ kind: d.kind, deviceId: d.deviceId, groupId: d.groupId, label: d.label })),
  };
})()`;

const JSON_PROBE = `(async () => {
  const list = await navigator.mediaDevices.enumerateDevices();
  const out = { ok: true };
  try {
    const text = JSON.stringify(list);
    const parsed = JSON.parse(text);
    out.bytes = text.length;
    out.pairs = parsed.map((x, i) => ({ json: x.label, direct: list[i].label }));
    out.allEqual = out.pairs.every((p) => p.json === p.direct);
    out.hasHostName = /Realtek|NVIDIA|立体声|USB Audio/i.test(text) && !/Microphone|Speakers|Headphones|Digital Audio/.test(text);
    out.toJSON = typeof MediaDeviceInfo.prototype.toJSON;
    out.toJSONNative = /\\[native code\\]/.test(String(MediaDeviceInfo.prototype.toJSON));
    out.ownKeys = list.length ? Object.keys(list[0]).join(',') : '(no devices)';
    out.instanceOf = list.every((d) => d instanceof MediaDeviceInfo);
  } catch (e) {
    out.ok = false;
    out.error = String(e && e.name) + ': ' + String(e && e.message);
  }
  return out;
})()`;

const GUM = `(async () => {
  const out = {};
  for (const kind of ['video', 'audio']) {
    const p = navigator.mediaDevices.getUserMedia(kind === 'video' ? { video: true } : { audio: true });
    out[kind] = await Promise.race([
      p.then((s) => { const t = s.getTracks(); const labels = t.map((x) => x.label); t.forEach((x) => x.stop()); return { ok: true, labels }; })
        .catch((e) => ({ ok: false, name: e && e.name })),
      new Promise((res) => setTimeout(() => res({ ok: false, name: 'TIMEOUT' }), 6000)),
    ]);
  }
  return out;
})()`;

const { results, check } = makeChecker();
try {
  await withProbe(async ({ evalIn, nav, grant, URL_A, URL_B }) => {
    const ids = (x) => (x.list || []).map((d) => d.deviceId).join('|');
    const realIds = (x) => (x.list || [])
      .filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d) => d.deviceId).join('|');
    const labelsEmpty = (x) => (x.list || []).every((d) => d.label === '');
    const labelsOf = (x, kind) => (x.list || []).filter((d) => d.kind === kind).map((d) => d.label);

    /* ---------------- 未授权 ---------------- */
    await nav(URL_A);
    const a1 = await evalIn(ENUM);
    await nav(URL_A);
    const a2 = await evalIn(ENUM);
    await nav(URL_B);
    const b1 = await evalIn(ENUM);

    check('P9-C：注入确实生效', a1.injected === true, String(a1.injected));
    check('P9-C：未授权时 label 全为空（原生行为）', labelsEmpty(a1) && labelsEmpty(b1), JSON.stringify((a1.list || []).map((d) => d.label)));
    check('P9-C：同 origin 刷新 deviceId 不变', ids(a1) === ids(a2), `${ids(a1)} / ${ids(a2)}`);

    /* ---------------- 只授权摄像头 ---------------- */
    const originA = new URL(URL_A).origin;
    const originB = new URL(URL_B).origin;
    await grant(originA, ['videoCapture']);
    await nav(URL_A);
    const cam = await evalIn(ENUM);
    console.log(`\n只授权摄像头：${JSON.stringify(cam.counts)} · 音频 label ${JSON.stringify(labelsOf(cam, 'audioinput').concat(labelsOf(cam, 'audiooutput')))}`);
    check('P9-C：只授权摄像头时，音频设备的 label 仍为空（权限按 kind 判）',
      [...labelsOf(cam, 'audioinput'), ...labelsOf(cam, 'audiooutput')].every((l) => l === ''),
      JSON.stringify(cam.list.map((d) => `${d.kind}:${d.label}`)));

    /* ---------------- 摄像头 + 麦克风 ---------------- */
    await grant(originA, ['audioCapture']);
    await grant(originB, ['videoCapture', 'audioCapture']);
    await nav(URL_A);
    const a3 = await evalIn(ENUM);
    const json = await evalIn(JSON_PROBE);
    const gum = await evalIn(GUM);
    await nav(URL_B);
    const b2 = await evalIn(ENUM);

    const labelsUsed = new Set((a3.list || []).map((d) => d.label));
    console.log(`\n授权后 A：${JSON.stringify(a3.counts)} · 名字 ${JSON.stringify([...labelsUsed])}`);
    console.log(`JSON：${JSON.stringify(json)}`);
    console.log(`getUserMedia：${JSON.stringify(gum)}`);

    check('P9-C：授权后 label 全部来自命名池、同类内不重复',
      (a3.list || []).length > 0
        && (a3.list || []).every((d) => d.label && /^(?:\d+- )?(Microphone|Microphone Array|Line In|Speakers|Headphones|Digital Audio|HD WebCam|USB Video Device|Integrated Camera)/.test(d.label))
        && ['audioinput', 'audiooutput'].every((k) => {
          const ls = labelsOf(a3, k);
          return new Set(ls).size === ls.length;
        }),
      JSON.stringify((a3.list || []).map((d) => d.label)));
    check('P9-C：授权后跨 origin deviceId 不同（内核按 origin 加盐）',
      realIds(a3) !== '' && realIds(a3) !== realIds(b2), `A ${realIds(a3).length} / B ${realIds(b2).length}`);
    check('P9-C：枚举里没有摄像头时 getUserMedia(video) 也报 NotFoundError',
      a3.counts.videoinput === 0 ? gum.video?.ok === false && gum.video?.name === 'NotFoundError' : gum.video?.ok === true,
      JSON.stringify(gum.video));
    check('P9-C：麦克风枚举与 getUserMedia 一致', a3.counts.audioinput === 0 ? gum.audio?.ok === false : gum.audio?.ok === true, JSON.stringify(gum.audio));
    check('P9-C：track.label 等于枚举里对应设备的名字',
      !gum.audio?.labels?.length || gum.audio.labels.every((l) => labelsUsed.has(l)),
      JSON.stringify(gum.audio?.labels));

    /* ---------------- 缺陷 1：JSON.stringify ---------------- */
    check('P9-C：JSON.stringify(设备列表) 不抛（原生 toJSON 不再 Illegal invocation）', json.ok === true, JSON.stringify(json.error || ''));
    check('P9-C：序列化结果里的 label 与逐条 d.label 相等（toJSON 没泄露宿主真名）',
      json.allEqual === true && json.hasHostName === false,
      JSON.stringify((json.pairs || []).slice(0, 3)));
    check('P9-C：toJSON 仍是函数且看起来原生', json.toJSON === 'function' && json.toJSONNative === true, `ownKeys=${json.ownKeys} instanceOf=${json.instanceOf}`);
  });
} catch (e) {
  console.log('异常：', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
  check('整体跑通（无异常）', false, String(e && e.message));
}
finish(results);
