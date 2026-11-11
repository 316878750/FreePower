/**
 * 本地 API 路由表。
 *
 * 分三类（对齐拆解手 07 号清单）：
 *   A 类「本地组装」：数据是我们自己拼的，形状照抄对手 —— /status、browser/start|stop|active|
 *        local-active|cloud-active、browser-profile/cookies|kernels|list。
 *   B 类「本地自己实现」：对手是云端透传，本地没有可抄逻辑，按同样的入参形状自己写 ——
 *        环境 CRUD、分组、标签、代理列表。
 *   其余：**明确报「不支持」，不假成功**，错误码用已知的 -1，脚本不会拿到未知码。
 *
 * FreePower 扩展（对手没有）：batch-start / batch-stop / selfcheck / detail / proxy-check。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  createProfile, getProfile, getProfileByNo, listProfiles, updateProfile, deleteProfiles, regroupProfiles,
  newFingerprintFor, listGroups, createGroup, getGroup, updateGroup, deleteGroup, cookieText, cookieToStorage,
} from '../store/profiles.js';
import { listTags, createTags, updateTags, deleteTags, tagIdsOf } from '../store/tags.js';
import {
  createProxies, updateProxy, listProxies, deleteProxies, rememberProxyCheck, getProxy,
} from '../store/proxies.js';
import { startProfile, stopProfile, listRunning, getRunning, getInstance, userDataDirFor } from '../runtime/manager.js';
import { batchStart, batchStop } from '../runtime/batch.js';
import { PROFILES_DIR } from '../config.js';
import { profileFormSchema } from './schema.js';
import { validateProfile } from '../../packages/profile/src/validate.js';
import { checkProxy, hasProxy } from '../proxy/probe.js';
import { checkMany, HEALTH_CONCURRENCY, HEALTH_TIMEOUT_MS } from '../proxy/health.js';
import { pacInUse, pacMessage } from '../proxy/pac.js';
import { runSelfCheck } from '../selfcheck/index.js';
import { readReportFile, summarize } from '../selfcheck/store.js';
import { renderHtml } from '../selfcheck/html.js';
import { issueTicket } from './tickets.js';
import { listKernels } from '../kernel/chrome.js';
import { toCanonical, toV2 } from '../../packages/profile/src/aliases.js';
import {
  ApiError, ERR, ok, unsupported, normalizeLaunchArgs, serializeLaunchArgs, normalizePasswordFilling, serializePasswordFilling,
} from './contract.js';

/* ------------------------------ 形状转换 ------------------------------ */

/** 内部记录 → 对外（v1 补 user_id/serial_number，v2 用 profile_id/profile_no） */
export function present(profile, version) {
  if (!profile) return null;
  const base = version === 'v2' ? toV2(profile) : { ...profile, user_id: profile.id, serial_number: profile.profile_no };
  if (profile.launch_args !== undefined) base.launch_args = serializeLaunchArgs(profile.launch_args, version);
  Object.assign(base, serializePasswordFilling(profile.disable_password_filling === '1'));
  // 标签两种命名都带上（v2 的 create 用 profile_tag_ids，老脚本用 fbcc_user_tag_ids）
  const tags = tagIdsOf(profile);
  base.profile_tag_ids = tags;
  base.fbcc_user_tag_ids = tags;
  return base;
}

/** 入站：v1/v2 参数名 → 内部键，并处理边界类型 */
function input(body = {}, version) {
  const canonical = toCanonical(body, version);
  if (body.launch_args !== undefined || body.browser_run_args !== undefined) {
    canonical.launch_args = normalizeLaunchArgs(body.launch_args ?? body.browser_run_args);
  }
  const pf = normalizePasswordFilling(body);
  if (pf !== undefined) canonical.disable_password_filling = pf ? '1' : '0';
  // v1 的 platform 是域名（toCanonical 已映到 domain_name），别覆盖 navigator.platform
  if (version === 'v1') delete canonical.platform;
  // PAC 明确拒绝：不静默忽略、不退化成直连（报错发生在落库之前）
  const pac = pacInUse({ ...canonical, proxy_config: body.proxy_config || body.user_proxy_config || canonical.user_proxy_config });
  if (pac) throw new ApiError(ERR.INVALID, pacMessage(pac));
  // 空 cookie 等于「没有 cookie」：它是 JSON 数组串字段，空串/ null 过不了校验，
  // 但控制台里每个环境都会带一个空 cookie 回传，不摘掉就永远存不上。
  if (canonical.cookie === null) delete canonical.cookie;
  else if (canonical.cookie !== undefined && String(canonical.cookie).trim() === '') delete canonical.cookie;
  return canonical;
}

/* ------------------------------ 目标解析 ------------------------------ */

const pick = (obj, keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
};

