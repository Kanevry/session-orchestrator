/**
 * file-lock.mjs — shared POSIX file-lock primitive (issue #630).
 *
 * Consolidates the five self-contained tmp + linkSync lock implementations that
 * had accreted across the codebase (agent-status.mjs, memory-proposals/store.mjs,
 * and the state-lock / staging-fence / session-lock blocks of session-lock.mjs).
 * Each copy independently re-implemented the same skeleton:
 *
 *   1. atomic create-or-fail via `linkSync(tmp, lock)` (POSIX mutex);
 *   2. on EEXIST → read + parse the existing body;
 *   3. same-host + dead-PID (or unparseable) → atomic override + WARN;
 *   4. live holder OR cross-host → poll until a deadline;
 *   5. owner-guarded release.
 *
 * This module is the single home for that skeleton. It is a PURE primitive:
 * it imports ONLY scripts/lib/io.mjs (for writeJsonAtomicSync) and Node stdlib.
 * It does NOT import session-lock.mjs — instead `isPidAliveOnHost` is MOVED here
 * and re-exported from session-lock.mjs, so the dependency edge points
 * file-lock → io, never the reverse (no import cycle).
 *
 * Behavior-preservation contract (issue #630 is a PURE dedup refactor):
 *   - Lock file paths, body shapes, timeouts, poll cadences, override channels
 *     (console.warn vs process.stderr.write), and result-object reasons are
 *     reproduced EXACTLY by the call-site options. The primitive carries no
 *     opinion of its own — every divergence between the five copies is a knob.
 *   - Cross-host locks are NEVER auto-overridden (PSA-003 hard invariant).
 *   - Overrides always go through writeJsonAtomicSync (tmp + renameSync).
 *
 * No external dependencies — Node 20+ stdlib + io.mjs only.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { writeJsonAtomicSync } from './io.mjs';

// ---------------------------------------------------------------------------
// PID liveness (moved here from session-lock.mjs in #630)
// ---------------------------------------------------------------------------

/**
 * Check whether a PID corresponds to a live process on this host.
 * Returns true when the process exists (even if we lack kill permission).
 * Returns false when the process does not exist (ESRCH).
 *
 * @forensic
 * This is a SAME-HOST PID liveness probe (POSIX `process.kill(pid, 0)`,
 * signal-0). It is NOT the discovery-path liveness check. Since Epic #583
 * (W1-D1/W1-D4) the discovery decision tree uses heartbeat-age via
 * `isLockLive` (session-lock.mjs) instead, because the `pid` recorded on a
 * session.lock is the *ephemeral hook subprocess* PID — that process exits
 * ~500ms after the SessionStart hook returns, so a signal-0 probe of it reports
 * "dead" while the semantic owner (the Claude harness) is still alive (the D2
 * production defect). Cross-host callers MUST pass `null` for the liveness slot
 * and never call this function. Remaining same-host callers use it only for the
 * short-lived state-lock / staging-fence-lock / agent-status / memory-proposals
 * stale-override path, where the recorded PID IS the live writer's PID.
 *
 * @param {number} pid  Process ID to probe via the POSIX signal-0 trick.
 * @returns {boolean}   true when a process with the given PID exists; false
 *                      when no such process exists or the probe failed.
 *
 * @remarks
 * PID-recycle trade-off (#560 Q3 L2 — deep-2115 session-reviewer):
 *
 *  - On Unix, `process.kill(pid, 0)` returns true if ANY process exists with
 *    that PID, including a recycled one. The kernel does not distinguish the
 *    original lock-holder from a fresh process that happens to have inherited
 *    the same numeric PID after the lock-holder's death.
 *  - On a long session where the lock-holder died abnormally AND the OS reused
 *    its PID before TTL expiry, this function returns `true` even though the
 *    original lock-holder is gone. The lock is then perceived as held by a
 *    "live" process that is actually unrelated to the original writer.
 *  - Impact: a stale lock waits the full TTL before being reclaimed by the
 *    timeout path. Fail-open posture means correctness is preserved — only
 *    operational latency is affected, and the missed race-detection is
 *    bounded to one incident per stale-lock event.
 *  - Trade-off accepted: the alternative would require recording a UUID or
 *    boot-nonce alongside the PID and comparing both fields on stale-detection.
 *    That adds complexity to the lock body, parse path, and every
 *    acquire/release branch for a single-missed-race-per-incident impact.
 *    Current trade-off is operationally sound at our scale.
 */
