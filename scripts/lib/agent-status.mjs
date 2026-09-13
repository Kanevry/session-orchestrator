/**
 * agent-status.mjs — lean per-agent status push helper (issue #565).
 *
 * Wave-executor agents push lightweight progress/status telemetry that a later
 * tmux-layout / wave-executor integration renders in an operator side-channel.
 * Two files live under `.orchestrator/runtime/` (already gitignored):
 *
 *   - `agent-status.jsonl`         — append-only event log (one record per push).
 *   - `agent-status-current.json`  — last-write-wins (LWW) map keyed by agentId.
 *
 * ## Source-of-truth contract (#1342)
 *
 * **`agent-status.jsonl` is the SOURCE OF TRUTH of this status channel. The
 * current-map is a REBUILDABLE CACHE of it.** `pushRecord()` appends to the
 * ledger FIRST and only then takes `agent-status.lock` to update the map, so
 * every failure of the second half (lock timeout because a foreign-host lock is
 * held, process death between the two writes, map corruption) leaves a ledger
 * that is AHEAD of the cache. Before #1342 the map was read as if current in
 * exactly those cases and the operator saw `running` for an agent that had
 * already reported `completed`.
 *
 * Therefore:
 *   - `rebuildCurrentFromLedger()` folds a bounded TAIL of the ledger into the
 *     same map shape and is the authority whenever it is newer than the cache.
 *   - `readCurrentStatus()` returns PROVENANCE (`source`, `at`, `degraded`) so a
 *     consumer can never mistake a stale cache for live state. It NEVER invents
 *     a state: an agent visible only in a discarded partial line is `unknown`,
 *     not `running`.
 *   - Neither reader writes anything — a rebuild is idempotent on disk and must
 *     stay that way (it is a read path in hooks and a tmux poll loop).
 *
 * This contract is local to the agent-status channel. It changes nothing about
 * STATE.md ownership or quality-gate semantics.
 *
 * Best-effort telemetry contract: a status push must NEVER crash or block a
 * wave. Every exported function is no-throw and returns a structured result:
 *
 *   { ok: true } | { ok: false, reason: 'invalid-input'|'timeout'|'fs-error', error? }
 *
 * Concurrency: the LWW-map read-modify-write is serialised through a
 * self-contained POSIX lock (`agent-status.lock`) using the same `linkSync`
 * create-or-fail idiom the repo uses elsewhere (session-lock.mjs). The lock is
 * intentionally local to this module — it is a fast, short-held write-mutex,
 * orthogonal to the session/state locks in session-lock.mjs.
 *
 * Reuse (do NOT reinvent):
 *   - appendJsonl(filePath, obj)        — scripts/lib/common.mjs (O_APPEND, PIPE_BUF-atomic)
 *   - writeJsonAtomicSync(filePath, ..) — scripts/lib/io.mjs     (tmp + renameSync)
 *   - isPidAliveOnHost(pid)             — scripts/lib/session-lock.mjs (signal-0 probe)
 *
 * No external dependencies — Node 20+ stdlib only.
 */

import fs from 'node:fs';
import path from 'node:path';

import { appendJsonl } from './common.mjs';
import { writeJsonAtomicSync } from './io.mjs';
import { tryAcquireFileLock, releaseFileLock } from './file-lock.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUNTIME_DIR = '.orchestrator/runtime';
const JSONL_NAME = 'agent-status.jsonl';
const CURRENT_NAME = 'agent-status-current.json';
const LOCK_NAME = 'agent-status.lock';

const DEFAULT_TIMEOUT_MS = 10000;
const POLL_MS = 100;

// macOS PIPE_BUF floor is 512 bytes; keep each JSONL line comfortably under it
// by truncating free-text fields. 256 chars leaves headroom for the JSON
// envelope (keys, ts, numbers).
const MAX_TEXT_LEN = 256;

