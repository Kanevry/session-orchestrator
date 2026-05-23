/**
 * tests/unit/quality-gate-shared-lib-touch.test.mjs
 *
 * Unit tests for scripts/lib/quality-gate.mjs — detectSharedLibTouch
 * (#555 FL-3 — shared-lib touch-detector for inter-wave Quality-Lite
 * auto-promotion to Full Gate).
 *
 * Covers:
 *   - touched:false when no shared-lib paths changed
 *   - touched:true when scripts/lib/* changed
 *   - touched:true when hooks/* changed
 *   - touched:true when .husky/* changed
 *   - safe-default {touched:false, paths:[]} on git failure (invalid sinceRef)
 *
 * Isolation strategy:
 *   - Each test spins up a fresh git repo in tmpdir.
 *   - Two commits per test: BASE (empty file) → HEAD (with the touch under test).
 *   - sinceRef = BASE sha; HEAD is implicit.
 *   - detectSharedLibTouch invokes the real `git diff` — no mocking of git.
 *   - afterEach removes the tmpdir to avoid cross-test bleed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { detectSharedLibTouch } from '@lib/quality-gate.mjs';

let repoRoot;
let baseSha;

/** Run a git command in repoRoot. Throws on non-zero exit. */
function git(...args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

/** Write a file at `relPath` (creating parent dirs) and return its full path. */
function writeFileInRepo(relPath, content) {
  const full = join(repoRoot, relPath);
  mkdirSync(join(repoRoot, relPath.split('/').slice(0, -1).join('/')), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'qg-shared-lib-touch-'));
  // Init repo with deterministic identity (no global config dependency).
  git('init', '--quiet', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  // Base commit: a placeholder file so HEAD~1 exists for subsequent diffs.
  writeFileInRepo('README.md', '# base\n');
  git('add', 'README.md');
  git('commit', '--quiet', '-m', 'base');
  baseSha = git('rev-parse', 'HEAD');
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('detectSharedLibTouch — #555 FL-3', () => {
  it('returns touched:false when no shared-lib paths changed', () => {
    // HEAD adds only tests/foo.test.mjs — outside the prefix list.
    writeFileInRepo('tests/foo.test.mjs', 'test\n');
    git('add', 'tests/foo.test.mjs');
    git('commit', '--quiet', '-m', 'add test only');

    const result = detectSharedLibTouch({ repoRoot, sinceRef: baseSha });

    expect(result).toEqual({ touched: false, paths: [] });
  });

  it('returns touched:true with paths when scripts/lib/* changed', () => {
    writeFileInRepo('scripts/lib/foo.mjs', 'export const x = 1;\n');
    git('add', 'scripts/lib/foo.mjs');
    git('commit', '--quiet', '-m', 'touch scripts/lib');

    const result = detectSharedLibTouch({ repoRoot, sinceRef: baseSha });

    expect(result).toEqual({ touched: true, paths: ['scripts/lib/foo.mjs'] });
  });

  it('returns touched:true when hooks/* changed', () => {
    writeFileInRepo('hooks/bar.mjs', '#!/usr/bin/env node\n');
    git('add', 'hooks/bar.mjs');
    git('commit', '--quiet', '-m', 'touch hooks');

    const result = detectSharedLibTouch({ repoRoot, sinceRef: baseSha });

    expect(result).toEqual({ touched: true, paths: ['hooks/bar.mjs'] });
  });

  it('returns touched:true when .husky/* changed', () => {
    writeFileInRepo('.husky/baz', '#!/usr/bin/env bash\n');
    git('add', '.husky/baz');
    git('commit', '--quiet', '-m', 'touch husky');

    const result = detectSharedLibTouch({ repoRoot, sinceRef: baseSha });

    expect(result).toEqual({ touched: true, paths: ['.husky/baz'] });
  });

  it('returns touched:false on git failure (safe-default with invalid sinceRef)', () => {
    // Make a real shared-lib touch so the prefix-filter would otherwise match,
    // but pass an invalid sinceRef. The git diff exits non-zero, so the helper
    // must default to the safe { touched:false, paths:[] } shape.
    writeFileInRepo('scripts/lib/foo.mjs', 'export const x = 1;\n');
    git('add', 'scripts/lib/foo.mjs');
    git('commit', '--quiet', '-m', 'touch scripts/lib');

    const result = detectSharedLibTouch({
      repoRoot,
      sinceRef: 'definitely-not-a-real-sha',
    });

    expect(result).toEqual({ touched: false, paths: [] });
  });
});
