/**
 * tests/integration/state-md-lock-concurrent.test.mjs
 *
 * Integration tests for the concurrent-access behaviour of withStateMdLock
 * (Pattern 1, issue #518).
 *
 * Scenario: two async Promises race to acquire the same .orchestrator/state.lock
 * within the same Node.js process.  Because JavaScript is single-threaded, the
 * contention is achieved by using non-blocking async fn payloads together with
 * a short poll-based wait in the lock implementation — the same contention model
 * gsd-2 tests.
 *
 * Tests here operate against a real tmp-dir filesystem (no mocks).
 *
 * Why no mocks?
 *  - The lock mechanism is entirely filesystem-based — mocking fs would only
 *    test the mock, not the locking behaviour (anti-pattern: "test-the-mock").
 *  - The race condition is observable through execution order and file state,
 *    both of which require real I/O.
 *
 * Design note: tests will be RED until Agent A commits acquireStateLock /
 * releaseStateLock / withStateMdLock into scripts/lib/session-lock.mjs.
 * This is expected per the wave plan.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { withStateMdLock } from '@lib/session-lock.mjs';

// ---------------------------------------------------------------------------
// Per-test isolated tmp root
// ---------------------------------------------------------------------------

let repoRoot;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'state-lock-int-'));
  mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolves after `ms` milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 1. Serialisation: only one writer holds the lock at a time
// ---------------------------------------------------------------------------

describe('concurrent withStateMdLock — serialisation', () => {
  it('serializes two parallel writers: only one holds the lock at a time', async () => {
    // Track the number of concurrent holders; it must never exceed 1.
    let concurrent = 0;
    let maxConcurrent = 0;
    const execOrder = [];

    const writer = async (label) => {
      return withStateMdLock(
        repoRoot,
        async () => {
          concurrent += 1;
          if (concurrent > maxConcurrent) maxConcurrent = concurrent;
          execOrder.push(`${label}:start`);
          // Give the event loop a chance for a second writer to try to enter
          await sleep(50);
          execOrder.push(`${label}:end`);
          concurrent -= 1;
        },
        { timeoutMs: 5000 },
      );
    };

    // Fire both writers simultaneously
    await Promise.all([writer('A'), writer('B')]);

    // Core invariant: the lock is a mutex — max concurrent holders is 1
    expect(maxConcurrent).toBe(1);

    // Both writers must have completed — execOrder has 4 entries
    expect(execOrder).toHaveLength(4);

    // Serialisation: one writer's :end must appear before the other's :start
    // i.e. the sequence is either [A:start, A:end, B:start, B:end]
    //                          or [B:start, B:end, A:start, A:end]
    const firstLabel = execOrder[0].split(':')[0];
    const secondLabel = firstLabel === 'A' ? 'B' : 'A';
    expect(execOrder[0]).toBe(`${firstLabel}:start`);
    expect(execOrder[1]).toBe(`${firstLabel}:end`);
    expect(execOrder[2]).toBe(`${secondLabel}:start`);
    expect(execOrder[3]).toBe(`${secondLabel}:end`);
  });

  it('both fn() callbacks execute — no call is silently dropped', async () => {
    const completed = [];

    const writer = (label) =>
      withStateMdLock(
        repoRoot,
        async () => {
          await sleep(20);
          completed.push(label);
        },
        { timeoutMs: 5000 },
      );

    await Promise.all([writer('alpha'), writer('beta')]);

    // Both must have run
    expect(completed).toHaveLength(2);
    expect(completed).toContain('alpha');
    expect(completed).toContain('beta');
  });
});

// ---------------------------------------------------------------------------
// 2. Timeout: second caller rejects when first holds lock too long
// ---------------------------------------------------------------------------

describe('concurrent withStateMdLock — timeout enforcement', () => {
  it('second call returns { ok:false } or rejects with timeout when first holds lock beyond timeoutMs', async () => {
    // A PID guaranteed dead — plant a lock manually so the live acquire loop
    // sees the lock as held and can only time out (we need a stable "blocked"
    // scenario without relying on timing of two withStateMdLock calls).
    // We write the lock file with the CURRENT process PID so isPidAlive → true,
    // then call acquireStateLock with a very short timeout.
    const lockPath = join(repoRoot, '.orchestrator', 'state.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString(), holder: 'holder' }),
      'utf8',
    );

    const start = Date.now();
    // withStateMdLock should either return { ok: false, reason: 'timeout' }
    // or reject — both indicate the caller correctly honoured the timeout.
    let timedOut = false;
    try {
      const result = await withStateMdLock(
        repoRoot,
        async () => {
          // This fn should NOT run — lock is already held
          throw new Error('fn must not execute while lock is held by live PID');
        },
        { timeoutMs: 300 },
      );
      // If withStateMdLock returns an object on timeout instead of throwing,
      // verify the failure shape
      if (result && result.ok === false && result.reason === 'timeout') {
        timedOut = true;
      }
    } catch (err) {
      // Rejection is also an acceptable signal that the timeout fired
      if (err.message && (err.message.includes('timeout') || err.message.includes('timed out'))) {
        timedOut = true;
      }
    }

    const elapsed = Date.now() - start;

    // Must have respected the timeoutMs — elapsed < 2 s  (not the default 10s)
    expect(elapsed).toBeLessThan(2000);
    expect(timedOut).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Data integrity: serialized writes preserve all data (no torn content)
// ---------------------------------------------------------------------------

describe('concurrent withStateMdLock — data integrity', () => {
  it('serialized writes to a shared counter produce the correct final value', async () => {
    // Simulate writing to a shared file (stands in for STATE.md).
    // Without a lock, two concurrent readers+incrementers would race.
    const counterPath = join(repoRoot, 'counter.txt');
    writeFileSync(counterPath, '0', 'utf8');

    const { readFileSync } = await import('node:fs');

    const increment = () =>
      withStateMdLock(
        repoRoot,
        async () => {
          const current = parseInt(readFileSync(counterPath, 'utf8'), 10);
          // Give event loop a turn before writing — without a lock this would race
          await sleep(10);
          writeFileSync(counterPath, String(current + 1), 'utf8');
        },
        { timeoutMs: 5000 },
      );

    // Fire 5 increments concurrently — lock must serialize them
    await Promise.all([increment(), increment(), increment(), increment(), increment()]);

    const finalValue = parseInt(readFileSync(counterPath, 'utf8'), 10);
    // If the lock is working: 5 serialized increments → 5
    // If the lock is broken:  concurrent reads yield 0 → all write 1 → final is 1
    expect(finalValue).toBe(5);
  });

  it('lock file is absent after all concurrent writers complete', async () => {
    const lockPath = join(repoRoot, '.orchestrator', 'state.lock');

    const noop = () =>
      withStateMdLock(repoRoot, async () => { await sleep(10); }, { timeoutMs: 5000 });

    await Promise.all([noop(), noop(), noop()]);

    expect(existsSync(lockPath)).toBe(false);
  });
});