// Bounded rebuild window (#1342). A wave's live status traffic is a handful of
// records per agent, so the newest state always sits in the last few KiB —
// 256 KiB is ~1500 typical 170-byte records, three orders of magnitude of
// headroom, and it keeps the rebuild a single bounded read instead of a scan of
// an unbounded append-only file.
// CEILING: an agent whose newest record sits FURTHER back than `maxBytes` is
// invisible to the rebuild (it stays whatever the cache says, or absent).
// REVISIT-TRIGGER: if a session ever pushes more than ~1500 status records, or
// if a rebuilt view is observed missing a live agent, raise this constant or
// switch to a reverse-chunked scan that stops once every known agentId is seen.
const DEFAULT_REBUILD_MAX_BYTES = 256 * 1024;

// Identity fields a record may carry to bind it to a run/session/wave. Records
// carrying none of them are `legacy` — they are NEVER auto-assigned to the
// newest wave (#1342 item 4).
const BINDING_KEYS = ['sessionId', 'session_id', 'runId', 'run_id', 'waveKey', 'wave_key', 'wave'];

// agentIds that must never become a map key. `entries['__proto__'] = rec` on a
// normal object REPLACES the prototype instead of storing the record (the record
// vanishes AND every later lookup walks a foreign prototype), and
// `constructor`/`prototype` are the same class of confusion. Every map this
// module builds is null-prototype, so the assignment itself is safe — these keys
// are rejected outright so a poisoned ledger line cannot reappear as an agent.
const UNSAFE_MAP_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function runtimeDirFor(repoRoot) {
  return path.join(repoRoot ?? process.cwd(), RUNTIME_DIR);
}

function jsonlPathFor(repoRoot) {
  return path.join(runtimeDirFor(repoRoot), JSONL_NAME);
}

function currentPathFor(repoRoot) {
  return path.join(runtimeDirFor(repoRoot), CURRENT_NAME);
}

function lockPathFor(repoRoot) {
  return path.join(runtimeDirFor(repoRoot), LOCK_NAME);
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Copy a plain object into a NULL-PROTOTYPE map, dropping `UNSAFE_MAP_KEYS`.
 * `JSON.parse` happily produces an OWN `__proto__` property, so a poisoned cache
 * file would otherwise travel into a consumer's `entries` map.
 * @param {Record<string, object>|null|undefined} obj
 * @returns {Record<string, object>}
 */
function nullProtoMap(obj) {
  const out = Object.create(null);
  for (const k of Object.keys(obj ?? {})) {
    if (UNSAFE_MAP_KEYS.has(k)) continue;
    out[k] = obj[k];
  }
  return out;
}

/**
 * Truncate a free-text field to MAX_TEXT_LEN so a single JSONL line stays under
 * the PIPE_BUF floor. Non-strings pass through untouched.
 * @param {*} s
 * @returns {*}
 */
function truncate(s) {
  if (typeof s !== 'string') return s;
  return s.length > MAX_TEXT_LEN ? s.slice(0, MAX_TEXT_LEN) : s;
}

/**
 * Acquire the write-mutex. Polls every POLL_MS until acquired or the timeout
 * deadline. The first iteration is unconditional so timeoutMs:0 still tries
 * exactly once. On EEXIST, inspects the existing lock and atomically overrides
 * it ONLY when same-host AND its PID is dead, or its body is unparseable
 * (PSA-003: never auto-override a cross-host lock).
 *
 * Delegates to the shared file-lock primitive (issue #630). Behavior is
 * preserved exactly: compact body `{pid, host, acquiredAt}` (indent:null),
 * synchronous busy-wait poll (sync variant), PID staleCheck, console.warn
 * override channel with the original message, override tmp prefix
 * `.agent-status.lock.replace`, and the ENOENT-on-read race collapsed into a
 * retry (signalVanished:false).
 *
 * @param {string} lockFile
 * @param {number} timeoutMs
 * @returns {{ ok: true, body: object } | { ok: false, reason: 'timeout'|'fs-error', error?: string }}
 */
function acquireLock(lockFile, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let firstPass = true;

  while (firstPass || Date.now() < deadline) {
    firstPass = false;

    const attempt = tryAcquireFileLock(lockFile, {
      staleCheck: 'pid',
      indent: null,
      tmpPrefix: '.agent-status.lock.replace',
      warnMessage: (reason, lp) => `⚠ agent-status: overriding stale lock (${reason}) at ${lp}`,
    });
    if (attempt.acquired) return { ok: true, body: attempt.body };
    if (attempt.reason === 'fs-error') {
      return { ok: false, reason: 'fs-error', error: attempt.error };
    }

    // reason === 'held' (live holder, cross-host, or vanished-collapsed-to-held)
    // → poll until the deadline.
    if (Date.now() >= deadline) break;
    sleepMs(POLL_MS);
  }

  return { ok: false, reason: 'timeout' };
}

/**
 * Synchronous busy-wait sleep. The lock is held only for a sub-millisecond
 * read-modify-write, so a short synchronous poll keeps the helper simple and
 * avoids leaking async timers into the best-effort no-throw contract.
 * @param {number} ms
 */
function sleepMs(ms) {
  const end = Date.now() + ms;
  // Atomics.wait on a throwaway buffer is a portable, CPU-cheap sleep.
  try {
    const sab = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sab, 0, 0, ms);
  } catch {
    // SharedArrayBuffer unavailable (unlikely on Node 20+) → tight spin fallback.
    while (Date.now() < end) { /* spin */ }
  }
}

