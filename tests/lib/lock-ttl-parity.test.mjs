/**
 * lock-ttl-parity.test.mjs — cross-reference drift guard (review FIX 3, W4-FC).
 *
 * The session-lock TTL/liveness semantics are encoded in THREE places:
 *   1. scripts/lib/session-lock.mjs         — SSOT (DEFAULT_TTL_HOURS, isLockLive)
 *   2. scripts/lib/lock-reaper.mjs           — ageHoursOf (age-only; no TTL constant)
 *   3. scripts/lib/harness-audit/categories/category4.mjs — inlined mirror
 *      (DEFAULT_LOCK_TTL_HOURS, lockIsLive), documented as a stdlib-only copy
 *      of the SSOT so the audit path never imports the session-lock barrel.
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
});