/**
 * 解析「要操作哪个环境」：v1 → user_id / serial_number，v2 → profile_id / profile_no，
 * 两套都接受（脚本迁移时经常混着写）。找不到统一报 100001 `Profile does not exist`。
 */
function resolveProfile(ctx, version) {
  const src = { ...ctx.query, ...ctx.body };
  const id = version === 'v1'
    ? pick(src, ['user_id', 'profile_id'])
    : pick(src, ['profile_id', 'user_id']);
  if (id) {
    const p = getProfile(String(id));
    if (!p) throw new ApiError(ERR.NOT_FOUND, 'Profile does not exist');
    return p;
  }
  const no = pick(src, ['serial_number', 'profile_no']);
  if (no !== null) {
    const p = getProfileByNo(no);
    if (!p) throw new ApiError(ERR.NOT_FOUND, 'Profile does not exist');
    return p;
  }
  throw new ApiError(ERR.INVALID, version === 'v1' ? 'Require user_id or serial_number' : 'Require profile_id or profile_no');
}

/** 多个 id（数组或逗号串），给 batch / 批量删用 */
function idList(raw, version) {
  if (raw === undefined || raw === null || raw === '') return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

/* ------------------------------ 路由表 ------------------------------ */

export function buildRoutes() {
  const routes = [];
  const add = (methods, paths, handler, opts = {}) => {
    for (const p of paths) {
      routes.push({ methods: methods.map((m) => m.toUpperCase()), path: p, handler, ...opts });
    }
  };
  const both = (nameV1, nameV2) => [`/api/v1/${nameV1}`, `/api/v2/${nameV2}`];
  const versionOf = (p) => (p.startsWith('/api/v2/') ? 'v2' : 'v1');
  const notImplemented = (path) => () => { throw unsupported(path); };

  add(['GET'], ['/status'], () => ({ code: 0, msg: 'success' }), { auth: false });

  /* ============================ 1. A 类 8 条 ============================ */

  add(['GET'], both('browser/start', 'browser-profile/start'), (ctx) => startHandler(ctx, versionOf(ctx.path)));

  add(['GET', 'POST'], both('browser/stop', 'browser-profile/stop'), async (ctx) => {
    const v = versionOf(ctx.path);
    const p = resolveProfile(ctx, v);
    const r = await stopProfile(p.id);
    if (!r.stopped) throw new ApiError(ERR.NOT_RUNNING, 'profile is not running');
    // 对手这条没有 data：null 时整个 key 不出现
    return ok(null);
  });

  /**
   * restart：stop → apply 变更 → start，一个请求内完成。
   *
   * 为什么不做「运行中热改注入参数」：CDP override 能热改，但注入脚本已经在页面里跑过一轮，
   * 热改只会让主帧与 worker 出现两套值 —— 那正是我们自己的双 Realm 漏洞。宁可重启。
   *
   * fail-closed：apply 失败就不启动；start 失败则保持 stopped，绝不留一个「还在跑旧配置」的内核。
   */
  add(['POST'], both('browser/restart', 'browser-profile/restart'), (ctx) => restartHandler(ctx, versionOf(ctx.path)));

  add(['GET'], both('browser/active', 'browser-profile/active'), (ctx) => {
    const v = versionOf(ctx.path);
    const p = resolveProfile(ctx, v);
    const live = getRunning(p.id);
    if (!live) return ok({ status: 'Inactive' });
    // 注意顺序：内部实例的 status 是 running/idle，这里必须被契约值 Active 覆盖
    return ok({ ...live, status: 'Active' });
  });

  add(['GET'], both('browser/local-active', 'browser-profile/local-active'), () => {
    const list = listRunning().map((i) => ({ ...i, status: 'Active' }));
    return ok({ list });
  });

  /**
   * cloud-active：对手是「查云端哪些环境开着」，我们没有云。
   * 必须明确报错 —— 返回成功会让脚本以为环境已经开了。
   */
  add(['POST'], both('browser/cloud-active', 'browser-profile/cloud-active'), (ctx) => {
    const raw = ctx.body.user_ids ?? ctx.body.profile_ids;
    if (raw === undefined || raw === null || raw === '') throw new ApiError(ERR.INVALID, 'Require user_ids');
    const ids = idList(raw, 'v1');
    if (ids.length > 100) throw new ApiError(ERR.INVALID, 'user_ids cannot exceed 100');
    throw new ApiError(
      ERR.GENERIC,
      'FreePower 不支持 cloud-active：该接口查的是 AdsPower 云端账号下的环境状态，FreePower 是纯本地产品，没有云端环境列表。本机已开环境请用 /api/v1/browser/local-active',
      200,
      { supported: false, reason: 'cloud_unavailable', local_alternative: '/api/v1/browser/local-active' },
    );
  });

  add(['GET'], ['/api/v2/browser-profile/cookies'], (ctx) => {
    const p = resolveProfile(ctx, 'v2');
    return ok({ cookies: cookieText(p.cookie) });
  });

  add(['GET'], ['/api/v2/browser-profile/kernels'], (ctx) => {
    const t = String(ctx.query.kernel_type || 'chrome').toLowerCase();
    if (t !== 'chrome' && t !== 'firefox') throw new ApiError(ERR.INVALID, 'Kernel type must be Chrome or Firefox.');
    const list = listKernels({ type: t });
    return ok({ list });
  });

  /* ---- list：v1 GET user/list，v2 POST browser-profile/list（limit 不传只回 1 条） ---- */
  const listHandler = (ctx) => {
    const v = versionOf(ctx.path);
    const src = { ...ctx.query, ...ctx.body };
    const limitRaw = v === 'v2'
      ? pick(src, ['limit'])
      : pick(src, ['page_size', 'limit']);
    // v2 的坑：limit 不传只回 1 条（对手如此，照抄）
    const size = limitRaw === null ? (v === 'v2' ? 1 : 50) : Number(limitRaw);
    if (v === 'v2' && size > 200) throw new ApiError(ERR.INVALID, 'limit must be less than 200');
    const ids = idList(src.profile_id ?? src.user_id, v);
    const nos = idList(src.profile_no ?? src.serial_number, v);
    const r = listProfiles({
      page: src.page,
      page_size: size,
      group_id: src.group_id ?? src.batch_id,
      name: src.name ?? src.name_filter,
      ids: ids.length ? ids : null,
      profile_nos: nos.length ? nos : null,
      tag_ids: idList(src.tag_ids ?? src.profile_tag_ids, v),
      sort_field: src.sort_type ?? src.user_sort,
      sort_order: src.sort_order,
    });
    const body = { list: r.list.map((p) => present(p, v)), page: r.page, total: r.total };
    if (v === 'v2') body.limit = r.page_size;
    else body.page_size = r.page_size;
    return ok(body);
  };
  add(['GET'], ['/api/v1/user/list'], listHandler);
  add(['POST', 'GET'], ['/api/v2/browser-profile/list'], listHandler);
  add(['GET'], ['/api/v1/fbbird/user/list'], listHandler);

  /* ============================ 2. 本地 CRUD ============================ */

  add(['GET'], ['/api/v1/user/detail', '/api/v2/browser-profile/detail'], (ctx) => {
    const v = versionOf(ctx.path);
    return ok(present(resolveProfile(ctx, v), v));
  });

  add(['POST'], both('user/create', 'browser-profile/create'), (ctx) => {
    const v = versionOf(ctx.path);
    const body = input(ctx.body, v);
    if (v === 'v1' && body.group_id === undefined) body.group_id = '0';
    const p = createProfile(body);
    return ok(present(p, v));
  });

  add(['POST'], both('user/update', 'browser-profile/update'), (ctx) => {
    const v = versionOf(ctx.path);
    const cur = resolveProfile(ctx, v);
    if (getRunning(cur.id)) throw new ApiError(ERR.GENERIC, 'profile is running, stop it before update');
    const p = updateProfile(cur.id, input(ctx.body, v));
    return ok(present(p, v));
  });

  add(['POST'], both('user/delete', 'browser-profile/delete'), async (ctx) => {
    const v = versionOf(ctx.path);
    const raw = ctx.body.user_ids ?? ctx.body.profile_ids ?? ctx.body.profile_id;
    if (raw === undefined || raw === null) {
      throw new ApiError(ERR.INVALID, v === 'v2' ? 'profile_id is required' : 'user_ids is required');
    }
    if (v === 'v2' && !Array.isArray(raw)) throw new ApiError(ERR.INVALID, 'profile_id must be an array');
    if (v === 'v1' && !Array.isArray(raw)) throw new ApiError(ERR.INVALID, '[user_ids] Incorrect format');
    const ids = idList(raw, v);
    // 先停再删：留着运行中的内核被删了记录，就是孤儿进程，谁也回收不了
    for (const id of ids) if (getRunning(id)) await stopProfile(id);
    const dirs = [];
    for (const id of ids) {
      const p = getProfile(id);
      if (p) dirs.push(removeProfileDataDir(p));
    }
    const deleted = deleteProfiles(ids);
    return ok({ deleted, userdata_removed: dirs.filter(Boolean).length });
  });

  add(['POST'], ['/api/v1/user/regroup', '/api/v2/browser-profile/regroup'], (ctx) => {
    const raw = ctx.body.user_ids ?? ctx.body.profile_ids;
    if (!raw) throw new ApiError(ERR.INVALID, 'user_ids is required');
    if (!Array.isArray(raw)) throw new ApiError(ERR.INVALID, '[user_ids] Incorrect format');
    const groupId = ctx.body.group_id ?? ctx.body.batch_id;
    if (groupId === undefined || groupId === null || groupId === '') throw new ApiError(ERR.INVALID, 'group_id is required');
    return ok({ changed: regroupProfiles(raw, groupId) });
  });

  add(['POST'], both('user/new-fingerprint', 'browser-profile/new-fingerprint'), (ctx) => {
    const v = versionOf(ctx.path);
    const raw = ctx.body.profile_id ?? ctx.body.user_ids ?? ctx.body.profile_no ?? ctx.body.user_id;
    const ids = idList(raw, v);
    if (!ids.length) throw new ApiError(ERR.INVALID, 'Require profile_id or profile_no');
    if (ids.length > 10) throw new ApiError(ERR.INVALID, 'Up to 10 profiles are supported per request.');
    const out = [];
    for (const id of ids) {
      const p = getProfile(id) || getProfileByNo(id);
      if (!p) throw new ApiError(ERR.NOT_FOUND, 'Profile does not exist');
      out.push(present(newFingerprintFor(p.id), v));
    }
    return ok(out.length === 1 ? out[0] : { list: out });
  });

  /* ---- 分组 ---- */
  add(['GET'], ['/api/v1/group/list', '/api/v2/group/list'], () => ok({ list: listGroups() }));
  add(['POST'], ['/api/v1/group/create', '/api/v2/group/create'], (ctx) => {
    const name = ctx.body.group_name;
    if (!name) throw new ApiError(ERR.INVALID, 'group_name is required');
    return ok(createGroup(String(name)));
  });
  add(['POST'], ['/api/v1/group/update', '/api/v2/group/update'], (ctx) => {
    const groupId = ctx.body.group_id ?? ctx.body.id;
    if (groupId === undefined || groupId === null || groupId === '') throw new ApiError(ERR.INVALID, 'group_id is required');
    const name = ctx.body.group_name;
    if (!name && ctx.body.name === undefined) throw new ApiError(ERR.INVALID, 'group_name is required');
    const r = updateGroup({ group_id: groupId, group_name: name ?? ctx.body.name, remark: ctx.body.remark });
    if (!r) throw new ApiError(ERR.NOT_FOUND, 'group not found');
    return ok(r);
  });
  add(['POST'], ['/api/v1/group/delete', '/api/v2/group/delete'], (ctx) => {
    const groupId = ctx.body.group_id ?? ctx.body.id;
    if (groupId === undefined || groupId === null || groupId === '') throw new ApiError(ERR.INVALID, 'group_id is required');
    const r = deleteGroup(groupId);
    if (!r.ok) {
      if (r.reason === 'not_found') throw new ApiError(ERR.NOT_FOUND, 'group not found');
      throw new ApiError(ERR.INVALID, 'default group cannot be deleted');
    }
    return ok(r);
  });

  /* ---- 标签 ---- */
  add(['POST'], ['/api/v2/browser-tags/list', '/api/v1/browser-tags/list'], (ctx) => {
    const r = listTags({ ids: idList(ctx.body.ids, 'v2'), page: ctx.body.page, limit: ctx.body.limit });
    return ok({ list: r.list, page: r.page, limit: r.limit, total: r.total });
  });
  add(['POST'], ['/api/v2/browser-tags/create', '/api/v1/browser-tags/create'], (ctx) => {
    if (ctx.body.tags === undefined) throw new ApiError(ERR.INVALID, 'failed');
    try {
      const created = createTags(ctx.body.tags);
      return ok({ list: created });
    } catch (e) {
      throw new ApiError(ERR.GENERIC, 'failed');
    }
  });
  add(['POST'], ['/api/v2/browser-tags/update', '/api/v1/browser-tags/update'], (ctx) => {
    if (ctx.body.tags === undefined) throw new ApiError(ERR.INVALID, 'failed');
    try {
      return ok({ list: updateTags(ctx.body.tags) });
    } catch (e) {
      throw new ApiError(ERR.GENERIC, 'failed');
    }
  });
  add(['POST'], ['/api/v2/browser-tags/delete', '/api/v1/browser-tags/delete'], (ctx) => {
    const ids = idList(ctx.body.ids, 'v2');
    if (!ids.length) throw new ApiError(ERR.INVALID, 'failed');
    try {
      return ok({ deleted: deleteTags(ids) });
    } catch {
      throw new ApiError(ERR.GENERIC, 'failed');
    }
  });

  /* ---- 代理列表 ---- */
  add(['POST'], ['/api/v2/proxy-list/create', '/api/v1/proxy-list/create'], (ctx) => {
    // 对手这条的 body 是**顶层数组**
    const body = Array.isArray(ctx.body) ? ctx.body : ctx.body?.list;
    try {
      return ok(createProxies(body));
    } catch (e) {
      throw new ApiError(ERR.INVALID, e.message);
    }
  });
  add(['POST'], ['/api/v2/proxy-list/update', '/api/v1/proxy-list/update'], (ctx) => {
    try {
      const r = updateProxy(ctx.body);
      if (!r) throw new ApiError(ERR.NOT_FOUND, 'proxy not found');
      return ok(r);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(ERR.INVALID, e.message);
    }
  });
  add(['POST'], ['/api/v2/proxy-list/list', '/api/v1/proxy-list/list'], (ctx) => {
    try {
      const r = listProxies({ ids: idList(ctx.body.proxy_id, 'v2'), page: ctx.body.page, limit: ctx.body.limit });
      return ok({ list: r.list, page: r.page, limit: r.limit, total: r.total });
    } catch (e) {
      throw new ApiError(ERR.INVALID, e.message);
    }
  });
  add(['POST'], ['/api/v2/proxy-list/delete', '/api/v1/proxy-list/delete'], (ctx) => {
    try {
      return ok({ deleted: deleteProxies(idList(ctx.body.proxy_id, 'v2')) });
    } catch (e) {
      throw new ApiError(ERR.INVALID, e.message);
    }
  });

  /* ======================== 3. 批量启停 + 全停 ======================== */

  add(['POST'], both('browser/batch-start', 'browser-profile/batch-start'), async (ctx) => {
    const v = versionOf(ctx.path);
    const ids = idList(ctx.body.profile_ids ?? ctx.body.user_ids ?? ctx.body.profile_id ?? ctx.body.user_id, v);
    if (!ids.length) throw new ApiError(ERR.INVALID, v === 'v2' ? 'profile_ids is required' : 'user_ids is required');
    const r = await batchStart(ids, {
      concurrency: ctx.body.concurrency,
      force: ['1', 'true', 'yes'].includes(String(ctx.body.force ?? '').toLowerCase()),
      stopOnError: ctx.body.stop_on_error === undefined ? true : String(ctx.body.stop_on_error) !== '0',
    });
    return ok(r);
  });

  add(['POST'], both('browser/batch-stop', 'browser-profile/batch-stop'), async (ctx) => {
    const v = versionOf(ctx.path);
    const ids = idList(ctx.body.profile_ids ?? ctx.body.user_ids ?? ctx.body.profile_id ?? ctx.body.user_id, v);
    if (!ids.length) throw new ApiError(ERR.INVALID, v === 'v2' ? 'profile_ids is required' : 'user_ids is required');
    return ok(await batchStop(ids, { concurrency: ctx.body.concurrency }));
  });

  add(['POST'], ['/api/v2/browser-profile/stop-all', '/api/v1/browser/stop-all'], async (ctx) => {
    const ids = listRunning().map((i) => i.profile_id);
    const r = await batchStop(ids, { concurrency: ctx.body?.concurrency });
    return ok(r);
  });

  /* ============================ 4. 其余本地能力 ============================ */

  /**
   * 编辑表单的 schema：分组 / 类型 / 值域 / 必填 / 默认值，全部来自 packages/profile 注册表。
   * 控制台按它渲染表单，值域和必填就不再有两份。
   */
  add(['GET'], ['/api/v2/browser-profile/schema', '/api/v1/user/schema'], () => {
    const s = profileFormSchema();
    return ok({ total: s.total, groups: s.groups });
  });

  /**
   * 只校验不落库：控制台边填边调这个，文案与 create/update 完全同源（同一个 validateProfile）。
   * 顺带也是脚本的自查工具 —— 想知道「这组参数会不会被拒」，不用真的建一个环境再删。
   */
  add(['POST'], ['/api/v2/browser-profile/validate', '/api/v1/user/validate'], (ctx) => {
    const v = versionOf(ctx.path);
    const src = ctx.body.profile || ctx.body;
    const mode = String(ctx.body.mode || 'create') === 'update' ? 'update' : 'create';
    const canonical = toCanonical(src, v);
    if (v === 'v1') delete canonical.platform;
    // 边界表示要和 create/update 完全一致，否则校验会对着「另一种形状」报错：
    //   launch_args 对外是数组、落库是 JSON 字符串；cookie 对外是原始串、落库是 JSON 数组串。
    if (canonical.launch_args !== undefined) canonical.launch_args = JSON.stringify(normalizeLaunchArgs(canonical.launch_args));
    if (canonical.cookie !== undefined) {
      if (canonical.cookie === null || String(canonical.cookie).trim() === '') delete canonical.cookie;
      else canonical.cookie = cookieToStorage(canonical.cookie);
    }
    const r = validateProfile(canonical, { mode, fillDefaults: false });
    return ok({ ok: r.ok, mode, errors: r.errors, warnings: r.warnings });
  });

  add(['GET', 'POST'], ['/api/v1/browser/selfcheck', '/api/v2/browser-profile/selfcheck'], async (ctx) => {
    const v = versionOf(ctx.path);
    const p = resolveProfile(ctx, v);
    const inst = getInstance(p.id);
    let report = null;
    let fresh = false;
    if (inst && inst.selfcheckReport) { report = inst.selfcheckReport; fresh = true; }
    if (!report) report = readReportFile(p.id).latest;
    const rerun = ['1', 'true', 'yes'].includes(String(ctx.query.rerun ?? ctx.body.rerun ?? '').toLowerCase());
    if (rerun) {
      if (!inst) throw new ApiError(ERR.NOT_RUNNING, 'profile is not running');
      report = await runSelfCheck(inst, p);
      inst.selfcheck = summarize(report);
      fresh = true;
    }
    if (!report) throw new ApiError(ERR.NOT_RUNNING, 'profile is not running and no selfcheck report yet');
    const out = { ...report, running: !!inst, stale: !fresh };
    if (String(ctx.query.format).toLowerCase() === 'html') return { __html: renderHtml(out) };
    return ok(out);
  }, { ticket: true });

  /**
   * 自检 HTML 报告的一次性票据。
   * 报告是给浏览器直接打开的页面，不能把 master api_key 拼进 URL（会进浏览器历史/日志）。
   * 票据 120 秒、绑 profile_id、只在内存里；主 key 的路径照旧可用，老脚本不受影响。
   */
  add(['POST'], ['/api/v2/browser-profile/selfcheck-ticket'], (ctx) => {
    const p = resolveProfile(ctx, 'v2');
    const t = issueTicket(p.id);
    return ok({
      ...t,
      url: `/api/v2/browser-profile/selfcheck?profile_id=${encodeURIComponent(p.id)}&format=html&ticket=${encodeURIComponent(t.ticket)}`,
    });
  });

  /**
   * 列表页要显示「自检状态」，但自检报告是落盘文件，不在 profiles 表里。
   * 让列表页为每行单独调一次 selfcheck 会打出几十个请求，所以这里批量取摘要。
   * 返回的是**上次**报告（stale:true），运行中且刚跑过则是新的。
   */
  add(['POST'], ['/api/v2/browser-profile/selfcheck-summary'], (ctx) => {
    const ids = idList(ctx.body.profile_ids ?? ctx.body.profile_id, 'v2');
    if (!ids.length) throw new ApiError(ERR.INVALID, 'profile_ids is required');
    const list = {};
    for (const id of ids.slice(0, 200)) {
      const inst = getInstance(id);
      if (inst && inst.selfcheckReport) { list[id] = summarize(inst.selfcheckReport); continue; }
      const rep = readReportFile(id).latest;
      list[id] = rep ? { ...summarize(rep), stale: true } : null;
    }
    return ok({ list });
  });

  add(['POST'], ['/api/v2/browser-profile/ua', '/api/v1/browser-profile/ua'], (ctx) => {
    const v = versionOf(ctx.path);
    const ids = idList(ctx.body.profile_id ?? ctx.body.profile_no ?? ctx.body.user_ids, v);
    if (!ids.length) throw new ApiError(ERR.INVALID, 'Require profile_id or profile_no');
    if (ids.length > 10) throw new ApiError(ERR.INVALID, 'Up to 10 profiles are supported per request.');
    const list = [];
    for (const id of ids) {
      const p = getProfile(id) || getProfileByNo(id);
      if (!p) throw new ApiError(ERR.NOT_FOUND, 'Profile does not exist');
      list.push({ profile_id: p.id, ua: p.ua });
    }
    return ok({ list });
  });

  /* 清缓存：本地操作，不依赖云端 */
  add(['POST'], both('user/delete-cache', 'browser-profile/delete-cache'), async (ctx) => {
    const v = versionOf(ctx.path);
    const raw = ctx.body.profile_id ?? ctx.body.user_ids;
    const ids = idList(raw, v);
    const types = idList(ctx.body.type, v);
    if (!ids.length) throw new ApiError(ERR.INVALID, 'Require profile_id or profile_no');
    if (!types.length) throw new ApiError(ERR.INVALID, 'type must be an array');
    const cleared = [];
    for (const id of ids) {
      const p = getProfile(id) || getProfileByNo(id);
      if (!p) throw new ApiError(ERR.NOT_FOUND, 'Profile does not exist');
      if (getRunning(p.id)) throw new ApiError(ERR.GENERIC, 'profile is running, stop it before delete-cache');
      cleared.push({ profile_id: p.id, removed: clearCache(p, types) });
    }
    return ok({ list: cleared });
  });

  /* ---- 代理预检（FreePower 扩展，先验再绑） ---- */
  add(['POST'], ['/api/v1/proxy/check', '/api/v2/proxy/check'], async (ctx) => {
    const cfg = ctx.body.proxy_config || ctx.body;
    if (!hasProxy(cfg)) throw new ApiError(ERR.INVALID, 'host / port is required');
    const r = await checkProxy(cfg);
    const proxyId = ctx.body.proxy_id || (ctx.body.proxy_config || {}).proxy_id;
    if (proxyId && r && r.ok) rememberProxyCheck(proxyId, r);
    return ok(r);
  });

  /* ---- 代理批量健康检查（限并发 3、单条 10s；成功才落「最近预检」缓存） ---- */
  add(['POST'], ['/api/v1/proxy/check-batch', '/api/v2/proxy/check-batch'], async (ctx) => {
    const v = versionOf(ctx.path);
    const ids = idList(ctx.body.proxy_ids ?? ctx.body.proxy_id, v);
    if (!ids.length) throw new ApiError(ERR.INVALID, v === 'v2' ? 'proxy_id is required' : 'proxy_ids is required');
    if (ids.length > 100) throw new ApiError(ERR.INVALID, 'proxy_ids length must be less than 100');

    // 只检查库里存在的代理；不存在的单独报「代理不存在」，别让一条脏 id 把整批打挂
    const valid = [];
    for (let i = 0; i < ids.length; i++) {
      const p = getProxy(ids[i]);
      if (!p) continue;
      valid.push({
        index: i,
        proxy_id: p.proxy_id,
        proxy: { proxy_type: p.type, host: p.host, port: p.port, username: p.user, password: p.password },
      });
    }
    const batch = await checkMany(valid.map((x) => ({ proxy_id: x.proxy_id, proxy: x.proxy })));

    const list = new Array(ids.length);
    valid.forEach((x, k) => {
      const r = batch.list[k] || {};
      list[x.index] = { ...r, proxy_id: x.proxy_id };
      if (r.ok) rememberProxyCheck(x.proxy_id, r);
    });
    const stamp = new Date().toISOString();
    for (let i = 0; i < ids.length; i++) {
      if (list[i]) continue;
      list[i] = {
        index: i, proxy_id: ids[i], ok: false, error_kind: 'not_found',
        error_label: '代理不存在', error: 'proxy not found', latency_ms: 0, checked_at: stamp,
      };
    }
    const okCount = list.filter((r) => r.ok).length;
    return ok({
      list,
      total: list.length,
      ok: okCount,
      fail: list.length - okCount,
      concurrency: batch.concurrency_limit || HEALTH_CONCURRENCY,
      timeout_ms: batch.timeout_ms || HEALTH_TIMEOUT_MS,
      elapsed_ms: batch.elapsed_ms,
    });
  });

  /* ============================ 5. 占位：明确不支持 ============================ */
  const placeholders = [
    '/api/v1/application/list', '/api/v2/category/list',
    '/api/v1/fb/list', '/api/v1/fb/page', '/api/v1/fb/bm',
    '/api/v2/browser-profile/recycle-bin/list', '/api/v2/browser-profile/recycle-bin/restore',
    '/api/v2/browser-profile/share', '/api/v2/browser-profile/download-kernel',
    '/api/v2/browser-profile/update-patch',
    '/api/v2/user/create', '/api/v2/user/update', '/api/v2/user/reset_password',
    '/api/v2/user/delete', '/api/v2/user/list', '/api/v2/user-group/list',
    '/api/v2/proxy/dynamic-proxy-traffic',
  ];
  for (const p of placeholders) add(['GET', 'POST'], [p], notImplemented(p));

  return routes;
}

/* ------------------------------ 处理器细节 ------------------------------ */

async function startHandler(ctx, v) {
  const p = resolveProfile(ctx, v);
  // 每次启动可以用 launch_args 覆盖（v1 是 JSON 串 / 换行串，v2 必须是数组）
  let profile = { ...p, id: p.id };
  const rawArgs = ctx.query.launch_args ?? ctx.body?.launch_args;
  if (rawArgs !== undefined) {
    if (v === 'v2' && !Array.isArray(rawArgs)) throw new ApiError(ERR.INVALID, 'launch_args must be array');
    if (v === 'v1' && Array.isArray(rawArgs)) throw new ApiError(ERR.INVALID, 'launch_args must be list string');
    profile.launch_args = normalizeLaunchArgs(rawArgs);
  }
  const live = getRunning(p.id);
  if (live) return ok(live);
  const force = ['1', 'true', 'yes'].includes(String(ctx.query.force ?? ctx.body?.force ?? '').toLowerCase());
  try {
    return ok(await startProfile(profile, { force }));
  } catch (e) {
    const extra = { errors: e.errors, reason: e.reason, proxy_check: e.proxy_check };
    for (const k of Object.keys(extra)) if (extra[k] === undefined) delete extra[k];
    throw new ApiError(e.code === 800005 ? ERR.CONSISTENCY : ERR.START_FAILED, `start failed: ${e.message}`, 200, extra);
  }
}

/**
 * 只报真正变化的字段。restart 的 `changed` 是给人和脚本看的证据，
 * 不能把整份入参回显成「全改了」（那样等于没信息）。
 */
function diffFields(before, patch) {
  const out = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    const old = before[k];
    const same = JSON.stringify(old ?? null) === JSON.stringify(v ?? null);
    if (!same) out.push(k);
  }
  return out.sort();
}

