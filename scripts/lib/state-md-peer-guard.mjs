/**
 * state-md-peer-guard.mjs — Issue #588 (STATE.md peer-guard)
 *
 * Belt-and-suspenders defense for session-start Phase 1b.
 *
 * Even with parallel-aware-preamble (Phase 0.5) and session-lock acquire
 * (Phase 1.2) in place, a session can miss an active peer when:
 *   - The peer's session.lock was force-deleted (stale-PID sweep) but
 *     STATE.md still shows status:active.
 *   - A registry entry was orphaned but not yet swept.
 *
 * `checkPeerStateMd` reads the repo's STATE.md frontmatter and reports
 * whether a *different* active session currently owns it.  Callers
 * (session-start Phase 1b, skill body) use the result to decide whether to
 * fire the Worktree-Promotion AUQ before overwriting STATE.md.
 *
 * Never throws — all errors are surfaced via the `reason` field with value
 * `'malformed-state-md'` so callers can always act on the return value.
 *
 * @module state-md-peer-guard
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStateMd } from './state-md.mjs';

// ---------------------------------------------------------------------------
// Canonical STATE.md path candidates (same order as frontmatter-mutators.mjs)
// ---------------------------------------------------------------------------

const STATE_MD_CANDIDATES = ['.claude/STATE.md', '.codex/STATE.md', '.cursor/STATE.md'];

/**
 * Resolve the first existing STATE.md path under repoRoot.
 * Falls back to `.claude/STATE.md` when none exist.
 *
 * @param {string} repoRoot
 * @returns {string}  Absolute path (may not exist on disk).
 */
function _resolveStateMdPath(repoRoot) {
  for (const candidate of STATE_MD_CANDIDATES) {
    const abs = join(repoRoot, candidate);
    if (existsSync(abs)) return abs;
  }
  return join(repoRoot, STATE_MD_CANDIDATES[0]);
}

// ---------------------------------------------------------------------------
// Age calculation helper
// ---------------------------------------------------------------------------

/**
 * Return age in decimal hours from an ISO-8601 `started_at` string to now.
 * Returns Infinity on unparseable input so callers treat malformed dates as
 * "very old" (safe-side: allow overwrite).
 *
 * @param {string|null|undefined} startedAt
 * @returns {number}  Hours elapsed (may be Infinity).
 */
function _ageHoursFromStartedAt(startedAt) {
  if (typeof startedAt !== 'string' || startedAt.trim() === '') return Infinity;
  const ms = Date.now() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms)) return Infinity;
  return ms / (1000 * 60 * 60);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect whether a peer session owns the current repo's STATE.md.
 *
 * Decision tree:
 *  1. File missing            → { peer: null, reason: 'no STATE.md' }
 *  2. Malformed frontmatter   → { peer: null, reason: 'malformed-state-md' }
 *  3. status completed|idle   → { peer: null, reason: 'status: <X>' }
 *  4. status active + session === mySessionId
 *                             → { peer: null, reason: 'own session' }
 *  5. status active + different session + age > maxAgeHours
 *                             → { peer: null, reason: 'ABANDONED (age > maxAgeHours)' }
 *  6. status active + different session + age ≤ maxAgeHours
 *                             → { peer: { sessionId, startedAt, currentWave, mode, ageHours },
 *                                  reason: 'ACTIVE peer detected' }
 *
 * @param {string}      repoRoot     Absolute path to the repository root.
 * @param {string|null} mySessionId  Current session's id (UUID or semantic);
 *                                   null means "no session yet" — any active
 *                                   session counts as a peer.
 * @param {object}      [opts]
 * @param {number}      [opts.maxAgeHours=4]  STATE.md older than this is
 *                                             treated as abandoned (allow overwrite).
 * @returns {{
 *   peer: {
 *     sessionId:   string,
 *     startedAt:   string,
 *     currentWave: number,
 *     mode:        string|null,
 *     ageHours:    number
 *   } | null,
 *   reason: string | null
 * }}
 */
