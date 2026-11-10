/**
 * 批量启停：多账号用户的核心场景（一次起 10 个 / 一次全停）。
 *
 * 两个硬要求（CEO 定的）：
 *   1. 并发上限 —— 不是开 10 个线程硬冲，默认 3，可传 concurrency 覆盖（夹在 1..10）。
 *   2. 可中断 —— 起的过程中有一个失败，**后面的不再硬起**，返回已经起来的清单、
 *      失败原因、以及没轮到的清单。用户能立刻知道「哪些成了」，而不是等 10 个全超时。
 *
 * 停不中断：停失败一个不影响停下一个（停是收敛操作，越多停掉越好）。
 */
import { startProfile, stopProfile, getRunning } from './manager.js';
import { getProfile } from '../store/profiles.js';
import { BATCH_CONCURRENCY } from '../config.js';

const MAX_CONCURRENCY = 10;

export function clampConcurrency(v, fallback = BATCH_CONCURRENCY) {
  const n = Number(v);
  if (!Number.isFinite(n)) return Math.min(Math.max(1, fallback || 3), MAX_CONCURRENCY);
  return Math.min(Math.max(1, Math.trunc(n)), MAX_CONCURRENCY);
}

function normalizeIds(raw) {
  const arr = Array.isArray(raw) ? raw : raw == null ? [] : String(raw).split(',');
  const out = [];
  for (const v of arr) {
    const s = String(v ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * @returns {{
 *   requested:number, concurrency:number, interrupted:boolean, elapsed_ms:number,
 *   started:object[], already_running:string[], failed:{profile_id:string,code:number,reason?:string,message:string}[],
 *   skipped:string[]
 * }}
 */
export async function batchStart(inputIds, { force = false, concurrency = BATCH_CONCURRENCY, stopOnError = true } = {}) {
  const ids = normalizeIds(inputIds);
  const limit = clampConcurrency(concurrency);
  const at = Date.now();

  const started = [];
  const alreadyRunning = [];
  const failed = [];
  const skipped = [];
  const queue = [...ids];
  let interrupted = false;

  async function worker() {
    for (;;) {
      // 中断检查放在取任务之前：已经失败过就不再领新任务，剩下的原样留给 skipped
      if (interrupted) return;
      const id = queue.shift();
      if (!id) return;

      const live = getRunning(id);
      if (live) {
        alreadyRunning.push(id);
        started.push({ profile_id: id, already_running: true, pid: live.pid, ws: live.ws, debug_port: live.debug_port });
        continue;
      }
      const p = getProfile(id);
      if (!p) {
        failed.push({ profile_id: id, code: 100001, message: 'Profile does not exist' });
        if (stopOnError) interrupted = true;
        continue;
      }
      try {
        const data = await startProfile({ ...p, id }, { force });
        started.push({
          profile_id: id,
          already_running: false,
          pid: data.pid,
          ws: data.ws,
          debug_port: data.debug_port,
          warnings: data.warnings || [],
        });
      } catch (e) {
        failed.push({
          profile_id: id,
          code: e.code || 800003,
          reason: e.reason,
          message: e.message || 'start failed',
        });
        if (stopOnError) interrupted = true;
      }
    }
  }

  const workers = Math.min(limit, Math.max(queue.length, 1));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (queue.length) skipped.push(...queue.splice(0));

  // 结果按请求顺序排，日志/断言更稳
  const order = (a, b) => ids.indexOf(a.profile_id) - ids.indexOf(b.profile_id);
  started.sort(order);
  failed.sort(order);

  return {
    requested: ids.length,
    concurrency: limit,
    interrupted: interrupted && skipped.length > 0,
    elapsed_ms: Date.now() - at,
    started,
    already_running: alreadyRunning,
    failed,
    skipped,
  };
}

export async function batchStop(inputIds, { concurrency = 5 } = {}) {
  const ids = normalizeIds(inputIds);
  const limit = clampConcurrency(concurrency, 5);
  const at = Date.now();
  const stopped = [];
  const notRunning = [];
  const failed = [];
  const queue = [...ids];

  async function worker() {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      try {
        const r = await stopProfile(id);
        if (r.stopped) stopped.push(id);
        else notRunning.push(id);
      } catch (e) {
        failed.push({ profile_id: id, message: e.message || 'stop failed' });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, Math.max(queue.length, 1)) }, () => worker()));
  const order = (a, b) => ids.indexOf(String(a)) - ids.indexOf(String(b));
  stopped.sort(order);
  notRunning.sort(order);

  return {
    requested: ids.length,
    concurrency: limit,
    elapsed_ms: Date.now() - at,
    stopped,
    not_running: notRunning,
    failed,
  };
}