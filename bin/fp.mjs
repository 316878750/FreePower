#!/usr/bin/env node
/**
 * `fp` 命令行：本机 FreePower 的短命令。
 *
 *   fp list                 列出环境（默认 20 条）
 *   fp start <id> [id...]   启动环境
 *   fp stop  <id> [id...]   停止环境
 *   fp status               服务状态 + 正在跑的环境
 *
 * 和 MCP server 走同一套「发现」逻辑：`-k/--key` > `FREEPOWER_API_KEY` >
 * `data/local_api`；端口 `--port` > `FREEPOWER_PORT` > 发现文件 > 53380。
 * **只连 127.0.0.1**，不发任何外网请求。
 */
import fs from 'node:fs';
import path from 'node:path';
import { API_HOST, API_PORT, DATA_DIR } from '../src/config.js';

function parseArgs(argv) {
  const out = { cmd: '', ids: [], port: 0, key: '', json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '-k' || a === '--key') out.key = argv[++i] || '';
    else if (a.startsWith('--key=')) out.key = a.slice(6);
    else if (a === '-p' || a === '--port') out.port = Number(argv[++i] || 0);
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7) || 0);
    else if (a === '--json') out.json = true;
    else if (!out.cmd) out.cmd = a;
    else out.ids.push(a);
  }
  return out;
}

function readDiscovery() {
  try {
    const text = fs.readFileSync(path.join(DATA_DIR, 'local_api'), 'utf8');
    return {
      url: (/(http:\/\/[^\s]+)/.exec(text) || [])[1] || '',
      key: (/api_key=(\S+)/.exec(text) || [])[1] || '',
    };
  } catch {
    return { url: '', key: '' };
  }
}

const args = parseArgs(process.argv.slice(2));
const found = readDiscovery();

let port = args.port || Number(process.env.FREEPOWER_PORT || 0);
if (!port && found.url) {
  const m = /:(\d+)/.exec(found.url);
  if (m) port = Number(m[1]);
}
if (!port) port = API_PORT;

const base = `http://${API_HOST}:${port}`;
/**
 * key 从哪来（排错要靠这个说清是哪一环出问题）：
 *   cli    命令行 -k
 *   env    FREEPOWER_API_KEY
 *   file   data/local_api 发现文件
 *   none   都没有
 */
const keySource = args.key ? 'cli' : (process.env.FREEPOWER_API_KEY ? 'env' : (found.key ? 'file' : 'none'));
const key = args.key || process.env.FREEPOWER_API_KEY || found.key || '';

const USAGE = `FreePower CLI

用法：
  fp list [--json]             列出环境
  fp start <id> [id...]        启动环境
  fp stop  <id> [id...]        停止环境
  fp status [--json]           服务状态 + 运行中的环境

选项：
  -k, --key <KEY>    API key（默认读 data/local_api）
  -p, --port <PORT>  本地 API 端口（默认 ${API_PORT}）
      --json         输出原始 JSON
`;

const TOO_MANY = 'Too many request per second';

/**
 * 调本地 API。
 * 默认档位是 1 req/s，而 CLI 一次操作可能连发几个请求（比如 `fp stop a b c`）——
 * 撞到限流就按报文提示**退一步重试**，这正是指令里那句 "please check" 的用法。
 * 不做无限重试：最多 3 次，仍失败就如实报错。
 */
async function call(method, apiPath, body, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const headers = { 'content-type': 'application/json' };
    if (key) headers['api-key'] = key;
    const res = await fetch(base + apiPath, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    if (!json) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
    if (json.code !== 0) {
      if (String(json.msg || '').includes(TOO_MANY) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 1100));
        continue;
      }
      throw new Error(`${json.msg || 'request failed'}（code ${json.code}）`);
    }
    return json.data === undefined ? { code: json.code, msg: json.msg } : json.data;
  }
}

/**
 * 失败提示要**分清是哪一种失败**：
 *   - key 根本没有 → 告诉用户怎么给；
 *   - key 有但被拒（401）→ 告诉用户是「哪来的 key 被拒」，别让他以为没配置。
 * 这两种混成一句，排障时会往完全错的方向走（比如以为要配 key，其实是连错了数据目录）。
 */
