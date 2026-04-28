/**
 * coercers.mjs — Value coercion helpers for Session Config parsing.
 *
 * Ported from config-json-coercion.sh (v2). Shared by all per-section parsers.
 * Two functions are exported for external callers (_coerceEnum, _coerceCollisionRisk);
 * the rest are internal to the config subsystem.
 */

// ---------------------------------------------------------------------------
// Internal: raw lookup
// ---------------------------------------------------------------------------

/**
 * Look up a key in the parsed KV map; returns the raw string value or the
 * given default. Last match wins (mirrors the shell `tail -1` behaviour).
 * @param {Map<string, string>} kv
 * @param {string} key
 * @param {string|undefined} def
 * @returns {string|undefined}
 */
export function _getVal(kv, key, def) {
  const val = kv.get(key);
  if (val !== undefined) return val;
  return def;
}

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

/**
 * Coerce a value to a JSON string or null.
 * @param {Map<string, string>} kv
 * @param {string} key
 * @param {string} [def] — omit for null default
 * @returns {string|null}
 */
export function _coerceString(kv, key, def) {
  const val = _getVal(kv, key, def);
  if (val === undefined || val === '' || val === 'none' || val === 'null') return null;
  return val;
}

/**
 * Coerce a value to an integer, supporting override syntax "N (k: M)".
 * @param {Map<string, string>} kv
 * @param {string} key
 * @param {number} def
 * @returns {number | {default: number, [k: string]: number}}
 */
export function _coerceInteger(kv, key, def) {
  const raw = _getVal(kv, key, String(def));

  // Override syntax: "6 (deep: 18)" or "6 (deep: 18, fast: 4)"
  const overrideMatch = raw.match(/^(\d+)\s*\(([^)]+)\)\s*$/);
  if (overrideMatch) {
    const base = parseInt(overrideMatch[1], 10);
    if (isNaN(base)) throw new Error(`config.mjs: invalid integer base for '${key}': '${raw}'`);
    const overridesStr = overrideMatch[2];
    const result = { default: base };
    for (const pair of overridesStr.split(',')) {
      const colonIdx = pair.indexOf(':');
      if (colonIdx === -1) continue;
      const okey = pair.slice(0, colonIdx).trim();
      const oval = pair.slice(colonIdx + 1).trim();
      const oint = parseInt(oval, 10);
      if (isNaN(oint) || !/^\d+$/.test(oval)) {
        throw new Error(`config.mjs: invalid integer override for '${key}.${okey}': '${oval}'`);
      }
      result[okey] = oint;
    }
    return result;
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`config.mjs: invalid integer for '${key}': '${raw}'`);
  }
  return parseInt(raw, 10);
}

/**
 * Coerce a value to a float with optional bounds.
 * @param {Map<string, string>} kv
 * @param {string} key
 * @param {number} def
 * @param {number} [min]
 * @param {number} [max] — exclusive upper bound
 * @returns {number}
 */
export function _coerceFloat(kv, key, def, min, max) {
  const raw = _getVal(kv, key, String(def));

  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`config.mjs: invalid float for '${key}': '${raw}' (expected non-negative number)`);
  }
  const val = parseFloat(raw);

  if (min !== undefined && val < min) {
    throw new Error(`config.mjs: float '${key}' value '${raw}' is below minimum '${min}'`);
  }
  if (max !== undefined && val >= max) {
    throw new Error(`config.mjs: float '${key}' value '${raw}' must be less than '${max}'`);
  }
  return val;
}

/**
 * Coerce a value to a boolean.
 * @param {Map<string, string>} kv
 * @param {string} key
 * @param {boolean} def
 * @returns {boolean}
 */
export function _coerceBoolean(kv, key, def) {
  const raw = _getVal(kv, key, def ? 'true' : 'false');
  const lower = raw.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  throw new Error(`config.mjs: invalid boolean for '${key}': '${raw}' (expected true or false)`);
}

/**
 * Coerce a value to a JSON array of strings, or null.
 * Handles "[a, b, c]", "a, b, c", "[]", "none", or absent (null).
 * @param {Map<string, string>} kv
 * @param {string} key
 * @param {string|null} [def] — raw default string like "[all]" or "[]"
 * @returns {string[]|null}
 */
