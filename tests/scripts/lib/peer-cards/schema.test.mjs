/**
 * tests/scripts/lib/peer-cards/schema.test.mjs — Unit tests for #503 peer-card schema.
 *
 * Covers validatePeerCardFrontmatter (happy + error paths), computeStalenessDays
 * (whole-day arithmetic + invalid input), STALENESS_THRESHOLD_DAYS constant, and
 * the read-only PEER_CARD_TARGETS frozen array.
 */

import { describe, it, expect } from 'vitest';

import {
  validatePeerCardFrontmatter,
  computeStalenessDays,
  isStalePeerCard,
  STALENESS_THRESHOLD_DAYS,
  PEER_CARD_TARGETS,
  isValidPeerCardId,
  isValidPeerCardTarget,
  isValidIsoTimestamp,
} from '@lib/peer-cards/schema.mjs';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const VALID_USER_FM = {
  id: 'op-cardguy',
  type: 'peer-card',
  target: 'user',
  created: '2026-05-01T10:00:00Z',
  updated: '2026-05-23T12:00:00Z',
  source_sessions: ['session-2026-05-23-deep'],
};

const VALID_AGENT_FM = {
  id: 'self-orchestrator',
  type: 'peer-card',
  target: 'agent',
  created: '2026-05-01T10:00:00Z',
  updated: '2026-05-23T12:00:00Z',
  source_sessions: [],
};

// ─── validatePeerCardFrontmatter — happy path ────────────────────────────────

describe('validatePeerCardFrontmatter — happy path', () => {
  it('accepts a complete valid user peer-card frontmatter', () => {
    const result = validatePeerCardFrontmatter(VALID_USER_FM);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(VALID_USER_FM);
  });

  it('accepts a complete valid agent peer-card frontmatter', () => {
    const result = validatePeerCardFrontmatter(VALID_AGENT_FM);
    expect(result.ok).toBe(true);
    expect(result.data.target).toBe('agent');
    expect(result.data.source_sessions).toEqual([]);
  });

  it('defaults source_sessions to [] when absent', () => {
    const fm = { ...VALID_USER_FM };
    delete fm.source_sessions;
    const result = validatePeerCardFrontmatter(fm);
    expect(result.ok).toBe(true);
    expect(result.data.source_sessions).toEqual([]);
  });

  it('preserves passthrough fields not in the canonical schema', () => {
    const fm = { ...VALID_USER_FM, custom_field: 'hello', another: 42 };
    const result = validatePeerCardFrontmatter(fm);
    expect(result.ok).toBe(true);
    expect(result.data.custom_field).toBe('hello');
    expect(result.data.another).toBe(42);
  });

  it('accepts optional title within length bounds', () => {
    const fm = { ...VALID_USER_FM, title: 'Operator preferences' };
    const result = validatePeerCardFrontmatter(fm);
    expect(result.ok).toBe(true);
    expect(result.data.title).toBe('Operator preferences');
  });

  it('accepts optional tags as a string array', () => {
    const fm = { ...VALID_USER_FM, tags: ['preferences', 'tone'] };
    const result = validatePeerCardFrontmatter(fm);
    expect(result.ok).toBe(true);
    expect(result.data.tags).toEqual(['preferences', 'tone']);
  });
});

// ─── validatePeerCardFrontmatter — error paths ───────────────────────────────

