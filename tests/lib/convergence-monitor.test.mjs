/**
 * tests/lib/convergence-monitor.test.mjs
 *
 * Guards the event-type gate in `classify` (#966 step 1).
 *
 * The bug this catches — and which NO existing test catches, because no test
 * exercised `classify` at all: `classify` extracted a wave number from ANY
 * record and had no event-type filter. Gate events were ignored only
 * ACCIDENTALLY, because they happened to carry no `wave_number`
 * (measured 2026-08-03: 4486 `orchestrator.quality_gate*` records in
 * `.orchestrator/metrics/events.jsonl`, 0 with `wave_number`). The moment
 * `run-quality-gate.mjs` began emitting `wave_number`, every gate run — the
 * single highest-volume record type in the file — would instantiate or refresh
 * a `WaveSummary`, advance `latestWave`, and burn the once-per-wave
 * `alreadyEmitted` keys, so the genuine convergence signal would be SUPPRESSED
 * when the real wave record arrived later. A regression here emits nothing and
 * logs nothing; it is invisible without this test.
 *
 * Falsification: delete the `isWaveScopedEvent` guard from `classify` and rows
 * 1-4 below go red (they would return a wave number instead of `null`).
 */

import { describe, it, expect } from 'vitest';
import { classify } from '@lib/convergence-monitor.mjs';

describe('convergence-monitor classify — event-type gate (#966)', () => {
  it.each([
    // [label, record, expectedWave]
    // --- rejected: carries a wave number but is not a wave-lifecycle record ---
    [
      'quality_gate.passed with counts + wave_number',
      {
        event: 'orchestrator.quality_gate.passed',
        variant: 'full-gate',
        exit_code: 0,
        counts: { passed: 12, failed: 2, total: 14 },
        wave_number: 3,
      },
      null,
    ],
    [
      'quality_gate.failed with wave_number',
      { event: 'orchestrator.quality_gate.failed', exit_code: 2, wave_number: 4 },
      null,
    ],
    [
      'session.stopped with wave',
      { event: 'orchestrator.session.stopped', wave: 2 },
      null,
    ],
    [
      'memory.propose_invoked with wave',
      { event: 'orchestrator.memory.propose_invoked', wave: 5 },
      null,
    ],
    ['untyped record with wave_number', { wave_number: 9 }, null],
    // --- accepted: the records this monitor exists to compare ---
    [
      'wave.completed carrying files_changed',
      { event: 'orchestrator.wave.completed', wave_number: 3, files_changed: 7 },
      3,
    ],
    ['wave.started', { event: 'orchestrator.wave.started', wave: 1 }, 1],
    ['agent.dispatched', { event_type: 'agent.dispatched', wave_number: 2 }, 2],
    // --- accepted type, but no wave number → still null ---
    ['wave.completed without any wave field', { event: 'orchestrator.wave.completed' }, null],
  ])('%s → %s', (_label, rec, expected) => {
    const state = new Map();
    expect(classify(rec, state)).toBe(expected);
    // A rejected record must leave NO WaveSummary behind: instantiating one is
    // what advances `latestWave` and burns the once-per-wave emit keys.
    expect(state.size).toBe(expected === null ? 0 : 1);
  });

  it('does not fold the gate event\'s nested counts.passed into testPassed', () => {
    // Guards against a "helpful" flattening that would silently change what the
    // monitor measures: `pass_rate_plateau` compares the FLAT `test.passed` key,
    // not a gate envelope's `counts.passed`.
    const state = new Map();
    classify({ event: 'orchestrator.wave.completed', wave_number: 1, counts: { passed: 99 } }, state);
    expect(state.get(1).testPassed).toBeNull();
  });
});
