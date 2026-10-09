/**
 * tests/scripts/lib/memory-proposals/store.test.mjs
 *
 * Unit tests + parallel-race test for scripts/lib/memory-proposals/store.mjs
 * (Issue #501).
 *
 * Covers:
 *   Section A — Happy path + branches (appendProposal)
 *   Section B — Boundary (summary file, countProposalsForWave, readWaveSummary)
 *   Section C — Parallel race (8 concurrent child_processes, quota=5)
 *
 * Test-quality discipline (.claude/rules/test-quality.md):
 *   - Hardcoded literal expectations — no computed expected values
 *   - One AAA per test, cyclomatic complexity = 1 (no if/loop/ternary inside it())
 *   - Falsification-checked: each test fails if the targeted code path is removed
 *   - Fixture isolation: each test (except race) owns a private mkdtempSync dir
 *     cleaned up in afterEach
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import fs, { writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rmSync } from 'node:fs';

import { appendProposal, countProposalsForWave, readWaveSummary } from '@lib/memory-proposals/store.mjs';
import { createProposalRecord, validateProposalRecord } from '@lib/memory-proposals/schema.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

/**
 * Create an isolated tmpdir with .orchestrator/metrics/ pre-created.
 * @returns {string} absolute path to repoRoot
 */
function makeTmpRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'proposals-store-'));
  mkdirSync(join(repoRoot, '.orchestrator/metrics'), { recursive: true });
  return repoRoot;
}

/**
 * Build a valid ProposalRecord with sensible defaults; caller can override
 * individual fields. Defaults to waveId='W1', confidence=0.7.
 */
function makeRecord(overrides = {}) {
  return createProposalRecord({
    type: 'workflow-pattern',
    subject: 'test-subject',
    insight: 'test insight for store tests',
    evidence: 'test evidence for store tests',
    confidence: 0.7,
    waveId: 'W1',
    ...overrides,
  });
}

// Track tmp dirs created per test so afterEach can clean them up.
const tmpDirsToCleanup = [];

afterEach(() => {
  // Restore any spies installed in this test (e.g., process.stderr.write).
  // No-op for tests that didn't spy.
  vi.restoreAllMocks();
  for (const dir of tmpDirsToCleanup) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  tmpDirsToCleanup.length = 0;
});

/**
 * Create and register a tmpdir for cleanup after the current test.
 */
function tmpRepo() {
  const r = makeTmpRepo();
  tmpDirsToCleanup.push(r);
  return r;
}

// ---------------------------------------------------------------------------
// Section A — Happy path + branches
// ---------------------------------------------------------------------------

