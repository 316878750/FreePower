/**
 * 多级代理链：**纯逻辑**判据（不起内核，不碰注册表，不连外网）
 *
 * 判的是「链由什么拼出来」，不是「转发通不通」（转发那条在 `test/proxy-chain.test.mjs`）：
 *   1. 开关只认字符串 `'1'`（`is_multi_level_proxy` 与对手拼写 `mutli_level_proxy`）；
 *   2. hop0 = **本机系统代理**（`ProxyEnable` / `ProxyServer` / `ProxyOverride`），hop1 = 环境代理；
 *   3. `ProxyEnable=0` → **塌成单跳**（0 或 1 跳，正常启动，不是失败）；
 *   4. 系统代理是 PAC（`AutoConfigURL` 非空）→ 明确拒绝（`pac_unsupported`）；
 *   5. `ProxyServer` 的两种写法都要解：`host:port` 与 `http=host:port;https=host:port`；
 *   6. `readSystemProxy(overrides)` 传了注入值就**完全不读注册表**（测试永远不改用户注册表）；
 *   7. 两跳必须都是 http：socks5 / https 跳明确拒绝，不假装支持。
 *
 * 跑法：npm run test:chain-rules
 */
import {
  readSystemProxy, parseProxyServer, resolveChain,
} from '../src/proxy/chain.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fmt = (x) => JSON.stringify(x);

const ENV = { proxy_type: 'http', host: '10.0.0.1', port: 8000, username: 'env-user', password: 'env-pass' };
const SYS = { ProxyEnable: 1, ProxyServer: '127.0.0.1:7890', ProxyOverride: '<local>;*.corp' };

/* ------------------------------ ProxyServer 解析 ------------------------------ */
{
  const a = parseProxyServer('127.0.0.1:7890');
  check('parseProxyServer：裸 host:port → http 跳', eq(a.pick, { type: 'http', host: '127.0.0.1', port: 7890, raw: '127.0.0.1:7890' }), fmt(a.pick));

  const b = parseProxyServer('http=10.1.1.1:8080;https=10.1.1.1:8443');
  check('parseProxyServer：http=…;https=… → 优先挑 http 那条', b.pick?.type === 'http' && b.pick.host === '10.1.1.1' && b.pick.port === 8080, fmt(b.pick));
  check('parseProxyServer：两条都留在 entries 里', b.entries.length === 2, fmt(b.entries.map((e) => e.type)));

  const c = parseProxyServer('https=10.2.2.2:8443');
  check('parseProxyServer：只有 https= → 认成 https（不冒充 http）', c.pick?.type === 'https' && c.pick.port === 8443, fmt(c.pick));

  const d = parseProxyServer('socks=127.0.0.1:1080');
  check('parseProxyServer：socks= → socks5（后面会被两跳规则拒掉）', d.pick?.type === 'socks5', fmt(d.pick));

  const e = parseProxyServer('[::1]:7890');
  check('parseProxyServer：IPv6 方括号写法', e.pick?.host === '::1' && e.pick.port === 7890, fmt(e.pick));

  check('parseProxyServer：空串 / 无端口 → null（不猜默认端口）',
    parseProxyServer('').pick === null && parseProxyServer('127.0.0.1').pick === null,
    fmt([parseProxyServer('').pick, parseProxyServer('127.0.0.1').pick]));
}

/* ------------------------------ readSystemProxy（注入，不碰注册表） ------------------------------ */
{
  const sys = readSystemProxy(SYS);
  check('readSystemProxy：注入就不读注册表（source=override）', sys.source === 'override');
  check('readSystemProxy：ProxyEnable=1 + ProxyServer → 有 hop', sys.enabled === true && sys.hop.host === '127.0.0.1' && sys.hop.port === 7890, fmt(sys.hop));
  check('readSystemProxy：ProxyOverride 解成旁路表（读出来备查）', eq(sys.bypass, ['<local>', '*.corp']), fmt(sys.bypass));
  check('readSystemProxy：没有 PAC 时 pacUrl=null', sys.pacUrl === null, fmt(sys.pacUrl));

  const off = readSystemProxy({ ProxyEnable: 0, ProxyServer: '127.0.0.1:7890' });
  check('readSystemProxy：ProxyEnable=0 → 即使留着 ProxyServer 也当没配', off.enabled === false && off.hop === null, fmt({ enabled: off.enabled, hop: off.hop }));

  const dword = readSystemProxy({ ProxyEnable: '0x1', ProxyServer: '127.0.0.1:7890' });
  check('readSystemProxy：reg query 的 0x1 也认成启用', dword.enabled === true, fmt(dword.proxyEnable));

  const pac = readSystemProxy({ ProxyEnable: 0, AutoConfigURL: 'http://wpad/proxy.pac' });
  check('readSystemProxy：AutoConfigURL 非空 → pacUrl 有值', pac.pacUrl === 'http://wpad/proxy.pac', fmt(pac.pacUrl));
}

/* ------------------------------ 开关判定 ------------------------------ */
{
  const off = resolveChain({ user_proxy_config: ENV }, { systemProxy: SYS });
  check('开关未设 → inactive / mode=off（有系统代理也不组链）', off.ok && off.active === false && off.mode === 'off', fmt(off.mode));

  const zero = resolveChain({ is_multi_level_proxy: '0', user_proxy_config: ENV }, { systemProxy: SYS });
  check('开关=0 → inactive（不是「假」值也算开）', zero.active === false, fmt(zero.mode));

  const typo = resolveChain({ mutli_level_proxy: '1', user_proxy_config: ENV }, { systemProxy: SYS });
  check('对手拼写 mutli_level_proxy=1 同样当开关', typo.active === true && typo.mode === 'chain', fmt(typo.mode));
}

