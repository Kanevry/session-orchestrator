#!/usr/bin/env node
/**
 * parse-config.mjs — Parse ## Session Config from CLAUDE.md or AGENTS.md and output validated JSON.
 * Part of Session Orchestrator v3.0.0 (originally parse-config.sh in v2).
 *
 * Usage: node scripts/parse-config.mjs [path/to/CLAUDE.md|AGENTS.md]
 *   If no path given, walks up from cwd to find project root and uses its CLAUDE.md (or AGENTS.md).
 *
 * Output: Single JSON object to stdout with ALL config fields (defaults applied).
 * Exit codes: 0 success, 1 error (message to stderr)
 *
 * Unparsable lines inside `## Session Config` (#1097) are reported per line on
 * stderr under `enforcement: warn` (the default) and refuse the run under
 * `enforcement: strict`; `off` is silent. stdout is unchanged for any
 * well-formed block — a warning never alters the emitted JSON.
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
import { collectUnparsableLines } from './lib/config/section-extractor.mjs';
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
// Main
// ---------------------------------------------------------------------------

const argPath = process.argv[2] ?? null;
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

if (unparsableLines.length > 0) {
  // Belt-and-braces, not a live branch: `parseSessionConfig` already REFUSES
  // an out-of-vocabulary enforcement value above (measured: `enforcement:
  // banana` exits 1 with "must be strict|warn|off" and never reaches here), so
  // `config.enforcement` is one of the three by the time this line runs. The
  // fallback exists for the direction that matters if that ever loosens — an
  // unknown value must degrade to `warn`, never arm the `strict` refusal.
  const enforcement = ENFORCEMENT_VALUES.has(config.enforcement) ? config.enforcement : 'warn';

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
