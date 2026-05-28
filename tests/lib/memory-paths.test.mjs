/**
 * tests/lib/memory-paths.test.mjs
 *
 * Unit tests for scripts/lib/memory-paths.mjs (Issue #512).
 *
 * `resolveMemoryDir()` mirrors the Claude Code harness convention:
 *   `~/.claude/projects/<encoded-cwd>/memory/`
 * where `<encoded-cwd>` replaces BOTH `/` AND `.` with `-`. The dot
 * replacement matters for users with a trailing-`.` in their home dir.
 *
 * Test-quality discipline (.claude/rules/test-quality.md):
 *   - Hardcoded literal expectations for the encoded-path suffix
 *   - One AAA per test, no branching/loops inside `it`
 *   - Behavioural assertions on path shape — not impl mirror
 *
 * os.homedir() is mocked at the module level so the "full expected path"
 * test uses a HARDCODED literal rather than live homedir, making the
 * assertion falsifiable if resolveMemoryDir() ever stops using os.homedir().
 * pool:forks isolates this mock to this file's worker process only.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
// os and path are not imported directly in the test body; the SUT imports them.
// os.homedir() is intercepted via vi.mock below so the SUT sees /home/fixed.

// Module-level mock: vi.spyOn(os,'homedir') is rejected in Vitest 4 ESM
// ("Module namespace is not configurable"). Factory form is required.
//
// memory-paths.mjs uses `import os from 'node:os'` (default import), so the
// mock must patch BOTH the named `homedir` export AND `default.homedir`.
// node:os exposes `default` as a separate object from the named exports; a
// flat spread only patches named exports and leaves default.homedir live.
// The getConfinementRoot-lockstep pattern (M4/#492) worked because that SUT
// uses a named import `import { homedir }` — flat spread suffices there.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal();
  const mockedHomedir = vi.fn(() => '/home/fixed');
  return {
    ...actual,
    homedir: mockedHomedir,
    default: { ...actual.default, homedir: mockedHomedir },
  };
});

import { resolveMemoryDir } from '@lib/memory-paths.mjs';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveMemoryDir', () => {
  it('encodes trailing-dot in cwd as "-" not "."', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/Users/bernhardg.');
    const dir = resolveMemoryDir();
    // The encoded segment must contain '-Users-bernhardg-' and NOT '-Users-bernhardg.'
    expect(dir).toContain('-Users-bernhardg-');
    expect(dir).not.toContain('-Users-bernhardg.');
  });

  it('replaces both slashes and dots in cwd path', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/Users/x/project.git');
    const dir = resolveMemoryDir();
    expect(dir).toContain('-Users-x-project-git');
    expect(dir).not.toContain('/Users/x/project.git');
  });

  it('returns a path ending in "/memory"', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/tmp/foo');
    const dir = resolveMemoryDir();
    expect(dir.endsWith('/memory')).toBe(true);
  });

  it('returns the full expected path shape for a fixed cwd', () => {
    // Hardcoded literal expectation — os.homedir() is mocked to '/home/fixed'
    // above so this assertion is falsifiable: if resolveMemoryDir() stops using
    // os.homedir(), or encodes the cwd incorrectly, or omits a path segment,
    // this exact-match fails. Never compute expected from os.homedir() here.
    vi.spyOn(process, 'cwd').mockReturnValue('/Users/x/project.git');
    expect(resolveMemoryDir()).toBe('/home/fixed/.claude/projects/-Users-x-project-git/memory');
  });

  it('places the encoded cwd segment under ~/.claude/projects', () => {
    // With homedir mocked to '/home/fixed', the projects dir is the hardcoded literal.
    vi.spyOn(process, 'cwd').mockReturnValue('/a/b');
    const dir = resolveMemoryDir();
    expect(dir).toContain('/home/fixed/.claude/projects');
    expect(dir).toContain('-a-b');
  });
});
