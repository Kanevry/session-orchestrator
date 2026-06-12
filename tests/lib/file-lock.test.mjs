/**
 * tests/lib/file-lock.test.mjs
 *
 * Vitest tests for scripts/lib/file-lock.mjs (issue #630 — the shared
 * tryAcquireFileLock / releaseFileLock / withFileLock primitive extracted from
 * the five copy-pasted lock implementations).
 *
 * Exports under test:
 *   tryAcquireFileLock, releaseFileLock, withFileLock, isPidAliveOnHost
 *
 * Strategy (no test-the-mock):
 *   - Every test runs against a fresh tmp dir, so no real lockfile is touched.
 *   - We assert on REAL on-disk lockfile contents and the SUT's structured
 *     result objects — not on mock interactions.
 *   - Stale-override is driven by writing a lock body with a dead PID (a numeric
 *     PID we know is not live) and asserting the SUT overrides it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as nodeFs from 'node:fs';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

import {
  tryAcquireFileLock,
  releaseFileLock,
  withFileLock,
  isPidAliveOnHost,
} from '@lib/file-lock.mjs';

// A numeric PID that is overwhelmingly unlikely to be live on the test host.
// Used to simulate a stale (dead-holder) lock for the override paths.
const DEAD_PID = 999999;

let dir;
let lockPath;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'file-lock-test-'));
  lockPath = join(dir, 'sub', 'test.lock');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Read + JSON.parse the lockfile body. */
function readLockBody() {
  return JSON.parse(readFileSync(lockPath, 'utf8'));
}

describe('tryAcquireFileLock — happy path', () => {
  it('creates the lockfile and returns the written body on first acquire', () => {
    const result = tryAcquireFileLock(lockPath, { staleCheck: 'pid' });

    expect(result.acquired).toBe(true);
    expect(result.body.pid).toBe(process.pid);
    expect(result.body.host).toBe(hostname());
    expect(typeof result.body.acquiredAt).toBe('string');
    expect(existsSync(lockPath)).toBe(true);

    const onDisk = readLockBody();
    expect(onDisk.pid).toBe(process.pid);
    expect(onDisk.host).toBe(hostname());
  });

  it('merges meta fields and a holder label into the body', () => {
    const result = tryAcquireFileLock(lockPath, {
      staleCheck: 'pid',
      meta: { kind: 'state' },
      holder: 'session-42',
    });

    expect(result.acquired).toBe(true);
    expect(result.body.kind).toBe('state');
    expect(result.body.holder).toBe('session-42');
    expect(readLockBody().holder).toBe('session-42');
  });

  it('writes a compact body with indent:null and a pretty body with indent:2', () => {
    const compactPath = join(dir, 'compact.lock');
    const prettyPath = join(dir, 'pretty.lock');

    tryAcquireFileLock(compactPath, { indent: null });
    tryAcquireFileLock(prettyPath, { indent: 2 });

    const compactRaw = readFileSync(compactPath, 'utf8');
    const prettyRaw = readFileSync(prettyPath, 'utf8');

    // Compact: single-line, no spaces after colons, no trailing newline.
    expect(compactRaw).not.toContain('\n');
    expect(compactRaw).toContain('"pid":');
    // Pretty: indented + trailing newline.
    expect(prettyRaw).toContain('\n');
    expect(prettyRaw).toContain('  "pid"');
  });
});

describe('tryAcquireFileLock — contention', () => {
  it('returns held with the existing body when a live holder owns the lock', () => {
    // First acquire (this process = a live holder).
    const first = tryAcquireFileLock(lockPath, { staleCheck: 'pid' });
    expect(first.acquired).toBe(true);

    // Second acquire while the live holder (us) still owns it → held.
    const second = tryAcquireFileLock(lockPath, { staleCheck: 'pid' });
    expect(second.acquired).toBe(false);
    expect(second.reason).toBe('held');
    expect(second.existing.pid).toBe(process.pid);
  });
});

