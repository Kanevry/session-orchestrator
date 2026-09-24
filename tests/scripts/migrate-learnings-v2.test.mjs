/**
 * tests/scripts/migrate-learnings-v2.test.mjs
 *
 * Vitest suite for learnings v2 migration enhancements (Wave 2 task C1).
 *
 * Changes under test:
 *   A. Scope-enum coercion: vault-tools, deep-sessions, wave-executor, coordinator → local
 *   B. source_session derivation: when missing/empty + sessions[] present, use sessions[0]
 *   C. Broken-consumer-record coercions (GitHub #69 / GitLab #1446), applied AFTER
 *      normalizeDialects: a repo-relative path in `scope` → appended to a COPIED
 *      `file_paths` + `scope: 'private'`; `project`/`repo` → `private`;
 *      `schema_version` "1" / 2 → 1. Anything not strictly path-shaped stays put.
 *
 * A and B run before schema_version stamping, C after the dialect pass; the
 * caller still runs validateLearning() on the result.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// ---------------------------------------------------------------------------
// Suite 6 — Broken-consumer-record coercions (GitHub #69 / GitLab #1446)
// ---------------------------------------------------------------------------

const GOLDEN = readFileSync(
  fileURLToPath(new URL('../fixtures/learnings-invalid-golden.jsonl', import.meta.url)),
  'utf8',
)
  .split('\n')
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l));

describe('migrateLegacyLearning — #1446 broken-consumer-record coercions', () => {
  it('moves a path-like scope into a new file_paths list and sets scope private', () => {
    const entry = { ...LEGACY(), schema_version: 1, scope: 'app/ui/demo-banner.tsx' };
    const migrated = migrateLegacyLearning(entry);
    expect(migrated.scope).toBe('private');
    expect(migrated.file_paths).toEqual(['app/ui/demo-banner.tsx']);
    expect(() => validateLearning(migrated)).not.toThrow();
  });

  it.each([
    ['missing from', ['lib/format/index.ts'], ['lib/format/index.ts', 'lib/format/price-label.ts']],
    ['already in', ['lib/format/price-label.ts'], ['lib/format/price-label.ts']],
  ])('path scope %s file_paths: result list is a copy, appended once, input untouched', (_label, existing, expected) => {
    // Frozen input: an in-place push/assign on the caller's array or object throws.
    const inputPaths = Object.freeze([...existing]);
    const entry = Object.freeze({
      ...LEGACY(),
      schema_version: 1,
      scope: 'lib/format/price-label.ts',
      file_paths: inputPaths,
    });
    const migrated = migrateLegacyLearning(entry);
    expect(migrated.file_paths).toEqual(expected);
    expect(migrated.file_paths).not.toBe(inputPaths);
    expect(migrated.scope).toBe('private');
    expect(entry.scope).toBe('lib/format/price-label.ts');
  });

  it('keeps legacy `files` ahead of the path scope: [files..., scope], no `files` key left', () => {
    const entry = {
      ...LEGACY(),
      schema_version: 1,
      scope: 'src/sample/list-view.tsx',
      files: ['src/sample/list-item.tsx'],
    };
    const migrated = migrateLegacyLearning(entry);
    expect(migrated.file_paths).toEqual(['src/sample/list-item.tsx', 'src/sample/list-view.tsx']);
    expect('files' in migrated).toBe(false);
    expect(migrated.scope).toBe('private');
  });

  it.each(['project', 'repo'])('coerces scope=%s to private', (scope) => {
    const migrated = migrateLegacyLearning({ ...LEGACY(), schema_version: 1, scope });
    expect(migrated.scope).toBe('private');
    expect('file_paths' in migrated).toBe(false);
    expect(() => validateLearning(migrated)).not.toThrow();
  });

  it.each([
    ['string "1"', '1', 1],
    ['number 2', 2, 1],
    ['legacy 0', 0, 0],
    ['current 1', 1, 1],
    ['absent', undefined, 1],
  ])('schema_version %s → %j', (_label, input, expected) => {
    const migrated = migrateLegacyLearning({ ...LEGACY(), scope: 'local', schema_version: input });
    expect(migrated.schema_version).toBe(expected);
  });

  it.each([
    'node.js',
    'infrastructure/docker-compose',
    'README.md',
    'bogus-team-name',
    '/abs/x.ts',
    '../x.ts',
    'src//x.ts',
    'src/a b.ts',
    'https://example.org/a.ts',
  ])('leaves non-path scope %j untouched (record stays invalid)', (scope) => {
    const migrated = migrateLegacyLearning({ ...LEGACY(), schema_version: 1, scope });
    expect(migrated.scope).toBe(scope);
    expect('file_paths' in migrated).toBe(false);
    expect(() => validateLearning(migrated)).toThrow(/scope must be one of/);
  });

  it('leaves a path scope untouched when file_paths is present but not an array', () => {
    const migrated = migrateLegacyLearning({
      ...LEGACY(),
      schema_version: 1,
      scope: 'src/x.ts',
      file_paths: 'src/y.ts',
    });
    expect(migrated.scope).toBe('src/x.ts');
    expect(migrated.file_paths).toBe('src/y.ts');
  });

  it.each(GOLDEN.map((r) => [r.id, r]))('golden record %s: migrating twice equals migrating once', (_id, record) => {
    const once = migrateLegacyLearning(record);
    const twice = migrateLegacyLearning(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });
});
