/**
 * tests/lib/session-schema/validator.test.mjs
 *
 * Vitest suite for scripts/lib/session-schema/validator.mjs.
 * Covers: ValidationError class shape, validateSession happy path,
 * required fields, schema_version bounds, session_id format,
 * session_type enum, timestamp ordering, waves shape, agent_summary shape,
 * optional fields, non-mutation contract.
 */

import { describe, it, expect } from 'vitest';
import {
  ValidationError,
  validateSession,
} from '../../../scripts/lib/session-schema/validator.mjs';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const VALID = () => ({
  session_id: 'sess-2026-04-24-test',
  session_type: 'deep',
  started_at: '2026-04-24T08:00:00Z',
  completed_at: '2026-04-24T09:00:00Z',
  total_waves: 3,
  waves: [
    { wave: 1, role: 'explore' },
    { wave: 2, role: 'implement' },
  ],
  agent_summary: { complete: 5, partial: 1, failed: 0, spiral: 0 },
  total_agents: 6,
  total_files_changed: 12,
});

// ---------------------------------------------------------------------------
// ValidationError class
// ---------------------------------------------------------------------------

describe('ValidationError', () => {
  it('is an instanceof Error', () => {
    const err = new ValidationError('boom');
    expect(err).toBeInstanceOf(Error);
  });

  it('is an instanceof ValidationError', () => {
    const err = new ValidationError('boom');
    expect(err).toBeInstanceOf(ValidationError);
  });

  it('has name: ValidationError', () => {
    const err = new ValidationError('boom');
    expect(err.name).toBe('ValidationError');
  });

  it('exposes the message passed to constructor', () => {
    const err = new ValidationError('my message');
    expect(err.message).toBe('my message');
  });
});

// ---------------------------------------------------------------------------
// validateSession — happy path
// ---------------------------------------------------------------------------

