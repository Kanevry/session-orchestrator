/**
 * idempotency.mjs — Record-store I/O + supersession + idempotency for the
 * #647 C2 auto-repair engine.
 *
 * This module OWNS all disk access for repair candidates. The sibling
 * `candidate-intake.mjs` is a PURE transform (no I/O) that mints
 * `RepairCandidate` records; this module is the only one that reads from and
 * writes to the candidate store.
 *
 * Store: `.orchestrator/runtime/repair-candidates.jsonl` — a mutable work-queue
 * in JSON-Lines format (one record per line). The store is ALWAYS rewritten in
 * full via tmp-file + atomic rename. It is NEVER appended to with `>>` semantics,
 * because supersession reconciliation must mutate existing lines (set
 * `superseded_by`) — an append would leave stale duplicates and corrupt the
 * supersession graph.
 *
 * Three responsibilities:
 *   1. Persistence — `loadCandidates` (read) + atomic full rewrite (internal).
 *   2. Supersession — when a new candidate shares `(source, target_path)` with an
 *      existing LIVE candidate but carries a DIFFERENT id (the proposed change
 *      moved on), the older one is stamped `superseded_by = <new id>`.
 *   3. Idempotency — the `processed_at` stamp (the "G2 stamp") makes a candidate
 *      terminal: once processed it is never re-emitted or mutated, and a repeat
 *      merge of the same id is skipped.
 *
 * The idempotency KEY is `id` (a deterministic hash of source + target_path +
 * fingerprint produced by candidate-intake.mjs — the same logical candidate
 * always yields the same id).
 *
 * I/O contract: this module NEVER throws on I/O. Reads return safe defaults
 * (`[]`); writes return a structured result and swallow filesystem errors into
 * `{ ok: false, reason }` where the API exposes a status.
 *
 * Part of Epic #643 → issue #647 (C2 auto-repair engine).
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * @typedef {import('./candidate-intake.mjs').RepairCandidate} RepairCandidate
 */

/** Default repo-relative location of the candidate work-queue. */
export const DEFAULT_STORE_PATH = '.orchestrator/runtime/repair-candidates.jsonl';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the store path against repoRoot when it is relative. An absolute
 * storePath is honoured as-is. Falls back to {@link DEFAULT_STORE_PATH}.
 * @param {string|undefined} repoRoot
 * @param {string|undefined} storePath
 * @returns {string} absolute (or cwd-relative) path to the store
 */
function resolveStorePath(repoRoot, storePath) {
  const rel = typeof storePath === 'string' && storePath.length > 0 ? storePath : DEFAULT_STORE_PATH;
  if (isAbsolute(rel)) return rel;
  if (typeof repoRoot === 'string' && repoRoot.length > 0) return join(repoRoot, rel);
  return rel;
}

/**
 * Read + defensively parse the store's JSONL lines into RepairCandidate records.
 * Malformed lines (bad JSON, non-object) are skipped silently. A missing file
 * yields `[]`. Never throws.
 * @param {string} absPath
 * @returns {RepairCandidate[]}
 */
function readStore(absPath) {
  let raw;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch {
    // ENOENT or any read error → empty store.
    return [];
  }

  /** @type {RepairCandidate[]} */
  const records = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // skip malformed line
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      records.push(/** @type {RepairCandidate} */ (parsed));
    }
  }
  return records;
}

/**
 * Atomically rewrite the entire store from an in-memory record array. Creates
 * the parent dir with mkdir -p semantics, writes a tmp file, then renames over
 * the target (same-filesystem rename is atomic on POSIX). Never appends.
 * Never throws — filesystem errors are returned as `{ ok: false, ... }`.
 * @param {string} absPath
 * @param {RepairCandidate[]} records
 * @returns {{ ok: true, lines: number } | { ok: false, reason: 'fs-error', error: string }}
 */
