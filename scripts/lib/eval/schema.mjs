/**
 * eval/schema.mjs — canonical record-schema contract for the aiat-llm-eval
 * standard (Epic #803, S2). The single source of truth every other eval module
 * (engine, report renderer, session-end phase, judge) builds against.
 *
 * Zod-free plain-JS validator + normalizer, matching the repo convention for
 * script-layer utilities (mirrors scripts/lib/skill-judgments-schema.mjs and
 * scripts/lib/session-schema/*). No top-level side effects, no I/O — the sink
 * (eval/sink.mjs) owns the append/read path.
 *
 * ── CANONICAL RECORD (schema_version: 1, record_kind: "session-eval") ────────
 *
 * A session-eval record scores one orchestrator session against a pre-registered
 * rubric. Written append-only to .orchestrator/metrics/eval.jsonl (the journal is
 * the Single Source of Truth; the HTML report is a derived, rebuildable view).
 *
 *   schema_version    1 (stamped by validateEvalRecord if absent)
 *   record_kind       'session-eval' — discriminator; future benchmark records
 *                     reuse this stream with a different record_kind.
 *   run_id            string (unique). Format: `<session_id>-eval-<compactISO>`
 *                     where compactISO strips `- : .` from the ISO timestamp,
 *                     e.g. main-2026-07-16-deep-1-eval-20260716T100000000Z.
 *                     Build via buildRunId(sessionId, timestamp) — deterministic,
 *                     no Date.now (determinism is load-bearing for --verify).
 *   session_id        string (non-empty) — the session being evaluated.
 *   standard_version  string — CURRENT_STANDARD_VERSION ('aiat-llm-eval/1.0').
 *   rubric_version    string (non-empty) — e.g. 'rubric-v1'.
 *   provenance        { rubric_sha256: string, engine_commit: string|null }
 *                     Hash-bound drift detection. The ENGINE computes the hash
 *                     and the commit; this module only validates their shape.
 *   model             { id: string, source: 'self-report'|'env'|'config' }
 *                     Honest model-capture provenance (PRD §4 Modell-Capture).
 *   harness           { plugin_version: string, platform: string,
 *                       host_class: string|null, hostname_hash: string|null }
 *                     hostname_hash is ALWAYS a sha256 short-form hex string —
 *                     NEVER a cleartext hostname (validated via HEX_RE below).
 *   kpis              { duration_seconds, total_waves, total_agents,
 *                       token_input, token_output, carryover } — each field is
 *                     number|null. "Don't fake perfect": a missing KPI is null,
 *                     NEVER guessed as 0. normalizeEvalRecord fills undefined→null.
 *   dimensions        array of per-dimension results, see DIMENSION contract.
 *   handle            string|null — optional self-chosen pseudonym; default null.
 *   anonymized        boolean — true = anonymous submission posture.
 *   timestamp         ISO 8601 string — passed as a PARAMETER (no Date.now in the
 *                     validator path, so re-verify stays byte-deterministic).
 *
 *   DIMENSION (element of dimensions[]):
 *     id                string (non-empty).
 *     method            'deterministic' | 'judge'.
 *     status            'pass' | 'fail' | 'not-applicable' | 'cannot-determine'.
 *     evidence          string — visible justification (may embed paths/prompts;
 *                       therefore EXCLUDED from SUBMISSION_FIELDS, see below).
 *     score             (optional) number|null.
 *     advisory          (judge only) boolean true — the load-bearing firewall:
 *                       a judge dimension can NEVER be persisted as advisory:false
 *                       (mirrors skill-judgments-schema advisory:true guarantee).
 *     calibration_status(judge only) 'uncalibrated' — v1 judge is never calibrated.
 *     Deterministic dimensions MUST NOT carry advisory / calibration_status.
 *
 * ── NO GLOBALSCORE, BY CONSTRUCTION ──────────────────────────────────────────
 *
 * validateEvalRecord REJECTS any record carrying a top-level overall / total /
 * mean / global_score key (FORBIDDEN_GLOBALSCORE_KEYS). Aggregation across many
 * records (CIs, trends, rankings) is a downstream concern, never a single-record
 * field — a core promise of the standard ("kein Globalscore per Konstruktion").
 *
 * ── DATA-MINIMIZATION (SUBMISSION_FIELDS / projectSubmission) ─────────────────
 *
 * SUBMISSION_FIELDS is the frozen whitelist of submission-safe fields for the
 * (future) leaderboard. projectSubmission(record) applies it nested-aware:
 * anything not on the whitelist — file paths, prompts, repo names, dimension
 * evidence, unhashed hostnames, rogue extra fields — is dropped. This is the
 * contract the Leaderboard-Epic consumes.
 *
 * ── CONTRACT SUMMARY ─────────────────────────────────────────────────────────
 *
 *   validateEvalRecord(entry)  — throws ValidationError on any violation; returns
 *                                a NEW object with schema_version stamped.
 *   normalizeEvalRecord(entry) — never throws; applies read-path defaults
 *                                (handle→null, kpi undefined→null, judge-dim
 *                                advisory→true / calibration_status→uncalibrated).
 *   buildRunId(sessionId, ts)  — deterministic run-id builder.
 *   projectSubmission(record)  — nested-aware whitelist projection.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current eval-record schema version. */
