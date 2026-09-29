/**
 * pricing.mjs — USD price table for token-bucket cost estimation (#1244, #1470).
 *
 * The subagent ledger records four token buckets per stop record
 * (`token_input_uncached`, `token_cache_read`, `token_cache_creation`,
 * `token_output`). Each bucket is billed at its OWN rate, so a cost estimate
 * that multiplies one blended rate by a single token total is wrong by up to
 * an order of magnitude on a cache-heavy run — which is the whole reason this
 * table exists rather than a single `$/token` constant.
 *
 * ## Every rate is a documented figure
 *
 * All four rates of every row are first-party Anthropic API list prices, read
 * off the price page each row names in `source_url` on the date
 * `PRICING_TABLE_DATE` carries — that constant is the SSOT, never a second date
 * repeated in this prose. Nothing here is multiplied out. `cache_read` in
 * particular is never derived from `input`: the ratio is not a constant (Opus
 * 5.5 reads at 0.05× its input rate, Fable 5.1 at 0.025×, Fable 5 at 0.1×), so
 * a multiplier would misprice exactly the cache-heavy runs this table exists
 * for. Each row carries its own provenance fields, so a consumer quoting a
 * dollar figure can cite where it came from without reading this file.
 *
 * `verified: false` would mark a PLACEHOLDER row — a best-effort stand-in,
 * never a quoted price. No current row carries it; a consumer publishing a
 * dollar figure must still surface the flag.
 *
 * ## Only exact ids resolve
 *
 * `priceFor()` accepts an exact table key or an explicit `MODEL_ALIASES` entry
 * and nothing else. Until #1470 it fell back to the longest table key an id
 * started with, which handed an unlisted generation the rates of its nearest
 * neighbour, marked verified.
 *
 * ## Series break (#1470, 2026-09-29)
 *
 * Session reports written before this fix priced records through that
 * fallback: `claude-opus-5-5` at `claude-opus-5` rates, `claude-sonnet-5-5` at
 * `claude-sonnet-5` rates (identical numbers, by coincidence rather than
 * evidence), and `claude-fable-5` / `claude-opus-4-8` not at all. Nothing
 * rewrites that history — the metrics ledgers are append-only. Measured
 * 2026-09-29: 0 of the 9 priced sessions.jsonl reports in this repo contained
 * such records (the first one reached subagents.jsonl after the last priced
 * report was written).
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
 * The date the rates in PRICING_TABLE were read off the price page. Every row's
 * `checked_at` equals it. Any consumer quoting a dollar figure should quote this
 * date beside it — a price without its measurement date ages silently.
 * @type {string}
 */
export const PRICING_TABLE_DATE = '2026-09-29';

/**
 * @typedef {Object} PricingRow
 * @property {number} input           - USD per 1M uncached prompt tokens.
 * @property {number} cache_read      - USD per 1M tokens served from the prompt cache.
 * @property {number} cache_creation  - USD per 1M tokens written to the prompt cache
 *   (the `cache_write_ttl` rate).
 * @property {number} output          - USD per 1M completion tokens.
 * @property {boolean} verified       - false ⇒ the row is a labelled placeholder, not a quoted price.
 * @property {'documented'|'derived-multiplier'} cache_source - provenance of the two cache rates.
 *   Every current row is 'documented'; 'derived-multiplier' is kept for a future row whose cache
 *   rates are multiplied out and must say so.
 * @property {string} source_url      - the page all four rates were read from.
 * @property {string} checked_at      - ISO date the rates were read; equals PRICING_TABLE_DATE.
 * @property {'anthropic'} provider
 * @property {'5m'} cache_write_ttl   - which cache-write rate `cache_creation` is.
 * @property {string} unit            - 'USD per 1M tokens'.
 * @property {string} surface         - the billing surface and speed the rates apply to.
 * @property {'standard'} tier        - the service tier the rates apply to.
 */

/** Provenance shared by every current row — all read off one page on one date. */
const PROVENANCE = Object.freeze({
  verified: true,
  cache_source: 'documented',
  source_url: 'https://platform.claude.com/docs/en/about-claude/pricing',
  checked_at: PRICING_TABLE_DATE,
  provider: 'anthropic',
  cache_write_ttl: '5m',
  unit: 'USD per 1M tokens',
  surface: 'Claude API (first-party), standard speed',
  tier: 'standard',
});

