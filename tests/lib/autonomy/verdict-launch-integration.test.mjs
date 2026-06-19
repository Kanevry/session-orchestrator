// SPDX-License-Identifier: MIT
// Integration tests for the #682 verdict-gated launch path (Epic #673 P3,
// NICE-c deliverable). Exercises the launch-gate decision END-TO-END by
// combining the REAL autopilot run reader with the REAL suitability engine:
//
//   readRecentAutopilotRuns({ repoRoot })  →  recentRuns array
//   computeSuitabilityVerdict({ ..., recentRuns })  →  { suitable, rationale, ... }
//   mayAutoLaunch(autonomy, verdict)  →  the coordinator's launch decision
//
// `mayAutoLaunch` models the dispatcher PROSE decision (autonomy gate AND
// suitable). It is encoded INSIDE this test by design — it is NOT a production
// import; it documents the fail-closed invariant the dispatcher must honour.
//
// Portability: tmp autopilot.jsonl under mkdtempSync(tmpdir()); cleaned in
// afterEach. NO hardcoded home/absolute paths (owner-leakage hook blocks them).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readRecentAutopilotRuns } from '../../../scripts/lib/autopilot/recent-runs.mjs';
import { computeSuitabilityVerdict } from '../../../scripts/lib/autonomy/suitability.mjs';

const createdDirs = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    rmSync(createdDirs.pop(), { recursive: true, force: true });
  }
});

/**
 * Materialise a tmp repoRoot with an autopilot.jsonl built from run records.
 * `runs` is an array of kill_switch values (string|null). Returns the repoRoot.
 * Fixture setup, not test logic.
 */
function makeRepoWithRuns(runs) {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'verdict-launch-'));
  createdDirs.push(repoRoot);
  const metricsDir = path.join(repoRoot, '.orchestrator', 'metrics');
  mkdirSync(metricsDir, { recursive: true });
  const lines = runs.map((ks) => JSON.stringify({ kill_switch: ks }));
  writeFileSync(path.join(metricsDir, 'autopilot.jsonl'), lines.join('\n'), 'utf8');
  return repoRoot;
}

/**
 * The dispatcher launch-gate decision, modeled in-test (the #682 fail-closed
 * invariant): auto-launch is permitted ONLY when the autonomy dial is
 * 'autonomous-gated' AND the suitability verdict says suitable. Every other
 * autonomy value (off / advisory / undefined) means inform-and-ask, never auto.
 * Encoded here on purpose — it is the prose decision under test, not an import.
 */
function mayAutoLaunch(autonomy, verdict) {
  return autonomy === 'autonomous-gated' && verdict.suitable === true;
}

describe('verdict-launch — forcedFail: CI red is not rescued by confidence', () => {
  it('CI red + confidence 0.99 + clean history → suitable false', () => {
    const repoRoot = makeRepoWithRuns(Array.from({ length: 6 }, () => null));
    const recentRuns = readRecentAutopilotRuns({ repoRoot });
    const verdict = computeSuitabilityVerdict({
      confidence: 0.99,
      ci: { status: 'red' },
      resourceVerdict: 'green',
      recentRuns,
    });
    expect(verdict.suitable).toBe(false);
  });

  it('CI red rationale carries the FORCED / CI red wording', () => {
    const repoRoot = makeRepoWithRuns(Array.from({ length: 6 }, () => null));
    const recentRuns = readRecentAutopilotRuns({ repoRoot });
    const verdict = computeSuitabilityVerdict({
      confidence: 0.99,
      ci: { status: 'red' },
      resourceVerdict: 'green',
      recentRuns,
    });
    expect(verdict.rationale).toContain('FORCED');
    expect(verdict.rationale).toContain('CI red');
  });

  it('CI red blocks auto-launch even under autonomous-gated', () => {
    const repoRoot = makeRepoWithRuns(Array.from({ length: 6 }, () => null));
    const recentRuns = readRecentAutopilotRuns({ repoRoot });
    const verdict = computeSuitabilityVerdict({
      confidence: 0.99,
      ci: { status: 'red' },
      resourceVerdict: 'green',
      recentRuns,
    });
    expect(mayAutoLaunch('autonomous-gated', verdict)).toBe(false);
  });
});

