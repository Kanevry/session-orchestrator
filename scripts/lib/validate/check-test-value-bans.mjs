#!/usr/bin/env node
/**
 * check-test-value-bans.mjs — Advisory scan for the two lint-enforceable test
 * bans from `.claude/rules/testing.md` § "Lint-Enforceable Test Bans".
 *
 * WARN-ONLY (v1): findings never fail the process. Exit is 0 whenever the scan
 * completed, so this can be wired into a pre-commit hook as a pure advisory.
 *
 * Bans:
 *   B1 (exact-count)  Exact count assertions on DYNAMIC sets:
 *                       `.toHaveLength(<literal>)`
 *                       `.length).toBe|toEqual|toStrictEqual(<literal>)`
 *                     Only a count DERIVED FROM a dynamic set — a directory
 *                     walk (`readdirSync`/`glob`/`git ls-files`), a registry or
 *                     export map (`Object.keys`/`values`/`entries`) — is
 *                     flagged. Such a count drifts on every legitimate catalog
 *                     growth (`testing.md` § "Dynamic Artifact Counts"); use the
 *                     floor/ceiling pattern instead. A FIXED arity on a static
 *                     fixture (a hand-built array, a parsed test record, a hash
 *                     width) does not drift and is NOT flagged — the subject is
 *                     traced inline, then back to its nearest assignment, and
 *                     must reach a dynamic source before the count is a finding.
 *                     This is the narrowing `testing.md` already prescribes
 *                     ("count derived from a directory walk / registry / export
 *                     map"), which v1's blanket literal-match over-reported.
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
 *                     contract in a test file that is not one of the contract's
 *                     declared owners. This is the mechanical brake on the six
 *                     local helper copies and the 21 soft
 *                     `toContain('"permissionDecision":"deny"')` substring
 *                     asserts that survived the #906 protocol change verbatim.
 *
 *                     Two contract keys (#941 3b): `permissionDecision`
 *                     (allow/deny) is unambiguous and flagged in ANY non-owner
 *                     file; `systemMessage` (the emitWarn warn-envelope carrier)
 *                     is OVERLOADED with plain hook output, so it is flagged only
 *                     when the file-under-test is a deny-capable hook — otherwise
 *                     operator-steer / session-start banner asserts would
 *                     false-positive. Without the systemMessage key a warn-block
 *                     copy is invisible (the warn envelope carries no
 *                     `permissionDecision`): the "census keyed on the payload
 *                     misses the channel" trap, inside the rule that names it.
 *
 *                     NOT flagged (each an inverse of the banned shape): comment
 *                     lines; a line that goes THROUGH the helper
 *                     (`expectDeny(…).hookSpecificOutput.permissionDecisionReason`);
 *                     and absence guards (`.toBeUndefined()`, `.not.`), which
 *                     assert the key is missing rather than re-stating it.
 *
 *   B5 (clock-bomb)   A hardcoded absolute-date literal asserted against a
 *                     subject that HAS an injectable clock seam, in a block that
 *                     does not use it. The expected value is then a function of
 *                     the wall clock, so the test goes red on a calendar date
 *                     nobody chose (learning `test-fixture-time-bomb`, conf 0.9:
 *                     CI turned red on 2026-07-30 with no code change).
 *
 *                     The seam is PROVEN from the file itself: an id is in scope
 *                     only when some OTHER block in the same file passes an
 *                     explicit clock argument (`now:` / `nowMs:` / `clock:`) to
 *                     it. A function whose public API exposes a clock parameter
 *                     reads the clock on its main path — that is why the seam
 *                     exists. Absent that proof the check says nothing, so a
 *                     pure input→output date function is out of scope by
 *                     construction rather than by exception list.
 *
 *                     NOT flagged: blocks that control the clock (`now:`, `{ now }`
 *                     or a positional `now` — wider than the seam proof, #1478;
 *                     SCREAMING_CASE `NOW` / `FIXED_NOW` / `NOW_MS` count as
 *                     clock names too, #1499 item 7 — or a fake timer that pins
 *                     the DATE: `vi.setSystemTime(<date>)`,
 *                     `vi.useFakeTimers({ now: <date> })`, also when called in
 *                     the setup at module level or in a `describe` that
 *                     encloses the block; a bare `vi.useFakeTimers()` installs
 *                     at the real clock and pins nothing, #1499 item 8). A
 *                     handover whose value IS the real clock is no control
 *                     (#1487): inline (`{ now: Date.now() }`) or through a
 *                     binding in the same block (`const now = new Date();
 *                     fn(now)`) or in the shared setup — module level,
 *                     `describe` body, `beforeEach` (#1489 item 16). A freeze
 *                     does not exempt a block that hands over a real clock bound
 *                     at collection time (module level, `describe` body): that
 *                     value was read before any hook ran (#1499 item 9). Date
 *                     literals in INPUT position (only `.toBe`/`.toEqual`/
 *                     `.toStrictEqual` expected values are read), which leaves
 *                     the passthrough class (input date === output date)
 *                     untouched.
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
import { isGitToplevel } from './repo-files.mjs';

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
  console.log('  B5  hardcoded date asserted against a clock-seamed subject without using the seam');
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

/** B2 heuristic: how many toContain/toMatch calls make a .md read suspect. */
const PROSE_ASSERT_THRESHOLD = 3;