export function isPidAliveOnHost(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    if (err.code === 'EPERM') return true; // process exists, we just lack permission
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a lock-file body. Returns null on any malformed input. The required
 * fields are configurable so a single parser serves both the 3-field shape
 * ({pid, host, acquiredAt}) used by agent-status / memory-proposals and the
 * 4-field shape ({pid, host, acquiredAt, holder}) used by the state-lock /
 * staging-fence locks. The primitive only ever inspects `pid` and `host`, so
 * the minimal contract enforced here is `{ pid: number, host: string }`.
 *
 * @param {string} raw
 * @returns {object|null}
 */
function parseBody(raw) {
  try {
    const obj = JSON.parse(raw);
    if (
      obj &&
      typeof obj === 'object' &&
      !Array.isArray(obj) &&
      typeof obj.pid === 'number' &&
      typeof obj.host === 'string'
    ) {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve whether an existing lock body is stale relative to the requested
 * stale-check policy. Cross-host bodies are NEVER stale here (PSA-003 — we
 * cannot signal a remote process). Returns a `{ stale, reason }` pair.
 *
 * @param {object} existing — parsed lock body (non-null).
 * @param {'pid'|'heartbeat'|'mtime'|'none'} staleCheck
 * @param {number|undefined} staleMs — TTL for heartbeat/mtime checks.
 * @param {string|undefined} lockPath — needed for mtime stat.
 * @returns {{ stale: boolean, reason: string }}
 */
function isExistingStale(existing, staleCheck, staleMs, lockPath) {
  const sameHost = existing.host === os.hostname();
  if (!sameHost) return { stale: false, reason: 'cross-host' };

  if (staleCheck === 'none') return { stale: false, reason: 'live' };

  if (staleCheck === 'pid') {
    const pidIsNumber = typeof existing.pid === 'number';
    const dead = pidIsNumber && !isPidAliveOnHost(existing.pid);
    return dead
      ? { stale: true, reason: `dead pid ${existing.pid}` }
      : { stale: false, reason: 'live' };
  }

  if (staleCheck === 'heartbeat') {
    const ts = Date.parse(existing.acquiredAt ?? existing.lastHeartbeat ?? '');
    if (!Number.isFinite(ts) || typeof staleMs !== 'number') {
      return { stale: false, reason: 'live' };
    }
    const age = Date.now() - ts;
    return age > staleMs
      ? { stale: true, reason: `heartbeat age ${age}ms > ${staleMs}ms` }
      : { stale: false, reason: 'live' };
  }

  if (staleCheck === 'mtime') {
    if (typeof staleMs !== 'number' || !lockPath) {
      return { stale: false, reason: 'live' };
    }
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(lockPath).mtimeMs;
    } catch {
      return { stale: false, reason: 'live' };
    }
    const age = Date.now() - mtimeMs;
    return age > staleMs
      ? { stale: true, reason: `mtime age ${Math.round(age)}ms > ${staleMs}ms` }
      : { stale: false, reason: 'live' };
  }

  return { stale: false, reason: 'live' };
}

/**
 * Atomically create the lock file via tmp + linkSync (POSIX create-or-fail).
 * The winner creates the hard link; every loser gets EEXIST.
 *
 * @param {string} lockPath
 * @param {object} body
 * @param {{ indent?: number|null, tmpPrefix: string }} fmt
 * @returns {{ ok: true } | { ok: false, reason: 'exists' } | { ok: false, reason: 'fs-error', error: string }}
 */
function createExclusive(lockPath, body, fmt) {
  const dir = path.dirname(lockPath);
  let tmpFile;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const suffix = crypto.randomBytes(8).toString('hex');
    tmpFile = path.join(dir, `${fmt.tmpPrefix}.create.tmp.${suffix}`);
    fs.writeFileSync(tmpFile, serializeBody(body, fmt.indent), 'utf8');
  } catch (err) {
    if (tmpFile) {
      try { fs.unlinkSync(tmpFile); } catch { /* best-effort */ }
    }
    return { ok: false, reason: 'fs-error', error: err?.message ?? String(err) };
  }

  try {
    fs.linkSync(tmpFile, lockPath);
    return { ok: true };
  } catch (err) {
    if (err.code === 'EEXIST') return { ok: false, reason: 'exists' };
    return { ok: false, reason: 'fs-error', error: err?.message ?? String(err) };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* best-effort */ }
  }
}

/**
 * Serialize a lock body. `indent === null` → compact (no whitespace, no
 * trailing newline) to reproduce agent-status / memory-proposals exactly.
 * Numeric indent → pretty-printed with a trailing newline (state / staging).
 *
 * @param {object} body
 * @param {number|null} indent
 * @returns {string}
 */
function serializeBody(body, indent) {
  if (indent === null || indent === undefined) {
    return JSON.stringify(body);
  }
  return JSON.stringify(body, null, indent) + '\n';
}

// ---------------------------------------------------------------------------
// Exported primitive
// ---------------------------------------------------------------------------

/**
 * Attempt ONE exclusive lock acquisition pass.
 *
 * On EEXIST the existing body is read and parsed; if it is stale per the
 * configured `staleCheck` policy (or unparseable), the lock is atomically
 * overridden via writeJsonAtomicSync and a WARN is emitted. A live holder or a
 * cross-host body returns `{ acquired: false, reason: 'held' }`.
 *
 * The `signalVanished` knob reproduces memory-proposals/store.mjs's distinct
 * third state: when the lock file disappears between the EEXIST and the read
 * (concurrent release race), `{ acquired: false, reason: 'vanished' }` is
 * returned so the caller defers WITHOUT any override side-effect (preserves the
 * C9 8-worker double-holder invariant). When `signalVanished` is false the
 * ENOENT-on-read race collapses into `{ acquired: false, reason: 'held' }`
 * (state-lock / staging-fence / agent-status behavior).
 *
 * @param {string} lockPath  Absolute path to the lock file.
 * @param {object} [opts]
 * @param {'pid'|'heartbeat'|'mtime'|'none'} [opts.staleCheck='pid']
 * @param {number} [opts.staleMs]            — TTL for heartbeat/mtime staleCheck.
 * @param {object} [opts.meta]               — extra fields merged into the body.
 * @param {string} [opts.holder]             — holder label (added to body when set).
 * @param {boolean} [opts.signalVanished=false]
 * @param {number|null} [opts.indent]        — body serialization: null=compact, number=pretty.
 * @param {string} [opts.tmpPrefix]          — tmp-file prefix for create + override.
 * @param {(msg: string) => void} [opts.warn] — override-WARN sink (default console.warn).
 * @param {(reason: string, lockPath: string, existing: object|null) => string} [opts.warnMessage]
 *        — build the WARN string from the stale reason, path, and the parsed
 *        existing body (null when the body was unparseable). The reason token is
 *        'unparseable body' | 'dead pid <n>' | 'heartbeat age ...' | 'mtime age ...'.
 * @returns {{ acquired: true, body: object }
 *   | { acquired: false, reason: 'held'|'vanished'|'fs-error', existing?: object|null, error?: string }}
 */
export function tryAcquireFileLock(lockPath, opts = {}) {
  const {
    staleCheck = 'pid',
    staleMs,
    meta,
    holder,
    signalVanished = false,
    indent = null,
    tmpPrefix = '.file.lock',
    warn = (msg) => console.warn(msg),
    warnMessage = (reason, lp) => `⚠ file-lock: overriding stale lock (${reason}) at ${lp}`,
  } = opts;

  // The stale-override path writes via writeJsonAtomicSync. The original copies
  // diverged on override formatting: agent-status / state-lock / staging-fence
  // override pretty-printed (indent 2) regardless of create format, while
  // memory-proposals overrode compact. writeJsonAtomicSync always appends a
  // trailing newline; with overrideIndent:null it emits `JSON.stringify(body)\n`
  // (compact + newline). The trailing newline is parse-transparent (JSON.parse
  // ignores it), so this is behavior-identical for every consumer.
  const overrideIndent = opts.overrideIndent !== undefined ? opts.overrideIndent : (indent ?? 2);

  const body = {
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: new Date().toISOString(),
    ...(meta && typeof meta === 'object' ? meta : {}),
  };
  if (typeof holder === 'string' && holder.length > 0) {
    body.holder = holder;
  }

  const fmt = { indent, tmpPrefix };

  let created;
  try {
    created = createExclusive(lockPath, body, fmt);
  } catch (err) {
    return { acquired: false, reason: 'fs-error', error: err?.message ?? String(err) };
  }
  if (created.ok) return { acquired: true, body };
  if (created.reason === 'fs-error') {
    return { acquired: false, reason: 'fs-error', error: created.error };
  }

  // reason === 'exists' — inspect the holder.
  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Lock vanished between linkSync-EEXIST and read — a concurrent
      // release-then-reacquire race. We lost; never override.
      return signalVanished
        ? { acquired: false, reason: 'vanished' }
        : { acquired: false, reason: 'held', existing: null };
    }
    return { acquired: false, reason: 'fs-error', error: err?.message ?? String(err) };
  }

  const existing = parseBody(raw);

  // Unparseable contents → treat as stale and override (only safe move).
  if (existing === null) {
    warn(warnMessage('unparseable body', lockPath, null));
    const replaced = writeJsonAtomicSync(lockPath, body, { tmpPrefix, indent: overrideIndent });
    if (replaced.ok) return { acquired: true, body };
    return { acquired: false, reason: 'fs-error', error: replaced.error };
  }

  const { stale, reason } = isExistingStale(existing, staleCheck, staleMs, lockPath);
  if (stale) {
    warn(warnMessage(reason, lockPath, existing));
    const replaced = writeJsonAtomicSync(lockPath, body, { tmpPrefix, indent: overrideIndent });
    if (replaced.ok) return { acquired: true, body };
    return { acquired: false, reason: 'fs-error', error: replaced.error };
  }

  // Live holder OR cross-host → caller polls.
  return { acquired: false, reason: 'held', existing };
}

