/**
 * tests/hooks/on-stop.test.mjs
 *
 * Tests for hooks/on-stop.mjs — consolidated Stop + SubagentStop hook (issue #141).
 *
 * Strategy: spawn `node hooks/on-stop.mjs` with a controlled stdin, then read the
 * written events.jsonl to verify the record shape. Each test gets an isolated tmp
 * project dir so parallel runs cannot interfere with each other.
 *
 * Covered cases:
 *   1. Stop with session_id — record has event="orchestrator.session.stopped", session_id, wave, duration_ms
 *   2. Stop without session_id — record has event="orchestrator.session.stopped", no session_id key
 *   3. SubagentStop with agent_type — record has event="orchestrator.agent.stopped", agent=<type>
 *   4. Missing / empty stdin — exits 0, writes a stop record (graceful degradation)
 *   5. git info unavailable (non-git dir) — exits 0, record omits branch/commit
 *   6. Discriminator via hook_event_name="SubagentStop" — writes subagent_stop record
 *   7. webhook fetch not called when CLANK_EVENT_SECRET is unset
 *   8. webhook fetch called when CLANK_EVENT_SECRET is set
 *   9. missing node_modules degrades gracefully (GH Kanevry/session-orchestrator#63)
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { isRoot } from '../_helpers/perms.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Deterministic, RFC-9562-shaped UUID for a readable fixture label.
 *
 * WHY the fixture ids below are UUIDs and not plain slugs (#1091 / Kanevry#66):
 * `resolveSessionId()` now accepts a stdin `session_id` only when it parses as
 * a UUID — mirroring the writer in `hooks/on-session-start.mjs`, which is what
 * keys every artifact this hook then refreshes (the host-registry entry and
 * `session.lock`). A slug fixture would be DROPPED by the hook, so each
 * "refreshed / not refreshed" assertion below would pass because the id
 * resolved to `null` rather than because the ownership compare it names held.
 *
 * Derived from sha256(label) so the value is stable across runs, and shaped
 * `…-4xxx-8xxx-…` (version 4, variant `10xx`) so it satisfies `UUID_RE` in
 * `scripts/lib/session-id.mjs`.
 */
function U(label) {
  const h = crypto.createHash('sha256').update(String(label)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const HOOK = path.resolve(import.meta.dirname, '../../hooks/on-stop.mjs');
const EVENTS_REL = path.join('.orchestrator', 'metrics', 'events.jsonl');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the hook subprocess with CLAUDE_PROJECT_DIR pointed at projectDir.
 * Returns { code, stdout, stderr }.
 */
async function runHook({ projectDir, stdin = '', env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        // Never fire real webhooks during tests
        CLANK_EVENT_SECRET: undefined,
        CLANK_EVENT_URL: undefined,
        // A spawned hook otherwise inherits the OPERATOR's live session id from
        // the ambient env, so an assertion about identity resolution could pass
        // on the real session rather than on the fixture.
        CLAUDE_CODE_SESSION_ID: undefined,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));

    if (stdin) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Create a temporary directory (no git init — used for git-unavailable test).
 */
async function mkTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'on-stop-test-'));
}

/**
 * Create a temporary directory WITH a git repo (for normal operation tests).
 */
async function mkGitDir() {
  const dir = await mkTmpDir();
  // Minimal git init so `git rev-parse HEAD` can at least find the repo.
  // We don't commit, so HEAD may not exist — that's fine; gitInfo() handles the error.
  const { $ } = await import('zx');
  $.verbose = false;
  $.quiet = true;
  try {
    await $`git -C ${dir} init -q`;
  } catch {
    // git unavailable in this environment — plain dir is fine
  }
  return dir;
}

/**
 * Create a temporary git repo WITH a committed HEAD so `git rev-parse HEAD`
 * resolves a real SHA. Returns { dir, committed } where committed=false means
 * git was unavailable (caller should skip the assertion).
 */
async function mkCommittedGitDir() {
  const dir = await mkTmpDir();
  const { $ } = await import('zx');
  $.verbose = false;
  $.quiet = true;
  try {
    await $`git -C ${dir} init -q`;
    await $`git -C ${dir} config user.email test@example.com`;
    await $`git -C ${dir} config user.name Test`;
    await $`git -C ${dir} commit --allow-empty -q -m probe`;
    return { dir, committed: true };
  } catch {
    return { dir, committed: false };
  }
}

/**
 * Read and parse the last JSONL line written to <projectDir>/.orchestrator/metrics/events.jsonl.
 */
async function readLastEvent(projectDir) {
  const filePath = path.join(projectDir, EVENTS_REL);
  const content = await fs.readFile(filePath, 'utf8');
  const lines = content.trim().split('\n').filter((l) => l.length > 0);
  return JSON.parse(lines[lines.length - 1]);
}

/**
 * Read all JSONL lines from events.jsonl.
 */
async function readAllEvents(projectDir) {
  const filePath = path.join(projectDir, EVENTS_REL);
  const content = await fs.readFile(filePath, 'utf8');
  return content.trim().split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const tmpDirs = [];
let origRegistryDir;

beforeEach(async () => {
  // Isolate session registry for every test (#169) so deregisterSelf never
  // touches the real user's ~/.config/session-orchestrator/sessions/active/.
  origRegistryDir = process.env.SO_SESSION_REGISTRY_DIR;
  const registryTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'on-stop-registry-'));
  process.env.SO_SESSION_REGISTRY_DIR = registryTmp;
  tmpDirs.push(registryTmp);
});

