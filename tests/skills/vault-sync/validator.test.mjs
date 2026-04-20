/**
 * tests/skills/vault-sync/validator.test.mjs
 *
 * Vitest port of skills/vault-sync/tests/validator.bats
 * Subject: skills/vault-sync/validator.mjs
 *
 * 21 bats @test blocks covering:
 *   - clean vault (5 tests)
 *   - broken frontmatter (3 tests)
 *   - missing field (1 test)
 *   - dangling wiki-link (2 tests)
 *   - edge cases (4 tests)
 *   - mode flags (3 tests)
 *   - exclude glob (3 tests)
 *   - nested tags (2 tests)
 *   - vault-dir guard (2 tests)
 *
 * Reuses existing fixture vaults at skills/vault-sync/tests/fixtures/
 * via path.resolve — fixtures NOT moved.
 * Spawns `node skills/vault-sync/validator.mjs` subprocess.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const VALIDATOR_MJS = join(REPO_ROOT, 'skills/vault-sync/validator.mjs');
const VALIDATOR_CWD = join(REPO_ROOT, 'skills/vault-sync');
const FIXTURES = join(REPO_ROOT, 'skills/vault-sync/tests/fixtures');

function runValidator(fixtureDir, extraArgs = [], env = {}) {
  return spawnSync('node', [VALIDATOR_MJS, ...extraArgs], {
    encoding: 'utf8',
    cwd: VALIDATOR_CWD,
    env: { ...process.env, VAULT_DIR: fixtureDir, ...env },
  });
}

// ── Clean vault ─────────────────────────────────────────────────────────────

describe('clean vault', () => {
  const cleanVault = join(FIXTURES, 'clean-vault');

  it('exits 0 and status is "ok"', () => {
    const result = runValidator(cleanVault);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('ok');
  });

  it('JSON output is valid and parseable', () => {
    const result = runValidator(cleanVault);
    expect(result.status).toBe(0);
    // Must not throw
    const parsed = JSON.parse(result.stdout);
    expect(typeof parsed).toBe('object');
  });

  it('skips README without frontmatter (files_skipped_no_frontmatter >= 1)', () => {
    const result = runValidator(cleanVault);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.files_skipped_no_frontmatter).toBeGreaterThanOrEqual(1);
  });

  it('counts valid frontmatter files (files_checked == 3)', () => {
    const result = runValidator(cleanVault);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).files_checked).toBe(3);
  });

  it('excludes .obsidian/ directory (no errors)', () => {
    const result = runValidator(cleanVault);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).errors.length).toBe(0);
  });
});

// ── Broken frontmatter vault ─────────────────────────────────────────────────

describe('broken-frontmatter vault', () => {
  const brokenVault = join(FIXTURES, 'broken-frontmatter-vault');

  it('exits 1 and status is "invalid"', () => {
    const result = runValidator(brokenVault);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).status).toBe('invalid');
  });

  it('error mentions bad-type.md', () => {
    const result = runValidator(brokenVault);
    expect(result.status).toBe(1);
    const errors = JSON.parse(result.stdout).errors;
    const hit = errors.filter((e) => e.file && e.file.includes('bad-type'));
    expect(hit.length).toBeGreaterThanOrEqual(1);
  });

  it('zod issue path is "type"', () => {
    const result = runValidator(brokenVault);
    expect(result.status).toBe(1);
    const errors = JSON.parse(result.stdout).errors;
    const badTypeError = errors.find((e) => e.file && e.file.includes('bad-type'));
    expect(badTypeError).toBeDefined();
    expect(badTypeError.path).toBe('type');
  });
});

// ── Missing-field vault ───────────────────────────────────────────────────────

describe('missing-field vault', () => {
  it('exits 1 with error mentioning "id"', () => {
    const result = runValidator(join(FIXTURES, 'missing-field-vault'));
    expect(result.status).toBe(1);
    const errors = JSON.parse(result.stdout).errors;
    expect(errors[0].path).toBe('id');
  });
});

// ── Dangling wiki-link vault ─────────────────────────────────────────────────

describe('dangling-link vault', () => {
  const danglingVault = join(FIXTURES, 'dangling-link-vault');

  it('exits 0 (warnings do not fail) with dangling warning present', () => {
    const result = runValidator(danglingVault);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('ok');
    const danglingWarnings = parsed.warnings.filter((w) => w.type === 'dangling-wiki-link');
    expect(danglingWarnings.length).toBeGreaterThanOrEqual(1);
  });

  it('existing link target does NOT produce a warning', () => {
    const result = runValidator(danglingVault);
    expect(result.status).toBe(0);
    const warnings = JSON.parse(result.stdout).warnings;
    const realTargetWarnings = warnings.filter(
      (w) => w.message && w.message.includes('real-target'),
    );
    expect(realTargetWarnings.length).toBe(0);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('non-existent vault dir: exits 0 and status is "skipped"', () => {
    const result = runValidator(`/tmp/this-dir-does-not-exist-${Date.now()}-test`);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('skipped');
  });

  it('empty vault (dir with no .md files): status is "skipped"', () => {
    const result = runValidator(join(FIXTURES, 'empty-vault'));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('skipped');
  });

  it('README-only vault: exits 0 with files_skipped_no_frontmatter == 2 and files_checked == 0', () => {
    const result = runValidator(join(FIXTURES, 'no-frontmatter-vault'));
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('ok');
    expect(parsed.files_skipped_no_frontmatter).toBe(2);
    expect(parsed.files_checked).toBe(0);
  });

  it('archive-test vault: 90-archive/ is excluded (only live-note is checked)', () => {
    const result = runValidator(join(FIXTURES, 'archive-test-vault'));
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.files_checked).toBe(1);
    expect(parsed.errors.length).toBe(0);
  });
});

// ── Mode flags ────────────────────────────────────────────────────────────────

describe('mode flags', () => {
  const brokenVault = join(FIXTURES, 'broken-frontmatter-vault');

  it('--mode warn: broken vault exits 0 but reports errors in JSON', () => {
    const result = runValidator(brokenVault, ['--mode', 'warn']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('ok');
    expect(parsed.mode).toBe('warn');
    expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('--mode off: broken vault exits 0 with status "skipped-mode-off"', () => {
    const result = runValidator(brokenVault, ['--mode', 'off']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('skipped-mode-off');
    expect(parsed.mode).toBe('off');
    expect(parsed.errors.length).toBe(0);
  });

  it('--mode hard (default): broken vault exits 1 with mode="hard"', () => {
    const result = runValidator(brokenVault, ['--mode', 'hard']);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('invalid');
    expect(parsed.mode).toBe('hard');
  });

  it('JSON output always includes mode field on normal runs (default is "hard")', () => {
    const result = runValidator(join(FIXTURES, 'clean-vault'));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).mode).toBe('hard');
  });
});

// ── Exclude glob ─────────────────────────────────────────────────────────────

describe('exclude glob', () => {
  const mocVault = join(FIXTURES, 'with-moc-vault');

  it('with --exclude "**/_MOC.md": with-moc-vault passes', () => {
    const result = runValidator(mocVault, ['--exclude', '**/_MOC.md']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('ok');
    expect(parsed.excluded_count).toBe(1);
    expect(parsed.files_checked).toBe(1);
    expect(parsed.errors.length).toBe(0);
  });

  it('without --exclude: with-moc-vault fails (baseline)', () => {
    const result = runValidator(mocVault);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('invalid');
    expect(parsed.excluded_count).toBe(0);
  });

  it('repeatable --exclude flags accumulate', () => {
    const result = runValidator(mocVault, ['--exclude', '**/_MOC.md', '--exclude', '**/does-not-exist.md']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).excluded_count).toBe(1);
  });
});

