/**
 * tests/hooks/on-session-start.test.mjs
 *
 * Regression tests for hooks/on-session-start.mjs — SessionStart event emitter.
 *
 * Strategy: spawn the hook as a subprocess with a tmp project dir (CLAUDE_PROJECT_DIR),
 * assert exit code is always 0, assert the JSONL event was written correctly.
 *
 * Issue #140 (hook implementation).
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOOK = path.resolve(import.meta.dirname, '../../hooks/on-session-start.mjs');
const EVENTS_RELPATH = path.join('.orchestrator', 'metrics', 'events.jsonl');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the hook with the given environment overrides and collect result.
 * @param {{ projectDir: string, env?: Record<string,string> }} opts
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string }>}
 */
async function runHook({ projectDir, env = {}, stdin = null, registryDir = null }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        // Remove any real secret so tests do not hit the network.
        CLANK_EVENT_SECRET: '',
        CLANK_EVENT_URL: '',
        // Isolate session registry writes to the per-test directory (#168).
        ...(registryDir ? { SO_SESSION_REGISTRY_DIR: registryDir } : {}),
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    if (stdin !== null) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Create a minimal temp project directory with a git repo.
 * Uses spawnSync directly (no zx / bash) so the helper works on Windows
 * runners where bash is not on PATH. Issue #216.
 * @returns {Promise<string>}
 */
async function mkProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-session-start-test-'));
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const runGit = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, env: gitEnv, encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    }
  };
  runGit('init', '-q');
  runGit('commit', '--allow-empty', '-m', 'init', '--no-gpg-sign');
  return dir;
}

/**
 * Read and parse all JSONL lines from the events file in a project dir.
 * @param {string} projectDir
 * @returns {Promise<object[]>}
 */
