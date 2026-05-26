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

  // -------------------------------------------------------------------------
  // #558 Q2-M5 — Boundary tests (multi-prefix, mixed-scope, default-sinceRef,
  // override-semantics). The existing 5 tests each cover ONE prefix at a time.
  // Production waves frequently touch multiple shared-lib prefixes in the same
  // commit, and the default `promoteWhenTouched` fallback path is exercised by
  // every wave-executor call — both surfaces need explicit coverage.
  // -------------------------------------------------------------------------

  it('Test A — returns all matching prefixes when a single commit touches multiple shared-lib roots', () => {
    // A single commit touches scripts/lib/ AND hooks/ AND .husky/ simultaneously.
    // Asserts the helper returns every matching file (not just the first prefix
    // it encounters) so callers can attribute the auto-promotion accurately.
    writeFileInRepo('scripts/lib/foo.mjs', 'export const x = 1;\n');
    writeFileInRepo('hooks/bar.mjs', '#!/usr/bin/env node\n');
    writeFileInRepo('.husky/baz', '#!/usr/bin/env bash\n');
    git('add', 'scripts/lib/foo.mjs', 'hooks/bar.mjs', '.husky/baz');
    git('commit', '--quiet', '-m', 'touch all three shared-lib roots');

    const result = detectSharedLibTouch({
      repoRoot,
      sinceRef: baseSha,
      promoteWhenTouched: ['scripts/lib/', 'hooks/', '.husky/'],
    });

    expect(result.touched).toBe(true);
    expect(result.paths).toEqual(
      expect.arrayContaining(['scripts/lib/foo.mjs', 'hooks/bar.mjs', '.husky/baz']),
    );
    expect(result.paths).toHaveLength(3);
  });

  it('Test B — filters out-of-scope files when prefixes narrow the match set', () => {
    // A single commit touches a mix of in-scope and out-of-scope files. When the
    // caller restricts `promoteWhenTouched` to `scripts/lib/` only, the result
    // must contain ONLY the scripts/lib match — never the docs/ or tests/ paths.
    writeFileInRepo('scripts/lib/foo.mjs', 'export const x = 1;\n');
    writeFileInRepo('docs/readme.md', '# docs\n');
    writeFileInRepo('tests/bar.test.mjs', 'test\n');
    git('add', 'scripts/lib/foo.mjs', 'docs/readme.md', 'tests/bar.test.mjs');
    git('commit', '--quiet', '-m', 'touch in-scope + out-of-scope files');

    const result = detectSharedLibTouch({
      repoRoot,
      sinceRef: baseSha,
      promoteWhenTouched: ['scripts/lib/'],
    });

    expect(result.touched).toBe(true);
    expect(result.paths).toEqual(['scripts/lib/foo.mjs']);
  });

  it('Test C — falls back to HEAD~1 when no sinceRef and no last-green-sha.txt', () => {
    // Contract per quality-gate.mjs L353-355:
    //   sinceRef = opts.sinceRef ?? readLastGreenSha() ?? 'HEAD~1'.
    // With NO `sinceRef` opt and NO `.orchestrator/runtime/last-green-sha.txt`,
    // the helper must fall back to HEAD~1. The base commit (README.md) is the
    // only ancestor; a scripts/lib touch on HEAD diffed against HEAD~1 must
    // be detected.
    writeFileInRepo('scripts/lib/foo.mjs', 'export const x = 1;\n');
    git('add', 'scripts/lib/foo.mjs');
    git('commit', '--quiet', '-m', 'touch scripts/lib on HEAD');

    // No sinceRef passed; no last-green-sha.txt written. Must not throw.
    const result = detectSharedLibTouch({ repoRoot });

    expect(result.touched).toBe(true);
    expect(result.paths).toEqual(['scripts/lib/foo.mjs']);
  });

  it('Test D — promoteWhenTouched REPLACES (does not extend) the default prefix list', () => {
    // Contract per quality-gate.mjs L350-352:
    //   prefixes = Array.isArray(opts.promoteWhenTouched) && length > 0
    //              ? opts.promoteWhenTouched
    //              : ['scripts/lib/', 'hooks/', '.husky/'].
    // The ternary REPLACES the default — it does not concatenate. So a commit
    // touching only `hooks/foo.mjs` with override `['scripts/lib/']` must return
    // `touched: false` because hooks/ is no longer in the active prefix list.
    writeFileInRepo('hooks/foo.mjs', '#!/usr/bin/env node\n');
    git('add', 'hooks/foo.mjs');
    git('commit', '--quiet', '-m', 'touch hooks only');

    const result = detectSharedLibTouch({
      repoRoot,
      sinceRef: baseSha,
      promoteWhenTouched: ['scripts/lib/'], // explicit replacement; hooks/ excluded
    });

    expect(result).toEqual({ touched: false, paths: [] });
  });
});
