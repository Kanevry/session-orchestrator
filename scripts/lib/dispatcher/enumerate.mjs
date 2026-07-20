/**
 * enumerate.mjs — Candidate-repo enumeration + free/busy resolution.
 *
 * Epic #673 Phase 2 (issue #676, PRD §2 P2.1+P2.2, §4). Enumerates candidate
 * repos below a confinement root (recursive walk, depth-capped — see
 * {@link DEFAULT_MAX_DEPTH}) and resolves each as free or busy via its per-repo
 * `session.lock` v2 lease (heartbeat-based liveness).
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
 *   enumerateCandidates  — walk a startDir up to `maxDepth` levels deep, resolve
 *                          each repo's free/busy status from its lease.
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
 * Default walk depth. `1` = immediate children of the scan root only (the
 * pre-#832 behaviour); `2` additionally covers `<root>/<org>/<repo>`.
 *
 * Measured on the reference host (~/Projects, 2026-07-19; warm dentry cache —
 * a cold first walk costs roughly 10x these figures at either depth):
 *   depth 1 →  1 of 47 repos (2%)   — the real topology is `<org>/<repo>`,
 *                                     so the scan missed 46 repos including
 *                                     session-orchestrator itself.
 *   depth 2 → 45 of 47 repos, ~0.9-1.9ms
 *   depth 3 → 47 of 47 repos, ~8ms (node_modules is pruned, but the extra
 *                                     level still multiplies the node count)
 *                                     for two additional repos, both archived.
 * Depth 2 is therefore the default: it recovers 96% of the host's repos at
 * negligible cost, while depth 3 costs ~8x the walk for two dead repos.
 */
const DEFAULT_MAX_DEPTH = 2;

/** Hard bounds for {@link clampMaxDepth}. Depth 3 is the ceiling by measurement. */
const MIN_MAX_DEPTH = 1;
const MAX_MAX_DEPTH = 3;

/**
 * Directory names never DESCENDED into during the walk.
 *
 * Applied to the descent decision ONLY — never to repo emission — so the
 * depth-1 contract stays byte-identical to the pre-#832 scan (`.orchestrator`,
 * `.claude` etc. are still probed for a `.git` marker at depth 1; they simply
 * have none). `node_modules` is the dominant cost driver at depth 3 and can
 * legitimately contain vendored `.git` directories that are not host repos.
 *
 * @param {string} name — a single path segment (Dirent.name).
 * @returns {boolean} true iff the walk may recurse into this directory.
 */
function shouldDescendInto(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name === 'node_modules') return false;
  // Dot-directories (.git, .claude, .orchestrator, .venv, …) hold no host repos.
  if (name.startsWith('.')) return false;
  return true;
}

/**
 * Normalise a caller-supplied `maxDepth` into the supported 1..3 range.
 * Anything that is not a positive finite number falls back to
 * {@link DEFAULT_MAX_DEPTH} — including `0`, negatives, `NaN`, and non-numbers
 * such as the string `'3'` (no coercion: a string is a caller bug, and silently
 * honouring it would make an unvalidated config value widen the walk).
 *
 * @param {unknown} value
 * @returns {number} an integer in [MIN_MAX_DEPTH, MAX_MAX_DEPTH].
 */
