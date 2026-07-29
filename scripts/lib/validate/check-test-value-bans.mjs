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
 *   B3 (bare-exit)    A bare `expect(<x>.code|status).toBe(0)` inside an
 *                     `it(`/`test(` block of a test file whose hook-under-test
 *                     is DENY-CAPABLE, with no discriminator in the same block.
 *
 *                     Under the `exit 0` PreToolUse protocol (#906) allow AND
 *                     deny both exit 0, so an exit-code assertion alone passes
 *                     in BOTH directions — an assert-nothing. stdout is the only
 *                     channel that still discriminates. Discriminators accepted:
 *                     `expectAllow` / `expectDeny` / `expectNoDeny` from
 *                     `tests/_helpers/hook-decision.mjs`, or any `expect(...)`
 *                     naming `stdout` in the same block.
 *
 *   B4 (decision-copy) A hand-rolled, POSITIVE assertion of the hook decision
 *                     contract (`permissionDecision`) in a test file that is not
 *                     one of the contract's declared owners. This is the
 *                     mechanical brake on the six local helper copies and the 21
 *                     soft `toContain('"permissionDecision":"deny"')` substring
 *                     asserts that survived the #906 protocol change verbatim.
 *
 *                     NOT flagged (each an inverse of the banned shape): comment
 *                     lines; a line that goes THROUGH the helper
 *                     (`expectDeny(…).hookSpecificOutput.permissionDecisionReason`);
 *                     and absence guards (`.toBeUndefined()`, `.not.`), which
 *                     assert the key is missing rather than re-stating it.
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

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
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
  console.log('  B3  bare exit-0 assertion on a deny-capable hook (allow and deny both exit 0)');
  console.log('  B4  hook decision contract restated outside tests/_helpers/hook-decision.mjs');
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
const B3_HINT =
  'under the exit-0 PreToolUse protocol allow AND deny both exit 0, so this passes in both ' +
  'directions — use expectAllow(result) / expectDeny(result, reason) from ' +
  'tests/_helpers/hook-decision.mjs, or assert on stdout in the same block';
const B4_HINT =
  'the hook decision contract lives in tests/_helpers/hook-decision.mjs — import expectDeny/' +
  'expectAllow instead of restating the envelope here; hand-rolled copies survive the next ' +
  'protocol change verbatim (the #906 class: 6 helper copies + 21 soft substring asserts)';

// --- B3: deny-capable-hook exit-code discrimination -------------------------

/**
 * A hook is DENY-CAPABLE when its source emits a permission-decision envelope.
 * Derived from `<repoRoot>/hooks/` at scan time rather than hardcoded, so a new
 * deny-capable hook is covered the moment it lands.
 */
const DENY_EMITTER = /\bemitDeny\b|\bdenyDecision\b|permissionDecision/;

/** `const HOOK = …'hooks/<name>.mjs'` / `…'hooks', '<name>.mjs'` (module level). */
const HOOK_CONST_LINE = /^(?:export\s+)?(?:const|let|var)\s/;
const HOOK_PATH_REF = /hooks[/\\]([\w-]+\.(?:mjs|sh))\b|['"]hooks['"]\s*,\s*['"]([\w-]+\.(?:mjs|sh))['"]/g;

/** `expect(res.code).toBe(0)` and its `.status` / `.exitCode` / toEqual variants. */
const BARE_EXIT_OK =
  /expect\(\s*[A-Za-z_$][\w$.[\]'"]*\.(?:code|status|exitCode)\s*\)\s*\.(?:toBe|toEqual|toStrictEqual)\(\s*0\s*\)/;

/** Anything that still tells allow from deny under the exit-0 protocol. */
const DECISION_DISCRIMINATOR = /\bexpect(?:Allow|Deny|NoDeny)\s*\(/;
const STDOUT_ASSERT = /expect\([^)]*\bstdout\b|\bstdout\b[^\n]*\)\s*\.(?:toBe|toEqual|toContain|toMatch)/;

// --- B4: hook-decision contract ownership -----------------------------------

const DECISION_KEY = 'permissionDecision';

/**
 * The only files allowed to name the decision contract directly. Each owns a
 * DIFFERENT side of it — none is a consumer-side assertion copy:
 *   - the helper itself: the consumer-side assertion contract (SSOT)
 *   - io.test.mjs: producer-side — tests the `denyDecision`/`emitDeny` BUILDER
 *     in scripts/lib/io.mjs, whose field names are literally its subject matter
 *   - pi-hook-bridge.test.mjs: its fixtures are third-party/legacy-protocol hook
 *     sources the bridge must translate, not this repo's own contract
 */
const DECISION_CONTRACT_OWNERS = new Set([
  'tests/_helpers/hook-decision.mjs',
  'tests/lib/io.test.mjs',
  'tests/lib/pi-hook-bridge.test.mjs',
]);

/** Matchers that RE-STATE the contract (as opposed to asserting its absence). */
const POSITIVE_MATCHER = /\.(?:toBe|toEqual|toStrictEqual|toContain|toMatch|toMatchObject)\(/;
const ABSENCE_ASSERT = /\.toBeUndefined\(|\.toBeNull\(|\.not\./;
/** A quoted JSON-key literal — the soft-substring-assert shape from #906. */
const DECISION_KEY_LITERAL = new RegExp(`["'\\\\]+${DECISION_KEY}["'\\\\]+\\s*:`);

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

/** A `//`, `*` or `/*` line — prose, never an assertion. */
function isCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * The set of deny-capable hook basenames under `<repoRoot>/hooks/`.
 * Empty (→ B3 inert) when the root has no hooks/ directory.
 * @returns {Set<string>}
 */
function denyCapableHooks() {
  const dir = join(repoRoot, 'hooks');
  /** @type {Set<string>} */
  const out = new Set();
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith('.mjs')) continue;
    try {
      if (DENY_EMITTER.test(readFileSync(join(dir, name), 'utf8'))) out.add(name);
    } catch {
      // unreadable — treat as not deny-capable
    }
  }
  return out;
}

/**
 * The hook file(s) a test declares as its subject, read off module-level
 * `const HOOK = …hooks/<name>.mjs` bindings — the uniform convention in this
 * suite. A file that declares none is not a hook test and is out of B3 scope.
 * @param {string[]} lines
 * @returns {string[]} hook basenames
 */
function declaredHookSubjects(lines) {
  /** @type {Set<string>} */
  const hooks = new Set();
  for (const line of lines) {
    if (!HOOK_CONST_LINE.test(line) || isCommentLine(line)) continue;
    for (const m of line.matchAll(new RegExp(HOOK_PATH_REF.source, 'g'))) {
      hooks.add(m[1] ?? m[2]);
    }
  }
  return [...hooks];
}

/**
 * Split a file into `it(`/`test(` blocks. The block ends at the first later line
 * that closes at the SAME indentation (prettier-formatted `});`), falling back
 * to the next sibling test. Over-inclusion is the safe direction here: a wider
 * block can only reveal MORE discriminators, never invent a finding.
 * @param {string[]} lines
 * @returns {Array<{start: number, end: number}>} half-open [start, end) indices
 */
function testBlocks(lines) {
  const OPENER = /^(\s*)(?:it|test)(?:\.\w+)*\s*\(/;
  const SIBLING = /^\s*(?:it|test|describe)(?:\.\w+)*\s*\(/;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = OPENER.exec(lines[i]);
    if (!m) continue;
    const closer = new RegExp(`^${m[1]}\\}\\)`);
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (SIBLING.test(lines[j])) {
        end = j;
        break;
      }
      if (closer.test(lines[j])) {
        end = j + 1;
        break;
      }
    }
    out.push({ start: i, end });
  }
  return out;
}

/**
 * Scan one file's content, returning its findings.
 * @param {string} relPath
 * @param {string} content
 * @param {Set<string>} [denyHooks] deny-capable hook basenames (B3 scope gate)
 */
function scanContent(relPath, content, denyHooks = new Set()) {
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

  // --- B3: bare exit-code allow assertion on a deny-capable hook ----------
  // Scope gate: EVERY hook this file declares as its subject must be
  // deny-capable. A file that also drives a non-deny hook, a husky hook or a
  // plain CLI is out — there, exit 0 is an unambiguous claim.
  const subjects = declaredHookSubjects(lines);
  if (subjects.length > 0 && subjects.every((h) => denyHooks.has(h))) {
    for (const { start, end } of testBlocks(lines)) {
      const block = lines.slice(start, end);
      const discriminated = block.some(
        (l) => !isCommentLine(l) && (DECISION_DISCRIMINATOR.test(l) || STDOUT_ASSERT.test(l)),
      );
      if (discriminated) continue;
      block.forEach((line, k) => {
        if (isCommentLine(line) || !BARE_EXIT_OK.test(line)) return;
        findings.push({
          file: relPath,
          line: start + k + 1,
          ban: 'B3-bare-hook-exit-code',
          match: line.trim(),
          hint: B3_HINT,
        });
      });
    }
  }

  // --- B4: hook-decision contract copied outside its owners ---------------
  if (!DECISION_CONTRACT_OWNERS.has(relPath)) {
    lines.forEach((line, idx) => {
      if (!line.includes(DECISION_KEY) || isCommentLine(line)) return;
      // Goes THROUGH the helper — the outcome this ban exists to produce.
      if (DECISION_DISCRIMINATOR.test(line)) return;
      // Absence guards assert the key is GONE; they cannot re-state a contract.
      if (ABSENCE_ASSERT.test(line)) return;
      const restatesKey = DECISION_KEY_LITERAL.test(line);
      const assertsKey = POSITIVE_MATCHER.test(line) && /expect\(/.test(line);
      if (!restatesKey && !assertsKey) return;
      findings.push({
        file: relPath,
        line: idx + 1,
        ban: 'B4-hook-decision-contract-copy',
        match: line.trim().slice(0, 120),
        hint: B4_HINT,
      });
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const candidates = flags.has('--stdin') ? stdinFiles() : trackedTestFiles();
const denyHooks = denyCapableHooks();

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
  findings.push(...scanContent(rel, content, denyHooks));
}

const counts = {
  'B1-exact-count': findings.filter((f) => f.ban === 'B1-exact-count').length,
  'B2-prose-pin-suspected': findings.filter((f) => f.ban === 'B2-prose-pin-suspected').length,
  'B3-bare-hook-exit-code': findings.filter((f) => f.ban === 'B3-bare-hook-exit-code').length,
  'B4-hook-decision-contract-copy': findings.filter(
    (f) => f.ban === 'B4-hook-decision-contract-copy',
  ).length,
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
  if (counts['B1-exact-count'] > 0) console.log(`  B1 hint: ${B1_HINT}`);
  if (counts['B2-prose-pin-suspected'] > 0) console.log(`  B2 hint: ${B2_HINT}`);
  if (counts['B3-bare-hook-exit-code'] > 0) console.log(`  B3 hint: ${B3_HINT}`);
  if (counts['B4-hook-decision-contract-copy'] > 0) console.log(`  B4 hint: ${B4_HINT}`);
  console.log('  (advisory — this check never blocks; see .claude/rules/testing.md § Lint-Enforceable Test Bans)');
}

// NOT `process.exit(0)`: on a PIPE, exiting truncates stdout writes still queued
// in the async pipe buffer — the full-corpus `--json` payload is well past the
// ~64 KiB pipe capacity, so `… --json | jq` silently received cut-off JSON while
// `… --json > file` was complete. Setting exitCode lets the writes drain first.
process.exitCode = 0;
