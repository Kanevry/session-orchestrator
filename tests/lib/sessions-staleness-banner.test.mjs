/**
 * tests/lib/sessions-staleness-banner.test.mjs — #724
 *
 * Every case writes into an isolated tmpdir repo — never touches the real
 * `.orchestrator/metrics/sessions.jsonl`, `.orchestrator/metrics/events.jsonl`,
 * or `.orchestrator/session.lock` in this repo, so results stay deterministic
 * regardless of the host repo's live state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  checkSessionsStaleness,
  WARN_THRESHOLD_HOURS,
  ALERT_THRESHOLD_HOURS,
} from '@lib/sessions-staleness-banner.mjs';

let tmpRepo;

beforeEach(() => {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-staleness-repo-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

/** Build one sessions.jsonl line with the given `completed_at`. */
function sessionLine(completedAt) {
  return JSON.stringify({ session_id: 'main-test-session', session_type: 'housekeeping', completed_at: completedAt });
}

/** Build one events.jsonl line with the given `timestamp`. */
function eventLine(timestamp) {
  return JSON.stringify({ event: 'orchestrator.agent.stopped', timestamp, agent: 'session-orchestrator:code-implementer' });
}

/** Write raw lines (each already a JSON string, or deliberately malformed) to <repo>/.orchestrator/metrics/sessions.jsonl. */
function writeSessions(repo, lines) {
  const dir = path.join(repo, '.orchestrator', 'metrics');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions.jsonl'), lines.length ? lines.join('\n') + '\n' : '', 'utf8');
}

/** Write raw lines to <repo>/.orchestrator/metrics/events.jsonl. */
function writeEvents(repo, lines) {
  const dir = path.join(repo, '.orchestrator', 'metrics');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.length ? lines.join('\n') + '\n' : '', 'utf8');
}

/** Write a session.lock file with the given `started_at`. */
function writeLock(repo, startedAt) {
  const dir = path.join(repo, '.orchestrator');
  fs.mkdirSync(dir, { recursive: true });
  const lock = {
    session_id: 'test-session-id',
    started_at: startedAt,
    last_heartbeat: startedAt,
    mode: 'session',
    pid: 1,
    host: 'test-host',
    ttl_hours: 4,
  };
  fs.writeFileSync(path.join(dir, 'session.lock'), JSON.stringify(lock, null, 2) + '\n', 'utf8');
}

describe('checkSessionsStaleness — bad input', () => {
  it('returns null when called with no arguments', () => {
    expect(checkSessionsStaleness()).toBe(null);
  });

  it('returns null when repoRoot is missing', () => {
    expect(checkSessionsStaleness({})).toBe(null);
  });

  it('returns null when repoRoot is a non-string', () => {
    expect(checkSessionsStaleness({ repoRoot: 42 })).toBe(null);
  });
});

describe('checkSessionsStaleness — silent no-op (missing/empty files)', () => {
  it('returns null when sessions.jsonl does not exist', () => {
    writeEvents(tmpRepo, [eventLine('2026-01-01T10:00:00.000Z')]);
    expect(checkSessionsStaleness({ repoRoot: tmpRepo })).toBe(null);
  });

  it('returns null when sessions.jsonl exists but is empty', () => {
    writeSessions(tmpRepo, []);
    writeEvents(tmpRepo, [eventLine('2026-01-01T10:00:00.000Z')]);
    expect(checkSessionsStaleness({ repoRoot: tmpRepo })).toBe(null);
  });

  it('returns null when sessions.jsonl contains only malformed lines', () => {
    writeSessions(tmpRepo, ['not valid json at all', '{broken']);
    writeEvents(tmpRepo, [eventLine('2026-01-01T10:00:00.000Z')]);
    expect(checkSessionsStaleness({ repoRoot: tmpRepo })).toBe(null);
  });

  it('returns null when events.jsonl does not exist', () => {
    writeSessions(tmpRepo, [sessionLine('2026-01-01T00:00:00.000Z')]);
    expect(checkSessionsStaleness({ repoRoot: tmpRepo })).toBe(null);
  });

  it('returns null when events.jsonl exists but is empty', () => {
    writeSessions(tmpRepo, [sessionLine('2026-01-01T00:00:00.000Z')]);
    writeEvents(tmpRepo, []);
    expect(checkSessionsStaleness({ repoRoot: tmpRepo })).toBe(null);
  });
});

describe('checkSessionsStaleness — under threshold', () => {
  it('returns null when the gap is at or under WARN_THRESHOLD_HOURS', () => {
    writeSessions(tmpRepo, [sessionLine('2026-01-01T00:00:00.000Z')]);
    // Foreign event 4h after ledger — under the 8h warn threshold.
    writeEvents(tmpRepo, [eventLine('2026-01-01T04:00:00.000Z')]);
    const now = Date.parse('2026-01-01T06:00:00.000Z'); // cutoff after the foreign event
    expect(checkSessionsStaleness({ repoRoot: tmpRepo, now })).toBe(null);
  });
});

