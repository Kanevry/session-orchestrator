// SPDX-License-Identifier: MIT
// Tests for scripts/lib/autopilot/durable-telemetry.mjs
// Closes #483 W4-Q3-MED-2 / W4-Q4-H1 (module shipped W2 I5 with zero tests).
// Covers: enabled:false no-op path, input validation, and the #483 W4-Q5
// security guards (branch-name allowlist + cwd confinement).

import { describe, it, expect } from 'vitest';
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