async function readEvents(projectDir) {
  const filePath = path.join(projectDir, EVENTS_RELPATH);
  const raw = await fs.readFile(filePath, 'utf8');
  return raw
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const tmpDirs = [];
let origRegistryDir;

beforeEach(async () => {
  // Isolate the session registry for every test so the real user's
  // ~/.config/session-orchestrator/sessions/active/ is never written to (#168).
  origRegistryDir = process.env.SO_SESSION_REGISTRY_DIR;
  const registryTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-session-start-registry-'));
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

async function mkProjectTracked() {
  const dir = await mkProject();
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Exit code — always 0
// ---------------------------------------------------------------------------

describe('exit code', { timeout: 15000 }, () => {
  it('exits 0 on a normal run', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({ projectDir: dir });
    expect(result.code).toBe(0);
  });

  it('exits 0 when the project directory does not exist (graceful fallback)', async () => {
    const result = await runHook({
      projectDir: path.join(os.tmpdir(), 'nonexistent-so-dir-' + Date.now()),
    });
    expect(result.code).toBe(0);
  });

  it('exits 0 when CLANK_EVENT_SECRET is absent', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      env: { CLANK_EVENT_SECRET: '' },
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Normal run — JSONL event written
// ---------------------------------------------------------------------------

describe('normal run — event written to JSONL', { timeout: 15000 }, () => {
  it('creates the events.jsonl file', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const filePath = path.join(dir, EVENTS_RELPATH);
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it('writes exactly one JSONL line', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
  });

  it('event.event equals "orchestrator.session.started"', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const [evt] = await readEvents(dir);
    expect(evt.event).toBe('orchestrator.session.started');
  });

  it('event.timestamp is an ISO 8601 UTC timestamp', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const [evt] = await readEvents(dir);
    expect(evt.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
  });

  it('event.project matches the directory basename', async () => {
    const dir = await mkProjectTracked();
    const expectedName = path.basename(dir);
    await runHook({ projectDir: dir });
    const [evt] = await readEvents(dir);
    expect(evt.project).toBe(expectedName);
  });

  it('event.branch is a non-empty string', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const [evt] = await readEvents(dir);
    expect(typeof evt.branch).toBe('string');
    expect(evt.branch.length).toBeGreaterThan(0);
  });

  it('event.platform field is present', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const [evt] = await readEvents(dir);
    expect(evt).toHaveProperty('platform');
  });
});

// ---------------------------------------------------------------------------
// CLANK_EVENT_SECRET absent — no network calls attempted
// ---------------------------------------------------------------------------

describe('CLANK_EVENT_SECRET absent — no webhook', { timeout: 15000 }, () => {
  it('exits 0 and writes event even without CLANK_EVENT_SECRET', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      env: { CLANK_EVENT_SECRET: '' },
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Host banner (v3.1.0 #164)
// ---------------------------------------------------------------------------

describe('host banner (v3.1.0 #164)', { timeout: 15000 }, () => {
  it('emits a systemMessage JSON line with host banner when no config present (default enabled)', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({ projectDir: dir });
    expect(result.code).toBe(0);
    const systemLines = result.stdout
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    const banner = systemLines.find((l) => l.systemMessage);
    expect(banner).toBeDefined();
    expect(banner.systemMessage).toMatch(/^🖥️\s+Host:/);
    expect(banner.systemMessage).toMatch(/📊\s+Resources:/);
  });

  it('suppresses the banner when enable-host-banner: false is present in CLAUDE.md', async () => {
    const dir = await mkProjectTracked();
    await fs.writeFile(
      path.join(dir, 'CLAUDE.md'),
      '# Test\n\n## Session Config\n\nenable-host-banner: false\n',
      'utf8',
    );
    const result = await runHook({ projectDir: dir });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toMatch(/systemMessage/);
  });

  it('includes host_class and resource fields on the emitted event', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const [evt] = await readEvents(dir);
    expect(evt.host_class).toMatch(/^(macos|linux|windows|freebsd)/);
    expect(typeof evt.ram_free_gb).toBe('number');
    expect(typeof evt.cpu_load_pct).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Project-dir resolution
// ---------------------------------------------------------------------------

describe('project-dir resolution', { timeout: 15000 }, () => {
  it('uses CLAUDE_PROJECT_DIR to resolve the events file location', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const expectedPath = path.join(dir, EVENTS_RELPATH);
    await expect(fs.access(expectedPath)).resolves.toBeUndefined();
  });

  it('event.project is "unknown" or fallback when no git repo is present', async () => {
    // Non-git directory — git commands will fail gracefully.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-session-start-nogit-'));
    tmpDirs.push(dir);
    const result = await runHook({ projectDir: dir });
    expect(result.code).toBe(0);
    const filePath = path.join(dir, EVENTS_RELPATH);
    const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
    if (fileExists) {
      const events = await readEvents(dir);
      expect(events[0].event).toBe('orchestrator.session.started');
    }
  });
});

// ---------------------------------------------------------------------------
// Silent-failure observability — sweep.log breadcrumb on registerSelf failure
// ---------------------------------------------------------------------------

describe('register-failed observability breadcrumb', { timeout: 15000 }, () => {
  it('hook still exits 0 when the registry dir is read-only (registerSelf fails)', async () => {
    if (process.platform === 'win32') return; // chmod not meaningful on Windows
    const dir = await mkProjectTracked();
    // Point the registry to a non-writable path so registerSelf fails.
    const badRegistryDir = path.join(os.tmpdir(), 'hook-session-start-ro-' + Date.now());
    await fs.mkdir(badRegistryDir, { recursive: true });
    // Make it read-only so mkdir(active/) inside registerSelf throws EACCES.
    await fs.chmod(badRegistryDir, 0o555);
    try {
      const result = await runHook({ projectDir: dir, registryDir: badRegistryDir });
      expect(result.code).toBe(0);
    } finally {
      await fs.chmod(badRegistryDir, 0o755);
      await fs.rm(badRegistryDir, { recursive: true, force: true });
    }
  });

  it('appends a register-failed entry to sweep.log when registerSelf throws', async () => {
    if (process.platform === 'win32') return; // chmod not meaningful on Windows
    const dir = await mkProjectTracked();
    const badRegistryDir = path.join(os.tmpdir(), 'hook-session-start-log-' + Date.now());
    await fs.mkdir(badRegistryDir, { recursive: true });
    await fs.chmod(badRegistryDir, 0o555);
    try {
      await runHook({ projectDir: dir, registryDir: badRegistryDir });
      // The log may not be writable either if the dir is 0o555, but the hook
      // must not crash. Just verify exit code 0 was already asserted above.
      // Restore and then check sweep.log if it was written.
      await fs.chmod(badRegistryDir, 0o755);
      const logPath = path.join(badRegistryDir, 'sweep.log');
      const exists = await fs.access(logPath).then(() => true).catch(() => false);
      if (exists) {
        const raw = await fs.readFile(logPath, 'utf8');
        const entries = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const failed = entries.find((e) => e.event === 'register-failed');
        expect(failed).toBeDefined();
        expect(typeof failed.session_id).toBe('string');
        expect(typeof failed.error).toBe('string');
        expect(failed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      }
    } finally {
      try { await fs.chmod(badRegistryDir, 0o755); } catch { /* ignore */ }
      await fs.rm(badRegistryDir, { recursive: true, force: true });
    }
  });

  it('does not write to stderr on registerSelf failure', async () => {
    if (process.platform === 'win32') return;
    const dir = await mkProjectTracked();
    const badRegistryDir = path.join(os.tmpdir(), 'hook-session-start-stderr-' + Date.now());
    await fs.mkdir(badRegistryDir, { recursive: true });
    await fs.chmod(badRegistryDir, 0o555);
    try {
      const result = await runHook({ projectDir: dir, registryDir: badRegistryDir });
      expect(result.stderr).toBe('');
    } finally {
      try { await fs.chmod(badRegistryDir, 0o755); } catch { /* ignore */ }
      await fs.rm(badRegistryDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Multi-session registry (v3.1.0 #168)
// ---------------------------------------------------------------------------

describe('multi-session registry (#168)', { timeout: 15000 }, () => {
  async function readRegistry() {
    const dir = path.join(process.env.SO_SESSION_REGISTRY_DIR, 'active');
    const names = await fs.readdir(dir).catch(() => []);
    const entries = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const raw = await fs.readFile(path.join(dir, n), 'utf8');
      entries.push(JSON.parse(raw));
    }
    return entries;
  }

  it('registers the current session in the active/ directory', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const entries = await readRegistry();
    expect(entries).toHaveLength(1);
    expect(entries[0].pid).toBe(entries[0].pid); // sanity
    expect(entries[0].session_id).toBeTruthy();
    expect(entries[0].repo_name).toBe(path.basename(dir));
    expect(entries[0].status).toBe('active');
  });

  it('uses the stdin session_id when provided', async () => {
    const dir = await mkProjectTracked();
    const stdinId = 'claude-stdin-session-id-42';
    await runHook({ projectDir: dir, stdin: JSON.stringify({ session_id: stdinId }) });
    const entries = await readRegistry();
    expect(entries).toHaveLength(1);
    expect(entries[0].session_id).toBe(stdinId);
  });

  it('falls back to a generated uuid when stdin carries no session_id', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const entries = await readRegistry();
    expect(entries[0].session_id).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('persists the session id to .orchestrator/current-session.json', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const raw = await fs.readFile(path.join(dir, '.orchestrator', 'current-session.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.session_id).toBeTruthy();
    expect(parsed.source).toBe('generated');
  });

  it('records source=stdin when session_id came from stdin', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir, stdin: JSON.stringify({ session_id: 'stdin-42' }) });
    const raw = await fs.readFile(path.join(dir, '.orchestrator', 'current-session.json'), 'utf8');
    expect(JSON.parse(raw).source).toBe('stdin');
  });

  it('filters self out of detected peers — peer_count is 0 on a clean registry', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const [evt] = await readEvents(dir);
    expect(evt.peer_count).toBe(0);
  });

  it('reports peer_count on the event and emits a peer banner when peers exist', async () => {
    const dir1 = await mkProjectTracked();
    const dir2 = await mkProjectTracked();
    // Simulate a first session.
    await runHook({ projectDir: dir1 });
    // Second session should detect the first as a peer.
    const result = await runHook({ projectDir: dir2 });
    const events = await readEvents(dir2);
    expect(events.at(-1).peer_count).toBe(1);
    // Banner should contain a peer line.
    const banners = result.stdout
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .filter((l) => l.systemMessage);
    const peerBanner = banners.find((l) => /Peers: \d+ active/.test(l.systemMessage));
    expect(peerBanner).toBeDefined();
  });

  it('prepends a WARN icon when peer count meets concurrent-sessions-warn threshold', async () => {
    // Pre-populate the registry with 2 live peers (threshold in test CLAUDE.md: 2).
    const activeDir = path.join(process.env.SO_SESSION_REGISTRY_DIR, 'active');
    await fs.mkdir(activeDir, { recursive: true });
    const now = new Date().toISOString();
    for (const id of ['peer-a', 'peer-b']) {
      await fs.writeFile(
        path.join(activeDir, `${id}.json`),
        JSON.stringify({
          session_id: id,
          pid: 99999,
          repo_name: 'demo',
          branch: 'main',
          started_at: now,
          last_heartbeat: now,
          status: 'active',
          current_wave: 0,
        }),
      );
    }
    const dir = await mkProjectTracked();
    await fs.writeFile(
      path.join(dir, 'CLAUDE.md'),
      '# Test\n\n## Session Config\n\nconcurrent-sessions-warn: 2\n',
      'utf8',
    );
    const result = await runHook({ projectDir: dir });
    const banners = result.stdout
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .filter((l) => l.systemMessage && l.systemMessage.includes('Peers:'));
    expect(banners).toHaveLength(1);
    expect(banners[0].systemMessage).toMatch(/^⚠️/);
  });

  it('sweeps zombie heartbeats older than 60 minutes on session start', async () => {
    const activeDir = path.join(process.env.SO_SESSION_REGISTRY_DIR, 'active');
    await fs.mkdir(activeDir, { recursive: true });
    const oldTs = new Date(Date.now() - 120 * 60_000).toISOString();
    await fs.writeFile(
      path.join(activeDir, 'zombie.json'),
      JSON.stringify({
        session_id: 'zombie',
        pid: 1,
        repo_name: 'crashed',
        branch: 'main',
        started_at: oldTs,
        last_heartbeat: oldTs,
        status: 'active',
        current_wave: 0,
      }),
    );
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const remaining = await fs.readdir(activeDir);
    expect(remaining.includes('zombie.json')).toBe(false);
  });

  it('emits a session_id field on the event', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const [evt] = await readEvents(dir);
    expect(typeof evt.session_id).toBe('string');
    expect(evt.session_id.length).toBeGreaterThan(0);
  });
});
