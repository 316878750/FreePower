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
 * FreePower 扩展（对手没有）：batch-start / batch-stop / selfcheck / detail / proxy-check，
 * 以及 0.4.0 的 agent/*（工作流 / 审批，见第十节）。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  createProfile, getProfile, getProfileByNo, listProfiles, updateProfile, deleteProfiles, regroupProfiles,
  newFingerprintFor, listGroups, createGroup, getGroup, updateGroup, deleteGroup, cookieText, cookieToStorage,
  listRecycleBin, restoreProfiles, getRecycledProfile,
} from '../store/profiles.js';
import { listTags, createTags, updateTags, deleteTags, tagIdsOf } from '../store/tags.js';
import { importProfiles, copyProfile } from '../store/transfer.js';
import { parseAdspowerTxt, formatAdspowerTxt, txtFilename } from '../store/adspower-txt.js';
import { readCookies, writeCookies, formatNetscape, parseNetscape, missingAfterWrite } from '../kernel/cookies.js';
import {
  createProxies, updateProxy, listProxies, deleteProxies, rememberProxyCheck, getProxy,
} from '../store/proxies.js';
import { startProfile, stopProfile, listRunning, getRunning, getInstance, userDataDirFor } from '../runtime/manager.js';
import { batchStart, batchStop } from '../runtime/batch.js';
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
import { createWorkflow, getWorkflow, approveStep, presentWorkflow, runWorkflow, assertWorkflowRunnable } from '../agent/workflow.js';
import { createCli } from '../agent/cli.js';
import { API_PORT } from '../config.js';
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
    // v2 的分页参数叫 limit，但 `page/page_size` 是两条版本共用的分页写法：
    // 显式给了 page_size 就按它翻页（P10 验收门与老脚本都这么传），
    // “limit 不传只回 1 条”那个坑只在两个都没给时成立。
    const limitRaw = v === 'v2'
      ? pick(src, ['limit', 'page_size'])
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
  // 唯一 10/s 的桶（对手的分桶表：其余全 1/s，只有这条 10/s），档位由 server.js 的 rateTier 读
  add(['GET'], ['/api/v1/fbbird/user/list'], listHandler, { rateTier: 'fbbird' });

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
    // 先停再删：留着运行中的内核被软删除，就是孤儿进程，谁也回收不了
    for (const id of ids) if (getRunning(id)) await stopProfile(id);
    // 软删除（进回收站）：只置删除标记，**user-data 目录原样留在盘上** ——
    // 回收站里的环境恢复后必须能直接启动，删了盘就恢复出一个空壳。
    // 所以 userdata_removed 恒为 0；这个键保留，是为了不动 54 条路由契约的形状。
    const deleted = deleteProfiles(ids);
    return ok({ deleted, userdata_removed: 0 });
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
        // 结果里带上可读标识：只给 uuid 的话，API 消费者的日志里全是不可读的 id
        remark: p.remark || null,
        name: p.remark || `${p.host}:${p.port}`,
        proxy: { proxy_type: p.type, host: p.host, port: p.port, username: p.user, password: p.password },
      });
    }
    const batch = await checkMany(valid.map((x) => ({ proxy_id: x.proxy_id, proxy: x.proxy })));

    const list = new Array(ids.length);
    valid.forEach((x, k) => {
      const r = batch.list[k] || {};
      list[x.index] = { ...r, proxy_id: x.proxy_id, remark: x.remark, name: x.name };
      if (r.ok) rememberProxyCheck(x.proxy_id, r);
    });
    const stamp = new Date().toISOString();
    for (let i = 0; i < ids.length; i++) {
      if (list[i]) continue;
      list[i] = {
        index: i, proxy_id: ids[i], remark: null, name: null, ok: false, error_kind: 'not_found',
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

  /* ==================== 4.6 P10：环境导入/导出、复制、cookie 导入/导出 ==================== */

  /**
   * import：三种 body 形状都认（`{list}` / `{data:{list}}` / 裸数组）。
   * 一条失败不影响其余；未知字段只进 warnings。整体 code 仍是 0（部分失败不算接口失败）。
   */
  add(['POST'], ['/api/v1/browser-profile/import', '/api/v2/browser-profile/import', '/api/v1/user/import'], importHandler);

  /** export：POST `{profile_id: [...]}`，或 GET `?profile_id=a&profile_id=b`（逗号串也认） */
  add(['GET', 'POST'], ['/api/v1/browser-profile/export', '/api/v2/browser-profile/export', '/api/v1/user/export'], exportHandler);

  /**
   * copy：指纹字段原样复制，**四个噪声种子整组重生**。
   * copy_cookies 默认关；打开时源环境必须在跑（cookie 在内核里），不会静默跳过。
   */
  add(['POST'], ['/api/v1/browser-profile/copy', '/api/v2/browser-profile/copy', '/api/v1/user/copy'], (ctx) => copyHandler(ctx));

  /** cookie 导出/导入都只走运行中内核的 CDP（Storage.*），不读 SQLite、不偷偷起内核 */
  add(['GET'], ['/api/v1/browser-profile/cookie/export', '/api/v2/browser-profile/cookie/export', '/api/v1/user/cookie/export'], cookieExportHandler);
  add(['POST'], ['/api/v1/browser-profile/cookie/import', '/api/v2/browser-profile/cookie/import', '/api/v1/user/cookie/import'], cookieImportHandler);

  /* ==================== 4.7 回收站（软删除；形状按逆向 22- 号文） ==================== */

  /**
   * recycle-bin/list：入参只认 `page`（≥1）与 `limit`（1–100），本地改写成 `page_size`。
   * 出参 `data` 是**恒定三键** `{list, page, limit}` —— 对手的整形函数里这两个字段永远存在
   * （`l(e&&e.page)` / `l(e&&e.page_size)`），不是"传了才给"。**没有** `total` / `total_count`
   * / `total_pages`（对手整形函数里这三个词零出现；普通 `/browser-profile/list` 才有 total）。
   * 不传时的 `page=1` / `limit=50` 是**我们**的取值，对手云端默认值无证据（README 已标）。
   * item 是严格 6 字段子集（store 里的 toRecycleBinItem）。
   */
  add(['POST'], ['/api/v2/browser-profile/recycle-bin/list'], (ctx) => {
    const src = ctx.body || {};
    const asNumber = (name, raw) => {
      if (raw === undefined || raw === null || raw === '') return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new ApiError(ERR.INVALID, `${name} must be a number`);
      return n;
    };
    const page = asNumber('page', src.page);
    if (page !== undefined && page < 1) throw new ApiError(ERR.INVALID, 'page must be greater than or equal to 1');
    const limit = asNumber('limit', src.limit);
    if (limit !== undefined && (limit < 1 || limit > 100)) throw new ApiError(ERR.INVALID, 'limit must be between 1 and 100');
    const effPage = page ?? 1;
    const effLimit = limit ?? 50;
    const r = listRecycleBin({ page: effPage, page_size: effLimit });
    return ok({ list: r.list, page: effPage, limit: effLimit });
  });

  /**
   * recycle-bin/restore：**单个** `profile_id`（或 `profile_no`），不是 `user_ids` 数组。
   * `group_id` **必填**（对手要求恢复时显式选分组）—— 不能"回原分组就不传"。
   * 五条错误文案逐字照抄对手（docs/reverse/07 的错误串表）。
   * 成功响应体**无对手证据**（它是原样透传、客户端零整形），所以取最小形状：`data` 不出现。
   */
  add(['POST'], ['/api/v2/browser-profile/recycle-bin/restore'], (ctx) => {
    const src = ctx.body || {};
    const given = (v) => v !== undefined && v !== null && String(v).trim() !== '';
    if (given(src.profile_id) && typeof src.profile_id !== 'string' && typeof src.profile_id !== 'number') {
      throw new ApiError(ERR.INVALID, 'profile_id must be a string');
    }
    if (given(src.profile_no) && typeof src.profile_no !== 'string' && typeof src.profile_no !== 'number') {
      throw new ApiError(ERR.INVALID, 'profile_no must be a string');
    }
    if (!given(src.profile_id) && !given(src.profile_no)) throw new ApiError(ERR.INVALID, 'profile_id or profile_no is required');
    if (!given(src.group_id)) throw new ApiError(ERR.INVALID, 'group_id is required');
    const g = src.group_id;
    if (typeof g !== 'number' && !(typeof g === 'string' && /^\d+$/.test(g))) {
      throw new ApiError(ERR.INVALID, 'group_id must be a number');
    }

    const byId = given(src.profile_id) ? String(src.profile_id) : null;
    const target = getRecycledProfile({ profile_id: byId, profile_no: byId ? null : src.profile_no });
    // 不在回收站里（含"根本没这个环境"）一律 100001：不要给"恢复成功"的假象
    if (!target) throw new ApiError(ERR.NOT_FOUND, 'Profile does not exist');
    const r = restoreProfiles([target.id], g)[0];
    if (!r.restored) throw new ApiError(ERR.GENERIC, 'restore failed');
    return ok(null);
  });

  /* ==================== 6. AI Agent（0.4.0 骨架；对手那套在云端，见 docs/reverse 24-） ====================
   *
   * 三条路由都是**我们自己的契约**（对手没有可抄的本地 REST：它是 5.3 MB Agent Core 子进程
   * + `ws://127.0.0.1:<port>/agent/socket` 的 4 条 WS 指令，逆向 `24-` §3.2）。
   * 所以这里的形状不定"对齐对手"，定"脚本能编排 + 人能在控制台批"：
   *   POST run      建工作流（解析 DSL、算每步审批 digest），**不启动浏览器**
   *   GET  status   读状态（骨架版永远到不了 completed，因为执行器未接）
   *   POST approve  HITL 批/拒一步；**不给 decision 就是拒**（默认拒）
   */

  /** 把 agent 层的错误（带数字 code / field）统一转成 ApiError，不发明新码 */
  const agentCall = (fn) => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof ApiError) throw e;
      const code = Number.isFinite(e?.code) ? e.code : ERR.GENERIC;
      throw new ApiError(code, e?.message || 'agent error', 200, e?.field ? { field: e.field } : {});
    }
  };

  add(['POST'], ['/api/v1/agent/workflow/run'], (ctx) => {
    const b = ctx.body || {};
    const pid = String(b.profile_id ?? b.user_id ?? '').trim();
    if (!pid) throw new ApiError(ERR.INVALID, 'profile_id is required');
    // 环境存在性先查：别让工作流建出来挂在一个不存在的环境上（执行器接上后才发现就晚了）
    if (!getProfile(pid)) throw new ApiError(ERR.NOT_FOUND, 'Profile does not exist');
    const wf = agentCall(() => createWorkflow({ profile_id: pid, goal: b.goal, tasks: b.tasks }));
    return ok(presentWorkflow(wf));
  });

  add(['GET'], ['/api/v1/agent/workflow/:id/status'], (ctx) => {
    const wf = getWorkflow(ctx.params?.id);
    if (!wf) throw new ApiError(ERR.NOT_FOUND, 'Workflow does not exist');
    return ok(presentWorkflow(wf));
  });

  add(['POST'], ['/api/v1/agent/workflow/:id/approve'], (ctx) => {
    const b = ctx.body || {};
    const wf = agentCall(() => approveStep(ctx.params?.id, { step_id: b.step_id, decision: b.decision, digest: b.digest }));
    return ok(presentWorkflow(wf));
  });

  /**
   * 真跑：只接受「全部步都批完」的 approved 工作流。接口**立刻回 `running`**，
   * 执行在后台推进（单步可能几十秒，不能挂在请求上）；进度走 `GET …/:id/status` 轮询。
   *
   * 状态 / 每步审批 / 盘上 digest 都在返回前**同步**核一遍：参数错必须当面回 100002，
   * 不能等后台跑起来才发现（那时调用方已经拿到 200 了）。
   */
  add(['POST'], ['/api/v1/agent/workflow/:id/run'], (ctx) => {
    const wf = getWorkflow(ctx.params?.id);
    if (!wf) throw new ApiError(ERR.NOT_FOUND, 'Workflow does not exist');
    const port = ctx.req?.socket?.localPort || API_PORT;
    const cli = createCli({ base: `http://127.0.0.1:${port}`, apiKey: ctx.apiKey || '' });
    agentCall(() => assertWorkflowRunnable(wf));
    agentCall(() => {
      runWorkflow(wf.id, { cli }).catch((e) => {
        // runWorkflow 内部已把失败落到 wf.error；这里只兜「连状态转移都没走到」的意外
        try { console.warn(`[agent] 工作流执行异常 ${wf.id}：${e?.message || e}`); } catch { /* ignore */ }
      });
    });
    return ok(presentWorkflow(wf));
  });

  /* ============================ 5. 占位：明确不支持 ============================ */
  const placeholders = [
    '/api/v1/application/list', '/api/v2/category/list',
    '/api/v1/fb/list', '/api/v1/fb/page', '/api/v1/fb/bm',
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

/* ------------------------------ P10：导入 / 导出 / 复制 / cookie ------------------------------ */

/** GET 里同一个 key 可能重复（?profile_id=a&profile_id=b），Object.fromEntries 会丢，直接读原始 query */
function queryAll(ctx, name) {
  try {
    return new URL(ctx.req.url, 'http://127.0.0.1').searchParams.getAll(name)
      .flatMap((s) => String(s).split(','))
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function extractImportList(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.list)) return body.list;
  if (Array.isArray(body?.data?.list)) return body.data.list;
  if (Array.isArray(body?.data)) return body.data;
  throw new ApiError(ERR.INVALID, 'list is required：支持 {list:[...]}、{data:{list:[...]}} 或裸数组');
}

function importHandler(ctx) {
  const body = ctx.body;
  const format = String(body?.format || '').toLowerCase();
  // .txt 块格式（AdsPower 环境导出）：18 字段 + 18 星号收尾；能建就建，失败的块带块号
  if (format === 'txt') {
    const content = body?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new ApiError(ERR.INVALID, 'format=txt 需要 content 字符串（整份文件的内容）');
    }
    const parsed = parseAdspowerTxt(content);
    if (parsed.items.length > 1000) throw new ApiError(ERR.INVALID, '单次导入最多 1000 条');
    const r = importProfiles(parsed.items, { unit: '块' });
    const list = r.list.map((p) => present(p, 'v2'));
    const failed = [...parsed.failed, ...r.failed];
    const warnings = [...parsed.warnings, ...r.warnings];
    return {
      code: 0,
      msg: 'success',
      imported: r.imported,
      failed,
      warnings,
      data: { format: 'txt', list, imported: r.imported, failed, warnings },
    };
  }
  const items = extractImportList(body);
  if (items.length > 1000) throw new ApiError(ERR.INVALID, '单次导入最多 1000 条');
  const r = importProfiles(items);
  const list = r.list.map((p) => present(p, 'v2'));
  // imported / failed / warnings 顶层与 data 各放一份：脚本按契约读顶层，控制台按 data 读
  return {
    code: 0,
    msg: 'success',
    imported: r.imported,
    failed: r.failed,
    warnings: r.warnings,
    data: { list, imported: r.imported, failed: r.failed, warnings: r.warnings },
  };
}

