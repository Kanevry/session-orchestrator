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

const EVENTS_PATH = '.orchestrator/metrics/events.jsonl';

/**
 * Emit a single tmux-layout event to events.jsonl.
 * Best-effort — never throws (telemetry must not block the layout itself).
 *
 * @param {string} eventType - 'tmux-layout.invoked' | 'tmux-layout.degraded' | 'tmux-layout.completed'
 * @param {object} [payload] - additional fields (layout, duration_ms, reason, etc.)
 */
export function emit(eventType, payload = {}) {
  try {
    const dir = path.dirname(EVENTS_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const record = {
      event: eventType,
      timestamp: new Date().toISOString(),
      ...payload,
    };
    appendFileSync(EVENTS_PATH, JSON.stringify(record) + '\n');
  } catch {
    // Best-effort — swallow all errors. Telemetry must not block layout.
  }
}

/**
 * Wrap a layout function with telemetry. Emits invoked → completed/degraded.
 *
 * @param {string} layoutName - 'default' | 'debug'
 * @param {Function} fn - async function returning { ok, oneliner, panes, degraded, attachCommand, error? }
 * @returns {Function} wrapped function with same signature
 * @throws {TypeError} synchronously when fn is not a function
 */
export function withTelemetry(layoutName, fn) {
  if (typeof fn !== 'function') {
    throw new TypeError(`withTelemetry: fn must be a function (got ${typeof fn})`);
  }
  return async function telemetryWrapped(...args) {
    const startedAt = Date.now();
    emit('tmux-layout.invoked', { layout: layoutName });
    try {
      const result = await fn(...args);
      const durationMs = Date.now() - startedAt;
      if (result && result.ok === true) {
        emit('tmux-layout.completed', {
          layout: layoutName,
          duration_ms: durationMs,
          panes: result.panes ?? null,
          degraded: result.degraded === true,
        });
      } else {
        emit('tmux-layout.degraded', {
          layout: layoutName,
          duration_ms: durationMs,
          reason: result?.error ?? 'unknown',
        });
      }
      return result;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      emit('tmux-layout.degraded', {
        layout: layoutName,
        duration_ms: durationMs,
        reason: `exception: ${err?.message ?? String(err)}`,
      });
      throw err;
    }
  };
}
