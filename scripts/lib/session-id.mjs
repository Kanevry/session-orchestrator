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
 * Closes (partial) #908 follow-up — deep-2026-07-29 W1: registry as a fourth
 *               candidate source (see "History-aware" design note below).
 *
 * PRD refs:
 *  - "Parallel-aware sessions" (#568; archived in the private Meta-Vault) §3 P2 + §3.A P2
 *  - Epic #583 (Parallel-Session Detection Wiring Hardening)
 *
 * Design notes:
 *  - resolveSemanticSessionId wraps its body in withStateMdLock so two
 *    concurrent preambles cannot assign duplicate n values (PSA-005).
 *  - parseSessionId is a pure synchronous function — no I/O, no side effects.
 *  - History-aware (#585, extended #908): the n-increment consults FOUR
 *    candidate sources:
 *      1. activeSessions (the legacy source — caller-supplied live sessions).
 *      2. sessions.jsonl history (closed sessions; appended on session-end
 *         ONLY — a session that never reaches /close never appears here).
 *      3. STATE.md frontmatter `session:` (last-resort survivor of crashed
 *         sessions — but only the MOST RECENT one, since STATE.md holds a
 *         single frontmatter block, not a history).
 *      4. The host-wide session registry (`~/.config/session-orchestrator/
 *         sessions/active/*.json`, `scripts/lib/session-registry.mjs`),
 *         filtered to THIS repo via `repo_path_hash`. Closes the gap sources
 *         2+3 leave: a session that registers a semantic ID at start and then
 *         crashes/is killed before ever closing or being overwritten in
 *         STATE.md is invisible to 2 and 3 but IS visible here, because
 *         registerSelf() runs at session-start (hooks/on-session-start.mjs),
 *         not session-end. This was the confirmed root cause of the
 *         same-day duplicate-ID collisions observed 2026-07-29 (#908
 *         follow-up): `sessions.jsonl` had 0 matching entries for either
 *         colliding ID, because neither session ever reached /close.
 *    Sources 2, 3, and 4 are read inside the existing withStateMdLock so their
 *    visibility is consistent with the n-claim that follows. All three are
 *    opt-out via opts.history.{consultHistory,consultStateMd,consultRegistry}
 *    and DI-overridable via
 *    opts.history.{readHistoryImpl,readStateMdSessionImpl,readRegistryImpl}
 *    for tests.
 *  - Reader helpers never throw: missing files, malformed JSONL lines,
 *    unparseable frontmatter, and an unreadable/missing registry directory
 *    are all treated as "no signal" (empty/null) — fail-open, never
 *    fail-closed, per the same robustness contract as sources 2 and 3.
 *  - Production code is silent: no console.log, no console.warn.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { withStateMdLock } from './session-lock.mjs';
import { resolveStateMdPath } from './state-md/frontmatter-mutators.mjs';
import { parseStateMd } from './state-md/yaml-parser.mjs';
import { readRegistry, repoPathHash } from './session-registry.mjs';

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
 * `.cursor`, `.pi` — `resolveStateMdPath` picks the active/existing candidate).
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

/**
 * Read same-repo `semantic_session_id` values from the host-wide session
 * registry (`~/.config/session-orchestrator/sessions/active/*.json`, see
 * `scripts/lib/session-registry.mjs`).
 *
 * Why this source exists (#908 follow-up, deep-2026-07-29 W1): sources B
 * (sessions.jsonl) and C (STATE.md) are both written only at specific
 * lifecycle points — B exclusively by `/close`, C overwritten by whichever
 * session last touched STATE.md. A session that registers a semantic ID at
 * start (`registerSelf()`, called from `hooks/on-session-start.mjs`) and then
 * crashes, is killed, or is simply abandoned before reaching `/close` is
 * invisible to both B and C — so the NEXT session-start sees n as if that
 * crashed session never existed, and reassigns the same n. This was measured
 * as the root cause of the live 2026-07-29 collision: `main-2026-07-29-deep-1`
 * was assigned twice (`grep -c "main-2026-07-29-deep-1"
 * .orchestrator/metrics/sessions.jsonl` → 0 matches, confirming neither
 * assignment ever reached history). The registry closes this gap because it
 * is written at session-START, not session-end.
 *
 * HOST-WIDE, NOT REPO-SCOPED (critical filter): the registry directory holds
 * one entry per active session across EVERY repo on the host, keyed by a
 * random session_id filename — not by repo. Two different repos can
 * legitimately register the identical `semantic_session_id` string (e.g.
 * both on `main`, same day, same mode) without any collision, because the
 * semantic ID is only meant to be unique WITHIN one repo. Consuming this
 * source unfiltered would let an unrelated repo's same-day session inflate
 * THIS repo's counter — a distinct, subtler bug than the one this source
 * fixes. The filter is `entry.repo_path_hash === repoPathHash(repoRoot)`,
 * using the registry module's OWN `repoPathHash()` export (never a
 * hand-rolled hash — the two must agree byte-for-byte since one produced the
 * on-disk value and the other reproduces it for comparison).
 *
 * Freshness — deliberately NOT filtered (decision + rationale): entries are
 * included regardless of `isRegistryEntryFresh()` / `last_heartbeat` age.
 * The bug this source closes is EXACTLY the crashed/abandoned-session case —
 * by the time the next session starts, a crashed registration is, almost by
 * definition, no longer "fresh" (that staleness is *why* sources B/C miss
 * it). Filtering on freshness here would silently readmit the very
 * collision this change exists to prevent. The counter-argument — an
 * ever-growing registry monotonically driving n upward — does not hold here:
 * (a) matching is already scoped to (branch, date, mode), so only same-day
 * same-branch same-mode entries count at all, a naturally bounded set; and
 * (b) `sweepZombies()` (default `thresholdMin=60`) independently removes
 * stale entries on its own schedule, so registry growth is bounded by that
 * mechanism, not by this reader needing its own freshness gate. A zombie
 * entry's n was genuinely consumed once — counting it is correct, not a
 * leak.
 *
 * Robustness contract (mirrors readSessionIdsFromHistory / B and
 * readSessionIdFromStateMd / C):
 *  - `readRegistry()` itself never throws (see session-registry.mjs) — it
 *    returns `[]` on a missing/unreadable registry directory.
 *  - `repoPathHash()` throws `TypeError` on a non-string/empty `repoRoot`;
 *    guarded here so a caller passing a bad `repoRoot` degrades to `[]`
 *    rather than propagating (fail-open, matching the PSA-006/#906 "moving a
 *    guard must not invert its failure direction" lesson — this reader's
 *    failure direction is and must remain "fewer candidates", never "throw").
 *  - Entries without a string `semantic_session_id` are excluded (v1
 *    registry entries predate the field — schema v2.1, Epic #583 W5-F1c —
 *    and their bare UUID `session_id` is not a semantic ID; `parseSessionId`
 *    would reject it downstream anyway, but excluding it here keeps this
 *    reader's contract explicit rather than relying on that downstream
 *    filter).
 *
 * @param {string} repoRoot
 * @returns {Promise<string[]>}  Array of `semantic_session_id` strings scoped
 *   to this repo (may include duplicates; empty when the registry is absent,
 *   unreadable, or has no matching entries).
 */
async function readSessionIdsFromRegistry(repoRoot) {
  let hash;
  try {
    hash = repoPathHash(repoRoot);
  } catch {
    return [];
  }
  let entries;
  try {
    entries = await readRegistry();
  } catch {
    return [];
  }
  return entries
    .filter((e) => e?.repo_path_hash === hash && typeof e?.semantic_session_id === 'string')
    .map((e) => e.semantic_session_id);
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
 * Counter semantics (PRD §3.A P2 Ubiquitous + #585 history-aware extension,
 * + #908 follow-up registry source):
 *   n = max(existing n values for same branch+date+mode across FOUR sources) + 1
 *   When no matching sessions exist anywhere → n = 1.
 *   Gaps are never filled: if existing n = [1, 3] the next is 4, not 2.
 *
 *   Sources consulted (all merged into a single candidate set):
 *     A. opts.activeSessions  — caller-supplied live sessions.
 *     B. sessions.jsonl       — closed-session history (opt-out via opts.history.consultHistory=false).
 *     C. STATE.md `session:`  — last-resort survivor (opt-out via opts.history.consultStateMd=false).
 *     D. host-wide session registry, filtered to this repo via repo_path_hash
 *        (opt-out via opts.history.consultRegistry=false) — see
 *        readSessionIdsFromRegistry() jsdoc for the full rationale (#908).
 *
 *   Defaults for B, C, and D are ON — historically only source A was
 *   consulted, which caused n to reset to 1 once the previous session
 *   deregistered itself (root-cause of duplicate-ID incidents documented in
 *   #585 and, for the crashed/never-closed case specifically, #908).
 *
 * Concurrency safety (PSA-005):
 *   All history-aware reads (B, C, D) and the n-claim are wrapped in
 *   `withStateMdLock` so two concurrent preambles in parallel worktrees
 *   observe a consistent view and cannot assign the same n.
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
 * @param {boolean} [opts.history.consultRegistry=true] - When false, the
 *   host-wide session-registry reader is skipped entirely (#908 follow-up).
 * @param {(repoRoot: string) => Promise<string[]>} [opts.history.readRegistryImpl]
 *   Test/DI override for the registry reader. Signature must mirror the
 *   internal helper: returns an array of semantic_session_id strings already
 *   filtered to this repo (no throws). Tests MUST use this override (or the
 *   registry module's own `SO_SESSION_REGISTRY_DIR` env var pointed at a
 *   tmp dir) rather than exercising the real host-wide registry — see
 *   parallel-sessions.md § "this session repairs the machinery it runs on".
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

  // Normalise the history opts bag. All three flags default ON — see audit
  // §2.3 (B/C) and the readSessionIdsFromRegistry() jsdoc (D, #908).
  const consultHistory = history?.consultHistory !== false;
  const consultStateMd = history?.consultStateMd !== false;
  const consultRegistry = history?.consultRegistry !== false;
  const historyImpl = history?.readHistoryImpl ?? readSessionIdsFromHistory;
  const stateMdImpl = history?.readStateMdSessionImpl ?? readSessionIdFromStateMd;
  const registryImpl = history?.readRegistryImpl ?? readSessionIdsFromRegistry;
  const effectiveRoot = repoRoot ?? process.cwd();

  return withStateMdLock(repoRoot, async () => {
    // Derive the current UTC date as YYYY-MM-DD.
    const today = new Date().toISOString().slice(0, 10);

    // Read the three history-aware sources in parallel. Errors from any source
    // are swallowed (the .catch() guards belt-and-braces; helpers already
    // never throw, but a third-party DI impl might).
    const [historicalIds, stateMdId, registryIds] = await Promise.all([
      consultHistory ? historyImpl(effectiveRoot).catch(() => []) : Promise.resolve([]),
      consultStateMd ? stateMdImpl(effectiveRoot).catch(() => null) : Promise.resolve(null),
      consultRegistry ? registryImpl(effectiveRoot).catch(() => []) : Promise.resolve([]),
    ]);

    // Build a single candidate stream. Duplicates are fine — Math.max handles them.
    const candidateIds = [
      ...(activeSessions ?? []).map((s) => s?.sessionId),
      ...historicalIds,
      ...(stateMdId !== null ? [stateMdId] : []),
      ...registryIds,
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
