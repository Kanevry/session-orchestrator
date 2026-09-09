/**
 * session-token-rollup.mjs — session-level token aggregation from subagents.jsonl.
 *
 * Reads `.orchestrator/metrics/subagents.jsonl` (or a caller-supplied path),
 * filters to a given `parent_session_id`, and sums `token_input` /
 * `token_output` across the records whose token fields are TRUSTWORTHY — see
 * § Token provenance below, which is the whole reason this module is not a
 * two-line sum.
 *
 * Design notes:
 * - Pure function — no top-level side effects, no writes.
 * - File-absent or all-null-token sessions return a sentinel shape with null
 *   totals (not 0) so callers can distinguish "session had no token data" from
 *   "session was genuinely free / cost $0".
 * - Malformed JSONL lines are silently skipped (resilience over strictness).
 * - `subagents_with_tokens` counts distinct agent_ids that have at least one
 *   TOKEN-BEARING record (coverage metric).
 *
 * ## Token provenance — why a bare Σ over token_input is wrong (#949)
 *
 * Two record classes in this ledger carry a `token_input` that must NEVER be
 * summed, and both look identical to a naive reader:
 *
 * 1. **Pre-#949 records** (written before 2026-07-31). The producer read the
 *    PARENT session transcript instead of the subagent's own, so every stop
 *    record carries the parent's running totals. Summing them counts the parent
 *    once per subagent. `hooks/subagent-telemetry.mjs` § TOKEN-DATA PROVENANCE
 *    states the consumer obligation outright: "Consumers MUST discard token_* on
 *    every stop record written before this fix landed."
 * 2. **Phantom stops** (#939). The harness fires `SubagentStop` for an ephemeral
 *    agent class that never fires `SubagentStart` and for which no subagent ever
 *    existed. These carry null tokens today — harmless to sum, but they inflate
 *    any coverage ratio computed against `matched_records`.
 *
 * `subagent_transcript_found === true` settles both at once and is the flag the
 * producer writes for exactly this purpose. It is a sufficient cutoff on its own:
 * the field did not exist before the #949 fix, so `=== true` excludes every
 * pre-fix record without needing a date comparison.
 *
 * Measured over this repo's ledger on 2026-08-11 (3,981 records / 116 sessions):
 * 73 sessions summed to 96,148,781 tokens that no agent ever spent — every one of
 * them a pre-#949 parent total. Under this filter those sessions correctly report
 * null ("no token data") instead.
 *
 *   jq -r 'select(.event=="stop" and .subagent_transcript_found==true and .token_input==null)' \
 *     .orchestrator/metrics/subagents.jsonl | wc -l     # → 0
 *
 * i.e. the flag never excludes a record that genuinely had tokens.
 *
 * FORWARD-ONLY. Session totals already written into `sessions.jsonl` by the
 * unfiltered recipe are NOT recomputed — that ledger is append-only and the
 * transcripts that produced the oldest records have aged out, so a rewrite would
 * be reconstruction, not correction. Consumers comparing token totals across the
 * 2026-08-11 boundary must treat it as a series break.
 *
 * ## Schema-version boundary — v1 and v2 token_input are different quantities (#1244)
 *
 * Since 2026-09-09 (`schema_version: 2`) a stop record's `token_input` is
 * BILLABLE PROMPT VOLUME — uncached + cache_read + cache_creation — where v1
 * held raw `usage.input_tokens` only. Under prompt caching those differ by up
 * to five orders of magnitude (measured: 56 vs 3,676,179 on one agent), so
 * summing them together produces a number describing neither. This module
 * therefore sums ONLY `schema_version >= 2` token-bearing records into
 * `total_token_*` and reports the excluded ones as `legacy_v1_records`: the
 * boundary is DECLARED, never silent.
 *
 * `total_cost_usd` is computed per record via `costUsd()` and is null when ANY
 * priced record carries a model the price table does not know — a partial cost
 * is worse than no cost, because it reads as a complete one. `cost_records_priced`
 * / `cost_records_total` say how much of the session the estimate covers.
 *
 * @module session-token-rollup
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { costUsd } from './telemetry/pricing.mjs';

// ---------------------------------------------------------------------------
// Default subagents.jsonl path (relative to cwd, mirroring the rest of the
// metrics layer which uses process.cwd() + relative paths).
// ---------------------------------------------------------------------------
const DEFAULT_SUBAGENTS_PATH = '.orchestrator/metrics/subagents.jsonl';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Is this record's token data trustworthy enough to sum? (#949)
 *
 * The producer sets `subagent_transcript_found: true` only when it located and
 * read the subagent's OWN transcript. Every other shape — a phantom stop, a
 * start record, or any record written before the flag existed — is excluded.
 * See the module header § Token provenance for why this single flag is a
 * sufficient cutoff and what it costs to omit it.
 *
 * @param {object} record — a parsed subagents.jsonl record
 * @returns {boolean}
 */
