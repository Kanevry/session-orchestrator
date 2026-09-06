/**
 * tests/lib/session-close-backfill-honesty.test.mjs — GitLab #1234, backfiller
 * honesty.
 *
 * THE BUG THIS NAMES: **a backfilled record claimed a session type it never
 * measured.** When `events.jsonl` carries no usable `mode`, `synthesizeRecord`
 * DEFAULTS `session_type` to `'housekeeping'`. Measured 2026-09-06, all 1.656
 * `abandoned` records in the 90-day fleet window carry
 * `_session_type_inferred: true` + `total_waves: 0`, and no organically written
 * `abandoned` record exists anywhere — the synthetic `abandoned/housekeeping`
 * label is what produced the "27 % close rate" figure that turned out to be an
 * artefact (the real rate is 21,3 %).
 *
 * STATE OF THE FIX (updated 2026-09-06, w3-p4). Both enums have since been
 * widened — `VALID_SESSION_TYPES` carries `unknown`, `SESSION_STATUS` carries
 * `unresolved` — and `synthesizeRecord()` now WRITES `session_type: 'unknown'`
 * for an unmeasurable type. The old `'housekeeping'` guess is gone from new
 * records; historical ones keep it verbatim, because sessions.jsonl is
 * append-only.
 *
 * `status` deliberately stays `'abandoned'`. Six executable phantom-stub filters
 * key on that literal (census in `scripts/lib/session-schema/validator.mjs`
 * § SESSION_STATUS); flipping the emitter before they accept both names would
 * make every new stub invisible to all six and re-open the #834
 * phantom-in-signal class. `_synthetic: true` still carries the claim no enum
 * can: this record was COMPOSED.
 *
 * The original 4th case, "PINS THE BLOCKER", asserted that the honest values
 * THROW. It was written to go red the moment somebody widened the enums — it
 * did exactly that, so it is RETIRED here (TV-002) and replaced by its inverse:
 * the honest values now validate, and the emitter writes the honest type.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { backfillAbandonedSession } from '@lib/session-close-backfill.mjs';
import { validateSession } from '@lib/session-schema/validator.mjs';
import { VALID_SESSION_TYPES } from '@lib/session-schema/constants.mjs';

const UUID = '11111111-2222-4333-8444-555555555555';
const STARTED_AT = '2026-05-27T14:00:00.000Z';
const NOW_MS = Date.parse('2026-05-27T18:30:00.000Z');

let repoRoot;
const tmpDirs = [];

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-honesty-'));
  tmpDirs.push(repoRoot);
});

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function seedEvents(records) {
  const file = path.join(repoRoot, '.orchestrator', 'metrics', 'events.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function readSessions() {
  const file = path.join(repoRoot, '.orchestrator', 'metrics', 'sessions.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Events with a lock.acquired that carries NO mode → the type is unmeasurable. */
