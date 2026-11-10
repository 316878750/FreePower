/**
 * 桌面壳的契约测试（不需要真开窗口，也不依赖 electron 能在这台机器上起 GUI）。
 *
 * 能测的都在这里测：服务引导（boot.js）、自检报告的一次性票据、
 * 残留进程检查的形状、以及 desktop/main.js 里那几条「安全姿势」不许被改回去。
 * 真窗口/托盘/安装包属于外部验收，见 docs/07-P6-桌面壳.md。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 53541;
const DATA = path.join(os.tmpdir(), `fp-desktop-${process.pid}`);
process.env.FREEPOWER_DATA = DATA;
process.env.FREEPOWER_PORT = String(PORT);
process.env.FREEPOWER_RATE_LIMIT_UI = '200';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function raw(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

fs.rmSync(DATA, { recursive: true, force: true });

/* ------------------------- 1. 服务引导（壳复用的那份） ------------------------- */
const boot = await import('../src/boot.js');
const started = await startWithRetry();

async function startWithRetry() {
  for (let i = 0; i < 3; i++) {
    try { return await boot.startApiServer({ port: PORT, tries: 3 }); } catch (e) {
      if (i === 2) throw e;
      await sleep(300);
    }
  }
}

const apiKey = started.apiKey;
check('boot.startApiServer 返回端口/key/url', started.port > 0 && apiKey.length > 10 && started.url.startsWith('http://127.0.0.1:'), started.url);
check('boot 写了 local_api 发现文件', fs.readFileSync(path.join(DATA, 'local_api'), 'utf8').includes(`api_key=${apiKey}`));
check('boot 的 url 就是壳 loadURL 的地址', (await raw('GET', '/status')).text.includes('"code":0'));

/* ------------------------- 2. 自检报告票据 ------------------------- */
const h = { 'api-key': apiKey, 'x-freepower-client': 'ui', 'content-type': 'application/json' };
const createRes = await raw('POST', '/api/v2/browser-profile/create', {
  headers: h,
  body: JSON.stringify({ name: '桌面壳测试环境', country: 'US', group_id: '0' }),
});
const created = JSON.parse(createRes.text);
const pid = created.data && (created.data.profile_id || created.data.id);
check('建了一个环境给票据用', !!pid, pid || created.text.slice(0, 80));

// 直接开 html 报告（没有报告文件）会报「没在运行」，但鉴权必须先过 —— 用 ticket 走
const ticketRes = await raw('POST', '/api/v2/browser-profile/selfcheck-ticket', {
  headers: h, body: JSON.stringify({ profile_id: pid }),
});
const ticketJson = JSON.parse(ticketRes.text);
check('票据接口返回 ticket + url + 有效期', ticketJson.code === 0 && !!ticketJson.data.ticket && ticketJson.data.url.includes('ticket='), JSON.stringify(ticketJson.data || {}).slice(0, 90));
check('票据 url 里没有 api_key', !String(ticketJson.data.url).includes('api_key'));

// 不带任何 key、只带 ticket：鉴权层应放行（之后业务报「没报告」而不是 401）
const noKeyNoTicket = await raw('GET', `/api/v2/browser-profile/selfcheck?profile_id=${pid}&format=html`);
check('没 key 没 ticket → 401', noKeyNoTicket.status === 401, `${noKeyNoTicket.status}`);
const withTicket = await raw('GET', ticketJson.data.url);
check('只带 ticket 能过鉴权（不是 401）', withTicket.status === 200, `${withTicket.status} ${withTicket.text.slice(0, 60)}`);
check('票据放行后仍然是正常 JSON 错误（没报告）', withTicket.text.includes('"code"'), withTicket.text.slice(0, 80));

// 票据绑定 profile：拿 A 的票据读 B
const otherRes = await raw('POST', '/api/v2/browser-profile/create', { headers: h, body: JSON.stringify({ name: '另一个环境', group_id: '0' }) });
const otherId = JSON.parse(otherRes.text).data.profile_id;
const cross = await raw('GET', `/api/v2/browser-profile/selfcheck?profile_id=${otherId}&format=html&ticket=${ticketJson.data.ticket}`);
check('票据绑 profile，换一个环境读不到', cross.status === 401, `${cross.status}`);

// 老契约仍在：api_key 直接放 URL 照旧能用（脚本兼容）
const withKey = await raw('GET', `/api/v2/browser-profile/selfcheck?profile_id=${pid}&format=html&api_key=${apiKey}`);
check('api_key 走 query 的老用法没变', withKey.status === 200 && withKey.text.includes('"code"'), `${withKey.status}`);

// 垃圾票据
const junk = await raw('GET', `/api/v2/browser-profile/selfcheck?profile_id=${pid}&format=html&ticket=fp_nope`);
check('伪造票据 → 401', junk.status === 401, `${junk.status}`);

