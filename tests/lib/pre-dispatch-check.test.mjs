/**
 * tests/lib/pre-dispatch-check.test.mjs
 *
 * Vitest unit tests for scripts/lib/pre-dispatch-check.mjs (issue #180).
 * Asserts untracked-file overlap detection returns the right decision under
 * warn / block / off modes, and listUntracked parses git porcelain output
 * correctly including edge cases (directory entries, quoted paths).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  checkUntrackedOverlap,
  listUntracked,
} from '@lib/pre-dispatch-check.mjs';

// ---------------------------------------------------------------------------
// Test repo helpers
// ---------------------------------------------------------------------------

let repoDir;

function run(cmd, args, cwd = repoDir) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeFile(rel, content = '') {
  const abs = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'predispatch-test-'));
  run('git', ['init', '-q', '--initial-branch=main']);
  run('git', ['config', 'user.email', 'test@example.com']);
  run('git', ['config', 'user.name', 'Test']);
  writeFile('README.md', 'initial');
  run('git', ['add', 'README.md']);
  run('git', ['commit', '-q', '-m', 'init']);
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// listUntracked
// ---------------------------------------------------------------------------

describe('listUntracked', () => {
  it('returns empty array for clean working tree', () => {
    expect(listUntracked(repoDir)).toEqual([]);
  });

  it('returns individual untracked files as relative paths', () => {
    writeFile('scripts/new.mjs');
    writeFile('docs/intro.md');
    const untracked = listUntracked(repoDir);
    expect(untracked).toContain('scripts/new.mjs');
    expect(untracked).toContain('docs/intro.md');
  });

  it('expands untracked directories via git ls-files --others', () => {
    writeFile('skills/new-skill/SKILL.md');
    writeFile('skills/new-skill/helper.mjs');
    const untracked = listUntracked(repoDir);
    // Git reports the whole directory as one `?? skills/new-skill/` entry; expandDirectory fans it out.
    expect(untracked).toContain('skills/new-skill/SKILL.md');
    expect(untracked).toContain('skills/new-skill/helper.mjs');
  });

  it('returns [] when not in a git repo', () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-'));
    try {
      expect(listUntracked(nonRepo)).toEqual([]);
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// checkUntrackedOverlap — decision matrix
// ---------------------------------------------------------------------------

describe('checkUntrackedOverlap', () => {
  it('decision=ok when no untracked files exist', () => {
    const result = checkUntrackedOverlap({ scope: ['scripts/**'], cwd: repoDir });
    expect(result.decision).toBe('ok');
    expect(result.overlapping).toEqual([]);
  });

  it('decision=ok when untracked files do not overlap the scope', () => {
    writeFile('docs/extra.md');
    const result = checkUntrackedOverlap({ scope: ['scripts/**'], cwd: repoDir });
    expect(result.decision).toBe('ok');
    expect(result.overlapping).toEqual([]);
    expect(result.untracked).toContain('docs/extra.md');
  });

  it('decision=warn (default mode) when overlap detected', () => {
    writeFile('scripts/leaked.mjs');
    const result = checkUntrackedOverlap({ scope: ['scripts/**'], cwd: repoDir });
    expect(result.decision).toBe('warn');
    expect(result.overlapping).toContain('scripts/leaked.mjs');
    expect(result.message).toMatch(/WARNING/);
    expect(result.message).toMatch(/scripts\/leaked\.mjs/);
    expect(result.message).toMatch(/#180/);
  });

  it('decision=block when mode=block and overlap detected', () => {
    writeFile('scripts/leaked.mjs');
    const result = checkUntrackedOverlap({ scope: ['scripts/**'], cwd: repoDir, mode: 'block' });
    expect(result.decision).toBe('block');
    expect(result.message).toMatch(/REFUSING/);
    expect(result.message).toMatch(/commit or stash/);
  });

  it('decision=ok when mode=off (short-circuit, skips git entirely)', () => {
    writeFile('scripts/leaked.mjs');
    const result = checkUntrackedOverlap({ scope: ['scripts/**'], cwd: repoDir, mode: 'off' });
    expect(result.decision).toBe('ok');
    expect(result.overlapping).toEqual([]);
    expect(result.untracked).toEqual([]);
  });

  it('decision=ok when scope is empty', () => {
    writeFile('scripts/leaked.mjs');
    const result = checkUntrackedOverlap({ scope: [], cwd: repoDir });
    expect(result.decision).toBe('ok');
    expect(result.message).toMatch(/empty scope/);
  });

  it('matches directory-prefix patterns ending in `/`', () => {
    writeFile('skills/new-skill/SKILL.md');
    const result = checkUntrackedOverlap({ scope: ['skills/'], cwd: repoDir });
    expect(result.decision).toBe('warn');
    expect(result.overlapping).toContain('skills/new-skill/SKILL.md');
  });

  it('matches exact-file scope entries', () => {
    writeFile('scripts/exact.mjs');
    const result = checkUntrackedOverlap({ scope: ['scripts/exact.mjs'], cwd: repoDir });
    expect(result.decision).toBe('warn');
    expect(result.overlapping).toEqual(['scripts/exact.mjs']);
  });

  it('matches **/ deep-glob patterns correctly', () => {
    writeFile('skills/claude-md-drift-check/SKILL.md');
    writeFile('skills/claude-md-drift-check/checker.mjs');
    const result = checkUntrackedOverlap({
      scope: ['skills/**/*.mjs'],
      cwd: repoDir,
    });
    expect(result.decision).toBe('warn');
    expect(result.overlapping).toContain('skills/claude-md-drift-check/checker.mjs');
    // SKILL.md is untracked but does NOT match the *.mjs glob, so it's not in overlapping
    expect(result.overlapping).not.toContain('skills/claude-md-drift-check/SKILL.md');
  });

  it('regression — reproduces the #180 scenario', () => {
    // Coordinator has untracked source files in skills/claude-md-drift-check/
    // Agent is about to run isolation:worktree with scope skills/claude-md-drift-check/**
    // Pre-dispatch check MUST flag this before dispatch.
    writeFile('skills/claude-md-drift-check/checker.mjs', '// 238 LoC would live here');
    writeFile('skills/claude-md-drift-check/checker.sh');
    writeFile('skills/claude-md-drift-check/SKILL.md');
    writeFile('skills/claude-md-drift-check/package.json');

    const result = checkUntrackedOverlap({
      scope: ['skills/claude-md-drift-check/**'],
      cwd: repoDir,
      mode: 'block',
    });

    expect(result.decision).toBe('block');
    expect(result.overlapping.length).toBe(4);
    expect(result.message).toMatch(/REFUSING/);
    expect(result.message).toMatch(/4 untracked/);
  });
});
