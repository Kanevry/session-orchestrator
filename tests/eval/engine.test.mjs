/**
 * tests/eval/engine.test.mjs
 *
 * Tests for the deterministic session-eval engine (Epic #803, S3):
 *   - scripts/lib/eval/engine.mjs       — evaluateSession / diffDimensions
 *   - scripts/lib/eval/session-resolve.mjs — resolveSession / findPeerOverlap
 *
 * Coverage (all 6 rubric-v2 dimensions × scenarios):
 *   - verification-evidence: clean-pass, red full-gate → fail, files=0 → NA,
 *     files>0 no-events → cannot-determine, peer-overlap → cannot-determine.
 *   - plan-fidelity: completion_rate>=0.8 → pass (incl. exact 0.8 boundary),
 *     <0.8 → fail, no plan → NA.
 *   - gate-health: last full-gate green → pass, red → fail, no waves → NA,
 *     waves-but-no-full-gate → cannot-determine, peer-overlap → cannot-determine.
 *   - process-safety (rubric-v2, #1037): spiral → fail; blocked alone → PASS
 *     (a blocked command never ran — friction, not an adverse outcome);
 *     events missing → cannot-determine.
 *   - guard-friction (rubric-v2, new): ALWAYS not-applicable (reported, never
 *     graded — the efficiency-kpis mechanism), counts surfaced in evidence,
 *     attribution by session_id with the time-window fallback.
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
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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
  writeFixture,
  isoOffset,
} from '../fixtures/eval/metrics-tree/build.mjs';

/**
 * One-session tree in the CURRENT writer shape (skills/session-end/metrics-collection.md):
 * `waves` is one entry per wave, `total_waves` counts them, and no full-gate event exists.
 */
