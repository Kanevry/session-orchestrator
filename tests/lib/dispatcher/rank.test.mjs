import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  scoreCandidate,
  rankCandidates,
  defaultDeps,
  STALENESS_CAP_DAYS,
} from '../../../scripts/lib/dispatcher/rank.mjs';

const MS_PER_DAY = 86_400_000;

// Deterministic clock for every rankCandidates call. Its exact value is
// irrelevant because all signal sources are injected via deps — no dep reads
// `nowMs` to derive a score in these tests.
const FIXED_NOW = Date.parse('2026-06-18T12:00:00.000Z');

/**
 * Stub deps factory: every signal source is a constant function so the score
 * for each candidate is fully determined by the values passed here. Lets each
 * test pin exact per-candidate signals without touching glab/gh/fs/CI.
 *
 * @param {{
 *   priorityByRepo?: Record<string, {criticalCount:number,highCount:number}|null>,
 *   staleByRepo?: Record<string, number>,
 *   ciByRepo?: Record<string, 'green'|'red'|'unknown'|null>,
 *   resourceVerdict?: 'green'|'warn'|'degraded'|'critical',
 *   fetchPriority?: Function,
 *   resourceVerdictFn?: Function,
 * }} cfg
 */
function makeDeps(cfg = {}) {
  return {
    fetchPriority:
      cfg.fetchPriority ??
      (async (repoRoot) => (cfg.priorityByRepo ? cfg.priorityByRepo[repoRoot] ?? null : null)),
    staleDaysFor: async (repoRoot) => (cfg.staleByRepo ? cfg.staleByRepo[repoRoot] ?? 0 : 0),
    checkCiStatus: async ({ repoRoot }) => (cfg.ciByRepo ? cfg.ciByRepo[repoRoot] ?? null : null),
    resourceVerdict: cfg.resourceVerdictFn ?? (async () => cfg.resourceVerdict ?? 'green'),
  };
}

/** Minimal FREE candidate shape (dispatcher pre-filters free === true). */
function candidate(repoName) {
  return {
    repoRoot: repoName,
    repoName,
    free: true,
    status: 'frei',
    heartbeat: null,
    sessionId: null,
  };
}

