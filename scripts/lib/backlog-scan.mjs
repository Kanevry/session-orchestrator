/**
 * backlog-scan.mjs — VCS backlog signal source for Mode-Selector (Phase B-3, issue #293).
 *
 * Provides `scanBacklog({limit, vcs})` returning structured counts derived from the
 * project's open-issue list via `glab` (GitLab) or `gh` (GitHub). The result is fed
 * into `signals.backlog` consumed by `selectMode` in `mode-selector.mjs`.
 *
 * Design contract:
 *  - Pure structural counts, never raw issue objects (keeps the selector pure).
 *  - Module-level cache keyed on (vcs, limit) — one VCS round-trip per session.
 *  - Graceful degradation: missing CLI / non-zero exit / parse failure → null.
 *    Never throws to the caller.
 *
 * Stale threshold: 30 days since `updated_at`.
 *
 * Dependencies:
 *  - VCS detection follows `skills/gitlab-ops/SKILL.md` (origin URL contains "github.com" → gh, else glab).
 */

import { spawnSync } from 'node:child_process';

export const STALE_THRESHOLD_DAYS = 30;

/** Module-level cache. Keyed by JSON.stringify({vcs, limit}). */
const _cache = new Map();

/**
 * Detect the VCS for the current working directory by inspecting the origin URL.
 * Returns 'github' | 'gitlab' | null. Never throws.
 *
 * @returns {'github'|'gitlab'|null}
 */
export function detectVcs() {
  try {
    const r = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    const url = String(r.stdout || '').trim();
    if (!url) return null;
    return url.includes('github.com') ? 'github' : 'gitlab';
  } catch {
    return null;
  }
}

/**
 * Run a CLI command and parse stdout as JSON. Returns null on any failure
 * (binary missing, non-zero exit, empty stdout, unparsable JSON, non-array).
 * spawnSync sets `r.status = null` and `r.error.code = 'ENOENT'` when the
 * binary is absent — the `r.status !== 0` check covers that path.
 *
 * @param {string} bin
 * @param {string[]} args
 * @returns {Array|null}
 */
function runJson(bin, args) {
  try {
    const r = spawnSync(bin, args, { encoding: 'utf8' });
    if (r.status !== 0) return null;
    const out = String(r.stdout || '').trim();
    if (!out) return null;
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Compute days elapsed between an ISO-8601 timestamp and `now`.
 * Returns Infinity if the input is unparsable so unparsable dates never count
 * as "fresh".
 *
 * @param {string|undefined|null} iso
 * @param {number} nowMs
 * @returns {number}
 */
function ageDays(iso, nowMs) {
  if (!iso || typeof iso !== 'string') return Infinity;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity;
  return (nowMs - t) / 86_400_000;
}

/**
 * Aggregate a list of issue records into the structural backlog summary.
 *
 * Issue shape requirements (tolerant — missing fields are skipped):
 *  - `labels`: array of strings OR array of {name: string} objects
 *  - `updated_at` (glab) or `updatedAt` (gh): ISO-8601 timestamp
 *
 * @param {Array<object>} issues
 * @param {number} nowMs — injected for tests
 * @returns {{criticalCount: number, highCount: number, staleCount: number, byLabel: Record<string, number>, total: number}}
 */
export function summarizeIssues(issues, nowMs = Date.now()) {
  let criticalCount = 0;
  let highCount = 0;
  let staleCount = 0;
  const byLabel = {};

  for (const issue of issues) {
    if (!issue || typeof issue !== 'object') continue;

    const rawLabels = Array.isArray(issue.labels) ? issue.labels : [];
    const labelNames = rawLabels
      .map((l) => (typeof l === 'string' ? l : l && typeof l === 'object' ? l.name : null))
      .filter((n) => typeof n === 'string' && n.length > 0);

    for (const name of labelNames) {
      byLabel[name] = (byLabel[name] || 0) + 1;
      if (name === 'priority:critical') criticalCount += 1;
      else if (name === 'priority:high') highCount += 1;
    }

    const updated = issue.updated_at || issue.updatedAt || null;
    if (ageDays(updated, nowMs) > STALE_THRESHOLD_DAYS) staleCount += 1;
  }

  return {
    criticalCount,
    highCount,
    staleCount,
    byLabel,
    total: issues.length,
  };
}

/**
 * Scan the project's open backlog and return a structural summary suitable for
 * `signals.backlog`. Caches the result per (vcs, limit) within the running process.
 *
 * Returns null on any of:
 *  - VCS cannot be detected (no git origin)
 *  - CLI binary missing (`glab` for gitlab, `gh` for github)
 *  - CLI exits non-zero or produces unparsable output
 *
 * Never throws.
 *
 * @param {{limit?: number, vcs?: 'github'|'gitlab'|null, nowMs?: number}} [opts]
 * @returns {Promise<null | {criticalCount: number, highCount: number, staleCount: number, byLabel: Record<string, number>, total: number, vcs: string, limit: number}>}
 */
export async function scanBacklog(opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 50;
  // Distinguish "user did not pass vcs" (auto-detect) from "user explicitly passed
  // null" (degrade). 'vcs' in opts catches the explicit-null path so callers can
  // force the no-vcs branch in tests without monkey-patching detectVcs.
  const vcs = 'vcs' in opts ? opts.vcs : detectVcs();
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();

  if (vcs !== 'github' && vcs !== 'gitlab') return null;

  const cacheKey = JSON.stringify({ vcs, limit });
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);

  const bin = vcs === 'github' ? 'gh' : 'glab';
  const args =
    vcs === 'github'
      ? ['issue', 'list', '--limit', String(limit), '--json', 'number,labels,updatedAt,state']
      : ['issue', 'list', '--per-page', String(limit), '--output', 'json'];

  const issues = runJson(bin, args);
  if (issues === null) {
    _cache.set(cacheKey, null);
    return null;
  }

  const summary = summarizeIssues(issues, nowMs);
  const result = { ...summary, vcs, limit };
  _cache.set(cacheKey, result);
  return result;
}

/**
 * Test/coordinator helper: clear the in-process cache. Not part of the
 * production surface but exported so tests don't need to reload the module.
 */
export function clearBacklogCache() {
  _cache.clear();
}
