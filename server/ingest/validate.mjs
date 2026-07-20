/**
 * server/ingest/validate.mjs — record_kind-generic validation registry for the
 * ingest server (Epic #841, S5 / GitLab #846; PRD §3-FA4).
 *
 * A record arrives as `{ record_kind, schema_version, ... }`. validateRecord()
 * dispatches on `record_kind` to the registered per-kind validator; an unknown
 * kind is rejected. v1 ships the `usage-ping` validator; `session-eval` and
 * `learning` register later as new validators + tables with NO transport change
 * (aligns with the eval PRD's record_kind reservation).
 *
 * Each validator returns a STORAGE ROW — the exact column set db.mjs persists —
 * NOT the raw record. Unknown TOP-LEVEL fields on the record are accepted and
 * preserved verbatim inside raw_json (additive forward-compatibility): a future
 * schema field survives a today's-server round-trip.
 *
 * No I/O, no top-level side effects; mirrors the Zod-free plain-JS validator
 * convention of scripts/lib/eval/schema.mjs.
 */

// ---------------------------------------------------------------------------
// ValidationError
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  /**
   * @param {string} message
   * @param {string} [field] — the offending field path (surfaced to the client
   *   as `{ error: 'validation_failed', field }`; NEVER an internal message).
   */
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Accepted schema versions — data-driven so a v2 rollout is a one-line edit
// (Set([2, 1]) accepts current + previous per the additive-evolution contract).
// ---------------------------------------------------------------------------

export const ACCEPTED_VERSIONS = new Set([1]);

// ---------------------------------------------------------------------------
// usage-ping v1 enumerations & field bounds (PRD §3-FA2 whitelist)
// ---------------------------------------------------------------------------

