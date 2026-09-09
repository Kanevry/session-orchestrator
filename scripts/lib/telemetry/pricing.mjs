/**
 * pricing.mjs — USD price table for token-bucket cost estimation (#1244).
 *
 * The subagent ledger records four token buckets per stop record
 * (`token_input_uncached`, `token_cache_read`, `token_cache_creation`,
 * `token_output`). Each bucket is billed at its OWN rate, so a cost estimate
 * that multiplies one blended rate by a single token total is wrong by up to
 * an order of magnitude on a cache-heavy run — which is the whole reason this
 * table exists rather than a single `$/token` constant.
 *
 * ## What is measured and what is derived
 *
 * `input` and `output` are the first-party Anthropic API list prices as
 * published in the bundled model table, sourced on the date `PRICING_TABLE_DATE`
 * carries (2026-09-09) — that constant is the SSOT, never a second date repeated
 * in this prose. `cache_read` and `cache_creation` are DERIVED from the
 * documented ephemeral-cache multipliers (read ≈ 0.1×, 5-minute write ≈ 1.25×
 * the input rate) except where a row carries a documented figure — Claude Fable
 * 5.1 publishes $0.25/MTok cache reads directly, which is NOT 0.1× its $10
 * input rate. Every row therefore declares its own `cache_source` so a reader
 * never has to guess which numbers were read off a price list and which were
 * multiplied out here.
 *
 * A row with `verified: false` carries a PLACEHOLDER: its numbers are a
 * best-effort stand-in, never a quoted price. `costUsd()` still prices such a
 * row (an estimate is more useful than a null when it is labelled), but any
 * consumer publishing a dollar figure must surface the flag.
 *
 * ## Null means UNKNOWN MODEL, never zero
 *
 * `priceFor()` and `costUsd()` return `null` for a model this table does not
 * know. `null` is an honest absence — the same discipline the token rollup
 * applies to `total_token_input`. Coercing it to `0` fabricates a free run and
 * is the single most damaging misreading of this module.
 *
 * All rates are USD per MILLION tokens.
 *
 * @module telemetry/pricing
 */

/**
 * The date the `input`/`output` rates in PRICING_TABLE were sourced.
 * Any consumer quoting a dollar figure should quote this date beside it — a
 * price without its measurement date ages silently.
 * @type {string}
 */
export const PRICING_TABLE_DATE = '2026-09-09';

/**
 * @typedef {Object} PricingRow
 * @property {number} input           - USD per 1M uncached prompt tokens.
 * @property {number} cache_read      - USD per 1M tokens served from the prompt cache.
 * @property {number} cache_creation  - USD per 1M tokens written to the prompt cache.
 * @property {number} output          - USD per 1M completion tokens.
 * @property {boolean} verified       - false ⇒ the row is a labelled placeholder, not a quoted price.
 * @property {'documented'|'derived-multiplier'} cache_source - provenance of the two cache rates.
 */

/**
 * Per-model USD-per-million-token rates.
 * @type {Readonly<Record<string, PricingRow>>}
 */
export const PRICING_TABLE = Object.freeze({
  // Claude Fable 5.1 — $10 / $50 list; cache reads documented at $0.25/MTok
  // (NOT the usual 0.1× multiplier), cache writes derived at 1.25× input.
  'claude-fable-5-1': Object.freeze({
    input: 10.0,
    cache_read: 0.25,
    cache_creation: 12.5,
    output: 50.0,
    verified: true,
    cache_source: 'documented',
  }),
  'claude-opus-5': Object.freeze({
    input: 5.0,
    cache_read: 0.5,
    cache_creation: 6.25,
    output: 25.0,
    verified: true,
    cache_source: 'derived-multiplier',
  }),
  'claude-sonnet-5': Object.freeze({
    input: 2.0,
    cache_read: 0.2,
    cache_creation: 2.5,
    output: 10.0,
    verified: true,
    cache_source: 'derived-multiplier',
  }),
  'claude-haiku-4-5': Object.freeze({
    input: 1.0,
    cache_read: 0.1,
    cache_creation: 1.25,
    output: 5.0,
    verified: true,
    cache_source: 'derived-multiplier',
  }),
});

