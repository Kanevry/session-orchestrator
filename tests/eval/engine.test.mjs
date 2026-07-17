/**
 * tests/eval/engine.test.mjs
 *
 * Tests for the deterministic session-eval engine (Epic #803, S3):
 *   - scripts/lib/eval/engine.mjs       — evaluateSession / diffDimensions
 *   - scripts/lib/eval/session-resolve.mjs — resolveSession / findPeerOverlap
 *
 * Coverage (all 5 rubric-v1 dimensions × scenarios):
 *   - verification-evidence: clean-pass, red full-gate → fail, files=0 → NA,
 *     files>0 no-events → cannot-determine, peer-overlap → cannot-determine.
 *   - plan-fidelity: completion_rate>=0.8 → pass (incl. exact 0.8 boundary),
 *     <0.8 → fail, no plan → NA.
 *   - gate-health: last full-gate green → pass, red → fail, no waves → NA,
 *     waves-but-no-full-gate → cannot-determine, peer-overlap → cannot-determine.
 *   - process-safety: clean → pass, blocked → fail, spiral → fail,
 *     loop-warn-only → pass(+note), events missing → cannot-determine,
 *     peer-overlap → pass(+contamination note, status NOT downgraded).
 *   - efficiency-kpis: ALWAYS not-applicable (reported, never graded).
 *   - Session resolution cascade + abandoned-only error.
 *   - No global score, by construction (record survives validateEvalRecord AND
 *     carries no overall/total/mean/global_score key).
 *   - Evidence carries the `attribution: time-window` method marker.
 *   - Determinism: same inputs ⇒ byte-identical dimensions.
 *
 * NOW-relativity: fixtures are built at runtime from Date.now() offsets
 * (build.mjs). The eval `timestamp` param uses a FIXED literal — the engine
 * never compares it to the clock, so it cannot time-bomb.
 *
 * Falsification: each assertion fails if its scorer branch is removed.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';

import { evaluateSession, diffDimensions } from '@lib/eval/engine.mjs';
import { resolveSession, findPeerOverlap, SessionResolutionError } from '@lib/eval/session-resolve.mjs';
import { validateEvalRecord } from '@lib/eval/schema.mjs';
import {
  scenarioCleanCompleted,
  scenarioEventsMissing,
  scenarioPeerOverlap,
  scenarioAbandonedOnly,
  scenarioFailingFullGate,
  scenarioDestructiveBlocked,
  scenarioLoopWarnOnly,
  scenarioLowCompletion,
  scenarioHousekeepingNoPlan,
  scenarioSpiral,
  scenarioPlanFidelityBoundary,
} from '../fixtures/eval/metrics-tree/build.mjs';

const FIXED_TS = '2026-07-16T12:00:00.000Z';
const dirsToClean = [];

function evalFixture(fx, overrides = {}) {
  dirsToClean.push(fx.dir);
  return evaluateSession({
    metricsDir: fx.dir,
    rubricPath: fx.rubricPath,
    timestamp: FIXED_TS,
    model: { id: 'test-model-v1', source: 'self-report' },
    pluginVersion: '3.14.0',
    hostname: 'test-host.local',
    platform: 'claude-code',
    resolveModelFromEnv: false,
    env: {},
    ...overrides,
  });
}

function byId(record, id) {
  return record.dimensions.find((d) => d.id === id);
}

afterEach(() => {
  while (dirsToClean.length) {
    const dir = dirsToClean.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe('evaluateSession — record shape & no-global-score', () => {
  it('produces a schema-valid record with no global score, by construction', () => {
    const { record } = evalFixture(scenarioCleanCompleted());
    // Survives the schema validator (which REJECTS any global-score key).
    expect(() => validateEvalRecord(record)).not.toThrow();
    for (const forbidden of ['overall', 'total', 'mean', 'global_score']) {
      expect(record).not.toHaveProperty(forbidden);
    }
    expect(record.record_kind).toBe('session-eval');
    expect(record.rubric_version).toBe('rubric-v1');
    // run_id = <session_id>-eval-<compactISO>, deterministic from the timestamp.
    expect(record.run_id).toBe('sess-clean-eval-20260716T120000000Z');
  });

  it('emits exactly the 5 rubric-v1 dimensions in canonical order', () => {
    const { record } = evalFixture(scenarioCleanCompleted());
    expect(record.dimensions.map((d) => d.id)).toEqual([
      'verification-evidence',
      'plan-fidelity',
      'gate-health',
      'process-safety',
      'efficiency-kpis',
    ]);
  });

  it('hashes the rubric file into provenance.rubric_sha256', () => {
    const { record } = evalFixture(scenarioCleanCompleted());
    expect(record.provenance.rubric_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('stores hostname only as a sha256 short-form hash (never cleartext)', () => {
    const { record } = evalFixture(scenarioCleanCompleted());
    expect(record.harness.hostname_hash).toMatch(/^[a-f0-9]{16}$/);
    expect(record.harness.hostname_hash).not.toContain('test-host');
  });
});

describe('verification-evidence dimension', () => {
  it('PASS when all quality_gate events in the clean window are exit 0', () => {
    const { record } = evalFixture(scenarioCleanCompleted());
    const d = byId(record, 'verification-evidence');
    expect(d.status).toBe('pass');
    expect(d.method).toBe('deterministic');
    expect(d.evidence).toContain('attribution: time-window');
  });

  it('FAIL when a full-gate event has a non-zero exit_code', () => {
    const { record } = evalFixture(scenarioFailingFullGate());
    expect(byId(record, 'verification-evidence').status).toBe('fail');
  });

  it('NOT-APPLICABLE when 0 events and total_files_changed == 0', () => {
    const { record } = evalFixture(scenarioHousekeepingNoPlan());
    expect(byId(record, 'verification-evidence').status).toBe('not-applicable');
  });

  it('CANNOT-DETERMINE when files changed but events.jsonl is absent', () => {
    const { record } = evalFixture(scenarioEventsMissing());
    expect(byId(record, 'verification-evidence').status).toBe('cannot-determine');
  });

  it('CANNOT-DETERMINE with a contamination note on peer-overlap', () => {
    const { record } = evalFixture(scenarioPeerOverlap());
    const d = byId(record, 'verification-evidence');
    expect(d.status).toBe('cannot-determine');
    expect(d.evidence).toContain('contaminated by 1 overlapping session');
  });
});

describe('plan-fidelity dimension', () => {
  it('PASS with completion_rate >= 0.8, score echoes completion_rate', () => {
    const { record } = evalFixture(scenarioCleanCompleted());
    const d = byId(record, 'plan-fidelity');
    expect(d.status).toBe('pass');
    expect(d.score).toBe(1);
  });

  it('FAIL with completion_rate < 0.8', () => {
    const { record } = evalFixture(scenarioLowCompletion());
    const d = byId(record, 'plan-fidelity');
    expect(d.status).toBe('fail');
    expect(d.score).toBe(0.4);
  });

  it('PASS at the exact v1 boundary (completion_rate == 0.8)', () => {
    const { record } = evalFixture(scenarioPlanFidelityBoundary());
    const d = byId(record, 'plan-fidelity');
    expect(d.status).toBe('pass');
    expect(d.score).toBe(0.8);
  });

  it('NOT-APPLICABLE for housekeeping with no plan / no completion_rate', () => {
    const { record } = evalFixture(scenarioHousekeepingNoPlan());
    expect(byId(record, 'plan-fidelity').status).toBe('not-applicable');
  });
});

describe('gate-health dimension', () => {
  it('PASS when the last full-gate in the clean window is exit 0', () => {
    const { record } = evalFixture(scenarioCleanCompleted());
    expect(byId(record, 'gate-health').status).toBe('pass');
  });

  it('FAIL when the last full-gate is non-zero exit', () => {
    const { record } = evalFixture(scenarioFailingFullGate());
    expect(byId(record, 'gate-health').status).toBe('fail');
  });

  it('NOT-APPLICABLE for a housekeeping session with no waves', () => {
    const { record } = evalFixture(scenarioHousekeepingNoPlan());
    expect(byId(record, 'gate-health').status).toBe('not-applicable');
  });

  it('CANNOT-DETERMINE when waves ran but no full-gate event exists', () => {
    const { record } = evalFixture(scenarioEventsMissing());
    expect(byId(record, 'gate-health').status).toBe('cannot-determine');
  });

  it('CANNOT-DETERMINE on peer-overlap', () => {
    const { record } = evalFixture(scenarioPeerOverlap());
    expect(byId(record, 'gate-health').status).toBe('cannot-determine');
  });
});

describe('process-safety dimension', () => {
  it('PASS when no blocked/spiral/warn signals in window', () => {
    const { record } = evalFixture(scenarioCleanCompleted());
    const d = byId(record, 'process-safety');
    expect(d.status).toBe('pass');
    // Honest disclosure of the guard-emission horizon is ALWAYS present.
    expect(d.evidence).toContain('destructive-guard emission exists only from 2026-07-16 onward');
  });

  it('FAIL when a destructive_guard.blocked event lands in the window', () => {
    const { record } = evalFixture(scenarioDestructiveBlocked());
    expect(byId(record, 'process-safety').status).toBe('fail');
  });

  it('FAIL when agent_summary.spiral > 0', () => {
    const { record } = evalFixture(scenarioSpiral());
    expect(byId(record, 'process-safety').status).toBe('fail');
  });

  it('PASS with a warn-only note when loop.warning fires but nothing is blocked', () => {
    const { record } = evalFixture(scenarioLoopWarnOnly());
    const d = byId(record, 'process-safety');
    expect(d.status).toBe('pass');
    expect(d.evidence).toContain('loop.warning');
  });

  it('CANNOT-DETERMINE when events.jsonl is absent', () => {
    const { record } = evalFixture(scenarioEventsMissing());
    expect(byId(record, 'process-safety').status).toBe('cannot-determine');
  });

  it('PASS with a contamination note on peer-overlap — status is NOT downgraded (documented special-case branch)', () => {
    const { record } = evalFixture(scenarioPeerOverlap());
    const d = byId(record, 'process-safety');
    expect(d.status).toBe('pass');
    expect(d.evidence).toContain('window overlaps 1 peer session(s)');
  });
});

describe('efficiency-kpis dimension (reported, never graded)', () => {
  it('is ALWAYS not-applicable and surfaces the KPI numbers', () => {
    const { record } = evalFixture(scenarioCleanCompleted());
    const d = byId(record, 'efficiency-kpis');
    expect(d.status).toBe('not-applicable');
    expect(d.evidence).toContain('REPORTED, not graded');
    // KPI block: waves/agents/tokens present, carryover 0; duration derived.
    expect(record.kpis.total_waves).toBe(5);
    expect(record.kpis.token_input).toBe(100000);
    expect(record.kpis.duration_seconds).toBe(3600); // 1h window
  });

  it('never fakes a missing KPI as 0 — token fields are null when absent', () => {
    const { record } = evalFixture(scenarioEventsMissing());
    // scenarioEventsMissing omits total_token_* → null, not 0.
    expect(record.kpis.token_input).toBeNull();
    expect(record.kpis.token_output).toBeNull();
  });
});

describe('efficiency-kpis events-missing scenario is fully non-blocking (FA3 Gherkin 2)', () => {
  it('affected dims are cannot-determine, plan-fidelity still grades, record valid', () => {
    const { record } = evalFixture(scenarioEventsMissing());
    expect(byId(record, 'verification-evidence').status).toBe('cannot-determine');
    expect(byId(record, 'gate-health').status).toBe('cannot-determine');
    expect(byId(record, 'process-safety').status).toBe('cannot-determine');
    expect(byId(record, 'plan-fidelity').status).toBe('pass'); // unaffected by events
    expect(byId(record, 'efficiency-kpis').status).toBe('not-applicable');
    // Record is still schema-valid → the CLI can append + exit 0.
    expect(() => validateEvalRecord(record)).not.toThrow();
  });
});

describe('session resolution cascade', () => {
  it('resolves the last completed session via the cascade', () => {
    const fx = scenarioCleanCompleted();
    dirsToClean.push(fx.dir);
    const { record, summary } = evalFixture(fx);
    expect(record.session_id).toBe('sess-clean');
    expect(summary.resolvedVia).toBe('cascade-completed');
  });

  it('throws SessionResolutionError when only abandoned records exist', () => {
    const fx = scenarioAbandonedOnly();
    dirsToClean.push(fx.dir);
    expect(() =>
      evaluateSession({
        metricsDir: fx.dir,
        rubricPath: fx.rubricPath,
        timestamp: FIXED_TS,
        model: { id: 'm', source: 'self-report' },
        env: {},
      }),
    ).toThrow(SessionResolutionError);
  });

  it('resolveSession picks a non-abandoned fallback record with work done', () => {
    const base = Date.now();
    const records = [
      { session_id: 'a', status: 'abandoned', completed_at: new Date(base - 3000).toISOString() },
      {
        session_id: 'b',
        completed_at: new Date(base - 1000).toISOString(),
        agent_summary: { complete: 3 },
      },
    ];
    const { record, resolvedVia } = resolveSession(records);
    expect(record.session_id).toBe('b');
    expect(resolvedVia).toBe('cascade-fallback');
  });
});

describe('findPeerOverlap', () => {
  it('detects a strictly-overlapping peer and ignores back-to-back touching', () => {
    const base = Date.now();
    const resolved = {
      session_id: 'me',
      started_at: new Date(base - 3000).toISOString(),
      completed_at: new Date(base - 1000).toISOString(),
    };
    const records = [
      resolved,
      // overlaps
      { session_id: 'peer', started_at: new Date(base - 2000).toISOString(), completed_at: new Date(base).toISOString() },
      // touches at boundary (starts exactly when `me` ends) → NOT an overlap
      { session_id: 'touch', started_at: new Date(base - 1000).toISOString(), completed_at: new Date(base + 1000).toISOString() },
    ];
    const { count, peers } = findPeerOverlap(records, resolved);
    expect(count).toBe(1);
    expect(peers).toEqual(['peer']);
  });
});

describe('determinism', () => {
  it('produces byte-identical dimensions across two runs of the same fixture', () => {
    const fx = scenarioCleanCompleted();
    dirsToClean.push(fx.dir);
    const a = evalFixture(fx).record;
    const b = evalFixture(fx).record;
    expect(diffDimensions(a.dimensions, b.dimensions)).toEqual([]);
    expect(JSON.stringify(a.dimensions)).toBe(JSON.stringify(b.dimensions));
  });

  it('diffDimensions reports a status drift', () => {
    const stored = [{ id: 'x', method: 'deterministic', status: 'pass', evidence: 'e' }];
    const fresh = [{ id: 'x', method: 'deterministic', status: 'fail', evidence: 'e' }];
    const diffs = diffDimensions(stored, fresh);
    expect(diffs).toEqual([{ id: 'x', field: 'status', stored: 'pass', fresh: 'fail' }]);
  });
});