/**
 * 重启一个环境：stop → apply → start。
 * 运行中 / 未运行都接受（未运行时等价于「改完直接启动」，restarted=false）。
 */
async function restartHandler(ctx, v) {
  const cur = resolveProfile(ctx, v);
  const patch = input(ctx.body, v);
  const changed = diffFields(cur, patch);
  const wasRunning = !!getRunning(cur.id);

  // 1) 先停：不停就改配置，等于让运行中的内核继续用旧代理/旧指纹
  if (wasRunning) {
    const r = await stopProfile(cur.id);
    if (!r.stopped && getRunning(cur.id)) {
      throw new ApiError(ERR.GENERIC, 'restart aborted: failed to stop the running kernel', 200,
        { restarted: false, changed, stopped: false });
    }
  }

  // 2) 再落库。失败就停在这里 —— 环境已经是 stopped，返回错误，不启动
  let profile;
  try {
    profile = updateProfile(cur.id, patch);
  } catch (e) {
    throw new ApiError(ERR.INVALID, `restart aborted, profile is stopped: ${e.message}`, 200,
      { restarted: false, changed, stopped: true, errors: e.fieldErrors });
  }

  // 3) 最后启动；启动失败同样保持 stopped（不会留下旧配置的内核）
  try {
    const data = await startProfile({ ...profile, id: profile.id });
    return ok({ ...data, restarted: wasRunning, changed });
  } catch (e) {
    const extra = {
      restarted: false, changed, stopped: true,
      reason: e.reason, errors: e.errors, proxy_check: e.proxy_check,
    };
    for (const k of Object.keys(extra)) if (extra[k] === undefined) delete extra[k];
    throw new ApiError(e.code === 800005 ? ERR.CONSISTENCY : ERR.START_FAILED,
      `restart failed, profile is stopped: ${e.message}`, 200, extra);
  }
}