describe('validatePeerCardFrontmatter — error paths', () => {
  it('rejects when input is null', () => {
    const result = validatePeerCardFrontmatter(null);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['<root>: frontmatter must be a plain object']);
  });

  it('rejects when input is an array', () => {
    const result = validatePeerCardFrontmatter([VALID_USER_FM]);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['<root>: frontmatter must be a plain object']);
  });

  it('rejects missing id with id-related error', () => {
    const fm = { ...VALID_USER_FM };
    delete fm.id;
    const result = validatePeerCardFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('id: required field missing');
  });

  it('rejects non-kebab-case id', () => {
    const fm = { ...VALID_USER_FM, id: 'NotKebabCase' };
    const result = validatePeerCardFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.startsWith('id:'))).toBe(true);
  });

  it('rejects too-short id (1 char)', () => {
    const fm = { ...VALID_USER_FM, id: 'a' };
    const result = validatePeerCardFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.startsWith('id:'))).toBe(true);
  });

  it('rejects wrong type literal (e.g. "note")', () => {
    const fm = { ...VALID_USER_FM, type: 'note' };
    const result = validatePeerCardFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('type: must be literal "peer-card" (got "note")');
  });

  it('rejects missing type', () => {
    const fm = { ...VALID_USER_FM };
    delete fm.type;
    const result = validatePeerCardFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('type: required field missing');
  });

  it('rejects invalid target (not user or agent)', () => {
    const fm = { ...VALID_USER_FM, target: 'system' };
    const result = validatePeerCardFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.startsWith('target:'))).toBe(true);
  });

  it('rejects missing target', () => {
    const fm = { ...VALID_USER_FM };
    delete fm.target;
    const result = validatePeerCardFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('target: required field missing');
  });

  it('rejects malformed created (not ISO 8601)', () => {
    const fm = { ...VALID_USER_FM, created: '2026-05-01' };
    const result = validatePeerCardFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.startsWith('created:'))).toBe(true);
  });

  it('rejects malformed updated (offset instead of Z)', () => {
    const fm = { ...VALID_USER_FM, updated: '2026-05-23T12:00:00+02:00' };
    const result = validatePeerCardFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.startsWith('updated:'))).toBe(true);
  });

  it('rejects missing created and updated separately', () => {
    const fm = { ...VALID_USER_FM };
    delete fm.created;
    delete fm.updated;
    const result = validatePeerCardFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('created: required field missing');
    expect(result.errors).toContain('updated: required field missing');
  });

  it('rejects source_sessions that is not a string array', () => {
    const fm = { ...VALID_USER_FM, source_sessions: [1, 2, 3] };
    const result = validatePeerCardFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('source_sessions: must be an array of strings');
  });

  it('rejects title that is not a string', () => {
    const fm = { ...VALID_USER_FM, title: 42 };
    const result = validatePeerCardFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('title: must be a string when provided');
  });

  it('rejects title exceeding max length (201 chars)', () => {
    const fm = { ...VALID_USER_FM, title: 'x'.repeat(201) };
    const result = validatePeerCardFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.startsWith('title:'))).toBe(true);
  });

  it('rejects tags that is not a string array', () => {
    const fm = { ...VALID_USER_FM, tags: 'not-an-array' };
    const result = validatePeerCardFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('tags: must be an array of strings when provided');
  });

  it('aggregates multiple errors (missing id + wrong type)', () => {
    const fm = { type: 'note', target: 'user', created: 'bad', updated: 'bad' };
    const result = validatePeerCardFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });
});

// ─── computeStalenessDays ────────────────────────────────────────────────────

describe('computeStalenessDays', () => {
  it('returns exactly 30 for a 30-day delta', () => {
    const updated = '2026-04-23T12:00:00Z';
    const now = new Date('2026-05-23T12:00:00Z');
    expect(computeStalenessDays(updated, now)).toBe(30);
  });

  it('returns 0 for the same instant', () => {
    const now = new Date('2026-05-23T12:00:00Z');
    expect(computeStalenessDays('2026-05-23T12:00:00Z', now)).toBe(0);
  });

  it('returns 1 for a 29-hour gap (floors toward zero)', () => {
    const updated = '2026-05-22T07:00:00Z';
    const now = new Date('2026-05-23T12:00:00Z'); // 29h later
    expect(computeStalenessDays(updated, now)).toBe(1);
  });

  it('returns Infinity for an unparseable timestamp', () => {
    expect(computeStalenessDays('not-a-date', new Date('2026-05-23T12:00:00Z'))).toBe(Infinity);
  });

  it('returns Infinity when updatedIso is not a string', () => {
    expect(computeStalenessDays(null, new Date('2026-05-23T12:00:00Z'))).toBe(Infinity);
    expect(computeStalenessDays(undefined, new Date('2026-05-23T12:00:00Z'))).toBe(Infinity);
    expect(computeStalenessDays(12345, new Date('2026-05-23T12:00:00Z'))).toBe(Infinity);
  });

  it('returns Infinity for a non-finite now value', () => {
    expect(computeStalenessDays('2026-05-23T12:00:00Z', Number.NaN)).toBe(Infinity);
  });
});