describe('scoreCandidate — exact hand-computed values', () => {
  it('null priority is neutral (1) — competes on staleness×readiness only', () => {
    // priorityScore=1, stalenessScore=1+30/30=2, readiness=1 → 1·2·1 = 2
    expect(
      scoreCandidate({
        priority: null,
        staleDays: 30,
        readiness: { ciStatus: 'green', resourceVerdict: 'green' },
      }),
    ).toBe(2);
  });

  it('clamps staleness at STALENESS_CAP_DAYS (120 days scores like 90)', () => {
    // priorityScore=1+2·1=3, stalenessScore=1+min(120,90)/30=4, readiness=1 → 3·4·1 = 12
    expect(
      scoreCandidate({
        priority: { criticalCount: 1, highCount: 0 },
        staleDays: 120,
        readiness: { ciStatus: 'green', resourceVerdict: 'green' },
      }),
    ).toBe(12);
  });

  it('staleness at exactly the cap (90 days) scores identically to beyond-cap', () => {
    // Proves the cap: 90 and 120 (above) both yield stalenessScore 4 → 12
    expect(
      scoreCandidate({
        priority: { criticalCount: 1, highCount: 0 },
        staleDays: 90,
        readiness: { ciStatus: 'green', resourceVerdict: 'green' },
      }),
    ).toBe(12);
  });

  it('red CI dampens readiness to 0.25', () => {
    // priorityScore=1+1·2=3, stalenessScore=1+0/30=1, ciFactor=0.25 → 3·1·0.25 = 0.75
    expect(
      scoreCandidate({
        priority: { criticalCount: 0, highCount: 2 },
        staleDays: 0,
        readiness: { ciStatus: 'red', resourceVerdict: 'green' },
      }),
    ).toBe(0.75);
  });

  it('critical resource verdict dampens readiness to 0.25', () => {
    // priorityScore=1+2·2+1=6, stalenessScore=1+60/30=3, resourceFactor=0.25 → 6·3·0.25 = 4.5
    expect(
      scoreCandidate({
        priority: { criticalCount: 2, highCount: 1 },
        staleDays: 60,
        readiness: { ciStatus: 'green', resourceVerdict: 'critical' },
      }),
    ).toBe(4.5);
  });

  it('degraded resource verdict dampens readiness to 0.6', () => {
    // priorityScore=1+2·1+1=4, stalenessScore=1+30/30=2, resourceFactor=0.6 → 4·2·0.6 = 4.8
    expect(
      scoreCandidate({
        priority: { criticalCount: 1, highCount: 1 },
        staleDays: 30,
        readiness: { ciStatus: 'green', resourceVerdict: 'degraded' },
      }),
    ).toBe(4.8);
  });

  it('red CI AND degraded resource compound (0.25·0.6 = 0.15)', () => {
    // priorityScore=1 (null), stalenessScore=2, readiness=0.25·0.6=0.15 → 1·2·0.15 = 0.3
    expect(
      scoreCandidate({
        priority: null,
        staleDays: 30,
        readiness: { ciStatus: 'red', resourceVerdict: 'degraded' },
      }),
    ).toBe(0.3);
  });

  it('NaN staleDays clamps to 0 (stalenessScore 1)', () => {
    // staleDays NaN → 0 → stalenessScore=1, priorityScore=1, readiness=1 → 1
    expect(
      scoreCandidate({
        priority: null,
        staleDays: NaN,
        readiness: { ciStatus: 'green', resourceVerdict: 'green' },
      }),
    ).toBe(1);
  });

  it('negative staleDays clamps to 0 (stalenessScore 1)', () => {
    // staleDays -5 → not >0 → 0 → stalenessScore=1 → 1·1·1 = 1
    expect(
      scoreCandidate({
        priority: null,
        staleDays: -5,
        readiness: { ciStatus: 'green', resourceVerdict: 'green' },
      }),
    ).toBe(1);
  });

  it('exposes STALENESS_CAP_DAYS as 90', () => {
    expect(STALENESS_CAP_DAYS).toBe(90);
  });
});

describe('rankCandidates — DESC ordering by score', () => {
  it('sorts candidates highest score first and returns full descending order', async () => {
    // Scores (green CI + green resource, null priority unless noted):
    //  low:  staleDays 0  → 1·(1)·1 = 1
    //  mid:  staleDays 30 → 1·(2)·1 = 2
    //  high: priority{crit:2} staleDays 30 → (1+4)·2·1 = 10
    const deps = makeDeps({
      priorityByRepo: { high: { criticalCount: 2, highCount: 0 } },
      staleByRepo: { low: 0, mid: 30, high: 30 },
      ciByRepo: { low: 'green', mid: 'green', high: 'green' },
      resourceVerdict: 'green',
    });

    const { ranked } = await rankCandidates(
      [candidate('low'), candidate('mid'), candidate('high')],
      { now: FIXED_NOW, deps },
    );

    expect(ranked.map((r) => r.candidate.repoName)).toEqual(['high', 'mid', 'low']);
    expect(ranked.map((r) => r.score)).toEqual([10, 2, 1]);
  });

  it('attaches the gathered signals onto each ranked row', async () => {
    const deps = makeDeps({
      priorityByRepo: { alpha: { criticalCount: 1, highCount: 3 } },
      staleByRepo: { alpha: 45 },
      ciByRepo: { alpha: 'red' },
      resourceVerdict: 'degraded',
    });

    const { ranked } = await rankCandidates([candidate('alpha')], { now: FIXED_NOW, deps });

    expect(ranked[0].signals).toEqual({
      priority: { criticalCount: 1, highCount: 3 },
      staleDays: 45,
      readiness: { ciStatus: 'red', resourceVerdict: 'degraded' },
    });
  });
});

