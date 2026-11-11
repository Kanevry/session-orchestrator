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
//
// Census tests (#1938, pipeline 35968): a test that walks the real source tree from
// disk (readdirSync over scripts/, hooks/, skills/ ...) and imports nothing it checks is
// never `related` to the file it judges. Such a test registers itself with a line
//   // census-source-tree: <dirs or files it reads, space-separated>
// within its first CENSUS_HEAD_BYTES, and the gate hands EVERY registered test to the
// same `vitest related` call (vitest runs a test file passed as an argument).
// A test that matches the walker heuristic but reads only a fixture/tmp tree opts out:
//   // census-source-tree: none — <reason>
// tests/husky/census-marker-registry.test.mjs fails when a walker carries neither line;
// it reads the real tests/ tree, so it is registered itself and runs on every partial push.
// CEILING (BV-004): all registered tests run on every partial push, whatever changed —
// 22 files / 370 tests took 22 s on 2026-11-04, 49 files / 934 tests 26 s after #1945
// registered the root-argument readers. The named dirs are documentation today;
// revisit trigger: that run exceeding ~60 s, then select only tests whose named dirs
// contain a changed path.
// CEILING (BV-004) of the walker heuristic (CENSUS_WALK_RE + CENSUS_SOURCE_DIR_RE, or
// CENSUS_ROOT_ARG_RE alone — the guard's only way to find an unmarked census test): it
// sees a test that reads a directory ITSELF with a quoted scripts/hooks/skills/commands
// name, one that hands the repo root to a check library or a spawned CLI as a call
// argument (`runCheckHooksEmitEventGuard(REPO_ROOT)`, `[SCRIPT, REPO_ROOT]`; #1945), and
// a `git ls-files` run in the cwd (`'git', ['ls-files'`). It misses fixed `readFileSync`
// lists of source paths, dirs outside the regex (agents, docs, .claude, mods, templates),
// paths built as template strings, a root under another name, and `git -C <dir>
// ls-files`. The MR pipeline stays the net for that class. Revisit trigger: an MR
// pipeline red in a test of that class on a head this partial gate passed.
import { existsSync, readdirSync, readFileSync, openSync, readSync, closeSync, mkdtempSync, rmSync, statSync,
  realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { isMainModule } from './is-main-module.mjs';
import { spawnSync } from './native-command.mjs';

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

const CENSUS_HEAD_BYTES = 4096;
const CENSUS_MARKER_RE = /^\/\/ census-source-tree: (.+)$/m;
const TEST_FILE_RE = /\.test\.[cm]?js$/;
/** Walker heuristic, both halves: a directory read AND a quoted source-tree dir name. */
const CENSUS_WALK_RE = /readdirSync|globSync|readdir\(/;
const CENSUS_SOURCE_DIR_RE = /EVENT_SOURCE_DIRS|['"](?:scripts|hooks|skills|scripts\/lib|commands)['"]/;
/**
 * Walker on its own (#1945): the repo root as a call argument of a check library or a
 * spawned CLI, or `git ls-files` in the cwd. Not a jest matcher's argument
 * (`.toContain(REPO_ROOT)`) and not `resolve(REPO_ROOT)` — neither reads the tree.
 */
const CENSUS_ROOT_ARG_RE =
  /(?<!\.to[A-Z]\w*|\bresolve)\((?:REPO_ROOT|PLUGIN_ROOT|ROOT)\)|\[SCRIPT, (?:REPO_ROOT|PLUGIN_ROOT|ROOT)\b|['"]git['"], \[['"]ls-files['"]/;
/** The event carries at most this many selected census paths (plus `census_truncated`). */
const CENSUS_EVENT_LIMIT = 20;

/** Every test file under `<root>/tests`, as posix paths relative to `root`, sorted. */
function listTestFiles(root) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch (error) {
      if (rel === 'tests' && error.code === 'ENOENT') return; // a tree without tests/
      throw error;
    }
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== 'fixtures') walk(child);
      } else if (e.isFile() && TEST_FILE_RE.test(e.name)) out.push(child);
    }
  };
  walk('tests');
  return out.sort();
}

function readHead(file) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(CENSUS_HEAD_BYTES);
    return buf.toString('utf8', 0, readSync(fd, buf, 0, CENSUS_HEAD_BYTES, 0));
  } finally {
    closeSync(fd);
  }
}

/**
 * The census marker of one test file: `null` without a marker, else
 * `{ optOut, value }` (`optOut` when the value starts with `none`).
 * @param {string} file absolute path
 */
export function readCensusMarker(file) {
  const m = CENSUS_MARKER_RE.exec(readHead(file));
  if (!m) return null;
  const value = m[1].trim();
  return { optOut: /^none\b/.test(value), value };
}

/**
 * Registered census tests under `<root>/tests` (posix paths relative to `root`, sorted).
 * @param {string} root the materialised tree or a repo root
 * @returns {string[]}
 */
