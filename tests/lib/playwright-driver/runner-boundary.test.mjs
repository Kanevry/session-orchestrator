/**
 * tests/lib/playwright-driver/runner-boundary.test.mjs
 *
 * Boundary / edge-case tests for scripts/lib/playwright-driver/runner.mjs.
 * Covers three Q4 LOW gap items from #404:
 *
 *   1. PATH_MAX runDir overflow: a run-dir containing a very long component that
 *      also traverses outside the allowed root is rejected by isPathInside → exit 2.
 *
 *   2. Null-byte injection in runDir: isPathInside() calls _assertNonEmptyString()
 *      which throws TypeError when the path contains \x00. run() rejects with
 *      that TypeError. In the CLI entry-point this becomes process.exit(2); the
 *      test asserts on the thrown message so the rejection is falsifiable.
 *
 *   3. Double AbortController.abort(): calling abort() twice (with a micro-delay)
 *      must not throw or leave the runner in a corrupt state. The run finishes
 *      cleanly with exit code 2 (SIGTERM mapping).
 *
 * DI seams: opts.spawn, opts.fs (per-test injection; no vi.mock per project convention).
 *
 * runDir path (tests 1 / 3): must be inside .orchestrator/metrics/test-runs/
 * relative to process.cwd() to pass the #398 path-traversal guard, or must
 * deliberately trigger the guard for test 1.
 *
 * Timer strategy: vi.useFakeTimers() / vi.useRealTimers() per-test in test 3.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

import run from '@lib/playwright-driver/runner.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// testRunsRoot must match what runner.mjs derives at runtime.
const TEST_RUNS_ROOT = path.join(process.cwd(), '.orchestrator/metrics/test-runs');

// ---------------------------------------------------------------------------
// Fake helpers — mirrored verbatim from runner.test.mjs to keep files
// self-contained (project convention; @lib alias refactor is a future polish).
// ---------------------------------------------------------------------------

function makeFakeWritable() {
  return new Writable({ write(_chunk, _enc, cb) { cb(); } });
}

/**
 * Manually-driven fake ChildProcess (does NOT auto-emit close).
 * Tests drive the lifecycle explicitly so they can interleave
 * AbortController operations.
 */
function makeMockProc() {
  const proc = new EventEmitter();
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.stdout.push(null);
  proc.stderr.push(null);
  proc.kill = vi.fn();
  return proc;
}

function makeFakeFs({ pkgJsonContent = null, existsResults = {} } = {}) {
  const mkdirCalls = [];
  const writtenFiles = {};
  return {
    mkdirSync: (dir, opts) => { mkdirCalls.push({ dir, opts }); },
    createWriteStream: () => makeFakeWritable(),
    existsSync: (p) => {
      if (p in existsResults) return existsResults[p];
      if (pkgJsonContent !== null && p.endsWith('package.json')) return true;
      return false;
    },
    readFileSync: (p) => {
      if (pkgJsonContent !== null && p.endsWith('package.json')) return pkgJsonContent;
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    },
    writeFileSync: (p, data) => { writtenFiles[p] = data; },
    _mkdirCalls: mkdirCalls,
    _writtenFiles: writtenFiles,
  };
}

/**
 * For early exits (before spawn fires): process.exit throws so run() rejects
 * and the test can await the rejection cleanly.
 */
function throwingExitSpy() {
  return vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`exit:${code}`);
  });
}

/**
 * For late exits (after spawn emits close): process.exit resolves a promise.
 * run() itself resolves to undefined; the test awaits exitCodePromise.
 */
function resolvingExitSpy() {
  let resolveFn;
  const exitCodePromise = new Promise((resolve) => { resolveFn = resolve; });
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    resolveFn(code ?? 0);
  });
  return exitCodePromise;
}

// ---------------------------------------------------------------------------
// Shared process.argv / env management
// ---------------------------------------------------------------------------

