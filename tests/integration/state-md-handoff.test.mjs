/**
 * Integration test for Epic #271 Phase A — session-end Phase 3.7a
 * Compute-and-Write-Recommendations integration (#273).
 *
 * Simulates the Phase 3.7a writer in isolation (no full SKILL.md run) against
 * a fixture STATE.md, then re-parses the frontmatter to verify the 5
 * Recommendation fields were written additively and all existing keys
 * (including custom-extension) are preserved.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseStateMd,
  updateFrontmatterFields,
  parseRecommendations,
} from '@lib/state-md.mjs';
import { computeV0Recommendation } from '@lib/recommendations-v0.mjs';

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'state-md-handoff-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Simulates session-end Phase 3.7a in isolation. Mirrors the shell snippet
 * in `skills/session-end/SKILL.md` § 3.7a but written as a pure JS function
 * for deterministic testing.
 */
function writeRecommendationsPhase37a(statePath, metrics, sweepLogPath) {
  try {
    const rec = computeV0Recommendation({
      completionRate: metrics.completionRate,
      carryoverRatio: metrics.carryoverRatio,
      carryoverIssues: metrics.carryoverIssues,
    });
    const fields = {
      'recommended-mode': rec.mode,
      'top-priorities': rec.priorities,
      'carryover-ratio': Number(metrics.carryoverRatio.toFixed(2)),
      'completion-rate': Number(metrics.completionRate.toFixed(2)),
      rationale: rec.rationale,
    };
    const contents = readFileSync(statePath, 'utf8');
    writeFileSync(statePath, updateFrontmatterFields(contents, fields));
    return { ok: true, rec };
  } catch (err) {
    writeFileSync(
      sweepLogPath,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'recommendation-compute-failed',
        error: String((err && err.message) || err),
      }) + '\n',
      { flag: 'a' },
    );
    return { ok: false, err };
  }
}

describe('session-end Phase 3.7a — state-md handoff', () => {
  it('AC1: writes all 5 Recommendation fields into STATE.md frontmatter', () => {
    const statePath = join(tmp, 'STATE.md');
    writeFileSync(
      statePath,
      `---
schema-version: 1
session-type: deep
branch: main
issues: [272, 273, 274, 275]
started_at: 2026-04-24T18:10:00+02:00
status: active
current-wave: 5
total-waves: 5
---

## Current Wave

Wave 5 — Finalization
`,
    );

    const result = writeRecommendationsPhase37a(
      statePath,
      {
        completionRate: 1.0,
        carryoverRatio: 0.0,
        carryoverIssues: [],
      },
      join(tmp, 'sweep.log'),
    );

    expect(result.ok).toBe(true);
    const parsed = parseStateMd(readFileSync(statePath, 'utf8'));
    const rec = parseRecommendations(parsed.frontmatter);
    expect(rec).not.toBeNull();
    expect(rec.mode).toBe('feature');
    expect(rec.completionRate).toBe(1.0);
    expect(rec.carryoverRatio).toBe(0.0);
    expect(rec.rationale).toBe('v0: default clean completion');
    expect(rec.priorities).toEqual([]);

    // schema-version unchanged
    expect(parsed.frontmatter['schema-version']).toBe(1);
  });

  it('AC1: additive write — existing frontmatter keys (incl. custom extensions) preserved', () => {
    const statePath = join(tmp, 'STATE.md');
    writeFileSync(
      statePath,
      `---
schema-version: 1
session-type: deep
custom-extension: "keep-me"
issues: [100, 200]
status: active
---

body
`,
    );

    writeRecommendationsPhase37a(
      statePath,
      { completionRate: 0.7, carryoverRatio: 0.4, carryoverIssues: [500, 501] },
      join(tmp, 'sweep.log'),
    );

    const parsed = parseStateMd(readFileSync(statePath, 'utf8'));
    expect(parsed.frontmatter['custom-extension']).toBe('keep-me');
    expect(parsed.frontmatter.issues).toEqual([100, 200]);
    expect(parsed.frontmatter['session-type']).toBe('deep');
    expect(parsed.frontmatter.status).toBe('active'); // status: completed not yet set
    expect(parsed.frontmatter['recommended-mode']).toBe('deep');
    expect(parsed.frontmatter['top-priorities']).toEqual([500, 501]);
  });

  it('AC2: writer runs BEFORE status: completed — status stays `active` during write', () => {
    const statePath = join(tmp, 'STATE.md');
    writeFileSync(
      statePath,
      `---
status: active
schema-version: 1
---

body
`,
    );

    writeRecommendationsPhase37a(
      statePath,
      { completionRate: 1.0, carryoverRatio: 0.0, carryoverIssues: [] },
      join(tmp, 'sweep.log'),
    );

    const parsed = parseStateMd(readFileSync(statePath, 'utf8'));
    expect(parsed.frontmatter.status).toBe('active');
    expect(parsed.frontmatter['recommended-mode']).toBe('feature');
  });

  it('AC3: exception path — fields omitted, sweep.log entry written, no STATE.md corruption', () => {
    const statePath = join(tmp, 'STATE.md');
    const beforeContents = `---
status: active
schema-version: 1
---

body
`;
    writeFileSync(statePath, beforeContents);
    const sweepLog = join(tmp, 'sweep.log');

    // Force a throw: completionRate type-mismatch triggers TypeError in compute.
    const result = writeRecommendationsPhase37a(
      statePath,
      { completionRate: 'not-a-number', carryoverRatio: 0.1, carryoverIssues: [] },
      sweepLog,
    );

    expect(result.ok).toBe(false);
    expect(existsSync(sweepLog)).toBe(true);
    const logContents = readFileSync(sweepLog, 'utf8').trim();
    const evt = JSON.parse(logContents);
    expect(evt.event).toBe('recommendation-compute-failed');
    expect(evt.error).toMatch(/number/i);

    // STATE.md unchanged
    expect(readFileSync(statePath, 'utf8')).toBe(beforeContents);
  });

  it('AC3 follow-on: after exception, Phase 3.4 can still proceed (status: completed stays settable)', () => {
    const statePath = join(tmp, 'STATE.md');
    writeFileSync(
      statePath,
      `---
status: active
schema-version: 1
---

body
`,
    );

    writeRecommendationsPhase37a(
      statePath,
      { completionRate: 'bogus', carryoverRatio: 0.1, carryoverIssues: [] },
      join(tmp, 'sweep.log'),
    );

    // Simulate Phase 3.4's subsequent status: completed write (unrelated to 3.7a's failure)
    const after = updateFrontmatterFields(readFileSync(statePath, 'utf8'), {
      status: 'completed',
    });
    writeFileSync(statePath, after);

    const parsed = parseStateMd(readFileSync(statePath, 'utf8'));
    expect(parsed.frontmatter.status).toBe('completed');
    expect(parseRecommendations(parsed.frontmatter)).toBeNull(); // no rec fields
  });
});
