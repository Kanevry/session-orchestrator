/**
 * memory-proposals/schema.mjs — schema, validation, and serialization for
 * memory proposal records.
 *
 * A proposal record is an agent-generated candidate learning that has not yet
 * been promoted to the persistent learnings store. Proposals are collected
 * during a wave, reviewed by the memory-cleanup flow, and either accepted
 * (appended to learnings.jsonl) or discarded.
 *
 * Pure leaf module — imports only node:crypto. No I/O, no quota enforcement
 * (see store.mjs for those responsibilities).
 *
 * Canonical schema (schema_version: 1) — ALL required fields:
 *   id               UUID v4 string (crypto.randomUUID())
 *   created_at       ISO 8601 UTC timestamp
 *   wave_id          string — e.g. 'W2' (sourced from STATE.md current-wave by caller)
 *   type             string — one of PROPOSAL_TYPES
 *   subject          string — 1..100 chars, no newlines
 *   insight          string — 1..2000 chars
 *   evidence         string — 1..5000 chars
 *   confidence       number — [0, 1] (0.5 floor enforced in store.mjs, not here)
 *   schema_version   1
 *
 * Optional fields:
 *   proposed_by_agent string | undefined — identifier of the submitting agent
 */

import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Current proposal record schema version.
 *
 * History:
 *  - 1: initial shape. All appends are stamped with schema_version: 1.
 */
export const SCHEMA_VERSION = 1;

/**
 * Canonical type enum — agent-writable subset of the learnings schema type set
 * defined in scripts/lib/learnings/schema.mjs (LEARNING_TTL_DAYS keys, minus
 * 'default' and analyzer-only types).
 *
 * When a proposal is promoted to a learning, its type flows through unchanged.
 * Adding a new type here MUST be accompanied by a corresponding TTL entry in
 * the learnings schema.
 */
export const PROPOSAL_TYPES = Object.freeze([
  'mode-selector-accuracy',
  'hardware-pattern',
  'fragile-file',
  'effective-sizing',
  'recurring-issue',
  'workflow-pattern',
  'proven-pattern',
  'anti-pattern',
  'autopilot-effectiveness',
  'domain-regression',
]);

// ---------------------------------------------------------------------------
// Field limits (defined once for validation + documentation)
// ---------------------------------------------------------------------------

const SUBJECT_MAX = 100;
const INSIGHT_MAX = 2000;
const EVIDENCE_MAX = 5000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a complete, stamped proposal record from caller-supplied fields.
 * Auto-generates `id` (UUID v4) and `created_at` (UTC ISO 8601).
 *
 * This function does NOT validate — call validateProposalRecord() if you need
 * strict gate enforcement before storing.
 *
 * @param {object} opts
 * @param {string} opts.type           — one of PROPOSAL_TYPES
 * @param {string} opts.subject        — 1..100 chars
 * @param {string} opts.insight        — 1..2000 chars
 * @param {string} opts.evidence       — 1..5000 chars
 * @param {number} opts.confidence     — [0, 1]
 * @param {string} opts.waveId         — e.g. 'W2'
 * @param {string} [opts.proposedByAgent] — optional agent identifier
 * @returns {object} complete proposal record
 */