afterEach(async () => {
  if (origRegistryDir === undefined) delete process.env.SO_SESSION_REGISTRY_DIR;
  else process.env.SO_SESSION_REGISTRY_DIR = origRegistryDir;
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function track(dir) {
  tmpDirs.push(dir);
  return dir;
}

/**
 * Seed one registry entry. `ageMinutes` backdates BOTH started_at and
 * last_heartbeat so a refresh is observable as a strict increase rather than
 * relying on sub-millisecond spawn timing.
 */
async function writeHeartbeat(sessionId, { ageMinutes = 0 } = {}) {
  const active = path.join(process.env.SO_SESSION_REGISTRY_DIR, 'active');
  await fs.mkdir(active, { recursive: true });
  const stamp = new Date(Date.now() - ageMinutes * 60_000).toISOString();
  await fs.writeFile(
    path.join(active, `${sessionId}.json`),
    JSON.stringify({
      session_id: sessionId,
      pid: process.pid,
      repo_name: 'demo',
      branch: 'main',
      started_at: stamp,
      last_heartbeat: stamp,
      status: 'active',
      current_wave: 0,
    }),
  );
}

async function registryFiles() {
  const active = path.join(process.env.SO_SESSION_REGISTRY_DIR, 'active');
  return (await fs.readdir(active).catch(() => [])).filter((n) => n.endsWith('.json'));
}

/** Read one registry entry as an object. */
async function readEntry(sessionId) {
  const active = path.join(process.env.SO_SESSION_REGISTRY_DIR, 'active');
  return JSON.parse(await fs.readFile(path.join(active, `${sessionId}.json`), 'utf8'));
}

/** Read sweep.log as parsed JSONL records (empty array when absent). */
async function readSweepLog(baseDir = process.env.SO_SESSION_REGISTRY_DIR) {
  const raw = await fs.readFile(path.join(baseDir, 'sweep.log'), 'utf8').catch(() => '');
  return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// 1. Stop with session_id
// ---------------------------------------------------------------------------

describe('Stop event with session_id', { timeout: 15000 }, () => {
  it('writes the complete session-stopped record for a session payload', async () => {
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: U('sess-abc123') }),
    });

    const record = await readLastEvent(dir);
    expect(record).toMatchObject({
      event: 'orchestrator.session.stopped',
      session_id: U('sess-abc123'),
      wave: 0,
    });
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // K5 — with no session.lock in this fixture the span is UNMEASURABLE, so
    // both keys are omitted. The old code wrote a hard `duration_ms: 0`, which
    // is why 8.127 of 8.127 fleet records carried a fabricated zero.
    expect(Object.hasOwn(record, 'duration_ms')).toBe(false);
    expect(Object.hasOwn(record, 'duration_source')).toBe(false);
    expect(Number.isInteger(record.wave)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Stop without session_id
// ---------------------------------------------------------------------------

describe('Stop event without session_id', { timeout: 15000 }, () => {
  it('writes a stop record and omits the session_id key', async () => {
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ wave: 2 }),
    });
    const record = await readLastEvent(dir);
    expect(record.event).toBe('orchestrator.session.stopped');
    expect(Object.prototype.hasOwnProperty.call(record, 'session_id')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. SubagentStop with agent_type (discriminated by field presence)
// ---------------------------------------------------------------------------

describe('SubagentStop via agent_type field', { timeout: 15000 }, () => {
  it('writes the complete agent-stopped record for an agent payload', async () => {
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ agent_type: 'test-writer' }),
    });

    const record = await readLastEvent(dir);
    expect(record).toMatchObject({
      event: 'orchestrator.agent.stopped',
      agent: 'test-writer',
    });
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ---------------------------------------------------------------------------
// 4. SubagentStop via hook_event_name discriminator
// ---------------------------------------------------------------------------

describe('hook_event_name discriminator', { timeout: 15000 }, () => {
  it.each([
    {
      name: 'SubagentStop',
      input: { hook_event_name: 'SubagentStop', agent_type: 'ui-developer' },
      expected: { event: 'orchestrator.agent.stopped', agent: 'ui-developer' },
    },
    {
      name: 'Stop',
      input: { hook_event_name: 'Stop', session_id: U('sess-xyz') },
      expected: { event: 'orchestrator.session.stopped', session_id: U('sess-xyz') },
    },
  ])('routes an explicit $name payload to its event record', async ({ input, expected }) => {
    const dir = await track(await mkGitDir());
    await runHook({ projectDir: dir, stdin: JSON.stringify(input) });

    expect(await readLastEvent(dir)).toMatchObject(expected);
  });
});

// ---------------------------------------------------------------------------
// 5. Empty / missing stdin
// ---------------------------------------------------------------------------

describe('empty stdin (no hook payload)', { timeout: 15000 }, () => {
  it('writes a stop record even with no stdin', async () => {
    const dir = await track(await mkGitDir());
    await runHook({ projectDir: dir, stdin: '' });
    const record = await readLastEvent(dir);
    expect(record.event).toBe('orchestrator.session.stopped');
  });
});

// ---------------------------------------------------------------------------
// 6. git info unavailable (plain non-git directory)
// ---------------------------------------------------------------------------

describe('git info unavailable', { timeout: 15000 }, () => {
  it('writes a stop record without branch/commit when git is unavailable', async () => {
    const dir = await track(await mkTmpDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: U('no-git') }),
    });
    const record = await readLastEvent(dir);
    expect(record.event).toBe('orchestrator.session.stopped');
    // branch and commit should be absent (gitInfo returns null → omitted)
    expect(Object.prototype.hasOwnProperty.call(record, 'branch')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(record, 'commit')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6b. git info AVAILABLE — populated branch/commit positive path (#613)
// ---------------------------------------------------------------------------
//
// The "git info unavailable" block above asserts branch/commit are ABSENT.
// A bug where gitInfo() always returns { commit: null, branch: null } (e.g. a
// broken `git rev-parse`) reads IDENTICALLY to "not a git repo" — both omit the
// keys. This positive path distinguishes the two: in a committed git repo the
// record MUST carry a real commit SHA and a non-empty branch name.

describe('git info available — populated branch/commit', { timeout: 15000 }, () => {
  it('record carries a commit SHA and non-empty branch when HEAD is committed', async () => {
    const { dir, committed } = await mkCommittedGitDir();
    await track(dir);
    expect(committed).toBe(true); // guard: git must be available in this env
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: U('git-positive') }),
    });
    const record = await readLastEvent(dir);
    expect(record.event).toBe('orchestrator.session.stopped');
    // commit is a 7–40 char lowercase hex SHA (full SHA from `git rev-parse HEAD`).
    expect(record.commit).toMatch(/^[0-9a-f]{7,40}$/);
    // branch is a non-empty string (default branch name, e.g. "main"/"master").
    expect(typeof record.branch).toBe('string');
    expect(record.branch.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 7. CLANK_EVENT_SECRET set — subprocess exits 0, record still written
//    (We cannot spy on fetch inside a subprocess, so we verify the hook
//    completes successfully with the secret set and a mock URL that will
//    immediately reject — the fire-and-forget must not cause a non-zero exit.)
// ---------------------------------------------------------------------------

describe('webhook — CLANK_EVENT_SECRET set', { timeout: 15000 }, () => {
  it('keeps the stop hook non-blocking and writes its record when the URL is unreachable', async () => {
    const dir = await track(await mkGitDir());
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: U('webhook-test') }),
      env: {
        CLANK_EVENT_SECRET: 'test-secret-token',
        // Point to localhost port nobody listens on — connection refused
        CLANK_EVENT_URL: 'http://127.0.0.1:1',
      },
    });

    expect(result.code).toBe(0);
    expect(await readLastEvent(dir)).toMatchObject({
      event: 'orchestrator.session.stopped',
      session_id: U('webhook-test'),
    });
  });
});

// ---------------------------------------------------------------------------
// 9. Multiple sequential events accumulate in events.jsonl
// ---------------------------------------------------------------------------

describe('sequential event accumulation', { timeout: 20000 }, () => {
  it('two runs produce two lines in events.jsonl', async () => {
    const dir = await track(await mkGitDir());
    await runHook({ projectDir: dir, stdin: JSON.stringify({ agent_type: 'agent-1' }) });
    await runHook({ projectDir: dir, stdin: JSON.stringify({ agent_type: 'agent-2' }) });
    const events = await readAllEvents(dir);
    expect(events).toHaveLength(2);
    expect(events[0].agent).toBe('agent-1');
    expect(events[1].agent).toBe('agent-2');
  });
});

// ---------------------------------------------------------------------------
// 10. Issue #32 regression — Claude Code passes agent_type, not agent_name
// ---------------------------------------------------------------------------

describe('issue #32 — legacy agent_name is ignored', { timeout: 15000 }, () => {
  it('omits agent entirely instead of reading the legacy agent_name field', async () => {
    // This test pins the contract change. If the handler ever falls back to
    // input.agent_name again, this assertion will fail loudly.
    // #1190: the fallback is now OMISSION, not the fabricated 'unknown' — an
    // unmeasured agent type must stay distinguishable from a measured one.
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SubagentStop', agent_name: 'legacy-name' }),
    });
    const record = await readLastEvent(dir);
    expect(record.event).toBe('orchestrator.agent.stopped');
    expect(Object.hasOwn(record, 'agent')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 11. Silent-failure observability — sweep.log breadcrumb on registry-refresh failure
//
// #1047 re-pointed these from `deregisterSelf` to `heartbeat`: the Stop hook no
// longer removes the entry, it refreshes it. The behaviour under test is
// unchanged and still valuable — an fs-layer failure inside the registry write
// must produce a sweep.log breadcrumb, exit 0, and stay off stderr — so the
// tests move to the new call site rather than being deleted. The read-only
// registry dir now makes _writeJsonAtomic's tmp-file write fail (EACCES)
// instead of unlink.
// ---------------------------------------------------------------------------

describe('heartbeat-failed observability breadcrumb', { timeout: 15000 }, () => {
  it('hook still exits 0 when the registry refresh throws (read-only registry)', async () => {
    if (process.platform === 'win32') return; // chmod not meaningful on Windows
    const dir = await track(await mkGitDir());
    const badRegistryDir = path.join(os.tmpdir(), 'on-stop-deregister-ro-' + Date.now());
    await fs.mkdir(badRegistryDir, { recursive: true });
    // Pre-create the active/ dir and an entry so heartbeat() actually tries to
    // rewrite something; then lock down the directory so the write fails.
    const activeDir = path.join(badRegistryDir, 'active');
    await fs.mkdir(activeDir, { recursive: true });
    const sessionId = U('fail-deregister-test');
    await fs.writeFile(
      path.join(activeDir, `${sessionId}.json`),
      JSON.stringify({ session_id: sessionId, last_heartbeat: new Date().toISOString(), started_at: new Date().toISOString() }),
    );
    await fs.chmod(activeDir, 0o555); // can't delete files from a read-only dir
    try {
      const result = await runHook({
        projectDir: dir,
        stdin: JSON.stringify({ session_id: sessionId }),
        env: { SO_SESSION_REGISTRY_DIR: badRegistryDir },
      });
      expect(result.code).toBe(0);
    } finally {
      try { await fs.chmod(activeDir, 0o755); } catch { /* ignore */ }
      await fs.rm(badRegistryDir, { recursive: true, force: true });
    }
  });

  it.skipIf(isRoot)('appends a heartbeat-failed entry to sweep.log when the registry refresh throws', async () => {
    if (process.platform === 'win32') return;
    const dir = await track(await mkGitDir());
    const badRegistryDir = path.join(os.tmpdir(), 'on-stop-heartbeat-log-' + Date.now());
    await fs.mkdir(badRegistryDir, { recursive: true });
    const activeDir = path.join(badRegistryDir, 'active');
    await fs.mkdir(activeDir, { recursive: true });
    const sessionId = U('fail-deregister-log-test');
    await fs.writeFile(
      path.join(activeDir, `${sessionId}.json`),
      JSON.stringify({ session_id: sessionId, last_heartbeat: new Date().toISOString(), started_at: new Date().toISOString() }),
    );
    await fs.chmod(activeDir, 0o555);
    try {
      await runHook({
        projectDir: dir,
        stdin: JSON.stringify({ session_id: sessionId }),
        env: { SO_SESSION_REGISTRY_DIR: badRegistryDir },
      });
      await fs.chmod(activeDir, 0o755);
      const entries = await readSweepLog(badRegistryDir);
      const failed = entries.find((e) => e.event === 'heartbeat-failed');
      expect(failed).toMatchObject({
        event: 'heartbeat-failed',
        session_id: sessionId,
      });
      expect(typeof failed.error).toBe('string');
      expect(failed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    } finally {
      try { await fs.chmod(activeDir, 0o755); } catch { /* ignore */ }
      await fs.rm(badRegistryDir, { recursive: true, force: true });
    }
  });

  it('does not write to stderr on registry-refresh failure', async () => {
    if (process.platform === 'win32') return;
    const dir = await track(await mkGitDir());
    const badRegistryDir = path.join(os.tmpdir(), 'on-stop-heartbeat-stderr-' + Date.now());
    await fs.mkdir(badRegistryDir, { recursive: true });
    const activeDir = path.join(badRegistryDir, 'active');
    await fs.mkdir(activeDir, { recursive: true });
    const sessionId = U('fail-deregister-stderr-test');
    await fs.writeFile(
      path.join(activeDir, `${sessionId}.json`),
      JSON.stringify({ session_id: sessionId, last_heartbeat: new Date().toISOString(), started_at: new Date().toISOString() }),
    );
    await fs.chmod(activeDir, 0o555);
    try {
      const result = await runHook({
        projectDir: dir,
        stdin: JSON.stringify({ session_id: sessionId }),
        env: { SO_SESSION_REGISTRY_DIR: badRegistryDir },
      });
      expect(result.stderr).toBe('');
    } finally {
      try { await fs.chmod(activeDir, 0o755); } catch { /* ignore */ }
      await fs.rm(badRegistryDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 13. Session registry heartbeat, NOT deregistration (#1047; was #169)
//
// The bug these tests exist to catch: A REGISTRY ENTRY DID NOT SURVIVE A SINGLE
// ASSISTANT TURN. Stop fires at TURN end, so the original #169 wiring
// (deregisterSelf here) deleted the entry of a still-live session on every
// turn — measured as 1 surviving entry against 12 live sockets, with sweep.log
// recording deletions of sessions aged 72/335/351/369 minutes.
//
// No lib-level test can go red on this: deregisterSelf() and heartbeat() are
// each correct in isolation and their unit tests pass either way. The defect is
// in the hook's WIRING, so the guard belongs here, at the spawned-hook level.
//
// The old section asserted the ENTRY IS GONE after a run. Those assertions
// described the defect as the contract, so they are inverted here rather than
// kept: survival + refresh-in-place is the contract now. The peer-isolation and
// id-resolution coverage they carried is preserved.
// ---------------------------------------------------------------------------

describe('session registry heartbeat (#1047)', { timeout: 15000 }, () => {
  it('keeps and refreshes the entry after one turn when session_id comes via stdin', async () => {
    const dir = await track(await mkGitDir());
    await writeHeartbeat(U('stop-via-stdin'), { ageMinutes: 5 });
    const before = await readEntry(U('stop-via-stdin'));

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: U('stop-via-stdin') }),
    });

    // (A) the entry still exists — RED under the pre-#1047 deregisterSelf wiring
    expect(await registryFiles()).toContain(`${U('stop-via-stdin')}.json`);
    const after = await readEntry(U('stop-via-stdin'));
    // (B) last_heartbeat moved forward — distinguishes "wired the heartbeat"
    //     from merely "deleted the delete"
    expect(Date.parse(after.last_heartbeat)).toBeGreaterThan(Date.parse(before.last_heartbeat));
    // (C) started_at is untouched — refresh in place, not re-registration
    expect(after.started_at).toBe(before.started_at);
  });

  it('refreshes via the .orchestrator/current-session.json fallback when stdin has no session_id', async () => {
    const dir = await track(await mkGitDir());
    await writeHeartbeat(U('stop-via-fallback'), { ageMinutes: 5 });
    const before = await readEntry(U('stop-via-fallback'));
    await fs.mkdir(path.join(dir, '.orchestrator'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.orchestrator', 'current-session.json'),
      JSON.stringify({ session_id: U('stop-via-fallback'), source: 'generated' }),
    );

    await runHook({ projectDir: dir, stdin: '' });

    expect(await registryFiles()).toContain(`${U('stop-via-fallback')}.json`);
    const after = await readEntry(U('stop-via-fallback'));
    expect(Date.parse(after.last_heartbeat)).toBeGreaterThan(Date.parse(before.last_heartbeat));
  });

  it('is a no-op when no session_id is resolvable — never throws, exits 0', async () => {
    const dir = await track(await mkGitDir());
    // No heartbeat, no current-session.json, no stdin session_id.
    const result = await runHook({ projectDir: dir, stdin: '' });
    expect(result.code).toBe(0);
    const record = await readLastEvent(dir);
    expect(record.event).toBe('orchestrator.session.stopped');
    expect(record.session_id).toBeUndefined();
  });

  it('leaves a sweep.log breadcrumb (not a silent no-op) when the entry is missing', async () => {
    const dir = await track(await mkGitDir());
    // session_id provided but no entry exists — heartbeat() returns null.
    // Without the breadcrumb this loss would be permanently invisible.
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: U('never-registered') }),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(await readEntry(U('never-registered')).catch(() => null)).toBeNull();

    const missing = (await readSweepLog()).find((e) => e.event === 'heartbeat-missing');
    expect(missing).toMatchObject({
      event: 'heartbeat-missing',
      session_id: U('never-registered'),
    });

    const record = await readLastEvent(dir);
    expect(record.session_id).toBe(U('never-registered'));
  });

  it('refreshes only its own entry, leaving peer heartbeats byte-identical', async () => {
    const dir = await track(await mkGitDir());
    await writeHeartbeat(U('self'), { ageMinutes: 5 });
    await writeHeartbeat('peer-one', { ageMinutes: 5 });
    await writeHeartbeat('peer-two', { ageMinutes: 5 });
    const peerOneBefore = await readEntry('peer-one');

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: U('self') }),
    });

    // All three survive — the pre-#1047 wiring removed the ending session's own entry.
    expect((await registryFiles()).sort()).toEqual(
      [`${U('self')}.json`, 'peer-one.json', 'peer-two.json'].sort(),
    );
    expect(await readEntry('peer-one')).toEqual(peerOneBefore);
    const self = await readEntry(U('self'));
    expect(Date.parse(self.last_heartbeat)).toBeGreaterThan(Date.parse(peerOneBefore.last_heartbeat));
  });

  it('prefers stdin session_id over current-session.json fallback', async () => {
    const dir = await track(await mkGitDir());
    await writeHeartbeat(U('stdin-wins'), { ageMinutes: 5 });
    await writeHeartbeat(U('fallback-loses'), { ageMinutes: 5 });
    const fallbackBefore = await readEntry(U('fallback-loses'));
    await fs.mkdir(path.join(dir, '.orchestrator'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.orchestrator', 'current-session.json'),
      JSON.stringify({ session_id: U('fallback-loses') }),
    );

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: U('stdin-wins') }),
    });

    // Only the stdin id is refreshed; the fallback entry is untouched.
    expect(await readEntry(U('fallback-loses'))).toEqual(fallbackBefore);
    const stdinWins = await readEntry(U('stdin-wins'));
    expect(Date.parse(stdinWins.last_heartbeat)).toBeGreaterThan(Date.parse(fallbackBefore.last_heartbeat));
  });
});

// ---------------------------------------------------------------------------
// 15. SubagentStop stdout shape — additionalContext slot (#666, v2.1.163+)
//
// handleSubagentStop currently returns null (no inline warning), so stdout
// MUST be empty for SubagentStop events — the hookSpecificOutput slot is
// live but only fires when the handler returns a non-null string.
// Stop events MUST still emit the terminalSequence JSON on stdout.
// ---------------------------------------------------------------------------

describe('SubagentStop stdout — additionalContext slot (#666)', { timeout: 15000 }, () => {
  it('writes the agent event without hook-specific stdout or terminalSequence', async () => {
    const dir = await track(await mkGitDir());
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SubagentStop', agent_type: 'qa-strategist' }),
    });

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(await readLastEvent(dir)).toMatchObject({
      event: 'orchestrator.agent.stopped',
      agent: 'qa-strategist',
    });
  });

  it('Stop path emits terminalSequence JSON on stdout', async () => {
    const dir = await track(await mkGitDir());
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: U('ts-test') }),
    });

    const out = JSON.parse(result.stdout);
    expect(typeof out.terminalSequence).toBe('string');
    expect(out.terminalSequence.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 16. terminalSequence guaranteed even when handleStop() side-effect throws (#666 F2)
// ---------------------------------------------------------------------------
//
// The #666 change moved process.stdout.write(buildTerminalSequenceJson()) OUT of
// .finally() to AFTER await handleStop(). Now if handleStop() throws (e.g.
// emitEvent's fs.appendFile on a full/read-only disk), the terminalSequence is
// lost. The fix wraps the Stop branch in try/finally so terminalSequence is
// always emitted for Stop, never for SubagentStop.

describe('terminalSequence guaranteed on handleStop() throw (#666 F2)', { timeout: 15000 }, () => {
  it('emits terminalSequence to stdout even when events.jsonl dir is not writable (handleStop throws)', async () => {
    if (process.platform === 'win32') return; // chmod semantics differ on Windows
    const dir = await track(await mkTmpDir());
    // Place a FILE at the path where emitEvent expects a DIRECTORY, so
    // fs.appendFile (or mkdir) inside emitEvent will throw ENOTDIR.
    const orchDir = path.join(dir, '.orchestrator', 'metrics');
    await fs.mkdir(path.dirname(orchDir), { recursive: true });
    // Write a file at the position that should be a directory — causes ENOTDIR
    await fs.writeFile(orchDir, 'i-am-a-file-not-a-dir');

    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: U('ts-throw-test') }),
    });
    // Exit code must stay 0 (informational hook never blocks)
    expect(result.code).toBe(0);
    // terminalSequence MUST appear on stdout despite the throw
    const parsed = JSON.parse(result.stdout);
    expect(typeof parsed.terminalSequence).toBe('string');
    expect(parsed.terminalSequence.length).toBeGreaterThan(0);
  });

  it('SubagentStop never emits terminalSequence even when events.jsonl dir is not writable', async () => {
    if (process.platform === 'win32') return;
    const dir = await track(await mkTmpDir());
    const orchDir = path.join(dir, '.orchestrator', 'metrics');
    await fs.mkdir(path.dirname(orchDir), { recursive: true });
    await fs.writeFile(orchDir, 'i-am-a-file-not-a-dir');

    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SubagentStop', agent_type: 'code-implementer' }),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('terminalSequence');
  });
});

