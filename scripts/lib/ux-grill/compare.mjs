/**
 * ux-grill/compare.mjs — cross-run fingerprint classification (PRD § 2 S5,
 * § 3 "Reconcile & Regression").
 *
 * Two layers, deliberately split:
 *   - {@link compareFingerprints} is PURE — two arrays in, three arrays out. It
 *     is the whole classification rule and needs no filesystem to be tested.
 *   - {@link compareRuns} is the thin I/O wrapper: it loads the current run's
 *     findings, locates the baseline run via `run-record.mjs`, applies the pure
 *     function, subtracts the UNMEASURED set, and patches the run-record's
 *     `compare` counts.
 *
 * Imports `./run-record.mjs` only (which is itself fs + `./paths.mjs` +
 * `./schema.mjs`). No shell-out, no network.
 *
 * THE TWO WAYS A `fixed` CLASSIFICATION LIES, both surfaced rather than hidden:
 *
 *   1. A rule left the RUBRIC. If the baseline ran under a different
 *      `rubric_hash`, a fingerprint that disappeared may no longer be
 *      checked for. `compareRuns` still compares (refusing to compare would
 *      lose the persisting set too) but returns `rubricChanged: true`, and the
 *      `fixed` array then carries FIXED-OR-RUBRIC-CHANGED semantics — a fact
 *      for the caller to render, never a filter applied here.
 *
 *   2. A measurement never RAN. A route whose `open` failed, a viewport whose
 *      `set device` did not take, one `eval` that threw — every such step is a
 *      `skipped[]` entry in the run record precisely because zero findings for
 *      a check that never ran is indistinguishable from a clean check
 *      (`schema.mjs` § SKIP_REASONS). Previous findings under a skipped scope
 *      are therefore removed from `fixed` and returned as `unmeasured`.
 *
 * Exports:
 *   compareFingerprints(previousFindings, currentFindings)
 *   compareRuns({repoRoot, runId, manifestHash, build, rubricHash, skipped})
 */

import {
  findPreviousRun,
  readFindings,
  readRunRecords,
  updateRunRecordCompare,
} from './run-record.mjs';

/** Sort findings by fingerprint so every consumer sees one deterministic order. */
function byFingerprint(findings) {
  return [...findings].sort((a, b) =>
    a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0,
  );
}

/**
 * Index findings by fingerprint. A duplicate fingerprint keeps the FIRST entry:
 * `collect()` writes at most one finding per (checkId, locator) pair, so a
 * duplicate is a malformed input, and "first wins" makes the result independent
 * of file order.
 *
 * @param {Array<{fingerprint: string}>} findings
 * @returns {Map<string, object>}
 */
function indexByFingerprint(findings) {
  const map = new Map();
  for (const finding of findings) {
    const fp = finding?.fingerprint;
    if (typeof fp !== 'string' || fp.length === 0) continue;
    if (!map.has(fp)) map.set(fp, finding);
  }
  return map;
}

/**
 * Classify every fingerprint of two runs as `new`, `persisting` or `fixed`.
 *
 * Pure. Knows nothing about skips or rubric hashes — the caller subtracts those
 * (see {@link compareRuns}), because they are facts about the RUN, not about the
 * fingerprint sets.
 *
 * @param {Array<{fingerprint: string}>} previousFindings - the baseline run's findings
 * @param {Array<{fingerprint: string}>} currentFindings - this run's findings
 * @returns {{new: object[], persisting: object[], fixed: object[]}} FINDING
 *   objects, each array sorted by fingerprint. `new` and `persisting` carry the
 *   CURRENT finding (its severity/evidence are the ones that matter now);
 *   `fixed` carries the PREVIOUS finding, which is the only record of it left.
 * @throws {TypeError} if either argument is not an array
 */
