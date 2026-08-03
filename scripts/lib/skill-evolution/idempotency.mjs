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
 * supersession graph. The store is OWNED by this module: nothing else — no
 * report, no analysis run, no agent — may append to it; a read-side shape guard
 * ({@link isRepairCandidateShape}) drops any record that is not a
 * RepairCandidate, COUNTS the drop, and WARNs on stderr.
 *
 * The warning lives in {@link readStore} — the ONE seam every public function
 * reads through — rather than in each caller's return shape, because only
 * `mergeCandidates` has a result object with room for a count: `markProcessed`
 * returns `{ok, reason}` and `isProcessed` returns a boolean, yet both rewrite
 * or gate on a store whose foreign lines the rewrite DELETES. Those two run far
 * more often than a merge, so a count reported only by `mergeCandidates` would
 * leave the most-travelled deletion path silent.
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
 * Minimal shape guard for a persisted store line. A record is accepted only when
 * it carries the three fields THIS store's own consumers read:
 *   - `id`          — THE idempotency key (`mergeCandidates` byId index,
 *                     `markProcessed`, `isProcessed` all look records up by it).
 *   - `source`      — one half of the supersession key (`mergeCandidates`
 *                     compares `rec.source === cand.source`).
 *   - `target_path` — the other half of the supersession key.
 *
 * Deliberately NOT a full schema check, and NOT a copy of the reconcile store's
 * guard: the two record types share only 5 fields, and the reconcile guard keys
 * on `learning_key`, which a {@link RepairCandidate} does not have at all —
 * applying it here would reject 100% of legitimate repair candidates. The fields
 * above were chosen by what consumers actually READ, not by the typedef: a grep
 * of `scripts/lib/skill-evolution/` (2026-07-31) found ZERO consumer reads of
 * `created_at` — only the producer `candidate-intake.mjs` sets it — so requiring
 * it would be schema validation, not a load-bearing check. The store is a
 * mutable work-queue whose records may gain fields across schema versions, so
 * over-strict validation would silently drop legitimate future records.
 *
 * What it DOES reject is a record no writer in this repo produces — the concrete
 * incident class being a hand-written report artefact landing in the sibling
 * reconcile store using `candidate_id` / `generated_at` / `status:"candidate"`
 * (2026-07-31, GitLab #955; this store is the near-twin that kept the old
 * permissive `typeof parsed === 'object'` check).
 * @param {unknown} rec
 * @returns {boolean}
 */
function isRepairCandidateShape(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return false;
  const r = /** @type {Record<string, unknown>} */ (rec);
  if (typeof r.id !== 'string' || r.id.length === 0) return false;
  if (typeof r.source !== 'string' || r.source.length === 0) return false;
  if (typeof r.target_path !== 'string' || r.target_path.length === 0) return false;
  return true;
}

/**
 * Per-store memo of the skip count already WARNed about, keyed by resolved
 * absolute store path. Without it a caller that reads the same store in a loop
 * (the engine calls {@link isProcessed} once per candidate) would emit one
 * identical line per read. A read that comes back CLEAN clears the entry, so a
 * store contaminated again later warns again instead of being muted forever.
 * @type {Map<string, number>}
 */
const warnedSkips = new Map();

/**
 * Emit ONE stderr WARN per (store, skip-count) transition. Called from every
 * {@link readStore} exit — including the ENOENT path, whose `skipped: 0` clears
 * the memo. Never throws: a stderr write failure must not break a store read.
 * @param {string} absPath
 * @param {number} skipped
 * @returns {void}
 */
function warnOnSkipped(absPath, skipped) {
  if (skipped <= 0) {
    warnedSkips.delete(absPath);
    return;
  }
  if (warnedSkips.get(absPath) === skipped) return;
  warnedSkips.set(absPath, skipped);
  try {
    process.stderr.write(
      `WARN repair-candidate store: ${skipped} unreadable record(s) skipped in ${absPath} — ` +
        'not RepairCandidate shape (need id/source/target_path) or unparseable JSON. ' +
        'The next full rewrite (mergeCandidates/markProcessed) DELETES them from disk.\n',
    );
  } catch {
    // stderr unavailable (closed pipe) — the count is still returned to callers.
  }
}