function isTokenBearing(record) {
  return record?.subagent_transcript_found === true;
}

/**
 * Is this record inside the schema_version 2 token contract? (#1244)
 * @param {object} record
 * @returns {boolean}
 */
function isV2(record) {
  return typeof record?.schema_version === 'number' && record.schema_version >= 2;
}

/**
 * @typedef {Object} TokenRollupResult
 * @property {number|null} total_token_input  - Sum of token_input across TOKEN-BEARING matched records; null when none had a non-null value.
 * @property {number|null} total_token_output - Sum of token_output across TOKEN-BEARING matched records; null when none had a non-null value.
 * @property {number}      subagents_with_tokens - Count of distinct agent_ids with at least one token-bearing record. This is the numerator of the honest coverage ratio.
 * @property {number}      matched_records    - Total count of JSONL records matched by parentSessionId. Counts start records, phantom stops and pre-#949 records alike, so it is NOT the denominator for a token-coverage ratio — dividing by it is what made healthy sessions read as 12% covered.
 * @property {number|null}  total_token_input_uncached - Sum of token_input_uncached across v2 token-bearing records.
 * @property {number|null}  total_token_cache_read     - Sum of token_cache_read across v2 token-bearing records.
 * @property {number|null}  total_token_cache_creation - Sum of token_cache_creation across v2 token-bearing records.
 * @property {number|null}  total_cost_usd     - Σ costUsd() over v2 token-bearing records; null when ANY of them carries an unknown model (never 0 — see telemetry/pricing.mjs).
 * @property {number}       cost_records_priced - How many token-bearing records the price table could price.
 * @property {number}       cost_records_total  - How many token-bearing records were candidates for pricing.
 * @property {number}       legacy_v1_records  - Token-bearing records EXCLUDED from every total above because their schema_version < 2 (their token_input is a different quantity).
 * @property {2}            _token_schema      - The token contract these totals were computed under.
 */

/**
 * Aggregate token usage from subagents.jsonl for a single session.
 *
 * @param {object} opts
 * @param {string} opts.parentSessionId  - The UUID to filter on (`parent_session_id` field in JSONL).
 * @param {string} [opts.subagentsPath]  - Absolute or cwd-relative path to subagents.jsonl.
 *   Defaults to `.orchestrator/metrics/subagents.jsonl`.
 * @returns {TokenRollupResult}
 */
