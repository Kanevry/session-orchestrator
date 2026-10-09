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
 *  - Overflow JSONL: `.orchestrator/metrics/proposals-overflow.jsonl` — validated
 *    proposals the quota rejected (#1027 1b). Never counted against the quota,
 *    never read by the collector; written under the same lock as the queue.
 *  - Confidence floor check: BEFORE lock acquisition (no I/O, no lock held).
 *  - Quota check: INSIDE lock (count + decide + write serialized).
 *
 * No external dependencies — Node 20+ stdlib only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { serializeProposal } from './schema.mjs';
import { validatePathInsideProject } from '../path-utils.mjs';
import { tryAcquireFileLock, releaseFileLock } from '../file-lock.mjs';
import { writeJsonAtomicSync } from '../io.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROPOSALS_JSONL = '.orchestrator/metrics/proposals.jsonl';
const PROPOSALS_OVERFLOW_JSONL = '.orchestrator/metrics/proposals-overflow.jsonl';
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
  // #548 A5 — surface result.reason ('lexical' | 'symlink' | 'input') in the
  // error so operators can distinguish path-traversal classes at a glance:
  //  - 'lexical' → relPath escaped repoRoot via ../../ before symlink resolution
  //  - 'symlink' → relPath resolved through a symlink that points outside repoRoot
  //  - 'input'   → relPath was malformed (empty, non-string, null byte)
  const blocked = (reason) =>
    new TypeError(
      `store.mjs: path traversal blocked: ${path.resolve(repoRoot, relPath)} is outside ${repoRoot} (reason: ${reason})`
    );
  if (!result.ok) throw blocked(result.reason);
  // The shared validator swallows ENOENT on the target and returns the lexical
  // path unchecked, so a symlinked ancestor (or a dangling symlink AT the
  // target) lets the first write land outside the repo (#1027 1b). Closed here,
  // store-side, so the shared validator's other callers keep their behaviour.
  if (result.realPath === undefined && !existingAncestorInsideRoot(repoRoot, result.lexicalPath)) {
    throw blocked('symlink');
  }
  return result.realPath ?? result.lexicalPath;
}

/**
 * True when the nearest EXISTING component of `lexicalPath` (the path itself
 * or the closest ancestor) resolves inside the canonical `repoRoot`. A
 * symlink there whose target is missing (dangling) counts as an escape — the
 * write that follows would create the target wherever the link points.
 *
 * Only node:fs/node:path on purpose: store-safepath-reason.test.mjs mocks
 * `@lib/path-utils.mjs` with a single export, so no second import from it.
 *
 * Check-then-write TOCTOU: a link swapped in between this check and the
 * append is not caught (O_NOFOLLOW would narrow the final component only).
 * Accepted under the local-trust model; revisit if the metrics dir ever
 * becomes writable by another principal.
 *
 * @param {string} repoRoot
 * @param {string} lexicalPath — absolute, already known to be lexically inside repoRoot
 * @returns {boolean}
 */
