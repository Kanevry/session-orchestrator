#!/usr/bin/env node
/**
 * express-path.mjs — the mechanical caller for the Express Path decision (#214, #1119, #1146).
 *
 * ## Why a CLI, and why this is the only shape that works
 *
 * `scripts/lib/express-path.mjs` has held the decision AND its telemetry since
 * #1119. Measured at HEAD 01eb35d, it had ZERO production callers:
 *
 *   rg -n "evaluateExpressPath" scripts hooks   → the definition, and nothing else
 *
 * Its only "caller" was a fenced ```js block in
 * `skills/session-start/phase-8-5-express-path.md` — prose that no process runs.
 * That is the repo's standing disease (built, not wired): a decision module whose
 * whole point is to record whether the fast path fired, reachable only if a
 * coordinator reads the right paragraph and hand-writes an import.
 *
 * A hook cannot close the gap. Both `sessionType` and `taskCount` exist only
 * AFTER the Phase 8 Q&A resolves, and no hook event fires at that moment. The
 * caller therefore has to be something the coordinator RUNS, in Phase 8.5, with
 * the answers it just received — i.e. this file.
 *
 * ## Usage
 *
 *   node scripts/express-path.mjs --repo-root <path> --session-type <type> \
 *        --task-count <n> [--parallel-agents true|false] [--config-file <path>]
 *
 * Options:
 *   --repo-root <path>          REQUIRED. Repo whose `.orchestrator/metrics/events.jsonl`
 *                               receives the record. Never defaulted: see below.
 *   --session-type <type>       REQUIRED. The type confirmed in Phase 8 (housekeeping|feature|deep).
 *   --task-count <n>            REQUIRED. Agreed issue/task scope, a non-negative integer.
 *   --parallel-agents <bool>    Optional `true`/`false`. Omitting it ASSERTS NOTHING —
 *                               the field is left out of the record entirely.
 *   --config-file <path>        Optional. Defaults to CLAUDE.md / AGENTS.md under
 *                               --repo-root (SO_CONFIG_FILE honoured first, as in
 *                               parse-config.mjs).
 *   --help, -h                  Print this usage block.
 *
 * Output: ONE JSON line on stdout — the `evaluateExpressPath` verdict verbatim,
 * `{"activated":<bool>,"reasons":[…]}`. Always JSON, so there is no `--json`
 * flag, matching its two siblings `parse-config.mjs` and `emit-session.mjs`.
 * Diagnostics — including the activation banner — go to stderr.
 *
 * Exit codes:
 *   0 — the evaluation COMPLETED. `activated:false` is a completed evaluation and
 *       exits 0: a refusal is an answer, not a failure. Callers branch on the
 *       stdout `activated` field, never on the exit code.
 *   1 — user/input error: missing or invalid --repo-root / --session-type /
 *       --task-count / --parallel-agents, or an unknown flag.
 *   2 — config I/O error: an unreadable or unparseable config file.
 *
 * ## Two deliberate asymmetries
 *
 * `--repo-root` is REQUIRED and is never filled from `SO_PROJECT_DIR`. The
 * library refuses that fallback for a measured reason (#941: an ambient
 * destination put a synthetic record into the operator's real fleet ledger), and
 * a CLI that quietly supplied one would reinstate exactly what the library
 * refuses. A missing repo-root is an input error here, not a default.
 *
 * A config file that EXISTS but cannot be read or parsed exits 2 — it may carry
 * `express-path.enabled: false`, and guessing past an unreadable opt-out would
 * activate a path that skips every inter-wave quality gate. A config file that
 * is simply ABSENT is not an error: there is no opt-out to lose, the documented
 * default (`enabled: true`) applies to the decision, and `enabled` is omitted
 * from the record so "nobody looked" stays distinguishable from "operator said
 * true".
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveInstructionFile } from './lib/common.mjs';
import { parseSessionConfig } from './lib/config.mjs';
import { evaluateExpressPath } from './lib/express-path.mjs';

const USAGE = [
  'Usage: node scripts/express-path.mjs --repo-root <path> --session-type <type> --task-count <n>',
  '                                     [--parallel-agents true|false] [--config-file <path>]',
  '',
  '  --repo-root        REQUIRED  repo receiving the .orchestrator/metrics/events.jsonl record',
  '  --session-type     REQUIRED  session type confirmed in session-start Phase 8',
  '  --task-count       REQUIRED  agreed issue/task scope (non-negative integer)',
  '  --parallel-agents  optional  true|false; omitted means "not asserted", never false',
  '  --config-file      optional  defaults to CLAUDE.md / AGENTS.md under --repo-root',
  '',
  'stdout: one JSON line — {"activated":<bool>,"reasons":[…]}',
  'Exit codes: 0 evaluation completed (activated true OR false), 1 input error, 2 config I/O error',
].join('\n');

/** User/input error — usage class. */
const EXIT_INPUT = 1;
/** System error — config could not be read or parsed. */
const EXIT_CONFIG_IO = 2;

