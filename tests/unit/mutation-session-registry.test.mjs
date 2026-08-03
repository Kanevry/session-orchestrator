/**
 * Mutation-derived tests for session-registry.mjs isRegistryEntryFresh (GL #910, W3).
 *
 * A hand-mutation sweep found 5 SURVIVORS in this module. Three of them are
 * reachable through the pure, exported `isRegistryEntryFresh()` seam and name
 * concrete bugs the existing suite never entered:
 *   - sr4: the schema-v2 `mode` type-validation was inverted (valid string modes
 *     dropped, malformed non-string modes accepted) and no test constructed an
 *     entry carrying a `mode` field to notice.
 *   - sr6: an entry with an UNPARSEABLE `last_heartbeat` fails open — `_ageMinutes`
 *     returns Infinity (→ stale, correct); a mutant returning 0 would treat a
 *     corrupt timestamp as brand-new (→ a phantom live peer that never gets swept).
 *   - sr1: the freshness comparison `age <= freshnessMin` was only tested strictly
 *     above/below its limit, never AT the exact boundary.
 *
 * Each `it` names the concrete bug a flip would ship.
 */
import { describe, it, expect } from 'vitest';
import { isRegistryEntryFresh } from '../../scripts/lib/session-registry.mjs';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');
const minsAgo = (m) => new Date(NOW - m * 60_000).toISOString();

const validEntry = (over = {}) => ({
  session_id: 'sess-abc',
  started_at: minsAgo(30),
  last_heartbeat: minsAgo(5),
  ...over,
});

describe('session-registry isRegistryEntryFresh — mode validation + fail-safe (mutation #910)', () => {
  it('accepts an entry carrying a valid string `mode` as fresh (survivor sr4: inverted mode type-check drops valid string modes)', () => {
    const entry = validEntry({ mode: 'deep', last_heartbeat: minsAgo(5) });
    expect(isRegistryEntryFresh(entry, { freshnessMin: 15, now: NOW })).toBe(true);
  });

  it('rejects an entry whose `mode` is a non-string (number) as invalid (survivor sr4: malformed mode smuggled through)', () => {
    // A number `mode` violates schema v2 → _validEntry must reject → not fresh,
    // regardless of a fresh heartbeat. The inverted mutant would ACCEPT it.
    const entry = validEntry({ mode: 123, last_heartbeat: minsAgo(1) });
    expect(isRegistryEntryFresh(entry, { freshnessMin: 15, now: NOW })).toBe(false);
  });

  it('treats an entry with an unparseable last_heartbeat as NOT fresh (survivor sr6: fail-open NaN→0 would make a corrupt timestamp a phantom live peer)', () => {
    const entry = validEntry({ last_heartbeat: 'not-a-timestamp' });
    expect(isRegistryEntryFresh(entry, { freshnessMin: 15, now: NOW })).toBe(false);
  });

  it('counts an entry aged EXACTLY at the freshness window as still fresh (survivor sr1: `age <= freshnessMin` boundary)', () => {
    // last_heartbeat exactly freshnessMin (15) minutes old → age == 15.
    // `15 <= 15` is fresh; the mutant `15 < 15` would wrongly evict it.
    const entry = validEntry({ last_heartbeat: minsAgo(15) });
    expect(isRegistryEntryFresh(entry, { freshnessMin: 15, now: NOW })).toBe(true);
  });
});