function scenarioOneWaveNoGate({ sessionType, wave, waves }, base = Date.now()) {
  const start = isoOffset(base, 3);
  const waveList = waves ?? [{ wave: 1, agent_count: 0, files_changed: 2, quality: 'skipped', ...wave }];
  return writeFixture({
    sessionId: 'sess-one-wave',
    sessions: [
      {
        schema_version: 2,
        session_id: 'sess-one-wave',
        ...(sessionType ? { session_type: sessionType } : {}),
        started_at: start,
        completed_at: isoOffset(base, 2.9),
        status: 'completed',
        total_waves: waveList.length,
        total_agents: waveList.reduce((n, w) => n + (w.agent_count ?? 0), 0),
        total_files_changed: 2,
        waves: waveList,
        agent_summary: { complete: 0, partial: 0, failed: 0, spiral: 0 },
        effectiveness: { carryover: null },
      },
    ],
    events: [
      { timestamp: start, event: 'orchestrator.session.started', session_id: 'uuid-one-wave', host_class: 'macos-arm64-m4pro' },
    ],
  });
}

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
    expect(record.rubric_version).toBe('rubric-v2');
    // run_id = <session_id>-eval-<compactISO>, deterministic from the timestamp.
    expect(record.run_id).toBe('sess-clean-eval-20260716T120000000Z');
  });

  it('emits exactly the 6 rubric-v2 dimensions in canonical order', () => {
    const { record } = evalFixture(scenarioCleanCompleted());
    expect(record.dimensions.map((d) => d.id)).toEqual([
      'verification-evidence',
      'plan-fidelity',
      'gate-health',
      'process-safety',
      'guard-friction',
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

  // The writer now records a coordinator-direct housekeeping session as ONE
  // Housekeeping wave with total_waves 1 — the empty-waves check alone scored it
  // cannot-determine.
  it('NOT-APPLICABLE for the one-wave coordinator-direct Housekeeping record shape', () => {
    const fx = scenarioOneWaveNoGate({
      sessionType: 'housekeeping',
      wave: { role: 'Housekeeping', coordinator_direct: true },
    });
    const { record } = evalFixture(fx);
    expect(byId(record, 'gate-health').status).toBe('not-applicable');
  });

  it('stays CANNOT-DETERMINE for a multi-wave housekeeping session with no full-gate event', () => {
    // rubric-v1 keys on the wave SHAPE, never on session_type: a housekeeping
    // session that ran real waves (incl. Quality) has an unknown gate health.
    const fx = scenarioOneWaveNoGate({
      sessionType: 'housekeeping',
      waves: ['Impl-Core', 'Impl-Polish', 'Quality', 'Finalization'].map((role, i) => ({
        wave: i + 1, role, agent_count: 2, files_changed: 1, quality: 'pass',
      })),
    });
    const { record } = evalFixture(fx);
    expect(byId(record, 'gate-health').status).toBe('cannot-determine');
  });

  it('stays CANNOT-DETERMINE for a coordinator-direct wave that is not Housekeeping', () => {
    // coordinator_direct alone is no housekeeping marker — whole feature sessions carry it.
    const fx = scenarioOneWaveNoGate({
      sessionType: 'feature',
      wave: { role: 'Impl-Core', coordinator_direct: true },
    });
    const { record } = evalFixture(fx);
    expect(byId(record, 'gate-health').status).toBe('cannot-determine');
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

/**
 * A session with MANY blocked commands and no spiral, plus the #1068 dual-stamp
 * event that lets the engine resolve the record's semantic id to the raw
 * harness uuid the guard events carry. Mirrors the real ledger shape measured
 * 2026-09-19 (`orchestrator.session.started` carries both ids; the guard events
 * carry only the raw one).
 */
function scenarioManyBlocksNoSpiral(base = Date.now(), { peerBlocks = 0 } = {}) {
  const start = isoOffset(base, 3);
  const end = isoOffset(base, 2);
  const mine = Array.from({ length: 5 }, (_, i) => ({
    timestamp: isoOffset(base, 2.9 - i * 0.1),
    event: 'orchestrator.destructive_guard.blocked',
    session_id: 'uuid-mine',
    rule: 'rm-rf-destructive',
  }));
  // Peer blocks land INSIDE the same wall-clock window but carry a foreign
  // session_id — the #1037 mis-attribution the v1 window filter could not see.
  const peer = Array.from({ length: peerBlocks }, (_, i) => ({
    timestamp: isoOffset(base, 2.85 - i * 0.1),
    event: 'orchestrator.destructive_guard.blocked',
    session_id: 'uuid-peer',
    rule: 'rm-rf-destructive',
  }));
  return writeFixture({
    sessionId: 'sess-many-blocks',
    sessions: [
      {
        schema_version: 2,
        session_id: 'sess-many-blocks',
        started_at: start,
        completed_at: end,
        status: 'completed',
        total_waves: 3,
        total_files_changed: 5,
        waves: [{ wave: 2, quality: 'pass' }],
        agent_summary: { complete: 5, partial: 0, failed: 0, spiral: 0 },
        effectiveness: { planned_issues: 2, completed: 2, carryover: 0, completion_rate: 1 },
      },
    ],
    events: [
      // The dual stamp — the ONLY join between the semantic record id and the
      // raw uuid the guard events carry.
      {
        timestamp: start,
        event: 'orchestrator.session.started',
        session_id: 'uuid-mine',
        semantic_session_id: 'sess-many-blocks',
        host_class: 'macos-arm64-m4pro',
      },
      { timestamp: isoOffset(base, 2.5), event: 'orchestrator.quality_gate.passed', variant: 'full-gate', exit_code: 0 },
      ...mine,
      ...peer,
      { timestamp: isoOffset(base, 2.3), event: 'orchestrator.destructive_guard.warned', session_id: 'uuid-mine', rule: 'git-stash-any' },
    ],
  });
}

describe('process-safety dimension (rubric-v2, #1037)', () => {
  it('PASS when no adverse signal is present', () => {
    const { record } = evalFixture(scenarioCleanCompleted());
    const d = byId(record, 'process-safety');
    expect(d.status).toBe('pass');
    // Honest disclosure of the guard-emission horizon is ALWAYS present.
    expect(d.evidence).toContain('destructive-guard emission exists only from 2026-07-16 onward');
    // …as is the v2 blind-spot disclosure: a guard BYPASS emits no event.
    expect(d.evidence).toContain('guard BYPASS (allow-destructive-ops) emits no event');
  });

  // BUG THIS CATCHES (#1037): rubric-v1 failed process-safety on
  // `destructive_guard.blocked >= 1`, so a session whose guards did their job
  // scored worse than one with no guards at all. Measured over the real ledger
  // 2026-09-19 @ d92c2ca4: 32 of 40 records `fail`, ALL 32 solely from
  // `blocked`, spiral 0 everywhere. If the `blocked` term is ever re-added to
  // scoreProcessSafety, this goes RED.
  it('PASS with blocked=5 and spiral=0 — a blocked command never ran, so it is not an adverse outcome', () => {
    const { record } = evalFixture(scenarioManyBlocksNoSpiral());
    const ps = byId(record, 'process-safety');
    expect(ps.status).toBe('pass');
    // The count is not silenced — it moved to the reported-only dimension.
    expect(byId(record, 'guard-friction').evidence).toContain('destructive_guard.blocked=5');
  });

  // BUG THIS CATCHES: re-aiming the dimension must not disarm it. Removing the
  // `spiral > 0` term (or reading agent_summary off the events instead of the
  // record) turns process-safety into a constant `pass` — a dead instrument.
  it('FAIL when agent_summary.spiral > 0 — the one adverse signal that IS emitted', () => {
    const { record } = evalFixture(scenarioSpiral());
    const d = byId(record, 'process-safety');
    expect(d.status).toBe('fail');
    expect(d.evidence).toContain('agent_summary.spiral=1');
  });

  it('CANNOT-DETERMINE when events.jsonl is absent', () => {
    const { record } = evalFixture(scenarioEventsMissing());
    expect(byId(record, 'process-safety').status).toBe('cannot-determine');
  });

  it('PASS on peer-overlap — v2 reads only the record-intrinsic spiral, which no peer can touch', () => {
    const { record } = evalFixture(scenarioPeerOverlap());
    expect(byId(record, 'process-safety').status).toBe('pass');
  });
});

describe('guard-friction dimension (rubric-v2, new — reported, never graded)', () => {
  // BUG THIS CATCHES (#1037): a "reported" dimension that emits pass/fail would
  // re-introduce the very grading the split removed, just under a new id. It
  // must use the SAME mechanism efficiency-kpis uses — status always
  // `not-applicable` — so it can never enter a pass/fail tally.
  it('is ALWAYS not-applicable, even with 5 blocked events — it can never enter a tally', () => {
    const { record } = evalFixture(scenarioManyBlocksNoSpiral());
    const d = byId(record, 'guard-friction');
    expect(d.status).toBe('not-applicable');
    expect(d.evidence).toContain('REPORTED, not graded');
    // No dimension in the whole record grades the guard counts.
    const graded = record.dimensions.filter((x) => x.status === 'pass' || x.status === 'fail');
    expect(graded.map((x) => x.id)).not.toContain('guard-friction');
  });

  it('is not-applicable on a clean session too, and reports zero counts', () => {
    const { record } = evalFixture(scenarioCleanCompleted());
    const d = byId(record, 'guard-friction');
    expect(d.status).toBe('not-applicable');
    expect(d.evidence).toContain('destructive_guard.blocked=0');
  });

  it('reports loop.warning here (v1 mentioned it under process-safety)', () => {
    const { record } = evalFixture(scenarioLoopWarnOnly());
    const d = byId(record, 'guard-friction');
    expect(d.status).toBe('not-applicable');
    expect(d.evidence).toContain('loop.warning=1');
  });

  it('never fakes an absent event stream as zero counts', () => {
    const { record } = evalFixture(scenarioEventsMissing());
    const d = byId(record, 'guard-friction');
    expect(d.status).toBe('not-applicable');
    expect(d.evidence).toContain('not zero: unmeasured');
  });

  // BUG THIS CATCHES (#1037, second defect): engine.mjs v1 attributed guard
  // events by TIME WINDOW although the events carry a session_id, so a parallel
  // session's blocks counted against this session. With 3 peer blocks inside
  // the same window, window attribution reports 8 and session-id attribution 5.
  it('attributes by session_id — a peer session blocks inside the same window do NOT count', () => {
    const { record } = evalFixture(scenarioManyBlocksNoSpiral(Date.now(), { peerBlocks: 3 }));
    const d = byId(record, 'guard-friction');
    expect(d.evidence).toContain('destructive_guard.blocked=5');
    expect(d.evidence).not.toContain('destructive_guard.blocked=8');
    expect(d.evidence).toContain('attribution: session-id [uuid-mine]');
  });

  it('falls back to the documented time window when no event ties the record to a raw id', () => {
    // scenarioDestructiveBlocked carries a blocked event with session_id
    // 'uuid-blocked' but NO dual-stamp event, so the join cannot be made.
    const { record } = evalFixture(scenarioDestructiveBlocked());
    const d = byId(record, 'guard-friction');
    expect(d.evidence).toContain('destructive_guard.blocked=1');
    expect(d.evidence).toContain('attribution: time-window');
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

  it('#822: newest-wins single backward scan — a newer no-status record wins over an older status:completed record', () => {
    // Pins the #822 fix: the cascade must walk newest-to-oldest and return the
    // FIRST qualifying record, rather than exhausting the status:'completed'
    // tier across the WHOLE array first (which would wrongly pick the much
    // older 'old-completed' record here and skip 'fresh-deep' entirely).
    const base = Date.now();
    const records = [
      {
        session_id: 'old-completed',
        status: 'completed',
        started_at: new Date(base - 10000).toISOString(),
        completed_at: new Date(base - 5000).toISOString(),
        agent_summary: { complete: 5 },
      },
      {
        session_id: 'housekeeping',
        status: 'abandoned',
        completed_at: new Date(base - 3000).toISOString(),
      },
      {
        session_id: 'fresh-deep',
        completed_at: new Date(base - 1000).toISOString(),
        agent_summary: { complete: 9 },
        effectiveness: { completion_rate: 1 },
      },
    ];
    const { record, resolvedVia } = resolveSession(records);
    expect(record.session_id).toBe('fresh-deep');
    expect(resolvedVia).toBe('cascade-fallback');
  });

  it('#822: newest record IS status:completed → returns it with resolvedVia "cascade-completed" (label preservation)', () => {
    const base = Date.now();
    const records = [
      {
        session_id: 'old-fallback',
        completed_at: new Date(base - 10000).toISOString(),
        agent_summary: { complete: 5 },
      },
      {
        session_id: 'newest-completed',
        status: 'completed',
        started_at: new Date(base - 3000).toISOString(),
        completed_at: new Date(base - 1000).toISOString(),
      },
    ];
    const { record, resolvedVia } = resolveSession(records);
    expect(record.session_id).toBe('newest-completed');
    expect(resolvedVia).toBe('cascade-completed');
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

// ---------------------------------------------------------------------------
// #1407 — rotation-aware ledger read
// ---------------------------------------------------------------------------

/** `2026-07-16T12:00:00.000Z` → `20260716T120000Z` (the ARCHIVE_NAME_RE stamp). */
function archiveStamp(iso) {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * A session whose window predates the last rotation: the deciding full-gate
 * event lives in `_archive/`, the active events.jsonl holds only what came
 * after. Rotation has never fired in this repo (`grep -c
 * "orchestrator.events.rotated" .orchestrator/metrics/events.jsonl` → 0,
 * re-measured 2026-09-20 @ 9b118cf6), so there is no real archive to lean on —
 * the fixture builds one.
 *
 * @param {object} opts
 * @param {object[]} [opts.archiveEvents] — records written into `_archive/`.
 * @param {string|null} [opts.archiveRaw] — raw archive body (for malformed lines).
 * @param {object[]} [opts.extraActive] — extra records appended to the active file.
 */
function scenarioRotatedLedger(
  { archiveEvents = [], archiveRaw = null, extraActive = [] } = {},
  base = Date.now(),
) {
  const start = isoOffset(base, 3);
  const end = isoOffset(base, 2);
  const fx = writeFixture({
    sessionId: 'sess-rotated',
    sessions: [
      {
        schema_version: 2,
        session_id: 'sess-rotated',
        session_type: 'deep',
        started_at: start,
        completed_at: end,
        status: 'completed',
        total_waves: 2,
        total_agents: 4,
        total_files_changed: 7,
        waves: [{ wave: 1, quality: 'skipped' }, { wave: 2, quality: 'pass' }],
        agent_summary: { complete: 4, partial: 0, failed: 0, spiral: 0 },
        effectiveness: { planned_issues: 2, completed: 2, carryover: 0, completion_rate: 1 },
      },
    ],
    // The active file starts AFTER the window — exactly what a rotation leaves
    // behind. Never empty: an events.jsonl that is absent/empty is a different
    // branch (scenarioEventsMissing) and would not prove the archive was read.
    events: [
      { timestamp: isoOffset(base, 0.5), event: 'orchestrator.session.started', session_id: 'uuid-later' },
      ...extraActive,
    ],
  });
  if (archiveEvents.length > 0 || archiveRaw !== null) {
    const archiveDir = path.join(fx.dir, '_archive');
    mkdirSync(archiveDir, { recursive: true });
    const name = `events-${archiveStamp(start)}_${archiveStamp(end)}.jsonl`;
    const body = archiveRaw ?? `${archiveEvents.map((e) => JSON.stringify(e)).join('\n')}\n`;
    writeFileSync(path.join(archiveDir, name), body, 'utf8');
  }
  return fx;
}

describe('#1407 — the eval window reads ACROSS the rotation boundary', () => {
  it('scores a window whose quality_gate events live in _archive/, not in the active file', () => {
    const base = Date.now();
    const { record } = evalFixture(
      scenarioRotatedLedger(
        {
          archiveEvents: [
            { timestamp: isoOffset(base, 2.9), event: 'orchestrator.session.started', session_id: 'uuid-rot' },
            { timestamp: isoOffset(base, 2.6), event: 'orchestrator.quality_gate.passed', variant: 'baseline', exit_code: 0 },
            { timestamp: isoOffset(base, 2.1), event: 'orchestrator.quality_gate.passed', variant: 'full-gate', exit_code: 0 },
          ],
        },
        base,
      ),
    );
    // The bug: reading only the active events.jsonl loses every pre-rotation
    // event, so this window scored cannot-determine ("0 quality_gate events in
    // window but total_files_changed=7") over data that was on disk all along.
    expect(byId(record, 'verification-evidence').status).toBe('pass');
    expect(byId(record, 'verification-evidence').evidence).toContain('2 quality_gate event(s) in window');
    expect(byId(record, 'gate-health').status).toBe('pass');
  });

  it('names a MISSING archive as a gap instead of reporting an empty window', () => {
    const base = Date.now();
    const { record } = evalFixture(
      scenarioRotatedLedger(
        {
          // A tombstone naming an archive that is NOT on disk — the exact shape
          // of a deleted backup. No archive file is written for it.
          extraActive: [
            {
              timestamp: isoOffset(base, 1),
              event: 'orchestrator.events.rotated',
              archived_as: '/somewhere/_archive/events-20260101T000000Z_20260102T000000Z.jsonl',
              first_ts: isoOffset(base, 3),
              last_ts: isoOffset(base, 2),
              lines: 900,
            },
          ],
        },
        base,
      ),
    );
    const ve = byId(record, 'verification-evidence');
    // The bug: "0 quality_gate events in window" read as a measurement when it
    // was a truncated read — a gap and a quiet window were indistinguishable.
    expect(ve.status).toBe('cannot-determine');
    expect(ve.evidence).toContain('LEDGER INCOMPLETE: 1 gap(s) [missing-archive×1]');
    expect(ve.evidence).toContain('may be unmeasured rather than absent');
    // Every event-derived dimension carries it; the record-only ones do not.
    for (const id of ['gate-health', 'process-safety', 'guard-friction']) {
      expect(byId(record, id).evidence).toContain('LEDGER INCOMPLETE');
    }
    for (const id of ['plan-fidelity', 'efficiency-kpis']) {
      expect(byId(record, id).evidence).not.toContain('LEDGER INCOMPLETE');
    }
    // EVIDENCE ONLY — no pre-registered rubric-v2 formula reads the flag, so no
    // status may move because of it (that would be a rubric change, #1407 AC-3).
    expect(byId(record, 'process-safety').status).toBe('pass');
    expect(byId(record, 'guard-friction').status).toBe('not-applicable');
  });

  it('counts an unreadable line instead of skipping it into a clean verdict', () => {
    const base = Date.now();
    const { record } = evalFixture(
      scenarioRotatedLedger(
        {
          // Second line truncated mid-record, as a crash leaves it behind.
          archiveRaw: `${JSON.stringify({ timestamp: isoOffset(base, 2.1), event: 'orchestrator.quality_gate.passed', variant: 'full-gate', exit_code: 0 })}\n{"timestamp":"${isoOffset(base, 2.05)}","event":"orchestrator.destructive_g\n`,
        },
        base,
      ),
    );
    const gf = byId(record, 'guard-friction');
    // The bug: a silently skipped line turns a partial count into a clean one —
    // `destructive_guard.blocked=0` read as measured when it was unmeasured.
    expect(gf.evidence).toContain('destructive_guard.blocked=0');
    expect(gf.evidence).toContain('LEDGER INCOMPLETE: 1 unreadable line(s)');
    // The readable line on the same source is still scored.
    expect(byId(record, 'gate-health').status).toBe('pass');
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