/** AdsPower 兼容键：导出的顶层与 fingerprint_config 里各给一份（导入时两种位置都认） */
function proxyCompat(p) {
  const px = p.proxy_config || {};
  return {
    proxy_type: px.proxy_type || 'http',
    proxy_host: px.host || '',
    proxy_port: Number(px.port) || 0,
    proxy_user: px.username || '',
    proxy_password: px.password || '',
  };
}

function exportRecord(p) {
  const base = present(p, 'v2');
  const px = proxyCompat(p);
  const fp = { ...(base.fingerprint_config || {}) };
  fp.seed = String(p.fp_seed ?? '');
  Object.assign(fp, px);
  base.fingerprint_config = fp;
  Object.assign(base, px);
  return base;
}

function exportHandler(ctx) {
  const body = ctx.body || {};
  const ids = idList(body.profile_id ?? body.user_id ?? body.user_ids, 'v2');
  const all = [...new Set([...ids, ...queryAll(ctx, 'profile_id'), ...queryAll(ctx, 'user_id')])];
  if (!all.length) throw new ApiError(ERR.INVALID, 'Require profile_id');
  const profiles = [];
  const missing = [];
  for (const id of all) {
    const p = getProfile(id);
    if (!p) { missing.push(id); continue; }
    profiles.push(p);
  }
  const format = String(body.format || ctx.query.format || 'json').toLowerCase();
  if (format === 'txt') {
    // AdsPower 互操作格式：只回文本，不再夹带 list（两边都塞会让调用方不知道该信哪份）
    let built;
    try {
      built = formatAdspowerTxt(profiles);
    } catch (e) {
      // 自校验失败就不许输出半坏的文件
      throw new ApiError(ERR.GENERIC, `导出 txt 失败：${e.message}`);
    }
    return ok({
      format: 'txt',
      count: profiles.length,
      filename: txtFilename(),
      content: built.content,
      warnings: built.warnings,
      missing,
    });
  }
  if (format !== 'json') throw new ApiError(ERR.INVALID, 'format must be json or txt');
  const list = profiles.map(exportRecord);
  return ok({ list, count: list.length, missing });
}

