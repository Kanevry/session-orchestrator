/**
 * tests/lib/hardening.test.mjs
 *
 * Vitest unit tests for scripts/lib/hardening.mjs (issue #135).
 * Covers all 10 exports with behavioral assertions.
 *
 * Security note: the F-01 shell-operator bypass regression block encodes
 * attack strings fixed in commit 6cfd081 (HIGH finding, CWE-77/184).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  assertNodeVersion,
  assertDepInstalled,
  checkEnvironment,
  findScopeFile,
  getEnforcementLevel,
  gateEnabled,
  pathMatchesPattern,
  commandMatchesBlocked,
  suggestForScopeViolation,
  suggestForCommandBlock,
} from '../../scripts/lib/hardening.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hardening-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeScopeFile(dir, data) {
  const subdir = path.join(tmpDir, dir);
  fs.mkdirSync(subdir, { recursive: true });
  const filePath = path.join(subdir, 'wave-scope.json');
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
  return filePath;
}

function writeRawScopeFile(dir, raw) {
  const subdir = path.join(tmpDir, dir);
  fs.mkdirSync(subdir, { recursive: true });
  const filePath = path.join(subdir, 'wave-scope.json');
  fs.writeFileSync(filePath, raw, 'utf8');
  return filePath;
}

// ---------------------------------------------------------------------------
// 1. assertNodeVersion
// ---------------------------------------------------------------------------

describe('assertNodeVersion', () => {
  it('resolves without throwing when current Node meets the default min (20)', async () => {
    await expect(assertNodeVersion()).resolves.toBeUndefined();
  });

  it('resolves without throwing when passing the exact current major version', async () => {
    const currentMajor = parseInt(process.versions.node.split('.')[0], 10);
    await expect(assertNodeVersion(currentMajor)).resolves.toBeUndefined();
  });

  it('throws when min is 99 (unreachably high)', async () => {
    await expect(assertNodeVersion(99)).rejects.toThrow();
  });

  it('error message mentions "Node" when version requirement is not met', async () => {
    await expect(assertNodeVersion(99)).rejects.toThrow(/Node/);
  });

  it('error message includes the minimum version number when requirement is not met', async () => {
    await expect(assertNodeVersion(99)).rejects.toThrow(/99/);
  });
});

// ---------------------------------------------------------------------------
// 2. assertDepInstalled
// ---------------------------------------------------------------------------

describe('assertDepInstalled', () => {
  it('returns true for "prettier" which is installed as a devDependency', async () => {
    // Using 'prettier' rather than 'vitest' — vitest 4's dynamic-import path
    // has side-effects that can fail on Windows runners when `import()` is
    // invoked from within a vitest worker (#280 regression).
    const result = await assertDepInstalled('prettier');
    expect(result).toBe(true);
  });

  it('returns false for a nonexistent package without throwing', async () => {
    const result = await assertDepInstalled('nonexistent-package-xyz123');
    expect(result).toBe(false);
  });

  it('does not throw for a nonexistent package', async () => {
    await expect(assertDepInstalled('nonexistent-package-xyz123')).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. checkEnvironment
// ---------------------------------------------------------------------------

describe('checkEnvironment', () => {
  it('returns an object with ok, missing, and warnings keys', async () => {
    const result = await checkEnvironment();
    expect(result).toHaveProperty('ok');
    expect(result).toHaveProperty('missing');
    expect(result).toHaveProperty('warnings');
  });

  it('ok is a boolean', async () => {
    const result = await checkEnvironment();
    expect(typeof result.ok).toBe('boolean');
  });

  it('missing is an array', async () => {
    const result = await checkEnvironment();
    expect(Array.isArray(result.missing)).toBe(true);
  });

  it('warnings is an array', async () => {
    const result = await checkEnvironment();
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it('ok is true on the current system (Node >= 20 is a test prerequisite)', async () => {
    const result = await checkEnvironment();
    // The CLAUDE.md declares Node 20+ as dev prerequisite; tests run in Node 20+
    expect(result.ok).toBe(true);
  });

  it('missing array is empty on the current system', async () => {
    const result = await checkEnvironment();
    expect(result.missing).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. findScopeFile
// ---------------------------------------------------------------------------

describe('findScopeFile', () => {
  it('returns null when no wave-scope.json exists anywhere under the root', () => {
    const result = findScopeFile(tmpDir);
    expect(result).toBeNull();
  });

  it('returns the absolute path to .claude/wave-scope.json when only that exists', () => {
    writeScopeFile('.claude', { enforcement: 'warn' });
    const result = findScopeFile(tmpDir);
    expect(result).toBe(path.join(tmpDir, '.claude', 'wave-scope.json'));
  });

  it('returns the absolute path to .codex/wave-scope.json when only that exists', () => {
    writeScopeFile('.codex', { enforcement: 'strict' });
    const result = findScopeFile(tmpDir);
    expect(result).toBe(path.join(tmpDir, '.codex', 'wave-scope.json'));
  });

  it('returns the absolute path to .cursor/wave-scope.json when only that exists', () => {
    writeScopeFile('.cursor', { enforcement: 'off' });
    const result = findScopeFile(tmpDir);
    expect(result).toBe(path.join(tmpDir, '.cursor', 'wave-scope.json'));
  });

  it('returns .codex path when both .codex and .claude exist (codex > claude precedence)', () => {
    writeScopeFile('.claude', { enforcement: 'warn' });
    writeScopeFile('.codex', { enforcement: 'strict' });
    const result = findScopeFile(tmpDir);
    expect(result).toBe(path.join(tmpDir, '.codex', 'wave-scope.json'));
  });

  it('returns .cursor path when all three exist (.cursor > .codex > .claude precedence)', () => {
    writeScopeFile('.claude', { enforcement: 'warn' });
    writeScopeFile('.codex', { enforcement: 'strict' });
    writeScopeFile('.cursor', { enforcement: 'off' });
    const result = findScopeFile(tmpDir);
    expect(result).toBe(path.join(tmpDir, '.cursor', 'wave-scope.json'));
  });

  it('returns an absolute path (not a relative path)', () => {
    writeScopeFile('.claude', {});
    const result = findScopeFile(tmpDir);
    expect(path.isAbsolute(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. getEnforcementLevel
// ---------------------------------------------------------------------------

describe('getEnforcementLevel', () => {
  it('returns "strict" when enforcement field is "strict"', () => {
    const filePath = writeScopeFile('.claude', { enforcement: 'strict' });
    expect(getEnforcementLevel(filePath)).toBe('strict');
  });

  it('returns "warn" when enforcement field is "warn"', () => {
    const filePath = writeScopeFile('.claude', { enforcement: 'warn' });
    expect(getEnforcementLevel(filePath)).toBe('warn');
  });

  it('returns "off" when enforcement field is "off"', () => {
    const filePath = writeScopeFile('.claude', { enforcement: 'off' });
    expect(getEnforcementLevel(filePath)).toBe('off');
  });

  it('returns "strict" (fail-closed default) when enforcement field is missing', () => {
    const filePath = writeScopeFile('.claude', { gates: {} });
    expect(getEnforcementLevel(filePath)).toBe('strict');
  });

  it('returns "strict" (fail-closed) when JSON is malformed', () => {
    const filePath = writeRawScopeFile('.claude', '{ broken json ,,, }');
    expect(getEnforcementLevel(filePath)).toBe('strict');
  });

  it('returns "strict" (fail-closed) when file does not exist', () => {
    const nonexistent = path.join(tmpDir, '.claude', 'nonexistent.json');
    expect(getEnforcementLevel(nonexistent)).toBe('strict');
  });
});

// ---------------------------------------------------------------------------
// 6. gateEnabled
// ---------------------------------------------------------------------------

describe('gateEnabled', () => {
  it('returns false when gate is explicitly set to false', () => {
    const filePath = writeScopeFile('.claude', { gates: { 'path-guard': false } });
    expect(gateEnabled(filePath, 'path-guard')).toBe(false);
  });

  it('returns true when gate is explicitly set to true', () => {
    const filePath = writeScopeFile('.claude', { gates: { 'path-guard': true } });
    expect(gateEnabled(filePath, 'path-guard')).toBe(true);
  });

  it('returns true (default-on) when gate key is absent from gates object', () => {
    const filePath = writeScopeFile('.claude', { gates: {} });
    expect(gateEnabled(filePath, 'path-guard')).toBe(true);
  });

  it('returns true (default-on) when gates field is absent from JSON entirely', () => {
    const filePath = writeScopeFile('.claude', { enforcement: 'strict' });
    expect(gateEnabled(filePath, 'path-guard')).toBe(true);
  });

  it('returns true (default-on, backward compat) when JSON is malformed', () => {
    const filePath = writeRawScopeFile('.claude', '{ broken json }');
    expect(gateEnabled(filePath, 'path-guard')).toBe(true);
  });

  it('returns true (default-on) for command-guard when it is absent', () => {
    const filePath = writeScopeFile('.claude', { gates: { 'path-guard': false } });
    expect(gateEnabled(filePath, 'command-guard')).toBe(true);
  });

  it('returns false only for the explicitly-false gate, not for other gate names', () => {
    const filePath = writeScopeFile('.claude', { gates: { 'path-guard': false } });
    expect(gateEnabled(filePath, 'command-guard')).toBe(true);
    expect(gateEnabled(filePath, 'path-guard')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. pathMatchesPattern — parity table + extras
// ---------------------------------------------------------------------------

describe('pathMatchesPattern', () => {
  describe('parity table from baseline spec Part 4', () => {
    it.each([
      ['src/foo.ts',            'src/',              true],
      ['src/nested/foo.ts',     'src/',              true],
      ['lib/foo.ts',            'src/',              false],
      ['src/foo.ts',            'src/**/*.ts',       true],
      ['src/nested/deep/foo.ts','src/**/*.ts',       true],
      ['src/foo.js',            'src/**/*.ts',       false],
      ['src/foo.ts',            'src/*.ts',          true],
      ['src/nested/foo.ts',     'src/*.ts',          false],
      ['docs/README.md',        'docs/README.md',    true],
      ['docs/README.md',        'docs/CHANGELOG.md', false],
    ])('pathMatchesPattern(%s, %s) === %s', (rel, pattern, expected) => {
      expect(pathMatchesPattern(rel, pattern)).toBe(expected);
    });
  });

  describe('edge cases', () => {
    it('returns false for empty pattern', () => {
      expect(pathMatchesPattern('src/foo.ts', '')).toBe(false);
    });

    it('returns true for exact dotfile match (.gitignore vs .gitignore)', () => {
      expect(pathMatchesPattern('.gitignore', '.gitignore')).toBe(true);
    });

    it('returns false when dotfile does not match a different filename', () => {
      expect(pathMatchesPattern('.gitignore', '.npmignore')).toBe(false);
    });
  });

  describe('regex-injection resistance (patterns with regex meta-chars treated as literals)', () => {
    it('treats "." in pattern as literal dot, not any-char regex', () => {
      // src/.+  should NOT match src/foo.ts as a regex (src/ + any + wildcard)
      // It should be treated as glob-literal: src/ then literal dot then literal +
      expect(pathMatchesPattern('src/foo.ts', 'src/.+')).toBe(false);
    });

    it('treats "(" and ")" as literal characters, not regex groups', () => {
      // src/(?:a) should only match a path literally containing "(?:a)"
      expect(pathMatchesPattern('src/a', 'src/(?:a)')).toBe(false);
    });

    it('treats "[a-z]" as literal characters in pattern, not a character class', () => {
      // src/[a-z] should not match src/b via regex character class
      expect(pathMatchesPattern('src/b', 'src/[a-z]')).toBe(false);
    });

    it('literal pattern src/[a-z] matches only path that contains literal [a-z]', () => {
      expect(pathMatchesPattern('src/[a-z]', 'src/[a-z]')).toBe(true);
    });
  });

  describe('** glob expansion (issue #220 regression)', () => {
    it.each([
      // [relPath, pattern, expected]
      ['tests/lib/foo.test.mjs', 'tests/**',           true],
      ['tests/foo.mjs',          'tests/**',           true],
      ['src/foo.mjs',            'tests/**',           false],
      ['a/b/src/foo.mjs',        '**/src/foo.mjs',     true],
      ['src/foo.mjs',            '**/src/foo.mjs',     true],
      ['src/a/b/foo.test.mjs',   'src/**/*.test.mjs',  true],
      ['src/a/b/foo.test.js',    'src/**/*.test.mjs',  false],
      ['src/nested/foo.mjs',     'src/*.mjs',          false],
      ['src/foo.mjs',            'src/*.mjs',          true],
    ])('pathMatchesPattern(%s, %s) === %s', (rel, pattern, expected) => {
      expect(pathMatchesPattern(rel, pattern)).toBe(expected);
    });
  });
});

