/**
 * memory-proposals/collector.mjs — Read-only aggregator for the memory-proposal queue.
 *
 * Reads proposals.jsonl + all per-wave summary JSONs at session-end and
 * aggregates them into a structured payload the coordinator uses to drive
 * AUQ rendering (Phase 3.6.3).
 *
 * Design principles (issue #501, PRD F2.1):
 *   - Read-only — never writes any file.
 *   - Never throws — fs/parse errors are translated to empty/zero results.
 *   - FIFO ordering — proposals are sorted by created_at ASC (no confidence re-sort).
 *   - Malformed JSONL lines are silently skipped (counted in stats.parse_errors).
 *   - Missing files → empty queue + all-zero stats (graceful degradation).
 *
 * No external deps — Node 20+ stdlib only.
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the path to proposals.jsonl within the repo's metrics directory.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
function proposalsJsonlPath(repoRoot) {
  return path.join(repoRoot, '.orchestrator', 'metrics', 'proposals.jsonl');
}

/**
 * Resolve the metrics directory where per-wave summary JSONs are stored.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
function metricsDir(repoRoot) {
  return path.join(repoRoot, '.orchestrator', 'metrics');
}

// ---------------------------------------------------------------------------
// Zero-value helpers
// ---------------------------------------------------------------------------

/**
 * Return a stats object with all counters set to zero.
 *
 * @returns {object}
 */
function zeroStats() {
  return {
    queued: 0,
    dropped: 0,
    below_floor: 0,
    fs_error: 0,
    parse_errors: 0,
  };
}

// ---------------------------------------------------------------------------
// JSONL reader (exported for unit testing / direct use)
// ---------------------------------------------------------------------------

/**
 * Read proposals.jsonl and return records sorted FIFO by created_at.
 *
 * Malformed lines are skipped silently (a debug-level log is emitted so
 * callers can observe them without failing). The caller receives an array
 * of plain parsed objects — no schema validation is applied here; that is
 * the store layer's responsibility.
 *
 * Uses `deserializeProposal` from schema.mjs when available; falls back to
 * raw `JSON.parse` so the module can operate independently during testing or
 * when I1 (schema.mjs) ships in the same wave.
 *
 * @param {object} args
 * @param {string} args.repoRoot  Absolute path to the repo root.
 * @returns {Promise<import('./schema.mjs').ProposalRecord[]>}
 */
export async function readProposalsJsonl({ repoRoot }) {
  const filePath = proposalsJsonlPath(repoRoot);
  if (!existsSync(filePath)) {
    return [];
  }

  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    console.error(`[memory-proposals/collector] WARN: could not read proposals.jsonl: ${err.message}`);
    return [];
  }

  // Attempt to load deserializeProposal from schema.mjs (may not exist yet).
  let deserialize = null;
  try {
    const schema = await import('./schema.mjs');
    if (typeof schema.deserializeProposal === 'function') {
      deserialize = schema.deserializeProposal;
    }
  } catch {
    // schema.mjs not yet available — fall back to raw JSON.parse.
  }

  const lines = raw.split('\n').filter((l) => l.length > 0);
  const records = [];

  for (const line of lines) {
    try {
      // deserializeProposal from schema.mjs expects the raw JSONL line (it
      // does JSON.parse internally). Passing a pre-parsed object trips its
      // `typeof line !== 'string'` guard and returns null for every record.
      // Fall back to raw JSON.parse only when schema.mjs is unavailable.
      const record = deserialize ? deserialize(line) : JSON.parse(line);
      if (record !== null && record !== undefined) {
        records.push(record);
      }
    } catch {
      // Malformed line — skip silently per spec.
      console.debug(`[memory-proposals/collector] DEBUG: skipped malformed JSONL line`);
    }
  }

  // FIFO: sort by created_at ascending (lexicographic ISO 8601 is safe for this).
  records.sort((a, b) => {
    const aTs = typeof a.created_at === 'string' ? a.created_at : '';
    const bTs = typeof b.created_at === 'string' ? b.created_at : '';
    if (aTs < bTs) return -1;
    if (aTs > bTs) return 1;
    return 0;
  });

  return records;
}

// ---------------------------------------------------------------------------
// Per-wave summary reader
// ---------------------------------------------------------------------------

/**
 * Read all `proposals-summary-*.json` files from the metrics directory.
 *
 * Returns a map of wave_id → parsed summary object. Files that cannot be
 * parsed are skipped (fs_error is counted separately in collectProposals).
 *
 * @param {string} repoRoot
 * @returns {Promise<Record<string, object>>}
 */
async function readPerWaveSummaries(repoRoot) {
  const dir = metricsDir(repoRoot);
  const summaries = {};

  if (!existsSync(dir)) {
    return summaries;
  }

  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    console.error(`[memory-proposals/collector] WARN: could not read metrics dir: ${err.message}`);
    return summaries;
  }

  const summaryFiles = names.filter(
    (n) => n.startsWith('proposals-summary-') && n.endsWith('.json')
  );

  for (const filename of summaryFiles) {
    const filePath = path.join(dir, filename);
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      // Derive the wave_id from the filename: proposals-summary-W1.json → W1
      const waveId = filename
        .replace(/^proposals-summary-/, '')
        .replace(/\.json$/, '');
      summaries[waveId] = parsed;
    } catch (err) {
      console.error(
        `[memory-proposals/collector] WARN: could not parse ${filename}: ${err.message}`
      );
      // Silently skip — the caller gets the fs_error count from collectProposals.
    }
  }

  return summaries;
}

