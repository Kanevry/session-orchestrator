/**
 * tests/lib/session-schema/normalizer.test.mjs
 *
 * Vitest suite for scripts/lib/session-schema/normalizer.mjs.
 * Covers: alias application, schema_version stamping, dedupe-warn,
 * non-clobber of existing canonical keys, malformed pass-through,
 * idempotence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizeSession } from '../../../scripts/lib/session-schema/normalizer.mjs';

let errSpy;
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Alias application
// ---------------------------------------------------------------------------

describe('normalizeSession — alias application', () => {
  it('aliases type → session_type and preserves original key', () => {
    const out = normalizeSession({ session_id: 'sess-1', type: 'deep' });
    expect(out.session_type).toBe('deep');
    expect(out.type).toBe('deep'); // original preserved for debugging
  });

  it('aliases closed_issues → issues_closed', () => {
    const out = normalizeSession({ session_id: 's', closed_issues: [1, 2] });
    expect(out.issues_closed).toEqual([1, 2]);
    expect(out.closed_issues).toEqual([1, 2]);
  });

  it('aliases waves_completed → total_waves', () => {
    const out = normalizeSession({ session_id: 's', waves_completed: 5 });
    expect(out.total_waves).toBe(5);
    expect(out.waves_completed).toBe(5); // original preserved
  });

  it('aliases head_ref → branch', () => {
    const out = normalizeSession({ session_id: 's', head_ref: 'main' });
    expect(out.branch).toBe('main');
  });

  it('aliases files_changed → total_files_changed', () => {
    const out = normalizeSession({ session_id: 's', files_changed: 7 });
    expect(out.total_files_changed).toBe(7);
  });

  it('does not overwrite an existing canonical key when alias also present', () => {
    const out = normalizeSession({
      session_id: 's',
      type: 'feature',
      session_type: 'deep',
    });
    expect(out.session_type).toBe('deep'); // canonical wins
    expect(out.type).toBe('feature'); // alias preserved
  });

  it('applies all aliases in a composite input', () => {
    const src = {
      session_id: 'sess-all',
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
});

// ---------------------------------------------------------------------------
// schema_version stamping
// ---------------------------------------------------------------------------

describe('normalizeSession — schema_version stamping', () => {
  it('tags missing schema_version as 0 (not CURRENT=1)', () => {
    const out = normalizeSession({ session_id: 'sess-no-ver', session_type: 'deep' });
    expect(out.schema_version).toBe(0);
  });

  it('preserves schema_version: 1 when already present', () => {
    const out = normalizeSession({ session_id: 's', schema_version: 1 });
    expect(out.schema_version).toBe(1);
    expect(errSpy).not.toHaveBeenCalled(); // no warn when version present
  });

  it('preserves schema_version: 0 when explicitly set', () => {
    const out = normalizeSession({ session_id: 's', schema_version: 0 });
    expect(out.schema_version).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Dedupe warn
// ---------------------------------------------------------------------------

describe('normalizeSession — dedupe warn', () => {
  it('emits WARN on the first call for a session_id missing schema_version', () => {
    const id = `sess-warn-${Date.now()}-${Math.random()}`;
    normalizeSession({ session_id: id });
    const hits = errSpy.mock.calls.filter((c) => String(c[0]).includes(`session_id=${id}`));
    expect(hits.length).toBe(1);
  });

  it('deduplicates: same session_id normalized 3 times logs only once', () => {
    const id = `sess-dedup-${Date.now()}-${Math.random()}`;
    normalizeSession({ session_id: id });
    normalizeSession({ session_id: id });
    normalizeSession({ session_id: id });
    const hits = errSpy.mock.calls.filter((c) => String(c[0]).includes(`session_id=${id}`));
    expect(hits.length).toBe(1);
  });

  it('uses <unknown> key when session_id is absent', () => {
    normalizeSession({ session_type: 'deep' });
    const hits = errSpy.mock.calls.filter((c) => String(c[0]).includes('session_id=<unknown>'));
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Malformed pass-through
// ---------------------------------------------------------------------------

describe('normalizeSession — malformed pass-through', () => {
  it('returns null unchanged', () => {
    expect(normalizeSession(null)).toBe(null);
  });

  it('returns string unchanged', () => {
    expect(normalizeSession('x')).toBe('x');
  });

  it('returns array by identity (arrays are not plain objects)', () => {
    const arr = [1, 2];
    expect(normalizeSession(arr)).toBe(arr);
  });

  it('returns undefined unchanged', () => {
    expect(normalizeSession(undefined)).toBe(undefined);
  });

  it('never throws on any input type', () => {
    expect(() => normalizeSession(null)).not.toThrow();
    expect(() => normalizeSession(42)).not.toThrow();
    expect(() => normalizeSession({ session_id: null })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------------------

describe('normalizeSession — idempotence', () => {
  it('normalize(normalize(x)) deep-equals normalize(x)', () => {
    const src = { session_id: 'sess-idem', type: 'deep', waves_total: 2 };
    const once = normalizeSession(src);
    const twice = normalizeSession(once);
    expect(twice).toEqual(once);
  });
});
