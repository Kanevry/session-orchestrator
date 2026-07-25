/**
 * scope-baseline.mjs — Scope Governor: baseline-freeze + drift-tripwire module.
 *
 * Freezes a per-session "scope baseline" into STATE.md frontmatter (five
 * flat keys) exactly once per session, reads it back, and computes a
 * warn-only drift ratio against it. This is the mechanical half of the
 * Scope Governor's session-scoping self-validation (PRD "Scope Governor —
 * Loop-Termination über Scope statt über Retry-Cap",
 * docs/prd/2026-07-25-scope-governor.md, Epic #894).
 *
 * SCOPE: this module implements `writeBaseline()`, `readBaseline()`, the
 * shared `DRIFT_EXCLUDE_PATTERNS` constant (issue #895 / S1), and
 * `computeDrift()` — the 2x-tripwire drift calculation that consumes
 * `DRIFT_EXCLUDE_PATTERNS` from both sides of the ratio (issue #896 / S2,
 * delivered in this revision). The two distinguishable non-baseline
 * `readBaseline()` return shapes (`null` vs `{ stale: true, ... }`) exist
 * specifically so `computeDrift()` can pick its skip-reason additively
 * without re-parsing STATE.md a second time: both functions share the
 * internal `readFrontmatterOrReason()` + `classifyBaselineFromFrontmatter()`
 * helpers below, so a single `computeDrift()` call performs exactly ONE
 * `readFileSync`/`parseStateMd` pass over STATE.md.
 *
 * ---------------------------------------------------------------------
 * Session-scoping semantics (the load-bearing part).
 * ---------------------------------------------------------------------
 * The canonical frontmatter key is `session` — NOT `session-id`. See
 * skills/_shared/state-ownership.md:28 ("optional... writers SHOULD
 * populate these fields but readers MUST tolerate their absence"). This
 * module reads `frontmatter.session` directly; it does NOT call
 * `parseSessionId(repoRoot)` — that function takes a session-ID STRING and
 * performs no I/O (scripts/lib/session-id.mjs:21/200, "pure synchronous
 * function — no I/O, no side effects"). The frontmatter read lives in that
 * module's PRIVATE, unexported `readSessionIdFromStateMd()` helper, not in
 * `parseSessionId()` itself.
 *
 * Three rules govern `scope-baseline-session` vs. the current `session`:
 *   1. No `scope-baseline-session` key present at all → this STATE.md has
 *      never had a baseline frozen. Write unconditionally — even when the
 *      current `session` field is itself absent (freezes `null`).
 *   2. A `scope-baseline-session` key IS present (its stored value may
 *      itself be `null`, from rule 1) → compare it against the current
 *      `session` value via plain equality on normalised values:
 *        - equal (this also covers BOTH sides being `null` — a missing
 *          optional `session` field must never render the tripwire
 *          permanently inert by making every comparison look "stale") →
 *          MATCH → `{ written: false, reason: 'already-frozen' }`, no
 *          mutation.
 *        - different → the stored baseline belongs to an earlier session →
 *          STALE → fully overwritten, `{ written: true }`.
 *
 * ---------------------------------------------------------------------
 * Fail-open asymmetry — deliberate exception to a documented module
 * convention (naming it explicitly so a future reader does not "fix" it
 * away as an oversight).
 * ---------------------------------------------------------------------
 * `getEnforcementLevel()` and `gateEnabled()` (scope-gate.mjs:50-57 / :68-79)
 * both fall toward ENFORCEMENT on unreadable data, and
 * `assertFileScopeSubset()` documents "Fail-closed & no-throw (module
 * convention)" at scope-gate.mjs:195-197. THIS module inverts that: on
 * unreadable or missing STATE.md, both `writeBaseline()` and
 * `readBaseline()` fail OPEN (a skip-ish result, never a throw, never a
 * denial). Rationale: a *blocking* gate must be suspicious of unreadable
 * data and fail toward the restrictive side; a *warning* signal — this
 * module feeds the S2 warn-only drift tripwire, never a Deny — must stay
 * SILENT on unreadable data instead, because a WARN fired from
 * corrupt/missing input is noise that erodes the guard's credibility faster
 * than a missed drift warning ever would. Do not unify this back to
 * fail-closed. `computeDrift()` follows the SAME asymmetry: every
 * unreadable/missing/stale/unresolvable condition is a silent `skipped`
 * result, never a WARN and never a thrown error.
 *
 * ---------------------------------------------------------------------
 * Sync/async rule.
 * ---------------------------------------------------------------------
 * `readBaseline()` and `computeDrift()` are SYNC (`readFileSync` +, for
 * `computeDrift()`, `execFileSync('git', ...)` only) — pure read paths, kept
 * consistent with the scope-gate.mjs all-sync hook-hot-path convention.
 * `writeBaseline()` is the ONLY async export in this module, and ONLY
 * because `writeStateMd()` (scripts/lib/state-md/frontmatter-mutators.mjs:348,
 * re-exported from scripts/lib/state-md.mjs) is itself async — it takes the
 * STATE.md lock (`withStateMdLock()`) INTERNALLY, so `writeBaseline()` MUST
 * NOT wrap its own call in a second `withStateMdLock()` (that would deadlock
 * on the lockfile). Routing through `writeStateMd()` instead of a private
 * lock+read+write sequence also gets `writeBaseline()` two guards for free:
 * a size-ceiling check and a frontmatter-round-trip-safety check (both
 * documented at frontmatter-mutators.mjs:307-328) — a breach of either
 * REFUSES the write (leaves STATE.md untouched) and surfaces as
 * `{ written: false, reason: 'size-ceiling' | 'frontmatter-unsafe' }`
 * instead of silently bypassing the guard the way the old private
 * `writeStateMdAtomic()` helper did.
 *
 * `writeStateMd()` never throws by contract EXCEPT a `TypeError` when its
 * transformer returns a non-string/non-null/non-undefined value — this
 * module's transformer always returns a string or `null`, OR throws a
 * `TypeError` itself when the `plannedFiles` argument is neither a number
 * nor an array (see `writeBaseline()`'s param doc) — and the underlying
 * `withStateMdLock()` THROWS a labelled Error on acquire failure BY DESIGN
 * (state-md-lock.mjs:265-270: "throws a labelled Error so callers see the
 * failure as an exception rather than a silent {ok:false} return", throw
 * site :328, tagging `err.code` as `STATE_LOCK_TIMEOUT` or
 * `STATE_LOCK_FS_ERROR`). This module's contract is "never throw" —
 * `writeBaseline()` therefore wraps the `writeStateMd()` call in try/catch
 * and maps the escaping error's `err.code` HONESTLY instead of collapsing
 * every failure into one reason (#894 review finding F4 — a disk-full /
 * permission failure on the lock directory must not misdirect the operator
 * toward "retry, it's contention", and a genuine bug thrown inside the
 * transformer must not masquerade as a transient lock condition either):
 * `STATE_LOCK_TIMEOUT` → `'lock-timeout'`, `STATE_LOCK_FS_ERROR` →
 * `'lock-fs-error'`, anything else (including a `TypeError` raised by the
 * transformer itself) → `'unexpected-error'`.
 *
 * `branch` and `session-start-ref` are READ from the existing frontmatter —
 * this module never writes or duplicates them (they are already session-
 * pinned values STATE.md carries independently of this feature).
 *
 * No I/O at import time. Node 20+ stdlib only.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { parseStateMd, serializeStateMd, resolveStateMdPath, writeStateMd } from './state-md.mjs';
import { pathMatchesPattern } from './scope-gate.mjs';

// ---------------------------------------------------------------------------
// DRIFT_EXCLUDE_PATTERNS — the SINGLE filter source for both the denominator
// and the numerator, applied through the SAME internal `filterExcluded()`
// helper below (#894 review finding F1 — the denominator used to be filtered
// only in PROSE, by the coordinator, before calling `writeBaseline()`; a
// prose instruction is not a code path, so a coordinator that forgot to
// filter silently broke the ratio). `writeBaseline()` now filters the
// denominator itself, in code, whenever its `plannedFiles` argument is the
// RAW array of planned file paths (`countPlannedFiles()`, exported below —
// the preferred, documented call shape); a plain number is still accepted
// for back-compat ("already counted, store verbatim"). `computeDrift()`
// filters the numerator at measure time by running the live
// `git diff --name-only` output through the same `filterExcluded()` helper.
// Deliberately narrows skills/session-end/plan-verification.md:42-45's
// per-session-state exclusion from "the whole .claude/ directory" down to
// just the session ARTEFACTS — `.claude/rules/**` stays COUNTED because a
// rule file is a deliverable of this very epic, not a session artefact.
// plan-verification.md:43 (test-file reclassification) is a bucket
// RECLASSIFY — the file stays counted, never excluded — so it is NOT
// mirrored here; :44 (generated/lock) and :45 (per-session state, narrowed)
// are true exclusions and ARE mirrored below.
// ---------------------------------------------------------------------------
export const DRIFT_EXCLUDE_PATTERNS = [
  // Tests — excluded on BOTH sides (deliberately NOT "reclassified" the way
  // plan-verification.md:43 does).
  '**/*.test.*', '**/*.spec.*', '**/__tests__/**',
  // Generated / lock (covers plan-verification.md:44).
  'package-lock.json', 'pnpm-lock.yaml', '*.lock', 'dist/**', 'node_modules/**',
  // Per-session state — deliberately NARROWS plan-verification.md:45 to the
  // ARTEFACTS instead of the whole directory. `.claude/rules/**` stays
  // COUNTED: a rule file is a deliverable, not a session artefact.
  '.claude/STATE.md', '.claude/wave-scope.json', '.claude/metrics/**',
  '.codex/STATE.md', '.codex/wave-scope.json', '.codex/metrics/**',
  '.cursor/STATE.md', '.cursor/wave-scope.json', '.cursor/metrics/**',
  '.pi/STATE.md', '.pi/wave-scope.json', '.pi/metrics/**',
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Current time as an ISO-8601 UTC string.
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Normalise a raw frontmatter session value for comparison: a non-empty
 * string is kept as-is; anything else (undefined, `null`, or any
 * non-string scalar the YAML parser could in principle produce) collapses
 * to `null`. This is what makes "both sides absent" compare equal via a
 * plain `===` at the call sites — no special-casing needed there.
 * @param {unknown} v
 * @returns {string|null}
 */
