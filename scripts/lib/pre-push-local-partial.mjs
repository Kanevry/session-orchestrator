#!/usr/bin/env node
// Local partial pre-push gate (#1642): the route the hook takes when no remote host
// could run the full gate (router exit 10) AND the push goes to an origin MR branch.
// Exit 0 verified, 1 blocked, 10 not determinable (the hook then runs the full gate
// locally — fail-closed, same contract as LSO scripts/pre-push-gate.sh, Owner #801).
//
// It checks what this push changes since the merge-base with origin's default branch:
// `node --check` + ESLint on the changed source files and `vitest related` for them.
// The full suite runs in the MR pipeline on the pushed head SHA.
//
// CEILING (BV-004): `vitest related` follows the static import graph. A test that
// reaches a changed file only by spawning it (hooks, .husky/, CLIs run via
// spawnSync) or by reading it from disk (policy JSON, Markdown, fixtures — edited OR
// deleted) is not selected here; the MR pipeline is the net for that class. Only a
// deleted or renamed SOURCE file falls back to the full gate, because its importers
// break while nothing is left to select (#1643: falling back on every deletion would
// send each archive move of a doc to the full local suite).
// Revisit trigger: an MR pipeline red that a selected-by-path test would have caught
// locally on a push routed through this gate.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isMainModule } from './is-main-module.mjs';

const log = (message) => process.stderr.write(`pre-push: ${message}\n`);

/** Changed files that make a selection meaningless: they reconfigure every test or lint run. */
const FULL_SUITE_TRIGGERS = [/^package(-lock)?\.json$/, /^vitest\.config\.[cm]?[jt]s$/, /^eslint\.config\.[cm]?[jt]s$/];
const SOURCE_RE = /\.(mjs|cjs|js)$/;

function git(repoRoot, args) {
  // core.quotePath=false: git otherwise prints a non-ASCII path as "\303\244.mjs" (quoted,
  // escaped), and every suffix test below would miss it (#1643).
  const r = spawnSync('git', ['-C', repoRoot, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Merge-base of the pushed SHA with origin's default branch, or null when no
 * origin default ref resolves in the source repo (the materialised clone has none).
 */
export function resolveBase(repoRoot, sha) {
  const head = git(repoRoot, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
  for (const ref of [head, 'origin/main'].filter(Boolean)) {
    if (git(repoRoot, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]) === null) continue;
    return git(repoRoot, ['merge-base', sha, ref]) || null;
  }
  return null;
}

/** Runs one tool from the tree's own node_modules; null when the tool is not installed there. */
function runTool(tree, bin, args, timeout) {
  const path = join(tree, 'node_modules/.bin', bin);
  if (!existsSync(path)) return null;
  const r = spawnSync(process.execPath, [path, ...args], { cwd: tree, stdio: ['ignore', 2, 2], timeout });
  return r.status === 0 && !r.error;
}

async function emit(ledgerRoot, passed, fields) {
  try {
    const { emitEvent, sessionAttribution } = await import('./events.mjs');
    await emitEvent(`orchestrator.quality_gate.${passed ? 'passed' : 'failed'}`, {
      variant: 'local-partial', exit_code: passed ? 0 : 1, host: 'local', host_source: 'fallback',
      ...fields, ...sessionAttribution(ledgerRoot),
    }, { repoRoot: ledgerRoot });
  } catch { /* telemetry cannot change the blocking verdict */ }
}

export async function main(argv = process.argv.slice(2)) {
  const [tree, sha, repoRoot] = argv;
  if (!tree || !sha || !repoRoot) return 10;
  const base = resolveBase(repoRoot, sha);
  if (!base) {
    log('local partial gate: no merge-base with origin\'s default branch — full gate locally (fail-closed).');
    return 10;
  }
  // --no-renames: a rename reads as delete + add, so the old path stays visible.
  const diff = git(repoRoot, ['diff', '--name-only', '--no-renames', '--diff-filter=d', base, sha]);
  const deleted = git(repoRoot, ['diff', '--name-only', '--no-renames', '--diff-filter=D', base, sha]);
  if (diff === null || deleted === null) return 10;
  // A deleted or renamed module breaks its importers, and `vitest related` cannot
  // select tests for a file that no longer exists.
  const gone = deleted.split('\n').find((f) => SOURCE_RE.test(f));
  if (gone) {
    log(`local partial gate: ${gone} deleted or renamed — full gate locally (fail-closed).`);
    return 10;
  }
  const changed = diff.split('\n').filter(Boolean);
  const trigger = changed.find((f) => FULL_SUITE_TRIGGERS.some((re) => re.test(f)));
  if (trigger) {
    log(`local partial gate: ${trigger} changed — full gate locally (fail-closed).`);
    return 10;
  }
  const sources = changed.filter((f) => SOURCE_RE.test(f) && existsSync(join(tree, f)));
  log(`local partial gate: ${changed.length} changed file(s) since ${base.slice(0, 12)}; the full suite runs in the MR pipeline on ${sha.slice(0, 12)} (#1642).`);
  const fields = { pushed_sha: sha, base_sha: base, changed_count: changed.length };
  if (changed.length === 0) {
    await emit(repoRoot, true, fields);
    return 0;
  }
  const syntaxFailed = sources.filter((f) =>
    spawnSync(process.execPath, ['--check', f], { cwd: tree, stdio: ['ignore', 2, 2], timeout: 30_000 }).status !== 0);
  if (syntaxFailed.length) log(`local partial gate: node --check failed: ${syntaxFailed.join(', ')}`);
  const lint = sources.length ? runTool(tree, 'eslint', ['--no-warn-ignored', ...sources], 300_000) : true;
  const test = runTool(tree, 'vitest', ['related', '--run', '--passWithNoTests', ...changed], 900_000);
  if (lint === null || test === null) {
    log('local partial gate: eslint or vitest missing in node_modules — full gate locally (fail-closed).');
    return 10;
  }
  const passed = syntaxFailed.length === 0 && lint && test;
  const failedChecks = [syntaxFailed.length && 'typecheck', !lint && 'lint', !test && 'test'].filter(Boolean);
  await emit(repoRoot, passed, { ...fields, ...(failedChecks.length ? { failed_checks: failedChecks } : {}) });
  log(`local partial gate ${passed ? 'passed' : 'FAILED — Push blocked'}.`);
  return passed ? 0 : 1;
}

if (isMainModule(import.meta.url)) process.exitCode = await main();