/** A line that reads a `.md` file — the B2 trigger. */
const MD_READ_CALL = /readFileSync\(/;
const MD_READ_TARGET = /\.md\b/;

/** A prose assertion — the B2 population. */
const PROSE_ASSERT = /\.(?:toContain|toMatch)\(/g;

/**
 * Count prose assertions in `lines[from, to)`.
 * @param {string[]} lines
 * @param {number} from inclusive
 * @param {number} to exclusive
 * @returns {number}
 */
function countProseAsserts(lines, from, to) {
  let n = 0;
  for (let i = from; i < to; i++) {
    const m = lines[i].match(PROSE_ASSERT);
    if (m) n += m.length;
  }
  return n;
}

const B1_PATTERNS = [
  {
    name: 'toHaveLength',
    regex: /\.toHaveLength\(\s*(\d+)\s*\)/g,
  },
  {
    name: 'length-toBe',
    // `[\s)]*` — a SINGLE character class — replaces the former
    // `\s*\)?\s*\)?\s*`. That old shape put three `\s*` groups adjacent around
    // two optional `)`; a whitespace run before a FAILING `.toBe(` could then be
    // partitioned O(n²) ways across those groups, polynomial backtracking (the
    // ReDoS risk this hardening removes). One class matches the same `.length ) )`
    // gap unambiguously in linear time, with no ambiguous quantifier adjacency.
    regex: /\.length[\s)]*\.(?:toBe|toEqual|toStrictEqual)\(\s*(\d+)\s*\)/g,
  },
];

/**
 * A value derived from a directory walk, registry, or export map — the "dynamic
 * set" B1 targets (`testing.md` § Lint-Enforceable Test Bans: "count derived
 * from a directory walk / registry / export map"). A count over such a set
 * drifts on catalog growth; a fixed arity over a STATIC fixture does not. B1
 * flags a count only when its subject reaches one of these sources.
 */
const DYNAMIC_SOURCE =
  /\b(?:readdirSync|readdir|globSync|glob|Reflect\.ownKeys|Object\.(?:keys|values|entries|getOwnPropertyNames))\s*\(|\bls-files\b/;

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
  'expectAllow/expectWarn instead of restating the envelope (permissionDecision or the warn ' +
  'systemMessage) here; hand-rolled copies survive the next protocol change verbatim (the ' +
  '#906 class: 6 helper copies + 21 soft substring asserts)';
const B5_HINT =
  'this subject takes an injectable clock elsewhere in the same file — pass it here too ' +
  '(`{ now: new Date("…") }`) or freeze the clock with vi.setSystemTime(); a hardcoded date ' +
  'compared against a now-dependent value is a time bomb that goes red on a calendar date ' +
  'nobody chose (learning test-fixture-time-bomb — CI red 2026-07-30, no code change)';

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

/** Anything that still tells allow from deny (or warn) under the exit-0 protocol.
 *  `Warn` is the #941-3b `expectWarn` route the sibling adds to hook-decision.mjs
 *  for the systemMessage warn-envelope — a block going through it is the outcome
 *  these bans exist to produce, so it is never itself flagged. */
const DECISION_DISCRIMINATOR = /\bexpect(?:Allow|Deny|NoDeny|Warn)\s*\(/;
const STDOUT_ASSERT = /expect\([^)]*\bstdout\b|\bstdout\b[^\n]*\)\s*\.(?:toBe|toEqual|toContain|toMatch)/;

// --- B4: hook-decision contract ownership -----------------------------------

/**
 * The permission-decision contract key — unambiguous. Any restatement outside a
 * declared owner is a copy regardless of the file's subject.
 */
const PERMISSION_DECISION_KEY = 'permissionDecision';

/**
 * The warn path's contract key (#941 point 3b). Since W1's `emitWarn`, the
 * operator notice rides a TOP-LEVEL `systemMessage` and carries NO
 * `permissionDecision`, so a hand-rolled warn-contract block was structurally
 * invisible to a B4 keyed only on `permissionDecision` — the repo's own
 * "census-keyed-on-the-payload misses the channel" failure class, reproduced
 * inside the very rule that names it.
 *
 * `systemMessage` is OVERLOADED, though: it is also the plain output of
 * non-decision hooks (operator-steer, the session-start banner). Only
 * `emitWarn`'s systemMessage is the contract `expectWarn` owns, and it appears
 * ONLY in deny-capable-hook tests. So this key's arm of B4 is scope-gated on
 * that (the same gate B3 uses), where `permissionDecision` needs none.
 */
const SYSTEM_MESSAGE_KEY = 'systemMessage';

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
/** A quoted JSON-key literal for one contract key — the soft-substring-assert
 *  shape from #906 (`toContain('"<key>":"…"')`). */
const keyLiteralRe = (key) => new RegExp(`["'\\\\]+${key}["'\\\\]+\\s*:`);

// --- B5: date-literal time bombs --------------------------------------------

/**
 * An absolute date pinned as the EXPECTED value of an equality assertion.
 * Input-position date literals (`created_at: '2026-06-21T…'`) do not match —
 * that is what keeps the passthrough class (input date === output date) out.
 *
 * CEILING (#1473): a fixed INPUT date that a production TTL ages out later is
 * not flagged either, on purpose. Measured 2026-09-29 with a shim that moves
 * `Date.now()` and `new Date()` forward in every vitest worker: the 34 test
 * files (plus one fixture module) holding a fixed `created_at: '2026-05…09'`
 * (1,211 tests) stayed green at +120, +365 and +3,650 days, so a rule keyed on
 * fixed input dates would have reported false positives only. The one real
 * bomb of that shape, the phase-skip fixture before 6670149c, was green at
 * -60 days and red at +0 and +120 days under the same shim — and
 * scanClockBombs() reaches that file since #1476 (alias imports are read) but
 * stays silent on it: the file hands no clock argument to anything. REVISIT when a
 * second fixed-input-date bomb lands on main: the class then recurs, and a
 * clock-shift run of the suite is the check that finds it without guessing.
 */
const DATE_EXPECTATION =
  /\.(?:toBe|toEqual|toStrictEqual)\(\s*(['"`])(\d{4}-\d{2}-\d{2}(?:[T ][^'"`]*)?)\1\s*\)/;

/**
 * A clock-named token not read off an object (`Date.now`, `opts.now`) — shared
 * head of the patterns below. Group 1 is the name.
 *
 * SCREAMING_CASE module constants are clock names too (#1499 item 7): `NOW`,
 * `NOW_MS`, `NOW_ISO`, and any `<WORD>_`-prefixed form (`FIXED_NOW`,
 * `FROZEN_NOW`). An `i` flag would not reach them — `_` is a `\w`, so the
 * lookbehind and the terminators below never see a `FIXED_NOW` boundary.
 * Measured 2026-10-02 over 722 test files: `NOW` is handed over in 29 files,
 * `FIXED_NOW` in 10, `NOW_MS` in 5, `NOW_ISO` in 2.
 */
const CLOCK_NAME = String.raw`(?<![.\w$])(now|nowMs|nowIso|clock|currentDate|(?:[A-Z][A-Z0-9]*_)*(?:NOW(?:_MS|_ISO)?|CLOCK|CURRENT_DATE))\s*`;

/**
 * Pass 1, the seam PROOF: a NAMED clock key (`{ now: … }`) — only that shape says
 * the callee's API takes a clock, whatever value it is handed. Every line it
 * matches also matches CONTROL_CLOCK_ARG, so a block that proves a seam is never
 * flagged itself — UNLESS the value it hands over is the real clock (#1487):
 * then the block proves the seam and is a bomb in the same breath.
 */
const SEAM_CLOCK_ARG = new RegExp(`${CLOCK_NAME}:`);

/**
 * Pass 2, is this block clock-CONTROLLED: any clock handover. Property shorthand
 * (`{ now }`, `{ repoRoot, now }`) and a positional `now` count too; `Date.now()`
 * and `const now =` do not. Wider is the safe direction here — it can only
 * remove findings. Group 2 is the terminator: `:` means the name is a KEY and
 * the handed-over value follows it; any other terminator means the name IS the
 * value. A handover only counts when that value is not the real clock — see
 * {@link handsOverControlledClock}.
 *
 * CEILING (#1478): pass 1 reads only the named form, because the wide form also
 * turns helpers into seams — +20 seamed (file, id) pairs in 15 files
 * (172 → 192, measured 2026-10-01 @ ffc5929f), e.g. `expectDeny` via a
 * `{ manifestMtimeMs: now }` fixture. Cost: a file whose ONLY clock handover is
 * `{ now }` or a positional `now` loses its seam proof and its bombs go unseen.
 * REVISIT on the first B5 finding whose subject is a helper, or the first CI
 * `test-value-bans` B5 finding the ±days clock-shift probe shows to be false.
 *
 * CEILING (#1507 item 3) — three known blind spots of the SCREAMING_CASE forms,
 * left deliberately: (a) a bare `NOW)` / `NOW,` counts as a handover, whatever
 * the constant holds; (b) arithmetic on a collected clock (`NOW - DAY`) is NOT
 * seen as a handover, the terminator follows the operand, not the name; (c) an
 * IMPORTED clock constant is not checked for provenance — `NOW` from a helper
 * module that holds `Date.now()` reads as controlled. Measured impact
 * 2026-10-03: 0 changed findings over 722 test files.
 * REVISIT on the first B5 miss or false finding traced to (a), (b) or (c).
 */
const CONTROL_CLOCK_ARG = new RegExp(String.raw`${CLOCK_NAME}(:|,|\}|\))`, 'g');

/** A read of the real wall clock: `Date.now()`, an argument-less `new Date()`, `performance.now()`. */
const REAL_CLOCK_READ = /\bDate\.now\(\)|\bnew Date\(\s*\)|\bperformance\.now\(\)/;

/**
 * `const now = <rhs>` / `now = <rhs>` — a clock-named binding (not `==`, not an
 * arrow `now =>`). Group 1 is the name, group 2 the right-hand side.
 */
const CLOCK_BINDING = new RegExp(String.raw`${CLOCK_NAME}=(?![=>])(.*)`);

/**
 * Freezing the global clock — equally valid control, but not a seam PROOF. Only
 * the INSTALLERS count: `advanceTimersByTime` / `runAllTimers` move a clock some
 * installer already faked and freeze nothing on their own, so a block that only
 * advances timers is controlled exactly when an installer reaches it. Whether an
 * installer pins the DATE is {@link pinsDate}'s call. Group 1 is the installer.
 */
const DATE_PIN_CALL = /\b(useFakeTimers|setSystemTime)\s*\(/g;

/**
 * Vitest aliases that resolve to the repo's own modules — source of truth is
 * `resolve.alias` in vitest.config.mjs (today only `@lib`). CEILING: one entry
 * per alias, kept by hand; REVISIT when vitest.config.mjs gains an alias — the
 * parametrised B5 test reads that config and goes red until the key is listed
 * here. Dynamic imports (`await import('@lib/…')`) are not read in either form.
 */
const ALIAS_PREFIXES = ['@lib/'];

/** `import { a, b as c } from './rel.mjs'` or `'@lib/x.mjs'` — SUT candidates live behind these. */
const LOCAL_IMPORT = new RegExp(
  String.raw`import\s+([^;]+?)\s+from\s+['"]((?:\.|` +
    ALIAS_PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|') +
    String.raw`)[^'"]+)['"]`,
  'g',
);

// ---------------------------------------------------------------------------
// File enumeration
// ---------------------------------------------------------------------------

/** Tracked tests/**\/*.test.mjs via git ls-files (repo-wide default mode). */
function trackedTestFiles() {
  let out;
  try {
    out = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return []; // not a git repo — nothing to scan
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((rel) => rel.replace(/\\/g, '/'))
    .filter((rel) => /^tests\/.*\.test\.mjs$/.test(rel));
}

/**
 * Line ranges this commit actually ADDS or CHANGES, per repo-relative path,
 * from `git diff --cached -U0`.
 *
 * Why (#1148, HR-101): `--stdin` scopes the scan to staged FILES, not staged
 * LINES. Touching one line of a 1400-line test file therefore surfaced every
 * pre-existing finding in it — a warning that fires on work the committer did
 * not do, which teaches the committer to ignore the warning. The repo-wide
 * census is not lost by this: the CI job `test-value-bans` runs the scanner
 * unscoped over `$CI_PROJECT_DIR` (.gitlab-ci.yml), so an old prose pin is
 * still reported there — just not at the moment someone edits a neighbouring
 * line.
 *
 * Returns `null` when there is no index to consult (not a git top level, git
 * absent, command failed). A null gate is INERT, never empty: failing open is
 * the only safe direction for an advisory that must not invent silence.
 *
 * @returns {Map<string, Array<[number, number]>> | null}
 */
function stagedLineRanges() {
  if (!isGitToplevel(repoRoot)) return null;
  let out;
  try {
    out = execFileSync('git', ['diff', '--cached', '-U0', '--no-color'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  /** @type {Map<string, Array<[number, number]>>} */
  const ranges = new Map();
  /** @type {string | null} */
  let current = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('+++ ')) {
      // The POST-image path: a rename stages under its new name, and a
      // deletion stages as /dev/null (no post-image lines to judge).
      const target = line.slice(4).trim();
      current = target === '/dev/null' ? null : target.replace(/^b\//, '').replace(/\\/g, '/');
      if (current && !ranges.has(current)) ranges.set(current, []);
      continue;
    }
    if (!current || !line.startsWith('@@')) continue;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) continue; // pure deletion — no post-image line exists
    ranges.get(current).push([start, start + count - 1]);
  }
  return ranges;
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
 * The subject expression a B1 assertion pins the length/size of — the text
 * inside the enclosing `expect( … )`, with one trailing `)` stripped. Works for
 * both `expect(<subj>).toHaveLength(n)` (matchIndex at `.toHaveLength`) and
 * `expect(<subj>.length).toBe(n)` (matchIndex at `.length`).
 * @param {string} line
 * @param {number} matchIndex column where the B1 pattern begins
 */
function b1Subject(line, matchIndex) {
  const before = line.slice(0, matchIndex);
  const ei = before.lastIndexOf('expect(');
  const inner = ei !== -1 ? before.slice(ei + 'expect('.length) : before;
  return inner.replace(/\)\s*$/, '').trim();
}

/** The leading identifier of an expression (`Object` in `Object.keys(x)`). */
function leadingIdent(expr) {
  const m = /^[(\s]*([A-Za-z_$][\w$]*)/.exec(expr);
  return m ? m[1] : null;
}

/**
 * True when a B1 count is derived from a dynamic set rather than a static
 * fixture. Checked first inline on the subject expression, then by tracing a
 * bare subject identifier back to its NEAREST assignment above the assertion —
 * a walk/registry call on that assignment's right-hand side makes the count
 * dynamic. A subject that never reaches a {@link DYNAMIC_SOURCE} (a hand-built
 * array, a parsed record, a fixed-width hash) is a legitimate static arity and
 * is not flagged. Precision over recall by construction: an undetectable
 * dynamic source simply yields no finding, the correct direction for a mutable
 * advisory.
 * @param {string[]} lines
 * @param {number} idx zero-based index of the asserting line
 * @param {string} subject the length subject expression
 */
function b1IsDynamic(lines, idx, subject) {
  if (DYNAMIC_SOURCE.test(subject)) return true;
  const id = leadingIdent(subject);
  if (!id) return false;
  const assignRe = new RegExp(
    `(?:const|let|var)\\s+(?:\\{[^}]*\\b${id}\\b[^}]*\\}|${id})\\s*=(?!=)` +
      `|(?:^|[^.\\w$])${id}\\s*=(?!=)`,
  );
  for (let j = idx - 1; j >= 0; j--) {
    if (isCommentLine(lines[j])) continue;
    if (assignRe.test(lines[j])) return DYNAMIC_SOURCE.test(lines[j]);
  }
  return false;
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
  return callRanges(lines, /^(\s*)(?:it|test)(?:\.\w+)*\s*\(/, /^\s*(?:it|test|describe)(?:\.\w+)*\s*\(/);
}

/**
 * Split a file into `describe(` blocks, segmented like {@link testBlocks} but
 * with no sibling fallback: a `describe` without its own same-indentation `});`
 * runs to the end of the file. For its one consumer (B5's setup fake-timer
 * scope) over-inclusion is NOT safe: a wider `describe` exempts more blocks, so
 * a fake timer in it hides a sibling describe's time bomb — the false negative
 * this scoping exists to remove. Ceiling (BV-004): two shapes still widen —
 * a `describe` closed with options (`}, 10_000);`) runs to end of file, and a
 * tagged-template `describe.each\`…\`` never matches the opener, so its timer
 * reads as module level. Measured 2026-10-02 over 722 test files: 0 of the 13
 * fake-timer files use either shape. Revisit when one appears in a fake-timer
 * file, or when a B5 miss traces to one.
 * @param {string[]} lines
 * @returns {Array<{start: number, end: number}>} half-open [start, end) indices
 */
function describeBlocks(lines) {
  return callRanges(lines, /^(\s*)describe(?:\.\w+)*\s*\(/, null);
}

/**
 * Shared segmenter: every line matching `opener` (group 1 = its indentation)
 * opens a range that ends after the first later line closing at the SAME
 * indentation (`});`), or before the first `sibling` line, or at end of file.
 * @param {string[]} lines
 * @param {RegExp} opener
 * @param {RegExp|null} sibling
 * @returns {Array<{start: number, end: number}>} half-open [start, end) indices
 */
function callRanges(lines, opener, sibling) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = opener.exec(lines[i]);
    if (!m) continue;
    const closer = new RegExp(`^${m[1]}\\}\\)`);
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (sibling?.test(lines[j])) {
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
 * Identifiers this test file imports from the repo's OWN modules (relative or
 * vitest-alias specifiers). These are the subject-under-test candidates for B5;
 * framework (`vitest`) and stdlib (`node:*`) imports are structurally excluded
 * because their specifiers match neither form.
 * @param {string} content
 * @returns {string[]}
 */
function importedLocalIdentifiers(content) {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const m of content.matchAll(LOCAL_IMPORT)) {
    const clause = m[1];
    // `{ a, b as c }` → c ; `x` / `* as ns` → x / ns
    for (const part of clause.replace(/[{}]/g, ',').split(',')) {
      const t = part.trim();
      if (!t) continue;
      const alias = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(t);
      const name = alias ? alias[1] : /^([A-Za-z_$][\w$]*)$/.exec(t)?.[1];
      if (name && name !== 'type') ids.add(name);
    }
  }
  return [...ids];
}

/**
 * The clock-named bindings in these lines (`const now = Date.now()`,
 * `now = new Date('2026-01-01')`): per name, whether ANY binding reads the REAL
 * clock and whether ANY binding does not. Handing a real-clock binding over is
 * reading the wall clock with an extra step, not controlling it.
 *
 * CEILING (#1487): a real-clock value laundered through a non-clock name
 * (`const t = Date.now(); fn({ now: t })`) still counts as control. REVISIT
 * when a clock-shift run of the suite finds a bomb fed by that route.
 * @param {string[]} live non-comment lines
 * @returns {Map<string, {real: boolean, other: boolean}>}
 */
function clockBindings(live) {
  /** @type {Map<string, {real: boolean, other: boolean}>} */
  const out = new Map();
  for (const line of live) {
    const m = CLOCK_BINDING.exec(line);
    if (!m) continue;
    const seen = out.get(m[1]) ?? { real: false, other: false };
    if (REAL_CLOCK_READ.test(m[2])) seen.real = true;
    else seen.other = true;
    out.set(m[1], seen);
  }
  return out;
}

/**
 * The clock-named names a block hands over as the REAL clock: its own real-clock
 * bindings, plus the shared setup's (module level, `describe` body,
 * `beforeEach`) for every name the block does not rebind itself (#1489 item 16:
 * read block-wise only, `const now = Date.now()` at module level counted as
 * control and kept a genuine bomb silent).
 *
 * A setup name counts only when EVERY setup binding of it reads the real clock.
 * Setup is file-wide, not per-`describe`, so a name bound to the real clock in
 * one `beforeEach` and to a fixed date in another is ambiguous for any given
 * block — read as control, the scan's precision-first direction.
 * @param {Map<string, {real: boolean, other: boolean}>} own the block's bindings
 * @param {Map<string, {real: boolean, other: boolean}>} setup the shared setup's bindings
 * @returns {Set<string>}
 */
function realClockNames(own, setup) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const [name, b] of own) if (b.real) names.add(name);
  for (const [name, b] of setup) if (b.real && !b.other && !own.has(name)) names.add(name);
  return names;
}

/**
 * The value expression starting at `from`, up to the first `,` or closing
 * bracket at nesting depth 0 (`now: new Date(x), other` → `new Date(x)`).
 * Brackets inside string literals are not tracked; a cut-short value can only
 * hide a real-clock read, which leaves the block counted as controlled — the
 * pre-#1487 behaviour, never a new finding.
 */
function valueExpressionAt(line, from) {
  let depth = 0;
  for (let i = from; i < line.length; i++) {
    const c = line[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return line.slice(from, i);
      depth--;
    } else if (c === ',' && depth === 0) return line.slice(from, i);
  }
  return line.slice(from);
}

/**
 * True when this line hands over a clock that is NOT the real one: a clock-named
 * handover (CONTROL_CLOCK_ARG) whose value neither reads the wall clock inline
 * (`{ now: Date.now() }`) nor names a real-clock binding in the block's scope
 * (`const now = Date.now(); fn(now)`, see `realClockNames`). #1487: before this,
 * both shapes counted as control and kept a genuine time bomb silent.
 * @param {string} line
 * @param {Set<string>} realClock names bound to the real clock in this block's scope
 */
function handsOverControlledClock(line, realClock) {
  return handoverValues(line).some((v) => !REAL_CLOCK_READ.test(v) && !namesAny(v, realClock));
}

/**
 * The values this line hands over as a clock (CONTROL_CLOCK_ARG): after a
 * `name:` key the expression that follows it, otherwise the name itself.
 * @param {string} line
 * @returns {string[]}
 */
function handoverValues(line) {
  return [...line.matchAll(CONTROL_CLOCK_ARG)].map((m) =>
    m[2] === ':' ? valueExpressionAt(line, m.index + m[0].length) : m[1],
  );
}

/**
 * True when `value` names one of `names` as a whole identifier.
 * @param {string} value
 * @param {Iterable<string>} names
 */
function namesAny(value, names) {
  return [...names].some((n) => new RegExp(String.raw`(?<![.\w$])${n}(?![\w$])`).test(value));
}

/**
 * True when this line freezes the calendar DATE, not just the timers (#1499
 * item 8). vitest 4.1 installs `useFakeTimers()` at `this._fakingDate ||
 * Date.now()` — the real clock unless a date was set first — so only
 * `setSystemTime(<date>)` or a `useFakeTimers` config naming `now` pins a day;
 * `{ toFake: ['setTimeout'] }` leaves Date real. A pin whose value reads the wall
 * clock pins nothing: inline (`setSystemTime(new Date())`, `{ now: Date.now() }`)
 * or through a clock-named binding the scanner knows reads it
 * (`const now = new Date(); vi.setSystemTime(now)`, `useFakeTimers({ now })` —
 * review of ac3ded47). An argument the line cannot read — a variable, a config
 * spread over lines, a quoted key — counts as a pin: precision first, as
 * everywhere in B5. CEILING: a pin value laundered through a NON-clock name
 * (`const t = new Date(); vi.setSystemTime(t)`) still counts — the
 * {@link clockBindings} ceiling.
 * @param {string} line
 * @param {Set<string>} realClock names bound to the real clock in this line's scope
 */
function pinsDate(line, realClock) {
  for (const m of line.matchAll(DATE_PIN_CALL)) {
    const arg = valueExpressionAt(line, m.index + m[0].length).trim();
    let value = arg;
    if (m[1] === 'useFakeTimers') {
      if (arg === '') continue;
      if (!arg.startsWith('{') || !arg.endsWith('}')) return true;
      const key = /(?<![\w$])now(?![\w$])\s*([:,}])?/.exec(arg);
      if (!key) continue;
      if (!key[1]) return true;
      // `now:` hands over the expression after it; shorthand `{ now }` hands over the binding `now`.
      value = key[1] === ':' ? valueExpressionAt(arg, key.index + key[0].length) : 'now';
    }
    if (!REAL_CLOCK_READ.test(value) && !namesAny(value, realClock)) return true;
  }
  return false;
}

/** True when `id` is invoked anywhere in these lines. */
function callsIdentifier(lines, id) {
  const re = new RegExp(`\\b${id}\\s*\\(`);
  return lines.some((l) => !isCommentLine(l) && re.test(l));
}

/**
 * B5 findings for one file.
 *
 * Two passes over the file's `it`/`test` blocks:
 *   1. PROVE the seam — an imported id called from a block that also hands over
 *      a NAMED clock key (SEAM_CLOCK_ARG) is clock-seamed. A public API only
 *      grows a `now` parameter because the function reads the clock on its
 *      main path.
 *   2. FLAG — in blocks with NO clock control at all, any equality assertion
 *      pinning an absolute date against such a subject is a time bomb.
 *
 * Recall is deliberately traded for precision: a clock-dependent function that
 * never exposes a seam is invisible here, and that is the correct failure
 * direction for an advisory a developer can mute.
 *
 * @param {string} relPath
 * @param {string} content
 * @param {string[]} lines
 * @returns {Array<{file: string, line: number, ban: string, match: string, hint: string}>}
 */
function scanClockBombs(relPath, content, lines) {
  const findings = [];
  const sutIds = importedLocalIdentifiers(content);
  if (sutIds.length === 0) return findings;

  const ranges = testBlocks(lines);

  // The setup every block shares (helpers, constants, `describe` bodies,
  // beforeEach): where an echo may come from, and where a clock may be bound or
  // frozen for the blocks below it. Never a sibling test — its assertions,
  // titles and clock literals say nothing about this block's inputs.
  // CEILING (BV-004): a block without its own same-indentation `});` (a
  // `}, 10_000);` close, an expression-bodied arrow) runs on to the next sibling
  // and takes the setup lines in between out of sharedSetup. Both directions
  // follow: a swallowed `now = Date.now()` hides a finding, a swallowed fake
  // timer adds one. Measured 2026-10-02 @ 46e6695b over 722 test files: 221 of
  // 15,644 blocks lack the closer, 1 of them swallows a beforeAll/beforeEach,
  // none a fake-timer install; 0 blocks are one-line its. REVISIT when a
  // swallowed setup line binds or freezes a clock — then end such blocks on
  // their own close instead of the sibling (testBlocks() also feeds B2/B3).
  /** @type {Set<number>} */
  const inBlock = new Set();
  for (const { start, end } of ranges) for (let q = start; q < end; q++) inBlock.add(q);
  const sharedSetup = lines.filter((_, q) => !inBlock.has(q));
  const setupLive = sharedSetup.filter((l) => !isCommentLine(l));
  const setupBindings = clockBindings(setupLive);
  // A clock frozen in setup (`beforeEach(() => vi.setSystemTime(…))`) controls
  // every block it reaches, including a `now = Date.now()` bound after it — and
  // it reaches only the blocks vitest runs it for: all of them from module level,
  // only its own `describe`'s from inside one. A fake timer in a SIBLING
  // `describe` exempted every block in the file until 2026-10-02 and kept a
  // genuine bomb silent (review of 3206ab24). `null` = module level.
  const describes = describeBlocks(lines);
  /**
   * Innermost `describe` holding line q — ranges nest, so the latest start that
   * still holds it — or `null` at module level.
   * @param {number} q
   */
  const innermostDescribe = (q) => {
    const holders = describes.filter((d) => d.start <= q && q < d.end);
    return holders.length > 0 ? holders[holders.length - 1] : null;
  };
  const setupRealClock = realClockNames(new Map(), setupBindings);
  /** @type {Array<{start: number, end: number}|null>} */
  const setupTimerScopes = [];
  lines.forEach((l, q) => {
    if (inBlock.has(q) || isCommentLine(l) || !pinsDate(l, setupRealClock)) return;
    setupTimerScopes.push(innermostDescribe(q));
  });
  /** @param {number} start */
  const setupFreezes = (start) =>
    setupTimerScopes.some((d) => d === null || (d.start < start && start < d.end));
  // A real-clock name bound by a statement of the module itself or of a
  // `describe` body is read at COLLECTION time, before vitest runs any hook
  // (#1499 item 9). No freeze, in the setup or in the block, reaches that value,
  // so a block handing it over is not exempted by one. Every other setup binding
  // is DEFERRED — a hook callback, or a helper function's body (`validRecord()`,
  // `writeLock()`), which runs when called, after any freeze: 12 of the 13 setup
  // real-clock bindings outside a hook were such helper locals (measured
  // 2026-10-02 over 722 test files, review of ac3ded47). A name qualifies only
  // with no deferred binding at all — anything else reads as control, the
  // precision-first direction. "Statement of" is read from indentation: column 0
  // at module level, the enclosing `describe`'s column + 2 inside one (the
  // prettier indent of this repo). A misread only moves names OUT of the set: a
  // deeper or other indent style counts as deferred, and a hook range that
  // over-extends (a one-line `beforeEach(…);`) does the same. CEILINGS: a
  // one-line helper (`function f() { const now = Date.now(); … }`) at
  // `describe`-body indent counts as collection time; a freeze that itself runs
  // at collection time (a module-level `vi.setSystemTime` above the binding) is
  // not read. Measured 2026-10-02 over 722 test files: 1 collection-time binding
  // (tests/hooks/lock-reconcile.test.mjs:24), 0 installers outside a hook or test
  // block. REVISIT on the first B5 finding traced to either shape.
  const hooks = callRanges(lines, /^(\s*)(?:before|after)(?:Each|All)\s*\(/, null);
  const indentOf = (/** @type {string} */ l) => /^\s*/.exec(l)[0].length;
  /** @param {number} q */
  const atCollection = (q) => {
    if (hooks.some((h) => h.start <= q && q < h.end)) return false;
    const d = innermostDescribe(q);
    return indentOf(lines[q]) === (d ? indentOf(lines[d.start]) + 2 : 0);
  };
  const deferredBindings = clockBindings(
    lines.filter((l, q) => !inBlock.has(q) && !isCommentLine(l) && !atCollection(q)),
  );
  const collectionClock = [...setupBindings]
    .filter(([name, b]) => b.real && !b.other && !deferredBindings.has(name))
    .map(([name]) => name);

  const blocks = ranges.map(({ start, end }) => {
    const body = lines.slice(start, end);
    const live = body.filter((l) => !isCommentLine(l));
    const own = clockBindings(live);
    const realClock = realClockNames(own, setupBindings);
    const unfrozen = collectionClock.filter((name) => !own.has(name));
    const handsOverUnfrozen = live.some((l) => handoverValues(l).some((v) => namesAny(v, unfrozen)));
    return {
      start,
      body,
      provesSeam: live.some((l) => SEAM_CLOCK_ARG.test(l)),
      hasClockArg: live.some((l) => handsOverControlledClock(l, realClock)),
      freezesDate: !handsOverUnfrozen && (setupFreezes(start) || live.some((l) => pinsDate(l, realClock))),
    };
  });

  /** @type {Set<string>} */
  const seamed = new Set();
  for (const b of blocks) {
    if (!b.provesSeam) continue;
    for (const id of sutIds) if (callsIdentifier(b.body, id)) seamed.add(id);
  }
  if (seamed.size === 0) return findings;

  for (const b of blocks) {
    if (b.hasClockArg || b.freezesDate) continue;
    const subject = [...seamed].find((id) => callsIdentifier(b.body, id));
    if (!subject) continue;
    const echoSources = [...b.body, ...sharedSetup].filter(
      (l) => !isCommentLine(l) && !DATE_EXPECTATION.test(l),
    );
    b.body.forEach((line, k) => {
      if (isCommentLine(line)) return;
      const m = DATE_EXPECTATION.exec(line);
      if (!m) return;
      // Echo: the pinned value is also an input of this block or its shared setup,
      // not a clock reading (the CEILING above keeps fixed INPUT dates unflagged on
      // purpose). CEILING: a real bomb whose date also stands in its own block or
      // the shared setup (its title, a trailing comment, a helper fixture) is
      // swallowed; REVISIT when a clock-shift run finds a bomb this scan missed.
      if (echoSources.some((l) => l.includes(m[2]))) return;
      findings.push({
        file: relPath,
        line: b.start + k + 1,
        ban: 'B5-date-time-bomb',
        match: `${m[0].trim()} — ${subject}() called without its clock seam`,
        hint: B5_HINT,
      });
    });
  }
  return findings;
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

  // --- B1: exact count assertions on DYNAMIC sets -----------------------
  // A fixed arity over a static fixture does not drift and is legitimate; only
  // a count whose subject reaches a directory walk / registry / export map is
  // flagged (testing.md § Lint-Enforceable Test Bans). This narrowing is what
  // separates the ~349-finding v1 noise from the handful of real drift pins.
  lines.forEach((line, idx) => {
    for (const { regex } of B1_PATTERNS) {
      const re = new RegExp(regex.source, 'g');
      let m;
      while ((m = re.exec(line)) !== null) {
        if (EXEMPT_COUNT_LITERALS.has(Number(m[1]))) continue;
        if (hasCarveOut(lines, idx)) continue;
        if (!b1IsDynamic(lines, idx, b1Subject(line, m.index))) continue;
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
  // ONE finding per .md read, counted over the population that read can reach
  // (#1148). v1 reported the line of the FIRST .md read beside a WHOLE-FILE
  // assert count — two different populations with no causal relation, so the
  // reported location was never the location of anything counted.
  // Live proof: tests/unit/vault-mirror.test.mjs was filed at :1077 on
  // 2026-08-23 and reported :1415 three days later with the same 52 asserts.
  // Nothing happened at line 1077; the first .md read simply moved 338 lines.
  //
  // A read's population = its enclosing it()/test() block when it has one,
  // else the whole file — a module-scope read IS visible file-wide, so there
  // the file is the causally correct scope, not a fallback.
  // Ceiling (BV-004): testBlocks() segments it()/test() only, so a read at
  // describe() scope also counts file-wide. That over-includes in the same
  // direction v1 always did; revisit if a describe-scoped .md read is ever
  // reported with a count no single test could produce.
  {
    const blocks = testBlocks(lines);
    /** Segments already reported — a block holding two .md reads reports once. */
    const reportedSegments = new Set();
    lines.forEach((line, idx) => {
      if (!MD_READ_CALL.test(line) || !MD_READ_TARGET.test(line)) return;
      const block = blocks.find((b) => idx >= b.start && idx < b.end);
      const key = block ? `block:${block.start}` : 'file';
      if (reportedSegments.has(key)) return;
      const [from, to] = block ? [block.start, block.end] : [0, lines.length];
      const proseAsserts = countProseAsserts(lines, from, to);
      if (proseAsserts < PROSE_ASSERT_THRESHOLD) return;
      reportedSegments.add(key);
      findings.push({
        file: relPath,
        line: idx + 1,
        ban: 'B2-prose-pin-suspected',
        match: `readFileSync on .md + ${proseAsserts} toContain/toMatch asserts in ${
          block ? 'this test' : 'this file'
        }`,
        hint: B2_HINT,
      });
    });
  }

  // --- B3: bare exit-code allow assertion on a deny-capable hook ----------
  // Scope gate: EVERY hook this file declares as its subject must be
  // deny-capable. A file that also drives a non-deny hook, a husky hook or a
  // plain CLI is out — there, exit 0 is an unambiguous claim.
  const subjects = declaredHookSubjects(lines);
  const isDenyCapableHookTest =
    subjects.length > 0 && subjects.every((h) => denyHooks.has(h));
  if (isDenyCapableHookTest) {
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
    /** Lines already flagged — a two-key line reports once, not twice. */
    const b4Flagged = new Set();
    const scanContractKey = (key) => {
      const literalRe = keyLiteralRe(key);
      lines.forEach((line, idx) => {
        if (b4Flagged.has(idx)) return;
        if (!line.includes(key) || isCommentLine(line)) return;
        // Goes THROUGH the helper — the outcome this ban exists to produce.
        if (DECISION_DISCRIMINATOR.test(line)) return;
        // Absence guards assert the key is GONE; they cannot re-state a contract.
        if (ABSENCE_ASSERT.test(line)) return;
        const restatesKey = literalRe.test(line);
        const assertsKey = POSITIVE_MATCHER.test(line) && /expect\(/.test(line);
        if (!restatesKey && !assertsKey) return;
        b4Flagged.add(idx);
        findings.push({
          file: relPath,
          line: idx + 1,
          ban: 'B4-hook-decision-contract-copy',
          match: line.trim().slice(0, 120),
          hint: B4_HINT,
        });
      });
    };
    // permissionDecision: unambiguous — a copy in ANY non-owner file.
    scanContractKey(PERMISSION_DECISION_KEY);
    // systemMessage (#941 3b): the warn-decision carrier, but overloaded with
    // plain hook output — a contract copy ONLY when the file-under-test is a
    // deny-capable hook, where emitWarn's systemMessage lives. Without this
    // gate, operator-steer / session-start banner asserts would false-positive.
    if (isDenyCapableHookTest) scanContractKey(SYSTEM_MESSAGE_KEY);
  }

  // --- B5: date literal pinned against a clock-seamed subject -------------
  findings.push(...scanClockBombs(relPath, content, lines));

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

// Under --stdin (the pre-commit path) judge only the lines this commit
// touches; without it (the CI path) keep the repo-wide census. See
// stagedLineRanges() for why the two paths differ.
const stagedScope = flags.has('--stdin') ? stagedLineRanges() : null;
let suppressed = 0;
const reported = stagedScope
  ? findings.filter((f) => {
      const ranges = stagedScope.get(f.file);
      const inHunk = Boolean(ranges) && ranges.some(([a, b]) => f.line >= a && f.line <= b);
      if (!inHunk) suppressed++;
      return inHunk;
    })
  : findings;

const counts = {
  'B1-exact-count': reported.filter((f) => f.ban === 'B1-exact-count').length,
  'B2-prose-pin-suspected': reported.filter((f) => f.ban === 'B2-prose-pin-suspected').length,
  'B3-bare-hook-exit-code': reported.filter((f) => f.ban === 'B3-bare-hook-exit-code').length,
  'B4-hook-decision-contract-copy': findings.filter(
    (f) => f.ban === 'B4-hook-decision-contract-copy',
  ).length,
  'B5-date-time-bomb': reported.filter((f) => f.ban === 'B5-date-time-bomb').length,
};

if (jsonMode) {
  console.log(
    JSON.stringify(
      {
        advisory: true,
        scanned,
        counts,
        stagedScope: { applied: stagedScope !== null, suppressed },
        findings: reported,
      },
      null,
      2,
    ),
  );
} else if (reported.length === 0) {
  if (!quiet) {
    console.log(`check-test-value-bans: 0 findings across ${scanned} test file(s) — advisory`);
    // Never suppress silently: an empty result that had findings behind it is
    // a different fact from an empty result that did not (HR-106).
    if (stagedScope !== null && suppressed > 0) {
      console.log(
        `  (${suppressed} pre-existing finding(s) outside this commit's staged hunks not shown — ` +
          'the CI job test-value-bans reports the repo-wide census)',
      );
    }
  }
} else {
  console.log(`check-test-value-bans: ${reported.length} advisory finding(s) across ${scanned} test file(s)`);
  for (const f of reported) {
    console.log(`  ${f.ban}  ${f.file}:${f.line}  ${f.match}`);
  }
  if (counts['B1-exact-count'] > 0) console.log(`  B1 hint: ${B1_HINT}`);
  if (counts['B2-prose-pin-suspected'] > 0) console.log(`  B2 hint: ${B2_HINT}`);
  if (counts['B3-bare-hook-exit-code'] > 0) console.log(`  B3 hint: ${B3_HINT}`);
  if (counts['B4-hook-decision-contract-copy'] > 0) console.log(`  B4 hint: ${B4_HINT}`);
  if (counts['B5-date-time-bomb'] > 0) console.log(`  B5 hint: ${B5_HINT}`);
  if (stagedScope !== null && suppressed > 0) {
    console.log(
      `  (${suppressed} pre-existing finding(s) outside this commit's staged hunks not shown — ` +
        'the CI job test-value-bans reports the repo-wide census)',
    );
  }
  console.log('  (advisory — this check never blocks; see .claude/rules/testing.md § Lint-Enforceable Test Bans)');
}

// NOT `process.exit(0)`: on a PIPE, exiting truncates stdout writes still queued
// in the async pipe buffer — the full-corpus `--json` payload is well past the
// ~64 KiB pipe capacity, so `… --json | jq` silently received cut-off JSON while
// `… --json > file` was complete. Setting exitCode lets the writes drain first.
process.exitCode = 0;