describe('validateSession — happy path', () => {
  it('accepts a valid entry and stamps schema_version: 1 when absent', () => {
    const v = validateSession(VALID());
    expect(v.schema_version).toBe(1);
  });

  it('preserves pre-existing schema_version: 0 (legacy)', () => {
    const v = validateSession({ ...VALID(), schema_version: 0 });
    expect(v.schema_version).toBe(0);
  });

  it('returns a NEW object and does not mutate input', () => {
    const input = VALID();
    const snapshot = JSON.parse(JSON.stringify(input));
    const v = validateSession(input);
    expect(v).not.toBe(input);
    expect(input).toEqual(snapshot);
  });

  it('passes through unknown fields (additive contract)', () => {
    const v = validateSession({ ...VALID(), custom_metric: 42, my_extra: 'ok' });
    expect(v.custom_metric).toBe(42);
    expect(v.my_extra).toBe('ok');
  });

  it('accepts an empty waves array', () => {
    const v = validateSession({ ...VALID(), waves: [] });
    expect(v.waves).toEqual([]);
  });

  it('accepts valid optional fields without throwing', () => {
    const v = validateSession({
      ...VALID(),
      effectiveness: { overall: 0.9 },
      discovery_stats: { probes: 3 },
      review_stats: null,
      platform: 'darwin',
      duration_seconds: 3600,
      branch: 'main',
      base_branch: 'main',
      issues_closed: [1, 2, 3],
      issues_created: [4],
      notes: 'all good',
    });
    expect(v.duration_seconds).toBe(3600);
    expect(v.issues_closed).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// validateSession — non-object input
// ---------------------------------------------------------------------------

describe('validateSession — non-object input', () => {
  it('throws on null', () => {
    expect(() => validateSession(null)).toThrow(ValidationError);
    expect(() => validateSession(null)).toThrow(/session must be an object/);
  });

  it('throws on string', () => {
    expect(() => validateSession('nope')).toThrow(/session must be an object/);
  });

  it('throws on array', () => {
    expect(() => validateSession([])).toThrow(/session must be an object/);
  });
});

// ---------------------------------------------------------------------------
// validateSession — schema_version
// ---------------------------------------------------------------------------

describe('validateSession — schema_version', () => {
  it('throws on schema_version: 2 (out of range)', () => {
    expect(() => validateSession({ ...VALID(), schema_version: 2 })).toThrow(
      /schema_version must be 0 \(legacy\) or 1/
    );
  });

  it('accepts schema_version: 1 (current)', () => {
    expect(() => validateSession({ ...VALID(), schema_version: 1 })).not.toThrow();
  });

  it('accepts schema_version: 0 (legacy)', () => {
    expect(() => validateSession({ ...VALID(), schema_version: 0 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateSession — required fields
// ---------------------------------------------------------------------------

describe('validateSession — required fields', () => {
  it.each([
    'session_id',
    'session_type',
    'started_at',
    'completed_at',
    'total_waves',
    'waves',
    'agent_summary',
    'total_agents',
    'total_files_changed',
  ])('throws ValidationError when %s is missing', (field) => {
    const e = { ...VALID() };
    delete e[field];
    expect(() => validateSession(e)).toThrow(ValidationError);
    expect(() => validateSession(e)).toThrow(new RegExp(field));
  });
});

// ---------------------------------------------------------------------------
// validateSession — session_id
// ---------------------------------------------------------------------------

describe('validateSession — session_id', () => {
  it('throws when session_id is an empty string', () => {
    expect(() => validateSession({ ...VALID(), session_id: '' })).toThrow(
      /session_id must be a non-empty string/
    );
  });

  it('throws when session_id is a number', () => {
    expect(() => validateSession({ ...VALID(), session_id: 42 })).toThrow(/session_id/);
  });
});

// ---------------------------------------------------------------------------
// validateSession — session_type enum
// ---------------------------------------------------------------------------

describe('validateSession — session_type', () => {
  it('throws on unknown session_type value', () => {
    expect(() => validateSession({ ...VALID(), session_type: 'refactor' })).toThrow(
      /session_type must be one of feature\|deep\|housekeeping/
    );
  });

  it('accepts feature, deep, housekeeping', () => {
    for (const t of ['feature', 'deep', 'housekeeping']) {
      expect(() => validateSession({ ...VALID(), session_type: t })).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// validateSession — timestamps
// ---------------------------------------------------------------------------

describe('validateSession — timestamps', () => {
  it('throws when completed_at is before started_at', () => {
    const e = {
      ...VALID(),
      started_at: '2026-04-24T10:00:00Z',
      completed_at: '2026-04-24T09:00:00Z',
    };
    expect(() => validateSession(e)).toThrow(/completed_at.*must be >= started_at/);
  });

  it('accepts equal started_at and completed_at (zero-duration)', () => {
    const ts = '2026-04-24T10:00:00Z';
    expect(() => validateSession({ ...VALID(), started_at: ts, completed_at: ts })).not.toThrow();
  });

  it('throws on malformed started_at', () => {
    expect(() => validateSession({ ...VALID(), started_at: 'not-a-date' })).toThrow(
      /started_at is not a parsable timestamp/
    );
  });

  it('throws on malformed completed_at', () => {
    expect(() => validateSession({ ...VALID(), completed_at: 'nope' })).toThrow(
      /completed_at is not a parsable timestamp/
    );
  });
});

// ---------------------------------------------------------------------------
// validateSession — waves
// ---------------------------------------------------------------------------

describe('validateSession — waves', () => {
  it('throws on negative total_waves', () => {
    expect(() => validateSession({ ...VALID(), total_waves: -1 })).toThrow(
      /total_waves must be a non-negative number/
    );
  });

  it('throws when waves is not an array', () => {
    expect(() => validateSession({ ...VALID(), waves: 'x' })).toThrow(/waves must be an array/);
  });

  it('throws when a wave entry is not an object', () => {
    expect(() => validateSession({ ...VALID(), waves: [42] })).toThrow(/waves\[0\] must be an object/);
  });

  it('throws when wave.wave < 1', () => {
    expect(() => validateSession({ ...VALID(), waves: [{ wave: 0, role: 'x' }] })).toThrow(
      /waves\[0\]\.wave must be a number >= 1/
    );
  });

  it('throws when wave.role is empty string', () => {
    expect(() => validateSession({ ...VALID(), waves: [{ wave: 1, role: '' }] })).toThrow(
      /waves\[0\]\.role must be a non-empty string/
    );
  });
});

// ---------------------------------------------------------------------------
// validateSession — agent_summary
// ---------------------------------------------------------------------------

describe('validateSession — agent_summary', () => {
  it('throws when agent_summary is not an object', () => {
    expect(() => validateSession({ ...VALID(), agent_summary: 42 })).toThrow(
      /agent_summary must be an object/
    );
  });

  it('throws when agent_summary is missing spiral field', () => {
    const e = { ...VALID(), agent_summary: { complete: 1, partial: 0, failed: 0 } };
    expect(() => validateSession(e)).toThrow(/agent_summary missing required field: spiral/);
  });

  it('throws when agent_summary.complete is negative', () => {
    const e = { ...VALID(), agent_summary: { complete: -1, partial: 0, failed: 0, spiral: 0 } };
    expect(() => validateSession(e)).toThrow(/agent_summary\.complete/);
  });

  it('throws when total_agents is negative', () => {
    expect(() => validateSession({ ...VALID(), total_agents: -1 })).toThrow(
      /total_agents must be a non-negative number/
    );
  });

  it('throws when total_files_changed is negative', () => {
    expect(() => validateSession({ ...VALID(), total_files_changed: -1 })).toThrow(
      /total_files_changed must be a non-negative number/
    );
  });

  it('accepts all-zero agent_summary (no-op session)', () => {
    const e = {
      ...VALID(),
      agent_summary: { complete: 0, partial: 0, failed: 0, spiral: 0 },
      total_agents: 0,
    };
    expect(() => validateSession(e)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateSession — optional fields
// ---------------------------------------------------------------------------

describe('validateSession — optional fields', () => {
  it('throws when effectiveness is not an object (string)', () => {
    expect(() => validateSession({ ...VALID(), effectiveness: 'bad' })).toThrow(
      /effectiveness must be an object or null/
    );
  });

  it('throws when duration_seconds is negative', () => {
    expect(() => validateSession({ ...VALID(), duration_seconds: -5 })).toThrow(
      /duration_seconds must be a non-negative number/
    );
  });

  it('throws when issues_closed contains a non-number element', () => {
    expect(() => validateSession({ ...VALID(), issues_closed: [1, 'x'] })).toThrow(
      /issues_closed must be an array of numbers/
    );
  });

  it('throws when issues_created is not an array', () => {
    expect(() => validateSession({ ...VALID(), issues_created: 42 })).toThrow(/issues_created/);
  });

  it('throws when platform is a number', () => {
    expect(() => validateSession({ ...VALID(), platform: 42 })).toThrow(
      /platform must be a string or null/
    );
  });
});
