/**
 * Web 控制台的契约测试（不需要 Chrome）。
 *
 * 覆盖：静态托管边界、schema 接口形状、validate 与 create/update 同源、
 * 删除时清 user-data 目录、ui 客户端的限流额度。
 * 起真服务、打真 HTTP —— 界面出问题时这些是最先该看的东西。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 53531;
const DATA = path.join(os.tmpdir(), `fp-ui-${process.pid}`);
process.env.FREEPOWER_DATA = DATA;
process.env.FREEPOWER_PORT = String(PORT);

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 原始路径请求：fetch 会把 /ui/../x 归一化掉，测穿越必须自己发 */
function raw(method, rawPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: rawPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function start() {
  fs.rmSync(DATA, { recursive: true, force: true });
  const child = spawn(process.execPath, ['--no-warnings', 'src/main.js'], {
    cwd: ROOT,
    env: { ...process.env, FREEPOWER_DATA: DATA, FREEPOWER_PORT: String(PORT) },
    stdio: 'ignore',
  });
  return child;
}

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    try {
      const r = await raw('GET', '/status');
      if (r.status === 200 && r.text.includes('"code":0')) return true;
    } catch { /* 还没起来 */ }
  }
  return false;
}

const child = start();
let apiKey = '';
try {
  check('服务起来了', await waitReady());
  apiKey = fs.readFileSync(path.join(DATA, 'local_api'), 'utf8').match(/api_key=(\S+)/)[1];

  /* ---------------- 静态托管 ---------------- */
  const index = await raw('GET', '/');
  check('首页 200 + text/html', index.status === 200 && /text\/html/.test(index.headers['content-type'] || ''), `${index.status}`);
  check('首页注入了本地 api_key', index.text.includes(apiKey) && index.text.includes('window.__FP__'));
  check('首页引用了控制台脚本', index.text.includes('/ui/app.js'));

  const js = await raw('GET', '/ui/app.js');
  check('/ui/app.js 200 + js 类型', js.status === 200 && /javascript/.test(js.headers['content-type'] || ''), js.headers['content-type']);
  check('/ui/app.js 有 no-store（本地活页不吃缓存）', /no-store/.test(js.headers['cache-control'] || ''));

  const css = await raw('GET', '/ui/style.css');
  check('/ui/style.css 200', css.status === 200 && /text\/css/.test(css.headers['content-type'] || ''));

  const traversal = await raw('GET', '/ui/../package.json');
  check('路径穿越被拒（404）', traversal.status === 404, `${traversal.status}`);
  const traversal2 = await raw('GET', '/ui/%2e%2e/package.json');
  check('编码后的穿越也被拒', traversal2.status === 404, `${traversal2.status}`);
  const missing = await raw('GET', '/ui/nope.js');
  check('不存在的资源 404', missing.status === 404);

  /* ---------------- schema ---------------- */
  const schemaNoKey = await raw('GET', '/api/v2/browser-profile/schema');
  check('schema 需要 api-key', schemaNoKey.status === 401, `${schemaNoKey.status}`);

  const h = { 'api-key': apiKey, 'x-freepower-client': 'ui', 'content-type': 'application/json' };
  const schemaRes = await raw('GET', '/api/v2/browser-profile/schema', { headers: h });
  const schema = JSON.parse(schemaRes.text);
  check('schema code 0', schema.code === 0);
  const groups = schema.data.groups;
  check('schema 分 11 组', groups.length === 11, groups.map((g) => g.id).join(','));
  check('schema 字段总数 = 注册表 - 运行时字段', schema.data.total === 131, String(schema.data.total));
  const byName = new Map();
  for (const g of groups) for (const f of g.fields) byName.set(f.name, f);
  check('name/group_id 在基本信息里', byName.get('name')?.group === 'identity' && byName.get('group_id')?.required === true);
  check('canvas 是开关型（带值标签）', byName.get('canvas')?.kind === 'select' && byName.get('canvas')?.value_labels?.['1'] === '开启（同种子稳定）');
  check('runtime 字段不进表单', !byName.has('ip') && !byName.has('user_proxy_config'));
  check('云端字段标了 cloudOnly', byName.get('category_id')?.cloudOnly === true);
  check('fields 只出现在组里，不重复', groups.reduce((n, g) => n + g.fields.length, 0) === schema.data.total);

  /* ---------------- validate ---------------- */
  const bad = JSON.parse((await raw('POST', '/api/v2/browser-profile/validate', {
    headers: h,
    body: JSON.stringify({ mode: 'create', profile: { name: 'v', group_id: '0', timezone: 'Mars/Olympus', hardware_concurrency: 7 } }),
  })).text);
  check('validate：非法值报错且带字段名', bad.code === 0 && bad.data.ok === false
    && bad.data.errors.some((e) => e.field === 'timezone' && /not an IANA timezone/.test(e.message))
    && bad.data.errors.some((e) => e.field === 'hardware_concurrency'), JSON.stringify(bad.data.errors));

  const consistency = JSON.parse((await raw('POST', '/api/v2/browser-profile/validate', {
    headers: h,
    body: JSON.stringify({ mode: 'create', profile: { name: 'v', group_id: '0', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/157.0.0.0', platform: 'MacIntel' } }),
  })).text);
  check('validate：UA↔platform 硬冲突作为 warnings 返回',
    consistency.data.ok === true && consistency.data.warnings.some((w) => w.severity === 'hard' && w.field === 'platform'),
    JSON.stringify(consistency.data.warnings));

  const good = JSON.parse((await raw('POST', '/api/v2/browser-profile/validate', {
    headers: h,
    body: JSON.stringify({ mode: 'create', profile: { name: 'v', group_id: '0', timezone: 'Asia/Tokyo' } }),
  })).text);
  check('validate：合法输入 ok', good.data.ok === true && good.data.errors.length === 0);

  /* ---------------- 创建 → 删除（含 user-data） ---------------- */
  const created = JSON.parse((await raw('POST', '/api/v2/browser-profile/create', {
    headers: h,
    body: JSON.stringify({ name: 'ui-env', group_id: '0', country: 'JP' }),
  })).text);
  check('建环境成功', created.code === 0 && !!created.data.profile_id, created.msg);
  const pid = created.data.profile_id;
  const pno = created.data.profile_no;

  // 手动造一个 user-data 目录，验证删除时会被带走
  const envDir = path.join(DATA, 'profiles', `${pno}_${String(pid).slice(0, 8)}`);
  fs.mkdirSync(path.join(envDir, 'userdata', 'Default'), { recursive: true });
  fs.writeFileSync(path.join(envDir, 'userdata', 'Default', 'Cookies'), 'x');

  const del = JSON.parse((await raw('POST', '/api/v2/browser-profile/delete', {
    headers: h,
    body: JSON.stringify({ profile_id: [pid] }),
  })).text);
  check('删除返回 deleted + userdata_removed', del.code === 0 && del.data.deleted.length === 1 && del.data.userdata_removed === 1, JSON.stringify(del.data));
  check('user-data 目录已删除', !fs.existsSync(envDir));
  const gone = JSON.parse((await raw('GET', `/api/v2/browser-profile/detail?profile_id=${pid}`, { headers: h })).text);
  check('删完再查报 100001', gone.code === 100001, `${gone.code}`);

  /* ---------------- 限流 ---------------- */
  const hits = [];
  for (let i = 0; i < 6; i++) {
    const r = await raw('GET', '/api/v1/user/list', { headers: { 'api-key': apiKey } });
    hits.push(JSON.parse(r.text));
  }
  check('普通客户端 1/s：连发会被限', hits.some((j) => j.code === -1 && /Too many request/.test(j.msg)));

  const uiHits = [];
  for (let i = 0; i < 6; i++) {
    const r = await raw('GET', '/api/v1/user/list', { headers: h });
    uiHits.push(JSON.parse(r.text));
  }
  check('控制台客户端（ui）有自己的额度，连发不被打断', uiHits.every((j) => j.code === 0), uiHits.map((j) => j.code).join(','));

  /* ---------------- 别的站点嵌不了控制台 ---------------- */
  const corsIndex = await raw('GET', '/', { headers: { origin: 'https://evil.example' } });
  check('外站 Origin 拿不到首页（403 纯文本）', corsIndex.status === 403 && corsIndex.text === 'CORS ERROR', `${corsIndex.status}`);
} catch (e) {
  fail++;
  console.log(`FAIL  未捕获异常：${e.message}\n${e.stack}`);
} finally {
  child.kill();
  await sleep(300);
  fs.rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);