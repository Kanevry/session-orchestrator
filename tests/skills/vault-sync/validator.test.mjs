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
/** Fixtures owned by this vitest file (co-located, not shared with the bats suite). */
const LOCAL_FIXTURES = join(__dirname, 'fixtures');

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

// ── Wiki-link alias parsing ──────────────────────────────────────────────────

describe('wiki-link alias parsing', () => {
  function makeWikiLinkVault(linkText, includeTarget = true) {
    const dir = mkdtempSync(join(tmpdir(), 'vault-wikilink-test-'));
    const sourceNote = `---\nid: source-note\ntype: note\ncreated: 2026-07-03\nupdated: 2026-07-03\n---\n\n${linkText}\n`;
    writeFileSync(join(dir, 'source-note.md'), sourceNote, 'utf8');

    if (includeTarget) {
      const targetNote = '---\nid: real-target\ntype: note\ncreated: 2026-07-03\nupdated: 2026-07-03\n---\n\n# Real target\n';
      writeFileSync(join(dir, 'real-target.md'), targetNote, 'utf8');
    }

    return dir;
  }

  it('does not warn for an existing target with a Markdown-table escaped alias separator', () => {
    const vaultDir = makeWikiLinkVault('[[real-target\\|Alias]]');
    const result = runValidator(vaultDir);
    try { rmSync(vaultDir, { recursive: true, force: true }); } catch { /* ignore */ }
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.warnings.filter((w) => w.type === 'dangling-wiki-link')).toEqual([]);
  });

  it('does not warn for an existing target with an anchor and escaped alias separator', () => {
    const vaultDir = makeWikiLinkVault('[[real-target#Heading\\|Alias]]');
    const result = runValidator(vaultDir);
    try { rmSync(vaultDir, { recursive: true, force: true }); } catch { /* ignore */ }
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.warnings.filter((w) => w.type === 'dangling-wiki-link')).toEqual([]);
  });

  it('warns for the actual missing target when an escaped alias separator is present', () => {
    const vaultDir = makeWikiLinkVault('[[missing-target\\|Alias]]', false);
    const result = runValidator(vaultDir);
    try { rmSync(vaultDir, { recursive: true, force: true }); } catch { /* ignore */ }
    expect(result.status).toBe(0);
    const danglingWarnings = JSON.parse(result.stdout).warnings.filter((w) => w.type === 'dangling-wiki-link');
    expect(danglingWarnings).toHaveLength(1);
    expect(danglingWarnings[0].message).toContain('[[missing-target]]');
    expect(danglingWarnings[0].message).not.toContain('missing-target\\');
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

// ── Link-target register vs check-set (#833) ─────────────────────────────────
//
// EXCLUDED_DIRS (walk-level) and CHECK_EXCLUDED_TOP_DIRS (validation-level) are
// deliberately separate sets. Archived notes are WALKED (so they can resolve as
// wiki-link targets) but never CHECKED (so their frontmatter cannot block a
// close). These tests pin both halves plus the register's new key sources.

describe('link-target register (#833)', () => {
  const archiveLinkVault = join(LOCAL_FIXTURES, 'archive-link-vault');

  /**
   * FAKE-REGRESSION GUARD. Verified to go RED when '90-archive' is put back
   * into EXCLUDED_DIRS in skills/vault-sync/validator.mjs — see the session
   * report for the observed transcript. The link in live-note.md is a BARE
   * basename on purpose: a pathed [[90-archive/archived-note]] resolves via the
   * existsSync candidate branch regardless of the register, which would make
   * this assertion vacuously green.
   */
  it('a live note linking [[archived-note]] by bare basename produces NO dangling warning', () => {
    const result = runValidator(archiveLinkVault);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.warnings.filter((w) => w.type === 'dangling-wiki-link')).toEqual([]);
  });

  it('archived notes are still excluded from CHECKING (counted, not validated)', () => {
    const result = runValidator(archiveLinkVault);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    // Only live-note.md is checked; the archived note is skipped and counted.
    expect(parsed.files_checked).toBe(1);
    expect(parsed.archived_skipped_count).toBe(1);
    expect(parsed.errors).toEqual([]);
  });

  it('archived notes with INVALID frontmatter produce no error entry', () => {
    // archive-test-vault/90-archive/bad-archived.md has type: memo + bogus dates.
    const result = runValidator(join(FIXTURES, 'archive-test-vault'));
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.errors.filter((e) => e.file && e.file.includes('bad-archived'))).toEqual([]);
    expect(parsed.archived_skipped_count).toBe(1);
  });

  it('archived_skipped_count does NOT overload excluded_count (glob-matched files only)', () => {
    const result = runValidator(archiveLinkVault);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.excluded_count).toBe(0);
    expect(parsed.archived_skipped_count).toBe(1);
  });

  it('archive-only vault: exits 0 with status "ok" and files_checked 0', () => {
    // Edge: before #833 an archive-only vault produced mdFiles.length === 0 →
    // status "skipped". Archived notes are now walked, so the run proceeds.
    const dir = mkdtempSync(join(tmpdir(), 'vault-archive-only-'));
    mkdirSync(join(dir, '_meta'), { recursive: true });
    mkdirSync(join(dir, '90-archive'), { recursive: true });
    writeFileSync(
      join(dir, '90-archive', 'only-note.md'),
      '---\nid: only-note\ntype: note\ncreated: 2026-07-19\nupdated: 2026-07-19\n---\n\nBody.\n',
      'utf8',
    );
    const result = runValidator(dir);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('ok');
    expect(parsed.files_checked).toBe(0);
    expect(parsed.archived_skipped_count).toBe(1);
  });
});

