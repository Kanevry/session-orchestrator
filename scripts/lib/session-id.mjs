/**
 * session-id.mjs — Semantic session-ID generation and dual-format parsing.
 *
 * Public API:
 *   - resolveSemanticSessionId({ branch, mode, activeSessions, repoRoot, history }): Promise<string>
 *   - parseSessionId(id): { format: 'semantic'|'uuid', ...fields, raw } | null
 *   - SEMANTIC_ID_RE — source-of-truth regex for semantic session IDs
 *   - UUID_V4_RE     — regex for UUID-v4 format session IDs
 *
 * Closes #572 — Epic #568 Phase 2.1 (Parallel-Aware Sessions Semantic ID)
 * Closes #585 — Epic #583 W2-I2 (history-aware n-increment) per audit
 *               .orchestrator/audits/W1-D2-resolveSemanticSessionId.md
 *
 * PRD refs:
 *  - docs/prd/2026-05-26-parallel-aware-sessions.md §3 P2 + §3.A P2
 *  - docs/prd/2026-05-27-parallel-session-detection-hardening.md (Epic #583)
 *
 * Design notes:
 *  - resolveSemanticSessionId wraps its body in withStateMdLock so two
 *    concurrent preambles cannot assign duplicate n values (PSA-005).
 *  - parseSessionId is a pure synchronous function — no I/O, no side effects.
 *  - History-aware (#585): the n-increment consults three candidate sources:
 *      1. activeSessions (the legacy source — live lockfiles + registry).
 *      2. sessions.jsonl history (closed sessions; appended on session-end).
 *      3. STATE.md frontmatter `session:` (last-resort survivor of crashed sessions).
 *    Sources 2 and 3 are read inside the existing withStateMdLock so their
 *    visibility is consistent with the n-claim that follows. Both are opt-out
 *    via opts.history.{consultHistory,consultStateMd} and DI-overridable via
 *    opts.history.{readHistoryImpl,readStateMdSessionImpl} for tests.
 *  - Reader helpers never throw: missing files, malformed JSONL lines, and
 *    unparseable frontmatter are all treated as "no signal" (empty/null).
 *  - Production code is silent: no console.log, no console.warn.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { withStateMdLock } from './session-lock.mjs';
import { resolveStateMdPath } from './state-md/frontmatter-mutators.mjs';
import { parseStateMd } from './state-md/yaml-parser.mjs';

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

/**
 * Read closed-session IDs from `<repoRoot>/.orchestrator/metrics/sessions.jsonl`.
 *
 * Robustness contract (W1-D2 audit §3.1):
 *  - Missing file (ENOENT) → returns [] (fresh repo, no history yet).
 *  - Permission/FS error → returns [] (fail-open; this helper must never
 *    block the n-claim it feeds).
 *  - Malformed JSONL line → silently skipped (per-line try/catch).
 *  - Lines without a string `session_id` field → filtered out.
 *
 * Performance note: sessions.jsonl is line-oriented but typically <100 KB.
 * A single readFile is faster than line-streaming at this size. Should the
 * file grow past ~5 MB a future change can swap to a `readline` stream with
 * early-exit; not a launch blocker.
 *
 * @param {string} repoRoot
 * @returns {Promise<string[]>}  Array of session_id strings (may include duplicates).
 */
async function readSessionIdsFromHistory(repoRoot) {
  const filePath = path.join(repoRoot, '.orchestrator', 'metrics', 'sessions.jsonl');
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  const ids = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed?.session_id === 'string') ids.push(parsed.session_id);
    } catch {
      // Malformed line — skip silently (audit §3.1 robustness contract).
    }
  }
  return ids;
}

/**
 * Read the `session:` field from `<repoRoot>/.claude/STATE.md` (or `.codex`,
 * `.cursor` — `resolveStateMdPath` picks the first existing candidate).
 *
 * Robustness contract (W1-D2 audit §3.2):
 *  - Missing STATE.md → returns null.
 *  - Unparseable frontmatter → returns null (parseStateMd already returns
 *    null on bad input).
 *  - `session:` field absent or non-string → returns null.
 *  - I/O error → returns null (fail-open).
 *
 * Lock invariant: this helper is called from inside `withStateMdLock`, so we
 * are reading our own write-lock domain — no mid-write races.
 *
 * @param {string} repoRoot
 * @returns {Promise<string|null>}  The session_id string, or null when absent.
 */