describe('tryAcquireFileLock — stale-pid override', () => {
  it('overrides a same-host dead-PID lock and warns', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: DEAD_PID, host: hostname(), acquiredAt: new Date().toISOString() }),
      'utf8',
    );
    const warn = vi.fn();

    const result = tryAcquireFileLock(lockPath, { staleCheck: 'pid', warn });

    expect(result.acquired).toBe(true);
    expect(result.body.pid).toBe(process.pid);
    expect(readLockBody().pid).toBe(process.pid);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(`dead pid ${DEAD_PID}`);
  });

  it('overrides an unparseable lock body (existing=null in warnMessage)', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(lockPath, 'not-json-at-all', 'utf8');
    const warnMessage = vi.fn(() => 'override-msg');
    const warn = vi.fn();

    const result = tryAcquireFileLock(lockPath, { staleCheck: 'pid', warn, warnMessage });

    expect(result.acquired).toBe(true);
    expect(readLockBody().pid).toBe(process.pid);
    expect(warnMessage).toHaveBeenCalledWith('unparseable body', lockPath, null);
  });
});

describe('tryAcquireFileLock — cross-host never overridden (PSA-003)', () => {
  it('returns held for a dead-PID lock from a different host', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: DEAD_PID, host: 'some-other-host', acquiredAt: new Date().toISOString() }),
      'utf8',
    );
    const warn = vi.fn();

    const result = tryAcquireFileLock(lockPath, { staleCheck: 'pid', warn });

    // Cross-host → NEVER override, even though the PID is dead on this host.
    expect(result.acquired).toBe(false);
    expect(result.reason).toBe('held');
    expect(result.existing.host).toBe('some-other-host');
    expect(warn).not.toHaveBeenCalled();
    // The original cross-host lock body is untouched.
    expect(readLockBody().host).toBe('some-other-host');
  });
});

describe('tryAcquireFileLock — staleCheck:none', () => {
  it('never overrides a same-host dead-PID lock when staleCheck is none', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: DEAD_PID, host: hostname(), acquiredAt: new Date().toISOString() }),
      'utf8',
    );

    const result = tryAcquireFileLock(lockPath, { staleCheck: 'none' });

    expect(result.acquired).toBe(false);
    expect(result.reason).toBe('held');
    expect(readLockBody().pid).toBe(DEAD_PID);
  });
});

describe('tryAcquireFileLock — mtime staleCheck', () => {
  it('overrides a same-host lock older than staleMs by mtime', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(
      lockPath,
      // Live PID (us) so PID-staleCheck would NOT override — proves mtime drives it.
      JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString() }),
      'utf8',
    );
    // Backdate the mtime by 60s.
    const old = Date.now() / 1000 - 60;
    utimesSync(lockPath, old, old);

    const result = tryAcquireFileLock(lockPath, { staleCheck: 'mtime', staleMs: 10_000 });

    expect(result.acquired).toBe(true);
    expect(readLockBody().pid).toBe(process.pid);
  });

  it('returns held for a fresh-mtime same-host lock under staleMs', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString() }),
      'utf8',
    );

    const result = tryAcquireFileLock(lockPath, { staleCheck: 'mtime', staleMs: 60_000 });

    expect(result.acquired).toBe(false);
    expect(result.reason).toBe('held');
  });
});

describe('tryAcquireFileLock — signalVanished', () => {
  it('reproduces the vanished result shape via a stubbed read race', () => {
    // Create a live-holder lock so the SUT hits the EEXIST → read branch, then
    // simulate the lock vanishing between linkSync-EEXIST and the read by making
    // the first readFileSync throw ENOENT.
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString() }),
      'utf8',
    );

    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    // The primitive uses `import fs from 'node:fs'` (the default export object),
    // whose properties ARE configurable — spy there, not on the namespace.
    const spy = vi.spyOn(nodeFs.default, 'readFileSync').mockImplementationOnce(() => {
      throw enoent;
    });

    const result = tryAcquireFileLock(lockPath, { staleCheck: 'pid', signalVanished: true });

    expect(result.acquired).toBe(false);
    expect(result.reason).toBe('vanished');
    spy.mockRestore();
  });

  it('collapses the ENOENT-on-read race into held when signalVanished is false', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString() }),
      'utf8',
    );

    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    // The primitive uses `import fs from 'node:fs'` (the default export object),
    // whose properties ARE configurable — spy there, not on the namespace.
    const spy = vi.spyOn(nodeFs.default, 'readFileSync').mockImplementationOnce(() => {
      throw enoent;
    });

    const result = tryAcquireFileLock(lockPath, { staleCheck: 'pid', signalVanished: false });

    expect(result.acquired).toBe(false);
    expect(result.reason).toBe('held');
    expect(result.existing).toBe(null);
    spy.mockRestore();
  });
});