describe('link-target register — id and aliases keys (#833)', () => {
  /**
   * Builds a two-note vault: a target note whose FILENAME deliberately differs
   * from the register key under test, and a source note linking that key.
   */
  function makeRegisterVault(targetFrontmatter, linkTarget, targetFilename = 'zzz-unrelated-filename.md') {
    const dir = mkdtempSync(join(tmpdir(), 'vault-register-'));
    mkdirSync(join(dir, '_meta'), { recursive: true });
    writeFileSync(join(dir, targetFilename), `---\n${targetFrontmatter}\n---\n\nTarget body.\n`, 'utf8');
    writeFileSync(
      join(dir, 'source.md'),
      `---\nid: source\ntype: note\ncreated: 2026-07-19\nupdated: 2026-07-19\n---\n\nSee [[${linkTarget}]].\n`,
      'utf8',
    );
    return dir;
  }

  function danglingOf(result) {
    return JSON.parse(result.stdout).warnings.filter((w) => w.type === 'dangling-wiki-link');
  }

  it('frontmatter `id` resolves a link when no file of that basename exists', () => {
    const dir = makeRegisterVault(
      'id: canonical-id\ntype: note\ncreated: 2026-07-19\nupdated: 2026-07-19',
      'canonical-id',
    );
    const result = runValidator(dir);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    expect(result.status).toBe(0);
    expect(danglingOf(result)).toEqual([]);
  });

  it('frontmatter `aliases` entry resolves a link', () => {
    const dir = makeRegisterVault(
      'id: alias-target\ntype: note\ncreated: 2026-07-19\nupdated: 2026-07-19\naliases:\n  - Some Alias\n  - second-alias',
      'second-alias',
    );
    const result = runValidator(dir);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    expect(result.status).toBe(0);
    expect(danglingOf(result)).toEqual([]);
  });

  it('a still-unknown link target remains dangling (register does not resolve everything)', () => {
    const dir = makeRegisterVault(
      'id: canonical-id\ntype: note\ncreated: 2026-07-19\nupdated: 2026-07-19',
      'no-such-target',
    );
    const result = runValidator(dir);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    expect(result.status).toBe(0);
    const dangling = danglingOf(result);
    expect(dangling).toHaveLength(1);
    expect(dangling[0].message).toContain('[[no-such-target]]');
  });

  it('a scalar-string `aliases` does not crash the validator — JSON stays well-formed', () => {
    // `aliases: not-an-array` violates the Zod array schema (→ an error entry)
    // but MUST NOT throw out of the register build in pass 1.
    const dir = makeRegisterVault(
      'id: scalar-alias\ntype: note\ncreated: 2026-07-19\nupdated: 2026-07-19\naliases: not-an-array',
      'scalar-alias',
    );
    const result = runValidator(dir);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    // Exit 1 because the schema rejects the scalar — but the run completed.
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('invalid');
    expect(parsed.errors.some((e) => e.path === 'aliases')).toBe(true);
    // The `id` key still registered, so the link resolved.
    expect(parsed.warnings.filter((w) => w.type === 'dangling-wiki-link')).toEqual([]);
  });
});

