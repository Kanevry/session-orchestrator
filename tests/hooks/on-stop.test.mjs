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
import { isRoot } from '../_helpers/perms.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

async function writeHeartbeat(sessionId) {
  const active = path.join(process.env.SO_SESSION_REGISTRY_DIR, 'active');
  await fs.mkdir(active, { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(
    path.join(active, `${sessionId}.json`),
    JSON.stringify({
      session_id: sessionId,
      pid: process.pid,
      repo_name: 'demo',
      branch: 'main',
      started_at: now,
      last_heartbeat: now,
      status: 'active',
      current_wave: 0,
    }),
  );
}

async function registryFiles() {
  const active = path.join(process.env.SO_SESSION_REGISTRY_DIR, 'active');
  return (await fs.readdir(active).catch(() => [])).filter((n) => n.endsWith('.json'));
}

// ---------------------------------------------------------------------------
// 1. Stop with session_id
// ---------------------------------------------------------------------------

describe('Stop event with session_id', { timeout: 15000 }, () => {
  it('writes the complete session-stopped record for a session payload', async () => {
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: 'sess-abc123' }),
    });

    const record = await readLastEvent(dir);
    expect(record).toMatchObject({
      event: 'orchestrator.session.stopped',
      session_id: 'sess-abc123',
      duration_ms: 0,
      wave: 0,
    });
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Number.isInteger(record.duration_ms)).toBe(true);
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
      input: { hook_event_name: 'Stop', session_id: 'sess-xyz' },
      expected: { event: 'orchestrator.session.stopped', session_id: 'sess-xyz' },
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
      stdin: JSON.stringify({ session_id: 'no-git' }),
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
      stdin: JSON.stringify({ session_id: 'git-positive' }),
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
      stdin: JSON.stringify({ session_id: 'webhook-test' }),
      env: {
        CLANK_EVENT_SECRET: 'test-secret-token',
        // Point to localhost port nobody listens on — connection refused
        CLANK_EVENT_URL: 'http://127.0.0.1:1',
      },
    });

    expect(result.code).toBe(0);
    expect(await readLastEvent(dir)).toMatchObject({
      event: 'orchestrator.session.stopped',
      session_id: 'webhook-test',
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
  it('uses "unknown" instead of the legacy agent_name field', async () => {
    // This test pins the contract change. If the handler ever falls back to
    // input.agent_name again, this assertion will fail loudly.
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SubagentStop', agent_name: 'legacy-name' }),
    });
    const record = await readLastEvent(dir);
    expect(record).toMatchObject({
      event: 'orchestrator.agent.stopped',
      agent: 'unknown',
    });
  });
});

// ---------------------------------------------------------------------------
// 11. Silent-failure observability — sweep.log breadcrumb on deregisterSelf failure
// ---------------------------------------------------------------------------