describe('appendProposal — happy path + branches', () => {

  it('A1: first call returns {status:"queued", position:"1/5"}', async () => {
    const repoRoot = tmpRepo();
    const record = makeRecord();

    const result = await appendProposal({ record, repoRoot, waveId: 'W1' });

    expect(result).toEqual({ status: 'queued', position: '1/5' });
  });

  it('A1b: first call writes exactly 1 line to proposals.jsonl', async () => {
    const repoRoot = tmpRepo();
    const record = makeRecord();
    await appendProposal({ record, repoRoot, waveId: 'W1' });

    const raw = readFileSync(join(repoRoot, '.orchestrator/metrics/proposals.jsonl'), 'utf8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    expect(lines).toHaveLength(1);
  });

  it('A2: five sequential calls return positions 1/5 through 5/5', async () => {
    const repoRoot = tmpRepo();

    const r1 = await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1' });
    const r2 = await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1' });
    const r3 = await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1' });
    const r4 = await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1' });
    const r5 = await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1' });

    expect(r1).toEqual({ status: 'queued', position: '1/5' });
    expect(r2).toEqual({ status: 'queued', position: '2/5' });
    expect(r3).toEqual({ status: 'queued', position: '3/5' });
    expect(r4).toEqual({ status: 'queued', position: '4/5' });
    expect(r5).toEqual({ status: 'queued', position: '5/5' });
  });

  it('A3: 6th call returns {status:"quota-exceeded", quota:5, dropped:1}', async () => {
    const repoRoot = tmpRepo();
    for (let i = 0; i < 5; i++) {
      await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1' });
    }

    const result = await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1' });

    expect(result).toEqual({ status: 'quota-exceeded', quota: 5, dropped: 1 });
  });

  it('A3b: proposals.jsonl still has exactly 5 lines after 6 sequential calls', async () => {
    const repoRoot = tmpRepo();
    for (let i = 0; i < 6; i++) {
      await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1' });
    }

    const raw = readFileSync(join(repoRoot, '.orchestrator/metrics/proposals.jsonl'), 'utf8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    expect(lines).toHaveLength(5);
  });

  it('A4: confidence below 0.5 floor returns {status:"below-floor"}', async () => {
    const repoRoot = tmpRepo();
    const lowConfRecord = makeRecord({ confidence: 0.4, waveId: 'W1' });

    const result = await appendProposal({ record: lowConfRecord, repoRoot, waveId: 'W1' });

    expect(result).toEqual({ status: 'below-floor' });
  });

  it('A4b: below-floor call leaves proposals.jsonl absent (no I/O performed)', async () => {
    const repoRoot = tmpRepo();
    const lowConfRecord = makeRecord({ confidence: 0.4, waveId: 'W1' });
    await appendProposal({ record: lowConfRecord, repoRoot, waveId: 'W1' });

    let fileExists = true;
    try {
      readFileSync(join(repoRoot, '.orchestrator/metrics/proposals.jsonl'), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') fileExists = false;
    }
    expect(fileExists).toBe(false);
  });

  it('A5: W1 and W2 maintain independent quota counters (each can queue 5)', async () => {
    const repoRoot = tmpRepo();
    // Fill W1 to quota
    for (let i = 0; i < 5; i++) {
      await appendProposal({ record: makeRecord({ waveId: 'W1' }), repoRoot, waveId: 'W1' });
    }
    // W2 should still accept appends independently
    const w2r1 = await appendProposal({ record: makeRecord({ waveId: 'W2' }), repoRoot, waveId: 'W2' });
    const w2r5 = await appendProposal({ record: makeRecord({ waveId: 'W2' }), repoRoot, waveId: 'W2' });

    // W1 is exhausted
    const w1r6 = await appendProposal({ record: makeRecord({ waveId: 'W1' }), repoRoot, waveId: 'W1' });

    expect(w2r1.status).toBe('queued');
    expect(w2r5.status).toBe('queued');
    expect(w1r6.status).toBe('quota-exceeded');
  });

  it('A5b: W1 quota-exceeded does not prevent W2 from reaching 5/5', async () => {
    const repoRoot = tmpRepo();
    // Exhaust W1
    for (let i = 0; i < 5; i++) {
      await appendProposal({ record: makeRecord({ waveId: 'W1' }), repoRoot, waveId: 'W1' });
    }
    // Fill W2 to full quota
    for (let i = 0; i < 4; i++) {
      await appendProposal({ record: makeRecord({ waveId: 'W2' }), repoRoot, waveId: 'W2' });
    }
    const w2Last = await appendProposal({ record: makeRecord({ waveId: 'W2' }), repoRoot, waveId: 'W2' });

    expect(w2Last).toEqual({ status: 'queued', position: '5/5' });
  });

});

// ---------------------------------------------------------------------------
// Section B — Boundary
// ---------------------------------------------------------------------------

describe('appendProposal + readWaveSummary — boundary', () => {

  it('B6: summary file written after first append with correct initial counts', async () => {
    const repoRoot = tmpRepo();
    await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1' });

    const summary = await readWaveSummary({ repoRoot, waveId: 'W1' });

    expect(summary).toEqual({
      queued: 1,
      dropped: 0,
      below_floor: 0,
      fs_error: 0,
    });
  });

  it('B7: after 1 queued + 1 below-floor + 1 quota-exceeded the summary is exact', async () => {
    const repoRoot = tmpRepo();
    // Fill to quota=1 by using quotaPerWave=1
    await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1', quotaPerWave: 1 });
    // Below-floor (confidence=0.3 < 0.5)
    await appendProposal({ record: makeRecord({ confidence: 0.3 }), repoRoot, waveId: 'W1', quotaPerWave: 1 });
    // Quota-exceeded (quota=1 already filled)
    await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1', quotaPerWave: 1 });

    const summary = await readWaveSummary({ repoRoot, waveId: 'W1' });

    expect(summary).toEqual({
      queued: 1,
      dropped: 1,
      below_floor: 1,
      fs_error: 0,
    });
  });

  it('B7b: dropped field in quota-exceeded return reflects cumulative count (2nd drop → dropped:2)', async () => {
    const repoRoot = tmpRepo();
    for (let i = 0; i < 5; i++) {
      await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1' });
    }
    const r6 = await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1' });
    const r7 = await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1' });

    expect(r6.dropped).toBe(1);
    expect(r7.dropped).toBe(2);
  });

  it('B8a: countProposalsForWave returns 0 for a fresh tmpdir (no file)', async () => {
    const repoRoot = tmpRepo();

    const count = await countProposalsForWave({ repoRoot, waveId: 'W1' });

    expect(count).toBe(0);
  });

  it('B8b: countProposalsForWave returns 3 after 3 queued appends for the same wave', async () => {
    const repoRoot = tmpRepo();
    for (let i = 0; i < 3; i++) {
      await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1' });
    }

    const count = await countProposalsForWave({ repoRoot, waveId: 'W1' });

    expect(count).toBe(3);
  });

  it('B8c: countProposalsForWave counts only lines for the specified waveId', async () => {
    const repoRoot = tmpRepo();
    // 3 appended to W1, 2 appended to W2
    for (let i = 0; i < 3; i++) {
      await appendProposal({ record: makeRecord({ waveId: 'W1' }), repoRoot, waveId: 'W1' });
    }
    for (let i = 0; i < 2; i++) {
      await appendProposal({ record: makeRecord({ waveId: 'W2' }), repoRoot, waveId: 'W2' });
    }

    const w1count = await countProposalsForWave({ repoRoot, waveId: 'W1' });
    const w2count = await countProposalsForWave({ repoRoot, waveId: 'W2' });

    expect(w1count).toBe(3);
    expect(w2count).toBe(2);
  });

  it('B8d (#1216): countProposalsForWave warns on a non-ENOENT read failure (EISDIR) and returns 0', async () => {
    const repoRoot = tmpRepo();
    // A DIRECTORY at proposals.jsonl: readFileSync throws EISDIR, which
    // countWaveLines rethrows — previously swallowed without a trace.
    mkdirSync(join(repoRoot, '.orchestrator/metrics/proposals.jsonl'));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const count = await countProposalsForWave({ repoRoot, waveId: 'W1' });

    expect(count).toBe(0);
    const warned = stderrSpy.mock.calls.some(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('[memory-proposals] WARN: countProposalsForWave') &&
        call[0].includes('EISDIR'),
    );
    expect(warned).toBe(true);
  });

  it('B9: readWaveSummary returns null when no summary file exists', async () => {
    const repoRoot = tmpRepo();

    const summary = await readWaveSummary({ repoRoot, waveId: 'W1' });

    expect(summary).toBeNull();
  });

  it('B9b (#1210): does NOT warn when the summary file is simply absent (ENOENT)', async () => {
    const repoRoot = tmpRepo();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const summary = await readWaveSummary({ repoRoot, waveId: 'W1' });

    expect(summary).toBeNull();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('B9c (#1210): warns on a non-ENOENT read failure (EISDIR) and still returns null', async () => {
    const repoRoot = tmpRepo();
    // A DIRECTORY at the summary path: the real fs.readFileSync throws
    // EISDIR, not ENOENT — no DI mock needed to force the "other" branch.
    const summaryPath = join(repoRoot, '.orchestrator/metrics/proposals-summary-W1.json');
    mkdirSync(summaryPath);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const summary = await readWaveSummary({ repoRoot, waveId: 'W1' });

    expect(summary).toBeNull();
    const warned = stderrSpy.mock.calls.some(
      (call) =>
        typeof call[0] === 'string' && call[0].includes(summaryPath) && call[0].includes('EISDIR'),
    );
    expect(warned).toBe(true);
  });

  it('B10: each appended line is valid JSON with correct wave_id field', async () => {
    const repoRoot = tmpRepo();
    await appendProposal({ record: makeRecord({ waveId: 'W1' }), repoRoot, waveId: 'W1' });
    await appendProposal({ record: makeRecord({ waveId: 'W1' }), repoRoot, waveId: 'W1' });

    const raw = readFileSync(join(repoRoot, '.orchestrator/metrics/proposals.jsonl'), 'utf8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);

    const parsed0 = JSON.parse(lines[0]);
    const parsed1 = JSON.parse(lines[1]);
    expect(parsed0.wave_id).toBe('W1');
    expect(parsed1.wave_id).toBe('W1');
  });

  it('B11: confidence exactly at floor (0.5) is accepted, not rejected', async () => {
    const repoRoot = tmpRepo();
    const atFloor = makeRecord({ confidence: 0.5 });

    const result = await appendProposal({ record: atFloor, repoRoot, waveId: 'W1' });

    expect(result.status).toBe('queued');
  });

  it('B12: confidence just below floor (0.499) is rejected', async () => {
    const repoRoot = tmpRepo();
    const justBelow = makeRecord({ confidence: 0.499 });

    const result = await appendProposal({ record: justBelow, repoRoot, waveId: 'W1' });

    expect(result.status).toBe('below-floor');
  });

  it('B13: custom quotaPerWave=3 is respected — 4th call is quota-exceeded', async () => {
    const repoRoot = tmpRepo();
    for (let i = 0; i < 3; i++) {
      await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1', quotaPerWave: 3 });
    }

    const result = await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1', quotaPerWave: 3 });

    expect(result).toEqual({ status: 'quota-exceeded', quota: 3, dropped: 1 });
  });

  it('B14: custom quotaPerWave=3 — position string uses the custom quota', async () => {
    const repoRoot = tmpRepo();

    const r1 = await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1', quotaPerWave: 3 });
    const r2 = await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1', quotaPerWave: 3 });
    const r3 = await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1', quotaPerWave: 3 });

    expect(r1.position).toBe('1/3');
    expect(r2.position).toBe('2/3');
    expect(r3.position).toBe('3/3');
  });

});

// ---------------------------------------------------------------------------
// Section C — Parallel race (THE critical test)
// ---------------------------------------------------------------------------
//
// FALSIFICATION: removing the lock (tryCreateLock / acquireProposalsLock) from
// store.mjs would cause concurrent appenders to race past the quota check and
// write 8 lines instead of 5. This test would fail on the toHaveLength(5)
// assertion.

describe('appendProposal — parallel race', () => {

  /**
   * Spawn `workers` child processes that each call appendProposal once with
   * `quotaPerWave`, and resolve with their parsed results.
   */
  async function raceWorkers(repoRoot, workers, quotaPerWave) {
    // The worker reads its index from process.argv[2] to produce a unique subject.
    const workerScript = `
import { appendProposal } from ${JSON.stringify(join(PROJECT_ROOT, 'scripts/lib/memory-proposals/store.mjs'))};
import { createProposalRecord } from ${JSON.stringify(join(PROJECT_ROOT, 'scripts/lib/memory-proposals/schema.mjs'))};

const record = createProposalRecord({
  type: 'workflow-pattern',
  subject: 'race-worker-' + process.argv[2],
  insight: 'parallel race test insight',
  evidence: 'parallel race test evidence content',
  confidence: 0.7,
  waveId: 'W1',
});

const result = await appendProposal({
  record,
  repoRoot: ${JSON.stringify(repoRoot)},
  waveId: 'W1',
  quotaPerWave: ${quotaPerWave},
  lockTimeoutMs: 20000,
});

process.stdout.write(JSON.stringify(result));
process.exit(0);
`;
    const workerPath = join(repoRoot, 'worker.mjs');
    writeFileSync(workerPath, workerScript, 'utf8');

    return Promise.all(
      Array.from({ length: workers }, (_, i) =>
        new Promise((resolve, reject) => {
          let stdout = '';
          let stderr = '';
          const child = spawn(process.execPath, [workerPath, String(i)]);
          child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
          child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
          child.on('close', (code) => {
            if (code !== 0) {
              reject(new Error(`Worker ${i} exited with code ${code}. stderr: ${stderr}`));
              return;
            }
            try {
              resolve(JSON.parse(stdout.trim()));
            } catch {
              reject(new Error(`Worker ${i} produced unparseable output: ${JSON.stringify(stdout)}. stderr: ${stderr}`));
            }
          });
          child.on('error', reject);
        })
      )
    );
  }

  /** Parse a JSONL file, failing loudly on any non-JSON line. */
  function readJsonl(file) {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
  }

  it('C9: 8 parallel child_processes with quota=5 yields exactly 5 queued + 3 quota-exceeded', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'proposals-race-'));
    tmpDirsToCleanup.push(repoRoot);
    mkdirSync(join(repoRoot, '.orchestrator/metrics'), { recursive: true });

    const results = await raceWorkers(repoRoot, 8, 5);

    const queued = results.filter((r) => r.status === 'queued');
    const dropped = results.filter((r) => r.status === 'quota-exceeded');

    // FALSIFICATION: without the lock, races would allow >5 queued and <3 dropped.
    expect(queued).toHaveLength(5);
    expect(dropped).toHaveLength(3);

    // proposals.jsonl must have exactly 5 non-empty lines
    const metrics = join(repoRoot, '.orchestrator/metrics');
    const lines = readJsonl(join(metrics, 'proposals.jsonl'));
    expect(lines).toHaveLength(5);

    // All 5 lines must be valid JSON with wave_id='W1'
    for (const parsed of lines) {
      expect(parsed.wave_id).toBe('W1');
    }

    // No leftover lock file or tmp file in the metrics dir
    const metricsDir = readdirSync(metrics);
    const lockFiles = metricsDir.filter((f) => f.includes('proposals-write.lock'));
    expect(lockFiles).toHaveLength(0);

    // Positions reported by queued workers must form exactly the set 1/5..5/5
    const positions = queued.map((r) => r.position).sort();
    expect(positions).toEqual(['1/5', '2/5', '3/5', '4/5', '5/5']);

    // The 3 rejected proposals are all preserved in the overflow file (#1027 1b)
    const overflow = readJsonl(join(metrics, 'proposals-overflow.jsonl'));
    expect(overflow).toHaveLength(3);
  }, 30_000); // 30s timeout for parallel child_process spawn

  // FALSIFICATION: an overflow that lost lines under 12 writers, wrote a torn
  // line, or counted against the quota (shrinking the queue below 2) turns this
  // red. It does NOT pin that the append happens under the lock: small O_APPEND
  // lines do not tear, so a deferred append would still pass.
  it('C10 (#1027 1b): 12 parallel writers with quota=2 keep 2 queued + all 10 rejected, none lost or torn', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'proposals-race-'));
    tmpDirsToCleanup.push(repoRoot);
    mkdirSync(join(repoRoot, '.orchestrator/metrics'), { recursive: true });

    const results = await raceWorkers(repoRoot, 12, 2);

    expect(results.filter((r) => r.status === 'queued')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'quota-exceeded')).toHaveLength(10);
    const metrics = join(repoRoot, '.orchestrator/metrics');
    const queue = readJsonl(join(metrics, 'proposals.jsonl'));
    const overflow = readJsonl(join(metrics, 'proposals-overflow.jsonl'));
    expect(queue).toHaveLength(2);
    expect(overflow).toHaveLength(10);
    const subjects = [...queue, ...overflow].map((r) => r.subject).sort();
    expect(subjects).toEqual(Array.from({ length: 12 }, (_, i) => `race-worker-${i}`).sort());
    expect(readdirSync(metrics).filter((f) => f.includes('proposals-write.lock'))).toHaveLength(0);
  }, 60_000);

  it('C11 (#1545): 12 writers across rotation preserve the seed and every rejected record', async () => {
    const repoRoot = tmpRepo();
    const metrics = join(repoRoot, '.orchestrator/metrics');
    const seed = JSON.stringify(makeRecord({ subject: 'seed' })) + '\n';
    writeFileSync(join(metrics, 'proposals-overflow.jsonl'), seed + '\n'.repeat(1024 * 1024 - Buffer.byteLength(seed) - 100));

    const results = await raceWorkers(repoRoot, 12, 0);

    expect(results.filter((r) => r.status === 'quota-exceeded')).toHaveLength(12);
    const archives = readdirSync(metrics).filter((f) => f.includes('.archive-'));
    expect(archives).toHaveLength(1);
    const records = [...readJsonl(join(metrics, archives[0])), ...readJsonl(join(metrics, 'proposals-overflow.jsonl'))];
    expect(records.map((r) => r.subject).sort()).toEqual(['seed', ...Array.from({ length: 12 }, (_, i) => `race-worker-${i}`)].sort());
    expect(existsSync(join(metrics, 'proposals-write.lock'))).toBe(false);
  }, 60_000);

});

