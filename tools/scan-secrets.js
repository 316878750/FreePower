// tools/scan-secrets.js —— 按「结构特征」扫全目录，而不是按「已知真值」扫。
// 教训来源：2026-11-11 CEO 复核发现 03b/08 里还有真实出口 IP 和真实 MAC，
// 而我上一轮的扫描模式里根本没有那两个值，所以报了个假的 CLEAN。
//
// 用法：node tools/scan-secrets.js [根目录]
// 输出：所有「像真值」的候选，需人工判定（脚本不自动下结论）。
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || path.join(__dirname, '..');

// 文本扩展名白名单：宁多勿少
const TEXT_EXT = new Set([
  '.md', '.json', '.txt', '.js', '.mjs', '.cjs', '.ts', '.log', '.yml', '.yaml',
  '.html', '.htm', '.css', '.csv', '.xml', '.ini', '.cfg', '.conf', '.ps1', '.bat',
  '.sh', '.py', '.env', '.properties',
]);
// 目录/文件跳过
const SKIP_DIR = new Set(['node_modules', '.git', 'slices']);
const SKIP_FILE = /\.(min\.js|pretty\.js|bak|bin|node|dll|exe|asar|ico|png|jpg|zip)$/i;

// RFC 5737 / 私有 / 回环 / 保留：这些是允许出现的占位与内网
const IP_ALLOW = [
  /^127\./, /^0\./, /^10\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, /^255\./,
  /^203\.0\.113\./, /^192\.0\.2\./, /^198\.51\.100\./, /^233\.252\./, // TEST-NET 1/2/3 + 文档段
  /^8\.9\.\d+\.\d+$/,           // 版本号误报 8.9.23.0
];

const RE = {
  ipv4: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
  mac: /\b[0-9A-Fa-f]{2}([:-])[0-9A-Fa-f]{2}(?:\1[0-9A-Fa-f]{2}){4}\b/g,
  // 凭据类：password/account/token/secret 后跟一个非占位值
  cred: /["']?(password|passwd|pwd|account|user_name|username|token|secret|api_?key)["']?\s*[:=]\s*["']([^"']{3,80})["']/gi,
  // 疑似密钥：长随机串
  keyish: /\b(AIza[0-9A-Za-z_\-]{30,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g,
};

const findings = [];

function walk(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      walk(p);
    } else {
      if (SKIP_FILE.test(e.name)) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!TEXT_EXT.has(ext)) continue;
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.size > 8 * 1024 * 1024) continue; // 大 bundle 跳过，单独处理
      let text; try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      scan(p, text);
    }
  }
}

function scan(file, text) {
  const rel = path.relative(ROOT, file);
  const lines = text.split(/\r?\n/);

  lines.forEach((line, i) => {
    const ln = i + 1;

    for (const m of line.matchAll(RE.ipv4)) {
      const ip = m[0];
      if (IP_ALLOW.some(r => r.test(ip))) continue;
      findings.push({ kind: 'IPv4', file: rel, line: ln, value: ip, snippet: line.trim().slice(0, 120) });
    }
    for (const m of line.matchAll(RE.mac)) {
      findings.push({ kind: 'MAC', file: rel, line: ln, value: m[0], snippet: line.trim().slice(0, 120) });
    }
    for (const m of line.matchAll(RE.cred)) {
      const v = m[2];
      if (/^(<.*>|redacted|null|undefined|true|false|\d+|""|'')$/i.test(v)) continue;
      if (/^(no_proxy|proxy|http|socks5|other|none|default)$/i.test(v)) continue;
      findings.push({ kind: 'CRED:' + m[1], file: rel, line: ln, value: v, snippet: line.trim().slice(0, 120) });
    }
    for (const m of line.matchAll(RE.keyish)) {
      findings.push({ kind: 'KEYISH', file: rel, line: ln, value: m[0].slice(0, 24) + '…', snippet: line.trim().slice(0, 120) });
    }
  });
}

walk(ROOT);

const groups = {};
for (const f of findings) {
  const k = f.file + ':' + f.line;
  (groups[k] = groups[k] || []).push(f);
}

console.log('扫描根目录: ' + ROOT);
console.log('命中 ' + findings.length + ' 处，涉及 ' + Object.keys(groups).length + ' 行\n');

const byFile = {};
for (const f of findings) (byFile[f.file] = byFile[f.file] || []).push(f);
for (const [file, list] of Object.entries(byFile).sort()) {
  console.log('--- ' + file + ' (' + list.length + ') ---');
  for (const f of list) {
    console.log(`  L${f.line}  [${f.kind}]  ${f.value}`);
    console.log(`         ${f.snippet}`);
  }
}
if (!findings.length) console.log('CLEAN — 未发现疑似真值');