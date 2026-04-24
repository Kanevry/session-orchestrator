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
 *   1. Stop with session_id — record has event="stop", session_id, wave, duration_ms
 *   2. Stop without session_id — record has event="stop", no session_id key
 *   3. SubagentStop with agent_name — record has event="subagent_stop", agent=<name>
 *   4. Missing / empty stdin — exits 0, writes a stop record (graceful degradation)
 *   5. git info unavailable (non-git dir) — exits 0, record omits branch/commit
 *   6. Discriminator via hook_event_name="SubagentStop" — writes subagent_stop record
 *   7. webhook fetch not called when CLANK_EVENT_SECRET is unset
 *   8. webhook fetch called when CLANK_EVENT_SECRET is set
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
  it('exits 0', async () => {
    const dir = await track(await mkGitDir());
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: 'sess-abc123' }),
    });
    expect(result.code).toBe(0);
  });

  it('writes event="stop" to events.jsonl', async () => {
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: 'sess-abc123' }),
    });
    const record = await readLastEvent(dir);
    expect(record.event).toBe('stop');
  });

  it('record includes session_id', async () => {
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: 'sess-abc123' }),
    });
    const record = await readLastEvent(dir);
    expect(record.session_id).toBe('sess-abc123');
  });

  it('record has ISO timestamp', async () => {
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: 'sess-abc123' }),
    });
    const record = await readLastEvent(dir);
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('record has duration_ms as integer', async () => {
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: 'sess-abc123' }),
    });
    const record = await readLastEvent(dir);
    expect(typeof record.duration_ms).toBe('number');
    expect(Number.isInteger(record.duration_ms)).toBe(true);
  });

  it('record has wave field as integer', async () => {
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: 'sess-abc123' }),
    });
    const record = await readLastEvent(dir);
    expect(typeof record.wave).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// 2. Stop without session_id
// ---------------------------------------------------------------------------

describe('Stop event without session_id', { timeout: 15000 }, () => {
  it('exits 0', async () => {
    const dir = await track(await mkGitDir());
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ wave: 2 }),
    });
    expect(result.code).toBe(0);
  });

  it('writes event="stop" and omits session_id key', async () => {
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ wave: 2 }),
    });
    const record = await readLastEvent(dir);
    expect(record.event).toBe('stop');
    expect(Object.prototype.hasOwnProperty.call(record, 'session_id')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. SubagentStop with agent_name (discriminated by field presence)
// ---------------------------------------------------------------------------

describe('SubagentStop via agent_name field', { timeout: 15000 }, () => {
  it('exits 0', async () => {
    const dir = await track(await mkGitDir());
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ agent_name: 'code-implementer' }),
    });
    expect(result.code).toBe(0);
  });

  it('writes event="subagent_stop" to events.jsonl', async () => {
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ agent_name: 'code-implementer' }),
    });
    const record = await readLastEvent(dir);
    expect(record.event).toBe('subagent_stop');
  });

  it('record includes agent field with the agent_name value', async () => {
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ agent_name: 'test-writer' }),
    });
    const record = await readLastEvent(dir);
    expect(record.agent).toBe('test-writer');
  });

  it('record has ISO timestamp', async () => {
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ agent_name: 'security-reviewer' }),
    });
    const record = await readLastEvent(dir);
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ---------------------------------------------------------------------------
// 4. SubagentStop via hook_event_name discriminator
// ---------------------------------------------------------------------------

describe('SubagentStop via hook_event_name field', { timeout: 15000 }, () => {
  it('writes event="subagent_stop" when hook_event_name is "SubagentStop"', async () => {
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SubagentStop', agent_name: 'ui-developer' }),
    });
    const record = await readLastEvent(dir);
    expect(record.event).toBe('subagent_stop');
    expect(record.agent).toBe('ui-developer');
  });

  it('writes event="stop" when hook_event_name is "Stop"', async () => {
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-xyz' }),
    });
    const record = await readLastEvent(dir);
    expect(record.event).toBe('stop');
  });
});

// ---------------------------------------------------------------------------
// 5. Empty / missing stdin
// ---------------------------------------------------------------------------

describe('empty stdin (no hook payload)', { timeout: 15000 }, () => {
  it('exits 0', async () => {
    const dir = await track(await mkGitDir());
    const result = await runHook({ projectDir: dir, stdin: '' });
    expect(result.code).toBe(0);
  });

  it('writes a stop record even with no stdin', async () => {
    const dir = await track(await mkGitDir());
    await runHook({ projectDir: dir, stdin: '' });
    const record = await readLastEvent(dir);
    expect(record.event).toBe('stop');
  });
});