function fail(e) {
  const msg = String(e?.message || e);
  const rejected = /invalid api_key/i.test(msg) || /code -1/.test(msg) && /api_key/i.test(msg);
  console.error(`失败：${msg}`);
  if (keySource === 'none') {
    console.error('提示：没找到 API key —— 传 -k，或确认 FreePower 桌面端在运行（它会写 data/local_api）。');
  } else if (rejected) {
    const where = { cli: '命令行 -k 传的', env: '环境变量 FREEPOWER_API_KEY 里的', file: `发现文件 ${path.join(DATA_DIR, 'local_api')} 里的` }[keySource];
    console.error(`提示：${where} key 被拒（服务不认它）。常见原因：服务重启后换过 key、或这个数据目录不是桌面端正在用的那个。`);
    console.error(`      正确的 key 在桌面端「API & MCP」页，或 ${path.join(DATA_DIR, 'local_api')}（如果目录对）。`);
  }
  process.exit(1);
}

const pad = (s, n) => String(s ?? '').padEnd(n);

/** 按**实际内容**算列宽：profile_id 是 36 字符的 UUID，写死 12 会把 ID 和编号粘在一起 */
function columnWidths(header, rows) {
  return header.map((h, i) => Math.max(...[h, ...rows.map((r) => r[i])].map((v) => String(v ?? '').length)));
}
const renderRow = (cells, widths) => cells.map((c, i) => pad(c, widths[i])).join('');

async function main() {
  if (args.help || !args.cmd) {
    process.stdout.write(USAGE);
    process.exit(args.cmd || args.help ? 0 : 1);
  }

  switch (args.cmd) {
    case 'list': {
      const data = await call('POST', '/api/v2/browser-profile/list', { page: 1, limit: 20 });
      if (args.json) { process.stdout.write(`${JSON.stringify(data, null, 2)}\n`); break; }
      const list = data?.list || [];
      if (!list.length) { console.log('还没有环境。'); break; }
      // 每列后面留一个空格，按实际内容算宽度（ID 是 36 字符的 UUID）
      const header = ['ID', '编号', '名称', '分组'];
      const rows = list.map((p) => [p.profile_id, p.profile_no, p.name, p.group_id ?? '']);
      const widths = columnWidths(header, rows).map((w) => w + 2);
      console.log(renderRow(header, widths).trimEnd());
      for (const r of rows) console.log(renderRow(r, widths).trimEnd());
      console.log(`\n共 ${data.total ?? list.length} 个（本页 ${list.length} 个）`);
      break;
    }
    case 'start':
    case 'stop': {
      if (!args.ids.length) { console.error('缺少环境 id。用法：fp start <id>'); process.exit(1); }
      const pathName = args.cmd === 'start' ? 'start' : 'stop';
      let bad = 0;
      for (const id of args.ids) {
        try {
          const r = await call('GET', `/api/v2/browser-profile/${pathName}?profile_id=${encodeURIComponent(id)}`);
          if (args.json) console.log(JSON.stringify(r, null, 2));
          else if (args.cmd === 'start') console.log(`已启动 ${id}${r?.ws?.puppeteer ? `  ws: ${r.ws.puppeteer}` : ''}`);
          else console.log(`已停止 ${id}`);
        } catch (e) {
          bad++;
          console.error(`${id} 失败：${e.message}`);
        }
      }
      if (bad) process.exit(1);
      break;
    }
    case 'status': {
      // 顺序发：/status 免鉴权也不限流，local-active 才占配额（并行会自己撞 1/s 的限流）
      const st = await call('GET', '/status');
      const running = await call('GET', '/api/v2/browser-profile/local-active');
      const list = running?.list || [];
      if (args.json) { process.stdout.write(`${JSON.stringify({ status: st, running: list }, null, 2)}\n`); break; }
      console.log(`服务     ${base}  ${st?.msg === 'success' ? '在线' : '未知'}`);
      console.log(`运行中   ${list.length} 个`);
      for (const p of list) console.log(`  - ${p.profile_id}  ${p.name || ''}`);
      break;
    }
    default:
      console.error(`未知命令：${args.cmd}\n`);
      process.stdout.write(USAGE);
      process.exit(1);
  }
}

main().catch(fail);