describe('checkSessionsStaleness — warn case', () => {
  it('returns a warn banner when the gap exceeds WARN_THRESHOLD_HOURS but not ALERT_THRESHOLD_HOURS', () => {
    writeSessions(tmpRepo, [sessionLine('2026-01-01T00:00:00.000Z')]);
    // Foreign event 10h after ledger — over the 8h warn threshold, under 24h alert.
    writeEvents(tmpRepo, [eventLine('2026-01-01T10:00:00.000Z')]);
    const now = Date.parse('2026-01-01T12:00:00.000Z'); // cutoff after the foreign event
    const result = checkSessionsStaleness({ repoRoot: tmpRepo, now });
    expect(result).not.toBe(null);
    expect(result.severity).toBe('warn');
    expect(result.lastLedgerAt).toBe('2026-01-01T00:00:00.000Z');
    expect(result.lastForeignEventAt).toBe('2026-01-01T10:00:00.000Z');
    expect(result.deltaHours).toBe(10);
    expect(WARN_THRESHOLD_HOURS).toBe(8);
  });

  it('warn message contains the expected shape and does NOT mention the 24h alert clause', () => {
    writeSessions(tmpRepo, [sessionLine('2026-01-01T00:00:00.000Z')]);
    writeEvents(tmpRepo, [eventLine('2026-01-01T10:00:00.000Z')]);
    const now = Date.parse('2026-01-01T12:00:00.000Z');
    const result = checkSessionsStaleness({ repoRoot: tmpRepo, now });
    expect(result.message).toContain('⚠ sessions-staleness: last sessions.jsonl entry 2026-01-01T00:00:00.000Z is 10h behind');
    expect(result.message).toContain('pre-session events.jsonl activity 2026-01-01T10:00:00.000Z');
    expect(result.message).toContain('close-through gap');
    expect(result.message).toContain('scripts/backfill-abandoned-sessions.mjs --dry-run');
    expect(result.message).not.toContain('gap exceeds 24h');
    expect(result.message).not.toContain('🚨');
  });
});

describe('checkSessionsStaleness — alert case', () => {
  it('returns an alert banner when the gap exceeds ALERT_THRESHOLD_HOURS', () => {
    writeSessions(tmpRepo, [sessionLine('2026-01-01T00:00:00.000Z')]);
    // Foreign event 26h after ledger — over the 24h alert threshold.
    writeEvents(tmpRepo, [eventLine('2026-01-02T02:00:00.000Z')]);
    const now = Date.parse('2026-01-02T04:00:00.000Z'); // cutoff after the foreign event
    const result = checkSessionsStaleness({ repoRoot: tmpRepo, now });
    expect(result).not.toBe(null);
    expect(result.severity).toBe('alert');
    expect(result.deltaHours).toBe(26);
    expect(ALERT_THRESHOLD_HOURS).toBe(24);
  });

  it('alert message uses the 🚨 prefix and mentions the 24h clause', () => {
    writeSessions(tmpRepo, [sessionLine('2026-01-01T00:00:00.000Z')]);
    writeEvents(tmpRepo, [eventLine('2026-01-02T02:00:00.000Z')]);
    const now = Date.parse('2026-01-02T04:00:00.000Z');
    const result = checkSessionsStaleness({ repoRoot: tmpRepo, now });
    expect(result.message).toContain('🚨 sessions-staleness: last sessions.jsonl entry 2026-01-01T00:00:00.000Z is 26h behind');
    expect(result.message).toContain('gap exceeds 24h');
    expect(result.message).not.toContain('⚠');
  });
});

describe('checkSessionsStaleness — self-exclusion (the core test)', () => {
  it('does NOT count events.jsonl entries at or after the current session lock started_at', () => {
    writeSessions(tmpRepo, [sessionLine('2026-01-01T00:00:00.000Z')]);
    // Only an event AFTER the lock's started_at exists — must be excluded,
    // yielding null (not a false-positive alert on the session's own event).
    writeLock(tmpRepo, '2026-01-01T10:00:00.000Z');
    writeEvents(tmpRepo, [eventLine('2026-01-02T10:00:00.000Z')]); // 34h after ledger, AFTER lock
    expect(checkSessionsStaleness({ repoRoot: tmpRepo })).toBe(null);
  });

  it('uses the genuine pre-cutoff foreign event and ignores a later same-session event mixed into the same file', () => {
    writeSessions(tmpRepo, [sessionLine('2026-01-01T00:00:00.000Z')]);
    // Lock starts 10h after the ledger entry.
    writeLock(tmpRepo, '2026-01-01T10:00:00.000Z');
    writeEvents(tmpRepo, [
      // Genuine foreign event: 9h after ledger, BEFORE the lock's started_at — counts.
      eventLine('2026-01-01T09:00:00.000Z'),
      // Current session's own event: 34h after ledger, AFTER the lock's started_at —
      // must be excluded. If the exclusion is broken, this would flip the result
      // to 'alert' with deltaHours=34 instead of 'warn' with deltaHours=9.
      eventLine('2026-01-02T10:00:00.000Z'),
    ]);
    const result = checkSessionsStaleness({ repoRoot: tmpRepo });
    expect(result).not.toBe(null);
    expect(result.severity).toBe('warn');
    expect(result.lastForeignEventAt).toBe('2026-01-01T09:00:00.000Z');
    expect(result.deltaHours).toBe(9);
  });
});

