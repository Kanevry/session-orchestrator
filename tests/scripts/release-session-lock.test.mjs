/**
 * release-session-lock.test.mjs — wiring tests for scripts/release-session-lock.mjs
 * (GitLab #1395).
 *
 * The CLI replaces a PROSE step (`skills/session-end/SKILL.md` § Phase 3.8) that
 * released the lock by hand and wrote no terminal event — measured 2026-09-19 in
 * this repo: 5 `orchestrator.session.lock.acquired`, 0 `…released`. So the tests
 * here drive the REAL binary as a child process and read the REAL ledger it
 * wrote: an in-process call to an exported helper would re-prove the helper, not
 * the command the skill file tells a coordinator to run.
 *
 * SAFETY: every run is pinned to an `mkdtemp` repo via `--repo-root`, which is
 * also the destination `emitEvent({ repoRoot })` writes to — no test touches the
 * real `.orchestrator/session.lock` or `.orchestrator/metrics/events.jsonl`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CLI = path.resolve(import.meta.dirname, '../../scripts/release-session-lock.mjs');
const LOCK_REL = path.join('.orchestrator', 'session.lock');
const EVENTS_REL = path.join('.orchestrator', 'metrics', 'events.jsonl');

const OWN_ID = '11111111-1111-4111-8111-111111111111';
const FOREIGN_ID = '22222222-2222-4222-8222-222222222222';
const SEMANTIC_ID = 'main-2026-09-20-session-3';

const tmpDirs = [];

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function mkRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'release-session-lock-'));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Seed a schema-v2 `session.lock` — the same field set `acquire()` writes, so
 * the fixture is the producer's shape and not the reader's assumption.
 */
async function seedLock(repoRoot, { sessionId = OWN_ID, semanticSessionId = SEMANTIC_ID } = {}) {
  await fs.mkdir(path.join(repoRoot, '.orchestrator'), { recursive: true });
  const now = new Date();
  await fs.writeFile(
    path.join(repoRoot, LOCK_REL),
    JSON.stringify({
      session_id: sessionId,
      started_at: new Date(now.getTime() - 3600_000).toISOString(),
      last_heartbeat: now.toISOString(),
      mode: 'deep',
      pid: 999999,
      host: os.hostname(),
      ttl_hours: 4,
      ...(semanticSessionId ? { semantic_session_id: semanticSessionId } : {}),
    }, null, 2) + '\n',
  );
}

function runCli(args, repoRoot) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        // The ledger destination is `--repo-root`; these two only guard the
        // fire-and-forget webhook in emitEvent from firing at a real endpoint.
        CLANK_EVENT_SECRET: undefined,
        CLANK_EVENT_URL: undefined,
        CLAUDE_PROJECT_DIR: repoRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function readEvents(repoRoot) {
  try {
    const raw = await fs.readFile(path.join(repoRoot, EVENTS_REL), 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function lockExists(repoRoot) {
  try {
    await fs.access(path.join(repoRoot, LOCK_REL));
    return true;
  } catch {
    return false;
  }
}

describe('scripts/release-session-lock.mjs (#1395)', { timeout: 15000 }, () => {
  // BUG: the Phase 3.8 prose released the lock and emitted nothing, so the
  // SessionEnd hook later saw `absent` and stayed silent too — a lock lifecycle
  // with no terminal event (5 acquired / 0 released in this repo). A release
  // that forgets the breadcrumb, or one that reads the ids AFTER the unlink
  // (emitEvent's lock-derived correlation then finds nothing, so
  // `semantic_session_id` silently disappears), reproduces exactly that gap.
  it('releases the own lock and writes ONE lock.released record carrying both ids and the caller', async () => {
    const repo = await mkRepo();
    await seedLock(repo);

    const res = await runCli(['--repo-root', repo, '--session-id', OWN_ID, '--json'], repo);

    expect(res.code).toBe(0);
    expect(await lockExists(repo)).toBe(false);
    expect(JSON.parse(res.stdout)).toEqual({
      ok: true,
      outcome: 'deleted',
      verified: true,
      session_id: OWN_ID,
      semantic_session_id: SEMANTIC_ID,
      event_emitted: true,
    });

    const released = (await readEvents(repo))
      .filter((e) => e.event === 'orchestrator.session.lock.released');
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({
      session_id: OWN_ID,
      semantic_session_id: SEMANTIC_ID,
      caller: 'session-end-phase-3-8',
      outcome: 'deleted',
      verified: true,
    });
  });

  // BUG: a release path that trusts the id it was handed deletes a LIVE peer's
  // lease in a shared working copy (PSA-005) — and, worse, records a
  // `lock.released` for a session that is still running, so the event stream
  // asserts a lifecycle end that never happened.
  it('refuses a lock owned by a different session: non-zero exit, lock untouched, no event', async () => {
    const repo = await mkRepo();
    await seedLock(repo);

    const res = await runCli(['--repo-root', repo, '--session-id', FOREIGN_ID, '--json'], repo);

    expect(res.code).not.toBe(0);
    expect(await lockExists(repo)).toBe(true);
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: false, outcome: 'session-mismatch' });
    expect(await readEvents(repo)).toEqual([]);
  });

  // BUG: an idempotent re-run (Phase 3.8 executed twice, or after the SessionEnd
  // hook already released) that emits anyway writes a second terminal event for a
  // lifecycle that already ended — inflating the very `released` count #1395
  // exists to make trustworthy.
  it('exits 0 with outcome=absent and writes NO event when there is no lock', async () => {
    const repo = await mkRepo();

    const res = await runCli(['--repo-root', repo, '--session-id', OWN_ID, '--json'], repo);

    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: true, outcome: 'absent' });
    expect(await readEvents(repo)).toEqual([]);
  });
});
