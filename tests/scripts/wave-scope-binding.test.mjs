/**
 * tests/scripts/wave-scope-binding.test.mjs
 *
 * Regression tests for scripts/wave-scope-binding.mjs (#1153 P4).
 *
 * The bug each test catches (TV-001):
 *   1. an empty id written as `"session": ""` instead of the key being OMITTED —
 *      present-but-equal-to-nobody, which every reader classifies as FOREIGN and
 *      therefore skips enforcement entirely
 *   2. the UNBOUND case staying silent, which is what made a coordinator that
 *      skipped this step indistinguishable from one that ran it (0
 *      `orchestrator.scope.unbound_manifest` hits repo-wide before #1153)
 *   3. the event firing on the BOUND path too, which would make the counter
 *      useless as a signal
 *
 * Every run points the emitter at a tmp repoRoot — never this repo's own
 * `.orchestrator/metrics/events.jsonl`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../../scripts/wave-scope-binding.mjs', import.meta.url).pathname;

const OWN_ID = 'OWN-UUID-2222';

describe('wave-scope-binding CLI (#1153 P4)', () => {
  let tmp;

  const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: tmp,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: OWN_ID, ...env },
    timeout: 20_000,
  });

  const writeLock = (fields) => {
    mkdirSync(join(tmp, '.orchestrator'), { recursive: true });
    writeFileSync(
      join(tmp, '.orchestrator', 'session.lock'),
      JSON.stringify({
        started_at: new Date().toISOString(),
        mode: 'session',
        pid: process.pid,
        host: 'test-host',
        ttl_hours: 4,
        ...fields,
      }),
    );
  };

  const readEvents = () => {
    const f = join(tmp, '.orchestrator', 'metrics', 'events.jsonl');
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wsb-'));
  });

  afterEach(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('prints both binding keys and emits NO event when the lock names this process', () => {
    writeLock({ session_id: OWN_ID, semantic_session_id: 'main-2026-01-01-session-1' });
    const res = run(['--wave', '2', '--role', 'Impl-Core', '--repo-root', tmp]);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual({
      session_id: OWN_ID,
      semantic_session_id: 'main-2026-01-01-session-1',
    });
    expect(readEvents().filter((e) => e.event === 'orchestrator.scope.unbound_manifest')).toHaveLength(0);
  });

  it('OMITS an unavailable key rather than writing an empty string', () => {
    // `semantic_session_id` absent from the lock → the key must not appear at
    // all. `"semantic_session_id": ""` would read as FOREIGN to every consumer.
    writeLock({ session_id: OWN_ID });
    const res = run(['--repo-root', tmp]);
    const out = JSON.parse(res.stdout.trim());
    expect(out.session_id).toBe(OWN_ID);
    expect(Object.keys(out)).not.toContain('semantic_session_id');
  });

  it('prints {} and emits exactly one unbound_manifest event when no lock exists', () => {
    const res = run(['--wave', '3', '--role', 'Discovery', '--repo-root', tmp]);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual({});

    const events = readEvents().filter((e) => e.event === 'orchestrator.scope.unbound_manifest');
    expect(events).toHaveLength(1);
    expect(events[0].wave).toBe(3);
    expect(events[0].role).toBe('Discovery');
    expect(events[0].reason).toBe('no-confirmed-session-attribution');
  });

  // --merge (#1207): the coordinator used to copy two keys out of the printed
  // object into the manifest JSON by hand. The bug that catches (TV-001): a
  // hand-merge that keeps a key whose value is unavailable writes
  // `"session_id": ""` (FOREIGN to every reader → enforcement skipped), or
  // silently drops a field of the draft it was supposed to pass through.
  const runMerge = (draft, args = []) => spawnSync(
    process.execPath,
    [CLI, '--merge', ...args],
    {
      encoding: 'utf8',
      cwd: tmp,
      input: typeof draft === 'string' ? draft : JSON.stringify(draft),
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: OWN_ID },
      timeout: 20_000,
    },
  );

  const DRAFT = {
    wave: 9,
    role: 'Impl-Core',
    enforcement: 'strict',
    allowedPaths: ['scripts/example.mjs'],
    blockedCommands: ['rm -rf'],
  };

  it('--merge with a lock present: binding keys added, every other field untouched', () => {
    writeLock({ session_id: OWN_ID, semantic_session_id: 'main-2026-01-01-session-1' });
    const res = runMerge(DRAFT, ['--wave', '9', '--role', 'Impl-Core', '--repo-root', tmp]);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual({
      ...DRAFT,
      session_id: OWN_ID,
      semantic_session_id: 'main-2026-01-01-session-1',
    });
    expect(readEvents().filter((e) => e.event === 'orchestrator.scope.unbound_manifest')).toHaveLength(0);
  });

  it('--merge drops LEGACY binding keys too — a stale `session`/`semantic_session` pair must not name a foreign session (close-review 2026-09-04 HIGH)', () => {
    writeLock({ session_id: OWN_ID, semantic_session_id: 'main-2026-01-01-session-1' });
    const stale = { ...DRAFT, session: 'peer-session-x', semantic_session: 'peer-sem', session_id: 'stale' };
    const res = runMerge(stale, ['--wave', '9', '--role', 'Impl-Core', '--repo-root', tmp]);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout.trim());
    expect(out).not.toHaveProperty('session');
    expect(out).not.toHaveProperty('semantic_session');
    expect(out.session_id).toBe(OWN_ID);
  });

  it('--merge without a lock: keys ABSENT (never ""), draft intact, one unbound event', () => {
    const res = runMerge(DRAFT, ['--wave', '9', '--role', 'Impl-Core', '--repo-root', tmp]);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout.trim());
    expect(out).toEqual(DRAFT);
    expect(Object.keys(out)).not.toContain('session_id');
    expect(Object.keys(out)).not.toContain('semantic_session_id');

    const events = readEvents().filter((e) => e.event === 'orchestrator.scope.unbound_manifest');
    expect(events).toHaveLength(1);
    expect(events[0].wave).toBe(9);
  });

  it('--merge DROPS a stale binding key when the binding is unbound', () => {
    // A re-run over an already-bound manifest under a peer-owned lock must not
    // leave the previous id standing — the merged manifest names nobody.
    writeLock({ session_id: 'PEER-UUID-1111' });
    const res = runMerge({ ...DRAFT, session_id: 'STALE-ID' }, ['--repo-root', tmp]);
    expect(JSON.parse(res.stdout.trim())).toEqual(DRAFT);
  });

  it('--merge rejects stdin that is not one JSON object', () => {
    writeLock({ session_id: OWN_ID });
    for (const bad of ['not json', '[1,2]', '"str"']) {
      const res = runMerge(bad, ['--repo-root', tmp]);
      expect(res.status).toBe(1);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain('ONE JSON object on stdin');
    }
  });

  it('prints {} for a PEER-owned lock — a foreign id is never handed back', () => {
    // The fail-closed direction: `attributionForRecord()` confirms the lock's
    // raw id against this process's own identity and returns {} on a mismatch.
    writeLock({ session_id: 'PEER-UUID-1111', semantic_session_id: 'main-2026-01-01-session-9' });
    const res = run(['--wave', '3', '--role', 'Impl', '--repo-root', tmp]);
    expect(JSON.parse(res.stdout.trim())).toEqual({});
    expect(readEvents().filter((e) => e.event === 'orchestrator.scope.unbound_manifest')).toHaveLength(1);
  });
});
