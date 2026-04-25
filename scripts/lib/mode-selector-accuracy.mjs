/**
 * mode-selector-accuracy.mjs — Mode-Selector feedback-loop helper (Phase B-4, issue #294).
 *
 * After session-start renders a Mode-Selector recommendation and the user
 * confirms or overrides it, call `recordAccuracy({recommended, chosen, sessionId})`
 * to append a `mode-selector-accuracy` learning to the project's learnings.jsonl.
 *
 * Lifecycle (handled by skills/evolve + skills/session-end on subsequent reads,
 * NOT by this helper):
 *   - Same (type, subject) seen again → +0.15 confidence (confirmed)
 *   - Contradicted by new evidence  → -0.20 confidence
 *
 * Subject pattern encodes the outcome class:
 *   `<recommended>-selected-vs-<chosen>`
 *
 * Examples:
 *   recommended=feature, chosen=feature → "feature-selected-vs-feature"  (agreement)
 *   recommended=feature, chosen=deep    → "feature-selected-vs-deep"     (override)
 *
 * Same-pair recurrence in future sessions hits the dedupe path in evolve and
 * confirms; novel pairs land at confidence 0.5 and accumulate from there.
 *
 * AC contract (from issue #294):
 *  - Learning written only when user actively chooses (caller decides).
 *  - Confidence starts at 0.5 (initial value; lifecycle handles increment/decrement).
 *  - No-op when `recommended` is null/undefined (selector did not render a banner).
 *
 * The helper is a thin wrapper around `appendLearning` from `learnings.mjs`. It
 * never throws on validation issues — those bubble back to the caller as a
 * resolved-error return value (`{ok: false, reason}`) so session-start can
 * log to sweep.log without halting the session.
 */

import { appendLearning } from './learnings.mjs';
import { isValidMode } from './recommendations-v0.mjs';

export const LEARNING_TYPE = 'mode-selector-accuracy';
export const INITIAL_CONFIDENCE = 0.5;
export const DEFAULT_EXPIRY_DAYS = 30;

/**
 * Build the canonical subject string for a (recommended, chosen) pair.
 * @param {string} recommended
 * @param {string} chosen
 * @returns {string}
 */
export function buildSubject(recommended, chosen) {
  return `${recommended}-selected-vs-${chosen}`;
}

/**
 * Record a Mode-Selector accuracy learning.
 *
 * @param {{
 *   recommended: string|null,
 *   chosen: string,
 *   sessionId: string,
 *   filePath?: string,
 *   nowMs?: number,
 *   expiryDays?: number,
 *   confidence?: number,
 * }} opts
 * @returns {Promise<{ok: true, entry: object} | {ok: false, reason: string}>}
 */
export async function recordAccuracy(opts) {
  const recommended = opts?.recommended;
  const chosen = opts?.chosen;
  const sessionId = opts?.sessionId;
  const filePath = opts?.filePath || '.orchestrator/metrics/learnings.jsonl';

  // No-op when the selector did not render a recommendation (banner suppressed,
  // confidence 0.0, etc). Caller passes recommended=null in that case.
  if (recommended === null || recommended === undefined || recommended === '') {
    return { ok: false, reason: 'no-recommendation' };
  }
  if (typeof recommended !== 'string' || typeof chosen !== 'string') {
    return { ok: false, reason: 'invalid-mode-type' };
  }
  if (!isValidMode(recommended) || !isValidMode(chosen)) {
    return { ok: false, reason: 'unknown-mode' };
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { ok: false, reason: 'missing-session-id' };
  }

  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const expiryDays = Number.isInteger(opts.expiryDays) && opts.expiryDays > 0
    ? opts.expiryDays
    : DEFAULT_EXPIRY_DAYS;
  const confidence = typeof opts.confidence === 'number'
    ? opts.confidence
    : INITIAL_CONFIDENCE;

  const subject = buildSubject(recommended, chosen);
  const agreement = recommended === chosen;
  const insight = agreement
    ? `User confirmed Mode-Selector recommendation (${recommended}).`
    : `User overrode Mode-Selector recommendation (${recommended}) with ${chosen}.`;

  const created_at = new Date(nowMs).toISOString();
  const expires_at = new Date(nowMs + expiryDays * 86_400_000).toISOString();

  const entry = {
    id: `${LEARNING_TYPE}-${subject}-${sessionId}`,
    type: LEARNING_TYPE,
    subject,
    insight,
    evidence: [`${sessionId}: recommended=${recommended} chosen=${chosen}`],
    confidence,
    source_session: sessionId,
    created_at,
    expires_at,
  };

  try {
    const validated = await appendLearning(filePath, entry);
    return { ok: true, entry: validated };
  } catch (err) {
    return { ok: false, reason: `append-failed: ${err?.message ?? String(err)}` };
  }
}
