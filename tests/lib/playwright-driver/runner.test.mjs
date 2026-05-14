/**
 * tests/lib/playwright-driver/runner.test.mjs
 *
 * Unit tests for scripts/lib/playwright-driver/runner.mjs.
 *
 * The runner always terminates via process.exit(). Tests capture the exit code
 * using one of two spy strategies:
 *
 *   THROWING spy (early exits only — before spawn is called):
 *     The spy throws `Error('exit:N')` so the runner's async function rejects
 *     and `await run()` unwinds cleanly. Used when process.exit fires before
 *     spawn is ever reached, so no ChildProcess leaks occur.
 *
 *   RESOLVING spy (late exits — after spawn emits close/error):
 *     The spy does NOT throw; instead it resolves a shared promise with the
 *     exit code. run() itself resolves to undefined; the test awaits the
 *     exitCodePromise for the mapped exit code.
 *
 * DI seams (per-test opts injection — no vi.mock per project convention):
 *   opts.spawn — fake ChildProcess factory
 *   opts.fs    — fake sync fs subset
 *
 * All expected values are hardcoded literals.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------

import run from '../../../scripts/lib/playwright-driver/runner.mjs';

// ---------------------------------------------------------------------------
// Fake Writable stream (satisfies proc.stdout.pipe(logStream))
// ---------------------------------------------------------------------------

function makeFakeWritable() {
  return new Writable({ write(_chunk, _enc, cb) { cb(); } });
}

// ---------------------------------------------------------------------------
// Fake ChildProcess factory
// ---------------------------------------------------------------------------

/**
 * @param {{ exitCode?: number|null, signal?: string|null, errorMsg?: string }} [opts]
 */
function makeProc({ exitCode = 0, signal = null, errorMsg = null } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.stdout.push(null);
  proc.stderr.push(null);
  setImmediate(() => {
    if (errorMsg !== null) {
      proc.emit('error', new Error(errorMsg));
    } else {
      proc.emit('close', exitCode, signal);
    }
  });
  return proc;
}

// ---------------------------------------------------------------------------
// Fake fs factory
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Spy factories
// ---------------------------------------------------------------------------

/** For early exits (before spawn): spy throws so run() rejects cleanly. */
function throwingExitSpy() {
  return vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`exit:${code}`);
  });
}

/** For late exits (after spawn emits close): spy resolves a promise. */
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

function setScenario({ runDir, profile, target, dryRun } = {}) {
  process.argv = process.argv.slice(0, 2);
  process.env.RUN_DIR = runDir ?? '/tmp/run-001';
  process.env.PROFILE = profile ?? 'web-gate';
  if (target !== undefined) process.env.TARGET = target;
  else delete process.env.TARGET;
  if (dryRun) process.argv.push('--dry-run');
}

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
// Tests 1–2: module contract
// ---------------------------------------------------------------------------