export function censusTests(root) {
  return listTestFiles(root).filter((rel) => readCensusMarker(join(root, rel))?.optOut === false);
}

/**
 * Test files that match the walker heuristic and carry no census marker of either kind.
 * `walkers` is the heuristic match count — the guard's vacuum check.
 * @param {string} root
 * @returns {{ walkers: number, unregistered: string[] }}
 */
export function findUnregisteredCensusTests(root) {
  let walkers = 0;
  const unregistered = [];
  for (const rel of listTestFiles(root)) {
    const text = readFileSync(join(root, rel), 'utf8');
    const walks = CENSUS_WALK_RE.test(text) && CENSUS_SOURCE_DIR_RE.test(text);
    if (!walks && !CENSUS_ROOT_ARG_RE.test(text)) continue;
    walkers++;
    if (readCensusMarker(join(root, rel)) === null) unregistered.push(rel);
  }
  return { walkers, unregistered };
}

/** Reports above this size are not parsed: the fields stay out, the verdict is unaffected. */
const REPORT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * `selected_count` / `selected_tests` (first CENSUS_EVENT_LIMIT, posix paths relative to
 * the tree) / `selected_truncated` from a vitest json report, or `{}` when the report is
 * missing, oversized or unparsable — telemetry only, it never changes the verdict.
 * @param {string} reportFile
 * @param {string} tree the materialised tree vitest ran in
 * @returns {{ selected_count?: number, selected_tests?: string[], selected_truncated?: boolean }}
 */
export function readSelectedTests(reportFile, tree) {
  try {
    if (statSync(reportFile).size > REPORT_MAX_BYTES) return {};
    const results = JSON.parse(readFileSync(reportFile, 'utf8')).testResults;
    if (!Array.isArray(results)) return {};
    // vitest reports names under its realpath'd root; $TMPDIR is a symlink on macOS.
    const roots = [...new Set([tree, realpathSync(tree)])];
    const names = results.map((r) => r?.name).filter((n) => typeof n === 'string').map((name) => {
      const rel = roots.map((root) => relative(root, name)).find((r) => !r.startsWith('..') && !isAbsolute(r));
      return (rel ?? name).split(sep).join('/');
    });
    const selected = [...new Set(names)].sort();
    return { selected_count: selected.length, selected_tests: selected.slice(0, CENSUS_EVENT_LIMIT),
      selected_truncated: selected.length > CENSUS_EVENT_LIMIT };
  } catch {
    return {};
  }
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
  // The hook hands over no ref name, so the branch is the source repo's checked-out
  // branch (null when detached) — not necessarily the pushed ref.
  const fields = { pushed_sha: sha, base_sha: base, changed_count: changed.length,
    branch: git(repoRoot, ['symbolic-ref', '-q', '--short', 'HEAD']) || null };
  if (changed.length === 0) {
    await emit(repoRoot, true, fields);
    return 0;
  }
  let census;
  try {
    census = censusTests(tree).filter((f) => !changed.includes(f));
  } catch (error) {
    log(`local partial gate: census-test discovery failed (${error.code ?? error.message}) — full gate locally (fail-closed).`);
    return 10;
  }
  fields.census_count = census.length;
  fields.census_tests = census.slice(0, CENSUS_EVENT_LIMIT);
  fields.census_truncated = census.length > CENSUS_EVENT_LIMIT;
  if (census.length) log(`local partial gate: +${census.length} census test(s) that read the source tree from disk (#1938).`);
  const syntaxFailed = sources.filter((f) =>
    spawnSync(process.execPath, ['--check', f], { cwd: tree, stdio: ['ignore', 2, 2], timeout: 30_000 }).status !== 0);
  if (syntaxFailed.length) log(`local partial gate: node --check failed: ${syntaxFailed.join(', ')}`);
  const lint = sources.length ? runTool(tree, 'eslint', ['--no-warn-ignored', ...sources], 300_000) : true;
  // The json report names the test files vitest actually ran — the `related` selection
  // plus the census tests (#1938 acceptance 3). Two reporters: the default one keeps the
  // human output on stderr as before (measured on vitest 4.1.12: exit code unchanged).
  // No temp dir: run without the json reporter rather than fail the push on telemetry.
  let reportDir = null;
  try { reportDir = mkdtempSync(join(tmpdir(), 'so-partial-gate-')); } catch { /* fields stay out */ }
  const reportFile = reportDir && join(reportDir, 'vitest-report.json');
  const reportArgs = reportFile ? ['--reporter=default', '--reporter=json', `--outputFile=${reportFile}`] : [];
  let test;
  try {
    test = runTool(tree, 'vitest', ['related', '--run', '--passWithNoTests', ...reportArgs, ...changed, ...census],
      900_000);
    if (reportFile) Object.assign(fields, readSelectedTests(reportFile, tree));
  } finally {
    if (reportDir) rmSync(reportDir, { recursive: true, force: true });
  }
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
