/**
 * evolve-telemetry.test.mjs — Unit tests for the #1206 mechanical
 * `orchestrator.evolve.completed` / `orchestrator.dialectic.completed`
 * emitters (`scripts/lib/learnings/evolve-telemetry.mjs`).
 *
 * DI-free: both emitters take a plain options object and write directly into
 * `<repoRoot>/.orchestrator/metrics/events.jsonl` via the real `emitEvent()`,
 * so every test pins a TMP repo root — same pattern as
 * `tests/lib/reconcile/engine.test.mjs`'s telemetry describe block. The one
 * deliberate exception is the no-repoRoot regression, which asserts this
 * repo's REAL ledger stays byte-identical (#1119).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  emitEvolveCompleted,
  recordDialecticRun,
} from '../../../scripts/lib/learnings/evolve-telemetry.mjs';

const REAL_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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

  it('REGRESSION: no repoRoot writes NO event into the real fleet ledger', async () => {
    const realLedger = join(REAL_REPO_ROOT, '.orchestrator', 'metrics', 'events.jsonl');
    const before = existsSync(realLedger) ? statSync(realLedger).size : -1;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await emitEvolveCompleted({ appended: 1, durationMs: 1 });
      const after = existsSync(realLedger) ? statSync(realLedger).size : -1;
      expect(after).toBe(before);
      expect(stderr).toHaveBeenCalledTimes(1);
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

  it('REGRESSION: no repoRoot writes NO event into the real fleet ledger', async () => {
    const realLedger = join(REAL_REPO_ROOT, '.orchestrator', 'metrics', 'events.jsonl');
    const before = existsSync(realLedger) ? statSync(realLedger).size : -1;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await recordDialecticRun({ status: 'empty-input', durationMs: 1 });
      const after = existsSync(realLedger) ? statSync(realLedger).size : -1;
      expect(after).toBe(before);
      expect(stderr).toHaveBeenCalledTimes(1);
    } finally {
      stderr.mockRestore();
    }
  });
});
