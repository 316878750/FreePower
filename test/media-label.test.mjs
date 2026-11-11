/**
 * 真机验证（P14 的门）：MediaDeviceInfo 的 label 投影不能再留 own property
 *
 * 背景：改了 label 的真实设备对象上，我们原来用 `Object.defineProperty(d,'label',…)`，
 * 于是实例多出一个 own property；原生设备对象上**一个 own 属性都没有**
 * （本机 media_devices=0 基线实测：8 个实例的 Object.getOwnPropertyNames 全是 []）。
 * 逆向裁判 R1 就是一行 `Object.getOwnPropertyNames(device)` 读出来的。
 *
 * 这里判两面（缺一不可）：
 *   消掉：授权后 `Object.getOwnPropertyNames(d)` / `hasOwnProperty` / `Object.keys` / 展开 /
 *         `Reflect.ownKeys` 都不出现 label，且 `MediaDeviceInfo.prototype.label` 的描述符与原生 getter 同形；
 *   没改坏：label 仍是改过的名字（在命名池内、同类不重复）、toJSON / JSON.stringify 一致、
 *           structuredClone 与原生同样抛 DataCloneError、未授权 label 空、只授权摄像头时音频仍空、
 *           撤销授权后回到空。
 *
 * 跑法：node --no-warnings test/media-label.test.mjs
 */
import { withProbe, makeChecker, finish } from './helpers/profile-probe.mjs';

const PROBE = `(async () => {
  const list = await navigator.mediaDevices.enumerateDevices();
  const pool = /^(?:\\d+- )?(Microphone|Microphone Array|Line In|Speakers|Headphones|Digital Audio|HD WebCam|USB Video Device|Integrated Camera)/;
  const proto = MediaDeviceInfo.prototype;
  const pd = (() => { try { return Object.getOwnPropertyDescriptor(proto, 'label'); } catch (e) { return null; } })();
  // 同 realm 的原生 getter 当对照，别把「我们自己写的期望值」抄成判据
  const nativeGetter = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform').get;
  return {
    injected: typeof window.__fpApplied,
    counts: list.reduce((a, d) => { a[d.kind] = (a[d.kind] || 0) + 1; return a; }, {}),
    devices: list.map((d) => ({
      kind: d.kind,
      label: d.label,
      labelInPool: pool.test(d.label || ''),
      protoIsMdi: Object.getPrototypeOf(d) === proto,
      ctorName: (() => { try { return Object.getPrototypeOf(d).constructor.name; } catch (e) { return 'THROW'; } })(),
      instanceofMdi: d instanceof MediaDeviceInfo,
      ownNames: Object.getOwnPropertyNames(d),
      hasOwnLabel: Object.prototype.hasOwnProperty.call(d, 'label'),
      ownKeys: Object.keys(d),
      spreadKeys: Object.keys(Object.assign({}, d)),
      reflectKeys: Reflect.ownKeys(d),
      jsonLabel: (() => { try { return JSON.parse(JSON.stringify(d)).label; } catch (e) { return 'THROW:' + e.name; } })(),
      clone: (() => { try { structuredClone(d); return 'ok'; } catch (e) { return 'THROW:' + e.name; } })(),
    })),
    jsonAll: (() => {
      try { const p = JSON.parse(JSON.stringify(list)); return { ok: true, labels: p.map((x) => x && x.label) }; }
      catch (e) { return { ok: false, err: e.name + ':' + e.message }; }
    })(),
    protoDesc: pd ? {
      enumerable: pd.enumerable, configurable: pd.configurable,
      hasGet: typeof pd.get === 'function', hasSet: typeof pd.set === 'function', hasValue: 'value' in pd,
      getNative: typeof pd.get === 'function' ? /\\[native code\\]/.test(Function.prototype.toString.call(pd.get)) : null,
      getName: typeof pd.get === 'function' ? pd.get.name : null,
      getLength: typeof pd.get === 'function' ? pd.get.length : null,
      getOwn: typeof pd.get === 'function' ? Object.getOwnPropertyNames(pd.get).sort() : null,
      nativeGetterOwn: Object.getOwnPropertyNames(nativeGetter).sort(),
      nativeGetterNative: /\\[native code\\]/.test(Function.prototype.toString.call(nativeGetter)),
    } : null,
  };
})()`;

const { results, check } = makeChecker();
const labelsOf = (x, kind) => (x.devices || []).filter((d) => !kind || d.kind === kind).map((d) => d.label);
const noOwnLabel = (x) => (x.devices || []).every((d) => !d.hasOwnLabel
  && !d.ownNames.includes('label') && d.ownKeys.length === 0
  && d.spreadKeys.length === 0 && d.reflectKeys.length === 0);

