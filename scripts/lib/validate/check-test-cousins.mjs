#!/usr/bin/env node
/**
 * check-test-cousins.mjs — report NEWLY ADDED test files whose basename is
 * already taken by a tracked test file (a "test cousin"). #1030 item 2b.
 *
 * THE CLASS. A coordinator put guessed test paths into wave plans; agents then
 * created `tests/lib/validate/check-agents.test.mjs` next to the tracked
 * `tests/scripts/validate/check-agents.test.mjs` (same for `check-commands`).
 * The acceptance run went against the wrong suite and 4 failures surfaced only
 * in the full gate. `.claude/rules/test-value.md` § TV-004 asks for a `rg`
 * before writing a test; this is the mechanical reminder.
 *
 * WHY ONLY NEW FILES. The corpus already holds legitimate duplicate basenames
 * (~33 at 2026-11-10, 77 files; `scripts/lib/test-sibling-coverage.mjs`), so a
 * whole-tree check would be red on day one. Only files this change ADDS are
 * judged: staged adds (default), plus untracked files with `--untracked`.
 * A modified file with a duplicate basename is never reported.
 *
 * WARN-ONLY. Exit 0 whenever the scan completed; `--strict` turns a finding
 * into exit 1 for a human or a wave gate. It is deliberately NOT wired into
 * `scope-gate.mjs` / `enforce-scope.mjs` (hook-safe: no filesystem census in
 * the hot path) — only into the `.husky/pre-commit` advisory stage.
 *
 * "Test file" = matches scope-gate DEFAULT_TEST_PATH_PATTERNS (the one test
 * path definition) AND its basename carries `.test.` / `.spec.`; fixtures and
 * helpers under `tests/` share generic basenames (`index.mjs`) legitimately.
 *
 * Usage: check-test-cousins.mjs [<repo-root>] [--untracked] [--stdin] [--json] [--strict]
 *   --untracked  also treat `git ls-files --others --exclude-standard` as new
 *   --stdin      read the new-file list (newline-separated) from stdin instead
 *                of `git diff --cached --diff-filter=A` (the hook pre-filters)
 * Exit: 0 scan completed · 1 finding under --strict · 2 tool error
 *
 * @module scripts/lib/validate/check-test-cousins
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';

import { DEFAULT_TEST_PATH_PATTERNS, pathMatchesPattern } from '../scope-gate.mjs';
import { isMainModule } from '../is-main-module.mjs';
import { execFileSync } from '../native-command.mjs';

const MAX_SHOWN = 3;
const TEST_NAME_RE = /\.(?:test|spec)\.[^./]+$/;

/** @param {string} p repo-relative POSIX path */
export function isTestFile(p) {
  return TEST_NAME_RE.test(path.posix.basename(p)) && DEFAULT_TEST_PATH_PATTERNS.some((pat) => pathMatchesPattern(p, pat));
}

/**
 * Pure. For every new test file, the OTHER test files in `tracked` sharing its basename.
 * `tracked` may already contain the new files (staged adds are in the index); a file is
 * never its own cousin.
 * @param {string[]} newFiles
 * @param {string[]} tracked
 * @returns {{file: string, cousins: string[]}[]}
 */
export function findTestCousins(newFiles, tracked) {
  const byBase = new Map();
  for (const t of tracked) {
    if (!isTestFile(t)) continue;
    const b = path.posix.basename(t);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(t);
  }
  const out = [];
  for (const f of new Set(newFiles)) {
    if (!isTestFile(f)) continue;
    const cousins = (byBase.get(path.posix.basename(f)) ?? []).filter((t) => t !== f);
    if (cousins.length > 0) out.push({ file: f, cousins });
  }
  return out;
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}
const lines = (s) => s.split('\n').filter(Boolean);

const USAGE = 'Usage: check-test-cousins.mjs [<repo-root>] [--untracked] [--stdin] [--json] [--strict]';

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const known = new Set(['--untracked', '--stdin', '--json', '--strict']);
  const bad = [...flags].find((f) => !known.has(f));
  const positionals = argv.filter((a) => !a.startsWith('--'));
  if (bad || positionals.length > 1) {
    process.stderr.write(`${bad ? `Unknown flag: ${bad}\n` : 'At most one <repo-root>\n'}${USAGE}\n`);
    return 2;
  }
  const root = path.resolve(positionals[0] ?? process.cwd());
  let newFiles;
  let tracked;
  try {
    if (flags.has('--stdin')) newFiles = lines(readFileSync(0, 'utf8'));
    else newFiles = lines(git(root, ['-c', 'core.quotePath=false', 'diff', '--cached', '--name-only', '--diff-filter=A']));
    if (flags.has('--untracked')) newFiles.push(...lines(git(root, ['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard'])));
    tracked = lines(git(root, ['-c', 'core.quotePath=false', 'ls-files']));
  } catch (error) {
    process.stderr.write(`ERROR: git failed in ${root}: ${error.message}\n`);
    return 2;
  }
  const findings = findTestCousins(newFiles, tracked);
  if (flags.has('--json')) {
    process.stdout.write(`${JSON.stringify({ schema: 'check-test-cousins/1', findings }, null, 2)}\n`);
  } else {
    for (const { file, cousins } of findings) {
      // Capped: thousands of same-named adds must not print every cousin each (--json keeps the full list).
      const shown = cousins.slice(0, MAX_SHOWN).join(', ');
      const more = cousins.length > MAX_SHOWN ? ` (+${cousins.length - MAX_SHOWN} more)` : '';
      process.stderr.write(`⚠ test-cousin: new ${file} shares its basename with tracked ${shown}${more}\n`);
      process.stderr.write('  Prüfe, ob der Fall in die bestehende Datei gehört (TV-004).\n');
    }
  }
  return flags.has('--strict') && findings.length > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) process.exit(main(process.argv.slice(2)));
