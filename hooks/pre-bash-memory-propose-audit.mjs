#!/usr/bin/env node
/**
 * pre-bash-memory-propose-audit.mjs — PreToolUse Bash hook
 *
 * Logs memory.propose() CLI invocations to .orchestrator/metrics/events.jsonl
 * for auditability. Observe-only — never blocks the Bash call.
 *
 * Part of issue #501. Node 20+, ESM, no external deps beyond project libs.
 *
 * Decision flow (G1-G7 early-return ladder):
 *   G1 — Bash tool only (other tools → exit 0)
 *   G2 — non-empty command string (else → exit 0)
 *   G3 — regex match /\bnode\b.*\bmemory-propose\.mjs\b/i (no match → exit 0)
 *   G4 — resolve session_id (from stdin payload or .orchestrator/current-session.json)
 *   G5 — resolve wave (from .claude/wave-scope.json `wave` field, default 0)
 *   G6 — redact argv: strip --insight/--subject/--evidence/--content/--reason values
 *   G7 — append event JSON line to .orchestrator/metrics/events.jsonl
 *   Always: exit 0 (never block)
 *
 * Exit codes:
 *   0  — always (audit hook is observe-only, never denies)
 */

import { readStdin, emitAllow } from '../scripts/lib/io.mjs';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { shouldRunHook } from './_lib/profile-gate.mjs';
// exit 0 immediately when this hook is disabled via profile/env
if (!shouldRunHook('pre-bash-memory-propose-audit')) process.exit(0);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Matches `node ... memory-propose.mjs ...` invocations in any form:
 *   node scripts/memory-propose.mjs ...
 *   node "$PLUGIN_ROOT/scripts/memory-propose.mjs" ...
 *   /usr/bin/node ./scripts/memory-propose.mjs ...
 * Does NOT match:
 *   echo "memory-propose.mjs"
 *   cat scripts/memory-propose.mjs
 */
const MEMORY_PROPOSE_REGEX = /\bnode\b.*\bmemory-propose\.mjs\b/i;

/**
 * Flags whose VALUES are privacy-sensitive and must be redacted from the log.
 * The flag name itself is preserved; only the value is replaced with [REDACTED].
 *
 * Matches both forms:
 *   --insight=value            → --insight=[REDACTED]
 *   --insight "quoted value"   → --insight [REDACTED]
 *   --insight unquoted         → --insight [REDACTED]
 */
// Issue #546: `\S+` would match an opening quote `"` or `'` (non-whitespace),
// and on malformed inputs (e.g. unbalanced or shell-already-unescaped values)
// could partial-match the value, leaving the tail unredacted. The negative
// lookahead `(?!["'])` forces `\S+` to be tried only on values that do not
// start with a quote, preserving the quoted-alt as the sole path for quoted
// values and preventing tail-leaks on malformed inputs.
const SENSITIVE_FLAGS_REGEX = /--(?:insight|subject|evidence|content|reason)(?:=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?!["'])\S+)|\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?!["'])\S+))/g;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Redact values of privacy-sensitive flags from a command string.
 * Preserves flag names; replaces values with [REDACTED].
 *
 * @param {string} command
 * @returns {string}
 */
function redactArgv(command) {
  return command.replace(SENSITIVE_FLAGS_REGEX, (match, eqValue, spaceValue) => {
    if (eqValue !== undefined) {
      // --insight=value form: preserve up to and including '=', replace value
      const eqIndex = match.indexOf('=');
      return match.slice(0, eqIndex + 1) + '[REDACTED]';
    }
    if (spaceValue !== undefined) {
      // --insight value form: preserve flag + whitespace, replace value
      const valueIndex = match.lastIndexOf(spaceValue);
      return match.slice(0, valueIndex) + '[REDACTED]';
    }
    // Fallback: keep flag name, drop value
    const flagMatch = match.match(/^(--[\w-]+)/);
    return flagMatch ? flagMatch[1] + ' [REDACTED]' : match;
  });
}

/**
 * Resolve the session_id from the hook stdin payload, with fallback to the
 * persisted file written by on-session-start.mjs. Returns null when neither
 * source yields a string.
 *
 * @param {object|null} input
 * @param {string} projectDir
 * @returns {Promise<string|null>}
 */
async function resolveSessionId(input, projectDir) {
  const fromStdin = input?.session_id ?? input?.sessionId ?? null;
  if (typeof fromStdin === 'string' && fromStdin.length > 0) return fromStdin;

  const persisted = path.join(projectDir, '.orchestrator', 'current-session.json');
  if (!existsSync(persisted)) return null;
  try {
    const raw = await readFile(persisted, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      const sid = data.session_id ?? data.sessionId ?? null;
      if (typeof sid === 'string' && sid.length > 0) return sid;
    }
  } catch {
    // ignore — null below
  }
  return null;
}

/**
 * Resolve the current wave number from .claude/wave-scope.json.
 * Returns 0 when the file is absent or unparseable.
 *
 * @param {string} projectDir
 * @returns {Promise<number>}
 */
async function resolveWave(projectDir) {
  const waveFile = path.join(projectDir, '.claude', 'wave-scope.json');
  if (!existsSync(waveFile)) return 0;
  try {
    const raw = await readFile(waveFile, 'utf8');
    const data = JSON.parse(raw);
    const wave = data?.wave;
    return typeof wave === 'number' ? wave : 0;
  } catch {
    return 0;
  }
}

/**
 * Append a single-line JSON event to .orchestrator/metrics/events.jsonl.
 * Creates the parent directory if absent. Fire-and-forget: any error is
 * caught and reported to stderr without blocking.
 *
 * @param {string} eventsPath  Absolute path to events.jsonl
 * @param {object} event       Event object to serialise as a single line
 */
function appendEvent(eventsPath, event) {
  try {
    const dir = path.dirname(eventsPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(eventsPath, JSON.stringify(event) + '\n', 'utf8');
  } catch (err) {
    process.stderr.write(
      `⚠ pre-bash-memory-propose-audit: failed to append event — ${err?.message || err}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdin();
  if (!input) return emitAllow();

  // G1 — only Bash tool is audited
  if (input.tool_name !== 'Bash') return emitAllow();

  // G2 — command must be a non-empty string
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || command.length === 0) return emitAllow();

  // G3 — regex gate: only memory-propose.mjs invocations via node
  if (!MEMORY_PROPOSE_REGEX.test(command)) return emitAllow();

  // Matched — proceed with audit logging (G4-G7)
  const projectDir = process.env.CLAUDE_PROJECT_DIR
    ?? process.env.CODEX_PROJECT_DIR
    ?? process.cwd();

  // G4 — resolve session_id
  const sessionId = await resolveSessionId(input, projectDir);

  // G5 — resolve wave
  const wave = await resolveWave(projectDir);

  // G6 — redact argv: strip sensitive flag values, keep flag names
  const argvRedacted = redactArgv(command);

  // G7 — append event to events.jsonl
  const eventsPath = path.join(projectDir, '.orchestrator', 'metrics', 'events.jsonl');
  const event = {
    event: 'memory_propose_invoked',
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    wave,
    argv_truncated: argvRedacted.slice(0, 512),
    cwd: process.cwd(),
    exit_code: null,
  };

  appendEvent(eventsPath, event);

  // Always allow — this is an observe-only audit hook
  return emitAllow();
}

// Top-level error handler — never let exit 1 leak
main().catch((e) => {
  process.stderr.write(
    `⚠ pre-bash-memory-propose-audit: internal error — ${e?.message || e}\n`,
  );
  process.exit(0); // fail-open on internal errors
});
