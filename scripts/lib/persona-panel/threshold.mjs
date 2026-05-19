/**
 * threshold.mjs — Parsed-threshold helpers for /persona-panel consolidation (#457).
 *
 * Pure module. No filesystem I/O, no async, no side effects.
 *
 * Threshold spec grammar:
 *   "M-of-N"   → m,n integers, 1 ≤ M ≤ N ≤ 20
 *   "all"      → equivalent to N-of-N at consolidation time
 *   "any"      → equivalent to 1-of-N at consolidation time
 *
 * Security guard M2 (W1-D4):
 *   - Anchored regex (^…$), no unbounded back-tracking
 *   - N hard-capped at 20 (N_MAX) — rejects absurd splits like "21-of-21"
 *   - parseInt with explicit radix 10
 *   - M=0, M>N, leading zeros, non-digit suffixes all rejected
 *
 * Examples that MUST reject (W1-D4 acceptance):
 *   "0-of-5", "6-of-5", "21-of-21", "abc", "", "5-of-", "-of-5", "5/5", "all-of-5"
 */

/**
 * Strictly anchored M-of-N matcher. `[1-9]\d?` rejects "0" prefix and "00", "05", etc.
 * The second group `[1-9]\d?` enforces the same constraint on N.
 *
 * Note: this RE is intentionally NOT exported. Consumers go through parseThreshold()
 * so all callers share the cap/relationship checks.
 */
const THRESHOLD_RE = /^([1-9]\d?)-of-([1-9]\d?)$/;

/** Hard cap on N — defense-in-depth against absurd inputs. */
const N_MAX = 20;

/**
 * Thrown by parseThreshold for any malformed input. Distinguishable from
 * generic Error via the class name so callers/tests can `instanceof` it.
 */
export class InvalidThresholdError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidThresholdError';
  }
}

/**
 * @typedef {{kind: 'm-of-n', m: number, n: number} | {kind: 'all'} | {kind: 'any'}} ParsedThreshold
 */

/**
 * Parse a threshold spec string into a normalised ParsedThreshold.
 *
 * @param {string} spec — one of: "all" | "any" | "M-of-N"
 * @returns {ParsedThreshold}
 * @throws {InvalidThresholdError} on any malformed input
 */
export function parseThreshold(spec) {
  if (typeof spec !== 'string') {
    throw new InvalidThresholdError(
      `threshold spec must be a string (got ${typeof spec})`,
    );
  }

  const trimmed = spec.trim();
  if (trimmed === '') {
    throw new InvalidThresholdError('threshold spec must not be empty');
  }

  if (trimmed === 'all') return { kind: 'all' };
  if (trimmed === 'any') return { kind: 'any' };

  const match = THRESHOLD_RE.exec(trimmed);
  if (match === null) {
    throw new InvalidThresholdError(
      `threshold spec must match "M-of-N" or be "all"/"any" (got ${JSON.stringify(spec)})`,
    );
  }

  const m = parseInt(match[1], 10);
  const n = parseInt(match[2], 10);

  // Defense-in-depth — RE already rejects 0, but the cap is the real guard here.
  if (!Number.isInteger(m) || m < 1) {
    throw new InvalidThresholdError(
      `threshold M must be a positive integer (got ${JSON.stringify(spec)})`,
    );
  }
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidThresholdError(
      `threshold N must be a positive integer (got ${JSON.stringify(spec)})`,
    );
  }
  if (n > N_MAX) {
    throw new InvalidThresholdError(
      `threshold N must be ≤ ${N_MAX} (got ${n} in ${JSON.stringify(spec)})`,
    );
  }
  if (m > n) {
    throw new InvalidThresholdError(
      `threshold M must be ≤ N (got ${m}-of-${n} in ${JSON.stringify(spec)})`,
    );
  }

  return { kind: 'm-of-n', m, n };
}

/**
 * Test whether a vote tally meets a parsed threshold.
 *
 * For `all`:    pass-votes must equal total.
 * For `any`:    pass-votes must be ≥ 1.
 * For `m-of-n`: pass-votes must be ≥ m. (n is informational/audit only; the
 *               consolidator validates that the actual vote count matches n.)
 *
 * @param {ParsedThreshold} parsed
 * @param {{pass: number, total: number}} votes
 * @returns {boolean}
 */
export function thresholdMet(parsed, votes) {
  if (parsed === null || typeof parsed !== 'object') return false;
  const pass = Number.isInteger(votes?.pass) ? votes.pass : 0;
  const total = Number.isInteger(votes?.total) ? votes.total : 0;
  if (total === 0) return false;

  if (parsed.kind === 'all') return pass === total;
  if (parsed.kind === 'any') return pass >= 1;
  if (parsed.kind === 'm-of-n') return pass >= parsed.m;
  return false;
}

/** Exposed for tests + audit reporting. */
export const _N_MAX = N_MAX;
