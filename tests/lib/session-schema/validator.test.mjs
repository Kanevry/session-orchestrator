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
} from '@lib/session-schema/validator.mjs';

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
  it('inherits Error and preserves its public error shape', () => {
    const err = new ValidationError('my message');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.name).toBe('ValidationError');
    expect(err.message).toBe('my message');
  });
});

// ---------------------------------------------------------------------------
// validateSession — happy path
// ---------------------------------------------------------------------------

describe('validateSession — happy path', () => {
  it('accepts a valid entry and stamps schema_version: 2 when absent', () => {
    const v = validateSession(VALID());
    expect(v.schema_version).toBe(2);
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
  it.each([[null], ['nope'], [[]]])('throws ValidationError for input %j', (input) => {
    expect(() => validateSession(input)).toThrow(ValidationError);
    expect(() => validateSession(input)).toThrow(/session must be an object/);
  });
});

// ---------------------------------------------------------------------------
// validateSession — schema_version
// ---------------------------------------------------------------------------

describe('validateSession — schema_version', () => {
  it.each([0, 1, 2, 3])('accepts schema_version: %s for readable historical records', (schemaVersion) => {
    expect(() => validateSession({ ...VALID(), schema_version: schemaVersion })).not.toThrow();
  });

  it.each([
    [-1, /schema_version must be one of \[0 \(legacy\), 1, 2, 3\].*got: -1/],
    [4, /schema_version must be one of \[0 \(legacy\), 1, 2, 3\].*got: 4/],
    ['1', /schema_version must be one of \[0 \(legacy\), 1, 2, 3\].*got: 1/],
    [1.5, /schema_version must be one of \[0 \(legacy\), 1, 2, 3\].*got: 1\.5/],
    [999, /schema_version must be one of \[0 \(legacy\), 1, 2, 3\].*got: 999/],
  ])('rejects schema_version %j outside the accepted set', (schemaVersion, expectedMessage) => {
    expect(() => validateSession({ ...VALID(), schema_version: schemaVersion })).toThrow(expectedMessage);
  });
});

// ---------------------------------------------------------------------------
// validateSession — required fields
// ---------------------------------------------------------------------------

describe('validateSession — required fields', () => {
  it.each([
    ['session_id', /session_id/],
    ['session_type', /session_type/],
    ['started_at', /started_at/],
    ['completed_at', /completed_at/],
    ['total_waves', /total_waves/],
    ['waves', /waves/],
    ['agent_summary', /agent_summary/],
    ['total_agents', /total_agents/],
    ['total_files_changed', /total_files_changed/],
  ])('throws ValidationError when %s is missing', (field, expectedMessage) => {
    const e = { ...VALID() };
    delete e[field];
    expect(() => validateSession(e)).toThrow(ValidationError);
    expect(() => validateSession(e)).toThrow(expectedMessage);
  });
});

// ---------------------------------------------------------------------------
// validateSession — session_id
// ---------------------------------------------------------------------------

describe('validateSession — session_id', () => {
  it.each([[''], [42]])('rejects session_id value %j', (sessionId) => {
    expect(() => validateSession({ ...VALID(), session_id: sessionId })).toThrow(
      /session_id must be a non-empty string/
    );
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

  it.each(['feature', 'deep', 'housekeeping'])('accepts session_type: %s', (sessionType) => {
    expect(() => validateSession({ ...VALID(), session_type: sessionType })).not.toThrow();
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

  it.each([
    ['started_at', 'not-a-date', /started_at is not a parsable timestamp/],
    ['completed_at', 'nope', /completed_at is not a parsable timestamp/],
  ])('rejects malformed %s timestamps', (field, value, expectedMessage) => {
    expect(() => validateSession({ ...VALID(), [field]: value })).toThrow(expectedMessage);
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
  it.each([
    ['effectiveness', 'bad', /effectiveness must be an object or null/],
    ['duration_seconds', -5, /duration_seconds must be a non-negative number/],
    ['issues_closed', [1, 'x'], /issues_closed must be an array of numbers/],
    ['issues_created', 42, /issues_created must be an array of numbers/],
    ['platform', 42, /platform must be a string or null/],
  ])('rejects invalid %s', (field, value, expectedMessage) => {
    expect(() => validateSession({ ...VALID(), [field]: value })).toThrow(expectedMessage);
  });
});

// ---------------------------------------------------------------------------
// ADR-364 optional additive fields
// ---------------------------------------------------------------------------

describe('ADR-364 optional additive fields', () => {
  it('happy path: entry with all 6 ADR-364 fields populated with valid values passes', () => {
    const v = validateSession({
      ...VALID(),
      agent_identity: 'agent-a',
      worktree_path: '/tmp/so-worktrees/wt-1',
      parent_run_id: 'run-uuid',
      lease_acquired_at: '2026-05-10T18:00:00Z',
      lease_ttl_seconds: 600,
      expected_cost_tier: 'standard',
    });
    expect(v.agent_identity).toBe('agent-a');
    expect(v.worktree_path).toBe('/tmp/so-worktrees/wt-1');
    expect(v.parent_run_id).toBe('run-uuid');
    expect(v.lease_acquired_at).toBe('2026-05-10T18:00:00Z');
    expect(v.lease_ttl_seconds).toBe(600);
    expect(v.expected_cost_tier).toBe('standard');
  });

  it('legacy compatibility: entry omitting all 6 ADR-364 fields passes (additive contract DoD)', () => {
    // This is the canonical DoD assertion: older entries without any of the
    // new fields must validate cleanly with no modification required.
    expect(() => validateSession(VALID())).not.toThrow();
  });

  it.each([[''], [42]])('rejects agent_identity value %j', (value) => {
    expect(() => validateSession({ ...VALID(), agent_identity: value })).toThrow(
      /agent_identity must be a non-empty string or null/
    );
  });

  it('throws when lease_acquired_at is not a parsable date string', () => {
    expect(() => validateSession({ ...VALID(), lease_acquired_at: 'not-a-date' })).toThrow(
      /lease_acquired_at is not a parsable timestamp/
    );
  });

  it.each([[-1], ['abc']])('rejects lease_ttl_seconds value %j', (value) => {
    expect(() => validateSession({ ...VALID(), lease_ttl_seconds: value })).toThrow(
      /lease_ttl_seconds must be a non-negative finite number or null/
    );
  });

  it.each([['enterprise'], [5]])('rejects expected_cost_tier value %j', (value) => {
    expect(() => validateSession({ ...VALID(), expected_cost_tier: value })).toThrow(
      /expected_cost_tier must be one of quick\|standard\|deep or null/
    );
  });

  it.each([
    'agent_identity',
    'worktree_path',
    'parent_run_id',
    'lease_acquired_at',
    'lease_ttl_seconds',
    'expected_cost_tier',
  ])('tolerates explicit null for %s', (field) => {
    expect(() => validateSession({ ...VALID(), [field]: null })).not.toThrow();
  });

  it.each(['quick', 'deep'])('accepts expected_cost_tier: %s', (tier) => {
    expect(() => validateSession({ ...VALID(), expected_cost_tier: tier })).not.toThrow();
  });

  it('accepts lease_ttl_seconds: 0 (boundary — zero is valid)', () => {
    expect(() => validateSession({ ...VALID(), lease_ttl_seconds: 0 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// #773 — Handover-Alignment-Gate open-question telemetry fields
// (open_questions_asked / open_questions_answered / open_questions_deferred:
//  non-negative integers, null/absent = "gate not run / not measured").
// ---------------------------------------------------------------------------

describe('#773 open-question telemetry fields', () => {
  it('happy path: passes through open_questions_asked/answered/deferred integer counts', () => {
    const v = validateSession({
      ...VALID(),
      open_questions_asked: 2,
      open_questions_answered: 1,
      open_questions_deferred: 0,
    });
    expect(v.open_questions_asked).toBe(2);
    expect(v.open_questions_answered).toBe(1);
    expect(v.open_questions_deferred).toBe(0);
  });

  it.each([
    ['open_questions_asked', -1, /open_questions_asked must be a non-negative integer/],
    ['open_questions_answered', 1.5, /open_questions_answered must be a non-negative integer/],
    ['open_questions_answered', '2', /open_questions_answered must be a non-negative integer/],
    ['open_questions_deferred', -3, /open_questions_deferred must be a non-negative integer/],
  ])('rejects invalid %s telemetry value %j', (field, value, expectedMessage) => {
    expect(() => validateSession({ ...VALID(), [field]: value })).toThrow(expectedMessage);
  });

  it('explicit null is tolerated for all three fields (not-measured sentinel)', () => {
    expect(() =>
      validateSession({
        ...VALID(),
        open_questions_asked: null,
        open_questions_answered: null,
        open_questions_deferred: null,
      })
    ).not.toThrow();
  });

  it('legacy compatibility: a record omitting all 3 fields validates and never coerces them to 0', () => {
    // Core #773 distinction — "not measured" must stay ABSENT, never become 0.
    // If the validator ever stamped a `?? 0` default, these keys would appear.
    const v = validateSession(VALID());
    expect('open_questions_asked' in v).toBe(false);
    expect('open_questions_answered' in v).toBe(false);
    expect('open_questions_deferred' in v).toBe(false);
  });
});
