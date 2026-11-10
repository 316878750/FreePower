/**
 * Web 控制台的静态托管。
 *
 * 只托管 web/ 这一个目录，只暴露 /（首页）和 /ui/*（资源）。
 * 设计上刻意很窄：没有目录列表、没有 dotfile、没有 user-data 这类动态目录，
 * 因为这套东西跑在用户本机上，静态层是最容易被写错的地方。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

export const WEB_DIR = path.join(ROOT, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 首页：把本地 api_key 与端口注入进去，页面不用再问用户要（本机控制台，同源） */
export function renderIndex({ apiKey, port, version }) {
  const file = path.join(WEB_DIR, 'index.html');
  let html = fs.readFileSync(file, 'utf8');
  const boot = JSON.stringify({ apiKey, port, version, apiBase: '' }).replace(/</g, '\\u003c');
  html = html.replace('/*__FP_BOOT__*/', `window.__FP__ = ${boot};`);
  return html;
}

/**
 * 解析 /ui/<rel> 到磁盘路径。
 * 用 resolve 后前缀比对，`..`、绝对路径、点开头的一律拒掉 —— 宁可 404 也不猜。
 */
export function resolveStatic(relPath) {
  const rel = String(relPath || '').replace(/^\/+/, '');
  if (!rel || rel.startsWith('.') || rel.includes('\0')) return null;
  const abs = path.resolve(WEB_DIR, rel);
  const base = path.resolve(WEB_DIR) + path.sep;
  if (!abs.startsWith(base)) return null;
  if (rel.split(/[\\/]/).some((seg) => seg.startsWith('.'))) return null;
  if (!MIME[path.extname(abs).toLowerCase()]) return null;
  let st;
  try { st = fs.statSync(abs); } catch { return null; }
  if (!st.isFile()) return null;
  return { abs, size: st.size, type: MIME[path.extname(abs).toLowerCase()] };
}

export function sendStatic(res, file, extraHeaders = {}) {
  res.writeHead(200, {
    'content-type': file.type,
    'content-length': file.size,
    // 控制台是本地开发的活页，别让浏览器拿旧 JS 骗自己
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  fs.createReadStream(file.abs).pipe(res);
}

/** 这个路径是不是该由静态层接手（不是 API） */
export function isStaticPath(pathname) {
  return pathname === '/' || pathname === '/index.html' || pathname.startsWith('/ui/');
}