/**
 * Release a lock file.
 *
 * With `ownerGuard: true` (default) the file is unlinked ONLY when we own it:
 * the recorded `holder` matches `opts.holder` (when provided), else PID + host
 * match. This reproduces the agent-status / state-lock / staging-fence owner
 * guard (PSA-003: never delete a lock another holder owns).
 *
 * With `ownerGuard: false` the file is unlinked unconditionally, ENOENT
 * ignored — reproducing memory-proposals/store.mjs's `releaseProposalsLock`.
 *
 * @param {string} lockPath
 * @param {object} [opts]
 * @param {string} [opts.holder]            — expected holder for the owner guard.
 * @param {boolean} [opts.ownerGuard=true]
 * @param {(errToken: string) => void} [opts.warn] — sink for unexpected fs
 *        errors on the ownerGuard:false path. Receives the raw
 *        `err.code ?? err.message` token; the call-site formats the message.
 * @returns {{ ok: true }
 *   | { ok: false, reason: 'not-found'|'not-owner'|'fs-error', error?: string }}
 */
export function releaseFileLock(lockPath, opts = {}) {
  const { holder, ownerGuard = true, warn } = opts;

  if (ownerGuard === false) {
    // Unconditional unlink; ENOENT ignored. Other fs errors surfaced via warn.
    // The warn callback receives the raw `err.code ?? err.message` token so the
    // call-site controls the surrounding message format.
    try {
      fs.unlinkSync(lockPath);
      return { ok: true };
    } catch (err) {
      if (err.code === 'ENOENT') return { ok: true };
      if (typeof warn === 'function') warn(err.code ?? err.message);
      return { ok: false, reason: 'fs-error', error: err?.message ?? String(err) };
    }
  }

  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, reason: 'not-found' };
    return { ok: false, reason: 'fs-error', error: err?.message ?? String(err) };
  }

  const lock = parseBody(raw);
  if (lock === null) {
    // Unparseable — refuse to delete; some other process may be writing now.
    return { ok: false, reason: 'not-owner' };
  }

  const expectedHolder = typeof holder === 'string' && holder.length > 0 ? holder : null;
  const ownerMatch = expectedHolder !== null
    ? lock.holder === expectedHolder
    : lock.pid === process.pid && lock.host === os.hostname();

  if (!ownerMatch) return { ok: false, reason: 'not-owner' };

  try {
    fs.unlinkSync(lockPath);
    return { ok: true };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, reason: 'not-found' };
    return { ok: false, reason: 'fs-error', error: err?.message ?? String(err) };
  }
}

