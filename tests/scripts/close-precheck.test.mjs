/**
 * tests/scripts/close-precheck.test.mjs — #1661: `/close` decides on WHOSE
 * STATE.md it reads, not only on its status. #1718: when ownership is
 * unproven, a would-be session-end stops until confirmed with a token bound to
 * the STATE.md path and bytes. Wiring tests through the CLI the close skill
 * calls, with the real STATE.md parser and ledger reader.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { computeConfirmToken } from '../../scripts/lib/session-end/close-precheck.mjs';

const SCRIPT = resolve(process.cwd(), 'scripts/close-precheck.mjs');
const OWN = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'close-precheck-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeState({ status, sessionId }) {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  const lines = ['---', 'schema-version: 1', 'session: main-2026-10-17-session-8'];
  if (sessionId) lines.push(`session-id: ${sessionId}`);
  lines.push('started_at: 2026-10-17T07:07:32.409Z', `status: ${status}`, '---', '', '# STATE', '');
  writeFileSync(join(dir, '.claude', 'STATE.md'), lines.join('\n'));
}

function writeLedger(text) {
  mkdirSync(join(dir, '.orchestrator', 'metrics'), { recursive: true });
  writeFileSync(join(dir, '.orchestrator', 'metrics', 'sessions.jsonl'), text);
}

function writeLock(sessionId) {
  mkdirSync(join(dir, '.orchestrator'), { recursive: true });
  const at = '2026-10-17T07:07:32.409Z';
  writeFileSync(join(dir, '.orchestrator', 'session.lock'), `${JSON.stringify({
    session_id: sessionId, started_at: at, last_heartbeat: at, mode: 'deep',
    pid: 999999, host: 'test-host', ttl_hours: 4, semantic_session_id: 'peer-2026-10-17-session-3',
  })}\n`);
}

function run(ownId = OWN, extraArgs = [], repoRoot = dir) {
  const env = { ...process.env, SO_PLATFORM: 'claude', CLAUDE_CODE_SESSION_ID: ownId };
  delete env.CODEX_THREAD_ID;
  const r = spawnSync(process.execPath, [SCRIPT, '--repo-root', repoRoot, '--state-dir', '.claude', ...extraArgs], { env, encoding: 'utf8', timeout: 15_000 });
  return { code: r.status, out: r.status === 0 ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

describe('close-precheck — ownership (#1661)', () => {
  it('never hands a peer\'s active STATE.md to session-end', () => {
    writeState({ status: 'active', sessionId: OTHER });
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out).toMatchObject({ verdict: 'foreign', ownership: 'foreign', runsSessionEnd: false, stateSessionId: OTHER });
  });

  it('reads a completed STATE.md from before /clear as foreign, not as this session finalized', () => {
    writeState({ status: 'completed', sessionId: OTHER });
    writeLedger(`${JSON.stringify({ session_id: OTHER, status: 'completed' })}\n`);
    expect(run().out).toMatchObject({ verdict: 'foreign', runsSessionEnd: false });
  });

  it('own active STATE.md still runs session-end', () => {
    writeState({ status: 'active', sessionId: OWN });
    expect(run().out).toMatchObject({ verdict: 'run-session-end', ownership: 'own', runsSessionEnd: true });
  });

  it('STATE.md without session-id does not run session-end unconfirmed (#1718)', () => {
    writeState({ status: 'active' });
    expect(run().out).toMatchObject({
      verdict: 'ownership-unproven', ownership: 'legacy', wouldRun: 'run-session-end', runsSessionEnd: false,
    });
  });

  it('a process without a native id (Cursor, Pi) is never blocked as foreign, but must confirm (#1718)', () => {
    writeState({ status: 'active', sessionId: OTHER });
    expect(run('').out).toMatchObject({
      verdict: 'ownership-unproven', ownership: 'unprovable', ownSessionIds: [], runsSessionEnd: false,
    });
  });
});

describe('close-precheck — unproven ownership needs confirmation (#1718)', () => {
  it('a foreign old STATE.md without session-id and without a record is not closed (field case)', () => {
    writeState({ status: 'completed' });
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out).toMatchObject({
      verdict: 'ownership-unproven', runsSessionEnd: false, ownership: 'legacy',
      wouldRun: 'complete-missing-record',
      session: 'main-2026-10-17-session-8', startedAt: '2026-10-17T07:07:32.409Z',
    });
    expect(out.confirmToken).toMatch(/^[0-9a-f]{16}$/);
  });

  it('the token from the pre-check confirms and runs session-end', () => {
    writeState({ status: 'active' });
    const token = run().out.confirmToken;
    const statePath = join(dir, '.claude', 'STATE.md');
    expect(token).toBe(computeConfirmToken(statePath, readFileSync(statePath)));
    expect(run(OWN, ['--confirm-own', token]).out).toMatchObject({
      verdict: 'run-session-end', ownership: 'confirmed', runsSessionEnd: true,
    });
  });

  it('a token from before STATE.md changed does not confirm', () => {
    writeState({ status: 'active' });
    const token = run().out.confirmToken;
    // Body-only change, status stays active: the token covers the whole file, not the frontmatter.
    const statePath = join(dir, '.claude', 'STATE.md');
    writeFileSync(statePath, `${readFileSync(statePath, 'utf8')}- wave 2 done\n`);
    const { out } = run(OWN, ['--confirm-own', token]);
    expect(out).toMatchObject({ verdict: 'ownership-unproven', runsSessionEnd: false });
    expect(out.reason).toEqual(expect.any(String));
  });

  it('a token from another repo with a byte-identical STATE.md does not confirm', () => {
    writeState({ status: 'active' });
    const other = mkdtempSync(join(tmpdir(), 'close-precheck-other-'));
    try {
      mkdirSync(join(other, '.claude'), { recursive: true });
      writeFileSync(join(other, '.claude', 'STATE.md'), readFileSync(join(dir, '.claude', 'STATE.md')));
      const token = run(OWN, [], other).out.confirmToken;
      expect(token).toMatch(/^[0-9a-f]{16}$/);
      expect(run(OWN, ['--confirm-own', token]).out).toMatchObject({ verdict: 'ownership-unproven', runsSessionEnd: false });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('a matching token never overrides foreign', () => {
    writeState({ status: 'active', sessionId: OTHER });
    const statePath = join(dir, '.claude', 'STATE.md');
    const token = computeConfirmToken(statePath, readFileSync(statePath));
    expect(run(OWN, ['--confirm-own', token]).out).toMatchObject({ verdict: 'foreign', runsSessionEnd: false });
  });

  it('a malformed --confirm-own is a usage error', () => {
    writeState({ status: 'active' });
    const { code, out, stderr } = run(OWN, ['--confirm-own', 'xyz']);
    expect(code).toBe(2);
    expect(out).toBeNull();
    expect(stderr).toContain('--confirm-own needs a 16-hex token');
  });
});

describe('close-precheck — own completed STATE.md (#429)', () => {
  it('an abandoned backfill stub is not a completion', () => {
    writeState({ status: 'completed', sessionId: OWN });
    writeLedger(`${JSON.stringify({ session_id: OWN, status: 'abandoned' })}\n`);
    expect(run().out).toMatchObject({ verdict: 'complete-missing-record', runsSessionEnd: true });
  });

  it('a completed record stops the close', () => {
    writeState({ status: 'completed', sessionId: OWN });
    writeLedger(`${JSON.stringify({ session_id: OWN, status: 'completed' })}\n`);
    expect(run().out).toMatchObject({ verdict: 'already-finalized', runsSessionEnd: false });
  });

  it('a legacy record without status counts as the completion (no second session-end)', () => {
    writeState({ status: 'completed', sessionId: OWN });
    writeLedger(`${JSON.stringify({ session_id: OWN })}\n`);
    expect(run().out).toMatchObject({ verdict: 'already-finalized' });
  });

  it('legacy STATE.md + a peer\'s lock: the own record is found by label, no second session-end (#1663)', () => {
    writeState({ status: 'completed' });
    writeLock(OTHER);
    writeLedger(`${JSON.stringify({
      session_id: OWN, semantic_session_id: 'main-2026-10-17-session-8',
      started_at: '2026-10-17T07:07:32.409Z', status: 'completed',
    })}\n`);
    expect(run().out).toMatchObject({ verdict: 'already-finalized', ownership: 'legacy', runsSessionEnd: false });
  });

  it('a malformed ledger is inconclusive, never finalized or re-closed', () => {
    writeState({ status: 'completed', sessionId: OWN });
    writeLedger('{"session_id": broken\n');
    expect(run().out).toMatchObject({ verdict: 'inconclusive', runsSessionEnd: false });
  });
});

describe('close-precheck --record-without-plan (#1762)', () => {
  it('without the flag a foreign stop writes no record and prints no record key; with it, one closed-without-plan record', () => {
    writeState({ status: 'active', sessionId: OTHER });
    const plain = run();
    expect(plain.out.record).toBeUndefined();
    expect(existsSync(join(dir, '.orchestrator', 'metrics', 'sessions.jsonl'))).toBe(false);

    const flagged = run(OWN, ['--record-without-plan']);
    expect(flagged.code).toBe(0);
    expect(flagged.out).toMatchObject({ verdict: 'foreign', record: { written: true, verified: true, raw_session_id: OWN } });
    const lines = readFileSync(join(dir, '.orchestrator', 'metrics', 'sessions.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ status: 'closed-without-plan', close_reason: 'foreign', raw_session_id: OWN });
  });

  it('never records when the verdict hands off to session-end', () => {
    writeState({ status: 'active', sessionId: OWN });
    const { out } = run(OWN, ['--record-without-plan']);
    expect(out).toMatchObject({ verdict: 'run-session-end' });
    expect(out.record).toBeUndefined();
  });
});

describe('close skill wiring (#1661)', () => {
  it('the pre-check runs through scripts/close-precheck.mjs', () => {
    const skill = readFileSync(resolve(process.cwd(), 'skills/close/SKILL.md'), 'utf8');
    expect(skill).toContain('scripts/close-precheck.mjs');
  });
});
