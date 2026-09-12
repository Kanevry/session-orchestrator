/**
 * ux-grill/run-record.mjs — the ONLY reader/writer of the ux-grill run-record
 * ledger (`.orchestrator/metrics/ux-grill.jsonl`) and of a run's `findings.jsonl`.
 *
 * Leaf-ish module: `node:fs` + `node:path` plus the two ux-grill leaf modules
 * (`./paths.mjs`, `./schema.mjs`). No shell-outs, no network, no other project
 * imports — so `compare.mjs` can depend on it without dragging a closure in.
 *
 * WHY a module and not `fs.appendFileSync` at each call site: the record is
 * written ONCE by `collect()` with `compare` at its schema defaults
 * (`{new:0, persisting:0, fixed:0}`) and PATCHED later by `compare.mjs`, after
 * the previous run has been located. Two writers on one append-only file need a
 * single place that knows (a) how a record is validated before it is appended,
 * (b) that the patch is a line rewrite which must preserve line ORDER and every
 * line it does not own, including unparseable ones.
 *
 * TOLERANT READS, COUNTED. Both readers skip a line they cannot parse and
 * return how many they skipped, instead of throwing. A ledger is append-only
 * telemetry that several processes write; one truncated line must not make the
 * whole comparison impossible — but a silently-dropped line is exactly the
 * "measurement over an unnamed population" trap, so the count is part of the
 * return value and callers are expected to surface it.
 *
 * Exports:
 *   appendRunRecord(repoRoot, record)
 *   readRunRecords(repoRoot, {manifestHash, build, limit})
 *   findPreviousRun(repoRoot, {manifestHash, build, beforeRunId})
 *   updateRunRecordCompare(repoRoot, runId, compare)
 *   readFindings(repoRoot, runId)
 */

import fs from 'node:fs';
import path from 'node:path';

import { findingsPath, runRecordPath } from './paths.mjs';
import { makeRunRecord } from './schema.mjs';

/** Default number of (filtered) records `readRunRecords` returns. */
const DEFAULT_READ_LIMIT = 50;

/**
 * Read a UTF-8 file, returning `null` when it does not exist.
 * Any other error (EACCES, EISDIR) propagates — that is a real defect, not an
 * empty history, and must not read as "no previous run".
 *
 * @param {string} file
 * @returns {string|null}
 */
function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Parse a JSONL text blob into objects, counting the lines that did not parse.
 *
 * @param {string|null} text
 * @param {(value: unknown) => boolean} isRecord - shape predicate; a parsed
 *   line failing it counts as skipped, same as a syntax error.
 * @returns {{values: object[], skippedLines: number}}
 */
function parseJsonl(text, isRecord) {
  const values = [];
  let skippedLines = 0;
  if (text === null) return { values, skippedLines };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      skippedLines += 1;
      continue;
    }
    if (!isRecord(parsed)) {
      skippedLines += 1;
      continue;
    }
    values.push(parsed);
  }
  return { values, skippedLines };
}

/** A run-record is usable only when it carries the compare key: `run_id`. */
function isRunRecord(value) {
  return typeof value === 'object' && value !== null && typeof value.run_id === 'string';
}

/** A finding is usable only when it carries its identity: `fingerprint`. */
function isFinding(value) {
  return typeof value === 'object' && value !== null && typeof value.fingerprint === 'string';
}

/**
 * Append ONE run-record to the ledger, creating the metrics directory if needed.
 *
 * The record is re-validated through {@link makeRunRecord} (required fields,
 * `build` enum, `skipped[].reason` enum) but the ORIGINAL object is what gets
 * written — re-validation must never silently re-default a field the caller
 * set. Invalid input throws rather than appending a half-record: a ledger line
 * nothing can parse is worse than a missing one, because the next reader counts
 * it as `skippedLines` forever.
 *
 * This is the function `collect.mjs` calls (`collect.mjs:60` imports it, `:970`
 * invokes it) — verified 2026-09-12, which is what makes the module header's
 * "ONLY writer" claim true rather than aspirational.
 *
 * @param {string} repoRoot - absolute repo root of the TARGET repo
 * @param {object} record - a record built by `makeRunRecord`
 * @returns {object} the same record, for chaining
 * @throws {TypeError} when the record fails schema validation
 */
