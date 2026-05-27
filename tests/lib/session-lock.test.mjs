/**
 * tests/lib/session-lock.test.mjs
 *
 * Vitest suite for scripts/lib/session-lock.mjs (issue #330).
 *
 * Covers: acquire (success, active-lock contention, atomic write hygiene),
 * release (matching session_id, mismatched session_id, no lock present),
 * checkStale (missing lock, TTL-expired classification, cross-host),
 * forceAcquire (replaces existing, creates from scratch).
 *
 * P1.2 (#570) additions: acquire() with exclusivity-matrix integration —
 * backward-compat (omit activeSessions), matrix happy-paths, exclusivityClass
 * propagation, edge / error-handling cases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_TTL_HOURS,
  LOCK_PATH,
  readLock,
  acquire,
  forceAcquire,
  release,
  checkStale,
} from '@lib/session-lock.mjs';

// A PID guaranteed to be dead on any machine (kernel would never assign this).
const DEAD_PID = 999999;

let repoRoot;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'session-lock-test-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('DEFAULT_TTL_HOURS is 4', () => {
    expect(DEFAULT_TTL_HOURS).toBe(4);
  });

  it('LOCK_PATH is .orchestrator/session.lock', () => {
    expect(LOCK_PATH).toBe('.orchestrator/session.lock');
  });
});

// ---------------------------------------------------------------------------
// acquire
// ---------------------------------------------------------------------------

describe('acquire', () => {
  it('successful acquire on absent lock: returns ok=true with all required fields', () => {
    const result = acquire({ sessionId: 'sess-001', mode: 'feature', repoRoot });

    expect(result.ok).toBe(true);
    expect(result.lock.session_id).toBe('sess-001');
    expect(result.lock.mode).toBe('feature');
    expect(typeof result.lock.started_at).toBe('string');
    expect(typeof result.lock.pid).toBe('number');
    expect(typeof result.lock.host).toBe('string');
    expect(result.lock.ttl_hours).toBe(DEFAULT_TTL_HOURS);
  });

  it('lock file exists on disk after successful acquire', () => {
    acquire({ sessionId: 'sess-disk', mode: 'deep', repoRoot });

    const lockFile = join(repoRoot, LOCK_PATH);
    expect(existsSync(lockFile)).toBe(true);
  });

  it('second acquire on active lock returns ok=false with reason=active', () => {
    acquire({ sessionId: 'sess-first', mode: 'feature', repoRoot });
    const result = acquire({ sessionId: 'sess-second', mode: 'deep', repoRoot });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('active');
    expect(result.existingLock.session_id).toBe('sess-first');
  });

  it('second acquire does not modify the existing lock', () => {
    acquire({ sessionId: 'sess-original', mode: 'feature', repoRoot });
    const lockBefore = readLock({ repoRoot });

    acquire({ sessionId: 'sess-intruder', mode: 'deep', repoRoot });
    const lockAfter = readLock({ repoRoot });

    expect(lockAfter.session_id).toBe('sess-original');
    expect(lockAfter.started_at).toBe(lockBefore.started_at);
  });

  it('atomic write: no .tmp.* file remains in .orchestrator/ after a clean acquire', () => {
    acquire({ sessionId: 'sess-atomic', mode: 'feature', repoRoot });

    const orchDir = join(repoRoot, '.orchestrator');
    const entries = readdirSync(orchDir);
    const tmpFiles = entries.filter((e) => e.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// release
// ---------------------------------------------------------------------------

describe('release', () => {
  it('releases when session_id matches: file deleted, returns ok=true deleted=true', () => {
    acquire({ sessionId: 'sess-to-release', mode: 'feature', repoRoot });
    const lockFile = join(repoRoot, LOCK_PATH);
    expect(existsSync(lockFile)).toBe(true);

    const result = release({ sessionId: 'sess-to-release', repoRoot });

    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(true);
    expect(existsSync(lockFile)).toBe(false);
  });

  it('returns ok=true deleted=false with reason when session_id does not match', () => {
    acquire({ sessionId: 'sess-owner', mode: 'feature', repoRoot });
    const lockFile = join(repoRoot, LOCK_PATH);

    const result = release({ sessionId: 'sess-intruder', repoRoot });

    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(false);
    expect(typeof result.reason).toBe('string');
    // Lock file must still be intact
    expect(existsSync(lockFile)).toBe(true);
    expect(readLock({ repoRoot }).session_id).toBe('sess-owner');
  });

  it('returns ok=true deleted=false when no lock file is present', () => {
    const result = release({ sessionId: 'sess-nobody', repoRoot });

    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkStale
// ---------------------------------------------------------------------------

describe('checkStale', () => {
  it('returns exists=false with nulls when no lock file is present', () => {
    const result = checkStale({ repoRoot });

    expect(result.exists).toBe(false);
    expect(result.lock).toBeNull();
    expect(result.ageHours).toBeNull();
    expect(result.ttlExpired).toBe(false);
    expect(result.pidAlive).toBeNull();
    expect(result.host).toBeNull();
    expect(result.sameHost).toBe(false);
  });

  it('TTL expired classification: lock older than ttl_hours is marked ttlExpired=true', () => {
    // Write a lock with started_at 5 hours ago (ttl_hours=4 → expired).
    const fiveHoursAgo = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
    const staleLock = {
      session_id: 'sess-stale',
      started_at: fiveHoursAgo,
      mode: 'feature',
      pid: process.pid,
      host: hostname(),
      ttl_hours: 4,
    };
    const orchDir = join(repoRoot, '.orchestrator');
    mkdirSync(orchDir, { recursive: true });
    writeFileSync(join(orchDir, 'session.lock'), JSON.stringify(staleLock) + '\n');

    const result = checkStale({ repoRoot });

    expect(result.exists).toBe(true);
    expect(result.ttlExpired).toBe(true);
    expect(result.ageHours).toBeGreaterThan(4);
  });

  it('cross-host lock: sameHost=false and pidAlive=null', () => {
    const crossHostLock = {
      session_id: 'sess-remote',
      started_at: new Date().toISOString(),
      mode: 'deep',
      pid: process.pid,
      host: 'other-host-that-does-not-exist',
      ttl_hours: 4,
    };
    const orchDir = join(repoRoot, '.orchestrator');
    mkdirSync(orchDir, { recursive: true });
    writeFileSync(join(orchDir, 'session.lock'), JSON.stringify(crossHostLock) + '\n');

    const result = checkStale({ repoRoot });

    expect(result.exists).toBe(true);
    expect(result.sameHost).toBe(false);
    expect(result.pidAlive).toBeNull();
    expect(result.host).toBe('other-host-that-does-not-exist');
  });

  it('same-host lock with dead PID: pidAlive=false', () => {
    const lockWithDeadPid = {
      session_id: 'sess-dead-pid',
      started_at: new Date().toISOString(),
      mode: 'feature',
      pid: DEAD_PID,
      host: hostname(),
      ttl_hours: 4,
    };
    const orchDir = join(repoRoot, '.orchestrator');
    mkdirSync(orchDir, { recursive: true });
    writeFileSync(join(orchDir, 'session.lock'), JSON.stringify(lockWithDeadPid) + '\n');

    const result = checkStale({ repoRoot });

    expect(result.exists).toBe(true);
    expect(result.sameHost).toBe(true);
    expect(result.pidAlive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// forceAcquire
// ---------------------------------------------------------------------------

describe('forceAcquire', () => {
  it('replaces an existing lock and returns ok=true with replacedLock', () => {
    acquire({ sessionId: 'sess-old', mode: 'feature', repoRoot });

    const result = forceAcquire({ sessionId: 'sess-new', mode: 'deep', repoRoot });

    expect(result.ok).toBe(true);
    expect(result.lock.session_id).toBe('sess-new');
    expect(result.replacedLock.session_id).toBe('sess-old');
    expect(readLock({ repoRoot }).session_id).toBe('sess-new');
  });

  it('creates a lock when none exists and returns ok=true without replacedLock', () => {
    const result = forceAcquire({ sessionId: 'sess-fresh', mode: 'housekeeping', repoRoot });

    expect(result.ok).toBe(true);
    expect(result.lock.session_id).toBe('sess-fresh');
    expect(result.replacedLock).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// acquire() with exclusivity-matrix integration (P1.2 #570)
// ---------------------------------------------------------------------------

describe('acquire() with exclusivity-matrix integration (P1.2 #570)', () => {
  // ---------------------------------------------------------------------------
  // Backward-compat group (1 test)
  // ---------------------------------------------------------------------------

  it('acquire() with activeSessions omitted reproduces pre-P1.2 active reason unchanged', () => {
    // Establish a lock without activeSessions (pre-P1.2 call shape).
    acquire({ sessionId: 'sess-compat-first', mode: 'feature', repoRoot });

    // Second acquire also omits activeSessions — must still produce 'active'.
    const result = acquire({ sessionId: 'sess-compat-second', mode: 'deep', repoRoot });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('active');
    expect(result.existingLock.session_id).toBe('sess-compat-first');
  });

  // ---------------------------------------------------------------------------
  // Matrix happy-path group (3 tests)
  // ---------------------------------------------------------------------------

  it('acquire() returns active-incompatible-exclusive when housekeeping running and deep caller requests lock', () => {
    // activeSessions contains a housekeeping entry (exclusive class).
    // Caller is deep (parallel-ok class) → must be blocked.
    const activeSessions = [
      { mode: 'housekeeping', pid: process.pid, host: hostname(), sessionId: 'existing-hk-sess' },
    ];

    const result = acquire({ sessionId: 'new-deep-sess', mode: 'deep', activeSessions, repoRoot });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('active-incompatible-exclusive');
    expect(result.exclusivityClass).toBe('parallel-ok');
    expect(result.blockingSession.sessionId).toBe('existing-hk-sess');
    expect(result.blockingSession.mode).toBe('housekeeping');
    expect(Array.isArray(result.allActiveSessions)).toBe(true);
    expect(result.allActiveSessions).toHaveLength(1);
  });

  it('acquire() returns active-compatible-parallel when deep running and deep caller requests lock', () => {
    // activeSessions contains a deep entry (parallel-ok class).
    // Caller is also deep (parallel-ok class) → signals promotion-opportunity.
    const activeSessions = [
      { mode: 'deep', pid: process.pid, host: hostname(), sessionId: 'existing-deep-sess' },
    ];

    const result = acquire({ sessionId: 'new-deep-sess', mode: 'deep', activeSessions, repoRoot });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('active-compatible-parallel');
    expect(result.exclusivityClass).toBe('parallel-ok');
    expect(Array.isArray(result.allActiveSessions)).toBe(true);
    expect(result.allActiveSessions).toHaveLength(1);
  });

  it('acquire() returns active-readonly-bypass when deep running and discovery caller requests lock', () => {
    // activeSessions contains a deep entry (parallel-ok class).
    // Caller is discovery (always-ok class) → passes through regardless.
    const activeSessions = [
      { mode: 'deep', pid: process.pid, host: hostname(), sessionId: 'existing-deep-sess' },
    ];

    const result = acquire({ sessionId: 'new-discovery-sess', mode: 'discovery', activeSessions, repoRoot });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('active-readonly-bypass');
    expect(result.exclusivityClass).toBe('always-ok');
    expect(Array.isArray(result.allActiveSessions)).toBe(true);
    expect(result.allActiveSessions).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // exclusivityClass propagation group (2 tests)
  // ---------------------------------------------------------------------------

  it('acquire() success path includes exclusivityClass when activeSessions is provided and empty', () => {
    // Empty activeSessions: no conflicts, lock should be created.
    // success result must include exclusivityClass for the caller's mode (feature → parallel-ok).
    const result = acquire({ sessionId: 'fresh-feature-sess', mode: 'feature', activeSessions: [], repoRoot });

    expect(result.ok).toBe(true);
    expect(result.lock.session_id).toBe('fresh-feature-sess');
    expect(result.exclusivityClass).toBe('parallel-ok');
  });

  it('acquire() existing-lock active reason includes exclusivityClass when activeSessions is provided', () => {
    // Pre-establish a lock directly.
    acquire({ sessionId: 'first-hk-sess', mode: 'housekeeping', repoRoot });

    // Second acquire with activeSessions: [] — file lock is present (active reason),
    // but caller is housekeeping (exclusive class) so exclusivityClass should reflect caller.
    const result = acquire({ sessionId: 'second-hk-sess', mode: 'housekeeping', activeSessions: [], repoRoot });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('active');
    expect(result.existingLock.session_id).toBe('first-hk-sess');
    expect(result.exclusivityClass).toBe('exclusive');
  });

  // ---------------------------------------------------------------------------
  // Edge / error-handling group (2 tests)
  // ---------------------------------------------------------------------------

  it('acquire() with unknown mode does not throw and returns a structured result', () => {
    // classifyMode throws for unknown modes, but acquire() must catch that and
    // handle gracefully per I1's safe-handling spec (fall back to parallel-ok).
    // We pass activeSessions with a feature session to trigger matrix evaluation.
    const activeSessions = [
      { mode: 'feature', pid: process.pid, host: hostname(), sessionId: 'existing-feature-sess' },
    ];

    // Must not throw — acquire() is specified as no-throw.
    let result;
    expect(() => {
      result = acquire({ sessionId: 'new-unknown-sess', mode: 'unknown-mode-xyz', activeSessions, repoRoot });
    }).not.toThrow();

    // Result must be a structured object (not undefined or null).
    expect(typeof result).toBe('object');
    expect(result).not.toBeNull();
    // ok must be a boolean — shape is always present.
    expect(typeof result.ok).toBe('boolean');
  });

  it('acquire() does not crash when activeSessions entry has a live PID (normal usage)', () => {
    // discoverActiveSessions() filters dead PIDs before passing activeSessions.
    // Verify acquire() handles a normal live-PID activeSessions entry without throwing.
    // (housekeeping → exclusive, caller deep → parallel-ok → blocked)
    const activeSessions = [
      { mode: 'housekeeping', pid: process.pid, host: hostname(), sessionId: 'live-hk-sess' },
    ];

    let result;
    expect(() => {
      result = acquire({ sessionId: 'new-deep-sess-2', mode: 'deep', activeSessions, repoRoot });
    }).not.toThrow();

    // Shape must be structured.
    expect(typeof result).toBe('object');
    expect(result).not.toBeNull();
    expect(typeof result.ok).toBe('boolean');
    // The exclusive blocker must produce a failure (not a lock write).
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('active-incompatible-exclusive');
  });
});
