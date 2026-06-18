/**
 * tests/scripts/lib/learnings/surface.test.mjs
 *
 * Unit tests for scripts/lib/learnings/surface.mjs — surfaceTopN().
 *
 * Pattern: mkdtempSync per-suite via beforeEach/afterEach, hardcoded
 * expected literals, frozen clock for expiry tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  surfaceTopN,
  effectiveScore,
  decayOptsFromConfig,
  DECAY_DEFAULTS,
} from '@lib/learnings/surface.mjs';

// ---------------------------------------------------------------------------
// Tmp-dir lifecycle
// ---------------------------------------------------------------------------

let tmpDir;
let filePath;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'surface-test-'));
  filePath = join(tmpDir, 'learnings.jsonl');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write JSONL lines to filePath. Each element is either a plain string
 *  (already serialised) or an object (will be JSON.stringify'd). */
function writeLines(...entries) {
  const content = entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n');
  writeFileSync(filePath, content, 'utf8');
}

/** A minimal valid learning entry above the default confidence floor. */
function entry(overrides = {}) {
  return {
    id: 'test-id',
    type: 'recurring-issue',
    subject: 'test subject',
    confidence: 0.8,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('surfaceTopN', () => {
  // 1. Missing file → returns []
  it('returns [] when the file does not exist', async () => {
    const result = await surfaceTopN(join(tmpDir, 'nonexistent.jsonl'));
    expect(result).toEqual([]);
  });

  // 2. Empty file (0 bytes) → returns []
  it('returns [] for a zero-byte file', async () => {
    writeFileSync(filePath, '', 'utf8');
    const result = await surfaceTopN(filePath);
    expect(result).toEqual([]);
  });

  // 3. File with only blank lines → returns []
  it('returns [] for a file containing only blank lines', async () => {
    writeFileSync(filePath, '\n\n\n', 'utf8');
    const result = await surfaceTopN(filePath);
    expect(result).toEqual([]);
  });

  // 4. Malformed line in middle of valid lines → silently skipped, others surface
  it('skips malformed JSON lines and surfaces valid entries', async () => {
    const good = entry({ id: 'good', confidence: 0.9 });
    writeLines(good, 'NOT VALID JSON }{', entry({ id: 'good2', confidence: 0.7 }));
    const result = await surfaceTopN(filePath);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('good');
    expect(result[1].id).toBe('good2');
  });

  // 5. Single entry above floor → returns that 1 entry
  it('returns a single entry when only one entry is above the confidence floor', async () => {
    const e = entry({ id: 'solo', confidence: 0.5 });
    writeLines(e);
    const result = await surfaceTopN(filePath);
    expect(result).toEqual([e]);
  });

  // 6. Multiple entries above floor → sorted confidence DESC, sliced to n
  it('returns entries sorted by confidence DESC when all are above the floor', async () => {
    const low = entry({ id: 'low', confidence: 0.5, created_at: '2026-01-01T00:00:00Z' });
    const high = entry({ id: 'high', confidence: 0.9, created_at: '2026-01-01T00:00:00Z' });
    const mid = entry({ id: 'mid', confidence: 0.7, created_at: '2026-01-01T00:00:00Z' });
    writeLines(low, high, mid);
    const result = await surfaceTopN(filePath, 10);
    expect(result[0].id).toBe('high');
    expect(result[1].id).toBe('mid');
    expect(result[2].id).toBe('low');
  });

  // 7. Confidence floor is STRICT >: confidence === 0.3 dropped, 0.31 kept
  it('drops entries with confidence exactly equal to the default floor (0.3)', async () => {
    const atFloor = entry({ id: 'at-floor', confidence: 0.3 });
    const aboveFloor = entry({ id: 'above-floor', confidence: 0.31 });
    writeLines(atFloor, aboveFloor);
    const result = await surfaceTopN(filePath);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('above-floor');
  });

  // 8. Custom confidenceFloor — 0.4 dropped when floor=0.5, 0.6 kept
  it('applies a custom confidenceFloor correctly', async () => {
    const dropped = entry({ id: 'dropped', confidence: 0.4 });
    const kept = entry({ id: 'kept', confidence: 0.6 });
    writeLines(dropped, kept);
    const result = await surfaceTopN(filePath, 5, { confidenceFloor: 0.5 });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('kept');
  });

  // 9. Tiebreaker: same confidence, newer created_at wins
  it('breaks confidence ties by created_at DESC (newer first)', async () => {
    const older = entry({ id: 'older', confidence: 0.8, created_at: '2025-01-01T00:00:00Z' });
    const newer = entry({ id: 'newer', confidence: 0.8, created_at: '2026-03-01T00:00:00Z' });
    writeLines(older, newer);
    const result = await surfaceTopN(filePath, 10);
    expect(result[0].id).toBe('newer');
    expect(result[1].id).toBe('older');
  });

  // 10. Expired entry dropped; future expires_at kept
  it('drops entries whose expires_at is before now and keeps entries with future expires_at', async () => {
    const frozenNow = new Date('2026-05-23T12:00:00Z');
    const expired = entry({ id: 'expired', confidence: 0.9, expires_at: '2026-05-22T00:00:00Z' });
    const fresh = entry({ id: 'fresh', confidence: 0.8, expires_at: '2026-06-01T00:00:00Z' });
    writeLines(expired, fresh);
    const result = await surfaceTopN(filePath, 5, { now: frozenNow });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('fresh');
  });

  // 11. Entry missing expires_at → treated as not-expired (kept)
  it('keeps entries that have no expires_at field', async () => {
    const e = entry({ id: 'no-expiry', confidence: 0.75 });
    delete e.expires_at; // ensure field is absent
    writeLines(e);
    const result = await surfaceTopN(filePath, 5, { now: new Date('2099-01-01T00:00:00Z') });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('no-expiry');
  });

  // 12. Entry missing confidence → treated as 0 → dropped
  it('drops entries that have no confidence field', async () => {
    const noConf = { id: 'no-conf', type: 'recurring-issue', subject: 'x', created_at: '2026-01-01T00:00:00Z' };
    const withConf = entry({ id: 'with-conf', confidence: 0.8 });
    writeLines(noConf, withConf);
    const result = await surfaceTopN(filePath);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('with-conf');
  });

  // 13. N slicing: 5 valid entries, n=3 → exactly 3 returned (top-3 by confidence)
  it('slices the result to n entries', async () => {
    const entries = [
      entry({ id: 'e1', confidence: 0.9, created_at: '2026-01-01T00:00:00Z' }),
      entry({ id: 'e2', confidence: 0.85, created_at: '2026-01-01T00:00:00Z' }),
      entry({ id: 'e3', confidence: 0.80, created_at: '2026-01-01T00:00:00Z' }),
      entry({ id: 'e4', confidence: 0.75, created_at: '2026-01-01T00:00:00Z' }),
      entry({ id: 'e5', confidence: 0.70, created_at: '2026-01-01T00:00:00Z' }),
    ];
    writeLines(...entries);
    const result = await surfaceTopN(filePath, 3);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('e1');
    expect(result[1].id).toBe('e2');
    expect(result[2].id).toBe('e3');
  });

  // 14. Default n=5: file with 7 entries → returns exactly 5
  it('defaults n to 5, returning 5 entries from a 7-entry file', async () => {
    const entries = [
      entry({ id: 'a', confidence: 0.98, created_at: '2026-01-01T00:00:00Z' }),
      entry({ id: 'b', confidence: 0.95, created_at: '2026-01-01T00:00:00Z' }),
      entry({ id: 'c', confidence: 0.90, created_at: '2026-01-01T00:00:00Z' }),
      entry({ id: 'd', confidence: 0.85, created_at: '2026-01-01T00:00:00Z' }),
      entry({ id: 'e', confidence: 0.80, created_at: '2026-01-01T00:00:00Z' }),
      entry({ id: 'f', confidence: 0.75, created_at: '2026-01-01T00:00:00Z' }),
      entry({ id: 'g', confidence: 0.70, created_at: '2026-01-01T00:00:00Z' }),
    ];
    writeLines(...entries);
    const result = await surfaceTopN(filePath);
    expect(result).toHaveLength(5);
    expect(result[0].id).toBe('a');
    expect(result[4].id).toBe('e');
  });

  // 15. now passed as a number (epoch ms) — exercises the typeof nowOpt === 'number' branch
  it('accepts now as a numeric epoch ms for expiry evaluation', async () => {
    const nowMs = new Date('2026-05-23T12:00:00Z').getTime();
    const expired = entry({ id: 'expired-num', confidence: 0.9, expires_at: '2026-05-22T00:00:00Z' });
    const fresh = entry({ id: 'fresh-num', confidence: 0.8, expires_at: '2026-06-01T00:00:00Z' });
    writeLines(expired, fresh);
    const result = await surfaceTopN(filePath, 5, { now: nowMs });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('fresh-num');
  });

  // 16. Tiebreaker with entries missing created_at → stable sort, missing treated as epoch 0.
  // `now` is pinned to the dated entry's created_at so its decay age is 0 and the
  // effectiveScores tie (both 0.8), isolating the created_at tiebreaker (#670).
  it('sorts entries missing created_at to the end of a confidence tie', async () => {
    const withDate = entry({ id: 'with-date', confidence: 0.8, created_at: '2026-01-01T00:00:00Z' });
    const noDate = { id: 'no-date', type: 'recurring-issue', subject: 'x', confidence: 0.8 };
    writeLines(withDate, noDate);
    const result = await surfaceTopN(filePath, 10, { now: new Date('2026-01-01T00:00:00Z') });
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('with-date');
    expect(result[1].id).toBe('no-date');
  });

  // 17. Stable sort when BOTH confidence AND created_at are tied — input order preserved (#541 G3)
  it('preserves input order for entries with identical confidence AND identical created_at (stable sort)', async () => {
    const first = entry({ id: 'first-in', confidence: 0.8, created_at: '2026-01-01T00:00:00Z' });
    const second = entry({ id: 'second-in', confidence: 0.8, created_at: '2026-01-01T00:00:00Z' });
    const third = entry({ id: 'third-in', confidence: 0.8, created_at: '2026-01-01T00:00:00Z' });
    writeLines(first, second, third);
    const result = await surfaceTopN(filePath, 10);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('first-in');
    expect(result[1].id).toBe('second-in');
    expect(result[2].id).toBe('third-in');
  });
});

// ---------------------------------------------------------------------------
// Time-decay ranking (#670)
//
// Fixed "now" injected via opts.now so age is deterministic. Default decay:
// half-life 90 days, floor-factor 0.1, enabled. At now=2027-01-01:
//   - 2026-01-01 entry is 365 days old → factor 0.5^(365/90) ≈ 0.060
//   - 2027-01-01 entry is 0 days old   → factor 1.0
// ---------------------------------------------------------------------------

describe('surfaceTopN — time-decay ranking (#670)', () => {
  const NOW = new Date('2027-01-01T00:00:00Z');

  // Core win: a STALE high-confidence entry ranks BELOW a FRESH mid-confidence one.
  // stale 0.9 @365d → 0.090 (floored); fresh 0.6 @0d → 0.600. Fresh wins.
  it('ranks a stale high-confidence entry below a fresh mid-confidence entry', async () => {
    const stale = entry({ id: 'stale-high', confidence: 0.9, created_at: '2026-01-01T00:00:00Z' });
    const fresh = entry({ id: 'fresh-mid', confidence: 0.6, created_at: '2027-01-01T00:00:00Z' });
    writeLines(stale, fresh);
    const result = await surfaceTopN(filePath, 10, { now: NOW });
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('fresh-mid');
    expect(result[1].id).toBe('stale-high');
  });

  // The active confidence-filter is PRESERVED: decay re-ranks survivors but does
  // not promote an entry that fails the floor. A 0.3-confidence (== floor) entry
  // stays dropped even though it is fresh.
  it('still drops an at-floor entry — decay re-ranks but does not bypass the confidence filter', async () => {
    const atFloor = entry({ id: 'at-floor-fresh', confidence: 0.3, created_at: '2027-01-01T00:00:00Z' });
    const stale = entry({ id: 'stale-above', confidence: 0.5, created_at: '2026-01-01T00:00:00Z' });
    writeLines(atFloor, stale);
    const result = await surfaceTopN(filePath, 10, { now: NOW });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('stale-above');
  });

  // Floor holds: a VERY OLD high-confidence entry still surfaces. Its effective
  // score never drops below confidence × floorFactor (0.95 × 0.1 = 0.095).
  it('keeps a very old high-confidence entry above the floor (effectiveScore >= confidence × 0.1)', async () => {
    const ancient = entry({ id: 'ancient', confidence: 0.95, created_at: '1990-01-01T00:00:00Z' });
    writeLines(ancient);
    const result = await surfaceTopN(filePath, 10, { now: NOW });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ancient');
    // The floor guarantees the score never collapses to ~0.
    const score = effectiveScore(ancient, NOW.getTime(), DECAY_DEFAULTS);
    expect(score).toBe(0.095); // 0.95 × 0.1 floor — durable learning never vanishes
  });

  // decay-enabled: false → pure-confidence ordering restored (back-compat).
  // Without decay, stale 0.9 outranks fresh 0.6 (the pre-#670 behavior).
  it('restores pure-confidence ordering when decay is disabled', async () => {
    const stale = entry({ id: 'stale-high', confidence: 0.9, created_at: '2026-01-01T00:00:00Z' });
    const fresh = entry({ id: 'fresh-mid', confidence: 0.6, created_at: '2027-01-01T00:00:00Z' });
    writeLines(stale, fresh);
    const result = await surfaceTopN(filePath, 10, { now: NOW, decay: { enabled: false } });
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('stale-high');
    expect(result[1].id).toBe('fresh-mid');
  });

  // last_reinforced overrides created_at as the recency basis when present. An
  // old created_at but a fresh last_reinforced means the entry does NOT decay.
  it('uses last_reinforced over created_at when the field is present', async () => {
    const reinforced = entry({
      id: 'reinforced',
      confidence: 0.6,
      created_at: '2026-01-01T00:00:00Z',
      last_reinforced: '2027-01-01T00:00:00Z',
    });
    const stale = entry({ id: 'stale-high', confidence: 0.9, created_at: '2026-01-01T00:00:00Z' });
    writeLines(stale, reinforced);
    const result = await surfaceTopN(filePath, 10, { now: NOW });
    // reinforced (fresh via last_reinforced, 0.6 → 0.600) beats stale (0.9 → 0.090).
    expect(result[0].id).toBe('reinforced');
    expect(result[1].id).toBe('stale-high');
  });

  // No parseable timestamp → no decay → ranks on raw confidence.
  it('falls back to raw confidence for entries with no parseable recency timestamp', async () => {
    const noDate = { id: 'no-date-high', type: 'x', subject: 'y', confidence: 0.9 };
    const fresh = entry({ id: 'fresh-mid', confidence: 0.6, created_at: '2027-01-01T00:00:00Z' });
    writeLines(noDate, fresh);
    const result = await surfaceTopN(filePath, 10, { now: NOW });
    // noDate cannot age → effective score is raw 0.9, outranking fresh 0.6.
    expect(result[0].id).toBe('no-date-high');
    expect(result[1].id).toBe('fresh-mid');
  });

  // A custom half-life makes decay bite harder. With half-life 30, the stale
  // entry decays faster — still ranks below fresh, confirming the knob is wired.
  it('honours a custom decay half-life', async () => {
    const stale = entry({ id: 'stale-high', confidence: 0.9, created_at: '2026-01-01T00:00:00Z' });
    const fresh = entry({ id: 'fresh-mid', confidence: 0.6, created_at: '2027-01-01T00:00:00Z' });
    writeLines(stale, fresh);
    const result = await surfaceTopN(filePath, 10, {
      now: NOW,
      decay: { halfLifeDays: 30 },
    });
    expect(result[0].id).toBe('fresh-mid');
    expect(result[1].id).toBe('stale-high');
  });
});

// ---------------------------------------------------------------------------
// effectiveScore — unit (#670)
// ---------------------------------------------------------------------------

describe('effectiveScore (#670)', () => {
  const NOW_MS = new Date('2027-01-01T00:00:00Z').getTime();

  it('returns raw confidence at age 0 (no decay yet)', () => {
    const e = { confidence: 0.8, created_at: '2027-01-01T00:00:00Z' };
    expect(effectiveScore(e, NOW_MS, DECAY_DEFAULTS)).toBe(0.8);
  });

  it('halves the score after exactly one half-life', () => {
    // 90 days before NOW → exactly one half-life with the default → confidence / 2.
    const e = { confidence: 0.8, created_at: '2026-10-03T00:00:00Z' };
    expect(effectiveScore(e, NOW_MS, DECAY_DEFAULTS)).toBe(0.4);
  });

  it('never drops below confidence × floorFactor for ancient entries', () => {
    const e = { confidence: 0.95, created_at: '1990-01-01T00:00:00Z' };
    expect(effectiveScore(e, NOW_MS, DECAY_DEFAULTS)).toBe(0.095);
  });

  it('returns raw confidence when decay is disabled', () => {
    const e = { confidence: 0.9, created_at: '2026-01-01T00:00:00Z' };
    expect(effectiveScore(e, NOW_MS, { ...DECAY_DEFAULTS, enabled: false })).toBe(0.9);
  });

  it('clamps future timestamps to age 0 (never boosts above confidence)', () => {
    const e = { confidence: 0.7, created_at: '2099-01-01T00:00:00Z' };
    expect(effectiveScore(e, NOW_MS, DECAY_DEFAULTS)).toBe(0.7);
  });

  // qa finding E — NaN-guard hardening (#670). A halfLifeDays of 0 must fall
  // back to the default half-life, NOT divide-by-zero into NaN. The guard
  // (`halfLifeDays > 0 ? ... : DEFAULT`) already exists; this pins it.
  it('falls back to the default half-life when halfLifeDays is 0 (no NaN)', () => {
    // 90 days before NOW → exactly one default half-life → 0.8 / 2 = 0.4.
    const e = { confidence: 0.8, created_at: '2026-10-03T00:00:00Z' };
    const score = effectiveScore(e, NOW_MS, { enabled: true, halfLifeDays: 0, floorFactor: 0.1 });
    expect(Number.isNaN(score)).toBe(false);
    expect(score).toBe(0.4);
  });
});

// ---------------------------------------------------------------------------
// decayOptsFromConfig — kebab→camel bridge (#670)
//
// `_parseEvolveDecay` (scripts/lib/config/evolve.mjs) emits kebab-case
// (`half-life-days`, `floor-factor`, `enabled`); surfaceTopN's opts.decay
// expects camelCase (`halfLifeDays`, `floorFactor`, `enabled`). This bridge is
// what closes the no-op gap the reviewers found.
// ---------------------------------------------------------------------------

describe('decayOptsFromConfig (#670)', () => {
  it('maps each kebab key to its camelCase equivalent', () => {
    expect(
      decayOptsFromConfig({ enabled: false, 'half-life-days': 30, 'floor-factor': 0.2 }),
    ).toEqual({ enabled: false, halfLifeDays: 30, floorFactor: 0.2 });
  });

  it('copies only keys present on the input (partial config)', () => {
    expect(decayOptsFromConfig({ 'half-life-days': 5 })).toEqual({ halfLifeDays: 5 });
  });

  it('returns undefined for undefined input (surfaceTopN then uses DECAY_DEFAULTS)', () => {
    expect(decayOptsFromConfig(undefined)).toBeUndefined();
  });

  it('returns undefined for null input', () => {
    expect(decayOptsFromConfig(null)).toBeUndefined();
  });

  it('returns undefined for a non-object input', () => {
    expect(decayOptsFromConfig('nope')).toBeUndefined();
  });

  it('returns {} for an empty-object input (all defaults apply downstream)', () => {
    expect(decayOptsFromConfig({})).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// INTEGRATION: decayOptsFromConfig → surfaceTopN (#670)
//
// Proves the documented Session Config knobs actually take effect end-to-end.
// The `config` objects here use the EXACT kebab-case shape that
// `_parseEvolveDecay` produces, so a regression in either the bridge mapping or
// the surfaceTopN wiring would fail these — not just the unit bridge test.
// ---------------------------------------------------------------------------

describe('surfaceTopN ← decayOptsFromConfig integration (#670)', () => {
  const NOW = new Date('2027-01-01T00:00:00Z');

  // decay-enabled: false (kebab from config) → bridged → pure-confidence order.
  // The stale 0.9 entry must rank ABOVE the fresh 0.6 entry, proving the knob
  // round-trips from config-shape through the bridge into surfaceTopN.
  it('restores pure-confidence ordering when config sets decay-enabled: false', async () => {
    const stale = entry({ id: 'stale-high', confidence: 0.9, created_at: '2026-01-01T00:00:00Z' });
    const fresh = entry({ id: 'fresh-mid', confidence: 0.6, created_at: '2027-01-01T00:00:00Z' });
    writeLines(stale, fresh);

    // Shape as produced by _parseEvolveDecay for `decay-enabled: false`.
    const evolveDecay = { enabled: false, 'half-life-days': 90, 'floor-factor': 0.1 };
    const result = await surfaceTopN(filePath, 10, {
      now: NOW,
      decay: decayOptsFromConfig(evolveDecay),
    });

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('stale-high');
    expect(result[1].id).toBe('fresh-mid');
  });

  // decay-half-life-days: 5 (aggressive) → a 30-day-old high-conf entry decays
  // hard and ranks BELOW a fresh mid-conf one. stale 0.9 @ ~365d with hl=5 floors
  // at 0.09; fresh 0.6 @ 0d = 0.6. Fresh wins — proving the half-life knob is live.
  it('ranks a 30-day-old high-conf entry below a fresh mid-conf one with decay-half-life-days: 5', async () => {
    const stale = entry({ id: 'stale-high', confidence: 0.9, created_at: '2026-01-01T00:00:00Z' });
    const fresh = entry({ id: 'fresh-mid', confidence: 0.6, created_at: '2027-01-01T00:00:00Z' });
    writeLines(stale, fresh);

    // Shape as produced by _parseEvolveDecay for `decay-half-life-days: 5`.
    const evolveDecay = { enabled: true, 'half-life-days': 5, 'floor-factor': 0.1 };
    const result = await surfaceTopN(filePath, 10, {
      now: NOW,
      decay: decayOptsFromConfig(evolveDecay),
    });

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('fresh-mid');
    expect(result[1].id).toBe('stale-high');
  });

  // undefined config (no evolve.decay block) → DECAY_DEFAULTS apply (enabled,
  // 90-day half-life). Default decay still ranks fresh-mid above stale-high.
  it('applies DECAY_DEFAULTS when config has no evolve.decay (undefined bridge)', async () => {
    const stale = entry({ id: 'stale-high', confidence: 0.9, created_at: '2026-01-01T00:00:00Z' });
    const fresh = entry({ id: 'fresh-mid', confidence: 0.6, created_at: '2027-01-01T00:00:00Z' });
    writeLines(stale, fresh);

    const result = await surfaceTopN(filePath, 10, {
      now: NOW,
      decay: decayOptsFromConfig(undefined),
    });

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('fresh-mid');
    expect(result[1].id).toBe('stale-high');
  });
});
