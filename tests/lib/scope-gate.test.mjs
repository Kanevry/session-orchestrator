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
} from '@lib/scope-gate.mjs';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-gate-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scope-gate.mjs (direct import)', () => {
  it('pathMatchesPattern matches a recursive glob', () => {
    expect(pathMatchesPattern('src/a/b/foo.ts', 'src/**/*.ts')).toBe(true);
  });

  it('pathMatchesPattern rejects a non-matching path', () => {
    expect(pathMatchesPattern('docs/readme.md', 'src/**/*.ts')).toBe(false);
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
  it('returns ok when every concrete fileScope entry is covered', () => {
    const result = assertFileScopeSubset(
      ['src/a.ts', 'src/b.ts'],
      ['src/a.ts', 'src/b.ts', 'tests/c.test.ts'],
    );
    expect(result).toEqual({ ok: true, missing: [] });
  });

  it('reports the uncovered entry in missing', () => {
    const result = assertFileScopeSubset(
      ['src/a.ts', 'docs/x.md'],
      ['src/**'],
    );
    expect(result).toEqual({ ok: false, missing: ['docs/x.md'] });
  });

  it('treats a concrete path as covered by a recursive glob (src/a.ts ⊆ src/**)', () => {
    expect(assertFileScopeSubset(['src/a.ts'], ['src/**'])).toEqual({ ok: true, missing: [] });
  });

  it('treats a concrete path as covered by a directory prefix (src/lib/a.mjs ⊆ src/)', () => {
    expect(assertFileScopeSubset(['src/lib/a.mjs'], ['src/'])).toEqual({ ok: true, missing: [] });
  });

  it('covers a glob fileScope entry via exact string presence in allowedPaths', () => {
    expect(assertFileScopeSubset(['src/**'], ['src/**', 'tests/**'])).toEqual({
      ok: true,
      missing: [],
    });
  });

  it('covers a glob fileScope entry via a literal-prefix allowedPaths pattern (src/*.ts ⊆ src/)', () => {
    expect(assertFileScopeSubset(['src/*.ts'], ['src/'])).toEqual({ ok: true, missing: [] });
  });

  it('F1 incident repro: full union covers both sibling agents', () => {
    // Agent A owns src/, Agent B owns tests/. Coordinator writes the UNION.
    const union = ['src/', 'tests/'];
    expect(assertFileScopeSubset(['src/'], union)).toEqual({ ok: true, missing: [] });
    expect(assertFileScopeSubset(['tests/'], union)).toEqual({ ok: true, missing: [] });
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
