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

/**
 * Current events.jsonl record schema version (#1177). Mirrors
 * `subagents-schema.mjs § CURRENT_SCHEMA_VERSION`.
 *
 * Records written before #1177 carry NO `schema_version` key at all; an absent
 * key therefore reads as "pre-versioned", never as version 0. Stamping is
 * strictly additive — see `stampEventSchemaVersion()`.
 */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * Thrown by `emitEvent()` when a record fails `validateEventRecord()`.
 *
 * Carries the individual validator messages so a CLI/hook caller can surface
 * them without re-running the validator.
 */
export class EventValidationError extends Error {
  /**
   * @param {string} message — human-readable summary.
   * @param {string[]} [errors=[]] — the validator's individual error strings.
   * @param {string} [eventType] — the offending event name, when known.
   */
  constructor(message, errors = [], eventType) {
    super(message);
    this.name = 'EventValidationError';
    this.errors = errors;
    this.eventType = eventType;
  }
}

/**
 * Return a shallow copy of `record` with `schema_version` stamped to
 * `CURRENT_SCHEMA_VERSION` — but ONLY when the field is absent
 * (`undefined`/`null`). An existing value is never overwritten, so a caller
 * (or a migration re-writing historical records) keeps authority over its own
 * version field.
 *
 * @param {object} record
 * @returns {object} shallow copy, `schema_version` guaranteed present.
 */
export function stampEventSchemaVersion(record) {
  const out = { ...record };
  if (out.schema_version === undefined || out.schema_version === null) {
    out.schema_version = CURRENT_SCHEMA_VERSION;
  }
  return out;
}

/** ISO-8601 UTC timestamp with trailing Z (e.g. 2026-05-28T14:35:13.123Z). */
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

// ---------------------------------------------------------------------------
// Rotation-archive naming contract (#1401)
// ---------------------------------------------------------------------------
//
// These four live HERE, in the pure module, and not beside the rotation writer
// that produces them — deliberately, and measured. `events-rotation.mjs`
// imports `node:fs`; when `events.mjs` (the reader) imported the constants
// from it, `generate-hook-import-set.mjs` went from `reachable_from:
// ["on-session-start.mjs"]` to SEVENTEEN hooks, including the per-Edit/per-Bash
// hot paths (`enforce-scope`, `pre-task-scope-disjoint`, `post-edit-validate`).
// A naming CONTRACT shared by a writer and a reader belongs in the zero-fs
// module both already load; only the fs code stays behind. Same reasoning as
// `session-lock-shape.mjs` (`.claude/rules/identity-and-locks.md`).

/** Event name written as the first line of the new active file after a rotation. */
export const ROTATION_EVENT = 'orchestrator.events.rotated';

/** Directory (beside the active log) that holds rotated archives. */
export const ARCHIVE_DIR_NAME = '_archive';

/**
 * Exact shape of a rotation archive: `events-<first>_<last>.jsonl`, each stamp
 * `YYYYMMDDTHHMMSSZ`, with an optional `-<n>` collision suffix.
 *
 * Deliberately tight, because the same regex decides what the pruner may
 * DELETE. `_archive/` is a shared human-facing directory — this repo's own copy
 * already holds a hand-placed `events-worktree-vault-session-analysis-<date>.jsonl`
 * — and a loose `^events-.*\.jsonl$` would both merge that file into the ledger
 * timeline and offer it up for pruning. Rotation deletes only what it made.
 */
export const ARCHIVE_NAME_RE =
  /^events-(?:\d{8}T\d{6}Z|unknown)_\d{8}T\d{6}Z(?:-\d+)?\.jsonl$/;

/** Upper bound of the legacy `.1`..`.N` ring (`max-backups` is capped at 20). */
export const LEGACY_RING_MAX = 20;

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
 * Split raw JSONL text into records, COUNTING the lines that could not be read.
 *
 * The counting is the point (#1401). Skipping an unreadable line is right — a
 * torn tail from a killed writer must not abort a whole window read — but
 * skipping it SILENTLY turns a partial result into a clean verdict: a join over
 * the ledger then reports "everything matched" in the very instrument built to
 * surface silent failure. So the count travels with the records and every
 * consumer is expected to carry it into its own report and telemetry (HR-105).
 *
 * What counts as malformed here is UNREADABLE, not invalid: a line that is not
 * JSON, or that parses to something other than a plain object. A readable
 * record that `validateEventRecord()` would reject (bad timestamp, illegal
 * event name) is a DIFFERENT class and is returned in `records` — the two must
 * not be conflated, or a schema violation would hide inside a corruption count.
 * Blank lines are neither: a trailing newline is the normal shape of a JSONL
 * file, so an empty line is skipped without being counted.
 *
 * @param {string} text — raw file contents.
 * @returns {{records: object[], malformedLines: number}}
 */
export function parseEventLines(text) {
  const records = [];
  let malformedLines = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      malformedLines += 1;
      continue;
    }
    records.push(parsed);
  }
  return { records, malformedLines };
}

/**
 * Earliest and latest VALID timestamp across `records` — `null` for each when
 * no record carries a parseable one.
 *
 * Compared on `Date.parse`, not lexicographically: ISO-8601 UTC strings sort by
 * string order ONLY while their millisecond part is uniform, and this stream
 * carries both spellings (`…:13Z` and `…:13.123Z`). `Z` (0x5A) sorts after `.`
 * (0x2E), so the millisecond-free form of the SAME second would compare as the
 * later instant.
 *
 * `null` means "no parseable timestamp in this set" — an honest absence, never
 * a fabricated epoch.
 *
 * @param {object[]} records
 * @returns {{firstTs: string|null, lastTs: string|null}}
 */
export function summarizeEventRecords(records) {
  let firstTs = null;
  let lastTs = null;
  let firstMs = Infinity;
  let lastMs = -Infinity;
  for (const record of records ?? []) {
    if (!isIso8601(record?.timestamp)) continue;
    const ms = Date.parse(record.timestamp);
    if (ms < firstMs) {
      firstMs = ms;
      firstTs = record.timestamp;
    }
    if (ms > lastMs) {
      lastMs = ms;
      lastTs = record.timestamp;
    }
  }
  return { firstTs, lastTs };
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
