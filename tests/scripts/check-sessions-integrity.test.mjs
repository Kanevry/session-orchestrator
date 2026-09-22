/**
 * tests/scripts/check-sessions-integrity.test.mjs
 *
 * Suite for scripts/check-sessions-integrity.mjs — the CLI front-end for
 * `checkSessionsIntegrity` (GitLab #1417). It replaces the
 * `node --input-type=module -e` one-liner that session-end step 4a carried, so
 * what is under test is the CONTRACT that one-liner had: exit 0 when the named
 * record is sound, exit 1 when it is not, and other sessions' pre-existing
 * findings printed but never fatal.
 *
 * Isolation contract: every case builds its own tmp repo via mkdtemp. NOTHING
 * here derives a path from `process.cwd()` — the husky pre-push gate runs this
 * suite inside a materialised tree under $TMPDIR where cwd is NOT a checkout
 * (`.claude/rules/toolchain-and-build.md`), so a cwd-anchored path is red under
 * the hook and green in the checkout. The script under test is addressed
 * relative to THIS FILE via import.meta.url instead.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { parseArgs, runSessionsIntegrityCheck } from '../../scripts/check-sessions-integrity.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-sessions-integrity.mjs', import.meta.url));

let repoRoot;

/** A record that passes BOTH validateSession and the vault-mirror render path. */
function validRecord(sessionId) {
  return {
    schema_version: 1,
    session_id: sessionId,
    session_type: 'feature',
    started_at: '2026-09-21T08:00:00.000Z',
    completed_at: '2026-09-21T09:00:00.000Z',
    status: 'completed',
    total_waves: 1,
    waves: [{ wave: 1, role: 'Impl', agents_planned: 2, agents_started: 2, agents_completed: 2 }],
    agent_summary: { complete: 2, partial: 0, failed: 0, spiral: 0 },
    total_agents: 2,
    total_files_changed: 3,
    // REQUIRED by the vault-mirror render path (v1), OPTIONAL to
    // validateSession — the two populations this checker reports separately.
    effectiveness: { planned_issues: 1, completed_issues: 1, carryover: 0, completion_rate: 1 },
  };
}

/** The #1408 shape: parses as JSON, fails the schema (`ended_at`, no type). */
function brokenRecord(sessionId) {
  return { schema_version: 1, session_id: sessionId, ended_at: '2026-09-21T09:00:00.000Z' };
}

function seedLedger(records) {
  mkdirSync(join(repoRoot, '.orchestrator', 'metrics'), { recursive: true });
  writeFileSync(
    join(repoRoot, '.orchestrator', 'metrics', 'sessions.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''),
  );
}

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'check-sessions-integrity-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('parseArgs', () => {
  it('accepts the documented flags', () => {
    const { opts, error } = parseArgs(['--repo-root', '/tmp/x', '--session-id', 's1', '--json']);
    expect(error).toBeNull();
    expect(opts).toMatchObject({ repoRoot: '/tmp/x', sessionId: 's1', json: true });
  });

  // BUG THIS CATCHES: `--session-id` swallowing the next flag (or nothing) would
  // produce a filter matching no record — which, before the not-found branch
  // existed, read as "clean". A usage error must stay a usage error.
  it('rejects a value-taking flag with no value, and one followed by another flag', () => {
    expect(parseArgs(['--session-id']).error).toMatch(/requires a value/);
    expect(parseArgs(['--session-id', '--json']).error).toMatch(/requires a value/);
    expect(parseArgs(['--repo-root']).error).toMatch(/requires a value/);
  });

  it('rejects an unknown flag', () => {
    expect(parseArgs(['--nope']).error).toMatch(/unknown flag/);
  });
});