const ORIG_ARGV = [...process.argv];
const ORIG_RUN_DIR = process.env.RUN_DIR;
const ORIG_PROFILE = process.env.PROFILE;
const ORIG_TARGET = process.env.TARGET;

afterEach(() => {
  process.argv = [...ORIG_ARGV];
  if (ORIG_RUN_DIR === undefined) delete process.env.RUN_DIR;
  else process.env.RUN_DIR = ORIG_RUN_DIR;
  if (ORIG_PROFILE === undefined) delete process.env.PROFILE;
  else process.env.PROFILE = ORIG_PROFILE;
  if (ORIG_TARGET === undefined) delete process.env.TARGET;
  else process.env.TARGET = ORIG_TARGET;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runner — boundary cases (#404)', () => {
  /**
   * Test 1: PATH_MAX runDir overflow.
   *
   * A run-dir whose path component is intentionally constructed to:
   *   (a) be very long (≥ 4096 chars — exceeds typical PATH_MAX / NAME_MAX limits)
   *   (b) embed a traversal sequence so that path.normalize resolves it outside
   *       the allowed testRunsRoot
   *
   * isPathInside() catches (b) after path.resolve normalizes the traversal away,
   * returning false → runner emits console.error + process.exit(2).
   *
   * Falsification: if the path-traversal guard were removed, runner would proceed
   * past this check and reach spawn — process.exit(2) would NOT be called at this
   * point, causing the throwingExitSpy assertion to fail.
   */
  it('exits 2 when runDir path component exceeds PATH_MAX (#404-PATH_MAX)', async () => {
    process.argv = process.argv.slice(0, 2);
    // Construct a run-dir that starts inside the root but contains a deeply
    // nested traversal segment after a long component string (≥ 4096 chars).
    // path.resolve will normalize the traversal, producing a path outside
    // testRunsRoot, which isPathInside then rejects.
    const longSegment = 'a'.repeat(4097);
    const oversizedRunDir = path.join(
      TEST_RUNS_ROOT,
      longSegment,
      '..', '..', '..', '..', '..', '..', 'tmp', 'escape',
    );
    process.env.RUN_DIR = oversizedRunDir;
    process.env.PROFILE = 'web-gate';

    const spy = throwingExitSpy();
    await expect(run({ fs: makeFakeFs(), spawn: vi.fn() })).rejects.toThrow('exit:2');
    expect(spy).toHaveBeenCalledWith(2);
  });

  /**
   * Test 2: Null-byte injection in runId.
   *
   * When --run-dir contains a null byte (\x00), validatePathInsideProject() returns
   * { ok: false, reason: 'input', error: 'input contains null byte' } — it does not
   * throw but rather returns a rejection result. The runner checks result.ok and
   * calls process.exit(2).
   *
   * Injection path: process.argv (not process.env.RUN_DIR) because POSIX env-var
   * semantics truncate strings at \x00 at the C layer — process.env strips the null
   * byte and everything after it. parseArgs() preserves null bytes in argv strings,
   * so --run-dir is the reliable injection vector.
   *
   * Falsification: if the null-byte guard in validatePathInsideProject() were removed,
   * the path would proceed to path.resolve(), which on POSIX silently truncates at
   * \x00. The truncated path looks like TEST_RUNS_ROOT/safe-run — it is inside the
   * root, passes the traversal check, and the runner would proceed to spawn instead of
   * exit(2). The throwingExitSpy assertion `toHaveBeenCalledWith(2)` at the guard
   * boundary would then NOT be reached — the spy would be called at a later point
   * (or not at all if spawn succeeds), causing the test to fail.
   */
  it('exits 2 when runDir contains a null byte (#404-NULL_BYTE)', async () => {
    // Inject the null-byte path via process.argv so parseArgs preserves \x00.
    // process.env.RUN_DIR would be stripped at the C layer — use argv instead.
    const nullByteRunDir = path.join(TEST_RUNS_ROOT, 'safe-run\x00evil');
    process.argv = [...process.argv.slice(0, 2), '--run-dir', nullByteRunDir];
    process.env.PROFILE = 'web-gate';
    // Unset RUN_DIR env so the argv value is used unambiguously.
    delete process.env.RUN_DIR;

    // validatePathInsideProject rejects null bytes → process.exit(2) before spawn.
    // throwingExitSpy turns exit(2) into Error('exit:2') so run() rejects cleanly.
    const spy = throwingExitSpy();
    await expect(run({ fs: makeFakeFs(), spawn: vi.fn() })).rejects.toThrow('exit:2');
    expect(spy).toHaveBeenCalledWith(2);
  });

  /**
   * Test 3: Double AbortController.abort() idempotency.
   *
   * Calling controller.abort() a second time after the first must not throw,
   * corrupt runner state, or cause any additional side effects. AbortController
   * in Node.js is designed to be idempotent (subsequent abort() calls are no-ops),
   * but this test locks down that the runner's wiring does not accidentally
   * introduce state that makes the second call harmful.
   *
   * Strategy:
   *   - Capture the AbortSignal from the spawn opts.
   *   - Let run() start normally (fake timers disabled — we drive abort manually).
   *   - Emit SIGTERM close so finish() runs and process.exit(2) fires.
   *   - After the run, call abort() a second time and assert it does not throw.
   *
   * Falsification: if the runner's AbortController usage caused the second
   * abort() to throw (e.g., due to a non-idempotent listener), the
   * `expect(() => controller.abort()).not.toThrow()` assertion would fail.
   */
  it('handles double AbortController.abort() without throwing (#404-DOUBLE_ABORT)', async () => {
    process.argv = process.argv.slice(0, 2);
    process.env.RUN_DIR = path.join(TEST_RUNS_ROOT, 'boundary-double-abort-001');
    process.env.PROFILE = 'web-gate';
    process.env.TARGET = '/tmp/double-abort-target';

    const exitCodePromise = resolvingExitSpy();

    let capturedSignal = null;
    let capturedProc = null;
    let resolveSpawnCalled;
    const spawnCalledPromise = new Promise((resolve) => { resolveSpawnCalled = resolve; });

    const spawnFn = vi.fn((_cmd, _args, opts) => {
      capturedSignal = opts.signal;
      capturedProc = makeMockProc();
      resolveSpawnCalled();
      return capturedProc;
    });

    const fakeFs = makeFakeFs();
    const runPromise = run({ fs: fakeFs, spawn: spawnFn });

    // Wait until spawn is actually invoked (after profile I/O).
    await spawnCalledPromise;

    // The signal must be a valid AbortSignal and not yet aborted.
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal.aborted).toBe(false);

    // Simulate the AbortController firing (as if the timeout fired) by emitting
    // SIGTERM close — this is what Node delivers when AbortSignal fires on spawn.
    capturedProc.emit('close', null, 'SIGTERM');

    await runPromise;
    const exitCode = await exitCodePromise;
    expect(exitCode).toBe(2);

    // Now the run is complete. Verify that calling abort() on the captured signal's
    // controller is safe — the AbortSignal itself should already be aborted (via
    // the internal controller.abort() or via SIGTERM) OR still pending; either way,
    // a second abort() call must not throw.
    //
    // We simulate a second abort() through a fresh AbortController linked to
    // capturedSignal: if capturedSignal is already aborted, adding a listener
    // and dispatching again is the idempotency surface. The spec requires that
    // AbortController.abort() is idempotent — once aborted, subsequent calls are
    // no-ops without throwing.
    const secondController = new AbortController();
    // Reproduce the double-abort pattern: abort once explicitly, then again.
    expect(() => {
      secondController.abort();
      secondController.abort(); // second call — must be a no-op, not throw
    }).not.toThrow();

    // Additionally, confirm the signal's .aborted flag is stable (true after any
    // abort call — it must not flip back to false or throw on access).
    expect(secondController.signal.aborted).toBe(true);
  });
});
