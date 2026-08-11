/**
 * scripts/lib/tmux-layout/telemetry.mjs
 *
 * Telemetry for the /tmux-layout skill — emits structured events to
 * .orchestrator/metrics/events.jsonl for the promotion-gate criteria
 * defined in GitLab #563 and docs/adr/0007-tmux-visualization-substrate.md.
 *
 * Three event types:
 *   - tmux-layout.invoked    — fires before layout function runs
 *   - tmux-layout.completed  — fires after layout function returns ok
 *   - tmux-layout.degraded   — fires when layout returns ok:false OR throws
 *
 * Promotion gate (#563): invocation count >= 5 across >= 3 distinct deep
 * sessions over >= 2 calendar weeks, layout-completion rate >= 80%, zero
 * AUQ-001 / PSA-003 regressions. See ADR-0007 § Follow-ups.
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

import { findProjectRoot } from '../common.mjs';

/**
 * Path FRAGMENT joined against a resolved repo root at write time — NOT a
 * relative path constant. A relative constant resolves against process.cwd(),
 * which is how ~8k test-emitted tmux events landed in the real ledger: the
 * suite spawns scripts/tmux-layout.mjs with cwd = repo root, so every
 * telemetry write went straight into production telemetry.
 * Same shape as scripts/lib/session-close-backfill.mjs § EVENTS_REL.
 */
const EVENTS_REL = ['.orchestrator', 'metrics', 'events.jsonl'];

/**
 * True when this process is a vitest run, or a child spawned by one
 * (vitest sets VITEST=true and the child inherits process.env).
 * @returns {boolean}
 */
function isTestRunner() {
  return Boolean(process.env.VITEST) || process.env.VITEST_WORKER_ID !== undefined;
}

/**
 * Emit a single tmux-layout event to <repoRoot>/.orchestrator/metrics/events.jsonl.
 * Best-effort — never throws (telemetry must not block the layout itself).
 *
 * Under a test runner an emit WITHOUT an explicit `repoRoot` is dropped: a test
 * process has no business appending to a real ledger, and telemetry is
 * best-effort by contract, so dropping is the correct degradation. Tests that
 * assert on the write pass `repoRoot` and get the full write path.
 *
 * @param {string} eventType - 'tmux-layout.invoked' | 'tmux-layout.degraded' | 'tmux-layout.completed'
 * @param {object} [payload] - additional fields (layout, duration_ms, reason, etc.)
 * @param {{ repoRoot?: string }} [opts] - repoRoot the ledger is resolved against (default: findProjectRoot())
 */
export function emit(eventType, payload = {}, { repoRoot } = {}) {
  try {
    if (!repoRoot && isTestRunner()) return;
    const eventsPath = path.join(repoRoot || findProjectRoot(), ...EVENTS_REL);
    const dir = path.dirname(eventsPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const record = {
      event: eventType,
      timestamp: new Date().toISOString(),
      ...payload,
    };
    appendFileSync(eventsPath, JSON.stringify(record) + '\n');
  } catch {
    // Best-effort — swallow all errors. Telemetry must not block layout.
  }
}

/**
 * Wrap a layout function with telemetry. Emits invoked → completed/degraded.
 *
 * The repoRoot is taken ONLY from this explicit option — never derived from the
 * wrapped call's own `projectRoot` argument. Deriving it would hand the spawned
 * CLI an explicit root inside the test suite and re-open the exact
 * production-ledger contamination path the emit() guard closes.
 *
 * @param {string} layoutName - 'default' | 'debug'
 * @param {Function} fn - async function returning { ok, oneliner, panes, degraded, attachCommand, error? }
 * @param {{ repoRoot?: string }} [opts] - repoRoot the ledger is resolved against (default: findProjectRoot())
 * @returns {Function} wrapped function with same signature
 * @throws {TypeError} synchronously when fn is not a function
 */
export function withTelemetry(layoutName, fn, { repoRoot } = {}) {
  if (typeof fn !== 'function') {
    throw new TypeError(`withTelemetry: fn must be a function (got ${typeof fn})`);
  }
  return async function telemetryWrapped(...args) {
    const startedAt = Date.now();
    emit('tmux-layout.invoked', { layout: layoutName }, { repoRoot });
    try {
      const result = await fn(...args);
      const durationMs = Date.now() - startedAt;
      if (result && result.ok === true) {
        emit('tmux-layout.completed', {
          layout: layoutName,
          duration_ms: durationMs,
          panes: result.panes ?? null,
          degraded: result.degraded === true,
        }, { repoRoot });
      } else {
        emit('tmux-layout.degraded', {
          layout: layoutName,
          duration_ms: durationMs,
          reason: result?.error ?? 'unknown',
        }, { repoRoot });
      }
      return result;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      emit('tmux-layout.degraded', {
        layout: layoutName,
        duration_ms: durationMs,
        reason: `exception: ${err?.message ?? String(err)}`,
      }, { repoRoot });
      throw err;
    }
  };
}
