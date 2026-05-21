/**
 * cold-start-detector.test.mjs — Unit tests for scripts/lib/cold-start-detector.mjs
 *
 * Covers detectColdStart() decision logic and consumeMarker() idempotency.
 * Each test builds a tmpdir-based fake repo with .orchestrator/* fixtures
 * and exercises the function directly via ESM import. `now` is injected for
 * deterministic clock control.
 *
 * Behaviour validated (PRD §F1.3 / issue #500):
 *   - Bootstrap-lock missing → no emit.
 *   - Sessions floor met → no emit.
 *   - Bootstrap too fresh → no emit (clock-injected).
 *   - Kill-switch enabled:false → no emit.
 *   - All conditions met → emit; markerPath set only when marker present.
 *   - consumeMarker deletes once; second call returns false.
 *   - Edge cases: unparseable timestamp, legacy `timestamp` key fallback,
 *     empty sessions file, trailing-newline line counter.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectColdStart,
  consumeMarker,
  MS_PER_HOUR,
  WELCOME_MARKER_REL,
} from '@lib/cold-start-detector.mjs';

// ───────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ───────────────────────────────────────────────────────────────────────────

let repo;

function repoPath(...segments) {
  return join(repo, ...segments);
}

/**
 * Writes a bootstrap.lock with the given timestamp (modern key) or legacy
 * timestamp key. Passing `null` skips writing the lock entirely.
 */
function writeLock({ bootstrappedAt, legacyTimestamp = null, custom = null }) {
  const dir = join(repo, '.orchestrator');
  mkdirSync(dir, { recursive: true });
  let body;
  if (custom !== null) {
    body = custom;
  } else if (legacyTimestamp) {
    body = `timestamp: ${legacyTimestamp}\n`;
  } else {
    body = `bootstrapped-at: ${bootstrappedAt}\n`;
  }
  writeFileSync(join(dir, 'bootstrap.lock'), body, 'utf8');
}

function writeSessions(lines) {
  const dir = join(repo, '.orchestrator', 'metrics');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sessions.jsonl'), lines, 'utf8');
}

function writeMarker() {
  const dir = join(repo, '.orchestrator');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'welcome-banner-pending'), '', 'utf8');
}

// Anchor "now" at a deterministic point: 2026-01-01T12:00:00Z
const NOW_MS = Date.parse('2026-01-01T12:00:00Z');
const HOURS_AGO = (h) => new Date(NOW_MS - h * MS_PER_HOUR).toISOString();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'cold-start-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────
// P0 — Skip decisions
// ───────────────────────────────────────────────────────────────────────────

