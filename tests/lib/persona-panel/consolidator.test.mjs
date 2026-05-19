/**
 * tests/lib/persona-panel/consolidator.test.mjs
 *
 * Vitest tests for scripts/lib/persona-panel/consolidator.mjs (issue #457).
 *
 * Pure-function tests — no I/O, no mocks. Each test constructs a synthetic
 * persona-output array and a parsed-threshold config, then asserts on the
 * ConsolidationResult shape.
 *
 * Test list (18 tests):
 *   Modes:
 *     1.  voting-quorum 6/6 pass, threshold 5-of-6 → PROCEED
 *     2.  voting-quorum 5/6 pass, threshold 5-of-6 → PROCEED_WITH_FOLLOWUPS (inclusive)
 *     3.  voting-quorum 4/6 pass, threshold 5-of-6 → BLOCKED
 *     4.  voting-quorum 3/6 pass + 3/6 fail (split-verdict), threshold 4-of-6 → BLOCKED
 *     5.  hard-gate-threshold 6/6 pass, threshold "all" → PROCEED
 *     6.  hard-gate-threshold 5/6 pass, threshold "all" → BLOCKED (off-by-one)
 *     7.  hard-gate-threshold 6/6 pass, threshold 6-of-6 → PROCEED (explicit equality)
 *     8.  hard-gate-threshold 5/6 pass, threshold 6-of-6 → BLOCKED
 *     9.  coordinator-summary → REQUIRES_COORDINATOR (no compute)
 *    10. Empty outputs array → BLOCKED with notes ['no persona outputs']
 *   Parse-error / error-vote handling:
 *    11. parse-error counts as FAIL: 5 pass + 1 parse-error, threshold "all" → BLOCKED
 *    12. compile-error counts as FAIL: 4 pass + 2 compile-error, threshold 4-of-6 → BLOCKED
 *    13. validation-failed counts as FAIL
 *    14. Dispatch-error (treated as non-validated mode "error") counts as FAIL
 *    15. Timeout mode counts as FAIL
 *   Dissenting personas detection:
 *    16. 5 pass / 1 fail (majority pass) → dissenting_personas contains the 1 failing name
 *    17. Tie (3 pass / 3 fail, threshold 4-of-6) → final BLOCKED, dissenters are the 3 PASS personas
 *   Tie-break flag:
 *    18. tie_break_applied=true when pass count equals threshold m exactly
 *
 * Falsification check: every test asserts on concrete result fields. Replacing
 * consolidate's body with `throw new Error()` fails every test.
 */

import { describe, it, expect } from 'vitest';
import {
  consolidate,
  CONSOLIDATION_MODES,
  FINAL_VERDICTS,
} from '../../../scripts/lib/persona-panel/consolidator.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a validated PASS persona output. */
function pass(name) {
  return { persona_name: name, mode: 'validated', verdict: 'pass' };
}

/** Build a validated FAIL persona output. */
function fail(name) {
  return { persona_name: name, mode: 'validated', verdict: 'fail' };
}

/** Build a non-validated persona output (parse-error / compile-error / etc.). */
function nonValidated(name, mode) {
  return { persona_name: name, mode };
}

const MOFN_5_OF_6 = { kind: 'm-of-n', m: 5, n: 6 };
const MOFN_4_OF_6 = { kind: 'm-of-n', m: 4, n: 6 };
const MOFN_6_OF_6 = { kind: 'm-of-n', m: 6, n: 6 };
const ALL = { kind: 'all' };

// ---------------------------------------------------------------------------
// Exported constants (sanity pins)
// ---------------------------------------------------------------------------

describe('CONSOLIDATION_MODES', () => {
  it('exports exactly the three known modes in canonical order', () => {
    expect(CONSOLIDATION_MODES).toEqual([
      'voting-quorum',
      'hard-gate-threshold',
      'coordinator-summary',
    ]);
  });
});

describe('FINAL_VERDICTS', () => {
  it('exports exactly the four known verdicts in canonical order', () => {
    expect(FINAL_VERDICTS).toEqual([
      'PROCEED',
      'PROCEED_WITH_FOLLOWUPS',
      'BLOCKED',
      'REQUIRES_COORDINATOR',
    ]);
  });
});

// ---------------------------------------------------------------------------
// voting-quorum mode
// ---------------------------------------------------------------------------

