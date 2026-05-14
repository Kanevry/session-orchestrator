/**
 * tests/lib/config/test.test.mjs
 *
 * Unit tests for scripts/lib/config/test.mjs (_parseTest).
 *
 * Coverage:
 *   - Returns all defaults when no `test:` block present
 *   - Each field is independently overridable: enabled, default-profile,
 *     profiles-path, mode, retention-days
 *   - Invalid `mode` value falls back silently to 'warn'
 *   - CRLF tolerance
 *   - Inline YAML comments stripped
 *   - Block boundary: next top-level key stops parsing
 *
 * Mirrors the docs-orchestrator.test.mjs pattern (see tests/lib/config/).
 * All expected values are hardcoded literals.
 */

import { describe, it, expect } from 'vitest';
import fs, { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _parseTest } from '@lib/config/test.mjs';

const DEFAULTS = {
  enabled: false,
  'default-profile': 'smoke',
  'profiles-path': '.orchestrator/policy/test-profiles.json',
  mode: 'warn',
  'retention-days': 30,
};

// ---------------------------------------------------------------------------
// Missing / empty block — all defaults returned
// ---------------------------------------------------------------------------

describe('_parseTest — missing or empty block', () => {
  it('returns all defaults on empty string input', () => {
    expect(_parseTest('')).toEqual(DEFAULTS);
  });

  it('returns all defaults when test: block is absent from content', () => {
    expect(_parseTest('persistence: true\nenforcement: warn\n')).toEqual(DEFAULTS);
  });

  it('returns all defaults when test: block is present but empty', () => {
    const content = 'test:\n\nnext-section:\n';
    expect(_parseTest(content)).toEqual(DEFAULTS);
  });
});

// ---------------------------------------------------------------------------
// Individual fields — each overridable
// ---------------------------------------------------------------------------

