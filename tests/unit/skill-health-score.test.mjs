/**
 * tests/unit/skill-health-score.test.mjs
 *
 * Unit tests for the PURE per-skill health scorer (#648):
 *   scripts/lib/skill-health/score.mjs — scoreSkillHealth(...)
 *
 * The scorer is pure (no I/O, no Date.now, no fs). All fixtures are inline
 * literals; every expected value is a hardcoded literal (NEVER computed via the
 * production formula) per .claude/rules/testing.md § False-Positive Prevention.
 */

import { describe, it, expect } from 'vitest';

import {
  scoreSkillHealth,
  MIN_SAMPLES_FOR_VERDICT,
  STRONG_APPLIED_NO_FLOOR,
} from '@lib/skill-health/score.mjs';

// ---------------------------------------------------------------------------
// Fixture helpers — build the input shapes the scorer consumes.
// These BUILD inputs only; they never compute an expected output.
// ---------------------------------------------------------------------------

/** One L2 bySkill entry. */
function skillEntry(skill, selections) {
  return { skill, selections, sessions: [], outcomes: {} };
}

/** One L3 judgment-count record (full shape the scorer reads). */
function judgments({
  appliedYes = 0,
  appliedNo = 0,
  appliedUnknown = 0,
  completedYes = 0,
  completedNo = 0,
  completedUnknown = 0,
  total,
}) {
  return {
    appliedYes,
    appliedNo,
    appliedUnknown,
    completedYes,
    completedNo,
    completedUnknown,
    total,
    lastTs: null,
  };
}

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

