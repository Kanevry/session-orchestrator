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
    expect(existsSync(`${lockPath}.acquire`)).toBe(false);
  });

  it.each([
    ['dead holder', JSON.stringify({ pid: DEAD_PID, host: hostname() })],
    ['live holder', JSON.stringify({ pid: process.pid, host: hostname() })],
    ['foreign holder', JSON.stringify({ pid: DEAD_PID, host: 'another-host' })],
    ['invalid body', 'not-json'],
  ])('fails closed without stealing an acquisition guard with %s', async (_label, guardBody) => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    const guardPath = `${lockPath}.acquire`;
    writeFileSync(guardPath, guardBody);
    const original = JSON.stringify({ pid: DEAD_PID, host: hostname(), acquiredAt: new Date().toISOString() });
    writeFileSync(lockPath, original);

    const attempt = tryAcquireFileLock(lockPath);
    expect(attempt.acquired).toBe(false);
    expect(attempt.reason).toBe('held');
    let called = false;
    const bounded = await withFileLock(lockPath, () => { called = true; }, { timeoutMs: 0 });
    expect(bounded).toMatchObject({ ok: false, reason: 'timeout' });
    expect(called).toBe(false);
    expect(readFileSync(guardPath, 'utf8')).toBe(guardBody);
    expect(readFileSync(lockPath, 'utf8')).toBe(original);
  });
});

describe('tryAcquireFileLock — acquisition guard cleanup', () => {
  it.each(['readFileSync', 'linkSync'])('releases its guard after a primary %s failure', (operation) => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    if (operation === 'readFileSync') {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: hostname() }));
    }
    const original = nodeFs.default[operation];
    const spy = vi.spyOn(nodeFs.default, operation).mockImplementation((...args) => {
      const target = args[operation === 'linkSync' ? 1 : 0];
      if (target === lockPath) throw Object.assign(new Error('fixture I/O error'), { code: 'EIO' });
      return original(...args);
    });

    const result = tryAcquireFileLock(lockPath);
    spy.mockRestore();
    expect(result).toMatchObject({ acquired: false, reason: 'fs-error' });
    expect(existsSync(`${lockPath}.acquire`)).toBe(false);
  });

  it.each(['warn', 'warnMessage'])('releases its guard when the %s callback throws', (callback) => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    const original = JSON.stringify({ pid: DEAD_PID, host: hostname() });
    writeFileSync(lockPath, original);
    expect(() => tryAcquireFileLock(lockPath, {
      [callback]: () => { throw new Error('fixture warning callback failed'); },
    })).toThrow('fixture warning callback failed');
    expect(existsSync(`${lockPath}.acquire`)).toBe(false);
    expect(readFileSync(lockPath, 'utf8')).toBe(original);
    expect(tryAcquireFileLock(lockPath, { warn: () => {} }).acquired).toBe(true);
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

  it.each([
    ['dead PID', JSON.stringify({ pid: DEAD_PID, host: hostname(), acquiredAt: new Date().toISOString() })],
    ['invalid body', 'not-json'],
  ])('serializes competing takeover attempts for a primary lock with %s', (_label, original) => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(lockPath, original);
    let competing;
    const result = tryAcquireFileLock(lockPath, {
      holder: 'first',
      warn: () => { competing = tryAcquireFileLock(lockPath, { holder: 'second', warn: () => {} }); },
    });

    expect(result.acquired).toBe(true);
    expect(competing).toMatchObject({ acquired: false, reason: 'held' });
    expect(readLockBody().holder).toBe('first');
    expect(existsSync(`${lockPath}.acquire`)).toBe(false);
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
    expect(existsSync(`${lockPath}.acquire`)).toBe(false);
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
    expect(existsSync(`${lockPath}.acquire`)).toBe(false);
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
    expect(existsSync(`${lockPath}.acquire`)).toBe(false);
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
    // #1285: the release pass takes the acquisition guard — a refusal must
    // still hand it back, or every later acquire reads `held` forever.
    expect(existsSync(`${lockPath}.acquire`)).toBe(false);
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
    // Releasing nothing must not create the lock's directory as a side effect.
    expect(existsSync(join(dir, 'sub'))).toBe(false);
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

describe('releaseFileLock — #1285 release is serialized with takeover', () => {
  // Bug: release read → matched → unlinked WITHOUT the `.acquire` guard that
  // takeover holds. An old holder paused between its read and its unlink let a
  // successor take over the expired lease; the old holder then deleted the
  // successor's lock and a third process acquired beside a live holder.
  const lease = (holder) => ({ staleCheck: 'mtime', staleMs: 10_000, holder, warn: () => {} });

  it('an old holder releasing mid-takeover never deletes the successor lock', () => {
    expect(tryAcquireFileLock(lockPath, lease('A')).acquired).toBe(true);
    const old = Date.now() / 1000 - 60;
    utimesSync(lockPath, old, old); // A's lease has expired
    const original = nodeFs.default.readFileSync;
    let successor;
    vi.spyOn(nodeFs.default, 'readFileSync').mockImplementation((...args) => {
      const raw = original(...args);
      // A has just read its own body; B tries to take over the expired lease.
      if (args[0] === lockPath && successor === undefined) {
        successor = tryAcquireFileLock(lockPath, lease('B'));
      }
      return raw;
    });

    const released = releaseFileLock(lockPath, { holder: 'A' });
    vi.restoreAllMocks();

    // Invariant: B acquired ⇒ the lock exists with holder B. Pre-fix B took
    // over, A then unlinked B's lock: { successorAcquired: true, lockExists: false }.
    expect({ successorAcquired: successor.acquired, lockExists: existsSync(lockPath) })
      .toEqual({ successorAcquired: false, lockExists: false });
    expect(successor.reason).toBe('held');
    expect(released).toEqual({ ok: true });
    expect(tryAcquireFileLock(lockPath, lease('B')).acquired).toBe(true);
    expect(readLockBody().holder).toBe('B');
  });

  it('returns busy within its budget on an abandoned guard and touches neither file', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    const guardPath = `${lockPath}.acquire`;
    const body = JSON.stringify({ pid: process.pid, host: hostname(), holder: 'A' });
    const guardBody = JSON.stringify({ pid: DEAD_PID, host: hostname(), kind: 'acquisition-guard' });
    writeFileSync(lockPath, body);
    writeFileSync(guardPath, guardBody);

    const started = Date.now();
    const result = releaseFileLock(lockPath, { holder: 'A', guardTimeoutMs: 30 });

    expect(result).toEqual({ ok: false, reason: 'busy' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(readFileSync(lockPath, 'utf8')).toBe(body);
    expect(readFileSync(guardPath, 'utf8')).toBe(guardBody);
  });

  it('removes its guard even when unlinking the primary lock fails', () => {
    tryAcquireFileLock(lockPath, { holder: 'A' });
    const original = nodeFs.default.unlinkSync;
    vi.spyOn(nodeFs.default, 'unlinkSync').mockImplementation((...args) => {
      if (args[0] === lockPath) throw Object.assign(new Error('fixture I/O error'), { code: 'EIO' });
      return original(...args);
    });

    const result = releaseFileLock(lockPath, { holder: 'A' });
    vi.restoreAllMocks();

    expect(result).toMatchObject({ ok: false, reason: 'fs-error' });
    expect(existsSync(`${lockPath}.acquire`)).toBe(false);
    expect(readLockBody().holder).toBe('A');
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

// ===========================================================================
// #1072 — host identity is normalised, not a raw os.hostname() string
// ===========================================================================
//
// Bug: os.hostname() flips spelling on a single machine (measured 2026-08-24:
// `Mac.home` and `Ferdinands-MacBook-Pro.local` ten minutes apart on the same
// host). `existing.host === os.hostname()` then reports `cross-host`, and
// cross-host bodies are NEVER stale by design — so a dead holder's lock
// survived for the full acquire timeout instead of being overridden.

describe('tryAcquireFileLock — #1072 host-spelling variants are same-host', () => {
  const localBase = hostname().replace(/\.(local|home|lan|localdomain)$/i, '');

  it('overrides a stale lock written under a SUFFIX VARIANT of this hostname', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: DEAD_PID, host: `${localBase}.home`, acquiredAt: new Date().toISOString() }),
    );
    const warn = vi.fn();

    const result = tryAcquireFileLock(lockPath, { staleCheck: 'pid', warn });

    // Before the fix this returned { acquired:false, reason:'held' } because
    // the body was classified cross-host and cross-host is never stale.
    expect(result.acquired).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(readLockBody().pid).toBe(process.pid);
  });

  it('still refuses to override a genuinely foreign host (PSA-003 invariant intact)', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: DEAD_PID, host: 'a-different-host', acquiredAt: new Date().toISOString() }),
    );

    const result = tryAcquireFileLock(lockPath, { staleCheck: 'pid' });

    expect(result.acquired).toBe(false);
    expect(result.reason).toBe('held');
    expect(readLockBody().pid).toBe(DEAD_PID);
  });

  it('writes an additive normalised host_id alongside the raw host', () => {
    const result = tryAcquireFileLock(lockPath, { staleCheck: 'pid' });
    expect(result.body.host).toBe(hostname());
    expect(result.body.host_id).toBe(localBase.toLowerCase());
    expect(readLockBody().host_id).toBe(localBase.toLowerCase());
  });
});

