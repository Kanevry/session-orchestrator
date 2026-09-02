#!/usr/bin/env node
/**
 * on-stop.mjs — consolidated Stop + SubagentStop hook.
 *
 * Replaces hooks/on-stop.sh and hooks/on-subagent-stop.sh. Handles both Claude Code
 * hook events in a single file, discriminating by the `hook_event_name` field first,
 * then falling back to presence of `agent_type` (SubagentStop) vs absence (Stop).
 *
 * Part of v3.0.0 Windows-native migration. Issue #141.
 *
 * Exit codes: 0 always (informational hooks must never block) — including when
 * node_modules is absent: zx is imported lazily and a missing package degrades
 * to one rate-limited stderr line instead of an ERR_MODULE_NOT_FOUND stack on
 * every turn end (GH Kanevry/session-orchestrator#63).
 *
 * JSONL format (`.orchestrator/metrics/events.jsonl`) — emitted via the canonical
 * `emitEvent()` so the JSONL record and the optional Clank webhook always carry the
 * SAME dotted event name (was: bare `stop`/`subagent_stop` in JSONL vs dotted in webhook):
 *   Stop:        {"timestamp":<ISO>,"event":"orchestrator.session.stopped","session_id":"...","semantic_session_id":"...","wave":<int>,"branch":"...","commit":"...","duration_ms":<int>,"duration_source":"session-lock"}
 *                (`session_id` / `semantic_session_id` are omitted when unresolvable — #1068 AC1.
 *                 `duration_ms` + `duration_source` are omitted TOGETHER when no OWNED
 *                 session.lock is readable — never a fabricated 0, see K5 below.)
 *   SubagentStop: {"timestamp":<ISO>,"event":"orchestrator.agent.stopped","agent":"<name>","agent_id":"...",
 *                  "agent_type_meta":"...","tool_use_id":"...","transcript_found":true,
 *                  "duration_ms":<int>,"duration_source":"meta-birthtime","status":"done"}
 *                (#1190 — every key after `event` is OPTIONAL and OMITTED when the
 *                 measurement could not be made; `agent` too. See docs/events-schema.md.)
 */

import path from 'node:path';
import {
  promises as fs,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';

import { shouldRunHook } from './_lib/profile-gate.mjs';
// #211: exit 0 immediately (silent allow) when this hook is disabled via profile/env
if (!shouldRunHook('on-stop')) process.exit(0);

import { emitEvent } from '../scripts/lib/events.mjs';
import { SO_PROJECT_DIR } from '../scripts/lib/platform.mjs';
import { parseSessionId } from '../scripts/lib/session-id.mjs';
import { heartbeat, logSweepEvent } from '../scripts/lib/session-registry.mjs';
import { readLock, updateHeartbeat } from '../scripts/lib/session-lock.mjs';

// ---------------------------------------------------------------------------
// stdin reading (inline — no io.mjs because Stop hooks exit 0 always, never deny)
// ---------------------------------------------------------------------------

/**
 * Read stdin to EOF and parse as JSON. Returns null on empty or parse failure.
 * @returns {Promise<object|null>}
 */
async function readStdinJson() {
  return new Promise((resolve) => {
    const chunks = [];
    const timer = setTimeout(() => {
      process.stdin.destroy();
      resolve(null);
    }, 8000); // generous guard; contract says 5s (Stop) / 3s (SubagentStop)

    if (process.stdin.readableEnded) {
      clearTimeout(timer);
      resolve(null);
      return;
    }

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      const raw = chunks.join('').trim();
      if (!raw) { resolve(null); return; }
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(null); });
    process.stdin.resume();
  });
}

// ---------------------------------------------------------------------------
// discriminate hook event type
// ---------------------------------------------------------------------------

/**
 * Determine whether the parsed stdin represents a Stop or SubagentStop event.
 * Precedence: hook_event_name field → presence of agent_type field → default Stop.
 * @param {object|null} input
 * @returns {"stop"|"subagent_stop"}
 */
function discriminate(input) {
  if (!input) return 'stop';
  const name = input.hook_event_name;
  if (typeof name === 'string') {
    if (name === 'SubagentStop') return 'subagent_stop';
    return 'stop';
  }
  // Fallback: SubagentStop always provides agent_type; Stop does not.
  if (typeof input.agent_type === 'string') return 'subagent_stop';
  return 'stop';
}

