/**
 * build-live-signals.mjs — Phase C-1.c (issue #301).
 *
 * Assembles the Signals object consumed by `selectMode` in `mode-selector.mjs`.
 * Composes six source modules, each wrapped in its own graceful-null branch so
 * a single failure does not blow up the entire helper.
 *
 * Design contract:
 *  - Pure async function. Never throws. Six graceful-null branches.
 *  - Synchronous file I/O for STATE.md / sessions.jsonl / bootstrap.lock.
 *    The async wrapper exists only because `scanBacklog` is async.
 *  - Logging is NOT this helper's job — silent graceful-null on every error.
 *  - Relative paths resolve against `opts.repoRoot` (which itself defaults to
 *    process.cwd()); an explicit ABSOLUTE path always wins over the root.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseStateMd, parseRecommendations } from './state-md.mjs';
import { normalizeSession, tailRealSessions } from './session-schema.mjs';
import { parseBootstrapLock } from './bootstrap-lock-freshness.mjs';
import { scanBacklog, DEFAULT_BACKLOG_LIMIT } from './backlog-scan.mjs';
import { readCanonicalSessions } from './sessions-canonical.mjs';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * buildLiveSignals — assembles the Signals object consumed by selectMode.
 *
 * Pure async function. Never throws. Six graceful-null branches matching the
 * v1 schema additive convention: any missing source contributes the appropriate
 * null/[] value to the Signals object.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]       — absolute project root every relative
 *   path below resolves against, and the root forwarded to `scanBacklog`.
 *   Defaults to `process.cwd()`. Without it (#1071) a caller running from a
 *   worktree or a subdirectory silently read a DIFFERENT repo's STATE.md and
 *   sessions.jsonl than the one it was reporting on — measured as
 *   `recentSessions: []` against a checkout holding 245 session records.
 *   An explicit absolute `statePath`/`sessionsPath`/`lockPath` still wins.
 * @param {string} [opts.statePath]      — defaults to '<repoRoot>/.claude/STATE.md'
 * @param {string} [opts.sessionsPath]   — defaults to '<repoRoot>/.orchestrator/metrics/sessions.jsonl'
 * @param {string} [opts.lockPath]       — defaults to '<repoRoot>/.orchestrator/bootstrap.lock'
 * @param {Array}  [opts.learnings]      — pre-surfaced top-N learnings; defaults to []
 * @param {number} [opts.backlogLimit]   — passed to scanBacklog; defaults to
 *   `DEFAULT_BACKLOG_LIMIT` from backlog-scan.mjs (never a local copy of that
 *   number). A window smaller than the repo's open backlog makes
 *   `backlog.criticalCount`/`highCount`/`staleCount` lower bounds —
 *   `backlog.truncated` is the flag that says so.
 * @param {number} [opts.sessionTailN]   — defaults to 10 (last N sessions)
 * @param {Function} [opts._scanBacklog] — injectable seam for tests (defaults to scanBacklog)
 * @returns {Promise<import('./mode-selector.mjs').Signals>}
 */