describe('rankCandidates — deterministic tiebreak', () => {
  it('breaks an equal-score tie by staleDays DESC, then repoName ASC', async () => {
    // All three null-priority, green/green. Score depends only on staleDays.
    //   tieA: staleDays 30 → score 2
    //   tieB: staleDays 30 → score 2 (same staleDays as tieA → repoName ASC: tieA before tieB)
    //   older: staleDays 60 → score 3 (higher staleness → higher score)
    // But to test the staleDays-DESC tiebreak among EQUAL scores we need equal
    // scores with different staleDays — engineered via priority offset:
    //   p1: priority{high:1} staleDays 0  → (1+1)·1·1 = 2
    //   p2: null            staleDays 30 → 1·2·1     = 2  (equal score, staleDays 30 > 0)
    // Equal score 2: staleDays DESC ⇒ p2 (30) before p1 (0).
    const deps = makeDeps({
      priorityByRepo: { p1: { criticalCount: 0, highCount: 1 }, p2: null },
      staleByRepo: { p1: 0, p2: 30 },
      ciByRepo: { p1: 'green', p2: 'green' },
      resourceVerdict: 'green',
    });

    const { ranked } = await rankCandidates([candidate('p1'), candidate('p2')], {
      now: FIXED_NOW,
      deps,
    });

    expect(ranked.map((r) => r.score)).toEqual([2, 2]);
    expect(ranked.map((r) => r.candidate.repoName)).toEqual(['p2', 'p1']);
  });

  it('breaks a fully-equal tie (same score AND staleDays) by repoName ASC', async () => {
    // zebra and apple: identical null-priority, staleDays 30, green/green → score 2 each.
    // Tiebreak falls through to repoName ASC ⇒ apple before zebra.
    const deps = makeDeps({
      priorityByRepo: { zebra: null, apple: null },
      staleByRepo: { zebra: 30, apple: 30 },
      ciByRepo: { zebra: 'green', apple: 'green' },
      resourceVerdict: 'green',
    });

    const { ranked } = await rankCandidates([candidate('zebra'), candidate('apple')], {
      now: FIXED_NOW,
      deps,
    });

    expect(ranked.map((r) => r.score)).toEqual([2, 2]);
    expect(ranked.map((r) => r.candidate.repoName)).toEqual(['apple', 'zebra']);
  });
});

describe('rankCandidates — glab/gh priority fallback (AC4)', () => {
  it('null fetchPriority ⇒ neutral score + a warning naming the repo, never throws', async () => {
    const deps = makeDeps({
      priorityByRepo: { nogh: null },
      staleByRepo: { nogh: 30 },
      ciByRepo: { nogh: 'green' },
      resourceVerdict: 'green',
    });

    const { ranked, warnings } = await rankCandidates([candidate('nogh')], {
      now: FIXED_NOW,
      deps,
    });

    // Scored on staleness×readiness only: priority null ⇒ 1·2·1 = 2.
    expect(ranked[0].score).toBe(2);
    expect(ranked[0].signals.priority).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('nogh');
    expect(warnings[0]).toContain('priority unavailable');
  });
});

describe('rankCandidates — throwing fetchPriority is caught (AC5)', () => {
  it('a fetchPriority that rejects is treated as null priority, candidate still ranks', async () => {
    const deps = makeDeps({
      fetchPriority: async () => {
        throw new Error('glab subprocess exploded');
      },
      staleByRepo: { boom: 30 },
      ciByRepo: { boom: 'green' },
      resourceVerdict: 'green',
    });

    const result = await rankCandidates([candidate('boom')], { now: FIXED_NOW, deps });

    expect(result.ranked).toHaveLength(1);
    expect(result.ranked[0].score).toBe(2); // null priority → 1·2·1
    expect(result.ranked[0].signals.priority).toBeNull();
    expect(result.warnings[0]).toContain('boom');
  });
});

describe('rankCandidates — host resource-probe failure (AC6)', () => {
  it('a throwing resourceVerdict dep pushes a resource-unavailable warning and ranks on green', async () => {
    const deps = makeDeps({
      resourceVerdictFn: async () => {
        throw new Error('host probe failed');
      },
      priorityByRepo: { r: { criticalCount: 1, highCount: 0 } },
      staleByRepo: { r: 30 },
      ciByRepo: { r: 'green' },
    });

    const { ranked, warnings } = await rankCandidates([candidate('r')], {
      now: FIXED_NOW,
      deps,
    });

    // resourceVerdict defaulted to 'green' (non-dampening): (1+2)·2·1 = 6.
    expect(ranked[0].score).toBe(6);
    expect(ranked[0].signals.readiness.resourceVerdict).toBe('green');
    expect(warnings.some((w) => w.includes('resource verdict unavailable'))).toBe(true);
  });
});