describe('consolidate — voting-quorum', () => {
  it('returns PROCEED when 6/6 pass with threshold 5-of-6 (unanimous)', () => {
    const outputs = ['a', 'b', 'c', 'd', 'e', 'f'].map(pass);
    const result = consolidate(outputs, 'voting-quorum', { threshold: MOFN_5_OF_6 });
    expect(result.final_verdict).toBe('PROCEED');
    expect(result.threshold_met).toBe(true);
    expect(result.votes).toEqual({ pass: 6, fail: 0, warn: 0, error: 0, total: 6 });
    expect(result.dissenting_personas).toEqual([]);
  });

  it('returns PROCEED_WITH_FOLLOWUPS when 5/6 pass with threshold 5-of-6 (tie-break inclusive)', () => {
    const outputs = [
      pass('a'),
      pass('b'),
      pass('c'),
      pass('d'),
      pass('e'),
      fail('f'),
    ];
    const result = consolidate(outputs, 'voting-quorum', { threshold: MOFN_5_OF_6 });
    expect(result.final_verdict).toBe('PROCEED_WITH_FOLLOWUPS');
    expect(result.threshold_met).toBe(true);
    expect(result.tie_break_applied).toBe(true);
    expect(result.dissenting_personas).toEqual(['f']);
  });

  it('returns BLOCKED when 4/6 pass with threshold 5-of-6 (below threshold)', () => {
    const outputs = [
      pass('a'),
      pass('b'),
      pass('c'),
      pass('d'),
      fail('e'),
      fail('f'),
    ];
    const result = consolidate(outputs, 'voting-quorum', { threshold: MOFN_5_OF_6 });
    expect(result.final_verdict).toBe('BLOCKED');
    expect(result.threshold_met).toBe(false);
    expect(result.votes.pass).toBe(4);
    expect(result.votes.fail).toBe(2);
  });

  it('returns BLOCKED for split 3/6 pass + 3/6 fail with threshold 4-of-6 (tie ties go to FAIL)', () => {
    const outputs = [
      pass('a'),
      pass('b'),
      pass('c'),
      fail('d'),
      fail('e'),
      fail('f'),
    ];
    const result = consolidate(outputs, 'voting-quorum', { threshold: MOFN_4_OF_6 });
    expect(result.final_verdict).toBe('BLOCKED');
    expect(result.threshold_met).toBe(false);
    expect(result.votes.pass).toBe(3);
    expect(result.votes.fail).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// hard-gate-threshold mode
// ---------------------------------------------------------------------------

describe('consolidate — hard-gate-threshold', () => {
  it('returns PROCEED when 6/6 pass with threshold "all"', () => {
    const outputs = ['a', 'b', 'c', 'd', 'e', 'f'].map(pass);
    const result = consolidate(outputs, 'hard-gate-threshold', { threshold: ALL });
    expect(result.final_verdict).toBe('PROCEED');
    expect(result.threshold_met).toBe(true);
    expect(result.votes.pass).toBe(6);
  });

  it('returns BLOCKED when 5/6 pass with threshold "all" (off-by-one HIGH H1)', () => {
    const outputs = [
      pass('a'),
      pass('b'),
      pass('c'),
      pass('d'),
      pass('e'),
      fail('f'),
    ];
    const result = consolidate(outputs, 'hard-gate-threshold', { threshold: ALL });
    expect(result.final_verdict).toBe('BLOCKED');
    expect(result.threshold_met).toBe(false);
    expect(result.dissenting_personas).toEqual(['f']);
  });

  it('returns PROCEED when 6/6 pass with threshold 6-of-6 (explicit equality)', () => {
    const outputs = ['a', 'b', 'c', 'd', 'e', 'f'].map(pass);
    const result = consolidate(outputs, 'hard-gate-threshold', { threshold: MOFN_6_OF_6 });
    expect(result.final_verdict).toBe('PROCEED');
    expect(result.threshold_met).toBe(true);
  });

  it('returns BLOCKED when 5/6 pass with threshold 6-of-6 (one short of unanimity)', () => {
    const outputs = [
      pass('a'),
      pass('b'),
      pass('c'),
      pass('d'),
      pass('e'),
      fail('f'),
    ];
    const result = consolidate(outputs, 'hard-gate-threshold', { threshold: MOFN_6_OF_6 });
    expect(result.final_verdict).toBe('BLOCKED');
    expect(result.threshold_met).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// coordinator-summary mode
// ---------------------------------------------------------------------------

describe('consolidate — coordinator-summary', () => {
  it('returns REQUIRES_COORDINATOR without computing a verdict (defer to caller)', () => {
    const outputs = [pass('a'), fail('b')];
    const result = consolidate(outputs, 'coordinator-summary', { threshold: ALL });
    expect(result.final_verdict).toBe('REQUIRES_COORDINATOR');
    expect(result.threshold_met).toBe(false);
    expect(result.notes).toContain('coordinator-summary: defer panel verdict to caller');
  });
});

// ---------------------------------------------------------------------------
// Empty / degenerate input
// ---------------------------------------------------------------------------

describe('consolidate — empty outputs', () => {
  it('returns BLOCKED with notes ["no persona outputs"] when outputs array is empty', () => {
    const result = consolidate([], 'voting-quorum', { threshold: MOFN_5_OF_6 });
    expect(result.final_verdict).toBe('BLOCKED');
    expect(result.notes).toEqual(['no persona outputs']);
    expect(result.votes.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Parse-error / error-vote handling (conservative-error rule W1-D3 H4)
// ---------------------------------------------------------------------------

describe('consolidate — non-validated outputs count as FAIL (W1-D3 H4)', () => {
  it('counts parse-error inputs as FAIL: 5 pass + 1 parse-error, threshold "all" → BLOCKED', () => {
    const outputs = [
      pass('a'),
      pass('b'),
      pass('c'),
      pass('d'),
      pass('e'),
      nonValidated('f', 'parse-error'),
    ];
    const result = consolidate(outputs, 'hard-gate-threshold', { threshold: ALL });
    expect(result.final_verdict).toBe('BLOCKED');
    expect(result.votes.pass).toBe(5);
    expect(result.votes.error).toBe(1);
    expect(result.votes.fail).toBe(1);
  });

  it('counts compile-error inputs as FAIL votes: 4 pass + 2 compile-error with threshold 5-of-6 → BLOCKED (errors do not boost pass count)', () => {
    // compile-error increments {fail, error, total} but never `pass`. Therefore
    // pass=4 < m=5 → threshold not met → BLOCKED.
    const outputs = [
      pass('a'),
      pass('b'),
      pass('c'),
      pass('d'),
      nonValidated('e', 'compile-error'),
      nonValidated('f', 'compile-error'),
    ];
    const result = consolidate(outputs, 'voting-quorum', { threshold: MOFN_5_OF_6 });
    expect(result.final_verdict).toBe('BLOCKED');
    expect(result.votes.pass).toBe(4);
    expect(result.votes.error).toBe(2);
    expect(result.votes.fail).toBe(2);
    expect(result.threshold_met).toBe(false);
  });

  it('counts validation-failed inputs as FAIL: 3 pass + 3 validation-failed, threshold "all" → BLOCKED', () => {
    const outputs = [
      pass('a'),
      pass('b'),
      pass('c'),
      nonValidated('d', 'validation-failed'),
      nonValidated('e', 'validation-failed'),
      nonValidated('f', 'validation-failed'),
    ];
    const result = consolidate(outputs, 'hard-gate-threshold', { threshold: ALL });
    expect(result.final_verdict).toBe('BLOCKED');
    expect(result.votes.pass).toBe(3);
    expect(result.votes.error).toBe(3);
    expect(result.votes.fail).toBe(3);
  });

  it('counts dispatch-error mode as FAIL (non-validated): 5 pass + 1 dispatch-error, threshold "all" → BLOCKED', () => {
    const outputs = [
      pass('a'),
      pass('b'),
      pass('c'),
      pass('d'),
      pass('e'),
      nonValidated('f', 'dispatch-error'),
    ];
    const result = consolidate(outputs, 'hard-gate-threshold', { threshold: ALL });
    expect(result.final_verdict).toBe('BLOCKED');
    expect(result.votes.pass).toBe(5);
    expect(result.votes.error).toBe(1);
    expect(result.votes.fail).toBe(1);
  });

  it('counts timeout mode as FAIL (non-validated): 5 pass + 1 timeout, threshold "all" → BLOCKED', () => {
    const outputs = [
      pass('a'),
      pass('b'),
      pass('c'),
      pass('d'),
      pass('e'),
      nonValidated('f', 'timeout'),
    ];
    const result = consolidate(outputs, 'hard-gate-threshold', { threshold: ALL });
    expect(result.final_verdict).toBe('BLOCKED');
    expect(result.votes.pass).toBe(5);
    expect(result.votes.error).toBe(1);
    expect(result.votes.fail).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Dissenting personas detection
// ---------------------------------------------------------------------------

describe('consolidate — dissenting_personas', () => {
  it('returns the single failing persona name when 5/6 pass and 1 fails (voting-quorum, met)', () => {
    const outputs = [
      pass('alpha'),
      pass('beta'),
      pass('gamma'),
      pass('delta'),
      pass('epsilon'),
      fail('zeta-the-dissenter'),
    ];
    const result = consolidate(outputs, 'voting-quorum', { threshold: MOFN_5_OF_6 });
    expect(result.final_verdict).toBe('PROCEED_WITH_FOLLOWUPS');
    expect(result.dissenting_personas).toEqual(['zeta-the-dissenter']);
  });

  it('on a 3/3 tie with threshold 4-of-6 the result is BLOCKED and dissenters are the 3 PASS personas', () => {
    // When BLOCKED, dominantVerdict='fail' → dissenters are everyone who voted pass.
    const outputs = [
      pass('p1'),
      pass('p2'),
      pass('p3'),
      fail('f1'),
      fail('f2'),
      fail('f3'),
    ];
    const result = consolidate(outputs, 'voting-quorum', { threshold: MOFN_4_OF_6 });
    expect(result.final_verdict).toBe('BLOCKED');
    expect(result.dissenting_personas).toEqual(['p1', 'p2', 'p3']);
  });
});

// ---------------------------------------------------------------------------
// Tie-break flag
// ---------------------------------------------------------------------------

describe('consolidate — tie_break_applied flag', () => {
  it('sets tie_break_applied=true when m-of-n is met with pass count equal to m exactly (5-of-6 at 5 pass)', () => {
    const outputs = [
      pass('a'),
      pass('b'),
      pass('c'),
      pass('d'),
      pass('e'),
      fail('f'),
    ];
    const result = consolidate(outputs, 'voting-quorum', { threshold: MOFN_5_OF_6 });
    expect(result.tie_break_applied).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Coord-direct fold-in: W4-Q4 HIGH-3 (all-personas-parse-error) + MED-1 (N=1)
// ---------------------------------------------------------------------------

describe('consolidate — coord-direct boundary fold-ins (W4-Q4)', () => {
  it('returns BLOCKED when all 6 personas are in parse-error mode (pass=0, error=6)', () => {
    const outputs = [
      nonValidated('a', 'parse-error'),
      nonValidated('b', 'parse-error'),
      nonValidated('c', 'parse-error'),
      nonValidated('d', 'parse-error'),
      nonValidated('e', 'parse-error'),
      nonValidated('f', 'parse-error'),
    ];
    const result = consolidate(outputs, 'hard-gate-threshold', { threshold: ALL });
    expect(result.final_verdict).toBe('BLOCKED');
    expect(result.votes.pass).toBe(0);
    expect(result.votes.error).toBe(6);
    expect(result.threshold_met).toBe(false);
  });

  it('returns PROCEED for single-persona N=1 voting-quorum 1-of-1 when the lone vote passes', () => {
    const outputs = [pass('solo')];
    const result = consolidate(outputs, 'voting-quorum', {
      threshold: { kind: 'm-of-n', m: 1, n: 1 },
    });
    expect(result.final_verdict).toBe('PROCEED');
    expect(result.votes).toEqual({ pass: 1, fail: 0, warn: 0, error: 0, total: 1 });
    expect(result.threshold_met).toBe(true);
    expect(result.dissenting_personas).toEqual([]);
  });

  it('returns BLOCKED for single-persona N=1 hard-gate "all" when the lone vote fails', () => {
    const outputs = [fail('solo')];
    const result = consolidate(outputs, 'hard-gate-threshold', { threshold: ALL });
    expect(result.final_verdict).toBe('BLOCKED');
    expect(result.votes.pass).toBe(0);
    expect(result.votes.fail).toBe(1);
    expect(result.threshold_met).toBe(false);
  });
});