function seedWithoutMode() {
  seedEvents([
    { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
    {
      timestamp: '2026-05-27T14:01:00.000Z',
      event: 'orchestrator.session.lock.acquired',
      session_id: UUID,
      semantic_session_id: 'main-2026-05-27-session-1',
    },
    { timestamp: '2026-05-27T17:00:00.000Z', event: 'orchestrator.session.ended', session_id: UUID, reason: 'clear' },
  ]);
}

describe('a backfilled record never claims a session type it did not measure', () => {
  it('THE BUG: an unmeasurable type is marked _synthetic, not passed off as a measurement', async () => {
    seedWithoutMode();
    const res = await backfillAbandonedSession({ repoRoot, sessionId: UUID, now: NOW_MS });
    expect(res.action).toBe('backfilled');

    const rec = readSessions()[0];
    // The honest value, not the old `'housekeeping'` guess (see header).
    expect(rec.session_type).toBe('unknown');
    // …and it is still flagged as composed, by TWO independent markers.
    expect(rec._session_type_inferred).toBe(true);
    expect(rec._synthetic).toBe(true);
    // A consumer filtering on `_synthetic !== true` sees no unmeasured type at all.
    expect([rec].filter((r) => r._synthetic !== true)).toEqual([]);
  });

  it('a MEASURED type is not flagged — the marker separates the two populations', async () => {
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
      {
        timestamp: '2026-05-27T14:01:00.000Z',
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID,
        semantic_session_id: 'main-2026-05-27-session-1',
        mode: 'feature',
      },
      { timestamp: '2026-05-27T17:00:00.000Z', event: 'orchestrator.session.ended', session_id: UUID, reason: 'clear' },
    ]);
    const res = await backfillAbandonedSession({ repoRoot, sessionId: UUID, now: NOW_MS });
    expect(res.action).toBe('backfilled');

    const rec = readSessions()[0];
    expect(rec.session_type).toBe('feature');
    expect(rec._session_type_inferred).toBeUndefined();
    expect(rec._synthetic).toBeUndefined();
  });

  it('the flagged record still validates (the marker is additive, not a schema break)', async () => {
    seedWithoutMode();
    await backfillAbandonedSession({ repoRoot, sessionId: UUID, now: NOW_MS });
    expect(() => validateSession(readSessions()[0])).not.toThrow();
  });

  it('the honest values now VALIDATE — the retired blocker, inverted', () => {
    // RETIRED + INVERTED (TV-002). The predecessor asserted these two throw, so
    // that widening the enums would go red and remind someone to finish the job.
    // It fired, the job is finished, and asserting the old blocker again would
    // now pin a defect instead of a contract. The bug this inverted case names
    // is the REGRESSION: re-narrowing either enum silently re-breaks the
    // backfiller, which validates every record it appends — it would then write
    // NOTHING at all rather than error visibly.
    expect(VALID_SESSION_TYPES).toContain('unknown');
    const base = {
      session_id: 'main-2026-05-27-session-1',
      session_type: 'housekeeping',
      started_at: STARTED_AT,
      completed_at: '2026-05-27T17:00:00.000Z',
      total_waves: 0,
      waves: [],
      agent_summary: { complete: 0, partial: 0, failed: 0, spiral: 0 },
      total_agents: 0,
      total_files_changed: 0,
      status: 'abandoned',
      effectiveness: { carryover: null },
    };
    expect(() => validateSession({ ...base, session_type: 'unknown' })).not.toThrow();
    expect(() => validateSession({ ...base, status: 'unresolved' })).not.toThrow();
    // A value outside the widened enums must STILL be rejected — widening is not
    // the same as opening, and a typo'd type is exactly what the enum catches.
    expect(() => validateSession({ ...base, session_type: 'unknwon' })).toThrow(/session_type/);
    expect(() => validateSession({ ...base, status: 'unfinished' })).toThrow(/status/);
  });

  it('status stays `abandoned` while the six phantom-stub filters key on that literal', () => {
    // Names the regression the deferred half would cause: `isRealSession()`
    // (scripts/lib/session-schema/filters.mjs) and five sibling filters drop a
    // stub only when `status === 'abandoned'`. An emitter that switched to
    // `'unresolved'` before they accept both would let every new phantom back
    // into the signal windows — silently, since none of them errors on an
    // unrecognised status.
    seedWithoutMode();
    return backfillAbandonedSession({ repoRoot, sessionId: UUID, now: NOW_MS }).then(() => {
      expect(readSessions()[0].status).toBe('abandoned');
    });
  });
});

describe('the terminal-event probe accepts BOTH stop-event names', () => {
  it('orchestrator.turn.stopped supplies an attested completed_at (not an estimate)', async () => {
    // Post-rename shape: only the NEW name is present. Before the fix this fell
    // through to the flagged lastEventMs estimate for every session.
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
      {
        timestamp: '2026-05-27T14:01:00.000Z',
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID,
        semantic_session_id: 'main-2026-05-27-session-1',
        mode: 'deep',
      },
      { timestamp: '2026-05-27T16:30:00.000Z', event: 'orchestrator.turn.stopped', session_id: UUID },
    ]);
    const res = await backfillAbandonedSession({ repoRoot, sessionId: UUID, now: NOW_MS });
    expect(res.action).toBe('backfilled');

    const rec = readSessions()[0];
    expect(rec.completed_at).toBe('2026-05-27T16:30:00.000Z');
    expect(rec._completed_at_estimated).toBeUndefined();
    expect(rec._backfill_incomplete_fields).not.toContain('completed_at');
  });
});
