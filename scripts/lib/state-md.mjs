/**
 * STATE.md helpers (issue #184).
 *
 * Thin barrel — re-exports every public symbol of the split submodules.
 * Implementation lives in scripts/lib/state-md/*.mjs.
 *
 * @see scripts/lib/state-md/yaml-parser.mjs        parseStateMd, serializeStateMd
 * @see scripts/lib/state-md/frontmatter-mutators.mjs touchUpdatedField, updateFrontmatterFields
 * @see scripts/lib/state-md/body-sections.mjs       readCurrentTask, appendDeviation, markExpressPathComplete, appendWhatNotToRetry, readWhatNotToRetry, readOpenQuestions, appendOpenQuestion, markOpenQuestionAnswered
 * @see scripts/lib/state-md/mission-status.mjs      parseMissionStatus, parseMissionStatusStrict, MISSION_STATUS_VALUES, writeMissionStatus, setMissionStatus, setMissionStatusDetailed, readMissionStatus, recoverFrontmatterMissionStatusDetailed, writeMissionStatusOnDisk, setMissionStatusOnDisk
 * @see scripts/lib/state-md/recommendations.mjs     parseRecommendations
 *
 * Plus TWO small non-re-export surfaces at the bottom of this file (each with
 * its own docblock explaining why it is composed here rather than added as a
 * fourth mutator module): the `session-profile` frontmatter accessors, and the
 * `started_at` / `session-id` frontmatter SOURCES (#1368).
 */

import { parseStateMd as _parseStateMd } from './state-md/yaml-parser.mjs';
import { updateFrontmatterFields as _updateFrontmatterFields } from './state-md/frontmatter-mutators.mjs';
import { readLock as _readLock } from './session-lock.mjs';
import { readProcessLocalSessionIds as _readProcessLocalSessionIds } from './session-identity/own-session.mjs';

export { parseStateMd, serializeStateMd } from './state-md/yaml-parser.mjs';

export {
  touchUpdatedField,
  updateFrontmatterFields,
  resolveStateArtifactPath,
  resolveStateMdPath,
  writeStateMd,
  updateFrontmatterFieldsOnDisk,
  touchUpdatedFieldOnDisk,
} from './state-md/frontmatter-mutators.mjs';

export {
  readCurrentTask,
  appendDeviation,
  markExpressPathComplete,
  recordAutoCommit,
  appendDeviationOnDisk,
  recordAutoCommitOnDisk,
  markExpressPathCompleteOnDisk,
  appendWhatNotToRetry,
  readWhatNotToRetry,
  appendWhatNotToRetryOnDisk,
  readOpenQuestions,
  appendOpenQuestion,
  markOpenQuestionAnswered,
  appendOpenQuestionOnDisk,
  markOpenQuestionAnsweredOnDisk,
  MAX_OPEN_QUESTIONS_STORED,
} from './state-md/body-sections.mjs';

export {
  parseMissionStatus,
  // The strict reader and the status vocabulary are part of the same public
  // surface as `parseMissionStatus` (#1111) — a consumer that imports from this
  // barrel (the documented entry point) reached neither until this re-export
  // landed: a static `import { parseMissionStatusStrict } from '.../state-md.mjs'`
  // failed at link time, and the `await import()` form — the one hooks and
  // lazy loaders use — yielded `undefined` and failed only at the call.
  parseMissionStatusStrict,
  MISSION_STATUS_VALUES,
  writeMissionStatus,
  setMissionStatus,
  readMissionStatus,
  writeMissionStatusOnDisk,
  setMissionStatusOnDisk,
  recoverFrontmatterMissionStatusDetailed,
  setMissionStatusDetailed,
} from './state-md/mission-status.mjs';

export { parseRecommendations } from './state-md/recommendations.mjs';

