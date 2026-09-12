/**
 * ux-grill/paths.mjs — Pure path builders for ux-grill run artifacts.
 *
 * Near-leaf module: node builtins (`node:path`, `node:crypto`) plus the repo's
 * own `../crypto-digest-utils.mjs` (itself a `node:crypto` leaf) and
 * `../test-runner/artifact-paths.mjs` (a `node:path` leaf), no I/O. All
 * functions are side-effect free — callers do the mkdir. Every builder returns
 * an ABSOLUTE path resolved against `repoRoot`.
 *
 * The run-id invariant ({@link RUN_ID_PATTERN}, `assertRunId`) is imported from
 * `scripts/lib/test-runner/artifact-paths.mjs`, so the two artifact trees can
 * never drift apart on what a safe run id is. Its path BUILDERS are not reused:
 * they return REPO-RELATIVE paths under `.orchestrator/metrics/test-runs/` and
 * take no `repoRoot`, so they are not substitutable here (PRD § 2 S2: "eigener
 * Pfad-Helfer"). Its `makeRunId()` (`<pid>-<ms>`) is likewise not reused:
 * a pid is not unique across hosts and ux-grill artefacts are meant to be
 * committed/compared across machines — see {@link makeRunId}.
 *
 * Exports:
 *   UX_GRILL_METRICS_DIR, UX_GRILL_LEDGER, RUN_ID_PATTERN,
 *   makeRunId(), runDirPath(), screenshotsDir(), axeDir(), measuresDir(),
 *   findingsPath(), runRecordPath(), artefactStem(), screenshotName()
 */

import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { digestSha256Short } from '../crypto-digest-utils.mjs';
import { RUN_ID_PATTERN, assertRunId } from '../test-runner/artifact-paths.mjs';

// Re-exported so existing `ux-grill/paths.mjs` importers keep working; the
// definition lives in test-runner/artifact-paths.mjs (one run-id invariant).
export { RUN_ID_PATTERN };

/**
 * Repo-relative directory holding one sub-directory per ux-grill run.
 * @type {string}
 */
export const UX_GRILL_METRICS_DIR = '.orchestrator/metrics/ux-grill';

/**
 * Repo-relative JSONL ledger of run-records (one line per run, PRD § 4).
 * @type {string}
 */
export const UX_GRILL_LEDGER = '.orchestrator/metrics/ux-grill.jsonl';

const SCREENSHOT_NAME_MAX = 120;

/**
 * Length of the raw-input digest every artefact name carries.
 *
 * The slug alone is LOSSY — `/a b` and `/a_b` both slugify to `_a_b`, and two
 * routes differing only past {@link STEM_SLUG_MAX} truncate to the same prefix.
 * Either collision silently overwrites one route's screenshot, axe JSON and
 * measures JSON with another's, so a filed issue's `evidence` points at a
 * different page than the finding describes.
 *
 * Named ceiling (BV-004): 6 hex chars = 24 bits. Fine for the tens-to-hundreds
 * of route × viewport pairs one manifest declares; revisit if a manifest ever
 * declares thousands.
 * @type {number}
 */
const STEM_DIGEST_LENGTH = 6;

/**
 * Cap on the slug part of {@link artefactStem}, leaving room under
 * {@link SCREENSHOT_NAME_MAX} for `-<digest>` and the `-<variant>` suffix
 * {@link screenshotName} appends.
 * @type {number}
 */
const STEM_SLUG_MAX = 96;

/**
 * Generate a run id of the form `<unix-ms>-<6 hex>`.
 *
 * Millisecond prefix keeps runs lexically sortable; the 6 random hex chars
 * disambiguate two runs started in the same millisecond (and, unlike a pid,
 * stay meaningful when a run directory is compared across hosts). Not a
 * security token — `randomBytes` is used because it is the node-native
 * source (SEC-015 prefers it over `Math.random` regardless).
 *
 * @returns {string} e.g. `'1757635200123-9f3a01'`
 */
export function makeRunId() {
  return `${Date.now()}-${randomBytes(3).toString('hex')}`;
}

/**
 * Validate a repo root.
 * @param {string} repoRoot
 * @returns {string} the same repoRoot
 * @throws {TypeError} if absent or empty
 */
function assertRepoRoot(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new TypeError('ux-grill paths: repoRoot must be a non-empty string');
  }
  return repoRoot;
}

/**
 * Absolute path of one run's artifact directory.
 * @param {string} repoRoot
 * @param {string} runId
 * @returns {string}
 * @throws {TypeError} on an invalid repoRoot or runId (path-traversal guard)
 */
