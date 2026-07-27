#!/usr/bin/env node
/**
 * check-test-value-bans.mjs — Advisory scan for the two lint-enforceable test
 * bans from `.claude/rules/testing.md` § "Lint-Enforceable Test Bans".
 *
 * WARN-ONLY (v1): findings never fail the process. Exit is 0 whenever the scan
 * completed, so this can be wired into a pre-commit hook as a pure advisory.
 *
 * Bans:
 *   B1 (exact-count)  Exact count assertions on dynamic sets:
 *                       `.toHaveLength(<literal>)`
 *                       `.length).toBe|toEqual|toStrictEqual(<literal>)`
 *                     These drift on every legitimate catalog growth
 *                     (`testing.md` § "Dynamic Artifact Counts"). Use the
 *                     floor/ceiling pattern instead.
 *
 *                     Exempt literals: 0 and 1. `toHaveLength(0)` is an
 *                     EMPTINESS invariant ("no violations") and
 *                     `toHaveLength(1)` a UNIQUENESS invariant — both are
 *                     behavioural claims that do not drift when a catalog
 *                     grows. The growth-drift class starts at 2.
 *
 *                     Carve-out: a documented integrity anchor (fixed-width
 *                     hash, protocol-fixed tuple size) is exempted by an
 *                     `// integrity-anchor: <reason>` comment on the SAME line
 *                     or on the line immediately ABOVE the assertion.
 *
 *   B2 (prose-pin)    A test file that reads a `.md` document via readFileSync
 *                     AND carries >= 3 `toContain(` / `toMatch(` assertions is
 *                     reported as a SUSPECTED prose pin (TV-002c). Heuristic,
 *                     not a verdict — a doc-derived value assert is fine, a
 *                     sentence-presence assert is not.
 *
 * Per-file opt-out: `// @test-value-bans-allowed` in the first 5 lines skips
 * the file entirely (same convention as check-test-fixture-shapes.mjs's
 * `// @secret-shape-allowed`). Used by this check's own test file, which must
 * embed ban signatures as fixture literals.
 *
 * Usage:
 *   check-test-value-bans.mjs [<repo-root>] [--stdin] [--json] [--quiet]
 *
 *   <repo-root>  defaults to process.cwd()
 *   --stdin      read newline-separated file paths to scan from stdin instead
 *                of enumerating tracked tests/ files (pre-commit staged-only
 *                mode — keeps the hook fast). Paths may be relative to root.
 *   --json       emit a single JSON object on stdout, nothing else
 *   --quiet      suppress the "no findings" line in human mode
 *
 * Exit codes:
 *   0 — scan completed (findings are ADVISORY and do not change the exit code)
 *   2 — tool error (missing/unreadable root, bad argv)
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, isAbsolute, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positionals = argv.filter((a) => !a.startsWith('--'));

const KNOWN_FLAGS = new Set(['--stdin', '--json', '--quiet', '--help']);
for (const f of flags) {
  if (!KNOWN_FLAGS.has(f)) {
    console.error(`Unknown flag: ${f}`);
    console.error('Usage: check-test-value-bans.mjs [<repo-root>] [--stdin] [--json] [--quiet]');
    process.exit(2);
  }
}

if (flags.has('--help')) {
  console.log('Usage: check-test-value-bans.mjs [<repo-root>] [--stdin] [--json] [--quiet]');
  console.log('');
  console.log('Advisory scan for the two lint-enforceable test bans (testing.md).');
  console.log('  B1  exact count assertions on dynamic sets (toHaveLength(<n>), .length).toBe(<n>))');
  console.log('  B2  suspected prose pins (.md readFileSync + >=3 toContain/toMatch)');
  console.log('');
  console.log('  <repo-root>  repository root (default: cwd)');
  console.log('  --stdin      scan newline-separated paths from stdin (staged-only mode)');
  console.log('  --json       machine-readable output on stdout');
  console.log('  --quiet      suppress the no-findings line');
  console.log('');
  console.log('Exit: 0 always when the scan completes (warn-only v1); 2 on tool error.');
  process.exit(0);
}

if (positionals.length > 1) {
  console.error('Error: at most one positional <repo-root> argument is accepted');
  process.exit(2);
}

const repoRoot = positionals[0] ?? process.cwd();
if (!existsSync(repoRoot)) {
  console.error(`Error: repo root does not exist: ${repoRoot}`);
  process.exit(2);
}

const jsonMode = flags.has('--json');
const quiet = flags.has('--quiet');

// ---------------------------------------------------------------------------
// Detection constants
// ---------------------------------------------------------------------------

/** Literals that are behavioural invariants rather than growth-drift pins. */
const EXEMPT_COUNT_LITERALS = new Set([0, 1]);

const CARVE_OUT_MARKER = '// integrity-anchor:';
const MAGIC_COMMENT = '// @test-value-bans-allowed';
const MAGIC_COMMENT_SCAN_LINES = 5;

/** B2 heuristic: how many toContain/toMatch calls make a .md-reading file suspect. */
const PROSE_ASSERT_THRESHOLD = 3;

