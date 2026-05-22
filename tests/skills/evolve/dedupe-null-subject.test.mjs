/**
 * Regression test for issue #284 — evolve atomic-rewrite dedupe collapses all
 * null-subject entries of a given type to a single survivor.
 *
 * Root cause: the dedupe key was `${type}::${subject}`, which collapses every
 * entry with `subject: null` (or missing subject) to a single bucket, keeping
 * only the highest-confidence one and silently discarding the rest.
 *
 * Fix (SKILL.md Phase 3.5 step 7 + Phase 4.4 step 4):
 *   Dedupe key = `${type}::${subject}` ONLY when subject is a non-empty string.
 *   Null/empty/missing subject entries are keyed by their unique `id` instead,
 *   ensuring they are NEVER collapsed.
 *
 * This file tests a reference implementation (`consolidateDuplicates`) that
 * mirrors the SKILL.md prose after the fix. It cannot exec LLM-executed prose
 * directly, so the function encodes the contract in pure JS.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Reference implementation — mirrors SKILL.md Phase 3.5 step 7 AFTER the fix.
//
// Dedupe rule:
//   - If subject is a non-empty string: key = `${type}::${subject}`
//     → keep the entry with highest confidence (last-write wins on tie)
//   - Otherwise (null / undefined / ''): key = entry.id
//     → always preserved individually (never collapsed)
// ---------------------------------------------------------------------------

function consolidateDuplicates(entries) {
  /** @type {Map<string, object>} */
  const buckets = new Map();

  for (const entry of entries) {
    const hasSubject =
      typeof entry.subject === 'string' && entry.subject.trim().length > 0;
    const key = hasSubject ? `${entry.type}::${entry.subject}` : entry.id;

    if (!buckets.has(key)) {
      buckets.set(key, entry);
    } else {
      const existing = buckets.get(key);
      if (entry.confidence > existing.confidence) {
        buckets.set(key, entry);
      }
    }
  }

  return Array.from(buckets.values());
}

// ---------------------------------------------------------------------------
// OLD (buggy) reference implementation — mirrors the pre-fix SKILL.md rule.
//
// Dedupe rule: key = `${type}::${subject}` unconditionally (null coerced to
// the string "null"), so all null-subject entries of the same type share a
// bucket and collapse to a single survivor.
// ---------------------------------------------------------------------------

function consolidateDuplicatesOld(entries) {
  /** @type {Map<string, object>} */
  const buckets = new Map();

  for (const entry of entries) {
    const key = `${entry.type}::${entry.subject}`; // subject null → "null"

    if (!buckets.has(key)) {
      buckets.set(key, entry);
    } else {
      const existing = buckets.get(key);
      if (entry.confidence > existing.confidence) {
        buckets.set(key, entry);
      }
    }
  }

  return Array.from(buckets.values());
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * Fixture layout:
 *   A) 3 × effective-pattern, subject: null,  distinct id, distinct insight
 *   B) 2 × recurring-issue,   subject: "xcodebuild-hang" (legitimate dupes)
 *   C) 1 × effective-pattern, subject: "parallel-wave-sizing" (named)
 *
 * Expected survivors (AFTER fix): 5
 *   - All 3 null-subject effective-pattern entries preserved individually
 *   - recurring-issue deduped to 1 (higher confidence wins)
 *   - named effective-pattern survives as-is
 *
 * Expected survivors (BEFORE fix / old rule): 3
 *   - 3 null-subject effective-pattern entries collapse to 1
 *   - recurring-issue deduped to 1
 *   - named effective-pattern survives
 */