/**
 * Write a diagnostic line to stderr. stdout carries the verdict and nothing
 * else, so every human-facing line goes here (`cli-design.md` § JSON-First).
 *
 * @param {string} message
 * @returns {void}
 */
function warn(message) {
  process.stderr.write(`express-path: ${message}\n`);
}

/**
 * Fail with a usage-class diagnostic and the given exit code.
 *
 * @param {string} message
 * @param {number} code
 * @returns {never}
 */
function fail(message, code) {
  warn(message);
  process.exit(code);
}

/**
 * Resolve the config file to read, anchored at `--repo-root`.
 *
 * The CLAUDE.md → AGENTS.md half is NOT re-implemented here: that walk is
 * `resolveInstructionFile()` in `scripts/lib/common.mjs`, the SSOT for the
 * instruction-file alias rule (`skills/_shared/instruction-file-resolution.md`)
 * that 8 other modules already share. Reusing it also inherits its size > 0
 * guard, which this function lacked: a zero-byte CLAUDE.md used to be accepted
 * and parsed, publishing `enabled` from an empty document as if it had been
 * measured. Only the candidate the shared walk does not know about is layered
 * on top — the `SO_CONFIG_FILE` override `scripts/parse-config.mjs` honours,
 * plus an explicit `--config-file`, which wins outright.
 *
 * Anchoring at `repoRoot` instead of walking up from cwd is deliberate: the
 * repo is already known here, and a walk-up could reach a DIFFERENT repo's
 * config than the one being recorded.
 *
 * Named `resolveRepoConfigPath`, NOT `resolveConfigFile`: that name is already
 * taken twice with two other meanings — `scripts/lib/platform.mjs` maps a
 * PLATFORM to a bare filename, `scripts/lib/ecosystem-wizard/config-writer.mjs`
 * resolves the wizard's own target. A third meaning under one name is a trap
 * for the next person who greps it.
 *
 * @param {string} repoRoot — absolute repo root
 * @param {string|undefined} explicit — value of `--config-file`, if given
 * @returns {string|null} absolute path, or null when no config file exists
 */
function resolveRepoConfigPath(repoRoot, explicit) {
  if (explicit) {
    const abs = resolve(explicit);
    if (!existsSync(abs)) fail(`config file not found: ${explicit}`, EXIT_CONFIG_IO);
    return abs;
  }

  if (process.env.SO_CONFIG_FILE) {
    const override = join(repoRoot, process.env.SO_CONFIG_FILE);
    if (existsSync(override)) return override;
  }

  return resolveInstructionFile(repoRoot)?.path ?? null;
}

/**
 * Read and parse the Session Config.
 *
 * Returns `undefined` — not `{}` — when no config file exists, so
 * `evaluateExpressPath` can tell "not measured" from "measured as absent" and
 * keep `enabled` out of the record. See the module docstring's second asymmetry.
 *
 * @param {string|null} configFile
 * @returns {object|undefined}
 */