function clampMaxDepth(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_DEPTH;
  const truncated = Math.trunc(value);
  if (truncated <= 0) return DEFAULT_MAX_DEPTH;
  if (truncated < MIN_MAX_DEPTH) return MIN_MAX_DEPTH;
  if (truncated > MAX_MAX_DEPTH) return MAX_MAX_DEPTH;
  return truncated;
}

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
 *   1. Depth-first walk of `startDir`, up to `maxDepth` levels deep (depth 1 =
 *      immediate children). Every directory node is a repo candidate iff
 *      `<node>/.git` exists (dir or file — the file form covers worktrees).
 *   2. Confinement guard (`validatePathInsideProject(nodeAbs, startDir)`) runs
 *      on EVERY node BEFORE it is emitted AND before it is opened — see the
 *      security notes on the walk body below.
 *   3. OPTIONAL secondary source: union with `getCrossRepoProjects()`
 *      config-declared paths (leading `~/` expanded, then confinement-filtered),
 *      deduped by `path.resolve()`. Additive, applied AFTER the FS scan.
 *   4. Resolve free/busy per repo from its `session.lock` lease.
 *
 * A git repo does NOT terminate the descent: on a measured reference host, an
 * org-level directory one level under the confinement root was itself a git
 * repo (a small umbrella notes repo) that CONTAINED 16 independent repos —
 * this plugin's own checkout among them. "A repo's children are not separate
 * repos" is empirically false there, and an early-exit-on-`.git` walk dropped
 * 45 discoverable repos to 29. Pruning is therefore by NAME
 * ({@link shouldDescendInto}), never by `.git` presence.
 *
 * ALL repos are returned (busy ones LISTED, not dropped — downstream rank.mjs
 * filters). Returns a plain serialisable {@link Candidate}[].
 *
 * @param {object} [opts]
 * @param {string} [opts.startDir] — scan root; defaults to {@link getConfinementRoot}().
 * @param {number} [opts.maxDepth] — walk depth, clamped to 1..3; defaults to
 *   {@link DEFAULT_MAX_DEPTH} (2) for anything non-numeric, non-finite, or <= 0.
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
export async function enumerateCandidates({ startDir, now, maxDepth, deps } = {}) {
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
  const depthCap = clampMaxDepth(maxDepth);

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

  // ── 1+2. Depth-capped FS walk, confinement-guarded at every node. ──
  //
  // SECURITY (three load-bearing invariants — do not relax without re-reading
  // validatePathInsideProject at scripts/lib/path-utils.mjs):
  //
  //   (i)  Every node is validated against the ORIGINAL `root`, NEVER against
  //        its own parent. The guard's Phase 2 calls realpathSync, which
  //        resolves EVERY intermediate component — so validating a grandchild
  //        against the original root is both sufficient and complete at any
  //        depth. Re-rooting per level (`validate(grandchild, childDir)`) would
  //        validate a symlinked subtree against ITSELF and defeat the guard.
  //
  //   (ii) The guard runs BEFORE `readdirSync`, not merely before emission.
  //        Pre-#832 the guard ran only after `isGitRepo` passed, which was safe
  //        because a non-repo directory was never opened. Under recursion an
  //        unguarded non-repo directory WOULD be opened, so an `ok:false` node
  //        must be refused for descent as well as for emission.
  //
  //  (iii) The guard call is wrapped in try/catch. path-utils.mjs rethrows any
  //        non-ENOENT realpath error, so a single mode-000 directory under the
  //        scan root would otherwise throw straight out of enumerateCandidates
  //        — and runDispatch (scripts/lib/dispatcher/cli.mjs) has no try/catch
  //        around this call. The walk now validates ~52 nodes instead of 1, so
  //        a throwing guard is treated as "skip this node".
  //
  // Unbounded recursion is impossible: `Dirent.isDirectory()` is false for a
  // symlink-to-directory (verified empirically), so symlink cycles never enter
  // the walk — and `depthCap` bounds it regardless, including for stubbed
  // entries that do not implement isDirectory().
  const walk = (dirAbs, depth) => {
    let entries;
    try {
      entries = readdirSyncFn(dirAbs, { withFileTypes: true });
    } catch {
      // Unreadable/absent directory → this subtree contributes nothing.
      // Siblings and the config-declared secondary source are unaffected.
      return;
    }

    for (const entry of entries) {
      // Only directories can be repos. Dirent.isDirectory() guards against
      // files, sockets, etc. A stubbed entry may not implement isDirectory —
      // fall back to treating it as a directory candidate (the depth cap and
      // existsSync('.git') gate the consequences).
      const isDir = typeof entry?.isDirectory === 'function' ? entry.isDirectory() : true;
      if (!isDir) continue;

      const childAbs = path.join(dirAbs, entry.name);

      // Confinement guard — invariants (i)+(ii)+(iii) above.
      let guard;
      try {
        guard = validatePathInsideProjectFn(childAbs, root);
      } catch {
        continue;
      }
      if (!guard || guard.ok !== true) continue;

      if (isGitRepo(childAbs, existsSyncFn)) addRepo(childAbs);

      // Descent is INDEPENDENT of repo-ness: a repo may contain further repos
      // (the umbrella-repo case documented above). Prune by name only, and only
      // for the descent decision — emission above is untouched, which keeps the
      // depth-1 contract byte-identical to the pre-#832 scan.
      if (depth < depthCap && shouldDescendInto(entry.name)) {
        walk(childAbs, depth + 1);
      }
    }
  };

  walk(root, 1);

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
