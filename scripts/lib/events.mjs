/**
 * events.mjs — JSONL event emission + optional webhook POST for session-orchestrator.
 *
 * Replaces scripts/lib/events.sh. Windows-safe (no hardcoded path separators).
 * Uses native fetch (Node 20+) and fs.promises — no external dependencies.
 *
 * Part of v3.0.0 migration (Epic #124, issue #133).
 * Issue #228: removed hardcoded personal-domain default URL. Clank Event Bus URL
 * must now be supplied explicitly via CLANK_EVENT_URL when CLANK_EVENT_SECRET is set.
 *
 * ## Correlation envelope (#1177 FA3)
 *
 * Measured 2026-09-02 @ c3ab480 over 33,608 ledger records: only 22.1% carry
 * `session_id` and 4.8% carry `wave`, because filling them was every call
 * site's own job and 32 of 34 call sites pass no options at all. `emitEvent()`
 * now fills those keys itself — under three hard rules:
 *
 *   1. **Additive, never overriding.** The correlation keys are spread BEFORE
 *      `payload`, so any caller-supplied `session_id` / `semantic_session_id` /
 *      `wave` wins byte-for-byte. A payload that supplies EITHER session key
 *      suppresses the session fill entirely (both keys), so a caller that
 *      deliberately pins attribution elsewhere — `vault-mirror/telemetry.mjs`
 *      pins to `SO_PROJECT_DIR` and passes both keys — is untouched.
 *   2. **Omit, never fabricate.** When attribution cannot be PROVEN, both keys
 *      are left ABSENT — never `null`, never `''`. An absent key is the only
 *      honest encoding of "not attributable" (see `sessionAttribution()`).
 *   3. **Never a peer's id (#1123).** A shared working copy means
 *      `session.lock` can name a PEER session that won the acquire race. The
 *      lock alone therefore does not prove ownership; the fill happens only
 *      when a PROCESS-LOCAL id (`CLAUDE_CODE_SESSION_ID`, or a hook payload's
 *      `session_id`) equals the lock's raw `session_id`. STATE.md is NOT a
 *      witness here (#1177 FX1): it is a shared working-copy file written by
 *      the lock holder, so under a peer-owned lock both agreed about the peer
 *      and the union stamped the peer's ids. See {@link attributionForRecord}.
 *
 * The attribution root is the SAME root the ledger line is pinned to
 * (`opts.repoRoot ?? SO_PROJECT_DIR`), never `process.cwd()`. Measured cost of
 * the whole envelope (lock + wave manifest, 100 calls, this repo):
 * 0.0961 ms/call.
 */