// ---------------------------------------------------------------------------
// 8. commandMatchesBlocked — baseline table + F-01 regression
// ---------------------------------------------------------------------------

describe('commandMatchesBlocked', () => {
  describe('baseline cases from spec', () => {
    it.each([
      ['rm -rf /',               'rm -rf',           true],
      ['rm -rf',                 'rm -rf',           true],
      ['rm-rf /home',            'rm -rf',           false],
      ['srm -rf /home',          'rm -rf',           false],
      ['echo rm -rf /',          'rm -rf',           true],
      ['ls -la',                 'rm -rf',           false],
      ['git push --force origin','git push --force', true],
      ['git push -f origin',     'git push --force', false],
    ])('commandMatchesBlocked(%s, %s) === %s', (command, pattern, expected) => {
      expect(commandMatchesBlocked(command, pattern)).toBe(expected);
    });
  });

  describe('commandMatchesBlocked — F-01 shell-operator bypass regression', () => {
    // These attack strings were the HIGH security finding (CWE-77/184) fixed in
    // commit 6cfd081. The previous implementation used \s boundary only, allowing
    // bypass via shell operators that don't produce whitespace.
    it.each([
      // semicolon-separated
      ['ls;rm -rf /',            'rm -rf', true],
      // double-ampersand
      ['ls&&rm -rf /',           'rm -rf', true],
      // pipe-or
      ['ls||rm -rf /',           'rm -rf', true],
      // subshell parens
      ['(rm -rf /)',             'rm -rf', true],
      // backtick subshell
      ['`rm -rf /`',             'rm -rf', true],
      // $() command substitution ($ is not a boundary but pattern follows space-free)
      ['$(rm -rf /)',            'rm -rf', true],
      // semicolon with leading word
      ['echo hi;rm -rf /',      'rm -rf', true],
    ])('F-01 bypass attempt: commandMatchesBlocked(%s, %s) === %s', (command, pattern, expected) => {
      expect(commandMatchesBlocked(command, pattern)).toBe(expected);
    });
  });

  describe('additional edge cases', () => {
    it('returns false for empty pattern', () => {
      expect(commandMatchesBlocked('rm -rf /', '')).toBe(false);
    });

    it('is case-sensitive — "DROP TABLE" pattern does not match lowercase command', () => {
      expect(commandMatchesBlocked('drop table users', 'DROP TABLE')).toBe(false);
    });

    it('matches "DROP TABLE" pattern against exact-case command', () => {
      expect(commandMatchesBlocked('DROP TABLE users', 'DROP TABLE')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 9. suggestForScopeViolation
// ---------------------------------------------------------------------------

describe('suggestForScopeViolation', () => {
  it('mentions "No paths are currently allowed" when allowedCsv is empty string', () => {
    const result = suggestForScopeViolation('src/foo.ts', '');
    expect(result).toContain('No paths are currently allowed');
  });

  it('includes the blocked path in the message when allowedCsv is non-empty', () => {
    const result = suggestForScopeViolation('src/foo.ts', 'lib/, tests/');
    expect(result).toContain('src/foo.ts');
  });

  it('includes the allowed paths list in the message when allowedCsv is non-empty', () => {
    const result = suggestForScopeViolation('src/foo.ts', 'lib/, tests/');
    expect(result).toContain('lib/, tests/');
  });

  it('returns a non-empty string in all cases', () => {
    expect(suggestForScopeViolation('x', '').length).toBeGreaterThan(0);
    expect(suggestForScopeViolation('x', 'y').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 10. suggestForCommandBlock
// ---------------------------------------------------------------------------

describe('suggestForCommandBlock', () => {
  it('mentions "destructive" (case-insensitive) for "rm -rf" pattern', () => {
    const result = suggestForCommandBlock('rm -rf');
    expect(result.toLowerCase()).toContain('destructive');
  });

  it('mentions "Force-push" for "git push --force" pattern', () => {
    const result = suggestForCommandBlock('git push --force');
    expect(result).toContain('Force-push');
  });

  it('mentions "reset" or "stash" for "git reset --hard" pattern', () => {
    const result = suggestForCommandBlock('git reset --hard');
    expect(result.toLowerCase()).toMatch(/reset|stash/);
  });

  it('mentions "discard" for "git checkout -- ." pattern', () => {
    const result = suggestForCommandBlock('git checkout -- .');
    expect(result.toLowerCase()).toContain('discard');
  });

  it('includes the pattern itself in the message for unknown patterns', () => {
    const result = suggestForCommandBlock('some-unknown-cmd --flag');
    expect(result).toContain('some-unknown-cmd --flag');
  });

  it('returns a non-empty string for any pattern', () => {
    expect(suggestForCommandBlock('anything').length).toBeGreaterThan(0);
  });
});
