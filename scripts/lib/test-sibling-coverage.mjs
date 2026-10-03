#!/usr/bin/env node
/**
 * test-sibling-coverage.mjs — THE measurement behind the Test-Sibling Expansion
 * figures (#970) in skills/wave-executor/references/wave-loop-scope-manifest.md.
 *
 * ## Why this file exists
 *
 * The expansion grants a GLOB (`tests/**\/{basename}*.test.mjs`) instead of a
 * computed path, and the manifest justified that with three hand-measured counts
 * (439 / 375 / 272 at `730ee9d`). Those numbers lived in prose, went stale, and a
 * second contradicting copy appeared in a code comment (#1026.5, #1030 P3). Same
 * cure as `tests-src-ratio.mjs`: the recipe is code, the `--json` envelope
 * carries its own definition, and the docs point here instead of restating it.
 *
 * ## The recipe
 *
 *   universe     `git ls-files` (the index — tracked paths only)
 *   tests        tracked files matching DEFAULT_TEST_PATH_PATTERNS (scope-gate)
 *   production   tracked files matching a DEFAULT_TEST_SIBLING_RULES `source`
 *                that are NOT tests — defined by negation, so a new top-level
 *                directory is counted the moment it is committed
 *   glob         production files where a sibling glob from `testSiblingsFor()`
 *                matches a test via `pathMatchesPattern()` — the exact matcher
 *                the scope gate grants with, reused rather than re-derived
 *   exact        production files with a test under `tests/` whose basename is
 *                exactly `<stem>.test<ext>`
 *   mirror       production files whose 1:1 mirror exists: `tests/` + the path
 *                with a leading `scripts/` dropped, `<ext>` → `.test<ext>`
 *
 * By construction mirror ⊆ exact ⊆ glob ⊆ production, so the counts must obey
 * mirror ≤ exact ≤ glob ≤ total; a violation means a broken definition.
 *
 * Usage: test-sibling-coverage.mjs [<repo-root>] [--json]
 * Exit:  0 measured · 2 tool error (not a git repo, bad argument)
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';

import {
  DEFAULT_TEST_PATH_PATTERNS,
  DEFAULT_TEST_SIBLING_RULES,
  pathMatchesPattern,
  testSiblingsFor,
} from './scope-gate.mjs';
import { isMainModule } from './is-main-module.mjs';

/** Machine-readable schema tag for the --json envelope. */
export const SCHEMA = 'test-sibling-coverage/1';

const isTest = (p) => DEFAULT_TEST_PATH_PATTERNS.some((pat) => pathMatchesPattern(p, pat));
const isProduction = (p) =>
  !isTest(p) && DEFAULT_TEST_SIBLING_RULES.some((r) => pathMatchesPattern(p, r.source));

/** `scripts/lib/x.mjs` → { stem: 'x', ext: '.mjs' } */
function stemOf(p) {
  const ext = path.posix.extname(p);
  return { stem: path.posix.basename(p, ext), ext };
}

/** The 1:1 mirror path the manifest's "naive mirror" figure counts. */
export function mirrorPathOf(p) {
  const { ext } = stemOf(p);
  const rel = p.startsWith('scripts/') ? p.slice('scripts/'.length) : p;
  return `tests/${rel.slice(0, rel.length - ext.length)}.test${ext}`;
}

/**
 * Measure the three coverage counts over a path list. Pure.
 * @param {string[]} files — repo-relative POSIX paths
 * @returns {{total: number, glob: number, exact: number, mirror: number, uncovered: string[]}}
 */
export function measure(files) {
  const tests = files.filter(isTest);
  const testSet = new Set(tests);
  const testBasenames = new Set(tests.filter((t) => t.startsWith('tests/')).map((t) => path.posix.basename(t)));
  const production = files.filter(isProduction);
  let glob = 0;
  let exact = 0;
  let mirror = 0;
  const uncovered = [];
  for (const p of production) {
    const globs = testSiblingsFor([p]);
    // Linear scan of every test per glob — 0.3 s wall for the whole CLI at 571
    // production files (2026-10-03); revisit if the tracked test count passes ~5000.
    if (globs.some((g) => tests.some((t) => pathMatchesPattern(t, g)))) glob += 1;
    else uncovered.push(p);
    const { stem, ext } = stemOf(p);
    if (testBasenames.has(`${stem}.test${ext}`)) exact += 1;
    if (testSet.has(mirrorPathOf(p))) mirror += 1;
  }
  return { total: production.length, glob, exact, mirror, uncovered };
}

/** The self-describing definition block shipped inside every --json envelope. */
export function definition() {
  return {
    source: 'git ls-files (tracked paths only)',
    tests: `tracked paths matching scope-gate DEFAULT_TEST_PATH_PATTERNS: ${DEFAULT_TEST_PATH_PATTERNS.join(', ')}`,
    total: `production files: tracked paths matching a sibling-rule source (${DEFAULT_TEST_SIBLING_RULES.map((r) => r.source).join(', ')}) that are not tests`,
    glob: `production files where a scope-gate testSiblingsFor() glob (${DEFAULT_TEST_SIBLING_RULES.map((r) => r.sibling).join(', ')}) matches a test via pathMatchesPattern`,
    exact: 'production files with a test under tests/ whose basename is exactly <stem>.test<ext>',
    mirror: 'production files whose mirror tests/<path minus leading scripts/, <ext> -> .test<ext>> is tracked',
    invariant: 'mirror <= exact <= glob <= total',
  };
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

const pct = (n, d) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

function main(argv) {
  let json = false;
  let root = process.cwd();
  for (const a of argv) {
    if (a === '--json') json = true;
    else if (a.startsWith('--')) {
      process.stderr.write(`Unknown argument '${a}'. Usage: test-sibling-coverage.mjs [<repo-root>] [--json]\n`);
      return 2;
    } else root = path.resolve(a);
  }
  let files;
  let ref;
  let dirty;
  try {
    files = git(root, ['ls-files']).split('\n').filter(Boolean);
    ref = git(root, ['rev-parse', '--short', 'HEAD']).trim();
    // The index IS the measured population: only a staged add/delete/rename
    // makes (ref, counts) unreproducible. --no-optional-locks: no index refresh
    // under a parallel session (PSA-007).
    dirty = git(root, ['--no-optional-locks', 'diff', '--cached', '--name-only', '--diff-filter=ADR']).trim() !== '';
  } catch (error) {
    process.stderr.write(`ERROR: git failed in ${root}: ${error.message}\n`);
    return 2;
  }
  const r = measure(files);
  const envelope = {
    schema: SCHEMA,
    ref,
    dirty,
    measuredAt: new Date().toISOString().slice(0, 10),
    total: r.total,
    glob: r.glob,
    exact: r.exact,
    mirror: r.mirror,
    percent: { glob: pct(r.glob, r.total), exact: pct(r.exact, r.total), mirror: pct(r.mirror, r.total) },
    uncovered: r.uncovered,
    definition: definition(),
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    const line = (k) => `  ${k.padEnd(7)} ${String(r[k]).padStart(5)} / ${r.total}  (${envelope.percent[k]} %)`;
    process.stdout.write(
      `test-sibling coverage at ${ref}${dirty ? ' (index differs from HEAD)' : ''}, ${envelope.measuredAt}\n`
      + `${line('glob')}\n${line('exact')}\n${line('mirror')}\n`
      + `  uncovered by the glob: ${r.uncovered.length} (list: --json)\n`,
    );
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
