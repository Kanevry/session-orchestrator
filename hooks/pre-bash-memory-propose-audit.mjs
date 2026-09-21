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
 *   G5 — resolve wave (from the active wave-scope.json `wave` field, default 0)
 *   G6 — derive a NON-REVERSIBLE argv summary: sha256 command_hash + known flag
 *        NAMES + raw length. The command text itself never leaves this process.
 *   G7 — append event JSON line to .orchestrator/metrics/events.jsonl
 *   Always: exit 0 (never block)
 *
 * Exit codes:
 *   0  — always (audit hook is observe-only, never denies)
 */

import { readStdin, emitAllow } from '../scripts/lib/io.mjs';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { emitEvent } from '../scripts/lib/events.mjs';
import { findScopeFile } from '../scripts/lib/hardening.mjs';

import { shouldRunHook } from './_lib/profile-gate.mjs';
import { isMainModule } from '../scripts/lib/is-main-module.mjs';

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
 * The flag NAMES `scripts/memory-propose.mjs` accepts (its `parseArgs` options
 * block, plus `--help`). CLOSED LIST BY DESIGN: `flags_present` is built by
 * intersecting the command with this constant, never by scraping `--\S+` tokens
 * out of the command. A scrape would re-open the leak this file just closed —
 * `--insight --my-secret-value` would publish the value as if it were a flag.
 *
 * A flag the CLI does not know is simply not reported. That is the correct
 * trade: the field exists to say WHICH of the audited CLI's switches were used,
 * not to mirror the command line.
 */
const KNOWN_FLAGS = Object.freeze([
  'type',
  'subject',
  'insight',
  'evidence',
  'confidence',
  'dry-run',
  'file-paths',
  'help',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * sha256(command), truncated to 16 hex characters.
 *
 * WORD-FOR-WORD the `hashCommand()` of `hooks/enforce-commands.mjs:69` (itself
 * taken from `hooks/pre-bash-destructive-guard.mjs:253`, which mirrors
 * `loop-guard.mjs` `hashArgs()`). Deliberately duplicated rather than shared:
 * a PreToolUse hook must not gain another loadable module that can fail at
 * start — three lines are cheaper than a load error on the hot path. Verified
 * before duplicating that no helper is EXPORTED at any of those sites.
 *
 * WHY THE HASH IS HERE (#1415, 2026-09-21): until today this hook wrote a
 * merely flag-redacted `argv_truncated` (512 chars of command text) into
 * `orchestrator.memory.propose_invoked` — a TRACKED `events.jsonl` line and,
 * with the webhook configured, a network payload. Redaction covered only the
 * five `--insight/--subject/--evidence/--content/--reason` values and said so
 * in its own caveat: `$VAR`, `$(cat secret)` and any value written elsewhere
 * on the line passed through. This was the THIRD and last open site of the
 * class closed by `8f15f77b` (enforce-commands) and #1404 (staging-fence).
 *
 * The hash keeps the event COUNTABLE and GROUPABLE — repeat invocations of the
 * same command still collapse to one key — which is the only property any
 * consumer needed. Measured 2026-09-21 (`rg argv_truncated` over `scripts/
 * hooks/ skills/ docs/`): ZERO production readers, the field's only consumers
 * were this hook's own tests.
 *
 * @param {string} command
 * @returns {string}
 */
function hashCommand(command) {
  return crypto.createHash('sha256').update(command).digest('hex').slice(0, 16);
}

/**
 * The subset of KNOWN_FLAGS that appears in the command, in KNOWN_FLAGS order.
 *
 * Names only — a value can never reach this array, because the array is built
 * from the constant above and the command is only ever TESTED against it. Both
 * spellings count (`--insight=x` and `--insight x`); the trailing boundary
 * `(?![\w-])` keeps `--insightful` from reporting `insight`.
 *
 * @param {string} command
 * @returns {string[]}
 */
function flagsPresent(command) {
  return KNOWN_FLAGS.filter((flag) =>
    new RegExp(`--${flag}(?![\\w-])`).test(command),
  );
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
 * Resolve the current wave number from the active wave-scope.json.
 * Returns 0 when the file is absent or unparseable.
 *
 * @param {string} projectDir
 * @returns {Promise<number>}
 */
async function resolveWave(projectDir) {
  const waveFile = findScopeFile(projectDir);
  if (!waveFile || !existsSync(waveFile)) return 0;
  try {
    const raw = await readFile(waveFile, 'utf8');
    const data = JSON.parse(raw);
    const wave = data?.wave;
    return typeof wave === 'number' ? wave : 0;
  } catch {
    return 0;
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

  // G6 — derive the non-reversible argv summary (#1415). Nothing downstream
  // ever sees the command text: hash for grouping, known flag NAMES for
  // shape, raw length for size — no operands, no paths, no values.
  const commandHash = hashCommand(command);
  const flags = flagsPresent(command);

  // G7 — emit canonical event via emitEvent (single emission path: schema + webhook,
  // replacing the local hand-rolled appendFileSync bypass).
  // #1183 — a malformed record throws EventValidationError BEFORE any side
  // effect (scripts/lib/events.mjs); this PreToolUse hook must never abort on
  // that (it is deny-capable via emitAllow() below), so the emit is wrapped
  // rather than left to propagate.
  try {
    await emitEvent('orchestrator.memory.propose_invoked', {
      session_id: sessionId,
      wave,
      command_hash: commandHash,
      flags_present: flags,
      argv_length: command.length,
      cwd: process.cwd(),
      exit_code: null,
    });
  } catch { /* telemetry never blocks the hook (#1183) */ }

  // Always allow — this is an observe-only audit hook
  return emitAllow();
}

// Entry guard (#1393): run only as the node script the harness execs — a bare
// `import()` must run no handler and must not exit the importing process.
if (isMainModule(import.meta.url)) {
  // exit 0 immediately when this hook is disabled via profile/env
  if (!shouldRunHook('pre-bash-memory-propose-audit')) process.exit(0);

  // Top-level error handler — never let exit 1 leak
  main().catch((e) => {
    process.stderr.write(
      `⚠ pre-bash-memory-propose-audit: internal error — ${e?.message || e}\n`,
    );
    process.exit(0); // fail-open on internal errors
  });
}
