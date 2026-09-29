/**
 * tests/lib/telemetry/pricing.test.mjs — #1244.
 *
 * Three bugs are pinned here, each of which turns a cost report into a lie:
 *   1. an unknown model priced as 0 (a run that cost money reported as free);
 *   2. one blended rate applied to all four token buckets (cache reads are
 *      10-40x cheaper and 5-minute cache writes ~1.25x dearer than an uncached token);
 *   3. (#1470) an unlisted model generation priced at a neighbour's rates and
 *      marked verified.
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
    // A transcript's `message.model` is not always the bare table key — an
    // alias miss would silently null out the whole session cost.
    expect(priceFor('claude-haiku-4-5-20251001')).toBe(PRICING_TABLE['claude-haiku-4-5']);
    expect(priceFor('claude-opus-5[1m]')).toBe(PRICING_TABLE['claude-opus-5']);
    expect(priceFor('claude-sonnet-5')).toBe(PRICING_TABLE['claude-sonnet-5']);
    expect(priceFor('claude-fable-5-1')).toBe(PRICING_TABLE['claude-fable-5-1']);
  });

  // #1470 — an id that is not an exact key or an explicit alias must be UNKNOWN.
  // The old unbounded `startsWith` gave an invented generation the rates of its
  // nearest table key, marked verified.
  it.each([
    'claude-opus-5-99',
    'claude-sonnet-5-7',
    'claude-opus-5-20260401',
    'claude-opus-5-5-20260401',
    'claude-haiku-4-5-20251002',
    'claude-fable-5-2',
  ])('treats the unlisted model id %s as unknown in priceFor and costUsd', (id) => {
    expect(priceFor(id)).toBeNull();
    expect(
      costUsd({
        model: id,
        tokenInputUncached: 1_000_000,
        tokenCacheRead: 1_000_000,
        tokenCacheCreation: 1_000_000,
        tokenOutput: 1_000_000,
      }),
    ).toBeNull();
  });

  it('prices claude-opus-5-5 at its own rates, not those of claude-opus-5', () => {
    expect(priceFor('claude-opus-5-5').input).toBe(4);
    // 1M tokens per bucket: 4 + 0.2 + 5 + 20 = 29.20 USD (claude-opus-5 would be 36.75).
    expect(
      costUsd({
        model: 'claude-opus-5-5',
        tokenInputUncached: 1_000_000,
        tokenCacheRead: 1_000_000,
        tokenCacheCreation: 1_000_000,
        tokenOutput: 1_000_000,
      }),
    ).toBeCloseTo(29.2, 10);
  });

  // Golden table (USD/MTok) from https://platform.claude.com/docs/en/about-claude/pricing.
  it.each([
    ['claude-fable-5-1', 10, 0.25, 12.5, 50],
    ['claude-fable-5', 10, 1, 12.5, 50],
    ['claude-opus-5-5', 4, 0.2, 5, 20],
    ['claude-opus-5', 5, 0.5, 6.25, 25],
    ['claude-opus-4-8', 5, 0.5, 6.25, 25],
    ['claude-sonnet-5-5', 2, 0.2, 2.5, 10],
    ['claude-sonnet-5', 2, 0.2, 2.5, 10],
    ['claude-haiku-4-5', 1, 0.1, 1.25, 5],
  ])(
    '%s carries the documented rates %d / %d / %d / %d',
    (id, input, cacheRead, cacheCreation, output) => {
      expect(PRICING_TABLE[id]).toMatchObject({
        input,
        cache_read: cacheRead,
        cache_creation: cacheCreation,
        output,
      });
    },
  );

  it('lists exactly the eight documented models', () => {
    expect(Object.keys(PRICING_TABLE).sort()).toEqual([
      'claude-fable-5',
      'claude-fable-5-1',
      'claude-haiku-4-5',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude-sonnet-5-5',
    ]);
  });

  it.each(Object.entries(PRICING_TABLE))('%s row carries full provenance', (_id, row) => {
    expect(row.verified).toBe(true);
    expect(row.cache_source).toBe('documented');
    expect(row.source_url).toMatch(/^https:\/\/platform\.claude\.com\//);
    expect(row.checked_at).toBe(PRICING_TABLE_DATE);
    expect(row.provider).toBe('anthropic');
    expect(row.cache_write_ttl).toBe('5m');
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
