#!/usr/bin/env node
/**
 * tests-src-ratio.mjs — THE canonical tests:src LOC measurement for TV-003
 * (`.claude/rules/test-value.md` § TV-003 Budget Corridor).
 *
 * ## Why this file exists
 *
 * TV-003 named a ceiling but no recipe, so the recipe lived in prose — and prose
 * re-derives differently for every person who measures. On 2026-07-30 SIX numbers
 * for the one metric were in simultaneous circulation (1.7142 / 1.7360 / 1.74 /
 * 1.7779 / 1.8032 / 1.8084), differing only in which files each measurer chose to
 * count. A threshold steered by six numbers is steered blind. This module is the
 * single answer: the recipe is code, the number is reproducible at a SHA, and the
 * rule text points here instead of describing a seventh calculation.
 *
 * ## The recipe (a PARTITION, not two independent globs)
 *
 * Every tracked code file lands in EXACTLY ONE bucket — that property is the
 * whole design. Two independently-authored globs are how the six numbers arose:
 * each hand-picked src list (`scripts+hooks` vs `+skills` vs `everything`) both
 * dropped files silently and invited the next measurer to pick differently.
 * Here `src` is defined by NEGATION, so a new top-level directory joins the
 * denominator the moment it is committed, with no rule edit and no re-derivation.
 *
 *   universe     `git ls-files`, filtered to CODE_EXTENSIONS
 *   numerator    tracked code under `tests/`
 *   denominator  every OTHER tracked code file
 *
 * ## The four questions, answered in code rather than left open
 *
 *   Do `skills/**.mjs` count as src?      YES — shipped product code, and no
 *                                         hand-picked list decides it; negation does.
 *   Do `.md` files count?                 NO — neither side. Documentation volume
 *                                         is a different budget (instruction-budget);
 *                                         mixing them makes the ratio movable by
 *                                         writing prose, which catches no bug.
 *   Only git-tracked?                     YES — reproducible at a SHA, and it is
 *                                         what keeps node_modules/, coverage/ and
 *                                         untracked scratch out without an ignore list.
 *   Do `tests/fixtures/` count as test LOC? YES when they are code (`.mjs`/`.js`/
 *                                         `.cjs`). A code fixture is maintained
 *                                         code that exists only to serve the suite —
 *                                         that is test-corpus cost. Non-code
 *                                         fixtures (`.json`, `.jsonl`, `.md`) are
 *                                         excluded by the same extension filter
 *                                         that governs the denominator.
 *   Blank lines and comments?             COUNTED — see countPhysicalLines().
 *
 * ## What this is NOT
 *
 * Not a ratchet, and deliberately so. TV-003 is a CORRIDOR: exceeding the ceiling
 * switches the consolidation rule on, it does not break the build. `--check` is a
 * machine-readable answer to "is the consolidation wave required?", which is the
 * only job TV-003 gives the ratio ("the ratio is merely the trigger that switches
 * it on"). Wiring it as a blocking CI gate would manufacture standing deletion
 * pressure with no nameable target per file — the precise thing TV-001 and TV-002
 * forbid, and the documented reason the predecessor ceiling of 1.20 was abandoned.
 *
 * Usage:
 *   tests-src-ratio.mjs [<repo-root>] [--json] [--check] [--ceiling <n>] [--stdin]
 *
 *   <repo-root>    defaults to process.cwd()
 *   --json         emit a single JSON object on stdout, nothing else
 *   --check        exit 1 when the ratio exceeds the ceiling (consolidation
 *                  wave required); exit 0 when inside the corridor
 *   --ceiling <n>  override the TV-003 ceiling (default 1.60)
 *   --stdin        take newline-separated paths from stdin instead of
 *                  enumerating via `git ls-files` (test seam / staged-only mode)
 *
 * Exit codes:
 *   0 — measurement completed (and, under --check, ratio is within the corridor)
 *   1 — --check only: ratio exceeds the ceiling
 *   2 — tool error (missing/unreadable root, bad argv)
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, isAbsolute, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { writeStdoutLineSync } from './io.mjs';

// ---------------------------------------------------------------------------
// The definition — the part that must never be re-derived by hand
// ---------------------------------------------------------------------------

/**
 * Extensions that count as CODE on both sides of the ratio. Anything else is in
 * neither bucket: `.md` is documentation, `.json`/`.jsonl`/`.yml` are data.
 * Applied symmetrically to numerator and denominator by construction — a file
 * type can never inflate one side while being invisible to the other.
 */
