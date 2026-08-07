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
      expect((await readEvents(dir))[0].event).toBe('orchestrator.session.started');
    } finally {
      await fs.chmod(badRegistryDir, 0o755);
      await fs.rm(badRegistryDir, { recursive: true, force: true });
    }
  });

  it.skipIf(isRoot)('appends a register-failed entry to sweep.log when registerSelf throws', async () => {
    if (process.platform === 'win32') return; // chmod not meaningful on Windows
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
    expect(entries[0].session_id).toMatch(
      /^([a-f0-9-]{36}|[a-z0-9._/-]+-\d{4}-\d{2}-\d{2}-[a-z-]+-\d+)$/,
    );
    expect(entries[0].repo_name).toBe(path.basename(dir));
    expect(entries[0].status).toBe('active');
    expect((await readEvents(dir))[0].session_id).toBe(entries[0].session_id);
  });

  it('uses the stdin session_id when provided', async () => {
    const dir = await mkProjectTracked();
    const stdinId = 'claude-stdin-session-id-42';
    await runHook({ projectDir: dir, stdin: JSON.stringify({ session_id: stdinId }) });
    const entries = await readRegistry();
    expect(entries).toHaveLength(1);
    expect(entries[0].session_id).toBe(stdinId);
  });

  it('generates a session id when stdin carries no session_id', async () => {
    // Post-P2.2 (#573): hook prefers semantic format `<branch>-<YYYY-MM-DD>-<mode>-<n>`,
    // with UUID-v4 as the fallback when semantic resolution fails.
    // Both formats are valid per PRD §3 P2 row 3 (backward-compat reader via parseSessionId).
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const entries = await readRegistry();
    expect(entries[0].session_id).toMatch(
      /^([a-f0-9-]{36}|[a-z0-9._/-]+-\d{4}-\d{2}-\d{2}-[a-z-]+-\d+)$/,
    );
  });

  it('persists the session id to .orchestrator/current-session.json', async () => {
    // Post-P2.2 (#573): source label is one of: generated-semantic | generated-uuid-fallback | generated (legacy).
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const raw = await fs.readFile(path.join(dir, '.orchestrator', 'current-session.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.session_id).toMatch(
      /^([a-f0-9-]{36}|[a-z0-9._/-]+-\d{4}-\d{2}-\d{2}-[a-z-]+-\d+)$/,
    );
    expect(parsed.source).toMatch(/^generated(-semantic|-uuid-fallback)?$/);
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
//   - session_id           — the resolved id (semantic OR UUID)
//   - semantic_session_id  — ALWAYS the semantic form (D4 #587)
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

  it('T2: hook without stdin writes session.lock with semantic session_id and matching semantic_session_id', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });

    const lock = await readSessionLock(dir);
    // session_id should be semantic (no stdin → semantic-id generation path)
    expect(lock.session_id).toMatch(
      /^[a-z0-9._/-]+-\d{4}-\d{2}-\d{2}-[a-z-]+-\d+$/,
    );
    // semantic_session_id should be identical to session_id on this path
    expect(lock.semantic_session_id).toBe(lock.session_id);
  });

  it('T3: bootstrapLock failure does NOT crash the hook (best-effort contract)', async () => {
    // Force a bootstrap failure by making the .orchestrator/ directory a
    // read-only file (so the lock write to .orchestrator/session.lock fails).
    // The hook should still exit 0 and emit its normal event.
    if (process.platform === 'win32') return; // chmod not meaningful on Windows
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
    await runHook({ projectDir: dir });

    const lock = await readSessionLock(dir);
    expect(typeof lock.pid).toBe('number');
    expect(lock.pid).toBeGreaterThan(0);
    // The PID is the hook subprocess's process.pid (transient, dies in <1s).
    // It must NOT be process.pid of this test runner. We cannot assert
    // exact equality (subprocess PID is unknown), but we can assert that
    // the spawn child's PID was NOT the test runner's.
    expect(lock.pid).not.toBe(process.pid);
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

  it('emits "Mechanical peer-detection:" banner when discoverActiveSessions returns a peer (other than self)', async () => {
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
    const mechanical = messages.find((m) =>
      /^🔍\s+Mechanical peer-detection:\s+\d+\s+active/.test(m.systemMessage),
    );
    expect(mechanical).toBeDefined();
    // The banner must include the peer's session_id and mode.
    expect(mechanical.systemMessage).toContain('peer-mech');
    expect(mechanical.systemMessage).toContain('deep');
  });

  it('does NOT emit the mechanical banner when discoverActiveSessions returns only self', async () => {
    const dir = await mkProjectTracked();
    // No peer registry entry; the only lock will be the one this hook
    // writes. useCwd: true scopes `git worktree list` to the fresh-git
    // fixture so the test runner's outer worktree set is not visible.
    const result = await runHook({ projectDir: dir, useCwd: true });

    const messages = parseSystemMessages(result.stdout);
    const mechanical = messages.find((m) =>
      /^🔍\s+Mechanical peer-detection:/.test(m.systemMessage),
    );
    // No mechanical-peer banner — discoverActiveSessions returns only self.
    expect(mechanical).toBeUndefined();
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
