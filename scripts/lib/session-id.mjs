/**
 * session-id.mjs — Semantic session-ID generation and dual-format parsing.
 *
 * Public API:
 *   - resolveSemanticSessionId({ branch, mode, activeSessions, repoRoot, sources }): Promise<string>
 *   - parseSessionId(id): { format: 'semantic'|'uuid', ...fields, raw } | null
 *   - DEFAULT_SESSION_ID_SOURCES — the default `sources` array (see below)
 *   - SEMANTIC_ID_RE — source-of-truth regex for semantic session IDs
 *   - UUID_RE        — regex for RFC 9562 UUID session IDs (any version 1–8)
 *   - UUID_V4_RE     — deprecated alias of UUID_RE (kept for importers)
 *
 * Closes #572 — Epic #568 Phase 2.1 (Parallel-Aware Sessions Semantic ID)
 * Closes #585 — Epic #583 W2-I2 (history-aware n-increment) per audit
 *               .orchestrator/audits/W1-D2-resolveSemanticSessionId.md
 *
 * PRD refs:
 *  - "Parallel-aware sessions" (#568; archived in the private Meta-Vault) §3 P2 + §3.A P2
 *  - Epic #583 (Parallel-Session Detection Wiring Hardening)
 *
 * Design notes:
 *  - resolveSemanticSessionId wraps its body in withStateMdLock so two
 *    concurrent preambles cannot assign duplicate n values (PSA-005).
 *  - parseSessionId is a pure synchronous function — no I/O, no side effects.
 *  - History-aware (#585): the n-increment consults four candidate sources:
 *      1. activeSessions (the legacy source — live lockfiles + registry).
 *      2. sessions.jsonl history (closed sessions; appended on session-end).
 *      3. STATE.md frontmatter `session:` (last-resort survivor of crashed sessions).
 *      4. events.jsonl `orchestrator.session.lock.acquired` (#952 Teil B —
 *         append-only mint-ledger; the only source written at CLAIM time).
 *    Sources 2-4 are DEFAULT_SESSION_ID_SOURCES — deferred readers invoked
 *    inside the existing withStateMdLock, so their visibility is consistent
 *    with the n-claim that follows. They are configured through the single
 *    `opts.sources` array (#956): opting out is passing a shorter array,
 *    overriding is passing your own reader, and adding a fifth source costs
 *    no new interface element. Source 1 stays a separate parameter — it is
 *    already-resolved data gathered BEFORE the lock, so it is deliberately
 *    not disguised as a deferred, lock-covered reader.
 *  - Reader helpers never throw: missing files, malformed JSONL lines, and
 *    unparseable frontmatter are all treated as "no signal" (empty/null).
 *  - Production code is silent: no console.log, no console.warn.
 */

