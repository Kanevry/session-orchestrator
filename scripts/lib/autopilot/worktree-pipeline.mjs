// scripts/lib/autopilot/worktree-pipeline.mjs
//
// Per-story worktree-isolated loop driver for autopilot --multi-story.
// Wraps single-story runLoop from ./loop.mjs with worktree setup/teardown,
// per-worktree session-lock, and gc-on-exit. DI seams for testability.
//
// DI seam (#580-DI-001): this module uses an ASYNC `opts.$` (zx) executor seam
// because its worktree primitives — `setupWorktree`, `enterWorktree`,
// `teardownWorktree` — are async (they await `git worktree add` and lazy zx
// imports). This is DELIBERATELY divergent from the SYNCHRONOUS `opts.execFileFn`
// (execFileSync) seam used by the session-end / memory-cleanup helpers
// (`scripts/lib/session-end/worktree-cleanup.mjs`,
//  `scripts/lib/memory-cleanup/worktree-sweep.mjs`), which run in synchronous
// coordinator steps. The seams are kept divergent on purpose — forcing a single
// seam would break the sync/async boundary. Do NOT unify.
//
// References:
//   - "Autopilot Phase D — Per-Story Worktree Pipelines" (#341; archived in the private Meta-Vault) (PRD)
//   - docs/adr/2026-05-10-364-remote-agent-substrate.md (ADR-364)
//   - scripts/lib/autopilot/loop.mjs (substrate: forward-compat params)
//   - scripts/lib/worktree/lifecycle.mjs (substrate: validateWorkspacePath)

// NOTE: zx is imported LAZILY inside functions that need it (see lazyZx() helper).
// Top-level `import { $ as realZx } from 'zx'` caused fork-pool fragility — when this
// module is loaded in a worker fork before tests like tests/lib/worktree/constants.test.mjs
// run, vi.mock('zx', ...) factories in those test files cannot re-route the cached
// import. Pipeline 3848 (commit 1347c7a) failed for this reason. Lazy import preserves
// module-load order isolation. Pattern matches deep-2 #367 DI-seam migration.
import path from 'node:path';
import os from 'node:os';
import fs, { realpathSync } from 'node:fs';
import { runLoop } from './loop.mjs';
import { maybeCreateDraftMR } from './mr-draft.mjs';
import { validateWorkspacePath } from '../worktree/lifecycle.mjs';
import { acquire, release, buildLockOwnerProof } from '../session-lock.mjs';
import { emitEvent } from '../events.mjs';
import { main as gcMain } from '../../gc-stale-worktrees.mjs';
import { SEMANTIC_ID_RE } from '../session-id.mjs';

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/**
 * Per-story context passed through the worktree pipeline.
 *
 * @typedef {object} StoryContext
 * @property {number} issueIid          - GitLab/GitHub issue IID.
 * @property {string} issueTitle        - Issue title (used for draft MR body).
 * @property {string} branchName        - Feature branch to create/reuse.
 * @property {string} repoRoot          - Absolute path to the primary repo.
 * @property {string} parentRunId       - Autopilot run ID of the parent orchestration session.
 * @property {string} [worktreeRoot]    - Override for the worktree root directory.
 * @property {object} [killSwitchOpts]  - Kill-switch overrides forwarded to the inner loop.
 * @property {'off'|'on-loop-start'|'on-green'} [draftMrPolicy] - Draft MR creation policy; default "off".
 * @property {'gitlab'|'github'} [vcs]  - VCS backend; defaults to "gitlab" if absent.
 */

/**
 * Result returned by `runStoryPipeline` after the per-story loop completes.
 *
 * @typedef {object} StoryResult
 * @property {number} issueIid
 * @property {string} worktreePath
 * @property {string} runId
 * @property {string|null} killSwitch
 * @property {string|null} killSwitchDetail
 * @property {number} iterationsCompleted
 * @property {boolean} fallbackToManual  - Mirrors loop.mjs's `fallback_to_manual` (#905): true
 *   when the inner loop broke out with no mode recommendation instead of doing real work.
 *   The caller (autopilot-multi.mjs) MUST NOT treat a true value as a completed loop.
 * @property {number} spiralRecoveryCount
 * @property {string|null} commitDependency
 * @property {boolean} abortedByCohort
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default root directory that contains all per-story worktrees. */
export const WORKTREE_ROOT_DEFAULT = path.join(os.homedir(), '.so-worktrees');