export async function buildLiveSignals(opts = {}) {
  const repoRoot =
    typeof opts.repoRoot === 'string' && opts.repoRoot.length > 0
      ? opts.repoRoot
      : process.cwd();
  // `resolve(root, p)` returns `p` unchanged when `p` is absolute — explicit
  // per-file overrides therefore keep precedence over repoRoot.
  const statePath = resolve(
    repoRoot,
    typeof opts.statePath === 'string' ? opts.statePath : '.claude/STATE.md'
  );
  const sessionsPath = resolve(
    repoRoot,
    typeof opts.sessionsPath === 'string'
      ? opts.sessionsPath
      : '.orchestrator/metrics/sessions.jsonl'
  );
  const lockPath = resolve(
    repoRoot,
    typeof opts.lockPath === 'string' ? opts.lockPath : '.orchestrator/bootstrap.lock'
  );
  const learnings = Array.isArray(opts.learnings) ? opts.learnings : [];
  const backlogLimit = typeof opts.backlogLimit === 'number' && opts.backlogLimit > 0
    ? opts.backlogLimit
    : DEFAULT_BACKLOG_LIMIT;
  const sessionTailN = typeof opts.sessionTailN === 'number' && opts.sessionTailN > 0
    ? opts.sessionTailN
    : 10;
  const _scan = typeof opts._scanBacklog === 'function' ? opts._scanBacklog : scanBacklog;

  // --- Branch 1 + 2: STATE.md recommendations ---
  let recommendedMode = null;
  let topPriorities = null;
  let carryoverRatio = null;
  let completionRate = null;
  let previousRationale = null;

  try {
    if (existsSync(statePath)) {
      const contents = readFileSync(statePath, 'utf8');
      const parsed = parseStateMd(contents);
      if (parsed !== null) {
        const rec = parseRecommendations(parsed.frontmatter);
        if (rec !== null) {
          recommendedMode = rec.mode;
          topPriorities = rec.priorities;
          carryoverRatio = rec.carryoverRatio;
          completionRate = rec.completionRate;
          previousRationale = rec.rationale;
        }
      }
    }
  } catch {
    // Branch 1: file unreadable — all fields stay null
  }

  // --- Branch 3 + 4: sessions.jsonl ---
  let recentSessions = [];

  try {
    // #1186: readCanonicalSessions applies the #1167 newest-wins-per-`session_id`
    // / attestable-`supersedes` collapse BEFORE the tail is taken. The raw read
    // this replaced parsed every line unconditionally (malformed lines skipped
    // on JSON.parse failure only), so a duplicated `session_id` — a
    // crash-recovery re-append, or the #1068 abandoned-stub/supersede pair —
    // counted as TWO entries toward `sessionTailN`, silently narrowing the
    // REAL window by however many duplicates sat in the file's tail.
    //
    // Behavioural change: a well-formed record with NO `session_id` (never
    // legitimate per REQUIRED_FIELDS, but possible on a hand-edited or
    // pre-schema legacy line) is now DROPPED rather than counted — it cannot
    // be deduplicated by identity, so `canonicalizeSessions` excludes it (see
    // sessions-canonical.mjs's own contract). Missing-file / unreadable-file
    // handling (ENOENT vs EACCES/EISDIR, #1188) is delegated to the shared
    // reader; both still degrade to `[]` here, matching Branch 3's contract.
    const canonical = readCanonicalSessions({ filePath: sessionsPath });
    const parsed = canonical.map((obj) => normalizeSession(obj));
    // #834: `status: 'abandoned'` phantom stubs must still be filtered out
    // BEFORE the tail is taken, or sessionTailN silently means "last N LINES"
    // instead of "last N REAL sessions". tailRealSessions() does the filter +
    // tail.
    recentSessions = tailRealSessions(parsed, sessionTailN);
  } catch {
    // Branch 3: file unreadable — recentSessions stays [] (readCanonicalSessions
    // itself never throws, but the graceful-null contract is kept as a backstop).
  }

  // --- Branch 5: bootstrap.lock ---
  let bootstrapLock = null;

  try {
    if (existsSync(lockPath)) {
      const contents = readFileSync(lockPath, 'utf8');
      bootstrapLock = parseBootstrapLock(contents);
    }
  } catch {
    // Branch 5: file unreadable — bootstrapLock stays null
  }

  // --- Branch 6: backlog scan ---
  let backlog = null;

  try {
    // `repoRoot` is forwarded so VCS detection and the `-R` host-pinning spec
    // inside scanBacklog answer about the SAME repo the signals describe.
    backlog = await _scan({ limit: backlogLimit, repoRoot });
  } catch {
    // Branch 6: scanBacklog threw — backlog stays null
  }

  return {
    recommendedMode,
    topPriorities,
    carryoverRatio,
    completionRate,
    previousRationale,
    recentSessions,
    bootstrapLock,
    learnings,
    backlog,
    vaultStaleness: null,
  };
}
