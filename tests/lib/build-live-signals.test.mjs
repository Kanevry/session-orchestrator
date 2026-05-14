import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLiveSignals } from '@lib/build-live-signals.mjs';
import { selectMode } from '@lib/mode-selector.mjs';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'bls-test-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/**
 * Write a file, creating intermediate directories if needed.
 */
function writeFixture(relPath, contents) {
  const abs = join(sandbox, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, contents, 'utf8');
  return abs;
}

/**
 * Build path inside sandbox (does NOT create the file).
 */
function sandboxPath(relPath) {
  return join(sandbox, relPath);
}

/** Minimal valid STATE.md with Phase A recommendation fields. */
const VALID_STATE_MD = `---
recommended-mode: deep
top-priorities: [301, 302, 303]
carryover-ratio: 0.4
completion-rate: 0.75
rationale: High carryover from previous session
---

## Current Wave
Wave 1 — Implementation
`;

/** STATE.md with frontmatter but no recommendation keys (pre-v1.1). */
const STATE_MD_NO_RECS = `---
status: active
updated: 2026-04-25T10:00:00Z
---

## Notes
No recommendation fields here.
`;

/** Minimal valid session JSONL line. */
function makeSession(sessionType, completionRate = 0.8) {
  return JSON.stringify({
    session_id: `sess-${Date.now()}-${Math.random()}`,
    session_type: sessionType,
    started_at: '2026-04-25T08:00:00Z',
    completed_at: '2026-04-25T09:00:00Z',
    total_waves: 3,
    waves: [
      { wave: 1, role: 'impl' },
      { wave: 2, role: 'test' },
      { wave: 3, role: 'review' },
    ],
    agent_summary: { complete: 2, partial: 0, failed: 0, spiral: 0 },
    total_agents: 2,
    total_files_changed: 5,
    completion_rate: completionRate,
    schema_version: 1,
  });
}

/** Bootstrap lock content. */
const LOCK_CONTENTS = `# bootstrap.lock
version: 1
tier: deep
archetype: node-minimal
plugin-version: 3.1.0
bootstrapped-at: 2026-04-01T00:00:00Z
`;

/** Three sample learnings. */
const SAMPLE_LEARNINGS = [
  { type: 'scope-guidance', subject: 'deep-selected-for-large-epics', confidence: 0.8 },
  { type: 'effective-sizing', subject: 'agents-per-wave: 2', confidence: 0.9 },
  { type: 'cadence', subject: 'feature-selected-vs-deep', confidence: 0.7 },
];

/** Null-returning scanBacklog stub (no VCS / CLI). */
const nullScanBacklog = async () => null;

/** Returns a fake backlog summary. */
const fakeScanBacklog = async () => ({
  criticalCount: 2,
  highCount: 5,
  staleCount: 1,
  byLabel: { 'priority:critical': 2, 'priority:high': 5 },
  total: 30,
  vcs: 'gitlab',
  limit: 50,
});

// ---------------------------------------------------------------------------
// Graceful-null branch 1: STATE.md absent
// ---------------------------------------------------------------------------

