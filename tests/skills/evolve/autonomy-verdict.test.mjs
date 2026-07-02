/**
 * Tests for scripts/lib/evolve/autonomy-verdict.mjs (#683 P3.5).
 *
 * Locks the core analyzer contract: emit only when autopilot + skill-judge
 * signal families both exist, reuse type-8 mode effectiveness evidence, and
 * produce schema_version:1 `autonomy-verdict` learnings with the required
 * `<repo-or-scope>-autonomy-readiness` subject form.
 */

import { describe, it, expect } from 'vitest';
import {
  analyze,
  buildLearning,
  summarizeAutopilot,
  summarizeSkillJudgments,
  LEARNING_TYPE,
  DEFAULT_MIN_AUTOPILOT_RUNS,
  DEFAULT_MIN_SKILL_JUDGMENTS,
} from '@lib/evolve/autonomy-verdict.mjs';
import { validateLearning } from '@lib/learnings/schema.mjs';

const NOW_ISO = '2026-06-18T12:00:00.000Z';

function makeRun(id, overrides = {}) {
  return {
    autopilot_run_id: id,
    kill_switch: null,
    ...overrides,
  };
}

function makeSession({
  mode = 'feature',
  autopilotRunId = null,
  completion = 0.8,
  carryover = 0.1,
  repo = undefined,
} = {}) {
  const s = {
    mode,
    completion_rate: completion,
    carryover_ratio: carryover,
  };
  if (autopilotRunId) s.autopilot_run_id = autopilotRunId;
  if (repo) s.repo = repo;
  return s;
}

function makeJudgment(overrides = {}) {
  return {
    timestamp: '2026-06-18T10:00:00.000Z',
    event: 'judged',
    skill: 'session-orchestrator:wave-executor',
    session_id: 'deep-2026-06-18',
    applied: 'yes',
    completed: 'yes',
    confidence: 0.8,
    advisory: true,
    model: 'haiku',
    schema_version: 1,
    ...overrides,
  };
}

describe('autonomy-verdict — constants', () => {
  it('exports the learning type and default gates', () => {
    expect(LEARNING_TYPE).toBe('autonomy-verdict');
    expect(DEFAULT_MIN_AUTOPILOT_RUNS).toBe(1);
    expect(DEFAULT_MIN_SKILL_JUDGMENTS).toBe(1);
  });
});

describe('autonomy-verdict — analyze() data gate', () => {
  it('returns [] for empty arrays', () => {
    expect(analyze([], [], [], { now: NOW_ISO })).toEqual([]);
  });

  it('returns [] for null/undefined inputs without throwing', () => {
    expect(() => analyze(null, undefined, null, { now: NOW_ISO })).not.toThrow();
    expect(analyze(null, undefined, null, { now: NOW_ISO })).toEqual([]);
  });

  it('requires at least one autopilot run and one canonical skill-judge judgment by default', () => {
    const runs = [makeRun('r1')];
    const judgments = [makeJudgment()];

    expect(analyze(runs, [], [], { now: NOW_ISO })).toEqual([]);
    expect(analyze([], [], judgments, { now: NOW_ISO })).toEqual([]);
    expect(analyze(runs, [], judgments, { now: NOW_ISO })).toHaveLength(1);
  });

  it('does not treat multi-story coordinator entries as autopilot loop runs', () => {
    const coordinatorOnly = [{
      run_id: 'coordinator-1',
      kind: 'multi-story-coordinator',
      child_run_ids: ['r1', 'r2'],
      completed_count: 2,
      failed_count: 0,
    }];

    expect(analyze(coordinatorOnly, [], [makeJudgment()], { now: NOW_ISO })).toEqual([]);
    expect(summarizeAutopilot(coordinatorOnly, []).n_runs).toBe(0);
  });

  it('honors raised minimum gates', () => {
    const runs = [makeRun('r1')];
    const judgments = [makeJudgment()];

    expect(
      analyze(runs, [], judgments, {
        now: NOW_ISO,
        minAutopilotRuns: 2,
      }),
    ).toEqual([]);
    expect(
      analyze(runs, [], judgments, {
        now: NOW_ISO,
        minSkillJudgments: 2,
      }),
    ).toEqual([]);
  });

  it('does not let lowered gates bypass the required signal families', () => {
    const runs = [makeRun('r1')];
    const judgments = [makeJudgment()];

    expect(
      analyze([], [], judgments, {
        now: NOW_ISO,
        minAutopilotRuns: 0,
      }),
    ).toEqual([]);
    expect(
      analyze(runs, [], [], {
        now: NOW_ISO,
        minSkillJudgments: 0,
      }),
    ).toEqual([]);
    expect(
      analyze([], [], [], {
        now: NOW_ISO,
        minAutopilotRuns: 0,
        minSkillJudgments: 0,
      }),
    ).toEqual([]);
  });
});