// ---------------------------------------------------------------------------
// Section D — Stale-lock override branches (G3) + lock-timeout exhaustion (G4)
// ---------------------------------------------------------------------------
//
// G3 — 3-branch stale-PID override in acquireProposalsLock (store.mjs lines ~243-326):
//   (a) live PID  → poll-retry (no override)   ← already exercised by C9 race
//   (b) dead PID same host → override + WARN  ← D1
//   (c) unparseable body   → override + WARN  ← D2
//   (d) cross-host stale-PID NOT auto-overridden (poll until timeout) ← D3
//
// G4 — lock-timeout exhausted by long-lived holder (store.mjs lines ~261-263, ~321-323):
//   appendProposal returns { status: 'fs-error', error: 'lock-timeout' } ← D4
//
// PID literal: 999999 — a hardcoded value that is overwhelmingly unlikely to be
// alive on any test host (Linux pid_max default = 32768 or 4194304, macOS = 99998).
//
// FALSIFICATION (one per test, no in-test computation):
//   D1: if dead-PID branch was changed to silent override (no stderr WARN), the
//       toContain('stale lock detected') assertion would not fire.
//   D2: if unparseable-body branch was changed to return without override, the
//       proposal would never be queued and the position assertion would fail.
//   D3: if cross-host bodies were treated as stale (auto-overridden), the call
//       would return { status: 'queued', ... } instead of the timeout shape, and
//       the toEqual on the error envelope would fail.
//   D4: if the deadline check at line ~321 were removed, the spin-poll would
//       loop forever — vitest would hit its testTimeout instead of returning
//       'lock-timeout', and the toEqual({error:'lock-timeout'}) assertion would
//       fail (or the test would time out, which is also a failure).
// ---------------------------------------------------------------------------

