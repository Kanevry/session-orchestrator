/**
 * eligibility.test.mjs — Unit tests for the #695 Reconciliation-engine
 * eligibility filter (`classifyLearning` / `filterEligible` / `CONVERT_TYPES`).
 *
 * Covers:
 *   - Happy path: eligible types with non-empty file_paths.
 *   - Reject: eligible type but no file_paths (empty file_paths reason).
 *   - Reject: type gate beats file gate (out-of-allow-list type WITH file_paths).
 *   - Reject: default-reject types (proven-pattern).
 *   - Invalid records (null / {} / no type) → rejected, never throws.
 *   - filterEligible partition shape + counts.
 *   - Committed-fixture regression lock (CI-portable; no real-file read).
 */

import { describe, it, expect } from 'vitest';

import {
  CONVERT_TYPES,
  classifyLearning,
  filterEligible,
} from '../../../scripts/lib/reconcile/eligibility.mjs';
import { LEARNING_TYPE_REGISTRY } from '../../../scripts/lib/learnings/schema.mjs';
import { RECONCILE_FIXTURE } from './_fixtures.mjs';

describe('classifyLearning — eligible records', () => {
  it('accepts a fragile-pattern with a non-empty file_paths[]', () => {
    const result = classifyLearning({
      type: 'fragile-pattern',
      insight: 'Top-level imports cause fork-pool fragility.',
      file_paths: ['scripts/lib/x.mjs'],
    });
    expect(result.eligible).toBe(true);
  });

  it('accepts a recurring-issue with file_paths[]', () => {
    const result = classifyLearning({
      type: 'recurring-issue',
      insight: 'Fresh claim files must be age-gated before a zombie sweep removes them.',
      file_paths: ['scripts/lib/y.mjs'],
    });
    expect(result.eligible).toBe(true);
  });

  it('accepts an anti-pattern with file_paths[]', () => {
    const result = classifyLearning({
      type: 'anti-pattern',
      insight: 'A quality-gate wrapper needs a large output buffer and env isolation.',
      file_paths: ['scripts/lib/z.mjs'],
    });
    expect(result.eligible).toBe(true);
  });
});

describe('classifyLearning — rejected records', () => {
  it('rejects an eligible type with no file_paths (empty file_paths reason)', () => {
    const result = classifyLearning({ type: 'fragile-pattern' });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/empty file_paths/);
  });

  it('rejects an eligible type with an empty file_paths array', () => {
    const result = classifyLearning({ type: 'fragile-pattern', file_paths: [] });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/empty file_paths/);
  });

  it('type gate beats file gate — out-of-allow-list type WITH file_paths rejects on type', () => {
    const result = classifyLearning({
      type: 'effective-sizing',
      file_paths: ['a.mjs'],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/not in convert allow-list/);
  });

  it('rejects proven-pattern as a default-reject type', () => {
    const result = classifyLearning({
      type: 'proven-pattern',
      file_paths: ['a.mjs'],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/not in convert allow-list/);
  });
});

// ---------------------------------------------------------------------------
// placeholder-insight gate (#741.2) — always-on: an empty or recovery-stub
// insight would produce an EMPTY rule body downstream, so it is rejected
// honestly at the eligibility gate rather than reaching the renderer.
//
// FAKE-REGRESSION: if PLACEHOLDER_RE (or the empty-insight check) were removed
// from eligibility.mjs, both rejection tests below would flip to
// `eligible: true` and go RED — proving the gate is load-bearing, not a
// green-by-coincidence assertion.
// ---------------------------------------------------------------------------

