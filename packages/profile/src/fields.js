// FreePower · profile 字段注册表（由 tools/gen-schema.mjs 生成，勿手改）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(fs.readFileSync(path.join(here, 'fields.generated.json'), 'utf8'));

export const FIELDS = data.fields;
export const FIELD_META = data.meta;
export const BY_NAME = new Map(FIELDS.map((f) => [f.name, f]));

export const GROUPS = [...new Set(FIELDS.map((f) => f.group))];

/** 进 fingerprint_config 的键 */
export const FP_KEYS = FIELDS.filter((f) => f.storage === 'fp').map((f) => f.name);

export function coverageSummary() {
  const out = { full: [], partial: [], none: [], 'n/a': [] };
  for (const f of FIELDS) out[f.coverage].push(f.name);
  return out;
}