/**
 * Release the lock — but ONLY if WE own it (pid + host match). PSA-003: never
 * delete a lock another holder owns. Delegates to releaseFileLock with the
 * default owner-guard (no holder label → falls back to pid+host equality,
 * exactly as the original did).
 * @param {string} lockFile
 * @param {object} _myBody  The body returned by acquireLock (unused — the
 *   primitive re-reads the on-disk body and matches pid+host of the current
 *   process, which is the same process that called acquireLock).
 */
function releaseLock(lockFile, _myBody) {
  // ownerGuard:true with no holder → unlink IFF on-disk pid+host match this
  // process. Result reasons (not-found/not-owner) are ignored: best-effort.
  releaseFileLock(lockFile, { ownerGuard: true });
}

/**
 * Read the current LWW map from disk. Returns {} on a missing file (ENOENT)
 * silently; an unreadable/unparseable one (EACCES/EISDIR/malformed JSON/…)
 * also returns {} but with a stderr WARN (#1210 — ENOENT and other failures
 * are different facts, same split as `sessions-canonical.mjs`
 * `readCanonicalSessions`).
 * @param {string} currentFile
 * @returns {Record<string, object>}
 */
function readCurrentMap(currentFile) {
  return readCurrentMapDetailed(currentFile).entries;
}

/**
 * Same read as `readCurrentMap`, but it reports WHY the map is empty (#1342) —
 * "absent" and "unreadable" are different facts, and only the second one makes
 * the ledger the authority for provenance purposes.
 *
 * @param {string} currentFile
 * @returns {{ ok: boolean, entries: Record<string, object>, reason: 'ok'|'cache-missing'|'cache-unreadable' }}
 */
function readCurrentMapDetailed(currentFile) {
  let raw;
  try {
    raw = fs.readFileSync(currentFile, 'utf8');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      process.stderr.write(
        `⚠ readCurrentMap: cannot read ${currentFile} ` +
          `(${err?.code ?? '?'}: ${err?.message ?? String(err)}) — ` +
          'treating as EMPTY, counts below are floors\n',
      );
      return { ok: false, entries: Object.create(null), reason: 'cache-unreadable' };
    }
    return { ok: false, entries: Object.create(null), reason: 'cache-missing' };
  }
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return { ok: true, entries: nullProtoMap(obj), reason: 'ok' };
    }
  } catch {
    /* fall through to the unreadable verdict below */
  }
  return { ok: false, entries: Object.create(null), reason: 'cache-unreadable' };
}

/**
 * Parse a record's `ts` into epoch millis. Returns null when absent/unparseable
 * — such a record is never allowed to win a fold on timestamp grounds.
 * @param {*} rec
 * @returns {number|null}
 */
