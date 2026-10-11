#!/usr/bin/env node
/**
 * parse-config.mjs — Parse ## Session Config from CLAUDE.md or AGENTS.md and output validated JSON.
 * Part of Session Orchestrator v3.0.0 (originally parse-config.sh in v2).
 *
 * Usage: node scripts/parse-config.mjs [--json] [path/to/CLAUDE.md|AGENTS.md]
 *   If no path given, walks up from cwd to find project root and uses its CLAUDE.md (or AGENTS.md).
 *
 * Output: Single JSON object to stdout with ALL config fields (defaults applied).
 *   `--json` is an explicit NO-OP alias for that default — accepted because
 *   `docs/session-config-template.md` ("How to use" and "Validation &
 *   Bootstrap") documents `node scripts/parse-config.mjs --json` as THE
 *   validation command, and the flag used to be swallowed by the
 *   positional-path slot and rejected with `File not found: --json` (exit 1).
 *   `cli-design.md` § JSON-First Output also requires every CLI to accept
 *   `--json`.
 * Exit codes: 0 success, 1 error (message to stderr)
 *
 * Unparsable lines inside `## Session Config` (#1097) are reported per line on
 * stderr under `enforcement: warn` (the default) and refuse the run under
 * `enforcement: strict`; `off` is silent. stdout is unchanged for any
 * well-formed block — a warning never alters the emitted JSON.
 *
 * Unknown top-level keys (#1562) — a key the plugin's own
 * `docs/session-config-template.md` does not document, i.e. a typo or a key
 * from a newer plugin version — are reported per line on stderr under `warn`
 * AND `strict` (a report, never a refusal); `off` is silent. stdout unchanged.
 *
 * Environment:
 *   SO_CONFIG_FILE             — override filename (e.g. "AGENTS.md") resolved from project root
 *   SO_SKIP_CONFIG_VALIDATION  — set to "1" to bypass validate-config.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve, parse as parsePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSessionConfig } from './lib/config.mjs';
import { collectUnparsableLines, collectTopLevelKeyLines } from './lib/config/section-extractor.mjs';
import { knownTemplateKeys } from './lib/config/template-keys.mjs';
import { findUnterminatedComment } from './lib/config/block-preprocess.mjs';
import { ENFORCEMENT_VALUES } from './lib/config-schema.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Project-root resolution (walk up from cwd until .git / CLAUDE.md / AGENTS.md)
// ---------------------------------------------------------------------------

function findProjectRoot(startDir) {
  let dir = resolve(startDir);
  const { root } = parsePath(dir);

  while (true) {
    if (
      existsSync(join(dir, '.git')) ||
      existsSync(join(dir, 'CLAUDE.md')) ||
      existsSync(join(dir, 'AGENTS.md'))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir || dir === root) {
      // Reached filesystem root without finding a project root — return cwd
      return resolve(startDir);
    }
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Config file resolution (mirrors parse-config.sh lines 31-47)
// ---------------------------------------------------------------------------

function resolveConfigFile(argPath) {
  if (argPath) {
    const abs = resolve(argPath);
    if (!existsSync(abs)) {
      process.stderr.write(`parse-config.mjs: File not found: ${argPath}\n`);
      process.exit(1);
    }
    return abs;
  }

  const projectRoot = findProjectRoot(process.cwd());
  const soConfigFile = process.env.SO_CONFIG_FILE;

  if (soConfigFile) {
    const candidate = join(projectRoot, soConfigFile);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const claudeMd = join(projectRoot, 'CLAUDE.md');
  if (existsSync(claudeMd)) {
    return claudeMd;
  }

  const agentsMd = join(projectRoot, 'AGENTS.md');
  if (existsSync(agentsMd)) {
    return agentsMd;
  }

  process.stderr.write('parse-config.mjs: CLAUDE.md or AGENTS.md required\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main — argument parsing
// ---------------------------------------------------------------------------
//
// Exactly two recognised flags plus one optional positional path. `--json` is
// accepted and IGNORED: stdout is already a single JSON object, and the
// documented validation command passes the flag. Anything else starting with
// `-` is rejected rather than silently treated as a filename, so a typo cannot
// masquerade as a missing file.

const HELP_TEXT = `Usage: parse-config.mjs [--json] [path/to/CLAUDE.md|AGENTS.md]

Parse the \`## Session Config\` block from CLAUDE.md (or AGENTS.md) and write
the validated config to stdout as a single JSON object.

Options:
  --json     No-op alias for the default output (stdout is always JSON).
  --help     Show this help and exit 0.

Without a path, walks up from cwd to the project root and uses its CLAUDE.md,
falling back to AGENTS.md. Exit codes: 0 success, 1 error (message on stderr).
`;

let argPath = null;
for (const arg of process.argv.slice(2)) {
  if (arg === '--help' || arg === '-h') {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  } else if (arg === '--json') {
    // no-op — the default output already IS JSON
  } else if (arg.startsWith('-')) {
    process.stderr.write(`parse-config.mjs: Unknown option: ${arg}\n\n${HELP_TEXT}`);
    process.exit(1);
  } else if (argPath === null) {
    argPath = arg;
  } else {
    process.stderr.write(`parse-config.mjs: Unexpected extra argument: ${arg}\n\n${HELP_TEXT}`);
    process.exit(1);
  }
}

const configFile = resolveConfigFile(argPath);

let content;
try {
  content = readFileSync(configFile, 'utf8');
} catch (err) {
  process.stderr.write(`parse-config.mjs: Failed to read ${configFile}: ${err.message}\n`);
  process.exit(1);
}

// Unterminated-comment gate — ONE line per session, not one per parser.
// An `<!--` with no `-->` after it would put the shared HTML-comment skipper in
// the swallowing state for the rest of the document; `stripHtmlCommentBlocks`
// now fails CLOSED (returns the lines unfiltered) rather than letting every
// later block disappear into its defaults, but the operator still has to learn
// that the document has a defect. This is the surface that says so — never
// fatal, exit code unchanged.
const unterminatedCommentLine = findUnterminatedComment(content.split(/\r?\n/));
if (unterminatedCommentLine !== null) {
  process.stderr.write(
    `⚠ ${parsePath(configFile).base}: unterminated <!-- at line ${unterminatedCommentLine} — comment stripping disabled for the whole document\n`,
  );
}

let config;
try {
  config = parseSessionConfig(content);
} catch (err) {
  process.stderr.write(`parse-config.mjs: Parse error: ${err.message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Unparsable-line gate (#1097) — never a silent default
// ---------------------------------------------------------------------------
//
// A line inside `## Session Config` that no parser can read is simply absent
// from the KV map, and every consumer then applies its own default — `false`
// for the booleans. A broken key therefore reads exactly like a deliberately
// disabled feature, in every log, forever. This gate is the only place that
// difference is ever stated out loud.
//
// It runs BEFORE the validator so a malformed block is reported in terms of the
// FILE (line number + text) rather than in terms of the defaults it silently
// produced. `off` stays silent by definition — that is what turning enforcement
// off means; `warn` (the default) reports and proceeds; `strict` refuses.

const unparsableLines = collectUnparsableLines(content);

// Belt-and-braces, not a live branch: `parseSessionConfig` already REFUSES
// an out-of-vocabulary enforcement value above (measured: `enforcement:
// banana` exits 1 with "must be strict|warn|off" and never reaches here), so
// `config.enforcement` is one of the three by the time this line runs. The
// fallback exists for the direction that matters if that ever loosens — an
// unknown value must degrade to `warn`, never arm the `strict` refusal.
const enforcement = ENFORCEMENT_VALUES.has(config.enforcement) ? config.enforcement : 'warn';

if (unparsableLines.length > 0) {
  if (enforcement !== 'off') {
    // Ceiling: 20 named lines. A whole prose section pasted into the block is
    // one defect, not 200, and the strict path below exits immediately after
    // writing — Node's stderr is async on a pipe, so an unbounded list is the
    // write-then-exit truncation class this repo has already paid for once.
    // Revisit if a legitimate config block ever carries >20 broken lines.
    const SHOWN = 20;
    for (const { line, text } of unparsableLines.slice(0, SHOWN)) {
      process.stderr.write(
        `parse-config.mjs: WARN unparsable Session Config line ${line}: ${text}\n`,
      );
    }
    if (unparsableLines.length > SHOWN) {
      process.stderr.write(
        `parse-config.mjs: WARN … and ${unparsableLines.length - SHOWN} more unparsable line(s)\n`,
      );
    }
    process.stderr.write(
      `parse-config.mjs: ${unparsableLines.length} unparsable line(s) in ${configFile} — ` +
        'those keys fall back to their defaults, which for booleans is `false`.\n',
    );
  }

  if (enforcement === 'strict') {
    process.stderr.write(
      'parse-config.mjs: enforcement: strict — refusing to emit config parsed from an ' +
        'unparsable Session Config block.\n',
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Unknown-key report (#1562) — a typo'd key is not a silent default either
// ---------------------------------------------------------------------------
//
// A well-formed line with a mis-spelled key (`persistance: true`) parses
// cleanly, so the gate above never sees it: the key lands in the KV map under a
// name nothing reads, and the real key keeps its default. The population of
// known keys is the plugin's OWN template (first + last `## Session Config`
// block, the population drift-check Check 6 reads) plus every top-level key
// `parseSessionConfig()` emits, so it moves with the plugin version, never
// with the repo.
//
// A report, never a refusal — even under `strict`: a key from a newer plugin
// version is not a defect of the repo. Three states stay apart on purpose:
// measured with findings (one line per key), measured clean (silence), and NOT
// measured (one line saying why) — "the check could not run" must never read
// like "no unknown keys".

if (enforcement !== 'off') {
  const templatePath = join(SCRIPT_DIR, '..', 'docs', 'session-config-template.md');
  let known = null;
  let notRunReason = null;
  try {
    known = knownTemplateKeys(readFileSync(templatePath, 'utf8'));
    if (!known) notRunReason = 'it has no distinct starter and opt-in `## Session Config` blocks';
    // A key the parser itself emits is read, wherever the template documents it:
    // `skill-evolution` and `dispatcher-autonomy` are parsed from the whole file
    // (their parity-exempt template blocks sit outside `## Session Config`), so
    // the same key inside the block is applied and must not read "no effect".
    else for (const key of Object.keys(config)) known.add(key);
  } catch (err) {
    notRunReason = err.code === 'ENOENT' ? 'it was not found' : `it could not be read (${err.code ?? err.message})`;
  }

  if (notRunReason) {
    process.stderr.write(
      `⚠ parse-config.mjs: unknown Session Config key check did not run — ${templatePath}: ${notRunReason}\n`,
    );
  } else {
    const configName = parsePath(configFile).base;
    for (const { line, key } of collectTopLevelKeyLines(content)) {
      if (known.has(key)) continue;
      process.stderr.write(
        `⚠ ${configName}:${line}: unknown Session Config key '${key}' — not in docs/session-config-template.md ` +
          '(a typo, or a key from a newer plugin version); it has no effect\n',
      );
    }
  }
}

// jq -n produces pretty-printed JSON without a trailing newline — match that format
const assembledJson = JSON.stringify(config, null, 2);

// ---------------------------------------------------------------------------
// Validation gate (mirrors parse-config.sh lines 281-286)
// ---------------------------------------------------------------------------

const validatorPath = join(SCRIPT_DIR, 'validate-config.mjs');
const skipValidation = process.env.SO_SKIP_CONFIG_VALIDATION === '1';

if (!skipValidation && existsSync(validatorPath)) {
  // Use spawnSync so we can capture both stdout and stderr regardless of exit code
  const result = spawnSync('node', [validatorPath], {
    input: assembledJson,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.error) {
    process.stderr.write(`parse-config.mjs: Failed to run validator: ${result.error.message}\n`);
    process.exit(1);
  }

  // Relay validator stderr (warnings or errors) to our stderr
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    // strict enforcement: validator exited non-zero → suppress stdout, exit 1
    process.exit(1);
  }

  // Emit whatever the validator wrote to stdout (validate-config.mjs passes through raw input)
  process.stdout.write(result.stdout);
} else {
  // Match jq -n output: no trailing newline
  process.stdout.write(assembledJson);
}
