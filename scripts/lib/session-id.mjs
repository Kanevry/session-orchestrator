/**
 * session-id.mjs — Semantic session-ID generation and dual-format parsing.
 *
 * Public API:
 *   - resolveSemanticSessionId({ branch, mode, activeSessions, repoRoot }): Promise<string>
 *   - parseSessionId(id): { format: 'semantic'|'uuid', ...fields, raw } | null
 *   - SEMANTIC_ID_RE — source-of-truth regex for semantic session IDs
 *   - UUID_V4_RE     — regex for UUID-v4 format session IDs
 *
 * Closes #572 — Epic #568 Phase 2.1 (Parallel-Aware Sessions Semantic ID)
 * PRD: docs/prd/2026-05-26-parallel-aware-sessions.md §3 P2 + §3.A P2
 *
 * Design notes:
 *  - resolveSemanticSessionId wraps its body in withStateMdLock so two
 *    concurrent preambles cannot assign duplicate n values (PSA-005).
 *  - parseSessionId is a pure synchronous function — no I/O, no side effects.
 *  - No external dependencies beyond ./session-lock.mjs.
 *  - Production code is silent: no console.log.
 */

import { withStateMdLock } from './session-lock.mjs';

// ---------------------------------------------------------------------------
// Exported regexes (source-of-truth, also consumed by tests/consumers)
// ---------------------------------------------------------------------------

/**
 * Source-of-truth regex for the semantic session-ID format.
 *
 * Groups:
 *   1 — branch   (`[a-z0-9._/-]+`, git branch characters including slashes)
 *   2 — date     (`YYYY-MM-DD`, UTC)
 *   3 — mode     (`[a-z-]+`, lowercase + hyphens)
 *   4 — n        monotonic counter (decimal digits)
 *
 * Note: the branch group is case-insensitive at the regex level, but
 * callers must normalise branches to the form they store in activeSessions.
 *
 * @type {RegExp}
 */
export const SEMANTIC_ID_RE = /^([a-z0-9._/-]+)-(\d{4}-\d{2}-\d{2})-([a-z-]+)-(\d+)$/;

/**
 * Regex for UUID-v4 session IDs.
 *
 * Matches: 8-4-4-4-12 hex digits, version nibble = '4', variant nibble in {8,9,a,b}.
 * Case-insensitive to accept both uppercase and lowercase hex.
 *
 * @type {RegExp}
 */
export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate a git branch name for use in a semantic session ID.
 *
 * Allows the characters that git itself accepts: alphanumerics, dots, dashes,
 * underscores, and forward-slashes (for namespaced branches like feature/foo).
 *
 * @param {string} branch
 * @returns {boolean}
 */
function isValidBranch(branch) {
  return typeof branch === 'string' && branch.length > 0 && /^[a-zA-Z0-9._/-]+$/.test(branch);
}

/**
 * Validate a session mode name.
 *
 * Modes are lowercase ASCII letters and hyphens (e.g. "deep", "feature",
 * "house-keeping"). No uppercase, no underscores, no digits.
 *
 * @param {string} mode
 * @returns {boolean}
 */