describe('autonomy-verdict — summarizeAutopilot()', () => {
  it('reuses type-8 mode rollups and computes repo-level readiness evidence', () => {
    const runs = [makeRun('r1'), makeRun('r2', { kill_switch: 'failed-wave' })];
    const sessions = [
      makeSession({ mode: 'feature', completion: 0.7, carryover: 0.2 }),
      makeSession({ mode: 'feature', autopilotRunId: 'r1', completion: 0.9, carryover: 0.1 }),
      makeSession({ mode: 'feature', autopilotRunId: 'r2', completion: 0.8, carryover: 0.3 }),
    ];

    const summary = summarizeAutopilot(runs, sessions);

    expect(summary.n_runs).toBe(2);
    expect(summary.kill_switches_fired).toBe(1);
    expect(summary.kill_switch_rate).toBe(0.5);
    expect(summary.n_autopilot_sessions).toBe(2);
    expect(summary.completion_rate_autopilot).toBe(0.85);
    expect(summary.completion_rate_manual).toBe(0.7);
    expect(summary.carryover_ratio_autopilot).toBe(0.2);
    expect(summary.carryover_ratio_manual).toBe(0.2);
    expect(summary.completion_delta).toBe(0.15);
    expect(summary.carryover_delta).toBe(0);
    expect(summary.modes).toEqual([
      {
        mode: 'feature',
        n_manual: 1,
        n_autopilot: 2,
        completion_rate_manual: 0.7,
        completion_rate_autopilot: 0.85,
        carryover_ratio_manual: 0.2,
        carryover_ratio_autopilot: 0.2,
        completion_delta: 0.15,
        carryover_delta: 0,
      },
    ]);
  });
});

describe('autonomy-verdict — summarizeSkillJudgments()', () => {
  it('counts advisory judged records and ignores malformed/non-advisory signals', () => {
    const summary = summarizeSkillJudgments([
      makeJudgment({ applied: 'yes', completed: 'yes', confidence: 0.9 }),
      makeJudgment({ applied: 'unknown', completed: 'no', confidence: 0.5 }),
      { applied: 'yes', completed: 'yes', confidence: 1 },
      makeJudgment({ schema_version: 0, applied: 'yes', completed: 'yes' }),
      makeJudgment({ skill: '', applied: 'yes', completed: 'yes' }),
      makeJudgment({ model: '', applied: 'yes', completed: 'yes' }),
      makeJudgment({ event: 'selected', applied: 'yes', completed: 'yes' }),
      makeJudgment({ advisory: false, applied: 'yes', completed: 'yes' }),
      makeJudgment({ timestamp: '', applied: 'yes', completed: 'yes' }),
      makeJudgment({ timestamp: 'not-a-date', applied: 'yes', completed: 'yes' }),
      makeJudgment({ applied: 'maybe', completed: 'yes' }),
      null,
    ]);

    expect(summary.total).toBe(2);
    expect(summary.applied_yes).toBe(1);
    expect(summary.applied_unknown).toBe(1);
    expect(summary.completed_yes).toBe(1);
    expect(summary.completed_no).toBe(1);
    expect(summary.applied_yes_rate).toBe(0.5);
    expect(summary.completed_yes_rate).toBe(0.5);
    expect(summary.avg_confidence).toBe(0.7);
    expect(summary.score).toBe(0.625);
    // Bug 2 fix (#683 review): both_yes is the CORRELATED counter — only the
    // first record has applied==='yes' AND completed==='yes' simultaneously;
    // the second record (applied:'unknown', completed:'no') does not count.
    expect(summary.both_yes).toBe(1);
  });

  it('does not increment both_yes for uncorrelated applied/completed records', () => {
    const summary = summarizeSkillJudgments([
      makeJudgment({ applied: 'yes', completed: 'no' }),
      makeJudgment({ applied: 'no', completed: 'yes' }),
    ]);

    expect(summary.total).toBe(2);
    expect(summary.applied_yes).toBe(1);
    expect(summary.completed_yes).toBe(1);
    // Bug 2 fix (#683 review): the independent sums (applied_yes=1,
    // completed_yes=1) are both non-zero, which is exactly the trap the old
    // `hasAffirmativeJudgeEvidence()` fell into — no SINGLE record here has
    // applied==='yes' AND completed==='yes', so both_yes must stay 0.
    expect(summary.both_yes).toBe(0);
  });
});

