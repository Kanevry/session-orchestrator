/**
 * tests/lib/session-end/phase-skip.test.mjs
 *
 * Unit suite for the Phase 3.6.x tail skip-plan aggregator (Issue #724).
 *
 * Covers, per phase, both the SKIP (config-gate + empty-input) and the RUN
 * (input-smuggled fake-regression) branches, the compact `skippedReport`
 * format, and the never-throws / fail-open contract. Expected reasons are
 * hard-coded literals — no test-the-mock, no computed expectations.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { planTailPhases, buildSkippedReport } from '@lib/session-end/phase-skip.mjs';

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

/** Create an empty tmp repo with `.orchestrator/metrics/` and a non-existent memory dir. */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'so-phaseskip-'));
  tmpDirs.push(root);
  mkdirSync(join(root, '.orchestrator', 'metrics'), { recursive: true });
  return root;
}

function metric(root, name) {
  return join(root, '.orchestrator', 'metrics', name);
}

function writeJsonl(file, records) {
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

/** A full default config (matches parse-config.mjs defaults for the relevant keys). */
function defaultConfig(overrides = {}) {
  return {
    persistence: true,
    memory: { proposals: { enabled: true } },
    'auto-dream': { 'min-confidence': 0.5 },
    dialectic: { cadence: 5 },
    reconcile: { enabled: false, 'confidence-floor': 0.5, 'rule-expiry-days': null },
    'skill-evolution': { judge: false },
    'memory-cleanup-threshold': 5,
    'memory-cleanup-soft-limit': 180,
    ...overrides,
  };
}

/** Standard call: empty repo, non-existent memory dir so Auto-Dream reads zero. */
async function plan(root, config, extra = {}) {
  return planTailPhases({
    repoRoot: root,
    config,
    sessionId: 'sess-A',
    platform: 'claude',
    memoryDir: join(root, 'no-such-memory-dir'),
    ...extra,
  });
}

const byId = (p, id) => p.find((d) => d.phase === id);

// ---------------------------------------------------------------------------
// A — empty repo + default config → every tail phase skips
// ---------------------------------------------------------------------------

describe('A — all-skip on an empty repo with default config', () => {
  it('returns a 6-entry plan, all run:false', async () => {
    const root = makeRepo();
    const { plan: p } = await plan(root, defaultConfig());

    expect(p).toHaveLength(6);
    expect(p.map((d) => d.phase)).toEqual(['3.6.3', '3.6.4', '3.6.5', '3.6.6', '3.6.7', '3.6.8']);
    expect(p.every((d) => d.run === false)).toBe(true);
  });

  it('each phase carries the expected skip reason + inputSource', async () => {
    const root = makeRepo();
    const { plan: p } = await plan(root, defaultConfig());

    expect(byId(p, '3.6.3')).toMatchObject({ run: false, inputSource: 'proposals.jsonl' });
    expect(byId(p, '3.6.3').reason).toBe('proposals empty (queued=0)');

    expect(byId(p, '3.6.4')).toMatchObject({ run: false, inputSource: 'learnings.jsonl' });
    expect(byId(p, '3.6.4').reason).toBe('learnings.jsonl absent');

    expect(byId(p, '3.6.5')).toMatchObject({ run: false, inputSource: 'auto-dream-signal' });
    expect(byId(p, '3.6.5').reason).toContain('under-thresholds');

    expect(byId(p, '3.6.6')).toMatchObject({ run: false, inputSource: 'config-gate' });
    expect(byId(p, '3.6.6').reason).toBe('disabled (skill-evolution.judge=false)');

    expect(byId(p, '3.6.7')).toMatchObject({ run: false, inputSource: 'auto-dialectic-signal' });
    expect(byId(p, '3.6.7').reason).toBe('no-new-input-since-last-run');

    expect(byId(p, '3.6.8')).toMatchObject({ run: false, inputSource: 'config-gate' });
    expect(byId(p, '3.6.8').reason).toBe('disabled (reconcile.enabled=false)');
  });
});

// ---------------------------------------------------------------------------
// B — config-gate short-circuits (cheap, no disk touch)
// ---------------------------------------------------------------------------

describe('B — config-gate short-circuits', () => {
  it('persistence:false gates 3.6.3 / 3.6.7 / 3.6.8 with config-gate reason', async () => {
    const root = makeRepo();
    const { plan: p } = await plan(root, defaultConfig({ persistence: false }));

    for (const id of ['3.6.3', '3.6.7', '3.6.8']) {
      expect(byId(p, id)).toMatchObject({ run: false, reason: 'persistence=false', inputSource: 'config-gate' });
    }
    // 3.6.4 has no persistence gate — still decided by its own input probe.
    expect(byId(p, '3.6.4').reason).toBe('learnings.jsonl absent');
  });

  it('3.6.6 gates on judge-off BEFORE persistence (SKILL-documented order)', async () => {
    const root = makeRepo();
    // judge:false + persistence:false → the judge gate wins first.
    const off = await plan(root, defaultConfig({ persistence: false }));
    expect(byId(off.plan, '3.6.6').reason).toBe('disabled (skill-evolution.judge=false)');
    // judge:true + persistence:false → now the persistence gate fires.
    const on = await plan(root, defaultConfig({ persistence: false, 'skill-evolution': { judge: true } }));
    expect(byId(on.plan, '3.6.6')).toMatchObject({ run: false, reason: 'persistence=false', inputSource: 'config-gate' });
  });

  it('memory.proposals.enabled:false gates 3.6.3 at config, not input', async () => {
    const root = makeRepo();
    // Even with a queued proposal on disk, the config gate wins first.
    writeJsonl(metric(root, 'proposals.jsonl'), [
      { type: 'pattern', subject: 's', insight: 'i', evidence: 'e', confidence: 0.9, created_at: '2026-07-01T00:00:00Z' },
    ]);
    const { plan: p } = await plan(root, defaultConfig({ memory: { proposals: { enabled: false } } }));

    expect(byId(p, '3.6.3')).toMatchObject({
      run: false,
      reason: 'memory.proposals.enabled=false',
      inputSource: 'config-gate',
    });
  });

  it('memory-cleanup-threshold:0 kill-switch gates 3.6.5', async () => {
    const root = makeRepo();
    const { plan: p } = await plan(root, defaultConfig({ 'memory-cleanup-threshold': 0 }));
    expect(byId(p, '3.6.5')).toMatchObject({
      run: false,
      reason: 'kill-switch (memory-cleanup-threshold=0)',
      inputSource: 'config-gate',
    });
  });

  it('dialectic.cadence:0 kill-switch gates 3.6.7', async () => {
    const root = makeRepo();
    const { plan: p } = await plan(root, defaultConfig({ dialectic: { cadence: 0 } }));
    expect(byId(p, '3.6.7')).toMatchObject({
      run: false,
      reason: 'kill-switch (dialectic.cadence=0)',
      inputSource: 'config-gate',
    });
  });

  it('non-Claude platform gates 3.6.5 (memory dir unavailable)', async () => {
    const root = makeRepo();
    const { plan: p } = await planTailPhases({
      repoRoot: root,
      config: defaultConfig(),
      sessionId: 'sess-A',
      platform: 'codex',
      memoryDir: join(root, 'no-such-memory-dir'),
    });
    expect(byId(p, '3.6.5')).toMatchObject({
      run: false,
      reason: 'non-Claude-Code platform (memory dir unavailable)',
      inputSource: 'config-gate',
    });
  });
});

// ---------------------------------------------------------------------------
// C — run-flip fake-regressions: smuggle input → run:true kippt
// ---------------------------------------------------------------------------

describe('C — input smuggled → phase flips to run:true', () => {
  it('3.6.3 flips to run when a proposal is queued', async () => {
    const root = makeRepo();
    writeJsonl(metric(root, 'proposals.jsonl'), [
      { type: 'pattern', subject: 's', insight: 'i', evidence: 'e', confidence: 0.9, created_at: '2026-07-01T00:00:00Z' },
    ]);
    const { plan: p } = await plan(root, defaultConfig());
    expect(byId(p, '3.6.3')).toMatchObject({ run: true, inputSource: 'proposals.jsonl' });
    expect(byId(p, '3.6.3').reason).toBe('1 proposal(s) queued');
  });

  it('3.6.4 flips to run when a learning is expired past the grace window', async () => {
    const root = makeRepo();
    writeJsonl(metric(root, 'learnings.jsonl'), [
      {
        id: 'l1', created_at: '2020-01-01T00:00:00.000Z', type: 'convention', confidence: 0.8,
        subject: 'old', insight: 'old insight', evidence: 'old',
        expires_at: '2020-06-01T00:00:00.000Z', schema_version: 1,
      },
    ]);
    const { plan: p } = await plan(root, defaultConfig());
    expect(byId(p, '3.6.4')).toMatchObject({ run: true, inputSource: 'sweep-dry-run' });
    expect(byId(p, '3.6.4').reason).toContain('archive-eligible');
  });

  it('3.6.5 flips to run when sessions-since-cleanup reaches the threshold', async () => {
    const root = makeRepo();
    const sessions = Array.from({ length: 5 }, (_, i) => ({ started_at: `2026-07-0${i + 1}T00:00:00Z` }));
    writeJsonl(metric(root, 'sessions.jsonl'), sessions);
    const { plan: p } = await plan(root, defaultConfig());
    expect(byId(p, '3.6.5')).toMatchObject({ run: true, inputSource: 'auto-dream-signal' });
    expect(byId(p, '3.6.5').reason).toContain('cadence-threshold-met');
  });

  it('3.6.6 flips to run when judge enabled AND this session has selected skills', async () => {
    const root = makeRepo();
    writeJsonl(metric(root, 'skill-invocations.jsonl'), [
      { timestamp: '2026-07-01T00:00:00Z', event: 'selected', skill: 'session-orchestrator:plan', session_id: 'sess-A', schema_version: 1 },
      { timestamp: '2026-07-01T00:01:00Z', event: 'selected', skill: 'session-orchestrator:go', session_id: 'sess-A', schema_version: 1 },
    ]);
    const { plan: p } = await plan(root, defaultConfig({ 'skill-evolution': { judge: true } }));
    expect(byId(p, '3.6.6')).toMatchObject({ run: true, inputSource: 'skill-invocations.jsonl' });
    expect(byId(p, '3.6.6').reason).toBe('2 selected skill(s) to judge');
  });

  it('3.6.6 stays skipped when judge enabled but only OTHER sessions selected skills', async () => {
    const root = makeRepo();
    writeJsonl(metric(root, 'skill-invocations.jsonl'), [
      { timestamp: '2026-07-01T00:00:00Z', event: 'selected', skill: 'session-orchestrator:plan', session_id: 'other-session', schema_version: 1 },
    ]);
    const { plan: p } = await plan(root, defaultConfig({ 'skill-evolution': { judge: true } }));
    expect(byId(p, '3.6.6')).toMatchObject({
      run: false,
      reason: 'empty-input (no selected skills this session)',
      inputSource: 'skill-invocations.jsonl',
    });
  });

  it('3.6.7 flips to run when cadence met with new input', async () => {
    const root = makeRepo();
    const sessions = Array.from({ length: 5 }, (_, i) => ({ started_at: `2026-07-0${i + 1}T00:00:00Z` }));
    writeJsonl(metric(root, 'sessions.jsonl'), sessions);
    const { plan: p } = await plan(root, defaultConfig());
    expect(byId(p, '3.6.7')).toMatchObject({ run: true, inputSource: 'auto-dialectic-signal' });
    expect(byId(p, '3.6.7').reason).toContain('cadence-threshold-met');
  });

  it('3.6.8 flips to run when reconcile enabled AND an eligible high-confidence learning exists', async () => {
    const root = makeRepo();
    writeJsonl(metric(root, 'learnings.jsonl'), [
      {
        id: 'c1', created_at: '2026-07-01T00:00:00.000Z', type: 'convention', confidence: 0.9,
        subject: 'always stage files individually', insight: 'git add . sweeps parallel work',
        evidence: 'seen in 3 sessions', expires_at: '2027-01-01T00:00:00.000Z', schema_version: 1,
        scope: 'repo-local', file_paths: ['skills/x.md'],
      },
    ]);
    const { plan: p } = await plan(root, defaultConfig({ reconcile: { enabled: true, 'confidence-floor': 0.5, 'rule-expiry-days': null } }));
    expect(byId(p, '3.6.8')).toMatchObject({ run: true, inputSource: 'reconcile-dry-run' });
    expect(byId(p, '3.6.8').reason).toContain('above confidence floor');
  });

  it('3.6.8 stays skipped when the eligible learning is below the confidence floor', async () => {
    const root = makeRepo();
    writeJsonl(metric(root, 'learnings.jsonl'), [
      {
        id: 'c2', created_at: '2026-07-01T00:00:00.000Z', type: 'convention', confidence: 0.2,
        subject: 'low conf convention', insight: 'weak signal', evidence: 'once',
        expires_at: '2027-01-01T00:00:00.000Z', schema_version: 1,
        scope: 'repo-local', file_paths: ['skills/x.md'],
      },
    ]);
    const { plan: p } = await plan(root, defaultConfig({ reconcile: { enabled: true, 'confidence-floor': 0.5, 'rule-expiry-days': null } }));
    expect(byId(p, '3.6.8')).toMatchObject({ run: false, inputSource: 'reconcile-dry-run' });
    expect(byId(p, '3.6.8').reason).toContain('above confidence floor');
  });

  it('reconcile dry-run does NOT write the candidate sidecar (side-effect-free)', async () => {
    const root = makeRepo();
    writeJsonl(metric(root, 'learnings.jsonl'), [
      {
        id: 'c3', created_at: '2026-07-01T00:00:00.000Z', type: 'convention', confidence: 0.9,
        subject: 'stage files individually', insight: 'git add . sweeps parallel work',
        evidence: 'seen in 3 sessions', expires_at: '2027-01-01T00:00:00.000Z', schema_version: 1,
        scope: 'repo-local', file_paths: ['skills/x.md'],
      },
    ]);
    await plan(root, defaultConfig({ reconcile: { enabled: true, 'confidence-floor': 0.5, 'rule-expiry-days': null } }));
    // The reconcile-candidates sidecar must not exist — dryRun:true skips the merge.
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(root, '.orchestrator', 'runtime', 'reconcile-candidates.jsonl'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D — skippedReport format
// ---------------------------------------------------------------------------

describe('D — skippedReport format', () => {
  it('is a single Tail-Diät line with · separators and one segment per phase', async () => {
    const root = makeRepo();
    const { skippedReport } = await plan(root, defaultConfig());
    expect(skippedReport.startsWith('Tail-Diät: ')).toBe(true);
    expect(skippedReport.split(' · ')).toHaveLength(6);
    expect(skippedReport).toContain('3.6.3 skipped (proposals empty (queued=0))');
  });

  it('renders RUN segments for phases that flip', async () => {
    const root = makeRepo();
    writeJsonl(metric(root, 'proposals.jsonl'), [
      { type: 'pattern', subject: 's', insight: 'i', evidence: 'e', confidence: 0.9, created_at: '2026-07-01T00:00:00Z' },
    ]);
    const { skippedReport } = await plan(root, defaultConfig());
    expect(skippedReport).toContain('3.6.3 RUN (1 proposal(s) queued)');
  });

  it('buildSkippedReport is a pure exported helper over a plan array', () => {
    const report = buildSkippedReport([
      { phase: '3.6.3', run: false, reason: 'x', inputSource: 'config-gate' },
      { phase: '3.6.7', run: true, reason: 'y', inputSource: 'auto-dialectic-signal' },
    ]);
    expect(report).toBe('Tail-Diät: 3.6.3 skipped (x) · 3.6.7 RUN (y)');
  });
});

// ---------------------------------------------------------------------------
// E — never-throws / fail-open contract
// ---------------------------------------------------------------------------

describe('E — never-throws contract', () => {
  it('returns a 6-entry plan even with an empty/absent config', async () => {
    const root = makeRepo();
    const { plan: p, skippedReport } = await planTailPhases({ repoRoot: root, config: {}, platform: 'claude', memoryDir: join(root, 'nope') });
    expect(p).toHaveLength(6);
    expect(typeof skippedReport).toBe('string');
  });

  it('does not throw when called with no arguments', async () => {
    await expect(planTailPhases()).resolves.toMatchObject({ plan: expect.any(Array) });
  });
});

// ---------------------------------------------------------------------------
// F — fail-open on unreadable input (F-C, W4 fix pass)
//
// Each metrics file is planted as a DIRECTORY at the expected path, so any
// readFile()/readFileSync() against it throws EISDIR. Per-phase behaviour
// differs depending on whether the underlying reader catches the error
// internally (fail-CLOSED to an empty/zero result) or lets it propagate up
// to the phase decider's own try/catch (fail-OPEN to run:true). Both are
// legitimate, already-shipped behaviours — these tests PIN which is which so
// a future refactor of any reader cannot silently flip the posture unnoticed.
// ---------------------------------------------------------------------------

describe('F — fail-open on unreadable input', () => {
  it('3.6.4 fail-OPENS (run:true, inputSource probe-error) on unreadable learnings.jsonl', async () => {
    const root = makeRepo();
    // Plant learnings.jsonl as a DIRECTORY — existsSync() sees it as present,
    // but readLearnings()'s readFile() throws EISDIR with no internal catch,
    // propagating up through sweepExpiredLearnings() to decideExpiredSweep()'s
    // try/catch, which fail-opens per the module's documented posture (never
    // silently lose a phase on an unreadable input).
    mkdirSync(metric(root, 'learnings.jsonl'));
    const { plan: p } = await plan(root, defaultConfig());

    expect(byId(p, '3.6.4')).toMatchObject({ run: true, inputSource: 'probe-error' });
    expect(byId(p, '3.6.4').reason).toMatch(/^probe-error:/);
  });

  it('3.6.3 skips silently on unreadable proposals.jsonl — documents the fail-closed reality of collectProposals', async () => {
    const root = makeRepo();
    // Plant proposals.jsonl as a DIRECTORY. Unlike learnings.jsonl above,
    // collectProposals()'s own readProposalsJsonl() catches the EISDIR
    // internally (console.error + return []) rather than letting it
    // propagate — see collector.mjs's per-call try/catch around readFile().
    // The result: decideMemoryProposals() sees an empty queue (stats all
    // zero, including fs_error, because accumulateSummaryStats only reads
    // per-wave summary JSONs, not the proposals.jsonl read failure itself)
    // and reports the ordinary "proposals empty" skip — the aggregator never
    // learns the file was unreadable at all. Pinned here per W4-QA finding F1
    // so a future collector.mjs change that removes the internal catch (and
    // starts throwing) is caught as a BEHAVIOUR CHANGE, not silently absorbed.
    mkdirSync(metric(root, 'proposals.jsonl'));
    const { plan: p } = await plan(root, defaultConfig());

    expect(byId(p, '3.6.3')).toMatchObject({ run: false, inputSource: 'proposals.jsonl' });
    expect(byId(p, '3.6.3').reason).toBe('proposals empty (queued=0)');
  });

  it('3.6.8 also skips silently on unreadable learnings.jsonl — runReconcile fail-closes to a zero-learnings corpus', async () => {
    const root = makeRepo();
    // defaultLoadLearnings() inside runReconcile() catches readFileSync's
    // EISDIR internally and returns [] (empty corpus, no `error` field set),
    // so the empty short-circuit fires and decideReconcile() sees a plain
    // "0 proposals above confidence floor" — same fail-closed shape as 3.6.3,
    // for a different underlying reason (empty corpus vs. empty queue).
    mkdirSync(metric(root, 'learnings.jsonl'));
    const { plan: p } = await plan(root, defaultConfig({ reconcile: { enabled: true, 'confidence-floor': 0.5, 'rule-expiry-days': null } }));

    expect(byId(p, '3.6.8')).toMatchObject({ run: false, inputSource: 'reconcile-dry-run' });
    expect(byId(p, '3.6.8').reason).toBe('0 proposals above confidence floor (eligible=0, floor=0.5)');
  });
});