// ---------------------------------------------------------------------------
// Session profile (PRD docs/prd/2026-09-06-ultradeep-session-profile.md)
// ---------------------------------------------------------------------------
//
// `session-profile` is an OPTIONAL STATE.md frontmatter scalar that names a
// wave-shape variant on top of an unchanged `session-type`. Today exactly one
// value is defined — `ultradeep` (7 waves, coordinator-direct Synthesis-Gate at
// wave 2) — resolved from the `/session ultradeep` argument alias in
// `commands/session.md`.
//
// The vocabulary is deliberately NOT a closed set here. A profile changes only
// how the coordinator shapes waves; unlike `session_type` (a closed set in
// scripts/lib/session-schema/constants.mjs, telemetry and the close-backfill),
// no consumer branches on the value, so an unknown one degrades to "a profile
// this reader does not recognise" rather than to a silent mislabel. Revisit
// trigger: the first consumer that BRANCHES on a specific profile value — at
// that point the set becomes load-bearing and belongs in a shared constant.
//
// Composed from the two existing helpers above rather than reaching into the
// frontmatter with a second parser: `parseStateMd` for the read,
// `updateFrontmatterFields` for the write (whose null/undefined semantics
// already mean DELETE, which is exactly "no profile").

/** Frontmatter key holding the optional session profile. */
export const SESSION_PROFILE_FIELD = 'session-profile';

/**
 * Read the session profile from STATE.md contents.
 *
 * ABSENCE IS NEVER COERCED. Returns `null` — not `''`, not `'none'` — when the
 * document has no frontmatter, no `session-profile` key, or a value that is not
 * a non-empty string. Callers test `=== null` for "no profile"; they must not
 * test truthiness of a string they assumed was always present.
 *
 * @param {string} contents  Full STATE.md text.
 * @returns {string|null} The profile name, or null when no profile is set.
 */
