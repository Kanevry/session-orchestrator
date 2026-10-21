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
import { spawn, spawnSync } from 'node:child_process';
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

/**
 * #1605 lifecycle fixture: a real repo `main` with linked worktrees `wt1`, `wt2`
 * under `<main>/.claude/worktrees/` (the EnterWorktree shape), an isolated host
 * registry, and a runner that spawns a real hook with `$CLAUDE_PROJECT_DIR` on
 * the launch checkout — exactly what the harness keeps after EnterWorktree.
 */
async function mkWorktreeFixture() {
  const main = await mkProject();
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: main, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  };
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  const wt1 = path.join(main, '.claude', 'worktrees', 'wt1');
  const wt2 = path.join(main, '.claude', 'worktrees', 'wt2');
  git('worktree', 'add', '-q', '-b', 'wt1-branch', wt1);
  git('worktree', 'add', '-q', '-b', 'wt2-branch', wt2);
  const registryDir = await mkProject();
  const run = (name, payload) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../../hooks', `${name}.mjs`)], {
      cwd: main,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: main,
        CLANK_EVENT_SECRET: undefined,
        CLANK_EVENT_URL: undefined,
        CLAUDE_CODE_SESSION_ID: undefined,
        SO_DISABLE_UPDATE_CHECK: '1',
        SO_SESSION_REGISTRY_DIR: registryDir,
        ...telemetryIsolationEnv(),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.resume();
    child.stderr.resume();
    child.on('close', resolve);
    child.stdin.end(JSON.stringify(payload));
  });
  const lockId = (root) => fs.readFile(path.join(root, LOCK_REL), 'utf8').then((t) => JSON.parse(t).session_id, () => null);
  const currentId = (root) => fs.readFile(path.join(root, '.orchestrator', 'current-session.json'), 'utf8')
    .then((t) => JSON.parse(t).session_id, () => null);
  return { main, wt1, wt2, registryDir, run, lockId, currentId };
}

/**
 * The issue's production sequence: session `a` starts at the launch checkout,
 * enters `wt` (its turn-end Stop fires there), then /clear ends `a` and starts
 * `b` with the payload `cwd` inside the worktree.
 */
async function enterWorktreeThenClear(fx, wt, a, b) {
  await fx.run('on-session-start', { session_id: a, source: 'startup', cwd: fx.main });
  await fx.run('on-stop', { session_id: a, cwd: wt, hook_event_name: 'Stop' });
  await fx.run('on-session-end', { session_id: a, reason: 'clear', cwd: wt });
  await fx.run('on-session-start', { session_id: b, source: 'clear', cwd: wt });
}

