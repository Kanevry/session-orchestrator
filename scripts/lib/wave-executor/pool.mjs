/**
 * pool.mjs — Bounded-concurrency worker-pool cursor for wave-executor dispatch.
 *
 * Provides a true cursor-based pull loop for agent dispatch, replacing the
 * existing Promise.all() fan-out model when `worker-pool.enabled: true` in
 * Session Config. Agents pull tasks from a shared cursor so at most
 * `maxParallel` workers are active at any moment — forward-compatible with
 * resource-gate decisions (#193).
 *
 * Issue: #415
 *
 * Exports:
 *   runWavePool(opts) → Promise<{results: Array, errors: Array}>
 *
 * AbortSignal behaviour:
 *   When the caller's abortSignal fires, each in-flight worker is sent a
 *   per-worker AbortController.abort(). No new tasks are pulled. The function
 *   drains for up to `drainTimeoutMs` before returning partial results.
 *
 * Error semantics:
 *   A single failing task never cascades — remaining workers continue pulling
 *   until the cursor is exhausted. Failed tasks accumulate in `errors`.
 */

// ---------------------------------------------------------------------------
// Types (JSDoc only — no TypeScript at runtime)
// ---------------------------------------------------------------------------

/**
 * @typedef {{ taskId: string, dispatch: () => Promise<*> }} PoolTask
 *
 * @typedef {{
 *   tasks: PoolTask[],
 *   maxParallel: number,
 *   abortSignal?: AbortSignal,
 *   drainTimeoutMs?: number,
 *   onTaskStart?: (taskId: string) => void,
 *   onTaskComplete?: (taskId: string, result: *, error: Error|null) => void,
 * }} PoolOptions
 *
 * @typedef {{
 *   results: Array<{ taskId: string, result: * }>,
 *   errors: Array<{ taskId: string, error: Error }>,
 * }} PoolResult
 */

/** Default drain timeout (ms) when an abort signal fires mid-run. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// runWavePool
// ---------------------------------------------------------------------------

/**
 * Execute `tasks` with at most `maxParallel` concurrent workers.
 *
 * Workers pull tasks from a shared cursor — this is a genuine cursor model,
 * not Promise.all(tasks.map(...)).  Each worker loop:
 *   1. Picks up the next unstarted task (atomic cursor advance).
 *   2. Awaits task.dispatch().
 *   3. Records result/error.
 *   4. Repeats until cursor is exhausted.
 *
 * When `abortSignal.aborted` is true (or fires during execution), the pool
 * stops pulling new tasks and each in-flight worker receives its own
 * AbortController abort.  The pool then waits up to `drainTimeoutMs` for
 * workers to settle before returning partial results.
 *
 * @param {PoolOptions} opts
 * @returns {Promise<PoolResult>}
 */