describe('link-target register — case-insensitive NFC keys (#833)', () => {
  function makeVault(files) {
    const dir = mkdtempSync(join(tmpdir(), 'vault-case-'));
    mkdirSync(join(dir, '_meta'), { recursive: true });
    for (const [relPath, content] of Object.entries(files)) {
      const abs = join(dir, relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf8');
    }
    return dir;
  }

  const note = (id, body = '') =>
    `---\nid: ${id}\ntype: note\ncreated: 2026-07-19\nupdated: 2026-07-19\n---\n\n${body}\n`;

  /**
   * Target note whose key under test lives in `aliases`, NOT in its filename.
   *
   * Case parity CANNOT be tested via filenames on this host: APFS is both
   * case-insensitive and normalization-insensitive, so resolveWikiLink's
   * existsSync candidate branch resolves `[[some-TOPIC]]` against `Some-Topic.md`
   * (and an NFD link against an NFC file) BEFORE the register is ever consulted
   * — such a test is vacuously green even with a case-sensitive register.
   * Verified empirically: existsSync('<tmp>/some-TOPIC.md') === true for a file
   * written as 'Some-Topic.md'. Routing the key through `aliases` on an
   * unrelated filename makes the register the only possible resolution path.
   */
  const aliasTarget = (alias) =>
    `---\nid: alias-target\ntype: note\ncreated: 2026-07-19\nupdated: 2026-07-19\naliases:\n  - ${alias}\n---\n\nTarget.\n`;

  it('resolves a link whose case differs from the registered alias key', () => {
    const dir = makeVault({
      'zzz-unrelated-filename.md': aliasTarget('Some-Topic'),
      'source.md': note('source', 'See [[some-TOPIC]].'),
    });
    const result = runValidator(dir);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    expect(result.status).toBe(0);
    const dangling = JSON.parse(result.stdout).warnings.filter((w) => w.type === 'dangling-wiki-link');
    expect(dangling).toEqual([]);
  });

  it('resolves an NFD-composed umlaut link against an NFC-registered key (German corpus)', () => {
    // 'Übung' composed (NFC, U+00DC) in the register vs decomposed
    // (NFD, U+0055 U+0308) in the link body.
    const nfc = 'Übung'.normalize('NFC');
    const nfd = 'Übung'.normalize('NFD');
    expect(nfc).not.toBe(nfd); // guard: the pair really differs code-point-wise
    const dir = makeVault({
      'zzz-umlaut-filename.md': aliasTarget(nfc),
      'source.md': note('source', `See [[${nfd}]].`),
    });
    const result = runValidator(dir);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    expect(result.status).toBe(0);
    const dangling = JSON.parse(result.stdout).warnings.filter((w) => w.type === 'dangling-wiki-link');
    expect(dangling).toEqual([]);
  });

  it('case-collision across subdirs (Topic.md + topic.md) does not regress link resolution', () => {
    // fileIndex values are arrays, so a lowercased-key collision merely appends.
    const dir = makeVault({
      'a/Topic.md': note('topic-upper'),
      'b/topic.md': note('topic-lower'),
      'source.md': note('source', 'See [[Topic]].'),
    });
    const result = runValidator(dir);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.warnings.filter((w) => w.type === 'dangling-wiki-link')).toEqual([]);
    expect(parsed.files_checked).toBe(3);
    expect(parsed.errors).toEqual([]);
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

// ── vaultNoteTypeSchema enum coverage ────────────────────────────────────────
//
// Guards the vaultNoteTypeSchema enum against regressions that would silently
// break vault-sync for first-class note types emitted by generators.

describe('vaultNoteTypeSchema enum coverage', () => {
  function makeTempVault(frontmatterLines) {
    const dir = mkdtempSync(join(tmpdir(), 'vault-pc-test-'));
    const note = `---\n${frontmatterLines}\n---\n\n# Test note\n`;
    writeFileSync(join(dir, 'test-note.md'), note, 'utf8');
    return dir;
  }

  it.each([
    ['note'],
    ['daily'],
    ['project'],
    ['person'],
    ['reference'],
    ['idea'],
    ['learning'],
    ['session'],
    ['peer-card'],
    ['board'],
  ])('accepts type: %s (all vaultNoteTypeSchema enum values, including generated boards from #738)', (typeValue) => {
    const vaultDir = makeTempVault(
      `id: test-type-enum\ntype: ${typeValue}\ncreated: 2026-05-23\nupdated: 2026-05-23`,
    );
    const result = runValidator(vaultDir);
    try {
      rmSync(vaultDir, { recursive: true, force: true });
    } catch { /* ignore */ }
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('ok');
    expect(parsed.errors.length).toBe(0);
  });

  it('rejects unknown type values with a type-path error', () => {
    const vaultDir = makeTempVault(
      'id: test-unknown-type\ntype: totally-fake-type\ncreated: 2026-05-23\nupdated: 2026-05-23',
    );
    const result = runValidator(vaultDir);
    try {
      rmSync(vaultDir, { recursive: true, force: true });
    } catch { /* ignore */ }
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('invalid');
    const typeError = parsed.errors.find((e) => e.path === 'type');
    expect(typeError).toBeDefined();
    expect(typeError.path).toBe('type');
  });
});

// ── source-repo optional field (#725 D2) ──────────────────────────────────────

describe('source-repo optional field (#725 D2)', () => {
  function makeTempVault(frontmatterLines) {
    const dir = mkdtempSync(join(tmpdir(), 'vault-src-repo-test-'));
    const note = `---\n${frontmatterLines}\n---\n\n# Test note\n`;
    writeFileSync(join(dir, 'test-note.md'), note, 'utf8');
    return dir;
  }

  it('accepts a learning note WITH source-repo (string)', () => {
    const vaultDir = makeTempVault(
      'id: test-src-repo\ntype: learning\ncreated: 2026-07-02\nupdated: 2026-07-02\nsource-repo: session-orchestrator',
    );
    const result = runValidator(vaultDir);
    try { rmSync(vaultDir, { recursive: true, force: true }); } catch { /* ignore */ }
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('ok');
    expect(parsed.errors.length).toBe(0);
  });

  it('accepts a learning note WITHOUT source-repo (field is optional — backward-compatible)', () => {
    const vaultDir = makeTempVault(
      'id: test-no-src-repo\ntype: learning\ncreated: 2026-07-02\nupdated: 2026-07-02',
    );
    const result = runValidator(vaultDir);
    try { rmSync(vaultDir, { recursive: true, force: true }); } catch { /* ignore */ }
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('ok');
    expect(parsed.errors.length).toBe(0);
  });

  it('rejects a non-string source-repo — proves the explicit declaration bites (not mere passthrough)', () => {
    // A YAML sequence parses to an array → z.string() fails. Without the explicit
    // `'source-repo': z.string().optional()` declaration, .passthrough() would
    // accept ANY value here — so this asserts the declaration is load-bearing.
    const vaultDir = makeTempVault(
      'id: test-bad-src-repo\ntype: learning\ncreated: 2026-07-02\nupdated: 2026-07-02\nsource-repo: [not, a, string]',
    );
    const result = runValidator(vaultDir);
    try { rmSync(vaultDir, { recursive: true, force: true }); } catch { /* ignore */ }
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('invalid');
    const srcRepoError = parsed.errors.find((e) => e.path === 'source-repo');
    expect(srcRepoError).toBeDefined();
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