function existingAncestorInsideRoot(repoRoot, lexicalPath) {
  let root = repoRoot;
  try {
    root = fs.realpathSync(repoRoot);
  } catch (err) {
    if (err?.code !== 'ENOENT' && err?.code !== 'EACCES') throw err;
  }
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const inside = (p) => {
    const rel = path.relative(fold(root), fold(p));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  for (let cur = lexicalPath; ; cur = path.dirname(cur)) {
    // Climbed above the root: root itself is missing, so nothing under it can
    // be a link — the later mkdir creates a plain tree.
    if (!inside(cur)) return true;
    try {
      fs.lstatSync(cur);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      continue;
    }
    let real;
    try {
      real = fs.realpathSync(cur);
    } catch {
      // Dangling link or loop at the nearest existing component → escape.
      // But the lock file is created and unlinked by concurrent writers all
      // the time: if the component vanished between lstat and realpath it was
      // never a link, so step up to its parent instead of rejecting.
      try {
        fs.lstatSync(cur);
      } catch (err) {
        if (err?.code === 'ENOENT') continue;
        throw err;
      }
      return false;
    }
    return inside(real);
  }
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
 * Build the absolute path to the quota-overflow JSONL file.
 * @param {string} repoRoot
 * @returns {string}
 */
function overflowPathFor(repoRoot) {
  return safePath(repoRoot, PROPOSALS_OVERFLOW_JSONL);
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
 * Acquire the proposals write-lock via spin-poll.
 * Returns when the lock is acquired, or after timeoutMs.
 *
 * Delegates to the shared file-lock primitive (issue #630). Behavior is
 * preserved EXACTLY:
 *
 *  - Compact body `{pid, host, acquiredAt}` (indent:null on create).
 *  - 3-state distinction via `signalVanished:true` — the ENOENT-on-read race
 *    surfaces as `{ acquired: false, reason: 'vanished' }`, and this loop
 *    defers WITHOUT any override side-effect. CRITICAL: never override on
 *    `vanished` — a concurrent acquirer may have already taken the freshly
 *    vacant lock; overriding would create a double-holder race (regression of
 *    the C9 8-worker test). This was the reason the memory-proposals copy
 *    surfaced `vanished` as a distinct third reason rather than collapsing it
 *    into `held` (#548 A1).
 *  - PID staleCheck: same-host + dead PID → atomic override + WARN to stderr.
 *  - WARN channel: `process.stderr.write` with the original messages.
 *  - Override tmp prefix `.proposals-write.lock.tmp`, compact override body
 *    (overrideIndent:null) — preserves the original `replaceLockAtomic` format.
 *
 * #548 A5 — TOCTOU acknowledgment (now centralized in file-lock.mjs's
 * isExistingStale → isPidAliveOnHost): a sub-millisecond race exists between
 * the PID-liveness check and the override write. The window is two sync
 * syscalls; the consequence is bounded (override a stale lock nobody used).
 * Accepted, not eliminated. See file-lock.mjs `isPidAliveOnHost` remarks.
 *
 * @param {string} lockFile
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'timeout' | 'fs-error', error?: string }>}
 */
async function acquireProposalsLock(lockFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const result = tryAcquireFileLock(lockFile, {
      staleCheck: 'pid',
      signalVanished: true,
      indent: null,
      overrideIndent: null,
      tmpPrefix: '.proposals-write.lock.tmp',
      warn: (msg) => process.stderr.write(msg),
      warnMessage: (reason, _lp, existing) =>
        existing === null
          ? '⚠ memory-proposals lock: stale lock detected (unparseable body) — reclaiming\n'
          : `⚠ memory-proposals lock: stale lock detected (pid=${existing.pid}, host=${existing.host}) — reclaiming\n`,
    });

    if (result.acquired) return { ok: true };
    if (result.reason === 'fs-error') return { ok: false, reason: 'fs-error', error: result.error };

    // reason === 'vanished' (concurrent release race) OR 'held' (live holder /
    // cross-host). Both defer to the next poll iteration without overriding.
    if (Date.now() >= deadline) {
      return { ok: false, reason: 'timeout', error: 'lock-timeout' };
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

/**
 * Release (unlink) the proposals write-lock. Idempotent — ENOENT is ignored.
 *
 * Delegates to releaseFileLock with `ownerGuard:false` — reproducing the
 * original unconditional unlink. PRESERVE this: the memory-proposals release is
 * intentionally NOT owner-guarded (it always runs inside the same process that
 * acquired, immediately after the JSONL append, so the on-disk lock is always
 * ours). Non-ENOENT fs errors are logged to stderr, never re-thrown.
 *
 * @param {string} lockFile
 */
function releaseProposalsLock(lockFile) {
  releaseFileLock(lockFile, {
    ownerGuard: false,
    warn: (errToken) => process.stderr.write(`store.mjs: lock release failed (${errToken})\n`),
  });
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
 * Read + parse a per-wave summary JSON file. Returns the parsed summary on
 * success, or `null` on any failure — missing file (ENOENT) silently, any
 * other read/parse failure with a stderr WARN (#1210 — ENOENT and other
 * failures are different facts, same split as `sessions-canonical.mjs`
 * `readCanonicalSessions`). Shared by `readSummary` (defaults to zeros) and
 * `readWaveSummary` (surfaces `null` to its own caller) — one read path
 * instead of two near-identical copies.
 *
 * @param {string} summaryPath
 * @returns {{ queued: number, dropped: number, below_floor: number, fs_error: number } | null}
 */
function readSummaryFileSafe(summaryPath) {
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
    if (!err || err.code !== 'ENOENT') {
      process.stderr.write(
        `⚠ readSummaryFileSafe: cannot read ${summaryPath} ` +
          `(${err?.code ?? '?'}: ${err?.message ?? String(err)}) — ` +
          'treating as EMPTY, counts below are floors\n',
      );
    }
    return null;
  }
}

/**
 * Read the per-wave summary JSON, or return a zeroed summary if absent.
 * @param {string} summaryPath
 * @returns {{ queued: number, dropped: number, below_floor: number, fs_error: number }}
 */
function readSummary(summaryPath) {
  return readSummaryFileSafe(summaryPath) ?? { queued: 0, dropped: 0, below_floor: 0, fs_error: 0 };
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
    // Same bytes (indent 2 + trailing newline); a failure is swallowed as before.
    writeJsonAtomicSync(summaryPath, current, { tmpPrefix: `.${path.basename(summaryPath)}.tmp` });
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
      // Keep the validated proposal (#1027 1b): the quota caps what enters the
      // queue, not what an agent found. A failed write is fs-error — never a
      // quota-exceeded that implies the content was preserved. No size cap:
      // growth is bounded by rejected proposals only; revisit if the file
      // passes ~1 MB (rotation belongs with the quota policy, not here).
      let overflowPath;
      try {
        overflowPath = overflowPathFor(repoRoot);
      } catch (err) {
        incrementSummary(summaryPath, 'fs_error'); // traversal still throws, like every store path
        throw err;
      }
      try {
        ensureDir(overflowPath);
        fs.appendFileSync(overflowPath, serializeProposal(record) + '\n', 'utf8');
      } catch (err) {
        incrementSummary(summaryPath, 'fs_error');
        return { status: 'fs-error', error: err.message };
      }
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
 * Returns 0 when the file does not exist (silently — `countWaveLines` maps
 * ENOENT to 0). Any other read failure also returns 0, but with a stderr WARN
 * so a 0 caused by an unreadable file is distinguishable from an empty queue
 * (#1216).
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
  } catch (err) {
    process.stderr.write(
      `[memory-proposals] WARN: countProposalsForWave: ` +
        `${err?.code ?? '?'}: ${err?.message ?? String(err)} — returning 0\n`,
    );
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
  return readSummaryFileSafe(summaryPath);
}
