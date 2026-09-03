/**
 * evolve-telemetry.test.mjs — Unit tests for the #1206 mechanical
 * `orchestrator.evolve.completed` / `orchestrator.dialectic.completed`
 * emitters (`scripts/lib/learnings/evolve-telemetry.mjs`).
 *
 * DI-free: both emitters take a plain options object and write directly into
 * `<repoRoot>/.orchestrator/metrics/events.jsonl` via the real `emitEvent()`,
 * so every test pins a TMP repo root — same pattern as
 * `tests/lib/reconcile/engine.test.mjs`'s telemetry describe block.
 *
 * The two no-repoRoot regression tests are the one exception: they never
 * touch this repo's real ledger (statSync-ing it before/after was flaky
 * under parallel sessions and hooks that write into that same file — #1206
 * W4 MED-4). Instead they point the AMBIENT project dir (`CLAUDE_PROJECT_DIR`,
 * which `scripts/lib/platform.mjs`'s `SO_PROJECT_DIR` resolves from — see
 * `tests/lib/events-default-url.test.mjs` for the same isolation pattern) at
 * a throwaway tmpdir via `vi.resetModules()` + a dynamic re-import, then
 * assert nothing was written even there. That is a STRICTER guard than the
 * byte-identical check it replaces: it would still catch a regression where
 * the `repoRoot` guard is removed and the call silently falls through to
 * `emitEvent()`'s own `SO_PROJECT_DIR` default — without ever depending on,
 * or risking corrupting, this repo's real event ledger.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  emitEvolveCompleted,
  recordDialecticRun,
} from '../../../scripts/lib/learnings/evolve-telemetry.mjs';

/** Every record in a tmp repo's event ledger. */
function ledger(repoRoot) {
  const p = join(repoRoot, '.orchestrator', 'metrics', 'events.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

describe('emitEvolveCompleted', () => {
  let repoRoot;

  afterEach(() => {
    if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
    repoRoot = undefined;
  });

  it('writes exactly one orchestrator.evolve.completed record with all four counters, including zeros', async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'evolve-telemetry-'));
    mkdirSync(join(repoRoot, '.orchestrator', 'metrics'), { recursive: true });

    await emitEvolveCompleted({ repoRoot, durationMs: 42 });

    const records = ledger(repoRoot).filter((r) => r.event === 'orchestrator.evolve.completed');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      appended: 0,
      boosted: 0,
      pruned: 0,
      promoted: 0,
      duration_ms: 42,
    });
  });

  it('includes non-zero counters and the optional skipped array when passed', async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'evolve-telemetry-'));

    await emitEvolveCompleted({
      repoRoot,
      appended: 3,
      boosted: 2,
      pruned: 1,
      durationMs: 100,
      skipped: ['vault-mirror-off'],
    });

    const records = ledger(repoRoot).filter((r) => r.event === 'orchestrator.evolve.completed');
    expect(records[0]).toMatchObject({
      appended: 3,
      boosted: 2,
      pruned: 1,
      promoted: 0,
      skipped: ['vault-mirror-off'],
    });
  });

  it('omits the skipped field entirely when the array is empty (never an empty array on the wire)', async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'evolve-telemetry-'));

    await emitEvolveCompleted({ repoRoot, durationMs: 10 });

    const records = ledger(repoRoot).filter((r) => r.event === 'orchestrator.evolve.completed');
    expect('skipped' in records[0]).toBe(false);
  });

  it('emits the abort form (aborted + reason + duration_ms, no counters) when aborted is given', async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'evolve-telemetry-'));

    await emitEvolveCompleted({
      repoRoot,
      aborted: 'persistence-disabled',
      reason: 'Learnings require persistence to be enabled in Session Config.',
      durationMs: 5,
    });

    const records = ledger(repoRoot).filter((r) => r.event === 'orchestrator.evolve.completed');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      aborted: 'persistence-disabled',
      reason: 'Learnings require persistence to be enabled in Session Config.',
      duration_ms: 5,
    });
    expect('appended' in records[0]).toBe(false);
  });

  it('REGRESSION: no repoRoot writes NO event, even under an isolated ambient project dir', async () => {
    const origClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
    const isolatedDir = mkdtempSync(join(tmpdir(), 'evolve-telemetry-noroot-'));
    process.env.CLAUDE_PROJECT_DIR = isolatedDir;
    vi.resetModules();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const isolated = await import('@lib/learnings/evolve-telemetry.mjs');
      await isolated.emitEvolveCompleted({ appended: 1, durationMs: 1 });
      expect(existsSync(join(isolatedDir, '.orchestrator', 'metrics', 'events.jsonl'))).toBe(false);
      expect(stderr).toHaveBeenCalledTimes(1);
    } finally {
      stderr.mockRestore();
      if (origClaudeProjectDir === undefined) {
        delete process.env.CLAUDE_PROJECT_DIR;
      } else {
        process.env.CLAUDE_PROJECT_DIR = origClaudeProjectDir;
      }
      vi.resetModules();
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  });

  it('an emitFn that throws is caught, surfaced as one stderr WARN, and never rethrown (#1206 LOW-1)', async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'evolve-telemetry-'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const throwingEmitFn = vi.fn().mockRejectedValue(new Error('boom'));
    try {
      await expect(
        emitEvolveCompleted({ repoRoot, durationMs: 1, emitFn: throwingEmitFn }),
      ).resolves.toBeUndefined();
      expect(throwingEmitFn).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr.mock.calls[0][0]).toContain(
        'evolve-telemetry: emit failed (orchestrator.evolve.completed): boom',
      );
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('recordDialecticRun', () => {
  let repoRoot;

  afterEach(() => {
    if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
    repoRoot = undefined;
  });

  it('emits the success form with mode/deltas/tokens/duration_ms when status is "ok"', async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'evolve-telemetry-'));

    await recordDialecticRun({
      repoRoot,
      status: 'ok',
      mode: 'dry-run',
      userDeltas: 2,
      agentDeltas: 1,
      tokensIn: 1234,
      tokensOut: 567,
      durationMs: 88,
    });

    const records = ledger(repoRoot).filter((r) => r.event === 'orchestrator.dialectic.completed');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      mode: 'dry-run',
      user_deltas: 2,
      agent_deltas: 1,
      tokens_in: 1234,
      tokens_out: 567,
      duration_ms: 88,
    });
  });

  it('emits the abort form (aborted + duration_ms only) for any non-"ok" status', async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'evolve-telemetry-'));

    await recordDialecticRun({ repoRoot, status: 'budget-exceeded', durationMs: 7 });

    const records = ledger(repoRoot).filter((r) => r.event === 'orchestrator.dialectic.completed');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ aborted: 'budget-exceeded', duration_ms: 7 });
    expect('mode' in records[0]).toBe(false);
  });

  it('REGRESSION: no repoRoot writes NO event, even under an isolated ambient project dir', async () => {
    const origClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
    const isolatedDir = mkdtempSync(join(tmpdir(), 'evolve-telemetry-noroot-'));
    process.env.CLAUDE_PROJECT_DIR = isolatedDir;
    vi.resetModules();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const isolated = await import('@lib/learnings/evolve-telemetry.mjs');
      await isolated.recordDialecticRun({ status: 'empty-input', durationMs: 1 });
      expect(existsSync(join(isolatedDir, '.orchestrator', 'metrics', 'events.jsonl'))).toBe(false);
      expect(stderr).toHaveBeenCalledTimes(1);
    } finally {
      stderr.mockRestore();
      if (origClaudeProjectDir === undefined) {
        delete process.env.CLAUDE_PROJECT_DIR;
      } else {
        process.env.CLAUDE_PROJECT_DIR = origClaudeProjectDir;
      }
      vi.resetModules();
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  });
});
