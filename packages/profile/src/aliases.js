// v1 / v2 API 字段别名。两边走同一个 handler，只是参数名不同（拆解表 §0 实测）。
export const V1_TO_CANONICAL = {
  user_id: 'id',
  serial_number: 'profile_no',
  group_id: 'group_id',
  category_id: 'category_id',
  profile_tag_ids: 'profile_tag_ids',
  open_urls: 'open_urls',
  platform: 'domain_name', // v1 的 platform 是域名，不是 navigator.platform
  random_fingerprint: 'random_fingerprint',
};

export const V2_TO_CANONICAL = {
  profile_id: 'id',
  profile_no: 'profile_no',
  batch_id: 'group_id',
  sys_app_cate_id: 'category_id',
  fbcc_user_tag_ids: 'profile_tag_ids',
  openfb_urls: 'open_urls',
  switch_random_finger: 'random_fingerprint',
  domain_name: 'domain_name',
};

/** 内部字段名 → v2 对外名（响应体用） */
export const CANONICAL_TO_V2 = invert(V2_TO_CANONICAL);

function invert(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (out[v] === undefined) out[v] = k;
  return out;
}

/** 把 v1 或 v2 的请求体翻译成内部规范键 */
export function toCanonical(body, version = 'v2') {
  const map = version === 'v1' ? V1_TO_CANONICAL : V2_TO_CANONICAL;
  const out = {};
  for (const [k, v] of Object.entries(body ?? {})) out[map[k] ?? k] = v;
  return out;
}

/** 把内部记录翻译成 v2 响应形状 */
export function toV2(record) {
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    out[CANONICAL_TO_V2[k] ?? k] = v;
  }
  // v1 兼容字段也带上，方便老脚本
  out.user_id = record.id;
  out.serial_number = record.profile_no;
  out.group_id = record.group_id;
  return out;
}