try {
  await withProbe(async ({ evalIn, nav, grant, client, URL_A }) => {
    const originA = new URL(URL_A).origin;

    /* ---------------- 未授权 ---------------- */
    await nav(URL_A);
    const unauth = await evalIn(PROBE);
    console.log(`\n未授权：${JSON.stringify(unauth.counts)} · 原型描述符 ${JSON.stringify(unauth.protoDesc)}`);
    check('P14：注入生效', unauth.injected === 'object', String(unauth.injected));
    check('P14：未授权时 label 全为空', labelsOf(unauth).every((l) => l === ''), JSON.stringify(labelsOf(unauth)));
    check('P14：未授权时也没有 own property（原生形状）', noOwnLabel(unauth),
      JSON.stringify((unauth.devices || []).map((d) => d.ownNames)));

    /* ---------------- 只授权摄像头：音频不许跟着改名 ---------------- */
    await grant(originA, ['videoCapture']);
    await nav(URL_A);
    const cam = await evalIn(PROBE);
    const camAudio = [...labelsOf(cam, 'audioinput'), ...labelsOf(cam, 'audiooutput')];
    console.log(`只授权摄像头：${JSON.stringify(cam.counts)} · 音频 label ${JSON.stringify(camAudio)}`);
    check('P14：只授权摄像头时音频 label 仍为空（权限按 kind 判）',
      camAudio.every((l) => l === ''), JSON.stringify(camAudio));

    /* ---------------- 摄像头 + 麦克风：核心断言 ---------------- */
    await grant(originA, ['videoCapture', 'audioCapture']);
    await nav(URL_A);
    const mic = await evalIn(PROBE);
    console.log(`\n授权后：${JSON.stringify(mic.counts)} · 名字 ${JSON.stringify((mic.devices || []).map((d) => d.label))}`);
    console.log(`own 形状：${JSON.stringify((mic.devices || []).map((d) => ({ ctor: d.ctorName, own: d.ownNames })))}`);
    console.log(`JSON 一致：${JSON.stringify(mic.jsonAll && mic.jsonAll.ok)}`);

    check('P14：授权后实例上没有任何 own 属性（R1 消掉）', noOwnLabel(mic),
      JSON.stringify((mic.devices || []).map((d) => ({ names: d.ownNames, hasOwn: d.hasOwnLabel }))));
    check('P14：授权后 label 仍是改过的名字（在命名池内）',
      labelsOf(mic, 'audioinput').length > 0 && labelsOf(mic, 'audioinput').every((l) => l && /^(?:\d+- )?(Microphone|Microphone Array|Line In)/.test(l)),
      JSON.stringify(labelsOf(mic, 'audioinput')));
    check('P14：同类内 label 不重复',
      ['audioinput', 'audiooutput'].every((k) => { const ls = labelsOf(mic, k); return new Set(ls).size === ls.length; }),
      JSON.stringify(mic.devices.map((d) => d.label)));
    check('P14：设备仍是 MediaDeviceInfo 实例',
      (mic.devices || []).every((d) => d.instanceofMdi === true), JSON.stringify((mic.devices || []).map((d) => d.instanceofMdi)));
    check('P14：子类（InputDeviceInfo）也走同一条原型链（音频输入设备）',
      (mic.devices || []).filter((d) => d.kind === 'audioinput').every((d) => d.ownNames.length === 0 && !!d.label),
      JSON.stringify((mic.devices || []).filter((d) => d.kind === 'audioinput').map((d) => ({ ctor: d.ctorName, protoIsMdi: d.protoIsMdi, own: d.ownNames }))));

    const pd = mic.protoDesc || {};
    console.log(`原型描述符：${JSON.stringify(pd)}`);
    check('P14：MediaDeviceInfo.prototype.label 仍是 accessor（enumerable 与原生一致、configurable）',
      pd.hasGet === true && pd.hasSet === false && pd.hasValue === false
      && pd.enumerable === true && pd.configurable === true,
      JSON.stringify({ get: pd.hasGet, set: pd.hasSet, e: pd.enumerable, c: pd.configurable }));
    check('P14：原型 getter 看起来原生（toString / name / length）',
      pd.getNative === true && pd.getName === 'get label' && pd.getLength === 0,
      JSON.stringify({ native: pd.getNative, name: pd.getName, length: pd.getLength }));
    check('P14：原型 getter 的 own 属性形状与同 realm 原生 getter 一致',
      JSON.stringify(pd.getOwn) === JSON.stringify(pd.nativeGetterOwn) && pd.nativeGetterNative === true,
      JSON.stringify({ ours: pd.getOwn, native: pd.nativeGetterOwn }));

    check('P14：JSON.stringify 里的 label 与逐条 d.label 一致（toJSON 仍一致）',
      mic.jsonAll && mic.jsonAll.ok === true
      && (mic.jsonAll.labels || []).slice(0, mic.devices.length).join('|') === labelsOf(mic).join('|'),
      JSON.stringify(mic.devices.map((d) => ({ json: d.jsonLabel, direct: d.label }))));
    check('P14：structuredClone 行为与原生一致（原生也抛 DataCloneError）',
      (mic.devices || []).every((d) => d.clone === 'THROW:DataCloneError'),
      JSON.stringify([...new Set((mic.devices || []).map((d) => d.clone))]));

    /* ---------------- 撤销授权：回到空 ---------------- */
    await client.send('Browser.resetPermissions', {}).catch(() => {});
    await nav(URL_A);
    const rev = await evalIn(PROBE);
    const revLabels = labelsOf(rev);
    console.log(`\n撤销后：${JSON.stringify(rev.counts)} · label ${JSON.stringify(revLabels)}`);
    check('P14：撤销授权后 label 回到空（WeakMap 映射已清）', revLabels.every((l) => l === ''), JSON.stringify(revLabels));
    check('P14：撤销后仍没有 own property', noOwnLabel(rev),
      JSON.stringify((rev.devices || []).map((d) => d.ownNames)));
  });
} catch (e) {
  console.log('异常：', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
  check('整体跑通（无异常）', false, String(e && e.message));
}
finish(results);
