/**
 * events-schema.mjs — canonical schema + naming-convention validator for
 * `.orchestrator/metrics/events.jsonl` records.
 *
 * The orchestrator emits ONE event stream via `emitEvent()` (see events.mjs).
 * Every record has the shape `{ timestamp, event, ...payload }`. Orchestrator-owned
 * events follow the dotted namespace `orchestrator.<domain>.<verb>` (see
 * docs/events-schema.md). Third-party / legacy event names (e.g. `tmux-layout.*`)
 * are accepted as-is — this validator only enforces the convention on the
 * `orchestrator.` namespace we own.
 *
 * Pure functions, no filesystem access — safe to import anywhere.
 */

/** ISO-8601 UTC timestamp with trailing Z (e.g. 2026-05-28T14:35:13.123Z). */
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Prefix marking an orchestrator-owned event. */
export const ORCHESTRATOR_PREFIX = 'orchestrator.';

/**
 * Dotted orchestrator-domain event name: `orchestrator.<domain>.<verb>[.<...>]`.
 * Lowercase alphanumeric segments; underscores allowed WITHIN a segment
 * (e.g. `quality_gate`, `propose_invoked`). Requires at least three segments
 * (orchestrator + domain + verb).
 */
export const ORCHESTRATOR_EVENT_RE =
  /^orchestrator\.[a-z0-9]+(?:_[a-z0-9]+)*(?:\.[a-z0-9]+(?:_[a-z0-9]+)*)+$/;

/**
 * True when `value` is an ISO-8601 UTC timestamp string that also parses to a
 * real date.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isIso8601(value) {
  return (
    typeof value === 'string' &&
    ISO_8601_RE.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/**
 * Validate a single events.jsonl record against the canonical schema.
 *
 * Rules:
 *   - record must be a plain (non-array) object;
 *   - `timestamp` is required and must be an ISO-8601 UTC string;
 *   - `event` is required and must be a non-empty string;
 *   - events in the `orchestrator.` namespace MUST match
 *     `orchestrator.<domain>.<verb>` (lowercase, dotted);
 *   - non-orchestrator event names are accepted as-is (legacy / third-party).
 *
 * @param {unknown} record
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateEventRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a non-array object'] };
  }

  const errors = [];

  if (!isIso8601(record.timestamp)) {
    errors.push('timestamp must be an ISO-8601 UTC string ending in Z');
  }

  if (typeof record.event !== 'string' || record.event.length === 0) {
    errors.push('event must be a non-empty string');
  } else if (
    record.event.startsWith(ORCHESTRATOR_PREFIX) &&
    !ORCHESTRATOR_EVENT_RE.test(record.event)
  ) {
    errors.push(
      `orchestrator-domain event "${record.event}" must match orchestrator.<domain>.<verb> (lowercase, dotted, ≥3 segments)`,
    );
  }

  return { valid: errors.length === 0, errors };
}
