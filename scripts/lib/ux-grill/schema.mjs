/**
 * ux-grill/schema.mjs — Frozen contract for Stufe-1 (mechanical) ux-grill records.
 *
 * Leaf module: imports only `../test-runner/fingerprint.mjs` (no I/O, no side
 * effects, no node builtins). Every producer of a ux-grill finding or run-record
 * (`collect.mjs`, `measures.mjs`, `compare.mjs`) goes through this module so the
 * fingerprint inputs and the severity table have exactly one definition.
 *
 * Spec: docs/prd/2026-09-12-ux-grill.md § 2 S2/S3 and § 4 Data Model.
 *
 * Exports:
 *   SCOPE, CHECK_IDS, SEVERITIES, SEVERITY_BY_CHECK, SKIP_REASONS,
 *   RUN_RECORD_SCHEMA_VERSION, LOCATOR_MAX_LENGTH,
 *   severityForAxeImpact(), makeFinding(), countBySeverity(), makeRunRecord()
 */

import { fingerprintFinding } from '../test-runner/fingerprint.mjs';

/**
 * Fingerprint scope for every ux-grill finding. Constant by contract: it is a
 * fingerprint input, so changing it invalidates every previously filed issue.
 * @type {string}
 */
export const SCOPE = 'ux-grill';

/**
 * The check identifiers ux-grill Stufe 1 can emit (PRD § 2 S3 table).
 *
 * `axe-violations` is the CATALOGUE entry only — an emitted axe finding carries
 * `checkId = 'axe-<ruleId>'` (rubric-v1 § Fingerprint), so that two axe rules
 * violated on the same selector remain two distinct findings.
 * @type {Readonly<Record<string, string>>}
 */
export const CHECK_IDS = Object.freeze({
  AXE_VIOLATIONS: 'axe-violations',
  CONSOLE_ERRORS: 'console-errors',
  JOURNEY_STEP_COUNT: 'journey-step-count',
  JOURNEY_FAILED: 'journey-failed',
  TARGET_SIZE_FLOOR: 'target-size-floor',
  TARGET_SIZE_TARGET: 'target-size-target',
  HORIZONTAL_OVERFLOW: 'horizontal-overflow',
  TITLE_MISMATCH: 'title-mismatch',
});

/**
 * Severities ux-grill Stufe 1 emits, most severe first.
 *
 * Note: `skills/test-runner/rubric-v1.md` additionally knows `critical` for
 * issue routing. Stufe 1 of ux-grill NEVER emits `critical` — every severity
 * here is derived from a measured value (PRD § 2 S3), and no measured ux
 * violation is defined as release-blocking. Stufe 2 emits no severity at all.
 * @type {readonly string[]}
 */
export const SEVERITIES = Object.freeze(['high', 'medium', 'low']);

/**
 * Static severity per check id (PRD § 2 S3). Axe is absent by design — its
 * severity comes from the impact field, see {@link severityForAxeImpact}.
 * @type {Readonly<Record<string, string>>}
 */
export const SEVERITY_BY_CHECK = Object.freeze({
  [CHECK_IDS.TARGET_SIZE_FLOOR]: 'high',
  [CHECK_IDS.TARGET_SIZE_TARGET]: 'medium',
  [CHECK_IDS.HORIZONTAL_OVERFLOW]: 'medium',
  [CHECK_IDS.JOURNEY_FAILED]: 'high',
  [CHECK_IDS.JOURNEY_STEP_COUNT]: 'medium',
  [CHECK_IDS.CONSOLE_ERRORS]: 'medium',
  [CHECK_IDS.TITLE_MISMATCH]: 'low',
});

/**
 * Reasons a Stufe-1 step may be recorded as skipped in the run-record.
 *
 * - `device-mismatch`  — `set device` / `set viewport` did not produce the
 *   requested `window.innerWidth`; the viewport is skipped rather than filed
 *   under a wrong label (PRD § 3 AC "Stufe 1").
 * - `pencil-unavailable` — Pen.app or its MCP surface is not reachable; the
 *   optional coverage step is skipped and the run still ends without error.
 * - `route-unreachable` — the route failed to load. It is a SKIP, not a
 *   dropped route: a route that never loaded produced no measurement, so
 *   emitting zero findings for it would read as "clean" in the next compare
 *   run and silently turn an outage into a `fixed` classification. Also used
 *   for a journey whose `start` page never opened.
 * - `measure-failed` — ONE browser measurement on an otherwise reachable page
 *   did not produce a usable payload: a non-zero exit, an unparseable stdout,
 *   or an `agent-browser` envelope carrying `success: false` (measured
 *   2026-09-12, v0.37.1: a page-side `eval` throw answers `{"success":false,
 *   "data":null,...}` at EXIT CODE 0). Without this reason such a call is
 *   indistinguishable from "measured, found nothing" — zero findings for a
 *   check that never ran, which the next compare run reads as `fixed`.
 * @type {Readonly<Record<string, string>>}
 */