async function readSessionIdFromStateMd(repoRoot) {
  const filePath = resolveStateMdPath(repoRoot);
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  const parsed = parseStateMd(raw);
  if (parsed === null) return null;
  const sessionField = parsed.frontmatter?.session;
  return typeof sessionField === 'string' ? sessionField : null;
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
 * Counter semantics (PRD §3.A P2 Ubiquitous + #585 history-aware extension):
 *   n = max(existing n values for same branch+date+mode across THREE sources) + 1
 *   When no matching sessions exist anywhere → n = 1.
 *   Gaps are never filled: if existing n = [1, 3] the next is 4, not 2.
 *
 *   Sources consulted (all merged into a single candidate set):
 *     A. opts.activeSessions  — live sessions (lockfiles + host-wide registry).
 *     B. sessions.jsonl       — closed-session history (opt-out via opts.history.consultHistory=false).
 *     C. STATE.md `session:`  — last-resort survivor (opt-out via opts.history.consultStateMd=false).
 *
 *   Defaults for B and C are ON — historically only source A was consulted,
 *   which caused n to reset to 1 once the previous session deregistered itself
 *   (root-cause of duplicate-ID incidents documented in #585).
 *
 * Concurrency safety (PSA-005):
 *   All three reads and the n-claim are wrapped in `withStateMdLock` so two
 *   concurrent preambles in parallel worktrees observe a consistent view and
 *   cannot assign the same n.
 *
 * UUID-v4 entries (in any source) are silently dropped (parseSessionId returns
 * format:'uuid' which the filter excludes). Malformed semantic-looking IDs are
 * also dropped (SEMANTIC_ID_RE rejects them).
 *
 * @param {object} opts
 * @param {string} opts.branch - Current git branch (e.g. "main", "feature/foo").
 *   Must match `/^[a-zA-Z0-9._/-]+$/`. Required.
 * @param {string} opts.mode - Session type (e.g. "deep", "feature", "housekeeping").
 *   Must match `/^[a-z-]+$/`. Required.
 * @param {Array<{sessionId: string}>} [opts.activeSessions=[]] - Active sessions
 *   array from session-discovery. Each element must have a `.sessionId` string.
 *   Defaults to an empty array when omitted or undefined.
 * @param {string} [opts.repoRoot] - Absolute path to the repo root. Used by
 *   `withStateMdLock`, the sessions.jsonl reader, and the STATE.md reader.
 *   Defaults to `process.cwd()` when omitted.
 * @param {object} [opts.history] - Opt-out + DI controls for the history-aware
 *   sources introduced in #585. All fields optional.
 * @param {boolean} [opts.history.consultHistory=true] - When false, the
 *   sessions.jsonl reader is skipped entirely (legacy-only behaviour).
 * @param {boolean} [opts.history.consultStateMd=true] - When false, the
 *   STATE.md `session:` reader is skipped entirely (legacy-only behaviour).
 * @param {(repoRoot: string) => Promise<string[]>} [opts.history.readHistoryImpl]
 *   Test/DI override for the sessions.jsonl reader. Signature must mirror the
 *   internal helper: returns an array of session_id strings (no throws).
 * @param {(repoRoot: string) => Promise<string|null>} [opts.history.readStateMdSessionImpl]
 *   Test/DI override for the STATE.md reader. Signature must mirror the
 *   internal helper: returns a session_id string or null (no throws).
 * @returns {Promise<string>} The next semantic session ID, e.g. "main-2026-05-27-deep-2".
 * @throws {TypeError} When `branch` is missing, empty, or contains invalid characters.
 * @throws {TypeError} When `mode` is missing, empty, or contains characters other than
 *   lowercase letters and hyphens.
 * @throws {Error} When the STATE.md write-lock cannot be acquired (timeout or fs-error).
 */
export async function resolveSemanticSessionId({
  branch,
  mode,
  activeSessions,
  repoRoot,
  history,
} = {}) {
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

  // Normalise the history opts bag. Both flags default ON — see audit §2.3.
  const consultHistory = history?.consultHistory !== false;
  const consultStateMd = history?.consultStateMd !== false;
  const historyImpl = history?.readHistoryImpl ?? readSessionIdsFromHistory;
  const stateMdImpl = history?.readStateMdSessionImpl ?? readSessionIdFromStateMd;
  const effectiveRoot = repoRoot ?? process.cwd();

  return withStateMdLock(repoRoot, async () => {
    // Derive the current UTC date as YYYY-MM-DD.
    const today = new Date().toISOString().slice(0, 10);

    // Read the two history-aware sources in parallel. Errors from either source
    // are swallowed (the .catch() guards belt-and-braces; helpers already
    // never throw, but a third-party DI impl might).
    const [historicalIds, stateMdId] = await Promise.all([
      consultHistory ? historyImpl(effectiveRoot).catch(() => []) : Promise.resolve([]),
      consultStateMd ? stateMdImpl(effectiveRoot).catch(() => null) : Promise.resolve(null),
    ]);

    // Build a single candidate stream. Duplicates are fine — Math.max handles them.
    const candidateIds = [
      ...(activeSessions ?? []).map((s) => s?.sessionId),
      ...historicalIds,
      ...(stateMdId !== null ? [stateMdId] : []),
    ];

    // Match against (branch, date, mode) and project to n.
    // UUID entries, unknown-format entries, and non-matching tuples are excluded.
    const matchingNs = candidateIds
      .map((id) => parseSessionId(id))
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