function recordTsMs(rec) {
  const ms = Date.parse(rec?.ts ?? '');
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Newest parsable record timestamp across a map's values, or null.
 * @param {Record<string, object>} entries
 * @returns {number|null}
 */
function newestTsMs(entries) {
  let newest = null;
  for (const rec of Object.values(entries ?? {})) {
    const ms = recordTsMs(rec);
    if (ms !== null && (newest === null || ms > newest)) newest = ms;
  }
  return newest;
}

/**
 * Read the last `maxBytes` of a file. Returns the raw text plus whether the
 * window cut into the file (i.e. the first line in `text` may be partial).
 * @param {string} file
 * @param {number} maxBytes
 * @returns {{ text: string, size: number, cut: boolean }}
 */
function readTail(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const want = Math.min(size, maxBytes);
    const start = size - want;
    const buf = Buffer.allocUnsafe(want);
    let read = 0;
    while (read < want) {
      const n = fs.readSync(fd, buf, read, want - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return { text: buf.subarray(0, read).toString('utf8'), size, cut: start > 0 };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Shared write path for both setters: append the JSONL record, then perform a
 * lock-serialised read-modify-write of the LWW map. No-throw.
 *
 * @param {object} record  Fully-built status record (already validated/truncated).
 * @param {{ repoRoot?: string, timeoutMs?: number }} opts
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'timeout'|'fs-error', error?: string }>}
 */
async function pushRecord(record, opts) {
  const repoRoot = opts?.repoRoot;
  const timeoutMs = typeof opts?.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  const jsonlFile = jsonlPathFor(repoRoot);
  const currentFile = currentPathFor(repoRoot);
  const lockFile = lockPathFor(repoRoot);

  // (1) Append-only JSONL stream. appendJsonl mkdir -p's and is O_APPEND-atomic.
  try {
    await appendJsonl(jsonlFile, record);
  } catch (err) {
    return { ok: false, reason: 'fs-error', error: err?.message ?? String(err) };
  }

  // (2) Lock-serialised RMW of the LWW current-map.
  let acquired;
  try {
    acquired = acquireLock(lockFile, timeoutMs);
  } catch (err) {
    // acquireLock is internally no-throw, but belt-and-suspenders for the
    // best-effort contract.
    return { ok: false, reason: 'fs-error', error: err?.message ?? String(err) };
  }
  if (!acquired.ok) return acquired;

  try {
    const map = readCurrentMap(currentFile);
    map[record.agentId] = record;
    const written = writeJsonAtomicSync(currentFile, map, { tmpPrefix: '.agent-status-current' });
    if (!written.ok) return { ok: false, reason: 'fs-error', error: written.error };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'fs-error', error: err?.message ?? String(err) };
  } finally {
    releaseLock(lockFile, acquired.body);
  }
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Push a free-text status for an agent. No-throw, best-effort.
 *
 * @param {string} agentId  Non-empty agent identifier (LWW map key).
 * @param {string} text     Non-empty status text (truncated to ~256 chars).
 * @param {{ repoRoot?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'invalid-input'|'timeout'|'fs-error', error?: string }>}
 */
export async function setStatus(agentId, text, opts = {}) {
  if (typeof agentId !== 'string' || agentId.trim().length === 0) {
    return { ok: false, reason: 'invalid-input', error: 'agentId must be a non-empty string' };
  }
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, reason: 'invalid-input', error: 'text must be a non-empty string' };
  }

  const record = {
    agentId,
    kind: 'status',
    text: truncate(text),
    ts: new Date().toISOString(),
  };

  return pushRecord(record, opts);
}

/**
 * Push a structured progress update for an agent. No-throw, best-effort.
 *
 * @param {string} agentId  Non-empty agent identifier (LWW map key).
 * @param {{ step: number, total: number, label?: string }} progress
 * @param {{ repoRoot?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'invalid-input'|'timeout'|'fs-error', error?: string }>}
 */