describe('autonomy-verdict — emitted learning schema', () => {
  it('emits a schema_version:1 autonomy-verdict with required subject form', () => {
    const runs = [makeRun('r1', { repo: 'session-orchestrator' })];
    const sessions = [
      makeSession({ repo: 'session-orchestrator', completion: 0.7, carryover: 0.2 }),
      makeSession({
        repo: 'session-orchestrator',
        autopilotRunId: 'r1',
        completion: 0.9,
        carryover: 0.1,
      }),
    ];
    const judgments = [makeJudgment({ confidence: 0.8 })];

    const out = analyze(runs, sessions, judgments, { now: NOW_ISO });

    expect(out).toHaveLength(1);
    const rec = out[0];
    expect(rec.schema_version).toBe(1);
    expect(typeof rec.id).toBe('string');
    expect(rec.id.length).toBeGreaterThan(0);
    expect(rec.type).toBe('autonomy-verdict');
    expect(rec.subject).toBe('session-orchestrator-autonomy-readiness');
    expect(rec.insight).toContain('autonomy readiness is ready');
    expect(rec.evidence.scope).toBe('session-orchestrator');
    expect(rec.evidence.verdict).toBe('ready');
    expect(rec.evidence.score).toBe(0.91);
    expect(rec.evidence.autopilot.score).toBe(0.82);
    expect(rec.evidence.autopilot.modes[0].mode).toBe('feature');
    expect(rec.evidence.skill_judge.total).toBe(1);
    expect(rec.evidence.skill_judge.score).toBe(1);
    expect(rec.confidence).toBeGreaterThanOrEqual(0);
    expect(rec.confidence).toBeLessThanOrEqual(1);
    expect(rec.scope).toBe('private');
    expect(rec.source_session).toBe('evolve-2026-06-18');
    expect(rec.created_at).toBe(NOW_ISO);
    expect(validateLearning(rec).scope).toBe('private');

    const expDelta = new Date(rec.expires_at).getTime() - new Date(rec.created_at).getTime();
    expect(expDelta).toBe(90 * 86400 * 1000);
  });

  it('uses explicit scope override and sanitizes slash-separated repo names', () => {
    const rec = buildLearning(
      'owner/session-orchestrator',
      {
        autopilot: summarizeAutopilot([makeRun('r1')], []),
        skill_judge: summarizeSkillJudgments([makeJudgment()]),
      },
      NOW_ISO,
    );

    expect(rec.subject).toBe('owner-session-orchestrator-autonomy-readiness');
    expect(rec.evidence.scope).toBe('owner-session-orchestrator');
  });

  it('can emit not-ready when both autopilot and judge signals are negative', () => {
    const out = analyze(
      [makeRun('r1', { kill_switch: 'spiral' })],
      [makeSession({ autopilotRunId: 'r1', completion: 0.1, carryover: 0.9 })],
      [makeJudgment({ applied: 'no', completed: 'no', confidence: 0.9 })],
      { now: NOW_ISO, scope: 'repo-r' },
    );

    expect(out).toHaveLength(1);
    expect(out[0].subject).toBe('repo-r-autonomy-readiness');
    expect(out[0].evidence.verdict).toBe('not-ready');
    expect(out[0].evidence.score).toBeLessThan(0.5);
  });

  it('does not emit ready when skill-judge evidence is all unknown', () => {
    const out = analyze(
      [makeRun('r1')],
      [makeSession({ autopilotRunId: 'r1', completion: 1, carryover: 0 })],
      [makeJudgment({ applied: 'unknown', completed: 'unknown', confidence: 0.9 })],
      { now: NOW_ISO, scope: 'repo-r' },
    );

    expect(out).toHaveLength(1);
    expect(out[0].evidence.score).toBeGreaterThanOrEqual(0.7);
    expect(out[0].evidence.verdict).toBe('watch');
  });

  it('does not count non-canonical skill-judgment objects as gate evidence', () => {
    const out = analyze(
      [makeRun('r1')],
      [],
      [{ applied: 'yes', completed: 'yes', confidence: 1 }],
      { now: NOW_ISO, scope: 'repo-r' },
    );

    expect(out).toEqual([]);
  });

  it('does not count missing or invalid timestamp skill-judgment objects as gate evidence', () => {
    const runs = [makeRun('r1')];
    const sessions = [makeSession({ autopilotRunId: 'r1', completion: 1, carryover: 0 })];

    expect(
      analyze(
        runs,
        sessions,
        [makeJudgment({ timestamp: undefined, applied: 'yes', completed: 'yes' })],
        { now: NOW_ISO, scope: 'repo-r' },
      ),
    ).toEqual([]);
    expect(
      analyze(
        runs,
        sessions,
        [makeJudgment({ timestamp: 'not-a-date', applied: 'yes', completed: 'yes' })],
        { now: NOW_ISO, scope: 'repo-r' },
      ),
    ).toEqual([]);
  });
});