// ---------------------------------------------------------------------------
// 14. Session lock heartbeat-refresh on Stop (Epic #583 W5-F1c — replaces W3-P3 release)
// ---------------------------------------------------------------------------
//
// Earlier W3-P3 added release-on-Stop which proved wrong: Stop fires per-turn-end,
// so release-on-Stop would delete the lock after the first turn. W5-F1c replaces
// release with updateHeartbeat — the lock stays live + heartbeat is refreshed.
// Closes W4-Q3 H2 cadence finding (PostToolBatch-only heartbeat was too narrow).

describe('session lock heartbeat-refresh on Stop (Epic #583 W5-F1c)', { timeout: 15000 }, () => {
  /**
   * Write a minimal valid session.lock body for the given sessionId under
   * projectDir's .orchestrator/ folder. Returns the lock-file path.
   */
  async function writeLock(projectDir, sessionId) {
    const orchDir = path.join(projectDir, '.orchestrator');
    await fs.mkdir(orchDir, { recursive: true });
    const lockPath = path.join(orchDir, 'session.lock');
    const nowIso = new Date().toISOString();
    const lock = {
      session_id: sessionId,
      started_at: nowIso,
      last_heartbeat: nowIso,
      mode: 'deep',
      pid: 999999,
      host: 'test-host',
      ttl_hours: 4,
    };
    await fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
    return lockPath;
  }

  async function lockExists(projectDir) {
    const lockPath = path.join(projectDir, '.orchestrator', 'session.lock');
    return fs.access(lockPath).then(() => true).catch(() => false);
  }

  it('refreshes last_heartbeat when stdin session_id matches the lock owner', async () => {
    const dir = await track(await mkGitDir());
    const sessionId = U('stop-refreshes-heartbeat');
    await writeLock(dir, sessionId);
    // Snapshot the heartbeat BEFORE Stop.
    const beforePath = path.join(dir, '.orchestrator', 'session.lock');
    const beforeRaw = await fs.readFile(beforePath, 'utf8');
    const beforeHb = JSON.parse(beforeRaw).last_heartbeat;

    // Sleep 10ms so the new heartbeat ISO is strictly later.
    await new Promise((r) => setTimeout(r, 10));

    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: sessionId }),
    });
    expect(result.code).toBe(0);

    // Lock STAYS — and heartbeat is now strictly after the pre-Stop snapshot.
    expect(await lockExists(dir)).toBe(true);
    const afterRaw = await fs.readFile(beforePath, 'utf8');
    const afterHb = JSON.parse(afterRaw).last_heartbeat;
    expect(new Date(afterHb).getTime()).toBeGreaterThan(new Date(beforeHb).getTime());
  });

  it('does NOT refresh a lock owned by a DIFFERENT session (same-session guard)', async () => {
    const dir = await track(await mkGitDir());
    const lockOwner = 'real-lock-owner';
    await writeLock(dir, lockOwner);
    expect(await lockExists(dir)).toBe(true);
    const beforeRaw = await fs.readFile(path.join(dir, '.orchestrator', 'session.lock'), 'utf8');
    const beforeHb = JSON.parse(beforeRaw).last_heartbeat;

    await new Promise((r) => setTimeout(r, 10));

    // Run on-stop with a DIFFERENT session_id — updateHeartbeat must no-op.
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: U('impostor-session') }),
    });
    expect(result.code).toBe(0);

    // Lock survives AND heartbeat unchanged.
    expect(await lockExists(dir)).toBe(true);
    const raw = await fs.readFile(path.join(dir, '.orchestrator', 'session.lock'), 'utf8');
    const surviving = JSON.parse(raw);
    expect(surviving.session_id).toBe(lockOwner);
    expect(surviving.last_heartbeat).toBe(beforeHb);
  });

  it('exits 0 when no session.lock exists (best-effort contract)', async () => {
    const dir = await track(await mkGitDir());
    // No lock pre-written.
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: U('no-lock-to-release') }),
    });
    expect(result.code).toBe(0);
    // Hook still writes the stop event.
    const record = await readLastEvent(dir);
    expect(record.event).toBe('orchestrator.session.stopped');
  });

  it('uses current-session.json fallback when stdin lacks session_id', async () => {
    const dir = await track(await mkGitDir());
    const sessionId = U('fallback-heartbeat-via-current-session');
    await writeLock(dir, sessionId);

    // Write current-session.json so the resolver picks it up.
    await fs.mkdir(path.join(dir, '.orchestrator'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.orchestrator', 'current-session.json'),
      JSON.stringify({ session_id: sessionId }),
    );

    const beforeRaw = await fs.readFile(path.join(dir, '.orchestrator', 'session.lock'), 'utf8');
    const beforeHb = JSON.parse(beforeRaw).last_heartbeat;
    await new Promise((r) => setTimeout(r, 10));

    const result = await runHook({ projectDir: dir, stdin: '' });
    expect(result.code).toBe(0);

    // Heartbeat MUST have been refreshed via the current-session.json fallback path.
    const afterRaw = await fs.readFile(path.join(dir, '.orchestrator', 'session.lock'), 'utf8');
    const afterHb = JSON.parse(afterRaw).last_heartbeat;
    expect(new Date(afterHb).getTime()).toBeGreaterThan(new Date(beforeHb).getTime());
  });
});

