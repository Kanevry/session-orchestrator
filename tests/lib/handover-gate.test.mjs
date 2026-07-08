/**
 * handover-gate.test.mjs — Unit tests for scripts/lib/handover-gate.mjs (#769)
 *
 * Covers:
 *   normalizeCandidate — pure coercion of a raw carryover-candidate record:
 *     - full happy-path normalization (priority-label stripping, numeric-string
 *       originIssue coercion, sourcePhase→bucket inference)
 *     - originIssue coercion table (numeric string / number / float-string /
 *       non-numeric / negative / missing)
 *     - priority coercion table (label-stripping, invalid → null, whitespace)
 *     - sourcePhase → bucket inference table (1.2/1.3/1.4/1.6/unknown/absent)
 *     - explicit-bucket-wins vs explicit-invalid-bucket-falls-back-to-inference
 *     - malformed detection (missing / whitespace-only / non-string task)
 *     - non-object raw input never throws, treated as an empty record
 *
 *   routeCandidates — pure classification into { autoCarry, ask }:
 *     - routing matrix (each autoCarry/ask condition, individually and combined)
 *     - malformed precedence over every autoCarry condition (explicit)
 *     - empty / undefined / non-array input → { autoCarry: [], ask: [] }, never throws
 *     - ubiquitous invariant: every candidate lands in exactly one bucket (no drops)
 */

import { describe, it, expect } from 'vitest';
import { normalizeCandidate, routeCandidates } from '@lib/handover-gate.mjs';

// ---------------------------------------------------------------------------
// normalizeCandidate — full happy-path shape
// ---------------------------------------------------------------------------

