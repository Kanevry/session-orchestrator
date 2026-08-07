/**
 * tests/lib/session-schema.test.mjs
 *
 * Vitest suite for scripts/lib/session-schema.mjs (issue #249 follow-up:
 * producer-side schema lock for session JSONL entries).
 *
 * Covers: barrel re-export identity, migration/import compatibility, old-shape
 * migration mapping, migration idempotence, and the migration/validator seam.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CURRENT_SESSION_SCHEMA_VERSION,
  SESSION_KEY_ALIASES,
  ValidationError,
  validateSession,
  normalizeSession,
  clampTimestampsMonotonic,
  aliasLegacyEndedAt,
} from '@lib/session-schema.mjs';
import * as constants from '@lib/session-schema/constants.mjs';
import * as validator from '@lib/session-schema/validator.mjs';
import * as normalizer from '@lib/session-schema/normalizer.mjs';
import * as timestamps from '@lib/session-schema/timestamps.mjs';
import * as aliases from '@lib/session-schema/aliases.mjs';
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
// Barrel re-export compatibility
// ---------------------------------------------------------------------------

describe('session-schema barrel exports', () => {
  it('re-exports split-module symbols without changing their identity', () => {
    expect(CURRENT_SESSION_SCHEMA_VERSION).toBe(constants.CURRENT_SESSION_SCHEMA_VERSION);
    expect(SESSION_KEY_ALIASES).toBe(constants.SESSION_KEY_ALIASES);
    expect(ValidationError).toBe(validator.ValidationError);
    expect(validateSession).toBe(validator.validateSession);
    expect(normalizeSession).toBe(normalizer.normalizeSession);
    expect(clampTimestampsMonotonic).toBe(timestamps.clampTimestampsMonotonic);
    expect(aliasLegacyEndedAt).toBe(aliases.aliasLegacyEndedAt);
  });
});

// ---------------------------------------------------------------------------
// #304 — old-shape migration fixture
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
    expect(validated.schema_version).toBe(2);
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
    expect(v1.schema_version).toBe(2);
    expect(v2.schema_version).toBe(2);
  });

  it('migrateEntry on a record with schema_version:1 does not change schema_version', () => {
    const entry = { ...VALID(), schema_version: 1 };
    const migrated = migrateEntry(entry);
    // schema_version preserved by validateSession stamp
    const validated = validateSession(migrated);
    expect(validated.schema_version).toBe(1);
  });
});