export const CODE_EXTENSIONS = Object.freeze(['.mjs', '.js', '.cjs']);

/** Path prefix that makes a tracked code file part of the TEST corpus. */
export const TEST_PREFIX = 'tests/';

/** The TV-003 ceiling. Exceeding it switches the consolidation rule on. */
export const DEFAULT_CEILING = 1.6;

/** Machine-readable schema tag for the --json envelope. */
export const SCHEMA = 'tests-src-ratio/1';

/**
 * Which bucket a repo-relative path belongs to.
 *
 * `src` is defined by NEGATION — every tracked code file that is not under
 * `tests/`. That is what makes the two buckets a partition rather than two
 * globs that can overlap or leave a gap.
 *
 * @param {string} relPath repo-relative path, `/`-separated
 * @returns {'test'|'src'|null} null = outside the metric entirely
 */
export function classifyPath(relPath) {
  const p = String(relPath).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!CODE_EXTENSIONS.some((ext) => p.endsWith(ext))) return null;
  return p === TEST_PREFIX.slice(0, -1) || p.startsWith(TEST_PREFIX) ? 'test' : 'src';
}

/**
 * Physical line count — blank lines and comment lines INCLUDED.
 *
 * Two deliberate choices:
 *
 * 1. No comment stripping. Stripping would need a real JS parser (a `//` inside
 *    a string, a regex literal, or a template literal is not a comment), so the
 *    stripper itself becomes a bug surface in the measuring instrument. It also
 *    inverts the incentive: comments sit in the DENOMINATOR too, so a stripper
 *    would reward deleting explanatory comments from src to move the ratio.
 *
 * 2. EOF-newline-insensitive. `wc -l` counts newline BYTES, so a file whose last
 *    line has no trailing newline is undercounted by one — an off-by-one that
 *    varies with an invisible byte. Here a trailing empty segment is dropped, so
 *    "10 lines" means ten lines with or without the final newline.
 *
 * @param {string} content
 * @returns {number}
 */