export function checkPeerStateMd(repoRoot, mySessionId, opts = {}) {
  const maxAgeHours =
    typeof opts.maxAgeHours === 'number' && opts.maxAgeHours > 0 ? opts.maxAgeHours : 4;

  // ------------------------------------------------------------------
  // Step 1: resolve + read STATE.md
  // ------------------------------------------------------------------
  const stateMdPath = _resolveStateMdPath(repoRoot);

  let raw;
  try {
    raw = readFileSync(stateMdPath, 'utf8');
  } catch (err) {
    // ENOENT is expected for fresh repos; other FS errors also treated as
    // "no STATE.md" — fail-open (allow overwrite) rather than blocking.
    if (err.code === 'ENOENT') {
      return { peer: null, reason: 'no STATE.md' };
    }
    return { peer: null, reason: 'no STATE.md' };
  }

  // ------------------------------------------------------------------
  // Step 2: parse frontmatter (parseStateMd never throws per its contract)
  // ------------------------------------------------------------------
  let parsed;
  try {
    parsed = parseStateMd(raw);
  } catch {
    return { peer: null, reason: 'malformed-state-md' };
  }

  if (parsed === null || parsed.frontmatter === null) {
    return { peer: null, reason: 'malformed-state-md' };
  }

  const fm = parsed.frontmatter;

  // ------------------------------------------------------------------
  // Step 3: check status field
  // ------------------------------------------------------------------
  const status = typeof fm.status === 'string' ? fm.status.toLowerCase().trim() : '';

  if (status === 'completed' || status === 'idle') {
    return { peer: null, reason: `status: ${status}` };
  }

  // Any non-active value (missing, unknown) → treat as non-blocking.
  if (status !== 'active') {
    return { peer: null, reason: `status: ${status || 'unknown'}` };
  }

  // ------------------------------------------------------------------
  // Step 4: check session identity
  // ------------------------------------------------------------------
  // PRECONDITION (invariant): `mySessionId` and `fm.session` MUST be expressed
  // in the SAME id-space (both semantic OR both UUID). The equality check below
  // is plain string-equality — a semantic-vs-UUID mismatch for the SAME logical
  // session would be misclassified as a foreign peer (fail-safe: extra AUQ, never
  // a missed peer). When `mySessionId === null` ("no session yet"), the ownership
  // short-circuit is skipped and any active session with a `session` field counts
  // as a peer.
  const sessionField = typeof fm.session === 'string' ? fm.session : null;

  // No session field → cannot identify a peer; allow overwrite.
  if (sessionField === null) {
    return { peer: null, reason: 'no session field' };
  }

  // Session matches ours → we own STATE.md already.
  if (mySessionId !== null && sessionField === mySessionId) {
    return { peer: null, reason: 'own session' };
  }

  // ------------------------------------------------------------------
  // Step 5: check age of the active entry
  // ------------------------------------------------------------------
  const startedAt = typeof fm['started_at'] === 'string' ? fm['started_at'] : null;
  const ageHours = _ageHoursFromStartedAt(startedAt);

  if (ageHours > maxAgeHours) {
    return { peer: null, reason: 'ABANDONED (age > maxAgeHours)' };
  }

  // ------------------------------------------------------------------
  // Step 6: active peer detected
  // ------------------------------------------------------------------
  const currentWave = typeof fm['current-wave'] === 'number' ? fm['current-wave'] : 0;
  // `session-type` is the frontmatter key used for mode (e.g. 'deep', 'feature').
  const mode = typeof fm['session-type'] === 'string' ? fm['session-type'] : null;

  return {
    peer: {
      sessionId: sessionField,
      startedAt: startedAt ?? '',
      currentWave,
      mode,
      ageHours,
    },
    reason: 'ACTIVE peer detected',
  };
}
