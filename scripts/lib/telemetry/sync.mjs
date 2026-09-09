/**
 * telemetry/sync.mjs — batch build + offline-tolerant sync for anonymous usage
 * telemetry (Epic #841, Issue #844 / S3 FA3; PRD
 * docs/prd/2026-07-20-anonymous-usage-telemetry.md §3-FA3).
 *
 * This module is the SEND path. It ties together the W2 primitives:
 *   - consent.mjs  — resolveConsent (the outermost gate), telemetry.json read/write
 *   - schema.mjs   — buildUsagePing + projectUsagePing (whitelist projection)
 *   - anon-id.mjs  — ensureAnonId (lazy mint + 90-day rotation)
 *   - queue.mjs    — the bounded NDJSON offline queue
 *
 * ── Outermost-seam gating (load-bearing privacy invariant) ───────────────────
 * `resolveConsent()` is the FIRST statement of `flush()`. When it returns
 * `send !== true` the function returns immediately — nothing below the gate is
 * reachable: no fetch, no queue write, and NO anon-ID minting. The anon-ID is
 * minted lazily inside `buildBatch()`, which `flush()` calls ONLY after the gate
 * has passed. This makes "no ID exists until an affirmative-consent send is
 * actually attempted" a structural guarantee, not a discipline.
 *
 * ── Fire-and-forget, never-throw ─────────────────────────────────────────────
 * A flush never throws and never blocks a session beyond the POST timeout. On
 * any send failure (network, timeout, non-2xx) the batch lands in the host-local
 * queue (bounded, oldest-dropped) and the session closes with zero user-facing
 * error.
 *
 * Node ESM. The only network dependency is the global `fetch`.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import {
  resolveConsent,
  readTelemetryState,
  writeTelemetryState,
  TELEMETRY_JSON_PATH,
} from './consent.mjs';
import { buildUsagePing, projectUsagePing, normalizeSessionProfile } from './schema.mjs';
import { ensureAnonId } from './anon-id.mjs';
import { peekAll, enqueue, clear, queueStats } from './queue.mjs';
import { loadOwnerConfig } from '../owner-yaml.mjs';
import { readJsonlFile } from '../io.mjs';
import { readCanonicalSessions } from '../sessions-canonical.mjs';
import { resolvePrivateConfigDir } from '../config/private-config-dir.mjs';
import { readSessionProfile } from '../state-md.mjs';
import { resolveStateMdPath } from '../state-md/frontmatter-mutators.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Public ingest endpoint. Overridable per-process via SO_TELEMETRY_ENDPOINT (tests/staging). */
export const TELEMETRY_ENDPOINT = 'https://telemetry.session-orchestrator.com/v1/records';

/** Fire-and-forget POST timeout (ms). */
export const POST_TIMEOUT_MS = 3000;

/** Daily-fallback horizon: only flush a backlog older than this. */
const DAILY_FLUSH_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Resolve the effective ingest endpoint (env override wins). */
function resolveEndpoint(env) {
  const override = (env?.SO_TELEMETRY_ENDPOINT || '').trim();
  return override || TELEMETRY_ENDPOINT;
}

/**
 * The default network sender: one POST carrying the whole batch array as the
 * JSON body (the server accepts arrays), with an AbortSignal timeout. Resolves
 * on a 2xx status, rejects on anything else (which routes the caller into the
 * offline queue).
 *
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {number} opts.timeoutMs
 * @returns {(batches: object[]) => Promise<void>}
 */
