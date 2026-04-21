// @ts-check
/**
 * coordinator-snapshot.mjs — pre-dispatch coordinator snapshot helpers for session-orchestrator.
 *
 * Saves git stash commit objects under refs/so-snapshots/<sessionId>/wave-<N>-<label>
 * without touching the working tree. Uses `git stash create` to produce a stash commit
 * object and `git update-ref` to persist it under the custom ref namespace.
 *
 * Part of v3.1.0 env-aware sessions (issue #196).
 */

import { $, nothrow } from 'zx';

// Do not spam stdout/stderr with git command echoes.
$.verbose = false;
$.quiet = true;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MODULE = 'coordinator-snapshot';
const REF_PREFIX = 'refs/so-snapshots/';

/**
 * Sanitize a session ID for use in a git ref namespace.
 * Replaces any character outside [A-Za-z0-9._-] with '-'.
 *
 * @param {string} sessionId
 * @returns {string}
 */
function _sanitizeSessionId(sessionId) {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '-');
}

/**
 * Build the full ref name for a snapshot.
 *
 * @param {string} sanitizedSessionId
 * @param {number} waveN
 * @param {string} label
 * @returns {string}
 */
function _refName(sanitizedSessionId, waveN, label) {
  return `${REF_PREFIX}${sanitizedSessionId}/wave-${waveN}-${label}`;
}

// ---------------------------------------------------------------------------
// saveSnapshot
// ---------------------------------------------------------------------------

/**
 * Create a git-stash commit object and save it under refs/so-snapshots/<sessionId>/wave-<N>-<label>.
 * No-op when working tree is clean (no uncommitted changes). Does NOT touch the working tree
 * (uses `git stash create` which produces a commit object without modifying files).
 *
 * @param {Object} opts
 * @param {string} opts.sessionId — session identifier (sanitized for ref namespace)
 * @param {number} opts.waveN — wave number, 1-indexed
 * @param {string} [opts.label='pre'] — short suffix for the ref (e.g. 'pre-dispatch', 'post-impl')
 * @returns {Promise<{ok: boolean, ref: string|null, sha: string|null, skipped?: true, error?: string}>}
 */