/**
 * Read + defensively parse the store's JSONL lines into RepairCandidate records.
 * Malformed lines (bad JSON) and shape-foreign records (see
 * {@link isRepairCandidateShape}) are skipped — and COUNTED, because every
 * writer in this module rewrites the store in FULL, so a skipped line is dropped
 * from disk on the next merge or stamp; a silent drop would be unattributable
 * data loss. Every skip is ALSO reported on stderr via {@link warnOnSkipped},
 * which is what covers the three callers whose return contract has no room for
 * the count. A missing file yields `{ records: [], skipped: 0 }`. Never throws.
 * @param {string} absPath
 * @returns {{ records: RepairCandidate[], skipped: number }}
 */
function readStore(absPath) {
  let raw;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch {
    // ENOENT or any read error → empty store.
    warnOnSkipped(absPath, 0);
    return { records: [], skipped: 0 };
  }

  /** @type {RepairCandidate[]} */
  const records = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue; // skip malformed line
    }
    if (isRepairCandidateShape(parsed)) {
      records.push(/** @type {RepairCandidate} */ (parsed));
    } else {
      skipped += 1;
    }
  }
  warnOnSkipped(absPath, skipped);
  return { records, skipped };
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
 * skips malformed lines AND shape-foreign records (missing `id` / `source` /
 * `target_path`), returns `[]` for a missing file. Does NOT create the runtime
 * dir (mkdir -p happens only on write). Never throws.
 *
 * Read-only: the skipped lines are still on disk after this call. The count is
 * not in the return value — this function's plain-array contract is unchanged —
 * but it is never silent: {@link readStore} WARNs it on stderr, and a caller
 * that needs the number programmatically gets it from {@link mergeCandidates}
 * as `dropped_on_read`.
 * @param {Object} params
 * @param {string} [params.repoRoot] - repo root; relative `storePath` is resolved against it.
 * @param {string} [params.storePath] - store path (relative ⇒ joined to repoRoot). Defaults to {@link DEFAULT_STORE_PATH}.
 * @returns {RepairCandidate[]}
 */
export function loadCandidates({ repoRoot, storePath } = {}) {
  const absPath = resolveStorePath(repoRoot, storePath);
  return readStore(absPath).records;
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
 *
 * `dropped_on_read` reports how many PERSISTED lines the read-side guard
 * rejected (malformed JSON, or a record missing `id`/`source`/`target_path`).
 * Because the store is rewritten in full, those lines are DROPPED from disk by
 * this call — the count is what makes that loss attributable instead of silent.
 * It is deliberately NOT named `skipped`: `skipped_processed` above already
 * means "an INCOMING candidate was skipped because its id is already processed",
 * a different population (incoming, not persisted) with a different cause
 * (terminal verdict, not contamination). Confusing the two would read a
 * contaminated store as a healthy idempotent no-op.
 * @param {Object} params
 * @param {RepairCandidate[]} params.candidates - newly minted candidates to merge.
 * @param {string} [params.repoRoot]
 * @param {string} [params.storePath]
 * @returns {{ written: number, superseded: number, skipped_processed: number, dropped_on_read: number, total: number }}
 */
export function mergeCandidates({ candidates, repoRoot, storePath } = {}) {
  const absPath = resolveStorePath(repoRoot, storePath);
  const { records: store, skipped: droppedOnRead } = readStore(absPath);

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
    dropped_on_read: droppedOnRead,
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
 * Never throws. Like {@link mergeCandidates} this rewrites the store in full, so
 * shape-foreign lines are DELETED from disk here too. This API's result shape
 * has no room to report the count (it is `{ ok, reason }` by contract), so the
 * deletion is surfaced by {@link readStore}'s stderr WARN instead — this is the
 * most-travelled of the three rewrite paths, so it must not be the silent one.
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
  const { records: store } = readStore(absPath);

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
 * processed (`processed_at !== null`). Read-only — it does not itself rewrite
 * the store — but it reads through the same shape guard, so a contaminated
 * store is reported here too via {@link readStore}'s stderr WARN. Never throws.
 * @param {Object} params
 * @param {string} params.id
 * @param {string} [params.repoRoot]
 * @param {string} [params.storePath]
 * @returns {boolean}
 */
export function isProcessed({ id, repoRoot, storePath } = {}) {
  if (typeof id !== 'string' || id.length === 0) return false;
  const absPath = resolveStorePath(repoRoot, storePath);
  const { records: store } = readStore(absPath);
  const rec = store.find((r) => r && r.id === id);
  return !!rec && rec.processed_at !== null && rec.processed_at !== undefined;
}