describe('branch 1 — STATE.md absent', () => {
  it('returns null for all five recommendation fields when statePath does not exist', async () => {
    const signals = await buildLiveSignals({
      statePath: sandboxPath('.claude/STATE.md'),
      sessionsPath: sandboxPath('sessions.jsonl'),
      lockPath: sandboxPath('bootstrap.lock'),
      _scanBacklog: nullScanBacklog,
    });

    expect(signals.recommendedMode).toBeNull();
    expect(signals.topPriorities).toBeNull();
    expect(signals.carryoverRatio).toBeNull();
    expect(signals.completionRate).toBeNull();
    expect(signals.previousRationale).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Graceful-null branch 2: STATE.md exists but parseRecommendations returns null
// ---------------------------------------------------------------------------

describe('branch 2 — STATE.md exists, no v1.1 fields', () => {
  it('returns null for all five recommendation fields for pre-v1.1 frontmatter', async () => {
    const statePath = writeFixture('.claude/STATE.md', STATE_MD_NO_RECS);

    const signals = await buildLiveSignals({
      statePath,
      sessionsPath: sandboxPath('sessions.jsonl'),
      lockPath: sandboxPath('bootstrap.lock'),
      _scanBacklog: nullScanBacklog,
    });

    expect(signals.recommendedMode).toBeNull();
    expect(signals.topPriorities).toBeNull();
    expect(signals.carryoverRatio).toBeNull();
    expect(signals.completionRate).toBeNull();
    expect(signals.previousRationale).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Graceful-null branch 3: sessions.jsonl absent
// ---------------------------------------------------------------------------

describe('branch 3 — sessions.jsonl absent', () => {
  it('returns empty recentSessions array when sessionsPath does not exist', async () => {
    const signals = await buildLiveSignals({
      statePath: sandboxPath('.claude/STATE.md'),
      sessionsPath: sandboxPath('sessions.jsonl'),
      lockPath: sandboxPath('bootstrap.lock'),
      _scanBacklog: nullScanBacklog,
    });

    expect(signals.recentSessions).toEqual([]);
    expect(Array.isArray(signals.recentSessions)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Graceful-null branch 4: sessions.jsonl has malformed lines
// ---------------------------------------------------------------------------

describe('branch 4 — malformed sessions.jsonl lines', () => {
  it('skips malformed lines and normalizes valid ones', async () => {
    const validLine = makeSession('feature');
    const content = [
      'not-json{{{',
      validLine,
      '{"broken":',
      makeSession('deep'),
      '',
    ].join('\n');
    const sessionsPath = writeFixture('sessions.jsonl', content);

    const signals = await buildLiveSignals({
      statePath: sandboxPath('.claude/STATE.md'),
      sessionsPath,
      lockPath: sandboxPath('bootstrap.lock'),
      _scanBacklog: nullScanBacklog,
    });

    // 2 valid lines, 2 malformed lines (empty line filtered before parse)
    expect(signals.recentSessions).toHaveLength(2);
    expect(signals.recentSessions[0].session_type).toBe('feature');
    expect(signals.recentSessions[1].session_type).toBe('deep');
  });

  it('returns empty array when every line is malformed', async () => {
    const sessionsPath = writeFixture('sessions.jsonl', 'bad\n{also bad\njunk\n');

    const signals = await buildLiveSignals({
      statePath: sandboxPath('.claude/STATE.md'),
      sessionsPath,
      lockPath: sandboxPath('bootstrap.lock'),
      _scanBacklog: nullScanBacklog,
    });

    expect(signals.recentSessions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Graceful-null branch 5: bootstrap.lock absent vs. present
// ---------------------------------------------------------------------------

describe('branch 5 — bootstrap.lock', () => {
  it('returns null for bootstrapLock when lockPath does not exist', async () => {
    const signals = await buildLiveSignals({
      statePath: sandboxPath('.claude/STATE.md'),
      sessionsPath: sandboxPath('sessions.jsonl'),
      lockPath: sandboxPath('bootstrap.lock'),
      _scanBacklog: nullScanBacklog,
    });

    expect(signals.bootstrapLock).toBeNull();
  });

  it('returns parsed object when lock file is present', async () => {
    const lockPath = writeFixture('bootstrap.lock', LOCK_CONTENTS);

    const signals = await buildLiveSignals({
      statePath: sandboxPath('.claude/STATE.md'),
      sessionsPath: sandboxPath('sessions.jsonl'),
      lockPath,
      _scanBacklog: nullScanBacklog,
    });

    expect(signals.bootstrapLock).not.toBeNull();
    expect(typeof signals.bootstrapLock).toBe('object');
    expect(signals.bootstrapLock['tier']).toBe('deep');
    expect(signals.bootstrapLock['plugin-version']).toBe('3.1.0');
  });
});

// ---------------------------------------------------------------------------
// Graceful-null branch 6: scanBacklog returns null
// ---------------------------------------------------------------------------

describe('branch 6 — scanBacklog null path', () => {
  it('returns null for backlog when scanBacklog returns null', async () => {
    const signals = await buildLiveSignals({
      statePath: sandboxPath('.claude/STATE.md'),
      sessionsPath: sandboxPath('sessions.jsonl'),
      lockPath: sandboxPath('bootstrap.lock'),
      _scanBacklog: nullScanBacklog,
    });

    expect(signals.backlog).toBeNull();
  });

  it('returns backlog summary when scanBacklog returns a real result', async () => {
    const signals = await buildLiveSignals({
      statePath: sandboxPath('.claude/STATE.md'),
      sessionsPath: sandboxPath('sessions.jsonl'),
      lockPath: sandboxPath('bootstrap.lock'),
      _scanBacklog: fakeScanBacklog,
    });

    expect(signals.backlog).not.toBeNull();
    expect(signals.backlog.criticalCount).toBe(2);
    expect(signals.backlog.highCount).toBe(5);
    expect(signals.backlog.total).toBe(30);
    expect(signals.backlog.vcs).toBe('gitlab');
  });
});

// ---------------------------------------------------------------------------
// Happy path: full fixtures
// ---------------------------------------------------------------------------

describe('happy path — all fixtures present', () => {
  it('populates all 10 fields correctly from full fixtures', async () => {
    const statePath = writeFixture('.claude/STATE.md', VALID_STATE_MD);
    const lockPath = writeFixture('bootstrap.lock', LOCK_CONTENTS);

    const sessions = [
      makeSession('feature', 0.9),
      makeSession('deep', 0.8),
      makeSession('feature', 0.7),
      makeSession('housekeeping', 0.95),
      makeSession('deep', 0.85),
    ];
    const sessionsPath = writeFixture('sessions.jsonl', sessions.join('\n'));

    const signals = await buildLiveSignals({
      statePath,
      sessionsPath,
      lockPath,
      learnings: SAMPLE_LEARNINGS,
      _scanBacklog: fakeScanBacklog,
    });

    // State recommendations
    expect(signals.recommendedMode).toBe('deep');
    expect(signals.topPriorities).toEqual([301, 302, 303]);
    expect(signals.carryoverRatio).toBe(0.4);
    expect(signals.completionRate).toBe(0.75);
    expect(signals.previousRationale).toBe('High carryover from previous session');

    // Sessions
    expect(signals.recentSessions).toHaveLength(5);

    // Bootstrap lock
    expect(signals.bootstrapLock).not.toBeNull();
    expect(signals.bootstrapLock['tier']).toBe('deep');

    // Learnings
    expect(signals.learnings).toBe(SAMPLE_LEARNINGS);
    expect(signals.learnings).toHaveLength(3);

    // Backlog
    expect(signals.backlog).not.toBeNull();
    expect(signals.backlog.criticalCount).toBe(2);

    // Reserved
    expect(signals.vaultStaleness).toBeNull();
  });

  it('all 10 expected keys are present in the returned object', async () => {
    const signals = await buildLiveSignals({
      statePath: sandboxPath('.claude/STATE.md'),
      sessionsPath: sandboxPath('sessions.jsonl'),
      lockPath: sandboxPath('bootstrap.lock'),
      _scanBacklog: nullScanBacklog,
    });

    const expectedKeys = [
      'recommendedMode',
      'topPriorities',
      'carryoverRatio',
      'completionRate',
      'previousRationale',
      'recentSessions',
      'bootstrapLock',
      'learnings',
      'backlog',
      'vaultStaleness',
    ];
    for (const key of expectedKeys) {
      expect(key in signals, `key '${key}' must be present`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Lock-in test: output is consumable by selectMode
// ---------------------------------------------------------------------------

describe('lock-in test — selectMode accepts buildLiveSignals output', () => {
  it('selectMode does not throw and returns a valid Recommendation shape (minimal fixtures)', async () => {
    const signals = await buildLiveSignals({
      statePath: sandboxPath('.claude/STATE.md'),
      sessionsPath: sandboxPath('sessions.jsonl'),
      lockPath: sandboxPath('bootstrap.lock'),
      _scanBacklog: nullScanBacklog,
    });

    let rec;
    expect(() => {
      rec = selectMode(signals);
    }).not.toThrow();

    expect(typeof rec.mode).toBe('string');
    expect(typeof rec.rationale).toBe('string');
    expect(typeof rec.confidence).toBe('number');
    expect(Array.isArray(rec.alternatives)).toBe(true);
  });

  it('selectMode returns a valid Recommendation shape with full fixtures', async () => {
    const statePath = writeFixture('.claude/STATE.md', VALID_STATE_MD);
    const lockPath = writeFixture('bootstrap.lock', LOCK_CONTENTS);
    const sessions = [
      makeSession('deep', 0.9),
      makeSession('deep', 0.85),
      makeSession('deep', 0.92),
    ];
    const sessionsPath = writeFixture('sessions.jsonl', sessions.join('\n'));

    const signals = await buildLiveSignals({
      statePath,
      sessionsPath,
      lockPath,
      learnings: SAMPLE_LEARNINGS,
      _scanBacklog: fakeScanBacklog,
    });

    let rec;
    expect(() => {
      rec = selectMode(signals);
    }).not.toThrow();

    const VALID_MODES = ['housekeeping', 'feature', 'deep', 'discovery', 'evolve', 'plan-retro'];
    expect(VALID_MODES).toContain(rec.mode);
    expect(typeof rec.rationale).toBe('string');
    expect(rec.rationale.length).toBeGreaterThan(0);
    expect(rec.rationale.length).toBeLessThanOrEqual(120);
    expect(rec.confidence).toBeGreaterThanOrEqual(0.0);
    expect(rec.confidence).toBeLessThanOrEqual(1.0);
    expect(Array.isArray(rec.alternatives)).toBe(true);
    for (const alt of rec.alternatives) {
      expect(typeof alt.mode).toBe('string');
      expect(typeof alt.confidence).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// Defaults and options
// ---------------------------------------------------------------------------

describe('defaults and options', () => {
  it('learnings defaults to [] when not provided', async () => {
    const signals = await buildLiveSignals({
      statePath: sandboxPath('.claude/STATE.md'),
      sessionsPath: sandboxPath('sessions.jsonl'),
      lockPath: sandboxPath('bootstrap.lock'),
      _scanBacklog: nullScanBacklog,
    });

    expect(signals.learnings).toEqual([]);
    expect(Array.isArray(signals.learnings)).toBe(true);
  });

  it('sessionTailN limits sessions to last N entries', async () => {
    const sessions = Array.from({ length: 15 }, (_, i) =>
      makeSession(i % 2 === 0 ? 'feature' : 'deep')
    );
    const sessionsPath = writeFixture('sessions.jsonl', sessions.join('\n'));

    const signals = await buildLiveSignals({
      statePath: sandboxPath('.claude/STATE.md'),
      sessionsPath,
      lockPath: sandboxPath('bootstrap.lock'),
      sessionTailN: 5,
      _scanBacklog: nullScanBacklog,
    });

    expect(signals.recentSessions).toHaveLength(5);
  });

  it('sessionTailN defaults to 10', async () => {
    const sessions = Array.from({ length: 15 }, () => makeSession('feature'));
    const sessionsPath = writeFixture('sessions.jsonl', sessions.join('\n'));

    const signals = await buildLiveSignals({
      statePath: sandboxPath('.claude/STATE.md'),
      sessionsPath,
      lockPath: sandboxPath('bootstrap.lock'),
      _scanBacklog: nullScanBacklog,
    });

    expect(signals.recentSessions).toHaveLength(10);
  });

  it('vaultStaleness is always null (reserved field)', async () => {
    const signals = await buildLiveSignals({
      statePath: sandboxPath('.claude/STATE.md'),
      sessionsPath: sandboxPath('sessions.jsonl'),
      lockPath: sandboxPath('bootstrap.lock'),
      _scanBacklog: fakeScanBacklog,
    });

    expect(signals.vaultStaleness).toBeNull();
  });

  it('recentSessions is never null — always an array', async () => {
    const signals = await buildLiveSignals({
      statePath: sandboxPath('.claude/STATE.md'),
      sessionsPath: sandboxPath('sessions.jsonl'),
      lockPath: sandboxPath('bootstrap.lock'),
      _scanBacklog: nullScanBacklog,
    });

    expect(signals.recentSessions).not.toBeNull();
    expect(Array.isArray(signals.recentSessions)).toBe(true);
  });

  it('learnings is never null — always an array', async () => {
    const signals = await buildLiveSignals({
      statePath: sandboxPath('.claude/STATE.md'),
      sessionsPath: sandboxPath('sessions.jsonl'),
      lockPath: sandboxPath('bootstrap.lock'),
      learnings: undefined,
      _scanBacklog: nullScanBacklog,
    });

    expect(signals.learnings).not.toBeNull();
    expect(Array.isArray(signals.learnings)).toBe(true);
  });

  it('scanBacklog receives the correct limit option', async () => {
    let capturedOpts;
    const capturingScan = async (opts) => {
      capturedOpts = opts;
      return null;
    };

    await buildLiveSignals({
      statePath: sandboxPath('.claude/STATE.md'),
      sessionsPath: sandboxPath('sessions.jsonl'),
      lockPath: sandboxPath('bootstrap.lock'),
      backlogLimit: 25,
      _scanBacklog: capturingScan,
    });

    expect(capturedOpts.limit).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('STATE.md with invalid YAML frontmatter → all rec fields null', async () => {
    const statePath = writeFixture('.claude/STATE.md', 'not-a-frontmatter file');

    const signals = await buildLiveSignals({
      statePath,
      sessionsPath: sandboxPath('sessions.jsonl'),
      lockPath: sandboxPath('bootstrap.lock'),
      _scanBacklog: nullScanBacklog,
    });

    expect(signals.recommendedMode).toBeNull();
    expect(signals.carryoverRatio).toBeNull();
  });

  it('sessions.jsonl with only empty lines → empty recentSessions', async () => {
    const sessionsPath = writeFixture('sessions.jsonl', '\n\n\n');

    const signals = await buildLiveSignals({
      statePath: sandboxPath('.claude/STATE.md'),
      sessionsPath,
      lockPath: sandboxPath('bootstrap.lock'),
      _scanBacklog: nullScanBacklog,
    });

    expect(signals.recentSessions).toEqual([]);
  });

  it('scanBacklog throwing → backlog is null (does not throw)', async () => {
    const throwingScan = async () => {
      throw new Error('CLI not found');
    };

    const signals = await buildLiveSignals({
      statePath: sandboxPath('.claude/STATE.md'),
      sessionsPath: sandboxPath('sessions.jsonl'),
      lockPath: sandboxPath('bootstrap.lock'),
      _scanBacklog: throwingScan,
    });

    expect(signals.backlog).toBeNull();
  });

  it('bootstrap.lock present but empty → bootstrapLock is empty object (not null)', async () => {
    const lockPath = writeFixture('bootstrap.lock', '# just a comment\n\n');

    const signals = await buildLiveSignals({
      statePath: sandboxPath('.claude/STATE.md'),
      sessionsPath: sandboxPath('sessions.jsonl'),
      lockPath,
      _scanBacklog: nullScanBacklog,
    });

    expect(signals.bootstrapLock).not.toBeNull();
    expect(typeof signals.bootstrapLock).toBe('object');
    expect(Object.keys(signals.bootstrapLock)).toHaveLength(0);
  });

  it('sessions are normalized via normalizeSession (legacy key alias applied)', async () => {
    // Use legacy key `type` which aliases to `session_type` via normalizeSession
    const legacySession = JSON.stringify({
      session_id: 'legacy-1',
      type: 'feature', // legacy key
      started_at: '2026-04-25T08:00:00Z',
      completed_at: '2026-04-25T09:00:00Z',
      total_waves: 1,
      waves: [{ wave: 1, role: 'impl' }],
      agent_summary: { complete: 1, partial: 0, failed: 0, spiral: 0 },
      total_agents: 1,
      total_files_changed: 2,
    });
    const sessionsPath = writeFixture('sessions.jsonl', legacySession);

    const signals = await buildLiveSignals({
      statePath: sandboxPath('.claude/STATE.md'),
      sessionsPath,
      lockPath: sandboxPath('bootstrap.lock'),
      _scanBacklog: nullScanBacklog,
    });

    expect(signals.recentSessions).toHaveLength(1);
    // normalizeSession should have applied the `type` → `session_type` alias
    expect(signals.recentSessions[0].session_type).toBe('feature');
  });
});
