/**
 * tests/lib/session-end/tail-runner.test.mjs
 *
 * The bug this file exists for, in one line: session-end Phase 3.6.4 computed a
 * dry-run sweep decision on every close and then never applied it, because the
 * apply half was coordinator PROSE. Census 2026-09-09 — `sweepExpiredLearnings`
 * had no session-end caller at all; across three consumer repos 0 sweeps were
 * ever applied and 628 learnings sat resident in the active stores.
 *
 * Each test below names the concrete bug it catches (TV-001):
 *   1. the sweep is never applied (the measured defect);
 *   2. the apply leaves no ledger trace, so "did it ever run?" stays unanswerable;
 *   3. a runner that ignores the plan and sweeps unconditionally;
 *   4. a runner that throws on a corrupt store and takes the session close with it.
 *
 * LEDGER SAFETY (copied from tests/lib/express-path.test.mjs): every emitting
 * test passes an explicit tmp `repoRoot`, AND `CLAUDE_PROJECT_DIR` is pinned to
 * a throwaway sentinel tree at FILE SCOPE — before any lazy `events.mjs` →
 * `platform.mjs` import can compute its module-level `SO_PROJECT_DIR` const —
 * so a regression of the repoRoot guard lands in the sentinel rather than in the
 * operator's real ledger.
 */

import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// --- must run before any lazy import of events.mjs → platform.mjs ------------
const SENTINEL = mkdtempSync(join(tmpdir(), 'tail-runner-sentinel-'));
process.env.CLAUDE_PROJECT_DIR = SENTINEL;

const { runExpiredSweep, runTailPhases } = await import('@lib/session-end/tail-runner.mjs');
const { planTailPhases } = await import('@lib/session-end/phase-skip.mjs');

const SENTINEL_LEDGER = join(SENTINEL, '.orchestrator', 'metrics', 'events.jsonl');

// ---------------------------------------------------------------------------
// tmp helpers
// ---------------------------------------------------------------------------

let tmpDirs = [];

afterEach(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  tmpDirs = [];
});

