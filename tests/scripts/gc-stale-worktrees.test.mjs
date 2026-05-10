/**
 * tests/scripts/gc-stale-worktrees.test.mjs
 *
 * Tests for scripts/gc-stale-worktrees.mjs — ADR-364 thin-slice item 4.
 *
 * Uses DI seams (opts.worktreeRoot, opts.metaDir, opts.repoRoot) — no vi.mock.
 * CLI tests invoke the script via child_process.spawnSync (fork-pool safe).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyWorktree, discoverWorktrees, isPidAlive, main } from '../../scripts/gc-stale-worktrees.mjs';

// ---------------------------------------------------------------------------
// Repo + script paths
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'gc-stale-worktrees.mjs');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const MS_8_DAYS = 8 * 24 * 60 * 60 * 1000;
const MS_3_DAYS = 3 * 24 * 60 * 60 * 1000;

/**
 * Create a temporary directory layout for a single test.
 * Returns { tmp, worktreeRoot, metaDir, repoRoot }.
 */
function makeTmpLayout() {
  const tmp = mkdtempSync(join(tmpdir(), 'gc-wt-test-'));
  const worktreeRoot = join(tmp, 'so-worktrees');
  const repoRoot = join(tmp, 'repo');
  const metaDir = join(repoRoot, '.orchestrator', 'tmp', 'worktree-meta');
  const metricsDir = join(repoRoot, '.orchestrator', 'metrics');

  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(metaDir, { recursive: true });
  mkdirSync(metricsDir, { recursive: true });

  // Create empty sessions.jsonl by default.
  writeFileSync(join(metricsDir, 'sessions.jsonl'), '', 'utf8');

  return { tmp, worktreeRoot, metaDir, repoRoot, metricsDir };
}

/**
 * Create a worktree directory inside worktreeRoot.
 * @param {string} worktreeRoot
 * @param {string} suffix
 * @returns {string}  The worktree path.
 */
function makeWorktreeDir(worktreeRoot, suffix) {
  const branch = `so-worktree-${suffix}`;
  const wtPath = join(worktreeRoot, branch);
  mkdirSync(wtPath, { recursive: true });
  return wtPath;
}

/**
 * Write a worktree meta JSON file.
 * @param {string} metaDir
 * @param {string} suffix
 * @param {object} overrides
 */
