/**
 * tests/fixtures/eval/metrics-tree/build.mjs
 *
 * NOW-relative fixture builder for the eval-engine tests (Epic #803, S3).
 *
 * The engine's SCORING path is clock-free (it only compares event timestamps to
 * the resolved session's window, never to Date.now). So static timestamps would
 * be safe here — but per the Zeitbomben-Learning (conf 0.9) we still generate
 * every fixture at test runtime from offsets relative to a caller-supplied base
 * (default Date.now()). Each scenario writes sessions.jsonl (+ optionally
 * events.jsonl + a rubric.md to hash) into a fresh temp dir and returns the
 * paths + the expected session id.
 *
 * Using Date.now() INSIDE a test is fine; the engine scoring path stays
 * clock-free by construction.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOUR = 3_600_000;

/** ISO string `hoursAgo` before `base` (fractional hours allowed). */
export function isoOffset(base, hoursAgo) {
  return new Date(base - Math.round(hoursAgo * HOUR)).toISOString();
}

/**
 * Write a metrics tree into a fresh temp dir.
 * @param {object} opts
 * @param {object[]} opts.sessions — sessions.jsonl records.
 * @param {object[]|null} [opts.events] — events.jsonl records; null ⇒ omit the file.
 * @param {string} opts.sessionId — the id the engine is expected to resolve.
 * @returns {{ dir: string, rubricPath: string, sessionId: string }}
 */
