/**
 * tests/lib/session-schema/normalizer.test.mjs
 *
 * Vitest suite for scripts/lib/session-schema/normalizer.mjs.
 * Covers: alias application, schema_version stamping, dedupe-warn,
 * non-clobber of existing canonical keys, malformed pass-through,
 * idempotence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizeSession } from '@lib/session-schema/normalizer.mjs';

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
  it('tags missing schema_version as 0 (not CURRENT=2)', () => {
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

// ---------------------------------------------------------------------------
// express_path — legacy object form collapsed onto the canonical boolean
//
// Synthetic fixtures only. The live .orchestrator/metrics/sessions.jsonl is
// gitignored (absent on CI) and measuring the living tree would punish its own
// repair; the shapes below are copied from the 2026-08-23 census by hand.
// ---------------------------------------------------------------------------

/** The one real object-form record, shape-for-shape (main-2026-05-01-housekeeping-2). */
const LEGACY_EXPRESS_OBJECT = () => ({
  session_id: 'sess-express-legacy',
  session_type: 'housekeeping',
  schema_version: 1,
  express_path: {
    activated: true,
    tasks: 3,
    notes: 'Cross-repo migrate-v2 --apply + promote-vault-strict --apply',
  },
});

describe('normalizeSession — express_path canonical form', () => {
  it('collapses the legacy object onto the boolean carried by `activated`', () => {
    const out = normalizeSession(LEGACY_EXPRESS_OBJECT());
    expect(out.express_path).toBe(true);
  });

  it('collapses {activated: false} to false — an object is TRUTHY, so a consumer branching on `express_path` would have counted a declined express path as taken', () => {
    // The bug in one line: Boolean({activated: false}) === true. Any reader
    // doing `if (r.express_path)` or `r.express_path === true ? ... : ...`
    // mis-classifies the record before this collapse. 14 of the 21 live
    // records are `false`, i.e. they ARE the denominator of "greift er?".
    expect(Boolean({ activated: false })).toBe(true); // the trap, pinned
    const out = normalizeSession({
      session_id: 'sess-express-declined',
      schema_version: 1,
      express_path: { activated: false, tasks: 0 },
    });
    expect(out.express_path).toBe(false);
    expect(typeof out.express_path).toBe('boolean');
  });

  it('preserves the pre-collapse object verbatim under _express_path_detail', () => {
    // Bug: a collapse that keeps only `activated` silently destroys `tasks`
    // and `notes` — the only copy of them, since the ledger is append-only.
    const src = LEGACY_EXPRESS_OBJECT();
    const out = normalizeSession(src);
    expect(out._express_path_detail).toEqual(src.express_path);
    expect(out._express_path_detail.tasks).toBe(3);
  });

  it('leaves an already-canonical boolean untouched and writes no sidecar', () => {
    // Bug: an over-eager normalizer that wraps or re-shapes the 20 records
    // that are already canonical.
    for (const v of [true, false]) {
      const out = normalizeSession({ session_id: `sess-b-${v}`, schema_version: 1, express_path: v });
      expect(out.express_path).toBe(v);
      expect('_express_path_detail' in out).toBe(false);
    }
  });

  it('is idempotent on the legacy object — the second pass must not overwrite the sidecar with the collapsed boolean', () => {
    // Bug: without the non-clobber guard, normalize(normalize(x)) would set
    // _express_path_detail to the already-collapsed boolean and lose the
    // original object on any double-normalized read path.
    const once = normalizeSession(LEGACY_EXPRESS_OBJECT());
    const twice = normalizeSession(once);
    expect(twice).toEqual(once);
    expect(twice._express_path_detail).toEqual(LEGACY_EXPRESS_OBJECT().express_path);
  });

  it('passes unrecognised shapes through untouched and never throws', () => {
    // Bug: normalizeSession's documented "never throws / malformed passes
    // through" contract broken for a shape the collapse cannot recognise.
    // Refusing these is the write path's job (validator.mjs), not the reader's.
    for (const bad of ['yes', 7, [1], { tasks: 3 }, { activated: 'true' }, null]) {
      const src = { session_id: 'sess-express-weird', schema_version: 1, express_path: bad };
      let out;
      expect(() => {
        out = normalizeSession(src);
      }).not.toThrow();
      expect(out.express_path).toEqual(bad);
      expect('_express_path_detail' in out).toBe(false);
    }
  });

  it('leaves records without express_path alone (no key invented)', () => {
    const out = normalizeSession({ session_id: 'sess-no-express', schema_version: 1 });
    expect('express_path' in out).toBe(false);
    expect('_express_path_detail' in out).toBe(false);
  });
});