import { promises as fs, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SO_PROJECT_DIR, SO_SHARED_DIR } from './platform.mjs';
import { readLock } from './session-lock.mjs';
import { resolveStateMdPath } from './state-md/frontmatter-mutators.mjs';
import {
  classifyManifestSession,
  readProcessLocalSessionIds,
} from './session-identity/own-session.mjs';
import {
  EventValidationError,
  stampEventSchemaVersion,
  validateEventRecord,
} from './events-schema.mjs';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the absolute path to `.orchestrator/metrics/events.jsonl` under `repoRoot`.
 *
 * `repoRoot` defaults to the module-level `SO_PROJECT_DIR` constant, so the
 * zero-arg call is unchanged for every existing caller (#941). Pass an explicit
 * `repoRoot` when the destination must be pinned to a tree other than the
 * CWD/env-resolved project — e.g. a unit test running the gate against a tmp
 * repo, which must NOT append synthetic records to the real fleet telemetry.
 *
 * @param {string} [repoRoot=SO_PROJECT_DIR] — project root the events log lives under.
 * @returns {string}
 */
export function eventsFilePath(repoRoot = SO_PROJECT_DIR) {
  return path.join(repoRoot, SO_SHARED_DIR, 'metrics', 'events.jsonl');
}

/**
 * Session attribution for gate/lifecycle telemetry (#928a, hoisted here #941).
 *
 * The natural shared home the two former call-site copies (`quality-gate.mjs`,
 * `run-quality-gate.mjs`) both named. Emits BOTH the UUID `session_id` and the
 * `semantic_session_id`, mirroring the field shape of
 * `orchestrator.session.lock.acquired` so gate events join against the same keys
 * existing consumers already read (see `session-close-backfill.mjs`).
 *
 * Without a lock (CI runs have none) BOTH keys are OMITTED rather than filled
 * with a placeholder: a fabricated id would silently collide across every
 * unattributed run and read as a real session; an empty string would satisfy a
 * truthiness check while attributing to nothing. An absent key is the only
 * honest encoding of "not attributable".
 *
 * @param {string} [repoRoot] — repo whose `session.lock` is read for attribution.
 * @returns {{session_id?: string, semantic_session_id?: string}}
 */
export function sessionAttribution(repoRoot) {
  try {
    const lock = readLock({ repoRoot });
    if (!lock) return {};
    const out = {};
    if (typeof lock.session_id === 'string' && lock.session_id.trim()) {
      out.session_id = lock.session_id;
    }
    if (typeof lock.semantic_session_id === 'string' && lock.semantic_session_id.trim()) {
      out.semantic_session_id = lock.semantic_session_id;
    }
    return out;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Correlation envelope (#1177 FA3)
// ---------------------------------------------------------------------------

/** State-dir candidates, in the same order `state-md` resolves them. */
const STATE_DIR_CANDIDATES = ['.claude', '.codex', '.cursor', '.pi'];

/**
 * Session-correlation keys for a record pinned to `root` — `{}` when ownership
 * is not provable.
 *
 * Decision, in one line: **only a PROCESS-LOCAL id may confirm the lock, and
 * when one exists it decides alone.**
 *
 *   - No lock (CI, a bare script) → `{}`. Nothing to attribute to.
 *   - No process-local id (`CLAUDE_CODE_SESSION_ID` absent) → `{}`. Ownership is
 *     UNPROVEN, and an unproven attribution is exactly the peer-id write #1123
 *     forbids; an absent key costs a correlation, a wrong key costs a false one.
 *   - A process-local id that equals the lock's raw `session_id` → fill BOTH
 *     keys, verbatim from the lock.
 *   - A process-local id that DISAGREES → `{}` (the lock names a peer that won
 *     the acquire race).
 *
 * **Why STATE.md is not a witness (#1177 FX1).** It used to be one, unioned
 * with the env id — and the union was the bug: `.claude/STATE.md` is a SHARED
 * working-copy artefact written by the session that OWNS the working copy,
 * i.e. normally the lock holder. When a peer holds the lock, the peer also
 * wrote STATE.md, so both "independent" witnesses name the PEER and a
 * disagreeing process-local id could not veto them. Measured: lock=peer,
 * STATE.md=peer, `CLAUDE_CODE_SESSION_ID`=me → the peer's ids were stamped on
 * this session's records. A shared file cannot prove which PROCESS is emitting;
 * see `readProcessLocalSessionIds()` for the tiering rationale (HR-102: a
 * better signal replaces a worse one, it does not merely get outvoted by it).
 *
 * CEILING (BV-004): the comparison is against the lock's RAW `session_id`, so a
 * harness that ROTATES its session id mid-session (see
 * `tests/hooks/on-session-end.test.mjs` `new-rotated-uuid`) has an env id that
 * no longer equals the lock's raw id, and BOTH keys are then omitted — honest
 * absence, never misattribution. REVISIT when the rotation rate is measured in
 * `events.jsonl` (count `orchestrator.session.started` against lock rewrites):
 * if rotation is common, the lock must be refreshed on rotation rather than
 * this comparison widened.
 *
 * **THE manifest-binding writer contract (#1207).** This function is not only
 * `emitEvent()`'s correlation fill — it is the canonical primitive for every
 * caller that needs to name a `.orchestrator/`-adjacent artefact as "mine"
 * without risking a peer's id. `skills/wave-executor/wave-loop.md` § Scope
 * Manifest step 1 calls it directly to derive `wave-scope.json`'s `session` /
 * `semantic_session` binding — a hand-written prose comparison against
 * STATE.md previously stood in for exactly this check, and (per the STATE.md
 * caveat above) that comparison could not veto a peer-owned lock. Any new
 * writer facing the same "is this working-copy-shared artefact mine to
 * stamp?" question should call this function rather than re-deriving the
 * raw-id-vs-process-local comparison inline (see `scripts/memory-propose.mjs`
 * `resolveRunningWaveId()` for a case that reads the SAME lock but needs the
 * semantic id plus diagnostic detail this function's `{}`-on-any-mismatch
 * contract intentionally does not expose, and keeps its own comparison for
 * that reason).
 *
 * @param {string} [root=SO_PROJECT_DIR] — the repo the record is pinned to.
 * @returns {{session_id?: string, semantic_session_id?: string}}
 */
export function attributionForRecord(root = SO_PROJECT_DIR) {
  const attribution = sessionAttribution(root);
  const lockRawId =
    typeof attribution.session_id === 'string' ? attribution.session_id.trim() : '';
  if (!lockRawId) return {};
  const processLocal = readProcessLocalSessionIds();
  if (processLocal.length === 0) return {};
  return processLocal.includes(lockRawId) ? { ...attribution } : {};
}

/**
 * Absolute path of the active `wave-scope.json`, or `null` when none exists.
 *
 * The active platform's state dir is tried first (via `resolveStateMdPath()`,
 * the repo's existing resolver), then the remaining candidates — so a Codex or
 * Cursor run finds its own manifest rather than a stale `.claude/` one.
 *
 * @param {string} root
 * @returns {string|null}
 */
function waveScopePath(root) {
  const dirs = [];
  try {
    dirs.push(path.dirname(resolveStateMdPath(root)));
  } catch {
    /* fall through to the fixed candidate list */
  }
  for (const dir of STATE_DIR_CANDIDATES) {
    const abs = path.join(root, dir);
    if (!dirs.includes(abs)) dirs.push(abs);
  }
  for (const dir of dirs) {
    const candidate = path.join(dir, 'wave-scope.json');
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* unreadable candidate — try the next one */
    }
  }
  return null;
}

/**
 * `{ wave }` from the live wave-scope manifest — `{}` when the manifest is
 * missing, waveless, or belongs to another session.
 *
 * The manifest is a SHARED working-copy artefact (`.claude/wave-scope.json`),
 * so a peer session's manifest is readable here and would stamp this session's
 * events with a foreign wave number. Ownership is classified with
 * `classifyManifestSession()` against the PROCESS-LOCAL id set plus whatever
 * `attributionForRecord()` actually filled — the same tiering as the session
 * keys, for the same reason (a shared file cannot prove which process emits):
 *
 *   - manifest classified `own` → fill (as a NUMBER, see below).
 *   - anything else → omit. That includes an UNBOUND manifest (no `session` /
 *     `semantic_session`): since #1123 BOTH writers stamp the binding, so a
 *     manifest without one is a peer's or a stale artefact, never a legacy own
 *     one. It also includes `unknown` because we cannot resolve our own
 *     identity — stricter than `classifyManifestSession()`'s own `unknown`
 *     doctrine on purpose: a wave number is data on the record, not a feature
 *     gate, so "cannot tell" must not become "stamp it anyway".
 *
 * @param {string} root
 * @param {{session_id?: string, semantic_session_id?: string}} attribution
 * @returns {{wave?: number}}
 */
function waveForRecord(root, attribution) {
  let scope;
  try {
    const file = waveScopePath(root);
    if (!file) return {};
    scope = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  // The ledger's `wave` is numeric in 1876 of 1876 live records; a manifest
  // carrying `"wave": "3"` used to write the STRING through verbatim and split
  // every downstream group-by. Coerce, and omit anything that is not an integer
  // (`"abc"`, `2.5`) rather than writing a NaN or a fraction.
  const waveNum = Number(scope?.wave);
  if (scope?.wave === null || scope?.wave === '' || !Number.isInteger(waveNum)) return {};

  const ownIds = new Set([
    ...readProcessLocalSessionIds(),
    ...[attribution.session_id, attribution.semantic_session_id].filter(Boolean),
  ]);
  const { verdict } = classifyManifestSession(scope, ownIds);
  return verdict === 'own' ? { wave: waveNum } : {};
}

/**
 * Append a JSONL event record and optionally POST to the Clank Event Bus webhook.
 *
 * Writes `{timestamp, event, schema_version, ...payload}` as a single JSON line
 * to `.orchestrator/metrics/events.jsonl` (creates parent directory if needed).
 * If both `CLANK_EVENT_SECRET` and `CLANK_EVENT_URL` are set, fires an async
 * fire-and-forget POST to `CLANK_EVENT_URL` with a 3-second timeout. Network
 * errors are swallowed. Write errors propagate to the caller. No personal-domain
 * default URL exists — both vars must be set explicitly (#228).
 *
 * Validation + versioning (#1177). Every record is stamped via
 * `stampEventSchemaVersion()` (the schema module's own stamper — it fills the
 * field only when absent, so a caller keeps authority over it) and run through
 * `validateEventRecord()` BEFORE any side effect. An invalid record throws
 * `EventValidationError` and produces NO ledger line and NO webhook POST —
 * a malformed event is dropped at the producer rather than written and
 * discovered by a downstream reader. The stamp is applied AFTER the payload
 * spread, and still yields to it: the helper fills the field only when it is
 * absent or null, so a caller supplying its own `schema_version` wins.
 *
 * Correlation envelope (#1177 FA3). When the payload carries neither session
 * key, `session_id`/`semantic_session_id` are filled from
 * {@link attributionForRecord}; when it carries no `wave`, `wave` is filled
 * from the OWN wave-scope manifest. Both are additive and omitted whenever
 * ownership is unproven — see the module header for the three rules.
 *
 * The webhook body deliberately stays `{ event_type, source, payload }` with the
 * RAW payload — the wire format is a published contract with an external
 * consumer; `schema_version` describes the JSONL record, not the webhook
 * envelope, and is not added to it.
 *
 * @param {string} type — event type (e.g. "orchestrator.session.started")
 * @param {object} [payload={}] — additional fields shallow-merged into the record
 * @param {object} [opts={}] — emission options.
 * @param {string} [opts.filePath] — override the destination JSONL path. Defaults
 *   to `eventsFilePath()` (the project's `.orchestrator/metrics/events.jsonl`).
 *   Used by `scripts/emit-event.mjs --file` so shell callers (e.g.
 *   compute-grounding-injection.sh) can target a pre-resolved EVENTS_JSONL path
 *   without depending on platform.mjs CWD/env resolution (#611).
 * @param {string} [opts.repoRoot] — pin the destination to `<repoRoot>/.orchestrator/
 *   metrics/events.jsonl` instead of the module-level `SO_PROJECT_DIR` default
 *   (#941). Ignored when `opts.filePath` is given (explicit path wins). This is
 *   the clean interface replacing the hand-built `join(repoRoot, …)` recipes that
 *   used to open-code this destination at each call-site.
 * @returns {Promise<void>}
 */
export async function emitEvent(type, payload = {}, opts = {}) {
  // Correlation envelope (#1177 FA3) — computed against the SAME root the line
  // is pinned to. Both fills are gated on the payload NOT already carrying the
  // key, and both spread BEFORE `payload`, so a caller always wins twice over.
  // A payload that supplies EITHER session key suppresses BOTH: mixing a
  // caller's `session_id` with a lock-derived `semantic_session_id` would
  // silently produce a record whose two id fields name different sessions.
  const attributionRoot = opts.repoRoot ?? SO_PROJECT_DIR;
  const correlation = {};
  if (payload.session_id === undefined && payload.semantic_session_id === undefined) {
    Object.assign(correlation, attributionForRecord(attributionRoot));
  }
  if (payload.wave === undefined) {
    Object.assign(correlation, waveForRecord(attributionRoot, correlation));
  }

  // Build the JSONL record: timestamp + event first, payload spreads last, and
  // `stampEventSchemaVersion()` — the schema module's own stamper, which only
  // fills an ABSENT/null field — adds the version. Routing through the helper
  // instead of inlining `schema_version: CURRENT_SCHEMA_VERSION` keeps the
  // stamp rule in ONE place: a caller-supplied version still wins, because the
  // helper never overwrites a value the spread already put there.
  const record = stampEventSchemaVersion({
    timestamp: new Date().toISOString(),
    event: type,
    ...correlation,
    ...payload,
  });

  // Validate BEFORE any side effect — no line, no directory, no webhook (#1177).
  const verdict = validateEventRecord(record);
  if (!verdict.valid) {
    throw new EventValidationError(
      `invalid event record for "${String(type)}": ${verdict.errors.join('; ')}`,
      verdict.errors,
      typeof type === 'string' ? type : undefined,
    );
  }

  const line = JSON.stringify(record) + '\n';

  // Ensure the destination directory exists before appending. Resolution order:
  //   1. explicit opts.filePath (a pre-resolved path — #611)
  //   2. opts.repoRoot → <repoRoot>/.orchestrator/metrics/events.jsonl (#941)
  //   3. the SO_PROJECT_DIR default (unchanged for 2-arg callers)
  // eventsFilePath(undefined) falls through to its SO_PROJECT_DIR default param,
  // so a caller passing neither behaves EXACTLY as before (additive).
  const filePath = opts.filePath ?? eventsFilePath(opts.repoRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, line, 'utf8');

  // Fire-and-forget webhook POST — only when secret AND URL are configured.
  // No personal-domain default: CLANK_EVENT_URL must be set explicitly (#228).
  if (process.env.CLANK_EVENT_SECRET && process.env.CLANK_EVENT_URL) {
    const url = process.env.CLANK_EVENT_URL;
    const body = JSON.stringify({
      event_type: type,
      source: 'session-orchestrator',
      payload,
    });

    fetch(`${url}/api/webhooks/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CLANK_EVENT_SECRET}`,
      },
      body,
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  }
}
