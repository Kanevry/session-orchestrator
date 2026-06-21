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
 * work-queue in JSON-Lines format (one ReconcileCandidate per line).
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
 * Read + defensively parse the store's JSONL lines into ReconcileCandidate
 * records. Malformed lines (bad JSON, non-object) are skipped silently. A
 * missing file yields `[]`. Never throws.
 * @param {string} absPath
 * @returns {ReconcileCandidate[]}
 */
function readStore(absPath) {
  let raw;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch {
    // ENOENT or any read error → empty store.
    return [];
  }

  /** @type {ReconcileCandidate[]} */
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
      records.push(/** @type {ReconcileCandidate} */ (parsed));
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
 * Load every ReconcileCandidate currently persisted in the store. Reads JSONL,
 * skips malformed lines, returns `[]` for a missing file. Does NOT create the
 * runtime dir (mkdir -p happens only on write). Never throws.
 * @param {Object} [params]
 * @param {string} [params.repoRoot] - repo root; relative `storePath` is resolved against it (defaults to `process.cwd()`).
 * @param {string} [params.storePath] - store path (relative ⇒ joined to repoRoot). Defaults to {@link DEFAULT_STORE_PATH}.
 * @returns {ReconcileCandidate[]}
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
 * failure returns `{ merged, written: false }`.
 * @param {Object} [params]
 * @param {ReconcileCandidate[]} [params.candidates] - newly minted candidates to merge.
 * @param {string} [params.repoRoot]
 * @param {string} [params.storePath]
 * @returns {{ merged: ReconcileCandidate[], written: boolean }}
 */
export function mergeCandidates({ candidates, repoRoot, storePath } = {}) {
  const absPath = resolveStorePath(repoRoot, storePath);
  const store = readStore(absPath);

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
  return { merged, written: result.ok === true };
}
