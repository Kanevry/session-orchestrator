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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
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
  isLockLive,
  updateHeartbeat,
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
// acquire() — TOCTOU-safe create-or-fail fresh write (#590 Item 2)
// ---------------------------------------------------------------------------
//
// The fresh-acquire write path migrated from writeLockAtomic (tmp + rename,
// last-writer-wins) to createSessionLockExclusive (tmp + linkSync, create-or-
// fail). These tests pin the deterministic, single-process behaviour of the new
// path: a clean create writes correct content and leaves no residue; the
// EEXIST-loser classification reuses the same active/stale logic as the
// up-front readLock() branch. The cross-process race test (two acquirers, one
// wins) is intentionally NOT here — it is owned by a later wave.

describe('acquire() — TOCTOU-safe create-or-fail fresh write (#590 Item 2)', () => {
  it('fresh acquire writes the full lock body via the create path', () => {
    const result = acquire({ sessionId: 'sess-create', mode: 'feature', repoRoot });

    expect(result.ok).toBe(true);

    // The on-disk content must be the complete, parseable lock — proving the
    // tmp file was hardlinked into place with its full body (not an empty
    // O_EXCL placeholder).
    const lockFile = join(repoRoot, LOCK_PATH);
    const raw = readFileSync(lockFile, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.session_id).toBe('sess-create');
    expect(parsed.mode).toBe('feature');
    expect(parsed.ttl_hours).toBe(DEFAULT_TTL_HOURS);
  });

  it('no .session.lock.create.tmp.* residue remains after a clean fresh acquire', () => {
    acquire({ sessionId: 'sess-create-hygiene', mode: 'deep', repoRoot });

    const orchDir = join(repoRoot, '.orchestrator');
    const residue = readdirSync(orchDir).filter((e) => e.startsWith('.session.lock.create.tmp.'));
    expect(residue).toHaveLength(0);
  });

  it('EEXIST loser path: a second acquire over a live lock returns reason=active', () => {
    // First acquire wins the create. Second acquire sees the present lock; the
    // result must be the classified 'active' reason regardless of which branch
    // (up-front readLock or create-race loser) produced it.
    acquire({ sessionId: 'sess-winner', mode: 'feature', repoRoot });
    const result = acquire({ sessionId: 'sess-loser', mode: 'deep', repoRoot });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('active');
    expect(result.existingLock.session_id).toBe('sess-winner');
  });

  it('EEXIST loser path: a second acquire over a dead-PID lock returns reason=stale-pid-dead', () => {
    // Pre-write a same-host lock whose PID is guaranteed dead.
    const deadLock = {
      session_id: 'sess-dead-winner',
      started_at: new Date().toISOString(),
      last_heartbeat: new Date().toISOString(),
      mode: 'feature',
      pid: DEAD_PID,
      host: hostname(),
      ttl_hours: 4,
    };
    const orchDir = join(repoRoot, '.orchestrator');
    mkdirSync(orchDir, { recursive: true });
    writeFileSync(join(orchDir, 'session.lock'), JSON.stringify(deadLock) + '\n');

    const result = acquire({ sessionId: 'sess-new', mode: 'deep', repoRoot });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('stale-pid-dead');
    expect(result.existingLock.session_id).toBe('sess-dead-winner');
  });

  it('forceAcquire still overwrites an existing lock (NOT migrated to create-or-fail)', () => {
    // Regression guard: the create-or-fail migration must be scoped to the
    // fresh-acquire path only. forceAcquire MUST still replace a present lock.
    acquire({ sessionId: 'sess-old-fa', mode: 'feature', repoRoot });
    const result = forceAcquire({ sessionId: 'sess-new-fa', mode: 'deep', repoRoot });

    expect(result.ok).toBe(true);
    expect(result.lock.session_id).toBe('sess-new-fa');
    expect(result.replacedLock.session_id).toBe('sess-old-fa');
    expect(readLock({ repoRoot }).session_id).toBe('sess-new-fa');
  });

  it('updateHeartbeat still rewrites an existing lock (NOT migrated to create-or-fail)', () => {
    // Regression guard: updateHeartbeat overwrites an already-owned lock, so it
    // must keep using the rename-based path — a create-or-fail there would
    // EEXIST and fail to refresh the heartbeat.
    acquire({ sessionId: 'sess-hb', mode: 'deep', repoRoot });
    const ok = updateHeartbeat({ sessionId: 'sess-hb', repoRoot });
    expect(ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// acquire() — quiet unknown-mode option (#592 MED-2)
// ---------------------------------------------------------------------------

describe('acquire() — quiet unknown-mode option (#592 MED-2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('default acquire() warns to console.warn on an unknown mode', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = acquire({ sessionId: 'sess-warn', mode: 'totally-unknown-mode', repoRoot });

    expect(result.ok).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('unknown mode "totally-unknown-mode"');
  });

  it('acquire({ quiet: true }) suppresses the unknown-mode warn but still acquires', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = acquire({ sessionId: 'sess-quiet', mode: 'totally-unknown-mode', quiet: true, repoRoot });

    expect(result.ok).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('quiet acquire() still persists the RAW unknown mode on the lock body', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = acquire({ sessionId: 'sess-quiet-mode', mode: 'my-custom-mode', quiet: true, repoRoot });

    expect(result.ok).toBe(true);
    expect(result.lock.mode).toBe('my-custom-mode');
    expect(readLock({ repoRoot }).mode).toBe('my-custom-mode');
  });

  it('quiet acquire() defaults exclusivityClass to parallel-ok for an unknown mode', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Pass an empty activeSessions so the success result carries exclusivityClass.
    const result = acquire({
      sessionId: 'sess-quiet-class',
      mode: 'another-unknown-mode',
      quiet: true,
      activeSessions: [],
      repoRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.exclusivityClass).toBe('parallel-ok');
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

  // ---------------------------------------------------------------------------
  // EARS ordering invariant group (Gap 3, #579) — "exclusive shall win ordering"
  // ---------------------------------------------------------------------------
  //
  // PRD §3.A P1 "Unwanted behaviour": "If a parallel-ok and an exclusive session
  // call acquire() simultaneously, then the exclusive shall win ordering."
  //
  // The impl serialises concurrent acquire() calls via withStateMdLock; whichever
  // runs first records its entry in activeSessions, and the second caller observes
  // that entry through the exclusivity-matrix loop. The post-serialisation states
  // are deterministic, so we construct the activeSessions array directly to model
  // each of the two possible orderings (no real timing / sleep races). The
  // load-bearing invariant is the ASYMMETRY between the two orderings: an exclusive
  // entry blocks a parallel-ok caller, but a parallel-ok entry never blocks an
  // exclusive caller — in both orderings the exclusive session wins.

  it('exclusive-wins ordering: parallel-ok caller is blocked when an exclusive session is already active', () => {
    // Ordering A — the exclusive session won the mutex first, so the parallel-ok
    // (deep) caller observes the exclusive (housekeeping) entry and must lose.
    const activeSessions = [
      { mode: 'housekeeping', pid: process.pid, host: hostname(), sessionId: 'won-exclusive-sess' },
    ];

    const result = acquire({ sessionId: 'lost-deep-sess', mode: 'deep', activeSessions, repoRoot });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('active-incompatible-exclusive');
    expect(result.exclusivityClass).toBe('parallel-ok');
    expect(result.blockingSession.sessionId).toBe('won-exclusive-sess');
    expect(result.blockingSession.mode).toBe('housekeeping');
  });

  it('exclusive-wins ordering: exclusive caller is NOT blocked by an already-active parallel-ok session', () => {
    // Ordering B — the parallel-ok (deep) session won the mutex first, so the
    // exclusive (housekeeping) caller observes the parallel-ok entry. The matrix
    // must NOT block the exclusive caller on a parallel-ok entry; the exclusive
    // caller falls through to the local-lock check, finds no file lock in this
    // fresh repoRoot, and acquires the lock. This is the asymmetric counterpart
    // to Ordering A — a parallel-ok entry never blocks an exclusive caller.
    const activeSessions = [
      { mode: 'deep', pid: process.pid, host: hostname(), sessionId: 'won-parallel-sess' },
    ];

    const result = acquire({ sessionId: 'exclusive-caller-sess', mode: 'housekeeping', activeSessions, repoRoot });

    expect(result.ok).toBe(true);
    expect(result.lock.session_id).toBe('exclusive-caller-sess');
    expect(result.lock.mode).toBe('housekeeping');
    expect(result.exclusivityClass).toBe('exclusive');
    // It must NOT have resolved as the parallel-compatible promotion path.
    expect(result.reason).toBeUndefined();
  });

  it('exclusive-wins ordering: an exclusive caller is blocked by another active exclusive session (no two exclusives)', () => {
    // Reinforces the ordering invariant from the exclusive caller's side: two
    // exclusive sessions can never both win. The exclusive (memory-cleanup) caller
    // observes an active exclusive (housekeeping) entry and must be blocked, with
    // the housekeeping session named as the deterministic winner.
    const activeSessions = [
      { mode: 'housekeeping', pid: process.pid, host: hostname(), sessionId: 'first-exclusive-sess' },
    ];

    const result = acquire({ sessionId: 'second-exclusive-sess', mode: 'memory-cleanup', activeSessions, repoRoot });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('active-incompatible-exclusive');
    expect(result.exclusivityClass).toBe('exclusive');
    expect(result.blockingSession.sessionId).toBe('first-exclusive-sess');
    expect(result.blockingSession.mode).toBe('housekeeping');
  });
});

// ---------------------------------------------------------------------------
// Schema v2 — last_heartbeat + semantic_session_id (Epic #583, W2-I3)
// ---------------------------------------------------------------------------

describe('Schema v2 — last_heartbeat + semantic_session_id (Epic #583, W2-I3)', () => {
  // L1: acquire() writes a lock with last_heartbeat == started_at initially.
  it('L1: acquire() writes a lock with last_heartbeat === started_at', () => {
    const result = acquire({ sessionId: 'sess-L1', mode: 'feature', repoRoot });

    expect(result.ok).toBe(true);
    expect(typeof result.lock.last_heartbeat).toBe('string');
    expect(result.lock.last_heartbeat).toBe(result.lock.started_at);

    // Persisted to disk identically.
    const onDisk = readLock({ repoRoot });
    expect(onDisk.last_heartbeat).toBe(onDisk.started_at);
  });

  // L2: updateHeartbeat() updates ONLY last_heartbeat, preserving other fields.
  // AP1 (#591): replaced a wall-clock `setTimeout(r, 5)` sleep with fake timers
  // so the test is deterministic on contended CI. acquire() + updateHeartbeat()
  // are SYNCHRONOUS, so the body is sync (no async). nowIso() resolves to
  // `new Date().toISOString()`, which fake timers control via setSystemTime →
  // advancing the clock guarantees a strictly-later heartbeat without sleeping.
  it('L2: updateHeartbeat() updates only last_heartbeat, preserving other fields', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-27T12:00:00.000Z'));
      acquire({ sessionId: 'sess-L2', mode: 'deep', repoRoot });
      const before = readLock({ repoRoot });

      // Advance the controlled clock so nowIso() yields a strictly-later stamp.
      vi.advanceTimersByTime(10);

      const ok = updateHeartbeat({ sessionId: 'sess-L2', repoRoot });
      expect(ok).toBe(true);

      const after = readLock({ repoRoot });

      // last_heartbeat advanced (started_at + 10ms == 2026-05-27T12:00:00.010Z).
      expect(after.last_heartbeat).not.toBe(before.last_heartbeat);
      expect(after.last_heartbeat).toBe('2026-05-27T12:00:00.010Z');
      expect(Date.parse(after.last_heartbeat))
        .toBeGreaterThanOrEqual(Date.parse(before.last_heartbeat));

      // All OTHER fields preserved.
      expect(after.session_id).toBe(before.session_id);
      expect(after.started_at).toBe(before.started_at);
      expect(after.mode).toBe(before.mode);
      expect(after.pid).toBe(before.pid);
      expect(after.host).toBe(before.host);
      expect(after.ttl_hours).toBe(before.ttl_hours);
    } finally {
      vi.useRealTimers();
    }
  });

  // L3: updateHeartbeat() refuses to update a lock owned by a different session_id.
  it('L3: updateHeartbeat() refuses to update a lock owned by a different session_id', () => {
    acquire({ sessionId: 'sess-L3-owner', mode: 'feature', repoRoot });
    const before = readLock({ repoRoot });

    const ok = updateHeartbeat({ sessionId: 'sess-L3-intruder', repoRoot });
    expect(ok).toBe(false);

    // Lock content unchanged — same heartbeat as before.
    const after = readLock({ repoRoot });
    expect(after.session_id).toBe('sess-L3-owner');
    expect(after.last_heartbeat).toBe(before.last_heartbeat);
  });

  // H2 (#591) — updateHeartbeat() against a repo with NO lock file. Exercises
  // the `if (existing === null) return false` early-return at line ~624 that
  // every other test bypasses (they acquire() first). The `repoRoot` here is
  // the fresh mkdtemp from beforeEach with no prior acquire → readLock() is
  // null → must return false and write nothing.
  // Mutation-falsification: if the null-guard were removed, buildLock would
  // throw / writeLockAtomic would create a lock and `readLock` would be non-null,
  // failing both assertions below.
  it('H2: updateHeartbeat() on a repo with no lock returns false and writes no lock', () => {
    const result = updateHeartbeat({ sessionId: 'sess-no-lock', repoRoot });

    expect(result).toBe(false);
    // Nothing was written — readLock stays null.
    expect(readLock({ repoRoot })).toBeNull();
  });

  // L4: Old-schema lock (no last_heartbeat) is read with last_heartbeat == started_at.
  it('L4: old-schema v1 lock (no last_heartbeat) is normalised with last_heartbeat = started_at', () => {
    // Write a v1 lock manually (no last_heartbeat field).
    const v1Lock = {
      session_id: 'sess-L4',
      started_at: '2026-05-27T11:04:39.516Z',
      mode: 'deep',
      pid: process.pid,
      host: hostname(),
      ttl_hours: 4,
      // last_heartbeat intentionally absent — pre-#583 schema v1.
    };
    const orchDir = join(repoRoot, '.orchestrator');
    mkdirSync(orchDir, { recursive: true });
    writeFileSync(join(orchDir, 'session.lock'), JSON.stringify(v1Lock) + '\n');

    const lock = readLock({ repoRoot });
    expect(lock).not.toBeNull();
    expect(lock.last_heartbeat).toBe(lock.started_at);
    expect(lock.started_at).toBe('2026-05-27T11:04:39.516Z');
  });

  // Bonus: isLockLive helper contract.
  it('isLockLive: fresh heartbeat within ttl_hours returns true', () => {
    const lock = {
      session_id: 'x',
      started_at: '2026-05-27T11:04:39.516Z',
      last_heartbeat: new Date().toISOString(),
      mode: 'deep',
      pid: process.pid,
      host: hostname(),
      ttl_hours: 4,
    };
    expect(isLockLive(lock)).toBe(true);
  });

  it('isLockLive: heartbeat older than ttl_hours returns false', () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
    const lock = {
      session_id: 'x',
      started_at: fiveHoursAgo,
      last_heartbeat: fiveHoursAgo,
      mode: 'deep',
      pid: process.pid,
      host: hostname(),
      ttl_hours: 4,
    };
    expect(isLockLive(lock)).toBe(false);
  });

  // H1 (#591) — exact-TTL boundary. isLockLive uses STRICT `<` (line ~253:
  // `(nowMs - heartbeatMs) < ttlMs`), so a heartbeat that is EXACTLY ttl_hours
  // old must be reported DEAD (false), and one 1ms younger must be LIVE (true).
  // The function takes an explicit `nowMs`, so this is fully deterministic — no
  // fake timers. Hardcoded ISO heartbeat; the expiry edge is the heartbeat ms
  // plus the exact ttl window so the boundary is reproduced precisely.
  // Mutation-falsification: if `<` were reverted to `<=`, the exact-edge case
  // would flip to `true` and the first assertion below would FAIL.
  it('H1: isLockLive at exactly ttl_hours old returns false (strict <), 1ms under returns true', () => {
    const heartbeatIso = '2026-05-27T12:00:00.000Z';
    const heartbeatMs = Date.parse(heartbeatIso); // hardcoded reference epoch
    const ttlHours = 4;
    const ttlMs = ttlHours * 3600 * 1000; // 14_400_000
    const lock = {
      session_id: 'x',
      started_at: heartbeatIso,
      last_heartbeat: heartbeatIso,
      mode: 'deep',
      pid: process.pid,
      host: hostname(),
      ttl_hours: ttlHours,
    };

    // Exactly ttl_hours later: (nowMs - heartbeatMs) === ttlMs → strict < is false.
    expect(isLockLive(lock, heartbeatMs + ttlMs)).toBe(false);

    // 1ms before the exact edge: (nowMs - heartbeatMs) === ttlMs - 1 → live.
    expect(isLockLive(lock, heartbeatMs + ttlMs - 1)).toBe(true);

    // 1ms past the exact edge: clearly expired.
    expect(isLockLive(lock, heartbeatMs + ttlMs + 1)).toBe(false);
  });

  // semantic_session_id propagation: acquire() persists it when provided.
  it('acquire() persists semantic_session_id when provided', () => {
    const result = acquire({
      sessionId: 'uuid-bcfa-1234-...',
      semanticSessionId: 'main-2026-05-27-deep-5',
      mode: 'deep',
      repoRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.lock.semantic_session_id).toBe('main-2026-05-27-deep-5');
    expect(readLock({ repoRoot }).semantic_session_id).toBe('main-2026-05-27-deep-5');
  });

  it('acquire() omits semantic_session_id when not provided', () => {
    const result = acquire({ sessionId: 'sess-no-semantic', mode: 'deep', repoRoot });

    expect(result.ok).toBe(true);
    expect(result.lock.semantic_session_id).toBeUndefined();
    expect(readLock({ repoRoot }).semantic_session_id).toBeUndefined();
  });
});