describe('releaseFileLock — owner guard vs unconditional', () => {
  it('unlinks the lock when the holder matches (ownerGuard)', () => {
    tryAcquireFileLock(lockPath, { holder: 'me' });

    const result = releaseFileLock(lockPath, { holder: 'me', ownerGuard: true });

    expect(result.ok).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('refuses to unlink when the holder does not match (ownerGuard)', () => {
    tryAcquireFileLock(lockPath, { holder: 'me' });

    const result = releaseFileLock(lockPath, { holder: 'someone-else', ownerGuard: true });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not-owner');
    expect(existsSync(lockPath)).toBe(true);
  });

  it('falls back to pid+host match when no holder is supplied', () => {
    // Body written by this process → pid+host match → release succeeds.
    tryAcquireFileLock(lockPath, {});

    const result = releaseFileLock(lockPath, { ownerGuard: true });

    expect(result.ok).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('returns not-found when the lockfile does not exist (ownerGuard)', () => {
    const result = releaseFileLock(lockPath, { holder: 'me', ownerGuard: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not-found');
  });

  it('unlinks unconditionally with ownerGuard:false even for a foreign holder', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: DEAD_PID, host: 'other-host', acquiredAt: new Date().toISOString(), holder: 'not-me' }),
      'utf8',
    );

    const result = releaseFileLock(lockPath, { ownerGuard: false });

    expect(result.ok).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('ignores ENOENT on the unconditional release path', () => {
    const result = releaseFileLock(lockPath, { ownerGuard: false });
    expect(result.ok).toBe(true);
  });
});

describe('withFileLock — acquire → fn → release', () => {
  it('runs fn while holding the lock and releases it afterwards', async () => {
    let lockExistedDuringFn = false;

    const result = await withFileLock(
      lockPath,
      (body) => {
        lockExistedDuringFn = existsSync(lockPath);
        expect(body.pid).toBe(process.pid);
        return 'value-42';
      },
      { timeoutMs: 1000, pollMs: 10, holder: 'me' },
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe('value-42');
    expect(lockExistedDuringFn).toBe(true);
    // Released in the finally.
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lock even when fn throws, and propagates the error', async () => {
    await expect(
      withFileLock(
        lockPath,
        () => {
          throw new Error('boom');
        },
        { timeoutMs: 1000, pollMs: 10, holder: 'me' },
      ),
    ).rejects.toThrow('boom');

    // Lock must NOT leak on the throwing path.
    expect(existsSync(lockPath)).toBe(false);
  });

  it('times out with reason:timeout when a live cross-host holder blocks acquire', async () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    // Cross-host live-looking holder → never overridden → acquire must time out.
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: DEAD_PID, host: 'other-host', acquiredAt: new Date().toISOString() }),
      'utf8',
    );

    const result = await withFileLock(lockPath, () => 'unreached', {
      timeoutMs: 0,
      pollMs: 5,
      staleCheck: 'pid',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('timeout');
    expect(result.existing.host).toBe('other-host');
  });

  it('supports the sync busy-wait variant (sync:true)', async () => {
    const result = await withFileLock(lockPath, () => 'sync-ok', {
      timeoutMs: 500,
      pollMs: 5,
      sync: true,
      holder: 'me',
    });

    expect(result.ok).toBe(true);
    expect(result.value).toBe('sync-ok');
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('isPidAliveOnHost', () => {
  it('returns true for the current process PID', () => {
    expect(isPidAliveOnHost(process.pid)).toBe(true);
  });

  it('returns false for a PID that does not exist', () => {
    expect(isPidAliveOnHost(DEAD_PID)).toBe(false);
  });
});