/**
 * Synchronous busy-wait sleep via Atomics.wait on a throwaway buffer — a
 * portable, CPU-cheap sleep used by the `sync` variant of withFileLock (the
 * agent-status no-throw hot path that must not leak async timers). Falls back
 * to a tight spin if SharedArrayBuffer is unavailable.
 * @param {number} ms
 */
function sleepSync(ms) {
  const end = Date.now() + ms;
  try {
    const sab = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sab, 0, 0, ms);
  } catch {
    while (Date.now() < end) { /* spin */ }
  }
}

/**
 * Async poll-sleep. Promise-returning so the loop does not block the event loop.
 * @param {number} ms
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * High-level wrapper: acquire `lockPath` (polling until a deadline), run `fn`,
 * and release in a finally. The acquire pass delegates to tryAcquireFileLock,
 * so every stale-override / cross-host / vanished knob is honored here too.
 *
 * Returns the value of `fn()`. On acquire timeout or fs-error returns a
 * structured failure (callers that want a throw should branch on it — the
 * existing session-lock wrappers keep their own throw-translation). `fn` errors
 * propagate after the lock is released.
 *
 * @param {string} lockPath
 * @param {(body: object) => (T | Promise<T>)} fn  — receives the acquired body.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=10000]
 * @param {number} [opts.pollMs=100]
 * @param {boolean} [opts.sync=false]  — true → synchronous busy-wait poll +
 *        synchronous fn (agent-status variant). false → async poll.
 * @param {boolean} [opts.ownerGuard=true]  — passed to releaseFileLock.
 * @param {...*} [opts.acquireOpts]  — remaining keys forwarded to tryAcquireFileLock.
 * @returns {Promise<{ ok: true, value: T }
 *   | { ok: false, reason: 'timeout'|'fs-error', error?: string, existing?: object|null }>}
 * @template T
 */