const DEAD_PID = 999999;

describe('appendProposal — stale-lock override (G3) + lock-timeout (G4)', () => {

  it('D1 (G3-b): dead PID same host triggers atomic override + stderr WARN, append succeeds', async () => {
    const repoRoot = tmpRepo();
    const lockPath = join(repoRoot, '.orchestrator/metrics/proposals-write.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: DEAD_PID,
        host: hostname(),
        acquiredAt: '2026-01-01T00:00:00.000Z',
      }),
      'utf8',
    );

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = await appendProposal({
      record: makeRecord(),
      repoRoot,
      waveId: 'W1',
    });

    // Override succeeded → the proposal was queued at position 1/5.
    expect(result).toEqual({ status: 'queued', position: '1/5' });

    // The stale-lock WARN must mention the dead PID and the override action.
    const allOutput = stderrSpy.mock.calls.map((args) => String(args[0])).join('');
    expect(allOutput).toContain('stale lock detected (pid=999999');
    expect(allOutput).toContain('reclaiming');

    // The JSONL file must contain exactly 1 line (the appended proposal).
    const raw = readFileSync(join(repoRoot, '.orchestrator/metrics/proposals.jsonl'), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
  });

  it('D2 (G3-c): unparseable lock body triggers atomic override + stderr WARN, append succeeds', async () => {
    const repoRoot = tmpRepo();
    const lockPath = join(repoRoot, '.orchestrator/metrics/proposals-write.lock');
    // Garbage bytes — neither JSON nor a plausible lock body.
    writeFileSync(lockPath, 'garbage text not yaml not json {{{', 'utf8');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = await appendProposal({
      record: makeRecord(),
      repoRoot,
      waveId: 'W1',
    });

    // Override succeeded → the proposal was queued at position 1/5.
    expect(result).toEqual({ status: 'queued', position: '1/5' });

    // The unparseable-body WARN must mention the unparseable body and reclaim action.
    const allOutput = stderrSpy.mock.calls.map((args) => String(args[0])).join('');
    expect(allOutput).toContain('unparseable body');
    expect(allOutput).toContain('reclaiming');

    // The JSONL file must contain exactly 1 line.
    const raw = readFileSync(join(repoRoot, '.orchestrator/metrics/proposals.jsonl'), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
  });

  it('D3 (G3-d): cross-host stale-PID body is NOT auto-overridden — polls until timeout', async () => {
    const repoRoot = tmpRepo();
    const lockPath = join(repoRoot, '.orchestrator/metrics/proposals-write.lock');
    // Foreign host AND a would-be-dead PID. Per cross-host policy, PID liveness
    // cannot be verified across hosts, so the lock must NOT be auto-overridden.
    const foreignBody = JSON.stringify({
      pid: DEAD_PID,
      host: 'definitely-not-this-host-12345',
      acquiredAt: '2026-01-01T00:00:00.000Z',
    });
    writeFileSync(lockPath, foreignBody, 'utf8');

    const result = await appendProposal({
      record: makeRecord(),
      repoRoot,
      waveId: 'W1',
      lockTimeoutMs: 100,
    });

    // No override → lock-timeout, surfaced as fs-error envelope.
    expect(result).toEqual({ status: 'fs-error', error: 'lock-timeout' });

    // The lock file on disk must still contain the foreign-host body, byte-for-byte.
    const onDisk = readFileSync(lockPath, 'utf8');
    expect(onDisk).toBe(foreignBody);

    // No proposal must have been appended (file should not exist).
    const jsonlPath = join(repoRoot, '.orchestrator/metrics/proposals.jsonl');
    expect(existsSync(jsonlPath)).toBe(false);
  });

  it('D4 (G4): live-PID same-host holder exhausts lockTimeoutMs=100 with exact fs-error shape', async () => {
    const repoRoot = tmpRepo();
    const lockPath = join(repoRoot, '.orchestrator/metrics/proposals-write.lock');
    // process.pid is GUARANTEED to be alive throughout the test — same-host live-PID
    // means the override branch is never taken; spin-poll continues until deadline.
    const holderBody = JSON.stringify({
      pid: process.pid,
      host: hostname(),
      acquiredAt: '2026-01-01T00:00:00.000Z',
    });
    writeFileSync(lockPath, holderBody, 'utf8');

    const result = await appendProposal({
      record: makeRecord(),
      repoRoot,
      waveId: 'W1',
      lockTimeoutMs: 100,
    });

    // Exact fs-error envelope shape — no toBeTruthy, no partial match.
    expect(result).toEqual({ status: 'fs-error', error: 'lock-timeout' });

    // The holder's lock body must still be on disk unchanged (no override attempted).
    const onDisk = readFileSync(lockPath, 'utf8');
    expect(onDisk).toBe(holderBody);
  });

});