// ---------------------------------------------------------------------------
// dependency degradation (GH Kanevry/session-orchestrator#63)
// ---------------------------------------------------------------------------
//
// zx is loaded LAZILY. A static `import { $ } from 'zx'` fails at MODULE LOAD
// time when node_modules is absent (interrupted install, EPERM sandbox, half-
// synced plugin cache), so the harness prints a 10-frame ERR_MODULE_NOT_FOUND
// stack on EVERY turn end with no hint that `npm install` is the fix. This
// mirrors the missing-`node` degradation in hooks/run-node.sh (§5): one
// actionable stderr line per 6h window, then carry on with reduced features.

/** Rate-limit window for the dependencies-missing warning — mirrors run-node.sh's 6h TTL. */
const DEP_WARN_TTL_MS = 6 * 60 * 60 * 1000;

/** Plugin root (the directory that owns package.json / node_modules). */
const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Marker path for the dependencies-missing warning. Deliberately a DIFFERENT
 * name from run-node.sh's `session-orchestrator-node-missing-*`: sharing one
 * marker would let a missing-node warning mask a missing-deps warning (and
 * vice versa), leaving the operator with half a diagnostic.
 * @returns {string}
 */
function depWarnMarkerPath() {
  // `||` alone falls back only on falsy values — a whitespace-only TMPDIR is
  // truthy and would yield a garbage path (see .claude/rules/development.md).
  const tmpDir = (process.env.TMPDIR || '').trim() || '/tmp';
  const user = (process.env.USER || '').trim() || 'uid';
  return path.join(tmpDir, `session-orchestrator-deps-missing-${user}`);
}

/**
 * Print ONE actionable stderr line telling the operator to run `npm install`,
 * at most once per DEP_WARN_TTL_MS. Marker mtime is the clock, exactly like
 * run-node.sh's `find -mmin +360` check. Best-effort throughout: a marker we
 * cannot stat is treated as expired (warn), a marker we cannot write means the
 * next invocation warns again — noisier, never silent-broken.
 */
function warnDependenciesMissingOnce() {
  const marker = depWarnMarkerPath();
  try {
    if (Date.now() - statSync(marker).mtimeMs < DEP_WARN_TTL_MS) return;
  } catch { /* missing / unreadable marker → treat as expired */ }
  try { writeFileSync(marker, ''); } catch { /* best-effort */ }
  process.stderr.write(
    `session-orchestrator: dependencies missing — run 'npm install' in ${PLUGIN_ROOT}. `
    + 'Hook features degraded (this warning is rate-limited to once per 6h).\n',
  );
}

/**
 * Load zx's `$` lazily. Returns null when the package is not installed (after
 * emitting the rate-limited advisory). Any OTHER import failure is re-thrown —
 * a corrupt zx install is not a missing-dependency problem and must not be
 * mislabelled as one.
 * @returns {Promise<Function|null>}
 */
