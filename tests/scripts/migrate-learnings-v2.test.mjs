/**
 * tests/scripts/migrate-learnings-v2.test.mjs
 *
 * Vitest suite for learnings v2 migration enhancements (Wave 2 task C1).
 *
 * Changes under test:
 *   A. Scope-enum coercion: vault-tools, deep-sessions, wave-executor, coordinator → local
 *   B. source_session derivation: when missing/empty + sessions[] present, use sessions[0]
 *
 * These enhancements are applied in migrateLegacyLearning() before schema_version
 * stamping, making it safe to call validateLearning() on the result.
 */

import { describe, it, expect } from 'vitest';
import {
  migrateLegacyLearning,
  validateLearning,
} from '@lib/learnings.mjs';

// ---------------------------------------------------------------------------
// Fixture helper — minimal canonical learning (pre-migration shape)
// ---------------------------------------------------------------------------

/**
 * Returns a minimal valid legacy learning record.
 * Tests fork this with spread syntax to avoid mutation: { ...LEGACY() }.
 */
const LEGACY = () => ({
  id: 'test-id-1',
  type: 'recurring-issue',
  subject: 'test-subject',
  insight: 'test insight text',
  evidence: 'test evidence text',
  confidence: 0.5,
  source_session: 'test-session',
  created_at: '2026-04-19T00:00:00Z',
  expires_at: '2026-05-19T00:00:00Z',
});

// ---------------------------------------------------------------------------
// Suite 1 — Scope coercion
// ---------------------------------------------------------------------------

describe('migrateLegacyLearning — v2 scope coercion', () => {
  it('coerces scope=vault-tools to local', () => {
    const entry = { ...LEGACY(), scope: 'vault-tools', schema_version: 1 };
    const migrated = migrateLegacyLearning(entry);
    expect(migrated.scope).toBe('local');
    expect(() => validateLearning(migrated)).not.toThrow();
  });

  it('coerces scope=deep-sessions to local', () => {
    const entry = { ...LEGACY(), scope: 'deep-sessions', schema_version: 1 };
    const migrated = migrateLegacyLearning(entry);
    expect(migrated.scope).toBe('local');
    expect(() => validateLearning(migrated)).not.toThrow();
  });

  it('coerces scope=wave-executor to local', () => {
    const entry = { ...LEGACY(), scope: 'wave-executor', schema_version: 1 };
    const migrated = migrateLegacyLearning(entry);
    expect(migrated.scope).toBe('local');
    expect(() => validateLearning(migrated)).not.toThrow();
  });

  it('coerces scope=coordinator to local', () => {
    const entry = { ...LEGACY(), scope: 'coordinator', schema_version: 1 };
    const migrated = migrateLegacyLearning(entry);
    expect(migrated.scope).toBe('local');
    expect(() => validateLearning(migrated)).not.toThrow();
  });

  it('does NOT coerce valid scopes (local, private, public)', () => {
    for (const validScope of ['local', 'private', 'public']) {
      const entry = { ...LEGACY(), scope: validScope, schema_version: 1 };
      if (validScope === 'public') {
        entry.anonymized = true;
        entry.host_class = 'macos-test';
      }
      const migrated = migrateLegacyLearning(entry);
      expect(migrated.scope).toBe(validScope);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Unknown bad scopes pass through unchanged
// ---------------------------------------------------------------------------

describe('migrateLegacyLearning — v2 unknown bad scope passthrough', () => {
  it('unknown bad scope (not in coercible list) passes through unchanged', () => {
    const entry = { ...LEGACY(), scope: 'bogus-team-name', schema_version: 1 };
    const migrated = migrateLegacyLearning(entry);
    // scope is unchanged; validator rejects because 'bogus-team-name' is not in VALID_SCOPES
    expect(migrated.scope).toBe('bogus-team-name');
    expect(() => validateLearning(migrated)).toThrow(/scope must be one of/);
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — source_session derivation
// ---------------------------------------------------------------------------

describe('migrateLegacyLearning — v2 source_session derivation', () => {
  it('derives source_session from sessions[0] when source_session is absent', () => {
    const entry = { ...LEGACY(), schema_version: 1 };
    delete entry.source_session;
    entry.sessions = ['main-2026-04-27-1942', 'alt-session-2'];
    const migrated = migrateLegacyLearning(entry);
    expect(migrated.source_session).toBe('main-2026-04-27-1942');
    expect(() => validateLearning(migrated)).not.toThrow();
  });

  it('derives source_session from sessions[0] when source_session is empty string', () => {
    const entry = {
      ...LEGACY(),
      source_session: '',
      sessions: ['main-2026-04-28-0830'],
      schema_version: 1,
    };
    const migrated = migrateLegacyLearning(entry);
    expect(migrated.source_session).toBe('main-2026-04-28-0830');
    expect(() => validateLearning(migrated)).not.toThrow();
  });

  it('does NOT overwrite existing source_session with sessions[0]', () => {
    const entry = {
      ...LEGACY(),
      source_session: 'original-session',
      sessions: ['different-session'],
      schema_version: 1,
    };
    const migrated = migrateLegacyLearning(entry);
    expect(migrated.source_session).toBe('original-session');
  });

  it('does NOT derive source_session when sessions array is empty', () => {
    const entry = {
      ...LEGACY(),
      source_session: '',
      sessions: [],
      schema_version: 1,
    };
    const migrated = migrateLegacyLearning(entry);
    // sessions[] is empty, so derivation does not fire; source_session remains empty string
    expect(migrated.source_session).toBe('');
  });

  it('does NOT derive source_session when sessions is absent', () => {
    const entry = {
      ...LEGACY(),
      source_session: '',
      schema_version: 1,
    };
    delete entry.sessions;
    const migrated = migrateLegacyLearning(entry);
    // sessions is missing, derivation does not fire; source_session remains empty string
    expect(migrated.source_session).toBe('');
    expect('sessions' in migrated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — Combined coercion (both A + B in one pass)
// ---------------------------------------------------------------------------

describe('migrateLegacyLearning — v2 combined coercion', () => {
  it('applies both scope coercion and source_session derivation in one pass', () => {
    const entry = {
      id: 'test-id-combined',
      type: 'hardware-pattern',
      subject: 'combined-test',
      insight: 'combined test insight',
      evidence: 'combined test evidence',
      confidence: 0.8,
      created_at: '2026-04-01T00:00:00Z',
      expires_at: '2026-05-01T00:00:00Z',
      // source_session intentionally absent
      scope: 'vault-tools',
      sessions: ['main-2026-04-27-1942'],
      schema_version: 1,
    };
    const migrated = migrateLegacyLearning(entry);
    expect(migrated.scope).toBe('local');
    expect(migrated.source_session).toBe('main-2026-04-27-1942');
    expect(() => validateLearning(migrated)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — Idempotency
// ---------------------------------------------------------------------------

describe('migrateLegacyLearning — v2 idempotency', () => {
  it('running migration twice produces identical output', () => {
    const entry = {
      id: 'idem-test-v2',
      type: 'recurring-issue',
      subject: 'idempotent test',
      insight: 'v2 idempotent insight',
      evidence: 'v2 evidence',
      confidence: 0.75,
      created_at: '2026-04-01T00:00:00Z',
      scope: 'coordinator', // will be coerced to 'local'
      sessions: ['session-a', 'session-b'],
      // source_session absent, will be derived from sessions[0]
    };
    const once = migrateLegacyLearning(entry);
    const twice = migrateLegacyLearning(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(twice.scope).toBe('local');
    expect(twice.source_session).toBe('session-a');
  });
});
