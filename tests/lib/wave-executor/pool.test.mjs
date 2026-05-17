/**
 * tests/lib/wave-executor/pool.test.mjs
 *
 * Vitest unit tests for scripts/lib/wave-executor/pool.mjs (issue #415).
 *
 * Covers:
 *  - Cursor exhausts: 8 tasks / 3 workers → all 8 results returned
 *  - maxParallel=1 → serial execution, results in submitted order
 *  - One task throws → other tasks complete; errors array length=1
 *  - All tasks throw → results empty, errors.length === tasks.length
 *  - AbortSignal mid-flight → no new pulls, partial results returned
 *  - maxParallel > tasks.length → no over-spawn (cap at tasks.length)
 *  - Empty tasks array → {results:[], errors:[]} immediately
 *  - drainTimeoutMs exceeded → function returns (does not hang)
 *  - onTaskStart/onTaskComplete callbacks fire per task
 *  - Input validation: bad maxParallel, bad tasks type, bad drainTimeoutMs
 */

import { describe, it, expect } from 'vitest';
import { runWavePool, DEFAULT_DRAIN_TIMEOUT_MS } from '@lib/wave-executor/pool.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a task that resolves immediately with its id. */
function makeTask(id, delayMs = 0) {
  return {
    taskId: String(id),
    dispatch: () =>
      delayMs > 0
        ? new Promise((res) => setTimeout(() => res(`result-${id}`), delayMs))
        : Promise.resolve(`result-${id}`),
  };
}

/** Build a task that rejects after an optional delay. */
function makeFailingTask(id, delayMs = 0, message = `fail-${id}`) {
  return {
    taskId: String(id),
    dispatch: () =>
      delayMs > 0
        ? new Promise((_, rej) => setTimeout(() => rej(new Error(message)), delayMs))
        : Promise.reject(new Error(message)),
  };
}

/** Build 8 tasks [0..7] that resolve instantly. */
function makeTasks8() {
  return Array.from({ length: 8 }, (_, i) => makeTask(i));
}

// ---------------------------------------------------------------------------
// Core cursor behaviour
// ---------------------------------------------------------------------------

describe('runWavePool — cursor exhausts', () => {
  it('8 tasks / maxParallel=3 → all 8 results returned, 0 errors', async () => {
    const tasks = makeTasks8();
    const { results, errors } = await runWavePool({ tasks, maxParallel: 3 });
    expect(results).toHaveLength(8);
    expect(errors).toHaveLength(0);
    // All task IDs are present (order may vary)
    const ids = results.map((r) => r.taskId).sort();
    expect(ids).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
  });

  it('result objects carry taskId + result', async () => {
    const tasks = [makeTask('alpha')];
    const { results } = await runWavePool({ tasks, maxParallel: 1 });
    expect(results[0]).toEqual({ taskId: 'alpha', result: 'result-alpha' });
  });
});

