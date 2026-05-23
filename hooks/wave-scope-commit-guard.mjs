#!/usr/bin/env node
// hooks/wave-scope-commit-guard.mjs
//
// PSA-004 sub-mode B guard: runs at pre-commit time (AFTER lint-staged
// re-stages files) and rejects the commit if any staged path lies outside
// the active wave-scope.json allowedPaths.
//
// Why: lint-staged's eslint --fix / prettier --write step touches files
// that match its globs in package.json (not just the agent's staged set)
// and re-stages them via internal `git add`. PreToolUse Edit/Write gates
// never see these files. This guard catches them at the very last moment
// before the commit object is created.
//
// Behavior:
//   - If no .orchestrator/wave-scope.json exists, exit 0 (no active wave).
//   - Reads `git diff --cached --name-only`, validates each staged path
//     against allowedPaths globs from wave-scope.json.
//   - If any path is outside, exit 1 with a structured error listing
//     the violating paths and a hint to use `git restore --staged <path>`.
//
// SCOPE NOTE: This guard covers PSA-004 sub-mode B (lint-staged sweep).
// Sub-mode C (concurrent `git add` from two agents on the same repo)
// requires a staging-fence + mutex layer and is tracked separately —
// see #495 issue body and the follow-up issue filed by this session.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Re-use existing helpers from scripts/lib/hardening.mjs.
// IMPORTANT: import is resolved relative to THIS file's location (the hook
// ships with the session-orchestrator package), NOT relative to the git
// repo it is protecting. The two diverge when the hook is invoked from a
// consumer repo or a test tmp-dir.
import { pathMatchesPattern } from '../scripts/lib/hardening.mjs';

const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const scopePath = join(repoRoot, '.orchestrator', 'wave-scope.json');

if (!existsSync(scopePath)) {
  // No active wave — nothing to guard.
  process.exit(0);
}

let scope;
try {
  scope = JSON.parse(readFileSync(scopePath, 'utf8'));
} catch (err) {
  process.stderr.write(`wave-scope-commit-guard: failed to parse wave-scope.json: ${err.message}\n`);
  process.exit(1);
}

const allowedPaths = Array.isArray(scope.allowedPaths) ? scope.allowedPaths : [];
if (allowedPaths.length === 0) {
  process.exit(0); // Empty scope → no-op (matches the documented permissive default).
}

const stagedOutput = execSync('git diff --cached --name-only', { encoding: 'utf8' });
const stagedFiles = stagedOutput.split('\n').filter(Boolean);

const violations = stagedFiles.filter(
  (f) => !allowedPaths.some((pattern) => pathMatchesPattern(f, pattern)),
);

if (violations.length > 0) {
  process.stderr.write('✗ wave-scope-commit-guard: staged paths outside wave-scope.allowedPaths:\n');
  for (const v of violations) process.stderr.write(`  - ${v}\n`);
  process.stderr.write('\nThese files were likely added by lint-staged eslint --fix / prettier --write.\n');
  process.stderr.write('To proceed:\n');
  process.stderr.write('  1) git restore --staged <path>   # for each foreign path\n');
  process.stderr.write('  2) git commit                    # retry\n');
  process.exit(1);
}

process.exit(0);