describe('detectColdStart — skip decisions', () => {
  it('returns no-bootstrap-lock when bootstrap.lock is missing', async () => {
    // No .orchestrator/bootstrap.lock written → bootstrap-gate path.
    const result = await detectColdStart({ repoRoot: repo, now: NOW_MS });
    expect(result).toEqual({ shouldEmit: false, reason: 'no-bootstrap-lock' });
  });

  it('returns sessions-floor-met when sessions.jsonl line count >= silenceAfterSessions', async () => {
    writeLock({ bootstrappedAt: HOURS_AGO(48) });
    writeSessions('{"session":"a"}\n{"session":"b"}\n');
    const result = await detectColdStart({
      repoRoot: repo,
      silenceAfterSessions: 1,
      now: NOW_MS,
    });
    expect(result.shouldEmit).toBe(false);
    expect(result.reason).toBe('sessions-floor-met (2 >= 1)');
  });

  it('returns bootstrap-too-fresh when age < nudgeAfterHours (now injected)', async () => {
    writeLock({ bootstrappedAt: HOURS_AGO(0.5) }); // 30 minutes ago
    const result = await detectColdStart({
      repoRoot: repo,
      nudgeAfterHours: 1,
      now: NOW_MS,
    });
    expect(result.shouldEmit).toBe(false);
    expect(result.reason).toBe('bootstrap-too-fresh (0h < 1h)');
  });

  it('returns disabled when kill-switch enabled:false', async () => {
    // Even with a perfectly cold repo, enabled=false short-circuits.
    writeLock({ bootstrappedAt: HOURS_AGO(48) });
    const result = await detectColdStart({
      repoRoot: repo,
      enabled: false,
      now: NOW_MS,
    });
    expect(result).toEqual({ shouldEmit: false, reason: 'disabled' });
  });

  it('returns no-repo-root when repoRoot is missing', async () => {
    const result = await detectColdStart({ now: NOW_MS });
    expect(result).toEqual({ shouldEmit: false, reason: 'no-repo-root' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// P0 — Emit decisions
// ───────────────────────────────────────────────────────────────────────────

describe('detectColdStart — emit decisions', () => {
  it('emits with markerPath set when marker file is present and all conditions met', async () => {
    writeLock({ bootstrappedAt: HOURS_AGO(48) });
    writeMarker();
    const result = await detectColdStart({
      repoRoot: repo,
      nudgeAfterHours: 1,
      silenceAfterSessions: 1,
      now: NOW_MS,
    });
    expect(result.shouldEmit).toBe(true);
    expect(result.markerPath).toBe(repoPath(WELCOME_MARKER_REL));
    expect(result.reason).toBe('migration-marker-present');
    expect(Array.isArray(result.bannerLines)).toBe(true);
    expect(result.bannerLines.length).toBeGreaterThan(0);
  });

  it('emits with markerPath undefined when marker file is absent', async () => {
    writeLock({ bootstrappedAt: HOURS_AGO(48) });
    const result = await detectColdStart({
      repoRoot: repo,
      nudgeAfterHours: 1,
      silenceAfterSessions: 1,
      now: NOW_MS,
    });
    expect(result.shouldEmit).toBe(true);
    expect(result.markerPath).toBeUndefined();
    expect(result.reason).toBe(
      'bootstrap-age-met (48h >= 1h, sessions=0)',
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// P0 — consumeMarker idempotency
// ───────────────────────────────────────────────────────────────────────────

describe('consumeMarker', () => {
  it('deletes the marker file on first call', async () => {
    writeMarker();
    const path = repoPath(WELCOME_MARKER_REL);
    expect(existsSync(path)).toBe(true);
    const ok = await consumeMarker(path);
    expect(ok).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('returns false on second call (idempotent)', async () => {
    writeMarker();
    const path = repoPath(WELCOME_MARKER_REL);
    await consumeMarker(path);
    const second = await consumeMarker(path);
    expect(second).toBe(false);
  });

  it('returns false when markerPath is empty string', async () => {
    const ok = await consumeMarker('');
    expect(ok).toBe(false);
  });

  it('returns false when markerPath is undefined', async () => {
    const ok = await consumeMarker(undefined);
    expect(ok).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// P0 — Line counter (indirectly via the sessions check)
// ───────────────────────────────────────────────────────────────────────────

describe('detectColdStart — sessions line counting', () => {
  it('counts empty sessions.jsonl as 0 (emit when other conditions met)', async () => {
    writeLock({ bootstrappedAt: HOURS_AGO(48) });
    writeSessions('');
    const result = await detectColdStart({
      repoRoot: repo,
      nudgeAfterHours: 1,
      silenceAfterSessions: 1,
      now: NOW_MS,
    });
    // 0 sessions < 1 floor → emit.
    expect(result.shouldEmit).toBe(true);
  });

  it('trailing newline does not inflate session count', async () => {
    writeLock({ bootstrappedAt: HOURS_AGO(48) });
    // Exactly ONE session, with a trailing newline. silence floor = 2 →
    // 1 < 2 → emit. If trailing \n inflated to 2, we'd skip.
    writeSessions('{"session":"a"}\n');
    const result = await detectColdStart({
      repoRoot: repo,
      nudgeAfterHours: 1,
      silenceAfterSessions: 2,
      now: NOW_MS,
    });
    expect(result.shouldEmit).toBe(true);
  });

  it('one session at floor=1 silences the banner', async () => {
    // Boundary: count === floor → reason should be sessions-floor-met.
    writeLock({ bootstrappedAt: HOURS_AGO(48) });
    writeSessions('{"session":"a"}\n');
    const result = await detectColdStart({
      repoRoot: repo,
      silenceAfterSessions: 1,
      now: NOW_MS,
    });
    expect(result.shouldEmit).toBe(false);
    expect(result.reason).toBe('sessions-floor-met (1 >= 1)');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// P1 — Lock parsing edge cases
// ───────────────────────────────────────────────────────────────────────────

describe('detectColdStart — lock parsing edge cases', () => {
  it('returns lock-unparseable-timestamp when bootstrapped-at is not a date', async () => {
    writeLock({ bootstrappedAt: 'not-a-date' });
    const result = await detectColdStart({ repoRoot: repo, now: NOW_MS });
    expect(result).toEqual({
      shouldEmit: false,
      reason: 'lock-unparseable-timestamp',
    });
  });

  it('falls back to legacy `timestamp` key when `bootstrapped-at` is absent', async () => {
    // Legacy locks (pre-#186) only have `timestamp:`. Detector must still
    // honour the freshness check via that field.
    writeLock({ bootstrappedAt: null, legacyTimestamp: HOURS_AGO(48) });
    const result = await detectColdStart({
      repoRoot: repo,
      nudgeAfterHours: 1,
      silenceAfterSessions: 1,
      now: NOW_MS,
    });
    expect(result.shouldEmit).toBe(true);
  });

  it('returns lock-no-timestamp when lock body contains neither timestamp key', async () => {
    writeLock({ custom: 'version: 1\ntier: standard\n' });
    const result = await detectColdStart({ repoRoot: repo, now: NOW_MS });
    expect(result).toEqual({ shouldEmit: false, reason: 'lock-no-timestamp' });
  });
});
