/**
 * hardware-pattern-detector.mjs — v3.1.0 hardware-pattern detection.
 *
 * Part of Sub-Epic #160 / Epic #157. Issue #171 (C2).
 *
 * Extracts `hardware-pattern` learning candidates from session + event history.
 * Detection signals (all key on host_class rather than project):
 *
 *   1. oom-kill      — stop events with exitCode 137 or "Out of memory" marker
 *   2. heartbeat-gap — registry sweep.log entries for the same host
 *                      (session disappeared without a clean stop — freeze proxy)
 *   3. concurrent-session-pressure — session-start events inside a start wave:
 *                      `recent_starts_count` (foreign starts in the last 5 min,
 *                      emitted since #1650) >= startWaveMin. Re-aimed in #1654
 *                      off `peer_count`, a standing state (see the detector).
 *   4. disk-full     — events with ENOSPC / "no space left" markers
 *   5. thermal-throttle — sustained high CPU load + unexpected slow-wave marker
 *
 * The detector is additive and idempotent. It produces CANDIDATES; the /evolve
 * analyze flow still runs them through the standard dedupe + user-confirmation
 * pipeline before they reach learnings.jsonl. Candidates are emitted with
 * scope='private' by default (in-repo safe); export (C3) elevates them to
 * scope='public' only after an anonymization pass.
 */

// ---------------------------------------------------------------------------
// Thresholds (defaults; caller can override via opts.thresholds)
// ---------------------------------------------------------------------------

export const DEFAULT_THRESHOLDS = Object.freeze({
  /** Minimum recurrence for a candidate to be emitted (same host_class). */
  minOccurrences: 2,
  /**
   * Minimum `recent_starts_count` (foreign session starts in the 5 min before
   * this start) to count as concurrent-session pressure. Mirrors START_WAVE_MIN
   * in hooks/on-session-start.mjs (#1650). Replaces `concurrentSessionsWarn`
   * (#1654), which was compared against `peer_count`; a caller still passing
   * that key is ignored on purpose rather than silently fed the old meaning.
   */
  startWaveMin: 5,
  /** CPU load percentage that marks a thermal-throttle signal. */
  thermalCpuLoadPct: 85,
  /** Heartbeat gap threshold in minutes above which a session is "frozen". */
  heartbeatGapMinutes: 30,
});

/** Signal classifiers — narrow enum for candidate subjects. */
export const HW_SIGNALS = Object.freeze([
  'oom-kill',
  'heartbeat-gap',
  'concurrent-session-pressure',
  'disk-full',
  'thermal-throttle',
]);

// ---------------------------------------------------------------------------
// Per-signal detectors — stateless, pure functions over arrays
// ---------------------------------------------------------------------------

/**
 * Terminal turn-event names accepted by the OOM detector.
 *
 * `orchestrator.turn.stopped` is the canonical name; `orchestrator.session.stopped`
 * is the DEPRECATED legacy alias `hooks/on-stop.mjs` still emits beside it
 * (carrying `deprecated: true`) for one deprecation generation. BOTH must be
 * accepted here: every OOM record already on disk carries only the legacy name,
 * so a hard switch would blind this detector to the entire history it exists to
 * mine — and the `≥2 occurrences` aggregation threshold makes that silent
 * (fewer hits, never an error).
 *
 * REMOVAL: drop `'orchestrator.session.stopped'` from this set on 2027-03-06,
 * the date `hooks/on-stop.mjs` stops emitting the legacy name. See
 * `skills/evolve/SKILL.md` § hardware-pattern, which documents the same window.
 */
const OOM_TERMINAL_EVENTS = new Set(['orchestrator.turn.stopped', 'orchestrator.session.stopped']);

function detectOomKill(events) {
  const hits = events.filter((e) => {
    if (!OOM_TERMINAL_EVENTS.has(e.event)) return false;
    if (e.exit_code === 137) return true;
    if (typeof e.error === 'string' && /out of memory|killed/i.test(e.error)) return true;
    return false;
  });
  return hits.map((e) => ({
    signal: 'oom-kill',
    host_class: e.host_class ?? null,
    timestamp: e.timestamp,
    raw: { exit_code: e.exit_code, session: e.session ?? null },
  }));
}

function detectHeartbeatGap(sweepLogEntries, thresholdMin) {
  // sweepLogEntries expected shape: {host_class, session_id, gap_minutes, swept_at}
  return sweepLogEntries
    .filter((e) => typeof e.gap_minutes === 'number' && e.gap_minutes >= thresholdMin)
    .map((e) => ({
      signal: 'heartbeat-gap',
      host_class: e.host_class ?? null,
      timestamp: e.swept_at,
      raw: { gap_minutes: e.gap_minutes, session_id: e.session_id },
    }));
}

