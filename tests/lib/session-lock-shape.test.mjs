/**
 * tests/lib/session-lock-shape.test.mjs
 *
 * The bug this catches (TV-001): `scripts/lib/session-lock.mjs` `parseLock()`
 * and `scripts/lib/session-identity/own-session.mjs` `readLockIds()` used to
 * carry TWO copies of the six-field lock predicate with nothing binding them.
 * Relaxing one copy and not the other is fail-OPEN: the lock tier of
 * `readOwnSessionIds()` stops contributing ids, this session's own wave-scope
 * manifest classifies `foreign`, and `hooks/enforce-scope.mjs` skips
 * enforcement for the whole wave with no signal.
 *
 * The parity block below is the binding mechanism expressed as a test: for
 * every fixture, "readLock() returned a record" and "readLockIds() returned
 * ids" must be the SAME boolean. A future divergence turns it red.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLockShape } from '../../scripts/lib/session-lock-shape.mjs';
import { readLock } from '../../scripts/lib/session-lock.mjs';
import { readOwnSessionIds } from '../../scripts/lib/session-identity/own-session.mjs';

const VALID = Object.freeze({
  session_id: 'RAW-UUID-SHAPE',
  started_at: '2026-09-04T00:00:00.000Z',
  mode: 'session',
  pid: 4242,
  host: 'test-host',
  ttl_hours: 4,
  semantic_session_id: 'main-2026-09-04-session-1',
});

/** [name, mutation applied to a copy of VALID, expected isLockShape] */
const FIXTURES = [
  ['a complete v2 lock', (o) => o, true],
  ['a v1 lock without last_heartbeat', (o) => o, true],
  ['session_id missing', (o) => { delete o.session_id; return o; }, false],
  ['session_id non-string', (o) => ({ ...o, session_id: 7 }), false],
  ['started_at missing', (o) => { delete o.started_at; return o; }, false],
  ['started_at non-string', (o) => ({ ...o, started_at: 0 }), false],
  ['mode missing', (o) => { delete o.mode; return o; }, false],
  ['mode non-string', (o) => ({ ...o, mode: null }), false],
  ['pid missing', (o) => { delete o.pid; return o; }, false],
  ['pid non-number', (o) => ({ ...o, pid: '4242' }), false],
  ['host missing', (o) => { delete o.host; return o; }, false],
  ['host non-string', (o) => ({ ...o, host: ['h'] }), false],
  ['ttl_hours missing', (o) => { delete o.ttl_hours; return o; }, false],
  ['ttl_hours non-number', (o) => ({ ...o, ttl_hours: '4' }), false],
  ['semantic_session_id absent (optional by schema)', (o) => { delete o.semantic_session_id; return o; }, true],
];

const build = (mutate) => mutate({ ...VALID });

describe('isLockShape (#1153 P7 — one predicate, two consumers)', () => {
  it('rejects non-objects outright', () => {
    for (const value of [null, undefined, 'lock', 42, true, [VALID]]) {
      expect(isLockShape(value)).toBe(false);
    }
  });

  for (const [name, mutate, expected] of FIXTURES) {
    it(`${expected ? 'accepts' : 'rejects'}: ${name}`, () => {
      expect(isLockShape(build(mutate))).toBe(expected);
    });
  }
});

describe('lock-shape parity: readLock() and readLockIds() agree (#1153 P7)', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'lock-shape-'));
    mkdirSync(join(tmp, '.orchestrator'), { recursive: true });
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  const writeLock = (obj) => {
    writeFileSync(join(tmp, '.orchestrator', 'session.lock'), JSON.stringify(obj));
  };

  // `readLockIds` is module-private; `readOwnSessionIds` is its only exported
  // path. The env var is neutralised so ONLY the lock tier can contribute.
  const lockTierIds = () => {
    const saved = process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    try {
      return readOwnSessionIds(tmp);
    } finally {
      if (saved !== undefined) process.env.CLAUDE_CODE_SESSION_ID = saved;
    }
  };

  for (const [name, mutate, expected] of FIXTURES) {
    it(`agrees on: ${name}`, () => {
      const fixture = build(mutate);
      writeLock(fixture);
      const parsed = readLock({ repoRoot: tmp }) !== null;
      const ids = lockTierIds();
      expect(parsed).toBe(expected);
      expect(ids.size > 0).toBe(expected);
      expect(ids.size > 0).toBe(parsed);
      if (expected) expect(ids.has(VALID.session_id)).toBe(true);
    });
  }

  it('agrees on invalid JSON and on a missing file', () => {
    writeFileSync(join(tmp, '.orchestrator', 'session.lock'), '{not json');
    expect(readLock({ repoRoot: tmp })).toBeNull();
    expect(lockTierIds().size).toBe(0);

    rmSync(join(tmp, '.orchestrator', 'session.lock'));
    expect(readLock({ repoRoot: tmp })).toBeNull();
    expect(lockTierIds().size).toBe(0);
  });
});
