import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { redactSpans } from '@lib/redact-spans.mjs';

/**
 * Contract tests for the extracted overlap-safe span-redaction primitive (#974).
 *
 * WHY THESE TESTS EXIST (TV-001 — the bug class the existing suite lets through):
 * `tests/lib/validate/check-owner-leakage.test.mjs` exercises this code ONLY
 * end-to-end through the scanner, and its redaction verdict is
 * `result.stdout.includes('[REDACTED]')` (line 142) plus `echoed: []`. That pair is
 * satisfied by a BROKEN merge as well as a correct one: an output of
 * `[REDACTED][REDACTED]-corp-secret` still "includes" the sentinel, and an output of
 * `[REDACTED][REDACTED]` for a single overlapping name still echoes nothing. So every
 * defect in the interval-merge step — nested double markers, a dropped adjacent merge,
 * an off-by-one splice — is structurally invisible to the existing suite. These tests
 * assert the EXACT output string and the marker COUNT, which is what bites.
 */

const M = '[REDACTED]';
const rx = (s, f = 'i') => new RegExp(s, f);
const markerCount = (s) => s.split(M).length - 1;

describe('redactSpans — overlap-safe merge', () => {
  it('merges two OVERLAPPING spans into exactly ONE marker (prefix collision, list order [short,long])', () => {
    // Bug caught: a naive per-pattern .replace() chain redacts `acme` first and leaks
    // the suffix residue `[REDACTED]-corp-secret`; a missing merge step emits two
    // nested markers. Both pass the existing suite's includes()-check.
    const out = redactSpans('x acme-corp-secret y', [rx('acme'), rx('acme-corp-secret')]);
    expect(out).toBe('x [REDACTED] y');
    expect(markerCount(out)).toBe(1);
  });

  it('produces the IDENTICAL result when the same spans are passed in REVERSE order', () => {
    // Bug caught: order-dependence. The order-independence invariant (Fix 2) is the
    // whole reason this primitive computes spans against the original string.
    const patterns = [rx('acme'), rx('acme-corp-secret')];
    const forward = redactSpans('x acme-corp-secret y', patterns);
    const reverse = redactSpans('x acme-corp-secret y', patterns.slice().reverse());
    expect(reverse).toBe(forward);
    expect(reverse).toBe('x [REDACTED] y');
  });

  it('collapses a span FULLY CONTAINED in another into ONE marker', () => {
    // Bug caught: a merge that only handles partial overlap (s <= last[1] but
    // e > last[1]) and forgets Math.max would truncate the enclosing span, splitting
    // one region into two markers and re-emitting the inner text.
    const out = redactSpans('aXbXc', [rx('XbX'), rx('b')]);
    expect(out).toBe('a[REDACTED]c');
    expect(markerCount(out)).toBe(1);
  });

  it('merges two spans that TOUCH at exactly one boundary into ONE marker', () => {
    // Bug caught: an off-by-one in the merge predicate. `s < last[1]` (instead of
    // `s <= last[1]`) leaves adjacent spans unmerged and emits `[REDACTED][REDACTED]`
    // — a doubled sentinel the existing includes()-check accepts as correct.
    const out = redactSpans('abcd', [rx('ab'), rx('cd')]);
    expect(out).toBe('[REDACTED]');
    expect(markerCount(out)).toBe(1);
  });

  it('redacts spans anchored at the START and the END of the string', () => {
    // Bug caught: an off-by-one in the splice prologue/epilogue — slice(cursor, s) with
    // a wrong bound eats or duplicates the boundary character when a span sits at
    // index 0 or runs to line.length.
    const out = redactSpans('acme MID acme', [rx('acme')]);
    expect(out).toBe('[REDACTED] MID [REDACTED]');
    expect(markerCount(out)).toBe(2);
  });
});

