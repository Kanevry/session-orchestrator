/**
 * scripts/lib/tmux-layout/telemetry-stats.mjs
 *
 * Aggregator stub for /tmux-layout telemetry promotion gate (#563).
 * Reads the events ledger — active file AND every rotated archive (#1407) —
 * and computes:
 *   - invocation count (total + per layout)
 *   - completion rate (completed / invoked) — promotion gate threshold 80%
 *   - top-K degradation reasons
 *   - meetsPromotionGate boolean (#563 acceptance criterion)
 *
 * Usage:
 *   - Programmatic: `import { computeStats, readTmuxEvents } from './telemetry-stats.mjs'`
 *   - CLI: `node scripts/lib/tmux-layout/telemetry-stats.mjs` (emits JSON to stdout)
 */

import path from 'node:path';
import { readEventsWithRotations } from '../events.mjs';
import { isMainModule } from '../is-main-module.mjs';

const EVENTS_PATH = '.orchestrator/metrics/events.jsonl';

/** Every event this module reports on carries this prefix. */
const TMUX_EVENT_PREFIX = 'tmux-layout.';

/**
 * Read the tmux-layout events ACROSS rotation boundaries, together with the
 * honesty verdict of that read.
 *
 * WHY THE ENVELOPE (#1407 acceptance criterion 3): the stats below are an
 * ALL-TIME rate. Reading only the active file silently redefines "all time" as
 * "since the last rotation", and a genuinely missing archive would then look
 * identical to a quiet week. `complete === false` says which of the two it is;
 * the CLI prints it and never computes over a partial set in silence.
 *
 * THREE states (#1423): `complete === null` is a THIRD reading — no source
 * existed at all, so `invocations: 0` is UNMEASURED, not a measured zero, and
 * `meetsPromotionGate: false` below rests on nothing. The CLI names that case
 * separately; folding it into `false` would report a gap nobody found, folding
 * it into `true` would report a measurement nobody took.
 *
 * CEILING (BV-004): `readEventsWithRotations` loads the active file and every
 * archive fully into memory — up to ~60 MB transient at the default
 * `max-size-mb: 10` / `max-backups: 5`. Acceptable here because this is a COLD
 * ops path: a hand-run CLI / promotion-gate check, never a hook and never on
 * the session path. Revisit if this module gains a hot-path caller or if
 * `max-size-mb` is raised past ~100.
 *
 * @param {string} [eventsPath=.orchestrator/metrics/events.jsonl]
 * @returns {{events: Array<object>, complete: boolean|null, gaps: Array<object>,
 *            notices: Array<object>}}
 */
export function readTmuxEventsEnvelope(eventsPath = EVENTS_PATH) {
  const { events, gaps, complete, notices } = readEventsWithRotations(undefined, {
    filePath: eventsPath,
  });
  return {
    events: events.filter(
      (rec) => rec && typeof rec.event === 'string' && rec.event.startsWith(TMUX_EVENT_PREFIX),
    ),
    complete,
    gaps,
    notices: notices ?? [],
  };
}

/**
 * Read the events ledger and return tmux-layout-related events.
 *
 * Thin array-returning view of {@link readTmuxEventsEnvelope} — the shape every
 * existing caller expects. Use the envelope when the completeness of the read
 * matters to the answer.
 *
 * @param {string} [eventsPath=.orchestrator/metrics/events.jsonl]
 * @returns {Array<object>}  parsed event records (filtered to tmux-layout.* events)
 */
export function readTmuxEvents(eventsPath = EVENTS_PATH) {
  return readTmuxEventsEnvelope(eventsPath).events;
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
if (isMainModule(import.meta.url)) {
  const { events, complete, gaps } = readTmuxEventsEnvelope();
  const stats = computeStats(events);
  if (complete === null) {
    // NOT MEASURED — a different sentence from "incomplete" (#1423): no active
    // file and no archive means the zeros below were never observed.
    console.error(
      'WARN: no events source was readable (no active file, no archive) — the stats below are UNMEASURED, not zero',
    );
  } else if (!complete) {
    // A gap, never an empty window: diagnostics on stderr (cli-design.md),
    // the machine-readable verdict in the JSON below.
    const detail = gaps
      .map((g) => `${g.kind}:${path.basename(String(g.archived_as ?? 'unknown'))}`)
      .join(', ');
    console.error(
      `WARN: events ledger incomplete — the all-time rate below is computed over a PARTIAL set (${gaps.length} gap(s): ${detail})`,
    );
  }
  console.log(JSON.stringify({ ...stats, ledgerComplete: complete, ledgerGaps: gaps }, null, 2));
}