// ---------------------------------------------------------------------------
// 17. Missing dependencies degrade gracefully (GH Kanevry/session-orchestrator#63)
// ---------------------------------------------------------------------------
//
// Reported by an external user: with node_modules absent (interrupted install,
// EPERM sandbox, half-synced plugin cache) a STATIC `import { $ } from 'zx'`
// killed the hook at module-load time — EXIT 1 plus a 10-frame
// ERR_MODULE_NOT_FOUND stack on EVERY turn end, with no hint that the fix is
// `npm install`. The hook's own contract is "exit 0 always"; a missing package
// must not be louder than the missing-`node` case that hooks/run-node.sh
// already degrades (one rate-limited stderr line, exit 0).
//
// The sandbox is a COPY of hooks/ + scripts/ + package.json in a tmp dir with
// no node_modules anywhere up the tree — Node's resolver walks upward from the
// module, so this is the only faithful way to reproduce the user's state.

const DEPS_TEST_USER = 'deps-test-user';
const DEPS_MARKER_NAME = `session-orchestrator-deps-missing-${DEPS_TEST_USER}`;

/** Copy hooks/ + scripts/ + package.json into a tmp dir that has NO node_modules. */
async function mkDepLessSandbox() {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const root = await track(await fs.mkdtemp(path.join(os.tmpdir(), 'on-stop-nodeps-')));
  for (const entry of ['hooks', 'scripts']) {
    await fs.cp(path.join(repoRoot, entry), path.join(root, entry), { recursive: true });
  }
  await fs.cp(path.join(repoRoot, 'package.json'), path.join(root, 'package.json'));
  const tmpDir = path.join(root, 'tmp');
  await fs.mkdir(tmpDir, { recursive: true });
  return { root, hook: path.join(root, 'hooks', 'on-stop.mjs'), tmpDir };
}

