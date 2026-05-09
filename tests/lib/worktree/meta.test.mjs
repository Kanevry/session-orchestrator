/**
 * tests/lib/worktree/meta.test.mjs
 *
 * Unit tests for scripts/lib/worktree/meta.mjs.
 * Covers metaPathFor pure path computation and _writeWorktreeMeta atomicity.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

// zx side-effect mock — constants.mjs sets $.verbose/$.quiet at import time.
vi.mock('zx', () => ({
  $: Object.assign(
    vi.fn().mockImplementation(() => Promise.resolve({ stdout: '' })),
    { verbose: false, quiet: true }
  ),
}));

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'worktree-meta-test-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// metaPathFor
// ---------------------------------------------------------------------------

describe('metaPathFor', () => {
  it('returns an absolute path ending with <suffix>.json', async () => {
    const { metaPathFor } = await import('../../../scripts/lib/worktree/meta.mjs');
    const result = metaPathFor('my-suffix');
    expect(result.endsWith('my-suffix.json')).toBe(true);
    // Must be absolute.
    expect(result.startsWith('/')).toBe(true);
  });

  it('constructs path under WORKTREE_META_DIR relative to process.cwd()', async () => {
    const { metaPathFor } = await import('../../../scripts/lib/worktree/meta.mjs');
    const { WORKTREE_META_DIR } = await import('../../../scripts/lib/worktree/constants.mjs');
    const cwd = process.cwd();
    const result = metaPathFor('wave1');
    // Expected: <cwd>/<WORKTREE_META_DIR>/wave1.json
    expect(result).toBe(join(cwd, WORKTREE_META_DIR, 'wave1.json'));
  });

  it('embeds the suffix as the filename stem', async () => {
    const { metaPathFor } = await import('../../../scripts/lib/worktree/meta.mjs');
    const result = metaPathFor('agent-5');
    expect(basename(result)).toBe('agent-5.json');
  });
});

// ---------------------------------------------------------------------------
// _writeWorktreeMeta (atomic write)
// ---------------------------------------------------------------------------

describe('_writeWorktreeMeta', () => {
  it('writes a JSON file with all required fields', async () => {
    const { _writeWorktreeMeta } = await import('../../../scripts/lib/worktree/meta.mjs');
    const suffix = 'write-test';
    const info = {
      branch: `so-worktree-${suffix}`,
      wtPath: join(sandbox, 'wt'),
      baseRef: 'HEAD',
      baseSha: 'abc1234'.padEnd(40, '0'),
      repoRoot: sandbox,
    };

    await _writeWorktreeMeta(suffix, info);

    const { WORKTREE_META_DIR } = await import('../../../scripts/lib/worktree/constants.mjs');
    const metaPath = join(sandbox, WORKTREE_META_DIR, `${suffix}.json`);
    expect(existsSync(metaPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(metaPath, 'utf8'));
    expect(parsed.suffix).toBe(suffix);
    expect(parsed.branch).toBe(info.branch);
    expect(parsed.wtPath).toBe(info.wtPath);
    expect(parsed.baseRef).toBe(info.baseRef);
    expect(parsed.baseSha).toBe(info.baseSha);
    expect(typeof parsed.createdAt).toBe('string');
  });

  it('creates the meta directory if it does not exist', async () => {
    const { _writeWorktreeMeta } = await import('../../../scripts/lib/worktree/meta.mjs');
    const { WORKTREE_META_DIR } = await import('../../../scripts/lib/worktree/constants.mjs');
    const suffix = 'dir-create';
    const metaDir = join(sandbox, WORKTREE_META_DIR);

    // Confirm dir does not exist yet.
    expect(existsSync(metaDir)).toBe(false);

    await _writeWorktreeMeta(suffix, {
      branch: `so-worktree-${suffix}`,
      wtPath: '/tmp/wt',
      baseRef: 'HEAD',
      baseSha: null,
      repoRoot: sandbox,
    });

    expect(existsSync(metaDir)).toBe(true);
  });

  it('write is atomic — no .tmp file left on disk after success', async () => {
    const { _writeWorktreeMeta } = await import('../../../scripts/lib/worktree/meta.mjs');
    const { WORKTREE_META_DIR } = await import('../../../scripts/lib/worktree/constants.mjs');
    const suffix = 'atomic-test';

    await _writeWorktreeMeta(suffix, {
      branch: `so-worktree-${suffix}`,
      wtPath: '/tmp/wt',
      baseRef: 'HEAD',
      baseSha: null,
      repoRoot: sandbox,
    });

    const metaDir = join(sandbox, WORKTREE_META_DIR);
    const tmpFile = join(metaDir, `${suffix}.json.tmp`);
    expect(existsSync(tmpFile)).toBe(false);
  });

  it('sets baseSha to null when null is provided', async () => {
    const { _writeWorktreeMeta } = await import('../../../scripts/lib/worktree/meta.mjs');
    const { WORKTREE_META_DIR } = await import('../../../scripts/lib/worktree/constants.mjs');
    const suffix = 'null-sha';

    await _writeWorktreeMeta(suffix, {
      branch: `so-worktree-${suffix}`,
      wtPath: '/tmp/wt',
      baseRef: 'feature/x',
      baseSha: null,
      repoRoot: sandbox,
    });

    const metaPath = join(sandbox, WORKTREE_META_DIR, `${suffix}.json`);
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8'));
    expect(parsed.baseSha).toBeNull();
  });

  it('overwrites an existing meta file without error', async () => {
    const { _writeWorktreeMeta } = await import('../../../scripts/lib/worktree/meta.mjs');
    const { WORKTREE_META_DIR } = await import('../../../scripts/lib/worktree/constants.mjs');
    const suffix = 'overwrite';

    const base = {
      branch: `so-worktree-${suffix}`,
      wtPath: '/tmp/wt',
      baseRef: 'HEAD',
      baseSha: null,
      repoRoot: sandbox,
    };

    await _writeWorktreeMeta(suffix, base);
    await _writeWorktreeMeta(suffix, { ...base, baseSha: 'deadbeef'.padEnd(40, '0') });

    const metaPath = join(sandbox, WORKTREE_META_DIR, `${suffix}.json`);
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8'));
    expect(parsed.baseSha).toBe('deadbeef'.padEnd(40, '0'));
  });

  it('throws when repoRoot is a file (mkdir fails)', async () => {
    const { _writeWorktreeMeta } = await import('../../../scripts/lib/worktree/meta.mjs');
    // Point repoRoot to a path that cannot contain subdirectories (a file)
    const { writeFileSync } = await import('node:fs');
    const blockingFile = join(sandbox, 'blocking');
    writeFileSync(blockingFile, 'I am a file');

    // Attempting to mkdir inside a file as if it were a directory must throw.
    await expect(
      _writeWorktreeMeta('fail-test', {
        branch: 'so-worktree-fail-test',
        wtPath: '/tmp/wt',
        baseRef: 'HEAD',
        baseSha: null,
        // Make repoRoot the blocking file — its child path will fail fs.mkdir
        repoRoot: blockingFile,
      })
    ).rejects.toThrow();
  });
});