async function copyHandler(ctx) {
  const p = resolveProfile(ctx, 'v2');
  const copyCookies = ['1', 'true', 'yes'].includes(String(ctx.body?.copy_cookies ?? '').toLowerCase());
  // 先判「源没跑」再建副本：否则会留一个半成品环境
  if (copyCookies && !getRunning(p.id)) {
    throw new ApiError(ERR.NOT_RUNNING, 'copy_cookies 需要源环境在运行：cookie 存在内核里，请先启动该环境（不会静默跳过）');
  }
  const created = copyProfile(p.id, { name: ctx.body?.name });
  if (!created) throw new ApiError(ERR.NOT_FOUND, 'Profile does not exist');

  let cookiesCopied = 0;
  if (copyCookies) {
    const inst = getInstance(p.id);
    let live = [];
    try { live = await readCookies(inst.client); } catch (e) {
      throw new ApiError(ERR.GENERIC, `读取源环境 cookie 失败：${e.message}`);
    }
    if (live.length) {
      // cookie 以「登录 cookie 文本」回写到新环境（/cookies 接口可读）；
      // 不是把内核实时读到的 SQLite 文件复制过去（那份数据既加锁又不完整）。
      const text = live.map((c) => `${c.name}=${c.value}`).join('; ');
      updateProfile(created.profile_id, { login_cookie: text });
      cookiesCopied = live.length;
    }
  }
  const fresh = getProfile(created.profile_id) || created;
  return ok({ ...present(fresh, 'v2'), seeds_regenerated: true, cookies_copied: cookiesCopied });
}

