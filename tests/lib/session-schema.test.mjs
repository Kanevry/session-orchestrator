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
  clampTimestampsMonotonic,
  aliasLegacyEndedAt,
} from '@lib/session-schema.mjs';
import { migrateEntry } from '../../scripts/migrate-sessions-jsonl.mjs';

// Defensive guard: surface process.exit() during test setup as a thrown error
// rather than letting it crash the vitest worker (#368).
vi.spyOn(process, 'exit').mockImplementation((code) => {
  throw new Error(`Unexpected process.exit(${code}) during test setup`);
});

// ---------------------------------------------------------------------------
// module-import safety
// ---------------------------------------------------------------------------

describe('module-import safety', () => {
  it('importing migrate-sessions-jsonl does not trigger process.exit', () => {
    // The vi.spyOn(process, 'exit') guard at module top would throw if main()
    // ran on import. If we get here, the CLI guard in migrate-sessions-jsonl.mjs
    // is functioning correctly. (Regression guard for #368.)
    expect(process.exit).toHaveBeenCalledTimes(0);
  });
});

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

  it('applies waves_completed → total_waves alias (#400)', () => {
    const out = normalizeSession({ session_id: 'sess-wc', session_type: 'deep', waves_completed: 5 });
    expect(out.total_waves).toBe(5);
    expect(out.waves_completed).toBe(5); // original preserved for debugging
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

  it('SESSION_KEY_ALIASES maps waves_completed → total_waves (#400)', () => {
    expect(SESSION_KEY_ALIASES.waves_completed).toBe('total_waves');
  });

  it('CURRENT_SESSION_SCHEMA_VERSION is 1', () => {
    expect(CURRENT_SESSION_SCHEMA_VERSION).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #304 — old-shape rejected by validateSession, new-shape accepted
// ---------------------------------------------------------------------------

/**
 * Old-shape record: uses agents_dispatched / agents_complete / agents_partial /
 * agents_failed scalars + waves_completed scalar instead of agent_summary
 * object + waves[] array.
 */
const OLD_SHAPE = () => ({
  session_id: 'sess-old-2025-01-01-1000',
  session_type: 'feature',
  started_at: '2025-01-01T10:00:00Z',
  completed_at: '2025-01-01T11:00:00Z',
  agents_dispatched: 4,
  agents_complete: 3,
  agents_partial: 1,
  agents_failed: 0,
  waves_completed: 2,
  total_files_changed: 8,
});

describe('validateSession — old shape rejected (#304)', () => {
  it('rejects a bare old-shape record (missing total_waves, waves, agent_summary, total_agents)', () => {
    const entry = OLD_SHAPE();
    // OLD_SHAPE lacks total_waves, waves[], agent_summary, total_agents — all required
    expect(() => validateSession(entry)).toThrow(ValidationError);
    // The validator hits the first missing required field in REQUIRED_FIELDS order;
    // assert that it rejects with a "missing required field" message.
    expect(() => validateSession(entry)).toThrow(/session missing required field/);
  });

  it('rejects an old-shape record that has agent_summary but lacks waves array', () => {
    // Supply total_waves + agent_summary + total_agents but NOT waves[]
    const entry = {
      ...OLD_SHAPE(),
      total_waves: 2,
      agent_summary: { complete: 3, partial: 1, failed: 0, spiral: 0 },
      total_agents: 4,
    };
    expect(() => validateSession(entry)).toThrow(ValidationError);
    expect(() => validateSession(entry)).toThrow(/waves/);
  });

  it('rejects an old-shape record that has waves[] but lacks agent_summary', () => {
    const entry = {
      ...OLD_SHAPE(),
      total_waves: 2,
      waves: [],
      total_agents: 4,
    };
    expect(() => validateSession(entry)).toThrow(ValidationError);
    expect(() => validateSession(entry)).toThrow(/agent_summary/);
  });

  it('rejects an old-shape record that has agent_summary + waves[] but lacks total_agents', () => {
    const entry = {
      ...OLD_SHAPE(),
      total_waves: 2,
      waves: [],
      agent_summary: { complete: 3, partial: 1, failed: 0, spiral: 0 },
    };
    expect(() => validateSession(entry)).toThrow(ValidationError);
    expect(() => validateSession(entry)).toThrow(/total_agents/);
  });
});

describe('validateSession — new shape accepted (#304)', () => {
  it('accepts a fully canonical new-shape record', () => {
    const entry = VALID();
    const v = validateSession(entry);
    expect(v.schema_version).toBe(1);
    expect(v.agent_summary).toEqual({ complete: 5, partial: 1, failed: 0, spiral: 0 });
    expect(Array.isArray(v.waves)).toBe(true);
    expect(typeof v.total_agents).toBe('number');
    expect(typeof v.total_files_changed).toBe('number');
  });

  it('accepts new-shape with empty waves array', () => {
    const v = validateSession({ ...VALID(), waves: [], total_waves: 0 });
    expect(v.waves).toEqual([]);
    expect(v.total_waves).toBe(0);
  });

  it('accepts new-shape with all four agent_summary fields as zero', () => {
    const v = validateSession({
      ...VALID(),
      agent_summary: { complete: 0, partial: 0, failed: 0, spiral: 0 },
      total_agents: 0,
    });
    expect(v.agent_summary.spiral).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #304 — migrateEntry: old → new shape mapping
// ---------------------------------------------------------------------------

describe('migrateEntry — old to new shape mapping (#304)', () => {
  it('reconstructs agent_summary from agents_complete/partial/failed scalars', () => {
    const migrated = migrateEntry(OLD_SHAPE());
    expect(migrated.agent_summary).toEqual({ complete: 3, partial: 1, failed: 0, spiral: 0 });
  });

  it('derives total_agents from agents_dispatched when agent_summary absent', () => {
    const migrated = migrateEntry(OLD_SHAPE());
    expect(migrated.total_agents).toBe(4);
  });

  it('derives total_waves from waves_completed scalar', () => {
    const migrated = migrateEntry(OLD_SHAPE());
    expect(migrated.total_waves).toBe(2);
  });

  it('sets waves to empty array when scalar-only record (not reconstructible)', () => {
    const migrated = migrateEntry(OLD_SHAPE());
    expect(Array.isArray(migrated.waves)).toBe(true);
    expect(migrated.waves).toHaveLength(0);
  });

  it('preserves total_files_changed when already present', () => {
    const migrated = migrateEntry(OLD_SHAPE());
    expect(migrated.total_files_changed).toBe(8);
  });

  it('produces a record that passes validateSession', () => {
    const migrated = migrateEntry(OLD_SHAPE());
    expect(() => validateSession(migrated)).not.toThrow();
    const validated = validateSession(migrated);
    expect(validated.schema_version).toBe(1);
  });

  it('converts duration_min to duration_seconds when absent', () => {
    const entry = { ...OLD_SHAPE(), duration_min: 30 };
    const migrated = migrateEntry(entry);
    expect(migrated.duration_seconds).toBe(1800);
  });

  it('converts duration_minutes to duration_seconds when absent', () => {
    const entry = { ...OLD_SHAPE(), duration_minutes: 45 };
    const migrated = migrateEntry(entry);
    expect(migrated.duration_seconds).toBe(2700);
  });

  it('does not overwrite existing duration_seconds when duration_min also present', () => {
    const entry = { ...OLD_SHAPE(), duration_min: 30, duration_seconds: 999 };
    const migrated = migrateEntry(entry);
    expect(migrated.duration_seconds).toBe(999);
  });

  it('applies head_ref → branch alias via normalizeSession', () => {
    const entry = { ...OLD_SHAPE(), head_ref: 'feature/foo' };
    const migrated = migrateEntry(entry);
    expect(migrated.branch).toBe('feature/foo');
  });

  it('preserves all original old-shape fields (additive migration — no information lost)', () => {
    const old = OLD_SHAPE();
    const migrated = migrateEntry(old);
    expect(migrated.agents_dispatched).toBe(4);
    expect(migrated.agents_complete).toBe(3);
    expect(migrated.agents_partial).toBe(1);
    expect(migrated.agents_failed).toBe(0);
    expect(migrated.waves_completed).toBe(2);
  });

  it('throws TypeError on non-object input', () => {
    expect(() => migrateEntry(null)).toThrow(TypeError);
    expect(() => migrateEntry('nope')).toThrow(TypeError);
    expect(() => migrateEntry([1, 2])).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// #304 — migrateEntry idempotency: already-canonical records survive intact
// ---------------------------------------------------------------------------

describe('migrateEntry — idempotency (#304)', () => {
  it('running migrateEntry on a new-shape record is a no-op (result validates identically)', () => {
    const canonical = VALID();
    const once = migrateEntry(canonical);
    const twice = migrateEntry(once);
    // Both must validate without error
    const v1 = validateSession(once);
    const v2 = validateSession(twice);
    expect(v1.session_id).toBe(canonical.session_id);
    expect(v2.session_id).toBe(canonical.session_id);
    expect(v1.agent_summary).toEqual(v2.agent_summary);
    expect(v1.total_agents).toBe(v2.total_agents);
    expect(v1.total_files_changed).toBe(v2.total_files_changed);
  });

  it('running migrateEntry twice on an old-shape record yields the same canonical form', () => {
    const old = OLD_SHAPE();
    const once = migrateEntry(old);
    const twice = migrateEntry(once);
    const v1 = validateSession(once);
    const v2 = validateSession(twice);
    expect(v1.agent_summary).toEqual(v2.agent_summary);
    expect(v1.total_agents).toBe(v2.total_agents);
    expect(v1.schema_version).toBe(1);
    expect(v2.schema_version).toBe(1);
  });

  it('migrateEntry on a record with schema_version:1 does not change schema_version', () => {
    const entry = { ...VALID(), schema_version: 1 };
    const migrated = migrateEntry(entry);
    // schema_version preserved by validateSession stamp
    const validated = validateSession(migrated);
    expect(validated.schema_version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #321 — clampTimestampsMonotonic (pre-validation repair)
// ---------------------------------------------------------------------------

describe('clampTimestampsMonotonic (#321)', () => {
  it('returns input unchanged when entry has neither timestamp', () => {
    const entry = { session_id: 'sess-no-ts' };
    const out = clampTimestampsMonotonic(entry);
    expect(out).toBe(entry);
  });

  it('returns input unchanged when entry is non-object (null)', () => {
    expect(clampTimestampsMonotonic(null)).toBe(null);
  });

  it('returns input unchanged when entry is non-object (string)', () => {
    expect(clampTimestampsMonotonic('nope')).toBe('nope');
  });

  it('returns input unchanged when entry is an array', () => {
    const arr = [1, 2, 3];
    expect(clampTimestampsMonotonic(arr)).toBe(arr);
  });

  it('returns input unchanged when only started_at is present', () => {
    const entry = { session_id: 's', started_at: '2026-04-24T08:00:00Z' };
    const out = clampTimestampsMonotonic(entry);
    expect(out).toBe(entry);
  });

  it('returns input unchanged when only completed_at is present', () => {
    const entry = { session_id: 's', completed_at: '2026-04-24T08:00:00Z' };
    const out = clampTimestampsMonotonic(entry);
    expect(out).toBe(entry);
  });

  it('returns input unchanged when started_at is unparsable (NaN)', () => {
    const entry = {
      session_id: 's',
      started_at: 'not-a-date',
      completed_at: '2026-04-24T08:00:00Z',
    };
    const out = clampTimestampsMonotonic(entry);
    expect(out).toBe(entry);
  });

  it('returns input unchanged when completed_at is unparsable (NaN)', () => {
    const entry = {
      session_id: 's',
      started_at: '2026-04-24T08:00:00Z',
      completed_at: 'still-not-a-date',
    };
    const out = clampTimestampsMonotonic(entry);
    expect(out).toBe(entry);
  });

  it('returns input unchanged when completed_at equals started_at', () => {
    const entry = {
      session_id: 's',
      started_at: '2026-04-24T08:00:00Z',
      completed_at: '2026-04-24T08:00:00Z',
    };
    const out = clampTimestampsMonotonic(entry);
    expect(out).toBe(entry);
    expect(out._clamped).toBeUndefined();
  });

  it('returns input unchanged when completed_at is later than started_at', () => {
    const entry = {
      session_id: 's',
      started_at: '2026-04-24T08:00:00Z',
      completed_at: '2026-04-24T09:30:00Z',
    };
    const out = clampTimestampsMonotonic(entry);
    expect(out).toBe(entry);
    expect(out._clamped).toBeUndefined();
  });

  it('returns a NEW object when inversion detected (does not mutate input)', () => {
    const entry = {
      session_id: 'inv-1',
      started_at: '2026-04-24T10:00:00Z',
      completed_at: '2026-04-24T09:00:00Z',
    };
    const snapshot = JSON.parse(JSON.stringify(entry));
    const out = clampTimestampsMonotonic(entry);
    expect(out).not.toBe(entry);
    // Original input unmodified
    expect(entry).toEqual(snapshot);
    expect(entry._clamped).toBeUndefined();
    expect(entry.completed_at).toBe('2026-04-24T09:00:00Z');
  });

  it('clamps completed_at to equal started_at on inversion', () => {
    const entry = {
      session_id: 'inv-2',
      started_at: '2026-04-24T10:00:00Z',
      completed_at: '2026-04-24T09:00:00Z',
    };
    const out = clampTimestampsMonotonic(entry);
    expect(out.completed_at).toBe('2026-04-24T10:00:00Z');
    expect(out.completed_at).toBe(out.started_at);
  });

  it('sets _clamped: true on the clamped record', () => {
    const entry = {
      session_id: 'inv-3',
      started_at: '2026-04-24T10:00:00Z',
      completed_at: '2026-04-24T09:00:00Z',
    };
    const out = clampTimestampsMonotonic(entry);
    expect(out._clamped).toBe(true);
  });

  it('preserves _original_completed_at with the original value', () => {
    const original = '2026-04-24T09:00:00Z';
    const entry = {
      session_id: 'inv-4',
      started_at: '2026-04-24T10:00:00Z',
      completed_at: original,
    };
    const out = clampTimestampsMonotonic(entry);
    expect(out._original_completed_at).toBe(original);
  });

  it('1h inversion: deterministic clamp result (started_at preserved, completed_at = started_at)', () => {
    const entry = {
      session_id: 'inv-1h',
      started_at: '2026-04-24T11:00:00Z',
      completed_at: '2026-04-24T10:00:00Z',
    };
    const out = clampTimestampsMonotonic(entry);
    expect(out).toEqual({
      session_id: 'inv-1h',
      started_at: '2026-04-24T11:00:00Z',
      completed_at: '2026-04-24T11:00:00Z',
      _clamped: true,
      _original_completed_at: '2026-04-24T10:00:00Z',
    });
  });
});

// ---------------------------------------------------------------------------
// #321 — aliasLegacyEndedAt (pre-validation repair)
// ---------------------------------------------------------------------------

describe('aliasLegacyEndedAt (#321)', () => {
  it('returns input unchanged when neither completed_at nor ended_at present', () => {
    const entry = { session_id: 's', started_at: '2026-04-24T08:00:00Z' };
    const out = aliasLegacyEndedAt(entry);
    expect(out).toBe(entry);
  });

  it('returns input unchanged on non-object input (null / string / array)', () => {
    expect(aliasLegacyEndedAt(null)).toBe(null);
    expect(aliasLegacyEndedAt('nope')).toBe('nope');
    const arr = [];
    expect(aliasLegacyEndedAt(arr)).toBe(arr);
  });

  it('aliases ended_at -> completed_at when only ended_at present', () => {
    const entry = {
      session_id: 's',
      started_at: '2026-04-24T08:00:00Z',
      ended_at: '2026-04-24T09:00:00Z',
    };
    const out = aliasLegacyEndedAt(entry);
    expect(out).not.toBe(entry);
    expect(out.completed_at).toBe('2026-04-24T09:00:00Z');
    expect(out.ended_at).toBe('2026-04-24T09:00:00Z');
    expect(out._completed_at_conflict).toBeUndefined();
  });

  it('prefers completed_at and tags _completed_at_conflict when both present and differ', () => {
    const entry = {
      session_id: 's',
      started_at: '2026-04-24T08:00:00Z',
      completed_at: '2026-04-24T09:00:00Z',
      ended_at: '2026-04-24T09:30:00Z',
    };
    const out = aliasLegacyEndedAt(entry);
    expect(out).not.toBe(entry);
    expect(out.completed_at).toBe('2026-04-24T09:00:00Z'); // preferred
    expect(out.ended_at).toBe('2026-04-24T09:30:00Z'); // preserved
    expect(out._completed_at_conflict).toBe(true);
  });

  it('leaves both unchanged + no conflict tag when both present and equal', () => {
    const entry = {
      session_id: 's',
      started_at: '2026-04-24T08:00:00Z',
      completed_at: '2026-04-24T09:00:00Z',
      ended_at: '2026-04-24T09:00:00Z',
    };
    const out = aliasLegacyEndedAt(entry);
    expect(out.completed_at).toBe('2026-04-24T09:00:00Z');
    expect(out.ended_at).toBe('2026-04-24T09:00:00Z');
    expect(out._completed_at_conflict).toBeUndefined();
  });

  it('drops duration_ms once both started_at and completed_at end up present (alias path)', () => {
    const entry = {
      session_id: 's',
      started_at: '2026-04-24T08:00:00Z',
      ended_at: '2026-04-24T09:00:00Z',
      duration_ms: 3600000,
    };
    const out = aliasLegacyEndedAt(entry);
    expect(out.completed_at).toBe('2026-04-24T09:00:00Z');
    expect('duration_ms' in out).toBe(false);
  });

  it('drops duration_ms when completed_at already canonical and started_at present', () => {
    const entry = {
      session_id: 's',
      started_at: '2026-04-24T08:00:00Z',
      completed_at: '2026-04-24T09:00:00Z',
      ended_at: '2026-04-24T09:00:00Z',
      duration_ms: 3600000,
    };
    const out = aliasLegacyEndedAt(entry);
    expect('duration_ms' in out).toBe(false);
  });

  it('leaves duration_ms intact when started_at is absent', () => {
    const entry = {
      session_id: 's',
      ended_at: '2026-04-24T09:00:00Z',
      duration_ms: 3600000,
    };
    const out = aliasLegacyEndedAt(entry);
    expect(out.completed_at).toBe('2026-04-24T09:00:00Z');
    expect(out.duration_ms).toBe(3600000);
  });
});
