/**
 * tests/lib/playwright-driver/runner-abort-controller.test.mjs
 *
 * AbortController / timeout path coverage for runner.mjs (#399 — GAP-Q4-3).
 *
 * Covers:
 *   1. AbortSignal becomes `aborted` when profile.timeout_ms elapses
 *   2. spawn receives controller.signal as the signal option
 *   3. clearTimeout is called when subprocess exits before the deadline
 *   4. exit code 2 is emitted when the process closes with SIGTERM
 *   5. web-gate profile's 120 000 ms timeout boundary is respected
 *
 * DI seams: opts.spawn, opts.fs  (same pattern as runner.test.mjs)
 *
 * Timer strategy: vi.useFakeTimers() in beforeEach, vi.useRealTimers() in
 * afterEach.  Process.exit captured via the resolvingExitSpy() pattern so
 * run() never throws and the AbortController advances cleanly.
 *
 * runDir path: must be inside .orchestrator/metrics/test-runs/ relative to
 * process.cwd() to pass the #398 path-traversal guard in runner.mjs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

import run from '../../../scripts/lib/playwright-driver/runner.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Valid runDir: inside .orchestrator/metrics/test-runs/ to pass #398 guard.
const VALID_RUN_DIR = path.join(
  process.cwd(),
  '.orchestrator/metrics/test-runs/abort-test-001',
);

// web-gate profile timeout_ms (from .orchestrator/policy/test-profiles.json)
const WEB_GATE_TIMEOUT_MS = 120000;

// ---------------------------------------------------------------------------
// Fake helpers (mirror runner.test.mjs conventions exactly)
// ---------------------------------------------------------------------------

function makeFakeWritable() {
  return new Writable({ write(_chunk, _enc, cb) { cb(); } });
}

/**
 * Build a fake ChildProcess.
 * Unlike the auto-emitting makeProc() in runner.test.mjs, this one does NOT
 * auto-emit close — the test drives the lifecycle manually.
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

function makeFakeFs({ existsResults = {} } = {}) {
  const mkdirCalls = [];
  const writtenFiles = {};
  return {
    mkdirSync: (dir, opts) => { mkdirCalls.push({ dir, opts }); },
    createWriteStream: () => makeFakeWritable(),
    existsSync: (p) => existsResults[p] ?? false,
    readFileSync: (p) => {
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    },
    writeFileSync: (p, data) => { writtenFiles[p] = data; },
    _mkdirCalls: mkdirCalls,
    _writtenFiles: writtenFiles,
  };
}

// ---------------------------------------------------------------------------
// Exit-code spy — resolving variant (run() completes; exit captured via Promise)
// ---------------------------------------------------------------------------

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

function setScenario({ runDir, profile, target } = {}) {
  process.argv = process.argv.slice(0, 2);
  process.env.RUN_DIR = runDir ?? VALID_RUN_DIR;
  process.env.PROFILE = profile ?? 'web-gate';
  if (target !== undefined) process.env.TARGET = target;
  else delete process.env.TARGET;
}

// ---------------------------------------------------------------------------
// Per-test lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
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

describe('runner.mjs AbortController timeout path (#399)', () => {
  /**
   * Test 1: AbortSignal becomes aborted after timeout_ms elapses.
   *
   * Strategy:
   *   - capture the `signal` option passed to spawnFn
   *   - spawnFn resolves a latch promise when called so we can await it
   *   - verify signal is not yet aborted before advancing timers
   *   - advance fake timers by WEB_GATE_TIMEOUT_MS ms → setTimeout fires → controller.abort()
   *   - verify signal.aborted === true
   *   - emit close(null, 'SIGTERM') so run() can finish cleanly
   */
  it('aborts subprocess when profile.timeout_ms elapses', async () => {
    setScenario({ target: '/tmp/abort-target' });
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

    // Wait until spawn is actually called (after loadProfiles + getProfile async I/O).
    await spawnCalledPromise;

    expect(capturedSignal.aborted).toBe(false);

    // Advance timers to fire the setTimeout → controller.abort()
    vi.advanceTimersByTime(WEB_GATE_TIMEOUT_MS);

    // Signal must now be aborted.
    expect(capturedSignal.aborted).toBe(true);

    // Emit close so finish() runs and process.exit is called.
    capturedProc.emit('close', null, 'SIGTERM');

    await runPromise;
    await exitCodePromise;
  });

  /**
   * Test 2: spawn receives controller.signal as the `signal` option.
   *
   * Strategy: capture spawnFn opts; assert that opts.signal is an AbortSignal
   * before the timeout fires (so it is not yet aborted at spawn time).
   */
  it('passes controller.signal as spawn signal option', async () => {
    setScenario({ target: '/tmp/abort-target' });
    const exitCodePromise = resolvingExitSpy();

    let capturedSpawnOpts = null;
    let capturedProc = null;
    let resolveSpawnCalled;
    const spawnCalledPromise = new Promise((resolve) => { resolveSpawnCalled = resolve; });

    const spawnFn = vi.fn((_cmd, _args, opts) => {
      capturedSpawnOpts = opts;
      capturedProc = makeMockProc();
      resolveSpawnCalled();
      return capturedProc;
    });

    const fakeFs = makeFakeFs();
    const runPromise = run({ fs: fakeFs, spawn: spawnFn });

    // Wait for spawn to be called.
    await spawnCalledPromise;

    // The signal option must be an AbortSignal and not yet aborted at spawn time.
    expect(capturedSpawnOpts.signal).toBeInstanceOf(AbortSignal);
    expect(capturedSpawnOpts.signal.aborted).toBe(false);

    // Let run() finish cleanly.
    capturedProc.emit('close', 0, null);
    await runPromise;
    await exitCodePromise;
  });

  /**
   * Test 3: clearTimeout is called when the subprocess exits before the deadline.
   *
   * The `finish()` function in runner.mjs calls clearTimeout(timeoutHandle) before
   * calling logStream.end(). This test verifies that the timer is cancelled on
   * a normal (code 0) exit so the AbortController never fires late.
   */
  it('clearTimeout is called when subprocess exits before timeout', async () => {
    setScenario({ target: '/tmp/abort-target' });
    const exitCodePromise = resolvingExitSpy();

    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    let capturedProc = null;
    let resolveSpawnCalled;
    const spawnCalledPromise = new Promise((resolve) => { resolveSpawnCalled = resolve; });

    const spawnFn = vi.fn((_cmd, _args, _opts) => {
      capturedProc = makeMockProc();
      resolveSpawnCalled();
      return capturedProc;
    });

    const fakeFs = makeFakeFs();
    const runPromise = run({ fs: fakeFs, spawn: spawnFn });

    // Wait for spawn to be called.
    await spawnCalledPromise;

    // Subprocess exits cleanly before timeout — clearTimeout must be called.
    capturedProc.emit('close', 0, null);

    await runPromise;
    await exitCodePromise;

    // clearTimeout must have been called at least once (the timeoutHandle).
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  /**
   * Test 4: exit code 2 is emitted when the process receives SIGTERM.
   *
   * This is the expected outcome when the AbortController fires — Node kills
   * the subprocess with SIGTERM, emitting close(null, 'SIGTERM').
   * The runner maps (signal === 'SIGTERM') → exit code 2.
   */
  it('exit code 2 emitted when SIGTERM received from abort', async () => {
    setScenario({ target: '/tmp/abort-target' });
    const exitCodePromise = resolvingExitSpy();

    let capturedProc = null;
    let resolveSpawnCalled;
    const spawnCalledPromise = new Promise((resolve) => { resolveSpawnCalled = resolve; });

    const spawnFn = vi.fn((_cmd, _args, _opts) => {
      capturedProc = makeMockProc();
      resolveSpawnCalled();
      return capturedProc;
    });

    const fakeFs = makeFakeFs();
    const runPromise = run({ fs: fakeFs, spawn: spawnFn });

    // Wait for spawn to be called.
    await spawnCalledPromise;

    // Simulate what Node does when the AbortSignal fires — subprocess closed with SIGTERM.
    capturedProc.emit('close', null, 'SIGTERM');

    await runPromise;
    expect(await exitCodePromise).toBe(2);
  });

  /**
   * Test 5: web-gate profile timeout boundary — signal is NOT aborted at
   * WEB_GATE_TIMEOUT_MS - 1 ms, but IS aborted at WEB_GATE_TIMEOUT_MS ms.
   *
   * This locks down the exact 120 000 ms value from test-profiles.json and
   * would fail if someone changed the profile's timeout_ms without updating tests.
   */
  it('honors web-gate profile timeout_ms (120 000 ms boundary)', async () => {
    setScenario({ target: '/tmp/abort-target' });
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

    // Wait for spawn to be called.
    await spawnCalledPromise;

    // One millisecond before the deadline: NOT aborted yet.
    vi.advanceTimersByTime(WEB_GATE_TIMEOUT_MS - 1);
    expect(capturedSignal.aborted).toBe(false);

    // Exactly at the deadline: aborted.
    vi.advanceTimersByTime(1);
    expect(capturedSignal.aborted).toBe(true);

    // Finish cleanly.
    capturedProc.emit('close', null, 'SIGTERM');
    await runPromise;
    await exitCodePromise;
  });
});