function writeStore(absPath, records) {
  try {
    const dir = dirname(absPath);
    mkdirSync(dir, { recursive: true });
    const body = records.map((r) => JSON.stringify(r)).join('\n');
    const content = records.length > 0 ? body + '\n' : '';
    const tmpFile = join(dir, `.repair-candidates.${randomBytes(6).toString('hex')}.tmp`);
    writeFileSync(tmpFile, content, { encoding: 'utf8' });
    renameSync(tmpFile, absPath);
    return { ok: true, lines: records.length };
  } catch (err) {
    return { ok: false, reason: 'fs-error', error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load every RepairCandidate currently persisted in the store. Reads JSONL,
 * skips malformed lines, returns `[]` for a missing file. Does NOT create the
 * runtime dir (mkdir -p happens only on write). Never throws.
 * @param {Object} params
 * @param {string} [params.repoRoot] - repo root; relative `storePath` is resolved against it.
 * @param {string} [params.storePath] - store path (relative ⇒ joined to repoRoot). Defaults to {@link DEFAULT_STORE_PATH}.
 * @returns {RepairCandidate[]}
 */
export function loadCandidates({ repoRoot, storePath } = {}) {
  const absPath = resolveStorePath(repoRoot, storePath);
  return readStore(absPath);
}

/**
 * Merge new candidates into the store, reconciling supersession and skipping
 * already-processed ids, then atomically rewrite the full store.
 *
 * Per new candidate, against the existing store:
 *   - SAME `id` AND existing `processed_at !== null` → SKIP (idempotent;
 *     `skipped_processed++`). A processed candidate is terminal — never
 *     re-emitted or mutated.
 *   - SAME `id` AND existing is live (`processed_at === null`) → no-op update
 *     (already present; not counted as written).
 *   - DIFFERENT `id` but an existing LIVE candidate shares `(source,
 *     target_path)` → stamp the older one `superseded_by = <new id>`
 *     (`superseded++`) and add the new candidate (`written++`).
 *   - otherwise → add the new candidate (`written++`).
 *
 * The store is rewritten in full (read-all → merge → atomic tmp+rename), never
 * appended. Never throws; a write failure still returns counts with
 * `total` reflecting the in-memory final line count.
 * @param {Object} params
 * @param {RepairCandidate[]} params.candidates - newly minted candidates to merge.
 * @param {string} [params.repoRoot]
 * @param {string} [params.storePath]
 * @returns {{ written: number, superseded: number, skipped_processed: number, total: number }}
 */
export function mergeCandidates({ candidates, repoRoot, storePath } = {}) {
  const absPath = resolveStorePath(repoRoot, storePath);
  const store = readStore(absPath);

  // Index existing records by id for O(1) lookup.
  /** @type {Map<string, RepairCandidate>} */
  const byId = new Map();
  for (const rec of store) {
    if (rec && typeof rec.id === 'string') byId.set(rec.id, rec);
  }

  let written = 0;
  let superseded = 0;
  let skippedProcessed = 0;

  const incoming = Array.isArray(candidates) ? candidates : [];
  for (const cand of incoming) {
    if (!cand || typeof cand !== 'object' || typeof cand.id !== 'string') continue;

    const existing = byId.get(cand.id);
    if (existing) {
      if (existing.processed_at !== null && existing.processed_at !== undefined) {
        // Terminal: already processed. Idempotent skip.
        skippedProcessed += 1;
      }
      // Live duplicate of same id → no-op update (already present).
      continue;
    }

    // New id. Look for a LIVE same-(source, target_path) candidate to supersede.
    for (const rec of store) {
      const recLive = rec.processed_at === null || rec.processed_at === undefined;
      const recNotAlreadySuperseded = rec.superseded_by === null || rec.superseded_by === undefined;
      if (
        recLive &&
        recNotAlreadySuperseded &&
        rec.id !== cand.id &&
        rec.source === cand.source &&
        rec.target_path === cand.target_path
      ) {
        rec.superseded_by = cand.id;
        superseded += 1;
      }
    }

    store.push(cand);
    byId.set(cand.id, cand);
    written += 1;
  }

  writeStore(absPath, store);

  return {
    written,
    superseded,
    skipped_processed: skippedProcessed,
    total: store.length,
  };
}

/**
 * Stamp a candidate as processed (the "G2 stamp"). Sets `processed_at` then
 * atomically rewrites the store. Called by the engine ONLY after a successful
 * autonomous apply.
 *   - id not found → `{ ok: false, reason: 'not-found' }`
 *   - already processed → `{ ok: true }` (idempotent no-op; store untouched)
 *   - filesystem write failure → `{ ok: false, reason: 'fs-error' }`
 * Never throws.
 * @param {Object} params
 * @param {string} params.id - candidate id to stamp.
 * @param {string} [params.repoRoot]
 * @param {string} [params.storePath]
 * @param {string} [params.now] - ISO timestamp for `processed_at` (test determinism). Defaults to `new Date().toISOString()`.
 * @returns {{ ok: boolean, reason?: string }}
 */
export function markProcessed({ id, repoRoot, storePath, now } = {}) {
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, reason: 'not-found' };
  }

  const absPath = resolveStorePath(repoRoot, storePath);
  const store = readStore(absPath);

  const target = store.find((rec) => rec && rec.id === id);
  if (!target) return { ok: false, reason: 'not-found' };

  if (target.processed_at !== null && target.processed_at !== undefined) {
    // Already processed — idempotent no-op, leave the store untouched.
    return { ok: true };
  }

  target.processed_at = typeof now === 'string' && now.length > 0 ? now : new Date().toISOString();

  const result = writeStore(absPath, store);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true };
}

/**
 * True iff a candidate with the given id exists in the store AND has been
 * processed (`processed_at !== null`). Never throws.
 * @param {Object} params
 * @param {string} params.id
 * @param {string} [params.repoRoot]
 * @param {string} [params.storePath]
 * @returns {boolean}
 */
export function isProcessed({ id, repoRoot, storePath } = {}) {
  if (typeof id !== 'string' || id.length === 0) return false;
  const absPath = resolveStorePath(repoRoot, storePath);
  const store = readStore(absPath);
  const rec = store.find((r) => r && r.id === id);
  return !!rec && rec.processed_at !== null && rec.processed_at !== undefined;
}
