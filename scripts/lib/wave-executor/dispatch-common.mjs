/**
 * dispatch-common.mjs — shared base for the two foreign-dispatch adapters:
 * `foreign-dispatch.mjs` (Cursor channel, `cursor-agent`) and
 * `remote-dispatch.mjs` (remote-host channel, `offload`). Two adapters, one
 * base (#1204).
 *
 * These six symbols moved here because each one is an enforcement point or a
 * budget constant that must NOT diverge between the two channels: the
 * `never_foreign` role lock, the run-id path-segment validator, the
 * SIGTERM→SIGKILL child runner, and the two dispatch-budget constants. Before
 * this module existed, `remote-dispatch.mjs` imported all five from
 * `foreign-dispatch.mjs` directly — a Cursor-specific file acting as a shared
 * base for a channel that has nothing to do with Cursor. Both adapters now
 * import from here instead, so neither exports something the other must reach
 * through.
 *
 * Revisit-Trigger: if a THIRD dispatch channel ever needs a different budget
 * default or a different never-foreign list, split the constant per-channel
 * at that point rather than overriding it at the call site — a call-site
 * override would silently diverge from the one enforcement point this module
 * exists to be.
 */

/**
 * Roles that may NEVER run on a foreign model. Copied verbatim from
 * account-switch `tools/routing/routing.yaml` § never_foreign (read 2026-08-25).
 * Keep in sync by hand — the YAML lives in a different repo and is parsed there
 * by awk, not by a shared library.
 * @type {readonly string[]}
 */
export const NEVER_FOREIGN_ROLES = Object.freeze([
  'impl-core',
  'security-review',
  'migration',
  'release',
  'secrets',
  'incident',
  'refactor-crosscut',
]);

/** Default wall-clock budget for one foreign dispatch, in seconds.
 * This is a FLOOR, not a suggestion: measured 2026-08-23, `cursor-grok-4.6-high`
 * ran 2 of 3 hard-test tasks past a 540 s cap (recorded as DNF). Lowering this
 * manufactures timeouts and reads as model failure. */
export const DEFAULT_TIMEOUT_SEC = 900;

/**
 * Grace period between SIGTERM and SIGKILL, in ms.
 *
 * `child.kill('SIGTERM')` is a REQUEST: a child that installs a handler and
 * ignores it never emits `close`, and this module's only resolve paths are
 * `close` and `error` — so without escalation a wedged `cursor-agent` hangs
 * `dispatchForeign` forever and takes the whole wave with it. SIGKILL is not
 * catchable, so the escalation always terminates.
 *
 * Named ceiling (BV-004): 10 s is enough for a cooperative child to flush its
 * stream-json tail and exit. Revisit if a well-behaved `cursor-agent` is ever
 * measured needing longer than that to shut down — raise the constant, never
 * drop the escalation.
 */
export const DEFAULT_KILL_GRACE_MS = 10_000;

/** A runId names a directory and a log file. Anything outside this alphabet —
 * or the two relative-path literals the alphabet happens to admit — can escape
 * the parent it is joined to. */
const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

/**
 * @param {unknown} runId
 * @returns {boolean} true when the id is safe to use as a path segment.
 */
export function isSafeRunId(runId) {
  const s = String(runId ?? '');
  if (s === '.' || s === '..') return false; // admitted by SAFE_RUN_ID, still an escape
  return SAFE_RUN_ID.test(s);
}

/**
 * @param {string} role
 * @returns {boolean} true when the role is locked to Claude.
 */
export function isNeverForeignRole(role) {
  return NEVER_FOREIGN_ROLES.includes(String(role || '').trim());
}

/**
 * Run the child process, capturing stdout+stderr merged, with a hand-rolled
 * SIGTERM timeout that ESCALATES to SIGKILL. `spawnFn` is the DI seam so tests
 * never touch the real `cursor-agent` binary.
 *
 * The escalation is the difference between a bounded dispatch and a hung wave:
 * this function's only resolve paths are the child's `close` and `error`
 * events, so a child that ignores SIGTERM never lets the promise settle. See
 * {@link DEFAULT_KILL_GRACE_MS}.
 *
 * @returns {Promise<{capture: string, exitCode: number|null, signal: string|null,
 *   timerFired: boolean, killSignals: string[], errorCode: string|null}>}
 */
export function runChild(cmd, args, options, { spawnFn, timeoutMs, killGraceMs }) {
  return new Promise((resolve) => {
    /** @type {string[]} */
    const killSignals = [];
    let child;
    try {
      child = spawnFn(cmd, args, options);
    } catch (err) {
      resolve({
        capture: `spawn failed: ${err && err.message}`,
        exitCode: null,
        signal: null,
        timerFired: false,
        killSignals,
        errorCode: (err && err.code) || null,
      });
      return;
    }

    let capture = '';
    let timerFired = false;
    let settled = false;
    let errorCode = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let graceTimer = null;

    const onChunk = (chunk) => {
      capture += chunk.toString();
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    const send = (signal) => {
      killSignals.push(signal);
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    };

    const timer = setTimeout(() => {
      timerFired = true;
      send('SIGTERM');
      // SIGTERM is a request; SIGKILL is not. A child that installs a handler
      // and declines to exit would otherwise hang this promise forever.
      graceTimer = setTimeout(() => send('SIGKILL'), killGraceMs);
      graceTimer.unref?.();
    }, timeoutMs);

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ capture, exitCode, signal, timerFired, killSignals, errorCode });
    };

    child.on('error', (err) => {
      errorCode = (err && err.code) || null;
      capture += `\nchild error: ${err && err.message}`;
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal ?? null));
  });
}
