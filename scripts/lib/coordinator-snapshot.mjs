// @ts-check
/**
 * coordinator-snapshot.mjs — pre-dispatch coordinator snapshot helpers for session-orchestrator.
 *
 * Saves git stash-format commit objects under refs/so-snapshots/<sessionId>/wave-<N>-<label>
 * without touching the working tree, using `git update-ref` to persist them.
 *
 * `git stash create` alone captures only tracked modifications. It silently ignores
 * `-u`/`--include-untracked` on git 2.53 (the flag is accepted but has no effect on
 * `create` — only `push` and `save` honor it), so any new untracked files produced
 * during a wave were dropped from the snapshot. Fix (#221): after building the
 * tracked stash commit we also build an untracked-tree commit from a temp index and
 * attach it as a third parent, matching git-stash's 3-parent format so
 * `git stash apply` restores both tracked and untracked content on recovery.
 *
 * Part of v3.1.0 env-aware sessions (issue #196).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

/**
 * Build a snapshot commit that captures both tracked changes and untracked files.
 *
 * Strategy:
 *   1. `git stash create` produces a 2-parent commit over tracked/index changes.
 *   2. `_buildUntrackedParent` produces an optional commit whose tree is the set
 *      of untracked, non-gitignored files (done via a temp GIT_INDEX_FILE).
 *   3. If both are present, we splice the untracked commit in as a third parent
 *      of the stash — matching the format `git stash push -u` writes, so
 *      `git stash apply` can restore both tracked and untracked content.
 *   4. If only one is present, return that SHA; if neither, return empty string.
 *
 * @param {ReturnType<typeof $>} git
 * @param {string} cwd
 * @param {string} stashMessage
 * @returns {Promise<string>} snapshot commit SHA or '' if nothing to capture
 */
async function _buildSnapshotCommit(git, cwd, stashMessage) {
  const stashResult = await git`git stash create ${stashMessage}`;
  const trackedSha = stashResult.stdout.trim();
  const untrackedSha = await _buildUntrackedParent(git, cwd, stashMessage);

  if (!trackedSha && !untrackedSha) return '';
  if (!untrackedSha) return trackedSha;
  if (!trackedSha) return untrackedSha;

  // Splice untracked commit as a 3rd parent of the tracked stash commit.
  const trackedTree = (await git`git rev-parse ${trackedSha + '^{tree}'}`).stdout.trim();
  const parentsRaw = (await git`git rev-list --parents -n 1 ${trackedSha}`).stdout.trim().split(' ');
  const [, ...stashParents] = parentsRaw;
  const parentArgs = [];
  for (const p of stashParents) parentArgs.push('-p', p);
  parentArgs.push('-p', untrackedSha);
  const combined = await git`git commit-tree ${trackedTree} ${parentArgs} -m ${stashMessage}`;
  return combined.stdout.trim();
}

/**
 * Build a commit object whose tree contains only the current untracked,
 * non-gitignored files. Returns '' when the tree has no such files.
 *
 * Uses a temporary GIT_INDEX_FILE so the real index and working tree are never
 * touched. The commit has HEAD as its sole parent, matching git-stash's
 * "untracked files on ..." conventions.
 *
 * @param {ReturnType<typeof $>} git
 * @param {string} cwd
 * @param {string} stashMessage — reused as commit subject for provenance
 * @returns {Promise<string>} untracked-commit SHA, or '' if no untracked files
 */
async function _buildUntrackedParent(git, cwd, stashMessage) {
  const lsRes = await git`git ls-files --others --exclude-standard -z`;
  const paths = lsRes.stdout.split('\0').filter(Boolean);
  if (paths.length === 0) return '';

  const tempIndex = path.join(
    os.tmpdir(),
    `so-snap-untracked-${process.pid}-${Date.now()}`,
  );
  const gitIdx = $({
    cwd,
    env: { ...process.env, GIT_INDEX_FILE: tempIndex },
  });
  gitIdx.verbose = false;
  gitIdx.quiet = true;

  try {
    // `read-tree --empty` initializes the temp index file.
    await gitIdx`git read-tree --empty`;
    await gitIdx`git update-index --add -- ${paths}`;
    const treeSha = (await gitIdx`git write-tree`).stdout.trim();
    if (!treeSha) return '';
    const head = (await git`git rev-parse HEAD`).stdout.trim();
    const subject = `untracked files on ${stashMessage}`;
    const commitRes = await git`git commit-tree ${treeSha} -p ${head} -m ${subject}`;
    return commitRes.stdout.trim();
  } finally {
    try {
      await fs.unlink(tempIndex);
    } catch {
      // Temp index may never have been created if read-tree failed — ignore.
    }
  }
}

// ---------------------------------------------------------------------------
// saveSnapshot
// ---------------------------------------------------------------------------

/**
 * Create a git-stash commit object and save it under refs/so-snapshots/<sessionId>/wave-<N>-<label>.
 * No-op when working tree is clean (no uncommitted changes). Does NOT touch the working tree
 * (uses `git stash create -u` which produces a commit object including untracked files
 * without modifying files). The `-u` flag is load-bearing — without it, untracked files
 * generated between waves (e.g. new test files) are silently dropped from the snapshot
 * and cannot be recovered on crash resume (#221).
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

    // Step 2: Build the snapshot commit without modifying the working tree.
    // Tracked changes come from `git stash create`; untracked files are attached
    // via a third parent commit built from a temp index (see _buildUntrackedParent).
    const sanitized = _sanitizeSessionId(sessionId);
    const stashMessage = `so-snapshot ${sessionId} wave ${waveN} ${label}`;
    const sha = await _buildSnapshotCommit(git, cwd, stashMessage);

    if (!sha) {
      // Race condition guard: status showed changes but git stash create produced
      // nothing and there are no untracked files — treat as clean.
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

  let output;
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
    let ageMs;
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
