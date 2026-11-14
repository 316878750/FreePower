#!/usr/bin/env node
/**
 * FreePower MCP server（stdio，零依赖）。
 *
 * 为什么自己写协议层：官方 `@modelcontextprotocol/sdk` 不在我们的依赖里，为一个
 * 「把本地 API 包成 tools」的薄壳引一整套 SDK（含 zod 等传递依赖）不划算，
 * 而 MCP 的 stdio 传输就是**一行一个 JSON-RPC 消息**，`initialize` / `tools/list` /
 * `tools/call` 三个方法 + 一条 `notifications/initialized` 通知，手写比读 SDK 文档还短。
 * 将来要接 resources / prompts 再引 SDK 也不迟。
 *
 * 连谁：**只连本机 127.0.0.1 的 FreePower Local API**，key 从环境变量或
 * `data/local_api` 发现文件读。不向外发任何请求，不读用户数据目录以外的东西。
 *
 * 启动方式（三种客户端都一样，只是配置文件的形状不同，控制台里能直接复制）：
 *   node <repo>/mcp/server.mjs
 * 环境变量：
 *   FREEPOWER_PORT     本地 API 端口（默认 53380）
 *   FREEPOWER_API_KEY  API key（不设就从 data/local_api 读）
 *   FREEPOWER_DATA     数据目录（不设用仓库/data，打包后用 %APPDATA%\\FreePower\\data）
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { API_HOST, API_PORT, DATA_DIR } from '../src/config.js';

const require = createRequire(import.meta.url);
const VERSION = (() => {
  try { return require('../package.json').version; } catch { return '0.0.0'; }
})();

/** 协议版本：客户端要什么就回什么（MCP 的版本协商是「客户端提议、服务端同意」） */
const DEFAULT_PROTOCOL = '2024-11-05';

/* --------------------------- 连本地 API --------------------------- */

function readDiscovery() {
  const file = path.join(DATA_DIR, 'local_api');
  try {
    const text = fs.readFileSync(file, 'utf8');
    const url = /(http:\/\/[^\s]+)/.exec(text);
    const key = /api_key=(\S+)/.exec(text);
    return { url: url ? url[1] : '', key: key ? key[1] : '' };
  } catch {
    return { url: '', key: '' };
  }
}

function resolveTarget() {
  const found = readDiscovery();
  let port = Number(process.env.FREEPOWER_PORT || 0);
  if (!port && found.url) {
    const m = /:(\d+)/.exec(found.url);
    if (m) port = Number(m[1]);
  }
  if (!port) port = API_PORT;
  return {
    base: `http://${API_HOST}:${port}`,
    key: process.env.FREEPOWER_API_KEY || found.key || '',
  };
}

const target = resolveTarget();

async function callApi(method, apiPath, body) {
  const headers = { 'content-type': 'application/json', 'x-freepower-client': 'mcp' };
  if (target.key) headers['api-key'] = target.key;
  const res = await fetch(target.base + apiPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!json) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  if (json.code !== 0) {
    throw new Error(`${json.msg || 'request failed'}（code ${json.code}）`);
  }
  return json.data === undefined ? null : json.data;
}

/* ------------------------------ tools ------------------------------ */

