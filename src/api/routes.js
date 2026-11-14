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
  listRecycleBin, restoreProfiles, getRecycledProfile, purgeProfiles,
} from '../store/profiles.js';
import { listTags, createTags, updateTags, deleteTags, tagIdsOf } from '../store/tags.js';
import {
  listExtensions, importExtension, updateExtension, deleteExtensions,
  profileExtensions, profileExtensionIds, setProfileExtensions,
} from '../store/extensions.js';
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
import { apiInfoPayload, setApiVerify, resetStats } from './info.js';
import { startSync, stopSync, syncStatus, updateSettings, refreshAll, unifySize, arrangeWindows, showWindows, forceShowWindows, openTabInAll, tabState, closeTabs, copyTabToSlaves, unifyTabs } from '../sync/session.js';
import { readDisplays } from '../sync/displays.js';
import { readHotkeyStatus, requestHotkey } from '../sync/hotkey.js';
import { resetApiKey } from '../store/db.js';
import { listKernels } from '../kernel/chrome.js';
import { runKernelDownload } from '../kernel/download.js';
import { createWorkflow, getWorkflow, approveStep, presentWorkflow, runWorkflow, assertWorkflowRunnable } from '../agent/workflow.js';
import { planTasksFromGoal } from '../agent/llm.js';
import { normalizeShotPath, resolveShotPath } from '../agent/task.js';
import { createCli } from '../agent/cli.js';
import { API_PORT, AGENT_SCREENSHOT_DIR } from '../config.js';
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

  /**
   * download-kernel（0.4.1 从占位变真实现）—— 契约 `23-内核下载契约.md`。
   *
   * 源是 **Chrome for Testing**（不是对手的 CDN，理由见 `src/kernel/download.js` 头注释）；
   * **同步状态机、没有 task id、没有轮询端点**：每次调用推进一次，立刻回
   * `{code:0,data:{status[,progress]}}`，要进度就再调这个端点。
   *
   * 错误照契约 §4 只回 `{code:-1,msg}`（**不塞 `data.reason`**，与 agent 那组路由的口径不同）：
   * 缺参 / 类型大小写错 / 版本非数字 / Firefox 不支持 / 目录里没有该版本，都在这里**同步**抛出。
   * 真下载在后台跑，失败不进响应 —— 下一次调用自动重试（契约 §2.1 的 `FAIL → RE_DOWNLOAD`）。
   */
  add(['POST'], ['/api/v2/browser-profile/download-kernel'], async (ctx) => {
    try {
      return await runKernelDownload(ctx.body || {});
    } catch (e) {
      if (e instanceof ApiError) throw e;
      // `previous_error`（前一个源为什么失败）跟着错误走：只塞 msg 的话，脚本看得到「镜像 404」，
      // 看不到「官方先卡死了」。没有这个字段时**不加键**，形状与契约 §4 一致。
      const extra = e?.previous_error ? { previous_error: e.previous_error } : {};
      throw new ApiError(Number.isFinite(e?.code) ? e.code : ERR.GENERIC, e?.message || 'kernel download failed', 200, extra);
    }
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

  /**
   * recycle-bin/purge：**彻底删除**（我们自己的路由，对手没有）。
   *
   * 证据边界：逆向 22- 号文 §5.4 明确「只看到 check-hard-delete-list 服务于清缓存，
   * 没看到从回收站永久删的路由」→ 对手客户端能不能从回收站彻底删，**无证据**。
   * 我们加这条，是因为「只能恢复、不能清」的回收站等于磁盘只进不出：
   * user-data 目录里是 cookie 和缓存，几十个环境就是几十 GB。
   *
   * 语义三条：
   *   1. **只对回收站里的环境生效**。在用环境走这条一律 skipped，不给绕过软删除的口子。
   *   2. 参数必须显式：`profile_id`（数组）或 `all: true`（清空）。
   *      一个都没给就报错 —— 全量动作最怕「字段拼错被当成空/当成全清」。
   *   3. 先停（理论上不该在跑）、再删盘、最后删库。盘删不掉就**不删库**：
   *      留下一条记录让用户还能再点一次，比删了库留下一堆谁也管不着的目录强。
   */
  add(['POST'], ['/api/v2/browser-profile/recycle-bin/purge'], async (ctx) => {
    const src = ctx.body || {};
    const wantsAll = src.all === true;
    const hasIds = src.profile_id !== undefined || src.profile_no !== undefined || src.ids !== undefined;
    if (!wantsAll && !hasIds) {
      throw new ApiError(ERR.INVALID, 'profile_id is required（清空回收站请显式传 all:true）', 200, { field: 'profile_id' });
    }

    let ids;
    if (wantsAll) {
      // 回收站可能超过一页（list 的 limit 上限 100），所以自己把所有 id 捞出来
      ids = [];
      for (let page = 1; page <= 1000; page++) {
        const r = listRecycleBin({ page, page_size: 100 });
        ids.push(...r.list.map((x) => x.profile_id));
        if (r.list.length < 100) break;
      }
    } else {
      const raw = src.profile_id ?? src.ids ?? src.profile_no;
      const list = idList(raw, 'v2');
      if (!list.length) throw new ApiError(ERR.INVALID, 'profile_id is required', 200, { field: 'profile_id' });
      // profile_no 也能传（对齐 restore 的口径），换算成 id
      ids = list.map((one) => {
        const p = getProfile(one) || getRecycledProfile({ profile_id: one }) || getRecycledProfile({ profile_no: one });
        return p ? p.id : one;
      });
    }

    const purged = [];
    const skipped = [];
    let userdataRemoved = 0;
    for (const id of ids) {
      const target = getRecycledProfile({ profile_id: id });
      if (!target) { skipped.push({ profile_id: String(id), reason: 'not_in_recycle_bin' }); continue; }
      if (getRunning(target.id)) { try { await stopProfile(target.id); } catch { /* 停不掉就走下面删库失败分支 */ } }
      // 目录：<profiles>/<no>_<id8>/userdata → 连它的上一级（同一个环境的目录）一起删
      let dirGone = true;
      try {
        const udd = userDataDirFor(target);
        const dir = path.dirname(udd);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        dirGone = !fs.existsSync(dir);
        if (dirGone) userdataRemoved++;
      } catch (e) {
        dirGone = false;
        /**
         * 这一步**真的会失败**，而且不是罕见情况：残留的内核进程把 user-data 目录当工作目录、
         * 或某个文件被别的程序锁着时，Windows 给的是 `EPERM`（实测：子进程 cwd 在目录里就必现）。
         * 所以 reason 用**稳定的机器可读串**，错误码与原文分开挂 —— 界面上要显示原因，
         * 脚本要能按 reason/code 判断「等会儿再试」，两件事不能挤在一条中文串里。
         */
        skipped.push({
          profile_id: target.id,
          reason: 'userdata_remove_failed',
          error_code: e.code || null,
          error_message: e.message,
        });
      }
      if (!dirGone) continue; // 盘没删掉就不删库，留个还能再点的入口
      const r = purgeProfiles([target.id]);
      purged.push(...r.purged);
      for (const s of r.skipped) skipped.push(s);
    }
    return ok({ purged, skipped, userdata_removed: userdataRemoved });
  });

  /* ==================== 6. AI Agent（0.4.0 骨架；对手那套在云端，见 docs/reverse 24-） ====================
   *
   * 三条路由都是**我们自己的契约**（对手没有可抄的本地 REST：它是 5.3 MB Agent Core 子进程
   * + `ws://127.0.0.1:<port>/agent/socket` 的 4 条 WS 指令，逆向 `24-` §3.2）。
   * 所以这里的形状不定"对齐对手"，定"脚本能编排 + 人能在控制台批"：
   *   POST create-from-goal  一句话目标 → 调用户自己的模型 → 建工作流（不启动浏览器）
   *   POST run      建工作流（解析 DSL、算每步审批 digest），**不启动浏览器**
   *   GET  status   读状态与每步结果（执行器是本地 CDP，见 workflow.js）
   *   POST approve  HITL 批/拒一步；**不给 decision 就是拒**（默认拒）
   */

  /**
   * 把 agent 层的错误（带数字 code / field）统一转成 ApiError，不发明新码。
   * `reason` 只在错误自带时透出（`llm_*` / `execution_*` 这类稳定标识），方便脚本/控制台定位
   * —— 响应形状只增不改。
   */
  const agentFail = (e) => {
    if (e instanceof ApiError) return e;
    const code = Number.isFinite(e?.code) ? e.code : ERR.GENERIC;
    const extra = {};
    if (e?.field) extra.field = e.field;
    if (e?.reason) extra.reason = String(e.reason);
    return new ApiError(code, e?.message || 'agent error', 200, extra);
  };
  const agentCall = (fn) => {
    try {
      return fn();
    } catch (e) {
      throw agentFail(e);
    }
  };
  /** 异步版（LLM 调用要等网络）：错误映射与 `agentCall` 完全一致，别写两套口径 */
  const agentCallAsync = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      throw agentFail(e);
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

  /**
   * 截图取图的**短期票据**：控制台要把图片塞进 `<img src>`，没法带 api-key 头；
   * 把 master key 拼进 URL 又会留在浏览器历史/日志里（同自检报告的坑，见 tickets.js）。
   * 票 120 秒、绑 workflow 的 profile_id，只读那一个环境的截图。
   */
  add(['POST'], ['/api/v1/agent/workflow/:id/screenshot-ticket'], (ctx) => {
    const wf = getWorkflow(ctx.params?.id);
    if (!wf) throw new ApiError(ERR.NOT_FOUND, 'Workflow does not exist');
    const t = issueTicket(wf.profile_id);
    return ok({
      ...t,
      url: `/api/v1/agent/workflow/${encodeURIComponent(wf.id)}/screenshot?profile_id=${encodeURIComponent(wf.profile_id)}&ticket=${encodeURIComponent(t.ticket)}`,
    });
  });

  /**
   * 取一张工作流截图（PNG）。`path` 是相对 `DATA_DIR/agent/screenshots/` 的相对路径，
   * 复用 DSL 层的 `normalizeShotPath`（只 .png、不许 `..`/绝对路径）+ 执行层 `resolveShotPath`
   * 兜越界 —— 查询串是用户能改的，必须在这里再校验一次。
   */
  add(['GET'], ['/api/v1/agent/workflow/:id/screenshot'], (ctx) => {
    const wf = getWorkflow(ctx.params?.id);
    if (!wf) throw new ApiError(ERR.NOT_FOUND, 'Workflow does not exist');
    const { abs } = agentCall(() => resolveShotPath(normalizeShotPath(ctx.query.path), AGENT_SCREENSHOT_DIR, ''));
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      throw new ApiError(ERR.NOT_FOUND, 'screenshot not found（这步可能还没跑，或被清理了）');
    }
    return { __bytes: buf, contentType: 'image/png' };
  }, { ticket: true });

  add(['POST'], ['/api/v1/agent/workflow/:id/approve'], (ctx) => {
    const b = ctx.body || {};
    const wf = agentCall(() => approveStep(ctx.params?.id, { step_id: b.step_id, decision: b.decision, digest: b.digest }));
    return ok(presentWorkflow(wf));
  });

  /**
   * 一句话目标 → 工作流：调**用户自己配的**模型，把 goal 拆成 `browser_task` 数组，
   * 直接落成全部 `pending_approval` 的工作流（每步 digest 生成即算，见 `createWorkflow`）。
   *
   * 与 `POST run` 的区别：那个收**已写好的 tasks**，这个收**一句话目标**。
   * LLM 三样（endpoint/key/model）显式参数优先，否则走 `AGENT_LLM_*`；配不齐 = 100002 field=llm。
   * **不在这里执行、不启动浏览器**：生成只是提案，跑不跑由人一步步批。
   * 环境存在性先查：别让工作流挂在不存在的环境上（模型调用也不该为它花钱）。
   */
  add(['POST'], ['/api/v1/agent/workflow/create-from-goal'], async (ctx) => {
    const b = ctx.body || {};
    const pid = String(b.profile_id ?? '').trim();
    if (!pid) throw new ApiError(ERR.INVALID, 'profile_id is required', 200, { field: 'profile_id' });
    if (b.llm !== undefined && (!b.llm || typeof b.llm !== 'object' || Array.isArray(b.llm))) {
      throw new ApiError(ERR.INVALID, 'llm must be an object {endpoint,key,model}', 200, { field: 'llm' });
    }
    const goal = String(b.goal ?? '').trim();
    if (!goal) throw new ApiError(ERR.INVALID, 'goal is required', 200, { field: 'goal' });
    if (!getProfile(pid)) throw new ApiError(ERR.NOT_FOUND, 'Profile does not exist');

    // 模型产出 → 校验后的 tasks（未知动作/字段在这里就 100002，带 tasks[i].x）
    const plan = await agentCallAsync(() => planTasksFromGoal(b.llm || {}, { goal }));
    const wf = agentCall(() => createWorkflow({ profile_id: pid, goal, tasks: plan.tasks }));
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

  /* ============================ 4.5 本地 API 自述（0.4.2） ============================ */
  /**
   * 「API & MCP」页要的全部状态，一次请求拿完。
   * `endpoints` 直接从**这次 buildRoutes() 的结果**派生（见 catalog.js），
   * 所以页面显示的条数永远等于真实路由数 —— 判据钉的就是这一点。
   */
  add(['GET'], ['/api/v2/api/info', '/api/v1/api/info'], (ctx) => ok(apiInfoPayload(ctx, routes)));

  /**
   * API 验证开关。**关掉 = 不校验 api_key**（对齐对手的开关语义，不是我们的发明）。
   * 代价必须说清：关掉之后本机任何进程都能调 API，包括重置 key、改环境。
   */
  add(['POST'], ['/api/v2/api/verify', '/api/v1/api/verify'], (ctx) => {
    const raw = ctx.body?.enabled ?? ctx.query?.enabled;
    if (raw === undefined || raw === null || raw === '') throw new ApiError(ERR.INVALID, 'enabled is required');
    const on = raw === true || raw === 1 || String(raw).toLowerCase() === 'true' || String(raw) === '1';
    return ok({ verify: setApiVerify(on) });
  });

  /**
   * 重置 API Key：库里换一把、`data/local_api` 一起换、**本进程立刻按新 key 校验**。
   * 计数归零 —— 换了 key 等于换了一个使用阶段，旧读数没有参考价值。
   */
  add(['POST'], ['/api/v2/api/key/reset', '/api/v1/api/key/reset'], (ctx) => {
    const port = Number(ctx.port || API_PORT);
    const key = resetApiKey({ port });
    if (typeof ctx.setApiKey === 'function') ctx.setApiKey(key);
    resetStats();
    return ok({ api_key: key });
  });

  /* ============================ 4.6 窗口同步（0.4.2） ============================ */
  /**
   * 开始窗口同步。**跑在主进程里的长会话**，不是一次请求做完的事：
   * 这里只负责建连、装捕获、登记受控窗口，然后立刻回一份 status 给界面。
   *
   * 入参（v2 风格）：`{ master_id, slave_ids: [...], settings?: {...}, rng_seed? }`
   * 出错一律 100002 —— 全是「参数/前置状态不对」，没有一种是服务端故障。
   */
  add(['POST'], ['/api/v2/sync/start'], async (ctx) => {
    const b = ctx.body || {};
    const masterId = String(b.master_id ?? b.masterId ?? '').trim();
    const rawSlaves = b.slave_ids ?? b.slaveIds ?? b.window_ids ?? [];
    if (!masterId) throw new ApiError(ERR.INVALID, 'master_id is required', 200, { field: 'master_id' });
    if (!Array.isArray(rawSlaves) || !rawSlaves.length) {
      throw new ApiError(ERR.INVALID, 'slave_ids must be a non-empty array', 200, { field: 'slave_ids' });
    }
    try {
      return ok(await startSync({
        masterId,
        slaveIds: rawSlaves,
        settings: b.settings && typeof b.settings === 'object' ? b.settings : {},
        rngSeed: b.rng_seed ?? null,
      }));
    } catch (e) {
      throw new ApiError(ERR.INVALID, e?.message || 'sync start failed');
    }
  });

  /** 停止同步：没在跑也回 200（幂等），界面不用先查状态再关 */
  add(['POST'], ['/api/v2/sync/stop'], async () => ok(await stopSync()));

  /** 同步状态：没在跑也给稳定形状（running:false + 默认设置），界面不用到处判空 */
  add(['GET'], ['/api/v2/sync/status'], () => ok(syncStatus()));

  /**
   * 运行中改设置（四个开关 / 延迟）。**不重开会话** —— 重开等于把用户已经打开的标签
   * 重新挂一遍，按键会丢。参数非法也照默认值归一，不为了让开关生效而报错。
   */
  add(['POST'], ['/api/v2/sync/settings'], (ctx) => {
    const b = ctx.body || {};
    try {
      return ok({ settings: updateSettings(b.settings && typeof b.settings === 'object' ? b.settings : b) });
    } catch (e) {
      throw new ApiError(ERR.INVALID, e?.message || 'sync is not running');
    }
  });

  /** 重读各窗口视口/外框尺寸：用户拖动窗口大小之后，坐标映射得跟着更新 */
  add(['POST'], ['/api/v2/sync/refresh'], async () => ok(await refreshAll()));

  /**
   * 一键统一尺寸：受控窗口拉到主窗口的宽高。
   * **只在用户点按钮时执行** —— 不自动改人家的窗口（那是可见的副作用）。
   */
  add(['POST'], ['/api/v2/sync/unify-size'], async () => {
    try {
      return ok(await unifySize());
    } catch (e) {
      throw new ApiError(ERR.INVALID, e?.message || 'sync is not running');
    }
  });

  /**
   * 窗口排列（`tileWin`）：把参与同步的窗口按网格摆好。
   * 参数对齐对手：row/hs/vs/left/top/width/height/range/screenId/screenList；`auto:true` = 一键排列。
   * 摆完**回读**每个窗口的位置尺寸，不一致如实报（不静默当成功）。
   */
  add(['POST'], ['/api/v2/sync/arrange'], async (ctx) => {
    const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
    try {
      return ok(await arrangeWindows(body));
    } catch (e) {
      throw new ApiError(ERR.INVALID, e?.message || 'sync is not running');
    }
  });

  /** 显示器列表（桌面壳写、服务进程读）：多屏排列要用 workArea */
  add(['GET'], ['/api/v2/sync/displays'], () => ok(readDisplays()));

  /**
   * 显示窗口（`viewWin` / 行内 `displayWin`）：最小化的窗口恢复出来并放到前台。
   *
   * **能力边界如实写在返回值里**（`raise` 字段，别让调用方以为都到前台了）：
   *   `restored`  最小化 → 恢复，实测会同时成为 OS 前台窗口
   *   `page_only` 只做了页面级激活，窗口可能仍被别的窗口盖住（零依赖做不到 ③）
   * `os_foreground` 只有全部窗口都走 `restored` 时才为 true。
   */
  add(['POST'], ['/api/v2/sync/show'], async (ctx) => {
    const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
    const ids = body.profile_ids ?? body.profile_id ?? ctx.query?.profile_id;
    try {
      return ok(await showWindows(ids));
    } catch (e) {
      throw new ApiError(ERR.INVALID, e?.message || 'sync is not running');
    }
  });

  /**
   * 强制抬到前台（**用户显式点按钮才调，默认路径不许调**）：`{profile_ids?}`。
   *
   * 手段是「最小化 → 恢复原状态」—— 零依赖下唯一能真的把被盖住的窗口抬到 OS 前台的办法
   * （实测会到前台，代价是任务栏闪一下、每个窗口 0.6–1.0 秒）。所以它是一次性动作，不是开关、
   * 不写设置。返回 `confirmed: 'window_restored'`：**能确认窗口已恢复正常，确认不了它在最前面**
   * （产品里不调 Win32）。
   */
  add(['POST'], ['/api/v2/sync/show/force'], async (ctx) => {
    const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
    const ids = body.profile_ids ?? body.profile_id ?? ctx.query?.profile_id;
    try {
      return ok(await forceShowWindows(ids));
    } catch (e) {
      throw new ApiError(ERR.INVALID, e?.message || 'sync is not running');
    }
  });

  /**
   * 打开网址（`syncOperateOpenUrl`）：每个同步窗口打开同一批网址。
   * 入参是**多行文本**（`url`，每行一个，对齐对手的 `syncOperateUrlList`）或数组（`urls`），
   * 最多 10 个 —— 超过就报「一键最多打开10个网址」（对手原文），**不静默截断**。
   * 内部走 about:blank → 登记豁免 → attach → navigate，避免首帧原始指纹。
   */
  add(['POST'], ['/api/v2/sync/tab'], async (ctx) => {
    const raw = ctx.body?.urls ?? ctx.body?.url ?? ctx.query?.urls ?? ctx.query?.url;
    try {
      return ok(await openTabInAll(raw));
    } catch (e) {
      throw new ApiError(ERR.INVALID, e?.message || 'sync is not running', 200, { field: 'url' });
    }
  });

  /** 各窗口的标签列表与当前可见序号（界面与判据都读这个，不靠猜） */
  add(['GET'], ['/api/v2/sync/tabs'], async () => ok(await tabState()));

  /** 关标签：which = current（当前）/ others（留当前，关其它）/ blank（关空白） */
  add(['POST'], ['/api/v2/sync/tab-close'], async (ctx) => {
    const which = ctx.body?.which ?? ctx.query?.which ?? 'current';
    try {
      return ok(await closeTabs(which));
    } catch (e) {
      throw new ApiError(ERR.INVALID, e?.message || 'sync is not running', 200, { field: 'which' });
    }
  });

  /** 复制主窗口某标签到受控窗口（只往受控去，不动主窗口） */
  add(['POST'], ['/api/v2/sync/tab-copy'], async (ctx) => {
    const raw = ctx.body?.index ?? ctx.query?.index;
    const index = raw === undefined || raw === null || raw === '' ? null : Number(raw);
    try {
      return ok(await copyTabToSlaves({ index }));
    } catch (e) {
      throw new ApiError(ERR.INVALID, e?.message || 'sync is not running', 200, { field: 'index' });
    }
  });

  /** 统一标签页：受控窗口的标签数量与序号 URL 对齐主窗口 */
  add(['POST'], ['/api/v2/sync/tab-unify'], async () => {
    try {
      return ok(await unifyTabs());
    } catch (e) {
      throw new ApiError(ERR.INVALID, e?.message || 'sync is not running');
    }
  });

  /**
   * 全局快捷键状态。`managed:false` = 没有桌面壳在管（命令行跑服务时没有全局快捷键），
   * 这不是失败；`ok:false` 才是真的注册失败（被占用）。
   */
  add(['GET'], ['/api/v2/sync/hotkey'], () => ok(readHotkeyStatus()));

  /**
   * 改快捷键：写请求文件，桌面壳轮询到就重新注册，结果写回 status。
   * 不在这里直接注册 —— 注册是 Electron 主进程的事，服务进程里没这个能力。
   */
  add(['POST'], ['/api/v2/sync/hotkey'], (ctx) => {
    const raw = ctx.body?.accelerator ?? ctx.query?.accelerator;
    const r = requestHotkey(raw);
    if (!r.ok) throw new ApiError(ERR.INVALID, r.error, 200, { field: 'accelerator' });
    return ok({ requested: r.accelerator, status: readHotkeyStatus() });
  });

  /* ============================ 4.8 应用中心：扩展管理（0.4.3） ============================ */
  /**
   * 对手这块在云端（`/api/v1/application/list`、下载走它家 CDN），我们没有也不转发别人的分发，
   * 所以是**本地自己的一套**：库在本地（`<数据根>/ext_env/<id>/` 全局共享一份），
   * 启用状态按环境勾选（`profile_extensions`）。加载发生在环境启动后（CDP Extensions.loadUnpacked），
   * 不是 `--load-extension`（那条在 Chrome 157 已失效，见 src/kernel/extensions.js）。
   */

  add(['GET', 'POST'], ['/api/v2/app/list'], () => ok({ list: listExtensions() }));

  add(['POST'], ['/api/v2/app/import'], (ctx) => {
    try {
      const r = importExtension(ctx.body.path ?? ctx.body.source_path, {
        name: ctx.body.name,
        status: ctx.body.status,
      });
      return ok({ ...r.extension, duplicate: r.duplicate, warnings: r.warnings });
    } catch (e) {
      throw new ApiError(ERR.INVALID, e.message);
    }
  });

  add(['POST'], ['/api/v2/app/update'], (ctx) => {
    const id = String(ctx.body.id ?? ctx.body.ext_id ?? ctx.body.ids ?? '');
    if (!id) throw new ApiError(ERR.INVALID, 'id is required');
    try {
      const r = updateExtension(id, { status: ctx.body.status, name: ctx.body.name });
      if (!r) throw new ApiError(ERR.NOT_FOUND, 'extension not found');
      return ok(r);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(ERR.INVALID, e.message);
    }
  });

  add(['POST'], ['/api/v2/app/delete'], (ctx) => {
    const ids = idList(ctx.body.ids ?? ctx.body.id ?? ctx.body.ext_ids, 'v2');
    if (!ids.length) throw new ApiError(ERR.INVALID, 'ids is required');
    /**
     * 正在跑的环境里可能正加载着它：**允许删**（文件删了内核不会崩），
     * 但必须如实回「哪些运行中的环境要到重启才真的没有」，不能让用户以为立刻生效。
     */
    const running = listRunning().map((i) => i.profile_id);
    const affected = new Set();
    for (const pid of running) {
      for (const extId of profileExtensionIds(pid)) if (ids.includes(extId)) affected.add(pid);
    }
    try {
      return ok({ ...deleteExtensions(ids), running_affected: [...affected] });
    } catch (e) {
      throw new ApiError(ERR.INVALID, e.message);
    }
  });

  /** 某个环境勾了哪些扩展（含库级停用的，用 enabled 区分；界面上不隐藏） */
  add(['GET', 'POST'], ['/api/v2/app/profile'], (ctx) => {
    const p = resolveProfile(ctx, 'v2');
    const list = profileExtensions(p.id);
    return ok({
      profile_id: p.id,
      list,
      ext_ids: list.filter((x) => x.enabled).map((x) => x.id),
      all_ext_ids: list.map((x) => x.id),
    });
  });

  /**
   * 全量替换某个环境启用的扩展。环境在跑时要重启才生效 —— 如实回 restart_required
   *
   * 这是**全量替换**语义，所以「字段没给」和「给了空数组」必须分开：
   * 早先写成 `ctx.body.ext_ids ?? ctx.body.ids`，字段名拼错（比如 extension_ids）时取到 undefined
   * → 被当成空数组 → **把用户勾选全清掉还回 code=0**。这就是静默截断那一类错：
   * 用户/脚本写错了名字，东西没了，界面还显示成功。
   * 现在两个字段都不存在就报错，**只有显式传 [] 才算清空**。
   */
  add(['POST'], ['/api/v2/app/profile/set'], (ctx) => {
    const p = resolveProfile(ctx, 'v2');
    const hasExtIds = ctx.body?.ext_ids !== undefined && ctx.body?.ext_ids !== null;
    const hasIds = ctx.body?.ids !== undefined && ctx.body?.ids !== null;
    if (!hasExtIds && !hasIds) {
      throw new ApiError(ERR.INVALID, 'ext_ids is required（要清空请显式传 []）', 200, { field: 'ext_ids' });
    }
    const ids = idList(hasExtIds ? ctx.body.ext_ids : ctx.body.ids, 'v2');
    try {
      const saved = setProfileExtensions(p.id, ids);
      return ok({ profile_id: p.id, ext_ids: saved, restart_required: !!getRunning(p.id) });
    } catch (e) {
      throw new ApiError(ERR.INVALID, e.message);
    }
  });

  /* ============================ 5. 占位：明确不支持 ============================ */
  const placeholders = [
    '/api/v1/application/list', '/api/v2/category/list',
    '/api/v1/fb/list', '/api/v1/fb/page', '/api/v1/fb/bm',
    '/api/v2/browser-profile/share',
    '/api/v2/browser-profile/update-patch',
    '/api/v2/user/create', '/api/v2/user/update', '/api/v2/user/reset_password',
    '/api/v2/user/delete', '/api/v2/user/list', '/api/v2/user-group/list',
    '/api/v2/proxy/dynamic-proxy-traffic',
  ];
  // `unsupported: true` 让「API & MCP」页能把这些标成「明确不支持」——
  // 标记只加在真的会抛 -1 的路由上，不靠路径猜。
  for (const p of placeholders) add(['GET', 'POST'], [p], notImplemented(p), { unsupported: true });

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
