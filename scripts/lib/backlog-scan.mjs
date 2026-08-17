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
 *  - No silent caps: the scan reads at most `limit` issues, so every count is a
 *    LOWER BOUND when the window fills. `truncated` says so in the return value
 *    and a WARNING says so on stderr — a bound that is applied is announced.
 *
 * Stale threshold: 30 days since `updated_at`.
 *
 * Dependencies:
 *  - VCS detection follows `skills/gitlab-ops/SKILL.md` (origin URL contains "github.com" → gh, else glab).
 */

import { spawnSync } from 'node:child_process';

import { warn } from './common.mjs';
import { normalizeLabel } from './label-scope.mjs';
import { resolveRepoSpec } from './vcs-repo-spec.mjs';

export const STALE_THRESHOLD_DAYS = 30;

/**
 * Default scan window, and the SINGLE source for that number — every caller
 * either omits `limit` or imports this constant. A second hand-written copy is
 * what made the old default wrong in three places at once.
 *
 * Ceiling: 100 is the largest single-request page BOTH CLIs serve reliably
 * (the GitLab API clamps `per_page` at 100), so it is the widest exact window
 * available without paginating. Above it the scan truncates — `truncated: true`
 * plus a stderr WARNING announce that, and every count becomes a lower bound.
 * Revisit with a `--page` loop if a repo's OPEN backlog routinely exceeds 100.
 */
export const DEFAULT_BACKLOG_LIMIT = 100;

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
 * `total` is the number of records AGGREGATED, never the number of records that
 * exist in the tracker — the caller decides the window, so only the caller
 * (or `scanBacklog`'s `truncated` flag) can tell the two apart.
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
      // Scope-tolerant: the canonical spelling is the scoped `priority::<level>`,
      // but the label-data migration trails the producer migration, so issues
      // carrying the legacy `priority:<level>` must keep counting.
      const key = normalizeLabel(name);
      if (key === 'priority:critical') criticalCount += 1;
      else if (key === 'priority:high') highCount += 1;
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
 * `signals.backlog`. Caches the result per (vcs, limit, spec) within the
 * running process — `spec` (the resolved `-R`/`--repo` host-pinning value,
 * #872) is part of the cache key so two different repos scanning the SAME
 * (vcs, limit) pair never collide on a shared cache entry.
 *
 * Returns null on any of:
 *  - VCS cannot be detected (no git origin)
 *  - CLI binary missing (`glab` for gitlab, `gh` for github)
 *  - CLI exits non-zero or produces unparsable output
 *
 * Never throws.
 *
 * The scan reads at most `limit` records (default `DEFAULT_BACKLOG_LIMIT`), so
 * every count is a LOWER BOUND once the window fills. `truncated` reports that:
 * `true` means the CLI returned a full window, so records — and the critical /
 * high / stale issues among them — may lie beyond it. It is deliberately
 * conservative: a backlog of exactly `limit` issues reports `truncated: true`
 * even though nothing was missed. Over-reporting "you may have missed some" is
 * safe; under-reporting it is the bug this flag exists to prevent.
 *
 * @param {{
 *   limit?: number,
 *   vcs?: 'github'|'gitlab'|null,
 *   nowMs?: number,
 *   repoRoot?: string,
 *   resolveRepoSpecFn?: (opts: { repoRoot: string, vcs: 'gitlab'|'github' }) => string | undefined,
 *   runJsonFn?: (bin: string, args: string[]) => Array | null
 * }} [opts]
 *   `repoRoot` defaults to `process.cwd()`. `resolveRepoSpecFn` is the
 *   injectable seam for the `-R`/`--repo` host-pinning resolution (#872) —
 *   defaults to the real `resolveRepoSpec` (shells out to `git remote
 *   get-url`); tests inject a stub instead of shelling out. `runJsonFn` is
 *   the injectable seam for the CLI runner — defaults to the real `runJson`
 *   (shells out to `glab`/`gh`).
 * @returns {Promise<null | {criticalCount: number, highCount: number, staleCount: number, byLabel: Record<string, number>, total: number, vcs: string, limit: number, truncated: boolean}>}
 */
export async function scanBacklog(opts = {}) {
  const limit =
    Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_BACKLOG_LIMIT;
  // Distinguish "user did not pass vcs" (auto-detect) from "user explicitly passed
  // null" (degrade). 'vcs' in opts catches the explicit-null path so callers can
  // force the no-vcs branch in tests without monkey-patching detectVcs.
  const vcs = 'vcs' in opts ? opts.vcs : detectVcs();
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();

  if (vcs !== 'github' && vcs !== 'gitlab') return null;

  const repoRoot = typeof opts.repoRoot === 'string' ? opts.repoRoot : process.cwd();
  const resolveRepoSpecFn =
    typeof opts.resolveRepoSpecFn === 'function' ? opts.resolveRepoSpecFn : resolveRepoSpec;
  const runJsonFn = typeof opts.runJsonFn === 'function' ? opts.runJsonFn : runJson;

  // Resolve the -R/--repo host-pinning spec ONCE (#872), mirroring the
  // #839 idiom in spiral-carryover.mjs / issue-close-strip-labels.mjs.
  const spec = resolveRepoSpecFn({ repoRoot, vcs });

  const cacheKey = JSON.stringify({ vcs, limit, spec });
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);

  const bin = vcs === 'github' ? 'gh' : 'glab';
  const args =
    vcs === 'github'
      ? ['issue', 'list', '--limit', String(limit), '--json', 'number,labels,updatedAt,state']
      : ['issue', 'list', '--per-page', String(limit), '--output', 'json'];
  if (spec) args.push('-R', spec);

  const issues = runJsonFn(bin, args);
  if (issues === null) {
    _cache.set(cacheKey, null);
    return null;
  }

  // A full window means records may lie beyond it, so every count is a lower
  // bound. `>=` (not `> `) because the CLIs cap silently: the GitLab API clamps
  // `per_page` at 100, so an over-fetch of `limit + 1` would come back capped
  // and read as "not truncated" — under-approximating exactly the way the
  // window itself did. A full window is the only signal that survives clamping.
  const truncated = issues.length >= limit;

  const summary = summarizeIssues(issues, nowMs);
  const result = { ...summary, vcs, limit, truncated };

  // Announce the bound (never a silent cap). Emitted once per cache key — a
  // cache hit returns before this point, so a per-session scan warns once.
  if (truncated) {
    warn(
      `backlog scan filled its ${limit}-issue window (${bin}): criticalCount/highCount/staleCount are LOWER BOUNDS. ` +
        `Pass a larger limit for exact counts.`
    );
  }

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