/**
 * Fallback wave window for start events that predate the producer writing
 * `recent_starts_window_min` beside `recent_starts_count`. Mirrors the default
 * of `countRecentStarts()` in scripts/lib/session-registry.mjs; the producer's
 * own constant (START_WAVE_WINDOW_MIN in hooks/on-session-start.mjs) is
 * module-private to a hook script and arrives per event instead, so the event
 * field always wins over this value.
 */
const FALLBACK_START_WAVE_WINDOW_MIN = 5;

/**
 * Start-wave detector (#1654). Keyed on `recent_starts_count`, NOT `peer_count`:
 * `peer_count >= 5` held on 880/1305 = 67.4% of M4 and 255/991 = 25.7% of M5
 * starts since 2026-08-24 (#1650) — a standing condition, so every learning
 * derived from it was noise (HR-101). A start wave fired on 2.7% / 5.2%.
 *
 * Events without a numeric `recent_starts_count` (every pre-#1650 record) carry
 * no value on this branch: they are skipped, never read as 0 and never as a hit.
 * The signal name stays `concurrent-session-pressure` so existing learnings'
 * subjects (`concurrent-session-pressure::<host_class>`) remain stable.
 *
 * One hit per WAVE, not per event (#1664): with >= 7 starts in one wave, the
 * 6th and 7th start each see >= 5 foreign starts, so counting events let a
 * single wave satisfy `minOccurrences: 2` on its own. See clusterStartWaves().
 */
function detectConcurrentSessionPressure(events, threshold) {
  const qualifying = events.filter(
    (e) =>
      e.event === 'orchestrator.session.started' &&
      typeof e.recent_starts_count === 'number' &&
      e.recent_starts_count >= threshold,
  );
  return clusterStartWaves(qualifying).map((wave) => ({
    signal: 'concurrent-session-pressure',
    host_class: wave[0].host_class ?? null,
    timestamp: wave[0].timestamp,
    // Peak count of the wave: same `{ recent_starts_count }` sample shape as
    // the per-event hits this replaces.
    raw: { recent_starts_count: Math.max(...wave.map((e) => e.recent_starts_count)) },
  }));
}

/**
 * Cluster qualifying start events into waves, per `host_class` (events without
 * a host share one `null` bucket; aggregateCandidates() drops those hits later).
 * Chain rule: sorted by time, an event joins the current wave when it lies
 * less than the window after the PREVIOUS qualifying event — the window being
 * the span `recent_starts_count` itself looks back over (event field
 * `recent_starts_window_min`, else FALLBACK_START_WAVE_WINDOW_MIN). Events with
 * an unparseable timestamp cannot be placed in any wave and are DROPPED:
 * counting each as its own wave would re-open the per-event over-count.
 *
 * Each wave's hit carries the wave's FIRST timestamp, so downstream
 * `last_seen` means "start of the last wave", not "last qualifying start".
 *
 * Ceiling (BV-004): chaining is unbounded, so qualifying starts that keep
 * arriving less than one window apart for an hour merge into ONE occurrence —
 * a sustained-pressure stretch undercounts rather than overcounts. Revisit if
 * the ledger shows a chained wave on one host spanning more than 30 min, which
 * would mean sustained load, not a burst, and deserves its own count.
 *
 * @param {object[]} qualifying — start events already past the threshold
 * @returns {object[][]} waves, each a non-empty array of events in time order
 */
function clusterStartWaves(qualifying) {
  const byHost = new Map();
  for (const e of qualifying) {
    const key = e.host_class ?? null;
    if (!byHost.has(key)) byHost.set(key, []);
    byHost.get(key).push({ e, ms: Date.parse(e.timestamp) });
  }
  const waves = [];
  for (const list of byHost.values()) {
    const timed = list.filter((x) => Number.isFinite(x.ms)).sort((a, b) => a.ms - b.ms);
    let current = null;
    let prevMs = 0;
    for (const x of timed) {
      const windowMin =
        typeof x.e.recent_starts_window_min === 'number' && x.e.recent_starts_window_min > 0
          ? x.e.recent_starts_window_min
          : FALLBACK_START_WAVE_WINDOW_MIN;
      if (current && x.ms - prevMs < windowMin * 60_000) {
        current.push(x.e);
      } else {
        current = [x.e];
        waves.push(current);
      }
      prevMs = x.ms;
    }
  }
  return waves;
}

function detectDiskFull(events) {
  const hits = events.filter((e) => {
    if (typeof e.error !== 'string') return false;
    return /ENOSPC|no space left|disk full/i.test(e.error);
  });
  return hits.map((e) => ({
    signal: 'disk-full',
    host_class: e.host_class ?? null,
    timestamp: e.timestamp,
    raw: { error: e.error },
  }));
}

