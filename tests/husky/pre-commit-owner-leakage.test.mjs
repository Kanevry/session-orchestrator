/**
 * tests/husky/pre-commit-owner-leakage.test.mjs
 *
 * Tests for the .husky/pre-commit owner-leakage stage (#494).
 *
 * Three guarantees the test must lock in:
 *   1. The hook file contains the scanner invocation line (regression-guard
 *      against accidental removal during pre-commit edits).
 *   2. The hook exits non-zero when a planted leak exists in a tmp git repo
 *      (E2E: shell hook → scanner → block).
 *   3. The hook exits zero on a clean tmp git repo (negative path).
 *
 * The hook script itself is shell, not Node, so we drive it via `sh -c` from
 * an isolated tmp directory containing only the scanner + a fixture .git tree.
 * We do NOT touch the real repo's commit history.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, cpSync, mkdirSync, chmodSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const HOOK_PATH = join(REPO_ROOT, '.husky', 'pre-commit');
const SCANNER_PATH = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-owner-leakage.mjs');

describe('.husky/pre-commit — owner-leakage stage (#494)', () => {
  describe('regression guard — hook content', () => {
    it('contains the check-owner-leakage scanner invocation line', () => {
      const hookContent = readFileSync(HOOK_PATH, 'utf8');
      expect(hookContent).toContain('scripts/lib/validate/check-owner-leakage.mjs');
    });

    it('invokes the scanner with git rev-parse --show-toplevel as plugin root', () => {
      const hookContent = readFileSync(HOOK_PATH, 'utf8');
      // The CI argument must resolve to the repo root, NOT $(pwd), because
      // husky runs the hook from the repo top-level but downstream invocations
      // (e.g. `git commit` from a subdir) would otherwise mis-root the scanner.
      expect(hookContent).toMatch(/git rev-parse --show-toplevel/);
    });

    it('exits 1 with a clear error message on scanner non-zero', () => {
      const hookContent = readFileSync(HOOK_PATH, 'utf8');
      expect(hookContent).toContain('Commit blocked');
      expect(hookContent).toMatch(/--no-verify/);
    });

    it('is exec-bit set (husky requirement)', () => {
      const stat = execFileSync('ls', ['-l', HOOK_PATH], { encoding: 'utf8' });
      // First char of perms is type; positions 1-3 = owner rwx
      expect(stat).toMatch(/^-r[w-]x/);
    });
  });

  describe('E2E — scanner-via-hook against tmp git repo', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'so-husky-owner-leakage-'));
      // Initialize a minimal git repo
      execFileSync('git', ['init', '-q', tmpDir], { encoding: 'utf8' });
      execFileSync('git', ['-C', tmpDir, 'config', 'user.email', 'test@example.com']);
      execFileSync('git', ['-C', tmpDir, 'config', 'user.name', 'Test']);
      execFileSync('git', ['-C', tmpDir, 'config', 'commit.gpgsign', 'false']);
      // Copy the scanner into the same relative path it lives at in the real repo,
      // so the hook's `node scripts/lib/validate/check-owner-leakage.mjs` resolves.
      mkdirSync(join(tmpDir, 'scripts', 'lib', 'validate'), { recursive: true });
      cpSync(SCANNER_PATH, join(tmpDir, 'scripts', 'lib', 'validate', 'check-owner-leakage.mjs'));
      // Install our pre-commit hook into .git/hooks so `git commit` triggers it
      // (we don't need husky's _ runtime — just the hook body running).
      const hookSrc = readFileSync(HOOK_PATH, 'utf8')
        // Strip the gitleaks prelude + EVERYTHING after the check-owner-leakage
        // closing brace. We test only the owner-leakage stage. Future appended
        // scanner stages (e.g. check-test-fixture-shapes #556, PSA-004 sub-mode B
        // commit-guard #495, future #557/#558/...) and lint-staged are all
        // stripped — they have their own dedicated test files. Anchoring on
        // check-owner-leakage's closing brace is future-proof: any stage added
        // before OR after lint-staged is removed automatically.
        .replace(/if command -v gitleaks[\s\S]*?fi\n\n/, '')
        .replace(/(check-owner-leakage\.mjs[\s\S]*?\n\}\n)[\s\S]*$/, '$1');
      const hookDst = join(tmpDir, '.git', 'hooks', 'pre-commit');
      writeFileSync(hookDst, hookSrc);
      chmodSync(hookDst, 0o755);
    });

    afterEach(() => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    it('blocks commit when a planted leak file is staged', () => {
      // Plant a clear P1 (personal home path) leak
      writeFileSync(join(tmpDir, 'doc.md'), 'See /Users/bernhardgoetzendorfer/Projects/vault for notes.\n');
      execFileSync('git', ['-C', tmpDir, 'add', 'doc.md']);
      const result = spawnSync('git', ['-C', tmpDir, 'commit', '-m', 'leak attempt'], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Commit blocked|check-owner-leakage/);
    });

    it('blocks commit when a planted P6 (private slug) leak is staged', () => {
      writeFileSync(join(tmpDir, 'notes.md'), '# Tracking buchhaltgenie deployment\n');
      execFileSync('git', ['-C', tmpDir, 'add', 'notes.md']);
      const result = spawnSync('git', ['-C', tmpDir, 'commit', '-m', 'leak attempt'], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Commit blocked|check-owner-leakage/);
    });

    it('allows commit on a clean fixture (negative path)', () => {
      writeFileSync(join(tmpDir, 'doc.md'), 'A perfectly fine document with no leaks.\n');
      execFileSync('git', ['-C', tmpDir, 'add', 'doc.md']);
      const result = spawnSync('git', ['-C', tmpDir, 'commit', '-m', 'clean commit'], { encoding: 'utf8' });
      expect(result.status).toBe(0);
    });

    it('catches the tracked-after-add false-pass class (#494 root cause)', () => {
      // The exact regression: file is untracked, gets `git add`-ed, then commit
      // is attempted. Before #494 a manual local scan (running before the add)
      // would miss it; the hook scanner runs AFTER add, so it sees the staged
      // tree and blocks.
      writeFileSync(join(tmpDir, 'fresh.md'), 'New file: /Users/bernhardg./private/path/here\n');
      // Verify the file is untracked
      const statusBefore = execFileSync('git', ['-C', tmpDir, 'status', '--short'], { encoding: 'utf8' });
      expect(statusBefore).toContain('?? fresh.md');
      // Now stage it — this is the moment a pre-add scan would miss
      execFileSync('git', ['-C', tmpDir, 'add', 'fresh.md']);
      // And the hook must catch it
      const result = spawnSync('git', ['-C', tmpDir, 'commit', '-m', 'fresh leak'], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
    });
  });
});
