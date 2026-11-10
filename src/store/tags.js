/**
 * 标签（browser-tags）本地仓储。
 * AdsPower 的 4 条 tags 路由是云端透传，本地没有实现；这里按同样的入参形状自己写。
 */
import { getDb } from './db.js';

/** 对手的 8 个颜色枚举（见 07 号清单末尾） */
export const TAG_COLORS = ['darkBlue', 'blue', 'purple', 'red', 'yellow', 'orange', 'green', 'lightGreen'];

const MAX_NAME = 50;

function toApi(row) {
  if (!row) return null;
  return { id: String(row.id), name: row.name, color: row.color || null, created_at: row.created_at };
}

export function listTags({ ids = null, page = 1, limit = 50 } = {}) {
  const db = getDb();
  const where = [];
  const args = [];
  if (Array.isArray(ids) && ids.length) {
    where.push(`id IN (${ids.map(() => '?').join(',')})`);
    args.push(...ids.map(String));
  }
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM tags ${sqlWhere}`).get(...args).n;
  const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * size;
  const rows = db.prepare(`SELECT * FROM tags ${sqlWhere} ORDER BY created_at ASC LIMIT ? OFFSET ?`).all(...args, size, offset);
  return { list: rows.map(toApi), page: Number(page) || 1, limit: size, total };
}

/** 建标签：入参可能是单个对象，也可能是数组（对手两种都收） */
export function createTags(input) {
  const items = Array.isArray(input) ? input : [input];
  const db = getDb();
  const created = [];
  for (const t of items) {
    const name = String(t?.name ?? '').trim();
    if (!name) throw new Error('tag name is required');
    if (name.length > MAX_NAME) throw new Error(`tag name is longer than ${MAX_NAME}`);
    const color = t?.color ? String(t.color) : null;
    if (color && !TAG_COLORS.includes(color)) throw new Error(`tag color must be one of ${TAG_COLORS.join('/')}`);
    const id = 'tag_' + Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(8))).toString('hex');
    db.prepare('INSERT INTO tags (id, name, color, created_at) VALUES (?, ?, ?, ?)')
      .run(id, name, color, new Date().toISOString());
    created.push(toApi(db.prepare('SELECT * FROM tags WHERE id = ?').get(id)));
  }
  return created;
}

export function updateTags(input) {
  const items = Array.isArray(input) ? input : [input];
  const db = getDb();
  const updated = [];
  for (const t of items) {
    const id = String(t?.id ?? '');
    if (!id) throw new Error('tag id is required');
    const cur = db.prepare('SELECT * FROM tags WHERE id = ?').get(id);
    if (!cur) continue;
    const name = t.name !== undefined ? String(t.name).trim() : cur.name;
    if (!name) throw new Error('tag name is required');
    if (name.length > MAX_NAME) throw new Error(`tag name is longer than ${MAX_NAME}`);
    const color = t.color !== undefined ? (t.color ? String(t.color) : null) : cur.color;
    if (color && !TAG_COLORS.includes(color)) throw new Error(`tag color must be one of ${TAG_COLORS.join('/')}`);
    db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?').run(name, color, id);
    updated.push(toApi(db.prepare('SELECT * FROM tags WHERE id = ?').get(id)));
  }
  return updated;
}

export function deleteTags(ids = []) {
  const db = getDb();
  const deleted = [];
  for (const id of ids.map(String)) {
    if (db.prepare('DELETE FROM tags WHERE id = ?').run(id).changes) deleted.push(id);
  }
  // 环境上挂的 tag 一并摘掉（profile_tag_ids 是 JSON 数组字符串）
  if (deleted.length) {
    const rows = db.prepare('SELECT id, profile_tag_ids FROM profiles WHERE profile_tag_ids IS NOT NULL').all();
    for (const r of rows) {
      let arr = [];
      try { arr = JSON.parse(r.profile_tag_ids) || []; } catch { continue; }
      if (!Array.isArray(arr)) continue;
      const next = arr.filter((x) => !deleted.includes(String(x)));
      if (next.length !== arr.length) {
        db.prepare('UPDATE profiles SET profile_tag_ids = ? WHERE id = ?').run(JSON.stringify(next), r.id);
      }
    }
  }
  return deleted;
}

/** 环境当前挂的标签 id（读 profile_tag_ids，兼容 JSON 字符串 / 数组） */
export function tagIdsOf(profile) {
  const raw = profile?.profile_tag_ids;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string' && raw.trim()) {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p.map(String) : []; } catch { return []; }
  }
  return [];
}
