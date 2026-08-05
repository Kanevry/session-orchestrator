/**
 * tests/lib/scope-gate.test.mjs
 *
 * Smoke-level direct unit tests for scripts/lib/scope-gate.mjs (A4 barrel split).
 * Verifies the new module path resolves and the scope/pattern primitives behave.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  findScopeFile,
  getEnforcementLevel,
  gateEnabled,
  pathMatchesPattern,
  suggestForScopeViolation,
  assertFileScopeSubset,
  assertTestSiblingCoverage,
  expandTestSiblings,
  testSiblingExpansionApplies,
  TEST_SIBLING_EXPANSION_ROLES,
  extractBashWriteTargets,
} from '@lib/scope-gate.mjs';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-gate-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scope-gate.mjs (direct import)', () => {
  // TV-004 consolidation: the match/reject pair was two its asserting one
  // behaviour of one matcher; parametrized, no assertion lost.
  it.each([
    ['recursive glob matches', 'src/a/b/foo.ts', 'src/**/*.ts', true],
    ['non-matching path rejected', 'docs/readme.md', 'src/**/*.ts', false],
  ])('pathMatchesPattern — %s', (_n, relPath, pattern, expected) => {
    expect(pathMatchesPattern(relPath, pattern)).toBe(expected);
  });

  it('findScopeFile resolves .claude/wave-scope.json', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    const scope = path.join(tmpDir, '.claude', 'wave-scope.json');
    fs.writeFileSync(scope, '{}');
    expect(findScopeFile(tmpDir)).toBe(scope);
  });

  it('findScopeFile returns null when no scope file exists', () => {
    expect(findScopeFile(tmpDir)).toBe(null);
  });

  it('getEnforcementLevel reads the enforcement field and fails closed on parse error', () => {
    const scope = path.join(tmpDir, 'scope.json');
    fs.writeFileSync(scope, JSON.stringify({ enforcement: 'warn' }));
    expect(getEnforcementLevel(scope)).toBe('warn');
    expect(getEnforcementLevel(path.join(tmpDir, 'missing.json'))).toBe('strict');
  });

  it('gateEnabled returns false only when explicitly disabled', () => {
    const scope = path.join(tmpDir, 'scope.json');
    fs.writeFileSync(scope, JSON.stringify({ gates: { commitGuard: false } }));
    expect(gateEnabled(scope, 'commitGuard')).toBe(false);
    expect(gateEnabled(scope, 'otherGate')).toBe(true);
  });

  it('suggestForScopeViolation includes the blocked path and allowed list', () => {
    expect(suggestForScopeViolation('x.ts', 'src/,tests/')).toContain('src/,tests/');
    expect(suggestForScopeViolation('x.ts', '')).toContain('No paths are currently allowed');
  });
});

