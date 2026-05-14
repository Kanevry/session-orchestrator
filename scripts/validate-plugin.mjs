#!/usr/bin/env node
/**
 * validate-plugin.mjs — Validate plugin structure against the Claude Code Plugin API.
 * Port of validate-plugin.sh (issue #218).
 *
 * Usage:
 *   node scripts/validate-plugin.mjs [<plugin-root>]
 *
 * If <plugin-root> is omitted, uses `git rev-parse --show-toplevel`.
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more validation failures
 *
 * Sub-scripts in scripts/lib/validate/ are NOT reimplemented here — they are
 * spawned via child_process so that check logic stays in a single place.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { die, requireJq } from './lib/common.mjs';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VALIDATE_DIR = path.join(SCRIPT_DIR, 'lib', 'validate');

// Require jq (same gate as validate-plugin.sh's require_jq)
try {
  requireJq();
} catch (/** @type {unknown} */ e) {
  die(/** @type {Error} */ (e).message);
}

// Resolve plugin root
let PLUGIN_ROOT;
if (process.argv[2]) {
  PLUGIN_ROOT = path.resolve(process.argv[2]);
} else {
  const gitResult = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (gitResult.status !== 0) {
    die('Not inside a git repository');
  }
  PLUGIN_ROOT = gitResult.stdout.trim();
}

// ---------------------------------------------------------------------------
// Check runner — mirrors run_check() in validate-plugin.sh
// ---------------------------------------------------------------------------

let totalPass = 0;
let totalFail = 0;

/**
 * Run a single sub-script from scripts/lib/validate/.
 * Returns the exit code of the sub-script (0 = all checks passed, 1 = failure).
 *
 * @param {string} script - basename of the .mjs file (e.g. "check-plugin-json.mjs")
 * @returns {number} exit code
 */
function runCheck(script) {
  const result = spawnSync('node', [path.join(VALIDATE_DIR, script), PLUGIN_ROOT], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const combined = (result.stdout ?? '') + (result.stderr ?? '');

  // Print output, stripping the per-helper "Results: " summary line
  // (orchestrator emits one final tally)
  const lines = combined.split('\n');
  const filtered = lines.filter((l) => !/^Results: /.test(l));
  // Trim trailing blank lines that result from stripping the Results line
  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === '') {
    filtered.pop();
  }
  if (filtered.length > 0) {
    process.stdout.write(filtered.join('\n') + '\n');
  }

  // Accumulate pass/fail counts from the sub-script output
  const passMatches = combined.match(/^[ ]{2}PASS:/gm);
  const failMatches = combined.match(/^[ ]{2}FAIL:/gm);
  totalPass += passMatches ? passMatches.length : 0;
  totalFail += failMatches ? failMatches.length : 0;

  return result.status ?? 1;
}

// ---------------------------------------------------------------------------
// Run all checks — same order as validate-plugin.sh
// plugin.json checks are prerequisite; abort early if they fail.
// ---------------------------------------------------------------------------

let checkFailed = 0;

const pluginJsonRc = runCheck('check-plugin-json.mjs');
if (pluginJsonRc !== 0) {
  checkFailed = 1;
  process.stdout.write('\n');
  process.stdout.write('===========================================\n');
  process.stdout.write(`  Results: ${totalPass} passed, ${totalFail} failed\n`);
  process.stdout.write('===========================================\n');
  process.exit(1);
}

process.stdout.write('\n');
if (runCheck('check-component-paths.mjs') !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runCheck('check-json-files.mjs') !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runCheck('check-agents.mjs') !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runCheck('check-commands.mjs') !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runCheck('check-hooks-symmetry.mjs') !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runCheck('check-playwright-mcp-canary.mjs') !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runCheck('check-peekaboo-driver-canary.mjs') !== 0) checkFailed = 1;

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write('\n');
process.stdout.write('===========================================\n');
process.stdout.write(`  Results: ${totalPass} passed, ${totalFail} failed\n`);
process.stdout.write('===========================================\n');

if (checkFailed > 0 || totalFail > 0) {
  process.exit(1);
}
process.exit(0);
