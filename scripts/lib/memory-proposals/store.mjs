/**
 * memory-proposals/store.mjs — atomic JSONL append + per-wave quota counter
 * + per-wave summary writer for memory proposal records.
 *
 * Design:
 *  - Lock file: `.orchestrator/metrics/proposals-write.lock`
 *  - Lock idiom: tmp-file + linkSync(tmp, lock) — mirrors session-lock.mjs
 *    `createStateLockExclusive` pattern (POSIX-atomic create-or-fail).
 *  - Proposals JSONL: `.orchestrator/metrics/proposals.jsonl` (O_APPEND)
 *  - Per-wave summary: `.orchestrator/metrics/proposals-summary-<wave-id>.json`
 *  - Confidence floor check: BEFORE lock acquisition (no I/O, no lock held).
 *  - Quota check: INSIDE lock (count + decide + write serialized).
 *
 * No external dependencies — Node 20+ stdlib only.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { serializeProposal } from './schema.mjs';
import { validatePathInsideProject } from '../path-utils.mjs';
import { isPidAlive } from '../session-lock.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROPOSALS_JSONL = '.orchestrator/metrics/proposals.jsonl';
const PROPOSALS_LOCK = '.orchestrator/metrics/proposals-write.lock';
const PROPOSALS_SUMMARY_PREFIX = '.orchestrator/metrics/proposals-summary-';

const DEFAULT_QUOTA_PER_WAVE = 5;
const DEFAULT_CONFIDENCE_FLOOR = 0.5;
const DEFAULT_LOCK_TIMEOUT_MS = 1000;
const LOCK_POLL_MS = 50;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a metrics-relative path against repoRoot, with path-traversal guard.
 * Throws a TypeError on traversal attempts — callers have already validated
 * repoRoot is a trusted absolute path.
 *
 * Delegates to validatePathInsideProject (#544 M3 — canonical two-phase guard)
 * with canonicalizeRoot:true so macOS tmpdir paths (where /var resolves to
 * /private/var) are handled consistently in tests and production.
 *
 * Trust boundary (#554 A4, low severity): On block, the TypeError surfaces
 * the resolved absolute path (`${resolved}`). This path-info disclosure is
 * acceptable per the project's local-trust model — only reachable via an
 * attacker-controlled `relPath`, surfaced only to local stderr and the
 * memory-propose audit log (operator-readable). NOT for environments where
 * filesystem layout is sensitive.
 *
 * @param {string} repoRoot — absolute path to the repo working directory
 * @param {string} relPath  — path relative to repoRoot (must not escape it)
 * @returns {string} resolved absolute path (realPath when the target exists, else lexicalPath)
 */
function safePath(repoRoot, relPath) {
  const result = validatePathInsideProject(relPath, repoRoot, { canonicalizeRoot: true });
  if (!result.ok) {
    const resolved = path.resolve(repoRoot, relPath);
    // #548 A5 — surface result.reason ('lexical' | 'symlink' | 'input') in the
    // error so operators can distinguish path-traversal classes at a glance:
    //  - 'lexical' → relPath escaped repoRoot via ../../ before symlink resolution
    //  - 'symlink' → relPath resolved through a symlink that points outside repoRoot
    //  - 'input'   → relPath was malformed (empty, non-string, null byte)
    throw new TypeError(
      `store.mjs: path traversal blocked: ${resolved} is outside ${repoRoot} (reason: ${result.reason})`
    );
  }
  return result.realPath ?? result.lexicalPath;
}

/**
 * Ensure the parent directory of `filePath` exists.
 * @param {string} filePath
 */
function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/**
 * Build the absolute path to the lock file.
 * @param {string} repoRoot
 * @returns {string}
 */
function lockPathFor(repoRoot) {
  return safePath(repoRoot, PROPOSALS_LOCK);
}

/**
 * Build the absolute path to the JSONL proposals file.
 * @param {string} repoRoot
 * @returns {string}
 */
function jsonlPathFor(repoRoot) {
  return safePath(repoRoot, PROPOSALS_JSONL);
}

/**
 * Build the absolute path to the per-wave summary JSON file.
 * wave_id values are restricted to alphanumerics + hyphens/underscores to
 * prevent filename injection — any other character causes a throw.
 *
 * @param {string} repoRoot
 * @param {string} waveId
 * @returns {string}
 */