export const CURRENT_EVAL_SCHEMA_VERSION = 1;

/** Versioned standard identifier stamped on every record. */
export const CURRENT_STANDARD_VERSION = 'aiat-llm-eval/1.0';

/** Allowed record_kind discriminator values. v1: session-eval only. */
export const VALID_RECORD_KINDS = Object.freeze(['session-eval']);

/** Provenance of the captured model id. */
export const VALID_MODEL_SOURCES = Object.freeze(['self-report', 'env', 'config']);

/** Per-dimension scoring method. */
export const VALID_DIMENSION_METHODS = Object.freeze(['deterministic', 'judge']);

/** 3-state verdict + abstention (never guess) for a dimension. */
export const VALID_DIMENSION_STATUSES = Object.freeze([
  'pass',
  'fail',
  'not-applicable',
  'cannot-determine',
]);

/** Judge calibration status. v1: uncalibrated only (κ-calibration is a later stage). */
export const VALID_CALIBRATION_STATUSES = Object.freeze(['uncalibrated']);

/**
 * Top-level keys that a valid record must NOT carry — the standard forbids any
 * aggregated global score inside a single record.
 */
export const FORBIDDEN_GLOBALSCORE_KEYS = Object.freeze([
  'overall',
  'total',
  'mean',
  'global_score',
]);

/** KPI sub-fields. Each is number|null (undefined→null via normalize). */
export const KPI_FIELDS = Object.freeze([
  'duration_seconds',
  'total_waves',
  'total_agents',
  'token_input',
  'token_output',
  'carryover',
]);

/**
 * Required top-level fields (schema_version is stamped, handle defaults to null,
 * so neither is required on input).
 */
export const REQUIRED_FIELDS = Object.freeze([
  'record_kind',
  'run_id',
  'session_id',
  'standard_version',
  'rubric_version',
  'provenance',
  'model',
  'harness',
  'kpis',
  'dimensions',
  'anonymized',
  'timestamp',
]);

/**
 * Submission-safe whitelist (Data-Minimization). Structured + nested-aware so
 * projectSubmission is fully data-driven: a field absent from the relevant list
 * is dropped from the projection. Deliberately EXCLUDES dimension `evidence`
 * (may embed paths/prompts/repo names) and any unhashed hostname.
 *
 * Frozen at every level so a caller cannot silently widen the contract.
 */
