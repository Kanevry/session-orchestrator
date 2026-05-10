/**
 * tests/lib/autopilot/kill-switches.test.mjs
 *
 * Dedicated test file for scripts/lib/autopilot/kill-switches.mjs.
 * Created in ADR-364 thin-slice (STALL_TIMEOUT scaffold).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  KILL_SWITCHES,
  preIterationKillSwitch,
  postSessionKillSwitch,
} from '../../../scripts/lib/autopilot/kill-switches.mjs';

// ---------------------------------------------------------------------------
// KILL_SWITCHES enum
// ---------------------------------------------------------------------------

describe('KILL_SWITCHES enum', () => {
  it('includes STALL_TIMEOUT with the correct kebab-case value', () => {
    expect(KILL_SWITCHES.STALL_TIMEOUT).toBe('stall-timeout');
  });

  it('exports exactly 10 kill-switches', () => {
    expect(Object.keys(KILL_SWITCHES)).toHaveLength(10);
  });

  it('STALL_TIMEOUT does not collide with any existing identifier', () => {
    const values = Object.values(KILL_SWITCHES);
    expect(new Set(values).size).toBe(values.length);
  });

  it('is frozen (cannot be mutated at runtime)', () => {
    expect(() => {
      KILL_SWITCHES.STALL_TIMEOUT = 'mutated';
    }).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// postSessionKillSwitch — STALL_TIMEOUT does not spuriously fire (ADR-364 §3 DoD)
// ---------------------------------------------------------------------------

describe('postSessionKillSwitch — STALL_TIMEOUT does not spuriously fire', () => {
  // With the sampler wired (issue #371), STALL_TIMEOUT must NOT fire on
  // happy-path / empty / unrelated sessions when no stale autopilot.jsonl
  // marker is present. Path is pointed at a non-existent file so the sampler
  // reports marker='missing' with stallSeconds=0 → kill condition false.
  const MISSING_PATH = '/tmp/__nonexistent_autopilot_jsonl_for_test__.jsonl';

  it.each([
    [
      'happy carryover-ok',
      { agent_summary: { complete: 1, failed: 0, partial: 0, spiral: 0 } },
      { carryoverThreshold: 0.5, autopilotJsonlPath: MISSING_PATH },
    ],
    ['empty session result', {}, { carryoverThreshold: 0.5, autopilotJsonlPath: MISSING_PATH }],
    [
      'high carryover (other switch may fire)',
      { effectiveness: { planned_issues: 10, carryover: 5 } },
      { carryoverThreshold: 0.3, autopilotJsonlPath: MISSING_PATH },
    ],
  ])('STALL_TIMEOUT never fires (%s)', (_name, sessionResult, opts) => {
    const result = postSessionKillSwitch(sessionResult, opts);
    // Other post-session switches may fire; STALL_TIMEOUT must never be the cause.
    if (result === null) return;
    expect(result.kill).not.toBe(KILL_SWITCHES.STALL_TIMEOUT);
  });

  it('returns null when sessionResult is null', () => {
    expect(
      postSessionKillSwitch(null, { carryoverThreshold: 0.5, autopilotJsonlPath: MISSING_PATH })
    ).toBeNull();
  });

  it('returns null when sessionResult is empty object and carryover below threshold', () => {
    expect(
      postSessionKillSwitch(
        { effectiveness: { planned_issues: 10, carryover: 2 } },
        { carryoverThreshold: 0.5, autopilotJsonlPath: MISSING_PATH }
      )
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// postSessionKillSwitch — STALL_TIMEOUT wire-up (issue #371)
// ---------------------------------------------------------------------------

describe('postSessionKillSwitch — STALL_TIMEOUT wire-up (issue #371)', () => {
  let tmp;
  let jsonlPath;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'ks-stall-'));
    jsonlPath = path.join(tmp, 'autopilot.jsonl');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('fires STALL_TIMEOUT when stallSeconds >= threshold', () => {
    // Create a real file then push its mtime 1000s into the past.
    writeFileSync(jsonlPath, 'seed\n');
    const fakeNow = 2_000_000_000_000; // fixed wall-clock
    const oneThousandSecondsAgoMs = fakeNow - 1000 * 1000;
    const atime = new Date(oneThousandSecondsAgoMs);
    const mtime = new Date(oneThousandSecondsAgoMs);
    utimesSync(jsonlPath, atime, mtime);

    const result = postSessionKillSwitch(
      { agent_summary: { complete: 1, failed: 0, partial: 0, spiral: 0 } },
      {
        carryoverThreshold: 0.5,
        autopilotJsonlPath: jsonlPath,
        stallTimeoutSeconds: 600,
        nowMs: () => fakeNow,
      }
    );

    expect(result).not.toBeNull();
    expect(result.kill).toBe(KILL_SWITCHES.STALL_TIMEOUT);
    expect(result.detail).toMatch(/stalled \d+s/);
    expect(result.detail).toMatch(/threshold 600s/);
  });

  it('returns null when sampler reports progress (fresh mtime)', () => {
    writeFileSync(jsonlPath, 'seed\n');
    const fakeNow = 2_000_000_000_000;
    // Touch the file in the recent past (10s ago — well within SAMPLE_CADENCE_MS=30s).
    const tenSecondsAgoMs = fakeNow - 10 * 1000;
    utimesSync(jsonlPath, new Date(tenSecondsAgoMs), new Date(tenSecondsAgoMs));

    const result = postSessionKillSwitch(
      { agent_summary: { complete: 1, failed: 0, partial: 0, spiral: 0 } },
      {
        carryoverThreshold: 0.5,
        autopilotJsonlPath: jsonlPath,
        stallTimeoutSeconds: 600,
        nowMs: () => fakeNow,
      }
    );

    expect(result).toBeNull();
  });

  it('does NOT fire when autopilot.jsonl is missing (contract: stallSeconds=0)', () => {
    // Explicitly documented contract: missing file → stallSeconds=0 → kill
    // condition is FALSE because 0 < 600. Missing file is NOT a kill-switch
    // trigger; it represents "no history yet" rather than "stalled".
    const missingPath = path.join(tmp, 'does-not-exist.jsonl');

    const result = postSessionKillSwitch(
      { agent_summary: { complete: 1, failed: 0, partial: 0, spiral: 0 } },
      {
        carryoverThreshold: 0.5,
        autopilotJsonlPath: missingPath,
        stallTimeoutSeconds: 600,
        nowMs: () => 2_000_000_000_000,
      }
    );

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// preIterationKillSwitch — regression check after STALL_TIMEOUT addition
// ---------------------------------------------------------------------------

describe('preIterationKillSwitch — regression check after STALL_TIMEOUT addition', () => {
  it('still fires TOKEN_BUDGET_EXCEEDED when cumulative tokens exceed maxTokens', () => {
    const result = preIterationKillSwitch({
      maxTokens: 1000,
      cumulativeTokensUsed: 1500,
    });
    expect(result?.kill).toBe(KILL_SWITCHES.TOKEN_BUDGET_EXCEEDED);
  });

  it('returns null when no kill condition is met', () => {
    const result = preIterationKillSwitch({
      aborted: false,
      iterationsCompleted: 2,
      maxSessions: 10,
      elapsedMs: 1_000,
      maxHoursMs: 3_600_000,
      maxTokens: 100_000,
      cumulativeTokensUsed: 500,
      resourceVerdict: 'green',
      peerCount: 0,
      peerAbortThreshold: 5,
    });
    expect(result).toBeNull();
  });

  it('fires USER_ABORT when aborted is true', () => {
    const result = preIterationKillSwitch({ aborted: true });
    expect(result?.kill).toBe(KILL_SWITCHES.USER_ABORT);
  });
});
