/**
 * Unit tests for scripts/lib/vault-mirror/auto-commit.mjs
 * Focus: isMirrorArtifact (via autoCommitVaultMirror), action emission logic
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';

const GENERATOR_MARKER = 'session-orchestrator-vault-mirror@1';
const VAULT = '/fake/vault';
const SESSION = 'test-session-001';

// Helper to capture stdout.write calls and return parsed JSON lines
function captureStdout(fn) {
  const lines = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    if (typeof chunk === 'string') {
      for (const line of chunk.split('\n').filter(Boolean)) {
        try { lines.push(JSON.parse(line)); } catch { /* non-JSON skip */ }
      }
    }
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

// We need to reset modules to get a fresh import every test because the module
// caches the existsSync calls. Instead, we mock at the vi.mock level.

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return { ...actual };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return { ...actual };
});

describe('autoCommitVaultMirror — action emission', () => {
  let existsSyncSpy;
  let readFileSyncSpy;
  let spawnSyncSpy;

  beforeEach(() => {
    existsSyncSpy = vi.spyOn(fs, 'existsSync');
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync');
    spawnSyncSpy = vi.spyOn(cp, 'spawnSync');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function getAutoCommit() {
    vi.resetModules();
    const mod = await import('@lib/vault-mirror/auto-commit.mjs');
    return mod.autoCommitVaultMirror;
  }

  it('emits no-mirror-dirs when neither 40-learnings nor 50-sessions exist', async () => {
    existsSyncSpy.mockReturnValue(false);
    const autoCommitVaultMirror = await getAutoCommit();

    const lines = captureStdout(() => autoCommitVaultMirror(VAULT, SESSION));
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('auto-commit-skipped');
    expect(lines[0].reason).toBe('no-mirror-dirs');
  });

  it('emits not-a-git-repo when rev-parse fails', async () => {
    existsSyncSpy.mockImplementation((p) => {
      if (p.endsWith('40-learnings') || p.endsWith('50-sessions')) return true;
      return false;
    });
    spawnSyncSpy.mockReturnValue({ status: 1, stdout: '', stderr: 'not a git repo' });
    const autoCommitVaultMirror = await getAutoCommit();

    const lines = captureStdout(() => autoCommitVaultMirror(VAULT, SESSION));
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('auto-commit-skipped');
    expect(lines[0].reason).toBe('not-a-git-repo');
  });

  it('emits git-add-failed when git add returns non-zero', async () => {
    existsSyncSpy.mockImplementation((p) => {
      if (p.endsWith('40-learnings') || p.endsWith('50-sessions')) return true;
      return false;
    });
    spawnSyncSpy
      .mockReturnValueOnce({ status: 0, stdout: '.git', stderr: '' }) // rev-parse
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'add error' }); // git add
    const autoCommitVaultMirror = await getAutoCommit();

    const lines = captureStdout(() => autoCommitVaultMirror(VAULT, SESSION));
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('auto-commit-skipped');
    expect(lines[0].reason).toBe('git-add-failed');
  });

  it('emits git-diff-failed when git diff --cached returns non-zero', async () => {
    existsSyncSpy.mockImplementation((p) => {
      if (p.endsWith('40-learnings') || p.endsWith('50-sessions')) return true;
      return false;
    });
    spawnSyncSpy
      .mockReturnValueOnce({ status: 0, stdout: '.git', stderr: '' }) // rev-parse
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })      // git add
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'diff err' }); // git diff
    const autoCommitVaultMirror = await getAutoCommit();

    const lines = captureStdout(() => autoCommitVaultMirror(VAULT, SESSION));
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('auto-commit-skipped');
    expect(lines[0].reason).toBe('git-diff-failed');
  });

  it('emits no-staged-changes when diff output is empty', async () => {
    existsSyncSpy.mockImplementation((p) => {
      if (p.endsWith('40-learnings') || p.endsWith('50-sessions')) return true;
      return false;
    });
    spawnSyncSpy
      .mockReturnValueOnce({ status: 0, stdout: '.git', stderr: '' }) // rev-parse
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })     // git add
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });    // git diff → empty
    const autoCommitVaultMirror = await getAutoCommit();

    const lines = captureStdout(() => autoCommitVaultMirror(VAULT, SESSION));
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('auto-commit-noop');
    expect(lines[0].reason).toBe('no-staged-changes');
  });

  it('emits non-mirror-staged-changes when a staged file lacks the generator marker', async () => {
    existsSyncSpy.mockImplementation((p) => {
      // mirror dirs exist
      if (p.endsWith('40-learnings') || p.endsWith('50-sessions')) return true;
      // staged file exists for readFileSync
      return true;
    });
    spawnSyncSpy
      .mockReturnValueOnce({ status: 0, stdout: '.git', stderr: '' }) // rev-parse
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })     // git add
      .mockReturnValueOnce({ status: 0, stdout: '40-learnings/handwritten.md\n', stderr: '' }) // git diff
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' }); // git restore (unstage)
    // readFileSync for isMirrorArtifact — no generator marker
    readFileSyncSpy.mockReturnValue('---\ntitle: hand written\n---\n\nNo generator here.\n');
    const autoCommitVaultMirror = await getAutoCommit();

    const lines = captureStdout(() => autoCommitVaultMirror(VAULT, SESSION));
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('auto-commit-skipped');
    expect(lines[0].reason).toBe('non-mirror-staged-changes');
    expect(lines[0].offenders).toContain('40-learnings/handwritten.md');
  });

  it('emits git-commit-failed when git commit returns non-zero', async () => {
    existsSyncSpy.mockImplementation((p) => {
      if (p.endsWith('40-learnings') || p.endsWith('50-sessions')) return true;
      return true; // file exists for readFileSync
    });
    spawnSyncSpy
      .mockReturnValueOnce({ status: 0, stdout: '.git', stderr: '' }) // rev-parse
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })     // git add
      .mockReturnValueOnce({ status: 0, stdout: '40-learnings/learning.md\n', stderr: '' }) // git diff
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'commit failed' }); // git commit
    readFileSyncSpy.mockReturnValue(`---\n_generator: ${GENERATOR_MARKER}\n---\n`);
    const autoCommitVaultMirror = await getAutoCommit();

    const lines = captureStdout(() => autoCommitVaultMirror(VAULT, SESSION));
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('auto-commit-skipped');
    expect(lines[0].reason).toBe('git-commit-failed');
  });

  it('emits auto-commit-created with correct counts on success', async () => {
    existsSyncSpy.mockImplementation((p) => {
      if (p.endsWith('40-learnings') || p.endsWith('50-sessions')) return true;
      return true;
    });
    // Staged: 2 learnings + 1 session
    const diffOut = '40-learnings/learning-a.md\n40-learnings/learning-b.md\n50-sessions/session-x.md\n';
    spawnSyncSpy
      .mockReturnValueOnce({ status: 0, stdout: '.git', stderr: '' })   // rev-parse
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })        // git add
      .mockReturnValueOnce({ status: 0, stdout: diffOut, stderr: '' })   // git diff
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })        // git commit
      .mockReturnValueOnce({ status: 0, stdout: 'abc1234567890\n', stderr: '' }); // rev-parse HEAD
    readFileSyncSpy.mockReturnValue(`---\n_generator: ${GENERATOR_MARKER}\n---\n`);
    const autoCommitVaultMirror = await getAutoCommit();

    const lines = captureStdout(() => autoCommitVaultMirror(VAULT, SESSION));
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('auto-commit-created');
    expect(lines[0].learnings).toBe(2);
    expect(lines[0].sessions).toBe(1);
    expect(lines[0].files).toBe(3);
    expect(lines[0].subject).toBe(`chore(vault): mirror ${SESSION} — 2 learnings + 1 sessions`);
  });

  it('emits exactly one JSON line per invocation (no-mirror-dirs case)', async () => {
    existsSyncSpy.mockReturnValue(false);
    const autoCommitVaultMirror = await getAutoCommit();

    const lines = captureStdout(() => autoCommitVaultMirror(VAULT, SESSION));
    expect(lines).toHaveLength(1);
  });

  it('emits exactly one JSON line per invocation (success case)', async () => {
    existsSyncSpy.mockImplementation((p) => {
      if (p.endsWith('40-learnings') || p.endsWith('50-sessions')) return true;
      return true;
    });
    spawnSyncSpy
      .mockReturnValueOnce({ status: 0, stdout: '.git', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '40-learnings/a.md\n', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: 'sha123\n', stderr: '' });
    readFileSyncSpy.mockReturnValue(`---\n_generator: ${GENERATOR_MARKER}\n---\n`);
    const autoCommitVaultMirror = await getAutoCommit();

    const lines = captureStdout(() => autoCommitVaultMirror(VAULT, SESSION));
    expect(lines).toHaveLength(1);
  });

  it('isMirrorArtifact returns false when readFileSync throws ENOENT', async () => {
    existsSyncSpy.mockImplementation((p) => {
      if (p.endsWith('40-learnings') || p.endsWith('50-sessions')) return true;
      return true; // staged path "exists"
    });
    spawnSyncSpy
      .mockReturnValueOnce({ status: 0, stdout: '.git', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '40-learnings/missing.md\n', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' }); // git restore
    // readFileSync throws — isMirrorArtifact catches and returns false (offender)
    readFileSyncSpy.mockImplementation(() => {
      const err = new Error('ENOENT: no such file or directory');
      err.code = 'ENOENT';
      throw err;
    });
    const autoCommitVaultMirror = await getAutoCommit();

    const lines = captureStdout(() => autoCommitVaultMirror(VAULT, SESSION));
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('auto-commit-skipped');
    expect(lines[0].reason).toBe('non-mirror-staged-changes');
  });
});