async function cookieExportHandler(ctx) {
  const p = resolveProfile(ctx, 'v2');
  const format = String(ctx.query.format || 'json').toLowerCase();
  if (format !== 'json' && format !== 'netscape') throw new ApiError(ERR.INVALID, 'format must be json or netscape');
  const inst = getInstance(p.id);
  if (!inst) {
    throw new ApiError(ERR.NOT_RUNNING, '环境未在运行：cookie 存在内核里，请先启动该环境再导出（不会为了导出偷偷起内核）');
  }
  let cookies;
  try { cookies = await readCookies(inst.client); } catch (e) {
    throw new ApiError(ERR.GENERIC, `读取 cookie 失败：${e.message}`);
  }
  if (format === 'netscape') return ok({ format, count: cookies.length, content: formatNetscape(cookies) });
  return ok({ format, count: cookies.length, cookies });
}

async function cookieImportHandler(ctx) {
  const p = resolveProfile(ctx, 'v2');
  const inst = getInstance(p.id);
  if (!inst) {
    throw new ApiError(ERR.NOT_RUNNING, '环境未在运行：cookie 要写进内核，请先启动该环境（不会为了导入偷偷起内核）');
  }
  const body = ctx.body || {};
  let list = body.cookies;
  let failed = [];
  if (!Array.isArray(list)) {
    const content = body.content;
    const format = String(body.format || '').toLowerCase();
    if (typeof content !== 'string' || !content.trim()) {
      throw new ApiError(ERR.INVALID, '提供 cookies 数组，或 {format:"netscape", content:"..."}');
    }
    if (format && format !== 'netscape') throw new ApiError(ERR.INVALID, 'format 只支持 netscape；数组请用 cookies 字段');
    const parsed = parseNetscape(content);
    list = parsed.cookies;
    failed = parsed.failed;
  }
  if (list.length > 5000) throw new ApiError(ERR.INVALID, '单次最多导入 5000 条 cookie');
  const r = await writeCookies(inst.client, list);
  const warnings = [];
  let verified = 0;
  if (r.written.length) {
    // 契约要求的回读校验：imported > 0 时立刻读回，缺了就告警，不假装成功
    try {
      const now = await readCookies(inst.client);
      const missing = missingAfterWrite(r.written, now);
      verified = r.written.length - missing.length;
      if (missing.length) {
        warnings.push(`${missing.length} 条写入后回读不到（可能被内核按策略丢弃）：${missing.slice(0, 5).map((c) => `${c.name}@${c.domain}`).join('、')}`);
      }
    } catch (e) {
      warnings.push(`回读校验失败：${e.message}`);
    }
  }
  const allFailed = [...failed, ...r.failed];
  return {
    code: 0,
    msg: 'success',
    imported: r.written.length,
    failed: allFailed,
    warnings,
    verified,
    data: { imported: r.written.length, failed: allFailed, warnings, verified },
  };
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
