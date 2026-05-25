/**
 * scripts/lib/tmux-layout/telemetry-stats.mjs
 *
 * Aggregator stub for /tmux-layout telemetry promotion gate (#563).
 * Reads .orchestrator/metrics/events.jsonl and computes:
 *   - invocation count (total + per layout)
 *   - completion rate (completed / invoked) — promotion gate threshold 80%
 *   - top-K degradation reasons
 *   - meetsPromotionGate boolean (#563 acceptance criterion)
 *
 * Usage:
 *   - Programmatic: `import { computeStats, readTmuxEvents } from './telemetry-stats.mjs'`
 *   - CLI: `node scripts/lib/tmux-layout/telemetry-stats.mjs` (emits JSON to stdout)
 */

import { readFileSync, existsSync } from 'node:fs';

const EVENTS_PATH = '.orchestrator/metrics/events.jsonl';

/**
 * Read events.jsonl and return tmux-layout-related events.
 *
 * @param {string} [eventsPath=.orchestrator/metrics/events.jsonl]
 * @returns {Array<object>}  parsed event records (filtered to tmux-layout.* events)
 */
export function readTmuxEvents(eventsPath = EVENTS_PATH) {
  if (!existsSync(eventsPath)) return [];
  const raw = readFileSync(eventsPath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  return lines
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter((rec) => rec && typeof rec.event === 'string' && rec.event.startsWith('tmux-layout.'));
}

/**
 * Compute promotion-gate stats from tmux-layout events.
 *
 * @param {Array<object>} events  output of readTmuxEvents()
 * @returns {{
 *   invocations: number,
 *   completions: number,
 *   degradations: number,
 *   completionRate: number | null,
 *   byLayout: Record<string, {invoked: number, completed: number, degraded: number}>,
 *   topDegradationReasons: Array<{reason: string, count: number}>,
 *   meetsPromotionGate: boolean
 * }}
 */
export function computeStats(events) {
  const invocations = events.filter((e) => e.event === 'tmux-layout.invoked');
  const completions = events.filter((e) => e.event === 'tmux-layout.completed');
  const degradations = events.filter((e) => e.event === 'tmux-layout.degraded');

  const byLayout = {};
  const bump = (e, key) => {
    const layout = e.layout ?? 'unknown';
    byLayout[layout] ??= { invoked: 0, completed: 0, degraded: 0 };
    byLayout[layout][key]++;
  };
  for (const e of invocations) bump(e, 'invoked');
  for (const e of completions) bump(e, 'completed');
  for (const e of degradations) bump(e, 'degraded');

  const completionRate = invocations.length > 0
    ? completions.length / invocations.length
    : null;

  const reasonCounts = {};
  for (const e of degradations) {
    const reason = e.reason ?? 'unknown';
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  }
  const topDegradationReasons = Object.entries(reasonCounts)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Promotion gate (#563): >= 5 invocations AND completion rate >= 0.80
  const meetsPromotionGate =
    invocations.length >= 5 && (completionRate ?? 0) >= 0.80;

  return {
    invocations: invocations.length,
    completions: completions.length,
    degradations: degradations.length,
    completionRate,
    byLayout,
    topDegradationReasons,
    meetsPromotionGate,
  };
}

// CLI entry-point — emit stats as JSON to stdout when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const events = readTmuxEvents();
  const stats = computeStats(events);
  console.log(JSON.stringify(stats, null, 2));
}
