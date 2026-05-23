/**
 * scripts/lib/peer-cards/schema.mjs — Peer-card frontmatter validator (issue #503).
 *
 * Pure ESM, no I/O, no external dependencies. Used by reader.mjs / writer.mjs /
 * merger.mjs (siblings under scripts/lib/peer-cards/) to validate peer-card
 * YAML frontmatter on read and before write.
 *
 * Design notes:
 *   - Follows the `mission-status-schema.mjs` convention (pure regex/checks)
 *     rather than `skills/vault-sync/validator.mjs` (zod). The repo root has
 *     no `zod` dependency — only `skills/vault-sync/` does, scoped to that
 *     skill's own `node_modules`. Keeping this validator dependency-free lets
 *     callers from anywhere under `scripts/lib/` use it without extra setup.
 *   - The shape mirrors the canonical `vaultFrontmatterSchema` in
 *     `skills/vault-sync/validator.mjs` (slug regex, ISO date regex, optional
 *     title/tags) and extends it with the peer-card specific `target` enum and
 *     `source_sessions` array.
 *   - The `'peer-card'` discriminator is added to the vault-sync enum via the
 *     vendored-edit + sync-script-baseline path (see scripts/sync-vault-schema.mjs
 *     and the BEGIN/END GENERATED SCHEMA sentinel block in validator.mjs).
 *
 * Required frontmatter fields (per #503 AC1):
 *   id              : kebab-case slug, 2..128 chars
 *   type            : literal 'peer-card'
 *   target          : 'user' | 'agent'
 *   created         : ISO-8601 timestamp
 *   updated         : ISO-8601 timestamp
 *   source_sessions : string[] (may be empty; defaults to [] when absent)
 *
 * Optional fields:
 *   title : 1..200 chars
 *   tags  : string[]
 *
 * Unknown fields pass through (mirrors the .passthrough() behaviour of the
 * canonical vault schema).
 */

// ── Constants ───────────────────────────────────────────────────────────────

/** Canonical kebab-case slug regex (mirrors vault-sync slugRegex). */
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Strict ISO 8601 datetime regex with UTC Z suffix, matching the AC1 example
 * `2026-05-23T12:30:00Z`. Optional millisecond precision is accepted.
 * Note: the canonical vault schema accepts date-only and offsets too; peer-cards
 * deliberately require the full timestamp form for reproducible ordering.
 */
const ISO_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Permitted peer-card target values. */
export const PEER_CARD_TARGETS = Object.freeze(['user', 'agent']);

/** Staleness threshold in days — used by merger / discovery probes. */
export const STALENESS_THRESHOLD_DAYS = 30;

/** Inclusive bounds for the `id` field. */
const ID_MIN_LEN = 2;
const ID_MAX_LEN = 128;

/** Inclusive bounds for the optional `title` field. */
const TITLE_MIN_LEN = 1;
const TITLE_MAX_LEN = 200;

// ── Type guards ─────────────────────────────────────────────────────────────

function _isString(v) {
  return typeof v === 'string';
}

function _isStringArray(v) {
  return Array.isArray(v) && v.every(_isString);
}

// ── Public predicates ──────────────────────────────────────────────────────

/**
 * Returns true when `value` is one of the canonical peer-card target strings.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidPeerCardTarget(value) {
  return typeof value === 'string' && PEER_CARD_TARGETS.includes(value);
}

/**
 * Returns true when `value` is a valid kebab-case slug within the id length
 * bounds (2..128).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidPeerCardId(value) {
  if (typeof value !== 'string') return false;
  if (value.length < ID_MIN_LEN || value.length > ID_MAX_LEN) return false;
  return SLUG_REGEX.test(value);
}

/**
 * Returns true when `value` is a strict ISO 8601 datetime ending in `Z`.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidIsoTimestamp(value) {
  return typeof value === 'string' && ISO_DATETIME_REGEX.test(value);
}

// ── Validator ──────────────────────────────────────────────────────────────

/**
 * Validate a parsed peer-card frontmatter object against the #503 AC1 shape.
 *
 * Returns a discriminated result object:
 *   - { ok: true, data: object }   — input is valid; `data` is the input with
 *                                    `source_sessions` defaulted to `[]` when
 *                                    absent (mirrors AC1 default). Unknown
 *                                    fields are preserved (passthrough).
 *   - { ok: false, errors: string[] } — one entry per failed field, formatted
 *                                       as `"<path>: <message>"`.
 *
 * Never throws.
 *
 * @param {unknown} input - parsed YAML frontmatter object
 * @returns {{ ok: true, data: object } | { ok: false, errors: string[] }}
 */
