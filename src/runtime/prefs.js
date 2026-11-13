/**
 * 会话恢复（差距清单第 5 条）—— 启动前把 `<userdata>/Default/Preferences` 里的
 * `session.restore_on_startup` 写成 `1`（Chrome 的「继续浏览上次打开的网页」）。
 *
 * 对手是往自己的内核配置 `StaticConfig.RestoreLastSession = true` 塞（逆向 `03b` L236）；
 * 我们**没有内核改造能力**，走 Chrome 自己的设置项。这是**我们的实现、不是复刻**：
 * 语义相同（对用户强制开启），落点不同（一个在内核配置里，一个在 profile 的 Preferences 里）。
 *
 * 四条硬规矩（都是踩过坑才会想到的）：
 *   1. **读-改-写，不许整体覆盖**：`Preferences` 是 Chrome 自己的大 JSON（几十个顶层键），
 *      整份盖掉等于把用户的设置、扩展状态、实验开关全清掉。这里只碰
 *      `session.restore_on_startup`，其它键原样保留（连键顺序都不动）。
 *   2. **原子写**：先写 `Preferences.fp-tmp` 再 `rename`。崩在写一半，正式文件要么是旧版、
 *      要么是新版，不可能是半截 JSON。
 *   3. **坏文件先备份再写**：不是合法 JSON（或不是对象）时，先改名成
 *      `Preferences.corrupt-<时间戳>`，**不吞掉**用户的文件，再写新文件。
 *   4. **幂等**：已经是 1 就一个字节都不动（不写、不改 mtime）。只在内容真的需要变时才落盘。
 *
 * 为什么每次启动都写：这是「对用户强制开启」的语义（和对手强制内核配置一致）。
 * 用户若在 Chrome 里手动改回去，下次启动会被改回来 —— README 已写明。
 */
import fs from 'node:fs';
import path from 'node:path';

/** Chrome 的 `restore_on_startup` 取值：1 = 继续浏览上次打开的网页 */
export const RESTORE_ON_STARTUP = 1;

/** `<userdata>/Default/Preferences`（Chrome 的 profile 目录固定叫 `Default`） */
export function prefsPathOf(userDataDir) {
  return path.join(userDataDir, 'Default', 'Preferences');
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 合并：只把 `session.restore_on_startup` 设成 1，其它一律原样。
 * 抽成纯函数，A 层判据直接打它（不用碰盘）。
 *
 * @param {object} prefs 现有 Preferences（可以是 `{}`）
 * @returns {{prefs: object, changed: boolean}}
 */
export function mergeRestoreOnStartup(prefs) {
  const src = isPlainObject(prefs) ? prefs : {};
  const session = isPlainObject(src.session) ? src.session : {};
  if (session.restore_on_startup === RESTORE_ON_STARTUP) {
    // 已经对了：**返回原对象**（不改），调用方据此决定不写盘
    return { prefs: src, changed: false };
  }
  return {
    // 浅拷贝两层：`session` 换新对象，其它顶层键按引用带走（值没被改，不需要深拷贝）
    prefs: { ...src, session: { ...session, restore_on_startup: RESTORE_ON_STARTUP } },
    changed: true,
  };
}

/** 备份坏文件：`Preferences.corrupt-<时间戳>`（时间戳取本地时间、不含冒号，Windows 合法） */
function backupCorrupt(file, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('Z', '');
  const dst = `${file}.corrupt-${stamp}`;
  fs.renameSync(file, dst);
  return dst;
}

/**
 * 保证 `<userdata>/Default/Preferences` 的 `session.restore_on_startup === 1`。
 *
 * @param {string} userDataDir
 * @param {{log?: (msg: string) => void, now?: Date}} [opts]
 * @returns {{path: string, changed: boolean, backed_up: string|null, created: boolean}}
 *          `changed=false` 表示「本来就是 1，一个字节都没动」
 */
export function ensureRestoreOnStartup(userDataDir, { log = () => {}, now = new Date() } = {}) {
  const file = prefsPathOf(userDataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let raw = null;
  let backedUp = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }

  let prefs = {};
  let created = raw === null;
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed)) throw new Error('顶层不是对象');
      prefs = parsed;
    } catch (e) {
      // 坏文件：**先备份再写**，绝不静默吞掉用户的 Preferences
      backedUp = backupCorrupt(file, now);
      log(`Preferences 不是合法 JSON，已备份为 ${path.basename(backedUp)}（${e.message}）`);
      prefs = {};
      created = true;
    }
  }

  const { prefs: merged, changed } = mergeRestoreOnStartup(prefs);
  if (!changed && raw !== null) {
    return { path: file, changed: false, backed_up: backedUp, created: false };
  }

  const tmp = `${file}.fp-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(merged)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return { path: file, changed: true, backed_up: backedUp, created };
}