describe('autonomy-verdict — Bug 1 regression: thin-evidence must not read as perfect', () => {
  it('does not let a thin autopilot run-set (zero linked sessions) drive a ready verdict, even with a strong judgment', () => {
    // One clean autopilot RUN record with ZERO linked sessions — kill-switch
    // data exists but NO session-effectiveness evidence at all
    // (n_autopilot_sessions === 0).
    const out = analyze(
      [makeRun('r1')],
      [],
      [makeJudgment({ applied: 'yes', completed: 'yes', confidence: 0.9 })],
      { now: NOW_ISO, scope: 'repo-thin' },
    );

    expect(out).toHaveLength(1);
    const rec = out[0];

    expect(rec.evidence.autopilot.n_autopilot_sessions).toBe(0);
    // Hand-computed: scoreParts = [1 - killSwitchRate(0) = 1, neutral-unknown 0.5]
    // (the fixed neutral-placeholder path, since zero effectiveness components
    // are present) → mean([1, 0.5]) = 0.75. NOT ~1 ("perfect") as the buggy
    // version produced.
    expect(rec.evidence.autopilot.score).toBe(0.75);
    // Combined score = round3(mean([0.75, 1 (skill_judge.score)])) = 0.875 —
    // clears the >=0.7 numeric threshold, which is exactly why the fix needs
    // the STRUCTURAL hasAutopilotEffectivenessEvidence() gate in verdictFor(),
    // not just a score-arithmetic tweak.
    expect(rec.evidence.score).toBe(0.875);
    expect(rec.evidence.verdict).not.toBe('ready');
    expect(rec.evidence.verdict).toBe('watch');
  });
});

