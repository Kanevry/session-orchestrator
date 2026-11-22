/**
 * ux-grill/compare.mjs — cross-run fingerprint classification (PRD § 2 S5,
 * § 3 "Reconcile & Regression").
 *
 * Two layers, deliberately split:
 *   - {@link compareFingerprints} is PURE — two arrays in, three arrays out. It
 *     is the whole classification rule and needs no filesystem to be tested.
 *   - {@link compareRuns} is the thin I/O wrapper: it loads the current run's
 *     findings, recovers the baseline findings across measurement gaps, applies
 *     the pure function, subtracts the UNMEASURED set, and patches the run-record's
 *     `compare` counts.
 *
 * Imports `./run-record.mjs` and `./schema.mjs`. No shell-out, no network.
 *
 * THE TWO WAYS A `fixed` CLASSIFICATION LIES, both surfaced rather than hidden:
 *
 *   1. A rule left the RUBRIC. If any run contributing to the baseline used a different
 *      `rubric_hash`, a fingerprint that disappeared may no longer be
 *      checked for. `compareRuns` still compares (refusing to compare would
 *      lose the persisting set too) but returns `rubricChanged: true`, and the
 *      `fixed` array then carries FIXED-OR-RUBRIC-CHANGED semantics — a fact
 *      for the caller to render, never a filter applied here.
 *
 *   2. A measurement was INCOMPLETE. A route whose `open` failed, a viewport whose
 *      `set device` did not take, one `eval` that threw — every such step is a
 *      `skipped[]` entry in the run record precisely because zero findings for
 *      a check that never ran is indistinguishable from a clean check
 *      (`schema.mjs` § SKIP_REASONS). Previous findings under a skipped scope
 *      are therefore removed from `fixed` and returned as `unmeasured`.
 *      A capped target-size scan leaves only that check's missing findings
 *      unmeasured on the affected route and viewport.
 *
 * Exports:
 *   compareFingerprints(previousFindings, currentFindings)
 *   compareRuns({repoRoot, runId, manifestHash, build, rubricHash, skipped})
 */

import {
  readFindings,
  readRunRecords,
  updateRunRecordCompare,
} from './run-record.mjs';
import { CHECK_IDS, LOCATOR_MAX_LENGTH } from './schema.mjs';

const TARGET_SIZE_CAP_MARKER = 'eval:target-size:truncated';

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

/** Split the name from the viewport immediately before a known suffix. */
function legacyPair(kind, text) {
  const separator = text.lastIndexOf('|');
  if (separator < 0) return { kind, name: text, viewport: null };
  return { kind, name: text.slice(0, separator), viewport: text.slice(separator + 1) };
}

/** Recover scopes from ledger entries written before `skipped[].scope`. */
function legacySkipScope(what) {
  if (typeof what !== 'string' || what.length === 0) return null;
  if (what.startsWith('viewport:')) {
    return { kind: 'viewport', viewport: what.slice('viewport:'.length).replace(/\|eval:viewport-width$/, '') };
  }
  if (what.startsWith('route:')) return legacyPair('route', what.slice('route:'.length));
  if (what.startsWith('journey:')) {
    const text = what.slice('journey:'.length);
    const step = /\|step \d+ \([^)]+\): agent-browser [^|]*$/.exec(text);
    // Start and readiness skips in older runs did not record a viewport.
    return step
      ? legacyPair('journey', text.slice(0, step.index))
      : { kind: 'journey', name: text, viewport: null };
  }
  const call = /\|(?:get:title|a11y|eval:target-size(?::truncated)?|eval:overflow|errors|wait)$/.exec(what);
  return call ? legacyPair('route', what.slice(0, call.index)) : null;
}

function locatorPart(value) {
  return value.replace(/[\n\r\0]/g, ' ');
}

function isTargetSizeFinding(finding) {
  return finding.checkId === CHECK_IDS.TARGET_SIZE_FLOOR || finding.checkId === CHECK_IDS.TARGET_SIZE_TARGET;
}

