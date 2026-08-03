/**
 * idempotency.mjs — Record-store I/O + logical dedupe + idempotency for the
 * #695 FA2 Reconciliation Engine (Epic #693).
 *
 * This module OWNS all disk access for reconcile candidates. It is the
 * reconcile-side sibling of `scripts/lib/skill-evolution/idempotency.mjs`
 * (the C2 repair-candidates store) and mirrors its defensive posture: the
 * store is ALWAYS rewritten in full via tmp-file + atomic rename and is NEVER
 * appended to, because dedupe-by-`learning_key` must mutate/replace existing
 * lines — an append would leave stale duplicates.
 *
 * Store: `.orchestrator/runtime/reconcile-candidates.jsonl` — a mutable
 * work-queue in JSON-Lines format (one ReconcileCandidate per line). The store
 * is OWNED by `mergeCandidates`: it is the only sanctioned writer. Nothing else
 * — no report, no analysis run, no agent — may append to it; a read-side shape
 * guard drops any record that is not a ReconcileCandidate and COUNTS the drop.
 * The count reaches readers through the ONE reader ({@link loadCandidates}
 * returns `{records, skipped}`) and writers through `mergeCandidates`'s
 * `skipped` — there is deliberately no lossy array-only variant beside them.
 *
 * Two responsibilities differ from the repair store:
 *   1. The IDEMPOTENCY KEY is the LOGICAL `learning_key` (issue #695), not the
 *      physical hashed `id`. Two candidates with the same `learning_key`
 *      describe the same reconciliation; the latest one replaces the older —
 *      UNLESS the older is already processed (`processed_at !== null`), in
 *      which case the processed verdict wins and is never regressed.
 *   2. `makeCandidateId` mints the deterministic physical id from
 *      `(learning_key, slug)` for stable referencing.
 *
 * I/O contract: this module NEVER throws on I/O. Reads return safe defaults
 * (`[]`); the write helper swallows filesystem errors and `mergeCandidates`
 * reports `written: false` on a write failure.
 *
 * Part of Epic #693 → issue #695 (FA2 Reconciliation Engine).
 *
 * @typedef {Object} ReconcileCandidate
 * @property {string} id              - deterministic `rc-<sha256(learning_key + '\0' + slug)[:8]>`.
 * @property {number} schema_version  - schema version (1).
 * @property {string} learning_key    - THE logical dedupe key.
 * @property {string} slug            - the `.claude/rules/<slug>.md` slug.
 * @property {'proposed'|'rejected'} status
 * @property {string} reason
 * @property {number} confidence
 * @property {string} created_at      - ISO timestamp.
 * @property {string|null} processed_at  - terminal stamp (mirrors repair store).
 * @property {string|null} superseded_by
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

/** Default repo-relative location of the reconcile-candidate work-queue. */
export const DEFAULT_STORE_PATH = '.orchestrator/runtime/reconcile-candidates.jsonl';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the store path against repoRoot when it is relative. An absolute
 * storePath is honoured as-is. Falls back to {@link DEFAULT_STORE_PATH}, and
 * to `process.cwd()` when no repoRoot is supplied.
 * @param {string|undefined} repoRoot
 * @param {string|undefined} storePath
 * @returns {string}
 */
function resolveStorePath(repoRoot, storePath) {
  const rel = typeof storePath === 'string' && storePath.length > 0 ? storePath : DEFAULT_STORE_PATH;
  if (isAbsolute(rel)) return rel;
  const root = typeof repoRoot === 'string' && repoRoot.length > 0 ? repoRoot : process.cwd();
  return join(root, rel);
}

/**
 * Minimal shape guard for a persisted store line. A record is accepted only
 * when it carries the two fields every consumer of this store depends on:
 *   - `learning_key` — THE logical dedupe key (`mergeCandidates`, `isProcessed`).
 *   - `created_at`   — the recency axis (`reconcile-nudge-banner.mjs` `_lastRunAt`).
 *
 * This is deliberately NOT a full schema check: the store is a mutable
 * work-queue whose records may gain fields across schema versions, so
 * over-strict validation would silently drop legitimate future records. It
 * rejects only records that no writer in this repo produces — the concrete
 * incident being a hand-written report artefact using `candidate_id` /
 * `generated_at` / `status:"candidate"` (2026-07-31, see
 * `docs/reconcile/2026-07-31-reconcile-candidates.md`).
 * @param {unknown} rec
 * @returns {boolean}
 */
function isCandidateShape(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return false;
  const r = /** @type {Record<string, unknown>} */ (rec);
  if (typeof r.learning_key !== 'string' || r.learning_key.length === 0) return false;
  if (typeof r.created_at !== 'string') return false;
  return true;
}