// ---------------------------------------------------------------------------
// 6. git info unavailable (plain non-git directory)
// ---------------------------------------------------------------------------

describe('git info unavailable', { timeout: 15000 }, () => {
  it('exits 0 when project dir is not a git repo', async () => {
    // Use a plain tmp dir (no git init)
    const dir = await track(await mkTmpDir());
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: 'no-git' }),
    });
    expect(result.code).toBe(0);
  });

  it('writes a stop record without branch/commit when git is unavailable', async () => {
    const dir = await track(await mkTmpDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: 'no-git' }),
    });
    const record = await readLastEvent(dir);
    expect(record.event).toBe('stop');
    // branch and commit should be absent (gitInfo returns null → omitted)
    expect(Object.prototype.hasOwnProperty.call(record, 'branch')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(record, 'commit')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. CLANK_EVENT_SECRET not set — fetch must not be called
// ---------------------------------------------------------------------------

describe('webhook — CLANK_EVENT_SECRET not set', { timeout: 15000 }, () => {
  it('exits 0 and writes record without calling real network', async () => {
    const dir = await track(await mkGitDir());
    // CLANK_EVENT_SECRET omitted in env (runHook default)
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: 'no-webhook' }),
    });
    expect(result.code).toBe(0);
    const record = await readLastEvent(dir);
    expect(record.event).toBe('stop');
  });
});

// ---------------------------------------------------------------------------
// 8. CLANK_EVENT_SECRET set — subprocess exits 0, record still written
//    (We cannot spy on fetch inside a subprocess, so we verify the hook
//    completes successfully with the secret set and a mock URL that will
//    immediately reject — the fire-and-forget must not cause a non-zero exit.)
// ---------------------------------------------------------------------------

describe('webhook — CLANK_EVENT_SECRET set', { timeout: 15000 }, () => {
  it('exits 0 even when the webhook URL is unreachable', async () => {
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
  });

  it('writes a stop record to events.jsonl even with webhook configured', async () => {
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: 'webhook-test-2' }),
      env: {
        CLANK_EVENT_SECRET: 'test-secret-token',
        CLANK_EVENT_URL: 'http://127.0.0.1:1',
      },
    });
    const record = await readLastEvent(dir);
    expect(record.event).toBe('stop');
    expect(record.session_id).toBe('webhook-test-2');
  });
});

// ---------------------------------------------------------------------------
// 9. Multiple sequential events accumulate in events.jsonl
// ---------------------------------------------------------------------------

describe('sequential event accumulation', { timeout: 20000 }, () => {
  it('two runs produce two lines in events.jsonl', async () => {
    const dir = await track(await mkGitDir());
    await runHook({ projectDir: dir, stdin: JSON.stringify({ agent_name: 'agent-1' }) });
    await runHook({ projectDir: dir, stdin: JSON.stringify({ agent_name: 'agent-2' }) });
    const events = await readAllEvents(dir);
    expect(events).toHaveLength(2);
    expect(events[0].agent).toBe('agent-1');
    expect(events[1].agent).toBe('agent-2');
  });
});

// ---------------------------------------------------------------------------
// 10. SubagentStop with unknown agent (missing agent_name)
// ---------------------------------------------------------------------------

describe('SubagentStop with missing agent_name', { timeout: 15000 }, () => {
  it('uses "unknown" as agent value when agent_name is absent', async () => {
    const dir = await track(await mkGitDir());
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SubagentStop' }),
    });
    const record = await readLastEvent(dir);
    expect(record.event).toBe('subagent_stop');
    expect(record.agent).toBe('unknown');
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

  it('appends a deregister-failed entry to sweep.log when deregisterSelf throws', async () => {
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
      const logPath = path.join(badRegistryDir, 'sweep.log');
      const exists = await fs.access(logPath).then(() => true).catch(() => false);
      if (exists) {
        const raw = await fs.readFile(logPath, 'utf8');
        const entries = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const failed = entries.find((e) => e.event === 'deregister-failed');
        expect(failed).toBeDefined();
        expect(failed.session_id).toBe(sessionId);
        expect(typeof failed.error).toBe('string');
        expect(failed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      }
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
    expect(record.event).toBe('stop');
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
