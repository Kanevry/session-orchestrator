/**
 * enumerate.mjs — Candidate-repo enumeration + free/busy resolution.
 *
 * Epic #673 Phase 2 (issue #676, PRD §2 P2.1+P2.2, §4). Enumerates candidate
 * repos one level below a confinement root and resolves each as free or busy
 * via its per-repo `session.lock` v2 lease (heartbeat-based liveness).
 *
 * Source of truth for free/busy: the same lease semantics as
 * `scripts/lib/vault-status/board-writer.mjs` collectRows —
 *   - live lock   → in-progress (busy)
 *   - dead lock   → force-closed (busy)
 *   - no lock     → frei (free)
 * Busy repos are LISTED, never dropped (PRD: "busy repos listed as such, not
 * selected"). Downstream selection happens in rank.mjs (#677), which consumes
 * the {@link Candidate} contract defined here.
 *
 * Exports:
 *   enumerateCandidates  — scan immediate children of a startDir, resolve each
 *                          repo's free/busy status from its lease.
 *   freeCandidates       — filter helper: keep only `free === true` candidates.
 *
 * No top-level side effects. All filesystem + lock access is dependency-injected
 * (the `deps` arg) so Wave-4 tests can stub a tmpdir fs + fake locks.
 *
 * Plain Node ESM. Named exports. No external deps.
 */

import { readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getConfinementRoot, getCrossRepoProjects } from '../config/cross-repo.mjs';
import { validatePathInsideProject } from '../path-utils.mjs';
import { readLock, isLockLive } from '../session-lock.mjs';

/**
 * @typedef {Object} Candidate
 * @property {string} repoRoot   absolute path
 * @property {string} repoName   path.basename(repoRoot)
 * @property {boolean} free      true iff no live lease
 * @property {'frei'|'in-progress'|'force-closed'} status
 * @property {string|null} heartbeat  lock.last_heartbeat ?? null
 * @property {string|null} sessionId  lock.semantic_session_id ?? lock.session_id ?? null
 */

const STATUS_FREI = 'frei';
const STATUS_IN_PROGRESS = 'in-progress';
const STATUS_FORCE_CLOSED = 'force-closed';

/**
 * Expand a leading `~` to the current user's home directory. Mirrors the helper
 * in board-writer.mjs (a shared extraction is deferred to a later epic). Used to
 * normalise config-declared cross-repo paths that may begin with `~/`.
 *
 * @param {string} p
 * @returns {string}
 */