// ─── isStalePeerCard ─────────────────────────────────────────────────────────

describe('isStalePeerCard', () => {
  it('returns true for a card updated 31 days ago', () => {
    const updated = '2026-04-22T12:00:00Z';
    const now = new Date('2026-05-23T12:00:00Z'); // 31 days later
    expect(isStalePeerCard(updated, now)).toBe(true);
  });

  it('returns false for a card updated exactly 30 days ago (boundary)', () => {
    // STALENESS_THRESHOLD_DAYS=30 → stale only when > 30
    const updated = '2026-04-23T12:00:00Z';
    const now = new Date('2026-05-23T12:00:00Z');
    expect(isStalePeerCard(updated, now)).toBe(false);
  });

  it('returns true for an unparseable timestamp (Infinity > 30)', () => {
    expect(isStalePeerCard('not-a-date', new Date('2026-05-23T12:00:00Z'))).toBe(true);
  });
});

// ─── Constants ───────────────────────────────────────────────────────────────

describe('STALENESS_THRESHOLD_DAYS', () => {
  it('equals 30', () => {
    expect(STALENESS_THRESHOLD_DAYS).toBe(30);
  });
});

describe('PEER_CARD_TARGETS', () => {
  it('contains exactly [user, agent]', () => {
    expect([...PEER_CARD_TARGETS]).toEqual(['user', 'agent']);
  });

  it('is frozen (cannot be mutated)', () => {
    expect(Object.isFrozen(PEER_CARD_TARGETS)).toBe(true);
    expect(() => PEER_CARD_TARGETS.push('admin')).toThrow();
  });
});

// ─── Standalone predicates ───────────────────────────────────────────────────

describe('isValidPeerCardId', () => {
  it('accepts a valid kebab-case slug', () => {
    expect(isValidPeerCardId('op-cardguy')).toBe(true);
  });

  it('rejects uppercase', () => {
    expect(isValidPeerCardId('Op-Cardguy')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidPeerCardId('')).toBe(false);
  });

  it('rejects non-string', () => {
    expect(isValidPeerCardId(42)).toBe(false);
    expect(isValidPeerCardId(null)).toBe(false);
  });

  it('rejects ids longer than 128 chars', () => {
    const tooLong = 'a-' + 'b'.repeat(128);
    expect(isValidPeerCardId(tooLong)).toBe(false);
  });
});

describe('isValidPeerCardTarget', () => {
  it('accepts "user"', () => {
    expect(isValidPeerCardTarget('user')).toBe(true);
  });

  it('accepts "agent"', () => {
    expect(isValidPeerCardTarget('agent')).toBe(true);
  });

  it('rejects "User" (case-sensitive)', () => {
    expect(isValidPeerCardTarget('User')).toBe(false);
  });

  it('rejects unknown values', () => {
    expect(isValidPeerCardTarget('admin')).toBe(false);
    expect(isValidPeerCardTarget('')).toBe(false);
    expect(isValidPeerCardTarget(null)).toBe(false);
  });
});

describe('isValidIsoTimestamp', () => {
  it('accepts canonical ISO 8601 Z timestamps', () => {
    expect(isValidIsoTimestamp('2026-05-23T12:00:00Z')).toBe(true);
  });

  it('accepts millisecond precision', () => {
    expect(isValidIsoTimestamp('2026-05-23T12:00:00.123Z')).toBe(true);
  });

  it('rejects date-only', () => {
    expect(isValidIsoTimestamp('2026-05-23')).toBe(false);
  });

  it('rejects offset timezone', () => {
    expect(isValidIsoTimestamp('2026-05-23T12:00:00+02:00')).toBe(false);
  });

  it('rejects non-string', () => {
    expect(isValidIsoTimestamp(null)).toBe(false);
    expect(isValidIsoTimestamp(undefined)).toBe(false);
  });
});