describe('checkSessionsStaleness — no lock readable, cutoff=now fallback', () => {
  it('falls back to the default `now` clock as cutoff when no session.lock exists', () => {
    // No writeLock() call — session.lock is absent.
    writeSessions(tmpRepo, [sessionLine('2020-01-01T00:00:00.000Z')]);
    // 100h after ledger, comfortably in the past relative to the real Date.now() —
    // called WITHOUT a `now` override so the module's own `Date.now()` default applies.
    writeEvents(tmpRepo, [eventLine('2020-01-05T04:00:00.000Z')]);
    const result = checkSessionsStaleness({ repoRoot: tmpRepo });
    expect(result).not.toBe(null);
    expect(result.severity).toBe('alert');
    expect(result.lastForeignEventAt).toBe('2020-01-05T04:00:00.000Z');
  });
});

describe('checkSessionsStaleness — malformed JSONL lines are skipped', () => {
  it('skips malformed sessions.jsonl lines and uses the last parseable record', () => {
    writeSessions(tmpRepo, [
      'not json at all',
      '{"broken"',
      sessionLine('2026-01-01T00:00:00.000Z'),
    ]);
    writeEvents(tmpRepo, [eventLine('2026-01-01T10:00:00.000Z')]);
    const now = Date.parse('2026-01-01T12:00:00.000Z');
    const result = checkSessionsStaleness({ repoRoot: tmpRepo, now });
    expect(result).not.toBe(null);
    expect(result.lastLedgerAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('skips malformed events.jsonl lines and uses the newest valid pre-cutoff event', () => {
    writeSessions(tmpRepo, [sessionLine('2026-01-01T00:00:00.000Z')]);
    writeEvents(tmpRepo, [
      eventLine('2026-01-01T10:00:00.000Z'),
      'garbage line',
      '{oops',
    ]);
    const now = Date.parse('2026-01-01T12:00:00.000Z');
    const result = checkSessionsStaleness({ repoRoot: tmpRepo, now });
    expect(result).not.toBe(null);
    expect(result.lastForeignEventAt).toBe('2026-01-01T10:00:00.000Z');
  });
});

describe('checkSessionsStaleness — additional coverage (F-G, W4 fix pass)', () => {
  it('returns null when last ledger entry is newer than any foreign event (negative delta)', () => {
    // Ledger entry at 10:00, foreign event at 05:00 — the foreign event is
    // BEFORE the ledger entry, so deltaMs (foreign.ms - ledger.ms) is negative.
    writeSessions(tmpRepo, [sessionLine('2026-01-01T10:00:00.000Z')]);
    writeEvents(tmpRepo, [eventLine('2026-01-01T05:00:00.000Z')]);
    const now = Date.parse('2026-01-01T12:00:00.000Z'); // cutoff after the foreign event
    expect(checkSessionsStaleness({ repoRoot: tmpRepo, now })).toBe(null);
  });

  it('falls back to now-cutoff when session.lock exists but started_at is malformed', () => {
    writeSessions(tmpRepo, [sessionLine('2020-01-01T00:00:00.000Z')]);
    // The lock EXISTS (unlike the "no lock readable" case above) but its
    // started_at is not a parseable timestamp — resolveCutoffMs's
    // `Number.isFinite(parsed)` guard must still fall back to `nowMs`,
    // identically to the no-lock-at-all case.
    writeLock(tmpRepo, 'not-a-real-date');
    writeEvents(tmpRepo, [eventLine('2020-01-05T04:00:00.000Z')]);
    const result = checkSessionsStaleness({ repoRoot: tmpRepo });
    expect(result).not.toBe(null);
    expect(result.severity).toBe('alert');
    expect(result.lastForeignEventAt).toBe('2020-01-05T04:00:00.000Z');
  });

  it('skips a valid record lacking completed_at and uses the prior parseable one', () => {
    writeSessions(tmpRepo, [
      sessionLine('2026-01-01T00:00:00.000Z'),
      // Last (EOF-nearest) record has no completed_at at all — lastLedgerEntry
      // must skip it (typeof completed_at !== 'string' guard) and fall back
      // to the earlier, parseable record instead of returning null.
      JSON.stringify({ session_id: 'no-completed-at', session_type: 'housekeeping' }),
    ]);
    writeEvents(tmpRepo, [eventLine('2026-01-01T10:00:00.000Z')]);
    const now = Date.parse('2026-01-01T12:00:00.000Z');
    const result = checkSessionsStaleness({ repoRoot: tmpRepo, now });
    expect(result).not.toBe(null);
    expect(result.lastLedgerAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('session-start SKILL.md wiring (#724)', () => {
  it('references checkSessionsStaleness and sessions-staleness-banner.mjs in Phase 4', () => {
    const skillPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '..',
      '..',
      'skills',
      'session-start',
      'SKILL.md',
    );
    const content = fs.readFileSync(skillPath, 'utf8');
    expect(content).toContain('checkSessionsStaleness');
    expect(content).toContain('sessions-staleness-banner.mjs');
  });
});
