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
import { RECONCILE_FIXTURE } from './_fixtures.mjs';

describe('classifyLearning — eligible records', () => {
  it('accepts a fragile-pattern with a non-empty file_paths[]', () => {
    const result = classifyLearning({
      type: 'fragile-pattern',
      file_paths: ['scripts/lib/x.mjs'],
    });
    expect(result.eligible).toBe(true);
  });

  it('accepts a recurring-issue with file_paths[]', () => {
    const result = classifyLearning({
      type: 'recurring-issue',
      file_paths: ['scripts/lib/y.mjs'],
    });
    expect(result.eligible).toBe(true);
  });

  it('accepts an anti-pattern with file_paths[]', () => {
    const result = classifyLearning({
      type: 'anti-pattern',
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
});

describe('filterEligible — partition', () => {
  it('partitions a mixed 4-item list into 1 eligible + 3 rejected', () => {
    const learnings = [
      { type: 'fragile-pattern', file_paths: ['scripts/lib/x.mjs'] }, // eligible
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
      { type: 'fragile-pattern', file_paths: ['scripts/lib/x.mjs'] },
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
