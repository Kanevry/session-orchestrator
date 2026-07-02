/**
 * namespace.mjs — Per-project vault namespace resolver (Issue #660).
 *
 * Derives a single-segment, sanitised, leak-guarded directory name that scopes
 * vault writes under `40-learnings/<repoNs>/` and `50-sessions/<repoNs>/`.
 *
 * Contract:
 *   resolveRepoNamespace({ vaultName?, cwd? }) → string
 *
 *   - Pure + deterministic (given the same git remote / cwd / vaultName input,
 *     and the same host-local pseudonym map).
 *   - Returns a lowercase kebab slug safe for use as a filesystem path segment.
 *   - Host-local pseudonym mapping (Epic #725 D5): consulted ONLY at the redaction
 *     site (only when a segment is owner-leaky). If such a repo (raw or sanitised)
 *     appears in the operator's host-local namespace map, its stable pseudonym is
 *     returned INSTEAD of collapsing to 'redacted-repo'. This preserves per-repo
 *     write-isolation (#660) for the N owner-leaky private repos AND keeps
 *     cross-repo attribution stable — without ever writing the real name to the
 *     vault. The map is resolved lazily (owner.yaml / env SO_NAMESPACE_MAP) and
 *     cached per process; the lazy read is touched only on the leaky path, so clean
 *     repos add zero fs I/O.
 *   - Redacts UNMAPPED owner-privacy leaks (CP1/CP6/CP10) to 'redacted-repo' +
 *     stderr WARN — identical to pre-#725 behaviour when no map is configured.
 *   - Falls back to 'unknown-repo' when slug derivation produces an empty string.
 */

import { deriveRepo } from './process.mjs';
import { subjectToSlug } from './utils.mjs';
import { isOwnerLeakySegment } from '../../lib/validate/check-owner-leakage.mjs';
import { loadPseudonymMap } from './pseudonym-map.mjs';
import { loadHostPaths, resolveHostPath } from '../config/host-paths.mjs';

// ── Lazy pseudonym-map path resolution (Epic #725 D5) ────────────────────────
// The map path comes from env SO_NAMESPACE_MAP > owner.yaml paths.namespace-map-path
// > '' (unconfigured). resolveRepoNamespace is called once per mirrored record, so
// the resolved PATH is cached per process (the parsed MAP itself is cached inside
// pseudonym-map.mjs). `_mapPathOverride` is a TEST-ONLY seam: `undefined` = resolve
// lazily from host-paths; `null` = force "no map"; a string = use that path — this
// lets namespace.test.mjs stay deterministic and insulated from the machine's real
// owner.yaml.
let _mapPathOverride;
let _lazyPathResolved = false;
let _lazyPath = '';

/** Test-only: pin the pseudonym-map path (`null` = no map, string = explicit path). */
export function _setNamespaceMapPath(value) {
  _mapPathOverride = value;
}

/** Test-only: clear the map-path override AND the lazy path cache. */
export function _resetNamespaceMapState() {
  _mapPathOverride = undefined;
  _lazyPathResolved = false;
  _lazyPath = '';
}

/** Resolve the pseudonym-map path (test override → cached lazy host-path resolution). */
function currentMapPath() {
  if (_mapPathOverride !== undefined) return _mapPathOverride;
  if (_lazyPathResolved) return _lazyPath;
  _lazyPathResolved = true;
  try {
    const ctx = loadHostPaths();
    _lazyPath = resolveHostPath('namespace-map-path', '', ctx) ?? '';
  } catch {
    _lazyPath = '';
  }
  return _lazyPath;
}

/**
 * Look up a stable pseudonym for this repo. Checks the sanitised segment first
 * (the canonical, stable key) then the raw base (covers a vaultName override
 * passed verbatim). Returns null when no map is configured or no entry matches.
 *
 * @param {string} base - raw repo identifier.
 * @param {string} seg  - sanitised kebab segment derived from `base`.
 * @returns {string|null}
 */
function lookupPseudonym(base, seg) {
  const mapPath = currentMapPath();
  if (typeof mapPath !== 'string' || mapPath.trim() === '') return null;
  const map = loadPseudonymMap({ mapPath });
  if (!map) return null;
  if (seg && map.has(seg)) return map.get(seg);
  if (base && map.has(base)) return map.get(base);
  return null;
}

/**
 * Resolve the sanitised repository namespace segment for vault path scoping.
 *
 * @param {object}  [opts]
 * @param {string|null} [opts.vaultName] - Optional override for the repo identifier.
 *   When non-empty and non-whitespace, used in place of the git-derived repo name.
 *   When absent, the namespace is derived from the git origin via deriveRepo().
 * @returns {string} A single kebab-slug path segment, e.g. 'session-orchestrator'.
 *   Special returns:
 *   - 'unknown-repo'  — slug derivation produced an empty string.
 *   - 'redacted-repo' — the raw or slugified value matched an owner-leakage pattern
 *     (CP1 personal home path / CP6 private slug / CP10 personal name in Projects path).
 */
export function resolveRepoNamespace({ vaultName = null } = {}) {
  // Choose the base identifier: explicit override first, then git-derived.
  const base = (vaultName && typeof vaultName === 'string' && vaultName.trim())
    ? vaultName.trim()
    : deriveRepo();

  // Sanitise: collapse to last path segment, lowercase, strip non-[a-z0-9-].
  const seg = subjectToSlug(base);

  // Leak-guard: check both the raw base AND the sanitised segment.
  // A personal home path or a private project slug must be caught before writing
  // to the vault. We check both forms because:
  //   - CP1 matches the raw base (contains the personal home path prefix)
  //   - CP6/CP10 may match either form depending on how the slug strips context
  //
  // Host-local pseudonym mapping (Epic #725 D5): the map is consulted ONLY at the
  // redaction site — i.e. only when a segment IS owner-leaky. A mapped leaky repo
  // returns its stable pseudonym INSTEAD of collapsing to 'redacted-repo' (which is
  // the D5 goal: distinct per-repo namespaces + stable attribution for the N private
  // repos, without ever writing the real name to the vault). Because the map (and its
  // lazy owner.yaml read) is touched only on the leaky path, clean repos stay 100%
  // side-effect-free — identical to pre-#725 behaviour, and no fs I/O is added to the
  // common non-leaky path. Unmapped leaky segments fall through to redaction unchanged.
  const rawMatch = isOwnerLeakySegment(base);
  if (rawMatch !== null) {
    const pseudonym = lookupPseudonym(base, seg);
    if (pseudonym) return pseudonym;
    process.stderr.write(
      `WARN vault-mirror/namespace: owner-privacy leak detected in repo identifier (pattern: ${rawMatch}); redacting to 'redacted-repo'\n`,
    );
    return 'redacted-repo';
  }

  const segMatch = isOwnerLeakySegment(seg);
  if (segMatch !== null) {
    const pseudonym = lookupPseudonym(base, seg);
    if (pseudonym) return pseudonym;
    process.stderr.write(
      `WARN vault-mirror/namespace: owner-privacy leak detected in sanitised namespace segment (pattern: ${segMatch}); redacting to 'redacted-repo'\n`,
    );
    return 'redacted-repo';
  }

  // Fallback for degenerate inputs (empty slug after sanitisation).
  if (!seg) {
    return 'unknown-repo';
  }

  return seg;
}