export function validatePeerCardFrontmatter(input) {
  const errors = [];

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['<root>: frontmatter must be a plain object'] };
  }

  // ── id ──────────────────────────────────────────────────────────────────
  if (!('id' in input)) {
    errors.push('id: required field missing');
  } else if (!isValidPeerCardId(input.id)) {
    errors.push(
      `id: must be a kebab-case slug of ${ID_MIN_LEN}..${ID_MAX_LEN} chars (matching ${SLUG_REGEX.source})`,
    );
  }

  // ── type ────────────────────────────────────────────────────────────────
  if (!('type' in input)) {
    errors.push('type: required field missing');
  } else if (input.type !== 'peer-card') {
    errors.push(`type: must be literal "peer-card" (got ${JSON.stringify(input.type)})`);
  }

  // ── target ──────────────────────────────────────────────────────────────
  if (!('target' in input)) {
    errors.push('target: required field missing');
  } else if (!isValidPeerCardTarget(input.target)) {
    errors.push(
      `target: must be one of ${JSON.stringify(PEER_CARD_TARGETS)} (got ${JSON.stringify(input.target)})`,
    );
  }

  // ── created ─────────────────────────────────────────────────────────────
  if (!('created' in input)) {
    errors.push('created: required field missing');
  } else if (!isValidIsoTimestamp(input.created)) {
    errors.push('created: must be an ISO 8601 timestamp ending in Z (e.g. 2026-05-23T12:30:00Z)');
  }

  // ── updated ─────────────────────────────────────────────────────────────
  if (!('updated' in input)) {
    errors.push('updated: required field missing');
  } else if (!isValidIsoTimestamp(input.updated)) {
    errors.push('updated: must be an ISO 8601 timestamp ending in Z (e.g. 2026-05-23T12:30:00Z)');
  }

  // ── source_sessions (default: []) ───────────────────────────────────────
  let sourceSessions;
  if (!('source_sessions' in input) || input.source_sessions === undefined) {
    sourceSessions = [];
  } else if (!_isStringArray(input.source_sessions)) {
    errors.push('source_sessions: must be an array of strings');
    sourceSessions = undefined;
  } else {
    sourceSessions = input.source_sessions;
  }

  // ── Optional: title ────────────────────────────────────────────────────
  if ('title' in input && input.title !== undefined) {
    if (!_isString(input.title)) {
      errors.push('title: must be a string when provided');
    } else if (input.title.length < TITLE_MIN_LEN || input.title.length > TITLE_MAX_LEN) {
      errors.push(`title: length must be ${TITLE_MIN_LEN}..${TITLE_MAX_LEN} chars`);
    }
  }

  // ── Optional: tags ─────────────────────────────────────────────────────
  if ('tags' in input && input.tags !== undefined) {
    if (!_isStringArray(input.tags)) {
      errors.push('tags: must be an array of strings when provided');
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Spread input first so passthrough fields are preserved, then overwrite
  // source_sessions with the defaulted value.
  return { ok: true, data: { ...input, source_sessions: sourceSessions } };
}

// ── Staleness helpers ──────────────────────────────────────────────────────

/**
 * Compute staleness in whole days between `updatedIso` and `now`.
 *
 * Returns `Infinity` when `updatedIso` cannot be parsed by `Date`. The result
 * floors toward zero so a card updated 29 hours ago reads as `1` day stale.
 *
 * @param {string} updatedIso - ISO 8601 timestamp from peer-card frontmatter
 * @param {Date} [now=new Date()] - injectable clock for tests
 * @returns {number} whole days since `updatedIso`; `Infinity` on parse failure
 */
export function computeStalenessDays(updatedIso, now = new Date()) {
  if (typeof updatedIso !== 'string') return Infinity;
  const updated = new Date(updatedIso);
  const t = updated.getTime();
  if (Number.isNaN(t)) return Infinity;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) return Infinity;
  return Math.floor((nowMs - t) / 86_400_000);
}