describe('normalizeCandidate — full happy-path normalization', () => {
  it('normalizes a fully-specified candidate with label-stripped priority and numeric-string origin issue', () => {
    expect(
      normalizeCandidate({
        task: 'Fix the flaky test',
        sourcePhase: '1.2',
        originIssue: '769',
        priority: 'PRIORITY:High',
      })
    ).toEqual({
      task: 'Fix the flaky test',
      sourcePhase: '1.2',
      originIssue: 769,
      priority: 'high',
      bucket: 'partially-done',
    });
  });

  it('does not set a malformed key at all on a well-formed candidate', () => {
    const result = normalizeCandidate({ task: 'x' });
    expect(Object.hasOwn(result, 'malformed')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeCandidate — originIssue coercion table
// ---------------------------------------------------------------------------

describe('normalizeCandidate — originIssue coercion', () => {
  it.each([
    ['769', 769],
    [769, 769],
    ['12abc', null],
    ['769.5', null],
    ['-5', -5],
    [null, null],
    [undefined, null],
    ['', null],
  ])('coerces originIssue %j to %j', (input, expected) => {
    expect(normalizeCandidate({ task: 'x', originIssue: input }).originIssue).toBe(expected);
  });

  it('coerces a fractional number originIssue (769.5) to null, matching the equivalent fractional string', () => {
    expect(normalizeCandidate({ task: 'x', originIssue: 769.5 }).originIssue).toBe(null);
  });

  it('coerces a zero number originIssue to 0 (a genuine non-null value, not "no origin")', () => {
    expect(normalizeCandidate({ task: 'x', originIssue: 0 }).originIssue).toBe(0);
  });

  it('coerces a zero string originIssue ("0") to 0 (a genuine non-null value, not "no origin")', () => {
    expect(normalizeCandidate({ task: 'x', originIssue: '0' }).originIssue).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// normalizeCandidate — priority coercion table
// ---------------------------------------------------------------------------

describe('normalizeCandidate — priority coercion', () => {
  it.each([
    ['PRIORITY:High', 'high'],
    ['critical', 'critical'],
    ['urgent', null],
    [null, null],
    [undefined, null],
    ['  Low  ', 'low'],
  ])('coerces priority %j to %j', (input, expected) => {
    expect(normalizeCandidate({ task: 'x', priority: input }).priority).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// normalizeCandidate — sourcePhase → bucket inference
// ---------------------------------------------------------------------------

describe('normalizeCandidate — sourcePhase-based bucket inference (no explicit bucket)', () => {
  it.each([
    ['1.2', 'partially-done'],
    ['1.3', 'not-started'],
    ['1.4', 'emergent'],
    ['1.6', 'spiral-failed'],
    ['9.9', 'not-started'],
    ['', 'not-started'],
  ])('infers bucket %j from sourcePhase %j', (sourcePhase, expectedBucket) => {
    expect(normalizeCandidate({ task: 'x', sourcePhase }).bucket).toBe(expectedBucket);
  });
});

describe('normalizeCandidate — explicit bucket vs sourcePhase inference precedence', () => {
  it('an explicit valid bucket overrides sourcePhase inference', () => {
    expect(normalizeCandidate({ task: 'x', sourcePhase: '1.2', bucket: 'emergent' }).bucket).toBe(
      'emergent'
    );
  });

  it('falls back to sourcePhase inference when the explicit bucket is invalid', () => {
    expect(normalizeCandidate({ task: 'x', sourcePhase: '1.3', bucket: 'bogus' }).bucket).toBe(
      'not-started'
    );
  });

  it('falls back to the neutral default when both explicit bucket and sourcePhase are unusable', () => {
    expect(normalizeCandidate({ task: 'x', bucket: 'bogus' }).bucket).toBe('not-started');
  });

  it('lowercases an explicit uppercase bucket ("EMERGENT") rather than rejecting it', () => {
    expect(normalizeCandidate({ task: 'x', bucket: 'EMERGENT' }).bucket).toBe('emergent');
  });
});

// ---------------------------------------------------------------------------
// normalizeCandidate — malformed detection
// ---------------------------------------------------------------------------

describe('normalizeCandidate — malformed detection', () => {
  it('marks a candidate with a missing task field as malformed', () => {
    expect(normalizeCandidate({ sourcePhase: '1.2', originIssue: 1 })).toEqual({
      task: '',
      sourcePhase: '1.2',
      originIssue: 1,
      priority: null,
      bucket: 'partially-done',
      malformed: true,
    });
  });

  it('marks a candidate with a whitespace-only task as malformed', () => {
    expect(normalizeCandidate({ task: '   ' }).malformed).toBe(true);
  });

  it('blanks the task text on a whitespace-only task rather than keeping the whitespace', () => {
    expect(normalizeCandidate({ task: '   ' }).task).toBe('');
  });

  it('marks a candidate with a non-string task as malformed', () => {
    expect(normalizeCandidate({ task: 123 }).malformed).toBe(true);
  });

  it('marks a candidate with an empty string task as malformed', () => {
    expect(normalizeCandidate({ task: '' }).malformed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// normalizeCandidate — non-object raw input
// ---------------------------------------------------------------------------

describe('normalizeCandidate — non-object raw input never throws', () => {
  it.each([[null], [undefined], [42], ['just a string'], [true]])(
    'does not throw for raw input %j',
    (raw) => {
      expect(() => normalizeCandidate(raw)).not.toThrow();
    }
  );

  it('produces the fully-defaulted malformed shape for null input', () => {
    expect(normalizeCandidate(null)).toEqual({
      task: '',
      sourcePhase: '',
      originIssue: null,
      priority: null,
      bucket: 'not-started',
      malformed: true,
    });
  });

  it('produces the fully-defaulted malformed shape for a bare string input', () => {
    expect(normalizeCandidate('not a record')).toEqual({
      task: '',
      sourcePhase: '',
      originIssue: null,
      priority: null,
      bucket: 'not-started',
      malformed: true,
    });
  });
});

// ---------------------------------------------------------------------------
// routeCandidates — routing matrix
// ---------------------------------------------------------------------------

describe('routeCandidates — routing matrix', () => {
  it.each([
    [
      'priority critical alone routes to autoCarry',
      { task: 'a', priority: 'critical', originIssue: 42, bucket: 'not-started' },
      1,
      0,
    ],
    [
      'priority high alone routes to autoCarry',
      { task: 'a', priority: 'high', originIssue: 42, bucket: 'partially-done' },
      1,
      0,
    ],
    [
      'bucket spiral-failed overrides a medium priority into autoCarry',
      { task: 'a', priority: 'medium', originIssue: 42, bucket: 'spiral-failed' },
      1,
      0,
    ],
    [
      'originIssue null alone routes to autoCarry regardless of priority/bucket',
      { task: 'a', priority: 'low', originIssue: null, bucket: 'partially-done' },
      1,
      0,
    ],
    [
      'medium priority + origin issue + not-started bucket routes to ask',
      { task: 'a', priority: 'medium', originIssue: 42, bucket: 'not-started' },
      0,
      1,
    ],
    [
      'low priority + origin issue + partially-done bucket routes to ask',
      { task: 'a', priority: 'low', originIssue: 42, bucket: 'partially-done' },
      0,
      1,
    ],
    [
      'null priority + origin issue + emergent bucket routes to ask',
      { task: 'a', priority: null, originIssue: 42, bucket: 'emergent' },
      0,
      1,
    ],
  ])('%s', (_name, candidate, expectedAutoCarryLength, expectedAskLength) => {
    const result = routeCandidates([candidate]);
    expect(result.autoCarry).toHaveLength(expectedAutoCarryLength);
    expect(result.ask).toHaveLength(expectedAskLength);
  });

  it('routes a zero originIssue (0) to ask, not autoCarry — the no-origin check is strict === null', () => {
    const result = routeCandidates([
      { task: 'a', priority: 'low', originIssue: 0, bucket: 'not-started' },
    ]);
    expect(result.autoCarry).toHaveLength(0);
    expect(result.ask).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// routeCandidates — malformed precedence (explicit)
// ---------------------------------------------------------------------------

describe('routeCandidates — malformed takes precedence over every autoCarry condition', () => {
  it('routes a task-less critical/null-origin/spiral-failed record to ask with malformed:true', () => {
    const result = routeCandidates([
      { priority: 'critical', originIssue: null, bucket: 'spiral-failed' },
    ]);
    expect(result.autoCarry).toEqual([]);
    expect(result.ask).toEqual([
      {
        task: '',
        sourcePhase: '',
        originIssue: null,
        priority: 'critical',
        bucket: 'spiral-failed',
        malformed: true,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// routeCandidates — empty / undefined / non-array input
// ---------------------------------------------------------------------------

describe('routeCandidates — empty and non-array input', () => {
  it('returns empty buckets for an empty array', () => {
    expect(routeCandidates([])).toEqual({ autoCarry: [], ask: [] });
  });

  it('returns empty buckets for undefined', () => {
    expect(routeCandidates(undefined)).toEqual({ autoCarry: [], ask: [] });
  });

  it('returns empty buckets for null', () => {
    expect(routeCandidates(null)).toEqual({ autoCarry: [], ask: [] });
  });

  it('returns empty buckets for a non-array string', () => {
    expect(routeCandidates('not-an-array')).toEqual({ autoCarry: [], ask: [] });
  });

  it('returns empty buckets for a plain object', () => {
    expect(routeCandidates({ task: 'x' })).toEqual({ autoCarry: [], ask: [] });
  });

  it.each([[undefined], [null], [{}], [42]])('never throws for input %j', (input) => {
    expect(() => routeCandidates(input)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// routeCandidates — ubiquitous invariant: no candidate is ever dropped
// ---------------------------------------------------------------------------

describe('routeCandidates — ubiquitous invariant (no drops)', () => {
  it('routes every candidate in a mixed batch into exactly one of autoCarry/ask', () => {
    const candidates = [
      { task: 'a', priority: 'critical', originIssue: 1, bucket: 'not-started' }, // autoCarry
      { task: 'b', priority: 'medium', originIssue: 2, bucket: 'not-started' }, // ask
      { priority: 'low', originIssue: 3, bucket: 'partially-done' }, // malformed → ask
      { task: 'd', priority: 'low', originIssue: null, bucket: 'emergent' }, // autoCarry
      { task: 'e', priority: 'high', originIssue: 5, bucket: 'partially-done' }, // autoCarry
      { task: 'f', priority: null, originIssue: 6, bucket: 'emergent' }, // ask
    ];
    const result = routeCandidates(candidates);
    expect(result.autoCarry).toHaveLength(3);
    expect(result.ask).toHaveLength(3);
    expect(result.autoCarry.length + result.ask.length).toBe(6);
  });

  it('does not throw and drops nothing when non-object elements are mixed in with valid candidates', () => {
    const candidates = [
      { task: 'a', priority: 'low', originIssue: 5, bucket: 'not-started' },
      null,
      42,
      'garbage',
      { task: 'b', priority: 'critical' },
    ];
    let result;
    expect(() => {
      result = routeCandidates(candidates);
    }).not.toThrow();
    expect(result.autoCarry.length + result.ask.length).toBe(5);
  });
});