function normalizeSessionValue(v) {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Round to 2 decimal places. Plain `Math.round` scaling — good enough for a
 * human-facing ratio, not a precision-sensitive computation.
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Filter a raw file-path list through `DRIFT_EXCLUDE_PATTERNS`. THE shared
 * filter primitive (#894 review finding F1) — both `computeDrift()`'s
 * numerator (below) and `writeBaseline()`'s denominator (via
 * `countPlannedFiles()`/`filterPlannedFiles()`, exported below) call this
 * SAME function. No other code path in this module is allowed to
 * re-implement the `DRIFT_EXCLUDE_PATTERNS` filter loop.
 * @param {string[]} files
 * @returns {string[]}
 */
function filterExcluded(files) {
  return files.filter(
    (f) => !DRIFT_EXCLUDE_PATTERNS.some((pattern) => pathMatchesPattern(f, pattern))
  );
}

/**
 * Internal: read + parse STATE.md's frontmatter exactly once. Shared by
 * `readBaseline()` and `computeDrift()` so a single `computeDrift()` call
 * never re-parses the same file twice (see module docstring § SCOPE).
 *
 * @param {string|undefined} repoRoot
 * @returns {{ ok: true, fm: object } | { ok: false, reason: 'no-state-md'|'unreadable-state-md' }}
 */
function readFrontmatterOrReason(repoRoot) {
  const statePath = resolveStateMdPath(repoRoot);
  let raw;
  try {
    raw = readFileSync(statePath, 'utf8');
  } catch {
    // No STATE.md at all (e.g. persistence: false, or never yet written).
    return { ok: false, reason: 'no-state-md' };
  }

  const parsed = parseStateMd(raw);
  if (parsed === null) {
    // Malformed/unparseable frontmatter — fail-open (see module docstring).
    return { ok: false, reason: 'unreadable-state-md' };
  }

  return { ok: true, fm: parsed.frontmatter };
}

/**
 * Internal: classify a scope baseline from ALREADY-PARSED frontmatter.
 * Mirrors `readBaseline()`'s public contract exactly (same three shapes) —
 * extracted so `computeDrift()` can reuse the identical classification
 * logic against the SAME parsed frontmatter object `readFrontmatterOrReason()`
 * already produced, instead of re-parsing STATE.md a second time.
 *
 * @param {object} fm — already-parsed STATE.md frontmatter
 * @returns {null
 *   | { stale: true, baselineSession: string|null, currentSession: string|null }
 *   | { intent: unknown, ownerBoundary: unknown, plannedFiles: unknown,
 *       session: string|null, frozenAt: unknown, branch: unknown,
 *       sessionStartRef: unknown }}
 */
function classifyBaselineFromFrontmatter(fm) {
  if (!Object.prototype.hasOwnProperty.call(fm, 'scope-baseline-session')) {
    return null; // no baseline has ever been frozen
  }

  const baselineSession = normalizeSessionValue(fm['scope-baseline-session']);
  const currentSession = normalizeSessionValue(fm.session);

  if (baselineSession !== currentSession) {
    return { stale: true, baselineSession, currentSession };
  }

  return {
    intent: fm['scope-baseline-intent'] ?? null,
    ownerBoundary: fm['scope-baseline-owner-boundary'] ?? null,
    plannedFiles: fm['scope-baseline-planned-files'] ?? null,
    session: baselineSession,
    frozenAt: fm['scope-baseline-frozen-at'] ?? null,
    branch: fm.branch ?? null,
    sessionStartRef: fm['session-start-ref'] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Filter a RAW file-path list (e.g. the union of declared agent file scopes
 * for a session) through `DRIFT_EXCLUDE_PATTERNS`, returning the surviving
 * paths. This is the denominator half of the #894 review finding F1 fix —
 * `writeBaseline()` calls `countPlannedFiles()` (below), which wraps this
 * function, whenever its `plannedFiles` argument is an array. Exported
 * directly for callers that want the filtered LIST rather than just the
 * count (e.g. for logging which planned files were excluded).
 * @param {string[]} files
 * @returns {string[]}
 */
export function filterPlannedFiles(files) {
  return filterExcluded(files);
}

/**
 * Filter a RAW file-path list through `DRIFT_EXCLUDE_PATTERNS` and return
 * the surviving count — the preferred way to compute `writeBaseline()`'s
 * `plannedFiles` denominator. Calls the exact same `filterExcluded()`
 * primitive `computeDrift()`'s numerator uses, so both sides of the S2
 * drift ratio are provably produced by one function (#894 review finding
 * F1).
 * @param {string[]} files
 * @returns {number}
 */
export function countPlannedFiles(files) {
  return filterPlannedFiles(files).length;
}

/**
 * Read the scope baseline from STATE.md frontmatter, without mutating
 * anything. Sync, never throws.
 *
 * @param {string|undefined} repoRoot
 * @returns {null
 *   | { stale: true, baselineSession: string|null, currentSession: string|null }
 *   | { intent: unknown, ownerBoundary: unknown, plannedFiles: unknown,
 *       session: string|null, frozenAt: unknown, branch: unknown,
 *       sessionStartRef: unknown }}
 *   `null` — no STATE.md, unreadable/malformed frontmatter, or no baseline
 *   has ever been frozen. `{ stale: true, ... }` — a baseline exists but
 *   belongs to a different session than the current `session` field.
 *   Otherwise the baseline object itself.
 */
export function readBaseline(repoRoot) {
  const result = readFrontmatterOrReason(repoRoot);
  if (!result.ok) return null;
  return classifyBaselineFromFrontmatter(result.fm);
}

/**
 * Freeze (or refresh, when the stored baseline is stale) the scope baseline
 * into STATE.md frontmatter. Writes exactly five flat keys:
 * `scope-baseline-intent`, `scope-baseline-owner-boundary`,
 * `scope-baseline-planned-files`, `scope-baseline-session`,
 * `scope-baseline-frozen-at`. `branch` and `session-start-ref` are read
 * from the existing frontmatter, never written by this function.
 *
 * Routes its write through `writeStateMd()` (scripts/lib/state-md.mjs) —
 * see module docstring § Sync/async rule for why this is the ONLY async
 * export and why it must NOT nest its own `withStateMdLock()` call.
 * Never throws.
 *
 * @param {object} args
 * @param {string|undefined} args.repoRoot
 * @param {string} args.intent
 * @param {string} args.ownerBoundary
 * @param {number|string[]} args.plannedFiles — EITHER (preferred) the RAW
 *   array of planned file paths (e.g. the union of declared agent file
 *   scopes for the session) — filtered internally via `countPlannedFiles()`,
 *   which calls the SAME `filterExcluded()` helper `computeDrift()`'s
 *   numerator uses (see the `DRIFT_EXCLUDE_PATTERNS` doc comment above and
 *   #894 review finding F1) — OR (back-compat) a plain pre-counted number,
 *   stored verbatim with no further filtering. Any other type throws a
 *   `TypeError` from inside the write transformer, which this function
 *   catches and reports as `{ written: false, reason: 'unexpected-error' }`
 *   — it never escapes (see module docstring § the final paragraph).
 * @returns {Promise<{ written: boolean, reason?: 'already-frozen'|'no-state-md'|'unreadable-state-md'|'lock-timeout'|'lock-fs-error'|'unexpected-error'|'size-ceiling'|'frontmatter-unsafe' }>}
 */
export async function writeBaseline({ repoRoot, intent, ownerBoundary, plannedFiles } = {}) {
  let skipReason;

  try {
    const result = await writeStateMd(repoRoot, (before) => {
      // `writeStateMd()` passes an empty string when STATE.md does not
      // exist on disk (frontmatter-mutators.mjs:304-305) — that IS the
      // "no-state-md" signal at this layer.
      if (before === '') {
        skipReason = 'no-state-md';
        return null;
      }

      const parsed = parseStateMd(before);
      if (parsed === null) {
        skipReason = 'unreadable-state-md';
        return null;
      }

      const fm = parsed.frontmatter;
      const currentSession = normalizeSessionValue(fm.session);
      const hasBaseline = Object.prototype.hasOwnProperty.call(fm, 'scope-baseline-session');

      if (hasBaseline) {
        const baselineSession = normalizeSessionValue(fm['scope-baseline-session']);
        if (baselineSession === currentSession) {
          // Same session already froze a baseline (or both are absent,
          // which counts as a match per rule 2 above) — reject, no mutation.
          skipReason = 'already-frozen';
          return null;
        }
        // Different session — the stored baseline is stale. Fall through
        // and overwrite all five keys below.
      }

      // Resolve the denominator (#894 review finding F1): an array is the
      // RAW planned-file list, filtered here via `countPlannedFiles()` — the
      // SAME `filterExcluded()` primitive `computeDrift()`'s numerator uses
      // below, so both sides of the ratio are provably produced by one
      // function. A number is accepted for back-compat and stored verbatim.
      // Anything else is a call-site bug — throw rather than silently store
      // garbage; caught below and reported as `'unexpected-error'`, never
      // escapes this function.
      let resolvedPlannedFiles;
      if (Array.isArray(plannedFiles)) {
        resolvedPlannedFiles = countPlannedFiles(plannedFiles);
      } else if (typeof plannedFiles === 'number' && Number.isFinite(plannedFiles)) {
        resolvedPlannedFiles = plannedFiles;
      } else {
        throw new TypeError(
          'writeBaseline: plannedFiles must be a number (pre-counted, back-compat) or an array of raw file paths (filtered internally via DRIFT_EXCLUDE_PATTERNS)'
        );
      }

      fm['scope-baseline-intent'] = intent;
      fm['scope-baseline-owner-boundary'] = ownerBoundary;
      fm['scope-baseline-planned-files'] = resolvedPlannedFiles;
      fm['scope-baseline-session'] = currentSession;
      fm['scope-baseline-frozen-at'] = nowIso();

      return serializeStateMd(parsed);
    });

    if (result.written) {
      return { written: true };
    }
    // `writeStateMd()` itself refused the write (size-ceiling or
    // frontmatter-unsafe breach) — surface that reason rather than falling
    // back to the transformer's closure-captured reason, which was never
    // set on this path.
    if (result.reason === 'size-ceiling' || result.reason === 'frontmatter-unsafe') {
      return { written: false, reason: result.reason };
    }
    return { written: false, reason: skipReason ?? 'unreadable-state-md' };
  } catch (err) {
    // `writeStateMd()` throws a `TypeError` only if the transformer returns
    // a non-string/non-null/non-undefined value (never happens here), and
    // the `withStateMdLock()` it takes internally THROWS a labelled Error on
    // acquire failure BY DESIGN (state-md-lock.mjs:265-270 / :328), tagging
    // `err.code` as `STATE_LOCK_TIMEOUT` or `STATE_LOCK_FS_ERROR`. This
    // module's contract is "never throw" — map the escaping error's
    // `err.code` HONESTLY (#894 review finding F4) instead of collapsing
    // every failure into `'lock-timeout'`: a disk-full / permission failure
    // on the lock directory must not misdirect the operator toward "retry,
    // it's contention", and a genuine bug (including the `TypeError` thrown
    // above for an invalid `plannedFiles` argument) must not masquerade as a
    // transient lock condition either.
    if (err?.code === 'STATE_LOCK_TIMEOUT') {
      return { written: false, reason: 'lock-timeout' };
    }
    if (err?.code === 'STATE_LOCK_FS_ERROR') {
      return { written: false, reason: 'lock-fs-error' };
    }
    return { written: false, reason: 'unexpected-error' };
  }
}

/**
 * Compute the S2 warn-only scope-drift ratio: how many files have actually
 * changed since the session's frozen `session-start-ref`, filtered through
 * `DRIFT_EXCLUDE_PATTERNS`, against the `plannedFiles` count frozen by
 * `writeBaseline()`. Sync (`readFileSync` + `execFileSync('git', ...)`
 * only). Never throws, never denies — this is a WARN-only tripwire; the
 * CALLER decides whether/how to surface `breached`.
 *
 * Skip precedence (first match wins, so `reason` is deterministic):
 *   `no-state-md` → `unreadable-state-md` → `no-baseline` →
 *   `stale-baseline` → `unresolvable-ref`
 *
 * `session-start-ref` handling — MISSING vs UNRESOLVABLE are different:
 *   - Field absent from frontmatter → falls back to
 *     `git diff --name-only origin/main...HEAD` (the documented fallback,
 *     skills/session-end/plan-verification.md:37). This is NOT a skip —
 *     `refUsed` reports the fallback ref actually used.
 *   - Field present but the diff against it fails (rebase, force-push,
 *     deleted commit, …) → skip with `reason: 'unresolvable-ref'`.
 *
 * @param {object} args
 * @param {string|undefined} args.repoRoot
 * @param {number} [args.threshold] — breach threshold, `>=` counts as
 *   breached (default `2.0`).
 * @returns {{ ok: true, skipped: true, reason: 'no-state-md'|'unreadable-state-md'|'no-baseline'|'stale-baseline'|'unresolvable-ref' }
 *   | { ok: true, skipped: false, filesRatio: number, plannedFiles: number,
 *       actualFiles: number, breached: boolean, threshold: number, refUsed: string }}
 */
export function computeDrift({ repoRoot, threshold = 2.0 } = {}) {
  const parsedFm = readFrontmatterOrReason(repoRoot);
  if (!parsedFm.ok) {
    return { ok: true, skipped: true, reason: parsedFm.reason };
  }

  const classified = classifyBaselineFromFrontmatter(parsedFm.fm);
  if (classified === null) {
    // Distinguishable from readFrontmatterOrReason's failures — STATE.md
    // parses fine, but `scope-baseline-session` was never written.
    return { ok: true, skipped: true, reason: 'no-baseline' };
  }
  if (classified.stale === true) {
    // A fresh diff against an old denominator is noise, not a measurement
    // — no filesRatio is computed on this path.
    return { ok: true, skipped: true, reason: 'stale-baseline' };
  }

  const baseline = classified;
  const cwd = repoRoot ?? process.cwd();
  const rawRef = typeof baseline.sessionStartRef === 'string' && baseline.sessionStartRef.length > 0
    ? baseline.sessionStartRef
    : null;

  const diffArgs = rawRef !== null
    ? ['diff', '--name-only', `${rawRef}..HEAD`]
    : ['diff', '--name-only', 'origin/main...HEAD'];
  const refUsed = rawRef ?? 'origin/main...HEAD';

  let stdout;
  try {
    stdout = execFileSync('git', diffArgs, { cwd, encoding: 'utf8' });
  } catch {
    // Ref present-but-unresolvable (rebase, force-push, deleted commit) OR
    // the fallback diff itself failed (e.g. no origin/main) — both land in
    // the same skip bucket; neither can produce a trustworthy numerator.
    return { ok: true, skipped: true, reason: 'unresolvable-ref' };
  }

  const changedFiles = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Same `filterExcluded()` primitive `writeBaseline()`'s denominator
  // (`countPlannedFiles()`) calls (#894 review finding F1) — both sides of
  // the ratio are provably produced by one function.
  const actualFiles = filterExcluded(changedFiles).length;

  const plannedFilesRaw = baseline.plannedFiles;
  const plannedFiles = typeof plannedFilesRaw === 'number' && Number.isFinite(plannedFilesRaw)
    ? plannedFilesRaw
    : 0;

  // Mirrors the existing over_delivery_ratio div-by-zero guard in
  // skills/wave-executor/wave-loop.md (`files_changed / max(planned_files_count, 1)`,
  // in the per-wave metrics section). Deliberately un-line-pinned: that file is
  // edited often enough that a pinned number goes stale, as this very comment did.
  const filesRatio = round2(actualFiles / Math.max(plannedFiles, 1));
  const breached = filesRatio >= threshold;

  return {
    ok: true,
    skipped: false,
    filesRatio,
    plannedFiles,
    actualFiles,
    breached,
    threshold,
    refUsed,
  };
}
