/**
 * tests/lib/session-schema.test.mjs
 *
 * Vitest suite for scripts/lib/session-schema.mjs (issue #249 follow-up:
 * producer-side schema lock for session JSONL entries).
 *
 * Covers: validateSession (required fields, enum, timestamp ordering,
 * numeric bounds, waves shape, agent_summary shape, non-mutation,
 * pass-through), normalizeSession (alias application, schema_version
 * tagging semantics, dedupe warn, idempotence, malformed pass-through).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CURRENT_SESSION_SCHEMA_VERSION,
  SESSION_KEY_ALIASES,
  ValidationError,
  validateSession,
  normalizeSession,
} from '../../scripts/lib/session-schema.mjs';

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
// validateSession
// ---------------------------------------------------------------------------

describe('validateSession — happy path', () => {
  it('accepts a valid entry and stamps schema_version: 1 when absent', () => {
    const v = validateSession(VALID());
    expect(v.schema_version).toBe(CURRENT_SESSION_SCHEMA_VERSION);
    expect(v.schema_version).toBe(1);
    expect(v.session_id).toBe('sess-2026-04-24-test');
  });

  it('preserves pre-existing schema_version on a valid entry', () => {
    const v = validateSession({ ...VALID(), schema_version: 0 });
    expect(v.schema_version).toBe(0);
  });

  it('returns a NEW object and does not mutate input', () => {
    const input = VALID();
    const snapshot = JSON.parse(JSON.stringify(input));
    const v = validateSession(input);
    expect(v).not.toBe(input);
    expect(input).toEqual(snapshot);
    expect('schema_version' in input).toBe(false);
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

  it('accepts valid optional fields', () => {
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
      notes: 'ok',
    });
    expect(v.effectiveness).toEqual({ overall: 0.9 });
    expect(v.duration_seconds).toBe(3600);
  });
});

describe('validateSession — required fields', () => {
  it('throws ValidationError when session_id is missing', () => {
    const e = { ...VALID() };
    delete e.session_id;
    expect(() => validateSession(e)).toThrow(ValidationError);
    expect(() => validateSession(e)).toThrow(/session_id/);
  });

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
  ])('throws when required field %s is missing', (field) => {
    const e = { ...VALID() };
    delete e[field];
    expect(() => validateSession(e)).toThrow(ValidationError);
    expect(() => validateSession(e)).toThrow(new RegExp(field));
  });

  it('ValidationError is an instanceof Error with correct name', () => {
    try {
      validateSession({});
      throw new Error('expected validator to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.name).toBe('ValidationError');
    }
  });
});

describe('validateSession — type / range checks', () => {
  it('throws on invalid session_type (not in enum)', () => {
    expect(() => validateSession({ ...VALID(), session_type: 'refactor' })).toThrow(
      /session_type must be one of feature\|deep\|housekeeping/
    );
  });

  it('throws when completed_at is before started_at', () => {
    const e = { ...VALID(), started_at: '2026-04-24T10:00:00Z', completed_at: '2026-04-24T09:00:00Z' };
    expect(() => validateSession(e)).toThrow(/completed_at/);
  });

  it('throws on malformed ISO timestamp', () => {
    expect(() => validateSession({ ...VALID(), started_at: 'not-a-date' })).toThrow(
      /started_at is not a parsable timestamp/
    );
  });

  it('throws on negative total_waves', () => {
    expect(() => validateSession({ ...VALID(), total_waves: -1 })).toThrow(/total_waves/);
  });

  it('throws when waves is not an array', () => {
    expect(() => validateSession({ ...VALID(), waves: 'not-array' })).toThrow(/waves must be an array/);
  });

  it('throws when a wave has wave < 1', () => {
    expect(() => validateSession({ ...VALID(), waves: [{ wave: 0, role: 'x' }] })).toThrow(
      /waves\[0\]\.wave/
    );
  });

  it('throws when a wave has empty role', () => {
    expect(() => validateSession({ ...VALID(), waves: [{ wave: 1, role: '' }] })).toThrow(
      /waves\[0\]\.role/
    );
  });

  it('throws when agent_summary is missing spiral', () => {
    const e = { ...VALID(), agent_summary: { complete: 1, partial: 0, failed: 0 } };
    expect(() => validateSession(e)).toThrow(/agent_summary missing required field: spiral/);
  });

  it('throws when agent_summary has a negative counter', () => {
    const e = { ...VALID(), agent_summary: { complete: -1, partial: 0, failed: 0, spiral: 0 } };
    expect(() => validateSession(e)).toThrow(/agent_summary\.complete/);
  });

  it('throws when duration_seconds is negative', () => {
    expect(() => validateSession({ ...VALID(), duration_seconds: -5 })).toThrow(/duration_seconds/);
  });

  it('throws when issues_closed contains non-number', () => {
    expect(() => validateSession({ ...VALID(), issues_closed: [1, 'x'] })).toThrow(/issues_closed/);
  });

  it('throws on non-object input', () => {
    expect(() => validateSession(null)).toThrow(/session must be an object/);
    expect(() => validateSession('nope')).toThrow(/session must be an object/);
    expect(() => validateSession([])).toThrow(/session must be an object/);
  });

  it('throws on invalid schema_version literal', () => {
    expect(() => validateSession({ ...VALID(), schema_version: 2 })).toThrow(/schema_version/);
  });
});

// ---------------------------------------------------------------------------
// normalizeSession
// ---------------------------------------------------------------------------

describe('normalizeSession — aliases + schema_version', () => {
  let errSpy;
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it('applies SESSION_KEY_ALIASES (type → session_type) and tags schema_version: 0', () => {
    const out = normalizeSession({ session_id: 'sess-alias-1', type: 'deep' });
    expect(out.type).toBe('deep'); // original preserved for debugging
    expect(out.session_type).toBe('deep');
    expect(out.schema_version).toBe(0);
  });

  it('applies all declared aliases', () => {
    const src = {
      session_id: 'sess-alias-all',
      type: 'feature',
      closed_issues: [1, 2],
      new_issues: [3],
      issues_planned: [9],
      files_changed: 7,
      snapshots: 2,
      learnings: 1,
      waves_total: 4,
      head_ref: 'main',
      isolation_override: 'none',
    };
    const out = normalizeSession(src);
    expect(out.session_type).toBe('feature');
    expect(out.issues_closed).toEqual([1, 2]);
    expect(out.issues_created).toEqual([3]);
    expect(out.planned_issues).toEqual([9]);
    expect(out.total_files_changed).toBe(7);
    expect(out.snapshots_created).toBe(2);
    expect(out.learnings_added).toBe(1);
    expect(out.total_waves).toBe(4);
    expect(out.branch).toBe('main');
    expect(out.isolation).toBe('none');
  });

  it('does not overwrite an existing canonical key when alias also present', () => {
    const out = normalizeSession({
      session_id: 'sess-no-clobber',
      type: 'feature',
      session_type: 'deep',
    });
    expect(out.session_type).toBe('deep');
    expect(out.type).toBe('feature');
  });

  it('already-canonical entry gets schema_version: 0 when absent', () => {
    const out = normalizeSession({ session_id: 'sess-canonical', session_type: 'deep' });
    expect(out.schema_version).toBe(0);
    expect(out.session_type).toBe('deep');
  });

  it('preserves schema_version: 1 when already present', () => {
    const out = normalizeSession({ session_id: 'sess-v1', session_type: 'deep', schema_version: 1 });
    expect(out.schema_version).toBe(1);
    // No warn for records that already carry the field.
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('returns non-object input unchanged (null / string / array)', () => {
    expect(normalizeSession(null)).toBe(null);
    expect(normalizeSession('x')).toBe('x');
    const arr = [1, 2];
    expect(normalizeSession(arr)).toBe(arr);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('deduplicates WARN: same session_id normalized twice logs only once', () => {
    const id = `sess-dedupe-${Date.now()}-${Math.random()}`;
    normalizeSession({ session_id: id, session_type: 'deep' });
    normalizeSession({ session_id: id, session_type: 'deep' });
    normalizeSession({ session_id: id, session_type: 'deep' });
    const hits = errSpy.mock.calls.filter((c) => String(c[0]).includes(`session_id=${id}`));
    expect(hits.length).toBe(1);
  });

  it('is idempotent on shape (normalize(normalize(x)) deep-equals normalize(x))', () => {
    const src = { session_id: 'sess-idem', type: 'deep', waves_total: 2 };
    const once = normalizeSession(src);
    const twice = normalizeSession(once);
    expect(twice).toEqual(once);
  });

  it('never throws on malformed entries', () => {
    expect(() => normalizeSession(undefined)).not.toThrow();
    expect(() => normalizeSession(42)).not.toThrow();
    expect(() => normalizeSession({ session_id: null })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Exports sanity
// ---------------------------------------------------------------------------

describe('module exports', () => {
  it('SESSION_KEY_ALIASES includes the documented entries', () => {
    expect(SESSION_KEY_ALIASES.type).toBe('session_type');
    expect(SESSION_KEY_ALIASES.closed_issues).toBe('issues_closed');
    expect(SESSION_KEY_ALIASES.head_ref).toBe('branch');
  });

  it('CURRENT_SESSION_SCHEMA_VERSION is 1', () => {
    expect(CURRENT_SESSION_SCHEMA_VERSION).toBe(1);
  });
});