export const SKIP_REASONS = Object.freeze({
  DEVICE_MISMATCH: 'device-mismatch',
  PENCIL_UNAVAILABLE: 'pencil-unavailable',
  ROUTE_UNREACHABLE: 'route-unreachable',
  MEASURE_FAILED: 'measure-failed',
});

/**
 * Schema version of the `.orchestrator/metrics/ux-grill.jsonl` run-record.
 * @type {number}
 */
export const RUN_RECORD_SCHEMA_VERSION = 1;

/**
 * Locators longer than this are truncated BEFORE fingerprinting
 * (`skills/test-runner/rubric-v1.md` § Truncation rule for long locators).
 * @type {number}
 */
export const LOCATOR_MAX_LENGTH = 256;

/** Characters forbidden in a locator: they are the fingerprint separator / shell arg boundary. */
const LOCATOR_FORBIDDEN = /[\n\r\0]/;

const VALID_BUILDS = Object.freeze(['dev', 'prod']);

/**
 * Map an axe-core `impact` value to a ux-grill severity (PRD § 2 S3).
 *
 * @param {string} impact - axe impact: 'critical' | 'serious' | 'moderate' | 'minor'
 * @returns {string} 'high' | 'medium' | 'low'. Unknown, missing or non-string
 *   impacts default to `'low'` — an unclassifiable violation is reported but
 *   never allowed to inflate the high band that drives automatic issue filing.
 */
export function severityForAxeImpact(impact) {
  if (impact === 'critical' || impact === 'serious') return 'high';
  if (impact === 'moderate') return 'medium';
  return 'low';
}

/**
 * Build a ux-grill finding record.
 *
 * The fingerprint is computed from `(SCOPE, checkId, truncatedLocator)` ONLY —
 * never from severity, build, message or evidence, so that the same violation
 * keeps its identity across runs and across dev/prod builds.
 *
 * @param {object} opts
 * @param {string} opts.checkId - a value of {@link CHECK_IDS}, or `axe-<ruleId>`
 *   for axe. Passing the literal `'axe-violations'` throws: two axe rules
 *   violated on one selector must remain two findings, which only holds when the
 *   rule id is part of the fingerprint input.
 * @param {string} opts.locator - `route|viewport|selector` for route checks,
 *   `journey|viewport|<name>` for journey checks. Must contain at least one `|`
 *   and no newline/CR/NUL. Truncated to {@link LOCATOR_MAX_LENGTH} before
 *   fingerprinting; the truncated form is what the record carries.
 * @param {string} opts.severity - one of {@link SEVERITIES}.
 * @param {string} opts.build - `'dev'` or `'prod'`; drives `provisional`.
 * @param {string} [opts.message] - one-line human summary.
 * @param {object} [opts.evidence] - free-form evidence pointers (screenshot
 *   path, axe node, measured px). Defaults to `{}`.
 * @returns {{scope: string, checkId: string, locator: string, severity: string,
 *   provisional: boolean, fingerprint: string, message: string, evidence: object}}
 * @throws {TypeError} on any invalid input — no silent defaults.
 */
export function makeFinding({ checkId, locator, severity, build, message, evidence } = {}) {
  if (typeof checkId !== 'string' || checkId.length === 0) {
    throw new TypeError('makeFinding: checkId must be a non-empty string');
  }
  // Same predicate as the locator check below. `checkId` is fingerprint input
  // and is rendered into issue bodies and JSONL lines; a newline or NUL in it
  // splits one record into two. Downstream `reconcile.oneLine()` contains it
  // today, but the constructor is where a rejected input belongs (BV-002).
  if (LOCATOR_FORBIDDEN.test(checkId)) {
    throw new TypeError('makeFinding: checkId must not contain newline, CR or NUL');
  }
  if (checkId === CHECK_IDS.AXE_VIOLATIONS) {
    throw new TypeError(
      "makeFinding: checkId 'axe-violations' is the catalogue entry, not an emittable id — pass 'axe-<ruleId>' so two axe rules on one selector stay two findings",
    );
  }
  if (typeof locator !== 'string' || locator.length === 0) {
    throw new TypeError('makeFinding: locator must be a non-empty string');
  }
  if (!locator.includes('|')) {
    throw new TypeError("makeFinding: locator must be pipe-delimited (route|viewport|selector or journey|viewport|<name>)");
  }
  if (LOCATOR_FORBIDDEN.test(locator)) {
    throw new TypeError('makeFinding: locator must not contain newline, CR or NUL');
  }
  if (!SEVERITIES.includes(severity)) {
    throw new TypeError(`makeFinding: severity must be one of ${SEVERITIES.join('|')}, got ${String(severity)}`);
  }
  if (!VALID_BUILDS.includes(build)) {
    throw new TypeError(`makeFinding: build must be one of ${VALID_BUILDS.join('|')}, got ${String(build)}`);
  }
  if (message !== undefined && typeof message !== 'string') {
    throw new TypeError('makeFinding: message must be a string when provided');
  }
  if (evidence !== undefined && (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence))) {
    throw new TypeError('makeFinding: evidence must be a plain object when provided');
  }

  const truncated = locator.slice(0, LOCATOR_MAX_LENGTH);
  return {
    scope: SCOPE,
    checkId,
    locator: truncated,
    severity,
    // Dev builds are not a geometry measurement basis (PRD § 2 S3), so
    // target-size findings from a dev build are flagged rather than dropped.
    provisional: build === 'dev' && checkId.startsWith('target-size-'),
    fingerprint: fingerprintFinding({ scope: SCOPE, checkId, locator: truncated }),
    message: message ?? '',
    evidence: evidence ?? {},
  };
}