import { open, readFile } from 'node:fs/promises';
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
 * Regex for RFC 9562 UUID session IDs — ANY version 1–8, variant `10xx`.
 *
 * Matches: 8-4-4-4-12 hex digits, version nibble in [1-8], variant nibble in
 * {8,9,a,b}. Case-insensitive to accept both uppercase and lowercase hex.
 *
 * Why the version nibble is a RANGE and not the literal `4` (Kanevry#66 / #1091):
 * Claude Code mints UUIDv4 session ids, but Codex CLI mints UUIDv7. Pinning `4`
 * made `parseSessionId()` return `null` for every Codex session, so
 * `hooks/on-session-start.mjs` fell through to a freshly generated
 * `randomUUID()` and every later hook in that session missed the lock.
 *
 * The structure stays strict on purpose: the dash/length layout and the
 * variant nibble are what discriminate a real UUID from a 36-char lookalike,
 * so only the version nibble is widened. Version `0` (nil UUID) and `9`..`f`
 * (unassigned / max UUID) remain rejected — RFC 9562 defines 1–8.
 *
 * @type {RegExp}
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * @deprecated Use {@link UUID_RE}. Retained as an alias so no importer breaks;
 * the name is a misnomer since Kanevry#66 — the pattern accepts any RFC 9562
 * version 1–8, not only v4.
 * @type {RegExp}
 */
export const UUID_V4_RE = UUID_RE;

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
 * Event name emitted by `hooks/_lib/lock-bootstrap.mjs` on every successful
 * session-lock acquisition — i.e. on every semantic-ID MINT.
 * @type {string}
 */
const LOCK_ACQUIRED_EVENT = 'orchestrator.session.lock.acquired';

/**
 * Byte window for the events.jsonl tail read (1 MiB).
 *
 * Sizing rationale: the match downstream is `date === today`, so the window
 * only has to cover today's events. Worst observed single-day volume in this
 * repo is ~164 KiB (measured 2026-07-31 over the live log), and rotation caps
 * the file at `events-rotation.max-size-mb` (default 10 MiB). 1 MiB is ~6x the
 * worst observed day and 10% of the rotation ceiling.
 * @type {number}
 */
const EVENTS_TAIL_BYTES = 1024 * 1024;

/**
 * Age cutoff for events considered by the reader (2 days).
 *
 * Anything older cannot influence a `date === today` match, so dropping it
 * early keeps the candidate set small. Records whose timestamp is absent or
 * unparseable are KEPT, never dropped — under-reporting a claimed n is exactly
 * the failure this source exists to prevent (#952).
 * @type {number}
 */
const EVENTS_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Read minted semantic session IDs from
 * `<repoRoot>/.orchestrator/metrics/events.jsonl`.
 *
 * Why this source exists (#952 Teil B): `sessions.jsonl` is written at
 * session-END. A session that is killed before its SessionEnd hook fires never
 * writes a record, so the `n` it consumed becomes invisible to every other
 * source and the NEXT session mints the same ID. Proven collision (live ledger,
 * 2026-07-29): `main-2026-07-29-session-2` was minted twice, 7h57m apart.
 * `events.jsonl` is append-only and written at CLAIM time by
 * `hooks/_lib/lock-bootstrap.mjs`, so a minted `n` survives a crash by
 * construction.
 *
 * Read strategy: a bounded TAIL read (`EVENTS_TAIL_BYTES` from the end of the
 * file), not a whole-file read — events.jsonl grows without bound between
 * rotations (~1.9 MB at time of writing). When the window does not reach the
 * start of the file, the first (possibly truncated) line is discarded.
 *
 * Robustness contract (mirrors `readSessionIdsFromHistory`):
 *  - Missing file (ENOENT) → returns [].
 *  - Permission/FS/read error → returns [] (fail-open; a telemetry read must
 *    never block the n-claim it feeds).
 *  - Malformed JSONL line → silently skipped (per-line try/catch).
 *  - Freshly rotated file → legitimately yields [] or few records. Not an
 *    error: the three other sources remain in play unchanged.
 *
 * @param {string} repoRoot
 * @returns {Promise<string[]>}  Array of semantic_session_id strings (may include duplicates).
 */
async function readSessionIdsFromEvents(repoRoot) {
  const filePath = path.join(repoRoot, '.orchestrator', 'metrics', 'events.jsonl');

  let text = '';
  // Assigned in the try below; every path that reaches its read site has
  // passed through that assignment (the catch returns early).
  let windowIsPartial;
  let handle = null;
  try {
    handle = await open(filePath, 'r');
    const { size } = await handle.stat();
    const start = size > EVENTS_TAIL_BYTES ? size - EVENTS_TAIL_BYTES : 0;
    windowIsPartial = start > 0;
    const length = size - start;
    if (length > 0) {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, start);
      text = buf.subarray(0, bytesRead).toString('utf8');
    }
  } catch {
    return [];
  } finally {
    if (handle !== null) await handle.close().catch(() => {});
  }

  const lines = text.split(/\r?\n/);
  // The window started mid-file, so line 0 may be a truncated record.
  if (windowIsPartial) lines.shift();

  const cutoff = Date.now() - EVENTS_MAX_AGE_MS;
  const ids = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // Cheap substring pre-filter: events.jsonl carries many event kinds and
    // JSON.parse on every line of a 1 MiB window is the dominant cost.
    if (!trimmed.includes(LOCK_ACQUIRED_EVENT)) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Malformed line — skip silently (same contract as sessions.jsonl).
      continue;
    }
    if (parsed?.event !== LOCK_ACQUIRED_EVENT) continue;
    const ts = Date.parse(parsed.timestamp);
    // Only drop on a PARSEABLE, definitely-stale timestamp (see EVENTS_MAX_AGE_MS).
    if (Number.isFinite(ts) && ts < cutoff) continue;
    if (typeof parsed.semantic_session_id === 'string') ids.push(parsed.semantic_session_id);
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
 * Shape adapter for the STATE.md source.
 *
 * STATE.md has exactly ONE `session:` slot, so its reader naturally returns
 * `string|null` while every other source returns `string[]`. This adapter
 * normalises it to the uniform source signature `(repoRoot) => Promise<string[]>`,
 * which is what lets `sources` be a single homogeneous array. Before #956 the
 * mismatch was special-cased twice at the merge site (a `.catch(() => null)`
 * that differed from its siblings, plus a `stateMdId !== null` spread guard).
 *
 * @param {string} repoRoot
 * @returns {Promise<string[]>}  `[]` when absent/unreadable, else `[sessionId]`.
 */
async function readSessionIdsFromStateMd(repoRoot) {
  const id = await readSessionIdFromStateMd(repoRoot);
  return id === null ? [] : [id];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The default `sources` array for {@link resolveSemanticSessionId} — the three
 * on-disk candidate-ID readers, in the order they were introduced:
 *
 *   1. `readSessionIdsFromHistory`   — `.orchestrator/metrics/sessions.jsonl` (#585)
 *   2. `readSessionIdsFromStateMd`   — STATE.md frontmatter `session:`        (#585)
 *   3. `readSessionIdsFromEvents`    — `.orchestrator/metrics/events.jsonl`   (#952)
 *
 * Order is irrelevant to the result: aggregation is `max` over the UNION of all
 * sources, so it is commutative and monotone — an additional source can only
 * raise `n`, never lower it.
 *
 * Exported so callers can derive from it rather than restate it:
 *   - add a source:  `sources: [...DEFAULT_SESSION_ID_SOURCES, myReader]`
 *   - drop a source: `sources: DEFAULT_SESSION_ID_SOURCES.filter(s => s !== …)`
 *   - legacy mode:   `sources: []` (activeSessions only)
 *
 * @type {ReadonlyArray<(repoRoot: string) => Promise<string[]>>}
 */
export const DEFAULT_SESSION_ID_SOURCES = Object.freeze([
  readSessionIdsFromHistory,
  readSessionIdsFromStateMd,
  readSessionIdsFromEvents,
]);

/**
 * Parse a session ID string into a structured object.
 *
 * Accepts two formats:
 *
 *   1. Semantic: `<branch>-<YYYY-MM-DD>-<mode>-<n>`
 *      Returns `{ format: 'semantic', branch, date, mode, n, raw }`.
 *
 *   2. RFC 9562 UUID, any version 1–8, variant `10xx`:
 *      `xxxxxxxx-xxxx-[1-8]xxx-[89ab]xxx-xxxxxxxxxxxx`
 *      Returns `{ format: 'uuid', uuid, version, raw }`, where `version` is the
 *      version nibble as an integer (4 for Claude Code's v4 ids, 7 for Codex
 *      CLI's v7 ids). Callers that only branch on `format` are unaffected —
 *      `version` is additive (Kanevry#66 / #1091).
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
 *           | { format: 'uuid', uuid: string, version: number, raw: string }
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

  // Try RFC 9562 UUID (any version 1–8). Index 14 is the version nibble, and
  // UUID_RE has already constrained it to [1-8], so Number() cannot be NaN.
  if (UUID_RE.test(id)) {
    return { format: 'uuid', uuid: id, version: Number(id[14]), raw: id };
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
 *   n = max(existing n values for same branch+date+mode across FOUR sources) + 1
 *   When no matching sessions exist anywhere → n = 1.
 *   Gaps are never filled: if existing n = [1, 3] the next is 4, not 2.
 *
 *   Sources consulted (all merged into a single candidate set):
 *     A. opts.activeSessions  — live sessions (lockfiles + host-wide registry).
 *     B. sessions.jsonl       — closed-session history.
 *     C. STATE.md `session:`  — last-resort survivor.
 *     D. events.jsonl         — mint ledger, written at CLAIM time.
 *
 *   B, C and D are `opts.sources` (default: DEFAULT_SESSION_ID_SOURCES, i.e.
 *   all three ON) — historically only source A was consulted,
 *   which caused n to reset to 1 once the previous session deregistered itself
 *   (root-cause of duplicate-ID incidents documented in #585).
 *
 *   Source D closes the residual hole (#952 Teil B): B is written at session-END
 *   and C has exactly ONE slot (an interleaved session of a different mode
 *   overwrites it, and the mode filter below then discards it). A session killed
 *   before its SessionEnd hook therefore leaves NO trace in A, B or C, and the
 *   next session re-mints its n. Proven live: `main-2026-07-29-session-2` was
 *   minted twice, 7h57m apart. D would have yielded maxN=2 → `session-3`.
 *
 * Concurrency safety (PSA-005):
 *   All `sources` reads and the n-claim are wrapped in `withStateMdLock` so two
 *   concurrent preambles in parallel worktrees observe a consistent view and
 *   cannot assign the same n. The #952 collision was NOT a concurrency defect —
 *   the lock held; the candidate set was incomplete.
 *
 * UUID entries of ANY version (in any source) are silently dropped
 * (parseSessionId returns format:'uuid' which the filter excludes). Malformed
 * semantic-looking IDs are also dropped (SEMANTIC_ID_RE rejects them).
 *
 * @param {object} opts
 * @param {string} opts.branch - Current git branch (e.g. "main", "feature/foo").
 *   Must match `/^[a-zA-Z0-9._/-]+$/`. Required.
 * @param {string} opts.mode - Session type (e.g. "deep", "feature", "housekeeping").
 *   Must match `/^[a-z-]+$/`. Required.
 * @param {Array<{sessionId: string}>} [opts.activeSessions=[]] - Active sessions
 *   array from session-discovery. Each element must have a `.sessionId` string.
 *   Defaults to an empty array when omitted or undefined.
 *   Deliberately NOT part of `sources`: it is `{sessionId}` objects rather than
 *   strings, and it is already-resolved data gathered BEFORE the call (see
 *   `hooks/on-session-start.mjs` `deriveSemanticCandidate`), so it is the one
 *   source NOT covered by the lock's consistent-read guarantee. Wrapping it as
 *   `async () => data` would hide both facts.
 * @param {string} [opts.repoRoot] - Absolute path to the repo root. Used by
 *   `withStateMdLock` and passed to every entry of `sources`.
 *   Defaults to `process.cwd()` when omitted.
 * @param {ReadonlyArray<(repoRoot: string) => Promise<string[]>>} [opts.sources=DEFAULT_SESSION_ID_SOURCES]
 *   The candidate-ID readers for sources B/C/D — the ONLY DI knob (#956).
 *   Each entry is a deferred thunk invoked with the effective repo root INSIDE
 *   `withStateMdLock`, and must resolve to an array of session-ID strings.
 *   Non-string and unknown-format entries are dropped downstream, so a reader
 *   may return raw IDs without pre-filtering.
 *   The default is {@link DEFAULT_SESSION_ID_SOURCES} =
 *   `[sessions.jsonl reader, STATE.md reader, events.jsonl reader]`.
 *   Opting a source out = passing a shorter array (`[]` for the pre-#585
 *   activeSessions-only behaviour); overriding one = passing your own function;
 *   adding a fifth = appending to the default. Each entry is individually
 *   error-swallowed (a throwing or rejecting source contributes `[]` and never
 *   blocks the n-claim), so one bad reader cannot fail the mint.
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
  sources,
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

  // Resolve the source set. An explicit array (including []) wins; anything
  // else — omitted, undefined, non-array — falls back to the documented default.
  const effectiveSources = Array.isArray(sources) ? sources : DEFAULT_SESSION_ID_SOURCES;
  const effectiveRoot = repoRoot ?? process.cwd();

  return withStateMdLock(repoRoot, async () => {
    // Derive the current UTC date as YYYY-MM-DD.
    const today = new Date().toISOString().slice(0, 10);

    // Read every source in parallel. Each is individually error-swallowed:
    // the built-in readers already never throw, but a caller-supplied source
    // might — and one bad reader must never block the n-claim it feeds. The
    // Promise.resolve().then() wrapper also catches a SYNCHRONOUS throw, which
    // a bare `.catch()` on the return value would not.
    const perSourceIds = await Promise.all(
      effectiveSources.map((read) =>
        Promise.resolve()
          .then(() => read(effectiveRoot))
          .catch(() => []),
      ),
    );

    // Build a single candidate stream. Duplicates are fine — Math.max handles them.
    const candidateIds = [
      ...(activeSessions ?? []).map((s) => s?.sessionId),
      ...perSourceIds.flat(),
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
