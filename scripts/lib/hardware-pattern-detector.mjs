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
 *   3. concurrent-session-pressure — session events where peer_count crossed
 *                      the configured concurrent-sessions-warn threshold
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
  /** Minimum peer_count to count as concurrent-session pressure. */
  concurrentSessionsWarn: 5,
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

function detectOomKill(events) {
  const hits = events.filter((e) => {
    if (e.event !== 'orchestrator.session.stopped') return false;
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

function detectConcurrentSessionPressure(events, threshold) {
  return events
    .filter((e) => e.event === 'orchestrator.session.started' && typeof e.peer_count === 'number' && e.peer_count >= threshold)
    .map((e) => ({
      signal: 'concurrent-session-pressure',
      host_class: e.host_class ?? null,
      timestamp: e.timestamp,
      raw: { peer_count: e.peer_count },
    }));
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
    ...detectConcurrentSessionPressure(events, t.concurrentSessionsWarn),
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
