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
 * Exit codes: 0 always (informational hooks must never block).
 *
 * JSONL format (`.orchestrator/metrics/events.jsonl`) — emitted via the canonical
 * `emitEvent()` so the JSONL record and the optional Clank webhook always carry the
 * SAME dotted event name (was: bare `stop`/`subagent_stop` in JSONL vs dotted in webhook):
 *   Stop:        {"timestamp":<ISO>,"event":"orchestrator.session.stopped","session_id":"...","wave":<int>,"branch":"...","commit":"...","duration_ms":<int>}
 *   SubagentStop: {"timestamp":<ISO>,"event":"orchestrator.agent.stopped","agent":"<name>"}
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { $ } from 'zx';

import { shouldRunHook } from './_lib/profile-gate.mjs';
// #211: exit 0 immediately (silent allow) when this hook is disabled via profile/env
if (!shouldRunHook('on-stop')) process.exit(0);

import { emitEvent } from '../scripts/lib/events.mjs';
import { SO_PROJECT_DIR } from '../scripts/lib/platform.mjs';
import { deregisterSelf, logSweepEvent } from '../scripts/lib/session-registry.mjs';
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
// git helpers
// ---------------------------------------------------------------------------

/**
 * Returns { commit, branch } from the git repo at projectRoot, or null values
 * if git is unavailable or the directory is not a git repo.
 * @param {string} projectRoot — working directory for git commands
 * @returns {Promise<{commit:string|null, branch:string|null}>}
 */
async function gitInfo(projectRoot) {
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
 * Resolve this session's id. Stdin payload wins. If Claude Code did not pass
 * one (Codex / Cursor paths, or older harnesses), fall back to
 * `.orchestrator/current-session.json` which on-session-start.mjs writes.
 *
 * @param {object|null} input
 * @param {string} projectRoot
 * @returns {Promise<string|null>}
 */
async function resolveSessionId(input, projectRoot) {
  const fromStdin = input?.session_id ?? input?.sessionId ?? null;
  if (typeof fromStdin === 'string' && fromStdin.length > 0) return fromStdin;
  try {
    const raw = await fs.readFile(
      path.join(projectRoot, '.orchestrator', 'current-session.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw);
    if (typeof parsed.session_id === 'string' && parsed.session_id.length > 0) {
      return parsed.session_id;
    }
  } catch { /* missing or unparseable is fine */ }
  return null;
}

/**
 * Handle a Stop event. Reads wave from scope file + git info, appends JSONL.
 * @param {object|null} input
 */
async function handleStop(input) {
  const projectRoot = SO_PROJECT_DIR;

  const wave = await readWaveNumber(projectRoot);
  const { commit, branch } = await gitInfo(projectRoot);

  const sessionId = await resolveSessionId(input, projectRoot);

  // v3.1.0 multi-session registry (#169) — best-effort deregister. Missing
  // entry is fine (zombie sweep handles crashed sessions). Failures are logged
  // to sweep.log for observability but never re-thrown (hook must remain silent).
  if (sessionId) {
    try {
      await deregisterSelf(sessionId);
    } catch (err) {
      // Deregistration failed — emit an observability breadcrumb to sweep.log.
      // Do NOT throw, do NOT write to stderr: the hook is informational-only.
      logSweepEvent({ event: 'deregister-failed', session_id: sessionId, error: err?.message ?? String(err) });
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
  await emitEvent('orchestrator.session.stopped', {
    ...(sessionId !== null ? { session_id: sessionId } : {}),
    wave,
    ...(branch !== null ? { branch } : {}),
    ...(commit !== null ? { commit } : {}),
    duration_ms: durationMs,
  });
}

/**
 * Handle a SubagentStop event. Extracts agent name, emits orchestrator.agent.stopped.
 * @param {object|null} input
 */
async function handleSubagentStop(input) {
  const agent = input?.agent_type ?? 'unknown';
  await emitEvent('orchestrator.agent.stopped', { agent });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdinJson();
  const eventType = discriminate(input);

  if (eventType === 'subagent_stop') {
    await handleSubagentStop(input);
  } else {
    await handleStop(input);
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
  .finally(() => {
    process.stdout.write(buildTerminalSequenceJson());
    process.exit(0);
  });