// ---------------------------------------------------------------------------
// Custom error classes
// ---------------------------------------------------------------------------

/**
 * Thrown when the computed worktree path resolves outside the allowed root.
 * Defence-in-depth against path-traversal (CWE-23 / SEC-013).
 */
export class WorktreeBoundaryError extends Error {
  /**
   * @param {string} message
   * @param {{ computed?: string, root?: string }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'WorktreeBoundaryError';
    this.computed = meta.computed ?? null;
    this.root = meta.root ?? null;
  }
}

/**
 * Thrown when a per-worktree session lock cannot be acquired because another
 * process already holds it.
 */
export class WorktreeLockedError extends Error {
  /**
   * @param {string} message
   * @param {{ existingLock?: object, reason?: string }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'WorktreeLockedError';
    this.existingLock = meta.existingLock ?? null;
    this.lockReason = meta.reason ?? null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Derive the repo basename from the repoRoot path.
 * @param {string} repoRoot
 * @returns {string}
 */
function repoBasename(repoRoot) {
  return path.basename(repoRoot);
}

/**
 * Render a worktree path for an event record: repo-relative, never absolute.
 *
 * `events.jsonl` records get quoted into issues and MR descriptions, and this
 * repo mirrors to a PUBLIC GitHub remote — so an absolute worktree path ships
 * the operator's home directory (`/Users/<name>/…`) into a public artefact
 * (#957 finding 3). The forensic value of the field is "WHICH worktree", which
 * the repo-relative form carries in full.
 *
 * Escaping the repo root is expected, not an error: the default worktree root
 * is `~/.so-worktrees`, so the normal output is a `../…` chain. That form is
 * still host-agnostic — `path.relative` strips the COMMON PREFIX, which is
 * exactly where `/Users/<name>` lives.
 *
 * Pure string math: no `realpathSync`, no fs access, cannot throw. This runs on
 * the teardown path where the worktree may already have been removed.
 *
 * Residual, deliberately not defended against: a repo root OUTSIDE the home
 * directory combined with a worktree root INSIDE it (e.g. `/srv/repo` +
 * `~/.so-worktrees`) shares no prefix, so the `../` chain descends back through
 * `Users/<name>/`. That configuration is not reachable from this module's
 * defaults and a heuristic scrub would be less predictable than the plain
 * relative path.
 *
 * @param {string} repoRoot      absolute path to the primary repo
 * @param {string|null|undefined} worktreePath absolute worktree path, if known
 * @returns {string|null} repo-relative path, or null when either input is unusable
 */
export function relativeWorktreePath(repoRoot, worktreePath) {
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) return null;
  // Without a usable base there is no way to strip the host prefix. Report
  // "unknown" rather than fall back to the absolute path this exists to avoid.
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return null;
  return path.relative(repoRoot, worktreePath);
}

// ---------------------------------------------------------------------------
// setupWorktree
// ---------------------------------------------------------------------------

/**
 * Create (or reuse) the per-story git worktree.
 *
 * Path layout: `<worktreeRoot>/<repoBasename>/<issueIid>`
 *
 * Idempotent: if the directory already exists and contains a `.git` file,
 * the existing worktree is reused and `{ wtPath, reused: true }` is returned.
 *
 * @param {StoryContext} context
 * @param {object} [opts]
 * @param {Function} [opts.$] - zx-like template-tag executor (DI seam).
 * @returns {Promise<{ wtPath: string, reused: boolean }>}
 * @throws {WorktreeBoundaryError} when computed path escapes `worktreeRoot`.
 */
export async function setupWorktree(context, opts = {}) {
  const {
    issueIid,
    branchName,
    repoRoot,
    worktreeRoot = WORKTREE_ROOT_DEFAULT,
  } = context;

  const exec = opts.$ ?? (await import('zx')).$;

  // CWE-59 hardening (#375): resolve symlinks in worktreeRoot ONCE so that
  // validateWorkspacePath comparisons use a fully-resolved parent path.
  // macOS gotcha: /var → /private/var, so worktreeRoot must be resolved FIRST,
  // and wtPath must be derived from the resolved root — otherwise the ENOENT
  // fallback path stays as /var/... while resolvedWorktreeRoot is /private/var/...
  // causing legitimate paths to false-reject (mirrors #374 pattern).
  let resolvedWorktreeRoot;
  try {
    resolvedWorktreeRoot = realpathSync(worktreeRoot);
  } catch {
    // worktreeRoot missing — fall back to unresolved; validateWorkspacePath
    // will still catch string-level traversal attempts.
    resolvedWorktreeRoot = worktreeRoot;
  }

  // Compute wtPath from the resolved root so path comparisons are consistent.
  const wtPath = path.join(resolvedWorktreeRoot, repoBasename(repoRoot), String(issueIid));

  // Resolve symlinks in wtPath to prevent symlink-escape between path
  // computation and the eventual git worktree add call.
  // ENOENT is expected when the worktree doesn't exist yet — use raw path.
  let resolvedWtPath;
  try {
    resolvedWtPath = realpathSync(wtPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    resolvedWtPath = wtPath; // path doesn't exist yet — no symlink to resolve
  }

  // SEC-013 / ADR-364: validate resolved path BEFORE any filesystem write.
  const valid = validateWorkspacePath(resolvedWtPath, resolvedWorktreeRoot);
  if (!valid) {
    process.stderr.write(
      `worktree-pipeline: refusing to setup symlink-escape: ${wtPath} → ${resolvedWtPath}\n`,
    );
    throw new WorktreeBoundaryError(
      `worktree-pipeline: computed path '${resolvedWtPath}' escapes root '${resolvedWorktreeRoot}'`,
      { computed: resolvedWtPath, root: resolvedWorktreeRoot },
    );
  }

  // Idempotency: if the worktree already exists, reuse it.
  if (fs.existsSync(wtPath)) {
    const gitFile = path.join(wtPath, '.git');
    if (fs.existsSync(gitFile)) {
      console.error(
        `worktree-pipeline: reusing existing worktree at '${wtPath}' for issue #${issueIid}`,
      );
      return { wtPath, reused: true };
    }
  }

  // Create the worktree. Try origin/main first; fall back to HEAD if absent.
  try {
    await exec`git -C ${repoRoot} worktree add ${wtPath} -b ${branchName} origin/main`;
  } catch {
    // origin/main not available — fall back to HEAD.
    await exec`git -C ${repoRoot} worktree add ${wtPath} -b ${branchName} HEAD`;
  }

  return { wtPath, reused: false };
}

// ---------------------------------------------------------------------------
// teardownWorktree
// ---------------------------------------------------------------------------

/**
 * Tear down the per-story worktree after the loop completes.
 *
 * Behaviour:
 *  - If `result.killSwitch` is `'stall-timeout'`: leave the worktree intact
 *    for retry. Only release the lock.
 *  - Otherwise: call `opts.gcOnExit` to clean up, then release the lock.
 *  - The lock-release outcome is evaluated and emitted as an
 *    `orchestrator.session.lock.released` / `…release_failed` breadcrumb
 *    (`caller: 'worktree-pipeline'`) into the PARENT repo's events stream (#952).
 *  - Errors during teardown are swallowed (logged to stderr). Never re-throws.
 *
 * @param {StoryContext} context
 * @param {StoryResult} result
 * @param {object} [opts]
 * @param {Function} [opts.gcOnExit] - GC driver (DI seam).
 * @returns {Promise<void>}
 */
export async function teardownWorktree(context, result, opts = {}) {
  const {
    repoRoot,
    worktreeRoot = WORKTREE_ROOT_DEFAULT,
  } = context;

  const gcOnExit = opts.gcOnExit ?? gcMain;

  // Preserve the worktree on stall-timeout so the caller can retry.
  const preserve = result.killSwitch === 'stall-timeout';

  if (!preserve) {
    try {
      await gcOnExit({
        apply: true,
        worktreeRoot,
        repoRoot,
        dryRun: false,
        argv: [],
      });
    } catch (gcErr) {
      console.error(
        `worktree-pipeline: gc teardown error for issue #${context.issueIid}: ${gcErr?.message ?? String(gcErr)}`,
      );
    }
  }

  // Always attempt to release the per-worktree lock.
  if (result._lockSessionId) {
    /** @type {{ ok: boolean, deleted?: boolean, reason?: string, verified?: boolean }|null} */
    let releaseResult = null;
    try {
      // #987 defense-in-depth: pass the in-memory genesis proof (captured by
      // runStoryPipeline right after acquire — same process, no file I/O)
      // so the delete is double-gated at the fs layer. `_lockOwnerProof` is
      // null/undefined when the lock could not yield a full proof; release()
      // gates on `proof != null` (#989) and degrades to the session_id-only
      // path for that case, so no call-site guard is needed.
      releaseResult = release({
        sessionId: result._lockSessionId,
        repoRoot: result.worktreePath,
        proof: result._lockOwnerProof,
      });
    } catch (lockErr) {
      console.error(
        `worktree-pipeline: lock release error for issue #${context.issueIid}: ${lockErr?.message ?? String(lockErr)}`,
      );
    }

    // #952 (A) — observability breadcrumb for the SECOND release() call-site.
    // Before this, the call above was fire-and-forget: its structured result was
    // discarded entirely, so a per-worktree lock that failed to release — or
    // that had already vanished — left NO trace anywhere. That is the blind
    // spot behind the "#914 lock disappears in the start chain" class for
    // worktree-isolated runs.
    //
    // Emitted at the CALL-SITE, never inside release(): session-lock.mjs
    // deliberately carries no dependency on events.mjs, and release() is
    // synchronous while emitEvent() is async. `caller` keeps this path
    // distinguishable from hooks/on-session-end.mjs in the single stream.
    //
    // Destination is PINNED to the parent repo (`repoRoot` via the #941
    // `opts.repoRoot` interface — same pattern as scripts/lib/lock-reaper.mjs)
    // rather than the ambient SO_PROJECT_DIR: this pipeline deliberately runs
    // across worktrees with an explicit repoRoot (#219 CWD-drift), and the
    // worktree itself may already have been removed by the gc step above, so
    // its own `.orchestrator/` is not a valid destination.
    const benignAlreadyGone = releaseResult?.ok === true && releaseResult.reason === 'no-lock';
    const releaseFailed = releaseResult === null
      || (!benignAlreadyGone && (releaseResult.ok !== true || releaseResult.deleted !== true));
    try {
      if (releaseFailed) {
        await emitEvent('orchestrator.session.lock.release_failed', {
          session_id: result._lockSessionId,
          reason: releaseResult === null
            ? 'threw'
            : (releaseResult.reason ?? (releaseResult.ok === true ? 'not-deleted' : 'fs-error')),
          caller: 'worktree-pipeline',
          worktree_path: relativeWorktreePath(repoRoot, result.worktreePath),
          issue_iid: context.issueIid,
        }, { repoRoot });
      } else {
        await emitEvent('orchestrator.session.lock.released', {
          session_id: result._lockSessionId,
          caller: 'worktree-pipeline',
          outcome: benignAlreadyGone ? 'already-gone' : 'deleted',
          verified: releaseResult.verified === true,
          worktree_path: relativeWorktreePath(repoRoot, result.worktreePath),
          issue_iid: context.issueIid,
        }, { repoRoot });
      }
    } catch { /* observability is best-effort — teardown must never throw */ }
  }
}

// ---------------------------------------------------------------------------
// runStoryPipeline
// ---------------------------------------------------------------------------

/**
 * Run the full per-story worktree-isolated autopilot loop.
 *
 * Steps:
 *  1. Validate worktree path boundary.
 *  2. Setup worktree (idempotent).
 *  3. Acquire per-worktree session lock.
 *  4. Draft-MR creation hook (policy-gated via `context.draftMrPolicy`).
 *  5. Run the inner autopilot loop.
 *  6. Teardown worktree (or preserve on stall-timeout).
 *  7. Return StoryResult.
 *
 * @param {StoryContext} context
 * @param {object} [opts]
 * @param {Function} [opts.$] - zx-like template-tag executor (DI seam).
 * @param {Function} [opts.loopRunner] - Replaces `runLoop` for testability.
 * @param {Function} [opts.lockAcquire] - Replaces `acquire` for testability.
 * @param {Function} [opts.gcOnExit] - Replaces `gcMain` for testability.
 * @param {Function} [opts.nowMs] - Returns current epoch-ms (DI seam).
 * @param {Function} [opts.draftMrCreator] - Replaces `maybeCreateDraftMR` for testability.
 * @returns {Promise<StoryResult>}
 * @throws {WorktreeBoundaryError} on path-traversal attempt.
 * @throws {WorktreeLockedError} when lock is already held.
 */
export async function runStoryPipeline(context, opts = {}) {
  const {
    issueIid,
    parentRunId,
    killSwitchOpts = {},
  } = context;

  const loopRunner = opts.loopRunner ?? runLoop;
  const lockAcquire = opts.lockAcquire ?? acquire;
  const gcOnExit = opts.gcOnExit ?? gcMain;
  const nowMs = opts.nowMs ?? (() => Date.now());
  const draftMrCreator = opts.draftMrCreator ?? maybeCreateDraftMR; // DI seam: testable replacement for mr-draft module

  // -------------------------------------------------------------------------
  // Step 1+2: Setup worktree (includes path validation).
  // -------------------------------------------------------------------------
  const { wtPath } = await setupWorktree(context, { $: opts.$ });

  // -------------------------------------------------------------------------
  // Step 3: Acquire per-worktree session lock.
  // -------------------------------------------------------------------------
  const lockSessionId = `story-${issueIid}-${nowMs()}`;
  const lockResult = lockAcquire({
    sessionId: lockSessionId,
    mode: 'multi-story-pipeline',
    ttlHours: 2,
    repoRoot: wtPath,
  });

  if (!lockResult.ok) {
    throw new WorktreeLockedError(
      `worktree-pipeline: cannot acquire lock for issue #${issueIid} at '${wtPath}' — reason: ${lockResult.reason}`,
      { existingLock: lockResult.existingLock, reason: lockResult.reason },
    );
  }

  // -------------------------------------------------------------------------
  // Step 4: Draft-MR creation hook (policy-gated; non-blocking).
  // -------------------------------------------------------------------------
  if (context.draftMrPolicy && context.draftMrPolicy !== 'off') {
    try {
      const mrResult = await draftMrCreator({
        vcs: context.vcs ?? 'gitlab',
        issueIid: context.issueIid,
        issueTitle: context.issueTitle,
        branchName: context.branchName,
        parentRunId: context.parentRunId,
        worktreePath: wtPath,
        draftMrPolicy: context.draftMrPolicy,
      });
      // Non-blocking: log result but never throw upward.
      if (mrResult.created) {
        console.error(`[worktree-pipeline] draft MR created: ${mrResult.mrUrl}`);
      } else if (mrResult.existing) {
        console.error(`[worktree-pipeline] draft MR already exists: ${mrResult.mrUrl}`);
      } else if (mrResult.deferred) {
        console.error('[worktree-pipeline] draft MR deferred (policy=on-green); orchestrator triggers later');
      } else if (mrResult.error) {
        console.error(`[worktree-pipeline] draft MR failed (non-fatal): ${mrResult.error}`);
      }
    } catch (err) {
      // Never let MR-draft failure abort the pipeline.
      console.error(`[worktree-pipeline] draft MR threw (non-fatal): ${err.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Step 5: Run the inner loop.
  // -------------------------------------------------------------------------
  let loopState;
  let loopError = null;

  try {
    loopState = await loopRunner({
      mode: 'deep',
      maxSessions: 5,
      parentRunId,
      worktreePath: wtPath,
      ...killSwitchOpts,
    });
  } catch (err) {
    loopError = err;
    // Build a minimal fallback state so teardown can still run.
    loopState = {
      autopilot_run_id: `error-${issueIid}-${nowMs()}`,
      kill_switch: 'failed-wave',
      kill_switch_detail: err?.message ?? String(err),
      iterations_completed: 0,
      fallback_to_manual: false,
      stall_recovery_count: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Step 6: Teardown worktree.
  // -------------------------------------------------------------------------

  /** @type {StoryResult} */
  const result = {
    issueIid,
    worktreePath: wtPath,
    runId: loopState.autopilot_run_id ?? `story-${issueIid}-${nowMs()}`,
    killSwitch: loopState.kill_switch ?? null,
    killSwitchDetail: loopState.kill_switch_detail ?? null,
    iterationsCompleted: loopState.iterations_completed ?? 0,
    fallbackToManual: loopState.fallback_to_manual === true,
    spiralRecoveryCount: loopState.stall_recovery_count ?? 0,
    commitDependency: null,
    abortedByCohort: loopState.kill_switch === 'peer-abort',
    // Internal: used by teardownWorktree to release the lock.
    _lockSessionId: lockSessionId,
    // Internal (#987): in-memory genesis proof for the proof-gated release in
    // teardownWorktree. Same process as the acquire above, so no file I/O is
    // needed — buildLockOwnerProof() returns null on a partial/absent lock
    // (e.g. a DI test stub without a full lock body), and teardown's
    // spread-guard then falls back to the session_id-only release.
    _lockOwnerProof: buildLockOwnerProof(lockResult.lock),
  };

  await teardownWorktree(context, result, { gcOnExit });

  // Re-throw loop errors only after teardown has been attempted.
  if (loopError !== null) {
    throw loopError;
  }

  // Strip internal fields before returning to caller.
  const { _lockSessionId: _removed, _lockOwnerProof: _removedProof, ...publicResult } = result;

  // Suppress unused-variable lint warning — both are intentionally discarded.
  void _removed;
  void _removedProof;

  return publicResult;
}

// ---------------------------------------------------------------------------
// enterWorktree — Worktree-Auto-Promotion (#574, Epic #568 Phase 3.1)
// ---------------------------------------------------------------------------

/** Valid git branch character set — mirrors isValidBranch from session-id.mjs. */
const ENTER_WORKTREE_BRANCH_RE = /^[a-zA-Z0-9._/-]+$/;

/**
 * Create a sibling git worktree for Worktree-Auto-Promotion (#574, Epic #568 P3.1).
 *
 * Path layout: `<basePath>/<basename(repoRoot)>-<sessionId>/`
 *
 * Example:
 *   enterWorktree({
 *     basePath: '/Users/foo/Projects',
 *     sessionId: 'main-2026-05-27-deep-2',
 *     branch: 'main',
 *     repoRoot: '/Users/foo/Projects/myrepo',
 *   })
 *   → /Users/foo/Projects/myrepo-main-2026-05-27-deep-2/
 *
 * This is structurally distinct from `setupWorktree`: setupWorktree creates
 * `<worktreeRoot>/<repoBasename>/<issueIid>` (2-level nested); enterWorktree
 * creates `<basePath>/<repoBasename>-<sessionId>` (sibling, 1-level flat) to
 * satisfy the PRD §3 P3 Gherkin row-1 layout requirement.
 *
 * Idempotency: if the target worktree path already exists and contains `.git`,
 * returns `{ wtPath, reused: true }` without re-running `git worktree add`.
 *
 * Security: applies the same `realpathSync` + `validateWorkspacePath` boundary
 * check as `setupWorktree` (CWE-23 / SEC-013 defence-in-depth). Throws
 * `WorktreeBoundaryError` if the computed path escapes `basePath`.
 *
 * Branch handling: if the branch already exists (verified via
 * `git rev-parse --verify <branch>`), use `git worktree add <wtPath> <branch>`
 * (reuse). Otherwise use `git worktree add -b <branch> <wtPath>` (create new).
 * This differs from `setupWorktree`, which always passes `-b`.
 *
 * @param {object} params
 * @param {string} params.basePath  - Parent directory where the new worktree goes (absolute).
 * @param {string} params.sessionId - Semantic session-ID matching SEMANTIC_ID_RE.
 * @param {string} params.branch    - Branch name (existing or new) matching ENTER_WORKTREE_BRANCH_RE.
 * @param {string} params.repoRoot  - Path to the source git repository (passed explicitly to avoid CWD drift per #219).
 * @param {object} [opts]
 * @param {Function} [opts.$]       - zx-like template-tag executor (DI seam); falls back to lazy `await import('zx')`.
 * @returns {Promise<{ wtPath: string, reused: boolean }>}
 * @throws {TypeError} when any required param is missing or fails validation.
 * @throws {WorktreeBoundaryError} when the computed worktree path escapes `basePath`.
 */
export async function enterWorktree({ basePath, sessionId, branch, repoRoot } = {}, opts = {}) {
  // -------------------------------------------------------------------------
  // Step 1: Input validation (TypeError on any malformed param).
  // -------------------------------------------------------------------------
  if (typeof basePath !== 'string' || basePath.length === 0) {
    throw new TypeError('enterWorktree: basePath must be a non-empty string');
  }
  if (!path.isAbsolute(basePath)) {
    throw new TypeError(`enterWorktree: basePath must be an absolute path (got '${basePath}')`);
  }

  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('enterWorktree: sessionId must be a non-empty string');
  }
  if (!SEMANTIC_ID_RE.test(sessionId)) {
    throw new TypeError(
      `enterWorktree: sessionId '${sessionId}' does not match SEMANTIC_ID_RE`,
    );
  }

  if (typeof branch !== 'string' || branch.length === 0) {
    throw new TypeError('enterWorktree: branch must be a non-empty string');
  }
  if (!ENTER_WORKTREE_BRANCH_RE.test(branch)) {
    throw new TypeError(
      `enterWorktree: branch '${branch}' contains invalid characters (allowed: [a-zA-Z0-9._/-])`,
    );
  }

  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new TypeError('enterWorktree: repoRoot must be a non-empty string');
  }
  if (!path.isAbsolute(repoRoot)) {
    throw new TypeError(`enterWorktree: repoRoot must be an absolute path (got '${repoRoot}')`);
  }
  if (!fs.existsSync(repoRoot)) {
    throw new TypeError(`enterWorktree: repoRoot '${repoRoot}' does not exist`);
  }

  // -------------------------------------------------------------------------
  // Step 2: Lazy zx DI (Pipeline 3848 commit 1347c7a — mandatory for vi.mock).
  // -------------------------------------------------------------------------
  const exec = opts.$ ?? (await import('zx')).$;

  // -------------------------------------------------------------------------
  // Step 3: Path resolution + boundary check (mirrors setupWorktree lines 154-187).
  // -------------------------------------------------------------------------
  let resolvedBasePath;
  try {
    resolvedBasePath = realpathSync(basePath);
  } catch {
    // basePath missing — fall back to unresolved; validateWorkspacePath
    // will still catch string-level traversal attempts.
    resolvedBasePath = basePath;
  }

  // Resolve repoRoot to obtain a stable basename (defends against symlinked repos).
  let resolvedRepoRoot;
  try {
    resolvedRepoRoot = realpathSync(repoRoot);
  } catch {
    resolvedRepoRoot = repoRoot;
  }
  const repoName = path.basename(resolvedRepoRoot);

  const wtPath = path.join(resolvedBasePath, `${repoName}-${sessionId}`);

  // Resolve symlinks in wtPath to prevent symlink-escape between path
  // computation and the eventual git worktree add call.
  let resolvedWtPath;
  try {
    resolvedWtPath = realpathSync(wtPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    resolvedWtPath = wtPath; // path doesn't exist yet — no symlink to resolve
  }

  // SEC-013 / ADR-364: validate resolved path BEFORE any filesystem write.
  const valid = validateWorkspacePath(resolvedWtPath, resolvedBasePath);
  if (!valid) {
    process.stderr.write(
      `enterWorktree: refusing to create symlink-escape: ${wtPath} → ${resolvedWtPath}\n`,
    );
    throw new WorktreeBoundaryError(
      `enterWorktree: computed path '${resolvedWtPath}' escapes basePath '${resolvedBasePath}'`,
      { computed: resolvedWtPath, root: resolvedBasePath },
    );
  }

  // -------------------------------------------------------------------------
  // Step 4: Idempotency — reuse if worktree already exists with .git.
  // -------------------------------------------------------------------------
  if (fs.existsSync(wtPath) && fs.existsSync(path.join(wtPath, '.git'))) {
    return { wtPath, reused: true };
  }

  // -------------------------------------------------------------------------
  // Step 5: Detect whether branch already exists, then `git worktree add`.
  // -------------------------------------------------------------------------
  let branchExists = false;
  try {
    await exec`git -C ${repoRoot} rev-parse --verify ${branch}`;
    branchExists = true;
  } catch {
    // Branch does not exist — fall through to create-new path with `-b`.
  }

  if (branchExists) {
    await exec`git -C ${repoRoot} worktree add ${wtPath} ${branch}`;
  } else {
    await exec`git -C ${repoRoot} worktree add -b ${branch} ${wtPath}`;
  }

  // -------------------------------------------------------------------------
  // Step 6: WARN to stderr (PRD §3 P3 Gherkin row-1 + #574 DoD).
  // -------------------------------------------------------------------------
  console.warn(
    `enterWorktree: created sibling worktree at ${wtPath} (branch=${branch}, sessionId=${sessionId})`,
  );

  return { wtPath, reused: false };
}
