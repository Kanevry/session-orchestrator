/**
 * tests/lib/path-utils.test.mjs
 *
 * Security-critical tests for path-utils.mjs (CWE-23 path traversal prevention).
 * Covers all attack patterns documented in CWE_23_ATTACK_PATTERNS.
 *
 * Issue #130 — Wave 4 (Quality) of v3.0.0 migration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
// Namespace import (not default) so vi.spyOn(fs, 'realpathSync') in the
// canonicalizeRoot describe block can modify the same module namespace
// object the SUT's named import is live-bound to (#549 G1).
import * as fs from 'node:fs';

// vi.mock('node:fs', ...) is hoisted by vitest BEFORE the SUT import below.
// Returning { ...actual } is a passthrough (no behaviour change for the
// existing tests), but it enables vi.spyOn(fs, 'realpathSync') in the
// canonicalizeRoot describe block to override the SUT's named import via
// the ES module live binding. See tests/lib/vault-mirror/process.test.mjs
// for the same pattern (#549 G1, post-W3-P2 contract).
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return { ...actual };
});

import {
  isPathInside,
  relativeFromRoot,
  normalizeCase,
  sameDrive,
  CWE_23_ATTACK_PATTERNS,
  validatePathInsideProject,
} from '@lib/path-utils.mjs';

// ── isPathInside — positive (descendant returns true) ─────────────────────────

describe('isPathInside — positive: descendant returns true', () => {
  it('direct child returns true', () => {
    expect(isPathInside('/home/user/foo', '/home/user')).toBe(true);
  });

  it('deeply nested descendant returns true', () => {
    expect(isPathInside('/a/b/c/d/e', '/a/b')).toBe(true);
  });

  it('single-level child of root-level parent returns true', () => {
    expect(isPathInside('/home/user/docs/file.txt', '/home/user/docs')).toBe(true);
  });
});

// ── isPathInside — boundary (exact same path) ─────────────────────────────────

describe('isPathInside — boundary: same path is not a descendant', () => {
  it('exact same path returns false', () => {
    expect(isPathInside('/home/user', '/home/user')).toBe(false);
  });
});

// ── isPathInside — CWE-23 rejections ─────────────────────────────────────────

describe('isPathInside — CWE-23: path traversal attacks return false', () => {
  it('relative escape via .. returns false (CWE-23: relative-escape)', () => {
    // /home/user/../other resolves to /home/other — outside /home/user
    expect(isPathInside('/home/user/../other', '/home/user')).toBe(false);
  });

  it('deeper relative escape via multiple .. returns false (CWE-23: relative-escape)', () => {
    // /home/user/a/../../b resolves to /home/b — outside /home/user
    expect(isPathInside('/home/user/a/../../b', '/home/user')).toBe(false);
  });

  it('absolute path outside parent returns false (CWE-23: absolute-escape)', () => {
    // /etc/passwd is completely outside /home/user
    expect(isPathInside('/etc/passwd', '/home/user')).toBe(false);
  });

  it('prefix-match that is not a descendant returns false (CWE-23: prefix-match-confusion)', () => {
    // /home/userx/foo must NOT be treated as inside /home/user
    // because 'user' is a prefix of 'userx' but not a directory boundary
    expect(isPathInside('/home/userx/foo', '/home/user')).toBe(false);
  });

  it('parent directory itself is not inside itself (boundary integrity)', () => {
    // Edge case: the parent of /home/user is /home — /home/user is not inside /home/user
    expect(isPathInside('/home', '/home/user')).toBe(false);
  });

  it('sibling directory returns false (CWE-23: absolute-escape)', () => {
    expect(isPathInside('/home/attacker', '/home/user')).toBe(false);
  });
});

// ── isPathInside — input validation ──────────────────────────────────────────

describe('isPathInside — input validation: throws TypeError on bad input', () => {
  it('empty string child throws TypeError with "non-empty" in message', () => {
    expect(() => isPathInside('', '/home')).toThrowError(/non-empty/);
  });

  it('empty string parent throws TypeError with "non-empty" in message', () => {
    expect(() => isPathInside('/foo', '')).toThrowError(/non-empty/);
  });

  it('null byte in child path throws TypeError with "null byte" in message', () => {
    expect(() => isPathInside('/a\x00', '/home')).toThrowError(/null byte/);
  });

  it('null byte in parent path throws TypeError with "null byte" in message', () => {
    expect(() => isPathInside('/a/b', '/home\x00')).toThrowError(/null byte/);
  });

  it('null child throws TypeError', () => {
    expect(() => isPathInside(null, '/home')).toThrow(TypeError);
  });

  it('undefined child throws TypeError', () => {
    expect(() => isPathInside(undefined, '/home')).toThrow(TypeError);
  });

  it('numeric child throws TypeError', () => {
    expect(() => isPathInside(42, '/home')).toThrow(TypeError);
  });

  it('object child throws TypeError', () => {
    expect(() => isPathInside({}, '/home')).toThrow(TypeError);
  });

  it('null parent throws TypeError', () => {
    expect(() => isPathInside('/foo', null)).toThrow(TypeError);
  });
});

// ── isPathInside — Windows-specific (conditional on process.platform) ─────────

describe('isPathInside — Windows-specific tests', () => {
  it.skipIf(process.platform !== 'win32')(
    'UNC path child rejected when parent is a local drive (CWE-23: unc-path)',
    () => {
      // \\server\share\foo is a UNC path; C:\Users is a local drive path
      // They are in different namespaces — should never be considered "inside" each other
      expect(isPathInside('\\\\server\\share\\foo', 'C:\\Users')).toBe(false);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'cross-drive path returns false (D: is not inside C:)',
    () => {
      expect(isPathInside('D:\\Users\\foo', 'C:\\Users')).toBe(false);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'same drive descendant returns true on Windows',
    () => {
      expect(isPathInside('C:\\Users\\dev\\project\\src', 'C:\\Users\\dev\\project')).toBe(true);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'Windows drive letter case difference does not affect result (CWE-23: drive-case)',
    () => {
      // c: vs C: should be treated as the same drive
      expect(isPathInside('C:\\Users\\dev\\file.txt', 'c:\\Users\\dev')).toBe(true);
    },
  );
});

// ── relativeFromRoot ──────────────────────────────────────────────────────────

describe('relativeFromRoot — basic behaviour', () => {
  it('same path returns "." (dot, not empty string)', () => {
    expect(relativeFromRoot('/home/user', '/home/user')).toBe('.');
  });

  it('descendant returns relative path using platform separator', () => {
    const result = relativeFromRoot('/home/user', '/home/user/foo/bar');
    // On POSIX: 'foo/bar', on Windows (if tested with POSIX paths): may vary
    // Normalise by joining with platform sep to make the assertion cross-platform
    expect(result).toBe(['foo', 'bar'].join(path.sep));
  });

  it('path outside root returns null', () => {
    expect(relativeFromRoot('/home/user', '/etc')).toBeNull();
  });

  it('parent directory of root returns null', () => {
    expect(relativeFromRoot('/home/user', '/home')).toBeNull();
  });

  it('sibling directory returns null', () => {
    expect(relativeFromRoot('/home/user', '/home/other')).toBeNull();
  });

  it('"." is distinct from null — same-path is truthy, outside is null', () => {
    const same = relativeFromRoot('/x', '/x');
    const outside = relativeFromRoot('/x', '/y');
    expect(same).toBe('.');
    expect(outside).toBeNull();
    // Verify the distinction matters: '.' is truthy, null is falsy
    expect(same).toBeTruthy();
    expect(outside).toBeNull();
  });

  it('immediate child returns its basename only', () => {
    expect(relativeFromRoot('/home/user', '/home/user/readme.txt')).toBe('readme.txt');
  });
});

// ── normalizeCase ─────────────────────────────────────────────────────────────

describe('normalizeCase — platform behaviour', () => {
  it('on non-Windows: returns path unchanged (passthrough)', () => {
    // This assertion is only correct on non-Windows; on Windows it would be lowercased.
    // We test the POSIX behaviour explicitly.
    if (process.platform !== 'win32') {
      expect(normalizeCase('Foo/Bar')).toBe('Foo/Bar');
    }
  });

  it('on non-Windows: mixed case is preserved', () => {
    if (process.platform !== 'win32') {
      expect(normalizeCase('/Home/User/SomeFile.txt')).toBe('/Home/User/SomeFile.txt');
    }
  });

  it.skipIf(process.platform !== 'win32')(
    'on Windows: lowercases the entire path',
    () => {
      expect(normalizeCase('C:\\Users\\FOO')).toBe('c:\\users\\foo');
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'on Windows: drive letter is lowercased',
    () => {
      expect(normalizeCase('C:\\path')).toBe('c:\\path');
    },
  );
});

// ── sameDrive ─────────────────────────────────────────────────────────────────

describe('sameDrive — platform behaviour', () => {
  it('on POSIX: always returns true (no drive letters)', () => {
    if (process.platform !== 'win32') {
      expect(sameDrive('/a', '/b')).toBe(true);
      expect(sameDrive('/home/user', '/etc/passwd')).toBe(true);
      expect(sameDrive('/', '/very/deep/path')).toBe(true);
    }
  });

  it.skipIf(process.platform !== 'win32')(
    'on Windows: same drive returns true',
    () => {
      expect(sameDrive('C:\\Users\\foo', 'C:\\Windows')).toBe(true);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'on Windows: different drives return false (CWE-23: cross-drive)',
    () => {
      expect(sameDrive('C:\\a', 'D:\\a')).toBe(false);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'on Windows: drive letter case difference is normalised (C: == c:)',
    () => {
      expect(sameDrive('C:\\path', 'c:\\other')).toBe(true);
    },
  );
});

// ── CWE_23_ATTACK_PATTERNS ────────────────────────────────────────────────────

describe('CWE_23_ATTACK_PATTERNS — taxonomy completeness', () => {
  it('is an array', () => {
    expect(Array.isArray(CWE_23_ATTACK_PATTERNS)).toBe(true);
  });

  it('contains "relative-escape"', () => {
    expect(CWE_23_ATTACK_PATTERNS).toContain('relative-escape');
  });

  it('contains "absolute-escape"', () => {
    expect(CWE_23_ATTACK_PATTERNS).toContain('absolute-escape');
  });

  it('contains "null-byte-injection"', () => {
    expect(CWE_23_ATTACK_PATTERNS).toContain('null-byte-injection');
  });

  it('contains "unc-path"', () => {
    expect(CWE_23_ATTACK_PATTERNS).toContain('unc-path');
  });

  it('contains "prefix-match-confusion"', () => {
    expect(CWE_23_ATTACK_PATTERNS).toContain('prefix-match-confusion');
  });

  it('has at least 5 documented patterns (security-critical module must be thorough)', () => {
    expect(CWE_23_ATTACK_PATTERNS.length).toBeGreaterThanOrEqual(5);
  });

  it('all entries are non-empty strings', () => {
    for (const pattern of CWE_23_ATTACK_PATTERNS) {
      expect(typeof pattern).toBe('string');
      expect(pattern.length).toBeGreaterThan(0);
    }
  });
});

// ── Integration: isPathInside + relativeFromRoot agree ────────────────────────

describe('integration: isPathInside and relativeFromRoot are consistent', () => {
  it('when isPathInside is true, relativeFromRoot returns non-null non-dot', () => {
    const child = '/home/user/project/src/index.js';
    const parent = '/home/user/project';
    expect(isPathInside(child, parent)).toBe(true);
    const rel = relativeFromRoot(parent, child);
    expect(rel).not.toBeNull();
    expect(rel).not.toBe('.');
  });

  it('when isPathInside is false (sibling), relativeFromRoot returns null', () => {
    const sibling = '/home/other';
    const parent = '/home/user';
    expect(isPathInside(sibling, parent)).toBe(false);
    expect(relativeFromRoot(parent, sibling)).toBeNull();
  });

  it('when paths are equal, isPathInside is false and relativeFromRoot returns "."', () => {
    const p = '/home/user';
    expect(isPathInside(p, p)).toBe(false);
    expect(relativeFromRoot(p, p)).toBe('.');
  });
});

// ── validatePathInsideProject ─────────────────────────────────────────────────

describe('validatePathInsideProject — Phase 1 lexical + Phase 2 realpath guard', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-utils-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // (a) lexical pass + path does not exist → ok: true, realPath: undefined
  it('non-existent path inside root: ok=true, realPath undefined, lexicalPath resolved', () => {
    const result = validatePathInsideProject('subdir/file.txt', tmpDir);
    expect(result.ok).toBe(true);
    expect(result.realPath).toBeUndefined();
    expect(result.lexicalPath).toBe(path.resolve(tmpDir, 'subdir/file.txt'));
  });

  // (b) lexical pass + realpath pass → ok: true, realPath set
  it('existing file inside root: ok=true, realPath is set to resolved path', () => {
    // Use realpath of tmpDir as root: on macOS /var is a symlink to /private/var,
    // so realpathSync resolves the root to avoid Phase 2 false-positive rejections.
    const realRoot = fs.realpathSync(tmpDir);
    const subDir = path.join(realRoot, 'subdir');
    fs.mkdirSync(subDir);
    const filePath = path.join(subDir, 'file.txt');
    fs.writeFileSync(filePath, 'hello');
    const result = validatePathInsideProject('subdir/file.txt', realRoot);
    expect(result.ok).toBe(true);
    expect(result.realPath).toBe(filePath);
    expect(result.lexicalPath).toBe(filePath);
  });

  // (c) lexical pass + realpath ESCAPE via symlink → ok: false, reason: 'symlink'
  it.skipIf(process.platform === 'win32')(
    'symlink inside root pointing outside: ok=false, reason=symlink',
    () => {
      // Use realpath of tmpDir to avoid macOS /var → /private/var symlink confusion
      const realRoot = fs.realpathSync(tmpDir);
      const linkPath = path.join(realRoot, 'escape-link');
      fs.symlinkSync('/etc', linkPath);
      const result = validatePathInsideProject('escape-link', realRoot);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('symlink');
    },
  );

  // (d) lexical fail via relative escape
  it('relative escape via ../../: ok=false, reason=lexical', () => {
    const result = validatePathInsideProject('../../../etc/passwd', tmpDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('lexical');
  });

  // (e) lexical fail via absolute path outside root
  it('absolute path outside root (/etc/passwd): ok=false, reason=lexical', () => {
    const result = validatePathInsideProject('/etc/passwd', tmpDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('lexical');
  });

  // (f) empty string input
  it('empty string input: ok=false, reason=input', () => {
    const result = validatePathInsideProject('', tmpDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('input');
    expect(result.error).toMatch(/non-empty/);
  });

  // (g) null-byte in input
  it('null-byte in input: ok=false, reason=input', () => {
    const result = validatePathInsideProject('file\0.txt', tmpDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('input');
    expect(result.error).toMatch(/null byte/);
  });

  // (h) non-string input (null)
  it('null input: ok=false, reason=input', () => {
    const result = validatePathInsideProject(null, tmpDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('input');
  });

  // (i) input that resolves exactly to root (boundary — isPathInside rejects equality)
  it('input resolving exactly to root boundary: ok=false, reason=lexical', () => {
    // path.resolve(tmpDir, '.') === tmpDir — isPathInside(x, x) returns false
    const result = validatePathInsideProject('.', tmpDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('lexical');
  });

  // (j) relative path that resolves inside root (non-existent)
  it('relative path inside root (non-existent): ok=true, realPath undefined', () => {
    const result = validatePathInsideProject('src/index.js', tmpDir);
    expect(result.ok).toBe(true);
    expect(result.realPath).toBeUndefined();
    expect(result.lexicalPath).toBe(path.resolve(tmpDir, 'src/index.js'));
  });

  // (k) very deep traversal — 100 repetitions of '../' → lexical rejection
  it('very deep traversal (100x "../"): ok=false, reason=lexical', () => {
    const deepTraversal = '../'.repeat(100) + 'etc/passwd';
    const result = validatePathInsideProject(deepTraversal, tmpDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('lexical');
  });

  // (l) trailing slash on valid subdir — path.resolve normalises it, ENOENT → ok=true
  it('trailing slash on non-existent subdir: ok=true, lexicalPath same as without slash', () => {
    const withSlash = validatePathInsideProject('subdir/', tmpDir);
    const withoutSlash = validatePathInsideProject('subdir', tmpDir);
    expect(withSlash.ok).toBe(true);
    expect(withSlash.realPath).toBeUndefined();
    expect(withSlash.lexicalPath).toBe(path.resolve(tmpDir, 'subdir'));
    expect(withSlash.lexicalPath).toBe(withoutSlash.lexicalPath);
  });

  // (m) two-hop symlink chain (A→B→C) all inside project — ok=true, realPath resolves to C
  it.skipIf(process.platform === 'win32')(
    'two-hop symlink chain inside root: ok=true, realPath resolves to final target',
    () => {
      const realRoot = fs.realpathSync(tmpDir);
      // C: real file
      const targetFile = path.join(realRoot, 'target.txt');
      fs.writeFileSync(targetFile, 'data');
      // B → C
      const linkB = path.join(realRoot, 'link-b.txt');
      fs.symlinkSync(targetFile, linkB);
      // A → B
      const linkA = path.join(realRoot, 'link-a.txt');
      fs.symlinkSync(linkB, linkA);
      const result = validatePathInsideProject('link-a.txt', realRoot);
      expect(result.ok).toBe(true);
      // realPath must resolve all hops to the canonical target file
      expect(result.realPath).toBe(targetFile);
    },
  );
});

// ── validatePathInsideProject — opts.canonicalizeRoot (#549 G1) ─────────────
//
// Verifies the POST-W3-P2 contract of the opt-in `canonicalizeRoot: true`
// branch (scripts/lib/path-utils.mjs:191-200). W3-P2 removed the existsSync
// precheck (TOCTOU race) and narrowed the catch to ENOENT/EACCES only —
// other errors propagate.
//
// Each test asserts behaviour against the current implementation; if any of
// these assertions fail after a refactor, the canonicalizeRoot contract has
// silently changed and must be re-reviewed.

describe('validatePathInsideProject — opts.canonicalizeRoot (#549 G1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // G1.1 — root does not exist, descendant input → fall through to lexical
  // After W3-P2: realpathSync(root) throws ENOENT → caught (narrowed to
  // ENOENT/EACCES) → effectiveRoot = root (original) → Phase 1 lexical check
  // passes for descendant input → Phase 2 realpathSync(lexicalPath) also
  // throws ENOENT (path doesn't exist) → swallowed → ok=true, realPath=undefined.
  //
  // Falsification: if the W3-P2 catch were removed or narrowed to exclude
  // ENOENT, the function would throw and this test would crash before the
  // assertion. The spy further asserts the SUT actually invoked the
  // canonicalize branch (vs silently skipping it), preventing a "result
  // matches by accident" pass.
  it('root not existing + canonicalizeRoot:true: descendant input returns ok=true with lexical fallback', () => {
    // Deliberately non-existent root path — guarantees ENOENT on realpathSync.
    const nonExistentRoot = path.join(os.tmpdir(), `g1-nonexistent-root-${Date.now()}-${process.pid}-xyz`);
    // Belt-and-suspenders: confirm the path truly doesn't exist before the call.
    expect(fs.existsSync(nonExistentRoot)).toBe(false);

    // Spy without overriding behaviour: realpathSync(nonExistentRoot) will
    // naturally throw ENOENT. We only need to OBSERVE that it was called
    // with the root path (proving the canonicalize branch ran).
    const realpathSpy = vi.spyOn(fs, 'realpathSync');

    const result = validatePathInsideProject('subdir/file.txt', nonExistentRoot, {
      canonicalizeRoot: true,
    });

    // Exact shape — no over-generous toBeTruthy.
    expect(result).toEqual({
      ok: true,
      realPath: undefined,
      lexicalPath: path.resolve(nonExistentRoot, 'subdir/file.txt'),
    });
    // Falsification: the canonicalize branch must have called realpathSync
    // with the root path. If the branch were skipped (e.g., gate broken to
    // `false`), realpathSync would be called only ONCE (Phase 2 against
    // lexicalPath), not twice.
    expect(realpathSpy).toHaveBeenCalledTimes(2);
    expect(realpathSpy.mock.calls[0][0]).toBe(nonExistentRoot);
    expect(realpathSpy.mock.calls[1][0]).toBe(path.resolve(nonExistentRoot, 'subdir/file.txt'));
  });

  // G1.2 — EACCES on realpathSync(root) → fall back to lexical root
  // Mock realpathSync so the FIRST call (for root) throws EACCES. W3-P2's
  // narrowed catch covers ENOENT and EACCES — the function must NOT throw;
  // it must fall back to using the original root for Phase 1.
  // The SECOND call (for lexicalPath in Phase 2) throws ENOENT, which the
  // Phase 2 catch swallows → ok=true, realPath=undefined.
  it('EACCES on realpathSync(root): falls back to lexical, returns ok=true (no throw)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g1-eacces-'));
    const realTmp = fs.realpathSync(tmpDir);
    const expectedLexicalPath = path.resolve(realTmp, 'subdir/file.txt');

    const calls = [];
    const realpathSpy = vi.spyOn(fs, 'realpathSync').mockImplementation((p) => {
      calls.push(p);
      // First call is for root (canonicalize branch) — throw EACCES.
      if (calls.length === 1) {
        const err = new Error('mock EACCES on root');
        err.code = 'EACCES';
        throw err;
      }
      // Subsequent call (Phase 2 against lexicalPath) — throw ENOENT so
      // Phase 2's catch swallows it.
      const err = new Error('mock ENOENT on lexicalPath');
      err.code = 'ENOENT';
      throw err;
    });

    const result = validatePathInsideProject('subdir/file.txt', realTmp, {
      canonicalizeRoot: true,
    });

    // Result-shape assertions: function did NOT throw, returned the
    // lexical-fallback success envelope.
    expect(result).toEqual({
      ok: true,
      realPath: undefined,
      lexicalPath: expectedLexicalPath,
    });
    // Falsification: the SUT must have CALLED realpathSync exactly twice —
    // once for root (with EACCES) and once for lexicalPath (with ENOENT).
    // If the canonicalize branch were skipped or the EACCES catch removed,
    // call count and call args would differ.
    expect(realpathSpy).toHaveBeenCalledTimes(2);
    expect(calls[0]).toBe(realTmp);
    expect(calls[1]).toBe(expectedLexicalPath);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // G1.3 — default (canonicalizeRoot omitted) is byte-identical to
  // canonicalizeRoot:false. Strict `=== true` gate means anything else is
  // legacy behaviour.
  // Use a non-existent root so the SUT's path through Phase 1/Phase 2 is
  // deterministic and the comparison covers all returned fields.
  it('default (canonicalizeRoot omitted) deep-equals canonicalizeRoot:false', () => {
    const nonExistentRoot = path.join(os.tmpdir(), `g1-default-vs-false-${Date.now()}-${process.pid}-xyz`);
    expect(fs.existsSync(nonExistentRoot)).toBe(false);

    const omitted = validatePathInsideProject('subdir/file.txt', nonExistentRoot);
    const explicitFalse = validatePathInsideProject('subdir/file.txt', nonExistentRoot, {
      canonicalizeRoot: false,
    });

    // Deep-equal across the full returned shape (ok + realPath + lexicalPath).
    expect(omitted).toEqual(explicitFalse);
    // Pin the exact shape so a future refactor that drops realPath or
    // lexicalPath cannot silently slip past the deep-equal check above.
    expect(omitted).toEqual({
      ok: true,
      realPath: undefined,
      lexicalPath: path.resolve(nonExistentRoot, 'subdir/file.txt'),
    });
  });

  // G1.4 — non-boolean truthy values do NOT trigger the canonicalize branch.
  // The SUT uses strict `opts.canonicalizeRoot === true` (path-utils.mjs:191).
  // Passing `'yes'` or `1` must behave identically to omitting the option.
  //
  // The falsifying scenario: if the SUT were changed to `opts.canonicalizeRoot`
  // (loose truthy check), the spy below would be called with the root path
  // and would throw — but with the strict check it must NOT be called for
  // these inputs (only Phase 2's call against lexicalPath should occur).
  it('non-boolean truthy canonicalizeRoot does NOT trigger canonicalize branch', () => {
    // Non-existent root: Phase 2 realpathSync(lexicalPath) will throw ENOENT
    // naturally without any mock, so we only need to spy to OBSERVE whether
    // the canonicalize branch runs (no behaviour replacement needed).
    const nonExistentRoot = path.join(os.tmpdir(), `g1-truthy-${Date.now()}-${process.pid}-xyz`);
    expect(fs.existsSync(nonExistentRoot)).toBe(false);

    const realpathSpy = vi.spyOn(fs, 'realpathSync');

    const baseline = validatePathInsideProject('subdir/file.txt', nonExistentRoot); // default
    const callsAfterBaseline = realpathSpy.mock.calls.length;

    const withStringYes = validatePathInsideProject('subdir/file.txt', nonExistentRoot, {
      canonicalizeRoot: 'yes',
    });
    const callsAfterStringYes = realpathSpy.mock.calls.length;

    const withNumberOne = validatePathInsideProject('subdir/file.txt', nonExistentRoot, {
      canonicalizeRoot: 1,
    });
    const callsAfterNumberOne = realpathSpy.mock.calls.length;

    // All three must be deep-equal — non-boolean truthy must not change the
    // result shape vs default.
    expect(withStringYes).toEqual(baseline);
    expect(withNumberOne).toEqual(baseline);
    expect(baseline).toEqual({
      ok: true,
      realPath: undefined,
      lexicalPath: path.resolve(nonExistentRoot, 'subdir/file.txt'),
    });

    // Falsification: each call (default, 'yes', 1) makes exactly ONE
    // realpathSync invocation — the Phase 2 call against lexicalPath.
    // If the SUT were `if (opts.canonicalizeRoot)` (loose truthy), the
    // 'yes' and 1 cases would each invoke realpathSync TWICE (Phase 1b for
    // root + Phase 2 for lexicalPath), making the deltas 2 each.
    expect(callsAfterBaseline).toBe(1);
    expect(callsAfterStringYes - callsAfterBaseline).toBe(1);
    expect(callsAfterNumberOne - callsAfterStringYes).toBe(1);
  });

  // G-M3 (#553) — narrowed-catch rethrow on non-ENOENT/non-EACCES error
  //
  // SUT: scripts/lib/path-utils.mjs:191-200
  //   try { effectiveRoot = realpathSync(root); }
  //   catch (err) {
  //     if (err && err.code !== 'ENOENT' && err.code !== 'EACCES') throw err;
  //   }
  //
  // W3-P2 narrowed the catch to swallow ENOENT/EACCES only — any other code
  // (ELOOP for symlink loops, EIO for hardware faults, EPERM, ENOTDIR, …)
  // must propagate so the caller learns about genuine filesystem faults
  // rather than silently degrading to the lexical-fallback path.
  //
  // Mirrors the G1.2 EACCES test (vi.spyOn(fs, 'realpathSync') pattern at
  // path-utils.test.mjs:~553) but flips the expected behaviour from "swallow"
  // to "rethrow".
  //
  // Falsification: if the catch were widened to `catch (err) { /* swallow */ }`
  // or the condition were inverted, the function would NOT throw and the
  // assertion would fail. If the narrowing were dropped entirely (no catch),
  // the test would still pass because realpathSync's natural throw would
  // propagate — but the `expect.objectContaining({ code: 'ELOOP' })` assertion
  // pins us to the SPECIFIC error object thrown by the mock, not any incidental
  // throw, so a refactor that rethrows a wrapped/normalized error would fail.
  it('G-M3: rethrows non-ENOENT/non-EACCES error from realpathSync(root)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g-m3-eloop-'));
    const realTmp = fs.realpathSync(tmpDir);

    // Mock ONLY the first call (canonicalize branch against root) to throw ELOOP.
    // The SUT must rethrow before reaching Phase 2.
    vi.spyOn(fs, 'realpathSync').mockImplementationOnce(() => {
      const err = new Error('mock ELOOP from realpathSync(root)');
      err.code = 'ELOOP';
      throw err;
    });

    // The exact same {input, root, opts} shape that the G1.2 EACCES test uses,
    // except we expect a THROW here (not a result object).
    expect(() =>
      validatePathInsideProject('subdir/file.txt', realTmp, {
        canonicalizeRoot: true,
      }),
    ).toThrow(expect.objectContaining({ code: 'ELOOP' }));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