function loadConfig(configFile) {
  if (configFile === null) {
    warn('no CLAUDE.md / AGENTS.md under --repo-root; applying the documented default enabled=true');
    return undefined;
  }

  let content;
  try {
    content = readFileSync(configFile, 'utf8');
  } catch (err) {
    fail(`failed to read ${configFile}: ${err.message}`, EXIT_CONFIG_IO);
  }

  try {
    return parseSessionConfig(content);
  } catch (err) {
    fail(`failed to parse ${configFile}: ${err.message}`, EXIT_CONFIG_IO);
  }
}

/**
 * Parse `--parallel-agents`. Tri-state on purpose: `undefined` means the
 * coordinator asserted nothing, which the library records differently from an
 * explicit `false`.
 *
 * @param {string|undefined} raw
 * @returns {boolean|undefined}
 */
function parseParallelAgents(raw) {
  if (raw === undefined) return undefined;
  const value = String(raw).trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fail(`--parallel-agents must be "true" or "false" (got: ${raw})`, EXIT_INPUT);
}

async function main() {
  /** @type {{values: Record<string, string|boolean>}} */
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        'repo-root': { type: 'string' },
        'session-type': { type: 'string' },
        'task-count': { type: 'string' },
        'parallel-agents': { type: 'string' },
        'config-file': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    });
  } catch (err) {
    fail(`${err.message}\n\n${USAGE}`, EXIT_INPUT);
  }

  const { values } = parsed;

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  // --repo-root — required, never defaulted from the ambient env (#941).
  const repoRootArg = typeof values['repo-root'] === 'string' ? values['repo-root'].trim() : '';
  if (repoRootArg === '') {
    fail(`--repo-root is required (never defaulted from SO_PROJECT_DIR)\n\n${USAGE}`, EXIT_INPUT);
  }
  const repoRoot = resolve(repoRootArg);
  if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
    // A typo'd root would otherwise be CREATED by the emitter's mkdir, leaving
    // an orphan `.orchestrator/metrics/` tree that answers no question.
    fail(`--repo-root is not an existing directory: ${repoRootArg}`, EXIT_INPUT);
  }

  // --session-type — required. The library fails CLOSED on an unknown type; the
  // CLI refuses it outright so the miss is reported rather than recorded.
  const sessionType =
    typeof values['session-type'] === 'string' ? values['session-type'].trim() : '';
  if (sessionType === '') {
    fail(`--session-type is required\n\n${USAGE}`, EXIT_INPUT);
  }

  // --task-count — required, non-negative integer.
  const taskCountRaw = typeof values['task-count'] === 'string' ? values['task-count'].trim() : '';
  if (taskCountRaw === '') {
    fail(`--task-count is required\n\n${USAGE}`, EXIT_INPUT);
  }
  const taskCount = Number(taskCountRaw);
  if (!Number.isInteger(taskCount) || taskCount < 0) {
    fail(`--task-count must be a non-negative integer (got: ${taskCountRaw})`, EXIT_INPUT);
  }

  const parallelAgentsRequired = parseParallelAgents(
    typeof values['parallel-agents'] === 'string' ? values['parallel-agents'] : undefined,
  );

  const configFile = resolveRepoConfigPath(
    repoRoot,
    typeof values['config-file'] === 'string' ? values['config-file'] : undefined,
  );
  const config = loadConfig(configFile);

  const verdict = await evaluateExpressPath({
    repoRoot,
    config,
    sessionType,
    taskCount,
    parallelAgentsRequired,
  });

  // The banner the coordinator echoes into the transcript — `/go` and
  // session-plan's Express Path Short-Circuit both key off this EXACT line
  // (`commands/go.md` § Express Path Detection), so it is written verbatim,
  // without the `express-path:` diagnostic prefix. Still stderr: stdout belongs
  // to the verdict.
  if (verdict.activated) {
    process.stderr.write(
      `Express path activated — ${taskCount} tasks, coordinator-direct, no inter-wave checks.\n`,
    );
  }

  process.stdout.write(`${JSON.stringify(verdict)}\n`);
}

main().catch((err) => {
  process.stderr.write(`express-path: unexpected error: ${err?.stack ?? err}\n`);
  process.exit(EXIT_CONFIG_IO);
});
