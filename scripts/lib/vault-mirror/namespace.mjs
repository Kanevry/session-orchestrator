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
 *
 * Dependency direction (issue #734b): this module OWNS {@link deriveRepo}; it does
 * NOT import from `./process.mjs`. Until #734b, `deriveRepo` lived in `process.mjs`
 * while `process.mjs` imported `resolveRepoNamespace` from here — the repo's only
 * import cycle (`namespace.mjs ↔ process.mjs`). The cycle was broken by moving the
 * *identity* half down here (this module is the repo-identity resolver; `process.mjs`
 * is the record-mirroring pipeline that CONSUMES an identity), and `process.mjs`
 * re-exports `deriveRepo` from here so its public surface is unchanged.
 *
 * The direction is load-bearing beyond cycle-breaking: three modules
 * (`vault-repo-backfill.mjs`, `vault-relocation-rules.mjs`, `scripts/vault-mirror.mjs`)
 * import ONLY `resolveRepoNamespace` and previously dragged the entire `process.mjs`
 * graph (secret-masker, render-learnings, render-sessions, session-schema/filters)
 * in behind it. Keep this module leaf-ward: it may import `./utils.mjs`,
 * `./pseudonym-map.mjs`, the leak-guard, host-paths and `../vcs-repo-spec.mjs`
 * (itself a leaf — `node:child_process` only) — never the pipeline.
 */

import { basename } from 'node:path';

import { subjectToSlug } from './utils.mjs';
import { isOwnerLeakySegment } from '../../lib/validate/check-owner-leakage.mjs';
import { loadPseudonymMap } from './pseudonym-map.mjs';
import { loadHostPaths, resolveHostPath } from '../config/host-paths.mjs';
import { isQueryFailure, resolvePreferredRemote } from '../vcs-repo-spec.mjs';

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

// ── Repo identity (issue #343; moved here from process.mjs for #734b) ────────

let _cachedRepo = null;

/** scp-like SSH remote: `git@host:org/name.git` (no `://`, an `@` before any `/`). */
const SCP_LIKE_REMOTE_RE = /^[^@/\s]+@[^:/\s]+:(.+)$/;

/** `scheme://[authority]/path` remote: https, ssh, git, file, … */
const SCHEME_REMOTE_RE = /^([a-z][a-z0-9+.-]*):\/\/[^/]*\/(.+)$/i;

/**
 * Split a remote's path portion into meaningful segments: drop a trailing
 * `.git` (with any trailing slashes), then discard empty and `.`/`..` segments.
 *
 * The `.`-dropping is the load-bearing part: `git clone <path>/.` records the
 * origin VERBATIM as `/…/<repo>/.`, so the final segment of a filesystem remote
 * is routinely a bare dot (measured golden record, 2026-08-19).
 *
 * @param {string} path
 * @returns {string[]}
 */
function remotePathSegments(path) {
  return path
    .replace(/\.git\/*$/i, '')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Derive the RAW repo identifier from one git remote URL.
 *
 * - Hosted remote (scp-like SSH or a non-`file` scheme URL) → the last two path
 *   segments, `org/name` — byte-identical to the pre-#1039 regex for every
 *   hosted shape, so no existing vault namespace moves.
 * - Filesystem remote (`git clone <path>`, `file://…`) → the repo DIRECTORY
 *   name alone. A local clone has no owner segment, so `org/name` is not
 *   derivable and inventing one from the parent directory would namespace vault
 *   notes under an arbitrary path component.
 *
 * Returns `''` when nothing usable can be derived (caller falls back).
 *
 * @param {string} url
 * @returns {string}
 */
function repoIdentifierFromRemoteUrl(url) {
  const value = String(url ?? '').trim();
  if (value === '') return '';

  const scp = SCP_LIKE_REMOTE_RE.exec(value);
  const asUrl = scp === null ? SCHEME_REMOTE_RE.exec(value) : null;
  const isFileUrl = asUrl !== null && asUrl[1].toLowerCase() === 'file';

  if (scp !== null || (asUrl !== null && !isFileUrl)) {
    const segments = remotePathSegments(scp !== null ? scp[1] : asUrl[2]);
    if (segments.length === 0) return '';
    return segments.length >= 2
      ? `${segments[segments.length - 2]}/${segments[segments.length - 1]}`
      : segments[segments.length - 1];
  }

  const segments = remotePathSegments(isFileUrl ? asUrl[2] : value);
  return segments.length === 0 ? '' : segments[segments.length - 1];
}

/**
 * Derive the canonical repo identifier for cross-repo vault aggregation (issue #343).
 *
 * Strategy (#1039): ask the shared remote-resolution core for the repo's
 * PREFERRED remote — `resolvePreferredRemote` without a `vcs`, i.e. the
 * `origin` → `gitlab` → `github` order, plus its sole-remote fallback — then
 * derive `org/name` (hosted) or the repo directory name (filesystem clone) from
 * that remote's URL. The pre-#1039 implementation read the hard-coded literal
 * `git remote get-url origin`, which produced two live defects:
 *
 *   1. A repo whose remotes are named `gitlab`/`github` (no `origin`) silently
 *      namespaced its vault notes under the CHECKOUT DIRECTORY name.
 *   2. A `git clone <path>` origin (`/…/<repo>/.` — what the pre-push hook's
 *      clone records) parsed to `<repo>/.`, whose slug is empty, so
 *      {@link resolveRepoNamespace} returned `'unknown-repo'`. Measured
 *      2026-08-19; it turned a namespace assertion red and blocked a push.
 *
 * Fallback: `path.basename(process.cwd())`, as before — but the two reasons for
 * reaching it are no longer indistinguishable. A QUERY FAILURE (not a git repo,
 * git not on PATH, git errored — {@link isQueryFailure}) emits a stderr WARN,
 * because the identity under which vault notes are written was GUESSED. A real
 * ABSENCE (a repo with no remotes) stays silent: that is a legitimate repo state
 * and the directory name is the best available identity, not a degraded one.
 * An `ok` resolution whose URL yields no usable identifier also falls back
 * silently — the query succeeded and the answer was simply unusable.
 *
 * Cached per-process — repo identity does not change mid-run, and the cache also
 * keeps the WARN to at most one line per process.
 *
 * NOTE — this is the RAW identifier and is NOT leak-guarded. Never write its
 * output to the vault directly; route it through {@link resolveRepoNamespace}
 * (which is what the `vaultName`-less path below does). The WARN above therefore
 * deliberately does NOT print the derived value.
 *
 * Re-exported by `./process.mjs` for backwards compatibility — that was its home
 * until the #734b cycle break, and the module-level cache means there must remain
 * exactly ONE definition.
 *
 * @returns {string} e.g. 'Kanevry/session-orchestrator' or a bare directory name.
 */
export function deriveRepo() {
  if (_cachedRepo !== null) return _cachedRepo;

  const resolved = resolvePreferredRemote({});
  if (resolved.ok) {
    const identifier = repoIdentifierFromRemoteUrl(resolved.url);
    if (identifier !== '') {
      _cachedRepo = identifier;
      return _cachedRepo;
    }
  } else if (isQueryFailure(resolved.reason)) {
    process.stderr.write(
      `WARN vault-mirror/namespace: could not query git remotes (${resolved.reason}); ` +
        'falling back to the checkout directory name — vault notes may be namespaced ' +
        'under the directory rather than the repo identity\n',
    );
  }

  _cachedRepo = basename(process.cwd());
  return _cachedRepo;
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
