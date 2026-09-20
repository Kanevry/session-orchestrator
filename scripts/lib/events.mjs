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
 *      when a confirmed native PROCESS-LOCAL id (`CLAUDE_CODE_SESSION_ID` or
 *      `CODEX_THREAD_ID`) equals the lock's raw `session_id`. STATE.md is NOT a
 *      witness here (#1177 FX1): it is a shared working-copy file written by
 *      the lock holder, so under a peer-owned lock both agreed about the peer
 *      and the union stamped the peer's ids. See {@link attributionForRecord}.
 *
 * The attribution root is the SAME root the ledger line is pinned to
 * (`opts.repoRoot ?? SO_PROJECT_DIR`), never `process.cwd()`. Measured cost of
 * the whole envelope (lock + wave manifest, 100 calls, this repo):
 * 0.0961 ms/call.
 */

import { promises as fs, existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getProjectDir, SO_SHARED_DIR } from './platform.mjs';
import { readLock } from './session-lock.mjs';
import { resolveStateMdPath } from './state-md/frontmatter-mutators.mjs';
import {
  classifyManifestSession,
  readProcessLocalSessionIds,
} from './session-identity/own-session.mjs';
import {
  ARCHIVE_DIR_NAME,
  ARCHIVE_NAME_RE,
  EventValidationError,
  LEGACY_RING_MAX,
  ROTATION_EVENT,
  parseEventLines,
  stampEventSchemaVersion,
  summarizeEventRecords,
  validateEventRecord,
} from './events-schema.mjs';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Test seam (#1397 item 11): the absolute path of a sandbox ledger that the
 * DEFAULT destination is redirected to whenever that default would land outside
 * the OS temp root. Set by `tests/setup/events-ledger-guard.mjs` in every
 * vitest worker, and inherited by every child process the suite spawns — which
 * is the point: the default resolves via `SO_PROJECT_DIR` (env, else a walk up
 * from the cwd), so a spawned script with `cwd = <repo>` otherwise appended
 * synthetic records, stamped with the LIVE session id, to the real ledger.
 * Nothing in production sets it.
 */
export const EVENTS_LEDGER_SANDBOX_ENV = 'SO_EVENTS_LEDGER_SANDBOX';

/**
 * OS temp root in both spellings (macOS `os.tmpdir()` is `/var/folders/…`, a
 * symlink to `/private/var/folders/…`; `process.cwd()` inside it reports the
 * canonical form). Only called while the sandbox variable is set.
 * @returns {string[]}
 */
function tmpRoots() {
  const raw = path.resolve(tmpdir());
  let real = raw;
  try { real = realpathSync(raw); } catch { /* keep the raw spelling */ }
  return real === raw ? [raw] : [raw, real];
}

/** @param {string} p @param {string[]} roots @returns {boolean} */
function isUnderAny(p, roots) {
  const abs = path.resolve(p);
  return roots.some((r) => abs === r || abs.startsWith(r + path.sep));
}

/**
 * Apply the sandbox redirect to a DEFAULT-resolved ledger path.
 *
 * Rule: redirect only a default that would leave the temp root. A fixture
 * project dir under tmp (`CLAUDE_PROJECT_DIR=<mkdtemp>`, or `cwd: <mkdtemp>`) is
 * where a test EXPECTS its records — measured 2026-09-19 @ d92c2ca4, 38 test
 * files set a project-dir env var and read `events.jsonl` back — so it is kept
 * byte-identical. Keying on "outside tmp" rather than on "is this repo's ledger"
 * is deliberate: an allow-list of protected roots fails open on the root it did
 * not name (a sibling repo, a copied plugin tree), this invariant does not.
 *
 * Why the sandbox value must itself sit under the temp root: a stray or
 * malformed export in an operator's shell must never be able to aim real
 * telemetry at another tracked file. A value outside tmp, a relative value, or
 * a whitespace-only value is IGNORED → production resolution, unchanged. What
 * this cannot prevent (BV-004 ceiling): a stray export that DOES point under
 * tmp diverts a real session's records there. The name marks it a test seam;
 * revisit if it is ever found set outside a vitest process.
 *
 * @param {string} defaultPath
 * @returns {string}
 */
function sandboxedDefault(defaultPath) {
  const sandbox = (process.env[EVENTS_LEDGER_SANDBOX_ENV] || '').trim();
  if (!sandbox || !path.isAbsolute(sandbox)) return defaultPath;
  const roots = tmpRoots();
  if (!isUnderAny(sandbox, roots) || isUnderAny(defaultPath, roots)) return defaultPath;
  return path.resolve(sandbox);
}

/**
 * Returns the absolute path to `.orchestrator/metrics/events.jsonl` under `repoRoot`.
 *
 * `repoRoot` defaults to the module-level `SO_PROJECT_DIR` constant, so the
 * zero-arg call is unchanged for every existing caller (#941). Pass an explicit
 * `repoRoot` when the destination must be pinned to a tree other than the
 * CWD/env-resolved project — e.g. a unit test running the gate against a tmp
 * repo, which must NOT append synthetic records to the real fleet telemetry.
 *
 * Only the zero-arg (default) form honours {@link EVENTS_LEDGER_SANDBOX_ENV};
 * an explicit `repoRoot` is never redirected. Readers that resolve the default
 * (session-start rotation) and raw writers that use it (the discovery-validator
 * hook) therefore see the same sandbox `emitEvent()` writes to.
 *
 * @param {string} [repoRoot=SO_PROJECT_DIR] — project root the events log lives under.
 * @returns {string}
 */
export function eventsFilePath(repoRoot) {
  if (repoRoot !== undefined) return path.join(repoRoot, SO_SHARED_DIR, 'metrics', 'events.jsonl');
  return sandboxedDefault(path.join(getProjectDir(), SO_SHARED_DIR, 'metrics', 'events.jsonl'));
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
 *   - No confirmed process-local id (absent or ambiguous native env) → `{}`. Ownership is
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
 * Manifest step 1 calls it directly to derive `wave-scope.json`'s `session_id` /
 * `semantic_session_id` binding — a hand-written prose comparison against
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
export function attributionForRecord(root = getProjectDir()) {
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
 *   - anything else → omit. That includes an UNBOUND manifest (no `session_id` /
 *     `semantic_session_id`): since #1123 BOTH writers stamp the binding, so a
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
  const attributionRoot = opts.repoRoot ?? getProjectDir();
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
  // eventsFilePath(undefined) falls through to its SO_PROJECT_DIR default, so a
  // caller passing neither behaves EXACTLY as before (additive) — except under
  // the test-only EVENTS_LEDGER_SANDBOX_ENV seam, which only 3. honours.
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

// ---------------------------------------------------------------------------
// Rotation-aware reading (#1401)
// ---------------------------------------------------------------------------

/**
 * Read one JSONL source into a descriptor — never throws.
 *
 * @param {string} filePath
 * @param {'active'|'archive'|'legacy-ring'} kind
 * @returns {{path: string, kind: string, readable: boolean, records: object[],
 *            malformed_lines: number, first_ts: string|null, last_ts: string|null,
 *            error?: string}}
 */
function readEventSource(filePath, kind) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    return {
      path: filePath,
      kind,
      readable: false,
      records: [],
      malformed_lines: 0,
      first_ts: null,
      last_ts: null,
      error: err?.message ?? String(err),
    };
  }
  const { records, malformedLines } = parseEventLines(text);
  const { firstTs, lastTs } = summarizeEventRecords(records);
  return {
    path: filePath,
    kind,
    readable: true,
    records,
    malformed_lines: malformedLines,
    first_ts: firstTs,
    last_ts: lastTs,
  };
}

/**
 * Every archive belonging to `logPath`, in BOTH schemes.
 *
 * Reading the legacy `.1`..`.N` ring is not politeness towards old code — it is
 * a live requirement: measured 2026-09-19, two fleet repos hold a ~10 MB
 * `events.jsonl.1` written before #1401 switched the writer to `_archive/`. A
 * reader that saw only the new scheme would drop that history and call the
 * result complete.
 *
 * @param {string} logPath — absolute path of the ACTIVE log.
 * @returns {{archives: string[], legacy: string[], ringHoles: number[]}}
 */
function discoverArchives(logPath) {
  const dir = path.dirname(logPath);

  const archives = [];
  const archiveDir = path.join(dir, ARCHIVE_DIR_NAME);
  try {
    for (const name of readdirSync(archiveDir).sort()) {
      if (ARCHIVE_NAME_RE.test(name)) archives.push(path.join(archiveDir, name));
    }
  } catch {
    /* no archive directory yet — not a gap, just nothing rotated here */
  }

  // The ring was contiguous BY CONSTRUCTION (each rotation shifted every slot
  // up by one), so a hole between two present slots can only mean a backup was
  // removed out of band. Slots above the highest present one are simply
  // "not rotated that many times" and are not holes.
  const present = [];
  for (let i = 1; i <= LEGACY_RING_MAX; i += 1) {
    if (existsSync(`${logPath}.${i}`)) present.push(i);
  }
  const highest = present.length > 0 ? present[present.length - 1] : 0;
  const ringHoles = [];
  for (let i = 1; i < highest; i += 1) {
    if (!present.includes(i)) ringHoles.push(i);
  }
  return { archives, legacy: present.map((i) => `${logPath}.${i}`), ringHoles };
}

/**
 * Read the events ledger ACROSS rotation boundaries — active file plus every
 * archive still on disk — in time order, reporting what is missing instead of
 * silently returning less.
 *
 * ## Why this exists (#1401)
 *
 * Before it, nothing in `scripts/` or `hooks/` read a rotated backup at all
 * (census 2026-09-19 @ `8f15f77b`: `rg -n 'jsonl\.1|jsonl\.[0-9]' scripts/ hooks/`
 * excluding tests → zero code hits). Every window analysis therefore lost its
 * whole history at each rotation, silently — which is what reduced the #1037
 * guard-attribution join to 2 of 38 sessions.
 *
 * ## The three honesty rules
 *
 * 1. **A missing archive is a FINDING, not an empty result.** When a record in
 *    a later file names `archived_as: X` and X is not on disk, that appears in
 *    `gaps` with the range X covered, and `complete` is `false`. This is the
 *    exact shape of the 2026-09-19 loss, and it is detectable only because the
 *    rotation writes that pointer (see `events-rotation.mjs`) — an archive
 *    deleted before #1401 left no trace and is undetectable by construction.
 * 2. **Unreadable lines are COUNTED** (`malformed_lines`, per source and total).
 *    A silently skipping JSONL parser turns a partial result into a clean
 *    verdict.
 * 3. **Order is by measured time, not by filename.** Sources are sorted on
 *    their earliest parseable timestamp; records within a source keep file
 *    (append) order. A source with no parseable timestamp sorts last rather
 *    than being dropped.
 *
 * CEILING (BV-004): every source is read fully into memory — at the default
 * `max-size-mb: 10` / `max-backups: 5` that is up to ~60 MB transient. There is
 * no windowing parameter because no caller has asked for one; revisit when a
 * consumer needs a `since` filter or `max-size-mb` is raised past ~100.
 *
 * @param {string} [repoRoot] — project root; defaults exactly as
 *   {@link eventsFilePath} does (and only the default form honours the test
 *   sandbox seam).
 * @param {object} [opts={}]
 * @param {string} [opts.filePath] — override the active-log path outright.
 * @returns {{events: object[], sources: object[], malformed_lines: number,
 *            gaps: object[], complete: boolean, active_path: string}}
 */
export function readEventsWithRotations(repoRoot, opts = {}) {
  const activePath = opts.filePath ?? eventsFilePath(repoRoot);
  const { archives, legacy, ringHoles } = discoverArchives(activePath);

  const sources = [
    ...archives.map((p) => readEventSource(p, 'archive')),
    ...legacy.map((p) => readEventSource(p, 'legacy-ring')),
  ];
  if (existsSync(activePath)) sources.push(readEventSource(activePath, 'active'));

  // Time order across sources; undatable sources last, stable by path.
  sources.sort((a, b) => {
    const am = a.first_ts ? Date.parse(a.first_ts) : Infinity;
    const bm = b.first_ts ? Date.parse(b.first_ts) : Infinity;
    if (am !== bm) return am - bm;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  const gaps = [];
  const onDisk = new Set(sources.map((s) => s.path));
  // Same construction `discoverArchives` uses, so its unresolved entries in
  // `onDisk` still match by string.
  const ownArchiveDir = path.join(path.dirname(activePath), ARCHIVE_DIR_NAME);

  // Rule 1 — every rotation tombstone must still point at a file.
  for (const source of sources) {
    for (const record of source.records) {
      if (record?.event !== ROTATION_EVENT) continue;
      const target = record.archived_as;
      if (typeof target !== 'string' || target.length === 0) continue;
      // #1411 — resolve the tombstone against THIS ledger's own `_archive/`,
      // by BASENAME, and never against the absolute value it stores.
      //
      // The writer keeps `archived_as` absolute (`events-rotation.mjs` joins
      // the repo root) and that value stays in the record as PROVENANCE. It is
      // not a lookup key: a moved checkout, a clone, or a sibling git worktree
      // — routine here — makes every tombstone name a path that does not exist
      // in THIS tree, so the old exact comparison reported a phantom
      // `missing-archive` for an archive sitting right beside the active file.
      // Basename, not `realpath`: realpath cannot resolve a path that no longer
      // exists, which IS the failure mode.
      //
      // ORDER (why the absolute value has no second chance): the sibling answer
      // is consulted first, and an absolute hit would only be trustworthy while
      // it pointed INSIDE this ledger's own archive dir — but any such path
      // resolves to exactly the sibling path already tested, so once the
      // sibling misses, an absolute hit can ONLY be a still-present OLD
      // checkout. Honouring it would validate THIS ledger against a FOREIGN
      // repo's archive: a silent false negative, worse than the phantom gap.
      const sibling = path.join(ownArchiveDir, path.basename(target));
      if (onDisk.has(sibling) || existsSync(sibling)) continue;
      gaps.push({
        kind: 'missing-archive',
        archived_as: target,
        first_ts: record.first_ts ?? null,
        last_ts: record.last_ts ?? null,
        lines: record.lines ?? null,
        size_before: record.size_before ?? null,
        reported_by: source.path,
        rotated_at: record.timestamp ?? null,
      });
    }
  }

  for (const slot of ringHoles) {
    gaps.push({
      kind: 'ring-hole',
      archived_as: `${activePath}.${slot}`,
      first_ts: null,
      last_ts: null,
      reported_by: activePath,
    });
  }

  for (const source of sources) {
    if (source.readable) continue;
    gaps.push({
      kind: 'unreadable-source',
      archived_as: source.path,
      first_ts: null,
      last_ts: null,
      reported_by: source.path,
      error: source.error ?? null,
    });
  }

  const events = [];
  let malformed = 0;
  for (const source of sources) {
    events.push(...source.records);
    malformed += source.malformed_lines;
  }

  return {
    events,
    sources: sources.map(({ records, ...rest }) => ({ ...rest, records: records.length })),
    malformed_lines: malformed,
    gaps,
    complete: gaps.length === 0,
    active_path: activePath,
  };
}
