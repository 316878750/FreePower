/**
 * P9-A 真机验证：语音按环境 language 投影 getVoices()
 *
 * 跑法：npm run test:speech   （约 25 秒；需真实 Chrome + 完整权限）
 *
 * 断言：
 *   1. 宿主中文声音被挡掉（列表里没有 zh-CN）
 *   2. 只保留环境语言（en-US / en）
 *   3. 每条 voice 形状完整（name / lang / voiceURI / localService / default + instanceof）
 *   4. voice 上没有自有可枚举字段（原生也没有）
 *   5. default 恰好一条
 *   6. onvoiceschanged 由内核触发一次（注入不吞、也不补造）
 *   7. 重复读返回同一批对象
 *   8. SpeechSynthesisUtterance / speak / cancel 行为不受影响
 */
import { withProbe, makeChecker, finish } from './helpers/profile-probe.mjs';

const SPEECH = `(async () => {
  const t0 = Date.now();
  // 计数器由 addScriptToEvaluateOnNewDocument 在文档创建时就装上（原生 voiceschanged
  // 只在声音列表加载完成时触发一次；等加载完再挂 handler 永远等不到）
  const base = window.__voiceEvents || 0;
  const first = speechSynthesis.getVoices().length;
  speechSynthesis.onvoiceschanged = () => { window.__voiceEvents = (window.__voiceEvents || 0) + 1; };
  for (let i = 0; i < 50 && speechSynthesis.getVoices().length === 0; i++) await new Promise((r) => setTimeout(r, 100));
  const list = speechSynthesis.getVoices();
  const shape = list.map((v) => ({
    name: v.name, lang: v.lang, voiceURI: v.voiceURI,
    localService: v.localService, default: v.default,
    ownKeys: Object.keys(v).join(','),
    proto: Object.getPrototypeOf(v) && Object.getPrototypeOf(v).constructor && Object.getPrototypeOf(v).constructor.name,
    isVoice: v instanceof SpeechSynthesisVoice,
  }));
  const again = speechSynthesis.getVoices();
  const behavior = { ok: true };
  try {
    const u = new SpeechSynthesisUtterance('FreePower voice probe');
    u.lang = 'en-US';
    u.rate = 1.1; u.pitch = 1; u.volume = 0;
    if (list[0]) u.voice = list[0];
    const before = speechSynthesis.speaking;
    speechSynthesis.speak(u);
    await new Promise((r) => setTimeout(r, 300));
    speechSynthesis.cancel();
    behavior.ok = true;
    behavior.voiceSettable = list[0] ? u.voice === list[0] : null;
    behavior.speakingBefore = before;
  } catch (e) {
    behavior.ok = false;
    behavior.error = String(e && e.message);
  }
  return {
    first, count: list.length, events: (window.__voiceEvents || 0) - base, totalEvents: window.__voiceEvents || 0,
    ms: Date.now() - t0,
    sameObjects: again.length === list.length && (!list.length || again[0] === list[0]),
    shape, behavior,
    langs: list.map((v) => v.lang),
    firstNames: list.slice(0, 3).map((v) => v.voiceURI + ' / ' + v.lang),
  };
})()`;

const { results, check } = makeChecker();
try {
  await withProbe(async ({ evalIn, nav, URL_A }) => {
    await nav(URL_A);
    const speech = await evalIn(SPEECH);
    console.log(`\n语音：${JSON.stringify({ first: speech.first, count: speech.count, events: speech.events, langs: speech.langs, firstNames: speech.firstNames })}`);
    console.log(`形状：${JSON.stringify((speech.shape || []).slice(0, 3))}`);
    console.log(`Utterance：${JSON.stringify(speech.behavior)}`);

    const shape = speech.shape || [];
    check('P9-A：宿主中文声音被挡掉（列表里没有 zh-CN）', (speech.langs || []).length > 0 && !(speech.langs || []).some((l) => /^zh/i.test(l)), JSON.stringify(speech.langs));
    check('P9-A：只保留环境语言（en-US / en）', (speech.langs || []).every((l) => /^en(-|$)/i.test(l)), JSON.stringify(speech.langs));
    check('P9-A：每条 voice 形状完整（五个字段 + instanceof）',
      shape.length > 0 && shape.every((v) => v.name && v.lang && v.voiceURI !== undefined && typeof v.localService === 'boolean' && typeof v.default === 'boolean' && v.isVoice && v.proto === 'SpeechSynthesisVoice'),
      JSON.stringify(shape[0]));
    check('P9-A：voice 上没有自有可枚举字段（原生也没有）', shape.every((v) => v.ownKeys === ''), JSON.stringify(shape.map((v) => v.ownKeys)));
    check('P9-A：default 恰好一条', shape.filter((v) => v.default === true).length === 1, String(shape.filter((v) => v.default === true).length));
    check('P9-A：onvoiceschanged 由内核触发一次（注入不吞、也不补造）', speech.totalEvents === 1, `totalEvents=${speech.totalEvents}`);
    check('P9-A：重复读返回同一批对象', speech.sameObjects === true, String(speech.sameObjects));
    check('P9-A：SpeechSynthesisUtterance / speak / cancel 行为不受影响',
      speech.behavior?.ok === true && speech.behavior?.voiceSettable !== false, JSON.stringify(speech.behavior));
  });
} catch (e) {
  console.log('异常：', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
  check('整体跑通（无异常）', false, String(e && e.message));
}
finish(results);
