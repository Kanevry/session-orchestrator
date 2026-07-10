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
import { readFileSync, mkdtempSync, writeFileSync, rmSync, cpSync, mkdirSync, chmodSync, symlinkSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const HOOK_PATH = join(REPO_ROOT, '.husky', 'pre-commit');
const SCANNER_PATH = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-owner-leakage.mjs');
const CONFIDENTIAL_NAMES_HELPER_PATH = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'confidential-names.mjs');
const HOST_PATHS_HELPER_PATH = join(REPO_ROOT, 'scripts', 'lib', 'config', 'host-paths.mjs');
const OWNER_YAML_HELPER_PATH = join(REPO_ROOT, 'scripts', 'lib', 'owner-yaml.mjs');
const NODE_MODULES_PATH = join(REPO_ROOT, 'node_modules');

/** Build the same owner-leakage-only hook slice the E2E beforeEach installs below. */
function buildOwnerLeakageHookSlice() {
  return readFileSync(HOOK_PATH, 'utf8')
    .replace(/if command -v gitleaks[\s\S]*?fi\n\n/, '')
    .replace(/(check-owner-leakage\.mjs[\s\S]*?\n\}\n)[\s\S]*$/, '$1');
}

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

    it('blocks commit when a NOVEL-encoded home path is staged (#661 canonicalization)', () => {
      // The scanner now canonicalizes encodings before matching, so a home path
      // re-spelled with url-percent separators — which the old slash-form regex
      // would have MISSED — is caught end-to-end through the git hook.
      writeFileSync(join(tmpDir, 'enc.md'), 'leak: %2FUsers%2Fbernhardg%2Fsecret\n');
      execFileSync('git', ['-C', tmpDir, 'add', 'enc.md']);
      const result = spawnSync('git', ['-C', tmpDir, 'commit', '-m', 'encoded leak'], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Commit blocked|check-owner-leakage/);
    });

    it('blocks commit when a CAPITALIZED-username home path is staged (#661 Finding 1 HIGH)', () => {
      // /Users/Bernhardg. is a real operator path on case-insensitive APFS. The
      // username segment is now matched case-INSENSITIVELY, so the capitalized
      // form — which the old case-sensitive regex MISSED (exploitable false
      // negative) — is blocked end-to-end through the git hook.
      writeFileSync(join(tmpDir, 'cap.md'), 'home: /Users/Bernhardg./Projects/secret\n');
      execFileSync('git', ['-C', tmpDir, 'add', 'cap.md']);
      const result = spawnSync('git', ['-C', tmpDir, 'commit', '-m', 'capitalized leak'], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Commit blocked|check-owner-leakage/);
    });

    it('blocks commit when a zero-width-spliced home path is staged (#661 Finding 3)', () => {
      // A zero-width space wedged into the username breaks a contiguous-literal
      // match; the scanner now strips format chars from the canonical form.
      writeFileSync(join(tmpDir, 'zw.md'), 'p: /Users/bern\u200bhardg/secret\n');
      execFileSync('git', ['-C', tmpDir, 'add', 'zw.md']);
      const result = spawnSync('git', ['-C', tmpDir, 'commit', '-m', 'zero-width leak'], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Commit blocked|check-owner-leakage/);
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

    it('allows commit when a CP11 names-file is configured but the standalone-copied scanner lacks the confidential-names helper modules (inert degrade, #728a)', () => {
      // This tmpDir setup (from beforeEach above) copies ONLY the scanner file —
      // the documented standalone single-file vendoring shape (security.md §
      // Owner-Privacy). Configuring SO_CONFIDENTIAL_NAMES_FILE here must NOT crash
      // the hook and must NOT block the commit: getConfidentialNamePatterns()
      // dynamically imports ../config/host-paths.mjs, which does not exist at this
      // relative path inside tmpDir, so CP11 degrades to [] (inert) and CP1–CP10
      // (which do not match this fixture text) leave the commit clean.
      const namesDir = mkdtempSync(join(tmpdir(), 'so-husky-cp11-inert-names-'));
      const namesFile = join(namesDir, 'names.json');
      writeFileSync(namesFile, JSON.stringify(['zenithcorp']));
      writeFileSync(join(tmpDir, 'doc.md'), 'zenithcorp leak here\n');
      execFileSync('git', ['-C', tmpDir, 'add', 'doc.md']);

      const result = spawnSync('git', ['-C', tmpDir, 'commit', '-m', 'inert cp11 attempt'], {
        encoding: 'utf8',
        env: { ...process.env, SO_CONFIDENTIAL_NAMES_FILE: namesFile },
      });

      rmSync(namesDir, { recursive: true, force: true });

      expect(result.status).toBe(0);
    });
  });

  describe('CP11 — confidential-names redaction via host-local list (#728a)', () => {
    let tmpDir;
    let namesDir;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'so-husky-cp11-active-'));
      execFileSync('git', ['init', '-q', tmpDir], { encoding: 'utf8' });
      execFileSync('git', ['-C', tmpDir, 'config', 'user.email', 'test@example.com']);
      execFileSync('git', ['-C', tmpDir, 'config', 'user.name', 'Test']);
      execFileSync('git', ['-C', tmpDir, 'config', 'commit.gpgsign', 'false']);

      // Copy the scanner AND the three host-local helper modules it dynamically
      // imports for CP11, at their real relative paths, so getConfidentialNamePatterns()
      // resolves them from inside tmpDir.
      mkdirSync(join(tmpDir, 'scripts', 'lib', 'validate'), { recursive: true });
      mkdirSync(join(tmpDir, 'scripts', 'lib', 'config'), { recursive: true });
      cpSync(SCANNER_PATH, join(tmpDir, 'scripts', 'lib', 'validate', 'check-owner-leakage.mjs'));
      cpSync(CONFIDENTIAL_NAMES_HELPER_PATH, join(tmpDir, 'scripts', 'lib', 'validate', 'confidential-names.mjs'));
      cpSync(HOST_PATHS_HELPER_PATH, join(tmpDir, 'scripts', 'lib', 'config', 'host-paths.mjs'));
      cpSync(OWNER_YAML_HELPER_PATH, join(tmpDir, 'scripts', 'lib', 'owner-yaml.mjs'));
      // owner-yaml.mjs statically imports 'js-yaml' from node_modules. tmpDir has
      // no node_modules of its own, so ESM bare-specifier resolution would fail
      // with ERR_MODULE_NOT_FOUND — symlink the real repo's node_modules so the
      // dynamic import chain (host-paths.mjs -> owner-yaml.mjs -> js-yaml)
      // resolves and CP11 actually activates (proving the ACTIVE path, distinct
      // from the inert-degrade case above).
      symlinkSync(NODE_MODULES_PATH, join(tmpDir, 'node_modules'), 'dir');

      const hookDst = join(tmpDir, '.git', 'hooks', 'pre-commit');
      writeFileSync(hookDst, buildOwnerLeakageHookSlice());
      chmodSync(hookDst, 0o755);

      namesDir = mkdtempSync(join(tmpdir(), 'so-husky-cp11-names-'));
    });

    afterEach(() => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
      if (namesDir) rmSync(namesDir, { recursive: true, force: true });
    });

    it('blocks the commit end-to-end and redacts the confidential name in the scanner output', () => {
      const namesFile = join(namesDir, 'names.json');
      writeFileSync(namesFile, JSON.stringify(['zenithcorp']));
      writeFileSync(join(tmpDir, 'doc.md'), 'zenithcorp leak here\n');
      execFileSync('git', ['-C', tmpDir, 'add', 'doc.md']);

      // Env is passed ONLY via the spawnSync `env` option — never mutated on
      // process.env — so this test cannot leak SO_CONFIDENTIAL_NAMES_FILE into
      // any other test in this file or suite.
      const commitEnv = { ...process.env, SO_CONFIDENTIAL_NAMES_FILE: namesFile };

      const result = spawnSync('git', ['-C', tmpDir, 'commit', '-m', 'cp11 leak attempt'], {
        encoding: 'utf8',
        env: commitEnv,
      });

      // The hook blocks the commit end-to-end.
      expect(result.status).not.toBe(0);
      // The hook's owner-leakage stage redirects the scanner's own stdout/stderr
      // to /dev/null (`>/dev/null 2>&1`) and only echoes a FIXED, generic message
      // on scanner failure — so the confidential name can never reach the
      // git-commit capture through this path either way.
      expect(result.stdout).not.toContain('zenithcorp');
      expect(result.stderr).not.toContain('zenithcorp');

      // The redaction CONTRACT itself (name never printed verbatim, [REDACTED]
      // substituted instead) is only observable on the scanner's OWN stdout —
      // the hook swallows it (see above) — so invoke the scanner directly, the
      // same way the hook does: a RELATIVE script path with cwd: tmpDir (not
      // an absolute scannerPath). mkdtempSync() returns the non-canonical
      // macOS tmp form (/var/folders/... instead of /private/var/folders/...);
      // the scanner's isMain check compares resolve(argv[1]) against
      // fileURLToPath(import.meta.url), which IS canonicalized by Node's ESM
      // loader — an absolute non-canonical argv[1] silently fails that
      // comparison (isMain=false, runScan() never called, exit 0 with zero
      // output). A relative path resolved via process.cwd() picks up the
      // canonical form instead, exactly like the git hook's own invocation.
      const scannerResult = spawnSync('node', ['scripts/lib/validate/check-owner-leakage.mjs', tmpDir], {
        cwd: tmpDir,
        encoding: 'utf8',
        env: commitEnv,
      });
      expect(scannerResult.status).not.toBe(0);
      expect(scannerResult.stdout).not.toContain('zenithcorp');
      expect(scannerResult.stdout).toContain('[REDACTED]');
    });
  });
});
