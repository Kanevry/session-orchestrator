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
 * @module session-token-rollup
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
 * @typedef {Object} TokenRollupResult
 * @property {number|null} total_token_input  - Sum of token_input across TOKEN-BEARING matched records; null when none had a non-null value.
 * @property {number|null} total_token_output - Sum of token_output across TOKEN-BEARING matched records; null when none had a non-null value.
 * @property {number}      subagents_with_tokens - Count of distinct agent_ids with at least one token-bearing record. This is the numerator of the honest coverage ratio.
 * @property {number}      matched_records    - Total count of JSONL records matched by parentSessionId. Counts start records, phantom stops and pre-#949 records alike, so it is NOT the denominator for a token-coverage ratio — dividing by it is what made healthy sessions read as 12% covered.
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

  // Track distinct agent_ids that contributed at least one non-null token.
  const agentsWithTokens = new Set();

  for (const record of matched) {
    // Provenance gate (#949) — a record whose tokens describe the PARENT
    // transcript, or no transcript at all, contributes nothing. Skipping it
    // entirely (rather than treating its values as 0) preserves the null
    // sentinel: a session of only untrustworthy records reports "no data",
    // which is true, instead of a fabricated 0.
    if (!isTokenBearing(record)) continue;

    const inp = record.token_input;
    const out = record.token_output;

    if (typeof inp === 'number' && inp >= 0) {
      sumInput = (sumInput ?? 0) + inp;
    }
    if (typeof out === 'number' && out >= 0) {
      sumOutput = (sumOutput ?? 0) + out;
    }

    // Count this agent as having tokens if either field is a non-null number.
    if (
      (typeof inp === 'number' && inp >= 0) ||
      (typeof out === 'number' && out >= 0)
    ) {
      if (record.agent_id !== undefined && record.agent_id !== null) {
        agentsWithTokens.add(record.agent_id);
      }
    }
  }

  return {
    total_token_input: sumInput,
    total_token_output: sumOutput,
    subagents_with_tokens: agentsWithTokens.size,
    matched_records: matched.length,
  };
}
