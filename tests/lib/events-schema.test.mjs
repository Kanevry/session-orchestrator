/**
 * tests/lib/events-schema.test.mjs
 *
 * Unit tests for scripts/lib/events-schema.mjs — the canonical events.jsonl
 * schema + naming-convention validator (Track A, issue #609 / epic #608).
 * Pure functions — no filesystem, no env juggling.
 */

import { describe, it, expect } from 'vitest';
import {
  isIso8601,
  validateEventRecord,
  ORCHESTRATOR_EVENT_RE,
} from '@lib/events-schema.mjs';

/** The orchestrator.* event names this codebase actually emits (post Track A/B). */
const EMITTED_ORCHESTRATOR_EVENTS = [
  'orchestrator.session.started',
  'orchestrator.session.ended',
  'orchestrator.session.stopped',
  'orchestrator.session.lock.acquired',
  'orchestrator.agent.stopped',
  'orchestrator.memory.propose_invoked',
  'orchestrator.wave.started',
  'orchestrator.wave.completed',
  'orchestrator.quality_gate.passed',
  'orchestrator.quality_gate.failed',
];

describe('isIso8601', () => {
  it('accepts an ISO-8601 UTC timestamp with milliseconds', () => {
    expect(isIso8601('2026-05-28T14:35:13.123Z')).toBe(true);
  });

  it('accepts an ISO-8601 UTC timestamp without milliseconds', () => {
    expect(isIso8601('2026-05-28T14:35:13Z')).toBe(true);
  });

  it('rejects a date-only string (no time, no Z)', () => {
    expect(isIso8601('2026-05-28')).toBe(false);
  });

  it('rejects a timestamp without the trailing Z', () => {
    expect(isIso8601('2026-05-28T14:35:13.123')).toBe(false);
  });

  it('rejects a non-string', () => {
    expect(isIso8601(1716900913000)).toBe(false);
  });

  it('rejects a regex-shaped string that is not a real date — Date.parse guard is load-bearing (#613)', () => {
    // "2026-13-45T99:99:99Z" matches the ISO_8601_RE shape (4-2-2 T 2:2:2 Z) but
    // is an impossible calendar instant (month 13, day 45, 99h99m99s). isIso8601
    // chains ISO_8601_RE.test(value) AND !Number.isNaN(Date.parse(value)). If the
    // second guard were removed (dead-code), this would WRONGLY return true.
    const impossible = '2026-13-45T99:99:99Z';
    // Premise check — confirm the input truly exercises the Date.parse branch:
    // Date.parse (the exact dependency the guard calls) yields NaN for this value.
    expect(Number.isNaN(Date.parse(impossible))).toBe(true);
    // Load-bearing assertion — must be rejected despite passing the regex shape.
    expect(isIso8601(impossible)).toBe(false);
  });
});

describe('ORCHESTRATOR_EVENT_RE', () => {
  it('matches every orchestrator.* event the codebase emits', () => {
    const nonMatching = EMITTED_ORCHESTRATOR_EVENTS.filter((e) => !ORCHESTRATOR_EVENT_RE.test(e));
    expect(nonMatching).toEqual([]);
  });

  it('matches a four-segment name', () => {
    expect(ORCHESTRATOR_EVENT_RE.test('orchestrator.session.lock.acquired')).toBe(true);
  });

  it('allows underscores within a segment', () => {
    expect(ORCHESTRATOR_EVENT_RE.test('orchestrator.quality_gate.passed')).toBe(true);
  });

  it('rejects a two-segment name (domain without verb)', () => {
    expect(ORCHESTRATOR_EVENT_RE.test('orchestrator.session')).toBe(false);
  });

  it('rejects uppercase segments', () => {
    expect(ORCHESTRATOR_EVENT_RE.test('orchestrator.Session.Stopped')).toBe(false);
  });
});

describe('validateEventRecord — valid records', () => {
  it('accepts a canonical orchestrator record', () => {
    const result = validateEventRecord({
      timestamp: '2026-05-28T14:35:13.123Z',
      event: 'orchestrator.session.ended',
      session_id: 'sess-1',
      reason: 'clear',
      duration_ms: 4200,
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('accepts a non-orchestrator (third-party) dotted event as-is', () => {
    const result = validateEventRecord({
      timestamp: '2026-05-28T14:35:13Z',
      event: 'tmux-layout.invoked',
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('accepts a legacy bare event name (non-orchestrator namespace)', () => {
    const result = validateEventRecord({
      timestamp: '2026-05-28T14:35:13Z',
      event: 'grounding_injected',
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });
});

describe('validateEventRecord — invalid records', () => {
  it('rejects a record missing the timestamp', () => {
    const result = validateEventRecord({ event: 'orchestrator.session.ended' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('timestamp must be an ISO-8601 UTC string ending in Z');
  });

  it('rejects a non-ISO timestamp', () => {
    const result = validateEventRecord({ timestamp: '2026-05-28', event: 'orchestrator.session.ended' });
    expect(result.valid).toBe(false);
  });

  it('rejects an empty event string', () => {
    const result = validateEventRecord({ timestamp: '2026-05-28T14:35:13Z', event: '' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('event must be a non-empty string');
  });

  it('rejects a malformed orchestrator-domain event name', () => {
    const result = validateEventRecord({
      timestamp: '2026-05-28T14:35:13Z',
      event: 'orchestrator.Session.Stopped',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('orchestrator.<domain>.<verb>'))).toBe(true);
  });

  it('rejects a two-segment orchestrator event (no verb)', () => {
    const result = validateEventRecord({
      timestamp: '2026-05-28T14:35:13Z',
      event: 'orchestrator.session',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects null', () => {
    expect(validateEventRecord(null)).toEqual({ valid: false, errors: ['record must be a non-array object'] });
  });

  it('rejects an array', () => {
    expect(validateEventRecord([])).toEqual({ valid: false, errors: ['record must be a non-array object'] });
  });

  it('rejects a string', () => {
    expect(validateEventRecord('orchestrator.session.ended')).toEqual({
      valid: false,
      errors: ['record must be a non-array object'],
    });
  });
});

describe('validateEventRecord — #773 orchestrator.handover.gated', () => {
  it('accepts a handover.gated record carrying the full 8-field payload with path fail_open', () => {
    const result = validateEventRecord({
      timestamp: '2026-07-08T14:35:13.123Z',
      event: 'orchestrator.handover.gated',
      candidates_total: 5,
      auto_carry: 2,
      asked: 3,
      dropped: 0,
      questions_asked: 3,
      questions_answered: 2,
      questions_deferred: 1,
      path: 'fail_open',
    });
    // The dotted name is a well-formed orchestrator.<domain>.<verb>, and the
    // extra payload fields pass through untouched → valid with no errors.
    expect(result).toEqual({ valid: true, errors: [] });
  });
});