// NOTE: 'claude' — NOT 'claude-code'. Matches the client's SO_PLATFORM value.
const PLATFORMS = new Set(['claude', 'codex', 'cursor', 'pi', 'other']);
// FULL process.platform set + 'other' — the client normalizes anything else to
// 'other', so a genuine platform (android/aix/...) must NOT 400 server-side.
const OSES = new Set(['aix', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32', 'android', 'other']);
// FULL process.arch set + 'other'. A gap here (e.g. loong64, mips, s390) would
// falsely 400 a legitimate architecture the client did NOT normalize away.
const ARCHES = new Set(['arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64', 'riscv64', 's390', 's390x', 'x64', 'other']);
const DURATION_BUCKETS = new Set(['<15m', '15-60m', '1-3h', '>3h']);

// Lowercase-only (no /i): the client always emits crypto.randomUUID(), which is
// lowercase hex per the WHATWG spec, so an uppercase anon_id is malformed input
// — reject it rather than silently normalize (tighter input contract).
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PLUGIN_VERSION_RE = /^\d+\.\d+\.\d+([-+].+)?$/;

const MAX_ANON_ID = 36;
const MAX_SENT_AT = 40;
const MAX_PLUGIN_VERSION = 32;
const MAX_SESSION_TYPE = 32;
const MAX_LIST_ITEMS = 100;
const MAX_LIST_ITEM_LEN = 64;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function requireString(record, field) {
  const v = record[field];
  if (typeof v !== 'string' || v.length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`, field);
  }
  return v;
}

function requireEnum(record, field, allowed) {
  const v = record[field];
  if (typeof v !== 'string' || !allowed.has(v)) {
    throw new ValidationError(`${field} must be one of the allowed values`, field);
  }
  return v;
}

function requireBool(record, field) {
  const v = record[field];
  if (typeof v !== 'boolean') {
    throw new ValidationError(`${field} must be a boolean`, field);
  }
  return v;
}

/**
 * Validate a bounded string list (skills / commands): an array of ≤ MAX_LIST_ITEMS
 * strings, each ≤ MAX_LIST_ITEM_LEN chars.
 */
function requireStringList(record, field) {
  const v = record[field];
  if (!Array.isArray(v)) {
    throw new ValidationError(`${field} must be an array`, field);
  }
  if (v.length > MAX_LIST_ITEMS) {
    throw new ValidationError(`${field} must have at most ${MAX_LIST_ITEMS} items`, field);
  }
  for (let i = 0; i < v.length; i++) {
    const item = v[i];
    if (typeof item !== 'string') {
      throw new ValidationError(`${field}[${i}] must be a string`, `${field}[${i}]`);
    }
    if (item.length > MAX_LIST_ITEM_LEN) {
      throw new ValidationError(`${field}[${i}] must be at most ${MAX_LIST_ITEM_LEN} chars`, `${field}[${i}]`);
    }
  }
  return v;
}

/**
 * Today's date in UTC as YYYY-MM-DD. The server derives received_day from its
 * OWN clock — the client-supplied sent_at is validated for shape but is NEVER
 * trusted for the storage day (nor persisted as an indexed column).
 */
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// usage-ping v1 validator
// ---------------------------------------------------------------------------

/**
 * Validate a usage-ping v1 record and project it onto a storage row.
 * Unknown top-level fields are accepted and survive in raw_json.
 *
 * @param {object} record
 * @returns {{ kind: string, schema_version: number, received_day: string,
 *             anon_id: string, fleet: 0|1, raw_json: string }}
 * @throws {ValidationError}
 */
function validateUsagePingV1(record) {
  // record_kind — literal 'usage-ping' (the dispatcher already matched it, but
  // re-assert so the validator is self-contained / independently testable).
  if (record.record_kind !== 'usage-ping') {
    throw new ValidationError("record_kind must be 'usage-ping'", 'record_kind');
  }

  // schema_version — data-driven accepted set.
  if (!ACCEPTED_VERSIONS.has(record.schema_version)) {
    throw new ValidationError('schema_version is not accepted', 'schema_version');
  }

  // anon_id — UUID v4, defensively length-capped before the regex.
  const anonId = record.anon_id;
  if (typeof anonId !== 'string' || anonId.length > MAX_ANON_ID || !UUID_V4_RE.test(anonId)) {
    throw new ValidationError('anon_id must be a UUID v4', 'anon_id');
  }

  // sent_at — ISO string (validated, NOT trusted for received_day, NOT indexed).
  const sentAt = record.sent_at;
  if (typeof sentAt !== 'string' || sentAt.length === 0 || sentAt.length > MAX_SENT_AT || Number.isNaN(Date.parse(sentAt))) {
    throw new ValidationError('sent_at must be an ISO 8601 string', 'sent_at');
  }

  // plugin_version — semver-ish.
  const pv = record.plugin_version;
  if (typeof pv !== 'string' || pv.length > MAX_PLUGIN_VERSION || !PLUGIN_VERSION_RE.test(pv)) {
    throw new ValidationError('plugin_version must be a semver string', 'plugin_version');
  }

  requireEnum(record, 'platform', PLATFORMS);
  requireEnum(record, 'os', OSES);
  requireEnum(record, 'arch', ARCHES);

  const nodeMajor = record.node_major;
  if (!Number.isInteger(nodeMajor) || nodeMajor < 1 || nodeMajor > 99) {
    throw new ValidationError('node_major must be an integer 1-99', 'node_major');
  }

  requireBool(record, 'ci');
  const fleet = requireBool(record, 'fleet');

  const sessionType = requireString(record, 'session_type');
  if (sessionType.length > MAX_SESSION_TYPE) {
    throw new ValidationError(`session_type must be at most ${MAX_SESSION_TYPE} chars`, 'session_type');
  }

  requireEnum(record, 'duration_bucket', DURATION_BUCKETS);

  requireStringList(record, 'skills');
  requireStringList(record, 'commands');

  // Storage row. raw_json preserves the FULL record (including any unknown
  // top-level fields) so additive schema growth round-trips; the client IP is
  // never part of the record and therefore never lands here.
  return {
    kind: 'usage-ping',
    schema_version: record.schema_version,
    received_day: todayUtc(),
    anon_id: anonId,
    fleet: fleet ? 1 : 0,
    raw_json: JSON.stringify(record),
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** @type {Map<string, (record: object) => object>} */
export const REGISTRY = new Map();

/**
 * Register (or override) a per-kind validator.
 * @param {string} kind — the record_kind discriminator.
 * @param {(record: object) => object} fn — validator returning a storage row.
 */
export function registerValidator(kind, fn) {
  REGISTRY.set(kind, fn);
}

/**
 * Dispatch a record to its per-kind validator.
 *
 * @param {unknown} record
 * @returns {object} storage row
 * @throws {ValidationError} on non-object input, unknown record_kind, or any
 *   per-kind validation failure.
 */
export function validateRecord(record) {
  if (!isPlainObject(record)) {
    throw new ValidationError('record must be an object', 'record');
  }
  const kind = record.record_kind;
  const validator = REGISTRY.get(kind);
  if (!validator) {
    throw new ValidationError('unknown record_kind', 'record_kind');
  }
  return validator(record);
}

// v1 registration.
registerValidator('usage-ping', validateUsagePingV1);
