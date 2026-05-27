// SPDX-License-Identifier: MIT
// Tests for scripts/lib/autopilot/durable-telemetry.mjs
// Closes #483 W4-Q3-MED-2 / W4-Q4-H1 (module shipped W2 I5 with zero tests).
// Covers: enabled:false no-op path, input validation, and the #483 W4-Q5
// security guards (branch-name allowlist + cwd confinement).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { durableCommit, withDurableCommit } from '../../../scripts/lib/autopilot/durable-telemetry.mjs';

describe('durableCommit — input validation', () => {
  it('rejects a non-object opts argument', async () => {
    const result = await durableCommit(null);
    expect(result).toEqual({ ok: false, error: 'opts must be an object' });
  });

  it('rejects a missing sessionId', async () => {
    const result = await durableCommit({ files: ['package.json'] });
    expect(result).toEqual({ ok: false, error: 'sessionId required' });
  });

  it('rejects an empty files array', async () => {
    const result = await durableCommit({ sessionId: 'test-session', files: [] });
    expect(result).toEqual({ ok: false, error: 'files[] cannot be empty' });
  });

  it('rejects a non-array files value', async () => {
    const result = await durableCommit({ sessionId: 'test-session', files: 'package.json' });
    expect(result).toEqual({ ok: false, error: 'files[] cannot be empty' });
  });
});

describe('durableCommit — enabled:false no-op (local execution path)', () => {
  it('returns {ok:true, skipped:true} without touching git when enabled is omitted', async () => {
    const result = await durableCommit({ sessionId: 'test-session', files: ['package.json'] });
    expect(result).toEqual({ ok: true, skipped: true });
  });

  it('returns {ok:true, skipped:true} when enabled is explicitly false', async () => {
    const result = await durableCommit({
      sessionId: 'test-session',
      files: ['package.json'],
      enabled: false,
    });
    expect(result).toEqual({ ok: true, skipped: true });
  });
});

describe('durableCommit — security guards (#483 W4-Q5)', () => {
  it('rejects an unsafe branch name with shell metacharacters', async () => {
    const result = await durableCommit({
      sessionId: 'test-session',
      files: ['package.json'],
      branch: 'main; git push origin main --force',
      enabled: true,
    });
    expect(result).toEqual({
      ok: false,
      error: 'unsafe branch name rejected: main; git push origin main --force',
    });
  });

  it('rejects a branch name with command substitution', async () => {
    const result = await durableCommit({
      sessionId: 'test-session',
      files: ['package.json'],
      branch: 'x$(cat .env)',
      enabled: true,
    });
    expect(result).toEqual({ ok: false, error: 'unsafe branch name rejected: x$(cat .env)' });
  });

  it('rejects a cwd outside the project root without allowForeignCwd', async () => {
    const result = await durableCommit({
      sessionId: 'test-session',
      files: ['package.json'],
      cwd: '/tmp/attacker-repo',
      enabled: true,
    });
    expect(result).toEqual({
      ok: false,
      error: 'cwd outside project root rejected: /tmp/attacker-repo',
    });
  });

  it('accepts a safe default branch name (claude/<sessionId>) past the allowlist gate', async () => {
    // enabled:false short-circuits before git runs, but branch validation happens
    // AFTER the enabled gate — so a safe sessionId must NOT trip the guard.
    const result = await durableCommit({ sessionId: 'deep-3-2026-05-19', files: ['package.json'] });
    expect(result).toEqual({ ok: true, skipped: true });
  });
});

describe('withDurableCommit — wrapper', () => {
  it('invokes the write function then delegates to durableCommit (no-op path)', async () => {
    let wrote = false;
    const result = await withDurableCommit(
      () => {
        wrote = true;
      },
      { sessionId: 'test-session', files: ['package.json'] }
    );
    expect(wrote).toBe(true);
    expect(result).toEqual({ ok: true, skipped: true });
  });
});

describe('durableCommit — multi-file array support (#490)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  it('no-ops with {ok:true, skipped:true} for a 3-file array when enabled is false', async () => {
    // #490 AC2: the session-end-owned set is multi-file. enabled:false must
    // short-circuit regardless of files.length — it is not single-file gated.
    const result = await durableCommit({
      sessionId: 'test-session',
      files: [
        '.orchestrator/metrics/autopilot.jsonl',
        '.orchestrator/metrics/sessions.jsonl',
        '.claude/STATE.md',
      ],
      enabled: false,
    });
    expect(result).toEqual({ ok: true, skipped: true });
  });

  it('withDurableCommit runs the writer then no-ops for the exact 3-file telemetry tuple (enabled:false)', async () => {
    // The full durable-telemetry tuple committed across loop.mjs (autopilot.jsonl)
    // + session-end (sessions.jsonl + STATE.md). enabled:false → local no-op.
    let wrote = false;
    const result = await withDurableCommit(
      () => {
        wrote = true;
      },
      {
        sessionId: 'main-2026-05-27-deep-3',
        files: [
          '.orchestrator/metrics/autopilot.jsonl',
          '.orchestrator/metrics/sessions.jsonl',
          '.claude/STATE.md',
        ],
        enabled: false,
      }
    );
    expect(wrote).toBe(true);
    expect(result).toEqual({ ok: true, skipped: true });
  });

  it('returns {ok:false, error:/file not found/} when one of multiple files is missing (enabled:true)', async () => {
    // Verifies the per-file existsSync guard fires inside the array loop for
    // files.length > 1. git is mocked so the test stays hermetic — the branch
    // already "exists" so no `git branch` create runs, and the missing-file
    // guard returns before any `git add`/`git commit`.
    const sessionId = 'test-session';
    const branch = `claude/${sessionId}`;
    const execSyncMock = vi.fn((cmd) => {
      if (typeof cmd === 'string' && cmd.startsWith('git branch --list')) {
        return `* main\n  ${branch}\n`;
      }
      return '';
    });
    vi.doMock('node:child_process', () => ({ execSync: execSyncMock }));
    vi.resetModules();
    const { durableCommit: durableCommitMocked } = await import(
      '../../../scripts/lib/autopilot/durable-telemetry.mjs'
    );

    // durableCommit joins each entry onto cwd (process.cwd() = repo root in this
    // test), so pass repo-relative paths: file 1 exists, file 2 does not.
    const existingFile = 'package.json'; // resolves to <repo>/package.json — exists
    const missingFile = '.orchestrator/__does-not-exist-490__.jsonl'; // missing

    const result = await durableCommitMocked({
      sessionId,
      files: [existingFile, missingFile],
      enabled: true,
      branch,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(`file not found: ${missingFile}`);
    // No commit should have been attempted once a file failed the guard.
    expect(execSyncMock).not.toHaveBeenCalledWith(
      expect.stringContaining('git commit'),
      expect.anything()
    );
  });
});
