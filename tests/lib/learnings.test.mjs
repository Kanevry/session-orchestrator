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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateLearning,
  normalizeLearning,
  readLearnings,
  appendLearning,
  rewriteLearnings,
  filterByScope,
  filterByHostClass,
  filterByType,
  ValidationError,
  VALID_SCOPES,
  CURRENT_ANONYMIZATION_VERSION,
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