async function loadZx() {
  try {
    return (await import('zx')).$;
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    warnDependenciesMissingOnce();
    return null;
  }
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

/**
 * Returns { commit, branch } from the git repo at projectRoot, or null values
 * if git is unavailable, zx is not installed, or the directory is not a git repo.
 * @param {string} projectRoot — working directory for git commands
 * @returns {Promise<{commit:string|null, branch:string|null}>}
 */
async function gitInfo(projectRoot) {
  const $ = await loadZx();
  if ($ === null) return { commit: null, branch: null };
  $.verbose = false;
  $.quiet = true;
  const opts = projectRoot ? { cwd: projectRoot } : {};
  try {
    const commitResult = await $({ ...opts })`git rev-parse HEAD`;
    const branchResult = await $({ ...opts })`git rev-parse --abbrev-ref HEAD`;
    return {
      commit: commitResult.stdout.trim() || null,
      branch: branchResult.stdout.trim() || null,
    };
  } catch {
    return { commit: null, branch: null };
  }
}

// ---------------------------------------------------------------------------
// wave-scope.json helpers
// ---------------------------------------------------------------------------

/**
 * Try to read the wave number from .claude/wave-scope.json (or .codex / .cursor / .pi).
 * Returns 0 if no scope file is found or the file cannot be parsed.
 * @param {string} projectRoot
 * @returns {Promise<number>}
 */
async function readWaveNumber(projectRoot) {
  const dirs = ['.pi', '.claude', '.codex', '.cursor'];
  for (const dir of dirs) {
    const scopePath = path.join(projectRoot, dir, 'wave-scope.json');
    try {
      const raw = await fs.readFile(scopePath, 'utf8');
      const obj = JSON.parse(raw);
      const wave = typeof obj.wave === 'number' ? obj.wave : 0;
      return wave;
    } catch {
      // file missing or unparseable — try next
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// event handlers
// ---------------------------------------------------------------------------

/**
 * Resolve this session's id + its attested semantic id. A stdin payload id wins
 * ONLY when it parses as a UUID. If Claude Code did not pass one (Codex /
 * Cursor paths, or older harnesses) — or passed something that is not a UUID —
 * fall back to `.orchestrator/current-session.json` which on-session-start.mjs
 * writes.
 *
 * #1091 / Kanevry#66 — WRITER/READER SYMMETRY, same defect class as
 * `hooks/on-session-end.mjs`: `on-session-start.mjs` accepts a stdin raw id
 * only when `parseSessionId(fromStdin)?.format === 'uuid'` and otherwise mints
 * a `randomUUID()`, so every artifact this hook then addresses by id (the host
 * registry entry, `session.lock`) is keyed by a UUID. Passing a non-UUID stdin
 * string through meant `heartbeat()` and `updateHeartbeat()` addressed a key
 * that was never written: the registry entry silently went un-refreshed (and
 * aged into the zombie sweep) while the lock heartbeat no-oped on an ownership
 * mismatch.
 *
 * `semanticSessionId` (#1068 AC1) is read from the SAME file and is deliberately
 * gated on the resolved id BEING the recorded one — `current-session.json` is a
 * single repo-global file describing whichever session most recently ran
 * SessionStart, so an unrelated window's turn-end must not inherit a live
 * peer's semantic identity (the #863 defect (c) contamination shape, mirrored
 * here from `hooks/on-session-end.mjs`).
 *
 * @param {object|null} input
 * @param {string} projectRoot
 * @returns {Promise<{sessionId: string|null, semanticSessionId: string|null}>}
 */
async function resolveSessionId(input, projectRoot) {
  const fromStdin = input?.session_id ?? input?.sessionId ?? null;
  const rawStdinId = parseSessionId(fromStdin)?.format === 'uuid' ? fromStdin : null;
  let sessionId = rawStdinId;

  let recordedId = null;
  let semanticSessionId = null;
  try {
    const raw = await fs.readFile(
      path.join(projectRoot, '.orchestrator', 'current-session.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw);
    if (typeof parsed.session_id === 'string' && parsed.session_id.length > 0) {
      recordedId = parsed.session_id;
    }
    if (typeof parsed.semantic_session_id === 'string' && parsed.semantic_session_id.length > 0) {
      semanticSessionId = parsed.semantic_session_id;
    }
  } catch { /* missing or unparseable is fine */ }

  // Actor-identity fallback ONLY — `sessionId` drives the registry heartbeat and
  // the lock heartbeat, both of which need an id even when stdin carried none.
  if (sessionId === null) sessionId = recordedId;

  // W4a review F-A, second site of the same defect (census: exactly 2, both in
  // hooks/, `grep -rn "= recordedId;" hooks/ scripts/` 2026-09-02). Comparing
  // the RESOLVED id against `recordedId` is self-fulfilling: the line above may
  // have just copied one into the other, so an id-less or non-UUID turn-end
  // always read as "I am the recorded session" and inherited a live PEER's
  // semantic identity — the exact #863 defect (c) contamination this gate
  // exists to refuse. Decided on the RAW stdin UUID instead.
  const isRecordedSession = rawStdinId !== null && rawStdinId === recordedId;
  return {
    sessionId,
    semanticSessionId: isRecordedSession ? semanticSessionId : null,
  };
}

/**
 * Resolve an elapsed span for this Stop event — and WHICH span depends on the
 * source, which is why `duration_source` ships beside the number (W4a F-C).
 *
 *   `session-lock`   — SESSION-elapsed, measured at this turn's end. Stop fires
 *                      once per TURN, and `started_at` is stamped once per
 *                      SESSION, so this number GROWS MONOTONICALLY across the
 *                      turns of one session: the last Stop of a 3-hour session
 *                      reports ~3 hours, not the length of its final turn.
 *   `stdin-start-ms` — TURN-elapsed, the only first-party measurement of the
 *                      turn itself. Measured today: the harness never sends it,
 *                      so this source has never appeared in the fleet stream.
 *
 * Consumers must therefore not aggregate the two: summing `session-lock` spans
 * over a session double-counts, where summing `stdin-start-ms` spans would not.
 *
 * OWNERSHIP-GATED, on the raw stdin `session_id` only. A lock in this working
 * copy may name a PEER session (two windows share one checkout routinely), and
 * a working-copy artefact is not a process-local identity witness — so the
 * lock's `session_id` must match the id the STOPPING session was handed on
 * stdin. `resolveSessionId()`'s resolved id is deliberately NOT used here: it
 * falls back to `current-session.json`, which is exactly the foreign-identity
 * inheritance this guard exists to refuse.
 *
 * Returns an object to SPREAD into the payload: `{}` when nothing is
 * attestable, so `duration_ms` and `duration_source` are omitted together
 * rather than written as a fabricated 0 (K5).
 *
 * `start_ms` is honoured first when the harness ever starts sending it — it is
 * the only first-party measurement of the turn itself; measured today it is
 * never present.
 *
 * @param {object|null} input parsed stdin payload
 * @param {string} projectRoot
 * @returns {{duration_ms?: number, duration_source?: string}}
 */
function resolveStopDuration(input, projectRoot) {
  if (typeof input?.start_ms === 'number' && Number.isFinite(input.start_ms)) {
    const ms = Date.now() - input.start_ms;
    if (Number.isFinite(ms) && ms >= 0) {
      return { duration_ms: Math.round(ms), duration_source: 'stdin-start-ms' };
    }
  }

  const stdinId = input?.session_id ?? input?.sessionId ?? null;
  if (typeof stdinId !== 'string' || stdinId.length === 0) return {};

  try {
    const lock = readLock({ repoRoot: projectRoot });
    if (lock === null || lock.session_id !== stdinId) return {};
    const startedAt = Date.parse(lock.started_at);
    if (Number.isNaN(startedAt)) return {};
    const ms = Date.now() - startedAt;
    if (!Number.isFinite(ms) || ms < 0) return {};
    return { duration_ms: Math.round(ms), duration_source: 'session-lock' };
  } catch {
    return {}; // best-effort — an unreadable lock measures nothing
  }
}

/**
 * Handle a Stop event. Reads wave from scope file + git info, appends JSONL.
 * @param {object|null} input
 */
async function handleStop(input) {
  const projectRoot = SO_PROJECT_DIR;

  const wave = await readWaveNumber(projectRoot);
  const { commit, branch } = await gitInfo(projectRoot);

  const { sessionId, semanticSessionId } = await resolveSessionId(input, projectRoot);

  // v3.1.0 multi-session registry (#169), corrected in #1047 — REFRESH the
  // registry entry here; never remove it.
  //
  // Stop fires at TURN end, not session end (see the file docblock). The
  // original #169 wiring called deregisterSelf() here, so every assistant turn
  // deleted this session's registry entry while the session was still live:
  // measured on this host as 1 surviving entry (dead PID) against 12 live
  // sockets, with sweep.log recording deletions of sessions aged 72/335/351/369
  // minutes. Epic #583 fixed exactly this class for `.orchestrator/session.lock`
  // (release → updateHeartbeat, below); the host registry never got the same
  // correction. Deregistration now lives in hooks/on-session-end.mjs, which
  // fires at the real end of the session.
  //
  // CODEX CAVEAT — stated here because THIS file runs on Codex and the file
  // that owns deregistration does not. `hooks-codex.json` wires SessionStart +
  // Stop but no SessionEnd (the Codex contract rejects the event), so on that
  // bridge a session registers and never deregisters: its entry persists until
  // sweepZombies() reaps it at the next SessionStart, up to `thresholdMin`
  // (default 60 min). Accepted deliberately — it is the same path crash and
  // Ctrl-C already take on every platform, and it is safe precisely BECAUSE
  // the heartbeat below now advances, so a live session never ages into the
  // sweep. Do NOT add a platform-detecting deregister branch here; that is the
  // two-teardown-paths shape Epic #583 removed from the lock.
  // (pi is unaffected: hooks-pi.json maps session_shutdown to on-session-end.mjs.
  //  Cursor is unaffected: it wires no SessionStart, so it never registers.)
  //
  // Failures are logged to sweep.log for observability but never re-thrown
  // (hook must remain silent and non-blocking).
  if (sessionId) {
    try {
      // heartbeat() returns null when no entry exists — a SILENT no-op that
      // would otherwise make the loss permanent for the rest of the session
      // (e.g. after a zombie sweep, or a harness UUID rotation with no fresh
      // SessionStart). We do NOT re-register here: this hook has no access to
      // the entry's platform / mode / host_class, and a re-registration would
      // reset started_at to now — fabricating a session age instead of
      // reporting one. Emit an observability breadcrumb instead, so the miss
      // is visible in sweep.log rather than invisible. One line per turn while
      // the entry is absent; that volume IS the signal, and the next
      // SessionStart's registerSelf() ends it.
      const refreshed = await heartbeat(sessionId);
      if (refreshed === null) {
        logSweepEvent({
          event: 'heartbeat-missing',
          session_id: sessionId,
          error: 'no registry entry to refresh at turn end',
        });
      }
    } catch (err) {
      // Refresh failed at the fs layer — emit an observability breadcrumb to
      // sweep.log. Do NOT throw, do NOT write to stderr: the hook is
      // informational-only.
      logSweepEvent({ event: 'heartbeat-failed', session_id: sessionId, error: err?.message ?? String(err) });
    }

    // Epic #583 W5-F1c — refresh session.lock heartbeat on every turn-end.
    // Augments PostToolBatch's heartbeat (closes W4-Q3 H2 cadence finding:
    // a session with no PostToolBatch activity would otherwise go heartbeat-stale).
    // Best-effort: never throws, never blocks the Stop hook.
    try {
      updateHeartbeat({ sessionId, repoRoot: projectRoot });
    } catch { /* best-effort */ }
  }

  // K5 — `duration_ms` was literally 0 in 8.127 of 8.127 fleet
  // `orchestrator.session.stopped` records (measured 2026-09-02): the old
  // expression fell back to a hard 0 because the harness never sends
  // `start_ms`. A fabricated 0 is the exact failure class
  // `scripts/lib/telemetry/subagents-schema.mjs:20-35` documents — it reads as
  // a MEASURED zero-length session and is indistinguishable from one. So the
  // span now comes from the session.lock's `started_at`, and BOTH keys are
  // omitted when it cannot be measured.
  const duration = resolveStopDuration(input, projectRoot);

  // Single emission path: emitEvent writes the canonical {timestamp, event, ...payload}
  // JSONL record AND fires the optional Clank webhook with the SAME event name — no
  // more bare-`stop` (JSONL) vs dotted-`stopped` (webhook) divergence.
  // #1068 AC1 — carry the attested semantic id alongside the raw UUID so a
  // turn-end outcome is joinable by identity from events.jsonl alone. Omitted
  // (never `""`/`null`) when unattested: an unresolved identity stays visibly
  // unresolved rather than becoming a guessed id.
  await emitEvent('orchestrator.session.stopped', {
    ...(sessionId !== null ? { session_id: sessionId } : {}),
    ...(semanticSessionId !== null ? { semantic_session_id: semanticSessionId } : {}),
    wave,
    ...(branch !== null ? { branch } : {}),
    ...(commit !== null ? { commit } : {}),
    ...duration,
  });
}

/**
 * Handle a SubagentStop event. Extracts agent name, emits orchestrator.agent.stopped.
 * Returns an optional additionalContext string (v2.1.163+) to feed back to the
 * coordinator turn. Currently always returns null (no inline warning from this
 * handler) — the slot is reserved for future SubagentStop feedback.
 * @param {object|null} input
 * @returns {Promise<string|null>} additionalContext or null
 */
async function handleSubagentStop(input) {
  /** @type {Record<string, unknown>} */
  const payload = {};

  // `agent` — the #1190 headline fix. The harness sends the EMPTY STRING, which
  // `?? 'unknown'` never caught: 89.991 of 103.763 fleet records (86,7%,
  // measured 2026-09-02) carry `agent: ""`. Trim, and emit the key ONLY when a
  // real value remains — an unmeasured type stays visibly unmeasured rather
  // than becoming `""` or a guessed `'unknown'`.
  //
  // Clamped with the SAME regex as `agent_type_meta` below (Q1-LOW-F3): this is
  // the identical value class from a different source, it lands in the ledger
  // and travels the optional Clank webhook, and it was the only unclamped
  // string in this payload. A mismatch OMITS the key — never a truncation,
  // which would look like a measured (but wrong) agent type.
  const rawAgent = firstNonEmptyString(input, ['agent_type', 'subagent_type']);
  const agent = rawAgent !== null && AGENT_TYPE_META_RE.test(rawAgent) ? rawAgent : null;
  if (agent !== null) payload.agent = agent;

  // `agent_id` — reader shape copied from hooks/subagent-telemetry.mjs (both
  // naming conventions the harness may use). Charset-guarded before it is ever
  // interpolated into a path (same precedent, resolveSubagentTranscriptPath)
  // AND before it is emitted: an unbounded, unvalidated id (`../../etc/passwd`,
  // or a 10 KB blob) would otherwise land verbatim in the ledger and travel
  // over the optional Clank webhook unredacted. A rejected id is OMITTED — the
  // same omission contract every other field in this payload uses — never
  // sanitised into a different id that looks measured.
  const rawAgentId = firstNonEmptyString(input, ['agent_id', 'subagent_id']);
  const agentId = rawAgentId !== null && AGENT_ID_RE.test(rawAgentId) ? rawAgentId : null;
  if (agentId !== null) payload.agent_id = agentId;

  // Sidecar-derived fields. Every derivation is individually wrapped: a failure
  // omits its own field and nothing else, and this function must never throw —
  // a throw here would skip the emit and lose the record that already works.
  const sidecarBase = resolveSidecarBase(input?.transcript_path, agentId);
  if (sidecarBase !== null) {
    const transcriptPath = `${sidecarBase}.jsonl`;
    const metaPath = `${sidecarBase}.meta.json`;

    let transcriptFound = false;
    try {
      transcriptFound = existsSync(transcriptPath);
      payload.transcript_found = transcriptFound;
    } catch { /* probe failed — omit rather than assert `false` */ }

    try {
      // One small read, one parse, two fields. `description` is operator prose
      // and is deliberately NOT carried: this payload also travels over the
      // optional Clank webhook unredacted.
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      // Both fields are CHARSET+LENGTH CLAMPED before they enter the payload,
      // for the same reason `agent_id` above is: this record is appended to the
      // ledger AND travels over the optional Clank webhook UNREDACTED, and
      // meta.json is written by the harness, not by us. An oversized or
      // structured value would land verbatim in both. A rejected value is
      // OMITTED, never truncated into a shorter value that still looks measured.
      if (typeof meta?.toolUseId === 'string' && TOOL_USE_ID_RE.test(meta.toolUseId.trim())) {
        payload.tool_use_id = meta.toolUseId.trim();
      }
      // A SECOND witness for the type — never merged into `agent`, so the
      // empty-`agent_type` rate stays measurable.
      if (typeof meta?.agentType === 'string' && AGENT_TYPE_META_RE.test(meta.agentType.trim())) {
        payload.agent_type_meta = meta.agentType.trim();
      }
    } catch { /* absent or corrupt sidecar meta — omit both fields */ }

    try {
      // meta.json carries no spawn timestamp; the harness writes the file AT
      // spawn, so its birthtime IS the spawn moment. `duration_source` puts
      // that provenance in the record instead of implying a measured span.
      const span = spanFromBirthtime(Date.now(), statSync(metaPath).birthtimeMs);
      if (span !== null) {
        payload.duration_ms = span;
        payload.duration_source = 'meta-birthtime';
      }
    } catch { /* stat failed — omit both keys (never a fabricated 0) */ }

    if (transcriptFound) {
      const status = readStatusFromTranscriptTail(transcriptPath);
      if (status !== null) payload.status = status;
    }
  }

  await emitEvent('orchestrator.agent.stopped', payload);
  return null;
}

// ---------------------------------------------------------------------------
// SubagentStop payload derivations (#1190)
// ---------------------------------------------------------------------------

/** Real agent ids are hex-ish tokens; anything else is rejected, not sanitised. */
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Harness tool-use ids, measured on-disk 2026-09-02 in a real sidecar meta.json:
 * `toolu_01Xj6qZ3ApsVfomhByNftmxj` (25 chars, alphanumeric + one underscore).
 */
const TOOL_USE_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Agent types carry a plugin qualifier, so the COLON is part of the real shape —
 * measured in the same file: `session-orchestrator:code-implementer` (37 chars).
 * A `tool_use_id`-identical charset would have rejected every plugin-qualified
 * agent type in this repo, i.e. silently removed the field it clamps.
 */
const AGENT_TYPE_META_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Upper bound on a `meta-birthtime` span, in ms. NAMED CEILING (BV-004): 7 days.
 *
 * No subagent runs for a week — the longest recorded here is minutes — so a
 * span above this is not a long agent, it is a birthtime the filesystem did not
 * supply. Node documents `birthtimeMs` as unavailable on filesystems that do
 * not record it (overlayfs and some CI images among them), where it surfaces as
 * 0 / 1970-01-01; the old `>= 0` lower bound accepted that verbatim and would
 * ship a ~55-YEAR span stamped `duration_source: 'meta-birthtime'` — a
 * fabricated measurement of exactly the class K5 removed.
 *
 * REVISIT TRIGGER: if a legitimately long-running agent class ever appears
 * (a background agent measured in hours-to-days), raise this — but raise it to
 * a measured bound, never remove it.
 */
const META_BIRTHTIME_MAX_SPAN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Span between a birthtime and now, or `null` when the birthtime is not a
 * usable measurement.
 *
 * Rejects a non-positive `birthtimeMs` (the "filesystem records no birthtime"
 * signal) and any span outside `(0, META_BIRTHTIME_MAX_SPAN_MS)`. `null` means
 * "omit both keys" at the call site — never a fabricated number.
 *
 * Pure, and separate from the call site so the two out-of-band cases are
 * testable without a filesystem that can forge a birthtime.
 *
 * @param {number} nowMs
 * @param {number} birthtimeMs
 * @returns {number|null} rounded span in ms, or null
 */
function spanFromBirthtime(nowMs, birthtimeMs) {
  if (!Number.isFinite(birthtimeMs) || birthtimeMs <= 0) return null;
  const span = nowMs - birthtimeMs;
  if (!Number.isFinite(span) || span < 0 || span > META_BIRTHTIME_MAX_SPAN_MS) return null;
  return Math.round(span);
}

/** Tail window for the STATUS scan — sidecars measured at 113–528 KB. */
const STATUS_TAIL_BYTES = 64 * 1024;

/**
 * STATUS literals an agent reports at the START of a line (optionally bold).
 *
 * LINE-ANCHORED on purpose — the rationale and the measurement are at
 * `scripts/lib/wave-transcript-tail.mjs:105-112`: a free-floating
 * `/STATUS: partial/` fires on any agent that merely QUOTES the marker
 * (2 of 2 live hits in that measurement were quotations, 0 were reports).
 * NOT imported from that module because the two alternations are DIFFERENT
 * literal sets, not two copies of one: the tailer's `STATUS_RE` matches only
 * `partial|blocked|failed` (it classifies a single `status-partial` attention
 * pattern), while this hook records the agent's SELF-REPORTED status and must
 * therefore also match `done` and `no-tests-needed`. Importing its constant
 * would silently drop the two success literals. (Import cost is NOT the reason —
 * measured 2026-09-02 as equal.)
 */
const AGENT_STATUS_RE = /^[ \t*_]*STATUS:\s*(done|partial|blocked|failed|no-tests-needed)\b/im;

/**
 * Pick the first non-empty trimmed string among `keys` on `input`.
 * @param {object|null|undefined} input
 * @param {string[]} keys
 * @returns {string|null}
 */
function firstNonEmptyString(input, keys) {
  for (const k of keys) {
    const v = input?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Extension-less path of the stopping agent's sidecar pair, derived from the
 * PARENT transcript path the harness sends on stdin:
 * `<dir>/<parent-basename>/subagents/agent-<agent_id>` (+ `.jsonl` / `.meta.json`).
 * Shape verified against live transcripts — same derivation as
 * `hooks/subagent-telemetry.mjs` `resolveSubagentTranscriptPath()`.
 *
 * @param {unknown} parentTranscriptPath
 * @param {string|null} agentId
 * @returns {string|null} null when underivable (never the parent path)
 */
function resolveSidecarBase(parentTranscriptPath, agentId) {
  if (typeof parentTranscriptPath !== 'string' || !parentTranscriptPath.trim()) return null;
  if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) return null;
  const dir = path.dirname(parentTranscriptPath);
  const base = path.basename(parentTranscriptPath).replace(/\.jsonl$/i, '');
  if (!base || base === '.' || base === '..') return null;
  return path.join(dir, base, 'subagents', `agent-${agentId}`);
}

/**
 * Read the LAST `STATUS_TAIL_BYTES` of an agent transcript and return the most
 * recent line-anchored STATUS literal, or null when none is present.
 *
 * Never reads the whole file: measured sidecar sizes are 113–528 KB and this
 * hook fires on every SubagentStop. Absence means NOT FOUND, never success —
 * measured 2026-09-02, only 1 of 4 live sidecars carried a STATUS token in its
 * last 64 KiB, so the miss is the common path.
 *
 * @param {string} transcriptPath
 * @returns {string|null}
 */
function readStatusFromTranscriptTail(transcriptPath) {
  let fd = null;
  try {
    fd = openSync(transcriptPath, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, STATUS_TAIL_BYTES);
    const start = size - length;
    const buf = Buffer.alloc(length);
    const read = readSync(fd, buf, 0, length, start);
    let lines = buf.subarray(0, read).toString('utf8').split('\n');
    // Drop the leading partial line when the window did not start at byte 0.
    if (start > 0) lines = lines.slice(1);

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch { continue; }
      const content = rec?.message?.content;
      if (!Array.isArray(content)) continue;
      for (let j = content.length - 1; j >= 0; j -= 1) {
        const block = content[j];
        if (typeof block?.text !== 'string') continue;
        const m = AGENT_STATUS_RE.exec(block.text);
        if (m) return m[1].toLowerCase();
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdinJson();
  const eventType = discriminate(input);

  if (eventType === 'subagent_stop') {
    const additionalContext = await handleSubagentStop(input);
    // v2.1.163+: emit hookSpecificOutput for SubagentStop path.
    // If handleSubagentStop returns a non-empty context string, feed it back
    // to the coordinator turn. Currently returns null (no inline warning from
    // this handler), but the slot is live for future SubagentStop feedback.
    // terminalSequence is a Stop-only field — not emitted for SubagentStop.
    if (typeof additionalContext === 'string' && additionalContext.length > 0) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SubagentStop',
          additionalContext,
        },
      }));
    }
  } else {
    // terminalSequence must be emitted even when handleStop() throws (e.g.
    // emitEvent's fs.appendFile fails on a full / read-only disk). Wrap the
    // Stop branch in try/finally so the desktop notification is always sent.
    // SubagentStop is intentionally outside this block — it must never emit
    // terminalSequence.
    try {
      await handleStop(input);
    } finally {
      // terminalSequence is only meaningful for Stop (session-level) events.
      process.stdout.write(buildTerminalSequenceJson());
    }
  }
}

// ---------------------------------------------------------------------------
// terminal notification
// ---------------------------------------------------------------------------

/**
 * Emit a cross-platform desktop notification via the CC 2.1.141+ terminalSequence
 * output field. Supports OSC 9 (iTerm2, Windows Terminal, WezTerm, ConEmu) and
 * OSC 777 (Ghostty, urxvt, Warp). Both sequences are emitted together; unsupported
 * terminals silently ignore. Returns the JSON string to write to stdout.
 * @returns {string}
 */
function buildTerminalSequenceJson() {
  const title = 'Claude Code';
  const body  = 'Session stopped — your turn';
  const osc9   = `\x1b]9;${title}: ${body}\x07`;
  const osc777 = `\x1b]777;notify;${title};${body}\x07`;
  return JSON.stringify({ terminalSequence: osc9 + osc777 });
}

// Exit 0 always — informational hook must never block Claude.
main()
  .catch(() => {})
  .finally(() => process.exit(0));