export const SUBMISSION_FIELDS = Object.freeze({
  /** Top-level scalar / already-safe fields copied verbatim. */
  top: Object.freeze([
    'schema_version',
    'record_kind',
    'run_id',
    'standard_version',
    'rubric_version',
    'handle',
    'anonymized',
    'timestamp',
  ]),
  /** provenance sub-fields (hash + public commit — safe). */
  provenance: Object.freeze(['rubric_sha256', 'engine_commit']),
  /** model sub-fields — the whole point of a leaderboard. */
  model: Object.freeze(['id', 'source']),
  /** harness sub-fields — hostname_hash is hashed; NO unhashed hostname exists here. */
  harness: Object.freeze(['plugin_version', 'platform', 'host_class', 'hostname_hash']),
  /** kpis — all numeric, safe. */
  kpis: Object.freeze([...KPI_FIELDS]),
  /** dimension sub-fields — NOTE: `evidence` is intentionally absent. */
  dimensions: Object.freeze(['id', 'method', 'status', 'score', 'advisory', 'calibration_status']),
});

/**
 * sha256 short-form hex guard. A real cleartext hostname (dots, uppercase,
 * non-hex letters) fails this, structurally preventing an unhashed hostname
 * from being stored in harness.hostname_hash.
 */
const HEX_RE = /^[a-f0-9]{8,}$/;

// ---------------------------------------------------------------------------
// ValidationError
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  /**
   * @param {string} message
   * @param {string} [field] — optional field path that triggered the error
   */
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isNumberOrNull(v) {
  return v === null || (typeof v === 'number' && Number.isFinite(v));
}

// ---------------------------------------------------------------------------
// run_id builder
// ---------------------------------------------------------------------------

/**
 * Build a deterministic run_id: `<sessionId>-eval-<compactISO>` where compactISO
 * strips `- : .` from the ISO timestamp (e.g. 2026-07-16T10:00:00.000Z →
 * 20260716T100000000Z). Deterministic given the same inputs — never reads the
 * clock, so a re-verify pass reproduces the same id.
 *
 * @param {string} sessionId — the session identifier.
 * @param {string} timestamp — an ISO 8601 timestamp string.
 * @returns {string}
 */
