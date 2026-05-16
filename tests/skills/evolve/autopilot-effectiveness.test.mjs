/**
 * Tests for scripts/lib/evolve/autopilot-effectiveness.mjs (issue #298 type 8).
 *
 * Locks the data-gating contract (default 20 paired runs per mode), the
 * empty-input no-throw contract, and the schema_version:1 record shape.
 */

import { describe, it, expect } from 'vitest';
import {
  analyze,
  groupByMode,
  buildLearning,
  DEFAULT_MIN_PAIRED_RUNS,
  KNOWN_MODES,
} from '@lib/evolve/autopilot-effectiveness.mjs';

const NOW_ISO = '2026-04-30T12:00:00.000Z';

function makeRun(id) {
  return { autopilot_run_id: id };
}

function makeSession({ mode = 'feature', autopilotRunId = null, completion = 0.8, carryover = 0.1 } = {}) {
  const s = {
    mode,
    completion_rate: completion,
    carryover_ratio: carryover,
  };
  if (autopilotRunId) s.autopilot_run_id = autopilotRunId;
  return s;
}

function makeBatch(n, opts) {
  return Array.from({ length: n }, () => makeSession(opts));
}

describe('autopilot-effectiveness — constants', () => {
  it('exports DEFAULT_MIN_PAIRED_RUNS = 20', () => {
    expect(DEFAULT_MIN_PAIRED_RUNS).toBe(20);
  });

  it('exports KNOWN_MODES = [housekeeping, feature, deep]', () => {
    expect(KNOWN_MODES).toEqual(['housekeeping', 'feature', 'deep']);
  });
});

describe('autopilot-effectiveness — analyze() empty-input contract', () => {
  it('returns [] for empty arrays', () => {
    expect(analyze([], [])).toEqual([]);
  });

  it('returns [] for null inputs', () => {
    expect(analyze(null, null)).toEqual([]);
  });

  it('returns [] for undefined inputs (no args)', () => {
    expect(analyze()).toEqual([]);
  });

  it('returns [] when sessions is sparse / below threshold', () => {
    const runs = [makeRun('r1')];
    const sessions = [
      makeSession({ mode: 'feature' }),
      makeSession({ mode: 'feature' }),
    ];
    expect(analyze(runs, sessions)).toEqual([]);
  });
});

describe('autopilot-effectiveness — analyze() data-gating', () => {
  it('returns [] at 19 manual + 19 autopilot for feature (below threshold)', () => {
    const runs = Array.from({ length: 19 }, (_, i) => makeRun(`r${i}`));
    const manual = makeBatch(19, { mode: 'feature', completion: 0.7, carryover: 0.2 });
    const autopilot = runs.map((r) =>
      makeSession({ mode: 'feature', autopilotRunId: r.autopilot_run_id, completion: 0.85, carryover: 0.1 }),
    );
    expect(analyze(runs, [...manual, ...autopilot], { now: NOW_ISO })).toEqual([]);
  });

  it('emits 1 learning at the 20+20 threshold for feature', () => {
    const runs = Array.from({ length: 20 }, (_, i) => makeRun(`r${i}`));
    const manual = makeBatch(20, { mode: 'feature', completion: 0.7, carryover: 0.2 });
    const autopilot = runs.map((r) =>
      makeSession({ mode: 'feature', autopilotRunId: r.autopilot_run_id, completion: 0.85, carryover: 0.1 }),
    );
    const out = analyze(runs, [...manual, ...autopilot], { now: NOW_ISO });
    expect(out).toHaveLength(1);
    expect(out[0].subject).toBe('feature-manual-vs-autopilot');
  });

  it('emits 1 learning above-threshold with correct n_manual=30 / n_autopilot=25', () => {
    const runs = Array.from({ length: 25 }, (_, i) => makeRun(`r${i}`));
    const manual = makeBatch(30, { mode: 'feature', completion: 0.7, carryover: 0.2 });
    const autopilot = runs.map((r) =>
      makeSession({ mode: 'feature', autopilotRunId: r.autopilot_run_id, completion: 0.85, carryover: 0.1 }),
    );
    const out = analyze(runs, [...manual, ...autopilot], { now: NOW_ISO });
    expect(out).toHaveLength(1);
    expect(out[0].evidence.n_manual).toBe(30);
    expect(out[0].evidence.n_autopilot).toBe(25);
  });

  it('multi-mode: only emits for modes that meet threshold', () => {
    const runsFeature = Array.from({ length: 20 }, (_, i) => makeRun(`rf${i}`));
    const runsDeep = Array.from({ length: 5 }, (_, i) => makeRun(`rd${i}`));
    const manualFeature = makeBatch(20, { mode: 'feature' });
    const autoFeature = runsFeature.map((r) =>
      makeSession({ mode: 'feature', autopilotRunId: r.autopilot_run_id }),
    );
    const manualDeep = makeBatch(5, { mode: 'deep' });
    const autoDeep = runsDeep.map((r) =>
      makeSession({ mode: 'deep', autopilotRunId: r.autopilot_run_id }),
    );

    const out = analyze(
      [...runsFeature, ...runsDeep],
      [...manualFeature, ...autoFeature, ...manualDeep, ...autoDeep],
      { now: NOW_ISO },
    );
    expect(out).toHaveLength(1);
    expect(out[0].subject).toBe('feature-manual-vs-autopilot');
  });

  it('honors opts.minPairedRuns — 5+5 emits when threshold lowered to 5', () => {
    const runs = Array.from({ length: 5 }, (_, i) => makeRun(`r${i}`));
    const manual = makeBatch(5, { mode: 'feature' });
    const autopilot = runs.map((r) =>
      makeSession({ mode: 'feature', autopilotRunId: r.autopilot_run_id }),
    );
    const out = analyze(runs, [...manual, ...autopilot], {
      now: NOW_ISO,
      minPairedRuns: 5,
    });
    expect(out).toHaveLength(1);
  });
});

