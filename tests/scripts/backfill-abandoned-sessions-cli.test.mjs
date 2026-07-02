/**
 * tests/scripts/backfill-abandoned-sessions-cli.test.mjs
 *
 * Vitest suite for scripts/backfill-abandoned-sessions.mjs — the one-time
 * historical migration CLI (#724 C1). Drives the REAL CLI subprocess against
 * an isolated tmp repo-root and asserts on the JSON summary, the on-disk
 * sessions.jsonl, exit codes, and the load-bearing idempotency contract.
 *
 * Testing-rule compliance (testing.md):
 *   - Behaviour over implementation: assertions target the summary + on-disk
 *     records + process exit codes, never internal call shapes.
 *   - Hardcoded expected values (counts, modes, statuses).
 *   - Real fixtures in tmp — NEVER the live .orchestrator store.
 *   - Error path (bad-arg) proves the exit-code contract from cli-design.md.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateSession } from '@lib/session-schema/validator.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'backfill-abandoned-sessions.mjs');

const UUID_1 = '11111111-2222-4333-8444-555555555555';
const UUID_2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SEM_1 = 'main-2026-07-02-session-1';
const SEM_2 = 'main-2026-07-02-session-2';
const STARTED_AT = '2026-07-02T09:00:00.000Z';

let tmp;

/** Two started+lock-acquired sessions with NO sessions.jsonl records. */
const TWO_ABANDONED_EVENTS = [
  { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID_1, branch: 'main', project: 'demo' },
  {
    timestamp: '2026-07-02T09:01:00.000Z',
    event: 'orchestrator.session.lock.acquired',
    session_id: UUID_1,
    semantic_session_id: SEM_1,
    mode: 'deep',
  },
  { timestamp: '2026-07-02T11:00:00.000Z', event: 'orchestrator.session.started', session_id: UUID_2, branch: 'main' },
  {
    timestamp: '2026-07-02T11:01:00.000Z',
    event: 'orchestrator.session.lock.acquired',
    session_id: UUID_2,
    semantic_session_id: SEM_2,
    mode: 'feature',
  },
];

function metricsFile(name) {
  return join(tmp, '.orchestrator', 'metrics', name);
}

function seedEvents(records) {
  mkdirSync(join(tmp, '.orchestrator', 'metrics'), { recursive: true });
  writeFileSync(metricsFile('events.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function readSessions() {
  const file = metricsFile('sessions.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

function runCli(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Parse the single-line JSON summary emitted with --json. */
function summaryOf(r) {
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'backfill-abandoned-cli-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (a) dry-run is the default — counts candidates, writes NOTHING
// ---------------------------------------------------------------------------

describe('backfill-abandoned-sessions CLI — dry-run (default)', () => {
  it('counts the abandoned candidates and writes no sessions.jsonl', () => {
    seedEvents(TWO_ABANDONED_EVENTS);

    const r = runCli(['--repo-root', tmp, '--json']);

    expect(r.status).toBe(0);
    const summary = summaryOf(r);
    expect(summary.mode).toBe('dry-run');
    expect(summary.total).toBe(2);
    expect(summary.would_backfill).toBe(2);
    expect(summary.backfilled).toBe(0);
    // Nothing written on disk.
    expect(existsSync(metricsFile('sessions.jsonl'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (b) --apply writes N validated stubs
// ---------------------------------------------------------------------------

describe('backfill-abandoned-sessions CLI — --apply', () => {
  it('appends one validated status:abandoned stub per candidate', () => {
    seedEvents(TWO_ABANDONED_EVENTS);

    const r = runCli(['--repo-root', tmp, '--apply', '--json']);

    expect(r.status).toBe(0);
    const summary = summaryOf(r);
    expect(summary.mode).toBe('apply');
    expect(summary.backfilled).toBe(2);
    expect(summary.errors).toBe(0);

    const records = readSessions();
    expect(records).toHaveLength(2);
    const ids = records.map((rec) => rec.session_id).sort();
    expect(ids).toEqual([SEM_1, SEM_2]);
    for (const rec of records) {
      expect(rec.status).toBe('abandoned');
      // Every written stub must itself re-validate (round-trip contract).
      expect(() => validateSession(rec)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// (c) idempotency — a second --apply writes nothing new
// ---------------------------------------------------------------------------

describe('backfill-abandoned-sessions CLI — idempotency', () => {
  it('re-running --apply performs 0 new writes (dedupe against recorded ids)', () => {
    seedEvents(TWO_ABANDONED_EVENTS);

    const first = runCli(['--repo-root', tmp, '--apply', '--json']);
    expect(first.status).toBe(0);
    expect(summaryOf(first).backfilled).toBe(2);
    expect(readSessions()).toHaveLength(2);

    const second = runCli(['--repo-root', tmp, '--apply', '--json']);
    expect(second.status).toBe(0);
    const summary = summaryOf(second);
    // Load-bearing contract: stable semantic ids are already recorded → skipped.
    expect(summary.backfilled).toBe(0);
    expect(summary.skipped['skipped-already-recorded']).toBe(2);
    // The store is unchanged — no duplicate abandoned stubs.
    expect(readSessions()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// (d) exit codes — bad-arg (1) and unreadable/absent store (graceful 0)
// ---------------------------------------------------------------------------

describe('backfill-abandoned-sessions CLI — exit codes', () => {
  it('exits 1 on an unknown flag (user/input error)', () => {
    const r = runCli(['--not-a-real-flag']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Unknown option/);
  });

  it('degrades gracefully (exit 0, zero candidates) when the events store is unreadable', () => {
    // events.jsonl seeded as a DIRECTORY → readFileSync would EISDIR; the CLI's
    // readJsonl swallows fs errors by design (never a partial-migration crash),
    // so an unreadable store yields an empty plan rather than a system error.
    mkdirSync(metricsFile('events.jsonl'), { recursive: true });

    const r = runCli(['--repo-root', tmp, '--json']);

    expect(r.status).toBe(0);
    const summary = summaryOf(r);
    expect(summary.total).toBe(0);
    expect(summary.would_backfill).toBe(0);
    expect(existsSync(metricsFile('sessions.jsonl'))).toBe(false);
  });
});
