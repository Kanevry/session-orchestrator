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
import { writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rmSync } from 'node:fs';

import { appendProposal, countProposalsForWave, readWaveSummary } from '@lib/memory-proposals/store.mjs';
import { createProposalRecord } from '@lib/memory-proposals/schema.mjs';

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

  it('B9: readWaveSummary returns null when no summary file exists', async () => {
    const repoRoot = tmpRepo();

    const summary = await readWaveSummary({ repoRoot, waveId: 'W1' });

    expect(summary).toBeNull();
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

  it('C9: 8 parallel child_processes with quota=5 yields exactly 5 queued + 3 quota-exceeded', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'proposals-race-'));
    tmpDirsToCleanup.push(repoRoot);
    mkdirSync(join(repoRoot, '.orchestrator/metrics'), { recursive: true });

    // Write a tiny worker script that calls appendProposal once and prints the result.
    // It reads its index from process.argv[2] to produce a unique subject per worker.
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
  quotaPerWave: 5,
  lockTimeoutMs: 5000,
});

process.stdout.write(JSON.stringify(result));
process.exit(0);
`;
    const workerPath = join(repoRoot, 'worker.mjs');
    writeFileSync(workerPath, workerScript, 'utf8');

    // Spawn 8 child processes in parallel
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
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

    const queued = results.filter((r) => r.status === 'queued');
    const dropped = results.filter((r) => r.status === 'quota-exceeded');

    // FALSIFICATION: without the lock, races would allow >5 queued and <3 dropped.
    expect(queued).toHaveLength(5);
    expect(dropped).toHaveLength(3);

    // proposals.jsonl must have exactly 5 non-empty lines
    const raw = readFileSync(join(repoRoot, '.orchestrator/metrics/proposals.jsonl'), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(5);

    // All 5 lines must be valid JSON with wave_id='W1'
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.wave_id).toBe('W1');
    }

    // No leftover lock file or tmp file in the metrics dir
    const metricsDir = readdirSync(join(repoRoot, '.orchestrator/metrics'));
    const lockFiles = metricsDir.filter((f) => f.includes('proposals-write.lock'));
    expect(lockFiles).toHaveLength(0);

    // Positions reported by queued workers must form exactly the set 1/5..5/5
    const positions = queued.map((r) => r.position).sort();
    expect(positions).toEqual(['1/5', '2/5', '3/5', '4/5', '5/5']);
  }, 30_000); // 30s timeout for parallel child_process spawn

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