describe('classifyLearning — placeholder-insight gate (#741.2)', () => {
  it('rejects a legacy-recovery placeholder insight', () => {
    const result = classifyLearning({
      type: 'fragile-pattern',
      insight: '(legacy record — insight backfilled during 2026-07-02 recovery)',
      file_paths: ['scripts/lib/x.mjs'],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/placeholder-insight/);
  });

  it('rejects an empty insight', () => {
    const result = classifyLearning({
      type: 'fragile-pattern',
      insight: '',
      file_paths: ['scripts/lib/x.mjs'],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/placeholder-insight/);
  });

  it('rejects a whitespace-only insight', () => {
    const result = classifyLearning({
      type: 'fragile-pattern',
      insight: '   ',
      file_paths: ['scripts/lib/x.mjs'],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/placeholder-insight/);
  });

  it('rejects a record with no insight field at all', () => {
    const result = classifyLearning({
      type: 'fragile-pattern',
      file_paths: ['scripts/lib/x.mjs'],
    });
    // The file-paths gate already passed; falls through to the insight gate
    // (missing insight coerces to '' — same placeholder-insight reason).
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/placeholder-insight/);
  });

  it('accepts a real, non-placeholder insight (baseline — gate is not over-broad)', () => {
    const result = classifyLearning({
      type: 'fragile-pattern',
      insight: 'Top-level zx imports cause fork-pool fragility.',
      file_paths: ['scripts/lib/x.mjs'],
    });
    expect(result.eligible).toBe(true);
  });

  it('is opt-in on minInsightChars — rejects a short-but-real insight when the floor is set', () => {
    const result = classifyLearning(
      { type: 'fragile-pattern', insight: 'short', file_paths: ['scripts/lib/x.mjs'] },
      { minInsightChars: 20 },
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/placeholder-insight/);
  });

  it('is inert when minInsightChars is omitted — the same short insight is accepted', () => {
    const result = classifyLearning({
      type: 'fragile-pattern',
      insight: 'short',
      file_paths: ['scripts/lib/x.mjs'],
    });
    expect(result.eligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// already-expired-at-proposal gate (#741.1c) — opt-in via `now`: a learning
// whose natural TTL (created_at + per-type TTL) already elapsed before
// proposal time is rejected honestly instead of silently floored back to
// life by the emitter's born-dead-expiry floor.
//
// FAKE-REGRESSION: if the `now`-gated expiry check were removed from
// eligibility.mjs, the "rejects an already-expired learning" test below would
// flip to `eligible: true` and go RED.
// ---------------------------------------------------------------------------

describe('classifyLearning — already-expired-at-proposal gate (#741.1c)', () => {
  it('rejects a learning whose natural TTL elapsed before the injected now', () => {
    // fragile-pattern TTL = 45 days. created_at 2026-01-01 + 45d = 2026-02-15.
    // now = 2026-03-01 sits well after that natural expiry.
    const result = classifyLearning(
      {
        type: 'fragile-pattern',
        insight: 'Real insight text describing a fragile pattern.',
        file_paths: ['scripts/lib/x.mjs'],
        created_at: '2026-01-01T00:00:00Z',
      },
      { now: Date.parse('2026-03-01T00:00:00Z') },
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/already-expired-at-proposal/);
  });

  it('does not false-reject when the natural TTL has NOT yet elapsed at the injected now', () => {
    // Same fixture, but now = 2026-02-01 sits BEFORE the 2026-02-15 natural expiry.
    const result = classifyLearning(
      {
        type: 'fragile-pattern',
        insight: 'Real insight text describing a fragile pattern.',
        file_paths: ['scripts/lib/x.mjs'],
        created_at: '2026-01-01T00:00:00Z',
      },
      { now: Date.parse('2026-02-01T00:00:00Z') },
    );
    expect(result.eligible).toBe(true);
  });

  it('is inert when now is omitted — an old created_at does not reject without an injected clock', () => {
    const result = classifyLearning({
      type: 'fragile-pattern',
      insight: 'Real insight text describing a fragile pattern.',
      file_paths: ['scripts/lib/x.mjs'],
      created_at: '2020-01-01T00:00:00Z',
    });
    expect(result.eligible).toBe(true);
  });
});

describe('classifyLearning — invalid records (defensive, never throws)', () => {
  it('rejects null without throwing', () => {
    const result = classifyLearning(null);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/invalid learning record/);
  });

  it('rejects an empty object (no type) without throwing', () => {
    const result = classifyLearning({});
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/invalid learning record/);
  });

  it('rejects a record with insight but no type without throwing', () => {
    const result = classifyLearning({ insight: 'x' });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/invalid learning record/);
  });
});

describe('CONVERT_TYPES', () => {
  it('contains the three real corpus types', () => {
    expect(CONVERT_TYPES.has('fragile-pattern')).toBe(true);
    expect(CONVERT_TYPES.has('recurring-issue')).toBe(true);
    expect(CONVERT_TYPES.has('anti-pattern')).toBe(true);
  });

  it('does not contain default-reject types', () => {
    expect(CONVERT_TYPES.has('proven-pattern')).toBe(false);
    expect(CONVERT_TYPES.has('effective-sizing')).toBe(false);
  });

  it('contains the three newly convertible types (#733)', () => {
    expect(CONVERT_TYPES.has('convention')).toBe(true);
    expect(CONVERT_TYPES.has('architecture-pattern')).toBe(true);
    expect(CONVERT_TYPES.has('design-pattern')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CONVERT_TYPES cross-module drift-guard (#733)
//
// CONVERT_TYPES is DERIVED from LEARNING_TYPE_REGISTRY's ruleConvertible flag
// (see eligibility.mjs module comment). Checked bidirectionally via membership
// iteration on each side — not by re-deriving CONVERT_TYPES wholesale and
// asserting set equality against itself.
// ---------------------------------------------------------------------------

describe('CONVERT_TYPES cross-module drift-guard (#733)', () => {
  it('every CONVERT_TYPES member has ruleConvertible:true in LEARNING_TYPE_REGISTRY', () => {
    // FALSIFICATION: adding a type to CONVERT_TYPES whose registry entry has
    // ruleConvertible:false (or is absent) would fail this
    const notConvertible = [...CONVERT_TYPES].filter(
      (type) => LEARNING_TYPE_REGISTRY[type]?.ruleConvertible !== true,
    );
    expect(notConvertible).toEqual([]);
  });

  it('every ruleConvertible:true registry entry is a CONVERT_TYPES member', () => {
    // FALSIFICATION: flipping a registry entry's ruleConvertible to true
    // without CONVERT_TYPES picking it up would fail this
    const missing = Object.entries(LEARNING_TYPE_REGISTRY)
      .filter(([, meta]) => meta.ruleConvertible)
      .map(([type]) => type)
      .filter((type) => !CONVERT_TYPES.has(type));
    expect(missing).toEqual([]);
  });

  it('has a bounded size (floor/ceiling; growing catalog, not shrinking)', () => {
    // FALSIFICATION: emptying CONVERT_TYPES would drop below the floor
    expect(CONVERT_TYPES.size).toBeGreaterThanOrEqual(6);
    expect(CONVERT_TYPES.size).toBeLessThanOrEqual(30);
  });
});

describe('filterEligible — partition', () => {
  it('partitions a mixed 4-item list into 1 eligible + 3 rejected', () => {
    const learnings = [
      { type: 'fragile-pattern', insight: 'Real insight text.', file_paths: ['scripts/lib/x.mjs'] }, // eligible
      { type: 'fragile-pattern' }, // reject: empty file_paths
      { type: 'effective-sizing', file_paths: ['a.mjs'] }, // reject: type
      null, // reject: invalid record
    ];
    const { eligible, rejected } = filterEligible(learnings);
    expect(eligible).toHaveLength(1);
    expect(rejected).toHaveLength(3);
  });

  it('returns rejected entries each carrying { learning, reason }', () => {
    const learnings = [
      { type: 'fragile-pattern', insight: 'Real insight text.', file_paths: ['scripts/lib/x.mjs'] },
      { type: 'fragile-pattern' },
      { type: 'effective-sizing', file_paths: ['a.mjs'] },
      null,
    ];
    const { rejected } = filterEligible(learnings);
    expect(rejected[0]).toEqual({
      learning: { type: 'fragile-pattern' },
      reason: expect.stringContaining('empty file_paths'),
    });
    expect(rejected[1]).toEqual({
      learning: { type: 'effective-sizing', file_paths: ['a.mjs'] },
      reason: expect.stringContaining('not in convert allow-list'),
    });
    expect(rejected[2]).toEqual({
      learning: null,
      reason: expect.stringContaining('invalid learning record'),
    });
  });

  it('forwards opts to classifyLearning for every record (the wiring engine.mjs relies on)', () => {
    // FAKE-REGRESSION: if filterEligible stopped forwarding `opts`, this
    // already-past-TTL record would fall back to eligible:true (now inert)
    // and this test would go RED.
    const learnings = [
      {
        type: 'fragile-pattern',
        insight: 'Real insight text describing a fragile pattern.',
        file_paths: ['scripts/lib/x.mjs'],
        created_at: '2026-01-01T00:00:00Z',
      },
    ];
    const { eligible, rejected } = filterEligible(learnings, {
      now: Date.parse('2026-03-01T00:00:00Z'),
    });
    expect(eligible).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/already-expired-at-proposal/);
  });
});

describe('filterEligible — committed-fixture regression lock', () => {
  it('partitions the deterministic fixture into exactly 2 eligible / 4 rejected with the right subjects and reasons', () => {
    const { eligible, rejected } = filterEligible(RECONCILE_FIXTURE);

    // 2 eligible: fragile-pattern+files and recurring-issue+files.
    expect(eligible).toHaveLength(2);
    expect(eligible.map((l) => l.subject)).toEqual(['eligible-frag', 'eligible-rec']);

    // 4 rejected, each carrying a { learning, reason } shape.
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect(r).toHaveProperty('learning');
      expect(typeof r.reason).toBe('string');
    }

    // The effective-sizing reject fires on the TYPE gate (even WITH files).
    const sizing = rejected.find((r) => r.learning && r.learning.subject === 'sizing');
    expect(sizing.reason).toMatch(/not in convert allow-list/);

    // The two no-file rejects fire on the empty-file_paths gate.
    const noFiles = rejected.filter(
      (r) => r.learning && (r.learning.subject === 'no-files' || r.learning.subject === 'anti-no-files'),
    );
    expect(noFiles).toHaveLength(2);
    for (const r of noFiles) {
      expect(r.reason).toMatch(/empty file_paths/);
    }
  });
});