export function buildRunId(sessionId, timestamp) {
  if (!isNonEmptyString(sessionId)) {
    throw new ValidationError('buildRunId: sessionId must be a non-empty string', 'session_id');
  }
  if (!isNonEmptyString(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    throw new ValidationError('buildRunId: timestamp must be a valid ISO 8601 string', 'timestamp');
  }
  const compact = timestamp.replace(/[-:.]/g, '');
  return `${sessionId}-eval-${compact}`;
}

// ---------------------------------------------------------------------------
// Sub-validators (module-private)
// ---------------------------------------------------------------------------

function _validateSchemaVersion(entry) {
  if ('schema_version' in entry && entry.schema_version !== undefined) {
    if (entry.schema_version !== CURRENT_EVAL_SCHEMA_VERSION) {
      throw new ValidationError(
        `schema_version must be ${CURRENT_EVAL_SCHEMA_VERSION}, got: ${entry.schema_version}`,
        'schema_version',
      );
    }
  }
}

function _rejectGlobalScore(entry) {
  for (const key of FORBIDDEN_GLOBALSCORE_KEYS) {
    if (key in entry) {
      throw new ValidationError(
        `record must NOT carry a global-score key '${key}' — the standard forbids any aggregated score in a single record`,
        key,
      );
    }
  }
}

function _validateRequiredPresence(entry) {
  for (const field of REQUIRED_FIELDS) {
    if (!(field in entry)) {
      throw new ValidationError(`eval record missing required field: ${field}`, field);
    }
  }
}

function _validateDiscriminators(entry) {
  if (!VALID_RECORD_KINDS.includes(entry.record_kind)) {
    throw new ValidationError(
      `record_kind must be one of ${VALID_RECORD_KINDS.join('|')}, got: ${entry.record_kind}`,
      'record_kind',
    );
  }
  if (!isNonEmptyString(entry.run_id)) {
    throw new ValidationError('run_id must be a non-empty string', 'run_id');
  }
  if (!isNonEmptyString(entry.session_id)) {
    throw new ValidationError('session_id must be a non-empty string', 'session_id');
  }
  if (!isNonEmptyString(entry.standard_version)) {
    throw new ValidationError('standard_version must be a non-empty string', 'standard_version');
  }
  if (!isNonEmptyString(entry.rubric_version)) {
    throw new ValidationError('rubric_version must be a non-empty string', 'rubric_version');
  }
}

function _validateTimestamp(entry) {
  if (!isNonEmptyString(entry.timestamp) || Number.isNaN(Date.parse(entry.timestamp))) {
    throw new ValidationError(
      `timestamp must be a valid ISO 8601 string, got: ${entry.timestamp}`,
      'timestamp',
    );
  }
}

function _validateProvenance(entry) {
  const p = entry.provenance;
  if (!isPlainObject(p)) {
    throw new ValidationError('provenance must be an object', 'provenance');
  }
  if (!isNonEmptyString(p.rubric_sha256)) {
    throw new ValidationError(
      'provenance.rubric_sha256 must be a non-empty string',
      'provenance.rubric_sha256',
    );
  }
  if (p.engine_commit !== null && !isNonEmptyString(p.engine_commit)) {
    throw new ValidationError(
      'provenance.engine_commit must be a non-empty string or null',
      'provenance.engine_commit',
    );
  }
}

function _validateModel(entry) {
  const m = entry.model;
  if (!isPlainObject(m)) {
    throw new ValidationError('model must be an object', 'model');
  }
  if (!isNonEmptyString(m.id)) {
    throw new ValidationError('model.id must be a non-empty string', 'model.id');
  }
  if (!VALID_MODEL_SOURCES.includes(m.source)) {
    throw new ValidationError(
      `model.source must be one of ${VALID_MODEL_SOURCES.join('|')}, got: ${m.source}`,
      'model.source',
    );
  }
}

function _validateHarness(entry) {
  const h = entry.harness;
  if (!isPlainObject(h)) {
    throw new ValidationError('harness must be an object', 'harness');
  }
  if (!isNonEmptyString(h.plugin_version)) {
    throw new ValidationError('harness.plugin_version must be a non-empty string', 'harness.plugin_version');
  }
  if (!isNonEmptyString(h.platform)) {
    throw new ValidationError('harness.platform must be a non-empty string', 'harness.platform');
  }
  if (h.host_class !== null && !isNonEmptyString(h.host_class)) {
    throw new ValidationError('harness.host_class must be a non-empty string or null', 'harness.host_class');
  }
  // hostname_hash: null OR a sha256 short-form hex string — NEVER a cleartext
  // hostname. The HEX_RE guard structurally rejects a cleartext hostname
  // (dots / uppercase / non-hex letters) from being persisted.
  if (h.hostname_hash !== null) {
    if (typeof h.hostname_hash !== 'string' || !HEX_RE.test(h.hostname_hash)) {
      throw new ValidationError(
        'harness.hostname_hash must be null or a sha256 short-form hex string (never a cleartext hostname)',
        'harness.hostname_hash',
      );
    }
  }
}

function _validateKpis(entry) {
  const k = entry.kpis;
  if (!isPlainObject(k)) {
    throw new ValidationError('kpis must be an object', 'kpis');
  }
  for (const field of KPI_FIELDS) {
    if (!(field in k)) {
      throw new ValidationError(`kpis missing required field: ${field} (use null, never a guessed 0)`, `kpis.${field}`);
    }
    const v = k[field];
    if (!isNumberOrNull(v)) {
      throw new ValidationError(`kpis.${field} must be a finite number or null, got: ${v}`, `kpis.${field}`);
    }
    if (typeof v === 'number' && v < 0) {
      throw new ValidationError(`kpis.${field} must be non-negative, got: ${v}`, `kpis.${field}`);
    }
  }
}

function _validateDimensions(entry) {
  if (!Array.isArray(entry.dimensions)) {
    throw new ValidationError(`dimensions must be an array, got: ${typeof entry.dimensions}`, 'dimensions');
  }
  for (let i = 0; i < entry.dimensions.length; i++) {
    const d = entry.dimensions[i];
    const at = `dimensions[${i}]`;
    if (!isPlainObject(d)) {
      throw new ValidationError(`${at} must be an object`, at);
    }
    if (!isNonEmptyString(d.id)) {
      throw new ValidationError(`${at}.id must be a non-empty string`, `${at}.id`);
    }
    if (!VALID_DIMENSION_METHODS.includes(d.method)) {
      throw new ValidationError(
        `${at}.method must be one of ${VALID_DIMENSION_METHODS.join('|')}, got: ${d.method}`,
        `${at}.method`,
      );
    }
    if (!VALID_DIMENSION_STATUSES.includes(d.status)) {
      throw new ValidationError(
        `${at}.status must be one of ${VALID_DIMENSION_STATUSES.join('|')}, got: ${d.status}`,
        `${at}.status`,
      );
    }
    if (typeof d.evidence !== 'string') {
      throw new ValidationError(`${at}.evidence must be a string`, `${at}.evidence`);
    }
    if (d.score !== undefined && !isNumberOrNull(d.score)) {
      throw new ValidationError(`${at}.score must be a finite number or null`, `${at}.score`);
    }

    if (d.method === 'judge') {
      // Judge dimensions carry the advisory firewall + calibration status.
      if (d.advisory !== true) {
        throw new ValidationError(
          `${at}.advisory must be the literal value true for a judge dimension (advisory-only guarantee), got: ${d.advisory}`,
          `${at}.advisory`,
        );
      }
      if (!VALID_CALIBRATION_STATUSES.includes(d.calibration_status)) {
        throw new ValidationError(
          `${at}.calibration_status must be one of ${VALID_CALIBRATION_STATUSES.join('|')} for a judge dimension, got: ${d.calibration_status}`,
          `${at}.calibration_status`,
        );
      }
    } else {
      // Deterministic dimensions MUST NOT carry judge-only fields.
      if ('advisory' in d) {
        throw new ValidationError(
          `${at}.advisory is only valid for a judge dimension`,
          `${at}.advisory`,
        );
      }
      if ('calibration_status' in d) {
        throw new ValidationError(
          `${at}.calibration_status is only valid for a judge dimension`,
          `${at}.calibration_status`,
        );
      }
    }
  }
}

function _validateHandleAndAnonymized(entry) {
  if (entry.handle !== undefined && entry.handle !== null && !isNonEmptyString(entry.handle)) {
    throw new ValidationError('handle must be a non-empty string or null', 'handle');
  }
  if (typeof entry.anonymized !== 'boolean') {
    throw new ValidationError(`anonymized must be a boolean, got: ${entry.anonymized}`, 'anonymized');
  }
}

// ---------------------------------------------------------------------------
// Public API — validate
// ---------------------------------------------------------------------------

/**
 * Validate a session-eval record for writing. Throws ValidationError on any
 * required-field / type / enum / range violation, INCLUDING the presence of a
 * forbidden global-score key. Returns a NEW object (input not mutated) with
 * schema_version stamped to CURRENT_EVAL_SCHEMA_VERSION when absent.
 *
 * @param {object} entry
 * @returns {object} validated entry (new object)
 * @throws {ValidationError}
 */
export function validateEvalRecord(entry) {
  if (!isPlainObject(entry)) {
    throw new ValidationError('eval record must be a non-null object');
  }

  _rejectGlobalScore(entry);
  _validateSchemaVersion(entry);
  _validateRequiredPresence(entry);
  _validateDiscriminators(entry);
  _validateTimestamp(entry);
  _validateProvenance(entry);
  _validateModel(entry);
  _validateHarness(entry);
  _validateKpis(entry);
  _validateDimensions(entry);
  _validateHandleAndAnonymized(entry);

  return {
    ...entry,
    schema_version: entry.schema_version ?? CURRENT_EVAL_SCHEMA_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Public API — normalize (never throws)
// ---------------------------------------------------------------------------

/**
 * Normalize a session-eval record read from disk. Never throws — malformed
 * non-object input is returned unchanged. Applies read-path defaults so callers
 * treat legacy and new records uniformly:
 *   - schema_version   → CURRENT when absent
 *   - record_kind      → 'session-eval' when absent
 *   - standard_version → CURRENT_STANDARD_VERSION when absent
 *   - handle           → null when absent
 *   - anonymized       → derived from handle presence when absent (no handle ⇒
 *                        anonymous ⇒ true)
 *   - kpis             → every KPI sub-field undefined → null ("don't fake perfect")
 *   - judge dimensions → advisory → true, calibration_status → 'uncalibrated'
 *
 * @param {object} entry
 * @returns {object}
 */
export function normalizeEvalRecord(entry) {
  if (!isPlainObject(entry)) return entry;

  const handle = entry.handle ?? null;

  const kpisIn = isPlainObject(entry.kpis) ? entry.kpis : {};
  const kpis = {};
  for (const field of KPI_FIELDS) {
    kpis[field] = kpisIn[field] ?? null;
  }

  const dimensions = Array.isArray(entry.dimensions)
    ? entry.dimensions.map((d) => {
        if (!isPlainObject(d)) return d;
        if (d.method === 'judge') {
          return {
            ...d,
            advisory: d.advisory ?? true,
            calibration_status: d.calibration_status ?? 'uncalibrated',
          };
        }
        return d;
      })
    : entry.dimensions;

  return {
    ...entry,
    schema_version: entry.schema_version ?? CURRENT_EVAL_SCHEMA_VERSION,
    record_kind: entry.record_kind ?? 'session-eval',
    standard_version: entry.standard_version ?? CURRENT_STANDARD_VERSION,
    handle,
    anonymized: typeof entry.anonymized === 'boolean' ? entry.anonymized : handle === null,
    kpis,
    dimensions,
  };
}

// ---------------------------------------------------------------------------
// Public API — submission projection (Data-Minimization)
// ---------------------------------------------------------------------------

/**
 * Project a record onto the submission-safe whitelist (SUBMISSION_FIELDS),
 * nested-aware. Anything not on the whitelist — paths, prompts, repo names,
 * dimension evidence, unhashed hostnames, rogue extra fields — is dropped.
 *
 * Fully data-driven from SUBMISSION_FIELDS: a caller cannot widen the projection
 * without editing that frozen whitelist (which turns the data-minimization test
 * RED — the intended fake-regression tripwire).
 *
 * @remarks no v1 runtime caller — consumed by the future leaderboard epic
 *          (#803 follow-up); shipped now so the data-minimization contract is
 *          fixed before any submission surface exists.
 * @param {object} record — a (normalized or raw) session-eval record.
 * @returns {object} submission-safe projection.
 */
export function projectSubmission(record) {
  if (!isPlainObject(record)) return {};

  const out = {};

  for (const key of SUBMISSION_FIELDS.top) {
    if (key in record) out[key] = record[key];
  }

  out.provenance = _pickNested(record.provenance, SUBMISSION_FIELDS.provenance);
  out.model = _pickNested(record.model, SUBMISSION_FIELDS.model);
  out.harness = _pickNested(record.harness, SUBMISSION_FIELDS.harness);
  out.kpis = _pickNested(record.kpis, SUBMISSION_FIELDS.kpis);

  out.dimensions = Array.isArray(record.dimensions)
    ? record.dimensions.map((d) => _pickNested(d, SUBMISSION_FIELDS.dimensions))
    : [];

  return out;
}

/**
 * Pick only the whitelisted keys from a nested object. Returns {} when the input
 * is not an object, so the projection shape is stable regardless of input.
 * @param {*} obj
 * @param {readonly string[]} allowed
 * @returns {object}
 */
function _pickNested(obj, allowed) {
  const out = {};
  if (!isPlainObject(obj)) return out;
  for (const key of allowed) {
    if (key in obj) out[key] = obj[key];
  }
  return out;
}
