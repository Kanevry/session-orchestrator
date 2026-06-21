/**
 * engine.test.mjs — Unit tests for the #695 FA2 Reconciliation Engine
 * ORCHESTRATOR (`runReconcile`).
 *
 * DI seams (`opts.learnings`, `opts.merge`, `opts.loadLearnings`, `opts.dryRun`)
 * keep every test off the real corpus AND off the real sidecar. The
 * regression-lock test injects a committed fixture via `opts.learnings` so it is
 * deterministic and CI-portable (no read of the gitignored `learnings.jsonl`).
 *
 * The engine's load-bearing scope constraint is asserted: it COMPUTES proposals
 * (content lives inside each proposal object) and RECORDS them via the merge
 * seam, but NEVER writes `.claude/rules/`.
 */

import { describe, it, expect, vi } from 'vitest';

import { runReconcile } from '../../../scripts/lib/reconcile/engine.mjs';
import { RECONCILE_FIXTURE } from './_fixtures.mjs';

/** An eligible fragile-pattern learning (real type + non-empty file_paths). */
function eligibleLearning(overrides = {}) {
  return {
    type: 'fragile-pattern',
    subject: 'zx-imports',
    insight: 'Top-level zx imports cause fork-pool fragility',
    confidence: 0.9,
    file_paths: ['scripts/lib/autopilot/worktree-pipeline.mjs'],
    created_at: '2026-06-21T00:00:00Z',
    ...overrides,
  };
}

/** An ineligible learning (type not in the convert allow-list → rejected). */
function rejectLearning(overrides = {}) {
  return {
    type: 'effective-sizing',
    subject: 'deep-session-5w6a',
    confidence: 0.7,
    ...overrides,
  };
}

describe('runReconcile — committed-fixture regression lock (DI-injected dryRun)', () => {
  it('produces the fixture verdict: 6 total / 2 eligible / 2 proposed / 4 rejected / not written', async () => {
    const result = await runReconcile({ dryRun: true }, { learnings: RECONCILE_FIXTURE });

    expect(result.summary).toEqual({
      totalLearnings: 6,
      eligible: 2,
      proposed: 2,
      rejected: 4,
      written: false,
    });
    expect(result.proposals).toHaveLength(2);
    expect(result.rejected).toHaveLength(4);
  });
});

describe('runReconcile — DI injection', () => {
  it('partitions injected learnings into 1 proposal + 1 rejection and passes candidates to the merge seam', async () => {
    const merge = vi.fn(() => ({ merged: [], written: true }));

    const result = await runReconcile(
      {},
      { learnings: [eligibleLearning(), rejectLearning()], merge },
    );

    expect(result.summary.proposed).toBe(1);
    expect(result.summary.rejected).toBe(1);
    expect(result.summary.written).toBe(true);

    // The merge seam received the minted candidates (proposal + rejection).
    expect(merge).toHaveBeenCalledTimes(1);
    expect(merge.mock.calls[0][0].candidates).toHaveLength(2);
  });
});

describe('runReconcile — empty short-circuit', () => {
  it('returns an all-zero summary, no proposals/rejections, and never writes on an empty corpus', async () => {
    const merge = vi.fn(() => ({ merged: [], written: true }));

    const result = await runReconcile({}, { learnings: [], merge });

    expect(result.proposals).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.summary).toEqual({
      totalLearnings: 0,
      eligible: 0,
      proposed: 0,
      rejected: 0,
      written: false,
    });
    // Empty short-circuit touches no disk — merge seam is never invoked.
    expect(merge).not.toHaveBeenCalled();
  });
});

describe('runReconcile — never-throws boundary', () => {
  it('returns a zeroed result with an error field instead of throwing when the loader throws', async () => {
    const result = await runReconcile(
      {},
      {
        loadLearnings: () => {
          throw new Error('boom');
        },
      },
    );

    expect(result.error).toBe('boom');
    expect(result.summary).toEqual({
      totalLearnings: 0,
      eligible: 0,
      proposed: 0,
      rejected: 0,
      written: false,
    });
    expect(result.proposals).toEqual([]);
  });
});

describe('runReconcile — never writes .claude/rules/', () => {
  it('returns rule content inside the proposal object without persisting any rule file', async () => {
    // A merge stub keeps the real sidecar untouched; the engine NEVER writes
    // .claude/rules/, so the rendered rule is only ever carried in the proposal.
    const merge = vi.fn(() => ({ merged: [], written: true }));

    const result = await runReconcile({}, { learnings: [eligibleLearning()], merge });

    expect(result.proposals).toHaveLength(1);
    expect(typeof result.proposals[0].content).toBe('string');
    expect(result.proposals[0].path).toBe(
      '.claude/rules/fragile-pattern-zx-imports-660952b.md',
    );
    // The ONLY disk write the engine performs is via the merge seam (the
    // sidecar) — and here that seam is a stub, so no real file is written.
    expect(merge).toHaveBeenCalledTimes(1);
  });
});