describe('scoreSkillHealth — exported constants', () => {
  it('MIN_SAMPLES_FOR_VERDICT is 20', () => {
    expect(MIN_SAMPLES_FOR_VERDICT).toBe(20);
  });

  it('STRONG_APPLIED_NO_FLOOR is 2', () => {
    expect(STRONG_APPLIED_NO_FLOOR).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Empty / null inputs
// ---------------------------------------------------------------------------

describe('scoreSkillHealth — empty and null inputs', () => {
  it('returns [] for an empty bySkill object', () => {
    expect(scoreSkillHealth({ bySkill: {} })).toEqual([]);
  });

  it('returns [] when bySkill is null (no throw)', () => {
    expect(scoreSkillHealth({ bySkill: null })).toEqual([]);
  });

  it('returns [] when bySkill is undefined (no throw)', () => {
    expect(scoreSkillHealth({ bySkill: undefined })).toEqual([]);
  });

  it('returns [] when called with no arguments at all (no throw)', () => {
    expect(scoreSkillHealth()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Below sample threshold → "insufficient signal"
// ---------------------------------------------------------------------------

describe('scoreSkillHealth — below sample threshold', () => {
  it('verdict is "insufficient signal" when selections (3) < 20', () => {
    const rows = scoreSkillHealth({ bySkill: { plan: skillEntry('plan', 3) } });
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe('insufficient signal');
  });

  it('diagnosis names the below-threshold ratio for a sub-threshold skill', () => {
    const rows = scoreSkillHealth({ bySkill: { plan: skillEntry('plan', 3) } });
    expect(rows[0].diagnosis).toBe('below sample threshold (3/20)');
  });

  it('confidence is 0 and samples echo the input for a sub-threshold skill', () => {
    const rows = scoreSkillHealth({ bySkill: { plan: skillEntry('plan', 3) } });
    expect(rows[0].confidence).toBe(0);
    expect(rows[0].samples).toBe(3);
  });

  it('treats a missing selections field as 0 samples → insufficient signal', () => {
    const rows = scoreSkillHealth({ bySkill: { plan: { skill: 'plan' } } });
    expect(rows[0].verdict).toBe('insufficient signal');
    expect(rows[0].diagnosis).toBe('below sample threshold (0/20)');
    expect(rows[0].samples).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// At/above threshold, no L3 judgments → "insufficient signal" (no L3 data)
// ---------------------------------------------------------------------------

describe('scoreSkillHealth — at/above threshold without L3 judgments', () => {
  it('verdict is "insufficient signal" when there is no judgment data', () => {
    const rows = scoreSkillHealth({ bySkill: { plan: skillEntry('plan', 25) } });
    expect(rows[0].verdict).toBe('insufficient signal');
  });

  it('diagnosis is "no L3 judgment data" with an empty judgments Map', () => {
    const rows = scoreSkillHealth({ bySkill: { plan: skillEntry('plan', 25) } });
    expect(rows[0].diagnosis).toBe('no L3 judgment data');
  });

  it('diagnosis is "no L3 judgment data" when total === 0', () => {
    const j = new Map([['plan', judgments({ total: 0 })]]);
    const rows = scoreSkillHealth({
      bySkill: { plan: skillEntry('plan', 25) },
      judgmentsBySkill: j,
    });
    expect(rows[0].verdict).toBe('insufficient signal');
    expect(rows[0].diagnosis).toBe('no L3 judgment data');
  });
});

// ---------------------------------------------------------------------------
// "trigger description unclear" — selected but not applied
// ---------------------------------------------------------------------------

describe('scoreSkillHealth — trigger description unclear', () => {
  it('verdict is "trigger description unclear" when appliedNo>=2 and appliedYes===0', () => {
    const j = new Map([
      ['plan', judgments({ appliedYes: 0, appliedNo: 3, total: 3 })],
    ]);
    const rows = scoreSkillHealth({
      bySkill: { plan: skillEntry('plan', 25) },
      judgmentsBySkill: j,
    });
    expect(rows[0].verdict).toBe('trigger description unclear');
    expect(rows[0].diagnosis).toBe('selected but rarely applied');
  });
});

// ---------------------------------------------------------------------------
// "instructions wrong" — applied but low completion
// ---------------------------------------------------------------------------

describe('scoreSkillHealth — instructions wrong', () => {
  it('verdict is "instructions wrong" when applied but completedNo > completedYes', () => {
    const j = new Map([
      ['plan', judgments({ appliedYes: 5, appliedNo: 0, completedYes: 1, completedNo: 4, total: 5 })],
    ]);
    const rows = scoreSkillHealth({
      bySkill: { plan: skillEntry('plan', 25) },
      judgmentsBySkill: j,
    });
    expect(rows[0].verdict).toBe('instructions wrong');
    expect(rows[0].diagnosis).toBe('applied but low completion');
  });
});

// ---------------------------------------------------------------------------
// Boundary: selections exactly === 20 is NOT below threshold (samples < 20)
// → scored path. With sufficient judgments it yields an actionable verdict.
// ---------------------------------------------------------------------------

describe('scoreSkillHealth — exact boundary at 20 samples', () => {
  it('selections === 20 is scored (not "below sample threshold") with judgments', () => {
    // The code guard is `samples < minSamples` → 20 < 20 is false → scored.
    const j = new Map([
      ['plan', judgments({ appliedYes: 0, appliedNo: 4, total: 4 })],
    ]);
    const rows = scoreSkillHealth({
      bySkill: { plan: skillEntry('plan', 20) },
      judgmentsBySkill: j,
    });
    expect(rows[0].verdict).toBe('trigger description unclear');
    expect(rows[0].diagnosis).toBe('selected but rarely applied');
  });

  it('selections === 19 IS below threshold → insufficient signal (off-by-one guard)', () => {
    const j = new Map([
      ['plan', judgments({ appliedYes: 0, appliedNo: 4, total: 4 })],
    ]);
    const rows = scoreSkillHealth({
      bySkill: { plan: skillEntry('plan', 19) },
      judgmentsBySkill: j,
    });
    expect(rows[0].verdict).toBe('insufficient signal');
    expect(rows[0].diagnosis).toBe('below sample threshold (19/20)');
  });
});

// ---------------------------------------------------------------------------
// lowConfidence guardrail wins over a fully-scored skill
// ---------------------------------------------------------------------------

describe('scoreSkillHealth — lowConfidence guardrail', () => {
  it('lowConfidence:true forces "insufficient signal" even with 50 samples + good judgments', () => {
    const j = new Map([
      ['plan', judgments({ appliedYes: 5, completedYes: 1, completedNo: 4, total: 5 })],
    ]);
    const rows = scoreSkillHealth({
      bySkill: { plan: skillEntry('plan', 50) },
      judgmentsBySkill: j,
      lowConfidence: true,
    });
    expect(rows[0].verdict).toBe('insufficient signal');
    expect(rows[0].diagnosis).toBe('below sample threshold (50/20)');
    expect(rows[0].confidence).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// "no actionable signal" — has L3 data but no matching pattern
// ---------------------------------------------------------------------------

describe('scoreSkillHealth — L3 data but no actionable pattern', () => {
  it('verdict is "insufficient signal" with diagnosis "no actionable signal"', () => {
    // appliedYes>0 (so not "unclear"), completedNo <= completedYes (so not "wrong").
    const j = new Map([
      ['plan', judgments({ appliedYes: 5, completedYes: 4, completedNo: 1, total: 5 })],
    ]);
    const rows = scoreSkillHealth({
      bySkill: { plan: skillEntry('plan', 25) },
      judgmentsBySkill: j,
    });
    expect(rows[0].verdict).toBe('insufficient signal');
    expect(rows[0].diagnosis).toBe('no actionable signal');
  });
});

// ---------------------------------------------------------------------------
// Deterministic ordering — output sorted ascending by skill name
// ---------------------------------------------------------------------------

describe('scoreSkillHealth — deterministic ordering', () => {
  it('sorts output ascending by skill regardless of input key order', () => {
    const rows = scoreSkillHealth({
      bySkill: {
        zebra: skillEntry('zebra', 5),
        alpha: skillEntry('alpha', 5),
        mango: skillEntry('mango', 5),
      },
    });
    expect(rows.map((r) => r.skill)).toEqual(['alpha', 'mango', 'zebra']);
  });
});

// ---------------------------------------------------------------------------
// Full row shape — pin every field via a single toEqual with hardcoded literals
// ---------------------------------------------------------------------------

describe('scoreSkillHealth — full row shape', () => {
  it('emits the exact row shape for a sub-threshold skill', () => {
    const rows = scoreSkillHealth({ bySkill: { plan: skillEntry('plan', 3) } });
    expect(rows[0]).toEqual({
      skill: 'plan',
      verdict: 'insufficient signal',
      diagnosis: 'below sample threshold (3/20)',
      samples: 3,
      confidence: 0,
    });
  });

  it('emits the exact row shape (incl. confidence 0.15) for a scored "unclear" skill', () => {
    // confidence = Math.min(1, total/minSamples) = min(1, 3/20) = 0.15 (hardcoded literal).
    const j = new Map([
      ['plan', judgments({ appliedYes: 0, appliedNo: 3, total: 3 })],
    ]);
    const rows = scoreSkillHealth({
      bySkill: { plan: skillEntry('plan', 25) },
      judgmentsBySkill: j,
    });
    expect(rows[0]).toEqual({
      skill: 'plan',
      verdict: 'trigger description unclear',
      diagnosis: 'selected but rarely applied',
      samples: 25,
      confidence: 0.15,
    });
  });

  it('confidence saturates at 1 when total >= minSamples', () => {
    const j = new Map([
      ['plan', judgments({ appliedYes: 0, appliedNo: 20, total: 30 })],
    ]);
    const rows = scoreSkillHealth({
      bySkill: { plan: skillEntry('plan', 25) },
      judgmentsBySkill: j,
    });
    expect(rows[0].confidence).toBe(1);
  });
});