/**
 * Read + defensively parse the store's JSONL lines into ReconcileCandidate
 * records. Malformed lines (bad JSON, non-object) and shape-foreign records
 * (see {@link isCandidateShape}) are skipped — the latter are COUNTED, because
 * the store is a mutable work-queue that `mergeCandidates` rewrites in full, so
 * a skipped line is dropped from disk on the next merge and a silent drop would
 * be unattributable data loss. A missing file yields `{ records: [], skipped: 0 }`.
 * Never throws.
 * @param {string} absPath
 * @returns {{ records: ReconcileCandidate[], skipped: number }}
 */
function readStore(absPath) {
  let raw;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch {
    // ENOENT or any read error → empty store.
    return { records: [], skipped: 0 };
  }

  /** @type {ReconcileCandidate[]} */
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
    if (isCandidateShape(parsed)) {
      records.push(/** @type {ReconcileCandidate} */ (parsed));
    } else {
      skipped += 1;
    }
  }
  return { records, skipped };
}

/**
 * Atomically rewrite the entire store from an in-memory record array. Creates
 * the parent dir with mkdir -p semantics, writes a tmp file, then renames over
 * the target (same-filesystem rename is atomic on POSIX). Never appends.
 * Never throws — filesystem errors are returned as `{ ok: false, ... }`.
 * @param {string} absPath
 * @param {ReconcileCandidate[]} records
 * @returns {{ ok: true, lines: number } | { ok: false, reason: 'fs-error', error: string }}
 */
function writeStore(absPath, records) {
  try {
    const dir = dirname(absPath);
    mkdirSync(dir, { recursive: true });
    const body = records.map((r) => JSON.stringify(r)).join('\n');
    const content = records.length > 0 ? body + '\n' : '';
    const tmpFile = join(dir, `.reconcile-candidates.${randomBytes(6).toString('hex')}.tmp`);
    writeFileSync(tmpFile, content, { encoding: 'utf8' });
    renameSync(tmpFile, absPath);
    return { ok: true, lines: records.length };
  } catch (err) {
    return { ok: false, reason: 'fs-error', error: err?.message ?? String(err) };
  }
}

/**
 * True iff a candidate has a terminal `processed_at` stamp.
 * @param {ReconcileCandidate|undefined|null} cand
 * @returns {boolean}
 */