export async function withFileLock(lockPath, fn, opts = {}) {
  const {
    timeoutMs = 10000,
    pollMs = 100,
    sync = false,
    ownerGuard = true,
    ...acquireOpts
  } = opts;

  const effectiveTimeout = typeof timeoutMs === 'number' && timeoutMs >= 0 ? timeoutMs : 10000;
  const effectivePoll = typeof pollMs === 'number' && pollMs > 0 ? pollMs : 100;
  const deadline = Date.now() + effectiveTimeout;

  let acquired;
  // First iteration runs unconditionally so timeoutMs:0 still attempts once.
  for (;;) {
    const attempt = tryAcquireFileLock(lockPath, acquireOpts);
    if (attempt.acquired) {
      acquired = attempt;
      break;
    }
    if (attempt.reason === 'fs-error') {
      return { ok: false, reason: 'fs-error', error: attempt.error };
    }
    if (Date.now() >= deadline) {
      return { ok: false, reason: 'timeout', existing: attempt.existing ?? null };
    }
    if (sync) {
      sleepSync(effectivePoll);
    } else {
      await delay(effectivePoll);
    }
  }

  const releaseHolder = acquired.body.holder;
  try {
    const value = await fn(acquired.body);
    return { ok: true, value };
  } finally {
    releaseFileLock(lockPath, { holder: releaseHolder, ownerGuard });
  }
}
