/**
 * tests/lib/session-started-at.test.mjs
 *
 * Tests for the STATE.md frontmatter SOURCES in scripts/lib/state-md.mjs —
 * `resolveSessionStartedAt()` / `resolveSessionIds()` (#1368, #1663).
 *
 * The bug they exist for: STATE.md's `started_at` was 100% prose-written, so
 * coordinators filled it from `new Date()` at WRITE time. Measured 2026-09-13,
 * that put STATE.md 48 minutes ahead of the lock the ledger's own timestamps
 * descend from, and `/close`'s #429 pre-check — which compared the two — could
 * then not join STATE.md to its own session record.
 *
 * Strategy: an isolated tmp repoRoot with a hand-written session.lock, so the
 * REAL readLock() is exercised (no mocking of the thing under test).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { resolveSessionIds, resolveSessionStartedAt } from '@lib/state-md.mjs';

const LOCK_STARTED_AT = '2026-09-13T08:12:34.567Z';
const UUID = '11111111-2222-4333-8444-555555555555';
const SEMANTIC = 'main-2026-09-13-deep-1';
// Identity is injected, never inherited: the vitest process itself may run
// with a real CLAUDE_CODE_SESSION_ID.
const OWN_ENV = { SO_PLATFORM: 'claude', CLAUDE_CODE_SESSION_ID: UUID };
const PEER_ENV = { SO_PLATFORM: 'claude', CLAUDE_CODE_SESSION_ID: '99999999-8888-4777-8666-555555555555' };

let repoRoot;
const tmpDirs = [];

function seedLock(fields) {
  fs.mkdirSync(path.join(repoRoot, '.orchestrator'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, '.orchestrator', 'session.lock'),
    JSON.stringify(
      {
        session_id: UUID,
        started_at: LOCK_STARTED_AT,
        last_heartbeat: LOCK_STARTED_AT,
        mode: 'deep',
        pid: 999999,
        host: os.hostname(),
        ttl_hours: 4,
        semantic_session_id: SEMANTIC,
        ...fields,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
}

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-started-at-'));
  tmpDirs.push(repoRoot);
});

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('resolveSessionStartedAt (#1368, #1730)', () => {
  it('returns the lock started_at, not now()', () => {
    seedLock();
    // The whole point: a writer calling this HOURS after the lock was minted
    // still stamps the lock's instant. `new Date()` would return today.
    expect(resolveSessionStartedAt({ repoRoot, env: OWN_ENV })).toBe(LOCK_STARTED_AT);
  });

  it('normalises a non-Z lock timestamp to ISO-8601 UTC', () => {
    seedLock({ started_at: '2026-09-13T10:12:34.567+02:00' });
    expect(resolveSessionStartedAt({ repoRoot, env: OWN_ENV })).toBe(LOCK_STARTED_AT);
  });

  it('never stamps a PEER lock\'s start — a foreign lock falls back to now() (#1730 Pkt 8)', () => {
    // Bug caught: the lock is repo-global, so a worktree session reading at the
    // main checkout found the Lead's lock and wrote ITS start into STATE.md.
    seedLock();
    const before = Date.now();
    expect(Date.parse(resolveSessionStartedAt({ repoRoot, env: PEER_ENV }))).toBeGreaterThanOrEqual(before);
    // Same judgement as resolveSessionIds: the two keys never disagree.
    expect(resolveSessionIds({ repoRoot, env: PEER_ENV }).session_id).toBeNull();
    // Unprovable is not foreign: a process without an id keeps the lock instant.
    expect(resolveSessionStartedAt({ repoRoot, env: {} })).toBe(LOCK_STARTED_AT);
  });

  it('falls back to now() when the lock is absent', () => {
    const before = Date.now();
    const value = resolveSessionStartedAt({ repoRoot, env: OWN_ENV });
    const after = Date.now();
    // No lock (persistence off / acquire failed) → the present moment is the
    // best available source. Assert the WINDOW, never a literal.
    expect(Date.parse(value)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(value)).toBeLessThanOrEqual(after);
  });

  it('falls back to now() when the lock is corrupt (unparseable started_at)', () => {
    fs.mkdirSync(path.join(repoRoot, '.orchestrator'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, '.orchestrator', 'session.lock'), '{ not json', 'utf8');
    const before = Date.now();
    expect(Date.parse(resolveSessionStartedAt({ repoRoot, env: OWN_ENV }))).toBeGreaterThanOrEqual(before);
  });
});

describe('resolveSessionIds (#1368, #1663)', () => {
  it('yields the raw and semantic ids from the lock when the lock is this process\'s own', () => {
    seedLock();
    expect(resolveSessionIds({ repoRoot, env: OWN_ENV })).toEqual({
      session_id: UUID,
      semantic_session_id: SEMANTIC,
    });
  });

  it('a lock naming a peer yields null ids — STATE.md is written without session-id, never with the foreign one (#1663)', () => {
    seedLock();
    expect(resolveSessionIds({ repoRoot, env: PEER_ENV })).toEqual({
      session_id: null,
      semantic_session_id: null,
    });
  });

  it('a process that cannot name its own id keeps the lock label but no session-id (#1663 ceiling, #429 label join)', () => {
    seedLock();
    expect(resolveSessionIds({ repoRoot, env: {} })).toEqual({
      session_id: null,
      semantic_session_id: SEMANTIC,
    });
  });

  it('yields nulls (never placeholders) when no lock exists — the writer must OMIT the keys', () => {
    expect(resolveSessionIds({ repoRoot, env: OWN_ENV })).toEqual({
      session_id: null,
      semantic_session_id: null,
    });
  });

  it('yields a null semantic id for the lock shape that carries no semantic_session_id field', () => {
    seedLock({ semantic_session_id: undefined });
    expect(resolveSessionIds({ repoRoot, env: OWN_ENV })).toEqual({
      session_id: UUID,
      semantic_session_id: null,
    });
  });
});
