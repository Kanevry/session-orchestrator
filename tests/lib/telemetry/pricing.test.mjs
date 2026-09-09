/**
 * tests/lib/telemetry/pricing.test.mjs — #1244.
 *
 * Two bugs are pinned here, both of which turn a cost report into a lie:
 *   1. an unknown model priced as 0 (a run that cost money reported as free);
 *   2. one blended rate applied to all four token buckets (cache reads are
 *      ~10x cheaper and cache writes ~1.25x dearer than an uncached token).
 */

import { describe, it, expect } from 'vitest';
import { costUsd, priceFor, PRICING_TABLE, PRICING_TABLE_DATE } from '@lib/telemetry/pricing.mjs';

describe('telemetry/pricing', () => {
  it('returns null for an unknown model, never 0', () => {
    expect(priceFor('gpt-5.6-sol')).toBeNull();
    expect(priceFor(null)).toBeNull();
    expect(priceFor('')).toBeNull();

    const cost = costUsd({
      model: 'gpt-5.6-sol',
      tokenInputUncached: 1_000_000,
      tokenCacheRead: 1_000_000,
      tokenCacheCreation: 1_000_000,
      tokenOutput: 1_000_000,
    });
    // The distinction the whole module exists for: null means UNKNOWN MODEL.
    expect(cost).toBeNull();
    expect(cost).not.toBe(0);
  });

  it('costUsd multiplies each of the four buckets by its own rate', () => {
    const row = PRICING_TABLE['claude-opus-5'];
    const cost = costUsd({
      model: 'claude-opus-5',
      tokenInputUncached: 1_000_000,
      tokenCacheRead: 2_000_000,
      tokenCacheCreation: 3_000_000,
      tokenOutput: 4_000_000,
    });
    // A single blended rate cannot produce this number — each bucket carries
    // its own multiplier (5.0 / 0.5 / 6.25 / 25.0 USD per MTok).
    expect(cost).toBeCloseTo(row.input + 2 * row.cache_read + 3 * row.cache_creation + 4 * row.output, 10);
    expect(cost).toBeCloseTo(5.0 + 1.0 + 18.75 + 100.0, 10);
  });

  it('resolves dated and long-context model ids to their table row', () => {
    // A transcript's `message.model` is not always the bare table key — a
    // prefix/alias miss would silently null out the whole session cost.
    expect(priceFor('claude-haiku-4-5-20251001')).toBe(PRICING_TABLE['claude-haiku-4-5']);
    expect(priceFor('claude-opus-5[1m]')).toBe(PRICING_TABLE['claude-opus-5']);
    expect(priceFor('claude-sonnet-5')).toBe(PRICING_TABLE['claude-sonnet-5']);
    expect(priceFor('claude-fable-5-1')).toBe(PRICING_TABLE['claude-fable-5-1']);
  });

  it('never returns a non-finite cost for an absurd bucket — Infinity serialises as null', () => {
    // Bug: `1e308` is finite, so it passed the old `num()` guard and multiplied
    // out to Infinity. `JSON.stringify(Infinity)` is `null` — the exact encoding
    // this module reserves for "unknown model", so a corrupt bucket read as an
    // unpriced one. A token count above 2^53 is not a measurement; it is 0.
    const cost = costUsd({
      model: 'claude-opus-5',
      tokenInputUncached: 1e308,
      tokenCacheRead: 1e308,
      tokenCacheCreation: Number.MAX_SAFE_INTEGER + 10,
      tokenOutput: 1_000_000,
    });
    expect(cost).not.toBe(Infinity);
    expect(Number.isFinite(cost)).toBe(true);
    // Only the one honest bucket is priced.
    expect(cost).toBeCloseTo(25.0, 10);
  });

  it('carries a measurement date so a quoted price can age visibly', () => {
    expect(PRICING_TABLE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
