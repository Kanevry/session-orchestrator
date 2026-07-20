/**
 * telemetry/queue.mjs — host-local bounded NDJSON offline queue for anonymous
 * usage telemetry (Epic #841, Issue #844 FA3).
 *
 * Persists telemetry batches to a single NDJSON file at
 * `~/.config/session-orchestrator/telemetry-queue.ndjson` (one JSON object per
 * line: `{ queued_at, batch }`) so that a batch collected while the sender is
 * offline (network down, endpoint unreachable) is not lost — it waits in the
 * queue until the next successful `drain()`.
 *
 * The queue is BOUNDED on two independent axes — batch count (`MAX_BATCHES`)
 * and serialized byte size (`MAX_QUEUE_BYTES`) — dropping the OLDEST entries
 * first (FIFO) whenever either cap is exceeded. This prevents an unbounded
 * queue from growing across an extended offline period.
 *
 * Every public function accepts a `{ path }` override (defaulting to
 * `TELEMETRY_QUEUE_PATH`) for test injection, and NEVER throws — filesystem
 * or serialization failures are swallowed and reported via the function's
 * own result shape, mirroring the `scripts/lib/eval/sink.mjs` /
 * `scripts/lib/events-rotation.mjs` "never throw a caller can't route around"
 * convention used elsewhere in this repo.
 *
 * This storage layer imports ONLY the constants-only leaf module ./paths.mjs
 * (for TELEMETRY_QUEUE_PATH) and the generic ../io.mjs helpers — never a policy
 * sibling (consent.mjs) or the schema. Keeping the queue off the consent policy
 * preserves the correct dependency direction: the generic offline queue must not
 * hang off the telemetry consent layer.
 */

import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readJsonlFile } from '../io.mjs';
import { TELEMETRY_QUEUE_PATH } from './paths.mjs';

/** Host-local NDJSON offline queue path — single-sourced from ./paths.mjs (a constants-only leaf module; two independently computed copies can silently drift). */
export { TELEMETRY_QUEUE_PATH };

/** Maximum number of queued batch entries before oldest-first eviction kicks in. */
export const MAX_BATCHES = 50;

/** Maximum serialized queue size in bytes before oldest-first eviction kicks in. */
export const MAX_QUEUE_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read all queue entries from disk. Never throws: a missing file yields `[]`
 * and any corrupted/malformed line is silently skipped (readJsonlFile with
 * `skipInvalid: true`) — a corrupted line is dropped for good the next time
 * the queue is rewritten (enqueue/drain/dropOldest/clear all rewrite in full).
 *
 * @param {string} filePath
 * @returns {Array<{queued_at: string, batch: object}>}
 */
function _readEntries(filePath) {
  try {
    return readJsonlFile(filePath, { skipInvalid: true });
  } catch {
    return [];
  }
}

/**
 * Serialize entries as NDJSON text (one JSON object per line, trailing
 * newline when non-empty; empty string when entries is empty).
 *
 * @param {Array<object>} entries
 * @returns {string}
 */
function _toNdjson(entries) {
  if (entries.length === 0) return '';
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

/**
 * Byte length of the entries once serialized as NDJSON — used to enforce
 * `MAX_QUEUE_BYTES`.
 *
 * @param {Array<object>} entries
 * @returns {number}
 */
function _serializedByteLength(entries) {
  return Buffer.byteLength(_toNdjson(entries), 'utf8');
}

/**
 * Atomically replace `filePath` with the NDJSON serialization of `entries`
 * via tmp-file + `renameSync` in the SAME directory (same-filesystem rename
 * is atomic on POSIX — mirrors `writeJsonAtomicSync` in `scripts/lib/io.mjs`,
 * which has no NDJSON-array variant). Creates the parent directory with
 * `mkdirSync(dir, { recursive: true })` first.
 *
 * @param {string} filePath
 * @param {Array<object>} entries
 * @throws {Error} on filesystem failure — callers MUST catch (this helper is
 *         intentionally throw-on-failure; the never-throws contract lives at
 *         the public-API layer).
 */
function _writeEntriesAtomicSync(filePath, entries) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpSuffix = randomBytes(6).toString('hex');
  const tmpFile = join(dir, `.tmp.${tmpSuffix}`);
  writeFileSync(tmpFile, _toNdjson(entries), 'utf8');
  renameSync(tmpFile, filePath);
}

/**
 * Evict oldest entries (FIFO) until both the batch-count cap and the
 * serialized-byte cap are satisfied.
 *
 * @param {Array<object>} entries
 * @param {number} maxBatches
 * @param {number} maxBytes
 * @returns {{entries: Array<object>, dropped: number}}
 */
