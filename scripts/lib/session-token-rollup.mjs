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
 * - `match_status` and `ledger_records` distinguish why totals are absent
 *   without interpreting the session key's shape (#1027 Nachtrag 7).
 * - Malformed JSONL lines are silently skipped (resilience over strictness).
 * - `subagents_with_tokens` counts distinct agent_ids that have at least one
 *   TOKEN-BEARING record (coverage metric); every total counts each agent once
 *   (§ One record per agent).
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
 * ## One record per agent — a stop record carries a RUNNING total
 *
 * `hooks/subagent-telemetry.mjs` re-reads the agent's WHOLE transcript at every
 * stop, so an agent that stops twice (resumed via SendMessage, for one) writes
 * its running total twice, and summing both counts the first part again. Every
 * total below therefore takes ONE v2 record per `agent_id`: its tokens come from
 * the agent's last stop that found its transcript and carried tokens, its cost
 * candidacy from its last stop that found its transcript ("last" = latest
 * `timestamp`, ties and unparseable timestamps by file order). Those two differ
 * only when the last read yielded no tokens — an oversized transcript: the
 * earlier running total is then a lower bound for the tokens and the cost is
 * unknown. Measured 2026-10-01 over the 31 local fleet ledgers (1,002 distinct
 * session/agent pairs with two or more found stops, 407 sessions): no v2 token
 * bucket ever decreased from one found stop to the next, so the last record is
 * also the largest; 2 pairs end in a token-less stop, both transcripts now past
 * the hook's 50 MiB read limit. FORWARD-ONLY like the #949 cut: totals already
 * in `sessions.jsonl` are not recomputed.
 *
 * `total_cost_usd` is computed per agent via `costUsd()` and is null whenever
 * `cost_records_priced < cost_records_total` (#1475) — a partial cost is worse
 * than no cost, because it reads as a complete one. An agent is unpriced when the
 * model of its last found record is unknown to the price table, when it has no model (a token-bearing turn
 * named none), when it has no tokens at all (transcript found but oversized,
 * without usage turns, or unreadable, #1474), or when the agent has a start
 * record but its stop found no transcript of its own and no other record of the
 * same agent did (`start_record_found: true`, `subagent_transcript_found: false`
 * — mostly `workflow-subagent`). A phantom stop (#939, no start record) is no
 * agent and no candidate. A record whose four token buckets
 * are all 0 is priced at $0 whatever its model, and never turns a null total into
 * a number on its own. A record whose turns span several models carries
 * `models_usage` (#1470) and is priced part by part. `cost_records_priced` /
 * `cost_records_total` say how much of the session the estimate covers; with
 * nothing to price (total 0) the cost is null as well.
 *
 * Blind spots the ledger cannot close: an agent whose start record lies outside
 * the hook's tail window reads `start_record_found: false` and is
 * indistinguishable from a phantom, and an agent that left neither a start nor a
 * stop record is invisible. One blind spot is a rule of this module, not the
 * ledger: a session spanning the 2026-09-09 schema boundary is priced over its v2
 * records only — its v1 records are `legacy_v1_records`, never cost candidates
 * (4 distinct fleet sessions carry such a numeric cost, 31 ledgers, 2026-10-01).
 * "Never a partial sum" holds only over the v2 agents the ledger can see.
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
 * Did a REAL agent run whose transcript the hook could not find? (#1475 follow-up)
 *
 * A stop record with a start record (`start_record_found: true`) but no own
 * transcript (`subagent_transcript_found: false`) is not a phantom: the agent
 * existed, it just left nothing to price — 813 of the 877 such records in the
 * 33 fleet ledgers are `workflow-subagent` (2026-10-01). Its cost is unknown, so it must reach
 * `cost_records_total`. A phantom stop (#939) has `start_record_found` false and
 * stays out; a record written before either flag existed matches neither.
 * @param {object} record
 * @returns {boolean}
 */
function isStartedWithoutTranscript(record) {
  return (
    record?.event === 'stop' &&
    record.start_record_found === true &&
    record.subagent_transcript_found === false
  );
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
 * Does this record carry a token count on either side?
 * @param {object} record
 * @returns {boolean}
 */
function hasTokens(record) {
  const { token_input: inp, token_output: out } = record;
  return (typeof inp === 'number' && inp >= 0) || (typeof out === 'number' && out >= 0);
}

/**
 * Was `candidate` written at a later stop than `current`? Ordered by
 * `timestamp`; a tie or an unparseable timestamp falls back to file order, and
 * the caller reads in file order, so the candidate then wins.
 * @param {object} candidate — read after `current` in the ledger
 * @param {object} current
 * @returns {boolean}
 */
function isLaterStop(candidate, current) {
  const a = Date.parse(candidate.timestamp);
  const b = Date.parse(current.timestamp);
  if (Number.isNaN(a) || Number.isNaN(b) || a === b) return true;
  return a > b;
}

/**
 * USD cost of one v2 record, or null when it cannot be priced. A record whose
 * token-bearing turns span several models carries `models_usage` (#1470): each
 * part is priced at its own model's rates, and one unknown part leaves the whole
 * record unpriced. Without that field the record's single `model` prices all
 * four buckets.
 * @param {object} record
 * @returns {number|null}
 */
function recordCostUsd(record) {
  const parts =
    Array.isArray(record.models_usage) && record.models_usage.length > 0
      ? record.models_usage
      : [record];
  let total = 0;
  for (const part of parts) {
    const cost = costUsd({
      model: part?.model,
      tokenInputUncached: part?.token_input_uncached,
      tokenCacheRead: part?.token_cache_read,
      tokenCacheCreation: part?.token_cache_creation,
      tokenOutput: part?.token_output,
    });
    if (cost === null) return null;
    total += cost;
  }
  return total;
}

/**
 * @typedef {Object} TokenRollupResult
 * @property {'invalid-key'|'ledger-absent'|'ledger-empty'|'unmatched'|'matched'} match_status - Distinguishes absent telemetry from an unmatched key (#1027 Nachtrag 7).
 * @property {number|null} ledger_records - Count of parsed non-null, non-array objects; null when the ledger was not read (#1027 Nachtrag 7).
 * @property {number|null} total_token_input  - Sum of token_input over one v2 token-bearing record per agent (its last stop that carried tokens — § One record per agent); null when none had a non-null value.
 * @property {number|null} total_token_output - Sum of token_output over the same one record per agent; null when none had a non-null value.
 * @property {number|null} total_tokens       - total_token_input + total_token_output (#1436); a null side counts as absent, null only when BOTH are null.
 * @property {number}      subagents_with_tokens - Count of distinct agent_ids with at least one token-bearing record. This is the numerator of the honest coverage ratio.
 * @property {number}      matched_records    - Total count of JSONL records matched by parentSessionId. Counts start records, phantom stops and pre-#949 records alike, so it is NOT the denominator for a token-coverage ratio — dividing by it is what made healthy sessions read as 12% covered.
 * @property {number|null}  total_token_input_uncached - Sum of token_input_uncached over the same one record per agent.
 * @property {number|null}  total_token_cache_read     - Sum of token_cache_read over the same one record per agent.
 * @property {number|null}  total_token_cache_creation - Sum of token_cache_creation over the same one record per agent.
 * @property {number|null}  total_cost_usd     - Σ cost over the agents counted in cost_records_priced; null when cost_records_priced < cost_records_total (#1475 — any unpriced candidate: unknown model, no model, no tokens, or a started agent without a transcript), null when there is nothing to price (cost_records_total 0), and null when no record with a non-zero bucket was priced (all-zero records alone never yield a fabricated $0). Never 0 for unknown — see telemetry/pricing.mjs.
 * @property {number}       cost_records_priced - How many agents of cost_records_total carry a known cost on their last found v2 record: priced by the table (per model part when the record carries models_usage, #1470), or all four token buckets 0 (priced at $0 whatever the model, #1474).
 * @property {number}       cost_records_total  - How many agents were candidates for pricing, each counted once however often it stopped: every agent with a v2 record whose own transcript was found — priced on its LAST such record, so one whose last read yielded no tokens (transcript oversized, without usage turns, or unreadable, #1474) is unpriced — plus every started agent whose v2 stops found no transcript of its own (`start_record_found: true`, `subagent_transcript_found: false`) and that has no token-bearing record in the session. Both latter kinds have an unknown cost. Phantom stops (no start record, #939) are never candidates. priced < total nulls total_cost_usd.
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
    match_status: 'invalid-key',
    ledger_records: null,
    total_token_input: null,
    total_token_output: null,
    total_tokens: null,
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
      return { ...ZERO, match_status: 'ledger-absent' };
    }
    throw err;
  }

  // Parse JSONL — skip malformed lines, filter to parentSessionId.
  const lines = raw.split('\n');
  const matched = [];
  let ledgerRecords = 0;
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
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue;
    ledgerRecords += 1;
    if (record.parent_session_id === parentSessionId) {
      matched.push(record);
    }
  }

  if (matched.length === 0) {
    return {
      ...ZERO,
      match_status: ledgerRecords === 0 ? 'ledger-empty' : 'unmatched',
      ledger_records: ledgerRecords,
    };
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
  let legacyV1 = 0;

  // Track distinct agent_ids that contributed at least one non-null token.
  const agentsWithTokens = new Set();

  const addNonNegative = (acc, value) =>
    typeof value === 'number' && value >= 0 ? (acc ?? 0) + value : acc;

  // Agents with at least one record whose own transcript WAS read. A later stop
  // of the same agent can find a transcript an earlier one missed (measured
  // 2026-10-01: 4 agents in one fleet session, `workflow-subagent` found:false
  // first, then found:true) — its cost is then known and must not null the total.
  const agentsWithTranscript = new Set(
    matched.filter(isTokenBearing).map((r) => r.agent_id).filter((id) => typeof id === 'string'),
  );

  // One agent, one count (see module header § One record per agent). Per agent:
  // `last` is its last stop that found its transcript — the cost candidate —
  // and `lastWithTokens` its last such stop that carried tokens — the token
  // contribution. They differ only when the last read yielded no tokens (an
  // oversized transcript): the earlier running total is then a known lower bound
  // for the tokens, while the cost stays unknown. A record without an agent_id
  // cannot be joined to another and stands alone.
  /** @type {Map<unknown, {last: object, lastWithTokens: object|null}>} */
  const agents = new Map();
  /** Started agents whose stops found no transcript — each counts once. */
  const startedWithoutTranscript = new Set();
  let unkeyedStartedWithoutTranscript = 0;

  for (const record of matched) {
    // Provenance gate (#949) — a record whose tokens describe the PARENT
    // transcript, or no transcript at all, contributes no TOKENS. Skipping it
    // entirely (rather than treating its values as 0) preserves the null
    // sentinel: a session of only untrustworthy records reports "no data",
    // which is true, instead of a fabricated 0.
    if (!isTokenBearing(record)) {
      // …but a v2 agent that really ran without a readable transcript has an
      // unknown cost: an unpriced candidate (total, not priced), so priced <
      // total nulls `total_cost_usd` (#1475). Phantoms never reach this branch.
      if (
        isV2(record) &&
        isStartedWithoutTranscript(record) &&
        !agentsWithTranscript.has(record.agent_id)
      ) {
        if (record.agent_id === undefined || record.agent_id === null) {
          unkeyedStartedWithoutTranscript += 1;
        } else {
          startedWithoutTranscript.add(record.agent_id);
        }
      }
      continue;
    }

    // Schema gate (#1244) — a v1 record's token_input is raw uncached input,
    // a different quantity from a v2 record's billable prompt volume. Count it
    // so the boundary is visible, never sum it.
    if (!isV2(record)) {
      legacyV1 += 1;
      continue;
    }

    const withTokens = hasTokens(record) ? record : null;
    const key = record.agent_id ?? Symbol('unkeyed');
    const seen = agents.get(key);
    if (!seen) {
      agents.set(key, { last: record, lastWithTokens: withTokens });
      continue;
    }
    // A token-bearing `last` is always `lastWithTokens` too — set together, so
    // an unparseable timestamp (no transitive order) cannot split them.
    if (isLaterStop(record, seen.last)) {
      seen.last = record;
      if (withTokens) seen.lastWithTokens = withTokens;
    } else if (withTokens && (!seen.lastWithTokens || isLaterStop(withTokens, seen.lastWithTokens))) {
      seen.lastWithTokens = withTokens;
    }
  }

  for (const [key, { last, lastWithTokens }] of agents) {
    if (lastWithTokens) {
      sumInput = addNonNegative(sumInput, lastWithTokens.token_input);
      sumOutput = addNonNegative(sumOutput, lastWithTokens.token_output);
      sumUncached = addNonNegative(sumUncached, lastWithTokens.token_input_uncached);
      sumCacheRead = addNonNegative(sumCacheRead, lastWithTokens.token_cache_read);
      sumCacheCreation = addNonNegative(sumCacheCreation, lastWithTokens.token_cache_creation);
      if (typeof key !== 'symbol') agentsWithTokens.add(key);
    }

    // Cost: every agent with a found transcript is ONE pricing candidate. One
    // unpriced agent poisons the SESSION total — a cost covering some of the
    // agents reads as covering all of them.
    costTotal += 1;
    if (last !== lastWithTokens) {
      // #1474 — the agent's last read of its own transcript yielded no tokens:
      // it exceeded the hook's MAX_TRANSCRIPT_BYTES and was not read, it held no
      // usage turns, or it was unreadable. Either way the agent ran and its cost
      // is unknown, so it counts as an unpriced candidate (total, not priced),
      // and priced < total nulls `total_cost_usd` (#1475).
      continue;
    }
    // #1474 — all four buckets 0 costs $0 whatever the model says. The hook
    // names such a record by its last turn, typically `<synthetic>`, which
    // the price table does not know; pricing it would null the session total
    // for a record that added nothing to it.
    const allZero = [
      last.token_input_uncached,
      last.token_cache_read,
      last.token_cache_creation,
      last.token_output,
    ].every((v) => v === 0);
    const cost = allZero ? 0 : recordCostUsd(last);
    if (cost !== null) {
      costPriced += 1;
      // An all-zero record adds nothing, so it must not be what turns
      // `sumCost` from null into a number: next to a token-less record it
      // would persist a fabricated $0 for a session whose real cost is unknown.
      if (!allZero) sumCost = (sumCost ?? 0) + cost;
    }
  }
  costTotal += startedWithoutTranscript.size + unkeyedStartedWithoutTranscript;

  return {
    match_status: 'matched',
    ledger_records: ledgerRecords,
    total_token_input: sumInput,
    total_token_output: sumOutput,
    // #1436 — the one figure a session-level budget compares against. Null only
    // when neither side has data; never a fabricated 0.
    total_tokens: sumInput === null && sumOutput === null ? null : (sumInput ?? 0) + (sumOutput ?? 0),
    subagents_with_tokens: agentsWithTokens.size,
    matched_records: matched.length,
    total_token_input_uncached: sumUncached,
    total_token_cache_read: sumCacheRead,
    total_token_cache_creation: sumCacheCreation,
    // #1475 — a cost that leaves out any candidate record is not persisted.
    total_cost_usd: costPriced < costTotal ? null : sumCost,
    cost_records_priced: costPriced,
    cost_records_total: costTotal,
    legacy_v1_records: legacyV1,
    _token_schema: 2,
  };
}