/**
 * 硬删环境时把它的 user-data-dir 一起删掉。
 * 「删了记录、留几个 G 的 userdata」是最常见的脏数据来源；
 * 但这里只允许删 PROFILES_DIR 下的目录，路径算不对就不删（宁留数据不越界）。
 */
function removeProfileDataDir(profile) {
  try {
    const base = path.resolve(PROFILES_DIR) + path.sep;
    // userDataDirFor 给的是 <profiles>/<no>_<id8>/userdata，往上退一层才是这个环境的根
    const dir = path.resolve(path.dirname(userDataDirFor(profile)));
    if (!dir.startsWith(base)) return null;
    if (!fs.existsSync(dir)) return null;
    fs.rmSync(dir, { recursive: true, force: true });
    return dir;
  } catch {
    // 文件被占用（刚停完的内核还没退干净）不能把删除整体搞失败：记录已经删了，下次启动会重建目录
    return null;
  }
}

/** 每种缓存类型 → user-data-dir 下的相对路径（只删白名单里的，绝不递归删整个目录） */
const CACHE_PATHS = {
  local_storage: ['Local Storage'],
  indexeddb: ['IndexedDB'],
  extension_cache: ['Extension State', 'Extension Rules'],
  cookie: ['Network/Cookies', 'Network/Cookies-journal', 'Cookies', 'Cookies-journal'],
  history: ['History', 'History-journal'],
  image_file: ['Image File Cache'],
};

function clearCache(profile, types) {
  const root = userDataDirFor(profile);
  const removed = [];
  for (const t of types) {
    for (const rel of CACHE_PATHS[t] || []) {
      const abs = path.resolve(root, rel);
      // 防越界：必须还在这个环境的 userdata 目录里
      if (!abs.startsWith(path.resolve(root) + path.sep)) continue;
      try {
        if (fs.existsSync(abs)) { fs.rmSync(abs, { recursive: true, force: true }); removed.push(rel); }
      } catch { /* 文件被占用就跳过，别把整次请求搞挂 */ }
    }
  }
  return removed;
}