export function runDirPath(repoRoot, runId) {
  return path.resolve(assertRepoRoot(repoRoot), UX_GRILL_METRICS_DIR, assertRunId(runId));
}

/**
 * Absolute path of the run's screenshot directory (full + fold + journey steps).
 * @param {string} repoRoot
 * @param {string} runId
 * @returns {string}
 */
export function screenshotsDir(repoRoot, runId) {
  return path.join(runDirPath(repoRoot, runId), 'screenshots');
}

/**
 * Absolute path of the run's axe-JSON directory (one file per route × viewport).
 * @param {string} repoRoot
 * @param {string} runId
 * @returns {string}
 */
export function axeDir(repoRoot, runId) {
  return path.join(runDirPath(repoRoot, runId), 'axe');
}

/**
 * Absolute path of the run's measures directory (target-size / overflow / title).
 * @param {string} repoRoot
 * @param {string} runId
 * @returns {string}
 */
export function measuresDir(repoRoot, runId) {
  return path.join(runDirPath(repoRoot, runId), 'measures');
}

/**
 * Absolute path of the run's `findings.jsonl` (one finding per line).
 * @param {string} repoRoot
 * @param {string} runId
 * @returns {string}
 */
export function findingsPath(repoRoot, runId) {
  return path.join(runDirPath(repoRoot, runId), 'findings.jsonl');
}

/**
 * Absolute path of the cross-run run-record ledger ({@link UX_GRILL_LEDGER}).
 * Takes no runId — it is shared by every run of the repo.
 * @param {string} repoRoot
 * @returns {string}
 */
export function runRecordPath(repoRoot) {
  return path.resolve(assertRepoRoot(repoRoot), UX_GRILL_LEDGER);
}

/**
 * Filesystem-safe slug: every character outside `[A-Za-z0-9._-]` becomes `_`,
 * runs of `_` collapse to one.
 * @param {string} value
 * @returns {string}
 */
function slugify(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/_+/g, '_');
}

/**
 * Deterministic, collision-free stem shared by a route × viewport's three
 * artefacts (screenshots, axe JSON, measures JSON).
 *
 * Shape: `<slug>-<6 hex of sha256(raw)>`. The digest is taken over the RAW
 * `route-viewport` input, never over the slug — the slug is the lossy half, so
 * digesting it would reproduce exactly the collisions it exists to break (see
 * {@link STEM_DIGEST_LENGTH}).
 *
 * Same inputs always produce the same stem, so a re-run overwrites rather than
 * accumulating near-duplicates.
 *
 * @param {object} opts
 * @param {string} opts.route - route path, e.g. `/dashboard`, or a journey name
 * @param {string} opts.viewport - viewport label, e.g. `desktop` or `mobile`
 * @returns {string} e.g. `'_dashboard-desktop-3f1a9c'`
 * @throws {TypeError} if any part is missing or empty
 */
export function artefactStem({ route, viewport } = {}) {
  for (const [name, value] of [
    ['route', route],
    ['viewport', viewport],
  ]) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`artefactStem: ${name} must be a non-empty string`);
    }
  }
  const raw = `${route}-${viewport}`;
  return `${slugify(raw).slice(0, STEM_SLUG_MAX)}-${digestSha256Short(raw, { length: STEM_DIGEST_LENGTH })}`;
}

/**
 * Deterministic, filesystem-safe screenshot file name:
 * {@link artefactStem} plus the variant, which stays the LAST segment so a
 * caller can derive the stem from the name (and the reverse: the stem is the
 * name without its variant suffix).
 *
 * @param {object} opts
 * @param {string} opts.route - route path, e.g. `/dashboard`
 * @param {string} opts.viewport - viewport label, e.g. `desktop` or `mobile`
 * @param {string} opts.variant - `'full'`, `'fold'` or `'step-<n>'`
 * @returns {string} e.g. `'_dashboard-desktop-3f1a9c-full'` (no extension)
 * @throws {TypeError} if any part is missing, or `variant` is not one of the three shapes
 */
export function screenshotName({ route, viewport, variant } = {}) {
  if (typeof variant !== 'string' || variant.length === 0) {
    throw new TypeError('screenshotName: variant must be a non-empty string');
  }
  if (variant !== 'full' && variant !== 'fold' && !/^step-\d+$/.test(variant)) {
    throw new TypeError(`screenshotName: variant must be 'full', 'fold' or 'step-<n>', got ${JSON.stringify(variant)}`);
  }
  return `${artefactStem({ route, viewport })}-${variant}`.slice(0, SCREENSHOT_NAME_MAX);
}
