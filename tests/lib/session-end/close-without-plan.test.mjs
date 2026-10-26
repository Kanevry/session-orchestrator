/**
 * tests/lib/session-end/close-without-plan.test.mjs — #1762: a `/close` whose
 * pre-check finds no own plan (`foreign`, `no-state`, …) left no
 * `sessions.jsonl` record at all. The writer records the closing session
 * itself, exactly once, and never collides with the SessionEnd backfill.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recordCloseWithoutPlan } from '../../../scripts/lib/session-end/close-without-plan.mjs';
import { classifyCloseState } from '../../../scripts/lib/session-end/close-precheck.mjs';
import { backfillAbandonedSession } from '../../../scripts/lib/session-close-backfill.mjs';
import { validateSession } from '../../../scripts/lib/session-schema/validator.mjs';

const OWN = '11111111-2222-4333-8444-555555555555';
const PEER = '99999999-8888-4777-8666-555555555555';
const LABEL = 'main-2026-10-23-session-4';
const STARTED = '2026-10-23T01:02:03.000Z';
const NOW = new Date('2026-10-23T03:00:00.000Z');
const env = { SO_PLATFORM: 'claude', CLAUDE_CODE_SESSION_ID: OWN };

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'close-without-plan-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const metrics = () => join(dir, '.orchestrator', 'metrics');
const ledgerLines = () => {
  const p = join(metrics(), 'sessions.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

function writeOwnEvents() {
  mkdirSync(metrics(), { recursive: true });
  const events = [
    { timestamp: STARTED, event: 'orchestrator.session.started', session_id: OWN, branch: 'main' },
    { timestamp: '2026-10-23T01:02:04.000Z', event: 'orchestrator.session.lock.acquired', session_id: OWN, semantic_session_id: LABEL },
    // A peer's label must never become this session's key.
    { timestamp: '2026-10-23T01:05:00.000Z', event: 'orchestrator.session.lock.acquired', session_id: PEER, semantic_session_id: 'peer-2026-10-23-session-9' },
  ];
  writeFileSync(join(metrics(), 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function foreignPrecheck() {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'STATE.md'), [
    '---', 'schema-version: 1', 'session: peer-2026-10-23-session-9', `session-id: ${PEER}`,
    'started_at: 2026-10-23T00:00:00.000Z', 'status: active', '---', '', '# STATE', '',
  ].join('\n'));
  return classifyCloseState({ repoRoot: dir, stateDir: '.claude', env });
}

const record = (precheck) => recordCloseWithoutPlan({ repoRoot: dir, precheck, env, now: () => NOW });

describe('recordCloseWithoutPlan (#1762)', () => {
  it('a foreign-STATE.md /close writes exactly one validated closed-without-plan record for this session; a second /close writes nothing', async () => {
    writeOwnEvents();
    const precheck = foreignPrecheck();
    expect(precheck.verdict).toBe('foreign');

    const first = await record(precheck);
    expect(first).toMatchObject({ written: true, verified: true, session_id: LABEL, raw_session_id: OWN });
    const lines = ledgerLines();
    expect(lines).toHaveLength(1);
    expect(() => validateSession(lines[0])).not.toThrow();
    expect(lines[0]).toMatchObject({
      session_id: LABEL, raw_session_id: OWN, status: 'closed-without-plan', close_reason: 'foreign',
      started_at: STARTED, completed_at: NOW.toISOString(), session_type: 'unknown', total_waves: 0,
      _backfill_source: 'close-without-plan',
    });
    expect(lines[0]._backfill_incomplete_fields).toBeUndefined();

    const second = await record(precheck);
    expect(second).toMatchObject({ written: false, reason: 'already-recorded' });
    expect(ledgerLines()).toHaveLength(1);
  });

  it('never records on a hand-off verdict — session-end writes that session\'s record', async () => {
    const out = await record({ verdict: 'run-session-end' });
    expect(out).toMatchObject({ written: false, reason: 'hand-off-verdict' });
    expect(ledgerLines()).toHaveLength(0);
  });

  it('without any own start evidence the record keys by the raw id and names started_at as incomplete', async () => {
    const out = await record({ verdict: 'no-state' });
    expect(out).toMatchObject({ written: true, verified: true, session_id: OWN });
    expect(ledgerLines()[0]).toMatchObject({ close_reason: 'no-state', _backfill_incomplete_fields: ['started_at'] });
  });

  it('the SessionEnd backfill writes nothing after the /close record (never two records for one session)', async () => {
    writeOwnEvents();
    expect((await record({ verdict: 'foreign' })).written).toBe(true);
    const backfill = await backfillAbandonedSession({ repoRoot: dir, sessionId: OWN, ownSessionIsEnding: true, now: NOW.getTime() });
    expect(['skipped-already-recorded', 'skipped-marker-exists']).toContain(backfill.action);
    expect(ledgerLines()).toHaveLength(1);
  });

  it('an own active plan misplaced under .orchestrator/STATE.md is not "no plan": no record (#1790)', async () => {
    writeOwnEvents();
    writeFileSync(join(dir, '.orchestrator', 'STATE.md'), [
      '---', 'schema-version: 1', `session: ${LABEL}`, `session-id: ${OWN}`,
      `started_at: ${STARTED}`, 'status: active', '---', '', '# STATE', '',
    ].join('\n'));
    const precheck = classifyCloseState({ repoRoot: dir, stateDir: '.claude', env });
    expect(precheck.verdict).toBe('no-state');
    expect(await record(precheck)).toMatchObject({
      written: false, reason: 'misplaced-plan', path: join(dir, '.orchestrator', 'STATE.md'),
    });
    expect(ledgerLines()).toHaveLength(0);
  });

  // MED-2 (#1790): a stale legacy .orchestrator/STATE.md (no session-id) must not
  // suppress the record of every later session; only an mtime at/after this
  // session's start (events: STARTED = 01:02:03Z) is evidence it is ours.
  const WRITTEN = { written: true, verified: true, raw_session_id: OWN };
  const REFUSED = { written: false, reason: 'misplaced-plan' };
  it.each([
    { ownership: 'own', mtime: '2026-10-23T00:00:00.000Z', expected: REFUSED, pathKey: 'path', lines: 0 },
    { ownership: 'legacy', mtime: '2026-10-23T00:00:00.000Z', expected: WRITTEN, pathKey: 'misplaced_path', lines: 1 },
    { ownership: 'legacy', mtime: '2026-10-23T02:00:00.000Z', expected: REFUSED, pathKey: 'path', lines: 0 },
    { ownership: 'foreign', mtime: '2026-10-23T02:00:00.000Z', expected: WRITTEN, pathKey: 'misplaced_path', lines: 1 },
  ])('misplaced plan ownership=$ownership, mtime=$mtime → $lines record(s)', async ({ ownership, mtime, expected, pathKey, lines }) => {
    writeOwnEvents();
    const misplacedPath = join(dir, '.orchestrator', 'STATE.md');
    writeFileSync(misplacedPath, '---\nstatus: active\n---\n');
    utimesSync(misplacedPath, new Date(mtime), new Date(mtime));
    const out = await record({ verdict: 'no-state', misplacedState: { path: misplacedPath, ownership } });
    expect(out).toMatchObject({ ...expected, [pathKey]: misplacedPath });
    expect(ledgerLines()).toHaveLength(lines);
  });

  it('without a native id the misplaced-plan branch is never reached: `unprovable` ends at no-native-id', async () => {
    const noIdEnv = { SO_PLATFORM: 'claude' };
    mkdirSync(join(dir, '.orchestrator'), { recursive: true });
    writeFileSync(join(dir, '.orchestrator', 'STATE.md'), '---\nschema-version: 1\nsession-id: x\nstatus: active\n---\n');
    const precheck = classifyCloseState({ repoRoot: dir, stateDir: '.claude', env: noIdEnv });
    expect(precheck.misplacedState).toMatchObject({ ownership: 'unprovable' });
    const out = await recordCloseWithoutPlan({ repoRoot: dir, precheck, env: noIdEnv, now: () => NOW });
    expect(out).toEqual({ written: false, reason: 'no-native-id' });
  });

  it('the /close record writes nothing after an abandoned stub for the same raw id', async () => {
    writeOwnEvents();
    const backfill = await backfillAbandonedSession({ repoRoot: dir, sessionId: OWN, ownSessionIsEnding: true, now: NOW.getTime() });
    expect(backfill.action).toBe('backfilled');
    expect(await record({ verdict: 'foreign' })).toMatchObject({ written: false, reason: 'already-recorded' });
    expect(ledgerLines()).toHaveLength(1);
  });
});
