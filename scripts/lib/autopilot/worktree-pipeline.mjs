// scripts/lib/autopilot/worktree-pipeline.mjs
//
// Per-story worktree-isolated loop driver for autopilot --multi-story.
// Wraps single-story runLoop from ./loop.mjs with worktree setup/teardown,
// per-worktree session-lock, and gc-on-exit. DI seams for testability.
//
// References:
//   - docs/prd/2026-05-07-autopilot-phase-d.md (PRD)
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
import fs from 'node:fs';
import { runLoop } from './loop.mjs';
import { maybeCreateDraftMR } from './mr-draft.mjs';
import { validateWorkspacePath } from '../worktree/lifecycle.mjs';
import { acquire, release } from '../session-lock.mjs';
import { main as gcMain } from '../../gc-stale-worktrees.mjs';

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

  const wtPath = path.join(worktreeRoot, repoBasename(repoRoot), String(issueIid));

  // SEC-013 / ADR-364: validate path BEFORE any filesystem write.
  const valid = validateWorkspacePath(wtPath, worktreeRoot);
  if (!valid) {
    throw new WorktreeBoundaryError(
      `worktree-pipeline: computed path '${wtPath}' escapes root '${worktreeRoot}'`,
      { computed: wtPath, root: worktreeRoot },
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
    try {
      release({ sessionId: result._lockSessionId, repoRoot: result.worktreePath });
    } catch (lockErr) {
      console.error(
        `worktree-pipeline: lock release error for issue #${context.issueIid}: ${lockErr?.message ?? String(lockErr)}`,
      );
    }
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
    spiralRecoveryCount: loopState.stall_recovery_count ?? 0,
    commitDependency: null,
    abortedByCohort: loopState.kill_switch === 'peer-abort',
    // Internal: used by teardownWorktree to release the lock.
    _lockSessionId: lockSessionId,
  };

  await teardownWorktree(context, result, { gcOnExit });

  // Re-throw loop errors only after teardown has been attempted.
  if (loopError !== null) {
    throw loopError;
  }

  // Strip internal field before returning to caller.
  const { _lockSessionId: _removed, ...publicResult } = result;

  // Suppress unused-variable lint warning — _removed is intentionally discarded.
  void _removed;

  return publicResult;
}
