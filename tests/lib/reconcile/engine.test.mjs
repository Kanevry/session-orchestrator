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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    // Pinned `now` (issue #741.1c wiring — engine.mjs now threads nowMs into
    // the eligibility expiry gate). The fixture's two eligible records expire
    // 2026-08-05 (created_at 2026-06-21 + 45d fragile-pattern/recurring-issue
    // TTL) — without this pin, `Date.now()` would flip this fixture-lock to
    // "already-expired-at-proposal" after that date. Pinned well before expiry
    // keeps the assertion deterministic forever.
    const result = await runReconcile(
      { dryRun: true, now: new Date('2026-06-25T00:00:00Z') },
      { learnings: RECONCILE_FIXTURE },
    );

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

    // Pin `now` before the fixture's 2026-08-05 natural expiry (created_at
    // 2026-06-21 + 45d fragile-pattern TTL) — engine.mjs threads nowMs into the
    // eligibility expiry gate (#741.1c), so an unpinned Date.now() would flip
    // eligibleLearning() to already-expired-at-proposal after that date.
    const result = await runReconcile(
      { now: new Date('2026-06-25T00:00:00Z') },
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

describe('runReconcile — default loader uses the learnings schema SSOT', () => {
  it('converts a legacy dialect record read from disk without requiring a prior backfill', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'reconcile-engine-loader-'));
    try {
      const metricsDir = join(repoRoot, '.orchestrator', 'metrics');
      mkdirSync(metricsDir, { recursive: true });
      writeFileSync(
        join(metricsDir, 'learnings.jsonl'),
        JSON.stringify({
          type: 'anti-pattern',
          name: 'legacy files carrier',
          description: 'Legacy records with files[] must still reconcile through the default loader.',
          evidence: 'Fleet corpus used files[] before file_paths[] became canonical.',
          confidence: 0.9,
          sessions: ['main-2026-07-04-deep-1'],
          created_at: '2026-07-04T00:00:00Z',
          files: ['scripts/lib/reconcile/engine.mjs'],
        }) + '\n',
        'utf8',
      );

      const result = await runReconcile({
        repoRoot,
        dryRun: true,
        now: new Date('2026-07-04T00:00:00Z'),
      });

      expect(result.error).toBeUndefined();
      expect(result.summary).toMatchObject({
        totalLearnings: 1,
        eligible: 1,
        proposed: 1,
        rejected: 0,
        written: false,
      });
      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0].path).toMatch(
        /^\.claude\/rules\/anti-pattern-legacy-files-carrier-[a-f0-9]{7}\.md$/,
      );
      expect(result.proposals[0].content).toContain(
        'Legacy records with files[] must still reconcile through the default loader.',
      );
      expect(result.proposals[0].content).toContain(
        '- source-session: `main-2026-07-04-deep-1`',
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
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

describe('runReconcile — minRuleDays / minInsightChars param forwarding (#741.1/#741.2 config plumbing)', () => {
  it('minInsightChars, when forwarded, rejects a non-empty-but-short insight that is eligible by default', async () => {
    const pinnedNow = new Date('2026-06-25T00:00:00Z');
    const shortInsightLearning = eligibleLearning({
      subject: 'short-insight-case',
      insight: 'too short', // 9 chars — non-empty, non-placeholder, but < 24
    });

    // Baseline: minInsightChars omitted (undefined) — the placeholder-insight
    // gate stays inert for a non-empty, non-placeholder insight, so the
    // learning is still proposed.
    const baseline = await runReconcile(
      { dryRun: true, now: pinnedNow },
      { learnings: [shortInsightLearning] },
    );
    expect(baseline.summary.proposed).toBe(1);
    expect(baseline.summary.rejected).toBe(0);

    // Fake-regression note: before this wave wired `minInsightChars` through
    // to `filterEligible` (engine.mjs previously hardcoded the literal
    // `undefined`), this call would have produced the SAME result as the
    // baseline above — the gate below is the fix under test.
    const gated = await runReconcile(
      { dryRun: true, now: pinnedNow, minInsightChars: 24 },
      { learnings: [shortInsightLearning] },
    );
    expect(gated.summary.proposed).toBe(0);
    expect(gated.summary.rejected).toBe(1);
    expect(gated.rejected[0].reason).toContain('min-insight-chars 24');
  });

  it('minRuleDays, when forwarded, floors a near-dead learning\'s expires-at to now + minRuleDays days', async () => {
    // fragile-pattern TTL = 45d (learnings/schema.mjs LEARNING_TYPE_REGISTRY).
    // created_at 2026-05-13 + 45d -> natural expiry 2026-06-27 (2 days after
    // the pinned `now` below — eligible, not already-expired-at-proposal, but
    // near-dead relative to a 15-day floor).
    const nearDeadLearning = eligibleLearning({
      subject: 'near-dead-case',
      created_at: '2026-05-13T00:00:00Z',
    });

    const result = await runReconcile(
      { dryRun: true, now: new Date('2026-06-25T00:00:00Z'), minRuleDays: 15 },
      { learnings: [nearDeadLearning] },
    );

    expect(result.summary.proposed).toBe(1);
    // Fake-regression note: before this wave forwarded `minRuleDays` to
    // `toActivationMetadata`, the emitter's internal MIN_RULE_DAYS_DEFAULT
    // (7d) would have floored this to 2026-07-02 (now+7d) instead of the
    // requested 2026-07-10 (now+15d) — the assertion below is the fix under test.
    expect(result.proposals[0].content).toContain('expires-at: 2026-07-10');
  });
});

describe('runReconcile — never writes .claude/rules/', () => {
  it('returns rule content inside the proposal object without persisting any rule file', async () => {
    // A merge stub keeps the real sidecar untouched; the engine NEVER writes
    // .claude/rules/, so the rendered rule is only ever carried in the proposal.
    const merge = vi.fn(() => ({ merged: [], written: true }));

    // Pin `now` before the fixture's 2026-08-05 natural expiry (see #741.1c note above).
    const result = await runReconcile(
      { now: new Date('2026-06-25T00:00:00Z') },
      { learnings: [eligibleLearning()], merge },
    );

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