const B1_PATTERNS = [
  {
    name: 'toHaveLength',
    regex: /\.toHaveLength\(\s*(\d+)\s*\)/g,
  },
  {
    name: 'length-toBe',
    regex: /\.length\s*\)?\s*\)?\s*\.(?:toBe|toEqual|toStrictEqual)\(\s*(\d+)\s*\)/g,
  },
];

const B1_HINT =
  'use floor/ceiling (toBeGreaterThanOrEqual / toBeLessThanOrEqual) — testing.md § Dynamic Artifact Counts; ' +
  'or carve out with `// integrity-anchor: <reason>` if the count is a fixed protocol/hash width';
const B2_HINT =
  'asserting prose presence in a .md pins wording, not behaviour (test-value.md TV-002c) — ' +
  'assert the parsed/derived value the doc describes, or delete the test';

// ---------------------------------------------------------------------------
// File enumeration
// ---------------------------------------------------------------------------

/** Tracked tests/**\/*.test.mjs via git ls-files (repo-wide default mode). */
function trackedTestFiles() {
  let out;
  try {
    out = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
  } catch {
    return []; // not a git repo — nothing to scan
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((rel) => rel.replace(/\\/g, '/'))
    .filter((rel) => /^tests\/.*\.test\.mjs$/.test(rel));
}

/** Newline-separated paths from stdin (staged-only mode). */
function stdinFiles() {
  let raw;
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    return []; // no stdin attached
  }
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((p) => (isAbsolute(p) ? relative(repoRoot, p) : p).replace(/\\/g, '/'));
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Return true when the line itself, or the line above it, carries the
 * documented integrity-anchor carve-out marker.
 * @param {string[]} lines
 * @param {number} idx zero-based index of the asserting line
 */
function hasCarveOut(lines, idx) {
  if (lines[idx].includes(CARVE_OUT_MARKER)) return true;
  const prev = idx > 0 ? lines[idx - 1] : '';
  return prev.trimStart().startsWith('//') && prev.includes(CARVE_OUT_MARKER);
}

/**
 * Scan one file's content, returning its findings.
 * @param {string} relPath
 * @param {string} content
 */
function scanContent(relPath, content) {
  /** @type {Array<{file: string, line: number, ban: string, match: string, hint: string}>} */
  const findings = [];
  const lines = content.split('\n');

  if (lines.slice(0, MAGIC_COMMENT_SCAN_LINES).some((l) => l.includes(MAGIC_COMMENT))) {
    return findings;
  }

  // --- B1: exact count assertions ---------------------------------------
  lines.forEach((line, idx) => {
    for (const { regex } of B1_PATTERNS) {
      const re = new RegExp(regex.source, 'g');
      let m;
      while ((m = re.exec(line)) !== null) {
        if (EXEMPT_COUNT_LITERALS.has(Number(m[1]))) continue;
        if (hasCarveOut(lines, idx)) continue;
        findings.push({
          file: relPath,
          line: idx + 1,
          ban: 'B1-exact-count',
          match: m[0].trim(),
          hint: B1_HINT,
        });
      }
    }
  });

  // --- B2: suspected prose pin -------------------------------------------
  const mdReadLine = lines.findIndex((l) => /readFileSync\(/.test(l) && /\.md\b/.test(l));
  if (mdReadLine !== -1) {
    const proseAsserts = (content.match(/\.(?:toContain|toMatch)\(/g) ?? []).length;
    if (proseAsserts >= PROSE_ASSERT_THRESHOLD) {
      findings.push({
        file: relPath,
        line: mdReadLine + 1,
        ban: 'B2-prose-pin-suspected',
        match: `readFileSync on .md + ${proseAsserts} toContain/toMatch asserts`,
        hint: B2_HINT,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const candidates = flags.has('--stdin') ? stdinFiles() : trackedTestFiles();

/** @type {Array<{file: string, line: number, ban: string, match: string, hint: string}>} */
const findings = [];
let scanned = 0;

for (const rel of candidates) {
  if (!/\.test\.mjs$/.test(rel)) continue; // stdin mode may hand us anything
  const abs = join(repoRoot, rel);
  let content;
  try {
    if (!statSync(abs).isFile()) continue;
    content = readFileSync(abs, 'utf8');
  } catch {
    continue; // deleted/unreadable — nothing to say about it
  }
  scanned++;
  findings.push(...scanContent(rel, content));
}

const counts = {
  'B1-exact-count': findings.filter((f) => f.ban === 'B1-exact-count').length,
  'B2-prose-pin-suspected': findings.filter((f) => f.ban === 'B2-prose-pin-suspected').length,
};

if (jsonMode) {
  console.log(JSON.stringify({ advisory: true, scanned, counts, findings }, null, 2));
} else if (findings.length === 0) {
  if (!quiet) console.log(`check-test-value-bans: 0 findings across ${scanned} test file(s) — advisory`);
} else {
  console.log(`check-test-value-bans: ${findings.length} advisory finding(s) across ${scanned} test file(s)`);
  for (const f of findings) {
    console.log(`  ${f.ban}  ${f.file}:${f.line}  ${f.match}`);
  }
  console.log(`  B1 hint: ${B1_HINT}`);
  console.log(`  B2 hint: ${B2_HINT}`);
  console.log('  (advisory — this check never blocks; see .claude/rules/testing.md § Lint-Enforceable Test Bans)');
}

process.exit(0);
