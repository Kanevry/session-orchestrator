/**
 * tests/lib/path-utils.test.mjs
 *
 * Security-critical tests for path-utils.mjs (CWE-23 path traversal prevention).
 * Covers all attack patterns documented in CWE_23_ATTACK_PATTERNS.
 *
 * Issue #130 — Wave 4 (Quality) of v3.0.0 migration.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  isPathInside,
  relativeFromRoot,
  normalizeCase,
  sameDrive,
  CWE_23_ATTACK_PATTERNS,
} from '../../scripts/lib/path-utils.mjs';

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