export function appendRunRecord(repoRoot, record) {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new TypeError('appendRunRecord: record must be a plain object');
  }
  // Throws on any invalid required field; the return value is deliberately unused.
  makeRunRecord({
    runId: record.run_id,
    manifestHash: record.manifest_hash,
    rubricHash: record.rubric_hash,
    build: record.build,
    skipped: Array.isArray(record.skipped) ? record.skipped : [],
    countsBySeverity: record.counts_by_severity,
    provisionalCount: record.provisional_count,
  });

  const ledger = runRecordPath(repoRoot);
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.appendFileSync(ledger, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

/**
 * Read run-records from the ledger, newest LAST (file/append order preserved).
 *
 * @param {string} repoRoot
 * @param {object} [opts]
 * @param {string} [opts.manifestHash] - keep only records with this `manifest_hash`
 * @param {string} [opts.build] - keep only records with this `build`
 * @param {number} [opts.limit=50] - keep at most this many of the MOST RECENT
 *   matches (the tail of the filtered list). `Infinity` reads everything.
 * @returns {{records: object[], skippedLines: number}} `skippedLines` counts
 *   lines that were unparseable OR carried no `run_id`.
 */
export function readRunRecords(repoRoot, { manifestHash, build, limit = DEFAULT_READ_LIMIT } = {}) {
  const { values, skippedLines } = parseJsonl(readTextOrNull(runRecordPath(repoRoot)), isRunRecord);
  let records = values;
  if (manifestHash !== undefined) records = records.filter((r) => r.manifest_hash === manifestHash);
  if (build !== undefined) records = records.filter((r) => r.build === build);
  if (Number.isFinite(limit) && limit >= 0 && records.length > limit) {
    records = records.slice(records.length - limit);
  }
  return { records, skippedLines };
}

/**
 * Find the run to compare the current run against.
 *
 * The baseline must share BOTH keys:
 *   - `manifest_hash` — a different manifest measured different routes/viewports,
 *     so a fingerprint missing from it was never looked for, not fixed.
 *   - `build` — a dev build is not a measurement basis for a prod run (a dev
 *     bundle's geometry differs, which is exactly why `makeFinding` marks
 *     dev-build target-size findings `provisional`). Comparing across builds
 *     would report layout noise as `new`/`fixed` product change.
 *
 * `rubric_hash` is deliberately NOT a filter: a rubric change must still be
 * comparable, it only changes how `fixed` may be READ — see `compare.mjs`
 * § rubricChanged.
 *
 * @param {string} repoRoot
 * @param {object} opts
 * @param {string} opts.manifestHash
 * @param {string} opts.build
 * @param {string} [opts.beforeRunId] - the CURRENT run; records from its ledger
 *   line onward are ignored, so a run never compares against itself or against
 *   a run appended after it.
 * @returns {object|null} the most recent matching record, or `null` (baseline run)
 */
export function findPreviousRun(repoRoot, { manifestHash, build, beforeRunId } = {}) {
  const { records } = readRunRecords(repoRoot, { limit: Infinity });
  let scope = records;
  if (typeof beforeRunId === 'string' && beforeRunId.length > 0) {
    const index = records.findIndex((r) => r.run_id === beforeRunId);
    if (index >= 0) scope = records.slice(0, index);
  }
  for (let i = scope.length - 1; i >= 0; i -= 1) {
    const record = scope[i];
    if (manifestHash !== undefined && record.manifest_hash !== manifestHash) continue;
    if (build !== undefined && record.build !== build) continue;
    return record;
  }
  return null;
}

/**
 * Validate a compare-counts object: exactly three non-negative integers.
 * @param {unknown} compare
 * @returns {{new: number, persisting: number, fixed: number}}
 * @throws {TypeError}
 */
function assertCompareCounts(compare) {
  if (typeof compare !== 'object' || compare === null || Array.isArray(compare)) {
    throw new TypeError('updateRunRecordCompare: compare must be a plain object');
  }
  const out = {};
  for (const key of ['new', 'persisting', 'fixed']) {
    const value = compare[key];
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(`updateRunRecordCompare: compare.${key} must be a non-negative integer, got ${String(value)}`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Patch the `compare` counts of ONE already-appended run-record, in place.
 *
 * Rewrites the ledger atomically (tmp file in the same directory + `rename`) so
 * a crash mid-write cannot leave a truncated ledger. Line ORDER is preserved and
 * every line this call does not own is written back BYTE-IDENTICALLY, including
 * lines that do not parse — a repair pass must never be the thing that destroys
 * the evidence it was reading (the raw-sidecar lesson, one layer up).
 *
 * The record carries COUNTS, never the fingerprint lists — that is the schema
 * (`makeRunRecord` § compare). The lists stay in the caller's hands.
 *
 * BV-004 — deliberate simplification, its CEILING and its REVISIT TRIGGER:
 * this is a WHOLE-LEDGER rewrite (read every line, re-serialise the one that
 * matches, `rename` the lot) rather than a seek-and-patch. Ceiling: fine while
 * `.orchestrator/metrics/ux-grill.jsonl` stays under ~10k records — one record
 * per `/ux-grill` run, i.e. years of routine use at a few runs per session.
 * REVISIT TRIGGER: the ledger passing ~10k lines, or `/ux-grill` becoming a
 * per-commit/CI step rather than an operator-invoked one. Either makes the
 * rewrite O(n) per compare over a file nobody reads whole.
 *
 * CONCURRENCY — decided, not overlooked: this function takes NO lock, and a
 * concurrent {@link appendRunRecord} landing between the read above and the
 * `rename` below would be lost. That is accepted because ONE ux-grill run per
 * repo is the only shape the surrounding design admits: Stufe 1 is a single
 * coordinator-direct Bash call (`skills/ux-grill/SKILL.md` § 0.4 — "exactly one
 * Bash invocation", "No dispatched agent runs Stufe 1"), and the compare step
 * runs after it in the same thread. Taking `withFileLock` from
 * `scripts/lib/file-lock.mjs` would additionally force this whole module async
 * for a race the design forbids. REVISIT TRIGGER for the assumption: the first
 * caller that runs `collect()` in parallel (multi-target sweep, CI matrix) —
 * then use `withFileLock` here AND in `appendRunRecord`, never only one of them.
 *
 * @param {string} repoRoot
 * @param {string} runId
 * @param {{new: number, persisting: number, fixed: number}} compare
 * @returns {{updated: number, skippedLines: number}} `updated` is how many
 *   ledger lines matched `runId` (0 = the record is not in the ledger; the
 *   caller decides whether that is an error).
 * @throws {TypeError} on a malformed `compare`
 */
export function updateRunRecordCompare(repoRoot, runId, compare) {
  const counts = assertCompareCounts(compare);
  const ledger = runRecordPath(repoRoot);
  const text = readTextOrNull(ledger);
  if (text === null) return { updated: 0, skippedLines: 0 };

  let updated = 0;
  let skippedLines = 0;
  const out = [];
  for (const raw of text.split('\n')) {
    if (raw.trim().length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      skippedLines += 1;
      out.push(raw); // preserved verbatim — never dropped by a patch pass
      continue;
    }
    if (isRunRecord(parsed) && parsed.run_id === runId) {
      parsed.compare = { ...counts };
      updated += 1;
      out.push(JSON.stringify(parsed));
      continue;
    }
    if (!isRunRecord(parsed)) skippedLines += 1;
    out.push(raw);
  }

  const tmp = `${ledger}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, out.length > 0 ? `${out.join('\n')}\n` : '', 'utf8');
  fs.renameSync(tmp, ledger);
  return { updated, skippedLines };
}

/**
 * Read one run's `findings.jsonl`.
 *
 * Returns an ENVELOPE rather than a bare array so the dropped-line count has
 * somewhere to live (see module header): a compare run that silently lost three
 * previous findings would report them as `fixed`.
 *
 * @param {string} repoRoot
 * @param {string} runId
 * @returns {{findings: object[], skippedLines: number}} `findings: []` when the
 *   run produced none AND when the file does not exist — `skippedLines` does not
 *   distinguish those; the caller that needs to tell them apart checks the run
 *   record's `skipped[]`, which is what that field is for.
 */
export function readFindings(repoRoot, runId) {
  const { values, skippedLines } = parseJsonl(readTextOrNull(findingsPath(repoRoot, runId)), isFinding);
  return { findings: values, skippedLines };
}