export function readSessionProfile(contents) {
  if (typeof contents !== 'string') return null;
  const parsed = _parseStateMd(contents);
  if (parsed === null) return null;
  const value = parsed.frontmatter[SESSION_PROFILE_FIELD];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Set or clear the session profile in STATE.md contents.
 *
 * Passing `null` DELETES the key, restoring the absent (= no profile) state —
 * it never writes a placeholder value. Every other frontmatter key, including
 * unknown extensions, is preserved verbatim by `updateFrontmatterFields`.
 * No-ops (returns the input unchanged) when `contents` has no frontmatter.
 *
 * @param {string} contents  Full STATE.md text.
 * @param {string|null} profile  Profile name, or null to clear.
 * @returns {string} The new STATE.md text.
 * @throws {TypeError} when `profile` is neither a non-empty string nor null.
 */
export function setSessionProfile(contents, profile) {
  if (profile !== null && (typeof profile !== 'string' || profile.trim().length === 0)) {
    throw new TypeError(
      `setSessionProfile: profile must be a non-empty string or null, got: ${JSON.stringify(profile)}`
    );
  }
  return _updateFrontmatterFields(contents, {
    [SESSION_PROFILE_FIELD]: profile === null ? null : profile.trim(),
  });
}

// ---------------------------------------------------------------------------
// STATE.md frontmatter SOURCES (#1368) — `started_at` / `session-id`.
//
// These two helpers exist because the frontmatter they feed is written by the
// coordinator LLM from prose, and prose with no named source gets written from
// `new Date()` at WRITE time. `started_at` then names the moment STATE.md was
// created, not the moment the session began — measured 2026-09-13: 48 minutes
// apart. Every other producer of that timestamp (the lock's own `started_at`,
// `orchestrator.session.lock.acquired`, `orchestrator.session.started`) agrees
// within 1 ms, because all three descend from `buildLock()`. So the lock is
// the source, and these functions are how the template cites it.
//
// They live in this barrel rather than in `state-md/`: the barrel is the
// documented entry point for STATE.md work, and the edge barrel → session-lock
// already exists (state-md/frontmatter-mutators.mjs imports `withStateMdLock`
// from it), so no cycle is created — session-lock.mjs imports nothing from
// this module or its submodules.
// ---------------------------------------------------------------------------

/**
 * The canonical `started_at` for a STATE.md written during THIS session.
 *
 * Returns the live lock's `started_at`, normalised to ISO-8601 UTC ("Z"), so
 * STATE.md, the lock, both lock events and the ledger all name the SAME
 * instant. Falls back to `new Date().toISOString()` ONLY when no usable lock
 * exists — a missing lock means `persistence: false`, a lock that could not be
 * acquired, or a corrupt lock file, and in all three the writer has no better
 * source than the present moment. The fallback is deliberately silent: it is a
 * degradation of PRECISION, not a failure.
 *
 * A lock that is PROVABLY a peer's falls back the same way (#1730 Pkt 8): the
 * lock is repo-global, so the checkout a writer stands in can hold another
 * session's lock — the Lead's in the main checkout, for one. Its `started_at`
 * is that session's start, and stamping it would make this STATE.md claim the
 * peer's start. Ownership is judged exactly as in `resolveSessionIds()` (#1663,
 * shared `lockOwnership()`); a process that cannot name its own id keeps the
 * lock's instant, as before.
 *
 * Never throws.
 *
 * @param {{ repoRoot?: string, env?: object }} [opts]  `env` defaults to
 *   `process.env`; injectable for tests.
 * @returns {string} ISO-8601 UTC timestamp.
 */
export function resolveSessionStartedAt({ repoRoot, env = process.env } = {}) {
  try {
    const lock = _readLock({ repoRoot });
    if (lockOwnership(lock, env).provablyForeign) return new Date().toISOString();
    const raw = lock?.started_at;
    if (typeof raw === 'string' && raw.length > 0) {
      const ms = Date.parse(raw);
      if (Number.isFinite(ms)) return new Date(ms).toISOString();
    }
  } catch {
    /* readLock is no-throw by contract; the contract is not ours to trust */
  }
  return new Date().toISOString();
}

/**
 * The session ids a STATE.md writer may stamp into frontmatter: `session-id`
 * (the RAW/native harness id) and `session` (the semantic attribution label),
 * both read from the live lock — and `session-id` only when the lock is
 * provably THIS process's own (#1663).
 *
 * The lock is repo-global: a session that lost the acquire race, or a
 * pre-#1641 lock without `claude_pid` that survives until its TTL, names a
 * PEER. Since #1661 `/close` decides ownership by comparing STATE.md
 * `session-id` against `readProcessLocalSessionIds()`, so stamping the peer's
 * id would make this session's own STATE.md read `foreign` and stop its own
 * close. Hence:
 *   - `session_id` is the lock's raw id only when it is contained in
 *     `readProcessLocalSessionIds({ env })`; otherwise `null`. A process that
 *     cannot name its own id (Cursor, Pi, Codex without a thread id) gets
 *     `null` too — unprovable is not own.
 *   - `semantic_session_id` is `null` when the lock is PROVABLY foreign (this
 *     process has an id and the lock names another). Ceiling (BV-004): when
 *     the process has no id at all, the label is still taken from the lock,
 *     as before #1663, so the #429 label join keeps working on those
 *     harnesses — it may then name a peer. Revisit when every harness
 *     exposes a native id.
 *
 * ABSENCE IS NEVER COERCED: a writer must OMIT a `null` key rather than write
 * a placeholder. Neither id grants ownership of anything (see
 * `skills/_shared/state-ownership.md`); `session-id` exists so `/close`'s #429
 * pre-check can join STATE.md to sessions.jsonl on a native identity instead
 * of falling through to the label + timestamp path.
 *
 * Never throws.
 *
 * @param {{ repoRoot?: string, env?: object }} [opts]  `env` defaults to
 *   `process.env`; injectable for tests.
 * @returns {{ session_id: string|null, semantic_session_id: string|null }}
 */
export function resolveSessionIds({ repoRoot, env = process.env } = {}) {
  try {
    const lock = _readLock({ repoRoot });
    const { lockId, own, provablyForeign } = lockOwnership(lock, env);
    return {
      session_id: own ? lockId : null,
      semantic_session_id: provablyForeign ? null : pickId(lock?.semantic_session_id),
    };
  } catch {
    return { session_id: null, semantic_session_id: null };
  }
}

/** A trimmed non-empty string, else `null`. */
function pickId(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Whose lock is this? The ONE ownership judgement both STATE.md sources use, so
 * `started_at` and `session-id` can never disagree about the same lock (#1663,
 * #1730 Pkt 8). `own`: the lock's raw id is one of this process's own ids.
 * `provablyForeign`: this process names at least one id and the lock carries
 * another. A process without an id is neither — unprovable is not foreign.
 *
 * @param {object|null} lock  `readLock()` result
 * @param {object} env
 * @returns {{ lockId: string|null, own: boolean, provablyForeign: boolean }}
 */
function lockOwnership(lock, env) {
  const lockId = pickId(lock?.session_id);
  const ownIds = _readProcessLocalSessionIds({ env });
  const own = lockId !== null && ownIds.includes(lockId);
  return { lockId, own, provablyForeign: lockId !== null && ownIds.length > 0 && !own };
}