describe('deregister-failed observability breadcrumb', { timeout: 15000 }, () => {
  it('hook still exits 0 when deregisterSelf throws (read-only registry)', async () => {
    if (process.platform === 'win32') return; // chmod not meaningful on Windows
    const dir = await track(await mkGitDir());
    const badRegistryDir = path.join(os.tmpdir(), 'on-stop-deregister-ro-' + Date.now());
    await fs.mkdir(badRegistryDir, { recursive: true });
    // Pre-create the active/ dir and a heartbeat so deregisterSelf actually
    // tries to unlink something; then lock down the directory so unlink fails.
    const activeDir = path.join(badRegistryDir, 'active');
    await fs.mkdir(activeDir, { recursive: true });
    const sessionId = 'fail-deregister-test';
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

  it.skipIf(isRoot)('appends a deregister-failed entry to sweep.log when deregisterSelf throws', async () => {
    if (process.platform === 'win32') return;
    const dir = await track(await mkGitDir());
    const badRegistryDir = path.join(os.tmpdir(), 'on-stop-deregister-log-' + Date.now());
    await fs.mkdir(badRegistryDir, { recursive: true });
    const activeDir = path.join(badRegistryDir, 'active');
    await fs.mkdir(activeDir, { recursive: true });
    const sessionId = 'fail-deregister-log-test';
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
      const raw = await fs.readFile(path.join(badRegistryDir, 'sweep.log'), 'utf8');
      const entries = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const failed = entries.find((e) => e.event === 'deregister-failed');
      expect(failed).toMatchObject({
        event: 'deregister-failed',
        session_id: sessionId,
      });
      expect(typeof failed.error).toBe('string');
      expect(failed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    } finally {
      try { await fs.chmod(activeDir, 0o755); } catch { /* ignore */ }
      await fs.rm(badRegistryDir, { recursive: true, force: true });
    }
  });

  it('does not write to stderr on deregisterSelf failure', async () => {
    if (process.platform === 'win32') return;
    const dir = await track(await mkGitDir());
    const badRegistryDir = path.join(os.tmpdir(), 'on-stop-deregister-stderr-' + Date.now());
    await fs.mkdir(badRegistryDir, { recursive: true });
    const activeDir = path.join(badRegistryDir, 'active');
    await fs.mkdir(activeDir, { recursive: true });
    const sessionId = 'fail-deregister-stderr-test';
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
// 13. Session registry deregister (v3.1.0 #169)
// ---------------------------------------------------------------------------

describe('session registry deregister (#169)', { timeout: 15000 }, () => {
  it('removes the active heartbeat file when session_id comes via stdin', async () => {
    const dir = await track(await mkGitDir());
    await writeHeartbeat('stop-via-stdin');
    expect(await registryFiles()).toContain('stop-via-stdin.json');

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: 'stop-via-stdin' }),
    });

    expect(await registryFiles()).not.toContain('stop-via-stdin.json');
  });

  it('falls back to .orchestrator/current-session.json when stdin has no session_id', async () => {
    const dir = await track(await mkGitDir());
    await writeHeartbeat('stop-via-fallback');
    await fs.mkdir(path.join(dir, '.orchestrator'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.orchestrator', 'current-session.json'),
      JSON.stringify({ session_id: 'stop-via-fallback', source: 'generated' }),
    );

    await runHook({ projectDir: dir, stdin: '' });

    expect(await registryFiles()).not.toContain('stop-via-fallback.json');
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

  it('is idempotent — removing a missing heartbeat still exits 0', async () => {
    const dir = await track(await mkGitDir());
    // session_id provided but no heartbeat file exists.
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: 'never-registered' }),
    });
    expect(result.code).toBe(0);
    const record = await readLastEvent(dir);
    expect(record.session_id).toBe('never-registered');
  });

  it('does not touch unrelated peer heartbeats', async () => {
    const dir = await track(await mkGitDir());
    await writeHeartbeat('self');
    await writeHeartbeat('peer-one');
    await writeHeartbeat('peer-two');

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: 'self' }),
    });

    const remaining = await registryFiles();
    expect(remaining.sort()).toEqual(['peer-one.json', 'peer-two.json']);
  });

  it('prefers stdin session_id over current-session.json fallback', async () => {
    const dir = await track(await mkGitDir());
    await writeHeartbeat('stdin-wins');
    await writeHeartbeat('fallback-loses');
    await fs.mkdir(path.join(dir, '.orchestrator'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.orchestrator', 'current-session.json'),
      JSON.stringify({ session_id: 'fallback-loses' }),
    );

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: 'stdin-wins' }),
    });

    const remaining = await registryFiles();
    expect(remaining).toContain('fallback-loses.json');
    expect(remaining).not.toContain('stdin-wins.json');
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
      stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: 'ts-test' }),
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
      stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: 'ts-throw-test' }),
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
    const sessionId = 'stop-refreshes-heartbeat';
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
      stdin: JSON.stringify({ session_id: 'impostor-session' }),
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
      stdin: JSON.stringify({ session_id: 'no-lock-to-release' }),
    });
    expect(result.code).toBe(0);
    // Hook still writes the stop event.
    const record = await readLastEvent(dir);
    expect(record.event).toBe('orchestrator.session.stopped');
  });

  it('uses current-session.json fallback when stdin lacks session_id', async () => {
    const dir = await track(await mkGitDir());
    const sessionId = 'fallback-heartbeat-via-current-session';
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
      stdin: JSON.stringify({ session_id: 'nodeps-core' }),
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
      session_id: 'nodeps-core',
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
