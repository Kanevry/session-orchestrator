/**
 * tests/lib/vault-consolidate-fs.test.mjs
 *
 * Unit suite for scripts/lib/vault-consolidate-fs.mjs — the filesystem +
 * classification helpers extracted from scripts/vault-consolidate.mjs
 * (issue #514 / #607 architect MED item 3).
 *
 * BEFORE the extraction, vault-consolidate.mjs ran main() unconditionally on
 * import (no entry-guard), so walkFiles / stageBackup / classifyFile could only
 * be exercised through the CLI subprocess. The `stageBackup` lstat symlink-skip
 * in particular was SHADOWED by the walk-level guard in the live flow and so
 * was structurally untestable in isolation. Now that the helpers live in an
 * importable module behind an entry-guard, this suite reaches each one
 * directly.
 *
 * The CLI contract is still covered by tests/scripts/vault-consolidate.test.mjs
 * (subprocess) — this file complements, not replaces, that suite.
 *
 * Every test uses isolated tmpdirs under os.tmpdir(); none touch the real
 * vaults. Expected sha256 digests are hardcoded canonical/published test
 * vectors (NOT recomputed via crypto in-test — see test-quality.md tautology
 * rule).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  SCRIPT_NAME,
  BACKUP_PREFIX,
  DECISIONS_SIDECAR_REL,
  walkFiles,
  sha256OfFile,
  isPrefix,
  classifyFile,
  stageBackup,
  compressAndCleanupBackup,
} from '../../scripts/lib/vault-consolidate-fs.mjs';

describe('vault-consolidate-fs helpers', () => {
  let tmpRoots = [];

  beforeEach(() => {
    tmpRoots = [];
  });

  afterEach(() => {
    for (const d of tmpRoots) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    tmpRoots = [];
  });

  function mkTmp(prefix) {
    const d = mkdtempSync(join(tmpdir(), `vc-fs-${prefix}-`));
    tmpRoots.push(d);
    return d;
  }

  // -------------------------------------------------------------------------
  // Exported constants
  // -------------------------------------------------------------------------

  it('exports the shared constants the script + tests rely on', () => {
    expect(SCRIPT_NAME).toBe('vault-consolidate');
    expect(BACKUP_PREFIX).toBe('.vault-backup-');
    expect(DECISIONS_SIDECAR_REL).toBe('.vault-consolidate-decisions.json');
  });

  // -------------------------------------------------------------------------
  // sha256OfFile — hardcoded published vectors (no tautological recompute)
  // -------------------------------------------------------------------------

  it('sha256OfFile hashes file bytes to the canonical "abc" SHA-256 vector', async () => {
    // ba78... is THE published SHA-256 test vector for the bytes "abc".
    const dir = mkTmp('sha-abc');
    const f = join(dir, 'abc.txt');
    writeFileSync(f, 'abc'); // exactly the 3 bytes 0x61 0x62 0x63
    const digest = await sha256OfFile(f);
    expect(digest).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('sha256OfFile hashes an empty file to the canonical empty-input SHA-256 vector', async () => {
    // e3b0... is the published SHA-256 of the empty byte string.
    const dir = mkTmp('sha-empty');
    const f = join(dir, 'empty.txt');
    writeFileSync(f, '');
    const digest = await sha256OfFile(f);
    expect(digest).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('sha256OfFile rejects when the file does not exist', async () => {
    const dir = mkTmp('sha-missing');
    await expect(sha256OfFile(join(dir, 'nope.txt'))).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // isPrefix — pure string predicate, modulo trailing whitespace
  // -------------------------------------------------------------------------

  it('isPrefix is true when b starts with a (after trimEnd of a)', () => {
    expect(isPrefix('shared line\n', 'shared line\nextra\n')).toBe(true);
  });

  it('isPrefix trims trailing whitespace from a before comparing', () => {
    // 'foo   ' trims to 'foo', which IS a prefix of 'foobar'.
    expect(isPrefix('foo   ', 'foobar')).toBe(true);
  });

  it('isPrefix is false when b does not start with a', () => {
    expect(isPrefix('canonical', 'source text')).toBe(false);
  });

  it('isPrefix is false when a (trimmed) is empty — empty is not a meaningful prefix', () => {
    expect(isPrefix('   \n', 'anything')).toBe(false);
    expect(isPrefix('', 'anything')).toBe(false);
  });

  it('isPrefix is false when a is longer than b', () => {
    expect(isPrefix('a very long string', 'short')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // walkFiles — skip semantics + sort + symlink guard
  // -------------------------------------------------------------------------

  it('walkFiles returns sorted absolute paths of regular files only', async () => {
    const root = mkTmp('walk-basic');
    writeFileSync(join(root, 'b.md'), 'b\n');
    writeFileSync(join(root, 'a.md'), 'a\n');
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'sub', 'c.md'), 'c\n');

    const files = await walkFiles(root);
    expect(files).toEqual([
      join(root, 'a.md'),
      join(root, 'b.md'),
      join(root, 'sub', 'c.md'),
    ]);
  });

  it('walkFiles skips .git / .obsidian / .trash / node_modules / .vault-backup-* dirs', async () => {
    const root = mkTmp('walk-skip-dirs');
    for (const d of ['.git', '.obsidian', '.trash', 'node_modules', '.vault-backup-123']) {
      mkdirSync(join(root, d), { recursive: true });
      writeFileSync(join(root, d, 'inside.md'), 'hidden\n');
    }
    writeFileSync(join(root, 'real.md'), 'real\n');

    const files = await walkFiles(root);
    expect(files).toEqual([join(root, 'real.md')]);
  });

  it('walkFiles skips .DS_Store / ._* / decisions-sidecar / .vault-backup-* files', async () => {
    const root = mkTmp('walk-skip-files');
    writeFileSync(join(root, '.DS_Store'), 'meta\n');
    writeFileSync(join(root, '._resourcefork'), 'apple\n');
    writeFileSync(join(root, DECISIONS_SIDECAR_REL), '{}\n');
    writeFileSync(join(root, '.vault-backup-999.tar.gz'), 'archive\n');
    writeFileSync(join(root, 'keep.md'), 'keep\n');

    const files = await walkFiles(root);
    expect(files).toEqual([join(root, 'keep.md')]);
  });

  it('walkFiles does not dereference a symlinked file (skips it, leaving only real files)', async () => {
    const parent = mkTmp('walk-symlink-file');
    const root = join(parent, 'vault');
    mkdirSync(root, { recursive: true });
    // out-of-tree target the symlink points at
    writeFileSync(join(parent, 'secret.txt'), 'SECRET\n');
    symlinkSync(join(parent, 'secret.txt'), join(root, 'evil.md'));
    writeFileSync(join(root, 'real.md'), 'real\n');

    const files = await walkFiles(root);
    // Only the genuine file — the symlink is skipped, not followed.
    expect(files).toEqual([join(root, 'real.md')]);
  });

  it('walkFiles does not recurse into a symlinked directory', async () => {
    const parent = mkTmp('walk-symlink-dir');
    const root = join(parent, 'vault');
    mkdirSync(root, { recursive: true });
    const outside = join(parent, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'sentinel.md'), 'should-not-be-seen\n');
    symlinkSync(outside, join(root, 'linkdir'));
    writeFileSync(join(root, 'real.md'), 'real\n');

    const files = await walkFiles(root);
    expect(files).toEqual([join(root, 'real.md')]);
  });

  // -------------------------------------------------------------------------
  // classifyFile — the full classification matrix (canonicalRoot is a param)
  // -------------------------------------------------------------------------

  it('classifyFile → copy when the path is absent in canonical', async () => {
    const parent = mkTmp('classify-copy');
    const src = join(parent, 'src');
    const canon = join(parent, 'canon');
    mkdirSync(src, { recursive: true });
    mkdirSync(canon, { recursive: true });
    writeFileSync(join(src, 'only.md'), 'only-in-source\n');

    const rec = await classifyFile(join(src, 'only.md'), 'only.md', canon);
    expect(rec.kind).toBe('action');
    expect(rec.action).toBe('copy');
    expect(rec.rel).toBe('only.md');
    expect(rec.canonical).toBe(join(canon, 'only.md'));
  });

  it('classifyFile → skip-already-present when both sides are byte-identical', async () => {
    const parent = mkTmp('classify-skip');
    const src = join(parent, 'src');
    const canon = join(parent, 'canon');
    mkdirSync(src, { recursive: true });
    mkdirSync(canon, { recursive: true });
    const same = 'identical\n';
    writeFileSync(join(src, 'dup.md'), same);
    writeFileSync(join(canon, 'dup.md'), same);

    const rec = await classifyFile(join(src, 'dup.md'), 'dup.md', canon);
    expect(rec.action).toBe('skip-already-present');
    expect(rec.src_sha).toBe(rec.dst_sha);
  });

  it('classifyFile → merge for two different UTF-8 files, with src-is-superset hint', async () => {
    const parent = mkTmp('classify-merge');
    const src = join(parent, 'src');
    const canon = join(parent, 'canon');
    mkdirSync(src, { recursive: true });
    mkdirSync(canon, { recursive: true });
    // source is a strict superset of canonical → src-is-superset
    writeFileSync(join(src, 'note.md'), 'base line\nextra source line\n');
    writeFileSync(join(canon, 'note.md'), 'base line\n');

    const rec = await classifyFile(join(src, 'note.md'), 'note.md', canon);
    expect(rec.action).toBe('merge');
    expect(rec.subset_hint).toBe('src-is-superset');
  });

  it('classifyFile → merge with dst-is-superset hint when canonical extends source', async () => {
    const parent = mkTmp('classify-merge-dst');
    const src = join(parent, 'src');
    const canon = join(parent, 'canon');
    mkdirSync(src, { recursive: true });
    mkdirSync(canon, { recursive: true });
    writeFileSync(join(src, 'note.md'), 'base line\n');
    writeFileSync(join(canon, 'note.md'), 'base line\nextra canonical line\n');

    const rec = await classifyFile(join(src, 'note.md'), 'note.md', canon);
    expect(rec.action).toBe('merge');
    expect(rec.subset_hint).toBe('dst-is-superset');
  });

  it('classifyFile → merge with null hint when neither side is a prefix of the other', async () => {
    const parent = mkTmp('classify-merge-nohint');
    const src = join(parent, 'src');
    const canon = join(parent, 'canon');
    mkdirSync(src, { recursive: true });
    mkdirSync(canon, { recursive: true });
    writeFileSync(join(src, 'note.md'), 'alpha content\n');
    writeFileSync(join(canon, 'note.md'), 'beta content\n');

    const rec = await classifyFile(join(src, 'note.md'), 'note.md', canon);
    expect(rec.action).toBe('merge');
    expect(rec.subset_hint).toBeNull();
  });

  it('classifyFile → conflict-needs-review when both sides are non-UTF-8 binary (#508)', async () => {
    const parent = mkTmp('classify-binary');
    const src = join(parent, 'src');
    const canon = join(parent, 'canon');
    mkdirSync(src, { recursive: true });
    mkdirSync(canon, { recursive: true });
    writeFileSync(join(src, 'b.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    writeFileSync(join(canon, 'b.bin'), Buffer.from([0xfe, 0xff, 0x02, 0x03]));

    const rec = await classifyFile(join(src, 'b.bin'), 'b.bin', canon);
    expect(rec.action).toBe('conflict-needs-review');
  });

  it('classifyFile → error when the source file cannot be stat-ed', async () => {
    const parent = mkTmp('classify-stat-err');
    const canon = join(parent, 'canon');
    mkdirSync(canon, { recursive: true });

    const rec = await classifyFile(join(parent, 'ghost.md'), 'ghost.md', canon);
    expect(rec.action).toBe('error');
    expect(rec.error).toContain('stat source failed');
  });

  // -------------------------------------------------------------------------
  // stageBackup — the lstat symlink-skip, NOW directly testable (the headline
  // #514 win: this guard was SHADOWED by the walk-level guard in the CLI flow).
  // -------------------------------------------------------------------------

  it('stageBackup copies a regular file into the backup root, preserving its rel path', async () => {
    const parent = mkTmp('stage-regular');
    const src = join(parent, 'src');
    const backup = join(parent, 'backup');
    mkdirSync(src, { recursive: true });
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(src, 'a.md'), 'staged-content\n');

    const result = await stageBackup(backup, join(src, 'a.md'), 'a.md');
    expect(result).toEqual({ staged: true });
    const staged = await fsp.readFile(join(backup, 'a.md'), 'utf8');
    expect(staged).toBe('staged-content\n');
  });

  it('stageBackup creates intermediate directories for nested rel paths', async () => {
    const parent = mkTmp('stage-nested');
    const src = join(parent, 'src');
    const backup = join(parent, 'backup');
    mkdirSync(join(src, '50-sessions'), { recursive: true });
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(src, '50-sessions', 's.md'), 'nested\n');

    const result = await stageBackup(backup, join(src, '50-sessions', 's.md'), '50-sessions/s.md');
    expect(result.staged).toBe(true);
    const staged = await fsp.readFile(join(backup, '50-sessions', 's.md'), 'utf8');
    expect(staged).toBe('nested\n');
  });

  it('stageBackup REFUSES to dereference a symlink — returns {staged:false}, copies nothing', async () => {
    // This is the #514 headline case the extraction makes testable: in the CLI
    // flow the walk-level guard skips symlinks first, so stageBackup never sees
    // one and the lstat guard was unobservable. Here we call stageBackup with a
    // symlink directly and assert it refuses to follow it.
    const parent = mkTmp('stage-symlink');
    const src = join(parent, 'src');
    const backup = join(parent, 'backup');
    mkdirSync(src, { recursive: true });
    mkdirSync(backup, { recursive: true });
    // out-of-tree secret the symlink points to
    writeFileSync(join(parent, 'secret.txt'), 'TOP-SECRET\n');
    symlinkSync(join(parent, 'secret.txt'), join(src, 'evil.md'));

    const result = await stageBackup(backup, join(src, 'evil.md'), 'evil.md');
    // The symlink was NOT staged.
    expect(result).toEqual({ staged: false });
    // The secret target's content was NEVER written into the backup.
    await expect(fsp.readFile(join(backup, 'evil.md'))).rejects.toThrow();
  });

  it('stageBackup rejects when the source path does not exist (lstat throws)', async () => {
    const parent = mkTmp('stage-missing');
    const backup = join(parent, 'backup');
    mkdirSync(backup, { recursive: true });
    await expect(
      stageBackup(backup, join(parent, 'ghost.md'), 'ghost.md'),
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // compressAndCleanupBackup — tar success removes the staging dir
  // -------------------------------------------------------------------------

  it('compressAndCleanupBackup tars the staging dir then removes it on success', async () => {
    const parent = mkTmp('compress-ok');
    const backupRoot = join(parent, '.vault-backup-stamp');
    mkdirSync(backupRoot, { recursive: true });
    writeFileSync(join(backupRoot, 'note.md'), 'archived\n');

    const result = await compressAndCleanupBackup(backupRoot);
    expect(result.removed).toBe(true);
    expect(result.archive).toBe(`${backupRoot}.tar.gz`);
    // The .tar.gz exists and the staging dir is gone.
    await expect(fsp.stat(`${backupRoot}.tar.gz`)).resolves.toBeDefined();
    await expect(fsp.stat(backupRoot)).rejects.toThrow();
  });
});