export function compareFingerprints(previousFindings, currentFindings) {
  if (!Array.isArray(previousFindings)) {
    throw new TypeError('compareFingerprints: previousFindings must be an array');
  }
  if (!Array.isArray(currentFindings)) {
    throw new TypeError('compareFingerprints: currentFindings must be an array');
  }
  const previous = indexByFingerprint(previousFindings);
  const current = indexByFingerprint(currentFindings);

  const fresh = [];
  const persisting = [];
  for (const [fp, finding] of current) {
    (previous.has(fp) ? persisting : fresh).push(finding);
  }
  const fixed = [];
  for (const [fp, finding] of previous) {
    if (!current.has(fp)) fixed.push(finding);
  }
  return { new: byFingerprint(fresh), persisting: byFingerprint(persisting), fixed: byFingerprint(fixed) };
}

/**
 * Parse ONE `skipped[].what` into the locator scope it invalidates.
 *
 * `collect.mjs` emits exactly five `what` shapes (measured 2026-09-12 against
 * `scripts/lib/ux-grill/collect.mjs` — `skipEntry(` call sites at :745, :748,
 * :765, :774, :991):
 *
 *   `viewport:<vp>`                    device-mismatch  → the whole viewport
 *   `viewport:<vp>|eval:viewport-width` measure-failed  → the whole viewport
 *   `route:<path>|<vp>`                route-unreachable→ that route × viewport
 *   `<path>|<vp>|<call>`               measure-failed   → that route × viewport
 *   `journey:<name>`                   route-unreachable→ that journey, all viewports
 *
 * The last shape carries no viewport, so it invalidates the journey on EVERY
 * viewport — widening rather than guessing, because the cost of a
 * false `unmeasured` is a finding reported as still-open, while the cost of a
 * missed one is an outage reported as `fixed`.
 *
 * @param {string} what
 * @returns {{kind: 'viewport', viewport: string}
 *   | {kind: 'route', route: string, viewport: string|null}
 *   | {kind: 'journey', name: string}
 *   | null} `null` for an unrecognised shape (it invalidates nothing)
 */
function skipScope(what) {
  if (typeof what !== 'string' || what.length === 0) return null;
  const segments = what.split('|');
  const head = segments[0];
  if (head.startsWith('viewport:')) {
    const viewport = head.slice('viewport:'.length);
    return viewport.length > 0 ? { kind: 'viewport', viewport } : null;
  }
  if (head.startsWith('route:')) {
    const route = head.slice('route:'.length);
    return route.length > 0 ? { kind: 'route', route, viewport: segments[1] ?? null } : null;
  }
  if (head.startsWith('journey:')) {
    const name = head.slice('journey:'.length);
    return name.length > 0 ? { kind: 'journey', name } : null;
  }
  // Bare `<route>|<viewport>|<call>` — the measure-failed shape.
  if (segments.length >= 2 && head.length > 0) {
    return { kind: 'route', route: head, viewport: segments[1] };
  }
  return null;
}

/**
 * Build a predicate over finding LOCATORS from a run's `skipped[]`.
 *
 * Finding locators are `route|viewport|selector` or `journey|viewport|<name>`
 * (`schema.mjs` § makeFinding).
 *
 * @param {Array<{what: string, reason: string}>} skipped
 * @returns {(locator: string) => boolean} true when the locator sits under a
 *   scope this run did not measure
 */
function unmeasuredMatcher(skipped) {
  const scopes = [];
  for (const entry of Array.isArray(skipped) ? skipped : []) {
    const scope = skipScope(entry?.what);
    if (scope) scopes.push(scope);
  }
  if (scopes.length === 0) return () => false;
  return (locator) => {
    if (typeof locator !== 'string') return false;
    const segments = locator.split('|');
    for (const scope of scopes) {
      if (scope.kind === 'viewport' && segments[1] === scope.viewport) return true;
      if (
        scope.kind === 'route' &&
        segments[0] === scope.route &&
        (scope.viewport === null || segments[1] === scope.viewport)
      ) {
        return true;
      }
      if (scope.kind === 'journey' && segments[0] === 'journey' && segments[2] === scope.name) return true;
    }
    return false;
  };
}

