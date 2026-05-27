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
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

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
    // Hardcoded literal expectation — not computed from process.cwd().
    // Verifies the full layout: <homedir>/.claude/projects/<encoded>/memory
    vi.spyOn(process, 'cwd').mockReturnValue('/Users/x/project.git');
    const expected = path.join(
      os.homedir(),
      '.claude',
      'projects',
      '-Users-x-project-git',
      'memory',
    );
    expect(resolveMemoryDir()).toBe(expected);
  });

  it('places the encoded cwd segment under ~/.claude/projects', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/a/b');
    const dir = resolveMemoryDir();
    expect(dir).toContain(path.join(os.homedir(), '.claude', 'projects'));
    expect(dir).toContain('-a-b');
  });
});
