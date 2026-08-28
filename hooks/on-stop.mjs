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
 *   Stop:        {"timestamp":<ISO>,"event":"orchestrator.session.stopped","session_id":"...","semantic_session_id":"...","wave":<int>,"branch":"...","commit":"...","duration_ms":<int>}
 *                (`session_id` / `semantic_session_id` are omitted when unresolvable — #1068 AC1.)
 *   SubagentStop: {"timestamp":<ISO>,"event":"orchestrator.agent.stopped","agent":"<name>"}
 */

import path from 'node:path';
import { promises as fs, statSync, writeFileSync } from 'node:fs';

import { shouldRunHook } from './_lib/profile-gate.mjs';
// #211: exit 0 immediately (silent allow) when this hook is disabled via profile/env
if (!shouldRunHook('on-stop')) process.exit(0);

import { emitEvent } from '../scripts/lib/events.mjs';
import { SO_PROJECT_DIR } from '../scripts/lib/platform.mjs';
import { parseSessionId } from '../scripts/lib/session-id.mjs';
import { heartbeat, logSweepEvent } from '../scripts/lib/session-registry.mjs';
import { updateHeartbeat } from '../scripts/lib/session-lock.mjs';

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
  let sessionId = parseSessionId(fromStdin)?.format === 'uuid' ? fromStdin : null;

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

  if (sessionId === null) sessionId = recordedId;

  const isRecordedSession = sessionId !== null && sessionId === recordedId;
  return {
    sessionId,
    semanticSessionId: isRecordedSession ? semanticSessionId : null,
  };
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

  // duration_ms: if input provides a start time we compute from it, else 0
  const durationMs =
    typeof input?.start_ms === 'number' ? Date.now() - input.start_ms : 0;

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
    duration_ms: durationMs,
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
  const agent = input?.agent_type ?? 'unknown';
  await emitEvent('orchestrator.agent.stopped', { agent });
  return null;
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