describe('releaseFileLock — #1072 owner-match survives a hostname flip', () => {
  const localBase = hostname().replace(/\.(local|home|lan|localdomain)$/i, '');

  it('releases our own lock recorded under a different spelling of this host', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, host: `${localBase}.LOCAL`, acquiredAt: new Date().toISOString() }),
    );

    // Before the fix: { ok:false, reason:'not-owner' } — a process could not
    // release the lock it had written itself.
    expect(releaseFileLock(lockPath)).toEqual({ ok: true });
    expect(existsSync(lockPath)).toBe(false);
  });

  it('still refuses to release a foreign host\'s lock', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, host: 'a-different-host', acquiredAt: new Date().toISOString() }),
    );

    expect(releaseFileLock(lockPath)).toEqual({ ok: false, reason: 'not-owner' });
    expect(existsSync(lockPath)).toBe(true);
  });

  it('prefers host_id over a divergent host, and an EMPTY host_id falls back instead of reading cross-host', () => {
    const writeBody = (body) => {
      mkdirSync(join(dir, 'sub'), { recursive: true });
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), ...body }),
      );
    };

    // host_id wins over a divergent raw host.
    writeBody({ host_id: localBase.toLowerCase(), host: 'a-different-host' });
    expect(releaseFileLock(lockPath)).toEqual({ ok: true });

    // The `??` bug: an empty host_id is neither null nor undefined, so `??`
    // kept it, hostnamesMatch('', …) was false, and a process could not
    // release the lock it had written itself.
    writeBody({ host_id: '', host: `${localBase}.home` });
    expect(releaseFileLock(lockPath)).toEqual({ ok: true });

    // The invariant the fallback must NOT widen.
    writeBody({ host_id: '', host: 'a-different-host' });
    expect(releaseFileLock(lockPath)).toEqual({ ok: false, reason: 'not-owner' });
    expect(existsSync(lockPath)).toBe(true);
  });
});