export function _coerceList(kv, key, def) {
  const raw = _getVal(kv, key, def !== undefined ? def : undefined);

  if (raw === undefined || raw === 'none' || raw === 'null') return null;

  // Strip surrounding brackets
  const stripped = raw.replace(/^\s*\[/, '').replace(/\]\s*$/, '').trim();

  if (stripped === '') return [];

  // If value contains '{', bail to null (complex object)
  if (stripped.includes('{')) return null;

  const items = stripped.split(',').map(s => s.trim()).filter(s => s.length > 0);
  return items;
}

/**
 * Coerce a value to an enum string (lower-cased), throw on invalid.
 * @param {Map<string, string>} kv
 * @param {string} key
 * @param {string} def
 * @param {string[]} allowed
 * @returns {string}
 */
export function _coerceEnum(kv, key, def, allowed) {
  const raw = _getVal(kv, key, def);
  const lower = raw.toLowerCase();
  if (!allowed.includes(lower)) {
    throw new Error(`config.mjs: ${key} must be ${allowed.join('|')}, got '${raw}'`);
  }
  return lower;
}

/**
 * Validate and normalise a collision-risk value from plan output JSON.
 * Returns the default when value is null/undefined; throws TypeError on invalid.
 * @param {*} value
 * @param {string} [def='low']
 * @returns {'low'|'medium'|'high'}
 */
export function _coerceCollisionRisk(value, def = 'low') {
  const ALLOWED = ['low', 'medium', 'high'];
  if (value === null || value === undefined) return def;
  const lower = String(value).toLowerCase();
  if (!ALLOWED.includes(lower)) {
    throw new TypeError(`_coerceCollisionRisk: must be low|medium|high, got '${value}'`);
  }
  return lower;
}

/**
 * Coerce a value to a plain object of string values, or null.
 * Handles "{ key1: val1, key2: val2 }".
 * @param {Map<string, string>} kv
 * @param {string} key
 * @returns {Record<string,string>|null}
 */
export function _coerceObject(kv, key) {
  const raw = _getVal(kv, key, undefined);
  if (raw === undefined || raw === 'none' || raw === 'null') return null;

  const stripped = raw.replace(/^\s*\{/, '').replace(/\}\s*$/, '').trim();
  if (stripped === '') return null;

  const result = {};
  for (const pair of stripped.split(',')) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx === -1) continue;
    const k = pair.slice(0, colonIdx).trim();
    const v = pair.slice(colonIdx + 1).trim();
    if (k) result[k] = v;
  }
  return Object.keys(result).length === 0 ? null : result;
}

/**
 * Coerce a value to an object of boolean values (for enforcement-gates).
 * @param {Map<string, string>} kv
 * @param {string} key
 * @returns {Record<string,boolean>|null}
 */
export function _coerceBoolObject(kv, key) {
  const raw = _getVal(kv, key, undefined);
  if (raw === undefined || raw === 'none' || raw === 'null') return null;

  const stripped = raw.replace(/^\s*\{/, '').replace(/\}\s*$/, '').trim();
  if (stripped === '') return null;

  const result = {};
  for (const pair of stripped.split(',')) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx === -1) continue;
    const k = pair.slice(0, colonIdx).trim();
    const v = pair.slice(colonIdx + 1).trim().toLowerCase();
    if (!k) continue;
    if (v === 'true') result[k] = true;
    else if (v === 'false') result[k] = false;
    else throw new Error(`config.mjs: invalid enforcement-gates value for '${k}': '${v}' (must be true or false)`);
  }
  return Object.keys(result).length === 0 ? null : result;
}

/**
 * Coerce max-turns: positive integer or "auto".
 * @param {Map<string, string>} kv
 * @returns {number|string}
 */
export function _coerceMaxTurns(kv) {
  const raw = _getVal(kv, 'max-turns', 'auto');
  const lower = raw.toLowerCase();
  if (lower === 'auto') return 'auto';
  if (/^\d+$/.test(raw)) {
    const n = parseInt(raw, 10);
    if (n <= 0) throw new Error(`config.mjs: invalid max-turns: '${raw}' (must be positive integer or 'auto')`);
    return n;
  }
  throw new Error(`config.mjs: invalid max-turns: '${raw}' (must be positive integer or 'auto')`);
}
