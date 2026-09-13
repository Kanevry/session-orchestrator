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
});