function expandHome(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Derive free/busy status for a single repo from its session.lock lease.
 * Mirrors board-writer.mjs collectRows semantics exactly:
 *   - live lock   → in-progress (busy)
 *   - dead lock   → force-closed (busy)
 *   - no lock     → frei (free)
 *
 * @param {string} repoRoot — absolute repo path.
 * @param {number} nowMs    — clock seam (ms).
 * @param {object} resolveDeps
 * @param {Function} resolveDeps.readLock     — readLock({repoRoot}) → lock|null.
 * @param {Function} resolveDeps.isLockLive   — isLockLive(lock, nowMs) → boolean.
 * @returns {Candidate}
 */
function resolveCandidate(repoRoot, nowMs, { readLock: readLockFn, isLockLive: isLockLiveFn }) {
  const lock = readLockFn({ repoRoot });
  const live = !!(lock && isLockLiveFn(lock, nowMs));

  let status;
  let free;
  if (live) {
    status = STATUS_IN_PROGRESS;
    free = false;
  } else if (lock) {
    // Lock present but dead lease (heartbeat older than ttl) — busy, not free.
    status = STATUS_FORCE_CLOSED;
    free = false;
  } else {
    status = STATUS_FREI;
    free = true;
  }

  // Fields read straight off the raw lock (null when there is no lock).
  const heartbeat = lock ? (lock.last_heartbeat ?? null) : null;
  const sessionId = lock ? (lock.semantic_session_id ?? lock.session_id ?? null) : null;

  return {
    repoRoot,
    repoName: path.basename(repoRoot),
    free,
    status,
    heartbeat,
    sessionId,
  };
}

/**
 * Test whether a child path is a git repo. A child is a repo iff `<child>/.git`
 * exists as a directory OR a file (the file form covers worktrees + submodules,
 * whose `.git` is a `gitdir:` pointer file rather than a directory).
 *
 * @param {string} childAbs — absolute child path.
 * @param {Function} existsSyncFn — injected existsSync.
 * @returns {boolean}
 */
function isGitRepo(childAbs, existsSyncFn) {
  return existsSyncFn(path.join(childAbs, '.git'));
}

/**
 * Enumerate candidate repos from a starting directory and resolve each as
 * free or busy via its local lease.
 *
 * Algorithm:
 *   1. Scan the IMMEDIATE children (one level deep) of `startDir` that are git
 *      repos (a child is a repo iff `<child>/.git` exists — dir or file).
 *   2. Drop any child failing the confinement guard
 *      (`validatePathInsideProject(childAbs, startDir)`).
 *   3. OPTIONAL secondary source: union with `getCrossRepoProjects()`
 *      config-declared paths (leading `~/` expanded, then confinement-filtered),
 *      deduped by `path.resolve()`. Additive, applied AFTER the FS scan.
 *   4. Resolve free/busy per repo from its `session.lock` lease.
 *
 * ALL repos are returned (busy ones LISTED, not dropped — downstream rank.mjs
 * filters). Returns a plain serialisable {@link Candidate}[].
 *
 * @param {object} [opts]
 * @param {string} [opts.startDir] — scan root; defaults to {@link getConfinementRoot}().
 * @param {number} [opts.now] — clock seam in ms; defaults to Date.now().
 * @param {object} [opts.deps] — dependency-injection seam (Wave-4 testability).
 * @param {Function} [opts.deps.readdirSync]   — node:fs readdirSync.
 * @param {Function} [opts.deps.existsSync]     — node:fs existsSync.
 * @param {Function} [opts.deps.readLock]       — session-lock readLock.
 * @param {Function} [opts.deps.isLockLive]     — session-lock isLockLive.
 * @param {Function} [opts.deps.getCrossRepoProjects] — config-declared paths accessor.
 * @param {Function} [opts.deps.validatePathInsideProject] — confinement guard.
 * @param {Function} [opts.deps.now] — () => ms (overridden by opts.now when set).
 * @returns {Promise<Candidate[]>}
 */
export async function enumerateCandidates({ startDir, now, deps } = {}) {
  const d = deps ?? {};
  const readdirSyncFn = d.readdirSync ?? readdirSync;
  const existsSyncFn = d.existsSync ?? existsSync;
  const readLockFn = d.readLock ?? readLock;
  const isLockLiveFn = d.isLockLive ?? isLockLive;
  const getCrossRepoProjectsFn = d.getCrossRepoProjects ?? getCrossRepoProjects;
  const validatePathInsideProjectFn = d.validatePathInsideProject ?? validatePathInsideProject;
  const nowFn = d.now ?? Date.now;

  const root = (typeof startDir === 'string' && startDir.length > 0)
    ? startDir
    : getConfinementRoot();
  const nowMs = typeof now === 'number' ? now : nowFn();

  // Dedup set keyed by resolved absolute path; preserves first-seen ordering
  // (FS-scan repos first, config-declared additions after).
  const seen = new Set();
  /** @type {string[]} */
  const repoPaths = [];

  const addRepo = (absPath) => {
    const resolved = path.resolve(absPath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    repoPaths.push(resolved);
  };

  // ── 1+2. FS scan of immediate children, confinement-guarded. ──
  let entries;
  try {
    entries = readdirSyncFn(root, { withFileTypes: true });
  } catch {
    // Unreadable/absent startDir → no FS-scanned repos. The config-declared
    // secondary source below may still contribute.
    entries = [];
  }

  for (const entry of entries) {
    // Only directories can be repos. Dirent.isDirectory() guards against files,
    // sockets, etc. A stubbed entry may not implement isDirectory — fall back
    // to treating it as a directory candidate (existsSync('.git') gates anyway).
    const isDir = typeof entry?.isDirectory === 'function' ? entry.isDirectory() : true;
    if (!isDir) continue;

    const childAbs = path.join(root, entry.name);
    if (!isGitRepo(childAbs, existsSyncFn)) continue;

    // Confinement guard: drop anything not strictly inside startDir.
    const guard = validatePathInsideProjectFn(childAbs, root);
    if (!guard || guard.ok !== true) continue;

    addRepo(childAbs);
  }

  // ── 3. Optional secondary source: config-declared cross-repo projects. ──
  let declared;
  try {
    declared = await getCrossRepoProjectsFn();
  } catch {
    declared = [];
  }
  if (Array.isArray(declared)) {
    for (const raw of declared) {
      if (typeof raw !== 'string' || raw.length === 0) continue;
      const expanded = expandHome(raw);
      const abs = path.resolve(expanded);
      // Confinement-filter against the same root as the FS scan.
      const guard = validatePathInsideProjectFn(abs, root);
      if (!guard || guard.ok !== true) continue;
      addRepo(abs);
    }
  }

  // ── 4. Resolve free/busy per repo. ──
  return repoPaths.map((repoRoot) =>
    resolveCandidate(repoRoot, nowMs, { readLock: readLockFn, isLockLive: isLockLiveFn }),
  );
}

/**
 * Filter a candidate list down to the free ones (no live lease).
 *
 * @param {Candidate[]} candidates
 * @returns {Candidate[]}
 */
export function freeCandidates(candidates) {
  if (!Array.isArray(candidates)) return [];
  return candidates.filter((c) => c && c.free === true);
}
