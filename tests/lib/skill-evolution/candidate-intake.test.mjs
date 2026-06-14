/**
 * candidate-intake.test.mjs — Unit tests for the #647 C2 candidate-intake
 * pure transform (`extractCandidates`).
 *
 * Covers:
 *   - Actionable learning → exactly 1 candidate with the full RepairCandidate shape.
 *   - Descriptive learnings (no verb / no path) → dropped.
 *   - Confidence-floor gate, non-finite confidence, expiry filter.
 *   - Determinism: identical input → identical id.
 *   - Drift-check error mapping (filesystem-fact, evidence 1.0).
 *   - Inert drift results (null / skipped / warnings-only) → 0 drift candidates.
 *   - Defensive handling of malformed learnings.
 */

import { describe, it, expect } from 'vitest';
import { extractCandidates } from '@lib/skill-evolution/candidate-intake.mjs';

const NOW = '2026-06-14T12:00:00.000Z';

/** A learning that passes every actionable filter (verb + repo path + live + confident). */
function actionableLearning(overrides = {}) {
  return {
    id: 'learn-1',
    subject: 'scripts/lib/foo.mjs',
    insight: 'Fix the stale default in scripts/lib/foo.mjs',
    confidence: 0.8,
    created_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('extractCandidates — /evolve learnings', () => {
  it('maps an actionable learning to exactly one candidate', () => {
    const result = extractCandidates({ learnings: [actionableLearning()], now: NOW });
    expect(result).toHaveLength(1);
  });

  it('emits a candidate with source evolve-learning and confidence evidence', () => {
    const [candidate] = extractCandidates({ learnings: [actionableLearning()], now: NOW });
    expect(candidate).toEqual(
      expect.objectContaining({
        schema_version: 1,
        source: 'evolve-learning',
        target_path: 'scripts/lib/foo.mjs',
        evidence: 0.8,
        evidence_kind: 'confidence',
        processed_at: null,
        superseded_by: null,
        created_at: NOW,
      }),
    );
  });

  it('drops a descriptive learning with no prescriptive verb', () => {
    const learning = actionableLearning({
      insight: 'The behaviour in scripts/lib/foo.mjs is stale and surprising',
    });
    expect(extractCandidates({ learnings: [learning], now: NOW })).toEqual([]);
  });

  it('drops a learning with a verb but no resolvable repo path', () => {
    const learning = actionableLearning({
      subject: 'general guidance',
      insight: 'Always remove the surprising behaviour from the system',
    });
    expect(extractCandidates({ learnings: [learning], now: NOW })).toEqual([]);
  });

  it('drops a learning below the evidence floor', () => {
    const learning = actionableLearning({ confidence: 0.4 });
    expect(extractCandidates({ learnings: [learning], evidenceFloor: 0.5, now: NOW })).toEqual([]);
  });

  it('drops a learning with non-finite confidence', () => {
    const learning = actionableLearning({ confidence: Number.NaN });
    expect(extractCandidates({ learnings: [learning], now: NOW })).toEqual([]);
  });

  it('drops a learning that has expired', () => {
    const learning = actionableLearning({ expires_at: '2026-06-13T00:00:00.000Z' });
    expect(extractCandidates({ learnings: [learning], now: NOW })).toEqual([]);
  });

  it('keeps a learning whose expiry is after now', () => {
    const learning = actionableLearning({ expires_at: '2026-06-15T00:00:00.000Z' });
    expect(extractCandidates({ learnings: [learning], now: NOW })).toHaveLength(1);
  });

  it('produces an identical id for identical input across two calls', () => {
    const [first] = extractCandidates({ learnings: [actionableLearning()], now: NOW });
    const [second] = extractCandidates({ learnings: [actionableLearning()], now: NOW });
    expect(first.id).toBe(second.id);
  });

  it('handles a learning missing id/subject/insight without throwing', () => {
    const malformed = { confidence: 0.9, created_at: NOW };
    expect(() => extractCandidates({ learnings: [malformed], now: NOW })).not.toThrow();
    expect(extractCandidates({ learnings: [malformed], now: NOW })).toEqual([]);
  });

  it('returns an empty array when learnings is absent', () => {
    expect(extractCandidates({ now: NOW })).toEqual([]);
  });
});

describe('extractCandidates — drift-check errors', () => {
  const driftResult = {
    status: 'fail',
    errors: [
      {
        check: 'command-count',
        file: 'CLAUDE.md',
        line: 142,
        message: 'narrative says 13 commands but actual is 11',
        command_count: { actual: 11 },
      },
    ],
    warnings: [{ check: 'something', file: 'README.md', message: 'a warning' }],
  };

  it('maps a single drift error to exactly one candidate', () => {
    expect(extractCandidates({ driftResult, now: NOW })).toHaveLength(1);
  });

  it('emits a drift candidate as a filesystem-fact with evidence 1.0', () => {
    const [candidate] = extractCandidates({ driftResult, now: NOW });
    expect(candidate).toEqual(
      expect.objectContaining({
        source: 'drift-check',
        evidence: 1.0,
        evidence_kind: 'filesystem-fact',
        target_path: 'CLAUDE.md',
        processed_at: null,
        superseded_by: null,
      }),
    );
  });

  it('ignores drift warnings (only errors become candidates)', () => {
    const result = extractCandidates({ driftResult, now: NOW });
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('drift-check');
  });

  it('returns no drift candidates when driftResult is null', () => {
    expect(extractCandidates({ driftResult: null, now: NOW })).toEqual([]);
  });

  it('returns no drift candidates when status is skipped', () => {
    const skipped = { status: 'skipped', errors: [{ check: 'command-count', file: 'CLAUDE.md', line: 1, message: 'm' }] };
    expect(extractCandidates({ driftResult: skipped, now: NOW })).toEqual([]);
  });

  it('returns no drift candidates when status is skipped-mode-off', () => {
    const off = { status: 'skipped-mode-off', errors: [{ check: 'command-count', file: 'CLAUDE.md', line: 1, message: 'm' }] };
    expect(extractCandidates({ driftResult: off, now: NOW })).toEqual([]);
  });

  it('drops a drift error with no file', () => {
    const noFile = { status: 'fail', errors: [{ check: 'command-count', line: 1, message: 'm' }] };
    expect(extractCandidates({ driftResult: noFile, now: NOW })).toEqual([]);
  });
});
