/**
 * session-registry.mjs — Per-session heartbeat files + peer detection.
 *
 * Part of Sub-Epic F (#159) of Epic #157. Backs hooks/on-session-start.mjs
 * peer-detection (F2, #168) and hooks/on-stop.mjs clean deregister + zombie
 * sweep (F3, #169).
 *
 * Registry location: `~/.config/session-orchestrator/sessions/active/<sessionId>.json`
 * Sweep log: `~/.config/session-orchestrator/sessions/sweep.log` (JSONL)
 *
 * Overridable via env var `SO_SESSION_REGISTRY_DIR` (points to the parent
 * `sessions/` directory, not `active/`) — used by tests for isolation.
 *
 * Heartbeat schema (per issue #167):
 *   {
 *     session_id, pid, platform, repo_path_hash, repo_name, branch,
 *     started_at, last_heartbeat, status ('active'|'wave'|'idle'),
 *     current_wave, host_class, mode (Epic #583 W2-I3)
 *   }
 *
 * Schema v2 (Epic #583, W2-I3): `mode` field added so the exclusivity-matrix
 * can classify cross-repo registry entries correctly. Without it, every
 * registry-sourced peer was bucketed as `mode='session'` → classifyMode threw
 * → fell back to `parallel-ok`, silently bypassing the exclusivity matrix
 * for cross-repo entries (D5 from Epic #583 audit). The field is optional
 * on read for back-compat with v1 entries (defaults to null).
 */

import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { digestSha256 } from './crypto-digest-utils.mjs';

import { appendFileSync, mkdirSync } from 'node:fs';

import { utcTimestamp, appendJsonl } from './common.mjs';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Parent directory for all session-registry state. */
export function registryBaseDir() {
  const override = process.env.SO_SESSION_REGISTRY_DIR;
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), '.config', 'session-orchestrator', 'sessions');
}

/** Directory holding one JSON file per active session. */
export function activeDir() {
  return path.join(registryBaseDir(), 'active');
}

/** Zombie-sweep observability log (JSONL). */
export function sweepLogPath() {
  return path.join(registryBaseDir(), 'sweep.log');
}

function entryPath(sessionId) {
  _assertSessionId(sessionId);
  return path.join(activeDir(), `${sessionId}.json`);
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * Stable SHA-256 hex of an absolute path. Used so registry entries can be
 * correlated by repo without exposing local filesystem layout.
 */
export function repoPathHash(absPath) {
  if (typeof absPath !== 'string' || absPath.length === 0) {
    throw new TypeError('repoPathHash: absPath must be a non-empty string');
  }
  return digestSha256(path.resolve(absPath));
}

function _assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('session_id must be a non-empty string');
  }
  // Guard against path separators / traversal in filename.
  if (sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('\x00') || sessionId === '.' || sessionId === '..') {
    throw new TypeError('session_id must not contain path separators or null bytes');
  }
}

async function _writeJsonAtomic(filePath, data, { mode = 0o600 } = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, filePath);
  try { await fs.chmod(filePath, mode); } catch { /* best effort */ }
}

async function _readJsonSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function _validEntry(obj) {
  if (!obj
    || typeof obj !== 'object'
    || typeof obj.session_id !== 'string'
    || typeof obj.last_heartbeat !== 'string'
    || typeof obj.started_at !== 'string') {
    return false;
  }
  // Schema v2 (Epic #583): `mode` is optional. When present it MUST be a string
  // (no number / object / array smuggling). When absent (v1 entry), it is
  // accepted — back-compat with pre-#583 registry files.
  if ('mode' in obj && obj.mode !== null && typeof obj.mode !== 'string') {
    return false;
  }
  return true;
}

function _ageMinutes(isoTimestamp, now = Date.now()) {
  const t = Date.parse(isoTimestamp);
  if (Number.isNaN(t)) return Infinity;
  return (now - t) / 60_000;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a single JSONL observability event to sweep.log. Non-throwing:
 * if writing to sweep.log itself fails the error is silently swallowed so
 * callers never cascade a log-write failure into a blocking error.
 *
 * Uses appendFileSync (sync) intentionally — this is called from a catch
 * branch where fire-and-forget sync writes are simpler and safer than
 * spawning a new async chain. Lines stay well under PIPE_BUF (4 KiB) so
 * the append is effectively atomic on POSIX.
 *
 * @param {{ event: string, session_id: string|null, error: string }} opts
 */
export function logSweepEvent({ event, session_id, error }) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    session_id: session_id ?? null,
    error: typeof error === 'string' ? error : String(error),
  }) + '\n';
  try {
    const logPath = sweepLogPath();
    try { mkdirSync(path.dirname(logPath), { recursive: true }); } catch { /* best effort */ }
    appendFileSync(logPath, line, 'utf8');
  } catch { /* last-resort silent no-op — never let log-write cascade */ }
}

/**
 * Create the heartbeat file for this session.
 *
 * @param {object} opts
 * @param {string} opts.sessionId — unique id (from hook stdin payload preferred; uuid fallback)
 * @param {string} opts.projectRoot — absolute path to the project root
 * @param {string} [opts.branch] — current git branch (optional)
 * @param {string} [opts.platform] — 'claude' | 'codex' | 'cursor' | null
 * @param {string} [opts.hostClass] — from getHostFingerprint().host_class
 * @param {number} [opts.pid] — defaults to process.pid
 * @param {string} [opts.status] — 'active' | 'wave' | 'idle' (default 'active')
 * @param {number} [opts.currentWave] — default 0
 * @param {string} [opts.mode] — session mode (e.g., 'deep', 'feature', 'housekeeping').
 *   Schema v2 (Epic #583, W2-I3): when present, propagated into the entry so
 *   discovery + exclusivity-matrix classification work for cross-repo peers.
 *   Default: `null` (back-compat with v1 entries).
 * @returns {Promise<object>} the written entry
 */