describe('assertFileScopeSubset (#796 dispatch-time scope-union assertion)', () => {
  // TV-004 consolidation: six separate its each asserted the SAME shape
  // ({ok:true, missing:[]}) for a different coverage route. Parametrized into
  // one table — every (fileScope, allowedPaths) pair below is preserved
  // verbatim, so no coverage route is lost.
  it.each([
    ['concrete entries listed verbatim', ['src/a.ts', 'src/b.ts'], ['src/a.ts', 'src/b.ts', 'tests/c.test.ts']],
    ['concrete path under a recursive glob', ['src/a.ts'], ['src/**']],
    ['concrete path under a directory prefix', ['src/lib/a.mjs'], ['src/']],
    ['glob entry present verbatim', ['src/**'], ['src/**', 'tests/**']],
    ['glob entry via literal-prefix pattern', ['src/*.ts'], ['src/']],
    ['F1 repro — full union covers sibling agent A', ['src/'], ['src/', 'tests/']],
    ['F1 repro — full union covers sibling agent B', ['tests/'], ['src/', 'tests/']],
  ])('covered: %s', (_n, fileScope, allowedPaths) => {
    expect(assertFileScopeSubset(fileScope, allowedPaths)).toEqual({ ok: true, missing: [] });
  });

  it('reports the uncovered entry in missing', () => {
    const result = assertFileScopeSubset(
      ['src/a.ts', 'docs/x.md'],
      ['src/**'],
    );
    expect(result).toEqual({ ok: false, missing: ['docs/x.md'] });
  });

  it('F1 incident repro: union written for only agent A denies agent B (fake-regression guard)', () => {
    // The bug that motivated #796 — the union was (re)written for agent A only.
    // The assertion MUST go RED for agent B, whose tests/ scope is no longer covered.
    const truncatedUnion = ['src/'];
    const result = assertFileScopeSubset(['tests/'], truncatedUnion);
    expect(result).toEqual({ ok: false, missing: ['tests/'] });
  });

  it('non-array inputs fail closed with empty missing (no throw)', () => {
    expect(assertFileScopeSubset(null, ['src/'])).toEqual({ ok: false, missing: [] });
    expect(assertFileScopeSubset(['src/a.ts'], null)).toEqual({ ok: false, missing: [] });
    expect(assertFileScopeSubset(undefined, undefined)).toEqual({ ok: false, missing: [] });
  });

  it('an empty fileScope is a trivial subset', () => {
    expect(assertFileScopeSubset([], ['src/**'])).toEqual({ ok: true, missing: [] });
  });

  it('skips non-string / empty entries without throwing', () => {
    // Malformed entries are not real paths to protect — the CLI validates
    // the array-of-strings shape upstream. The pure function must not throw.
    const result = assertFileScopeSubset(['src/a.ts', '', 42], ['src/**']);
    expect(result).toEqual({ ok: true, missing: [] });
  });

  it('documents the glob-vs-glob design boundary (literal-prefix approximation, no subset calculus)', () => {
    // Both fileScope entries here are GLOB entries (contain `*`). Per the
    // "GLOB-vs-GLOB LIMITATION" docstring, coverage for a glob entry reduces
    // to verbatim presence OR literal-prefix coverage — this is NOT a full
    // glob-⊆-glob subset calculus. The two outcomes below are the DOCUMENTED,
    // deliberate design boundary (not a bug); values pinned empirically
    // (`node -e` against the live module), not derived from subset-calculus
    // intuition.

    // src/**/*.ts vs src/**/*.js: literal prefix is 'src/'. pathMatchesPattern
    // ('src/', 'src/**/*.js') requires a trailing '.js' segment that 'src/'
    // does not have, so this glob pair is (correctly, here) rejected — but
    // only as a side effect of the prefix approximation, not because the
    // matcher proved .ts ⊄ .js in general.
    expect(assertFileScopeSubset(['src/**/*.ts'], ['src/**/*.js'])).toEqual({
      ok: false,
      missing: ['src/**/*.ts'],
    });

    // src/x/*.ts vs src/: literal prefix is 'src/x/', which starts with the
    // directory-prefix pattern 'src/' — approved via the directory-prefix
    // shortcut in pathMatchesPattern, not via any glob-vs-glob subset proof.
    expect(assertFileScopeSubset(['src/x/*.ts'], ['src/'])).toEqual({
      ok: true,
      missing: [],
    });
  });
});

// ---------------------------------------------------------------------------
// extractBashWriteTargets — quote-desync (#970 Task 1)
//
// BUG CAUGHT: before #970 this function carried its OWN Bash lexer that knew
// nothing about comments, here-doc bodies or ANSI-C `$'…'` quotes. A single
// apostrophe in ordinary shell prose wedged it in single-quote state, so every
// later `>` read as quoted text and an OUT-OF-SCOPE WRITE became invisible to
// the wave-scope bash-write-guard. Measured against the old lexer, all three
// fixtures below returned [] while the W0 control returned ['src/secret.ts'] —
// the desync, not a missing feature.
//
// Fixtures mirror the six proven-correct ones in
// tests/hooks/pre-bash-sessions-ledger-guard.test.mjs: three detect-side, three
// load-bearing allow-side (an over-eager fix that "detects" these would trade a
// silent miss for operator noise, which the #800 docblock calls the worse bug).
// ---------------------------------------------------------------------------

