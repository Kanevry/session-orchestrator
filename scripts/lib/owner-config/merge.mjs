/**
 * owner-config/merge.mjs — Deep merge for owner persona configs.
 *
 * Imports: constants + defaults. One-level-deep section merge because the
 * schema has no nested object leaves beyond top-level sections. The output is
 * always a full default-filled config — either input may be partial.
 */

import { CURRENT_OWNER_SCHEMA_VERSION } from './constants.mjs';
import { defaults } from './defaults.mjs';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep merge two owner configs. `override` values win on every leaf key
 * where they are defined (i.e. not undefined). The returned value is a
 * full default-filled config — either input may be partial.
 *
 * Used by D3 (`soul.md` runtime-merge) and D4 (baseline-propagation +
 * per-session override). The merge is one level deep on each top-level
 * section (owner, tone, efficiency, hardware-sharing, defaults, metadata)
 * because the schema has no nested object leaves beyond that.
 *
 * @param {object|null|undefined} base
 * @param {object|null|undefined} override
 * @returns {object}
 */
export function merge(base, override) {
  const baseSafe = isPlainObject(base) ? base : {};
  const overSafe = isPlainObject(override) ? override : {};
  const def = defaults();

  const sections = ['owner', 'tone', 'efficiency', 'hardware-sharing', 'defaults', 'metadata'];
  const out = {
    'schema-version': CURRENT_OWNER_SCHEMA_VERSION,
  };

  for (const section of sections) {
    const baseSection = isPlainObject(baseSafe[section]) ? baseSafe[section] : {};
    const overSection = isPlainObject(overSafe[section]) ? overSafe[section] : {};
    out[section] = { ...def[section], ...baseSection };
    for (const [k, v] of Object.entries(overSection)) {
      if (v !== undefined) {
        out[section][k] = v;
      }
    }
  }

  return out;
}
