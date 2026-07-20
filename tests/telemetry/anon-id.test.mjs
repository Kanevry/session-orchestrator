/**
 * tests/telemetry/anon-id.test.mjs
 *
 * Unit tests for the rotating anonymous ID (Epic #841, S2 / GitLab #843):
 *   scripts/lib/telemetry/anon-id.mjs — newAnonId / isExpired / ensureAnonId
 *
 * Privacy-load-bearing invariants under test:
 *   - IDs are random UUIDs (v4), never machine-derived (two calls differ)
 *   - 90-day rotation boundary is exact (89d unchanged, 90d unchanged, 91d rotates)
 *   - unparsable created_at ⇒ rotate (fail-safe: unverifiable age is not trusted)
 *   - the input record is never mutated (a new object is always returned)
 *
 * All `now` values are passed in explicitly (the module reads no clock), so these
 * tests are deterministic and cannot time-bomb.
 */

import { describe, it, expect } from 'vitest';
import {
  ANON_ID_MAX_AGE_DAYS,
  newAnonId,
  isExpired,
  ensureAnonId,
} from '../../scripts/lib/telemetry/anon-id.mjs';

/** RFC 4122 v4 UUID shape. */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = '2026-07-20T00:00:00.000Z';
/** Build an ISO timestamp `days` before NOW (test-data setup, not a mirrored assertion). */
function daysBeforeNow(days) {
  return new Date(Date.parse(NOW) - days * MS_PER_DAY).toISOString();
}

describe('anon-id constants', () => {
  it('rotates after 90 days', () => {
    expect(ANON_ID_MAX_AGE_DAYS).toBe(90);
  });
});

describe('newAnonId', () => {
  it('returns a v4 UUID', () => {
    expect(newAnonId()).toMatch(UUID_V4_RE);
  });

  it('returns a different UUID on each call (not machine-derived / not constant)', () => {
    expect(newAnonId()).not.toBe(newAnonId());
  });
});

describe('isExpired', () => {
  it('is false at 89 days old (inside the window)', () => {
    expect(isExpired(daysBeforeNow(89), NOW)).toBe(false);
  });

  it('is false at exactly 90 days old (boundary is not-expired)', () => {
    expect(isExpired(daysBeforeNow(90), NOW)).toBe(false);
  });

  it('is true at 91 days old (past the window)', () => {
    expect(isExpired(daysBeforeNow(91), NOW)).toBe(true);
  });

  it('is true for an unparsable created_at (fail-safe rotate)', () => {
    expect(isExpired('not-a-date', NOW)).toBe(true);
  });

  it('is true for a missing created_at', () => {
    expect(isExpired(undefined, NOW)).toBe(true);
  });

  it('accepts an epoch-ms number for now', () => {
    expect(isExpired(daysBeforeNow(10), Date.parse(NOW))).toBe(false);
  });

  it('honors a custom maxAgeDays', () => {
    expect(isExpired(daysBeforeNow(10), NOW, 5)).toBe(true);
  });
});

describe('ensureAnonId', () => {
  it('creates a fresh ID when the record has none', () => {
    const result = ensureAnonId({}, { now: NOW });
    expect(result.created).toBe(true);
    expect(result.rotated).toBe(false);
    expect(result.anon_id).toMatch(UUID_V4_RE);
    expect(result.record.anon_id).toBe(result.anon_id);
    expect(result.record.anon_id_created_at).toBe(NOW);
  });

  it('creates a fresh ID when anon_id is null', () => {
    const result = ensureAnonId({ anon_id: null }, { now: NOW });
    expect(result.created).toBe(true);
    expect(result.rotated).toBe(false);
    expect(result.anon_id).toMatch(UUID_V4_RE);
  });

  it('leaves a fresh ID unchanged', () => {
    const input = { anon_id: 'existing-id-abc', anon_id_created_at: daysBeforeNow(10) };
    const result = ensureAnonId(input, { now: NOW });
    expect(result.created).toBe(false);
    expect(result.rotated).toBe(false);
    expect(result.anon_id).toBe('existing-id-abc');
    expect(result.record.anon_id).toBe('existing-id-abc');
    expect(result.record.anon_id_created_at).toBe(daysBeforeNow(10));
  });

  it('rotates an ID older than 90 days and discards the old one', () => {
    const input = { anon_id: 'old-id-xyz', anon_id_created_at: daysBeforeNow(91) };
    const result = ensureAnonId(input, { now: NOW });
    expect(result.rotated).toBe(true);
    expect(result.created).toBe(false);
    expect(result.anon_id).toMatch(UUID_V4_RE);
    expect(result.anon_id).not.toBe('old-id-xyz');
    expect(result.record.anon_id).not.toBe('old-id-xyz');
    expect(result.record.anon_id_created_at).toBe(NOW);
  });

  it('rotates an ID whose created_at is unparsable', () => {
    const input = { anon_id: 'orphan-id', anon_id_created_at: 'garbage' };
    const result = ensureAnonId(input, { now: NOW });
    expect(result.rotated).toBe(true);
    expect(result.anon_id).not.toBe('orphan-id');
  });

  it('does not mutate the input record', () => {
    const input = { anon_id: 'old-id-xyz', anon_id_created_at: daysBeforeNow(200) };
    ensureAnonId(input, { now: NOW });
    expect(input.anon_id).toBe('old-id-xyz');
    expect(input.anon_id_created_at).toBe(daysBeforeNow(200));
  });

  it('returns a new object, not the same reference, on the unchanged path', () => {
    const input = { anon_id: 'existing-id-abc', anon_id_created_at: daysBeforeNow(1) };
    const result = ensureAnonId(input, { now: NOW });
    expect(result.record).not.toBe(input);
    expect(result.record).toEqual(input);
  });
});
