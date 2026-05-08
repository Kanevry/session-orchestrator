/**
 * tests/lib/learnings.test.mjs
 *
 * Vitest suite for scripts/lib/learnings.mjs (Sub-Epic #160 / issue #170).
 *
 * Covers: validator (legacy required fields, scope enum, host_class shape,
 * anonymized boolean, public-requires-anonymized, public-requires-host_class,
 * confidence bounds), normalizer (backward-compat defaults), I/O (append,
 * rewrite, read with malformed lines), filters (scope/host_class/type).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateLearning,
  normalizeLearning,
  migrateLegacyLearning,
  readLearnings,
  appendLearning,
  rewriteLearnings,
  filterByScope,
  filterByHostClass,
  filterByType,
  ValidationError,
  VALID_SCOPES,
  CURRENT_ANONYMIZATION_VERSION,
  CURRENT_SCHEMA_VERSION,
  deriveExpiresAt,
  LEARNING_TTL_DAYS,
} from '../../scripts/lib/learnings.mjs';

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

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'learnings-'));
});

afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// validateLearning — legacy shape
// ---------------------------------------------------------------------------

describe('validateLearning — legacy required fields', () => {
  it('accepts a minimal legacy-shape entry (defaults extended fields)', () => {
    const v = validateLearning(LEGACY());
    expect(v.scope).toBe('local');
    expect(v.host_class).toBe(null);
    expect(v.anonymized).toBe(false);
    expect(v).not.toHaveProperty('anonymization_version');
  });

  it('throws when a legacy required field is missing', () => {
    const bad = LEGACY();
    delete bad.evidence;
    expect(() => validateLearning(bad)).toThrow(ValidationError);
    expect(() => validateLearning(bad)).toThrow(/missing.*evidence/);
  });

  it('throws when entry is null/undefined', () => {
    expect(() => validateLearning(null)).toThrow(ValidationError);
    expect(() => validateLearning(undefined)).toThrow(ValidationError);
  });

  it('rejects confidence outside [0, 1]', () => {
    const lo = { ...LEGACY(), confidence: -0.1 };
    const hi = { ...LEGACY(), confidence: 1.1 };
    expect(() => validateLearning(lo)).toThrow(/confidence/);
    expect(() => validateLearning(hi)).toThrow(/confidence/);
  });

  it('rejects confidence of wrong type', () => {
    const bad = { ...LEGACY(), confidence: '0.5' };
    expect(() => validateLearning(bad)).toThrow(/confidence/);
  });
});

// ---------------------------------------------------------------------------
// validateLearning — scope enum
// ---------------------------------------------------------------------------

describe('validateLearning — scope enum', () => {
  it('accepts local, private, public', () => {
    for (const s of VALID_SCOPES) {
      const entry = { ...LEGACY(), scope: s };
      if (s === 'public') {
        entry.anonymized = true;
        entry.host_class = 'macos-arm64-m3pro';
      }
      expect(() => validateLearning(entry)).not.toThrow();
    }
  });

  it('rejects unknown scope values', () => {
    const bad = { ...LEGACY(), scope: 'secret' };
    expect(() => validateLearning(bad)).toThrow(/scope must be one of/);
  });

  it('defaults missing scope to local', () => {
    const v = validateLearning(LEGACY());
    expect(v.scope).toBe('local');
  });
});

// ---------------------------------------------------------------------------
// validateLearning — privacy contract
// ---------------------------------------------------------------------------

describe('validateLearning — privacy contract', () => {
  it('REJECTS scope=public with anonymized=false', () => {
    const bad = {
      ...LEGACY(),
      scope: 'public',
      anonymized: false,
      host_class: 'macos-arm64-m3pro',
    };
    expect(() => validateLearning(bad)).toThrow(ValidationError);
    expect(() => validateLearning(bad)).toThrow(/public.*anonymized=true/);
  });

  it('REJECTS scope=public with host_class=null', () => {
    const bad = {
      ...LEGACY(),
      scope: 'public',
      anonymized: true,
      host_class: null,
    };
    expect(() => validateLearning(bad)).toThrow(/public.*host_class/);
  });

  it('accepts scope=public when anonymized=true AND host_class is set', () => {
    const ok = {
      ...LEGACY(),
      scope: 'public',
      anonymized: true,
      host_class: 'macos-arm64-m3pro',
    };
    const v = validateLearning(ok);
    expect(v.scope).toBe('public');
    expect(v.anonymized).toBe(true);
    expect(v.host_class).toBe('macos-arm64-m3pro');
    expect(v.anonymization_version).toBe(CURRENT_ANONYMIZATION_VERSION);
  });

  it('scope=local allows host_class and anonymized to be absent (defaults)', () => {
    const v = validateLearning({ ...LEGACY(), scope: 'local' });
    expect(v.scope).toBe('local');
    expect(v.host_class).toBe(null);
    expect(v.anonymized).toBe(false);
  });

  it('scope=private does not require anonymized', () => {
    const ok = { ...LEGACY(), scope: 'private', anonymized: false };
    expect(() => validateLearning(ok)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateLearning — type checks on extended fields
// ---------------------------------------------------------------------------

describe('validateLearning — extended field shape', () => {
  it('rejects non-string host_class', () => {
    const bad = { ...LEGACY(), host_class: 42 };
    expect(() => validateLearning(bad)).toThrow(/host_class/);
  });

  it('accepts host_class=null explicitly', () => {
    const ok = { ...LEGACY(), host_class: null };
    expect(() => validateLearning(ok)).not.toThrow();
  });

  it('rejects non-boolean anonymized', () => {
    const bad = { ...LEGACY(), anonymized: 'yes' };
    expect(() => validateLearning(bad)).toThrow(/anonymized/);
  });

  it('strips anonymization_version when anonymized=false', () => {
    const entry = { ...LEGACY(), anonymized: false, anonymization_version: 99 };
    const v = validateLearning(entry);
    expect(v).not.toHaveProperty('anonymization_version');
  });

  it('preserves explicit anonymization_version when anonymized=true', () => {
    const entry = {
      ...LEGACY(),
      scope: 'public',
      anonymized: true,
      host_class: 'macos-arm64-m3pro',
      anonymization_version: 5,
    };
    const v = validateLearning(entry);
    expect(v.anonymization_version).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// normalizeLearning — backward compat
// ---------------------------------------------------------------------------

describe('normalizeLearning — backward compat', () => {
  it('defaults scope to local on legacy entries', () => {
    const n = normalizeLearning(LEGACY());
    expect(n.scope).toBe('local');
    expect(n.host_class).toBe(null);
    expect(n.anonymized).toBe(false);
  });

  it('preserves existing extended fields', () => {
    const entry = {
      ...LEGACY(),
      scope: 'private',
      host_class: 'linux-x86_64',
      anonymized: false,
    };
    const n = normalizeLearning(entry);
    expect(n.scope).toBe('private');
    expect(n.host_class).toBe('linux-x86_64');
  });

  it('passes through malformed input unchanged', () => {
    expect(normalizeLearning(null)).toBe(null);
    expect(normalizeLearning(undefined)).toBe(undefined);
    expect(normalizeLearning('string')).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// normalizeLearning — required-key WARN (issue #281)
// ---------------------------------------------------------------------------

describe('normalizeLearning — required-key WARN (issue #281)', () => {
  let warnSpy;
  beforeEach(() => {
    warnSpy = [];
    // Route console.error into warnSpy so we can assert on WARN output without
    // spamming the test output. Restored in afterEach.
    const orig = console.error;
    console.error = (msg) => warnSpy.push(String(msg));
    warnSpy._restore = () => { console.error = orig; };
  });
  afterEach(() => { if (warnSpy._restore) warnSpy._restore(); });

  it('emits WARN for a record missing required legacy fields', () => {
    // unique id to avoid dedupe collision with other tests in this suite
    normalizeLearning({ id: 'warn-test-missing-1', type: 'a', confidence: 0.5, subject: 's' });
    const hit = warnSpy.find((m) => m.includes('warn-test-missing-1') && m.includes('missing required legacy field(s)'));
    expect(hit).toBeTruthy();
    expect(hit).toMatch(/\[insight,.+source_session/);
  });

  it('dedupes WARN by <id>|<missing-fields> key', () => {
    normalizeLearning({ id: 'warn-test-dedupe', type: 'a', confidence: 0.5, subject: 's' });
    normalizeLearning({ id: 'warn-test-dedupe', type: 'a', confidence: 0.5, subject: 's' });
    normalizeLearning({ id: 'warn-test-dedupe', type: 'a', confidence: 0.5, subject: 's' });
    const hits = warnSpy.filter((m) => m.includes('warn-test-dedupe') && m.includes('missing required legacy field(s)'));
    expect(hits.length).toBe(1);
  });

  it('emits a distinct WARN when the same id has a different missing-field set', () => {
    // first call: missing insight+evidence+source_session+created_at+expires_at
    normalizeLearning({ id: 'warn-test-shape-shift', type: 'a', confidence: 0.5, subject: 's' });
    // second call: only missing expires_at (shape has shifted)
    normalizeLearning({
      id: 'warn-test-shape-shift',
      type: 'a',
      subject: 's',
      insight: 'i',
      evidence: [],
      confidence: 0.5,
      source_session: 'x',
      created_at: '2026-04-24T00:00:00Z',
    });
    const hits = warnSpy.filter((m) => m.includes('warn-test-shape-shift') && m.includes('missing required legacy field(s)'));
    expect(hits.length).toBe(2);
  });

  it('does NOT emit WARN for a complete legacy record', () => {
    normalizeLearning({ ...LEGACY(), id: 'warn-test-complete' });
    const hit = warnSpy.find((m) => m.includes('warn-test-complete') && m.includes('missing required legacy field(s)'));
    expect(hit).toBeFalsy();
  });

  it('uses <unknown> as id when record lacks id', () => {
    normalizeLearning({ type: 'a', confidence: 0.5, subject: 's' });
    const hit = warnSpy.find((m) => m.includes('id=<unknown>') && m.includes('missing required legacy field(s)'));
    expect(hit).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// readLearnings — JSONL I/O + malformed handling
// ---------------------------------------------------------------------------

describe('readLearnings', () => {
  it('returns empty arrays when file is absent', async () => {
    const r = await readLearnings(join(tmp, 'nowhere.jsonl'));
    expect(r.entries).toEqual([]);
    expect(r.malformed).toEqual([]);
  });

  it('parses JSONL lines, defaults extended fields on legacy entries', async () => {
    const path = join(tmp, 'learnings.jsonl');
    writeFileSync(path, JSON.stringify(LEGACY()) + '\n');
    const r = await readLearnings(path);
    expect(r.entries.length).toBe(1);
    expect(r.entries[0].scope).toBe('local');
    expect(r.entries[0].host_class).toBe(null);
    expect(r.entries[0].anonymized).toBe(false);
  });

  it('skips malformed lines and records them in malformed[]', async () => {
    const path = join(tmp, 'learnings.jsonl');
    writeFileSync(path, JSON.stringify(LEGACY()) + '\n' + 'not json\n' + JSON.stringify(LEGACY()) + '\n');
    const r = await readLearnings(path);
    expect(r.entries.length).toBe(2);
    expect(r.malformed).toEqual(['not json']);
  });

  it('ignores blank lines between valid entries', async () => {
    const path = join(tmp, 'learnings.jsonl');
    writeFileSync(path, JSON.stringify(LEGACY()) + '\n\n\n' + JSON.stringify(LEGACY()) + '\n');
    const r = await readLearnings(path);
    expect(r.entries.length).toBe(2);
    expect(r.malformed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// appendLearning / rewriteLearnings
// ---------------------------------------------------------------------------

describe('appendLearning', () => {
  it('validates before writing; invalid entry is not appended', async () => {
    const path = join(tmp, 'learnings.jsonl');
    const bad = { ...LEGACY(), scope: 'public', anonymized: false, host_class: 'x' };
    await expect(appendLearning(path, bad)).rejects.toThrow(ValidationError);
    expect(existsSync(path)).toBe(false);
  });

  it('appends one JSONL line per call', async () => {
    const path = join(tmp, 'learnings.jsonl');
    await appendLearning(path, LEGACY());
    await appendLearning(path, { ...LEGACY(), id: 'test-id-2' });
    const content = readFileSync(path, 'utf8');
    expect(content.trim().split('\n').length).toBe(2);
  });

  it('creates parent directory if missing', async () => {
    const path = join(tmp, 'nested', 'deep', 'learnings.jsonl');
    await appendLearning(path, LEGACY());
    expect(existsSync(path)).toBe(true);
  });

  it('returns the normalized entry with defaults applied', async () => {
    const path = join(tmp, 'learnings.jsonl');
    const r = await appendLearning(path, LEGACY());
    expect(r.scope).toBe('local');
    expect(r.host_class).toBe(null);
  });
});

describe('rewriteLearnings', () => {
  it('atomically replaces the file with the provided entries', async () => {
    const path = join(tmp, 'learnings.jsonl');
    writeFileSync(path, JSON.stringify(LEGACY()) + '\n');
    await rewriteLearnings(path, [
      { ...LEGACY(), id: 'new-1' },
      { ...LEGACY(), id: 'new-2' },
    ]);
    const { entries } = await readLearnings(path);
    expect(entries.map((e) => e.id)).toEqual(['new-1', 'new-2']);
  });

  it('validates every entry; one bad entry aborts the whole write', async () => {
    const path = join(tmp, 'learnings.jsonl');
    writeFileSync(path, JSON.stringify(LEGACY()) + '\n');
    const entries = [
      { ...LEGACY(), id: 'good' },
      { ...LEGACY(), id: 'bad', scope: 'public', anonymized: false, host_class: 'x' },
    ];
    await expect(rewriteLearnings(path, entries)).rejects.toThrow(ValidationError);
    // original file contents preserved
    const { entries: after } = await readLearnings(path);
    expect(after.length).toBe(1);
    expect(after[0].id).toBe('test-id-1');
  });
});

// ---------------------------------------------------------------------------
// filter helpers
// ---------------------------------------------------------------------------

describe('filter helpers', () => {
  const set = [
    { ...LEGACY(), id: 'a', type: 'recurring-issue', scope: 'local', host_class: null },
    { ...LEGACY(), id: 'b', type: 'hardware-pattern', scope: 'public', host_class: 'macos-arm64-m3pro', anonymized: true },
    { ...LEGACY(), id: 'c', type: 'hardware-pattern', scope: 'public', host_class: 'linux-x86_64', anonymized: true },
    { ...LEGACY(), id: 'd', type: 'fragile-file', scope: 'private', host_class: null },
  ];

  it('filterByScope single', () => {
    expect(filterByScope(set, 'public').map((e) => e.id).sort()).toEqual(['b', 'c']);
  });

  it('filterByScope multiple', () => {
    expect(filterByScope(set, ['local', 'private']).map((e) => e.id).sort()).toEqual(['a', 'd']);
  });

  it('filterByHostClass', () => {
    expect(filterByHostClass(set, 'macos-arm64-m3pro').map((e) => e.id)).toEqual(['b']);
  });

  it('filterByType', () => {
    expect(filterByType(set, 'hardware-pattern').map((e) => e.id).sort()).toEqual(['b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// migrateLegacyLearning — #303 schema drift fix
// ---------------------------------------------------------------------------

describe('migrateLegacyLearning — canonical record passes through unchanged', () => {
  it('returns a canonical schema_version:1 record unmodified (except deleting stale aliases)', () => {
    const canonical = LEGACY(); // already has insight + id + all required fields
    canonical.schema_version = 1;
    const result = migrateLegacyLearning(canonical);
    expect(result.id).toBe(canonical.id);
    expect(result.insight).toBe(canonical.insight);
    expect(result.schema_version).toBe(1);
    expect(result).not.toHaveProperty('description');
    expect(result).not.toHaveProperty('recommendation');
  });

  it('migrated canonical record passes validateLearning without throwing', () => {
    const canonical = { ...LEGACY(), schema_version: 1 };
    const migrated = migrateLegacyLearning(canonical);
    expect(() => validateLearning(migrated)).not.toThrow();
  });
});

describe('migrateLegacyLearning — missing id is auto-generated', () => {
  it('backfills a UUID when id is absent', () => {
    const noId = { ...LEGACY() };
    delete noId.id;
    const result = migrateLegacyLearning(noId);
    expect(typeof result.id).toBe('string');
    // UUID v4 pattern
    expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('each call generates a different UUID for distinct records', () => {
    const noId = { ...LEGACY() };
    delete noId.id;
    const a = migrateLegacyLearning({ ...noId });
    const b = migrateLegacyLearning({ ...noId });
    expect(a.id).not.toBe(b.id);
  });

  it('record with backfilled id passes validateLearning', () => {
    const noId = { ...LEGACY(), schema_version: 1 };
    delete noId.id;
    const migrated = migrateLegacyLearning(noId);
    expect(() => validateLearning(migrated)).not.toThrow();
  });
});

describe('migrateLegacyLearning — description alias → insight', () => {
  it('renames description to insight when insight is absent', () => {
    const descRecord = { ...LEGACY() };
    delete descRecord.insight;
    descRecord.description = 'some description text';
    const result = migrateLegacyLearning(descRecord);
    expect(result.insight).toBe('some description text');
    expect(result).not.toHaveProperty('description');
  });

  it('migrated description record passes validateLearning', () => {
    const descRecord = { ...LEGACY(), schema_version: 1 };
    delete descRecord.insight;
    descRecord.description = 'docker-compose env: blocks DO NOT auto-inherit host env vars';
    const migrated = migrateLegacyLearning(descRecord);
    expect(() => validateLearning(migrated)).not.toThrow();
    expect(migrated.insight).toBe('docker-compose env: blocks DO NOT auto-inherit host env vars');
  });
});

describe('migrateLegacyLearning — recommendation alias → insight', () => {
  it('renames recommendation to insight when insight is absent', () => {
    const recRecord = { ...LEGACY() };
    delete recRecord.insight;
    recRecord.recommendation = 'Always use .schema(X).from(Y) for non-public schemas';
    const result = migrateLegacyLearning(recRecord);
    expect(result.insight).toBe('Always use .schema(X).from(Y) for non-public schemas');
    expect(result).not.toHaveProperty('recommendation');
  });

  it('migrated recommendation record passes validateLearning', () => {
    const recRecord = { ...LEGACY(), schema_version: 1 };
    delete recRecord.insight;
    recRecord.recommendation = 'When querying a non-public schema with Supabase JS client, always use .schema(X).from(Y).';
    const migrated = migrateLegacyLearning(recRecord);
    expect(() => validateLearning(migrated)).not.toThrow();
  });
});

describe('migrateLegacyLearning — schema_version backfill', () => {
  it('stamps schema_version:1 when field is absent', () => {
    const legacy = { ...LEGACY() };
    delete legacy.schema_version;
    const result = migrateLegacyLearning(legacy);
    expect(result.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('stamps schema_version:1 when field is null', () => {
    const legacy = { ...LEGACY(), schema_version: null };
    const result = migrateLegacyLearning(legacy);
    expect(result.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('preserves existing schema_version:1 (idempotent)', () => {
    const v1 = { ...LEGACY(), schema_version: 1 };
    const result = migrateLegacyLearning(v1);
    expect(result.schema_version).toBe(1);
  });
});

describe('migrateLegacyLearning — idempotency', () => {
  it('running migration twice on a legacy record produces the same output as once', () => {
    const legacy = { ...LEGACY() };
    delete legacy.id;
    delete legacy.insight;
    legacy.description = 'idempotent test description';
    delete legacy.schema_version;

    const once = migrateLegacyLearning(legacy);
    const twice = migrateLegacyLearning(once);

    expect(twice.insight).toBe(once.insight);
    expect(twice.schema_version).toBe(once.schema_version);
    expect(twice.id).toBe(once.id); // same id preserved on second pass
    expect(twice).not.toHaveProperty('description');
  });
});

describe('validateLearning — missing id is rejected (canonical write gate)', () => {
  it('throws ValidationError when id field is missing', () => {
    const noId = { ...LEGACY(), schema_version: 1 };
    delete noId.id;
    expect(() => validateLearning(noId)).toThrow(ValidationError);
    expect(() => validateLearning(noId)).toThrow(/missing required field.*id/);
  });
});

// ---------------------------------------------------------------------------
// migrateLegacyLearning — observation / lesson aliases (#Wave-2 extension)
// ---------------------------------------------------------------------------

describe('migrateLegacyLearning — observation → insight alias', () => {
  it('renames observation to insight when insight is absent', () => {
    const entry = { ...LEGACY() };
    delete entry.insight;
    entry.observation = 'observed memory leak pattern in session';
    const result = migrateLegacyLearning(entry);
    expect(result.insight).toBe('observed memory leak pattern in session');
    expect(result).not.toHaveProperty('observation');
  });

  it('migrated observation record passes validateLearning', () => {
    const entry = { ...LEGACY(), schema_version: 1 };
    delete entry.insight;
    entry.observation = 'RAM pressure spikes above 95% trigger OOM';
    const migrated = migrateLegacyLearning(entry);
    expect(() => validateLearning(migrated)).not.toThrow();
    expect(migrated.insight).toBe('RAM pressure spikes above 95% trigger OOM');
  });

  it('does NOT overwrite existing insight with observation', () => {
    const entry = { ...LEGACY(), insight: 'existing insight', observation: 'some observation' };
    const result = migrateLegacyLearning(entry);
    expect(result.insight).toBe('existing insight');
    // observation key cleaned up since insight already present
    expect(result).not.toHaveProperty('observation');
  });
});

describe('migrateLegacyLearning — lesson → insight alias', () => {
  it('renames lesson to insight when insight is absent', () => {
    const entry = { ...LEGACY() };
    delete entry.insight;
    entry.lesson = 'always gate on memory before spawning agents';
    const result = migrateLegacyLearning(entry);
    expect(result.insight).toBe('always gate on memory before spawning agents');
    expect(result).not.toHaveProperty('lesson');
  });

  it('migrated lesson record passes validateLearning', () => {
    const entry = { ...LEGACY(), schema_version: 1 };
    delete entry.insight;
    entry.lesson = 'pnpm install --frozen-lockfile prevents lockfile drift in CI';
    const migrated = migrateLegacyLearning(entry);
    expect(() => validateLearning(migrated)).not.toThrow();
    expect(migrated.insight).toBe('pnpm install --frozen-lockfile prevents lockfile drift in CI');
  });
});

describe('migrateLegacyLearning — alias precedence (multiple aliases present)', () => {
  it('prefers description over observation when both present and no insight', () => {
    const entry = { ...LEGACY() };
    delete entry.insight;
    entry.description = 'from description field';
    entry.observation = 'from observation field';
    const result = migrateLegacyLearning(entry);
    // precedence: insight > description > recommendation > observation > lesson
    expect(result.insight).toBe('from description field');
  });

  it('prefers recommendation over observation when description absent and no insight', () => {
    const entry = { ...LEGACY() };
    delete entry.insight;
    entry.recommendation = 'from recommendation field';
    entry.observation = 'from observation field';
    const result = migrateLegacyLearning(entry);
    expect(result.insight).toBe('from recommendation field');
  });

  it('uses observation when only observation and lesson present (no insight/description/recommendation)', () => {
    const entry = { ...LEGACY() };
    delete entry.insight;
    entry.observation = 'from observation field';
    entry.lesson = 'from lesson field';
    const result = migrateLegacyLearning(entry);
    // observation takes priority over lesson
    expect(result.insight).toBe('from observation field');
  });
});

// ---------------------------------------------------------------------------
// migrateLegacyLearning — missing evidence defaults to ""
// ---------------------------------------------------------------------------

describe('migrateLegacyLearning — missing evidence defaults to empty string', () => {
  it('sets evidence to "" when field is absent', () => {
    const entry = { ...LEGACY() };
    delete entry.evidence;
    const result = migrateLegacyLearning(entry);
    expect(result.evidence).toBe('');
  });

  it('does not modify existing evidence value', () => {
    const entry = { ...LEGACY(), evidence: 'existing evidence data' };
    const result = migrateLegacyLearning(entry);
    expect(result.evidence).toBe('existing evidence data');
  });

  it('evidence="" is preserved unchanged (idempotent)', () => {
    const entry = { ...LEGACY(), evidence: '' };
    const result = migrateLegacyLearning(entry);
    expect(result.evidence).toBe('');
  });

  it('record with backfilled evidence passes validateLearning', () => {
    const entry = { ...LEGACY(), schema_version: 1 };
    delete entry.evidence;
    const migrated = migrateLegacyLearning(entry);
    expect(() => validateLearning(migrated)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// migrateLegacyLearning — expires_at derivation from created_at
// ---------------------------------------------------------------------------

describe('migrateLegacyLearning — expires_at derived from created_at (+30 days)', () => {
  it('sets expires_at 30 days after created_at when expires_at is absent', () => {
    const entry = { ...LEGACY(), created_at: '2026-04-01T00:00:00Z' };
    delete entry.expires_at;
    const result = migrateLegacyLearning(entry);
    expect(result.expires_at).toBe('2026-05-01T00:00:00.000Z');
  });

  it('does not overwrite existing expires_at', () => {
    const entry = { ...LEGACY(), expires_at: '2099-12-31T00:00:00Z', created_at: '2026-04-01T00:00:00Z' };
    const result = migrateLegacyLearning(entry);
    expect(result.expires_at).toBe('2099-12-31T00:00:00Z');
  });

  it('leaves expires_at absent when created_at is unparsable', () => {
    const entry = { ...LEGACY(), created_at: 'not-a-date' };
    delete entry.expires_at;
    const result = migrateLegacyLearning(entry);
    expect(result).not.toHaveProperty('expires_at');
  });

  it('leaves expires_at absent when created_at is absent', () => {
    const entry = { ...LEGACY() };
    delete entry.expires_at;
    delete entry.created_at;
    const result = migrateLegacyLearning(entry);
    expect(result).not.toHaveProperty('expires_at');
  });

  it('record with derived expires_at passes validateLearning', () => {
    const entry = { ...LEGACY(), schema_version: 1, created_at: '2026-04-01T00:00:00Z' };
    delete entry.expires_at;
    const migrated = migrateLegacyLearning(entry);
    expect(() => validateLearning(migrated)).not.toThrow();
    expect(migrated.expires_at).toBe('2026-05-01T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// migrateLegacyLearning — name → subject alias
// ---------------------------------------------------------------------------

describe('migrateLegacyLearning — name → subject alias', () => {
  it('renames name to subject when subject is absent', () => {
    const entry = { ...LEGACY() };
    delete entry.subject;
    entry.name = 'memory-pressure-pattern';
    const result = migrateLegacyLearning(entry);
    expect(result.subject).toBe('memory-pressure-pattern');
    expect(result).not.toHaveProperty('name');
  });

  it('does NOT overwrite existing subject with name', () => {
    const entry = { ...LEGACY(), subject: 'existing-subject', name: 'other-name' };
    const result = migrateLegacyLearning(entry);
    expect(result.subject).toBe('existing-subject');
  });

  it('name key is deleted when subject already exists', () => {
    const entry = { ...LEGACY(), subject: 'existing-subject', name: 'other-name' };
    const result = migrateLegacyLearning(entry);
    expect(result).not.toHaveProperty('name');
  });

  it('record with migrated name→subject passes validateLearning', () => {
    const entry = { ...LEGACY(), schema_version: 1 };
    delete entry.subject;
    entry.name = 'zombie-process-pattern';
    const migrated = migrateLegacyLearning(entry);
    expect(() => validateLearning(migrated)).not.toThrow();
    expect(migrated.subject).toBe('zombie-process-pattern');
  });
});

// ---------------------------------------------------------------------------
// migrateLegacyLearning — full idempotency with all new transforms
// ---------------------------------------------------------------------------

describe('migrateLegacyLearning — idempotency with new transforms', () => {
  it('running migration twice on a record with new aliases produces the same output', () => {
    const legacy = {
      id: 'idem-test-id',
      type: 'recurring-issue',
      name: 'test-subject-idem',
      observation: 'idem observation text',
      confidence: 0.7,
      source_session: 'test-session',
      created_at: '2026-04-01T00:00:00Z',
    };
    const once = migrateLegacyLearning(legacy);
    const twice = migrateLegacyLearning(once);
    expect(twice.insight).toBe(once.insight);
    expect(twice.subject).toBe(once.subject);
    expect(twice.evidence).toBe(once.evidence);
    expect(twice.expires_at).toBe(once.expires_at);
    expect(twice.schema_version).toBe(once.schema_version);
    expect(twice).not.toHaveProperty('observation');
    expect(twice).not.toHaveProperty('name');
  });
});

// ---------------------------------------------------------------------------
// REQUIRED_FIELDS contract regression tests
// Guards the writer-side validation contract so a future refactor cannot
// silently remove the insight / source_session requirement without red tests.
// ---------------------------------------------------------------------------

describe('REQUIRED_FIELDS contract regression tests', () => {
  it('validateLearning throws when insight is missing', () => {
    const entry = LEGACY();
    delete entry.insight;
    expect(() => validateLearning(entry)).toThrow(ValidationError);
    expect(() => validateLearning(entry)).toThrow('insight');
  });

  it('validateLearning throws when source_session is missing', () => {
    const entry = LEGACY();
    delete entry.source_session;
    expect(() => validateLearning(entry)).toThrow(ValidationError);
    expect(() => validateLearning(entry)).toThrow('source_session');
  });

  it('appendLearning rejects records missing insight', async () => {
    const filePath = join(tmp, 'contract-insight.jsonl');
    const entry = LEGACY();
    delete entry.insight;
    await expect(appendLearning(filePath, entry)).rejects.toThrow(ValidationError);
    expect(existsSync(filePath)).toBe(false);
  });

  it('appendLearning rejects records missing source_session', async () => {
    const filePath = join(tmp, 'contract-source-session.jsonl');
    const entry = LEGACY();
    delete entry.source_session;
    await expect(appendLearning(filePath, entry)).rejects.toThrow(ValidationError);
    expect(existsSync(filePath)).toBe(false);
  });

  // LEGACY_REQUIRED_FIELDS is declared `const` (not exported) in learnings.mjs.
  // The four validateLearning and appendLearning tests above are the actual
  // contract guard. The following test documents the field membership via the
  // public API surface: a fully valid entry passes, and entries missing either
  // field throw with the field name in the message.
  it('error messages identify the missing field by name', () => {
    const missingInsight = LEGACY();
    delete missingInsight.insight;
    let caught;
    try {
      validateLearning(missingInsight);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught.message).toContain('insight');

    const missingSource = LEGACY();
    delete missingSource.source_session;
    let caught2;
    try {
      validateLearning(missingSource);
    } catch (e) {
      caught2 = e;
    }
    expect(caught2).toBeInstanceOf(ValidationError);
    expect(caught2.message).toContain('source_session');
  });
});

// ---------------------------------------------------------------------------
// deriveExpiresAt — issue #323 (W2 — type-specific TTL derivation)
// ---------------------------------------------------------------------------

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

describe('deriveExpiresAt', () => {
  it('happy path: mode-selector-accuracy returns +30 days exactly', () => {
    const result = deriveExpiresAt('2026-05-01T00:00:00Z', 'mode-selector-accuracy');
    expect(result).toBe('2026-05-31T00:00:00.000Z');
  });

  it('default fallback: unknown type returns +60 days', () => {
    const result = deriveExpiresAt('2026-05-01T00:00:00Z', 'totally-unknown-type-xyz');
    expect(result).toBe('2026-06-30T00:00:00.000Z');
  });

  it('unparseable createdAt returns a non-undefined ISO string (Date.now() fallback)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T12:00:00.000Z'));
    try {
      const result = deriveExpiresAt('not-a-date', 'fragile-file');
      expect(result).not.toBeUndefined();
      expect(typeof result).toBe('string');
      expect(result).toMatch(ISO_8601_RE);
      // 2026-05-08 + 45 days (fragile-file TTL) = 2026-06-22
      expect(result).toBe('2026-06-22T12:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('missing createdAt (undefined) falls back to now() + TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T00:00:00.000Z'));
    try {
      const result = deriveExpiresAt(undefined, 'workflow-pattern');
      // 2026-05-08 + 90 days (workflow-pattern TTL) = 2026-08-06
      expect(result).toBe('2026-08-06T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('all 9 keys in LEARNING_TTL_DAYS round-trip correctly', () => {
    const baseIso = '2026-05-01T00:00:00Z';
    const baseMs = Date.parse(baseIso);
    const keys = Object.keys(LEARNING_TTL_DAYS);
    // Sanity: confirm we have at least the 9 named keys + 'default' (10 total)
    expect(keys.length).toBeGreaterThanOrEqual(10);

    for (const key of keys) {
      const ttlDays = LEARNING_TTL_DAYS[key];
      const expectedMs = baseMs + ttlDays * 86400 * 1000;
      const expectedIso = new Date(expectedMs).toISOString();
      const result = deriveExpiresAt(baseIso, key === 'default' ? 'a-type-not-mapped' : key);
      expect(result).toBe(expectedIso);
    }
  });

  it('returns ISO 8601 formatted string', () => {
    const result = deriveExpiresAt('2026-05-01T00:00:00Z', 'recurring-issue');
    expect(result).toMatch(ISO_8601_RE);
  });
});

// ---------------------------------------------------------------------------
// appendLearning — auto-stamp expires_at + created_at (issue #323)
// ---------------------------------------------------------------------------

describe('appendLearning — auto-stamp expires_at and created_at (#323)', () => {
  it('auto-stamps expires_at when caller omits it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T00:00:00.000Z'));
    try {
      const filePath = join(tmp, 'autostamp-expires.jsonl');
      const entry = LEGACY();
      delete entry.expires_at;
      // Keep created_at for predictable expiry derivation
      entry.created_at = '2026-05-01T00:00:00Z';
      entry.type = 'mode-selector-accuracy'; // 30d TTL
      await appendLearning(filePath, entry);

      const content = readFileSync(filePath, 'utf8').trim();
      const written = JSON.parse(content);
      expect(written.expires_at).toBe('2026-05-31T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('respects caller-supplied expires_at (idempotent: callers value wins)', async () => {
    const filePath = join(tmp, 'caller-supplied-expires.jsonl');
    const entry = { ...LEGACY(), expires_at: '2099-12-31T00:00:00.000Z' };
    await appendLearning(filePath, entry);

    const content = readFileSync(filePath, 'utf8').trim();
    const written = JSON.parse(content);
    expect(written.expires_at).toBe('2099-12-31T00:00:00.000Z');
  });

  it('sets created_at to now() ISO when caller omits it', async () => {
    vi.useFakeTimers();
    const fakeNow = new Date('2026-05-08T15:30:45.000Z');
    vi.setSystemTime(fakeNow);
    try {
      const filePath = join(tmp, 'autostamp-created.jsonl');
      const entry = LEGACY();
      delete entry.created_at;
      delete entry.expires_at;
      await appendLearning(filePath, entry);

      const content = readFileSync(filePath, 'utf8').trim();
      const written = JSON.parse(content);
      expect(written.created_at).toBe('2026-05-08T15:30:45.000Z');
      expect(written.created_at).toMatch(ISO_8601_RE);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses type-specific TTL (autopilot-effectiveness → 90d) not default', async () => {
    const filePath = join(tmp, 'autopilot-ttl.jsonl');
    const entry = { ...LEGACY(), type: 'autopilot-effectiveness', created_at: '2026-05-01T00:00:00Z' };
    delete entry.expires_at;
    await appendLearning(filePath, entry);

    const content = readFileSync(filePath, 'utf8').trim();
    const written = JSON.parse(content);
    // 2026-05-01 + 90 days = 2026-07-30
    expect(written.expires_at).toBe('2026-07-30T00:00:00.000Z');
    // Sanity: ensure NOT the 60d default
    expect(written.expires_at).not.toBe('2026-06-30T00:00:00.000Z');
  });

  it('caller-supplied empty-string expires_at is treated as omitted (auto-derives)', async () => {
    const filePath = join(tmp, 'empty-expires.jsonl');
    const entry = {
      ...LEGACY(),
      expires_at: '',
      created_at: '2026-05-01T00:00:00Z',
      type: 'fragile-file', // 45d
    };
    await appendLearning(filePath, entry);

    const content = readFileSync(filePath, 'utf8').trim();
    const written = JSON.parse(content);
    // 2026-05-01 + 45 days = 2026-06-15
    expect(written.expires_at).toBe('2026-06-15T00:00:00.000Z');
  });
});