function defaultSender({ env, timeoutMs }) {
  const endpoint = resolveEndpoint(env);
  return async (batches) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batches),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      // The status travels ON the error: `flush` needs it to tell a TRANSPORT
      // failure (re-queue) from a SCHEMA rejection (evict — see
      // `isSchemaRejection`). A bare Error carries no such distinction, and
      // parsing the message string would be a second, drift-prone encoding.
      const err = new Error(`telemetry endpoint returned HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// Sandbox guard (GitLab #1234)
// ---------------------------------------------------------------------------

/**
 * THE BUG THIS EXISTS FOR: Wave-1 sandbox runs sent 6 production pings with a
 * wrong session_type on 2026-09-06.
 *
 * Six agent sandboxes executed `hooks/on-session-end.mjs` from the repo checkout
 * at 11:02:50–11:03:36Z. Each one resolved the OPERATOR's real `anon_id` and real
 * consent from `~/.config/session-orchestrator/telemetry.json` — because
 * `paths.mjs` computes that path from `homedir()` and does NOT honour
 * `SO_CONFIG_HOME` — while `owner.yaml` was unreachable inside the sandbox and
 * `sessions.jsonl` did not exist. Result: six real records on the ingest server,
 * attributed to a real person, carrying `session_type: "other"` and `fleet: 0`.
 * Same failure class as the d7-F2 registry leak: a bench harness whose SOURCE was
 * faked but whose DESTINATION was not.
 *
 * The guard refuses the send. It runs AFTER the consent gate (so the documented
 * outermost-seam invariant is untouched — see the module docblock) and BEFORE
 * `buildBatch()`, so a refused send performs no network call, no queue write and
 * NO anon-ID mint.
 *
 * Detection, three independent conditions — any ONE refuses:
 *
 *  (a) `SO_TELEMETRY_DISABLED` / `DO_NOT_TRACK` — already refused one layer up by
 *      `resolveConsent()`; re-asserted here so the guard is complete on its own
 *      and a future reordering cannot silently drop it.
 *  (b) CONFIG-HOME SPLIT — `SO_CONFIG_HOME` / `XDG_CONFIG_HOME` declares a config
 *      home, but the telemetry state is NOT read from inside it. That split IS
 *      the leak: the caller believes it redirected the identity, and it did not.
 *      A caller that redirects CONSISTENTLY (declared home + a `statePath`
 *      inside it) has actually isolated itself and is permitted.
 *  (c) TEMP-ROOT — `CLAUDE_PROJECT_DIR` (or the cwd) sits under the OS temp
 *      directory or `/tmp`, WHILE the identity is a real one. A real operator
 *      session runs from a real checkout.
 *
 * A FOURTH outcome is the guard's own failure: if any probe throws, the answer is
 * `sandbox: true` with `reason: 'sandbox:probe-failed'`. An environment the guard
 * cannot classify is treated as one it would have refused.
 *
 * (b) and (c) share one principle, and it is the whole design: **the guard
 * protects the DEFAULT host identity.** When the effective telemetry state path
 * is itself throwaway — inside the declared config home, or under a temp root —
 * there is no operator identity to leak and the send is permitted. That is what
 * keeps a properly-isolated harness (this repo's convention: a tmp `HOME`, see
 * `tests/_helpers/telemetry-isolation.mjs`) sendable, while the Wave-1 shape —
 * a redirect that the state reader ignored, so the REAL anon_id was used —
 * is refused.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.statePath] — an explicit telemetry.json override, if any.
 * @param {string} [opts.cwd]
 * @returns {{ sandbox: boolean, reason: string|null }}
 */
export function detectSandbox({ env = process.env, statePath, cwd } = {}) {
  try {
    // (a) explicit opt-out env — belt to resolveConsent's braces.
    if (env?.SO_TELEMETRY_DISABLED === '1') return { sandbox: true, reason: 'sandbox:telemetry-disabled' };
    const dnt = (env?.DO_NOT_TRACK || '').trim();
    if (dnt !== '' && dnt !== '0' && dnt.toLowerCase() !== 'false') {
      return { sandbox: true, reason: 'sandbox:do-not-track' };
    }

    // The state path that will ACTUALLY be read — the identity at stake.
    const effectiveStatePath = realOrSelf(statePath || TELEMETRY_JSON_PATH);

    // (b) config-home split: a declared config home that the state path is not
    //     inside. `resolvePrivateConfigDir` returns the homedir default when
    //     nothing is declared, which is why the raw env vars are checked here —
    //     an undeclared default is not a split, it is the normal case.
    const declaredHome = (env?.SO_CONFIG_HOME || '').trim() || (env?.XDG_CONFIG_HOME || '').trim();
    if (declaredHome !== '') {
      const declaredDir = realOrSelf(resolvePrivateConfigDir({ env }));
      if (!isUnder(effectiveStatePath, declaredDir)) {
        return { sandbox: true, reason: 'sandbox:config-home-split' };
      }
    }

    // (c) temp-root project WHILE the identity is real. Compare REAL paths:
    //     macOS $TMPDIR is /var/folders/… symlinked to /private/var/folders/…,
    //     so a string prefix on the raw values misses every macOS sandbox.
    const tempRoots = [os.tmpdir(), '/tmp'].filter(Boolean).map(realOrSelf);
    const identityIsThrowaway = tempRoots.some((root) => isUnder(effectiveStatePath, root));
    if (!identityIsThrowaway) {
      const project = realOrSelf((env?.CLAUDE_PROJECT_DIR || '').trim() || cwd || process.cwd());
      if (tempRoots.some((root) => isUnder(project, root))) {
        return { sandbox: true, reason: 'sandbox:temp-root' };
      }
    }

    return { sandbox: false, reason: null };
  } catch {
    // A guard that throws must never become a guard that permits — and until
    // 2026-09-06 this catch said exactly that while doing the opposite
    // (`{ sandbox: false }`, i.e. PERMIT on probe failure). It now fails CLOSED.
    //
    // What is refused is one ping, and the batch is not lost: `flush` returns
    // `reason: 'sandbox:probe-failed'`, writes no queue mutation, and the next
    // session's flush re-probes from scratch. What the old branch risked is the
    // thing this guard exists to prevent — a real `anon_id` leaving an
    // environment the guard could not classify.
    return { sandbox: true, reason: 'sandbox:probe-failed' };
  }
}

/** True when `candidate` IS `root` or lies beneath it (both already realpath'd). */
function isUnder(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * `fs.realpathSync` for a path that may not exist yet.
 *
 * Resolving the NEAREST EXISTING ANCESTOR and re-appending the remainder is the
 * load-bearing part, not a nicety: on macOS `$TMPDIR` is `/var/folders/…`, a
 * symlink to `/private/var/folders/…`. A plain `realpathSync` on a not-yet-created
 * `<tmp>/telemetry.json` throws, the raw `/var/folders/…` string is returned, and
 * it then fails to match the realpath'd `/private/var/folders/…` temp root — so
 * every comparison against a path that does not exist yet silently comes out
 * "not under the temp root". Measured while writing this guard's own tests.
 *
 * @param {string} p
 * @returns {string}
 */
function realOrSelf(p) {
  let abs = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(abs), ...tail);
    } catch {
      const parent = path.dirname(abs);
      if (parent === abs) return path.resolve(p); // reached the root, nothing exists
      tail.unshift(path.basename(abs));
      abs = parent;
    }
  }
}

// ---------------------------------------------------------------------------
// Batch build
// ---------------------------------------------------------------------------

/**
 * The canonical (#1167-deduplicated) session record most recently WRITTEN to
 * the ledger — ranked by `completed_at` (falling back to `started_at` when
 * absent), the closest analogue to "the last line of the file" once the reader
 * no longer trusts append order.
 *
 * `readCanonicalSessions` reorders its output to "first appearance of each
 * surviving id" (see sessions-canonical.mjs's own docstring) — it is NOT
 * append order — so a raw `records[records.length - 1]` (the pre-#1186 read)
 * silently picks the WRONG session once a `session_id` duplicate or a
 * `supersedes` collapse reshuffles the array. A record with neither timestamp
 * sorts last and is never chosen over a dated one.
 *
 * @param {Array<object>} records — canonical session records.
 * @returns {object|null}
 */
function mostRecentSession(records) {
  let best = null;
  let bestTs = '';
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    const ts =
      typeof rec.completed_at === 'string' && rec.completed_at
        ? rec.completed_at
        : typeof rec.started_at === 'string'
          ? rec.started_at
          : '';
    if (ts && ts > bestTs) {
      best = rec;
      bestTs = ts;
    }
  }
  return best;
}

/**
 * Read the session PROFILE (STATE.md frontmatter `session-profile`) for the repo
 * that owns `metricsDir`.
 *
 * The profile is a SECOND axis beside `session_type`: an ultradeep session is
 * `session_type: "deep"` PLUS `session_profile: "ultradeep"`. It deliberately
 * does NOT go through `normalizeSessionType`, which would flatten any unknown
 * value to `'other'` and destroy the only signal that distinguishes the 7-wave
 * form from an ordinary deep session.
 *
 * ABSENT IS NOT EMPTY. No STATE.md, no frontmatter, or no `session-profile` key
 * ⇒ `null` ⇒ the ping OMITS the field. A derived (ledger-less) ping therefore
 * carries no profile rather than an invented one.
 *
 * Never throws.
 *
 * @param {string} metricsDir — `<repoRoot>/.orchestrator/metrics`.
 * @returns {string|null}
 */
export function readSessionProfileForMetricsDir(metricsDir) {
  try {
    // metricsDir is `<repoRoot>/.orchestrator/metrics` by construction (every
    // caller builds it that way); two levels up is the repo root.
    const repoRoot = path.resolve(metricsDir, '..', '..');
    return readSessionProfile(fs.readFileSync(resolveStateMdPath(repoRoot), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Reconstruct the session facts a ping needs (`session_type`, `started_at`,
 * `completed_at`) from `<metricsDir>/events.jsonl` when `sessions.jsonl` has no
 * usable record.
 *
 * WHY THIS EXISTS: `buildBatch` keyed exclusively on `sessions.jsonl`, which is
 * written by `/close`. Measured 2026-09-06 (d8): the fleet's real close rate is
 * 21,3 % (429 clean closes / 2.016 distinct `session.started` ids over 90 days),
 * and THIS repo has no `sessions.jsonl` at all — so `sessionForPing` was `{}` and
 * every ping reported `session_type: "other"` / `duration_bucket: "<15m"` as if
 * measured. `events.jsonl` is written on every SessionStart, independent of
 * `/close`, so it is the source that survives a killed session.
 *
 * NEVER FABRICATES: when no `orchestrator.session.started` record carries a mode,
 * `session_type` is returned absent, and the caller emits `'unknown'`.
 *
 * Deliberate simplification (named ceiling): the LAST `session.started` record
 * wins and the LAST record of any kind supplies `completed_at`. That conflates a
 * session with the tail of a peer's events in a shared working copy. It is the
 * same precision the ledger path already offers (`mostRecentSession`), it costs
 * one linear pass, and the `session_record: 'derived'` marker tells the reader it
 * is a reconstruction. Revisit if events.jsonl ever carries interleaved sessions
 * that must be told apart — the `session_id` field is already there for it.
 *
 * Never throws.
 *
 * @param {string} metricsDir
 * @returns {{ session: object, source: 'derived'|'absent' }}
 */
export function deriveSessionFromEvents(metricsDir) {
  try {
    const events = readJsonlFile(path.join(metricsDir, 'events.jsonl'), { skipInvalid: true });
    if (!Array.isArray(events) || events.length === 0) return { session: {}, source: 'absent' };

    let startedAt = null;
    let sessionType = null;
    let lastTs = null;
    // `orchestrator.session.shape_resolved` (scripts/lib/session-shape.mjs) is
    // the plan-time measurement: it fires AFTER the operator picked a mode, and
    // it is the only event carrying `session_profile`. `session.started`'s mode
    // predates the choice, and the STATE.md profile read below evaporates the
    // moment STATE.md is rewritten — so when a shape record exists it wins for
    // BOTH fields. Latest wins; absent ⇒ the pre-existing behaviour, unchanged.
    //
    // "Latest" is decidable only for a record carrying a parseable timestamp. An
    // UNDATED record has no place in that order and must never displace a dated
    // one (the earlier `ts === null` disjunct inverted exactly that). It is kept
    // separately and used only when no dated shape record exists AND the
    // pre-existing sources below yielded nothing.
    let shapeType = null;
    let shapeProfile = null;
    let shapeTs = null;
    let undatedShapeType = null;
    let undatedShapeProfile = null;

    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      const ts = typeof ev.timestamp === 'string' && !Number.isNaN(Date.parse(ev.timestamp)) ? ev.timestamp : null;
      if (ts && (lastTs === null || ts > lastTs)) lastTs = ts;
      if (ev.event === 'orchestrator.session.shape_resolved') {
        const type = typeof ev.session_type === 'string' && ev.session_type.trim() !== '' ? ev.session_type.trim() : null;
        // OMITTED, never null, when the session has no profile — only a
        // present string may overwrite an earlier reading.
        const profile =
          typeof ev.session_profile === 'string' && ev.session_profile.trim() !== '' ? ev.session_profile.trim() : null;
        if (ts !== null) {
          if (shapeTs === null || ts >= shapeTs) {
            shapeTs = ts;
            if (type !== null) shapeType = type;
            if (profile !== null) shapeProfile = profile;
          }
        } else if (undatedShapeType === null && undatedShapeProfile === null) {
          undatedShapeType = type;
          undatedShapeProfile = profile;
        }
        continue;
      }
      if (ev.event !== 'orchestrator.session.started') continue;
      // `mode` is what session-start writes; `session_type` is the ledger's own
      // name for the same fact. Read both — neither is guaranteed present.
      const mode = typeof ev.session_type === 'string' ? ev.session_type : ev.mode;
      const started = typeof ev.started_at === 'string' ? ev.started_at : ts;
      if (started && (startedAt === null || started >= startedAt)) {
        startedAt = started;
        sessionType = typeof mode === 'string' && mode.trim() !== '' ? mode.trim() : null;
      }
    }

    if (shapeType !== null) sessionType = shapeType;
    // An undated shape record is the weakest reading there is: it wins over
    // nothing at all, and over nothing else. A dated shape record (shapeTs) or
    // a `session.started` mode both outrank it.
    // Type and profile are read as a PAIR from the same record, so the undated
    // fallback is taken as a pair too — never spliced onto a type another source
    // supplied.
    let profile = shapeProfile;
    if (shapeTs === null && sessionType === null) {
      sessionType = undatedShapeType;
      profile = undatedShapeProfile;
    }

    if (startedAt === null && sessionType === null && profile === null) return { session: {}, source: 'absent' };

    const session = {};
    if (sessionType !== null) session.session_type = sessionType;
    if (profile !== null) session.session_profile = profile;
    if (startedAt !== null) session.started_at = startedAt;
    // completed_at is the last life-sign, never the wall clock — the same
    // omit-never-fabricate contract session-close-backfill.mjs uses (#914 R1).
    if (lastTs !== null && startedAt !== null && lastTs >= startedAt) session.completed_at = lastTs;

    return { session, source: 'derived' };
  } catch {
    return { session: {}, source: 'absent' };
  }
}

/**
 * Build ONE whitelist-projected usage-ping record from the local JSONL streams.
 *
 * Reads `<metricsDir>/sessions.jsonl` (via `readCanonicalSessions`, #1186 — the
 * #1167 newest-wins-per-`session_id` / `supersedes` collapse) +
 * `<metricsDir>/skill-invocations.jsonl`. The most-recently-written CANONICAL
 * session record (`mostRecentSession`, above) defines the session window:
 * skill-invocations whose `timestamp >=` its `started_at` are included. When no
 * session record exists, the ping falls back to `session_type: 'other'`,
 * `duration_bucket: '<15m'`, and the invocations of the last 24 hours.
 *
 * anon-ID handling (persist=true, the send path): `ensureAnonId` runs on the
 * telemetry.json record; a created/rotated ID is persisted via
 * `writeTelemetryState`. With `persist=false` (the CLI `show` preview) NOTHING is
 * minted or written — an existing ID is echoed, otherwise a placeholder string is
 * shown. This preserves the lazy-ID invariant even for `show`.
 *
 * INVARIANT: `flush()` calls this ONLY after the consent gate has passed, so the
 * (persisting) anon-ID mint is never reachable under `send !== true`.
 *
 * Never throws — an internal failure returns `{ record: null, reason }`.
 *
 * @param {object} [opts]
 * @param {string} [opts.metricsDir]       Metrics dir (default `<cwd>/.orchestrator/metrics`).
 * @param {NodeJS.ProcessEnv} [opts.env]   Env source (default process.env).
 * @param {object} [opts.ownerConfig]      Parsed owner.yaml (default: loaded here).
 * @param {{skills: Set<string>, commands: Set<string>}} [opts.roster] Roster (default: loaded by schema).
 * @param {string} [opts.now]              ISO timestamp for sent_at + rotation clock.
 * @param {string} [opts.statePath]        telemetry.json path override (test injection).
 * @param {boolean} [opts.persist=true]    Mint+persist the anon-ID (false ⇒ preview only).
 * @returns {{ record: object|null, reason?: string }}
 */
export function buildBatch({
  metricsDir,
  env = process.env,
  ownerConfig,
  roster,
  now,
  statePath,
  persist = true,
  consentState,
} = {}) {
  try {
    const dir = metricsDir || path.join(process.cwd(), '.orchestrator', 'metrics');
    const nowIso = now || new Date().toISOString();

    const sessions = readCanonicalSessions({ filePath: path.join(dir, 'sessions.jsonl') });
    const invocations = readJsonlFile(path.join(dir, 'skill-invocations.jsonl'), { skipInvalid: true });

    const sessionRecord = mostRecentSession(sessions);

    let windowInvocations;
    let sessionForPing;
    /** @type {'ledger'|'derived'|'absent'} */
    let sessionRecordSource = 'ledger';
    if (sessionRecord && typeof sessionRecord.started_at === 'string' && !Number.isNaN(Date.parse(sessionRecord.started_at))) {
      const startMs = Date.parse(sessionRecord.started_at);
      windowInvocations = invocations.filter((rec) => {
        const t = Date.parse(rec?.timestamp);
        return !Number.isNaN(t) && t >= startMs;
      });
      sessionForPing = sessionRecord;
      sessionRecordSource = 'ledger';
    } else {
      // No usable LEDGER record → reconstruct from events.jsonl, which is
      // written on every SessionStart and therefore survives a killed session
      // (see deriveSessionFromEvents). Only when THAT also yields nothing does
      // the ping fall back to `session_type: 'unknown'` — never to a
      // measured-looking 'other'.
      const derived = deriveSessionFromEvents(dir);
      sessionForPing = derived.session;
      sessionRecordSource = derived.source;

      const derivedStartMs = Date.parse(sessionForPing.started_at);
      const cutoff = (Number.isNaN(Date.parse(nowIso)) ? Date.now() : Date.parse(nowIso)) - DAILY_FLUSH_MS;
      const windowStart = Number.isNaN(derivedStartMs) ? cutoff : derivedStartMs;
      windowInvocations = invocations.filter((rec) => {
        const t = Date.parse(rec?.timestamp);
        return !Number.isNaN(t) && t >= windowStart;
      });
    }

    const cfg = ownerConfig ?? loadOwnerConfig().config;

    const ping = buildUsagePing({
      sessionRecord: sessionForPing,
      skillInvocations: windowInvocations,
      ownerConfig: cfg,
      env,
      now: nowIso,
      roster,
      consentState,
      sessionRecordSource,
      sessionProfile: readSessionProfileForMetricsDir(dir),
    });

    const target = statePath || TELEMETRY_JSON_PATH;
    const { record: stateRecord } = readTelemetryState({ path: target });

    if (persist) {
      const { record: nextState, anon_id, created, rotated } = ensureAnonId(stateRecord, { now: nowIso });
      if (created || rotated) {
        writeTelemetryState(nextState, { path: target });
      }
      ping.anon_id = anon_id;
    } else {
      ping.anon_id =
        typeof stateRecord.anon_id === 'string' && stateRecord.anon_id.trim() !== ''
          ? stateRecord.anon_id
          : '(generated on first send)';
    }

    return { record: projectUsagePing(ping) };
  } catch (err) {
    return { record: null, reason: `build-error: ${err?.message ?? String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Transport-boundary normalisation (the queue is not a trusted producer)
// ---------------------------------------------------------------------------

/**
 * THE BUG THIS EXISTS FOR: a record written to the offline queue by an OLDER
 * client — one built before `session_profile` was whitelisted — carries whatever
 * `session-profile` that host's STATE.md held, e.g. a private repo name. `flush`
 * forwarded queued batches to the sender VERBATIM, so the builder-side whitelist
 * (`normalizeSessionProfile`, applied in `buildUsagePing`) was bypassed for every
 * record that had ever been queued. Two consequences, both live:
 *
 *   (a) PRIVACY — the private string reaches the wire on every later flush.
 *   (b) POISON QUEUE — the ingest server validates a batch ALL-OR-NOTHING, so
 *       the unknown profile 400s the whole batch; the new record is queued and
 *       the queue grows 1 → 2 → 3 … and never drains again.
 *
 * The fix is a boundary invariant, not a one-off patch: **a queued record can
 * never carry what a freshly built one cannot.** Every queued entry passes the
 * SAME two steps the builder applies — `projectUsagePing` field projection, then
 * the `normalizeSessionProfile` whitelist (unlisted ⇒ the key is DROPPED, per
 * that function's omit-don't-degrade contract).
 *
 * @param {unknown} batch A record as read back from the offline queue.
 * @returns {object} The projected + normalised record safe to hand to the sender.
 */
export function sanitizeQueuedRecord(batch) {
  const record = projectUsagePing(batch);
  if ('session_profile' in record) {
    const profile = normalizeSessionProfile(record.session_profile);
    if (profile === null) delete record.session_profile;
    else record.session_profile = profile;
  }
  return record;
}

/**
 * Does this send failure mean "the server refused this PAYLOAD" (evict) rather
 * than "the send did not get through" (re-queue)?
 *
 * `defaultSender` attaches `err.status`; an injected sender that throws a bare
 * Error carries no status and therefore always routes to the re-queue branch —
 * the pre-existing behaviour, unchanged.
 *
 * Only 400 (schema) and 422 (semantic) count. 408/429 and every 5xx are
 * transport-class and MUST re-queue: a rate-limited batch is not a bad batch.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isSchemaRejection(err) {
  const status = Number(err?.status);
  return status === 400 || status === 422;
}

// ---------------------------------------------------------------------------
// Flush
// ---------------------------------------------------------------------------

/**
 * Attempt to flush telemetry: gate on consent, build the batch, drain the
 * offline queue together with the new record in ONE send, and empty the queue on
 * success. Never throws, never blocks beyond `timeoutMs`.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]   Env source (default process.env).
 * @param {number} [opts.timeoutMs]        POST timeout (default POST_TIMEOUT_MS).
 * @param {(batches: object[]) => Promise<void>} [opts.sender] Injected sender (default: network POST).
 * @param {string} [opts.metricsDir]       Metrics dir override.
 * @param {string} [opts.statePath]        telemetry.json path override.
 * @param {string} [opts.queuePath]        queue path override.
 * @param {string} [opts.now]              ISO timestamp (sent_at, last_flush_at, rotation clock).
 * @param {object} [opts.ownerConfig]      Parsed owner.yaml (default: loaded here). Inject to
 *                                         isolate a test from the host's real owner.yaml fleet flag.
 * `reason` values: `gated` (consent), `sandbox:*` (the sandbox guard refused —
 * no network, no queue mutation, no anon-ID mint), `debug`, `queued`, `sent`,
 * `rejected-evicted` (the server refused the payload with 400/422 — the batch is
 * dropped instead of re-queued forever), `no-record`, `build-error: …`.
 *
 * @returns {Promise<{ sent: boolean, queued: boolean, state: string, reason: string }>}
 */
export async function flush({
  env = process.env,
  timeoutMs = POST_TIMEOUT_MS,
  sender,
  metricsDir,
  statePath,
  queuePath,
  now,
  ownerConfig,
} = {}) {
  // Resolve owner.yaml once (injectable for hermetic tests). loadOwnerConfig reads the host's
  // real owner.yaml — a test asserting "consent absent" MUST inject {} or a real fleet flag
  // (telemetry.enabled: true) legitimately flips send=true.
  const cfg = ownerConfig ?? loadOwnerConfig().config;

  // OUTERMOST SEAM — the consent gate is the FIRST statement. When send !== true
  // nothing below (no fetch, no queue write, no anon-ID mint) is reachable.
  const consent = resolveConsent({
    env,
    ownerConfig: cfg,
    state: readTelemetryState({ path: statePath }).record,
    interactive: false,
  });
  if (consent.send !== true) {
    return { sent: false, queued: false, state: consent.state, reason: 'gated' };
  }

  // SANDBOX GUARD — runs strictly between the consent gate and buildBatch, so a
  // refused send performs no network call, no queue write and no anon-ID mint.
  // See detectSandbox for the six production pings this exists to prevent.
  const sandbox = detectSandbox({ env, statePath });
  if (sandbox.sandbox) {
    return { sent: false, queued: false, state: consent.state, reason: sandbox.reason };
  }

  const nowIso = now || new Date().toISOString();

  // Build the batch (this lazily mints + persists the anon-ID — only reachable
  // here, i.e. strictly after the gate).
  const { record, reason } = buildBatch({
    metricsDir,
    env,
    ownerConfig: cfg,
    statePath,
    now: nowIso,
    // The RESOLVED consent state is what `fleet` is derived from now — not a raw
    // owner.yaml read. See buildUsagePing's fleet block (d8 root cause a).
    consentState: consent.state,
  });
  if (!record) {
    return { sent: false, queued: false, state: consent.state, reason: reason || 'no-record' };
  }

  // Debug seam: print the exact payload, send nothing.
  if (env?.SO_TELEMETRY_DEBUG === '1') {
    process.stderr.write(`${JSON.stringify(record)}\n`);
    return { sent: false, queued: false, state: consent.state, reason: 'debug' };
  }

  // Drain the existing queue together with the new record in ONE send. Every
  // queued record is re-normalised at this boundary — see sanitizeQueuedRecord
  // for the privacy + poison-queue defect that made this necessary.
  const queuedBatches = peekAll({ path: queuePath }).map((entry) => sanitizeQueuedRecord(entry.batch));
  const batches = [...queuedBatches, record];

  const send = typeof sender === 'function' ? sender : defaultSender({ env, timeoutMs });

  try {
    await send(batches);
  } catch (err) {
    if (isSchemaRejection(err)) {
      // The server refused the PAYLOAD. Re-queueing would replay the identical
      // batch forever, which is the poison-queue class itself. Drop it.
      //
      // Named ceiling (BV-004): the ingest API validates a batch all-or-nothing
      // and returns no per-record index, so the rejected record cannot be
      // identified — the only bounded choice is to evict the WHOLE batch (the
      // queued records AND the new one). Revisit if the server ever reports
      // which entries failed; then evict only those.
      clear({ path: queuePath });
      return { sent: false, queued: false, state: consent.state, reason: 'rejected-evicted' };
    }
    // Transport failure → only the NEW record joins the queue (queued batches
    // remain in place since the queue was not cleared).
    enqueue(record, { path: queuePath, now: nowIso });
    return { sent: false, queued: true, state: consent.state, reason: 'queued' };
  }

  // 2xx → empty the queue and stamp last_flush_at (preserving the anon-ID that
  // buildBatch may have just persisted).
  clear({ path: queuePath });
  const { record: freshState } = readTelemetryState({ path: statePath });
  writeTelemetryState({ ...freshState, last_flush_at: nowIso }, { path: statePath });

  return { sent: true, queued: false, state: consent.state, reason: 'sent' };
}

// ---------------------------------------------------------------------------
// Daily-fallback predicate
// ---------------------------------------------------------------------------

/**
 * Whether a daily-fallback flush is due. Two independent ways to be due, both
 * requiring that more than 24h have passed since the last successful flush
 * (never-flushed counts as infinitely stale):
 *
 *   (a) RETRY — the offline queue is non-empty: earlier sends failed and the
 *       backlog deserves another attempt.
 *   (b) CATCH-UP — the queue is empty, but `<metricsDir>/sessions.jsonl` ends on
 *       a record whose `completed_at` is NEWER than `last_flush_at`: a session
 *       closed since the last successful send and produced no ping.
 *
 * (b) is the reason this predicate exists at all. While it was queue-only, the
 * "daily fallback" could ONLY re-send what had already failed to send — it could
 * never originate a ping. Measured 2026-08-23 (#1138): 588 session closes across
 * 13 repos produced 82 ingest records (~14%), because the ONE writer of the
 * queue is a failed `flush()`, and a `flush()` that never runs never fails.
 *
 * Cheap in the common case: the staleness gate is checked FIRST (one small
 * telemetry.json read), so a host that flushed within the last 24h returns
 * before touching either the queue or the session ledger.
 *
 * Never throws.
 *
 * @param {object} [opts]
 * @param {string} [opts.statePath]  telemetry.json path override.
 * @param {string} [opts.queuePath]  queue path override.
 * @param {string} [opts.metricsDir] Metrics dir for the (b) catch-up probe
 *                                   (default `<cwd>/.orchestrator/metrics`).
 * @param {number} [opts.now]        Reference time in epoch-ms (default Date.now()).
 * @returns {boolean}
 */
export function shouldDailyFlush({ statePath, queuePath, metricsDir, now = Date.now() } = {}) {
  try {
    // Staleness gate — shared by BOTH disjuncts, so it runs first and short-
    // circuits the two file probes below on every fresh host.
    const { record } = readTelemetryState({ path: statePath });
    const raw = record?.last_flush_at;
    const lastMs = typeof raw === 'string' && !Number.isNaN(Date.parse(raw)) ? Date.parse(raw) : 0;
    if (now - lastMs <= DAILY_FLUSH_MS) return false;

    // (a) Retry an existing backlog.
    const { count } = queueStats({ path: queuePath });
    if (count > 0) return true;

    // (b) Catch-up: a session completed after the last successful flush.
    //     Reuses buildBatch's reader (#1186: readCanonicalSessions +
    //     mostRecentSession) — same file, same #1167 dedupe, no second parser.
    //
    //     Deliberate simplification (named ceiling): this parses the WHOLE
    //     sessions.jsonl to look at its last record. At the observed ledger size
    //     (271 records / 292 KB in this repo, 2026-08-23) that is sub-millisecond
    //     and it only runs once the 24h gate above has already passed. Revisit
    //     with a tail-read if any repo's sessions.jsonl passes ~10 MB.
    const dir = metricsDir || path.join(process.cwd(), '.orchestrator', 'metrics');
    const sessions = readCanonicalSessions({ filePath: path.join(dir, 'sessions.jsonl') });
    const last = mostRecentSession(sessions);
    const completedMs = Date.parse(last?.completed_at);
    return !Number.isNaN(completedMs) && completedMs > lastMs;
  } catch {
    return false;
  }
}
