#!/usr/bin/env node
/**
 * session-shape.mjs — the mechanical caller for the session-shape resolution.
 *
 * ## Why a CLI
 *
 * `scripts/lib/session-shape.mjs` holds the shape AND its telemetry. A library
 * with no entrypoint is the repo's standing disease (built, not wired): its only
 * caller would be a fenced code block in a skill file, which no process runs.
 * Both `sessionType` and `profile` exist only AFTER the session-start Q&A
 * resolves, and no hook event fires at that moment — so the caller has to be
 * something the coordinator RUNS with the answers it just received, i.e. this
 * file. Same shape as its sibling `scripts/express-path.mjs` (#1146).
 *
 * ## Usage
 *
 *   node scripts/session-shape.mjs --repo-root <path> --session-type <type> \
 *        [--profile ultradeep] [--known-scope true|false] [--task-count <n>] \
 *        [--config-file <path>] [--no-event]
 *
 * Output: ONE JSON line on stdout — the shape verbatim. Always JSON, so there is
 * no `--json` flag, matching `express-path.mjs` and `parse-config.mjs`. Human
 * diagnostics go to stderr.
 *
 * Exit codes (`.claude/rules/cli-design.md`):
 *   0 — the shape RESOLVED. Read it from stdout.
 *   1 — user/input error: missing/invalid --repo-root, --session-type, --profile,
 *       --known-scope, --task-count, or an unknown flag.
 *   2 — config I/O error: an unreadable or unparseable config file.
 *
 * `--repo-root` is REQUIRED and is never filled from `SO_PROJECT_DIR`: the
 * library refuses that fallback for a measured reason (#941 — an ambient
 * destination put a synthetic record into the operator's real fleet ledger), and
 * a CLI that quietly supplied one would reinstate exactly what it refuses.
 *
 * A config file that EXISTS but cannot be read or parsed exits 2 — it carries
 * `agents-per-wave`, and guessing past an unreadable cap would publish a shape
 * with the wrong agent budget. A config file that is simply ABSENT is not an
 * error: the documented defaults apply and a WARN goes to stderr.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveInstructionFile } from './lib/common.mjs';
import { parseSessionConfig } from './lib/config.mjs';
import { resolveAndRecordSessionShape } from './lib/session-shape.mjs';

const USAGE = [
  'Usage: node scripts/session-shape.mjs --repo-root <path> --session-type <housekeeping|feature|deep>',
  '                                      [--profile ultradeep] [--known-scope true|false]',
  '                                      [--task-count <n>] [--config-file <path>] [--no-event]',
  '',
  '  --repo-root     REQUIRED  repo receiving the .orchestrator/metrics/events.jsonl record',
  '  --session-type  REQUIRED  housekeeping | feature | deep',
  '  --profile       optional  ultradeep (a wave-shape variant on top of --session-type deep)',
  '  --known-scope   optional  true|false; deep only — true drops the Discovery wave',
  '  --task-count    optional  agreed issue/task scope (non-negative integer), recorded only',
  '  --config-file   optional  defaults to SO_CONFIG_FILE, else CLAUDE.md / AGENTS.md under --repo-root',
  '  --no-event      optional  resolve without writing the ledger record (planning dry-run)',
  '',
  'stdout: one JSON line — the resolved shape',
  'Exit codes: 0 resolved, 1 input error, 2 config I/O error',
].join('\n');

/** User/input error — usage class. */
const EXIT_INPUT = 1;
/** System error — config could not be read or parsed. */
const EXIT_CONFIG_IO = 2;

/**
 * Write a diagnostic line to stderr. stdout carries the shape and nothing else
 * (`cli-design.md` § JSON-First).
 *
 * @param {string} message
 * @returns {void}
 */
function warn(message) {
  process.stderr.write(`session-shape: ${message}\n`);
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
 * The CLAUDE.md → AGENTS.md walk is `resolveInstructionFile()` in
 * `scripts/lib/common.mjs` — the SSOT for the instruction-file alias rule — and
 * is deliberately not re-implemented here. Only the `SO_CONFIG_FILE` override
 * that `scripts/parse-config.mjs` honours is layered on top, plus an explicit
 * `--config-file`, which wins outright. Anchoring at `repoRoot` rather than
 * walking up from cwd keeps a DIFFERENT repo's config out of this shape.
 *
 * @param {string} repoRoot
 * @param {string|undefined} explicit
 * @returns {string|null}
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
 * Read and parse the Session Config. Returns `undefined` when no config file
 * exists, so the library applies its documented defaults.
 *
 * @param {string|null} configFile
 * @returns {object|undefined}
 */
function loadConfig(configFile) {
  if (configFile === null) {
    warn('no CLAUDE.md / AGENTS.md under --repo-root; applying documented defaults');
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
 * Parse a boolean flag value. Strict on purpose: a typo'd `--known-scope yes`
 * silently meaning `false` would drop or keep a whole Discovery wave.
 *
 * @param {string|undefined} raw
 * @param {string} flag
 * @returns {boolean|undefined}
 */
function parseBoolFlag(raw, flag) {
  if (raw === undefined) return undefined;
  const value = String(raw).trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fail(`${flag} must be "true" or "false" (got: ${raw})`, EXIT_INPUT);
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
        profile: { type: 'string' },
        'known-scope': { type: 'string' },
        'task-count': { type: 'string' },
        'config-file': { type: 'string' },
        'no-event': { type: 'boolean' },
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

  const sessionType =
    typeof values['session-type'] === 'string' ? values['session-type'].trim() : '';
  if (sessionType === '') {
    fail(`--session-type is required\n\n${USAGE}`, EXIT_INPUT);
  }

  const profileArg = typeof values.profile === 'string' ? values.profile.trim() : '';
  const profile = profileArg === '' ? null : profileArg;

  const knownScope = parseBoolFlag(
    typeof values['known-scope'] === 'string' ? values['known-scope'] : undefined,
    '--known-scope',
  );

  let taskCount = null;
  const taskCountRaw = typeof values['task-count'] === 'string' ? values['task-count'].trim() : '';
  if (taskCountRaw !== '') {
    taskCount = Number(taskCountRaw);
    if (!Number.isInteger(taskCount) || taskCount < 0) {
      fail(`--task-count must be a non-negative integer (got: ${taskCountRaw})`, EXIT_INPUT);
    }
  }

  const configFile = resolveRepoConfigPath(
    repoRoot,
    typeof values['config-file'] === 'string' ? values['config-file'] : undefined,
  );
  const config = loadConfig(configFile);

  let shape;
  try {
    shape = await resolveAndRecordSessionShape({
      repoRoot,
      config,
      sessionType,
      profile,
      knownScope: knownScope === true,
      taskCount,
      emit: values['no-event'] !== true,
    });
  } catch (err) {
    // The library throws TypeError on an unknown session type or profile —
    // that is an INPUT error here, not a crash. Its message already carries the
    // `session-shape: ` prefix that `warn()` adds, so strip the inner one:
    // `session-shape: session-shape: unknown sessionType …` reads as a bug in
    // the tool rather than a typo in the flag.
    if (err instanceof TypeError) fail(err.message.replace(/^session-shape:\s*/, ''), EXIT_INPUT);
    throw err;
  }

  process.stdout.write(`${JSON.stringify(shape)}\n`);
}

// Entrypoint guard — importing this file must not run it (check-unwired-features S3).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    process.stderr.write(`session-shape: unexpected error: ${err?.stack ?? err}\n`);
    process.exit(EXIT_CONFIG_IO);
  });
}