// ---------------------------------------------------------------------------
// Section E — Quota overflow (#1027 1b)
// ---------------------------------------------------------------------------
//
// The quota caps the QUEUE; a validated proposal beyond it used to exist only
// in the agent's transcript. It now lands in proposals-overflow.jsonl while the
// queue, the quota and the quota-exceeded return stay exactly as they were.

describe('appendProposal — quota overflow (#1027 1b)', () => {
  const metricsOf = (repoRoot) => join(repoRoot, '.orchestrator/metrics');
  const jsonl = (file) =>
    readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));

  // FALSIFICATION: drop the overflow append in the quota branch -> the file is
  // absent and the full-content assertion fails.
  it('E1: the quota-rejected proposal is kept with its full validated content, the queue stays at 5', async () => {
    const repoRoot = tmpRepo();
    for (let i = 0; i < 5; i++) {
      await appendProposal({ record: makeRecord({ subject: `queued-${i}` }), repoRoot, waveId: 'W1' });
    }
    const rejected = makeRecord({ subject: 'rejected-6', insight: 'insight that must survive the quota' });

    const result = await appendProposal({ record: rejected, repoRoot, waveId: 'W1' });

    expect(result).toEqual({ status: 'quota-exceeded', quota: 5, dropped: 1 });
    expect(jsonl(join(metricsOf(repoRoot), 'proposals-overflow.jsonl'))).toEqual([rejected]);
    expect(jsonl(join(metricsOf(repoRoot), 'proposals.jsonl'))).toHaveLength(5);
    expect(await countProposalsForWave({ repoRoot, waveId: 'W1' })).toBe(5);
  });

  it('E2: every rejected proposal is kept in order and the summary keeps the dropped contract', async () => {
    const repoRoot = tmpRepo();
    for (let i = 0; i < 8; i++) {
      await appendProposal({ record: makeRecord({ subject: `p-${i}` }), repoRoot, waveId: 'W1' });
    }

    const overflow = jsonl(join(metricsOf(repoRoot), 'proposals-overflow.jsonl'));

    expect(overflow.map((r) => r.subject)).toEqual(['p-5', 'p-6', 'p-7']);
    expect(await readWaveSummary({ repoRoot, waveId: 'W1' })).toEqual({
      queued: 5, dropped: 3, below_floor: 0, fs_error: 0,
    });
  });

  // FALSIFICATION: swallow the write error and fall through to quota-exceeded
  // -> status is quota-exceeded and fs_error stays 0.
  it('E3: a failing overflow write returns fs-error (not quota-exceeded), counts fs_error not dropped, frees the lock', async () => {
    const repoRoot = tmpRepo();
    for (let i = 0; i < 5; i++) {
      await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1' });
    }
    mkdirSync(join(metricsOf(repoRoot), 'proposals-overflow.jsonl')); // append -> EISDIR

    const result = await appendProposal({ record: makeRecord({ subject: 'lost' }), repoRoot, waveId: 'W1' });

    expect(result.status).toBe('fs-error');
    expect(result.error).toMatch(/EISDIR/);
    expect(await readWaveSummary({ repoRoot, waveId: 'W1' })).toEqual({
      queued: 5, dropped: 0, below_floor: 0, fs_error: 1,
    });
    expect(existsSync(join(metricsOf(repoRoot), 'proposals-write.lock'))).toBe(false);
    expect(jsonl(join(metricsOf(repoRoot), 'proposals.jsonl'))).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Section F — Store path guard: ancestors and dangling links (#1027 1b)
// ---------------------------------------------------------------------------
//
// The shared validator swallows ENOENT on the target and returns the lexical
// path unchecked, so a link above (or at) a not-yet-existing store file let the
// first write land outside the repo. All fixtures live under fresh tmp dirs.

describe('appendProposal — store path guard (#1027 1b)', () => {
  function outsideDir() {
    const d = mkdtempSync(join(tmpdir(), 'proposals-outside-'));
    tmpDirsToCleanup.push(d);
    return d;
  }

  // FALSIFICATION: remove the ancestor check in safePath -> result is queued
  // and proposals.jsonl + the summary appear in `outside`.
  it('F1: a metrics dir that is a symlink to outside the repo is rejected, nothing is written outside', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'proposals-store-'));
    tmpDirsToCleanup.push(repoRoot);
    mkdirSync(join(repoRoot, '.orchestrator'));
    const outside = outsideDir();
    symlinkSync(outside, join(repoRoot, '.orchestrator/metrics'));

    await expect(appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1' }))
      .rejects.toThrow(/reason: symlink\)/);

    expect(readdirSync(outside)).toEqual([]);
  });

  it('F2: a dangling symlink AT proposals.jsonl pointing outside is rejected, the target is not created', async () => {
    const repoRoot = tmpRepo();
    const outside = outsideDir();
    symlinkSync(join(outside, 'stolen.jsonl'), join(repoRoot, '.orchestrator/metrics/proposals.jsonl'));

    await expect(appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1' }))
      .rejects.toThrow(/reason: symlink\)/);

    expect(readdirSync(outside)).toEqual([]);
  });

  it('F3: a dangling symlink at the overflow target is rejected, the lock is released and the queue is untouched', async () => {
    const repoRoot = tmpRepo();
    for (let i = 0; i < 5; i++) {
      await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1' });
    }
    const outside = outsideDir();
    symlinkSync(join(outside, 'stolen.jsonl'), join(repoRoot, '.orchestrator/metrics/proposals-overflow.jsonl'));

    await expect(appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1' }))
      .rejects.toThrow(/reason: symlink\)/);

    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(repoRoot, '.orchestrator/metrics/proposals-write.lock'))).toBe(false);
    expect(await countProposalsForWave({ repoRoot, waveId: 'W1' })).toBe(5);
    expect((await readWaveSummary({ repoRoot, waveId: 'W1' })).fs_error).toBe(1);
  });

  // Guards against a false positive: a repoRoot reached THROUGH a symlink is
  // legitimate (macOS /var -> /private/var, symlinked checkouts).
  it('F4: a repoRoot given via a symlink to the real checkout still works', async () => {
    const real = tmpRepo();
    const holder = outsideDir();
    const viaLink = join(holder, 'link-to-repo');
    symlinkSync(real, viaLink);

    const result = await appendProposal({ record: makeRecord(), repoRoot: viaLink, waveId: 'W1' });

    expect(result).toEqual({ status: 'queued', position: '1/5' });
    expect(existsSync(join(real, '.orchestrator/metrics/proposals.jsonl'))).toBe(true);
  });

  // FALSIFICATION: flip the "climbed above the root" branch to false -> a repo
  // whose root does not exist yet is rejected instead of created.
  it('F5: a repoRoot that does not exist yet is created as a plain tree', async () => {
    const parent = outsideDir();
    const repoRoot = join(parent, 'not', 'yet');

    const result = await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1' });

    expect(result).toEqual({ status: 'queued', position: '1/5' });
    expect(existsSync(join(repoRoot, '.orchestrator/metrics/proposals.jsonl'))).toBe(true);
  });

  // The lock file is created and unlinked by concurrent writers. If it is seen
  // by lstat and gone by realpath it was never a link — the proposal must not
  // be rejected as a symlink escape.
  it('F6: a lock file that vanishes between lstat and realpath is not mistaken for a dangling link', async () => {
    const repoRoot = tmpRepo();
    const lock = join(repoRoot, '.orchestrator/metrics/proposals-write.lock');
    const realLstat = fs.lstatSync;
    const realRealpath = fs.realpathSync;
    let appeared = false;
    let vanished = false;
    vi.spyOn(fs, 'lstatSync').mockImplementation((p, ...rest) => {
      if (!appeared && String(p).endsWith('proposals-write.lock')) {
        appeared = true;
        writeFileSync(lock, 'x'); // a peer just created it
      }
      return realLstat(p, ...rest);
    });
    vi.spyOn(fs, 'realpathSync').mockImplementation((p, ...rest) => {
      if (appeared && !vanished && String(p).endsWith('proposals-write.lock')) {
        vanished = true;
        rmSync(lock); // ...and released it again
      }
      return realRealpath(p, ...rest);
    });

    const result = await appendProposal({ record: makeRecord(), repoRoot, waveId: 'W1' });

    expect(result).toEqual({ status: 'queued', position: '1/5' });
  });
});