describe('extractBashWriteTargets — quote desync (#970)', () => {
  it.each([
    ['W0 control — no quoting at all', 'echo x > src/secret.ts'],
    ['W1 apostrophe in a shell COMMENT', "# don't\necho x > src/secret.ts"],
    ['W2 apostrophe in a HERE-DOC body', "cat <<'EOF' > /tmp/n\nit's fine\nEOF\necho x > src/secret.ts"],
    ['W3 escaped quote in an ANSI-C $\'…\'', "echo $'a\\'b'; echo x > src/secret.ts"],
    ['W4 comment AFTER the redirect', "echo x > src/secret.ts # don't"],
  ])('still sees the out-of-scope write: %s', (_n, command) => {
    expect(extractBashWriteTargets(command)).toEqual(['src/secret.ts']);
  });

  it.each([
    // A quoted apostrophe in a commit message is prose, not a redirect.
    ['apostrophe inside a quoted argument', 'git commit -m "don\'t write src/secret.ts by hand"'],
    // A here-doc BODY that merely NAMES a path is data, not a write to it.
    ['here-doc body naming a path', "cat <<'EOF' > /tmp/n\ndon't hand-write src/secret.ts\nEOF"],
    // A read with an apostrophe in a trailing comment must stay silent.
    ['read + apostrophe in a trailing comment', "wc -l src/secret.ts   # don't forget the record"],
    // Comment TEXT is not a command — stripping it must not resurrect its redirect.
    ['redirect that exists only inside a comment', 'ls -la # echo x > src/secret.ts'],
  ])('reports no write target: %s', (_n, command) => {
    expect(extractBashWriteTargets(command)).toEqual([]);
  });

  // BUG CAUGHT: delegating to the shared tokenizeCommand loses two things it
  // does not model — `(`/`)` as control operators, and the here-doc BODY/arg
  // distinction. Without the local peel + heredoc tracking, `(echo x > y)`
  // silently drops to [] (detection LOSS vs the old lexer) and a one-word
  // here-doc body is reported as a `tee` file target (FALSE POSITIVE).
  it.each([
    ['subshell redirect target survives paren peeling', '(echo x > y.txt)', ['y.txt']],
    ['process substitution is still inert', 'diff a b > >(cat)', []],
    ['a here-doc BODY is never a tee file argument', 'tee out.txt <<EOF\nhello\nEOF', ['out.txt']],
    ['a here-doc redirect target still counts', 'cat <<EOF > out.txt\nhello\nEOF', ['out.txt']],
  ])('shared-lexer delta: %s', (_n, command, expected) => {
    expect(extractBashWriteTargets(command)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// extractBashWriteTargets — wrapper-aware verb resolution (#996.2)
//
// BUG CAUGHT: the pre-#996.2 second pass detected the command head via a lone
// `expectCommand` flag that consumed the FIRST word of the segment. When that
// first word was a transparent wrapper (sudo / env / timeout / nice / command /
// /usr/bin/time), the wrapper was read as the head, mode was cleared, and the
// REAL verb (tee/sed/dd) landed in argument position where it was never checked.
// D4 measured 10 of 10 wrapper forms losing their write target — a detection
// loss in the warn-only (#800) bash-write-guard, the same fail-open class #991
// closed in the ledger guard. The fix reuses splitChainSegments +
// resolveSegmentVerb from command-blocker.mjs (no new grammar): the verb is
// resolved through the shared wrapper table and returned basename-normalized, so
// `/usr/bin/tee` and every wrapper form now resolve their write target.
// ---------------------------------------------------------------------------

describe('extractBashWriteTargets — wrapper-aware verb resolution (#996.2)', () => {
  it.each([
    // The 10 wrapper write-forms D4 measured returning [] against the live module.
    ['sudo prefix on tee', 'sudo tee src/x.ts', ['src/x.ts']],
    ['env VAR= prefix on tee', 'env FOO=1 tee src/x.ts', ['src/x.ts']],
    ['timeout DURATION positional on tee', 'timeout 5 tee src/x.ts', ['src/x.ts']],
    // A wrapper-WRITTEN file: `time -o FILE` truncates FILE while the verb is npm
    // — no redirect operator, no tee/sed/dd head. Harvested via wrapperArgs.writesFile.
    ['time -o wrapper-written report file', '/usr/bin/time -o src/report.txt npm test', ['src/report.txt']],
    ['sudo prefix on sed -i', 'sudo sed -i s/a/b/ src/x.ts', ['src/x.ts']],
    ['nice -n VALUE on tee', 'nice -n 10 tee src/x.ts', ['src/x.ts']],
    ['command builtin prefix on tee', 'command tee src/x.ts', ['src/x.ts']],
    ['sudo -u USER on tee, append flag skipped', 'sudo -u root tee -a src/x.ts', ['src/x.ts']],
    ['absolute /usr/bin/tee resolves via basename', '/usr/bin/tee src/x.ts', ['src/x.ts']],
    ['sudo prefix on dd of=', 'sudo dd if=/dev/zero of=src/x.ts', ['src/x.ts']],
  ])('detects the wrapped write target: %s', (_n, command, expected) => {
    expect(extractBashWriteTargets(command)).toEqual(expected);
  });

  it.each([
    // Controls: the un-wrapped verbs and the redirect channel were already
    // correct pre-#996.2 and MUST stay correct — the fix must not regress them.
    ['bare tee (no wrapper)', 'tee src/x.ts', ['src/x.ts']],
    ['bare sed -i (no wrapper)', 'sed -i s/a/b/ src/x.ts', ['src/x.ts']],
    ['redirect channel is unaffected by the wrapper (`>` never lost the target)', 'sudo echo x > src/out.txt', ['src/out.txt']],
  ])('control — still correct: %s', (_n, command, expected) => {
    expect(extractBashWriteTargets(command)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// expandTestSiblings (#970 Task 2)
//
// BUG CAUGHT (cross-repo, established): an allowedPaths entry listing a
// production file WITHOUT its test sibling mechanically prevents the agent from
// updating that test — three occurrences in one consumer-repo session (an
// unwritable SQL regression test, an unwritable cross-tenant security test, and
// a suite left red because the importing test lay outside every scope).
// ---------------------------------------------------------------------------

/** A role for which expansion fires — see TEST_SIBLING_EXPANSION_ROLES. */
const IMPL = { role: 'Impl-Core' };

describe('expandTestSiblings (#970)', () => {
  it('emits a GLOB sibling, never a computed concrete path', () => {
    // Hit-rate provenance (same-basename glob vs. naive 1:1 mirror) lives in
    // skills/wave-executor/wave-loop.md § Scope Manifest #3 with its measurement
    // footer — not restated here, so there is one number, not two.
    expect(expandTestSiblings(['scripts/lib/scope-gate.mjs'], IMPL)).toEqual([
      'scripts/lib/scope-gate.mjs',
      'tests/**/scope-gate*.test.mjs',
    ]);
    // hooks/_lib is a bucket a 1:1 mirror path gets wrong every time.
    expect(expandTestSiblings(['hooks/_lib/lock-bootstrap.mjs'], IMPL)).toContain(
      'tests/**/lock-bootstrap*.test.mjs',
    );
  });

  // Pass-through behaviours: expansion is ON (role Impl-Core) yet the input must
  // come back unchanged. Each row is a distinct nameable regression.
  it.each([
    // Discovery waves use [] as a DELIBERATE deny-all (#256). If expansion could
    // add a single entry here it would resurrect writes in a read-only wave.
    ['behaviour 1 — an empty scope stays empty (#256 deny-all)', [], []],
    ['behaviour 1 — a non-array input returns []', null, []],
    [
      'behaviour 3 — an absolute Gate-5b grant never sprouts a tests/ sibling',
      ['/Users/someone/Projects/vault/**', '/etc/hosts.mjs'],
      ['/Users/someone/Projects/vault/**', '/etc/hosts.mjs'],
    ],
    [
      'behaviour 4 — no inverse expansion: a test path never adds a production path',
      ['tests/lib/scope-gate.test.mjs', 'tests/hooks/x.test.mjs'],
      ['tests/lib/scope-gate.test.mjs', 'tests/hooks/x.test.mjs'],
    ],
    [
      'glob / directory-prefix entries have no single basename to mirror',
      ['src/**', 'scripts/lib/', 'src/*.mjs'],
      ['src/**', 'scripts/lib/', 'src/*.mjs'],
    ],
  ])('%s', (_n, input, expected) => {
    expect(expandTestSiblings(input, IMPL)).toEqual(expected);
  });

  it('behaviour 2 — idempotent, so the #796 re-union path never shrinks the scope', () => {
    const once = expandTestSiblings(['scripts/lib/a.mjs', 'hooks/b.mjs'], IMPL);
    expect(expandTestSiblings(once, IMPL)).toEqual(once);
    // and the original entries survive expansion in order (append-only)
    expect(once.slice(0, 2)).toEqual(['scripts/lib/a.mjs', 'hooks/b.mjs']);
  });

  it('rules are configuration, not hardcoded — consumer-repo layouts work', () => {
    const opts = {
      ...IMPL,
      rules: [
        { source: '**/*.ts', sibling: '{dir}/__tests__/**' },
        { source: 'supabase/migrations/**', sibling: 'supabase/tests/**' },
      ],
      testPathPatterns: ['**/__tests__/**', 'supabase/tests/**'],
    };
    expect(expandTestSiblings(['src/app/page.ts', 'supabase/migrations/001_init.sql'], opts)).toEqual([
      'src/app/page.ts',
      'supabase/migrations/001_init.sql',
      'src/app/__tests__/**',
      'supabase/tests/**',
    ]);
  });
});

// ---------------------------------------------------------------------------
// behaviour 5 — the ROLE GATE (#970 HIGH-1)
//
// BUG CAUGHT: both prose surfaces tell the coordinator to call
// `expandTestSiblings(unionScopes, { role })`, but `role` was not part of the
// opts contract — it was silently ignored, so expansion fired for EVERY role.
// A coordinator following the snippet in a Quality Phase-1 (Simplification)
// wave handed its agents `tests/**` write access: the "delete a dead export,
// then edit the test to match" failure mode the carve-out exists to prevent.
// The last two rows pin the fail-closed direction (absent/unknown role).
// ---------------------------------------------------------------------------

describe('expandTestSiblings + assertTestSiblingCoverage — role gate (#970)', () => {
  const SCOPE = ['scripts/lib/foo.mjs'];
  const SIBLING = 'tests/**/foo*.test.mjs';

  it.each([
    ['Impl-Core — the incident role', { role: 'Impl-Core' }, true],
    ['Impl-Polish', { role: 'Impl-Polish' }, true],
    ['lower-case spelling of a listed role', { role: 'impl-core' }, true],
    ['  padded spelling of a listed role', { role: ' Impl-Polish ' }, true],
    ['Quality — phase 1 must NOT gain test-write access', { role: 'Quality' }, false],
    ['Discovery — read-only wave', { role: 'Discovery' }, false],
    ['Finalization', { role: 'Finalization' }, false],
    ['an unrecognised role fails closed', { role: 'Impl-Something' }, false],
    ['no role at all fails closed', {}, false],
    ['a non-string role fails closed', { role: 7 }, false],
    ['enabled:true is the explicit opt-in and overrides an unlisted role', { role: 'Quality', enabled: true }, true],
    ['enabled:false is the unconditional opt-out and overrides a listed role', { role: 'Impl-Core', enabled: false }, false],
  ])('%s', (_n, opts, expands) => {
    expect(testSiblingExpansionApplies(opts)).toBe(expands);
    expect(expandTestSiblings(SCOPE, opts).includes(SIBLING)).toBe(expands);
    // The expander and the dispatch-time assertion MUST agree: a check that
    // demands coverage the expander never produced blocks a dispatch for a
    // requirement nobody was told to satisfy (the Quality phase-1 shape).
    expect(assertTestSiblingCoverage(SCOPE, SCOPE, opts).ok).toBe(!expands);
  });

  it('the role list is exported, not restated in prose', () => {
    expect(TEST_SIBLING_EXPANSION_ROLES).toEqual(['Impl-Core', 'Impl-Polish']);
  });
});

describe('assertTestSiblingCoverage (#970 fail-closed wiring)', () => {
  it.each([
    ['verbatim sibling glob in the union', ['scripts/lib/x.mjs', 'tests/**/x*.test.mjs']],
    ['a broad tests/** grant', ['scripts/lib/x.mjs', 'tests/**']],
    ['a concrete test file that IS the sibling', ['scripts/lib/x.mjs', 'tests/lib/x.test.mjs']],
  ])('covered: %s', (_n, allowedPaths) => {
    expect(assertTestSiblingCoverage(['scripts/lib/x.mjs'], allowedPaths, IMPL)).toEqual({
      ok: true,
      missing: [],
    });
  });

  it('#970 repro — a production-only grant is reported missing (this is the bug)', () => {
    expect(assertTestSiblingCoverage(['scripts/lib/x.mjs'], ['scripts/lib/x.mjs'], IMPL)).toEqual({
      ok: false,
      missing: ['tests/**/x*.test.mjs'],
    });
  });

  it('fails closed on non-array input, before the role gate is consulted', () => {
    expect(assertTestSiblingCoverage(null, ['tests/**'], IMPL)).toEqual({ ok: false, missing: [] });
    expect(assertTestSiblingCoverage(['scripts/lib/x.mjs'], null, IMPL)).toEqual({
      ok: false,
      missing: [],
    });
  });
});