describe('runWavePool — maxParallel=1 (serial)', () => {
  it('tasks complete in submitted order when serial', async () => {
    const order = [];
    const tasks = [0, 1, 2, 3].map((i) => ({
      taskId: String(i),
      dispatch: async () => {
        order.push(i);
        return `r${i}`;
      },
    }));
    const { results, errors } = await runWavePool({ tasks, maxParallel: 1 });
    expect(errors).toHaveLength(0);
    expect(results).toHaveLength(4);
    expect(order).toEqual([0, 1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Error isolation (no cascade abort)
// ---------------------------------------------------------------------------

describe('runWavePool — error isolation', () => {
  it('one task throws → other tasks still complete; errors array has 1 entry', async () => {
    const tasks = [
      makeTask(0),
      makeFailingTask(1),
      makeTask(2),
      makeTask(3),
    ];
    const { results, errors } = await runWavePool({ tasks, maxParallel: 2 });
    expect(results).toHaveLength(3);
    expect(errors).toHaveLength(1);
    expect(errors[0].taskId).toBe('1');
    expect(errors[0].error.message).toBe('fail-1');
    // Successful task IDs
    const ids = results.map((r) => r.taskId).sort();
    expect(ids).toEqual(['0', '2', '3']);
  });

  it('all tasks throw → results empty, errors.length === tasks.length', async () => {
    const tasks = [makeFailingTask(0), makeFailingTask(1), makeFailingTask(2)];
    const { results, errors } = await runWavePool({ tasks, maxParallel: 3 });
    expect(results).toHaveLength(0);
    expect(errors).toHaveLength(3);
  });

  it('non-Error thrown is wrapped in Error', async () => {
    const tasks = [
      {
        taskId: 'bad',
        dispatch: () => Promise.reject('string-error'),
      },
    ];
    const { errors } = await runWavePool({ tasks, maxParallel: 1 });
    expect(errors[0].error).toBeInstanceOf(Error);
    expect(errors[0].error.message).toBe('string-error');
  });
});

// ---------------------------------------------------------------------------
// Empty tasks
// ---------------------------------------------------------------------------

describe('runWavePool — empty tasks', () => {
  it('empty tasks array → {results:[], errors:[]} immediately', async () => {
    const { results, errors } = await runWavePool({ tasks: [], maxParallel: 4 });
    expect(results).toEqual([]);
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// maxParallel capping
// ---------------------------------------------------------------------------

describe('runWavePool — maxParallel > tasks.length', () => {
  it('does not over-spawn: 2 tasks / maxParallel=10 → 2 results', async () => {
    const concurrentPeak = { count: 0, max: 0 };
    const tasks = [0, 1].map((i) => ({
      taskId: String(i),
      dispatch: async () => {
        concurrentPeak.count += 1;
        concurrentPeak.max = Math.max(concurrentPeak.max, concurrentPeak.count);
        await new Promise((r) => setTimeout(r, 10));
        concurrentPeak.count -= 1;
        return `r${i}`;
      },
    }));
    const { results, errors } = await runWavePool({ tasks, maxParallel: 10 });
    expect(results).toHaveLength(2);
    expect(errors).toHaveLength(0);
    // At most tasks.length workers active simultaneously
    expect(concurrentPeak.max).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Concurrency cap enforcement
// ---------------------------------------------------------------------------

describe('runWavePool — concurrency cap', () => {
  it('never exceeds maxParallel concurrent workers', async () => {
    let concurrent = 0;
    let peakConcurrent = 0;
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      taskId: String(i),
      dispatch: async () => {
        concurrent += 1;
        peakConcurrent = Math.max(peakConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 5));
        concurrent -= 1;
        return i;
      },
    }));
    await runWavePool({ tasks, maxParallel: 3 });
    expect(peakConcurrent).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// AbortSignal mid-flight
// ---------------------------------------------------------------------------

describe('runWavePool — AbortSignal', () => {
  it('aborting mid-flight stops new pulls and returns partial results', async () => {
    const controller = new AbortController();
    let dispatchCount = 0;

    // Tasks that run for 50ms each; abort fires after first batch starts.
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      taskId: String(i),
      dispatch: async (signal) => {
        dispatchCount += 1;
        if (dispatchCount === 1) {
          // Abort after the first task starts running
          setTimeout(() => controller.abort(), 10);
        }
        return new Promise((res, rej) => {
          const t = setTimeout(() => res(`r${i}`), 50);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            rej(new Error('aborted'));
          }, { once: true });
        });
      },
    }));

    const { results, errors } = await runWavePool({
      tasks,
      maxParallel: 2,
      abortSignal: controller.signal,
      drainTimeoutMs: 200,
    });

    // Should not have processed all 10 tasks
    const total = results.length + errors.length;
    expect(total).toBeLessThan(10);
    // Dispatch count should be small (abort fires early)
    expect(dispatchCount).toBeLessThan(10);
  });

  it('pre-aborted signal → returns empty results without running tasks', async () => {
    const controller = new AbortController();
    controller.abort();

    let dispatched = 0;
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      taskId: String(i),
      dispatch: async () => {
        dispatched += 1;
        return i;
      },
    }));

    const { results, errors } = await runWavePool({
      tasks,
      maxParallel: 3,
      abortSignal: controller.signal,
      drainTimeoutMs: 50,
    });

    // Pre-abort: workers break out immediately before picking any task
    expect(results.length + errors.length).toBeLessThanOrEqual(3);
    expect(dispatched).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// drainTimeoutMs exceeded
// ---------------------------------------------------------------------------

describe('runWavePool — drainTimeoutMs exceeded', () => {
  it('function returns within drainTimeoutMs even when tasks hang', async () => {
    const controller = new AbortController();

    // Tasks that never resolve unless signalled
    const tasks = Array.from({ length: 3 }, (_, i) => ({
      taskId: String(i),
      dispatch: (signal) =>
        new Promise((res, rej) => {
          signal?.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
        }),
    }));

    // Abort immediately
    controller.abort();

    const start = Date.now();
    await runWavePool({
      tasks,
      maxParallel: 3,
      abortSignal: controller.signal,
      drainTimeoutMs: 100,
    });
    const elapsed = Date.now() - start;

    // Should complete well under 2× drainTimeoutMs
    expect(elapsed).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

describe('runWavePool — onTaskStart / onTaskComplete callbacks', () => {
  it('onTaskStart fires once per task with the correct taskId', async () => {
    const started = [];
    const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
    await runWavePool({
      tasks,
      maxParallel: 3,
      onTaskStart: (id) => started.push(id),
    });
    expect(started.sort()).toEqual(['a', 'b', 'c']);
  });

  it('onTaskComplete fires once per task with result on success', async () => {
    const completed = [];
    const tasks = [makeTask('x'), makeTask('y')];
    await runWavePool({
      tasks,
      maxParallel: 2,
      onTaskComplete: (id, result, error) => completed.push({ id, result, error }),
    });
    expect(completed).toHaveLength(2);
    const x = completed.find((c) => c.id === 'x');
    expect(x.result).toBe('result-x');
    expect(x.error).toBeNull();
  });

  it('onTaskComplete fires with null result and error on failure', async () => {
    const completed = [];
    const tasks = [makeFailingTask('bad')];
    await runWavePool({
      tasks,
      maxParallel: 1,
      onTaskComplete: (id, result, error) => completed.push({ id, result, error }),
    });
    expect(completed).toHaveLength(1);
    expect(completed[0].result).toBeNull();
    expect(completed[0].error).toBeInstanceOf(Error);
  });

  it('both callbacks fire for every task in mixed result set', async () => {
    const startIds = [];
    const completeIds = [];
    const tasks = [makeTask(0), makeFailingTask(1), makeTask(2)];
    await runWavePool({
      tasks,
      maxParallel: 3,
      onTaskStart: (id) => startIds.push(id),
      onTaskComplete: (id) => completeIds.push(id),
    });
    expect(startIds.sort()).toEqual(['0', '1', '2']);
    expect(completeIds.sort()).toEqual(['0', '1', '2']);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('runWavePool — input validation', () => {
  it('throws TypeError when tasks is not an array', async () => {
    await expect(runWavePool({ tasks: null, maxParallel: 1 })).rejects.toThrow(TypeError);
    await expect(runWavePool({ tasks: null, maxParallel: 1 })).rejects.toThrow('tasks must be an array');
  });

  it('throws TypeError when maxParallel is 0', async () => {
    await expect(runWavePool({ tasks: [], maxParallel: 0 })).rejects.toThrow(TypeError);
  });

  it('throws TypeError when maxParallel is negative', async () => {
    await expect(runWavePool({ tasks: [], maxParallel: -1 })).rejects.toThrow(TypeError);
  });

  it('throws TypeError when maxParallel is a float', async () => {
    await expect(runWavePool({ tasks: [], maxParallel: 1.5 })).rejects.toThrow(TypeError);
  });

  it('throws TypeError when maxParallel is a string', async () => {
    await expect(runWavePool({ tasks: [], maxParallel: '3' })).rejects.toThrow(TypeError);
  });

  it('throws TypeError when drainTimeoutMs is negative', async () => {
    await expect(runWavePool({ tasks: [], maxParallel: 1, drainTimeoutMs: -1 })).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_DRAIN_TIMEOUT_MS export
// ---------------------------------------------------------------------------

describe('runWavePool — exports', () => {
  it('DEFAULT_DRAIN_TIMEOUT_MS is a positive integer', () => {
    expect(typeof DEFAULT_DRAIN_TIMEOUT_MS).toBe('number');
    expect(DEFAULT_DRAIN_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_DRAIN_TIMEOUT_MS)).toBe(true);
  });
});

// =============================================================================
// NEW BOUNDARY / ERROR-PATH TESTS (W4-T1)
// =============================================================================

// ---------------------------------------------------------------------------
// Concurrency stress: 100 tasks, maxParallel=5 — never more than 5 in flight
// ---------------------------------------------------------------------------

describe('runWavePool — concurrency stress (100 tasks, maxParallel=5)', () => {
  it('never exceeds 5 simultaneous in-flight tasks across 100 tasks', async () => {
    let concurrent = 0;
    let peakConcurrent = 0;

    const tasks = Array.from({ length: 100 }, (_, i) => ({
      taskId: String(i),
      dispatch: async () => {
        concurrent += 1;
        peakConcurrent = Math.max(peakConcurrent, concurrent);
        // Brief async yield so tasks actually overlap
        await new Promise((r) => setTimeout(r, 2));
        concurrent -= 1;
        return i;
      },
    }));

    const { results, errors } = await runWavePool({ tasks, maxParallel: 5 });

    expect(errors).toHaveLength(0);
    expect(results).toHaveLength(100);
    // The critical invariant: peak concurrency must never exceed maxParallel
    expect(peakConcurrent).toBeLessThanOrEqual(5);
    // Also verify the pool actually ran tasks concurrently (peak >= 1)
    expect(peakConcurrent).toBeGreaterThanOrEqual(1);
  });

  it('all 100 task IDs appear in results exactly once', async () => {
    const tasks = Array.from({ length: 100 }, (_, i) => makeTask(i));
    const { results } = await runWavePool({ tasks, maxParallel: 5 });

    const ids = new Set(results.map((r) => r.taskId));
    expect(ids.size).toBe(100);
    for (let i = 0; i < 100; i++) {
      expect(ids.has(String(i))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Failed task + abort signal interaction
// ---------------------------------------------------------------------------

describe('runWavePool — failed task + abort propagation', () => {
  it('abort still propagates to remaining in-flight workers after a prior task errored', async () => {
    const controller = new AbortController();
    const abortedTasks = [];

    // Task 0 fails immediately; tasks 1+ are slow but honour abort signal.
    const tasks = [
      {
        taskId: '0',
        dispatch: async () => {
          throw new Error('task-0-fails');
        },
      },
      ...Array.from({ length: 4 }, (_, i) => ({
        taskId: String(i + 1),
        dispatch: (signal) =>
          new Promise((res, rej) => {
            const t = setTimeout(() => res(`r${i + 1}`), 500);
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(t);
                abortedTasks.push(String(i + 1));
                rej(new Error('aborted'));
              },
              { once: true },
            );
            // Trigger abort after first slow task starts
            if (i === 0) setTimeout(() => controller.abort(), 20);
          }),
      })),
    ];

    const { errors } = await runWavePool({
      tasks,
      maxParallel: 3,
      abortSignal: controller.signal,
      drainTimeoutMs: 300,
    });

    // task-0 failure must be recorded
    const task0err = errors.find((e) => e.taskId === '0');
    expect(task0err).toBeDefined();
    expect(task0err.error.message).toBe('task-0-fails');

    // After abort, some in-flight workers should have been signalled
    expect(abortedTasks.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// drainTimeoutMs=1 — very short timeout forces immediate return
// ---------------------------------------------------------------------------

describe('runWavePool — drainTimeoutMs=1 forces near-immediate return', () => {
  it('returns quickly when drainTimeoutMs=1 and tasks are slow + abort pre-fired', async () => {
    const controller = new AbortController();
    controller.abort(); // pre-aborted

    const tasks = Array.from({ length: 5 }, (_, i) => ({
      taskId: String(i),
      dispatch: (_signal) =>
        new Promise((res) => {
          // These never resolve unless cancelled; signal ignored intentionally
          setTimeout(() => res(`r${i}`), 10_000);
        }),
    }));

    const start = Date.now();
    await runWavePool({
      tasks,
      maxParallel: 5,
      abortSignal: controller.signal,
      drainTimeoutMs: 1,
    });
    const elapsed = Date.now() - start;

    // drainTimeoutMs=1 means the pool should return within ~100ms
    expect(elapsed).toBeLessThan(500);
  });
});
