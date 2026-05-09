/**
 * session-schema/normalizer.mjs — normalizeSession (read-path normalization).
 *
 * Extracted from scripts/lib/session-schema.mjs (W1A3 split).
 * Imports: constants.mjs. No imports from siblings (validator, timestamps,
 * aliases) or parent barrel.
 *
 * Exports: normalizeSession
 * Module-private: _warnedMissingSchemaVersion (Set, per-process dedupe)
 */

import { SESSION_KEY_ALIASES } from './constants.mjs';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

// Keyed by session_id (or '<unknown>'). Each unique id warns at most once
// per process, preventing log-spam on large sessions.jsonl files.
const _warnedMissingSchemaVersion = new Set();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalize a session entry read from disk. Applies SAFE key aliases, tags
 * legacy entries without `schema_version` as 0 (distinct from
 * CURRENT_SESSION_SCHEMA_VERSION=1 which is stamped on new writes).
 *
 * Never throws. Malformed input (null, non-object, array) is passed through
 * unchanged. Original keys are preserved alongside their canonical alias for
 * debugging.
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