/**
 * One frozen documented row: four USD rates plus the shared provenance. The
 * rates are spread last, so provenance can never overwrite a price.
 * @param {{input: number, cache_read: number, cache_creation: number, output: number}} rates
 * @returns {PricingRow}
 */
function usd(rates) {
  return Object.freeze({ ...PROVENANCE, ...rates });
}

/**
 * Per-model USD-per-million-token rates.
 * @type {Readonly<Record<string, PricingRow>>}
 */
export const PRICING_TABLE = Object.freeze({
  // Ceiling: only the 5-minute cache-write rate is priced; a 1-hour write costs 2× input
  // (Opus 5.5: $8/MTok) and would be under-priced here. Measured 2026-09-29 over 803,788
  // assistant usage blocks in 10,745 subagent transcripts: `usage.cache_creation
  // .ephemeral_1h_input_tokens > 0` on 0 blocks. Revisit when the first such block appears.
  //
  // Ceiling: list price only — fast mode, `inference_geo: "us"` (1.1×) and batch discounts are
  // not modelled. Measured 2026-09-29: `usage.speed` = "fast" on 0 of the 374,331 blocks that
  // carry the field; `inference_geo` = "not_available" on 803,479 and no other value seen.
  // Revisit when either field shows another value.
  //
  // Ceiling: a model absent from this table prices as null, never at a neighbour's rate, so the
  // rollup reports `total_cost_usd: null` and `cost_records_priced < cost_records_total` — the
  // intended way missing evidence shows up. Revisit when that ratio drops below 1: add the model
  // as its own evidenced row, never as a family prefix or an alias to another generation.
  'claude-fable-5-1': usd({ input: 10.0, cache_read: 0.25, cache_creation: 12.5, output: 50.0 }),
  'claude-fable-5': usd({ input: 10.0, cache_read: 1.0, cache_creation: 12.5, output: 50.0 }),
  'claude-opus-5-5': usd({ input: 4.0, cache_read: 0.2, cache_creation: 5.0, output: 20.0 }),
  'claude-opus-5': usd({ input: 5.0, cache_read: 0.5, cache_creation: 6.25, output: 25.0 }),
  'claude-opus-4-8': usd({ input: 5.0, cache_read: 0.5, cache_creation: 6.25, output: 25.0 }),
  'claude-sonnet-5-5': usd({ input: 2.0, cache_read: 0.2, cache_creation: 2.5, output: 10.0 }),
  'claude-sonnet-5': usd({ input: 2.0, cache_read: 0.2, cache_creation: 2.5, output: 10.0 }),
  'claude-haiku-4-5': usd({ input: 1.0, cache_read: 0.1, cache_creation: 1.25, output: 5.0 }),
});

/**
 * Explicit aliases for model ids that appear in transcripts but are not the
 * canonical table key — a dated snapshot of the SAME model and the `[1m]`
 * context-window suffix the harness stamps on long-context sessions. An alias
 * never points at another generation.
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
 * Resolution: exact `PRICING_TABLE` key → explicit `MODEL_ALIASES` entry → `null`,
 * after trimming surrounding whitespace.
 * Nothing else resolves — no prefix, no pattern, no family fallback — so
 * `claude-opus-5-20260401`, `claude-opus-5-99` and `claude-haiku-4-5-20251002` are
 * all UNKNOWN even though each starts with a table key.
 *
 * Why no prefix: from the 4.6 generation on, Anthropic ships dateless pinned
 * model ids (https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions,
 * retrieved 2026-09-29). The ids that extend a current table key are therefore
 * other generations, not snapshots of it — `claude-opus-5-5` extends
 * `claude-opus-5` — and a prefix match priced them at another generation's
 * rates, marked verified (#1470). A future generation gets its own evidenced
 * row, never a family prefix.
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

  if (Object.hasOwn(MODEL_ALIASES, id) && Object.hasOwn(PRICING_TABLE, MODEL_ALIASES[id])) {
    return PRICING_TABLE[MODEL_ALIASES[id]];
  }
  return null;
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
 * Each bucket is multiplied by ITS OWN rate — depending on the row, a cache
 * read costs a tenth to a fortieth of an uncached prompt token and a 5-minute
 * cache write 1.25× as much, so a blended rate is not an approximation of
 * this, it is a different number.
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
