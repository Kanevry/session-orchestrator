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

  it('commit is run with --no-verify (intentional bypass — issue #603)', async () => {
    // Pins the documented --no-verify behaviour so a future silent removal fails CI.
    // Rationale: see scripts/lib/vault-mirror/auto-commit.mjs line ~116 and
    // skills/vault-mirror/SKILL.md § "Pre-commit hook bypass (--no-verify)".
    existsSyncSpy.mockImplementation((p) => {
      if (p.endsWith('40-learnings') || p.endsWith('50-sessions')) return true;
      return true;
    });
    spawnSyncSpy
      .mockReturnValueOnce({ status: 0, stdout: '.git', stderr: '' })   // rev-parse --git-dir
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })        // git add
      .mockReturnValueOnce({ status: 0, stdout: '40-learnings/a.md\n', stderr: '' }) // git diff
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })        // git commit
      .mockReturnValueOnce({ status: 0, stdout: 'sha123\n', stderr: '' }); // rev-parse HEAD
    readFileSyncSpy.mockReturnValue(`---\n_generator: ${GENERATOR_MARKER}\n---\n`);
    const autoCommitVaultMirror = await getAutoCommit();

    const lines = captureStdout(() => autoCommitVaultMirror(VAULT, SESSION));
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('auto-commit-created');

    // Find the actual `git commit` spawnSync call and assert it carries --no-verify.
    const commitCall = spawnSyncSpy.mock.calls.find(([cmd, args]) =>
      cmd === 'git' && Array.isArray(args) && args.includes('commit'),
    );
    expect(commitCall).toBeDefined();
    const [, commitArgs] = commitCall;
    expect(commitArgs).toContain('--no-verify');
    // Sanity: the bypass sits on the commit (not some unrelated git invocation).
    expect(commitArgs).toContain('-m');
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