describe('rankCandidates — empty input (AC7)', () => {
  it('empty candidate list returns empty ranked + empty warnings', async () => {
    const deps = makeDeps({ resourceVerdict: 'green' });
    const result = await rankCandidates([], { now: FIXED_NOW, deps });
    expect(result).toEqual({ ranked: [], warnings: [] });
  });

  it('non-array input is treated as empty (no throw)', async () => {
    const deps = makeDeps({ resourceVerdict: 'green' });
    const result = await rankCandidates(undefined, { now: FIXED_NOW, deps });
    expect(result).toEqual({ ranked: [], warnings: [] });
  });
});

describe('rankCandidates — shared host resource verdict (AC6 sharing contract)', () => {
  it('fetches the host resource verdict exactly once for the whole run', async () => {
    let calls = 0;
    const deps = makeDeps({
      priorityByRepo: { a: null, b: null, c: null },
      staleByRepo: { a: 30, b: 30, c: 30 },
      resourceVerdictFn: async () => {
        calls += 1;
        return 'critical';
      },
    });

    const { ranked } = await rankCandidates(
      [candidate('a'), candidate('b'), candidate('c')],
      { now: FIXED_NOW, deps },
    );

    expect(calls).toBe(1);
    // Every candidate shares the single 'critical' verdict (resourceFactor 0.25):
    // null priority, staleDays 30 → 1·2·0.25 = 0.5.
    expect(ranked.map((r) => r.signals.readiness.resourceVerdict)).toEqual([
      'critical',
      'critical',
      'critical',
    ]);
    expect(ranked.map((r) => r.score)).toEqual([0.5, 0.5, 0.5]);
  });
});

describe('defaultDeps', () => {
  it('returns the four real signal-source functions', () => {
    const deps = defaultDeps();
    expect(typeof deps.fetchPriority).toBe('function');
    expect(typeof deps.staleDaysFor).toBe('function');
    expect(typeof deps.checkCiStatus).toBe('function');
    expect(typeof deps.resourceVerdict).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// defaultDeps().staleDaysFor — abandoned-stub tail skip (#834)
// ---------------------------------------------------------------------------

describe('defaultDeps().staleDaysFor — abandoned-stub tail skip (#834)', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'rank-stale-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /**
   * Fake-regression fixture: the LAST line is an abandoned stub dated "today"
   * (nowMs), while the last REAL session is ~60 days old. Reading only the raw
   * last line (the pre-#834 bug) would compute ~0 stale-days, making a
   * genuinely neglected repo look freshly touched — the N=1 extreme case where
   * one phantom stub is enough to zero out staleness and defeat the
   * dispatcher's whole purpose.
   */
  function seedPhantomTailFixture(nowMs) {
    const dir = join(tmpRoot, '.orchestrator', 'metrics');
    mkdirSync(dir, { recursive: true });
    const realCompletedAt = new Date(nowMs - 60 * MS_PER_DAY).toISOString();
    const abandonedCompletedAt = new Date(nowMs).toISOString();
    const lines = [
      JSON.stringify({ session_id: 'real-1', completed_at: realCompletedAt, agent_summary: { complete: 3 } }),
      JSON.stringify({
        session_id: 'ghost-1',
        completed_at: abandonedCompletedAt,
        agent_summary: { complete: 0, partial: 0, failed: 0, spiral: 0 },
        status: 'abandoned',
      }),
    ];
    writeFileSync(join(dir, 'sessions.jsonl'), lines.join('\n') + '\n', 'utf8');
  }

  it('computes stale-days from the last REAL session (~60), not the trailing abandoned stub (~0)', async () => {
    const nowMs = Date.parse('2026-07-19T12:00:00.000Z');
    seedPhantomTailFixture(nowMs);

    const staleDays = await defaultDeps().staleDaysFor(tmpRoot, nowMs);

    expect(staleDays).toBeGreaterThan(59);
    expect(staleDays).toBeLessThan(61);
  });
});