describe('redactSpans — pass-through paths', () => {
  // Byte-fidelity fixture built by CONCATENATION from explicit code units — never via
  // JSON.stringify, whose output cannot carry a raw control byte, so a pass-through
  // assert against a stringify-produced fixture could not bite (learnings-index:
  // "byte-for-byte pass-through asserts cannot bite on a JSON.stringify-produced fixture").
  const RAW_FIXTURE =
    'a' +
    String.fromCharCode(9, 0, 13, 10) + // TAB, NUL, CR, LF
    'b' +
    String.fromCharCode(160) + // NBSP
    'c' +
    String.fromCharCode(55357, 56832) + // astral surrogate pair
    'd';
  const EXPECTED_UNITS = [97, 9, 0, 13, 10, 98, 160, 99, 55357, 56832, 100];
  // NB: iterate by code UNIT (s.length), not via Array.from(s, …) — the string
  // iterator walks code POINTS and would collapse the surrogate pair, dropping the
  // trailing unit and making the comparison silently short.
  const codeUnits = (s) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

  it('fixture sanity: the byte-fidelity fixture carries the control units it claims', () => {
    // Bug caught: a fixture that silently lost its control bytes (e.g. via an editor
    // normalising them) would make BOTH pass-through tests below vacuous.
    expect([...RAW_FIXTURE].length).toBe(10); // 10 code POINTS, 11 code units
    expect(codeUnits(RAW_FIXTURE)).toEqual(EXPECTED_UNITS);
  });

  it('returns the input BYTE-IDENTICALLY for an EMPTY pattern list', () => {
    // Bug caught: an early-return path that normalises, trims, or re-encodes the line.
    // This guard is load-bearing: the scanner calls redactSpans over EVERY violation's
    // lineContent, so a lossy pass-through would silently corrupt every CP1–CP10 report
    // on hosts with no confidential-names file configured (the common case).
    const out = redactSpans(RAW_FIXTURE, []);
    expect(out).toBe(RAW_FIXTURE);
    expect(codeUnits(out)).toEqual(EXPECTED_UNITS);
  });

  it('returns the input BYTE-IDENTICALLY when patterns exist but NOTHING matches', () => {
    // Bug caught: this is a DIFFERENT return statement than the empty-list guard above
    // (spans.length === 0 vs patterns.length === 0). A regression in the splice loop
    // that rebuilds the string from slices even with zero merged intervals would be
    // caught here but not by the test above.
    const out = redactSpans(RAW_FIXTURE, [rx('acme'), rx('nomatch')]);
    expect(out).toBe(RAW_FIXTURE);
    expect(codeUnits(out)).toEqual(EXPECTED_UNITS);
  });

  it('TERMINATES on a zero-width pattern instead of spinning forever', { timeout: 2000 }, () => {
    // Bug caught: dropping the `g.lastIndex += 1` zero-width guard turns exec() into an
    // infinite loop. This runs as a BLOCKING .husky/pre-commit stage — a hang there
    // wedges every commit in the repo, and no assertion in the existing suite would
    // report it as a failure (the shard just never finishes).
    expect(redactSpans('abcabc', [rx('(?=a)')])).toBe('abcabc');
    expect(redactSpans('abcabc', [rx('')])).toBe('abcabc');
  });
});

// ---------------------------------------------------------------------------
// Drift guard: shared primitive vs the DELIBERATE inline copy in the scanner
// ---------------------------------------------------------------------------
//
// WHY A SECOND COPY EXISTS AT ALL (and must keep existing):
// `scripts/lib/validate/check-owner-leakage.mjs` is a documented STANDALONE
// SINGLE-FILE vendoring target — `.claude/rules/security.md` § "Owner-Privacy
// Pre-Commit Hook" tells consumer repos to copy exactly that ONE file in as a
// pre-commit stage, and `tests/husky/pre-commit-owner-leakage.test.mjs` cpSync()s
// exactly that one file into a tmp repo. Replacing its inline `redactSpans()`
// with `import { redactSpans } from '../redact-spans.mjs'` made every vendored
// copy throw ERR_MODULE_NOT_FOUND at module load: empty stdout + exit 1 on a
// CLEAN tree, i.e. all three husky cases red and every consumer commit blocked
// (#974). CP11's dynamic-import degrade is no remedy here — an inert CP11 leaks
// nothing, an absent REDACTION prints confidential names into a PUBLIC CI log.
//
// WHAT THIS GUARD BUYS (TV-001 — the bug the rest of the suite cannot see):
// every test above imports the SHARED module, so the inline copy is currently
// unverified by anything except the end-to-end husky stage — which asserts only
// that `[REDACTED]` appears at all. A silent divergence in the inline copy (a
// dropped merge step, a changed marker, a lost zero-width guard) would ship a
// leak-shaped defect on exactly the vendored path with the whole unit suite
// green. This block instantiates the inline copy out of the scanner's SOURCE and
// pins the two implementations BYTE-FOR-BYTE over a generated corpus.
//
// It deliberately does NOT ask the scanner to export the function: an export
// added only for a test is a public-surface widening, and that module carries an
// `isMain` guard whose contract is that importing it runs no scan.

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const SCANNER_PATH = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-owner-leakage.mjs');
const SCANNER_SOURCE = readFileSync(SCANNER_PATH, 'utf8');
const SIGNATURE = 'function redactSpans(line, patterns) {';

/**
 * Extract the inline `redactSpans` definition from the scanner's raw source.
 * Brace-balanced from the signature's `{`, which is exact for this function
 * (its body contains no braces inside string literals, comments, or regex
 * literals). Any failure to locate/balance THROWS — a drift guard that cannot
 * find its subject must go red, never silently pass.
 * @param {string} src raw scanner source
 * @returns {{ full: string, body: string }}
 */
