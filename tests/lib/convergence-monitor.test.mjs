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

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { classify, _evaluateSignals } from '@lib/convergence-monitor.mjs';

describe('convergence-monitor classify — event-type gate (#966)', () => {
  it.each([
    // [label, record, expectedWave]
    // --- rejected: carries a wave number but is not a wave-lifecycle record ---
    // A gate record WITHOUT a well-formed `counts` carries no measurement to
    // fold, so admitting it would only burn the once-per-wave emit keys.
    [
      'quality_gate.failed with wave_number but no counts',
      { event: 'orchestrator.quality_gate.failed', exit_code: 2, wave_number: 4 },
      null,
    ],
    [
      'quality_gate.passed with counts but NO wave_number (session-level run)',
      {
        event: 'orchestrator.quality_gate.passed',
        variant: 'full-gate',
        exit_code: 0,
        counts: { passed: 12, failed: 2, total: 14 },
      },
      null,
    ],
    [
      'quality_gate.passed with wave_number but malformed counts',
      { event: 'orchestrator.quality_gate.passed', wave_number: 4, counts: 'full-gate' },
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
    ['agent.stopped carrying wave', { event: 'orchestrator.agent.stopped', wave: 4 }, 4],
    [
      'quality_gate.passed with counts + wave_number (#980 reader half)',
      {
        event: 'orchestrator.quality_gate.passed',
        variant: 'full-gate',
        exit_code: 0,
        counts: { passed: 12, failed: 2, total: 14 },
        wave_number: 3,
      },
      3,
    ],
    // --- accepted type, but no wave number → still null ---
    ['wave.completed without any wave field', { event: 'orchestrator.wave.completed' }, null],
  ])('%s → %s', (_label, rec, expected) => {
    const state = new Map();
    expect(classify(rec, state)).toBe(expected);
    // A rejected record must leave NO WaveSummary behind: instantiating one is
    // what advances `latestWave` and burns the once-per-wave emit keys.
    expect(state.size).toBe(expected === null ? 0 : 1);
  });

  it('does not fold counts.passed for a non-gate record that happens to carry counts', () => {
    // The #980 fold is scoped to `orchestrator.quality_gate.*`. A wave-lifecycle
    // record carrying an unrelated `counts` envelope must still fold NOTHING —
    // otherwise the monitor silently changes what `pass_rate_plateau` measures.
    const state = new Map();
    classify({ event: 'orchestrator.wave.completed', wave_number: 1, counts: { passed: 99 } }, state);
    expect(state.get(1).testPassed).toBeNull();
  });

  it('does not fold counts.passed for a quality_gate record WITHOUT wave_number', () => {
    // The #966 invariant, restated for the record class the fold now admits: a
    // session-level gate run (no `wave_number`) must not instantiate a
    // WaveSummary at all — that is what burns the once-per-wave emit keys.
    const state = new Map();
    const wave = classify(
      { event: 'orchestrator.quality_gate.passed', counts: { passed: 99, failed: 0, total: 99 } },
      state,
    );
    expect(wave).toBeNull();
    expect(state.size).toBe(0);
  });

  it('keeps the tail loop alive instead of draining the event loop', () => {
    // Bug (measured 2026-08-25, #980): the poll timer was `unref()`d and is the
    // ONLY handle this process holds, so node exits 0 the moment the first tick
    // is scheduled — after `tail.started` is already on stdout and with an empty
    // stderr. The monitor then supervises NOTHING while looking like a clean
    // shutdown, which is why no convergence signal was ever observed.
    // Hermetic: CLAUDE_PLUGIN_ROOT points at an empty tmpdir, so the child finds
    // no events.jsonl and can only poll — it neither reads nor writes anything
    // real. Falsification: restore `t.unref?.()` in sleep() and this goes red.
    const repo = mkdtempSync(join(tmpdir(), 'cm-live-'));
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, '../../scripts/lib/convergence-monitor.mjs'), '--tail', '--interval=1'],
      { env: { ...process.env, CLAUDE_PLUGIN_ROOT: repo }, stdio: 'ignore' },
    );
    let exitedEarly = false;
    child.on('exit', () => { exitedEarly = true; });
    return new Promise((r) => setTimeout(r, 2500))
      .then(() => { expect(exitedEarly).toBe(false); })
      .finally(() => { child.kill('SIGKILL'); });
  }, 15_000);
});