export function rollupSessionTokens({
  parentSessionId,
  subagentsPath = DEFAULT_SUBAGENTS_PATH,
}) {
  /** @type {TokenRollupResult} */
  const ZERO = {
    total_token_input: null,
    total_token_output: null,
    subagents_with_tokens: 0,
    matched_records: 0,
    total_token_input_uncached: null,
    total_token_cache_read: null,
    total_token_cache_creation: null,
    total_cost_usd: null,
    cost_records_priced: 0,
    cost_records_total: 0,
    legacy_v1_records: 0,
    _token_schema: 2,
  };

  if (typeof parentSessionId !== 'string' || parentSessionId.length === 0) {
    return { ...ZERO };
  }

  // Resolve path — support both absolute and cwd-relative.
  const resolvedPath = resolve(process.cwd(), subagentsPath);

  // Read the file; absent file is a valid state (sparse early sessions).
  let raw;
  try {
    raw = readFileSync(resolvedPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ...ZERO };
    }
    throw err;
  }

  // Parse JSONL — skip malformed lines, filter to parentSessionId.
  const lines = raw.split('\n');
  const matched = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      // Malformed line — skip silently.
      continue;
    }
    if (record && record.parent_session_id === parentSessionId) {
      matched.push(record);
    }
  }

  if (matched.length === 0) {
    return { ...ZERO };
  }

  // Aggregate — skip null/undefined token values.
  let sumInput = null;
  let sumOutput = null;
  let sumUncached = null;
  let sumCacheRead = null;
  let sumCacheCreation = null;
  let sumCost = null;
  let costPriced = 0;
  let costTotal = 0;
  let costUnknownModel = false;
  let legacyV1 = 0;

  // Track distinct agent_ids that contributed at least one non-null token.
  const agentsWithTokens = new Set();

  const addNonNegative = (acc, value) =>
    typeof value === 'number' && value >= 0 ? (acc ?? 0) + value : acc;

  for (const record of matched) {
    // Provenance gate (#949) — a record whose tokens describe the PARENT
    // transcript, or no transcript at all, contributes nothing. Skipping it
    // entirely (rather than treating its values as 0) preserves the null
    // sentinel: a session of only untrustworthy records reports "no data",
    // which is true, instead of a fabricated 0.
    if (!isTokenBearing(record)) continue;

    // Schema gate (#1244) — a v1 record's token_input is raw uncached input,
    // a different quantity from a v2 record's billable prompt volume. Count it
    // so the boundary is visible, never sum it.
    if (!isV2(record)) {
      legacyV1 += 1;
      continue;
    }

    const inp = record.token_input;
    const out = record.token_output;

    sumInput = addNonNegative(sumInput, inp);
    sumOutput = addNonNegative(sumOutput, out);
    sumUncached = addNonNegative(sumUncached, record.token_input_uncached);
    sumCacheRead = addNonNegative(sumCacheRead, record.token_cache_read);
    sumCacheCreation = addNonNegative(sumCacheCreation, record.token_cache_creation);

    // Count this agent as having tokens if either field is a non-null number.
    const hasTokens =
      (typeof inp === 'number' && inp >= 0) || (typeof out === 'number' && out >= 0);
    if (hasTokens) {
      if (record.agent_id !== undefined && record.agent_id !== null) {
        agentsWithTokens.add(record.agent_id);
      }

      // Cost: every token-bearing v2 record is a pricing candidate. One unknown
      // model poisons the SESSION total — a cost covering some of the agents
      // reads as covering all of them.
      costTotal += 1;
      const cost = costUsd({
        model: record.model,
        tokenInputUncached: record.token_input_uncached,
        tokenCacheRead: record.token_cache_read,
        tokenCacheCreation: record.token_cache_creation,
        tokenOutput: record.token_output,
      });
      if (cost === null) {
        costUnknownModel = true;
      } else {
        costPriced += 1;
        sumCost = (sumCost ?? 0) + cost;
      }
    }
  }

  return {
    total_token_input: sumInput,
    total_token_output: sumOutput,
    subagents_with_tokens: agentsWithTokens.size,
    matched_records: matched.length,
    total_token_input_uncached: sumUncached,
    total_token_cache_read: sumCacheRead,
    total_token_cache_creation: sumCacheCreation,
    total_cost_usd: costUnknownModel ? null : sumCost,
    cost_records_priced: costPriced,
    cost_records_total: costTotal,
    legacy_v1_records: legacyV1,
    _token_schema: 2,
  };
}