/**
 * Count findings per severity band.
 *
 * @param {Array<{severity: string}>} findings
 * @returns {{high: number, medium: number, low: number}} zero-filled for every band.
 * @throws {TypeError} if `findings` is not an array or carries an unknown severity.
 */
export function countBySeverity(findings) {
  if (!Array.isArray(findings)) {
    throw new TypeError('countBySeverity: findings must be an array');
  }
  const counts = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) {
    const severity = finding?.severity;
    if (!SEVERITIES.includes(severity)) {
      throw new TypeError(`countBySeverity: unknown severity ${String(severity)}`);
    }
    counts[severity] += 1;
  }
  return counts;
}

/**
 * Build the `.orchestrator/metrics/ux-grill.jsonl` run-record (PRD § 4).
 *
 * @param {object} opts
 * @param {string} opts.runId - run identifier (see `paths.mjs` `makeRunId`).
 * @param {string} opts.manifestHash - hash of the resolved ux-manifest; the
 *   compare key — only runs with the same manifest_hash are comparable.
 * @param {string} opts.rubricHash - hash of `skills/ux-grill/rubric-v2.md`.
 * @param {string} opts.build - `'dev'` or `'prod'`.
 * @param {string} [opts.timestamp] - ISO-8601 UTC; defaults to now.
 * @param {string[]} [opts.viewports] - viewport labels actually run.
 * @param {string[]} [opts.routes] - route paths actually run.
 * @param {Array<{severity: string}>} [opts.findings] - drives `counts_by_severity`
 *   and `provisional_count` when those are not passed explicitly.
 * @param {{high: number, medium: number, low: number}} [opts.countsBySeverity]
 * @param {number} [opts.provisionalCount]
 * @param {{new: number, persisting: number, fixed: number}} [opts.compare]
 * @param {Array<{what: string, reason: string}>} [opts.skipped] - `reason` must
 *   be a value of {@link SKIP_REASONS}.
 * @param {Array<{route: string, frame: string}>} [opts.pencilCoverage]
 * @returns {object} the run-record, with exactly the PRD § 4 fields.
 * @throws {TypeError} on missing/invalid required fields.
 */
export function makeRunRecord({
  runId,
  manifestHash,
  rubricHash,
  build,
  timestamp,
  viewports,
  routes,
  findings,
  countsBySeverity,
  provisionalCount,
  compare,
  skipped,
  pencilCoverage,
} = {}) {
  for (const [name, value] of [
    ['runId', runId],
    ['manifestHash', manifestHash],
    ['rubricHash', rubricHash],
  ]) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`makeRunRecord: ${name} must be a non-empty string`);
    }
  }
  if (!VALID_BUILDS.includes(build)) {
    throw new TypeError(`makeRunRecord: build must be one of ${VALID_BUILDS.join('|')}, got ${String(build)}`);
  }
  const findingList = findings ?? [];
  if (!Array.isArray(findingList)) {
    throw new TypeError('makeRunRecord: findings must be an array when provided');
  }
  for (const entry of skipped ?? []) {
    if (!Object.values(SKIP_REASONS).includes(entry?.reason)) {
      throw new TypeError(`makeRunRecord: unknown skip reason ${String(entry?.reason)}`);
    }
  }

  return {
    schema_version: RUN_RECORD_SCHEMA_VERSION,
    run_id: runId,
    timestamp: timestamp ?? new Date().toISOString(),
    manifest_hash: manifestHash,
    rubric_hash: rubricHash,
    build,
    viewports: viewports ?? [],
    routes: routes ?? [],
    counts_by_severity: countsBySeverity ?? countBySeverity(findingList),
    provisional_count: provisionalCount ?? findingList.filter((f) => f?.provisional).length,
    compare: compare ?? { new: 0, persisting: 0, fixed: 0 },
    skipped: skipped ?? [],
    pencil_coverage: pencilCoverage ?? [],
  };
}
