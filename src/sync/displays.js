/**
 * 显示器信息：桌面壳写、服务进程读（两个进程之间的文件交接）。
 *
 * 为什么需要交接：显示器列表只有 Electron 的 `screen.getAllDisplays()` 拿得到，
 * 而窗口同步的逻辑跑在服务进程里（Local API 那一侧，没有 Electron）。
 * 和全局快捷键同一个理由、同一个做法（见 `src/sync/hotkey.js`）——
 * 不为一个查询就在服务里塞一个原生依赖。
 *
 * **为什么用 `workArea` 而不是 `bounds`**（CEO 明确要求，也确实是对的）：
 * `bounds` 是整块屏幕（含任务栏），拿它当原点排窗口会把窗口压到任务栏底下；
 * `workArea` 是扣掉任务栏/停靠栏之后的可用区，排出来的窗口才是完整可见的。
 *
 * 没有桌面壳（命令行跑 `node src/main.js`）时 `managed:false` —— 这不是错误，
 * 但排列会退化成「按原点 (0,0) 算」，并把这件事如实报给调用方（不假装知道多屏布局）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

const FILE = () => path.join(DATA_DIR, 'displays.json');

function readJson(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** 归一一条显示器记录：只保留我们真会用的字段，别把 Electron 的一大坨原样传下去。
 *  两种形状都认：Electron 原样（`workArea`）和已落盘过的（`work_area`）——
 *  读回来的是写下去的那份，不认就会读成 0×0（踩过）。 */
function normalizeDisplay(d, i) {
  const wa = d?.workArea || d?.work_area || {};
  const b = d?.bounds || wa;
  return {
    id: d?.id ?? i,
    label: String(d?.label || ''),
    primary: d?.primary === true,
    scale_factor: num(d?.scaleFactor, 1),
    // 可用区（扣掉任务栏）—— 排列**只用这个**
    work_area: {
      x: num(wa.x, 0),
      y: num(wa.y, 0),
      width: Math.max(0, num(wa.width, 0)),
      height: Math.max(0, num(wa.height, 0)),
    },
    // 整块屏幕（只用于界面上显示「这块屏多大」，排列不用）
    bounds: {
      x: num(b.x, 0),
      y: num(b.y, 0),
      width: Math.max(0, num(b.width, 0)),
      height: Math.max(0, num(b.height, 0)),
    },
  };
}

/**
 * 标记主屏（0.4.7.5）。
 *
 * Electron 的 `screen.getAllDisplays()` 返回的 Display **没有 `primary` 字段** ——
 * 主屏要拿 `screen.getPrimaryDisplay().id` 去比。老实现把 `d.primary === true` 原样透传，
 * 于是 `displays.json` 里两块屏 `primary` 全是 `false`，UI 永远不显示「内置屏幕」，
 * 不传 screenId 的排列也落不到主屏上（用户 2026-11-18 实测：主屏是 CU34G3X 3440×1440，
 * 却被排到了左边的 24G4 上）。
 *
 * 兜底：调用方没给主屏 id 时，按「Windows 主屏原点必为 (0,0)」认一块 ——
 * 这比「谁都没主屏」强，但也只在真的判不出来时才用。
 */
function markPrimary(list, primaryId) {
  if (!list.length) return list;
  if (primaryId !== undefined && primaryId !== null && primaryId !== '') {
    const key = String(primaryId);
    return list.map((d) => ({ ...d, primary: String(d.id) === key }));
  }
  if (list.some((d) => d.primary)) return list;
  const origin = list.find((d) => d.work_area.x === 0 && d.work_area.y === 0);
  if (!origin) return list;
  return list.map((d) => ({ ...d, primary: d === origin }));
}

/**
 * 桌面壳用：把 `screen.getAllDisplays()` 的结果写下来。
 * @param {Array} displays Electron 的 Display 数组
 * @param {{primaryId?: number|string}} [opt] `screen.getPrimaryDisplay().id`
 */
export function writeDisplays(displays, { primaryId } = {}) {
  const list = markPrimary((Array.isArray(displays) ? displays : []).map(normalizeDisplay), primaryId);
  return writeJson(FILE(), { managed: true, at: new Date().toISOString(), displays: list });
}

/** 服务进程用：读显示器列表（没有桌面壳就 managed:false + 空列表） */
export function readDisplays() {
  const raw = readJson(FILE());
  if (!raw) return { managed: false, updated_at: null, displays: [] };
  const displays = markPrimary((Array.isArray(raw.displays) ? raw.displays : []).map(normalizeDisplay));
  return { managed: raw.managed === true, updated_at: raw.at || null, displays };
}

/** 给排列用的屏幕形状：`[{id, workArea, primary}]`（arrange.js 只认这三个字段） */
export function screensForArrange() {
  const { displays } = readDisplays();
  return displays.map((d) => ({ id: d.id, primary: d.primary, workArea: d.work_area }));
}
