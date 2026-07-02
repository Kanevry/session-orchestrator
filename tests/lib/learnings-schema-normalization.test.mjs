/**
 * tests/lib/learnings-schema-normalization.test.mjs
 *
 * Vitest suite for the Epic #723 B2 producer-DIALECT normalization added to
 * scripts/lib/learnings/schema.mjs:
 *   - normalizeDialects()       — the pure dialect mapper (standalone)
 *   - normalizeLearning()       — read funnel: dialects applied, schema_version
 *                                 read behaviour UNCHANGED (0 for missing)
 *   - migrateLegacyLearning()   — write funnel: dialects + schema_version:1 stamp
 *
 * Covers every mapping in the B2 census: files→file_paths (incl. empty array +
 * canonical-wins), session_id reconciliation (exact-dup drop / genuine conflict /
 * orphan), last_seen→updated_at, next_review:null drop, timestamp re-serialization,
 * and the documented NON-actions (evidence_sessions kept, evidence-array not coerced).
 *
 * Sibling test tests/lib/learnings.test.mjs (owned separately) is NOT touched.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  normalizeDialects,
  normalizeLearning,
  migrateLegacyLearning,
} from '../../scripts/lib/learnings/schema.mjs';
import { classifyLearning } from '../../scripts/lib/reconcile/eligibility.mjs';

// A minimal valid legacy record (pre-dialect-normalization). Fork with spread.
const BASE = () => ({
  id: 'base-id',
  type: 'anti-pattern',
  subject: 'base-subject',
  insight: 'base insight',
  evidence: 'base evidence',
  confidence: 0.5,
  source_session: 'main-2026-04-19-0900',
  created_at: '2026-04-19T00:00:00Z',
  expires_at: '2026-05-19T00:00:00Z',
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// normalizeDialects — files → file_paths
// ---------------------------------------------------------------------------

describe('normalizeDialects — files → file_paths', () => {
  it('renames a non-empty files array verbatim to file_paths', () => {
    const r = normalizeDialects({ files: ['scripts/a.mjs', 'scripts/b.mjs'] });
    expect(r.file_paths).toEqual(['scripts/a.mjs', 'scripts/b.mjs']);
    expect('files' in r).toBe(false);
  });

  it('preserves an empty files array as an empty file_paths (never dropped)', () => {
    const r = normalizeDialects({ files: [] });
    expect(r.file_paths).toEqual([]);
    expect('files' in r).toBe(false);
  });

  it('keeps a canonical file_paths and drops the legacy files (canonical wins)', () => {
    const r = normalizeDialects({ files: ['legacy.mjs'], file_paths: ['canon.mjs'] });
    expect(r.file_paths).toEqual(['canon.mjs']);
    expect('files' in r).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeDialects — session_id reconciliation
// ---------------------------------------------------------------------------

describe('normalizeDialects — session_id vs source_session', () => {
  it('drops session_id when it exactly duplicates source_session', () => {
    const r = normalizeDialects({ source_session: 's1', session_id: 's1' });
    expect('session_id' in r).toBe(false);
    expect(r.source_session).toBe('s1');
  });

  it('keeps BOTH on a genuine conflict and logs once (source_session wins)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = normalizeDialects({
      id: 'conflict-uniq-a',
      source_session: 's1',
      session_id: 's2',
    });
    expect(r.source_session).toBe('s1');
    expect(r.session_id).toBe('s2');
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toMatch(/session_id.*conflicts with source_session/);
  });

  it('leaves an orphan session_id (no source_session) untouched', () => {
    const r = normalizeDialects({ session_id: 's2' });
    expect(r.session_id).toBe('s2');
  });
});

// ---------------------------------------------------------------------------
// normalizeDialects — last_seen → updated_at
// ---------------------------------------------------------------------------

describe('normalizeDialects — last_seen → updated_at', () => {
  it('renames last_seen to updated_at when updated_at is missing (and re-serializes)', () => {
    const r = normalizeDialects({ last_seen: '2026-05-01T00:00:00Z' });
    expect(r.updated_at).toBe('2026-05-01T00:00:00.000Z');
    expect('last_seen' in r).toBe(false);
  });

  it('keeps BOTH when updated_at already present (no overwrite)', () => {
    const r = normalizeDialects({
      updated_at: '2026-05-02T00:00:00.000Z',
      last_seen: '2026-05-01T00:00:00Z',
    });
    expect(r.updated_at).toBe('2026-05-02T00:00:00.000Z');
    expect(r.last_seen).toBe('2026-05-01T00:00:00Z');
  });

  it('treats updated_at:null as missing and moves last_seen into it', () => {
    const r = normalizeDialects({ updated_at: null, last_seen: '2026-05-01T00:00:00Z' });
    expect(r.updated_at).toBe('2026-05-01T00:00:00.000Z');
    expect('last_seen' in r).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeDialects — next_review + timestamps
// ---------------------------------------------------------------------------

describe('normalizeDialects — next_review + timestamp re-serialization', () => {
  it('drops next_review when it is literal null', () => {
    const r = normalizeDialects({ next_review: null });
    expect('next_review' in r).toBe(false);
  });

  it('keeps and re-serializes a real next_review timestamp', () => {
    const r = normalizeDialects({ next_review: '2026-06-01T00:00:00Z' });
    expect(r.next_review).toBe('2026-06-01T00:00:00.000Z');
  });

  it('re-serializes no-millis timestamps to canonical millis+Z (same instant)', () => {
    const r = normalizeDialects({
      created_at: '2026-04-19T00:00:00Z',
      expires_at: '2026-05-19T00:00:00Z',
    });
    expect(r.created_at).toBe('2026-04-19T00:00:00.000Z');
    expect(r.expires_at).toBe('2026-05-19T00:00:00.000Z');
    // Same instant — re-serialization is lossless.
    expect(Date.parse(r.created_at)).toBe(Date.parse('2026-04-19T00:00:00Z'));
    expect(Date.parse(r.expires_at)).toBe(Date.parse('2026-05-19T00:00:00Z'));
  });

  it('leaves an unparseable timestamp verbatim', () => {
    const r = normalizeDialects({ created_at: 'not-a-date' });
    expect(r.created_at).toBe('not-a-date');
  });
});

// ---------------------------------------------------------------------------
// normalizeDialects — documented NON-actions
// ---------------------------------------------------------------------------

describe('normalizeDialects — documented invariants (non-actions)', () => {
  it('does NOT collapse evidence_sessions[] into source_session', () => {
    const r = normalizeDialects({ evidence_sessions: ['s1', 's2'], source_session: 's0' });
    expect(r.evidence_sessions).toEqual(['s1', 's2']);
    expect(r.source_session).toBe('s0');
  });

  it('does NOT coerce an array-shaped evidence field', () => {
    const r = normalizeDialects({ evidence: ['e1', 'e2'] });
    expect(r.evidence).toEqual(['e1', 'e2']);
  });

  it('does not mutate its input object', () => {
    const input = { files: ['a.mjs'], created_at: '2026-04-19T00:00:00Z' };
    normalizeDialects(input);
    expect(input).toEqual({ files: ['a.mjs'], created_at: '2026-04-19T00:00:00Z' });
  });

  it('passes non-objects (null / undefined / array) through unchanged', () => {
    expect(normalizeDialects(null)).toBe(null);
    expect(normalizeDialects(undefined)).toBe(undefined);
    const arr = [1, 2];
    expect(normalizeDialects(arr)).toBe(arr);
  });

  it('is idempotent — a second pass produces the identical serialized shape', () => {
    const once = normalizeDialects({
      files: ['a.mjs'],
      created_at: '2026-04-19T00:00:00Z',
      last_seen: '2026-05-01T00:00:00Z',
    });
    const twice = normalizeDialects(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });
});

// ---------------------------------------------------------------------------
// normalizeLearning (read funnel) — dialects applied, schema_version unchanged
// ---------------------------------------------------------------------------

describe('normalizeLearning — read funnel applies dialects, keeps schema_version behaviour', () => {
  it('exposes file_paths from a legacy files record on read', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const n = normalizeLearning({ ...BASE(), id: 'read-files-1', files: ['scripts/x.mjs'] });
    expect(n.file_paths).toEqual(['scripts/x.mjs']);
    expect('files' in n).toBe(false);
  });

  it('still reads a missing schema_version as 0 (read-path behaviour UNCHANGED)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const n = normalizeLearning({ ...BASE(), id: 'read-sv-1', files: ['scripts/x.mjs'] });
    expect(n.schema_version).toBe(0);
  });

  it('drops a duplicate session_id on read', () => {
    const n = normalizeLearning({
      ...BASE(),
      id: 'read-sid-1',
      schema_version: 1,
      session_id: 'main-2026-04-19-0900',
    });
    expect('session_id' in n).toBe(false);
    expect(n.source_session).toBe('main-2026-04-19-0900');
  });

  it('canonicalizes no-millis timestamps to millis+Z on read', () => {
    const n = normalizeLearning({ ...BASE(), id: 'read-ts-1', schema_version: 1 });
    expect(n.created_at).toBe('2026-04-19T00:00:00.000Z');
    expect(n.expires_at).toBe('2026-05-19T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// migrateLegacyLearning (write funnel) — dialects + schema_version:1
// ---------------------------------------------------------------------------

describe('migrateLegacyLearning — write funnel applies dialects + stamps schema_version:1', () => {
  it('renames files→file_paths and stamps schema_version:1', () => {
    const m = migrateLegacyLearning({ ...BASE(), id: 'mig-1', files: ['scripts/x.mjs'] });
    expect(m.file_paths).toEqual(['scripts/x.mjs']);
    expect('files' in m).toBe(false);
    expect(m.schema_version).toBe(1);
  });

  it('preserves timestamps byte-exact during migration (format canonicalization is read/backfill only)', () => {
    // migrateLegacyLearning keeps its byte-exact "does not overwrite an existing
    // expires_at" contract — timestamp FORMAT is canonicalized on read/backfill.
    const m = migrateLegacyLearning({ ...BASE(), id: 'mig-2' });
    expect(m.created_at).toBe('2026-04-19T00:00:00Z');
    expect(m.expires_at).toBe('2026-05-19T00:00:00Z');
  });

  it('makes a migrated anti-pattern+files record reconcile-eligible (end-to-end)', () => {
    // The B2 fix in one assertion: a legacy `files` record was invisible to the
    // reconcile eligibility gate (reads file_paths); post-migration it converts.
    const legacy = { ...BASE(), id: 'mig-elig-1', type: 'anti-pattern', files: ['scripts/x.mjs'] };
    expect(classifyLearning(legacy).eligible).toBe(false); // pre-migration: no file_paths
    const migrated = migrateLegacyLearning(legacy);
    expect(classifyLearning(migrated).eligible).toBe(true); // post-migration: file_paths present
  });
});