/**
 * #980 reader half — the two signals `pass_rate_plateau` and `velocity_drop`
 * were structurally unfireable: `classify` read a flat `test.passed` key and an
 * `agent.dispatched` event type, and NEITHER is emitted by anything in this
 * repo. Measured 2026-09-05 over `.orchestrator/metrics/events.jsonl`:
 *
 *   jq -c 'select(.event=="orchestrator.agent.stopped")' … | wc -l          → 11754
 *   jq -c 'select((.event//"")|startswith("orchestrator.quality_gate."))
 *          | select(.wave_number != null and (.counts|type)=="object")' … | wc -l →    33
 *   grep -c '"test.passed"' .orchestrator/metrics/events.jsonl              →     0
 *
 * So the ONLY per-wave pass count and the ONLY per-wave agent count in the
 * ledger sit in records `classify` refused. Falsification: revert the gate-fold
 * + agent.stopped admission in `classify` and every test below goes red.
 */
describe('convergence-monitor — golden records harvested from events.jsonl (#980)', () => {
  // Harvested verbatim via
  //   jq -c 'select(.event=="orchestrator.quality_gate.passed" and .wave_number != null
  //          and (.counts|type)=="object")' .orchestrator/metrics/events.jsonl | head -1
  // session ids redacted; every other field kept byte-for-byte.
  const GOLDEN_GATE = {
    timestamp: '2026-08-04T09:40:47.770Z',
    event: 'orchestrator.quality_gate.passed',
    variant: 'full-gate',
    exit_code: 0,
    counts: { passed: 13397, failed: 0, total: 13397 },
    wave_number: 5,
    session_id: '00000000-0000-4000-8000-000000000000',
    semantic_session_id: 'main-redacted-session-1',
  };

  // Harvested via
  //   jq -c 'select(.event=="orchestrator.agent.stopped")' … | head -1
  const GOLDEN_AGENT_STOPPED = {
    timestamp: '2026-09-02T05:22:38.020Z',
    event: 'orchestrator.agent.stopped',
    schema_version: 1,
    session_id: '00000000-0000-4000-8000-000000000000',
    semantic_session_id: 'main-redacted-session-1',
    wave: 3,
    agent: '',
  };

  it('folds the real gate envelope counts into the wave summary', () => {
    const state = new Map();
    expect(classify(GOLDEN_GATE, state)).toBe(5);
    expect(state.get(5).testPassed).toBe(13397);
    expect(state.get(5).testFailed).toBe(0);
  });

  it('counts each real agent.stopped record toward the wave agent count', () => {
    const state = new Map();
    expect(classify(GOLDEN_AGENT_STOPPED, state)).toBe(3);
    classify(GOLDEN_AGENT_STOPPED, state);
    classify(GOLDEN_AGENT_STOPPED, state);
    expect(state.get(3).agentDispatchCount).toBe(3);
  });
});

describe('convergence-monitor — signal firing on the folded measurements (#980)', () => {
  /** Capture the NDJSON lines `evaluateSignals` writes to stdout. */
  function captureSignals(state, latestWave) {
    const lines = [];
    const orig = process.stdout.write;
    process.stdout.write = (chunk) => { lines.push(String(chunk)); return true; };
    try {
      _evaluateSignals(state, new Set(), latestWave);
    } finally {
      process.stdout.write = orig;
    }
    return lines.map((l) => JSON.parse(l));
  }

  it('fires pass_rate_plateau when two consecutive gate envelopes carry the same pass count', () => {
    const state = new Map();
    classify({ event: 'orchestrator.quality_gate.passed', wave_number: 1, counts: { passed: 15869, failed: 0, total: 15869 } }, state);
    classify({ event: 'orchestrator.quality_gate.passed', wave_number: 2, counts: { passed: 15869, failed: 0, total: 15869 } }, state);
    const signals = captureSignals(state, 2);
    expect(signals.map((s) => s.event)).toContain('pass_rate_plateau');
    const plateau = signals.find((s) => s.event === 'pass_rate_plateau');
    expect(plateau.details).toEqual({ wave: 2, testPassed: 15869 });
  });

  it('fires velocity_drop when fewer agent.stopped records land in the later wave', () => {
    const state = new Map();
    for (let i = 0; i < 6; i += 1) classify({ event: 'orchestrator.agent.stopped', wave: 1 }, state);
    for (let i = 0; i < 2; i += 1) classify({ event: 'orchestrator.agent.stopped', wave: 2 }, state);
    const signals = captureSignals(state, 2);
    const drop = signals.find((s) => s.event === 'velocity_drop');
    expect(drop).toBeDefined();
    expect(drop.details).toEqual({ wave: 2, previousAgents: 6, currentAgents: 2, delta: -4 });
  });
});