describe('_parseTest — individual field overrides', () => {
  it('parses enabled: true', () => {
    const content = 'test:\n  enabled: true\n';
    expect(_parseTest(content).enabled).toBe(true);
  });

  it('parses default-profile: full', () => {
    const content = 'test:\n  default-profile: full\n';
    expect(_parseTest(content)['default-profile']).toBe('full');
  });

  it('parses profiles-path: custom path (stored as resolved absolute path, #405 TOCTOU fix)', () => {
    const content = 'test:\n  profiles-path: .custom/profiles.json\n';
    // After #402+#405: stored value is the resolved absolute path (not raw v).
    // .custom/profiles.json does not exist on disk — realPath is null, lexicalPath is used.
    const expected = path.resolve(process.cwd(), '.custom/profiles.json');
    expect(_parseTest(content)['profiles-path']).toBe(expected);
  });

  it('parses mode: strict', () => {
    const content = 'test:\n  mode: strict\n';
    expect(_parseTest(content).mode).toBe('strict');
  });

  it('parses retention-days: 60', () => {
    const content = 'test:\n  retention-days: 60\n';
    expect(_parseTest(content)['retention-days']).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Invalid mode — falls back to 'warn'
// ---------------------------------------------------------------------------

describe('_parseTest — invalid mode value', () => {
  it('silently falls back to "warn" when mode is an unrecognized value', () => {
    const content = 'test:\n  mode: turbo\n';
    expect(_parseTest(content).mode).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// CRLF tolerance
// ---------------------------------------------------------------------------

describe('_parseTest — CRLF tolerance', () => {
  it('handles CRLF line endings correctly', () => {
    const content = 'test:\r\n  enabled: true\r\n  mode: strict\r\n';
    const result = _parseTest(content);
    expect(result.enabled).toBe(true);
    expect(result.mode).toBe('strict');
  });
});

// ---------------------------------------------------------------------------
// Inline YAML comments stripped
// ---------------------------------------------------------------------------

describe('_parseTest — inline YAML comments stripped', () => {
  it('strips trailing inline comments from field values', () => {
    const content = 'test:\n  enabled: true  # opt-in\n  retention-days: 45  # days\n';
    const result = _parseTest(content);
    expect(result.enabled).toBe(true);
    expect(result['retention-days']).toBe(45);
  });
});

// ---------------------------------------------------------------------------
// Path-traversal validation for profiles-path (#390)
// ---------------------------------------------------------------------------

describe('_parseTest — profiles-path path-traversal rejection', () => {
  it('falls back to default when profiles-path is a relative traversal (../etc/passwd)', () => {
    const content = 'test:\n  profiles-path: ../etc/passwd\n';
    expect(_parseTest(content)['profiles-path']).toBe('.orchestrator/policy/test-profiles.json');
  });

  it('falls back to default when profiles-path is an absolute path outside the project (/etc/passwd)', () => {
    const content = 'test:\n  profiles-path: /etc/passwd\n';
    expect(_parseTest(content)['profiles-path']).toBe('.orchestrator/policy/test-profiles.json');
  });

  it('accepts a repo-relative profiles-path inside the project (skills/test-runner/whatever.json)', () => {
    // After #402+#405: stored value is the resolved absolute path (not raw v).
    // skills/test-runner/whatever.json does not exist on disk — realPath is null, lexicalPath is used.
    const content = 'test:\n  profiles-path: skills/test-runner/whatever.json\n';
    const expected = path.resolve(process.cwd(), 'skills/test-runner/whatever.json');
    expect(_parseTest(content)['profiles-path']).toBe(expected);
  });

  it('accepts a deep-traversal rejection — multiple ../ segments still fall back to default', () => {
    const content = 'test:\n  profiles-path: ../../../../../../etc/shadow\n';
    expect(_parseTest(content)['profiles-path']).toBe('.orchestrator/policy/test-profiles.json');
  });
});

// ---------------------------------------------------------------------------
// Phase 2 symlink-escape guard for profiles-path (#397 / SEC-Q2-LOW-1)
//
// When the path EXISTS on disk and is a symlink pointing outside the project
// root, Phase 2 (realpathSync) must reject it and fall back to the default.
// The test creates a real temp directory, a real symlink, and cleans up after.
// Skipped automatically on platforms where fs.symlinkSync fails (e.g. Windows
// without elevated privileges).
// ---------------------------------------------------------------------------

describe('_parseTest — profiles-path Phase 2 symlink-escape guard (#397)', () => {
  it('falls back to default when profiles-path resolves to a symlink pointing outside project root', () => {
    // Create a temp dir outside the project root to use as the symlink target.
    let tmpDir;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-symlink-test-'));
    } catch {
      // Can't create temp dir — skip silently.
      return;
    }

    // Place the symlink inside the project root so the lexical (Phase 1) check passes,
    // but make it point to the external tmpDir so Phase 2 (realpathSync) rejects it.
    const symlinkName = `symlink-escape-test-${Date.now()}.json`;
    const symlinkPath = path.join(process.cwd(), symlinkName);

    // Create the actual file inside tmpDir so the symlink is NOT dangling.
    // Without the target file, realpathSync throws ENOENT → the catch block
    // falls through to "path not on disk yet" and Phase 2 is skipped.
    const targetFile = path.join(tmpDir, 'escape.json');
    try {
      fs.writeFileSync(targetFile, '{}', 'utf8');
      fs.symlinkSync(targetFile, symlinkPath);
    } catch {
      // symlinkSync not available on this platform — skip test.
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      return;
    }

    try {
      const content = `test:\n  profiles-path: ${symlinkName}\n`;
      // Phase 1 passes (symlink is inside project root lexically).
      // Phase 2 must reject (realpath of symlink points outside project root).
      const result = _parseTest(content);
      expect(result['profiles-path']).toBe('.orchestrator/policy/test-profiles.json');
    } finally {
      try { fs.unlinkSync(symlinkPath); } catch { /* ignore */ }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ---------------------------------------------------------------------------
// TOCTOU fix: stored path is realpath, not raw input (#405 / SEC-Q2-LOW-1)
//
// Before the fix: tcProfilesPath = v (raw symlink name).
// After the fix:  tcProfilesPath = result.realPath || result.lexicalPath.
//
// This test creates a valid intra-project symlink pointing to a tempdir target
// inside the project, parses the config, and asserts the stored value is the
// canonical realpath of the symlink — not the original symlink name.
// Skipped automatically if symlink creation fails (e.g. Windows without elevation).
// ---------------------------------------------------------------------------

describe('_parseTest — profiles-path TOCTOU: stored as realpath, not raw input (#405)', () => {
  it('stores realpath of a valid in-project symlink, not the raw symlink name', () => {
    // Create a real file inside the project root to use as the symlink target.
    // (Symlink must point to an existing path so realpathSync resolves it.)
    const targetName = `.toctou-target-${Date.now()}.json`;
    const targetPath = path.join(process.cwd(), targetName);
    const symlinkName = `.toctou-link-${Date.now()}.json`;
    const symlinkPath = path.join(process.cwd(), symlinkName);

    try {
      fs.writeFileSync(targetPath, '{}', 'utf8');
    } catch {
      return; // Can't write test file — skip silently.
    }

    try {
      fs.symlinkSync(targetPath, symlinkPath);
    } catch {
      // symlinkSync not available on this platform — skip test.
      try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
      return;
    }

    try {
      const content = `test:\n  profiles-path: ${symlinkName}\n`;
      const result = _parseTest(content);
      // The stored value must be the canonical realpath of the target,
      // NOT the raw symlink name and NOT the lexical resolved symlink path.
      const expectedRealPath = realpathSync(symlinkPath);
      expect(result['profiles-path']).toBe(expectedRealPath);
      // Paranoia: confirm the stored value differs from the raw symlink name,
      // which is the TOCTOU-vulnerable form the bug previously stored.
      const rawSymlinkResolved = path.resolve(process.cwd(), symlinkName);
      // realpath of the symlink = realpath of the target (they are the same file).
      // The test only fails if we accidentally stored the unresolved form.
      expect(result['profiles-path']).not.toBe(symlinkName);
      expect(result['profiles-path']).not.toBe(rawSymlinkResolved);
    } finally {
      try { fs.unlinkSync(symlinkPath); } catch { /* ignore */ }
      try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
    }
  });
});

// ---------------------------------------------------------------------------
// TOCTOU fix: existing plain file (relative path) stores realPath, not raw v (#405)
//
// The _parseTest TOCTOU test (above) covers a symlink pointing to an in-project
// target: stored = realpath(target). This test covers the simpler case: a plain
// relative path to an existing, non-symlink file inside the project — stored
// value is realpathSync of that file (which equals the lexical path for plain files),
// NOT the raw relative string that was in the config.
// ---------------------------------------------------------------------------

describe('_parseTest — profiles-path existing plain file stores realPath not raw input (#405)', () => {
  it('stores resolved absolute path for a relative path to an existing in-project file', () => {
    // .orchestrator/policy/test-profiles.json exists on disk (part of the repo).
    // After #405: stored = result.realPath (realpathSync result) because Phase 2 succeeds.
    // For a plain file with no symlinks, realpathSync returns the absolute path,
    // which equals path.resolve(cwd, relativePath) — NOT the raw relative string 'x/y.json'.
    const content = 'test:\n  profiles-path: .orchestrator/policy/test-profiles.json\n';
    const result = _parseTest(content);
    // Must NOT be the raw relative string
    expect(result['profiles-path']).not.toBe('.orchestrator/policy/test-profiles.json');
    // Must be the resolved absolute path
    const expectedAbsolute = path.resolve(process.cwd(), '.orchestrator/policy/test-profiles.json');
    expect(result['profiles-path']).toBe(expectedAbsolute);
  });
});

// ---------------------------------------------------------------------------
// Block boundary — stops at next top-level key
// ---------------------------------------------------------------------------

describe('_parseTest — block boundary', () => {
  it('stops parsing when the next top-level key is encountered', () => {
    const content = 'test:\n  enabled: true\nother-section:\n  enabled: false\n';
    expect(_parseTest(content).enabled).toBe(true);
  });

  it('does not bleed default-profile from a subsequent block', () => {
    const content = 'test:\n  enabled: true\nother:\n  default-profile: bleed\n';
    expect(_parseTest(content)['default-profile']).toBe('smoke');
  });
});

// ---------------------------------------------------------------------------
// profiles-path boundary coverage (#401 GAP-Q4-4)
// ---------------------------------------------------------------------------

describe('_parseTest — profiles-path boundary coverage (#401 GAP-Q4-4)', () => {
  it('falls back to default when profiles-path is an empty string', () => {
    // Empty string is falsy — the `if (v)` guard in case 'profiles-path' silently skips it.
    const content = "test:\n  profiles-path: ''\n";
    expect(_parseTest(content)['profiles-path']).toBe('.orchestrator/policy/test-profiles.json');
  });

  it('accepts a dot-resolved profiles-path that resolves inside the project (./skills/../.orchestrator/policy/test-profiles.json)', () => {
    // path.resolve normalises the dot-segments; the resolved path is inside project root.
    // The file .orchestrator/policy/test-profiles.json exists on disk, so Phase 2 (realpath) runs.
    // After #402+#405: stored value is realPath (symlink-resolved canonical path), not raw v.
    const content = 'test:\n  profiles-path: ./skills/../.orchestrator/policy/test-profiles.json\n';
    const expectedLexical = path.resolve(process.cwd(), './skills/../.orchestrator/policy/test-profiles.json');
    let expected;
    try {
      expected = realpathSync(expectedLexical);
    } catch {
      expected = expectedLexical;
    }
    expect(_parseTest(content)['profiles-path']).toBe(expected);
  });

  it('accepts an absolute profiles-path that resolves to a file inside the project root', () => {
    // isPathInside(absolutePath, cwd) is true when the absolute path IS a descendant of cwd.
    // The silent-skip guard only rejects paths that escape the root, not absolute-but-inside paths.
    // After #402+#405: stored value is realPath (symlink-resolved canonical path).
    // For a plain file with no symlinks, realpathSync(absolutePath) === absolutePath.
    const absolutePath = process.cwd() + '/.orchestrator/policy/test-profiles.json';
    const content = `test:\n  profiles-path: ${absolutePath}\n`;
    let expected;
    try {
      expected = realpathSync(absolutePath);
    } catch {
      expected = absolutePath;
    }
    expect(_parseTest(content)['profiles-path']).toBe(expected);
  });
});