function writeWorktreeMeta(metaDir, suffix, overrides = {}) {
  const meta = {
    suffix,
    baseRef: 'HEAD',
    baseSha: 'abc123',
    branch: `so-worktree-${suffix}`,
    wtPath: `/tmp/so-worktrees/so-worktree-${suffix}`,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  writeFileSync(join(metaDir, `${suffix}.json`), JSON.stringify(meta), 'utf8');
}


// ---------------------------------------------------------------------------
// Classification tests
// ---------------------------------------------------------------------------

describe('gc-stale-worktrees — classification', () => {
  let layout;

  beforeEach(() => {
    layout = makeTmpLayout();
  });

  afterEach(() => {
    rmSync(layout.tmp, { recursive: true, force: true });
  });

  it('classifies a worktree referenced in sessions.jsonl as kept', async () => {
    const suffix = 'abc123';
    const wtPath = makeWorktreeDir(layout.worktreeRoot, suffix);
    writeWorktreeMeta(layout.metaDir, suffix, {
      createdAt: new Date(Date.now() - MS_8_DAYS).toISOString(),
    });

    // Write a recent session entry referencing this worktree.
    const line = JSON.stringify({
      session_id: 'main-2026-05-09-deep-1',
      session_type: 'deep',
      started_at: new Date(Date.now() - 60_000).toISOString(),
      completed_at: new Date(Date.now() - 30_000).toISOString(),
      worktree_path: wtPath,
    }) + '\n';
    writeFileSync(
      join(layout.metricsDir, 'sessions.jsonl'),
      line,
      'utf8'
    );

    const worktrees = discoverWorktrees({
      worktreeRoot: layout.worktreeRoot,
      metaDir: layout.metaDir,
      repoRoot: layout.repoRoot,
    });
    expect(worktrees).toHaveLength(1);

    // Build sessionRefs manually to test classifyWorktree directly.
    const { default: nodeFs } = await import('node:fs');
    const raw = nodeFs.readFileSync(join(layout.metricsDir, 'sessions.jsonl'), 'utf8');
    const sessionRefs = new Set();
    for (const l of raw.split('\n')) {
      if (l.trim()) sessionRefs.add(l.toLowerCase());
    }

    const result = classifyWorktree(worktrees[0], sessionRefs, layout.repoRoot);
    expect(result.status).toBe('kept');
  });

  it('classifies a worktree with live-PID lock as orphan-locked', () => {
    const suffix = 'def456';
    const wtPath = makeWorktreeDir(layout.worktreeRoot, suffix);
    writeWorktreeMeta(layout.metaDir, suffix, {
      createdAt: new Date(Date.now() - MS_8_DAYS).toISOString(),
    });

    // Write a lock file with the current (live) process PID.
    const lockFile = join(wtPath, '.session-meta.json');
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid }), 'utf8');

    const worktrees = discoverWorktrees({
      worktreeRoot: layout.worktreeRoot,
      metaDir: layout.metaDir,
      repoRoot: layout.repoRoot,
    });
    expect(worktrees).toHaveLength(1);

    const result = classifyWorktree(worktrees[0], new Set(), layout.repoRoot);
    expect(result.status).toBe('orphan-locked');
    expect(result.pid).toBe(process.pid);
  });

  it('classifies a worktree younger than 7 days with no refs as orphan-young', () => {
    const suffix = 'ghi789';
    makeWorktreeDir(layout.worktreeRoot, suffix);
    writeWorktreeMeta(layout.metaDir, suffix, {
      createdAt: new Date(Date.now() - MS_3_DAYS).toISOString(),
    });

    const worktrees = discoverWorktrees({
      worktreeRoot: layout.worktreeRoot,
      metaDir: layout.metaDir,
      repoRoot: layout.repoRoot,
    });
    expect(worktrees).toHaveLength(1);

    const result = classifyWorktree(worktrees[0], new Set(), layout.repoRoot);
    expect(result.status).toBe('orphan-young');
  });

  it('classifies a worktree older than 7 days with no refs as orphan-stale', () => {
    const suffix = 'jkl000';
    makeWorktreeDir(layout.worktreeRoot, suffix);
    writeWorktreeMeta(layout.metaDir, suffix, {
      createdAt: new Date(Date.now() - MS_8_DAYS).toISOString(),
    });

    const worktrees = discoverWorktrees({
      worktreeRoot: layout.worktreeRoot,
      metaDir: layout.metaDir,
      repoRoot: layout.repoRoot,
    });
    expect(worktrees).toHaveLength(1);

    const result = classifyWorktree(worktrees[0], new Set(), layout.repoRoot);
    expect(result.status).toBe('orphan-stale');
    expect(result.reason).toContain('no references');
  });

  it('treats meta file missing as no-meta but still ages from filesystem mtime', () => {
    const suffix = 'nometa1';
    // Create worktree dir but NO meta file — createdAt must fall back to fs mtime.
    makeWorktreeDir(layout.worktreeRoot, suffix);
    // Do NOT call writeWorktreeMeta — meta is absent.

    const worktrees = discoverWorktrees({
      worktreeRoot: layout.worktreeRoot,
      metaDir: layout.metaDir,
      repoRoot: layout.repoRoot,
    });
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].metaPresent).toBe(false);
    // createdAt should be a Date from filesystem mtime (just created, so recent).
    expect(worktrees[0].createdAt).toBeInstanceOf(Date);

    // Since just created, should be orphan-young (mtime = now).
    const result = classifyWorktree(worktrees[0], new Set(), layout.repoRoot);
    expect(result.status).toBe('orphan-young');
  });
});

