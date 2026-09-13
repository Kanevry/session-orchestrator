/**
 * tests/lib/learnings/sizing-subject.test.mjs
 *
 * GitLab #1247 acceptance: a 7-wave `{deep, ultradeep}` session and a 5-wave
 * `{deep, null}` session must land on DIFFERENT `effective-sizing` subjects.
 * Before this module, the analyzer keyed its subject on `session_type` alone
 * (`deep-session-sizing`), so the two profiles silently collided on one row.
 *
 * `{deep, null}` must additionally equal the pre-#1247 literal byte-for-byte —
 * otherwise every learning keyed before this change stops matching on re-run.
 */

import { describe, it, expect } from 'vitest';
import { sizingSubject } from '../../../scripts/lib/learnings/sizing-subject.mjs';

describe('sizingSubject (#1247)', () => {
  it('keys a plain deep session on the byte-identical legacy literal', () => {
    expect(sizingSubject({ session_type: 'deep', session_profile: null })).toBe('deep-session-sizing');
  });

  it('keys a deep+ultradeep session on a distinct, exact literal', () => {
    expect(sizingSubject({ session_type: 'deep', session_profile: 'ultradeep' })).toBe(
      'deep-ultradeep-session-sizing'
    );
  });

  it('never collides deep+ultradeep with plain deep — the #1247 bug this module fixes', () => {
    const ultradeep = sizingSubject({ session_type: 'deep', session_profile: 'ultradeep' });
    const plainDeep = sizingSubject({ session_type: 'deep', session_profile: null });
    expect(ultradeep).not.toBe(plainDeep);
  });

  it('treats an absent session_profile key the same as null (feature sessions unaffected)', () => {
    expect(sizingSubject({ session_type: 'feature' })).toBe('feature-session-sizing');
  });

  it('keys a record with no usable session_type on `unknown`, never on a bare suffix', () => {
    // The collision this pins is the #1247 bug in its second form: if the
    // missing-type fallback were '' (or dropped), every type-less record would
    // key on '-session-sizing' and merge onto ONE row — the same silent
    // averaging, arriving from the other side. `.orchestrator/metrics/sessions.jsonl`
    // really does carry `session_type: "unknown"` records, and since #1363
    // `check-unwired-features.mjs` re-derives written subjects from exactly this
    // function, so a bare-suffix subject would also read as correct there.
    expect(sizingSubject({ session_type: '   ' })).toBe('unknown-session-sizing');
    expect(sizingSubject({})).toBe('unknown-session-sizing');
  });
});