describe('cross-repo commit isolation (#660)', () => {
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

  // Test 1: Cross-repo reject
  // When git diff returns staged files from BOTH repo-a AND repo-b namespaces
  // (simulating another process having staged repo-b files), the guard must:
  //   - emit auto-commit-skipped with reason cross-repo-staged-changes
  //   - call git restore --staged (the 4th spawnSync call)
  //   - never call git commit
  it('emits cross-repo-staged-changes and unstages when diff reveals foreign-namespace files', async () => {
    // existsSync: both per-repo subfolders exist
    existsSyncSpy.mockImplementation((p) => {
      if (p.endsWith('40-learnings/repo-a') || p.endsWith('50-sessions/repo-a')) return true;
      return false;
    });
    // All files have the mirror marker — the NAMESPACE check fires, not the marker check
    readFileSyncSpy.mockReturnValue(`---\n_generator: ${GENERATOR_MARKER}\n---\n`);
    // git call sequence:
    //   1. rev-parse --git-dir  → success
    //   2. git add              → success
    //   3. git diff --cached    → returns files from BOTH namespaces (cross-process contamination)
    //   4. git restore --staged → success (the unstage step)
    const mixedDiff = '40-learnings/repo-a/foo.md\n40-learnings/repo-b/bar.md\n';
    spawnSyncSpy
      .mockReturnValueOnce({ status: 0, stdout: '.git', stderr: '' }) // rev-parse
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })     // git add
      .mockReturnValueOnce({ status: 0, stdout: mixedDiff, stderr: '' }) // git diff
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });    // git restore --staged
    const autoCommitVaultMirror = await getAutoCommit();

    const lines = captureStdout(() => autoCommitVaultMirror(VAULT, SESSION, 'repo-a'));

    // Action must be auto-commit-skipped with cross-repo reason
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('auto-commit-skipped');
    expect(lines[0].reason).toBe('cross-repo-staged-changes');
    // foreignRepos payload must identify the intruder
    expect(lines[0].foreignRepos).toEqual(['repo-b']);

    // The 4th git call must be restore --staged (not commit)
    const calls = spawnSyncSpy.mock.calls;
    expect(calls).toHaveLength(4);
    const [, restoreArgs] = calls[3];
    expect(restoreArgs).toContain('restore');
    expect(restoreArgs).toContain('--staged');

    // git commit must never have been called
    const commitCall = calls.find(([, args]) => Array.isArray(args) && args.includes('commit'));
    expect(commitCall).toBeUndefined();
  });

  // Test 2: Namespace-scoped staging
  // When repo='repo-a', git add must be called with the per-repo subfolders
  // (40-learnings/repo-a, 50-sessions/repo-a), NOT whole dirs (40-learnings, 50-sessions).
  it('scopes git add to per-repo subfolders when repo is provided', async () => {
    // Both per-repo subfolders exist
    existsSyncSpy.mockImplementation((p) => {
      if (p.endsWith('40-learnings/repo-a') || p.endsWith('50-sessions/repo-a')) return true;
      return false;
    });
    readFileSyncSpy.mockReturnValue(`---\n_generator: ${GENERATOR_MARKER}\n---\n`);
    spawnSyncSpy
      .mockReturnValueOnce({ status: 0, stdout: '.git', stderr: '' })   // rev-parse
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })        // git add
      .mockReturnValueOnce({ status: 0, stdout: '40-learnings/repo-a/learning.md\n', stderr: '' }) // git diff
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })        // git commit
      .mockReturnValueOnce({ status: 0, stdout: 'abc123\n', stderr: '' }); // rev-parse HEAD
    const autoCommitVaultMirror = await getAutoCommit();

    captureStdout(() => autoCommitVaultMirror(VAULT, SESSION, 'repo-a'));

    // The 2nd spawnSync call is git add; verify its args are repo-scoped
    const addCall = spawnSyncSpy.mock.calls[1];
    const [addCmd, addArgs] = addCall;
    expect(addCmd).toBe('git');
    // Must include the per-repo subfolder paths
    expect(addArgs).toContain('40-learnings/repo-a');
    expect(addArgs).toContain('50-sessions/repo-a');
    // Must NOT include bare whole-dir targets
    // Exact token matching: '40-learnings' alone (without '/repo-a') must not appear as a standalone arg
    expect(addArgs.filter((a) => a === '40-learnings')).toHaveLength(0);
    expect(addArgs.filter((a) => a === '50-sessions')).toHaveLength(0);
  });

  // Test 3: Same-repo passes — all staged files under repo-a namespace → proceeds to commit
  it('proceeds to commit when all staged files belong to the declared repo namespace', async () => {
    existsSyncSpy.mockImplementation((p) => {
      if (p.endsWith('40-learnings/repo-a') || p.endsWith('50-sessions/repo-a')) return true;
      return false;
    });
    readFileSyncSpy.mockReturnValue(`---\n_generator: ${GENERATOR_MARKER}\n---\n`);
    const sameDiff = '40-learnings/repo-a/learning-1.md\n50-sessions/repo-a/session-x.md\n';
    spawnSyncSpy
      .mockReturnValueOnce({ status: 0, stdout: '.git', stderr: '' })        // rev-parse
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })             // git add
      .mockReturnValueOnce({ status: 0, stdout: sameDiff, stderr: '' })      // git diff
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })             // git commit
      .mockReturnValueOnce({ status: 0, stdout: 'def456\n', stderr: '' });   // rev-parse HEAD
    const autoCommitVaultMirror = await getAutoCommit();

    const lines = captureStdout(() => autoCommitVaultMirror(VAULT, SESSION, 'repo-a'));

    // Must commit successfully — no skip, no restore
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('auto-commit-created');
    expect(lines[0].learnings).toBe(1);
    expect(lines[0].sessions).toBe(1);
    expect(lines[0].files).toBe(2);

    // git restore --staged must NOT have been called
    const restoreCall = spawnSyncSpy.mock.calls.find(
      ([, args]) => Array.isArray(args) && args.includes('restore'),
    );
    expect(restoreCall).toBeUndefined();
  });

  // Test 4: Backward-compat — 2-arg call → whole-dir git add (legacy behavior unchanged)
  it('stages whole mirror dirs (not per-repo) when repo argument is omitted', async () => {
    // existsSync: whole dirs exist (legacy check path: endsWith '40-learnings')
    existsSyncSpy.mockImplementation((p) => {
      if (p.endsWith('40-learnings') || p.endsWith('50-sessions')) return true;
      return false;
    });
    readFileSyncSpy.mockReturnValue(`---\n_generator: ${GENERATOR_MARKER}\n---\n`);
    spawnSyncSpy
      .mockReturnValueOnce({ status: 0, stdout: '.git', stderr: '' })   // rev-parse
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })        // git add
      .mockReturnValueOnce({ status: 0, stdout: '40-learnings/any.md\n', stderr: '' }) // git diff
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })        // git commit
      .mockReturnValueOnce({ status: 0, stdout: 'ghi789\n', stderr: '' }); // rev-parse HEAD
    const autoCommitVaultMirror = await getAutoCommit();

    captureStdout(() => autoCommitVaultMirror(VAULT, SESSION)); // 2-arg call

    // The 2nd spawnSync call is git add; its args must be whole dirs, not per-repo subfolders
    const addCall = spawnSyncSpy.mock.calls[1];
    const [, addArgs] = addCall;
    expect(addArgs).toContain('40-learnings');
    expect(addArgs).toContain('50-sessions');
    // Must NOT contain any per-repo-scoped subfolder arg
    const hasNamespacedArg = addArgs.some(
      (a) => typeof a === 'string' && a.startsWith('40-learnings/'),
    );
    expect(hasNamespacedArg).toBe(false);
  });
});