// Rotation only changes overflow persistence, never quota/queue/summary policy.
describe('appendProposal — lossless overflow rotation (#1545)', () => {
  const cap = 1024 * 1024;
  const activeOf = (root) => join(root, '.orchestrator/metrics/proposals-overflow.jsonl');
  const filesOf = (root, suffix) => readdirSync(join(root, '.orchestrator/metrics'))
    .filter((name) => name.includes('.archive-') && name.endsWith(suffix))
    .map((name) => join(root, '.orchestrator/metrics', name));
  const archivesOf = (root) => filesOf(root, '.jsonl');
  const partialsOf = (root) => filesOf(root, '.partial');
  const appendRejected = (root, record) => appendProposal({ record, repoRoot: root, waveId: 'W1', quotaPerWave: 0 });

  it('G1: exactly 1 MiB remains active; the next UTF8 record rotates byte-exact old content', async () => {
    const root = tmpRepo();
    const record = makeRecord({ subject: 'unicode', insight: 'é'.repeat(500) });
    const line = JSON.stringify(record) + '\n';
    const seed = Buffer.from('\n'.repeat(cap - Buffer.byteLength(line)));
    writeFileSync(activeOf(root), seed);

    const atBoundary = await appendRejected(root, record);
    const afterBoundary = await appendRejected(root, record);

    expect(atBoundary.status).toBe('quota-exceeded');
    expect(afterBoundary.status).toBe('quota-exceeded');
    expect(archivesOf(root)).toHaveLength(1);
    expect(readFileSync(archivesOf(root)[0])).toEqual(Buffer.concat([seed, Buffer.from(line)]));
    expect(readFileSync(activeOf(root), 'utf8')).toBe(line);
    expect(fs.statSync(archivesOf(root)[0]).size).toBe(1048576);
  });

  it.each(['{"partial":', '{"complete":"é"}'])('G2: unterminated bytes %s are archived without corrupting the next record', async (tail) => {
    const root = tmpRepo();
    const record = makeRecord();
    writeFileSync(activeOf(root), tail);

    const result = await appendRejected(root, record);

    expect(result.status).toBe('quota-exceeded');
    expect(archivesOf(root)).toHaveLength(1);
    expect(readFileSync(archivesOf(root)[0], 'utf8')).toBe(tail);
    expect(JSON.parse(readFileSync(activeOf(root), 'utf8'))).toEqual(record);
    expect(existsSync(join(root, '.orchestrator/metrics/proposals-write.lock'))).toBe(false);
  });

  it('G3: exclusive archive collision keeps preexisting bytes and original active content', async () => {
    const root = tmpRepo();
    writeFileSync(activeOf(root), '{"partial":');
    const realOpen = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, ...args) => {
      const name = String(file);
      if (name.endsWith('.partial')) writeFileSync(name.replace(/\.partial$/, '.jsonl'), 'existing archive');
      return realOpen(file, flags, ...args);
    });

    const result = await appendRejected(root, makeRecord());

    expect(result.status).toBe('fs-error');
    expect(result.error).toMatch(/EEXIST/);
    expect(readFileSync(activeOf(root), 'utf8')).toBe('{"partial":');
    expect(readFileSync(archivesOf(root)[0], 'utf8')).toBe('existing archive');
    expect(readFileSync(partialsOf(root)[0], 'utf8')).toBe('{"partial":');
    expect(existsSync(join(root, '.orchestrator/metrics/proposals-write.lock'))).toBe(false);
  });

  function injectRotationFailure(stage) {
    const descriptors = new Map();
    const realOpen = fs.openSync;
    const realWrite = fs.writeFileSync;
    const realSync = fs.fsyncSync;
    let directorySyncs = 0;
    const failure = () => { throw new Error(`synthetic ${stage} failure`); };
    vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      const fd = realOpen(file, ...args);
      descriptors.set(fd, String(file));
      return fd;
    });
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, bytes, ...args) => {
      const name = descriptors.get(file) ?? '';
      if (stage === 'archive-write' && name.includes('.archive-')) {
        realWrite(file, Buffer.from(bytes).subarray(0, 3));
        failure();
      }
      if (stage === 'temp-write' && name.includes('.tmp-')) failure();
      return realWrite(file, bytes, ...args);
    });
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      const name = descriptors.get(fd) ?? '';
      if (stage === 'archive-sync' && name.includes('.archive-')) failure();
      if (stage === 'temp-sync' && name.includes('.tmp-')) failure();
      if (name.endsWith('/metrics')) {
        directorySyncs++;
        if (stage === 'directory-before' && directorySyncs === 1) failure();
        if (stage === 'directory-after' && directorySyncs === 2) failure();
      }
      return realSync(fd);
    });
    if (stage === 'rename') vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (String(source).includes('proposals-overflow.jsonl.tmp-')) failure();
      return fsRename(source, target);
    });
  }
  const fsRename = fs.renameSync;

  it.each(['archive-write', 'archive-sync', 'directory-before', 'temp-write', 'temp-sync', 'rename'])('G4: %s failure preserves exact active bytes and releases the lock', async (stage) => {
    const root = tmpRepo();
    writeFileSync(activeOf(root), '{"partial":');
    injectRotationFailure(stage);

    const result = await appendRejected(root, makeRecord());
    const copyAborted = stage.startsWith('archive-');

    expect(result).toEqual({ status: 'fs-error', error: `synthetic ${stage} failure` });
    expect(readFileSync(activeOf(root), 'utf8')).toBe('{"partial":');
    // An aborted copy leaves only a .partial, never a truncated archive name.
    expect(archivesOf(root)).toHaveLength(copyAborted ? 0 : 1);
    expect(partialsOf(root)).toHaveLength(copyAborted ? 1 : 0);
    if (!copyAborted) expect(readFileSync(archivesOf(root)[0], 'utf8')).toBe('{"partial":');
    expect(existsSync(join(root, '.orchestrator/metrics/proposals-write.lock'))).toBe(false);
  });

  it('G5: directory flush failure after rename retains every byte in archive and active', async () => {
    const root = tmpRepo();
    const record = makeRecord();
    writeFileSync(activeOf(root), '{"partial":');
    injectRotationFailure('directory-after');

    const result = await appendRejected(root, record);

    expect(result).toEqual({ status: 'fs-error', error: 'synthetic directory-after failure' });
    expect(readFileSync(archivesOf(root)[0], 'utf8')).toBe('{"partial":');
    expect(JSON.parse(readFileSync(activeOf(root), 'utf8'))).toEqual(record);
    expect(existsSync(join(root, '.orchestrator/metrics/proposals-write.lock'))).toBe(false);
  });

  it('G6: symlink-root alias rotates within the canonical metrics directory', async () => {
    const root = tmpRepo();
    const aliasParent = tmpRepo();
    const alias = join(aliasParent, 'root-alias');
    symlinkSync(root, alias);
    writeFileSync(activeOf(root), '{"partial":');
    const record = makeRecord();

    const result = await appendRejected(alias, record);

    expect(result.status).toBe('quota-exceeded');
    expect(readFileSync(archivesOf(root)[0], 'utf8')).toBe('{"partial":');
    expect(JSON.parse(readFileSync(activeOf(root), 'utf8'))).toEqual(record);
  });

  it('G7: an oversized legacy file copies in bounded chunks without losing bytes', async () => {
    const root = tmpRepo();
    const oldBytes = Buffer.from('\n'.repeat(2 * cap + 17));
    const record = makeRecord();
    writeFileSync(activeOf(root), oldBytes);
    const realOpenSync = fs.openSync;
    const activeFds = new Set();
    vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      const fd = realOpenSync(file, ...args);
      if (path.resolve(String(file)) === path.resolve(activeOf(root))) activeFds.add(fd);
      return fd;
    });
    const reads = vi.spyOn(fs, 'readSync');

    const result = await appendRejected(root, record);
    // Only reads of the legacy file count: Node's own readFileSync also goes
    // through fs.readSync with whole-file lengths and must not be attributed.
    const copyReads = reads.mock.calls.filter((call) => activeFds.has(call[0]));

    expect(result.status).toBe('quota-exceeded');
    expect(readFileSync(archivesOf(root)[0])).toEqual(oldBytes);
    expect(JSON.parse(readFileSync(activeOf(root), 'utf8'))).toEqual(record);
    expect(copyReads.every((call) => call[3] <= 65536)).toBe(true);
    expect(copyReads.filter((call) => call[3] === 65536).length).toBeGreaterThan(32);
  });

  it.each([
    ['absent', undefined, []],
    ['empty', '', []],
    ['existing', '{"seed":true}\n', ['{"seed":true}\n']],
  ])('G8: a schema-valid oversized record survives an %s active file and the next rotation', async (_kind, initial, oldArchiveBytes) => {
    const root = tmpRepo();
    const largeRecord = makeRecord({ proposedByAgent: 'x'.repeat(cap) });
    const smallRecord = makeRecord({ subject: 'after-oversized' });
    const largeLine = JSON.stringify(largeRecord) + '\n';
    if (initial !== undefined) writeFileSync(activeOf(root), initial);

    const largeResult = await appendRejected(root, largeRecord);
    const largeActive = readFileSync(activeOf(root), 'utf8');
    const smallResult = await appendRejected(root, smallRecord);

    expect(validateProposalRecord(largeRecord)).toEqual({ ok: true });
    expect(Buffer.byteLength(largeLine)).toBeGreaterThan(1048576);
    expect(largeResult.status).toBe('quota-exceeded');
    expect(largeActive).toBe(largeLine);
    expect(smallResult.status).toBe('quota-exceeded');
    expect(archivesOf(root).map((file) => readFileSync(file, 'utf8')).sort()).toEqual([...oldArchiveBytes, largeLine].sort());
    expect(JSON.parse(readFileSync(activeOf(root), 'utf8'))).toEqual(smallRecord);
  });

  it.skipIf(process.platform === 'win32')('G9: rotation retains private inode permissions on archive and replacement', async () => {
    const root = tmpRepo();
    const record = makeRecord();
    writeFileSync(activeOf(root), '{"partial":', { mode: 0o600 });

    const result = await appendRejected(root, record);

    expect(result.status).toBe('quota-exceeded');
    expect(fs.statSync(archivesOf(root)[0]).mode & 0o777).toBe(0o600);
    expect(fs.statSync(activeOf(root)).mode & 0o777).toBe(0o600);
    expect(readFileSync(archivesOf(root)[0], 'utf8')).toBe('{"partial":');
    expect(JSON.parse(readFileSync(activeOf(root), 'utf8'))).toEqual(record);
  });
});