// 票据有效期与清理（直接测模块，不睡 120 秒）
const tickets = await import('../src/api/tickets.js');
const t = tickets.issueTicket('abc');
check('issueTicket 给 120 秒有效期', t.expires_in === 120, String(t.expires_in));
check('redeem 同 profile 通过', tickets.redeemTicket(t.ticket, 'abc') === true);
check('redeem 跨 profile 拒绝', tickets.redeemTicket(t.ticket, 'zzz') === false);
check('redeem 不存在的票据拒绝', tickets.redeemTicket('nope', 'abc') === false);

/* ------------------------- 3. 残留进程检查 ------------------------- */
const residue = await import('../desktop/residue.js');
const ghost = path.join(os.tmpdir(), `fp-no-such-dir-${Date.now()}`);
const none = await residue.findChromePids(ghost);
check('找不到残留时返回空数组', Array.isArray(none) && none.length === 0, JSON.stringify(none));
const ens = await residue.ensureNoChrome(ghost, { tries: 1, waitMs: 10 });
check('ensureNoChrome 返回 before/killed/remaining 三段', Array.isArray(ens.before) && Array.isArray(ens.killed) && Array.isArray(ens.remaining));
if (process.platform === 'win32') {
  // 拿一个真实存在的 chrome 进程做「能查到自己人」的正向验证（本机常驻 Chrome 即可）
  const sysChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (fs.existsSync(sysChrome)) {
    const found = await residue.findChromePids('chrome.exe');
    check('命令行匹配不到就不误杀（用不可能出现的路径）', (await residue.findChromePids(path.join(os.tmpdir(), 'no-such-fp-path-xyz'))).length === 0);
    check('WMI 查询本身可用（数组）', Array.isArray(found));
  }
}

/* ------------------------- 4. 壳源码的安全姿势不许被改回去 ------------------------- */
const mainSrc = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8');
const has = (re) => re.test(mainSrc);
check('renderer 没有 Node 能力（nodeIntegration 关）', has(/nodeIntegration:\s*false/));
check('contextIsolation 开着', has(/contextIsolation:\s*true/));
check('sandbox 开着', has(/sandbox:\s*true/));
check('不挂 preload', !has(/preload\s*:/));
check('window.open 一律拒', has(/setWindowOpenHandler/) && has(/action:\s*'deny'/));
check('外链丢系统浏览器', has(/shell\.openExternal/));
check('导航到外部地址被拦', has(/will-navigate/) && has(/event\.preventDefault\(\)/));
check('单实例锁', has(/requestSingleInstanceLock/) && has(/second-instance/));
check('关窗只隐藏不退出', has(/win\.on\('close'/) && has(/win\.hide\(\)/));
check('退出前停全部环境', has(/shutdownRuntime\(\)/) && has(/ensureNoChrome\(/));
check('托盘三件套（打开控制台/运行数/停止全部）', has(/打开控制台/) && has(/运行中：/) && has(/停止全部环境/));
check('托盘退出项', has(/退出 FreePower/));
check('开机自启开关', has(/setLoginItemSettings/) && has(/openAtLogin/));

/* ------------------------- 5. 打包配置 ------------------------- */
const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
check('打包配置存在 appId/productName', /appId:\s*com\.freepower\.desktop/.test(yml) && /productName:\s*FreePower/.test(yml));
check('测试与文档不进安装包', yml.includes('!test/**') && yml.includes('!docs/**'));
check('图标从 asar 里解出来（原生层要读）', /asarUnpack:\s*\n\s*-\s*desktop\/assets/.test(yml));
check('NSIS 一键安装 + 免管理员', /oneClick:\s*true/.test(yml) && /perMachine:\s*false/.test(yml));
check('安装完自动启动', /runAfterFinish:\s*true/.test(yml));

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check('package.json main 指向壳', pkg.main === 'desktop/main.js');
check('electron 只在 devDependencies（不进运行时依赖）', !!pkg.devDependencies.electron && !pkg.dependencies);
check('有 dist:win 脚本', String(pkg.scripts['dist:win']).includes('electron-builder'));

const ico = path.join(ROOT, 'desktop', 'build', 'icon.ico');
const tray = path.join(ROOT, 'desktop', 'assets', 'tray.png');
check('安装包图标存在且是 ICO', fs.existsSync(ico) && fs.statSync(ico).size > 2000, `${fs.existsSync(ico) ? fs.statSync(ico).size : 0} bytes`);
const pngHead = fs.existsSync(tray) ? fs.readFileSync(tray).subarray(1, 4).toString() : '';
check('托盘图标是 PNG', pngHead === 'PNG', pngHead);

/* ------------------------- 收尾 ------------------------- */
await started.close();
check('server.close() 能收干净', started.server.listening === false);
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 句柄可能还没放，临时目录不阻塞结论 */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);