/**
 * P9-C 真机验证：MediaDevices 三条（检测方用自己的探针复跑当裁判，这条我们得自己也能复跑）
 *
 * 跑法：npm run test:media-devices   （约 25 秒；需真实 Chrome + 完整权限）
 *
 * 断言：
 *   1. 未授权时 label 全为空、deviceId 为空串（与原生一致，不再伪造设备名）
 *   2. 同 origin 刷新 deviceId 不变
 *   3. 授权后：label 来自命名池、同类内不重复（只改名字，不造设备）
 *   4. 跨 origin deviceId 不同（原生按 origin 加盐）
 *   5. 枚举里没有摄像头 → getUserMedia({video:true}) 也 NotFoundError（枚举与能力一致）
 *   6. 有麦克风 → audio 成功，track.label 等于枚举里对应设备的名字
 */
import { withProbe, makeChecker, finish } from './helpers/profile-probe.mjs';

const ENUM = `(async () => {
  const list = await navigator.mediaDevices.enumerateDevices();
  const dist = (k) => list.filter((d) => d.kind === k).length;
  return {
    injected: Boolean(window.__fpInstalled),
    counts: { audioinput: dist('audioinput'), videoinput: dist('videoinput'), audiooutput: dist('audiooutput') },
    list: list.map((d) => ({ kind: d.kind, deviceId: d.deviceId, groupId: d.groupId, label: d.label })),
  };
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

    /* ---------------- 授权后 ---------------- */
    for (const origin of [new URL(URL_A).origin, new URL(URL_B).origin]) await grant(origin);
    await nav(URL_A);
    const a3 = await evalIn(ENUM);
    const gum = await evalIn(GUM);
    await nav(URL_B);
    const b2 = await evalIn(ENUM);

    const labelsUsed = new Set((a3.list || []).map((d) => d.label));
    console.log(`\n授权后 A：${JSON.stringify(a3.counts)} · 名字 ${JSON.stringify([...labelsUsed])}`);
    console.log(`getUserMedia：${JSON.stringify(gum)}`);

    check('P9-C：授权后 label 全部来自命名池、同类内不重复',
      (a3.list || []).length > 0
        && (a3.list || []).every((d) => d.label && /^(?:\d+- )?(Microphone|Microphone Array|Line In|Speakers|Headphones|Digital Audio|HD WebCam|USB Video Device|Integrated Camera)/.test(d.label))
        && ['audioinput', 'audiooutput'].every((k) => {
          const ls = (a3.list || []).filter((d) => d.kind === k).map((d) => d.label);
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
  });
} catch (e) {
  console.log('异常：', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
  check('整体跑通（无异常）', false, String(e && e.message));
}
finish(results);