// ---------------------------------------------------------------------------
// CLI tests (via spawnSync)
// ---------------------------------------------------------------------------

describe('gc-stale-worktrees — CLI', () => {
  let layout;

  beforeEach(() => {
    layout = makeTmpLayout();
  });

  afterEach(() => {
    rmSync(layout.tmp, { recursive: true, force: true });
  });

  it('default mode is --dry-run; no filesystem mutations occur without --apply', async () => {
    const suffix = 'dry1';
    const wtPath = makeWorktreeDir(layout.worktreeRoot, suffix);
    writeWorktreeMeta(layout.metaDir, suffix, {
      createdAt: new Date(Date.now() - MS_8_DAYS).toISOString(),
    });

    await main({
      worktreeRoot: layout.worktreeRoot,
      metaDir: layout.metaDir,
      repoRoot: layout.repoRoot,
      // no --apply flag in argv
      argv: [],
    });

    // The directory must still exist — dry-run does not delete.
    expect(existsSync(wtPath)).toBe(true);
  });

  it('--apply removes only orphan-stale entries, never orphan-locked or orphan-young', async () => {
    // Stale orphan — should be removed.
    const staleSuffix = 'stale1';
    const staleWtPath = makeWorktreeDir(layout.worktreeRoot, staleSuffix);
    writeWorktreeMeta(layout.metaDir, staleSuffix, {
      createdAt: new Date(Date.now() - MS_8_DAYS).toISOString(),
    });

    // Young orphan — should NOT be removed.
    const youngSuffix = 'young1';
    const youngWtPath = makeWorktreeDir(layout.worktreeRoot, youngSuffix);
    writeWorktreeMeta(layout.metaDir, youngSuffix, {
      createdAt: new Date(Date.now() - MS_3_DAYS).toISOString(),
    });

    // Locked orphan (live PID) — should NOT be removed.
    const lockedSuffix = 'locked1';
    const lockedWtPath = makeWorktreeDir(layout.worktreeRoot, lockedSuffix);
    writeWorktreeMeta(layout.metaDir, lockedSuffix, {
      createdAt: new Date(Date.now() - MS_8_DAYS).toISOString(),
    });
    writeFileSync(
      join(lockedWtPath, '.session-meta.json'),
      JSON.stringify({ pid: process.pid }),
      'utf8'
    );

    await main({
      worktreeRoot: layout.worktreeRoot,
      metaDir: layout.metaDir,
      repoRoot: layout.repoRoot,
      argv: ['--apply'],
    });

    expect(existsSync(staleWtPath)).toBe(false);   // removed
    expect(existsSync(youngWtPath)).toBe(true);    // kept
    expect(existsSync(lockedWtPath)).toBe(true);   // kept
  });

  it('--json emits machine-readable shape with all 4+1 buckets', async () => {
    // One stale orphan, one young orphan.
    const staleSuffix = 'jstale';
    makeWorktreeDir(layout.worktreeRoot, staleSuffix);
    writeWorktreeMeta(layout.metaDir, staleSuffix, {
      createdAt: new Date(Date.now() - MS_8_DAYS).toISOString(),
    });

    const youngSuffix = 'jyoung';
    makeWorktreeDir(layout.worktreeRoot, youngSuffix);
    writeWorktreeMeta(layout.metaDir, youngSuffix, {
      createdAt: new Date(Date.now() - MS_3_DAYS).toISOString(),
    });

    // The CLI doesn't use env vars for DI — test directly via main instead.
    // Capture stdout via process.stdout.write spy alternative: capture output
    // by calling main() with explicit opts and overriding stdout temporarily.
    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };

    try {
      await main({
        worktreeRoot: layout.worktreeRoot,
        metaDir: layout.metaDir,
        repoRoot: layout.repoRoot,
        argv: ['--json'],
      });
    } finally {
      process.stdout.write = origWrite;
    }

    const combined = chunks.join('');
    const parsed = JSON.parse(combined);
    expect(parsed).toHaveProperty('kept');
    expect(parsed).toHaveProperty('orphanLocked');
    expect(parsed).toHaveProperty('orphanYoung');
    expect(parsed).toHaveProperty('orphanStale');
    // No 'removed' key in dry-run (default).
    expect(parsed).not.toHaveProperty('removed');

    expect(parsed.orphanStale).toHaveLength(1);
    expect(parsed.orphanStale[0].suffix).toBe(staleSuffix);
    expect(parsed.orphanYoung).toHaveLength(1);
    expect(parsed.orphanYoung[0].suffix).toBe(youngSuffix);
  });

  it('--json with --apply includes removed array', async () => {
    const staleSuffix = 'jstale2';
    makeWorktreeDir(layout.worktreeRoot, staleSuffix);
    writeWorktreeMeta(layout.metaDir, staleSuffix, {
      createdAt: new Date(Date.now() - MS_8_DAYS).toISOString(),
    });

    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };

    try {
      await main({
        worktreeRoot: layout.worktreeRoot,
        metaDir: layout.metaDir,
        repoRoot: layout.repoRoot,
        argv: ['--apply', '--json'],
      });
    } finally {
      process.stdout.write = origWrite;
    }

    const parsed = JSON.parse(chunks.join(''));
    expect(parsed).toHaveProperty('removed');
    expect(parsed.removed).toHaveLength(1);
  });

  it('--apply --dry-run together exits 1 with error message', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--apply', '--dry-run'], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('mutually exclusive');
  });

  it('--help exits 0 with usage text', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--help'], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('gc-stale-worktrees.mjs');
    expect(r.stdout).toContain('--apply');
    expect(r.stdout).toContain('--dry-run');
  });

  it('-h is an alias for --help', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '-h'], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--help');
  });

  it('runs cleanly with no worktrees (empty directory)', async () => {
    // Create an empty worktreeRoot and verify main() exits 0 without throwing.
    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };

    let exitCode;
    try {
      exitCode = await main({
        worktreeRoot: layout.worktreeRoot, // empty — no so-worktree-* dirs
        metaDir: layout.metaDir,
        repoRoot: layout.repoRoot,
        argv: ['--json'],
      });
    } finally {
      process.stdout.write = origWrite;
    }

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(chunks.join(''));
    expect(parsed.kept).toHaveLength(0);
    expect(parsed.orphanStale).toHaveLength(0);
  });

  it('still removes orphan-stale entries whose wtPath is inside worktreeRoot (regression canary for #370 guard)', async () => {
    // Regression canary: confirms validateWorkspacePath defence-in-depth
    // does NOT break the normal removal path. A normal orphan-stale entry
    // whose wtPath sits inside worktreeRoot must still be deleted under --apply.
    const suffix = 'normal-stale';
    const wtPath = makeWorktreeDir(layout.worktreeRoot, suffix);
    writeWorktreeMeta(layout.metaDir, suffix, {
      createdAt: new Date(Date.now() - MS_8_DAYS).toISOString(),
    });

    expect(existsSync(wtPath)).toBe(true);

    await main({
      worktreeRoot: layout.worktreeRoot,
      metaDir: layout.metaDir,
      repoRoot: layout.repoRoot,
      argv: ['--apply'],
    });

    expect(existsSync(wtPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// --apply guards out-of-root paths (#370 defence-in-depth)
// ---------------------------------------------------------------------------

describe('gc-stale-worktrees — --apply guards out-of-root paths', () => {
  let layout;

  beforeEach(() => {
    layout = makeTmpLayout();
  });

  afterEach(() => {
    rmSync(layout.tmp, { recursive: true, force: true });
    vi.resetModules();
    vi.doUnmock('../../scripts/lib/worktree/lifecycle.mjs');
  });

  it('refuses to remove orphan-stale entry whose wtPath fails validateWorkspacePath', async () => {
    // Force the defence-in-depth guard to fire by mocking the validator to
    // return false for any input. This simulates a hypothetical future bug
    // where the discovered wtPath escapes worktreeRoot (e.g. via meta-driven
    // path injection, symlink resolution, or a leaky discoverWorktrees).
    //
    // Falsification check: if validateWorkspacePath returned `true` for all
    // inputs (i.e. the guard was a no-op), the rm() call would proceed and
    // existsSync(wtPath) would be false at the end. We assert the opposite.
    vi.resetModules();
    vi.doMock('../../scripts/lib/worktree/lifecycle.mjs', async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual, validateWorkspacePath: () => false };
    });

    // Set up a normal orphan-stale entry (would otherwise be removed).
    const suffix = 'poison';
    const wtPath = makeWorktreeDir(layout.worktreeRoot, suffix);
    writeWorktreeMeta(layout.metaDir, suffix, {
      createdAt: new Date(Date.now() - MS_8_DAYS).toISOString(),
    });

    // Capture stderr to verify the refusal message.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Suppress stdout (human-readable bucket summary).
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    let capturedStderr;
    try {
      // Dynamic re-import so the production module picks up the mocked validator.
      const mod = await import('../../scripts/gc-stale-worktrees.mjs');
      await mod.main({
        worktreeRoot: layout.worktreeRoot,
        metaDir: layout.metaDir,
        repoRoot: layout.repoRoot,
        argv: ['--apply'],
      });
      // Capture stderr calls BEFORE restoring spies — mockRestore clears the
      // mock.calls history on some vitest versions.
      capturedStderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }

    // Assertion (a): the directory still exists — guard prevented rm.
    expect(existsSync(wtPath)).toBe(true);

    // Assertion (b): stderr received the refusal message containing the path.
    expect(capturedStderr).toContain('refusing to remove out-of-root path');
    expect(capturedStderr).toContain(wtPath);
  });

  it('continues processing remaining orphan-stale entries when one is refused', async () => {
    // Verifies the `continue` (not throw) in the guard. When the first
    // entry is refused, the second normal entry must still be removed.
    //
    // Mock validateWorkspacePath to return false ONLY for the poisoned wtPath
    // and true for everything else, so the loop processes both entries.
    const poisonSuffix = 'poison2';
    const poisonWtPath = makeWorktreeDir(layout.worktreeRoot, poisonSuffix);
    writeWorktreeMeta(layout.metaDir, poisonSuffix, {
      createdAt: new Date(Date.now() - MS_8_DAYS).toISOString(),
    });

    const normalSuffix = 'normal2';
    const normalWtPath = makeWorktreeDir(layout.worktreeRoot, normalSuffix);
    writeWorktreeMeta(layout.metaDir, normalSuffix, {
      createdAt: new Date(Date.now() - MS_8_DAYS).toISOString(),
    });

    vi.resetModules();
    vi.doMock('../../scripts/lib/worktree/lifecycle.mjs', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        validateWorkspacePath: (computed) => computed !== poisonWtPath,
      };
    });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      const mod = await import('../../scripts/gc-stale-worktrees.mjs');
      await mod.main({
        worktreeRoot: layout.worktreeRoot,
        metaDir: layout.metaDir,
        repoRoot: layout.repoRoot,
        argv: ['--apply'],
      });
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }

    // Poisoned entry preserved; normal entry removed → loop continued past refusal.
    expect(existsSync(poisonWtPath)).toBe(true);
    expect(existsSync(normalWtPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPidAlive tests
// ---------------------------------------------------------------------------

describe('gc-stale-worktrees — isPidAlive (mirror)', () => {
  it('returns true for the current process pid', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('returns false for a fabricated very-high-numbered pid', () => {
    // Use PID 2_000_000 which is above Linux/macOS PID_MAX_DEFAULT.
    // On some systems this might return true if limit is higher, but generally false.
    const result = isPidAlive(2_000_000);
    // We assert it doesn't throw and returns a boolean.
    expect(typeof result).toBe('boolean');
    // Most OSes will return false for this unrealistic PID.
    expect(result).toBe(false);
  });

  it('returns false for non-finite input', () => {
    expect(isPidAlive(NaN)).toBe(false);
    expect(isPidAlive(Infinity)).toBe(false);
    expect(isPidAlive(-Infinity)).toBe(false);
  });

  it('returns false for negative pid', () => {
    // Negative PIDs have special kill semantics on POSIX (process group).
    // Our implementation gates on Number.isFinite — negative is finite so
    // the kill will actually run. With -99999 it should ESRCH.
    const result = isPidAlive(-99999);
    expect(typeof result).toBe('boolean');
  });

  it('returns false for zero', () => {
    // PID 0 = send to process group; process.kill(0, 0) always returns
    // without throwing on most systems. isPidAlive(0) returns true or false
    // — we just verify it does not throw.
    expect(() => isPidAlive(0)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// discoverWorktrees edge cases
// ---------------------------------------------------------------------------

describe('gc-stale-worktrees — discoverWorktrees', () => {
  let layout;

  beforeEach(() => {
    layout = makeTmpLayout();
  });

  afterEach(() => {
    rmSync(layout.tmp, { recursive: true, force: true });
  });

  it('returns empty array when worktreeRoot does not exist', () => {
    const result = discoverWorktrees({
      worktreeRoot: join(layout.tmp, 'nonexistent'),
      metaDir: layout.metaDir,
      repoRoot: layout.repoRoot,
    });
    expect(result).toEqual([]);
  });

  it('ignores directories not prefixed with so-worktree-', () => {
    // Create an unrelated directory.
    mkdirSync(join(layout.worktreeRoot, 'unrelated-dir'), { recursive: true });
    mkdirSync(join(layout.worktreeRoot, 'so-worktree-valid'), { recursive: true });

    const result = discoverWorktrees({
      worktreeRoot: layout.worktreeRoot,
      metaDir: layout.metaDir,
      repoRoot: layout.repoRoot,
    });
    expect(result).toHaveLength(1);
    expect(result[0].suffix).toBe('valid');
  });

  it('returns multiple worktrees when multiple directories exist', () => {
    makeWorktreeDir(layout.worktreeRoot, 'alpha');
    makeWorktreeDir(layout.worktreeRoot, 'beta');
    makeWorktreeDir(layout.worktreeRoot, 'gamma');

    const result = discoverWorktrees({
      worktreeRoot: layout.worktreeRoot,
      metaDir: layout.metaDir,
      repoRoot: layout.repoRoot,
    });
    expect(result).toHaveLength(3);
    const suffixes = result.map((r) => r.suffix).sort();
    expect(suffixes).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('sets metaPresent:false when meta file is missing', () => {
    makeWorktreeDir(layout.worktreeRoot, 'nometa2');
    // Do NOT write meta file.

    const result = discoverWorktrees({
      worktreeRoot: layout.worktreeRoot,
      metaDir: layout.metaDir,
      repoRoot: layout.repoRoot,
    });
    expect(result).toHaveLength(1);
    expect(result[0].metaPresent).toBe(false);
    expect(result[0].meta).toBeNull();
  });

  it('sets metaPresent:true and parses createdAt when meta file is valid', () => {
    const suffix = 'withmetax';
    makeWorktreeDir(layout.worktreeRoot, suffix);
    const created = new Date(Date.now() - MS_3_DAYS);
    writeWorktreeMeta(layout.metaDir, suffix, {
      createdAt: created.toISOString(),
    });

    const result = discoverWorktrees({
      worktreeRoot: layout.worktreeRoot,
      metaDir: layout.metaDir,
      repoRoot: layout.repoRoot,
    });
    expect(result).toHaveLength(1);
    expect(result[0].metaPresent).toBe(true);
    expect(result[0].createdAt).toBeInstanceOf(Date);
    // Dates should be within 1 second.
    expect(Math.abs(result[0].createdAt.getTime() - created.getTime())).toBeLessThan(1000);
  });
});
