/**
 * session-schema/normalizer.mjs — normalizeSession (read-path normalization).
 *
 * Extracted from scripts/lib/session-schema.mjs (W1A3 split).
 * Imports: constants.mjs. No imports from siblings (validator, timestamps,
 * aliases) or parent barrel.
 *
 * Exports: normalizeSession, normalizeWaveKeys
 * Module-private: _warnedMissingSchemaVersion (Set, per-process dedupe),
 *   isPlainObject, _canonicalizeExpressPath, _aliasWaves
 */

import { SESSION_KEY_ALIASES, WAVE_KEY_ALIASES } from './constants.mjs';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

// Keyed by session_id (or '<unknown>'). Each unique id warns at most once
// per process, preventing log-spam on large sessions.jsonl files.
const _warnedMissingSchemaVersion = new Set();

// ---------------------------------------------------------------------------
// Internal helper (intentional duplication — Option 1 submodule isolation,
// mirroring aliases.mjs / validator.mjs rather than adding a cross-import)
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Collapse the legacy OBJECT form of `express_path` onto the canonical
 * BOOLEAN form, in place on the caller's already-copied `next` object.
 *
 * WHY BOOLEAN IS CANONICAL. The ledger carried the field in two forms with no
 * arbiter: 20 boolean records (14 `false`, 6 `true`) and exactly ONE object,
 * `{activated, tasks, notes}` on `main-2026-05-01-housekeeping-2` (measured
 * 2026-08-23 over 271 records). That single record is a hand-composition
 * artefact, not a richer designed variant: it is the only one of the 21 with
 * no top-level `notes`, and its `express_path.notes` holds session-level
 * narrative that every other record puts in the canonical top-level `notes`.
 * It also carries the same era's ad-hoc vocabulary elsewhere
 * (`waves_completed`, `issues_new`, `cross_repo_writes`), so the object form
 * is that composition freedom, not a schema. The question the field exists to
 * answer — "greift der Express Path?" (docs/prd/2026-08-22-framework-
 * verschlankung.md § VS-1) — is a boolean question whose denominator is the
 * 14 `false` records.
 *
 * NOTHING IS DISCARDED. The original object is preserved verbatim under
 * `_express_path_detail`, following the module's own "original keys are
 * preserved alongside their canonical alias" convention and the
 * `_completed_at_conflict` forensics tag in aliases.mjs. The conversion is
 * therefore deterministic AND reversible.
 *
 * A shape this function cannot recognise (string, number, array, or an object
 * without a boolean `activated`) is passed through UNTOUCHED — normalizeSession
 * never throws. Refusing such a shape is the write path's job; validator.mjs
 * rejects it there.
 *
 * BOUNDED TOLERANCE — REVISIT TRIGGER: the legacy object form is accepted only
 * because one historical record uses it. When that record leaves the ledger (or
 * is rewritten by a migration), delete this function and the matching
 * `express_path` object clause in validator.mjs — canonical-boolean-only.
 *
 * @param {Record<string, any>} next — mutable copy of the entry being normalized
 */
function _canonicalizeExpressPath(next) {
  if (!('express_path' in next)) return;
  const raw = next.express_path;
  if (!isPlainObject(raw)) return; // boolean (canonical), null, or unrecognised
  if (typeof raw.activated !== 'boolean') return; // not the legacy shape

  // Non-clobber, matching the alias rule above: never overwrite a sidecar that
  // a previous normalization pass (or a producer) already wrote.
  if (!('_express_path_detail' in next)) {
    next._express_path_detail = raw;
  }
  next.express_path = raw.activated;
}

/**
 * Apply WAVE_KEY_ALIASES to every plain-object wave, mirroring the top-level
 * SESSION_KEY_ALIASES rule: the legacy key is preserved, and an existing
 * canonical key is never clobbered. Copy-on-write — the caller's wave objects
 * are never mutated (normalizeSession's `{ ...entry }` is shallow, so `waves`
 * is still the caller's array).
 *
 * @param {any[]} waves
 * @returns {any[]} the same array reference when no wave needed an alias
 */
function _aliasWaves(waves) {
  let changed = false;
  const out = waves.map((w) => {
    if (!isPlainObject(w)) return w;
    let copy = null;
    for (const [oldKey, newKey] of Object.entries(WAVE_KEY_ALIASES)) {
      if (oldKey in w && !(newKey in w)) {
        copy ??= { ...w };
        copy[newKey] = w[oldKey];
      }
    }
    if (copy === null) return w;
    changed = true;
    return copy;
  });
  return changed ? out : waves;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply ONLY the per-wave key aliases (WAVE_KEY_ALIASES) to a session entry —
 * the subset of normalizeSession that is safe on the WRITE path
 * (scripts/emit-session.mjs, #1390 P1). The rest of normalizeSession is not:
 * it tags a missing `schema_version` as 0 where validateSession stamps the
 * current version, and applies top-level aliases the write-path contract
 * explicitly excludes.
 *
 * Never throws. Non-objects and entries without a `waves` array are returned
 * unchanged; so is an entry none of whose waves needs an alias (same reference).
 *
 * @param {any} entry
 * @returns {any} a new entry with aliased waves, or the input unchanged
 */
export function normalizeWaveKeys(entry) {
  if (!isPlainObject(entry) || !Array.isArray(entry.waves)) return entry;
  const waves = _aliasWaves(entry.waves);
  return waves === entry.waves ? entry : { ...entry, waves };
}

/**
 * Normalize a session entry read from disk. Applies SAFE key aliases (top-level
 * SESSION_KEY_ALIASES and per-wave WAVE_KEY_ALIASES), collapses
 * the legacy object form of `express_path` onto its canonical boolean, and tags
 * legacy entries without `schema_version` as 0 (distinct from
 * CURRENT_SESSION_SCHEMA_VERSION=2 which is stamped on new writes; bumped
 * 1 -> 2 via #372).
 *
 * Never throws. Malformed input (null, non-object, array) is passed through
 * unchanged. Original keys are preserved alongside their canonical alias for
 * debugging; the pre-collapse `express_path` object is preserved under
 * `_express_path_detail` for the same reason.
 *
 * Idempotent: normalize(normalize(x)) deep-equals normalize(x).
 *
 * @param {any} entry
 * @returns {any} normalized entry (or original if non-object)
 */
export function normalizeSession(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;

  const next = { ...entry };

  // Apply safe key aliases (same-shape renames). Preserve the old key.
  for (const [oldKey, newKey] of Object.entries(SESSION_KEY_ALIASES)) {
    if (oldKey in next && !(newKey in next)) {
      next[newKey] = next[oldKey];
    }
  }

  // Per-wave aliases (#1390 P1) — same non-clobber rule, one level down.
  if (Array.isArray(next.waves)) next.waves = _aliasWaves(next.waves);

  // express_path — same key, two shapes. Collapse onto the canonical boolean.
  _canonicalizeExpressPath(next);

  // schema_version — legacy entries tagged as 0 (NOT CURRENT_SESSION_SCHEMA_VERSION).
  if ('schema_version' in next && next.schema_version !== undefined) {
    // Preserve existing version.
  } else {
    next.schema_version = 0;
    const warnKey = next.session_id ?? '<unknown>';
    if (!_warnedMissingSchemaVersion.has(warnKey)) {
      _warnedMissingSchemaVersion.add(warnKey);
      console.error(
        `[sessions] WARN: record missing schema_version (session_id=${warnKey}); treating as schema_version=0 (pre-versioning legacy)`
      );
    }
  }

  return next;
}
