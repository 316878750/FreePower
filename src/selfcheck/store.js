/**
 * 自检报告落盘：data/selfchecks/<profile_id>.json
 *
 * 只留最近 5 份摘要 + 最新完整报告。跨重启一致性比对靠这里的历史哈希，
 * 不写库（报告是诊断产物，不是业务数据）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

const dir = () => path.join(DATA_DIR, 'selfchecks');

function fileFor(profileId) {
  return path.join(dir(), `${String(profileId).replace(/[^\w.-]/g, '_')}.json`);
}

/** @returns {{latest: object|null, history: object[]}} */
export function readReportFile(profileId) {
  try {
    const j = JSON.parse(fs.readFileSync(fileFor(profileId), 'utf8'));
    if (j && j.latest) return { latest: j.latest, history: Array.isArray(j.history) ? j.history : [] };
  } catch { /* 第一次跑 */ }
  return { latest: null, history: [] };
}

/** 上一份「同环境」报告（跨重启一致性比对用） */
export function loadPrevious(profileId) {
  return readReportFile(profileId).latest;
}

/** 报告里不需要进历史的字段（raw 很大） */
function slim(report) {
  if (!report) return null;
  return {
    generated_at: report.generated_at,
    kernel_version: report.kernel_version,
    seed: report.seed,
    summary: report.summary,
    determinism: report.determinism,
    hashes: report.hashes,
  };
}

export function saveReport(report) {
  if (!report || !report.profile_id) return null;
  try {
    const prev = readReportFile(report.profile_id);
    const history = [slim(prev.latest), ...prev.history].filter(Boolean).slice(0, 4);
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(fileFor(report.profile_id), JSON.stringify({ latest: report, history }, null, 2));
    return report;
  } catch (e) {
    // 落盘失败不能影响自检结果，但必须留下痕迹，否则「跨重启一致」永远查不出来
    try { console.warn(`[selfcheck] 报告落盘失败：${e.message}`); } catch { /* ignore */ }
    return null;
  }
}

/** 报告摘要（进 start 响应，别把整份报告塞进去） */
export function summarize(report) {
  if (!report) return null;
  return {
    ok: report.summary.fail === 0,
    score: report.summary.score,
    total: report.summary.total,
    pass: report.summary.pass,
    warn: report.summary.warn,
    fail: report.summary.fail,
    full: report.summary.full,
    partial: report.summary.partial,
    none: report.summary.none,
    hashes: report.hashes,
    determinism: report.determinism,
    generated_at: report.generated_at,
    report_url: `/api/v2/browser-profile/selfcheck?profile_id=${report.profile_id}`,
  };
}