describe('verdict-launch — forcedFail: resource critical is not rescued by confidence', () => {
  it('resource critical + confidence 0.99 → suitable false', () => {
    const repoRoot = makeRepoWithRuns(Array.from({ length: 6 }, () => null));
    const recentRuns = readRecentAutopilotRuns({ repoRoot });
    const verdict = computeSuitabilityVerdict({
      confidence: 0.99,
      ci: { status: 'green' },
      resourceVerdict: 'critical',
      recentRuns,
    });
    expect(verdict.suitable).toBe(false);
  });

  it('resource critical rationale mentions FORCED resource critical', () => {
    const repoRoot = makeRepoWithRuns(Array.from({ length: 6 }, () => null));
    const recentRuns = readRecentAutopilotRuns({ repoRoot });
    const verdict = computeSuitabilityVerdict({
      confidence: 0.99,
      ci: { status: 'green' },
      resourceVerdict: 'critical',
      recentRuns,
    });
    expect(verdict.rationale).toContain('FORCED');
    expect(verdict.rationale).toContain('resource critical');
  });
});

describe('verdict-launch — fail-closed autonomy gate (the #682 invariant)', () => {
  // A fully-suitable verdict, computed once via the real engine + reader.
  function suitableVerdict() {
    const repoRoot = makeRepoWithRuns(Array.from({ length: 6 }, () => null));
    const recentRuns = readRecentAutopilotRuns({ repoRoot });
    return computeSuitabilityVerdict({
      confidence: 0.8,
      ci: { status: 'green' },
      resourceVerdict: 'green',
      recentRuns,
    });
  }

  it('the base verdict is genuinely suitable (precondition)', () => {
    expect(suitableVerdict().suitable).toBe(true);
  });

  it("autonomy 'off' + suitable=true → mayAutoLaunch FALSE (inform+ask)", () => {
    expect(mayAutoLaunch('off', suitableVerdict())).toBe(false);
  });

  it("autonomy 'advisory' + suitable=true → mayAutoLaunch FALSE", () => {
    expect(mayAutoLaunch('advisory', suitableVerdict())).toBe(false);
  });

  it("autonomy 'autonomous-gated' + suitable=true → mayAutoLaunch TRUE", () => {
    expect(mayAutoLaunch('autonomous-gated', suitableVerdict())).toBe(true);
  });

  it("autonomy 'autonomous-gated' + suitable=false → mayAutoLaunch FALSE", () => {
    const repoRoot = makeRepoWithRuns(Array.from({ length: 6 }, () => null));
    const recentRuns = readRecentAutopilotRuns({ repoRoot });
    const unsuitable = computeSuitabilityVerdict({
      confidence: 0.99,
      ci: { status: 'red' }, // forces suitable=false
      resourceVerdict: 'green',
      recentRuns,
    });
    expect(mayAutoLaunch('autonomous-gated', unsuitable)).toBe(false);
  });
});

