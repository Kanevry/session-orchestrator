/**
 * session-token-rollup.mjs — session-level token aggregation from subagents.jsonl.
 *
 * Reads `.orchestrator/metrics/subagents.jsonl` (or a caller-supplied path),
 * filters to a given `parent_session_id`, and sums `token_input` /
 * `token_output` across all matched records, skipping null/undefined values.
 *
 * Design notes:
 * - Pure function — no top-level side effects, no writes.
 * - File-absent or all-null-token sessions return a sentinel shape with null
 *   totals (not 0) so callers can distinguish "session had no token data" from
 *   "session was genuinely free / cost $0".
 * - Malformed JSONL lines are silently skipped (resilience over strictness).
 * - `subagents_with_tokens` counts distinct agent_ids that have at least one
 *   record with a non-null token_input or token_output value (coverage metric).
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
 * @typedef {Object} TokenRollupResult
 * @property {number|null} total_token_input  - Sum of token_input across matched records; null when no record had a non-null value.
 * @property {number|null} total_token_output - Sum of token_output across matched records; null when no record had a non-null value.
 * @property {number}      subagents_with_tokens - Count of distinct agent_ids that had at least one non-null token value.
 * @property {number}      matched_records    - Total count of JSONL records matched by parentSessionId (includes null-token records).
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
