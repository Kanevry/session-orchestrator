/**
 * tests/integration/session-lock-cross-process.test.mjs
 *
 * H4 (#591) — Real cross-process race against acquire() (Epic #583).
 *
 * PROVES the TOCTOU fix landed in W2-I2 (#590 Item 2): the fresh-acquire write
 * path migrated from writeLockAtomic (tmp + renameSync, last-writer-wins) to
 * createSessionLockExclusive (tmp + linkSync, POSIX create-or-fail). With the
 * fixed impl, N sibling processes that all observe readLock() === null race the
 * create, and EXACTLY ONE wins the linkSync — every other process gets EEXIST,
 * re-reads the now-present lock, and reports a contention reason (active /
 * stale-*). The on-disk lock ends up as a single valid JSON owner.
 *
 * FALSIFIABILITY (gated on the linkSync fix): against the OLD tmp+rename impl
 * this test FAILS — two children both read null, both write their own lock via
 * renameSync (last-writer-wins), and BOTH report ok:true. The single-winner
 * assertion (exactly 1 ok:true) would then see >1 winner. This is the test the
 * intra-process suite cannot provide: Node's single-threaded event loop makes
 * a synchronous create naturally atomic, so only separate OS processes can
 * exercise the real create race.
 *
 * Mirrors the spawn/runChild/buildWorkerScript pattern of
 * state-md-lock-cross-process.test.mjs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// Per-spawn watchdog ceiling: above the real runtime (5s barrier + acquire),
// below the per-test vitest timeout of 30000ms. If a child overruns this — e.g.
// a still-spinning orphan under CPU starvation — Node SIGTERMs it so the
// fork-pool worker is never pinned alive past the test boundary.
const CHILD_SPAWN_TIMEOUT_MS = 25000;

// ---------------------------------------------------------------------------
// Per-test isolated tmp root
// ---------------------------------------------------------------------------

let repoRoot;
// Track every spawned child so afterEach can SIGKILL any survivor (defensive
// insurance against an orphaned worker keeping the vitest forks pool alive).
let spawnedChildren = [];

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'session-lock-xproc-'));
  spawnedChildren = [];
  // NOTE: .orchestrator/ is created by the worker's acquire() itself — we do
  // NOT pre-create the session.lock, so every child races the fresh create.
  mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
});

afterEach(() => {
  for (const child of spawnedChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
  spawnedChildren = [];
  rmSync(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn a child Node process and wait for it to exit. Returns the exit code,
 * stdout (the acquire() JSON result), and stderr output.
 *
 * A per-spawn `timeout` makes Node SIGTERM a child that overruns the watchdog
 * ceiling, and every child is tracked so afterEach can SIGKILL any survivor.
 */
function runChild(scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CHILD_SPAWN_TIMEOUT_MS,
    });
    spawnedChildren.push(child);
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stderr, stdout }));
  });
}

// Project-root reference so the spawned worker can resolve
// scripts/lib/session-lock.mjs via absolute path.
const PROJECT_ROOT = process.cwd();
const SESSION_LOCK_PATH = join(PROJECT_ROOT, 'scripts', 'lib', 'session-lock.mjs');

/**
 * Inline worker: calls acquire() against the shared repoRoot with a unique
 * sessionId and mode 'deep'. We deliberately OMIT activeSessions so the
 * exclusivity-matrix branch is skipped and the call goes straight to the
 * local-lock create-or-fail path (the TOCTOU-relevant code). A barrier file
 * is busy-waited so all children fire their acquire() within a tight window,
 * maximising the real create race. Prints the JSON result to stdout.
 */
function buildWorkerScript({ repoRoot, barrierPath, sessionId }) {
  return `
import { acquire } from '${SESSION_LOCK_PATH}';
import { existsSync } from 'node:fs';

const repoRoot = ${JSON.stringify(repoRoot)};
const barrierPath = ${JSON.stringify(barrierPath)};
const sessionId = ${JSON.stringify(sessionId)};

// Wait on the barrier so siblings align their acquire() calls tightly. We poll
// with a short async sleep BETWEEN checks rather than a synchronous spin loop:
// a busy-wait pins a CPU core (the worst pattern under CPU starvation, where it
// can orphan a still-spinning child past the test deadline and keep the vitest
// forks-pool worker alive). The yielding poll preserves the SAME 5000ms deadline
// semantics — the child still proceeds the moment the barrier appears, and still
// gives up at the deadline — while releasing the core between checks.
const deadline = Date.now() + 5000;
const POLL_MS = 5;
while (!existsSync(barrierPath) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, POLL_MS));
}

const result = acquire({ sessionId, mode: 'deep', repoRoot });
process.stdout.write(JSON.stringify({ ok: result.ok, reason: result.reason ?? null, session_id: result.lock ? result.lock.session_id : null }));
`;
}