const TOOLS = [
  {
    name: 'list_profiles',
    description: '列出本机 FreePower 环境（默认 50 条）。返回 profile_id / name / group_id / 运行状态等。',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'number', description: '页码，从 1 开始' },
        limit: { type: 'number', description: '每页条数，最多 200' },
        name: { type: 'string', description: '按名字模糊过滤' },
        group_id: { type: 'string', description: '按分组过滤' },
      },
    },
  },
  {
    name: 'get_profile',
    description: '按 profile_id 查一个环境的完整配置（含指纹、代理、启动参数）。',
    inputSchema: {
      type: 'object',
      properties: { profile_id: { type: 'string', description: '环境 id' } },
      required: ['profile_id'],
    },
  },
  {
    name: 'start_profile',
    description: '启动一个环境，返回调试端口与 ws 地址。启动要十几秒，失败会返回具体原因。',
    inputSchema: {
      type: 'object',
      properties: { profile_id: { type: 'string', description: '环境 id' } },
      required: ['profile_id'],
    },
  },
  {
    name: 'stop_profile',
    description: '停止一个正在运行的环境。没在跑会返回错误（不会假装成功）。',
    inputSchema: {
      type: 'object',
      properties: { profile_id: { type: 'string', description: '环境 id' } },
      required: ['profile_id'],
    },
  },
  {
    name: 'create_profile',
    description: '新建环境。只给 name + group_id 时，时区/语言/UA 由后端按国家生成。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '环境名' },
        group_id: { type: 'string', description: '分组 id，默认 "0"' },
        country: { type: 'string', description: '两位国家码，如 US / JP' },
        remark: { type: 'string', description: '备注' },
        domain_name: { type: 'string', description: '目标域名（可选）' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_profile',
    description: '更新一个环境的配置（先停掉才能改）。传哪些字段改哪些。',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: '环境 id' },
        name: { type: 'string' },
        remark: { type: 'string' },
        timezone: { type: 'string', description: 'IANA 时区，如 Asia/Tokyo' },
        language: { type: 'array', items: { type: 'string' }, description: '语言列表，如 ["en-US"]' },
        ua: { type: 'string', description: '完整 User-Agent' },
      },
      required: ['profile_id'],
    },
  },
  {
    name: 'new_fingerprint',
    description: '给环境重新生成一套指纹（画布 / WebGL / 音频 / ClientRects 的种子一起换）。',
    inputSchema: {
      type: 'object',
      properties: { profile_id: { type: 'string', description: '环境 id' } },
      required: ['profile_id'],
    },
  },
  {
    name: 'list_proxies',
    description: '列出本机代理列表（含最近一次检测到的出口 IP 与国家）。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最多返回多少条，默认 100' } },
    },
  },
  {
    name: 'list_running',
    description: '列出当前正在运行的环境（本机）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'server_status',
    description: '本地 API 服务状态：是否在线、版本、端口。排查「MCP 连不上」时先用这个。',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function runTool(name, args = {}) {
  switch (name) {
    case 'list_profiles':
      return callApi('POST', '/api/v2/browser-profile/list', {
        page: args.page || 1,
        limit: args.limit || 50,
        ...(args.name ? { name: args.name } : {}),
        ...(args.group_id ? { group_id: args.group_id } : {}),
      });
    case 'get_profile':
      return callApi('GET', `/api/v2/browser-profile/detail?profile_id=${encodeURIComponent(args.profile_id)}`);
    case 'start_profile':
      return callApi('GET', `/api/v2/browser-profile/start?profile_id=${encodeURIComponent(args.profile_id)}`);
    case 'stop_profile':
      return callApi('GET', `/api/v2/browser-profile/stop?profile_id=${encodeURIComponent(args.profile_id)}`);
    case 'create_profile':
      return callApi('POST', '/api/v2/browser-profile/create', { group_id: '0', ...args });
    case 'update_profile': {
      const { profile_id: pid, ...rest } = args;
      return callApi('POST', '/api/v2/browser-profile/update', { profile_id: pid, ...rest });
    }
    case 'new_fingerprint':
      return callApi('POST', '/api/v2/browser-profile/new-fingerprint', { profile_id: [args.profile_id] });
    case 'list_proxies':
      return callApi('POST', '/api/v2/proxy-list/list', { limit: args.limit || 100 });
    case 'list_running':
      return callApi('GET', '/api/v2/browser-profile/local-active');
    case 'server_status':
      return { base: target.base, has_key: !!target.key, version: VERSION, api: await callApi('GET', '/status') };
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/* --------------------------- JSON-RPC over stdio --------------------------- */

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  // 通知（没有 id）不需要回应
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'freepower', version: VERSION },
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      if (!name) return replyError(id, -32602, 'params.name is required');
      try {
        const data = await runTool(name, params?.arguments || {});
        return reply(id, {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          isError: false,
        });
      } catch (e) {
        // 工具失败走 result.isError（协议这么定），不占 JSON-RPC 的 error 通道：
        // 客户端才能把「工具报错」和「协议坏了」分开处理。
        return reply(id, {
          content: [{ type: 'text', text: `调用失败：${e.message}` }],
          isError: true,
        });
      }
    }
    case 'resources/list':
      return reply(id, { resources: [] });
    case 'prompts/list':
      return reply(id, { prompts: [] });
    default:
      return replyError(id, -32601, `method not found: ${method}`);
  }
}

/** 串行处理：stdio 上消息必须按序回，并发处理会让响应乱序 */
let chain = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  chain = chain.then(async () => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return replyError(null, -32700, 'parse error');
    }
    try {
      await handle(msg);
    } catch (e) {
      replyError(msg?.id ?? null, -32603, e.message);
    }
  });
});
rl.on('close', () => { chain.then(() => process.exit(0)); });

// stderr 只用来排错，绝不往 stdout 打日志（stdout 是协议通道，混一行就废）
process.on('uncaughtException', (e) => {
  process.stderr.write(`[freepower-mcp] ${e.message}\n`);
  process.exit(1);
});