describe('autonomy-verdict — Bug 2 regression: uncorrelated judge counts must not satisfy the ready gate', () => {
  it('does not reach ready off two uncorrelated judge records even with strong autopilot effectiveness evidence', () => {
    const runs = [makeRun('r1')];
    const sessions = [makeSession({ autopilotRunId: 'r1', completion: 1, carryover: 0 })];
    const judgments = [
      makeJudgment({ applied: 'yes', completed: 'no', confidence: 0.9 }),
      makeJudgment({ applied: 'no', completed: 'yes', confidence: 0.9 }),
    ];

    const out = analyze(runs, sessions, judgments, { now: NOW_ISO, scope: 'repo-uncorrelated' });

    expect(out).toHaveLength(1);
    const rec = out[0];

    // Strong, real autopilot effectiveness evidence — the autopilot component
    // alone clears the numeric ready threshold.
    expect(rec.evidence.autopilot.score).toBe(1);
    // The OLD gate `applied_yes>0 && completed_yes>0` reads this as
    // affirmative (both independent sums are 1), even though NEITHER record
    // itself confirmed applied AND completed together.
    expect(rec.evidence.skill_judge.applied_yes).toBe(1);
    expect(rec.evidence.skill_judge.completed_yes).toBe(1);
    expect(rec.evidence.skill_judge.both_yes).toBe(0);
    expect(rec.evidence.verdict).not.toBe('ready');
  });
});

describe('autonomy-verdict — positive control: the happy path still reaches ready', () => {
  it('reaches ready when real autopilot effectiveness evidence pairs with a correlated affirmative judgment', () => {
    const runs = [makeRun('r1')];
    const sessions = [
      makeSession({ completion: 0.7, carryover: 0.2 }),
      makeSession({ autopilotRunId: 'r1', completion: 0.9, carryover: 0.1 }),
    ];
    const judgments = [makeJudgment({ applied: 'yes', completed: 'yes', confidence: 0.8 })];

    const out = analyze(runs, sessions, judgments, { now: NOW_ISO, scope: 'repo-happy-path' });

    expect(out).toHaveLength(1);
    const rec = out[0];

    expect(rec.evidence.autopilot.n_autopilot_sessions).toBe(1);
    expect(rec.evidence.skill_judge.both_yes).toBe(1);
    expect(rec.evidence.verdict).toBe('ready');
  });
});

describe('autonomy-verdict — readinessConfidence() exact value (R4)', () => {
  it('pins the exact confidence for a fixed autopilot/skill-judge input pair', () => {
    // Hand-crafted summaries (not derived from summarizeAutopilot/
    // summarizeSkillJudgments) so every input to readinessConfidence() is
    // pinned and the arithmetic below is fully reproducible by hand.
    const autopilot = {
      n_runs: 5,
      kill_switch_rate: 0,
      n_autopilot_sessions: 3,
      score: 0.6,
      modes: [],
    };
    const skillJudge = {
      total: 4,
      avg_confidence: 0.7,
      score: 0.8,
      both_yes: 2,
      applied_yes: 2,
      completed_yes: 2,
    };

    const rec = buildLearning('repo-confidence-pin', { autopilot, skill_judge: skillJudge }, NOW_ISO);

    // Hand-computed from buildLearning()/readinessConfidence()'s formula:
    //   score               = round3(mean([0.6, 0.8]))          = 0.7
    //   runStrength         = min(0.2, 5 * 0.02)                 = 0.1
    //   judgmentStrength    = min(0.2, 4 * 0.02)                 = 0.08
    //   confidenceStrength  = 0.7 * 0.1                          = 0.07
    //   separationStrength  = min(0.1, |0.7 - 0.5| * 0.2)        = 0.04
    //   confidence = round3(clamp01(0.4 + 0.1 + 0.08 + 0.07 + 0.04)) = 0.69
    expect(rec.evidence.score).toBe(0.7);
    expect(rec.confidence).toBe(0.69);
  });
});