// ---------------------------------------------------------------------------
// Cross-process acquire() single-winner contract (H4)
// ---------------------------------------------------------------------------

describe('cross-process acquire() — single-winner race contract (H4 #591)', () => {
  it('5 sibling processes racing acquire() on the same repo produce exactly one winner', async () => {
    const N = 5;
    const barrierPath = join(repoRoot, 'go.barrier');

    // Write one worker file per child with a unique sessionId baked in.
    const sessionIds = Array.from({ length: N }, (_, i) => `xproc-sess-${i}`);
    const workerPaths = sessionIds.map((sessionId, i) => {
      const p = join(repoRoot, `worker-${i}.mjs`);
      writeFileSync(p, buildWorkerScript({ repoRoot, barrierPath, sessionId }), 'utf8');
      return p;
    });

    // Spawn all children — they busy-wait on the barrier file.
    const childPromises = workerPaths.map((p) => runChild(p));
    // Release the barrier so all children fire acquire() in a tight window.
    writeFileSync(barrierPath, 'go', 'utf8');

    const results = await Promise.all(childPromises);

    // All children must exit cleanly (acquire() is no-throw).
    for (const r of results) {
      expect(r.code).toBe(0);
    }

    // Parse each child's acquire() result.
    const parsed = results.map((r) => JSON.parse(r.stdout));

    // INVARIANT 1: exactly one child won the create (ok:true). This is the
    // assertion that FAILS against the old tmp+rename impl (which would yield
    // >1 winner because rename is last-writer-wins, not create-or-fail).
    const winners = parsed.filter((p) => p.ok === true);
    expect(winners).toHaveLength(1);

    // INVARIANT 2: every loser reports a contention reason — 'active' (live
    // PID + fresh TTL is the overwhelmingly common case for sibling node
    // procs that are still alive), or a stale-* variant. Never ok:true.
    const losers = parsed.filter((p) => p.ok === false);
    expect(losers).toHaveLength(N - 1);
    for (const loser of losers) {
      expect(['active', 'stale-pid-dead', 'stale-pid-alive']).toContain(loser.reason);
    }

    // INVARIANT 3: the on-disk lock is a single, valid JSON owner whose
    // session_id matches the winner's reported session_id (no torn write, no
    // last-writer-wins clobber).
    const lockFile = join(repoRoot, '.orchestrator', 'session.lock');
    expect(existsSync(lockFile)).toBe(true);
    const onDisk = JSON.parse(readFileSync(lockFile, 'utf8'));
    expect(onDisk.session_id).toBe(winners[0].session_id);
    // The winner's session_id is one of the N unique ids we dispatched.
    expect(sessionIds).toContain(onDisk.session_id);
  }, 30000);

  it('no .session.lock.create.tmp.* residue remains after the concurrent race', async () => {
    const N = 5;
    const barrierPath = join(repoRoot, 'go.barrier');

    const workerPaths = Array.from({ length: N }, (_, i) => {
      const p = join(repoRoot, `worker-${i}.mjs`);
      writeFileSync(p, buildWorkerScript({ repoRoot, barrierPath, sessionId: `hygiene-sess-${i}` }), 'utf8');
      return p;
    });

    const childPromises = workerPaths.map((p) => runChild(p));
    writeFileSync(barrierPath, 'go', 'utf8');
    await Promise.all(childPromises);

    // The linkSync helper unlinks its tmp file in a finally block on both the
    // win and the EEXIST-lose path, so no create-tmp residue may survive.
    const entries = readdirSync(join(repoRoot, '.orchestrator'));
    const residue = entries.filter((name) => name.startsWith('.session.lock.create.tmp.'));
    expect(residue).toHaveLength(0);
  }, 30000);
});