/** Build a predicate over findings from a run's skips and target-size scan evidence. */
function unmeasuredMatcher(skipped, currentFindings) {
  const scopes = [];
  const truncatedTargetPrefixes = new Set();
  for (const entry of Array.isArray(skipped) ? skipped : []) {
    const scope = entry?.scope ?? legacySkipScope(entry?.what);
    if (!scope) continue;
    const { kind, name, viewport } = scope;
    const vp = typeof viewport === 'string' ? locatorPart(viewport) : null;
    if (kind === 'viewport') {
      scopes.push(({ locator }) => viewportInLocator(locator) === vp);
    } else if (kind === 'route' && typeof name === 'string') {
      const prefix = (vp === null ? `${locatorPart(name)}|` : `${locatorPart(name)}|${vp}|`).slice(0, LOCATOR_MAX_LENGTH);
      if (typeof entry.what === 'string' && entry.what.endsWith(`|${TARGET_SIZE_CAP_MARKER}`)) {
        truncatedTargetPrefixes.add(prefix);
      } else {
        scopes.push(({ locator }) => locator.startsWith(prefix));
      }
    } else if (kind === 'journey' && typeof name === 'string') {
      const journeyName = locatorPart(name);
      if (vp === null) {
        scopes.push(({ locator }) => {
          if (!locator.startsWith('journey|')) return false;
          const separator = locator.indexOf('|', 'journey|'.length);
          return separator >= 0 && locator.slice(separator + 1) === journeyName.slice(0, LOCATOR_MAX_LENGTH - separator - 1);
        });
      } else {
        const expected = `journey|${vp}|${journeyName}`.slice(0, LOCATOR_MAX_LENGTH);
        scopes.push(({ locator }) => locator === expected);
      }
    }
  }
  // Older runs recorded the cap only in the evidence of returned findings.
  for (const finding of currentFindings) {
    if (finding.evidence?.truncated === true && isTargetSizeFinding(finding) && typeof finding.locator === 'string') {
      if (!hasPrefix(finding.locator, truncatedTargetPrefixes)) {
        const scopePrefix = /^(?:[^|]*\|){2}/.exec(finding.locator)?.[0] ?? finding.locator;
        truncatedTargetPrefixes.add(scopePrefix);
      }
    }
  }
  if (scopes.length === 0 && truncatedTargetPrefixes.size === 0) return null;
  return (finding) => {
    const locator = finding?.locator;
    if (typeof locator !== 'string') return false;
    if (isTargetSizeFinding(finding) && hasPrefix(locator, truncatedTargetPrefixes)) return true;
    return scopes.some((matches) => matches(finding));
  };
}

function hasPrefix(locator, prefixes) {
  // Long stored locators can end before the viewport or its separator.
  for (const prefix of prefixes) {
    if (locator.startsWith(prefix)) return true;
  }
  return false;
}

function viewportInLocator(locator) {
  const start = locator.indexOf('|');
  const end = locator.indexOf('|', start + 1);
  return start >= 0 && end >= 0 ? locator.slice(start + 1, end) : null;
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
 * @param {Array<{what: string, reason: string, scope?: object}>} [opts.skipped] - this run's
 *   skips; read from the record when omitted
 * @returns {{
 *   runId: string, previousRunId: string|null, baseline: boolean, rubricChanged: boolean,
 *   new: object[], persisting: object[], fixed: object[], unmeasured: object[],
 *   counts: {new: number, persisting: number, fixed: number},
 *   recordUpdated: number, skippedLines: {current: number, previous: number, ledger: number}
 * }} `fixed` carries FIXED-OR-RUBRIC-CHANGED semantics whenever
 *   `rubricChanged` is true (see module header). `unmeasured` carries previous
 *   findings whose scope this run did not fully measure — they are
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
  const currentIndex = records.findIndex((record) => record.run_id === runId);
  const currentRecord = records[currentIndex];

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
  const previousFindings = new Map();
  const baselineRubricHashes = new Set();
  const gaps = [];
  let previousRecord = null;
  let previousSkippedLines = 0;
  const end = currentIndex < 0 ? records.length : currentIndex;
  // A finding from an older run is still a baseline candidate only if every
  // intervening matching run left its scope unmeasured. A clean run closes
  // all gaps and lets us stop reading older files.
  for (let index = end - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.manifest_hash !== effectiveManifestHash || record.build !== effectiveBuild) continue;
    if (previousRecord === null) {
      previousRecord = record;
      baselineRubricHashes.add(record.rubric_hash);
    }
    const previousRead = readFindings(repoRoot, record.run_id);
    previousSkippedLines += previousRead.skippedLines;
    for (const [fingerprint, finding] of indexByFingerprint(previousRead.findings)) {
      if (!previousFindings.has(fingerprint) && gaps.every((isGap) => isGap(finding))) {
        previousFindings.set(fingerprint, finding);
        baselineRubricHashes.add(record.rubric_hash);
      }
    }
    const isGap = unmeasuredMatcher(record.skipped, previousRead.findings);
    if (!isGap) break;
    gaps.push(isGap);
  }
  // A first run reports every measured finding as new.
  const result = previousRecord === null
    ? { new: byFingerprint(currentRead.findings), persisting: [], fixed: [] }
    : compareFingerprints([...previousFindings.values()], currentRead.findings);
  const isUnmeasured = unmeasuredMatcher(effectiveSkipped, currentRead.findings);
  const unmeasured = [];
  const fixed = [];
  for (const finding of result.fixed) {
    (isUnmeasured?.(finding) ? unmeasured : fixed).push(finding);
  }

  const counts = { new: result.new.length, persisting: result.persisting.length, fixed: fixed.length };
  const { updated } = updateRunRecordCompare(repoRoot, runId, counts);

  return {
    runId,
    previousRunId: previousRecord?.run_id ?? null,
    baseline: previousRecord === null,
    rubricChanged:
      effectiveRubricHash !== null &&
      [...baselineRubricHashes].some((hash) => hash !== effectiveRubricHash),
    new: result.new,
    persisting: result.persisting,
    fixed,
    unmeasured,
    counts,
    recordUpdated: updated,
    skippedLines: {
      current: currentRead.skippedLines,
      previous: previousSkippedLines,
      ledger: ledgerSkippedLines,
    },
  };
}
