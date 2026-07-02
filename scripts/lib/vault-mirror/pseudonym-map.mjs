/**
 * pseudonym-map.mjs — Host-local repo-namespace pseudonym map (Epic #725 D5).
 *
 * vault-mirror namespaces every write under a per-repo subdirectory (#660). For
 * owner-leaky repo identifiers (personal home path / private project slug /
 * personal name), `resolveRepoNamespace()` used to collapse ALL of them to a
 * single `redacted-repo/` subdir — which breaks the #660 write-isolation (N
 * private repos share one dir → id/slug collisions) and destroys cross-repo
 * attribution.
 *
 * This module loads a HOST-LOCAL map that assigns each real repo slug a stable
 * pseudonym. The real names live in a file referenced by owner.yaml
 * (`paths.namespace-map-path`, env `SO_NAMESPACE_MAP`) OUTSIDE any repo, so they
 * are never committed; only the stable, non-leaky pseudonyms reach the vault.
 *
 * Contract:
 *   loadPseudonymMap({ mapPath, deps? }) → Map<string,string> | null
 *
 *   - `mapPath` empty/whitespace/non-string → null (no map configured; SILENT —
 *     this is the default for the ~99% of hosts without a map).
 *   - file missing / unreadable / malformed-JSON / non-object → null + one stderr WARN.
 *   - Each entry's PSEUDONYM value is validated: it must be a filesystem-safe
 *     kebab slug (isValidSlug) AND must NOT itself be owner-leaky
 *     (isOwnerLeakySegment). Entries failing either check are dropped with an
 *     aggregate WARN (real keys / rejected values are NOT logged — logging them
 *     would defeat the privacy guarantee).
 *   - Result is CACHED per process, keyed by mapPath (the mirror loop calls this
 *     once per record — the file is read+parsed at most once per path).
 *
 * Privacy: this module never writes the map anywhere; it only reads the operator's
 * host-local file. WARN messages carry the map PATH (the operator's own config
 * path, shown transiently on their terminal) but never the real slugs or rejected
 * pseudonym values.
 */

import { readFileSync, existsSync } from 'node:fs';
import { isValidSlug } from './utils.mjs';
import { isOwnerLeakySegment } from '../validate/check-owner-leakage.mjs';

/** Per-process cache: mapPath → (Map<string,string> | null). */
const _cache = new Map();

/**
 * Clear the per-process pseudonym-map cache. Test-only seam — production code
 * never needs to reset (the map file does not change mid-process).
 */
export function _resetPseudonymMapCache() {
  _cache.clear();
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Default (production) dependency bindings — overridable per call for tests. */
const DEFAULT_DEPS = {
  readFileSync,
  existsSync,
  isLeaky: isOwnerLeakySegment,
  warn: (msg) => process.stderr.write(msg),
};

/**
 * Parse + validate the raw JSON map body into a Map of real-slug → pseudonym.
 * Returns null when the body is malformed or yields zero usable entries.
 *
 * @param {string} raw
 * @param {string} mapPath
 * @param {{ isLeaky: (v: string) => (string|null), warn: (msg: string) => void }} d
 * @returns {Map<string,string>|null}
 */
function parseMap(raw, mapPath, d) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    d.warn(
      `WARN vault-mirror/pseudonym-map: malformed JSON in namespace map ${mapPath}: ${err.message}; ignoring the map (owner-leaky repos fall back to 'redacted-repo')\n`,
    );
    return null;
  }

  if (!isPlainObject(parsed)) {
    d.warn(
      `WARN vault-mirror/pseudonym-map: namespace map ${mapPath} must be a JSON object of {"real-slug":"pseudonym-slug"}; ignoring the map\n`,
    );
    return null;
  }

  const map = new Map();
  let ignoredInvalid = 0;
  let ignoredLeaky = 0;

  for (const [real, pseudo] of Object.entries(parsed)) {
    // JSON object keys are always strings; guard against an empty key anyway.
    if (typeof real !== 'string' || real.trim() === '') {
      ignoredInvalid += 1;
      continue;
    }
    if (typeof pseudo !== 'string' || !isValidSlug(pseudo)) {
      ignoredInvalid += 1;
      continue;
    }
    // A pseudonym that is ITSELF owner-leaky would re-introduce the very leak the
    // map exists to prevent. Drop it — the repo falls back to 'redacted-repo'.
    if (d.isLeaky(pseudo) !== null) {
      ignoredLeaky += 1;
      continue;
    }
    map.set(real, pseudo);
  }

  if (ignoredInvalid > 0 || ignoredLeaky > 0) {
    // Deliberately omit the offending keys/values — logging them would leak the
    // private slugs the map is meant to keep host-local.
    d.warn(
      `WARN vault-mirror/pseudonym-map: ignored ${ignoredInvalid} invalid-slug and ${ignoredLeaky} owner-leaky pseudonym mapping(s) in ${mapPath}\n`,
    );
  }

  return map.size > 0 ? map : null;
}

/**
 * Load and validate the host-local pseudonym map. Defensive — never throws.
 *
 * @param {object} opts
 * @param {string|null|undefined} opts.mapPath - absolute path to the map JSON, or
 *   empty/absent when no map is configured.
 * @param {Partial<typeof DEFAULT_DEPS>} [opts.deps] - injected fs / leak-check / warn (tests).
 * @returns {Map<string,string>|null} the validated map, or null when unconfigured/unusable.
 */
export function loadPseudonymMap({ mapPath, deps = {} } = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };

  // Unconfigured → no map, no noise. This is the normal case for public repos and
  // for any host that has not opted into pseudonym mapping.
  if (typeof mapPath !== 'string' || mapPath.trim() === '') {
    return null;
  }

  if (_cache.has(mapPath)) {
    return _cache.get(mapPath);
  }

  let result = null; // default when the file is missing/unreadable/unusable
  try {
    if (!d.existsSync(mapPath)) {
      d.warn(
        `WARN vault-mirror/pseudonym-map: namespace-map-path is set but the file does not exist: ${mapPath}; owner-leaky repos fall back to 'redacted-repo'\n`,
      );
    } else {
      const raw = d.readFileSync(mapPath, 'utf8');
      result = parseMap(raw, mapPath, d);
    }
  } catch (err) {
    d.warn(
      `WARN vault-mirror/pseudonym-map: failed to read namespace map at ${mapPath}: ${err.message}; ignoring the map\n`,
    );
  }

  _cache.set(mapPath, result);
  return result;
}