describe('relocated lock lifecycle after EnterWorktree (#1605)', { timeout: 60000 }, () => {
  it('acceptance: EnterWorktree then /clear → session.lock and current-session.json in the worktree, main checkout untouched by the new session', async () => {
    // The bug: `$CLAUDE_PROJECT_DIR` stays on the launch checkout, so the
    // SessionStart after /clear wrote the new lock there and blocked it 4 h.
    const fx = await mkWorktreeFixture();
    const a = U('1605-acc-a');
    const b = U('1605-acc-b');
    await enterWorktreeThenClear(fx, fx.wt1, a, b);

    expect(await fx.lockId(fx.wt1)).toBe(b);
    expect(await fx.currentId(fx.wt1)).toBe(b);
    expect(await fx.lockId(fx.main)).toBeNull();
    expect(await fx.currentId(fx.main)).toBe(a);
    const entry = JSON.parse(await fs.readFile(path.join(fx.registryDir, 'active', `${b}.json`), 'utf8'));
    expect(entry.session_root).toBe(await fs.realpath(fx.wt1));
  });

  it('PostToolBatch → Stop → SessionEnd heartbeat and release the worktree lock; the next session inherits nothing', async () => {
    // The bug (review MEDIUM 2 on the first #1605 fix): the readers heartbeated
    // and released only at the launch dir, so the worktree lock aged for 4 h.
    const fx = await mkWorktreeFixture();
    const lockFile = path.join(fx.wt1, LOCK_REL);
    const age = async () => {
      const lock = JSON.parse(await fs.readFile(lockFile, 'utf8'));
      lock.last_heartbeat = new Date(Date.now() - 3600_000).toISOString();
      await fs.writeFile(lockFile, JSON.stringify(lock));
      return Date.parse(lock.last_heartbeat);
    };
    const heartbeat = async () => Date.parse(JSON.parse(await fs.readFile(lockFile, 'utf8')).last_heartbeat);
    const first = U('1605-first');
    const next = U('1605-next');

    await fx.run('on-session-start', { session_id: first, source: 'clear', cwd: fx.wt1 });
    let aged = await age();
    await fx.run('post-tool-batch-wave-signal', { session_id: first, cwd: fx.wt1, hook_event_name: 'PostToolBatch' });
    expect(await heartbeat()).toBeGreaterThan(aged);
    aged = await age();
    await fx.run('on-stop', { session_id: first, cwd: fx.wt1, hook_event_name: 'Stop' });
    expect(await heartbeat()).toBeGreaterThan(aged);
    await fx.run('on-session-end', { session_id: first, reason: 'other', cwd: fx.wt1 });
    await expect(fs.access(lockFile)).rejects.toThrow();

    await fx.run('on-session-start', { session_id: next, source: 'clear', cwd: fx.wt1 });
    const current = JSON.parse(await fs.readFile(path.join(fx.wt1, '.orchestrator', 'current-session.json'), 'utf8'));
    expect(current.session_id).toBe(next);
    expect(current.conflict_with_session_id).toBeUndefined();
    expect(await fx.lockId(fx.wt1)).toBe(next);
  });

  it('s1 (B1): after ExitWorktree, Stop and SessionEnd with cwd = main checkout still heartbeat and release the worktree lock', async () => {
    // The bug: the readers searched launch root and payload cwd only; with cwd
    // back on the main checkout the relocated lock stayed as an orphan with a
    // fresh heartbeat, and a follow-up session in the worktree ran without one.
    const fx = await mkWorktreeFixture();
    const a = U('1605-s1-a');
    const b = U('1605-s1-b');
    await enterWorktreeThenClear(fx, fx.wt1, a, b);
    expect(await fx.lockId(fx.wt1)).toBe(b);
    const lockFile = path.join(fx.wt1, LOCK_REL);
    const lock = JSON.parse(await fs.readFile(lockFile, 'utf8'));
    lock.last_heartbeat = new Date(Date.now() - 60_000).toISOString();
    await fs.writeFile(lockFile, JSON.stringify(lock));
    const aged = Date.parse(lock.last_heartbeat);

    await fx.run('on-stop', { session_id: b, cwd: fx.main, hook_event_name: 'Stop' });
    expect(Date.parse(JSON.parse(await fs.readFile(lockFile, 'utf8')).last_heartbeat)).toBeGreaterThan(aged);
    await fx.run('on-session-end', { session_id: b, reason: 'other', cwd: fx.main });

    expect(await fx.lockId(fx.wt1)).toBeNull();
    expect(await fx.lockId(fx.main)).toBeNull();
  });

  it('#1630: a resume from the main checkout does not follow the pointer to its own worktree lock past its TTL', async () => {
    // The bug: the session died without SessionEnd; hours later `resume` from
    // the main checkout followed the registry pointer back into wt1 (heartbeat
    // refreshed there) although the lock there had long expired — past every
    // target check a relocation must pass.
    const fx = await mkWorktreeFixture();
    const a = U('1630-resume-a');
    const b = U('1630-resume-b');
    await enterWorktreeThenClear(fx, fx.wt1, a, b);
    const lockFile = path.join(fx.wt1, LOCK_REL);
    const lock = JSON.parse(await fs.readFile(lockFile, 'utf8'));
    lock.last_heartbeat = new Date(Date.now() - 5 * 3600_000).toISOString();
    await fs.writeFile(lockFile, JSON.stringify(lock));

    await fx.run('on-session-start', { session_id: b, source: 'resume', cwd: fx.main });

    expect(JSON.parse(await fs.readFile(lockFile, 'utf8')).last_heartbeat).toBe(lock.last_heartbeat);
    expect(await fx.lockId(fx.main)).toBe(b);
  });

  it('#1630 review: a compact from the main checkout follows its own pointer even to a worktree lock past its TTL', async () => {
    // The bug: the TTL check on the pointer applied to every source, so a
    // compact after > 4 h idle (cwd = main after ExitWorktree) dropped the
    // pointer, took a second lock at main and orphaned the one in wt1.
    const fx = await mkWorktreeFixture();
    const a = U('1630-compact-a');
    const b = U('1630-compact-b');
    await enterWorktreeThenClear(fx, fx.wt1, a, b);
    const lockFile = path.join(fx.wt1, LOCK_REL);
    const lock = JSON.parse(await fs.readFile(lockFile, 'utf8'));
    lock.last_heartbeat = new Date(Date.now() - 5 * 3600_000).toISOString();
    await fs.writeFile(lockFile, JSON.stringify(lock));

    await fx.run('on-session-start', { session_id: b, source: 'compact', cwd: fx.main });

    expect(await fx.lockId(fx.wt1)).toBe(b);
    expect(Date.parse(JSON.parse(await fs.readFile(lockFile, 'utf8')).last_heartbeat))
      .toBeGreaterThan(Date.parse(lock.last_heartbeat));
    expect(await fx.lockId(fx.main)).toBeNull();
  });

  it('#1630: after ExitWorktree the quality gate reads its own corrective_context beside the relocated lock', async () => {
    // The bug: readCorrectiveContext read `<repoRoot>/.orchestrator/current-session.json`
    // — on the main checkout that file names the predecessor, so the gate
    // discarded it as foreign and the fixer got none of its own failure hints.
    const fx = await mkWorktreeFixture();
    const a = U('1630-qg-a');
    const b = U('1630-qg-b');
    await enterWorktreeThenClear(fx, fx.wt1, a, b);
    await fx.run('post-tool-failure-corrective-context', {
      session_id: b, cwd: fx.main, tool_name: 'Bash', error: 'boom', exit_code: 1,
    });

    const qg = path.resolve(import.meta.dirname, '../../scripts/lib/quality-gate.mjs');
    const script = `const { runQualityGateWithRetry } = await import(${JSON.stringify(qg)});
let seen = null;
await runQualityGateWithRetry({ maxRetries: 1, repoRoot: process.cwd(),
  commands: { test: 'false', typecheck: 'true', lint: 'true' },
  dispatchFixer: async (x) => { seen = x.correctiveContext; } });
process.stdout.write(JSON.stringify(seen));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fx.main,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: fx.main,
        CLAUDE_CODE_SESSION_ID: b,
        SO_PLATFORM: 'claude',
        SO_SESSION_REGISTRY_DIR: fx.registryDir,
        ...telemetryIsolationEnv(),
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toHaveLength(1);
  });

  it('s2 (B2): compact after a cd into a second worktree keeps the one existing lock, no second lock', async () => {
    const fx = await mkWorktreeFixture();
    const a = U('1605-s2-a');
    const b = U('1605-s2-b');
    await enterWorktreeThenClear(fx, fx.wt1, a, b);

    await fx.run('on-session-start', { session_id: b, source: 'compact', cwd: fx.wt2 });

    expect(await fx.lockId(fx.wt1)).toBe(b);
    expect(await fx.lockId(fx.wt2)).toBeNull();
    expect(await fx.currentId(fx.wt2)).toBeNull();
  });

  it('s3 (B3): compact at the launch root leaves the current-session.json of a session newly started there alone', async () => {
    const fx = await mkWorktreeFixture();
    const a = U('1605-s3-a');
    const b = U('1605-s3-b');
    const c = U('1605-s3-c');
    await enterWorktreeThenClear(fx, fx.wt1, a, b);
    await fx.run('on-session-start', { session_id: c, source: 'startup', cwd: fx.main });
    expect(await fx.currentId(fx.main)).toBe(c);

    await fx.run('on-session-start', { session_id: b, source: 'compact', cwd: fx.main });

    expect(await fx.currentId(fx.main)).toBe(c);
    expect(await fx.lockId(fx.main)).toBe(c);
    expect(await fx.lockId(fx.wt1)).toBe(b);
  });

  it('s4 (B4): a /clear does not relocate into a worktree another live session entered by EnterWorktree (its state at its launch root)', async () => {
    // The bug: the "foreign live session in target" test saw only a lock or a
    // current-session.json IN the target; session x keeps both at the launch
    // checkout while it works in wt1, so y moved in on top of it.
    const fx = await mkWorktreeFixture();
    const x = U('1605-s4-x');
    const y = U('1605-s4-y');
    await fx.run('on-session-start', { session_id: x, source: 'startup', cwd: fx.main });
    await fx.run('on-stop', { session_id: x, cwd: fx.wt1, hook_event_name: 'Stop' });

    await fx.run('on-session-start', { session_id: y, source: 'clear', cwd: fx.wt1 });

    expect(await fx.lockId(fx.wt1)).toBeNull();
    expect(await fx.currentId(fx.wt1)).toBeNull();
  });

  it('B6: an unreadable host registry entry counts as a live session — no relocation', async () => {
    const fx = await mkWorktreeFixture();
    await fs.mkdir(path.join(fx.registryDir, 'active'), { recursive: true });
    await fs.writeFile(path.join(fx.registryDir, 'active', `${U('1605-b6-junk')}.json`), '{ not json');

    await fx.run('on-session-start', { session_id: U('1605-b6'), source: 'clear', cwd: fx.wt1 });

    expect(await fx.lockId(fx.wt1)).toBeNull();
  });

  it.each(['cwd-change-restore', 'post-tool-failure-corrective-context'])(
    'B5: %s annotates the relocated current-session.json, not the launch checkout',
    async (hook) => {
      const fx = await mkWorktreeFixture();
      const a = U(`1605-b5-a-${hook}`);
      const b = U(`1605-b5-b-${hook}`);
      await enterWorktreeThenClear(fx, fx.wt1, a, b);
      const mainBefore = await fs.readFile(path.join(fx.main, '.orchestrator', 'current-session.json'), 'utf8');

      await fx.run(hook, {
        session_id: b, cwd: fx.main, previous_cwd: fx.wt1, new_cwd: fx.main,
        tool_name: 'Bash', error: 'boom', exit_code: 1,
      });

      const wt = JSON.parse(await fs.readFile(path.join(fx.wt1, '.orchestrator', 'current-session.json'), 'utf8'));
      expect((wt.cwd_changes ?? wt.corrective_context ?? []).length).toBe(1);
      expect(await fs.readFile(path.join(fx.main, '.orchestrator', 'current-session.json'), 'utf8')).toBe(mainBefore);
    },
  );
});