export async function setProgress(agentId, progress = {}, opts = {}) {
  if (typeof agentId !== 'string' || agentId.trim().length === 0) {
    return { ok: false, reason: 'invalid-input', error: 'agentId must be a non-empty string' };
  }
  const { step, total, label } = progress ?? {};
  if (typeof step !== 'number' || !Number.isFinite(step)) {
    return { ok: false, reason: 'invalid-input', error: 'step must be a finite number' };
  }
  if (typeof total !== 'number' || !Number.isFinite(total)) {
    return { ok: false, reason: 'invalid-input', error: 'total must be a finite number' };
  }

  const record = {
    agentId,
    kind: 'progress',
    step,
    total,
    ts: new Date().toISOString(),
  };
  if (typeof label === 'string' && label.length > 0) {
    record.label = truncate(label);
  }

  return pushRecord(record, opts);
}

/**
 * Rebuild the current-status map from a bounded TAIL of the append-only ledger
 * (#1342). The ledger is the source of truth; this is how a consumer reads it
 * without trusting the cache. READ-ONLY and idempotent — it never writes the
 * ledger, the cache, or anything else. No-throw.
 *
 * Fold rule (identity binding): one entry per `agentId`, won by the greatest
 * parsable `ts`; ties go to the later line. A record whose `ts` is absent or
 * unparseable can only win when NO timestamped record exists for that agentId,
 * and is then marked `binding: 'unknown'`. A record carrying none of the
 * run/session/wave fields is marked `binding: 'legacy'` — never promoted into
 * the newest wave. An older-session record therefore cannot overwrite a newer
 * session's record for the same agentId when the timestamps say otherwise.
 *
 * @param {{ repoRoot?: string, maxBytes?: number }} [opts]
 * @returns {{
 *   entries: Record<string, object>,
 *   at: string|null,
 *   scannedBytes: number,
 *   fileSize: number,
 *   degraded: { reason: string, reasons: string[], partialLines: number, parseErrors: number, unboundRecords: number, tailTruncated: boolean }|null
 * }}
 */
export function rebuildCurrentFromLedger(opts = {}) {
  const jsonlFile = jsonlPathFor(opts?.repoRoot);
  const maxBytes =
    typeof opts?.maxBytes === 'number' && opts.maxBytes > 0
      ? opts.maxBytes
      : DEFAULT_REBUILD_MAX_BYTES;

  const reasons = [];
  let partialLines = 0;
  let parseErrors = 0;
  let unboundRecords = 0;

  let tail;
  try {
    tail = readTail(jsonlFile, maxBytes);
  } catch (err) {
    const reason = err?.code === 'ENOENT' ? 'ledger-missing' : 'ledger-unreadable';
    return {
      entries: Object.create(null),
      at: null,
      scannedBytes: 0,
      fileSize: 0,
      degraded: {
        reason,
        reasons: [reason],
        partialLines: 0,
        parseErrors: 0,
        unboundRecords: 0,
        tailTruncated: false,
      },
    };
  }

  if (tail.size === 0) reasons.push('ledger-empty');

  const lines = tail.text.split('\n');
  if (tail.cut) {
    // The window started mid-file: the FIRST line is (or may be) a fragment.
    // Discard it and count it — never guess the state it would have carried.
    lines.shift();
    partialLines += 1;
    reasons.push('tail-truncated');
  }
  // A trailing newline yields one empty final element; a MISSING trailing
  // newline means the last line is an in-flight partial write.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  } else if (lines.length > 0 && tail.size > 0) {
    const incomplete = lines.pop();
    if (incomplete.trim().length > 0) {
      partialLines += 1;
      reasons.push('incomplete-last-line');
    }
  }

  /** @type {Record<string, object>} */
  const entries = Object.create(null);
  /** @type {Record<string, number|null>} */
  const bestTs = Object.create(null);

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      parseErrors += 1;
      continue;
    }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      parseErrors += 1;
      continue;
    }
    if (typeof rec.agentId !== 'string' || rec.agentId.trim().length === 0) {
      // No usable key — it can never be attributed to an agent. Counted, dropped.
      unboundRecords += 1;
      continue;
    }
    if (UNSAFE_MAP_KEYS.has(rec.agentId)) {
      // A prototype-shaped key is not a usable map key either (see
      // UNSAFE_MAP_KEYS) — same class as a missing agentId: counted, dropped.
      unboundRecords += 1;
      continue;
    }

    const ts = recordTsMs(rec);
    const bound = BINDING_KEYS.some((k) => rec[k] !== undefined && rec[k] !== null);
    const prevTs = Object.prototype.hasOwnProperty.call(bestTs, rec.agentId)
      ? bestTs[rec.agentId]
      : undefined;

    if (prevTs !== undefined) {
      if (ts === null) continue; // untimestamped never displaces a known record
      if (prevTs !== null && ts < prevTs) continue; // older session must not win
    }

    bestTs[rec.agentId] = ts;
    entries[rec.agentId] = { ...rec, binding: ts === null ? 'unknown' : bound ? 'bound' : 'legacy' };
  }

  if (parseErrors > 0) reasons.push('parse-errors');
  if (unboundRecords > 0) reasons.push('records-without-agent-id');

  const newest = newestTsMs(entries);
  return {
    entries,
    at: newest === null ? null : new Date(newest).toISOString(),
    scannedBytes: Buffer.byteLength(tail.text, 'utf8'),
    fileSize: tail.size,
    degraded:
      reasons.length === 0
        ? null
        : {
            reason: reasons[0],
            reasons,
            partialLines,
            parseErrors,
            unboundRecords,
            tailTruncated: tail.cut,
          },
  };
}

