/**
 * telemetry/anon-id.mjs — rotating anonymous ID for usage-telemetry (Epic #841,
 * S2 / GitLab #843; PRD docs/prd/2026-07-20-anonymous-usage-telemetry.md §3-FA2).
 *
 * PURE, no I/O. The anonymous ID is a random UUID that rotates every
 * ANON_ID_MAX_AGE_DAYS days. It is NEVER machine-derived (no hostname, MAC,
 * install path, or any stable hardware/user identifier) — this is the privacy
 * invariant that avoids the persistent-ID correlation criticism (PRD §4
 * "Privacy engineering"). Rotation discards the old ID entirely.
 *
 * All time is passed IN as a parameter (`now`), never read from the clock inside
 * this module, so callers stay deterministic and testable.
 *
 * Contract:
 *   newAnonId()                          → a fresh random UUID (v4).
 *   isExpired(createdAtISO, now, maxAge) → boolean; unparsable createdAt ⇒ true.
 *   ensureAnonId(record, opts)           → { record, anon_id, rotated, created }.
 */

import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rotate the anonymous ID after this many days. */
export const ANON_ID_MAX_AGE_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Resolve a `now` argument to epoch-ms. Accepts either a number (already epoch-ms)
 * or an ISO 8601 string. Returns NaN when it cannot be parsed.
 * @param {number|string} now
 * @returns {number}
 */
function toEpochMs(now) {
  if (typeof now === 'number') return now;
  if (typeof now === 'string') return Date.parse(now);
  return NaN;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Mint a fresh anonymous ID. A random UUID (v4) — never derived from any machine
 * or user attribute.
 *
 * @returns {string} a v4 UUID
 */
export function newAnonId() {
  return randomUUID();
}

/**
 * Decide whether an anonymous ID minted at `createdAtISO` is older than
 * `maxAgeDays` relative to `now` and must be rotated.
 *
 * Fail-safe posture: an unparsable / missing `createdAtISO` (or `now`) returns
 * `true` (rotate) — an ID whose age cannot be verified is treated as stale
 * rather than trusted indefinitely. The age comparison is strict: exactly
 * `maxAgeDays` old is NOT expired (only strictly older rotates).
 *
 * @param {string} createdAtISO — ISO 8601 timestamp the current ID was minted at.
 * @param {number|string} now   — reference time (epoch-ms or ISO 8601 string).
 * @param {number} [maxAgeDays=ANON_ID_MAX_AGE_DAYS]
 * @returns {boolean} true ⇒ rotate.
 */
export function isExpired(createdAtISO, now, maxAgeDays = ANON_ID_MAX_AGE_DAYS) {
  const createdMs = typeof createdAtISO === 'string' ? Date.parse(createdAtISO) : NaN;
  if (Number.isNaN(createdMs)) return true; // unverifiable age ⇒ rotate

  const nowMs = toEpochMs(now);
  if (Number.isNaN(nowMs)) return true; // unverifiable reference ⇒ rotate

  const ageMs = nowMs - createdMs;
  const maxMs = maxAgeDays * MS_PER_DAY;
  return ageMs > maxMs;
}

/**
 * Ensure `record` carries a fresh-enough anonymous ID, returning a NEW record
 * (the input is never mutated). Three outcomes:
 *
 *   - created  — the record had no `anon_id`: mint one, stamp `anon_id_created_at`
 *                to `now`. Returns `{ created: true, rotated: false }`.
 *   - rotated  — the existing ID is older than `maxAgeDays` (or its
 *                `anon_id_created_at` is unparsable): mint a new one, re-stamp
 *                `anon_id_created_at`, discard the old ID.
 *                Returns `{ created: false, rotated: true }`.
 *   - unchanged — the ID is present and fresh: return it as-is (in a shallow
 *                copy). Returns `{ created: false, rotated: false }`.
 *
 * @param {object} record — a record that may carry `anon_id` + `anon_id_created_at`.
 * @param {{now?: string, maxAgeDays?: number}} [opts]
 * @returns {{record: object, anon_id: string, rotated: boolean, created: boolean}}
 */
export function ensureAnonId(record, { now = new Date().toISOString(), maxAgeDays = ANON_ID_MAX_AGE_DAYS } = {}) {
  const rec = isPlainObject(record) ? record : {};
  const currentId = rec.anon_id;

  // created — no usable ID present.
  if (typeof currentId !== 'string' || currentId.trim() === '') {
    const anon_id = newAnonId();
    return {
      record: { ...rec, anon_id, anon_id_created_at: now },
      anon_id,
      rotated: false,
      created: true,
    };
  }

  // rotated — present ID is too old (or its created_at is unparsable).
  if (isExpired(rec.anon_id_created_at, now, maxAgeDays)) {
    const anon_id = newAnonId();
    return {
      record: { ...rec, anon_id, anon_id_created_at: now },
      anon_id,
      rotated: true,
      created: false,
    };
  }

  // unchanged — present and fresh. Return a copy so the input stays untouched.
  return {
    record: { ...rec },
    anon_id: currentId,
    rotated: false,
    created: false,
  };
}
