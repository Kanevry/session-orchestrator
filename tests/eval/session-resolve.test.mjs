/**
 * tests/eval/session-resolve.test.mjs
 *
 * Fake-regression coverage for the #1209 sessions-canonical migration of
 * `scripts/lib/eval/engine.mjs` (session-resolve.mjs's production caller).
 *
 * `resolveSession`/`findPeerOverlap` themselves are pure functions over
 * whatever `records` array a caller hands in — the bulk of their behaviour is
 * already covered inline in `tests/eval/engine.test.mjs` (cascade resolution,
 * strict-overlap detection). This file covers ONE thing that file does not:
 * the #1068 double-stub class reaching `evaluateSession()` through its real
 * production path (`readCanonicalSessions` → `findPeerOverlap`), which needs
 * the FULL engine (not the bare pure function) to prove the collapse actually
 * lands before peer-overlap counting runs.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';

import { evaluateSession } from '@lib/eval/engine.mjs';
import { writeFixture, isoOffset } from '../fixtures/eval/metrics-tree/build.mjs';

const FIXED_TS = '2026-07-16T12:00:00.000Z';

const dirsToClean = [];
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

describe('findPeerOverlap via evaluateSession — #1209: #1068 double-stub pair no longer double-counts', () => {
  it('a synthetic backfill twin of an abandoned session is not counted as a SECOND peer', () => {
    const base = Date.now();
    const mainStart = isoOffset(base, 4);
    const mainEnd = isoOffset(base, 2);
    // Fully inside the main session's window — guaranteed strict overlap.
    const abandonedStart = isoOffset(base, 3.5);
    const abandonedEnd = isoOffset(base, 3);

    const fx = writeFixture({
      sessionId: 'sess-main',
      sessions: [
        {
          schema_version: 1,
          session_id: 'sess-main',
          started_at: mainStart,
          completed_at: mainEnd,
          status: 'completed',
          total_waves: 1,
          total_files_changed: 1,
          waves: [{ wave: 1, quality: 'pass' }],
          agent_summary: { complete: 1, partial: 0, failed: 0, spiral: 0 },
          effectiveness: { planned_issues: 1, completed: 1, carryover: 0, completion_rate: 1 },
        },
        // The #1068 double-stub pair: SAME started_at/completed_at, one
        // authentic (real semantic id), one synthetic (backfill twin) — see
        // sessions-canonical.mjs `collapseAbandonedTuples()` for the exact
        // shape this rule requires.
        {
          session_id: 'sess-abandoned-real',
          started_at: abandonedStart,
          completed_at: abandonedEnd,
          status: 'abandoned',
        },
        {
          session_id: 'main-2026-06-01-abandoned-a1b2c3d4',
          started_at: abandonedStart,
          completed_at: abandonedEnd,
          status: 'abandoned',
          _synthetic_session_id: true,
        },
      ],
      events: [],
    });
    dirsToClean.push(fx.dir);

    const { summary } = evaluateSession({
      metricsDir: fx.dir,
      rubricPath: fx.rubricPath,
      timestamp: FIXED_TS,
      model: { id: 'test-model-v1', source: 'self-report' },
      resolveModelFromEnv: false,
      env: {},
    });

    // ONE physical abandoned session overlapped the window — not two lines.
    expect(summary.peerCount).toBe(1);
    expect(summary.peers).toEqual(['sess-abandoned-real']);
  });
});