/* ------------------------------ 三种情形 ------------------------------ */
{
  const two = resolveChain({ is_multi_level_proxy: '1', user_proxy_config: ENV }, { systemProxy: SYS });
  check('两跳：hop0=系统代理、hop1=环境代理（下标 0 离浏览器最近）',
    two.ok && two.mode === 'chain' && two.hops.length === 2
    && two.hops[0].source === 'system' && two.hops[0].port === 7890
    && two.hops[1].source === 'environment' && two.hops[1].host === '10.0.0.1',
    fmt(two.hops.map((h) => `${h.source}:${h.host}:${h.port}`)));
  check('两跳：环境代理的账密只挂在环境那一跳上', two.hops[0].username === '' && two.hops[1].username === 'env-user', fmt(two.hops.map((h) => h.username)));
  check('两跳：不是塌缩状态', two.collapsed === false);

  const noSys = resolveChain({ is_multi_level_proxy: '1', user_proxy_config: ENV }, { systemProxy: { ProxyEnable: 0, ProxyServer: '127.0.0.1:7890' } });
  check('系统代理未启用 → 塌成单跳（只有环境代理），**不是失败**',
    noSys.ok && noSys.mode === 'single' && noSys.hops.length === 1 && noSys.hops[0].source === 'environment' && noSys.collapsed === true,
    fmt({ ok: noSys.ok, mode: noSys.mode, hops: noSys.hops.length }));

  const noEnv = resolveChain({ is_multi_level_proxy: '1' }, { systemProxy: SYS });
  check('环境没有代理但系统代理在 → 单跳=系统代理（也算正常启动）',
    noEnv.ok && noEnv.mode === 'single' && noEnv.hops[0].source === 'system', fmt(noEnv.mode));

  const none = resolveChain({ is_multi_level_proxy: '1' }, { systemProxy: { ProxyEnable: 0 } });
  check('两者都没有 → 0 跳（与不设代理等价，不是失败）', none.ok && none.mode === 'none' && none.hops.length === 0, fmt(none.mode));

  const same = resolveChain({ is_multi_level_proxy: '1', user_proxy_config: { proxy_type: 'http', host: '127.0.0.1', port: 7890 } }, { systemProxy: SYS });
  check('系统代理与环境代理是同一个 → 去重成单跳（不自连自）', same.mode === 'single' && same.hops.length === 1, fmt(same.mode));
}

/* ------------------------------ PAC 明确拒绝 ------------------------------ */
{
  const pac = resolveChain({ is_multi_level_proxy: '1', user_proxy_config: ENV }, { systemProxy: { ProxyEnable: 0, AutoConfigURL: 'http://wpad/wpad.dat' } });
  check('系统代理是 PAC → ok:false + pac_unsupported（不静默绕过）',
    pac.ok === false && pac.reason === 'pac_unsupported', fmt({ ok: pac.ok, reason: pac.reason }));
  check('PAC 拒绝的文案里带 AutoConfigURL（能直接定位到配置）', String(pac.message).includes('AutoConfigURL=http://wpad/wpad.dat'), pac.message);
}

/* ------------------------------ 两跳的协议限制 ------------------------------ */
{
  const socksSys = resolveChain({ is_multi_level_proxy: '1', user_proxy_config: ENV }, { systemProxy: { ProxyEnable: 1, ProxyServer: 'socks=127.0.0.1:1080' } });
  check('系统代理只有 socks= → 两跳组不成，明确拒绝（不冒充 http）',
    socksSys.ok === false && socksSys.reason === 'proxy_chain_invalid' && String(socksSys.message).includes('socks5'),
    fmt({ ok: socksSys.ok, reason: socksSys.reason }));

  const socksEnv = resolveChain({ is_multi_level_proxy: '1', user_proxy_config: { proxy_type: 'socks5', host: '10.0.0.1', port: 1080 } }, { systemProxy: SYS });
  check('环境代理是 socks5 + 系统代理在 → 同样拒绝两跳',
    socksEnv.ok === false && socksEnv.reason === 'proxy_chain_invalid', fmt(socksEnv.reason));

  const socksAlone = resolveChain({ is_multi_level_proxy: '1', user_proxy_config: { proxy_type: 'socks5', host: '10.0.0.1', port: 1080 } }, { systemProxy: { ProxyEnable: 0 } });
  check('只有环境 socks5（单跳）→ 不组链、正常放行（老路径照旧）',
    socksAlone.ok && socksAlone.mode === 'single' && socksAlone.hops[0].type === 'socks5', fmt({ mode: socksAlone.mode, type: socksAlone.hops[0].type }));
}

/* ------------------------------ ProxyOverride 不产生直连 ------------------------------ */
{
  // `<local>` 是最常见的默认值。我们**不**按它逐请求旁路（旁路 = 直连，正是 fail-closed 要禁止的），
  // 所以即使 override 里写着 `<local>`，链仍是两跳；它只被读出来备查（README 已写明）。
  const sys = readSystemProxy({ ProxyEnable: 1, ProxyServer: '127.0.0.1:7890', ProxyOverride: '<local>' });
  check('ProxyOverride 被读出来（<local> 在旁路表里）', eq(sys.bypass, ['<local>']), fmt(sys.bypass));
  const chain = resolveChain({ is_multi_level_proxy: '1', user_proxy_config: ENV },
    { systemProxy: { ProxyEnable: 1, ProxyServer: '127.0.0.1:7890', ProxyOverride: '<local>' } });
  check('ProxyOverride 含 <local>：链不塌缩、也不产生直连分支（仍是两跳）',
    chain.mode === 'chain' && chain.hops.length === 2, fmt({ mode: chain.mode, hops: chain.hops.length }));
}

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