describe('runSessionsIntegrityCheck — verdict', () => {
  it('a clean ledger passes, with and without a filter', () => {
    seedLedger([validRecord('s1'), validRecord('s2')]);
    expect(runSessionsIntegrityCheck({ repoRoot })).toMatchObject({ ok: true, exitCode: 0, findings: [] });
    expect(runSessionsIntegrityCheck({ repoRoot, sessionId: 's1' })).toMatchObject({ ok: true, exitCode: 0, matched: 1 });
  });

  it('a broken record fails, and names itself in the findings', () => {
    seedLedger([brokenRecord('s-broken')]);
    const result = runSessionsIntegrityCheck({ repoRoot, sessionId: 's-broken' });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.sessionId === 's-broken')).toBe(true);
  });

  // THE FILTER IS THE POINT (the one-liner's contract): a pre-existing broken
  // record from an EARLIER session is printed but must never block this close —
  // otherwise every close stays red until someone runs the bulk repair.
  it('another session\'s broken record is reported but does not decide my verdict', () => {
    seedLedger([brokenRecord('s-old'), validRecord('s-mine')]);
    const mine = runSessionsIntegrityCheck({ repoRoot, sessionId: 's-mine' });
    expect(mine.ok).toBe(true);
    expect(mine.exitCode).toBe(0);
    expect(mine.message).toMatch(/s-old/); // still surfaced
    // …and with no filter the same ledger DOES fail: the exemption is the
    // filter's, not the checker's.
    expect(runSessionsIntegrityCheck({ repoRoot }).exitCode).toBe(1);
  });

  // THE FAIL-OPEN THIS CLOSES: `checkSessionsIntegrity` is silent both for a
  // sound record and for one that does not exist. Without this branch, a close
  // whose emit wrote nothing (or wrote a different id) would report success.
  it('a --session-id with NO record in the ledger fails, rather than passing silently', () => {
    seedLedger([validRecord('s-other')]);
    const result = runSessionsIntegrityCheck({ repoRoot, sessionId: 's-missing' });
    expect(result).toMatchObject({ ok: false, exitCode: 1, matched: 0 });
    expect(result.error).toMatch(/no record with session_id "s-missing"/);
  });

  it('an absent ledger is nothing to judge without a filter, and a miss with one', () => {
    expect(runSessionsIntegrityCheck({ repoRoot })).toMatchObject({ ok: true, exitCode: 0, total: null });
    expect(runSessionsIntegrityCheck({ repoRoot, sessionId: 's1' })).toMatchObject({ ok: false, exitCode: 1 });
  });

  it('an unparseable line is skipped, not treated as a finding', () => {
    mkdirSync(join(repoRoot, '.orchestrator', 'metrics'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.orchestrator', 'metrics', 'sessions.jsonl'),
      `${JSON.stringify(validRecord('s1'))}\n{"truncated":\n`,
    );
    expect(runSessionsIntegrityCheck({ repoRoot, sessionId: 's1' })).toMatchObject({ ok: true, exitCode: 0 });
  });

  it('a repo root that is not a directory is a TOOL error (exit 2), not a verdict', () => {
    const result = runSessionsIntegrityCheck({ repoRoot: join(repoRoot, 'nope') });
    expect(result.exitCode).toBe(2);
    expect(result.ok).toBe(false);
  });
});

describe('CLI surface', () => {
  it('--help exits 0 and documents the three exit codes', () => {
    const r = runCli(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/EXIT CODES/);
    expect(r.stdout).toMatch(/--session-id/);
  });

  it('an unknown flag exits 2 with the message on stderr, nothing on stdout', () => {
    const r = runCli(['--bogus']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown flag/);
    expect(r.stdout).toBe('');
  });

  it('--json prints ONE parseable object on stdout and mirrors the exit code', () => {
    seedLedger([validRecord('s1')]);
    const ok = runCli(['--repo-root', repoRoot, '--session-id', 's1', '--json']);
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ ok: true, exitCode: 0, sessionId: 's1', matched: 1 });

    seedLedger([brokenRecord('s1')]);
    const bad = runCli(['--repo-root', repoRoot, '--session-id', 's1', '--json']);
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, exitCode: 1 });
    expect(bad.stdout.trim().split('\n')).toHaveLength(1); // diagnostics stay on stderr
  });

  it('human mode keeps data on stdout and diagnostics on stderr', () => {
    seedLedger([brokenRecord('s1')]);
    const r = runCli(['--repo-root', repoRoot, '--session-id', 's1']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FAIL/);
    expect(r.stdout).toBe('');
  });

  // A bare import must have NO side effect: the module is imported by this
  // suite, and an `isMainModule`-less entry tail would run the check (and exit)
  // at import time — the silent-total failure shape is-main-module.mjs exists for.
  it('a bare import runs nothing and exits 0', () => {
    const probe = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(SCRIPT)}); await new Promise((r) => setTimeout(r, 700));`],
      { encoding: 'utf8', cwd: repoRoot },
    );
    expect(probe.status).toBe(0);
    expect(probe.stdout).toBe('');
    expect(probe.stderr).toBe('');
  });
});
