/**
 * tests/integration/state-md-lock-cross-process.test.mjs
 *
 * Regression guard for the cross-process mutex contract of withStateMdLock
 * (Issue #518, surfaced by W1 inter-wave session-reviewer YELLOW finding #1).
 *
 * The intra-process integration test (state-md-lock-concurrent.test.mjs)
 * proves serialisation under Node's single-threaded event loop, where
 * tryAcquireStateLock's synchronous body is naturally atomic. It does NOT
 * exercise the cross-process race that PRD § 3 Pattern 1 line 64 actually
 * promises ("zwei parallelen Worker-Sessions im selben Repo").
 *
 * This test spawns N sibling Node child processes, each of which calls
 * withStateMdLock + read-modify-write on a shared counter file. If the lock
 * is a true cross-process mutex (O_EXCL create), the final counter equals N.
 * If the lock is broken (tmp+rename TOCTOU race), the final counter is < N
 * because two children both read 0, both write 1, etc.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// Per-spawn watchdog ceiling: above the real runtime (5×30ms serialised
// increments + spawn overhead), below the per-test vitest timeout of 30000ms.
// Node SIGTERMs any child that overruns so the fork-pool worker is never pinned
// alive past the test boundary by an orphan under CPU starvation.
const CHILD_SPAWN_TIMEOUT_MS = 25000;

// Test-local lock-acquire timeout passed into withStateMdLock's opts.timeoutMs —
// scoped to THIS fixture only; DEFAULT_STATE_LOCK_TIMEOUT_MS (10000ms) in
// scripts/lib/locks/state-md-lock.mjs stays untouched for every other caller (#813).
// Headroom arithmetic: LOCK_ACQUIRE_TIMEOUT_MS (18000) < CHILD_SPAWN_TIMEOUT_MS
// (25000) < each it()'s own timeout (30000 / 30000) — a sibling that legitimately
// waits out the full lock-acquire window still has margin before the spawn
// watchdog or the vitest test timeout fires. The second it() sits at 30000 too:
// equal to CHILD_SPAWN_TIMEOUT_MS would give the outer vitest timeout zero race
// margin against the spawn watchdog, burying the speaking per-sibling diagnostic
// this fixture exists to surface (W2 session-reviewer finding, #813).
const LOCK_ACQUIRE_TIMEOUT_MS = 18000;

// ---------------------------------------------------------------------------
// Per-test isolated tmp root
// ---------------------------------------------------------------------------

let repoRoot;
let workerPath;
// Track every spawned child so afterEach can SIGKILL any survivor.
let spawnedChildren = [];

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'state-lock-xproc-'));
  spawnedChildren = [];
  mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
  workerPath = join(repoRoot, 'worker.mjs');
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
 * Spawn a child Node process and wait for it to exit. Returns the exit code
 * and stderr output.
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
 * Inline worker script that performs N read-modify-write cycles on a shared
 * counter file, each protected by withStateMdLock.
 */
function buildWorkerScript({ repoRoot, counterPath }) {
  return `
import { withStateMdLock } from '${SESSION_LOCK_PATH}';
import { readFileSync, writeFileSync } from 'node:fs';

const repoRoot = ${JSON.stringify(repoRoot)};
const counterPath = ${JSON.stringify(counterPath)};

await withStateMdLock(
  repoRoot,
  async () => {
    const current = parseInt(readFileSync(counterPath, 'utf8'), 10);
    // Yield to event loop so a sibling can race the read-modify-write.
    // Without a true mutex, both siblings read the same value, both write +1.
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(counterPath, String(current + 1), 'utf8');
  },
  { timeoutMs: ${LOCK_ACQUIRE_TIMEOUT_MS} },
);
`;
}

/** Pause a waiter after it has read the old lock, before its PID check. The
 * third process records its first real acquisition attempt so the parent can
 * resume the waiter even when correct serialization blocks that third process.
 */
function buildTakeoverRaceWorker({ repoRoot, counterPath }) {
  return `
import { withStateMdLock } from '${SESSION_LOCK_PATH}';
import fs from 'node:fs';
import path from 'node:path';
const root = ${JSON.stringify(repoRoot)};
const counter = ${JSON.stringify(counterPath)};
const role = process.argv[2];
const lock = path.join(root, '.orchestrator', 'state.lock');
const mark = (name, value = 'ready') => fs.writeFileSync(path.join(root, name), value);
const wait = async (name) => {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(root, name))) {
    if (Date.now() >= deadline) throw new Error('worker coordination timed out: ' + name);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
if (role === 'waiter') {
  const read = fs.readFileSync;
  let intercepted = false;
  fs.readFileSync = function(filename, ...args) {
    const raw = read.call(this, filename, ...args);
    if (!intercepted && filename === lock) {
      intercepted = true;
      mark('waiter-read-old-lock');
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(path.join(root, 'resume-waiter'))) {
        if (Date.now() >= deadline) throw new Error('waiter coordination timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    return raw;
  };
}
if (role === 'new-holder') {
  const link = fs.linkSync;
  let intercepted = false;
  fs.linkSync = function(source, destination) {
    const observe = !intercepted && path.dirname(destination) === path.dirname(lock);
    if (observe) intercepted = true;
    try {
      const result = link.call(this, source, destination);
      if (observe) mark('new-holder-attempt', 'created');
      return result;
    } catch (error) {
      if (observe) mark('new-holder-attempt', error.code);
      throw error;
    }
  };
}
await withStateMdLock(root, async () => {
  const value = Number(fs.readFileSync(counter, 'utf8'));
  mark(role + '-entered');
  if (role === 'owner') await wait('release-owner');
  if (role === 'new-holder') await wait('release-new-holder');
  fs.writeFileSync(counter, String(value + 1));
}, { timeoutMs: ${LOCK_ACQUIRE_TIMEOUT_MS} });
`;
}