export function writeFixture({ sessions, events = null, sessionId }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'eval-metrics-'));
  const rubricPath = path.join(dir, 'rubric.md');
  writeFileSync(rubricPath, '# rubric-v1 fixture\n', 'utf8');
  writeFileSync(
    path.join(dir, 'sessions.jsonl'),
    `${sessions.map((s) => JSON.stringify(s)).join('\n')}\n`,
    'utf8',
  );
  if (events !== null) {
    writeFileSync(
      path.join(dir, 'events.jsonl'),
      `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
      'utf8',
    );
  }
  return { dir, rubricPath, sessionId };
}

// ---------------------------------------------------------------------------
// Scenario constructors — one completed session per window unless noted.
// ---------------------------------------------------------------------------

/** (1) Clean completed session: full-gate pass, files changed, plan complete. */
export function scenarioCleanCompleted(base = Date.now()) {
  const start = isoOffset(base, 3);
  const end = isoOffset(base, 2);
  return writeFixture({
    sessionId: 'sess-clean',
    sessions: [
      {
        schema_version: 1,
        session_id: 'sess-clean',
        session_type: 'deep',
        started_at: start,
        completed_at: end,
        status: 'completed',
        total_waves: 5,
        total_agents: 10,
        total_files_changed: 12,
        waves: [{ wave: 1, quality: 'skipped' }, { wave: 4, quality: 'pass' }],
        agent_summary: { complete: 10, partial: 0, failed: 0, spiral: 0 },
        effectiveness: { planned_issues: 3, completed: 3, carryover: 0, completion_rate: 1, carryover_ratio: 0 },
        total_token_input: 100000,
        total_token_output: 400000,
      },
    ],
    events: [
      { timestamp: start, event: 'orchestrator.session.started', session_id: 'uuid-clean', host_class: 'macos-arm64-m4pro' },
      { timestamp: isoOffset(base, 2.7), event: 'orchestrator.quality_gate.passed', variant: 'baseline', exit_code: 0 },
      { timestamp: isoOffset(base, 2.1), event: 'orchestrator.quality_gate.passed', variant: 'full-gate', exit_code: 0 },
    ],
  });
}

/** (2) events.jsonl entirely absent — gate/process dims cannot-determine, exit 0. */
export function scenarioEventsMissing(base = Date.now()) {
  const start = isoOffset(base, 3);
  const end = isoOffset(base, 2);
  return writeFixture({
    sessionId: 'sess-noevents',
    sessions: [
      {
        schema_version: 1,
        session_id: 'sess-noevents',
        session_type: 'deep',
        started_at: start,
        completed_at: end,
        status: 'completed',
        total_waves: 4,
        total_agents: 8,
        total_files_changed: 6,
        waves: [{ wave: 2, quality: 'pass' }],
        agent_summary: { complete: 8, partial: 0, failed: 0, spiral: 0 },
        effectiveness: { planned_issues: 2, completed: 2, carryover: 0, completion_rate: 1, carryover_ratio: 0 },
      },
    ],
    events: null, // no events.jsonl file at all
  });
}

/** (3) Peer overlap: the resolved session's window overlaps another session. */
export function scenarioPeerOverlap(base = Date.now()) {
  const aStart = isoOffset(base, 4);
  const aEnd = isoOffset(base, 2.5);
  const bStart = isoOffset(base, 3);
  const bEnd = isoOffset(base, 1.5);
  return writeFixture({
    sessionId: 'sess-peer-b', // resolved = last completed
    sessions: [
      {
        schema_version: 1,
        session_id: 'sess-peer-a',
        started_at: aStart,
        completed_at: aEnd,
        status: 'completed',
        total_waves: 3,
        total_files_changed: 4,
        waves: [{ wave: 1, quality: 'pass' }],
        agent_summary: { complete: 5, partial: 0, failed: 0, spiral: 0 },
        effectiveness: { planned_issues: 2, completed: 2, carryover: 0, completion_rate: 1 },
      },
      {
        schema_version: 1,
        session_id: 'sess-peer-b',
        started_at: bStart,
        completed_at: bEnd,
        status: 'completed',
        total_waves: 3,
        total_files_changed: 7,
        waves: [{ wave: 2, quality: 'pass' }],
        agent_summary: { complete: 6, partial: 0, failed: 0, spiral: 0 },
        effectiveness: { planned_issues: 3, completed: 3, carryover: 0, completion_rate: 1 },
      },
    ],
    events: [
      { timestamp: isoOffset(base, 2), event: 'orchestrator.quality_gate.passed', variant: 'full-gate', exit_code: 0 },
    ],
  });
}

/** (4) Abandoned-only: cascade skips everything → resolution error. */
export function scenarioAbandonedOnly(base = Date.now()) {
  return writeFixture({
    sessionId: null,
    sessions: [
      {
        schema_version: 2,
        session_id: 'sess-aband-1',
        started_at: isoOffset(base, 5),
        completed_at: isoOffset(base, 4.9),
        status: 'abandoned',
        agent_summary: { complete: 0, partial: 0, failed: 0, spiral: 0 },
        effectiveness: { carryover: null },
      },
      {
        schema_version: 2,
        session_id: 'sess-aband-2',
        started_at: isoOffset(base, 3),
        completed_at: isoOffset(base, 2.9),
        status: 'abandoned',
        agent_summary: { complete: 0, partial: 0, failed: 0, spiral: 0 },
        effectiveness: { carryover: null },
      },
    ],
    events: [],
  });
}

/** (5) Failing full-gate: last full-gate exit_code != 0 → verification+gate fail. */
export function scenarioFailingFullGate(base = Date.now()) {
  const start = isoOffset(base, 3);
  const end = isoOffset(base, 2);
  return writeFixture({
    sessionId: 'sess-redgate',
    sessions: [
      {
        schema_version: 1,
        session_id: 'sess-redgate',
        session_type: 'deep',
        started_at: start,
        completed_at: end,
        status: 'completed',
        total_waves: 5,
        total_agents: 12,
        total_files_changed: 20,
        waves: [{ wave: 4, quality: 'fail' }],
        agent_summary: { complete: 11, partial: 1, failed: 0, spiral: 0 },
        effectiveness: { planned_issues: 4, completed: 4, carryover: 0, completion_rate: 1 },
      },
    ],
    events: [
      { timestamp: isoOffset(base, 2.6), event: 'orchestrator.quality_gate.passed', variant: 'baseline', exit_code: 0 },
      { timestamp: isoOffset(base, 2.2), event: 'orchestrator.quality_gate.failed', variant: 'full-gate', exit_code: 1 },
    ],
  });
}

/** (6) destructive_guard.blocked in window → process-safety fail. */
export function scenarioDestructiveBlocked(base = Date.now()) {
  const start = isoOffset(base, 3);
  const end = isoOffset(base, 2);
  return writeFixture({
    sessionId: 'sess-blocked',
    sessions: [
      {
        schema_version: 1,
        session_id: 'sess-blocked',
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
      { timestamp: isoOffset(base, 2.5), event: 'orchestrator.quality_gate.passed', variant: 'full-gate', exit_code: 0 },
      { timestamp: isoOffset(base, 2.4), event: 'orchestrator.destructive_guard.blocked', session_id: 'uuid-blocked', command: 'rm -rf x' },
    ],
  });
}

/** (7) loop.warning only (0 blocked) → process-safety pass with a warn note. */
export function scenarioLoopWarnOnly(base = Date.now()) {
  const start = isoOffset(base, 3);
  const end = isoOffset(base, 2);
  return writeFixture({
    sessionId: 'sess-warn',
    sessions: [
      {
        schema_version: 1,
        session_id: 'sess-warn',
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
      { timestamp: isoOffset(base, 2.5), event: 'orchestrator.quality_gate.passed', variant: 'full-gate', exit_code: 0 },
      { timestamp: isoOffset(base, 2.4), event: 'orchestrator.loop.warning', session_id: 's1', tool: 'Read', count: 3 },
    ],
  });
}

/** (8) Low completion_rate → plan-fidelity fail. */
export function scenarioLowCompletion(base = Date.now()) {
  const start = isoOffset(base, 3);
  const end = isoOffset(base, 2);
  return writeFixture({
    sessionId: 'sess-lowplan',
    sessions: [
      {
        schema_version: 1,
        session_id: 'sess-lowplan',
        started_at: start,
        completed_at: end,
        status: 'completed',
        total_waves: 5,
        total_files_changed: 8,
        waves: [{ wave: 4, quality: 'pass' }],
        agent_summary: { complete: 6, partial: 2, failed: 0, spiral: 0 },
        effectiveness: { planned_issues: 5, completed: 2, carryover: 3, completion_rate: 0.4, carryover_ratio: 0.6 },
      },
    ],
    events: [
      { timestamp: isoOffset(base, 2.5), event: 'orchestrator.quality_gate.passed', variant: 'full-gate', exit_code: 0 },
    ],
  });
}

/** (9) Housekeeping, no plan / no waves / no gates → NA dims where appropriate. */
export function scenarioHousekeepingNoPlan(base = Date.now()) {
  const start = isoOffset(base, 3);
  const end = isoOffset(base, 2.95);
  return writeFixture({
    sessionId: 'sess-housekeeping',
    sessions: [
      {
        schema_version: 2,
        session_id: 'sess-housekeeping',
        session_type: 'housekeeping',
        started_at: start,
        completed_at: end,
        status: 'completed',
        total_waves: 0,
        total_agents: 0,
        total_files_changed: 0,
        waves: [],
        agent_summary: { complete: 0, partial: 0, failed: 0, spiral: 0 },
        effectiveness: { carryover: null },
      },
    ],
    events: [
      { timestamp: start, event: 'orchestrator.session.started', session_id: 'uuid-hk', host_class: 'macos-arm64-m4pro' },
    ],
  });
}

/** (10) Spiral > 0 → process-safety fail (intrinsic signal, no guard event needed). */
export function scenarioSpiral(base = Date.now()) {
  const start = isoOffset(base, 3);
  const end = isoOffset(base, 2);
  return writeFixture({
    sessionId: 'sess-spiral',
    sessions: [
      {
        schema_version: 1,
        session_id: 'sess-spiral',
        started_at: start,
        completed_at: end,
        status: 'completed',
        total_waves: 4,
        total_files_changed: 3,
        waves: [{ wave: 2, quality: 'pass' }],
        agent_summary: { complete: 4, partial: 0, failed: 1, spiral: 1 },
        effectiveness: { planned_issues: 2, completed: 2, carryover: 0, completion_rate: 1 },
      },
    ],
    events: [
      { timestamp: isoOffset(base, 2.5), event: 'orchestrator.quality_gate.passed', variant: 'full-gate', exit_code: 0 },
    ],
  });
}

/** (11) completion_rate exactly at the v1 threshold (0.8) → plan-fidelity pass. */
export function scenarioPlanFidelityBoundary(base = Date.now()) {
  const start = isoOffset(base, 3);
  const end = isoOffset(base, 2);
  return writeFixture({
    sessionId: 'sess-boundary',
    sessions: [
      {
        schema_version: 1,
        session_id: 'sess-boundary',
        started_at: start,
        completed_at: end,
        status: 'completed',
        total_waves: 4,
        total_files_changed: 6,
        waves: [{ wave: 3, quality: 'pass' }],
        agent_summary: { complete: 6, partial: 0, failed: 0, spiral: 0 },
        effectiveness: { planned_issues: 5, completed: 4, carryover: 1, completion_rate: 0.8, carryover_ratio: 0.2 },
      },
    ],
    events: [
      { timestamp: isoOffset(base, 2.5), event: 'orchestrator.quality_gate.passed', variant: 'full-gate', exit_code: 0 },
    ],
  });
}
