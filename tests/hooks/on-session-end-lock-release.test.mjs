/**
 * tests/hooks/on-session-end-lock-release.test.mjs
 *
 * #952 (A) — the SUCCESS breadcrumb `orchestrator.session.lock.released`.
 *
 * TV-001 — the bug this catches, which the existing suite does NOT:
 * a dead emit. Every other signal the hook produces is identical whether the
 * breadcrumb lands or not: the hook exits 0 by contract, the lock is deleted
 * either way, and `on-session-end.test.mjs`'s happy-path test asserts only the
 * ABSENCE of the failure events (`release_failed` / `reconcile_attempted`), so
 * it stays green with the emit removed, misplaced on the wrong branch, or
 * silently swallowed by its own best-effort `catch`. The entire forensic value
 * of #952 is that this LINE EXISTS in events.jsonl — a test that observes the
 * line is the only thing that can fail when it stops existing.
 *
 * No mocks: spawns the real hook against an isolated tmp project and reads the
 * real events.jsonl it wrote (TV-005 — wiring/contract test on the real
 * production call shape).
 *
 * Not covered here on purpose: `outcome: 'already-gone'`. In the hook, release()
 * is only ever reached when readLock() already returned a lock, so 'no-lock' is
 * a genuine readLock↔release race — not deterministically reproducible from the
 * outside, and faking it would only test the mock.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { telemetryIsolationEnv } from '../_helpers/telemetry-isolation.mjs';

/**
 * Deterministic, RFC-9562-shaped UUID for a readable fixture label — the hook
 * accepts a stdin `session_id` only when it parses as a UUID (#1091), and a
 * slug fixture would make the ownership compare this test names unreachable.
 */
function U(label) {
  const h = crypto.createHash('sha256').update(String(label)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const HOOK = path.resolve(import.meta.dirname, '../../hooks/on-session-end.mjs');
const EVENTS_REL = path.join('.orchestrator', 'metrics', 'events.jsonl');
const LOCK_REL = path.join('.orchestrator', 'session.lock');

const tmpDirs = [];

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function mkProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'on-session-end-release-'));
  tmpDirs.push(dir);
  return dir;
}

/** Seed a v2 session.lock owned by `sessionId`. */
async function seedLock(projectDir, { sessionId, semanticSessionId }) {
  const dir = path.join(projectDir, '.orchestrator');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'session.lock'),
    JSON.stringify({
      session_id: sessionId,
      started_at: new Date(Date.now() - 3600_000).toISOString(),
      last_heartbeat: new Date().toISOString(),
      mode: 'deep',
      pid: 999999,
      host: os.hostname(),
      ttl_hours: 4,
      semantic_session_id: semanticSessionId,
    }, null, 2) + '\n',
  );
}

async function readAllEvents(projectDir) {
  try {
    const raw = await fs.readFile(path.join(projectDir, EVENTS_REL), 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function runHook({ projectDir, stdin = '' }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        CLANK_EVENT_SECRET: undefined,
        CLANK_EVENT_URL: undefined,
        // #1138 — see the same guard in tests/hooks/on-session-end.test.mjs:
        // the hook flushes telemetry on every run, and an inherited HOME +
        // absent SO_TELEMETRY_ENDPOINT means the operator's real consent
        // record and the production endpoint. Verified by md5: without this,
        // a run of this file alone rewrote the real offline queue.
        ...telemetryIsolationEnv(),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.resume();
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin.end(stdin);
  });
}

describe('on-session-end.mjs — lock.released breadcrumb (#952)', { timeout: 15000 }, () => {
  it('writes an orchestrator.session.lock.released record when it deletes its OWN lock', async () => {
    const dir = await mkProject();
    await seedLock(dir, { sessionId: U('sess-released'), semanticSessionId: 'sem-released' });

    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({
        hook_event_name: 'SessionEnd',
        session_id: U('sess-released'),
        reason: 'clear',
      }),
    });

    expect(result.code).toBe(0);
    // Ground the breadcrumb against reality: the lock really is gone, so the
    // record below describes an actual deletion rather than an optimistic claim.
    await expect(fs.access(path.join(dir, LOCK_REL))).rejects.toThrow();

    const events = await readAllEvents(dir);
    const released = events.filter((e) => e.event === 'orchestrator.session.lock.released');
    expect(released).toHaveLength(1);
    expect(released[0]).toEqual(expect.objectContaining({
      session_id: U('sess-released'),
      lock_session_id: U('sess-released'),
      end_reason: 'clear',
      caller: 'on-session-end',
      outcome: 'deleted',
      verified: true,
    }));
  });
});