function summaryPathFor(repoRoot, waveId) {
  if (!/^[A-Za-z0-9_-]+$/.test(waveId)) {
    throw new TypeError(`store.mjs: waveId contains invalid characters: ${waveId}`);
  }
  return safePath(repoRoot, `${PROPOSALS_SUMMARY_PREFIX}${waveId}.json`);
}

/**
 * Attempt one exclusive lock creation via tmp + linkSync (POSIX mutex).
 *
 * Pattern from session-lock.mjs § createStateLockExclusive:
 *  1. Write full content to a tmp file in the lock directory.
 *  2. linkSync(tmp, lockFile) — atomic create-or-EEXIST.
 *  3. Best-effort unlink(tmp) in finally.
 *
 * On EEXIST, reads the existing lock body and returns it for stale-PID
 * inspection by the caller (#543 H2). If the lock file disappears between
 * the EEXIST and the read (race with concurrent release), this returns a
 * 'vanished' signal so the caller defers rather than overriding.
 * Unparseable contents (parse failure on a present file) ARE treated as
 * stale via `existingLock: null` — they cannot be safely owned.
 *
 * --- #548 A1 — Acknowledged divergence from session-lock.mjs:tryAcquireStateLock ---
 *
 * This helper returns a **3-state** result shape (`exists` / `vanished` /
 * `fs-error`), whereas `scripts/lib/session-lock.mjs:tryAcquireStateLock`
 * (lines ~498-549) returns a **2-state** result that maps ENOENT-on-read
 * to `{ ok: false, reason: 'held', existingLock: null }` — i.e. the
 * session-lock variant collapses the "lock vanished mid-read" race into
 * the generic `held` bucket so the caller's poll loop simply retries.
 *
 * The memory-proposals path surfaces `vanished` as a **distinct third
 * reason** because the 8-worker parallel-write scenario (C9 regression
 * test) needs the caller — `acquireProposalsLock` — to *defer* without
 * any stale-override side-effect. If we collapsed `vanished` into
 * `exists` with `existingLock: null`, the stale-lock branch in
 * `acquireProposalsLock` would call `replaceLockAtomic()` against a
 * possibly-already-reacquired file, producing a double-holder race
 * (regression of C9). Keeping the third reason explicit preserves the
 * "lose race → just retry, never override" invariant.
 *
 * See `acquireProposalsLock` below (specifically the `result.reason ===
 * 'vanished'` branch with its CRITICAL comment) for the consumer side of
 * this contract, and #543 / #548 for context.
 *
 * @param {string} lockFile
 * @param {object} body — lock body to serialize
 * @returns {{ ok: true }
 *   | { ok: false, reason: 'exists', existingLock: object|null }
 *   | { ok: false, reason: 'vanished' }
 *   | { ok: false, reason: 'fs-error', error?: string }}
 */
function tryCreateLock(lockFile, body) {
  ensureDir(lockFile);
  const tmpSuffix = crypto.randomBytes(8).toString('hex');
  const tmpFile = path.join(path.dirname(lockFile), `.proposals-write.lock.tmp.${tmpSuffix}`);

  try {
    fs.writeFileSync(tmpFile, JSON.stringify(body), 'utf8');
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch { /* best-effort */ }
    return { ok: false, reason: 'fs-error', error: err.message };
  }

  try {
    fs.linkSync(tmpFile, lockFile);
    return { ok: true };
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Read existing lock body so the caller can apply PID-liveness logic.
      let raw;
      try {
        raw = fs.readFileSync(lockFile, 'utf8');
      } catch (readErr) {
        // ENOENT here means the file was unlinked between linkSync EEXIST
        // and our read — i.e., a concurrent release-then-acquire race. We
        // are the loser; defer to the next poll iteration. Do NOT override.
        if (readErr.code === 'ENOENT') {
          return { ok: false, reason: 'vanished' };
        }
        return { ok: false, reason: 'fs-error', error: readErr.message };
      }

      let existingLock = null;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          existingLock = parsed;
        }
      } catch {
        // Parseable read but unparseable contents — treat as stale (existingLock=null).
      }
      return { ok: false, reason: 'exists', existingLock };
    }
    return { ok: false, reason: 'fs-error', error: err.message };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* best-effort */ }
  }
}

