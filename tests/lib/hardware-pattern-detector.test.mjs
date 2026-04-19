/**
 * tests/lib/hardware-pattern-detector.test.mjs
 *
 * Vitest suite for scripts/lib/hardware-pattern-detector.mjs (Sub-Epic #160 / #171).
 *
 * Covers: the five signal detectors (oom-kill, heartbeat-gap,
 * concurrent-session-pressure, disk-full, thermal-throttle), aggregation
 * threshold behavior, host_class filtering, and candidate-to-learning shape.
 */

import { describe, it, expect } from 'vitest';
import {
  detectHardwarePatterns,
  aggregateCandidates,
  candidateToLearning,
  DEFAULT_THRESHOLDS,
  HW_SIGNALS,
} from '../../scripts/lib/hardware-pattern-detector.mjs';
import { validateLearning } from '../../scripts/lib/learnings.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOST_M3 = 'macos-arm64-m3pro';
const HOST_LINUX = 'linux-x86_64';

function oom(timestamp, host_class) {
  return {
    event: 'orchestrator.session.stopped',
    timestamp,
    host_class,
    exit_code: 137,
    session: 'abc',
  };
}

function startedWithPeers(timestamp, host_class, peer_count) {
  return {
    event: 'orchestrator.session.started',
    timestamp,
    host_class,
    peer_count,
  };
}

function diskFullEvent(timestamp, host_class, error = 'ENOSPC: no space left on device') {
  return {
    event: 'orchestrator.wave.failed',
    timestamp,
    host_class,
    error,
  };
}

function thermalEvent(timestamp, host_class, pct) {
  return {
    event: 'orchestrator.session.started',
    timestamp,
    host_class,
    resource_snapshot: { cpu_load_pct: pct },
  };
}

function sweepLog(swept_at, host_class, gap_minutes, session_id = 'sid-x') {
  return { swept_at, host_class, gap_minutes, session_id };
}

// ---------------------------------------------------------------------------
// detectHardwarePatterns — high-level
// ---------------------------------------------------------------------------

