// Session-close breadth (#2164). The ledgers measure native agent lifetimes.
// A workspace sync or a planned wave size supplies no delegated-job interval.
import { readFileSync } from 'node:fs';
import { readJsonlLines } from './io.mjs';

function ledgerRows(path) {
  if (typeof path !== 'string' || !path) return null;
  try {
    return readJsonlLines(readFileSync(path, 'utf8'), { skipInvalid: true });
  } catch {
    return null;
  }
}

function sessionRows(rows, idField, sessionId) {
  return rows.filter(row =>
    row?.[idField] === sessionId && typeof row.agent_id === 'string'
    && row.agent_id.trim() !== '' && row.agent_id !== 'unknown'
    && typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp)));
}

function recordInterval(intervals, id, start, end, windowStart, windowEnd) {
  // Keep instantaneous lifetimes only when their timestamp falls in the window.
  if (end < start || end < windowStart || start >= windowEnd
      || (end === windowStart && start < end)) return;
  start = Math.max(start, windowStart);
  end = Math.min(end, windowEnd);
  if (!(end >= start)) return;
  if (!intervals.has(id)) intervals.set(id, []);
  intervals.get(id).push([start, end]);
}

function durationStart(row, end) {
  return Number.isFinite(row.duration_ms) && row.duration_ms > 0
    ? end - row.duration_ms : NaN;
}

function subagentIntervals(rows, windowStart, windowEnd) {
  const intervals = new Map();
  const starts = new Map();
  rows.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  for (const row of rows) {
    const time = Date.parse(row.timestamp);
    if (row.event === 'start') {
      starts.set(row.agent_id, time);
    } else if (row.event === 'stop') {
      // A stop can survive rotation of its matching start. Exclude the
      // known phantom class (#939), unless we have the actual paired start.
      const start = starts.get(row.agent_id);
      if (start === undefined && row.start_record_found === false
          && row.subagent_transcript_found !== true) continue;
      recordInterval(intervals, row.agent_id, start ?? durationStart(row, time),
        time, windowStart, windowEnd);
      starts.delete(row.agent_id);
    }
  }
  return intervals;
}

function summarize(intervals, duration, sources) {
  const edges = new Map();
  function edge(time, change) {
    edges.set(time, (edges.get(time) ?? 0) + change);
  }
  for (const spans of intervals.values()) {
    // Resumed agents may produce multiple stops, including duplicates.
    // Merge per identity before measuring distinct concurrently running jobs.
    let lastEnd = -Infinity;
    for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
      if (end <= lastEnd) continue;
      edge(Math.max(start, lastEnd), 1);
      edge(end, -1);
      lastEnd = end;
    }
  }

  let previous = 0;
  let active = 0;
  let peak = 0;
  let busy = 0;
  for (const [time, change] of [...edges].sort((a, b) => a[0] - b[0])) {
    if (active > 0) busy += time - previous;
    active += change;
    peak = Math.max(peak, active);
    previous = time;
  }
  return {
    max_concurrent_subagents: sources.length ? peak : null,
    subagent_time_share: sources.length ? busy / duration : null,
    sources,
  };
}

/**
 * Measure observed intervals inside [startedAt, completedAt) for one raw
 * harness session id. The fraction uses wall time, so overlapping jobs count
 * once. Both metrics are lower bounds when lifecycle telemetry is incomplete.
 * A reported total_agents of zero is not timing evidence (e.g. backfills).
 */
export function measureDelegatedBreadth({ subagentPaths = [], eventsFile, sessionId, startedAt, completedAt }) {
  const windowStart = Date.parse(startedAt);
  const windowEnd = Date.parse(completedAt);
  let intervals = new Map();
  const sources = [];
  if (typeof sessionId === 'string' && sessionId.trim() && windowEnd > windowStart) {
    const lifecycle = subagentPaths.map(ledgerRows).filter(rows => rows !== null);
    if (lifecycle.length) sources.push('subagents.jsonl');
    intervals = subagentIntervals(
      lifecycle.flatMap(rows => sessionRows(rows, 'parent_session_id', sessionId)), windowStart, windowEnd);
    // on-stop measures from the sidecar birth time. Prefer a recorded
    // lifecycle for that agent: birth time predates a resume after idle time.
    const pairedIds = new Set(intervals.keys());
    const seenStops = new Set(pairedIds);
    const ledger = ledgerRows(eventsFile) ?? [];
    // If a previous stop rotated away, birthtime could span an idle period.
    const rotation = ledger.find(row => row?.event === 'orchestrator.events.rotated');
    const retainedFrom = rotation ? Date.parse(rotation.timestamp) : -Infinity;
    const events = sessionRows(ledger, 'session_id', sessionId);
    events.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    for (const row of events) {
      if (row.event !== 'orchestrator.agent.stopped' || seenStops.has(row.agent_id)) continue;
      // The sidecar birth time measures only the first invocation. A later
      // stop after a resume would include the idle period between invocations.
      seenStops.add(row.agent_id);
      const end = Date.parse(row.timestamp);
      const start = durationStart(row, end);
      if (row.duration_source === 'meta-birthtime' && start >= retainedFrom) {
        recordInterval(intervals, row.agent_id, start, end, windowStart, windowEnd);
      }
    }
    if (intervals.size > pairedIds.size) sources.push('events.jsonl');
  }
  return summarize(intervals, windowEnd - windowStart, sources);
}