export async function runWavePool({
  tasks,
  maxParallel,
  abortSignal,
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  onTaskStart,
  onTaskComplete,
}) {
  // ── Input validation ──────────────────────────────────────────────────────

  if (!Array.isArray(tasks)) {
    throw new TypeError('runWavePool: tasks must be an array');
  }
  if (typeof maxParallel !== 'number' || !Number.isInteger(maxParallel) || maxParallel < 1) {
    throw new TypeError('runWavePool: maxParallel must be a positive integer');
  }
  if (typeof drainTimeoutMs !== 'number' || drainTimeoutMs < 0) {
    throw new TypeError('runWavePool: drainTimeoutMs must be a non-negative number');
  }

  // ── Fast path: empty tasks ─────────────────────────────────────────────────

  if (tasks.length === 0) {
    return { results: [], errors: [] };
  }

  // ── Shared state (cursor + result accumulators) ───────────────────────────

  let nextIndex = 0;
  /** @type {Map<number, AbortController>} taskIndex → per-worker AbortController */
  const inFlight = new Map();
  /** @type {Array<{ taskId: string, result: * }>} */
  const results = [];
  /** @type {Array<{ taskId: string, error: Error }>} */
  const errors = [];

  // Cap effective concurrency at tasks.length to avoid over-spawn.
  const effective = Math.min(maxParallel, tasks.length);

  // ── Abort handling ─────────────────────────────────────────────────────────

  /**
   * Returns true when the pool should stop pulling new tasks.
   * Checks the caller-supplied AbortSignal (if any).
   */
  function isAborted() {
    return abortSignal !== null && abortSignal !== undefined && abortSignal.aborted;
  }

  /**
   * Abort all currently in-flight workers by forwarding to their per-worker
   * AbortControllers.  Called when the caller's abortSignal fires.
   */
  function abortInFlight() {
    for (const controller of inFlight.values()) {
      controller.abort();
    }
  }

  // Register a one-shot listener on the caller's AbortSignal so we react
  // immediately if it fires while workers are running.
  let abortListener = null;
  if (abortSignal !== null && abortSignal !== undefined) {
    abortListener = () => abortInFlight();
    abortSignal.addEventListener('abort', abortListener, { once: true });
  }

  // ── Worker function ───────────────────────────────────────────────────────

  /**
   * A single worker loop.  Pulls tasks from the shared cursor until the
   * cursor is exhausted or the pool is aborted.
   */
  async function worker() {
    while (true) {
      // Stop pulling when aborted.
      if (isAborted()) break;

      // Atomically claim the next task index.
      const taskIndex = nextIndex;
      if (taskIndex >= tasks.length) break; // cursor exhausted
      nextIndex += 1;

      const task = tasks[taskIndex];
      const workerController = new AbortController();
      inFlight.set(taskIndex, workerController);

      // Notify caller that this task is starting.
      if (typeof onTaskStart === 'function') {
        onTaskStart(task.taskId);
      }

      try {
        // Pass the worker's AbortSignal to the dispatch function so callers
        // can propagate cancellation into their child processes.
        const result = await task.dispatch(workerController.signal);
        results.push({ taskId: task.taskId, result });
        if (typeof onTaskComplete === 'function') {
          onTaskComplete(task.taskId, result, null);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        errors.push({ taskId: task.taskId, error });
        if (typeof onTaskComplete === 'function') {
          onTaskComplete(task.taskId, null, error);
        }
        // Single failure: continue the cursor, do NOT cascade abort.
      } finally {
        inFlight.delete(taskIndex);
      }
    }
  }

  // ── Spawn workers ──────────────────────────────────────────────────────────

  // Pre-abort: if the signal already fired before workers started, abort now.
  if (isAborted()) {
    abortInFlight();
  }

  // Worker errors are individual task failures already captured above; we
  // use allSettled so the pool itself never rejects.
  const workerSettle = Promise.allSettled(
    Array.from({ length: effective }, () => worker()),
  );

  // ── Drain with abort-timeout ───────────────────────────────────────────────

  // Normal path: await all workers.
  // Abort path: the abortListener forwards abort to each worker's controller,
  // then we race settle vs. drainTimeoutMs.  Workers that honour their signal
  // exit quickly; those that ignore it are abandoned after the timeout (the
  // Promise is still in-flight but we return whatever results we have).

  let drainTimeoutHandle;
  const drainTimeoutPromise = new Promise((resolve) => {
    drainTimeoutHandle = setTimeout(resolve, drainTimeoutMs);
  });

  if (abortSignal !== null && abortSignal !== undefined) {
    // Race: workers settle OR drain timeout fires after abort.
    // The abortListener (registered earlier) already handles aborting workers
    // when the signal fires.  We just need to bound the wait.
    await Promise.race([workerSettle, drainTimeoutPromise]);
  } else {
    // No abort signal — just wait for all workers to finish.
    await workerSettle;
  }

  clearTimeout(drainTimeoutHandle);

  // ── Cleanup ───────────────────────────────────────────────────────────────

  if (abortListener !== null && abortSignal !== null && abortSignal !== undefined) {
    abortSignal.removeEventListener('abort', abortListener);
  }

  return { results, errors };
}