const FIXTURE = [
  // A — null-subject effective-pattern entries (3)
  {
    id: 'aaa00000-0000-0000-0000-000000000001',
    type: 'effective-pattern',
    subject: null,
    insight: 'Parallel wave sizing reduces latency by 40%',
    confidence: 0.7,
  },
  {
    id: 'aaa00000-0000-0000-0000-000000000002',
    type: 'effective-pattern',
    subject: null,
    insight: 'Agent role specialization cuts wave-failures in half',
    confidence: 0.6,
  },
  {
    id: 'aaa00000-0000-0000-0000-000000000003',
    type: 'effective-pattern',
    subject: null,
    insight: 'Inter-wave architect gate catches 90% of type errors',
    confidence: 0.8,
  },
  // B — recurring-issue with named subject (2 dupes, higher confidence wins)
  {
    id: 'bbb00000-0000-0000-0000-000000000001',
    type: 'recurring-issue',
    subject: 'xcodebuild-hang',
    insight: 'xcodebuild hangs when parallel testing is ON',
    confidence: 0.5,
  },
  {
    id: 'bbb00000-0000-0000-0000-000000000002',
    type: 'recurring-issue',
    subject: 'xcodebuild-hang',
    insight: 'xcodebuild hangs when parallel testing is ON (confirmed x2)',
    confidence: 0.65,
  },
  // C — named effective-pattern (1)
  {
    id: 'ccc00000-0000-0000-0000-000000000001',
    type: 'effective-pattern',
    subject: 'parallel-wave-sizing',
    insight: '4 agents / wave is optimal for deep sessions',
    confidence: 0.75,
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('consolidateDuplicates — FIXED rule (null-subject safe)', () => {
  it('returns 5 survivors from the fixture (3 null-subject + 1 recurring-issue + 1 named)', () => {
    const result = consolidateDuplicates(FIXTURE);
    expect(result).toHaveLength(5);
  });

  it('preserves all 3 null-subject effective-pattern entries by id', () => {
    const result = consolidateDuplicates(FIXTURE);
    const nullSubjectIds = result
      .filter((e) => e.type === 'effective-pattern' && !e.subject)
      .map((e) => e.id)
      .sort();

    expect(nullSubjectIds).toEqual([
      'aaa00000-0000-0000-0000-000000000001',
      'aaa00000-0000-0000-0000-000000000002',
      'aaa00000-0000-0000-0000-000000000003',
    ]);
  });

  it('collapses the 2 recurring-issue "xcodebuild-hang" entries to 1 (higher confidence wins)', () => {
    const result = consolidateDuplicates(FIXTURE);
    const recurring = result.filter(
      (e) => e.type === 'recurring-issue' && e.subject === 'xcodebuild-hang',
    );
    expect(recurring).toHaveLength(1);
    expect(recurring[0].confidence).toBe(0.65);
  });

  it('preserves the named effective-pattern "parallel-wave-sizing"', () => {
    const result = consolidateDuplicates(FIXTURE);
    const named = result.filter(
      (e) => e.type === 'effective-pattern' && e.subject === 'parallel-wave-sizing',
    );
    expect(named).toHaveLength(1);
    expect(named[0].id).toBe('ccc00000-0000-0000-0000-000000000001');
  });

  it('treats empty-string subject as null-equivalent (keyed by id, not collapsed)', () => {
    const entries = [
      { id: 'x1', type: 'effective-pattern', subject: '', insight: 'A', confidence: 0.5 },
      { id: 'x2', type: 'effective-pattern', subject: '', insight: 'B', confidence: 0.7 },
    ];
    const result = consolidateDuplicates(entries);
    expect(result).toHaveLength(2); // both preserved
  });

  it('treats undefined subject as null-equivalent (keyed by id, not collapsed)', () => {
    const entries = [
      { id: 'y1', type: 'effective-pattern', insight: 'A', confidence: 0.5 },
      { id: 'y2', type: 'effective-pattern', insight: 'B', confidence: 0.6 },
    ];
    const result = consolidateDuplicates(entries);
    expect(result).toHaveLength(2); // both preserved
  });

  it('still dedupes entries with a proper non-empty subject string', () => {
    const entries = [
      { id: 'z1', type: 'fragile-file', subject: 'src/api.ts', confidence: 0.5 },
      { id: 'z2', type: 'fragile-file', subject: 'src/api.ts', confidence: 0.8 },
    ];
    const result = consolidateDuplicates(entries);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.8);
  });
});

describe('consolidateDuplicatesOld — NEGATIVE test proving OLD rule is broken', () => {
  it('wrongly collapses all 3 null-subject entries to 1, yielding only 3 survivors', () => {
    // OLD rule: null → "null" string → all 3 null-subject entries share
    // the bucket "effective-pattern::null" → only highest confidence (0.8)
    // survives.
    const result = consolidateDuplicatesOld(FIXTURE);
    expect(result).toHaveLength(3); // proves the bug
  });

  it('the single surviving null-subject entry has the highest confidence (0.8)', () => {
    const result = consolidateDuplicatesOld(FIXTURE);
    const nullSubjectEntries = result.filter(
      (e) => e.type === 'effective-pattern' && e.subject === null,
    );
    // OLD rule: exactly 1 survives (the one with confidence 0.8)
    expect(nullSubjectEntries).toHaveLength(1);
    expect(nullSubjectEntries[0].confidence).toBe(0.8);
  });

  it('the 2 insights with confidence 0.7 and 0.6 are silently discarded by old rule', () => {
    const result = consolidateDuplicatesOld(FIXTURE);
    const discardedInsights = result.filter(
      (e) =>
        e.type === 'effective-pattern' &&
        e.subject === null &&
        (e.confidence === 0.7 || e.confidence === 0.6),
    );
    // OLD rule: both are gone
    expect(discardedInsights).toHaveLength(0);
  });
});