/**
 * Explicit aliases for model ids that appear in transcripts but are not the
 * canonical table key — dated snapshots and the `[1m]` context-window suffix
 * the harness stamps on long-context sessions.
 * @type {Readonly<Record<string, string>>}
 */
export const MODEL_ALIASES = Object.freeze({
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
  'claude-opus-5[1m]': 'claude-opus-5',
  'claude-fable-5-1[1m]': 'claude-fable-5-1',
  'claude-sonnet-5[1m]': 'claude-sonnet-5',
});

/**
 * Look up the rate row for a model id.
 *
 * Resolution order: exact key → explicit alias → longest matching table key
 * that the id starts with (so `claude-opus-5-20260401` and `claude-opus-5[1m]`
 * both resolve to `claude-opus-5`). Longest-prefix wins so a future
 * `claude-opus-5-1` row is never shadowed by `claude-opus-5`.
 *
 * @param {string|null|undefined} modelId
 * @returns {PricingRow|null} the row, or null when the model is UNKNOWN
 *   (never a zero-rate row — see the module header).
 */
export function priceFor(modelId) {
  if (typeof modelId !== 'string') return null;
  const id = modelId.trim();
  if (!id) return null;

  if (Object.hasOwn(PRICING_TABLE, id)) return PRICING_TABLE[id];

  const aliased = MODEL_ALIASES[id];
  if (aliased && Object.hasOwn(PRICING_TABLE, aliased)) return PRICING_TABLE[aliased];

  let best = null;
  for (const key of Object.keys(PRICING_TABLE)) {
    if (id.startsWith(key) && (best === null || key.length > best.length)) best = key;
  }
  return best === null ? null : PRICING_TABLE[best];
}

/**
 * Non-negative finite number within the exactly-representable integer range,
 * else 0. Absent is 0 — an absent bucket costs nothing; an unknown MODEL is what
 * yields null (in costUsd, not here).
 *
 * The `MAX_SAFE_INTEGER` ceiling is not pedantry: a corrupt bucket of `1e308`
 * is finite, so it passed the old guard and multiplied out to `Infinity`, which
 * `JSON.stringify` writes as `null` — the exact encoding this module reserves
 * for "unknown model". A token count above 2^53 is not a measurement.
 *
 * @param {unknown} n
 * @returns {number}
 */
function num(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER
    ? n
    : 0;
}

/**
 * Estimate the USD cost of one record's four token buckets.
 *
 * Each bucket is multiplied by ITS OWN rate — a cache read is ~10× cheaper
 * than an uncached prompt token and a cache write ~1.25× more expensive, so a
 * blended rate is not an approximation of this, it is a different number.
 *
 * @param {object} opts
 * @param {string|null|undefined} opts.model            - model id from the transcript
 * @param {number|null|undefined} opts.tokenInputUncached
 * @param {number|null|undefined} opts.tokenCacheRead
 * @param {number|null|undefined} opts.tokenCacheCreation
 * @param {number|null|undefined} opts.tokenOutput
 * @returns {number|null} USD cost, or `null` when the model is UNKNOWN.
 *   **null means "unknown model", never 0.** A caller that coerces it to 0
 *   reports a free run that was not free.
 */
export function costUsd({
  model,
  tokenInputUncached,
  tokenCacheRead,
  tokenCacheCreation,
  tokenOutput,
} = {}) {
  const row = priceFor(model);
  if (row === null) return null;
  const perToken = 1e-6;
  const cost =
    num(tokenInputUncached) * row.input * perToken +
    num(tokenCacheRead) * row.cache_read * perToken +
    num(tokenCacheCreation) * row.cache_creation * perToken +
    num(tokenOutput) * row.output * perToken;
  // Belt and braces beside `num()`'s ceiling: a non-finite total would serialise
  // as JSON `null` and be indistinguishable from "unknown model". Returning null
  // deliberately makes that reading TRUE rather than accidental.
  return Number.isFinite(cost) ? cost : null;
}
