/**
 * lock-ttl-parity.test.mjs — cross-reference drift guard (review FIX 3, W4-FC).
 *
 * The session-lock TTL/liveness rule is encoded in TWO places:
 *   1. scripts/lib/session-lock.mjs         — SSOT (DEFAULT_TTL_HOURS, isLockLive)
 *   2. scripts/lib/harness-audit/categories/category4.mjs — inlined mirror
 *      (DEFAULT_LOCK_TTL_HOURS, lockIsLive), documented as a stdlib-only copy
 *      of the SSOT so the audit path never imports the session-lock barrel.
 *
 * Not a copy, so not covered here: scripts/lib/lock-reaper.mjs `ageHoursOf()`
 * reports hours since `last_heartbeat` for display, holds no TTL and decides
 * nothing (the reaper gates on the imported `isLockLive`).
 *
 * A silent edit to either the constant or the liveness rule in ONE of these
 * copies without the other would drift the harness-audit's orphaned-session-lock
 * check out of sync with the actual lock semantics, with no test catching it.
 * This is a mechanical drift-guard — not a functional test of either module.
 */

import { describe, it, expect } from 'vitest';

import { DEFAULT_TTL_HOURS, isLockLive } from '@lib/session-lock.mjs';
import { DEFAULT_LOCK_TTL_HOURS, lockIsLive } from '@lib/harness-audit/categories/category4.mjs';

const NOW = Date.parse('2026-07-02T12:00:00Z');

describe('lock TTL/liveness parity — session-lock.mjs (SSOT) vs category4.mjs (inlined mirror)', () => {
  it('the inlined default TTL constant matches the SSOT default', () => {
    expect(DEFAULT_LOCK_TTL_HOURS).toBe(DEFAULT_TTL_HOURS);
  });

  it('judges a fresh-heartbeat lock identically (both live)', () => {
    // No ttl_hours field: both copies must fall back to their default TTL
    // constant (equal per the test above) — a copy without that default would
    // compute a NaN window and call the lock dead.
    const lock = {
      last_heartbeat: new Date(NOW - 1 * 3600 * 1000).toISOString(), // 1h ago, default ttl 4h
      started_at: new Date(NOW - 1 * 3600 * 1000).toISOString(),
    };
    expect(isLockLive(lock, NOW)).toBe(true);
    expect(lockIsLive(lock, NOW)).toBe(true);
  });

  it('judges an expired-heartbeat lock identically (both dead)', () => {
    const lock = {
      last_heartbeat: new Date(NOW - 5 * 3600 * 1000).toISOString(), // 5h ago, ttl 4h
      started_at: new Date(NOW - 5 * 3600 * 1000).toISOString(),
      ttl_hours: 4,
    };
    expect(isLockLive(lock, NOW)).toBe(false);
    expect(lockIsLive(lock, NOW)).toBe(false);
  });

  it('judges a heartbeat-less lock identically (both NOT live — #595 sunset)', () => {
    // started_at is 1h ago, well inside the TTL. Until 2026-10-02 both copies
    // fell back to it and called this lock live; now neither may, so a copy
    // that re-grows the started_at fallback breaks parity here.
    const lock = {
      started_at: new Date(NOW - 1 * 3600 * 1000).toISOString(), // 1h ago
      ttl_hours: 4,
    };
    expect(isLockLive(lock, NOW)).toBe(false);
    expect(lockIsLive(lock, NOW)).toBe(false);
  });

  it('judges a heartbeat stamped in the future identically (#1494 — > 5 min ahead is not live)', () => {
    // A copy without the future guard computes a negative age, stays below the
    // TTL and calls a year-ahead lock live — the audit then reports a live
    // lease that acquire() treats as reclaimable.
    const at = (offsetMs) => ({ last_heartbeat: new Date(NOW + offsetMs).toISOString(), ttl_hours: 4 });
    const verdicts = (lock) => [isLockLive(lock, NOW), lockIsLive(lock, NOW)];

    expect(verdicts(at(365 * 24 * 3600 * 1000))).toEqual([false, false]);
    expect(verdicts(at(5 * 60 * 1000 + 1))).toEqual([false, false]); // 1 ms past the 5-min tolerance
    expect(verdicts(at(60 * 1000))).toEqual([true, true]);
  });
});