function _enforceCaps(entries, maxBatches, maxBytes) {
  let out = entries;
  let dropped = 0;

  while (out.length > maxBatches) {
    out = out.slice(1);
    dropped++;
  }
  while (out.length > 0 && _serializedByteLength(out) > maxBytes) {
    out = out.slice(1);
    dropped++;
  }

  return { entries: out, dropped };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a telemetry batch to the offline queue, then evict the oldest
 * entries (FIFO) until both `maxBatches` and `maxBytes` caps are satisfied.
 * Rewrites the queue file atomically. Never throws.
 *
 * @param {object} batch — arbitrary JSON-serializable telemetry batch payload.
 * @param {object} [opts]
 * @param {string} [opts.path] — queue file path override (defaults to `TELEMETRY_QUEUE_PATH`).
 * @param {string} [opts.now] — ISO8601 timestamp stamped as `queued_at` (defaults to `new Date().toISOString()`).
 * @param {number} [opts.maxBatches] — batch-count cap (defaults to `MAX_BATCHES`).
 * @param {number} [opts.maxBytes] — serialized-byte cap (defaults to `MAX_QUEUE_BYTES`).
 * @returns {{ok: true, dropped: number, total: number} | {ok: false, dropped: 0, total: 0, error: string}}
 */
export function enqueue(batch, opts = {}) {
  const {
    path: filePath = TELEMETRY_QUEUE_PATH,
    now = new Date().toISOString(),
    maxBatches = MAX_BATCHES,
    maxBytes = MAX_QUEUE_BYTES,
  } = opts;

  try {
    const existing = _readEntries(filePath);
    const entry = { queued_at: now, batch };
    const combined = [...existing, entry];

    const { entries, dropped } = _enforceCaps(combined, maxBatches, maxBytes);

    _writeEntriesAtomicSync(filePath, entries);
    return { ok: true, dropped, total: entries.length };
  } catch (err) {
    return { ok: false, dropped: 0, total: 0, error: err?.message ?? String(err) };
  }
}

/**
 * Drain the queue by handing all queued batches to `sender` as a single call.
 * On success (sender's returned promise resolves), the queue is atomically
 * emptied. On failure (sender's promise rejects or throws synchronously), the
 * queue is left byte-identical to before the call. When `sender` is omitted,
 * this is a no-op. Never throws.
 *
 * @param {object} [opts]
 * @param {string} [opts.path] — queue file path override (defaults to `TELEMETRY_QUEUE_PATH`).
 * @param {(batches: object[]) => Promise<void>} [opts.sender] — async callback invoked with all queued batch payloads.
 * @returns {Promise<{sent: number, remaining: number, dropped: number}>}
 */
export async function drain(opts = {}) {
  const { path: filePath = TELEMETRY_QUEUE_PATH, sender } = opts;

  const entries = _readEntries(filePath);

  if (typeof sender !== 'function') {
    return { sent: 0, remaining: entries.length, dropped: 0 };
  }

  try {
    await sender(entries.map((entry) => entry.batch));
  } catch {
    return { sent: 0, remaining: entries.length, dropped: 0 };
  }

  try {
    _writeEntriesAtomicSync(filePath, []);
    return { sent: entries.length, remaining: 0, dropped: 0 };
  } catch {
    // Sender succeeded but the queue could not be cleared — report the
    // batches as unsent-safe (still on disk) rather than losing them.
    return { sent: 0, remaining: entries.length, dropped: 0 };
  }
}

/**
 * Read all queue entries without mutating the queue. Never throws.
 *
 * @param {object} [opts]
 * @param {string} [opts.path] — queue file path override (defaults to `TELEMETRY_QUEUE_PATH`).
 * @returns {Array<{queued_at: string, batch: object}>} — `[]` when the queue file does not exist.
 */
export function peekAll(opts = {}) {
  const { path: filePath = TELEMETRY_QUEUE_PATH } = opts;
  return _readEntries(filePath);
}

/**
 * Drop the `n` oldest entries (FIFO) from the queue and atomically rewrite
 * it. Never throws.
 *
 * @param {number} n — number of oldest entries to drop (clamped to `[0, queue length]`).
 * @param {object} [opts]
 * @param {string} [opts.path] — queue file path override (defaults to `TELEMETRY_QUEUE_PATH`).
 * @returns {{dropped: number, remaining: number}}
 */
export function dropOldest(n, opts = {}) {
  const { path: filePath = TELEMETRY_QUEUE_PATH } = opts;

  try {
    const entries = _readEntries(filePath);
    const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    const dropCount = Math.min(count, entries.length);
    const remaining = entries.slice(dropCount);

    _writeEntriesAtomicSync(filePath, remaining);
    return { dropped: dropCount, remaining: remaining.length };
  } catch {
    return { dropped: 0, remaining: 0 };
  }
}

/**
 * Empty the queue (atomic truncate to zero entries). Never throws.
 *
 * @param {object} [opts]
 * @param {string} [opts.path] — queue file path override (defaults to `TELEMETRY_QUEUE_PATH`).
 * @returns {{ok: boolean}}
 */
export function clear(opts = {}) {
  const { path: filePath = TELEMETRY_QUEUE_PATH } = opts;
  try {
    _writeEntriesAtomicSync(filePath, []);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Report current queue occupancy. Never throws.
 *
 * @param {object} [opts]
 * @param {string} [opts.path] — queue file path override (defaults to `TELEMETRY_QUEUE_PATH`).
 * @returns {{count: number, bytes: number}} — `bytes` is the on-disk file size (`0` when the file does not exist).
 */
export function queueStats(opts = {}) {
  const { path: filePath = TELEMETRY_QUEUE_PATH } = opts;
  try {
    const entries = _readEntries(filePath);
    const bytes = existsSync(filePath) ? statSync(filePath).size : 0;
    return { count: entries.length, bytes };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

// Exported for atomicity-smoke tests that want to confirm no stray tmp file
// is left behind after a write (avoids re-deriving the tmp-name pattern
// baked into `_writeEntriesAtomicSync` above).
export const _TMP_FILE_PATTERN = /^\.tmp\./;