function isTerminal(cand) {
  return !!cand && cand.processed_at !== null && cand.processed_at !== undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Mint the deterministic physical id for a reconcile candidate. The same
 * `(learningKey, slug)` pair always yields the same id, so it is a stable
 * reference key. A NUL separator avoids cross-field collisions
 * (e.g. `('ab','c')` vs `('a','bc')`). Never throws — coerces inputs to string.
 * @param {string} learningKey
 * @param {string} slug
 * @returns {string} `rc-<sha256(learningKey + '\0' + slug)[:8]>`
 */
export function makeCandidateId(learningKey, slug) {
  const key = typeof learningKey === 'string' ? learningKey : String(learningKey ?? '');
  const s = typeof slug === 'string' ? slug : String(slug ?? '');
  return 'rc-' + createHash('sha256').update(key + '\0' + s).digest('hex').slice(0, 8);
}

/**
 * Build a ReconcileCandidate line-record for a proposed or rejected learning.
 *
 * Lives here — beside the {@link ReconcileCandidate} typedef it instantiates and
 * the read-side `isCandidateShape` guard that judges it — so ONE file decides
 * which fields a persisted record carries. It deliberately does NOT mint the
 * `id` (see {@link makeCandidateId}): rejections currently derive their id from
 * `(learningKey, 'rejected-<type>')` while storing `slug: ''`, so folding the
 * mint in here using the record's own slug would change every rejection
 * candidate's id and orphan every rejection row already on disk. Caller-supplied
 * `id` keeps that decision at the call site.
 *
 * `created_at` is caller-supplied (from the engine's injectable clock) so output
 * stays deterministic under test. `processed_at`/`superseded_by` always start
 * null — only the merge/approval path stamps them. Never throws.
 *
 * @param {Object} params
 * @param {string} params.id - deterministic physical id, see {@link makeCandidateId}.
 * @param {string|null} params.learningKey - logical dedupe key; a non-string coerces to `''`.
 * @param {string} params.slug - `.claude/rules/<slug>.md` slug (`''` for rejections).
 * @param {'proposed'|'rejected'} params.status
 * @param {string} params.reason
 * @param {number} params.confidence
 * @param {string} params.createdAt - ISO timestamp.
 * @returns {ReconcileCandidate}
 */
export function buildCandidate({ id, learningKey, slug, status, reason, confidence, createdAt }) {
  return {
    id,
    schema_version: 1,
    learning_key: typeof learningKey === 'string' ? learningKey : '',
    slug,
    status,
    reason,
    confidence,
    created_at: createdAt,
    processed_at: null,
    superseded_by: null,
  };
}

/**
 * Load the persisted store: every ReconcileCandidate that survives the read-side
 * shape guard, PLUS the count of lines it rejected. Reads JSONL, skips malformed
 * lines and shape-foreign records (missing `learning_key` / `created_at`),
 * yields `{ records: [], skipped: 0 }` for a missing file. Does NOT create the
 * runtime dir (mkdir -p happens only on write). Never throws.
 *
 * `skipped` is part of the return value rather than a second, "diagnostics"
 * reader beside this one, because `records.length === 0` is AMBIGUOUS on its
 * own: a missing store and a store whose every line is shape-foreign both yield
 * `[]`, and a consumer that sees only the array reports "no reconcile run on
 * record" for a store that in fact holds quarantined evidence of one (the
 * concrete defect in `scripts/lib/reconcile-nudge-banner.mjs`, GitLab #955
 * finding 2). Splitting the honest reader off under a longer name left the
 * OBVIOUS name as the lossy one — the next consumer would reach for
 * `loadCandidates`, get `[]`, and re-derive the same wrong conclusion. One
 * reader, one answer.
 *
 * Read-only: unlike {@link mergeCandidates} this does NOT rewrite the store, so
 * the skipped lines are still on disk after this call.
 * @param {Object} [params]
 * @param {string} [params.repoRoot] - repo root; relative `storePath` is resolved against it (defaults to `process.cwd()`).
 * @param {string} [params.storePath] - store path (relative ⇒ joined to repoRoot). Defaults to {@link DEFAULT_STORE_PATH}.
 * @returns {{ records: ReconcileCandidate[], skipped: number }}
 */
export function loadCandidates({ repoRoot, storePath } = {}) {
  const absPath = resolveStorePath(repoRoot, storePath);
  return readStore(absPath);
}

/**
 * True iff `existing` already holds a candidate that shares `candidate`'s
 * `learning_key` AND has a terminal `processed_at` stamp. The reconcile engine
 * uses this to idempotently SKIP re-proposing a learning whose verdict is
 * already terminal. Never throws.
 * @param {ReconcileCandidate} candidate - the candidate under consideration.
 * @param {ReconcileCandidate[]} existing - the currently-persisted candidates.
 * @returns {boolean}
 */
export function isProcessed(candidate, existing) {
  if (!candidate || typeof candidate !== 'object') return false;
  const key = candidate.learning_key;
  if (typeof key !== 'string' || key.length === 0) return false;
  const list = Array.isArray(existing) ? existing : [];
  return list.some((rec) => rec && rec.learning_key === key && isTerminal(rec));
}

/**
 * Merge new candidates into the store, deduping by `learning_key`, then
 * atomically rewrite the full store.
 *
 * Dedupe rule, per incoming candidate:
 *   - If an existing candidate shares the same `learning_key` AND is already
 *     processed (`processed_at !== null`) → KEEP existing (idempotent; do not
 *     regress a terminal verdict).
 *   - Else if an existing candidate shares the same `learning_key` → the NEW
 *     candidate REPLACES it (keep latest).
 *   - Else → add the new candidate.
 *
 * The runtime dir is created with mkdir -p semantics. The store is rewritten in
 * full (read-all → merge → atomic tmp+rename), never appended. Output lines are
 * sorted by `learning_key` for deterministic output. Never throws; on write
 * failure returns `written: false`.
 *
 * `skipped` reports how many persisted lines the read-side shape guard rejected
 * (malformed JSON, or a record missing `learning_key`/`created_at`). Because the
 * store is rewritten in full, those lines are DROPPED from disk by this call —
 * the count is what makes that loss attributable instead of silent.
 * @param {Object} [params]
 * @param {ReconcileCandidate[]} [params.candidates] - newly minted candidates to merge.
 * @param {string} [params.repoRoot]
 * @param {string} [params.storePath]
 * @returns {{ merged: ReconcileCandidate[], written: boolean, skipped: number }}
 */
export function mergeCandidates({ candidates, repoRoot, storePath } = {}) {
  const absPath = resolveStorePath(repoRoot, storePath);
  const { records: store, skipped } = readStore(absPath);

  // Index existing records by learning_key for O(1) lookup. Last write wins for
  // any pre-existing duplicates in the file (defensive — store should be unique).
  /** @type {Map<string, ReconcileCandidate>} */
  const byKey = new Map();
  for (const rec of store) {
    if (rec && typeof rec.learning_key === 'string') byKey.set(rec.learning_key, rec);
  }

  const incoming = Array.isArray(candidates) ? candidates : [];
  for (const cand of incoming) {
    if (!cand || typeof cand !== 'object' || typeof cand.learning_key !== 'string') continue;

    const existing = byKey.get(cand.learning_key);
    if (existing && isTerminal(existing)) {
      // Terminal verdict wins — do not regress a processed candidate.
      continue;
    }
    // New key, or live existing → the latest candidate replaces it.
    byKey.set(cand.learning_key, cand);
  }

  const merged = Array.from(byKey.values()).sort((a, b) =>
    String(a.learning_key).localeCompare(String(b.learning_key)),
  );

  const result = writeStore(absPath, merged);
  return { merged, written: result.ok === true, skipped };
}