export async function saveSnapshot({ sessionId, waveN, label = 'pre' }) {
  if (!sessionId || sessionId.trim() === '') {
    return { ok: false, ref: null, sha: null, error: `${MODULE}: sessionId must not be empty` };
  }

  const cwd = process.cwd();
  const git = $({ cwd });

  try {
    // Step 1: Check if working tree is clean.
    const statusResult = await git`git status --porcelain`;
    if (statusResult.stdout.trim() === '') {
      return { ok: true, ref: null, sha: null, skipped: true };
    }

    // Step 2: Create stash commit object without modifying working tree.
    const sanitized = _sanitizeSessionId(sessionId);
    const stashMessage = `so-snapshot ${sessionId} wave ${waveN} ${label}`;
    const stashResult = await git`git stash create ${stashMessage}`;
    const sha = stashResult.stdout.trim();

    if (!sha) {
      // git stash create returns empty if nothing to stash (race condition guard).
      return { ok: true, ref: null, sha: null, skipped: true };
    }

    // Step 3: Persist the stash commit object under our custom ref namespace.
    const ref = _refName(sanitized, waveN, label);
    await git`git update-ref ${ref} ${sha}`;

    return { ok: true, ref, sha };
  } catch (err) {
    const msg = err && typeof err === 'object' && 'stderr' in err
      ? /** @type {any} */ (err).stderr.trim()
      : String(err);
    return { ok: false, ref: null, sha: null, error: `${MODULE}: saveSnapshot failed — ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// listSnapshots
// ---------------------------------------------------------------------------

/**
 * List all coordinator snapshot refs, optionally filtered by sessionId.
 *
 * @param {Object} [opts]
 * @param {string} [opts.sessionId] — if set, only return this session's snapshots
 * @returns {Promise<Array<{ref: string, sha: string, sessionId: string, waveN: number, label: string, createdAt: string}>>}
 *   Sorted by waveN DESC (most recent wave first).
 */
export async function listSnapshots({ sessionId } = {}) {
  const cwd = process.cwd();
  const git = $({ cwd });

  let output = '';
  try {
    // zx interpolates each template-literal word as a separate argv entry, so the
    // format string must be a single interpolated value to stay as one --format arg.
    const fmt = '%(refname) %(objectname) %(committerdate:iso8601)';
    const result = await nothrow(
      git`git for-each-ref --format=${fmt} ${REF_PREFIX}`
    );
    output = result.stdout;
  } catch {
    return [];
  }

  /** @type {Array<{ref: string, sha: string, sessionId: string, waveN: number, label: string, createdAt: string}>} */
  const snapshots = [];

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    // Format: "<refname> <sha> <iso8601-date> <iso8601-time> <iso8601-offset>"
    // The date portion from --format=%(committerdate:iso8601) looks like:
    //   "refs/so-snapshots/sess/wave-1-pre abc123 2026-04-21 10:00:00 +0200"
    // We split on the first two spaces to get refname and sha, then take the rest as date.
    const spaceIdx1 = line.indexOf(' ');
    if (spaceIdx1 === -1) continue;
    const spaceIdx2 = line.indexOf(' ', spaceIdx1 + 1);
    if (spaceIdx2 === -1) continue;

    const ref = line.slice(0, spaceIdx1);
    const sha = line.slice(spaceIdx1 + 1, spaceIdx2);
    const dateStr = line.slice(spaceIdx2 + 1).trim();

    // Parse ref: strip prefix, then split on '/' to get sessionId and wave part.
    if (!ref.startsWith(REF_PREFIX)) continue;
    const remainder = ref.slice(REF_PREFIX.length);
    // remainder is "<sessionId>/wave-<N>-<label>"
    const slashIdx = remainder.indexOf('/');
    if (slashIdx === -1) {
      console.error(`${MODULE}: listSnapshots — unexpected ref format (no slash after sessionId): ${ref}`);
      continue;
    }

    const refSessionId = remainder.slice(0, slashIdx);
    const wavePart = remainder.slice(slashIdx + 1);

    // wavePart must match wave-<int>-<label>
    const waveMatch = wavePart.match(/^wave-(\d+)-(.+)$/);
    if (!waveMatch) {
      console.error(`${MODULE}: listSnapshots — skipping ref with unexpected wave format: ${ref}`);
      continue;
    }

    const waveN = parseInt(waveMatch[1], 10);
    const label = waveMatch[2];

    // Convert "2026-04-21 10:00:00 +0200" to ISO 8601 with T separator.
    const createdAt = dateStr.replace(' ', 'T').replace(' ', '');

    snapshots.push({ ref, sha, sessionId: refSessionId, waveN, label, createdAt });
  }

  snapshots.sort((a, b) => b.waveN - a.waveN);

  if (sessionId) {
    const sanitized = _sanitizeSessionId(sessionId);
    return snapshots.filter((s) => s.sessionId === sanitized);
  }

  return snapshots;
}

// ---------------------------------------------------------------------------
// deleteSnapshot
// ---------------------------------------------------------------------------

/**
 * Delete a single snapshot ref. Idempotent (returns ok:true if ref already gone).
 *
 * @param {Object} opts
 * @param {string} opts.refName — full ref name, e.g. "refs/so-snapshots/sess-123/wave-2-pre"
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function deleteSnapshot({ refName }) {
  const cwd = process.cwd();
  const git = $({ cwd });

  try {
    // git update-ref -d exits 0 whether or not the ref existed.
    await git`git update-ref -d ${refName}`;
    return { ok: true };
  } catch (err) {
    const msg = err && typeof err === 'object' && 'stderr' in err
      ? /** @type {any} */ (err).stderr.trim()
      : String(err);
    return { ok: false, error: `${MODULE}: deleteSnapshot failed for '${refName}' — ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// gcSnapshots
// ---------------------------------------------------------------------------

/**
 * Delete all snapshots whose commit committer-date is older than olderThanDays.
 * Non-throwing; errors per-ref are logged to stderr but don't abort.
 *
 * @param {Object} [opts]
 * @param {number} [opts.olderThanDays=14]
 * @returns {Promise<{ok: boolean, deletedCount: number, scanned: number, error?: string}>}
 */
export async function gcSnapshots({ olderThanDays = 14 } = {}) {
  let snapshots;
  try {
    snapshots = await listSnapshots();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, deletedCount: 0, scanned: 0, error: `${MODULE}: gcSnapshots — listSnapshots failed: ${msg}` };
  }

  const scanned = snapshots.length;
  let deletedCount = 0;
  const now = Date.now();
  const msPerDay = 24 * 60 * 60 * 1000;

  for (const snapshot of snapshots) {
    let ageMs = NaN;
    try {
      ageMs = now - new Date(snapshot.createdAt).getTime();
    } catch {
      // Unparseable date — skip this snapshot.
      console.error(`${MODULE}: gcSnapshots — could not parse createdAt '${snapshot.createdAt}' for ref ${snapshot.ref}, skipping`);
      continue;
    }

    if (isNaN(ageMs)) {
      console.error(`${MODULE}: gcSnapshots — invalid date for ref ${snapshot.ref}, skipping`);
      continue;
    }

    const ageDays = ageMs / msPerDay;
    if (ageDays > olderThanDays) {
      const result = await deleteSnapshot({ refName: snapshot.ref });
      if (result.ok) {
        deletedCount++;
      } else {
        console.error(`${MODULE}: gcSnapshots — failed to delete ${snapshot.ref}: ${result.error}`);
      }
    }
  }

  return { ok: true, deletedCount, scanned };
}
