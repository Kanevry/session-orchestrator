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

// FAIL-capable from day one: every rule this check enforces (frontmatter present,
// parses as YAML, kebab-case name matching the directory, non-empty description)
// was measured at 0 violations across all 46 SKILL.md files at the commit that
// added it — so unlike the WARN-only censuses further down, it cannot be red on
// arrival. It sits next to check-commands.mjs because it shares that check's
// posture: a real js-yaml parse, not the line-regex approach of check-agents.mjs
// that let 12 unparseable SKILL.md frontmatter blocks go unnoticed.
process.stdout.write('\n');
if (runCheck('check-skills.mjs') !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runDriftCheck() !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runCheck('check-hooks-symmetry.mjs') !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runCheck('check-guard-requires-parity.mjs') !== 0) checkFailed = 1;

process.stdout.write('\n');
if (runCheck('check-banner-parity.mjs') !== 0) checkFailed = 1;

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

// FAIL-capable, unlike the WARN-only censuses below: R2+R4 were measured at
// 1 hit / 1 TP / 0 FP each against the full test corpus, so this check cannot be
// red on arrival for anything but a real instance of the class. The alternatives
// (R1 at 67 FP, R3 at 47 FP) are exactly the shape that gets demoted to WARN and
// then ignored — see the rule table in the check's header.
process.stdout.write('\n');
if (runCheck('check-untracked-test-deps.mjs') !== 0) checkFailed = 1;

// WARN-only (v1): the unwired-config-key census reports but never fails the
// build — see the rationale in the check's header (a blocking gate on today's
// inventory would be red from day one and get disabled). Exit code is
// deliberately ignored; only a tool error (2) would be worth escalating later.
process.stdout.write('\n');
runCheck('check-unwired-features.mjs');

// WARN-only (#1017), same rationale as the census above: 11 of 13 provenance
// pointers in .claude/rules/ dangle at the time this check landed, so a blocking
// gate would be red on arrival. The exit code is deliberately ignored; a tool
// error still surfaces because that path prints FAIL: lines, which runCheck
// tallies into totalFail.
process.stdout.write('\n');
runCheck('check-learning-provenance.mjs');

// WARN-only (#971), same rationale as the two censuses above: a `gh`/`glab` call
// without `--repo`/`-R` resolves its target project from the ambient cwd remote —
// silently the wrong project in a sibling worktree, an /autopilot child, or a repo
// whose origin is a fork — and a gate that blocks on a backlog no single pass can
// drain gets switched off rather than obeyed. What WARN buys is that each newly
// added bare call site shows up in every validator run while the sweep drains the
// rest. No headcount is quoted here on purpose: the live number moves with every
// commit, and only the check's own `--json` summary can state it as of a SHA. The
// exit code is deliberately ignored; a tool error still surfaces because that path
// prints FAIL: lines, which runCheck tallies into totalFail.
process.stdout.write('\n');
runCheck('check-vcs-repo-flag.mjs');

// WARN-only (#1023): a `gh`/`glab` command cited in docs that no released CLI
// ever had — `glab repo edit --visibility`, `glab group list` — costs an
// operator a failed command and a re-derivation. The oracle is the CLI's own
// `--help` COMMANDS section, never an exit code (`glab repo <anything> --help`
// exits 0). WARN rather than FAIL because that oracle is the LOCALLY installed
// binary: a version skew must not red an unrelated commit, and a missing binary
// SKIPs. The exit code is deliberately ignored; a tool error still surfaces
// because that path prints FAIL: lines, which runCheck tallies into totalFail.
process.stdout.write('\n');
runCheck('check-doc-cli-commands.mjs');

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