describe('autopilot-effectiveness — emitted learning schema', () => {
  it('has all required fields and correct constants', () => {
    const runs = Array.from({ length: 20 }, (_, i) => makeRun(`r${i}`));
    const manual = makeBatch(20, { mode: 'feature', completion: 0.7, carryover: 0.2 });
    const autopilot = runs.map((r) =>
      makeSession({ mode: 'feature', autopilotRunId: r.autopilot_run_id, completion: 0.85, carryover: 0.1 }),
    );
    const out = analyze(runs, [...manual, ...autopilot], { now: NOW_ISO });
    expect(out).toHaveLength(1);
    const rec = out[0];

    expect(rec.schema_version).toBe(1);
    expect(typeof rec.id).toBe('string');
    expect(rec.id.length).toBeGreaterThan(0);
    expect(rec.type).toBe('autopilot-effectiveness');
    expect(rec.subject).toBe('feature-manual-vs-autopilot');
    expect(typeof rec.insight).toBe('string');
    expect(rec.insight.length).toBeGreaterThan(0);
    expect(typeof rec.evidence).toBe('object');
    expect(rec.evidence).not.toBeNull();
    expect(rec.evidence.mode).toBe('feature');
    expect(rec.confidence).toBe(0.5);
    expect(typeof rec.source_session).toBe('string');
    expect(rec.source_session).toBe('evolve-2026-04-30');
    expect(rec.created_at).toBe(NOW_ISO);
    expect(typeof rec.expires_at).toBe('string');
    // 90 days after NOW_ISO
    const expDelta = new Date(rec.expires_at).getTime() - new Date(rec.created_at).getTime();
    expect(expDelta).toBe(90 * 86400 * 1000);
  });

  it('opts.now is honored — created_at matches passed ISO string', () => {
    const customNow = '2026-12-25T00:00:00.000Z';
    const runs = Array.from({ length: 20 }, (_, i) => makeRun(`r${i}`));
    const manual = makeBatch(20, { mode: 'feature' });
    const autopilot = runs.map((r) =>
      makeSession({ mode: 'feature', autopilotRunId: r.autopilot_run_id }),
    );
    const out = analyze(runs, [...manual, ...autopilot], { now: customNow });
    expect(out[0].created_at).toBe(customNow);
    expect(out[0].source_session).toBe('evolve-2026-12-25');
  });
});

describe('autopilot-effectiveness — groupByMode() smoke', () => {
  it('returns Map keyed by mode with manual/autopilot counts', () => {
    const runs = [makeRun('r1'), makeRun('r2')];
    const sessions = [
      makeSession({ mode: 'feature' }),
      makeSession({ mode: 'feature', autopilotRunId: 'r1' }),
      makeSession({ mode: 'feature', autopilotRunId: 'r2' }),
      makeSession({ mode: 'deep' }),
    ];
    const map = groupByMode(runs, sessions);
    expect(map).toBeInstanceOf(Map);
    expect(map.has('feature')).toBe(true);
    expect(map.has('deep')).toBe(true);
    const feat = map.get('feature');
    expect(feat.n_manual).toBe(1);
    expect(feat.n_autopilot).toBe(2);
    const deep = map.get('deep');
    expect(deep.n_manual).toBe(1);
    expect(deep.n_autopilot).toBe(0);
  });
});

describe('autopilot-effectiveness — buildLearning() smoke', () => {
  it('returns a valid record from synthetic stats', () => {
    const stats = {
      n_manual: 22,
      n_autopilot: 21,
      completion_rate_manual: 0.7,
      completion_rate_autopilot: 0.85,
      carryover_ratio_manual: 0.2,
      carryover_ratio_autopilot: 0.1,
    };
    const rec = buildLearning('deep', stats, NOW_ISO);
    expect(rec.schema_version).toBe(1);
    expect(rec.type).toBe('autopilot-effectiveness');
    expect(rec.subject).toBe('deep-manual-vs-autopilot');
    expect(rec.confidence).toBe(0.5);
    expect(rec.evidence.mode).toBe('deep');
    expect(rec.evidence.n_manual).toBe(22);
    expect(rec.evidence.n_autopilot).toBe(21);
    expect(rec.evidence.completion_delta).toBeCloseTo(0.15, 3);
    expect(rec.evidence.carryover_delta).toBeCloseTo(-0.1, 3);
    expect(rec.created_at).toBe(NOW_ISO);
  });
});