export function createProposalRecord({
  type,
  subject,
  insight,
  evidence,
  confidence,
  waveId,
  proposedByAgent,
}) {
  const record = {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    wave_id: waveId,
    type,
    subject,
    insight,
    evidence,
    confidence,
    schema_version: SCHEMA_VERSION,
  };

  if (proposedByAgent !== undefined) {
    record.proposed_by_agent = proposedByAgent;
  }

  return record;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a proposal record for correctness. Returns a discriminated result
 * object rather than throwing so callers can batch-validate without try/catch.
 *
 * Checks:
 *  - record is a non-null object
 *  - all required fields present
 *  - type ∈ PROPOSAL_TYPES
 *  - subject: string, 1..SUBJECT_MAX chars, no embedded newlines
 *  - insight: string, 1..INSIGHT_MAX chars, no embedded newlines
 *  - evidence: string, 1..EVIDENCE_MAX chars, no embedded newlines
 *  - confidence: finite number in [0, 1]
 *  - wave_id: non-empty string
 *  - schema_version: 1
 *
 * NOTE: the 0.5 confidence floor is a business rule enforced in store.mjs,
 * not here. A confidence of 0.3 is structurally valid.
 *
 * @param {unknown} record
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
export function validateProposalRecord(record) {
  const errors = [];

  if (!record || typeof record !== 'object') {
    return { ok: false, errors: ['record must be a non-null object'] };
  }

  // Required field presence
  const REQUIRED = [
    'id',
    'created_at',
    'wave_id',
    'type',
    'subject',
    'insight',
    'evidence',
    'confidence',
    'schema_version',
  ];
  for (const field of REQUIRED) {
    if (!(field in record)) {
      errors.push(`missing required field: ${field}`);
    }
  }

  // Short-circuit if any required field missing — downstream checks would throw
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // schema_version
  if (record.schema_version !== SCHEMA_VERSION) {
    errors.push(`schema_version must be ${SCHEMA_VERSION}, got: ${record.schema_version}`);
  }

  // type
  if (!PROPOSAL_TYPES.includes(record.type)) {
    errors.push(
      `type must be one of [${PROPOSAL_TYPES.join(', ')}], got: ${JSON.stringify(record.type)}`
    );
  }

  // subject
  if (typeof record.subject !== 'string') {
    errors.push('subject must be a string');
  } else if (record.subject.length === 0) {
    errors.push('subject must not be empty');
  } else if (record.subject.length > SUBJECT_MAX) {
    errors.push(`subject exceeds ${SUBJECT_MAX} chars (got ${record.subject.length})`);
  } else if (/[\r\n]/.test(record.subject)) {
    errors.push('subject must not contain newline characters');
  }

  // insight
  if (typeof record.insight !== 'string') {
    errors.push('insight must be a string');
  } else if (record.insight.length === 0) {
    errors.push('insight must not be empty');
  } else if (record.insight.length > INSIGHT_MAX) {
    errors.push(`insight exceeds ${INSIGHT_MAX} chars (got ${record.insight.length})`);
  } else if (/[\r\n]/.test(record.insight)) {
    errors.push('insight must not contain newline characters');
  }

  // evidence
  if (typeof record.evidence !== 'string') {
    errors.push('evidence must be a string');
  } else if (record.evidence.length === 0) {
    errors.push('evidence must not be empty');
  } else if (record.evidence.length > EVIDENCE_MAX) {
    errors.push(`evidence exceeds ${EVIDENCE_MAX} chars (got ${record.evidence.length})`);
  } else if (/[\r\n]/.test(record.evidence)) {
    errors.push('evidence must not contain newline characters');
  }

  // confidence
  if (
    typeof record.confidence !== 'number' ||
    !Number.isFinite(record.confidence) ||
    record.confidence < 0 ||
    record.confidence > 1
  ) {
    errors.push(
      `confidence must be a finite number in [0, 1], got: ${record.confidence}`
    );
  }

  // wave_id
  if (typeof record.wave_id !== 'string' || record.wave_id.length === 0) {
    errors.push('wave_id must be a non-empty string');
  }

  // proposed_by_agent (optional, but if present must be string)
  if ('proposed_by_agent' in record && typeof record.proposed_by_agent !== 'string') {
    errors.push('proposed_by_agent must be a string when present');
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a proposal record to a single JSONL line (no trailing newline).
 * The result is safe to append to a JSONL file with a `\n` suffix.
 *
 * Precondition: record must pass validateProposalRecord — embedded newlines
 * in field values would break JSONL line-per-record semantics. Validate first.
 *
 * @param {object} record — validated proposal record
 * @returns {string} single-line JSON string (no newline)
 */
export function serializeProposal(record) {
  return JSON.stringify(record);
}

/**
 * Deserialize a single JSONL line back to a proposal record.
 * Returns null on any parse error (malformed JSON, empty line) rather than
 * throwing, so callers can safely process files with corrupted lines.
 *
 * Does NOT re-validate — callers that need strict validation should call
 * validateProposalRecord() on the result.
 *
 * @param {string} line — raw line from a proposals JSONL file
 * @returns {object|null} parsed record, or null on parse error
 */
export function deserializeProposal(line) {
  if (typeof line !== 'string' || line.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