describe('verdict-launch — <5-run omission via the real reader (NICE-a end-to-end)', () => {
  it('3 runs (1 fired) → reader returns 3 records', () => {
    const repoRoot = makeRepoWithRuns(['spiral', null, null]);
    expect(readRecentAutopilotRuns({ repoRoot })).toHaveLength(3);
  });

  it('3 runs (1 fired) → G2 omitted, suitable stays true (not blocked by G2)', () => {
    const repoRoot = makeRepoWithRuns(['spiral', null, null]);
    const recentRuns = readRecentAutopilotRuns({ repoRoot });
    const verdict = computeSuitabilityVerdict({
      confidence: 0.8,
      ci: { status: 'green' },
      resourceVerdict: 'green',
      recentRuns,
    });
    expect(verdict.suitable).toBe(true);
  });

  it('3 runs → G2 omission warning is surfaced', () => {
    const repoRoot = makeRepoWithRuns(['spiral', null, null]);
    const recentRuns = readRecentAutopilotRuns({ repoRoot });
    const verdict = computeSuitabilityVerdict({
      confidence: 0.8,
      ci: { status: 'green' },
      resourceVerdict: 'green',
      recentRuns,
    });
    expect(verdict.warnings).toContain('kill-switch signal omitted: only 3<5 runs');
  });

  it('5 runs with firedRate >= 0.2 (2/5 = 0.4) → G2 fails, suitable false', () => {
    const repoRoot = makeRepoWithRuns(['spiral', 'max-hours', null, null, null]);
    const recentRuns = readRecentAutopilotRuns({ repoRoot });
    const verdict = computeSuitabilityVerdict({
      confidence: 0.99,
      ci: { status: 'green' },
      resourceVerdict: 'green',
      recentRuns,
    });
    expect(verdict.suitable).toBe(false);
  });

  it('5 runs, firedRate 0.4 → G2 FAIL segment quotes 2/5', () => {
    const repoRoot = makeRepoWithRuns(['spiral', 'max-hours', null, null, null]);
    const recentRuns = readRecentAutopilotRuns({ repoRoot });
    const verdict = computeSuitabilityVerdict({
      confidence: 0.99,
      ci: { status: 'green' },
      resourceVerdict: 'green',
      recentRuns,
    });
    expect(verdict.rationale).toContain('kill-switch 2/5 fired rate=0.4 FAIL');
  });

  it('6 runs, 0 fired (firedRate 0 < 0.2) → G2 passes, suitable true', () => {
    const repoRoot = makeRepoWithRuns(Array.from({ length: 6 }, () => null));
    const recentRuns = readRecentAutopilotRuns({ repoRoot });
    const verdict = computeSuitabilityVerdict({
      confidence: 0.8,
      ci: { status: 'green' },
      resourceVerdict: 'green',
      recentRuns,
    });
    expect(verdict.suitable).toBe(true);
  });
});

describe('verdict-launch — null ci/resource no-signal passes (NICE-b)', () => {
  it('ci=null + resourceVerdict=null + confidence>=floor + clean history → suitable true', () => {
    const repoRoot = makeRepoWithRuns(Array.from({ length: 6 }, () => null));
    const recentRuns = readRecentAutopilotRuns({ repoRoot });
    const verdict = computeSuitabilityVerdict({
      confidence: 0.8,
      ci: null,
      resourceVerdict: null,
      recentRuns,
    });
    expect(verdict.suitable).toBe(true);
  });

  it('null ci/resource → absent-signal warnings are surfaced', () => {
    const repoRoot = makeRepoWithRuns(Array.from({ length: 6 }, () => null));
    const recentRuns = readRecentAutopilotRuns({ repoRoot });
    const verdict = computeSuitabilityVerdict({
      confidence: 0.8,
      ci: null,
      resourceVerdict: null,
      recentRuns,
    });
    expect(verdict.warnings).toContain('CI signal absent');
    expect(verdict.warnings).toContain('resource signal absent');
  });

  it('malformed ci {status:undefined} still passes G3 but warns (why null is honest)', () => {
    const repoRoot = makeRepoWithRuns(Array.from({ length: 6 }, () => null));
    const recentRuns = readRecentAutopilotRuns({ repoRoot });
    const verdict = computeSuitabilityVerdict({
      confidence: 0.8,
      ci: { status: undefined },
      resourceVerdict: 'green',
      recentRuns,
    });
    expect(verdict.suitable).toBe(true);
    expect(verdict.warnings).toContain('CI signal malformed — treated as absent');
  });
});