export function countPhysicalLines(content) {
  if (content === '') return 0;
  const parts = content.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/**
 * Measure the ratio over an explicit file list.
 *
 * Enumeration is injected rather than performed here, which is what lets the
 * test drive a controlled fixture without a git repository.
 *
 * @param {object} opts
 * @param {string[]} opts.files repo-relative paths
 * @param {(relPath: string) => string|null} opts.readFile returns content, or null when unreadable
 * @param {number} [opts.ceiling]
 * @returns {{testFiles:number,testLoc:number,srcFiles:number,srcLoc:number,ratio:number|null,
 *            ceiling:number,withinCorridor:boolean,consolidationWaveRequired:boolean,skipped:number}}
 */
export function measure({ files, readFile, ceiling = DEFAULT_CEILING }) {
  let testFiles = 0;
  let testLoc = 0;
  let srcFiles = 0;
  let srcLoc = 0;
  let skipped = 0;

  for (const rel of files) {
    const bucket = classifyPath(rel);
    if (bucket === null) continue;
    const content = readFile(rel);
    if (content === null || content === undefined) {
      skipped++;
      continue;
    }
    const lines = countPhysicalLines(content);
    if (bucket === 'test') {
      testFiles++;
      testLoc += lines;
    } else {
      srcFiles++;
      srcLoc += lines;
    }
  }

  // A repo with no src code has an undefined ratio, not an infinite one. Saying
  // `null` keeps the consumer from reading Infinity as a corridor breach.
  const ratio = srcLoc === 0 ? null : Number((testLoc / srcLoc).toFixed(4));
  const withinCorridor = ratio === null ? true : ratio <= ceiling;

  return {
    testFiles,
    testLoc,
    srcFiles,
    srcLoc,
    ratio,
    ceiling,
    withinCorridor,
    consolidationWaveRequired: !withinCorridor,
    skipped,
  };
}

/**
 * The self-describing definition block shipped inside every --json envelope, so
 * a consumer never has to guess which recipe produced the number.
 * @param {'git ls-files'|'stdin'} source
 */
export function definitionOf(source) {
  return {
    source: source === 'stdin' ? 'stdin path list' : 'git ls-files (tracked files only)',
    codeExtensions: [...CODE_EXTENSIONS],
    numerator: `tracked code files under ${TEST_PREFIX}`,
    denominator: `every OTHER tracked code file (src defined by negation, not by a directory list)`,
    lineRule: 'physical lines; blank + comment lines counted; EOF-newline-insensitive',
    excluded:
      'non-code extensions (.md, .json, .jsonl, .yml) on BOTH sides; untracked files (node_modules/, coverage/, scratch)',
  };
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

/** @param {string} root */
function trackedFiles(root) {
  const out = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out
    .split('\n')
    .filter(Boolean)
    .map((rel) => rel.replace(/\\/g, '/'));
}

/** @param {string} root */
function stdinPaths(root) {
  let raw;
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((p) => (isAbsolute(p) ? relative(root, p) : p).replace(/\\/g, '/'));
}

/** Short HEAD SHA, or null outside a git repo — the PSA-006 "measured WHEN" anchor. */
function headRef(root) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Whether any TRACKED CODE file differs from the index/HEAD.
 *
 * Load-bearing, not cosmetic. Enumeration reads the git INDEX but line counts
 * read the WORKING TREE, so on a dirty tree the pair (`ref`, `ratio`) is a claim
 * nobody can reproduce at that SHA. Observed live while this module was written:
 * a sibling agent grew one tracked src file 543 → 683 lines mid-measurement and
 * the "same" ratio moved across three consecutive runs. `ref` alone would have
 * stamped all three with the identical SHA.
 *
 * PSA-006 requires a measurement to carry WHEN it was taken; a SHA that does not
 * reproduce the number fails that requirement while looking like it satisfies it.
 *
 * @returns {boolean|null} null when git cannot answer (not a repo)
 */
function isDirty(root) {
  try {
    // --no-optional-locks is load-bearing, not tidiness: a plain `git status`
    // opportunistically refreshes and therefore LOCKS .git/index, which races a
    // parallel session's index write (PSA-007). This matters here specifically
    // because .claude/rules/test-value.md now instructs agents to run this
    // script, so it executes inside live sessions. Measured on git 2.50.1 with
    // stale stat info: plain status rewrote .git/index, the flagged form did not.
    // Same flag, same reason as hooks/post-bash-write-verify.mjs.
    const out = execFileSync('git', ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .filter(Boolean)
      .some((l) => classifyPath(l.slice(3).trim().split(' -> ').pop() ?? '') !== null);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE =
  'Usage: tests-src-ratio.mjs [<repo-root>] [--json] [--check] [--ceiling <n>] [--stdin]';

/** @param {string[]} argv */
/**
 * Session-start Phase 4 banner probe.
 *
 * WHY THIS EXISTS: without it this module had zero consumers. TV-003 defines the
 * ceiling as the trigger for a consolidation wave — and the trigger fired into a
 * void, since the only references were two rule files asking a human to type the
 * command. "Not a blocking gate" was conflated with "not wired at all"; the
 * counter-example shipped in the same commit range, where `checkInstructionBudget`
 * is equally non-blocking and does get a Phase 4 banner. This closes that asymmetry
 * WITHOUT making the ratio a build gate — the arguments against a bidirectional
 * ratchet in `.claude/rules/test-value.md` § TV-003 stand unchanged.
 *
 * Contract matches the sibling probes (`checkInstructionBudget`, `checkCiStatus`,
 * `checkMocStaleness`): returns `null` for "nothing to say", or a single
 * `{ severity, message }` record. Never throws — any failure degrades to silence,
 * because a measurement problem must not block a session start.
 *
 * @param {{ repoRoot?: string, ceiling?: number }} [opts]
 * @returns {{ severity: 'warn', message: string, ratio: number, ceiling: number } | null}
 */
export function checkTestsSrcRatio({ repoRoot, ceiling = DEFAULT_CEILING } = {}) {
  try {
    if (!repoRoot || typeof repoRoot !== 'string') return null;
    const root = resolve(repoRoot);
    if (!existsSync(root)) return null;

    const files = trackedFiles(root);
    const readFile = (rel) => {
      const abs = join(root, rel);
      try {
        if (!statSync(abs).isFile()) return null;
        return readFileSync(abs, 'utf8');
      } catch {
        return null;
      }
    };

    const result = measure({ files, readFile, ceiling });
    if (result.ratio === null || result.withinCorridor) return null;

    const dirty = isDirty(root);
    return {
      severity: 'warn',
      ratio: result.ratio,
      ceiling: result.ceiling,
      message:
        `⚠ tests:src ${result.ratio.toFixed(4)} > ceiling ${result.ceiling} — ` +
        `TV-003 consolidation wave is ON: no new test lands without removing a redundant one ` +
        `(${result.testLoc} test LOC / ${result.srcLoc} src LOC across ` +
        `${result.testFiles} + ${result.srcFiles} files${dirty ? ', dirty tree' : ''}). ` +
        `Detail: node scripts/lib/tests-src-ratio.mjs --json`,
    };
  } catch {
    return null; // never block a session start on a measurement failure
  }
}

export function parseArgs(argv) {
  const KNOWN = new Set(['--json', '--check', '--stdin', '--ceiling', '--help']);
  const positionals = [];
  let json = false;
  let check = false;
  let stdin = false;
  let help = false;
  let ceiling = DEFAULT_CEILING;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    if (!KNOWN.has(a)) return { error: `Unknown flag: ${a}` };
    if (a === '--json') json = true;
    else if (a === '--check') check = true;
    else if (a === '--stdin') stdin = true;
    else if (a === '--help') help = true;
    else if (a === '--ceiling') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) return { error: '--ceiling requires a positive number' };
      ceiling = v;
    }
  }
  if (positionals.length > 1) return { error: 'at most one positional <repo-root> is accepted' };
  return { json, check, stdin, help, ceiling, root: positionals[0] };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`Error: ${args.error}`);
    console.error(USAGE);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    console.log('');
    console.log('The canonical tests:src LOC measurement for TV-003 (test-value.md).');
    console.log('  numerator    tracked code under tests/');
    console.log('  denominator  every other tracked code file (src by negation)');
    console.log(`  code exts    ${CODE_EXTENSIONS.join(' ')}   (.md / .json never counted)`);
    console.log('  lines        physical; blanks + comments counted; EOF-newline-insensitive');
    console.log('');
    console.log('  --json         machine-readable envelope on stdout');
    console.log('  --check        exit 1 when the ratio exceeds the ceiling');
    console.log(`  --ceiling <n>  override the TV-003 ceiling (default ${DEFAULT_CEILING})`);
    console.log('  --stdin        read newline-separated paths instead of git ls-files');
    console.log('');
    console.log('Exit: 0 ok / within corridor · 1 (--check) ceiling exceeded · 2 tool error');
    process.exit(0);
  }

  const root = resolve(args.root ?? process.cwd());
  if (!existsSync(root)) {
    console.error(`Error: repo root does not exist: ${root}`);
    process.exit(2);
  }

  let files;
  try {
    files = args.stdin ? stdinPaths(root) : trackedFiles(root);
  } catch (err) {
    console.error(`Error: could not enumerate files under ${root}: ${err?.message ?? err}`);
    process.exit(2);
  }

  const readFile = (rel) => {
    const abs = join(root, rel);
    try {
      if (!statSync(abs).isFile()) return null;
      return readFileSync(abs, 'utf8');
    } catch {
      return null; // deleted/unreadable — counted as skipped, never as 0 lines
    }
  };

  const result = measure({ files, readFile, ceiling: args.ceiling });
  const dirty = args.stdin ? null : isDirty(root);
  const envelope = {
    schema: SCHEMA,
    measuredAt: new Date().toISOString(),
    root,
    ref: headRef(root),
    // `ref` is only a reproducible anchor when `dirty` is false — see isDirty().
    dirty,
    definition: definitionOf(args.stdin ? 'stdin' : 'git ls-files'),
    ...result,
  };

  if (args.json) {
    // writeStdoutLineSync, NOT console.log: stdout is async on a pipe on macOS,
    // so anything past the ~64 KiB kernel buffer is discarded by process.exit().
    // This envelope is small today, but --check exits explicitly below and the
    // fail-open class is not worth re-litigating per payload size.
    writeStdoutLineSync(JSON.stringify(envelope, null, 2));
  } else {
    const r = result.ratio === null ? 'n/a (no src code)' : result.ratio.toFixed(4);
    const verdict = result.withinCorridor
      ? 'within corridor'
      : `ABOVE ceiling ${result.ceiling} — TV-003 consolidation wave required`;
    const at = envelope.ref ? ` @ ${envelope.ref}${dirty ? '+dirty' : ''}` : '';
    writeStdoutLineSync(
      `tests:src = ${r}  (${result.testLoc} test LOC / ${result.srcLoc} src LOC` +
        `; ${result.testFiles} test + ${result.srcFiles} src files${at}) — ${verdict}` +
        (dirty ? '\n  NOTE: working tree is dirty — this number is NOT reproducible at that SHA' : ''),
    );
  }

  process.exit(args.check && !result.withinCorridor ? 1 : 0);
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] !== null &&
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) main();
