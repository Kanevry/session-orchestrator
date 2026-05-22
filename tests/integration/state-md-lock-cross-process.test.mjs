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

// ---------------------------------------------------------------------------
// Per-test isolated tmp root
// ---------------------------------------------------------------------------

let repoRoot;
let workerPath;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'state-lock-xproc-'));
  mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
  workerPath = join(repoRoot, 'worker.mjs');
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn a child Node process and wait for it to exit. Returns the exit code
 * and stderr output.
 */
function runChild(scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  { timeoutMs: 10000 },
);
`;
}

// ---------------------------------------------------------------------------
// Cross-process mutex contract
// ---------------------------------------------------------------------------

describe('cross-process withStateMdLock — mutex contract', () => {
  it('5 sibling Node processes incrementing a shared counter produce exactly 5', async () => {
    const counterPath = join(repoRoot, 'counter.txt');
    writeFileSync(counterPath, '0', 'utf8');
    writeFileSync(workerPath, buildWorkerScript({ repoRoot, counterPath }), 'utf8');

    // Fire 5 child processes in parallel.
    const N = 5;
    const results = await Promise.all(
      Array.from({ length: N }, () => runChild(workerPath)),
    );

    // All children must exit cleanly.
    for (const r of results) {
      expect(r.code).toBe(0);
    }

    // Final counter must reflect N serialised increments.
    const finalValue = parseInt(readFileSync(counterPath, 'utf8'), 10);
    expect(finalValue).toBe(N);
  }, 30000); // generous timeout for spawn + 5×30ms minimum serialisation

  it('no .state.lock or .tmp.* file remains after concurrent siblings complete', async () => {
    const counterPath = join(repoRoot, 'counter.txt');
    writeFileSync(counterPath, '0', 'utf8');
    writeFileSync(workerPath, buildWorkerScript({ repoRoot, counterPath }), 'utf8');

    await Promise.all([runChild(workerPath), runChild(workerPath), runChild(workerPath)]);

    const lockPath = join(repoRoot, '.orchestrator', 'state.lock');
    expect(existsSync(lockPath)).toBe(false);

    // No torn-write tmp files either.
    const { readdirSync } = await import('node:fs');
    const entries = readdirSync(join(repoRoot, '.orchestrator'));
    const tmpFiles = entries.filter((name) => name.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);
  }, 20000);
});