function detectThermalThrottle(events, thresholdPct) {
  // Thermal signal: session events carrying cpu_load_pct above threshold
  // sustained (our events include a live snapshot under .resource_snapshot).
  return events
    .filter((e) => {
      const snap = e.resource_snapshot;
      return snap && typeof snap.cpu_load_pct === 'number' && snap.cpu_load_pct >= thresholdPct;
    })
    .map((e) => ({
      signal: 'thermal-throttle',
      host_class: e.host_class ?? null,
      timestamp: e.timestamp,
      raw: { cpu_load_pct: e.resource_snapshot.cpu_load_pct },
    }));
}

// ---------------------------------------------------------------------------
// Aggregation — group individual hits into candidate learnings
// ---------------------------------------------------------------------------

/**
 * Group hits by (signal, host_class), count occurrences, and emit candidates
 * whose count meets the minOccurrences threshold. Hits missing host_class
 * are dropped (a hardware-pattern with no host anchor is meaningless).
 *
 * @param {object[]} hits — per-signal hit objects from detectors
 * @param {number} minOccurrences
 * @returns {object[]} candidate learning records (pre-validation)
 */
export function aggregateCandidates(hits, minOccurrences) {
  const buckets = new Map();
  for (const h of hits) {
    if (!h.host_class) continue;
    const key = `${h.signal}::${h.host_class}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        signal: h.signal,
        host_class: h.host_class,
        occurrences: 0,
        first_seen: h.timestamp,
        last_seen: h.timestamp,
        samples: [],
      };
      buckets.set(key, bucket);
    }
    bucket.occurrences += 1;
    if (h.timestamp < bucket.first_seen) bucket.first_seen = h.timestamp;
    if (h.timestamp > bucket.last_seen) bucket.last_seen = h.timestamp;
    // Keep at most 3 sample payloads to bound candidate size
    if (bucket.samples.length < 3) bucket.samples.push(h.raw);
  }

  const out = [];
  for (const b of buckets.values()) {
    if (b.occurrences < minOccurrences) continue;
    out.push({
      type: 'hardware-pattern',
      subject: `${b.signal}::${b.host_class}`,
      signal: b.signal,
      host_class: b.host_class,
      occurrences: b.occurrences,
      first_seen: b.first_seen,
      last_seen: b.last_seen,
      samples: b.samples,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Detect hardware-pattern candidates from structured session/event history.
 *
 * @param {object}   input
 * @param {object[]} [input.events=[]]          — parsed events.jsonl entries
 * @param {object[]} [input.sweepLogEntries=[]] — parsed registry sweep.log entries
 * @param {object}   [input.thresholds]         — override DEFAULT_THRESHOLDS
 * @returns {object[]} hardware-pattern candidates (type+subject+signal+host_class+occurrences+samples)
 */
export function detectHardwarePatterns({
  events = [],
  sweepLogEntries = [],
  thresholds = {},
} = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };

  const hits = [
    ...detectOomKill(events),
    ...detectHeartbeatGap(sweepLogEntries, t.heartbeatGapMinutes),
    ...detectConcurrentSessionPressure(events, t.startWaveMin),
    ...detectDiskFull(events),
    ...detectThermalThrottle(events, t.thermalCpuLoadPct),
  ];

  return aggregateCandidates(hits, t.minOccurrences);
}

// ---------------------------------------------------------------------------
// Candidate → learning shape (feeds /evolve analyze confirmation pipeline)
// ---------------------------------------------------------------------------

/**
 * Shape a candidate into the learnings.jsonl schema (see scripts/lib/learnings.mjs).
 * Intentionally uses scope='private' — hardware patterns never land as 'public'
 * without a separate anonymization pass (C3).
 *
 * @param {object} candidate — output of detectHardwarePatterns()
 * @param {object} opts
 * @param {string} opts.sessionId          — current session identifier (source_session)
 * @param {string} opts.createdAt          — ISO 8601 string (override for tests)
 * @param {string} opts.expiresAt          — ISO 8601 string (override for tests)
 * @returns {object} learning entry (pre-validation)
 */
export function candidateToLearning(candidate, opts) {
  const insight = `Host class ${candidate.host_class} shows ${candidate.signal} pattern (${candidate.occurrences} occurrences between ${candidate.first_seen} and ${candidate.last_seen}).`;
  const evidence = `signal=${candidate.signal}, host_class=${candidate.host_class}, occurrences=${candidate.occurrences}, samples=${JSON.stringify(candidate.samples)}`;

  return {
    id: opts.id,
    type: 'hardware-pattern',
    subject: candidate.subject,
    insight,
    evidence,
    confidence: 0.5,
    source_session: opts.sessionId,
    created_at: opts.createdAt,
    expires_at: opts.expiresAt,
    scope: 'private',
    host_class: candidate.host_class,
    anonymized: false,
  };
}