describe('detectHardwarePatterns — end to end', () => {
  it('returns empty array on empty input', () => {
    expect(detectHardwarePatterns({})).toEqual([]);
  });

  it('aggregates 3 OOM events on same host into one oom-kill candidate', () => {
    const events = [
      oom('2026-04-18T10:00:00Z', HOST_M3),
      oom('2026-04-18T11:00:00Z', HOST_M3),
      oom('2026-04-19T10:00:00Z', HOST_M3),
    ];
    const c = detectHardwarePatterns({ events });
    expect(c.length).toBe(1);
    expect(c[0].type).toBe('hardware-pattern');
    expect(c[0].signal).toBe('oom-kill');
    expect(c[0].host_class).toBe(HOST_M3);
    expect(c[0].occurrences).toBe(3);
    expect(c[0].subject).toBe(`oom-kill::${HOST_M3}`);
  });

  it('separates occurrences across distinct host_class values', () => {
    const events = [
      oom('2026-04-18T10:00:00Z', HOST_M3),
      oom('2026-04-18T11:00:00Z', HOST_M3),
      oom('2026-04-18T12:00:00Z', HOST_LINUX),
      oom('2026-04-19T10:00:00Z', HOST_LINUX),
    ];
    const c = detectHardwarePatterns({ events });
    const subjects = c.map((x) => x.subject).sort();
    expect(subjects).toEqual([`oom-kill::${HOST_LINUX}`, `oom-kill::${HOST_M3}`]);
  });

  it('below threshold: 1 occurrence of OOM emits no candidate', () => {
    const events = [oom('2026-04-18T10:00:00Z', HOST_M3)];
    const c = detectHardwarePatterns({ events });
    expect(c).toEqual([]);
  });

  it('drops hits missing host_class (no anchor = meaningless)', () => {
    const events = [
      oom('2026-04-18T10:00:00Z', null),
      oom('2026-04-18T11:00:00Z', null),
      oom('2026-04-18T12:00:00Z', null),
    ];
    const c = detectHardwarePatterns({ events });
    expect(c).toEqual([]);
  });

  it('acceptance fixture: 3 synthetic OOM events across 2 sessions on same host → detected', () => {
    const events = [
      { ...oom('2026-04-18T10:00:00Z', HOST_M3), session: 'session-1' },
      { ...oom('2026-04-18T10:30:00Z', HOST_M3), session: 'session-1' },
      { ...oom('2026-04-19T14:00:00Z', HOST_M3), session: 'session-2' },
    ];
    const c = detectHardwarePatterns({ events });
    expect(c.length).toBe(1);
    expect(c[0].signal).toBe('oom-kill');
    expect(c[0].occurrences).toBe(3);
    expect(c[0].first_seen).toBe('2026-04-18T10:00:00Z');
    expect(c[0].last_seen).toBe('2026-04-19T14:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// Per-signal behavior
// ---------------------------------------------------------------------------

describe('signal: heartbeat-gap', () => {
  it('emits candidate when gap exceeds threshold', () => {
    const sweepLogEntries = [
      sweepLog('2026-04-19T14:00:00Z', HOST_M3, 120),
      sweepLog('2026-04-19T15:00:00Z', HOST_M3, 90),
    ];
    const c = detectHardwarePatterns({ sweepLogEntries });
    expect(c.length).toBe(1);
    expect(c[0].signal).toBe('heartbeat-gap');
    expect(c[0].occurrences).toBe(2);
  });

  it('ignores gaps below threshold', () => {
    const sweepLogEntries = [
      sweepLog('2026-04-19T14:00:00Z', HOST_M3, 5),
      sweepLog('2026-04-19T15:00:00Z', HOST_M3, 10),
      sweepLog('2026-04-19T16:00:00Z', HOST_M3, 12),
    ];
    const c = detectHardwarePatterns({ sweepLogEntries });
    expect(c).toEqual([]);
  });

  it('threshold override is honored', () => {
    const sweepLogEntries = [
      sweepLog('2026-04-19T14:00:00Z', HOST_M3, 15),
      sweepLog('2026-04-19T15:00:00Z', HOST_M3, 18),
    ];
    const c = detectHardwarePatterns({
      sweepLogEntries,
      thresholds: { heartbeatGapMinutes: 10 },
    });
    expect(c.length).toBe(1);
  });
});

describe('signal: concurrent-session-pressure', () => {
  it('triggers at or above threshold', () => {
    const events = [
      startedWithPeers('2026-04-19T10:00:00Z', HOST_M3, 5),
      startedWithPeers('2026-04-19T11:00:00Z', HOST_M3, 8),
    ];
    const c = detectHardwarePatterns({ events });
    expect(c.length).toBe(1);
    expect(c[0].signal).toBe('concurrent-session-pressure');
  });

  it('ignores events below threshold', () => {
    const events = [
      startedWithPeers('2026-04-19T10:00:00Z', HOST_M3, 2),
      startedWithPeers('2026-04-19T11:00:00Z', HOST_M3, 3),
      startedWithPeers('2026-04-19T12:00:00Z', HOST_M3, 4),
    ];
    const c = detectHardwarePatterns({ events });
    expect(c).toEqual([]);
  });
});

describe('signal: disk-full', () => {
  it('matches ENOSPC text in error field', () => {
    const events = [
      diskFullEvent('2026-04-19T10:00:00Z', HOST_M3),
      diskFullEvent('2026-04-19T11:00:00Z', HOST_M3, 'Error: no space left on device'),
    ];
    const c = detectHardwarePatterns({ events });
    expect(c.length).toBe(1);
    expect(c[0].signal).toBe('disk-full');
  });

  it('does not match unrelated error text', () => {
    const events = [
      { event: 'orchestrator.wave.failed', timestamp: '2026-04-19T10:00:00Z', host_class: HOST_M3, error: 'Type error: cannot read' },
      { event: 'orchestrator.wave.failed', timestamp: '2026-04-19T11:00:00Z', host_class: HOST_M3, error: 'Timeout exceeded' },
    ];
    const c = detectHardwarePatterns({ events });
    expect(c).toEqual([]);
  });
});

describe('signal: thermal-throttle', () => {
  it('emits candidate when cpu_load_pct ≥ threshold', () => {
    const events = [
      thermalEvent('2026-04-19T10:00:00Z', HOST_M3, 85),
      thermalEvent('2026-04-19T11:00:00Z', HOST_M3, 92),
    ];
    const c = detectHardwarePatterns({ events });
    expect(c.length).toBe(1);
    expect(c[0].signal).toBe('thermal-throttle');
  });

  it('ignores events without resource_snapshot or below threshold', () => {
    const events = [
      thermalEvent('2026-04-19T10:00:00Z', HOST_M3, 70),
      { event: 'orchestrator.session.started', timestamp: '2026-04-19T11:00:00Z', host_class: HOST_M3 },
    ];
    const c = detectHardwarePatterns({ events });
    expect(c).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// aggregateCandidates — bookkeeping
// ---------------------------------------------------------------------------

describe('aggregateCandidates', () => {
  it('records first_seen and last_seen correctly regardless of input order', () => {
    const hits = [
      { signal: 'oom-kill', host_class: HOST_M3, timestamp: '2026-04-18T12:00:00Z', raw: {} },
      { signal: 'oom-kill', host_class: HOST_M3, timestamp: '2026-04-18T10:00:00Z', raw: {} },
      { signal: 'oom-kill', host_class: HOST_M3, timestamp: '2026-04-19T09:00:00Z', raw: {} },
    ];
    const c = aggregateCandidates(hits, 2);
    expect(c[0].first_seen).toBe('2026-04-18T10:00:00Z');
    expect(c[0].last_seen).toBe('2026-04-19T09:00:00Z');
  });

  it('keeps at most 3 samples per candidate', () => {
    const hits = Array.from({ length: 7 }, (_, i) => ({
      signal: 'oom-kill',
      host_class: HOST_M3,
      timestamp: `2026-04-19T0${i}:00:00Z`,
      raw: { idx: i },
    }));
    const c = aggregateCandidates(hits, 2);
    expect(c[0].samples.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// candidateToLearning → validateLearning round-trip
// ---------------------------------------------------------------------------

describe('candidateToLearning', () => {
  it('produces a shape that passes validateLearning', () => {
    const candidate = {
      type: 'hardware-pattern',
      subject: `oom-kill::${HOST_M3}`,
      signal: 'oom-kill',
      host_class: HOST_M3,
      occurrences: 3,
      first_seen: '2026-04-18T10:00:00Z',
      last_seen: '2026-04-19T14:00:00Z',
      samples: [{ exit_code: 137 }],
    };
    const entry = candidateToLearning(candidate, {
      id: 'hw-1',
      sessionId: 'test-session',
      createdAt: '2026-04-19T15:00:00Z',
      expiresAt: '2026-05-19T00:00:00Z',
    });
    expect(() => validateLearning(entry)).not.toThrow();
    const v = validateLearning(entry);
    expect(v.type).toBe('hardware-pattern');
    expect(v.scope).toBe('private');
    expect(v.host_class).toBe(HOST_M3);
    expect(v.anonymized).toBe(false);
  });

  it('emits scope=private by default (export step C3 promotes to public)', () => {
    const candidate = {
      type: 'hardware-pattern',
      subject: `thermal-throttle::${HOST_M3}`,
      signal: 'thermal-throttle',
      host_class: HOST_M3,
      occurrences: 2,
      first_seen: '2026-04-19T10:00:00Z',
      last_seen: '2026-04-19T11:00:00Z',
      samples: [],
    };
    const entry = candidateToLearning(candidate, {
      id: 'hw-2',
      sessionId: 's',
      createdAt: '2026-04-19T12:00:00Z',
      expiresAt: '2026-05-19T00:00:00Z',
    });
    expect(entry.scope).toBe('private');
    expect(entry.anonymized).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Constant sanity
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('exports all five signal names', () => {
    expect(HW_SIGNALS).toContain('oom-kill');
    expect(HW_SIGNALS).toContain('heartbeat-gap');
    expect(HW_SIGNALS).toContain('concurrent-session-pressure');
    expect(HW_SIGNALS).toContain('disk-full');
    expect(HW_SIGNALS).toContain('thermal-throttle');
    expect(HW_SIGNALS.length).toBe(5);
  });

  it('DEFAULT_THRESHOLDS has all expected keys', () => {
    expect(DEFAULT_THRESHOLDS.minOccurrences).toBeGreaterThan(0);
    expect(DEFAULT_THRESHOLDS.concurrentSessionsWarn).toBeGreaterThan(0);
    expect(DEFAULT_THRESHOLDS.thermalCpuLoadPct).toBeGreaterThan(0);
    expect(DEFAULT_THRESHOLDS.heartbeatGapMinutes).toBeGreaterThan(0);
  });
});