/**
 * Compare one run against its baseline and patch the run-record's counts.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot - absolute repo root of the TARGET repo
 * @param {string} opts.runId - the CURRENT run
 * @param {string} [opts.manifestHash] - compare key; read from the current run's
 *   ledger record when omitted
 * @param {string} [opts.build] - `'dev'`/`'prod'`; read from the record when omitted
 * @param {string} [opts.rubricHash] - this run's rubric hash; read from the record
 *   when omitted. Drives `rubricChanged` only — never the baseline selection.
 * @param {Array<{what: string, reason: string}>} [opts.skipped] - this run's
 *   skips; read from the record when omitted
 * @returns {{
 *   runId: string, previousRunId: string|null, baseline: boolean, rubricChanged: boolean,
 *   new: object[], persisting: object[], fixed: object[], unmeasured: object[],
 *   counts: {new: number, persisting: number, fixed: number},
 *   recordUpdated: number, skippedLines: {current: number, previous: number, ledger: number}
 * }} `fixed` carries FIXED-OR-RUBRIC-CHANGED semantics whenever
 *   `rubricChanged` is true (see module header). `unmeasured` carries previous
 *   findings whose route/viewport/journey this run did not measure — they are
 *   NOT in `fixed` and NOT in `persisting`.
 * @throws {TypeError} when `manifestHash`/`build` can be resolved from neither
 *   the arguments nor the ledger — comparing without a compare key would silently
 *   pick an unrelated run as the baseline.
 */
export function compareRuns({ repoRoot, runId, manifestHash, build, rubricHash, skipped } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new TypeError('compareRuns: repoRoot must be a non-empty string');
  }
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new TypeError('compareRuns: runId must be a non-empty string');
  }

  const { records, skippedLines: ledgerSkippedLines } = readRunRecords(repoRoot, { limit: Infinity });
  const currentRecord = records.find((record) => record.run_id === runId) ?? null;

  const effectiveManifestHash = manifestHash ?? currentRecord?.manifest_hash;
  const effectiveBuild = build ?? currentRecord?.build;
  const effectiveRubricHash = rubricHash ?? currentRecord?.rubric_hash ?? null;
  const effectiveSkipped = skipped ?? currentRecord?.skipped ?? [];
  if (typeof effectiveManifestHash !== 'string' || effectiveManifestHash.length === 0) {
    throw new TypeError(`compareRuns: no manifestHash for run ${runId} — pass one or append its run-record first`);
  }
  if (typeof effectiveBuild !== 'string' || effectiveBuild.length === 0) {
    throw new TypeError(`compareRuns: no build for run ${runId} — pass one or append its run-record first`);
  }

  const currentRead = readFindings(repoRoot, runId);
  const previousRecord = findPreviousRun(repoRoot, {
    manifestHash: effectiveManifestHash,
    build: effectiveBuild,
    beforeRunId: runId,
  });

  let result;
  let previousRead = { findings: [], skippedLines: 0 };
  if (previousRecord === null) {
    // Baseline run: everything measured is new by definition. Not "clean" —
    // a first run with 40 findings has 40 new ones.
    result = { new: byFingerprint(currentRead.findings), persisting: [], fixed: [] };
  } else {
    previousRead = readFindings(repoRoot, previousRecord.run_id);
    result = compareFingerprints(previousRead.findings, currentRead.findings);
  }

  const isUnmeasured = unmeasuredMatcher(effectiveSkipped);
  const unmeasured = [];
  const fixed = [];
  for (const finding of result.fixed) {
    (isUnmeasured(finding?.locator) ? unmeasured : fixed).push(finding);
  }

  const counts = { new: result.new.length, persisting: result.persisting.length, fixed: fixed.length };
  const { updated } = updateRunRecordCompare(repoRoot, runId, counts);

  return {
    runId,
    previousRunId: previousRecord?.run_id ?? null,
    baseline: previousRecord === null,
    rubricChanged:
      previousRecord !== null &&
      effectiveRubricHash !== null &&
      previousRecord.rubric_hash !== effectiveRubricHash,
    new: result.new,
    persisting: result.persisting,
    fixed,
    unmeasured,
    counts,
    recordUpdated: updated,
    skippedLines: {
      current: currentRead.skippedLines,
      previous: previousRead.skippedLines,
      ledger: ledgerSkippedLines,
    },
  };
}
