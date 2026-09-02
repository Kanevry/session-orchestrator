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
import { isRoot } from '../_helpers/perms.mjs';
import { telemetryIsolationEnv } from '../_helpers/telemetry-isolation.mjs';

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
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, pid: number|undefined }>}
 */
async function runHook({ projectDir, env = {}, stdin = null, registryDir = null, useCwd = false }) {
  return new Promise((resolve) => {
    const spawnOpts = {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        // Remove any real secret so tests do not hit the network.
        CLANK_EVENT_SECRET: '',
        CLANK_EVENT_URL: '',
        // Isolate session registry writes to the per-test directory (#168).
        ...(registryDir ? { SO_SESSION_REGISTRY_DIR: registryDir } : {}),
        // Scrub the operator's own session id. The live Claude Code environment
        // exports CLAUDE_CODE_SESSION_ID (#1123), and `...process.env` above
        // would hand the hook a REAL id from the surrounding session — which is
        // exactly the input several tests below claim to control. `undefined`
        // removes the key from the child env (node skips undefined entries).
        CLAUDE_CODE_SESSION_ID: undefined,
        // #1138 — the hook reads the host's telemetry consent record to decide
        // whether to inject the consent nudge. It never WRITES it, so there is
        // no data hazard here; the hazard is determinism, because stdout would
        // otherwise differ between a machine that has decided and one that has
        // not. The nudge block below overrides HOME deliberately.
        ...telemetryIsolationEnv(),
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    // Opt-in: set cwd to projectDir so cwd-sensitive subprocess calls
    // (git worktree list inside discoverActiveSessions, Epic #583 W3-P3)
    // see only the per-test fixture's worktree set rather than the test
    // runner's own repository worktrees. Opt-in keeps the
    // "nonexistent-project-dir graceful fallback" test working.
    if (useCwd) spawnOpts.cwd = projectDir;
    const child = spawn(process.execPath, [HOOK], spawnOpts);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    if (stdin !== null) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
    child.on('close', (code) => resolve({ code, stdout, stderr, pid: child.pid }));
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
 *
 * Filter applied: only events of type "orchestrator.session.started" are
 * returned by default. P3 (Epic #583 #584) added a SECOND event type
 * "orchestrator.session.lock.acquired" — passing it through here would
 * break the existing per-event-count assertions. Tests that want the
 * full event stream use {@link readAllEvents}.
 *
 * @param {string} projectDir
 * @returns {Promise<object[]>}
 */
async function readEvents(projectDir) {
  const events = await readAllEvents(projectDir);
  return events.filter((e) => e.event === 'orchestrator.session.started');
}

/**
 * Read and parse ALL JSONL lines from the events file in a project dir,
 * including the P3 (Epic #583) "orchestrator.session.lock.acquired" event.
 *
 * @param {string} projectDir
 * @returns {Promise<object[]>}
 */
async function readAllEvents(projectDir) {
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
// Missing project directory — graceful fallback
// ---------------------------------------------------------------------------

describe('missing project directory', { timeout: 15000 }, () => {
  it('still writes a session-start event when the project directory does not exist', async () => {
    const dir = path.join(os.tmpdir(), 'nonexistent-so-dir-' + Date.now());
    tmpDirs.push(dir);
    await runHook({ projectDir: dir });

    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'orchestrator.session.started',
      project: path.basename(dir),
      branch: 'unknown',
    });
  });
});

// ---------------------------------------------------------------------------
// Normal run — JSONL event written
// ---------------------------------------------------------------------------

describe('normal run — event written to JSONL', { timeout: 15000 }, () => {
  it('writes one complete session-start event record', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });

    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    const [evt] = events;
    expect(evt).toMatchObject({
      event: 'orchestrator.session.started',
      project: path.basename(dir),
    });
    expect(evt.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
    expect(typeof evt.branch).toBe('string');
    expect(evt.branch.length).toBeGreaterThan(0);
    expect(evt).toHaveProperty('platform');
    expect(typeof evt.session_id).toBe('string');
    expect(evt.session_id.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Host banner (v3.1.0 #164)
// ---------------------------------------------------------------------------

describe('host banner (v3.1.0 #164)', { timeout: 15000 }, () => {
  it('emits a systemMessage JSON line with host banner when no config present (default enabled)', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({ projectDir: dir });
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
  it('writes the fallback project and branch values when no git repo is present', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-session-start-nogit-'));
    tmpDirs.push(dir);
    await runHook({ projectDir: dir });

    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'orchestrator.session.started',
      project: path.basename(dir),
      branch: 'unknown',
    });
  });
});

// ---------------------------------------------------------------------------
// Silent-failure observability — sweep.log breadcrumb on registerSelf failure
// ---------------------------------------------------------------------------

describe('register-failed observability breadcrumb', { timeout: 15000 }, () => {
  it.skipIf(isRoot || process.platform === 'win32')('hook still exits 0 when the registry dir is read-only (registerSelf fails)', async () => {
    const dir = await mkProjectTracked();
    // Point the registry to a non-writable path so registerSelf fails.
    const badRegistryDir = path.join(os.tmpdir(), 'hook-session-start-ro-' + Date.now());
    await fs.mkdir(badRegistryDir, { recursive: true });
    // Make it read-only so mkdir(active/) inside registerSelf throws EACCES.
    await fs.chmod(badRegistryDir, 0o555);
    try {
      const result = await runHook({ projectDir: dir, registryDir: badRegistryDir });
      expect(result.code).toBe(0);
      expect((await readEvents(dir))[0].event).toBe('orchestrator.session.started');
    } finally {
      await fs.chmod(badRegistryDir, 0o755);
      await fs.rm(badRegistryDir, { recursive: true, force: true });
    }
  });

  it.skipIf(isRoot || process.platform === 'win32')('appends a register-failed entry to sweep.log when registerSelf throws', async () => {
    const dir = await mkProjectTracked();
    const badRegistryDir = path.join(os.tmpdir(), 'hook-session-start-log-' + Date.now());
    const activeDir = path.join(badRegistryDir, 'active');
    await fs.mkdir(activeDir, { recursive: true });
    await fs.chmod(activeDir, 0o555);
    try {
      await runHook({ projectDir: dir, registryDir: badRegistryDir });
      await fs.chmod(activeDir, 0o755);
      const raw = await fs.readFile(path.join(badRegistryDir, 'sweep.log'), 'utf8');
      const entries = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const failed = entries.find((e) => e.event === 'register-failed');
      expect(failed).toMatchObject({ event: 'register-failed' });
      expect(typeof failed.session_id).toBe('string');
      expect(typeof failed.error).toBe('string');
      expect(failed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    } finally {
      try { await fs.chmod(activeDir, 0o755); } catch { /* ignore */ }
      await fs.rm(badRegistryDir, { recursive: true, force: true });
    }
  });

  it.skipIf(isRoot || process.platform === 'win32')('does not write to stderr on registerSelf failure', async () => {
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
    expect(entries[0].session_id).toMatch(
      /^([a-f0-9-]{36}|[a-z0-9._/-]+-\d{4}-\d{2}-\d{2}-[a-z-]+-\d+)$/,
    );
    expect(entries[0].repo_name).toBe(path.basename(dir));
    expect(entries[0].status).toBe('active');
    expect((await readEvents(dir))[0].session_id).toBe(entries[0].session_id);
  });

  it('generates a UUID instead of using a malformed stdin session_id', async () => {
    const dir = await mkProjectTracked();
    const malformedSessionId = 'not-a-uuid';
    await runHook({ projectDir: dir, stdin: JSON.stringify({ session_id: malformedSessionId }) });

    const entries = await readRegistry();
    const raw = await fs.readFile(path.join(dir, '.orchestrator', 'current-session.json'), 'utf8');
    const currentSession = JSON.parse(raw);
    expect(entries).toHaveLength(1);
    expect(currentSession).toMatchObject({
      session_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
      source: 'generated-uuid',
    });
    expect(currentSession.session_id).not.toBe(malformedSessionId);
    expect(entries[0].session_id).toBe(currentSession.session_id);
  });

  it('generates a UUID raw session_id and a separate semantic label when stdin carries no session_id', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });

    const entries = await readRegistry();
    const raw = await fs.readFile(path.join(dir, '.orchestrator', 'current-session.json'), 'utf8');
    const currentSession = JSON.parse(raw);
    expect(currentSession).toMatchObject({
      session_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
      semantic_session_id: expect.stringMatching(/^[a-z0-9._/-]+-\d{4}-\d{2}-\d{2}-[a-z-]+-\d+$/),
      source: 'generated-uuid',
    });
    expect(entries[0].session_id).toBe(currentSession.session_id);
    expect(currentSession.semantic_session_id).not.toBe(currentSession.session_id);
  });

  it('does not repurpose a semantic stdin label as the physical raw session_id', async () => {
    const dir = await mkProjectTracked();
    const semanticHint = 'main-2026-08-20-deep-9';
    await runHook({ projectDir: dir, stdin: JSON.stringify({ session_id: semanticHint }) });

    const raw = await fs.readFile(path.join(dir, '.orchestrator', 'current-session.json'), 'utf8');
    const currentSession = JSON.parse(raw);
    expect(currentSession.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(currentSession.session_id).not.toBe(semanticHint);
  });

  it('persists the generated UUID source to .orchestrator/current-session.json', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const raw = await fs.readFile(path.join(dir, '.orchestrator', 'current-session.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(parsed.source).toBe('generated-uuid');
  });

  // The harness does not promise v4. `parseSessionId`'s UUID_RE accepts any
  // RFC 9562 version 1–8, and the start path must pass whatever it is through
  // VERBATIM — into current-session.json AND into the session.lock, which is
  // the file every peer-detection consumer keys on. Before this case, no
  // UUIDv7 ever reached the start path in any test, so a version re-pin to v4
  // (regenerating the id instead of preserving it) would have gone unnoticed.
  it.each([
    ['v4', '550e8400-e29b-41d4-a716-446655440004'],
    ['v7', '017f22e2-79b0-7cc3-98c4-dc0c0c07398f'],
  ])('preserves a valid UUID-%s supplied through the sessionId alias', async (_version, stdinUuid) => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir, stdin: JSON.stringify({ sessionId: stdinUuid }) });

    const raw = await fs.readFile(path.join(dir, '.orchestrator', 'current-session.json'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ session_id: stdinUuid, source: 'stdin' });

    const lockRaw = await fs.readFile(path.join(dir, '.orchestrator', 'session.lock'), 'utf8');
    const lock = JSON.parse(lockRaw);
    expect(lock.session_id).toBe(stdinUuid);
    // The semantic label is derived independently and must never be the raw id.
    expect(lock.semantic_session_id).not.toBe(stdinUuid);
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
    // #1089: all banner lines leave as ONE systemMessage (see flushBanner) —
    // search the combined text, not for a dedicated object.
    const peerBanner = banners.find((l) => /Peers: \d+ live on this host/.test(l.systemMessage));
    expect(peerBanner).toBeDefined();
  });

  it('prepends a WARN icon when peer count meets concurrent-sessions-warn threshold', async () => {
    // Pre-populate the registry with 2 live peers (threshold in test CLAUDE.md: 2).
    const activeDir = path.join(process.env.SO_SESSION_REGISTRY_DIR, 'active');
    await fs.mkdir(activeDir, { recursive: true });
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(activeDir, 'peer-a.json'),
      JSON.stringify({
        session_id: 'peer-a',
        pid: 99999,
        repo_name: 'demo',
        branch: 'main',
        started_at: now,
        last_heartbeat: now,
        status: 'active',
        current_wave: 0,
      }),
    );
    await fs.writeFile(
      path.join(activeDir, 'peer-b.json'),
      JSON.stringify({
        session_id: 'peer-b',
        pid: 99999,
        repo_name: 'demo',
        branch: 'main',
        started_at: now,
        last_heartbeat: now,
        status: 'active',
        current_wave: 0,
      }),
    );
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
    // #1089: exactly ONE systemMessage object is written — that is the contract
    // Claude Code reads. The WARN icon now sits on the peer LINE within it.
    expect(banners).toHaveLength(1);
    const peerLine = banners[0].systemMessage
      .split('\n')
      .find((l) => l.includes('Peers:'));
    expect(peerLine).toMatch(/^⚠️/);
  });

  // -------------------------------------------------------------------------
  // Single-envelope transport (#1089)
  // -------------------------------------------------------------------------
  //
  // Claude Code surfaces only the FIRST JSON object a SessionStart hook writes
  // to stdout. This hook had five independent emitters, so a measured live run
  // produced four stdout lines of which the operator saw one — silently
  // discarding both peer banners, i.e. exactly the lines that warn another
  // session holds this working copy. Every test in this file parsed stdout
  // itself and therefore saw all four, which is why none of them noticed.
  it('writes EXACTLY ONE JSON object to stdout even with peers present', async () => {
    const activeDir = path.join(process.env.SO_SESSION_REGISTRY_DIR, 'active');
    await fs.mkdir(activeDir, { recursive: true });
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(activeDir, 'peer-transport.json'),
      JSON.stringify({
        session_id: 'peer-transport',
        pid: 99999,
        repo_name: 'demo',
        branch: 'main',
        started_at: now,
        last_heartbeat: now,
        status: 'active',
        current_wave: 0,
      }),
    );
    const dir = await mkProjectTracked();
    const result = await runHook({ projectDir: dir });

    const objects = result.stdout
      .split('\n')
      .filter((l) => l.trim().startsWith('{'));
    expect(objects).toHaveLength(1);

    // ...and that one object still carries every line, so the consolidation
    // did not simply drop the banners it was meant to rescue.
    const combined = JSON.parse(objects[0]).systemMessage;
    expect(combined).toContain('Host:');
    expect(combined).toContain('Resources:');
    expect(combined).toContain('Peers:');
  });

  it('reports memory as pressure/available, never as Darwin Pages-free', async () => {
    // HR-106: the banner number must be the number the rule judged. The old
    // line printed `os.freemem()`, whose median across 1477 measured starts was
    // 0.4 GB on 24-128 GB hosts.
    const dir = await mkProjectTracked();
    const result = await runHook({ projectDir: dir });
    const combined = result.stdout
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((o) => o && o.systemMessage)
      .map((o) => o.systemMessage)
      .join('\n');
    const resourceLine = combined.split('\n').find((l) => l.includes('Resources:'));
    expect(resourceLine).toBeDefined();
    if (process.platform === 'darwin') {
      // On Darwin one of the two better signals is always published.
      expect(resourceLine).toMatch(/memory free \(OS pressure\)|GB available/);
      expect(resourceLine).not.toMatch(/GB free/);
    }
    // The concurrency figure is sessions, never the raw process count.
    expect(resourceLine).not.toMatch(/Claude process/);
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
});

// ---------------------------------------------------------------------------
// High-water-mark preservation across SessionStart (#612 root-cause fix)
// ---------------------------------------------------------------------------
//
// SessionStart fires on startup|clear|compact|resume. On clear/compact/resume
// of the SAME logical session the UUID session_id changes but the
// semantic_session_id stays stable. The hook must therefore PRESERVE the
// last_wave / last_batch high-water marks (written mid-session by
// post-tool-batch-wave-signal.mjs) when the prior current-session.json carries
// the SAME semantic_session_id — otherwise a full overwrite drops last_wave,
// and the next PostToolBatch re-emits a duplicate orchestrator.wave.started{N}.
// For a genuinely NEW logical session (different/absent semantic id) the marks
// are RESET (current behaviour).

describe('high-water-mark preservation across SessionStart (#612)', { timeout: 15000 }, () => {
  async function readSessionFile(projectDir) {
    const raw = await fs.readFile(
      path.join(projectDir, '.orchestrator', 'current-session.json'),
      'utf8',
    );
    return JSON.parse(raw);
  }

  /**
   * Wipe every n-counter memory the first hook run left behind, so a subsequent
   * run resolves the SAME semantic id (a clean slate yields `-1` again). This
   * deterministically simulates a clear/compact/resume of the SAME logical
   * session — the new UUID changes but the semantic id is stable while
   * current-session.json's high-water mark persists on disk.
   *
   * Two memories must be cleared, because `resolveSemanticSessionId()` merges
   * several candidate sources:
   *   1. the isolated session registry's active dir (source A — live sessions);
   *   2. the `orchestrator.session.lock.acquired` records in the tmp project's
   *      events.jsonl (source D, the #952 mint ledger, written at CLAIM time by
   *      hooks/_lib/lock-bootstrap.mjs). Clearing (1) alone leaves the minted
   *      `-1` visible in (2), and the next run mints `-2`.
   *
   * Deliberately surgical: only the mint-ledger records are stripped, not the
   * whole events file — the `orchestrator.session.started` lines are not an
   * n-counter memory, and a blanket wipe would blunt the fixture.
   *
   * @param {string} projectDir - The tmp project whose mint ledger to clear.
   */
  async function clearSemanticIdMemory(projectDir) {
    const activeDir = path.join(process.env.SO_SESSION_REGISTRY_DIR, 'active');
    await fs.rm(activeDir, { recursive: true, force: true });

    // Strip the mint-ledger records. The file legitimately may not exist.
    const eventsPath = path.join(projectDir, EVENTS_RELPATH);
    let raw;
    try {
      raw = await fs.readFile(eventsPath, 'utf8');
    } catch {
      return;
    }
    const kept = raw
      .split('\n')
      .filter((l) => l.length > 0 && !l.includes('orchestrator.session.lock.acquired'));
    await fs.writeFile(eventsPath, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
  }

  it('preserves last_wave when the prior session file carries the SAME semantic_session_id', async () => {
    const dir = await mkProjectTracked();
    // First run establishes the semantic_session_id this fixture resolves to
    // (derived from branch+date+mode+history; we read it back rather than
    // hardcode a derived value).
    await runHook({ projectDir: dir });
    const firstSemanticId = (await readSessionFile(dir)).semantic_session_id;
    expect(typeof firstSemanticId).toBe('string');
    expect(firstSemanticId.length).toBeGreaterThan(0);

    // Reclaim the registry slot AND the mint ledger so the next run resolves the
    // SAME semantic id, then simulate mid-session state: the same logical
    // session has progressed to wave 3 (current-session.json carries the SAME
    // semantic id + marks).
    await clearSemanticIdMemory(dir);
    await fs.writeFile(
      path.join(dir, '.orchestrator', 'current-session.json'),
      JSON.stringify(
        {
          session_id: 'prev-uuid-aaaa',
          semantic_session_id: firstSemanticId,
          pid: 12345,
          source: 'stdin',
          timestamp: '2026-05-28T00:00:00.000Z',
          last_wave: 3,
          last_batch: { batch_id: 'wave3-batch1', batch_size: 6 },
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );

    // A clear/compact/resume of the SAME logical session re-fires SessionStart.
    // The semantic id resolves identically, so last_wave/last_batch MUST survive.
    await runHook({ projectDir: dir });
    const after = await readSessionFile(dir);
    expect(after.semantic_session_id).toBe(firstSemanticId);
    expect(Object.prototype.hasOwnProperty.call(after, 'last_wave')).toBe(true);
    expect(after.last_wave).toBe(3);
    expect(after.last_batch).toEqual({ batch_id: 'wave3-batch1', batch_size: 6 });
  });

  it('resets last_wave when the prior session file carries a DIFFERENT semantic_session_id', async () => {
    const dir = await mkProjectTracked();
    // The hook creates .orchestrator/ on its own, but we seed current-session.json
    // BEFORE the run, so create the dir first.
    await fs.mkdir(path.join(dir, '.orchestrator'), { recursive: true });
    // Pre-seed a current-session.json for a DIFFERENT logical session that had
    // progressed to wave 3. The hook will resolve its own (different) semantic
    // id this run, so the marks belong to a stale session and must be dropped.
    await fs.writeFile(
      path.join(dir, '.orchestrator', 'current-session.json'),
      JSON.stringify(
        {
          session_id: 'stale-uuid-bbbb',
          semantic_session_id: 'some-other-branch-2020-01-01-deep-9',
          pid: 54321,
          source: 'stdin',
          timestamp: '2020-01-01T00:00:00.000Z',
          last_wave: 3,
          last_batch: { batch_id: 'stale-batch', batch_size: 2 },
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );

    await runHook({ projectDir: dir });
    const after = await readSessionFile(dir);
    // The resolved semantic id differs from the stale one, so NO preservation.
    expect(after.semantic_session_id).not.toBe('some-other-branch-2020-01-01-deep-9');
    expect(Object.prototype.hasOwnProperty.call(after, 'last_wave')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(after, 'last_batch')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mechanical session.lock writer (Epic #583 P3 — #584 + #587)
// ---------------------------------------------------------------------------
//
// W2-I1 adds a mechanical .orchestrator/session.lock writer at SessionStart
// so discoverActiveSessions() picks up the current session even when the
// coordinator-LLM skips the prose Phase 1.2 acquire-call. The lock body
// adopts schema v2:
//   - session_id           — physical native raw ID from stdin, or a generated UUID
//   - semantic_session_id  — separately derived semantic attribution (D4 #587)
//   - started_at           — ISO timestamp at acquire-time
//   - last_heartbeat       — ISO; basis for liveness (replaces PID-liveness)
//   - mode                 — session mode
//   - pid                  — writer PID (forensics only; NOT used for liveness)
//   - host                 — os.hostname()
//   - ttl_hours            — default 4

describe('mechanical session.lock writer (#584 + #587)', { timeout: 15000 }, () => {
  async function readSessionLock(projectDir) {
    const lockPath = path.join(projectDir, '.orchestrator', 'session.lock');
    const raw = await fs.readFile(lockPath, 'utf8');
    return JSON.parse(raw);
  }

  it('T1: hook with stdin UUID writes session.lock containing BOTH UUID session_id AND semantic semantic_session_id', async () => {
    const dir = await mkProjectTracked();
    const stdinUuid = '550e8400-e29b-41d4-a716-446655440000';
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: stdinUuid, mode: 'deep' }),
    });

    const lock = await readSessionLock(dir);
    // session_id should be the UUID provided via stdin
    expect(lock.session_id).toBe(stdinUuid);
    // semantic_session_id should be the semantic form derived independently
    expect(typeof lock.semantic_session_id).toBe('string');
    expect(lock.semantic_session_id).toMatch(
      /^[a-z0-9._/-]+-\d{4}-\d{2}-\d{2}-[a-z-]+-\d+$/,
    );
    // They must DIFFER — that's the whole point of the D4 fix
    expect(lock.semantic_session_id).not.toBe(stdinUuid);
  });

  it('T2: hook without stdin writes session.lock with UUID session_id and separate semantic_session_id', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });

    const lock = await readSessionLock(dir);
    expect(lock.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(lock.semantic_session_id).toMatch(
      /^[a-z0-9._/-]+-\d{4}-\d{2}-\d{2}-[a-z-]+-\d+$/,
    );
    expect(lock.semantic_session_id).not.toBe(lock.session_id);
  });

  it.skipIf(process.platform === 'win32')('T3: bootstrapLock failure does NOT crash the hook (best-effort contract)', async () => {
    // Force a bootstrap failure by making the .orchestrator/ directory a
    // read-only file (so the lock write to .orchestrator/session.lock fails).
    // The hook should still exit 0 and emit its normal event.
    const dir = await mkProjectTracked();
    // Pre-create the .orchestrator/ as a file (not a dir) so any mkdir+write
    // inside it fails.
    await fs.writeFile(path.join(dir, '.orchestrator'), 'blocker', 'utf8');

    const result = await runHook({ projectDir: dir });
    // Hook must still exit 0 — the bootstrap failure is swallowed.
    expect(result.code).toBe(0);
    // session.lock must NOT exist (because .orchestrator/ is a file)
    const lockExists = await fs
      .access(path.join(dir, '.orchestrator', 'session.lock'))
      .then(() => true)
      .catch(() => false);
    expect(lockExists).toBe(false);
  });

  it('T4: registerSelf payload carries the mode field', async () => {
    const dir = await mkProjectTracked();
    const stdinUuid = '550e8400-e29b-41d4-a716-446655440001';
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ session_id: stdinUuid, mode: 'feature' }),
    });
    // Registry entry should carry the mode (W2-I3 will add the field;
    // before that, the field is silently dropped by registerSelf — which is
    // a separate test concern. Here we verify the HOOK passes it.)
    // We assert via the session.lock instead (always written): mode must equal
    // the stdin-supplied mode (normalised to lowercase).
    const lock = await readSessionLock(dir);
    expect(lock.mode).toBe('feature');
  });

  it('T5: writes a fresh heartbeat and the default four-hour TTL', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });

    const lock = await readSessionLock(dir);
    expect(typeof lock.last_heartbeat).toBe('string');
    expect(typeof lock.started_at).toBe('string');
    const heartbeatMs = Date.parse(lock.last_heartbeat);
    const startedMs = Date.parse(lock.started_at);
    expect(Number.isFinite(heartbeatMs)).toBe(true);
    expect(Number.isFinite(startedMs)).toBe(true);
    // On bootstrap, last_heartbeat MUST equal started_at (the helper sets
    // them identically). Allow up to 1s drift in case a future change
    // updates last_heartbeat separately.
    expect(Math.abs(heartbeatMs - startedMs)).toBeLessThanOrEqual(1000);
    expect(lock.ttl_hours).toBe(4);
  });

  it('T6: PID in lock is the writer process PID (forensics only — NOT used for liveness)', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({ projectDir: dir });

    const lock = await readSessionLock(dir);
    // The lock belongs to the hook child, not merely to any positive PID that
    // happens not to equal the test runner. Capturing child.pid makes a stale
    // or parent PID fail this forensic-field regression directly.
    expect(lock.pid).toBe(result.pid);
  });

  it('emits orchestrator.session.lock.acquired observability event', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const events = await readAllEvents(dir);
    const acquired = events.find((e) => e.event === 'orchestrator.session.lock.acquired');
    expect(acquired).toBeDefined();
    expect(typeof acquired.session_id).toBe('string');
    expect(typeof acquired.semantic_session_id).toBe('string');
    expect(typeof acquired.mode).toBe('string');
    expect(typeof acquired.ttl_hours).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Mechanical peer-detection banner (Epic #583 W3-P3)
// ---------------------------------------------------------------------------
//
// In addition to the v3.1.0 host-registry-driven peer banner (#168), the
// SessionStart hook emits a SECOND banner line backed by
// discoverActiveSessions() — the canonical lock + registry merged source.
// This banner fires for any peer the lock-bootstrap hook can detect in the
// repository, EVEN WHEN the v3.1.0 detectPeers() path returned an empty
// list (e.g., the peer's registry write was orphaned, but its session.lock
// is still live and within heartbeat freshness).

describe('mechanical peer-detection banner (Epic #583 W3-P3)', { timeout: 15000 }, () => {
  function parseSystemMessages(stdout) {
    return stdout
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((m) => m && m.systemMessage);
  }

  it('emits "Mechanical peer-detection:" banner naming the peer\'s worktree basename (#1137)', async () => {
    const dir = await mkProjectTracked();
    // Plant a registry entry for a peer session (the registry fallback
    // path in discoverActiveSessions surfaces entries with matching
    // repo_path_hash + fresh heartbeat). That fires the banner without
    // depending on the lock-bootstrap write-order.
    const activeDir = path.join(process.env.SO_SESSION_REGISTRY_DIR, 'active');
    await fs.mkdir(activeDir, { recursive: true });
    const now = new Date().toISOString();
    // Compute repo_path_hash so the registry entry matches `dir`.
    const { repoPathHash } = await import('../../scripts/lib/session-registry.mjs');
    const hash = repoPathHash(dir);
    await fs.writeFile(
      path.join(activeDir, 'peer-mech.json'),
      JSON.stringify({
        session_id: 'peer-mech',
        pid: 99999,
        repo_path_hash: hash,
        repo_name: path.basename(dir),
        branch: 'main',
        mode: 'deep',
        started_at: now,
        last_heartbeat: now,
        status: 'active',
        current_wave: 0,
      }),
    );

    // useCwd: true so `git worktree list` inside discoverActiveSessions
    // runs in the per-test fresh-git fixture, not in the test runner's
    // session-orchestrator worktree.
    const result = await runHook({ projectDir: dir, useCwd: true });

    const messages = parseSystemMessages(result.stdout);
    // #1089: one combined systemMessage — match the LINE, not the object.
    const mechanical = messages
      .flatMap((m) => m.systemMessage.split('\n'))
      .find((l) => /^🔍\s+Mechanical peer-detection:\s+\d+\s+active/.test(l));
    expect(mechanical).toBeDefined();
    // #1137: the label must say WHICH repo surface was searched. The old
    // wording ("active in same repo") claimed the peers share this working
    // copy; discoverActiveSessions walks every path `git worktree list`
    // reports, including worktrees parked elsewhere on the host.
    expect(mechanical).toContain("active in this repo's worktree set");
    expect(mechanical).not.toContain('active in same repo');
    // Each peer is rendered `<worktree-basename>:<session-id>:<mode>` so a peer
    // in a FOREIGN worktree is distinguishable from one in this checkout, AND
    // the operator can see what it is doing (#1151 — a `deep` peer holding the
    // worktree set is a different decision from a `discovery` one). The
    // registry-fallback path sets worktreePath = the discovery repoRoot, so the
    // basename here is the fixture repo's own directory name, and `mode` is the
    // planted entry's own `deep`.
    expect(mechanical).toContain(`${path.basename(dir)}:peer-mech:deep`);
  });

  it('omits the mode segment when the peer records no mode (#1151 guard)', async () => {
    const dir = await mkProjectTracked();
    const activeDir = path.join(process.env.SO_SESSION_REGISTRY_DIR, 'active');
    await fs.mkdir(activeDir, { recursive: true });
    const now = new Date().toISOString();
    const { repoPathHash } = await import('../../scripts/lib/session-registry.mjs');
    // The bug this pins: an UNGUARDED `:${p.mode}` renders a dangling `:` (or
    // `:undefined`) for a peer whose source carried no mode. That is not
    // hypothetical — sessionFromLock() passes `lock.mode` straight through, so
    // any lock written without the field reaches the banner as undefined. An
    // empty-string registry mode takes the SAME falsy branch and is reachable
    // from this fixture without standing up a second worktree.
    await fs.writeFile(
      path.join(activeDir, 'peer-nomode.json'),
      JSON.stringify({
        session_id: 'peer-nomode',
        pid: 99998,
        repo_path_hash: repoPathHash(dir),
        repo_name: path.basename(dir),
        branch: 'main',
        mode: '',
        started_at: now,
        last_heartbeat: now,
        status: 'active',
        current_wave: 0,
      }),
    );

    const result = await runHook({ projectDir: dir, useCwd: true });

    const mechanical = parseSystemMessages(result.stdout)
      .flatMap((m) => m.systemMessage.split('\n'))
      .find((l) => /^🔍\s+Mechanical peer-detection:/.test(l));
    expect(mechanical).toBeDefined();
    expect(mechanical).toContain(`${path.basename(dir)}:peer-nomode`);
    expect(mechanical).not.toContain('peer-nomode:');
    expect(mechanical).not.toContain('undefined');
  });

  it('does NOT emit the mechanical banner when discoverActiveSessions returns only self', async () => {
    const dir = await mkProjectTracked();
    // No peer registry entry; the only lock will be the one this hook
    // writes. useCwd: true scopes `git worktree list` to the fresh-git
    // fixture so the test runner's outer worktree set is not visible.
    const result = await runHook({ projectDir: dir, useCwd: true });

    const messages = parseSystemMessages(result.stdout);
    const mechanical = messages
      .flatMap((m) => m.systemMessage.split('\n'))
      .find((l) => /^🔍\s+Mechanical peer-detection:/.test(l));
    // No mechanical-peer banner — discoverActiveSessions returns only self.
    expect(mechanical).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // GH#67 — supersession marker on registry-only peers
  // -------------------------------------------------------------------------
  //
  // Bug class this pins: a registry entry that a finished task left behind
  // (SessionEnd never ran, heartbeat still fresh) is indistinguishable in the
  // banner from a genuinely live peer, so the operator coordinates with a
  // session that no longer exists. discoverActiveSessions() annotates such an
  // entry (`registryOnly` + `lockSuperseded`); until this change the hook threw
  // the annotation away. The COUNT must stay honest (HR-106, #1085: the lock is
  // advisory, so a superseded entry may still be a live peer) — the marker is
  // additive only.

  /** Plant a fresh registry entry for `dir` under the isolated registry dir. */
  async function plantRegistryPeer(dir, sessionId, extra = {}) {
    const activeDir = path.join(process.env.SO_SESSION_REGISTRY_DIR, 'active');
    await fs.mkdir(activeDir, { recursive: true });
    const now = new Date().toISOString();
    const { repoPathHash } = await import('../../scripts/lib/session-registry.mjs');
    await fs.writeFile(
      path.join(activeDir, `${sessionId}.json`),
      JSON.stringify({
        session_id: sessionId,
        pid: 99997,
        repo_path_hash: repoPathHash(dir),
        repo_name: path.basename(dir),
        branch: 'main',
        mode: 'deep',
        started_at: now,
        last_heartbeat: now,
        status: 'active',
        current_wave: 0,
        ...extra,
      }),
    );
  }

  /**
   * Plant a LIVE session.lock owned by a foreign raw session id. bootstrapLock()
   * leaves it alone (acquire → reason 'active', different id → no force), so the
   * hook sees it as a lock-sourced peer AND as the lock owner that supersedes
   * registry entries carrying a different id.
   */
  async function plantForeignLock(dir, sessionId) {
    const now = new Date().toISOString();
    await fs.mkdir(path.join(dir, '.orchestrator'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.orchestrator', 'session.lock'),
      JSON.stringify({
        session_id: sessionId,
        semantic_session_id: sessionId,
        started_at: now,
        last_heartbeat: now,
        mode: 'deep',
        pid: 99996,
        host: os.hostname(),
        ttl_hours: 4,
      }),
    );
  }

  function mechanicalLines(stdout) {
    return parseSystemMessages(stdout).flatMap((m) => m.systemMessage.split('\n'));
  }

  /**
   * A SessionStart hook surfaces only the FIRST stdout JSON object (HR-106), so
   * `mechanicalLines()` — which unions across every object — would stay green if
   * the banner or its GH#67 explanation were emitted as a SECOND object nobody
   * ever sees. Pin the single envelope alongside every content assertion.
   */
  function expectSingleEnvelope(stdout) {
    const objects = stdout.split('\n').filter((l) => l.trim().startsWith('{'));
    expect(objects).toHaveLength(1);
  }

  it('marks a registry-only peer superseded by this root\'s live lock, without changing the count (GH#67)', async () => {
    const dir = await mkProjectTracked();
    await plantRegistryPeer(dir, 'peer-superseded');
    // The hook's own bootstrapLock() writes the live lock here, owned by this
    // session's raw id — a different id than the planted registry entry.
    const result = await runHook({ projectDir: dir, useCwd: true });

    expectSingleEnvelope(result.stdout);
    const lines = mechanicalLines(result.stdout);
    const mechanical = lines.find((l) => /^🔍\s+Mechanical peer-detection:/.test(l));
    expect(mechanical).toBeDefined();
    // Count is HONEST: the superseded entry is still one peer.
    expect(mechanical).toContain("1 active in this repo's worktree set");
    expect(mechanical).toContain('peer-superseded:deep [registry-only, superseded]');
    // The explanation rides the SAME systemMessage (HR-106: one JSON object).
    expect(lines.some((l) => l.includes('GH#67'))).toBe(true);

    const evt = (await readEvents(dir)).find((e) => e.event === 'orchestrator.session.started');
    expect(evt.peers_superseded).toBe(1);
  });

  it('does NOT mark a lock-sourced peer (GH#67)', async () => {
    const dir = await mkProjectTracked();
    await plantForeignLock(dir, 'peer-locked');

    const result = await runHook({ projectDir: dir, useCwd: true });

    expectSingleEnvelope(result.stdout);
    const lines = mechanicalLines(result.stdout);
    const mechanical = lines.find((l) => /^🔍\s+Mechanical peer-detection:/.test(l));
    expect(mechanical).toBeDefined();
    expect(mechanical).toContain('peer-locked');
    // A lock-sourced peer carries none of the three GH#67 fields, so it must
    // render byte-identically to the pre-GH#67 banner.
    expect(mechanical).not.toContain('registry-only');

    const evt = (await readEvents(dir)).find((e) => e.event === 'orchestrator.session.started');
    expect(evt.peers_superseded).toBe(0);
  });

  it('mixed peers: counts both, marks only the superseded registry one (GH#67)', async () => {
    const dir = await mkProjectTracked();
    // The foreign lock is BOTH a lock-sourced peer and the live lock owner that
    // supersedes the registry entry with a different id.
    await plantForeignLock(dir, 'peer-locked');
    await plantRegistryPeer(dir, 'peer-superseded');

    const result = await runHook({ projectDir: dir, useCwd: true });

    expectSingleEnvelope(result.stdout);
    const lines = mechanicalLines(result.stdout);
    const mechanical = lines.find((l) => /^🔍\s+Mechanical peer-detection:/.test(l));
    expect(mechanical).toBeDefined();
    expect(mechanical).toContain("2 active in this repo's worktree set");
    expect(mechanical).toContain('peer-superseded:deep [registry-only, superseded]');
    expect(mechanical).toContain('peer-locked:deep,');
    // Exactly ONE marker for two peers.
    expect(mechanical.match(/registry-only/g)).toHaveLength(1);

    const evt = (await readEvents(dir)).find((e) => e.event === 'orchestrator.session.started');
    expect(evt.peers_superseded).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Own-repo orphaned-lock reaper splice (Epic #724 C7)
// ---------------------------------------------------------------------------

describe('own-repo lock reaper splice (#724)', { timeout: 15000 }, () => {
  const LOCK_RELPATH = path.join('.orchestrator', 'session.lock');

  /** Seed a stale own-host session.lock owned by a foreign session id. */
  async function seedStaleLock(dir, sessionId) {
    const staleHeartbeat = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
    const lock = {
      session_id: sessionId,
      started_at: staleHeartbeat,
      last_heartbeat: staleHeartbeat,
      mode: 'deep',
      pid: 999999, // very unlikely to be a live PID → dead lease
      host: os.hostname(),
      ttl_hours: 4,
    };
    await fs.mkdir(path.join(dir, '.orchestrator'), { recursive: true });
    await fs.writeFile(path.join(dir, LOCK_RELPATH), JSON.stringify(lock, null, 2) + '\n', 'utf8');
  }

  it('reaps a stale orphan lock without blocking the new session', async () => {
    const dir = await mkProjectTracked();
    await seedStaleLock(dir, 'ghost-orphan');

    const result = await runHook({ projectDir: dir, useCwd: true });
    expect(result.code).toBe(0);
    expect((await readEvents(dir)).length).toBeGreaterThanOrEqual(1);

    const lockRaw = await fs
      .readFile(path.join(dir, LOCK_RELPATH), 'utf8')
      .catch(() => '');
    expect(lockRaw).not.toContain('ghost-orphan');
  });
});

// ---------------------------------------------------------------------------
// Close-through backfill at SessionStart (#926)
//
// The SessionEnd hook already backfills, but SessionEnd only fires on a REGULAR
// close: a session killed by Ctrl-C, a timeout or a crash leaves NO ledger entry
// and the backfill then waits for the next clean close. These tests pin that the
// NEXT session's start reconstructs it — and that doing so can never (a) block
// the start, or (b) record a session that is still running.
// ---------------------------------------------------------------------------

describe('close-through backfill at SessionStart (#926)', { timeout: 15000 }, () => {
  const SESSIONS_RELPATH = path.join('.orchestrator', 'metrics', 'sessions.jsonl');

  /** Seed one long-dead, never-closed session in events.jsonl. */
  async function seedAbandonedSession(dir) {
    await fs.mkdir(path.join(dir, '.orchestrator', 'metrics'), { recursive: true });
    const lines = [
      { timestamp: '2026-01-01T09:00:00.000Z', event: 'orchestrator.session.started', session_id: 'eeeeeeee-1111-4111-8111-111111111111', branch: 'main', project: 'demo' },
      { timestamp: '2026-01-01T09:01:00.000Z', event: 'orchestrator.session.lock.acquired', session_id: 'eeeeeeee-1111-4111-8111-111111111111', semantic_session_id: 'main-2026-01-01-session-9', mode: 'deep' },
    ];
    await fs.writeFile(path.join(dir, EVENTS_RELPATH), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  }

  async function readSessionsJsonl(dir) {
    try {
      const raw = await fs.readFile(path.join(dir, SESSIONS_RELPATH), 'utf8');
      return raw.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  it('reconstructs a previous never-closed session into sessions.jsonl', async () => {
    const dir = await mkProjectTracked();
    await seedAbandonedSession(dir);

    await runHook({ projectDir: dir, useCwd: true });

    const records = await readSessionsJsonl(dir);
    const recovered = records.find((r) => r.session_id === 'main-2026-01-01-session-9');
    expect(recovered).toBeDefined();
    expect(recovered.status).toBe('abandoned');
  });

  it('never records the session that is starting right now', async () => {
    // Structural self-exclusion: the backfill runs BEFORE this session emits
    // its own orchestrator.session.started, so it is not a candidate at all.
    const dir = await mkProjectTracked();
    await seedAbandonedSession(dir);

    await runHook({ projectDir: dir, useCwd: true, stdin: JSON.stringify({ session_id: 'ffffffff-2222-4222-8222-222222222222' }) });

    const records = await readSessionsJsonl(dir);
    // Only the genuinely-dead predecessor may be recorded.
    expect(records.map((r) => r.session_id)).toEqual(['main-2026-01-01-session-9']);
  });

  it('re-running the hook writes no duplicate stub (idempotent across starts)', async () => {
    const dir = await mkProjectTracked();
    await seedAbandonedSession(dir);

    expect((await runHook({ projectDir: dir, useCwd: true })).code).toBe(0);
    const afterFirst = await readSessionsJsonl(dir);
    expect(afterFirst).toHaveLength(1);

    expect((await runHook({ projectDir: dir, useCwd: true })).code).toBe(0);
    const afterSecond = await readSessionsJsonl(dir);
    expect(afterSecond).toHaveLength(1);
  });

  it('still exits 0 and still emits its own event when the ledger is unwritable', async () => {
    // sessions.jsonl seeded as a DIRECTORY → every append fails. The backfill
    // must swallow it; session start must complete regardless.
    const dir = await mkProjectTracked();
    await seedAbandonedSession(dir);
    await fs.mkdir(path.join(dir, SESSIONS_RELPATH), { recursive: true });

    const result = await runHook({ projectDir: dir, useCwd: true });

    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Phase 4 measurement probes (#1128)
// ---------------------------------------------------------------------------
//
// `skills/session-start/SKILL.md` § Phase 4 names 18 probes with module paths
// and entry functions. Measured 2026-08-23 at `4f6404e`, none of them had a
// mechanical caller anywhere in hooks/, npm scripts, .gitlab-ci.yml or .husky/
// — the only caller was the prose itself — and across 336 recorded session
// starts no event of any kind proved they had ever run. Built, documented,
// never wired, and unfalsifiable while it stayed that way.

describe('Phase 4 measurement probes', { timeout: 20000 }, () => {
  const PROBE_EVENT = 'orchestrator.probes.completed';

  async function probeEvents(dir) {
    return (await readAllEvents(dir)).filter((e) => e.event === PROBE_EVENT);
  }

  /** Age the bootstrap lock past the probe's 90-day alert threshold. */
  async function seedStaleBootstrapLock(dir) {
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    await fs.mkdir(path.join(dir, '.orchestrator'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.orchestrator', 'bootstrap.lock'),
      `version: 1\ntier: fast\nbootstrapped-at: ${old}\nplugin-version: 0.0.1\n`,
      'utf8',
    );
  }

  // BUG: the wiring is reverted, removed by a merge, or never fires — and the
  // probe family silently returns to the state this test was written to end.
  // Nothing else in the suite would notice: the hook exits 0, the banner still
  // renders, and the absence of a probe run looks exactly like a clean one.
  it('records one orchestrator.probes.completed per session start', async () => {
    const dir = await mkProjectTracked();
    const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-probe-vault-'));
    tmpDirs.push(vault);

    const result = await runHook({ projectDir: dir, env: { SO_VAULT_DIR: vault } });
    expect(result.code).toBe(0);

    const events = await probeEvents(dir);
    expect(events).toHaveLength(1);
    const [evt] = events;
    // Every probe SKILL.md names must be accounted for, with an outcome each —
    // "absent is not zero": a probe that did not run is recorded as skipped,
    // never dropped from the census.
    expect(evt.total).toBe(evt.probes.length);
    expect(evt.total).toBeGreaterThanOrEqual(18);
    for (const p of evt.probes) {
      expect(p.outcome).toMatch(/^(ran-clean|ran-warn|ran-alert|skipped|timeout|error)$/);
    }
    expect(evt.ran + evt.skipped + evt.errored + evt.timed_out).toBe(evt.total);
    expect(Number.isFinite(evt.duration_ms)).toBe(true);
    // The two network probes are excluded by default, and the exclusion is
    // visible rather than silent (that silence IS the defect being repaired).
    const byId = Object.fromEntries(evt.probes.map((p) => [p.id, p.outcome]));
    expect(byId['ci-status']).toBe('skipped');
    expect(byId['mirror-issues']).toBe('skipped');
  });

  // BUG: the probes run, find something, and their banner is discarded on the
  // way to the operator — half the original defect, restored. The existing
  // single-envelope test pins that stdout carries ONE object; nothing pins that
  // a probe finding is INSIDE it.
  it('delivers a probe finding inside the single stdout envelope', async () => {
    const dir = await mkProjectTracked();
    const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-probe-vault-'));
    tmpDirs.push(vault);
    await seedStaleBootstrapLock(dir);

    const result = await runHook({ projectDir: dir, env: { SO_VAULT_DIR: vault } });

    const objects = result.stdout.split('\n').filter((l) => l.trim().startsWith('{'));
    expect(objects).toHaveLength(1);
    const combined = JSON.parse(objects[0]).systemMessage;
    expect(combined).toContain('bootstrap.lock');
    expect(combined).toMatch(/age=\d+d/);

    const [evt] = await probeEvents(dir);
    const byId = Object.fromEntries(evt.probes.map((p) => [p.id, p.outcome]));
    expect(byId['bootstrap-lock-freshness']).toBe('ran-alert');
  });

  // BUG: a documented escape hatch that does nothing — the built-but-not-wired
  // class in miniature, on the one control an operator has over this run.
  it('runs no probes when SO_DISABLE_STARTUP_PROBES=1', async () => {
    const dir = await mkProjectTracked();
    const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-probe-vault-'));
    tmpDirs.push(vault);

    const result = await runHook({
      projectDir: dir,
      env: { SO_VAULT_DIR: vault, SO_DISABLE_STARTUP_PROBES: '1' },
    });

    expect(result.code).toBe(0);
    expect(await probeEvents(dir)).toHaveLength(0);
    // The rest of the hook is untouched by the opt-out.
    expect(await readEvents(dir)).toHaveLength(1);
  });

  // BUG: someone resolves the `enable-host-banner: false` collision by moving
  // the probe RUN inside the banner gate. Every operator who silenced banners
  // then silently loses the measurement too — rebuilding the unfalsifiable
  // blind spot behind a display preference (HR-105). The opt-out governs the
  // banner and nothing else.
  it('keeps measuring when enable-host-banner is false, and stays silent', async () => {
    const dir = await mkProjectTracked();
    const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-probe-vault-'));
    tmpDirs.push(vault);
    await seedStaleBootstrapLock(dir);
    await fs.writeFile(
      path.join(dir, 'CLAUDE.md'),
      '# Test\n\n## Session Config\n\nenable-host-banner: false\n',
      'utf8',
    );

    const result = await runHook({ projectDir: dir, env: { SO_VAULT_DIR: vault } });

    // Assert on the PROBE line specifically, not on `systemMessage` as such:
    // the cold-start nudge is a separate emitter that is NOT gated on
    // enable-host-banner (pre-existing, out of scope here) and the aged
    // bootstrap.lock this test seeds is exactly its trigger.
    expect(result.stdout).not.toContain('bootstrap.lock');
    expect(result.stdout).not.toMatch(/age=\d+d/);

    // ...while the measurement itself happened and is on the record.
    const [evt] = await probeEvents(dir);
    expect(evt).toBeDefined();
    const byId = Object.fromEntries(evt.probes.map((p) => [p.id, p.outcome]));
    expect(byId['bootstrap-lock-freshness']).toBe('ran-alert');
  });
});

// #1138 — one-time telemetry-consent nudge (hookSpecificOutput.additionalContext)
// ---------------------------------------------------------------------------

/**
 * Isolation contract: HOME is a fresh mkdtemp for every run, so `os.homedir()`
 * — and with it `~/.config/session-orchestrator/telemetry.json` and
 * `owner.yaml` — resolves into throwaway state. The operator's real consent
 * record is never read and never written by this block. The env kill-switches
 * are cleared explicitly so an ambient DO_NOT_TRACK cannot turn a
 * "nudge present" assertion into a passing "nudge absent".
 */
describe('telemetry-consent nudge (#1138)', { timeout: 15000 }, () => {
  // THE DEFECT THIS BLOCK PINS: the consent AUQ lived only as prose in
  // skills/session-start/SKILL.md § Phase 6.8 — line ~1060 of 1230, behind 24
  // other phases — and no hook ever called resolveConsent(). Measured
  // 2026-08-23: 0 ingest records from any host but the author's.

  /** A fresh fake HOME with an optional telemetry.json seeded into it. */
  async function mkFakeHome(state = null) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-session-start-home-'));
    tmpDirs.push(home);
    if (state !== null) {
      const cfg = path.join(home, '.config', 'session-orchestrator');
      await fs.mkdir(cfg, { recursive: true });
      await fs.writeFile(path.join(cfg, 'telemetry.json'), JSON.stringify(state));
    }
    return home;
  }

  const consentEnv = (home, extra = {}) => ({
    HOME: home,
    SO_TELEMETRY: '',
    SO_TELEMETRY_DISABLED: '',
    DO_NOT_TRACK: '',
    CI: '',
    GITHUB_ACTIONS: '',
    GITLAB_CI: '',
    CONTINUOUS_INTEGRATION: '',
    ...extra,
  });

  /** Every stdout JSON object the hook wrote. */
  const stdoutObjects = (stdout) =>
    stdout.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));

  it('injects the nudge when the host has no consent decision on record', async () => {
    const dir = await mkProjectTracked();
    const home = await mkFakeHome();

    const result = await runHook({ projectDir: dir, env: consentEnv(home) });

    const objects = stdoutObjects(result.stdout);
    expect(objects).toHaveLength(1);
    expect(objects[0].hookSpecificOutput).toMatchObject({ hookEventName: 'SessionStart' });
    expect(objects[0].hookSpecificOutput.additionalContext).toContain('Phase 6.8');
    // ...and the operator-facing banner still rides the SAME object, because a
    // second stdout write would be silently discarded by Claude Code.
    expect(objects[0].systemMessage).toContain('Host:');
  });

  it('stays silent once a decision is stored — granted', async () => {
    const dir = await mkProjectTracked();
    const home = await mkFakeHome({ schema_version: 1, consent: 'granted', decided_at: '2026-08-01T00:00:00.000Z' });

    const result = await runHook({ projectDir: dir, env: consentEnv(home) });

    for (const obj of stdoutObjects(result.stdout)) {
      expect(obj.hookSpecificOutput).toBeUndefined();
    }
  });

  it('stays silent once a decision is stored — denied', async () => {
    const dir = await mkProjectTracked();
    const home = await mkFakeHome({ schema_version: 1, consent: 'denied', decided_at: '2026-08-01T00:00:00.000Z' });

    const result = await runHook({ projectDir: dir, env: consentEnv(home) });

    for (const obj of stdoutObjects(result.stdout)) {
      expect(obj.hookSpecificOutput).toBeUndefined();
    }
  });

  it('never nudges in CI — there is no operator to answer an AskUserQuestion', async () => {
    const dir = await mkProjectTracked();
    const home = await mkFakeHome();

    const result = await runHook({ projectDir: dir, env: consentEnv(home, { CI: 'true' }) });

    for (const obj of stdoutObjects(result.stdout)) {
      expect(obj.hookSpecificOutput).toBeUndefined();
    }
  });

  it('never nudges under the env kill-switches (DO_NOT_TRACK / SO_TELEMETRY_DISABLED)', async () => {
    const dir = await mkProjectTracked();

    for (const kill of [{ DO_NOT_TRACK: '1' }, { SO_TELEMETRY_DISABLED: '1' }]) {
      const home = await mkFakeHome();
      const result = await runHook({ projectDir: dir, env: consentEnv(home, kill) });
      for (const obj of stdoutObjects(result.stdout)) {
        expect(obj.hookSpecificOutput).toBeUndefined();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Host-wide registry census feeds the semantic n-increment (#1066 AC1)
// ---------------------------------------------------------------------------
//
// The registry stores the two identity forms in SEPARATE fields: `session_id`
// is the RAW id (a UUID on Claude Code) and `semantic_session_id` is the label.
// `resolveSemanticSessionId()` counts only semantic candidates, so a census
// that projects `session_id` alone made the host-wide registry contribute
// NOTHING to numbering — a second session on the same host (typically in a
// DIFFERENT repo, which is why the local worktree-lock source cannot see it)
// re-minted `-1` and collided with the live label.
//
// Contract pinned here is the "Minimal" one: the semantic id is a best-effort
// monotonic LABEL; ownership stays (raw session_id, owner proof). The two forms
// are never interchangeable — hence the raw-id assertion in the first test.
describe('registry census → semantic n-increment (#1066)', { timeout: 15000 }, () => {
  const todayUtc = () => new Date().toISOString().slice(0, 10);

  /**
   * Pin the fixture's branch so the seeded label is byte-identical to what the
   * hook derives. `git init` honours the host's `init.defaultBranch`, which is
   * not ours to assume — and SEMANTIC_ID_RE only accepts a lowercase branch.
   */
  function pinBranch(dir, branch) {
    const r = spawnSync('git', ['branch', '-M', branch], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git branch -M failed: ${r.stderr}`);
    return branch;
  }

  /**
   * Seed one host-wide registry entry for a DIFFERENT repo: `repo_path_hash` is
   * deliberately absent, so `discoverActiveSessions()`'s own registry fallback
   * (which filters on a matching repo hash) drops it. Whatever numbering effect
   * the entry has can therefore only come from the hook's registry census.
   */
  async function seedRegistryEntry(name, entry) {
    const activeDir = path.join(process.env.SO_SESSION_REGISTRY_DIR, 'active');
    await fs.mkdir(activeDir, { recursive: true });
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(activeDir, `${name}.json`),
      JSON.stringify({
        pid: 99999,
        repo_name: 'other-repo',
        started_at: now,
        last_heartbeat: now,
        status: 'active',
        current_wave: 0,
        ...entry,
      }),
    );
  }

  async function readSessionFile(projectDir) {
    return JSON.parse(
      await fs.readFile(path.join(projectDir, '.orchestrator', 'current-session.json'), 'utf8'),
    );
  }

  it('mints session-2 when a host-wide registry entry holds session-1 under a UUID session_id', async () => {
    // The bug: `session-1` minted a second time on the same host, because the
    // peer's label lived in `semantic_session_id` while the census read the
    // UUID `session_id` — which resolveSemanticSessionId drops.
    const dir = await mkProjectTracked();
    const branch = pinBranch(dir, 'so1066');
    await seedRegistryEntry('peer-cross-repo', {
      session_id: 'aaaaaaaa-1111-4111-8111-111111111111',
      semantic_session_id: `${branch}-${todayUtc()}-session-1`,
      branch,
      mode: 'session',
    });

    const stdinUuid = 'bbbbbbbb-2222-4222-8222-222222222222';
    const result = await runHook({
      projectDir: dir,
      useCwd: true,
      stdin: JSON.stringify({ session_id: stdinUuid }),
    });

    expect(result.code).toBe(0);
    const session = await readSessionFile(dir);
    expect(session.semantic_session_id).toBe(`${branch}-${todayUtc()}-session-2`);
    // AC4 — the two identity forms are never interchangeable: the label moved,
    // the ownership key is still the raw id from stdin.
    expect(session.session_id).toBe(stdinUuid);
  });

  // Both rows share one shape (seed one registry entry, run the hook with no
  // stdin, assert the minted semantic_session_id) and differ only in the
  // entry's fields and the resulting session-N — merged per TV-004/testing.md
  // rather than kept as two near-identical bodies.
  it.each([
    [
      // The bug this guards: a census that reads ONLY `semantic_session_id`
      // stops counting peers that write a semantic raw id and carry no
      // separate label.
      'counts a registry entry whose raw session_id is itself semantic (Codex/Cursor)',
      'peer-semantic-raw',
      (branch) => ({ session_id: `${branch}-${todayUtc()}-session-4`, branch, mode: 'session' }),
      5,
    ],
    [
      // The bug: a v1 entry (UUID raw id, no label) that makes the census
      // throw silently drops semantic_session_id to null for the WHOLE
      // session, because deriveSemanticCandidate swallows every failure. It
      // must instead be skipped — contributing no candidate and no phantom
      // bump.
      'ignores a legacy v1 entry with no semantic_session_id instead of crashing the census',
      'peer-legacy-v1',
      (branch) => ({ session_id: 'cccccccc-3333-4333-8333-333333333333', branch }),
      1,
    ],
  ])('%s', async (_label, entryName, buildEntry, expectedN) => {
    const dir = await mkProjectTracked();
    const branch = pinBranch(dir, 'so1066');
    await seedRegistryEntry(entryName, buildEntry(branch));

    const result = await runHook({ projectDir: dir, useCwd: true });

    expect(result.code).toBe(0);
    const session = await readSessionFile(dir);
    expect(session.semantic_session_id).toBe(`${branch}-${todayUtc()}-session-${expectedN}`);
  });
});