/**
 * Read the current status of every agent WITH PROVENANCE (#1342).
 *
 * Return contract:
 *   {
 *     entries: Record<agentId, record>,   // the map shape the cache holds
 *     source: 'live-map' | 'rebuilt-log' | 'stale-cache' | 'absent',
 *     at: string|null,                    // ISO ts of the newest record in `entries`
 *     degraded?: { reason, reasons[], partialLines, parseErrors, unboundRecords, tailTruncated }
 *   }
 *
 * Decision rule — the fold is PER agentId, never by the two views' GLOBAL newest
 * timestamp. A global comparison is masked by any sibling: ledger `A completed`
 * (map write lost) followed by ledger `B running` (map write ok) makes the cache's
 * newest equal the ledger's newest, and `A` was then served from the cache as
 * `running` with `source: live-map` — byte-identical to the pre-#1342 defect.
 * So for every id in `cache ∪ ledger` the record with the newer `ts` wins (an
 * equal-ms tie goes to the cache, which is the writer's own last word):
 *   - every entry taken from the cache → `live-map`; the cache is VERIFIED
 *     against a ledger (the normal path).
 *   - ANY entry taken from the ledger, or the cache unreadable/missing while the
 *     ledger has entries → `rebuilt-log` (the #1342 defect: a failed map write
 *     used to show the OLD state unmarked).
 *   - ledger missing/unreadable/empty but the cache has entries → `stale-cache`;
 *     the cache is all we have and is explicitly marked as unverified.
 *   - neither a usable ledger NOR a cache entry → `absent`: nothing is on disk to
 *     verify against, so this is NOT `live-map`. `entries: {}`, `at: null`, and no
 *     `degraded` — a fresh repo is the normal state, not a degradation (HR-101).
 *
 * BREAKING (documented, #1342): this used to return the bare map. Read
 * `.entries` for the old value — or call `readCurrentStatusEntries()`.
 *
 * Entry shape note: an entry taken from the LEDGER carries the extra
 * `binding: 'bound'|'legacy'|'unknown'` field the fold assigns; an entry taken
 * from the cache is the record as written and has none. Since the fold is
 * per-agentId, a `rebuilt-log` view can hold BOTH kinds. A consumer must treat
 * `binding` as optional — its ABSENCE means "from the cache", never "bound".
 *
 * @param {{ repoRoot?: string, maxBytes?: number }} [opts]
 * @returns {{ entries: Record<string, object>, source: 'live-map'|'rebuilt-log'|'stale-cache'|'absent', at: string|null, degraded?: object }}
 */