function extractInlineRedactSpans(src) {
  const sigIdx = src.indexOf(SIGNATURE);
  if (sigIdx === -1) {
    throw new Error(`drift guard: '${SIGNATURE}' not found in ${SCANNER_PATH}`);
  }
  const openIdx = src.indexOf('{', sigIdx);
  let depth = 0;
  let end = -1;
  for (let i = openIdx; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) throw new Error('drift guard: unbalanced braces in inline redactSpans');
  return { full: src.slice(sigIdx, end), body: src.slice(openIdx + 1, end - 1) };
}

const INLINE = extractInlineRedactSpans(SCANNER_SOURCE);
// `new Function` (not a data:-URL import) so no bundler/loader sits between the
// scanner's bytes and the callable under comparison. The body references only
// globals (Array, RegExp, Math), so global-scope compilation is faithful.
const redactSpansInline = new Function('line', 'patterns', INLINE.body);

// --- corpus -----------------------------------------------------------------
// Deterministic PRNG: the corpus must be identical on every run and every host,
// so a failure is reproducible from the seed rather than "sometimes red".
function mulberry32(seed) {
  let a = seed;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Needles chosen so the pool itself contains every hard shape: strict prefixes
// ('acme' < 'acme-corp' < 'acme-corp-secret'), partial overlaps ('abc'/'bcd'),
// containment ('b' inside 'XbX'), and adjacency ('ab'+'cd').
const NEEDLES = [
  'acme',
  'acme-corp',
  'acme-corp-secret',
  'abc',
  'bcd',
  'ab',
  'cd',
  'XbX',
  'b',
  'zeta',
];
// Fillers are arbitrary separators; the only property that matters is variety
// (empty, single-char, whitespace, tab, and one longer dotted token). The dotted
// one is deliberately NOT an RFC1918 address — `check-owner-leakage` CP8 blocks
// private IPs in tracked files, and a fixture has no business tripping a guard
// whose whole job is to keep such literals out of the repo.
const FILLERS = ['', ' ', '-', 'x', 'y', ' v1.2.3 ', 'foo', String.fromCharCode(9)];
const FLAGS = ['i', '', 'g', 'gi'];
const ZERO_WIDTH = ['(?=a)', '', '\\b'];

/** @type {{label: string, line: string, patterns: [string, string][]}[]} */
const CASES = [];

// 1. Named cases — the coverage duty stated explicitly, not left to the RNG.
CASES.push(
  { label: 'overlapping spans', line: 'abcd', patterns: [['abc', 'i'], ['bcd', 'i']] },
  { label: 'nested span', line: 'aXbXc', patterns: [['XbX', 'i'], ['b', 'i']] },
  {
    label: 'needle is a strict prefix of another (forward)',
    line: 'x acme-corp-secret y',
    patterns: [['acme', 'i'], ['acme-corp-secret', 'i']],
  },
  {
    label: 'needle is a strict prefix of another (reversed list)',
    line: 'x acme-corp-secret y',
    patterns: [['acme-corp-secret', 'i'], ['acme', 'i']],
  },
  {
    label: 'three-way prefix chain',
    line: 'acme-corp-secret',
    patterns: [['acme', 'i'], ['acme-corp', 'i'], ['acme-corp-secret', 'i']],
  },
  { label: 'span at string start', line: 'acme tail', patterns: [['acme', 'i']] },
  { label: 'span at string end', line: 'head acme', patterns: [['acme', 'i']] },
  { label: 'span is the whole string', line: 'acme', patterns: [['acme', 'i']] },
  { label: 'adjacent spans touching at one boundary', line: 'abcd', patterns: [['ab', 'i'], ['cd', 'i']] },
  { label: 'empty pattern list', line: 'acme-corp-secret', patterns: [] },
  { label: 'identical duplicate patterns', line: 'acme acme', patterns: [['acme', 'i'], ['acme', 'i']] },
  {
    label: 'identical patterns with differing flags',
    line: 'ACME acme',
    patterns: [['acme', 'i'], ['acme', 'g'], ['acme', 'gi']],
  },
  { label: 'zero-width lookahead only', line: 'abcabc', patterns: [['(?=a)', 'g']] },
  { label: 'empty-source regex only', line: 'abcabc', patterns: [['', 'g']] },
  {
    label: 'zero-width mixed with a real needle',
    line: 'abc acme abc',
    patterns: [['(?=a)', 'g'], ['acme', 'i'], ['\\b', 'g']],
  },
  { label: 'no match at all', line: 'nothing to see here', patterns: [['acme', 'i'], ['zeta', 'i']] },
  { label: 'case-sensitive miss vs case-insensitive hit', line: 'ACME', patterns: [['acme', '']] },
  {
    label: 'control bytes and astral pair around a span',
    line: 'a' + String.fromCharCode(9, 0, 13, 10) + 'acme' + String.fromCharCode(160, 55357, 56832),
    patterns: [['acme', 'i']],
  },
  { label: 'repeated needle, many spans', line: 'acme acme acme acme', patterns: [['acme', 'i']] },
  { label: 'g-flagged input regex (flags branch)', line: 'ab ab ab', patterns: [['ab', 'g']] },
);

// 2. Generated cases — 200 pseudo-random (line, patterns) pairs drawn from the
//    same pool, including reversed / duplicated / zero-width / empty variants.
const rnd = mulberry32(0x9e3779b9);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
for (let i = 0; i < 200; i += 1) {
  const segments = 1 + Math.floor(rnd() * 6);
  let line = '';
  for (let s = 0; s < segments; s += 1) {
    line += pick(FILLERS) + pick(NEEDLES) + pick(FILLERS);
  }
  const patternCount = Math.floor(rnd() * 5); // 0..4 → empty lists occur naturally
  /** @type {[string, string][]} */
  let patterns = [];
  for (let p = 0; p < patternCount; p += 1) patterns.push([pick(NEEDLES), pick(FLAGS)]);
  if (rnd() < 0.2) patterns.push([pick(ZERO_WIDTH), 'g']);
  if (rnd() < 0.2 && patterns.length > 0) patterns.push(patterns[0]);
  if (rnd() < 0.5) patterns = patterns.slice().reverse();
  CASES.push({ label: `generated#${i}`, line, patterns });
}

const build = (patterns) => patterns.map(([source, flags]) => new RegExp(source, flags));
// Fresh RegExp objects per implementation: neither may observe the other's
// lastIndex state, or the comparison would measure the harness, not the code.
const runAll = (impl) =>
  CASES.map((c) => ({ label: c.label, out: impl(c.line, build(c.patterns)) }));

const SHARED_RESULTS = runAll(redactSpans);
const INLINE_RESULTS = runAll(redactSpansInline);

describe('redactSpans — drift guard vs the inline copy in check-owner-leakage.mjs', () => {
  it('finds a real inline definition in the scanner source (guard is not vacuous)', () => {
    // Bug caught: an extraction that silently matched nothing would make the
    // byte-equality test below compare the shared primitive against itself.
    expect(INLINE.full.startsWith(SIGNATURE)).toBe(true);
    expect(INLINE.full.endsWith('}')).toBe(true);
    expect(INLINE.body).toContain('[REDACTED]');
    expect(INLINE.body).toContain('g.lastIndex += 1');
    expect(typeof redactSpansInline).toBe('function');
  });

  it('the scanner does NOT static-import the shared primitive (the #974 regression)', () => {
    // Bug caught: exactly the regression this guard was written for. The husky
    // E2E also catches it, but only by spawning git in a tmp repo; this pins the
    // module-graph shape in microseconds and names the cause in the failure.
    expect(SCANNER_SOURCE).not.toMatch(/^\s*import\s[^\n]*redact-spans\.mjs/m);
  });

  it('carries a corpus of at least 150 inputs covering the hard shapes', () => {
    // Bug caught: a shrunken corpus (someone trimming "slow" cases) silently
    // weakening the equality proof below.
    expect(CASES.length).toBeGreaterThanOrEqual(150);
    const labels = CASES.map((c) => c.label);
    expect(labels).toContain('overlapping spans');
    expect(labels).toContain('nested span');
    expect(labels).toContain('needle is a strict prefix of another (reversed list)');
    expect(labels).toContain('span at string start');
    expect(labels).toContain('span at string end');
    expect(labels).toContain('empty pattern list');
    expect(labels).toContain('identical duplicate patterns');
    expect(labels).toContain('zero-width lookahead only');
  });

  it('actually redacts on most of the corpus (guards against an all-pass-through compare)', () => {
    // Bug caught: a corpus that never triggers a redaction would let two BROKEN
    // implementations agree on doing nothing and still report green.
    const changed = SHARED_RESULTS.filter((r, i) => r.out !== CASES[i].line).length;
    expect(changed).toBeGreaterThanOrEqual(100);
  });

  it('produces BYTE-IDENTICAL output to the shared primitive on every corpus input', () => {
    // Bug caught: ANY divergence between the vendored inline copy and the shared
    // primitive — a changed marker, a dropped merge, an off-by-one splice, a lost
    // zero-width guard. Byte equality, not "both redact somehow".
    expect(INLINE_RESULTS).toEqual(SHARED_RESULTS);
  });
});
