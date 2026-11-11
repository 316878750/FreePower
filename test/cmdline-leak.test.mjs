/**
 * 安全性自查：我们自己起的 chrome，命令行里**不许**出现代理账号密码、也不许出现指纹参数。
 *
 * 背景：逆向那边实测 AdsPower 把噪声种子、时区、出口 IP、地理坐标、UserId 全以
 * `--protected-*` 明文挂在每个子进程命令行上，本机任何进程一读就有。
 * 我们走 CDP + 注入，理论上不落命令行——这份脚本用 Win32_Process.CommandLine 实证一次，
 * 不靠「我读过代码所以应该没问题」。
 *
 * 跑法：npm run test:cmdline   （需真实 Chrome + 完整权限；独立于 npm run smoke）
 */
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, '.tmp', 'leak-data');
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.FREEPOWER_DATA = DATA;
process.env.FREEPOWER_SELFCHECK = '0';

const { startFakeProxy, startEchoServer } = await import('./fake-proxy.mjs');
const { createApiServer } = await import('../src/api/server.js');

const PASSWORD = 'Sup3rSecretProxyPwd';
const USERNAME = 'leakcheckuser';
const TIMEZONE = 'Europe/Berlin';

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
function ps(cmd) { try { return execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }); } catch { return ''; } }

const echo = await startEchoServer();
const fake = await startFakeProxy({ auth: { username: USERNAME, password: 'anything' }, egress: echo.url });

const { server, apiKey } = createApiServer();
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const api = async (m, p, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: m, headers: { 'content-type': 'application/json', api_key: apiKey, 'x-freepower-client': 'mcp' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
};

let id = null;
try {
  const c = await api('POST', '/api/v2/browser-profile/create', {
    name: `leak-${Date.now()}`,
    group_id: '0',
    proxy_config: { proxy_type: 'http', host: '127.0.0.1', port: fake.port, username: USERNAME, password: PASSWORD },
    timezone: TIMEZONE,
  });
  id = c.json.data.profile_id;
  const s = await api('GET', `/api/v2/browser-profile/start?profile_id=${id}`);
  check('环境起来了', s.json.code === 0 && s.json.data.status === 'running', JSON.stringify({ code: s.json.code, msg: s.json.msg }));

  const pid = s.json.data.pid;
  const frag = id.split('-')[0];

  // 读该环境所有进程的完整命令行（主进程 + 子进程）
  const raw = ps(`Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Select-Object -ExpandProperty CommandLine`);
  const lines = raw.split(/\r?\n/).filter((l) => l.includes(frag));
  const all = lines.join('\n');
  // user-data-dir 从命令行里取（实例对象不暴露这个字段）；它同时是「过滤真命中本环境、不是读到别人的进程」的证据
  const udd = (all.match(/--user-data-dir=(\S+)/) || [])[1] || '';
  console.log(`  该环境 chrome 进程 ${lines.length} 个；主进程 pid=${pid}；user-data-dir=${udd}`);

  check('命令行里没有代理密码', !all.includes(PASSWORD), PASSWORD.slice(0, 3) + '***');
  check('命令行里没有代理用户名', !all.includes(USERNAME));
  check('命令行里没有时区值（指纹参数不进命令行）', !all.includes(TIMEZONE));
  check('命令行里没有 --protected-* 这类明文指纹参数', !/--protected-/i.test(all));
  check('代理只以 host:port 形式出现', /--proxy-server=http:\/\/127\.0\.0\.1:\d+/.test(all), (all.match(/--proxy-server=\S+/) || [''])[0]);

  // 反面证据：确认我们确实读到了命令行（不是读了个空串导致全部「通过」）
  check('读到的命令行非空（防止假阴性）', all.length > 200, `${all.length} 字符`);
  check('命中的确实是本环境（user-data-dir 含 id 前 8 位）', Boolean(udd) && udd.includes(frag), udd);
  const sample = (lines.find((l) => !l.includes('--type=')) || '').replace(/\s+/g, ' ');
  console.log('  主进程命令行（前 220 字）:', sample.slice(0, 220));
} catch (e) {
  console.log('异常:', e && e.message);
} finally {
  try { await api('GET', `/api/v2/browser-profile/stop?profile_id=${id}`); } catch {}
  try { await api('POST', '/api/v2/browser-profile/delete', { profile_id: [id] }); } catch {}
  server.close();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
}

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
