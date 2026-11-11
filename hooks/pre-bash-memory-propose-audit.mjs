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
 *   G1 — Bash and Monitor commands (other tools → exit 0)
 *   G2 — non-empty command string (else → exit 0)
 *   G3 — regex match /\bnode\b.*\bmemory-propose\.mjs\b/i (no match → exit 0)
 *   G4 — resolve session_id (from stdin payload or .orchestrator/current-session.json)
 *   G5 — resolve wave (from the active wave-scope.json `wave` field, default 0)
 *   G6 — derive a NON-REVERSIBLE argv summary: keyed host-local HMAC command_hash
 *        (`hmac:<16hex>`, hooks/_lib/command-hash.mjs, #1880) + known flag
 *        NAMES + raw length. The command text itself never leaves this process.
 *   G7 — append event JSON line to .orchestrator/metrics/events.jsonl
 *   Always: exit 0 (never block)
 *
 * Exit codes:
 *   0  — always (audit hook is observe-only, never denies)
 */

import { isShellCommandTool, readStdin, emitAllow } from '../scripts/lib/io.mjs';
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emitEvent } from '../scripts/lib/events.mjs';
import { getProjectDir, resolveSessionRoot } from '../scripts/lib/platform.mjs';
import { findOwnScopeFile } from '../scripts/lib/scope-gate.mjs';
import {
  classifyManifestSession,
  readProcessLocalSessionIds,
} from '../scripts/lib/session-identity/own-session.mjs';

import { shouldRunHook } from './_lib/profile-gate.mjs';
// `command_hash`: keyed host-local HMAC since #1880 (was an unsalted sha256
// prefix, reversible by dictionary). Replaced `argv_truncated` in #1415.
import { hashCommand } from './_lib/command-hash.mjs';
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
 * The working directory as a value that carries no absolute host path (#1439).
 *
 * Relative to `projectDir` (`.` when equal); a directory OUTSIDE the project is
 * written as a keyed mark of its resolved path instead — still groupable on one
 * host, never the path itself. The mark is `hashCommand('cwd:' + realCwd)`, i.e.
 * `hmac:<16 hex>` under the host-local key (`v0-hmac:<16 hex>` when the key file
 * is unusable), since #1915; before, an unsalted `sha256:<12 hex>` prefix that a
 * guessable path (`/Users/<name>/…`) reverses by dictionary. The `cwd:` prefix
 * separates the domains: a directory and a `command_hash` of the same text never
 * share a mark. Until 2026-09-25 this was `process.cwd()` verbatim,
 * i.e. `/Users/<name>/…` in an events.jsonl line (gitignored here via
 * `.gitignore:57`; consumer repos may track it) and, with the webhook
 * configured, in a network payload. No production reader consumes `cwd`.
 *
 * Both sides are realpath-resolved before comparing: on macOS the tmp dir is
 * `/var/…` while `process.cwd()` reports `/private/var/…`, and a naive
 * `path.relative` then calls the project dir itself `../../../private/var/…`.
 * A path that cannot be resolved falls back to `path.resolve` — never throws.
 *
 * A project dir that is no project boundary — the filesystem root, the home
 * dir, or an ancestor of it (`/Users`) — also gets the keyed form: relative to
 * `/` the cwd reads `Users/<name>/…`, i.e. the username in a webhook-bound
 * event, the very leak the relative form exists to prevent. The ancestor test
 * is path-segment-wise (`path.relative`), so `/Users/al` is NOT an ancestor of
 * `/Users/alice` the way a string prefix would claim.
 *
 * @param {string} cwd
 * @param {string} projectDir
 * @returns {string}
 */
function relativeCwd(cwd, projectDir) {
  const real = (p) => {
    try { return realpathSync(p); } catch { return path.resolve(p); }
  };
  // `..`-prefixed (above the base) or absolute (another Windows drive).
  const escapes = (rel) =>
    rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  const realCwd = real(cwd);
  const realProject = real(projectDir);
  const rel = path.relative(realProject, realCwd);
  if (rel === '') return '.';
  // Keyed, domain-separated mark (#1915): the `command_hash` recipe (#1880)
  // over `cwd:<path>`, so a cwd never shares a mark with an equal command text.
  const hashed = hashCommand(`cwd:${realCwd}`);
  if (escapes(rel)) return hashed;
  if (path.dirname(realProject) === realProject) return hashed; // filesystem root
  let home = null;
  try { home = real(os.homedir()); } catch { /* no home dir: root check above still holds */ }
  if (home !== null && !escapes(path.relative(realProject, home))) return hashed;
  return rel;
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
 * Resolve the current wave number from THIS session's wave-scope.json.
 * Returns 0 when the file is absent or unparseable — and when the only
 * manifest is a peer's (#1504): its number is not this session's wave.
 *
 * @param {string} projectDir  the session root (`resolveSessionRoot`)
 * @param {Set<string>} ownIds  this process's own session ids
 * @returns {Promise<number>}
 */
async function resolveWave(projectDir, ownIds) {
  const { path: waveFile } = findOwnScopeFile(projectDir, ownIds, classifyManifestSession);
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

  // G1 — Bash and Monitor commands are audited
  if (!isShellCommandTool(input.tool_name)) return emitAllow();

  // G2 — command must be a non-empty string
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || command.length === 0) return emitAllow();

  // G3 — regex gate: only memory-propose.mjs invocations via node
  if (!MEMORY_PROPOSE_REGEX.test(command)) return emitAllow();

  // Matched — proceed with audit logging (G4-G7)
  // Two roots, by writer (#1511 point c). The session-id fallback reads
  // `current-session.json` where on-session-start.mjs WRITES it — the launch dir,
  // through the same resolver (`resolveProjectDir`; the hand-rolled
  // `CLAUDE_PROJECT_DIR ?? CODEX_PROJECT_DIR ?? process.cwd()` kept a set-but-
  // empty var, skipped the Cursor/Pi vars and never walked up). The wave and the
  // recorded `cwd` describe the tree the session WORKS in: the SESSION root the
  // scope guards use (#1504 point 4), which after EnterWorktree is not the
  // launch dir.
  const projectDir = getProjectDir();
  const sessionRoot = resolveSessionRoot(input.cwd);

  // G4 — resolve session_id
  const sessionId = await resolveSessionId(input, projectDir);

  // G5 — resolve wave
  const wave = await resolveWave(
    sessionRoot,
    new Set(readProcessLocalSessionIds({ hookInput: input })),
  );

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
      cwd: relativeCwd(process.cwd(), sessionRoot),
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