/** Spawn the SANDBOX copy of the hook (not the repo copy) and collect its output. */
async function runSandboxHook({ sandbox, projectDir, stdin = '{}' }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [sandbox.hook], {
      cwd: sandbox.root,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        // Keep the marker inside the sandbox — never touch the operator's real
        // ${TMPDIR}/session-orchestrator-* markers.
        TMPDIR: sandbox.tmpDir,
        USER: DEPS_TEST_USER,
        CLANK_EVENT_SECRET: undefined,
        CLANK_EVENT_URL: undefined,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

describe('missing node_modules — graceful degradation (GH#63)', { timeout: 30000 }, () => {
  it('exits 0 with ONE actionable line and no ERR_MODULE_NOT_FOUND stack', async () => {
    const sandbox = await mkDepLessSandbox();
    const projectDir = await track(await mkTmpDir());

    const res = await runSandboxHook({
      sandbox,
      projectDir,
      stdin: JSON.stringify({ session_id: U('nodeps-core') }),
    });

    expect(res.code).toBe(0);
    // The bug's fingerprint — the raw loader error and its Node-internals frames.
    expect(res.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(res.stderr).not.toContain('node:internal');
    // Exactly one line, and it names the fix + where to run it.
    expect(res.stderr.trim().split('\n')).toHaveLength(1);
    expect(res.stderr).toContain("run 'npm install'");
    expect(res.stderr).toContain(sandbox.root);
    // Degraded, not dead: the hook still does its job (event + terminalSequence).
    expect(await readLastEvent(projectDir)).toMatchObject({
      event: 'orchestrator.session.stopped',
      session_id: U('nodeps-core'),
    });
    expect(typeof JSON.parse(res.stdout).terminalSequence).toBe('string');
  });

  it('warns once per 6h window and speaks again once the marker ages out', async () => {
    const sandbox = await mkDepLessSandbox();
    const projectDir = await track(await mkTmpDir());
    const marker = path.join(sandbox.tmpDir, DEPS_MARKER_NAME);

    const first = await runSandboxHook({ sandbox, projectDir });
    expect(first.stderr).toContain("run 'npm install'");
    await fs.access(marker); // throws (fails the test) if the marker was not written

    const second = await runSandboxHook({ sandbox, projectDir });
    expect(second.code).toBe(0);
    expect(second.stderr).toBe('');

    // Age the marker past the 6h TTL — the operator gets a fresh reminder.
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
    await fs.utimes(marker, sevenHoursAgo, sevenHoursAgo);

    const third = await runSandboxHook({ sandbox, projectDir });
    expect(third.code).toBe(0);
    expect(third.stderr).toContain("run 'npm install'");
  });
});

// ---------------------------------------------------------------------------
// 18. Repo-wide structural guard: no hook may STATICALLY import a third-party
//     package (GH#63 recurrence class).
// ---------------------------------------------------------------------------
//
// The runtime test above proves on-stop.mjs degrades. This guard is the cheap
// repo-wide invariant: any hook that grows a static bare-specifier import
// reintroduces the same load-time crash, in a file whose own tests would never
// notice (the repo always has node_modules).
//
// Named ceiling (revisit trigger): this checks DIRECT imports of hooks/**/*.mjs
// only. A third-party package pulled in transitively via scripts/lib/** is not
// covered — revisit if a hook helper chain grows a bare dependency.

/** Bare (non-relative, non-`node:`) specifiers statically imported by `source`. */
function staticThirdPartyImports(source) {
  const specs = [];
  const patterns = [
    /^[ \t]*(?:import|export)[\s{][^'"]*\bfrom\s*['"]([^'"]+)['"]/gm, // import … from 'x'
    /^[ \t]*import\s*['"]([^'"]+)['"]/gm,                             // bare side-effect import
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      const spec = m[1];
      if (!spec.startsWith('.') && !spec.startsWith('node:')) specs.push(spec);
    }
  }
  return specs;
}

describe('hooks static-import guard (GH#63 recurrence class)', () => {
  it('no hooks/**/*.mjs statically imports a third-party package', async () => {
    const hooksDir = path.resolve(import.meta.dirname, '../../hooks');
    const entries = await fs.readdir(hooksDir, { recursive: true });
    const offenders = {};
    for (const rel of entries.filter((e) => e.endsWith('.mjs'))) {
      const source = await fs.readFile(path.join(hooksDir, rel), 'utf8');
      const specs = staticThirdPartyImports(source);
      if (specs.length > 0) offenders[rel] = specs;
    }
    expect(offenders).toEqual({});
  });

  it('the detector itself flags a static zx import (fake-regression check)', () => {
    expect(staticThirdPartyImports("import { $ } from 'zx';\n")).toEqual(['zx']);
    expect(staticThirdPartyImports("import 'zx';\n")).toEqual(['zx']);
    expect(staticThirdPartyImports(
      "import path from 'node:path';\nimport { x } from './lib.mjs';\n",
    )).toEqual([]);
    // The dynamic form the fix uses must NOT be flagged.
    expect(staticThirdPartyImports("const { $ } = await import('zx');\n")).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// #1068 AC1 — the turn-end event carries the attested semantic id
// ---------------------------------------------------------------------------

describe('Stop event — semantic_session_id (#1068)', { timeout: 15000 }, () => {
  /** Seed .orchestrator/current-session.json exactly as on-session-start writes it. */
  async function seedCurrentSession(dir, { sessionId, semanticSessionId }) {
    await fs.mkdir(path.join(dir, '.orchestrator'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.orchestrator', 'current-session.json'),
      JSON.stringify({
        session_id: sessionId,
        ...(semanticSessionId === undefined ? {} : { semantic_session_id: semanticSessionId }),
        source: 'stdin',
        timestamp: new Date().toISOString(),
      }),
    );
  }

  // TV-001 — the bug: `resolveSessionId()` read only `session_id` out of
  // current-session.json and dropped the `semantic_session_id` sitting beside
  // it, so `session.stopped` was unjoinable to the semantic-keyed ledger even
  // though the mapping was already on disk one line away.
  it('carries the semantic id from current-session.json for the recorded session', async () => {
    const dir = await track(await mkGitDir());
    await seedCurrentSession(dir, {
      sessionId: U('stop-sem-attested'),
      semanticSessionId: 'main-2026-08-28-session-9',
    });

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: U('stop-sem-attested') }),
    });

    const record = await readLastEvent(dir);
    expect(record.session_id).toBe(U('stop-sem-attested'));
    expect(record.semantic_session_id).toBe('main-2026-08-28-session-9');
  });

  // Both cases pin the SAME contamination class (#863 defect (c)) via two
  // different entry points: an explicit foreign stdin id, and an absent one.
  it.each([
    {
      // TV-001 — current-session.json is repo-global, so a turn-end from a
      // DIFFERENT window must not stamp the recorded peer's semantic identity
      // onto its own event.
      label: 'the stopping session is not the recorded one',
      seedSessionId: U('stop-sem-peer'),
      semanticSessionId: 'main-2026-08-28-session-9',
      stdin: { session_id: U('stop-sem-foreign') },
      expectedSessionId: U('stop-sem-foreign'),
    },
    {
      // Catches the self-fulfilling half the case above could not reach: with
      // no stdin id, `resolveSessionId()` assigned the FILE's id to
      // `sessionId` and only THEN compared the two, so the peer's semantic
      // identity was inherited by the very gate meant to refuse it.
      // `session_id` still falls back — that is the actor identity the
      // heartbeats need — but the attestation does not.
      label: 'stdin carries no session_id at all (F-A, second site)',
      seedSessionId: U('stop-sem-peer-2'),
      semanticSessionId: 'main-2026-09-02-session-11',
      stdin: { reason: 'other' },
      expectedSessionId: U('stop-sem-peer-2'),
    },
  ])('omits the key when $label', async ({ seedSessionId, semanticSessionId, stdin, expectedSessionId }) => {
    const dir = await track(await mkGitDir());
    await seedCurrentSession(dir, { sessionId: seedSessionId, semanticSessionId });

    await runHook({ projectDir: dir, stdin: JSON.stringify(stdin) });

    const record = await readLastEvent(dir);
    expect(record.session_id).toBe(expectedSessionId);
    expect(Object.prototype.hasOwnProperty.call(record, 'semantic_session_id')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #1091 / Kanevry#66 — the stdin session_id must parse as a UUID
// ---------------------------------------------------------------------------

describe('Stop event — stdin id is UUID-gated, mirroring the writer (#1091)', { timeout: 15000 }, () => {
  // TV-001 — the bug: any non-empty stdin string was passed through as the
  // registry/lock key, while on-session-start.mjs only ever registers a UUID.
  // The heartbeat then addressed a key nothing had written: the real entry went
  // un-refreshed every turn and aged into the zombie sweep while the session was
  // still live, and the only visible trace was a `heartbeat-missing` breadcrumb
  // naming an id that exists nowhere else.
  it('refreshes the entry recorded at SessionStart when the harness passes a NON-UUID stdin id', async () => {
    const dir = await track(await mkGitDir());
    const started = U('stop-uuid-gate');
    await writeHeartbeat(started, { ageMinutes: 5 });
    const before = await readEntry(started);
    await fs.mkdir(path.join(dir, '.orchestrator'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.orchestrator', 'current-session.json'),
      JSON.stringify({ session_id: started, source: 'generated-uuid' }),
    );

    await runHook({ projectDir: dir, stdin: JSON.stringify({ session_id: 'not-a-uuid' }) });

    const after = await readEntry(started);
    expect(Date.parse(after.last_heartbeat)).toBeGreaterThan(Date.parse(before.last_heartbeat));
    const record = await readLastEvent(dir);
    expect(record.session_id).toBe(started);
  });
});

// ---------------------------------------------------------------------------
// 20. SubagentStop payload enrichment (#1190)
//
// The fleet's most frequent event carried a single field, and in 86,7% of
// 103.763 records that field was the EMPTY STRING (`?? 'unknown'` never fires
// on ''). These cases pin BOTH halves of the fix: the omission contract for an
// unmeasured value, and the sidecar-derived fields.
// ---------------------------------------------------------------------------

describe('SubagentStop payload enrichment (#1190)', { timeout: 15000 }, () => {
  const META = {
    agentType: 'Explore',
    description: 'operator prose that must never reach the payload',
    toolUseId: 'toolu_01SQB2qvMLtZdCuST1w4P1Cs',
    spawnDepth: 1,
    model: 'opus',
  };

  /** One assistant transcript line whose single text block carries `text`. */
  const assistantLine = (text) =>
    `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`;

  /**
   * Build the harness's sidecar layout beside a parent transcript:
   *   <dir>/<parent-basename>/subagents/agent-<id>.{jsonl,meta.json}
   * Returns the parent transcript path to put on stdin.
   */
  async function mkSidecar(dir, agentId, { transcriptText, meta = META } = {}) {
    const parent = path.join(dir, 'parent.jsonl');
    const subagents = path.join(dir, 'parent', 'subagents');
    await fs.mkdir(subagents, { recursive: true });
    await fs.writeFile(parent, '');
    if (meta !== null) {
      await fs.writeFile(
        path.join(subagents, `agent-${agentId}.meta.json`),
        typeof meta === 'string' ? meta : JSON.stringify(meta),
      );
    }
    if (transcriptText !== undefined) {
      await fs.writeFile(path.join(subagents, `agent-${agentId}.jsonl`), assistantLine(transcriptText));
    }
    return parent;
  }

  it('carries agent, agent_id and every sidecar-derived field for a live sidecar', async () => {
    const dir = await track(await mkGitDir());
    const parent = await mkSidecar(dir, 'abc123', { transcriptText: 'STATUS: done — ok' });

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({
        hook_event_name: 'SubagentStop',
        agent_type: 'test-writer',
        agent_id: 'abc123',
        transcript_path: parent,
      }),
    });

    const record = await readLastEvent(dir);
    expect(record).toMatchObject({
      event: 'orchestrator.agent.stopped',
      agent: 'test-writer',
      agent_id: 'abc123',
      tool_use_id: META.toolUseId,
      agent_type_meta: 'Explore',
      transcript_found: true,
      status: 'done',
      duration_source: 'meta-birthtime',
    });
    expect(Number.isInteger(record.duration_ms)).toBe(true);
    // W4a review F-B — a BOUNDED window, not `>= 0`. The sidecar was created
    // milliseconds ago, so a plausible span is well under a minute; the old
    // lower-bound-only assertion also accepted the ~55-year span an
    // unsupported-birthtime filesystem produces (see the epoch case below),
    // which meant it could not go red on exactly the bug it was watching.
    expect(record.duration_ms).toBeGreaterThanOrEqual(0);
    expect(record.duration_ms).toBeLessThan(60_000);
    // The meta sidecar's `description` is operator prose; this payload also
    // travels over the optional Clank webhook unredacted.
    expect(JSON.stringify(record)).not.toContain('operator prose');
  });

  /**
   * Force a file's birthtime backwards. On APFS/HFS+ a `utimes` to a moment
   * BEFORE the birthtime drags `st_birthtime` along; on filesystems that do not
   * record a birthtime at all there is nothing to forge. Returns whether the
   * backdate actually took, so the caller can assert a real precondition
   * instead of passing vacuously (this is exactly the fabricated-birthtime
   * environment F-B is about, so a silent no-op must not read as a pass).
   */
  async function backdateBirthtime(file, when) {
    await fs.utimes(file, when, when);
    const { birthtimeMs } = await fs.stat(file);
    return Math.abs(birthtimeMs - when.getTime()) < 2000;
  }

  // Both cases backdate the sidecar's own meta.json birthtime, then assert
  // both duration keys are OMITTED — never a fabricated span. A filesystem
  // that cannot forge a birthtime returns early rather than passing
  // vacuously (see backdateBirthtime()).
  it.each([
    {
      // Catches: Node documents birthtimeMs as 0/1970 on filesystems that
      // record no birthtime (overlayfs, some CI images). The old `>= 0`
      // guard accepted it and shipped a ~55-YEAR span stamped
      // `duration_source: meta-birthtime` — a fabricated measurement of the
      // exact class K5 removed.
      label: 'the filesystem reports a 1970 birthtime',
      agentId: 'abcEpoch',
      when: () => new Date(0),
    },
    {
      // Catches: any birthtime the filesystem did not really supply. No
      // subagent runs for a week, so a span past the named ceiling is a
      // broken clock or a broken birthtime, never a long agent.
      label: 'the span is above the 7-day ceiling',
      agentId: 'abcOld',
      when: () => new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    },
  ])('omits duration when $label (F-B)', async ({ agentId, when }) => {
    const dir = await track(await mkGitDir());
    const parent = await mkSidecar(dir, agentId);
    const metaPath = path.join(dir, 'parent', 'subagents', `agent-${agentId}.meta.json`);
    const backdated = await backdateBirthtime(metaPath, when());
    // Precondition, asserted rather than assumed — see backdateBirthtime().
    if (!backdated) return; // this filesystem cannot forge a birthtime; nothing to prove

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({
        hook_event_name: 'SubagentStop',
        agent_type: 'Explore',
        agent_id: agentId,
        transcript_path: parent,
      }),
    });

    const record = await readLastEvent(dir);
    expect(record.event).toBe('orchestrator.agent.stopped');
    expect(Object.hasOwn(record, 'duration_ms')).toBe(false);
    expect(Object.hasOwn(record, 'duration_source')).toBe(false);
  });

  it('omits an out-of-charset / oversized tool_use_id (F-E)', async () => {
    // Catches: meta.json is harness-written, and tool_use_id lands in the
    // ledger AND in the optional Clank webhook UNREDACTED. An unbounded value
    // travelled verbatim into both.
    const dir = await track(await mkGitDir());
    const parent = await mkSidecar(dir, 'abcTid', {
      meta: { ...META, toolUseId: `toolu_${'x'.repeat(200)}` },
    });

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({
        hook_event_name: 'SubagentStop',
        agent_type: 'Explore',
        agent_id: 'abcTid',
        transcript_path: parent,
      }),
    });

    const record = await readLastEvent(dir);
    expect(Object.hasOwn(record, 'tool_use_id')).toBe(false);
    // The sibling field is unaffected — each derivation stands alone.
    expect(record.agent_type_meta).toBe('Explore');
  });

  it('omits a structured agent_type_meta but KEEPS the plugin-qualified form (F-E)', async () => {
    // Catches BOTH directions. A newline/quote payload must not reach the
    // unredacted webhook — and the clamp must not be so tight that it drops the
    // REAL shape: measured on-disk 2026-09-02, a live meta.json carries
    // `session-orchestrator:code-implementer`, i.e. a COLON. A tool_use_id-
    // identical charset would have silently omitted every plugin-qualified
    // agent type in this repo.
    const dir = await track(await mkGitDir());
    const parent = await mkSidecar(dir, 'abcAtm', {
      meta: { ...META, agentType: 'Explore\n{"injected":true}' },
    });

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({
        hook_event_name: 'SubagentStop',
        agent_type: 'Explore',
        agent_id: 'abcAtm',
        transcript_path: parent,
      }),
    });

    let record = await readLastEvent(dir);
    expect(Object.hasOwn(record, 'agent_type_meta')).toBe(false);
    expect(record.tool_use_id).toBe(META.toolUseId);

    const dir2 = await track(await mkGitDir());
    const parent2 = await mkSidecar(dir2, 'abcAtm2', {
      meta: { ...META, agentType: 'session-orchestrator:code-implementer' },
    });
    await runHook({
      projectDir: dir2,
      stdin: JSON.stringify({
        hook_event_name: 'SubagentStop',
        agent_type: 'Explore',
        agent_id: 'abcAtm2',
        transcript_path: parent2,
      }),
    });
    record = await readLastEvent(dir2);
    expect(record.agent_type_meta).toBe('session-orchestrator:code-implementer');
  });

  it('OMITS agent when agent_type is the empty string (the #1190 defect)', async () => {
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SubagentStop', agent_type: '' }),
    });

    const record = await readLastEvent(dir);
    expect(record.event).toBe('orchestrator.agent.stopped');
    expect(Object.hasOwn(record, 'agent')).toBe(false);
  });

  it('OMITS a structured agent from stdin but KEEPS the plugin-qualified form (Q1-LOW-F3)', async () => {
    // `agent` was the one unclamped string in this payload while its siblings
    // carried an explicit webhook rationale. Same regex, same omit-never-truncate
    // contract — and the colon form must survive, or the clamp would delete the
    // real shape it is meant to admit.
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({
        hook_event_name: 'SubagentStop',
        agent_type: 'Explore\n{"injected":true}',
      }),
    });
    expect(Object.hasOwn(await readLastEvent(dir), 'agent')).toBe(false);

    const dir2 = await track(await mkGitDir());
    await runHook({
      projectDir: dir2,
      stdin: JSON.stringify({
        hook_event_name: 'SubagentStop',
        agent_type: 'session-orchestrator:code-implementer',
      }),
    });
    expect((await readLastEvent(dir2)).agent).toBe('session-orchestrator:code-implementer');
  });

  it('omits every derived key (not false/0) when the sidecar directory is absent', async () => {
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({
        hook_event_name: 'SubagentStop',
        agent_type: 'Explore',
        agent_id: 'nope',
        transcript_path: path.join(dir, 'missing.jsonl'),
      }),
    });

    const record = await readLastEvent(dir);
    expect(record).toMatchObject({ agent: 'Explore', agent_id: 'nope' });
    for (const key of ['status', 'duration_ms', 'duration_source', 'tool_use_id', 'agent_type_meta']) {
      expect(Object.hasOwn(record, key)).toBe(false);
    }
    // `transcript_found: false` is a MEASURED absence here — both inputs were
    // present, so the probe ran and returned false. The omission contract binds
    // the case where the probe COULD NOT run (no agent_id / no transcript_path),
    // pinned by the traversal case below.
    expect(record.transcript_found).toBe(false);
  });

  it('omits status when the transcript exists but carries no STATUS line', async () => {
    const dir = await track(await mkGitDir());
    const parent = await mkSidecar(dir, 'abc', { transcriptText: 'done, no marker' });

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({
        hook_event_name: 'SubagentStop',
        agent_type: 'Explore',
        agent_id: 'abc',
        transcript_path: parent,
      }),
    });

    const record = await readLastEvent(dir);
    expect(record.transcript_found).toBe(true);
    expect(Number.isInteger(record.duration_ms)).toBe(true);
    expect(Object.hasOwn(record, 'status')).toBe(false);
  });

  // Every literal in AGENT_STATUS_RE, not just `done`. Before this, only the
  // success literal was ever matched positively, so a typo in any of the other
  // four alternatives — the ones that actually carry an attention signal — was
  // invisible to the suite.
  for (const literal of ['done', 'partial', 'blocked', 'failed', 'no-tests-needed']) {
    it(`records status:'${literal}' from the transcript tail`, async () => {
      const dir = await track(await mkGitDir());
      const parent = await mkSidecar(dir, 'abc', { transcriptText: `STATUS: ${literal} — reported` });

      await runHook({
        projectDir: dir,
        stdin: JSON.stringify({
          hook_event_name: 'SubagentStop',
          agent_type: 'Explore',
          agent_id: 'abc',
          transcript_path: parent,
        }),
      });

      expect((await readLastEvent(dir)).status).toBe(literal);
    });
  }

  it('finds the STATUS line inside the 64 KiB tail window of an oversized sidecar', async () => {
    // The window path (`start > 0` → partial first line dropped → backwards
    // multi-record scan) runs on 99,3 % of real sidecars (5.935 of 5.977 are
    // larger than 64 KiB, measured 2026-09-02) and 0 tests exercised it: every
    // other case here writes a single-record file far below the window.
    const dir = await track(await mkGitDir());
    const parent = await mkSidecar(dir, 'big');
    const subagents = path.join(dir, 'parent', 'subagents');

    // ~120 KiB of filler records, then the STATUS in the LAST one.
    const filler = assistantLine('x'.repeat(4096)).repeat(30);
    await fs.writeFile(
      path.join(subagents, 'agent-big.jsonl'),
      filler + assistantLine('STATUS: partial — ran out of turns'),
    );
    expect((await fs.stat(path.join(subagents, 'agent-big.jsonl'))).size).toBeGreaterThan(64 * 1024);

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({
        hook_event_name: 'SubagentStop',
        agent_type: 'Explore',
        agent_id: 'big',
        transcript_path: parent,
      }),
    });

    const record = await readLastEvent(dir);
    expect(record.transcript_found).toBe(true);
    expect(record.status).toBe('partial');
  });

  it('does not fire on a quoted STATUS token mid-line (line-anchor regression)', async () => {
    const dir = await track(await mkGitDir());
    const parent = await mkSidecar(dir, 'abc', {
      transcriptText: 'the reviewer asked me to write STATUS: failed at the end',
    });

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({
        hook_event_name: 'SubagentStop',
        agent_type: 'Explore',
        agent_id: 'abc',
        transcript_path: parent,
      }),
    });

    const record = await readLastEvent(dir);
    expect(record.transcript_found).toBe(true);
    expect(Object.hasOwn(record, 'status')).toBe(false);
  });

  it('exits 0 and still writes the record when the meta sidecar is corrupt', async () => {
    const dir = await track(await mkGitDir());
    const parent = await mkSidecar(dir, 'abc', { meta: 'not json' });

    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({
        hook_event_name: 'SubagentStop',
        agent_type: 'Explore',
        agent_id: 'abc',
        transcript_path: parent,
      }),
    });

    expect(result.code).toBe(0);
    const record = await readLastEvent(dir);
    expect(record).toMatchObject({ agent: 'Explore', agent_id: 'abc' });
    expect(Object.hasOwn(record, 'tool_use_id')).toBe(false);
    expect(Object.hasOwn(record, 'agent_type_meta')).toBe(false);
    expect(Object.hasOwn(record, 'status')).toBe(false);
  });

  it('rejects a path-traversing agent_id before it reaches the filesystem', async () => {
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({
        hook_event_name: 'SubagentStop',
        agent_type: 'Explore',
        agent_id: '../../etc/passwd',
        transcript_path: path.join(dir, 'parent.jsonl'),
      }),
    });

    const record = await readLastEvent(dir);
    // The traversal id is OMITTED, not echoed: an unvalidated id lands in the
    // ledger AND travels over the optional Clank webhook unredacted. Omission
    // is the same contract every other optional field in this payload uses.
    expect(Object.hasOwn(record, 'agent_id')).toBe(false);
    expect(Object.hasOwn(record, 'transcript_found')).toBe(false);
    // The record itself is still emitted, with the fields that DID validate.
    expect(record.event).toBe('orchestrator.agent.stopped');
    expect(record.agent).toBe('Explore');
  });

  it('OMITS an over-long agent_id (unbounded value in the payload)', async () => {
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({
        hook_event_name: 'SubagentStop',
        agent_type: 'Explore',
        agent_id: 'a'.repeat(4096),
      }),
    });

    const record = await readLastEvent(dir);
    expect(Object.hasOwn(record, 'agent_id')).toBe(false);
    expect(record.agent).toBe('Explore');
  });
});