/**
 * Atomically replace an existing lock file via tmp + renameSync.
 * Used only on the stale-override path where the existing lock is known dead.
 *
 * Mirrors session-lock.mjs § replaceStateLockAtomic.
 *
 * @param {string} lockFile
 * @param {object} body — lock body to serialize
 * @returns {{ ok: true } | { ok: false, reason: 'fs-error', error?: string }}
 */
function replaceLockAtomic(lockFile, body) {
  try {
    ensureDir(lockFile);
    const tmpSuffix = crypto.randomBytes(6).toString('hex');
    const tmpFile = path.join(path.dirname(lockFile), `.proposals-write.lock.tmp.${tmpSuffix}`);
    fs.writeFileSync(tmpFile, JSON.stringify(body), 'utf8');
    fs.renameSync(tmpFile, lockFile);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'fs-error', error: err.message };
  }
}

/**
 * Acquire the proposals write-lock via spin-poll.
 * Returns when the lock is acquired, or after timeoutMs.
 *
 * Stale-lock detection (#543 H2 — mirrors session-lock.mjs § tryAcquireStateLock):
 *  - On EEXIST with an unparseable body → treat as stale, atomic override + WARN.
 *  - On EEXIST with a parseable body whose host matches AND pid is dead →
 *    treat as stale, atomic override + WARN to stderr.
 *  - On EEXIST with a live PID, OR a cross-host body → continue polling.
 *
 * @param {string} lockFile
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'timeout' | 'fs-error', error?: string }>}
 */
async function acquireProposalsLock(lockFile, timeoutMs) {
  const body = {
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const result = tryCreateLock(lockFile, body);
    if (result.ok) return { ok: true };
    if (result.reason === 'fs-error') return result;

    // result.reason === 'vanished' — lock file was unlinked between our EEXIST
    // and our read. Concurrent release race; defer to the next poll iteration.
    // CRITICAL: do NOT call replaceLockAtomic here — a concurrent acquirer may
    // have already taken the freshly-vacant lock, and overriding would create
    // a double-holder race (regression of the C9 8-worker test).
    if (result.reason === 'vanished') {
      if (Date.now() >= deadline) {
        return { ok: false, reason: 'timeout', error: 'lock-timeout' };
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      continue;
    }

    // result.reason === 'exists' — inspect for staleness.
    const existing = result.existingLock;

    // Unparseable existing lock — treat as stale and override.
    if (existing === null) {
      process.stderr.write(
        '⚠ memory-proposals lock: stale lock detected (unparseable body) — reclaiming\n'
      );
      const writeResult = replaceLockAtomic(lockFile, body);
      if (writeResult.ok) return { ok: true };
      if (writeResult.reason === 'fs-error') return writeResult;
    } else {
      // Parseable existing lock — same-host AND dead PID → stale override.
      //
      // #548 A5 — TOCTOU acknowledgment:
      // There is a small, theoretically-existing race window between the
      // `isPidAlive(existing.pid)` check on the next line and the subsequent
      // `replaceLockAtomic(lockFile, body)` call. Concretely:
      //
      //   T0: isPidAlive(pid) === false  // PID was dead at check time
      //   T1: kernel recycles the same numeric PID for an UNRELATED process
      //   T2: replaceLockAtomic() overrides the lock
      //
      // At T2 we will have stolen the lock from a process that, by PID, looks
      // alive but is in fact a different program that never held our lock.
      // The window between T0 and T2 is sub-millisecond in practice (two sync
      // syscalls back-to-back), and the consequence is bounded — we override
      // a stale lock that nobody was using anyway. This is the same residual
      // risk profile as the ftruncate-then-write race in POSIX append-mode
      // writes: documented, accepted, not eliminated by simple userspace
      // means. Mirrors session-lock.mjs:tryAcquireStateLock (lines ~533-545)
      // which has the same structural race without explicit acknowledgment.
      //
      // Hardening options (future work, not in scope for #548 A5):
      //  - Persist a monotonic "lock generation" counter alongside `pid` so
      //    we detect PID reuse from a different generation.
      //  - Use Linux `pidfd_open` (not portable; no macOS equivalent).
      const sameHost =
        typeof existing.host === 'string' && existing.host === os.hostname();
      const pidIsNumber = typeof existing.pid === 'number';
      const pidDead = sameHost && pidIsNumber && isPidAlive(existing.pid) === false;

      if (pidDead) {
        process.stderr.write(
          `⚠ memory-proposals lock: stale lock detected (pid=${existing.pid}, host=${existing.host}) — reclaiming\n`
        );
        const writeResult = replaceLockAtomic(lockFile, body);
        if (writeResult.ok) return { ok: true };
        if (writeResult.reason === 'fs-error') return writeResult;
      }
    }

    if (Date.now() >= deadline) {
      return { ok: false, reason: 'timeout', error: 'lock-timeout' };
    }

    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

/**
 * Release (unlink) the proposals write-lock. Idempotent — ENOENT is ignored.
 * @param {string} lockFile
 */
function releaseProposalsLock(lockFile) {
  try {
    fs.unlinkSync(lockFile);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Log but do not re-throw — release errors must not mask the callers' error.
      process.stderr.write(
        `store.mjs: lock release failed (${err.code ?? err.message})\n`
      );
    }
  }
}

/**
 * Count lines in a JSONL file where `wave_id === waveId`.
 * Returns 0 if the file does not exist.
 *
 * Complexity: O(lines) — acceptable for quota ≤ 5 in a session.
 *
 * @param {string} jsonlPath
 * @param {string} waveId
 * @returns {number}
 */
function countWaveLines(jsonlPath, waveId) {
  let raw;
  try {
    raw = fs.readFileSync(jsonlPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }

  let count = 0;
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && obj.wave_id === waveId) count++;
    } catch {
      /* skip malformed lines */
    }
  }
  return count;
}