async function waitForMarker(name) {
  const filename = join(repoRoot, name);
  const deadline = Date.now() + 10000;
  while (!existsSync(filename)) {
    if (Date.now() >= deadline) throw new Error(`coordination timed out: ${name}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return readFileSync(filename, 'utf8');
}

// ---------------------------------------------------------------------------
// Cross-process mutex contract
// ---------------------------------------------------------------------------

describe('cross-process withStateMdLock — mutex contract', () => {
  it('serializes a stale waiter with a new holder after the observed owner exits', async () => {
    const counterPath = join(repoRoot, 'counter.txt');
    writeFileSync(counterPath, '0', 'utf8');
    writeFileSync(workerPath, buildTakeoverRaceWorker({ repoRoot, counterPath }), 'utf8');

    const owner = runChild(workerPath, ['owner']);
    await waitForMarker('owner-entered');
    const waiter = runChild(workerPath, ['waiter']);
    await waitForMarker('waiter-read-old-lock');
    writeFileSync(join(repoRoot, 'release-owner'), 'go');
    const ownerResult = await owner;
    expect(ownerResult.code, ownerResult.stderr).toBe(0);

    const newHolder = runChild(workerPath, ['new-holder']);
    const attempt = await waitForMarker('new-holder-attempt');
    expect(['created', 'EEXIST']).toContain(attempt);
    // Without acquisition serialization, the third process now holds the
    // replacement lock. Keep it inside its read-modify-write critical section
    // while the waiter decides the already-read owner PID is dead.
    if (attempt === 'created') await waitForMarker('new-holder-entered');
    writeFileSync(join(repoRoot, 'resume-waiter'), 'go');
    const waiterResult = await waiter;
    writeFileSync(join(repoRoot, 'release-new-holder'), 'go');
    const newHolderResult = await newHolder;
    for (const result of [waiterResult, newHolderResult]) {
      expect(result.code, result.stderr).toBe(0);
    }
    expect(Number(readFileSync(counterPath, 'utf8'))).toBe(3);
  }, 30000);

  it('5 sibling Node processes incrementing a shared counter produce exactly 5', async () => {
    const counterPath = join(repoRoot, 'counter.txt');
    writeFileSync(counterPath, '0', 'utf8');
    writeFileSync(workerPath, buildWorkerScript({ repoRoot, counterPath }), 'utf8');

    // Fire 5 child processes in parallel.
    const N = 5;
    const results = await Promise.all(
      Array.from({ length: N }, () => runChild(workerPath)),
    );

    // All children must exit cleanly. Speaking message surfaces stderr (e.g.
    // STATE_LOCK_TIMEOUT from withStateMdLock's acquire-failed throw) instead
    // of a bare "expected 0, got 1" that hides WHY a sibling died (#813).
    results.forEach((r, i) => {
      expect(r.code, `sibling #${i} exited ${r.code} (expected 0) — stderr:\n${r.stderr}`).toBe(0);
    });

    // Final counter must reflect N serialised increments.
    const finalValue = parseInt(readFileSync(counterPath, 'utf8'), 10);
    expect(finalValue).toBe(N);
  }, 30000); // generous timeout for spawn + 5×30ms minimum serialisation

  it('no .state.lock or .tmp.* file remains after concurrent siblings complete', async () => {
    const counterPath = join(repoRoot, 'counter.txt');
    writeFileSync(counterPath, '0', 'utf8');
    writeFileSync(workerPath, buildWorkerScript({ repoRoot, counterPath }), 'utf8');

    const results = await Promise.all([runChild(workerPath), runChild(workerPath), runChild(workerPath)]);

    // All children must exit cleanly — same speaking-message pattern as the
    // first it() so a sibling's STATE_LOCK_TIMEOUT (or any other acquire
    // failure) surfaces instead of being silently discarded (#813).
    results.forEach((r, i) => {
      expect(r.code, `sibling #${i} exited ${r.code} (expected 0) — stderr:\n${r.stderr}`).toBe(0);
    });

    const lockPath = join(repoRoot, '.orchestrator', 'state.lock');
    expect(existsSync(lockPath)).toBe(false);

    // No torn-write tmp files either.
    const { readdirSync } = await import('node:fs');
    const entries = readdirSync(join(repoRoot, '.orchestrator'));
    const tmpFiles = entries.filter((name) => name.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);
  }, 30000); // headroom above CHILD_SPAWN_TIMEOUT_MS (25000ms) — equal values would race the spawn watchdog vs. the vitest timeout and bury the speaking per-sibling diagnostic (W2 review, #813)
});
