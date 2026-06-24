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
const DRIFT_CHECKER = path.join(SCRIPT_DIR, '..', 'skills', 'claude-md-drift-check', 'checker.mjs');

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

/**
 * Run the surface-count drift family (issue #663) from the claude-md-drift-check
 * checker over the doc surfaces that carry artifact counts (README.md +
 * .orchestrator/steering/structure.md). The checker emits JSON; this adapter
 * translates surface-count drift into validate-plugin's line vocabulary.
 *
 * The family covers: command / skill / agent / hook-event / hook-matcher / test
 * counts. The checker runs in `warn` mode (it never exits non-zero on drift);
 * THIS adapter decides the gate. Drift is reported as a `WARN:` line that does
 * NOT increment the failure tally — surface-count drift in docs is advisory at
 * the validate-plugin gate (it would otherwise red the whole build on a single
 * stale prose number that any contributor can land). The hard-fail contract
 * lives in the checker itself (`--mode hard` → exit 1), exercised by the
 * regression suite. A genuine infra/parse failure of the checker DOES fail.
 *
 * @returns {number} 0 always for drift (advisory); 1 only on checker infra/parse failure.
 */
function runDriftCheck() {
  console.log('--- Check: surface-count drift (command/skill/agent/hook/test) ---');
  const result = spawnSync(
    'node',
    [
      DRIFT_CHECKER,
      '--mode', 'warn',
      '--include-path', 'README.md',
      '--include-path', '.orchestrator/steering/structure.md',
      '--skip-path-resolver',
      '--skip-project-count',
      '--skip-issue-refs',
      '--skip-session-files',
      '--skip-session-config-parity',
      '--skip-vault-dir-parity',
    ],
    {
      cwd: PLUGIN_ROOT,
      env: { ...process.env, VAULT_DIR: PLUGIN_ROOT },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  // Infra failure (exit 2) — surface the stderr and count one fail.
  if (result.status === 2) {
    console.log(`  FAIL: drift checker infra-error: ${(result.stderr || '').trim()}`);
    totalFail += 1;
    return 1;
  }

  let parsed;
  try {
    const line = (result.stdout || '').trim().split('\n').find((l) => l.startsWith('{'));
    parsed = JSON.parse(line);
  } catch {
    console.log('  FAIL: drift checker produced no parseable JSON output');
    totalFail += 1;
    return 1;
  }

  // Only surface-count-family errors are relevant here (other checks are skipped).
  const SURFACE_IDS = new Set([
    'command-count', 'skill-count', 'agent-count',
    'hook-event-count', 'hook-matcher-count', 'test-count',
  ]);
  const driftErrors = (parsed.errors || []).filter((e) => SURFACE_IDS.has(e.check));
  const ranSurfaces = (parsed.checks_run || []).filter((c) => SURFACE_IDS.has(c));

  if (driftErrors.length === 0) {
    console.log(`  PASS: surface counts in sync (${ranSurfaces.length} surface(s) checked: ${ranSurfaces.join(', ') || 'none claimed'})`);
    totalPass += 1;
    return 0;
  }

  // Advisory: report drift as WARN lines (do NOT increment the failure tally).
  console.log(`  PASS: surface-count drift check ran (${ranSurfaces.length} surface(s) checked)`);
  totalPass += 1;
  for (const e of driftErrors) {
    console.log(`  WARN: [${e.check}] ${e.file}:${e.line} — ${e.message}`);
  }
  return 0;
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
if (runDriftCheck() !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runCheck('check-hooks-symmetry.mjs') !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runCheck('check-playwright-mcp-canary.mjs') !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runCheck('check-peekaboo-driver-canary.mjs') !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runCheck('check-path-utils-canary.mjs') !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runCheck('check-codex-plugin.mjs') !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runCheck('check-pi-package.mjs') !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runCheck('check-pi-prompts.mjs') !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runCheck('check-session-plan-routing.mjs') !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runCheck('check-plugin-monitors.mjs') !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runCheck('check-plugin-schema.mjs') !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runCheck('check-owner-leakage.mjs') !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runCheck('check-rules.mjs') !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runCheck('check-unicode-safety.mjs') !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runCheck('check-dead-bridge.mjs') !== 0) checkFailed = 1;

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