describe('runner module contract', () => {
  it('imports without throwing', () => {
    expect(run).toBeDefined();
  });

  it('default export is a function', () => {
    expect(typeof run).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Tests 3–4: missing/invalid required args → early exit 2
// (These paths are reached before spawn; throwing spy is safe to use.)
// ---------------------------------------------------------------------------

describe('runner missing or invalid required args', () => {
  it('exits 2 when PROFILE is absent (profileName is empty, never reaches spawn)', async () => {
    // runDir resolves to cwd() when empty, which is truthy, so only the
    // profileName check triggers here.
    process.argv = process.argv.slice(0, 2);
    process.env.RUN_DIR = '/tmp/run-no-profile';
    delete process.env.PROFILE;

    const spy = throwingExitSpy();
    await expect(run({ fs: makeFakeFs(), spawn: vi.fn() })).rejects.toThrow('exit:2');
    expect(spy).toHaveBeenCalledWith(2);
  });

  it('exits 2 when profile name does not exist in the registry (getProfile fails)', async () => {
    setScenario({ profile: 'nonexistent-profile-xyz' });

    const spy = throwingExitSpy();
    await expect(run({ fs: makeFakeFs(), spawn: vi.fn() })).rejects.toThrow('exit:2');
    expect(spy).toHaveBeenCalledWith(2);
  });
});

// ---------------------------------------------------------------------------
// Tests 5–6: dry-run mode → early exit 0, spawn never called
// (dry-run exits before spawn; throwing spy is safe.)
// ---------------------------------------------------------------------------

describe('runner dry-run mode', () => {
  it('exits 0 in dry-run mode', async () => {
    setScenario({ dryRun: true });

    const spy = throwingExitSpy();
    await expect(run({ fs: makeFakeFs(), spawn: vi.fn() })).rejects.toThrow('exit:0');
    expect(spy).toHaveBeenCalledWith(0);
  });

  it('does not call spawn in dry-run mode', async () => {
    setScenario({ dryRun: true });

    throwingExitSpy();
    const spawnFn = vi.fn();
    await expect(run({ fs: makeFakeFs(), spawn: spawnFn })).rejects.toThrow('exit:0');
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests 7–10: spawn exit-code mapping → late exits
// (process.exit fires inside logStream.end() callback after run() resolves;
// using the resolving spy to capture the code.)
// ---------------------------------------------------------------------------

describe('runner spawn exit-code mapping', () => {
  it('exits 0 when spawned subprocess exits with code 0', async () => {
    setScenario({ target: '/tmp/fake-target' });
    const exitCodePromise = resolvingExitSpy();
    const spawnFn = vi.fn(() => makeProc({ exitCode: 0 }));
    const fakeFs = makeFakeFs({ existsResults: { '/tmp/fake-target/package.json': false } });
    await run({ fs: fakeFs, spawn: spawnFn });
    expect(await exitCodePromise).toBe(0);
  });

  it('exits 1 when spawned subprocess exits with code 1', async () => {
    setScenario({ target: '/tmp/fake-target' });
    const exitCodePromise = resolvingExitSpy();
    const spawnFn = vi.fn(() => makeProc({ exitCode: 1 }));
    const fakeFs = makeFakeFs({ existsResults: { '/tmp/fake-target/package.json': false } });
    await run({ fs: fakeFs, spawn: spawnFn });
    expect(await exitCodePromise).toBe(1);
  });

  it('exits 2 when spawned subprocess exits with code 2', async () => {
    setScenario({ target: '/tmp/fake-target' });
    const exitCodePromise = resolvingExitSpy();
    const spawnFn = vi.fn(() => makeProc({ exitCode: 2 }));
    const fakeFs = makeFakeFs({ existsResults: { '/tmp/fake-target/package.json': false } });
    await run({ fs: fakeFs, spawn: spawnFn });
    expect(await exitCodePromise).toBe(2);
  });

  it('exits 2 when spawned subprocess is killed with SIGTERM (close emits null code)', async () => {
    setScenario({ target: '/tmp/fake-target' });
    const exitCodePromise = resolvingExitSpy();
    const spawnFn = vi.fn(() => makeProc({ exitCode: null, signal: 'SIGTERM' }));
    const fakeFs = makeFakeFs({ existsResults: { '/tmp/fake-target/package.json': false } });
    await run({ fs: fakeFs, spawn: spawnFn });
    expect(await exitCodePromise).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test 11: spawn 'error' event → late exit 2
// ---------------------------------------------------------------------------

describe('runner spawn error event', () => {
  it('exits 2 when the spawned subprocess emits an error event', async () => {
    setScenario({ target: '/tmp/fake-target' });
    const exitCodePromise = resolvingExitSpy();
    const spawnFn = vi.fn(() => makeProc({ errorMsg: 'spawn error' }));
    const fakeFs = makeFakeFs({ existsResults: { '/tmp/fake-target/package.json': false } });
    await run({ fs: fakeFs, spawn: spawnFn });
    expect(await exitCodePromise).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests 12–13: axe-core presence check
// ---------------------------------------------------------------------------

describe('runner axe-core presence check', () => {
  it('logs skip message when target package.json lacks @axe-core/playwright', async () => {
    setScenario({ target: '/tmp/fake-target' });
    const exitCodePromise = resolvingExitSpy();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const spawnFn = vi.fn(() => makeProc({ exitCode: 0 }));
    const pkgJson = JSON.stringify({ dependencies: { react: '18.0.0' } });
    const fakeFs = makeFakeFs({ pkgJsonContent: pkgJson });
    await run({ fs: fakeFs, spawn: spawnFn });
    await exitCodePromise;
    const logOutput = consoleSpy.mock.calls.flat().join(' ');
    expect(logOutput).toContain('axe-violations: skipped');
  });

  it('does NOT log skip message when @axe-core/playwright is in devDependencies', async () => {
    setScenario({ target: '/tmp/fake-target' });
    const exitCodePromise = resolvingExitSpy();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const spawnFn = vi.fn(() => makeProc({ exitCode: 0 }));
    const pkgJson = JSON.stringify({
      devDependencies: { '@axe-core/playwright': '^4.9.0' },
    });
    const fakeFs = makeFakeFs({ pkgJsonContent: pkgJson });
    await run({ fs: fakeFs, spawn: spawnFn });
    await exitCodePromise;
    const logOutput = consoleSpy.mock.calls.flat().join(' ');
    expect(logOutput).not.toContain('axe-violations: skipped');
  });
});

// ---------------------------------------------------------------------------
// Test 14: tilde expansion
// ---------------------------------------------------------------------------

describe('runner tilde expansion', () => {
  it('expands ~/my-app in --target to $HOME/my-app before passing to spawn', async () => {
    process.argv = process.argv.slice(0, 2).concat(['--target', '~/my-app']);
    process.env.RUN_DIR = '/tmp/run-tilde';
    process.env.PROFILE = 'web-gate';
    delete process.env.TARGET;

    const exitCodePromise = resolvingExitSpy();
    let capturedCwd = null;
    const spawnFn = vi.fn((_cmd, _args, spawnOpts) => {
      capturedCwd = spawnOpts.cwd;
      return makeProc({ exitCode: 0 });
    });
    const fakeFs = makeFakeFs({ existsResults: {} });
    await run({ fs: fakeFs, spawn: spawnFn });
    await exitCodePromise;
    expect(capturedCwd).toBe(path.join(os.homedir(), 'my-app'));
  });
});

// ---------------------------------------------------------------------------
// Tests 15–16: run-dir creation
// ---------------------------------------------------------------------------

describe('runner run-dir creation', () => {
  it('calls mkdirSync with { recursive: true } for the artifact subdirectory', async () => {
    setScenario({ target: '/tmp/fake-target' });
    const exitCodePromise = resolvingExitSpy();
    const spawnFn = vi.fn(() => makeProc({ exitCode: 0 }));
    const fakeFs = makeFakeFs({ existsResults: { '/tmp/fake-target/package.json': false } });
    await run({ fs: fakeFs, spawn: spawnFn });
    await exitCodePromise;
    const recursiveCalls = fakeFs._mkdirCalls.filter(
      (c) => c.opts && c.opts.recursive === true,
    );
    expect(recursiveCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('creates a directory whose path includes "test-results"', async () => {
    setScenario({ target: '/tmp/fake-target' });
    const exitCodePromise = resolvingExitSpy();
    const spawnFn = vi.fn(() => makeProc({ exitCode: 0 }));
    const fakeFs = makeFakeFs({ existsResults: { '/tmp/fake-target/package.json': false } });
    await run({ fs: fakeFs, spawn: spawnFn });
    await exitCodePromise;
    const dirsCreated = fakeFs._mkdirCalls.map((c) => c.dir);
    const hasTestResults = dirsCreated.some((d) => d.includes('test-results'));
    expect(hasTestResults).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 17: exit_code file written with the resolved exit code
// ---------------------------------------------------------------------------

describe('runner exit_code file', () => {
  it('writes "0" to the exit_code file when subprocess exits 0', async () => {
    setScenario({ target: '/tmp/fake-target' });
    const exitCodePromise = resolvingExitSpy();
    const spawnFn = vi.fn(() => makeProc({ exitCode: 0 }));
    const fakeFs = makeFakeFs({ existsResults: { '/tmp/fake-target/package.json': false } });
    await run({ fs: fakeFs, spawn: spawnFn });
    await exitCodePromise;
    const exitCodeEntries = Object.entries(fakeFs._writtenFiles).filter(([k]) =>
      k.endsWith('exit_code'),
    );
    expect(exitCodeEntries).toHaveLength(1);
    expect(exitCodeEntries[0][1]).toBe('0');
  });
});