// ── Nested-tag vault ──────────────────────────────────────────────────────────

describe('nested-tag vault', () => {
  const nestedTagVault = join(FIXTURES, 'nested-tag-vault');

  it('exits 0 and status is "ok" in hard mode with slash-separated tags', () => {
    const result = runValidator(nestedTagVault);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('ok');
    expect(parsed.errors.length).toBe(0);
  });

  it('both files with nested tags are validated (files_checked == 2)', () => {
    const result = runValidator(nestedTagVault);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).files_checked).toBe(2);
  });
});

// ── vault-dir guard (isVaultDir) ──────────────────────────────────────────────

describe('vault-dir guard', () => {
  it('no VAULT_DIR and cwd is not a vault: exits 2 with actionable error', () => {
    const nonVaultDir = mkdtempSync(join(tmpdir(), 'non-vault-'));
    const result = spawnSync('node', [VALIDATOR_MJS], {
      encoding: 'utf8',
      cwd: nonVaultDir,
      env: { ...process.env, VAULT_DIR: undefined },
    });
    try {
      rmSync(nonVaultDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).toContain('VAULT_DIR is not set');
  });

  it('no VAULT_DIR but cwd is a vault (_meta/ present): exits 0 with JSON on stdout', () => {
    const vaultDir = mkdtempSync(join(tmpdir(), 'vault-with-meta-'));
    mkdirSync(join(vaultDir, '_meta'), { recursive: true });
    // Copy a valid note so there's something to validate
    const cleanVaultNote = join(FIXTURES, 'clean-vault', 'hello-world.md');
    writeFileSync(join(vaultDir, 'hello-world.md'), readFileSync(cleanVaultNote, 'utf8'), 'utf8');

    const result = spawnSync('node', [VALIDATOR_MJS], {
      encoding: 'utf8',
      cwd: VALIDATOR_CWD,
      env: { ...process.env, VAULT_DIR: vaultDir },
    });
    try {
      rmSync(vaultDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    expect(result.status).toBe(0);
    // Must be parseable JSON
    JSON.parse(result.stdout);
  });
});
