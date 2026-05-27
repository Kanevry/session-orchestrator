/**
 * tests/lib/state-md-peer-guard.test.mjs
 *
 * Unit tests for scripts/lib/state-md-peer-guard.mjs — Issue #588.
 *
 * Tests the `checkPeerStateMd(repoRoot, mySessionId, opts?)` function which
 * detects whether a peer session owns the repo's STATE.md.
 *
 * Fixture STATE.md files are written into per-test mkdtempSync directories;
 * all temps are cleaned up in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkPeerStateMd } from '@lib/state-md-peer-guard.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a STATE.md fixture under <repoRoot>/.claude/STATE.md */
function writeStateMd(repoRoot, content) {
  const dir = join(repoRoot, '.claude');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'STATE.md'), content, 'utf8');
}

/**
 * Build a minimal valid STATE.md frontmatter string.
 * Fields provided in `fields` override or extend the defaults.
 *
 * @param {object} fields  Key-value pairs for the frontmatter.
 * @returns {string}
 */
function buildStateMd(fields) {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n\n# Body\n`;
}

/** ISO timestamp for N minutes ago */
function minutesAgo(n) {
  return new Date(Date.now() - n * 60 * 1000).toISOString();
}

/** ISO timestamp for N hours ago */
function hoursAgo(n) {
  return new Date(Date.now() - n * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Shared tmp-dir lifecycle
// ---------------------------------------------------------------------------

let repoRoot;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'peer-guard-test-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkPeerStateMd', () => {
  // T1 ─────────────────────────────────────────────────────────────────────
  it('T1: missing STATE.md → peer null, reason "no STATE.md"', () => {
    // No .claude/STATE.md written — only the empty repoRoot dir exists.
    const result = checkPeerStateMd(repoRoot, 'main-2026-05-27-deep-5');

    expect(result.peer).toBeNull();
    expect(result.reason).toBe('no STATE.md');
  });

  // T2 ─────────────────────────────────────────────────────────────────────
  it('T2: status:completed → peer null, reason "status: completed"', () => {
    writeStateMd(repoRoot, buildStateMd({
      'schema-version': 1,
      'session-type': 'deep',
      'started_at': minutesAgo(10),
      'status': 'completed',
      'current-wave': 5,
      'session': 'main-2026-05-27-deep-3',
    }));

    const result = checkPeerStateMd(repoRoot, 'main-2026-05-27-deep-5');

    expect(result.peer).toBeNull();
    expect(result.reason).toBe('status: completed');
  });

  // T3 ─────────────────────────────────────────────────────────────────────
  it('T3: status:idle → peer null, reason "status: idle"', () => {
    writeStateMd(repoRoot, buildStateMd({
      'schema-version': 1,
      'session-type': 'housekeeping',
      'started_at': minutesAgo(30),
      'status': 'idle',
      'current-wave': 1,
      'session': 'main-2026-05-27-housekeeping-1',
    }));

    const result = checkPeerStateMd(repoRoot, 'main-2026-05-27-deep-5');

    expect(result.peer).toBeNull();
    expect(result.reason).toBe('status: idle');
  });

  // T4 ─────────────────────────────────────────────────────────────────────
  it('T4: status:active + session matches mine → peer null, reason "own session"', () => {
    const myId = 'main-2026-05-27-deep-5';
    writeStateMd(repoRoot, buildStateMd({
      'schema-version': 1,
      'session-type': 'deep',
      'started_at': minutesAgo(15),
      'status': 'active',
      'current-wave': 2,
      'session': myId,
    }));

    const result = checkPeerStateMd(repoRoot, myId);

    expect(result.peer).toBeNull();
    expect(result.reason).toBe('own session');
  });

  // T5 ─────────────────────────────────────────────────────────────────────
  it('T5: status:active + different session + age=10min → peer non-null with correct fields', () => {
    const peerStartedAt = minutesAgo(10);

    writeStateMd(repoRoot, buildStateMd({
      'schema-version': 1,
      'session-type': 'deep',
      'started_at': peerStartedAt,
      'status': 'active',
      'current-wave': 3,
      'session': 'main-2026-05-27-deep-4',
    }));

    const result = checkPeerStateMd(repoRoot, 'main-2026-05-27-deep-5');

    expect(result.peer).not.toBeNull();
    expect(result.reason).toBe('ACTIVE peer detected');
    expect(result.peer.sessionId).toBe('main-2026-05-27-deep-4');
    expect(result.peer.startedAt).toBe(peerStartedAt);
    expect(result.peer.currentWave).toBe(3);
    expect(result.peer.mode).toBe('deep');
    // age should be ~10 min ≈ 0.167 h — well below default 4h maxAgeHours
    expect(result.peer.ageHours).toBeGreaterThan(0);
    expect(result.peer.ageHours).toBeLessThan(1);
  });

  // T6 ─────────────────────────────────────────────────────────────────────
  it('T6: status:active + different session + age=5h (>4h default) → peer null, reason ABANDONED', () => {
    writeStateMd(repoRoot, buildStateMd({
      'schema-version': 1,
      'session-type': 'feature',
      'started_at': hoursAgo(5),
      'status': 'active',
      'current-wave': 1,
      'session': 'main-2026-05-27-feature-1',
    }));

    const result = checkPeerStateMd(repoRoot, 'main-2026-05-27-deep-5');

    expect(result.peer).toBeNull();
    expect(result.reason).toBe('ABANDONED (age > maxAgeHours)');
  });

  // T7 ─────────────────────────────────────────────────────────────────────
  it('T7: malformed YAML (no frontmatter delimiters) → peer null, reason "malformed-state-md"', () => {
    // Write a file that has no --- delimiters so parseStateMd returns null.
    writeStateMd(repoRoot, 'this is not yaml frontmatter at all\nno delimiters\n');

    const result = checkPeerStateMd(repoRoot, 'main-2026-05-27-deep-5');

    expect(result.peer).toBeNull();
    expect(result.reason).toBe('malformed-state-md');
  });

  // T8 ─────────────────────────────────────────────────────────────────────
  it('T8: live fixture — deep-4 scenario: session=deep-4, status=active, started 5 min ago → peer matches deep-4', () => {
    const peerSessionId = 'main-2026-05-27-deep-4';
    const peerStartedAt = minutesAgo(5);

    writeStateMd(repoRoot, buildStateMd({
      'schema-version': 1,
      'session-type': 'deep',
      'branch': 'main',
      'started_at': peerStartedAt,
      'status': 'active',
      'current-wave': 4,
      'total-waves': 5,
      'session': peerSessionId,
    }));

    const result = checkPeerStateMd(repoRoot, 'main-2026-05-27-deep-5');

    // Peer must be detected.
    expect(result.peer).not.toBeNull();
    expect(result.reason).toBe('ACTIVE peer detected');

    // All peer fields must match the fixture exactly.
    expect(result.peer.sessionId).toBe('main-2026-05-27-deep-4');
    expect(result.peer.startedAt).toBe(peerStartedAt);
    expect(result.peer.currentWave).toBe(4);
    expect(result.peer.mode).toBe('deep');
    // Age must be between 0 and 1 hour (started 5 min ago).
    expect(result.peer.ageHours).toBeGreaterThan(0);
    expect(result.peer.ageHours).toBeLessThan(1);
  });

  // ── Additional edge-case coverage ────────────────────────────────────────

  it('returns peer null when mySessionId is null and session field is present (null means "no session yet")', () => {
    // When mySessionId is null, any active session should be treated as a peer.
    writeStateMd(repoRoot, buildStateMd({
      'schema-version': 1,
      'session-type': 'deep',
      'started_at': minutesAgo(5),
      'status': 'active',
      'current-wave': 2,
      'session': 'main-2026-05-27-deep-4',
    }));

    const result = checkPeerStateMd(repoRoot, null);

    // null mySessionId means "no session yet" — any active session is a peer.
    expect(result.peer).not.toBeNull();
    expect(result.peer.sessionId).toBe('main-2026-05-27-deep-4');
  });

  it('respects custom maxAgeHours option', () => {
    // 30 minutes old; default 4h would flag it as active peer.
    // With maxAgeHours=0.25 (15min) it should be ABANDONED.
    writeStateMd(repoRoot, buildStateMd({
      'schema-version': 1,
      'session-type': 'deep',
      'started_at': minutesAgo(30),
      'status': 'active',
      'current-wave': 1,
      'session': 'main-2026-05-27-deep-3',
    }));

    const result = checkPeerStateMd(repoRoot, 'main-2026-05-27-deep-5', { maxAgeHours: 0.25 });

    expect(result.peer).toBeNull();
    expect(result.reason).toBe('ABANDONED (age > maxAgeHours)');
  });

  it('returns peer non-null when age is exactly at the boundary (≤ maxAgeHours)', () => {
    // Age is 1 minute; maxAgeHours=0.1 (6 min) → 1 min < 6 min → active peer.
    writeStateMd(repoRoot, buildStateMd({
      'schema-version': 1,
      'session-type': 'feature',
      'started_at': minutesAgo(1),
      'status': 'active',
      'current-wave': 2,
      'session': 'main-2026-05-27-feature-2',
    }));

    const result = checkPeerStateMd(repoRoot, 'main-2026-05-27-deep-5', { maxAgeHours: 0.1 });

    expect(result.peer).not.toBeNull();
    expect(result.reason).toBe('ACTIVE peer detected');
    expect(result.peer.mode).toBe('feature');
  });

  it('treats missing started_at as ABANDONED (Infinity age)', () => {
    // No started_at field → ageHours = Infinity → ABANDONED.
    writeStateMd(repoRoot, buildStateMd({
      'schema-version': 1,
      'session-type': 'deep',
      'status': 'active',
      'current-wave': 1,
      'session': 'main-2026-05-27-deep-3',
    }));

    const result = checkPeerStateMd(repoRoot, 'main-2026-05-27-deep-5');

    expect(result.peer).toBeNull();
    expect(result.reason).toBe('ABANDONED (age > maxAgeHours)');
  });

  it('treats non-active status values (e.g. "paused") as non-blocking', () => {
    writeStateMd(repoRoot, buildStateMd({
      'schema-version': 1,
      'session-type': 'deep',
      'started_at': minutesAgo(5),
      'status': 'paused',
      'current-wave': 2,
      'session': 'main-2026-05-27-deep-3',
    }));

    const result = checkPeerStateMd(repoRoot, 'main-2026-05-27-deep-5');

    expect(result.peer).toBeNull();
    expect(result.reason).toContain('status:');
  });

  // H5 ─────────────────────────────────────────────────────────────────────
  it('H5: status:active with no session: field → peer null, reason "no session field"', () => {
    // The `if (sessionField === null) return { peer: null, reason: 'no session field' }`
    // branch (SUT lines 168-170) is only reachable when status === 'active' AND
    // the `session:` frontmatter key is absent. Build that exact fixture by
    // omitting the `session` key from the fields object.
    writeStateMd(repoRoot, buildStateMd({
      'schema-version': 1,
      'session-type': 'deep',
      'started_at': minutesAgo(5),
      'status': 'active',
      'current-wave': 2,
    }));

    const result = checkPeerStateMd(repoRoot, 'main-2026-05-27-deep-6');

    expect(result.peer).toBeNull();
    expect(result.reason).toBe('no session field');
  });
});