afterAll(() => {
  try { rmSync(SENTINEL, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'tail-runner-'));
  tmpDirs.push(root);
  mkdirSync(join(root, '.orchestrator', 'metrics'), { recursive: true });
  return root;
}

const metric = (root, name) => join(root, '.orchestrator', 'metrics', name);

function writeJsonl(file, records) {
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

/** A schema-complete learning; `expires_at` is what the sweep partitions on. */
function learning(id, expiresAt) {
  return {
    id,
    type: 'convention',
    subject: id,
    insight: `${id} insight`,
    evidence: `${id} evidence`,
    confidence: 0.8,
    source_session: 'test-session',
    created_at: '2020-01-01T00:00:00.000Z',
    expires_at: expiresAt,
    schema_version: 1,
  };
}

const EXPIRED = '2020-06-01T00:00:00.000Z'; // long past the 14-day grace window
const LIVE = '2099-01-01T00:00:00.000Z';

/** Populate a repo with one expired-past-grace and one live learning. */
function seedStore(root) {
  writeJsonl(metric(root, 'learnings.jsonl'), [learning('expired-1', EXPIRED), learning('live-1', LIVE)]);
  return root;
}

/** The real planner's decision — never a hand-built stand-in. */
const planFor = (root) => planTailPhases({ repoRoot: root, config: {} });

// ---------------------------------------------------------------------------

describe('runExpiredSweep', () => {
  it('archives the expired entry and leaves the live one', async () => {
    // THE measured bug: nothing ever called the apply path, so an expired entry
    // stayed in the active store forever (628 resident across 3 repos).
    const root = seedStore(makeRepo());
    const plan = await planFor(root);
    expect(plan.plan.find((d) => d.phase === '3.6.4').run).toBe(true); // premise

    const res = await runExpiredSweep({ repoRoot: root, plan });

    expect(res).toMatchObject({ ran: true, scanned: 2, archived: 1 });
    expect(readJsonl(metric(root, 'learnings.jsonl')).map((e) => e.id)).toEqual(['live-1']);
    const archived = readJsonl(metric(root, 'learnings-archive.jsonl'));
    expect(archived.map((e) => e.id)).toEqual(['expired-1']);
    expect(archived[0]._archive_reason).toBe('expired');
  });

  it('emits orchestrator.learnings.sweep_applied with the archived count', async () => {
    // Bug: an apply with no ledger record leaves "has the sweep ever run?"
    // unanswerable — exactly the state that hid the missing caller for months.
    const root = seedStore(makeRepo());
    const plan = await planFor(root);

    await runExpiredSweep({ repoRoot: root, plan });

    const events = readJsonl(metric(root, 'events.jsonl'));
    const sweeps = events.filter((e) => e.event === 'orchestrator.learnings.sweep_applied');
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]).toMatchObject({ scanned: 2, archived: 1, source: 'session-end-3.6.4' });
    // Ledger-safety guard: nothing leaked to the ambient destination.
    expect(existsSync(SENTINEL_LEDGER)).toBe(false);
  });

  it('does nothing when the plan says skip', async () => {
    // Bug: a runner that re-derives (or ignores) the decision may sweep a store
    // the planner deliberately left alone — the planner owns the decision.
    const root = makeRepo();
    writeJsonl(metric(root, 'learnings.jsonl'), [learning('live-1', LIVE)]);
    const plan = await planFor(root);
    expect(plan.plan.find((d) => d.phase === '3.6.4').run).toBe(false); // premise

    const res = await runExpiredSweep({ repoRoot: root, plan });

    expect(res).toMatchObject({ ran: false, reason: 'plan-skip' });
    expect(readJsonl(metric(root, 'learnings.jsonl')).map((e) => e.id)).toEqual(['live-1']);
    expect(existsSync(metric(root, 'events.jsonl'))).toBe(false);
  });

  it('returns ran:false with no plan at all instead of sweeping unconditionally', async () => {
    // Bug: an absent/garbled plan must not read as consent to rewrite the store.
    const root = seedStore(makeRepo());
    const res = await runExpiredSweep({ repoRoot: root });
    expect(res).toEqual({ ran: false, reason: 'no-plan' });
    expect(readJsonl(metric(root, 'learnings.jsonl'))).toHaveLength(2);
  });

  it('returns ran:false on a corrupt learnings file instead of throwing', async () => {
    // Bug: a best-effort maintenance sweep that throws takes the session close
    // with it — and the session record, not the sweep, is the thing that matters.
    const root = makeRepo();
    // A DIRECTORY where the store belongs: existsSync() says present, the read throws.
    mkdirSync(metric(root, 'learnings.jsonl'));
    // The planner fail-OPENS here (probe-error → run:true), so the runner is
    // genuinely asked to sweep an unreadable store.
    const plan = await planFor(root);
    expect(plan.plan.find((d) => d.phase === '3.6.4').run).toBe(true); // premise

    const res = await runExpiredSweep({ repoRoot: root, plan });

    expect(res.ran).toBe(false);
    expect(res.reason).toBe('error');
    expect(typeof res.error).toBe('string');
  });

  it('accepts the bare 3.6.4 decision as well as the full plan envelope', async () => {
    // Bug: a caller holding only the phase entry would otherwise need an adapter,
    // and the obvious hand-rolled one silently degrades to "no-plan" (= never runs).
    const root = seedStore(makeRepo());
    const { plan } = await planFor(root);
    const decision = plan.find((d) => d.phase === '3.6.4');

    expect(await runExpiredSweep({ repoRoot: root, plan: decision, emit: false }))
      .toMatchObject({ ran: true, archived: 1 });
  });

  it('refuses to sweep without a repoRoot rather than resolving an ambient tree', async () => {
    // Bug (#941 class): falling back to SO_PROJECT_DIR would rewrite whatever
    // learnings store the ambient env resolves to — the operator's real one.
    const res = await runExpiredSweep({
      plan: [{ phase: '3.6.4', run: true, reason: 'x', inputSource: 'sweep-dry-run' }],
    });
    expect(res).toMatchObject({ ran: false, reason: 'error' });
  });
});

describe('runTailPhases', () => {
  it('dispatches 3.6.4 and returns it under its phase key', async () => {
    // Bug: the seam must key results by phase id — a bare result would force
    // every future caller to be rewritten when a second phase becomes mechanical.
    const root = seedStore(makeRepo());
    const plan = await planFor(root);

    const results = await runTailPhases({ repoRoot: root, plan, emit: false });

    expect(Object.keys(results)).toEqual(['3.6.4']);
    expect(results['3.6.4']).toMatchObject({ ran: true, scanned: 2, archived: 1 });
  });
});