function isValidMode(mode) {
  return typeof mode === 'string' && mode.length > 0 && /^[a-z-]+$/.test(mode);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a session ID string into a structured object.
 *
 * Accepts two formats:
 *
 *   1. Semantic: `<branch>-<YYYY-MM-DD>-<mode>-<n>`
 *      Returns `{ format: 'semantic', branch, date, mode, n, raw }`.
 *
 *   2. UUID-v4: `xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx`
 *      Returns `{ format: 'uuid', uuid, raw }`.
 *
 * Returns `null` for any input that is not a non-empty string or does not
 * match either known format. Never throws.
 *
 * PRD §3 P2 row 3: "Given an existing STATE.md with UUID-v4 session-id
 * (pre-P2 vintage), when any post-P2 code reads STATE.md frontmatter, then
 * both formats are accepted."
 *
 * @param {unknown} id - The session ID to parse.
 * @returns {{ format: 'semantic', branch: string, date: string, mode: string, n: number, raw: string }
 *           | { format: 'uuid', uuid: string, raw: string }
 *           | null}
 */
export function parseSessionId(id) {
  if (typeof id !== 'string' || id.length === 0) return null;

  // Try semantic format first.
  const m = id.match(SEMANTIC_ID_RE);
  if (m) {
    return {
      format: 'semantic',
      branch: m[1],
      date: m[2],
      mode: m[3],
      n: parseInt(m[4], 10),
      raw: id,
    };
  }

  // Try UUID-v4.
  if (UUID_V4_RE.test(id)) {
    return { format: 'uuid', uuid: id, raw: id };
  }

  return null;
}

/**
 * Generate the next semantic session ID for this (branch, date, mode) tuple.
 *
 * The generated ID matches the regex:
 *   `^[a-z0-9._/-]+-\d{4}-\d{2}-\d{2}-[a-z-]+-\d+$`
 *
 * Counter semantics (PRD §3.A P2 Ubiquitous):
 *   n = max(existing n values for same branch+date+mode) + 1
 *   When no matching sessions exist → n = 1.
 *   Gaps are never filled: if existing sessions have n = [1, 3] the next is 4.
 *
 * Concurrency safety (PSA-005):
 *   The counter derivation is serialised inside `withStateMdLock` so that two
 *   concurrent preambles running in parallel worktrees cannot assign the same n.
 *
 * UUID-v4 entries in activeSessions are silently ignored (parseSessionId returns
 * format:'uuid' which the filter drops). Mixed arrays are supported.
 *
 * @param {object} opts
 * @param {string} opts.branch - Current git branch (e.g. "main", "feature/foo").
 *   Must match `/^[a-zA-Z0-9._/-]+$/`. Required.
 * @param {string} opts.mode - Session type (e.g. "deep", "feature", "housekeeping").
 *   Must match `/^[a-z-]+$/`. Required.
 * @param {Array<{sessionId: string}>} [opts.activeSessions=[]] - Active sessions
 *   array from session-discovery. Each element must have a `.sessionId` string.
 *   Defaults to an empty array when omitted or undefined.
 * @param {string} [opts.repoRoot] - Absolute path to the repo root. Passed
 *   through to `withStateMdLock`. Defaults to `process.cwd()` when omitted.
 * @returns {Promise<string>} The next semantic session ID, e.g. "main-2026-05-27-deep-2".
 * @throws {TypeError} When `branch` is missing, empty, or contains invalid characters.
 * @throws {TypeError} When `mode` is missing, empty, or contains characters other than
 *   lowercase letters and hyphens.
 * @throws {Error} When the STATE.md write-lock cannot be acquired (timeout or fs-error).
 */
export async function resolveSemanticSessionId({ branch, mode, activeSessions, repoRoot } = {}) {
  // Input validation — validate before acquiring the lock to fail fast.
  if (!isValidBranch(branch)) {
    throw new TypeError(
      `resolveSemanticSessionId: 'branch' must be a non-empty string matching /^[a-zA-Z0-9._/-]+$/, got: ${JSON.stringify(branch)}`,
    );
  }
  if (!isValidMode(mode)) {
    throw new TypeError(
      `resolveSemanticSessionId: 'mode' must be a non-empty string matching /^[a-z-]+$/, got: ${JSON.stringify(mode)}`,
    );
  }

  return withStateMdLock(repoRoot, async () => {
    // Derive the current UTC date as YYYY-MM-DD.
    const today = new Date().toISOString().slice(0, 10);

    // Collect the n-values of all active sessions that match this (branch, date, mode).
    // UUID entries and unknown-format entries are silently excluded.
    const matchingNs = (activeSessions ?? [])
      .map((s) => parseSessionId(s?.sessionId))
      .filter(
        (parsed) =>
          parsed !== null &&
          parsed.format === 'semantic' &&
          parsed.branch === branch &&
          parsed.date === today &&
          parsed.mode === mode,
      )
      .map((parsed) => parsed.n);

    const maxN = matchingNs.length > 0 ? Math.max(...matchingNs) : 0;
    const nextN = maxN + 1;

    return _formatSemanticId(branch, today, mode, nextN);
  });
}

/**
 * Format a semantic session ID from its components.
 *
 * Exposed for testing only — the leading underscore marks this as an internal
 * helper that production callers should NOT use directly.
 *
 * @param {string} branch - Git branch name.
 * @param {string} date - ISO date string (YYYY-MM-DD).
 * @param {string} mode - Session mode.
 * @param {number} n - Monotonic counter value.
 * @returns {string} The formatted session ID, e.g. "main-2026-05-27-deep-1".
 */
export function _formatSemanticId(branch, date, mode, n) {
  return `${branch}-${date}-${mode}-${n}`;
}