export async function registerSelf(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('registerSelf: opts is required');
  }
  const { sessionId, projectRoot } = opts;
  _assertSessionId(sessionId);
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('registerSelf: projectRoot must be a non-empty string');
  }
  // Schema v2 (Epic #583): validate mode shape if provided.
  if (opts.mode !== undefined && opts.mode !== null && typeof opts.mode !== 'string') {
    throw new TypeError('registerSelf: mode must be a string when provided');
  }
  // Schema v2.1 (Epic #583 W5-F1c — Q5 H1): semanticSessionId field for #587 completion.
  if (opts.semanticSessionId !== undefined && opts.semanticSessionId !== null && typeof opts.semanticSessionId !== 'string') {
    throw new TypeError('registerSelf: semanticSessionId must be a string when provided');
  }
  const now = utcTimestamp();
  const entry = {
    session_id: sessionId,
    semantic_session_id: opts.semanticSessionId ?? null,
    pid: opts.pid ?? process.pid,
    platform: opts.platform ?? null,
    repo_path_hash: repoPathHash(projectRoot),
    repo_name: path.basename(path.resolve(projectRoot)),
    branch: opts.branch ?? null,
    started_at: now,
    last_heartbeat: now,
    status: opts.status ?? 'active',
    current_wave: opts.currentWave ?? 0,
    host_class: opts.hostClass ?? null,
    mode: opts.mode ?? null,
  };
  await _writeJsonAtomic(entryPath(sessionId), entry);
  return entry;
}

/**
 * Refresh last_heartbeat on the existing entry (and optionally status /
 * current_wave). No-op if the entry is missing.
 */
export async function heartbeat(sessionId, patch = {}) {
  const file = entryPath(sessionId);
  const existing = await _readJsonSafe(file);
  if (!_validEntry(existing)) return null;
  const updated = {
    ...existing,
    last_heartbeat: utcTimestamp(),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.currentWave !== undefined ? { current_wave: patch.currentWave } : {}),
  };
  await _writeJsonAtomic(file, updated);
  return updated;
}

/** Read every valid heartbeat entry (ignoring malformed files). */
export async function readRegistry() {
  const dir = activeDir();
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const parsed = await _readJsonSafe(path.join(dir, name));
    if (_validEntry(parsed)) entries.push(parsed);
  }
  return entries;
}

/**
 * Determine whether a registry entry is "fresh" — last_heartbeat within
 * `freshnessMin` minutes of `now`. Mirrors detectPeers()'s age filter but
 * exposes the rule as a pure function so callers (session-discovery,
 * exclusivity-matrix consumers) can apply it without re-deriving the formula.
 *
 * Schema v2 (Epic #583, W2-I3): used by discoverActiveSessions() to filter
 * registry-sourced sessions when locks are absent / stale.
 *
 * @param {object} entry  Registry entry object
 * @param {object} [opts]
 * @param {number} [opts.freshnessMin=15]
 * @param {number} [opts.now]  ms-since-epoch (test seam)
 * @returns {boolean}
 */
export function isRegistryEntryFresh(entry, { freshnessMin = 15, now = Date.now() } = {}) {
  if (!_validEntry(entry)) return false;
  return _ageMinutes(entry.last_heartbeat, now) <= freshnessMin;
}

/**
 * Live peers on this host — excludes self and entries whose last_heartbeat is
 * older than `freshnessMin` minutes. Stale entries remain on disk (sweep is
 * the only thing that removes them).
 */
export async function detectPeers({ sessionId, freshnessMin = 15 } = {}) {
  const now = Date.now();
  const all = await readRegistry();
  return all.filter((e) => {
    if (sessionId && e.session_id === sessionId) return false;
    return _ageMinutes(e.last_heartbeat, now) <= freshnessMin;
  });
}

/**
 * Remove heartbeat entries older than `thresholdMin` minutes. Appends one
 * JSONL line per removal to sweepLogPath() for observability.
 *
 * @returns {Promise<{removed: string[], logged: number}>}
 */
export async function sweepZombies({ thresholdMin = 60, now = Date.now() } = {}) {
  const dir = activeDir();
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return { removed: [], logged: 0 };
  }
  const removed = [];
  let logged = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(dir, name);
    const parsed = await _readJsonSafe(full);
    // Malformed file → treat as zombie too.
    const age = _validEntry(parsed) ? _ageMinutes(parsed.last_heartbeat, now) : Infinity;
    if (age > thresholdMin) {
      try {
        await fs.unlink(full);
        removed.push(name);
        try {
          await appendJsonl(sweepLogPath(), {
            timestamp: new Date(now).toISOString(),
            session_id: parsed?.session_id ?? null,
            file: name,
            age_minutes: Number.isFinite(age) ? Math.round(age) : null,
            reason: _validEntry(parsed) ? 'stale-heartbeat' : 'malformed-entry',
          });
          logged += 1;
        } catch { /* log best-effort */ }
      } catch { /* file might have been removed by another sweep */ }
    }
  }
  return { removed, logged };
}

/**
 * Remove this session's heartbeat file. Idempotent — missing file is not an
 * error (clean-stop after a crashed-sweep scenario).
 *
 * @returns {Promise<boolean>} true if a file was removed
 */
export async function deregisterSelf(sessionId) {
  _assertSessionId(sessionId);
  try {
    await fs.unlink(entryPath(sessionId));
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}
