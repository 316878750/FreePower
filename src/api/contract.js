/**
 * 本地 API 契约层：错误码、v1/v2 边界转换、响应封装。
 *
 * 错误码（对齐 AdsPower 公开的 6 个；含义按实测反推，标注为推测，见 docs/01-数据模型.md §9）：
 *   -1      通用失败
 *   100001  profile 不存在
 *   100002  参数非法
 *   800002  环境未在运行（stop 一个没启动的环境）
 *   800003  启动失败（内核缺失 / 进程起不来 / DevTools 端口超时）
 *   800005  启动前一致性校验不通过
 */
export const ERR = {
  GENERIC: -1,
  NOT_FOUND: 100001,
  INVALID: 100002,
  NOT_RUNNING: 800002,
  START_FAILED: 800003,
  CONSISTENCY: 800005,
};

export class ApiError extends Error {
  constructor(code, msg, httpStatus = 200, extra = {}) {
    super(msg);
    this.code = code;
    this.httpStatus = httpStatus;
    this.extra = extra;
  }
}

/** 成功响应：code 0 / msg success / data */
export function ok(data = null) {
  return { code: 0, msg: 'success', data };
}

/**
 * launch_args 边界转换：
 * v1 传 JSON 字符串（如 "[\"--foo\"]" 或 "--foo\n--bar"），v2 传数组；内部统一存数组。
 */
export function normalizeLaunchArgs(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const s = String(value).trim();
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      throw new ApiError(ERR.INVALID, 'launch_args must be a JSON array string');
    }
  }
  return s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

/** 出站：v1 返回 JSON 字符串，v2 返回数组 */
export function serializeLaunchArgs(args, version) {
  const arr = Array.isArray(args) ? args : [];
  return version === 'v1' ? JSON.stringify(arr) : arr;
}

/**
 * 密码填充开关：内部只留一个布尔（disable_password_filling）。
 * 边界同时接受 password_filling / disable_password_filling，任意写法都翻转到同一个内部值。
 */
export function normalizePasswordFilling(body = {}) {
  if (body.disable_password_filling !== undefined) {
    return String(body.disable_password_filling) === '1';
  }
  if (body.password_filling !== undefined) {
    return String(body.password_filling) !== '1';
  }
  return undefined;
}

/** 出站：v1/v2 各给一份，内部永远是同一个布尔 */
export function serializePasswordFilling(disabled) {
  if (disabled === undefined) return {};
  return { disable_password_filling: disabled ? '1' : '0', password_filling: disabled ? '0' : '1' };
}