// ---------------------------------------------------------------------------
// K5 — session.stopped duration_ms derived from the OWNED session.lock
// ---------------------------------------------------------------------------
// The bug: `typeof input?.start_ms === 'number' ? … : 0` fell back to a hard 0
// because the harness never sends `start_ms` — 8.127 of 8.127 fleet
// `orchestrator.session.stopped` records carried `duration_ms: 0` (measured
// 2026-09-02). A fabricated zero is indistinguishable from a measured one.
// ---------------------------------------------------------------------------

describe('Stop duration_ms from session.lock (K5)', { timeout: 15000 }, () => {
  async function writeStopLock(projectDir, sessionId, startedAtMs) {
    const orchDir = path.join(projectDir, '.orchestrator');
    await fs.mkdir(orchDir, { recursive: true });
    const iso = new Date(startedAtMs).toISOString();
    await fs.writeFile(
      path.join(orchDir, 'session.lock'),
      JSON.stringify({
        session_id: sessionId,
        started_at: iso,
        last_heartbeat: iso,
        mode: 'deep',
        pid: 999999,
        host: 'test-host',
        ttl_hours: 4,
      }, null, 2) + '\n',
      'utf8',
    );
  }

  it('derives duration_ms + duration_source from an OWNED lock', async () => {
    const dir = await track(await mkGitDir());
    const sessionId = U('k5-owned');
    await writeStopLock(dir, sessionId, Date.now() - 90_000);

    await runHook({ projectDir: dir, stdin: JSON.stringify({ session_id: sessionId }) });

    const record = await readLastEvent(dir);
    expect(record.duration_source).toBe('session-lock');
    expect(record.duration_ms).toBeGreaterThan(80_000);
    expect(record.duration_ms).toBeLessThan(120_000);
  });

  it.each([
    {
      // Catches: inheriting a foreign session's span. Two windows share one
      // working copy routinely, so a lock in this repo may name someone else.
      label: 'the lock names a PEER session',
      setup: (dir) => writeStopLock(dir, U('k5-peer'), Date.now() - 90_000),
      sessionId: U('k5-mine'),
    },
    {
      // Catches: a hard-coded `duration_ms: 0` fallback masquerading as a
      // measurement when there is nothing to measure from.
      label: 'no lock exists — never a fabricated 0',
      setup: () => {},
      sessionId: U('k5-nolock'),
    },
  ])('OMITS both keys when $label', async ({ setup, sessionId }) => {
    const dir = await track(await mkGitDir());
    await setup(dir);

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: sessionId }),
    });

    const record = await readLastEvent(dir);
    expect(record.event).toBe('orchestrator.session.stopped');
    expect(Object.hasOwn(record, 'duration_ms')).toBe(false);
    expect(Object.hasOwn(record, 'duration_source')).toBe(false);
  });
});
