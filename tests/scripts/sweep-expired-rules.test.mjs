/**
 * sweep-expired-rules.test.mjs — the CLI's roll-up (#1388 P7).
 *
 * TV-001 — the bug this catches: a HEADER-RAISE is an `action: 'rewrite'` plan
 * carrying `reason: 'header-raise'`, so it was folded into `rewrites` and
 * invisible on the human stdout line. Nothing else in the suite exercises
 * `summarize()` (census 2026-09-18: `grep -rn "summarize" tests/ docs/ skills/`
 * → no hit for this CLI), so dropping the counter again would be silent.
 */

import { describe, it, expect } from 'vitest';

import { summarize } from '../../scripts/sweep-expired-rules.mjs';

/** Minimal plan shape — only the fields `summarize()` reads. */
function planStub(plans) {
  return {
    plans: plans.map((p) => ({
      expiredPairIds: [],
      unresolvedPairIds: [],
      ...p,
    })),
    malformedLines: 0,
    ok: true,
    skipped: [],
  };
}

describe('summarize() — header-raise roll-up (#1388 P7)', () => {
  it('counts header-raises separately while keeping them inside rewrites', () => {
    const summary = summarize(
      planStub([
        { file: 'a.md', action: 'rewrite', reason: 'header-raise' },
        { file: 'b.md', action: 'rewrite', reason: 'expired-entries', expiredPairIds: ['x'] },
        { file: 'c.md', action: 'delete', reason: 'expired-entries' },
        { file: 'd.md', action: 'keep', reason: null },
      ]),
      { dryRun: true, graceDays: 0 },
      null,
    );

    expect(summary.rewrites).toBe(2); // header-raise is a SUBSET, not a sibling
    expect(summary.header_raises).toBe(1);
    expect(summary.deletes).toBe(1);
    expect(summary.keeps).toBe(1);
    expect(summary.files_scanned).toBe(4);
    expect(summary.expired_entries).toBe(1);
  });

  it('reports 0 header-raises when every rewrite has another reason', () => {
    const summary = summarize(
      planStub([{ file: 'a.md', action: 'rewrite', reason: 'expired-entries' }]),
      { dryRun: false, graceDays: 2 },
      null,
    );
    expect(summary.rewrites).toBe(1);
    expect(summary.header_raises).toBe(0);
  });
});