// ---------------------------------------------------------------------------
// Stats accumulator
// ---------------------------------------------------------------------------

/**
 * Accumulate stats from all per-wave summary objects into a single stats record.
 *
 * Recognised summary fields (store.mjs convention):
 *   queued, dropped, below_floor, fs_error
 * (wrong-context rejections exit at CLI before reaching store; not tracked here per Q1 W4 finding.)
 *
 * Unknown fields in summaries are ignored.
 *
 * @param {Record<string, object>} summaries
 * @returns {object} accumulated stats (without parse_errors — caller fills that)
 */
function accumulateSummaryStats(summaries) {
  const stats = zeroStats();
  const KNOWN_FIELDS = ['queued', 'dropped', 'below_floor', 'fs_error'];

  for (const summary of Object.values(summaries)) {
    if (!summary || typeof summary !== 'object') continue;
    for (const field of KNOWN_FIELDS) {
      if (typeof summary[field] === 'number' && Number.isFinite(summary[field])) {
        stats[field] += summary[field];
      }
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Collect all memory proposals at session-end: read proposals.jsonl + all
 * per-wave summary JSONs, aggregate into a structured payload.
 *
 * @param {object} args
 * @param {string} args.repoRoot      Absolute path to the repo root.
 * @param {number|null} [args.minConfidence=null]
 *   Optional collect-emit confidence floor (issue #566). When a finite number
 *   is supplied, records with `record.confidence < minConfidence` are dropped
 *   from the returned `queue` BEFORE the function returns. When `null`,
 *   `undefined`, or non-numeric, no filtering is applied (back-compat).
 *
 *   This is a SECOND gate above the write-time
 *   `memory.proposals.confidence-floor` enforced by
 *   `scripts/memory-propose.mjs` — the per-record write-floor runs first,
 *   then the collect-emit floor here filters what surfaces to the operator's
 *   AUQ at session-end Phase 3.6.3. `stats` reflect the full intake (not
 *   post-filter) because they are accumulated from the per-wave summaries,
 *   not from the returned queue.
 * @returns {Promise<{
 *   queue: object[],
 *   stats: {
 *     queued: number,
 *     dropped: number,
 *     below_floor: number,
 *     fs_error: number,
 *     parse_errors: number,
 *   },
 *   perWaveSummaries: Record<string, object>,
 * }>}
 */
export async function collectProposals({ repoRoot, minConfidence = null }) {
  // Short-circuit: if proposals.jsonl doesn't exist, nothing was ever queued.
  const jsonlPath = proposalsJsonlPath(repoRoot);
  if (!existsSync(jsonlPath)) {
    return {
      queue: [],
      stats: zeroStats(),
      perWaveSummaries: {},
    };
  }

  // Run JSONL read and per-wave summary read concurrently.
  const [queueResult, perWaveSummaries] = await Promise.allSettled([
    readProposalsJsonl({ repoRoot }),
    readPerWaveSummaries(repoRoot),
  ]);

  // Extract results, treating rejections as empty/no-op (should not happen
  // since both functions catch internally, but guard defensively).
  let queue = queueResult.status === 'fulfilled' ? queueResult.value : [];
  const summaries =
    perWaveSummaries.status === 'fulfilled' ? perWaveSummaries.value : {};

  if (queueResult.status === 'rejected') {
    console.error(
      `[memory-proposals/collector] WARN: readProposalsJsonl rejected unexpectedly: ${queueResult.reason}`
    );
  }
  if (perWaveSummaries.status === 'rejected') {
    console.error(
      `[memory-proposals/collector] WARN: readPerWaveSummaries rejected unexpectedly: ${perWaveSummaries.reason}`
    );
  }

  // Accumulate stats from per-wave summaries.
  const stats = accumulateSummaryStats(summaries);

  // Count parse_errors: lines in the JSONL that were NOT successfully parsed.
  // We approximate this by reading the raw line count vs the queue length.
  // This requires a second read-pass on the raw file — use the already-read
  // content by re-counting; since readProposalsJsonl does the heavy lifting,
  // we derive parse_errors from the difference between raw non-empty lines
  // and successfully parsed records.
  let parseErrors = 0;
  try {
    const raw = await readFile(jsonlPath, 'utf8');
    const rawLineCount = raw.split('\n').filter((l) => l.length > 0).length;
    parseErrors = Math.max(0, rawLineCount - queue.length);
  } catch {
    // File became unreadable between the two reads — treat as 0 parse errors.
  }
  stats.parse_errors = parseErrors;

  // Collect-emit confidence filter (issue #566). Applies AFTER parse_errors
  // is computed against the raw-line count, so parse_errors stays anchored to
  // what the file actually contains. The filter only affects what the
  // coordinator surfaces to the operator AUQ; stats reflect the full intake.
  if (typeof minConfidence === 'number' && Number.isFinite(minConfidence)) {
    queue = queue.filter((record) => {
      const c = record && typeof record.confidence === 'number' ? record.confidence : null;
      // Records with no confidence field (or NaN) are kept — the gate only
      // drops records that actively report a confidence below the floor.
      if (c === null || !Number.isFinite(c)) return true;
      return c >= minConfidence;
    });
  }

  return {
    queue,
    stats,
    perWaveSummaries: summaries,
  };
}
