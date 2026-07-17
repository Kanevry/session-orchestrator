/**
 * eval/sink.mjs — append-only sink + reader for the eval journal
 * (.orchestrator/metrics/eval.jsonl), the Single Source of Truth for the
 * aiat-llm-eval standard (Epic #803, S2). The HTML report is a derived view;
 * this journal is authoritative.
 *
 * Design (mirrors scripts/harness-audit.mjs appendAuditRecord): a metrics append
 * MUST NEVER break its caller. The session-end eval phase is advisory and must
 * never block /close, so appendEvalRecord swallows BOTH validation and
 * filesystem errors — it emits a stderr WARN and returns a result object, and
 * NEVER throws. Callers that want hard validation call validateEvalRecord
 * (from ./schema.mjs) directly.
 *
 * Read path reuses readJsonlFile from scripts/lib/io.mjs (missing file → [],
 * malformed lines skipped) — never throws.
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { validateEvalRecord, normalizeEvalRecord } from './schema.mjs';
import { readJsonlFile } from '../io.mjs';

/** Default repo-relative path for the eval journal. */
export const DEFAULT_EVAL_JSONL_PATH = '.orchestrator/metrics/eval.jsonl';

/**
 * Append a single session-eval record to the eval journal. NEVER throws.
 *
 * Steps:
 *   1. validateEvalRecord — stamps schema_version, enforces the full contract
 *      (incl. the no-global-score rule). On failure: stderr WARN + return
 *      { ok:false, reason:'validation', error }. The malformed record is NOT written.
 *   2. Serialize the validated record to JSON + newline.
 *   3. mkdirSync(dirname, recursive) + appendFileSync (append-only). On FS
 *      failure: stderr WARN + return { ok:false, reason:'fs-error', error }.
 *
 * @param {object} record — candidate session-eval record.
 * @param {{ path?: string }} [opts] — target path (absolute preferred); defaults
 *        to DEFAULT_EVAL_JSONL_PATH (repo-relative).
 * @returns {{ ok: true, record: object, path: string }
 *          | { ok: false, reason: 'validation'|'fs-error', error: string }}
 */
export function appendEvalRecord(record, { path: filePath = DEFAULT_EVAL_JSONL_PATH } = {}) {
  let validated;
  try {
    validated = validateEvalRecord(record);
  } catch (err) {
    const msg = err?.message ?? String(err);
    process.stderr.write(`[eval-sink] WARN: record failed validation, not written: ${msg}\n`);
    return { ok: false, reason: 'validation', error: msg };
  }

  try {
    const line = JSON.stringify(validated) + '\n';
    mkdirSync(path.dirname(filePath), { recursive: true });
    appendFileSync(filePath, line, 'utf8');
    return { ok: true, record: validated, path: filePath };
  } catch (err) {
    const msg = err?.message ?? String(err);
    process.stderr.write(`[eval-sink] WARN: could not append to ${filePath}: ${msg}\n`);
    return { ok: false, reason: 'fs-error', error: msg };
  }
}

/**
 * Read all session-eval records from the eval journal. Never throws — a missing
 * file yields [] and malformed JSONL lines are skipped (readJsonlFile with
 * skipInvalid). Each record is passed through normalizeEvalRecord so callers get
 * a uniform shape (kpi nulls, judge-dim defaults, stamped versions).
 *
 * @param {string} [filePath] — absolute path to the eval journal.
 * @returns {object[]} normalized session-eval records, in source order.
 */
export function readEvalRecords(filePath = DEFAULT_EVAL_JSONL_PATH) {
  const rows = readJsonlFile(filePath, { skipInvalid: true });
  return rows.map((r) => normalizeEvalRecord(r));
}