export function readCurrentStatus(opts = {}) {
  const cache = readCurrentMapDetailed(currentPathFor(opts?.repoRoot));
  const rebuilt = rebuildCurrentFromLedger(opts);

  const cacheNewest = newestTsMs(cache.entries);
  const ledgerNewest = rebuilt.at === null ? null : Date.parse(rebuilt.at);
  const ledgerUnusable =
    rebuilt.degraded !== null &&
    ['ledger-missing', 'ledger-unreadable', 'ledger-empty'].includes(rebuilt.degraded.reason) &&
    Object.keys(rebuilt.entries).length === 0;

  const reasons = rebuilt.degraded ? [...rebuilt.degraded.reasons] : [];
  const counts = {
    partialLines: rebuilt.degraded?.partialLines ?? 0,
    parseErrors: rebuilt.degraded?.parseErrors ?? 0,
    unboundRecords: rebuilt.degraded?.unboundRecords ?? 0,
    tailTruncated: rebuilt.degraded?.tailTruncated ?? false,
  };

  let source;
  let entries;
  let at;

  const cacheIds = Object.keys(cache.entries);
  const ledgerIds = Object.keys(rebuilt.entries);

  if (ledgerUnusable && cacheIds.length === 0) {
    // Nothing on disk at all — no ledger to verify against AND no cached entry
    // to verify. `live-map` would claim a verification that never happened.
    return { entries: Object.create(null), source: 'absent', at: null };
  }

  if (ledgerUnusable) {
    // No ledger to check the cache against, but the cache holds entries.
    source = 'stale-cache';
    entries = cache.entries;
    at = cacheNewest;
    if (!cache.ok && cache.reason === 'cache-unreadable') reasons.unshift(cache.reason);
  } else {
    // Per-agentId fold over `cache ∪ ledger` — see the decision rule above.
    entries = Object.create(null);
    let tookFromLedger = false;
    for (const id of new Set([...cacheIds, ...ledgerIds])) {
      const cached = Object.prototype.hasOwnProperty.call(cache.entries, id)
        ? cache.entries[id]
        : undefined;
      const logged = Object.prototype.hasOwnProperty.call(rebuilt.entries, id)
        ? rebuilt.entries[id]
        : undefined;

      if (cached === undefined) {
        entries[id] = logged;
        tookFromLedger = true;
        continue;
      }
      if (logged === undefined) {
        entries[id] = cached;
        continue;
      }
      const cachedTs = recordTsMs(cached);
      const loggedTs = recordTsMs(logged);
      // The ledger wins only when it is STRICTLY newer (an equal-ms tie, and an
      // undated ledger record, go to the cache).
      if (loggedTs !== null && (cachedTs === null || loggedTs > cachedTs)) {
        entries[id] = logged;
        tookFromLedger = true;
      } else {
        entries[id] = cached;
      }
    }

    at = newestTsMs(entries);
    if (tookFromLedger || (!cache.ok && ledgerIds.length > 0)) {
      source = 'rebuilt-log';
      if (cache.reason !== 'ok') reasons.unshift(cache.reason);
      else reasons.unshift('cache-behind-ledger');
    } else {
      source = 'live-map';
      // The ledger is BEHIND the cache — it was rotated or truncated under us.
      if (cacheNewest !== null && ledgerNewest !== null && ledgerNewest < cacheNewest) {
        reasons.unshift('ledger-behind-cache');
      }
    }
  }

  const out = {
    entries,
    source,
    at: at === null ? null : new Date(at).toISOString(),
  };
  if (reasons.length > 0) out.degraded = { reason: reasons[0], reasons, ...counts };
  return out;
}

/**
 * Backwards-compatible accessor: the bare `Record<agentId, record>` map that
 * `readCurrentStatus()` returned before #1342, resolved through the same
 * provenance rule (so it, too, prefers the ledger over a stale cache).
 *
 * @param {{ repoRoot?: string, maxBytes?: number }} [opts]
 * @returns {Record<string, object>}
 */
export function readCurrentStatusEntries(opts = {}) {
  return readCurrentStatus(opts).entries;
}