/**
 * Read the per-wave summary JSON, or return a zeroed summary if absent.
 * @param {string} summaryPath
 * @returns {{ queued: number, dropped: number, below_floor: number, fs_error: number }}
 */
function readSummary(summaryPath) {
  try {
    const raw = fs.readFileSync(summaryPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        queued: parsed.queued ?? 0,
        dropped: parsed.dropped ?? 0,
        below_floor: parsed.below_floor ?? 0,
        fs_error: parsed.fs_error ?? 0,
      };
    }
  } catch {
    /* ENOENT or malformed — return zeros */
  }
  return { queued: 0, dropped: 0, below_floor: 0, fs_error: 0 };
}

/**
 * Atomically increment one field in the per-wave summary JSON.
 * Uses a tmp + rename to avoid partial-write races.
 * Failures are silently swallowed — the summary is diagnostic, not critical.
 *
 * @param {string} summaryPath
 * @param {keyof ReturnType<typeof readSummary>} field
 */
function incrementSummary(summaryPath, field) {
  try {
    ensureDir(summaryPath);
    const current = readSummary(summaryPath);
    current[field] = (current[field] ?? 0) + 1;
    const tmpSuffix = crypto.randomBytes(4).toString('hex');
    const tmpFile = `${summaryPath}.tmp.${tmpSuffix}`;
    fs.writeFileSync(tmpFile, JSON.stringify(current, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpFile, summaryPath);
  } catch {
    /* best-effort: summary writes are non-critical */
  }
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Append a validated ProposalRecord to the proposals JSONL, subject to
 * per-wave quota and confidence floor enforcement.
 *
 * Flow:
 *  1. Confidence check BEFORE lock (no I/O needed).
 *  2. Acquire lock (spin-poll 50ms, timeout 1000ms default).
 *  3. Inside lock: count + decide + append.
 *  4. Release lock in finally.
 *
 * @param {object} opts
 * @param {object}  opts.record           — validated ProposalRecord (from schema.mjs)
 * @param {string}  opts.repoRoot         — absolute path to repo working directory
 * @param {string}  opts.waveId           — e.g. 'W2'; must match record.wave_id
 * @param {number}  [opts.quotaPerWave=5]
 * @param {number}  [opts.confidenceFloor=0.5]
 * @param {number}  [opts.lockTimeoutMs=1000]
 * @returns {Promise<{
 *   status: 'queued' | 'quota-exceeded' | 'below-floor' | 'fs-error',
 *   position?: string,
 *   quota?: number,
 *   dropped?: number,
 *   error?: string
 * }>}
 */
export async function appendProposal({
  record,
  repoRoot,
  waveId,
  quotaPerWave = DEFAULT_QUOTA_PER_WAVE,
  confidenceFloor = DEFAULT_CONFIDENCE_FLOOR,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
}) {
  const summaryPath = summaryPathFor(repoRoot, waveId);

  // ------------------------------------------------------------------
  // Step 1: Confidence floor — before lock, no I/O needed.
  // ------------------------------------------------------------------
  if (
    typeof record.confidence !== 'number' ||
    record.confidence < confidenceFloor
  ) {
    incrementSummary(summaryPath, 'below_floor');
    return { status: 'below-floor' };
  }

  const lockFile = lockPathFor(repoRoot);
  const jsonlPath = jsonlPathFor(repoRoot);

  // ------------------------------------------------------------------
  // Step 2: Acquire lock. Early return if acquire fails (no lock held → no
  // release needed). After this point any path that reaches the finally
  // below holds the lock and must release it.
  // ------------------------------------------------------------------
  const lockResult = await acquireProposalsLock(lockFile, lockTimeoutMs);
  if (!lockResult.ok) {
    incrementSummary(summaryPath, 'fs_error');
    return { status: 'fs-error', error: lockResult.error ?? lockResult.reason };
  }

  try {
    // ------------------------------------------------------------------
    // Step 3a: Count current proposals for this wave.
    // ------------------------------------------------------------------
    let currentCount;
    try {
      currentCount = countWaveLines(jsonlPath, waveId);
    } catch (err) {
      incrementSummary(summaryPath, 'fs_error');
      return { status: 'fs-error', error: err.message };
    }

    // ------------------------------------------------------------------
    // Step 3b: Quota check.
    // ------------------------------------------------------------------
    if (currentCount >= quotaPerWave) {
      const summary = readSummary(summaryPath);
      const droppedSoFar = summary.dropped;
      incrementSummary(summaryPath, 'dropped');
      return {
        status: 'quota-exceeded',
        quota: quotaPerWave,
        dropped: droppedSoFar + 1,
      };
    }

    // ------------------------------------------------------------------
    // Step 3c: Append to JSONL (O_APPEND via appendFileSync).
    // ------------------------------------------------------------------
    try {
      ensureDir(jsonlPath);
      fs.appendFileSync(jsonlPath, serializeProposal(record) + '\n', 'utf8');
    } catch (err) {
      incrementSummary(summaryPath, 'fs_error');
      return { status: 'fs-error', error: err.message };
    }

    incrementSummary(summaryPath, 'queued');
    const position = `${currentCount + 1}/${quotaPerWave}`;
    return { status: 'queued', position };
  } finally {
    // ------------------------------------------------------------------
    // Step 4: Always release lock (idempotent unlink). Reaching this finally
    // implies the lock was acquired above — early-return covers the
    // non-acquired branch.
    // ------------------------------------------------------------------
    releaseProposalsLock(lockFile);
  }
}

/**
 * Count the number of proposals recorded for a given wave_id.
 * Reads proposals.jsonl without acquiring the lock — suitable for diagnostics
 * and reads where eventual consistency is acceptable.
 *
 * Returns 0 when the file does not exist.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.waveId
 * @returns {Promise<number>}
 */
export async function countProposalsForWave({ repoRoot, waveId }) {
  const jsonlPath = jsonlPathFor(repoRoot);
  try {
    return countWaveLines(jsonlPath, waveId);
  } catch {
    return 0;
  }
}

/**
 * Read the per-wave summary for diagnostic purposes.
 * Returns null when the summary file does not exist.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.waveId
 * @returns {Promise<{
 *   queued: number,
 *   dropped: number,
 *   below_floor: number,
 *   fs_error: number
 * } | null>}
 */
export async function readWaveSummary({ repoRoot, waveId }) {
  const summaryPath = summaryPathFor(repoRoot, waveId);
  try {
    const raw = fs.readFileSync(summaryPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        queued: parsed.queued ?? 0,
        dropped: parsed.dropped ?? 0,
        below_floor: parsed.below_floor ?? 0,
        fs_error: parsed.fs_error ?? 0,
      };
    }
    return null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return null;
  }
}
